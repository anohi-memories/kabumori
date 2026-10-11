/**
 * POSTONA X reservation save flow (pure; no React, network or storage). G3, 2026-10-11.
 *
 * preview  -> each manual post is explicitly confirmed for (exact text, exact time, exact X account)
 *          -> one staged save request for the batch
 *          -> the server acknowledges durable reservation ids / revisions
 *          -> '予約済み' only after a server read-back returns every saved row as planned + confirmed.
 * Anything missing keeps the plan a preview ("プレビュー／未予約・投稿されません"); nothing here pretends a plan
 * was saved or will be posted. A changed time or text invalidates that post's confirmation. AI slots are a
 * separate save: they carry no text and need the owner's own opt-in (`auto_post_preference`) as read for
 * the selected account's brand -- AI consultation's 「これで覚えて」 is settings confirmation only.
 */
import type { ScheduleBatch, ScheduleDraft } from './schedule-planner.ts';

export type Sha256 = (text: string) => Promise<string>;

/** The user's explicit confirmation of one manual post, bound to exactly what they saw. */
export type PostConfirmation = {
  draftId: string;
  socialAccountId: string;
  scheduledAt: string;
  contentSha256: string;
};

export type ReservationItem = {
  draft_id: string;
  scheduled_at: string;
  body?: string;
  consent?: { confirmed: true; content_sha256: string };
};

export type SaveRequest = {
  socialAccountId: string;
  clientBatchId: string;
  revision: number;
  mode: ScheduleBatch['mode'];
  band: { date_from: string; date_to: string; window_start: string; window_end: string } | null;
  items: ReservationItem[];
};

export type FlowIssue = { code: string; message: string; draftId?: string };

/** Records a confirmation of what is on screen right now. */
export async function confirmPost(draft: ScheduleDraft, sha256: Sha256): Promise<PostConfirmation> {
  return { draftId: draft.id, socialAccountId: draft.accountId, scheduledAt: draft.scheduledAt, contentSha256: await sha256(draft.text) };
}

/** A confirmation still holds only if text, time and account are exactly what was confirmed. */
export async function confirmationHolds(draft: ScheduleDraft, confirmation: PostConfirmation | undefined, sha256: Sha256): Promise<boolean> {
  if (!confirmation || confirmation.draftId !== draft.id) return false;
  if (confirmation.socialAccountId !== draft.accountId || confirmation.scheduledAt !== draft.scheduledAt) return false;
  return confirmation.contentSha256 === (await sha256(draft.text));
}

function bandOf(batch: ScheduleBatch): SaveRequest['band'] {
  const request = batch.request;
  if (request.mode === 'manual_random_batch') {
    return { date_from: request.dateFrom, date_to: request.dateTo, window_start: request.window.start, window_end: request.window.end };
  }
  if (request.mode === 'ai_flexible') {
    return { date_from: request.dateFrom, date_to: request.dateTo, window_start: request.publishWindow.start, window_end: request.publishWindow.end };
  }
  return null;
}

/**
 * Builds the save request for one batch's ACTIVE drafts (cancelled drafts are never sent). Manual: every active
 * post must hold a current confirmation. AI: the selected brand's own saved opt-in must be in place.
 */
export async function buildSaveRequest(input: {
  batch: ScheduleBatch;
  drafts: ScheduleDraft[];
  confirmations: Record<string, PostConfirmation>;
  aiOptIn: { source: 'saved' | 'default'; approvalMode: string };
  sha256: Sha256;
}): Promise<{ ok: true; request: SaveRequest } | { ok: false; issues: FlowIssue[] }> {
  const { batch } = input;
  const active = input.drafts
    .filter((draft) => draft.batchId === batch.id && draft.state !== 'cancelled')
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id));
  if (!active.length) return { ok: false, issues: [{ code: 'NO_ACTIVE_POSTS', message: '保存できる投稿がありません。' }] };
  if (active.some((draft) => draft.accountId !== batch.accountId || draft.brandId !== batch.brandId)) {
    return { ok: false, issues: [{ code: 'OWNER_MISMATCH', message: '別のアカウントの予定は保存できません。' }] };
  }
  const issues: FlowIssue[] = [];
  const items: ReservationItem[] = [];
  if (batch.origin === 'ai_generated') {
    if (input.aiOptIn.source !== 'saved' || input.aiOptIn.approvalMode !== 'auto_post_preference') {
      return { ok: false, issues: [{ code: 'AI_NOT_OPTED_IN', message: 'AI自動投稿は、設定画面で自動投稿を選んだ場合だけ保存できます。AI相談の「これで覚えて」は同意になりません。' }] };
    }
    for (const draft of active) items.push({ draft_id: draft.id, scheduled_at: draft.scheduledAt });
  } else {
    for (const draft of active) {
      const confirmation = input.confirmations[draft.id];
      if (!(await confirmationHolds(draft, confirmation, input.sha256))) {
        issues.push({ code: 'CONFIRMATION_REQUIRED', message: '内容・日時・アカウントを確認してください。', draftId: draft.id });
        continue;
      }
      items.push({ draft_id: draft.id, scheduled_at: draft.scheduledAt, body: draft.text, consent: { confirmed: true, content_sha256: confirmation!.contentSha256 } });
    }
  }
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    request: { socialAccountId: batch.accountId, clientBatchId: batch.id, revision: batch.revision + 1, mode: batch.mode, band: bandOf(batch), items },
  };
}

// ---------------------------------------------------------------------------------------------------
// Server truth
// ---------------------------------------------------------------------------------------------------

export type ServerReservation = {
  reservationId: string;
  draftId: string;
  scheduledAt: string;
  status: 'planned' | 'claimed' | 'published' | 'failed' | 'uncertain' | 'cancelled' | 'expired';
  revision: number;
  consentState: 'confirmed' | 'needs_reconfirm' | 'ai_owner_opt_in';
};

export type SaveOutcome =
  | { kind: 'saved'; reservations: ServerReservation[] }
  | { kind: 'not_available' }
  | { kind: 'failed'; code: string };

/**
 * '予約済み' is shown only when the read-back contains every draft of the request as a planned row at the
 * requested time with a valid consent state. Anything else stays a preview (or an explicit error).
 */
export function verifySavedByReadBack(request: SaveRequest, readBack: ServerReservation[]): SaveOutcome {
  const byDraft = new Map(readBack.map((row) => [row.draftId, row]));
  for (const item of request.items) {
    const row = byDraft.get(item.draft_id);
    if (!row) return { kind: 'failed', code: 'READ_BACK_MISSING' };
    if (row.status !== 'planned') return { kind: 'failed', code: 'READ_BACK_NOT_PLANNED' };
    if (new Date(row.scheduledAt).getTime() !== new Date(item.scheduled_at).getTime()) return { kind: 'failed', code: 'READ_BACK_TIME_MISMATCH' };
    const expected = item.body !== undefined ? 'confirmed' : 'ai_owner_opt_in';
    if (row.consentState !== expected) return { kind: 'failed', code: 'READ_BACK_CONSENT_MISMATCH' };
  }
  return { kind: 'saved', reservations: request.items.map((item) => byDraft.get(item.draft_id)!) };
}

const STATUS_LABELS: Record<ServerReservation['status'], string> = {
  planned: '予約済み',
  claimed: '投稿処理中',
  published: '投稿済み',
  failed: '投稿されませんでした',
  uncertain: '結果を確認中',
  cancelled: '取り消し済み',
  expired: '期限切れ',
};

/** Label for a server row; a planned row whose consent needs reconfirmation is not shown as reserved. */
export function serverReservationLabel(row: ServerReservation): string {
  if (row.status === 'planned' && row.consentState === 'needs_reconfirm') return '再確認が必要';
  return STATUS_LABELS[row.status];
}
