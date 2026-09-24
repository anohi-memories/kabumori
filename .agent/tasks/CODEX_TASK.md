# Codex Task

- task_id: kabumori-important-news-caller-auth-production-rollout-20260924
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Luna
- purpose: mainへmerge済みの Important News caller-auth を、本番Cronを止めずに安全に有効化する。専用secret設定 → exact migration apply → important-news-monitor単独deploy → 自然Cron観測までを順序付きゲートで実施する。

## User authorization

2026-09-24、ユーザーは直前に説明された **Important News caller-auth production rollout** を H1 に入れて進めることを明示承認した。

このTASKで承認される本番変更は、以下に限定する。

1. `IMPORTANT_NEWS_CRON_SECRET` の Function secret 設定
2. Supabase Vault の `important_news_monitor_cron_secret` 設定
3. reviewed migration `20260923110440_important_news_monitor_caller_auth.sql` **1本だけ**の本番適用
4. `important-news-monitor` **だけ**のdeploy
5. 上記に必要なread-only preflight/postflight
6. 自然Cronの観測と、安全な認証拒否確認

以下は承認されていない:
- Cron頻度変更
- request body / URL変更
- auto_publish条件変更
- Important News判定/生成ロジック変更
- X OAuth変更
- Push仕様変更
- 他Function deploy
- 他migration apply
- blind `supabase db push`
- migration history repair
- 手動X投稿
- candidate injection
- unrelated production設定変更

## Approved source

Caller-auth source candidate:
- PR #12 merged
- reviewed head: `9dffce9620b8a04706cad314a1e558ea141cb105`
- merge commit: `844c77d6911380822c091b9b646df911810808a4`

Reviewed migration:
- `supabase/migrations/20260923110440_important_news_monitor_caller_auth.sql`

Reviewed contract:
- dedicated header: `x-important-news-cron-secret`
- Function env: `IMPORTANT_NEWS_CRON_SECRET`
- Vault name: `important_news_monitor_cron_secret`
- secret format: random 32-byte unpadded base64url = 43 chars
- keep `verify_jwt=false`
- Function validates caller secret before service-role load, body parse, or mode dispatch
- migration patches exactly the existing four monitor Cron command header expressions
- `important-news-shadow` is not part of the change

Previously verified:
- targeted auth/wiring/migration tests 7/7 PASS
- full Important News regression 431/431 PASS
- disposable PostgreSQL migration proof PASS
- fail-closed/transactional behavior PASS
- no secret literal embedded in migration/source
- schedules/body/URL/active metadata preserved in disposable proof

## Mandatory startup

Before any production mutation:

1. Read `PROJECT_RULES.md`
2. Read `.agent/ORCHESTRATION.md`
3. Read `.agent/CURRENT_STATE.md`
4. Read this TASK
5. Read latest `.agent/CODEX_REPORT.md`
6. Read `docs/runbooks/important-news-monitor-caller-auth.md`
7. Fresh fetch `origin/main`
8. Confirm reviewed caller-auth files/migration are present on latest main
9. Inspect H2/G1/G2 current ownership and prove no overlap with:
   - `important-news-monitor`
   - the four target Cron jobs
   - the caller-auth migration
   - the Function/Vault secret names
10. Read-only production preflight:
   - Function current metadata/version/`verify_jwt`
   - migration history absence for the exact migration
   - exact four Cron job names and current schedule/active/command fingerprints
   - `important-news-shadow` fingerprint
   - Vault entry presence by metadata only, never reveal value

If current production shape differs materially from the reviewed assumptions, STOP before mutation and return for C1.

## Production rollout order

### Gate A — secure secret setup

Create/use one cryptographically strong random 32-byte value encoded as unpadded base64url (43 chars).

The **same value** must be stored in:
- Function secret `IMPORTANT_NEWS_CRON_SECRET`
- Vault secret `important_news_monitor_cron_secret`

Security rules:
- never print the secret in chat, terminal output, report, source, SQL, git, logs, screenshots, or task files
- never embed the literal in migration text
- use an approved secure secret-setting mechanism/UI/API that does not echo the value into logs/history
- after setting, verify only presence/metadata/format where safe; do not read back or display the plaintext

If no safe non-echoing secret-write path is available, STOP before any migration/deploy and report the exact manual UI step the user must perform.

### Gate B — exact migration apply

Only after both secret stores are confirmed configured:

Apply **only**:
`20260923110440_important_news_monitor_caller_auth.sql`

Do NOT run broad `supabase db push`.

Postflight must prove:
- exactly four jobs changed:
  - `important-news-fetch`
  - `important-news-judgement`
  - `important-news-generation`
  - `important-news-publish-ready`
- each command now contains the dedicated auth-header/Vault lookup expression
- schedules unchanged
- active flags unchanged
- request bodies/modes unchanged
- endpoint URLs unchanged
- other command semantics unchanged
- `important-news-shadow` unchanged
- secret plaintext never selected/displayed
- migration history records this exact production change without any unrelated repair

If any postflight differs, STOP. Do not proceed to Function deploy.

### Gate C — deploy only important-news-monitor

Only after Gate B passes:

Deploy only `important-news-monitor` from latest reviewed main.

Requirements:
- preserve `verify_jwt=false`
- no other Function deploy
- read back Function metadata/source SHA/version after deploy
- confirm caller-auth code is present in deployed bundle
- confirm no unrelated source/config drift

If deploy fails:
- do not loop/retry repeatedly
- one careful diagnosis is allowed
- do not switch deployment method or modify production config without C1/user review

### Gate D — runtime verification

After successful deploy, observe natural scheduled runs.

Required:
- all four normal Cron paths continue running on their natural schedule
- no new 401/5xx from legitimate scheduled callers
- fetch / judgement / generation / publish_ready remain operational
- no change to X post selection, content, auto_publish logic, Push logic, or cadence

Authentication rejection check:
- verify unauthenticated/untrusted invocation fails closed **without causing business side effects**.
- Prefer a safe request that is rejected before body parse/mode dispatch.
- Do not use candidate injection, publish mode manipulation, X post, or Push.
- If a manual endpoint invocation would violate production safety constraints, rely on source + safe HTTP auth-boundary check and document the limitation.

## Stop conditions

Immediately STOP and return for C1 if:
- production caller shape differs from reviewed four-job assumptions
- secure secret storage cannot be done without exposing the value
- Vault/Function secret cannot be confirmed consistently
- migration changes anything outside the four intended commands
- deploy attempts to alter `verify_jwt`
- legitimate Cron begins failing
- any unrelated Function/Cron/config appears modified
- another workstream claims overlapping objects
- migration history is ambiguous enough to require repair/reconcile

Do not "fix forward" automatically in production.

## Verification / report

Update `.agent/CODEX_REPORT.md` with:

- fresh main SHA
- preflight Function metadata
- preflight migration-history result
- preflight four-Cron fingerprints/schedules/active state
- secret setup result as **configured/not configured only** — never secret value
- exact migration apply result
- postflight four-Cron preservation evidence
- deploy result + Function version/SHA/`verify_jwt`
- natural runtime observation timestamps/results
- unauthenticated rejection verification result
- explicit untouched list:
  - Important News business logic
  - auto_publish
  - Cron cadence
  - X OAuth
  - Push
  - other Functions
  - H2/G1/G2 workstreams
- exact production mutations performed
- remaining risks/issues

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Lunaで開始。production shape/secret/deployの判断が曖昧になった場合のみGPT-6 Sol Mediumへ上げる。**


## H1 stop — manual secret setup required (2026-09-24)

Read-only production preflight completed and matched the reviewed assumptions:

- `important-news-monitor`: ACTIVE v64 / `verify_jwt=false`
- caller-auth migration: not applied
- Vault `important_news_monitor_cron_secret`: not configured
- four target Cron jobs: existing schedules/command fingerprints unchanged
- `important-news-shadow`: unchanged
- candidate auth header/Vault lookup: not present in production
- production mutation: **0**

The automated run stopped before Gate A because no safe non-echoing secret-write path was available through the current tooling.

### Manual user action required

Generate one cryptographically strong random 32-byte value encoded as unpadded base64url (43 characters), then set the **same value** in Supabase Dashboard:

1. Edge Functions / Secrets:
   - name: `IMPORTANT_NEWS_CRON_SECRET`
2. Vault:
   - name: `important_news_monitor_cron_secret`

Do not paste the secret into chat, GitHub, terminal history, SQL, screenshots, or reports.

After both are configured, the user should report only:
`両方設定済み`

Then Codex slot 1 may resume this same task from Gate A verification. Do not regenerate/replace one side independently unless both are coordinated to the same value.


## User confirmation — manual secret setup complete (2026-09-24)

The user explicitly confirmed: `両方設定済み`.

Treat this as authorization to resume the same H1 task from Gate A verification onward.

Required resume sequence:
1. read-only verify the Function secret and Vault entry are both configured, without exposing either value;
2. verify the Vault entry shape/metadata safely;
3. apply only `20260923110440_important_news_monitor_caller_auth.sql`;
4. run the required four-Cron postflight;
5. deploy only `important-news-monitor` with `verify_jwt=false`;
6. observe natural scheduled executions and verify unauthenticated fail-closed behavior safely;
7. stop for C1.

Do not regenerate or replace either secret unless a mismatch is proven and a coordinated reset is separately approved.


## Report — 2026-09-24 production rollout

- task_id: kabumori-important-news-caller-auth-production-rollout-20260924
- result: **review_required**; completed within the approved scope; stop for C1.
- latest_main_source_check: `3e026ee83ec3436920f63561912d29fcc407a570`; caller-auth seven-file source remains identical to reviewed merge `844c77d6911380822c091b9b646df911810808a4`. Local `git fetch origin` failed on DNS; GitHub main refs were read directly.
- secrets: Function secret presence is based on the user's explicit Dashboard confirmation (Function inventory does not expose names); Vault name present and format predicate valid. No secret value was read or returned.
- migration: applied only `20260923110440_important_news_monitor_caller_auth.sql`, successful. History row name is `important_news_monitor_caller_auth`, tool-assigned version `20260924024406`; no history repair.
- Cron postflight: exactly four intended commands have the new Vault-backed header. Removing only the appended expression reproduces every original command MD5; schedules/active flags unchanged; shadow fingerprint unchanged.
- deploy: only `important-news-monitor`, ACTIVE v66, SHA `8192d004167b01e3a48c55df584ca6393e896db1c752f3bb7a247849c2c0257e`, `verify_jwt=false`. All 26 deployed modules match latest main; other 16 Function metadata records unchanged.
- auth rejection: one empty unauthenticated POST returned 401 `UNAUTHORIZED`; code rejects before credentials/body/mode. No candidate data.
- natural Cron: publish-ready 02:50/02:55/03:00/03:05 UTC, generation 02:54, fetch 03:00, judgement 03:07 — all `succeeded`. Through 03:07, 49 observed pg_net responses all HTTP 200; no auth/server/transport errors.
- production changes: one exact migration plus one Function deploy. No X post, candidate injection, Push, OAuth change, other Function/Cron/migration/config change, or business-logic/auto_publish/cadence change.
- remaining_issues: C1 review. Function secret was confirmed by user attestation; no plaintext was accessed.
- next_owner: chatgpt.

