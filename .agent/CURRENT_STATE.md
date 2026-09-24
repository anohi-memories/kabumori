# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST (PR #12 caller-auth source candidate merged; production rollout not authorized)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `in_progress` — `kabumori-important-news-caller-auth-production-rollout-20260924`
  - Read-only preflight matched assumptions: monitor ACTIVE v64 / verify_jwt=false, migration unapplied, Vault entry absent, four target Cron jobs and shadow unchanged.
  - Production mutation 0.
  - Blocked on manual secure secret setup because current tooling has no confirmed non-echoing write path.
  - User must set the same 43-char 32-byte base64url value in Function secret `IMPORTANT_NEWS_CRON_SECRET` and Vault `important_news_monitor_cron_secret`, then report only `両方設定済み`.

- Codex slot 2: `ready` — `x-autopost-phase1b-account-bound-queue-schema-and-outcome-ledger-20260924`
  - Phase1 C2はsafe-stopとしてPASS。独立read-backでscheduled_posts/post_execution_logsにsocial_account_id/account bindingやdurable provider outcomeが無いことを確認。
  - current claim_due_postはglobal oldest pendingをFOR UPDATE SKIP LOCKEDで1件claim、retry_scheduled_postはdurable provider phaseなしでrunning→pending可能。現状のままaccount/fairness/retryを拡張するのは危険。
  - 次H2はsource-onlyで明示social_account_id binding + DB integrity + durable attempt/outcome ledger + versioned claim/reconcile RPC候補を作り、disposable PostgreSQLで証明する。
  - legacy rowsのaccount推測/backfill禁止。production mutation 0。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `ready` — `kabumori-mobile-release-blockers-phase1-production-rollout-20260924`
  - User-approved production rollout after K1 PASS.
  - Sequence: exact `ensure_my_profile` migration → `account-delete`-only deploy → recovery redirect allowlist → postflight/readiness verification.
  - No real user deletion/reset email, no TestFlight/App Store action, no privacy/terms/support URL guessing.
  - Recommended model: Opus 5.5.

- Claude slot 2: `ready` — `x-admin-multibrand-selector-query-parameterization-phase2-20260924`
  - Phase1 admin foundationの次段階。server-sideで権限確認済みselected brandを使うbrand selector UIと4 query modulesのbrand_id parameterization。
  - 既存のexplicit brand filterを維持し、tampered selectorはfail-closed。cross-brand aggregateはまだ行わない。
  - system-toggleは安全にparameterizeできなければKabumori-onlyのまま明示。DB/RPC追加は禁止。
  - production mutation 0。x-test-post/queue系には触れないためH2と並行可。
  - Recommended model: Opus 5.5。


## Parallel safety

- H1 owns only PR #12 merge/read-back and related Important News caller-auth source scope.
- G1 owns consumer mobile Auth/account/settings/legal source scope.
- G2 is intentionally free for a new non-conflicting workstream.
- H1 and G1 are intentionally separated and may run in parallel if fresh-origin checks confirm no file/DB-object overlap.
- G1/H2 remain separate existing workstreams; same file, migration, RPC, Edge Function, workflow, or production setting must never be edited in parallel.
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- PR #12 caller-auth production rollout is now explicitly authorized only within H1 TASK gates: secure Function/Vault secret setup, exact migration apply, important-news-monitor-only deploy, and runtime verification.
- Release-readiness audit identified remaining release blockers: Auth/profile lifecycle, in-app account deletion, password recovery, legal/support entry points, iPhone/TestFlight E2E, Netlify admin trial, App Store metadata/privacy, and final security gate.
- PR #10 release-readiness audit docs remain separate from implementation work and should not be used to bypass required checks.
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。正本と索引が矛盾する場合はTASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
