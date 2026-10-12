/**
 * Changing the time of ONE fixed-time (manual_exact) preview post. Pure; the result is still a local preview.
 *
 * Only a post whose time the user chose themselves can be moved by hand. Random posts are moved by the explicit
 * re-roll (inside their date range and window), interval posts keep their cadence (the server re-derives every
 * instant from it), and a cancelled post is terminal. The edit never touches the text or the account.
 * Closeness to other posts is not decided here: the screen's conflict check shows it and blocks confirmation.
 */
import { jstDateOf, jstToUtcMs, parseClock, SCHEDULE_LIMITS, type PlanIssue, type ScheduleDraft } from '../../domain/schedule-planner.ts';

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;

/** JST date ('YYYY-MM-DD') and time ('HH:MM') of an ISO instant, as the edit fields show them. */
export function jstFieldsOf(iso: string): { date: string; time: string } {
  const ms = new Date(iso).getTime();
  const local = new Date(ms + JST_OFFSET_MS);
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return { date: jstDateOf(ms), time: `${hh}:${mm}` };
}

export function retimeFixedDraft(draft: ScheduleDraft, input: { date: string; time: string }, now: Date): ScheduleDraft | PlanIssue {
  if (draft.state === 'cancelled') return { code: 'DRAFT_CANCELLED', message: '取り消した投稿は変更できません。' };
  if (draft.origin !== 'user_authored' || draft.mode !== 'manual_exact') {
    return { code: 'RETIME_NOT_ALLOWED', message: '日時を直接変えられるのは、日時を指定した投稿だけです。' };
  }
  const minutes = parseClock(input.time);
  const ms = minutes === null ? null : jstToUtcMs(input.date.trim(), minutes);
  if (ms === null) return { code: 'DATETIME_INVALID', message: '日時が正しくありません（例: 2026-10-15 / 09:30）。' };
  if (ms < now.getTime() + SCHEDULE_LIMITS.minLeadMinutes * MINUTE_MS) {
    return { code: 'DATETIME_IN_PAST', message: `日時が過去か、近すぎます（${SCHEDULE_LIMITS.minLeadMinutes}分以上先にしてください）。` };
  }
  if (ms > now.getTime() + SCHEDULE_LIMITS.maxHorizonDays * DAY_MS) {
    return { code: 'HORIZON_TOO_LONG', message: `${SCHEDULE_LIMITS.maxHorizonDays}日より先の日時は指定できません。` };
  }
  return { ...draft, scheduledAt: new Date(ms).toISOString(), state: 'editing' };
}
