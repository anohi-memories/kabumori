// Ministry of Finance Japan -- JGB yield data (国債金利情報) adapter.
//
// MOF publishes the same table in two Shift-JIS CSV files (both confirmed by
// direct fetch, 2026-10-01):
//   current  .../interest_rate/jgbcm.csv           the latest month, one row per
//                                                   business day, updated daily
//   all      .../interest_rate/data/jgbcm_all.csv  history since 1974, extended
//                                                   only about once a month
// Line 0 is a title/unit line, line 1 is the real header
// ("基準日,1年,2年,...,40年"), data rows use Japanese era-based dates (e.g.
// "S49.9.24" = Showa 49, "R8.8.31" = Reiwa 8) and "-" for a maturity with no
// quoted yield that day. The current file ends with a blank-cell row and a
// "※..." note row.
//
// Until 2026-10 this adapter read only the history file. Its newest row was
// 2026-08-31 while the current file already had 2026-09-30, so Production
// JGB2Y/JGB10Y stayed a month old (observation_status 'stale') although every
// fetch "succeeded". Both files are now read and merged BY OBSERVATION DATE:
// no file name, month in the title, or today's date is trusted, so it does
// not matter whether the current file holds the previous or the new month
// around a month boundary.
import type { NormalizedMarketMetric } from "./mic_normalize_logic.ts";

export const MOF_JGB_CURRENT_CSV_URL = "https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv";
export const MOF_JGB_ALL_CSV_URL = "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv";
// Kept under its original name: the history file.
export const MOF_JGB_CSV_URL = MOF_JGB_ALL_CSV_URL;
export const MOF_SOURCE_KEY = "mof_jgb";

export class MofAdapterError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "MofAdapterError";
  }
}

export type MofMaturityMapping = { columnHeader: string; metricKey: string };

export const MOF_MATURITY_MAPPINGS: MofMaturityMapping[] = [
  { columnHeader: "2年", metricKey: "JGB2Y" },
  { columnHeader: "10年", metricKey: "JGB10Y" },
];

// MOF publishes a confirmed daily reference yield with roughly a one-day lag.
const MOF_EXPECTED_DELAY_MINUTES = 24 * 60;

// Japanese era start years (the year the era's "1st year" began).
// Meiji 1 = 1868, Taisho 1 = 1912, Showa 1 = 1926, Heisei 1 = 1989, Reiwa 1 = 2019.
const ERA_BASE_YEAR: Record<string, number> = { M: 1867, T: 1911, S: 1925, H: 1988, R: 2018 };

export function parseMofEraDate(raw: string): string {
  const match = raw.trim().match(/^([MTSHR])(\d{1,2})\.(\d{1,2})\.(\d{1,2})$/);
  if (!match) {
    throw new MofAdapterError("MOF_INVALID_DATE", `unexpected date format: ${raw}`);
  }
  const [, era, yearStr, monthStr, dayStr] = match;
  const baseYear = ERA_BASE_YEAR[era];
  const year = baseYear + Number(yearStr);
  const month = monthStr.padStart(2, "0");
  const day = dayStr.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type ParsedMofCsv = { headers: string[]; rows: string[][] };

export function parseMofJgbCsv(text: string): ParsedMofCsv {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 3) {
    throw new MofAdapterError("MOF_MALFORMED_CSV", `too few lines: ${lines.length}`);
  }
  const headers = lines[1].split(",");
  if (headers[0] !== "基準日") {
    throw new MofAdapterError("MOF_UNEXPECTED_HEADER", `expected 基準日 as first column, got: ${lines[1]}`);
  }
  const rows = lines.slice(2).map((line) => line.split(","));
  return { headers, rows };
}

export type MofObservation = { metricKey: string; date: string; value: number };

export type MofSourceFile = "current" | "all";
export type MofDatedObservation = MofObservation & { sourceFile: MofSourceFile };

function isRealIsoDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

// Every valid (date, value) pair of one file for the mapped maturities. A row
// is skipped, never fatal, when its date is not a real era date (blank row,
// "※" note row, typo) or its cell is missing ("-", empty) or not a plain
// decimal number. A missing mapped column is fatal for that file.
export function collectMofObservations(
  parsed: ParsedMofCsv,
  mappings: MofMaturityMapping[] = MOF_MATURITY_MAPPINGS,
  sourceFile: MofSourceFile = "all",
): MofDatedObservation[] {
  const results: MofDatedObservation[] = [];
  for (const mapping of mappings) {
    const columnIndex = parsed.headers.indexOf(mapping.columnHeader);
    if (columnIndex === -1) {
      throw new MofAdapterError("MOF_COLUMN_NOT_FOUND", `column not found: ${mapping.columnHeader}`);
    }
    for (const row of parsed.rows) {
      let date: string;
      try {
        date = parseMofEraDate(row[0] ?? "");
      } catch {
        continue;
      }
      if (!isRealIsoDate(date)) continue;
      const raw = row[columnIndex]?.trim();
      if (raw === undefined || !/^\d+(?:\.\d+)?$/.test(raw)) continue;
      results.push({ metricKey: mapping.metricKey, date, value: Number(raw), sourceFile });
    }
  }
  return results;
}

// Newest observation per metric across both files, chosen by observation date
// only. For the same date the current file wins over the history file (it is
// the one MOF updates daily). `latestAllowedDate` drops rows dated in the
// future, so one mistyped date cannot become "the latest".
export function mergeLatestMofObservations(
  fromAll: readonly MofDatedObservation[],
  fromCurrent: readonly MofDatedObservation[],
  mappings: MofMaturityMapping[] = MOF_MATURITY_MAPPINGS,
  latestAllowedDate?: string,
): MofDatedObservation[] {
  const byMetric = new Map<string, Map<string, MofDatedObservation>>();
  // History first, then current: a later insert for the same date replaces it.
  for (const observation of [...fromAll, ...fromCurrent]) {
    if (latestAllowedDate && observation.date > latestAllowedDate) continue;
    const byDate = byMetric.get(observation.metricKey) ?? new Map<string, MofDatedObservation>();
    byDate.set(observation.date, observation);
    byMetric.set(observation.metricKey, byDate);
  }
  const results: MofDatedObservation[] = [];
  for (const mapping of mappings) {
    const byDate = byMetric.get(mapping.metricKey);
    if (!byDate || byDate.size === 0) continue;
    const latestDate = [...byDate.keys()].sort().at(-1)!;
    results.push(byDate.get(latestDate)!);
  }
  return results;
}

// Newest non-missing value per mapped maturity within ONE parsed file.
export function latestMofObservations(
  parsed: ParsedMofCsv,
  mappings: MofMaturityMapping[] = MOF_MATURITY_MAPPINGS,
): MofObservation[] {
  return mergeLatestMofObservations(collectMofObservations(parsed, mappings, "all"), [], mappings)
    .map(({ metricKey, date, value }) => ({ metricKey, date, value }));
}

// What happened to each file in this fetch: "ok", "empty" (readable, but no
// usable row -- e.g. a new month's file before its first business day) or
// "failed:<CODE>". Stored in each metric's metadata so a run that completed
// on one file only is visible afterwards.
export type MofFetchSummary = { current: string; all: string };

export function normalizeMofObservation(
  observation: MofObservation & { sourceFile?: MofSourceFile },
  fetchedAt: Date,
  fetchSummary?: MofFetchSummary,
): NormalizedMarketMetric {
  const sourceFile = observation.sourceFile ?? "all";
  return {
    metricKey: observation.metricKey,
    value: observation.value,
    unit: "percent",
    // MOF's CSV gives only a calendar date (era-dated), never a time of
    // day. Per Phase 1A review, this is not converted into a fabricated
    // timestamp (e.g. "15:00 JST") -- observedAt stays null and
    // timePrecision is "date".
    observedDate: observation.date,
    observedAt: null,
    timePrecision: "date",
    fetchedAt: fetchedAt.toISOString(),
    sourceKey: MOF_SOURCE_KEY,
    provider: "MOF",
    sourceUrl: sourceFile === "current" ? MOF_JGB_CURRENT_CSV_URL : MOF_JGB_ALL_CSV_URL,
    isDelayed: true,
    delayMinutes: MOF_EXPECTED_DELAY_MINUTES,
    qualityTier: "official",
    isOfficial: true,
    metadata: {
      mofDate: observation.date,
      mofSourceFile: sourceFile,
      ...(fetchSummary
        ? {
          mofFetch: fetchSummary,
          // True when one of the two files could not be read at all.
          mofPartial: fetchSummary.current.startsWith("failed") || fetchSummary.all.startsWith("failed"),
        }
        : {}),
    },
  };
}

export type FetchMofJgbMetricsParams = {
  mappings?: MofMaturityMapping[];
  fetchedAt?: Date;
  timeoutMs?: number;
};

type MofFileOutcome =
  | { status: "ok"; observations: MofDatedObservation[] }
  | { status: "empty" }
  | { status: "failed"; code: string; detail: string };

// Never throws: every problem with one file becomes that file's outcome.
async function loadMofFile(
  url: string,
  sourceFile: MofSourceFile,
  mappings: MofMaturityMapping[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<MofFileOutcome> {
  let text: string;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "failed", code: "MOF_HTTP_ERROR", detail: `status=${response.status}` };
    }
    text = new TextDecoder("shift-jis").decode(await response.arrayBuffer());
  } catch (error) {
    return { status: "failed", code: "MOF_FETCH_FAILED", detail: String(error) };
  }
  try {
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
    // Title + header and nothing else: a valid file with no rows yet.
    if (lines.length === 2 && lines[1].split(",")[0] === "基準日") return { status: "empty" };
    const observations = collectMofObservations(parseMofJgbCsv(text), mappings, sourceFile);
    return observations.length > 0 ? { status: "ok", observations } : { status: "empty" };
  } catch (error) {
    const code = error instanceof MofAdapterError ? error.code : "MOF_MALFORMED_CSV";
    return { status: "failed", code, detail: error instanceof Error ? error.message : String(error) };
  }
}

const describeOutcome = (outcome: MofFileOutcome) =>
  outcome.status === "failed" ? `failed:${outcome.code}` : outcome.status;

// Contract when one file is unavailable:
//   current ok     / all failed -> use the current file (metadata.mofPartial = true)
//   current failed / all ok     -> use the history file as a fallback (mofPartial =
//                                  true). Its newest row can be a month old; nothing
//                                  here calls that "fresh" -- the metric keeps its
//                                  real observation date and the observation-freshness
//                                  view classifies it by that date.
//   current empty  / all ok     -> history file (not a failure: no rows yet)
//   both failed                 -> the run fails (MOF_FETCH_FAILED / MOF_HTTP_ERROR / ...)
//   no usable row in either     -> the run fails (MOF_NO_VALID_OBSERVATION)
export async function fetchMofJgbMetrics(
  params: FetchMofJgbMetricsParams = {},
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  const mappings = params.mappings ?? MOF_MATURITY_MAPPINGS;
  const timeoutMs = params.timeoutMs ?? 20_000;
  const fetchedAt = params.fetchedAt ?? new Date();
  const [current, all] = await Promise.all([
    loadMofFile(MOF_JGB_CURRENT_CSV_URL, "current", mappings, timeoutMs, fetchImpl),
    loadMofFile(MOF_JGB_ALL_CSV_URL, "all", mappings, timeoutMs, fetchImpl),
  ]);
  if (current.status === "failed" && all.status === "failed") {
    throw new MofAdapterError(current.code, `current: ${current.detail}; all: ${all.code}: ${all.detail}`);
  }
  // Japan is ahead of UTC, so a row dated "tomorrow" in UTC terms is possible;
  // anything later is a bad date.
  const latestAllowedDate = new Date(fetchedAt.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const observations = mergeLatestMofObservations(
    all.status === "ok" ? all.observations : [],
    current.status === "ok" ? current.observations : [],
    mappings,
    latestAllowedDate,
  );
  const fetchSummary: MofFetchSummary = { current: describeOutcome(current), all: describeOutcome(all) };
  if (observations.length === 0) {
    throw new MofAdapterError(
      "MOF_NO_VALID_OBSERVATION",
      `no observations found for the configured mappings (current=${fetchSummary.current}, all=${fetchSummary.all})`,
    );
  }
  return observations.map((observation) => normalizeMofObservation(observation, fetchedAt, fetchSummary));
}
