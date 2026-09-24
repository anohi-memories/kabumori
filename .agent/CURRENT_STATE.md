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
  - User confirmed both caller-auth secrets are configured manually.
  - Resume from read-only secret presence verification → exact caller-auth migration → four-Cron postflight → important-news-monitor-only deploy → natural runtime verification.
  - Never expose/read back plaintext secret values; keep `verify_jwt=false`; no business logic/auto_publish/Cron cadence/X/Push changes.

- Codex slot 2: `ready` — `x-autopost-phase1b-account-bound-queue-schema-and-outcome-ledger-20260924`
  - Phase1 C2はsafe-stopとしてPASS。独立read-backでscheduled_posts/post_execution_logsにsocial_account_id/account bindingやdurable provider outcomeが無いことを確認。
  - current claim_due_postはglobal oldest pendingをFOR UPDATE SKIP LOCKEDで1件claim、retry_scheduled_postはdurable provider phaseなしでrunning→pending可能。現状のままaccount/fairness/retryを拡張するのは危険。
  - 次H2はsource-onlyで明示social_account_id binding + DB integrity + durable attempt/outcome ledger + versioned claim/reconcile RPC候補を作り、disposable PostgreSQLで証明する。
  - legacy rowsのaccount推測/backfill禁止。production mutation 0。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `review_required` — `kabumori-mobile-release-blockers-phase1-production-rollout-20260924`
  - Gate A PASS: `public.ensure_my_profile()` applied alone (no db push / no history write). Security invoker, `search_path=""`, EXECUTE only for postgres (the owner) and authenticated; anon and service_role have none.
  - Gate B PASS: `account-delete` v1 ACTIVE with verify_jwt=true. Source is AST-identical to reviewed main, with a negative control. The other 16 functions are unchanged.
  - Gate C STOPPED: the CLI cannot safely add one Auth redirect entry. Manual Dashboard step: add `kabumori://reset-password` to Redirect URLs.
  - Gate D PASS: rollback-contained RPC contract check; unauthenticated and non-user token calls return 401; auth.users=2 / profiles=1 unchanged.
  - Production mutations: exactly 2 (migration + account-delete deploy). Legal/support URLs still unresolved.

- Claude slot 2: `done` — `x-admin-multibrand-selector-query-parameterization-phase2-20260924`
  - K2 PASS。brand selector + server-authorized selected-brand boundary + 4 admin query modulesのbrand parameterization source candidateを承認。
  - tampered/unknown selectorはfail-closed。queryはexplicit brand_id filter維持。Important NewsはKabumori-only gate。
  - system-toggleはKabumori-only維持し、posting_windows mutationへKabumori brand filterを追加して境界を狭めた。
  - tests/build: node 31/31、tsc/lint/build、git diff check PASS、secret scan clean。production mutation 0。
  - PR #15はopen/unmerged。branchはcurrent mainより5 commits behindだが差分は.agent control filesのみでapps/admin driftなし。
  - 次候補: merge-only G2でfreshen/rebase→tests再実行→PR #15 merge。Netlify実deployやDB policyは別gate。


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
