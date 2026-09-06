import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpoPushMessage,
  chunk,
  classifyTicket,
  decideNotificationPushStatus,
  tokenIdsToDeactivate,
  type DeliveryOutcome,
  type PendingNotification,
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
  const message = buildExpoPushMessage(sampleNotification, "ExponentPushToken[abc]");
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
  const result = classifyTicket({ status: "error", message: "rate limited", details: { error: "MessageRateExceeded" } });
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
