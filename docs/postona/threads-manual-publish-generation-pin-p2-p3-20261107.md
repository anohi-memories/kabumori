# POSTONA Threads manual publish — credential generation per attempt (P2) and the verdict pin (P3) (G4-02 #12, 2026-11-07)

task_id: `postona-g4-gen2-12-threads-manual-publish-credential-generation-and-verdict-pin-p2-p3-fix-20261107` (Issue #561).
Review fixed: H1 #40 (Issue #306, comment 6697134642): CHANGES_REQUIRED, P2 ×1 / P3 ×1 on PR #649 @ `99a6e24f`.
This branch is stacked on PR #649 (base = its head `99a6e24f81d9a34dbb185a6d66467c5fc7655f5b`).

**Status:** source candidates and local PostgreSQL 17 only. Nothing is applied, deployed or registered. Every gate stays as in
source (`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false`). Production stays NO_GO. The SECURITY DEFINER bodies changed here
(001's authorize, 002's begin and release) are **unadopted candidates that need review before adoption**.

## 1. P2 — an old attempt could still write after a reconnect

H1's reproduction: an attempt at `container_created`, the same person reconnects the same Threads user (same
`social_account_id`, same G5 `lifecycle_version`, only G4's `credential_generation` moves), then the old attempt's publish was
released and posted (+1). 001 asked "is the account verified now", never "is it still the connection this attempt began under".

**Fix: `supabase/candidates/postona_g4_threads_manual_publish_verdict/002_manual_publish_attempt_credential_generation.sql`**

| Part | What it does |
| --- | --- |
| New table `public.threads_manual_publish_attempt_generations` | `attempt_id` (PK, FK to the attempt, cascade) + `credential_generation` (`g4t1:<uuid>`). RLS on, **no policy, no grant to any role** (ALL revoked from PUBLIC / anon / authenticated / service_role). Only the owner's SECURITY DEFINER functions touch it. This is the only new DB object, on a G4-owned, unapplied candidate table; no shared schema / grant changes |
| `begin_threads_manual_publish` body | After authorize (which requires the verdict through 001), the verdict's generation is stored with the NEW attempt. A replay stores nothing |
| `release_threads_manual_publish_step` body, write steps only (`create_container` / `check_container` / `publish`) | With the attempt `FOR UPDATE` and the account `FOR SHARE` (authorize), the binding row is taken `FOR SHARE` to COMMIT, then the verdict is read. No stored generation (begun before 002), not verified, or another generation: the attempt is failed with the existing code `AUTHORIZATION_CHANGED` and the step refused `CONNECTION_NOT_VERIFIED`, **before the credential is read** (no token leaves, no provider call) |
| `confirm` / `reconcile` | Not gated: read-backs of a post that may exist stay possible and are never resent (001's rule) |

**Lock order.** The binding completion (both G5 profiles) locks `social_accounts` FOR UPDATE, then upserts the binding. The
release locks `social_accounts` FOR SHARE (authorize), then the binding FOR SHARE: the same order, so the two serialize and do
not deadlock. A reconnect committed first is seen by the verdict's own snapshot. A reconnect still open makes the release
wait, then refuse. A release that commits first makes the reconnect wait (measured in scenario 32).

**App / Edge:** no change in behavior. `AUTHORIZATION_CHANGED` already exists in the attempt CHECK, the Edge's code list and
the app's copy ("投稿の直前に条件が変わったため、送信しませんでした。"). Only the comment on that code in
`_shared/social/threads_manual_publish.ts` was corrected.

Bodies: begin `6ae40adbcd203592fbc3847c57f1bccf` → `7d26e42edaf3f7f85083880814983c2e`; release
`bd5bed5adcbef4d87614613f51c83dbf` → `e92ec523bb1a7a3ba7ca53dce744fb82`. Owners, ACLs, SECURITY DEFINER, `search_path`
and `lock_timeout` are unchanged (checked before and after in the same transaction).

## 2. P3 — the install did not detect a different verdict

001 (and now 002) refuse unless `postona_g4_credential.threads_publish_credential_verdict(uuid,text)` is the reviewed one,
pinned the way G3's `013_postona_threads_resv_g4_verdict.sql` pins it:
- body md5 `fb93a0ad84c44c6781521eec4618fff4` (the value G3 pins; measured equal on both G5 profiles);
- plpgsql, SECURITY DEFINER, STABLE, set-returning, result `TABLE(verified boolean, credential_generation text, code text)`;
- `search_path=""`;
- ACL not null and naming only this owner;
- no anon / authenticated / service_role / authenticator EXECUTE on it, nor USAGE on its schema.

Otherwise: `G4MP_PRECONDITION_VERDICT_UNPINNED` / `G4MG_PRECONDITION_VERDICT_UNPINNED`, nothing changed. 001's authorize
body is unchanged by #12 (still `f31f16d6ccbb4fc64946337325e93a35`). Not covered, by design and as in G3's pin: a verdict
replaced **after** the install (only the owner can do that).

## 3. Install order and rollback

Install: release candidate → verdict 001 → manual publish 001 → **002**. 002 requires 001's exact authorize body, begin and
release exactly as in the candidates, a non-superuser owner of all of them and of the attempt and binding tables, and the
binding keyed by `social_account_id` (both profiles).

Rollback: **002 rollback first** (restores both bodies byte for byte and drops the table), then 001's. 001's rollback now
refuses while 002 is installed (`G4MP_ROLLBACK_002_PRESENT`). After rolling 002 back the P2 gap returns: roll it back only
together with stopping manual publishing.

## 4. Measured (disposable PostgreSQL 17.11, UTF-8; fake Threads / PostgREST / GoTrue; the SQL is real)

Measured on 2026-11-10 (runner `G4T_APP_FLOW=1`, exit 0, `G4T_APP_FLOW_ALL_PASS`):

| Check | Result |
| --- | --- |
| e2e, full / personal profile | **32/32 / 32/32** |
| Fail-before without 002 (001 installed) | exactly **31, 32** fail. Old attempts posted: (a) publish +1, (b) +1, (c) container +1 / publish +1, (e) +1, (g) the server's create release `released` |
| Fail-before without 001 | exactly **30, 31, 32** fail |
| Scenario 31 after the fix | (a) / (b) / (c) / (e) / (g): `failed\|AUTHORIZATION_CHANGED`, publish +0. (d): uncertain → reconcile `published`, publish +0 (read-only). (f): new attempt `published`, bound to the current generation |
| Scenario 32 after the fix | (x) the release waited about 2.1 s for the open rebind, then refused. (y) the rebind waited about 1.9 s for the held release (`released:-`); the next write was refused. Publish +0 in both |
| 002 install checks | rollback refused before install; install, twice refused; owner / ACL / definer / settings unchanged; table RLS on, ACL owner only, 0 policies; 001 rollback refused under 002; rollback restores `6ae40adb` / `bd5bed5a` and drops the table; reinstall |
| 002 refusals | refused without 001, on other begin / release bodies, on a constant-true verdict (nothing changed), as a superuser, and on partial states (lone table / bodies without the table); a failing postcondition leaves nothing |
| 001 P3 | refused on a constant-true verdict (answers `true\|VERIFIED` for NULL input), an extra grant to authenticated, and `search_path = public`; authorize unchanged. The installed verdict md5 is `fb93a0ad...` |
| Mutants | no binding lock → 32 fails (x posted; y the rebind did not wait, 10 ms); no generation compare → 31 fails; gate on read-backs → 30 / 31 fail |
| `G4T_VERDICT=1` / `G4T_BRIDGE_FLOW=1` | ALL_PASS / ALL_PASS |
| Deno offline Threads suites / entry + composition / meta callback local HTTP | 211/211 / 14/14 / 10/10 |
| App unit tests (threads connect, iOS return, disconnect, manual publish) | 65/65 |
| Process gate (`index.ts` as in source) | 7/7 |
| `bash -n`, `node --check`, `deno lint`, `git diff --check`, secret scan | clean, 0 hits |

Covered:
- e2e (`G4T_APP_FLOW=1`), both G5 profiles, 32 scenarios. New:
  - **31** — a real reconnect of the same Threads user:
    - (a) container_created;
    - (b) H1's race, at the status read;
    - (c) while the container is created;
    - (d) uncertain → reconcile read-only;
    - (e) no stored generation;
    - (g) reserved through a direct RPC; forged attestation; the table out of every API role's reach; the server's release refused;
    - (f) a new attempt posts.
  - **32** — PostgreSQL races, (x) reconnect open first and (y) release first, with measured waits.
- Fail-before:
  - without 002, exactly 31 and 32 fail (the old attempts post);
  - without 001, 30, 31 and 32 fail.
- 002:
  - install, twice refused, rollback, reinstall;
  - refused without 001, on other begin / release bodies, on a constant-true verdict, as a superuser;
  - partial states refused;
  - a failing postcondition leaves nothing.
- Mutants: no binding lock (32), no generation compare (31), gate on read-backs (31).
- 001 P3: constant-true verdict / extra grant / changed `search_path` refused, authorize unchanged.
- Other other-person / brand / no token / stopped / expired / G5-ended cases: scenarios 25–27 and 30 run with 002 installed.

**NOT_VERIFIED:**
- a reconnect to a **different** Threads user (a re-bind is a new binding, so it changes the generation too, but it was not
  driven here);
- the real provider's behavior for a container made under the old token;
- real GoTrue / PostgREST;
- managed Supabase;
- a device.

## 5. Remaining

- Review of the changed SECURITY DEFINER bodies (001 authorize, 002 begin + release) before any adoption.
- The window between the release's COMMIT and the Threads HTTP request (milliseconds, at most the request bound) is still not
  closed: database locks do not span network calls. Every later write needs a new release, which now re-checks the generation.
- A reserved attempt whose create step never ran keeps the account busy until the next create release (which now fails it)
  or its 15-minute expiry. This is existing behavior: the Edge has no "drive reserved" action.
- G3's `beforePublish` hook and N1 / N5–N8 of `threads-meta-callbacks-delta-and-next-actions-20261106.md` are unchanged.
