// MOF JGB adapter: reading BOTH the current-month file and the history file
// and choosing the newest observation by date (State freshness Stage 0).
// No real network: fetch is routed by URL to fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectMofObservations,
  fetchMofJgbMetrics,
  mergeLatestMofObservations,
  MOF_JGB_ALL_CSV_URL,
  MOF_JGB_CURRENT_CSV_URL,
  MofAdapterError,
  parseMofJgbCsv,
} from "./mic_mof_jgb_adapter.ts";

// Real Shift-JIS bytes of the history file (title, header, first row, and its
// two newest rows R8.8.28 / R8.8.31) -- same capture as mic_mof_jgb_adapter_test.ts.
const REAL_ALL_BASE64 =
  "jZGNwovgl5iP7pXxLCwsLCwsLCwsLCwsLCwsKJJQiMogOiAlKQ0Kiu6PgJP6LDGUTiwylE4sM5ROLDSUTiw1lE4sNpROLDeUTiw4lE4sOZROLDEwlE4sMTWUTiwyMJROLDI1lE4sMzCUTiw0MJRODQpTNDkuOS4yNCwxMC4zMjcsOS4zNjIsOC44Myw4LjUxNSw4LjM0OCw4LjI5LDguMjQsOC4xMjEsOC4xMjcsLSwtLC0sLSwtLC0NClI4LjguMjgsMS40ODMsMS43MTksMS44NzIsMi4wNjIsMi4yMTIsMi4zNDUsMi40OTIsMi42NTYsMi43OTEsMi45MywzLjQ5NywzLjgwNiw0LjA5Niw0LjA4NCw0LjA4NA0KUjguOC4zMSwxLjUwMiwxLjc0MywxLjg5NCwyLjA4NCwyLjIzMywyLjM1OCwyLjUwNywyLjY3LDIuODAxLDIuOTQzLDMuNTAxLDMuODE1LDQuMTAyLDQuMDkyLDQuMDk0DQo=";

// Real Shift-JIS bytes of the current-month file captured 2026-10-01 from
// https://www.mof.go.jp/jgbs/reference/interest_rate/jgbcm.csv : title
// "国債金利情報 (令和8年9月)", header, the month's first row (R8.9.1), its two
// newest rows (R8.9.29 / R8.9.30) and the file's real trailer -- a blank-cell
// row and the "※最新のcsvデータが…" note row.
const REAL_CURRENT_BASE64 =
  "jZGNwovgl5iP7pXxICiX35hhOJROOYyOKSwsLCwsLCwsLCwsLCwsLCiSUIjKIDogJSkNCoruj4CT+iwxlE4sMpROLDOUTiw0lE4sNZROLDaUTiw3lE4sOJROLDmUTiwxMJROLDE1lE4sMjCUTiwyNZROLDMwlE4sNDCUTg0KUjguOS4xLDEuNTI3LDEuODAyLDEuOTUyLDIuMTQsMi4yOCwyLjQxMSwyLjU1OSwyLjcxOCwyLjg0OCwyLjk4NywzLjU0NCwzLjg1OSw0LjE0Myw0LjEzMSw0LjE0NQ0KUjguOS4yOSwxLjY5MiwxLjk3NiwyLjExNiwyLjMwMiwyLjQyNSwyLjU0NSwyLjY2MiwyLjgxOCwyLjk0NiwzLjA4MiwzLjYwMywzLjg4Nyw0LjE0NCw0LjEyNiw0LjEyNw0KUjguOS4zMCwxLjY4NCwxLjk1MiwyLjA4NiwyLjI3MywyLjM5OSwyLjUyNSwyLjYzOSwyLjc5NiwyLjkyNiwzLjA1NywzLjU4MywzLjg3Nyw0LjEzMSw0LjA5OCw0LjA5OQ0KLCwsLCwsLCwsLCwsLCwsDQqBpo3FkFaCzGNzdoNmgVuDXoKqg1+DRYOTg42BW4NogsWCq4LIgqKP6o2HgUGCspeYl3CCzIN1g4mDRYNVgsmCqIKigsSDTIODg2KDVoOFgsyN7Y+cgvCOwI57grWNxJN4g1+DRYOTg42BW4Nogq2CvoKzgqKBQiwsLCwsLCwsLCwsLCwsLA0K";

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// Title + header lines as real Shift-JIS bytes; data rows are ASCII, which is
// identical in Shift-JIS, so synthetic files still go through the real decoder.
function headerBytes(): Uint8Array {
  const all = bytes(REAL_ALL_BASE64);
  let seen = 0;
  for (let i = 0; i < all.length - 1; i++) {
    if (all[i] === 13 && all[i + 1] === 10 && ++seen === 2) return all.slice(0, i + 2);
  }
  throw new Error("fixture header not found");
}

// Columns: 基準日,1年,2年,3年,...,10年,15年,20年,25年,30年,40年 -> "2年" is index 2, "10年" index 10.
function row(date: string, twoYear: string, tenYear: string): string {
  const cells = [date, "1", twoYear, "1", "1", "1", "1", "1", "1", "1", tenYear, "1", "1", "1", "1", "1"];
  return cells.join(",");
}

function csv(rows: string[]): Uint8Array {
  const head = headerBytes();
  const body = new TextEncoder().encode(rows.length > 0 ? rows.join("\r\n") + "\r\n" : "");
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

type Reply = Uint8Array | number | "network";

function mof(current: Reply, all: Reply) {
  const calls: string[] = [];
  const impl = ((url: string) => {
    calls.push(url);
    const reply = url === MOF_JGB_CURRENT_CSV_URL ? current : url === MOF_JGB_ALL_CSV_URL ? all : 404;
    if (reply === "network") return Promise.reject(new TypeError("connection reset"));
    if (typeof reply === "number") return Promise.resolve(new Response("x", { status: reply }));
    const body = reply.buffer.slice(reply.byteOffset, reply.byteOffset + reply.byteLength) as ArrayBuffer;
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const FETCHED_AT = new Date("2026-10-02T06:00:00.000Z");
const get = (metrics: Awaited<ReturnType<typeof fetchMofJgbMetrics>>, key: string) => {
  const metric = metrics.find((m) => m.metricKey === key);
  assert.ok(metric, `${key} missing`);
  return metric;
};

test("negative yields are valid; placeholders, malformed numbers and overflow are not", async () => {
  const m = mof(csv([
    row("R8.9.29", "-0.15", "-0.02"),
    row("R8.9.30", "-", "--0.1"),
    row("R8.10.1", "9".repeat(400), "Infinity"),
  ]), csv([]));
  const metrics = await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl);
  assert.equal(get(metrics, "JGB2Y").value, -0.15);
  assert.equal(get(metrics, "JGB10Y").value, -0.02);
  assert.equal(get(metrics, "JGB2Y").observedDate, "2026-09-29");
  assert.ok(metrics.every((metric) => Number.isFinite(metric.value)));
});

test("UTC/JST allowance rejects tomorrow until midnight JST, then accepts that date", async () => {
  const current = csv([row("R8.10.3", "8", "9")]);
  const history = csv([row("R8.10.2", "1.9", "3.0")]);
  for (const at of ["2026-10-02T06:00:00Z", "2026-10-02T14:59:59Z"]) {
    const m = mof(current, history);
    const metric = get(await fetchMofJgbMetrics({ fetchedAt: new Date(at) }, m.impl), "JGB2Y");
    assert.equal(metric.observedDate, "2026-10-02");
    assert.deepEqual(metric.metadata?.mofFetch, { current: "empty", all: "ok" });
  }
  const m = mof(current, history);
  assert.equal(get(await fetchMofJgbMetrics({ fetchedAt: new Date("2026-10-02T15:00:00Z") }, m.impl), "JGB2Y").observedDate, "2026-10-03");
});

test("future-only files fail closed instead of persisting a future Fact", async () => {
  const m = mof(csv([row("R8.10.3", "1", "2")]), csv([row("R8.10.4", "3", "4")]));
  await assert.rejects(() => fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl),
    (error: unknown) => error instanceof MofAdapterError && error.code === "MOF_NO_VALID_OBSERVATION");
});

test("duplicate dates are deterministic: last valid value within a file, current over history", async () => {
  const m = mof(csv([row("R8.10.1", "-0.1", "3.0"), row("R8.10.1", "-0.15", "-")]),
    csv([row("R8.10.1", "9", "9")]));
  const metrics = await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl);
  assert.equal(get(metrics, "JGB2Y").value, -0.15);
  assert.equal(get(metrics, "JGB10Y").value, 3);
});

test("era year zero and impossible calendar dates never become observations", () => {
  const parsed = parseMofJgbCsv(new TextDecoder("shift-jis").decode(csv([
    row("R0.1.1", "9", "9"), row("H0.12.31", "9", "9"),
    row("R8.2.30", "9", "9"), row("R6.2.29", "-0.1", "-0.05"),
  ])));
  assert.deepEqual(collectMofObservations(parsed).map(({ date, value }) => ({ date, value })), [
    { date: "2024-02-29", value: -0.1 }, { date: "2024-02-29", value: -0.05 },
  ]);
});

test("real files: history ends 2026-08-31, current has 2026-09-30 -> the 09-30 rows are used", async () => {
  const m = mof(bytes(REAL_CURRENT_BASE64), bytes(REAL_ALL_BASE64));
  const metrics = await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl);
  const tenYear = get(metrics, "JGB10Y");
  assert.equal(tenYear.observedDate, "2026-09-30");
  assert.equal(tenYear.value, 3.057);
  assert.equal(tenYear.sourceUrl, MOF_JGB_CURRENT_CSV_URL);
  assert.deepEqual(tenYear.metadata, {
    mofDate: "2026-09-30", mofSourceFile: "current", mofFetch: { current: "ok", all: "ok" }, mofPartial: false,
  });
  const twoYear = get(metrics, "JGB2Y");
  assert.equal(twoYear.observedDate, "2026-09-30");
  assert.equal(twoYear.value, 1.952);
  assert.equal(tenYear.observedAt, null);
  assert.equal(tenYear.timePrecision, "date");
  // Both files, once each.
  assert.deepEqual([...m.calls].sort(), [MOF_JGB_ALL_CSV_URL, MOF_JGB_CURRENT_CSV_URL].sort());
});

test("the same date in both files: the current file's row wins", async () => {
  const m = mof(csv([row("R8.9.30", "1.952", "3.057")]), csv([row("R8.9.29", "1.9", "3.0"), row("R8.9.30", "9.999", "9.999")]));
  const tenYear = get(await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl), "JGB10Y");
  assert.equal(tenYear.value, 3.057);
  assert.equal(tenYear.metadata?.mofSourceFile, "current");
});

test("current file fails: the history file is the fallback, flagged partial, and keeps its OLD observation date", async () => {
  for (const failure of [404, 500, "network"] as const) {
    const m = mof(failure, bytes(REAL_ALL_BASE64));
    const tenYear = get(await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl), "JGB10Y");
    assert.equal(tenYear.value, 2.943);
    // Not relabelled as recent: freshness is judged from this date downstream.
    assert.equal(tenYear.observedDate, "2026-08-31");
    assert.equal(tenYear.sourceUrl, MOF_JGB_ALL_CSV_URL);
    assert.equal(tenYear.metadata?.mofSourceFile, "all");
    assert.equal(tenYear.metadata?.mofPartial, true);
    const expected = failure === "network" ? "failed:MOF_FETCH_FAILED" : "failed:MOF_HTTP_ERROR";
    assert.deepEqual(tenYear.metadata?.mofFetch, { current: expected, all: "ok" });
  }
});

test("history file fails: the current file alone is enough, flagged partial", async () => {
  const m = mof(bytes(REAL_CURRENT_BASE64), "network");
  const metrics = await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl);
  assert.equal(get(metrics, "JGB10Y").value, 3.057);
  assert.equal(get(metrics, "JGB2Y").observedDate, "2026-09-30");
  assert.deepEqual(get(metrics, "JGB10Y").metadata?.mofFetch, { current: "ok", all: "failed:MOF_FETCH_FAILED" });
  assert.equal(get(metrics, "JGB10Y").metadata?.mofPartial, true);
});

test("both files fail: the run fails, naming both failures", async () => {
  await assert.rejects(
    fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, mof(500, "network").impl),
    (error: unknown) =>
      error instanceof MofAdapterError && error.code === "MOF_HTTP_ERROR" &&
      /current: status=500; all: MOF_FETCH_FAILED/.test(error.message),
  );
  await assert.rejects(fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, mof("network", 404).impl), /MOF_FETCH_FAILED/);
});

test("current file is empty (title + header only): history fallback, not a failure", async () => {
  const m = mof(csv([]), bytes(REAL_ALL_BASE64));
  const tenYear = get(await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, m.impl), "JGB10Y");
  assert.equal(tenYear.observedDate, "2026-08-31");
  assert.deepEqual(tenYear.metadata?.mofFetch, { current: "empty", all: "ok" });
  assert.equal(tenYear.metadata?.mofPartial, false);
});

test("month boundary: the current file still holds only last month's rows -> chosen by date, not by file or today's month", async () => {
  // 2026-10-02: jgbcm.csv is still the September file (as observed in Production), history ends 08-31.
  const m = mof(csv([row("R8.9.29", "1.976", "3.082"), row("R8.9.30", "1.952", "3.057")]), csv([row("R8.8.31", "1.743", "2.943")]));
  const metrics = await fetchMofJgbMetrics({ fetchedAt: new Date("2026-10-02T06:00:00Z") }, m.impl);
  assert.equal(get(metrics, "JGB10Y").observedDate, "2026-09-30");
});

test("month boundary: the current file switched to the new month and history was extended -> newest date overall", async () => {
  const history = csv([row("R8.8.31", "1.743", "2.943"), row("R8.9.30", "1.952", "3.057")]);
  const switched = await fetchMofJgbMetrics({ fetchedAt: new Date("2026-10-05T06:00:00Z") }, mof(csv([row("R8.10.1", "1.96", "3.07"), row("R8.10.2", "1.97", "3.09")]), history).impl);
  assert.equal(get(switched, "JGB10Y").observedDate, "2026-10-02");
  assert.equal(get(switched, "JGB10Y").metadata?.mofSourceFile, "current");
  // New month's file exists but has no row yet: the newest row is the history file's month-end.
  const emptyNewMonth = await fetchMofJgbMetrics({ fetchedAt: new Date("2026-10-01T06:00:00Z") }, mof(csv([]), history).impl);
  assert.equal(get(emptyNewMonth, "JGB10Y").observedDate, "2026-09-30");
  assert.equal(get(emptyNewMonth, "JGB10Y").metadata?.mofSourceFile, "all");
});

test("malformed rows are ignored, never fatal", async () => {
  const current = csv([
    row("R8.9.25", "1.9", "3.0"),
    row("X8.9.30", "7", "7"), // unknown era
    row("R8.13.45", "7", "7"), // impossible month/day
    row("R8.9.31", "7", "7"), // September has 30 days
    row("R8.9.28", "n/a", "1e3"), // not plain decimals
    row("R8.9.29", "", " "), // empty cells
    ",,,,,,,,,,,,,,,", // blank-cell trailer
    "note,,,,,,,,,,,,,,,", // note trailer
    "R8.9.26", // truncated row
  ]);
  const metrics = await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, mof(current, csv([row("R8.8.31", "1.743", "2.943")])).impl);
  assert.equal(get(metrics, "JGB10Y").observedDate, "2026-09-25");
  assert.equal(get(metrics, "JGB2Y").value, 1.9);
});

test("a future-dated row cannot become the latest", async () => {
  const current = csv([row("R8.9.30", "1.952", "3.057"), row("R9.1.5", "8", "8"), row("R8.10.4", "8", "8")]);
  const metrics = await fetchMofJgbMetrics({ fetchedAt: new Date("2026-10-02T06:00:00Z") }, mof(current, csv([row("R8.8.31", "1.743", "2.943")])).impl);
  assert.equal(get(metrics, "JGB10Y").observedDate, "2026-09-30");
  // One day ahead of the UTC date is allowed (Japan is ahead of UTC).
  const ahead = await fetchMofJgbMetrics({ fetchedAt: new Date("2026-10-02T16:00:00Z") }, mof(csv([row("R8.10.3", "2", "3")]), csv([row("R8.8.31", "1.743", "2.943")])).impl);
  assert.equal(get(ahead, "JGB10Y").observedDate, "2026-10-03");
});

test("each maturity takes its own newest quoted value ('-' on the latest day falls back per metric)", async () => {
  const current = csv([row("R8.9.29", "1.976", "3.082"), row("R8.9.30", "1.952", "-")]);
  const metrics = await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, mof(current, csv([row("R8.8.31", "1.743", "2.943")])).impl);
  assert.equal(get(metrics, "JGB2Y").observedDate, "2026-09-30");
  assert.equal(get(metrics, "JGB10Y").observedDate, "2026-09-29");
  assert.equal(get(metrics, "JGB10Y").value, 3.082);
});

test("a 200 that is not the CSV (error page) counts as that file failing; the other file is used", async () => {
  const html = new TextEncoder().encode("<html>\r\n<body>maintenance</body>\r\n</html>\r\n");
  const metrics = await fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, mof(html, bytes(REAL_ALL_BASE64)).impl);
  assert.equal(get(metrics, "JGB10Y").observedDate, "2026-08-31");
  assert.deepEqual(get(metrics, "JGB10Y").metadata?.mofFetch, { current: "failed:MOF_UNEXPECTED_HEADER", all: "ok" });
  assert.equal(get(metrics, "JGB10Y").metadata?.mofPartial, true);
});

test("no usable row in either file: the run fails with MOF_NO_VALID_OBSERVATION", async () => {
  await assert.rejects(
    fetchMofJgbMetrics({ fetchedAt: FETCHED_AT }, mof(csv([]), csv([row("R8.8.31", "-", "-")])).impl),
    /MOF_NO_VALID_OBSERVATION: .*current=empty, all=empty/,
  );
});

test("collect / merge: pure helpers pick by date regardless of row order", () => {
  const decode = (data: Uint8Array) => parseMofJgbCsv(new TextDecoder("shift-jis").decode(data));
  // Rows deliberately out of order.
  const history = collectMofObservations(decode(csv([row("R8.9.30", "1.95", "3.05"), row("R8.8.31", "1.743", "2.943")])), undefined, "all");
  assert.equal(history.length, 4);
  const merged = mergeLatestMofObservations(history, []);
  assert.deepEqual(merged.map((o) => [o.metricKey, o.date, o.value]), [["JGB2Y", "2026-09-30", 1.95], ["JGB10Y", "2026-09-30", 3.05]]);
  assert.deepEqual(mergeLatestMofObservations([], []), []);
});
