// オンデマンド個別AI分析の worker（Edge Function）。未デプロイのソース候補。
//
// 呼び出し: DB の Cron（pg_cron + pg_net、毎分。Runbook 参照。未作成）から POST するだけ。アプリからは呼ばない。
// 認証: verify_jwt = false（デプロイ時に --no-verify-jwt）+ X-Cron-Secret ヘッダー。値は既存の
//       SEND_PUSH_NOTIFICATIONS_CRON_SECRET（送信の Cron と personalized-reports が使っているもの）と比べる。
//       新しい秘密情報は増やさない。
// DB: SUPABASE_SECRET_KEYS の既定のキー（service_role）で PostgREST の RPC と SELECT だけを使う。
//     ジョブの状態の変更はすべて SECURITY DEFINER の RPC（貸し出しの token と版で守る）。
// AI: 定時の個別レポートと同じ低費用のモデル（report_logic.REPORT_MODEL）と同じ OpenAI の呼び出し。
//
// 本文: { "batch": 1〜10 }（省略時 4。DB 側の同時に動かせる数の上限も効く）。

import { openAiRequester } from "../personalized-reports/report_logic.ts";
import { fetchAllSeries } from "../personalized-reports/portfolio_inputs.ts";
import { analyzeJob } from "./analysis_pipeline.ts";
import { runWorker, DEFAULT_BATCH } from "./worker_logic.ts";
import { isAuthorizedCronCaller, restDb, rpcStore } from "./store.ts";
import { safeCode } from "./market_basis.ts";

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function getSecretKey(): string | null {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return null;
  try {
    const value = (JSON.parse(raw) as Record<string, unknown>)["default"];
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!isAuthorizedCronCaller(req, Deno.env.get("SEND_PUSH_NOTIFICATIONS_CRON_SECRET"))) {
    return response({ error: "UNAUTHORIZED" }, 401);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!supabaseUrl || !secretKey || !openAiApiKey) return response({ error: "MISSING_CONFIGURATION" }, 500);

  let body: { batch?: unknown } = {};
  try { body = await req.json() as { batch?: unknown }; } catch { /* 空の本文 */ }
  const batch = typeof body.batch === "number" && Number.isFinite(body.batch) ? body.batch : DEFAULT_BATCH;

  const db = restDb(supabaseUrl, secretKey);
  const requester = openAiRequester(openAiApiKey);
  try {
    const report = await runWorker(
      rpcStore(db),
      (job) => analyzeJob(job, { db, fetchSeries: (symbols) => fetchAllSeries(symbols), requester, now: () => new Date() }),
      { batch, log: (event) => console.log(JSON.stringify(event)) },
    );
    return response({ status: "completed", ...report });
  } catch (error) {
    return response({ status: "failed", error: safeCode(error) }, 500);
  }
});
