import assert from "node:assert/strict";
import test from "node:test";
import {
  applyWithheld,
  checkRecordedPlaceholders,
  findOverlapping,
  isResidualWithheld,
  maskedDigest,
  RESIDUAL_WITHHELD,
  resolvePointer,
  stillOverlapping,
} from "./residual_redaction.ts";
import { POST_WITHHELD } from "./eval_redaction.ts";
import { buildTaskRequest, recordedFinalText } from "./tasks.ts";
import { loadCases } from "./fixtures.ts";

// Synthetic texts only. The reference is a made-up passage; "copies" repeat a run of it.

const REFERENCE = "合成の参照文として用意したこの一続きの文字列は、権利確認の対象となる第三者の文章の代わりである。";
const refs = [{ key: "body:synthetic", text: REFERENCE }];
const run = (n: number) => REFERENCE.slice(2, 2 + n);

const dataset = () => ({
  cases: [
    {
      caseId: "c-1",
      candidate: { title: run(30), sourceUrl: "https://example.test/a", bodySummary: run(40) },
      recorded: { judgement: { reason: `独自の理由。${run(40)}。以上。`, affectedEntities: ["合成株式会社"] }, generation: { text: `独自の投稿文。${run(25)}。` } },
      label: { keyFacts: [`独自の事実。${run(20)}`, "完全に独自の合成の事実の記述です、ここには参照との一致はありません"], rationale: "独自の合成の根拠" },
    },
    { caseId: "c-2", recorded: { judgement: { reason: "完全に独自の合成の判定理由であり、参照とは無関係である。" } }, label: { keyFacts: [], rationale: "独自" } },
  ],
});

test("only strings with a run of at least minRun characters are found; identifier and retained-source keys are not scanned", async () => {
  const found = await findOverlapping(dataset(), refs, 40);
  assert.deepEqual(found.map((e) => e.pointer), ["/cases/0/recorded/judgement/reason"]);
  assert.ok(found[0].longestRun >= 40);
  const at25 = await findOverlapping(dataset(), refs, 25);
  assert.deepEqual(at25.map((e) => e.pointer).sort(), ["/cases/0/recorded/generation/text", "/cases/0/recorded/judgement/reason"]);
  const at20 = await findOverlapping(dataset(), refs, 20);
  assert.deepEqual(at20.map((e) => e.pointer).sort(), [
    "/cases/0/label/keyFacts/0",
    "/cases/0/recorded/generation/text",
    "/cases/0/recorded/judgement/reason",
  ]);
  // the headline and the stored body hold a 30 / 40-character copy but are outside this module's scope
  assert.ok(!at20.some((e) => e.pointer.includes("candidate")));
});

test("a run one character short of the threshold is not found (boundary)", async () => {
  const data = { cases: [{ label: { rationale: `前${run(19)}後` } }, { label: { rationale: `前${run(20)}後` } }] };
  const found = await findOverlapping(data, refs, 20);
  assert.deepEqual(found.map((e) => e.pointer), ["/cases/1/label/rationale"]);
});

test("withholding changes exactly the found strings, records no text, and is idempotent", async () => {
  const data = dataset();
  const entries = await findOverlapping(data, refs, 20);
  const pointers = entries.map((e) => e.pointer);
  const before = await maskedDigest(data, pointers);
  applyWithheld(data, entries);
  assert.equal(await maskedDigest(data, pointers), before, "nothing else changed");
  for (const p of pointers) assert.ok(isResidualWithheld(resolvePointer(data, p) as string));
  const placeholders = pointers.map((p) => resolvePointer(data, p) as string);
  assert.equal(new Set(placeholders).size, placeholders.length, "placeholders differ");
  assert.deepEqual(checkRecordedPlaceholders(data, entries), []);
  assert.deepEqual(await stillOverlapping(data, refs, 20), []);
  assert.deepEqual(await findOverlapping(data, refs, 20), [], "idempotent");
  const record = JSON.stringify(entries);
  assert.ok(!record.includes(run(20)), "the record carries no text");
  assert.deepEqual(Object.keys(entries[0]).sort(), ["chars", "longestRun", "pointer", "sha256"]);
});

test("a tampered placeholder or record is detected", async () => {
  const data = dataset();
  const entries = await findOverlapping(data, refs, 40);
  applyWithheld(data, entries);
  const tampered = JSON.parse(JSON.stringify(data));
  tampered.cases[0].recorded.judgement.reason = "別の文字列";
  assert.match(checkRecordedPlaceholders(tampered, entries)[0], /not withheld/);
  const forged = [{ ...entries[0], sha256: "f".repeat(64) }];
  assert.match(checkRecordedPlaceholders(data, forged)[0], /does not match/);
});

test("pointers survive keys that contain / and ~", async () => {
  const data = { "a/b": { "c~d": `前${run(20)}後` } };
  const entries = await findOverlapping(data, refs, 20);
  assert.deepEqual(entries.map((e) => e.pointer), ["/a~1b/c~0d"]);
  applyWithheld(data, entries);
  assert.ok(isResidualWithheld(data["a/b"]["c~d"]));
});

test("a withheld post is never an input: the harness treats it as no post (fail closed)", async () => {
  const fixture = (await loadCases()).find((c) => c.recorded.generation?.text) as NonNullable<Awaited<ReturnType<typeof loadCases>>[number]>;
  assert.notEqual(recordedFinalText(fixture), null);
  for (const placeholder of [`${POST_WITHHELD}#00000000`, `${RESIDUAL_WITHHELD}#00000000`]) {
    const withheld = { ...fixture, recorded: { ...fixture.recorded, generation: { ...fixture.recorded.generation!, text: placeholder } } };
    assert.equal(recordedFinalText(withheld), null);
    assert.equal(await buildTaskRequest("generation_fact", withheld), null);
    assert.equal(await buildTaskRequest("generation_voice", withheld), null);
  }
});

test("candidate record at 20 characters: pointers, lengths and hashes only; entries are names and one post, never prose", async () => {
  const record = JSON.parse(
    await Deno.readTextFile(new URL("../../../docs/model-optimization/residual_redaction_candidate_min20_2026-10-14.json", import.meta.url)),
  ) as { files: Record<string, { minRun: number; withheld: Array<{ pointer: string; chars: number; sha256: string; longestRun: number }> }> };
  let total = 0;
  for (const file of Object.values(record.files)) {
    assert.equal(file.minRun, 20);
    for (const e of file.withheld) {
      total += 1;
      assert.match(e.sha256, /^[0-9a-f]{64}$/);
      assert.ok(e.longestRun >= 20 && e.longestRun <= e.chars);
      assert.ok(e.longestRun < 40, "no 40-character run exists in the committed data");
    }
  }
  assert.equal(total, 21);
});
