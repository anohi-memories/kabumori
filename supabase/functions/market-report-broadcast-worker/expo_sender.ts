// Expo Push API への送信（一斉通知用）。既存の送信 worker と同じ決まりを使う:
//   - 429・5xx（受け付けを明示的に断った）だけ、待ち時間を伸ばしながら数回まで送り直す。
//   - 通信の例外（応答が無い・本文が JSON でない）は送り直さない（送ったかもしれない）。呼び出し側へ例外のまま返す。
// トークンや本文はログに出さない。

import { expoRequestRetryDelayMs, shouldRetryExpoRequest } from "../send-push-notifications/push_send_logic.ts";
import type { BroadcastMessage, Clock, ExpoSender, SendResult } from "./broadcast_logic.ts";

export const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";

export function expoSender(clock: Clock, fetchImpl: typeof fetch = fetch): ExpoSender {
  return async (messages: BroadcastMessage[]): Promise<SendResult> => {
    for (let attempt = 1; ; attempt += 1) {
      const result = await fetchImpl(EXPO_PUSH_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(30_000),
      });
      if (result.ok) {
        // 中身はここでは解釈しない（broadcast_logic.readTicket が厳しく読む）。data が配列でなければ ticket は0件 =
        // 数が合わない = unknown（送り直さない）。
        const body = await result.json() as unknown;
        const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
        return { kind: "tickets", tickets: Array.isArray(data) ? data : [] };
      }
      if (!shouldRetryExpoRequest(result.status, attempt)) return { kind: "rejected", status: result.status };
      await clock.sleep(expoRequestRetryDelayMs(attempt));
    }
  };
}
