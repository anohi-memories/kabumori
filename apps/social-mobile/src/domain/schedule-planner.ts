/**
 * Unified AI / manual post scheduling (V1, local preview only).
 *
 * Pure planner: no React, no network, no storage. Every plan it produces is a LOCAL PREVIEW. Nothing here
 * can save a schedule, reach X or grant consent:
 *   - `persistence` is always 'local_only' and `publishable` is always false;
 *   - AI consultation's 「これで覚えて」 is not auto-post consent: AI slots only report whether the owner chose
 *     approvalMode 'auto_post_preference', and even then they stay unpublishable here;
 *   - a manual post needs its own per-post consent in a future backend (`manualPublishConsent` is always
 *     false in this module).
 *
 * Times are UTC instants (ISO strings) displayed in Asia/Tokyo; other zones are rejected. Random and AI
 * placement is seeded: the same input + seed gives the same slots (stable across re-render/restart), and
 * only an explicit re-roll (a new seed) moves them. Fixed manual slots never move. Anything that cannot be
 * placed is an explicit error -- never a silent drop, overrun or duplicate.
 */

export const SCHEDULE_TIME_ZONE = 'Asia/Tokyo';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const SCHEDULE_LIMITS = {
  /** Slot granularity for random / AI placement. */
  slotMinutes: 5,
  maxBatchPosts: 50,
  maxHorizonDays: 90,
  /** A post must start at least this far in the future. */
  minLeadMinutes: 5,
  /** Placement attempts per stratum before a plan is declared infeasible. */
  maxAttemptsPerPost: 400,
} as const;

/** Conservative defaults; callers may tighten or loosen them within validation. */
export const DEFAULT_SPACING = { minGapMinutes: 60, maxPostsPerDay: 10 } as const;

/** X counts most CJK characters twice; a standard account allows 280 weighted characters. */
export const X_STANDARD_WEIGHTED_LIMIT = 280;
const X_URL_WEIGHT = 23;

export type ScheduleOrigin = 'ai_generated' | 'user_authored';
export type ScheduleMode = 'manual_exact' | 'manual_random_batch' | 'manual_interval' | 'ai_flexible';
/** One way: editing -> previewed; cancelled is terminal. There is no "saved" or "scheduled" state locally. */
export type DraftState = 'editing' | 'previewed' | 'cancelled';
export type AiAutoPostConsent = 'granted_by_owner_setting' | 'not_granted';

export type ScheduleOwner = { accountId: string; brandId: string; platform: 'x' };

export type ScheduleDraft = ScheduleOwner & {
  /** Stable local id, derived from the batch id and the position at creation. */
  id: string;
  batchId: string;
  origin: ScheduleOrigin;
  mode: ScheduleMode;
  /** AI slots have no text yet: the AI writes it just before publishing (future backend). */
  text: string;
  /** UTC instant (ISO 8601). */
  scheduledAt: string;
  /** Exact manual time chosen by the user: never moved by any planner action. */
  fixed: boolean;
  state: DraftState;
  persistence: 'local_only';
  publishable: false;
  manualPublishConsent: false;
  /** AI slots only: whether the owner's settings opted in (still not publishable in this preview). */
  aiAutoPostConsent?: AiAutoPostConsent;
};

export type ScheduleBatch = ScheduleOwner & {
  id: string;
  mode: ScheduleMode;
  origin: ScheduleOrigin;
  /** Bumped only by an explicit re-roll. */
  seed: number;
  revision: number;
  request: BatchRequest;
};

export type DailyWindow = { start: string; end: string };
export type SpacingRule = { minGapMinutes: number; maxPostsPerDay: number };

export type ManualExactRequest = { mode: 'manual_exact'; posts: { text: string; date: string; time: string }[] };
export type ManualRandomRequest = {
  mode: 'manual_random_batch';
  texts: string[];
  dateFrom: string;
  dateTo: string;
  window: DailyWindow;
  /** 0 = Sunday ... 6 = Saturday; empty or missing = every day. */
  weekdays?: number[];
  excludedDates?: string[];
  /** Default false: the n-th text keeps the n-th (chronological) slot. */
  shuffleContent?: boolean;
};
export type ManualIntervalRequest = {
  mode: 'manual_interval';
  texts: string[];
  startDate: string;
  startTime: string;
  every: { unit: 'days' | 'hours'; value: number };
};
export type AiFlexibleRequest = {
  mode: 'ai_flexible';
  /** From the confirmed AI consultation settings. */
  frequencyTargetPerWeek: number;
  /** PUBLISH window chosen for this plan. The settings' generationWindow is AI generation timing, not this. */
  publishWindow: DailyWindow;
  dateFrom: string;
  dateTo: string;
  /** The owner's approvalMode; anything but 'auto_post_preference' means no auto-post consent. */
  approvalMode: string;
};
export type BatchRequest = ManualExactRequest | ManualRandomRequest | ManualIntervalRequest | AiFlexibleRequest;

export type PlanIssue = { code: string; message: string; index?: number };
export type PlanResult = { ok: true; batch: ScheduleBatch; drafts: ScheduleDraft[] } | { ok: false; issues: PlanIssue[] };

export type PlanContext = {
  owner: ScheduleOwner;
  now: Date;
  timeZone?: string;
  spacing?: SpacingRule;
  /** Weighted limit for manual text; AI automated publishing keeps its own (140 code point) server policy. */
  maxWeightedLength?: number;
  /** Already occupied instants for this account (server rows and other local drafts), UTC ISO. */
  occupied?: { scheduledAt: string; fixed: boolean }[];
  batchId: string;
  seed?: number;
};

// ---------------------------------------------------------------------------------------------------
// Time helpers (Asia/Tokyo has no DST: a fixed +09:00 offset)
// ---------------------------------------------------------------------------------------------------

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u;

function parseDate(value: string): { y: number; m: number; d: number } | null {
  const match = DATE_RE.exec(value.trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d ? { y, m, d } : null;
}

/** 'HH:MM' to minutes; '24:00' only where `allowEndOfDay`. */
export function parseClock(value: string, allowEndOfDay = false): number | null {
  const text = value.trim();
  if (allowEndOfDay && text === '24:00') return 24 * 60;
  const match = TIME_RE.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** UTC ms of a JST wall-clock date + minutes after midnight. */
export function jstToUtcMs(date: string, minutes: number): number | null {
  const parsed = parseDate(date);
  if (!parsed) return null;
  return Date.UTC(parsed.y, parsed.m - 1, parsed.d) + minutes * MINUTE_MS - JST_OFFSET_MS;
}

/** JST calendar date (YYYY-MM-DD) of a UTC instant. */
export function jstDateOf(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'M/D(曜) HH:MM' in JST, for display. */
export function formatJst(iso: string): string {
  const local = new Date(new Date(iso).getTime() + JST_OFFSET_MS);
  const weekday = '日月火水木金土'[local.getUTCDay()];
  const hh = String(local.getUTCHours()).padStart(2, '0');
  const mm = String(local.getUTCMinutes()).padStart(2, '0');
  return `${local.getUTCMonth() + 1}/${local.getUTCDate()}(${weekday}) ${hh}:${mm}`;
}

function jstWeekday(date: string): number {
  const parsed = parseDate(date)!;
  return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d)).getUTCDay();
}

function datesBetween(from: string, to: string): string[] {
  const start = jstToUtcMs(from, 0)!;
  const end = jstToUtcMs(to, 0)!;
  const dates: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) dates.push(jstDateOf(ms));
  return dates;
}

// ---------------------------------------------------------------------------------------------------
// Text policy
// ---------------------------------------------------------------------------------------------------

function isWide(codePoint: number): boolean {
  return (codePoint >= 0x1100 && codePoint <= 0x11ff) || (codePoint >= 0x2e80 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af) || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || (codePoint >= 0xff00 && codePoint <= 0xffef)
    || codePoint >= 0x1f000;
}

/** X-style weighted length: wide characters and emoji count 2, a URL counts 23. Conservative approximation. */
export function xWeightedLength(text: string): number {
  let total = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/gu, () => {
    total += X_URL_WEIGHT;
    return '';
  });
  for (const char of withoutUrls) total += isWide(char.codePointAt(0)!) ? 2 : 1;
  return total;
}

function textIssues(texts: string[], limit: number): PlanIssue[] {
  const issues: PlanIssue[] = [];
  texts.forEach((text, index) => {
    const trimmed = text.trim();
    if (!trimmed) issues.push({ code: 'TEXT_EMPTY', message: `${index + 1}件目の本文が空です。`, index });
    else if (xWeightedLength(trimmed) > limit) {
      issues.push({ code: 'TEXT_TOO_LONG', message: `${index + 1}件目の本文が長すぎます（Xの上限は全角で約${Math.floor(limit / 2)}文字）。`, index });
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------------------------------
// Seeded randomness (deterministic: mulberry32)
// ---------------------------------------------------------------------------------------------------

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable seed from a string (FNV-1a), e.g. the batch id. */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------------------------------
// Validation shared by every mode
// ---------------------------------------------------------------------------------------------------

function contextIssues(context: PlanContext): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if ((context.timeZone ?? SCHEDULE_TIME_ZONE) !== SCHEDULE_TIME_ZONE) {
    issues.push({ code: 'TIME_ZONE_UNSUPPORTED', message: '現在は日本時間（Asia/Tokyo）のみ対応しています。' });
  }
  const spacing = context.spacing ?? DEFAULT_SPACING;
  if (!Number.isInteger(spacing.minGapMinutes) || spacing.minGapMinutes < 0 || spacing.minGapMinutes > 24 * 60) {
    issues.push({ code: 'SPACING_INVALID', message: '投稿の間隔の設定が正しくありません。' });
  }
  if (!Number.isInteger(spacing.maxPostsPerDay) || spacing.maxPostsPerDay < 1 || spacing.maxPostsPerDay > 48) {
    issues.push({ code: 'DAILY_CAPACITY_INVALID', message: '1日の上限件数の設定が正しくありません。' });
  }
  if (!context.owner.accountId || !context.owner.brandId) {
    issues.push({ code: 'ACCOUNT_REQUIRED', message: '投稿するアカウントを選んでください。' });
  }
  return issues;
}

function windowMinutes(window: DailyWindow): { start: number; end: number } | PlanIssue {
  const start = parseClock(window.start);
  const end = parseClock(window.end, true);
  if (start === null || end === null) return { code: 'WINDOW_INVALID', message: '時間帯は「09:00」の形で入力してください（終わりは24:00まで）。' };
  if (end <= start) return { code: 'WINDOW_EMPTY', message: '時間帯の終わりは始まりより後にしてください。' };
  return { start, end };
}

function rangeIssues(from: string, to: string, nowMs: number): PlanIssue[] {
  const start = jstToUtcMs(from, 0);
  const end = jstToUtcMs(to, 0);
  if (start === null || end === null) return [{ code: 'DATE_INVALID', message: '日付は「2026-10-15」の形で入力してください。' }];
  if (end < start) return [{ code: 'DATE_RANGE_REVERSED', message: '期間の終わりは始まりより後にしてください。' }];
  if ((end - start) / DAY_MS + 1 > SCHEDULE_LIMITS.maxHorizonDays) {
    return [{ code: 'HORIZON_TOO_LONG', message: `期間は${SCHEDULE_LIMITS.maxHorizonDays}日以内にしてください。` }];
  }
  if (end + DAY_MS <= nowMs) return [{ code: 'DATE_IN_PAST', message: '期間がすでに過ぎています。' }];
  return [];
}

/** Can `ms` be added next to `taken` without breaking the gap or the per-day capacity? */
function fits(ms: number, taken: number[], spacing: SpacingRule): boolean {
  const gap = spacing.minGapMinutes * MINUTE_MS;
  if (taken.some((other) => Math.abs(other - ms) < Math.max(gap, 1))) return false;
  const day = jstDateOf(ms);
  return taken.filter((other) => jstDateOf(other) === day).length < spacing.maxPostsPerDay;
}

function makeDrafts(context: PlanContext, mode: ScheduleMode, origin: ScheduleOrigin, items: { text: string; ms: number; fixed: boolean }[],
  extra: Partial<ScheduleDraft> = {}): ScheduleDraft[] {
  return items.map((item, index) => ({
    ...context.owner,
    id: `${context.batchId}:${index}`,
    batchId: context.batchId,
    origin,
    mode,
    text: item.text.trim(),
    scheduledAt: new Date(item.ms).toISOString(),
    fixed: item.fixed,
    state: 'previewed' as const,
    persistence: 'local_only' as const,
    publishable: false as const,
    manualPublishConsent: false as const,
    ...extra,
  }));
}

function batchOf(context: PlanContext, request: BatchRequest, seed: number, revision = 0): ScheduleBatch {
  const origin: ScheduleOrigin = request.mode === 'ai_flexible' ? 'ai_generated' : 'user_authored';
  return { ...context.owner, id: context.batchId, mode: request.mode, origin, seed, revision, request };
}

// ---------------------------------------------------------------------------------------------------
// Placement for random and AI modes: stratified, seeded, gap- and capacity-aware
// ---------------------------------------------------------------------------------------------------

function candidateSlots(dates: string[], window: { start: number; end: number }, nowMs: number): number[] {
  const slots: number[] = [];
  const earliest = nowMs + SCHEDULE_LIMITS.minLeadMinutes * MINUTE_MS;
  for (const date of dates) {
    // The last slot starts before the window end (a 24:00 end allows up to 23:55).
    for (let minute = window.start; minute < window.end; minute += SCHEDULE_LIMITS.slotMinutes) {
      const ms = jstToUtcMs(date, minute)!;
      if (ms >= earliest) slots.push(ms);
    }
  }
  return slots;
}

/**
 * Picks `count` slots: the candidate list is split into `count` chronological strata and one slot is drawn
 * per stratum (seeded), so posts spread over the range instead of clustering. Each pick respects the gap and
 * per-day capacity against occupied slots and earlier picks; a stratum that cannot fit is retried within a
 * bounded number of attempts, then the whole placement fails.
 */
function placeSpread(count: number, candidates: number[], occupied: number[], spacing: SpacingRule, seed: number):
  { ok: true; slots: number[] } | { ok: false; issue: PlanIssue } {
  if (count === 0) return { ok: true, slots: [] };
  if (candidates.length < count) {
    return { ok: false, issue: { code: 'NOT_ENOUGH_SLOTS', message: `指定した期間と時間帯に入るのは最大${candidates.length}枠です（${count}件が必要）。` } };
  }
  const random = seededRandom(seed);
  const taken = [...occupied];
  const picked: number[] = [];
  const size = candidates.length / count;
  for (let index = 0; index < count; index += 1) {
    const from = Math.floor(index * size);
    const to = Math.max(from + 1, Math.floor((index + 1) * size));
    const stratum = candidates.slice(from, to);
    let chosen: number | null = null;
    for (let attempt = 0; attempt < Math.min(SCHEDULE_LIMITS.maxAttemptsPerPost, stratum.length * 2); attempt += 1) {
      const ms = stratum[Math.floor(random() * stratum.length)];
      if (fits(ms, taken, spacing)) {
        chosen = ms;
        break;
      }
    }
    // Deterministic fallback: scan the stratum in order before giving up.
    if (chosen === null) chosen = stratum.find((ms) => fits(ms, taken, spacing)) ?? null;
    if (chosen === null) {
      return {
        ok: false,
        issue: { code: 'SPACING_INFEASIBLE', message: `間隔（${spacing.minGapMinutes}分）や1日の上限（${spacing.maxPostsPerDay}件）を守ると、${count}件を配置できません。期間や時間帯を広げてください。` },
      };
    }
    taken.push(chosen);
    picked.push(chosen);
  }
  return { ok: true, slots: picked.sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------------------------------
// Public planners
// ---------------------------------------------------------------------------------------------------

export function planBatch(request: BatchRequest, context: PlanContext): PlanResult {
  const issues = contextIssues(context);
  if (issues.length) return { ok: false, issues };
  const spacing = context.spacing ?? DEFAULT_SPACING;
  const limit = context.maxWeightedLength ?? X_STANDARD_WEIGHTED_LIMIT;
  const nowMs = context.now.getTime();
  const occupied = (context.occupied ?? []).map((item) => new Date(item.scheduledAt).getTime());
  const seed = context.seed ?? seedFrom(context.batchId);

  switch (request.mode) {
    case 'manual_exact': {
      if (!request.posts.length) return { ok: false, issues: [{ code: 'NO_POSTS', message: '本文を1件以上入力してください。' }] };
      if (request.posts.length > SCHEDULE_LIMITS.maxBatchPosts) {
        return { ok: false, issues: [{ code: 'TOO_MANY_POSTS', message: `一度に作れるのは${SCHEDULE_LIMITS.maxBatchPosts}件までです。` }] };
      }
      const found = textIssues(request.posts.map((post) => post.text), limit);
      const items: { text: string; ms: number; fixed: boolean }[] = [];
      const taken = [...occupied];
      request.posts.forEach((post, index) => {
        const minutes = parseClock(post.time);
        const ms = minutes === null ? null : jstToUtcMs(post.date, minutes);
        if (ms === null) {
          found.push({ code: 'DATETIME_INVALID', message: `${index + 1}件目の日時が正しくありません（例: 2026-10-15 / 09:30）。`, index });
          return;
        }
        if (ms < nowMs + SCHEDULE_LIMITS.minLeadMinutes * MINUTE_MS) {
          found.push({ code: 'DATETIME_IN_PAST', message: `${index + 1}件目の日時が過去か、近すぎます（${SCHEDULE_LIMITS.minLeadMinutes}分以上先にしてください）。`, index });
          return;
        }
        // A user-fixed time is never moved: a clash is reported, not resolved.
        if (!fits(ms, taken, spacing)) {
          found.push({ code: 'FIXED_TIME_CONFLICT', message: `${index + 1}件目（${formatJst(new Date(ms).toISOString())}）が他の予定と近すぎるか、その日の上限を超えます。`, index });
          return;
        }
        taken.push(ms);
        items.push({ text: post.text, ms, fixed: true });
      });
      if (found.length) return { ok: false, issues: found };
      return { ok: true, batch: batchOf(context, request, seed), drafts: makeDrafts(context, 'manual_exact', 'user_authored', items) };
    }

    case 'manual_random_batch': {
      const found = [...textIssues(request.texts, limit), ...rangeIssues(request.dateFrom, request.dateTo, nowMs)];
      if (!request.texts.length) found.push({ code: 'NO_POSTS', message: '本文を1件以上入力してください。' });
      if (request.texts.length > SCHEDULE_LIMITS.maxBatchPosts) found.push({ code: 'TOO_MANY_POSTS', message: `一度に作れるのは${SCHEDULE_LIMITS.maxBatchPosts}件までです。` });
      const window = windowMinutes(request.window);
      if ('code' in window) found.push(window);
      if (request.weekdays?.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) found.push({ code: 'WEEKDAYS_INVALID', message: '曜日の指定が正しくありません。' });
      if (found.length || 'code' in window) return { ok: false, issues: found };
      const excluded = new Set((request.excludedDates ?? []).map((date) => date.trim()));
      const dates = datesBetween(request.dateFrom, request.dateTo)
        .filter((date) => !excluded.has(date) && (!request.weekdays?.length || request.weekdays.includes(jstWeekday(date))));
      const placed = placeSpread(request.texts.length, candidateSlots(dates, window, nowMs), occupied, spacing, seed);
      if (!placed.ok) return { ok: false, issues: [placed.issue] };
      const texts = request.shuffleContent ? shuffled(request.texts, seededRandom(seed ^ 0x9e3779b9)) : request.texts;
      const items = placed.slots.map((ms, index) => ({ text: texts[index], ms, fixed: false }));
      return { ok: true, batch: batchOf(context, request, seed), drafts: makeDrafts(context, 'manual_random_batch', 'user_authored', items) };
    }

    case 'manual_interval': {
      const found = textIssues(request.texts, limit);
      if (!request.texts.length) found.push({ code: 'NO_POSTS', message: '本文を1件以上入力してください。' });
      if (request.texts.length > SCHEDULE_LIMITS.maxBatchPosts) found.push({ code: 'TOO_MANY_POSTS', message: `一度に作れるのは${SCHEDULE_LIMITS.maxBatchPosts}件までです。` });
      const { unit, value } = request.every;
      const validEvery = Number.isInteger(value) && (unit === 'days' ? value >= 1 && value <= 30 : value >= 1 && value <= 72);
      if (!validEvery) found.push({ code: 'INTERVAL_INVALID', message: '間隔は「1〜30日」または「1〜72時間」で指定してください。' });
      const minutes = parseClock(request.startTime);
      const first = minutes === null ? null : jstToUtcMs(request.startDate, minutes);
      if (first === null) found.push({ code: 'DATETIME_INVALID', message: '開始日時が正しくありません（例: 2026-10-15 / 09:30）。' });
      else if (first < nowMs + SCHEDULE_LIMITS.minLeadMinutes * MINUTE_MS) found.push({ code: 'DATETIME_IN_PAST', message: '開始日時が過去か、近すぎます。' });
      if (found.length || first === null) return { ok: false, issues: found };
      const step = (unit === 'days' ? value * DAY_MS : value * 60 * MINUTE_MS);
      const last = first + step * (request.texts.length - 1);
      if ((last - first) / DAY_MS > SCHEDULE_LIMITS.maxHorizonDays) {
        return { ok: false, issues: [{ code: 'HORIZON_TOO_LONG', message: `最後の投稿が${SCHEDULE_LIMITS.maxHorizonDays}日より先になります。` }] };
      }
      const taken = [...occupied];
      const items: { text: string; ms: number; fixed: boolean }[] = [];
      const conflicts: PlanIssue[] = [];
      request.texts.forEach((text, index) => {
        const ms = first + step * index;
        if (!fits(ms, taken, spacing)) {
          // Never shifted silently: report it with an explicit alternative the user may choose.
          const alternative = nextFreeSlot(ms, taken, spacing);
          conflicts.push({
            code: 'INTERVAL_SLOT_BLOCKED',
            message: `${index + 1}件目（${formatJst(new Date(ms).toISOString())}）は他の予定と重なります。${alternative === null ? '' : `空いている近い時刻: ${formatJst(new Date(alternative).toISOString())}`}`,
            index,
          });
          return;
        }
        taken.push(ms);
        items.push({ text, ms, fixed: false });
      });
      if (conflicts.length) return { ok: false, issues: conflicts };
      return { ok: true, batch: batchOf(context, request, seed), drafts: makeDrafts(context, 'manual_interval', 'user_authored', items) };
    }

    case 'ai_flexible': {
      const found = rangeIssues(request.dateFrom, request.dateTo, nowMs);
      const frequency = request.frequencyTargetPerWeek;
      if (!Number.isInteger(frequency) || frequency < 0 || frequency > 14) found.push({ code: 'FREQUENCY_INVALID', message: '週あたりの投稿回数は0〜14回です。' });
      const window = windowMinutes(request.publishWindow);
      if ('code' in window) found.push(window);
      if (found.length || 'code' in window) return { ok: false, issues: found };
      const dates = datesBetween(request.dateFrom, request.dateTo);
      const count = Math.round((frequency * dates.length) / 7);
      if (count > SCHEDULE_LIMITS.maxBatchPosts) return { ok: false, issues: [{ code: 'TOO_MANY_POSTS', message: `この期間では${count}件になり、上限（${SCHEDULE_LIMITS.maxBatchPosts}件）を超えます。` }] };
      const placed = placeSpread(count, candidateSlots(dates, window, nowMs), occupied, spacing, seed);
      if (!placed.ok) return { ok: false, issues: [placed.issue] };
      const consent: AiAutoPostConsent = request.approvalMode === 'auto_post_preference' ? 'granted_by_owner_setting' : 'not_granted';
      const items = placed.slots.map((ms) => ({ text: '', ms, fixed: false }));
      return {
        ok: true,
        batch: batchOf(context, request, seed),
        drafts: makeDrafts(context, 'ai_flexible', 'ai_generated', items, { aiAutoPostConsent: consent }),
      };
    }
  }
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function nextFreeSlot(fromMs: number, taken: number[], spacing: SpacingRule): number | null {
  const step = SCHEDULE_LIMITS.slotMinutes * MINUTE_MS;
  for (let ms = fromMs + step, guard = 0; guard < (2 * DAY_MS) / step; ms += step, guard += 1) {
    if (fits(ms, taken, spacing)) return ms;
  }
  return null;
}

/**
 * Explicit re-roll: a new seed for ONE flexible batch (random or AI). Exact and interval batches cannot be
 * re-rolled. Other batches' slots are passed as `occupied` and stay where they are.
 */
export function rerollBatch(batch: ScheduleBatch, context: Omit<PlanContext, 'batchId' | 'seed'>): PlanResult {
  if (batch.mode !== 'manual_random_batch' && batch.mode !== 'ai_flexible') {
    return { ok: false, issues: [{ code: 'REROLL_NOT_ALLOWED', message: '日時を指定した投稿は再抽選しません。' }] };
  }
  const nextSeed = seededRandom(batch.seed ^ (batch.revision + 1))() * 4294967296 >>> 0;
  const result = planBatch(batch.request, { ...context, batchId: batch.id, seed: nextSeed });
  return result.ok ? { ...result, batch: { ...result.batch, revision: batch.revision + 1 } } : result;
}

// ---------------------------------------------------------------------------------------------------
// Editing a local plan (one-way state, text edits, reorder, cancel)
// ---------------------------------------------------------------------------------------------------

export function editDraftText(draft: ScheduleDraft, text: string, maxWeightedLength = X_STANDARD_WEIGHTED_LIMIT): ScheduleDraft | PlanIssue {
  if (draft.state === 'cancelled') return { code: 'DRAFT_CANCELLED', message: '取り消した投稿は編集できません。' };
  if (draft.origin === 'ai_generated') return { code: 'AI_TEXT_NOT_EDITABLE', message: 'AI自動投稿の本文は、投稿の直前にAIが作成します。' };
  const issue = textIssues([text], maxWeightedLength)[0];
  if (issue) return { ...issue, index: undefined };
  return { ...draft, text: text.trim(), state: 'editing' };
}

export function cancelDraft(draft: ScheduleDraft): ScheduleDraft {
  return { ...draft, state: 'cancelled' };
}

/**
 * Moves a text up or down within its batch: the slots stay in place and the texts swap, so a reorder never
 * changes any time. AI slots have no text and are not reordered.
 */
export function moveDraftText(drafts: ScheduleDraft[], draftId: string, direction: -1 | 1): ScheduleDraft[] {
  const target = drafts.find((draft) => draft.id === draftId);
  if (!target || target.origin !== 'user_authored' || target.state === 'cancelled') return drafts;
  const siblings = drafts
    .filter((draft) => draft.batchId === target.batchId && draft.state !== 'cancelled')
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const index = siblings.findIndex((draft) => draft.id === draftId);
  const other = siblings[index + direction];
  if (!other) return drafts;
  return drafts.map((draft) => {
    if (draft.id === target.id) return { ...draft, text: other.text, state: 'editing' as const };
    if (draft.id === other.id) return { ...draft, text: target.text, state: 'editing' as const };
    return draft;
  });
}

// ---------------------------------------------------------------------------------------------------
// Unified view: server rows (read-only) + local preview drafts, one account at a time
// ---------------------------------------------------------------------------------------------------

export type ServerScheduledPost = { id: string; accountId: string; scheduledAt: string; origin: string; status: string; text: string };

export type UnifiedItem =
  | { source: 'server'; id: string; accountId: string; scheduledAt: string; origin: ScheduleOrigin | 'other'; status: string; text: string }
  | { source: 'local_preview'; id: string; accountId: string; scheduledAt: string; origin: ScheduleOrigin; draft: ScheduleDraft };

export type UnifiedFilter = 'all' | 'ai' | 'manual';
export type ScheduleConflict = { firstId: string; secondId: string; minutesApart: number };

export function buildUnifiedSchedule(input: {
  accountId: string | null;
  serverPosts: ServerScheduledPost[];
  drafts: ScheduleDraft[];
  filter?: UnifiedFilter;
}): UnifiedItem[] {
  if (!input.accountId) return [];
  const server: UnifiedItem[] = input.serverPosts
    .filter((post) => post.accountId === input.accountId)
    .map((post) => ({
      source: 'server' as const,
      id: post.id,
      accountId: post.accountId,
      scheduledAt: post.scheduledAt,
      origin: post.origin === 'ai_generated' ? 'ai_generated' as const : post.origin === 'user_authored' || post.origin === 'manual' ? 'user_authored' as const : 'other' as const,
      status: post.status,
      text: post.text,
    }));
  const local: UnifiedItem[] = input.drafts
    .filter((draft) => draft.accountId === input.accountId && draft.state !== 'cancelled')
    .map((draft) => ({ source: 'local_preview' as const, id: draft.id, accountId: draft.accountId, scheduledAt: draft.scheduledAt, origin: draft.origin, draft }));
  const filter = input.filter ?? 'all';
  return [...server, ...local]
    .filter((item) => filter === 'all' || (filter === 'ai' ? item.origin === 'ai_generated' : item.origin === 'user_authored'))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id));
}

/** Pairs closer than the minimum gap (same account). Nothing is dropped or moved here. */
export function detectConflicts(items: UnifiedItem[], minGapMinutes: number = DEFAULT_SPACING.minGapMinutes): ScheduleConflict[] {
  const sorted = [...items].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  const conflicts: ScheduleConflict[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.accountId !== current.accountId) continue;
    const minutes = (new Date(current.scheduledAt).getTime() - new Date(previous.scheduledAt).getTime()) / MINUTE_MS;
    if (minutes < Math.max(minGapMinutes, 1)) conflicts.push({ firstId: previous.id, secondId: current.id, minutesApart: minutes });
  }
  return conflicts;
}

/**
 * Explicit "resolve conflicts": only flexible local drafts move, in priority order -- AI slots first, then
 * manual random/interval slots; fixed manual and server rows never move. Each moved draft goes to the next
 * free slot inside its own batch's allowed window/days (random and AI) or is reported (interval: the user
 * picked the rhythm, so it is not shifted). Anything that cannot be placed is returned as an issue.
 */
export function resolveConflicts(input: {
  drafts: ScheduleDraft[];
  batches: ScheduleBatch[];
  serverPosts: ServerScheduledPost[];
  now: Date;
  spacing?: SpacingRule;
}): { drafts: ScheduleDraft[]; moved: string[]; issues: PlanIssue[] } {
  const spacing = input.spacing ?? DEFAULT_SPACING;
  const active = input.drafts.filter((draft) => draft.state !== 'cancelled');
  const rank = (draft: ScheduleDraft) => (draft.fixed ? 0 : draft.origin === 'user_authored' ? 1 : 2);
  const ordered = [...active].sort((a, b) => rank(a) - rank(b) || a.scheduledAt.localeCompare(b.scheduledAt));
  const result = new Map(input.drafts.map((draft) => [draft.id, draft]));
  const moved: string[] = [];
  const issues: PlanIssue[] = [];
  const takenByAccount = new Map<string, number[]>();
  const taken = (accountId: string) => {
    if (!takenByAccount.has(accountId)) {
      takenByAccount.set(accountId, input.serverPosts.filter((post) => post.accountId === accountId).map((post) => new Date(post.scheduledAt).getTime()));
    }
    return takenByAccount.get(accountId)!;
  };
  for (const draft of ordered) {
    const slots = taken(draft.accountId);
    const ms = new Date(draft.scheduledAt).getTime();
    if (fits(ms, slots, spacing)) {
      slots.push(ms);
      continue;
    }
    if (draft.fixed || draft.mode === 'manual_interval') {
      issues.push({ code: draft.fixed ? 'FIXED_TIME_CONFLICT' : 'INTERVAL_SLOT_BLOCKED', message: `${formatJst(draft.scheduledAt)} の投稿は他の予定と重なります。日時を変えるか、どちらかを取り消してください。` });
      slots.push(ms);
      continue;
    }
    const batch = input.batches.find((candidate) => candidate.id === draft.batchId);
    const request = batch?.request;
    const window = request && (request.mode === 'manual_random_batch' ? request.window : request.mode === 'ai_flexible' ? request.publishWindow : null);
    const range = request && (request.mode === 'manual_random_batch' || request.mode === 'ai_flexible') ? { from: request.dateFrom, to: request.dateTo } : null;
    const bounds = window ? windowMinutes(window) : null;
    if (!bounds || 'code' in bounds || !range) {
      issues.push({ code: 'RESOLVE_IMPOSSIBLE', message: `${formatJst(draft.scheduledAt)} の投稿を動かせる範囲が分かりません。` });
      continue;
    }
    const weekdays = request?.mode === 'manual_random_batch' ? request.weekdays : undefined;
    const excluded = new Set(request?.mode === 'manual_random_batch' ? request.excludedDates ?? [] : []);
    const dates = datesBetween(range.from, range.to).filter((date) => !excluded.has(date) && (!weekdays?.length || weekdays.includes(jstWeekday(date))));
    const free = candidateSlots(dates, bounds, input.now.getTime()).find((slot) => slot >= ms && fits(slot, slots, spacing))
      ?? candidateSlots(dates, bounds, input.now.getTime()).find((slot) => fits(slot, slots, spacing));
    if (free === undefined) {
      issues.push({ code: 'RESOLVE_IMPOSSIBLE', message: `${formatJst(draft.scheduledAt)} の投稿は、決めた期間と時間帯の中に空きがありません。` });
      continue;
    }
    slots.push(free);
    result.set(draft.id, { ...draft, scheduledAt: new Date(free).toISOString(), state: 'editing' });
    moved.push(draft.id);
  }
  return { drafts: input.drafts.map((draft) => result.get(draft.id)!), moved, issues };
}
