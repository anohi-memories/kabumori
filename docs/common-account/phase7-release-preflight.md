# Common account — Phase 7 (F5): release preflight for Auth / entitlement / POSTONA end / common-ID deletion

Status: **source candidates + executable preflight; nothing applied, nothing deployed, no managed Supabase touched, no
real OAuth / X / Threads / Meta call, no user created.** Production NO_GO (section 11). Stacked on F5 PR #178 (Phase 6).
No F3/G3 (X), F4/G4 (Threads), H5, F1/F2 or app file was changed.

This phase does not add a feature. It answers one question with a command: *is the whole common-account chain
(Phase 1, 2, 3a, 3b, 4, 5, 6 and, since Phase 8, the reconciliation facts) safe to carry to a disposable managed environment, and what exactly must be read back
there before anyone may think of a release?*

```bash
export CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<local superuser>
bash supabase/tests/common_account_release_preflight_run.sh                       # chain, probe, rollback, matrix, notices
CAL_PREFLIGHT_SECTIONS=all bash supabase/tests/common_account_release_preflight_run.sh   # + every per-phase runner (minutes)
python3 supabase/tests/common_account_release_preflight_mutations.py               # 12 deliberate regressions of the preflight itself
```

## 1. What the preflight proves (local PostgreSQL 17, fake data)

| Stage | Proves |
| --- | --- |
| `chain` | the eight migrations (Phase 8's `20261013140000` is the eighth; see `phase8-integrated-security.md`) are single `BEGIN … COMMIT` files in release order (file order = release order, no duplicate version prefix, none names a later one); they apply in order on the production-shaped baseline; **13 out-of-order applications are each refused with their own fixed code and leave the catalog byte-identical**; each refuses a second application with its own code; Phase 3a and 3b commute |
| `probe` | `supabase/preflight/common_account_release_probe.sql` (the read-only probe for a disposable managed project, section 8) passes on the full chain, STOPs without its disposable gate, is read-only by construction, and **18 deliberate regressions each flip the check they are meant to flip** |
| `rollback` | the emergency rollbacks of Phase 8 → 6 → 5 → 4 → 3b restore the previous catalog exactly (only the documented additive remnants of Phases 6 and 8 remain); a forward re-apply reaches the identical final catalog; Phase 1's rollback refuses while any later phase is present |
| `matrix` | the provider-state matrix of the POSTONA end against the real SQL (section 5): 17 cases + the whole account |
| `notices` | every server error code has a user notice; a remote authorization that could not be revoked is never described as revoked; the POSTONA-end vs account-deletion difference is pinned; the real app clients' gaps are listed |
| `runners` | the per-phase runners (lifecycle, start intent, deletion completion, write guard, core fence incl. e2e + app contract, brand state, service deletion) |

## 2. The chain, its order and its dependencies

| # | Phase | File (version) | Needs | Refusal when out of order | Emergency rollback |
| --- | --- | --- | --- | --- | --- |
| 1 | foundation | `20261001150000_common_account_lifecycle_foundation` | baseline | — | `common_account_lifecycle_rollback.sql` (shadow state only; **refuses while any later phase is present**, Phase 7) |
| 2 | start intent | `20261006230000_common_account_service_start_intent` | 1 | `COMMON_ACCOUNT_START_INTENT_PREFLIGHT_FOUNDATION_MISSING` | none: forward-only (ship the previous app binary) |
| 3a | deletion completion | `20261009120000_common_account_deletion_completion` | 1, 2 | `COMMON_ACCOUNT_DELETION_COMPLETION_PREFLIGHT_FOUNDATION_MISSING` | none: forward-only |
| 3b | writer guard (T13) | `20261010051938_common_account_service_write_guard` | 1 (not 3a; they commute) | `COMMON_ACCOUNT_WRITE_GUARD_PREFLIGHT_FOUNDATION_MISSING` | `common_account_write_guard_rollback.sql` (fails closed) |
| 4 | service fence | `20261012130000_common_account_core_service_fence` | 3b | `COMMON_ACCOUNT_CORE_FENCE_PREFLIGHT_FOUNDATION_MISSING` | `common_account_core_fence_rollback.sql` (keeps shared functions others use) |
| 5 | workspace-owner state | `20261012230000_common_account_service_brand_state` | 4 | `COMMON_ACCOUNT_BRAND_STATE_PREFLIGHT_FOUNDATION_MISSING` | `common_account_brand_state_rollback.sql` |
| 6 | service-deletion ownership | `20261013120000_common_account_service_deletion_ownership` | 4, 5 | `…_PREFLIGHT_FOUNDATION_MISSING` / `…_CORE_FENCE_MISSING` / `…_BRAND_STATE_MISSING` | `common_account_service_deletion_rollback.sql` (keeps additive columns) |
| 8 | reconciliation facts (Phase 8) | `20261013140000_common_account_service_reconciliation_facts` | 6 | `COMMON_ACCOUNT_RECONCILIATION_PREFLIGHT_PHASE6_MISSING` | `common_account_service_reconciliation_rollback.sql` (keeps the column and its data; a re-apply works) |

External prerequisites the chain assumes but does not create: the social-mobile onboarding and account-deletion
migrations (`20260919120000`, `20260922003101`, `20260928160000`), `public.ensure_my_profile()`
(`20260924100000`), and — for Threads rows to exist at all — the multi-provider migration `20261007150000` (the
probe reports the platform rule as INFO K3). **The Supabase CLI must not be used to apply the chain** (`db push`
applies every unlisted local migration); the schema-first runner pattern of
`supabase/tests/common_account_lifecycle_rollout.md` stays the only sanctioned route, one file at a time.

### Findings of this phase (fixed in this PR unless stated)

1. **Phase 6 could be applied without Phase 4/5** (no preflight required them) — now refused with
   `…_CORE_FENCE_MISSING` / `…_BRAND_STATE_MISSING`; release order is enforced by the database, not by file names alone.
2. **Phase 1's rollback silently removed the tables of a Phase 1+2 world and left callable, broken Phase 2 functions**
   (plpgsql registers no dependency, so `DROP` without `CASCADE` could not notice them). It now refuses with
   `COMMON_ACCOUNT_ROLLBACK_REFUSED_LATER_PHASE_PRESENT`; nothing is removed.
3. **A resumed POSTONA end could get stuck**: when a provider's removal was already on record as "local removed,
   remote unverified" (an attempt that stopped or crashed after it) and the person's acknowledgement was not on record,
   the end could never complete (`REMOTE_UNVERIFIED_NOT_ACKNOWLEDGED`, reported as `UNKNOWN`). The claim now answers
   the acknowledgement already on record, and the orchestrator takes the consent from the retry (or asks for it with
   `REMOTE_UNVERIFIED_ACK_REQUIRED{providers}`) **before** touching anything again. Found by the matrix, not by a review.
4. The service-end reasons (`PROVIDER_RESULTS_UNSETTLED`, `REMOTE_UNVERIFIED_NOT_ACKNOWLEDGED`,
   `SERVICE_FOOTPRINT_REMAINS`) were reported as `UNKNOWN`; they are now in the fixed reason list.
5. The probe's disposable gate failed OPEN when the session setting was absent (`NULL`): caught by the runner's
   "STOP without the session setting" case before it was ever used.
6. Not changed (documented): Phase 2 and Phase 3a have **no emergency rollback**; Phase 4's rollback deliberately
   tolerates later phases (emergency use must not be blocked); Phase 3b's rollback fails closed.

## 3. Security inventory (what the probe asserts, exactly)

From a clean apply on PostgreSQL 17, reviewed by hand:

* **74 functions** (`private.account_lifecycle_*` 38 + public 36): all `SECURITY DEFINER`, `search_path = ""` (plus
  `lock_timeout = 3s` for exactly one: `private.account_lifecycle_service_state_refusal`), one owner (the owner of
  `public.common_accounts`), **no `PUBLIC` EXECUTE, none for `anon`**; `authenticated` only on `start_kabumori_service`,
  `start_x_autopost_service`, `reactivate_kabumori_service`, `reactivate_x_autopost_service`, `ensure_my_profile`;
  `service_role` on 28 service functions (identity always from a verified token, never a client value); every
  `private.*` helper (38) and the three Phase 3a functions retired from `service_role` (3) are owner-only.
* **7 relations**: five `private.*` (RLS on, no grant to any API role) and two public tables with RLS on, a single
  `SELECT` policy to `authenticated` on own rows (`auth.uid() = user_id`), no table-level grant, and column `SELECT`
  to `authenticated` on exactly the listed columns.
* **11 triggers**, all origin-enabled; none on `auth.users` (the Auth cascade reaches `common_accounts` through its
  foreign key, which the guard trigger then decides).
* State: release gate `managed_auth_delete = blocked`, settings `shadow / not_started`, the three built-in checkpoints.
* No API role is a member of the owner; default ACLs that grant `EXECUTE` to API roles exist (as in Supabase) and are
  explicitly revoked on every chain function.

The expected list lives in the probe (`exp_fn`, `exp_rel`, `exp_trg`). A function that is not in it (same name
family) is a FAIL: a new function must be reviewed and added on purpose.

## 4. Rollback ladder

Reverse order restores the previous catalog exactly (tested). Out of order is **safe because the rollbacks fail
closed**, not because they are blocked: removing Phase 3b's guard makes every guarded writer error (never open);
Phase 4's rollback keeps the shared functions other owners use (and reopens the profile window by design, back to
the real `20260924100000` definition); Phase 5/6 remove read helpers and leases. Phase 1 is the only destructive
rollback; it refuses unless it is alone. In a production-shaped environment Phases 2 and 3a are forward-only: a
defect there is fixed forward, and the safety net is that `managed_auth_delete` stays blocked and
`deletion_available` is false.

## 5. The POSTONA end, state by state (executable: `common_account_phase7_provider_matrix_test.ts`)

Real orchestrator + real SQL (Phase 1–6), generic adapters. For every case, invariants:
**I1** no fake success (`ok` ⇒ ended + completed + every answer settled; `confirmed_remote_revoked` only if the
adapter said so); **I2** nothing but a success ends the service; **I3** an unverified grant is never ended without the
acknowledgement on record, and it was recorded *before* the destructive call; **I4** a lost lease records and ends
nothing afterwards; **I5** other people are untouched; **I6** Kabumori's entitlement is untouched.

| Case | Result |
| --- | --- |
| unverified + acknowledged | ended; X done; `remote_unverified: [threads]` |
| unverified, no acknowledgement | `REMOTE_UNVERIFIED_ACK_REQUIRED`; nothing changed; the provider is not even read |
| adapter can confirm, registration `supported` | ended without acknowledgement; `confirmed_remote_revoked` |
| adapter could confirm, registration `unsupported` | acknowledgement still required |
| `reconciliation_required` / `blocked` / unreadable | not ended, X untouched, Threads kept; settled facts then end it |
| X `blocked` / `in_progress` / `failed` after Threads | never ended; the unverified fact is kept; X done later ends it |
| lease lost before the provider / in the adapter / before X | nothing recorded or ended by the lost owner; the retry ends it |
| "supported" registration answering unverified | `PROVIDER_REMOTE_UNVERIFIED`; the retry needs (and records) the person's consent |
| crash after the removal committed | the earlier consent is on record; none is asked again; still reported unverified |
| whole account | acknowledgement first; one chain of ownership; the result is readable by the subject hash afterwards |

## 6. User-facing notices (G5's contract; `supabase/functions/account-delete/user_notices.ts`)

The server answers fixed codes, never text. The apps copy these strings (the test pins them):

**Threads authorization (a separate line from the local result):**
「Threads（Meta）側のアプリへのアクセス許可は、このアプリからは取り消せません。取り消すには、Threads（Meta）側の設定でPOSTONAのアクセス許可を削除してください。」

**POSTONAの利用を終了** — 削除: POSTONAのワークスペースと投稿の設定／X連携（Xの認可の取り消しと保存していた認証情報の削除）／Threads連携（POSTONA内の連携情報と投稿の設定。Threads側の許可は残ります）／予約中の投稿と履歴・実行記録。
残る: ログイン用のアカウント／かぶモリの利用状況とデータ／XやThreadsにすでに公開された投稿。
あとから利用登録をやり直せますが、削除したデータは元に戻りません。

**共通アカウントを削除** — 削除: ログイン用のアカウント／かぶモリのデータ／POSTONAのデータ（上と同じ内容）。
残る: すでに公開された投稿／Threads側のアクセス許可（取り消せません）／削除の実行記録（識別子と日時・結果のみ）。元に戻すことはできません。

Success lines: local result first, then one remote line per entry of `remote_unverified`; never a claim of revocation.

## 7. What the real apps call today (verified in source; apps were not changed)

| App | Callsite | Calls | Gap (expected vs actual) |
| --- | --- | --- | --- |
| Kabumori | `src/components/account-lifecycle-views.tsx` → `src/lib/account-deletion-client.ts:75/82/89` → `src/lib/account-deletion.ts` (`previewCommonAccountDeletion`, `withdrawKabumori`, `deleteCommonAccount`) | `account-delete` actions `preview`, `withdraw_kabumori`, `delete_common_account` with `expected_lifecycle_version` | **No action `withdraw_postona`; no field `acknowledged_remote_unverified`.** A person with a connected Threads account who deletes the common account receives `409 REMOTE_UNVERIFIED_ACK_REQUIRED` and the app shows its generic failure text: **fail-closed but a dead end**. 8 server codes are not mapped (`ACKNOWLEDGEMENT_INVALID`, `ACTION_REQUIRED`, `FAILED`, `PROVIDER_ADAPTER_MISSING`, `PROVIDER_CLEANUP_BLOCKED`, `PROVIDER_REMOTE_UNVERIFIED`, `REMOTE_UNVERIFIED_ACK_REQUIRED`, `WITHDRAW_INCOMPLETE`) — pinned by a test |
| POSTONA | `apps/social-mobile/src/providers/auth-provider.tsx:243/257/278` (`callDeletion`, `previewDeletion`, `deleteAccount`), UI `apps/social-mobile/src/app/account-deletion.tsx` | `social-mobile-account-delete` `{action:'preview'}` and `{action:'delete', confirmation, expected_scope, apple_authorization_code?}` | **It never calls `account-delete`**: POSTONA's own deletion bypasses the common lifecycle (no entitlement change, no lease, no provider results, no acknowledgement). The legacy saga takes **every** social account of the workspace as X material (credential set without a platform filter; revoke through X's endpoint): a Threads account with credentials goes to `operator_required` (`CREDENTIAL_MATERIAL_MISSING`) at best |

Concrete follow-ups (owners' own reviewed changes): (a) POSTONA's deletion and "利用終了" call `account-delete`
(`withdraw_postona` / `delete_common_account`) with `acknowledged_remote_unverified` after showing section 6;
(b) Kabumori maps the unmapped codes and sends the acknowledgement on `REMOTE_UNVERIFIED_ACK_REQUIRED`
(`providers[]` names them); (c) G3/F3: the legacy saga must refuse, before any revoke call, when a non-X account is
in the workspace, and must never send a non-X credential to X.

## 8. The read-only probe and the managed disposable preflight (NOT executed here)

`supabase/preflight/common_account_release_probe.sql`: one read-only transaction, one `SELECT`; prints
`<id>|<PASS|FAIL|WARN|INFO|STOP>|<detail>` and a last line `RELEASE_PREFLIGHT|PASS|fail=0 warn=n stop=0`.

**Disposable gate** (an accident cannot pass it): the operator creates the marker table
`public.kabumori_disposable_marker` in the disposable project **and** starts the session with
`PGOPTIONS='-c kabumori.disposable_probe=yes'`; otherwise it prints one `STOP` line and nothing else.

```bash
PGOPTIONS='-c kabumori.disposable_probe=yes' psql -X -A -t -v ON_ERROR_STOP=1 \
  -f supabase/preflight/common_account_release_probe.sql "<connection string of the DISPOSABLE project>"
```

| Probe check | What it reads | STOP when |
| --- | --- | --- |
| A1–A4 | which phases exist; the ledger versions | a phase is missing before a present one; a chain version absent; a ledger gap |
| B1–B7 | the 74 functions: attributes, EXECUTE roles, PUBLIC, owner, unknown family members | any difference from section 3 |
| C1–C6 | 7 relations: RLS, table/column grants, policies, owner | any difference |
| D1–D3 | 11 triggers, none on `auth.users` | missing/disabled/extra |
| E1–E4 | gate blocked, settings affirmed, built-in checkpoints, Phase 6 columns | gate not blocked; checkpoints differ |
| H1–H4 | `auth.sessions` shape and owner access; FK cascade from `auth.users`; anonymous users | shape/privilege/FK differ |
| I1 | `storage.objects` readable by the owner with `bucket_id, name, owner_id` | not readable |
| K1–K3 | schema `private` not in `pgrst.db_schemas`; default ACLs; platform rule | `private` exposed |

`WARN` means "SQL cannot decide": the ledger or `pgrst.db_schemas` absent, `is_anonymous` absent. **A `WARN` is
answered by the manual checklist below, never assumed.**

### Manual checklist (needs a separate, explicit approval; none was done)

| # | Item | Expected read-back | STOP when |
| --- | --- | --- | --- |
| M1 | GoTrue token / session | access token carries `sub`, `role=authenticated`, `session_id`; an `auth.sessions` row exists for it; a global sign-out removes it / sets `not_after` and T13 refuses the old token | no `session_id` claim; session survives sign-out; T13 accepts the old token |
| M2 | Refresh vs new sign-in | refresh keeps `session_id`; a new sign-in changes it | refresh changes it (the app's gate would re-enrol on every refresh) |
| M3 | Anonymous sign-ins | disabled in Auth settings (attempt returns an error) | enabled and not explicitly accepted (the start RPCs do not check `is_anonymous`) |
| M4 | Identity linking | link/unlink and a deletion are **not run** (`IDP_PREPAUSE_BLOCKED`, `managed_auth_delete` stay blocked) | anyone proposes to open the gate in this phase |
| M5 | `55P03` over PostgREST | hold the lifecycle lock from a second connection; call `start_kabumori_service`; record HTTP status and body | a 2xx; a body that leaks SQL text (the Phase 5 client treats any non-listed answer as "unavailable, retry") |
| M6 | `42501` over PostgREST | HTTP 401/403 with `message` = the fixed code | the code is not in `message` (the Phase 5 client depends on it) |
| M7 | Storage | an uploaded object has `owner_id` of the person; the deletion inventory lists it; an upload with a token issued before a global sign-out is refused or documented | an object of a removed login remains with an owner id and no cleanup path |
| M8 | Owner / ACL | the probe's `B5`/`B6`/`B7` rows; the owner role name equals the project's migration role | functions owned by different roles; an API role member of the owner |
| M9 | Default privileges | `K2` rows; B2/B3 PASS (the chain revoked what defaults granted) | any chain function executable by `anon` or PUBLIC |
| M10 | Edge function configuration | the service credential is set only as a secret; logs contain no token; `account-delete` is the only Edge function with the deletion RPCs in `RPC_NAMES` | the credential appears in a log or a client bundle |

**Release STOP conditions** (any one): a FAIL or STOP line; a manual item outside its expected read-back; fresh
disposable counts non-zero (`G1`); the gate open; F4's cleanup authorization still lease-free (handoff
`F5_TO_F4_PHASE6_LEASE_GUARD_HANDOFF_20261013.md`) while any Threads adapter is registered; no F3 contract for the X
saga (section 9); the apps still bypassing `account-delete` for deletion (section 7).

## 9. Hand-offs

* **F4**: `threads_cleanup_authorized` must require a live deletion lease (PR178 doc §8.3); then the registry and grant
  candidates (`supabase/candidates/common_account_provider_registration/`) are a separate reviewed step.
* **F3/G3**: the X saga contract of PR178 §9.3 and: refuse a workspace that holds a non-X account before any
  revoke call; typed `blocked` reason for an in-flight post.
* **G1/G2**: map the unmapped codes (section 7), show section 6, send `acknowledged_remote_unverified`.
* **G4 / POSTONA app**: route deletion and "利用終了" through `account-delete`; `delete`'s legacy saga stays only for
  the X-only transition.
* **H5**: the service credential path for the registration (Edge secret), nothing else.
* **Coordinator**: this PR → one independent Sol (高) integrated review **after** F4's fix and F3's boundary and
  **before** any release gate; the disposable managed preflight (section 8) needs its own approval and project.

## 10. Not proven

managed Supabase behaviour (every manual item); real GoTrue tokens/sessions; the real PostgREST status mapping; Vault
and Storage policies; the React rendering of any notice; the real X saga (stand-in in the matrix); Threads' remote
authorization (cannot be revoked by this system); anything under load.

## 11. Production NO_GO — reasons

1. PR #121, #152, #165, #178 and this PR are unmerged Draft candidates; their merge/apply order is undecided.
2. F4's lease defect and F3's X boundary are open; the apps still bypass `account-delete`.
3. Managed behaviour is unproven (section 8, M1–M10); `IDP_PREPAUSE_BLOCKED` and `managed_auth_delete BLOCKED` stay.
4. Phases 2 and 3a have no emergency rollback.
