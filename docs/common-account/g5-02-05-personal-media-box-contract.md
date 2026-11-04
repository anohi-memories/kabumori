# POSTONA media box (素材BOX): the server contract for G1 (G5-02 tasks 5 and 6)

**Source candidate. Nothing is applied anywhere. Production NO_GO.** Before any managed use, these are needed, in order:
1. the central room's decision on G5-02 task 6 (H1 #306's F1 / F2 / F3 on PR #636, fixed here; see §6);
2. the owner's approval;
3. a read-only check of the managed project (its state is not known: never connected).

The pieces of this candidate:
- the files: `supabase/candidates/postona_personal_media_box/`;
- the tests: `supabase/tests/postona_personal_media_box_local_test.ts`, run by `postona_personal_workspace_local_run.sh`;
- the client: `client.ts` next to the SQL.

## 1. What the person gets

The person can add images and short videos to their **own** personal workspace, list them, view them, and delete them.

| | |
| --- | --- |
| types | `image/jpeg` `image/png` `image/webp` `image/heic` (up to 20 MiB); `video/mp4` `video/quicktime` (up to 50 MiB). Exact strings only. |
| limits per person | 200 assets, 10 open uploads, 2 GiB in total. A pending asset that holds an object counts too, even after its window closes. |
| storage | Supabase Storage bucket `postona-media`, **private**. There is no public URL and **no signed URL**. Reads use the person's own JWT, and every read is checked again. |
| who | the signed-in person only: a live session, not anonymous, POSTONA (`x_autopost`) active, the account active, and the personal workspace made by W0 |

The app never sends a workspace id, brand id, user id or object path of its own choosing. The server derives the workspace from the JWT, and the server picks both keys of an asset.

## 2. Flow (one press of 素材を追加)

```
app                                        server (PostgREST RPC)                       storage-api (Storage)
 | begin_upload(request_id, name, type, size) -> S2-2 -> T13 -> S2-3, limits; a pending row with TWO server keys
 |<- {status:"upload", upload:{bucket, object_path: <ws>/staging/<id>.<ext>, final_path: <ws>/<id>.<ext>, moved}}
 | upload(staging key, bytes, {contentType, upsert:false}) -----------------------------> INSERT policy: own pending, window open, STAGING key only
 | move(staging key, final key) --------------------------------------------------------> UPDATE policy: storage-api's move, staging -> own final key
 | complete_upload(asset_id)          -> the final object: owner, type, size; version + eTag pinned; limits re-checked
 |<- {status:"ready", asset}
```

- **list:** `list(limit, before_created_at, before_id)` returns ready assets whose final object is still at the pinned version, newest first. It pages by keyset (use `next` as the cursor).
- **view:** storage-api's **authenticated download** of the final key, with the person's JWT:
  - `client.storage.from(bucket).download(path)`;
  - or `GET {SUPABASE_URL}/storage/v1/object/authenticated/{bucket}/{path}` with `Authorization: Bearer <access token>`.

  The SELECT policy asks for everything again on every request: session, lifecycle, workspace, ownership, ready, and the pinned version.
- **delete:** `delete(asset_id)` takes the row out of the list (and out of reading) at once. Then `remove([final, staging])` removes the objects; storage-api allows that only for a deleted asset. Both calls can be retried.

## 3. API

Every RPC is `SECURITY DEFINER` with an empty `search_path`, and **only `authenticated` may EXECUTE it**. anon gets PostgREST `401 / 42501`. Every RPC answers HTTP 200 with a JSON `status`, like W0.

| RPC | arguments | success |
| --- | --- | --- |
| `postona_media_begin_upload` | `p_request_id uuid` (one per chosen file), `p_file_name text` (display only: the last path segment, control characters removed, ≤120 chars), `p_content_type text`, `p_size_bytes bigint` | `upload`: asset + `upload{bucket, object_path` (the staging key)`, final_path, content_type, max_bytes, expires_at, moved}`. `moved: true` means an earlier try already moved the bytes, so go straight to complete. Or `ready` when the same request is already complete. |
| `postona_media_complete_upload` | `p_asset_id uuid` | `ready` (asset). Idempotent. |
| `postona_media_list` | `p_limit` 1–50 (default 30), `p_before_created_at` + `p_before_id` (both or neither) | `ok` (`items[]`, `next` or null) |
| `postona_media_delete` | `p_asset_id uuid` | `deleted` (`already`, `remove{bucket, object_paths: [final, staging]}`). Idempotent. |

The asset in every answer has these fields: `id`, `kind` (`image` / `video`), `content_type`, `display_name`, `bytes`, `status`, `created_at`, `ready_at`, `bucket`, `object_path` (the final key).

### Status → class (what the app does)

| status | class | HTTP-equivalent | app |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` `SESSION_REVOKED` `SESSION_EXPIRED` | auth | 401 | sign in again |
| `SERVICE_NOT_ACTIVE` `SERVICE_NOT_REGISTERED` `SERVICE_DELETION_IN_PROGRESS` `ACCOUNT_LOCKED` `ACCOUNT_DELETION_IN_PROGRESS` `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` `OWN_WORKSPACE_CONFLICT` `WORKSPACE_OWNER_UNKNOWN` | forbidden | 403 | show "not available" (no retry) |
| `WORKSPACE_REQUIRED` | workspace | 409 | run W0 (`postona_ensure_my_personal_workspace`), then ask again |
| `MEDIA_NOT_FOUND` | not_found | 404 | drop it from the screen (another person's id answers the same: existence is not told) |
| `MEDIA_REQUEST_CONFLICT` `MEDIA_QUOTA_EXCEEDED` `MEDIA_UPLOAD_EXPIRED` `MEDIA_OBJECT_MISSING` `MEDIA_OBJECT_MISMATCH` `MEDIA_MOVE_REQUIRED` | conflict | 409 | new request id / upload or move again / free some space (`MEDIA_QUOTA_EXCEEDED` also comes from complete) |
| `MEDIA_TOO_LARGE` | too_large | 413 | "the file is too large" (`max_bytes` in the answer) |
| `MEDIA_TYPE_UNSUPPORTED` | unsupported | 415 | "this type is not supported" |
| `MEDIA_INPUT_INVALID` | invalid | 400 | a bug in the app |
| `ACCOUNT_LIFECYCLE_BUSY` `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE`, PostgREST / network errors | unavailable | 503 | retry later with the same request id |

storage-api answers with its own codes:
- 403: the policy refused;
- 404 / 400 `not_found`: not yours, gone, or not readable;
- 409: already exists;
- 413 / 415: the bucket's limits.

`client.ts` maps both kinds of answer to one `MediaFailure {class, status}`.

### Measured answers (local run, ids shortened)

```json
{"status":"upload","asset":{"id":"56116558-…","kind":"image","bytes":70,"bucket":"postona-media","status":"pending","ready_at":null,
 "object_path":"u_3ed8…/56116558-….png","content_type":"image/png","display_name":"いちごタルト.png","created_at":"2026-11-04T00:15:13.509183+00:00"},
 "upload":{"moved":false,"bucket":"postona-media","max_bytes":20971520,"expires_at":"2026-11-04T01:15:13.511776+00:00",
 "final_path":"u_3ed8…/56116558-….png","object_path":"u_3ed8…/staging/56116558-….png","content_type":"image/png"}}
{"status":"ready","asset":{"id":"56116558-…","status":"ready","bytes":70,"…":"…"}}
{"status":"ok","items":[{"id":"…","kind":"video","bytes":1000000,"…":"…"},{"id":"…","kind":"image","bytes":1500000,"…":"…"}],"next":{"before_id":"…","before_created_at":"…"}}
{"status":"deleted","already":false,"remove":{"bucket":"postona-media","object_paths":["u_3ed8…/8d513a5c-….jpg","u_3ed8…/staging/8d513a5c-….jpg"]}}
```

(The file name sent for the first answer was `../../etc/いちごタルト.png`; only `いちごタルト.png` is kept.)

## 4. For G1 (`apps/social-mobile`, G1-owned: G5 changed nothing there)

1. Copy `client.ts` into the app, or implement the same contract. It needs only `client.rpc` and `client.storage.from(bucket)` (`upload`, `move`, `download`, `remove`) of supabase-js v2.
2. `素材を追加`:
   1. pick a file;
   2. make **one `request_id` per picked file** and keep it until the add answers;
   3. call `addMedia(client, {name, contentType, body, size}, requestId)`. It runs begin → upload → move → complete.

   On `unavailable` or a network failure, call it again with the **same** `requestId`. It never makes a second asset, and it skips the steps already done.
3. The grid: `listMedia(client, 30, cursor)`, then `next` for more.
4. Each tile, and the video player:
   - `mediaReadSource(\`${SUPABASE_URL}/storage/v1\`, accessToken, asset)` gives `{uri, headers}`, for `<Image source>` or a player that takes headers;
   - or `mediaDownload(client, asset)` gives a Blob.

   Take the access token from the current session for each source, and **never store a URL or token**. Every request is checked again: after sign-out, the end of the service, a membership change or the stop, the next read fails with `forbidden` / `not_found`. There is no grace period, because no signed URL exists.
5. Delete: `deleteMedia(client, assetId)` (row, then both objects). Remove the tile at once; a retry is safe.
6. Cache:
   - Key every cached list, thumbnail and blob by the **signed-in user id**.
   - Drop them all on sign-out and on a change of user (measured: on one device, A → B → A each sees only their own).
   - Also drop them on any `auth` / `forbidden` / `workspace` answer, and when a read refuses.
   - Bytes the app cached itself stay on the device until it drops them: the server cannot revoke a copy. Keep caching to the screen's lifetime unless G1 decides otherwise.
7. Preview (`preview: true`) and offline:
   - Show what is cached for the signed-in user only, read-only.
   - Do not call begin / move / delete offline.
   - Queue nothing: an add needs the live session at every step.
8. Show `WORKSPACE_REQUIRED` as "preparing your workspace": the existing W0 call (G1 #592) solves it.

## 5. Future references (contract only; G3 / G6 sources unchanged)

A reservation (G3) or an AI assist (G6) will refer to an asset by **`asset_id`** only. They must never use the object path or a URL.

When such a consumer needs the bytes, it re-asks the server:
- a person-facing call uses the same JWT: `list` / download;
- a backend worker needs a future owner-checked, service-side read. That will be a separate TASK, with its own review.

That read must check, at use time:
- the asset is `ready`;
- the asset belongs to the reservation's owner;
- the owner's lifecycle is still active;
- the object is at the pinned version.

No such entry exists yet.

## 6. How it is enforced, and H1 F1 / F2 / F3 (G5-02 task 6)

**Metadata.** `private.postona_media_assets` is owner-only: row security is on with no policy, and no API role holds any grant. Only the definer functions touch it.

**Writers.** `begin` / `complete` / `delete` call S2-2, then T13, then S2-3, in W0's order. These are the reviewed gates, pinned by md5:
- S2-2 `a5d4d71c…`;
- T13 (with S2-1) `1f8cd9c7…`;
- S2-3 `fa462360…`.

T13's lifecycle lock serializes one person's writers; the quota counting relies on that.

**Readers.**
- `list` uses S2-2, plus one STABLE read of T13's facts, plus S2-3.
- The Storage policies use `postona_media_session()`.
  - The reason: storage-api sets the per-claim `request.jwt.claim.sub` / `.role` but **not `.session_id`**. So S2-2 answers `AUTH_REQUIRED` inside a Storage policy (measured, and kept as a test).
  - `postona_media_session()` applies S2-2's rules to the JSON claims. Any per-claim sub / role must match them.

**Storage policies.** There are four, for authenticated only. Each asks `postona_media_object_access(bucket, name, version, cmd)` together with storage-api's own `storage.operation`. That operation is set by storage-api, never by the client (measured: `storage.object.upload`, `storage.object.move`, `storage.object.copy`, `storage.object.get_authenticated`, `object.get_authenticated_info`, `storage.object.sign` / `sign_many`, `storage.object.list`, `storage.object.delete_many`).

| command | allowed |
| --- | --- |
| insert | the **staging** key of an own pending asset whose window is open (an upsert also needs update: refused) |
| update | only `storage.object.move` of the own staging object onto **its own final key** while pending. The destination is checked twice: by this WITH CHECK and by the SELECT of the new row (measured). |
| select | the final key of an own ready asset **at its pinned version**, for `get_authenticated` / `get_authenticated_info` only; the move's source and destination while pending; a deleted asset's objects for `delete_many`. **Never** `sign`, `sign_many`, `list` or `copy`. |
| delete | a deleted asset's final and staging objects |

"Own" means:
- `owner_user_id` = `auth.uid()`;
- workspace = the derived id;
- a live session;
- an active lifecycle.

### F1: a ready asset's bytes cannot change (was: a later write onto its key served 26 MiB under a 70-byte image)

- **Why it happened.** storage-api checks the INSERT permission, then writes with its own privileges, so a write can commit after its check (measured: two uploads of one key both succeed). With one key, a write that passed while the asset was pending could land after `complete`.
- **Now there are two keys.**
  - Uploads only ever reach the **staging** key.
  - The **final** key gets its object only from storage-api's move. A second move onto it fails (409 measured).
  - No client upload, upsert or copy can ever reach the final key, in any state (measured).
  - So a late write lands on the staging key and changes nothing ready. It shows up as an orphan.
- **Complete pins the final object's version and eTag.** Reads and list require that version. Even a write onto the final key that no client permission can make (only storage-api's own or the service key) makes the asset unreadable, unlisted and reported `broken_ready`. It never serves other bytes as this asset.
- **Measured before → after:**
  - PR #636: ready 70 B listed, 26 214 400 B served;
  - now: the same bytes as uploaded; after a simulated final write, not served.

### F2: no signed URL, every read checked (was: the person's own 1-year URL read after sign-out and service end)

- `sign` / `sign_many` / `list` / `copy` are refused by the SELECT policy, whatever the expiry asked; the direct `POST /object/sign` with `expiresIn=31536000` is refused (measured).
- The person reads with their own JWT through the authenticated download. The policy re-asks on **each** request. The next read is refused after any of these (measured):
  - a sign-out (a JWT still within exp);
  - session expiry;
  - service end;
  - membership removal;
  - the stop;
  - the delete RPC (before the objects are removed).

  The remaining window is zero for URLs, because none exist. Bytes the app itself cached are the app's to drop (§4).
- No new privileged issuer, proxy or Edge function was added. There is no service key on the device.

### F3: quota (was: an expired pending asset with an object left the count, and a late complete made 201 ready)

- **Usage.** It counts:
  - ready assets (the larger of the recorded and the stored size);
  - pending assets that hold an object (staging or final), even after their window closed;
  - pending assets whose window is open (their declared size).

  An expired pending asset releases its quota only when no object of it exists.
- **A late complete is allowed.** `complete` re-checks the count and the bytes, excluding itself, under T13's lock. It refuses with `MEDIA_QUOTA_EXCEEDED`, and the asset stays pending for the person to delete.
- **Measured before → after:**
  - PR #636: 201 ready, from 200 real uploads plus a late complete;
  - now: 199 more begin (the expired one counts), the late complete makes 200, and a forced 201st complete is refused;
  - the 2 GiB boundary is checked at complete with seeded rows (a real 2 GiB write was NOT_RUN).

**Orphans.** `private.postona_media_orphans()` (owner-only) lists five kinds:
- `object_without_asset`: a deleted asset's object, or a late staging write;
- `expired_upload_with_object`: still holds quota; the person completes or deletes it;
- `expired_upload`: no object;
- `broken_ready`: the final object is gone or not at the pinned version;
- plus the above for every person.

Cleaning is an operator step: delete through storage-api with the service key, never SQL. Storage refuses SQL deletes (`storage.protect_delete`).

**Lifecycle.** The person owns the objects in storage (`owner_id`).
- Whole-account deletion already counts them as `MANAGED_STORAGE_OWNED` and lists them in `account_lifecycle_storage_inventory`; they must be removed through storage-api.
- Ending POSTONA alone keeps them, but unreachable (every path refuses).

## 7. Install / stop / rollback (each as the lifecycle owner `postgres`, `ON_ERROR_STOP`)

**Order.**
1. MVP profile (`MVP_INSTALL`, W0, grants);
2. brands fix (`postona_brands_tenant_isolation`);
3. `001_media_box.sql`;
4. `MVP_RELEASE_PREFLIGHT.sql` (`PF_BRANDS PASS`).

**Install refusals** (each changes nothing):
- `MEDIA_SUPERUSER`;
- `MEDIA_PREREQUISITE_MISSING`;
- `MEDIA_GATE_CHANGED`;
- `MEDIA_OWNER_FILTERED`;
- `MEDIA_TAKEN` (includes an earlier candidate's table shape: roll that one back first);
- `MEDIA_UNREVIEWED_STORAGE_POLICY`;
- `MEDIA_POSTCONDITION_*`.

A re-run changes nothing.

**Stop** (`001_media_box_stop.sql`, idempotent): drops the four policies and revokes EXECUTE. The next read, upload, move or removal is refused at once (no signed URL outlives it), and every row and object stays. Re-running the install turns the box on again.

**Rollback** (`001_media_box_rollback.sql`):
- It refuses while an object or a pending / ready asset exists (`MEDIA_ROLLBACK_NOT_EMPTY`).
- It then removes everything, including the empty bucket (deleted with `storage.allow_delete_query` after checking it is empty).
- Measured: the catalog is back to its state before the install.

## 8. Tests (local only; the stack never calls out)

The stack is real GoTrue ES256, PostgREST, Kong, and storage-api v1.70.3 with its file backend, on PG 17.6.1.165. deno has `--allow-net` for the two local ports only.

**Storage-api facts**, kept as a test.

**Install:** refusals, idempotency, `PF_BRANDS` still PASS.

**The person:** PNG / JPEG / MP4 through begin → staging upload → move → complete, read back with the same SHA-256 (download and the `<Image>` source), pages, delete. Every retry gives the same answer, and `moved` on a retry.

**Another person, anon, forged paths.** Another person gets no list, read, sign, download, complete, delete, overwrite, move or remove of someone else's asset. These forged paths are all refused, and nothing is stored:
- `../`;
- the other workspace;
- the own final key;
- unknown ids;
- case changes;
- an extra `.png`.

A doubled slash collapses onto the own staging key. anon gets nothing, and there is no public URL.

**Lifecycle:** each state refuses every path, and A → B → A on one device works.

**Limits:** type / size, mismatch, the bucket's limits, retries / conflicts, two begins / staging uploads / moves / completes / deletes at once, expiry, orphans, quotas (exact boundaries).

**H1 F1 / F2 / F3:** BEFORE on PR #636's own install (each reproduced), then AFTER on this one (each PASS).

**Stop / rollback.**

**Mutants:** 18 / 18, each flipping its own case and refused by the original. They cover:
- the owner;
- the pending-only, unexpired, staging-only upload;
- the version pin;
- no sign;
- a deleted object readable only by removal;
- moves only onto the own final key (both destination guards);
- the session gate and lifecycle state;
- T13;
- the open-upload quota;
- an expired-with-object asset holding quota;
- complete re-checking the limits;
- the size check;
- list and delete are the caller's;
- the idempotent retry.
