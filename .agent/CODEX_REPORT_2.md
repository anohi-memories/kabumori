# Codex Slot 2 Report

- task_id: morning-greeting-soft-daily-copy-20260909
- result: review_required
- next_owner: chatgpt
- changed_files:
  - `supabase/functions/x-test-post/morning_greeting_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_logic_test.ts`
  - `supabase/functions/x-test-post/morning_greeting_payload_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_payload_logic_test.ts`
  - `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`

## Root cause

共通`KABUMORI_VOICE`には金融投稿向けの説明・指導表現が含まれるため、既存の朝挨拶専用指示だけでは相場解説寄りの硬さを十分に抑えられませんでした。また旧validatorの本文100〜300文字目標が短い日常挨拶の長文化を誘発し、ハッシュタグをLLM任せにすると欠落し得る状態でした。

## Implementation

- morning_greeting専用指示を共通voiceの後段に追加し、日常の短い朝挨拶を最優先化。相場材料・決算・指数解説・先生/指導口調を明示的に禁止。
- 本文validatorを60〜140文字、生成targetを80〜120文字へ変更。本文部分だけを計測し、固定タグ行は別扱い。
- `#おはよう #日本株 #日経平均 #かぶモリ #ブルバ100`をコード側で決定論的に最終本文へ1回だけ付与。部分/重複タグは`MORNING_GREETING_FIXED_HASHTAG_INVALID`で安全停止。
- payload dry-runと本番manual publishの双方で同じタグ付与helperを使用し、Xへ渡る最終本文を統一。
- 画像ロジック、canonical reference、画像model/quality/size、Storage生成経路、Cron、OAuth、他post_typeは変更していません。

## Length / retry

- 本文validator: 60〜140文字
- 生成target: 80〜120文字
- 既存のlength retry最大1回を維持
- 非長さエラーは再試行せず、60未満/140超だけ1回再生成

## Tests

- morning_greeting関連: **60 passed / 0 failed**
- x-test-post全体回帰: **365 passed / 0 failed**
- `git diff --check`: PASS

## Git / production safety

- commit_hash: 未コミット
- push: 未実施
- deploy: なし
- production変更: なし
- OpenAI実API / X API / X投稿 / 本番DB / Cron / secrets変更: 0

## Remaining issues / recommendation

- 実production自然投稿での文体確認は未実施。今回のTASKではdeploy/本番投稿を禁止しているため、次工程でread-only観測が必要です。
- 2026-09-09に確認されたStorage receipt 400問題は別件として未変更です。
- `C2`で6ファイルの差分、60/140境界、固定5タグの最終本文、365件回帰結果をレビューしてください。承認後に別タスクでdeployと自然投稿観測を判断します。
