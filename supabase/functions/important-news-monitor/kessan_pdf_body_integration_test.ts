// deno-lint-ignore-file require-await
// Phase 7: 決算短信 body composition inside the TDnet PDF path. Synthetic text (fictional company and figures).
import assert from "node:assert/strict";
import test from "node:test";
import { buildTdnetBodySummary, composeTdnetPdfBody, fetchTdnetPdfBodySummary } from "./official_source_fetchers.ts";
import { sourceTextConflicts, type GenerationCandidate } from "./post_generation_logic.ts";

const HEAD = ["2026年11月期 第３四半期決算短信〔日本基準〕(連結)", "2026年10月９日", "(百万円未満切捨て)"];
const RESULTS = (rows: string[], header = "売上高 営業利益 経常利益 親会社株主に帰属") => [
  "１．2026年11月期第３四半期の連結業績（2025年12月１日～2026年８月31日）",
  "（１）連結経営成績(累計) (％表示は、対前年同四半期増減率)",
  header,
  "する四半期純利益",
  "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％",
  ...rows,
];
const FORECAST = [
  "３．2026年11月期の連結業績予想（2025年12月１日～2026年11月30日）",
  "(％表示は、対前期増減率)",
  "売上高 営業利益 経常利益 親会社株主に帰属",
  "する当期純利益",
  "百万円 ％ 百万円 ％ 百万円 ％ 百万円 ％ 円 銭",
  "通期 17,730 △7.0 4,150 △21.6 2,920 △34.1 2,620 49.7 186.82",
];
const GOOD = [
  ...HEAD,
  ...RESULTS([
    "2026年11月期第３四半期 12,782 23.9 2,939 86.3 2,308 149.5 2,554 287.2",
    "2025年11月期第３四半期 10,314 30.4 1,577 37.3 925 25.8 659 31.4",
  ]),
  ...FORECAST,
].join("\n");

const candidate = (body: string): GenerationCandidate => ({
  id: "c1", sourceType: "tdnet", sourceUrl: "https://www.release.tdnet.info/inbs/x.pdf", sourceName: "tdnet", title: "2026年11月期 第3四半期決算短信〔日本基準〕(連結)",
  bodySummary: body, companyName: "テスト商事", companyCode: "1234", entityKey: "company:1234", category: "earnings",
  publishedAt: "2026-10-09T06:00:00Z", importance: "important", affectedEntities: [], japanMarketRelevance: "medium",
  judgementReason: null, judgementFactStatus: "passed", status: "ready_for_generation",
} as unknown as GenerationCandidate);

test("決算短信 with a readable table: current row first, prior row labelled, forecast kept, never the old keyword-only body", () => {
  const generic = buildTdnetBodySummary(GOOD) ?? "";
  const composed = composeTdnetPdfBody(GOOD, generic);
  assert.equal(composed.kind, "kessan_facts");
  assert.match(composed.body, /12,782/u);
  assert.match(composed.body, /10,314/u);
  assert.ok(composed.body.indexOf("12,782") < composed.body.indexOf("10,314"), "current period precedes prior period");
  assert.ok(composed.body.length <= 6000);
});

test("loss (△) values keep their sign through the integrated body", () => {
  const text = [
    ...HEAD,
    ...RESULTS([
      "2026年11月期第３四半期 8,100 △5.2 △320 － △410 － △560 －",
      "2025年11月期第３四半期 8,544 3.1 150 2.0 90 1.0 40 5.0",
    ]),
    ...FORECAST,
  ].join("\n");
  const composed = composeTdnetPdfBody(text, buildTdnetBodySummary(text) ?? "");
  assert.equal(composed.kind, "kessan_facts");
  assert.match(composed.body, /-320|△320|▲320/u);
  assert.equal(sourceTextConflicts(candidate(composed.body), "営業損益は320百万円の黒字でした。").length > 0, true);
});

test("unreadable table: the body says so and nothing is presented as the current-period figures", () => {
  const broken = [...HEAD, "１．連結業績", "売上高 営業利益", "12,782 23.9 2,939"].join("\n");
  const composed = composeTdnetPdfBody(broken, buildTdnetBodySummary(broken) ?? broken);
  assert.notEqual(composed.kind, "kessan_facts");
  if (composed.kind === "kessan_table_unreadable") assert.match(composed.body, /読み取れませんでした/u);
});

test("wrong column count / prior-year mismatch fail closed (no guessed numbers)", () => {
  const fiveCols = [
    ...HEAD,
    ...RESULTS([
      "2026年11月期第３四半期 12,782 23.9 2,939 86.3 2,308 149.5 2,554",
      "2025年11月期第３四半期 10,314 30.4 1,577 37.3 925 25.8 659 31.4",
    ]),
  ].join("\n");
  const composed = composeTdnetPdfBody(fiveCols, buildTdnetBodySummary(fiveCols) ?? fiveCols);
  assert.notEqual(composed.kind, "kessan_facts");
  const wrongYear = GOOD.replace("2025年11月期第３四半期 10,314", "2023年11月期第３四半期 10,314");
  const composed2 = composeTdnetPdfBody(wrongYear, buildTdnetBodySummary(wrongYear) ?? wrongYear);
  assert.notEqual(composed2.kind, "kessan_facts");
});

test("non-決算短信 disclosures keep the generic summary exactly", () => {
  const text = "通期業績予想の修正に関するお知らせ\n売上高 15,000 百万円\n営業利益 2,000 百万円";
  const generic = buildTdnetBodySummary(text) ?? "";
  assert.deepEqual(composeTdnetPdfBody(text, generic), { body: generic, kind: "generic", issues: [] });
});

test("facts-first body does not make a correct draft conflict, and a wrong number is caught", () => {
  const composed = composeTdnetPdfBody(GOOD, buildTdnetBodySummary(GOOD) ?? "");
  const c = candidate(composed.body);
  assert.deepEqual(sourceTextConflicts(c, "売上高は12,782百万円でした。"), []);
  assert.equal(sourceTextConflicts(c, "売上高は12,789百万円でした。").length > 0, true);
});

test("fetchTdnetPdfBodySummary returns the composed body through the injected extractor", async () => {
  const pdf = new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), { status: 200, headers: { "content-type": "application/pdf" } });
  const body = await fetchTdnetPdfBodySummary("https://www.release.tdnet.info/inbs/x.pdf", {
    fetcher: async () => pdf,
    extractor: async () => GOOD,
  });
  assert.match(body, /12,782/u);
  assert.match(body, /10,314/u);
});
