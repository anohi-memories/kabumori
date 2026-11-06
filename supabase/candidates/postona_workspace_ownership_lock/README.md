# Workspace ownership lock (G5 source candidate, G5-02 task 8)

**Not applied anywhere. Production NO_GO.**

This candidate adds a trigger on the shared table `public.brand_memberships`. It needs the central room's explicit gate (and the review it decides) before any adoption.

| file | what |
| --- | --- |
| `001_workspace_ownership_lock.sql` | As the owner of `public.brand_memberships`: one BEFORE INSERT OR UPDATE row trigger. It locks the account rows of the people whose personal-workspace eligibility the row can change, `FOR UPDATE`, in `user_id` order. So G3 PR #644's `notify()` (FOR SHARE: account → brand → owner row) and any such change serialize, whoever writes: an RPC, service_role through the Data API, or SQL. It refuses on a world it is not for, changing nothing; a re-run changes nothing. |
| `001_workspace_ownership_lock_rollback.sql` | Drops the trigger and its function (the race is open again). |

- The contract (who locks what, the order, what is not covered): `docs/common-account/g5-02-08-workspace-ownership-lock-contract.md`.
- The proof: `supabase/tests/postona_workspace_ownership_lock_run.sh`.
