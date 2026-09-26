# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3a-merge-edge-observe-20260926
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: reviewed Stage 3A sourceをmainへmergeし、Stage 3A対応版 x-test-post をproduction Edgeへdeployしたうえで、AI Labの自然な期限切れ1サイクルを観測して本番動作を確認する。

## Authorization

User approved proceeding on 2026-09-26 JST.

This task authorizes ONLY:
1. PR #38 reviewed/fixed head のfresh-main整合確認
2. PR #38 merge
3. merged mainから x-test-post のみ production Edge deploy
4. deploy後のread-only verification
5. AI Labの**自然な**次回token-expiry/refresh cycleを1回だけ観測
6. 安全上必要な場合のgate OFF / safe stop

Not authorized:
- second account pilot
- Stage 3B / 3C / 4 activation
- rollout row変更
- bulk Vault migration
- manual token refresh
- manual X test post
- replay of historical failed posts
- migration apply/reapply
- migration repair
- db push / include-all
- Kabumori credential migration
- unrelated DB/Auth/Admin/Cron/important-news changes

## Reviewed state

- PR #38 fixed head: `748deb13a934129e5696ab5552401f547204b32c`
- C1: PASS-WITH-FIX
- Stage 3A migration is already applied in production and read-back PASS
- production rollout rows at last K3: AI Lab only = enabled
- no other pilot/enabled rows
- migration history debt remains intentionally unnormalized
- live Edge is still pre-Stage3A TypeScript and must be updated only after merge
- current global refresh gate is expected ON from prior AI Lab recovery, but must be freshly verified

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Stage 3A production-apply report
   - latest H1/C1 Stage 3A report
2. Use independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog/docs relevant to Edge Functions deploy/secrets/runtime.
6. Check installed Supabase CLI version and discover deploy commands with `--help`.
7. Do not touch G4/Admin Auth work.

## Stage 0 — pre-merge and production preflight

Before merge, confirm:

### A. PR identity
- PR #38 is OPEN
- exact head = `748deb13a934129e5696ab5552401f547204b32c`
- no semantic changes after C1
- mergeable against fresh main
- any required CI/source checks are green or explainable
- source diff remains within Stage 3A scope

Any semantic drift => STOP.

### B. Production DB authority
Read-only confirm:
- Stage 3A rollout table/functions exist
- AI Lab is the only enabled rollout row
- no pilot row
- no unexpected second enabled account
- current AI Lab refresh state is healthy or at least in a known non-terminal state
- no refreshing lease is unexpectedly stuck
- Kabumori remains legacy non-Vault path
- no credential-ref sharing

Unexpected delta => STOP.

### C. Migration safety
Confirm:
- Stage 3A migration file is already live in production
- remote migration history remains known-debt/unrecorded
- this task will NOT run migration apply/repair/db push
- merge/deploy procedure cannot implicitly apply migrations

If deployment tooling would auto-apply migrations, STOP.

## Stage 1 — merge PR #38

Merge exact reviewed/fixed head only.

After merge:
- record merge commit
- fresh fetch `origin/main`
- prove Stage 3A semantic files match reviewed head
- no unexpected unrelated conflict resolution
- rerun focused source tests required to ensure merge did not alter semantics

Minimum:
- x-test-post focused tests
- _shared relevant tests
- Stage 3A static/migration contract tests
- git diff/status clean in G3 worktree

If merge introduces semantic drift => STOP before Edge deploy.

## Stage 2 — production Edge deploy

Deploy **x-test-post only** from the verified merged main source.

Requirements:
- no migration apply
- no env change unless a rollback safety action is required
- no other Edge Function deploy
- preserve verify_jwt behavior exactly as currently intended
- use the reviewed source corresponding to merged main
- after deploy, download/read-back or equivalent source identity proof must show exact deployed Stage 3A source
- confirm Stage 3A rollout refusal/proactive-start handling from fixed head is present
- confirm Kabumori legacy path is unchanged

Record:
- prior Edge version
- new Edge version
- source identity / hash evidence
- verify_jwt setting

Any mismatch => rollback if safe and STOP.

## Stage 3 — immediate post-deploy read-only checks

Confirm:
- global refresh gate current state
- AI Lab rollout = enabled
- all other rollout rows remain off/absent
- AI Lab account health remains healthy
- no token refresh occurred merely from deployment
- no X post occurred merely from deployment
- no cross-account mutation
- no rollout row mutation

If deploy itself causes unexpected refresh/post/mutation => STOP.

## Stage 4 — one natural AI Lab expiry-cycle observation

Observe exactly one naturally scheduled AI Lab post that requires or encounters token refresh after token expiry.

Do NOT:
- manually invoke x-test-post
- create a manual X post
- shorten expiry
- alter rollout mode
- force token invalidation
- replay old rows

Required evidence:
- intended AI Lab scheduled post is claimed once
- exact AI Lab account is selected
- at most one refresh request
- at most one retry of the intended X create after 401, if reactive path occurs
- refresh generation advances exactly once if a refresh occurs
- access expiry/last_refreshed_at update consistently
- rotated credentials commit only to the same AI Lab account
- final scheduled post succeeds
- no duplicate X post
- no second 401
- no uncertain result
- no reauth_required
- no stuck lease
- no cross-account credential/state change
- Kabumori remains unchanged

If the next natural due post occurs while token is still valid:
- record a normal success but continue waiting only until the first **practical** natural expiry-cycle candidate within this session/window.
- do not manufacture a refresh.
- if no natural expiry-cycle can be observed safely within the available working window, STOP with `OBSERVATION_PENDING`; do not treat as failure.

## Hard stop / rollback conditions

Hard stop on:
- PR/source drift
- merge conflict requiring semantic judgment
- unexpected rollout row
- unexpected account becomes eligible
- Edge source mismatch
- verify_jwt drift
- invalid_grant / reauth
- token endpoint uncertainty/network ambiguity
- second 401
- duplicate provider request
- lease mismatch/stuck refresh
- credential commit mismatch
- cross-account mutation
- Kabumori path change
- unexpected migration execution
- secret/token exposure

On Edge-deploy regression before a token rotation/uncertain event:
- rollback to prior known-good x-test-post source if safe
- leave DB authority layer intact
- report exact non-secret evidence

Do not blindly retry an uncertain refresh.

## Production mutation allowed

Allowed expected mutations:
- GitHub merge of PR #38
- x-test-post Edge deployment
- one natural AI Lab refresh/credential rotation/state update if triggered by its scheduled post
- one normal AI Lab scheduled X post from existing scheduler

No other production mutation is authorized.

## Completion / K3

Report:
- task_id
- source head + merge commit
- merge verification
- focused tests
- Edge prior/new version
- deployed source identity
- verify_jwt state
- gate state
- rollout rows before/after
- natural observation timestamp/post identity using non-secret identifiers
- whether refresh happened
- refresh generation before/after
- X retry count
- scheduled post result
- cross-account/Kabumori checks
- production mutations
- hard-stop conditions encountered
- remaining risks
- whether Stage 3A is fully live and ready to plan Stage 3B second-account pilot

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

## Report

- pending
