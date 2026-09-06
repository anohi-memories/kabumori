// Sends pending Kabumori push notifications via the Expo Push API. Reads
// only stocks_master-app tables (notifications, device_push_tokens);
// deliberately never imports or touches anything from
// supabase/functions/important-news-monitor -- this function only consumes
// whatever notifications rows already exist with push_status='pending',
// it never decides which news is important or writes notification content.
//
// NOT deployed as part of this task (see .agent/tasks/CLAUDE_TASK.md
// forbidden list: "本番Edge Function deployをしない"). Written to the same
// auth convention as stocks-master-sync/stocks-new-listing-sync
// (verify_jwt=false + a dedicated X-Cron-Secret header, DB access via the
// new-format SUPABASE_SECRET_KEYS) so it is ready to wire into
// supabase/config.toml and a cron job in a later task without rework.
import {
  buildExpoPushMessage,
  chunk,
  classifyTicket,
  decideNotificationPushStatus,
  EXPO_PUSH_BATCH_SIZE,
  shouldSendNotification,
  tokenIdsToDeactivate,
  type AlertSettings,
  type DeliveryOutcome,
  type ExpoPushTicket,
  type PendingNotification,
} from "./push_send_logic.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };
const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";
const NOTIFICATION_BATCH_LIMIT = 200;

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
  return typeof expected === "string" && expected.length > 0 && provided === expected;
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
type PendingNotificationRow = PendingNotification & { user_id: string };

async function fetchPendingNotifications(supabaseUrl: string, secretKey: string): Promise<PendingNotificationRow[]> {
  const result = await fetch(
    `${supabaseUrl}/rest/v1/notifications?push_status=eq.pending` +
      `&select=id,user_id,title,summary,importance,source_type,source_id&limit=${NOTIFICATION_BATCH_LIMIT}`,
    { headers: headers(secretKey) },
  );
  if (!result.ok) throw new Error(`FETCH_PENDING_NOTIFICATIONS_FAILED:${result.status}`);
  return (await result.json()) as PendingNotificationRow[];
}

async function fetchAlertSettingsForUsers(
  supabaseUrl: string,
  secretKey: string,
  userIds: string[],
): Promise<Map<string, AlertSettings>> {
  const byUser = new Map<string, AlertSettings>();
  if (userIds.length === 0) return byUser;
  const idList = userIds.map((id) => encodeURIComponent(id)).join(",");
  const result = await fetch(
    `${supabaseUrl}/rest/v1/alert_settings?user_id=in.(${idList})&select=user_id,push_enabled,important_news`,
    { headers: headers(secretKey) },
  );
  if (!result.ok) throw new Error(`FETCH_ALERT_SETTINGS_FAILED:${result.status}`);
  const rows = (await result.json()) as (AlertSettings & { user_id: string })[];
  for (const row of rows) byUser.set(row.user_id, { push_enabled: row.push_enabled, important_news: row.important_news });
  return byUser;
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
  if (!result.ok) throw new Error(`FETCH_DEVICE_TOKENS_FAILED:${result.status}`);
  return (await result.json()) as DeviceTokenRow[];
}

async function sendExpoPushBatch(
  messages: ReturnType<typeof buildExpoPushMessage>[],
): Promise<ExpoPushTicket[]> {
  if (messages.length === 0) return [];
  const result = await fetch(EXPO_PUSH_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!result.ok) throw new Error(`EXPO_PUSH_API_FAILED:${result.status}`);
  const body = (await result.json()) as { data?: ExpoPushTicket[] };
  return body.data ?? [];
}

async function updateNotificationStatus(
  supabaseUrl: string,
  secretKey: string,
  notificationId: string,
  status: "sent" | "failed" | "skipped",
): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/notifications?id=eq.${encodeURIComponent(notificationId)}`, {
    method: "PATCH",
    headers: headers(secretKey, "return=minimal"),
    body: JSON.stringify({ push_status: status }),
  });
}

async function deactivateDeviceTokens(supabaseUrl: string, secretKey: string, tokenIds: string[]): Promise<void> {
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
  if (!isAuthorizedCronCaller(req)) return response({ error: "UNAUTHORIZED" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) return response({ error: "SERVER_CONFIGURATION_MISSING" }, 500);

  try {
    const pending = await fetchPendingNotifications(supabaseUrl, secretKey);
    if (pending.length === 0) {
      return response({ status: "completed", processedCount: 0 });
    }

    const userIds = Array.from(new Set(pending.map((n) => n.user_id)));
    const alertSettingsByUser = await fetchAlertSettingsForUsers(supabaseUrl, secretKey, userIds);

    // A user who opted out (or opted out of important_news specifically)
    // never reaches the device-token/Expo-API pipeline below -- their
    // notifications go straight to 'skipped', same terminal status already
    // used for "no registered devices" (decideNotificationPushStatus), so no
    // schema change or new push_status value is needed. This also means we
    // never re-fetch their device tokens for nothing.
    const sendable: PendingNotificationRow[] = [];
    const settingsSkipped: PendingNotificationRow[] = [];
    for (const notification of pending) {
      const settings = alertSettingsByUser.get(notification.user_id);
      if (shouldSendNotification(notification, settings)) sendable.push(notification);
      else settingsSkipped.push(notification);
    }

    for (const notification of settingsSkipped) {
      await updateNotificationStatus(supabaseUrl, secretKey, notification.id, "skipped");
    }

    const sendableUserIds = Array.from(new Set(sendable.map((n) => n.user_id)));
    const deviceTokens = await fetchDeviceTokensForUsers(supabaseUrl, secretKey, sendableUserIds);
    const tokensByUser = new Map<string, DeviceTokenRow[]>();
    for (const row of deviceTokens) {
      const list = tokensByUser.get(row.user_id) ?? [];
      list.push(row);
      tokensByUser.set(row.user_id, list);
    }

    // Flatten to one (notification, deviceToken) pair per message, keeping
    // track of which pair each Expo ticket in the batched response
    // corresponds to (Expo preserves request order across one batch).
    const pairs: { notification: PendingNotificationRow; deviceToken: DeviceTokenRow }[] = [];
    for (const notification of sendable) {
      const devices = tokensByUser.get(notification.user_id) ?? [];
      for (const deviceToken of devices) pairs.push({ notification, deviceToken });
    }

    const messages = pairs.map((p) => buildExpoPushMessage(p.notification, p.deviceToken.expo_push_token));
    const tickets: ExpoPushTicket[] = [];
    for (const batch of chunk(messages, EXPO_PUSH_BATCH_SIZE)) {
      tickets.push(...(await sendExpoPushBatch(batch)));
    }

    const deliveriesByNotification = new Map<string, DeliveryOutcome[]>();
    const tokensToDeactivate: string[] = [];
    pairs.forEach((pair, index) => {
      const ticket = tickets[index];
      const outcome = ticket ? classifyTicket(ticket) : "transient_error";
      const list = deliveriesByNotification.get(pair.notification.id) ?? [];
      list.push({ tokenId: pair.deviceToken.id, outcome });
      deliveriesByNotification.set(pair.notification.id, list);
      if (outcome === "device_not_registered") tokensToDeactivate.push(pair.deviceToken.id);
    });

    for (const notification of sendable) {
      const deliveries = deliveriesByNotification.get(notification.id) ?? [];
      const status = decideNotificationPushStatus(deliveries);
      await updateNotificationStatus(supabaseUrl, secretKey, notification.id, status);
    }
    await deactivateDeviceTokens(supabaseUrl, secretKey, Array.from(new Set(tokensToDeactivate)));

    return response({
      status: "completed",
      processedCount: pending.length,
      settingsSkippedCount: settingsSkipped.length,
      messagesSent: messages.length,
      deactivatedTokenCount: new Set(tokensToDeactivate).size,
    });
  } catch (error) {
    return response({ error: "UNEXPECTED_ERROR", detail: safeError(error) }, 500);
  }
});
