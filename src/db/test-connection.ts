import { sql } from "./client.js";

try {
  const [row] = await sql`SELECT version() AS version, now() AS now`;
  console.log("Connected to Neon ✅");
  console.log(row);
} catch (err) {
  console.error("Connection failed ❌", err);
  process.exit(1);
}
