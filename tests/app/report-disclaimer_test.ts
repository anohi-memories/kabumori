// The agreed AI disclaimer is shown once at the end of every report detail (2026-10-07), on the market-detail and the
// legacy layout alike, with the same wording X carries. Screen structure is pinned by reading the source as text.
import assert from "node:assert/strict";
import test from "node:test";
import {
  REPORT_DISCLAIMER_JA,
  REPORT_SOURCE_NOTE_JA,
  reportFootnotes,
} from "../../src/lib/report-presentation.ts";
import { REPORT_DISCLAIMER_JA as BACKEND_DISCLAIMER_JA } from "../../supabase/functions/_shared/market_report_packet.ts";

const repoRoot = new URL("../../", import.meta.url);
const code = async (path: string) =>
  (await Deno.readTextFile(new URL(path, repoRoot))).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const SCREEN = "src/app/(tabs)/reports/[id].tsx";
const count = (text: string, part: string) => text.split(part).length - 1;

test("the app shows the agreed wording, the same text the backend appends to X and the story", () => {
  assert.equal(
    REPORT_DISCLAIMER_JA,
    "※本レポートはAIによる分析です。内容に誤り・不足を含む可能性があります。最終的な投資判断はご自身でお願いします。",
  );
  assert.equal(REPORT_DISCLAIMER_JA, BACKEND_DISCLAIMER_JA);
});

test("the closing notes end with the disclaimer exactly once, after the data gaps and the source note", () => {
  for (const gaps of [[], ["3銘柄の価格を取得できませんでした。"], ["一部の指数を取得できませんでした。", REPORT_DISCLAIMER_JA]]) {
    const notes = reportFootnotes(gaps);
    assert.equal(notes.at(-1), REPORT_DISCLAIMER_JA);
    assert.equal(notes.filter((note) => note === REPORT_DISCLAIMER_JA).length, 1, JSON.stringify(gaps));
    assert.equal(notes.at(-2), REPORT_SOURCE_NOTE_JA);
  }
  const joined = reportFootnotes(["一部の指数を取得できませんでした。"]).join("\n");
  // No contradicting or duplicate caution: no claim of independent research, no second investment caution.
  for (const wording of ["AIが独自", "独自調査", "売買をすすめる", "照合しています"]) assert.ok(!joined.includes(wording), wording);
});

test("the report detail renders the notes once, at the end, outside the market-detail / legacy branches", async () => {
  const screen = await code(SCREEN);
  assert.equal(count(screen, "reportFootnotes(gaps)"), 1);
  assert.ok(!screen.includes("※本レポートはAIによる分析です"), "the wording lives in one place (report-presentation.ts)");
  assert.ok(!screen.includes("売買をすすめるものではありません"), "the old note is replaced, not kept beside it");
  // The block is the screen's last child, at the top level of the ScrollView (both layouts reach it).
  const tail = screen.slice(screen.lastIndexOf("\n      <View style={styles.disclaimer}>"));
  assert.match(tail, /^\n      <View style=\{styles\.disclaimer\}>\n        \{reportFootnotes\(gaps\)\.map\([^\n]*\n      <\/View>\n    <\/ScrollView>/);
  // The backend story (which ends with its own copy of the disclaimer) is not rendered, so nothing doubles.
  assert.ok(!/\.story\b/.test(screen));
});

test("the root /report-detail route shows the same screen", async () => {
  const route = await code("src/app/report-detail.tsx");
  assert.ok(route.includes("(tabs)/reports/[id]"), route);
});
