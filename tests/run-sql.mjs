import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrations = new URL("../supabase/migrations/", import.meta.url);
const root = new URL("./", import.meta.url);
const database = new PGlite();
const baseline = process.argv.includes("--baseline");
const smokeFiles = baseline ? ["stage-3zh-database-smoke.sql"] : (await fs.readdir(root)).filter(name => name.endsWith(".sql")).sort();
try {
  await database.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const name of (await fs.readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
    if (baseline && name.includes("_pilot_")) continue;
    await database.exec(await fs.readFile(new URL(name, migrations), "utf8"));
    console.log("Миграция", name);
  }
  for (const name of smokeFiles) {
    await database.exec(await fs.readFile(new URL(name, root), "utf8"));
    console.log("PASS", name);
  }
} finally {
  await database.close();
}
