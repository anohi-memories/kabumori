# POSTONA media box (素材BOX): the server contract for G1 (G5-02 task 5)

**Source candidate. Nothing is applied anywhere. Production NO_GO.** Before any managed use, three things are needed, in order:
1. one focused H1 security review;
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
| limits per person | 200 assets (pending + ready), 10 open uploads, 2 GiB in total |
| storage | Supabase Storage bucket `postona-media`, **private**. There is no public URL. Reads use signed URLs of at most 300 s. |
| who | the signed-in person only: a live session, not anonymous, POSTONA (`x_autopost`) active, the account active, and the personal workspace made by W0 |

The app never sends a workspace id, brand id, user id or object path of its own choosing. The server derives the workspace from the JWT, and the server picks the object path.

## 2. Flow (one press of 素材を追加)

```
app                                   server (PostgREST RPC)                      storage-api (Storage)
 | begin_upload(request_id, name, type, size) ->  S2-2 -> T13 -> S2-3, limits; a pending row with a server path
 |<- {status:"upload", upload:{bucket, object_path, ...}}
 | upload(object_path, bytes, {contentType, upsert:false}) ------------------------> INSERT policy: own pending asset, not expired
 | complete_upload(asset_id)       ->  the stored object: owner, type and size must match -> ready
 |<- {status:"ready", asset}
```

- **list:** `list(limit, before_created_at, before_id)` returns ready assets, newest first. It pages by keyset (use `next` as the cursor).
- **view:** `createSignedUrl(object_path, ≤300)` works for your own ready asset only. The URL serves the bytes until it expires or the object is removed.
- **delete:** `delete(asset_id)` takes the row out of the list at once. Then `remove([object_path])` removes the object; storage-api allows that only for a deleted asset. Both calls can be retried.

## 3. API

Every RPC is `SECURITY DEFINER` with an empty `search_path`, and **only `authenticated` may EXECUTE it**. anon gets PostgREST `401 / 42501`. Every RPC answers HTTP 200 with a JSON `status`, like W0.

| RPC | arguments | success |
| --- | --- | --- |
| `postona_media_begin_upload` | `p_request_id uuid` (one per chosen file), `p_file_name text` (display only: the last path segment, control characters removed, ≤120 chars), `p_content_type text`, `p_size_bytes bigint` | `upload` (asset + `upload{bucket, object_path, content_type, max_bytes, expires_at}`, 1 hour), or `ready` when the same request is already complete |
| `postona_media_complete_upload` | `p_asset_id uuid` | `ready` (asset). Idempotent. |
| `postona_media_list` | `p_limit` 1–50 (default 30), `p_before_created_at` + `p_before_id` (both or neither) | `ok` (`items[]`, `next` or null) |
| `postona_media_delete` | `p_asset_id uuid` | `deleted` (`already`, `remove{bucket, object_path}`). Idempotent. |

The asset in every answer has these fields: `id`, `kind` (`image` / `video`), `content_type`, `display_name`, `bytes`, `status`, `created_at`, `ready_at`, `bucket`, `object_path`.

### Status → class (what the app does)

| status | class | HTTP-equivalent | app |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` `SESSION_REVOKED` `SESSION_EXPIRED` | auth | 401 | sign in again |
| `SERVICE_NOT_ACTIVE` `SERVICE_NOT_REGISTERED` `SERVICE_DELETION_IN_PROGRESS` `ACCOUNT_LOCKED` `ACCOUNT_DELETION_IN_PROGRESS` `ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND` `OWN_WORKSPACE_CONFLICT` `WORKSPACE_OWNER_UNKNOWN` | forbidden | 403 | show "not available" (no retry) |
| `WORKSPACE_REQUIRED` | workspace | 409 | run W0 (`postona_ensure_my_personal_workspace`), then ask again |
| `MEDIA_NOT_FOUND` | not_found | 404 | drop it from the screen (another person's id answers the same: existence is not told) |
| `MEDIA_REQUEST_CONFLICT` `MEDIA_QUOTA_EXCEEDED` `MEDIA_UPLOAD_EXPIRED` `MEDIA_OBJECT_MISSING` `MEDIA_OBJECT_MISMATCH` | conflict | 409 | new request id / upload again / free some space |
| `MEDIA_TOO_LARGE` | too_large | 413 | "the file is too large" (`max_bytes` in the answer) |
| `MEDIA_TYPE_UNSUPPORTED` | unsupported | 415 | "this type is not supported" |
| `MEDIA_INPUT_INVALID` | invalid | 400 | a bug in the app |
| `ACCOUNT_LIFECYCLE_BUSY` `ACCOUNT_LIFECYCLE_WRITER_FENCE_UNAVAILABLE`, PostgREST / network errors | unavailable | 503 | retry later with the same request id |

storage-api answers with its own codes:
- 403: the policy refused;
- 404: not yours, or gone;
- 409 `KeyAlreadyExists`: already uploaded. `client.ts` then goes on to complete.
- 413 / 415: the bucket's limits.

`client.ts` maps both kinds of answer to one `MediaFailure {class, status}`.

### Measured answers (local run, ids shortened)

```json
{"status":"upload","asset":{"id":"0f94d3db-…","kind":"image","bytes":70,"bucket":"postona-media","status":"pending","ready_at":null,
 "created_at":"2026-11-03T22:58:47.958095+00:00","object_path":"u_e01e7de1b395b4897c58b39d/0f94d3db-….png","content_type":"image/png",
 "display_name":"いちごタルト.png"},
 "upload":{"bucket":"postona-media","max_bytes":20971520,"expires_at":"2026-11-03T23:58:47.959852+00:00","object_path":"u_e01e…/0f94d3db-….png","content_type":"image/png"}}
{"status":"ready","asset":{"id":"0f94d3db-…","status":"ready","bytes":70,"ready_at":"2026-11-03T22:58:47.974046+00:00", "…":"…"}}
{"status":"ok","items":[{"id":"22b72481-…","kind":"video","bytes":1000000,"content_type":"video/mp4","display_name":"clip.mp4","…":"…"},
 {"id":"f22b83d3-…","kind":"image","bytes":1500000,"content_type":"image/jpeg","display_name":"朝の一枚.jpg","…":"…"}],
 "next":{"before_id":"f22b83d3-…","before_created_at":"2026-11-03T22:58:48.010714+00:00"}}
{"status":"deleted","already":false,"remove":{"bucket":"postona-media","object_path":"u_e01e…/f22b83d3-….jpg"}}
```

(The file name sent for the first answer was `../../etc/いちごタルト.png`; only `いちごタルト.png` is kept.)

## 4. For G1 (`apps/social-mobile`, G1-owned: G5 changed nothing there)

1. Copy `client.ts` into the app, or implement the same contract. It needs only `client.rpc` and `client.storage.from(bucket)` of supabase-js v2.
2. `素材を追加`:
   1. pick a file;
   2. make **one `request_id` per picked file** and keep it until the add answers;
   3. call `addMedia(client, {name, contentType, body, size}, requestId)`.

   On `unavailable` or a network failure, call it again with the **same** `requestId`: it never makes a second asset.
3. The grid: `listMedia(client, 30, cursor)`, then `next` for more. For each tile, `mediaReadUrl(client, asset, 120)`. Keep the URL only in memory, and ask again when it expires (≤300 s).
4. Delete: `deleteMedia(client, assetId)`. Remove the tile at once; a retry is safe.
5. Cache:
   - Key every cached list, URL and thumbnail by the **signed-in user id**.
   - Drop them all on sign-out and on a change of user (measured: on one device, A → B → A each sees only their own).
   - Also drop them on any `auth` / `forbidden` / `workspace` class answer.
6. Preview (`preview: true`) and offline:
   - Show cached tiles only, read-only.
   - Do not call begin / delete offline.
   - Queue nothing: an add needs the live session at begin, upload and complete.
7. Show `WORKSPACE_REQUIRED` as "preparing your workspace": the existing W0 call (G1 #592) solves it.

## 5. Future references (contract only; G3 / G6 sources unchanged)

A reservation (G3) or an AI assist (G6) will refer to an asset by **`asset_id`** only. They must never use the object path or a URL.

When such a consumer needs the bytes, it re-asks the server:
- a person-facing call uses the same JWT: `complete` / `list` / sign;
- a backend worker needs a future owner-checked, service-side read. That will be a separate TASK, with its own review.

That read must check, at use time:
- the asset is `ready`;
- the asset belongs to the reservation's owner;
- the owner's lifecycle is still active.

No such entry exists yet.

## 6. How it is enforced (for the H1 review)

**Metadata.** `private.postona_media_assets` is owner-only: row security is on with no policy, and no API role holds any grant. Only the definer functions touch it.

**Writers.** `begin` / `complete` / `delete` call S2-2, then T13, then S2-3, in W0's order. These are the reviewed gates, pinned by md5:
- S2-2 `a5d4d71c…`;
- T13 (with S2-1) `1f8cd9c7…`;
- S2-3 `fa462360…`.

T13 takes the lifecycle lock, so one person's writers are serialized; the quota counting relies on that.

**Readers and Storage.**
- `list` uses S2-2, plus one STABLE read of T13's facts (account, `x_autopost` entitlement, deletion in progress), plus S2-3.
- The Storage policies use `postona_media_session()` instead of S2-2.
  - The reason: storage-api sets the per-claim `request.jwt.claim.sub` / `.role` but **not `.session_id`**. So S2-2 answers `AUTH_REQUIRED` inside a Storage policy (measured).
  - `postona_media_session()` applies S2-2's rules to the JSON claims, which storage-api and PostgREST both set. Any per-claim sub / role must match them.

**Storage policies** (authenticated only; **no UPDATE policy**, so an object is never overwritten). Each one asks `postona_media_object_access(bucket, name, op)`:
- `insert`: an own `pending` asset whose upload window is still open;
- `select`: an own `ready` asset, or an own `deleted` asset while storage-api's own removal (`storage.operation = storage.object.delete_many`) reads it;
- `delete`: an own `deleted` asset.

"Own" means:
- `owner_user_id` = `auth.uid()`;
- workspace = the derived id;
- a live session;
- an active lifecycle.

**Completion.** `complete` takes the owner, type and size from storage-api's own record of the object, never from the client.

**Measured and residual (for the review):**
- **Concurrent uploads.** storage-api tests the INSERT permission in a transaction it rolls back, then writes with its own privileges. So two concurrent uploads of one new key can **both** succeed (measured: in 6 of 8 local runs; the last write wins).
  - It is always the person's own pending path, and there is one object row; `complete` checks what it then sees.
  - But an upload still in flight when `complete` runs can replace the bytes afterwards. The size and type are still bounded by the bucket (50 MiB, the six types). The recorded `bytes` can then differ from the stored ones, so the 2 GiB quota is exact only up to that.
  - Never cross-tenant.
- **Signed URL lifetime.** It is chosen by the client. `client.ts` caps it at 300 s, but storage-api does not enforce a cap.
- **Views calling functions** are out of scope. Only Storage policies and the RPCs exist.
- **Lifecycle.** Objects are owned by the person in storage (`owner_id`).
  - Whole-account deletion already counts them as `MANAGED_STORAGE_OWNED` and lists them in `account_lifecycle_storage_inventory`. They must be removed through storage-api.
  - Ending POSTONA alone keeps them, but unreachable (every path refuses `SERVICE_NOT_ACTIVE`). A restart shows them again (measured).

**Orphans.** `private.postona_media_orphans()` (owner-only) lists two kinds:
- objects without a pending / ready asset;
- expired uploads that have no object.

Cleaning is an operator step: delete through storage-api with the service key, never SQL. Storage refuses SQL deletes (`storage.protect_delete`).

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
- `MEDIA_OWNER_FILTERED` (the owner needs BYPASSRLS to read every row of `storage.objects` / `auth.sessions`);
- `MEDIA_TAKEN`;
- `MEDIA_UNREVIEWED_STORAGE_POLICY` (another permissive policy on `storage.objects` reaching an API role);
- `MEDIA_POSTCONDITION_*`.

A re-run changes nothing (the catalog is compared).

**Stop** (`001_media_box_stop.sql`, idempotent): drops the three policies and revokes EXECUTE. Every row and object stays; re-running the install turns the box on again.

**Rollback** (`001_media_box_rollback.sql`):
- It refuses while an object or a pending / ready asset exists (`MEDIA_ROLLBACK_NOT_EMPTY`). Remove the objects through storage-api first.
- It then removes the policies, the functions, the table and the empty bucket. For that one statement it sets `storage.allow_delete_query`, after checking the bucket is empty.
- Measured: the catalog is back to its state before the install.

## 8. Tests (local only; the stack never calls out)

The stack is real GoTrue ES256, PostgREST, Kong, and storage-api v1.70.3 with its file backend, on PG 17.6.1.165. deno has `--allow-net` for the two local ports only.

**Storage-api facts** (measured, and kept as a test): what a policy sees there, and S2-2's `AUTH_REQUIRED` there.

**Install:** each refusal changes nothing; a re-run is the same catalog; `PF_BRANDS` still PASS.

**The person:**
- a real 1×1 PNG, a 1.5 MB JPEG and a 1 MB MP4: begin → upload → complete;
- read back through a signed URL with the same SHA-256;
- pages, newest first;
- delete → the bytes are gone, and a URL signed before the delete stops serving them;
- every retry gives the same answer.

**Another person, anon, forged paths.** Another person cannot:
- list, read, sign, download, complete or delete someone else's asset;
- overwrite or remove someone else's object;
- upload to their path, or to any path the server did not give them.

The forged paths tried include `../`, the other workspace, case changes and an extra `.png`. A doubled slash is collapsed by supabase-js onto the person's own given path. anon gets nothing, and there is no public URL.

**Lifecycle.** Each of these refuses every path:
- no session;
- signed out (JWT within exp);
- an expired session;
- service ended (then restarted through the real RPC);
- account locked;
- membership removed;
- no workspace yet (`WORKSPACE_REQUIRED`).

A → B → A on one device works as above.

**Limits:**
- unsupported, empty or oversize declarations;
- bytes or type differing from the declaration → `MEDIA_OBJECT_MISMATCH`, and the person cleans up;
- the bucket's text/plain and >50 MiB refusals;
- `complete` before any upload;
- the same request twice → one asset; a changed request → conflict;
- two begins at once → one asset;
- two uploads at once (see §6);
- two completes / deletes at once;
- an expired upload;
- orphans of both kinds;
- the quotas (10 open uploads / 200 assets / 2 GiB, the boundary exact).

**Stop / rollback:** the stop closes everything and keeps the data; a re-install opens it again; the rollback refuses while anything is stored, then the catalog is as before.

**Mutants:** 13 / 13, each flipping its own case. They cover:
- the owner;
- the pending-only insert and its expiry;
- a deleted object visible only to removal;
- removal only after delete;
- the Storage session gate and lifecycle state;
- T13 in writers;
- the open-upload quota;
- the size check;
- list and delete are the caller's;
- the idempotent retry.
