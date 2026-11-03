// G4-08. Offline, no permissions except reading this folder for the isolation check.
//   deno test --no-config --cached-only --allow-read=. supabase/functions/_shared/social/g5_owner_epoch_token_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { g5Decimal, parseG5OwnerEpochToken } from "./g5_owner_epoch_token.ts";

test("the token: both numbers as decimal text", () => {
  assert.deepEqual(parseG5OwnerEpochToken("g5oe:7:3"), { ownerEpoch: "7", lifecycleVersion: "3" });
  assert.deepEqual(parseG5OwnerEpochToken("g5oe:9223372036854775807:9223372036854775807"), {
    ownerEpoch: "9223372036854775807",
    lifecycleVersion: "9223372036854775807",
  });
  assert.equal(parseG5OwnerEpochToken("g5oe:9007199254740993:1")?.ownerEpoch, "9007199254740993");
  assert.equal(Object.isFrozen(parseG5OwnerEpochToken("g5oe:7:3")), true);
});

test("the token: anything else is null (zero, sign, leading zero, overflow, shape, a JS number)", () => {
  for (const bad of [
    7, 7n, null, undefined, "", "7", "7:3", "g5oe:7", "g5oe:7:3:1", "g5oe::3", "g5oe:7:", "g5oe:0:3", "g5oe:7:0", "g5oe:-7:3", "g5oe:+7:3",
    "g5oe:07:3", "g5oe:7:03", "g5oe:7.0:3", "G5OE:7:3", " g5oe:7:3", "g5oe:7:3 ", "g5oe:9223372036854775808:1", "g5oe:1:9223372036854775808",
    "g5oe:99999999999999999999:1", "g5oe:１:3",
  ]) {
    assert.equal(parseG5OwnerEpochToken(bad), null, String(bad));
  }
});

test("a stored number: decimal text in 1..bigint max only", () => {
  assert.equal(g5Decimal("1"), "1");
  assert.equal(g5Decimal("9223372036854775807"), "9223372036854775807");
  for (const bad of [1, "0", "01", "-1", "1.0", "9223372036854775808", "", " 1", null]) assert.equal(g5Decimal(bad), null, String(bad));
});

test("isolation: imports nothing", async () => {
  const source = await Deno.readTextFile(new URL("./g5_owner_epoch_token.ts", import.meta.url));
  assert.equal(/^\s*import\b/mu.test(source), false);
});
