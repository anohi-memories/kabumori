import type { ScheduleMode } from '../../domain/schedule-planner.ts';

export const MODE_LABELS: Record<ScheduleMode, string> = {
  manual_exact: '指定日時',
  manual_random_batch: 'まとめてランダム',
  manual_interval: '間隔指定',
  ai_flexible: 'AI自動予約',
};

/** Shown on every preview: nothing here is saved, reserved or posted. */
export const PREVIEW_LABEL = 'プレビュー／未予約・投稿されません';
