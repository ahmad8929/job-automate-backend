import dns from "node:dns";
import net from "node:net";
import { neon, neonConfig } from "@neondatabase/serverless";
import { config } from "../config.js";

// Network tuning for this machine (applies to every outbound call: Neon, Gemini, Gmail, Cloudinary):
// - the local network advertises IPv6 but can't route it, so prefer IPv4;
// - Node's "happy eyeballs" gives each address only 500ms, but connecting to Neon (US-East) from here takes
//   300-450ms, so jitter made every attempt fail. Connect to one IPv4 address with the normal timeout instead.
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(false);

// Retry transient network failures (DNS/connect timeouts, Neon waking from idle) once before giving up.
neonConfig.fetchFunction = async (input: RequestInfo | URL, init?: RequestInit) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      if (attempt >= 2) throw err;
      console.warn("[db] network error talking to Neon, retrying once…", (err as Error).cause ?? err);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

export const sql = neon(config.DATABASE_URL);
