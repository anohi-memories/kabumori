# Codex Task

- task_id: kabumori-market-report-analysis-prod-sync-content-guard-20260929
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- purpose: K2 PASS/merge済みPR #57の `market-report-analysis` content guardを、consumer gate OFFのままproductionへ単一Function deployし、source read-back・verify_jwt・cron・consumer gate・他Function非変更を確認する。source実装は禁止。

## Accepted source baseline

- PR #57 accepted head: `b8bbfe981735e6a2e42987011f1e4a4e7ab2824c`
- merge SHA: `9488f9e8b12bb1c7c0fcf872767d078ed818c128`
- accepted behaviors:
  - 1306 proxy identity preserved
  - unsupported causal assertions rejected locally
  - valid cause A does not license unrelated cause B
  - direction/polarity inversion is rejected
  - Fact remains strict
- reported tests:
  - content guard 16/16
  - market-report-analysis 51/51
  - market-report-data-packet 42/42
  - personalized-reports 125/125
  - x shared consumer 6/6
  - _shared 279/279
  - deno check/lint/diff PASS
- production mutation from source task: 0
- consumer gates remain expected OFF/OFF
- data-packet v12 is already accepted in production by Final C1.

## Mandatory startup / isolation

1. Use a fresh independent H1 worktree/checkout; do not reuse G2/G1/shared checkout.
2. Fresh-fetch origin/main; record exact SHA.
3. Confirm merge `9488f9e8b12bb1c7c0fcf872767d078ed818c128` is an ancestor.
4. Read ORCHESTRATION, CURRENT_STATE, this TASK, Final K2 and current `market-report-analysis/**`.
5. Confirm no newer main commit changed `market-report-analysis/**` after the accepted merge without review.
6. Confirm no active slot owns `market-report-analysis/**`.
7. If isolation/ownership is ambiguous, STOP.

## Phase A — production preflight

Read-only:
- current production `market-report-analysis` version / updated_at / verify_jwt
- deployed source download/read-back
- compare production source with fresh-main accepted source
- canonical consumer settings:
  - app_enabled
  - x_enabled
- relevant market-report cron jobs/schedules
- metadata snapshot of all Edge Functions sufficient to prove only target changes later

Require before mutation:
- `app_enabled=false`
- `x_enabled=false`
- target source is stale vs accepted main or otherwise needs sync
- `verify_jwt=false` unless current reviewed production metadata proves a different accepted setting; do not guess
- cron state sane and recorded
- no ownership conflict

If production already matches fresh main byte-for-byte, do not redeploy; report no-op PASS.

Re-run relevant deterministic tests from fresh main:
- full market-report-analysis suite
- content_guard_test
- handler/transport tests
- deno check
- changed-runtime lint
- git diff --check

Do not weaken/alter source.

## Phase B — controlled deploy

If preflight proves drift, deploy exactly:
- `market-report-analysis`

Rules:
- explicit project ref
- preserve current accepted verify_jwt setting
- no broad deploy
- no db push
- no other Edge Function deploy
- no DB/schema/RPC/migration changes
- no cron change
- no app_enabled/x_enabled change
- no Auth/Vault/secret mutation
- no X post
- no app delivery activation
- no manual real cycle invocation

Use API deploy mode if required by the environment and already-supported CLI path.

## Phase C — read-back

Immediately after deploy:
1. record target version / updated_at / verify_jwt
2. download deployed source
3. byte-compare all deployable runtime files with accepted fresh-main source
4. explicitly verify the PR #57 guard logic is present:
   - 1306 protection
   - mixed supported/unsupported causality handling
   - polarity-preserving cause support
5. re-read exact cron rows; prove unchanged
6. re-read consumer gates; prove false/false unchanged
7. compare all-function metadata; prove no other Function changed by this task
8. do not manually invoke a cycle

## Failure / rollback

If source identity, verify_jwt, cron/gates, or deployment scope is wrong:
- STOP immediately
- rollback only if the pre-deploy exact source was captured and can be restored safely to this one function
- record all mutations and rollback evidence
- do not improvise broader changes

## Acceptance

PASS only if:
- exact accepted source is in production
- only market-report-analysis changed, if any deploy was needed
- verify_jwt preserved
- cron unchanged
- app_enabled=false / x_enabled=false unchanged
- no manual cycle
- no DB/Auth/Vault/X mutation

This PASS does not authorize consumer activation.

## Completion / C1

Write `.agent/CODEX_REPORT.md` with:
- task_id
- PASS / FAIL / STOP
- fresh main SHA/worktree
- production version before/after
- source drift proof
- test/check results
- deploy command/scope
- source read-back identity
- verify_jwt before/after
- cron before/after
- app/x gates before/after
- other-function metadata check
- production mutations
- rollback status
- remaining issues
- next recommendation for natural morning/close observation

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

---

## Archived predecessor task

# Codex Task

- task_id: kabumori-data-packet-prod-sync-verification-rollout-20260929
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- purpose: G1がproduction-read classifierでSTOPした market-report-data-packet 同期を、独立環境でproduction read-only preflightから引き継ぎ、条件が一致する場合だけ reviewed fresh-main source を単一Edge Functionへcontrolled deployし、read-backで同一性と周辺設定不変を確認する。source実装は禁止。

## Handoff from G1

- G1 task: kabumori-data-packet-session-reuse-prod-sync-20260929
- G1 result: STOP / BLOCKED before mutation
- production mutation: 0
- fresh-main verification SHA: 15a7ac72aba611f1eff734c38b3e6c517b4e691c
- aecfa60 confirmed ancestor
- data-packet tests: 42/42 PASS
- production market-report-data-packet observed as version 11, verify_jwt=false
- production source is older than main and lacks same-session reuse:
  - session_reuse.ts absent
  - handler lacks stored-packet lookup/wiring
  - packet_builder lacks reuse index/application
  - packet_schema lacks reuse provenance fields/validation
- G1 could not read production cron/gate rows because its classifier denied DB reads, so it correctly did not deploy.
- G2 owns market-report-analysis/**. Do not touch it.
- orchestration re-check found no market-report-data-packet/** or directly imported shared-source change between G1 verification and handoff.

## Role

This is production verification + controlled rollout, not source implementation.
Do not modify app/function source. Do not create a PR. Do not broaden scope.

## Mandatory startup / isolation

1. Use an independent H1 worktree/checkout; never use G1/G2/shared checkout.
2. Fresh-fetch origin/main and record exact SHA.
3. Read ORCHESTRATION, CURRENT_STATE, this TASK, current G1 TASK/latest G1 report, and market-report-data-packet source.
4. Confirm aecfa60 is an ancestor of fresh main.
5. Confirm no later main commit changed market-report-data-packet/** or directly imported shared dependencies after G1 verification without review.
6. Confirm no overlap with G2.
7. If isolation/ownership is ambiguous, STOP.

## Phase A — independent read-only preflight

Reproduce G1 source-drift proof independently:
- production function version, updated_at, verify_jwt, entrypoint metadata where exposed
- download deployed source
- compare deployed source with fresh-main deployable source
- prove whether same-session reuse is missing in production
- run full market-report-data-packet tests, applicable deno check/lint, git diff --check

Read only the minimum production DB state required:

### Cron snapshot
Read current pg_cron rows relevant to market-report-data-packet and shared market-report-analysis schedules.
Record jobid, jobname, schedule, active, and command text/identifier only as needed for before/after comparison.

### Consumer gate snapshot
Determine canonical config location from reviewed source/schema; do not guess.
Read only fields needed to prove:
- app_enabled=false
- x_enabled=false

Do not read user data, report bodies, tokens, Vault plaintext, or secrets.

If any precondition differs, STOP before deploy.
If production DB reads are blocked in H1 too, STOP; do not route around using hidden credentials/service-key REST.

## Phase B — controlled single-function deploy

Proceed only if Phase A proves:
- production source stale vs reviewed fresh main
- same-session reuse exists in fresh main and is absent in production
- verify_jwt=false
- cron snapshot sane
- app_enabled=false
- x_enabled=false
- no ownership conflict

Deploy exactly market-report-data-packet from clean fresh main with explicit project ref and preserve verify_jwt=false.

Allowed command shape after preflight:
supabase functions deploy market-report-data-packet --project-ref wsmznyzcvmuitkglfeuj --no-verify-jwt

Forbidden:
- source edit
- broad deploy
- db push
- any other Edge Function deploy
- cron/settings/gate changes
- DB/schema/RPC/migration write
- Auth/Vault/secret mutation
- manual real cycle invocation
- X/app consumer activation

Do not rely on shared untracked supabase/config.toml. If CLI needs local config, use only minimum isolated non-secret config and do not commit it.

## Phase C — post-deploy read-back

Immediately after deploy:
1. Record version / updated_at / verify_jwt.
2. Download deployed source.
3. Byte-compare deployed bundle files against fresh-main source.
4. Prove session_reuse.ts, handler wiring, packet_builder reuse wiring, packet_schema provenance/validation are present.
5. Re-read exact same cron rows and prove unchanged.
6. Re-read same consumer gates and prove app_enabled=false / x_enabled=false.
7. Compare Edge Function metadata before/after and confirm no other function was deployed/updated by this task.
8. Do not manually invoke a cycle.

## Failure / rollback rule

If deployed source does not match reviewed main, verify_jwt is wrong, or unexpected deployment-side mutation appears:
- STOP immediately.
- Only if pre-deploy source was downloaded and can be restored exactly with same verify_jwt, perform controlled rollback of this one function; otherwise do not improvise.
- Record rollback evidence/mutations.

## Acceptance

PASS only if:
- stale production source independently reproduced
- one controlled data-packet deploy completed
- read-back matches reviewed fresh main
- same-session reuse present
- verify_jwt remains false
- cron unchanged
- app_enabled/x_enabled remain false/false
- no other function/config/DB mutation
- no manual cycle invoked

No consumer activation is authorized.
Natural morning/close validation remains a later gate.

## Completion / C1

Write .agent/CODEX_REPORT.md with:
- task_id
- PASS / FAIL / STOP
- exact fresh main SHA/worktree
- production version before/after
- source drift proof before
- tests/checks
- cron before/after
- gates before/after
- deploy command/scope
- source identity/read-back
- verify_jwt before/after
- other-function mutation check
- production mutations
- rollback status
- remaining issues
- next recommendation for natural-cycle observation

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

## H1 execution — 2026-09-29 JST

- result: **PASS**; controlled production sync completed. C1 confirmation pending.
- deployed source: fresh main `d79b0c8524af56cc56c5245f5037517fc689d917`; no function source edits.
- production `market-report-data-packet`: v11 -> v12, verify_jwt=false unchanged.
- downloaded read-back: all 8 deployable files byte-identical to that exact main; same-session reuse and handler/builder/schema wiring present.
- tests: 42/42 PASS; runtime check + runtime lint PASS. Full-directory lint has one pre-existing test-only require-await finding; recorded without modifying source.
- cron jobids 28-33 unchanged, including command hashes; app_enabled/x_enabled remain false/false.
- other 18 functions' metadata unchanged; no manual invocation, no DB/cron/secret/consumer mutation.
- details: `.agent/CODEX_REPORT.md`, latest section for this task. Stop for C1; natural-cycle validation is a later gate.

---

## Archived predecessor task

# Codex Task

- task_id: x-social-mobile-auth-phase2-final-acceptance-review-20260928
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- purpose: PR #47 fixed headの最終Auth受け入れ確認。前回H1で再現した7件＋追加3件の修正だけをfocused regressionで確認し、merge可否を確定する。新しい広範レビューや別設計への拡張はしない。

## Review target

- PR #47 exact fixed head: `5fd483a5fc651da07d0791c68eaa557cdb201357`
- previous failed head: `7bda196147a749431774fba915a86d41bf43dc5d`

## Required focus

Reproduce/verify only these corrected boundaries:

1. provider linking accepts only valid expected external provider auth URLs and rejects malicious/unexpected URLs.
2. duplicate callback delivery shares the actual in-flight success/failure result; no false success.
3. `sb_flow_id` is preserved, strictly validated and passed to `exchangeCodeForSession`; concurrent/stale/malformed/mismatched flows fail safely.
4. email signup no-session UX does not enumerate existing accounts.
5. provider access/refresh credentials are not persisted in plaintext storage/context; Supabase app session restore still works.
6. password recovery is bound to exact user/session/flow and invalidates on incompatible user/session switch.
7. callback parser rejects malformed authority, userinfo/port, duplicate/conflicting credential params and posting callback.
8. new-account/onboarding state is exact-user scoped and survives interruption until explicit acknowledgement where appropriate.
9. provider/email readiness fails closed when provider/build config is missing; no fake ready state.
10. Apple linking path/config distinction is internally consistent.
11. X app-auth remains strictly separate from posting X `x-oauth-connect-user` + Vault path.
12. no service_role, user_metadata authorization, provider-token logging or posting-token exposure.

## Mandatory startup

- read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, latest G3 Report and previous H1 report section.
- independent H1 worktree.
- fresh fetch `origin/main` and exact PR #47 head.
- read current Supabase skill.
- check only current docs necessary to validate the above semantics.

## Verification

- inspect `7bda196..5fd483a` correction diff.
- run existing new Auth tests, including SDK behavior tests.
- recreate prior H1 negative probes where still useful.
- run:
  - `npm test`
  - data-view tests
  - typecheck
  - lint
  - Expo web + iOS export
  - git diff --check
  - source/secret/token scan
- verify mutation coverage where practical.

## Fix policy

- If a small, obvious source defect remains directly within one of the listed corrected boundaries, H1 may fix it on PR #47 and retest.
- If a design-level or new unrelated issue appears, report and STOP.
- Do not broaden review scope.

## Production constraints

- no provider console changes
- no redirect allowlist change
- no SMTP/template changes
- no Apple/Google/X console changes
- no DB migration
- no Stage 3B activation
- no real X post
- production_mutation=0

## Completion / C1

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed PR #47 head
- prior 7 findings status
- additional 3 gaps status
- test results
- any source fix
- production_mutation=0
- whether PR #47 is ready to merge
- remaining real-device/provider-console gates only

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

## H1 final acceptance — 2026-09-28

- **PASS-WITH-FIX**. Initial fixed head `5fd483a5fc651da07d0791c68eaa557cdb201357`; accepted PR #47 head after the permitted small H1 correction: `ed5f8b7890e538593dba369dd85cb99a12b27242`.
- Prior seven findings and three continuation/readiness/Apple-linking gaps pass focused source acceptance. H1 tightened cached callback flow/type binding and in-flight retention, recovery-action context pinning, and provider authorize paths; added six durable regression tests.
- Final mobile tests 43/43 + data-view 14/14, typecheck/lint, Web+iOS export, diff/secret checks PASS; four H1 in-memory mutations detected. Real provider/device E2E remains a separately authorized gate.
- Source correction pushed to PR #47; final exact head read back OPEN/MERGEABLE with Vercel/Netlify Preview SUCCESS. No merge, production deploy/config/DB/OAuth/X mutation; `production_mutation=0`.
- Ready for C1 and normal source merge decision at the accepted head. Full report: latest final-acceptance section of `.agent/CODEX_REPORT.md`. STOP for C1; no further review loop without a concrete discrepancy/new assignment.


## Final C1 — Auth Phase 2 final acceptance

Verdict: **PASS-WITH-FIX**.

- accepted PR #47 head: `ed5f8b7890e538593dba369dd85cb99a12b27242`.
- H1 applied one small bounded correction commit and re-ran the focused acceptance suite.
- prior seven findings and additional onboarding/readiness/Apple-linking gaps are accepted at source level.
- final tests: mobile 43/43, data-view 14/14, typecheck/lint, Expo web+iOS export, diff/secret checks PASS.
- X app-auth remains separate from posting-X/Vault.
- provider credentials are not persisted in plaintext app storage/context under the accepted policy.
- production_mutation=0 during review.
- PR #47 merged after C1 at merge commit `fbddef2535b82bf4775c2e4fddb93eeefb8c638a`.
- remaining gates are real-device/provider-console configuration/E2E only.

## Final C1 — accepted controlled production sync

- verdict: **PASS**.
- accepted H1 task: `kabumori-data-packet-prod-sync-verification-rollout-20260929`.
- deployed source commit: `d79b0c8524af56cc56c5245f5037517fc689d917`.
- production `market-report-data-packet`: v11 -> v12.
- `verify_jwt=false` preserved.
- all 8 deployable runtime files read back byte-identical to the accepted source commit.
- same-session reuse and handler/builder/schema wiring are present in production.
- data-packet tests: 42/42 PASS; runtime check/lint PASS.
- pg_cron jobs 28-33 unchanged before/after, including schedules/active/command digests.
- consumer gates unchanged: `app_enabled=false`, `x_enabled=false`.
- all other 18 Edge Functions' metadata unchanged.
- production mutation: exactly one target Edge Function deploy; no DB/schema/RPC/Cron/Auth/Vault/secret/gate mutation; no manual cycle; no X/app activation.
- rollback not required.
- post-C1 fresh-main check: current main advanced beyond the deployed commit only in agent/report control files; no `market-report-data-packet/**` or relevant shared-source change, so production v12 is not stale relative to current source.
- natural-cycle morning/close validation remains a separate gate. Consumer activation remains unapproved.


## Assignment correction — cancelled before execution

- disposition: **CANCELLED / MISROUTED BEFORE START**.
- reason: user clarified `kabumori-market-report-analysis-prod-sync-content-guard-20260929` belongs to G2, the owning implementation/rollout workstream, not H1.
- execution: not started.
- production mutation: 0.
- deploy: none.
- source changes: none.
- continuation: moved to `.agent/tasks/CLAUDE_TASK.md` / G2 with recommended model Sonnet5（高）.
- H1 is released from this assignment and must not run it concurrently.
