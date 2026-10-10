| E1 | Version and config | GoTrue ≥ v2.195.0 recorded. Manual linking, flow-state expiry, request duration, JWT expiry, session time-box and audit-to-Postgres recorded. |
| E2 | Ban vs OAuth callback with automatic linking (same verified email) | 403 `user_banned`; no `auth.identities` row; no session |
| E3 | Ban vs manual link **started after** the ban | `/user/identities/authorize` gives 403 |
| E4 | **Manual link started before the ban, callback after it (V11)** | Expected to **link**: confirms or refutes the counterexample. If it links, Option A needs manual linking off, or a settle time longer than the flow-state expiry. |
| E5 | Ban vs refresh and ID-token grant; logout ordering | Refresh 400 `user_banned`; ID-token sign-in 403; `/logout` refused after the ban (so revoke before the ban) |
| E6 | Concurrency: about 200 parallel link and sign-in attempts fired around the ban commit, repeated | The maximum time from ban commit to a committed identity is measured, and it is ≤ the configured request duration |
| E7 | Custom Access Token hook refusing a `deleting` account | Refuses password, refresh, PKCE exchange and ID token. A PKCE link before the exchange **is** committed (V10). Measure latency, and the behaviour when the hook errors. |
| E8 | Admin delete cascades on the project's schema | Every `auth` child row is gone. Phase 1's shadow guard records `login_removed`. Public foreign keys behave as in the fixtures. |
| E9 | Stale tokens after logout, ban and delete, against PostgREST and Storage | Guarded writer codes match §6. Unguarded writer and Storage-upload outcomes are recorded. `auth.sessions` is readable by `postgres` (H5). |
| E10 | Audit log | `identity_linked` rows (actor, provider) persist after the user's deletion and can be read by `postgres` (H4) |
| E11 | Option D | Can `postgres` `DELETE FROM auth.users` under our lock? Differences from the Admin delete. GoTrue's view of the user's tokens afterwards. |
| E12 | Apply the guard migration on the disposable database | Preflight and postcondition pass. Catalog read-back. A G4-shaped writer wired **in the disposable database only** passes 6a–6g against real PostgREST. |
