# POSTONA X connect on G5's personal MVP (g5pv) + the X verdict there (G4-02 #5, 2026-10-30)

task_id: `postona-g4-gen2-05-x-oauth-personal-g5pv-credential-verdict-product-integration-20261030` (Issue #561). Stacked on PR #579.

**Status:**
- source only; nothing applied or deployed; no grant;
- every gate is unchanged (the X disconnect gate is opened only in TEST worlds);
- PRODUCTION_NO_GO.

## 1. What changes, and what does not

**The problem.** G4's X OAuth (`postona_g4_x_oauth_personal_epoch/001`–`005`, reviewed X boundary) binds F5's brand owner epoch, which does not exist in G5's personal MVP:
- `001` / `005` require `private.account_lifecycle_brand_owner_epoch`;
- `require_owner_epoch(brand)` is recorded at begin and compared at consume and complete.

So X could not be installed on the personal profile, and G3's X verdict (G4-02 #4) refused there (`LINEAGE`).

**The personal build.** `supabase/candidates/postona_g4_x_oauth_personal_mvp/001_x_oauth_g5pv.sql` and `005_x_connect_lifecycle_t13_g5pv.sql` are **generated** by `supabase/tests/postona_g4_x_oauth_personal_mvp_build.py`. `--check` re-derives them byte for byte, and every replacement must match exactly once.

| | full (unchanged) | personal (generated) |
| --- | --- | --- |
| 001 authority it requires | S2-2, S2-3, F5 owner epoch | S2-2, S2-3, **G5 MV** (`postona_personal_worker_verdict`), **G5 brand owner**; F5's owner epoch must be **absent** (`G4X_G5PV_PRECONDITION_FULL_PROFILE`) |
| `require_owner_epoch(brand)` body | F5's owner epoch | the workspace owner's `lifecycle_version` (G5's g5pv generation), returned only while **MV = `active`** for exactly that value; otherwise G5's fixed code |
| 005 "same owner" list | … + owner epoch | … + MV + brand owner |
| begin / consume / complete / disconnect bodies, tables, 002 / 003 / 004, every rollback | — | **verbatim**: their md5 pins in 002 / 004 / 005 keep holding |

**Names.** The column `state_bindings.owner_epoch` and the helper keep their names, which is what keeps the reviewed bodies byte-identical. In this profile they carry the g5pv generation. A generation that moves between begin and the callback (service end + restart = ABA) is the reviewed body's `OWNER_EPOCH_CHANGED`.

**Not changed:**
- the X Edge;
- the app;
- G5 / G3 / H5 files;
- any grant;
- the verdict SQL (md5 Threads `fb93a0ad84c44c6781521eec4618fff4` / X `46643d50a4a6c6a82867061328de05bf`, as delivered in G4-02 #4).

## 2. What runs where now

| | full profile | personal profile |
| --- | --- | --- |
| Threads connect / verdict | yes | yes |
| X connect (app → Edge → SQL) | yes | **yes (new)** |
| X verdict (`postona_g4_credential.x_publish_credential_verdict`) | yes | **yes (new)**, same shape and same codes |
| service end + restart while at X | connects (owner epoch unmoved) | **refused** at the callback (`terminal_error` in the app, nothing written) |

The recommended profile is personal (1 person / 1 workspace, X + Threads). Install exactly one profile; mixing refuses:
- personal X 001 on full → `G4X_G5PV_PRECONDITION_FULL_PROFILE`;
- full X 001 on personal → `AUTHORITY_MISSING …owner_epoch`.

## 3. Tests (isolated PG17; fake GoTrue / X / Threads / PostgREST / Vault; measured)

**X app e2e** (`postona_g4_x_oauth_app_flow_run.sh`):
- mode `main` 8/8, `g4` 8/8, **`g4p` (personal) 8/8**.
- The path is the real app hook → supabase-js → Edge handler → SQL. The personal world is G5's own MVP world: the G5 chain `21a5cad4` + MVP_INSTALL `eebaabf2` (PR #563 `9846c0f0`) + the P3 test-world revoke.
- Scenarios: connect, reconnect, not started, anonymous, session switch, disconnect + reconnect, **service ABA while at X (new)**, service ending.

**X verdict behaviour** (`G4T_VERDICT=1`): **29/29 on full, 29/29 on personal**, through G4's real X SQL. The cases:
- connect, another person, absent, null;
- no token or secret id in the answer;
- a refresh-core write keeps the generation;
- reauth / uncertain / refreshing;
- connect pending, reconnect (new generation), connection error;
- disconnect (generation moved);
- service end, no lineage;
- **11 ABA between begin and complete:** personal `OWNER_EPOCH_CHANGED` and verdict `CONNECT_PENDING`; full completes.

**Mutants:**
- the refresh-state read removed → 3 cases fail;
- **the personal generation helper returning a constant → case 11 fails**.

**Install / no mixing / rollback:**
- the personal X installs, and so does the X verdict on it;
- each profile's X refuses on the other;
- the personal X rolls back with the full rollbacks (005 → 001) and the schema is gone;
- Threads verdict 001 checks (no binding, superuser, twice, 002 first).

**Regressions:** in the PR body / REPORT (Threads app e2e both profiles, bridge flow both profiles, G4-43, X, app, Deno, type and lint).

## 4. For G3 (#318) — the X / Threads verdicts are now usable on the personal profile

- G3 binds the same functions, owners and md5 values as in G4-02 #4 (`docs/postona/g4-publish-credential-verdict-for-g3-20261030.md`).
- On personal, install in this order:
  1. G5 MVP
  2. PR #124 + custody
  3. Threads g5pv 001
  4. Threads stack
  5. personal X 001
  6. X 002–004
  7. personal X 005
  8. verdict 001, then verdict 002
- G3's X generation compares `g4x1:<connection_epoch>`. The service generation stays G3's own (MV at send).

## 5. Review and open items

- **One focused review, together with G3's consumer change.** Scope:
  - the generated personal X delta (two preconditions + the `require_owner_epoch` body), plus the build script;
  - the verdict gate of G4-02 #4.

  Do not repeat H1-29 / H4-15. No review TASK was created.
- **Not claimed:** managed Supabase; real X / Threads / GoTrue; the Edge deploy; the device; owner transfer (outside the MVP); G5's profile decision (G5 #320 task 50 is active).
- **Open:**
  - G5 adoption / the real P3 revoke (G3 L-1);
  - H5 `bridgeFactory` (optional);
  - G1 / G2 callback, links and flags;
  - PR #124 authenticated EXECUTE stays NO_GO.
