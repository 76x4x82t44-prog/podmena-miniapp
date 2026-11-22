import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";

const originalDeno = globalThis.Deno;
// The Edge entry point registers Deno.serve on import. Tests invoke its actual
// handler and replace only the network, so no sockets or secrets are needed.
globalThis.Deno = { env: { get: () => undefined }, serve: () => {} };
const { createNotificationWorker } = await import(
  "../supabase/functions/telegram-notifications/index.ts"
);
if (originalDeno === undefined) delete globalThis.Deno;
else globalThis.Deno = originalDeno;

const config = {
  workerSecret: "fixture-worker-secret-for-unit-tests-only",
  botToken: "123456:fixture-bot-token-only",
  miniAppUrl: "https://example.org/telegram-test/",
  supabaseUrl: "https://fixture.supabase.co",
  serviceRoleKey: "fixture-service-role",
};
const job = {
  id: "00000000-0000-0000-0000-000000000001",
  lease_token: "00000000-0000-0000-0000-000000000002",
  telegram_id: "452392447895",
  event_kind: "chat_message",
  attempt: 1,
  private_text: "Не отправлять: пароль и имя получателя",
};

function request(secret = config.workerSecret, method = "POST") {
  const headers = {};
  if (secret !== null) headers["x-podmena-worker-secret"] = secret;
  return new Request(
    "https://fixture.supabase.co/functions/v1/telegram-notifications",
    { method, headers },
  );
}

function fixture(telegram, override = {}) {
  const calls = [];
  const handler = createNotificationWorker(
    { ...config, ...override.config },
    async (url, options) => {
      const address = new URL(url);
      const body = JSON.parse(options.body);
      calls.push([address, options, body]);
      if (address.pathname === "/rest/v1/rpc/podmena_claim_notifications") {
        return Response.json(override.jobs ?? [job]);
      }
      if (address.pathname === "/rest/v1/rpc/podmena_finish_notification") {
        return Response.json(override.settlement ?? true);
      }
      if (address.hostname === "api.telegram.org") {
        return await telegram(address, options);
      }
      assert.fail("Worker used an unexpected endpoint");
    },
  );
  return { calls, handler };
}

function finishBody(calls) {
  return calls.at(-1)?.[2];
}

test("worker rejects missing or invalid internal credentials before any claim", async () => {
  const { handler, calls } = fixture(() =>
    assert.fail("Unauthorized delivery attempted")
  );
  for (
    const key of [
      null,
      "fixture-worker-secret-for-unit-tests-onlx",
      "other-key",
    ]
  ) {
    const response = await handler(request(key));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
  assert.equal(
    (await handler(request(config.workerSecret, "GET"))).status,
    405,
  );
  assert.deepEqual(calls, []);
});

test("misconfigured or insecure Mini App URL fails before claim", async () => {
  for (
    const miniAppUrl of [
      "",
      "http://example.org",
      "https://owner:secret@example.org",
    ]
  ) {
    const { handler, calls } = fixture(() => assert.fail("Unexpected send"), {
      config: { miniAppUrl },
    });
    assert.equal((await handler(request())).status, 503);
    assert.deepEqual(calls, []);
  }
});

test("successful delivery claims bounded work and sends only safe content to its recipient", async () => {
  const { handler, calls } = fixture(() =>
    Response.json({ ok: true, result: { message_id: 5 } })
  );
  const response = await handler(request());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(result.delivered, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.settlement_errors, 0);
  const [
    [claim, claimOpts, { p_limit }],
    [bot, botOpts, message],
    [finish, ,],
  ] = calls;
  assert.equal(
    claim.href,
    "https://fixture.supabase.co/rest/v1/rpc/podmena_claim_notifications",
  );
  assert.equal(
    finish.href,
    "https://fixture.supabase.co/rest/v1/rpc/podmena_finish_notification",
  );
  assert.ok(Number.isInteger(p_limit) && p_limit > 0 && p_limit <= 10);
  assert.equal(
    new Headers(claimOpts.headers).get("apikey"),
    config.serviceRoleKey,
  );
  assert.equal(
    bot.href,
    "https://api.telegram.org/bot123456:fixture-bot-token-only/sendMessage",
  );
  assert.equal(botOpts.redirect, "error");
  assert.equal(new Headers(botOpts.headers).get("authorization"), null);
  assert.equal(message.chat_id, job.telegram_id);
  assert.match(message.text, /сообщение/i);
  assert.doesNotMatch(JSON.stringify(message), /пароль|имя получателя/);
  assert.doesNotMatch(JSON.stringify(result), /fixture|452392447895/);
  assert.equal(
    message.reply_markup.inline_keyboard[0][0].web_app.url,
    config.miniAppUrl,
  );
  assert.deepEqual(finishBody(calls), {
    p_id: job.id,
    p_lease_token: job.lease_token,
    p_result: "delivered",
    p_retry_after: null,
  });
});

test("Bot API 403 and chat not found become unavailable and are not retried", async () => {
  for (
    const [code, description] of [[
      403,
      "Forbidden: bot was blocked by the user",
    ], [400, "Bad Request: chat not found"]]
  ) {
    const { handler, calls } = fixture(() =>
      Response.json({ ok: false, error_code: code, description }, {
        status: code,
      })
    );
    const response = await handler(request());
    assert.equal((await response.json()).unavailable, 1);
    assert.equal(finishBody(calls).p_result, "unavailable");
    assert.equal(finishBody(calls).p_retry_after, null);
  }
});

test("Bot API flood control is queued with Telegram retry delay", async () => {
  const { handler, calls } = fixture(() =>
    Response.json(
      { ok: false, error_code: 429, parameters: { retry_after: 46 } },
      { status: 429 },
    )
  );
  assert.equal((await (await handler(request())).json()).retry, 1);
  assert.equal(finishBody(calls).p_result, "retry");
  assert.equal(finishBody(calls).p_retry_after, 46);
});

test("transport errors and malformed replies are uncertain to avoid duplicate sends", async () => {
  for (
    const telegram of [
      () => {
        throw new DOMException("local simulated timeout", "TimeoutError");
      },
      () => new Response("Bad gateway", { status: 502 }),
    ]
  ) {
    const { handler, calls } = fixture(telegram);
    assert.equal((await (await handler(request())).json()).uncertain, 1);
    assert.equal(finishBody(calls).p_result, "uncertain");
    assert.equal(
      calls.filter(([url]) => url.hostname === "api.telegram.org").length,
      1,
    );
  }
});

test("unknown event produces no Bot API request and records failure", async () => {
  const { handler, calls } = fixture(
    () => assert.fail("Private content could be sent"),
    {
      jobs: [{ ...job, event_kind: "private_contact" }],
    },
  );
  assert.equal((await (await handler(request())).json()).failed, 1);
  assert.equal(finishBody(calls).p_result, "failed");
  assert.equal(calls.length, 2);
});

test("failed settlement surfaces monitoring counts without attempting another delivery", async () => {
  const { handler, calls } = fixture(
    () => Response.json({ ok: true, result: { message_id: 5 } }),
    { settlement: false },
  );
  const response = await handler(request());
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.equal(result.settlement_errors, 1);
  assert.equal(result.delivered, 0);
  assert.equal(
    calls.filter(([url]) => url.hostname === "api.telegram.org").length,
    1,
  );
});

test("local Bot API server receives the app link and returns a retryable Telegram reply", async () => {
  const received = [];
  const mock = createServer(async (incoming, response) => {
    const body = [];
    for await (const chunk of incoming) body.push(chunk);
    received.push({
      path: incoming.url,
      body: JSON.parse(Buffer.concat(body).toString("utf8")),
    });
    response.writeHead(429, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: false,
        error_code: 429,
        parameters: { retry_after: 75 },
      }),
    );
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  try {
    const miniAppUrl = "https://t.me/example_fixture_bot?startapp";
    const { handler, calls } = fixture(async (bot, options) => {
      const loopback = new URL(
        bot.pathname,
        `http://127.0.0.1:${mock.address().port}`,
      );
      return await fetch(loopback, options);
    }, { config: { miniAppUrl } });
    const response = await handler(request());
    assert.equal(response.status, 200);
    assert.equal((await response.json()).retry, 1);
    assert.equal(finishBody(calls).p_retry_after, 75);
    assert.equal(received.length, 1);
    assert.equal(
      received[0].path,
      "/bot123456:fixture-bot-token-only/sendMessage",
    );
    assert.equal(
      received[0].body.reply_markup.inline_keyboard[0][0].url,
      miniAppUrl,
    );
  } finally {
    await new Promise((resolve, reject) =>
      mock.close((error) => error ? reject(error) : resolve())
    );
  }
});
