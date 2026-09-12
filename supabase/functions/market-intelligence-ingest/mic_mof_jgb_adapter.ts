// Ministry of Finance Japan -- JGB yield data (国債金利情報) adapter.
//
// Endpoint confirmed by direct fetch during implementation:
// https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv
// Shift-JIS encoded CSV. Line 0 is a title/unit line, line 1 is the real
// header ("基準日,1年,2年,...,40年"), data rows use Japanese era-based
// dates (e.g. "S49.9.24" = Showa 49, "R8.8.31" = Reiwa 8) and "-" for a
// maturity with no quoted yield that day.
import type { NormalizedMarketMetric } from "./mic_normalize_logic.ts";

export const MOF_JGB_CSV_URL = "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv";
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

// Rows are in ascending date order in the source file; scans from the end
// to find the newest non-missing ("-") value per mapped maturity.
export function latestMofObservations(
  parsed: ParsedMofCsv,
  mappings: MofMaturityMapping[] = MOF_MATURITY_MAPPINGS,
): MofObservation[] {
  const results: MofObservation[] = [];
  for (const mapping of mappings) {
    const columnIndex = parsed.headers.indexOf(mapping.columnHeader);
    if (columnIndex === -1) {
      throw new MofAdapterError("MOF_COLUMN_NOT_FOUND", `column not found: ${mapping.columnHeader}`);
    }
    for (let i = parsed.rows.length - 1; i >= 0; i--) {
      const row = parsed.rows[i];
      const raw = row[columnIndex];
      if (raw === undefined || raw === "-" || raw === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      results.push({ metricKey: mapping.metricKey, date: parseMofEraDate(row[0]), value });
      break;
    }
  }
  return results;
}

export function normalizeMofObservation(observation: MofObservation, fetchedAt: Date): NormalizedMarketMetric {
  return {
    metricKey: observation.metricKey,
    value: observation.value,
    unit: "percent",
    // 15:00 JST (the published reference time for this series) == 06:00 UTC.
    observedAt: `${observation.date}T06:00:00.000Z`,
    fetchedAt: fetchedAt.toISOString(),
    sourceKey: MOF_SOURCE_KEY,
    provider: "MOF",
    sourceUrl: MOF_JGB_CSV_URL,
    isDelayed: true,
    delayMinutes: MOF_EXPECTED_DELAY_MINUTES,
    qualityTier: "official",
    isOfficial: true,
    metadata: { mofDate: observation.date },
  };
}

export type FetchMofJgbMetricsParams = {
  mappings?: MofMaturityMapping[];
  fetchedAt?: Date;
  timeoutMs?: number;
};

export async function fetchMofJgbMetrics(
  params: FetchMofJgbMetricsParams = {},
  fetchImpl: typeof fetch = fetch,
): Promise<NormalizedMarketMetric[]> {
  let response: Response;
  try {
    response = await fetchImpl(MOF_JGB_CSV_URL, { signal: AbortSignal.timeout(params.timeoutMs ?? 20_000) });
  } catch (error) {
    throw new MofAdapterError("MOF_FETCH_FAILED", String(error));
  }
  if (!response.ok) {
    throw new MofAdapterError("MOF_HTTP_ERROR", `status=${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder("shift-jis").decode(buffer);
  const parsed = parseMofJgbCsv(text);
  const observations = latestMofObservations(parsed, params.mappings);
  if (observations.length === 0) {
    throw new MofAdapterError("MOF_NO_VALID_OBSERVATION", "no observations found for the configured mappings");
  }
  const fetchedAt = params.fetchedAt ?? new Date();
  return observations.map((observation) => normalizeMofObservation(observation, fetchedAt));
}
