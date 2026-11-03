# POSTONA media box (G5 source candidate, G5-02 task 5)

**Not applied anywhere. Production NO_GO.** Before managed use: one focused H1 security review, the owner's approval, a read-only check of the
managed project. The full contract (API, statuses, JSON, the G1 steps, enforcement, residuals): `docs/common-account/g5-02-05-personal-media-box-contract.md`.

| file | what |
| --- | --- |
| `001_media_box.sql` | as the lifecycle owner (`postgres`), after the MVP profile: the owner-only metadata table, four `authenticated`-only RPCs, the Storage gate functions, the private bucket `postona-media` and three Storage policies; refuses (changing nothing) unless the world is the one it is for; re-running it changes nothing |
| `001_media_box_stop.sql` | drops the three policies and revokes EXECUTE: every person loses the box at once, nothing is deleted; the install turns it on again |
| `001_media_box_rollback.sql` | removes everything once the box is empty (refuses while an object or a pending / ready asset exists; objects go through storage-api) |
| `client.ts` | the dependency-free client contract for the app (`addMedia` / `listMedia` / `mediaReadUrl` / `deleteMedia`, one failure class union) |

Tests: `supabase/tests/postona_personal_media_box_local_test.ts` on the real local Supabase (storage-api v1.70.3, real bytes), run by
`supabase/tests/postona_personal_workspace_local_run.sh`.
