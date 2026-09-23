# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST (C1 caller-auth source candidate PASS; PR #12 merge-only queued; Claude G2 mobile release blockers queued)
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex slot1開始=`H1`、完了確認=`C1`
  - Codex slot2開始=`H2`、完了確認=`C2`
  - Claude slot1開始=`G1`、完了確認=`K1`
  - Claude slot2開始=`G2`、完了確認=`K2`

## Active workstreams

- Codex slot 1: `ready` — `kabumori-important-news-caller-auth-merge-only-20260924`
  - PR #12 caller-auth source candidate is C1 PASS.
  - Reviewed head `9dffce9620b8a04706cad314a1e558ea141cb105`.
  - Targeted 7/7, full Important News 431/431, disposable PostgreSQL proof PASS, Vercel PASS.
  - Next H1: fresh-check main/drift, merge PR #12 only if still semantically identical and checks green.
  - Production migration/Vault secret/Function secret/deploy/Cron mutation remain forbidden and require separate explicit approval.
  - PR #11 is stale partial control-sync; never merge.

- Codex slot 2: `ready` — `x-autopost-phase0c2-production-deploy-retry-20260924`
  - Phase0c C2: first authorized x-test-post deploy stopped on Supabase Functions API HTTP 500. Migration was not applied.
  - Independent read-back: x-test-post remains ACTIVE v118 / verify_jwt=false / same runtime SHA; three legacy global UNIQUE constraints remain.
  - production mutation 0。次はpreflight/diagnostic後、明示同意を取ってx-test-post deployを1回だけretry。成功時のみruntime確認→fresh preflight→exact migration。
  - repeat failure時は自動再retry/別方式切替禁止。
  - Recommended model: GPT-6 Sol Medium。


- Claude slot 1: `ready` — `kabumori-release-mobile-blockers-phase1-auth-account-settings-20260924`
  - Main release-completion workstream for consumer mobile.
  - Scope: Auth/profile lifecycle, password recovery, account deletion source candidate, Settings/Account/Privacy/Terms/Support/Contact/Logout routes and tests.
  - Dedicated branch/PR; production mutation 0.
  - Must not touch Important News caller-auth, x-test-post/social-mobile, market-report, Netlify/Vercel settings, TestFlight/App Store Connect.
  - Recommended model: Opus 5.5.

- Claude slot 2: `ready` — `x-admin-netlify-thin-control-plane-phase1-20260924`
  - H2と分離した別系統。apps/admin/**中心でNetlify Free向けthin management UI設計/source candidate。
  - SupabaseをAuth/RLS/RPC/Edge/Cron/X executionの正本として維持。Netlify/Vercel production mutationは0。
  - x-test-post、Phase0 migrations、Cron、OAuth/Vault、H1 Important News、G1 consumer mobileへは触れない。
  - Recommended model: Opus 5.5。


## Parallel safety

- H1 owns only PR #12 merge/read-back and related Important News caller-auth source scope.
- G1 owns consumer mobile Auth/account/settings/legal source scope.
- G2 is intentionally free for a new non-conflicting workstream.
- H1 and G1 are intentionally separated and may run in parallel if fresh-origin checks confirm no file/DB-object overlap.
- G1/H2 remain separate existing workstreams; same file, migration, RPC, Edge Function, workflow, or production setting must never be edited in parallel.
- push前にfresh `origin/main`確認。既存未コミット変更は他workstream所有として触らない。

## Known issues / observations

- PR #12 production rollout is not yet authorized: migration apply, Vault write, Function secret/config and `important-news-monitor` deploy are still pending a separate approval after merge.
- Release-readiness audit identified remaining release blockers: Auth/profile lifecycle, in-app account deletion, password recovery, legal/support entry points, iPhone/TestFlight E2E, Netlify admin trial, App Store metadata/privacy, and final security gate.
- PR #10 release-readiness audit docs remain separate from implementation work and should not be used to bypass required checks.
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASKが正本。正本と索引が矛盾する場合はTASKを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
