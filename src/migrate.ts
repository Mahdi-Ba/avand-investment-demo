import { readFile } from "node:fs/promises";
import { pool, tx } from "./db.js";
await tx(async (c) => {
  await c.query(
    await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
  );
});
console.log("Schema ready");
await pool.end();
