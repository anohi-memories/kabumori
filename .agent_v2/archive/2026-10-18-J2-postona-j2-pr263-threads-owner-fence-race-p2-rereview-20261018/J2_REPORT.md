# J2 Report — PR263 checked-owner race focused rereview
- task_id: postona-j2-pr263-threads-owner-fence-race-p2-rereview-20261018
- slot: J2
- status: review_required
- next_owner: chatgpt
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: V2
- recommended_model: Sol（高）
- result: PASS_FOCUSED_REVIEW / F5_ACK_PENDING / PRODUCTION_AND_PILOT_NO_GO
- findings: no P2+ defect found in the assigned PR263 correction
- target_pr: https://github.com/anohi-memories/kabumori/pull/263
- target_head: a1cc77e4cb3b09b0775a7e60c2c76fecd18f3705
- base_head: 713955b5371cf4f1de4681ecec1737e1ccc7d4cd
- main_start_and_prepublication: 8bab7f4a0cbce164038346c9d66d9e58b89eae46
- implementation_commit: none (read-only source review)
- commit_hash: d88f96f526dc8a029fa7a7634d62404591bf0390 (review content and archive metadata; product-source commits0)
- push: SUCCESS; normal push to origin/main, fresh-fetch inclusion and GitHub exact Report content read-back verified at d88f96f526dc8a029fa7a7634d62404591bf0390; TASK/Report/ACTIVE J2 all review_required / next_owner chatgpt. This Report-only receipt records that completed publication.
- deploy: not performed

## Scope and conclusion

Reviewed exactly the four-file PR263 delta against PR258: candidate rotation SQL, rotation fixture SQL, rotation runner, and docs/postona/threads-credential-rotation-cas.md. No full PR258 or unrelated OAuth review. PR263 was rechecked OPEN / Draft / unmerged, same exact HEAD/base.

Original R1 is closed in the pinned real F5 SQL world. Claim chooses the person with F5's account_lifecycle_brand_owner and passes that explicit UUID to F5 before workspace locking (candidate202–205); after waiting it locks membership FOR SHARE and requires the same UUID (209–212). Rotate snapshots the person from the exact account/lease ID before F5 (285–292), then requires checked person = locked lease owner = locked membership owner (314–315). A successful F5 decision retains that person's I1 locks, so an ABA cannot substitute another person's lifecycle decision. No new owner is re-fenced under workspace/account locks.

Lifecycle → workspace → brand/membership → account → custody → lease order, wall-clock refusal, and fail-closed code mapping remain. Unknown/non-active F5 results and incompatible isolation refuse.

## PG17 tests actually run

Dedicated new PostgreSQL17.11 cluster: /private/tmp/j2-pr263-pg-20261018.TvjL9D; Unix socket/port58463, listen_addresses empty. Synthetic data/Vault stub only. Candidate runs as non-superuser table owner kb_threads_rot_owner_67565.

Commands:
```text
KEEP=1 THREADS_PGHOST=/private/tmp/j2-pr263-pg-20261018.TvjL9D THREADS_PGPORT=58463 THREADS_PGSUPER=j2_review_super PSQL=/opt/homebrew/opt/postgresql@17/bin/psql bash supabase/tests/postona_threads_rotation_run.sh
node /private/tmp/j2-pr263-independent-20261018.mjs
node /private/tmp/j2-pr263-catalog-20261018.mjs
bash -n supabase/tests/postona_threads_rotation_run.sh
git diff --check 713955b5371cf4f1de4681ecec1737e1ccc7d4cd..HEAD
```

| Verification | Actual result |
| --- | --- |
| Real pinned G5 T13/Phase4/F5/Phase6 + X/2a-2/PR124 + Threads publish/cleanup/disconnect world | PASS |
| Seven prerequisite refusals + reapply refusal | PASS |
| Existing single-session behavior | 14 sections PASS |
| Supplied two-session races (old10 + new3) | 13/13 PASS |
| PR258 candidate fail-before | All3 new races reproduce claimed / rotated / rotated |
| Mutations | 26/26 detected |
| Independent synchronized reproduction + stable controls | 9 scenario/control groups PASS |
| Catalog/body/ACL read-back; shell syntax; PR diff whitespace | PASS |

Independent harness uses the original J2 two-session protocol and pg_stat_activity Lock + pg_blocking_pids observation before committing owner mutation. Its assertions are outside repo; candidate/F5 functions are not substituted.

| Independent case | PR258 before | PR263 after |
| --- | --- | --- |
| Original claim: lifecycle wait; active A → ended B | claimed; B lease1 | OWNER_CHANGED; lease0 |
| Claim: F5 passed for A, workspace-lock wait, A → ended B | claimed; B lease1 | OWNER_CHANGED; lease0 |
| Rotate ABA: lease belongs to ended A, current active B → A | rotated using B's decision | SERVICE_NOT_ACTIVE; custody/Vault stub unchanged |
| Lease owner and membership rewritten P → Q while rotate waits | rotated | OWNER_CHANGED; custody/Vault stub unchanged |

Both claim cases observed real lock wait before and after. Fixed rotate ABA refuses immediately on ended lease owner (no wait expected). Unchanging active-owner claim/rotate succeed; unchanging ended-owner claim refuses SERVICE_NOT_ACTIVE. Repeatable-read claim refuses ACCOUNT_LIFECYCLE_BLOCKED.

Runner scratch: /private/tmp/kabumori-threads-rotation.6jrXJ9. Runner cleaned its generated DBs; reviewer DBs/logs retained in this private cluster. Server explicitly stopped; pg_ctl status confirmed no server running.

## F5 contract / catalog / ACK

Runner overlays five exact files from PR178 83334a091ded5571cf595fd99d7a035627564735 and verifies PR124 fixture/candidate byte equality with c30f246409a77080cbc03aef6c4cb72b5481e125. Catalog prosrc hashes independently compared with exact pinned source bodies:
- private.account_lifecycle_service_state_refusal(uuid,text): MD5 65cf14d7b350eb4b3150ec081d3d6842, exact match. READ COMMITTED; explicit person/service; login KEY SHARE → common account FOR UPDATE → entitlement FOR UPDATE; successful decision keeps locks to caller COMMIT.
- private.account_lifecycle_brand_owner(text): MD5 6a0fe098875e02814a81c37dbdc374a0, exact match. Single owner of social_mobile_user_v1 workspace or null. This resolves identity; lifecycle decision is separately locked.

All seven new functions: SECURITY INVOKER, same non-superuser owner, empty search_path; claim/rotate/release have3s lock_timeout. Lease RLS enabled. For anon/authenticated/service_role/authenticator: new-function EXECUTE0; lease-table privileges0; membership in owner role0. F5 helpers remain owner-only SECURITY DEFINER. No helper body/grant changed.

**F5 ACK is still required.** Local behavior proof is not agreement to treat private helpers as stable cross-owner interfaces. Exact coordination:
1. Approve F4 owner-channel use of account_lifecycle_brand_owner(text)->uuid|null and account_lifecycle_service_state_refusal(uuid,'x_autopost')->text|null.
2. Confirm single-owner rule, READ COMMITTED, I1 locks retained to COMMIT, lifecycle-before-workspace order, null only for active, refusal-code mapping; notify F4 before contract changes.
3. Accept claim checked UUID = later locked owner, and rotate checked lease UUID = locked lease owner = locked workspace owner; no re-fence of replacement identity under workspace locks.

H5 integration still needs dedicated owner transport/no user JWT and claim OWNER_CHANGED→no grant/busy; rotate OWNER_CHANGED→conflict, discard refresh output and do not write Vault. Rotated-only custody+same-secret Vault update in one transaction, publisher/refresh handshake and real Meta semantics remain separate unverified gates. No H5/F5 files modified; no messages sent.

## Startup / archive / publication

Fresh old/new ACTIVE_TASK and necessary CURRENT_STATE/F4/F5 metadata checked. Legacy slots done; F4 fix done; F5 preflight specification done; active F10 modifies orchestration candidates. No concurrent implementation owns these four source paths.

Clean review worktree: /private/tmp/j2-pr263-review-20261018.fSw1LX (exact target HEAD); record worktree: /private/tmp/j2-pr263-record-20261018.3GRpBO (fresh main). Formal main's pre-existing untracked supabase/.temp/ untouched.

Previous PR260 snapshot commit929870ce6cd67832b1d5ef95321dd51d918c7328 was missing integrity metadata. Exact-byte and Git-blob restore against original1f4667cd0c819346b48a82f4f87f3e55db3986bf PASS:
- TASK1690 bytes, SHA256 ca7e9fc5a7abcc0e54ab69523d2cd9484ddf45404c0fc30a3d6ab0e0e02d2c9f
- Report5040 bytes, SHA256 4005ed119bec129ada86aa0fb2d847d2f856e7052e3726297d581b27e200953c
Added append-only MANIFEST.md / MANIFEST.json / SHA256SUMS and HISTORY_INDEX entry; checksum2/2 PASS. Archived snapshots unchanged.

changed_files (records only):
- .agent_v2/tasks/J2.md
- .agent_v2/reports/J2.md
- J2 section of .agent_v2/ACTIVE_TASK.md
- appended J2 record in .agent_v2/HISTORY_INDEX.md
- previous J2 PR260 archive's new MANIFEST.md, MANIFEST.json, SHA256SUMS

Evidence SHA256:
- independent harness: 5e00a78c5e0a1c41c3c6d3fe1d6f3f926222b705ba56c3ca34df1ffebc020ed7
- catalog harness: d9a0c29e7ddeaaa11295403daeb4420d5b2c0d1bc8f6e172731ef77bf803a60d
- independent log: 029e7c92f625f5bb5fdae8487de3cf12ab756d298b169402f0c73e4dd82e35f8
- runner log: d4e9ad08ec48be1dfb88c0eb4b02050dfd0830d3c2caae7562e231787e978fd2

## Remaining issues / safety / next recommendation

No P2+ finding in assigned correction. Coordinator should obtain the precise F5 ACK above; keep production/pilot NO_GO until separately approved integration/managed gates. This review grants no merge/deploy/enable permission.

Product source changes0; merge/deploy/EAS0; managed/production DB/schema/RPC/migration/history/Cron/settings changes0; real secrets/token/Vault/OAuth/Meta/X/Threads/Push/OpenAI/paid API/SNS operations0. Authorized disposable local PG DDL/synthetic writes were executed (not global DB writes0). Other workstreams, local uncommitted changes, apps/admin and HANDOFF untouched. Supabase/Postgres skills informed actual ACL/RLS/lock-order verification.

POSTONA｜マルチSNS化・開発統括（G4）のちゃ へ V2 を送ってください。
