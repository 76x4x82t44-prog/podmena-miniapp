// PODMENA stage 3A: telegram-auth, self-contained Dashboard version.
// Combined from Codex-supplied init-data.ts, handler.ts and index.ts.

const encoder = new TextEncoder();
const maxAgeSeconds = 5 * 60;
const futureSkewSeconds = 30;

async function importHmacKey(bytes: BufferSource) {
  return await crypto.subtle.importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    [
      "sign",
      "verify",
    ],
  );
}

async function verifyTelegramInitData(
  initData: string,
  botToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ telegramId: number; telegramHash: string } | null> {
  if (initData.length > 16_384) return null;
  const params = new URLSearchParams(initData);
  const seen = new Set<string>();
  for (const [name, value] of params) {
    if (
      !/^[a-z][a-z0-9_]*$/.test(name) || seen.has(name) || /[\r\n]/.test(value)
    ) return null;
    seen.add(name);
  }

  const hash = params.get("hash")?.toLowerCase();
  const authDate = params.get("auth_date") ?? "";
  const userJson = params.get("user");
  if (
    !hash || !/^[0-9a-f]{64}$/.test(hash) || !/^\d{1,12}$/.test(authDate) ||
    !userJson
  ) return null;
  const age = nowSeconds - Number(authDate);
  if (age > maxAgeSeconds || age < -futureSkewSeconds) return null;

  params.delete("hash");
  params.sort();
  const dataCheckString = Array.from(
    params,
    ([name, value]) => `${name}=${value}`,
  ).join("\n");
  const rootKey = await importHmacKey(encoder.encode("WebAppData"));
  const secret = await crypto.subtle.sign(
    "HMAC",
    rootKey,
    encoder.encode(botToken),
  );
  const hmacKey = await importHmacKey(secret);
  const providedHash = Uint8Array.from(
    { length: 32 },
    (_, i) => Number.parseInt(hash.slice(2 * i, 2 * i + 2), 16),
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    hmacKey,
    providedHash,
    encoder.encode(dataCheckString),
  );
  if (!valid) return null;

  try {
    const telegramId = JSON.parse(userJson)?.id;
    if (
      !Number.isSafeInteger(telegramId) || telegramId < 1 ||
      telegramId > 2 ** 52 - 1
    ) return null;
    return { telegramId, telegramHash: hash };
  } catch {
    return null;
  }
}



const maxBodyBytes = 32_768;

type Config = {
  allowedOrigin: string;
  botToken: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

async function readInitData(request: Request): Promise<string | null> {
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
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
    );
    return typeof body?.initData === "string" ? body.initData : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(new Uint8Array(digest));
}

export function createHandler(config: Config) {
  async function callRpc(name: string, args: Record<string, string | number>) {
    return await fetch(new URL(`/rest/v1/rpc/${name}`, config.supabaseUrl), {
      method: "POST",
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  }

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
      headers.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type",
      );
      return new Response(null, { status: 204, headers });
    }
    if (
      !config.allowedOrigin || !config.botToken || !config.supabaseUrl ||
      !config.serviceRoleKey
    ) {
      return json({ error: "service_unavailable" }, 503);
    }

    try {
      let response: Response;
      let sessionToken: string | undefined;
      if (request.method === "POST") {
        const initData = await readInitData(request);
        if (!initData) return json({ error: "init_data_required" }, 400);
        const user = await verifyTelegramInitData(initData, config.botToken);
        if (!user) return json({ error: "invalid_or_expired_init_data" }, 401);
        sessionToken = toHex(crypto.getRandomValues(new Uint8Array(32)));
        response = await callRpc("podmena_start_telegram_session", {
          p_telegram_id: user.telegramId,
          p_telegram_hash: user.telegramHash,
          p_token_hash: await hashToken(sessionToken),
        });
        if (response.status === 409) {
          return json({ error: "init_data_already_used" }, 409);
        }
      } else if (request.method === "GET") {
        const token = /^Bearer ([0-9a-f]{64})$/i.exec(
          request.headers.get("Authorization") ?? "",
        )?.[1];
        if (!token) return json({ error: "session_required" }, 401);
        response = await callRpc("podmena_get_session_user", {
          p_token_hash: await hashToken(token),
        });
      } else {
        headers.set("Allow", "POST, GET, OPTIONS");
        return json({ error: "method_not_allowed" }, 405);
      }

      if (!response.ok) return json({ error: "service_unavailable" }, 503);
      const [session] = await response.json();
      if (!session && request.method === "GET") {
        return json({ error: "invalid_or_expired_session" }, 401);
      }
      if (
        typeof session?.user_id !== "string" ||
        typeof session.expires_at !== "string"
      ) {
        return json({ error: "service_unavailable" }, 503);
      }
      return json({
        userId: session.user_id,
        expiresAt: session.expires_at,
        ...(sessionToken ? { sessionToken } : {}),
      });
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  };
}



Deno.serve(createHandler({
  allowedOrigin: Deno.env.get("PODMENA_ALLOWED_ORIGIN") ?? "",
  botToken: Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "",
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
