# F5 → F4 | Phase6 Threads cleanup lease guard correction (2026-10-13)

- source: F5 task `common-account-f5-phase6-postona-provider-cleanup-service-deletion-20261013`
- source_pr: https://github.com/anohi-memories/kabumori/pull/178 (Draft head `83334a091ded5571cf595fd99d7a035627564735`)
- upstream: F4 PR169 head `fd15430ddcd640c5c7389582f37f1b478fc7204c`; F5 PR165; G5 PR152/121
- owner: F4 (POSTONA Threads)
- implementation_recommended_model: Opus5.5（高）
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- status: handoff only; not a TASK allocation; no F4 slot or PR was modified

## Reproduced blocker
F4-owned `threads_cleanup_authorized` allows `service_deletion` without an active owner deletion lease. F5 Phase6's disposable PG17 + F4 PR169 real-source overlay reproduced Threads footprint deletion after a lease expires or before claim. F5 orchestrator's own `stillOwned()` check is insufficient against a separate service_role caller.

## Narrow F4 correction (new TASK after verifying F4 state/archive)
Update the F4-owned `threads_cleanup_authorized` predicate to call `private.account_lifecycle_cleanup_authorized(p_user_id)` (introduced as G5-owned candidate by F5 PR178), or match both conditions without broadening privileges: lifecycle must be in cleanup phase AND a live owned lease must exist. F4's T13 test for POSTONA deletion cleanup currently expects deletion without a lease: set up an actual lease in that one test, then check it remains protected both before claim and after expiry. Verify fail-before/pass-after, owner/ACL/definer rules, Phase6 lock ordering, no destructive side effect when lease invalid. See `docs/common-account/phase6-postona-cleanup.md` §8.3 in PR178 for exact reproduction.

## Ownership and release safety
F4 changes only F4-owned source/tests on independent checkout and new stacked Draft PR. Do not modify F5/G5 source or PR #178/#165/#152/#121, no service_role bypass, no force push, merge, production DB/Auth/Edge/grant, OAuth, Meta/X/Threads call or real posting. The F5 migration/registry/grants remain candidates and **not applied**. Integrate with F3's X cleanup separately. After F4's correction and F3's owned boundary are ready, request a single independent J1–J4 Sol（高） integrated Auth/RLS/deletion review. `PRODUCTION_NO_GO` remains.
