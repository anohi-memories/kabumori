import assert from "node:assert/strict";
import test from "node:test";
import { evaluateImportantNewsOvernightHold } from "./overnight_hold_logic.ts";

const atJst = (iso: string) => new Date(iso);

test("00:59:59 JST important is not held", () => {
  assert.equal(evaluateImportantNewsOvernightHold("important", atJst("2026-09-01T15:59:59Z")).held, false);
});

test("01:00:00 JST important is held until 05:00 JST", () => {
  const result = evaluateImportantNewsOvernightHold("important", atJst("2026-09-01T16:00:00Z"));
  assert.equal(result.held, true);
  assert.equal(result.overnightHoldUntil, "2026-09-01T20:00:00.000Z");
});

test("04:59:59 JST important is still held", () => {
  assert.equal(evaluateImportantNewsOvernightHold("important", atJst("2026-09-01T19:59:59Z")).held, true);
});

test("03:00 JST important is held", () => {
  const result = evaluateImportantNewsOvernightHold("important", atJst("2026-09-01T18:00:00Z"));
  assert.equal(result.held, true);
  assert.equal(result.overnightHoldUntil, "2026-09-01T20:00:00.000Z");
});

test("02:00 JST important is held until same-day 05:00 JST", () => {
  const result = evaluateImportantNewsOvernightHold("important", atJst("2026-09-01T17:00:00Z"));
  assert.equal(result.held, true);
  assert.equal(result.overnightHoldUntil, "2026-09-01T20:00:00.000Z");
});

test("05:00:00 JST important is released", () => {
  assert.equal(evaluateImportantNewsOvernightHold("important", atJst("2026-09-01T20:00:00Z")).held, false);
});

test("08:00 JST important is not held", () => {
  assert.equal(evaluateImportantNewsOvernightHold("important", atJst("2026-09-01T23:00:00Z")).held, false);
});

test("02:00 JST most_important bypasses overnight hold", () => {
  const result = evaluateImportantNewsOvernightHold("most_important", atJst("2026-09-01T17:00:00Z"));
  assert.equal(result.held, false);
  assert.equal(result.bypassed, true);
});
