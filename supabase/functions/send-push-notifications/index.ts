// Sends pending Kabumori push notifications via the Expo Push API. Reads
// only stocks_master-app tables (notifications, device_push_tokens);
// deliberately never imports or touches anything from
// supabase/functions/important-news-monitor -- this function only consumes
// whatever notifications rows already exist with push_status='pending',
// it never decides which news is important or writes notification content.
//
// Invoked by the database Cron using the dedicated X-Cron-Secret header.
// Claims are obtained atomically from Postgres; this function never decides
// which news is important or creates notification rows.
import {
  buildExpoPushMessage,
  chunk,
  classifyTicket,
  decideNotificationPushDispatch,
  decidePreSendRetry,
  type DeliveryOutcome,
  expoRequestRetryDelayMs,
  EXPO_PUSH_BATCH_SIZE,
  type ExpoPushTicket,
  MAX_EXPO_REQUEST_ATTEMPTS,
  type PendingNotification,
  shouldRetryExpoRequest,
  tokenIdsToDeactivate,
} from "./push_send_logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const NOTIFICATION_BATCH_LIMIT = 200;

class ExpoHttpError extends Error {
  constructor(readonly status: number) {
    super(`EXPO_PUSH_API_FAILED:${status}`);
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function headers(secretKey: string, prefer?: string): Record<string, string> {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

function safeError(error: unknown): string {
  const value = error instanceof Error ? error.message : "UNEXPECTED_ERROR";
  return value.slice(0, 500);
}

function isAuthorizedCronCaller(req: Request): boolean {
  const expected = Deno.env.get("SEND_PUSH_NOTIFICATIONS_CRON_SECRET");
  const provided = req.headers.get("X-Cron-Secret");
  return typeof expected === "string" && expected.length > 0 &&
    provided === expected;
}

function getSecretKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed["default"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

type DeviceTokenRow = { id: string; user_id: string; expo_push_token: string };
type ClaimedNotificationRow = PendingNotification & {
  user_id: string;
  claim_token: string;
  attempt_count: number;
};

async function claimPendingNotifications(
  supabaseUrl: string,
  secretKey: string,
): Promise<ClaimedNotificationRow[]> {
  const result = await fetch(
    `${supabaseUrl}/rest/v1/rpc/claim_pending_push_notifications`,
    {
      method: "POST",
      headers: headers(secretKey),
      body: JSON.stringify({ p_limit: NOTIFICATION_BATCH_LIMIT }),
    },
  );
  if (!result.ok) {
    throw new Error(`CLAIM_PENDING_NOTIFICATIONS_FAILED:${result.status}`);
  }
  return (await result.json()) as ClaimedNotificationRow[];
}

async function fetchDeviceTokensForUsers(
  supabaseUrl: string,
  secretKey: string,
  userIds: string[],
): Promise<DeviceTokenRow[]> {
  if (userIds.length === 0) return [];
  const idList = userIds.map((id) => encodeURIComponent(id)).join(",");
  const result = await fetch(
    `${supabaseUrl}/rest/v1/device_push_tokens?user_id=in.(${idList})&select=id,user_id,expo_push_token`,
    { headers: headers(secretKey) },
  );
  if (!result.ok) {
    throw new Error(`FETCH_DEVICE_TOKENS_FAILED:${result.status}`);
  }
  return (await result.json()) as DeviceTokenRow[];
}

async function sendExpoPushBatch(
  messages: ReturnType<typeof buildExpoPushMessage>[],
): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  for (let attempt = 1; attempt <= MAX_EXPO_REQUEST_ATTEMPTS; attempt++) {
    // A transport exception has an ambiguous outcome and is deliberately not
    // retried. Only an explicit Expo 429/5xx response uses bounded backoff.
    const result = await fetch(EXPO_PUSH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(messages),
    });
    if (result.ok) {
      const body = (await result.json()) as { data?: ExpoPushTicket[] };
      return body.data ?? [];
    }
    if (!shouldRetryExpoRequest(result.status, attempt)) {
      throw new ExpoHttpError(result.status);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, expoRequestRetryDelayMs(attempt))
    );
  }
  throw new ExpoHttpError(503);
}

async function updateClaimedNotification(
  supabaseUrl: string,
  secretKey: string,
  notification: ClaimedNotificationRow,
  decision: ReturnType<typeof decideNotificationPushDispatch>,
): Promise<void> {
  const nextAttemptAt = decision.retryAfterSeconds === null
    ? null
    : new Date(Date.now() + decision.retryAfterSeconds * 1000).toISOString();
  const result = await fetch(
    `${supabaseUrl}/rest/v1/notifications?id=eq.${
      encodeURIComponent(notification.id)
    }` +
      `&push_status=eq.processing&push_claim_token=eq.${
        encodeURIComponent(notification.claim_token)
      }`,
    {
      method: "PATCH",
      headers: headers(secretKey, "return=representation"),
      body: JSON.stringify({
        push_status: decision.status,
        push_claimed_at: null,
        push_claim_token: null,
        push_next_attempt_at: nextAttemptAt,
        push_last_error_code: decision.errorCode,
      }),
    },
  );
  if (!result.ok) {
    throw new Error(`UPDATE_CLAIMED_NOTIFICATION_FAILED:${result.status}`);
  }
  const updated = await result.json() as unknown[];
  if (updated.length !== 1) {
    throw new Error("UPDATE_CLAIMED_NOTIFICATION_FAILED:CLAIM_LOST");
  }
}

async function finalizeUnknownProviderOutcome(
  supabaseUrl: string,
  secretKey: string,
  notifications: ClaimedNotificationRow[],
): Promise<void> {
  for (const notification of notifications) {
    await updateClaimedNotification(supabaseUrl, secretKey, notification, {
      status: "failed",
      errorCode: "PUSH_DELIVERY_OUTCOME_UNKNOWN",
      retryAfterSeconds: null,
    });
  }
}

async function deactivateDeviceTokens(
  supabaseUrl: string,
  secretKey: string,
  tokenIds: string[],
): Promise<void> {
  if (tokenIds.length === 0) return;
  const idList = tokenIds.map((id) => encodeURIComponent(id)).join(",");
  // Deleted, not soft-flagged: an invalid Expo token is permanently useless
  // (see DeviceNotRegistered in push_send_logic.ts) and the unique
  // constraint on expo_push_token would otherwise block that same physical
  // device from ever re-registering.
  await fetch(`${supabaseUrl}/rest/v1/device_push_tokens?id=in.(${idList})`, {
    method: "DELETE",
    headers: headers(secretKey, "return=minimal"),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "POST_REQUIRED" }, 405);
  if (!isAuthorizedCronCaller(req)) {
    return response({ error: "UNAUTHORIZED" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) {
    return response({ error: "SERVER_CONFIGURATION_MISSING" }, 500);
  }

  let claimed: ClaimedNotificationRow[] = [];
  try {
    claimed = await claimPendingNotifications(supabaseUrl, secretKey);
    if (claimed.length === 0) {
      return response({ status: "completed", processedCount: 0 });
    }

    const userIds = Array.from(new Set(claimed.map((n) => n.user_id)));
    let deviceTokens: DeviceTokenRow[];
    try {
      deviceTokens = await fetchDeviceTokensForUsers(
        supabaseUrl,
        secretKey,
        userIds,
      );
    } catch {
      // No Expo request has started, so bounded retry of the same rows is safe.
      for (const notification of claimed) {
        await updateClaimedNotification(
          supabaseUrl,
          secretKey,
          notification,
          decidePreSendRetry(notification.attempt_count),
        );
      }
      throw new Error("FETCH_DEVICE_TOKENS_FAILED");
    }

    const tokensByUser = new Map<string, DeviceTokenRow[]>();
    for (const row of deviceTokens) {
      const list = tokensByUser.get(row.user_id) ?? [];
      list.push(row);
      tokensByUser.set(row.user_id, list);
    }

    // Flatten to one (notification, deviceToken) pair per message, keeping
    // track of which pair each Expo ticket in the batched response
    // corresponds to (Expo preserves request order across one batch).
    const pairs: {
      notification: ClaimedNotificationRow;
      deviceToken: DeviceTokenRow;
    }[] = [];
    for (const notification of claimed) {
      const devices = tokensByUser.get(notification.user_id) ?? [];
      for (const deviceToken of devices) {
        pairs.push({ notification, deviceToken });
      }
    }

    const notificationIdsWithDevices = new Set(
      pairs.map((pair) => pair.notification.id),
    );
    const withoutDevices = claimed.filter((notification) =>
      !notificationIdsWithDevices.has(notification.id)
    );
    for (const notification of withoutDevices) {
      await updateClaimedNotification(supabaseUrl, secretKey, notification, {
        status: "skipped",
        errorCode: null,
        retryAfterSeconds: null,
      });
    }

    const messages = pairs.map((p) =>
      buildExpoPushMessage(p.notification, p.deviceToken.expo_push_token)
    );
    const withDevices = claimed.filter((notification) =>
      notificationIdsWithDevices.has(notification.id)
    );
    const alignedTickets: (ExpoPushTicket | undefined)[] = [];
    const possiblyDeliveredIds = new Set<string>();
    let pairOffset = 0;
    try {
      for (const batch of chunk(messages, EXPO_PUSH_BATCH_SIZE)) {
        // Include this batch before awaiting fetch: on rejection, the provider
        // may have accepted it even though no response reached this function.
        for (const pair of pairs.slice(pairOffset, pairOffset + batch.length)) {
          possiblyDeliveredIds.add(pair.notification.id);
        }
        const batchTickets = await sendExpoPushBatch(batch);
        pairOffset += batch.length;
        if (batchTickets.length === batch.length) {
          alignedTickets.push(...batchTickets);
        } else {
          // A cardinality mismatch makes positional ticket-to-device mapping
          // unsafe for this batch. Preserve indexes and never retry unknowns.
          alignedTickets.push(
            ...Array.from({ length: batch.length }, () => undefined),
          );
        }
      }
    } catch {
      // A transport/HTTP failure after a request begins is ambiguous: Expo may
      // have accepted it. Do not return these rows to pending and risk a resend.
      const possiblyDelivered = withDevices.filter((notification) =>
        possiblyDeliveredIds.has(notification.id)
      );
      await finalizeUnknownProviderOutcome(
        supabaseUrl,
        secretKey,
        possiblyDelivered,
      );
      // Notifications appearing only in later, never-started batches are known
      // not to have reached Expo and may retry on their existing rows.
      for (const notification of withDevices) {
        if (!possiblyDeliveredIds.has(notification.id)) {
          await updateClaimedNotification(
            supabaseUrl,
            secretKey,
            notification,
            decidePreSendRetry(notification.attempt_count),
          );
        }
      }
      throw new Error("EXPO_PUSH_OUTCOME_UNKNOWN");
    }

    const deliveriesByNotification = new Map<string, DeliveryOutcome[]>();
    const tokensToDeactivate: string[] = [];
    pairs.forEach((pair, index) => {
      const ticket = alignedTickets[index];
      const outcome = ticket ? classifyTicket(ticket) : "unknown";
      const list = deliveriesByNotification.get(pair.notification.id) ?? [];
      list.push({ tokenId: pair.deviceToken.id, outcome });
      deliveriesByNotification.set(pair.notification.id, list);
      if (outcome === "device_not_registered") {
        tokensToDeactivate.push(pair.deviceToken.id);
      }
    });

    for (const notification of withDevices) {
      const deliveries = deliveriesByNotification.get(notification.id) ?? [];
      const decision = decideNotificationPushDispatch(
        deliveries,
        notification.attempt_count,
      );
      await updateClaimedNotification(
        supabaseUrl,
        secretKey,
        notification,
        decision,
      );
    }
    await deactivateDeviceTokens(
      supabaseUrl,
      secretKey,
      Array.from(new Set(tokensToDeactivate)),
    );

    return response({
      status: "completed",
      processedCount: claimed.length,
      messagesSent: messages.length,
      deactivatedTokenCount: new Set(tokensToDeactivate).size,
    });
  } catch (error) {
    return response(
      { error: "UNEXPECTED_ERROR", detail: safeError(error) },
      500,
    );
  }
});
