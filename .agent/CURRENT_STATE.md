# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様やWeb管理画面の履歴は既存文書を参照してください。

- checked_at: 2026-09-13 JST
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`
- active_workstream:
  - Codex slot 1: `review_required` — `broad-news-display-and-notification-presets-phase3-20260913`（アプリmedium+表示・日本語ラベル・通知プリセットを実装、production変更0件、C1待ち）
  - Codex slot 2: `ready` — close-report TOPIX source correction production deploy verification
  - Claude slot 1: `review_required` — personalized portfolio morning/close reports Phase 1A
  - Claude slot 2: `done` — Phase 3C OAuth workstream transferred to Codex slot 1; do not modify same OAuth/Vault/x-oauth-connect area in parallel
- multibrand_work:
  - Phase 1 `719249f` K2 approved
  - Phase 2 `5806e85` C1 approved
  - Phase 3A `34cb78c` C1 approved
  - Phase 3B `d04d36d` C1 approved
  - Phase 3C implementation: base `4f1ae53`, void RPC fix `926f29a`; production `x-oauth-connect` v13 ACTIVE / verify_jwt=false
  - AI Lab scopeは `tweet.read users.read offline.access` のread-onlyを維持。Kabumori recoveryのみ既存投稿経路に必要な `tweet.write media.write offline.access` を含む
  - first connection verifies `/2/users/me` username matches `kaishain_ai_lab` before Vault token save
  - 2026-09-12 initial Dashboard Send Request returned HTTP400 `X_OAUTH_CONNECTION_FAILED`; fix was deployed to `x-oauth-connect` v11 and read back byte-identical
  - read-only production verification confirmed OAuth start RPC actually succeeded before the 400: `ai_salaryman_lab_x` exists, handle `kaishain_ai_lab`, `connection_status=authorization_pending`, `publish_enabled=false`; brand is `is_active=true/publish_mode=dry_run`; one OAuth state and one PKCE Vault secret were created; no access/refresh token ref yet
  - that OAuth state is now expired; do not reuse it
  - likely root cause: SQL `begin_ai_salaryman_lab_oauth_connection` returns void while Edge Function `rpc()` always calls `response.json()` after success, causing empty-response JSON parse failure and generic 400 after DB write
  - void/empty RPC success handling fixed and tested; JSON RPC behavior preserved
  - AI Labは `identity_verified`、Vault refsあり、brand `dry_run` / `publish_enabled=false` を維持
  - AI Labのlive化・publish有効化、手動X投稿、Cron変更、mio操作は引き続き禁止
- kabumori_oauth_recovery:
  - branch `codex/kabumori-x-oauth-recovery-20260913`; commits `ed4c8c0`, `13cb948`
  - production `x-oauth-connect` v13 ACTIVE。12 runtime files read-back完全一致、他Function version不変
  - 本番RPC migration 2件適用済み。3 RPCはSECURITY DEFINER / 空search_path / service_roleのみEXECUTE
  - legacy token storeは現行client secret由来鍵で復号可能だったため、共有secret変更による復号失敗仮説は否定
  - 実X handleはユーザー確認により `yume_daka`。DB誤登録 `kabumori` を訂正し、本人以外はtoken保存前にreject
  - 本人再認証後、token endpoint 2xx、暗号化保存、再読込・復号、`GET /2/users/me`本人確認pass
  - OAuth経路のX post/media callは各0。publish claimsはtotal 11 / published 4のまま。9/13 failed rowは人工retryなし
  - AI Lab identity/Vault refs/dry_run/publish無効は不変。Cron/scheduler/x-test-post/Pushは変更なし
- parallel_work:
  - Codex H1はreview待ち。`important-news-monitor` / app news / Phase 3 preset migration領域を別スロットで変更しない
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
