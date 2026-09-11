# Codex Task 2

- task_id: x-close-report-topix-source-correction-20260911
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: X版 close_report の誤った Yahoo `^TPX` 利用を停止し、正式TOPIX取得元が未確定の間も大引けレポートを安全に稼働させる。

## C2 Review — 2026-09-12

### Approved implementation

- Yahoo `^TPX` を日本TOPIXとしてreject: approved
- 1306.Tを代替市場比較指標として利用: approved
- 表示ラベル `TOPIX連動ETF（1306）`: approved
- 1306を `TOPIX` と表示しない invariant: approved
- metadata validation: 1306.T / JPX-Tokyo / JPY: approved
- same JST date / numeric / source-backed / 15:30+ gate: approved
- Nikkei path / 17:00 schedule / Fact / Voice / X publish gate unchanged: approved
- targeted tests: 63/63 PASS
- full x-test-post regression: 387/387 PASS
- deno check: PASS
- git diff --check: PASS
- implementation commit: `44630c8`

## Final Follow-up F2: production deploy verification only

Implementation is approved. Remaining work is production deployment and verification only.

### Pre-deploy checks

1. fresh `origin/main`
2. confirm implementation commit `44630c8` is contained in deploy HEAD
3. clean temporary worktree
4. verify worktree-local `supabase/config.toml`
5. verify project ref `wsmznyzcvmuitkglfeuj`
6. verify no other slot is modifying `supabase/functions/x-test-post/**`
7. do not touch existing unrelated uncommitted changes

### Production deploy

Deploy **`x-test-post` only**.

- use `--no-verify-jwt`
- do not deploy any other Edge Function
- do not manually invoke close_report
- do not make an artificial X post
- do not call OpenAI/X APIs manually

### Post-deploy verification

1. confirm `x-test-post` ACTIVE and `verify_jwt=false`
2. record new production version
3. `supabase functions download x-test-post --use-api`
4. byte-compare every downloaded runtime file against exact deploy source
5. confirm other Edge Function versions / updated_at unchanged
6. confirm DB / migrations / RLS / RPC unchanged
7. confirm Cron / scheduler / posting_windows unchanged
8. confirm secrets / OAuth / Vault / social_accounts unchanged
9. no manual same-day close_report rerun

### Completion

After successful deploy verification:
- update `.agent/CODEX_REPORT_2.md`
- set this TASK to `review_required`
- `next_owner: chatgpt`
- push metadata to origin/main

Report must include:
- deploy_head
- production_version
- verify_jwt
- byte_compare_result
- other_functions_unchanged
- forbidden_scopes_unchanged
- safety_checks
- remaining_issue: formal TOPIX source is still a future replacement; 1306 remains an explicitly labeled ETF proxy

## Final Follow-up F2: production deploy verification (2026-09-12)

- deploy_head: `090af349d771d1f73fe82dd65859eca531464209` (fresh `origin/main`)
- implementation commit `44630c8` contained in deploy HEAD: YES
- clean deploy worktree: `/private/tmp/kabumori-h2-f2-20260912`; temporary config removed after deploy
- worktree-local config used: project ref `wsmznyzcvmuitkglfeuj`, `verify_jwt = false`
- deploy scope: `x-test-post` only, `--no-verify-jwt`
- production result: x-test-post **v97 ACTIVE**, `verify_jwt=false`
- production source verification: Supabase source read-back for v97 matched all 27 runtime files in deploy source (content length and deterministic byte hash); no mismatches
- CLI download note: `supabase functions download x-test-post --use-api` was attempted in a separate clean worktree and blocked by missing `SUPABASE_ACCESS_TOKEN`; no state was changed. Equivalent production-source read-back/byte comparison completed through the Supabase API.
- other Edge Functions: versions and `updated_at` unchanged in pre/post list comparison
- DB / migrations / RLS / RPC / Cron / scheduler / posting_windows / settings / secrets / OAuth / Vault / social_accounts: no writes or changes performed; read-only snapshots remained unchanged
- manual close_report, Function invocation, OpenAI/X API calls, candidate injection, and X posts: 0
- remaining_issue: formal TOPIX source is still a future replacement; 1306 remains an explicitly labeled ETF proxy
- status: `review_required`
- next_owner: `chatgpt`
