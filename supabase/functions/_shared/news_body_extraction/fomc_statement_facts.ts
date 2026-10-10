// Phase 6 (offline): facts of an FOMC statement from the official federalreserve.gov press-release page.
//
// Finding (2026-10-11): https://www.federalreserve.gov/feeds/press_monetary.xml items carry a title and a link and an
// EMPTY description, so an item such as "Federal Reserve issues FOMC statement" reaches the pipeline as a headline only:
// no decision, no change, no target range, no vote. The official statement page itself is a short public HTML page
// (≈1,100 characters of article text) and holds exactly those facts.
//
// Rights: Federal Reserve Board web content is U.S. government work and may be reproduced with attribution; this module
// still fetches nothing and stores nothing. Pure functions; fail-closed: no decision or no range found => not ok.

export type FedMonetaryItemKind = "statement" | "minutes" | "implementation_note" | "projections" | "other";

export function classifyFedMonetaryTitle(title: string): FedMonetaryItemKind {
  const t = title.normalize("NFKC").toLowerCase();
  if (/issues fomc statement|fomc statement/u.test(t)) return "statement";
  if (/minutes of the federal open market committee|fomc minutes/u.test(t)) return "minutes";
  if (/implementation note/u.test(t)) return "implementation_note";
  if (/economic projections/u.test(t)) return "projections";
  return "other";
}

export type FomcStatementFacts = {
  ok: boolean;
  issues: string[];
  releaseDate: string | null;
  action: "raise" | "lower" | "maintain" | null;
  /** Change of the target range in basis points (0 when maintained); null when not stated. */
  changeBp: number | null;
  rangeLowerPct: number | null;
  rangeUpperPct: number | null;
  rangeText: string | null;
  votesFor: number | null;
  votesAgainst: number | null;
  dissenters: string[];
};

function articleText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ");
  // From the article container to the page footer. (The share buttons sit BEFORE the statement body, so they are not an end marker.)
  const start = /<div[^>]*\bid="article"[^>]*>/iu.exec(stripped);
  let raw = start ? stripped.slice(start.index + start[0].length) : stripped;
  const end = /Last Update:|Return to top|<div[^>]*\bid="footer"|<footer\b/iu.exec(raw);
  if (end) raw = raw.slice(0, end.index);
  return raw
    .replace(/<[^>]*>/gu, " ")
    .replace(/&nbsp;|&#160;/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&#8211;|&ndash;/gu, "–")
    .replace(/&#8217;|&rsquo;/gu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

/** "3-3/4" -> 3.75, "4" -> 4, "1/4" -> 0.25, "3.75" -> 3.75; null when not a number. */
export function parseFedRatePercent(raw: string): number | null {
  const text = raw.trim().replace(/[–—]/gu, "-");
  const mixed = text.match(/^(\d+)-(\d+)\/(\d+)$/u);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const fraction = text.match(/^(\d+)\/(\d+)$/u);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return /^\d+(?:\.\d+)?$/u.test(text) ? Number(text) : null;
}

const RATE = String.raw`(\d+(?:-\d+\/\d+|\/\d+|\.\d+)?)`;

export function extractFomcStatementFacts(html: string): FomcStatementFacts {
  const text = articleText(html);
  const issues: string[] = [];
  const releaseDate = text.match(/\b((?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})\b/u)?.[1] ?? null;

  let action: FomcStatementFacts["action"] = null;
  if (/decided to raise the target range/iu.test(text)) action = "raise";
  else if (/decided to (?:lower|reduce|cut) the target range/iu.test(text)) action = "lower";
  else if (/decided to (?:maintain|keep|leave)[^.]{0,60}target range|target range[^.]{0,60}unchanged/iu.test(text)) action = "maintain";

  const range = new RegExp(`target range[^.]{0,120}?(?:to|at)\\s+${RATE}\\s+to\\s+${RATE}\\s+percent`, "iu").exec(text) ??
    new RegExp(`${RATE}\\s+to\\s+${RATE}\\s+percent`, "iu").exec(text);
  const rangeLowerPct = range ? parseFedRatePercent(range[1]) : null;
  const rangeUpperPct = range ? parseFedRatePercent(range[2]) : null;

  let changeBp: number | null = null;
  const pp = text.match(/by\s+(\d+(?:\/\d+|\.\d+)?)\s+percentage points?/iu);
  const bp = text.match(/by\s+(\d+)\s+basis points?/iu);
  if (pp) {
    const value = parseFedRatePercent(pp[1]);
    changeBp = value === null ? null : Math.round(value * 100);
  } else if (bp) changeBp = Number(bp[1]);
  else if (action === "maintain") changeBp = 0;

  let votesFor: number | null = null;
  let votesAgainst: number | null = null;
  const vote = text.match(/(?:by\s+a\s+)?(\d{1,2})\s*[–-]\s*(\d{1,2})\s+vote/iu);
  if (vote) {
    votesFor = Number(vote[1]);
    votesAgainst = Number(vote[2]);
  } else if (/by unanimous vote|unanimously/iu.test(text)) {
    votesAgainst = 0;
  }
  const dissenters: string[] = [];
  const against = text.match(/Voting against (?:this action|the action|these actions)? ?(?:was|were)[:\s]+([^.]+?)\./iu);
  if (against) {
    for (const part of against[1].split(/,| and /u)) {
      const name = part.replace(/\bwho preferred.*$/iu, "").trim();
      if (name.length > 2 && name.length < 60) dissenters.push(name);
    }
    if (votesAgainst === null) votesAgainst = dissenters.length;
  }

  if (action === null) issues.push("NO_DECISION_FOUND");
  if (rangeLowerPct === null || rangeUpperPct === null) issues.push("NO_TARGET_RANGE");
  else if (rangeUpperPct <= rangeLowerPct) issues.push("RANGE_NOT_ASCENDING");
  if ((action === "raise" || action === "lower") && changeBp === null) issues.push("CHANGE_SIZE_UNKNOWN");
  if (action === "raise" && changeBp !== null && changeBp <= 0) issues.push("CHANGE_SIGN_MISMATCH");
  return {
    ok: issues.length === 0,
    issues,
    releaseDate,
    action,
    changeBp,
    rangeLowerPct,
    rangeUpperPct,
    rangeText: range ? `${range[1]} to ${range[2]} percent` : null,
    votesFor,
    votesAgainst,
    dissenters,
  };
}

const ACTION_JA: Record<NonNullable<FomcStatementFacts["action"]>, string> = {
  raise: "引き上げ",
  lower: "引き下げ",
  maintain: "据え置き",
};

/** One labelled block of facts for the judgement context; null unless the decision and the range are both certain. */
export function renderFomcStatementSummary(facts: FomcStatementFacts, officialUrl: string | null = null): string | null {
  if (!facts.ok || facts.action === null || facts.rangeLowerPct === null || facts.rangeUpperPct === null) return null;
  const change = facts.action === "maintain" ? "変更なし" : `${facts.changeBp}bp${ACTION_JA[facts.action]}`;
  const vote = facts.votesFor !== null && facts.votesAgainst !== null
    ? `票決 賛成${facts.votesFor}・反対${facts.votesAgainst}`
    : facts.votesAgainst === 0 ? "全会一致" : "票決数の記載なし";
  const lines = [
    `【FOMC声明（公式ページから抽出）】${facts.releaseDate ?? "日付不明"}`,
    `政策金利（FF金利誘導目標レンジ）: ${facts.rangeLowerPct}〜${facts.rangeUpperPct}%（${ACTION_JA[facts.action]}、${change}）`,
    vote + (facts.dissenters.length > 0 ? `（反対: ${facts.dissenters.join("、")}）` : ""),
  ];
  if (officialUrl) lines.push(`出典: ${officialUrl}`);
  return lines.join("\n");
}
