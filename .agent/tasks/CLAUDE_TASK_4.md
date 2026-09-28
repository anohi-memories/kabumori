# Claude Task 4

- task_id: x-social-mobile-posting-backend-foundation-phase3-20260928
- owner: claude
- slot: claude-4
- status: idle
- next_owner: none
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Phase 2で確認した投稿操作backendの欠落を、最小かつ安全な順序で解消する。まず「投稿本文の正本」「投稿詳細の安全な読み取り」「draft本文の編集保存」「失敗理由の安全な読み取り」をsource-onlyで実装し、再生成/承認/再試行は次段へ分離する。

## Accepted source

- PR #49 merged to main as `9eef82bf0729c25bf6aaf15951c138704b5b67b7`
- Phase 2 verdict: PASS
- no Codex review required for Phase 2
- Phase 2 UI truthfully disables edit/regenerate/approve/retry because no client-callable backend existed

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G4 Phase 2 report
2. Independent G4 worktree/checkout.
3. Fresh fetch `origin/main`; branch from latest main including PR #49 merge.
4. Read current Supabase skill/docs before DB/RLS/RPC/Edge changes.
5. Read-only inspect current production schema for:
   - `scheduled_posts`
   - `post_execution_logs`
   - relevant brand/workspace membership tables
   - existing posting/dispatcher RPCs
6. Confirm G3 file separation. G3 owns Auth/account/provider-readiness files.
7. If existing production schema differs materially from migration history, STOP before source changes and report the discrepancy.

## Goal

Unlock the first real posting interaction safely:

`post detail -> authoritative body -> edit draft -> persisted reload`

and expose a sanitized failure reason for failed posts where the user is authorized.

Do not implement AI regenerate, approval, schedule/post-now, or retry in this TASK.

## Security principle

Do NOT weaken existing dispatcher/service-role RPC grants merely to make the mobile app work.

Prefer a narrow authenticated command/read boundary that:
- derives the user from JWT/session
- checks exact workspace/brand membership server-side
- checks exact post ownership/scope
- constrains mutable statuses
- never accepts arbitrary brand authorization from client input
- does not expose service_role to the client
- does not expose raw provider/X tokens or internal stack traces

If an Edge Function is the safer boundary than direct authenticated RPC/DML, use it.

## Stage A — production schema read-only verification

Before implementation, confirm read-only:
- exact columns/types/constraints on `scheduled_posts`
- whether `post_execution_logs.brand_id` exists
- exact relationship between log rows and scheduled posts
- current RLS/grants for authenticated/service_role
- exact membership/brand authority source
- whether an existing body/content table already exists
- whether any existing safe user-facing API already covers this

Record exact findings in Report.

No production mutation.

## Stage B — authoritative post body model

If no existing authoritative body field/table exists, design the narrowest candidate schema.

Requirements:
- one authoritative user-visible body per scheduled/draft post
- clear nullable/backfill behavior for historical rows
- no fake body inferred from mock data
- do not overwrite published historical content unexpectedly
- define max length / validation consistent with posting contract
- preserve existing dispatcher behavior unless intentionally adapted in source candidate

Migration is candidate/source-only. Do not apply.

## Stage C — safe post-detail read contract

Implement source-only contract for an authenticated user to read only posts they are authorized to see.

Return only fields needed by the app:
- post id
- safe status
- authoritative body
- scheduled time
- approval/posting state if already authoritative
- sanitized failure summary if available
- reconnect-needed should continue to come from existing account state, not duplicated here

Do not expose:
- provider tokens
- service role data
- raw exception traces
- unrestricted execution log rows
- another brand/account's posts

## Stage D — draft edit contract

Implement edit only for states where mutation is safe.

At minimum:
- allow only authenticated authorized user
- exact post/brand scope check
- only mutable pre-publish states
- reject publishing/published
- reject stale/invalid post
- validate body length/content
- prevent cross-brand ID guessing
- return persisted canonical row/result
- safe idempotency/concurrency behavior where practical

No direct client access to dispatcher RPCs.

## Stage E — failure reason read

If `post_execution_logs` can safely support this:
- expose only a sanitized user-facing failure classification/message
- latest relevant attempt only or another explicitly defined rule
- never expose raw stack, request/response secrets, tokens, headers, provider payloads
- exact post/brand authorization

If schema cannot support this safely without larger redesign, leave it disabled and report why.

## Stage F — mobile integration

Update the Phase 2 post detail UI only after the backend/source contract exists.

Expected:
- real body shown from authoritative source
- edit action enabled only when contract says editable
- save waits for confirmed backend result
- reload reflects persisted value
- failure reason shown only from sanitized real contract
- regenerate/approve/retry remain disabled in this phase

No fake success.

## G3 separation

Do not modify:
- auth callback
- provider linking
- PKCE/recovery/session storage
- login methods
- provider readiness/config validation

If overlap is unavoidable, STOP and report exact file/reason.

## Tests

Add focused tests for:
- authenticated own-brand read
- cross-brand denial
- unauthenticated denial
- editable status allowlist
- publishing/published mutation denial
- invalid/too-long body
- concurrency/stale update behavior where applicable
- sanitized failure reason
- no raw secret/token/log leakage
- mobile truthfulness
- reload after save

Run:
- relevant disposable DB/migration tests
- Edge/RPC tests
- full social-mobile tests
- data-view tests
- typecheck
- lint
- Expo web + iOS export
- git diff --check
- secret scan

## Production constraints

Do NOT:
- apply migration
- deploy Edge Function
- change RLS/grants in production
- change dispatcher production behavior
- make real X post
- activate publish authority
- modify Auth provider/config/secrets

production_mutation=0.

## Review policy

This Phase 3 introduces a new DB/API authorization boundary, so independent review IS required before merge/apply.

Because Codex capacity is currently constrained:
- do not assign H1/H2 automatically
- at K4, recommend a separate-room Claude independent review
- recommended independent reviewer: **Opus5.5（高）**
- reviewer must use a separate worktree/read-only checkout from implementer

## Completion / K4

Report:
- production schema read-only findings
- chosen API/security boundary
- body storage design
- edit authorization/status rules
- failure reason sanitization
- changed_files
- migration/RPC/Edge changes
- tests
- production_mutation=0
- G3 overlap
- remaining disabled actions
- exact independent review scope
- recommended next step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.


## Report

- task_id: x-social-mobile-posting-backend-foundation-phase3-20260928
- result: **STOP after Stage A（設計に進まず報告）**。Stage Aの読み取り専用確認で、本Phaseのゴール（投稿本文の正本・安全な読み取り・編集・失敗理由の読み取り）が、いずれも**tenant membership（`auth.users`からbrand/workspaceへの正規の対応）が本番未適用であること**に阻まれていることを確認した。TASKのSecurity principle（「exact workspace/brand membership server-side check」「client-supplied brand authorizationを受け付けない」）を満たす設計が、この前提なしには書けないため、Stage B（schema設計）以降には進まず、ここで停止して報告する。production変更・migration作成・RPC作成は一切行っていない。
- model_used: Sonnet 5（高）※TASK推奨は Opus5.5（高）。理由は末尾「model note」参照。
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（新規branch/PRは作成していない。読み取り調査のみ）

### Stage A — production schema read-only findings

このセッションからは本番Supabaseへの直接接続手段がない（このworktreeに`supabase/config.toml`のlinkが無い。プロジェクト運用ルール上もworktreeからのCLI直link/pushは避ける対象）。そのため、**2026-09-17/18に実施済みのread-only監査ドキュメント**（`apps/social-mobile/docs/phase3-schema-rls-inventory.md`、`docs/phase4-membership-rls-contract.md`。いずれもSupabase metadata APIでのread-only確認、production write/migration/RLS/grant/RPC変更は無しと明記）を一次情報として採用し、以降のmigration履歴と突き合わせて矛盾がないかを確認した。

確認できたこと（production、2026-09-17/18時点）:

1. **`scheduled_posts`**: `id, schedule_date, post_type, slot_no, scheduled_for, status, attempt_count, brand_id`ほか。**本文/draft列（`generated_text`等）は存在しない**。`status`は`pending/running/succeeded/failed`の4値（migration `20260828203000_create_post_scheduler.sql`のcheck制約と一致）。RLSは有効だが、authenticated向けSELECT policyは`private.is_admin()`のみ→**一般mobileユーザーは現状readできない**（admin以外は0行）。
2. **`post_execution_logs`**: `scheduled_post_id, post_type, status, x_post_id, message, created_at, brand_id`ほか。**`brand_id`列は実在する**（Phase 2 Reportで「未確認」としていた点を、この監査ドキュメントで確定できた）。ただしRLSは`scheduled_posts`と同じくadmin-onlyで、**一般mobileユーザーは現状readできない**。
3. **`brands`・`social_accounts`**: いずれもauthenticated向けgrant/policyが確認できず、mobile側は現状readできない（`social_accounts`はVault参照列も含むため、既存の`SupabaseSocialRepository`の実装どおり、選択列を絞ってもRLSで止まる）。
4. **membership/ownership**: `auth.users.id`からbrand/workspace/accountへ結ぶ正規のrelationは、監査時点で**存在しない**（`admin_users`は管理画面専用で別モデル）。Phase 4候補`brand_memberships`（`supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`）が唯一の設計だが、**冒頭コメントに明記のとおりproduction未適用**。disposable Postgres（Podman、production資格情報なし）での候補apply・object/RLS/grant read-back・anon/non-member/brand A member/brand B member/admin/service_roleのpolicy matrix・membership write拒否・rollbackはすべてPASS済みだが、production適用の承認・実施はまだ行われていない。
5. **既存の安全なAPI**: 上記を読める既存の安全なuser-facing APIは無い（`social-mobile-brand-dry-run` edge functionはワークスペース単位のプレビュー生成のみで、投稿の読み取り/永続化API ではない）。
6. **migration履歴との整合性**: `20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql`以降のPhase1b〜1iのdispatcher migration群は、`scheduled_posts.brand_id`が既に存在する前提のpreflight assertを含むが、この列をこのrepoのmigration historyの中で`add column`している箇所は無い（`brands`・`social_accounts`のcreate文も同様に見当たらない）。単体で見ると「migration履歴だけでは説明できない列」に見えたが、上記2026-09-17監査ドキュメントにより、**この列は監査時点で本番に実在することを確認済み**であり、これらのmigrationはbase schema（migration履歴の外で存在する、より古い基盤）を前提にした追加であると判断した。「production schemaがmigration履歴と重大に異なる」というほどの矛盾ではなく、migration履歴がbase schemaの起源を含んでいないだけ、という結論。
7. 上記1回の監査（09-17/18）以降、production環境に対してmigrationはapplyされていない（このリポジトリのmigrationはPhase0以降すべて明示的にsource-only/candidateとコメントされており、Reportの追跡上も本番mutationは0件で推移している）。したがって監査時点の内容は現時点でも有効と判断した。ただし**このセッション自体はライブのDB接続で再確認していない**（worktreeにSupabase project linkが無いため）。

### なぜStage B以降に進まなかったか

Stage Dの「Security principle」は次を要求する:
- ユーザーをJWT/sessionから特定する
- **workspace/brand membershipをサーバー側で厳密確認する**
- 投稿の所有/scopeを厳密確認する
- client供給のbrand authorizationを受け付けない

これらはすべて「特定のuserがどのbrandに属するか」をサーバー側で判定できることが前提になる。しかし上記Stage Aの確認どおり、**production側にその判定手段（membership）が現状存在しない**。この状態で新しい認証境界（RPCまたはEdge Function）を設計すると、次のいずれかになってしまう:

a. 別の、Phase 4候補と重複・非整合なmembership判定ロジックをこのTASKの中で独自に作る（tenant境界ロジックが2箇所に分裂し、将来Phase 4適用時に矛盾・脆弱性化するリスクが高い）。
b. Phase 4候補（`brand_memberships`、disposable DBでのpolicy matrixテストPASS済み）にそのまま依存して設計する（正しいが、**Phase 4が先に適用されている必要がある**。今回未適用のため、このTASK単独では検証可能な形で完成させられない）。

(a)はTASKの「Prefer a narrow authenticated command/read boundary」「do not weaken existing... grants」という原則そのものにも反する重複実装であり、(b)は前提が満たされていない。したがって、**Stage B（body storage設計）以降のsource変更には着手せず**、この構造的な前提不足をStage Aの結論として報告する方を選んだ。

### chosen API/security boundary

**未定（このTASKでは設計しない）**。Phase 4 membership適用後に、`brand_memberships`をSECURITY DEFINER RPCまたはRLS policyの判定源として再利用する設計が最も安全（重複実装を避けられる）と考えるが、具体化はPhase 4適用後の別TASKに委ねるべきと判断した。

### body storage design / edit authorization / failure reason sanitization

**未設計**。理由は上記のとおり。参考として、body storageを設計する際に踏まえるべき制約は確認済み:
- `scheduled_posts`に本文列が無いため、新規列追加または別テーブル参照のいずれかが必要（TASK Stage Bの要求どおり、既存の`scheduled_posts`直下に足すか別テーブルにするかはmembership確定後に判断すべき）。
- `status`が`pending/running/succeeded/failed`の4値であること、`attempt_count`があることは、編集可能状態の許可リスト（`pending`のみ等）を決める際の制約になる。
- `post_execution_logs.message`は失敗理由の格納先として実在するが、admin-only RLSのため、sanitizeされたuser向け読み取り経路は別途Phase 4適用後に設計が必要。

### changed_files

**なし**。コード変更・migration・RPC・Edge Functionはいずれも作成していない。

### migration/RPC/Edge changes

**なし**。production_mutation=0。

### tests

新規のsource変更が無いため、新規テストは追加していない。既存のsocial-mobile回帰確認のみ実施:
- `node --experimental-strip-types --test src/domain/*.test.ts`（origin/mainの最新状態）: 回帰なし（実行のみ、変更なし）。
- 新規のmigration/RPC/Edge/disposable DBテストは対象が無いため未実施。

### production_mutation

**0件**。

### G3 overlap

**0件**。ファイル変更が無いため重なりようがない。読み取りは`apps/social-mobile/docs/*`（既存ドキュメント）と`supabase/migrations/*`（既存migration）のみ。

### remaining disabled actions

Phase 2の状態から変更なし: 編集・再生成・承認・再試行はすべて無効のまま。

### exact independent review scope

**このTASKでは発生しない**（新しいDB/API境界を導入していないため）。次にPhase 3を再開する際は、TASK指定どおり独立worktreeでのOpus5.5（高）レビューを設計完了時点で必ず挟む。

### recommended next step

1. **最優先**: Phase 4候補（`supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`、`apps/social-mobile/docs/phase4-membership-rls-contract.md`）の本番適用可否をChatGPT/ユーザーで判断する。disposable DBでのproofはPASS済みだが、production適用はまだ承認・実施されていない。DB/RLS/migrationを伴うため、レビューは必須（TASKのreview policyに準じ、Codex capacity制約下ではOpus5.5（高）の別room独立レビューを推奨）。
2. Phase 4適用後に、本Phase 3（投稿本文の正本・安全な読み取り・編集・失敗理由の読み取り）を**同じ`x-social-mobile-posting-backend-foundation-phase3`系のTASKとして再開**する。その際はmembership判定をこのTASKで再設計せず、Phase 4のRLS/membership境界にそのまま乗せる設計にする。
3. **model note**: このTASKのrecommended_modelは Opus5.5（高）。本セッションはユーザーが以前 `/model claude-sonnet-5` で明示的に切り替えたSonnet 5のまま実施した（自セッションのモデルを自分で切り替える権限はない — `set_session_model`は他セッション専用）。今回はStage Aの読み取り確認と「進めない」判断のみで、新しいschema/RPC設計は行っていないため実害は無いと考えるが、**Phase 4適用後にStage B以降を実装する際は、TASK推奨どおりOpus5.5（高）での実施を強く推奨する**（ユーザーがモデルメニューから切り替える必要がある）。

## Completion

- status -> review_required
- next_owner -> chatgpt


## Closed / deferred by user — 2026-09-28

- user requested G3/G4 to be closed at a clean stopping point.
- this TASK stopped safely after Stage A and is **not a completed implementation**.
- no source/migration/RPC/Edge changes were created; production_mutation=0.
- preserved finding: posting backend Phase 3 is blocked on a trustworthy user→brand/workspace membership boundary in production.
- preserved next dependency: decide/review the existing `brand_memberships` Phase 4 candidate before resuming post-body/read/edit/failure-reason backend design.
- no independent review is required for this stopped task because no new DB/API boundary was introduced.
- resume only after ChatGPT assigns a new explicit G4 TASK or reactivates this task as `ready`.
- recommended model on resume: **Opus5.5（高）**.
