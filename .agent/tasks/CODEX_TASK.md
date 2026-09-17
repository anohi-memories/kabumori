# Codex Task

- task_id: ai-lab-daily-content-plan-writer-postgres-proof-20260918
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol Medium/High
- purpose: Phase 2 writer candidate `3ce866e7e424c4e4b675269122285dab7ca39a6b` の設計自体は概ね承認可能だが、C1必須条件だった disposable PostgreSQL/Supabase 上での migration/RPC/grant/concurrency proof が未実施で、SQLite model + SQL文字列検査に留まっている。production適用前に実Postgres semanticsを証明する focused proof を行う。

## C1 review — 2026-09-18

**NOT PASS — real PostgreSQL disposable proof required before rollout.**

良かった点:
- service-side writer contract、versioning、activation、request_key idempotency、validation、payload上限の設計は目的に合っている。
- `SECURITY DEFINER` + `search_path=''`、anon/authenticated EXECUTE revoke、service_role grantというsecurity boundaryをcandidate化している。
- brand/date単位のadvisory transaction lockとactive一意constraintを使う設計。
- 同一request_key + 同一payloadは同じrowを返し、異なるpayloadならconflict。
- Phase 2で `x-test-post` / OAuth / Vault / market-report / Mio / Kabumori を変更していない。
- focused 10/10、full regression 473/473、deno check/fmt、git diff --check PASS。
- production mutation 0。

### Blocking issue

TASKは disposable/local/test DB で少なくとも以下を**実DBで**証明することを要求していた:
- Phase1 + writer migration apply
- service_role writer allowed
- anon/authenticated EXECUTE denied
- first active / second active archive / exactly-one-active
- draft preservation
- request_key retry/idempotency/conflict
- invalid payload reject/no row
- concurrent activation safety
- consumer query compatibility
- rollback/preflight/postflight SQL

しかしReportのproofは `node:sqlite` のin-memory modelと、migration SQLに文字列が存在することのstatic assertionのみ。これはPostgreSQL固有の以下を検証できない:
- `SECURITY DEFINER` / grants / JWT claim / session_user挙動
- `pg_advisory_xact_lock`
- partial unique index
- jsonb validation/casting semantics
- concurrent transaction behavior
- PL/pgSQL `return query` / exceptions

したがって production migration/RPC applyの承認にはまだ足りない。

## Required focused proof

### 1. Real disposable PostgreSQL/Supabase apply

productionではない disposable DB / local Supabase / ephemeral Postgres に、C1承認済みPhase1 migrationとwriter Phase2 migrationを実際に適用する。

- production DBへは一切applyしない
- production migration history repair/reconcile禁止
- disposable DBが用意できない場合はSTOPして具体的理由をReport

### 2. RPC/security proof

実Postgres上で最低限確認:
- function作成成功
- signature / SECURITY DEFINER / search_path
- anon EXECUTE denied
- authenticated EXECUTE denied
- service_role相当 allowed
- unauthorized callでrow mutation 0
- service-role callの戻り値が id/version/status/target_date/brand_id のみ

JWT claimをPostgRESTなしで直接再現する場合は、テスト方法と限界を明記する。可能ならSupabase local/test経由で実PostgREST role behaviorも確認する。

### 3. State/idempotency proof

実DBで:
- first active create => version 1 / active 1件
- second active create => prior archived / new version 2 / active exactly 1
- draft create => activeを維持
- identical request_key retry => same id/version、row増加なし
- same request_key changed source/plan/activation => `DAILY_CONTENT_PLAN_REQUEST_KEY_CONFLICT`
- invalid payload => reject、row増加なし
- null/omitted slot accepted
- explicit slot accepted
- duplicate item id rejected
- oversized payload rejected

### 4. Concurrency proof

可能な範囲で2 concurrent transactions/callsを同じ brand + target_date に対して実行し、
- version衝突なし
- active exactly 1
- unique violationで中途半端な状態にならない
- retry後も整合
を確認。

最低でもPostgreSQL上でadvisory lockが直列化する実証を残す。SQLite modelでは代替不可。

### 5. Consumer compatibility

Phase1 consumer相当query:
- brand_id
- target_date
- status='active'
- version desc
で最新active planが取得でき、structured payloadが既存parser/selectorに通ることを確認。

### 6. Rollback/preflight/postflight

production適用前に使えるread-only preflight / postflightと、rollback方針を具体化する。

重要:
- migration history driftが既知なのでblind `supabase db push`前提にしない
- production rolloutはまだ行わない

## Safety boundary

禁止:
- production migration apply
- production RPC/grant/RLS変更
- production `x-test-post` deploy
- Cron/window変更
- manual/synthetic X post
- retry/backfill
- OAuth/Vault/token/secret mutation
- Mio/Kabumori behavior変更
- G1 market-report変更

production mutation = 0でC1へ返す。

## Completion

完了時:
- `.agent/CODEX_REPORT.md` 先頭にPostgres proof report
- disposable DB種別/バージョン
- applied migrations
- exact tests/SQL result
- role/grant proof
- concurrency proof
- consumer compatibility
- production mutation 0
- candidate code変更が必要ならexact commit/hash
- this TASKを `status: review_required`, `next_owner: chatgpt`
- fresh origin/main確認後、安全にpush/read-back
- C1待ちでSTOP
