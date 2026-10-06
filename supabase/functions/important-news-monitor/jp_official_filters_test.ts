import assert from "node:assert/strict";
import test from "node:test";
import { classifyJpOfficialTitle, JP_OFFICIAL_SOURCES } from "./jp_official_filters.ts";

const candidate = (source: string, title: string) => classifyJpOfficialTitle(source, title).decision === "candidate";

test("MOF: FX intervention, reserve fund, sanctions reach judgement", () => {
  assert.equal(candidate("jp_mof_news", "外国為替平衡操作の実施状況（令和8年8月27日～令和8年9月28日）"), true);
  assert.equal(candidate("jp_mof_news", "令和8年度一般会計予備費使用要求書を掲載しました"), true);
  assert.equal(candidate("jp_mof_news", "ロシア等に対する資産凍結等の措置について"), true);
  assert.equal(classifyJpOfficialTitle("jp_mof_news", "外国為替平衡操作の実施状況").decision === "candidate" &&
    (classifyJpOfficialTitle("jp_mof_news", "外国為替平衡操作の実施状況") as { category: string }).category, "fx");
});

test("MOF: auction tables, personnel and statistics bulletins are routine", () => {
  for (const title of ["10年利付国債の入札結果", "財務省幹部名簿を更新しました", "租税及び印紙収入、収入額調", "財政金融統計月報を掲載しました", "職員を募集します"]) {
    assert.equal(candidate("jp_mof_news", title), false, title);
  }
});

test("FSA: administrative action and ordinance changes reach judgement; meeting minutes do not", () => {
  assert.equal(candidate("jp_fsa_news", "株式会社○○に対する行政処分について"), true);
  assert.equal(candidate("jp_fsa_news", "令和8年台風第○号に伴う災害等に対する金融上の措置について"), true);
  assert.equal(candidate("jp_fsa_news", "金融審議会 市場制度ワーキング・グループ議事要旨"), false);
  assert.equal(candidate("jp_fsa_news", "金融庁職員の採用について"), false);
});

test("Kantei: economic council and missile directive pass; courtesy calls and ceremonies do not", () => {
  assert.equal(candidate("jp_kantei_news", "経済財政諮問会議"), true);
  assert.equal(candidate("jp_kantei_news", "弾道ミサイル発射に関する総理指示"), true);
  assert.equal(candidate("jp_kantei_news", "○○大使の表敬"), false);
  assert.equal(candidate("jp_kantei_news", "○○賞の授賞式"), false);
});

test("CAA: serious accidents and enforcement pass; campaigns do not", () => {
  assert.equal(candidate("jp_caa_news", "重大製品事故の公表について"), true);
  assert.equal(candidate("jp_caa_news", "株式会社○○に対する景品表示法に基づく措置命令について"), true);
  assert.equal(candidate("jp_caa_news", "消費者月間の啓発イベント"), false);
});

test("JMA extra: only special warnings pass", () => {
  assert.equal(candidate("jp_jma_extra", "大雨特別警報"), true);
  assert.equal(candidate("jp_jma_extra", "大雨警報・注意報"), false);
  assert.equal(candidate("jp_jma_extra", "記録的短時間大雨情報"), false);
});

test("unconnected and unknown sources are dropped with a reason", () => {
  assert.deepEqual(classifyJpOfficialTitle("jp_esri", "GDP速報"), { decision: "drop", reason: "source_not_connected" });
  assert.deepEqual(classifyJpOfficialTitle("jp_jma_eqvol", "震度速報"), { decision: "drop", reason: "source_not_connected" });
  assert.deepEqual(classifyJpOfficialTitle("jp_boj_news", "決定会合"), { decision: "drop", reason: "unknown_source" });
  assert.deepEqual(classifyJpOfficialTitle("jp_mof_news", "   "), { decision: "drop", reason: "empty_title" });
});

test("unmatched theme defaults to drop; BOJ is not a connected source", () => {
  assert.deepEqual(classifyJpOfficialTitle("jp_mof_news", "広報活動のご案内"), { decision: "drop", reason: "no_matching_theme" });
  assert.equal(Object.keys(JP_OFFICIAL_SOURCES).some((id) => id.includes("boj")), false);
});
