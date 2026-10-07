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
/** Every name of a metric or a whole market, longest first (for editorial checks that set the names aside). */
export const MARKET_NAMES: readonly string[] = [
  ...Object.values(METRIC_ALIASES).flat(),
  ...GROUP_ALIASES.flatMap((group) => group.aliases),
].sort((a, b) => b.length - a.length);
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
const HYPOTHETICAL = /かどうか|(?:する|続く|なる)か(?!ら)|すれば|した場合|する場合|となれば|なら(?:ば)?[、。]?/u;
/**
 * What may stand between a move and the question or condition about it for the move itself to be the
 * thing asked (「米国株高が強まるかどうか」「上昇すれば」「米国株安が続くか」): a subject particle and one
 * predicate (kanji then kana). A continuative or a second predicate means the move was stated first and
 * only then a question was added (H1 on PR #79: 「米国株は下落しており次も続くか」「米国株高が強まり波及するかどうか」).
 */
// A continuative copula/verb (「明白で」「定着し」) asserts a premise before the next question.
// The two bounded degree modifiers still describe the predicate being questioned, not another event.
const GOVERNED_BY_QUESTION = /^(?!.*(?:で|し|て|り)$)(?:が|は|も)?(?:一段と|さらに)?[一-龠々ァ-ヶー]{0,6}[ぁ-ん]{0,3}$/u;
const STALE_MARKER = /時点|最新ではありません|古い値/u;
const PAST_FACT = /ました|でした|した(?:[。!?,、]|$)|だった|してい(?:る|ます)/u;
const CURRENT_STALE_PREFIX = /(?:今日|現在|直近)の(?:最新の)?$|最新の$/u;
const CURRENT_STALE_SUFFIX = /(?:が|は)(?:現在|最新)(?:の(?:値|水準))?(?:です|でした|とな)/u;
/**
 * After a direction word, a particle that makes the move a noun the sentence goes on to talk about
 * (「米国株高が…」「米国株高を踏まえ」「上昇の受け止め方」), as opposed to saying that it happened
 * (「上昇しました」「米国株高でした」「米国株高。」).
 */
const REFERRED_MOVE = /^(?:が|を|の|や|へ|は|も|・|など|および|及び|と(?!な)|に(?!な)|で(?!し|す|あ))/u;
/** Non-past wording that says something will be looked at. */
const WATCH_VERB = "(?:見ます|見る(?!と)|見たい|見てい(?:き|く)|確認します|確認する|確認したい|注目|焦点|見極め)";
/** Further moves of the same list: 「米国株高**や半導体株高**が…」. */
const MOVE_LIST = /^(?:(?:や|と|・|および|及び)[一-龠々ァ-ヶーA-Za-z0-9]{1,14}?(?:高|安|上昇|下落))+/u;
/** A noun phrase: kanji, katakana, Latin letters, digits and the joiners の / や / と / ・. No verb can be written with these. */
const NOUN = "[一-龠々ァ-ヶーA-Za-z0-9のやと・]";
/** Where the move shows: 「日本株で」「東京市場には」. */
const PLACE = `(?:${NOUN}{1,16}(?:で|に|へ)(?:は|も)?)?`;
/**
 * The move itself is what will be watched. Read from right after the direction word; a watch phrase
 * somewhere later in the sentence is not enough (K2 on PR #79: 「米国株高が続き、日本株の反応を確認します」
 * says the move continues today and only then adds a watch). Between the move and the watch only noun
 * phrases and particles may stand, so nothing can state that the move is happening.
 *   - 「が（日本株で）どう…か」, then a watch verb.
 *   - 「が（日本株に）続くか / 波及するかどうか」, then a watch verb.
 *   - 「の受け止め方 / の影響 / の波及 / への反応（を）」 directly followed by the watch verb.
 *   - 「を踏まえ（て）/ を受け（て）、日本株の反応を」 followed by the watch verb (H1 on PR #79: 「前夜の米国株高を
 *     受け、日本株の反応を見る」).
 *   - 「の流れを（どこで）どう…か」 with the watch verb in the same clause (「米国株高の流れをどう受け止めるかが焦点」).
 *   - 「を受けた動き（流れ・反応…）が続くか / どう…か」, then a watch verb.
 */
const WATCH_RELATION = new RegExp([
  `^が${PLACE}どう[^、。]*?か.*${WATCH_VERB}`,
  `^が${PLACE}(?:続くか(?!ら)|[一-龠々ァ-ヶー]{1,6}(?:する|される|できる)?かどうか).*${WATCH_VERB}`,
  `^(?:の(?:受け止め方?|影響|波及)|への反応)(?:を|に|も|は)?(?:${NOUN}{1,12}(?:を|に|で))?${WATCH_VERB}`,
  `^を(?:踏まえ|受け)て?、?(?:${NOUN}{1,12}(?:の|を|に|で|が|は|も)){0,3}${WATCH_VERB}`,
  `^の流れを?${PLACE}どう[^、。]*?か[^、。]*?${WATCH_VERB}`,
  `^を受けた(?:動き|流れ|買い|売り|反応|値動き|展開)(?:が|は|も)(?:続くか(?!ら)|どう[^、。]*?か)[^、。]*?${WATCH_VERB}`,
].join("|"), "u");
/** The date is the sentence's topic (「10月2日は、…」), not attached to the metric (「10月2日の米国株」). */
const TOPIC_AFTER_DATE = /^(?:は|には)/u;

type Mention = { keys: string[]; start: number; end: number };

function normalize(text: string): string {
  return text.normalize("NFKC");
}

export function numericTokens(value: string): string[] {
  return (normalize(value).match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? []).map((token) => token.replace(/,/g, "").replace(/^0+(?=\d)/, ""));
}

/** Whether the text names a market metric or a whole market (日経平均, 東京市場, 米国株, ドル円, …). */
export function mentionsMarketMetric(text: string, input: AnalysisInput): boolean {
  return mentions(normalize(text), new Map(input.metricFacts.map((fact) => [fact.key, fact]))).length > 0;
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

/** The direction a clause gives its subject, and whether it only refers to that move as a noun. */
function directionUse(clause: string): { direction: 1 | -1 | null; referred: boolean; end: number } {
  const found = directionWord(clause);
  if (!found) return { direction: null, referred: false, end: 0 };
  return { direction: found.direction, referred: REFERRED_MOVE.test(clause.slice(found.end)), end: found.end };
}

/**
 * The direction a clause states, or null when there is none or the move itself is the subject of a
 * question or condition. A question later in the clause does not cancel a move stated before it.
 */
function directionWord(clause: string): { direction: 1 | -1; end: number } | null {
  const found = statedDirection(clause);
  if (!found) return null;
  const question = clause.slice(found.end).search(HYPOTHETICAL);
  if (question >= 0 && GOVERNED_BY_QUESTION.test(clause.slice(found.end, found.end + question))) return null;
  return found;
}

function statedDirection(clause: string): { direction: 1 | -1; end: number } | null {
  const suffix = clause.match(/^(高|安)(?![いくけ値])/u);
  if (suffix) return { direction: suffix[1] === "高" ? 1 : -1, end: 1 };
  const unnegated = (pattern: RegExp) => {
    for (const match of clause.matchAll(new RegExp(pattern.source, "gu"))) {
      if (!/^(?:は|も)?(?:してい(?:ませ|な)|し(?:ません|なかった|ない)|せず)/u.test(clause.slice(match.index + match[0].length))) {
        return { at: match.index, end: match.index + match[0].length };
      }
    }
    return null;
  };
  const up = unnegated(UP_WORD);
  const down = unnegated(DOWN_WORD);
  if (!up && !down) return null;
  return !down || (up && up.at < down.at) ? { direction: 1, end: up!.end } : { direction: -1, end: down!.end };
}

function quote(sentence: string): string {
  const trimmed = sentence.trim();
  const characters = Array.from(trimmed);
  return `「${characters.length > 44 ? `${characters.slice(0, 44).join("")}…` : trimmed}」`;
}

/**
 * Sentences: split at 。!? and line breaks, and at a pictograph that ends a sentence (followed by a space or the end).
 * 2026-10-07 close: 「10月7日の日経平均は70,035.71（前日比−0.92%）でした📉 10月6日の米国市場では…」 was read as one
 * sentence, so the second sentence's date (10月6日) was taken as the Nikkei's date and a correct report was rejected.
 */
function sentences(text: string): string[] {
  return normalize(text).split(/[。!?\n]|\p{Extended_Pictographic}\uFE0F?(?=\s|$)/u).map((part) => part.trim()).filter(Boolean);
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
  const canonical = (token: string) => String(Number(token));
  const tokensOf = (fact: MetricFact) => new Set([...numericTokens(fact.valueDisplay), ...numericTokens(fact.changeDisplay ?? "")].map(canonical));
  const ownTokens = new Map(input.metricFacts.map((fact) => [fact.key, tokensOf(fact)]));
  const valueTokens = new Map(input.metricFacts.map((fact) => [fact.key, new Set(numericTokens(fact.valueDisplay).map(canonical))]));
  const changeTokens = new Map(input.metricFacts.map((fact) => [fact.key, new Set(numericTokens(fact.changeDisplay ?? "").map(canonical))]));
  const universe = new Set([...ownTokens.values()].flatMap((tokens) => [...tokens]));
  const [, tradingMonth, tradingDay] = input.tradingDate.split("-").map(Number);
  const tradingDateJa = `${tradingMonth}月${tradingDay}日`;
  const issues: string[] = [];

  const check = (text: string, statesFacts: boolean) => {
    for (const sentence of sentences(text)) {
      const dates = [...sentence.matchAll(DATE)].map((match) => ({ at: match.index, end: match.index + match[0].length, ja: `${Number(match[1])}月${Number(match[2])}日` }));
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
        const statedMembers = new Set<string>();
        for (const match of undated.matchAll(NUMBER)) {
          const valueLike = match[2].includes(".") || match[2].includes(",") || Boolean(match[3]);
          if (!valueLike) continue;
          const token = canonical(match[2].replace(/,/g, ""));
          if (allowed.has(token)) {
            statesValue = true;
            const matched = members.filter((member) => ownTokens.get(member.key)!.has(token));
            for (const member of matched) statedMembers.add(member.key);
            // A % after a daily-close index is its change, not its absolute level (yield values are %).
            const changeContext = match[3] === "%" && members.every((member) => !member.valueDisplay.includes("%"));
            const valueContext = match[3] === "円" || match[3] === "ドル" || /(?:終値|水準|値)(?:は|が)?\s*$/.test(undated.slice(0, match.index));
            if ((changeContext && !matched.some((member) => changeTokens.get(member.key)!.has(token))) ||
                (valueContext && !matched.some((member) => valueTokens.get(member.key)!.has(token)))) {
              issues.push(`指標と数値の不一致（値と前日比の取り違え）: ${quote(sentence)}`);
            }
            const targets = matched;
            // The sign printed in front of a day change must be the sign of that change.
            for (const target of targets) {
              if (!changeTokens.get(target.key)!.has(token) || !target.changeSign) continue;
              const printed = /[+]/.test(match[1]) ? 1 : /[-−▲▼]/.test(match[1]) ? -1 : 0;
              if (printed !== 0 && printed !== target.changeSign) {
                issues.push(`方向の逆転（前日比の符号が逆）: ${quote(sentence)}（${target.label}は前日比${target.changeDisplay}）`);
              }
            }
          } else if (universe.has(token)) {
            issues.push(`指標と数値の不一致（${label}の値ではない数値 ${match[2]}）: ${quote(sentence)}`);
          }
        }
        const use = statesFacts || PAST_FACT.test(scope) ? directionUse(firstClause(segment)) : { direction: null, referred: false, end: 0 };
        const direction = use.direction;
        if (direction !== null) {
          const signed = members.filter((fact) => fact.changeSign === 1 || fact.changeSign === -1);
          const contradicted = signed.filter((fact) => fact.changeSign !== direction);
          // One metric must agree. A market word (米国株 / 東京市場) is rejected only when none of its metrics agrees.
          const collective = /そろって|全て|すべて|とも|いずれも/.test(scope);
          if (signed.length > 0 && (contradicted.length === signed.length || collective && contradicted.length > 0)) {
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
        const datedMembers = statesValue ? members.filter((fact) => statedMembers.has(fact.key)) : members;
        // 2026-10-02 07:55: 「10月2日は、米国株高が日本株でどう表れるかを見ます」. Today's date is the topic of
        // the sentence and the move is the thing to be watched, so the date does not date the move.
        // Every condition must hold; a value, a change, a statement that the session moved or continues,
        // or a date attached to the metric (「10月2日の米国株」) is still checked.
        const afterMove = sentence.slice(mention.end + use.end).replace(MOVE_LIST, "");
        const watchFrame = !statesValue && use.referred && !inClause && !!before && !takenByOtherMarket &&
          before.ja === tradingDateJa && TOPIC_AFTER_DATE.test(sentence.slice(before.end)) && WATCH_RELATION.test(afterMove);
        if (stated && !watchFrame && (datedMembers.length > 0 && datedMembers.some((fact) => fact.dateJa !== stated))) {
          issues.push(`日付と指標の不一致（${label}は${[...new Set(members.map((fact) => fact.dateJa))].join("・")}の値、本文は${stated}）: ${quote(sentence)}`);
        }
        const stale = members.filter((fact) => fact.freshness === "stale");
        if (statesValue && stale.length > 0 && stale.length === members.length) {
          const dated = stale.every((fact) => sentence.includes(fact.dateJa)) || STALE_MARKER.test(sentence);
          if (!dated) issues.push(`古い値を日付なしで記載（${label}は${stale[0].dateJa}時点）: ${quote(sentence)}`);
          const prefix = sentence.slice(0, mention.start).split("、").pop() ?? "";
          if (CURRENT_STALE_PREFIX.test(prefix) || CURRENT_STALE_SUFFIX.test(firstClause(segment))) {
            issues.push(`古い値を現在・最新として記載（${label}）: ${quote(sentence)}`);
          }
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
  for (const line of texts.flatMap((text) => normalize(text).split(/[。\n、]/u))) {
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
