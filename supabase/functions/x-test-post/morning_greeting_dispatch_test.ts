import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// index.ts has no exports (it's the Deno.serve entrypoint), so the new scheduled-dispatch wiring for
// morning_greeting is verified structurally here, the same way P0.x quota/wiring changes are checked in
// important-news-monitor's own index.ts. The actual publish behavior (claim, image check, length-safe
// generation, X post, completion/failure) is already fully covered by
// morning_greeting_publish_logic_test.ts, which exercises runMorningGreetingManualPublish directly — this
// file only confirms the dispatcher calls that same, unmodified function correctly.

async function readIndexSource(): Promise<string> {
  return await readFile(new URL("./index.ts", import.meta.url), "utf8");
}

test("the morning_greeting dispatch branch calls the existing, unmodified runMorningGreetingManualPublish (no bespoke auto-post logic)", async () => {
  const source = await readIndexSource();
  const branchStart = source.indexOf('if (scheduledPost.post_type === "morning_greeting") {');
  assert.ok(branchStart >= 0, "morning_greeting dispatch branch not found");
  const branchEnd = source.indexOf('if (scheduledPost.post_type === "interaction") {', branchStart);
  assert.ok(branchEnd > branchStart);
  const branch = source.slice(branchStart, branchEnd);
  assert.match(branch, /await runMorningGreetingManualPublish\(\{/u);
  // Reuses the already-loaded X tokens (xAuth.tokens.accessToken) rather than loading a second time.
  assert.match(branch, /xAccessToken:\s*xAuth\.tokens\.accessToken/u);
  assert.match(branch, /complete_morning_greeting_post/u);
  assert.match(branch, /p_x_post_id:\s*result\.x_post_id/u);
});

test("the morning_greeting branch never bypasses the manual-publish function's own claim/skip/error handling with duplicate logic", async () => {
  const source = await readIndexSource();
  const branchStart = source.indexOf('if (scheduledPost.post_type === "morning_greeting") {');
  const branchEnd = source.indexOf('if (scheduledPost.post_type === "interaction") {', branchStart);
  const branch = source.slice(branchStart, branchEnd);
  // No re-implementation of image/length/claim logic here — it must all come from the imported function.
  assert.doesNotMatch(branch, /claimPublishSlot|completePublishSlot|failPublishSlot|MORNING_GREETING_IMAGE_NOT_FOUND/u);
  assert.doesNotMatch(branch, /resolveAdminAuthorization/u);
});

test("a scheduled_posts completion-RPC failure for morning_greeting is excluded from the generic fail_scheduled_post call, and the ambiguous missing-post-id case is too", async () => {
  const source = await readIndexSource();
  const anchor = source.indexOf('"x-test-post failed"');
  assert.ok(anchor >= 0, "outer dispatcher catch block not found");
  const catchBlock = source.slice(anchor, anchor + 2000);
  assert.match(catchBlock, /!code\.startsWith\("RPC_FAILED:complete_morning_greeting_post"\)/u);
  assert.match(catchBlock, /code !== "MORNING_GREETING_X_POST_ID_MISSING"/u);
});

test("posting_windows migration sets the 06:30-07:00 JST window and does not touch claim_due_post()", async () => {
  const migration = await readFile(
    new URL(
      "../../migrations/20260905010000_enable_morning_greeting_auto_dispatch.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /'morning_greeting', 1, '06:30:00', '07:00:00', 'Asia\/Tokyo', 1, true/u);
  // claim_due_post() may be *mentioned* in an explanatory comment, but must never be redefined here.
  assert.doesNotMatch(migration, /create or replace function public\.claim_due_post/u);
  assert.match(migration, /create or replace function public\.complete_morning_greeting_post/u);
});
