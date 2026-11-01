/**
 * Per-post confirmation state of the schedule preview (pure; no React, network or storage).
 *
 * A manual post counts as confirmed only while the exact text, time and X account the user confirmed are still
 * the ones on screen. Any edit, reorder, re-roll, conflict move or time change makes the confirmation
 * 'invalidated' at once (computed from the current draft on every render, never cached). A cancelled post is
 * terminal: it never counts and a confirmation can never bring it back. AI slots have no text: they are
 * never confirmed here (their only consent is the owner's own saved setting, read by the save flow).
 *
 * This module is session-only and local. It does not reserve, save or publish anything; the same rules are
 * enforced again by the save flow (`reservation-flow.ts`) and by the server candidate.
 */
import { confirmPost, type PostConfirmation, type Sha256 } from '../../domain/reservation-flow.ts';
import type { ScheduleDraft } from '../../domain/schedule-planner.ts';

/** The domain confirmation plus the exact text it was given for (so validity can be decided synchronously). */
export type ConfirmedPost = { confirmation: PostConfirmation; text: string };
export type ConfirmationMap = Readonly<Record<string, ConfirmedPost>>;
export type ConfirmationStatus = 'confirmed' | 'invalidated' | 'unconfirmed' | 'not_applicable';

export const EMPTY_CONFIRMATIONS: ConfirmationMap = Object.freeze({});

const isManual = (draft: ScheduleDraft) => draft.origin === 'user_authored';

/** Records a confirmation of exactly what the draft shows right now; null for AI slots and cancelled posts. */
export async function confirmDraft(draft: ScheduleDraft, sha256: Sha256): Promise<ConfirmedPost | null> {
  if (!isManual(draft) || draft.state === 'cancelled') return null;
  const text = draft.text;
  return { confirmation: await confirmPost(draft, sha256), text };
}

/** True only while text, time and account are exactly what was confirmed (same rule as `confirmationHolds`). */
export function confirmationIsCurrent(draft: ScheduleDraft, confirmed: ConfirmedPost | undefined): boolean {
  if (!confirmed || !isManual(draft) || draft.state === 'cancelled') return false;
  const { confirmation } = confirmed;
  return confirmation.draftId === draft.id
    && confirmation.socialAccountId === draft.accountId
    && confirmation.scheduledAt === draft.scheduledAt
    && confirmed.text === draft.text;
}

export function confirmationStatus(draft: ScheduleDraft, confirmations: ConfirmationMap): ConfirmationStatus {
  if (!isManual(draft) || draft.state === 'cancelled') return 'not_applicable';
  const confirmed = confirmations[draft.id];
  if (confirmationIsCurrent(draft, confirmed)) return 'confirmed';
  return confirmed ? 'invalidated' : 'unconfirmed';
}

export type ConfirmationProgress = {
  /** Active manual posts that need their own confirmation. */
  manualTotal: number;
  confirmed: number;
  invalidated: number;
  unconfirmed: number;
  /** Active AI slots: no text, no per-post confirmation. */
  aiSlots: number;
  /** Every active manual post is confirmed (and there is at least one). */
  complete: boolean;
};

/** Progress over the given drafts; the caller passes one account's (and optionally one batch's) drafts. */
export function confirmationProgress(drafts: readonly ScheduleDraft[], confirmations: ConfirmationMap): ConfirmationProgress {
  const progress = { manualTotal: 0, confirmed: 0, invalidated: 0, unconfirmed: 0, aiSlots: 0 };
  for (const draft of drafts) {
    if (draft.state === 'cancelled') continue;
    if (!isManual(draft)) {
      progress.aiSlots += 1;
      continue;
    }
    progress.manualTotal += 1;
    const status = confirmationStatus(draft, confirmations);
    if (status === 'confirmed') progress.confirmed += 1;
    else if (status === 'invalidated') progress.invalidated += 1;
    else progress.unconfirmed += 1;
  }
  return { ...progress, complete: progress.manualTotal > 0 && progress.confirmed === progress.manualTotal };
}

export function withConfirmation(confirmations: ConfirmationMap, confirmed: ConfirmedPost): ConfirmationMap {
  return { ...confirmations, [confirmed.confirmation.draftId]: confirmed };
}

export function withoutConfirmations(confirmations: ConfirmationMap, draftIds: readonly string[]): ConfirmationMap {
  if (!draftIds.some((id) => id in confirmations)) return confirmations;
  const drop = new Set(draftIds);
  return Object.fromEntries(Object.entries(confirmations).filter(([id]) => !drop.has(id)));
}
