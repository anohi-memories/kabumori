# G4-02 #19, #20: G4's X send credential source for G3's send paths (local only)

Status: G4 SOURCE CANDIDATE. Nothing here is deployed. No real X OAuth, X post, token fetch, paid API, hosted or production read/write was made. PRODUCTION_NO_GO.
Issue #561 (G4-02, task 19). Base: PR #701 HEAD `1c2b239e86c5b7b56991bdb26105409b317291d2`. G3 source read (never changed): PR #699 HEAD `8ebf3a7b079a79817644a2317139c16cb7465ca4`.

## 0. G4-02 #20 (H1 #50 CHANGES_REQUIRED, P2×2): the read is bound to a send attempt and to the account's own Vault references

Status: G4 SOURCE CANDIDATE, local PG17 only. Base: PR #706 HEAD `2bc386b5268b02f27914bc69801ef8eeed3f5160`. G3 PR #699 `8ebf3a7b079a79817644a2317139c16cb7465ca4` read only. PRODUCTION_NO_GO.
Sections 1–6 below describe #19 and stay as its record; where they differ, this section is the contract.

**P2-1 (an account id was enough).** `public.postona_x_send_credential_v1(text)` is gone. 003 now installs
`public.postona_x_send_credential_for_claim_v1(p_reservation_id uuid, p_lease_token uuid, p_social_account_id text, p_session_id uuid)`
→ `(code, credential_generation, access_token, refresh_generation)`, one row always, EXECUTE for service_role only. Install refuses while #19's
account-only read exists, and refuses when any API role (service_role included) can read G3's `postona_x_resv.reservations` (the lease must stay a capability only the claimer holds).

A token is answered only when, in one transaction:

| check | refusal code |
|---|---|
| the attempt is G3's claimed reservation row with exactly this lease and account (unknown id, wrong lease, another account: one code) | `CLAIM_INVALID` |
| still `claimed` (published / failed / uncertain / cancelled / expired never read again) | `CLAIM_NOT_ACTIVE` (cancelled clears the lease: `CLAIM_INVALID`) |
| lease not run out | `CLAIM_EXPIRED` |
| user-authored text with intact consent (G3's `row_publishable` consent rule) | `CLAIM_NOT_PUBLISHABLE` |
| manual send (`claimed_by = 'single_post'`, draft `single:`): a session id is given and is a live `auth.sessions` row of the attempt's person; G3's `single_post_bindings` row matches person / workspace and has no recorded result | `SESSION_REQUIRED`, `SESSION_NOT_ACTIVE`, `CLAIM_INVALID` |
| worker: no session id; the claim pinned a generation (014) | `INPUT_INVALID`, `CLAIM_INVALID` |
| the account row (locked FOR SHARE) is in the attempt's workspace, whose single owner is the attempt's person | `CLAIM_INVALID`, `NOT_OWN_WORKSPACE` |
| G4's verdict 002 VERIFIED; on the personal profile G4's 007 precheck `allow` (G5's service generation) | the verdict's / precheck's codes |
| publishing on; no `revoked` stop in `public.x_account_publish_authority` (where it exists) | `PUBLISH_DISABLED`, `PUBLISH_AUTHORITY_REVOKED` |
| G3's derivation of the verdict's generation (`sha256('g3x1|' || 'g4x1:<epoch>')`) equals the generation the attempt bound | `CREDENTIAL_GENERATION_CHANGED` |

**P2-2 (Vault references not bound).** Before decrypting, 003 now refuses: both references not set (`CREDENTIAL_MISSING`); access = refresh (`CREDENTIAL_REF_ALIASED`); either reference used by any other account row, in either column (`CREDENTIAL_REF_SHARED`, the refresh core's rule); a secret whose name is not the one G4's connect gives it, `<account>_access_token` / `<account>_refresh_token` (`CREDENTIAL_REF_PURPOSE`: swapped, or a restored copy of another account's secret); a dangling or unnamed reference (`CREDENTIAL_UNREADABLE`). Only names are read for the refresh secret; it is never decrypted.

**Errors and logs.** A lock wait over 3 s answers `CREDENTIAL_BUSY`; any other error answers `CREDENTIAL_UNAVAILABLE`. No database text, reference or value passes (outer handler, plus a separate handler around Vault). The function has no RAISE / NOTICE. The TS source answers `null` for anything else, logs nothing and puts nothing into an error.

**TS.** `credentialFor(socialAccountId, { reservationId, leaseToken, sessionId })`. Without a well-formed attempt it answers `null` and does not call the database. The RPC body is `{ p_reservation_id, p_lease_token, p_social_account_id, p_session_id }` (the worker sends `null` for the session).

**What G3 has to change (G3's code; G4 has not touched it).** G3's port `credentialFor(socialAccountId)` passes no attempt, so **today G4's source answers nothing on both of G3's send paths** (fail-closed: `X_CREDENTIALS_UNAVAILABLE`, never sent). G3's change:
- manual send: `credentialFor(account, { reservationId, leaseToken: lease, sessionId: subject.sessionId })`, after `post_now_begin`;
- worker: `credentialFor(item.socialAccountId, { reservationId: item.reservationId, leaseToken: item.leaseToken })`, after `claim_due`;
- `xGenerationSourceFromG4Raw` has to pass the second argument through.

Contract differences to note for G3:
- the worker now also needs `publish_enabled` on; G3's worker check does not ask for it;
- the session is checked as "a live session of the attempt's person". G3 does not store which session began the manual send, so binding to *that* session needs a G3 column. Until then, G3's `post_now_preflight` re-checks the caller's session right after this read.

**P3 (a refresh between the read and the X call).** Unchanged by design: G4's generation does not move on a refresh, so an attempt keeps its token across one (case 19: the next read answers the NEW token). A token read just before a refresh can be stale. X then answers 401, G3 records `failed` (`X_REJECTED_401`) and never re-sends. An unknown result stays `uncertain` and is never re-sent; nothing records a provider success that did not happen. `refresh_generation` (the refresh core's counter, 0 without a row) is now answered with VERIFIED. A caller that wants to detect "replaced since read" can compare it, but G3 does not compare it today. A safe retry would re-authorize only an explicit, provably-unsent refusal (401 before creation) under a new attempt; that is G3's and the central chat's decision.

**Still release gates (not verifiable here).** Real access-token expiry: this world's refresh state has no `access_expires_at`; main's refresh core has one, and it is not read here. Effective OAuth scopes per account: not stored. App permissions and pricing: see section 6.

**Evidence (local PG17, `supabase/tests/postona_g4_x_send_credential_run.sh`).**
- BEFORE on PR #706's 003, in the same world: an account id alone, publishing off, alias, shared, and another account's secret all answered VERIFIED with a token (5/5 reproduced).
- AFTER, behavior: 89/89 on the full profile and 89/89 on the personal profile. These are #19's 40 state cases read through a fresh attempt, plus:
  - no attempt, forged id / lease, another account's attempt;
  - no / another person's / unknown / expired / signed-out session;
  - reuse after published / failed / uncertain, cancelled, lease expired, text changed, result already recorded;
  - the worker attempt with no session, with a session, and without a pin;
  - another person's attempt, another workspace;
  - publishing off; stop recorded / lifted;
  - refresh (same attempt, new token, refresh generation 1); manual and worker attempts across a reconnect (ABA); a new attempt after it;
  - service_role reads no lease and no Vault;
  - alias, shared (access / refresh), swapped, a restored copy of another account's secret, unnamed, dangling, missing, restored; the other account untouched;
  - no refusal carries a token.
- Races:
  - R1: an open read holds the account against a disconnect;
  - R2: a reconnect in flight makes the read wait, then the attempt bound before it is refused and a new attempt reads the new token;
  - R3: a held attempt row → `CREDENTIAL_BUSY`.
- G3 contract (PR #699 adapter, attempt passed): 0 violations; G3's one-argument port answered 0 tokens.
- Install refusals:
  - no 002, 002 drift, no G3 tables, no 014 pin, #19's read present, a readable lease;
  - twice: refused;
  - ACL: service_role only.
- 16 mutants, all caught (each P2 binding, the lock on the attempt and on the account, the grant).
- Rollback, including drift refusal. Deno unit 6/6.
- NOT_RUN: the real local runtime e2e (`postona_g4_x_send_credential_e2e_run.sh` now stops with `G4XS_E2E_NOT_APPLICABLE`): it needs G3's port change above.


## 1. What was missing

G3's manual send ("send now") and the reservation worker take one G4 credential source:
`credentialFor(socialAccountId) -> { token, generation } | null` (G3's `x_credential_generation.ts`).
G3 ships it as `X_GENERATION_CREDENTIALS_NOT_CONNECTED`, so no authenticated X send was possible (G3-02 #26 ACCEPT: G4_CREDENTIAL_NOT_CONNECTED).

## 2. What G4 delivers

| file | what |
|---|---|
| `supabase/candidates/postona_g4_credential_verdict/003_x_send_credential_read.sql` | `public.postona_x_send_credential_v1(p_social_account_id text) -> (code, credential_generation, access_token)`, one row always. SECURITY DEFINER, empty search_path, lock_timeout 3 s. **EXECUTE for service_role only** (anon / authenticated / authenticator: no). Installs only over the reviewed X verdict 002 (body md5 `46643d50a4a6c6a82867061328de05bf`). |
| `.../003_x_send_credential_read_rollback.sql` | drops only that function, only when its body is the installed one (md5 `e536472736d61bcaf2ffdb0196e98514`); 002 stays. |
| `.../x_send_credential_source.ts` | `createG4XSendCredentialSource({ read })` answers G3's raw shape `{ token, g4Generation }`; `createXSendCredentialRpcRead({ supabaseUrl, serviceRoleKey })` reads 003 over PostgREST (https, or http for a loopback host only; no redirect; 5 s). |

How 003 decides, in one transaction:

1. lock the account row `FOR SHARE` (G4's begin / complete / disconnect and the reconnect reset all update it: they wait for the read, or the read waits for them and sees only what committed);
2. owner = G5's single workspace owner of the account (`private.account_lifecycle_brand_owner`);
3. G4's X verdict 002 for (that owner, that account) must be `VERIFIED`: own personal workspace, x_autopost active, G4's lineage, no begin pending, identity verified, no connection error, both credentials set, refresh core not `refreshing` / `uncertain` / `reauth_required`;
4. the access token from Vault, printable ASCII, 16..4096 characters.

Otherwise `(code, null, null)`: no generation and no token. Codes: `INPUT_INVALID`, `NOT_CONNECTED`, `NOT_OWN_WORKSPACE`, the verdict's codes, `CREDENTIAL_UNREADABLE`.
The TS source answers `null` for anything but exactly one well-formed `VERIFIED` row, and for a throw or a bad account id. It caches nothing, and nothing it answers, throws or logs carries a token, an account id or a database body.

## 3. How G3 connects it (contract for G3; G3's code, G3 decides)

Both send paths use the same fence:

```ts
credentials = xGenerationSourceFromG4Raw(            // G3's adapter (credential_generation_derivation.ts)
  createG4XSendCredentialSource({
    read: createXSendCredentialRpcRead({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY }),
  }));
```

- The generation G3 compares is G3's own derivation of G4's `g4x1:<connection_epoch>`. A reconnect or disconnect moves the epoch and never moves it back. A token refresh keeps it.
- **Who is sending** (person, session (G5 S2-2 / T13), publish switch, lease) stays G3's begin / preflight. 003 takes only the account id, because G3's port passes only that. The owner is derived from the account and re-checked by 002, so a wrong owner can never be `VERIFIED`. A send for another person's account is refused by G3's begin before 003 is asked.
- Optional later (G3's call): pass the subject to the source as defence in depth. That would need a G3 port change, so G4 has not asked for it here.
- The service-role key is server-only (Edge). It must never reach an app bundle.

## 4. Boundary for G1

None of this is a G1 surface. G1 keeps G3's manual-send contract (`sent` / `failed` / `uncertain` / `pending`, the same `clientRequestId` when retrying).
G4's refusals reach G1 only through G3's answer codes, as follows:
- "not sent" when G3's begin refuses (403 / 404);
- `failed` with `X_CREDENTIALS_UNAVAILABLE` or `CREDENTIAL_GENERATION_CREDENTIAL_CHANGED` / `CREDENTIAL_GENERATION_CHANGED`;
- 401 when the session ended.

The publish switch control (`publish_enabled`) is still not built by G1 or G4 (G3 G11b).

## 5. Evidence (local only)

- Deno unit (`x_send_credential_source_test.ts`, deny-net / deny-env / deny-run): 5 tests.
- PG17 (`supabase/tests/postona_g4_x_send_credential_run.sh`, the G4-43 world lines md5-pinned). Results:
  - install refusals; ACL (service_role only);
  - behavior: 40 cases on the full profile and 40 on the personal profile (connect, other person, refresh = same generation with the new token, refreshing / uncertain / reauth, bad token, pending, reconnect = new generation, disconnect, ABA, connection error, service end, owner loss, no lineage, no leak);
  - two-session races R1 / R2;
  - G3's contract `generationSourceViolations` through G3's adapter: 0 violations (2 connected, 5 not);
  - mutants: verdict ignored, token shape ignored, row lock removed and an authenticated grant are all caught. Deriving the owner another way is an equivalent mutant (002 re-checks the owner);
  - rollback, including the drift refusal.
- Real local runtime (`supabase/tests/postona_g4_x_send_credential_e2e_run.sh`): G3 PR #699's own `local_stack/run.sh` in a throw-away composition (counted insertions: G4's 003, one twin using G4's real source, one step L47). Real GoTrue signed JWT → Kong → Edge → PostgREST/Postgres → G3's fake X. The run had 48 steps: G3's L0–L46 unchanged, all PASS, plus G4's L47 PASS. L47 results:
  - sent: G4's Vault token reached the fake X (the bearer's SHA-256 matched);
  - refreshing: 403 `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`, 0 sends;
  - after a refresh: sent with the NEW token, same generation;
  - after a reconnect: 403 `POSTONA_RESV_PUBLISH_DISABLED` (the switch goes OFF again), then sent with the reconnect's token;
  - another person: 404;
  - signed-out session: 401, while the person's other session still sent;
  - disconnected: 403 `POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED`;
  - service ended: 403 `POSTONA_RESV_SERVICE_NOT_ACTIVE`;
  - 4 sends in all.

  On this path G3's begin (014, which calls G4's verdict) refuses before G4's source is asked. G4's source's own refusals are measured on PG17 above. 003 installed on the real image with EXECUTE for service_role only.

## 6. Not solved / to confirm (kept separate)

- **Refresh between the read and the X call**: the generation does not move on a refresh, so the token read just before may be the previous one. X then refuses it (401), G3 records `failed` and never resends. No double post; the person retries. Closing it fully needs the refresh core's lease to be part of G3's preflight (G3 + main refresh core), or the generation to include the refresh counter. That would change G3's 014 definition and needs central approval.
- **Access token expiry**: this world's refresh state has no expiry column. The refresh core (main) owns renewal. An expired token gives X 401 → `failed`.
- **Scopes**: not stored per account. G4's connect asks `tweet.read users.read tweet.write media.write offline.access` (`x-oauth-connect-user/oauth_logic.ts`). G3's sheet read the official page on 2026-11-17: create needs `tweet.read tweet.write users.read`, plus `offline.access` for refresh. G4 did not re-read the official pages in this task: **to confirm** before release. `media.write` is not needed for text-only posts. Whether to drop it is a product decision.
- **X pricing / app permissions**: not re-verified here (G3's sheet G5/G6, read 2026-11-17; prices can change): **to confirm**.
- **New grant**: EXECUTE on 003 for service_role is new and returns plaintext token material to the server. **An independent H review is required** before any hosted use, as is the deploy order (002 → 003, then G3 wiring).
- The worker path uses the same source. Only the manual send was driven end to end in this task. The worker's twin is G3's.
