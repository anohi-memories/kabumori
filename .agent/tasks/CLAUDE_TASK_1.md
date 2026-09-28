# Claude Task 1

- task_id: kabumori-daily-topic-prod-apply-verify-20260928
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: merged/reviewed daily-topic RPCをproductionへ1本だけ安全に反映し、ACL・RLS境界・determinism・アプリ契約をread-back/smokeで確認する。広範なmigration pushは禁止。

## Predecessor / K1 disposition

Predecessor task:
- `kabumori-daily-topic-prod-rollout-preflight-20260928`

K1 verdict:
- **PASS**
- PR #51 reviewed head `164485bef39c42164f9a69670d6087f7735f2bea`
- pure rename only: `20260928120000_add_daily_kabumori_tip_rpc.sql` -> `20260928123000_add_daily_kabumori_tip_rpc.sql`
- GitHub compare: status `renamed`, 0 additions / 0 deletions / 0 changes
- exact raw file content equality independently confirmed by ChatGPT
- PR #51 merged -> `4c07a81702c36f95bd26acdccd68a137d8bd5eea`
- production mutation before this task: 0

Additional K1 production read-only check by ChatGPT:
- remote migration history contains neither `20260928120000` nor `20260928123000`
- `public.get_daily_kabumori_tip(text,date)` currently **does not exist** in production
- MIC Phase 3A tables **do exist** in production even though that migration version is not recorded remotely
- therefore production has pre-existing migration-history drift for MIC/out-of-band-applied DDL
- this is not a reason to alter MIC now, but it makes broad `supabase db push` unsafe for this task

Repository note:
- a separate older duplicate migration prefix `20260922090000` also exists in main. It is unrelated to daily-topic and must not be modified here.
- the daily-topic target prefix `20260928123000` itself is unique.

## Mandatory startup / isolation

1. Use an independent G1 worktree/checkout.
2. Fresh-fetch `origin/main`; record exact SHA.
3. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - `supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`
4. Confirm the migration bytes still match the independently reviewed SQL from PR #48 / PR #51.
5. Do not touch G2, MIC, important-news, X, Auth, cron, Vault, or other migrations.

## Production rollout scope

This task authorizes **only** the exact daily-topic RPC/grants represented by:

`supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`

Expected function:
`public.get_daily_kabumori_tip(text,date)`

Expected semantics:
- SECURITY DEFINER
- `search_path = ''`
- read-only SELECT over fully-qualified `public.tips`
- active tips only
- beginner/intermediate/advanced -> 初級/中級/実践
- invalid level -> zero rows
- deterministic by JST date + level
- returned columns only: id,title,category,base_text,difficulty
- PUBLIC/anon EXECUTE denied
- authenticated EXECUTE allowed
- no direct authenticated SELECT grant on `public.tips`

## Critical apply constraint

**Do NOT run broad migration tooling that would apply other pending/untracked migrations.**

Forbidden:
- `supabase db push` over the repository migration set
- `--include-all` broad apply
- migration-history repair
- marking unrelated migrations applied
- applying MIC migration
- applying any migration other than the exact daily-topic SQL
- editing production data

Use only a mechanism that can prove it applies the exact reviewed daily-topic SQL and nothing else.

If your available tooling cannot guarantee one-file / exact-SQL scope:
- STOP before mutation
- report the safest available options for K1
- do not improvise a broad push

## Required pre-apply read-only checks

Immediately before mutation:
- fresh production read of `to_regprocedure('public.get_daily_kabumori_tip(text,date)')`
- confirm it is still absent
- confirm `public.tips` exists
- confirm current table-level privileges for anon/authenticated/service_role
- confirm no direct authenticated SELECT has appeared
- record current remote migration-history tail
- confirm target SQL content hash/bytes

If any unexpected daily-topic RPC already exists or privileges drift:
- STOP before applying and report.

MIC's existing out-of-band objects are informational only; do not modify them.

## Apply

Apply exactly the reviewed daily-topic SQL once.

No edits to SQL are allowed during apply.

No other DDL/DML.

## Required post-apply read-back

Verify from production:

1. Function exists with exact signature.
2. `prosecdef = true`.
3. function config includes empty search_path.
4. function body/source references only intended tips selection logic.
5. EXECUTE:
   - authenticated = yes
   - anon = no
   - PUBLIC = no
6. `public.tips` direct SELECT:
   - authenticated = no
   - anon = no
   - existing service_role access unchanged
7. No table/RLS/policy changes occurred.
8. Function is read-only in behavior:
   - capture `use_count` / `last_used_at` for sampled returned tips before/after repeated calls and show unchanged, if those columns exist.
9. Functional smoke:
   - beginner returns active 初級
   - intermediate returns active 中級
   - advanced returns active 実践
   - invalid level returns zero rows
   - same date + same level repeated calls return same row
   - no row case, if safely testable without mutating production data, otherwise do not manufacture one
10. Returned columns are only id,title,category,base_text,difficulty.

Do not expose full tip catalog unnecessarily; use minimal rows/aggregates for verification.

## App-level verification

No new app source change is expected.

After RPC is live:
- verify authenticated client contract can call the RPC with today's JST date
- if a safe existing test account/session is already available, perform non-destructive smoke for beginner/intermediate/advanced
- do not create/delete users just for this task
- real-device visual QA may remain a later user-facing step if no safe device/session is available

## Safety

Absolutely forbidden:
- G2 shared market-report changes
- MIC changes
- important-news changes
- X/social-mobile changes
- Auth/RLS policy redesign
- cron/settings changes
- table data edits
- migration-history repair
- broad migration apply
- source changes unless required to correct a concrete rollout blocker; if source change becomes necessary, STOP and return to K1 instead of patching production ad hoc

## Completion / K1

Report:
- fresh main SHA / worktree
- exact apply mechanism used
- exact SQL hash/bytes proof
- pre-apply read-only state
- production mutation performed
- post-apply function/ACL/RLS readback
- smoke results
- migration-history state after apply
- any drift noted
- app/client smoke if available
- production mutation scope
- remaining issues
- next recommendation

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

No Codex review is expected if the exact independently-reviewed SQL is applied unchanged and all production read-backs pass.

## Archived predecessor record

# Claude Task 1

- task_id: kabumori-daily-topic-prod-rollout-preflight-20260928
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: PR #48でmerge済みの「今日のトピック」RPCをproductionへ安全に反映する前提を整える。まずmain上のmigration version衝突を解消し、内容が独立レビュー済みSQLと完全一致することを証明してPR化する。production applyはこのPhaseではまだ行わない。

## Context

Completed predecessor:
- task: `kabumori-daily-topic-level-settings-20260928`
- PR #48 reviewed head: `98732bf36b79190d52e6bca779fd19a7eb2b8a33`
- merged to main: `9ccbb59da2b6c48b0022ec2a31305a69262c2966`
- independent separate-Claude DB/RPC review: PASS
- P1/P2/P3 findings: none
- production migration apply: not yet performed

The reviewed migration SQL is:
- `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql`

A new preflight issue was found after merge:
- `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql`
- `supabase/migrations/20260928120000_mic_scenario_layer_phase3a.sql`

share the same migration version prefix `20260928120000`.

This must be resolved before any production migration tooling is used.

## Mandatory startup / isolation

1. Use a new independent G1 worktree/checkout. Do not reuse the shared checkout or G2 worktree.
2. Fresh-fetch `origin/main`; record exact start SHA.
3. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - both colliding migration files
4. Confirm no other slot is modifying either migration filename/content.
5. G2 currently owns `market-report-analysis` production observation. Do not touch its worktree, function, gates, cron, or settings.

## Phase A — migration-version collision fix only

### Required action

Rename ONLY the daily-topic migration to a fresh, unique, unused migration timestamp prefix.

Current:
`20260928120000_add_daily_kabumori_tip_rpc.sql`

Target:
- choose a new unused timestamp after checking fresh main's full `supabase/migrations` directory;
- keep the suffix `add_daily_kabumori_tip_rpc.sql`;
- do not rename or edit the MIC migration.

### Hard invariant: SQL bytes must not change

The SQL content of the daily-topic migration must remain byte-for-byte identical to the independently reviewed/merged SQL from PR #48.

Before and after rename:
- compute SHA-256 of file contents;
- hashes must match exactly;
- no whitespace/comment/content edits are allowed.

### Production preflight — read-only only

Before opening the rename PR, inspect production migration history / live function existence read-only.

Confirm:
- whether version `20260928120000` is present in production migration history;
- whether `public.get_daily_kabumori_tip(text,date)` already exists;
- whether the MIC Phase 3A objects/migration are already present.

If production state is ambiguous, if the shared version has already been recorded in a way that makes renaming unsafe, or if the daily-topic RPC is already live unexpectedly:
- STOP;
- do not repair migration history;
- do not apply/drop/recreate anything;
- report exact read-only findings for K1.

### Explicitly forbidden in Phase A

- no `supabase db push`
- no migration apply
- no migration-history repair
- no production DDL/DML
- no RPC create/drop/replace in production
- no Edge deploy
- no cron/settings/Auth/RLS/Vault/X changes
- no MIC migration/content changes
- no G2 changes

## Verification

Required:
- fresh-main migration filename uniqueness check after rename
- old path absent / new path present
- SQL SHA-256 before == after
- git diff must show rename-only for migration source
- `git diff --check`
- no source/app behavior changes
- production mutation = 0

Create a narrow PR for the rename only.

Do not self-merge.

## Completion / K1 gate

When Phase A is complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

ChatGPT will verify the rename-only PR and merge it if safe.

After that, a continuation task will authorize the exact production migration apply + ACL/readback/smoke checks.

No Codex review is expected for this rename-only phase.

## Required Report

Include:
- fresh main SHA
- independent worktree path / branch
- all colliding migration filenames found
- production read-only migration-history/function preflight
- old migration path
- new migration path
- SHA-256 before rename
- SHA-256 after rename
- proof hashes are identical
- exact diff summary
- tests/checks
- production mutation = 0
- PR number/head SHA
- remaining issues
- next recommendation

## Report — G1 result (Phase A: migration-version collision fix)

- task_id: kabumori-daily-topic-prod-rollout-preflight-20260928
- fresh main SHA at start: `db6fa5c`
- independent worktree/branch: scratch clone, branch `claude/daily-topic-migration-rename-20260928`
- **result: rename-only PR opened. Not self-merged. No production mutation.**

### Colliding migration filenames found

- `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql` (mine, from PR #48)
- `supabase/migrations/20260928120000_mic_scenario_layer_phase3a.sql` (unrelated MIC task, untouched)

### Production read-only preflight

`supabase migration list --project-ref wsmznyzcvmuitkglfeuj` (read-only; no `db push`/apply): the two most recent entries in the remote migration history are both `{"local":"20260928120000","remote":""}` — **version `20260928120000` is not present in production's applied-migration history, for either colliding file.** No migration-history repair needed.

A deeper check specifically confirming `public.get_daily_kabumori_tip(text,date)` and the MIC Phase 3A objects don't already exist via some other path was attempted (`supabase db dump --project-ref ... --schema public`, still read-only) but was **blocked by this session's own safety classifier ("Production Reads")**, not by any ambiguous or concerning data. I did not attempt to route around it with another tool, per the denial's own instructions. Flagging this gap honestly: the migration-history evidence is strong on its own (this codebase's only path to creating these objects is a tracked migration, and neither is recorded as applied), but I could not independently verify function/object non-existence myself. Recommend K1 or the user do that specific check (their own access, or explicitly granting this session a Bash permission rule) before authorizing the actual production apply in the follow-up task — not before merging this rename, which touches no production state at all.

### Rename

- Old path: `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql`
- New path: `supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`
- Chosen timestamp verified unused against fresh main's full `supabase/migrations/` listing (97 files) before renaming.

### SHA-256 proof

- Before: `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1`
- After: `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1`
- **Identical.**

### Diff summary

`git diff --stat`: 1 file changed, 0 insertions(+), 0 deletions(-). `git diff` shows a pure `rename from` / `rename to` with `similarity index 100%` — no content, whitespace, or comment change of any kind.

### Tests / checks

- Fresh-main migration filename uniqueness re-checked after rename: no duplicate prefixes remain anywhere in `supabase/migrations/`.
- Old path absent, new path present — confirmed via `ls`/`git status`.
- `git diff --check` — clean.
- No source/app (`src/`) file touched; no MIC migration touched; no G2 file/worktree touched.

### Production mutation

**0.** No `supabase db push`, no migration apply, no migration-history repair, no DDL/DML, no Edge deploy, no cron/settings/Auth/RLS/Vault/X change.

### PR / head SHA

- PR: https://github.com/anohi-memories/kabumori/pull/51
- Head: `164485b` on `claude/daily-topic-migration-rename-20260928`
- Base: fresh `main` at `db6fa5c`
- **Not self-merged.**

### Remaining issues

1. The direct schema-level confirmation that `get_daily_kabumori_tip`/MIC Phase 3A objects aren't already live was blocked by this session's safety classifier — see preflight note above. Recommend resolving before the production-apply follow-up task, not before merging this rename.
2. No Codex review expected for this rename-only phase, per the task's own instruction.

### Next recommendation

K1 verifies the rename-only PR and merges if safe. A continuation task can then authorize the actual production migration apply + ACL/readback/smoke checks, ideally after the function/object-existence gap above is closed by someone with production-read access.

