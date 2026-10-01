// Deterministic hard-fact guards for the shared market analysis. Pure: no I/O.
//
// The relationship `metric -> session_date -> value / change` comes from the immutable
// market_data_packet and is authoritative. These guards read generated text and reject wording that
// breaks it: a value attached to another metric, a value presented under another session's date
// (2026-10-01: the 9/29 Nikkei close and the 9/30 1306 close shown together as "9月30日"), a direction
// opposite to the day change, and a stale value without its date. They do not rely on the model Fact
// checker. (Unscoped "no material" claims are in _shared/absence_claims.ts, shared with the app layer.)

import type { AnalysisInput, MetricFact } from "./analysis_input.ts";

const METRIC_ALIASES: Record<string, string[]> = {
  nikkei225: ["日経平均株価", "日経平均", "日経225"],
  topix_proxy_1306: ["TOPIX連動ETF(1306)", "TOPIX連動型ETF(1306)", "TOPIX連動型ETF", "TOPIX連動ETF"],
  dow: ["NYダウ", "ダウ工業株30種平均", "ダウ平均"],
  sp500: ["S&P500", "S&P 500"],
  nasdaq_composite: ["ナスダック総合指数", "ナスダック総合", "ナスダック"],
  sox: ["フィラデルフィア半導体株指数(SOX)", "フィラデルフィア半導体株指数", "半導体株指数", "SOX"],
  usdjpy: ["ドル円", "円相場", "為替"],
  us2y: ["米国2年債利回り", "米2年債利回り"],
  us10y: ["米国10年債利回り", "米10年債利回り", "米長期金利"],
  jgb2y: ["日本国債2年利回り"],
  jgb10y: ["日本国債10年利回り"],
  wti: ["WTI原油", "WTI"],
  brent: ["ブレント原油", "ブレント"],
};

/** Words for a whole market: checked against all of its metrics. */
const GROUP_ALIASES: Array<{ aliases: string[]; keys: string[] }> = [
  { aliases: ["米国株式市場", "米国市場", "米国株", "米株", "主要3指数"], keys: ["dow", "sp500", "nasdaq_composite"] },
  { aliases: ["東京株式市場", "東京市場", "日本市場", "日本株"], keys: ["nikkei225", "topix_proxy_1306"] },
];
/** 「東京は上昇」 means the Tokyo market; 「東京エレクトロンは下落」 is a company. Only the bare word counts. */
const TOKYO_ALONE = /(?<![一-龠ァ-ヶA-Za-z])東京(?=[はもがで、])/gu;
/** A longer name that only looks like an alias: 日経平均先物 is another instrument, 欧米株 is not US stocks. */
const NOT_AN_ALIAS: Array<{ alias: string; before?: RegExp; after?: RegExp }> = [
  { alias: "日経平均", after: /^先物/u },
  { alias: "米株", before: /欧$/u },
  { alias: "米国株", before: /欧$/u },
];

/** Metrics of one market share a session; a date written for one market does not date another. */
const MARKET_OF: Record<string, string> = {
  nikkei225: "tokyo", topix_proxy_1306: "tokyo",
  dow: "us", sp500: "us", nasdaq_composite: "us", sox: "us", us2y: "us", us10y: "us",
  usdjpy: "fx", jgb2y: "jgb", jgb10y: "jgb", wti: "oil", brent: "oil",
};
/** After one of these the sentence turns to another subject. */
const CONTRAST = /でも|ですが|ましたが|だが|ものの|一方|に対し|のに|けれど/u;

const CODE_1306 = /(?<![\d,.])1306(?![\d,.])/g;
const DATE = /(\d{1,2})月(\d{1,2})日/g;
const NUMBER = /([+\-−▲▼±]?)(\d+(?:,\d{3})*(?:\.\d+)?)(%|円|ドル)?/g;
const LIST_GAP = /^[、・,とや\s]*(?:および|及び)?[、・,とや\s]*$/u;
const UP_WORD = /上昇|(?<![利きし])上げ|上が[っりる]|値上がり|反発|続伸|プラス/u;
const DOWN_WORD = /下落|(?<![利きし])下げ|下が[っりる]|値下がり|反落|続落|マイナス/u;
/** A question or condition about a move is not a statement that it happened. */
const HYPOTHETICAL = /かどうか|するか|続くか|なるか|すれば|した場合|する場合|となれば|なら(?:ば)?[、。]?/u;
const STALE_MARKER = /時点|最新ではありません|古い値/u;

type Mention = { keys: string[]; start: number; end: number };

function normalize(text: string): string {
  return text.normalize("NFKC");
}

export function numericTokens(value: string): string[] {
  return (normalize(value).match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []).map((token) => token.replace(/,/g, "").replace(/^0+(?=\d)/, ""));
}

function mentions(sentence: string, facts: Map<string, MetricFact>): Mention[] {
  const found: Mention[] = [];
  const add = (alias: string, keys: string[]) => {
    const needle = normalize(alias);
    const excluded = NOT_AN_ALIAS.filter((rule) => rule.alias === alias);
    for (let at = sentence.indexOf(needle); at >= 0; at = sentence.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (excluded.some((rule) => rule.before?.test(sentence.slice(0, at)) || rule.after?.test(sentence.slice(end)))) continue;
      found.push({ keys, start: at, end });
    }
  };
  for (const [key, aliases] of Object.entries(METRIC_ALIASES)) if (facts.has(key)) for (const alias of aliases) add(alias, [key]);
  for (const group of GROUP_ALIASES) {
    const keys = group.keys.filter((key) => facts.has(key));
    if (keys.length > 0) for (const alias of group.aliases) add(alias, keys);
  }
  if (facts.has("topix_proxy_1306")) {
    for (const match of sentence.matchAll(CODE_1306)) found.push({ keys: ["topix_proxy_1306"], start: match.index, end: match.index + 4 });
  }
  const tokyo = GROUP_ALIASES[1].keys.filter((key) => facts.has(key));
  if (tokyo.length > 0) {
    for (const match of sentence.matchAll(TOKYO_ALONE)) found.push({ keys: tokyo, start: match.index, end: match.index + 2 });
  }
  // Longest match first at each position; overlapping shorter matches are dropped.
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const kept: Mention[] = [];
  for (const mention of found) if (kept.length === 0 || mention.start >= kept[kept.length - 1].end) kept.push(mention);
  // "NYダウ、S&P500、ナスダック総合" is one subject: merge mentions separated only by list punctuation.
  const merged: Mention[] = [];
  for (const mention of kept) {
    const previous = merged[merged.length - 1];
    if (previous && LIST_GAP.test(sentence.slice(previous.end, mention.start))) {
      previous.keys = [...new Set([...previous.keys, ...mention.keys])];
      previous.end = mention.end;
    } else {
      merged.push({ ...mention });
    }
  }
  return merged;
}

/** Text up to the first 、 outside parentheses: what is said about the subject just before it. */
function firstClause(text: string): string {
  const contrast = text.search(CONTRAST);
  if (contrast >= 0) text = text.slice(0, contrast);
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "、" && depth === 0) return text.slice(0, index);
  }
  return text;
}

function directionIn(clause: string): 1 | -1 | null {
  if (HYPOTHETICAL.test(clause)) return null;
  const suffix = clause.match(/^(高|安)(?![いくけ値])/u);
  if (suffix) return suffix[1] === "高" ? 1 : -1;
  const up = clause.search(UP_WORD);
  const down = clause.search(DOWN_WORD);
  if (up < 0 && down < 0) return null;
  return down < 0 || (up >= 0 && up < down) ? 1 : -1;
}

function quote(sentence: string): string {
  const trimmed = sentence.trim();
  const characters = Array.from(trimmed);
  return `「${characters.length > 44 ? `${characters.slice(0, 44).join("")}…` : trimmed}」`;
}

function sentences(text: string): string[] {
  return normalize(text).split(/[。!?\n]/u).map((part) => part.trim()).filter(Boolean);
}

export type GuardTexts = {
  /** Statements about what happened: every guard applies. */
  factual: string[];
  /** Forward-looking text (watch points, risks): direction words there are not statements of fact. */
  forward: string[];
};

/**
 * Hard-fact issues in generated text. Each issue quotes the sentence so a regeneration can fix it and
 * the diagnostics keep what was wrong.
 */
export function metricFactIssues(texts: GuardTexts, input: AnalysisInput): string[] {
  const facts = new Map(input.metricFacts.map((fact) => [fact.key, fact]));
  const tokensOf = (fact: MetricFact) => new Set([...numericTokens(fact.valueDisplay), ...numericTokens(fact.changeDisplay ?? "")]);
  const ownTokens = new Map(input.metricFacts.map((fact) => [fact.key, tokensOf(fact)]));
  const changeTokens = new Map(input.metricFacts.map((fact) => [fact.key, new Set(numericTokens(fact.changeDisplay ?? ""))]));
  const universe = new Set([...ownTokens.values()].flatMap((tokens) => [...tokens]));
  const newsTokens = new Set(input.news.flatMap((item) => numericTokens(`${item.headline_ja} ${item.summary_ja ?? ""}`)));
  const issues: string[] = [];

  const check = (text: string, statesFacts: boolean) => {
    for (const sentence of sentences(text)) {
      const dates = [...sentence.matchAll(DATE)].map((match) => ({ at: match.index, ja: `${Number(match[1])}月${Number(match[2])}日` }));
      const found = mentions(sentence, facts);
      found.forEach((mention, index) => {
        const members = mention.keys.map((key) => facts.get(key)!);
        const label = members.map((fact) => fact.label).join("・");
        const segment = sentence.slice(mention.end, index + 1 < found.length ? found[index + 1].start : sentence.length);
        // A list subject ("AとBがそれぞれ…、…") spends the whole segment; a single subject only its clause.
        const scope = members.length > 1 ? segment : firstClause(segment);
        const undated = scope.replace(DATE, (date) => " ".repeat(date.length));
        const allowed = new Set(mention.keys.flatMap((key) => [...ownTokens.get(key)!]));
        let statesValue = false;
        for (const match of undated.matchAll(NUMBER)) {
          const valueLike = match[2].includes(".") || match[2].includes(",") || Boolean(match[3]);
          if (!valueLike) continue;
          const token = match[2].replace(/,/g, "").replace(/^0+(?=\d)/, "");
          if (allowed.has(token)) {
            statesValue = true;
            // The sign printed in front of a day change must be the sign of that change.
            if (members.length === 1 && changeTokens.get(members[0].key)!.has(token) && members[0].changeSign) {
              const printed = /[+]/.test(match[1]) ? 1 : /[-−▲▼]/.test(match[1]) ? -1 : 0;
              if (printed !== 0 && printed !== members[0].changeSign) {
                issues.push(`方向の逆転（前日比の符号が逆）: ${quote(sentence)}（${label}は前日比${members[0].changeDisplay}）`);
              }
            }
          } else if (universe.has(token) && !newsTokens.has(token)) {
            issues.push(`指標と数値の不一致（${label}の値ではない数値 ${match[2]}）: ${quote(sentence)}`);
          }
        }
        const direction = statesFacts ? directionIn(firstClause(segment)) : null;
        if (direction !== null) {
          const signed = members.filter((fact) => fact.changeSign === 1 || fact.changeSign === -1);
          const contradicted = signed.filter((fact) => fact.changeSign !== direction);
          // One metric must agree. A market word (米国株 / 東京市場) is rejected only when none of its metrics agrees.
          if (signed.length > 0 && contradicted.length === signed.length) {
            issues.push(`方向の逆転（${label}は${signed.map((fact) => `前日比${fact.changeDisplay}`).join("・")}）: ${quote(sentence)}`);
          }
        }
        if (!statesValue && direction === null) return;
        // The date that governs this subject: one written inside its own clause, else the nearest before it,
        // unless that date already dated another market's metric ("9月28日の米国市場も…、東京市場は…").
        const inClause = [...firstClause(segment).matchAll(DATE)][0];
        const before = dates.filter((date) => date.at < mention.start).pop();
        const markets = new Set(mention.keys.map((key) => MARKET_OF[key] ?? key));
        const takenByOtherMarket = !!before && found.slice(0, index).some((earlier) =>
          earlier.start > before.at &&
          earlier.keys.some((key) => !markets.has(MARKET_OF[key] ?? key) && facts.get(key)!.dateJa === before.ja)
        );
        const stated = inClause
          ? `${Number(inClause[1])}月${Number(inClause[2])}日`
          : before && !takenByOtherMarket ? before.ja : null;
        if (stated && !members.some((fact) => fact.dateJa === stated)) {
          issues.push(`日付と指標の不一致（${label}は${[...new Set(members.map((fact) => fact.dateJa))].join("・")}の値、本文は${stated}）: ${quote(sentence)}`);
        }
        const stale = members.filter((fact) => fact.freshness === "stale");
        if (statesValue && stale.length > 0 && stale.length === members.length) {
          const dated = stale.every((fact) => sentence.includes(fact.dateJa)) || STALE_MARKER.test(sentence);
          if (!dated) issues.push(`古い値を日付なしで記載（${label}は${stale[0].dateJa}時点）: ${quote(sentence)}`);
        }
      });
    }
  };
  for (const text of texts.factual) check(text, true);
  for (const text of texts.forward) check(text, false);
  return [...new Set(issues)];
}

/** A chart emoji that points the opposite way to every metric it sits with. */
export function emojiDirectionIssues(texts: string[], input: AnalysisInput): string[] {
  const facts = new Map(input.metricFacts.map((fact) => [fact.key, fact]));
  const issues: string[] = [];
  for (const line of texts.flatMap((text) => normalize(text).split(/[。\n]/u))) {
    const up = line.includes("📈");
    const down = line.includes("📉");
    if (up === down) continue;
    const mentioned = mentions(line, facts).flatMap((mention) => mention.keys.map((key) => facts.get(key)!.changeSign));
    const signs = (mentioned.length > 0
      ? mentioned
      : input.sessionViews.map((view) => view.direction === "up" ? 1 : view.direction === "down" ? -1 : null))
      .filter((sign): sign is number => sign === 1 || sign === -1);
    if (signs.length > 0 && signs.every((sign) => sign !== (up ? 1 : -1))) {
      issues.push(`絵文字の向きがデータと逆: ${quote(line)}`);
    }
  }
  return [...new Set(issues)];
}
