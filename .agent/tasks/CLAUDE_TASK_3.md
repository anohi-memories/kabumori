# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-preflight-20260929
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: PR #52 merge後のaccount deletion本番反映前preflight。production migration/Edge deployを行う前に、現在のlive schema/owner/ACL/isolation/Auth/Vault/Storage/FK/rollback/E2E前提をread-onlyで確認し、exact rollout planとSTOP条件を確定する。**このTASKではapply/deployしない。**

## Accepted source

- PR #52 accepted head: `4bc819555c07c8792f5b78ea29aa6b9a35694042`
- squash merge commit: `136dcd2b35b161ccc4769da15b05e796f095e881`
- H2 final verdict: PASS for source merge
- production_mutation so far: 0

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Report
   - latest H2 PASS report
2. Use a fresh independent G3 worktree/checkout from latest `origin/main`.
3. Confirm no overlap with G4 or any active slot.
4. Read current Supabase skill first.
5. Check current Supabase changelog/docs relevant to:
   - Auth hard delete/session behavior
   - Edge Function JWT verification/CORS
   - SECURITY DEFINER/function ownership
   - Vault permissions
   - managed Auth schema
   - Storage ownership/FKs if relevant
   - PostgREST transaction isolation
6. Read current X revoke and Apple revoke guidance if production assumptions depend on them.
7. Absolutely no production writes.

## Preflight scope

### A. Exact migration inventory

Identify the exact single migration to apply:
`supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`

Verify against latest main:
- file exists exactly once
- no later migration supersedes/duplicates/conflicts with it
- no broad `db push` is needed or allowed
- all referenced tables/functions/columns exist in production with compatible types/constraints
- all 11 guarded writer tables exist and names still match
- all onboarding/reconnect RPCs used by the concurrency design still match reviewed assumptions.

Produce:
- exact migration SHA/content identity
- exact apply command/method to use later
- exact read-back SQL after apply
- exact rollback/recovery plan if apply fails part-way or post-check fails.

### B. Production catalog read-only verification

Read-only confirm:
- owners of `auth.users`, `vault.secrets`, relevant schemas
- current role privileges for `postgres`, `service_role`, anon, authenticated
- existing function EXECUTE grants that may conflict
- RLS state on new/existing exposed tables assumptions
- FK graph relevant to auth/users/profile/membership/social/workspace deletion
- any NO ACTION/CASCADE behavior that changed since review
- triggers on auth.users or affected tables that would materially change finalize semantics
- whether any existing object names collide with candidate migration.

Do not read user rows, token plaintext, or Vault plaintext.

### C. Isolation / locking preflight

Read-only verify production role/function transaction isolation settings relevant to:
- authenticated/PostgREST RPCs
- service_role RPCs
- any function-level `SET default_transaction_isolation` or role setting

Confirm intended READ COMMITTED assumption is true for the target paths, or STOP.

Check there is no production-side writer path for first social workspace creation that bypasses the guarded brands/brand_memberships INSERT points. If uncertain, STOP.

### D. Auth finalization assumptions

Confirm current production behavior/metadata supports:
- direct hard-delete semantics expected by candidate
- profile/main-app protection check
- session rows disappear on hard delete
- no requirement is being assumed for instant JWT invalidation
- no managed Auth trigger/extension makes direct SQL deletion unsafe

If direct SQL auth.users deletion cannot be confidently approved from current official guidance + live metadata, STOP and propose the safer alternative boundary.

### E. Vault capability

Read-only verify:
- candidate function owner at apply time would have intended DELETE capability on Vault secrets
- service_role itself is not accidentally gaining broad direct Vault read/delete surface beyond reviewed design
- no schema/owner drift invalidates the reviewed definer model

No secret values may be queried.

### F. Storage / external dependent preflight

Confirm whether social-mobile account deletion has any Storage-owned objects/FKs in production today.
- if none, record none.
- if any exist, identify exact deletion/retention requirement and STOP if not covered.

Confirm no new tables/RPCs/Edge functions added since PR #52 create an unguarded social workspace/account writer that invalidates the concurrency design.

### G. Edge deployment preflight

For `social-mobile-account-delete`:
- confirm expected `verify_jwt` behavior/config for production
- confirm required environment/secret names exist conceptually; do not print values
- list required X/Apple config gates
- confirm CORS/platform behavior
- define exact deploy command for later
- define post-deploy byte/source identity check
- define health/smoke check that does not delete anything.

No deploy in this task.

### H. Real E2E rollout plan

Design the later disposable-account E2E in safe stages:
1. never-connected user deletion
2. social-only user with Kabumori main profile retained
3. X-connected user revoke path
4. Apple-login user on iOS native
5. lost-response/retry scenario
6. onboarding-vs-deletion race sanity in a disposable environment if practical
7. confirm no unrelated workspace/data touched

Specify what must be observed before enabling:
`EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED=true`.

### I. Legal/operator gates

Inventory only; do not invent legal text.
Confirm remaining owner decisions:
- privacy policy URL
- terms URL
- support URL/email
- retention duration for hashed deletion audit
- wording for published X posts remaining external
- Kabumori-side account-delete coordination

## STOP conditions

STOP and report without apply/deploy if any of these occur:
- production schema differs materially from reviewed assumptions
- migration conflicts with later main migrations
- role/function isolation not READ COMMITTED where required
- function owner/Vault DELETE capability cannot be proven safely
- direct auth.users deletion semantics are uncertain/unsafe
- new unguarded workspace/account writer exists
- Storage dependency exists but deletion design does not cover it
- required X/Apple production configuration is materially different
- rollback/recovery cannot be defined safely
- any slot/worktree conflict.

## Forbidden in this TASK

- no migration apply
- no `db push`
- no Edge deploy
- no Auth/provider console mutation
- no Vault mutation
- no user deletion
- no real X/Apple revoke
- no X post
- no build activation flag
- no legal-text invention

`production_mutation=0`.

## Required Report / K3

Report:
- result: READY_FOR_ROLLOUT / STOP
- fresh main commit
- migration identity
- production catalog findings
- isolation findings
- Auth finalization findings
- Vault findings
- Storage/external dependency findings
- Edge deploy prerequisites
- exact later apply/deploy/read-back plan
- rollback/recovery plan
- E2E plan
- legal/operator gates
- changed_files (should normally be TASK/report/docs only unless a source discrepancy requires STOP; do not silently patch production code)
- tests/checks
- production_mutation=0
- recommended next step

Then status -> review_required, next_owner -> chatgpt, STOP for K3.


## ChatGPT decision — sanitize preflight report

Decision: use **sanitized publication**.

Do NOT commit or push sensitive production security detail such as:
- exact secret names
- malformed secret names
- detailed privilege weaknesses or over-grant specifics
- raw role capability inventories that unnecessarily expose production posture
- any credential/token/key/value

Instead:

1. Rewrite the TASK Report as a sanitized operational summary.
2. Rewrite `apps/social-mobile/docs/account-deletion-rollout-runbook.md` so it contains:
   - exact migration file/path and safe apply ordering
   - read-back categories and expected PASS/STOP conditions
   - rollback/recovery sequence
   - Edge deploy sequence and non-destructive smoke checks
   - disposable-account E2E stages
   - operator/legal gates
   but not sensitive production security details.
3. Record the preflight result as:
   - `READY_FOR_ROLLOUT_WITH_OPERATOR_GATES`
   - production_mutation=0
4. In the sanitized report, state only that:
   - live production schema/ownership/ACL/isolation assumptions required by the reviewed design were checked read-only and did not hit a STOP condition;
   - unrelated pre-existing security/configuration findings were observed and intentionally excluded from the public repo;
   - those findings require separate private operational follow-up before/alongside rollout as appropriate.
5. Do not alter production.
6. Push only the sanitized TASK/report/runbook.
7. Then set:
   - status: review_required
   - next_owner: chatgpt
   - STOP for K3.

Recommended model: **Opus5.5（高）**.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- **result: READY_FOR_ROLLOUT**（条件付き。手順書の gate を順に通すこと）。STOP 条件には該当しなかった。
- fresh main commit: 開始時 `4c7176c`。PR #52 の squash は `136dcd2`。
- production_mutation=0:
  - 本番に対しては、カタログの読み取りと集計値だけを見た。ユーザーの行、トークン、Vault の平文、secret の値は読んでいない。
  - apply / db push / deploy / Auth・コンソールの変更 / Vault の変更 / 削除 / 失効 / 投稿 / フラグの有効化は、いずれもなし。
- **機密情報の扱い**: 権限の詳細、設定の名前、範囲外のセキュリティ所見は、リポジトリには記録せず、ユーザー（オペレーター）に直接伝えた（ユーザーの指示による）。
- 手順書: `apps/social-mobile/docs/account-deletion-rollout-runbook.md`（新規）。適用・読み戻し・ロールバック・デプロイ・E2E・gate をまとめた。

### migration identity
- 対象は `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql` の1ファイルだけ。
  - sha256: `7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657`（受け入れ済みの head `4bc8195` と一致）。
- 本番では未適用で、同名オブジェクトとの衝突も無い。
- 後続の migration は、参照先のオブジェクトに触れていない。
- `db push` は不要で、禁止のまま。

### production catalog / isolation / Auth / Vault / Storage findings（要約）
- **権限**: migration を実行するロール（＝関数の owner）は、設計に必要な権限を持つ（11テーブルへの trigger 作成、Auth ユーザー行と Vault secret 行の DELETE）。
- **テーブル**: 監視対象の11テーブルは、存在・RLS・列の型がすべて想定どおり。
- **既存トリガー**: guard と両立することを確認した。Auth ユーザー表と Vault secret 表には、独自のトリガーが無い。
- **外部キー**: レビュー時から変わっていない。Auth ユーザーを削除すると、認証まわりの全行（セッションと refresh token を含む）が CASCADE で消える。
- **ワークスペースを作る経路**: 本番でも `begin_social_mobile_x_oauth_connection` だけ。オンボーディング RPC は repo と一致した。
- **分離レベル**: どこにも上書きが無く、すべての対象経路が READ COMMITTED（PostgREST の既定）で動く。ロック待ちには上限があり、時間切れはエラー（安全側）になる。
- **Auth の削除**: SQL での hard delete は、カタログ上、想定どおりの CASCADE になる。独自トリガーは無く、Storage の所有も無い。本体アプリのデータ（profiles）の保護は、ロックを取った状態で再確認する。JWT の即時無効化は前提にしていない。
- **Storage**: social-mobile の依存は無い。
- **Edge**: 未デプロイで、名前は空いている。必要な Supabase と X の設定はある（名前だけ確認、値は見ていない）。Apple の失効は未設定なので、Apple でログインしているユーザーは最初から拒否する（設計どおり）。

### exact later plan / rollback / E2E（詳細は手順書 §2–7）
- 流れ: 適用直前の再確認 → sha256 を確認したファイルを1トランザクションで適用（`supabase db query --linked --file`） → 読み戻し → Edge のデプロイ（`verify_jwt` は有効のまま） → download と diff で同一性確認 → 削除を伴わない動作確認。
- 読み戻し SQL と rollback SQL は、使い捨て PG17 で実行して期待どおりだった（21関数の md5 一致、11 trigger が有効、rollback 後は監査テーブルだけ残る）。
- ロールバック: 削除の途中でない場合だけ、DROP する SQL を用意した。削除の途中なら、先に operator が解消する。Edge は削除するか、フラグを未設定のままにする。
- E2E は使い捨てアカウントだけで、7段階の手順を用意した。フラグを有効にするのは 1〜3・5・7 が通った後。Apple には、さらに 4 が必要。

### legal/operator gates
- 未決: social-mobile のプライバシーポリシー / 規約 / 問い合わせ先、監査の保持期間、履歴を保持しない方針の確定、「X に公開済みの投稿は残る」という文言の確認。
- 調整: Kabumori の `account-delete`（稼働中）と共有ログインの扱い。G1/G2 で対応が必要。
- 範囲外の所見（リポジトリには記録していない、ユーザーに直接伝達済み）: プロジェクト全体の権限 hardening、設定の整理を推奨する。

### changed_files
- `.agent/tasks/CLAUDE_TASK_3.md`
- `apps/social-mobile/docs/account-deletion-rollout-runbook.md`（新規）
- ソースと migration は変更していない。

### tests/checks
- 本番のカタログ読み取り（3系統）。
- 使い捨て PG17 で、関数 md5 の算出、読み戻し SQL と rollback SQL の実行。
- 公式ドキュメントの確認（PostgREST の分離レベル、Edge の JWT 検証、Vault、ユーザー削除）。
- `git diff --check` OK。

### recommended next step
- 別途承認を得たうえで、手順書どおりに適用 → 読み戻し → デプロイ → 使い捨てアカウントでの E2E を進める。
- Kabumori との調整と、権限の hardening は別 TASK にすることを推奨する。
- STOP for K3。
