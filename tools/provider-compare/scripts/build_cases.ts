// Builds fixtures/cases.json from the JSON-lines output of scripts/export_cases.sql.
//   deno run --no-config --allow-read --allow-write tools/provider-compare/scripts/build_cases.ts <rows.jsonl> [out.json]
// The SQL is read-only; this script only reshapes and sanitises. It is deterministic: same rows, same file.
import type { CaseFixture, CaseGroup, CasesFile, Importance, OutcomeKind } from "../src/fixtures.ts";
import { sanitizeBody } from "../src/sanitize.ts";
import type { ImportantNewsCategory } from "../../../supabase/functions/important-news-monitor/news_candidate_logic.ts";

type Row = Record<string, unknown>;

type Meta = {
  slug: string;
  group: CaseGroup;
  kind: OutcomeKind;
  note: string;
  expected?: Importance;
};

// Keyed by the first 8 characters of the production candidate id.
export const CASE_META: Readonly<Record<string, Meta>> = {
  "25c28b26": { slug: "fx-finance-minister-remarks", group: "fx", kind: "success", note: "財務相が米国からの協調介入要請を否定した発言。旧generic検索（日本市場トピック）が拾い、重要として配信待ちになった。" },
  "a989d1f3": { slug: "boj-official-policy-change-notice", group: "boj", kind: "miss", note: "日銀公式の『金融市場調節方針の変更について』。同じ利上げの報道記事は重要として公開されたが、この公式文書は no_post と判定された（取りこぼし例）。", expected: "important" },
  "cafc0f82": { slug: "boj-rate-hike-news", group: "boj", kind: "success", note: "日銀の利上げ（1.25%）の報道。旧generic検索が拾い、重要として公開された。" },
  "090e8d18": { slug: "north-korea-projectile", group: "north_korea", kind: "success", note: "北朝鮮の飛翔体発射。旧generic検索（国内安全保障トピック）が拾い、重要として公開された。" },
  "84832da2": { slug: "tdnet-sbi-merger-fact-failure", group: "tdnet_capital", kind: "generation_failure", note: "吸収合併の基本合意。会社同一性が原因でFactに失敗した例（のちに判定を修正済み）。" },
  "26648baf": { slug: "tdnet-press-report-denial-fact-failure", group: "tdnet_capital", kind: "generation_failure", note: "『当社に関する一部報道について』。本文が『当社』のみで会社名を含まず、Factに失敗した例（のちに修正済み）。" },
  "e956ae92": { slug: "aj-flydubai-attack", group: "geopolitics", kind: "success", note: "Al Jazeeraの見出しトリガー経由で公開された国際ニュース。" },
  "f4a8a7cc": { slug: "bbc-flydubai-attack-fact-failure", group: "geopolitics", kind: "generation_failure", note: "同じ事件のBBC記事。『17,000フィート超』を『約5,200m』と言い換えて『超』を落とし、Factに失敗した例。" },
  "a3dac612": { slug: "boj-governor-speech", group: "negative_control", kind: "negative_control", note: "日銀総裁の挨拶（講演）。市場を動かす新情報がなく no_post が妥当な対照例。", expected: "no_post" },
  "1533a3fd": { slug: "bbc-nepal-floods", group: "disaster", kind: "success", note: "ネパールの洪水報道（海外災害）。見出しトリガー経由で公開された。" },
  "4887f2b0": { slug: "tdnet-buyback-fact-failure", group: "tdnet_capital", kind: "generation_failure", note: "自己株式取得の決定。Factに失敗した例。" },
  "0b73ef94": { slug: "tdnet-jftc-raid", group: "domestic_incident", kind: "success", note: "公正取引委員会による強制調査。国内企業の重大事案として公開された。" },
  "3a1fe802": { slug: "aj-qatar-tanker", group: "geopolitics", kind: "success", note: "カタール沖でタンカーが攻撃を受けた報道。重要として公開された。" },
  "d09c88ce": { slug: "tdnet-small-acquisition", group: "tdnet_capital", kind: "success", note: "子会社化（株式取得）の開示。重要として公開された。" },
  "60d9954a": { slug: "tdnet-third-party-committee", group: "domestic_incident", kind: "success", note: "分配可能額超過に関する第三者委員会の設置。重要として公開された。" },
  "7207a56d": { slug: "tdnet-dividend-increase", group: "tdnet_earnings", kind: "success", note: "中間配当の増配と配当予想の修正。" },
  "91569af5": { slug: "tdnet-earnings-revision-contract-loss", group: "tdnet_earnings", kind: "success", note: "主要取引先との契約解除に伴う損失と通期業績予想の修正（最重要）。" },
  "8792253b": { slug: "aj-hurricane-fact-failure", group: "disaster", kind: "generation_failure", note: "ハリケーン接近の報道。Factに失敗した例。" },
  "44df218f": { slug: "tdnet-share-consolidation-voice-failure", group: "tdnet_capital", kind: "generation_failure", note: "株式併合・単元株式数の廃止。Voiceに失敗した例。" },
  "2f881cde": { slug: "tdnet-large-order-fact-failure", group: "tdnet_earnings", kind: "generation_failure", note: "大口受注の開示。Factに失敗した例。" },
  "201cf3c7": { slug: "tdnet-etf-daily-disclosure", group: "negative_control", kind: "negative_control", note: "ETFの日々の開示事項。定型で no_post が妥当な対照例。", expected: "no_post" },
  "b5a10bac": { slug: "fsa-insurer-administrative-action", group: "fsa_action", kind: "success", note: "金融庁による生命保険会社への行政処分（JP公式レーン）。" },
};

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function buildCase(row: Row): CaseFixture {
  const id = String(row.id ?? "").slice(0, 8);
  const meta = CASE_META[id];
  if (!meta) throw new Error(`NO_CASE_META:${id}`);
  const importance = row.importance as Importance;
  const generated = text(row.generated_text);
  const hasGeneration = generated !== null || text(row.generation_error) !== null;
  return {
    caseId: `${meta.slug}-${id}`,
    group: meta.group,
    outcomeKind: meta.kind,
    note: meta.note,
    candidate: {
      sourceType: String(row.source_type),
      sourceUrl: String(row.source_url),
      sourceName: String(row.source_name),
      title: String(row.title),
      bodySummary: sanitizeBody(text(row.body_summary)),
      companyName: text(row.company_name),
      companyCode: text(row.company_code),
      entityKey: text(row.entity_key),
      category: row.category as ImportantNewsCategory,
      publishedAt: new Date(String(row.published_at)).toISOString(),
    },
    recorded: {
      judgement: {
        importance,
        category: row.category as ImportantNewsCategory,
        affectedEntities: list(row.affected_entities),
        japanMarketRelevance: (text(row.japan_market_relevance) ?? "none") as "none" | "low" | "medium" | "high",
        reason: text(row.judgement_reason) ?? "",
        confidence: Number(row.confidence ?? 0),
        needsSol: row.escalated_to_sol === true,
        factCheckStatus: (text(row.fact_check_status) ?? "needs_review") as "passed" | "needs_review",
        model: text(row.judgement_model) ?? "unknown",
        escalatedToSol: row.escalated_to_sol === true,
      },
      generation: hasGeneration
        ? {
          text: generated,
          model: text(row.generation_model),
          factStatus: text(row.generation_fact_status),
          voiceStatus: text(row.generation_voice_status),
          error: text(row.generation_error),
          factIssues: list(row.generation_fact_issues),
          voiceIssues: list(row.generation_voice_issues),
        }
        : null,
    },
    // A hint that merely restates production's decision (the negative controls) is still production's decision.
    expected: meta.expected && meta.expected !== importance
      ? { importance: meta.expected, source: "human_hint" }
      : { importance, source: "production_decision" },
  };
}

export function buildCasesFile(rows: Row[]): CasesFile {
  const cases = rows.map(buildCase).sort((a, b) => a.caseId.localeCompare(b.caseId));
  return { version: 1, exportedAt: "2026-10-09", cases };
}

if (import.meta.main) {
  const [input, output] = Deno.args;
  if (!input) {
    console.error("usage: build_cases.ts <rows.jsonl> [out.json]");
    Deno.exit(2);
  }
  const rows = (await Deno.readTextFile(input)).split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  const file = buildCasesFile(rows);
  const target = output ?? new URL("../fixtures/cases.json", import.meta.url).pathname;
  await Deno.writeTextFile(target, JSON.stringify(file, null, 2) + "\n");
  console.log(`wrote ${file.cases.length} cases to ${target}`);
}
