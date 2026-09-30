# Claude Task 4

- task_id: x-ai-lab-diary-update-20260930
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: K1〜K4共通ルールの初回運用として、2026-09-30の公開安全な開発内容を会社員AIラボ開発日記へ追記し、自動投稿で使えるruntime snapshotへ反映する。

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/room_handoffs/X_AUTOPOST_CHAT.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout and fresh `origin/main`.
3. Confirm G3 remains occupied by its native E3 workstream and this G4 task does not touch G3-owned files.
4. Read the existing diary source and generator/tests before editing.
5. Do not inspect or modify G1/G2 TASK/Report/status. For K1/K2 material, only Final K diary candidate lines would be allowed; this task does not require them.

## Source candidates for 2026-09-30

Use only these public-safe ideas; rewrite naturally for the existing diary format without adding internal identifiers:

1. iOS版で実データ接続とX認証の確認を進めたが、テスト用アカウントが既存接続と重なっていたため安全側で停止した。AIとの個人開発では、機能を進めること以上に「本番へ影響を出さない確認」に時間を使う日もある。
2. 開発の進捗を自動投稿の題材として残せるよう、完了確認のたびに安全な開発内容を選別して共有メモへ回す運用を整えた。

## Safety / sanitization

Diary text must not contain:
- branch名
- TASK ID
- commit hash
- PR番号
- internal URL / email
- token / JWT / password / secret / Authorization header
- DB table / RPC / Edge Function内部名
- Vault / production security details
- raw `.agent` content
- specific internal account identifiers

Do not claim an action happened if it did not. Keep the real date 2026-09-30; do not re-date older work.

## Implementation

1. Update:
   `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`
   with a 2026-09-30 entry matching the established format.
2. Regenerate the runtime snapshot using the repository's canonical generator:
   `generate_ai_lab_dev_diary_snapshot.ts`
   so `ai_lab_dev_diary_context.snapshot.ts` is byte-consistent with the Markdown source.
3. Run the relevant parity / freshness / sanitizer / scheduled AI Lab / shared-brand tests needed to prove no regression.
4. Run diff/secret checks.
5. Commit and push only this task's files after a fresh race check against origin/main.

## Production reflection

If the updated diary is not automatically available to production without redeploy, reflect it only through the existing controlled single-function path:
- target only `x-test-post`
- accepted commit fixed
- isolated directory
- explicit project ref
- preserve current verify_jwt setting
- read-back after deploy
- no DB/RLS/RPC/Auth/Vault/Cron/settings/secret mutation
- no manual X post
- no manual scheduler invocation

If Claude auto mode blocks the production deploy, do not bypass safety. Report the exact accepted commit and the exact single-target manual deploy command for the user, then STOP. Do not treat blocked deploy as success.

## Completion

Report:
- task_id
- result
- exact public-safe diary entry added
- changed_files
- tests
- commit_hash
- push
- deploy/read-back status
- remaining_issues
- safety_checks
- next_recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K4.
