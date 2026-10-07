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
  /**
   * 1エントリに2回以上書かれた1行ラベル（event_id / project / changed / difficulty / decided / remaining）。
   * 空でなければエントリ全体が無効（後勝ちで event_id を差し替えて使用済みの出来事を別名で復活させない）。
   */
  duplicateLabels: string[];
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
  if (entry.duplicateLabels.length > 0) return null;
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
    duplicateLabels: [],
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
  let current: { date: string; eventId: string | null; project: string | null; changed: string | null; difficulty: string | null; decided: string | null; remaining: string | null; angles: string[]; seen: Set<string>; duplicateLabels: string[] } | null = null;

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
        duplicateLabels: current.duplicateLabels,
      });
    }
    current = null;
  }

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    const heading = /^##\s+(\d{4}-\d{2}-\d{2})\s*$/u.exec(line);
    if (heading) {
      flush();
      current = { date: heading[1], eventId: null, project: null, changed: null, difficulty: null, decided: null, remaining: null, angles: [], seen: new Set(), duplicateLabels: [] };
      continue;
    }
    if (!current) continue;
    const labeled = isLabelLine(line);
    if (!labeled) continue;
    // 1行ラベルは1エントリに1回だけ。2回目以降は値が空でも重複として記録し、後の値で上書きしない。
    // 重複のあるエントリは sanitizeDiaryEntry が丸ごと無効にする（後勝ちで event_id を差し替えさせない）。
    if (labeled.label !== "angle") {
      if (current.seen.has(labeled.label)) {
        if (!current.duplicateLabels.includes(labeled.label)) current.duplicateLabels.push(labeled.label);
        continue;
      }
      current.seen.add(labeled.label);
    }
    if (labeled.value.length === 0) continue;
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
  // --- 2026-10-07: diverse evergreen (Tier 2). Appended only: existing indices keep their meaning, because
  // DB claims refer to seeds by index (evergreen-N) and their cooldowns must keep applying to the same text.
  "平日の夜に30分だけ触る時間を決めておくと、個人開発が生活の一部になるという話",
  "本業で疲れている日は、新しい機能より小さな改善だけにすると続けやすいという実感",
  "週末にまとめてやろうとするより、平日に少しずつ触るほうが前に進みやすいという話",
  "本業の段取りの考え方が、個人開発の進め方にもそのまま役に立つという気づき",
  "仕事のあとに頭を切り替えるため、最初の5分は前回のメモを読むだけにしている話",
  "大きな機能を一度に作るより、画面1つ分ずつ完成させるほうが気持ちよく進むという話",
  "まず動くものを作ってから整える順番にすると、迷う時間が減るという実感",
  "小さな改善を積み重ねたアプリは、ある日ふと使いやすくなっていると気づく話",
  "完璧を目指す前に一度使ってみると、本当に直すべき場所が見えてくるという話",
  "思いついたことをすぐ試せるのが、AIと一緒に作る楽しさの一つだという話",
  "仕様を言葉で書き出すだけで、作りたいものの輪郭がはっきりするという気づき",
  "作ってみてから仕様を変えるのは失敗ではなく、自然な流れだと思えるようになった話",
  "バグが見つかったとき、原因を一緒に考えてくれる相手がいる心強さ",
  "一度直したはずの不具合がまた出てきたとき、確認の手順を見直すきっかけになった話",
  "やり直しを前提に計画すると、気持ちに余裕が生まれるという実感",
  "AIに頼むときは、完成形より先に「何を避けたいか」を伝えると伝わりやすいという話",
  "同じお願いでも、背景を一言添えるだけでAIの答えが変わるという気づき",
  "AIへの指示を短く区切って渡すと、確認もしやすくなるという話",
  "AIに説明しているうちに、自分の考えが整理されていくという実感",
  "指示がうまく伝わらないときは、例を1つ見せると一気に通じることがあるという話",
  "設計する役と確認する役を別のAIに分けると、見落としが減るという話",
  "AIどうしの意見が分かれたとき、最後に決めるのは人間の役目だという実感",
  "役割を決めてAIに任せると、自分は全体の流れを見ることに集中できるという話",
  "複数のAIに同じ質問をすると、考え方の違いが見えておもしろいという話",
  "画面の見た目は、スマホの実機で触ってみて初めて分かることが多いという話",
  "指で押しやすいかどうかは、実際に片手で操作してみないと気づけないという実感",
  "文字の大きさや余白の少しの違いで、アプリの印象が大きく変わるという気づき",
  "自分で毎日使ってみると、作っているときには気づかない不便さが見えてくる話",
  "ボタンの言葉を少し変えるだけで、迷わず使えるようになることがあるという話",
  "動いたと思っても、もう一度確認する習慣がトラブルを防いでくれるという話",
  "失敗した経験が、次に作るときの確認リストになっていくという実感",
  "公開前に一呼吸おいて見直す時間が、結果的にいちばんの近道だったという話",
  "安全のための確認は面倒でも、あとで安心につながるという気づき",
  "うまくいかなかった原因を書き残しておくと、同じつまずきを繰り返さずに済む話",
  "専門用語が分からなくても、困っていることを自分の言葉で伝えれば前に進めるという話",
  "作りたいものの使い方を具体的に説明できることが、いちばんの武器になるという実感",
  "技術の細かいところより、誰が何に困っているかを考える時間が大事だという気づき",
  "できあがった画面を見て「ここが違う」と言えることも、立派な開発の一部だという話",
  "分からないことを分からないと言える相手がいると、学ぶのが楽しくなるという話",
  "少し前なら諦めていたアイデアも、今は形にできるかもしれないと思えるようになった話",
  "AIのおかげで、一人でも試せることの幅が広がったという実感",
  "アイデアから動くものまでの距離が、以前よりずっと短くなったと感じる話",
  "作れるものが増えた分、何を作るかを選ぶことの大切さが増したという気づき",
  "新しいAIを使い始めるときは、まず小さなお願いから試して相性を見ているという話",
  "新しい道具に慣れるまでの少しの戸惑いも、楽しみの一部だと思えるようになった話",
  "新しいAIに期待しすぎず、得意なことを見つけていく姿勢が大事だという実感",
  "使い慣れたやり方と新しいやり方を、無理なく組み合わせていく話",
  "自動化できる部分が増えても、最後に公開するかどうかは自分で決めたいという話",
  "AIが出した案をそのまま使わず、一度自分の目で確かめる習慣についての話",
  "便利な仕組みほど、止め方や見直し方を先に決めておくと安心だという気づき",
  "任せる部分と自分で判断する部分を分けておくと、気持ちが楽になるという話",
  "使っているAIが更新されたあと、同じお願いでも答え方が変わることがあるという話",
  "AIの性能が上がっても、何を頼むかを考えるのは自分だという実感",
  "道具が良くなるほど、使う側の工夫で差が出ると感じる話",
  "AIの進歩を追いかけるより、自分の作りたいものに合うかを大事にしたいという話",
  // --- Tier 3: continuity reserve. Plain, safe, general reflections kept at the END of the candidate order
  // so posting continues when diary and Tier 2 are all cooling down. No recent-AI facts, no "today" claims.
  "少しだけでも手を動かすと、気持ちが前に向くという個人開発の小さな習慣",
  "AIと相談しながら作ることで、一人でも心細くないと感じるという話",
  "便利になっても、指示を出したり確かめたりするのは人の役目だという一般的な実感",
  "AIの進歩が速いと感じる中で、自分のペースで使っていけばいいと思えるという話",
  "自分の作業が少し楽になったことで、別のことに時間を使えるようになったという一般論",
  "作りたいものがある日は、短い時間でも机に向かいたくなるという話",
  "できることが少しずつ増えていく感覚が、続けるいちばんの理由になっているという話",
  "誰かの役に立つかもしれないと思うと、小さな改善にも意味を感じられるという話",
  "作る過程で迷ったときは、使う人の気持ちを想像すると答えが見えやすいという話",
  "新しいことを学ぶとき、AIに質問できるだけで最初の一歩が軽くなるという話",
  "昨日より少しだけ良くなったと感じられることを、大切にしているという話",
  "焦らず一つずつ形にしていくことが、結局いちばんの近道だと感じている話",
];

/** First index of the Tier 3 continuity reserve inside EVERGREEN_TOPIC_SEEDS (everything from here on). */
export const AI_LAB_CONTINUITY_RESERVE_START = 62;

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
  // 2026-10-07 additions (Tier 2 and the Tier 3 continuity reserve): written to avoid every generic-theme
  // pattern, so they carry no theme tag and are governed by the 72h per-seed cooldown alone.
  ...Array.from({ length: 67 }, (): readonly AiLabGenericThemeId[] => []),
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
  stage: "freshness" | "sanitize" | "theme_cooldown" | "recent_overlap" | "capacity";
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
    if (raw.duplicateLabels.length > 0) {
      exclusions.push({ candidate: raw.date, stage: "sanitize", reason: `DIARY_DUPLICATE_LABEL:${raw.duplicateLabels.join(",")}` });
      continue;
    }
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
  // Tier 2 (diverse evergreen) rotates by rotationIndex; the Tier 3 continuity reserve always follows it,
  // also rotated, so it is used only when diary and every Tier 2 seed are cooling down or unresolved.
  const indices = EVERGREEN_TOPIC_SEEDS.map((_, index) => index);
  const evergreenOrder = [
    ...rotate(indices.slice(0, AI_LAB_CONTINUITY_RESERVE_START), rotationIndex),
    ...rotate(indices.slice(AI_LAB_CONTINUITY_RESERVE_START), rotationIndex),
  ];
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
  // The DB claim accepts at most AI_LAB_MAX_CLAIM_CANDIDATES per call. Diary candidates come first, so a
  // trim only ever drops the lowest-priority evergreen entries (it never happens with today's pool).
  for (const dropped of candidates.splice(AI_LAB_MAX_CLAIM_CANDIDATES)) {
    exclusions.push({ candidate: dropped.eventKey, stage: "capacity", reason: "CLAIM_CANDIDATE_LIMIT" });
  }
  return { candidates, exclusions };
}

/** Upper bound of candidates per claim call; equal to the DB claim_ai_lab_topic argument limit. */
export const AI_LAB_MAX_CLAIM_CANDIDATES = 128;

/**
 * Returns the bundled diary Markdown snapshot. This is a plain `import`-ed constant (see the
 * header comment), not a file read, so there is no "missing/unreadable at runtime" failure mode
 * for the production Edge path -- unlike a raw file read, which Supabase's deploy bundling does
 * not guarantee for a non-imported sibling file. Kept async only so callers do not need to change
 * between this and a future IO-backed source; today it never rejects.
 */
export function loadAiLabDevDiaryMarkdown(): Promise<string> {
  return Promise.resolve(AI_LAB_DEV_DIARY_MARKDOWN_SNAPSHOT);
}
