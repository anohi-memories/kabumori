import assert from "node:assert/strict";
import test from "node:test";
import {
  isCandidateAfterAutoPublishCutover,
} from "./auto_publish_cutover_logic.ts";

const cutover = "2026-09-08T07:47:56.873966Z";

test("cutover excludes a candidate generated before auto_publish was enabled", () => {
  assert.equal(isCandidateAfterAutoPublishCutover("2026-09-04T09:54:09.987Z", cutover), false);
});

test("cutover admits a candidate generated after auto_publish was enabled", () => {
  assert.equal(isCandidateAfterAutoPublishCutover("2026-09-08T07:48:00.000Z", cutover), true);
});

test("a candidate generated exactly at cutover is admitted", () => {
  assert.equal(isCandidateAfterAutoPublishCutover(cutover, cutover), true);
});

test("missing or invalid timestamps fail closed", () => {
  assert.equal(isCandidateAfterAutoPublishCutover(null, cutover), false);
  assert.equal(isCandidateAfterAutoPublishCutover("not-a-date", cutover), false);
  assert.equal(isCandidateAfterAutoPublishCutover("2026-09-08T07:48:00Z", null), false);
});
