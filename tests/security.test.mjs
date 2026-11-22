import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationDir = new URL("../supabase/migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
const allowedOrigin = "https://miniapp.invalid";
const supabaseUrl = "https://database.invalid";
const botToken = "synthetic-bot-fixture";
const serviceRoleKey = "synthetic-service-fixture";

async function migrate(db, include) {
  for (const name of migrationFiles.filter(include)) {
    await db.exec(await readFile(new URL(name, migrationDir), "utf8"));
  }
}

test("отзыв EXECUTE сохраняет установленный DDL-триггер RLS", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      grant usage, create on schema public to authenticated;
      create function public.rls_auto_enable() returns event_trigger
        language plpgsql security definer set search_path = pg_catalog as $hook$
      declare item record;
      begin
        for item in select * from pg_event_trigger_ddl_commands()
          where schema_name = 'public' and object_type in ('table','partitioned table')
        loop
          execute format('alter table %s enable row level security', item.object_identity);
        end loop;
      end;
      $hook$;
      create event trigger ensure_rls on ddl_command_end
        when tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
        execute function public.rls_auto_enable();
    `);
    const rights = () => db.query(`
      select
        has_function_privilege('anon','public.rls_auto_enable()','execute') anon_exec,
        has_function_privilege('authenticated','public.rls_auto_enable()','execute') authenticated_exec,
        has_function_privilege('service_role','public.rls_auto_enable()','execute') service_exec,
        (select evtenabled from pg_event_trigger where evtname='ensure_rls') active
    `).then(({ rows }) => rows[0]);
    assert.deepEqual(await rights(), { anon_exec: true, authenticated_exec: true, service_exec: true, active: "O" });
    await migrate(db, (name) => !name.includes("_pilot_") || name.includes("_pilot_security"));
    assert.deepEqual(await rights(), { anon_exec: false, authenticated_exec: false, service_exec: false, active: "O" });
    await migrate(db, (name) => name.includes("_pilot_security"));
    assert.deepEqual(await rights(), { anon_exec: false, authenticated_exec: false, service_exec: false, active: "O" });
    await db.transaction(async (tx) => {
      await tx.exec("set local role authenticated; create table public.test_rls_guard (id integer);");
      const state = await tx.query("select relrowsecurity from pg_class where oid='public.test_rls_guard'::regclass;");
      assert.deepEqual(state.rows, [{ relrowsecurity: true }]);
    });
  } finally {
    await db.close();
  }
});

test("реальные обработчики проверяют подпись, TTL и личность по сессии", async () => {
  const db = new PGlite();
  const savedDeno = globalThis.Deno;
  const savedFetch = globalThis.fetch;
  try {
    globalThis.Deno = { env: { get() {} }, serve() {} };
    const { createHandler: createAuth } = await import("../supabase/functions/telegram-auth-/index.ts");
    const { createHandler: createProfiles } = await import("../supabase/functions/telegram-profiles/index.ts");
    const { createHandler: createShifts } = await import("../supabase/functions/telegram-shifts/index.ts");
    const shared = { allowedOrigin, supabaseUrl, serviceRoleKey };
    const auth = createAuth({ ...shared, botToken });
    const profiles = createProfiles(shared);
    const shifts = createShifts(shared);
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await migrate(db, (name) => !name.includes("_pilot_") || name.includes("_pilot_security"));

    const routes = {
      podmena_start_telegram_session: (v) => ["select * from public.podmena_start_telegram_session($1,$2,$3)",
        [v.p_telegram_id, v.p_telegram_hash, v.p_token_hash], true],
      podmena_get_session_user: (v) => ["select * from public.podmena_get_session_user($1)", [v.p_token_hash], true],
      podmena_read_profiles: (v) => ["select public.podmena_read_profiles($1) result", [v.p_token_hash], false],
      podmena_shift_action: (v) => ["select public.podmena_shift_action($1,$2,$3::jsonb) result",
        [v.p_token_hash, v.p_action, JSON.stringify(v.p_input)], false],
    };
    let downstream = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url.origin, supabaseUrl);
      assert.equal(options.headers.Authorization, "Bearer " + serviceRoleKey);
      assert.equal(options.redirect, "error");
      const route = routes[url.pathname.split("/").at(-1)];
      assert.ok(route, "only expected SQL RPC is allowed");
      const [sql, params, returnsRows] = route(JSON.parse(options.body));
      downstream++;
      try {
        const { rows } = await db.transaction(async (tx) => {
          await tx.exec("set local role service_role;");
          return await tx.query(sql, params);
        });
        return Response.json(returnsRows ? rows : rows[0].result);
      } catch (error) {
        if (!error.code?.startsWith("PT")) throw error;
        return Response.json({ code: error.code, message: error.message }, { status: Number(error.code.slice(2)) });
      }
    };

    const now = Math.floor(Date.now() / 1000);
    const fields = { user: JSON.stringify({ id: 4499999700001 }), auth_date: String(now), query_id: "fixture-safe" };
    function sign(values) {
      const key = createHmac("sha256", "WebAppData").update(botToken).digest();
      const data = Object.entries(values).sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => name + "=" + value).join("\n");
      const hash = createHmac("sha256", key).update(data).digest("hex");
      return new URLSearchParams({ ...values, hash }).toString();
    }
    const login = (initData, origin = allowedOrigin) => auth(new Request("https://edge.invalid/telegram-auth-", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ initData, actor_id: "must never control identity" }),
    }));
    const authSession = (token) => auth(new Request("https://edge.invalid/telegram-auth-", {
      headers: { Origin: allowedOrigin, Authorization: "Bearer " + token },
    }));

    const goodSignature = sign(fields);
    const altered = new URLSearchParams(goodSignature);
    altered.set("user", JSON.stringify({ id: 4499999700002 }));
    assert.equal((await login(goodSignature, "https://outside.invalid")).status, 403);
    assert.equal((await login(altered.toString())).status, 401);
    assert.equal((await login(goodSignature + "&auth_date=" + fields.auth_date)).status, 401);
    assert.equal((await login(sign({ ...fields, auth_date: String(now - 360) }))).status, 401);
    assert.equal((await login(sign({ ...fields, auth_date: String(now + 60) }))).status, 401);
    assert.equal((await authSession("invalid")).status, 401);
    assert.equal(downstream, 0);

    const response = await login(goodSignature);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const owner = await response.json();
    assert.match(owner.sessionToken, /^[0-9a-f]{64}$/);
    const persisted = await db.query("select telegram_id,encode(token_hash,'hex') hash from podmena.telegram_users u join podmena.telegram_sessions s on s.user_id=u.id;");
    assert.deepEqual(persisted.rows, [{
      telegram_id: 4499999700001,
      hash: createHash("sha256").update(owner.sessionToken).digest("hex"),
    }]);

    assert.equal((await login(goodSignature)).status, 409);
    assert.equal((await authSession("f".repeat(64))).status, 401);
    assert.equal((await authSession(owner.sessionToken)).status, 200);
    const independent = await (await login(sign({ ...fields, user: JSON.stringify({ id: 4499999700002 }) }))).json();
    await db.query("insert into podmena.private_contacts(user_id,worker_phone) values($1,$2)", [owner.userId, "синтетический контакт"]);
    const readProfile = (sessionToken) => profiles(new Request("https://edge.invalid/telegram-profiles?actor_id=" + owner.userId, {
      headers: { Authorization: "Bearer " + sessionToken, Origin: allowedOrigin },
    }));
    assert.equal((await (await readProfile(owner.sessionToken)).json()).contacts.worker, "синтетический контакт");
    assert.deepEqual(await (await readProfile(independent.sessionToken)).json(), { worker: null, manager: null, contacts: null });

    const sendShift = (input, bearer) => shifts(new Request("https://edge.invalid/telegram-shifts", {
      method: "POST",
      headers: { Authorization: "Bearer " + bearer, Origin: allowedOrigin, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }));
    const dispute = { action: "reply_dispute", input: {
      shift_id: "00000000-0000-4000-8000-000000000040",
      request_id: "00000000-0000-4000-8000-000000000041", round_id: "1", message: "x".repeat(501),
    } };
    assert.equal((await sendShift(dispute, independent.sessionToken)).status, 400);
    assert.equal((await sendShift({ action: "owned", input: {} }, "not-a-token")).status, 401);
    assert.equal((await sendShift({ action: "owned", input: {} }, "d".repeat(64))).status, 401);

    const third = await (await login(sign({ ...fields, user: JSON.stringify({ id: 4499999700003 }) }))).json();
    await db.query("insert into podmena.manager_profiles(user_id,name,city,district,pickup_point,platform) values ($1,'ПВЗ','Тест','Тест','ПВЗ','ozon')", [owner.userId]);
    await db.query(`insert into podmena.worker_profiles(user_id,name,city,district,platforms,experience,accepts_single_shifts)
      values ($1,'Тест','Тест','Тест',array['ozon']::podmena.platform[],'Тест',true),
             ($2,'Тест','Тест','Тест',array['ozon']::podmena.platform[],'Тест',true)`, [independent.userId, third.userId]);
    const { rows: [{ id: shiftId }] } = await db.query(`
      insert into podmena.shifts(manager_id,platform,city,district,pickup_point,starts_at,ends_at,pay_rubles,time_zone)
      values($1,'ozon','Тест','Тест','Сменный тест',now()+interval '1 day',now()+interval '2 days',100,'Europe/Moscow') returning id
    `, [owner.userId]);
    const { rows: applications } = await db.query(`
      insert into podmena.shift_applications(shift_id,worker_id) values ($1,$2),($1,$3) returning id
    `, [shiftId, independent.userId, third.userId]);
    const concurrent = await Promise.all(applications.map(({ id }) => sendShift({
      action: "confirm", input: { shift_id: shiftId, application_id: id, actor_id: third.userId },
    }, owner.sessionToken)));
    assert.deepEqual(concurrent.map(({ status }) => status).sort(), [200, 409]);
    const { rows: winners } = await db.query(`
      select confirmed_application_id from podmena.shifts where id=$1 and status='confirmed'
    `, [shiftId]);
    assert.equal(winners.length, 1);
    assert.ok(applications.some(({ id }) => id === winners[0].confirmed_application_id));
    await assert.rejects(db.transaction(async (tx) => {
      await tx.exec("set local role anon;");
      await tx.query("select * from podmena.private_contacts limit 1");
    }), { code: "42501" });

    await db.query("update podmena.telegram_sessions set expires_at=now()-interval '1 second' where user_id=$1", [owner.userId]);
    assert.equal((await authSession(owner.sessionToken)).status, 401);
    assert.equal((await readProfile(owner.sessionToken)).status, 401);
    assert.equal((await sendShift({ action: "owned", input: {} }, owner.sessionToken)).status, 401);

    globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
    const incomplete = await sendShift({ action: "owned", input: {} }, independent.sessionToken);
    assert.equal(incomplete.status, 503);
    assert.deepEqual(await incomplete.json(), { error: "service_unavailable" });
  } finally {
    globalThis.Deno = savedDeno;
    globalThis.fetch = savedFetch;
    await db.close();
  }
});
