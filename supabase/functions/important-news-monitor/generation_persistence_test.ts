import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// index.ts has no exports (matching the rest of this codebase's Edge Function entrypoints), so its
// saveCandidateGeneration()/saveGenerationError() wiring is verified structurally here, the same way
// other index.ts branches are checked elsewhere in this repo. The actual diagnostic VALUES (what
// generated.fact.issues / generated.voice.issues contain for a passed/failed check) are covered by
// post_generation_logic_test.ts, which exercises the real generateImportantNewsPost() logic.

async function saveCandidateGenerationSource(): Promise<string> {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function saveCandidateGeneration(");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0, "saveCandidateGeneration not found");
  return source.slice(start, end);
}

test("6+9: saveCandidateGeneration persists the AI Fact/Voice check's own issues, not a new judgement", async () => {
  const fn = await saveCandidateGenerationSource();
  assert.match(fn, /generation_fact_issues:\s*generated\.fact\.issues/u);
  assert.match(fn, /generation_voice_issues:\s*generated\.voice\.issues/u);
  // Only the existing status/error fields accompany them — no new derived field is introduced.
  assert.match(fn, /generation_fact_status:\s*generated\.fact\.status/u);
  assert.match(fn, /generation_voice_status:\s*generated\.voice\.status/u);
});

test("10: saveCandidateGeneration's persisted body never includes prompt text, instructions, or secrets", async () => {
  const fn = await saveCandidateGenerationSource();
  const bodyStart = fn.indexOf("body: JSON.stringify({");
  const bodyEnd = fn.indexOf("}),", bodyStart);
  assert.ok(bodyStart >= 0 && bodyEnd > bodyStart, "PATCH body not found");
  const persistedBody = fn.slice(bodyStart, bodyEnd);
  assert.doesNotMatch(persistedBody, /instructions|system_prompt|Authorization|apiKey|serviceRoleKey|openAiApiKey/iu);
});

test("saveGenerationError (the eligibility/parse-failure path) is unchanged by this diagnostics addition", async () => {
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function saveGenerationError(");
  const end = source.indexOf("\n}\n", start);
  const fn = source.slice(start, end);
  assert.doesNotMatch(fn, /generation_fact_issues|generation_voice_issues/u);
});
