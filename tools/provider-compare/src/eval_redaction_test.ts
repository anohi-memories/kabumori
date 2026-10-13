import assert from "node:assert/strict";
import test from "node:test";
import { bodyMayBeStored } from "./body_policy.ts";
import {
  contentDigest,
  hostClassOf,
  isWithheldPost,
  normaliseTitle,
  POST_WITHHELD,
  redactEvalExpansion,
  redactNopostSample,
  titleKeyOf,
  verifyAgainstRows,
} from "./eval_redaction.ts";
import { isWithheldTitle, sha256Hex } from "./fixture_access.ts";
import { caseHazards, hazardCoverage } from "../scripts/eval_set_report.ts";

// Source-derived text (headlines of unconfirmed sources, generated posts) is withheld in the evaluation datasets. These
// tests check the committed files against the committed record, and the redaction code on synthetic data, including the
// negative cases: unknown sources, very short text, a forged fingerprint, a leak of the original text.

const dir = new URL("../fixtures/", import.meta.url);
const readJson = async (url: URL) => JSON.parse(await Deno.readTextFile(url));
const expansion = await readJson(new URL("eval_expansion.json", dir));
const nopost = await readJson(new URL("eval_nopost_sample.json", dir));
const record = await readJson(new URL("../../../docs/model-optimization/eval_redaction_2026-10-13.json", import.meta.url));

const HEX = /^[0-9a-f]{64}$/;

test("committed datasets: every headline of a source without confirmed terms is withheld, with a fingerprint", () => {
  let withheld = 0;
  let kept = 0;
  for (const item of expansion.cases) {
    const c = item.candidate;
    if (bodyMayBeStored(c.sourceUrl)) {
      kept += 1;
      assert.ok(!isWithheldTitle(c.title) && c.titleSha256 === undefined, item.caseId);
    } else {
      withheld += 1;
      assert.ok(isWithheldTitle(c.title), `${item.caseId}: headline not withheld`);
      assert.match(c.titleSha256, HEX, item.caseId);
      assert.match(c.titleKeySha256, HEX, item.caseId);
      assert.ok(c.titleChars > 0, item.caseId);
    }
  }
  for (const item of nopost.cases) {
    if (bodyMayBeStored(item.sourceUrl)) {
      kept += 1;
      assert.ok(!isWithheldTitle(item.title), item.caseId);
    } else {
      withheld += 1;
      assert.ok(isWithheldTitle(item.title) && HEX.test(item.titleSha256) && item.titleChars > 0, item.caseId);
    }
  }
  assert.equal(withheld, record.files["eval_expansion.json"].titlesWithheld + record.files["eval_nopost_sample.json"].titlesWithheld);
  assert.equal(kept, record.files["eval_expansion.json"].titlesKept + record.files["eval_nopost_sample.json"].titlesKept);
  assert.ok(withheld >= 250, `withheld ${withheld}`);
});

test("committed dataset: every stored generated post is withheld, with length and SHA-256", () => {
  let posts = 0;
  for (const item of expansion.cases) {
    const g = item.recorded.generation;
    if (!g || g.text === null) continue;
    posts += 1;
    assert.ok(isWithheldPost(g.text), `${item.caseId}: post not withheld`);
    assert.match(g.textSha256, HEX, item.caseId);
    assert.ok(g.textChars > 0, item.caseId);
  }
  assert.equal(posts, record.files["eval_expansion.json"].postsWithheld);
  assert.equal(posts, 76);
  assert.ok(!JSON.stringify(nopost).includes('"generation"'), "the no_post sample carries no posts");
});

test("comparability: everything except the withheld keys is exactly what it was before redaction", async () => {
  assert.equal(await contentDigest(expansion), record.files["eval_expansion.json"].contentSha256);
  assert.equal(await contentDigest(nopost), record.files["eval_nopost_sample.json"].contentSha256);
  assert.equal(expansion.cases.length, record.files["eval_expansion.json"].cases);
  assert.equal(nopost.cases.length, record.files["eval_nopost_sample.json"].cases);
});

test("comparability: hazard coverage is the same as when it was computed from the text", () => {
  assert.deepEqual(hazardCoverage(expansion.cases), record.files["eval_expansion.json"].hazardCoverage);
  // a withheld case carries its tags; a case with nothing withheld is computed from its own text
  const withheldCase = expansion.cases.find((c: { derived?: unknown }) => c.derived !== undefined);
  assert.ok(withheldCase && Array.isArray(withheldCase.derived.hazards));
  assert.deepEqual(caseHazards(withheldCase), withheldCase.derived.hazards);
});

test("comparability: duplicate headlines are still detectable through the key hash", () => {
  const keys = new Map<string, number>();
  for (const item of expansion.cases) {
    const k = titleKeyOf(item.candidate);
    keys.set(k, (keys.get(k) ?? 0) + 1);
  }
  // withheld titles are keyed by hash, open-terms titles by the normalised text; nothing collapses to the placeholder
  assert.ok(![...keys.keys()].some((k) => k.startsWith("（見出し非保持")));
  assert.ok(keys.size > 150);
});

test("record of the redaction: counts by source class add up", () => {
  for (const name of ["eval_expansion.json", "eval_nopost_sample.json"] as const) {
    const f = record.files[name];
    const byClass = Object.values(f.withheldTitlesByHostClass as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.equal(byClass, f.titlesWithheld, name);
    assert.ok(!("open_terms" in f.withheldTitlesByHostClass), "an open-terms headline is never withheld");
  }
});

// --- the redaction code, on synthetic data --------------------------------------------------------------------------
const synth = (id: string, url: string, title: string, post: string | null) => ({
  caseId: `x-${id}`,
  candidateId: `${id}-0000-4000-8000-000000000000`,
  candidate: { title, sourceUrl: url },
  recorded: { generation: post === null ? null : { text: post as string | null } },
});

test("redaction: unconfirmed and unknown sources are withheld, open-terms headlines are kept, posts are always withheld", async () => {
  const file = {
    cases: [
      synth("aaaaaaaa", "https://www.release.tdnet.info/inbs/a.pdf", "合成の見出し A（試験用）", "合成の投稿文 A"),
      synth("bbbbbbbb", "https://unknown-publisher.example/x", "合成の見出し B（試験用）", null),
      synth("cccccccc", "https://www.fsa.go.jp/news/c.html", "合成の見出し C（試験用）", "合成の投稿文 C"),
      synth("dddddddd", "not a url", "短", "短"),
    ],
  };
  const stats = await redactEvalExpansion(file);
  assert.deepEqual(stats, { cases: 4, titlesWithheld: 3, titlesKept: 1, postsWithheld: 3, alreadyRedacted: 0 });
  const [a, b, c, d] = file.cases;
  assert.ok(isWithheldTitle(a.candidate.title) && a.candidate.title.endsWith("#aaaaaaaa"));
  assert.ok(isWithheldTitle(b.candidate.title), "an unknown publisher is not trusted");
  assert.equal(c.candidate.title, "合成の見出し C（試験用）");
  assert.ok(isWithheldTitle(d.candidate.title), "an unparsable URL is not trusted; a one-character title is withheld too");
  for (const item of file.cases) {
    const g = item.recorded.generation;
    if (g) assert.ok(isWithheldPost(g.text as string) && (g.text as string).startsWith(POST_WITHHELD));
  }
  assert.equal((a.candidate as { titleSha256?: string }).titleSha256, await sha256Hex("合成の見出し A（試験用）"));
  assert.equal((a.candidate as { titleKeySha256?: string }).titleKeySha256, await sha256Hex(normaliseTitle("合成の見出し A（試験用）")));
  assert.equal((a.recorded.generation as { textSha256?: string }).textSha256, await sha256Hex("合成の投稿文 A"));
});

test("redaction is idempotent and leaves no original text behind", async () => {
  const file = {
    cases: [synth("eeeeeeee", "https://www.release.tdnet.info/inbs/e.pdf", "合成の見出し E（試験用・長め）", "合成の投稿文 E（試験用・長め）")],
  };
  await redactEvalExpansion(file);
  const once = JSON.stringify(file);
  const again = await redactEvalExpansion(file);
  assert.equal(JSON.stringify(file), once);
  assert.equal(again.alreadyRedacted, 1);
  assert.equal(again.titlesWithheld + again.postsWithheld, 0);
  assert.ok(!once.includes("合成の見出し E") && !once.includes("合成の投稿文 E"), "the original text is not in the output");
});

test("redaction: derived features are computed before the text is withheld", async () => {
  const file = { cases: [synth("ffffffff", "https://www.release.tdnet.info/inbs/f.pdf", "合成の見出し F（試験用）", "合成の投稿文 F")] };
  await redactEvalExpansion(file, (item) => ({ seenTitleChars: item.candidate.title.length, seenPost: item.recorded.generation?.text }));
  const withDerived = file.cases[0] as unknown as { derived: { seenTitleChars: number; seenPost: string } };
  assert.equal(withDerived.derived.seenTitleChars, "合成の見出し F（試験用）".length);
  assert.equal(withDerived.derived.seenPost, "合成の投稿文 F", "features see the original; only the stored fields are withheld");
});

test("the no_post sample: headlines are withheld, an open-terms headline is kept", async () => {
  const file = {
    cases: [
      { caseId: "n-1", candidateId: "11111111-0000-4000-8000-000000000000", title: "合成の見出し N1（試験用）", sourceUrl: "https://www.bbc.co.uk/news/x" },
      { caseId: "n-2", candidateId: "22222222-0000-4000-8000-000000000000", title: "合成の見出し N2（試験用）", sourceUrl: "https://www.boj.or.jp/x.html" },
    ],
  };
  const stats = await redactNopostSample(file);
  assert.deepEqual(stats, { cases: 2, titlesWithheld: 1, titlesKept: 1, postsWithheld: 0, alreadyRedacted: 0 });
  assert.ok(isWithheldTitle(file.cases[0].title));
  assert.equal(file.cases[1].title, "合成の見出し N2（試験用）");
});

test("verification against a local export: a match is a match; a forged hash, a changed text and a missing row are not", async () => {
  const file = {
    cases: [
      synth("11111111", "https://www.release.tdnet.info/inbs/1.pdf", "合成の見出し V1（試験用）", "合成の投稿文 V1"),
      synth("22222222", "https://www.release.tdnet.info/inbs/2.pdf", "合成の見出し V2（試験用）", "合成の投稿文 V2"),
      synth("33333333", "https://www.release.tdnet.info/inbs/3.pdf", "合成の見出し V3（試験用）", "合成の投稿文 V3"),
      synth("44444444", "https://www.release.tdnet.info/inbs/4.pdf", "合成の見出し V4（試験用）", "合成の投稿文 V4"),
    ],
  };
  await redactEvalExpansion(file);
  (file.cases[3].candidate as { titleSha256?: string }).titleSha256 = "0".repeat(64); // forged fingerprint
  const rows = [
    { id: "11111111-0000-4000-8000-000000000000", title: "合成の見出し V1（試験用）", generated_text: "合成の投稿文 V1" },
    { id: "22222222-0000-4000-8000-000000000000", title: "合成の見出し V2（更新）", generated_text: "合成の投稿文 V2（更新）" },
    { id: "44444444-0000-4000-8000-000000000000", title: "合成の見出し V4（試験用）", generated_text: "合成の投稿文 V4" },
  ];
  const result = await verifyAgainstRows(file as never, rows);
  assert.deepEqual(result.titles, { checked: 4, matched: 1, mismatched: ["22222222", "44444444"], missing: ["33333333"] });
  assert.deepEqual(result.posts, { checked: 4, matched: 2, mismatched: ["22222222"], missing: ["33333333"] });
});

test("host classes follow the body policy (unknown hosts are never open_terms)", () => {
  assert.equal(hostClassOf("https://www.fsa.go.jp/x"), "open_terms");
  assert.equal(hostClassOf("https://www.release.tdnet.info/x"), "tdnet");
  assert.equal(hostClassOf("https://apnews.com/x"), "ap");
  assert.equal(hostClassOf("https://example.test/x"), "other");
  assert.equal(hostClassOf("::::"), "other");
});
