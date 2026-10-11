// オンデマンドが ON のとき、定時の個別レポートは何も生成・通知しない（二重の生成・二重の通知を防ぐ）。
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ondemandModeEnabled } from "./ondemand_mode.ts";

function db(responses: Array<unknown | Error>) {
  const paths: string[] = [];
  return {
    paths,
    get<T>(path: string): Promise<T> {
      paths.push(path);
      const next = responses.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next as T);
    },
  };
}

test("ゲートの値をそのまま読む（既定の OFF・行が無いときは OFF）", async () => {
  assert.equal(await ondemandModeEnabled(db([[{ ondemand_requests_enabled: true }]])), true);
  assert.equal(await ondemandModeEnabled(db([[{ ondemand_requests_enabled: false }]])), false);
  assert.equal(await ondemandModeEnabled(db([[]])), false);
  const reader = db([[{ ondemand_requests_enabled: "true" }]]);
  assert.equal(await ondemandModeEnabled(reader), false, "true（真偽値）以外は ON とみなさない");
  assert.deepEqual(reader.paths, ["personalized_ondemand_settings?id=eq.true&select=ondemand_requests_enabled"]);
});

test("表が無い（migration が未適用）なら OFF で従来どおり", async () => {
  assert.equal(await ondemandModeEnabled(db([new Error("REST_GET_FAILED:personalized_ondemand_settings:404")])), false);
});

test("読み取りの失敗は1回だけ読み直し、続けて失敗したらその回は何もしない（例外）", async () => {
  assert.equal(await ondemandModeEnabled(db([new Error("REST_GET_FAILED:x:503"), [{ ondemand_requests_enabled: true }]])), true);
  await assert.rejects(
    ondemandModeEnabled(db([new Error("REST_GET_FAILED:x:503"), new Error("REST_GET_FAILED:x:503")])),
    /ONDEMAND_MODE_READ_FAILED/,
  );
});

test("配線: index.ts はゲートを、対象者の読み込み・生成・通知より前に確かめて、ON なら丸ごと飛ばす", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const gate = source.indexOf("if (await ondemandModeEnabled(db))");
  assert.ok(gate > 0);
  assert.match(source.slice(gate, gate + 400), /return response\(\{ status: "skipped", reason: "ONDEMAND_MODE"/);
  for (const later of ["tracked_stocks?is_active=eq.true", "personalized_reports?on_conflict=", "rpc/enqueue_personalized_report_notification"]) {
    assert.ok(source.indexOf(later) > gate, `${later} はゲートの後`);
  }
  // ゲートの読み取りの失敗は外側の catch で 500（その回は何も生成しない）。
  assert.ok(source.indexOf("try {") < gate);
});

test("共有の入力の部品は index.ts から移しただけ（定時の実行も同じ部品を使う）", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(source, /from "\.\/portfolio_inputs\.ts"/);
  assert.doesNotMatch(source, /async function fetchSeries|function toTracked|function toNews/);
  assert.match(source, /`&select=\$\{TRACKED_SELECT\}&order=user_id\.asc,created_at\.asc`/);
});
