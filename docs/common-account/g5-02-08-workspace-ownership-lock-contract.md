# Workspace ownership lock contract: G5 eligibility × G3 notifications (G5-02 task 8)

**Source candidate. Nothing is applied anywhere. Production NO_GO.**

The candidate adds a **trigger on the shared table `public.brand_memberships`**. It needs the central room's explicit gate (and the review it decides) before any adoption. The local proof below is not that gate.

The files:
- the candidate: `supabase/candidates/postona_workspace_ownership_lock/` (install + rollback);
- the proof: `supabase/tests/postona_workspace_ownership_lock_run.sh` / `_test.ts`.

## 1. The problem

G3 PR #644 (`737074b2`, `018_postona_x_resv_approvals.sql`) writes a notification, and its outbox row, only while the workspace is still the person's own personal one. Its `notify()`:
1. takes **FOR SHARE**, in this order, held until COMMIT: the person's `public.common_accounts` row → the workspace's `public.brands` row → the person's owner row in `public.brand_memberships`;
2. then INSERTs, checking G5's S2-3 (`private.postona_personal_workspace_eligibility(...) = 'own'`) in that new statement.

A DELETE or UPDATE of any of those three rows waits for `notify()`, and `notify()` waits for it. G3 states the gap itself: a change made only by **INSERTING** a row locks nothing `notify()` holds.

S2-3 answers `own` only when four things all hold:
- the derived brand exists, of kind `social_mobile_user_v1`;
- it has exactly one membership, which is the person as owner;
- the person owns no other brand.

So all of these end it, without touching any locked row:
- another member or owner joining the workspace;
- a member moving in (an UPDATE of someone else's row);
- the person becoming the owner of another brand.

Who can make such a write (measured in G4's personal world):
- the table's owner;
- **service_role**, directly (Data API `INSERT` / `UPDATE` on `brand_memberships`);
- definer RPCs: the X OAuth begin, G4's personal provisioner, G5's W0.

`anon` / `authenticated` cannot.

**Measured before (G3 PR #644 alone), each of the 5 writes:**
- notify first: the write did **not** wait, and committed while the notification, already checked, was still being written;
- change first: the notification **was written (+1 notification, +1 outbox row)** for a workspace no longer personal.

## 2. The contract

**Every write that can change a person's personal-workspace eligibility first holds that person's `public.common_accounts` row `FOR UPDATE`. Writers lock in the order account → brand → membership** (the order of G3's FOR SHARE).

| write | how it holds the account first |
| --- | --- |
| service start / end / restart, account lock / deletion (P1) | P1's lifecycle lock (account FOR UPDATE); T13 |
| W0, G4's personal provisioner, the X OAuth begin | T13 first, then brand, then membership |
| a workspace deletion / a brands UPDATE | the brands row lock meets G3's FOR SHARE |
| the person's owner row DELETE / UPDATE | that row lock meets G3's FOR SHARE |
| **any other membership INSERT / UPDATE** (another member or owner, a member moving in, the person owning another brand; by any role, service_role through the Data API included) | **this candidate's trigger** |
| another member's row DELETE | not needed: it can only make the workspace personal again, and a notification for an own workspace is correct either way |

**The trigger** (`postona_workspace_ownership_lock`, BEFORE INSERT OR UPDATE, FOR EACH ROW, on `public.brand_memberships`). For each row it locks `FOR UPDATE`, in `user_id` order, the account rows of:
- the row's person (before and after);
- every owner of the row's workspace (before and after).

The function is `SECURITY DEFINER`, owner-only, with an empty `search_path`. A writer that already holds the lock (T13) takes nothing new.

**Guarantee (measured after, the same 5 writes):**
- notify first: the write **waits until the notification commits**, and only then changes the eligibility;
- change first: `notify()` **waits for the change**, then writes **nothing** (0 notifications, 0 outbox rows).

The controls (owner row deleted, workspace deleted) behave as before.

**Deadlock rule.** A writer that locks the **brands row first** and then inserts a membership, while a notification holds the account, makes a cycle. PostgreSQL aborts one of the two (measured: 1 aborted; never both the member and the notification committed). Writers must follow the order.

**Not covered:**
- `session_replication_role = replica`: a superuser can bypass every trigger that way;
- TRUNCATE: its ACCESS EXCLUSIVE lock waits for, and blocks, `notify()`'s row locks anyway;
- changes outside S2-3: service end changes `common_accounts` and so waits, but `notify()`'s predicate does not read the entitlement. Whether a notification may be written after a service end is G3's predicate, not this lock.

## 3. For G3 and G1

- **G3 (#589):** nothing to change in `notify()` for this contract.
  - The order account → brand → owner row is the one the trigger relies on.
  - If G3 adds a write path that changes ownership, it must hold the account first.
  - If `notify()` must also stop after a service end, that is G3's predicate (read the entitlement in the INSERT).
- **G1 (#316):** nothing changes in the app. Membership changes have no app path.
- **The push worker** (reads the outbox) is a separate, separately reviewed step. Delivery authorization is not part of this contract.

## 4. Install / rollback

`001_workspace_ownership_lock.sql` runs as the owner of `public.brand_memberships` (not a superuser), with `ON_ERROR_STOP`.

Refusals (each changes nothing):
- `WO_SUPERUSER`;
- `WO_PREREQUISITE_MISSING`;
- `WO_NOT_OWNER`;
- `WO_TAKEN`;
- `WO_POSTCONDITION_*` (the exact trigger shape: tgtype 23, enabled, no WHEN, no columns; the definer function's ACL).

A re-run changes nothing.

`001_workspace_ownership_lock_rollback.sql` drops both objects, and the race is open again (measured: re-detected after the rollback, closed after a re-install).

## 5. Tests

Real local PostgreSQL 17, two or three live sessions per race, a test-only advisory barrier on G3's notifications. The world:
- G4's personal world at `c6df19cc`, built by G4's own runner;
- G4 PR #617's 006 / 007;
- G3 PR #644's own 17-step rollout.

All of these are read only, from temporary detached worktrees.

| part | what |
| --- | --- |
| setup | two people through G4's own sign-up → start → personal provisioner; S2-3 `own` |
| BEFORE | each of the 5 writes (member, second owner, the person owning another brand, a member moving in by UPDATE, service_role's direct INSERT) in both orders: FAIL reproduced; the 2 controls already serialize |
| install | superuser refused, nothing changed; idempotent |
| AFTER | each of the 5 writes in both orders: PASS; the controls unchanged |
| regressions | G4's provisioner still works; one notification per event key; the lock-order deadlock; rollback re-detects, re-install closes |
| mutants | 4 / 4: the workspace owners' lock, the row person's lock, the UPDATE event, the lock itself |
