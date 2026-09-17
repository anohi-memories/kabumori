import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPostWithinLengthPolicy,
  postCharacterCount,
  postLengthInstruction,
  type PostLengthPolicy,
  UNLIMITED_POST_LENGTH,
} from "./post_length_policy.ts";

const limit280: PostLengthPolicy = { mode: "limited", maxChars: 280 };

test("finite mode accepts 279 and 280 Unicode code points and rejects 281", () => {
  assert.equal(assertPostWithinLengthPolicy(limit280, "あ".repeat(279)), 279);
  assert.equal(assertPostWithinLengthPolicy(limit280, "あ".repeat(280)), 280);
  assert.throws(
    () => assertPostWithinLengthPolicy(limit280, "あ".repeat(281)),
    { message: "POST_LENGTH_LIMIT_EXCEEDED" },
  );
});

test("Japanese characters and a surrogate-pair emoji use deterministic code-point counting", () => {
  assert.equal(postCharacterCount("株😀"), 2);
  assert.equal(
    assertPostWithinLengthPolicy(limit280, "あ".repeat(279) + "😀"),
    280,
  );
  assert.throws(
    () => assertPostWithinLengthPolicy(limit280, "あ".repeat(280) + "😀"),
    { message: "POST_LENGTH_LIMIT_EXCEEDED" },
  );
});

test("explicit unlimited mode has no magic numeric ceiling", () => {
  assert.equal(UNLIMITED_POST_LENGTH.maxChars, null);
  assert.equal(
    assertPostWithinLengthPolicy(UNLIMITED_POST_LENGTH, "長文。".repeat(1000)),
    3000,
  );
  assert.match(
    postLengthInstruction(UNLIMITED_POST_LENGTH),
    /上限は設定されていません/u,
  );
});
