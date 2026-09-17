# Codex Task

- task_id: x-ai-lab-oauth-401-recovery-20260917
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: AI Lab通常`brand_post` dispatcher復旧後のX API `401`を解消する。OAuth再認可後に自然投稿が1回成功したが、その次の自然slotで再び401になったため、再現条件を安全に特定し、AI Labだけの認証経路を安定化する。

## User authorization

2026-09-17 JST、C1でdispatcher hotfix完了後、ユーザーが「じゃあすすめて」と明示。今回のAI Lab 401復旧に必要な範囲に限り、OAuth再認可フロー開始、AI Labの新access/refresh token保存、本人確認、read-back確認を承認済みと扱う。

ただしユーザー本人のX認可操作が必要な箇所では勝手に代行せず、認可URL/画面まで安全に準備してユーザー操作を待つ。

## Confirmed blocker

- AI Lab brand/account: `ai_salaryman_lab` / `ai_salaryman_lab_x`
- expected X username: exactly `kaishain_ai_lab`
- brand is active/live; publishing enabled; enabled post type includes `brand_post`
- dispatcher自体は正常化済みで、通常scheduled rowはcanonical AI Lab routeへ到達する
- 2026-09-17 OAuth再認可後、slot 6は16:23 JSTに自然投稿成功、X post id `2100485677238677509`、fingerprint 1件
- その次のslot 7は17:34 JSTに `X_REQUEST_FAILED:401` で失敗
- slot 7はx_post_idなし、追加fingerprintなし、retry/backfillなし
- したがって「再認可で恒久復旧」は未成立。1回成功後に同じ401が再発する条件の特定が必要

## C1 review — 2026-09-17

**NOT PASS / follow-up required.**

確認できた安全上の成果:
- OAuth再認可はAI Labだけに限定して成功
- requested scopesは `tweet.read users.read tweet.write offline.access` の4つのみ
- `/2/users/me` で `kaishain_ai_lab` 本人確認後にcredentialを受理
- Vault access/refresh refは存在確認のみで、値は未読
- 再認可後の最初の自然slotは1回だけ成功し、x_post_id 1件 / fingerprint 1件 / duplicate 0 / retry 0
- Kabumori/Mio、Cron/window、schema/migration/RPC definition、manual X/media writeは変更なし

未完了理由:
- 次の自然slotで同じ `X_REQUEST_FAILED:401` が再発した
- よって本タスクの「通常自動投稿が安定して401なしで継続する」完了条件を満たしていない

次のCodex作業は、**credential値を表示せずread-only中心に、1回成功後401になる認証ライフサイクルの原因特定**を優先する。

### Follow-up investigation scope

1. fresh `origin/main` / current production runtimeを確認し、他slot競合を確認
2. 16:23成功slotと17:34失敗slotの非秘密メタデータを比較
   - scheduled_posts / post_execution_logs
   - account/brand non-secret state
   - token-ref presence/timestamp metadata（値は読まない）
   - X response status/headersのうち秘密を含まない範囲
3. `x-test-post` のAI Lab token load pathを追跡し、各slotで同じcredential source/refを使っているか確認
4. OAuth callback後にaccess/refresh refやaccount stateを上書き/無効化する処理がないか監査
5. X側のaccess token有効期限・refresh token利用設計・token rotationの実装前提を、現行コードとOAuth仕様に照らして確認
6. 401が「access token失効」「別ref読込」「account state mutation」「scope/account mismatch」のどれかを証拠ベースで切り分ける

### Stop gate

以下の変更が必要と判明したら、**実装・deploy・token mutationの前にSTOPしてC1へ戻す**:
- token refresh/rotation実装
- x-oauth-connect / x-test-post source変更
- Vault/token ref更新
- OAuth再々認可
- DB schema/RPC/migration変更
- Cron/window変更

read-only調査とローカルtests/候補設計までは進めてよいが、本番credential mutationや新規deployは別承認とする。

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
8. natural AI Lab slots can continue without recurring 401

## Mandatory startup / safety

Before any mutation:
1. read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md`
2. fresh-check `origin/main`
3. inspect H2/G1/G2 for OAuth/Vault/x-oauth-connect overlap; STOP on conflict
4. read-only inspect production `x-oauth-connect` version/status/verify_jwt and AI Lab account metadata
5. confirm current runtime still enforces fixed AI Lab routing and exact username verification
6. do not read or print token/secret/Vault values

If source code or Function deploy is unexpectedly required, STOP and return for C1.

## Authorized production actions

At this follow-up stage, production actions are **read-only only** until a new C1 approval:
- inspect non-secret AI Lab account/brand/scheduled-post/log metadata
- inspect token-reference presence and non-secret timestamps only
- inspect deployed source/runtime metadata and code path
- inspect natural future slot outcome read-only

## Prohibited

- Kabumori OAuth/token/handle/publish/schedule changes
- Mio changes
- OAuth client secret rotation
- adding scopes beyond `tweet.read users.read tweet.write offline.access`
- media upload / `media.write`
- manual X post
- manual synthetic `brand_post`
- retry/backfill of failed rows
- Cron/posting-window time/probability changes
- DB schema/migration/RPC/RLS changes
- `supabase db push`
- unrelated Function deploy
- secret/token/Vault value output
- token refresh/rotation implementation or credential mutation before new C1 review

## Completion

When the recurring-401 cause is identified:
- append a new top section to `.agent/CODEX_REPORT.md`
- include evidence comparing the successful and failed natural slots, exact root-cause conclusion or remaining hypotheses, required fix blast radius, and safety checks
- if a source/credential mutation is required, set this TASK to `status: review_required`, `next_owner: chatgpt` **before** applying it
- fresh-check origin/main before pushing control/report metadata
- read back origin/main and STOP for C1
