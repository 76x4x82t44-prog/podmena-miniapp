import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const migrations = new URL("../supabase/migrations/", import.meta.url);
const root = new URL("./", import.meta.url);
const database = new PGlite();
const baseline = process.argv.includes("--baseline");
const disputeSmoke = "stage-3zh-database-smoke.sql";
const smokeFiles = baseline ? [disputeSmoke] : (await fs.readdir(root)).filter(name => name.endsWith(".sql")).sort();
const securityMigration = "20261122095300_pilot_security.sql";
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
  if (!baseline) {
    await database.exec(await fs.readFile(new URL("../supabase/rollback/pilot_compatibility.sql", root), "utf8"));
    const { rows: [rpc] } = await database.query(`
      select (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang
          where p.oid = 'public.podmena_shift_action(text,text,jsonb)'::regprocedure) as language,
        has_function_privilege('anon', 'public.podmena_shift_action(text,text,jsonb)', 'execute') as anon_allowed,
        has_function_privilege('service_role', 'public.podmena_shift_action(text,text,jsonb)', 'execute') as server_allowed
    `);
    assert.equal(rpc.language, "sql");
    assert.equal(rpc.anon_allowed, false);
    assert.equal(rpc.server_allowed, true);
    await database.exec(await fs.readFile(new URL(disputeSmoke, root), "utf8"));
    await database.exec(await fs.readFile(new URL(securityMigration, migrations), "utf8"));
    await database.exec(await fs.readFile(new URL("stage-pilot-security-smoke.sql", root), "utf8"));
    console.log("PASS rollback and reapply pilot security");
  }
} finally {
  await database.close();
}
