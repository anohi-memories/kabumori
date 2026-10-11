// Does the stored text of an earnings report contain the current period's results row?
//
// In the first table of a 決算短信 ("経営成績"), the rows are labelled by period (2026年7月期 ...). When the extraction
// drops the first data row, only the prior period's figures remain, and any reader (a model or a person) sees last year's
// numbers under this year's title. The check compares the period in the title with the period of the first row label.
//
// Pure string analysis. It reports what is present; it does not extract numbers.

export type CurrentRowStatus =
  | "current_row_present"   // the first row is labelled with the title's period
  | "prior_period_only"     // the first row is an earlier period: the current row is missing
  | "no_table"              // no 経営成績 table in the stored text
  | "unclear";              // a period could not be read from the title or the row

const FULL = (text: string) => text.normalize("NFKC");

/** Western year and month of a fiscal period, accepting 令和N年M月期. Null when none is present. */
export function periodOf(text: string): { year: number; month: number } | null {
  const t = FULL(text);
  const west = t.match(/(\d{4})年\s*(\d{1,2})月期/);
  if (west) return { year: Number(west[1]), month: Number(west[2]) };
  const reiwa = t.match(/令和\s*(\d{1,2})年\s*(\d{1,2})月期/);
  if (reiwa) return { year: 2018 + Number(reiwa[1]), month: Number(reiwa[2]) };
  return null;
}

/** Funds, ETFs and REITs report in a different format; they are not part of this check. */
export function isOperatingCompanyReport(title: string): boolean {
  return !/(REIT|ＲＥＩＴ|ETF|ＥＴＦ|上場投信|ファンド|投資法人|インデックス|ＥＴＮ|信託)/i.test(FULL(title));
}

/**
 * The table that carries the rows: a "経営成績" mention followed, within the next 400 characters, by a revenue header and a
 * period label. A mention in the table of contents ("（１）経営成績に関する説明 ……… 2") has no period label after it.
 */
function resultsTableWindow(normalised: string): string | null {
  for (const match of normalised.matchAll(/経営成績/g)) {
    const slice = normalised.slice(match.index!, match.index! + 400);
    if (/売上高|営業収益|経常収益/.test(slice) && periodOf(slice) !== null) return slice;
  }
  return null;
}

export function currentRowStatus(title: string, body: string): CurrentRowStatus {
  const target = periodOf(title);
  const normalised = FULL(body);
  if (!/経営成績/.test(normalised)) return "no_table";
  const window = resultsTableWindow(normalised);
  const first = window === null ? null : periodOf(window);
  if (target === null || first === null) return "unclear";
  if (first.year === target.year && first.month === target.month) return "current_row_present";
  if (first.year < target.year || (first.year === target.year && first.month < target.month)) return "prior_period_only";
  return "unclear";
}
