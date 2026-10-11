// 個別レポートの1回の実行で、誰を処理し、どう保存し、通知をどう予約するか（2026-10-11 配信安定化 P1）。
// - 20人の上限は「1回の実行の上限」で、利用者全体の上限ではない。まだ行の無い利用者から順に選ぶので、
//   実行を重ねれば全員に届く（P1-4）。
// - 完成したレポートは、通知の予約に失敗しても failed に戻さない。最後の保存は「生成中」の行にだけ効く（P1-5）。
// - 途中で止まって「生成中」のまま残った行は、十分に古いものだけを条件付きの更新で引き取る（P1-6）。
// どれも既存の列・一意キー・権限だけで行い、DB の定義は変えない。

export const MAX_USERS_PER_RUN = 20;
/**
 * これより古い「生成中」の行は、元の実行がもう動いていないとみなして引き取る。1回の実行は 110 秒の時間の予算と
 * 1人あたり最大2回×90 秒のモデル呼び出しで終わるので、30 分は十分に長い（Edge Function の実時間の上限は未確認）。
 */
export const STALE_GENERATING_MINUTES = 30;
/** 1回の実行で、通知の予約をやり直す完成済みのレポートの上限。 */
export const NOTIFICATION_SWEEP_LIMIT = 20;
/**
 * 通知の予約に失敗した完成済みのレポートに付ける印（既存の `error` 欄。アプリは読まない）。完成・Fact の状態は
 * 変えない。次の実行が、この印の付いた行だけを予約し直し、終わったら印を消す。
 */
export const NOTIFICATION_PENDING_MARK = "NOTIFICATION_ENQUEUE_FAILED";

export type ExistingRow = { id: string; user_id: string; status: string; updated_at: string };

export type RunSelection = {
  /** まだ行の無い利用者（新しく行を作る）。 */
  fresh: string[];
  /** 古い「生成中」の行（引き取る）。 */
  stale: Array<{ userId: string; reportId: string }>;
  /** この実行では選ばれなかった、まだ終わっていない利用者の数（次の実行で処理する）。 */
  remaining: number;
};

/**
 * この実行で処理する利用者。`candidates` は利用者 ID の昇順。完成・失敗・新しい「生成中」の行がある利用者は
 * 処理済みとして飛ばし、行の無い利用者と古い「生成中」の行を、昇順で最大 `limit` 人まで選ぶ。
 */
export function selectRunUsers(
  candidates: readonly string[],
  existing: readonly ExistingRow[],
  now: Date,
  limit = MAX_USERS_PER_RUN,
): RunSelection {
  const cutoff = now.getTime() - STALE_GENERATING_MINUTES * 60_000;
  const rowByUser = new Map(existing.map((row) => [row.user_id, row]));
  const pending: Array<{ userId: string; reportId: string | null }> = [];
  for (const userId of candidates) {
    const row = rowByUser.get(userId);
    if (!row) pending.push({ userId, reportId: null });
    else if (row.status === "generating" && Date.parse(row.updated_at) < cutoff) pending.push({ userId, reportId: row.id });
  }
  const chosen = pending.slice(0, limit);
  return {
    fresh: chosen.filter((item) => item.reportId === null).map((item) => item.userId),
    stale: chosen.filter((item) => item.reportId !== null).map((item) => ({ userId: item.userId, reportId: item.reportId! })),
    remaining: pending.length - chosen.length,
  };
}

export function staleCutoffIso(now: Date): string {
  return new Date(now.getTime() - STALE_GENERATING_MINUTES * 60_000).toISOString();
}

/** 個別レポートの行への操作。どれも条件付きで、他の実行の結果や完成した行を上書きしない。 */
export type ReportStore = {
  /** その日・その種類の全行（利用者の選定用）。 */
  listRows(reportType: string, tradingDate: string, onlyUser: string | null): Promise<ExistingRow[]>;
  /** 「生成中」の行を新しく作る。既に行があれば null（一意キー）。 */
  insertGenerating(userId: string, reportType: string, tradingDate: string): Promise<string | null>;
  /** 古い「生成中」の行を引き取る。まだ「生成中」で、かつ cutoff より古いときだけ更新し、更新できたら true。 */
  takeOverStale(reportId: string, cutoffIso: string, nowIso: string): Promise<boolean>;
  /** 最後の保存。行がまだ「生成中」のときだけ効き、効いたら true。 */
  finalize(reportId: string, update: Record<string, unknown>): Promise<boolean>;
  /** 失敗の記録。行がまだ「生成中」のときだけ効く（完成した行を failed に戻さない）。 */
  markFailed(reportId: string, error: string, nowIso: string): Promise<boolean>;
  /** 通知の予約（既存の RPC。一意の索引で1つのレポートに1件まで）。予約されたら true。 */
  enqueue(reportId: string): Promise<boolean>;
  /** 通知の予約に失敗した印を付ける（完成した行で、まだ予約されていないときだけ）。 */
  markNotificationPending(reportId: string, code: string): Promise<void>;
  /** 印を消す（予約できた、または利用者の設定で予約しない場合）。 */
  clearNotificationPending(reportId: string): Promise<void>;
  /** 印が付いていて、まだ予約されていない完成済みのレポート。 */
  listNotificationPending(reportType: string, tradingDate: string, limit: number): Promise<string[]>;
};

export type ClaimResult = { reportId: string | null; reason: "claimed" | "taken_over" | "already_exists" | "lost_takeover" };

export async function claimReport(
  store: ReportStore,
  pick: { userId: string; staleReportId?: string },
  reportType: string,
  tradingDate: string,
  now: Date,
): Promise<ClaimResult> {
  if (pick.staleReportId) {
    const taken = await store.takeOverStale(pick.staleReportId, staleCutoffIso(now), now.toISOString());
    return taken ? { reportId: pick.staleReportId, reason: "taken_over" } : { reportId: null, reason: "lost_takeover" };
  }
  const reportId = await store.insertGenerating(pick.userId, reportType, tradingDate);
  return reportId ? { reportId, reason: "claimed" } : { reportId: null, reason: "already_exists" };
}

export type FinalizeResult = {
  /** 保存が効いた（行がまだ「生成中」だった）。 */
  saved: boolean;
  notification: "not_attempted" | "queued" | "not_queued_by_settings_or_duplicate" | "skipped_not_saved" | `enqueue_failed:${string}`;
};

/**
 * 最後の保存と通知の予約。予約の失敗は保存した結果を変えない（完成した本文と Fact の状態は戻さない）。
 * 予約できなかった完成済みのレポートは、次の実行の `sweepNotifications` が予約し直す。
 */
export async function finalizeReport(
  store: ReportStore,
  reportId: string,
  update: Record<string, unknown>,
  errorCode: (error: unknown) => string,
): Promise<FinalizeResult> {
  const saved = await store.finalize(reportId, update);
  if (!saved) return { saved, notification: "skipped_not_saved" };
  if (update.status !== "completed") return { saved, notification: "not_attempted" };
  try {
    return { saved, notification: (await store.enqueue(reportId)) ? "queued" : "not_queued_by_settings_or_duplicate" };
  } catch (error) {
    const code = errorCode(error);
    // 印が付けられなくても、完成した行はそのまま（ログには残る）。
    await store.markNotificationPending(reportId, code).catch(() => {});
    return { saved, notification: `enqueue_failed:${code}` };
  }
}

/**
 * 予約に失敗した印の付いた完成済みのレポートを、予約し直す。予約は一意の索引で1件までなので重複しない。
 * 予約できた、または利用者の設定で予約しない（空の結果）ときは印を消し、失敗したら印を残して次に回す。
 * 送信そのものは別の dispatcher の仕事で、ここでは送らない。
 */
export async function sweepNotifications(
  store: ReportStore,
  reportType: string,
  tradingDate: string,
  errorCode: (error: unknown) => string,
): Promise<{ queued: number; cleared: number; failed: string[] }> {
  const ids = await store.listNotificationPending(reportType, tradingDate, NOTIFICATION_SWEEP_LIMIT);
  let queued = 0;
  let cleared = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      if (await store.enqueue(id)) queued += 1;
      await store.clearNotificationPending(id);
      cleared += 1;
    } catch (error) {
      failed.push(errorCode(error));
    }
  }
  return { queued, cleared, failed };
}

type Rest = {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, prefer?: string): Promise<T>;
  patchReturning<T>(path: string, body: unknown): Promise<T>;
};

const enc = encodeURIComponent;

/** PostgREST での実装。条件（status・updated_at）は URL のフィルタで、更新と同じ1つの文の中で判定される。 */
export function restReportStore(db: Rest): ReportStore {
  return {
    listRows: (reportType, tradingDate, onlyUser) =>
      db.get<ExistingRow[]>(
        `personalized_reports?report_type=eq.${enc(reportType)}&trading_date=eq.${enc(tradingDate)}` +
          (onlyUser ? `&user_id=eq.${enc(onlyUser)}` : "") + "&select=id,user_id,status,updated_at",
      ),
    insertGenerating: async (userId, reportType, tradingDate) => {
      const rows = await db.post<Array<{ id: string }>>(
        "personalized_reports?on_conflict=user_id,report_type,trading_date",
        { user_id: userId, report_type: reportType, trading_date: tradingDate, status: "generating" },
        "resolution=ignore-duplicates,return=representation",
      );
      return rows?.[0]?.id ?? null;
    },
    takeOverStale: async (reportId, cutoffIso, nowIso) => {
      const rows = await db.patchReturning<Array<{ id: string }>>(
        `personalized_reports?id=eq.${enc(reportId)}&status=eq.generating&updated_at=lt.${enc(cutoffIso)}`,
        { updated_at: nowIso, error: null },
      );
      return (rows?.length ?? 0) === 1;
    },
    finalize: async (reportId, update) => {
      const rows = await db.patchReturning<Array<{ id: string }>>(
        `personalized_reports?id=eq.${enc(reportId)}&status=eq.generating`, update,
      );
      return (rows?.length ?? 0) === 1;
    },
    markFailed: async (reportId, error, nowIso) => {
      const rows = await db.patchReturning<Array<{ id: string }>>(
        `personalized_reports?id=eq.${enc(reportId)}&status=eq.generating`,
        { status: "failed", fact_status: "pending", error, updated_at: nowIso },
      );
      return (rows?.length ?? 0) === 1;
    },
    enqueue: async (reportId) => {
      const queued = await db.post<Array<{ notification_id: string }>>(
        "rpc/enqueue_personalized_report_notification", { p_report_id: reportId },
      );
      return (queued?.length ?? 0) > 0;
    },
    markNotificationPending: async (reportId, code) => {
      await db.patchReturning(
        `personalized_reports?id=eq.${enc(reportId)}&status=eq.completed&notified_at=is.null`,
        { error: `${NOTIFICATION_PENDING_MARK}:${code}`.slice(0, 300) },
      );
    },
    clearNotificationPending: async (reportId) => {
      await db.patchReturning(
        `personalized_reports?id=eq.${enc(reportId)}&status=eq.completed&error=like.${enc(`${NOTIFICATION_PENDING_MARK}*`)}`,
        { error: null },
      );
    },
    listNotificationPending: async (reportType, tradingDate, limit) => {
      const rows = await db.get<Array<{ id: string }>>(
        `personalized_reports?report_type=eq.${enc(reportType)}&trading_date=eq.${enc(tradingDate)}` +
          `&status=eq.completed&fact_status=eq.passed&notified_at=is.null` +
          `&error=like.${enc(`${NOTIFICATION_PENDING_MARK}*`)}&select=id&order=id.asc&limit=${limit}`,
      );
      return (rows ?? []).map((row) => row.id);
    },
  };
}
