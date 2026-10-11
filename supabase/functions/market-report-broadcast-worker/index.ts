// 共通の朝刊・大引けの一斉通知の worker（Edge Function）。未デプロイのソース候補。
//
// 呼び出し: DB の Cron（pg_cron + pg_net、毎分。Runbook 参照。未作成）から POST するだけ。
// 認証: verify_jwt = false（デプロイ時に --no-verify-jwt）+ X-Cron-Secret ヘッダー。値は既存の
//       SEND_PUSH_NOTIFICATIONS_CRON_SECRET と比べる（新しい秘密情報は増やさない）。
// DB: SUPABASE_SECRET_KEYS の既定のキー（service_role）で、一斉通知の RPC と許された SELECT だけを使う。
// 送信: Expo Push API。重要ニュースの経路（notifications と send-push-notifications）には触れない。
// AI は呼ばない。

import { runBroadcastWorker, safeCode, type Clock } from "./broadcast_logic.ts";
import { expoSender } from "./expo_sender.ts";
import { isAuthorizedCronCaller, restDb, rpcStore } from "./store.ts";

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

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return response({ error: "METHOD_NOT_ALLOWED" }, 405);
  if (!isAuthorizedCronCaller(req, Deno.env.get("SEND_PUSH_NOTIFICATIONS_CRON_SECRET"))) {
    return response({ error: "UNAUTHORIZED" }, 401);
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const secretKey = getSecretKey();
  if (!supabaseUrl || !secretKey) return response({ error: "MISSING_CONFIGURATION" }, 500);

  try {
    const report = await runBroadcastWorker(
      rpcStore(restDb(supabaseUrl, secretKey)),
      expoSender(realClock),
      realClock,
      { log: (event) => console.log(JSON.stringify(event)) },
    );
    return response({ status: "completed", ...report });
  } catch (error) {
    return response({ status: "failed", error: safeCode(error) }, 500);
  }
});
