# Codex Task

- task_id: ai-lab-daily-content-plan-production-rollout-20260918
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Sol Medium/High
- purpose: C1 PASS済みの AI Lab daily content plan Phase1 consumer/schema candidate + Phase2 writer RPC を、production Supabaseへ最小・可逆に反映する。まず exact migration preflight/apply/read-back を行い、writerを本番で使える状態にする。G1の `x-test-post` consumer cutoverとは分離し、このH1では consumer deploy は行わない。

## Approved inputs

C1承認済み:
- Phase1 base migration: `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql`
- Phase2 writer migration: `supabase/migrations/20260917211919_ai_lab_daily_content_plan_writer_phase2.sql`
- consumer/source candidate:
  - `0a6f20c86603c5834876208e4c05ef711d036be4`
  - focused selection fix `cdebdc861d9b6fb38645b640c3d48396ec72aee3`
- writer candidate: `3ce866e7e424c4e4b675269122285dab7ca39a6b`
- real PostgreSQL 17.6 proof PASS:
  - migrations apply
  - service_role allowed / anon+authenticated denied
  - activation/version/idempotency
  - concurrent activation serialization
  - consumer-shaped read
  - rollback dry-run

## Mandatory startup / conflict gate

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT.md`
5. `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/tasks/CLAUDE_TASK_1.md`
7. fresh `origin/main`
8. production Supabase current schema/migration/object state read-only

### Hard conflict rule

H2は `brand_memberships` / tenant RLS のproduction rolloutを予定している。**H1とH2でproduction migration applyを同時に行わない。**

- H2が `in_progress` でproduction DB write/apply中、または直近writeの安全確認が未完了なら、H1はproduction write前にSTOPして具体的競合を報告する。
- H2がreview_required/doneでwrite完了・postflight済みなら、fresh production read-back後にH1を進めてよい。
- G1はmarket-report / `x-test-post` 領域。H1は今回 `x-test-post` をdeploy/modifyしないのでDB objectが分離していれば競合しない。

## Goal

productionに以下だけを安全に作る:
1. `public.daily_content_plans` とPhase1 constraints/index/RLS/grants
2. Phase2 metadata columns/index
3. `public.write_daily_content_plan(text,date,text,jsonb,boolean,text)`
4. writer ACL: anon/authenticated/public deny、service_role allow

**このH1ではAI Lab consumerを本番有効化しない。**
つまり `x-test-post` deploy、Cron/window変更、投稿生成切替は別承認。

## 1. Production preflight — read-only

適用前に最低限確認:
- `daily_content_plans` table absent/present
- writer RPC absent/present
- 同名index/constraint/policy/grantの衝突
- `brands.id='ai_salaryman_lab'` が存在
- Phase1/Phase2 migrationが既に別timestampで実適用されていないか object-levelで確認
- migration historyは参考にするが、既知driftがあるためhistoryだけで判断しない
- production PostgreSQL version
- H2/G1が同じobjectsを触っていないこと

既にobjectsが部分存在する場合は、blind applyせず差分を特定してSTOPまたは安全なexact apply案をReportする。

## 2. Exact migration apply

禁止:
- `supabase db push`
- `--include-all`
- migration history repair/reconcile
- unrelated migrations apply

許可:
- C1承認済みの上記2 migrationだけをexact SQLとして順番に適用
- 必要ならBEGIN/ROLLBACKの事前proofをproduction上でno-persistで行う

順序:
1. Phase1 base migration
2. read-back
3. Phase2 writer migration
4. read-back

各段階で失敗したら次へ進まずSTOP。

## 3. Production postflight

必須確認:
- `daily_content_plans` columns / constraints / partial active uniqueness / indexes
- RLS enabled
- table grantsが想定どおり
- writer RPC signature
- `prosecdef=true`
- `search_path=''`
- function owner
- function EXECUTE:
  - public=false
  - anon=false
  - authenticated=false
  - service_role=true
- request-key unique partial index
- no unexpected policy/client write path
- unrelated tables/functions/grants unchanged in relevant inventory

## 4. Bounded writer smoke

本番に不要な恒久テストデータを残さないこと。

第一候補:
- transaction内で、未来の安全なテスト日付 + `ai_salaryman_lab` に対しwriterを呼び、
  - active create
  - idempotent retry
  - conflict reject
  - then ROLLBACK
- postflightでテストrow 0件を確認

service_role transport mappingを確認できる安全な方法があれば、実PostgREST/RPC経由で1回だけ no-secret/no-X のbounded smokeを行ってよい。ただし恒久rowを残さない方法を優先。
manual X post / scheduler invokeは禁止。

## 5. ChatGPT operational readiness

本番反映後、ちゃが次工程で実際にplan登録できるよう、Reportに以下を明記:
- exact RPC name/signature
- canonical JSON payload
- target_dateはJST calendar date
- request_key命名例
- activate=true semantics
- plan registrationだけではX投稿を即時起動しないこと
- consumer deploy前はplanを登録しても現行投稿生成にはまだ使われないこと

## 6. Rollback readiness

rollback案を具体化:
- writer利用停止
- EXECUTE revoke
- writer function drop
- Phase2 metadata/index rollback
- Phase1 table rollbackはデータ有無を確認したうえで別承認（安易にdropしない）

本タスクでは問題が無ければrollbackを実行しない。

## Production safety boundary

このH1で許可:
- exact approved Phase1/Phase2 migration production apply
- read-only pre/postflight
- transaction rollback smoke
- .agent metadata/report update

このH1で禁止:
- `x-test-post` deploy/modify
- AI Lab consumer enable/cutover
- manual/synthetic X post
- scheduled_posts retry/backfill
- Cron/posting-window変更
- OAuth再認可
- Vault/token/secret変更
- Kabumori/Mio behavior変更
- market-report objects変更
- social-mobile membership/RLS objects変更

## Completion / C1 return

完了時:
- `.agent/CODEX_REPORT.md` 先頭にproduction rollout report
- exact applied SQL/migrations
- preflight
- postflight
- RPC/grant proof
- smoke/rollback result
- production changed objects
- unrelated objects unchanged
- secrets/X/Cron/OAuth/Vault changes=0
- this TASK `status: review_required`, `next_owner: chatgpt`
- fresh origin/main確認後にcontrol metadata同期
- C1待ちでSTOP

成功してもconsumer deployはしない。次工程はG1の `x-test-post` 競合解消後、AI Lab consumer sourceをproductionへdeployし、ちゃが翌日planを登録する実運用テストを別タスクで行う。
