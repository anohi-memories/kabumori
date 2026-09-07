import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// evaluateKabumoriVoice() has no exports of its own (it's a local function in index.ts, shared by
// morning_report/close_report/us_premarket_report/interaction/tip via its postType parameter), so its
// prompt wording is verified structurally here — the same convention used elsewhere in this repo for
// index.ts's un-exported logic.

async function readEvaluateKabumoriVoiceSource(): Promise<string> {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function evaluateKabumoriVoice(");
  assert.ok(start >= 0, "evaluateKabumoriVoice not found");
  const end = source.indexOf("\nfunction skippedVoiceEvaluation(", start);
  assert.ok(end > start);
  return source.slice(start, end);
}

// Production false positive (2026-09-07): a morning_report ending in "...続くのかが気になるところです。"
// (an ordinary market-commentary rhetorical closing) was rejected as a fabricated current personal
// feeling, even though nothing about it claims a specific real experience or holding.
test("ordinary market-commentary rhetoric ('気になるところです' etc.) is explicitly named as not a violation on its own", async () => {
  const source = await readEvaluateKabumoriVoiceSource();
  assert.match(source, /気になるところです/u);
  assert.match(source, /注目したいところです/u);
  assert.match(source, /見ておきたいところです/u);
  assert.match(source, /確認したいポイントです/u);
  assert.match(source, /論点を示すだけの相場解説上の修辞は違反ではなく/u);
});

test("a fabricated specific current/recent personal state or experience is still explicitly named as a violation", async () => {
  const source = await readEvaluateKabumoriVoiceSource();
  assert.match(source, /今朝からずっと気になっています/u);
  assert.match(source, /さっき見て驚きました/u);
  assert.match(source, /具体的な現在・直近の個人的状態や行動を実在した事実として語っている場合/u);
  assert.match(source, /架空の売買・保有・損失・利益経験を語っている場合/u);
});

test("this Voice evaluator is the single shared instance used by morning_report, close_report, and us_premarket_report (one fix point, not three)", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const callSites = source.match(/evaluateKabumoriVoice\(openAiApiKey, "(morning_report|close_report|us_premarket_report)"/gu) ?? [];
  const postTypes = new Set(callSites.map((call) => call.match(/"([a-z_]+)"/u)?.[1]));
  assert.ok(postTypes.has("morning_report"));
  assert.ok(postTypes.has("close_report"));
  assert.ok(postTypes.has("us_premarket_report"));
});
