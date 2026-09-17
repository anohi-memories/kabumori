// Test-only fixtures shaped like real Yahoo chart responses (range=1mo,
// interval=1d) observed on 2026-09-17: daily bars stamped at the session
// open, regularMarketTime at the last trade/close.

export type ChartFixture = {
  symbol: string;
  currency: string;
  timezone: string;
  instrumentType: string;
  regularMarketTime: string;
  bars: Array<[string, number | null]>;
};

export function chart(fixture: ChartFixture): unknown {
  return {
    chart: {
      result: [{
        meta: {
          symbol: fixture.symbol,
          currency: fixture.currency,
          exchangeTimezoneName: fixture.timezone,
          instrumentType: fixture.instrumentType,
          regularMarketTime: Math.floor(Date.parse(fixture.regularMarketTime) / 1000),
        },
        timestamp: fixture.bars.map(([iso]) => Math.floor(Date.parse(iso) / 1000)),
        indicators: { quote: [{ close: fixture.bars.map(([, close]) => close) }] },
      }],
      error: null,
    },
  };
}

/** Tokyo daily bars open at 09:00 JST = 00:00Z. */
export const jpBar = (date: string, close: number | null): [string, number | null] => [`${date}T00:00:00Z`, close];
/** New York daily bars open at 09:30 EDT = 13:30Z (September). */
export const usBar = (date: string, close: number | null): [string, number | null] => [`${date}T13:30:00Z`, close];

export function nikkeiChart(regularMarketTime: string, bars: Array<[string, number | null]>): unknown {
  return chart({ symbol: "^N225", currency: "JPY", timezone: "Asia/Tokyo", instrumentType: "INDEX", regularMarketTime, bars });
}

export function topixEtfChart(regularMarketTime: string, bars: Array<[string, number | null]>): unknown {
  return chart({ symbol: "1306.T", currency: "JPY", timezone: "Asia/Tokyo", instrumentType: "ETF", regularMarketTime, bars });
}

export function usIndexChart(symbol: string, regularMarketTime: string, bars: Array<[string, number | null]>): unknown {
  return chart({ symbol, currency: "USD", timezone: "America/New_York", instrumentType: "INDEX", regularMarketTime, bars });
}

/** Close of 2026-09-16 (Wed): Tokyo closed, NY session of 09-15 complete. */
export const CLOSE_0916 = {
  n225: nikkeiChart("2026-09-16T06:45:00Z", [
    jpBar("2026-09-11", 64011.34), jpBar("2026-09-14", 63492.99), jpBar("2026-09-15", 63484.1), jpBar("2026-09-16", 63923),
  ]),
  etf1306: topixEtfChart("2026-09-16T06:30:00Z", [
    jpBar("2026-09-11", 419.7), jpBar("2026-09-14", 423.3), jpBar("2026-09-15", 421.3), jpBar("2026-09-16", 423.9),
  ]),
  us: (symbol: string) =>
    usIndexChart(symbol, "2026-09-15T20:44:00Z", [
      usBar("2026-09-11", 100), usBar("2026-09-14", 101), usBar("2026-09-15", 102),
    ]),
};

export const MIC_ROWS = [
  { metric_key: "USDJPY", value: "155.05", observed_date: "2026-09-16", observed_at: null, fetched_at: "2026-09-17T00:42:25.339+00:00", provider: "Frankfurter", source_url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY", quality_tier: "trusted_free" },
  { metric_key: "USDJPY", value: "154.38", observed_date: "2026-09-15", observed_at: null, fetched_at: "2026-09-16T00:42:25.339+00:00", provider: "Frankfurter", source_url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY", quality_tier: "trusted_free" },
  { metric_key: "US10Y", value: "5", observed_date: "2026-09-15", observed_at: null, fetched_at: "2026-09-17T01:00:32.101+00:00", provider: "FRED", source_url: "https://fred.stlouisfed.org/series/DGS10", quality_tier: "official" },
  { metric_key: "US2Y", value: "4.67", observed_date: "2026-09-15", observed_at: null, fetched_at: "2026-09-17T01:00:32.101+00:00", provider: "FRED", source_url: "https://fred.stlouisfed.org/series/DGS2", quality_tier: "official" },
  { metric_key: "JGB10Y", value: "2.943", observed_date: "2026-08-31", observed_at: null, fetched_at: "2026-09-16T09:00:04.089+00:00", provider: "MOF", source_url: "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv", quality_tier: "official" },
  { metric_key: "JGB2Y", value: "1.743", observed_date: "2026-08-31", observed_at: null, fetched_at: "2026-09-16T09:00:04.089+00:00", provider: "MOF", source_url: "https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv", quality_tier: "official" },
  { metric_key: "WTI", value: "107.02", observed_date: "2026-09-15", observed_at: null, fetched_at: "2026-09-16T19:00:00.781+00:00", provider: "EIA", source_url: "https://www.eia.gov/dnav/pet/hist/RWTCD.htm", quality_tier: "official" },
  { metric_key: "BRENT", value: "130.8", observed_date: "2026-09-15", observed_at: null, fetched_at: "2026-09-16T19:00:00.781+00:00", provider: "EIA", source_url: "https://www.eia.gov/dnav/pet/hist/RBRTED.htm", quality_tier: "official" },
];

export const MIC_THRESHOLDS = [
  { metric_key: "USDJPY", expected_observation_lag_minutes: 4320 },
  { metric_key: "US2Y", expected_observation_lag_minutes: 4320 },
  { metric_key: "US10Y", expected_observation_lag_minutes: 4320 },
];

export const JPX_HOLIDAYS = new Set(["2026-09-21", "2026-09-22", "2026-09-23"]);
export const NYSE_HOLIDAYS = new Set(["2026-09-07", "2026-11-26", "2026-12-25"]);
