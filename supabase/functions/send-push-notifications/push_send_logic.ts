// Pure logic for the push-sending Edge Function: building Expo Push API
// messages and interpreting their per-message ticket responses. No
// network/DB access here (see push_send_logic_test.ts). Completely
// independent of important-news-monitor -- this module only knows about
// notifications rows and device_push_tokens rows already fetched by the
// caller; it never decides *which* notifications are important or generates
// their content.

export type PendingNotification = {
  id: string;
  title: string;
  summary: string;
  importance: string;
  source_type: string;
  source_id: string;
};

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: { notification_id: string; source_type: string; source_id: string };
  sound?: "default";
};

export function buildExpoPushMessage(
  notification: PendingNotification,
  expoPushToken: string,
): ExpoPushMessage {
  return {
    to: expoPushToken,
    title: notification.title,
    body: notification.summary,
    data: {
      notification_id: notification.id,
      source_type: notification.source_type,
      source_id: notification.source_id,
    },
    sound: "default",
  };
}

// Expo's push API returns one ticket per message, in request order. A ticket
// is either {status:'ok', id} or {status:'error', message, details:{error}}.
// DeviceNotRegistered is the one error Expo documents as permanent (the
// token will never work again, e.g. app uninstalled) -- every other error is
// treated as transient and simply left for the next run to retry.
export type ExpoPushTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; details?: { error?: string } };

export type TicketOutcome =
  | "ok"
  | "device_not_registered"
  | "transient_error"
  | "unknown";

export function classifyTicket(ticket: ExpoPushTicket): TicketOutcome {
  if (ticket.status === "ok") return "ok";
  if (ticket.details?.error === "DeviceNotRegistered") {
    return "device_not_registered";
  }
  return "transient_error";
}

export type DeliveryOutcome = { tokenId: string; outcome: TicketOutcome };

// One notification can reach multiple devices (a user logged in on more than
// one phone). The notification's own push_status reflects the best outcome
// across all of that user's devices, since the user only needs to receive it
// once; individual DeviceNotRegistered tokens are still cleaned up
// per-device regardless of the notification's overall status.
export function decideNotificationPushStatus(
  deliveries: DeliveryOutcome[],
): "sent" | "failed" | "skipped" {
  if (deliveries.length === 0) return "skipped"; // user has no registered devices
  if (deliveries.some((d) => d.outcome === "ok")) return "sent";
  return "failed";
}

export type PushDispatchDecision = {
  status: "sent" | "failed" | "skipped" | "pending";
  errorCode: string | null;
  retryAfterSeconds: number | null;
};

export const MAX_PUSH_ATTEMPTS = 3;
export const PUSH_RETRY_DELAYS_SECONDS = [120, 600] as const;
export const MAX_EXPO_REQUEST_ATTEMPTS = 3;

/** Retry only explicit whole-request rate/server rejection, never transport ambiguity. */
export function shouldRetryExpoRequest(status: number, attemptNumber: number): boolean {
  return attemptNumber < MAX_EXPO_REQUEST_ATTEMPTS &&
    (status === 429 || (status >= 500 && status < 600));
}

export function expoRequestRetryDelayMs(attemptNumber: number): number {
  return 2000 * 2 ** Math.max(0, attemptNumber - 1);
}

/** A lookup failure before any Expo request is safe to retry on the same row. */
export function decidePreSendRetry(attemptCount: number): PushDispatchDecision {
  if (attemptCount < MAX_PUSH_ATTEMPTS) {
    return {
      status: "pending",
      errorCode: "PUSH_PRE_SEND_FAILURE",
      retryAfterSeconds:
        PUSH_RETRY_DELAYS_SECONDS[Math.max(0, attemptCount - 1)] ?? 600,
    };
  }
  return {
    status: "failed",
    errorCode: "PUSH_ATTEMPT_LIMIT_REACHED",
    retryAfterSeconds: null,
  };
}

/**
 * Decide the persisted state after a complete, successful Expo HTTP response.
 * Only explicit per-message transient tickets are retried. A missing ticket is
 * ambiguous (Expo may have accepted the message), so it is terminally failed
 * rather than risking a duplicate push. Retries reuse the same notification row.
 */
export function decideNotificationPushDispatch(
  deliveries: DeliveryOutcome[],
  attemptCount: number,
): PushDispatchDecision {
  if (deliveries.length === 0) {
    return { status: "skipped", errorCode: null, retryAfterSeconds: null };
  }
  if (deliveries.some((delivery) => delivery.outcome === "ok")) {
    return { status: "sent", errorCode: null, retryAfterSeconds: null };
  }
  if (deliveries.some((delivery) => delivery.outcome === "unknown")) {
    return {
      status: "failed",
      errorCode: "PUSH_DELIVERY_OUTCOME_UNKNOWN",
      retryAfterSeconds: null,
    };
  }
  if (deliveries.some((delivery) => delivery.outcome === "transient_error")) {
    if (attemptCount < MAX_PUSH_ATTEMPTS) {
      const retryAfterSeconds =
        PUSH_RETRY_DELAYS_SECONDS[Math.max(0, attemptCount - 1)] ?? 600;
      return {
        status: "pending",
        errorCode: "EXPO_TICKET_TRANSIENT_ERROR",
        retryAfterSeconds,
      };
    }
    return {
      status: "failed",
      errorCode: "PUSH_ATTEMPT_LIMIT_REACHED",
      retryAfterSeconds: null,
    };
  }
  return {
    status: "failed",
    errorCode: "EXPO_DEVICE_NOT_REGISTERED",
    retryAfterSeconds: null,
  };
}

export function tokenIdsToDeactivate(deliveries: DeliveryOutcome[]): string[] {
  return deliveries.filter((d) => d.outcome === "device_not_registered").map((
    d,
  ) => d.tokenId);
}

// Expo's API accepts a batch (array) per request, capped at 100 messages;
// chunk conservatively below that so one oversized run can't be rejected outright.
export const EXPO_PUSH_BATCH_SIZE = 90;

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
