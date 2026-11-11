# POSTONA Threads manual publish — an unknown outcome under an expired credential (P2) and the generation table's column ACL (P3) (G4-02 #15, 2026-11-11)

task_id: `postona-g4-gen2-15-threads-expired-credential-uncertain-reconcile-recovery-and-column-acl-drift-20261111` (Issue #561).
Review fixed: H1 #43 (Issue #306, comment 6790597991): CHANGES_REQUIRED, P2 ×1 / P3 ×1 on PR #652 @ `0381c704`.
Stacked on PR #652 (base = its head `0381c704c3d123621c02953d3e9f53ba17894cf0`).

**Status:** source candidates and local PostgreSQL 17 only. Nothing is applied, deployed or registered. Every gate stays as in
source (the connect entry and the publish entry stay hard-disabled). Production stays NO_GO. Three new SECURITY DEFINER functions
in G4's schema, the changed 002 postconditions / rollback, 001's rollback guard and G4's owner bridge are **unadopted candidates
that need review before adoption**. The fence, begin and release bodies are unchanged (`4992a4a1` / `7d26e42e` / `e92ec523`).

## 1. P2 — the deadlock

An attempt is `uncertain` (Threads may have posted; its answer was lost, or the server stopped) and the stored credential has
expired. Then (H1 #43, measured again here as the fail-before):
- reconcile needs a valid credential → `409 CREDENTIALS_EXPIRED`;
- the send fence (#14) refuses the reconnect that would bring a new credential → `COMPLETE_OUTCOME_UNKNOWN`;
- disconnect keeps the account while a post may exist → `stopped` / `PUBLISH_IN_FLIGHT`.
Nothing ever moves. Lifting the fence on a timer (#13's mistake), or on the credential's expiry (a database-clock judgement
again, and an expired token in a server's memory is not proof that the provider refuses it) is not acceptable.

## 2. The recovery contract: read before rebind

The only party that can still learn the outcome is the person, by granting a NEW token for the SAME Threads user. So the
recovery is part of their reconnect, and it happens BEFORE the binding moves:

| Step | Who / what |
| --- | --- |
| 1 | The person reconnects through the normal path (PR #124 begin / claim, G5 lifecycle, H5's code exchange, which reads `/me` with the new token) |
| 2 | G4's owner bridge (`postona_g4_threads_personal_auth/owner_bridge.ts`), before its completion transaction, asks `postona_threads_binding.reconnect_recovery_candidates(oauth_state, threads_user)` for the account's open attempts |
| 3 | For each, it reads with the NEW token — **GET only** (`reconnect_recovery.ts`: a fetch that refuses any other method, 4 s budget for all reads inside H5's 8 s deadline): the container status; for PUBLISHED, the listing and the post |
| 4 | Only **final** evidence is recorded, one transaction per attempt, by `postona_threads_binding.settle_attempt_before_rebind`: PUBLISHED → `published` (exactly one post with the exact text since the attempt began, with its permalink) or `published_unidentified`; ERROR / EXPIRED → `failed` CONTAINER_ERROR / CONTAINER_EXPIRED |
| 5 | The normal completion runs. If every open attempt was settled, the fence lets it through and the account is connected again; otherwise it is still refused (the person can try again later; nothing was stored) |

What it never does: write to Threads (no container, no publish, no resend), store the new token outside the normal completion,
lift the fence by time, or turn an unknown outcome into "not posted" (FINISHED / IN_PROGRESS / a failed, timed-out or foreign
read records nothing).

Who may record (all checked in SQL, `reconnect_recovery_account`, for every call):
- the caller is the person with an active session (`auth.uid()`, `auth.sessions`), G5's lifecycle fence passes
  (`threads_manual_publish_fence`), and they are an owner / admin of the account's workspace (`brand_memberships`);
- the OAuth state (`public.social_account_oauth_states`) of THIS connect was initiated by them, is not expired, and names that
  account;
- the token's Threads user (as H5's exchange proved it) is the account's `platform_user_id` AND the binding's `threads_user_id`;
- the attempt is that account's, still `publishing` / `uncertain`, has the SAME container id (compare-and-set, the row locked),
  and is bound to the binding's current generation (the one this reconnect replaces);
- only final transitions are accepted (`published` with a numeric post id and a threads.net / threads.com permalink;
  `published_unidentified` AMBIGUOUS / NOT_FOUND; `failed` CONTAINER_ERROR / CONTAINER_EXPIRED).
The three functions are SECURITY DEFINER (like `complete_and_attest_binding`, which the same bridge calls), `search_path=""`,
VOLATILE, executable by the owner only; no API role reaches them (no EXECUTE, no USAGE on the schema).

What the database cannot check: that the evidence really came from Threads for that container — the owner bridge made the read
(the same trust as every attested record). What is NOT_VERIFIED on real Threads: whether a token from a NEW grant can read a
container created under the old grant; how long until a FINISHED container reports EXPIRED; whether a container's status is
final and truthful.

Bounded failure semantics:

| Situation | Result |
| --- | --- |
| PUBLISHED, post identified | `published`, reconnect goes through, a new post can begin |
| PUBLISHED, post not identifiable | `published_unidentified` (a post exists), reconnect goes through |
| ERROR / EXPIRED | `failed`, reconnect goes through |
| FINISHED / IN_PROGRESS | nothing recorded, reconnect refused (`COMPLETE_OUTCOME_UNKNOWN`), try again later |
| read fails (5xx, network, token refused, another container's answer, budget spent) | nothing recorded, reconnect refused |
| another Threads user | no read at all; refused by the existing completion checks |
| a second settle / a concurrent reconcile | compare-and-set: `STALE`, nothing changed |
| a disconnect while unknown | unchanged: kept (`PUBLISH_IN_FLIGHT`); after recovery it can complete |

Shared contracts this does NOT change (and would need for a better UX): H5's runtime still reports any refused completion as
`COMPLETE_OUTCOME_UNKNOWN`; G1's screen has no "waiting for Threads / reconnect to check" copy; the app's reconcile button still
shows CREDENTIALS_EXPIRED for an expired credential (the way out is the reconnect). A support-side recovery (an operator reading
the container) is not built.

## 3. P3 — the generation table's column ACL

002's install postcondition and its rollback precheck now share one table predicate: RLS on, owner, owner-only table ACL, no
policy, exactly the three columns (`attempt_id:uuid, credential_generation:text, bound_at:timestamptz`, none dropped), **no
column ACL at all**, and no API role (anon / authenticated / service_role / authenticator) with any table OR column privilege
(`has_table_privilege`, `has_any_column_privilege`). A difference → `G4MG_POSTCONDITION_TABLE_ACL` (install, nothing left) /
`G4MG_ROLLBACK_TABLE_DRIFT` (rollback, before any change). The recovery functions have their own pinned signature
(`G4MG_POSTCONDITION_RECOVERY` / `G4MG_ROLLBACK_RECOVERY_DRIFT`; missing → `G4MG_ROLLBACK_NOT_APPLIED`). 001's rollback also
treats a recovery function as a partial 002 (`G4MP_ROLLBACK_002_PARTIAL`).

## 4. Behaviour change vs #14

A reconnect while an attempt is open now first reads the container with the new token. With final evidence it settles the
attempt and goes through (31 (d): lost answer, PUBLISHED → `published`, +0 sent; 33 (d): after the one send, PUBLISHED →
`published`). Without final evidence it is refused exactly as in #14 (33 (a) `publishing` + FINISHED; 33 (g) FINISHED; 34 (b)).
The fence itself (`4992a4a1`) is unchanged: no clock, `publishing` / `uncertain`.

## 5. Measured (2026-11-11, disposable PostgreSQL 17.11 UTF-8; fake Threads / PostgREST / GoTrue; the SQL is real)

Runner `G4T_APP_FLOW=1`, once per G5 profile, exit 0 `G4T_APP_FLOW_ALL_PASS`; every stage ran in both.

| Check | Result |
| --- | --- |
| e2e personal / full | **34/34** / **34/34** |
| Fail-before: #14's 002 exactly (`git show 0381c704:…`) | exactly **31 33 34** fail. 34 (a) = H1 #43: reconcile `409 CREDENTIALS_EXPIRED`, disconnect `stopped / PUBLISH_IN_FLIGHT`, reconnect `failed:COMPLETE_OUTCOME_UNKNOWN`, attempt stays `uncertain`, generation unchanged, no read, +0 sent; 31 (d) / 33 (d) stay refused without recovery |
| Fail-before: #13's 002 / PR #650's 002 / without 002 / without 001 | 33 34 / 33 34 / 31 32 33 34 / 30 31 32 33 34 |
| 34 after the fix | (a) the reconnect read the container, the listing and the post (GET only) → `published`, `verifying`, generation moved, +0 written; a new attempt then posted once. (b) FINISHED → refused, nothing recorded (1 read); a failed read (503) → refused; EXPIRED → `failed` CONTAINER_EXPIRED, `verifying`; a second settle → `STALE`. (c) ERROR → `failed` CONTAINER_ERROR. (d) PUBLISHED, post not identifiable → `published_unidentified` NOT_FOUND. (e) another Threads user → refused, 0 reads. (f) direct SQL: anon / authenticated / service_role → permission denied; another person's OAuth state / another Threads user / no such attempt → `NOT_PERMITTED`; another container / another generation → `STALE`; a non-final or write transition (STEP_INTERRUPTED, PUBLISH_OUTCOME_UNKNOWN, `publishing`) → `REQUEST_INVALID`; nothing changed. The connect side made 0 non-GET requests |
| Recovery mutants | no OAuth-state owner check / no container compare-and-set / no generation pin / non-final codes accepted → each fails 34 only |
| Fence and #12 mutants | INSERT-only → 33; `publishing` only → 33 34; no isolation guard → 33; no binding lock → 32 33; no generation compare → 31 32 33 34; read-backs gated → 30 |
| 002 rollback drift, before any change, catalog + bodies unchanged (25) | the 15 of #14, plus TABLE: column SELECT to authenticated / column UPDATE to service_role / column REFERENCES to PUBLIC / an added column / a dropped column; RECOVERY: SECURITY INVOKER / EXECUTE granted / `search_path` reset / body changed / an extra overload |
| H1 #43's fixture | a non-API role with SELECT on one column (table privilege false, column privilege true) → `G4MG_ROLLBACK_TABLE_DRIFT`, nothing changed |
| 002 install | a copy that grants one column → `G4MG_POSTCONDITION_TABLE_ACL`, nothing left; a lone recovery function → install `ALREADY_APPLIED`, 002 rollback `NOT_APPLIED`, 001 rollback `002_PARTIAL`; 002 → rollback → 001 rollback leaves no table / fence / trigger / recovery function |
| Deno: Threads offline + publish Edge / connect entry + composition / meta callbacks (+ local HTTP) / recovery + owner bridge | 183/183 / 14/14 / 41/41 / 9/9 |
| App unit / process gate | 65/65 / 7/7 |
| `bash -n`, `node --check`, `deno check` / `deno lint`, `git diff --check`, secret scan | clean / 0 hits |

## 6. NOT_VERIFIED / remaining

- Real Threads: a token from a NEW grant reading a container made under the old one; container status finality / truthfulness;
  how long FINISHED lasts. Real GoTrue / PostgREST, managed Supabase, a device, the G3 worker.
- The database trusts the owner bridge's read (as every attested record). DB COMMIT and the external HTTP request are not atomic.
- Liveness: a container that stays FINISHED keeps the reconnect refused until it reports a final status; each later reconnect
  reads again. No support-side recovery is built.
- UX (shared, not changed): H5's `COMPLETE_OUTCOME_UNKNOWN` for a refused reconnect; no G1 copy for "checking Threads before
  reconnecting"; reconcile still answers CREDENTIALS_EXPIRED for an expired credential.
- G1 #635 carries older copies of the e2e, the runner, the Edge test entry, `threads_manual_publish.ts` and its test.
