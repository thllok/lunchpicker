import dotenv from "dotenv";
dotenv.config();
import express from "express";
import path from "path";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import { redis } from "./redis.js";
import { PrismaClient } from "@prisma/client";
import axios from "axios";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));
const prisma = new PrismaClient();

const PORT = Number(process.env.PORT || 3000);
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!GOOGLE_CLIENT_ID) {
  throw new Error("Missing GOOGLE_CLIENT_ID in env");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---- Simple cookies helpers ----
function parseCookies(req: express.Request) {
  const header = req.headers.cookie || "";
  const out: Record<string, string> = {};
  header.split(";").forEach(part => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

function setCookie(res: express.Response, name: string, value: string, opts?: {
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  secure?: boolean;
  maxAgeSeconds?: number;
  path?: string;
}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts?.path ?? "/"}`);
  if (opts?.httpOnly ?? true) parts.push("HttpOnly");
  parts.push(`SameSite=${opts?.sameSite ?? "Lax"}`);
  if (opts?.secure) parts.push("Secure");
  if (typeof opts?.maxAgeSeconds === "number") parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  res.setHeader("Set-Cookie", parts.join("; "));
}

// ---- Auth session in Redis ----
const AUTH_COOKIE = "auth_sid";
const AUTH_TTL_SECONDS = 60 * 60 * 24 * 7;

async function getAuthSession(req: express.Request) {
  const cookies = parseCookies(req);
  const sid = cookies[AUTH_COOKIE];
  if (!sid) return null;

  const raw = await redis.get(`auth:sess:${sid}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as { sub: string; email?: string; name?: string; picture?: string; };
  } catch {
    return null;
  }
}

function requireAuth(handler: (req: express.Request, res: express.Response, user: any) => any) {
  return async (req: express.Request, res: express.Response) => {
    const user = await getAuthSession(req);
    if (!user) return res.status(401).json({ error: "Not logged in" });
    return handler(req, res, user);
  };
}

// ---- Google Auth Endpoints ----
app.post("/api/auth/google", async (req, res) => {
  const idToken = req.body?.idToken;
  if (!idToken || typeof idToken !== "string") {
    return res.status(400).json({ error: "Missing idToken" });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.sub) return res.status(401).json({ error: "Invalid token payload" });

    await prisma.user.upsert({
      where: { id: payload.sub },
      update: { email: payload.email || null }, 
      create: { id: payload.sub, email: payload.email || null },
    });

    const authSid = crypto.randomUUID();
    const user = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    };

    await redis.set(`auth:sess:${authSid}`, JSON.stringify(user), "EX", AUTH_TTL_SECONDS);

    setCookie(res, AUTH_COOKIE, authSid, {
      httpOnly: true,
      sameSite: "Lax",
      secure: process.env.NODE_ENV === "production",
      maxAgeSeconds: AUTH_TTL_SECONDS,
      path: "/",
    });

    return res.json({ ok: true, user });
  } catch (e: any) {
    console.error("Auth error:", e);
    return res.status(401).json({ error: "Token verification failed" });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  const cookies = parseCookies(req);
  const sid = cookies[AUTH_COOKIE];
  if (sid) await redis.del(`auth:sess:${sid}`);
  setCookie(res, AUTH_COOKIE, "", { maxAgeSeconds: 0, path: "/" });
  return res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const user = await getAuthSession(req);
  if (!user) return res.status(401).json({ loggedIn: false });
  return res.json({ loggedIn: true, user });
});

// ---- HELPER: Fetch Real Places (With Redis Cache) ----
async function fetchNearbyRestaurants(lat: number, lng: number, radius: number) {
  const cacheKey = `cache:places:rich:${lat.toFixed(3)},${lng.toFixed(3)}:${radius}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const url = `https://places.googleapis.com/v1/places:searchNearby`;
  try {
    const res = await axios.post(url, {
      includedTypes: ["restaurant"],
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } }
    }, {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
        // UPDATED: Added places.googleMapsUri to the FieldMask
        "X-Goog-FieldMask": "places.id,places.displayName,places.rating,places.shortFormattedAddress,places.location,places.internationalPhoneNumber,places.types,places.photos,places.googleMapsUri"
      }
    });

    const results = (res.data.places || []).map((p: any) => ({
      placeId: p.id,
      name: p.displayName?.text,
      rating: p.rating || 0,
      vicinity: p.shortFormattedAddress,
      phone: p.internationalPhoneNumber || "N/A",
      googleMapsUri: p.googleMapsUri, // Added link
      cuisine: p.types?.find((t: string) => t !== 'restaurant' && t !== 'food' && t !== 'point_of_interest') || "Restaurant",
      photoUrl: p.photos?.[0] 
        ? `https://places.googleapis.com/v1/${p.photos[0].name}/media?key=${GOOGLE_MAPS_API_KEY}&maxWidthPx=400`
        : null
    }));

    if (results.length > 0) await redis.set(cacheKey, JSON.stringify(results), "EX", 600);
    return results;
  } catch (e) { 
    console.error("Fetch Error:", e);
    return []; 
  }
}

function getOrSetSid(req: express.Request, res: express.Response) {
  const cookies = parseCookies(req);
  if (cookies.sid) return cookies.sid;

  const sid = crypto.randomUUID();
  setCookie(res, "sid", sid, {
    httpOnly: true,
    sameSite: "Lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAgeSeconds: 60 * 60 * 24 * 365,
  });
  return sid;
}

// ---- Pick Endpoint ----
app.post("/api/pick", async (req, res) => {
  const { location, radius, minRating, days } = req.body;
  
  if (!location?.lat || !location?.lng) {
    return res.status(400).json({ error: "Location required" });
  }
  const safeRadius = Math.min(Math.max(Number(radius) || 500, 100), 5000);
  const safeDays = Number(days ?? 7);

  let candidates = await fetchNearbyRestaurants(location.lat, location.lng, safeRadius);
  
  if (minRating) {
    candidates = candidates.filter((p: any) => (p.rating || 0) >= Number(minRating));
  }

  if (candidates.length === 0) {
    return res.status(404).json({ error: "No restaurants found nearby." });
  }

  const user = await getAuthSession(req);
  let key: string;
  if (user) {
    key = `pick:hist:user:${user.sub}`;
  } else {
    const sid = getOrSetSid(req, res);
    key = `pick:hist:sess:${sid}`;
  }

  const now = Math.floor(Date.now() / 1000);
  let blocked = new Set<string>();
  
  if (safeDays > 0) {
    const cutoff = now - safeDays * 86400;
    const blockedIds = await redis.zrangebyscore(key, cutoff, "+inf");
    blocked = new Set(blockedIds);
  }

  const available = candidates.filter((p: any) => !blocked.has(p.placeId));

  if (available.length === 0) {
    return res.status(409).json({ error: "No options left recently!" });
  }

  const pick = available[Math.floor(Math.random() * available.length)];
  await redis.zadd(key, now, pick.placeId);
  
  return res.json({ 
    pick, 
    candidates: candidates.slice(0, 8) // Racing against original pool feels more competitive
  }); 
});

// ---- History Endpoints ----
app.get("/api/history", requireAuth(async (req, res, user) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    await prisma.history.deleteMany({
      where: {
        userId: user.sub,
        createdAt: { lt: thirtyDaysAgo }
      }
    });

    const items = await prisma.history.findMany({
        where: { userId: user.sub },
        orderBy: { createdAt: 'desc' }
    });

    return res.json(items);
  } catch (e) {
      return res.status(500).json({ error: "Failed to fetch history" });
  }
}));

app.post("/api/history", requireAuth(async (req, res, user) => {
  try {
    const { name, rating, address, googleMapsUri } = req.body;
    if (!name) return res.status(400).json({ error: "Name is required" });

    await prisma.history.create({
      data: {
        userId: user.sub,
        name: name,
        rating: Number(rating),
        address: address || "",
        url: googleMapsUri || "" // Save the URL to the DB
      }
    });

    return res.json({ success: true });
  } catch (e) {
    console.error("Save error:", e);
    return res.status(500).json({ error: "Failed to save history" });
  }
}));

app.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}`);
});