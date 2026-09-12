import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpoPushMessage,
  chunk,
  classifyTicket,
  decideNotificationPushDispatch,
  decideNotificationPushStatus,
  decidePreSendRetry,
  type DeliveryOutcome,
  expoRequestRetryDelayMs,
  MAX_EXPO_REQUEST_ATTEMPTS,
  MAX_PUSH_ATTEMPTS,
  type PendingNotification,
  shouldRetryExpoRequest,
  tokenIdsToDeactivate,
} from "./push_send_logic.ts";

const sampleNotification: PendingNotification = {
  id: "notif-1",
  title: "重要ニュース",
  summary: "トヨタ自動車が上方修正を発表しました。",
  importance: "important",
  source_type: "important_news",
  source_id: "candidate-1",
};

test("buildExpoPushMessage: carries the ids needed for in-app tap navigation in data", () => {
  const message = buildExpoPushMessage(
    sampleNotification,
    "ExponentPushToken[abc]",
  );
  assert.equal(message.to, "ExponentPushToken[abc]");
  assert.equal(message.title, "重要ニュース");
  assert.equal(message.body, "トヨタ自動車が上方修正を発表しました。");
  assert.deepEqual(message.data, {
    notification_id: "notif-1",
    source_type: "important_news",
    source_id: "candidate-1",
  });
});

test("classifyTicket: an ok ticket is ok", () => {
  assert.equal(classifyTicket({ status: "ok", id: "receipt-1" }), "ok");
});

test("classifyTicket: DeviceNotRegistered is treated as permanent, not retried", () => {
  const result = classifyTicket({
    status: "error",
    message: "not registered",
    details: { error: "DeviceNotRegistered" },
  });
  assert.equal(result, "device_not_registered");
});

test("classifyTicket: any other error is treated as transient (left for next run)", () => {
  const result = classifyTicket({
    status: "error",
    message: "rate limited",
    details: { error: "MessageRateExceeded" },
  });
  assert.equal(result, "transient_error");
});

test("classifyTicket: an error with no details is treated as transient, not crashing", () => {
  const result = classifyTicket({ status: "error", message: "unknown" });
  assert.equal(result, "transient_error");
});

test("decideNotificationPushStatus: skipped when the user has no registered devices", () => {
  assert.equal(decideNotificationPushStatus([]), "skipped");
});

test("decideNotificationPushStatus: sent if at least one of several devices succeeded", () => {
  const deliveries: DeliveryOutcome[] = [
    { tokenId: "t1", outcome: "device_not_registered" },
    { tokenId: "t2", outcome: "ok" },
  ];
  assert.equal(decideNotificationPushStatus(deliveries), "sent");
});

test("decideNotificationPushStatus: failed when every device failed", () => {
  const deliveries: DeliveryOutcome[] = [
    { tokenId: "t1", outcome: "transient_error" },
    { tokenId: "t2", outcome: "device_not_registered" },
  ];
  assert.equal(decideNotificationPushStatus(deliveries), "failed");
});

test("dispatch decision: explicit transient ticket retries the same row with bounded backoff", () => {
  const deliveries: DeliveryOutcome[] = [{
    tokenId: "t1",
    outcome: "transient_error",
  }];
  assert.deepEqual(decideNotificationPushDispatch(deliveries, 1), {
    status: "pending",
    errorCode: "EXPO_TICKET_TRANSIENT_ERROR",
    retryAfterSeconds: 120,
  });
  assert.deepEqual(decideNotificationPushDispatch(deliveries, 2), {
    status: "pending",
    errorCode: "EXPO_TICKET_TRANSIENT_ERROR",
    retryAfterSeconds: 600,
  });
  assert.deepEqual(
    decideNotificationPushDispatch(deliveries, MAX_PUSH_ATTEMPTS),
    {
      status: "failed",
      errorCode: "PUSH_ATTEMPT_LIMIT_REACHED",
      retryAfterSeconds: null,
    },
  );
});

test("dispatch decision: successful device makes notification terminally sent", () => {
  const deliveries: DeliveryOutcome[] = [
    { tokenId: "t1", outcome: "ok" },
    { tokenId: "t2", outcome: "transient_error" },
  ];
  assert.deepEqual(decideNotificationPushDispatch(deliveries, 1), {
    status: "sent",
    errorCode: null,
    retryAfterSeconds: null,
  });
});

test("dispatch decision: missing ticket is uncertain and is never auto-retried", () => {
  assert.deepEqual(
    decideNotificationPushDispatch([{ tokenId: "t1", outcome: "unknown" }], 1),
    {
      status: "failed",
      errorCode: "PUSH_DELIVERY_OUTCOME_UNKNOWN",
      retryAfterSeconds: null,
    },
  );
});

test("dispatch decision: all permanently invalid tokens fail without retry", () => {
  assert.deepEqual(
    decideNotificationPushDispatch([{
      tokenId: "t1",
      outcome: "device_not_registered",
    }], 1),
    {
      status: "failed",
      errorCode: "EXPO_DEVICE_NOT_REGISTERED",
      retryAfterSeconds: null,
    },
  );
});

test("pre-send lookup failure retries the same row only up to the attempt limit", () => {
  assert.deepEqual(decidePreSendRetry(1), {
    status: "pending",
    errorCode: "PUSH_PRE_SEND_FAILURE",
    retryAfterSeconds: 120,
  });
  assert.deepEqual(decidePreSendRetry(2), {
    status: "pending",
    errorCode: "PUSH_PRE_SEND_FAILURE",
    retryAfterSeconds: 600,
  });
  assert.deepEqual(decidePreSendRetry(3), {
    status: "failed",
    errorCode: "PUSH_ATTEMPT_LIMIT_REACHED",
    retryAfterSeconds: null,
  });
});

test("Expo explicit 429 and 5xx responses retry with bounded backoff", () => {
  assert.equal(MAX_EXPO_REQUEST_ATTEMPTS, 3);
  for (const status of [429, 500, 503, 599]) {
    assert.equal(shouldRetryExpoRequest(status, 1), true);
    assert.equal(shouldRetryExpoRequest(status, 2), true);
    assert.equal(shouldRetryExpoRequest(status, 3), false);
  }
  assert.equal(expoRequestRetryDelayMs(1), 2000);
  assert.equal(expoRequestRetryDelayMs(2), 4000);
});

test("Expo client/other 4xx responses do not retry", () => {
  for (const status of [400, 401, 404, 408, 422]) {
    assert.equal(shouldRetryExpoRequest(status, 1), false);
  }
});

test("tokenIdsToDeactivate: only collects device_not_registered tokens, not transient failures", () => {
  const deliveries: DeliveryOutcome[] = [
    { tokenId: "t1", outcome: "device_not_registered" },
    { tokenId: "t2", outcome: "transient_error" },
    { tokenId: "t3", outcome: "ok" },
  ];
  assert.deepEqual(tokenIdsToDeactivate(deliveries), ["t1"]);
});

test("chunk: splits into groups of the given size, including a smaller final group", () => {
  const result = chunk([1, 2, 3, 4, 5], 2);
  assert.deepEqual(result, [[1, 2], [3, 4], [5]]);
});

test("chunk: an empty array yields no chunks", () => {
  assert.deepEqual(chunk([], 10), []);
});
