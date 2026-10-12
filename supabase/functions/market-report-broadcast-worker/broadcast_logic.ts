// 共通の朝刊・大引けの一斉通知の worker の処理（DB・Expo・時計は差し替え可能。テストでは手元の模型を使う）。
//
// 1回の実行
//   1. 作る:   enqueue_market_report_broadcasts（完成した今日の共通の回ごとに1つ。何度呼んでも同じ）
//   2. 分ける: 分割中の一斉通知ごとに plan_market_report_broadcast（1回の呼び出しで上限まで。続きは次の回）
//   3. 送る:   区切りを上限まで引き取り（claim）、並行して送る。区切りごとに
//              begin（送る直前に確かめ直し、送る人に「送信中」）→ Expo へ送る → finish（利用者ごとの結果）
//              を、時間の予算の範囲でくり返す
//   4. 片付ける: 古い記録を少しずつ消す（purge）
//
// 二重送信を防ぐ決まり
//   - 1人の端末は、必ず同じ Expo へのリクエストに入れる（利用者ごとの結果を1つのリクエストで決める）。入りきらない
//     人には送らず failed（DEVICE_LIMIT_EXCEEDED。DB の max_devices_per_user でも同じ人を先に除く）。
//   - ticket は形を厳しく読み、分からない形は unknown（送り直さない）。送り直すのは MessageRateExceeded だけ。
//   - Expo へのリクエストが途中で切れた（応答が無い）ら、そのリクエストの人は unknown（送ったかもしれないので二度と送らない）。
//     まだ送っていない後ろのリクエストの人は retry（区切りの次の試行で送る）。
//   - 429・5xx（Expo が受け付けを明示的に断った）は、同じリクエストを数回だけ送り直し、それでも断られたら retry。
//     それ以外の 4xx は failed（内容の問題なので送り直さない）。
//   - 貸し出しの残りが短くなったら、新しいリクエストを送らずに止め、残りの人は retry にする。
// 重要ニュースとは別の経路（notifications の表と send-push-notifications には触れない）。Expo の受け付け（ticket）は、
// 端末に届いたことの保証ではない。

import { EXPO_PUSH_BATCH_SIZE } from "../send-push-notifications/push_send_logic.ts";

export type ReportType = "morning" | "close";

export type ClaimedChunk = {
  chunk_id: string;
  broadcast_id: string;
  report_type: ReportType;
  trading_date: string;
  title: string;
  body: string;
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
  lease_version: number;
  lease_expires_at: string;
};

export type Target = { user_id: string; token_id: string; expo_push_token: string };

export type UserOutcome = "sent" | "retry" | "failed" | "unknown";
export type UserResult = { user_id: string; outcome: UserOutcome; error_code?: string };

export type BroadcastSettings = { messages_per_second: number; max_parallel_chunks: number };

export type BroadcastStore = {
  enqueue(): Promise<unknown>;
  planningBroadcasts(limit: number): Promise<string[]>;
  plan(broadcastId: string): Promise<string>;
  settings(): Promise<BroadcastSettings | null>;
  claim(limit: number): Promise<ClaimedChunk[]>;
  begin(chunk: ClaimedChunk): Promise<Target[]>;
  finish(chunk: ClaimedChunk, results: UserResult[], errorCode: string | null): Promise<string>;
  purge(limit: number): Promise<unknown>;
};

/** Expo への1回のリクエストの結果。throw は「応答が無い」（送ったかどうか分からない）。tickets の中身は readTicket で厳しく読む。 */
export type SendResult =
  | { kind: "tickets"; tickets: unknown[] }
  | { kind: "rejected"; status: number };

export type ExpoSender = (messages: BroadcastMessage[]) => Promise<SendResult>;

export type BroadcastMessage = {
  to: string;
  title: string;
  body: string;
  data: { source_type: "market_report"; source_id: string; report_type: ReportType; trading_date: string };
  sound: "default";
};

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const DEFAULT_TIME_BUDGET_MS = 100_000;
/** 貸し出しの残りがこれより短ければ、新しいリクエストを送らない（finish を期限内に終えるため）。 */
export const LEASE_SAFETY_MS = 20_000;
export const PLAN_CALLS_PER_RUN = 10;
export const PURGE_LIMIT = 20_000;

export function messageFor(chunk: ClaimedChunk, token: string): BroadcastMessage {
  return {
    to: token,
    title: chunk.title,
    body: chunk.body,
    data: {
      source_type: "market_report",
      source_id: `${chunk.report_type}:${chunk.trading_date}`,
      report_type: chunk.report_type,
      trading_date: chunk.trading_date,
    },
    sound: "default",
  };
}

/**
 * 利用者ごとに端末をまとめ、1人の端末が2つのリクエストに分かれないように詰める（1つのリクエストは size 通まで）。
 * 1人で size を超える端末は1つのリクエストに入らないので、その人には送らず overLimit に返す（黙って切り捨てない）。
 */
export function batchByUser(targets: readonly Target[], size = EXPO_PUSH_BATCH_SIZE): { batches: Target[][]; overLimit: string[] } {
  const byUser = new Map<string, Target[]>();
  for (const target of targets) byUser.set(target.user_id, [...(byUser.get(target.user_id) ?? []), target]);
  const batches: Target[][] = [];
  const overLimit: string[] = [];
  let current: Target[] = [];
  for (const [user_id, devices] of byUser) {
    if (devices.length > size) {
      overLimit.push(user_id);
      continue;
    }
    if (current.length + devices.length > size) {
      batches.push(current);
      current = [];
    }
    current.push(...devices);
  }
  if (current.length > 0) batches.push(current);
  return { batches, overLimit };
}

/**
 * Expo の ticket を厳しく読む（既存の送信の worker の classifyTicket は使わない。形の分からない ticket を
 * 「一時的な失敗」と読んで送り直すことになるため）。
 *   ok:           {status:"ok", id:<空でない文字列>}
 *   dead:         {status:"error", details:{error:"DeviceNotRegistered"}}（その端末は二度と届かない）
 *   rate_limited: {status:"error", details:{error:"MessageRateExceeded"}}（受け付けられなかった。送り直してよい）
 *   rejected:     {status:"error", details:{error:<ほかの文字列>}}（MessageTooBig など。送り直しても変わらない）
 *   malformed:    それ以外の形（受け付けられたかどうか分からない。送り直さない）
 */
export type TicketVerdict = "ok" | "dead" | "rate_limited" | "rejected" | "malformed";

export function readTicket(ticket: unknown): TicketVerdict {
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) return "malformed";
  const value = ticket as { status?: unknown; id?: unknown; details?: unknown };
  if (value.status === "ok") return typeof value.id === "string" && value.id.length > 0 ? "ok" : "malformed";
  if (value.status !== "error") return "malformed";
  const details = value.details;
  const code = details && typeof details === "object" ? (details as { error?: unknown }).error : undefined;
  if (typeof code !== "string" || code.length === 0) return "malformed";
  if (code === "DeviceNotRegistered") return "dead";
  if (code === "MessageRateExceeded") return "rate_limited";
  return "rejected";
}

/** 1つのリクエストの ticket から、利用者ごとの結果を決める。 */
export function outcomesFromTickets(batch: readonly Target[], tickets: readonly unknown[]): UserResult[] {
  const users = [...new Set(batch.map((target) => target.user_id))];
  if (!Array.isArray(tickets) || tickets.length !== batch.length) {
    // ticket の数が合わなければ、どの端末の結果か分からない。送ったかもしれないので unknown。
    return users.map((user_id) => ({ user_id, outcome: "unknown", error_code: "TICKET_COUNT_MISMATCH" }));
  }
  const perUser = new Map<string, TicketVerdict[]>();
  batch.forEach((target, index) => {
    perUser.set(target.user_id, [...(perUser.get(target.user_id) ?? []), readTicket(tickets[index])]);
  });
  return users.map((user_id): UserResult => {
    const verdicts = perUser.get(user_id) ?? [];
    // 1台でも受け付けられたら送信済み（ほかの端末へは送り直さない）。
    if (verdicts.includes("ok")) return { user_id, outcome: "sent" };
    // 形の分からない ticket があれば、受け付けられたかもしれないので unknown（送り直さない）。
    if (verdicts.includes("malformed")) return { user_id, outcome: "unknown", error_code: "TICKET_MALFORMED" };
    if (verdicts.includes("rate_limited")) return { user_id, outcome: "retry", error_code: "EXPO_MESSAGE_RATE_EXCEEDED" };
    if (verdicts.includes("rejected")) return { user_id, outcome: "failed", error_code: "EXPO_TICKET_REJECTED" };
    return { user_id, outcome: "failed", error_code: "EXPO_DEVICE_NOT_REGISTERED" };
  });
}

/**
 * 区切り1つ分の送信。利用者ごとの結果と、区切りに残す失敗のコードを返す。例外は投げない。
 *
 * 送る速さ（どの1秒の窓でも超えない）: この区切りの上限 perChunkRate（全体の上限 ÷ 同時の区切りの数）に対して、
 *   - 1つのリクエストは min(90, perChunkRate) 通まで
 *   - 送る前に直近1秒の送信数を数え、足すと上限を超えるなら、窓が空くまで待つ
 *   - 区切りを終える前に、最後の送信から1秒たつまで待つ（同じ枠で次の区切りが送り始めても、窓が重ならない）
 * DB が同時に動く区切りを max_parallel_chunks までに抑えるので、全体でも、どの1秒の窓でも上限以内になる。
 */
export async function sendChunk(
  chunk: ClaimedChunk,
  targets: readonly Target[],
  sender: ExpoSender,
  clock: Clock,
  perChunkRate: number,
): Promise<{ results: UserResult[]; errorCode: string | null; requests: number }> {
  const results: UserResult[] = [];
  const rate = Math.max(1, Math.floor(perChunkRate));
  const { batches, overLimit } = batchByUser(targets, Math.min(EXPO_PUSH_BATCH_SIZE, rate));
  for (const user_id of overLimit) results.push({ user_id, outcome: "failed", error_code: "DEVICE_LIMIT_EXCEEDED" });
  const deadline = Date.parse(chunk.lease_expires_at) - LEASE_SAFETY_MS;
  const window: Array<{ at: number; count: number }> = [];
  let errorCode: string | null = null;
  let requests = 0;
  let index = 0;
  for (; index < batches.length; index += 1) {
    const batch = batches[index];
    for (;;) {
      while (window.length > 0 && window[0].at <= clock.now() - 1000) window.shift();
      const used = window.reduce((sum, entry) => sum + entry.count, 0);
      if (used + batch.length <= rate) break;
      await clock.sleep(Math.max(1, window[0].at + 1000 - clock.now()));
    }
    if (clock.now() >= deadline) {
      errorCode = "LEASE_SAFETY_STOP";
      break;
    }
    window.push({ at: clock.now(), count: batch.length });
    requests += 1;
    let sent: SendResult;
    try {
      sent = await sender(batch.map((target) => messageFor(chunk, target.expo_push_token)));
    } catch {
      // 応答が無い: このリクエストの人は送ったかもしれない。後ろの人はまだ送っていない。
      for (const user_id of new Set(batch.map((target) => target.user_id))) {
        results.push({ user_id, outcome: "unknown", error_code: "EXPO_OUTCOME_UNKNOWN" });
      }
      errorCode = "EXPO_OUTCOME_UNKNOWN";
      index += 1;
      break;
    }
    if (sent.kind === "rejected") {
      const retryable = sent.status === 429 || (sent.status >= 500 && sent.status < 600);
      for (const user_id of new Set(batch.map((target) => target.user_id))) {
        results.push({ user_id, outcome: retryable ? "retry" : "failed", error_code: `EXPO_REJECTED_${sent.status}` });
      }
      errorCode = `EXPO_REJECTED_${sent.status}`;
      if (retryable) {
        // 混んでいる・落ちている間は、この区切りの残りを送らずに次の試行へ回す。
        index += 1;
        break;
      }
      continue;
    }
    results.push(...outcomesFromTickets(batch, sent.tickets));
  }
  // 最後の送信から1秒たつまで待ってから終える（枠ごとの窓を次の区切りと重ねない）。
  const last = window[window.length - 1];
  if (last && clock.now() < last.at + 1000) await clock.sleep(last.at + 1000 - clock.now());
  // 送らなかった後ろの人は retry（送っていないことが確か）。
  for (const batch of batches.slice(index)) {
    for (const user_id of new Set(batch.map((target) => target.user_id))) {
      results.push({ user_id, outcome: "retry", error_code: errorCode ?? "NOT_ATTEMPTED" });
    }
  }
  return { results, errorCode, requests };
}

export type RunReport = {
  created: unknown;
  planned: number;
  chunks: number;
  lease_lost: number;
  users: Record<UserOutcome, number>;
  requests: number;
};

export async function runBroadcastWorker(
  store: BroadcastStore,
  sender: ExpoSender,
  clock: Clock,
  options: { timeBudgetMs?: number; log?: (event: Record<string, unknown>) => void } = {},
): Promise<RunReport> {
  const started = clock.now();
  const budget = options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const log = options.log ?? (() => {});
  const report: RunReport = {
    created: null, planned: 0, chunks: 0, lease_lost: 0, users: { sent: 0, retry: 0, failed: 0, unknown: 0 }, requests: 0,
  };
  report.created = await store.enqueue();
  const settings = await store.settings();
  if (!settings) return report;
  const perChunkRate = Math.max(1, Math.floor(settings.messages_per_second / Math.max(1, settings.max_parallel_chunks)));

  let planCalls = 0;
  const planSome = async () => {
    for (const id of await store.planningBroadcasts(5)) {
      if (planCalls >= PLAN_CALLS_PER_RUN) return;
      planCalls += 1;
      report.planned += 1;
      await store.plan(id);
    }
  };

  while (clock.now() - started < budget) {
    await planSome();
    const chunks = await store.claim(settings.max_parallel_chunks);
    if (chunks.length === 0) {
      // 分割の途中なら、もう一度分けてから引き取る。それでも無ければ終わり。
      if ((await store.planningBroadcasts(1)).length > 0 && planCalls < PLAN_CALLS_PER_RUN) continue;
      break;
    }
    await Promise.all(chunks.map(async (chunk) => {
      report.chunks += 1;
      let targets: Target[];
      try {
        targets = await store.begin(chunk);
      } catch (error) {
        // begin が失敗: 送っていない。DB 側で記録が付いていても、期限切れで unknown になり二度と送られない。
        report.lease_lost += 1;
        log({ event: "market_report_broadcast_begin_failed", chunk: chunk.chunk_id.slice(0, 8), code: safeCode(error) });
        return;
      }
      const { results, errorCode, requests } = await sendChunk(chunk, targets, sender, clock, perChunkRate);
      report.requests += requests;
      for (const result of results) report.users[result.outcome] += 1;
      const status = await store.finish(chunk, results, errorCode).catch((error) => `error:${safeCode(error)}`);
      if (status === "lease_lost") report.lease_lost += 1;
      log({
        event: "market_report_broadcast_chunk", chunk: chunk.chunk_id.slice(0, 8), attempt: chunk.attempt_count,
        users: results.length, requests, status, code: errorCode,
      });
    }));
  }
  await store.purge(PURGE_LIMIT).catch(() => null);
  return report;
}

export function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "BROADCAST_UNEXPECTED_ERROR";
  return /^[A-Z][A-Za-z0-9_:.-]*$/.test(value) ? value.slice(0, 120) : "BROADCAST_UNEXPECTED_ERROR";
}
