type Config = {
  allowedOrigin: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

type Input = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORMS = new Set(["ozon", "wildberries", "yandex_market"]);
const BODY_LIMIT = 16_384;

function record(value: unknown): value is Input {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function trimmed(value: unknown, max: number): string | null {
  return typeof value === "string" && !value.includes("\0") &&
      Array.from(value.trim()).length <= max
    ? value.trim()
    : null;
}

function integerPage(input: Input): number | null {
  const page = input.page ?? 0;
  return typeof page === "number" && Number.isInteger(page) && page >= 0 &&
      page <= 1000
    ? page
    : null;
}

export function parseSocialRequest(
  payload: unknown,
): { action: string; input: Input } | null {
  if (
    !record(payload) || typeof payload.action !== "string" ||
    !record(payload.input)
  ) return null;
  const { action, input } = payload;
  const parsed: Input = {};

  switch (action) {
    case "settings":
      break;
    case "save_settings":
      for (const key of ["visible", "notifications_enabled"]) {
        if (key in input) {
          if (typeof input[key] !== "boolean") return null;
          parsed[key] = input[key];
        }
      }
      if ("description" in input) {
        const text = trimmed(input.description, 500);
        if (text === null) return null;
        parsed.description = text;
      }
      break;
    case "catalog":
    case "connections":
    case "threads": {
      const page = integerPage(input);
      if (page === null) return null;
      parsed.page = page;
      if (action !== "catalog") break;
      for (
        const [key, limit] of [["city", 80], ["district", 100], [
          "experience",
          100,
        ]] as const
      ) {
        if (key in input && input[key] !== null) {
          const text = trimmed(input[key], limit);
          if (text === null) return null;
          if (text) parsed[key] = text;
        }
      }
      if (input.platform != null && input.platform !== "") {
        if (
          typeof input.platform !== "string" || !PLATFORMS.has(input.platform)
        ) return null;
        parsed.platform = input.platform;
      }
      if (input.work_type != null && input.work_type !== "") {
        if (input.work_type !== "single" && input.work_type !== "permanent") {
          return null;
        }
        parsed.work_type = input.work_type;
      }
      break;
    }
    case "request_contact":
      parsed.catalog_id = uuid(input.catalog_id);
      break;
    case "decide_contact":
      parsed.request_id = uuid(input.request_id);
      if (
        input.decision !== "accept" && input.decision !== "reject" &&
        input.decision !== "block"
      ) return null;
      parsed.decision = input.decision;
      break;
    case "shift_thread":
      parsed.shift_id = uuid(input.shift_id);
      parsed.application_id = uuid(input.application_id);
      break;
    case "messages":
      parsed.thread_id = uuid(input.thread_id);
      if ("before" in input) parsed.before = uuid(input.before);
      break;
    case "send_message": {
      const body = trimmed(input.body, 2000);
      if (!body) return null;
      parsed.body = body;
      parsed.thread_id = uuid(input.thread_id);
      parsed.request_id = uuid(input.request_id);
      break;
    }
    case "mark_read":
      parsed.thread_id = uuid(input.thread_id);
      parsed.message_id = uuid(input.message_id);
      break;
    case "block":
    case "unblock": {
      const targets = ["thread_id", "request_id"].filter((key) => key in input);
      if (targets.length !== 1) return null;
      parsed[targets[0]] = uuid(input[targets[0]]);
      break;
    }
    case "report": {
      const targets = ["thread_id", "request_id", "catalog_id"].filter((key) =>
        key in input
      );
      const reason = trimmed(input.reason, 500);
      if (targets.length !== 1 || !reason) return null;
      parsed[targets[0]] = uuid(input[targets[0]]);
      parsed.reason = reason;
      break;
    }
    default:
      return null;
  }
  return Object.values(parsed).some((value) => value === null)
    ? null
    : { action, input: parsed };
}

async function readJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const bytes = new Uint8Array(BODY_LIMIT);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > bytes.length) {
        void reader.cancel().catch(() => {});
        return null;
      }
      bytes.set(value, length);
      length += value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      ),
    );
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

const ERRORS: Record<string, [number, Set<string>, string]> = {
  PT400: [400, new Set(["invalid_request"]), "invalid_request"],
  PT401: [401, new Set(["session_expired"]), "session_expired"],
  PT403: [
    403,
    new Set([
      "forbidden",
      "actor_missing_worker_profile",
      "actor_missing_manager_profile",
    ]),
    "forbidden",
  ],
  PT404: [404, new Set(["not_found"]), "not_found"],
  PT409: [
    409,
    new Set([
      "blocked",
      "contact_already_rejected",
      "contact_already_decided",
      "idempotency_conflict",
    ]),
    "conflict",
  ],
  PT429: [429, new Set(["rate_limited"]), "rate_limited"],
};

export function createSocialHandler(
  config: Config,
  fetcher: typeof fetch = fetch,
) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    const respond = (body: object, status = 200) =>
      Response.json(body, { headers, status });

    if (origin && origin !== config.allowedOrigin) {
      return respond({ error: "origin_not_allowed" }, 403);
    }
    if (origin) {
      headers.set("Access-Control-Allow-Origin", config.allowedOrigin);
    }
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      return new Response(null, { headers, status: 204 });
    }
    if (request.method !== "POST") {
      headers.set("Allow", "POST, OPTIONS");
      return respond({ error: "method_not_allowed" }, 405);
    }

    const token = /^Bearer ([0-9a-f]{64})$/i.exec(
      request.headers.get("Authorization") ?? "",
    )?.[1];
    if (!token) return respond({ error: "session_required" }, 401);
    if (
      !config.allowedOrigin || !config.supabaseUrl || !config.serviceRoleKey
    ) {
      return respond({ error: "service_unavailable" }, 503);
    }

    const parsed = parseSocialRequest(await readJson(request));
    if (!parsed) return respond({ error: "invalid_request" }, 400);

    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token),
      );
      const hash = Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const upstream = await fetcher(
        new URL("/rest/v1/rpc/podmena_social_action", config.supabaseUrl),
        {
          method: "POST",
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            p_token_hash: hash,
            p_action: parsed.action,
            p_input: parsed.input,
          }),
        },
      );
      const value: unknown = await upstream.json().catch(() => null);
      if (upstream.ok && record(value)) return respond(value);
      if (
        record(value) && typeof value.code === "string" &&
        Object.hasOwn(ERRORS, value.code)
      ) {
        const [status, allowed, fallback] = ERRORS[value.code];
        const code =
          typeof value.message === "string" && allowed.has(value.message)
            ? value.message
            : fallback;
        return respond({ error: code }, status);
      }
    } catch {
      // Upstream errors can contain SQL details and request data. Do not log or relay them.
    }
    return respond({ error: "service_unavailable" }, 503);
  };
}

if (import.meta.main) {
  Deno.serve(createSocialHandler({
    allowedOrigin: Deno.env.get("PODMENA_ALLOWED_ORIGIN") ?? "",
    supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  }));
}
