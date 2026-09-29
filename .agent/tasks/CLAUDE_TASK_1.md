# Claude Task 1

- task_id: kabumori-daily-topic-real-device-qa-20260929
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（中）
- purpose: productionでliveになった「今日のトピック」機能を、fresh mainのiOS内部配布ビルドで実機確認できる状態にし、ユーザーが初心者/中級/上級の切替とHome表示を最終確認できるようにする。

## Context

Completed predecessor:
- PR #48 source implementation merged
- PR #51 migration filename collision fix merged
- production RPC `public.get_daily_kabumori_tip(text,date)` is live
- production ACL/RLS/determinism/read-only verification PASS
- authenticated DB-role call PASS, anon denied
- no Codex review needed

Remaining gate:
- real iPhone visual/settings QA

## Goal

Prepare the safest current-main iOS nonproduction/internal build for the user and verify as much as possible without touching production configuration.

User-facing QA target:
1. Home「今日のトピック」が実データを表示する
2. Settingsで
   - 初心者向け
   - 中級者向け
   - 上級者向け
   を切り替えられる
3. Homeへ戻ると選択したレベルのtopicに変わる
4. 同じ日・同じレベルでpull-to-refreshしてもtopicが変わらない
5. エラー/準備中へ誤表示しない
6. report/news sectionsを壊していない

## Mandatory startup / isolation

1. Use a fresh independent G1 worktree/checkout.
2. Fresh-fetch `origin/main`; record SHA.
3. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - `app.json`
   - `eas.json` if present
   - `src/app/index.tsx`
   - `src/components/settings-sheet.tsx`
   - `src/components/home/topic-card.tsx`
4. Confirm fresh main contains the merged daily-topic source and renamed migration.
5. Do not touch G2/market-report-analysis or any X/MIC/news workstream.

## Phase A — preflight

Read-only / non-destructive checks only:

- EAS/Expo login status
- project linkage / projectId
- iOS bundle identifier
- available nonproduction/internal build profile
- required `EXPO_PUBLIC_*` variable presence for the selected build environment
- signing/device-registration readiness
- whether an already-existing internal build at the current main SHA can be reused

Do not display secret values. Presence only.

If a current-main compatible internal build already exists and is installable, prefer reuse instead of spending a new build.

If no reusable build exists, create exactly one safest nonproduction/internal iOS build.

## Build constraints

Allowed:
- one EAS internal/preview iOS build from fresh main if needed
- read-only EAS/Expo metadata checks
- build-status polling at reasonable intervals
- install URL/QR information for the user

Forbidden:
- App Store submission
- production App Store release
- TestFlight production rollout unless already the project's normal internal nonproduction path and explicitly safe
- changing bundle identifier/projectId
- changing EAS production secrets/env
- Supabase mutation
- database migration/DDL/DML
- Auth/SMTP config mutation
- source changes unless a concrete build blocker is found

If a source/config change is required:
- STOP
- report blocker
- do not patch and build ad hoc

## Automated verification before build/reuse

Run focused checks from fresh main:
- daily-topic tests
- settings-menu/dashboard tests
- Home regression tests relevant to report/news/topic
- `npx tsc --noEmit` and distinguish known pre-existing unrelated errors
- `npx expo config --json`
- `git diff --check`

No Codex review required for this QA-only task.

## User real-device QA checklist

When the build is ready, report a concise exact checklist for the user:

### A. Default beginner
- launch/sign in
- Home topic shows `初心者向け`
- title/body are real content, not 準備中

### B. Change to intermediate
- Settings -> 今日のトピック -> 中級者向け
- return Home
- badge/content becomes 中級者向け

### C. Change to advanced
- same flow -> 上級者向け
- Home reflects 上級者向け

### D. Determinism
- pull-to-refresh twice on same day at same level
- same topic title remains

### E. Regression
- 今日のかぶモリレポート still renders
- 重要ニュース still renders
- 保有銘柄最新ニュース still renders
- no fatal error/red screen

The user will perform the physical iPhone checks; do not claim them PASS until the user reports the result.

## Completion / K1

Report:
- fresh main SHA
- worktree
- EAS project/profile used
- whether reused existing build or created one new build
- build id/url/status
- signing/device registration result
- env presence checks (names/presence only, never values)
- automated test results
- source changes: expected 0
- production mutation: 0
- exact user QA checklist
- remaining issues

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

If build requires user interaction (device registration, Apple login, credential prompt), STOP and report exactly one next action.

## Archived predecessor record

# Claude Task 1

- task_id: kabumori-daily-topic-prod-apply-verify-20260928
- owner: claude
- slot: claude-1
- status: done
- next_owner: none
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

## Report — G1 result (production apply: STOPPED before mutation)

- task_id: kabumori-daily-topic-prod-apply-verify-20260928
- fresh main SHA at start: `4d308af`
- worktree/branch: independent scratch checkout (read-only preparation only; no branch was created, since no source change was made)

### Exact apply mechanism identified (not yet used)

`supabase db query --project-ref wsmznyzcvmuitkglfeuj --file supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql` — this executes exactly that one file's SQL against the database via a direct query, with no interaction with the migration-history tracking table and no possibility of pulling in other pending migrations. This satisfies the task's "mechanism that can prove it applies the exact reviewed daily-topic SQL and nothing else" requirement, and avoids `supabase db push`'s broad-apply risk entirely. **Caveat for K1**: because this bypasses the migration-history mechanism, `supabase migration list` will still show `20260928123000` as unapplied remotely even after a successful apply this way — expected, not a bug, and consistent with the pre-existing MIC migration-history drift K1 already flagged as informational.

### Target SQL hash/bytes proof

`supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql` on fresh main (`4d308af`): SHA-256 `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1` — **identical** to the hash recorded and independently verified through PR #48 and PR #51.

### Pre-apply read-only checks: BLOCKED, not performed

I attempted the mandated pre-apply read-only check (`to_regprocedure('public.get_daily_kabumori_tip(text,date)')` / `to_regclass('public.tips')` via `supabase db query`, read-only SELECT, no mutation) and it was **refused by this session's own auto-mode safety classifier under the "Production Reads" category** — the same category that blocked the schema-dump check in the predecessor task. I did not attempt to route around it with a different tool, host, or encoding, per the denial's own explicit instructions.

**None of the mandated pre-apply checks were performed**:
- `to_regprocedure('public.get_daily_kabumori_tip(text,date)')` absence — not confirmed
- `public.tips` existence — not confirmed (already known from prior tasks, but not freshly re-confirmed as required)
- current table-level privileges for anon/authenticated/service_role — not confirmed
- no direct authenticated SELECT has appeared — not confirmed
- current remote migration-history tail — not re-recorded fresh for this task (last known from the predecessor task's report only)

### Production mutation performed

**0. No apply was attempted.** The task's own instruction is explicit: "If any unexpected daily-topic RPC already exists or privileges drift: STOP before applying and report" and "If your available tooling cannot guarantee one-file / exact-SQL scope: STOP before mutation; report the safest available options for K1; do not improvise a broad push." Since I could not even perform the mandated pre-apply confirmation that nothing has drifted, applying anyway would directly violate this task's own safety gate — independent of my session's tooling restriction, I would not have proceeded past this point regardless.

### Why this happened (both this task and its predecessor)

This session runs under a local safety layer that blocks any direct production-database read or write by default ("Production Reads" / presumably an equivalent "Production Writes" category for the apply step, untested since I stopped before reaching it). This is separate from the project's own K1/Codex review process and from Supabase access itself being configured (the CLI is authenticated and the project is reachable — `supabase migration list --project-ref` succeeded earlier in the predecessor task, which is apparently categorized differently from `db query`/`db dump`).

### Remaining issues

1. Someone with this restriction lifted — the user directly, or a session with different permission settings — needs to either (a) perform the pre-apply checks + apply themselves (Supabase SQL editor or CLI, using the exact `supabase db query --project-ref wsmznyzcvmuitkglfeuj --file supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql` command identified above), or (b) grant this session a Bash permission rule covering Supabase production reads/writes so a future G1 pass can complete this task end-to-end.
2. The exact reviewed SQL is ready and hash-verified; nothing about the SQL itself is in question. This is purely a tooling-permission blocker, not a content or safety concern about the migration itself.

### Next recommendation

Route this to the user for an explicit decision: either they run the apply themselves using the exact command/file identified above (with the pre-apply checks first), or they extend this session's permissions so G1 can complete Phase B end-to-end in a future pass. Not recommending any workaround within this session.


## Final K1 / ChatGPT production apply completion

- result: **PASS**
- production apply completed by ChatGPT after Claude stopped at the safety gate.
- source used: current-main exact file `supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`
- GitHub blob SHA: `b383c31af29d64cb47afd5a3eb8446ca9deff398`
- SQL length observed at apply: 1943 bytes/chars as returned by GitHub connector; content was fetched directly from main and passed unchanged to the production SQL executor.
- reviewed SHA-256 from PR #48/#51 remained `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1`.

### Fresh pre-apply read-only state

Production project: `wsmznyzcvmuitkglfeuj`

Confirmed immediately before apply:
- `public.get_daily_kabumori_tip(text,date)`: absent
- `public.tips`: present
- authenticated direct SELECT on tips: false
- anon direct SELECT on tips: false
- service_role SELECT on tips: true
- tips RLS enabled: true
- remote migration history still ended at the existing tracked migrations; neither `20260928120000` nor `20260928123000` was recorded

### Exact production mutation

Executed exactly the contents of the reviewed daily-topic SQL file through the Supabase SQL execution connector.

No broad migration push.
No other migration.
No migration-history repair.
No table data edit.
No MIC/G2/news/X/Auth/cron/settings/Vault change.

### Post-apply production read-back

Function:
- exact signature exists: PASS
- SECURITY DEFINER: `prosecdef=true`
- volatility: stable
- function config: empty search_path
- function ACL: owner + authenticated only
- authenticated execute: true
- anon execute: false
- PUBLIC execute: absent from ACL
- authenticated direct SELECT on `public.tips`: false
- anon direct SELECT on `public.tips`: false
- service_role SELECT on `public.tips`: true
- tips RLS: still enabled
- tips policy count: 0
- body references `public.tips`, filters `t.is_active`, and contains no INSERT/UPDATE/DELETE
- returned table columns verified from output arg metadata: id/title/category/base_text/difficulty only

Role-level proof:
- `SET LOCAL ROLE authenticated` call returned exactly one beginner/初級 row
- `SET LOCAL ROLE anon` call failed with PostgreSQL 42501 permission denied for function

Functional smoke for JST date 2026-09-28:
- beginner -> 1 row, 初級
- intermediate -> 1 row, 中級
- advanced -> 1 row, 実践
- invalid `expert` -> 0 rows
- repeated same date + same beginner level -> same id

Read-only behavior proof:
- sampled tip had `use_count=2` and unchanged `last_used_at` before repeated RPC calls
- after repeated calls, both values remained exactly unchanged

### Migration-history note

Because the task intentionally used exact direct SQL execution rather than broad migration tooling, remote migration history still does not record local version `20260928123000`.

This is consistent with the already-known production migration-history drift (including MIC objects that exist out-of-band). Do not run a broad `supabase db push` until migration-history hygiene is handled in a dedicated task.

No migration-history repair was performed here.

### Production mutation scope

Only:
- create/replace `public.get_daily_kabumori_tip(text,date)`
- revoke EXECUTE from PUBLIC/anon
- grant EXECUTE to authenticated

Nothing else.

### Remaining issues

1. Authenticated database-role smoke passed; real-device visual/settings interaction remains a later UI QA step.
2. Production migration-history drift remains an infrastructure hygiene item and is not repaired by this task.
3. Broad `db push` remains unsafe until that drift is reconciled deliberately.

### Final disposition

Daily-topic backend is now live in production and the reviewed security/behavior contract passed production read-back.

No Codex review required; exact independently-reviewed SQL was applied unchanged.

Task closed.

## Report — G1 result (daily-topic real-device QA build ready)

- task_id: kabumori-daily-topic-real-device-qa-20260929
- fresh main SHA at start: `6b59c3f`
- worktree/branch: independent scratch checkout (no source change needed, so no branch was created/pushed)

### Phase A preflight (read-only)

- EAS/Expo login: `anohi-memories` (voxy1948.p3@gmail.com), Owner on both `anohi-memories` and `anohi-memoriess-team` accounts.
- Project linkage: `@anohi-memoriess-team/kabumori`, ID `eb80adf3-861e-4a48-a373-2d9a85b58899`.
- Bundle identifier: `com.anohimemories.kabumori`.
- `EXPO_PUBLIC_*` presence in the `preview` environment: **both present** (`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_SUPABASE_URL`) — names only, values never displayed.
- Signing/device registration: existing Ad Hoc distribution certificate (expires 2027-09-10) and provisioning profile (Developer Portal ID `5M79MS9DFQ`, already covering the registered iPhone) — both reused, no new credentials generated, no device-registration/Apple-login prompt needed.
- Reusable-build check: the two most recent `preview` builds (`10e8610e...` at commit `f04ccf35...`, `79955c92...` at commit `12db8657...`) both predate PR #46/#48/#51 — **neither contains the daily-topic client code (Home reorg, topic card, settings level picker)**. No reusable build existed; created exactly one new build per the task's instruction.

### Automated verification (before build)

- `deno test` on daily-topic/settings/dashboard/Home regression suite: **52/52 pass** (`home-topic_test.ts`, `settings-menu_test.ts`, `dashboard_test.ts`, `home-report-highlights_test.ts`, `home-news-sections_test.ts`, `home-news-visual_test.ts`).
- `npx tsc --noEmit`: 0 new errors under `src/` (same 2 pre-existing, unrelated CSS-module errors as `main`).
- `npx expo config --json`: resolves cleanly.
- `git diff --check`: clean (fresh clone, no diff).

### Build

| Field | Value |
| --- | --- |
| Platform | iOS |
| Profile | `preview` (internal distribution) |
| Status | **finished** |
| Build ID | `9f0e45a1-b2ec-4631-b04b-b510f90a475d` |
| Source commit | `6b59c3f722811dd76b8e8d9a7435c5604097c494` (fresh main at task start; contains the merged daily-topic feature + migration rename) |
| Bundle identifier | `com.anohimemories.kabumori` |
| Distribution certificate / provisioning profile | existing, reused — **no new credentials generated** |
| Started / finished | 2026-09-29 10:07:09 / 10:12:50 |
| Install link | https://expo.dev/accounts/anohi-memoriess-team/projects/kabumori/builds/9f0e45a1-b2ec-4631-b04b-b510f90a475d |

### Source changes

**0**, as expected — no blocker was found requiring a source/config change.

### Production mutation

**0.** No Supabase mutation, no migration/DDL/DML, no Auth/SMTP config change, no EAS production secret/env change, no bundle identifier/projectId change.

### Exact user QA checklist

**A. Default beginner**
1. Install/open the build, sign in.
2. Home's 今日のトピック shows レベル badge 初心者向け with real title/body content (not 準備中).

**B. Change to intermediate**
3. 設定 → 今日のトピック 投資知識レベル → 中級者向け を選択。
4. Home に戻る。
5. バッジ/内容が中級者向けに変わっている。

**C. Change to advanced**
6. 同じ流れで 上級者向け を選択 → Home が上級者向けを反映。

**D. Determinism**
7. 同じ日・同じレベルのまま pull-to-refresh を2回。
8. トピックのタイトルが変わらないまま。

**E. Regression**
9. 今日のかぶモリレポートが表示される。
10. 重要ニュースが表示される。
11. あなたの保有銘柄 最新ニュースが表示される。
12. 致命的なエラー/赤画面が出ない。

I will not mark this checklist PASS myself; it needs the user's own observation on the device, per this task's own instruction.

### Remaining issues

None found. Waiting on the user's real-device confirmation of the checklist above.

### Next recommendation

Send the user the install link and checklist; once they report the result, a final G1 pass records PASS/issues for K1.
