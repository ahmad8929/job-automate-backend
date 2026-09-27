import { sql } from "./client.js";
import { schemaStatements } from "./schema.js";

for (const statement of schemaStatements) {
  const firstLine = statement.trim().split("\n")[0];
  await sql.query(statement);
  console.log("✓", firstLine);
}
const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' ORDER BY table_name`;
console.log("Tables:", tables.map((t) => t.table_name).join(", "));
