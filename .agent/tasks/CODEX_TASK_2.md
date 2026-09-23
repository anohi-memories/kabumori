# Codex Task 2

- task_id: social-mobile-app-phase21-production-history-learning-disabled-deploy-20260923
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase20 C2 PASS済みのaccess-token RPCを前提に、`social-mobile-history-learning` Edge Functionをproductionへ初回deployする。ただしdefault entrypointはdisabled adapterのまま維持し、service-role live wiring・Vault plaintext read・real X history fetchはまだ有効化しない。

## Goal

Productionに history-learning Function の**安全な殻だけ**を置く。

このPhaseで認める本番変更:
- `social-mobile-history-learning` Edge Functionのdeployのみ
- sourceはapproved `origin/main` とbyte-equivalent
- default dependencyは `disabledHistoryLearningDependencies()` のまま
- live RPC/Vault/X dependency factoryはentrypointから未接続

このPhaseでは実際の過去投稿取得は絶対に起こさない。

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. Phase20 RPC production read-back
8. relevant Phase16/18/19 source/tests
9. other-slot overlap check

If another slot touches `social-mobile-history-learning`, the access-token RPC, Vault/history-learning production settings, or the same shared reader modules, STOP.

## Model policy

Use **GPT-6 Sol Medium** for this Phase.

Reason:
- production Edge deployment
- security boundary around bearer Auth / service-role-only RPC
- need exact proof that live Vault/X path remains unreachable

Raise effort only if there is a concrete deploy/runtime/auth ambiguity.

## Gate A — source integrity

Read and verify:
- `supabase/functions/social-mobile-history-learning/index.ts`
- `logic.ts`
- `../_shared/brand/social_mobile_history_access_reader.ts`
- tests
- Phase20 RPC metadata from production

Must prove before deploy:
- `index.ts` calls only `disabledHistoryLearningDependencies()`
- `index.ts` does NOT call/import `createHistoryLearningCandidateDependencies()`
- no `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` or equivalent live secret wiring exists in the entrypoint
- no live RPC call can be reached from current deployed default dependency
- no X fetch can be reached because Auth resolution itself fails closed in disabled deps
- response never contains token/ref
- no write/publish path exists
- max history remains 50 posts / 2 pages in dormant logic
- raw posts are not persisted

If current source differs materially from Phase19-approved security model, STOP for C2 before deploy.

## Gate B — production preflight

Target:
- project `stock-x-autopost`
- ref `wsmznyzcvmuitkglfeuj`

Read-only checks:
- Phase20 RPC exists exactly once with approved ACL/search_path/security-definer properties
- no existing `social-mobile-history-learning` Function, or if it exists unexpectedly, read back and compare before any deploy
- existing unrelated Functions baseline recorded
- required public Supabase URL is available as normal project metadata
- do NOT obtain/use a service-role key in this Phase
- do NOT inspect Vault plaintext
- no overlapping task/deploy

If Function already exists with unknown/different source, STOP.

## Gate C — tests before deploy

Run at minimum:
- history-learning logic tests
- access-reader tests
- migration/static security tests relevant to Phase19/20
- Deno check for Function entrypoint/logic
- social-mobile typecheck/lint only if shared/mobile source changed
- `git diff --check`

Add/retain explicit regression proving:
- default entrypoint uses disabled dependencies
- disabled path cannot invoke RPC
- disabled path cannot invoke X
- disabled path cannot return token
- explicit consent alone is insufficient while live dependency is disabled

## Gate D — production deploy

Deploy only:
- Function: `social-mobile-history-learning`

Deployment source must be byte-equivalent to approved `origin/main`.

### JWT policy

Determine the correct `verify_jwt` setting from the current mobile/Supabase Auth architecture and existing approved Function patterns.

Preferred if compatible: `verify_jwt=true`.

If project architecture requires custom bearer validation with `verify_jwt=false`, do not assume it. Prove why from current source/tests and record it in report.

Important:
- do not add a service-role secret/env
- do not wire live reader factory
- do not change RPC/DB
- do not change OAuth
- deploy no other Function

## Gate E — post-deploy source/read-back

Read back Function metadata/source and prove:
- ACTIVE
- exact function slug
- exact verify_jwt value + rationale
- runtime `index.ts` / `logic.ts` / shared reader files match approved source
- entrypoint still uses `disabledHistoryLearningDependencies()`
- live candidate factory still not wired
- unrelated Functions unchanged

Record version / updated_at / source hashes where available.

## Gate F — safe smoke only

Permitted smoke must terminate before Vault/X.

Examples:
- unsupported GET -> 405
- POST without usable Auth -> 401 / safe fail-closed equivalent
- OPTIONS -> safe CORS response if useful

Do NOT send:
- a real QA user's bearer token with explicit consent
- real workspace/account ids
- service-role credential
- any request capable of reaching the production RPC

Smoke proof must show:
- Vault plaintext reads = 0
- access-token RPC calls = 0
- X calls = 0
- persona/settings writes = 0

## Forbidden in Phase21

- wiring `createHistoryLearningCandidateDependencies()` into production entrypoint
- using `SUPABASE_SERVICE_ROLE_KEY` for live history access
- invoking `read_social_mobile_history_access_token`
- reading Vault plaintext
- real X `/2/users/:id/tweets` call
- storing raw historical posts
- persisting persona proposal
- OpenAI live call
- OAuth changes
- publish/media/repost
- `publish_enabled=true`
- Cron/scheduler
- DB migration/RPC/RLS/ACL mutation
- migration-history repair
- unrelated Function deploy

## Production mutation budget

Exactly:
- one Edge Function deploy/update: `social-mobile-history-learning`

Everything else mutation = 0.

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- update `.agent/CODEX_REPORT_2.md`

Report must include:
1. fresh source commit
2. source integrity proof
3. Phase20 RPC preflight
4. tests
5. exact deploy result/version
6. verify_jwt value and rationale
7. runtime byte/source hash comparison
8. safe smoke results
9. proof default adapter remains disabled
10. Vault plaintext reads = 0
11. access-token RPC invocations = 0
12. X history calls = 0
13. service-role live wiring = 0
14. unrelated production mutation = 0
15. remaining risks
16. exact next gate recommendation
17. commit/push/fresh origin verification

Then STOP for C2.

## Next gate after PASS

Phase22 only after C2 PASS:
- prepare live dependency wiring behind an explicit server-side feature gate/default OFF
- deploy that wiring while keeping the gate OFF
- still no real Vault/X call

A later separate QA phase may perform exactly one real Vault access-token read + X history fetch, only with explicit user consent.

Publishing remains separate and disabled.


## Final C2 — 2026-09-23

PASS. Phase21 complete.

Independent review confirmed:
- production Function `social-mobile-history-learning` is ACTIVE v1 with `verify_jwt=true`;
- runtime entrypoint still uses `disabledHistoryLearningDependencies()`;
- runtime source includes dormant live-reader code but the entrypoint does not wire it;
- no service-role live wiring, access-token RPC invocation, Vault plaintext read, real X history call, persona write, or publish path was enabled;
- H2 reported source/tests/runtime byte-equivalence and safe unauthenticated smoke are consistent with the production read-back.

Next gate:
- Phase22 may add server-only live dependency wiring behind an explicit default-OFF feature gate.
- real Vault/X history access remains a later explicit-consent QA gate.
