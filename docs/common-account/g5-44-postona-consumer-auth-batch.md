# POSTONA's current consumers on the G5 auth candidate: one batch, and what each owner still has to change (G5-44)

Status: **source-only.**
- Not applied.
- No G3 / G4 / G6 / H file changed: their sources were loaded read-only from pinned heads.
- No G5 SQL changed: the G5-42 migration candidate and the G5-43 check are used as they are.
- Production **NO_GO**: PR #457 (P2) is still not accepted.
- TASK `common-account-g5-current-postona-consumer-auth-integration-offline-batch-20261028` (Issue #320, task 44, K5).

## 1. What was loaded, in one database, by the lifecycle owner

The `bt` world, in this order:
1. G5 migration candidate `20261028090000` (PR #539).
2. **G4** X `001`–`004` (PR #533 `98e5cf03`).
3. **G3** X OAuth T13 guard `postona_x_oauth_t13_guard/001` (wraps G4's begin / consume / complete).
4. G3 reservations `001`–`006` (PR #541 `8d49f94c`).
5. G3's own **test double** of G4's verified-X predicate.

**G6** (PR #500 `636c38b9`): the transport and authority port run in Deno, fed the real R1 answers.

Every file installed. There was **no grant on a G5 object**. The G5-43 read-only check found **nothing** (every consumer is the lifecycle owner's definer).

Runner / suite: `supabase/tests/postona_personal_auth_consumer_batch_pg_{run.sh,test.ts}` (PG17.11, fake data). **5 / 5 passed, 3 runs in a row.**

## 2. Measured answers (fake people: A = POSTONA started, C = never started)

| Path | Allow | Refused (code) | GAP (passes today, should not) |
| --- | --- | --- | --- |
| X connect: G4 begin / consume **wrapped by G3's T13 guard** | A begins and consumes | C: `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND`<br>service being ended: `SERVICE_DELETION_IN_PROGRESS` (begin and consume)<br>anonymous / no `is_anonymous` / ended session: `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`<br>A→B→A: `OWNER_EPOCH_CHANGED` | — |
| X connect: **G4 alone** | — | — | C begins; a service being ended begins (**G4-1**) |
| G3 reservations via `postona_resv_api` | create / list / cancel for A | anonymous / no `is_anonymous` / ended session: `POSTONA_RESV_AUTH_REQUIRED`<br>service being ended, and C: `POSTONA_RESV_SERVICE_NOT_ACTIVE`<br>another person's account: `POSTONA_RESV_ACCOUNT_NOT_FOUND`<br>`authenticated` / `anon` / `service_role`: permission denied | a reservation is created right after A→B→A (no owner epoch on X reservations) |
| G6 transport + port on R1 `consult` | A: `allow` | `deny:AUTH_REQUIRED`, `deny:SESSION_EXPIRED`, `deny:ACCOUNT_NOT_FOUND` (C), `deny:SERVICE_DELETION_IN_PROGRESS` | — |

**Install order and withdrawal:**
- G3's T13 guard **before** G4 makes G4 `001` refuse with `G4X_PRECONDITION_BEGIN_BODY` (nothing created). The working order is G4 `001`–`004`, then the guard.
- With the batch installed, the G5 rollback refuses with `BUNDLE_ROLLBACK_CALLERS`.
- After withdrawing G3's guard (its rollback), the reservations schema and G4 `004`→`001`, the G5 rollback returns the **exact** pre-install catalog. ACL entries are compared sorted, because the guard's rollback re-grants in another order.

## 3. Implementation contract per owner (concrete; their TASKs decide)

| Owner | Change | Path | Privileges | Failure today | Done when |
| --- | --- | --- | --- | --- | --- |
| **G4** (+ G3) | **G4-1:** the X connect entry must call T13 (`private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')`) first. Either:<br>(a) adopt G3's wrapper, after G4 `001`–`004` (measured working); or<br>(b) put the call in G4's own begin / consume / complete.<br>**One owner** for these three functions; today two candidates replace them. | `supabase/candidates/postona_g4_x_oauth_personal_epoch/` (new file), or G3's `postona_x_oauth_t13_guard/001` | None. Install as the lifecycle owner; T13 stays owner-only. | `rv`: C, and a service being ended, begin an X connection. | The two `GAP G4-1` assertions in the suite become these refusals: `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` / `SERVICE_DELETION_IN_PROGRESS`. |
| **G4** | Optional precondition hardening (G5-43): begin / complete owner = the S2-2 owner, not a superuser. | X `001` (and Threads `001` / `002`) | None | — | G5-43's grant / superuser cases refuse at install. |
| **G3** | X reservations: bind the owner epoch at create (R1 `g5oe` or `account_lifecycle_brand_owner_epoch`) and W1 at claim / send. **After PR #457.** | `supabase/candidates/postona_x_reservations/` (new `007`) | None (lifecycle owner) | A reservation is created right after A→B→A. | The suite's `GAP` assertion becomes a refusal, and a reservation made before A→B→A is not published. |
| **G3** | Provide rollbacks for `001` / `002`. The Edge login role needs **SET** membership in `postona_resv_api`: the test world uses `grant postona_resv_api to <owner> with set true`. In production this is a deployment decision, made separately; G5 grants nothing. | `postona_x_reservations/` | Role membership (deployment) | Without it, `permission denied to set role`. | G3's own rollout doc. |
| **G6** | Nothing to change. Wire the transport to R1 after the candidate is applied. Map `ACCOUNT_NOT_FOUND` (never started POSTONA) in the UI. | `supabase/ai_gateway` | None (R1 is `authenticated`) | — | — |
| **H5** | Forward the verified `sub` / `role` / `session_id` / `is_anonymous` unchanged. Every missing or wrong one is refused above. | Edge auth | — | — | — |

## 4. Not verified here (and why)

- **G4 Threads `001` / `002`**, and G3 / G4 Threads publish: the PR #124 begin / complete stack and its binding chain are not in this world. S2-2 for Threads also waits on H5's `is_anonymous`.
- **G3 single post `005` / `006` at run time** (`post_now_*`): needs G4's credential source and verified predicate (a G3 test double stands in only for the predicate) and main's publish-authority tables.
- **G3 worker path** (`claim_due` / `pre_publish_check` / `finish`).
- **Managed:** owners / GoTrue / PostgREST / RLS.
- **Callers:** the Edge and the app, dynamic SQL.
- **Production.**

## 5. Still open

1. **PR #457** (P2, H3 stopped) blocks production. G3's epoch binding also depends on it.
2. The G4 ownership decision (no grant recommended, G5-43).
3. Who owns the X OAuth T13 call (G3's wrapper vs G4's bodies).
4. F-1 / P-1 – P-5 (user).
