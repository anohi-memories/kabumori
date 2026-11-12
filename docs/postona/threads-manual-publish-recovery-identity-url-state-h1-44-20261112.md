# POSTONA Threads manual publish — recovery without a guessed post id, without a URL policy of its own, only under this connect's claimed state (G4-02 #16, 2026-11-12)

task_id: `postona-g4-gen2-16-h1-44-threads-recovery-identity-url-oauth-state-fixes-20261112` (Issue #561).
Review fixed: H1 #44 (Issue #306, comment 6812968648): CHANGES_REQUIRED, P2 ×2 / P3 ×1 on PR #654 @ `1463cccb`.
Stacked on PR #654 (base = its head `1463cccbbc8a263fcd7bae6b026e353d7e48c389`). Amends
`threads-manual-publish-expired-uncertain-recovery-p2-p3-20261111.md` (#15); everything there not changed below still holds.

**Status:** source candidates and local PostgreSQL 17 only. Nothing is applied, deployed or registered; gates unchanged;
production NO_GO. The three SECURITY DEFINER recovery functions (new bodies and signatures), 002's preconditions /
postconditions / rollback, G4's owner bridge and the shared reconcile rule are **unadopted candidates that need review before
adoption**. The fence (`4992a4a1`), begin / release and authorize bodies are unchanged. Real Threads remains NOT_VERIFIED.

## 1. P2-1 — a post id the evidence does not prove

H1 #44: recovery (and reconcile, same code) listed the account's recent posts and took the one with the exact text. A
container's PUBLISHED proves *a* post exists from that container; it does not say *which* post. With an earlier same-text post
and the lost one edited, the earlier post's id was stored for the wrong attempt (measured again here as the fail-before:
`pNotTheFirstPost=false`).

Now one rule, shared by reconcile and recovery (`containerStatusEvidence` in `_shared/social/threads_manual_publish.ts`):

| Container status | Recorded |
| --- | --- |
| PUBLISHED | `published_unidentified` PUBLISHED_POST_NOT_FOUND — a post exists; no post id, no permalink is attributed |
| ERROR / EXPIRED | `failed` CONTAINER_ERROR / CONTAINER_EXPIRED |
| FINISHED / IN_PROGRESS / a failed read | nothing (stays `uncertain`; the fence keeps refusing) |

No listing is read any more (recovery: one GET, the container). A post id is only ever stored from the provider's own publish
answer (`publish_returned` → confirm → `published`). The app already shows `published_unidentified` as "the post went out; its
link could not be identified — check in Threads", and a new post may begin. The Threads API exposes no container → post link
we could use as proof (NOT_VERIFIED that none exists).

## 2. P2-2 — a URL policy that disagreed

With no permalink written by the recovery, 002 has no URL check of its own; `settle_attempt_before_rebind` refuses `published`
(and any permalink) outright. The only permalink policy stays where it was: the TypeScript contract
(`readThreadsPublishedPost`, used by confirm) and the attempts table's CHECK, which agree (threads.net / threads.com, with or
without `www.`). H1 #44's fixture (a correct post with an `https://threads.com/` permalink) now settles
`published_unidentified` and the reconnect goes through (fail-before: stuck `uncertain`, reconnect refused).

## 3. P3 — the recovery's freshness = the completion's

- Every recovery function now takes THIS connect's `state_hash` and requires its H5 attempt (`postona_threads_runtime.attempts`)
  to be `claimed` by this person and this session, not expired, for this account and workspace, and its OAuth state
  (`social_account_oauth_states`) initiated by them, not expired and **not yet consumed**. (Fail-before: an unclaimed local state
  returned the candidate.)
- The owner bridge does the reads first (outside any transaction), then writes the evidence **inside the completion's own
  transaction**: after its claimed-state check, before `complete_and_attest_binding` (PR #124's state, G5's generation and
  session checks, the binding and its send fence), each settle under a savepoint. If the completion refuses — an ABA of G5's
  lifecycle, a lost owner, an expired state — the evidence is rolled back with it (measured: the ABA case leaves the attempt
  `uncertain`; fail-before: it was settled although the reconnect was refused).
- `settle` takes the account FOR SHARE before the attempt FOR UPDATE (the publish release's order).
- 002 now requires `postona_threads_runtime.attempts` (with its columns) owned by the same owner (`G4MG_PRECONDITION_OWNER`).

No H5 runtime, G5 Auth / JWT / RLS / GRANT, G3 worker, G1 UI or production Edge change.

## 4. Also

- The inline `jsr:@std/assert` imports in G4's two test files (`owner_bridge_test.ts`, `reconnect_recovery_test.ts`; lint
  `no-import-prefix`) are replaced by `node:assert/strict` with the same semantics (the wiring `deno.json` is H5's and is not
  touched).

## 5. Behaviour change

A lost publish answer settled by reconcile (or by the reconnect's recovery) is now `published_unidentified`, never `published`
with an id from a listing: scenarios 24, 28, 30, 31 (d), 33 (d), 34 expect it. `published` still comes from the provider's own
publish answer (confirm), unchanged (20, 22, 26, 33 (a) (b), 34 (a) next post).

## 6. Measured (2026-11-12, disposable PostgreSQL 17.11 UTF-8; fake Threads / PostgREST / GoTrue over loopback; the SQL is real)

| Check | Result |
| --- | --- |
| e2e personal / full (runner `G4T_APP_FLOW=1`, exit 0, `G4T_APP_FLOW_ALL_PASS`, every stage in both) | **34/34** / **34/34** |
| Fail-before: this branch's e2e on the #15 tree exactly (PR #654 @ `1463cccb`, TypeScript + SQL, separate PG17) | exactly **24 28 30 31 33 34** fail. P2-1: (a) a listing id stored (`published` + post id), (p) the EARLIER same-text post's id stored for the lost attempt (`pNotTheFirstPost=false`); P2-2: (u) a `threads.com` permalink left the attempt `uncertain`, reconnect `COMPLETE_OUTCOME_UNKNOWN`; P3: an unclaimed local state returned the candidate (1), and under the ABA the completion was refused (`THREADS_BINDING_SERVICE_GENERATION_CHANGED`) while the attempt had already been settled `published` |
| Fail-before (runner, SQL only): #15's / #14's 002 | 31 33 34 / 31 33 34 |
| 34 after the fix | (a) ONE GET (the container) → `published_unidentified`, no id / permalink, `verifying`, +0 written; (p) never the earlier post's id; (u) `threads.com` → settled, `verifying`; (b) FINISHED / 503 → refused, nothing recorded; (e) another Threads user → 0 reads; (f) candidates only under a claimed state of this session, not consumed (`1,0,0,0`); unclaimed / another session / consumed / wrong hash / another person's state / another initiator / another Threads user / no such attempt → `NOT_PERMITTED`; another container / generation → `STALE`; `published` / a post id / AMBIGUOUS / non-final codes → `REQUEST_INVALID`; API roles → permission denied; (r) two sessions: the other session's settle stays, the recovery waited ~1.98 s, wrote nothing over it, the reconnect went through; (c) ERROR → `failed`; (x) ABA → the completion refused AND the attempt stayed `uncertain`; the next reconnect settled and bound |
| Recovery mutants (each fails 34 only) | no OAuth-state initiator check / no consumed check / no claimed-state check / no container CAS / no generation pin / non-final codes accepted / `published` accepted |
| Fence and #12 mutants | as #15 (INSERT-only → 33; `publishing` only → 33 34; no isolation guard → 33; no binding lock → 32 33; no generation compare → 31 32 33 34; read-backs gated → 30) |
| 002 rollback drift (25, before any change, catalog + bodies unchanged), H1 #43's column fixture, install / rollback / partial states | as #15, with the new signatures |
| Deno | Threads offline + publish Edge 183/183 (incl. the permalink-policy alignment test); connect entry 14/14; meta callbacks 41/41; recovery + owner bridge 10/10 |
| App unit / process gate / `G4T_VERDICT` / `G4T_BRIDGE_FLOW` | 65/65 / 7/7 / ALL_PASS / ALL_PASS |
| Lint / type check | `deno lint` (wiring config) 0 problems on G4's personal_auth directory (the inline `jsr:` imports gone); `deno check` clean |

## 7. NOT_VERIFIED / remaining

- Real Threads: a NEW grant's token reading a container made under the old grant; status finality / truthfulness; whether any
  container → post link exists that could prove an id. Without it every lost answer stays `published_unidentified`.
- The owner bridge's read is trusted (as every attested record); DB COMMIT and the HTTP request are not atomic.
- Liveness: FINISHED keeps the reconnect refused until a final status. No support-side recovery.
- Shared UX not changed (H5 `COMPLETE_OUTCOME_UNKNOWN`; G1 copy). G1 #635 carries older copies of overlapping paths.
