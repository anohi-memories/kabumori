// 会社員AIラボ（ai_salaryman_lab）の開発日記コンテキスト: 読み込み・sanitize・題材選択。
//
// 正本は隣接する ai_lab_dev_diary_context.md（git管理、人/ChatGPTが手で書き足す）。ただし
// Supabase Edge Functionのデプロイは、functionが実際にimportするmodule graphだけをESZipへ
// バンドルする（Deno/Supabase公式ドキュメント確認済み）。同じディレクトリに置いた
// ファイルというだけでは、importされていない限りバンドルされる保証がない
// （`supabase/config.toml`の`static_files`で明示宣言すれば別だが、この機能では宣言していない
// し、新たに宣言すること自体が別の本番デプロイ設定変更になる）。
//
// そのためこのモジュールは、隣接する ai_lab_dev_diary_context.snapshot.ts
// （generate_ai_lab_dev_diary_snapshot.tsが.mdから生成するcommit済みのTS定数）を通常の
// `import`として読み込む。importされた定数は、他の_shared/brand/*.tsのimportと同じく、
// module graphの一部として確実にバンドルされる。ファイル読み取りではないため、実行時に
// 「読めない」という失敗モード自体が無い。
//
// 代わりに正直に残る制約: .mdを書き換えたら generate_ai_lab_dev_diary_snapshot.ts を実行して
// snapshotを再生成し、両方をcommitしてから x-test-post を再デプロイしないと、投稿には反映
// されない。ai_lab_dev_diary_context_test.tsのparity testが、.mdとsnapshotの乖離を検知する。
//
// 安全側の設計: 個々のフィールドに、内部識別子（ブランチ名・タスクID・テーブル名・コミット
// ハッシュ・PR番号・鍵やトークンらしき文字列・メールアドレス・URL 等）が含まれていたら、その
// フィールドを黙って通さない。`changed` が弾かれたらエントリ全体を候補から除外する。

import { AI_LAB_DEV_DIARY_MARKDOWN_SNAPSHOT } from "./ai_lab_dev_diary_context.snapshot.ts";
import { type AiLabGenericThemeId, detectGenericThemes } from "./ai_lab_theme_guard.ts";

export type DevDiaryEntry = {
  date: string; // YYYY-MM-DD
  /** 人が付ける安定ID（`event_id:` 行）。本文・angle の修正や並べ替えでも変わらない出来事の鍵。 */
  eventId: string | null;
  project: string | null;
  changed: string;
  difficulty: string | null;
  decided: string | null;
  remaining: string | null;
  angles: string[];
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * True only for a real calendar date, not merely the YYYY-MM-DD shape. `new Date(...)` silently
 * normalizes an overflowing day/month (e.g. 2026-09-31 becomes 2026-10-01, 2026-02-29 -- 2026 is
 * not a leap year -- becomes 2026-03-01), which could otherwise let an impossible or mistyped
 * date pass freshness checks as if it were a real recent day. Round-trips the parsed UTC
 * year/month/day back against the input to catch exactly that normalization.
 */
export function isValidCalendarDate(dateString: string): boolean {
  if (!DATE_PATTERN.test(dateString)) return false;
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Anything matching one of these disqualifies the *field* it appears in. Deliberately broad and
// conservative: diary text is ordinary Japanese prose, so a false positive here just means one
// field (or, if it's `changed`, one entry) is skipped -- never partially redacted and shipped.
const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /https?:\/\//iu, // any URL
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u, // email address
  /\bsk-[A-Za-z0-9]{10,}\b/u, // API-secret-shaped token
  /\beyJ[A-Za-z0-9_-]{10,}\b/u, // JWT-shaped token
  /\b(?:g[1-4]|h[12]|k[1-4])\/[A-Za-z0-9._-]+/u, // branch-name-like (g4/..., h1/...)
  /\bclaude\/[A-Za-z0-9._-]+/iu, // branch-name-like (claude/...)
  /\bPR\s*#?\d+\b/iu, // PR reference
  /\b[0-9a-f]{7,40}\b/u, // git-commit-sha-shaped hex run
  /\bx-[a-z][a-z0-9-]{8,}-\d{8}\b/u, // task_id-shaped kebab-case string
  /\b(?:scheduled_posts|brand_memberships|post_execution_logs|admin_users|social_accounts|social_mobile_content_settings|service_role|RLS|RPC)\b/iu,
  /\bADMIN_INVITE_BINDING_SECRET\b/iu,
];

export function isSanitizedDiaryField(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return false;
  return !FORBIDDEN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Returns a copy with every unsafe optional field dropped to null and every unsafe angle removed.
 * Returns null (the whole entry excluded) only when `changed` itself is missing/unsafe, or the date
 * is malformed or not a real calendar date -- `changed` is the one field every consumer of this
 * module treats as required.
 */
export function sanitizeDiaryEntry(entry: DevDiaryEntry): DevDiaryEntry | null {
  if (!isValidCalendarDate(entry.date)) return null;
  if (!isSanitizedDiaryField(entry.changed)) return null;
  return {
    date: entry.date,
    eventId: entry.eventId && isValidDiaryEventId(entry.eventId, entry.date) ? entry.eventId : null,
    project: entry.project && isSanitizedDiaryField(entry.project) ? entry.project : null,
    changed: entry.changed,
    difficulty: entry.difficulty && isSanitizedDiaryField(entry.difficulty) ? entry.difficulty : null,
    decided: entry.decided && isSanitizedDiaryField(entry.decided) ? entry.decided : null,
    remaining: entry.remaining && isSanitizedDiaryField(entry.remaining) ? entry.remaining : null,
    angles: entry.angles.filter((angle) => isSanitizedDiaryField(angle)),
  };
}

// 公開して問題ない、人が付ける出来事ID: `YYYYMMDD-slug`（日付は見出しと一致、64文字以内）。
const DIARY_EVENT_ID_PATTERN = /^(\d{8})-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
// 内部識別子に見える区切り（PR番号・作業スロット名・DB/秘密まわりの語）。
const INTERNAL_ID_SEGMENT =
  /^(?:pr\d*|[ghkc][1-5]|task|branch|commit|claude|codex|rpc|rls|sql|db|table|token|secret|vault|key|supabase)$/u;

function looksLikeCommitHash(segment: string): boolean {
  return segment.length >= 7 && /^[0-9a-f]+$/u.test(segment) && /\d/u.test(segment) && /[a-f]/u.test(segment);
}

/** event_id の形式検証。日付部分が見出しの日付と一致し、内部識別子らしい区切りを含まないこと。 */
export function isValidDiaryEventId(eventId: string, date: string): boolean {
  if (eventId.length > 64) return false;
  const match = DIARY_EVENT_ID_PATTERN.exec(eventId);
  if (!match || match[1] !== date.replaceAll("-", "")) return false;
  return !eventId.split("-").slice(1).some((segment) =>
    INTERNAL_ID_SEGMENT.test(segment) || looksLikeCommitHash(segment)
  );
}

const LABELS = ["event_id", "project", "changed", "difficulty", "decided", "remaining", "angle"] as const;
type Label = (typeof LABELS)[number];

function isLabelLine(line: string): { label: Label; value: string } | null {
  for (const label of LABELS) {
    const prefix = `${label}:`;
    if (line.startsWith(prefix)) return { label, value: line.slice(prefix.length).trim() };
  }
  return null;
}

/**
 * Parses the canonical Markdown. Unknown lines (including the leading HTML comment / any prose
 * outside a labeled line) are ignored rather than rejected, so writing the format is forgiving; the
 * *content* safety check happens separately in sanitizeDiaryEntry, not here.
 */
export function parseDevDiaryMarkdown(markdown: string): DevDiaryEntry[] {
  const entries: DevDiaryEntry[] = [];
  let current: { date: string; eventId: string | null; project: string | null; changed: string | null; difficulty: string | null; decided: string | null; remaining: string | null; angles: string[] } | null = null;

  function flush() {
    if (current && current.changed !== null) {
      entries.push({
        date: current.date,
        eventId: current.eventId,
        project: current.project,
        changed: current.changed,
        difficulty: current.difficulty,
        decided: current.decided,
        remaining: current.remaining,
        angles: current.angles,
      });
    }
    current = null;
  }

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line);
    if (heading) {
      flush();
      current = { date: heading[1], eventId: null, project: null, changed: null, difficulty: null, decided: null, remaining: null, angles: [] };
      continue;
    }
    if (!current) continue;
    const labeled = isLabelLine(line);
    if (!labeled || labeled.value.length === 0) continue;
    if (labeled.label === "angle") {
      current.angles.push(labeled.value);
    } else if (labeled.label === "event_id") {
      current.eventId = labeled.value;
    } else if (labeled.label === "changed") {
      current.changed = labeled.value;
    } else {
      current[labeled.label] = labeled.value;
    }
  }
  flush();
  return entries;
}

/** Parses and sanitizes in one step; unsafe entries are excluded, never partially included. */
export function loadSanitizedDiaryEntries(markdown: string): DevDiaryEntry[] {
  return parseDevDiaryMarkdown(markdown).flatMap((entry) => {
    const safe = sanitizeDiaryEntry(entry);
    return safe ? [safe] : [];
  });
}

// Evergreen reflections in the account's approved style, used only when no fresh, safe diary entry
// exists. These are topic *seeds* (short prompts), not finished posts -- the generator still writes
// the actual text from the brand voice instructions. Style-inspired by, not copied from, the
// TASK-approved example posts; never claims something happened "today".
export const EVERGREEN_TOPIC_SEEDS: readonly string[] = [
  "個人開発は「作る」より「直す」時間のほうが長い日が普通にあるという実感",
  "AIに任せれば一発で完成するわけではなく、指示の出し方で詰まることが多いという話",
  "本業をしながらの個人開発は、毎日長時間やるより「今日は1つだけ終わらせる」方が続くという話",
  "複数のAIを役割分担させて、人間のチームのように動かしている感覚",
  "コードを書けなくても「何が違うか」を言葉にできる力が個人開発では重要だという気づき",
  "仕様を決める・作ってもらう・確認する・直してもらう、というサイクルに時間がかかる実感",
  "小さく進める習慣が、結局いちばん長続きするという話",
];

export type AiLabTopicSeedSelection = { topic: string; source: "diary" | "evergreen" };

function daysBetween(from: Date, to: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.floor((to.getTime() - from.getTime()) / msPerDay);
}

/**
 * Picks the concrete topic seed for one scheduled AI Lab post.
 *
 * Prefers the most recent sanitized diary entry within `maxAgeDays` of `now`, using one of its
 * angles (or `changed`, if it has none) as the seed -- randomized via the injected `random` so
 * repeated calls on the same day still vary. An entry dated in the future relative to `now` is
 * never selected (a diary-context typo must not make the generator claim something happened
 * "today" ahead of time). With no fresh, safe entry, falls back to a randomly chosen evergreen
 * reflection -- never a fabricated "today" claim.
 */
export function selectAiLabTopicSeed({
  markdown,
  now,
  maxAgeDays = 3,
  random = Math.random,
}: {
  markdown: string;
  now: Date;
  maxAgeDays?: number;
  random?: () => number;
}): AiLabTopicSeedSelection {
  const entries = loadSanitizedDiaryEntries(markdown)
    .filter((entry) => {
      const entryDate = new Date(`${entry.date}T00:00:00Z`);
      if (Number.isNaN(entryDate.getTime())) return false;
      const age = daysBetween(entryDate, now);
      return age >= 0 && age <= maxAgeDays;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const freshest = entries[0];
  if (freshest) {
    const candidates = freshest.angles.length > 0 ? freshest.angles : [freshest.changed];
    const topic = candidates[Math.floor(random() * candidates.length) % candidates.length];
    return { topic, source: "diary" };
  }

  const topic = EVERGREEN_TOPIC_SEEDS[Math.floor(random() * EVERGREEN_TOPIC_SEEDS.length) % EVERGREEN_TOPIC_SEEDS.length];
  return { topic, source: "evergreen" };
}

// ---------------------------------------------------------------------------------------------------
// 題材候補の組み立て（本番の呼び出し元 x-test-post が使う）。`selectAiLabTopicSeed`（上）は既存テスト互換の旧実装。
//
// 重複判定の単位は「文章」でも「切り口」でもなく【実際の開発イベント】。1つの日記エントリ（= 1つの
// event_id）から作る changed / difficulty / decided / angle の各切り口は、同じイベントに属する。
//
// この関数は「優先順に並べた候補」を返すだけで、どれを使うかは決めない。実際に使う題材は DB の
// claim_ai_lab_topic（ai_lab_topic_claims、migration 20261004090000）が、ブランド単位のロックの中で
// 先頭から順に「まだ誰も確保していない／クールダウン中でない」ものを1件だけ確保して決める。
// 同時に動いた2つの投稿処理が同じイベントを確保することはなく、確保できなかった側は X へ進まない。
// ---------------------------------------------------------------------------------------------------

// evergreen seed ごとの汎用テーマタグ（EVERGREEN_TOPIC_SEEDS と同じ並び）。DB 側の48時間テーマクールダウンに使う。
export const EVERGREEN_THEME_TAGS: ReadonlyArray<readonly AiLabGenericThemeId[]> = [
  ["unglamorous_work"],
  ["ai_trial_error"],
  [],
  [],
  [],
  ["rework_reduction", "unglamorous_work"],
  [],
];

/**
 * イベントの安定キー。DB 側（ai_lab_topic_claims.event_key の CHECK）と同じ形。
 * - 日記: `diary:<event_id>`（event_id は日記に人が書く安定ID。本文や並び順に依存しない）。
 * - evergreen: `evergreen-N`（EVERGREEN_TOPIC_SEEDS の添字）。evergreen は再利用される（DB 側で72時間／48時間のクールダウン）。
 */
export const AI_LAB_EVENT_KEY_PATTERN = /^(?:diary:\d{8}-[a-z][a-z0-9]*(?:-[a-z0-9]+)*|evergreen-\d{1,2})$/u;

export function diaryEventKey(eventId: string): string {
  return `diary:${eventId}`;
}

export function evergreenEventKey(index: number): string {
  return `evergreen-${index}`;
}

export type AiLabTopicExclusion = {
  /** 非機密の識別子のみ（日付・eventKey・unitKey）。本文は入れない。 */
  candidate: string;
  stage: "freshness" | "sanitize" | "theme_cooldown" | "recent_overlap";
  reason: string;
};

/** DB の claim 関数へ優先順に渡す1候補。topic（生成に渡す題材文）は DB へは送らない。 */
export type AiLabTopicCandidate = {
  kind: "diary" | "evergreen";
  eventKey: string;
  /** 例: "diary:20261001-x-auth#changed" / "evergreen-3"。ログ用の非機密ID。 */
  unitKey: string;
  themeTags: readonly AiLabGenericThemeId[];
  topic: string;
};

type TopicUnit = { key: string; seed: string };

function relativeDayLabel(age: number): string {
  if (age <= 0) return "今日";
  if (age === 1) return "昨日";
  return `${age}日前`;
}

/**
 * 1イベントの「切り口」を列挙する。どの切り口にも同じイベントの具体的な事実を添える。切り口は同じ
 * イベントの言い換えにすぎないので、候補にはこのうち1つしか入れない（イベントは1回しか確保されない）。
 */
export function diaryUnitsFor(
  entry: DevDiaryEntry,
  eventKey: string,
  age: number,
  exclusions: AiLabTopicExclusion[],
): TopicUnit[] {
  const facts = [
    `開発日記（${entry.date}、${relativeDayLabel(age)}の出来事）より。`,
    `できごと: ${entry.changed}`,
    entry.difficulty ? `詰まったこと: ${entry.difficulty}` : null,
    entry.decided ? `決めたこと: ${entry.decided}` : null,
  ].filter((line): line is string => line !== null).join("\n");

  const units: TopicUnit[] = [
    { key: `${eventKey}#changed`, seed: `${facts}\n今回の切り口: 何を作った・直したのか、実際に何が起きたのか` },
  ];
  if (entry.difficulty) {
    units.push({ key: `${eventKey}#difficulty`, seed: `${facts}\n今回の切り口: どこで詰まり、何に気づいたのか` });
  }
  if (entry.decided) {
    units.push({ key: `${eventKey}#decided`, seed: `${facts}\n今回の切り口: なぜその判断（止める・変える・決める）をしたのか` });
  }
  entry.angles.forEach((angle, index) => {
    // 具体的な出来事に触れない汎用角度（「下調べだけで1日」等）は使わない。
    const generic = detectGenericThemes(angle);
    if (generic.length > 0) {
      exclusions.push({
        candidate: `${eventKey}#angle${index + 1}`,
        stage: "theme_cooldown",
        reason: `GENERIC_THEME:${generic.join(",")}`,
      });
      return;
    }
    units.push({ key: `${eventKey}#angle${index + 1}`, seed: `${facts}\n今回の切り口: ${angle}` });
  });
  return units;
}

function pickByRotation<T>(items: readonly T[], rotationIndex: number): T {
  const safe = Number.isFinite(rotationIndex) ? Math.trunc(rotationIndex) : 0;
  return items[((safe % items.length) + items.length) % items.length];
}

function rotate<T>(items: readonly T[], rotationIndex: number): T[] {
  if (items.length === 0) return [];
  const safe = Number.isFinite(rotationIndex) ? Math.trunc(rotationIndex) : 0;
  const start = ((safe % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/**
 * 会社員AIラボの題材候補を優先順に並べる。
 *
 * 1. fresh（maxAgeDays以内）な日記イベントを新しい順に、1イベント1候補（切り口は rotationIndex で1つ選ぶ）
 * 2. evergreen seed 全件（rotationIndex で開始位置をずらす）
 *
 * 使用済み・確保中・クールダウン中の判定はここではしない（DB の claim が正本）。DB は先頭から確保を
 * 試みるので、未使用の fresh イベントがあれば必ずそれが evergreen より先に選ばれる。全候補が使えなければ
 * 確保なし＝その枠は投稿しない（evergreen のクールダウンを破って埋めない）。
 *
 * - event_id が無い・不正・重複している日記エントリは候補にしない（ログに理由を残す）。
 * - `recentPostTexts`（直近投稿本文。渡された場合のみ）と同じ汎用テーマの evergreen は候補から外す。
 * - 除外した候補は `exclusions` に理由コード付きで返す（PROJECT_RULES「候補選定と除外ログ」）。本文は入れない。
 */
export function buildAiLabTopicCandidates({
  markdown,
  now,
  rotationIndex,
  maxAgeDays = 3,
  recentPostTexts = [],
}: {
  markdown: string;
  now: Date;
  rotationIndex: number;
  maxAgeDays?: number;
  recentPostTexts?: readonly string[];
}): { candidates: AiLabTopicCandidate[]; exclusions: AiLabTopicExclusion[] } {
  const exclusions: AiLabTopicExclusion[] = [];
  const parsed = parseDevDiaryMarkdown(markdown);
  const idCounts = new Map<string, number>();
  for (const entry of parsed) {
    if (entry.eventId) idCounts.set(entry.eventId, (idCounts.get(entry.eventId) ?? 0) + 1);
  }

  const fresh: Array<{ entry: DevDiaryEntry; eventKey: string; age: number }> = [];
  for (const raw of parsed) {
    const entry = sanitizeDiaryEntry(raw);
    if (!entry) {
      exclusions.push({ candidate: raw.date, stage: "sanitize", reason: "DIARY_ENTRY_UNSAFE_OR_INVALID" });
      continue;
    }
    if (!entry.eventId) {
      exclusions.push({ candidate: entry.date, stage: "sanitize", reason: "DIARY_EVENT_ID_MISSING_OR_INVALID" });
      continue;
    }
    const eventKey = diaryEventKey(entry.eventId);
    if ((idCounts.get(entry.eventId) ?? 0) > 1) {
      exclusions.push({ candidate: eventKey, stage: "sanitize", reason: "DIARY_EVENT_ID_DUPLICATE" });
      continue;
    }
    const age = daysBetween(new Date(`${entry.date}T00:00:00Z`), now);
    if (age < 0) {
      exclusions.push({ candidate: eventKey, stage: "freshness", reason: "DIARY_ENTRY_IN_FUTURE" });
    } else if (age > maxAgeDays) {
      exclusions.push({ candidate: eventKey, stage: "freshness", reason: "DIARY_ENTRY_STALE" });
    } else {
      fresh.push({ entry, eventKey, age });
    }
  }
  fresh.sort((a, b) => (a.entry.date < b.entry.date ? 1 : a.entry.date > b.entry.date ? -1 : 0));

  const candidates: AiLabTopicCandidate[] = [];
  for (const { entry, eventKey, age } of fresh) {
    const units = diaryUnitsFor(entry, eventKey, age, exclusions);
    const unit = pickByRotation(units, rotationIndex);
    candidates.push({ kind: "diary", eventKey, unitKey: unit.key, themeTags: [], topic: unit.seed });
  }

  const recentThemes = new Set(recentPostTexts.flatMap((text) => detectGenericThemes(text)));
  const evergreenOrder = rotate(EVERGREEN_TOPIC_SEEDS.map((_, index) => index), rotationIndex);
  for (const index of evergreenOrder) {
    const key = evergreenEventKey(index);
    const tags = EVERGREEN_THEME_TAGS[index] ?? [];
    const overlap = tags.filter((id) => recentThemes.has(id));
    if (overlap.length > 0) {
      exclusions.push({ candidate: key, stage: "recent_overlap", reason: `RECENT_GENERIC_THEME:${overlap.join(",")}` });
      continue;
    }
    candidates.push({ kind: "evergreen", eventKey: key, unitKey: key, themeTags: tags, topic: EVERGREEN_TOPIC_SEEDS[index] });
  }
  return { candidates, exclusions };
}

/**
 * Returns the bundled diary Markdown snapshot. This is a plain `import`-ed constant (see the
 * header comment), not a file read, so there is no "missing/unreadable at runtime" failure mode
 * for the production Edge path -- unlike a raw file read, which Supabase's deploy bundling does
 * not guarantee for a non-imported sibling file. Kept async only so callers do not need to change
 * between this and a future IO-backed source; today it never rejects.
 */
export async function loadAiLabDevDiaryMarkdown(): Promise<string> {
  return AI_LAB_DEV_DIARY_MARKDOWN_SNAPSHOT;
}
