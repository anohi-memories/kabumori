import assert from "node:assert/strict";
import test from "node:test";
import { scanJson, scanText, scanUrl } from "./secret_scan.ts";

// Fake credentials are assembled at run time so that this file never contains a key-shaped literal.
const ANT = ["sk", "ant", "FAKE".repeat(8)].join("-");
const PROJ = ["sk", "proj", "FAKE".repeat(8)].join("-");
const LEGACY = "sk-" + "FAKE0123".repeat(5);
const JWT = ["eyJ" + "A".repeat(20), "B".repeat(20), "C".repeat(20)].join(".");
const SLUG = "https://www.aljazeera.com/news/2026/10/8/more-killed-in-kramatorsk-as-russia-targets-ukraines-transportation-system";

test("a news URL slug that happens to contain 'sk-' is not a credential", () => {
  assert.deepEqual(scanUrl(SLUG), []);
  assert.deepEqual(scanJson({ sourceUrl: SLUG }), []);
});

test("provider-prefixed keys are found in free text", () => {
  for (const key of [ANT, PROJ, LEGACY]) {
    assert.ok(scanText(`この文書には ${key} が含まれる`).length > 0, key.slice(0, 12));
  }
  assert.ok(scanText(`Authorization: Bearer ${"x".repeat(32)}`).includes("bearer_token"));
  assert.ok(scanText(JWT).includes("jwt"));
  assert.ok(scanText("api_key = " + "a1b2c3d4".repeat(4)).includes("key_assignment"));
});

test("the same shapes are found inside a URL: path, query and userinfo", () => {
  assert.ok(scanUrl(`https://example.test/path/${ANT}`).includes("anthropic_key"));
  assert.ok(scanUrl(`https://example.test/a?token=${"z".repeat(24)}`).includes("secret_query_parameter"));
  assert.ok(scanUrl(`https://example.test/a?x=1&api_key=${"z".repeat(24)}`).includes("secret_query_parameter"));
  assert.ok(scanUrl("https://user:hunter2pass@example.test/").includes("url_userinfo"));
  assert.ok(scanUrl(`https://example.test/${JWT}`).includes("jwt"));
});

test("a harmless query string is not a finding", () => {
  assert.deepEqual(scanUrl("https://example.test/search?q=kirin&page=2&lang=ja"), []);
  assert.deepEqual(scanUrl("https://www.release.tdnet.info/inbs/140120261007547228.pdf"), []);
});

test("scanJson reports the path of a leak in nested data and does not skip any field", () => {
  const data = {
    cases: [
      { caseId: "a", candidate: { title: "ok", sourceUrl: SLUG }, label: { keyFacts: ["fine", `leaked ${ANT}`] } },
      { caseId: "b", candidate: { title: "ok", sourceUrl: `https://example.test/?token=${"q".repeat(20)}` } },
    ],
    [`key-${ANT}`]: 1,
  };
  const findings = scanJson(data);
  const paths = findings.map((f) => f.path);
  assert.ok(paths.includes("$.cases[0].label.keyFacts[1]"), paths.join(","));
  assert.ok(paths.includes("$.cases[1].candidate.sourceUrl"), paths.join(","));
  assert.ok(paths.some((p) => p.startsWith("$.<key:")), paths.join(","));
  assert.equal(findings.filter((f) => f.path.startsWith("$.cases[0].candidate")).length, 0);
});

test("ordinary Japanese and English disclosure text is clean", () => {
  const samples = [
    "自己株式の取得状況に関するお知らせ 取得株式数 214,100株、取得価額 335,225,800円",
    "Risk-based capital rules and task-force recommendations were published on the Federal Reserve site.",
    "営業利益 270→410百万円（+51.9%）、経常利益 +53.1%",
  ];
  for (const sample of samples) assert.deepEqual(scanText(sample), [], sample);
});
