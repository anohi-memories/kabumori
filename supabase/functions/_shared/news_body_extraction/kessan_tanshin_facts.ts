// Phase 6 (offline): structured facts of a 決算短信 (TDnet earnings flash) from its PDF text.
//
// Why: the production body summary (buildTdnetBodySummary) keeps only lines that contain a keyword plus one line of
// context on each side. The results table puts its numbers two or three lines BELOW the header ("売上高 営業利益 …",
// units line, then "2026年11月期第３四半期 12,782 23.9 2,939 …"), and the period label of that row contains none of the
// keywords, so the current-period row is dropped (19 of 19 real tables in the 2026-10-11 survey) and the 6,000
// character cap is then filled with other keyword lines.
//
// This module reads the table rows themselves, keeps the current period and the prior period apart, validates the
// column count and the year relation, and FAILS CLOSED: anything it cannot read with certainty is reported as an
// issue and no number is emitted. Pure functions; no fetching, no storage.

export type KessanMetric = "sales" | "operating_profit" | "ordinary_profit" | "net_profit";

export type KessanValue = { metric: KessanMetric; amount: string | null; changePct: string | null };

export type KessanRow = {
  label: string;
  /** Fiscal year number of the label (2026 for 2026年11月期…), null when the label has none. */
  fiscalYear: number | null;
  values: KessanValue[];
};

export type KessanTable = {
  kind: "results" | "forecast";
  /** 連結 / 個別 (非連結) / unknown — taken from the heading above the table. */
  basis: "consolidated" | "standalone" | "unknown";
  unit: "百万円" | "千円" | "億円" | "円" | null;
  metrics: KessanMetric[];
  rows: KessanRow[];
};

export type KessanFacts = {
  ok: boolean;
  /** Short codes; empty when ok. */
  issues: string[];
  /** Codes for parts that were dropped without failing the facts (e.g. an unreadable forecast row). */
  partialIssues: string[];
  /** The document's own sentence stating the period's results, when it has one (tables may be absent). */
  prose: string | null;
  results: KessanTable | null;
  forecast: KessanTable | null;
  currentRow: KessanRow | null;
  priorRow: KessanRow | null;
};

const MINUS_MARKS = /^[△▲]/u;
const NUMBER = /^[△▲-]?\d[\d,]*(?:\.\d+)?$/u;
const DASH_ONLY = /^[－―—-]$/u;
const PERIOD_LABEL =
  /^(?:(?:20\d{2}|令和\d+)年\d{1,2}月期(?:第[1-4]四半期|中間期|第2四半期(?:\(累計\))?|[1-4]Q|[1-4]Ｑ|通期)?|通期|第2四半期(?:\(累計\))?|中間期|第[1-4]四半期(?:\(累計\))?)(?=\s|$)/u;

const METRIC_PATTERNS: ReadonlyArray<readonly [KessanMetric, RegExp]> = [
  ["sales", /売上高|売上収益|営業収益|経常収益|営業総収入|営業収入/u],
  ["operating_profit", /営業利益|営業損益/u],
  ["ordinary_profit", /経常利益|税引前(?:当期|四半期|中間期)?利益|経常損益/u],
  ["net_profit", /(?:親会社株主|親会社の所有者|親会社)に帰属する(?:当期|四半期|中間期?|半期)?(?:純)?(?:利益|損益)|(?:当期|四半期|中間期?|半期)純(?:利益|損益)|四半期利益|当期利益|中間利益/u],
];

function fiscalYearOf(label: string): number | null {
  const western = label.match(/^(20\d{2})年/u);
  if (western) return Number(western[1]);
  const reiwa = label.match(/^令和(\d+)年/u);
  return reiwa ? 2018 + Number(reiwa[1]) : null;
}

/** "△7.0" / "▲7.0" -> "-7.0"; "12,782" stays; a lone dash -> null. */
function signed(token: string): string | null {
  if (DASH_ONLY.test(token)) return null;
  return token.replace(MINUS_MARKS, "-");
}

function metricsOfHeader(headerText: string): KessanMetric[] {
  // Scan left to right so the order of columns is the order in which the names appear.
  const found: Array<{ at: number; metric: KessanMetric }> = [];
  for (const [metric, pattern] of METRIC_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of headerText.matchAll(new RegExp(pattern.source, flags))) found.push({ at: match.index ?? 0, metric });
  }
  found.sort((a, b) => a.at - b.at);
  const ordered: KessanMetric[] = [];
  for (const { metric } of found) if (!ordered.includes(metric)) ordered.push(metric);
  return ordered;
}

function unitOf(text: string): KessanTable["unit"] {
  if (/百万円/u.test(text)) return "百万円";
  if (/千円/u.test(text)) return "千円";
  if (/億円/u.test(text)) return "億円";
  return null;
}

function basisOf(context: string): KessanTable["basis"] {
  if (/非連結|個別|単体/u.test(context)) return "standalone";
  if (/連結/u.test(context)) return "consolidated";
  return "unknown";
}

function parseRow(line: string, metrics: KessanMetric[], issues: string[], allowExtraTokens: number): KessanRow | null {
  const label = line.match(PERIOD_LABEL)?.[0];
  if (!label) return null;
  const rest = line.slice(label.length).trim();
  const tokens = rest.split(/\s+/u).filter(Boolean);
  const numericLike = tokens.filter((token) => NUMBER.test(token) || DASH_ONLY.test(token));
  const m = metrics.length;
  // A results / forecast row is amount, change%, amount, change%… (2 per metric); some tables list amounts only.
  let pairs: boolean;
  if (numericLike.length >= m * 2 && numericLike.length <= m * 2 + allowExtraTokens) pairs = true;
  else if (numericLike.length === m) pairs = false;
  else {
    // fewer tokens than columns, or surplus tokens (a column was not recognised): never guess
    issues.push(`TOKEN_COUNT_MISMATCH:${label}:${numericLike.length}/${m * 2}`);
    return null;
  }
  const values: KessanValue[] = metrics.map((metric, index) => ({
    metric,
    amount: signed(numericLike[pairs ? index * 2 : index]),
    changePct: pairs ? signed(numericLike[index * 2 + 1]) : null,
  }));
  return { label, fiscalYear: fiscalYearOf(label), values };
}

/** Reads the 経営成績 and 業績予想 tables of a 決算短信 text. Never throws; issues explain what was not readable. */
export function extractKessanTankiFacts(rawText: string): KessanFacts {
  const text = rawText.normalize("NFKC").replaceAll("\u0000", "");
  const lines = text.split(/\r?\n/u).map((line) => line.replace(/[ \t　]+/gu, " ").trim());
  const issues: string[] = [];
  const partial: string[] = [];
  const tables: KessanTable[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!/売上高|売上収益|営業収益|経常収益|営業総収入|営業収入/u.test(lines[index])) continue;
    // header block: this line and the next few until the units line / a period row
    let end = index;
    let headerText = lines[index];
    for (let look = index + 1; look <= Math.min(lines.length - 1, index + 5); look += 1) {
      if (PERIOD_LABEL.test(lines[look])) break;
      headerText += ` ${lines[look]}`;
      end = look;
    }
    const compactHeader = headerText.replace(/\s+/gu, "");
    // Ratio / per-share / cash-flow tables also mention 売上高 and 営業利益 ("売上高営業利益率"); they are not results.
    if (/率|自己資本|総資産|配当性向|キャッシュ|営業活動|セグメント/u.test(compactHeader)) continue;
    const metrics = metricsOfHeader(compactHeader);
    if (metrics.length < 2 || !metrics.includes("sales") || !metrics.includes("operating_profit")) continue;
    const heading = lines.slice(Math.max(0, index - 6), index).join(" ");
    const isForecastHeading = /業績予想/u.test(heading);
    const tableIssues: string[] = [];
    const rows: KessanRow[] = [];
    let cursor = end + 1;
    while (cursor < lines.length && rows.length < 4) {
      const line = lines[cursor];
      if (PERIOD_LABEL.test(line)) {
        // forecast rows may carry one extra token (EPS in yen); results rows must match the columns exactly
        const row = parseRow(line, metrics, tableIssues, isForecastHeading || /^通期|^第2四半期|^中間期/u.test(line) ? 1 : 0);
        if (row) rows.push(row);
        cursor += 1;
        continue;
      }
      if (/^\(注\)|^（注）|^[(（][1-9１-９][)）]|^※|^[1-9]\.|^[１-９]．/u.test(line) && (rows.length > 0 || tableIssues.length > 0)) break;
      if ((rows.length > 0 || tableIssues.length > 0) && !/^[\d,.\s△▲－―—-]+$/u.test(line) && !/^(?:百万円|％|円|銭|\s)+$/u.test(line)) break;
      cursor += 1;
      if (cursor - end > 12) break;
    }
    if (rows.length === 0 && tableIssues.length === 0) continue;
    const before = lines.slice(Math.max(0, index - 4), index + 1).join(" ");
    const kind: KessanTable["kind"] = isForecastHeading || (rows.length > 0 && rows.every((row) => /^通期|^第2四半期|^中間期/u.test(row.label))) ? "forecast" : "results";
    tables.push({
      kind,
      basis: basisOf(`${before} ${heading}`),
      unit: unitOf(`${headerText} ${lines.slice(end + 1, end + 3).join(" ")}`),
      metrics,
      rows,
    });
    // a forecast table that cannot be read is dropped (and noted); a results table that cannot be read fails the facts
    if (tableIssues.length > 0) (kind === "forecast" ? partial : issues).push(...tableIssues);
    index = cursor - 1;
  }

  const results = tables.find((table) => table.kind === "results") ?? null;
  const forecast = tables.find((table) => table.kind === "forecast") ?? null;
  const currentRow = results?.rows[0] ?? null;
  const priorRow = results?.rows[1] ?? null;

  if (!results) issues.push("NO_RESULTS_TABLE");
  else if (!currentRow) issues.push("NO_CURRENT_ROW");
  if (currentRow && priorRow && currentRow.fiscalYear !== null && priorRow.fiscalYear !== null) {
    if (priorRow.fiscalYear !== currentRow.fiscalYear - 1) issues.push("PRIOR_ROW_YEAR_MISMATCH");
  }
  if (currentRow && !priorRow) issues.push("NO_PRIOR_ROW");
  if (results && results.unit === null) issues.push("UNIT_UNKNOWN");
  return { ok: issues.length === 0 && currentRow !== null, issues, partialIssues: partial, results, forecast, currentRow, priorRow, prose: proseHeadline(text) };
}

/** "…の業績は、売上高3,069百万円（前年同四半期比16.5％減）、営業損失54百万円…となりました。" — the document's own wording. */
function proseHeadline(text: string): string | null {
  const joined = text.replace(/\n/gu, "");
  const match = joined.match(/(?:業績|経営成績)[^。]{0,12}は、?\s*(?:売上高|売上収益|営業収益|営業総収入|営業収入)[^。]{0,400}?(?:となりました|でした|となっております)。/u);
  return match ? match[0].replace(/\s+/gu, "").slice(0, 600) : null;
}

const METRIC_JA: Record<KessanMetric, string> = {
  sales: "売上高",
  operating_profit: "営業利益",
  ordinary_profit: "経常利益",
  net_profit: "純利益",
};

function renderRow(row: KessanRow, unit: string | null): string {
  const parts = row.values.map((value) => {
    if (value.amount === null) return `${METRIC_JA[value.metric]}なし(－)`;
    const change = value.changePct === null ? "" : `（前年同期比${value.changePct.startsWith("-") ? "" : "+"}${value.changePct}%）`;
    return `${METRIC_JA[value.metric]}${value.amount}${unit ?? ""}${change}`;
  });
  return `${row.label}: ${parts.join("、")}`;
}

/**
 * Compact, labelled summary of the facts. Returns null unless the current period was read with certainty: a missing
 * or doubtful table must never be replaced by a plausible-looking line.
 */
export function renderKessanFactsSummary(facts: KessanFacts): string | null {
  if (!facts.ok || !facts.results || !facts.currentRow) return null;
  const basis = facts.results.basis === "consolidated" ? "連結" : facts.results.basis === "standalone" ? "個別" : "";
  const unit = facts.results.unit;
  const lines = [
    `【決算短信 数値（表から抽出）】${basis}経営成績（${unit ?? "単位不明"}、％は前年同期比）`,
    `当期 ${renderRow(facts.currentRow, unit)}`,
  ];
  if (facts.priorRow) lines.push(`前期 ${renderRow(facts.priorRow, unit)}`);
  if (facts.forecast) {
    const forecastBasis = facts.forecast.basis === "standalone" ? "個別" : facts.forecast.basis === "consolidated" ? "連結" : "";
    for (const row of facts.forecast.rows) lines.push(`予想 ${forecastBasis}${renderRow(row, facts.forecast.unit ?? unit)}`);
  }
  return lines.join("\n");
}

export type KessanBodyAssessment = {
  /**
   * complete: the results table was read (facts-first body).
   * prose_only: no table in the text, but the document's own results sentence was found (kept verbatim).
   * missing: neither; the body is insufficient and the caller must not present it as the document.
   */
  status: "complete" | "prose_only" | "missing";
  facts: KessanFacts;
  /** Facts first, then the generic keyword summary, within maxChars. null when status is missing. */
  body: string | null;
  issues: string[];
};

/**
 * Composes the body for judgement / generation: table facts first (they are the point of the document), the generic
 * keyword summary after them, within the cap. When the table cannot be read the status is "missing" (or "prose_only")
 * and the caller must treat the body as insufficient rather than silently falling back to the generic summary alone.
 */
export function assessKessanBody(pdfText: string, genericSummary: string | null, maxChars = 6000): KessanBodyAssessment {
  const facts = extractKessanTankiFacts(pdfText);
  const rendered = renderKessanFactsSummary(facts);
  const rest = genericSummary ? `\n\n${genericSummary}` : "";
  if (rendered) {
    return { status: "complete", facts, body: `${rendered}${rest}`.slice(0, maxChars), issues: facts.partialIssues };
  }
  if (facts.prose) {
    return { status: "prose_only", facts, body: `【決算短信 業績の概況（本文の記載）】${facts.prose}${rest}`.slice(0, maxChars), issues: facts.issues };
  }
  return { status: "missing", facts, body: null, issues: facts.issues };
}
