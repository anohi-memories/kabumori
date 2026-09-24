# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST (H1 caller-auth production rollout completed; latest main read before sync: 22cab8714ff1cf3bdfe033d95b3b8851ffeda31d)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `review_required` — `kabumori-important-news-caller-auth-production-rollout-20260924`
  - Exact approved caller-auth migration applied; only `important-news-monitor` deployed (ACTIVE v66, `verify_jwt=false`).
  - Four Cron jobs postflight preserved schedules/active/body/URL; shadow and all other Functions unchanged.
  - All four natural Cron paths succeeded; unauthorized empty request rejected 401. Secrets never exposed. See latest `.agent/CODEX_REPORT.md`.
  - Stop for C1.
- Codex slot 2: `done` — `x-autopost-phase1b-account-bound-queue-schema-and-outcome-ledger-20260924`
  - C2 PASS。source-only account-bound queue foundation candidate承認。
  - explicit nullable social_account_id + DB brand/account/platform integrity、durable attempt/outcome ledger、versioned service-role-only v2 RPC候補を実装。
  - focused 6/6、x-test-post 409/409、disposable PostgreSQL fairness/concurrency/retry/stale/rollback proof PASS。
  - production catalog独立確認: social_account_id列0、v2 tables 0、v2 RPCs 0。production mutation 0。
  - live legacy queueは205 succeeded / 63 failed / 15 pending / 0 running。15 pendingは暗黙backfill禁止。
  - migration単独適用禁止。old dispatcherのままclaim_due_post_v2有効化禁止。
  - 次候補: source-only dispatcher/planner cutover candidate。claim.social_account_idでcredential routingし、remaining planners/callersをversion化してからproduction gate。


- Claude slot 1: `ready` — `kabumori-mobile-auth-real-e2e-disposable-account-20260924`
  - User-approved real E2E using exactly one new disposable test account.
  - Flow: signup → confirmation → first login/profile creation → session restore/logout/re-login → password recovery/deep-link → new password → in-app delete → DB/Auth read-back.
  - Existing production users must not be touched. If no test email is available, stop and ask user for one; never ask for password in chat.
  - Current Kabumori dev server may use 8082; do not stop the separate social-mobile process on 8081.
  - Recommended model: Opus 5.5.

- Claude slot 2: `ready` — `x-admin-multibrand-selector-phase2-merge-only-20260924`
  - K2 PASS済みPR #15を最新mainへfreshen/rebaseし、apps/admin/**の意味的差分がレビュー済みcandidateと同一であることを確認してからmergeする。
  - tests: node 31/31想定、tsc/lint/build/diff/secret scanを再実行。
  - selector/brand registry/query semanticsの新規変更は禁止。Netlify deploy/DB policy変更も禁止。
  - production mutation 0。
  - Recommended model: Opus 5.5。


## Parallel safety

- H1 completed the exact authorized Important News caller-auth production rollout; awaiting C1.
- G1 owns consumer mobile Auth/account/settings/legal source scope.
- G2 is intentionally free for a new non-conflicting workstream.
- H1 and G1 are intentionally separated and may run in parallel if fresh-origin checks confirm no file/DB-object overlap.
- G1/H2 remain separate existing workstreams; same file, migration, RPC, Edge Function, workflow, or production setting must never be edited in parallel.
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- PR #12 caller-auth production rollout completed within the exact H1 authorization; see the latest `.agent/CODEX_REPORT.md` for pre/postflight and runtime evidence.
- Release-readiness audit identified remaining release blockers: Auth/profile lifecycle, in-app account deletion, password recovery, legal/support entry points, iPhone/TestFlight E2E, Netlify admin trial, App Store metadata/privacy, and final security gate.
- PR #10 release-readiness audit docs remain separate from implementation work and should not be used to bypass required checks.
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。正本と索引が矛盾する場合はTASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
