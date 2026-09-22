# Codex Task 2

- task_id: social-mobile-app-phase16-server-side-x-history-learning-adapter-candidate-20260922
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna
- purpose: Phase15 C2 PASS済みの「代打AI」history-learning candidateを、mobile入力を信頼しないserver-side authorization boundaryへ引き上げる。本人のAuth・workspace ownership・接続済みX identity・Vault tokenをtrusted server/DB stateから解決し、明示同意後のみ本人の過去X投稿を取得してpersona候補を生成するsource candidateを作る。production deploy / real X history call / live publishはまだ禁止。

## Product goal

ユーザーが「過去の自分の投稿を読んで覚えて」と言った時、
**本人の接続済みX投稿だけを、サーバー側で安全に取得し、代打AIの文体学習に使える仕組み**を作る。

UX上はシンプルでも、authorizationは必ずserver側で確定する。

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. 他3slot overlap確認

latest TASK statusだけを開始判断に使う。
H1/G1/G2と同じfile/migration/RPC/Edge Function/workflowを触る可能性があればSTOP。

## Model policy

- **Lunaで開始・継続**
- Solは Auth/RLS/Vault/X token boundary の具体的security blockerが出て、Lunaで安全に解決できない場合のみ
- 通常実装・テスト・UI整理でSolへ上げない

## Scope A — server-side trusted identity resolution

新しいserver-side history-learning boundaryをsource candidateとして作る。

Mobile/clientから authority として受け取ってよいのは最小限:
- user Auth bearer
- optional requested workspace selector
- explicit consent action / request intent

Clientから受け取って **authorityに使ってはいけない**:
- workspaceOwnerUserId
- ownedWorkspaceId
- verifiedAccounts
- platformUserId
- X access token
- Vault secret id
- publish permission

Server側でtrusted stateから解決:
1. bearer token -> Supabase Auth user
2. owner membership -> owned workspace
3. selected workspace belongs to user
4. workspace has exactly one X account
5. account is `identity_verified`
6. platform_user_id exists
7. access-token Vault reference exists
8. account binding is consistent

Fail closed on ambiguity.

## Scope B — Vault/token boundary

History fetcher must:
- read only the access token needed for the verified account
- never return token/secret id to mobile
- never log token
- never persist raw token outside Vault flow
- never read refresh token unless access-token refresh is explicitly needed by a future separate design
- never reuse admin/global X tokens

Prefer a dedicated server-side helper/function path clearly separated from publish adapters.

If existing RPC/function architecture can safely expose a single token-read operation internally, reuse only if responsibility is clean.
Do not weaken Vault/RLS/ACL.

## Scope C — X history fetch adapter candidate

Implement a source candidate for authenticated user's own:
- `GET /2/users/:id/tweets`

Requirements:
- target `:id` comes from DB-bound `platform_user_id`, not client
- scopes expected: `tweet.read users.read`
- pagination token handled server-side
- bounded max:
  - max 50 posts total
  - max 2 pages initially
- exclude replies/retweets unless later explicitly requested
- request only fields necessary for style analysis
- no likes/bookmarks/DMs/follow graph
- no write endpoint
- no media upload/post/repost path

Handle X errors with safe normalized classes; do not return raw provider bodies to mobile.

## Scope D — explicit consent runtime contract

History call must require a **fresh explicit consent action**.

Design candidate should distinguish:
- user conversational intent: 「過去投稿を見て」
- final consent: 「このアカウントの直近N件を読み取る」

No background/automatic history fetch.
No fetch on screen load.
No fetch merely because historyLearningIntent=true.

Consent request should show:
- target connected handle
- approximate max posts
- what will be learned
- raw post bodies will not be permanently stored
- no X posting occurs

## Scope E — analysis output

Reuse/improve Phase15 persona derivation.

Derived candidate can include:
- tone
- sentence length
- punctuation/emoji
- recurring vocabulary
- topic signals
- hashtag habits
- CTA style
- opening/closing patterns
- analyzed count/time

Output after history fetch:
- unconfirmed persona proposal
- provenance `past_post_analysis`
- `confirmed=false`

It must NOT write confirmed persona automatically.

User must review and confirm in the conversation UI before persistence.

## Scope F — raw content retention

Default:
- raw X post bodies exist only during request processing / test fixture lifetime
- do not write full posts to DB
- do not add history/archive table
- derived bounded profile + count/time only after later confirmation

If debugging metadata is needed, use non-content safe metadata only.

## Scope G — mobile integration candidate

Update `あなたの投稿AI` flow to support the server boundary contract without real production invocation.

Preferred UX:
1. user asks AI to learn past posts
2. app shows target account + max range
3. user gives final consent
4. future server response returns learned profile proposal
5. AI summarizes what it learned
6. user says `これで覚えて`
7. only then persona persistence candidate is called

Source candidate may use injected/mock server response.
Do not wire production network call in this phase unless it can remain disabled by construction.

## Scope H — tests

Minimum:
- missing Auth -> deny before X/Vault
- non-owner workspace -> deny
- multiple X accounts -> deny
- non-identity_verified -> deny
- missing platform_user_id -> deny
- missing Vault access-token ref -> deny
- client-supplied platform user/account identity ignored
- target X user id comes from trusted DB account
- explicit final consent required
- fetcher not called without final consent
- max 50 posts / 2 pages
- replies/retweets excluded
- only read endpoint used
- token never returned/logged
- raw posts not persisted
- X error normalized
- history result remains unconfirmed
- no publish/media/schedule path
- no publish permission mutation

Run:
- relevant Deno tests
- social-mobile typecheck
- lint
- Expo export
- `git diff --check`

Where possible use mocked Supabase/Vault/X calls and assert call ordering:
Auth -> ownership/account resolution -> token read -> X fetch.

## Scope I — production boundary

Phase16 is **source candidate only**.

Forbidden:
- production migration apply
- production RPC/RLS/ACL change
- production Edge Function deploy
- production Vault token read
- production X history API call
- OAuth scope/Portal change
- production settings/persona write
- OpenAI live call
- X post/media/repost
- `publish_enabled=true`
- Cron/scheduler
- scheduled_posts
- app-wide data-source switch
- migration-history repair/reconcile
- blind db push

Production mutation = 0.

## Parallel safety

Current H1 is Kabumori app holdings/watch + Important News candidate.
Do not touch H1 files.
If H1 unexpectedly changes shared social-mobile/X OAuth/Vault files, STOP and report overlap.

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- `.agent/CODEX_REPORT_2.md` must include:
  1. server authorization flow
  2. trusted vs untrusted input boundary
  3. Vault token handling
  4. X endpoint/request shape
  5. consent flow
  6. raw-content retention behavior
  7. changed files
  8. tests/call-order proof
  9. production mutation=0
  10. remaining risks
  11. next rollout proposal
- commit/push
- fresh origin/main check
- STOP for C2


## Final C2 — 2026-09-22 (Phase16 server-side X history-learning adapter candidate)

**PASS. Phase16 source candidate is complete.**

Accepted:
- server-side authority resolution is correctly separated from client input.
- the client may supply only Auth bearer, optional workspace selector, and explicit consent; owner identity, workspace ownership, X account, platform user id, and token reference are resolved through trusted server-side readers.
- non-owner, ambiguous/multiple-account, non-verified, missing platform id, and missing token-reference states fail closed.
- target X user id is taken from the trusted DB-bound account, not mobile input.
- history fetch is read-only \`GET /2/users/:id/tweets\`, bounded to 50 posts / 2 pages, with replies/retweets excluded.
- access token is not returned to the client, not persisted, and no refresh/admin/global-token fallback exists in this candidate.
- provider errors are normalized and raw provider bodies are not returned.
- raw X post bodies are not returned or persisted by the candidate.
- output remains an unconfirmed \`past_post_analysis\` persona proposal; no automatic persona persistence occurs.
- no publish/media/schedule/publish-permission mutation path is introduced.
- the default Edge entrypoint is deliberately disabled and cannot read Vault or call X accidentally.
- call-order tests cover Auth -> membership/workspace -> account -> token read -> X fetch.
- reported Deno tests, regressions, social-mobile typecheck/lint/Expo export, and diff-check pass.
- production mutation = 0.

Important next gate:
- before any production deploy or real X-history read, prove the exact token-read mechanism in a disposable environment.
- the production implementation must preserve the same trusted-state order and must not expose a generic client-callable Vault secret reader.
- prefer the narrowest possible internal function/RPC contract that resolves the verified account and reads only that account's access token.

No production rollout is implied by this PASS.

Future work must be separately scoped for:
1. disposable Vault/RLS/token-boundary proof,
2. production deployment gate for the history-learning Function,
3. exactly-one real QA history fetch with explicit user consent,
4. later confirmed persona persistence / LLM conversation wiring.
