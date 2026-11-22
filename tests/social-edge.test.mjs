import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { createSocialHandler, parseSocialRequest } from "../supabase/functions/telegram-social/index.ts";

const origin = "https://pilot.example";
const config = { allowedOrigin: origin, supabaseUrl: "https://db.example", serviceRoleKey: "synthetic-server-key" };
const opaqueId = "8342fb73-0252-45dc-a18c-d4941565fccd";
const requestId = "9ac1ebc6-56a3-412f-b5d0-97802be6943a";
const validToken = "a".repeat(64);

function request(payload, token = validToken, website = origin) {
  return new Request("https://api.example/function", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, Origin: website },
    body: JSON.stringify(payload),
  });
}

test("parser drops spoofed author IDs and preserves user text", () => {
  const body = '<svg onclick="alert(1)">';
  assert.deepEqual(parseSocialRequest({ action: "send_message", input: {
    thread_id: opaqueId, request_id: requestId, body, sender_id: opaqueId, actor_id: opaqueId,
  } }), { action: "send_message", input: { thread_id: opaqueId, request_id: requestId, body } });
});

test("parser enforces text lengths, paging and an unambiguous object for reporting", () => {
  assert.equal(parseSocialRequest({ action: "send_message", input: {
    thread_id: opaqueId, request_id: requestId, body: "ч".repeat(2001),
  } }), null);
  assert.equal(parseSocialRequest({ action: "send_message", input: {
    thread_id: opaqueId, request_id: requestId, body: " \n ",
  } }), null);
  assert.equal(parseSocialRequest({ action: "catalog", input: { page: -1 } }), null);
  assert.equal(parseSocialRequest({ action: "catalog", input: { page: 1.2 } }), null);
  assert.equal(parseSocialRequest({ action: "catalog", input: { platform: "invalid" } }), null);
  assert.equal(parseSocialRequest({ action: "report", input: { thread_id: opaqueId,
    request_id: requestId, reason: "причина" } }), null);
  assert.deepEqual(parseSocialRequest({ action: "unblock", input: { request_id: requestId } }),
    { action: "unblock", input: { request_id: requestId } });
});

test("bad Bearer, origin and oversized body are rejected before the database", async () => {
  const handler = createSocialHandler(config, () => {
    throw new Error("unexpected database call");
  });
  const payload = { action: "settings", input: {} };
  assert.equal((await handler(request(payload, "bad"))).status, 401);
  assert.equal((await handler(request(payload, validToken, "https://pilot.example.attacker.example"))).status, 403);
  assert.equal((await handler(request({ ...payload, unstored: "x".repeat(17000) }))).status, 400);
});

test("only token hash and allowlisted fields reach RPC, with a request timeout", async () => {
  const handler = createSocialHandler(config, async (url, init) => {
    assert.equal(url.href, "https://db.example/rest/v1/rpc/podmena_social_action");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Authorization, "Bearer synthetic-server-key");
    assert.deepEqual(JSON.parse(init.body), {
      p_token_hash: createHash("sha256").update(validToken).digest("hex"),
      p_action: "catalog",
      p_input: { city: "СПб", page: 0 },
    });
    return Response.json({ items: [], has_more: false });
  });
  const response = await handler(request({ action: "catalog", input: { city: "СПб", user: opaqueId } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { items: [], has_more: false });
});

test("expired sessions, rate limits and upstream timeouts never reveal internal details", async () => {
  const invoke = async (fetcher) => {
    const handler = createSocialHandler(config, fetcher);
    const response = await handler(request({ action: "settings", input: {} }));
    return [response.status, await response.json()];
  };
  assert.deepEqual(await invoke(async () => Response.json({ code: "PT401", message: "private details" }, { status: 401 })),
    [401, { error: "session_expired" }]);
  assert.deepEqual(await invoke(async () => Response.json({ code: "PT429", message: "rate_limited" }, { status: 429 })),
    [429, { error: "rate_limited" }]);
  assert.deepEqual(await invoke(async () => {
    throw new DOMException("synthetic timeout detail", "TimeoutError");
  }), [503, { error: "service_unavailable" }]);
});
