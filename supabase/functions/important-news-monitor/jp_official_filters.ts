import type { ImportantNewsCategory } from "./news_candidate_logic.ts";

// JP official lane (JP Coverage Phase B): which Japanese government releases stored by news_discovery are
// worth a place in front of the importance judgement.  Nothing here decides importance — the existing
// judgement does.  This only removes releases that are structurally routine (personnel, procurement, auction
// result tables, recruiting, outreach), so that a cheap deterministic step keeps the AI judgement for releases
// that can plausibly matter to Japanese-stock investors.  Default is DROP, and every drop carries a reason so
// recall can be audited from the diagnostics.

export type JpOfficialSourceId =
  | "jp_mof_news"
  | "jp_fsa_news"
  | "jp_kantei_news"
  | "jp_caa_news"
  | "jp_esri"
  | "jp_jma_eqvol"
  | "jp_jma_extra";

export type JpOfficialSourceConfig = {
  label: string;
  /** false = not connected in this phase (reason says why). */
  enabled: boolean;
  /** Fetch a short main text from the release's own official page before judgement. */
  enrich: boolean;
  /** The release link is not a readable page (JMA telegrams are XML): the feed's own short text is the body. */
  bodyFromHint?: boolean;
  /** Registrable domains the release URL (and every redirect hop) must stay on. */
  domains: string[];
  /** Attribution the publisher's terms ask for. Shown with the source URL by downstream posts. */
  attribution: string;
  note: string;
};

export const JP_OFFICIAL_SOURCES: Record<JpOfficialSourceId, JpOfficialSourceConfig> = {
  jp_mof_news: {
    label: "財務省",
    enabled: true,
    enrich: true,
    domains: ["mof.go.jp"],
    attribution: "出典：財務省ウェブサイト",
    note: "FX intervention results, 予備費, tax / tariff requests, 国債 plans. Auction result tables and personnel are routine.",
  },
  jp_fsa_news: {
    label: "金融庁",
    enabled: true,
    enrich: true,
    domains: ["fsa.go.jp"],
    attribution: "出典：金融庁ウェブサイト",
    note: "Administrative actions, financial measures after disasters, ordinance changes, bank reorganisations.",
  },
  jp_kantei_news: {
    label: "首相官邸",
    enabled: true,
    enrich: true,
    domains: ["kantei.go.jp"],
    attribution: "出典：首相官邸ホームページ",
    note: "Economic council, monthly economic report, leader talks, missile directives. Courtesy calls and messages are routine.",
  },
  jp_caa_news: {
    label: "消費者庁",
    enabled: true,
    enrich: true,
    domains: ["caa.go.jp"],
    attribution: "出典：消費者庁ウェブサイト",
    note: "Serious product accidents / recalls and 景品表示法 orders. Campaigns, surveys and recruiting are routine.",
  },
  jp_esri: {
    label: "内閣府（ESRI）",
    enabled: false,
    enrich: false,
    domains: ["esri.cao.go.jp"],
    attribution: "出典：内閣府ウェブサイト",
    note:
      "NOT connected: the feed link of a GDP / business-cycle release is the statistics menu page (e.g. /jp/sna/menu.html), " +
      "not the release, and the title carries no figures, so the judgement could only answer 'cannot confirm'. " +
      "Needs its own design (the 記者公表資料 PDF or a release-label-verified dashboard parser).",
  },
  jp_jma_eqvol: {
    label: "気象庁（地震・津波・噴火）",
    enabled: false,
    enrich: false,
    domains: ["jma.go.jp"],
    attribution: "出典：気象庁ホームページ",
    note:
      "NOT connected: the legacy market_macro lane already fetches the same eqvol.xml feed " +
      "(jma_eqvol, 震度5以上 / 津波 / 噴火警報級), so connecting it again would only duplicate.",
  },
  jp_jma_extra: {
    label: "気象庁（特別警報）",
    enabled: true,
    enrich: false,
    bodyFromHint: true,
    domains: ["jma.go.jp"],
    attribution: "出典：気象庁ホームページ",
    note:
      "Only special-warning-class telegrams reach the signals table (the observer drops ~1,700 routine telegrams a day). " +
      "The link is an XML telegram, so the feed's short text is the body. Relay with attribution only (気象業務法23条).",
  },
};

export type JpOfficialClassification =
  | { decision: "candidate"; reason: string; category: ImportantNewsCategory; topicKey: string }
  | { decision: "drop"; reason: string };

// Releases that are never worth a judgement, whatever else the title says (personnel, procurement, recruiting,
// outreach, messages, awards).  Checked first.
const HARD_ROUTINE =
  /人事異動|幹部名簿|職員を募集|採用|任期付|公募|入札、?落札結果|政府調達|障害者|広報誌|メールマガジン|もっと知りたい|ディスカッション・?ペーパー|フィナンシャル・?レビュー|財政金融統計月報|講演|相談室|ナビダイヤル|アンケート|啓発|川柳|コンテスト|表彰|ビデオメッセージ|食品ロス|てまえどり|VR動画|機能性表示食品/u;
// Generic bookkeeping wording (agendas, "updated", "posted").  Checked only AFTER the allow rules, so that a
// specific event posted with such wording (予備費使用要求書を掲載しました) is not lost.
const SOFT_ROUTINE =
  /議事次第|議事要旨|議事録|開催について|開催のお知らせ|委員名簿|Q&A|更新しました|掲載しました|募集について|募集を開始/u;

type Rule = { pattern: RegExp; reason: string; category: ImportantNewsCategory; topicKey: string };

const MOF_RULES: Rule[] = [
  { pattern: /外国為替平衡操作|為替介入/u, reason: "fx_intervention", category: "fx", topicKey: "fx_intervention" },
  { pattern: /予備費|補正予算|経済対策|総合経済対策|財政健全化|骨太/u, reason: "budget_fiscal_policy", category: "other_market_moving", topicKey: "fiscal_policy" },
  { pattern: /税制改正|関税改正|関税定率|租税/u, reason: "tax_policy", category: "other_market_moving", topicKey: "tax_policy" },
  { pattern: /資産凍結|制裁/u, reason: "sanctions", category: "sanctions", topicKey: "sanctions" },
  { pattern: /国債発行計画|国債の発行計画|借換債|国債整理基金|格付/u, reason: "jgb_issuance_policy", category: "interest_rates", topicKey: "jgb_policy" },
  { pattern: /財務(?:大臣|相).*(?:会見|声明|談話)|閣議後記者会見|G7|G20/u, reason: "minister_statement", category: "other_market_moving", topicKey: "minister_statement" },
];
// MOF auction / issuance / rate tables are weekly routine (market data is covered by MIC), not releases to judge.
const MOF_ROUTINE = [
  /入札結果|入札発行|非価格競争入札|入札予定|発行予定額|償還予定額|流動性供給入札|物価連動債|金利情報|貸付金利|預託金利|借入金の入札|政府保証の付与|証券売買契約等の状況|租税及び印紙収入|製造たばこ|特別会計/u,
];

const FSA_RULES: Rule[] = [
  { pattern: /行政処分|業務改善命令|業務停止命令|課徴金|勧告|処分について|検査結果/u, reason: "enforcement", category: "other_market_moving", topicKey: "enforcement" },
  { pattern: /金融上の措置|災害等に対する|災害救助法/u, reason: "disaster_financial_measures", category: "disaster", topicKey: "disaster_measures" },
  { pattern: /組織再編|経営統合|公的資金|資本参加|破綻|金融機能強化法/u, reason: "bank_restructuring", category: "other_market_moving", topicKey: "bank_restructuring" },
  { pattern: /内閣府令の一部を改正|政令|法律案|施行規則等の一部を改正|市場制度|空売り|暗号資産|ステーブルコイン|NISA|税制改正要望/u, reason: "rule_change", category: "other_market_moving", topicKey: "rule_change" },
  { pattern: /サイバー|システム障害|顧客情報|不正(?:アクセス|取引)|詐欺/u, reason: "incident", category: "major_security_incident", topicKey: "financial_incident" },
];

// Meeting bodies' agendas and minutes (議事次第 / 議事要旨 of 審議会・審査会・WG・フォーラム) are routine for FSA.
const FSA_ROUTINE = [/議事次第|議事要旨|審査会|審議会|ワーキング・?グループ|フォーラム|研究会|検討会/u];

const KANTEI_RULES: Rule[] = [
  { pattern: /経済財政諮問会議|月例経済報告|経済対策|総合経済対策|補正予算|予算編成|骨太/u, reason: "economic_policy", category: "other_market_moving", topicKey: "economic_policy" },
  { pattern: /弾道ミサイル|ミサイル.*発射|総理指示/u, reason: "missile_directive", category: "war_ceasefire", topicKey: "missile" },
  { pattern: /首脳会談|電話会談|日米|関税|通商|貿易/u, reason: "diplomacy_trade", category: "geopolitics", topicKey: "diplomacy_trade" },
  { pattern: /エネルギー|半導体|賃金|物価|金融政策|為替|防衛力|国家安全保障|緊急事態|解散|内閣改造/u, reason: "policy_theme", category: "other_market_moving", topicKey: "policy_theme" },
  { pattern: /閣議の概要/u, reason: "cabinet_decisions", category: "other_market_moving", topicKey: "cabinet" },
];
const KANTEI_ROUTINE = [/表敬|面会|政務官会合|次官連絡会議|式典|視察|懇談|レセプション|夕べ|大賞/u];

const CAA_RULES: Rule[] = [
  { pattern: /重大製品事故|リコール|自主回収/u, reason: "product_safety", category: "other_market_moving", topicKey: "product_safety" },
  { pattern: /措置命令|課徴金納付命令|景品表示法に基づく措置|消費者安全法の重大事故/u, reason: "consumer_enforcement", category: "other_market_moving", topicKey: "consumer_enforcement" },
];
const CAA_ROUTINE = [/法的措置件数の推移|経過報告|委員会委員名簿|一葉/u];

// Only a JMA *special warning* (大雨特別警報 …) is a release worth judging; 記録的短時間大雨情報 / 土砂災害警戒情報 /
// 竜巻注意情報 are local and frequent.
const JMA_EXTRA_RULES: Rule[] = [
  { pattern: /特別警報(?!・警報・注意報)/u, reason: "jma_special_warning", category: "disaster", topicKey: "jma_special_warning" },
];

const RULES: Partial<Record<JpOfficialSourceId, { rules: Rule[]; routine: RegExp[] }>> = {
  jp_mof_news: { rules: MOF_RULES, routine: MOF_ROUTINE },
  jp_fsa_news: { rules: FSA_RULES, routine: FSA_ROUTINE },
  jp_kantei_news: { rules: KANTEI_RULES, routine: KANTEI_ROUTINE },
  jp_caa_news: { rules: CAA_RULES, routine: CAA_ROUTINE },
  jp_jma_extra: { rules: JMA_EXTRA_RULES, routine: [] },
};

export function isJpOfficialSourceId(value: string): value is JpOfficialSourceId {
  return Object.prototype.hasOwnProperty.call(JP_OFFICIAL_SOURCES, value);
}

/** Deterministic title classification. Default is drop; a candidate only means "worth the judgement's time". */
export function classifyJpOfficialTitle(sourceId: string, rawTitle: string): JpOfficialClassification {
  if (!isJpOfficialSourceId(sourceId)) return { decision: "drop", reason: "unknown_source" };
  const config = JP_OFFICIAL_SOURCES[sourceId];
  if (!config.enabled) return { decision: "drop", reason: "source_not_connected" };
  const title = rawTitle.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!title) return { decision: "drop", reason: "empty_title" };
  const table = RULES[sourceId];
  if (!table) return { decision: "drop", reason: "source_not_connected" };
  if (HARD_ROUTINE.test(title)) return { decision: "drop", reason: "routine" };
  if (table.routine.some((pattern) => pattern.test(title))) return { decision: "drop", reason: "routine" };
  const hit = table.rules.find((rule) => rule.pattern.test(title));
  if (hit) return { decision: "candidate", reason: hit.reason, category: hit.category, topicKey: hit.topicKey };
  if (SOFT_ROUTINE.test(title)) return { decision: "drop", reason: "routine" };
  return { decision: "drop", reason: "no_matching_theme" };
}
