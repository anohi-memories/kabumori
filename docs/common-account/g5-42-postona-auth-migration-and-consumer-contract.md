# POSTONA personal auth: the migration candidate and the consumer wiring contract (G5-42)

Status: **source-only.**
- Not applied.
- No G3 / G4 / G6 file changed (read at their latest accepted heads only).
- Production **NO_GO**.
- TASK `common-account-g5-postona-entrypoint-only-migration-candidate-consumer-contract-20261028` (Issue #320, G5-01 generation, task 42,
  completion K5).

## 1. The deliverable

`supabase/candidates/postona_personal_auth_migration/` is the **apply / withdraw unit**:
- `20261028090000_postona_personal_auth_install.sql` = PR #537's `INSTALL_ALL` plus the read-only **prerequisites block**;
- `ROLLBACK_20261028090000_postona_personal_auth.sql` = PR #537's `ROLLBACK_ALL`, byte for byte.

Its README has the procedure, the prerequisites (P1 chain, P2 PR #457, P3 G3 L-1, P4 auth), the limits and the evidence. Nothing else ships: no
part files, no standalone drops.

## 2. Dependency order (what must exist first, and its state)

1. G5 lifecycle chain `20261001150000` … `20261015120000`. The G5 Draft chain; only the first migration is on main.
2. G3 L-1 revoke on `brand_memberships` (PR #370).
3. G5 owner epoch (PR #285 → #303 → **#457: independent review not accepted, H3 stopped**). **Blocks production.**
4. **This candidate**, in one transaction: R1 / R0 / SV → D1 → S2-3 → S2-2 → S2-1 (T13 body).
5. Consumers (§4), owned by the lifecycle owner, wired only after step 4.

Withdrawal is the reverse: consumers out → `ROLLBACK_…` (refuses while any caller or dependent remains) → only then could steps 1–3 change.

## 3. The ownership / ACL model (one rule for every consumer)

- **The gates are owner-only, with one deliberate exception per public entry.**
  - Owner-only: SV `private.account_lifecycle_session_verdict()`, S2-2 `private.postona_personal_session()`, S2-3 `private.postona_personal_workspace_eligibility(uuid)`, T13 `private.account_lifecycle_assert_active_service_write(uuid,text)`, W1 `private.account_lifecycle_worker_brand_verdict(…)`, and the owner-epoch functions.
  - Public: R1 `public.common_account_authorization_verdict(…)` and R0 `public.common_account_bootstrap_verdict(…)` → `authenticated`; W2 → `service_role`. This is what the install postcondition asserts.
- **A consumer that calls an owner-only gate must be a SECURITY DEFINER function OWNED BY THE LIFECYCLE OWNER** (the same role that applies this candidate).
  - G5 grants **no** EXECUTE on an owner-only gate to any other role.
  - A request for such a grant is a separate security decision, with its own review. It is not part of this candidate.
- Consumers expose their own RPCs to their own roles (e.g. G3's `postona_resv_api` / `postona_resv_worker`, G4's `authenticated`). G5's gates stay behind them.
- **Claims:**
  - the database sees only claims the Edge has **verified**, and forwards **unchanged**: `sub`, `role`, `session_id`, `is_anonymous` (the boolean);
  - a missing or non-boolean `is_anonymous` is refused before the database;
  - G5's gates refuse it again (D1 / S2-1 / S2-2).

## 4. Per owner: what their latest source does, and what wiring needs (read-only; their TASKs are not overridden)

### G3 — PR #536 `1dc19904` (with #529 `cb8f51c3`)

| Item | Today | Needed for wiring | Owner |
| --- | --- | --- | --- |
| Ownership | One non-superuser installer owns all G3 functions (definer). It requires T13 / R1 / W1 / brand-owner to be **same-owner** (005:49-52, 007:51-63). | **Matches G5's model:** the installer must be the lifecycle owner. | G3 |
| `caller()` (001:163-176) | S2-2 first; only exactly `'active'` passes; NULL or a missing gate refuses. | Also check S2-2's owner = `current_user` and owner-only ACL (as 005 does for T13). This is a recommendation, not a blocker. | G3 |
| Claims | **Fixed by #529:** the Edge accepts only the boolean `is_anonymous === false` from the verified token and forwards it (`api.ts:114-124`, `postgres_db.ts:75-78`). | Done (G5-39's G3-1 closed in source). | — |
| X reservations | S2-2 for person entries; `service_state_refusal` for service; **no owner epoch / W1**. | R1 `g5oe` at create and W1 at claim / send, after PR #457. | G3 |
| Threads | R1 at create (token bound), W1 at claim / preflight / record, S2-2 for cancel / receipt (no service gate: P-2). | — (P-2 pending). | G3 / user |
| Runners | Pin S2-2 `6d59f3b6` individually; other G5 SQL from an env tree. **No runner uses the bundle / this candidate.** | Run G3's suites against `20261028090000_…install.sql` once (one transaction), instead of the individual files. | G3 |

### G4 — PR #533 `98e5cf03` (on #523)

| Item | Today | Needed for wiring | Owner |
| --- | --- | --- | --- |
| Ownership | The install preconditions require **the owner of begin / complete** to hold EXECUTE on S2-2 / S2-3 / owner epoch (X/001:58-75; Threads 001/002). The docs ask G5 to **grant** it (X/001:19-20, `threads-auth-x-oauth-integration-batch-20261025.md:55`). | **Conflict with G5's model.** Either (a) begin / complete and the `postona_g4_x_oauth` helpers are owned by the lifecycle owner, so the existing checks pass with no grant (G5's proposal); or (b) a separately reviewed grant. **Decision needed** (担当ちゃ / user); G5 grants nothing here. | G4 + decision |
| X begin / pre-exchange / complete | S2-2 + S2-3 (`require_person`) + the bare brand owner epoch; **no T13 / R1** (G4-1). The binding stores `owner_epoch` only (G4-2). | Add T13 (or R1) so a stopped service or locked account is refused. Bind R1's `g5oe` or the lifecycle version. | G4 |
| X disconnect | S2-2 + S2-3 only (`require_person = 'absent'` → not found), behind a gate that ships closed. | Same ownership rule. | G4 |
| Threads | PR #124 begin / complete call T13 first. The callback binds owner epoch **and** lifecycle version, then S2-2 / S2-3. **S2-2 is blocked until H5 forwards `is_anonymous`.** | H5 claims forwarding; S2-2 in Threads begin. | G4 / H5 |
| Runners | S2-2 / S2-3 / owner epoch are fakes (X) or copied bodies (Threads, `bbc52a6b` / `6d59f3b6`). **No runner uses the bundle / this candidate.** | One run against this candidate's install file. | G4 |
| Open questions to G5 | Q10, Q11, Q13, and "role claim vs a user + session verdict". | **G5's answers** (proposals):<br>• **Q10:** an anonymous or unproven caller is refused by S2-2 (`AUTH_REQUIRED`) at begin and at callback; G4 maps it to its own `SESSION_NOT_ACTIVE`.<br>• **Q11:** after A→B→A the owner epoch has moved (monotonic), so any state bound before is stale; a new begin binds the new value.<br>• **Q13:** yes, re-check S2-3 at the callback (G4 already does).<br>• **Role claim:** the transport forwards the **verified** `role` with the other claims. G5 does **not** offer a verdict by user id + session id without claims, because it would skip the JWT boundary. | G5 → G4 |

### G6 — PR #500 `636c38b9` (unchanged since G6-17)

| Item | Today | Needed |
| --- | --- | --- |
| Gateway | Not wired. Its real transport and port accept the real R1 v1 answers (G5-39 [RUN]); D1 closes G6's KNOWN GAP 1. | Wire the transport to R1 after this candidate is applied. No grant needed: R1 is `authenticated`. |

### H5

Forward the verified claims unchanged, `is_anonymous` and `role` included. This unblocks G4's Threads S2-2.

## 5. What remains open

1. **PR #457** (P2): its independent review is not accepted; production is blocked on it. H3 / owner.
2. **The G4 ownership decision** (§4 G4 row 1): no grant, or a reviewed grant. 担当ちゃ / user.
3. **G4-1 / G4-2** (G4), G3's X owner epoch (G3, after PR #457), H5's claims forwarding.
4. **Policies:** P-1 (with F-1), P-2, P-3, P-4, P-5 (user).
5. **Not verified:**
   - managed GoTrue / PostgREST / RLS / owners;
   - the Supabase CLI's handling of the explicit transaction;
   - concurrent DDL;
   - dynamic callers;
   - real consumers end to end;
   - production.
