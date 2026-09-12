# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-12 JST
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`
- active_workstream:
  - Codex slot 1: `ready` — `x-multibrand-phase3c-oauth-start-void-rpc-fix-20260912`
  - Codex slot 2: `ready` — close-report TOPIX source correction production deploy verification
  - Claude slot 1: `review_required` — personalized portfolio morning/close reports Phase 1A
  - Claude slot 2: `done` — Phase 3C OAuth workstream transferred to Codex slot 1; do not modify same OAuth/Vault/x-oauth-connect area in parallel
- multibrand_work:
  - Phase 1 `719249f` K2 approved
  - Phase 2 `5806e85` C1 approved
  - Phase 3A `34cb78c` C1 approved
  - Phase 3B `d04d36d` C1 approved
  - Phase 3C latest implementation `4f1ae53`; production `x-oauth-connect` v4 ACTIVE / verify_jwt=false
  - scope is `tweet.read users.read offline.access`; no posting scope
  - first connection verifies `/2/users/me` username matches `kaishain_ai_lab` before Vault token save
  - 2026-09-12 Dashboard Send Request executed once and UI returned HTTP400 `X_OAUTH_CONNECTION_FAILED`
  - read-only production verification confirmed OAuth start RPC actually succeeded before the 400: `ai_salaryman_lab_x` exists, handle `kaishain_ai_lab`, `connection_status=authorization_pending`, `publish_enabled=false`; brand is `is_active=true/publish_mode=dry_run`; one OAuth state and one PKCE Vault secret were created; no access/refresh token ref yet
  - that OAuth state is now expired; do not reuse it
  - likely root cause: SQL `begin_ai_salaryman_lab_oauth_connection` returns void while Edge Function `rpc()` always calls `response.json()` after success, causing empty-response JSON parse failure and generic 400 after DB write
  - Codex H1 must reproduce/confirm, minimally fix void/empty RPC success handling, preserve JSON RPC behavior, test, deploy only `x-oauth-connect`, then retry OAuth start once
  - X login/consent/token exchange/read-only identity verification remain not completed
  - connection must remain `dry_run` / `publish_enabled=false`
  - X posting, Cron change, live enable, Kabumori token change, mio operation remain prohibited
- parallel_work:
  - Codex H1 may touch `x-oauth-connect` only for the minimal OAuth response fix
  - Claude slot2 must not touch same area until H1 completes
  - Codex slot2 may touch `x-test-post` only; if scope overlaps, stop and report conflict
  - existing uncommitted changes belong to other workstreams and must not be modified/staged/committed
- known_issue:
  - multibrand migrations `20260910170000/180000/190000` objects exist in production but migration history may not record them; do not use blind `supabase db push`
  - 2026-09-09 morning_greeting legacy Storage receipt HTTP400 is a separate unresolved issue

## 更新ルール

- 作業完了時に、確認できた現在値だけを短く反映する。
- 推測は事実として書かず、未確認であることを明記する。
- 秘密情報、認証情報、個人情報は書かない。
