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
  sound?: 'default';
};

export function buildExpoPushMessage(notification: PendingNotification, expoPushToken: string): ExpoPushMessage {
  return {
    to: expoPushToken,
    title: notification.title,
    body: notification.summary,
    data: {
      notification_id: notification.id,
      source_type: notification.source_type,
      source_id: notification.source_id,
    },
    sound: 'default',
  };
}

// Expo's push API returns one ticket per message, in request order. A ticket
// is either {status:'ok', id} or {status:'error', message, details:{error}}.
// DeviceNotRegistered is the one error Expo documents as permanent (the
// token will never work again, e.g. app uninstalled) -- every other error is
// treated as transient and simply left for the next run to retry.
export type ExpoPushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } };

export type TicketOutcome = 'ok' | 'device_not_registered' | 'transient_error';

export function classifyTicket(ticket: ExpoPushTicket): TicketOutcome {
  if (ticket.status === 'ok') return 'ok';
  if (ticket.details?.error === 'DeviceNotRegistered') return 'device_not_registered';
  return 'transient_error';
}

export type DeliveryOutcome = { tokenId: string; outcome: TicketOutcome };

// One notification can reach multiple devices (a user logged in on more than
// one phone). The notification's own push_status reflects the best outcome
// across all of that user's devices, since the user only needs to receive it
// once; individual DeviceNotRegistered tokens are still cleaned up
// per-device regardless of the notification's overall status.
export function decideNotificationPushStatus(
  deliveries: DeliveryOutcome[],
): 'sent' | 'failed' | 'skipped' {
  if (deliveries.length === 0) return 'skipped'; // user has no registered devices
  if (deliveries.some((d) => d.outcome === 'ok')) return 'sent';
  return 'failed';
}

export function tokenIdsToDeactivate(deliveries: DeliveryOutcome[]): string[] {
  return deliveries.filter((d) => d.outcome === 'device_not_registered').map((d) => d.tokenId);
}

// Expo's API accepts a batch (array) per request, capped at 100 messages;
// chunk conservatively below that so one oversized run can't be rejected outright.
export const EXPO_PUSH_BATCH_SIZE = 90;

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}
