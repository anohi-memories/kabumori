import assert from "node:assert/strict";
import test from "node:test";

import {
  TOPIC_DETAIL_CATALOG,
  TOPIC_DETAIL_HEADINGS,
  TOPIC_DETAIL_PRACTICAL_MARKET_HEADING,
  TOPIC_DETAIL_ROLES,
  topicDetailFor,
} from "../../src/lib/topic-detail-catalog.ts";

// Every title currently seeded in supabase/migrations/20260828213000_expand_tips_catalog.sql,
// copied verbatim so this test fails loudly if either file drifts from the other.
const SEEDED_TITLES = [
  'PERって何？', 'PBRって何？', '配当利回りって何？', '成行と指値の違いは？', 'ETFって何？',
  'NISAって何？', 'ストップ高って何？', 'ストップ安って何？', 'EPSって何？', '時価総額って何？',
  '配当性向って何？', '権利落ち日って何？', '株式分割って何？', 'IPOって何？', '日経平均とTOPIXの違いは？',
  '含み益と実現益の違いは？', '単元株って何？', '優待利回りってどう計算する？', '損切りって何のためにする？', '分散投資はなぜ必要？',
  'ROEって何を見る指標？', 'EPS成長率はなぜ重要？', '信用倍率ってどう見る？', '出来高が増えると何が分かる？', '移動平均線って何？',
  '自己資本比率って何？', '営業利益率はなぜ大事？', 'ギャップアップって何？', 'RSIはどう見る？', 'MACDは何を表す？',
  'フリーキャッシュフローって何？', '決算の進捗率はどう見る？', '営業利益と経常利益の違いは？', '空売りってどんな取引？', 'ボラティリティって何？',
  'ベータ値って何を見る？', '売上総利益率は何が分かる？', '有利子負債はどこまで気にする？', 'VWAPって何？', 'セクターローテーションって何？',
  '好決算なのに株価が下がるのはなぜ？', '上方修正はどこを見ればいい？', '自社株買いはなぜ好材料になりやすい？', '信用買い残が多いと上値が重くなることがあるのはなぜ？', '配当利回りだけで銘柄を選ぶと危ない理由',
  '決算短信で最初に見るポイント', '半導体株がSOX指数に影響されやすい理由', '円安が輸出株に追い風と言われる理由', '金利上昇でグロース株が弱くなりやすい理由', '急騰株で出来高を見る理由',
];
// The last ten seeded titles are the 実践 (advanced) topics.
const ADVANCED_TITLES = SEEDED_TITLES.slice(40);

const bodyLength = (title: string) => TOPIC_DETAIL_CATALOG[title].sections.reduce((sum, section) => sum + section.body.length, 0);

test("every one of the 50 currently-seeded tip titles has a curated detail entry", () => {
  assert.equal(SEEDED_TITLES.length, 50);
  assert.equal(new Set(SEEDED_TITLES).size, 50);
  const missing = SEEDED_TITLES.filter((title) => !(title in TOPIC_DETAIL_CATALOG));
  assert.deepEqual(missing, [], `missing curated detail for: ${missing.join(", ")}`);
});

test("the catalog contains no unexpected extra titles beyond the current seed", () => {
  const seeded = new Set(SEEDED_TITLES);
  const extra = Object.keys(TOPIC_DETAIL_CATALOG).filter((title) => !seeded.has(title));
  assert.deepEqual(extra, []);
});

test("the seeded titles above match the seed migration, and 実践 is exactly the last ten", async () => {
  const sql = await Deno.readTextFile(new URL("../../supabase/migrations/20260828213000_expand_tips_catalog.sql", import.meta.url));
  const rows = [...sql.matchAll(/^\('([^']+)', '(初級|中級|実践)', '[^']+', '/gm)].map((m) => ({ title: m[1], difficulty: m[2] }));
  assert.deepEqual(rows.map((r) => r.title), SEEDED_TITLES);
  assert.deepEqual(rows.filter((r) => r.difficulty === "実践").map((r) => r.title), ADVANCED_TITLES);
  assert.equal(rows.filter((r) => r.difficulty === "初級").length, 20);
  assert.equal(rows.filter((r) => r.difficulty === "中級").length, 20);
});

test("every entry has exactly the five learning roles, in order, with the right headings", () => {
  assert.deepEqual([...TOPIC_DETAIL_ROLES], ["basics", "why", "example", "market", "takeaway"]);
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    assert.deepEqual(entry.sections.map((s) => s.role), [...TOPIC_DETAIL_ROLES], `${title}: roles/order`);
    const marketHeading = ADVANCED_TITLES.includes(title) ? TOPIC_DETAIL_PRACTICAL_MARKET_HEADING : TOPIC_DETAIL_HEADINGS.market;
    const expected = [
      TOPIC_DETAIL_HEADINGS.basics,
      TOPIC_DETAIL_HEADINGS.why,
      TOPIC_DETAIL_HEADINGS.example,
      marketHeading,
      TOPIC_DETAIL_HEADINGS.takeaway,
    ];
    assert.deepEqual(entry.sections.map((s) => s.heading), expected, `${title}: headings`);
  }
});

test("the user-facing headings are the agreed natural Japanese", () => {
  assert.deepEqual(TOPIC_DETAIL_HEADINGS, {
    basics: "まずこれだけ",
    why: "なぜ大事？",
    example: "具体例",
    market: "株価・相場とどう関係する？",
    takeaway: "覚えておくポイント",
  });
  assert.equal(TOPIC_DETAIL_PRACTICAL_MARKET_HEADING, "実践ではどう見る？");
});

test("no blank heading or body; every section is substantial but bounded", () => {
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    for (const section of entry.sections) {
      assert.ok(section.heading.trim().length > 0, `${title}: blank heading`);
      assert.ok(section.body.trim().length > 0, `${title}: blank body`);
      assert.ok(section.body.length >= 25 && section.body.length <= 200, `${title}/${section.role}: ${section.body.length} chars is outside 25-200`);
      assert.equal(section.body, section.body.trim(), `${title}/${section.role}: stray leading/trailing whitespace`);
      assert.ok(!/ {2,}|[　]{2,}|\t/.test(section.body), `${title}/${section.role}: odd whitespace`);
    }
  }
});

test("combined body is roughly 220-600 characters per topic (a design target, never padding)", () => {
  for (const title of SEEDED_TITLES) {
    const total = bodyLength(title);
    assert.ok(total >= 220 && total <= 600, `${title}: combined body length ${total} is outside 220-600`);
  }
});

test("every topic has a concrete, clearly hypothetical example", () => {
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    const example = entry.sections.find((s) => s.role === "example")!;
    assert.ok(example.body.length >= 60, `${title}: the example is too thin`);
    assert.ok(/たとえば/.test(example.body), `${title}: an example should be introduced as たとえば…`);
    // Numbers or scenarios must be flagged as hypothetical/educational, never read as a real quote.
    assert.ok(/仮の(数字|例|流れ)/.test(example.body) || !/[0-9０-９]/.test(example.body), `${title}: an example with numbers must say it is hypothetical (仮の数字/仮の例)`);
  }
});

test("every topic ends with a memorable takeaway", () => {
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    const takeaway = entry.sections[entry.sections.length - 1];
    assert.equal(takeaway.role, "takeaway", title);
    assert.ok(takeaway.body.length >= 25, `${title}: takeaway too short`);
  }
});

test("evergreen guard: no current-price/date/live-market claims and no 今日の市場 style grounding", () => {
  const forbidden = /現在の株価|本日|今日の(相場|株価|市場|終値)|今週|今月|今年|昨日|最新|直近|速報|リアルタイム|\d{4}年|\d{1,2}月\d{1,2}日|[0-9]{4}\/[0-9]{1,2}/;
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    for (const section of entry.sections) {
      assert.ok(!forbidden.test(section.body), `${title}: section "${section.heading}" looks time-bound or live`);
    }
  }
});

test("no advice, prediction or guarantee wording", () => {
  const forbidden = /買うべき|売るべき|買いです|売りです|おすすめ|オススメ|必ず(上が|儲か|下が|勝)|絶対|間違いなく|確実に(上|儲|勝)|保証します|儲かります|損しません/;
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    for (const section of entry.sections) {
      assert.ok(!forbidden.test(section.body), `${title}: section "${section.heading}" sounds like advice/prediction`);
    }
  }
});

test("no sentence is repeated across the sections of a topic, and no entry copies another", () => {
  const seen = new Map<string, string>();
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    const sentences = new Set<string>();
    for (const section of entry.sections) {
      for (const sentence of section.body.split("。").map((s) => s.trim()).filter((s) => s.length >= 12)) {
        assert.ok(!sentences.has(sentence), `${title}: repeats "${sentence}" across sections`);
        sentences.add(sentence);
        const owner = seen.get(sentence);
        assert.ok(owner === undefined || owner === title, `"${sentence}" is copied between ${owner} and ${title}`);
        seen.set(sentence, title);
      }
    }
  }
});

test("each topic's takeaway and example are unique across the catalog", () => {
  const takeaways = Object.values(TOPIC_DETAIL_CATALOG).map((e) => e.sections[4].body);
  const examples = Object.values(TOPIC_DETAIL_CATALOG).map((e) => e.sections[2].body);
  assert.equal(new Set(takeaways).size, 50);
  assert.equal(new Set(examples).size, 50);
});

test("topicDetailFor: returns null for an unknown title, never fabricating content", () => {
  assert.equal(topicDetailFor("架空のトピックタイトル"), null);
  assert.equal(topicDetailFor(""), null);
});

test("topicDetailFor: returns the exact catalog entry for a known title", () => {
  const entry = topicDetailFor("PERって何？");
  assert.ok(entry);
  assert.equal(entry.sections[0].heading, "まずこれだけ");
  assert.equal(entry.sections[0].role, "basics");
  assert.equal(topicDetailFor("急騰株で出来高を見る理由")!.sections[3].heading, "実践ではどう見る？");
});
