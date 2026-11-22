// ПОДМЕНА — telegram-profiles. Подготовлено из исходных файлов Codex этапа 3В.
// Вставить весь файл в Supabase Edge Functions / telegram-profiles / index.ts.

type Config = {
  allowedOrigin: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

const maxBodyBytes = 16_384;
const platforms = ["ozon", "wildberries", "yandex_market"];

async function readJson(request: Request): Promise<unknown> {
  if (
    request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
  ) {
    return null;
  }
  const reader = request.body?.getReader();
  if (!reader) return null;
  const buffer = new Uint8Array(maxBodyBytes);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.length > buffer.length) {
        void reader.cancel().catch(() => {});
        return null;
      }
      buffer.set(value, size);
      size += value.length;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
    );
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number, required = false): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const clean = value.trim();
  return clean.length <= max && (!required || clean !== "") ? clean : null;
}

function validate(body: unknown) {
  if (
    !object(body) || !object(body.profile) ||
    (body.role !== "worker" && body.role !== "manager")
  ) return null;
  const { role, profile } = body;
  const contact = body.contact === undefined
    ? null
    : text(body.contact, role === "worker" ? 40 : 160);
  const name = text(profile.name, 80, true);
  const city = text(profile.city, 80, true);
  const district = text(profile.district, 100, true);
  if (
    (body.contact !== undefined && contact === null) || !name || !city ||
    !district
  ) return null;

  const shared = { name, city, district };
  if (role === "worker") {
    const { accepts_single_shifts, accepts_permanent_work } = profile;
    const experience = text(profile.experience, 100, true);
    const about = text(profile.about, 500);
    if (
      !experience || about === null ||
      typeof accepts_single_shifts !== "boolean" ||
      typeof accepts_permanent_work !== "boolean" ||
      !(accepts_single_shifts || accepts_permanent_work) ||
      !Array.isArray(profile.platforms) || profile.platforms.length < 1 ||
      profile.platforms.length > 3 ||
      !profile.platforms.every((value) =>
        typeof value === "string" && platforms.includes(value)
      ) ||
      new Set(profile.platforms).size !== profile.platforms.length
    ) return null;
    return {
      role,
      contact,
      profile: {
        ...shared,
        platforms: profile.platforms,
        experience,
        accepts_single_shifts,
        accepts_permanent_work,
        about,
      },
    };
  }
  const pickup_point = text(profile.pickup_point, 160, true);
  const conditions = text(profile.conditions, 500);
  const platform = profile.platform;
  if (
    !pickup_point || conditions === null || typeof platform !== "string" ||
    !platforms.includes(platform)
  ) return null;
  return {
    role,
    contact,
    profile: { ...shared, pickup_point, conditions, platform },
  };
}

export function createHandler(config: Config) {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
      "Cache-Control": "no-store",
      Vary: "Origin",
    });
    const json = (body: object, status = 200) =>
      Response.json(body, { headers, status });

    if (origin && origin !== config.allowedOrigin) {
      return json({ error: "origin_not_allowed" }, 403);
    }
    if (origin) {
      headers.set("Access-Control-Allow-Origin", config.allowedOrigin);
    }
    if (request.method === "OPTIONS") {
      headers.set("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== "GET" && request.method !== "PUT") {
      headers.set("Allow", "GET, PUT, OPTIONS");
      return json({ error: "method_not_allowed" }, 405);
    }
    const token = /^Bearer ([0-9a-f]{64})$/i.exec(
      request.headers.get("Authorization") ?? "",
    )?.[1];
    if (!token) return json({ error: "session_required" }, 401);
    if (
      !config.allowedOrigin || !config.supabaseUrl || !config.serviceRoleKey
    ) {
      return json({ error: "service_unavailable" }, 503);
    }

    try {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(token),
      );
      const tokenHash = Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const args: Record<string, unknown> = { p_token_hash: tokenHash };
      let rpc = "podmena_read_profiles";
      if (request.method === "PUT") {
        const data = validate(await readJson(request));
        if (!data) return json({ error: "invalid_profile" }, 400);
        rpc = "podmena_save_profile";
        Object.assign(args, {
          p_role: data.role,
          p_profile: data.profile,
          p_contact: data.contact,
        });
      }

      const response = await fetch(
        new URL(`/rest/v1/rpc/${rpc}`, config.supabaseUrl),
        {
          method: "POST",
          headers: {
            apikey: config.serviceRoleKey,
            Authorization: `Bearer ${config.serviceRoleKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(args),
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) {
        const problem = await response.json().catch(() => null);
        if (response.status === 401 && problem?.code === "PT401") {
          return json({ error: "invalid_or_expired_session" }, 401);
        }
        if (
          response.status === 400 &&
          ["23502", "23514", "22P02", "PT400"].includes(problem?.code)
        ) {
          return json({ error: "invalid_profile" }, 400);
        }
        return json({ error: "service_unavailable" }, 503);
      }
      const result = await response.json();
      if (request.method === "PUT" && result === true) {
        return json({ saved: true });
      }
      if (request.method === "GET" && object(result)) return json(result);
      return json({ error: "service_unavailable" }, 503);
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  };
}




Deno.serve(createHandler({
  allowedOrigin: Deno.env.get("PODMENA_ALLOWED_ORIGIN") ?? "",
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
