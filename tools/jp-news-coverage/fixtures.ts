// Phase J0 offline benchmark fixtures: 100% synthetic (fictional companies, places and figures). No third-party article
// text. Each event is described by attributes only; the expected axes are decided by the rules in classify.ts.

export type SourceKind =
  | "official_primary" // government / regulator / exchange / company IR release
  | "company_newsroom"
  | "licensed_wire" // contract in place (none today: modelled for Tier C planning)
  | "media_unlicensed" // news media without a machine-use licence
  | "social_unverified";

export type Verification = "primary_confirmed" | "multi_source" | "single_source" | "rumor" | "retracted" | "old_republish";
export type Locality = "domestic" | "foreign_with_jp_impact" | "foreign_only";
export type Severity = "emergency" | "critical" | "high" | "medium" | "low";

export type EventFixture = {
  id: string;
  group:
    | "corporate_scandal"
    | "incident_accident"
    | "financial_regulation_bank_failure"
    | "boj_policy"
    | "earthquake_missile"
    | "administrative_action_litigation"
    | "negative_control";
  summary: string; // synthetic description, never an article
  source_kind: SourceKind;
  /** A technically reachable feed / API exists for this source (false = no_source). Whether we may use it is rights_ok. */
  feed_available: boolean;
  /** Machine use / AI input / display rights are confirmed for this source. */
  rights_ok: boolean;
  verification: Verification;
  locality: Locality;
  severity: Severity;
  /** Passes the deterministic theme filter of the lane that would pick it up. */
  passes_rule_filter: boolean;
  /** Seconds after first public time (null = not observed / NOT_AVAILABLE). */
  first_public_to_fetched_s: number | null;
  fetched_to_judged_s: number | null;
  judged_to_display_s: number | null;
  expected: { discovered: boolean; relevant: boolean; eligible_for_app: boolean; urgent_push: boolean; miss_reason: MissReason | null };
};

export type MissReason =
  | "no_source"
  | "terms_excluded"
  | "filtered_rule"
  | "no_candidate"
  | "judgement_rejected"
  | "generation_failed"
  | "app_display_gate"
  | "push_policy"
  | "duplicate_event"
  | "unknown";

const t = (a: number | null, b: number | null, c: number | null) => ({ first_public_to_fetched_s: a, fetched_to_judged_s: b, judged_to_display_s: c });

export const FIXTURES: EventFixture[] = [
  // --- corporate scandal
  { id: "cs-1", group: "corporate_scandal", summary: "架空のA社が第三者委員会の調査報告で不適切会計を公表（自社IR）", source_kind: "official_primary", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "critical", passes_rule_filter: true, ...t(300, 900, 600), expected: { discovered: true, relevant: true, eligible_for_app: true, urgent_push: true, miss_reason: null } },
  { id: "cs-2", group: "corporate_scandal", summary: "架空のB社の元役員に関する不正疑惑を報じる記事（公式確認なし）", source_kind: "media_unlicensed", feed_available: true, rights_ok: false, verification: "single_source", locality: "domestic", severity: "high", passes_rule_filter: true, ...t(null, null, null), expected: { discovered: false, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "terms_excluded" } },
  // --- incident / accident
  { id: "ia-1", group: "incident_accident", summary: "架空のC工場で爆発事故、消防が発表（公式）", source_kind: "official_primary", feed_available: false, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "critical", passes_rule_filter: true, ...t(null, null, null), expected: { discovered: false, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "no_source" } },
  { id: "ia-2", group: "incident_accident", summary: "架空の鉄道会社D線で大規模運休、会社が公式発表", source_kind: "company_newsroom", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "high", passes_rule_filter: true, ...t(600, 1200, 900), expected: { discovered: true, relevant: true, eligible_for_app: true, urgent_push: false, miss_reason: null } },
  // --- financial regulation / bank failure
  { id: "fr-1", group: "financial_regulation_bank_failure", summary: "金融庁が架空のE銀行へ業務改善命令（公式）", source_kind: "official_primary", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "critical", passes_rule_filter: true, ...t(900, 1500, 600), expected: { discovered: true, relevant: true, eligible_for_app: true, urgent_push: true, miss_reason: null } },
  { id: "fr-2", group: "financial_regulation_bank_failure", summary: "架空のF信用組合の経営破綻の噂（SNS）", source_kind: "social_unverified", feed_available: true, rights_ok: false, verification: "rumor", locality: "domestic", severity: "emergency", passes_rule_filter: true, ...t(null, null, null), expected: { discovered: false, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "terms_excluded" } },
  // --- BOJ policy
  { id: "bj-1", group: "boj_policy", summary: "日銀が政策金利の変更を公表（公式・決定文）", source_kind: "official_primary", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "emergency", passes_rule_filter: true, ...t(120, 600, 300), expected: { discovered: true, relevant: true, eligible_for_app: true, urgent_push: true, miss_reason: null } },
  { id: "bj-2", group: "boj_policy", summary: "日銀審議委員の講演要旨（公式・定例）", source_kind: "official_primary", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "low", passes_rule_filter: false, ...t(1800, null, null), expected: { discovered: true, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "filtered_rule" } },
  // --- earthquake / missile
  { id: "em-1", group: "earthquake_missile", summary: "気象庁が震度6強の地震情報を発表（公式防災XML）", source_kind: "official_primary", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "emergency", passes_rule_filter: true, ...t(90, 300, 120), expected: { discovered: true, relevant: true, eligible_for_app: true, urgent_push: true, miss_reason: null } },
  { id: "em-2", group: "earthquake_missile", summary: "隣国の弾道ミサイル発射（日本の公式発表の機械取得経路なし）", source_kind: "official_primary", feed_available: false, rights_ok: true, verification: "primary_confirmed", locality: "foreign_with_jp_impact", severity: "emergency", passes_rule_filter: true, ...t(null, null, null), expected: { discovered: false, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "no_source" } },
  // --- administrative action / litigation
  { id: "al-1", group: "administrative_action_litigation", summary: "公取委が架空のG社へ排除措置命令（公式）", source_kind: "official_primary", feed_available: false, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "high", passes_rule_filter: true, ...t(null, null, null), expected: { discovered: false, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "no_source" } },
  { id: "al-2", group: "administrative_action_litigation", summary: "架空のH社が訴訟提起を受けたと自社IRで開示", source_kind: "official_primary", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "domestic", severity: "medium", passes_rule_filter: true, ...t(600, 2400, 1800), expected: { discovered: true, relevant: true, eligible_for_app: true, urgent_push: false, miss_reason: null } },
  // --- negative controls
  { id: "nc-1", group: "negative_control", summary: "数年前の不祥事を再掲した記事（旧ニュースの再掲）", source_kind: "company_newsroom", feed_available: true, rights_ok: true, verification: "old_republish", locality: "domestic", severity: "high", passes_rule_filter: true, ...t(600, 600, null), expected: { discovered: true, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "duplicate_event" } },
  { id: "nc-2", group: "negative_control", summary: "海外のみで完結する企業事件（日本関連なし）", source_kind: "official_primary", feed_available: true, rights_ok: true, verification: "primary_confirmed", locality: "foreign_only", severity: "high", passes_rule_filter: false, ...t(1800, null, null), expected: { discovered: true, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "filtered_rule" } },
  { id: "nc-3", group: "negative_control", summary: "行政処分と噂される未確認情報（公式の確認なし）", source_kind: "media_unlicensed", feed_available: true, rights_ok: true, verification: "rumor", locality: "domestic", severity: "high", passes_rule_filter: true, ...t(600, 900, null), expected: { discovered: true, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "judgement_rejected" } },
  { id: "nc-4", group: "negative_control", summary: "訂正・取消された報道（retracted）", source_kind: "licensed_wire", feed_available: true, rights_ok: true, verification: "retracted", locality: "domestic", severity: "critical", passes_rule_filter: true, ...t(300, 600, null), expected: { discovered: true, relevant: false, eligible_for_app: false, urgent_push: false, miss_reason: "judgement_rejected" } },
];
