import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// index.ts's Deno.serve dispatch blocks have no HTTP-level test harness in this codebase (see
// close_report_logic_test.ts's own "structural confirmation" tests for the established pattern) — so the
// morning_report Voice-rewrite-and-hashtag wiring (requirements 6-9 of the 2026-09-07 resilience task) is
// verified here by slicing out the exact block source and asserting on its structure.

async function readIndexSource(): Promise<string> {
  return await readFile(new URL("./index.ts", import.meta.url), "utf8");
}

async function readLiveMorningReportBlock(): Promise<string> {
  const source = await readIndexSource();
  const start = source.indexOf('if (scheduledPost.post_type === "morning_report")');
  const end = source.indexOf('if (scheduledPost.post_type === "close_report")', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

async function readDryRunMorningReportBlock(): Promise<string> {
  const source = await readIndexSource();
  const start = source.indexOf("if (isMorningReportDryRun) {");
  const end = source.indexOf("if (isCloseReportDryRun) {", start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test("live dispatch: the rewrite is attempted at most once, only when the first Voice check failed", async () => {
  const block = await readLiveMorningReportBlock();
  assert.match(
    block,
    /if \(draft\.text && !firstVoiceEvaluation\.passed\) \{\s*\n\s*voiceRewriteAttempted = true;\s*\n\s*const rewriteAttempt = await attemptMorningReportVoiceRewrite\(/u,
  );
  const rewriteCallCount = (block.match(/attemptMorningReportVoiceRewrite\(/gu) ?? []).length;
  assert.equal(rewriteCallCount, 1);
  const evaluateVoiceCallCount = (block.match(/evaluateKabumoriVoice\(/gu) ?? []).length;
  assert.equal(evaluateVoiceCallCount, 2); // exactly: the first check, and the at-most-one rewrite re-check
});

test("live dispatch: MORNING_REPORT_VOICE_CHECK_FAILED is thrown from the final (possibly rewritten) evaluation, not the first", async () => {
  const block = await readLiveMorningReportBlock();
  assert.match(block, /if \(!finalVoiceEvaluation\.passed\) throw new Error\("MORNING_REPORT_VOICE_CHECK_FAILED"\);/u);
  assert.doesNotMatch(block, /if \(!firstVoiceEvaluation\.passed\) throw/u);
});

test("live dispatch: fixed hashtags are appended exactly once, after the final Voice check, immediately before the one X post call", async () => {
  const block = await readLiveMorningReportBlock();
  const hashtagCallCount = (block.match(/appendKabumoriReportFixedHashtags\(/gu) ?? []).length;
  assert.equal(hashtagCallCount, 1);
  const postToXCallCount = (block.match(/postToX\(/gu) ?? []).length;
  assert.equal(postToXCallCount, 1);
  const voiceCheckIndex = block.indexOf('throw new Error("MORNING_REPORT_VOICE_CHECK_FAILED")');
  const hashtagIndex = block.indexOf("appendKabumoriReportFixedHashtags(");
  const postToXIndex = block.indexOf("postToX(xAuth, textWithHashtags)");
  assert.ok(voiceCheckIndex >= 0 && hashtagIndex > voiceCheckIndex);
  assert.ok(postToXIndex > hashtagIndex);
});

test("live dispatch: the outer shouldRetryMorningReport call and its arguments are untouched by this task", async () => {
  const block = await readLiveMorningReportBlock();
  assert.match(
    block,
    /const retryDecision = shouldRetryMorningReport\(\{\s*\n\s*error,\s*\n\s*postAttempted: xPostAttempted,\s*\n\s*attemptNumber: scheduledPost\.attempt_count,\s*\n\s*maxAttempts: MORNING_REPORT_MAX_ATTEMPTS,\s*\n\s*\}\);/u,
  );
});

test("live dispatch: diagnostics for the rewrite are persisted via the existing non-migration market_data JSON field", async () => {
  const block = await readLiveMorningReportBlock();
  assert.match(block, /first_voice_passed: firstVoiceEvaluation\.passed,/u);
  assert.match(block, /voice_rewrite_attempted: voiceRewriteAttempted,/u);
  assert.match(block, /second_voice_passed: secondVoicePassed,/u);
  assert.match(block, /final_voice_failure_stage: finalVoiceEvaluation\.passed \? null : \(voiceRewriteAttempted \? "after_rewrite" : "first"\),/u);
  assert.match(block, /market_data: morningRunMarketData\(draft, finalVoiceEvaluation, "completed", null, voiceRewriteDiagnostics\)/u);
});

test("dry run: never calls postToX, and previews the same rewrite-then-hashtag decision as the live path", async () => {
  const block = await readDryRunMorningReportBlock();
  assert.doesNotMatch(block, /postToX\(/u);
  assert.match(block, /attemptMorningReportVoiceRewrite\(/u);
  assert.match(block, /const finalTextWithHashtags = wouldPublish \? appendKabumoriReportFixedHashtags\(finalText\) : finalText;/u);
});
