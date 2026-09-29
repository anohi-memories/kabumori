import assert from "node:assert/strict";
import test from "node:test";

import { TOPIC_DETAIL_CATALOG, topicDetailFor } from "../../src/lib/topic-detail-catalog.ts";

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

test("every one of the 50 currently-seeded tip titles has a curated detail entry", () => {
  assert.equal(SEEDED_TITLES.length, 50);
  const missing = SEEDED_TITLES.filter((title) => !(title in TOPIC_DETAIL_CATALOG));
  assert.deepEqual(missing, [], `missing curated detail for: ${missing.join(", ")}`);
});

test("the catalog contains no unexpected extra titles beyond the current seed", () => {
  const seeded = new Set(SEEDED_TITLES);
  const extra = Object.keys(TOPIC_DETAIL_CATALOG).filter((title) => !seeded.has(title));
  assert.deepEqual(extra, []);
});

test("every entry has 2-4 sections, each with a non-empty heading and body", () => {
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    assert.ok(entry.sections.length >= 2 && entry.sections.length <= 4, `${title}: expected 2-4 sections, got ${entry.sections.length}`);
    for (const section of entry.sections) {
      assert.ok(section.heading.trim().length > 0, `${title}: a section heading is empty`);
      assert.ok(section.body.trim().length > 0, `${title}: a section body is empty`);
    }
  }
});

test("every entry is substantially longer than the ~50-character base_text it replaces (task's own 200-450 is a soft 目安, not a hard minimum)", () => {
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    const total = entry.sections.reduce((sum, section) => sum + section.body.length, 0);
    assert.ok(total >= 100 && total <= 500, `${title}: combined body length ${total} is outside 100-500`);
  }
});

test("no entry claims specific real-time prices or dates (a lightweight evergreen-content guard)", () => {
  const forbidden = /現在の株価|本日の終値|今日の相場|\d{4}年\d{1,2}月\d{1,2}日/;
  for (const [title, entry] of Object.entries(TOPIC_DETAIL_CATALOG)) {
    for (const section of entry.sections) {
      assert.ok(!forbidden.test(section.body), `${title}: section "${section.heading}" looks like it references a specific real-time value`);
    }
  }
});

test("topicDetailFor: returns null for an unknown title, never fabricating content", () => {
  assert.equal(topicDetailFor("架空のトピックタイトル"), null);
  assert.equal(topicDetailFor(""), null);
});

test("topicDetailFor: returns the exact catalog entry for a known title", () => {
  const entry = topicDetailFor("PERって何？");
  assert.ok(entry);
  assert.equal(entry.sections[0].heading, "ひとことで");
});
