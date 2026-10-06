# Claude Task 3 — CURRENT TASK

- task_id: x-social-mobile-ai-consult-v1-fresh-integration-20261006
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: highest
- recommended_model: Opus5.5（高）
- type: source-only fresh-main integration / AI consultation V1 core / memory-to-generation contract
- source_pr: 78
- source_head: 6e9f78a31bae9b65599732a9b416dcb50f2bfbc7
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Product decision

「AIと相談する」はV1必須の中核機能。
単なるチャットではなく、利用者とAIが会話しながら投稿内容・口調・好みを整理し、
利用者が明示確認した内容だけを覚え、その保存内容が実際の投稿生成へ反映されることをV1完成条件とする。

## Current dependencies

- PR #81 source is merged and independently reviewed, but production schema apply is still HOLD while G5 common-account critical path is active.
- G5 currently owns common-account legacy backfill / entitlement critical path. Do not overlap Auth/entitlement/account deletion/production DB work.
- G4 morning-greeting reliability task is complete; G4 is a separate X-app slot and will later handle UI work. Do not edit G4-owned work.
- PR #78 is still open at head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` and is currently not mergeable against fresh main.
- PR #78 changed paths are limited to the AI-consult/content-settings surface:
  - `apps/social-mobile/src/app/(tabs)/consult.tsx`
  - `apps/social-mobile/src/data/consult-client.ts`
  - `apps/social-mobile/src/data/content-settings-repository.ts`
  - `apps/social-mobile/src/domain/consult-session.ts`
  - `apps/social-mobile/src/domain/content-settings-conversation.ts`
  - `apps/social-mobile/src/domain/content-settings.ts`
  - `apps/social-mobile/tests/consult-screen.test.mjs`
  - `apps/social-mobile/tests/consult.test.mjs`
  - `supabase/functions/social-mobile-consult/index.ts`
  - `supabase/functions/social-mobile-consult/logic.ts`
  - `supabase/functions/social-mobile-consult/logic_test.ts`
- Current main brand generator already supports `contentSettings` and feeds `socialMobileGenerationGuidance(contentSettings)` into the prompt. This contract must remain compatible.

## Goal

Fresh-integrate PR #78 onto current main and make the AI consultation V1 source ready for later production activation, without touching production or G5 boundaries.

The task must prove:
1. natural conversation works;
2. AI can explain what it currently understands;
3. proposal is delta-only;
4. nothing is saved merely because the AI replied;
5. only explicit user confirmation ("これで覚えて") commits;
6. stale proposals never overwrite newer settings;
7. confirmed persona/settings survive re-read and are the same shape consumed by post generation;
8. AI cannot alter publish ON/OFF, X account/OAuth, schedule, approval mode, deletion, entitlement or Auth;
9. one user's workspace/settings cannot leak into another user's consultation;
10. the consultation source can be merged later without silently activating a production path before PR81 schema is live.

## Mandatory startup / isolation

1. Read ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / this TASK / prior PR78 body / final PR81 H2/C2 evidence.
2. Read current G4 and G5 TASKs for conflict only; do not execute or modify them.
3. Use new-Mac clean base `/Users/yuya/Developer/kabumori-fresh`.
4. Fetch fresh `origin/main` and PR #78 head.
5. Create a new independent G3 worktree/checkout. Never share G4/G5 workdir or dev server.
6. Confirm PR #78 exact head before integration.
7. Do not rebase/reset/force-push another slot branch.
8. Prefer a normal fresh-main integration into the PR branch or an equivalent non-destructive continuation. If the PR branch has moved unexpectedly, STOP.

## Scope

Primary scope is the existing PR #78 11 paths above plus the smallest narrowly-related tests necessary to prove current-main compatibility.

Allowed only when necessary for the memory-to-generation contract:
- read-only inspection of `supabase/functions/_shared/brand/social_mobile_content_settings.ts`
- read-only inspection/tests around `brand_post_generator.ts`
- a narrowly-scoped contract test may be added if it does not change the generator/runtime behavior.

Do not edit:
- G5 common-account / entitlement / lifecycle files or migration;
- Auth signup/login/provider wiring;
- account deletion;
- X OAuth/token/Vault paths;
- PR #41 generic live auto-post implementation;
- PR #76 publish permission code;
- morning greeting workflows;
- DB migrations, RLS, RPC, Cron;
- production settings or secrets.

If a required fix would cross one of these boundaries, STOP and report it as the next task rather than expanding scope.

## Fresh-main integration

Resolve PR #78 conflicts against current main deliberately.

Especially verify:
- final PR81 `SocialMobileContentSettings` shape;
- final persona provenance/confirmed fields;
- final `updated_at` CAS contract;
- 24:00 generation-window semantics;
- current RLS-facing repository calls;
- no old candidate migration assumptions remain in app/server code.

Do not weaken current PR81 validation to make PR78 fit.

## AI consultation behavior

Preserve/verify:
- authenticated user JWT only; no service-role shortcut;
- owner membership + `social_mobile_user_v1` workspace proof;
- tenant-safe not-found behavior;
- bounded request/history/body sizes;
- exactly one AI provider call per send;
- `gpt-5.6-luna`, structured output, `store:false`, no web/tools/X call;
- no conversation body/token/email/secret logging;
- untrusted model output allowlist + length/type validation;
- chat/question responses cannot carry mutation deltas;
- ambiguous user intent asks instead of silently proposing;
- proposal changes only explicitly requested editable fields;
- current settings explanation produces no delta;
- history-learning intent is detected but does not pretend to have read X history;
- publish/account/oauth/token/schedule/cron/approval/deletion/auth/entitlement changes remain forbidden.

## Explicit memory contract

The UI must make the state transition clear:

conversation
→ AI proposal
→ user sees exactly what will change
→ user presses explicit confirmation
→ latest settings are re-read
→ only proposal-target fields are applied
→ CAS on `updated_at`
→ stale/conflicting proposal refuses and asks for reconfirmation
→ confirmed state becomes the next consultation's saved context.

No implicit save on:
- send;
- AI reply;
- navigation;
- retry;
- app resume;
- preview/example mode.

Persona must be treated as remembered truth only after user confirmation.

## Memory-to-post-generation proof

This is a V1 acceptance requirement.

Prove with source/tests that:
- the exact confirmed settings/persona persisted by the consultation path materialize into the final `SocialMobileContentSettings` / confirmed persona contract;
- the current main post-generation guidance consumes those remembered values without a lossy/remapped shadow schema;
- preferred tone, themes/objective/notes/NG words and confirmed persona signals used by generation are preserved through save → read → guidance;
- unconfirmed persona is not treated as remembered guidance;
- unrelated read-only controls such as approval mode/generation time are not changed by consultation.

If the current live scheduled-user dispatcher that consumes this guidance still depends on open PR #41, do not implement PR #41 here. Instead, report the exact missing live wiring as a release blocker and prove the reusable generator contract only.

## UX / native verification

Use local iOS Simulator where practical.

Verify:
- normal conversation;
- loading;
- retryable provider error;
- question;
- proposal card;
- explicit "これで覚えて";
- successful save;
- stale-save conflict;
- continue conversation after save;
- keyboard/scroll/safe-area on narrow width;
- no misleading "保存済み" wording before confirmation.

No EAS build.

## Tests

At minimum:
- all PR78 consult server logic tests;
- all social-mobile consult/session/screen tests;
- content-settings repository tests;
- PR81-related content-settings tests affected by integration;
- targeted generation-guidance compatibility test;
- unauthorized / wrong-member / cross-brand refusal;
- unknown-key and dangerous-key model output refusal;
- one provider call maximum;
- no X call;
- no save before confirmation;
- stale CAS refusal;
- confirmed persona/settings re-read into next consultation;
- memory-to-generation guidance round trip;
- typecheck;
- lint;
- Deno check/lint for changed runtime;
- `git diff --check`;
- added-line secret scan.

Use fake model/X where appropriate. Do not make a paid real-AI production call in this task.

## Merge / production gates

This task is **source-only**.

Forbidden:
- PR merge;
- Edge deploy;
- PR81 production schema apply;
- DB/history write;
- Auth/Vault/OAuth/X/Cron mutation;
- production feature flag;
- real X post.

Reason:
PR81 production schema must be exact before the consultation endpoint can be activated safely, and G5 critical-path production work has priority.

At completion, if source integration/tests PASS:
- keep PR #78 open;
- report exact integrated head;
- status -> review_required / next_owner -> chatgpt;
- K3 will decide whether one focused review is needed.
- Do not request production deploy yet.

## Completion report

Include:
- task_id / result
- fresh main and original/new PR78 head
- conflicts and exact resolutions
- changed files
- memory contract proof
- memory-to-generation proof
- whether PR #41 remains required for live scheduled-user generation
- native verification
- tests
- production mutation = 0
- merge/deploy = 0
- G4/G5 conflict check
- remaining V1 blockers
- next recommendation

## Review policy

This is Auth/RLS-adjacent AI behavior but no new DB/auth/permission boundary is introduced.

Default after a clean focused integration:
- one independent review only if fresh integration materially changes auth/tenant/CAS/model-output safety boundaries;
- otherwise no routine rereview of already-reviewed unchanged contracts.
- if review is warranted, prefer **Luna（高）**; use Sol only for a concrete security-boundary change.

Recommended model: **Opus5.5（高）**.

---

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr81-production-apply-continuation-20261006
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Opus5.5（高）
- type: production schema continuation / same-day preflight / exact atomic apply / post-apply read-back
- source_pr: 81
- merged_main_sha: 686f23a7094389b793470503fceb2f47a71f8fbf
- prerequisite_pr76: satisfied
- blocks_pr: 78
- production_mutation_allowed: false

## Purpose

PR #76 production prerequisite is now satisfied and Final K4 PASS.

Verified production state before this allocation:
- PR76 history exact: `20261003090000 / social_mobile_publish_permission_boundary` = 1 row;
- exact two PR76 SECURITY DEFINER RPCs present with expected owner/search_path/effective EXECUTE graph;
- `x-test-post` active with guarded runtime;
- `social-mobile-publish-setting` ACTIVE v1 / verify_jwt=true;
- running=0 / overdue pending=0;
- G4 production_mutation_window = CLOSED.

Resume the previously accepted PR #81 rollout plan.

Target files:
- `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`
- `supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql`

Accepted SHA256:
- candidate: `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`
- hardening: `83d44ccfd51bcd8fcd78d31236fa52d1d8f90c6642f12c5bb1586f9d1497467e`

Reviewed production apply method:
one operator-controlled
`psql -X --single-transaction -v ON_ERROR_STOP=1`
session containing:
1. candidate SQL;
2. hardening SQL;
3. exact history insert for `20260922045046 / social_mobile_content_settings_candidate`;
4. exact history insert for `20261003120000 / social_mobile_content_settings_hardening`.

No `db push`, no `migration up`, no `--include-all`, no history repair, no unrelated migration.

## Startup / isolation

1. Read ORCHESTRATION / CURRENT_STATE / Final K4 PR76 / Final C2 PR81 / prior G3 report / this TASK.
2. Use fresh `/Users/yuya/Developer/kabumori-fresh` and a new independent G3 worktree.
3. Fetch fresh origin/main.
4. Confirm current main still contains PR81 accepted merge and both SQL files are byte unchanged.
5. Do not touch G4 worktree/runtime or G5/common-account work.
6. Production mutation mutex: before any production write, verify G2/G5/other slots are not mutating production. If another production mutation window is ACTIVE, STOP.
7. Do not read secrets/token plaintext/user content.

## Gate A — same-day production ordering

Read-only verify:
- PR76 history exact one row;
- PR82 history exact one row;
- PR81 candidate and hardening history absent unless legitimately already applied;
- no version/name collision;
- no newer unresolved prerequisite that changes the reviewed order;
- do not reorder/repair history.

If PR76 is not exact anymore, STOP.

## Gate B — fresh production preflight

One explicit READ ONLY transaction.

Verify:
- `public.social_mobile_content_settings` absent unless an exact reviewed prior apply exists;
- same-prefix helper functions absent unless exact;
- exact live migration-ledger shape;
- applying role = reviewed owner assumptions;
- `brands` / `brand_memberships` dependencies unchanged;
- default ACL and API role graph unchanged from accepted H2 baseline;
- no same-name relation/function/policy/trigger collisions;
- no unexpected overload/grant drift.

Any drift => STOP; no repair.

## Gate C — freeze exact package

Freeze:
- fresh main SHA;
- both SQL SHA256;
- exact two version/name pairs;
- exact operator command;
- exact post-apply read-back SQL;
- failure/abort behavior.

Run local syntax/diff/secret checks only as needed. Do not modify accepted migrations.

## Mandatory STOP for approval

After A/B/C are clean, STOP before first production write and report:
- project identity;
- fresh main SHA;
- exact hashes;
- current ledger state;
- exact outer transaction;
- expected schema/history changes;
- mutex state;
- rollback/abort behavior;
- confirmation PR76/PR82/G5 are not bundled.

Request fresh explicit approval for PR81 production apply.

TASK creation or prior approvals do not authorize mutation.

## After fresh explicit approval only

Immediately rerun Gate A/B.
If any material state changed, approval is invalid; STOP.

Then execute only the reviewed outer transaction.

Open a new separate READ ONLY session and verify:
- exact two history rows;
- table columns/types/nullability/defaults exact;
- PK/index immediate, nondeferrable, valid/ready/live;
- FK/check constraints exact;
- finite timestamp CHECK exact;
- RLS enabled;
- exact policies;
- table effective ACL exact;
- helper signatures/owners/search_path/effective EXECUTE exact;
- exact one expected version trigger;
- no overloads/unexpected grants/column ACL.

Mismatch => STOP, no auto-drop/history repair, no PR78 continuation.

No Edge deploy in this task.

## PR78 continuation

Only after PR81 production schema/read-back PASS:
- report schema prerequisite satisfied;
- do not merge/rebase PR78 inside the same production mutation;
- next G3 task should fresh-integrate/rebase PR #78 current head onto fresh main and resume remaining AI/Auth/security work.

## Safety

Before explicit approval forbidden:
- production DDL/DML/history write;
- Edge deploy;
- X/OpenAI/Auth/Vault/OAuth/Cron mutation.

Always forbidden:
- accepted migration rewrite;
- PR76/PR82/G5 bundling;
- history repair/reorder;
- production test data writes.

## Completion / K3

Report:
- result
- fresh main
- Gate A/B/C
- hashes
- approval requested/received
- exact production mutations
- post-apply read-back
- deploy=0
- X/OpenAI/Vault/OAuth/Cron=0
- whether PR78 may resume
- remaining risks
- next recommendation

Then status -> review_required / next_owner -> chatgpt / STOP for K3.

Review policy:
- PR81 source and migration plan already had independent final review.
- do not add routine Codex review after exact apply/read-back PASS.
- only review if a concrete production mismatch or source change appears.

Recommended model: **Opus5.5（高）**.

## Report — x-social-mobile-pr81-production-apply-continuation-20261006

- result: **PREFLIGHT_READY / HOLD — Gate A/B/C PASS (read-only); approval NOT requested** because Final K5 (`2328415d`) holds G3 production writes while the G5 common-account production-apply decision is pending. Production mutations **0**.
- fresh main at start: `af4c8996` (this TASK's in_progress commit; contains PR81 merge `686f23a7`). Main later advanced to `8f86112f` (K5 hold + G4 morning-greeting allocation, control files only; PR81 files untouched).
- worktree: new independent `/Users/yuya/Developer/kabumori-g3-pr81-apply` (detached). G4/G5 worktrees not touched (G4 `s3_stage_a.sh` only read for the pooler connection pattern).
- hashes (byte-unchanged vs accepted): candidate `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`; hardening `83d44ccfd51bcd8fcd78d31236fa52d1d8f90c6642f12c5bb1586f9d1497467e`.
- local proof on fresh main (PG 17.11, UTF8, disposable): `social_mobile_content_settings_run.sh` → `SOCIAL_MOBILE_CONTENT_SETTINGS_ALL_PASS` (48 markers). Note: a cluster made with `--locale=C` but without `-E UTF8` is SQL_ASCII and fails the length checks — always `-E UTF8`.

### Gate A — ordering (read-only, user-run at 2026-10-06 05:28 UTC; auto mode denies Claude's production reads)
- ledger 74 rows (was 72 on 10/05): +`20261003090000 social_mobile_publish_permission_boundary` (1 row) and +`20261004090000 ai_lab_topic_claims` (1 row) — exactly PR76 and PR82.
- versions ≥ 20261002: only `20261002090000`, `20261003090000`, `20261004090000`. PR81 versions/names absent; no collision.
- pre-existing, unrelated: duplicate ledger name `add_us_premarket_report` (two versions) — reported only. Earlier ledger notes (repo `20260929090000` missing from ledger; ledger-only `20260924001508`/`20260924024406`) unchanged.
- common-account `20261001150000` is unapplied and sorts between the PR81 candidate and hardening versions; it is a separate file/feature with no object overlap, but if G5 applies first, Gate A/B must be re-read (ledger/default ACL baseline changes).

### Gate B — fresh preflight (one READ ONLY transaction; `transaction_read_only=on`)
- diff vs the accepted 10/05 baseline: **only** the ledger changes above (+ newly added probe keys). Target table/any-schema same-name relation absent; same-prefix routines/policies/triggers/constraints 0; ledger shape (version text PK, statements, name, created_by, idempotency_key UNIQUE, rollback; no triggers) unchanged; `current_user=postgres` (non-superuser, bypassrls), owns `brands`; brands/brand_memberships columns/constraints/RLS/self-select policy unchanged; auth.uid unchanged; default ACL (postgres→anon/authenticated/service_role TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on tables; functions postgres only) unchanged; public schema ACL and API role graph unchanged.
- new probe: production event trigger `ensure_rls` (`rls_auto_enable`, SECURITY DEFINER, ddl_command_end on CREATE TABLE in `public`; src md5 `99be20677b456ea8d3be47bdd44fb369`) runs `alter table … enable row level security` and swallows errors. The candidate enables RLS itself, so the effect is idempotent. Reproduced byte-identically (same md5) in the local rehearsal: apply + read-back exact, `force_rls=false`.
- probe-filter note: `pr76_rpcs=[]` is a too-narrow name filter (`social_mobile_%publish%`); PR76 functions are `set_social_account_publish_enabled` / `assert_x_publish_permission_for_legacy_post`, already independently read back at K4. Not drift.

### Gate C — frozen package (untracked, `/Users/yuya/Developer/kabumori-g3-pr81-apply/.g3-local/`)
- `pr81_apply.sh` — operator runs it; checks 4 SHA-256 then ONE `psql -X --single-transaction -v ON_ERROR_STOP=1` via session pooler (`aws-0-ap-northeast-1.pooler.supabase.com:5432`, `postgres.wsmznyzcvmuitkglfeuj`, password prompt, sslmode=require): `select current_user` → `pr81_guard.sql` → candidate → hardening → `pr81_history_insert.sql`. Exit 0 = committed; 3 = whole transaction rolled back; never rerun blindly.
- `pr81_guard.sql` `bb78f9700b903e55b23d3c33cd1b322e67faa5e34ced5328e3b7fe8438703ab8` — operator-side fail-closed assertion only (no schema change): `set local lock_timeout='5s'`; current_user=postgres; PR76 history exact 1 row; PR81 history/objects absent.
- `pr81_history_insert.sql` `bf8778d9f315815357911bffaa0ceb18383106441da5cca3d50520115ff17311` — exactly `(20260922045046, social_mobile_content_settings_candidate)` and `(20261003120000, social_mobile_content_settings_hardening)`, `(version, name)` only as reviewed.
- `pr81_readback.sql` `12f136b10c450c20578b47df03b8d0b1eff04a39e78556a0eca10923d850c5d4` — separate READ ONLY session: history rows, columns/defaults/column ACL, constraints (deferrable/validated/def), PK index flags, RLS/force, policies, trigger, table ACL + effective privileges, function owner/secdef/volatility/search_path/src md5/ACL/effective EXECUTE, overloads, row count only. Expected output frozen from the local prod-shaped rehearsal in `readback_expected_local.json` (only `ledger_count` should differ: production expects 76).
- local prod-shaped rehearsal (role named `postgres`, nonsuperuser bypassrls; ensure_rls copy; ledger with PR76/PR82 rows) of the exact script: first run hit a local-only schema-permission error inside the guard → exit 3, nothing left (proves abort path); after fixing the local fixture → exit 0, `PR81_GUARD_OK`, 2 history rows; immediate rerun → `PR81_GUARD: PR81 history already present`, exit 3.
- expected read-back: 9 columns; 7 constraints all non-deferrable/validated incl. `finite_versions`; PK btree immediate/valid/ready/live; RLS on / force off; 3 owner policies (select/insert/update) for authenticated; one `social_mobile_content_settings_version` BEFORE INSERT OR UPDATE trigger; 5 functions owner postgres, non-secdef, `search_path=pg_catalog`; effective table privileges anon none / authenticated SELECT,INSERT,UPDATE / service_role none; EXECUTE authenticated on 4 validators only; overloads 0; rows 0.

### Approval / mutations / side effects
- approval requested: **no** (K5 hold). approval received: no.
- production DDL/DML/history writes 0; deploy 0; X/OpenAI/Auth/Vault/OAuth/Cron 0. Production reads: one user-run catalog/ledger-only READ ONLY preflight (no user content/PII/token/Vault).
- PR78 may resume: **no** (PR81 schema not applied).

### Remaining risks / next recommendation
- Decide order between G5 common-account apply and G3 PR81 apply (mutex: never concurrent). If G5 goes first, G3 resume must rerun the preflight (`.g3-local/pr81_preflight_v2.sql`, sha `6c9782a1…`) and accept G5's reviewed deltas before requesting approval.
- On resume: fresh mutex check → user-run preflight → diff → request explicit approval with this package → immediate Gate A/B re-read → operator runs `pr81_apply.sh` (needs the DB password reset during G4) → user-run `pr81_readback.sql` → compare to `readback_expected_local.json`.
- Pre-existing ledger irregularities (missing `20260929090000`, ledger-only `20260924001508/024406`, duplicate name `add_us_premarket_report`) remain for a separate ledger-hygiene task; they do not affect the manual PR81 path.
- status → review_required / next_owner → chatgpt. STOP.

---

# Previous G3 task history — preserved below

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr81-production-schema-gate-20261005
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- type: production migration gate / read-only preflight / ordered rollout / post-apply read-back
- source_pr: 81
- merged_main_sha: 686f23a7094389b793470503fceb2f47a71f8fbf
- blocks_pr: 78
- production_mutation_allowed: false

## Purpose

PR #81 content-settings hardeningは source実装・H2最終レビュー・main mergeまで完了済み。

本来の次工程は:

1. production schemaのsame-day read-only preflight
2. pending migration順序の確認
3. explicit user approval後に、PR #81の2ファイルをreview済みのouter transactionでproductionへ適用
4. separate-session read-back
5. その完了後にPR #78 AI相談 v1をfresh mainへrebase/integrateして残りレビューを再開

このTASKでは、まず1〜2と適用準備まで行う。

**production mutationは、TASKに書いてあるだけでは許可しない。**
実際のapply直前にユーザーの明示承認が必要。
承認前は必ずSTOPする。

## Mandatory startup / isolation

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / this TASK / Final C2 for PR #81 / H2 final report.
2. New Mac clean base: `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh `origin/main`からG3専用の独立worktree/checkoutを使用。
4. Confirm main contains PR #81 merge `686f23a7094389b793470503fceb2f47a71f8fbf`.
5. Confirm these exact merged files are unchanged:
   - `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`
   - `supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql`
6. G4/PR #76 is a separate workstream. Do not edit its files/worktree.
7. Do not touch AI Lab PR #82 runtime/migration.
8. Do not touch common-account G5/H1 work.
9. No production user content/PII/token/Vault plaintext reads.

## Gate A — fresh migration ordering / pending history

Before any production mutation, read-only verify current source + production ledger.

Relevant versions:
- PR #76: `20261003090000_social_mobile_publish_permission_boundary`
- PR #81: `20261003120000_social_mobile_content_settings_hardening`
- merged PR #82: `20261004090000_ai_lab_topic_claims`
- historical PR #81 candidate: `20260922045046_social_mobile_content_settings_candidate`

Rules:
- if PR #76's earlier `20261003090000` is still an active pending/unmerged/unapplied workstream, **do not apply PR #81 ahead of it by assumption**.
- report the exact ordering conflict and STOP at read-only HOLD unless ChatGPT/user has separately resolved the rollout order.
- do not fake/repair/reorder migration history to bypass this.
- if PR #76 is merged and its production disposition is known, re-evaluate with fresh ledger.
- PR #82 being merged does not authorize its production apply and must not be bundled.

## Gate B — PR #81 production read-only preflight

Use one explicit READ ONLY production transaction and verify:

- target table `public.social_mobile_content_settings` absent unless an explicitly reviewed prior apply happened;
- same-prefix helper functions absent unless exact reviewed shape exists;
- both PR #81 migration versions absent from ledger unless already legitimately applied;
- exact live `supabase_migrations.schema_migrations` column/constraint shape;
- applying role identity;
- `brands` / `brand_memberships` dependency shape;
- current default table/function ACL relevant to the migration;
- current API role membership graph;
- no target-version/name collision;
- no unexpected same-name relation/function/policy/trigger.

If any drift from the H2-reviewed preconditions is found:
- STOP;
- do not apply;
- do not repair;
- report exact mismatch.

## Gate C — freeze reviewed production apply package

If A/B are clean and ordering is resolved, prepare but do not execute:

- exact current main SHA;
- SHA256 of both PR #81 SQL files;
- exact migration version/name pairs;
- exact operator command/runbook based on the H2-reviewed procedure;
- pre-apply and post-apply read-back SQL;
- failure/abort conditions.

Reviewed apply policy:
- direct operator-controlled `psql -X --single-transaction -v ON_ERROR_STOP=1`;
- candidate + hardening + exact two migration-history records in the same outer transaction;
- no `supabase db push`;
- no `migration up`;
- no Management API migration apply;
- no history repair/reconcile;
- no unrelated pending migration;
- production connection supplied securely outside logs/chat.

Do not change the two merged SQL files.

## Mandatory STOP for approval

When Gate A/B/C are complete, STOP before the first production write.

Report to ChatGPT/user:
- exact production project identity;
- fresh main SHA;
- exact migration hashes;
- current ledger state;
- PR #76 ordering status;
- exact operation proposed;
- expected schema/history changes;
- rollback/abort behavior;
- confirmation that no other migration/deploy is included.

Then request explicit production-apply approval.

Do not treat this TASK creation or a previous generic “continue” as mutation approval.

## After explicit approval only — production apply

Only if ChatGPT/user explicitly approves after the above STOP:

1. repeat fresh same-day Gate A/B reads immediately before mutation;
2. if any state changed -> STOP and invalidate approval;
3. execute the exact reviewed outer transaction only;
4. do not retry blindly on lost/ambiguous response;
5. open a new separate read-only session and verify:
   - both ledger rows exact;
   - target table exact columns/types/nullability/defaults;
   - PK/index immediate/nondeferrable/valid/ready/live;
   - FK/check constraints exact;
   - finite timestamp CHECK exact;
   - RLS enabled and policies exact;
   - table effective ACL exact;
   - helper signatures/owners/search_path/exact effective EXECUTE;
   - single expected version trigger;
   - no unexpected overloads/grants/column ACL.
6. if read-back mismatch:
   - STOP;
   - do not auto-drop;
   - do not history-repair;
   - do not proceed to PR #78;
   - report exact committed state for separate recovery decision.

No Edge deploy is part of this schema task.

## PR #78 continuation gate

Only after production PR #81 apply + read-back is PASS:

- fresh-check PR #78 exact current head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`;
- do not silently merge/rebase it inside this same mutation step;
- report that schema prerequisite is satisfied;
- next G3 task should fresh-integrate/rebase PR #78 onto current main and resume its unfinished Auth/AI/security gates.

PR #78 remains unmerged until that separate continuation.

## Safety

Forbidden before explicit mutation approval:
- production INSERT/UPDATE/DELETE/DDL;
- migration/history write;
- Edge deploy;
- Auth/Vault/OAuth/X/OpenAI mutation;
- Cron/scheduler/settings changes;
- PR #78 merge/deploy;
- PR #76 changes.

Always forbidden in this task:
- rewriting accepted PR #81 migrations;
- broad migration repair;
- bundling PR #76 or PR #82;
- production test data/user-content writes.

## Verification

Before approval:
- read-only production catalog/ledger preflight;
- local command/runbook syntax check;
- verify exact source hashes;
- `git diff --check`;
- no source changes expected except .agent unless a bounded operator-readback script is truly necessary.

After approved apply:
- separate-session production read-back only;
- no app/Edge/runtime test required for schema-only change beyond existing accepted source tests.

## Completion / K3

Report:
- task_id/result
- fresh main
- PR #76 ordering disposition
- production preflight
- exact SQL hashes
- whether approval was requested/received
- exact production mutations, if any
- post-apply read-back, if any
- production deploy = 0
- X/OpenAI/Vault/OAuth/Cron = 0
- remaining blockers
- whether PR #78 may now resume
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Review policy:
- this is execution of an already independently reviewed migration plan.
- do **not** automatically add another Codex review after a clean exact apply/read-back.
- if only read-only preflight/HOLD occurs, no review is needed.

## Report — x-social-mobile-pr81-production-schema-gate-20261005

- task_id: x-social-mobile-pr81-production-schema-gate-20261005
- result: **HOLD (read-only) — Gate B CLEAN, Gate A ordering unresolved; Gate C not frozen; no approval requested; production mutations 0.** Model: Opus 5.5.
- fresh main at start: `2eebb066` (contains PR #81 merge `686f23a7094389b793470503fceb2f47a71f8fbf`). Isolated G3 worktree created from the new clean base: `/Users/yuya/Developer/kabumori-g3-schema-gate` (detached on origin/main).
- exact SQL hashes (unchanged since the merge; `git diff 686f23a7..HEAD` empty for both):
  - `20260922045046_social_mobile_content_settings_candidate.sql` sha256 `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`
  - `20261003120000_social_mobile_content_settings_hardening.sql` sha256 `83d44ccfd51bcd8fcd78d31236fa52d1d8f90c6642f12c5bb1586f9d1497467e`

### Gate A — ordering: HOLD
- PR #76 `20261003090000_social_mobile_publish_permission_boundary` is **OPEN / unmerged** (head `5448e545f4a88bbf6597a981c0bcbe4c01043c30`) and **absent from the production ledger**. It sorts before PR #81's `20261003120000`. CURRENT_STATE also records this order as unresolved. Per the TASK, PR #81 is not applied ahead of it by assumption; no history reorder/fake/repair.
- PR #82 `20261004090000_ai_lab_topic_claims` is merged but **not applied** in production (ledger absent); it sorts after PR #81 and is not bundled.
- Needed decision (ChatGPT/user): either apply PR #76's migration first when it is ready, or explicitly accept PR #81 going first (then a later PR #76 apply is out-of-order for the CLI and must use the same reviewed manual procedure or `--include-all`, decided then).

### Gate B — production read-only preflight: CLEAN
One `BEGIN TRANSACTION READ ONLY` catalog/ledger query (`transaction_read_only=on`), **run by the user in their own terminal** because Claude's production read was refused by the auto-mode classifier; Claude read only the user's output file. Query sha256 `f74fbc29f8e90961b86323aef2b3b9736ea11d98a3ffa44bf90c1b0f61617054` (syntax-tested first on a throwaway local PostgreSQL, since removed). No user content, PII, tokens or Vault data selected. Results (checked_at 2026-10-05T14:32:55Z, project `wsmznyzcvmuitkglfeuj`, PostgreSQL 17.6):
- `public.social_mobile_content_settings` absent (no same-name relation in any schema); same-prefix routines 0, policies 0, triggers 0, constraints 0.
- Ledger: 72 rows; versions 20260922045046 / 20261003090000 / 20261003120000 / 20261004090000 and matching names all **absent**; latest applied `20261002090000`. Ledger columns: version text NOT NULL PK, statements text[], name text, created_by text, idempotency_key text UNIQUE, rollback text[] — all but version nullable, no triggers, so the reviewed `(version, name)` history insert fits.
- Applying role: `postgres` (current_user = session_user, not superuser), owner of `public.brands` — matches the hardening guard's owner rules.
- Dependencies: brands.id text NOT NULL PK; brand_memberships(brand_id text FK -> brands ON DELETE CASCADE, user_id uuid FK -> auth.users ON DELETE CASCADE, role CHECK owner/admin/member/viewer, PK (brand_id,user_id)), RLS on, self-select policy for authenticated using `(select auth.uid()) = user_id`, authenticated SELECT granted; auth.uid() stable, not SECURITY DEFINER.
- Default ACL (postgres, public): tables -> owner + anon/authenticated/service_role TRUNCATE/REFERENCES/TRIGGER/MAINTAIN (as H2 recorded; normalised by the hardening, allowed by its grantee guard); functions -> EXECUTE to postgres only. No global (all-schema) defaults. Public schema: USAGE for PUBLIC/anon/authenticated/service_role, CREATE only pg_database_owner.
- Role graph: authenticator, postgres and supabase_realtime_admin are members of anon/authenticated/service_role (expected Supabase shape; inherited privileges therefore follow the hardened grants).
- Verdict: no drift from the H2-reviewed preconditions.

### Gate C — not frozen (ordering unresolved)
The reviewed procedure remains `supabase/tests/social_mobile_content_settings_rollout.md` (one `psql -X --single-transaction -v ON_ERROR_STOP=1` session: candidate + hardening + two `(version, name)` history rows; no db push / migration up / Management API apply / repair; no other migration). It will be frozen with a fresh same-day preflight once the order is decided.

### Approval / mutations
- Production apply approval: **not requested** (Gate A HOLD). Production writes / DDL / history: **0**. Deploy: **0**. X/OpenAI/Vault/OAuth/Cron: **0**. PR #76/#78/#82 untouched.

### Pre-existing ledger observations (not touched, outside PR #81)
- `20260929090000_news_discovery_observer` exists in the repo but **not** in the production ledger (the history row known missing since the N3 canary).
- Ledger contains `20260924001508` and `20260924024406`, which have **no file** on main (remote-only versions).
Both matter for any future CLI `db push` and should be reconciled separately with approval; they do not affect the manual PR #81 procedure.

### Remaining blockers / PR #78
- Blocker: rollout order vs PR #76. PR #78 may **not** resume yet (schema prerequisite not applied).
- Local evidence files (untracked, not committed): `/Users/yuya/Developer/kabumori-g3-schema-gate/.g3-local/pr81_preflight.sql` and `pr81_preflight_out.json` (catalog/ledger metadata only).

### Next recommendation
ChatGPT/user decide the PR #76 vs PR #81 order. Then reassign G3: fresh same-day preflight (same query), freeze the package, request explicit production approval, apply the reviewed outer transaction, separate-session read-back; only then fresh-integrate PR #78.


---

# Withdrawn G3 allocation — user corrected routing; DO NOT EXECUTE

- task_id: ai-lab-pr82-production-rollout-runner-20261005
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- type: bounded production-rollout tooling / runbook / local rehearsal
- source_pr: 82
- merged_main_sha: 80e11c9207d44599db26a25195f1ee0091484231
- target_migration: 20261004090000_ai_lab_topic_claims.sql
- production_mutation_allowed: false

## Purpose

会社員AIラボ PR #82 の source implementation / review / main merge は完了済み。

残っているのは production rollout の **適用方式だけ**。

H1 read-only preflight で以下が確定している:
- production target table/functions/history version は未存在
- owner/default ACL/role-membership 前提は通る
- exact deploy target は `x-test-post` のみ
- Cron変更不要
- migration本体は自前の BEGIN/COMMIT を持つ
- Supabase CLI では migration SQL の COMMIT 後に history insert が走るため、schema + ledger は同一transactionにならない
- history insert失敗時に「schemaは入ったがledgerがない」状態があり得る
- migration本体を accepted source から書き換えてはいけない

このTASKでは、accepted migrationを変更せずに、本番反映を安全・再現可能に行うための **operator runner / runbook / local proof** を作る。

productionへの実行はしない。

## Isolation / startup

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / H1 preflight report / this TASK.
2. Use new Mac clean base `/Users/yuya/Developer/kabumori-fresh` with a fresh origin/main and independent G3 worktree.
3. Confirm merged PR #82 SHA `80e11c9207d44599db26a25195f1ee0091484231` is ancestor of current main.
4. G4 PR #76 is a separate active workstream. Do not touch PR #76 files/worktree/migration.
5. PR #81 is merged. Do not alter its migration/history plan.
6. No production connection, no production SQL, no deploy, no X call.

## Chosen rollout policy

Use the already-reviewed **schema-first / history-second checkpoint** policy rather than inventing a new migration or editing the accepted migration.

The runner must make this explicit:

### Stage A — exact schema apply
- apply ONLY the exact merged `20261004090000_ai_lab_topic_claims.sql`
- via direct psql/operator connection, not `supabase db push`, not `migration up`, not Management API
- preserve the migration's own BEGIN/COMMIT exactly
- ON_ERROR_STOP=1
- no include-all / repair / history rewrite
- no unrelated migrations

### Stage B — mandatory read-back checkpoint
After Stage A returns, before any history insertion:
- catalog-read exact target table/index/constraint/RLS/function owner/signature/security/search_path/effective ACL
- verify exactly five intended functions
- verify no unsafe/default/public API privileges
- verify target migration effects are fully present and safe
- if response was lost/ambiguous, inspect catalog first; never blindly rerun
- if catalog absent -> treat Stage A unapplied
- if catalog fully correct -> proceed to Stage C only with the exact same frozen source/version/name
- if catalog partial/unsafe -> STOP, no history write, no deploy, no automatic drop/down migration

### Stage C — narrow history record
Only after Stage B proves the target schema exactly correct:
- insert only the exact migration history record for version `20261004090000`, name `ai_lab_topic_claims`
- use a dedicated explicit transaction
- re-read ledger immediately
- never write/repair unrelated history rows
- if insert fails, leave schema in place and STOP with `schema present / history missing`; do not deploy and do not automatically retry/repair

The exact insert shape must be derived from the live ledger shape already documented by H1:
`version text NOT NULL PK, statements text[], name text, created_by text, idempotency_key text UNIQUE, rollback text[]`.
Do not assume fields beyond what is required; prove locally which minimal insert remains compatible with CLI pending/version detection.

## Required deliverables

Prefer adding:
- `supabase/tests/ai_lab_topic_claims_rollout.sh`
- `supabase/tests/ai_lab_topic_claims_rollout.md`

The shell runner must default to **local/disposable only** and refuse accidental production execution unless an explicit operator-only environment switch is provided in a future authorized run. Do not embed production URL/project ref/credentials.

It should support/rehearse:
- preflight
- Stage A exact migration apply
- Stage B catalog verification
- Stage C ledger insertion
- postflight
- failure modes

Do not make it a generic migration runner.

## Failure-state proof

Use disposable PostgreSQL only and prove:

1. clean success:
   - no schema/no history
   - Stage A -> exact schema
   - Stage B PASS
   - Stage C -> one exact history row
   - postflight PASS

2. migration SQL failure before COMMIT:
   - no target schema
   - no history

3. lost/unknown Stage A response simulation:
   - catalog determines whether schema exists
   - runner never auto-reruns before catalog read-back

4. Stage B detects unsafe/partial catalog:
   - no history insertion
   - no deploy recommendation

5. Stage C history INSERT failure:
   - schema remains exact
   - history absent
   - runner STOPs and marks operator-review-required
   - no automatic history repair/retry

6. rerun after fully completed rollout:
   - detects exact schema + exact history and becomes no-op/read-only
   - does not duplicate schema/history

7. mismatch:
   - wrong history name/version or drifted target object -> STOP

## Production cutover runbook

Document exact future order, but do NOT execute:

1. same-day production read-only preflight
2. verify no running/overdue AI Lab work
3. freeze exact migration SHA and x-test-post source/import graph
4. Stage A schema apply
5. Stage B catalog/API-cache read-back
6. Stage C exact history insert
7. ledger read-back
8. verify no in-flight/overdue old worker immediately before deploy
9. deploy only exact `x-test-post`
10. read back Function version/status/verify_jwt/source-byte graph
11. no manual POST/scheduler/backlog injection
12. separately authorized natural-cycle observation

Document the cold-ledger limitation truthfully:
- no historical event-claim backfill
- dedupe guarantee is forward-looking from cutover
- no retroactive no-repeat guarantee for already-posted diary topics

## Scope / safety

Allowed:
- new rollout runner/docs/tests
- local disposable DB proof
- minimal static test updates if needed
- .agent task/report

Forbidden:
- editing accepted migration `20261004090000_ai_lab_topic_claims.sql`
- editing AI Lab runtime logic
- production DB/history writes
- Edge deploy
- Cron/gate changes
- real X/OpenAI/Vault/OAuth/token actions
- PR #76 / PR #81 changes
- generic migration-repair tooling

## Verification

Run:
- rollout shell in disposable DB across all failure states
- shell syntax
- relevant migration source invariant/static checks
- exact accepted migration SHA check
- `git diff --check`
- secret/project-ref scan

No broad app/runtime test rerun required because runtime source is unchanged.

## Completion / K3

Report:
- task_id/result
- changed_files
- accepted migration untouched proof + SHA
- runner/runbook design
- Stage A/B/C semantics
- failure-state results
- local tests
- production reads/writes = 0
- deploy/X/Vault/OAuth/Cron = 0
- exact future production operator sequence
- remaining risks
- whether an additional Codex review is truly necessary
- recommended reviewer model if needed, preferring Luna

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Review policy:
- do NOT automatically request Sol review.
- If K3 shows only runner/docs/test additions and all local failure-state proofs pass, prefer either no extra review or at most **Luna（高）** for a single focused rollout-script review.

---

# Previous G3 task history — preserved below

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr81-hardening-residual-corrective-20261005
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- type: bounded corrective implementation / migration drift / function ACL / CAS finite-domain / rollout plan
- continues_from: x-social-mobile-content-settings-schema-hardening-20261003
- target_pr: 81
- current_head: 5595fb131813542c55c43bc783af623cdb9ea442
- blocks_pr: 78
- production_mutation_allowed: false

## C2 verdict / purpose

H2 rereview of PR #81 returned **CHANGES REQUIRED**.

Important:
- the original large F1 JSON/persona contract issue is closed for inspected writer shapes;
- the original table ACL/RLS flaw is closed;
- finite-path CAS and normal concurrency behavior are closed;
- most drift checks are closed.

This task is **not** a redesign. It must correct exactly the remaining adversarial boundaries and produce a safe production-apply plan.

PR #81 remains open/unmerged. Production apply is still forbidden.

## Freshness / isolation

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / this TASK / full H2 rereview report.
2. Use the existing isolated G3 worktree only.
3. Fetch fresh `origin/main`.
4. Confirm PR #81 exact head is still `5595fb131813542c55c43bc783af623cdb9ea442` before editing. If head moved, STOP.
5. Fresh C2 comparison: main is 62 commits ahead of PR base with **0 overlap** across PR #81 files; still recheck before push.
6. G4 PR #76 and direct AI-Lab PR #82 are separate. Do not touch their migrations/files.
7. No production apply/write/deploy/Auth/Vault/X/OpenAI/Cron mutation.

## Residual R1 — reject deferrable PK drift

Current hardening validates PK key columns/count but not enough of the PK/index semantics.

H2 reproduced:
- replace the expected PK with `PRIMARY KEY (brand_id) DEFERRABLE INITIALLY IMMEDIATE`;
- hardening succeeds;
- actual repository `INSERT ... ON CONFLICT (brand_id) DO UPDATE` then fails with SQLSTATE 55000.

Correction requirements:
- explicitly require the expected immediate, non-deferrable PK contract;
- verify the backing unique index is usable as an ON CONFLICT arbiter;
- reject deferrable / initially deferred / unexpected PK/index drift;
- do **not** silently repair an unknown PK definition;
- add a disposable DB regression using the actual Settings upsert pattern, not catalog-only assertions.

Expected result:
- exact candidate PK -> accepted;
- deferrable/wrong PK -> hardening refuses before mutation;
- real owner upsert remains successful after hardening.

## Residual R2 — helper function owner / ACL drift

H2 reproduced an existing helper function with an unexpected EXECUTE grant to another role. `CREATE OR REPLACE` preserved that ACL and hardening did not reject it.

Correction requirements for all content-settings helper/version functions introduced or replaced by the hardening migration:
- validate exact expected signatures;
- fail closed on unexpected overloads;
- validate owner identity/policy before replacement;
- fail closed on unexpected pre-existing grantees / EXECUTE ACLs;
- after creation/replacement, assert exact effective EXECUTE privileges;
- PUBLIC / anon / service_role / unrelated roles must not inherit unexpected EXECUTE;
- authenticated may EXECUTE only the validator helper(s) that genuinely must run under CHECK evaluation;
- version trigger function must not be directly executable by app roles if not required;
- do not globally modify default privileges or unrelated role memberships;
- do not silently rewrite an unexpected owner/ACL drift unless the exact known transition is explicitly justified and tested.

Use effective privilege checks, not only `proacl` text.

Add regressions for:
- unknown helper EXECUTE grant;
- unexpected helper owner;
- unexpected overload/signature;
- post-hardening exact ACL.

## Residual R3 — finite CAS domain / infinity

H2 reproduced a valid historical row with:
`updated_at = 'infinity'`

The current trigger:
`greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`
cannot advance infinity, so the same old CAS token remains reusable.

Correction requirements:
- before hardening changes, explicitly refuse existing rows with non-finite `updated_at`;
- also assess `created_at` finite-domain expectations and document/enforce consistently if needed for invariant safety;
- do not silently rewrite historical infinity values;
- enforce finite timestamps for future rows/updates with a DB constraint or equivalent fail-closed invariant;
- server-owned INSERT/UPDATE version semantics remain unchanged for valid finite rows;
- preserve PR #78 string-token interface.

Add tests:
- existing updated_at=infinity -> hardening fails before mutation;
- negative infinity likewise;
- future finite timestamp (e.g. year 2999) remains valid if intended;
- post-hardening attempt to write non-finite version is rejected/overridden safely;
- same-transaction, concurrent one-winner, long-running earlier transaction, stale-token zero-row behavior remain GREEN.

## Whole-chain production apply plan

H2 proved actual Supabase CLI 2.116.0 gives **per-file atomicity**, not whole-chain atomicity.

The current chain is:
1. `20260922045046_social_mobile_content_settings_candidate.sql`
2. `20261003120000_social_mobile_content_settings_hardening.sql`

A normal migration-up can commit (1), then fail before/inside (2), temporarily leaving the known weak candidate live.

This task must produce a concrete rollout plan that avoids exposing the weak candidate.

Preferred options to evaluate:
- a reviewed operator-controlled outer transaction that applies both source files atomically and records migration history correctly/safely, OR
- a new deployment-safe source strategy that avoids ever exposing the weak intermediate state, without rewriting already-applied production history (none exists yet) and without breaking repo migration semantics.

Do not implement a production history repair or remote apply here.

Because production currently has neither migration version applied and the target table is absent, you may propose a source consolidation strategy **only if** it is clearly safer, preserves auditability, and H2 can independently review it. Do not silently rewrite the historical candidate without explaining why.

The completion report must state the exact intended production apply commands/transaction boundaries conceptually, but do not execute them.

## Preserve closed behavior

Do not regress:
- exact settings/persona JSON/type/key validation;
- endLocal 24:00 only;
- authenticated table privileges exactly SELECT/INSERT/UPDATE;
- DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN denied;
- owner-only RLS;
- no service-role DML requirement;
- server-owned finite monotonic updated_at;
- CAS stale zero-row semantics;
- brand FK cascade;
- no durable publish/token/OAuth controls in settings/persona;
- PR #78 source compatibility.

## Tests

Run independently after correction:

### SQL / migration
- original candidate -> corrected hardening
- reapply exact hardened shape
- all prior 20 drift cases
- deferrable PK drift
- wrong PK/index arbiter
- unknown helper EXECUTE grant
- unexpected helper owner
- unexpected overload
- infinity / -infinity existing versions
- exact effective function ACL
- table ACL/RLS
- valid historical rows unchanged
- invalid rows refuse
- same-tx CAS
- concurrent CAS one winner
- long-tx no regression
- actual repository upsert under authenticated owner
- cascade lifecycle
- no unrelated mutation.

### App/source
- focused content-settings repository tests
- full social-mobile tests
- PR #78 composition/merge-tree if useful
- typecheck
- lint
- relevant Deno shared tests
- bash syntax
- `git diff --check`
- secret/scope scan.

Use disposable local PostgreSQL/Supabase only.

## PR handling

Prefer amending PR #81 normally.

- preserve old reviewed head `5595fb131813542c55c43bc783af623cdb9ea442` in Report;
- normal push only; no force push;
- fresh-main integration only if needed;
- do not merge.

## Production safety

Forbidden:
- production migration apply / db push
- migration history repair
- production INSERT/UPDATE/DELETE
- RLS/grant/function change
- Edge deploy
- Auth/Vault/X/OpenAI/Cron mutation
- PR #78 merge/deploy.

Read-only catalog checks are optional only if required to confirm no new collision; do not read user content/PII.

## Completion / K3

Report:
- task_id/result
- R1 deferrable-PK fix and proof
- R2 helper owner/ACL fix and proof
- R3 finite-version fix and proof
- exact migration/source strategy chosen
- whole-chain production apply plan
- whether historical candidate changed and why
- changed_files
- SQL tests
- app/Deno tests
- old/new PR head
- fresh-main overlap
- production reads/mutations
- remaining risks
- safety checks
- next recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

After K3, H2 independent rereview is mandatory.

Recommended H2 model: **Sol（高）**.

## Report — x-social-mobile-pr81-hardening-residual-corrective-20261005

- task_id: x-social-mobile-pr81-hardening-residual-corrective-20261005
- result: **PASS (source + disposable local proof; nothing applied)**. Model: Opus 5.5.
- PR #81: old reviewed head `5595fb131813542c55c43bc783af623cdb9ea442` (confirmed unchanged before editing, preserved in history) -> new head `bcc01312c638f5922db4ffd6255ddddf6f611183`, normal push (no force), PR body appended truthfully. Not merged.
- PR #78 head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` untouched; `git merge-tree` of #78 onto new #81 head: clean (tree `7fb711e2`).
- fresh-main overlap: main changed 59 files since the PR merge-base; overlap with the 8 PR #81 files = **0**. Version `20261003120000` not present on main. G4 PR #76 / AI-Lab PR #82 files untouched.

### R1 — deferrable PK (fixed)
Guard now requires exactly one PK whose constraint is `not condeferrable`, `not condeferred`, `convalidated`, with key exactly (brand_id), backed by an index that is `indisprimary`, `indisunique`, `indimmediate`, valid/ready/live, 1 key column = brand_id, no predicate/expressions, btree, default opclass for the column type, collation = column collation. Unknown PK definitions are refused, never repaired. Proof: drift refusals `pk_deferrable` (the H2 reproduction), `pk_initially_deferred`, `pk_composite`, `pk_missing`; the actual Settings writer pattern `INSERT … ON CONFLICT (brand_id) DO UPDATE` as authenticated owner through RLS succeeds after hardening (behavior section A). Constraint- and index-side immediacy are two independent checks; removing both makes `pk_deferrable` accepted -> suite FAIL.

### R2 — helper owner/ACL (fixed)
Guard: every `public.social_mobile_content_settings_%` routine must be one of the six known signatures (legacy touch, text_ok, text_list_ok, valid_settings, valid_persona, version) by oid — no overloads, other names or procedures; `prokind='f'`; owner = table owner (CREATE OR REPLACE would otherwise keep a foreign owner); grantees only owner/PUBLIC/anon/authenticated/service_role. Post-conditions: exactly five functions by signature, all owned by the table owner; exact non-owner EXECUTE list = authenticated on the four validators only; effective `has_function_privilege` false for anon/service_role on all, false for authenticated on `version()`. No default-privilege or role-membership change. Proof: drift refusals `helper_unknown_grant` (H2 reproduction, real parameter names so CREATE OR REPLACE would otherwise succeed), `touch_unknown_grant`, `helper_overload`, `helper_unknown_name`, `helper_procedure`, `helper_owner` (owned by another role), plus `after_hardening_function_grant`; behavior asserts effective EXECUTE for anon/authenticated/service_role/an unrelated role on all five, PUBLIC none, legacy function removed, and that revoking EXECUTE on a validator or either nested helper makes the owner's write fail (42501) — the four grants are genuinely required. Removing guard + post-condition makes `helper_unknown_grant` accepted -> suite FAIL.

### R3 — finite versions (fixed)
Guard (before any change) refuses rows with non-finite `updated_at` or `created_at` (`…_EXISTING_ROWS_NONFINITE`), never rewriting them. New CHECK `social_mobile_content_settings_finite_versions` `((isfinite(created_at) and isfinite(updated_at)) is true)`. Trigger semantics unchanged (server-owned, `greatest(clock_timestamp(), old + 1us)`); string-token interface unchanged. Proof: `updated_infinity`, `updated_minus_infinity`, `created_infinity` refused with the row byte-identical and nothing created; a valid historical row with a 2999 version survives hardening byte-identical and advances by exactly 1us on the next update; caller-supplied ±infinity overridden on update; with the trigger disabled, infinite values are refused by the CHECK while a finite 2999 value is accepted; same-tx / concurrent one-winner / long-tx no-regression / stale-zero-row / competing insert all still PASS. Removing guard + CHECK -> suite FAIL.

### Migration / source strategy
Historical candidate **unchanged** (its reviewed shape is exactly what the guard accepts; rewriting would discard review history and production has nothing applied, so there is nothing to gain). The hardening migration was amended in place (it is itself unapplied anywhere). Whole-chain safety comes from the apply procedure, not from rewriting history.

### Whole-chain production apply plan (documented, NOT executed)
`supabase/tests/social_mobile_content_settings_rollout.md`: same-day read-only preflight (table/functions absent, both versions absent from history, history column list, applying role owns brands, default ACL grantees only anon/authenticated/service_role, dependency shape, other pending migrations e.g. G4 `20261003090000` coordinated first). Apply in ONE outer transaction from the reviewed commit:
`psql "<prod URL by operator>" --single-transaction -v ON_ERROR_STOP=1 -f …20260922045046_…candidate.sql -f …20261003120000_…hardening.sql -c "insert into supabase_migrations.schema_migrations (version, name) values ('20260922045046','social_mobile_content_settings_candidate'), ('20261003120000','social_mobile_content_settings_hardening')"`
— schema and history commit together or not at all; never `db push`/`migration up` for these versions. Then a separate read-only read-back (history, RLS/policies, effective table and function privileges, constraints, single trigger). Failure handling = a separately approved removal transaction. Rehearsed locally: `SMCS_ATOMIC_CHAIN_REHEARSAL_PASS` (atomic success with both history rows; a forced failure after the hardening leaves no table and no history; per-file application of the same failure leaves the weak candidate — the contrast that motivates the plan).

### changed_files (this corrective commit)
- supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql (R1/R2/R3 + header)
- supabase/tests/social_mobile_content_settings_behavior.sql (function ACL, nested EXECUTE, finite checks)
- supabase/tests/social_mobile_content_settings_run.sh (rollout rehearsal, 14 new drift/non-finite/historical cases)
- supabase/tests/social_mobile_content_settings_rollout.md (new)
- supabase/functions/_shared/brand/social_mobile_content_settings_hardening_static_test.ts (R1/R2/R3/rollout invariants)

### SQL tests (disposable local PostgreSQL 17.11, socket-only, non-superuser owner, fake data)
`SOCIAL_MOBILE_CONTENT_SETTINGS_ALL_PASS` with 48 PASS markers (run twice): apply + re-run, single-transaction apply, atomic-chain rehearsal, behavior (contract 61+24 invalid cases, legitimate payloads incl. real upsert, table ACL/RLS, exact function ACL, CAS, finite, lifecycle/cascade, unrelated untouched), concurrent CAS one winner, long-tx no regression, competing insert, invalid rows refused, **37 drift refusals** (prior 20 + after-hardening + 4 PK + 6 function + function-grant after hardening … incl. all prior cases), 3 non-finite refusals, valid historical row unchanged, 3 enumerated repairs, cleanup. Mutation checks: combined removal of each new defence (R1 both immediacy checks; R2 guard + post-condition; R3 guard + CHECK) -> suite FAIL; single-layer removals are caught by the other layer (defence in depth). All disposable DBs dropped; cluster stopped and deleted.

### App / Deno tests
social-mobile 116/116; typecheck 0; lint 0; `deno test --no-check` `_shared/brand` + dry-run 162/162 (incl. 9 static invariants); `deno lint` clean; `bash -n` clean; `git diff --check` clean. App code unchanged in this commit; validators not loosened.

### Production reads / mutations
Production reads: 0. Production apply / db push / history repair / writes / RLS / grants / functions / deploy: 0. Auth/Vault/X/OpenAI/Cron: 0.

### Remaining risks
1. The rollout's history insert assumes `schema_migrations(version, name)` suffices for the CLI in use — confirm the column list in the preflight; the plan is a reviewed manual step and needs explicit approval.
2. Cross-PR version collision noted by H2 (PR #76 and #82 both `20261003090000`) is outside PR #81 but affects any later `db push`; settle before combining histories.
3. Local PostgreSQL proof only (no managed Supabase/PostgREST E2E).
4. Validators remain callable via PostgREST RPC by authenticated (pure booleans).
5. Structural validation only (no semantic secret detection in free text).

### Safety checks
Own G3 worktree/branch only; normal push; explicit-path staging; other workstreams' files untouched; untracked supabase/.temp and supabase/config.toml left alone; no secrets/PII in code, tests, PR or report.

### Next recommendation
H2 independent rereview of PR #81 at `bcc01312` (Sol（高）), focusing on R1–R3 closure and the rollout plan. Then a separately approved production apply per the plan with preflight and read-back. Only after that, rebase PR #78 and resume its review.

---

# Claude Task 3 — CURRENT TASK

- task_id: x-social-mobile-content-settings-schema-hardening-20261003
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: codex
- priority: highest
- recommended_model: Opus5.5（高）
- type: corrective implementation / DB migration / RLS / JSON contract / optimistic concurrency
- continues_from: x-social-mobile-ai-consult-v1-20261002
- blocks_pr: 78
- production_mutation_allowed: false

## C2 verdict / purpose

H2 independently reviewed the existing source-only migration candidate:

`supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`

and returned **FAIL / CHANGES REQUIRED**.

PR #78 AI相談 v1 remains open/unmerged. The AI consultation source is not rejected on its merits; its durable settings/persona persistence prerequisite is not safe enough yet.

This TASK hardens that schema prerequisite **in source + local disposable tests only**.

Do NOT apply any migration to production.

## Accepted H2 findings to correct

### F1 / P1 — JSON boundary too weak

The existing CHECKs allow durable malformed or forbidden data because SQL CHECK may evaluate NULL and pass, and `->>` coerces types.

H2 reproduced acceptance of examples including:
- required fields present but null
- wrong scalar types that coerce through `->>`
- malformed/missing generationWindow members
- arrays with non-string/null/object members or overlong strings
- structurally forbidden settings keys such as token/secret/oauth/publish controls
- nested forbidden controls
- persona fields with forbidden token/publish/history-like content or wrong types.

The DB boundary must validate exact structured shape/types compatible with legitimate current app/server writers.

### F2 / P1 — effective ACL too broad

Production default ACL means the unchanged candidate can leave authenticated with non-DML privileges such as:
- TRUNCATE
- TRIGGER
- REFERENCES
- MAINTAIN

H2 locally proved an authenticated role could TRUNCATE the settings table despite DELETE being denied.

The corrected migration must normalize effective table privileges to true least privilege.

### F3 / P2 — updated_at is not a robust version

Current trigger uses `now()`, which is transaction-start time.

H2 proved:
- two updates within one transaction can retain the same timestamp
- an earlier long-running transaction can write a timestamp older than a later transaction's version.

PR #78 relies on `updated_at` as a compare-and-swap version, so the server-owned update value must be strictly monotonic for that row.

### F4 / P2 — drift silently accepted

`CREATE TABLE IF NOT EXISTS` lets a same-name but drifted table survive migration.
H2 removed CHECK/FK constraints in a disposable DB, reran the original candidate, and migration succeeded while those constraints remained absent.

The migration path must fail closed on unknown/unsafe drift rather than silently claim success.

## Mandatory startup / isolation

1. Read PROJECT_RULES, CLAUDE.md, ORCHESTRATION, CURRENT_STATE, this TASK.
2. Read the full H2 report for `x-social-mobile-content-settings-schema-prereq-review-20261002`.
3. Use independent G3 worktree/checkout.
4. Fresh origin/main and PR #78 branch/head.
5. Preserve original PR #78 head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` as review history.
6. G4 is independently changing publish-toggle authorization/migration/RPC. Do not touch its migration/RPC/function/files. Use a unique migration version and confirm no filename/order collision before push.
7. H1 is reviewing Kabumori PR #79. Do not touch H1/G2 files.
8. Read Supabase skill before DB work.
9. No production apply/write/deploy.

## Migration strategy

Default: **preserve the historical source-candidate migration and add a new versioned hardening migration**.

Do not silently rewrite `20260922045046_social_mobile_content_settings_candidate.sql`.

If you believe consolidation/editing the historical never-applied migration is materially safer, STOP and report exact migration-history evidence and rollout rationale before changing that strategy. Do not make that choice implicitly.

The new hardening migration must work safely when:
- the original candidate has just created the exact expected table, and
- the exact candidate already exists in a disposable/local environment.

Unknown drift must fail explicitly.

Production currently has no target table and no applied version `20260922045046`; that fact does not authorize apply here.

## Required corrected contract

### 1. Exact durable settings shape

Use current source types/normalizers as the canonical value contract.

At DB level, reject missing/null/wrong-type/unknown structured fields as appropriate.

Validate at minimum:
- root `settings` is object
- exact/approved root keys only
- `locale` string and currently supported values
- `preferredTone` string, bounded
- `themes` array of bounded strings, bounded count and per-item length
- `objective` string, bounded
- `frequencyTargetPerWeek` JSON number/integer semantics matching current writers; do not accept string coercion unless current canonical writer intentionally stores strings (prove if so)
- `approvalMode` exact allowed values
- `generationWindow` object with approved keys only
- timezone string constrained to current legitimate contract; do not invent support that app/server cannot consume
- `startLocal` time, **24:00 forbidden**
- `endLocal` time, **24:00 allowed**
- `defaultGenerationLocal` time, **24:00 forbidden**
- `generationDayOffset` actual canonical type and allowed values
- `optionalNgWords` array of bounded strings, count and per-item length
- `notes` string, bounded.

The DB is a structural safety boundary. Do not claim it can detect whether arbitrary allowed human text semantically contains a "secret"; that is not realistic.

### 2. Exact persona shape

Derive exact allowed durable keys/types from the current `PersonaProfile` model and server materializer.

Requirements:
- root object only
- exact approved keys only
- bounded strings/arrays/numbers as applicable
- no raw posts/history bodies
- no token/OAuth/publish/account/scheduler/Auth controls
- provenance/confirmed/analyzed metadata remain in dedicated columns where the current schema expects them, not silently duplicated into arbitrary JSON
- existing legitimate conversation and future bounded past-post-analysis profiles remain representable.

Do not weaken client/server validators to make malformed DB rows pass.

### 3. Null-safe CHECK semantics

Every invariant must evaluate to TRUE for a valid row, not merely "not false".

Use explicit `IS TRUE`, `jsonb_typeof`, key-existence/keyset tests, helper functions if justified, or equivalent fail-closed SQL.

Avoid unsafe cast order where malformed JSON can produce migration/runtime errors rather than a clean CHECK failure.

If helper validation functions are introduced:
- fixed search_path
- least privilege
- deterministic/immutable semantics where valid
- no dynamic SQL
- no user-controlled object names
- explicit EXECUTE grants/revokes.

### 4. Least-privilege ACL

Normalize effective ACL for this table/function(s).

At minimum:
- PUBLIC: no table privileges
- anon: no table privileges
- authenticated: only the exact operations needed by current mobile settings flow (expected SELECT/INSERT/UPDATE)
- DELETE denied
- TRUNCATE denied
- REFERENCES denied unless concretely needed
- TRIGGER denied
- MAINTAIN denied
- service_role: grant only what a current proven server path actually needs; do not inherit broad defaults by accident.

Do not globally alter database default privileges or unrelated tables.

RLS remains enabled and owner-scoped to exact `brand_id + auth.uid()`.

Test effective privileges, not only the GRANT statements in the file.

### 5. Monotonic CAS version

Keep compatibility with PR #78's `updated_at timestamptz` CAS unless a change is demonstrably necessary.

Preferred bounded approach to evaluate:
`greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`
on every UPDATE, ignoring caller-supplied version.

Requirements:
- strictly greater than OLD.updated_at
- cannot regress due to transaction-start time
- same transaction repeated updates advance
- normal concurrent CAS yields one winner
- stale old timestamp yields zero updates
- caller cannot set arbitrary future/past version
- insert gets a server-owned initial version.

If PostgreSQL timestamptz precision/serialization creates any remaining ABA/collision issue, document and fix before declaring PASS. A revision integer is allowed only if coordinated app/schema change is justified; avoid unnecessary scope expansion.

### 6. Drift guard / migration safety

The hardening migration must distinguish:
- expected exact candidate shape -> harden successfully
- already-hardened exact shape -> safe/idempotent behavior where migration tooling may re-run in disposable tests
- unexpected same-name relation/column/FK/CHECK/function/trigger/policy drift -> explicit failure.

Do not silently repair arbitrary unknown drift unless every repaired property is deliberately enumerated and safe.

Validate:
- expected columns/types/nullability/defaults
- PK/FK target + ON DELETE action
- expected relation kind/schema
- policy/function/trigger identity where relevant.

Avoid trusting constraint names alone; verify definitions/columns/actions for security-critical properties.

### 7. FK / lifecycle compatibility

Confirm:
- `brand_id` text compatible with current `brands(id)`
- FK ON DELETE CASCADE is still intended
- settings row disappears with brand deletion
- current common-account source work does not require a different owner key
- no dependency on unapplied common-account production schema for this table to function
- no interference with G4's new publish-toggle migration/RPC.

## Local disposable proof

Use G3-owned disposable PostgreSQL/Supabase environment only.

Must execute:

### Valid behavior
- original candidate -> hardening migration succeeds
- legitimate default row succeeds
- current Settings screen payloads succeed
- current PR #78 save/persona payloads succeed
- endLocal 24:00 succeeds
- startLocal/defaultGenerationLocal 24:00 fail
- legitimate persona examples succeed.

### Invalid JSON/persona
Regression-test H2 adverse cases:
- missing/null required fields
- wrong scalar types
- numeric/bool text coercion
- malformed generationWindow
- unknown root/window/persona keys
- non-string array items
- overlong array items
- forbidden publish/token/oauth/account/scheduler-like structured keys
- invalid persona shapes.

### ACL/RLS
Under representative roles:
- owner SELECT/INSERT/UPDATE succeed
- owner DELETE fails
- owner TRUNCATE fails
- owner cannot CREATE TRIGGER on table
- owner cannot use REFERENCES privilege
- member/viewer/nonmember/cross-brand fail DML/read as intended
- anon fails
- effective privilege queries prove only intended privileges.

### CAS
- distinct transactions advance
- two updates in same transaction advance strictly
- long-running earlier transaction cannot regress version
- concurrent CAS exactly one winner
- stale CAS zero rows
- competing insert -> unique conflict
- caller-supplied timestamp cannot control version.

### Drift
Create representative bad same-name structures:
- missing FK
- wrong FK target/action
- missing/weak CHECK
- wrong column type/nullability
- wrong trigger/function/policy
and prove hardening refuses unknown drift or explicitly repairs only the enumerated safe case.

### Lifecycle
- brand delete cascades settings row
- no unrelated rows/tables touched.

Drop disposable DB/cluster after proof.

## Source consumers / tests

Compare and run:
- current content-settings domain validators
- content-settings repository
- shared server normalizer/materializer
- PR #78 tests where source can be tested without production table
- full social-mobile tests
- relevant Deno/shared tests
- migration-specific SQL test harness
- typecheck/lint
- `git diff --check`
- secret/scope scan.

Do not loosen application validators simply because the DB is hardened.

## PR #78 handling

You may amend PR #78 with the new hardening migration/tests if that is the cleanest ownership path, because G3 owns the blocked feature.

If you do:
- keep exact original head in Report
- rebase/fresh-main safely
- ensure no overlap with G4 migration/RPC work
- update PR body truthfully
- do not merge.

Alternatively create a dedicated prerequisite PR and report dependency ordering. Choose based on smallest conflict and clearest rollout; document why.

## Production safety

Forbidden:
- production migration apply
- production settings INSERT/UPDATE/DELETE
- production RLS/grant/function change
- Edge deploy
- Auth/Vault/X/OpenAI/Cron mutation
- PR #78 merge.

Read-only production catalog inspection is allowed only if needed to confirm no new collision since H2.

## Completion / K3

Report:
- task_id/result
- migration strategy chosen
- original H2 F1-F4 disposition
- exact table/settings/persona contract
- ACL/RLS result
- monotonic CAS design and proofs
- drift handling
- lifecycle/common-account compatibility
- changed_files
- local disposable SQL evidence
- app/server tests
- original PR #78 head and new PR/dependency head
- production reads/mutations
- remaining risks
- safety checks
- next recommendation.

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

After K3, allocate fresh H2 review before any production apply or PR #78 merge.

Recommended Codex rereview: **Sol（高）**.

## Report — x-social-mobile-content-settings-schema-hardening-20261003

- task_id: x-social-mobile-content-settings-schema-hardening-20261003
- result: **PASS (source + disposable local proof; nothing applied)**. Model: Opus 5.5.
- PR: https://github.com/anohi-memories/kabumori/pull/81 — branch `claude/g3-content-settings-hardening-20261003`, head `5595fb13` (rebased on origin/main `cde3a7d3`), pushed. Not merged.
- original PR #78 head: `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` — **unchanged** (not amended, not rebased). Dependency order: #81 (review -> separate apply approval -> apply) first, then #78 rebased on it. `git merge-tree` of #78 onto #81: clean, no conflict (only shared file: content-settings-repository.ts).

### Migration strategy
- Kept `20260922045046_social_mobile_content_settings_candidate.sql` byte-unchanged as history; added `20261003120000_social_mobile_content_settings_hardening.sql` after it.
- Unique version; G4 PR #76 uses `20261003090000_social_mobile_publish_permission_boundary.sql` and does not reference this table/its functions (grep of its migration on the fetched branch: 0 hits). No H1/G2/G4 file touched.
- Chosen over amending #78: the table is a prerequisite of main's existing Settings screen too, so it can be reviewed/applied on its own and #78 stays a pure feature PR.
- Must run inside one transaction (migration tool / `psql -1`); the file itself has no BEGIN/COMMIT. All checks run before the first change; post-conditions after the last.

### H2 F1–F4 disposition
- F1 FIXED: `social_mobile_content_settings_valid_settings(jsonb)` / `_valid_persona(jsonb)` (+ `_text_ok`, `_text_list_ok`): plpgsql IMMUTABLE PARALLEL SAFE, `search_path=pg_catalog`, no dynamic SQL, type checked before any cast, never NULL. CHECKs are `(... ) is true`. Candidate shape CHECKs replaced.
- F2 FIXED: `revoke all ... from public, anon, authenticated, service_role` + `grant select, insert, update ... to authenticated`; validators EXECUTE to authenticated only (proven necessary: CHECK runs with the writer's privileges); version function EXECUTE to nobody. No default-privilege change. Post-condition asserts the exact effective ACL and zero column ACLs.
- F3 FIXED: single trigger `social_mobile_content_settings_version` BEFORE INSERT OR UPDATE; INSERT sets created_at=updated_at=clock_timestamp(); UPDATE keeps created_at and sets `greatest(clock_timestamp(), old.updated_at + 1us)`. Old `touch_updated_at` trigger+function dropped. timestamptz stays (PR #78 CAS contract unchanged).
- F4 FIXED: catalog drift guard (see below) + refusal when existing rows break the contract (`..._EXISTING_ROWS_INVALID`, nothing rewritten).

### Exact table / settings / persona contract
- Columns (exact set): brand_id text NOT NULL PK + FK -> public.brands(id) ON DELETE CASCADE; settings jsonb NOT NULL; persona_profile jsonb NOT NULL default {}; persona_provenance text NOT NULL in (conversation, past_post_analysis, manual); persona_confirmed boolean NOT NULL default false; persona_last_analyzed_at timestamptz NULL; persona_last_analyzed_count integer NULL 0..1000; created_at/updated_at timestamptz NOT NULL (server-owned).
- settings: exactly {locale, preferredTone, themes, objective, frequencyTargetPerWeek, approvalMode, generationWindow, optionalNgWords, notes}; locale = "ja-JP"; preferredTone string 1..120 non-blank; themes array <=8 of non-blank strings <=100; objective 1..160 non-blank; frequencyTargetPerWeek JSON number, integer 0..14; approvalMode "manual_review"|"auto_post_preference"; generationWindow exactly {timezone="Asia/Tokyo", startLocal HH:MM (no 24:00), endLocal HH:MM or 24:00, defaultGenerationLocal HH:MM (no 24:00), generationDayOffset JSON number -1|0}; optionalNgWords array <=20 of non-blank strings <=60; notes string <=1000. Blank = only ASCII/full-width whitespace.
- persona_profile: object with only {toneSignals <=20x80, recurringVocabulary <=30x50, topicSignals <=20x80, openingClosingPatterns <=20x100 (non-blank string items), punctuationEmoji/hashtagHabits/ctaStyle strings <=200, sentenceLength short|mixed|long}. source/confirmed/analyzedAt/analyzedPostCount are column data and refused as JSON keys.
- Not claimed: semantic secret detection inside allowed free text.

### ACL / RLS result
Effective privileges (has_table_privilege, all 8 privileges incl. MAINTAIN) for anon/authenticated/service_role: only authenticated SELECT/INSERT/UPDATE; PUBLIC none; no column ACL. RLS enabled; the three owner policies recreated unchanged in meaning (`brand_id` + `(select auth.uid())` + role owner); no DELETE policy. Proven: owner SELECT/INSERT/UPDATE ok; owner DELETE/TRUNCATE/CREATE TRIGGER/REFERENCES/ALTER denied (42501); admin/member/viewer/non-member see 0, update 0, insert denied; owner A cannot update/insert/move rows to brand B/C; anon and service_role denied.

### Monotonic CAS design and proofs
Distinct transactions advance; two updates in one transaction advance strictly and the first version then matches 0; stale CAS 0 rows; current CAS 1 row; caller-supplied updated_at/created_at (future or past) ignored; update cannot move the version back; from a far-future stored version it still advances by exactly 1us per update; `to_json(updated_at)` token round-trips exactly. Two-connection: concurrent CAS on one version -> changed=1 / changed=0 and the first writer's value stored; an earlier long-running transaction updating after a later commit still ends strictly above it; two first inserts -> one row + duplicate key. Residual: only a delete+recreate of the same brand id combined with a backwards wall clock could reproduce an old token (users cannot DELETE; rows disappear only with their brand).

### Drift handling
Accepted states: exact candidate, or the hardened shape (safe re-run proven). Verified by definition: relation kind/schema, no inheritance/partition, exact column name/type/nullability/identity/generated set, single PK on brand_id, single FK brand_id -> brands.id ON DELETE CASCADE / ON UPDATE NO ACTION / validated / not deferrable, only known-named CHECKs, only the PK index, only the candidate/hardened trigger bound to its own function, only the three owner policies, grantees only owner/PUBLIC/anon/authenticated/service_role (table and column). Refused in proof (20): FK missing / retargeted / RESTRICT / NOT VALID / extra; column type / nullable / extra / missing; unknown CHECK; extra UNIQUE; extra index; unknown trigger; rebound trigger; extra policy; unknown table grantee; unknown column grantee; table missing; same-name view; drift introduced after hardening. Each refusal leaves no partial change. Enumerated repair only: weakened or missing known-named candidate CHECK, and over-broad grants to anon/authenticated/service_role -> replaced/normalised (proven).

### Lifecycle / common-account compatibility
brand_id text matches brands.id text; ON DELETE CASCADE kept and proven (also when the deleting role has no privilege on this table — the RI action runs as the table owner); other brand's row and an unrelated table untouched. No dependency on the unapplied common-account (PR #70) schema; owner key stays the existing brand membership model. No interaction with G4's publish-toggle migration/RPC.

### changed_files (PR #81)
- supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql (new)
- supabase/tests/social_mobile_content_settings_{fixture.sql,behavior.sql,run.sh} (new)
- supabase/functions/_shared/brand/social_mobile_content_settings_hardening_static_test.ts (new)
- apps/social-mobile/src/data/content-settings-repository.ts (saveConfirmedProposal no longer copies analyzedAt/analyzedPostCount into persona_profile)
- apps/social-mobile/tests/content-settings-repository.test.mjs (new)

### Local disposable SQL evidence
Homebrew PostgreSQL 17.11, own cluster, Unix socket under /private/tmp only, lc_messages=C, non-superuser owner, fixture default ACL = ALL to anon/authenticated/service_role (broader than production's TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). Runner output: APPLY_AND_RERUN, SINGLE_TRANSACTION_APPLY, BEHAVIOR (61 invalid settings + 24 invalid persona cases rejected with 23514; legitimate default/Settings/bounds/24:00/PR78 persona/full analysis persona accepted; ACL/RLS; CAS; lifecycle), CONCURRENT_CAS_ONE_WINNER, LONG_TRANSACTION_NO_REGRESSION, COMPETING_INSERT_UNIQUE, EXISTING_INVALID_ROWS_REFUSED, DRIFT_REFUSED x20, ENUMERATED_REPAIR x3, CLEANUP -> `SOCIAL_MOBILE_CONTENT_SETTINGS_ALL_PASS`. Mutation checks (8): version via now(), no key-count check, FK action unchecked, frequency type unchecked, blank text allowed, startLocal unchecked, extra policy tolerated, ACL normalisation + post-condition removed -> each made the suite fail. All disposable databases dropped; cluster stopped and deleted.

### App / server tests
social-mobile `npm test` 116/116 (incl. 3 new repository tests); typecheck 0; lint 0; `deno test --no-check` `_shared/brand` + `social-mobile-brand-dry-run` 158/158 (incl. 5 new static invariants; candidate static tests still pass); `deno lint` clean; `bash -n` clean; `git diff --check` clean. App validators were not loosened. Note: main's app validator still rejects its own 24:00 default — fixed in PR #78 (not merged here, per H2).

### Production reads / mutations
Production reads: 0 (no catalog inspection needed; relied on H2's 2026-10-03 read-only facts). Production mutations / apply / deploy / RLS / grants / migration history: 0. OpenAI / X / Auth / Vault / Cron: 0.

### Remaining risks
1. If production's default ACL also grants this new table to a role other than anon/authenticated/service_role, the guard stops the migration (fail closed). Do a read-only `aclexplode(acldefault)` / default-ACL check in the apply preflight.
2. Validators are public functions callable via PostgREST RPC by authenticated (pure boolean, no side effects). Moving them to a non-exposed schema would be a separate decision.
3. Structural validation only; free text is not secret-scanned.
4. Theoretical old-token reuse only after brand delete+recreate with a backwards clock (see CAS).
5. Requires transactional application; not tested through managed Supabase/PostgREST (local PostgreSQL only).
6. #78 must still be rebased after #81 and re-reviewed for its own A–H gates.

### Safety checks
Own G3 worktree/branch; explicit-path staging; no other slot's files; untracked supabase/.temp and supabase/config.toml left alone; no secrets/tokens/personal data in code, tests, PR or report.

### Next recommendation
H2 rereview of PR #81 (Sol（高）): contract completeness vs writers, ACL/default-ACL assumptions, CAS trigger, drift guard coverage. Then a separate, explicitly approved production apply with read-only preflight and read-back. Only after that, rebase PR #78 and resume its review.

---

# Claude Task 3 — CURRENT TASK

- task_id: x-social-mobile-ai-consult-v1-20261002
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: codex
- priority: high
- recommended_model: Opus5.5（高）
- type: feature implementation / AI conversation / Edge Function / authenticated settings proposal
- production_mutation_allowed: false

## Product goal

X自動投稿アプリの「AIと相談する」を、現在のローカル疑似判定から**本当にAIと自然に会話できる機能**へ進める。

この機能は投稿生成そのものではなく、その前段としてAIがユーザーを理解する場所。

ユーザーは普通の会話で、
- どんな投稿をしたいか相談する
- AIから不足情報を質問してもらう
- 発信テーマ、文体、読者、目的、NG表現などを整理する
- 現在AIが理解している投稿方針を聞く
- 簡単な雑談や一般的な質問をする
ことができる。

会話から設定変更候補が生まれても、**AIは勝手に保存しない**。
必ずユーザーが内容を確認して「これで覚えて」等の明示操作をした後だけ、既存の投稿設定 / PersonaProfileへ保存する。

過去X投稿の実取得・分析はこのTASKでは行わない。現在の同意導線・意図検出を壊さず、K3後に別G4 TASKとして接続できる境界だけ維持する。

## Existing foundation — preserve and reuse

Fresh mainで以下が既に存在する。

- `apps/social-mobile/src/app/(tabs)/consult.tsx`
  - 会話画面
  - 保存前提案カード
  - 明示確認
  - existing settings/persona read/save
- `apps/social-mobile/src/domain/content-settings.ts`
  - `SocialMobileContentSettings`
  - `PersonaProfile`
- `apps/social-mobile/src/domain/content-settings-conversation.ts`
  - bounded structured proposal
  - untrusted AI-output validator
  - publish/account/OAuth/token/scheduler controlsの拒否
  - past-post learning intent scaffold
- `apps/social-mobile/src/data/content-settings-repository.ts`
  - existing `social_mobile_content_settings` storage
  - settings + confirmed persona save
  - settings-only saveがpersonaを消さない設計

Current `createConversationalAssistantProposal()` is deterministic/local scaffolding. This TASK replaces the runtime conversation path with an authenticated server-side AI boundary while keeping deterministic helpers/validators useful for tests/fallback where appropriate.

## Mandatory startup / isolation

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G3 worktree/checkout. Do not use G1/G2/G4/G5/H1/H2 worktrees, untracked files, simulator, Metro or branch.
3. Fresh `origin/main`.
4. Confirm G4 is done and PR #65 merged.
5. Confirm G5/H1 common-account PR #70 work does not overlap intended runtime files.
6. **Do not create or edit a DB migration in this TASK.** Existing `social_mobile_content_settings` schema/persona columns are the storage boundary. If production/source schema is actually insufficient, STOP and report the exact missing column/constraint instead of creating a migration while the common-account migration review is active.
7. Inspect existing AI/LLM Edge Functions/shared helpers/model config and reuse the established provider/client/usage/error patterns. Do not introduce a new AI vendor or duplicate secret scheme.

## Functional requirements

### 1. Real conversational AI

Implement an authenticated server-side AI conversation endpoint for social-mobile consultation.

Preferred boundary:
- a dedicated narrowly scoped Edge Function such as `social-mobile-consult`, unless repository conventions clearly point to an existing suitable endpoint.
- client never receives AI provider secret.
- no direct provider call from Expo client.

Request should be bounded and include only what the assistant needs:
- current brand/workspace id
- current confirmed `SocialMobileContentSettings`
- current confirmed `PersonaProfile` if present
- bounded recent conversation turns from this consultation session
- current user message

Do not send:
- OAuth tokens
- X access/refresh tokens
- Vault ids/plaintext
- provider credentials
- unrelated workspace data
- raw account deletion/auth internals.

Keep history bounded. Do not send an unlimited chat transcript.

### 2. Natural conversation modes

The AI must support at least these behaviors without requiring explicit mode buttons:

**A. General conversation / simple questions**
Examples:
- 「今日何投稿しようかな」
- 「Xってどれくらいの頻度がいい？」
- 「最近ネタがない」
- 「ちょっと疲れた」
- simple casual conversation / brainstorming / general questions

It should answer naturally.
A normal answer **must not automatically create a settings proposal**.

No web search/current-news browsing in v1. If the user asks for genuinely current/external facts that cannot be known from supplied context, the assistant should say that this consultation chat does not currently fetch live web information rather than inventing it.

**B. Preference discovery**
When the user wants help deciding posting style or has not supplied enough detail, AI should ask concise follow-up questions naturally.

Important:
- avoid a rigid questionnaire dump.
- ask preferably 1 useful question at a time, at most 2 when tightly related.
- do not force questions when enough information exists.
- use already confirmed settings/persona so it does not repeatedly ask what it already knows.

Useful dimensions include:
- main themes
- intended audience
- purpose
- tone/formality
- post length / sentence length
- emoji/punctuation tendencies
- CTA style
- hashtag tendency
- topics/expressions to avoid
- posting frequency preference
- personal/private disclosure boundaries where explicitly discussed

Do not invent personal facts.

**C. Explain current understanding**
If user asks things like:
- 「今どういう設定になってる？」
- 「俺の投稿方針どう理解してる？」
AI should explain the currently saved settings/persona clearly without proposing a mutation unless the user asks to change something.

**D. Settings/persona proposal**
Only when the conversation contains a reasonably clear preference/change should the AI return a structured proposal delta.

Examples:
- 「もっと親しみやすくして」
- 「AIの話を多めにしたい」
- 「絵文字は少なめ」
- 「週5回くらい」

Proposal must be a **delta**, not a replacement snapshot, so unrelated saved fields are preserved.

Ambiguous statements such as「AIの話多めでもいいかな」should be handled conversationally and may ask/offer confirmation rather than silently treating them as durable settings.

### 3. Structured AI contract

Keep/reuse `validateConversationalAssistantResult()` as the trust boundary and strengthen it if needed.

Model output must be parsed as untrusted structured data containing conceptually:
- assistant reply
- optional settings delta
- optional persona delta
- follow-up questions
- confidence / uncertainty
- history-learning intent
- requires confirmation = true for any persistent change
- publish permission changed = false

Add explicit distinction if helpful between:
- chat-only response
- clarification/question
- proposal

But do not allow the model to control:
- auto-post on/off
- publish permission
- posting execution
- scheduler
- OAuth/account selection
- Auth/session
- deletion
- secrets/tokens.

Malformed/unsafe structured output must fail closed:
- show a safe retryable assistant error or safe chat fallback
- do not save anything
- do not alter posting state.

### 4. Confirmation and persistence

Existing principle remains mandatory:

**conversation → proposal → user confirmation → save**

Never:
- mutate settings on AI response arrival
- mutate persona because AI “learned” something without confirmation
- enable posting
- create scheduled posts
- change X connection.

When user confirms:
- apply only the returned delta to the latest known/safely refreshed saved state
- preserve unrelated existing fields
- save settings/persona using the existing repository/storage boundary
- visibly report save success/failure.

If a proposal became stale because saved settings changed during the conversation, prefer re-read/merge or require reconfirmation rather than silently overwriting unrelated newer settings.

### 5. Conversation UX — functional only

UI design will be substantially redesigned later. Do NOT spend time on polish.

Functional minimum:
- user message input
- send action
- visible assistant/user turns
- loading state
- retryable error state
- proposal/“AIが理解した内容” block only when there is something persistent to confirm
- clear explicit confirmation button
- clear indication after successful save
- user can keep chatting after a proposal/save
- current settings can be explained through conversation.

Do not redesign global navigation, theme, cards, spacing, animation, avatar, etc.

### 6. Past-post learning handoff

Do **not** fetch X history in this TASK.

If user says:
- 「過去の投稿を読んで」
- 「自分の過去ポストから学んで」
the AI may recognize the intent and explain that past-post learning requires explicit confirmation / the upcoming learning flow.

Preserve a structured `historyLearningIntent` boundary so the next G4 task can attach:
- verified connected X account
- bounded post fetch
- style analysis
- user confirmation
without redesigning this chat contract.

No X API read/write in this TASK.

## Authentication / authorization boundary

Because this adds an Edge Function/API boundary:

1. Require valid user JWT/session.
2. Do not trust a client-supplied brand id by itself.
3. Verify the caller has current allowed membership/ownership for that brand using the repository's established social-mobile authorization pattern.
4. Do not use future/common-account service entitlement semantics from unmerged PR #70.
5. Fail closed for missing/ambiguous membership.
6. Never log Authorization headers, JWTs, user email, AI provider secrets, X tokens, or full sensitive conversation bodies.
7. Prefer metadata-only logs: request id, result class, bounded lengths/counts, error code, duration/model usage if existing conventions support it.

## Cost / abuse bounds

Reuse existing AI cost/usage helpers if present.

At minimum:
- cap user message length
- cap number of conversation turns sent
- cap total context length
- cap model output
- one model call per send under normal path
- no automatic recursive “agent” loops
- no web search
- no X API call
- bounded timeout
- deterministic error path.

Use the least expensive existing model/config that safely supports the repository's structured-output contract; do not introduce a premium model simply because Claude is implementing the feature.

## Data/privacy behavior

For v1:
- do not create a new table to persist raw chat transcripts.
- raw conversation may live in screen/session state only.
- durable memory is the **user-confirmed structured settings/persona**, not the entire transcript.
- do not store raw conversation text in analytics/logs.
- if existing observability captures request bodies, explicitly prevent consultation text from being logged there.

This keeps the “AI learns me” behavior transparent: it remembers only what the user confirms.

## Tests

Add focused tests for at least:

### Server/API
- unauthenticated request rejected
- caller without brand membership rejected
- valid member accepted
- bounded message/history input
- oversized/malformed input rejected
- AI secret never returned/logged
- safe model response parses
- malformed JSON/shape fails closed
- model attempt to include publish/OAuth/token/scheduler/account controls rejected
- chat-only response creates no proposal
- proposal response cannot persist by itself
- current-settings explanation path has no mutation
- past-post intent creates no X API call
- provider timeout/error is safe/retryable
- model call count bounded

### Domain/client
- multi-turn assistant history sent in bounded form
- normal chat displays reply without proposal card
- follow-up question displays naturally
- proposal displays only changed fields
- explicit confirmation persists
- unconfirmed proposal persists nothing
- correction in later turn supersedes/replaces prior pending proposal safely
- unrelated settings remain unchanged when applying a delta
- existing persona not erased by settings-only confirmation
- settings changed after proposal cannot be silently clobbered
- general chat never toggles posting/scheduling/X connection
- history-learning request stays consent-gated / no fetch.

Run:
- new focused tests
- full social-mobile tests
- relevant Edge Function/shared tests
- typecheck / lint / runtime check per repo conventions
- `git diff --check`
- secret scan
- scope diff check.

No live paid AI call is required in automated tests; mock/stub the model boundary.

## Local verification

Use G3-owned environment only.

Verify with local/mock AI responses or a safe dev invocation:
1. greeting / casual conversation returns a natural answer
2. 「どんな投稿にしたらいい？」 produces a useful follow-up question
3. 「親しみやすく、AIの話を多めにしたい」 produces a reviewable proposal
4. before confirmation, saved settings unchanged
5. after explicit confirmation, local/test storage shows only intended changes
6. 「今どういう設定？」 explains saved understanding
7. 「過去投稿を読んで」 does not call X and remains consent-gated
8. no posting/schedule/X connection side effect.

Do not use real X posting or destructive production flows.

## DB / migration rule

**No new migration in this task.**
Use the existing `social_mobile_content_settings` settings/persona storage.

If the required production schema columns are absent or incompatible:
- STOP
- report exact evidence
- do not create a migration
- do not borrow/modify PR #70 common-account migration.

## Explicit non-scope

- actual past-X-post retrieval/analysis
- AI-generated post creation
- editing/regeneration/approval of a generated post
- automatic posting
- scheduled posting
- X API read/write
- x-connect/OAuth behavior
- login provider changes
- account deletion
- common-account/service-entitlement implementation
- new DB migration/schema
- major UI redesign
- production deploy
- feature flag rollout.

## Production / safety

This is **source + tests + PR only**.

Forbidden:
- production Edge Function deploy
- production DB mutation
- migration apply
- real X API operation
- real X post
- Vault mutation
- Auth mutation
- provider configuration mutation.

## Completion / K3

Report:
- task_id
- result
- architecture / endpoint chosen
- existing foundations reused
- exact AI request/response trust boundary
- authorization checks
- chat modes implemented
- confirmation/persistence semantics
- changed_files
- tests
- local verification
- AI/provider/model usage policy
- DB migration = none
- production mutation = 0
- real X operations = 0
- remaining issues
- safety_checks
- commit_hash / push / PR
- next_recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

### Expected next stage

Because this task introduces an authenticated AI Edge Function/API boundary, K3 should normally allocate a focused Codex review before merge.

Likely review:
- H2 if free
- recommended Codex model: **Sol（高）**
- focus: Auth/membership boundary, prompt/structured-output injection, no implicit persistence, cost bounds, no publish/X side effects.

Only after source review/merge should G4 be assigned the real **past-post learning** integration.


## Report — x-social-mobile-ai-consult-v1-20261002

- task_id: x-social-mobile-ai-consult-v1-20261002
- result: **PASS (source + tests + PR; K3 / Codex review requested before merge)**. Model: Opus 5.5 (switched by the user before start).
- PR: https://github.com/anohi-memories/kabumori/pull/78 — branch `claude/g3-ai-consult-v1-20261002`, commit `6e9f78a3` (rebased on origin/main `0c2c04e0`), pushed.

### Architecture / endpoint chosen
- New dedicated Edge Function `supabase/functions/social-mobile-consult` (`index.ts` + pure `logic.ts`). Read-only: it has no write path, no service-role client, no token/Vault adapter, no X adapter.
- Client: `domain/consult-session.ts` (pure), `data/consult-client.ts` (functions.invoke), rewritten `app/(tabs)/consult.tsx`, versioned save in `data/content-settings-repository.ts`.
- One deliberate tightening vs. the TASK text: saved settings/persona are **read server-side with the caller's JWT** instead of being sent by the client, so the request is only `brand_id` + `message` + bounded `history`. The assistant gets the same inputs; the client cannot inject "saved" state.

### Existing foundations reused
- Auth/ownership pattern of `social-mobile-brand-dry-run` (`/auth/v1/user` + RLS-scoped REST reads with the user JWT + `social_mobile_user_v1` profile check).
- `_shared/brand/social_mobile_content_settings.ts` (`normalizeSocialMobileContentSettings`, `materializeSocialMobilePersonaProfile`).
- OpenAI Responses API pattern and default model tier of `brand_post_generator.ts` (`gpt-5.6-luna`, `store:false`, low reasoning) and the strict `json_schema` output pattern already used in `market-intelligence-ingest`. Same `OPENAI_API_KEY` secret; no new vendor or secret.
- `validateConversationalAssistantResult()` kept as the client trust boundary (strengthened), `applyConfirmedConversationProposal()`, existing `social_mobile_content_settings` storage, existing history-learning consent gate. `createConversationalAssistantProposal()` is kept only for the sample-data preview and tests.

### Exact AI request / response trust boundary
- Request to the model: system prompt + a data block of saved editable settings (+ read-only approval mode / generation time for explanation) and the **confirmed** persona only + bounded turns + the message. Never tokens, Vault ids, account/auth data, other workspaces.
- Model output = untrusted. `sanitizeConsultModelOutput()` (server): exact top-level key set; allowlisted settings keys (preferredTone, themes, objective, frequencyTargetPerWeek, optionalNgWords, notes) and persona keys; types and lengths bounded; any key matching publish/account/oauth/token/secret/schedul/cron/approval/generationWindow/locale/password/session/delete/vault refused anywhere; `chat`/`question` can never carry a delta; a delta equal to the saved value is dropped; anything else -> `CONSULT_AI_MALFORMED` (502, retryable), nothing saved.
- The client re-validates the envelope and result (`parseConsultResponse` -> `validateConversationalAssistantResult`), independently allowlisted; an envelope claiming a save/publish/X call is rejected.
- Result always has `requiresConfirmation: true`, `publishPermissionChanged: false`; envelope pins `settings_saved/persona_saved/publish_attempted/scheduled_post_created/x_api_called: false`.

### Authorization checks
1. Bearer required -> Auth server verifies the user (identity checked before body parsing).
2. `brand_memberships` read with the user's JWT, filtered by the **verified** user id + requested brand + role owner; row must match all three.
3. `brands` row must exist for that id and be `social_mobile_user_v1`.
4. Any missing/malformed/mismatched row -> 404/409, no settings read, no model call. No PR #70 / common-account semantics used. No service role anywhere.
5. Logs are metadata only (request id, result class, counts/lengths, duration, model, token usage); message/history/reply text, Authorization, user id, brand id, email and keys are never logged or returned (tested).

### Chat modes implemented
chat (casual talk, general questions, brainstorming, explaining current settings — no proposal), question (1 question, at most 2), proposal (delta only, on a clear preference; hesitant statements are handled conversationally by prompt rule). No web/live info (the assistant says so). Requests to change posting/schedule/X connection/login/deletion are answered as chat with a pointer to the app screen.

### Confirmation / persistence semantics
- An arriving answer only updates on-screen session state. The only write path is 「これで覚えて」 -> re-read latest -> `planConfirmedSave` -> `saveConfirmedIfUnchanged`.
- Delta applied onto the freshly read state: unrelated fields (including newer ones) are preserved.
- If a field the proposal touches changed since the proposal was shown -> no write, user is asked to confirm again against the current state.
- Save is a compare-and-swap on `updated_at` (insert when no row; a concurrent change/insert -> `stale`, nothing written).
- Settings-only confirmation does not touch persona columns or relabel persona provenance; a persona delta is merged and saved as confirmed/conversation.
- A newer proposal replaces the pending one; a plain answer leaves it; the user can dismiss it. Chat continues after a save.
- Raw conversation lives in screen state only; no transcript table, no analytics.

### Past-post learning handoff
`historyLearningIntent` preserved (model flag OR deterministic match on the user's own words). It only opens the existing consent gate; no X call, no persona derived, `derivedProfile` always null. G4 can attach the verified-account fetch behind that gate without changing the chat contract.

### changed_files
- supabase/functions/social-mobile-consult/{index.ts,logic.ts,logic_test.ts} (new)
- apps/social-mobile/src/domain/consult-session.ts (new), src/data/consult-client.ts (new)
- apps/social-mobile/src/app/(tabs)/consult.tsx, src/data/content-settings-repository.ts, src/domain/content-settings-conversation.ts, src/domain/content-settings.ts
- apps/social-mobile/tests/{consult.test.mjs,consult-screen.test.mjs} (new)

### Pre-existing defect found and fixed (it blocked every save)
The app validator rejected the saved default `generationWindow.endLocal = "24:00"` (DB constraint and server accept it), so `validateSocialMobileContentSettings(DEFAULTS)` was false and any settings save/read with the default window failed. Only the end time now accepts `24:00`; regression test added. Not a schema change.

### tests
- Server (`logic_test.ts`, 26): unauthenticated rejected; non-member / wrong role / wrong user rejected; valid owner accepted; bounded message/history; oversized/malformed/unknown-key input rejected; secret never returned/logged; safe response parses; malformed JSON/shape fails closed; publish/OAuth/token/scheduler/account/approval smuggling rejected; chat-only creates no proposal; proposal does not persist (handler performs only GETs); current-settings explanation has no mutation; past-post intent makes no X call; provider error/timeout safe + retryable; model call count = 1.
- App domain (`consult.test.mjs`, 29) and real screen code driven with stubbed React + scripted AI + in-memory versioned store (`consult-screen.test.mjs`, 11): bounded multi-turn history; chat shows no proposal card; follow-up question; proposal shows only changed fields; confirmation persists; unconfirmed persists nothing; later correction replaces pending proposal; unrelated settings unchanged; persona not erased by settings-only confirmation; changed settings not clobbered (reconfirm + CAS); general chat never toggles posting/scheduling/X; history request stays consent-gated; retry; preview mode makes no call and no write.
- End-to-end contract test: client -> real Edge handler (model stubbed) -> client validator -> save plan.
- Mutation checks (10): removing the membership check, the chat-delta rule, the settings allowlist, the request-key allowlist, the CAS filter, the stale-conflict rule, the client allowlist, or leaking the message into the log each makes a test fail. The deep forbidden-key scan is redundant with the allowlists (defence in depth; noted in code).
- Runs: `npm test` 153/153; typecheck 0; lint 0; `deno test` social-mobile-consult + dry-run + history-learning + `_shared/brand` 196/196; `deno check`, `deno lint` clean; `git diff --check` clean; secret scan and scope diff clean (no migration, x-connect, auth-provider, account-deletion, env, Vault, config path).
- No live paid AI call was made.

### Local verification (G3-owned, mock AI responses)
1 greeting/casual -> natural reply, no proposal. 2 「どんな投稿にしたらいい？」 -> follow-up question. 3 「親しみやすく、AIの話を多めにしたい」 -> reviewable proposal (tone + themes only). 4 before confirmation the store is byte-identical, zero writes. 5 after 「これで覚えて」 the store shows only the intended changes. 6 「今どういう設定？」 -> explanation, no proposal. 7 「過去投稿を読んで」 -> consent gate only, no X call. 8 no posting/schedule/X-connection side effect (handler issues only GETs + one provider request). All executed through the real screen code and the real handler with stubs.

### AI / provider / model usage policy
OpenAI Responses API, `gpt-5.6-luna` (existing default tier), structured output, `max_output_tokens` 900, 25 s timeout, 1 call per send, no retry/tools/web search, `store:false`. Input caps: message 1000 chars, 12 turns x 1000 chars, 6000 chars total, 32 KB body.

### DB migration = none. production mutation = 0. real X operations = 0. No deploy, no secret/config change.

### remaining issues
1. Live model behaviour (prompt quality, how reliably it distinguishes chat / question / proposal and hesitant statements) is **not verified**; it needs a dev invocation after deploy. Contract safety does not depend on it.
2. No native (Simulator) visual check of the new screen in this task; behaviour is verified through the real screen code in tests. UI is functional-only by design.
3. No per-user rate limit / usage accounting (no existing helper for social-mobile); only per-request caps. Recommend a quota before public rollout.
4. The endpoint is not deployed; the app shows a retryable error until it is. Deploy with `verify_jwt` on (the function also verifies the user itself). Remember the worktree-root deploy caveat (byte-verify).
5. Client-supplied `history` can contain forged assistant turns; they only influence the caller's own conversation and the output is still allowlisted. Worth a reviewer's look.
6. A persona edited through conversation sets provenance to `conversation` even when it was derived from past posts (existing `source: result.provenance` rule kept; analysed count/date are preserved).
7. Whether the production `social_mobile_content_settings` table exists was not checked (production reads are not available to this slot); the endpoint falls back to defaults if the table is absent, and the app already reports the table as unavailable.

### safety_checks
Own worktree/branch only; explicit-path staging; untracked `supabase/.temp`, `supabase/config.toml` left untouched; no other slot's files, simulator or Metro used; no secrets, tokens or personal emails in code, tests or this report.

### next_recommendation
- K3 -> focused Codex review (H2, Sol（高）) on: Auth/membership boundary, prompt / structured-output injection, no implicit persistence, cost bounds, no publish/X side effects.
- After merge: controlled deploy + one dev conversation to tune the prompt; then G4 past-post learning behind the existing consent gate; add a per-user quota.

---

# Claude Task 3 — CURRENT TASK

- task_id: x-ai-lab-dev-diary-kabumori-hero-8state-sync-20261002
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: low
- recommended_model: Sonnet5（中）
- type: AI Lab public-safe development diary context sync
- production_mutation_allowed: false

## Purpose

Final K1で完了した「かぶモリ Home Report Hero 8-state integration」を、会社員AIラボの公開安全な開発日記題材へ同期する。

これはX投稿生成ロジックの改修ではない。
共有メモ正本と、そのcommit済みruntime snapshotの同期だけを行う。

## Source fact

実際に完了・merge確認済みの事実:
- かぶモリHomeのレポートHeroで、レポート内容に応じて8種類のキャラクター表情を切り替えるUIを実装した。
- 追加AI呼び出しなしで、保存済みレポートの情報から表示状態を決める。
- 画面幅や「今日のポイント」1〜3件の差でも崩れないよう調整した。
- iOS Simulatorで複数幅を確認した。
- EAS build / production backend mutationは行っていない。

公開文にはPR番号、task_id、branch、commit SHA、内部テーブル/関数名、秘密情報を入れない。

## Required changes

1. `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`
   - 2026-10-02に既存entryがあるため、**同日entryを増やさない**。
   - 既存2026-10-02 entryはX自動投稿アプリの不具合修正について書かれているので、その内容を壊さない。
   - 1日1entry原則を守るため、今回のKabumori Hero内容を同entryへ無理に混ぜない。
   - 代わりに **2026-10-03 entryとして先取りして書かないこと**。
   - 結論として、正本Markdownへ新しい日付entryを追加できないため、今回のK1内容は**保留メモとしてTASK Reportへ記録するだけ**にする。日付が変わって実際の10/03作業が発生した場合のみ別TASKで追加する。

2. このTASKでは runtime snapshot / generator / tests を変更しない。

## Important

「K1で公開安全な題材候補がある」こと自体は記録するが、存在しない日付の開発日記を捏造しない。
同日1entryルールを破らない。
既存2026-10-02 entryを書き換えて異なる2つの開発内容を混在させない。

## Tests

- source diffが `.agent/**` のみであること
- `git diff --check`

## Completion

Reportに以下を記録:
- task_id
- result
- diary update performed: no
- reason: existing 2026-10-02 entry + one-entry-per-day rule
- preserved public-safe candidate text for future manual/next-day use
- production mutation: 0
- changed_files
- next_recommendation

その後:
- status -> done
- next_owner -> none
- STOP.

Recommended model: **Sonnet5（中）**.

## Report — K1 diary decision

- task_id: `x-ai-lab-dev-diary-kabumori-hero-8state-sync-20261002`
- result: **NO SOURCE UPDATE REQUIRED / DONE**.
- diary update performed: no.
- reason: canonical diary already has a real 2026-10-02 entry, and the documented rule is one entry per day. The K1-completed Kabumori Hero work is a valid public-safe candidate, but creating a duplicate same-day entry or pre-dating 2026-10-03 would break the diary contract.
- preserved candidate: 「株アプリのホームで、その日のレポート内容に合わせて8種類のキャラクター表情を切り替え、画面サイズやポイント数が変わっても崩れないよう調整した。」
- production mutation: 0.
- changed_files: `.agent/tasks/CLAUDE_TASK_3.md` only.
- next_recommendation: do not consume a Claude slot; reuse the candidate only if a later real diary-update task needs a backlog of public-safe development topics.
- next_owner: none.

---

## Archived previous G3 task

# Claude Task 3

- task_id: x-social-mobile-native-link-navigation-cleanup-20261001
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: medium
- recommended_model: Sonnet5（高）
- continues_from: x-social-mobile-account-deletion-ui-release-finish-20261001
- purpose: PR #68 / PR #65 後に残った social-mobile の native navigation UI 不具合を、Link-asChild の既知パターンに限定して修正・再発防止する。

## Confirmed current-main findings

Fresh main で以下を確認済み。

1. `apps/social-mobile/src/app/accounts/index.tsx`
   - 「ログイン方法」カードがまだ `<Link asChild><Pressable style={({ pressed }) => ...}>`。
   - PR #68 で確定した同じ root cause により、native で card styling が落ちる既知パターン。
   - G4 PR #65 は Final K4 PASS で merge 済みのため、現在はG4所有競合なし。

2. `apps/social-mobile/src/app/(tabs)/settings.tsx`
   - 「会話で相談する」が `<Link asChild><Card>...`。
   - `Card` は navigation press handler を受け取らないため、native確認で dead tap になっている。

3. PR #68 の `native-link-button-style.test.mjs` には `accounts/index.tsx` の known allowlist が残っている。今回の修正後はこの例外を除去する。

## Mandatory startup

1. Read `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G3 worktree/checkout.
3. Fresh `origin/main`.
4. Confirm G4 task is done and PR #65 is merged; do not reopen OAuth/auth-session work.
5. Confirm H1/G5 common-account work does not overlap the UI files below.
6. Do not reuse another slot's untracked files, .env, Simulator process, Metro process, branch, or worktree.

## Primary required fixes

### A. Accounts screen — 「ログイン方法」card

Fix the remaining native styling defect in:
- `apps/social-mobile/src/app/accounts/index.tsx`

Requirements:
- the whole intended card/tap target remains visibly styled on native iOS.
- tap navigates to `/login-methods`.
- preserve accessibility role / readable label.
- do not change X-connect hook, connect/reconnect behavior, OAuth, PKCE, callback, or account data.
- remove `accounts/index.tsx` from the known-unfixed allowlist once fixed.

Prefer the already accepted safe pattern:
- standalone `Pressable` + `router.push`
rather than `Link asChild` around a function-styled Pressable.

### B. Settings — 「会話で相談する」

Fix:
- `apps/social-mobile/src/app/(tabs)/settings.tsx`

Requirements:
- the card is visibly tappable.
- tap navigates to `/(tabs)/consult`.
- preserve the existing copy and overall layout.
- no content-settings persistence logic change.

Prefer explicit navigation with an interactive element rather than relying on `Link asChild` to inject press behavior into a component that does not forward it.

## Narrow same-pattern audit

Audit only `apps/social-mobile/src/app/**` and `apps/social-mobile/src/components/**` for these two specific invalid compositions:

1. `Link asChild` + direct child with function-valued `style` that can be lost by Slot style merging.
2. `Link asChild` + direct child such as `Card` / `View` that does not actually forward the injected press handler/ref and is therefore dead/non-interactive.

For every match:
- classify as broken / safe / false positive with concrete source reason.
- fix only demonstrably broken navigation in the same family.
- do not broaden into visual redesign or unrelated route cleanup.
- if a shared UI component change is proposed, make it only if it is strictly safer/smaller than fixing the call sites and regression coverage proves all consumers remain safe.

Potential rows mentioned by prior G3 report (history/schedule/account rows) are **audit candidates, not automatic edit targets**. Prove the issue before changing them.

## Tests

Update/extend `apps/social-mobile/tests/native-link-button-style.test.mjs` or a narrowly named companion test so that:

- `accounts/index.tsx` is no longer allowlisted.
- no `Link asChild` + function-valued direct-child style remains in app/components.
- the detector also catches the proven dead `Link asChild > Card/View` class where the child cannot receive/forward press behavior.
- detector self-tests prove the scanner actually fails on synthetic broken examples.
- the Accounts 「ログイン方法」 target is an interactive element with explicit navigation to `/login-methods`.
- Settings 「会話で相談する」 is interactive and explicitly navigates to `/(tabs)/consult`.
- any additional call-site fix gets a focused route/navigation regression.

Run:
- social-mobile full tests
- typecheck
- lint
- `git diff --check`
- focused static/navigation tests
- secret/scope diff check

## Native verification

Use a G3-owned local iOS Simulator environment only.

Verify at minimum:
1. Accounts → 「ログイン方法」 card has expected visible card styling and opens Login methods.
2. Settings → 「会話で相談する」 visibly responds to tap and opens Consult.
3. If any additional same-pattern call site was changed, visually/tap-verify that route too.
4. No production data mutation is needed; sample/mock data preferred.
5. No EAS build unless local verification is genuinely impossible.

Temporary local auth/sample-data harness is allowed only if:
- isolated to G3,
- untracked/uncommitted,
- reverted/removed after verification,
- does not connect to protected production data.

## Explicit non-scope

Do NOT change:
- `apps/social-mobile/src/features/x-connect/**`
- OAuth / PKCE / callback / provider behavior
- Supabase Auth/provider flows
- account deletion backend/state machine
- common-account/service-entitlement work
- DB / RLS / RPC / migrations
- Edge Functions
- Vault/token storage
- scheduler/posting
- production feature flags
- App Store/TestFlight/EAS release configuration

## Production / safety

- source + tests + PR only
- production mutation = 0
- real X operations = 0
- no deploy
- no account deletion
- no provider login/revoke/post
- do not expose secrets or personal credentials

## Completion / K3

Report:
- task_id
- result
- exact broken Link-asChild patterns found
- exact files fixed
- audit matrix (broken / safe / false positive)
- changed_files
- tests
- native simulator result
- proof x-connect/Auth/deletion/common-account/backend scopes unchanged
- commit_hash
- push
- PR
- production mutation = 0
- real X operations = 0
- remaining issues
- safety_checks
- next_recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Expected review policy:
- if changes stay UI/navigation-only and native verification passes, additional Codex review is normally unnecessary.
- if implementation touches shared interactive primitives broadly, Auth/OAuth, or any backend boundary, STOP and let ChatGPT decide review before merge.


## Report — x-social-mobile-native-link-navigation-cleanup-20261001

- task_id: x-social-mobile-native-link-navigation-cleanup-20261001
- result: **PASS** (source + tests + native before/after verification; PR open). Model: Sonnet 5.5.
- PR: https://github.com/anohi-memories/kabumori/pull/73 (branch `claude/g3-native-link-cleanup-20261001`)
- commit_hash: 645923ba (rebased on origin/main 0c27998b); push: done, branch pushed to origin.

### Exact broken Link-asChild patterns found (all proven dead/broken on native BEFORE the fix)
1. `Link asChild` + `Card`/`View` direct child: Link only injects its press handler into the direct child; `Card`/`View` do not accept/forward `onPress` -> tap does nothing.
2. `Link asChild` + function-valued `style` on the direct child: radix Slot merges style as `{...slotStyle, ...childStyle}`, a function spreads to `{}` -> styling lost.

### Exact files fixed
- apps/social-mobile/src/app/(tabs)/history.tsx (row -> /posts/[id])
- apps/social-mobile/src/app/(tabs)/schedule.tsx (row -> /posts/[id])
- apps/social-mobile/src/app/(tabs)/settings.tsx (「会話で相談する」 -> /(tabs)/consult)
- apps/social-mobile/src/app/accounts/index.tsx (account row -> /accounts/[id]; 「ログイン方法」 card -> /login-methods keeps styles.card)
All now use a standalone `Pressable` + `router.push` (accessibilityRole="button"), copy/layout unchanged.

### Audit matrix (src/app/** and src/components/**; every Link asChild)
| site | direct child | verdict |
|---|---|---|
| (tabs)/index.tsx x5 (切り替える/予定/履歴/設定/相談) | ActionButton | safe (forwards onPress to Pressable; Home→アカウント verified on native) |
| posts/[id].tsx 再接続 | ActionButton | safe (same class) |
| (tabs)/history.tsx, (tabs)/schedule.tsx | Card | broken -> fixed (dead tap proven native) |
| (tabs)/settings.tsx 会話で相談する | Card | broken -> fixed (dead tap proven native) |
| accounts/index.tsx account row | View | broken -> fixed (dead tap proven native) |
| accounts/index.tsx ログイン方法 | Pressable + function style | broken -> fixed (flat unstyled block proven native) |
| login-methods.tsx, settings.tsx アカウント管理 | (fixed in PR #68) | safe |
False positives: none.

### changed_files
- apps/social-mobile/src/app/(tabs)/history.tsx, (tabs)/schedule.tsx, (tabs)/settings.tsx, accounts/index.tsx
- apps/social-mobile/tests/native-link-button-style.test.mjs

### tests (clean env, no local .env.local)
- `npm test` 113/113, typecheck exit 0, lint exit 0, `git diff --check` clean.
- test file: allowlist for accounts/index.tsx removed; both broken classes detected app-wide (allowlist of press-forwarding components: Pressable/ActionButton/Text/Touchable*); detector self-tests fail on synthetic broken (Card, View, function-style Pressable) and pass on good examples; per-route navigation checks (/login-methods, /accounts/[id], /(tabs)/consult, /posts/[id]); new tests failed (6) against the unfixed code, pass after the fix.
- scope diff check: no x-connect/Auth/DB/RLS/RPC/migrations/Edge/Vault/flag path in the diff; no secret-like string added.

### Native simulator result (G3-owned device, iOS Simulator Release, sample data)
- Own simulator "G3-nav-cleanup" created and used only (another slot's devices were not touched; one stray tap on another booted device's empty home-screen area happened before I pinned the device, no effect).
- BEFORE: 履歴行, 投稿予定行, 会話で相談する, アカウント行 = no response after 8s; ログイン方法 = flat unstyled block.
- AFTER: 履歴行 -> 投稿詳細 (8:20), 投稿予定行 -> 投稿詳細 (11:44), 会話で相談する -> AI相談 tab, アカウント行 -> アカウント詳細 (@kabumori), ログイン方法 card visibly styled and -> ログイン方法 screen. Home ActionButton path also works.
- Local-only harness (sample-data .env.local, temporary auth-gate bypass in _layout.tsx, throwaway bundle id, generated ios/) used and removed; simulator deleted; nothing of it committed; package.json/.gitignore unchanged.

### proof x-connect / Auth / deletion / common-account / backend unchanged
- diff touches only the 4 screens + 1 test; `git diff --name-only` has no match for x-connect, supabase, migrations, env, auth-provider, account-deletion.

### production mutation = 0, real X operations = 0
No deploy, no flag change, no deletion, no provider login/revoke/post; sample-data build had no Supabase config.

### remaining issues
1. `/accounts/[id]` (アカウント詳細) shows no top header/back button. It was unreachable before (dead row); now reachable. Edge-swipe back works. Header config is route cleanup (out of scope) — decide separately.
2. Any future `Link asChild` around a new non-forwarding component is now caught by the test; shared primitives were not changed.
3. Unchanged release gates: common-account deletion semantics, Apple production config, legal URLs/texts, audit retention, main-app account-delete coordination; deletion flag stays OFF.

### safety_checks
- own worktree + own simulator only; explicit-path staging; no secrets/tokens/emails in report; G4/G5/H1 files untouched.

### next_recommendation
- Review/merge PR #73 (UI/navigation only; additional Codex review normally unnecessary per TASK).
- Separate small task: give `/accounts/[id]` a visible header/back button (or confirm it is intended).

---

# Claude Task 3

- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- continues_from: x-social-mobile-e3-delete-revoke-residue-20261001
- purpose: E3で機能動作がPASSしたX自動投稿アプリのアカウント削除について、残っているnative iOS UIブロッカーを解消し、共通アカウント設計に踏み込まずに現行削除UIをリリース可能な見た目・導線まで仕上げる。

## Context

Previous G3 E3 reached Final K3 PASS:
- disposable X authorization revoke succeeded
- social-mobile workspace/membership/social account/X credential/OAuth transient data were removed
- unexpected residue = 0
- protected production posting accounts unchanged
- shared Supabase Auth/login/main-app profile intentionally remained under current `social_only` behavior
- real X posts = 0

Remaining UI findings from the native iOS Release verification:
1. On `login-methods`, the buttons for 「投稿用のX接続を確認する」 and 「アカウントの削除について」 can render as blank/invisible text while their tap area still works.
2. Account deletion is too deep to discover; Settings has no direct account-management/deletion entry.

A separate common-account/auth design effort is now defining the future company-wide account/service-entitlement model. This G3 task MUST NOT preempt or redesign that model.

## Mandatory startup

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, and this TASK.
2. Fresh-check `origin/main`.
3. Use an independent G3 worktree/checkout. Do not use G4/H1/H2 worktrees or simulator processes.
4. Confirm G4 PR #65 owns X account-switch auth-session work and currently touches X-connect/account-selection paths. Do not edit G4-owned files.
5. Confirm H2 PR #66 review and H1 PR #67 review do not overlap the files you intend to change.
6. Preserve all previous G3 E3 reports below; do not rewrite historical results.

## Allowed primary scope

Prefer the smallest set necessary:
- `apps/social-mobile/src/app/login-methods.tsx`
- `apps/social-mobile/src/app/(tabs)/settings.tsx`
- `apps/social-mobile/src/app/account-deletion.tsx` only if needed for UI consistency
- narrowly related social-mobile UI tests
- shared UI component only if the root cause is proven there and the change is demonstrably safe for all consumers

Do NOT edit:
- `apps/social-mobile/src/features/x-connect/**`
- G4-owned account-switch files
- Supabase Auth/provider flows
- account-deletion backend/state machine
- DB/RLS/RPC/migrations
- Vault/token storage
- OAuth ownership
- service-entitlement/common-account design
- production feature flags
- scheduler/posting paths

## Required work

### 1. Root-cause the invisible native buttons

Reproduce or inspect the iOS Release/native rendering path for:
- 「投稿用のX接続を確認する」
- 「アカウントの削除について」

Determine why the text is invisible while the Pressable remains tappable.

Do not merely change color blindly. Confirm whether the problem is caused by:
- `Link asChild` + `Pressable`
- inherited/native text/style behavior
- shared `styles.buttonText`
- Release-only rendering
- another concrete cause

Fix the actual source cause with the narrowest safe change.

### 2. Make account management discoverable from Settings

Add a clear, ordinary Settings entry for account/login management.

Preferred UX:
- a distinct account section/card in Settings
- direct route to `/login-methods`
- wording should make it obvious that login methods, X connection, and account/service deletion live there

If a direct deletion shortcut is clearly safer/usably better, it may be added, but do not bypass the existing preview/re-auth/confirmation deletion screen.

Do not move destructive logic into Settings.

### 3. Preserve deletion truthfulness

Current deletion UI must continue to:
- preview what the server says will be deleted/kept
- require fresh reauthentication
- require the typed confirmation
- report server-confirmed outcome only
- keep the current feature-gate behavior

Do not alter `social_only` / `social_and_login` semantics in this task. Those semantics will be reconsidered by the common-account project.

### 4. Feature flag

Do NOT globally enable `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` in this task.

Goal is source/UI readiness only.

After the common-account design decides the final deletion semantics, activation can be a separate controlled release step.

## Tests / verification

At minimum:
- relevant social-mobile tests
- new/updated UI/static tests proving the two button labels remain visibly rendered in native-compatible composition
- Settings contains a discoverable account-management route
- existing account-deletion preview/reauth/typed-confirmation behavior unchanged
- no G4 X-connect source change
- no Auth/DB/RLS/RPC/Vault/OAuth backend diff
- typecheck
- lint
- `git diff --check`

Native verification:
- use local iOS Simulator / Release-like build where practical
- visually confirm both affected button labels are visible
- confirm both routes are tappable and land on the correct screens
- confirm the Settings account entry is visible without requiring knowledge of hidden navigation
- no EAS build unless truly required; explain if unavoidable

## Production / safety

- source + tests + PR only
- no production deploy
- no feature-flag enable
- no destructive account deletion in this task
- no real X login/revoke/post
- production mutation = 0
- do not remove the retained disposable Auth/profile from the E3 test; that now belongs to the common-account/account-lifecycle decision

## Completion conditions

- invisible button root cause identified
- source fix implemented
- both labels visible in native verification
- Settings account-management entry added and verified
- deletion semantics/backend unchanged
- tests/typecheck/lint/diff checks pass
- commit + push + PR
- production mutation 0
- real X operations 0

## Report

Include:
- task_id
- result
- root cause of invisible buttons
- UX change
- changed_files
- tests
- native/simulator verification
- proof deletion backend/semantics unchanged
- proof no G4 overlap
- commit_hash
- push
- PR
- production mutation
- real X operations
- remaining issues
- safety_checks
- next_recommendation

Then status -> review_required, next_owner -> chatgpt and STOP for K3.

---

## Previous completed G3 history — preserved below

# Claude Task 3

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- continues_from: x-social-mobile-pr63-merge-native-e3-resume-20260930
- purpose: E3の使い捨てユーザー/X接続が正常に成立した状態から、アカウント削除E2Eを最後まで検証する。削除によるX認可失効、Vault/DB/Auth等の残存データ、既存本番アカウントへの非影響を確認する。

## Confirmed starting point

Operator report:
- local iPhone Simulator build is connected to real production data.
- a genuinely disposable X account `@tigers_torataro` is now connected successfully to the disposable social-mobile user.
- protected production posting accounts were not touched.
- account deletion and X authorization revoke have NOT been executed yet.
- a temporary local-only browser-session workaround was used to choose the correct X account; it was not committed.

The previous K3 blocker (wrong X account already connected in production) is therefore resolved.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, and the previous G3 report history.
2. Use the existing independent G3 worktree/checkout only. Do not use G4's worktree.
3. Fresh-check `origin/main`, but do NOT pull unrelated G4 source changes into the already verified E3 session unless rebuilding becomes unavoidable.
4. Do not make source changes in this task unless a blocking defect is found. This task is operational E2E verification.
5. Confirm the disposable connected X identity is exactly `@tigers_torataro`.
6. Confirm protected production posting accounts remain unchanged and are excluded from every destructive selector.
7. Do not reveal token plaintext, secret values, Vault plaintext, or personal email addresses in logs/report.

## Phase 1 — read-only preflight before deletion

Capture a read-only baseline sufficient to prove isolation:
- disposable Auth/user/profile/workspace/membership state
- disposable social account state and platform identity
- disposable token-reference / Vault-reference existence only (never plaintext)
- OAuth state / pending rows relevant to the disposable flow
- deletion/audit/tombstone baseline if present
- protected production X account state/count/hash or equivalent invariant
- Vault count/identifier hash or equivalent protected-account invariant
- feature flags relevant to deletion remain unchanged; do not globally enable deletion

Confirm again:
- no real X post
- no scheduler/manual publish
- no provider-console mutation
- no protected production account mutation

## MANDATORY STOP — fresh destructive approval

After Phase 1 is complete and BEFORE the first destructive action, STOP and report:

- disposable identity confirmed: `@tigers_torataro`
- read-only baseline captured
- protected production accounts unchanged
- exact first destructive operation: execute the existing account-deletion flow for this disposable social-mobile user
- expected effects: delete the disposable account/workspace data, revoke only this disposable X authorization as designed, remove only this disposable credential material
- feature remains OFF globally

Then request **fresh explicit user approval in the conversation**.

The user's current request to create this TASK is NOT the destructive approval.
Do not reuse any older approval.

## Phase 2 — after fresh approval only: execute deletion

Only after explicit approval:
1. Use the existing app/account-deletion E2E path for the disposable user.
2. If a local-only flag/config is required to expose the deletion path, keep it local/uncommitted and do not globally enable production deletion.
3. Perform the deletion once. Do not retry blindly if the result is ambiguous.
4. Do not manually revoke other X accounts or make provider-console changes.
5. If deletion fails before completion, STOP and preserve evidence; do not run separate cleanup mutations unless explicitly approved.

## Phase 3 — verify X revoke

After successful deletion:
- verify the deletion path attempted/completed revoke for the disposable X authorization according to the existing implementation.
- prefer server-side/audit/result evidence that does not require retaining token plaintext.
- if provider-side confirmation requires an interactive X "Connected apps" check, ask the user to perform only that read/confirmation for `@tigers_torataro`.
- never revoke the app globally and never touch the protected production X accounts.
- do not perform a real X post as a revocation test.
- if automatic revoke is not provable or failed, STOP; do not perform a separate manual revoke without new explicit approval.

## Phase 4 — residue / isolation verification

Read-only verify the disposable user's data is removed or intentionally retained exactly as designed. Check the relevant boundaries:
- Auth user/session
- profile/workspace/membership
- social account
- OAuth transient state
- token-reference/Vault credential
- content/settings/history rows owned only by the disposable workspace, where applicable
- deletion audit/tombstone records that are intentionally retained

Also prove protected production invariants are unchanged:
- existing production X accounts
- their credential references/Vault identifiers
- refresh state
- posting/scheduler state
- feature flags
- no real X post created

Classify every remaining row/value as:
- expected retained audit/tombstone
- unexpected residue
- unrelated protected production data

Do not "clean up" unexpected residue during verification. Report it first.

## Completion / K3

Report:
- task_id
- result
- destructive approval timestamp/message boundary
- deletion result
- X revoke proof/result
- residue matrix
- protected-account invariants before/after
- source changes (expected none)
- local-only temporary config used, if any
- tests/checks
- production mutations performed exactly
- real X posts = 0
- remaining issues
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Previous G3 task closure

Previous task `x-social-mobile-pr63-merge-native-e3-resume-20260930` reached Final K3 BLOCKED only because the first X identity was already connected to a protected production posting account. No destructive action occurred. Its report and Final K3 state remain in Git history / CURRENT_STATE and are not to be re-executed.

## Report — x-social-mobile-e3-delete-revoke-residue-20261001

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- result: **PASS** (E3 complete: deletion, X revoke, residue, protected invariants all verified). Two UI findings and one retained-by-design item are listed under remaining issues.
- model: Opus 5.5

### Destructive approval boundary
- Phase 1 (read-only baseline) finished, then STOP. Fresh explicit approval was requested in the conversation with the exact operation, expected effects and "feature stays OFF globally".
- User answered "承認する（自分で削除ボタンを押す）" at 2026-09-30T15:50:00Z (JST 10/1 00:50). No older approval was reused.
- The delete button was pressed once, by the user, in the local Simulator build. Claude pressed no destructive control.

### Deletion result
- App showed「削除しました — このアプリのデータを削除しました。ログイン用アカウントと「かぶモリ」のデータは残っています。」and returned to the login screen with the same notice banner (D2 fix confirmed on native).
- Scope: `social_only` (the disposable login also has a main-app profile), as predicted in Phase 1.
- Audit trail for the subject after the approval boundary (UTC): requested 15:57:07.42 → started 15:57:07.47 → x_revoked 15:57:07.91 → purged 15:57:07.95 → completed_social_only 15:57:08.05. No `failed` / `operator_required` / `blocked` row, no reason code. One attempt, no retry.

### X revoke proof
- Server-side: the flow stops with X_REVOKE_FAILED unless the X revoke endpoint returns success for both the refresh and the access token of exactly this account, and the `x_revoked` checkpoint is only written when the fingerprints of the revoked material match the credential set. The `x_revoked` audit row exists, followed by `purged`.
- Provider-side (user read-only check, logged in as `@tigers_torataro`): the app is no longer listed under X "connected apps". Nothing was pressed there.
- No global app revoke, no provider-console change, no real X post used as a test.

### Residue matrix (disposable subject, before → after)
| boundary | before | after | class |
|---|---|---|---|
| workspace | 1 | 0 | removed |
| membership | 1 | 0 | removed |
| social account (`tigers_torataro`, identity_verified, publish_enabled=false) | 1 | 0 | removed |
| token references in Vault (access + refresh) | 2 | 0 | removed |
| OAuth transient states (5 unconsumed) | 6 | 0 | removed |
| refresh state / scheduled posts / post logs / claims / windows / fingerprints of the workspace | 0 | 0 | none existed |
| deletion tombstone | 0 | 0 | none left (removed at finalize, as designed) |
| deletion audit rows (hashed subject only) | 10 | 15 | expected retained audit |
| Auth user / identity (email) / profile | 1 / 1 / 1 | 1 / 1 / 1 | expected retained (`social_only`: login belongs to the main app) |
| Auth sessions / refresh tokens | 3 / 4 | 3 / 4 | expected retained with the login (device sign-out is local) |
| handle present anywhere else | 0 | 0 | none |

Unexpected residue: **none**.

### Protected-account invariants (before = after, byte-equal hashes)
- protected social accounts: 3, row hash (ids, workspace, platform user, both token references, publish flag, status, updated_at) unchanged
- Vault rows referenced by protected accounts (id + updated_at hash) unchanged; all other Vault ids unchanged; Vault total 22 → 20 (= exactly the two disposable references)
- refresh state count/hash, refresh rollout, non-user workspaces hash, the other pre-existing user workspace: unchanged
- scheduled_posts 408, post_execution_logs 949 (latest timestamp unchanged, before the test), publish_claims 20, posting_windows 19, fingerprints 103: unchanged
- auth users 4, profiles 2: unchanged
- global totals changed only by the disposable rows: user workspaces 2→1, memberships 2→1, social accounts 4→3, OAuth states 28→22

### Other fields
- source changes: none committed. No PR.
- local-only temporary config (uncommitted, not in any product build): `.env.local` (real-data mode + deletion flag), `app.config.js` (throwaway bundle id), generated `ios/`, and a one-line ephemeral auth-session option in the X-connect hook used only to pick the right X account. The hook edit has been reverted in the worktree; the other files stay untracked until K3, then are removed.
- feature flag: the deletion entry is still gated by the client build flag, which is unset in every committed config. Nothing was enabled globally. No secret, Edge function, migration or provider setting was changed.
- tests/checks: operational verification only (read-only SQL before/after diff). No code changed, so no test run.
- production mutations performed exactly: (1) the user's X connect for the disposable account (new social account + 2 Vault references + OAuth states), done before this TASK; (2) one account-deletion call by the user, which revoked that X authorization and removed the rows above and wrote 5 audit rows. Nothing else.
- real X posts = 0. No scheduler/manual publish.

### Remaining issues
1. **Invisible buttons on the Login methods screen (native iOS, Release build).** 「アカウントの削除について」and「投稿用のX接続を確認する」render as blank space; the hidden area is still tappable and navigates. The deletion entry is effectively undiscoverable for a signed-in, onboarded user (the onboarding-gate entry from PR #59 is visible and fine). Release blocker for the deletion feature; needs a source fix + Simulator check. Not fixed here (operational task).
2. **Deletion entry is deep**: Home → アカウントを切り替える → ログイン方法 → bottom card. Not in the 設定 tab, where the user looked first. Consider a direct entry.
3. X auth session reuses the previous X login (already assigned to G4).
4. The disposable login itself remains in production (main-app profile exists → `social_only`). Removing it is a main-app (G1/G2) account-delete or operator action; not done.
5. Unchanged release gates: Apple production config, legal URLs/texts, audit retention policy, main-app account-delete coordination.

### Safety checks
- no token plaintext, Vault plaintext, secret value/id or personal email in logs or this report
- every destructive selector was the caller-bound deletion flow of the disposable user; no first-row fallback, no manual SQL mutation, no cleanup mutation
- protected production posting accounts untouched and proven unchanged
- dedicated G3 worktree only; G4 worktree and X-connect source untouched

### Next recommendation
- Final K3 for E3 = PASS candidate.
- Open a small source task for issue 1 (and decide issue 2) before the deletion flag can be enabled in any product build.
- Decide who removes the leftover disposable login (issue 4).


## Final K3 — E3 deletion/revoke/residue

- verdict: **PASS**
- accepted task: `x-social-mobile-e3-delete-revoke-residue-20261001`
- operational result: the disposable social-mobile service data was deleted once after fresh approval; its X authorization was revoked; no unexpected residue remained.
- accepted scope: `social_only`. The shared Supabase Auth user / login identity / main-app profile were intentionally retained.
- residue: workspace, membership, social account, disposable X credential references/material, and OAuth transient state removed as designed; deletion audit retained as designed.
- protected production posting accounts and their credential references/state remained unchanged.
- real X posts: 0. No scheduler/manual publish. No global deletion flag enable. No source commit or PR from this task.
- source changes: none. Local-only verification edits/config were not product changes; the X-connect temporary hook edit was reverted before report.
- remaining release blocker: native iOS Login methods screen has invisible/tappable-only buttons for the deletion and posting-X navigation. Deletion entry is also too deep. Keep deletion feature globally gated until UI/flow work is addressed.
- retained disposable login/profile is intentional under current `social_only` behavior and now becomes input to the new common-account/service-entitlement design rather than an E3 failure.
- Codex review: **not required for this K3** because no implementation source changed and the purpose of this task was operational E2E of already reviewed boundaries. Re-review at the next source change / production activation gate.
- AI Lab diary: 候補あり — 使い捨てアカウントで「このアプリだけ利用終了」の流れを最後まで試し、他のサービス用ログインを残したままX連携とアプリ専用データだけ消えることを確認した。
- next: common-account design should replace the current proxy-style service-existence decision with an explicit service entitlement. Separately fix the native deletion/navigation button visibility before enabling self-service deletion broadly.


## Report — x-social-mobile-account-deletion-ui-release-finish-20261001

- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- result: **PASS** (source + tests + native visual check done; PR open for review). Model: Sonnet 5.5 (recommended Sonnet5（高）, switched by user before start).
- PR: https://github.com/anohi-memories/kabumori/pull/68 (branch `claude/g3-deletion-ui-finish-20261001`, commit `ec292b5`)

### Root cause of the invisible buttons
- `<Link asChild>` renders expo-router's Slot, which uses radix `mergeProps`: `style = { ...slotStyle, ...childStyle }`.
- A `Pressable` whose `style` is a function (`({ pressed }) => [...]`) spreads to `{}` → the button's background, padding and border were dropped; the label (`color: #FFFFFF`) stayed → white text on a near-white screen. The Pressable and its tap area still existed, hence "invisible but tappable".
- Not Release-only and not `styles.buttonText`; it is the Link-asChild + function-style composition. Verified in `node_modules/@radix-ui/react-slot` (mergeProps) and `expo-router/build/ui/Slot.js` (only flattens the Slot's own style).

### UX change
- login-methods: the two buttons are standalone `Pressable` + `router.push('/accounts' | '/account-deletion')`, same style as before (primary / danger).
- Settings: new「アカウント管理」card at the top (above the long content form, visible without scrolling): ログイン方法の確認 / 投稿用のXアカウントの接続 / アカウントの削除 are explained, button「アカウントを管理する」→ `/login-methods`. No destructive logic in Settings.
- Deletion screen, reauth, typed confirmation, server-confirmed outcome, `social_only` / `social_and_login` semantics, feature gate: untouched. `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` not enabled anywhere.

### changed_files
- apps/social-mobile/src/app/login-methods.tsx
- apps/social-mobile/src/app/(tabs)/settings.tsx
- apps/social-mobile/tests/native-link-button-style.test.mjs (new)
- No change to x-connect, accounts/index.tsx, Auth, DB/RLS/RPC/migrations, Vault, OAuth, Edge functions, flags.

### tests / checks (clean env, no local .env.local)
- `npm test` 94/94 pass (5 new), `npm run typecheck` exit 0, `npm run lint` exit 0, `git diff --check` clean.
- New test: AST scan of src/app + src/components for `Link asChild` with a function-valued child style (one known file excepted, listed in the test), detector self-check, both labels live in standalone Pressables that navigate and keep button style, Settings entry opens `/login-methods` and sits above 「コンテンツ設定」.
- Note: with a local `.env.local` present (my earlier real-data E2E file) `auth-release-readiness` "operator script" fails because the script reads it; unrelated to this change, passes without the file.

### Native verification (iOS Simulator, Release build, sample-data mode, no production connection)
- Settings → 「アカウント管理」card + button visible at top without scrolling.
- Tap → ログイン方法 screen. 「投稿用のX接続を確認する」 (blue) and 「アカウントの削除について」 (red) both visibly render with white labels.
- Tap 削除 → アカウントの削除 screen (shows 準備中 because the flag is unset — gate behavior preserved). Tap X-confirm → アカウント screen. Both land correctly.
- Local-only harness used and removed: sample-data `.env.local`, a temporary auth-gate bypass in `_layout.tsx` (reverted, never committed), a throwaway bundle id. After the check: app uninstalled, `ios/`, `app.config.js`, `.env.local` and the env backup deleted. Untracked `supabase/.temp` and `supabase/config.toml` (CLI link files) remain untracked and unstaged.

### Findings (not fixed, out of this TASK's boundary)
1. `src/app/accounts/index.tsx`「ログイン方法」card has the same defect (Link asChild + function style → card styling lost; visible as a flat unstyled block). File is touched by G4 PR #65; fix there or after it merges, then drop it from the test's allowlist.
2. Settings existing「会話で相談する」 card is a dead tap (verified on native): `Link asChild` child is `Card`, which does not accept `onPress`. Needs a separate small fix (Pressable + router.push, or let Card forward touch props). Also applies to other `Link asChild > Card/View` uses (accounts/index.tsx account rows, history/schedule rows) — worth auditing together.
3. The same family of problem can silently return; the new test guards only Link-asChild-with-function-style, not non-forwarding children.

### Production / safety
- production mutation = 0, real X operations = 0, no deploy, no flag change, no destructive deletion, no secrets/tokens/emails in report.
- Disposable E3 login/profile left in production untouched (belongs to the common-account decision).
- G4 files and worktree untouched; own worktree only; explicit-path staging.

### Remaining / next recommendation
- Review and merge PR #68; then decide the fix for findings 1–2 (G4 / a follow-up).
- Release gates unchanged: common-account deletion semantics, Apple production config, legal URLs/texts, audit retention, main-app account-delete coordination; deletion flag stays OFF.


## Final K3 — account deletion UI release finish

- verdict: **PASS**.
- accepted PR #68 exact head: `ec292b50f8d9622a9c35dd1ce62a7d9ec1c1512b`.
- squash merged as `c1f4f42ab78430ee0c214759b4ddac280b7f2265`.
- root cause accepted: `Link asChild` + function-valued Pressable style lost the button container styling, leaving white text on a light background.
- fix accepted: standalone Pressable + router.push for the two affected buttons; Settings now has a visible account-management entry.
- native iOS Simulator Release verification passed for visibility and navigation.
- tests: 94/94, typecheck PASS, lint PASS, diff check PASS.
- no account-deletion backend/state-machine/scope/feature-flag/Auth/DB/RLS/RPC/Vault/OAuth change.
- G4 files untouched; PR #65 remains a separate account-switch workstream.
- production mutation: 0; real X operations: 0.
- extra Codex review: not required because this is a narrow UI/navigation fix with native verification and no security/backend boundary change.
- remaining non-blocking findings: accounts screen has a similar styling issue in a G4-owned file; Settings 「会話で相談する」 and similar Link-asChild non-forwarding children need a separate UI follow-up.
- app binary/TestFlight release was not performed by this task; merge makes the source ready for the next native build.
- G3 closed and reusable only after fresh allocation.


## Final K3 — native Link navigation cleanup

- verdict: **PASS**.
- accepted PR #73 exact head: `645923ba87c8667073061d13a2fc46bbb31ebcbe`.
- squash merged as `a81a60bb731e2c51aa907b4cc08234cb602c4f6a`.
- scope remained UI/navigation-only: history, schedule, Settings, Accounts and the focused navigation regression test.
- native Release-like Simulator verification confirmed all previously dead targets now navigate correctly and the Accounts 「ログイン方法」 card styling is restored.
- audit accepted: all broken `Link asChild > Card/View` and function-style direct-child cases in app/components were fixed; remaining ActionButton cases are safe because they forward onPress to Pressable.
- tests: social-mobile 113/113 PASS; typecheck PASS; lint PASS; git diff --check PASS.
- no x-connect/OAuth/Auth/account-deletion/common-account/DB/RLS/RPC/Edge/Vault/flag/scheduler change.
- production mutation: 0; real X operations: 0; deploy: none.
- extra Codex review: not required because the final delta is narrow UI/navigation-only, shared primitives were not changed, and native before/after verification passed.
- Netlify preview succeeded. Vercel status failure was only the known free-tier build-rate-limit and is not a candidate-quality failure for this native UI PR.
- remaining UI issue: `/accounts/[id]` is now reachable but lacks a visible top header/back button; edge-swipe works. Treat separately as route/navigation polish.
- no TestFlight/App Store/native production build was released by this task.
- G3 closed and reusable after fresh allocation.


## K3 decision — PR #78 AI consultation v1

- verdict: **PASS to focused Codex review; merge/deploy HOLD**.
- review target: PR #78 exact head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`.
- PR open/mergeable; fresh main +7 commits with no overlap across the 11 PR files.
- Netlify success; Vercel failure is the known build-rate-limit signal.
- source/test scope is consistent with AI consultation v1; no migration/deploy/production mutation/X operation.
- K3 does not merge because the candidate adds an authenticated AI API plus user-confirmed durable settings/persona writes.
- H2 assigned `x-social-mobile-pr78-ai-consult-review-20261002`, recommended **Sol（高）**.
- key review includes real production `updated_at` CAS/trigger semantics and verify_jwt config, not only unit tests.
- next_owner: codex; wait for C2.


## C2 result — schema prerequisite missing

- verdict: **HOLD / CHANGES REQUIRED before PR #78 merge**.
- H2 confirmed production `public.social_mobile_content_settings` is absent.
- PR #78 source head remains `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`; no H2 source fix.
- AI conversation source is not rejected on its merits; review stopped at the mandatory persistence/CAS prerequisite.
- existing source-only migration candidate is undergoing a separate H2 review.
- no production schema apply is authorized.
- G3 remains review_required and blocked from merge/deploy until schema prerequisite and the remaining H2 PR #78 review gates are completed.


## K3 decision — PR #81 content-settings hardening

- verdict: **PASS to focused H2 rereview; merge/apply/deploy HOLD**.
- accepted review target: PR #81 exact head `5595fb131813542c55c43bc783af623cdb9ea442`.
- fresh main is 24 commits ahead of PR base with no overlap across the 7 PR files.
- Netlify/Vercel checks green.
- reported local evidence is sufficient to proceed to independent review, not to production apply.
- H2 assigned `x-social-mobile-pr81-content-settings-hardening-rereview-20261003`, recommended **Sol（高）**.
- production migration apply remains separately approval-gated.
- PR #78 remains blocked until schema is independently accepted, applied with explicit approval, and read back.
- next_owner: codex; wait for C2.
