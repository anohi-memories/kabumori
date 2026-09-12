import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchMofJgbMetrics,
  latestMofObservations,
  MofAdapterError,
  parseMofEraDate,
  parseMofJgbCsv,
} from "./mic_mof_jgb_adapter.ts";

// A small fixture mirroring the real file's structure exactly (verified by
// fetching https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv
// during implementation): title/unit line, header line starting with
// 基準日, era-dated rows ("S"=Showa, "R"=Reiwa), "-" for an unquoted maturity.
const HEADER_LINE = "基準日,1年,2年,3年,4年,5年,6年,7年,8年,9年,10年,15年,20年,25年,30年,40年";
const SAMPLE_CSV = [
  "国債金利情報,,,,,,,,,,,,,,,(単位 : %)",
  HEADER_LINE,
  "S49.9.24,10.327,9.362,8.83,8.515,8.348,8.29,8.24,8.121,8.127,-,-,-,-,-,-",
  "R8.8.27,1.461,1.696,1.846,2.037,2.182,2.315,2.452,2.617,2.755,2.897,3.458,3.764,4.052,4.038,4.043",
  "R8.8.28,1.483,1.719,1.872,2.062,2.212,2.345,2.492,2.656,2.791,-,3.497,3.806,4.096,4.084,4.084",
].join("\n");

// Real Shift-JIS bytes captured directly from
// https://www.mof.go.jp/jgbs/reference/interest_rate/data/jgbcm_all.csv
// during implementation (title line, header line, the file's first data
// row, and its two newest rows at the time of capture) -- base64-encoded so
// the fixture is self-contained and portable, while still exercising the
// real TextDecoder("shift-jis") path end to end rather than an ASCII
// stand-in. Decodes to the exact text asserted in the "normal path" test.
const REAL_MOF_CSV_SAMPLE_BASE64 =
  "jZGNwovgl5iP7pXxLCwsLCwsLCwsLCwsLCwsKJJQiMogOiAlKQ0Kiu6PgJP6LDGUTiwylE4sM5ROLDSUTiw1lE4sNpROLDeUTiw4lE4sOZROLDEwlE4sMTWUTiwyMJROLDI1lE4sMzCUTiw0MJRODQpTNDkuOS4yNCwxMC4zMjcsOS4zNjIsOC44Myw4LjUxNSw4LjM0OCw4LjI5LDguMjQsOC4xMjEsOC4xMjcsLSwtLC0sLSwtLC0NClI4LjguMjgsMS40ODMsMS43MTksMS44NzIsMi4wNjIsMi4yMTIsMi4zNDUsMi40OTIsMi42NTYsMi43OTEsMi45MywzLjQ5NywzLjgwNiw0LjA5Niw0LjA4NCw0LjA4NA0KUjguOC4zMSwxLjUwMiwxLjc0MywxLjg5NCwyLjA4NCwyLjIzMywyLjM1OCwyLjUwNywyLjY3LDIuODAxLDIuOTQzLDMuNTAxLDMuODE1LDQuMTAyLDQuMDkyLDQuMDk0DQ==";

function realMofSampleBytes(): ArrayBuffer {
  return Uint8Array.from(atob(REAL_MOF_CSV_SAMPLE_BASE64), (c) => c.charCodeAt(0)).buffer;
}

test("parseMofEraDate converts Showa/Reiwa era dates to Gregorian YYYY-MM-DD", () => {
  assert.equal(parseMofEraDate("S49.9.24"), "1974-09-24");
  assert.equal(parseMofEraDate("R8.8.27"), "2026-08-27");
});

test("parseMofEraDate rejects an unrecognized era or shape", () => {
  assert.throws(() => parseMofEraDate("2026-08-27"), MofAdapterError);
  assert.throws(() => parseMofEraDate("X8.8.27"), MofAdapterError);
});

test("parseMofJgbCsv reads the real header line (skipping the title line) and the data rows", () => {
  const parsed = parseMofJgbCsv(SAMPLE_CSV);
  assert.deepEqual(parsed.headers, HEADER_LINE.split(","));
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0][0], "S49.9.24");
});

test("parseMofJgbCsv rejects a file that doesn't start with 基準日 on line 2", () => {
  assert.throws(() => parseMofJgbCsv(["title", "not,the,header", "row"].join("\n")), MofAdapterError);
});

test("parseMofJgbCsv rejects a file with too few lines", () => {
  assert.throws(() => parseMofJgbCsv("only one line"), MofAdapterError);
});

test("latestMofObservations scans backward past a missing ('-') value to the newest quoted one", () => {
  const parsed = parseMofJgbCsv(SAMPLE_CSV);
  const observations = latestMofObservations(parsed, [{ columnHeader: "10年", metricKey: "JGB10Y" }]);
  // The newest row (R8.8.28) has "-" for 10年; the adapter must fall back
  // to the previous row (R8.8.27, value 2.897) instead of skipping the
  // metric entirely.
  assert.deepEqual(observations, [{ metricKey: "JGB10Y", date: "2026-08-27", value: 2.897 }]);
});

test("latestMofObservations throws when the mapped column header doesn't exist", () => {
  const parsed = parseMofJgbCsv(SAMPLE_CSV);
  assert.throws(
    () => latestMofObservations(parsed, [{ columnHeader: "99年", metricKey: "NOPE" }]),
    MofAdapterError,
  );
});

test("fetchMofJgbMetrics: normal path decodes real Shift-JIS bytes and returns JGB2Y/JGB10Y", async () => {
  const fetchImpl = async () => new Response(realMofSampleBytes(), { status: 200 });
  const metrics = await fetchMofJgbMetrics({ fetchedAt: new Date("2026-09-12T00:00:00.000Z") }, fetchImpl as typeof fetch);
  const jgb10y = metrics.find((m) => m.metricKey === "JGB10Y");
  assert.ok(jgb10y);
  // Newest row in the captured sample (R8.8.31 = 2026-08-31) carries a
  // quoted 10年 value (2.943); the file's first row (S49.9.24) has "-".
  assert.equal(jgb10y!.value, 2.943);
  assert.equal(jgb10y!.observedDate, "2026-08-31");
  assert.equal(jgb10y!.observedAt, null);
  assert.equal(jgb10y!.timePrecision, "date");
  assert.equal(jgb10y!.sourceKey, "mof_jgb");
  assert.equal(jgb10y!.isOfficial, true);
  const jgb2y = metrics.find((m) => m.metricKey === "JGB2Y");
  assert.ok(jgb2y);
  assert.equal(jgb2y!.value, 1.743);
});

test("fetchMofJgbMetrics: non-200 surfaces MOF_HTTP_ERROR", async () => {
  const fetchImpl = async () => new Response("nope", { status: 404 });
  await assert.rejects(() => fetchMofJgbMetrics({}, fetchImpl as typeof fetch), /MOF_HTTP_ERROR/);
});

test("fetchMofJgbMetrics: a fetch-level failure surfaces MOF_FETCH_FAILED", async () => {
  const fetchImpl = async () => {
    throw new Error("connection reset");
  };
  await assert.rejects(() => fetchMofJgbMetrics({}, fetchImpl as typeof fetch), /MOF_FETCH_FAILED/);
});
