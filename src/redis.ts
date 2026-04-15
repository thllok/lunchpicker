import dotenv from "dotenv";
dotenv.config();
import { Redis } from "ioredis";

const url = process.env.REDIS_URL;

// Optional: Default to localhost if missing (good for dev), or keep throwing error
if (!url) {
  // throw new Error("Missing REDIS_URL"); 
  console.warn("No REDIS_URL found, defaulting to localhost");
}

export const redis = new Redis(url || "redis://localhost:6379");