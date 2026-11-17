# POSTONA X initial release: what is ready, and the gate to a real X send (G3-02 #26)

Status: SOURCE CANDIDATE review sheet. Nothing here is deployed, and no real X request has ever been made from this stack. PRODUCTION_NO_GO.
Initial release: Threads + X. Instagram later. Threads is G4's. This sheet covers G3's X reservation / approval / manual send / worker / notification path.

## 1. The user path and where each step is proven (fake X, local only)

The local stack is real GoTrue JWT → Kong → Edge (twins with the gate passed as enabled) → Postgres. The X API is the test-only fake in `supabase/candidates/postona_reservations_rollout/local_stack/fake_x.ts`. No step below has touched the real X.

| step | proven by | result |
|---|---|---|
| sign in, start the service, own workspace (G5) | L1 | PASS (local) |
| connect X (G4's real SQL, fake tokens) | L1, L7, L33 | PASS (local); real OAuth NOT_RUN |
| manual send ("send now"): sent once; the same request again answers the stored result without a second X call | L46 (G3-02 #26) | PASS (local) |
| manual send refused by X (429) → `failed`, not retried; unknown → `uncertain`, never re-sent | L46 | PASS (local) |
| manual send: another person / no token; the publishing switch off → 403, nothing sent | L46 | refused (local) |
| reservation create / double post / reschedule / reconfirm / cancel / conflicts | L3–L6, L16 | PASS (local) |
| approval: submit → revise → approve / reject → one reservation; races; lost answer | L35, L36, L38 | PASS (local) |
| worker: due → claim → pre-send → one X call → published; never twice; two workers | L19, L24, L28 | PASS (local) |
| worker vs X refusals: 400 / 401 / 403 / 429 → `failed` (X_REJECTED_*), never retried; 500 → `uncertain`; transport unknown → `uncertain` | L22, L23, L45 (G3-02 #26) | PASS (local) |
| worker vs a stale / changed connection, service end, owner loss, G5 holder | L20, L21, L32, L33, L40 | PASS (local) |
| result → one recorded event → one notification + outbox row; paging; end of list; session end → 401 | L39–L45 | PASS (local) |
| scheduler tick (pg_cron + pg_net → worker, signed one-use ticket) | L25–L31 | PASS (local); hosted Cron / Vault NOT_RUN |
| X timeout (no answer within 20 s) | Deno `x_publisher` unit tests | unit only; not driven end to end here |

## 2. Gate table for a real X send

Legend: **ready** = done and proven locally; **needs approval** = a person's explicit go is required; **to confirm** = not verifiable from here or the facts can change; **open** = work not done.

| # | item | state | evidence / what is missing |
|---|---|---|---|
| G1 | X API endpoint and body | ready (source) | `POST https://api.x.com/2/tweets`, body `{ text }` (`x_publisher.ts`). The official reference lists the same endpoint (docs.x.com, read 2026-11-17). |
| G2 | OAuth 2.0 scopes | to confirm (G4) | The official page requires the user token scopes `tweet.read`, `tweet.write`, `users.read` for create, plus `offline.access` for a refresh token. `media.write` is needed only if media is added. Whether G4's connect requests exactly these is G4's to confirm. |
| G3 | OAuth flow / redirect | to confirm (G4) | The authorization code with PKCE; the callback URL must match the app settings exactly. The code expires in 30 s. An access token lasts 2 h unless `offline.access` is granted (official page). G4 owns the flow and the redirect registration. |
| G4 | refresh token handling | to confirm (G4) | G4's generation-bound refresh fence exists as a source candidate. The worker and manual send take only G4's generation-bound credential source. In this source that source is `X_GENERATION_CREDENTIALS_NOT_CONNECTED`, so 0 sends are possible until G4 delivers it. |
| G5 | X developer app type / permissions | needs approval + to confirm | Read-and-write permission on the app; confidential vs public client (the app's client type decides whether a secret is used). Set in the X Developer Console by the account owner; not visible from here. |
| G6 | cost | needs approval | Pay-per-use (official pricing page, read 2026-11-17): Post: Create **$0.015 per request**; Post: Create with a URL **$0.200 per request**. Credits are prepaid; a spend limit per billing cycle can be set. A developer report says media uploads may be billed separately — unconfirmed, **to confirm**. Prices can change. |
| G7 | rate limits | ready (handling) / to confirm (values) | Official table for POST /2/tweets: **100 per 15 min per user, 10,000 per 24 h per app**. A 429 is answered until `x-rate-limit-reset`. G3 records 429 as `failed / X_REJECTED_429` and never retries automatically (L45, L46). Whether the product should retry later is a product decision. |
| G8 | URL in the text | open (product) | A URL makes a post cost $0.200 instead of $0.015 (official pricing). The text check does not detect or warn about URLs. Product decision: allow, warn, or block. |
| G9 | media (images / video) | open | G3 sends text only. Media needs the upload API, `media.write`, the 4 photos / 1 GIF / 1 video rule and account-dependent video limits (official reference). Not in the initial release scope here. |
| G10 | the first real test target | needs approval | A dedicated test X account, a single post, a person's explicit go, and how to delete the post afterwards. None of this has been done. |
| G11 | worker schedule (hosted) | needs approval + to confirm | pg_cron / pg_net / Vault in the hosted project, the pinned project ref, and the worker secret: proven only on the local stack (L25–L31). SQL 016 is not in the manifest. |
| G11b | the account's publishing switch | ready (fence) / open (control) | `social_accounts.publish_enabled` (PR #262) must be on for a manual send. After a connect it is off, and the send answers 403 `POSTONA_RESV_PUBLISH_DISABLED` with nothing recorded or sent (L46). The person's control that turns it on is G1 / G4's. L46 turns it on SYNTHETICALLY. |
| G12 | release gates in source | needs approval | `POSTONA_RESERVATION_API_ENABLED`, `POSTONA_APPROVAL_API_ENABLED`, `POSTONA_X_SINGLE_POST_ENABLED` and the worker gate are all `false`. Turning each on is a separate approved change. |
| G13 | database rollout | needs approval | The 17-step manifest (`postona_reservations_rollout/MANIFEST.tsv`) and its rollback are proven on PG17 only. Hosted adoption needs its own review and approval. G5's ownership-lock trigger (#645) is hosted-gated too. |
| G14 | independent review | open (central) | Each G3 PR is reviewed per delta. The central chat decides a final review of the X path as one unit. |
| G15 | push for results | open (G5 / later) | Results go to the in-app notification list and outbox. No push worker exists, and no push is sent. |

## 3. Contract for G1 (screens / HTTP), as built

- **Manual send** (`postona-x-single-post`): `{ socialAccountId, clientRequestId, text, consent: { confirmed: true, contentSha256 } }`. The answer `status` is one of:
  - `sent` (with `xPostId`);
  - `failed` (with `code`, e.g. `X_REJECTED_429`; show "not posted" and allow a new attempt with a new request id);
  - `uncertain` (never resend; tell the person to check X);
  - `pending` (not sent; the same request id may be sent again).

  Always reuse the same `clientRequestId` when retrying the same intent.
- **Reservations, approvals, notifications**: as in `docs/postona/g3-approval-notification-contract-20261105.md` (approve → one reservation; `nextCursor` paging; 401 means sign in again).
- **simulated**: today every result is from the fake X (`simulated: true`). A real send will answer `simulated: false`.

## 4. The boundary with G4

- G4 owns X OAuth (connect / refresh / disconnect), the verdict and precheck, and the generation-bound credential source. G4 owns all of Threads.
- G3 consumes G4's verdict (014) and credential generation only. G3 never reads a token itself; the twins use a test-only fake snapshot.
- The G3 paths and the G4 paths do not overlap in this TASK.

## 5. Not done here

- Any real X request.
- Real OAuth.
- Managed / hosted reads or writes.
- Paid API calls.
- Cost figures other than those read from the official pricing page on 2026-11-17.
