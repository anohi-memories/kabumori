// What one X row says about its connection generation (G1 TASK 39). Pure: no React, no network.
// G3's list and get carry `connectionGeneration` (G3-02 #15). It is read here from the row as an unknown value, not from G3's type, so this works
// on a server or store without the field: absent or anything else is 'unknown', never a guess at 'current'. Only ever narrows what a row offers.
import { NOT_EDITABLE_LABEL, NOT_EDITABLE_TEXT } from './x-write-view.ts';

export type RowGeneration = 'current' | 'earlier' | 'unknown';

export const EARLIER_LABEL = '以前の接続の予約';
export const EARLIER_TEXT = '以前の接続で保存した予約です。再接続しても投稿されません。取り消して、作り直すことができます。';
export const CURRENT_TEXT = '現在の接続で確認できた予約です。投稿を保証するものではありません。';
export const UNKNOWN_TEXT = 'この予約の接続世代を確認できません。投稿されないことがあります。';

export function rowGenerationOf(row: object): RowGeneration {
  const value = (row as { connectionGeneration?: unknown }).connectionGeneration;
  return value === 'current' || value === 'earlier' ? value : 'unknown';
}

/** Why a planned row offers a cancel only: the server's word on its generation first, then a refusal this app saw. */
export function rowRefusalOf(row: object, refusedHere: boolean): { label: string; text: string } | null {
  if (rowGenerationOf(row) === 'earlier') return { label: EARLIER_LABEL, text: EARLIER_TEXT };
  return refusedHere ? { label: NOT_EDITABLE_LABEL, text: NOT_EDITABLE_TEXT } : null;
}

/** The line beside a planned row that is not refused. 「現在の接続」 is not said while the screen refuses every write of this account. */
export function rowGenerationNote(row: { status: string }, writesOpen: boolean): string | null {
  if (row.status !== 'planned') return null;
  const generation = rowGenerationOf(row);
  if (generation === 'unknown') return UNKNOWN_TEXT;
  return generation === 'current' && writesOpen ? CURRENT_TEXT : null;
}

/** A general note on rows the app cannot tell apart is only true while a planned row has no answer. */
export function anyGenerationUnproven(rows: readonly { status: string }[]): boolean {
  return rows.some((row) => row.status === 'planned' && rowGenerationOf(row) === 'unknown');
}
