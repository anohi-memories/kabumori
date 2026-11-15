# J5 — POSTONA利用終了・共通ID管理のクライアント境界

- task_id: postona-j5-account-deletion-legacy-bypass-ui-bridge-20261014
- recommended_model: Sol（高）
- result: source candidate only / independent security review required / production NO_GO
- source baseline: main `1c3c404d59a157b9b1aa4338f19522637738df0b`
- contract: F5 PR193 `314aeac47a02ce80aea3d94426a563dfbe57ad7c`, `docs/common-account/phase8-*.md` §9, `account-delete/http.ts`, `lifecycle_logic.ts`, `user_notices.ts` (read-only).

## Behavior

All application entries (settings, login-methods, onboarding, enrollment) still reach the same account-management screen. The screen distinguishes **POSTONAの利用終了** from **共通IDを完全削除**. Ending POSTONA is strictly `x_autopost` service deletion; common ID and Kabumori stay even for someone who never registered for Kabumori. X/Threads individual disconnect routes and their source are unchanged. The whole-ID panel requires a separate acknowledgement and phrase to explain the effects, but has no enabled submit handler or transport implementation.

The legacy `previewDeletion`/`deleteAccount` compatibility methods always return `LEGACY_DELETION_DISABLED` before Auth, fetch, local logout or local data removal. The old `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true` cannot reopen them. The old scope selector, permissive success parser and old endpoint constant are removed from the client.

`POSTONA_END_SOURCE_ENABLED=false` is a static source gate. Neither the new preview nor mutation can run in this candidate. It is not an environment toggle. A separate reviewed release change is required; this PR is not a working production withdrawal service.

## Exact source-confirmed transport (offline tests only)

The new client calls only `POST /functions/v1/account-delete`, with the person's current token and a publishable key. No client service key, direct lifecycle RPC, user-ID body, new endpoint or legacy fallback exists.

1. `{action:'preview'}`. Actual PR193 uses **`acknowledgement_required`**, not a preview `remote_unverified` field. Parse account state, lifecycle version, `services` (`kabumori`, `x_autopost`), provider adapter/revoke capabilities, `postona_end_available`, `x_cleanup`, blockers and in-progress state. Unknown provider/shape is blocked.
2. Reauthenticate using the person's linked login method. Pin the returned user + session. Load a new preview; clear typed confirmation and provider consent. Display Threads local data removal and remote grant retention as separate lines, with an explicit checkbox.
3. `{action:'withdraw_postona',confirmation:'END_POSTONA_SERVICE',acknowledged_remote_unverified:['threads']}`. The array must reflect explicit consent from this issued preview. No common-account action is exposed. F5's server enforces recent authentication and checks the provider snapshot again before mutation. `expected_lifecycle_version` belongs to **whole-account deletion**, and is not invented for service deletion.
4. Parse only HTTP200, explicit `ok:true` and `ended`/`already_ended`/`not_registered`. Refuse login deletion, pending/unknown provider results, unacknowledged new remote results or unknown remote providers and malformed uncertainty counts. Map all F5 error notices and X reason notices to fixed client text; never render server prose.
5. Read another authenticated preview. Report success only after the common account is active, Kabumori service state is unchanged, and POSTONA is ended (or absent for `not_registered`). Unavailable managed Auth, failed read-back, changed session or altered Kabumori state is unconfirmed, never successful. A bounded transport timeout is also unconfirmed.

A synchronous operation lock prevents double taps. Mutation consumes its preview so replay/retry needs a new preview and new consent. The screen clears reauthentication, phrase and consent after every attempt. Authentication changes reset consent before rendering, and hide results bound to an earlier session. No local sign-out or automatic enrollment follows service ending.

The local client copies `user_notices.ts` per its explicit app-owner copy contract. It includes all F5 errors, separate local/remote Threads notices, and the durable `x_posts_unconfirmed` warning on success, `already_ended`, and failed responses. An uncertain X post is never described as posted or not posted. `already_ended` may carry durable, previously acknowledged Threads facts after its local connection disappeared; the client displays that remote warning without pretending a new revocation happened or demanding a new destructive consent.

## Exact owner handoff / blockers before activation

- **F3/G3 (legacy server owner):** this app patch cannot contain older installed builds or direct HTTP callers. Independently read back the deployed legacy `social-mobile-account-delete` source/permissions and retire the login-deleting scope whenever a common account exists. Do not rely on an app flag. Keep X-only disconnect semantics separate. No server file is changed here.
- **F5/G5:** PR193 is Draft/unmerged. Establish and prove managed `account-delete` routing, Auth/session permissions, lifecycle SQL and provider registration, durable provider results/count read-back, service-only deletion preserving the login/Kabumori, and the whole-account release gate. Keep F3-R2'/L1 and other integrated blockers explicit. This client cannot make a POSTONA-only user's legacy saga safe: current F5 source may return `X_CLEANUP_UNSUPPORTED`; show that operator notice and never fall back.
- **F4/G4:** prove the managed Threads adapter/owner lease and intentional remote-unverified semantics. An acknowledgement does not mean remote revoke succeeded. Confirm individual disconnect UI on its existing stack.
- **J1–J4 (separate reviewer):** Sol（高） focused independent security review of this client plus the exact assembled server stack before activation. J5's regression checks are implementation QA, not independent approval.
- **Staging, separate authorization:** verify same user/session + recent-auth rejection; POSTONA-only and dual-app users; missing adapters; Threads consent absent/present; in-progress/reconciliation/retry; expired/changed session; remote revoke ambiguity; unconfirmed X count sticky on retry; old client rejection; read-back of account, both entitlements, provider records and footprint. Real OAuth/revoke/deletion needs explicit authorization, disposable test accounts and a separate mutation window.
- **Whole-account deletion:** remains blocked here regardless of server `deletion_available`. A future common-account settings owner must implement explicit scope acknowledgement, exact lifecycle-version confirmation, Apple requirements, managed Auth/Storage/session proofs and definitive read-back. No current action implies it is available.

## Validation limits

Synthetic VM UI/provider tests and typed transport tests run without network or real Auth/SNS/DB. Typecheck, lint and local web export verify the application source. No native/iPhone execution or managed staging/production check is claimed. No backend/source gate was enabled; no migration, secret, OAuth, real user deletion, merge, deploy, EAS or posting occurred.
