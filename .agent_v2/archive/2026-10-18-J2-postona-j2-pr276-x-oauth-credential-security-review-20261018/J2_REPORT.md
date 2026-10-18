# J2 Report — PR276 focused OAuth / credential security review
- task_id: postona-j2-pr276-x-oauth-credential-security-review-20261018
- slot: J2
- status: review_required
- next_owner: chatgpt
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V2
- recommended_model: Sol（高）
- result: CHANGES_REQUIRED / P2x2 / PRODUCTION_AND_REAL_X_NO_GO
- target_pr: https://github.com/anohi-memories/kabumori/pull/276
- target_head: 39ab57ab3648a4c727be8a31366e4a03b2fad9fc
- base_pr: 126
- base_head: 65f49f98dab39b974e6e4b450f376a37f99ef1ac
- main_start: 41e7530fba350489119b16c247fd6fd52e47ab0c
- main_prepublication: 9bd9e8892dfeacf01c62f49b20481e402ab683a1 (later changes only F3/V3 records; no J2 overlap)
- implementation_commit: none; product-source edits0
- commit_hash: c2d302e75455d9b706ffa66107c881c41b4f0e4e (review records/archive metadata; product-source edits0)
- push: SUCCESS; normal fast-forward push to origin/main. Fresh-fetch inclusion and GitHub exact Report byte read-back verified at c2d302e75455d9b706ffa66107c881c41b4f0e4e; TASK/Report/ACTIVE J2 all review_required / next_owner chatgpt. This Report-only receipt records that completed publication.
- deploy: no manual deploy, merge or production operation performed

## Review result and scope

Two P2 source/protocol defects reproduced. No P0/P1 found in this focused review. PR276 remained OPEN / Draft / unmerged at the exact HEAD/base above. This is not evidence of exploitation of deployed endpoints: the new SQL grants no API role access, the adapter defaults OFF, and current Edge does not wire this port. Both findings concern the proposed owner-side credential protocol and must be resolved before integration/enable.

Read all eleven PR276 changed paths (not a full rereview of neighbor PRs):
1. docs/postona/x-identity-credential-m1-20261018.md
2. supabase/candidates/postona_x_identity_credential/001_x_identity_credential_candidate.sql
3. supabase/candidates/postona_x_identity_credential/002_g3_predicate_binding.sql
4. supabase/candidates/postona_x_identity_credential/002_g3_predicate_binding_rollback.sql
5. supabase/candidates/postona_x_oauth_hardening_candidate.sql
6. supabase/functions/_shared/social/x_posting_credential_source.ts
7. supabase/functions/_shared/social/x_posting_credential_source_test.ts
8. supabase/tests/postona_x_identity_credential_behavior.sql
9. supabase/tests/postona_x_identity_credential_e2e_test.ts
10. supabase/tests/postona_x_identity_credential_fixture.sql
11. supabase/tests/postona_x_identity_credential_run.sh

Neighbor PR257 K1–K6/C1–C5, PR262 enable semantics, PR272 sender, and PR275 B5/B7 were read for their interfaces. During review F3 completed PR278; its generation-port interface only was additionally read, not independently security-reviewed.

## R1 — P2: a legacy v1 overwrite can retain the signed attestation within one transaction

Location: 001_x_identity_credential_candidate.sql:103–107 (in particular107); attestation writer postona_x_oauth_hardening_candidate.sql:343–346, paired with verified_at=now() at335. Owner: F4/G4, with F3/v1 owner coordination if changing legacy completion or rollout restrictions.

The new attestation binds Vault IDs and verified_at, but not a write identity/token digest after the v2 write. Both v2 and the live v1 completion update existing Vault IDs in place and stamp verified_at with PostgreSQL now(), which is constant for the whole transaction. In one transaction, signed v2 completion followed by unsigned v1 completion for the same account/X ID leaves verified_at and both references equal to the v2 attestation. The attestation UUID and refresh generation also remain unchanged. The new predicate therefore accepts the unsigned replacement as the signed credential.

Actual PG17 reproduction (real candidates/guards; fixture only supplies fake initial Edge signature):
```sql
begin;
select xg.enroll(821);
insert into xg.ids values
 ('same_tx', xg.connect_v2(xg.uid(821),'j2txv2','8821','SIGNED'));
insert into xg.ids values
 ('same_tx_generation',
  public.x_account_credential_generation((select v from xg.ids where k='same_tx')));
select xg.connect_v1(xg.uid(821),'j2txv1','8821','UNSIGNED');
commit;
-- On a NEW connection, ask the real G4 predicate/token/generation functions.
```

Observed booleans: g4_verified=true; F3 bound predicate=true; token equals the unsigned-v1 fixture token=true; generation unchanged=true; timestamps equal=true. A separate connection after COMMIT still receives the unsigned replacement. Actual G4 adapter + unchanged PR272-identical F3 primitive publisher sends that token to a counting fake X once. Required safety result is unverified/null, mock send0.

Reachability limit: this specifically requires an owner/server path grouping both completions in one transaction. Normal separate PostgREST RPC transactions are not demonstrated as exploitable; no public-client multi-RPC transaction route was established. The unconditional source promise “a v1 overwrite is never attested” is nevertheless false, and the recorded token survives COMMIT. No real token/attestation key/provider call was used.

Recommendation: F4 must make every legacy credential overwrite invalidate signed provenance independently of transaction timestamps, or enforce/approve a rollout that eliminates the legacy writer before credential delivery. Use an explicit monotonic write/provenance version or equivalent atomic invalidation, coordinated with the legacy writer owner. Merely assuming now() changes per function call is insufficient. Retest same-transaction overwrite and post-COMMIT mock send0; do not silently change F3/F5 code or revoke live grants in this review.

## R2 — P2: owner A→B→A restores the old credential generation

Location: 001_x_identity_credential_candidate.sql:128–136 (hash inputs130–132), plus current-owner-only equality at109. Owner: F4/G4 generation contract; ownership-version/invalidation design coordinated with F5/F3.

The generation hashes attestation UUID/user/verification time/references and refresh generation. It contains no durable ownership-change version. Changing the workspace owner away from attested A makes the predicate/generation null, but restoring A restores the exact previous hash and token without new attestation or authorization.

Actual three committed transactions on the same real synthetic world:
1. A has a valid v2 attestation; capture generation g1.
2. Change the membership owner A→B; COMMIT. G4 token=null and generation=null (correct intermediate refusal).
3. Change B→A; COMMIT. G4 generation is g1 again; old attestation/token is accepted.

The unchanged G4 adapter plus the primitive publisher can fake-send once; a “generation now equals the value authorized before owner loss” check cannot distinguish this history. This violates the PR275 §6 request that generation change on owner change and the TASK's explicit ABA requirement. No token of B was returned; the failure is stale authorization/version revival, not proven cross-user secret theft.

Reachability limit: ownership changes were performed by the synthetic owner channel. No current end-user ownership-transfer API was asserted. F5 expressly guarantees only its call-time owner rule, not a durable owner epoch; a source consumer must not infer an ABA guarantee from that rule.

Recommendation: persist an ownership/provenance epoch or invalidate the attestation when ownership changes; alternatively prove and enforce immutability of this ownership boundary with owner ACK. Final-owner equality or a hash of the final row is not enough to detect a committed A→B→A. Add a regression demanding a new authorization/attestation (or irreversible denial) after owner loss.

## Existing tests versus independent evidence

All counts below were actually executed unless explicitly marked otherwise.

| Check | Result |
| --- | --- |
| Supplied postona_x_identity_credential_run.sh | ALL PASS, exit0 |
| Candidate001 prerequisites / 002 prerequisites / reapply | PASS (4 + 2 supplied refusals) |
| Supplied behavior | 9 sections PASS |
| Supplied snapshot races (v1 overwrite, owner transfer) | PASS |
| K1 with live v1 helpers | expected refusal reproduced |
| K1–K6 with TEST-ONLY v2 helper grants | PASS |
| Supplied F3 C1–C5 + primitive publisher E2E | 5/5 PASS |
| Supplied mutations | 14/14 detected |
| Typed adapter5 + PR126 RPC/attestation contract8 | 13/13 PASS |
| Independent PG cases | 12 safety/control PASS; 2 safety/contract counterexamples R1/R2 |
| Independent mock-send evidence | 3/3 reproducers confirm R1/R2 and the older F3 generation-fence limitation; NOT safety PASS |
| Actual catalog / F5 bodies / 002 rollback→DENY→rebind | PASS |
| deno lint (3 scoped TS files), deno check (2 modules), bash -n, PR git diff --check | PASS |

Why the supplied PASS does not close these findings: its v1 overwrite occurs in a later transaction, so verified_at differs. Its owner test stops with another owner; it never restores A. Its “last moment” E2E reads g1 but never passes an authorized generation to the primitive publisher, and all four mutations merely make the token getter refuse. A valid attested reconnect changes generation but that primitive publisher still fake-sends once. That last fact is the known F3 integration boundary, not a third newly assigned PR276 defect.

PR126's broader SQL hardening runner was implementer-reported RUN_PASS; it was not separately rerun here. The eight PR126 typed contract tests and real v2 functions in the focused PG world were independently exercised. No inference of actual managed Auth/Edge/provider correctness is made from these tests.

## Contracts / rollout / actual caller

- HMAC binds state ID, provider account ID, username and both token digests. Forged signature / another actor's state refuse; two simultaneous callbacks yield exactly one success and one refusal, one attestation. Source SQL errors/adaptor failures are fixed codes; adapter does not log or retain driver causes.
- Snapshot handoff correctly refuses unknown accounts, wrong current owner/brand, shared/dangling references, F5 inactive/deleting states, uncertain/reauth refresh states and expired tokens in the supplied tests. The two-hour initial access expiry remains an explicitly unverified provider assumption.
- Actual catalog: four new functions SECURITY DEFINER, empty search_path, same non-superuser owner. RLS on attestations. anon/authenticated/service_role/authenticator/postona_resv_api/postona_resv_worker have no EXECUTE on these functions, no attestation-table privilege and no membership in owner. The installer test owner has CREATEROLE to create F3 test roles; it is NOT the actual worker. Thus an actual worker credential channel is NOT delivered/validated by owner-run E2E; grant/transport design still needs approval.
- F5 helper prosrc matches current PR275 ec0b3a6f4432c1d01ba3671f57d8a508c06d8777 exactly: brand_owner MD5 6a0fe098875e02814a81c37dbdc374a0; service_state_readonly MD5 c5205d7c71dfbeec8620b081edab55e5. Its P5 file is byte-identical to pinned PR178. These are advisory reads, no lock spans X.
- Keep F3 001→002→003→004 before G4 binding002: F3 003 postcondition demands the shipped G4 DENY. G4 002 refuses a non-DENY body; rollback restores DENY and rebind was proved locally. F3 ACK remains a manual rollout gate; no candidate was promoted to a migration.
- K1 must use an actually attested v2 connection; do not weaken G4 to accept legacy client-stated identity. Existing v1 users require the reviewed reconnect/Edge/key/grant/revoke rollout. No backfill or live privilege change was performed.

Additional current interface BLOCKER (safe-stop, not a third security finding): latest fresh main9bd9e889 marks F3 M1-F1 done/none with L3 PASS_SOURCE_CANDIDATE and records Draft PR278 bf76a7c7b54ff8aa1155aace2045235e9408c18a. Its interface now requires credentialFor(account)->{token,generation} in one snapshot, 64-hex generation equal to F3's SQL x_credential_generation. PR276 supplies separate accessTokenFor / credentialGenerationFor and a different 32-hex MD5. The new F3 generationSourceOf rejects an accessor-only source; simple wiring is NOT compatible. G3/G4 must agree on one atomic generation-bound port/algorithm and run integrated negative tests. PR278's implementation/test claims were not independently rereviewed. The mock-send reproducers above use the primitive sender pinned identically to PR272, not the new PR278 full pipeline.

## Isolation / provenance / records

New dedicated PostgreSQL17.11 at /private/tmp/j2-pr276-pg-20261018.TJyuVg, Unix socket/port58476, TCP disabled. Synthetic fixtures, fake attestation key and stub Vault; Deno cached-only, no network permission / explicit deny-net for independent tests. Only psql against the explicit local socket was spawned. Server stopped after verification; pg_ctl status: no server running. Evidence retained:
- supplied combined tree: /private/tmp/kabumori-x-identity.yugJN1
- independent baseline tree: /private/tmp/kabumori-x-identity.eaqxXk
- final independent DB: j2_pr276_independent_1792312619053 (in stopped dedicated cluster)
- runner.log / independent.log / send-evidence.log / catalog.log in that cluster directory
- reviewer harnesses: /private/tmp/j2-pr276-independent-20261018.mjs; /private/tmp/j2-pr276-send-evidence-20261018.ts; /private/tmp/j2-pr276-catalog-20261018.mjs

Commands:
```text
KEEP=1 XG_PGHOST=/private/tmp/j2-pr276-pg-20261018.TJyuVg XG_PGPORT=58476 XG_PGSUPER=j2_review_super PSQL=/opt/homebrew/opt/postgresql@17/bin/psql bash supabase/tests/postona_x_identity_credential_run.sh
deno test --no-config --cached-only --deny-net --allow-read supabase/functions/_shared/social/x_posting_credential_source_test.ts supabase/functions/_shared/social/x_connect_rpc_contract_test.ts
node /private/tmp/j2-pr276-bootstrap-20261018.mjs
node /private/tmp/j2-pr276-independent-20261018.mjs
deno test --no-config --cached-only --deny-net --allow-run=/opt/homebrew/opt/postgresql@17/bin/psql /private/tmp/j2-pr276-send-evidence-20261018.ts
node /private/tmp/j2-pr276-catalog-20261018.mjs
```
Independent reproducer exit0 means it confirmed the two unsafe observations, not that their safety assertions passed.

Evidence SHA256:
- independent harness: c0d9685a6f36359e04983f41c0240b2ae93ea62acad6c83676ee832949b10eea
- mock-send harness: 083e7521be02693ee17d344b5a9d04b4b8d3d767404817e8982cc2868c2a369b
- catalog harness: 5da006edfd882c845a4aec1595b5c0c404538fcdbdbbcb45ea09392e1d3b1a39
- independent log: 83a6fbe366fcf1bd5f2b8657c1ff5ca434ece29e500d2bc1381772306ecde8fb
- supplied runner log: 5d5fc76a9230955ae30322382ffcb3284b27d900bd92a1ff2413534591df7e3f

Clean exact-head review worktree /private/tmp/j2-pr276-review-20261018.EGwBFF; independent record worktree /private/tmp/j2-pr276-record-20261018.5wdUXq. Fresh rule changes/V3 G10 pilot read; J2 remains v2. Frozen legacy .agent tree9a8d8e105c7e875d260e8f36db4271727379554d matches. Task_id appears in only the J2 TASK across old/v2/V3 task paths. F3 active source paths are separate and were only read as pinned Git interfaces. Fresh publication preserves F1/F3 updates; no source/worktree conflict.

Prior J2 PR263 archive verified against eee3a925e7dac4dacee97ba6d8f851743d0f93f2: TASK1939 bytes SHA256 92ba9bbb3f97b4d94617d08ee27cdeca8ee98bdd67b3c3f9e9e6b3bd33930325; Report9629 bytes SHA256 668d2983c70135c5703090459bf1982a8dd64b9638c1a50021bee50275a8fba9. Original/archive blobs and bytes equal, SHA256SUMS2/2 PASS; MANIFEST.md/HISTORY_INDEX already present. Add only missing MANIFEST.json; all existing archive bytes preserved.

changed_files (records only): J2 TASK; J2 Report; J2 section of ACTIVE_TASK; previous J2 PR263 archive MANIFEST.json. No product/test source was edited.

safety_checks: no managed/production DB, Auth, Vault, actual tokens/secrets, X/Threads/OAuth/Push/OpenAI/paid API, explicit deploy, merge, EAS or privilege changes. Local disposable SQL/synthetic writes ran and are not called global DB writes0. No settings/Cron/history repair; no other workstream or existing local change touched; apps/admin and HANDOFF unchanged. Supabase/Postgres skills used for actual ACL/RLS/ownership/snapshot checks. No external messages/PR changes made.

next_recommendation: G4 assigns the two narrow F4 fixes and coordinates the current F3/F5 atomic-generation interface; keep SOURCE_ONLY / MANAGED_NO_GO / PRODUCTION_NO_GO / REAL_X_NO_GO. No automatic implementation or rollout from this review.

POSTONA｜マルチSNS化・開発統括（G4）のちゃ へ V2 を送ってください。
