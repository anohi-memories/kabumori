# Claude Task 4

- task_id: x-ai-salaryman-dev-diary-pr61-date-validation-fix-20260930
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（中）
- target: PR #61
- purpose: H2最終レビューで見つかった impossible calendar date のみを修正し、PR #61をmerge/deploy可能な状態にする。

## Fix

Current issue:
- diary date validation checks only YYYY-MM-DD shape
- JavaScript normalizes impossible dates such as 2026-09-31
- this can incorrectly pass freshness and allow a diary topic to be treated as recent

Required:
- validate actual calendar dates strictly
- use round-trip validation or equivalent so impossible dates are rejected
- reject invalid leap-day/month/day combinations
- impossible dates must fall back to evergreen, never diary/current-progress mode
- do not change the accepted runtime snapshot/import architecture
- do not change hashtag behavior
- do not change sanitizer scope except what is strictly required for date validation

## Tests

Add regression coverage for at least:
- 2026-09-31 rejected
- 2026-02-29 rejected
- valid leap day accepted
- valid month-end accepted
- invalid date falls back to evergreen
- existing context/profile/generator/scheduled suites remain green
- rerun current-head relevant tests with updated counts
- deno check changed files
- git diff --check
- secret scan

## Production

No deploy and no real X post.
production_mutation=0.

## Completion / K4

Report exact validation rule, changed_files, tests/current counts, PR head, production_mutation=0, and readiness for final H2 re-review.
Then status -> review_required, next_owner -> chatgpt, STOP for K4.


## Report

- task_id: x-ai-salaryman-dev-diary-pr61-date-validation-fix-20260930
- result: **PASS（source-only、未デプロイ）**。H2最終レビューで見つかった「実在しないカレンダー日付」の問題を修正した。PR #61（未merge、未デプロイ）、head `67ee04b`。
- model_used: Sonnet 5（中）
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（ブランチ`g4/ai-lab-dev-diary-content-shift-20260930`で継続。origin/mainが先行（`supabase/functions`配下への他コミットは無し）→ `git rebase origin/main`で安全に追従、force-with-leaseでpush）

### exact validation rule

- 問題: これまでの日付検証は`/^\d{4}-\d{2}-\d{2}$/`という**形だけ**のチェックで、実在するカレンダー日付かは見ていなかった。JavaScriptの`Date`は範囲外の日を黙って繰り上げる（例: `2026-09-31`は自動的に`2026-10-01`になる。`2026-02-29`は2026年がうるう年でないため`2026-03-01`になる）。この繰り上げにより、本来「無効」であるべき日付が、鮮度判定（直近3日以内かどうか）で「実在する別の日」として扱われ、日記モード（当日の進捗）として誤って通ってしまう可能性があった。
- 修正: 新規`isValidCalendarDate(dateString)`を追加。`YYYY-MM-DD`をUTCの年・月・日へ分解して`Date.UTC(...)`で一度Dateを作り、そのDateから読み戻した年・月・日が入力と完全に一致するかを確認する（round-trip検証）。一致しなければ「実在しない日付」として`false`。
- `sanitizeDiaryEntry()`内の日付チェックを、形だけの正規表現から`isValidCalendarDate()`へ置き換えた。これにより、実在しない日付のエントリは`changed`が不正な場合と同じ経路でエントリ全体が候補から除外される（黙って部分的に通すのではなく、丸ごと除外）。除外されたエントリは`selectAiLabTopicSeed`の候補集合に一切入らないため、日記モードには絶対に到達せず、エバーグリーンな振り返りへ必ずフォールバックする。

### changed_files（今回の修正分のみ）

- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts`（`isValidCalendarDate`追加、`sanitizeDiaryEntry`の日付チェックを置き換え）
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context_test.ts`（回帰テスト追加）

この2ファイルのみ。バンドル方式（snapshot/import）・ハッシュタグの挙動・sanitizerのそれ以外の範囲は無変更（TASKの制約どおり）。`.md`本体・snapshotファイルの内容変更もなし（既存エントリはすべて実在する日付のため、再生成は不要だった）。

### tests / current counts

- `ai_lab_dev_diary_context_test.ts`: **29/29 pass**（既存22件＋新規7件: `2026-09-31`拒否／`2026-02-29`（非うるう年）拒否／実在するうるう日`2028-02-29`受理／月末日（9/30・1/31・12/31）受理／その他の不正日付・形式不正の一括拒否／`sanitizeDiaryEntry`が形は正しいが実在しない日付のエントリを除外することの確認／実在しない日付のエントリが`selectAiLabTopicSeed`で日記モードへ絶対に到達せずエバーグリーンへ落ちることのend-to-end確認）。
- `supabase/functions/_shared/brand/`配下すべて: **119/119 pass**（前回112 → 今回+7、`deno test`、実行時ランタイムで確認）。
- `brand_profiles_test.ts`・`brand_post_generator_test.ts`・`ai_lab_scheduled_brand_post_test.ts`: 前回報告のとおり全件pass、今回の変更による影響なし（ファイル自体を変更していない）。
- `deno check`: 変更した2ファイルはエラー0。`x-test-post/index.ts`全体では、今回のPRが触れていない既存4ファイル由来の型エラー6件が引き続き出るが、前回・前々回のReportで確認済みの`origin/main`起因のものと同一件数（今回の修正による新規エラーなし）。
- `git diff --check`: PASS。差分に対する簡易secret scan: 該当なし。差分は上記2ファイルのみ。

### PR/head

https://github.com/anohi-memories/kabumori/pull/61 （head `67ee04b`、OPEN、MERGEABLE）。

### production_mutation

**0件**。デプロイ・DB/RLS/RPC/migration・Auth設定変更・X実投稿のいずれも無し。

### readiness for final H2 re-review

**Ready**。H2最終レビューで指摘された1点（実在しないカレンダー日付の扱い）のみを、指摘どおりの範囲で修正した。バンドル方式・ハッシュタグのスコープなど、これまでにレビューで確認済みの項目は変更していない。

## Completion

- status -> review_required
- next_owner -> chatgpt
