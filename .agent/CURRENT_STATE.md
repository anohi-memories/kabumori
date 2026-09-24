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

- Codex slot 1: `ready` — `kabumori-important-news-caller-auth-production-rollout-20260924`
  - User-approved production rollout for merged PR #12 caller-auth.
  - Sequence: secure Function/Vault secret setup → exact caller-auth migration only → four-Cron postflight → important-news-monitor-only deploy → natural runtime verification.
  - Keep `verify_jwt=false`; no business logic/auto_publish/Cron cadence/X/Push changes.
  - Start with Luna; use Sol only if production/security judgment becomes ambiguous.

- Codex slot 2: `ready` — `x-autopost-phase0c2-production-deploy-retry-20260924`
  - Phase0c C2: first authorized x-test-post deploy stopped on Supabase Functions API HTTP 500. Migration was not applied.
  - Independent read-back: x-test-post remains ACTIVE v118 / verify_jwt=false / same runtime SHA; three legacy global UNIQUE constraints remain.
  - production mutation 0。次はpreflight/diagnostic後、明示同意を取ってx-test-post deployを1回だけretry。成功時のみruntime確認→fresh preflight→exact migration。
  - repeat failure時は自動再retry/別方式切替禁止。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `review_required` — `kabumori-mobile-release-blockers-phase1-merge-only-20260924`
  - PR #13 merged normally (user approved in chat after the auto-mode check stopped the first attempt). Resulting main `f7ace17336c29edec49bb8daa0f95116a30d42fb`.
  - All 25 reviewed files byte-identical to reviewed head `8b78ecc2`; 94/0 tests on merged main.
  - Production read-only: `account-delete` absent from functions list; `public.ensure_my_profile` absent (catalog count 0); migration `20260924100000` unapplied. Production mutation 0.
  - Apply the migration before shipping any build from this main: the app now calls `ensure_my_profile` on every session.
  - Next: K1, then separately approved migration apply + `account-delete`-only deploy + Auth redirect allowlist.

- Claude slot 2: `ready` — `x-admin-netlify-thin-control-plane-phase1-merge-only-20260924`
  - K2 PASS済みPhase1 candidateを最新mainへfreshen/rebaseし、apps/admin/** drift確認＋tests再実行後にPhase1だけmergeする。
  - reviewed branch: `admin-netlify-thin-control-plane-phase1-20260924` / reviewed commit `3505269386b6345468a025749a5dd22b4ededbb7`。
  - brand selector配線・4 query module parameterization・DB/RPC・Netlify deployはこのtaskでは禁止。
  - production mutation 0。
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
