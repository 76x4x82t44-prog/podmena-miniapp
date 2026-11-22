import { timingSafeEqual } from "node:crypto";

type Config = {
  workerSecret: string;
  botToken: string;
  miniAppUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
};

const messages: Readonly<Record<string, string>> = Object.freeze({
  new_application: "На вашу смену поступил отклик.",
  assignment: "Вас назначили исполнителем смены.",
  worker_declined: "Исполнитель отказался от смены.",
  shift_cancelled: "Одна из ваших смен отменена.",
  replacement_opened: "По смене снова открыт поиск исполнителя.",
  completion_requested: "Подтвердите завершение смены в приложении.",
  completion_confirmed: "Выполнение смены подтверждено.",
  dispute_opened: "По смене открыт спор.",
  dispute_replied: "В споре по смене появился новый ответ.",
  dispute_resolved: "Спор по смене урегулирован.",
  dispute_withdrawn: "Спор по смене отозван.",
  chat_message: "В приложении новое сообщение.",
  connection_request: "В приложении новый запрос на связь.",
});

const maxBatch = 5;
const maxRetryAfter = 86_400;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

type Outcome = "delivered" | "retry" | "unavailable" | "failed" | "uncertain";
type Result = { outcome: Outcome; retryAfter?: number };

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function safeHttps(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    ) return url;
  } catch {
    // A missing or malformed URL is a configuration error.
  }
}

async function authorized(
  given: string | null,
  expected: string,
): Promise<boolean> {
  if (given === null) return false;
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", encoder.encode(value));
  const [candidate, secret] = await Promise.all([
    digest(given),
    digest(expected),
  ]);
  return timingSafeEqual(new Uint8Array(candidate), new Uint8Array(secret));
}

function validTelegramId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) &&
    BigInt(value) <= 4_503_599_627_370_495n;
}

function resultForBotReply(response: Response, value: unknown): Result {
  const reply = record(value);
  if (
    response.ok && reply?.ok === true &&
    Number.isInteger(record(reply.result)?.message_id)
  ) {
    return { outcome: "delivered" };
  }
  if (reply?.ok !== false || reply.error_code !== response.status) {
    // A proxy or network can fail after Telegram received the request.
    return { outcome: "uncertain" };
  }
  const code = response.status;
  if (
    code === 403 || (code === 400 && typeof reply.description === "string" &&
      /chat not found|user is deactivated|bot can.t initiate conversation/i
        .test(reply.description))
  ) {
    return { outcome: "unavailable" };
  }
  if (code === 429) {
    const delay = record(reply.parameters)?.retry_after;
    if (
      typeof delay === "number" && Number.isSafeInteger(delay) &&
      delay > maxRetryAfter
    ) {
      return { outcome: "failed" };
    }
    return {
      outcome: "retry",
      retryAfter:
        typeof delay === "number" && Number.isSafeInteger(delay) && delay > 0
          ? delay
          : 60,
    };
  }
  if (code >= 500) return { outcome: "retry" };
  return { outcome: "failed" };
}

export function createNotificationWorker(
  config: Config,
  network: typeof fetch = fetch,
) {
  const miniApp = safeHttps(config.miniAppUrl);
  const supabase = safeHttps(config.supabaseUrl);
  const configured = config.workerSecret.length >= 32 &&
    /^[0-9]+:[a-z0-9_-]+$/i.test(config.botToken) &&
    config.serviceRoleKey.length > 0 && supabase && miniApp;

  function respond(
    body: Record<string, number>,
    status: number,
    allow?: string,
  ) {
    const headers = new Headers({ "Cache-Control": "no-store" });
    if (allow) headers.set("Allow", allow);
    return Response.json(body, { status, headers });
  }

  function rpc(name: string, body: object) {
    return network(new URL("/rest/v1/rpc/" + name, supabase), {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        apikey: config.serviceRoleKey,
        Authorization: "Bearer " + config.serviceRoleKey,
      },
      signal: AbortSignal.timeout(5_000),
      body: JSON.stringify(body),
    });
  }

  async function deliver(
    telegramId: string,
    text: string,
    miniAppUrl: URL,
  ): Promise<Result> {
    const openButton = miniAppUrl.hostname === "t.me"
      ? { text: "Открыть ПОДМЕНУ", url: miniAppUrl.href }
      : { text: "Открыть ПОДМЕНУ", web_app: { url: miniAppUrl.href } };
    try {
      const response = await network(
        new URL(
          "https://api.telegram.org/bot" + config.botToken + "/sendMessage",
        ),
        {
          method: "POST",
          redirect: "error",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8_000),
          body: JSON.stringify({
            chat_id: telegramId,
            text: "ПОДМЕНА\n" + text,
            reply_markup: { inline_keyboard: [[openButton]] },
          }),
        },
      );
      return resultForBotReply(response, await response.json());
    } catch {
      return { outcome: "uncertain" };
    }
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return respond({}, 405, "POST");
    if (!configured) return respond({}, 503);
    if (
      !await authorized(
        request.headers.get("x-podmena-worker-secret"),
        config.workerSecret,
      )
    ) {
      return respond({}, 401);
    }

    const counts = {
      claimed: 0,
      delivered: 0,
      retry: 0,
      unavailable: 0,
      failed: 0,
      uncertain: 0,
      settlement_errors: 0,
    };
    let rows: unknown;
    try {
      const claim = await rpc("podmena_claim_notifications", {
        p_limit: maxBatch,
      });
      if (!claim.ok) return respond(counts, 503);
      rows = await claim.json();
    } catch {
      return respond(counts, 503);
    }
    if (!Array.isArray(rows) || rows.length > maxBatch) {
      return respond(counts, 503);
    }
    counts.claimed = rows.length;

    for (const row of rows) {
      const job = record(row);
      if (
        !job || typeof job.id !== "string" || !uuid.test(job.id) ||
        typeof job.lease_token !== "string" || !uuid.test(job.lease_token)
      ) {
        counts.settlement_errors++;
        continue;
      }

      const content = typeof job.event_kind === "string" &&
          Object.hasOwn(messages, job.event_kind)
        ? messages[job.event_kind]
        : undefined;
      const result: Result = content && validTelegramId(job.telegram_id)
        ? await deliver(job.telegram_id, content, configured)
        : { outcome: "failed" };
      try {
        const settled = await rpc("podmena_finish_notification", {
          p_id: job.id,
          p_lease_token: job.lease_token,
          p_result: result.outcome,
          p_retry_after: result.retryAfter ?? null,
        });
        if (!settled.ok || await settled.json() !== true) {
          counts.settlement_errors++;
        } else {
          counts[result.outcome]++;
        }
      } catch {
        counts.settlement_errors++;
      }
    }
    return respond(counts, counts.settlement_errors ? 503 : 200);
  };
}

Deno.serve(createNotificationWorker({
  workerSecret: Deno.env.get("PODMENA_NOTIFICATION_WORKER_SECRET") ?? "",
  botToken: Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "",
  miniAppUrl: Deno.env.get("PODMENA_MINI_APP_URL") ?? "",
  supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
  serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
}));
