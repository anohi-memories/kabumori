# Codex Task H1 — CURRENT TASK

- task_id: postona-pr106-phase2a2-security-rereview-20261007
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused exact-head DB/security rereview
- target_pr: 106
- target_head: a8f313dc72b087ab86482781297848fe6e23bdcc
- previous_reviewed_head: dac01220ca600cc003b3dafa4b30a84340b29850
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Perform one focused independent rereview of POSTONA PR #106 after G4 corrected all six blockers from the prior direct review.

Do not broaden this into a new architecture review.
Do not merge or apply anything.

The exact question is whether head `a8f313dc72b087ab86482781297848fe6e23bdcc` safely closes B1-B6 while preserving the already accepted X behavior and source-only scope.

## Freshness / isolation

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/ACTIVE_TASK.md`
   - `.agent/CURRENT_STATE.md`
   - latest G4 TASK/Report
   - this H1 TASK.
2. Use a fresh independent H1 worktree/checkout from `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh-fetch origin/main and PR #106.
4. Require exact head `a8f313dc72b087ab86482781297848fe6e23bdcc`; moved head => STOP.
5. Allocation-time facts:
   - PR #106 open/unmerged;
   - exactly 6 changed files;
   - Netlify PASS / Vercel PASS;
   - current main is 5 commits ahead of PR merge-base, all in `.agent/` files only;
   - changed-file overlap with the six PR files = 0.
6. G3 is separately active on AI Lab continuity; G5 is separately active on common-account native validation. Do not touch their files/worktrees/servers.
7. No production DB/catalog read, migration apply, deploy, Auth/OAuth/Vault/secrets, real X/Threads/Instagram call, merge, or production mutation.

## Review scope — B1 provider identity uniqueness

Independently reproduce the former failures and confirm the corrected precondition refuses them atomically before DDL:

- missing `(platform, platform_user_id)` unique index;
- X-only predicate;
- wrong/wider key;
- expression index;
- invalid/not-ready index;
- wrong predicate;
- NULLS NOT DISTINCT / non-default opclass/collation if supported by the fixture.

Confirm the accepted healthy shape is semantically the existing unique btree on:
- `platform, platform_user_id`
- predicate covering every non-null canonical provider identity.

Verify no silent repair/deduplication.

## Review scope — B2 provider immutability

Independently verify provider relabeling is impossible for all provider pairs and connection states, including simultaneous edits to:
- access ref;
- refresh ref;
- connection_status;
- publish_enabled.

Probe:
- X -> Threads / Instagram;
- Threads / Instagram -> X;
- Threads <-> Instagram;
- service_role and owner paths;
- multi-row UPDATE;
- UPSERT/conflict update.

Normal same-provider X publish/refresh/delete operations must remain green.

## Review scope — B3 PG16+/17 SET ROLE graph

Independently exercise:
- `INHERIT FALSE, SET TRUE` authenticated -> service_role;
- anon equivalent;
- transitive SET-only chains;
- SET path to owner;
- SET path to superuser/BYPASSRLS/write-bearing role;
- column-only INSERT/UPDATE role;
- service_role -> owner/superuser path.

Confirm unsafe graphs fail before DDL and the migration does not normalize memberships.

Inspect the actual membership logic; do not rely only on tests.

## Review scope — B4 explicit starting schema/security contract

Verify the migration now fails closed on unknown starting drift rather than merely snapshotting it.

Probe at least:
- plaintext-credential-shaped column;
- arbitrary unknown column;
- unknown CHECK / UNIQUE / index / trigger / policy;
- policy permissive/restrictive drift;
- trigger event/function/security/search_path drift;
- PUBLIC / anon / authenticated / unknown-role ACL drift;
- column ACL drift;
- unexpected grant option;
- missing authenticated SELECT if that is part of the approved baseline.

Confirm the healthy fixture's full expected:
- 14 columns;
- expected constraints/indexes;
- RLS policy;
- triggers;
- table/column ACL;
- role graph
matches the migration's precondition exactly enough to justify fail-closed behavior.

If a claimed baseline depends on facts only known from historical production inventory and not source, identify it explicitly as a **future production-preflight requirement**, not a source-review failure unless the migration invents the fact unsafely.

## Review scope — B5 connected Meta access credential

Verify the complete provider/status/ref matrix:
- Threads + Instagram;
- all allowed connection statuses;
- access present/absent;
- refresh present/absent.

Required:
- Meta refresh ref always null;
- connected / identity_verified Meta requires access ref;
- explicit pre-connect/disconnected states can remain without access ref when consistent with current status contract;
- X DB acceptance is not unintentionally tightened.

Probe updates that remove access while connected and valid disconnect transitions.

## Review scope — B6 service_role provider authority

This is security-critical.

Verify:
- direct service_role Meta INSERT is refused;
- direct service_role Meta UPDATE is refused;
- UPSERT cannot bypass the guard;
- X writes required by current runtime still work;
- anon/authenticated cannot write X or Meta;
- provider guard is not bypassable by provider relabeling or simultaneous changes.

Audit the actual existing SECURITY DEFINER functions that write `social_accounts`.
Confirm none acts as a generic Meta writer under the corrected schema.

Inspect the future intended narrow owner/SECURITY DEFINER Threads path only as a design boundary; do not implement it here.

## Defensive postcondition review

Verify the corrected migration/postcondition tracks:
- exact new CHECK expressions;
- policy `polpermissive`;
- full trigger definition and trigger function identity;
- trigger function owner/security/search_path/body identity;
- index valid/ready/live/immediate state;
- role memberships/options;
- full relevant ACL/column ACL;
- all rows.

Check that precondition/DDL/postcondition failures all rollback to the original X-only state with no guard/helper residue.

## Regression evidence

Independently rerun enough to support the verdict:

- corrected G4 runner;
- mutation suite;
- original direct-review reproductions for B1-B6;
- X publish permission;
- X refresh pilot/authority;
- account deletion;
- PR41 Stage3B/settings-reader boundary;
- source/diff checks.

The G4 report claims:
- 73 adverse starting states;
- 21 postcondition mutation states;
- 45/45 mutation detection;
- B5 60-case matrix;
- B2 64-case matrix plus UPSERT/multi-row;
- no production/provider operation.

Do not assume these counts prove correctness; sample and independently reproduce the critical former blockers.

## Verdict

Return one of:

### PASS
Only if:
- B1-B6 are independently closed;
- no new P1/P2 blocker appears within the bounded scope;
- X regressions are preserved;
- no source/production boundary was exceeded.

A PASS is **source merge readiness only**.
It does not approve production preflight or migration apply.

### CHANGES REQUIRED
If any B1-B6 reproduction still succeeds, or a new material security/schema blocker is found.

Provide:
- exact file/line area;
- independent reproduction;
- minimum correction;
- whether prior accepted areas remain intact.

## Report

Append to `.agent/CODEX_REPORT.md`:
- task_id / verdict;
- exact reviewed head;
- B1-B6 disposition;
- independent PostgreSQL evidence;
- ACL/role/owner assessment;
- X regression result;
- changed files by reviewer;
- production reads/writes = 0;
- merge recommendation;
- production apply recommendation;
- remaining production-only facts.

Then:
- TASK status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1.

推薦モデル：**Sol（高）**

---

## Final C1 — CHANGES REQUIRED — 2026-10-07

- C1 accepts the completed H1 verdict for PR #106 head `a8f313dc72b087ab86482781297848fe6e23bdcc`: **CHANGES REQUIRED**.
- two remaining blockers only:
  1. existing trigger-function owner/ACL drift is not fully fail-closed;
  2. the new provider guard function body is not pinned by the postcondition.
- existing X regressions and the 45/45 mutation suite remain green.
- H1 source changes: 0.
- production read/write/apply/deploy/provider operations: 0.
- H1 is now closed/free; corrective returns to G4.
- recommended G4 model: **Opus5.5（高）**.
- corrected head must receive one focused exact-head rereview afterward, recommended **Sol（高）**.

# Previous H1 task history

# Codex Task H1 — CURRENT TASK

- task_id: ai-lab-topic-continuity-pr109-focused-review-20261007
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol（高）
- target_pr: 109
- target_head: f83247ae1024d4220dfbfa5484c725381d63815d
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Perform one focused independent exact-head review of PR #109, the AI Lab topic-pool continuity fix.

Do not reopen unrelated X/social work. The target is narrow:
- expand company AI Lab evergreen topics from 7 to 74;
- preserve recent-diary priority;
- add Tier 3 continuity reserve;
- increase claim candidate limit 64 -> 128;
- update the canonical evergreen mapping inside SECURITY DEFINER `claim_ai_lab_topic`;
- prove 10 posts/day can run without topic exhaustion while existing dedupe/cooldown/provider safety remains intact.

## Freshness / isolation

1. Read ORCHESTRATION, ACTIVE_TASK, CURRENT_STATE, G3 TASK/Report, this TASK and PR #109.
2. Use a fresh independent H1 worktree/checkout from `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh-fetch origin/main and PR #109.
4. Require exact head `f83247ae1024d4220dfbfa5484c725381d63815d`. If moved, STOP.
5. Re-check changed-file overlap with G2/G4/G5 and current main.
6. No production access/write, migration apply, deploy, scheduler invoke, OpenAI/X call, Vault/Auth/OAuth/provider mutation.

## Review questions

### 1. SECURITY DEFINER / ACL / ownership — blocking if wrong
Independently verify migration `20261007173000_ai_lab_topic_evergreen_capacity.sql`:
- replaces only the intended `claim_ai_lab_topic(uuid,jsonb,integer)`;
- preserves SECURITY DEFINER and exact safe search_path behavior;
- does not create a weaker overload;
- preserves owner assumptions and rejects unsafe owner/API-role membership drift;
- preserves effective EXECUTE scope: service_role only, no PUBLIC/anon/authenticated leakage including inherited/SET ROLE paths;
- does not grant table/column privileges;
- preflight/postcondition fail closed on unexpected schema/function/ACL drift;
- reapply is safe/idempotent;
- base migration prerequisite is correctly enforced.

Run the disposable PostgreSQL proof and add adversarial fixtures only if needed.

### 2. Canonical map / validation
Verify:
- TS seeds/tags and SQL `c_evergreen_tags` are exactly aligned for all 74 entries;
- evergreen-0..6 retain prior identities/tags;
- unknown evergreen ids are rejected;
- 129+ candidates remain rejected;
- candidate validation is still all-or-nothing before mutation;
- increasing 64 -> 128 cannot bypass canonical theme tags or event/unit-key validation.

### 3. Capacity semantics
Independently reproduce:
- current 7-seed baseline exhausts;
- diary=0, 10 posts/day, >=14 days -> no exhaustion;
- per-seed published cooldown >=72h;
- tagged shared-theme cooldown >=48h;
- unresolved claimed/provider_started/ambiguous seeds remain blocked;
- rotation fixed/skewed cannot cause unexpected exhaustion;
- continuity reserve is actually last priority after diary and Tier 2.

Check whether 74 seeds is mathematically sufficient under the shipped claim semantics, not only the in-memory model.

### 4. Product/content safety
Verify new topics:
- are materially varied enough for the intended account;
- do not contain fabricated specific recent AI/news claims;
- require no Web Search to remain truthful;
- Tier 3 is generic and safe rather than fake "today" events;
- existing content diversity/fingerprint/X outcome protections are unchanged.

Do not turn this into editorial rewriting unless a concrete safety/duplication defect exists.

### 5. Rollout order
Confirm G3 Report's production order:
1. read-only preflight;
2. apply migration first;
3. read-back ACL/function/map;
4. deploy x-test-post second;
5. read-back deployed bundle.

Verify that deploy-first against the old DB function would indeed fail closed and therefore must remain forbidden.

## Regression boundary

Do not change or reopen:
- G2 market-report GPT-6.1 rollout;
- G4 social_accounts/Threads schema;
- G5 common-account client;
- POSTONA Auth/OAuth/Vault;
- X token refresh/publish authority;
- scheduler frequencies/posting windows;
- unrelated AI model policy;
- important-news/MIC/Kabumori app.

## Expected evidence

At minimum:
- inspect exact 5-file PR diff;
- run relevant Deno AI Lab suites;
- run `supabase/tests/ai_lab_topic_capacity_run.sh` in disposable local PostgreSQL;
- run existing claim SQL proof if practical;
- run migration source invariant tests;
- `git diff --check`;
- secret/scope scan;
- exact-head/fresh-main read-back.

## Verdict

Return exactly one:
- PASS
- CHANGES REQUIRED

If PASS, explicitly state whether PR #109 may merge at the exact reviewed head but **production migration/deploy remain separately gated**.

If CHANGES REQUIRED, list only concrete blocking findings with reproduction/evidence.

## Completion

Write H1 Report to `.agent/CODEX_REPORT.md`.
Then set:
- status: review_required
- next_owner: chatgpt

STOP for `C1`.

## H1 completion — 2026-10-07

- Exact PR109 head `f83247ae1024d4220dfbfa5484c725381d63815d`; verdict **CHANGES REQUIRED**. Three concrete P2 migration-boundary findings: non-inheriting SET ROLE paths to service_role pass; table-schema drift passes; unsafe companion-function body drift passes.
- Independent local PG17 adverse fixtures: seven unsafe states accepted, three negative controls correctly rejected. Unsafe start-function fixture returns true without durable provider_started, settlement fails, and the same diary event is reclaimable after lease expiry. No real provider call.
- Capacity/product change itself is verified: normal/fixed/skew SQL rotations each 140/140; original seven 6 claims / 4 exhausted slots on day one; 72h seed / 48h shared-theme cooldowns preserved; 74-entry TS/SQL parity, diary -> Tier2 -> reserve ordering, malformed payload all-or-nothing and unresolved quarantine PASS.
- Focused checked tests 118/118; broad runtime tests 1007/1007 with --no-check; broad checked run has the same 18 diagnostics on candidate and pre-PR parent, not new debt. Changed-file check/lint, migration invariants 11/11 and diff check PASS; prior claim SQL proof 132 PASS markers.
- H1 only changes TASK/Report; source patches, production access/mutation, migration apply, merge, deploy, scheduler, OpenAI/X/Auth/OAuth/Vault operations = 0. Dedicated disposable DB stopped.
- Return PR109 to G3 for bounded corrective and a focused exact-head re-review; do not merge/apply/deploy this head. Production migration-before-deploy ordering remains separately gated. **STOP for C1**.

---

# Previous H1 task — preserved history

# Codex Task H1 — CURRENT TASK

- task_id: common-account-v1-phase2-q1-final-rereview-20261007
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- target_pr: 95
- target_head: ba35b642d30ce423a8683feffcd26aec325b45ee
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Perform the final focused exact-head rereview of PR #95 after G5's round-4 Q1 correction.

Do not repeat the whole common-account review. Focus on the remaining queued-preparation cancellation boundary and verify previously accepted invariants did not regress.

## Freshness / isolation

1. Read PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, ACTIVE_TASK, latest G5 Report, previous H1 Report, and this TASK.
2. Use an independent H1 worktree/check-out from `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh-fetch origin/main and PR #95.
4. Require exact head `ba35b642d30ce423a8683feffcd26aec325b45ee`; if moved, STOP and report.
5. K5 fresh main: `6717083c21300fe247736296430089cec8a6a397`; changed-file overlap with PR #95 was 0. Re-check at review time.
6. No production access/write, migration apply, deploy, EAS, Auth/Storage/OAuth/Vault/Cron/X/provider mutation.

## Q1 — must close

Independently verify on actual candidate source:

- a deferred auth task captures intended owner/login;
- immediately before it advances generation/loading or enters acceptSession/prepareSession/transport, it confirms that owner/login is still the synchronously announced current owner;
- if superseded, it returns before any automatic enrollment request can dispatch;
- synchronous auth callback still performs no awaited Auth/Data/network work.

Reproduce at minimum:
1. A1 established -> SIGNED_IN(A2) queued -> SIGNED_OUT before A2 deferred dispatch -> **0 A2 automatic requests**, readiness remains null.
2. A1 -> SIGNED_IN(A2) queued -> different user B before A2 deferred dispatch -> **0 A2 requests**, B only its own current preparation.
3. A1 -> A2 queued -> same user fresh A3 before A2 dispatch -> **0 A2 requests**, A3 only its own.
4. current A2 with no superseding event -> exactly one preparation.
5. same-session TOKEN_REFRESHED -> no unnecessary duplicate start and intended single-flight preserved.

Use the prior reviewer reproduction without weakening assertions where possible.

## Regression boundary

Confirm no concrete regression in:
- original S1-T synchronous stale-readiness fence;
- stable `userId + session_id` context;
- S2 X queued pre-dispatch cancellation;
- immutable captured-token Authorization;
- strict response validation;
- R1 automatic start never reactivates ended / explicit reactivation separation;
- Kabumori positive-ready push/notification gate;
- PR #94 root news-detail route in final merged tree compatibility;
- X enrollment remains separate from X OAuth/workspace/credentials/publish authority.

Do not reopen accepted areas without concrete evidence.

## Evidence

Run enough to independently support the verdict:
- targeted actual AuthProvider tests and reviewer Q1/S1-T probes;
- Kabumori app suite or focused + broad regression sufficient to catch provider/root regressions;
- relevant X regression if shared code is implicated;
- migration/source invariants only as needed to prove unchanged R1-R5;
- diff/secret/log scan;
- fresh merge-tree/overlap read-only check against current main.

## Report

Write `.agent/CODEX_REPORT.md` with:
- exact reviewed head;
- PASS or CHANGES REQUIRED;
- Q1 disposition;
- S1-T / TOKEN_REFRESHED disposition;
- prior-boundary regression disposition;
- independent test evidence;
- fresh-main overlap/merge-tree result;
- changed_files (review only);
- production mutation/deploy/EAS = 0;
- next recommendation.

If PASS:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

If finding remains:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-07

- Exact reviewed PR95 head: `ba35b642d30ce423a8683feffcd26aec325b45ee`; verdict **PASS** for the focused Q1 source review. No remaining blocker in this scope.
- Deferred current-owner check runs before generation/loading/acceptSession/transport. SIGNED_OUT, newer user B and same-user fresh A3 yield zero obsolete A2 requests; current A2 prepares once; same-login refresh preserves single-flight.
- Previous H1 scripts unchanged: 10/10 PASS. Additional reviewer Q1 supersession/control cases: 5/5 PASS. Two in-memory adverse variants are detected as expected (remove guard: 3 failures; user-only guard: A3 failure). No product patch.
- AuthProvider 23/23, Kabumori app 390/390, X 221/221, migration source invariants 11/11; X tsc/lint and diff check PASS. Accepted shared/X/SQL/root boundaries byte-unchanged; no repeated DB/production/native work.
- Fresh main `d648ec02` has zero product-file overlap; read-only merge-tree PASS. H1 changed only TASK/Report; production access/mutation/apply/merge/deploy/EAS = 0.
- C1 may judge source merge readiness. Production start-intent migration apply/read-back and native release are separate later approval gates. **STOP for C1**.

---

# Codex Task — CURRENT TASK

- task_id: common-account-v1-phase2-q1-final-rereview-20261007
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sol（高）
- target_pr: 95
- target_head: ba35b642d30ce423a8683feffcd26aec325b45ee
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Final focused rereview of PR #95 after G5 round 4. The only intended blocker is Q1: an obsolete Kabumori deferred auth-preparation task must not dispatch automatic service enrollment after a newer auth owner is announced.

## Required checks

- Fresh-fetch main and require exact PR #95 head `ba35b642d30ce423a8683feffcd26aec325b45ee`.
- Use an isolated H1 worktree from `/Users/yuya/Developer/kabumori-fresh`.
- Re-check fresh-main overlap. Allocation-time main has unrelated important-news-monitor changes plus .agent changes; overlap with PR #95's 17 files is zero.
- Verify deferred preparation compares its captured user+login owner (or equivalent ticket) with the synchronously announced current owner **before** generation/loading mutation, acceptSession/prepareSession, or enrollment transport dispatch.
- Reproduce:
  1. SIGNED_IN(A2) then SIGNED_OUT before A2 deferred work -> zero A2 automatic enrollment requests.
  2. SIGNED_IN(A2) then newer user B before A2 deferred work -> zero A2 requests; only B may prepare.
  3. Same-user fresh A3 supersedes A2 before deferred work -> zero A2 requests; only A3 may prepare.
  4. Normal current A2 -> exactly one preparation.
  5. Same-session TOKEN_REFRESHED -> retain safe single-flight/no duplicate.
- Re-run prior unchanged H1 probes for S1-T, S1/S2 and refresh control.
- Verify the synchronous auth-owner/readiness fence remains intact and no old login becomes ready.
- Verify R1-R5, PR94 root news-detail and X OAuth separation remain unchanged.
- No production access/write, migration apply, deploy, EAS, Phase3, Auth/Storage/OAuth/Vault/Cron/X/provider mutation.

## Evidence

G5 reports: Kabumori 390/390; AuthProvider 23/23; X 221/221; X tsc/lint PASS; both web exports PASS; start-intent DB runner 10 PASS markers; Phase1 20/20; migration invariants 11/11; unchanged H1 probes 10/10 PASS; mutation checks 11/11 detected.

Do not trust counts alone. Inspect the actual source and rerun the Q1 timing boundary.

## Verdict / completion

Return PASS, PASS-WITH-NONBLOCKING-NOTES, CHANGES REQUIRED, or BLOCKED.

PASS authorizes only C1 source merge/readiness judgment. Production migration apply and native release remain separate gates.

Write the result to `.agent/CODEX_REPORT.md`, set status `review_required`, next_owner `chatgpt`, and STOP for C1.

Recommended model: **Sol（高）**.

---

# Previous H1 task history — preserved

# Codex Task — CURRENT TASK

- task_id: common-account-v1-phase2-s1t-final-rereview-20261007
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- target_pr: 95
- target_head: 13f4281f9514742bdee43ffc08834fea67449bf2
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Perform one final focused re-review of the G5 round-3 correction on PR #95. The only intended blocker is S1-T: Kabumori AuthProvider must synchronously invalidate stale readiness when Supabase notifies a superseding login/user/sign-out, before deferred preparation runs.

## Required checks

- Fresh-fetch main and require exact PR #95 head `13f4281f9514742bdee43ffc08834fea67449bf2`.
- Use an isolated H1 worktree from `/Users/yuya/Developer/kabumori-fresh`.
- Re-check product-file overlap with fresh main. Allocation-time main is one commit past the PR base and that commit changes only `.agent/tasks/CLAUDE_TASK_5.md`.
- Verify auth callback synchronously records/fences the SDK-notified owner/login before any deferred task.
- Verify changed user/login/SIGNED_OUT immediately invalidates service-ready/generation and cancels obsolete enrollment without awaiting Auth/Data API/network calls.
- Verify result acceptance and serviceSession readiness are fenced by the synchronously current owner.
- Reproduce the prior H1 provider-event timing cases without weakening them:
  1. same user, fresh A2 session;
  2. different user B;
  3. SIGNED_OUT;
  release old A1 result before deferred work and require every serviceSession to stay null.
- Verify same-session TOKEN_REFRESHED control keeps intended single-flight and does not spuriously abort/restart.
- Verify old getSession results cannot override a newer synchronous auth notification.
- Verify reenroll cannot proceed from an obsolete owner/view.
- Preserve accepted boundaries: S2 X queued cancellation; userId+session_id context model; R1-R5; PR94 root news-detail; X OAuth separation.
- Do not apply the migration or touch production/deploy/EAS/Phase3/Auth/Storage/OAuth/Vault/Cron/X/provider state.

## Evidence to independently rerun

G5 reports:
- Kabumori app 390/390;
- AuthProvider 17/17;
- X 221/221;
- X tsc/lint PASS;
- both web exports PASS;
- start-intent DB runner 10 PASS markers;
- Phase1 lifecycle 20/20;
- migration invariants 11/11;
- previous H1 provider-event-window 3 cases + control PASS unchanged;
- former-probes 4/4 PASS;
- mutation checks 9/9 detected.

Do not trust counts alone; inspect actual source and reproduce the timing boundary.

## Verdict

Return PASS, PASS-WITH-NONBLOCKING-NOTES, CHANGES REQUIRED, or BLOCKED.

A PASS only authorizes C1 source merge/readiness judgment. Production migration apply and native release remain separate gates.

## Completion

Write the result to `.agent/CODEX_REPORT.md`, set status `review_required`, next_owner `chatgpt`, and STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-07

- Exact reviewed head: `13f4281f9514742bdee43ffc08834fea67449bf2`, PR95 OPEN/unmerged.
- Verdict: **CHANGES REQUIRED**, one P2 queued-preparation cancellation gap. Original S1-T stale-readiness window is corrected: previous unchanged 3 timing cases + refresh control all PASS; former S1/S2 probes 4/4 PASS.
- Two auth notifications before deferred preparation runs still dispatch the superseded login's automatic start after sign-out/new-user notification. Readiness stays fail-closed; this is not recurrence of old A1-ready or R1 silent reactivation.
- Minimum correction: check synchronously announced current owner before the deferred task advances generation or calls prepareSession; add SIGNED_IN(A2) -> SIGNED_OUT/B-before-task tests requiring zero A2 requests, retain refresh/current-owner controls.
- Shipped suites 390/17/221 PASS; X tsc/lint and both web exports PASS; local DB start-intent 10 / Phase1 20 PASS markers; migration invariants 11 PASS. Added actual-source probes 8 PASS / 2 FAIL (one cause); reviewer-only in-memory pre-dispatch guard makes both failures PASS. No product patch.
- H1 changed only its TASK/Report. Production access/mutation, migration apply, merge, deploy, EAS/native release = 0.
- STOP for C1. Focused corrective/re-review recommendation: **Sol（高）**; detail and reproducible evidence in `.agent/CODEX_REPORT.md`.

---

# Previous H1 task history — preserved

# Codex Task — CURRENT TASK

- task_id: common-account-v1-phase2-session-identity-final-rereview-20261007
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- type: focused auth/session cancellation security re-review
- target_pr: 95
- target_head: 1e8119e12457d9f6fbb8aef86991f44bf46f9cd6
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Re-review the second G5 corrective on PR #95. The only intended blockers are S1 same-user fresh-session reuse and S2 queued X enrollment after cleanup.

## Required checks

- Fresh-fetch main and require exact PR #95 head `1e8119e12457d9f6fbb8aef86991f44bf46f9cd6`.
- Use an isolated H1 worktree from `/Users/yuya/Developer/kabumori-fresh`.
- Verify runtime identity is `userId + stable login session_id`, not userId alone.
- Verify local token claim parsing is used only as an ephemeral session discriminator; malformed/missing/foreign-sub/session_id inputs fail closed, while the server still authenticates RPCs.
- Reproduce A1 explicit reactivation pending -> same user fresh A2 -> release A1 in both apps; A2 must not inherit consent/result or become ready.
- Verify same-login token refresh preserves safe single-flight.
- Verify X unmount/sign-out/superseded effect before queued dispatch sends zero obsolete enrollment requests.
- Verify normal X mount sends exactly once and existing in-flight stale-result suppression still works.
- Re-run enough R1-R5 regressions to ensure the prior server/RPC, strict payload, immutable Authorization, push-gate and cross-user fixes remain intact.
- Preserve PR #94 root news-detail and X OAuth separation.
- Current allocation-time main is three commits past PR merge-base, with changes only in .agent control files and zero product overlap; re-check at review time.
- No production access/write, migration apply, deploy, EAS, Phase3, Auth/Storage/OAuth/Vault/Cron/X/provider mutation.

## Evidence

Independently inspect/reproduce the reported G5 results: Kabumori 390/390, AuthProvider 10/10, X 221/221, DB start-intent runner 10 PASS markers, Phase1 20/20, migration invariants 10/10, and former S1/S2 adversarial probes now PASS.

## Verdict / completion

Return PASS, PASS-WITH-NONBLOCKING-NOTES, CHANGES REQUIRED, or BLOCKED.

PASS authorizes only C1 source merge/readiness judgment. It does not authorize production migration apply or native release.

Write the result to `.agent/CODEX_REPORT.md`, set H1 status `review_required`, next_owner `chatgpt`, and STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-07

- Exact reviewed PR #95 head: `1e8119e12457d9f6fbb8aef86991f44bf46f9cd6`; OPEN/unmerged at fresh read-back.
- Verdict: **CHANGES REQUIRED**. S1's old same-user cache reuse is corrected, but one P2 Kabumori auth-event/deferred-task window still admits stale A1 readiness after a changed-login/sign-out notification. S2 X queued cancellation is corrected/PASS.
- Shipped tests: Kabumori 390, AuthProvider 10, X 221; local DB start-intent 10 / Phase1 20 PASS markers; migration invariants 10; both web exports and X typecheck/lint PASS.
- Independent actual-source probes: former S1/S2 plus same-session controls 5 PASS; new timing variants 3 FAIL, one root cause. No product fix performed in H1.
- H1 changed only this TASK and `.agent/CODEX_REPORT.md`; production access/mutation, merge, deploy and native release = 0.
- C1: hold PR95; return the focused synchronous auth-owner/readiness fencing correction and the before-deferred-task regression to G5. Preserve same-login refresh single-flight and already-corrected S2. Recommended corrective re-review: **Sol（高）**.
- STOP for C1; detailed evidence and minimum correction are in the current H1 Report.

---

# Previous H1 task history — preserved

# Codex Task — CURRENT TASK

- task_id: common-account-v1-phase2-session-identity-final-rereview-20261007
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: critical
- recommended_model: Sol（高）
- type: focused auth/session cancellation security re-review
- target_pr: 95
- target_head: 1e8119e12457d9f6fbb8aef86991f44bf46f9cd6
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Independently review the second G5 corrective on PR #95 after C1 narrowed the remaining blockers to S1/S2.

Previously accepted and not to be reopened without concrete regression evidence:
- R1 server automatic-vs-explicit lifecycle semantics;
- R5 strict response validation;
- immutable captured-token Authorization transport;
- cross-user A -> B re-enrollment isolation;
- original Kabumori retry/push positive-ready gate;
- PR #94 root news-detail integration;
- X login/service-enrollment separation from posting OAuth/workspace/credentials/publish authority.

G5 reports S1 and S2 fixed on exact head `1e8119e12457d9f6fbb8aef86991f44bf46f9cd6`.

## Freshness / isolation

1. Read PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, ACTIVE_TASK, latest G5 Report, previous H1 reports, and this TASK.
2. Use a fresh independent H1 worktree/check-out from `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh-fetch origin/main and PR #95.
4. Require exact PR head `1e8119e12457d9f6fbb8aef86991f44bf46f9cd6`. If moved, STOP.
5. Current allocation-time main is 3 commits past PR merge-base `2f3b1ea9...`; those commits changed only `.agent/tasks/CLAUDE_TASK.md` and `.agent/tasks/CLAUDE_TASK_5.md`, with zero product-file overlap. Re-check freshness/overlap at review time.
6. No production access/write, migration apply, deploy, EAS, managed Auth/Storage/OAuth/Vault/Cron/X/provider mutation.

## Focus S1 — stable login-session identity

Verify the new session-context model is safe and actually closes the previous same-user fresh-login defect.

Independently inspect/reproduce:
- `loginSessionIdOf(userId, token)` derives only ephemeral local login identity and does not become an authorization source.
- JWT parsing is bounded/fail-closed: three segments/base64url decode, exact `sub === userId`, valid UUID `session_id`; malformed/missing/foreign-sub/session id fails closed and sends no enrollment request.
- Server still authenticates every actual RPC using the captured token; local unverified claim parsing must never substitute for server authentication.
- cache/single-flight, explicit reactivation intent, view state, result acceptance, Kabumori serviceSession and X ready state are keyed/validated by stable login context, not merely userId.
- A1 explicit ended reactivation held -> same Auth user fresh login A2 -> release A1: A2 must not become ready in either app and must not inherit A1 consent/result.
- sign-out -> same-user login and PASSWORD_RECOVERY/new-session variants behave similarly.
- already-sent A1 may finish under A1, but its result cannot certify A2.
- same-login token refresh with the same session_id does not cause unnecessary extra enrollment/re-enrollment or break single-flight.
- token/JWT/session identifiers are not logged or persisted.

Be alert for a false sense of security from parsing an unverified JWT locally. It is acceptable only as a cache/session-generation discriminator while the server validates the captured JWT on RPC.

## Focus S2 — queued X task cancellation before dispatch

Independently reproduce actual ServiceEnrollmentGate timing:
- mount/effect queued, then unmount before microtask flush -> zero enrollment request;
- sign-out before dispatch -> zero;
- same/different-user fresh-session supersedes effect before dispatch -> obsolete task sends zero, current task at most once;
- obsolete queued task cannot recreate gate/singleton state after cleanup;
- normal mount dispatches exactly once;
- existing in-flight abort/stale-result suppression remains correct.

Cancellation/current-context checks must happen **before** entering ensure/transport dispatch, not only after.

## Regression gates

Re-run enough existing evidence to ensure S1/S2 changes did not reopen earlier accepted boundaries:
- R1 service-start-intent SQL behavior/lock races;
- R2 cross-user and double-tap isolation;
- R3 Kabumori retry/push positive-ready behavior;
- R4 immutable Authorization/no mutable-current-token substitution;
- R5 strict malformed payload rejection;
- no `ensure_my_profile` active bootstrap bypass;
- X enrollment does not create OAuth/workspace/credential/publish state;
- PR #94 root news-detail remains preserved.

Review the unchanged forward migration source but do not apply it.

## Required evidence

Independently rerun/reproduce as practical:
- Kabumori app enrollment tests;
- actual AuthProvider-focused Node tests;
- X tests including actual ServiceEnrollmentGate;
- H1 prior adversarial S1/S2 reproductions with corrected fixtures;
- same-session refresh controls;
- X typecheck/lint;
- both web exports;
- service-start-intent local PostgreSQL runner;
- Phase 1 lifecycle regression;
- migration source invariants;
- git diff --check + secret/PII/log scan.

G5 reports at head 1e8119:
- Kabumori 390/390;
- AuthProvider 10/10;
- X 221/221;
- service-start-intent runner 10 PASS markers;
- Phase1 20/20;
- migration invariants 10/10;
- H1 former S1 X / S1 Kabumori / S2 probes now PASS.

Do not accept counts alone; validate actual source behavior.

## Verdict

Return one of:
- PASS
- PASS-WITH-NONBLOCKING-NOTES
- CHANGES REQUIRED
- BLOCKED

PASS means source is safe for C1 merge/readiness judgment only. It does **not** authorize production migration apply, native build/release, deploy, Phase 3, or production writes.

If blocker remains, do not edit product source in H1; report minimum correction.

## Completion / C1

Write `.agent/CODEX_REPORT.md` with:
- exact head;
- verdict/findings;
- S1 disposition;
- S2 disposition;
- local JWT/session-id parsing safety disposition;
- same-session refresh disposition;
- R1-R5 regression disposition;
- current-main/PR compatibility;
- tests/evidence;
- production mutation=0;
- merge recommendation;
- exact next action.

Then status -> review_required; next_owner -> chatgpt; STOP for C1.

Recommended model: **Sol（高）**.

---

# Previous H1 task history — preserved

# Codex Task — CURRENT TASK

- task_id: kabumori-pr99-editorial-specificity-focused-review-20261007
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna（高）
- type: focused runtime-delivery review / prompt specificity / WARN-only telemetry
- target_pr: 99
- target_head: cd33b1f22f532be9273d63f0f42f0a0d9c1de156
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Focused independent review of PR #99 after the 2026-10-06 natural close observation showed PR #87's three points were factually safe but too generic.

This review is intentionally narrow. Do not re-review unrelated market-report architecture.

## Freshness / isolation

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / G2 latest Report / this TASK.
2. Use a fresh independent H1 worktree/checkout from `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh-fetch origin/main and PR #99.
4. Require exact head `cd33b1f22f532be9273d63f0f42f0a0d9c1de156`; moved head => STOP.
5. Allocation-time check: PR open/unmerged; main is 3 commits ahead of PR base and changed-file overlap with the 10 PR files = 0. Re-check before verdict.
6. H2 owns PR #41 security review. Do not touch H2 files/worktree.

## Focus A — prompt specificity

Verify:
- copyable finished example sentences were removed from the model prompt;
- morning/close roles remain correct without rigid templating;
- day-specific concrete entities/events are required;
- generic headlines such as "ニュースを確認" are discouraged without creating a Hard delivery block;
- safely evidenced milestones/thresholds may appear in headlines;
- unsupported claims such as "史上最高" / "初めて" are not encouraged unless actually supported;
- morning does not assert completed Tokyo-session movement;
- close does not assert future outcomes.

## Focus B — WARN-only specificity telemetry

Verify:
- `X_POINTS_GENERIC:<n>` and existing `X_POINTS_*` remain telemetry/WARN only;
- generic detection does not become a Hard reject;
- generic detection does not itself trigger quality rewrite;
- concrete headlines with real entities/events/milestones are not obviously overflagged;
- the 10/6 observed generic three points are detected;
- metric-recap logic still treats normal value recaps as recap while allowing genuine milestone language.

## Focus C — rewrite threshold runtime semantics

This is the main reason for independent review.

PR #99 changes X-only shortness rewrite behavior so:
- `X_POST_SHORTER_THAN_TARGET` remains recorded below the target;
- only X output below 300 chars triggers rewrite based on X-shortness;
- omission/other quality conditions remain unchanged;
- App-story shortness behavior remains unchanged.

Independently verify:
- this reduces unnecessary calls rather than creating a new call path;
- a safe ~387-char X report can deliver without rewrite if App/other conditions are good;
- <300-char X still rewrites;
- missing required sections still rewrites;
- call ceiling remains generation 2 + Fact 2 = max 4;
- safe-original fallback remains intact;
- no condition accidentally turns short but materially incomplete X into accepted output when omission guards should catch it.

Treat this as a bounded delivery-policy change, not a reason to reopen Hard Fact design.

## Focus D — rejection diagnostics

Verify:
- `rejection_reasons` stores bounded fixed classifications only;
- no raw model body, quoted issue text, user content, secret/token, or unbounded strings are persisted;
- local/Fact rejection classifications are deterministic enough for false-reject diagnosis;
- schema migration is not required for the existing diagnostics jsonb;
- adding diagnostics does not alter accept/reject decisions.

## Focus E — Hard boundary / regressions

Confirm no Hard semantics changed:
- date/session/value/sign/stale;
- 1306 identity;
- refs;
- unsupported causality;
- false broad absence;
- exactly 3 points;
- safe-original fallback.

Run/inspect enough evidence for:
- new editorial specificity tests;
- editorial points/session-date/presentation/causal/quality regressions;
- market-report-analysis full suite;
- personalized/X shared/data-packet/shared regressions as appropriate;
- Deno check/lint on changed runtime;
- git diff --check.

Document pre-existing lint separately.

## Safety

Review only. No product-source fixes in H1.
Forbidden:
- PR merge;
- Edge deploy;
- manual report/retry;
- DB/RPC/migration/Cron/gate mutation;
- Auth/Vault/secret access;
- X/app notification;
- production access/mutation.

If a concrete blocker exists, return CHANGES REQUIRED to ChatGPT/G2.

## Completion / C1

Prepend to `.agent/CODEX_REPORT.md`:
- verdict PASS / CHANGES REQUIRED;
- exact reviewed head;
- freshness/no-overlap result;
- findings A-E;
- focused tests;
- rewrite-threshold judgment;
- diagnostics privacy/boundedness judgment;
- source changes by H1 = 0;
- production mutation = 0;
- merge recommendation;
- deploy recommendation;
- next recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Luna（高）**.

---

# Codex Task — CURRENT TASK

- task_id: common-account-v1-phase2-service-enrollment-corrective-rereview-20261006
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- type: focused auth/session/lifecycle-RPC/migration security re-review
- target_pr: 95
- target_head: dd065e16f64a37582f73d05f1ab57ff7d276a5f7
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Independently re-review the G5 corrective for Phase 2 common-account service enrollment after the prior H1 CHANGES REQUIRED verdict.

The previous blockers were R1-R5:
- R1 P1: stale automatic start could silently reactivate ended;
- R2 P1: explicit re-enrollment intent could cross user/session boundaries;
- R3 P2: Kabumori push/notification side effects could run before positive enrollment-ready;
- R4 P1: stale A work could dispatch using mutable singleton client credential for B;
- R5 P2: malformed active RPC payload could be accepted as ready.

G5 reports all five corrected on PR #95 head `dd065e16f64a37582f73d05f1ab57ff7d276a5f7`.
This re-review must independently verify those claims. Do not merge or deploy.

## Freshness / isolation

1. Read PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, ACTIVE_TASK, G5 latest Report, previous H1 report, and this TASK.
2. Use a fresh independent H1 worktree/check-out from `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh-fetch origin/main and PR #95.
4. Require exact head `dd065e16f64a37582f73d05f1ab57ff7d276a5f7`. If moved, STOP and report stale review target.
5. Confirm no directory/worktree is shared with G1-G5/H2.
6. Source/disposable-local review only. Production access/write, migration apply, deploy, EAS, Auth/Storage/OAuth/Vault/Cron/X mutation are forbidden.

## Review focus A — R1 automatic vs explicit lifecycle semantics

Review the new forward migration:
`supabase/migrations/20261006230000_common_account_service_start_intent.sql`

Verify at the actual SQL/lock/ACL boundary:
- existing automatic `start_kabumori_service()` / `start_x_autopost_service()` never reactivate a currently ended entitlement;
- missing -> create requested service only;
- active -> idempotent;
- deleting/suspended/provisioning/locked/deleting-account -> fail closed;
- ended -> reenroll_required with a valid lifecycle_version and no mutation;
- explicit `reactivate_*_service(bigint)` only reactivates currently ended when expected lifecycle_version matches;
- stale/replayed explicit intent cannot reactivate after version changes;
- non-ended or missing entitlement does not get silently created/reactivated by explicit reactivation;
- lock order, auth.uid identity, SECURITY DEFINER, fixed empty search_path, grants and API role exposure remain safe;
- the already-applied Phase 1 migration was not edited;
- old binary calls become safer/fail-closed, not silently reactive.

Use disposable PostgreSQL concurrency/race tests, including the exact former R1 reproduction.

## Review focus B — R2 one-use re-enrollment intent

Independently reproduce:
- A sees ended -> A explicitly taps re-enroll -> switch to B;
- no B reactivation request may occur without B action;
- double tap cannot issue reusable intent;
- sign-out/recovery/new session invalidates prior intent;
- stale completion cannot mark another user ready.

Check both Kabumori provider path and X ServiceEnrollmentGate.

## Review focus C — R3 positive-ready side-effect gate

Verify Kabumori push registration, pending-notification navigation and signed-in app tree use a positive service-ready state for the exact current session/user generation.

Reproduce:
- rejected -> retry pending -> rejected;
- during pending, push/session side-effect input remains null;
- stale success cannot reopen side effects for wrong user/session;
- password recovery/logout behavior remains valid.

## Review focus D — R4 immutable session-bound transport

Verify the enrollment/reactivation request Authorization is bound to the captured initiating session token and does not query the mutable shared Supabase client for a later token at dispatch time.

Reproduce:
- delayed A preparation -> switch to B -> release A => no RPC authenticated as B from A operation;
- sign-out while pending;
- token refresh for same user does not corrupt single-flight semantics;
- abort/invalidation happens before dispatch when possible;
- already-sent request response is ignored if stale;
- access tokens are never logged or persisted.

Also verify use of public Supabase URL/publishable key introduces no new secret exposure.

## Review focus E — R5 strict response validation

For both clients verify all canonical payload variants are validated structurally and fail closed:
- exact service;
- known status;
- required boolean fields such as started/shared_account;
- lifecycle_version safe integer where required;
- known reason values;
- exact/allowed key set.

Re-test missing/null/string/number/wrong-service/unknown-status payloads and ensure none opens the gate.

## Review focus F — regression / compatibility

Verify current main already contains PR #94 merge and PR #95 preserves:
- root `news-detail` navigation/swipe behavior;
- Auth/service-access gate;
- no legacy `ensure_my_profile` bootstrap bypass;
- X login remains separate from X posting OAuth/workspace/credential/publish authorization.

Re-check current main/PR changed-file overlap before verdict.

## Required evidence

Independently rerun or reproduce as practical:
- new service-start-intent disposable PostgreSQL runner and race cases;
- Phase 1 lifecycle regression suite;
- Kabumori app tests and real AuthProvider-focused Node tests;
- X tests including actual ServiceEnrollmentGate;
- X typecheck/lint;
- both web exports;
- migration source invariants;
- git diff --check and secret/PII scan.

G5 reported:
- Kabumori 387/387;
- AuthProvider 4/4;
- X 207/207;
- Phase 1 20/20;
- migration source invariants 10/10.
Do not merely trust these counts; independently inspect/reproduce enough to support the verdict.

## Verdict

Return one of:
- PASS
- PASS-WITH-NONBLOCKING-NOTES
- CHANGES REQUIRED
- BLOCKED

PASS means the corrected source candidate is safe to proceed to C1 merge/readiness judgment, **not** authorization to apply the new migration to production or release native apps.

If any blocker exists, do not modify product source in H1. Report the minimum correction back to G5.

## Completion / C1

Write `.agent/CODEX_REPORT.md` with:
- exact reviewed head;
- verdict/findings by severity;
- R1-R5 disposition individually;
- migration/ACL/lock/race disposition;
- session-bound transport and user-switch disposition;
- Kabumori side-effect gate disposition;
- X OAuth separation disposition;
- PR #94/current-main compatibility;
- test evidence;
- production mutation = 0;
- merge recommendation;
- exact next action.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-07 JST

- Exact reviewed head: `dd065e16f64a37582f73d05f1ab57ff7d276a5f7` (PR95 unchanged at final review fetch).
- Verdict: **CHANGES REQUIRED**. Prior SQL automatic-ended race R1 and malformed-response R5 are corrected. Original cross-user and retry-Push reproductions pass, but session/cancellation gates remain incomplete.
- Remaining blockers: **S1 P2**, both clients reuse an old explicit request/result for a fresh same-user login (`session_id` changes); **S2 P2**, X's queued automatic task dispatches after unmount/sign-out because cleanup is checked only after the request.
- Independent proofs: actual X TSX, actual Kabumori AuthProvider + lib/auth + shared domain, intercepted fake transport; 3 expected-safe assertions fail (S1 in two clients, S2), same-session single-flight control passes.
- Existing suites: Kabumori 387/387; AuthProvider 4/4; X 207/207; migration invariants 10/10; new SQL behavior/ACL/additive/5 race cases PASS; Phase 1 20 PASS markers. X typecheck/lint and both Web exports PASS. Kabumori app-only tsc retains 2 unchanged CSS-resolution diagnostics.
- PR94 merge is already in both current main and PR95; root news-detail is preserved. Final review main `676ce44b3d7f9282276428fbfee0dedc4ce4d385`; product changed-file overlap 0; merge-tree succeeds (no actual merge).
- Product source edit/push, production access/mutation/apply/deploy/EAS/Auth/Storage/OAuth/Vault/Cron/X operations: 0.
- Next: STOP for C1; ChatGPT returns focused S1/S2 correction to G5 and requests exact-head re-review. Recommended model: **Sol（高）** for C1/re-review. Source acceptance is not production migration or native release approval.

---

## H1 completion — 2026-10-07 JST

- result / verdict: **PASS-WITH-NONBLOCKING-NOTES** for exact PR #99 head `cd33b1f22f532be9273d63f0f42f0a0d9c1de156`.
- Freshness: final `origin/main` `e241c29feb27fefb8d4f58adc19ed5dee59b1d25`; target TASK still current; PR #99 OPEN/unmerged, exact head unchanged. Main/PR changed-file overlap: 0. `mergeable=UNKNOWN`, so do not claim GitHub mergeability.
- Review findings A-E: prompt specificity and morning/close constraints are consistent; generic specificity and milestone/recap checks are non-Hard telemetry; 430→300 semantics follow the bounded rewrite/fallback path; new rejection diagnostics persist fixed categories/counts only; reviewed hard-fact boundaries remain covered and unchanged.
- Tests: market-report-analysis **160/160 PASS**; personalized/X shared/data-packet regressions **22/22 PASS**; focused `deno check --no-config` on all six changed TS files **PASS**; `git diff --check` **PASS**. Lint passes with existing `require-await` excluded; default lint reports one pre-existing `analysis_test.ts:34` async-without-await warning, outside this PR's changed lines.
- Runtime probe: a safe 387-character packet delivered in 2 calls when no other rewrite condition applied; a <300-character draft actually took generate → Fact → generate → Fact, delivered generation 2; existing tests cover missing-section rewrites and safe-original fallback.
- Diagnostics/privacy: `rejection_reasons` labels are mapped to a fixed allowlist and capped at 160 characters; no raw rejected copy is retained. No schema migration required. Added public-market fixtures had no private-key/token/email-pattern matches.
- H1 source edits: 0. Production/DB/RPC/migration/Cron/Edge/manual report or X operations: 0. Merge/deploy: 0.
- Recommendation: **eligible for ChatGPT C1 merge-readiness decision only**. No merge/deploy recommendation beyond C1; a natural-cycle observation is still needed to assess model-output quality. STOP for C1.

# Previous H1 task history — preserved

# Codex Task — CURRENT TASK

- task_id: common-account-v1-phase2-service-enrollment-review-20261006
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- type: focused auth/session/service-enrollment security review
- target_pr: 95
- target_head: c06fac6492708331b6ba816122c9852cdcea73e7
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Purpose

Independently review Phase 2 common-account service enrollment wiring for both Kabumori and X social-mobile.

PR #95 changes authenticated-session bootstrap so each app enrolls the corresponding service through the already-reviewed lifecycle RPC boundary.

This review is mandatory because the diff crosses:
- Auth/session bootstrap
- both native apps
- lifecycle service-start RPCs
- fail-closed behavior for account/service lifecycle states

Do not broaden into Phase 3 deletion/enforcement implementation.

## Freshness / isolation

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / G5 report / this TASK.
2. Use a fresh independent H1 worktree from `/Users/yuya/Developer/kabumori-fresh`.
3. Fetch fresh origin/main and PR #95.
4. Require exact head `c06fac6492708331b6ba816122c9852cdcea73e7`. Head moved => STOP and report stale review target.
5. Confirm no H1 directory/worktree is shared with G1-G5/H2.
6. Review source only. No production access/write, no deploy, no EAS, no Auth/Storage/OAuth/Vault mutation.
7. PR #94 currently also changes `src/app/_layout.tsx`; review compatibility against its current head, but do not merge either PR. Re-check overlap/freshness before final verdict.

## Review focus A — canonical lifecycle RPC contract

Verify both clients use only:
- `public.start_kabumori_service()`
- `public.start_x_autopost_service()`

Verify:
- no direct client INSERT/UPDATE into common-account tables;
- no email merge/inference;
- return payload/service key/user state is validated fail-closed;
- unknown/malformed responses never become ready;
- Kabumori profile creation is not raced by legacy `ensure_my_profile`;
- X login does not create workspace/social account/OAuth state/credential/publish enablement.

Read the exact current migration/source definitions so review is against the server contract, not assumptions.

## Review focus B — lifecycle-state safety

Independently test/inspect:
- active entitlement -> idempotent ready;
- missing entitlement -> only that service is added;
- deleting / locked / suspended / provisioning / invalid-login / unknown -> fail closed;
- no legacy profile-only bypass in Kabumori;
- no OAuth/workspace shortcut in X.

### Ended / explicit reactivation — critical

G5 reports an acknowledged two-call pattern:
1. client observes ended;
2. user explicitly chooses to re-enroll;
3. client calls start RPC.

Determine whether a stale/racing request can silently reactivate an entitlement that became ended after the UI observation but before the start call.

Current Phase 2 source must satisfy the product contract:
**ended must never silently reactivate; reactivation must be tied to an explicit current user action.**

If the current client+RPC contract cannot guarantee this under the lifecycle states that Phase 3 will introduce, mark CHANGES REQUIRED and state the minimum safe correction. Do not dismiss a real race solely because no current production route creates ended yet.

## Review focus C — session concurrency / user switching

Verify:
- single-flight is scoped to the actual user/session;
- sign-out clears remembered state;
- switching from user A to user B cannot reuse A's success/error;
- transient failures are not cached as durable failure;
- retries cannot duplicate/corrupt lifecycle rows;
- token refresh/auth events do not cause unintended repeated state mutation;
- password recovery ordering is safe;
- stale async completion after sign-out/user switch cannot reopen app for wrong user.

Use adversarial tests where practical.

## Review focus D — Kabumori app gate

Verify:
- app cannot enter signed-in application tree until enrollment is ready;
- push registration/notification navigation do not proceed on rejected enrollment;
- profile-dependent code still works after start RPC;
- explicit re-enrollment UX is accurate and non-enumerating before auth;
- logout always remains possible;
- no old `ensure_my_profile` fallback remains in active session bootstrap.

## Review focus E — X app gate / OAuth separation

Verify:
- ServiceEnrollmentGate sits after auth/recovery but before user workspace data/onboarding;
- login alone does not touch X posting authorization;
- X OAuth remains explicit user action;
- rejection cannot be bypassed by onboarding/deep link;
- deletion/account-help route remains reachable as required;
- mock/preview behavior cannot leak into production;
- provider login (email/Google/Apple/X) all converge safely without storing provider tokens.

## Review focus F — PR #94 compatibility

PR #94 currently changes the same Kabumori `src/app/_layout.tsx` in another hunk.

At review time:
- fetch current PR #94 head;
- compare exact overlapping file;
- test both merge orders or an equivalent merge-tree proof;
- ensure combined behavior preserves both:
  - PR #94 root-level navigation/swipe contract;
  - PR #95 AuthGate/service-enrollment contract.
- If PR #94 is still moving, do not recommend blind merge. State the safe merge order/fresh rebase requirement.

## Review focus G — tests / build evidence

Rerun or independently reproduce relevant:
- Kabumori app tests including new enrollment tests;
- X tests including new enrollment tests;
- cross-app lifecycle DB fixture tests where practical;
- typecheck / web export / lint where configured;
- mutation/adversarial tests around unknown response, ended behavior, user switch, stale completion;
- git diff --check / secret scan.

Distinguish pre-existing diagnostics from PR regressions.

## Verdict

Return one of:
- PASS
- PASS-WITH-NONBLOCKING-NOTES
- CHANGES REQUIRED
- BLOCKED

PASS requires confidence that current Phase 2 source is safe to merge as source, while production deploy/enforcement remain separate gates.

Do not merge PR #95.
Do not deploy.
Do not modify product source in H1; if a blocker exists, return it to G5 for correction.

## Completion / C1

Write `.agent/CODEX_REPORT.md` with:
- exact reviewed head
- verdict
- findings by severity
- ended/reactivation disposition
- session concurrency/user-switch disposition
- Kabumori gate disposition
- X/OAuth separation disposition
- PR94 compatibility disposition
- test evidence
- production mutation = 0
- merge recommendation
- exact next action

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## Final C1 — PR #95 CHANGES REQUIRED accepted / H1 closed

- verdict: **ACCEPT H1 REVIEW / CHANGES REQUIRED**.
- exact reviewed PR #95 head: `c06fac6492708331b6ba816122c9852cdcea73e7`.
- PR #95 remains OPEN / unmerged / undeployed.
- C1 accepts all five findings:
  - R1 P1: automatic bootstrap can silently reactivate an entitlement that became ended after the client's read;
  - R2 P1: X explicit re-enrollment intent can be reused after user switch;
  - R3 P2: Kabumori push/notification side effects can run during pending retry before enrollment is positively ready;
  - R4 P1: stale enrollment work can dispatch with the singleton Supabase client's new user's credential;
  - R5 P2: malformed active RPC payload can be accepted as ready.
- no production incident is claimed; these are source-contract/security defects proven in isolated fixtures/harnesses.
- C1 rejects merge/deploy of current PR #95.
- PR #94 compatibility proof is accepted: only `src/app/_layout.tsx` overlapped, both merge orders produced the same tree, and combined Kabumori tests passed 392/392.
- PR #94 is now safe to land first; PR #95 correction must start from fresh main after that merge and preserve the root `news-detail` route.
- H1 source edits: 0; production mutation/deploy/EAS/Auth/Storage/OAuth/Vault/X = 0.
- H1 is done/free. A new focused H1 re-review will be allocated only after G5 produces a corrected exact head.
- recommended re-review model: **Sol（高）**.

---

## H1 completion — 2026-10-06

- Exact reviewed PR #95 head: `c06fac6492708331b6ba816122c9852cdcea73e7`; unchanged at final fresh fetch.
- Verdict: **CHANGES REQUIRED**; R1/R2/R4 are P1, R3/R5 are P2. See `.agent/CODEX_REPORT.md` for reproductions and minimum safe corrections.
- Ended silently reactivated after completed withdrawal in a disposable PostgreSQL fixture for both services; explicit current-user action is not guaranteed.
- Adversarial probes reproduce cross-user re-enrollment consent, stale request using the new user's SDK credential, pending-retry push gate bypass, and malformed active payload accepted as ready.
- Existing tests: Kabumori 352/352, X 157/157; combined latest PR94 + PR95 Kabumori 392/392. Both web exports and X typecheck/lint passed. Kabumori app-only tsc has two unchanged CSS-resolution diagnostics, no changed-file diagnostic.
- Final compatibility target PR #94: `97d374b48886ad33b61cd2288188d4b690e27a5c`; both merge-tree orders produce `00ab532dd8565c330d070bab369d622d45996ffe`. No actual PR merge.
- Product source changes: 0. Production access/mutation, merge, deploy, EAS, Auth/Storage/OAuth/Vault changes: 0.
- Next: STOP for C1. ChatGPT should return corrections to G5; no merge recommendation until corrected exact head passes focused re-review. Recommended model: **Sol（高）** for C1/re-review.

---

# Previous H1 task history — preserved

# Codex Task — CURRENT TASK

- task_id: kabumori-pr87-editorial-three-points-review-20261006
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna（高）
- type: focused source review / editorial presentation / shared consumer consistency
- target_pr: 87
- target_head: 3561f1eaac41df0f23dcce8fdaace0decc654a0a
- production_mutation_allowed: false

## Purpose

Review PR #87, which changes the market-report "today's 3 points" from metric recap lines into useful editorial headlines.

User intent:
- Morning: today's focus / risks / what to watch.
- Close: what happened today / supported drivers / why it matters / next watch.
- Numeric values should mainly live in supporting body/context, not dominate all three headlines.
- No clickbait and no unsupported market causality.
- X and App should show the same shared points for presentation v2.

This is a focused independent review. Do not broaden into unrelated market-report redesign.

## Freshness / isolation

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / G2 Report / this TASK.
2. Use a fresh independent H1 worktree/checkout. Do not share G1/G2/G3/G4/H2 directories.
3. New-Mac rule: any new checkout/worktree must derive from fresh `/Users/yuya/Developer/kabumori-fresh`, never old `/Users/yuya/Developer/kabumori`.
4. Fresh-fetch origin/main and PR #87.
5. Require exact review head `3561f1eaac41df0f23dcce8fdaace0decc654a0a`; if head moved, STOP.
6. Allocation-time fresh check: PR open/unmerged/mergeable=true; current main is 24 commits beyond PR merge-base with **0 overlap** across PR #87's 13 changed files. Re-check before final verdict.
7. H2 owns PR #76 security review. Do not touch H2 worktree/files.

## Review gates

### A — editorial contract
Verify:
- Morning points express today's focus / risk / watch axis, not a fake completed-session recap.
- Close points express what happened / supported drivers / significance / next watch.
- All three are not mere metric/value recaps.
- Exactly 3 points remains required.
- Points are meaningfully distinct rather than near-duplicate rewrites.
- No hard-coded theme/sector claims are introduced without input evidence.

### B — factual / causal safety
Confirm:
- Hard Fact decision logic is unchanged.
- Date/session/value/sign/stale/1306/ref/unsupported-causality/false-absence protections still apply to points.
- exporting `MARKET_NAMES` does not alter guard behavior.
- unsupported causal headlines remain rejected.
- honest uncertainty such as `主因は絞れず` remains allowed.
- Morning watch wording does not create new wrong-date/session assertions.

### C — delivery-first / model calls
Confirm:
- no new model call or hidden retry is introduced.
- generation/fact call ceiling is unchanged.
- `X_POINTS_METRIC_RECAP` and `X_POINTS_NEAR_DUPLICATE` are WARN/telemetry only and do not trigger quality rewrite.
- PR #77 delivery-first behavior and safe-original fallback remain unchanged.

### D — X/App shared truth
Trace:
- X uses `x_post.points_ja`.
- presentation-v2 App receives the same values via optional `market_detail.points_ja`.
- Home card prefers shared points when available.
- old/v1 stored reports retain prior fallback behavior.
- no App-only second market analysis or divergent interpretation is added.
- schema/type changes are additive and backward compatible.

### E — regression verification
Run/inspect enough to independently establish:
- editorial-points focused tests;
- market-report-analysis full/focused suite;
- session-date / H1 boundary / causal / quality / presentation regressions;
- personalized-reports;
- X shared consumer;
- App home-report-highlights;
- relevant data-packet/shared tests as needed;
- deno check/lint on changed runtime files;
- git diff --check.

Do not turn documented pre-existing lint/type debt into a new blocker.

## Safety

Review only. Do not modify PR #87 product source in H1.

Forbidden:
- merge PR;
- deploy Edge Functions;
- manual market-report invoke/retry;
- DB/RPC/migration write;
- consumer gate/Cron change;
- Auth/Vault/secret access;
- X post/API mutation;
- app notification;
- production mutation of any kind.

If source correction is needed, return CHANGES REQUIRED to ChatGPT/G2.

## Completion / C1

Prepend to `.agent/CODEX_REPORT.md`:
- verdict PASS / CHANGES REQUIRED;
- exact reviewed head;
- freshness/no-overlap result;
- findings A-E;
- tests;
- source changes by H1 = 0;
- production mutation = 0;
- merge recommendation;
- deploy recommendation;
- remaining risks;
- next recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Luna（高）**.

---

# Codex Task — CURRENT TASK

## H1 result — 2026-10-06

- verdict: **PASS** on exact PR #87 head `3561f1eaac41df0f23dcce8fdaace0decc654a0a`; see `.agent/CODEX_REPORT.md`.
- H1 source changes: 0; production mutation: 0.
- C1 is the next step. No merge, deploy, consumer activation, or production action was performed.

- task_id: common-account-gateb-managed-auth-final-review-20261005
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（極高）
- type: final managed-Supabase Gate B evidence review / Auth deletion / stale-session boundary / production migration gate
- production_mutation_allowed: false
- test_project_mutation_allowed: false

## Purpose

PR #70 / common-account Phase 1 の source は既に main へ merge 済み。
今回 ChatGPT + user が disposable hosted Supabase で Gate B を実施し、managed Auth / Storage / PostgREST の実挙動まで証拠を取った。

このTASKは **実装ではなく最終独立レビュー**。
「この証拠で Phase 1 migration の production apply gate を開けてよいか」を判定する。
production apply / backfill / Auth delete / Storage delete / project pause/restore は一切しない。

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / this TASK / prior common-account H1/H2 reports を読む。
2. 新Macでは `/Users/yuya/Developer/kabumori-fresh` の fresh origin/main を確認し、H1専用独立worktree/checkoutを使う。
3. G1/G2/G4/H2 の現行作業を触らない。特に H2 は G4完了後のX security rereview用に温存する。
4. production reads は必要最小限かつ read-only。PII/token/Vault plaintext を読まない。
5. paused disposable project や写真共有 project を勝手に再起動/Pauseしない。remote mutation 0。

## Accepted source baseline

Common-account Phase 1:
- original PR #70 merged source commit: `44121914b035e22380a4ca1bd8252a42713a2bbf`
- accepted fixed source commit before merge: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`
- target migration: `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`

Prior source/local tests:
- lifecycle 20 PASS
- mutations 46/46 DETECTED
- social-mobile deletion 8 PASS
- migration invariants 10/10 PASS

## Hosted Supabase Gate B evidence — 2026-10-05

Disposable hosted project:
- name: `common-account-gateb-20261005`
- ref: `wrmtvdgsxwmlzekvbmsa`
- fake data only; no production data/provider OAuth
- current disposition after proof: PAUSING / intended INACTIVE
- production `stock-x-autopost`: mutation 0
- photo-sharing `anohi-memories`: only temporary availability pause/restore; DB/Auth/Storage mutation 0

### A. Exact hosted migration apply
- production-shaped minimal fixture created in disposable project.
- exact merged migration `20261001150000_common_account_lifecycle_foundation.sql` applied through hosted Supabase migration path.
- result: SUCCESS.

### B. Real Data API / RLS / RPC / Storage proof
User ran fail-fast Phase A script and received:
- `GATE_B_PHASE_A_PASS`

That PASS requires all of these to have succeeded:
- authenticated own `common_accounts` read = allowed
- authenticated cross-user read = denied / zero rows
- authenticated direct write = denied
- anon direct read = denied
- service-role direct table read = denied
- service-role SECURITY DEFINER RPC boundary = works
- real hosted Storage API upload by fake authenticated user = works
- managed Storage ownership causes `prepare_common_account_auth_delete` to fail closed
- object removed via Storage API, not SQL
- after cleanup, readiness becomes `ready_for_managed_auth_delete`

### C. Direct common row deletion guard
ChatGPT executed hosted SQL while fake Auth user still existed:
- direct DELETE of `public.common_accounts` rejected with expected foreign-key-class error / `COMMON_ACCOUNT_ROW_DELETE_REQUIRES_LOGIN_REMOVAL`
- common-account row remained present
- observer did not falsely mark login removed

### D. Real Auth Admin hard delete
User ran fail-fast Phase B and received:
- `GATE_B_PHASE_B_PASS`
- `old access JWT Data API: ALLOWED`

Phase B PASS requires:
- real Auth Admin API hard delete = success
- `/auth/v1/user` with deleted user's token = rejected
- refresh token after deletion = rejected
- old already-issued access JWT was still accepted by Data API before expiry

This reproduces the known stale-JWT hazard on actual hosted Supabase.

### E. Hosted post-delete DB read-back
After real Auth Admin delete, ChatGPT read back:
- auth.users: 0 for deleted fake user
- auth.identities: 0
- auth.sessions: 0
- auth.refresh_tokens: 0
- public.common_accounts: 0
- public.service_entitlements: 0
- lifecycle `login_removed` operation: 1
- same operation preserved `ready_for_managed_auth_delete` -> `login_removed` observation: 1

This proves managed Auth cascade + observer boundary on hosted Supabase.

## Critical security conclusion to review

Actual hosted behavior proves:
- deleting Auth user does **not** immediately invalidate already-issued access JWT for Data API authorization.
- therefore the future common-account orchestrator must complete and attest **session revocation before Auth hard delete**.
- Phase 1's built-in `session_revocation` checkpoint is therefore not optional.
- a future destructive orchestrator must not treat "Auth row deleted" as sufficient session invalidation.

Review whether current Phase 1 remains safe specifically because it **does not itself perform managed Auth deletion** and does not claim whole-account deletion complete.

## Final gates

Independently review source + recorded evidence and answer:

1. Does hosted evidence close the previous Gate B managed-boundary unknowns enough for Phase 1 migration apply?
2. Is stale-JWT behavior correctly contained by the current Phase 1 contract, or is a source blocker still present before even installing the additive foundation?
3. Does observer behavior remain observational only and non-authorizing?
4. Do RLS/grants/Data API results match intended least privilege?
5. Does service-role table denial + RPC-only boundary match source grants?
6. Does Storage ownership fail closed until API cleanup?
7. Does managed Auth delete produce the intended cascade + durable operation observation?
8. Is any rollback/reapply or PostgREST error-mapping proof still materially required before production apply, or can it be deferred because Phase 1 is additive/non-destructive and exact hosted apply succeeded?
9. If production migration apply can proceed, specify exact preflight/apply/read-back sequence and STOP conditions.
10. Backfill must remain a **separate explicit approval** after migration read-back.

## Safety / forbidden

- no production mutation/apply/backfill/deploy
- no production Auth user operation
- no Storage/Vault/provider OAuth mutation
- no pause/restore of any Supabase project
- no recreation of hosted destructive proof unless ChatGPT/user explicitly authorizes it
- no source implementation in H1
- if a source blocker is found: report CHANGES REQUIRED and return to ChatGPT/G5

## Completion / C1

Append to `.agent/CODEX_REPORT.md`:
- task_id
- verdict: PASS / PASS-WITH-CONDITIONS / CHANGES REQUIRED
- exact source reviewed
- disposition for each final gate
- stale-JWT security implication
- whether Phase 1 production migration apply may proceed to a **separately authorized mutation gate**
- exact rollout/read-back checklist
- whether backfill remains HOLD
- remaining issues
- production reads
- production mutations = 0
- test/photo project mutations = 0 from H1
- recommended next model

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

Recommended model: **Sol（極高）**.

## H1 completion — 2026-10-05

- verdict: **PASS-WITH-CONDITIONS** for Phase 1 foundation installation only, not deletion activation or production execution authority.
- exact accepted SQL remains byte-identical to `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65` / merged `44121914b035e22380a4ca1bd8252a42713a2bbf`; SHA256 `e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3`.
- recorded hosted Phase A/B + cascade read-back close the installation-level managed-role/RLS/Storage/Auth observer unknowns. H1 reviewed that recorded evidence; it did not rerun hosted destructive scripts or certify unprovided raw scripts/transcripts.
- critical clarification: session/global sign-out revokes refresh/session state, NOT an already-issued access JWT. Future destructive orchestration must additionally close the stale-token writer window (live session/lifecycle authorization or an independently proven bounded-expiry/quiescence policy), then revalidate Storage and readiness. Checkpoint presence is not evidence that this has happened.
- observer remains shadow-only and non-authorizing; no Phase 1 Auth/Storage deletion or account-deletion completed state. Existing legacy deletion routes remain unchanged/unsafe.
- minimal production metadata: target history/relations/functions absent; no API-to-postgres membership; no unexpected apply-owner default grantee in the inspected scope. Full fresh pre-apply dependency/ACL/API/apply-path checks remain mandatory.
- disposable test project read-only status: INACTIVE. No resume/pause/restore attempted.
- production migration may advance to C1's separately authorized exact-single-file mutation gate, with explicit apply/history failure policy. Backfill, rollback, enforcement, deletion/registration wiring and deploy remain HOLD/separately authorized.
- this turn: source invariants 10/10, runner syntax and diff checks PASS; prior local 20 / 46 / 8 results remain prior evidence, not reruns.
- production/test/photo mutations = 0; source changes = 0. Full gate dispositions/checklist appended to CODEX_REPORT. STOP for C1; recommended next model Sol（極高）.


## Final C1 — 2026-10-06

- verdict: **PASS-WITH-CONDITIONS ACCEPTED** for the common-account Phase 1 additive foundation.
- hosted Gate B evidence is accepted for installation scope.
- stale access JWT remained usable against Data API after Auth deletion; future destructive orchestration must close stale-token writer paths beyond session/refresh revocation alone.
- observer remains observational/shadow-only and does not authorize deletion or claim whole-account completion.
- Phase 1 production migration may proceed only through a separately approved exact-single-file mutation gate after fresh full preflight and a pinned apply/history failure policy.
- ordinary db push, include-all migration, history repair/relabel, blind reapply, ad-hoc GRANT repair, automatic rollback, enforcement/deletion activation are not authorized.
- backfill(true) remains HOLD and requires separate explicit approval after migration read-back and fresh backfill(false) parity review.
- production mutation by C1: 0.
- next recommended model for the production migration mutation gate: **Sol（極高）**.

---

# Previous H1 task history — preserved


- task_id: ai-lab-pr82-production-readonly-preflight-20261005
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: production read-only preflight / migration-ledger / catalog-ACL / rollout-order certification
- source_pr: 82
- merged_main_sha: 80e11c9207d44599db26a25195f1ee0091484231
- accepted_source_head: 9d30a68317dd523a96e6ce96bf7a0f6de23235d5
- production_mutation_allowed: false

## Purpose

PR #82 の source review は Final C1 PASS-WITH-FIX accepted、CI green後に squash merge 済み。

このTASKは **production反映前のread-only preflightだけ** を行う。
migration apply / Edge deploy / Cron変更 / 実X / Vault plaintext / token refresh / production write は一切しない。

C1で残した production gate を、実際の現在production状態に照らして「安全に適用できるか」「適用順は何か」「どこでSTOPすべきか」まで確定する。

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / this TASK / Final C1 / H1 final report を読む。
2. 新Macでは `/Users/yuya/Developer/kabumori-fresh` の fresh origin/main を確認し、H1専用の独立worktree/checkoutを使う。他slot worktreeを共有・reset・rebase・削除しない。
3. mainに PR #82 squash merge SHA `80e11c9207d44599db26a25195f1ee0091484231` が含まれることを確認する。source差分を勝手に追加修正しない。
4. H2 PR #76 / G3 PR #81 は並行中。彼らのmigration/RPC/Edge/agent filesを変更しない。
5. production readsは必要最小限。PII/user content/token plaintextは読まない。

## Gate A — production migration ledger / collision

Read-onlyで確認:
- `20261004090000_ai_lab_topic_claims` がproduction migration ledgerに未適用か、既適用なら exact 状態を報告してSTOP。
- superseded `20261003090000_ai_lab_topic_event_usage` がproductionへ適用されていないこと。存在する場合は勝手にrepairせずSTOP。
- PR #76 `20261003090000_social_mobile_publish_permission_boundary`、PR #81 `20261003120000_social_mobile_content_settings_hardening` とのversion/name collisionがないこと。
- current production ledgerとfresh main sourceの整合。

## Gate B — production catalog preconditions

PR #82 migrationが触る対象についてread-only catalog確認:
- relation / index / constraint / policy / trigger / function signatures
- relation/function owner
- RLS flags
- function security/search_path
- effective EXECUTE/table privileges
- column ACL
- unexpected same-name object/overload
- API rolesとownerのrole-membership継承関係

migrationが「新規作成前提」なら、productionに対象objectが既に存在しないことを明示的に証明。
存在する場合は migration のfail-closed条件と照合し、applyせずSTOP判定。

Vault secret値・token値は読まない。

## Gate C — exact migration apply semantics

実際にproductionで使う予定のapply経路について、以下をsource/toolingレベルで証明:
- migration 1ファイルがtransactionalに適用されるか
- BEGIN/COMMITの実際の境界
- failure時に部分DDL/ACLが残らないか
- migration history記録のタイミング
- apply後のread-back項目
- rollbackを「安易なdown migration」で行わず、失敗時の安全な停止点

production apply自体はしない。

必要ならlocal disposable PostgreSQLで exact merged migration を clean apply / reapply / rollback-on-failure まで再確認してよい。

## Gate D — deploy target / rollout order

merged mainから、PR #82によってproductionへ反映が必要な **正確なFunction/deploy target** を特定する。

確認:
- migrationを先にする必要があるか
- deployを先にするとfail-open/fail-closedどちらになるか
- shared moduleをimportするdeploy target一覧
- scheduler/Cron変更が必要か（原則不要のはず。必要ならBLOCK）
- deploy後のread-back方法
- old/new function version/source byte確認方法
- real Xを使わずにできるpost-deploy smoke/readiness確認
- natural-cycle観察をする場合の安全条件

実X投稿、manual scheduler invoke、backlog/candidate injectionは禁止。

## Gate E — production safety snapshot

変更前のread-only baselineとして必要最小限を記録:
-対象Function version/status/verify_jwt等
- 対象Cron/scheduleの存在と変更不要性
- AI Lab publish gate / relevant setting の現在状態（値を変更しない）
- migration対象objectの有無
- role/ACLの必要なmetadata

秘密・ユーザー投稿本文・token・Vault plaintextは記録しない。

## Completion / C1

Report:
- task_id / verdict
- fresh main SHA
- production migration ledger result
- superseded migration presence/absence
- catalog/owner/effective ACL result
- exact apply transaction semantics
- exact deploy target(s)
- required rollout order
- pre/post read-back checklist
- blockers / remaining risks
- production reads performed
- production mutations = 0
- real X/Vault plaintext/token operations = 0
- whether production rollout may proceed to a separately authorized mutation gate
- recommended model for mutation gate

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

Do not create/apply/deploy anything.

## H1 preflight completion — 2026-10-05

- result: **PREFLIGHT COMPLETE / PRODUCTION ROLLOUT HOLD**. Target catalog/owner prerequisites pass; the exact production apply path still needs a separately reviewed decision.
- merged source `80e11c9207d44599db26a25195f1ee0091484231` is in main; migration SHA256 `30d8504173160f1dc9c3d7d1cf323d9890129d1ff117c2448aa1b2516629c09c`.
- production target/superseded migration ledger entries and objects: absent. API-to-postgres ownership membership: false. No target version/name collision.
- actual CLI 2.116.0 + exact SQL local proof: clean/reapply pass; pre-COMMIT ACL failure leaves no target DDL/history; history INSERT failure after authored COMMIT leaves complete target DDL without history. This boundary must not be called schema+ledger atomic.
- isolated one-file migration-up against an existing unmatched ledger rejects before apply. Production/source history is not globally aligned; no include-all, repair, bulk push, or history rewrite attempted.
- exact deploy target: `x-test-post` only, after approved migration + catalog/API read-back. Baseline ACTIVE v133, verify_jwt=false; production does not yet contain the topic-claim path.
- live AI Lab / active Cron require no manual POST smoke, old-worker drain and no overdue backlog at cutover; empty new ledger does not dedupe already-posted historical diary events.
- source/runtime changes: 0; production mutations/deploy/X/Vault plaintext/token/refresh/Cron changes: 0. Local proof DBs cleaned and own cluster stopped.
- full evidence and pre/post checklist appended to `.agent/CODEX_REPORT.md`.
- next: C1 decides the exact single-file apply mechanism and schema/history failure policy before requesting any production authority. Recommended C1 **Sol（高）**; future mutation gate **Sol（極高）**. STOP here.

---

# Previous H1 task — preserved history

- task_id: ai-lab-pr82-final-boundary-rereview-20261005
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused final rereview / provider outcome proof / claim quarantine / migration ACL-owner / canonical payload
- target_pr: 82
- target_head: 51457826ea6c29d9c94ac0066786df8927fa1274
- previous_bad_head: 9f3b19a3cde490cf63735220ae191dcd4f11bdcb
- production_mutation_allowed: false

## Purpose

PR #82 の前回C1残件を独立再レビューする。

Previous core design already materially improved:
- durable pre-X claim
- provider_started boundary
- claim_id fencing
- ordinary two-worker diary race closure
- confirmed-X settle failure does not reopen event

This rereview focuses only on the residual boundaries that previously caused CHANGES REQUIRED:
1. duplicate scalar event_id labels
2. unsafe owner / inherited effective privilege drift
3. real Vault-path 401 no-post classification
4. unresolved evergreen becoming reusable by age
5. cooldown measured from claim instead of publish
6. malformed/non-canonical RPC candidate payload
7. net-new lint debt

PASS only if those are independently closed **without regressing the previously accepted concurrency/fencing behavior**.

No merge, migration apply, Edge deploy, production write, real X/Vault/token/OAuth/Cron mutation.

## Mandatory startup

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / previous H1 reports.
2. Independent H1 worktree.
3. Fresh origin/main.
4. Confirm PR #82 exact head `51457826ea6c29d9c94ac0066786df8927fa1274`. If moved, STOP.
5. Fresh ChatGPT check:
   - PR open / unmerged / mergeable=true
   - 14 changed files
   - Netlify/Vercel success
   - main is 13 commits ahead of PR base
   - overlap with PR #82 changed files = **0**
6. G3 PR #81 and G4 PR #76 are active separate workstreams. Do not touch their files/worktrees.
7. Check migration timestamp collision fresh:
   - PR #82 uses `20261004090000_ai_lab_topic_claims.sql`
   - PR #76 uses `20261003090000_social_mobile_publish_permission_boundary.sql`
   - PR #81 uses `20261003120000_social_mobile_content_settings_hardening.sql`
   No collision is expected.

## Gate A — duplicate event_id identity

Use the actual runtime parser/sanitizer/candidate builder and the actual workflow validation logic.

Must prove:
- exactly one event_id label per diary entry is required;
- zero labels -> invalid;
- two valid labels in one entry -> invalid, no last-wins behavior;
- duplicate scalar labels for changed/difficulty/decided/etc follow the intended same contract;
- duplicate label entry produces **zero runtime candidate**;
- workflow fails before snapshot generation;
- reordering/body/angle edits do not change a valid existing event_id;
- fresh main diary content from topic-detail-learning is preserved exactly except intentional event_id metadata;
- snapshot matches canonical markdown deterministically.

Re-run the previous H1 duplicate-label RED evidence against the new actual workflow and runtime, not just a copied parser.

## Gate B — provider outcome classification / actual Vault wrapper

Review new:
`supabase/functions/_shared/brand/ai_lab_provider_outcome.ts`

This is a critical gate.

The candidate claims no-post is proven only when:
- no X request was made at all, or
- every X response was one of 400/401/422/429.

Independently verify with the **actual VaultAccountXAuth.send contract** and fake request callbacks:
- pre-request credential/token failure -> no request observed -> releasable only if truly no X write path started;
- genuine X 400/401/422/429 -> AiLabProviderNoPostError;
- 401 transformed by VaultAccountXAuth into `X_ACCESS_TOKEN_UNAUTHORIZED` / `X_ACCESS_TOKEN_REJECTED_AFTER_REFRESH` still carries request-observation proof and releases safely;
- first request 401 + refresh + second request success -> success, not release;
- first request 401 + second request 401 -> proven no-post only if both are actual X non-write responses;
- any timeout/network throw/response-read failure -> ambiguous;
- 403 -> ambiguous;
- 408 -> ambiguous;
- 3xx -> ambiguous;
- 5xx -> ambiguous;
- mixed responses where any attempt is uncertain -> ambiguous;
- a local/proxy/generated error code must never become proven no-post solely by message text.

Inspect whether 400/401/422/429 are actually safe non-create outcomes for the exact X create-post endpoint/wrapper behavior represented here. If status semantics cannot prove that, do not PASS on assumption.

No real token refresh/X call.

## Gate C — dispatcher release/quarantine integration

Actual dispatcher order:
claim -> generate/guards -> startProvider -> sendAiLabXPost -> release/ambiguous/published -> completion.

Verify:
- only `AiLabProviderNoPostError` causes post-provider release;
- generic Error string cannot cause release;
- markAmbiguous failure leaves provider_started (still blocked);
- settlePublished failure leaves provider_started (still blocked);
- completion failure never reopens event and never routes confirmed X to retry;
- pre-X failures still release only own fenced claim;
- failed startProvider never reaches X.

Re-run previous accepted two-worker diary concurrency and fencing controls to prove no regression.

## Gate D — unresolved evergreen quarantine

Use actual SQL, not an in-memory approximation.

For an evergreen seed and overlapping theme:
- `claimed` within lease blocks;
- expired claimed can be reclaimed;
- `provider_started` blocks same seed indefinitely, regardless of 73h/7d/long aging;
- `ambiguous` blocks same seed indefinitely;
- unresolved same-theme seed also blocks other evergreen candidate with overlapping canonical tag;
- unresolved row must not become reusable just because claimed_at/provider_started_at is old;
- published is the only state that enters ordinary reusable cooldown semantics.

Explicitly repeat the previous H1 73h time-simulation. It must now stay at one fake X / no replacement claim.

## Gate E — publish-time cooldown

Verify with actual SQL:
- same published seed blocked until 72h after **published_at**;
- same generic theme blocked until 48h after **published_at**;
- old claimed_at cannot shorten cooldown;
- published_at is server-owned/settlement-owned and cannot be supplied by candidate payload;
- after >72h seed may re-enter if no unresolved quarantine exists;
- after >48h overlapping theme may re-enter subject to seed rule;
- released/expired pre-X rows do not consume cooldown.

Try edge times around 72h/48h boundaries.

## Gate F — canonical candidate payload

Review `claim_ai_lab_topic`.

Must prove:
- candidates array bounded;
- every candidate fully validated **before** any state mutation;
- exact keyset only: kind/event_key/unit_key/theme_tags;
- extra key -> reject entire call with zero side effects;
- duplicate event key -> reject entire call;
- evergreen seed must be from canonical pool;
- evergreen unit_key exactly equals event_key;
- evergreen theme_tags exactly match canonical DB mapping, not caller-supplied truth;
- wrong/missing/extra tags -> reject;
- diary event_key syntax exact;
- diary unit relationship exact:
  changed/difficulty/decided/angleN only;
- diary theme_tags must be empty;
- malformed later candidate cannot leave an earlier claim inserted;
- no post text/body stored.

Compare DB canonical evergreen mapping against the TypeScript `EVERGREEN_THEME_TAGS` source. Any drift is a blocker unless a single source of truth or executable parity test guarantees equality.

## Gate G — owner / role inheritance / effective ACL

Review migration preflight and postconditions independently.

The intended policy is:
- table + five claim functions owned by migration owner;
- migration owner is not anon/authenticated/service_role/authenticator;
- API roles are not members of migration owner;
- direct table privileges remain none for app/API roles;
- only service_role may EXECUTE the five narrow functions;
- no effective TRUNCATE/REFERENCES/TRIGGER/MAINTAIN or unintended table privilege via inheritance/ownership.

Test local role graphs:
1. expected clean owner -> migration succeeds.
2. existing table owner = service_role -> fail.
3. existing function owner = anon/authenticated/service_role -> fail.
4. service_role inherits owner -> fail.
5. authenticated inherits owner -> fail.
6. nested membership chain to owner -> fail if PostgreSQL effective privilege allows owner powers through it.
7. unexpected function EXECUTE grantee -> fail or deterministically normalize only if explicitly designed.
8. unexpected table grant -> postcondition must close or reject per documented policy.
9. PG17 MAINTAIN included.
10. column ACL remains none.

Do not modify role graph in migration.

Critically inspect use of `pg_has_role(role, current_user, 'MEMBER')`: prove argument direction and transitive behavior are correct for the intended “API role can become owner role” test.

## Gate H — migration drift/idempotency

Clean apply + reapply must pass.

Adversarially mutate:
- missing/wrong PK
- wrong partial UNIQUEs
- wrong evergreen index
- missing CHECK
- wrong RLS flag
- unexpected policy
- unexpected trigger
- column ACL
- owner drift
- function overload/signature
- function owner
- function EXECUTE ACL.

Migration must fail closed on incompatible same-name objects.

Check transaction/rollback on failure.

## Gate I — lint / static quality

Verify:
- changed test files no longer add net-new `require-await` debt;
- no broad lint disable introduced;
- changed runtime helpers check/lint clean;
- x-test-post baseline diagnostics are unchanged from fresh main;
- git diff --check clean;
- no secrets/internal IDs in event IDs/logs.

Do not require unrelated main lint debt to be fixed.

## Gate J — existing safety / other brands

Confirm no regression to:
- exact/cross-brand fingerprint dedupe;
- content diversity guard;
- AI Lab max attempts;
- scheduled-post completion behavior;
- other X brands;
- Kabumori morning/close;
- OAuth/token semantics;
- Cron/scheduler;
- common account;
- G3/G4 workstreams.

No additional OpenAI call.

## Required tests

Run independently:
- full PR #82 focused checked suites;
- actual H1 previous RED boundary cases;
- actual workflow duplicate-label validator;
- actual VaultAccountXAuth fake 401/refresh matrix;
- dispatcher provider-outcome tests;
- two-session SQL claim concurrency;
- lease/fencing;
- 73h unresolved evergreen quarantine;
- publish-time cooldown edges;
- malformed candidate JSON matrix;
- owner/inheritance ACL matrix;
- migration drift matrix;
- full relevant Functions runtime tests;
- changed runtime Deno check/lint;
- changed test lint;
- SQL runner;
- git diff --check / secret scan.

Candidate reported:
- Functions 2543/2543 PASS
- SQL 132 PASS
- SQL mutations 15/15 detected
- TS mutations 15/15 detected
Treat these as claims to independently verify, not proof by themselves.

## Production

No production mutation.
Optional read-only only if required to validate rollout compatibility:
- owner/default ACL/membership graph
- target object existence
- migration ledger collision.

No content/PII/token/Vault reads.

## Verdict

PASS only if all previous residual C1 blockers are closed and prior concurrency/fencing guarantees remain intact.

PASS-WITH-FIX only for a truly bounded review fix with full rerun.

CHANGES REQUIRED if:
- any duplicate event_id path revives identity;
- no-post classification can release an uncertain X attempt;
- unresolved evergreen can re-enter by age;
- caller can lie about canonical themes/payload;
- role ownership/inheritance leaves effective unsafe privilege;
- prior two-worker/fencing bug regresses.

## Report

Append to `.agent/CODEX_REPORT.md`:
- verdict
- reviewed exact head
- duplicate event_id result
- provider outcome proof
- dispatcher release/quarantine result
- evergreen unresolved result
- publish-time cooldown result
- canonical payload result
- owner/inheritance/ACL result
- migration drift/idempotency
- previous concurrency/fencing regression
- lint/static result
- tests
- production reads/writes
- source fix if any
- merge recommendation
- rollout ordering recommendation.

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-05

- result: **PASS-WITH-FIX**, conditional on adopting the two bounded corrections; unchanged PR #82 head is not an unconditional PASS.
- reviewed exact PR head: `51457826ea6c29d9c94ac0066786df8927fa1274`; PR remains open/unmerged and its branch was not changed.
- corrected source/evidence head: `9d30a68317dd523a96e6ce96bf7a0f6de23235d5`, pushed/read-back on `codex/h1-pr82-final-20261005`.
- findings fixed: checked Vault fixture resolver type (P3); invalid/not-ready/live index catalog drift detection (P2).
- independent tests: focused checked 104 PASS; relevant Functions runtime 914 PASS; SQL runner 132 PASS; H1 boundaries 41 PASS; actual workflow regression 49 PASS. Counts overlap and must not be summed as unique tests.
- static: four changed runtime helpers check PASS; nine changed TS files lint PASS; full entrypoint has the same six check errors / three lint diagnostics as fresh-main source.
- production reads/writes/deploy/merge/X/OAuth/token/Vault/Cron mutation: 0.
- details: appended final-boundary review in `.agent/CODEX_REPORT.md`.
- next: C1 accepts/adopts the correction head, then decides source merge and separately authorized rollout. Recommended model: **Sol（高）**. STOP here; shared indices remain C1-owned.

---

# Codex Task — CURRENT TASK

- task_id: ai-lab-pr82-claim-rereview-20261004
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused rereview / durable pre-X claim / migration / crash safety
- target_pr: 82
- target_head: 9f3b19a3cde490cf63735220ae191dcd4f11bdcb
- previous_bad_head: 08a7346ccd63f2ff540bd48149f1f1e65e6dbe09
- production_mutation_allowed: false

## Purpose

前回C1でCHANGES REQUIREDとなったPR #82の修正版を再レビューする。

今回の修正は、単なるusage記録ではなく:
- stable `event_id`
- pre-X durable claim
- provider_started / ambiguous / published state
- fencing token
- evergreen cooldownのDB強制
- migration drift fail-closed
へ設計変更されている。

目的は「同じ実開発eventの言い換え連投」を、並行実行・DB失敗・process crash・X応答不明まで含めて本当に閉じたか確認すること。

**merge / migration apply / Edge deploy / real X / production writeは禁止。**

## Mandatory startup

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / previous H1 reportを読む。
2. independent H1 worktree。
3. fresh origin/main。
4. PR #82 exact head `9f3b19a3cde490cf63735220ae191dcd4f11bdcb` を確認。違えばSTOP。
5. K3/C1後の他slotを確認。H2はPR #81 review結果待ち、G3/G4は別workstream。触れない。
6. fresh comparison。ChatGPT確認時点ではmainはPR baseから3 commits ahead、PR #82の13ファイルとのoverlap 0。
7. migration timestamp/order collisionもfresh確認。

## Gate A — previous P1: concurrent same-event publish

最重要。

2 worker / 2 scheduled_post が同時に同じ diary event を狙うケースを、実SQL + dispatcher harnessで再現する。

必須:
- 同じ候補リスト
- 同じevent
- 同時claim
- advisory lockが効く
- active diary event partial UNIQUEが効く
- 勝者だけclaimを取得
- 敗者は同eventでXへ進めない
- 長いDB transactionをX跨ぎで保持していない。

advisory lockだけ、UNIQUEだけ、どちらか片方を壊した mutation でもテストが検出するか確認。

「scheduler間隔がある」は安全根拠にしない。

## Gate B — fencing / lease

`claim_id`が本当にfencing tokenとして機能するか。

確認:
- expired old claimのworkerがprovider_startedへ進めない
- old workerがnew claimをreleaseできない
- old workerがnew claimをpublishedへsettleできない
- same scheduled_postの二重claimはexplicit conflict
- lease expirationはclaimedのみ
- provider_started/ambiguous/publishedはleaseで自動再開放されない
- claimed lease expiration後の新claim取得が安全。

## Gate C — provider_started boundary

dispatcher順序を実コードで確認:

claim
→ generation / content guard / fingerprint
→ provider_started DB commit
→ X call
→ result classification
→ settle/ambiguous/release
→ existing completion

以下を個別にテスト:
- generation failure
- content diversity rejection
- fingerprint duplicate
- start-provider RPC false/error
- provider call not started
- provider 400
- 401
- 422
- 429
- 403
- 5xx
- timeout
- network error
- response missing id
- process crash-equivalent after provider_started
- process crash-equivalent after X success before settle
- settle DB error
- completion RPC error.

X side effect may have occurred after provider_startedなら、eventが再利用可能にならないこと。

## Gate D — “clear rejection” classification

Candidate treats 400 / 401 / 422 / 429 as clearly no-post and releasable; 403 / 5xx are ambiguous.

Independently inspect the actual `postToX` abstraction / error contract.

Do not assume status alone if the wrapper cannot prove:
- request was accepted/rejected before creating a post
- status is authentic X response vs local/proxy failure.

If any of 400/401/422/429 can be returned after an uncertain write in current abstraction, release is unsafe.

Conversely, do not overblock clear pre-write failures if the abstraction proves them.

Report exact evidence.

## Gate E — settle idempotency / conflict

Verify:
- same claim + scheduled + event + unit + same xPostId => IDEMPOTENT
- same claim + different xPostId => conflict
- same claim + different event/unit => conflict
- same scheduled_post + different active claim => conflict
- NOT_FOUND does not become success
- published cannot be released
- ambiguous can only become published through exact identity match
- released/expired cannot be settled published.

Confirm DB return handling in TS does not misinterpret conflict strings/status.

## Gate F — stable event_id

Review diary parser + sanitizer + canonical MD + snapshot + CI.

Must prove:
- event_id required for runtime candidate
- format bound to heading date
- unique
- reordering entries does not change ID
- inserting another entry does not change existing ID
- changing body/angles does not change ID
- sanitizer cannot silently rewrite ID into another valid ID
- duplicate/missing/unsafe event_id is excluded/fails CI
- event_id does not expose task/branch/commit/PR/token/internal DB identifiers.

Inspect all 8 current IDs for public safety.

Important:
CI currently also rejects duplicate diary dates. Determine whether this remains an intentional one-event-per-day contract. If yes, document. If future multiple events/day are desired, do not silently block them via date uniqueness while claiming event_id supports multiple events.

## Gate G — diary snapshot workflow safety

Review `.github/workflows/ai-lab-diary-snapshot.yml`.

Verify:
- validation imports are safe in GitHub Actions
- snapshot generation deterministic
- missing/invalid/duplicate event_id stops before write
- generated-file-only diff remains enforced
- race check still prevents non-fast-forward write
- workflow cannot overwrite unrelated main changes
- permissions remain minimal enough for intended auto-commit.

No live workflow mutation required.

## Gate H — evergreen behavior

DB must enforce:
- same seed 72h cooldown
- overlapping generic theme 48h cooldown
- all candidates blocked => **no claim**
- dispatcher skips X with explicit safe failure/skip
- no least-recent cooldown bypass
- evergreen can eventually re-enter after cooldown
- diary event remains permanently/non-reclaimably blocked once provider_started/ambiguous/published as designed.

Check whether released/expired evergreen rows affect cooldown correctly.

## Gate I — migration schema / drift / ACL

Review `20261004090000_ai_lab_topic_claims.sql`.

Must verify:
- clean apply
- clean reapply
- explicit BEGIN/COMMIT behavior under repo deployment tooling
- old superseded table presence => fail
- wrong/missing column => fail
- wrong/missing PK/CHECK/UNIQUE/index => fail
- RLS/policies/triggers drift => fail
- column/table ACL drift => fail or normalize only where explicitly intended
- unexpected overloads => fail
- exact function signatures
- SECURITY DEFINER
- `search_path=''`
- fully-qualified object references inside functions
- PUBLIC/anon/authenticated cannot execute
- service_role execute only exact intended 5 functions
- table direct privileges none
- no TRUNCATE/TRIGGER/REFERENCES/MAINTAIN leakage
- owner role / function owner cannot accidentally broaden exposure through PUBLIC execute default.

Because another migration recently had `IF NOT EXISTS` drift issues, do not accept source-text claims without disposable proof.

## Gate J — advisory lock / hash

Review:
`pg_advisory_xact_lock(hashtextextended('ai_lab_topic_claims:ai_salaryman_lab',0))`

Confirm:
- deterministic per database
- all claim acquisition paths use same key
- no alternate writer bypasses it
- no realistic collision concern that changes correctness materially
- lock ordering does not create deadlock with other locks/functions.

## Gate K — candidate payload validation

`claim_ai_lab_topic` accepts JSON candidates.

Verify DB validates:
- no unexpected candidate keys causing hidden behavior
- exact kind/event/unit/theme relationships
- invalid eventKey/unitKey fails closed
- theme_tags contents/count
- no text body stored in DB
- max candidate count
- no malformed candidate can bypass diary one-time or evergreen cooldown.

If DB relies on table CHECK for some validation, confirm no candidate is partially acted upon before failure in a way that leaves bad state.

## Gate L — completion / duplicate-X safety

Existing `complete_ai_salaryman_lab_brand_post` was not changed.

Verify integration:
- event claim does not introduce a new retry of confirmed X
- settle failure is absorbed/handled so outer failure path does not resend X
- completion failure after published claim does not reopen event
- ambiguous outcome never gets automatically retried as same event
- scheduled-post failure handling remains compatible.

Do not claim cross-system exactly-once beyond what is proven.

## Gate M — other brands / unrelated paths

Confirm no functional change to:
- Kabumori morning/close reports
- other X brands
- OAuth
- tokens/Vault
- scheduler/Cron
- common account
- PR #81 content settings
- PR #76 publish-toggle corrective.

## Required tests

Run independently:
- Functions relevant suites
- rewritten `ai_lab_event_dedupe_test.ts`
- diary context tests
- scheduled brand-post tests
- topic dedupe tests
- cross-brand dedupe tests
- x-test-post relevant suites
- SQL runner `supabase/tests/ai_lab_topic_claims_run.sh`
- two-session concurrent claim
- lease/fencing
- provider classification
- idempotency conflicts
- drift adversarial cases
- ACL effective privileges
- CI validation script
- changed-file Deno check/lint
- git diff --check
- secret/internal-id scan.

Where full entrypoint `deno check` has the known six pre-existing errors, compare against merge-base and do not mislabel them as new.

## Production read-only

Optional only if needed:
- migration ledger collision
- target table/function existence
- role/default ACL facts
- aggregate scheduled-post metadata.

No post text/token/Vault/PII read.

Production write = 0.

## Verdict

PASS only if previous C1 blockers are closed under realistic adversarial concurrency/failure.

PASS-WITH-FIX only for bounded correction fully verified by H1.

CHANGES REQUIRED if:
- two workers can still hit X for same diary event;
- any ambiguous/possibly-posted outcome can reopen the event;
- stable ID can silently change/revive;
- migration drift/ACL/security boundary remains unsafe;
- dispatcher can retry confirmed/possibly-confirmed X.

## Report

Append `.agent/CODEX_REPORT.md`:
- verdict
- exact head
- previous P1/P2 disposition
- concurrency proof
- lease/fencing proof
- provider-status classification evidence
- crash/ambiguous outcome
- settle/idempotency
- event_id + CI
- evergreen
- migration/ACL/RLS/drift
- other-brand impact
- tests
- production reads/writes
- source fix if any
- merge recommendation
- rollout order.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-04 JST

- verdict: **CHANGES REQUIRED**. PR #82 exact head remains `9f3b19a3cde490cf63735220ae191dcd4f11bdcb`, open/unmerged; no runtime fix.
- Previous ordinary diary concurrency, failed-settle and claim-id fencing blockers are closed in actual local SQL-backed dispatch controls. Remaining required corrections: duplicate scalar event_id silently renames identity in runtime and actual CI; API-owner/inherited-owner ACL drift is accepted; genuine Vault-path 401 becomes permanently ambiguous; unresolved evergreen claims reopen after cooldown age; cooldown timing and canonical payload/theme validation remain incomplete.
- Candidate focused checked suites 97 PASS; existing shared + x-test-post runtime 907 PASS (--no-check); local SQL runner 96 PASS; Node workflow-related suites 49 PASS. H1 independent SQL/dispatcher safety tests: 6 controls PASS / 10 required failures; actual workflow validator: 2 controls PASS / 1 required failure. These RED tests are evidence, not a passing release suite.
- Advisory-lock removal is detected by the existing two-session SQL runner; diary UNIQUE removal is independently detected by H1's direct-insert constraint control.
- Three changed helper modules typecheck PASS. Full entrypoint has exactly the same six baseline type errors; runtime lint has the same four baseline issues. Changed test-file lint has 65 require-await diagnostics vs 25 at merge-base (40 net-new); no blanket check/lint PASS claim.
- Evidence-only commit `0801619f4bcd882dadc71deab5cd07493a7ea80a` on H1-only `codex/h1-pr82-claims-20261004` contains two RED-test files; do not merge it as a release candidate.
- Fresh main `1a713f8c7fc48629262c6cdc7c11fed1fa316e8e` now overlaps canonical diary MD + snapshot: preserve the new topic-detail diary content when correcting/freshening PR #82. No migration timestamp collision found on that fresh main.
- H1-owned temporary databases removed and dedicated PostgreSQL stopped. Production reads/writes, real X/model/Vault/token operations, merge/deploy = 0. Other slot worktrees/control files untouched.
- Detailed findings, limits and correction contract appended to `.agent/CODEX_REPORT.md`. Next: **C1, 推薦モデル：Sol（高）**; return for focused correction, HOLD merge/deploy. H1 STOP after control-file sync/read-back.

---

# Codex Task — CURRENT TASK

- task_id: ai-lab-pr82-event-dedupe-review-20261003
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused review / AI Lab event dedupe / migration / concurrency
- target_pr: 82
- target_head: 08a7346ccd63f2ff540bd48149f1f1e65e6dbe09
- production_mutation_allowed: false

## Purpose

PR #82を独立レビューする。
目的は、会社員AIラボで同じ実際の開発イベントを changed / difficulty / decided / angle の別表現で繰り返し投稿する問題が、本当に構造的に閉じたかを確認すること。

## Mandatory

- independent H1 worktree
- fresh origin/main
- exact PR head確認。headが変わっていたらSTOP
- G3/G4のworktree・migration・未commit変更に触れない
- merge/deploy/production write/real X operation禁止

## Must-review gates

1. 9/30 fixtureで旧不具合を再現し、新実装で同一eventの全unitが1回のpublished usage後に除外されること。
2. fresh未使用eventがあればそれを優先し、全部使用済みならevergreenへ行くこと。
3. rotationIndexがused eventを復活させないこと。
4. eventKey `diary-YYYY-MM-DD-N` の安定性。同日途中挿入・並べ替え・sanitize除外でfresh eventが別keyになり再投稿できないか。
5. **同時実行レース**:
   - A/Bが同じrecentUsageを読み、
   - 同じ未使用eventを選び、
   - 両方がX publishへ到達できないか。
   scheduler間隔を安全性の根拠にしない。
6. **usage保存失敗**:
   - X成功
   - usage insert失敗
   - completion成功
   - 次回history read成功
   のとき同じeventが再選択されないか。
7. X成功後のcrash window:
   - X成功→usage前
   - usage後→completion前
   で二重X投稿安全性とevent dedupeの両方を評価。
8. 必要ならreservation/claim方式を correction contract として提案:
   - event単位unique claim
   - lease/expiry
   - pre-X failureでrelease
   - X成功後published化
   - crashでも同じeventの二重publishを防止。
   大きな設計変更はレビュー中に実装しない。
9. migration `20261003090000_ai_lab_topic_event_usage.sql`:
   - CHECK
   - PK/unique設計
   - RLS
   - effective ACL
   - service_role SELECT/INSERT only
   - TRUNCATE等が残らないこと
   - IF NOT EXISTSでunsafe driftを黙って受け入れないか
   - reapply/idempotency
   - index/read query整合。
10. `loadAiLabTopicUsage`:
   - 14日lookback
   - 200件limit
   - malformed/read failure時fail-safe
   - brand filter
   - no raw post body storage。
11. `recordAiLabTopicUsage`:
   - on_conflict scheduled_post_id の意味
   - 同じscheduled_post_idで別event/x idを黙ってignoreしてよいか。
12. evergreen 72h seed / 48h generic theme cooldown。
13. existing content guard / cross-brand fingerprint / final dispatch guardを維持。
14. 他ブランド、朝刊/大引け、OAuth、Cronへ非影響。
15. exclusion/logに本文や内部開発情報を出さない。

## Tests

- PR #82 focused tests
- AI Lab topic dedupe
- scheduled brand post
- cross-brand fingerprint
- relevant x-test-post/shared tests
- changed runtime Deno check/lint
- disposable PostgreSQL migration proof
- diff check / secret-shape scan
- 上記同時実行・usage失敗のadversarial testを追加して検証

PASS条件:
現実的な同時実行・usage失敗でも同じeventが再publishされない、または安全に阻止されること。

CHANGES REQUIRED条件:
同時dispatchやusage write failureで同じeventのpublishが現実的に再発するなら、scheduler間隔に関係なくFAIL。

## Report

`.agent/CODEX_REPORT.md`へ:
- verdict
- reviewed head
- old bug reproduction
- eventKey stability
- concurrent selection result
- usage failure result
- crash-window result
- migration/RLS/ACL/drift result
- tests
- production read/write
- remaining risks
- merge recommendation
- rollout order

status -> review_required
next_owner -> chatgpt
STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-03 JST

- verdict: **CHANGES REQUIRED**. Exact PR #82 head remains `08a7346ccd63f2ff540bd48149f1f1e65e6dbe09`, open/unmerged.
- P1: same-event concurrent schedules both reach fake X; usage failure + successful completion permits next-slot republish; confirmed-X/before-usage and ambiguous-response windows lack durable event protection.
- P2: ordinal event IDs revive used events after insertion/reordering/parser exclusion; ignored conflicting schedule ID falsely reports persistence; exhausted evergreen pool bypasses 72h; migration silently accepts missing PK/CHECKs/wrong index drift.
- Candidate focused checked tests 96 PASS (new event tests 26); existing shared + x-test-post runtime 901 PASS with --no-check. H1 safety regressions intentionally RED: 2 control PASS / 9 required safety failures. Disposable PostgreSQL 17: 16 observation probes + four CHECK cases; unsafe drift/duplicate/conflict cases independently reproduced, not safety PASS.
- Evidence-only source commit `100ab65f8142adc11916f467f68415d15cbc00b1` pushed/read-back on H1-only `codex/h1-pr82-event-review-20261003`; two test files, no runtime fix or PR #82 mutation. Do not merge this RED-test evidence branch as a release candidate.
- Detailed correction contract / test and lint debt / local DB rollback+shutdown evidence appended to `.agent/CODEX_REPORT.md`.
- Production read/write, model/provider/X operations, merge/deploy = 0. G3/G4 files and shared slot indexes untouched.
- Next: **C1, 推薦モデル：Sol（高）**. Return for focused durable event-claim/identity/schema correction; do not merge/deploy unchanged PR #82. H1 STOP.

---

# Codex Task — CURRENT TASK

- task_id: kabumori-pr79-hard-guard-rereview-20261003
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused rereview / Hard Fact session-date+hypothetical boundary
- target_pr: 79
- target_head: f7083ba6a810d5f9cdbe7090e4439f261e38bf0f
- previous_reviewed_head: 9ce344b78f23f3bfc1cf033031f1c6ea6bf16fa3
- production_mutation_allowed: false

## Purpose

前回H1でCHANGES REQUIREDとなったPR #79の修正版を再レビューする。

前回の3 findings:
- P1 hypothetical tail が前半のwrong-date/wrong-direction断定を消す
- P2 普通の前夜watch表現がfalse reject
- P3 unused `directionIn` でlint fail

が、Hard Fact境界を壊さず解消されたかを確認する。

**merge / deploy / gate change / manual cycle / DB/Auth/Vault/X mutationは禁止。**

## Mandatory startup / isolation

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G2 current TASK+Report / previous H1 report.
2. Use independent H1 worktree.
3. Fresh-fetch origin/main and PR #79 exact head `f7083ba6a810d5f9cdbe7090e4439f261e38bf0f`.
4. STOP if PR head differs.
5. Fresh compare PR files vs current main; K2 found overlap 0. Re-check independently.
6. Do not touch H2 or other slot worktrees.

## Gate A — P1 hypothetical-tail bypass

Must Hard-fail in all six factual placements:
- `10月2日の米国株は下落しており次も続くかを見ます`
- `10月2日は、米国株高が強まり波及するかどうかを見ます`
- `10月2日は、米国株高が鮮明となり波及するかどうかを見ます`
- `10月2日は、米国株高が継続し波及するかどうかを見ます`
- `10月2日は、米国株が上昇しており、さらに上昇するかを見ます`

Six placements:
- market_summary
- X context
- X closing
- App summary
- App japan
- observation claim

Check both:
- wrong-date/session detection
- wrong-direction detection where input direction contradicts text

Do not accept protection that only happens through LLM Fact.

## Gate B — genuine hypothetical/conditional forms

These should remain non-factual for date/direction:
- `米国株高が強まるかどうかを見る`
- `米国株が上昇すれば、日本株の反応を見る`
- `米国株安が続くかを見る`

Attack `GOVERNED_BY_QUESTION`:
- 6-kanji / 3-hiragana bounds
- particles
- nested predicates
- continuative forms
- punctuation/no punctuation
- forms where an asserted predicate occurs before `かどうか/続くか`

Goal: prove it does not let a completed assertion masquerade as a genuine hypothesis.

If you find a deterministic bypass, add failing regression first.

## Gate C — P2 bounded prior-night watch references

Must pass the **session-date** guard:
- `10月2日は、前夜の米国株高を受け、日本株の反応を見る`
- `10月2日は、米国株高の流れをどう受け止めるかが焦点`
- `前日の米国株上昇を踏まえて、日本株の反応を確認する`
- all original PR #79 legitimate watch-reference shapes

But must remain Hard:
- `10月2日は、米国株高を受け、米国株高が続き、日本株を見る`
- `10月2日は、米国株高を受け、買いが先行し、日本株の反応を見る`
- `10月2日は、米国株高の流れが続き、日本株の反応を見る`
- `10月2日は、米国株高の流れが強まり、どう受け止めるかが焦点`
- `10月2日は、前夜の米国株高が続き、日本株の反応を確認します`
- `10月2日の前夜の米国株は上昇しました`

Inspect:
- WATCH_RELATION new `を受け` branch
- `の流れを…どう…か` branch
- MOVE_LIST narrowing
- REFERRED_MOVE / TOPIC_AFTER_DATE

## Gate D — remaining Hard safeguards

Must remain Hard:
- wrong-date numeric values/change
- exact 10/1 mixed-session Nikkei/1306 regression
- stale-as-current
- 1306 -> TOPIX index
- direction/sign/emoji inversion
- unsupported market causality
- fabricated/unknown ref

PR #77 quality calibration and safe-original fallback must remain unchanged.

## Gate E — causality interaction for P2

G2 reports:
- the date guard now passes `前夜の米国株高を受け、日本株の反応を見る`
- but in factual summary/context/closing fields, the **separate causal guard** may still Hard-block it because `を受け` + `日本株` looks causal.
- in watch/next_watch fields it can pass.

Assess this carefully.

Question:
Is that behavior acceptable under product policy, or would ordinary morning watch phrasing still routinely disappear from factual presentation fields despite the session-date fix?

Do not automatically weaken causal guard.

If you conclude this is a real recurring delivery false positive and the fix is small/deterministic within current scope, document the minimal correction and decide whether H1 can safely fix it.
If it needs broader causal semantics, return CHANGES REQUIRED with a focused G2 follow-up instead.

User policy:
- objective lies/contradictions -> BLOCK
- supported watch/reference phrasing and honest uncertainty should not routinely kill delivery

## Gate F — lint/check truth

Re-run changed-file lint and verify exit 0.
Confirm unused `directionIn` is gone.
Do not accept a report-only claim.

## Required tests

At minimum:
- session_date_calibration
- h1_pr79_boundary
- presentation_v2
- causal_calibration
- quality_calibration
- h1_adversarial
- content_guard
- transport_retry
- full market-report-analysis
- personalized-reports
- X shared consumer
- market-report-data-packet
- _shared
- deno check
- deno lint changed files
- git diff --check

Use `--no-check` only where that suite already has known unrelated checked-type debt; report it precisely.

## Fix authority

H1 may make only small deterministic fixes inside this exact guard boundary.

Allowed:
- one clause-classification predicate correction
- one WATCH_RELATION regex correction
- one narrow causal-watch classification correction if clearly bounded
- focused regression tests/docs

Return CHANGES REQUIRED if fix requires:
- general parser redesign
- prompt/model/call-budget changes
- packet/schema changes
- DB/RPC/migration
- broader causal architecture

## Production safety

Forbidden:
- merge
- deploy
- app/x gate change
- manual model/Edge invoke
- DB/schema/RPC/migration
- cron/Auth/Vault/secrets
- real X operation

Production mutation must remain 0.

## Completion / C1

Append to `.agent/CODEX_REPORT.md`.

Report:
- verdict PASS / PASS-WITH-FIX / CHANGES REQUIRED
- original/final reviewed head
- P1 result
- genuine-hypothesis result
- P2 result
- causal interaction assessment
- remaining Hard safeguards
- lint/check result
- tests
- any fix commit / changed files
- production mutation=0
- merge recommendation
- rollout prerequisites

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-03 JST

- verdict: **PASS-WITH-FIX**, conditional on incorporating the exact H1 correction, not the unchanged PR head.
- original head: `f7083ba6a810d5f9cdbe7090e4439f261e38bf0f`; final verified source: `b6d2dce3cc45c73951e51d139fefeddad7e2906e` on H1-only `codex/h1-pr79-rereview-20261003` (push + remote SHA read-back confirmed).
- Prior P1/P2 session-date/P3 fixed by G2. H1 regression-first fix additionally separates `続くから/するから` from questions, excludes asserted continuative premises, preserves bounded degree-adverb questions, and recognizes only full terminal reaction-watch effects in the causal checker.
- Analysis 136 PASS (H1 boundary 9, session-date 14); personalized 128, X consumer 8, data-packet 42 PASS with type checking. Shared runtime 361 PASS with `--no-check`; its separate checked run failed on five existing unrelated errors. Entry-point check, changed-file lint and diff-check PASS.
- Source change: four files only; no G2 branch/PR update, merge, deploy or production operation. Detailed evidence appended to `.agent/CODEX_REPORT.md`.
- Next **C1, 推薦モデル：Sol（高）**: accept/arrange exact fix incorporation and verify PR head before any merge. Deployment remains a separate explicitly approved PR77+accepted PR79 bundle with gates OFF. H1 STOP; shared slot indexes are not overwritten.

---

# Previous completed H1 task — preserved history

# Codex Task — CURRENT TASK

- task_id: kabumori-pr79-session-date-hard-guard-review-20261003
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused review / Hard Fact session-date boundary
- target_pr: 79
- target_head: 9ce344b78f23f3bfc1cf033031f1c6ea6bf16fa3
- production_mutation_allowed: false

## Purpose

PR #79 の session-date Hard Fact guard の緩和を独立レビューする。

狙いは、朝刊の正当な「今日の見る点 + 前夜の米国株高」表現を通しつつ、当日の米国市場が実際に上昇したかのような誤った事実主張、wrong-date数値、mixed-session混同をHardのまま止めること。

**merge / deploy / gate change / manual cycle / DB/Auth/Vault/X mutationは禁止。**

## Accepted G2 evidence to verify independently

- PR #79 final candidate head: `9ce344b78f23f3bfc1cf033031f1c6ea6bf16fa3`
- prior problematic head: `a70dfdd23257c6361b60f1b9221f6029b0fccaf9`
- PR open / mergeable at K2.
- changed files remain 3:
  - `supabase/functions/market-report-analysis/hard_fact_guards.ts`
  - `supabase/functions/market-report-analysis/session_date_calibration_test.ts`
  - `docs/market-report-shared-platform/DESIGN.md`
- G2 reported:
  - session-date calibration 10/10
  - market-report-analysis 123/123
  - personalized-reports 128/128
  - X shared consumer 8/8
  - data-packet 42/42
  - `_shared` 361/361
  - deno check/lint/diff PASS
- production mutation=0.

## Mandatory startup / isolation

1. Read PROJECT_RULES, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, G2 TASK/Report, this H1 TASK.
2. Use independent H1 worktree/checkout. Do not share G2/H2/G3/G4 workspaces.
3. Fresh-fetch `origin/main` and PR #79 exact head.
4. STOP if PR head differs from `9ce344b78f23f3bfc1cf033031f1c6ea6bf16fa3`.
5. Fresh compare PR files against main-side changes; if overlap exists, report and STOP before modifying.
6. H2 remains occupied by X-app schema prerequisite review. Do not touch H2 TASK/branch/files.

## Review Gate A — exact positive boundary

Confirm these legitimate prior-session watch references do NOT produce the session-date Hard error:

- `10月2日は、米国株高や半導体株高が日本株でどう表れるかを見ます`
- `10月2日は、米国株高や半導体株高の受け止め方を確認する一日です`
- `10月2日は、米国株高を踏まえ、日本株の反応を確認します`
- `10月2日は、前夜の米国株高が日本株にどう波及するかではなく、実際の値動きを確認します`
- `10月2日は、米国市場の上昇を受けた動きが続くかを確認します`
- correct explicit prior-session-date forms.

Check the same semantics in market_summary, X context/closing, App story and claims, not only dedicated watch fields.

## Review Gate B — assertion-before-watch laundering

Independently attack `WATCH_RELATION`, `MOVE_LIST`, `NOUN`, `PLACE`, `REFERRED_MOVE`, `TOPIC_AFTER_DATE`.

At minimum these must remain Hard when packet US session is only 10/1:

- `10月2日は、米国株高が続き、日本株の反応を確認します`
- `10月2日は、米国株高が確認され、日本株の反応を確認します`
- `10月2日は、米国株高が鮮明となり、日本株の反応に注目です`
- `10月2日は、米国株高が一段と強まり、日本株の反応を見ます`
- `10月2日は、米国株高が継続し、日本株を見る一日です`
- `10月2日は、米国株高が続いています。日本株の反応を確認します`
- same shapes with `米国市場の上昇`.
- no-comma variants.
- assertion first, then a real `どう表れるか` question.

Try additional Japanese constructions not already in G2 tests. Focus on whether a verb/adjective can sneak through NOUN/PLACE or MOVE_LIST and reach an allowed relation.

## Review Gate C — wrong-date facts remain strict

Must Hard-fail:

- `10月2日の米国株は上昇しました`
- `10月2日は米国株高でした`
- `10月2日のNYダウは50,926.56でした`
- `10月2日はNYダウ50,926.56、S&P500 7,666.45でした`
- any wrong-date metric value/change even inside watch wording.
- 10/1 legacy mixed-session regression: 9/29 Nikkei value + 9/30 1306 under one 9/30 date.
- stale-as-current.
- 1306 -> TOPIX index.
- direction/sign/emoji inversion.
- fabricated/unknown ref.
- unsupported market causality.

Do not accept a relaxation that only shifts protection to the LLM Fact checker for objective date/value contradictions.

## Review Gate D — pre-existing HYPOTHETICAL behavior

G2 explicitly reported a pre-existing boundary:

`HYPOTHETICAL` can cause direction/date checks to skip when a metric clause contains forms like `かどうか`, `続くか`, `すれば`, `なら`.

Example to investigate carefully:
`10月2日は、米国株高が強まり波及するかどうかを見ます`

Determine whether this is:
- safe because the grammar is genuinely hypothetical and no completed-session assertion is made, or
- a real bypass where `強まり` asserts the wrong-date move before the hypothetical tail.

Do not dismiss it merely because it predates PR #79. This review is the pre-deploy Hard-boundary gate.

If a real deterministic bypass exists and the fix is small/local:
- add failing regression first,
- apply the minimal fix on an H1-owned branch / directly mergeable review commit,
- rerun the full relevant suites,
- report original and final head.

If fixing it requires redesigning general clause parsing or materially changes product semantics, return **CHANGES REQUIRED** to G2 instead of broadening review scope.

## Review Gate E — no over-strict delivery regression

User's product policy remains:

> 客観的な嘘・日付/数値/参照の矛盾は止める。正当な見る点・不確実性・軽微な文体品質で日次配信を落とさない。

Verify PR #79 does not regress back into routine false rejects for normal morning phrasing.

Specifically check likely model variants such as:
- `前夜の米国株高を受け、日本株の反応を見る`
- `米国株高の流れをどう受け止めるかが焦点`
- `前日の米国株上昇を踏まえて、日本株の反応を確認する`

If a phrase is rejected, classify whether it is reasonably safe to reject or likely to cause recurring delivery churn. Do not demand exhaustive Japanese NLP.

## Review Gate F — PR #77 combined rollout compatibility

PR #77 is merged but still production-unapplied. It changes quality WARN/rewrite calibration only.

Confirm PR #79 does not interfere with:
- PR #77 quality warning semantics,
- safe-original fallback,
- model-call ceiling,
- packet schema.

Later production rollout should be one `market-report-analysis` deploy containing both PR #77 and the accepted PR #79.

## Required verification

At exact reviewed head, run at minimum:
- `session_date_calibration_test.ts`
- presentation_v2
- causal_calibration
- quality_calibration
- h1_adversarial
- content_guard
- transport retry
- full market-report-analysis suite
- personalized-reports relevant/full suite
- X shared consumer
- market-report-data-packet
- `_shared` relevant/full suite if feasible
- deno check
- deno lint
- git diff --check

Add focused adversarial tests for any newly found bypass or false positive.

## Fix authority

H1 may fix only a small deterministic issue inside the same Hard-guard scope.

Allowed small-fix examples:
- one regex/relation boundary correction
- one clause-classification predicate correction
- regression tests/docs directly tied to the defect

Return to G2 if the fix needs:
- architecture redesign
- model/prompt/call-budget changes
- packet-contract changes
- DB/migration/RPC changes
- broader parsing framework
- production-specific behavior changes

## Forbidden

- no merge
- no production deploy
- no app/x gate change
- no manual Edge invoke/retry
- no DB/schema/RPC/migration
- no cron/Auth/Vault/secrets
- no real X operation
- no personalized-reports/x-test-post source changes
- no unrelated news acquisition changes

## Completion / C1

Append a new section to `.agent/CODEX_REPORT.md`; preserve all history.

Report:
- verdict: PASS / PASS-WITH-FIX / CHANGES REQUIRED
- original reviewed head / final head
- findings by severity
- positive watch-reference result
- assertion-laundering result
- wrong-date numeric/mixed-session result
- HYPOTHETICAL assessment
- delivery-false-positive assessment
- PR #77 compatibility
- tests/check/lint/diff
- changed_files/fix commit if any
- production mutation=0
- merge recommendation
- rollout prerequisites

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion — 2026-10-03 JST

- verdict: **CHANGES REQUIRED**. Exact PR #79 runtime head `9ce344b78f23f3bfc1cf033031f1c6ea6bf16fa3` remains unchanged and is not accepted for merge/deploy.
- P1: a hypothetical tail skips prior asserted date/direction facts, including `10月2日の米国株は下落しており次も続くかを見ます`; all six factual placements return no Hard rejection.
- P2: two ordinary prior-night watch variants falsely fail the date guard; P3: unused `directionIn` makes the changed-file lint fail.
- Original suite 123/123 PASS; focused independent regressions 2 PASS / 2 FAIL; extended full suite 125 PASS / 2 FAIL. Other suites: personalized 128, X consumer 8, data-packet 42, shared 361 PASS (`--no-check` for those four).
- H1 test-only evidence commit: `6140968378c44aecd2d40a1cc7d344f2e98e8b4e` on `codex/h1-pr79-hard-guard-review-20261003`. No runtime fix, no update to G2 branch/PR, no merge/deploy, production mutation=0.
- Details appended to `.agent/CODEX_REPORT.md`. Next **C1, 推薦モデル：Sol（高）**, then narrowly scoped G2 correction; H1 STOP. Dedicated TASK/REPORT are authoritative; shared slot indexes are not overwritten.

---

# Previous completed H1 task — preserved history

# Codex Task — CURRENT TASK

- task_id: x-social-mobile-pr76-publish-toggle-review-20261002
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused review / posting-permission security boundary
- target_pr: 76
- target_head: a59a89e9c585fb6e780e1af2ecc898c830f5524e
- production_mutation_allowed: false

## Purpose

PR #76 の「アカウント単位の自動投稿 ON/OFF」実装を独立レビューする。

これは単なるUIレビューではない。
`social_accounts.publish_enabled` を変更し、将来のX自動投稿を許可/停止する**投稿権限境界**なので、Auth・tenant isolation・CAS・TOCTOU・実行時publish guardとの整合まで確認する。

**merge / deploy / production toggle / DB mutation / X API / Vault mutation / Auth mutationは禁止。**

## Mandatory startup / isolation

1. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK.
2. Read G4 current TASK + Report for `x-social-mobile-publish-toggle-v1-20261002`.
3. Use independent H1 worktree/checkout.
4. Fresh fetch `origin/main` and PR #76 exact head `a59a89e9c585fb6e780e1af2ecc898c830f5524e`.
5. STOP if PR head differs.
6. Confirm fresh base-to-main overlap for the 10 PR files. K4 found main ahead by 5 with overlap 0; re-check independently.
7. Do not touch G3 AI-consult files/worktree or H2 common-account preproduction work.

## Reviewed candidate facts to verify, not assume

PR #76 reports:
- new authenticated Edge Function `social-mobile-publish-setting`
- request exactly `social_account_id / desired_enabled / expected_current_enabled`
- service-side exact account lookup -> server-derived brand id
- caller identity verified through Auth
- membership checked for exact brand
- owner/admin only
- ON strict prerequisites
- OFF remains possible for authorized owner/admin even when connection/brand state is degraded
- CAS/expected-state semantics
- exact write body only `publish_enabled`
- no migration / RLS / grant change
- no X API / Vault plaintext / scheduler mutation
- source tests PASS
- no production deploy.

Independently prove or reject each of these.

## Gate A — authentication and tenant isolation

Verify:
1. Missing/invalid JWT is rejected.
2. User identity is derived from verified Auth result, never request body.
3. Client cannot supply/override `brand_id`.
4. Social account lookup returns the account's authoritative `brand_id`.
5. Membership check binds the authenticated user to that exact brand.
6. Cross-brand account ids cannot be toggled.
7. account-not-found vs foreign-account behavior does not leak useful tenant existence.
8. service-role use is strictly server-side and does not accidentally turn client input into an unrestricted admin write.
9. viewer/member are denied; owner/admin only unless repository policy clearly proves another role is intended.
10. Auth/JWT/service-role/Vault references are not logged or returned.

Try concrete adversarial cases:
- valid user + foreign account id
- valid membership in brand A + account in brand B
- same user multiple memberships
- missing membership
- viewer/member
- spoofed brand_id extra field
- malformed/duplicate/oversized JSON
- non-POST / wrong content type.

## Gate B — ON safety

For `false -> true`, verify all source-of-truth prerequisites and their exact production semantics:

- platform X
- brand exists
- brand active
- brand publish_mode live
- connection state is truly the state accepted by the runtime posting pipeline
- platform_user_id / verified_at requirements match real runtime assumptions
- required access/refresh Vault **references** are present
- connection error state blocks
- stale expected state blocks
- account busy/lifecycle interactions fail closed where applicable.

Do not accept a condition merely because tests encode it; compare to the actual posting pipeline / `assertBrandPublishAllowed` / token loading / account selection path.

### Critical TOCTOU review

G4 already disclosed that brand `is_active/publish_mode` are checked before the PATCH but are not part of the PATCH predicate.

Determine whether this is safe enough because the actual publishing pipeline re-checks those brand conditions before any X write.

- If runtime publish guard definitively re-checks brand active/live before every post and cannot be bypassed by this toggle, document why residual race is non-publishing.
- If not, mark blocker and propose the smallest safe source correction.
- Also inspect account connection/readiness races and ensure the PATCH predicate actually closes those.

## Gate C — OFF safety

For `true -> false`:
- authorized owner/admin must be able to disable even when connection credentials are missing/degraded or brand is inactive.
- OFF must not depend on Vault readability/validity.
- no X revoke.
- no token deletion.
- no scheduled post/history deletion.
- no Auth/common-account mutation.
- exact state conflict still respected.

Check that fail-safe OFF cannot be accidentally prevented by an ON-only prerequisite.

## Gate D — CAS / concurrency

Verify:
- expected_current_enabled is mandatory boolean.
- read mismatch -> 409/no mutation.
- conditional update binds exact id + authoritative brand + expected current state.
- zero updated rows are never blindly reported success.
- race between read and write returns stale or prerequisite failure.
- duplicate taps cannot create contradictory state.
- same-state/idempotent request behavior is truthful.
- response cannot say ON/OFF unless exact requested account/value is confirmed.

Try concurrent counterexamples in unit/fake PostgREST harness where possible.

## Gate E — exact mutation boundary

Prove candidate can mutate only the intended setting.

Review all HTTP calls and write bodies:
- only `social_accounts.publish_enabled` may be patched
- no connection_status
- no verified_at
- no platform_user_id
- no oauth refs
- no Vault
- no brands
- no memberships
- no scheduled_posts
- no post_execution_logs
- no content settings/persona
- no Auth/common account.

Inspect whether database triggers on social_accounts cause additional relevant side effects. Read-only production catalog inspection is allowed if needed; production mutation is not.

Review the decision not to touch `updated_at`:
- confirm current pipeline meaning of updated_at/lease and whether leaving it unchanged is correct.
- if DB trigger updates it anyway, document actual behavior.

## Gate F — Edge Function exposure/config

Verify:
- function JWT verification is actually ON under repository/Supabase config, not merely assumed.
- service key/provider credentials stay server-side.
- no overly broad CORS/exposure issue if relevant to current client.
- error codes are bounded/safe.
- raw PostgREST/provider errors are not reflected to client.
- no sensitive request/response body logging.
- method/content-type/body-size validation is real.

## Gate G — client truthfulness

Review account-detail UI/hook:
- ON requires explicit confirmation.
- cancel makes zero request.
- OFF wording does not imply revoke/delete.
- loading blocks double tap.
- stale/error reload behavior is safe.
- mock preview cannot mutate.
- disconnected OFF account cannot request ON.
- degraded ON account can still request OFF.
- exact selected account id/state is sent.
- success only shown after server-confirmed exact account/value.
- G3 consultation/content settings are untouched.
- no accidental coupling of `approvalMode` with `publish_enabled`.

UI aesthetics are out of scope.

## Tests / independent verification

Run at minimum:
- PR's Edge logic/http tests
- Deno check
- full social-mobile tests
- typecheck/lint
- diff check
- secret scan
- relevant existing X publish-guard/token-loader tests
- any focused adversarial tests needed for the findings above.

If a defect is found and the correction is genuinely bounded/safe, H1 may make a **small review fix** on an H1-owned branch, but:
- preserve original PR head evidence
- add regression first where practical
- do not merge
- do not deploy
- do not alter DB schema/migration/RLS/grants.
If correction requires architecture or migration, STOP and report CHANGES REQUIRED.

## Production safety

Allowed:
- source review
- local tests
- read-only production catalog/schema/config checks if needed.

Forbidden:
- Edge Function deploy
- production publish toggle
- production row mutation
- real X API/post/auth/revoke
- Vault mutation
- Auth mutation
- migration/backfill/Cron change.

## Report

Append to `.agent/CODEX_REPORT.md` without erasing history:

- task_id
- verdict: PASS / PASS-WITH-FIX / FAIL
- reviewed exact head
- findings severity
- Auth/tenant isolation result
- ON prerequisite result
- brand TOCTOU analysis
- OFF fail-safe result
- CAS/concurrency result
- exact mutation-boundary result
- Edge config/JWT result
- client truthfulness result
- tests/adversarial checks
- any changed_files + fix commit
- production read/mutation
- real X operations
- remaining risks
- merge recommendation
- deployment/E2E recommendation
- safety checks.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.

Recommended model: **Sol（高）**.

## H1 completion / delivery resume — 2026-10-02 JST

- verdict: **FAIL / CHANGES REQUIRED**. Reviewed exact head `a59a89e9c585fb6e780e1af2ecc898c830f5524e`, unchanged/open. No source fix or merge/deploy/production change.
- blocking findings: revoked/demoted membership can still authorize the privileged PATCH; brand active/live race is not made non-publishing by the cached runtime guard. Additional findings: foreign no-match reread, nonempty readiness mismatch, unpinned client confirmation/preview transition.
- prior completed-review evidence: Edge 37/37, mobile 134/134, domain 22/22; target runtime check/lint and mobile typecheck/lint PASS; X regression 48/48 with --no-check; seven server/runtime + two client counterexample proofs. Existing shared checked-type errors and candidate test-helper lint failures are documented separately. No tests rerun for this delivery-only resume.
- report synchronized via H1-dedicated TASK/REPORT only; shared CURRENT_STATE/ACTIVE_TASK remain untouched due concurrent other-slot updates. C1 should treat this TASK/REPORT as authoritative and safely align H1 index/summary later. GitHub publication complete only after normal push/read-back.
- architecture/transactional correction requires separately scoped authority. No DB/RPC/publishing-runtime expansion. Full evidence `.agent/CODEX_REPORT.md`. Next **C1, 推薦モデル：Sol（高）**; STOP.

---

# Codex Task

- task_id: common-account-pr70-readiness-authorization-rereview-20261002
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused rereview / lifecycle readiness authorization / migration security
- target: PR #70 exact head `47a2ed6a1635177ba82004eace4bddb42d9d53e3`
- previous_head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`
- production_mutation_allowed: false

## Purpose

PR #70第2是正headを独立再レビューする。

今回の中心は、「Phase 1にenforcing guardを置かず、durable readiness authorizationとinvalidation contractだけを提供する」という責任分離が本当にtruthfulか、そして前回H1の新4 findings / 7 adverse casesが実際に塞がっているか。

**merge / production apply / backfill / deploy / Auth / Storage / OAuth / Vault mutationは禁止。**

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK を読む。
2. G5 current TASK/Report、前回H1 corrective rereview report、Final C1を読む。
3. H1専用worktree/checkout。
4. fresh origin/main と PR #70 exact head `47a2ed6a1635177ba82004eace4bddb42d9d53e3` を取得。head差異ならSTOP。
5. base-to-main changed filesを再確認。PRの8ファイルとの実ファイル競合があればSTOP。
6. 他slot/PRのbranch・TASK・未commit変更へ触れない。

## First gate — responsibility truthfulness

最初に以下を確認。

- candidateに `DELETE FROM auth.users` がない。
- candidateにStorage/Vault/provider destructive SQLがない。
- account deletionの「completed」をPhase 1が主張しない。
- Phase 1に**enforcing deletion guardが存在しない**。
- Auth cascade triggerは観測/shadowのみで、blockerを再構築してauthorizeしない。
- current Kabumori hard-deleteは安全化されていないと明記されている。
- actual managed deletionはfuture orchestrator:
  - recent reauth
  - session revoke / stale JWT handling
  - Apple revoke
  - X posting authorization revoke
  - Vault purge
  - Storage API cleanup/re-enumeration
  - final prepare/revalidation
  - Auth Admin API delete
  - post-delete read-back/audit/retry
  の責務として残る。
- unwired producerが残る間、Phase 1のreadinessをそのままmanaged Auth deleteの安全保証として扱わない。

責任分離が曖昧ならFAIL。

## Re-run prior resolved blockers

前回までの6 blockersが再発していないことを確認：
1. no SQL Auth delete / false Storage completion
2. absent preview stale after backfill
3. backfill vs lifecycle lock
4. admin X consumer backfill exclusion
5. exact FK preflight
6. affirmative fail-closed rollback

## Re-run latest seven adverse cases

### A. Late admin blocker
- ready後にadmin stateを加える。
- read model/prepareがstale/blockerを検出する。
- Phase 1 guardが「authorize」しないことを確認。
- cascade orderingが変わってもobserver triggerの判断が安全性保証として使われていないことを確認。

### B. Late foreign/internal X membership
- ready後のforeign/shared/internal membershipでauthorization/readinessが再評価時にstaleになる。
- post-cascade table visibilityに依存しない設計か。

### C. Cascade order
- admin/membership行がcommon triggerより先に消える順序と、見える順序の両方。
- trigger output/behaviorがauthorize decisionではないため順序依存で安全性主張が変わらないこと。

### D. Built-in requirement row removal
- normal maintenanceでは拒否。
- corruption/drift fixtureでも prepare/read model/rollback が fail closed。

### E. New always-required checkpoint
- requirement epochが進む。
- old ready stateがstale。
- prepareは新要件を要求。

### F. Late Apple identity
- old ready stateがstale。
- apple_revocation requirementを新たに要求。
- old authorization bindingだけでは通らない。

### G. Built-in semantic weakening
exact contract:
- session_revocation = always
- storage_cleanup = always
- apple_revocation = apple_identity

名前だけ同じで意味を弱めた場合、prepare/read/rollbackがfail closed。

### H. Entitlement ownership transfer
- `user_id` / `service_key` direct UPDATEが拒否されること。
- rejected transferでsource/destination lifecycle versionが不整合にならないこと。
- legitimate service moveはend/delete + new startというcontractがtruthfulか。

## Durable readiness authorization review

特に深く確認：

- ready stateがどのtableに保存され、Auth cascadeより先に消えないか。
- bound values:
  - lifecycle version
  - requirement epoch
  - required checkpoint set
  が十分か。
- `authorization_problems` が current blocker / managed requirement / ownership probe をtruthfully再評価するか。
- read modelの none / valid / stale が誤解を招かないか。
- prepareがstale readyを取り消し/cleanupへ戻すか。
- checkpoint clear / requirement change / lifecycle version changeでreadinessが確実にstaleになるか。
- ready row自体の存在と「deleteして安全」の意味を混同していないか。

## Invalidation inventory review

G5のinventory全行を読む。

少なくとも：
- entitlement writes
- account status/version
- backfill
- checkpoint requirement registry
- settings/integration state
- checkpoint clear
- admin membership
- X membership/workspace state
- Kabumori profile creation
- Apple identity
- Storage ownership
- login deletion

各行について：
- writer
- Phase 1で捕捉するか
- version/epochで自動無効化するか
- 再評価のみか
- 未配線ならenforceが存在しない理由
が整合しているか。

**「再評価のみ」のproducerを残したまま、将来の削除安全をPhase 1単体で保証していないこと**が重要。

## Checkpoint registry / settings

- built-in semantic immutability
- extension row追加/削除でrequirement epoch更新
- missing/corrupt built-in contract fail closed
- settingsはshadow以外を受け付けない
- settings missing/corruptでdelete observerがfail closedするか
- settings/integration transitionがready stateへ与える影響
- rollbackがbuilt-in exact semantics、operation/use evidence、dependencyを肯定的に確認するか

## Observer trigger review

Auth/common cascade triggerについて：
- authorizeしない
- admin/membership/identity stateを見て安全判定しない
- cascade順序に依存しない
- open operationのlogin_removed観測はtruthfulか
- settings missing/non-shadowでfail closedする設計が既存shadow導入と矛盾しないか
- raw subject/user data cleanup semanticsが監査要件と矛盾しないか

## ACL / RLS / SECURITY DEFINER

再確認：
- new tables RLS
- intended self SELECTのみ
- client arbitrary writesなし
- service_role table direct grantsなし
- RPC EXECUTE最小
- PUBLIC/anon leakなし
- empty search_path / schema qualification
- metadata/user_metadataによるauthorizationなし
- observer/readiness private objectsがclientから露出しない

## Exact preflight / rollback

前回acceptedしたexact FK/type/delete-action/validation/deferrability/helper signature checksを維持。

追加object/trigger/functionについてもpreflightが十分か。

rollback:
- shadow exact state
- built-in exact semantics
- integration/use evidenceなし
- operation/readiness/extension registry等の存在条件
- downstream dependencyなし
- one transaction / partial teardownなし

## Required independent tests

最低限再実行：
- `supabase/tests/common_account_lifecycle_run.sh`
- `supabase/tests/common_account_lifecycle_mutations.sh`
- `supabase/tests/social_mobile_account_deletion_run.sh`
- migration source invariants
- `bash -n`
- relevant lint/static checks
- `git diff --check`

G5 reported:
- lifecycle 20 PASS
- mutation 45/45 detected
- social deletion 8 PASS
- migration invariants 10 PASS

鵜呑みにせず独立確認。

Mutation suite:
- generic FAILだけでなく intended invariant matcherか。
- latest 7 adverse casesとold 6 blockersのmutation/fixtureが本当に狙った欠陥を検出するか。

必要ならscratch-only adverse probesを追加してよい。PR/sourceへ追加fixする場合はfix authorityに従う。

## Fix authority

小さく決定的なPR #70 scope内P1/P2/P3なら failing test -> minimal fix -> rerun可。

以下はG5へCHANGES REQUIRED：
- lifecycle/readiness contract変更
- enforcing strategy追加
- managed Auth/Storage/provider orchestrator実装
- existing creator/deleter wiring
- broad schema/ACL architecture変更
- production-specific repair

## Production gate

このH1がPASSしてもproduction applyは承認しない。

production前に別途必須：
- **Sol（極高）**
- disposable actual Supabase project proof
- exact production catalog/read-only preflight
- migration-history/version collision
- role/ACL/PostgREST behavior
- Storage/GoTrue/session/API behavior
- backfill dry-run/parity
- explicit approval

## Completion / C1

`.agent/CODEX_REPORT.md`へappend。

必須：
- PASS / PASS-WITH-FIX / FAIL
- exact original/final head
- old six blockers disposition
- latest seven adverse cases disposition
- responsibility-boundary verdict
- durable readiness authorization verdict
- invalidation inventory verdict
- checkpoint/settings verdict
- observer trigger verdict
- ACL/RLS/preflight/rollback verdict
- independent test evidence
- changed_files
- production_mutation=0
- merge recommendation
- remaining Phase 2/3 obligations
- Sol（極高）pre-production gate
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 completion — 2026-10-02 JST

- result: **PASS-WITH-FIX** for reviewed source plus H1's bounded correction; not approval to merge the unchanged PR head.
- original PR #70 head: `47a2ed6a1635177ba82004eace4bddb42d9d53e3`; final verified candidate: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65` on H1-only branch `codex/h1-pr70-readiness-review-20261002`. G5/PR source branch untouched.
- responsibility gate PASS: no managed Auth/Storage/Vault write, no account-completed claim, no enforcing Auth deletion mode; unwired producers are evaluation-only and Phase 2/3 prerequisites are explicit.
- old six blockers and latest seven adverse cases: independently verified resolved. Durable version/epoch/set binding, built-in exact semantics, ownership-transfer refusal, ACL/preflight/rollback PASS in the local model.
- new P2 fixed: direct common-row deletion while Auth remains falsely recorded `login_removed` and scrubbed user_id. Failing regression -> seven-line identity-existence check -> regression/mutation rerun. Real shadow Auth cascades remain allowed; this is observation integrity, not deletion authorization.
- independent verification: original 20 lifecycle PASS / 45 mutations DETECTED; final 20 lifecycle PASS / 46 mutations DETECTED; existing social deletion 8 PASS; invariants 10 PASS; syntax/lint/diff PASS. Additional cascade probe measured both visible/gone admin orders with identical unverified observations; Storage SELECT denial fails closed.
- H1 fix published to its own branch only; no PR merge/update or main runtime change. C1 must decide incorporation of the exact fix before PR #70 merge; do not merge original `47a2ed6` unchanged.
- production read/mutation=0; real X operations=0. Owned fake probe DB removed and own cluster stopped; detailed evidence appended to `.agent/CODEX_REPORT.md`.
- next: **C1, 推薦モデル：Sol（高）**. Separate **Sol（極高）** pre-production review + actual disposable Supabase proof + exact production preflight/history/roles/API checks + explicit approval remain mandatory. H1 STOP after report synchronization.


## Final C1 — PR #70 readiness authorization

- verdict: **PASS-WITH-FIX / accepted**.
- assigned reviewed head: `47a2ed6a1635177ba82004eace4bddb42d9d53e3`.
- H1 bounded fix candidate: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`, exactly one commit atop the assigned head.
- accepted bounded fix: direct owner-maintenance deletion of `common_accounts` no longer falsely records `login_removed` while the Auth parent still exists; actual Auth cascade observation remains shadow/unverified and does not authorize deletion.
- independent final evidence accepted:
  - lifecycle runner 20 PASS
  - mutation suite 46/46 detected
  - social-mobile deletion 8 PASS
  - migration invariants 10 PASS
  - old six blockers resolved
  - latest seven adverse cases resolved
  - responsibility boundary remains no-enforce / no-managed-Auth-delete in Phase 1
- PR #70 branch was fast-forwarded to exact reviewed fix `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`; fresh main overlap = 0 files; PR checks completed successfully/neutral as expected.
- PR #70 merged by ChatGPT.
- merge/main SHA: `44121914b035e22380a4ca1bd8252a42713a2bbf`.
- production mutation/read from H1/C1: 0.
- **This merge does not apply the Supabase migration, run backfill, enable any guard, alter Auth/Storage/OAuth/Vault, or authorize production rollout.**
- next: independent H2 pre-production gate `common-account-pr70-preproduction-gate-20261002`, recommended **Sol（極高）**.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: common-account-pr70-corrective-rereview-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused rereview / Auth lifecycle / migration security
- target: PR #70 exact head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`
- previous_failed_head: `89cf128bd9219897806b2b641cce4866f6e16c52`
- production_mutation_allowed: false

## Purpose

PR #70 corrective headを再レビューし、前回H1が再現した6 blockersが本当に解消され、Phase 1の責任が「additive lifecycle foundation」に安全に縮小されたか確認する。

**merge / production apply / backfill / deploy / Auth/Storage/OAuth/Vault mutationは禁止。**

## Mandatory startup

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G5 corrective TASK+Report / prior H1 PR #70 FAIL report / Final C1を読む。
2. H1専用の独立worktree/checkout。
3. fresh origin/main と PR #70 exact head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855` を取得。headが違えばSTOP。
4. base-to-main changed filesを再確認し、PR runtime/test/docとの競合があればSTOP。
5. G4 PR #65など他slot/PRへ触れない。

## First gate — architecture correction

最初に確認：

- candidate migration/runtimeに `DELETE FROM auth.users` が存在しない。
- Phase 1はaccount deletionを「managed Auth削除準備完了」までしか進めない。
- `completed` 等、Phase 1がmanaged account deletion完了を主張するstate/returnがない。
- Storage/Auth/identity/session/provider cleanupをSQLで完了したふりをしない。
- actual Auth Admin API delete / Storage API cleanup / provider revoke / session handlingはfuture orchestrator prerequisiteとして明示。
- current Kabumori legacy hard-deleteがこのPRだけでは安全化されないことがtruthfulに残っている。

この責任分離が崩れていればFAIL。

## Re-run all six prior H1 counterexamples

前回の反例を、PRにcommitされたregressionとして**独立に再実行**する。

### 1. Managed Storage/Auth completion gap
確認：
- Phase 1 candidateはAuth/Storage managed schemaへ destructive writeしない。
- Storage-owned stateがある場合、ready判定が少なくともfail closedする。
- checkpointだけでStorage cleanup済みと盲信しない。
- readyになってもloginは残る。
- Phase 1は「削除完了」を返さない。

注意：DB probeがcleanでも実Storage cleanup完了の証明にはならない。docs/return wordingが過剰保証していないか確認。

### 2. Absent preview / stale confirmation
- no common row previewのversion/epoch
- backfill/service introduction後、old preview/versionが必ずinvalid
- begin deletionがold confirmationでstartedにならない
- version triggerがRPCだけでなくdirect/operator/backfill writeでも適切に動くか

### 3. Backfill vs lock/state transition
- auth.users -> common_accounts lock order
- lock後にplan/status/versionを再評価
- concurrent locked/deleting transition後にentitlement付与されない
- reverse orderも安全
- READ COMMITTED contract / fail-closed behavior

### 4. Admin + self-service workspace
- admin userはconsumer x_autopost entitlement backfill対象外
- Kabumori entitlement semanticsとの区別
- intersection case regression

### 5. Exact FK preflight
- exact referencing column / referenced column
- expected type
- delete action
- validated
- deferrability
- helper function signature/return
- unrelated-column Auth FK counterexample must fail atomically

### 6. Rollback with missing/corrupt settings
- settings row absent => rollback拒否
- enforce/corrupt/non-shadow =>拒否
- in-flight op / downstream dependency / integration started =>拒否
- valid affirmative shadow stateだけrollback可
- guard/objectがpartial teardownされない

## New corrective areas

### Managed checkpoint registry
- built-in checkpoint欠損時fail closed
- service_role/backendが任意にfalse successを作れないか、ACLとcaller contractを確認
- checkpointはorchestrator申告でありDB検証ではないことが明確か
- Apple identity条件、Storage/session required semantics
- future extensibilityがunknown ownershipをsilent ignoreしないか

### Storage read-only probe
- SECURITY DEFINER ownerにproductionでSELECT権限が無い場合fail closedか
- expected storage schema shape違いでfail closedか
- owner/owner_id semanticsを誤解していないか
- clean probeを「cleanup complete証明」として扱っていないか

### Guard semantics
- shadowは既存hard deleteを安全化しないことが明確
- enforceはintegration not_started中に有効化できない
- delete instantでaccount deleting / ready op / ended entitlements / blockers / managed ownershipを再評価
- enforce許可 = DB-visible conditions only。provider/Storage cleanup保証ではない
- legacy X deletionの23503 handlingとの整合

### ACL / RLS / SECURITY DEFINER
- 5 new tables RLS
- self-select columns only
- client writeなし
- service_role table grantなし
- RPC EXECUTE最小権限
- PUBLIC/anon leakなし
- empty search_path + qualified objects
- user_metadata authorizationなし
- start RPC arbitrary user idなし

## Test verification

少なくとも独立再実行：
- `supabase/tests/common_account_lifecycle_run.sh`
- `supabase/tests/common_account_lifecycle_mutations.sh`
- `supabase/tests/social_mobile_account_deletion_run.sh`
- migration source invariants
- shell syntax/static checks
- `git diff --check`

G5 reported:
- lifecycle runner: 19 PASS
- mutation: 29/29 detected
- social-mobile deletion: 8 PASS
- migration invariants: 10 PASS

数字を鵜呑みにせず、可能な範囲で再現する。

mutation suiteについて、少なくとも前回6 blockersに対応するmutation/fixtureが「別の理由で偶然落ちる」だけでなく、狙ったinvariantを検出しているか見る。

## Fix authority

小さく決定的なPR #70 scope内のP1/P2/P3なら failing test -> minimal fix -> rerunを許可。

以下はG5へCHANGES REQUIRED：
- lifecycle contract変更
- managed deletion責任分離の変更
- schema/ACL architecture変更
- provider/Storage orchestrator実装追加
- client/Edge wiring追加
- production-specific repair

## Production gate

このH1がPASSしてもproduction applyは承認しない。

production前に別途必要：
- **Sol（極高）**
- disposable actual Supabase proof
- exact production catalog/preflight read-only確認
- migration-history conflict確認
- Storage/GoTrue/session/role/API境界確認
- backfill dry-run/parity
- explicit user approval

## Completion / C1

`.agent/CODEX_REPORT.md`へ新reportをappend。

必須：
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/final head
- prior six blockers disposition
- architecture responsibility verdict
- lifecycle/version/backfill verdict
- managed checkpoint/Storage probe verdict
- preflight/rollback verdict
- guard/ACL/RLS verdict
- independent test evidence
- changed_files
- production_mutation=0
- merge recommendation
- remaining prerequisites
- Sol（極高）pre-production gateの要否
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 corrective rereview completion — 2026-10-01 JST

- verdict: **FAIL / CHANGES REQUIRED**; reviewed/final PR #70 head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`, unchanged.
- architecture correction and all six prior blockers: independently verified resolved. Phase 1 no longer writes destructive Auth/Storage SQL or claims managed deletion completion.
- new P1: Auth FK cascades can erase late admin/foreign-membership blockers before the common_accounts guard checks them; local trigger instrumentation proves this valid-shape ordering misses the blocker.
- new P2: ready guard does not revalidate changed required checkpoints/Apple identity; built-in registry names can survive with unsafe requirement mappings; an operator entitlement user_id transfer bumps only the destination version.
- independent tests: lifecycle 19 PASS markers; mutation 29/29 DETECTED; existing social deletion 8 PASS; migration invariants 10/10 PASS; shell syntax/lint/diff PASS. Seven additional adverse cases reproduced; Storage SELECT-denied/type-mismatch probes fail closed.
- source/runtime fixes: none. The root delete-boundary/ready-invalidation correction requires lifecycle contract work reserved for G5, not an isolated partial PASS. H1 has not reallocated G5.
- source merge/apply/backfill/deploy: **HOLD**. No production reads or mutations during this rereview; production_mutation=0; no real X operations.
- owned fake probe database removed and local cluster stopped; production data untouched. Detailed counterexamples, scope limits and prior-six dispositions appended to `.agent/CODEX_REPORT.md`.
- next: **C1, 推薦モデル：Sol（高）**; C1 should decide a separate bounded G5 correction. Separate **Sol（極高）** pre-production review, actual disposable Supabase proof and explicit approval remain mandatory. H1 STOP after report synchronization.


## Final C1 — PR #70 corrective rereview

- verdict: **FAIL / CHANGES REQUIRED accepted**.
- reviewed head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855` unchanged.
- previous six blockers: **resolved and accepted**.
- new accepted blockers:
  1. P1: Auth-delete cascade ordering can remove admin / foreign membership rows before the common-account guard checks them, so delete-instant blocker revalidation is not reliable at that trigger point.
  2. P2: a previously ready operation is not invalidated when required checkpoint registry / Apple identity requirements change.
  3. P2: built-in checkpoint names can retain their names while their required semantics are corrupted.
  4. P2: direct/operator entitlement ownership transfer bumps only the destination account version, leaving the source account stale.
- production mutation/read from H1: 0.
- merge/apply/backfill/deploy: **HOLD**.
- architecture direction: preserve the accepted Phase 1 responsibility split (no managed Auth deletion). Do not make the common_accounts cascade trigger the sole correctness boundary for final Auth deletion. The future managed orchestrator must obtain durable pre-delete authorization from state that cannot be erased by Auth cascade ordering, and every readiness-relevant producer/requirement change must invalidate or revalidate that authorization.
- next owner: G5 corrective task `common-account-pr70-guard-boundary-corrective-20261002`, recommended **Opus5.5（極高）**.
- after corrective K5, focused Codex rereview required. Before any production apply, separate **Sol（極高）** gate remains mandatory.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: common-account-pr70-lifecycle-foundation-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: focused security / migration / Auth lifecycle review
- target: PR #70 exact head `89cf128bd9219897806b2b641cce4866f6e16c52`
- production_mutation_allowed: false

## Purpose

共通アカウントv1 Phase 1のadditive lifecycle foundationを独立レビューする。

PR #70は、`common_accounts`、`service_entitlements`、durable lifecycle operation、shadow backfill、lifecycle RPC、Auth削除guard、RLS/grants、race testsをsource-onlyで追加する高リスク候補。

**merge / production migration apply / backfill / deploy / Auth delete / OAuth/Vault操作は禁止。**

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G5 Phase 1 TASK+Report / H1 prior C1を読む。
2. H1独立worktree/checkout。
3. fresh origin/main と PR #70 exact headを取得。headが変わっていたらSTOP。
4. PR #70 base以降main変更を再確認し、runtime overlap/raceがあればSTOP。
5. G4 PR #65は別workstream。G4 filesへ触れない。

## Review priorities

### A. Lifecycle serialization — 最優先

- service start vs whole-account deletionの両commit orderが本当に安全か
- auth.users row lock + common_accounts row lockのlock order
- existing `ensure_my_profile` と `begin_social_mobile_x_oauth_connection` との競合証明
- finalizeが同一transaction内でblocker再検証→Auth削除まで隙間なく行うか
- READ COMMITTED限定が妥当か、他isolationでfail closedか
- lifecycle_versionによる確認後変更検知
- stale/retry/idempotency
- deadlock possibilityとdocumented single-transaction assumption
- advisory/row lockが外部Saga stepを原子的に扱ったふりをしていないか

race testが本当に欠陥を検知するか、mutation evidenceも確認する。

### B. SQLによる Auth user deletion

特に深く確認：

- Supabase/GoTrue管理下の `auth.users` をSQLでDELETEすることの妥当性
- auth schema ownership/trigger/FK/session/identity/storage等との整合
- existing X finalizeとの類似だけを根拠に安全扱いしていないか
- delete failure時のtransaction rollback/fail-closed
- session/JWT invalidation assumptions
- future provider/Apple revoke ordering
- production apply前に必要な実Supabase disposable proof

必要なら「SQL deleteはsource candidateとして不採用、Edge/common orchestrator経由へ変更」などをCHANGES REQUIREDとして返す。

### C. Auth deletion guard trigger

- shadow / enforce semantics
- settings row missing時のfail-closed
- cascade時のtrigger behavior
- legitimate service-only cleanupを誤blockしないか
- existing X deletion sagaが23503を期待通り扱えるか（sourceで証明）
- bypass path / owner role / SECURITY DEFINERからの削除
- trigger disable/replica role等の考慮
- rollback時にenforce状態を安全に扱うか

### D. RLS / grants / SECURITY DEFINER

- exposed public tablesはRLS enabledか
- authenticatedはself SELECTのみか
- source/legacy_evidence等の列制限
- client INSERT/UPDATE/DELETE/TRUNCATE不可
- PUBLIC/anon/authenticated/service_roleの不要grantが残らないか
- service_role table grantなし + RPC-onlyが実運用可能か
- SECURITY DEFINERのfixed search_path
- function EXECUTE PUBLIC revoke ordering
- helper/private schema exposure
- auth.uid() ownership checks
- user-controlled metadataをauthorizationに使っていないか

### E. Backfill rules

- common_accounts 1:1 with Auth users
- Kabumori legacy profileをactive候補にすることの曖昧性をsourceで保持しているか
- X entitlementがself-service user workspace ownerだけか
- admin/internal workspace除外
- Auth-only users
- no email-based merge
- existing rowsを上書きしない/idempotent
- locked/deleting accountへ誤付与しない
- sourceのmigration-history driftを悪化させない

Phase 0のproduction aggregateはreference evidenceとして使えるが、このreviewでproduction backfillはしない。

### F. Migration preflight / rollback

- exact preflight object/column/FK/function dependency check
- one transaction / partial apply防止
- version collision
- re-apply strategy
- existing repo migration-history mismatchへの耐性
- rollbackがcandidate-created objectsだけをdropするか
- downstream依存がある状態でrollbackを拒否するか
- rollback後再applyが成立するか

### G. Service lifecycle semantics

- service-only deleteは他service/Authを触らない
- whole-account deleteは全service cleanup完了までfinalize不可
- admin/shared/unknown/unregistered footprint fail closed
- X posting OAuth authorizationとlogin identityを混同しない
- Apple revoke checkpointはwhole-account flowだけの責任として妥当か
- current X deletion scopeのprofiles proxyをこのPRがまだ切り替えていないことが明確か
- current Kabumori hard-deleteがこのPRだけでは安全にならないと明示されているか

## Required verification

PR #70 reported evidenceを鵜呑みにせず再実行/検査：

- `supabase/tests/common_account_lifecycle_run.sh`
- behavior tests
- two-session race tests
- rollback/reapply
- mutation tests or equivalent defect-detection validation
- `social_mobile_account_deletion_run.sh`
- migration source invariants
- SQL lint/static checks where available
- `git diff --check`
- schema diff / ACL inspection

可能なら disposable Supabase/PostgreSQL環境で、role/trigger/search_path/SQLSTATE挙動を追加検証。

実productionへのwrite/apply/deleteは禁止。

## Fix authority

小さく決定的なP1/P2/P3でPR #70 scope内なら failing test -> minimal fix -> rerun を許可。

ただし以下はG5へCHANGES REQUIREDで返す：

- architecture変更
- Auth削除方式の根本変更
- lifecycle contract変更
- schema/role modelの大幅変更
- production-specific migration repair
- client/Edge wiring追加

## Completion / C1

`.agent/CODEX_REPORT.md` に新規reportをappend。

必須：

- PASS / PASS-WITH-FIX / FAIL
- exact original/final head
- findings severity
- lifecycle serialization verdict
- SQL Auth deletion verdict
- guard trigger verdict
- ACL/RLS/SECURITY DEFINER verdict
- backfill/preflight/rollback verdict
- test evidence
- changed_files
- production mutation=0
- merge recommendation
- prerequisites before any production apply
- whether **Sol（極高）** pre-production review is required
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **FAIL / CHANGES REQUIRED**; review completed, source merge/apply/deploy HOLD.
- original/final PR #70 head: `89cf128bd9219897806b2b641cce4866f6e16c52` (unchanged).
- P1: SQL Auth finalization can report completed with Storage-owned metadata remaining; ownership is not protected by an Auth FK. No production deletion was performed.
- P2: backfill preserves version 1 for newly created accounts with new service entitlements, accepting an old empty preview; a two-session backfill can grant an active entitlement after an operator lock commits; admin + self-service-owner is not actually excluded.
- P2: preflight accepts an unrelated-column Auth FK instead of the required user binding; rollback removes the effective-enforce guard when its settings row is missing.
- independently rerun after reset: lifecycle runner 16 checks PASS, existing social deletion runner 8 checks PASS, migration invariants 10/10 PASS, bash syntax / invariant lint / diff checks PASS. Removing the common row lock in a scratch-only mutation is detected by race 7. Six additional safety counterexamples reproduced; standard suites do not cover them.
- runtime/source fixes: none. Correcting managed Auth/Storage deletion and backfill/confirmation serialization requires the lifecycle contract work explicitly reserved for G5, not a partial safety claim.
- production mutation=0; read-only catalog metadata only. Real disposable Supabase GoTrue/PostgREST/Storage proof is still required; local PostgreSQL is not that proof.
- full findings, reproduction recipes, limits and delivery evidence appended to `.agent/CODEX_REPORT.md`; prior reports and other slots preserved.
- next: **C1, 推薦モデル：Sol（高）**. After a separately assigned G5 correction, repeat focused review; **Sol（極高） pre-production review required** before any production apply. This completion does not allocate G5 or authorize production. H1 STOP.


## Final C1 — PR #70 lifecycle foundation

- verdict: **FAIL / CHANGES REQUIRED accepted**.
- reviewed source head: `89cf128bd9219897806b2b641cce4866f6e16c52`; unchanged by H1.
- merge/apply/deploy: **HOLD**.
- accepted blockers:
  1. SQL Auth DELETE can report completion while Storage-owned state remains; Phase 1 must not claim managed-account destruction safety.
  2. absent-account preview version can remain valid after backfill adds service entitlement.
  3. backfill can grant entitlement after a concurrent account lock/state change.
  4. admin + self-service workspace intersection can receive x_autopost entitlement.
  5. FK preflight validates table-level FK existence instead of exact invariant-bearing columns.
  6. rollback can remove the guard when lifecycle settings row is missing even though runtime treats missing as enforce.
- accepted approach: do **not** patch the SQL hard-delete path incrementally. Narrow Phase 1 to additive lifecycle/entitlement/serialization foundation and move actual managed Auth destruction to a later common-account orchestrator/integration phase.
- production mutation from H1: 0.
- current production corruption: not established.
- next owner: G5 corrective task `common-account-pr70-corrective-lifecycle-foundation-20261001`, recommended **Opus5.5（極高）**.
- after corrective K5, repeat focused Codex review. Before any production apply, separate **Sol（極高）** review remains mandatory.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: common-account-kabumori-delete-cross-service-safety-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- type: security review / bug fix / Auth deletion boundary
- target: fresh origin/main; existing production-deployed Kabumori account deletion source
- production_mutation_allowed: false

## Purpose

共通アカウントv1 Phase 0（G5）のread-only inventoryで確認された、既存Kabumori account deletionのcross-service lifecycle riskを独立レビューする。

現在のKabumori deletionは共有Supabase Auth userをhard deleteする一方、X自動投稿側のworkspace / posting authorization / Vault credential / admin ownershipを認識しない。現時点で両service利用者は0人だが、共通ID導入後にそのまま残すと一サービスの退会が他serviceへ影響する。

このTASKでは、まずsource/securityレビューを行い、**小さく安全で決定的な暫定fail-closed修正が可能なら source + tests まで実施してよい**。production deployはしない。

## Mandatory startup / isolation

1. PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / G5 Final K5 + Reportを読む。
2. H1専用の独立worktree/checkoutを使用。
3. fresh origin/mainを取得。
4. G3はsocial-mobile account deletion UI、G4はX posting OAuth account-switchを扱っている。G3/G4のbranch/files/PRを変更・merge・rebase/resetしない。
5. pending PRのchanged filesを確認し、Kabumori account-delete scopeと競合があればSTOP。

## Facts from G5 to independently verify

- production Kabumori account-delete is ACTIVE and verify_jwt=true.
- source path hard-deletes the authenticated Supabase Auth user.
- shared Auth hard delete cascades at least to Kabumori profile data, admin membership, X membership/OAuth-state references, while X workspace/social account/Vault credential can remain because they are not directly Auth-owned.
- X authorization revoke is not performed by Kabumori deletion.
- X social-mobile deletion has stronger cross-service/admin guards and service-specific cleanup, but must not be copied blindly.
- current production population has no user simultaneously classified as Kabumori + user-facing X workspace owner, so this is a latent boundary defect rather than evidence of an already-corrupted shared user.

Treat these as G5 findings to verify, not assumptions to silently trust.

## Review questions

1. Is the Kabumori hard-delete path actually reachable from current client UI and production deployment?
2. Exactly which shared/cross-service rows cascade or remain orphaned if Auth user is deleted?
3. Can an admin account currently delete itself through the Kabumori path?
4. What is the smallest safe interim guard before common-account orchestrator exists?
5. Should the interim path fail closed when any of the following exist:
   - admin ownership
   - X/social-mobile user-facing membership/workspace ownership
   - active/pending posting OAuth state or other service footprint
   - any other shared-account evidence found in source/production metadata
6. Does the interim correction preserve legitimate Kabumori-only account deletion?
7. Is server-side reauthentication/session freshness already adequate, or is a separate issue required? Do not expand into a large auth redesign in this TASK.
8. What regression tests prove “Kabumori-only may delete” and “other-service/admin footprint cannot be hard-deleted here”?

## Fix authority

Allowed only if review shows a bounded source-only fix:

- modify Kabumori account-delete Edge Function and narrowly related tests/docs
- add a server-side fail-closed pre-delete ownership/other-service guard using existing schema
- preserve current JWT verification and Auth ownership
- return a truthful non-success error requiring common-account/service-specific lifecycle handling
- add regression tests

Do not introduce common_accounts/service_entitlements yet.
Do not create/apply migrations or RLS changes in this TASK.

If safe correction requires schema migration, new lifecycle orchestrator, provider revoke redesign, or broad cross-service semantics, **do not implement**; report CHANGES REQUIRED for G5 Phase 1.

## Forbidden

- production deploy
- production DB write
- migration apply
- Auth user create/update/delete
- identity link/unlink
- X OAuth authorize/revoke
- Vault secret read/write/delete
- account deletion execution
- real X operations
- feature flag / Cron / secret / provider setting changes
- G3/G4 source changes
- common-account Phase 1 schema implementation

Read-only production metadata checks are permitted only if already available through safe authorized tooling; never expose PII/secrets.

## Required verification

At minimum:

- inspect account-delete source and client entry path
- inspect current FK/cascade ownership relevant to cross-service deletion
- focused account-delete tests
- static/type/lint/diff checks appropriate to changed scope
- tests for Kabumori-only allowed path if behavior preserved
- tests for admin and X-service footprint blocked path if implemented
- confirm no X revoke/Vault mutation is introduced into Kabumori service-only path
- confirm production mutation = 0

## Completion / C1

Append a new report to `.agent/CODEX_REPORT.md`.

Report:

- PASS / PASS-WITH-FIX / FAIL
- exact reviewed main/head and final head if source changed
- confirmed risk and affected boundaries
- findings by severity
- interim guard decision
- changed_files
- tests
- production mutation = 0
- whether source is safe to merge
- whether any production deploy is recommended/held
- what remains for G5 common-account Phase 1
- next recommendation

At completion: status -> review_required, next_owner -> chatgpt, STOP for C1.

## H1 completion — 2026-10-01 JST

- result: **FAIL / CHANGES REQUIRED** for the existing shared-Auth hard-delete boundary; review itself completed.
- independently confirmed production account-delete ACTIVE v8 / verify_jwt=true; both deployed source files byte-equal to reviewed main.
- P1: admin self-deletion is not guarded; X membership/OAuth-state cascades can leave workspace/social-account/posting credentials behind. No actual account deletion was performed.
- interim_guard_decision: no runtime fix. Separate read-only footprint checks followed by Auth DELETE retain a creation/deletion race. Existing X deletion acquisition writes tombstones/audit/posting state and has different service scope; copying it is not a bounded Kabumori guard.
- tests: focused 23/23 PASS; offline missing-guard/freshness probes 4/4 confirmed current behavior; targeted typecheck/runtime lint PASS. Combined test lint has five pre-existing require-await findings.
- reviewed main: startup 59108acab7c8445c169bbd05f24f10af4f120ce7; completion baseline 6e262b0b2f17386c55924f757c19abc7d48b89e8 (only G2 Report changed between them).
- runtime/source delta: 0; production mutation: 0; deploy: none. This TASK does not implement or authorize G5 Phase 1.
- full evidence / proposed acceptance tests: appended .agent/CODEX_REPORT.md section for this task_id.
- next: C1 review, then separately scope/authorize common lifecycle serialization, explicit service registration and recent reauthentication after G3/G4 conflict reconciliation. Recommendation: Sol（高）. H1 STOP.


## Final C1 — Common account deletion safety

- verdict: **FAIL / CHANGES REQUIRED accepted**.
- accepted finding: the existing Kabumori hard-delete route is not common-account-safe. Admin self-deletion and cross-service ownership/orphan risk are confirmed source/security defects.
- no runtime fix was accepted because a read-check followed by a separate Auth hard delete cannot serialize against concurrent service provisioning; a partial preflight would give false confidence.
- current production corruption was not observed; dual Kabumori+user-facing-X users were 0 at review time.
- production mutation from H1: 0.
- runtime source candidate: none.
- merge/deploy: none / HOLD.
- next step: G5 Phase 1 additive common-account/service-entitlement/lifecycle foundation, source-only. It must provide an explicit lifecycle/serialization primitive before the Kabumori hard-delete route can be considered safe.
- recommended G5 model: Opus5.5（極高）.

---

## Previous completed H1 task history — preserved below

# Codex Task

- task_id: kabumori-pr67-shared-report-v2-hard-fact-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: highest
- recommended_model: Sol（高）
- target: PR #67 exact head `5877045f7554cd4e089fb3b79091bf8e2bb38456`

## Purpose

PR #67 の shared market report Presentation v2 を独立レビューする。X約500字・App長文・Hard Fact / Quality WARN境界を、1つのshared fact spineを壊さず安全に成立させることを確認する。

**source/test review only**。merge / deploy / gate ON / real X post / production mutationは禁止。

## Accepted G2 evidence

- PR #67: open / mergeable=true / 27 files / +4622 -146.
- main-side 10 commits after PR base have no overlap with PR #67 runtime files.
- reported: analysis 73/73, personalized 128/128, X shared 8/8, data-packet 42/42, _shared 329/329, historical Fact-passed packet replay 8件で新Hard誤検出0, check/lint/diff PASS.
- production mutation=0; app_enabled=false / x_enabled=false.

## Mandatory startup / isolation

1. PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, G2 Report, DESIGN §15 を読む。
2. H1独立worktree/checkoutを使う。G2/H2/G1/G3/G4と共有しない。
3. fresh origin/main と PR #67 exact head を取得し、headが変わっていたらSTOP。
4. H2はPR #66をreview中。H2のTASK/branch/filesを触らない。

## Review priorities

### A. Hard Fact guard — 最優先

`hard_fact_guards.ts` と `analysis_logic.ts` integrationを深く確認する。
- metric/value mismatch
- metric/session-date mismatch
- 2026-10-01 mixed-session exact regression
- reused metricが元session_dateを保持
- staleをfresh/currentとして出さない
- direction/polarity/sign/emoji inversion
- 1306をTOPIX indexと誤認しない
- unsupported causality
- fabricated metric/news/ref/entity
- broad false absence claim

False negativeだけでなくfalse positiveも見る。『理由不明』『材料が薄い』『文体弱い』は、正直に書ける限り配信停止要因にしない。

### B. Hard BLOCK vs Quality WARN / rewrite fallback

`localAnalysisCheck`, warning codes, `qualityRewriteHints`, generation flow, handler diagnostics, delivery-policy分類を確認。
最低限次をadversarial testする：
- safe original + WARN -> rewrite Hard
- safe original + WARN -> rewrite Fact fail
- gen1 Hard -> gen2 safe
- invalid output -> next generation safe
- persistent Hard
- transport 429 around quality rewrite
- sparse/no evidence

確認条件：WARNだけではcycleを落とさない。rewriteがHardなら元のsafe draftへ戻る。call loopは bounded。content regeneration / Fact-local rejection / transport retry / cron retryを混同しない。

### C. v1 backward compatibility

`_shared/market_report_packet.ts`, `market_report_story.ts` を確認。
- 保存済みv1 packetが読める
- v1 X formatterの既存挙動を壊さない
- v1 fallback storyが事実を捏造しない
- DBのschema_version checkを破らない
- migration不要という判断がJSON payload実装上正しい
- report_packet_id/content_hash semantics維持

### D. Public X contract / privacy

- rich v2 section order, exactly 3 points, optional context/news/watch
- length targetはWARNでありFact blockではない
- hard min/maxは投稿不能保護として妥当
- URL/hashtag/internal field/user portfolio漏洩なし
- X consumerが独立再分析しない
- warning telemetryがsafe postを誤blockしない
- ~500日本語文字の投稿権限/契約がsourceから証明できなければ activation prerequisite として記録する

### E. App story / personalization boundary

- App storyはshared evidenceだけで長文化
- market-wide storyは全ユーザー共通
- personalized layerはholdingsを足してもshared market facts/directionを書き換えない
- user/portfolio dataがshared packet/storyへ漏れない
- native UI未対応は別G1 taskとして残す

### F. News priority / absence claims

- broad > sector > company がdeterministic
- isolated company criticalが市場全体storyを機械的に占有しない
- company itemはkey_newsやMy Portfolioで扱える
- category/company-code scope inferenceに明白な誤分類がない
- scoped absence（例: この銘柄の個別ニュースは確認できない）を誤blockしない
- 旧経路で出たfalse absence文はblockする

## Required verification

- market-report-analysis full suite + presentation_v2
- hard fact/date/session regressions
- handler/regeneration diagnostics
- transport retry suite
- personalized-reports full suite + shared story + absence regressions
- X shared consumer full suite
- data-packet regression
- _shared relevant/full suite if feasible
- deno check / lint / git diff --check

見つけた穴にはfocused adversarial testを追加する。

## Fix authority

小さく決定的なP1/P2/P3なら failing test -> minimal fix -> rerun を許可。PR #67 scope内だけ。
architecture変更、DB/schema/migration、model-call architecture変更、product semantics大変更が必要なら修正せず CHANGES REQUIRED でG2へ返す。

## Forbidden

- production deploy / DB write / migration / cron / gate change
- real X post / manual production cycle
- legacy X/App generator fix
- G1 native UI implementation
- important-news/API最適化変更
- H2/PR #66変更

## Completion / C1

`.agent/CODEX_REPORT.md` に新しいH1 reportを追記し、過去履歴を消さない。
reportには verdict, original/final head, findings severity, Hard-vs-WARN, mixed-session, rewrite/fallback/call budget, v1 compatibility, X privacy/output, App shared/personalized boundary, news priority/absence, tests, changed_files, production mutation=0, merge recommendation, rollout prerequisites を含める。

完了時: status -> review_required / next_owner -> chatgpt / STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **PASS-WITH-FIX (source/tests)**; STOP for C1, no merge/deploy/activation.
- original head: `5877045f7554cd4e089fb3b79091bf8e2bb38456`.
- final source head, pushed to PR #67: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9`.
- corrected deterministic guard holes and false positives, malformed nested-output handling, exhausted quality-rewrite request fallback, and actual model-input news ordering; added 13 executed adversarial tests.
- analysis 86/86 (presentation 22 + H1 adversarial 13 included); personalized 128/128; data-packet 42/42; X shared consumer 8/8; `_shared` 329/329 with --no-check. Target runtime check/lint/diff PASS.
- existing `_shared` whole-suite type errors are documented separately; not a claim of a repository-wide clean typecheck.
- production mutation=0. Actual v2 model output, ~500-Japanese-character X API posting entitlement/contract, and native story UI remain rollout prerequisites. Detailed findings and limits are appended to `.agent/CODEX_REPORT.md`.


## Final C1 — PR #67

- verdict: **PASS-WITH-FIX / accepted**
- original G2 head: `5877045f7554cd4e089fb3b79091bf8e2bb38456`
- H1 reviewed/fixed final head: `d6f9c9a0285920871d0ce86cc4559f9675c0ebb9`
- H1 fixed nine demonstrated P2-class issues, including:
  - safe-original loss on quality-rewrite request failure
  - malformed nested-output parser escape
  - metric value/change/date association holes
  - stale-as-current wording
  - mixed-direction emoji escape
  - historical assertions in watch/caution escaping factual guards
  - scoped absence false positive
  - negated direction false positive
  - model-input news ordering contradicting broad-first policy
- final verification accepted:
  - market-report-analysis 86/86
  - H1 adversarial 13/13
  - personalized-reports 128/128
  - market-report-data-packet 42/42
  - X shared consumer 8/8
  - _shared 329/329 with --no-check
  - target runtime check/lint/diff PASS
- production mutation from H1: 0
- fresh-main overlap check before merge: no runtime-file overlap with PR #67.
- PR #67 final head was mergeable and was merged by ChatGPT.
- merge/main SHA: `09975d02cc81b1614818951173a94aa8677291a0`
- consumer gates remain OFF; this C1 does not authorize app/X activation.
- rollout prerequisites still include:
  - actual live-model v2 generation observation
  - actual X long-post entitlement/provider acceptance before x_enabled
  - native App story UI integration before app consumer activation

---

# Previous completed H1 task — preserved history

# Codex Task

- task_id: x-social-mobile-pr65-ephemeral-x-auth-session-review-20261001
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Sol（高）
- target: PR #65 exact head `e8a7785d5635096aa428899d28e629a95b7e3f31`

## Purpose

Focused pre-merge OAuth/authentication-boundary review of the iOS X posting-account connection change that requests an ephemeral/private auth session so a previously logged-in X account is not silently reused.

This is a source/security review only. Provider-side live account switching remains an operator E2E check and must not be simulated with protected production accounts.

## Verify

### 1. Expo API / platform behavior
- installed `expo-web-browser 57.0.3` actually supports `AuthSessionOpenOptions.preferEphemeralSession`
- the option is valid for `openAuthSessionAsync` and is iOS-scoped as claimed
- implementation passes `{ preferEphemeralSession: true }` only on iOS
- Android/Web behavior is not unintentionally changed
- no native rebuild/config/plugin change is required beyond the existing expo-web-browser native module already in the development build; flag uncertainty if this cannot be proven from source/package state

### 2. OAuth security invariants
- authorization URL host/protocol validation remains unchanged
- state generation/verification remains unchanged
- PKCE verifier/challenge generation remains unchanged
- callback redirect validation remains unchanged
- callback request body and ownership binding remain unchanged
- no undocumented X parameters were added
- no global cookie/browser-data clearing was introduced
- duplicate-X-account server protection is untouched
- no token/Vault/DB/Auth/server-side write path was changed

### 3. Session/account-selection semantics
- ephemeral session is an appropriate way to avoid sharing normal Safari/browser cookies for this posting-account connect flow
- wording does not overpromise that an account chooser will always appear
- reconnect path uses the same behavior
- cancellation/dismiss/retry/error handling stays truthful
- assess the caveat that the browser/provider may ignore the request, and whether the current UX copy is sufficient

### 4. Tests
Review whether the new tests prove behavior rather than only source-string shape where possible.
Run/re-run relevant:
- focused X auth-session tests
- full social-mobile test suite
- typecheck
- lint
- any safe static/export checks useful for this boundary

If a test is brittle or gives false confidence, fix only narrowly within PR scope and report the new exact head.

### 5. Scope / safety
Confirm:
- PR changes only intended client files/tests
- no overlap with G3 E3 destructive verification
- no production mutation
- no real X login/post/revoke
- no DB/RLS/RPC/migration/Edge/Vault/Auth-provider mutation
- no secret leakage

## Provider-side E2E boundary

Do NOT attempt to type X credentials, use protected production X accounts, revoke any authorization, or post to X.

The operator must separately verify on a safe disposable account/device that the iOS auth sheet no longer silently reuses the previous X session and that a different X account can be authenticated.

Codex should state whether source is safe to merge **conditional on that provider-side E2E**.

## Completion / C1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- exact reviewed head
- findings and any fixes
- OAuth/security invariant result
- platform behavior result
- test evidence
- remaining provider-side caveat
- production mutation = 0
- whether PR #65 is source-safe to merge after operator E2E passes
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for C1.

## H1 completion — 2026-10-01 JST

- verdict: **PASS-WITH-FIX (tests only)**; no client runtime/security defect found.
- original reviewed head: `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- final reviewed/pushed PR #65 head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`.
- H1 replaced weak source-string assertions with executed hook/SDK-bridge tests; client behavior is byte-unchanged from the original PR head.
- focused 14/14, mobile 103/103, data-view/post-interaction 22/22, typecheck/lint/Web+iOS exports/diff checks PASS.
- source is safe to merge **after C1 and safe operator provider-side E2E pass**. Account switching on an actual device/browser remains unverified; keep merge hold.
- production_mutation=0; see `.agent/CODEX_REPORT.md` for evidence and caveats.


## Final C1

- verdict: **PASS**
- accepted PR: #65
- accepted exact head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`
- H1 disposition: PASS-WITH-FIX (tests only). Runtime/client behavior remained unchanged from original head `e8a7785d5635096aa428899d28e629a95b7e3f31`.
- H1-only source delta from original reviewed head: exactly one test file, `apps/social-mobile/tests/x-connect-auth-session.test.mjs`.
- verification: focused 14/14, mobile 103/103, data-view/post-interaction 22/22, typecheck/lint/Web+iOS exports/diff checks PASS.
- OAuth/security invariants accepted: PKCE/state/redirect/callback/host validation/server duplicate-account protection unchanged; no undocumented provider parameter; no cookie clearing; no DB/RLS/RPC/migration/Edge/Vault/Auth-provider change.
- production mutation: 0.
- merge decision: **HOLD** until safe operator provider-side E2E confirms a different X account can authenticate without silently reusing the prior normal-browser session, including cancel/retry/reconnect behavior.
- H1 is closed and free. G4 remains review_required for the operator E2E/merge gate.


## Final C1 — PR #76 publish-toggle review

- verdict: **FAIL / CHANGES REQUIRED accepted**.
- reviewed exact head: `a59a89e9c585fb6e780e1af2ecc898c830f5524e`.
- H1 source fix: none; the required correction crosses transaction/authorization/runtime publish boundaries and was correctly not improvised inside review.
- accepted P1 blockers:
  - membership authorization snapshot is not atomically bound to the privileged publish_enabled write;
  - brand active/live TOCTOU can combine with cached runtime context and permit a new publish path without a single current state where brand-live + account-ON were simultaneously authoritative.
- accepted P2 blockers:
  - zero-row reread can expose foreign-tenant current state after account movement/revocation;
  - ON readiness read/write predicates differ (including blank platform identity semantics);
  - ON confirmation is not pinned to the exact account/context shown.
- candidate tests passing do not override the independently reproduced adverse interleavings.
- PR #76 remains open/unmerged; merge/deploy prohibited.
- production mutation / real X operations from H1: 0 / 0.
- G4 corrective assigned: `x-social-mobile-publish-toggle-transactional-corrective-20261003`.
- required correction includes atomic caller/membership/brand/account/CAS authorization boundary plus fresh pre-send permission verification and client confirmation pinning.
- G4 recommended model: **Opus5.5（極高）**.
- after G4 correction, independent rereview required; recommended Codex model: **Sol（極高）**.
- H1 closed and reusable after fresh allocation.


## Final C1 — PR #79 hard-guard review

- verdict: **CHANGES REQUIRED accepted**.
- reviewed runtime head: `9ce344b78f23f3bfc1cf033031f1c6ea6bf16fa3`; unchanged/open/unmerged.
- H1 found three required corrections:
  1. **P1**: `HYPOTHETICAL` can erase an already asserted wrong-date/direction fact when a later hypothetical tail exists.
  2. **P2**: ordinary prior-night watch wording still false-rejects and can cause delivery churn.
  3. **P3**: changed-file lint is not clean because `directionIn` is now unused.
- H1 test-only evidence commit: `6140968378c44aecd2d40a1cc7d344f2e98e8b4e`; not a runtime release candidate.
- no merge/deploy/production mutation.
- PR #79 returns to G2 for a narrow source correction; recommended Claude model **Opus5.5（高）**.
- after correction, another focused Codex review is required before merge/deploy.



## Final C1 — PR #79 accepted and merged

- verdict: **PASS-WITH-FIX / accepted**.
- original rereviewed PR head: `f7083ba6a810d5f9cdbe7090e4439f261e38bf0f`.
- exact H1 reviewed/fixed source: `b6d2dce3cc45c73951e51d139fefeddad7e2906e`.
- H1 fix branch was a direct one-commit descendant of the PR head.
- C1 fast-forwarded the existing PR #79 head branch to that exact H1 fix with no force.
- fresh read-back confirmed PR #79 head exactly `b6d2dce3cc45c73951e51d139fefeddad7e2906e`, mergeable=true, with no overlap against fresh main.
- PR #79 merged -> main `4dbf11f2848059cc967d942efc9d60613d855537`.
- accepted H1 verification:
  - market-report-analysis 136/136
  - session-date 14/14
  - H1 boundary 9/9
  - personalized 128/128
  - X shared consumer 8/8
  - data-packet 42/42
  - _shared runtime 361/361 with --no-check due documented pre-existing unrelated checked-type debt
  - explicit target checks / changed-file lint / diff PASS
- accepted bounded fixes include:
  - `続くから/するから/なるから` no longer masquerade as questions;
  - asserted continuative premises remain factual;
  - bounded honest degree-modifier questions remain deliverable;
  - ordinary prior-night reaction-watch prose no longer trips the causal Hard checker when the effect is purely terminal watch text;
  - actual/speculative market effects and wrong-date/sign/ref facts remain protected.
- production mutation from H1/C1 = 0 except normal GitHub branch fast-forward + merge; no Edge deploy/gate/manual cycle.
- next rollout: one controlled `market-report-analysis` deploy containing already-merged PR #77 + accepted PR #79, app/x gates OFF, exact source read-back, then natural-cycle observation.


## Final C1 — PR #82 AI Lab event dedupe

- verdict: **CHANGES REQUIRED accepted**.
- reviewed exact head: `08a7346ccd63f2ff540bd48149f1f1e65e6dbe09`.
- accepted P1 blockers:
  - two concurrent schedules can read the same unused event and both reach X before any usage row exists;
  - X success followed by usage-persistence failure allows the same event to become eligible on a later slot;
  - confirmed-X/before-usage and lost-response crash windows have no durable event ownership.
- accepted P2 blockers:
  - ordinal `diary-YYYY-MM-DD-N` IDs are not durable under same-date insertion/reordering/parser removal;
  - conflicting duplicate scheduled_post_id can be silently ignored while reporting persistence success;
  - exhausted evergreen pool can bypass the stated 72h cooldown;
  - migration reapply silently accepts unsafe drift such as missing PK/CHECKs or wrong index.
- H1 evidence branch `codex/h1-pr82-event-review-20261003` commit `100ab65f8142adc11916f467f68415d15cbc00b1` is RED evidence only and must not be merged as a release candidate.
- PR #82 remains open/unmerged. Production mutation / real X / deploy = 0.
- correction must use stable immutable event identity and durable pre-X event claim/reservation semantics with safe ambiguous-outcome handling; scheduler spacing is not a correctness guarantee.
- G3/G4 are currently occupied, so no slot is overwritten. Return via direct Claude instruction in an independent worktree.
- recommended Claude model: **Opus5.5（高）**.
- corrected candidate requires fresh Codex rereview: **Sol（高）**.
- H1 closed and reusable after fresh allocation.


## Final C1 — PR #82 durable-claim rereview

- verdict: **CHANGES REQUIRED accepted**.
- reviewed exact head: `9f3b19a3cde490cf63735220ae191dcd4f11bdcb`.
- accepted improvements:
  - ordinary two-worker diary race is closed under actual SQL-backed dispatch;
  - provider_started precedes X without holding a DB transaction across X;
  - claim_id fencing/lease prevents stale worker start/release/settle;
  - settle failure after confirmed X retains a blocking claim and does not reopen the diary event;
  - exact settlement/idempotency conflicts are materially improved;
  - normal evergreen pool exhaustion no longer uses the old least-recent bypass.
- accepted remaining blockers:
  - P1 duplicate `event_id:` labels within one diary entry silently overwrite identity in runtime and current workflow validator, reviving a previously consumed event under a new key;
  - P2 migration drift/ACL proof does not reject unsafe table/function ownership or inherited effective privileges;
  - P2 real VaultAccountXAuth 401 maps to typed errors not recognized by the dispatcher release classifier, leaving a proven no-post case permanently ambiguous;
  - P1 unresolved evergreen provider_started/ambiguous rows become reclaimable after 72h/48h solely by age, allowing a possibly-posted seed to be sent again;
  - P2 confirmed evergreen cooldown uses claimed_at rather than published/settled time;
  - P2 RPC candidate JSON accepts extra keys and non-canonical event/theme mappings, allowing cooldown/theme checks to be bypassed by malformed service-role input;
  - P3 changed test files introduce net-new require-await lint debt.
- H1 evidence branch `codex/h1-pr82-claims-20261004` commit `0801619f4bcd882dadc71deab5cd07493a7ea80a` is RED evidence only; do not merge as release candidate.
- fresh main has advanced and now overlaps PR #82 in the canonical diary MD + snapshot. Correction must preserve the latest main diary/topic-detail entry and re-generate snapshot; do not overwrite it.
- PR #82 remains open/unmerged; production mutation/read, real X/model/Vault/token operations, migration apply and deploy all remain 0.
- G3/G4 remain occupied, so no implementation slot is overwritten. Correction should continue as direct Claude work in an independent worktree.
- recommended Claude model: **Opus5.5（高）**.
- corrected candidate requires fresh Codex rereview: **Sol（高）**.
- H1 closed and reusable after fresh allocation.

