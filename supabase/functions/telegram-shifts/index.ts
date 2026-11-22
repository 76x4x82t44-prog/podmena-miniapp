type Config = {
  allowedOrigin: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

const platforms = ["ozon", "wildberries", "yandex_market"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const maxBody = 16_384;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
}

function matches(pattern: RegExp, value: unknown): value is string {
  return typeof value === "string" && pattern.test(value);
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
  const bytes = new Uint8Array(maxBody);
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

// Project user input onto the fields supported by each action. No identity or role
// is forwarded. The session identifies the actor inside the database operation.
function parse(body: unknown) {
  if (!record(body) || !record(body.input)) return null;
  const { action, input } = body;
  const { page = 0, shift_id, application_id } = input;
  const validPage = typeof page === "number" && Number.isInteger(page) &&
    page >= 0 && page <= 100_000;

  switch (action) {
    case "browse": {
      const city = text(input.city ?? "", 80);
      const district = text(input.district ?? "", 100);
      const platform = input.platform ?? null;
      if (
        !validPage || city === null || district === null ||
        (platform !== null &&
          (typeof platform !== "string" || !platforms.includes(platform)))
      ) return null;
      return { action, input: { city, district, platform, page } };
    }
    case "reputation":
      return { action, input: {} };
    case "work_history":
    case "owned":
    case "outgoing":
      return validPage ? { action, input: { page } } : null;
    case "respondents":
      return validPage && matches(uuid, shift_id)
        ? { action, input: { shift_id, page } }
        : null;
    case "apply":
    case "confirm_completion":
    case "request_completion":
    case "complete":
      return matches(uuid, shift_id) ? { action, input: { shift_id } } : null;
    case "withdraw_dispute":
    case "accept_dispute":
      return matches(uuid, shift_id) ? { action, input: { shift_id } } : null;
    case "reply_dispute":
    case "comment_dispute": {
      const message = text(input.message, 500);
      return matches(uuid, shift_id) && message
        ? { action, input: { shift_id, message } }
        : null;
    }
    case "dispute_completion": {
      const reason = text(input.reason, 500);
      return matches(uuid, shift_id) && reason
        ? { action, input: { shift_id, reason } }
        : null;
    }
    case "review": {
      const { stars } = input;
      const comment = text(input.comment ?? "", 500);
      return matches(uuid, shift_id) && typeof stars === "number" &&
          Number.isInteger(stars) && stars >= 1 && stars <= 5 &&
          comment !== null
        ? { action, input: { shift_id, stars, comment } }
        : null;
    }
    case "cancel": {
      const expected_application_id = input.expected_application_id ?? null;
      const reason = text(input.reason ?? "", 500);
      return matches(uuid, shift_id) && reason !== null &&
          (expected_application_id === null ||
            matches(uuid, expected_application_id))
        ? { action, input: { shift_id, expected_application_id, reason } }
        : null;
    }
    case "decline": {
      const reason = text(input.reason ?? "", 500);
      return matches(uuid, shift_id) && matches(uuid, application_id) &&
          reason !== null
        ? { action, input: { shift_id, application_id, reason } }
        : null;
    }
    case "withdraw":
    case "reopen":
    case "confirm":
      return matches(uuid, shift_id) && matches(uuid, application_id)
        ? { action, input: { shift_id, application_id } }
        : null;
    case "create": {
      const city = text(input.city, 80);
      const district = text(input.district, 100);
      const pickup_point = text(input.pickup_point, 160);
      const notes = text(input.notes, 500);
      const time_zone = text(input.time_zone, 50);
      const { platform, date, start_time, end_time, pay_rubles, request_id } =
        input;
      if (
        !city || !district || !pickup_point || notes === null || !time_zone ||
        typeof platform !== "string" || !platforms.includes(platform) ||
        !matches(/^\d{4}-\d{2}-\d{2}$/, date) || !matches(time, start_time) ||
        !matches(time, end_time) ||
        typeof pay_rubles !== "number" || !Number.isSafeInteger(pay_rubles) ||
        pay_rubles < 0 || pay_rubles > 2_147_483_647 ||
        !matches(uuid, request_id)
      ) return null;
      return {
        action,
        input: {
          city,
          district,
          pickup_point,
          notes,
          time_zone,
          platform,
          date,
          start_time,
          end_time,
          pay_rubles,
          request_id,
        },
      };
    }
    default:
      return null;
  }
}

const publicErrors = new Map<string, [string, number]>([
  ["PT401", ["session_expired", 401]],
  ["PT403", ["manager_profile_required", 403]],
  ["PT404", ["shift_not_found", 404]],
  ["PT409", ["shift_not_open", 409]],
  ["PT400", ["invalid_request", 400]],
]);
const specificErrors = new Set([
  "manager_profile_required",
  "worker_profile_required",
  "cannot_apply_to_own_shift",
  "shift_not_found",
  "application_not_found",
  "shift_not_open",
  "shift_not_ready_to_complete",
  "shift_terminal",
  "application_inactive",
  "application_already_selected",
  "application_not_selected",
  "shift_already_started",
  "shift_state_changed",
  "invalid_request",
  "invalid_shift_time",
  "session_expired",
  "completion_under_review",
  "completion_client_update",
  "completion_disputed",
  "completion_request_required",
  "dispute_reason_required",
  "dispute_not_open",
  "dispute_offer_required",
  "dispute_message_required",
  "review_self_forbidden",
  "review_completion_required",
  "review_already_exists",
]);

export function createHandler(config: Config) {
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

    try {
      const data = parse(await readJson(request));
      if (!data) return respond({ error: "invalid_request" }, 400);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token),
      );
      const tokenHash = Array.from(
        new Uint8Array(digest),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
      const response = await fetch(
        new URL("/rest/v1/rpc/podmena_shift_action", config.supabaseUrl),
        {
          method: "POST",
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            p_token_hash: tokenHash,
            p_action: data.action,
            p_input: data.input,
          }),
          signal: AbortSignal.timeout(5_000),
          redirect: "error",
        },
      );
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        if (record(problem)) {
          const error = typeof problem.code === "string"
            ? publicErrors.get(problem.code)
            : undefined;
          if (error) {
            const [fallback, status] = error;
            const message = typeof problem.message === "string" &&
                specificErrors.has(problem.message)
              ? problem.message
              : fallback;
            return respond({ error: message }, status);
          }
          if (
            ["22007", "22008", "22023", "23502", "23514"].includes(
              String(problem.code),
            )
          ) {
            return respond({ error: "invalid_request" }, 400);
          }
        }
        return respond({ error: "service_unavailable" }, 503);
      }
      const result = await response.json();
      return record(result)
        ? respond(result)
        : respond({ error: "service_unavailable" }, 503);
    } catch {
      return respond({ error: "service_unavailable" }, 503);
    }
  };
}

Deno.serve(createHandler({
  allowedOrigin: Deno.env.get("PODMENA_ALLOWED_ORIGIN") ?? "",
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));