# POSTONA push devices (G5 source candidate, G5-02 tasks 9 / 10 / 11 / 12 / 13 / 14 / 15)

Task 15 fixes H4 #331 task 29's P2 on PR #692: "off" of the person's own row already revoked for another reason (signed out, stopped, taken over, provider rejected, proof expired, ...) moves it to `unregistered` with a new version, so turning it on again needs a new ON grant; an `unregistered` row is left as it is.

Task 14 fixes H4 #331 task 28's P2 and P3 on PR #687:
- P2: "on" again only with a one-time ON grant from `public.postona_push_device_enable` (the person's explicit act; bound to installation, device secret, session, generation; deleted by every "off"), stored hashed in `private.postona_push_on_grants`. Task 13's JWT-age rule and "off" fences are removed.
- P3: `private.postona_push_proof_presend` is the proof push's pre-send read; delivery targets stay active-only.

Task 13 fixes H4 #331 task 27's three P2 on PR #681:
- P2-1: `private.postona_push_proof_issue` issues a nonce only where delivery would accept the registration now (fence, MV at the current generation, the row's generation / workspace / live session), with one lock order (the fence FOR SHARE, then never waiting: the account, advisory and row locks skip when taken).
- P2-2: a proof answer only before the pending registration expires, from its own session and generation (`PROOF_STALE` otherwise); the nonce bound to the registration and capped at its expiry.
- P2-3: a first registration only with a JWT issued within the 1-day "off" period and after the person's "off" fence (`private.postona_push_off_fences`, set by an "off" the cap cannot record and by a handover).

Task 12 fixes H4 #331 task 26's two P2 on PR #676:
- P2-1: an unproven token is `pending` (never delivered) until the phone answers the provider nonce from `private.postona_push_proof_issue`. No provider is connected: NOT_RUN.
- P2-2: one per-person cap (100 rows) and writer lock for register and "off", plus retention in purge.

Task 11 fixes H4 #331 task 25's two P2 on PR #672:
- P2-1: token claims (`private.postona_push_token_claims`, hashes only). A token another person registered last moves only on the same installation with its device secret; an ended session frees nothing.
- P2-2: "off" before the first registration leaves an "off" row (unregister with the device secret), and the client completes "off" after any answer.

Task 10 fixes H4 #331 task 24's three P2 on PR #667:
- P2-1: one stop fence, `private.postona_push_control`, shared by the stop and every registration;
- P2-2: no automatic re-send in `client.ts`;
- P2-3: a device secret per installation, and another person's live registration is never taken over by a matching id.

**Not applied anywhere. Production NO_GO.** New SECURITY DEFINER RPCs over a new owner-only table holding push tokens (secrets): an independent H review, the owner's approval and a read-only check of the managed project come first. Nothing here sends a push or talks to APNs / FCM / Expo.

| file | what |
| --- | --- |
| `001_push_devices.sql` | As the lifecycle owner (never a superuser): `private.postona_push_devices` (owner-only, row security on, no policy), four RPCs for `authenticated` (register / unregister / list / enable; the only definers), and the owner-only worker side (delivery targets, provider-receipt invalidation, purge). Refuses on a world it is not for, changing nothing; a re-run changes nothing. |
| `001_push_devices_stop.sql` | The fence off first (it waits for in-flight registrations), no new registration (EXECUTE taken away), every active device revoked `stopped` with its token erased: the worker side answers `PUSH_DEVICES_STOPPED`. Keeps the tables; the install starts it again. |
| `001_push_devices_rollback.sql` | Drops everything. Refuses while a device is active (stop first) or while another function names the worker side. |
| `client.ts` | The app's contract (G1): `syncPushDevice` / `registerPushDevice` / `unregisterPushDevice` / `listPushDevices`, and the app lifecycle in its header. |

- The contract (binding, the G1 app lifecycle, the G3 delivery read, what is not covered, the remaining push worker design): `docs/common-account/g5-02-09-push-device-contract.md`.
- The proof: `supabase/tests/postona_push_devices_local_test.ts`, run by `supabase/tests/postona_personal_workspace_local_run.sh` (local Supabase stack; fake tokens only; every container log scanned for them afterwards).
- Not the KabuMori app's `public.device_push_tokens`: that table is left as it is (another app's; see the contract, section 1).
