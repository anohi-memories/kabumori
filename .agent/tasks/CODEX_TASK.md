# Codex Task

- task_id: x-ai-lab-oauth-401-recovery-20260917
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: AI Lab通常`brand_post` dispatcher復旧後、自然slotがX API `401`で停止している。AI Labアカウントだけを安全にOAuth再認可し、Vault-backed access/refresh tokenを置き換え、次の自然投稿で成功確認できる状態へ戻す。

## User authorization

2026-09-17 JST、C1でdispatcher hotfix完了後、ユーザーが「じゃあすすめて」と明示。今回のAI Lab 401復旧に必要な範囲に限り、OAuth再認可フロー開始、AI Labの新access/refresh token保存、本人確認、read-back確認を承認済みと扱う。

ただしユーザー本人のX認可操作が必要な箇所では勝手に代行せず、認可URL/画面まで安全に準備してユーザー操作を待つ。

## Confirmed blocker

- AI Lab brand/account: `ai_salaryman_lab` / `ai_salaryman_lab_x`
- expected X username: exactly `kaishain_ai_lab`
- brand is active/live; publishing enabled; enabled post type includes `brand_post`
- normal scheduled row now reaches canonical AI Lab dispatcher
- 2026-09-17 09:49 JST natural slot failed once with `X_REQUEST_FAILED:401`
- x_post_id=0, fingerprint=0, retry=0
- current path intentionally does not auto-refresh/fallback, so no unapproved credential mutation occurred
- previous controlled post succeeded after OAuth reauthorization on 2026-09-16, proving the account can publish when token is valid

## Goal

Recover only AI Lab OAuth credentials without changing Kabumori/Mio or posting behavior.

Expected end state:
1. OAuth authorization requests exactly: `tweet.read users.read tweet.write offline.access`
2. no `media.write`, `like.write`, `follows.write`
3. callback verifies `/2/users/me` username is exactly `kaishain_ai_lab` before accepting credentials
4. new access/refresh credentials are stored only in the AI Lab Vault-backed destinations
5. `connection_status=identity_verified`, `publish_enabled=true` preserved/restored for AI Lab
6. Kabumori OAuth/token/handle/publish state unchanged
7. no manual resend/backfill of failed scheduled rows
8. next natural AI Lab slot is used for delivery confirmation

## Mandatory startup / safety

Before any mutation:
1. read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md`
2. fresh-check `origin/main`
3. inspect H2/G1/G2 for OAuth/Vault/x-oauth-connect overlap; STOP on conflict
4. read-only inspect production `x-oauth-connect` version/status/verify_jwt and AI Lab account metadata
5. confirm current runtime still enforces fixed AI Lab routing and exact username verification
6. do not read or print token/secret/Vault values

If source code or Function deploy is unexpectedly required, STOP and return for C1 unless the required source is already the exact previously reviewed/deployed OAuth implementation and only read-back confirmation is needed.

## Authorized production actions

Allowed only for AI Lab:
- initiate OAuth authorization flow through existing `x-oauth-connect`
- accept callback after user authorization
- store/replace AI Lab access and refresh token references through the existing Vault-backed path
- verify exact scope set and `/2/users/me` username
- read back non-secret account metadata and token-ref presence booleans
- observe next natural scheduled `brand_post`

## Prohibited

- Kabumori OAuth/token/handle/publish/schedule changes
- Mio changes
- OAuth client secret rotation
- adding scopes beyond `tweet.read users.read tweet.write offline.access`
- media upload / `media.write`
- manual X post
- manual synthetic `brand_post`
- retry/backfill of failed 401 row
- Cron/posting-window time/probability changes
- DB schema/migration/RPC/RLS changes unless an existing approved RPC is merely invoked by the normal OAuth path
- `supabase db push`
- unrelated Function deploy
- secret/token/Vault value output

## Verification

After callback:
- username exactly `kaishain_ai_lab`
- requested/granted scope contains the approved four scopes and no unexpected write scopes
- AI Lab account remains fixed to `ai_salaryman_lab_x`
- connection status identity verified
- access/refresh token references present (presence only; never values)
- publish enabled remains true
- Kabumori account metadata/timestamps/settings unchanged except incidental read timestamps if any
- no manual X/media write occurred during OAuth recovery

Then wait for the next natural AI Lab scheduled slot. Success criteria:
- row claimed once
- no `UNSUPPORTED_POST_TYPE`
- no 401
- one succeeded terminal log
- one x_post_id
- one fingerprint
- no duplicate/retry/media write

If next natural slot fails for a different reason, record exact evidence and stop; do not widen scope automatically.

## Completion

When complete:
- append a new top section to `.agent/CODEX_REPORT.md`
- include pre/post non-secret account state, exact scopes, verified username, whether user interaction was required, natural-slot result, X text-write count/media-write count, safety checks, and remaining issues
- set this TASK to `status: review_required`, `next_owner: chatgpt`
- fresh-check origin/main before pushing control/report metadata
- read back origin/main and STOP for C1
