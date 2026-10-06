# C1 CORRECTIVE — PR #95 security/session enrollment hardening

This is the newest canonical instruction for G5 and supersedes the prior PASS_CANDIDATE disposition.

- task_id remains: `common-account-v1-phase2-service-enrollment-integration-20261006`
- status: in_progress
- next_owner: claude
- target PR: **#95**, update the existing PR; do not open a replacement PR unless technically unavoidable and reported first.
- previous reviewed head: `c06fac6492708331b6ba816122c9852cdcea73e7`
- current main now includes PR #94 merge `d30a518731e976ab1c0e4e19e26f461a174a3c1c`.
- recommended model: **Opus5.5（極高）**.
- production mutation / deploy / EAS / enforcement: **0**.

## Mandatory fresh integration first

Before editing:
1. fresh-fetch `origin/main`;
2. rebase/fresh-integrate PR #95 work onto current main;
3. preserve PR #94's root `news-detail` registration and all topic/news navigation behavior;
4. re-check G1/G2/G3/G4/H1/H2/G5 ownership and open-PR overlaps;
5. use the existing isolated G5 worktree only if still clean and safe; otherwise create a fresh independent G5 worktree from `/Users/yuya/Developer/kabumori-fresh`;
6. do not touch another slot's branch/server/uncommitted files.

## C1 accepted H1 findings — all must close

### R1 P1 — automatic bootstrap must never reactivate ended

Current defect:
- client read says active/missing;
- lifecycle state can become `ended`;
- stale automatic `start_*_service()` then reactivates ended inside the server transaction.

Required correction:
- close this **at the server lifecycle transaction boundary**, not with another client SELECT.
- automatic/bootstrap service-start semantics must be fail-closed for an entitlement that is currently `ended`.
- explicit reactivation must be distinguishable from automatic bootstrap and tied to a current authenticated user action.

Preferred minimal contract:
- add a **new forward migration**; never edit the already-applied Phase 1 migration.
- keep/create an automatic start/ensure RPC for each service that:
  - creates missing entitlement;
  - returns active idempotently;
  - **does not reactivate ended**;
  - fails closed for deleting/suspended/provisioning/locked/other blocked states.
- add a separate explicit reactivation RPC for each service, callable only from the authenticated re-enrollment action, that atomically locks and reactivates **only a currently ended entitlement**.
- exact names/signatures are implementation choices; preserve authenticated-only EXECUTE, auth.uid identity, SECURITY DEFINER safety, empty/fixed search_path and existing lock ordering.
- old binaries calling the existing automatic RPC should become safer/fail-closed on ended, not silently reactive.
- no production apply in this task.

If a different design is safer/smaller, document it and prove the same invariants.

### R2 P1 — explicit re-enrollment intent must be one-use and user/session scoped

For both apps where applicable, especially X:
- a re-enrollment click must create a one-use intent pinned to the exact initiating `userId` and current session/generation;
- consume/clear intent once the explicit reactivation request starts;
- invalidate it on user change, sign-out, recovery transition, cancellation/unmount and new session generation;
- user A's click must never trigger a reactivation request for user B.

Add the exact A-click -> B-switch regression H1 reproduced.

### R3 P2 — side effects require positive enrollment-ready state

Kabumori:
- do not pass a session to push-registration or notification-navigation hooks merely because there is currently no error.
- while service initialization/retry is loading or unresolved, these hooks must receive null/no service session.
- create/use an explicit **ready for this exact user/session generation** state.
- rejected -> retry pending -> rejected must perform zero push-token registration and zero pending-notification navigation.
- preserve password-recovery ordering and logout availability.

### R4 P1 — enrollment request transport must be bound to immutable session credentials

Do not allow a stale A operation to issue a mutation with singleton Supabase client's later B token.

Preferred correction:
- remove the client read -> later mutation chain where possible; let the atomic server RPC decide lifecycle state.
- capture immutable session context at request initiation: at minimum `user.id`, session/access-token identity and a local generation/request id.
- use a request transport whose Authorization is bound to that captured token for the enrollment/reactivation call, rather than asking a mutable singleton client for whatever token is current at dispatch time.
- invalidate/abort stale pre-dispatch work on sign-out/user switch.
- stale completions must never open the app for another user.
- never log/persist the access token.

A dedicated short-lived Supabase/fetch transport bound to the captured JWT is acceptable if implemented safely with the existing public URL/anon configuration and no new secret.

Add adversarial tests:
- delayed A preparation/read -> switch to B -> release A => no request using B credential;
- sign-out during pending run;
- A explicit reactivation intent -> B switch;
- repeated auth events/same user remain idempotent.

### R5 P2 — validate full RPC response fail-closed

For both app implementations:
- validate the exact canonical response shape.
- `status`, exact `service`, and `started` boolean are mandatory where defined by the server contract.
- validate every other required field in the exact current/new RPC contract.
- missing/null/string/number `started`, wrong service, unknown status, malformed object => **not ready / fail closed**.
- no coercion of malformed fields into a valid default.

## Server/client contract tests — mandatory

Use a disposable PostgreSQL fixture and focused client tests to prove:

Automatic:
- missing -> creates only requested service;
- active -> idempotent;
- ended -> remains ended / no reactivation;
- deleting/suspended/provisioning/locked/unknown -> fail closed.

Explicit reactivation:
- current ended + explicit current-user action -> active;
- no explicit action -> no reactivation;
- active/non-ended unexpected state -> deterministic safe response, no unintended mutation;
- same action cannot be reused across user/session switch.

Concurrency:
- end/withdraw racing automatic bootstrap cannot end as active because of stale automatic start;
- user A -> user B switch cannot make stale A work mutate B;
- same-user repeated events remain one logical initialization.

Kabumori:
- push and notification side effects only after positive ready for exact current session;
- pending/rejected states have zero side effects.

X:
- login/service enrollment still creates no X OAuth credential/workspace/posting authorization/publish-enable side effect;
- existing explicit X OAuth flow remains separate.

Malformed responses:
- both clients fail closed on every incomplete/wrong active response shape.

## PR #94 integration regression

Because PR #94 is now on main:
- current main must retain `<Stack.Screen name="news-detail" />` in Kabumori root SignedInNavigator.
- merge/rebase PR #95 changes without dropping that route.
- rerun the Kabumori navigation/root-navigator tests and the common-account AuthGate tests together.
- manually inspect the final `src/app/_layout.tsx` so it contains both:
  - PR #94 root-detail registration;
  - corrected PR #95 service-access/AuthGate logic.

## Scope / migration safety

Allowed:
- source changes required for R1-R5;
- one **new forward migration candidate** for the corrected lifecycle RPC contract;
- client/domain/tests/runbook updates required by that candidate.

Forbidden:
- editing the already-applied historical migration in place;
- applying the new migration to production;
- enabling RLS/service-role enforcement;
- Phase 3 deletion-orchestrator implementation;
- production DB/Auth/Storage/OAuth/Vault mutation;
- EAS/TestFlight;
- real X;
- unrelated G1-G4 work.

## Completion / K5

Update existing PR #95 to a new exact head.

Report:
- fresh main + PR94 merge ancestry;
- migration/RPC contract delta;
- exact automatic vs explicit-reactivation semantics;
- session-bound transport design;
- one-use user-scoped reactivation intent;
- Kabumori positive-ready side-effect gate;
- strict response validation;
- all adversarial reproductions from H1 now passing;
- combined Kabumori + X tests;
- disposable PostgreSQL proof;
- final `src/app/_layout.tsx` proof preserving `news-detail`;
- changed files;
- production mutation/deploy/EAS = 0;
- remaining issues.

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K5.

A **new focused H1 re-review is mandatory** on the corrected exact head before merge.
Recommended reviewer: **Sol（高）**.

---

# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase2-service-enrollment-integration-20261006
- owner: claude
- slot: claude-5
- status: ready
- next_owner: claude
- priority: critical
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: shared-account Phase 2 integration / service enrollment / auth-session wiring / source-only first
- production_mutation_allowed: false
- deploy_allowed: false
- enforcement_allowed: false
- deletion_orchestrator_allowed: false

## Priority

Common account remains the project-wide critical path by explicit user decision.

This task begins Phase 2 now that:
- Phase 1 foundation is production PASS;
- legacy production backfill is production PASS;
- current common_accounts = 5;
- current service_entitlements = 3:
  - Kabumori 2
  - X autopost 1
- Auth-only accounts = 2;
- lifecycle operations = 0;
- guard mode remains shadow;
- integration_state remains not_started.

Existing G1-G4 tasks must be preserved. Do not overwrite their branches or files. Source-only work may proceed in parallel only where target files are disjoint.

## Goal

Wire both applications to the common-account service-enrollment contract so that future users and existing common-account users no longer depend on legacy footprint inference.

Required product behavior:

1. Kabumori signup / first accepted session:
   - same Supabase Auth identity remains the canonical person;
   - create/ensure common account through the reviewed lifecycle RPC boundary;
   - create/ensure active `kabumori` entitlement;
   - create/ensure Kabumori profile as part of the service-start contract;
   - idempotent on repeated cold start / auth-state change / sign-in;
   - never create duplicate rows;
   - never infer by email or merge accounts.

2. X autopost signup / first accepted session:
   - same Supabase Auth identity remains canonical;
   - create/ensure common account through lifecycle RPC boundary;
   - create/ensure active `x_autopost` entitlement;
   - do NOT create workspace/social account merely because login occurred unless current product contract explicitly requires it;
   - posting OAuth remains separate from login identity and service entitlement.

3. Existing common-account login in another app:
   - if entitlement for that service is missing, app can enroll only that service;
   - preserve the user's shared login;
   - no account merge flow in V1;
   - ended/deleting/suspended states fail closed according to accepted lifecycle semantics; no silent reactivation.

4. Existing service user:
   - repeated service-start path is idempotent;
   - no unintended profile/workspace/OAuth mutation.

## Canonical RPC boundary

Use only the already-reviewed public service-start RPCs:
- `public.start_kabumori_service()`
- `public.start_x_autopost_service()`

Do not duplicate lifecycle SQL in clients or Edge Functions.
Do not directly INSERT/UPDATE common_accounts or service_entitlements from app clients.

Before implementation, re-read exact function definitions and return contracts from current main/production-reviewed migration.

## Mandatory startup / isolation

1. Read:
   - PROJECT_RULES.md
   - .agent/ORCHESTRATION.md
   - .agent/CURRENT_STATE.md
   - .agent/ACTIVE_TASK.md
   - this G5 TASK + prior G5 report
   - common-account Phase 1 migration/design docs
2. Fresh fetch `origin/main` from:
   `/Users/yuya/Developer/kabumori-fresh`
3. Create a new dedicated G5 worktree.
4. Check current G1/G2/G3/G4 worktrees/tasks and open PR changed files.
5. Prove no file overlap before editing.
6. If auth/session/onboarding files overlap another active slot/PR, STOP and report exact overlap; do not edit around it.

## Phase A — inventory the current app flows

Read-only/source inspection only.

Kabumori:
- map signup, sign-in, session restore, auth-state-change, password recovery and profile bootstrap.
- identify every call to `ensure_my_profile` or direct profile bootstrap.
- identify which calls are truly required after service start and which can be replaced by/ordered behind `start_kabumori_service()`.

X autopost:
- map email/Google/Apple/X login flow.
- map post-auth session bootstrap.
- map first X posting-authorization/onboarding flow.
- identify where service enrollment should happen without conflating it with X OAuth/workspace creation.

Shared:
- identify app behavior for an Auth user whose common account exists but entitlement is absent/ended/deleting/suspended.
- identify existing error handling/offline/retry behavior.

Document exact touched-file plan before edits.

## Phase B — implement service-start integration

### Kabumori

Implement a single idempotent service-start path used by all accepted signed-in sessions.

Requirements:
- call `start_kabumori_service()` with the user JWT;
- only after successful service start treat Kabumori session bootstrap as service-ready;
- preserve current profile-dependent flows;
- do not separately create profile in a way that races lifecycle RPC;
- recovery/login restore must converge on same path;
- transient network failure must not corrupt auth; surface retryable service-initialization state;
- lifecycle refusal (deleting/locked/ended semantics as returned) must fail closed and not silently bypass to legacy profile-only operation.

### X autopost

Implement a single idempotent service-start path after authenticated session acceptance.

Requirements:
- call `start_x_autopost_service()` with user JWT;
- service enrollment must be independent of posting OAuth;
- login alone must not set publish_enabled, create posting credentials, touch Vault, call X API or start posting;
- if workspace creation currently happens only when user chooses “Xを連携”, preserve that separation;
- repeated auth restore/sign-in is safe and idempotent;
- lifecycle refusal fails closed with a user-actionable state.

### Shared UX behavior

Use concise non-enumerating pre-auth copy.
Post-auth, it is acceptable to explain:
- “共通IDはお持ちです。このサービスの利用登録を行います”
only when supported by authenticated state.

Do not add account merge UI.

## Phase C — tests

Add/adjust focused tests proving at minimum:

Kabumori:
- new Auth user -> common service start -> profile/service ready;
- existing common account, missing Kabumori entitlement -> Kabumori entitlement only;
- already active entitlement -> idempotent;
- repeated auth-state events -> one logical initialization;
- lifecycle blocked state -> no legacy bypass;
- retryable network error -> no duplicate/corrupt state.

X:
- new Auth user -> X service entitlement active;
- existing common account missing X entitlement -> X only;
- active X entitlement -> idempotent;
- login does not create posting authorization/credentials/publish enablement;
- lifecycle blocked state -> no OAuth/workspace shortcut;
- repeated session restore safe.

Cross-app:
- one Auth identity can hold both entitlements;
- adding second service does not mutate first service's data;
- no email-based merge path;
- no direct client writes to common tables.

Run relevant app/unit/typecheck/lint/diff tests.

## Phase D — production-readiness package, no production mutation

Do NOT deploy in this first pass.

Prepare exact rollout plan:
- target native/app source changes;
- any Edge Function changes if genuinely required (prefer none if client RPC is sufficient);
- required environment/config changes, ideally none;
- backward compatibility while old app binaries still exist;
- rollback behavior;
- how to observe new enrollment without PII;
- how to avoid breaking existing users during staged app rollout.

Important:
old binaries still using legacy behavior may remain installed. Do not enable enforcement in this task.

## Explicitly out of scope

Do NOT:
- change existing RLS policies to require entitlement yet;
- change service_role producer filters yet;
- enable delete guard enforcement;
- replace account-delete/social-mobile-account-delete yet;
- implement common-account hard-delete orchestrator;
- revoke sessions;
- revoke Apple/X providers;
- mutate Storage/Vault;
- change X publish authorization;
- merge accounts by email;
- deploy production;
- run EAS/TestFlight;
- perform real X or paid-model calls for this task.

These come after source integration is reviewed and compatible.

## Review gate

Because this task crosses:
- Auth/session bootstrap
- both apps
- common-account lifecycle RPCs

K5 should normally allocate a focused Codex review unless the actual diff turns out materially smaller than expected.

Likely recommended Codex model if review is needed:
**Sol（高）**.

## Completion / K5

Report:
- task_id
- result: PASS_CANDIDATE / BLOCKED / PARTIAL
- fresh main
- isolated worktree
- exact touched files
- current-flow inventory
- implemented Kabumori behavior
- implemented X behavior
- tests
- backward compatibility
- rollout plan
- production mutation = 0
- deploy = 0
- remaining issues
- safety checks
- next recommendation

At completion:
- status -> review_required
- next_owner -> chatgpt
- STOP for K5.

Recommended model: **Opus5.5（極高）**.

## Report

- task_id: common-account-v1-phase2-service-enrollment-integration-20261006
- result: **PASS_CANDIDATE**（source のみ。本番の変更 0、deploy 0、EAS 0）。
- PR：[#95](https://github.com/anohi-memories/kabumori/pull/95)、head `c06fac64`（未 merge、merge は HOLD）。
- fresh main：開始時 `59ca05c3`。着手マーカー `0597a632`。Report の基点は `6cfd6528`。
- isolated worktree：`/Users/yuya/Developer/kabumori-g5-phase2`（branch `claude/g5-phase2-enrollment-20261006`、`kabumori-fresh` の fresh main から作成）。

### 他スロットとの重なり（すべて報告）

- 開始時：open PR（#94 G1、#78 G3、#41、#33 admin）と、全 worktree の未 commit の変更を確認した。認証 / セッション / 登録まわりのファイルとの重なりは 0。
  - 旧 Mac の共有 checkout `/Users/yuya/Developer/kabumori`（9/12 時点の main、9/8 の未 commit の変更）にだけ `src/app/_layout.tsx` の変更があった。どのスロットも使っていないので、対象外とした。
- **作業中に発生した重なり**：G1 の PR #94 が addendum 2（head `64c71bd6`、ニュース詳細をルートの Stack に移動）で `src/app/_layout.tsx` を変更した。
  - 内容は `SignedInNavigator` に `<Stack.Screen name="news-detail" />` を 1 行足すだけ。G5 の変更（`AuthGate` のフックと分岐）とは別の hunk。
  - 実際の差分を確認し、ローカルで試しに merge した：`git merge-tree` で衝突 0。merge 後の tree で Kabumori のテスト 392 / 392 PASS（#94 の分を含む）。試しの merge は push しておらず、削除済み。
  - G5 は #94 の範囲を回避するための編集をしていない。どちらを先に merge しても、もう一方は機械的に rebase できる。merge の順番は K5 で判断してほしい。

### 現在の flow の棚卸し（Phase A、source の読み取りのみ）

**Kabumori（`src/`）**
- ログインはメール / パスワードだけ（`src/lib/auth.ts`）。
- セッションは `AuthProvider`（`src/providers/auth-provider.tsx`）が持つ。起動時の `getSession` と、唯一の `onAuthStateChange` 購読の両方が `acceptSession` → `prepareSession` に入る。
- 変更前は、`prepareSession` が `ensure_my_profile()` を、セッションを受け入れるたび（sign-in / sign-up の中でも）に呼んでいた。これが profile を直接作る唯一の場所。
- 画面の振り分けは `src/app/_layout.tsx` の `AuthGate` が条件付きの render で行う（recovery → loading → onboarding → profileError → app → login）。
- push の登録は、profile の失敗中にも走っていた。
- 退会は `account-delete` Edge（今回は変更していない）。

**X（`apps/social-mobile/`）**
- ログイン方法：email / Google / Apple / X。PKCE を使い、provider token は保存しない。
- セッション：`AuthProvider` 内の `onAuthStateChange`。RPC は 1 つも呼ばない。
- ログイン後に読むもの：`DataProvider` / `OnboardingGate` が RLS で workspace を読むだけ。
- workspace / social account / OAuth state は、「Xを接続」で `x-oauth-connect-user` → `begin_social_mobile_x_oauth_connection` を通ったときだけ作られる。ログインしただけでは何も作られない。
- 退会は `social-mobile-account-delete`（今回は変更していない）。

**共通**
- どちらのアプリも、common account / entitlement を参照していなかった。
- entitlement が無い・ended・deleting・suspended のときの挙動は、どちらのアプリにも無かった（今回追加した）。

### 実装した Kabumori の挙動

- 受け入れた全セッションで `public.start_kabumori_service()` を呼ぶ（`ensure_my_profile()` を置き換え）。サーバーの 1 transaction の中で、次の 3 つを冪等に用意する：common account、active な `kabumori` entitlement、profile。profile を別に作ることはしない。
- 結果ごとの挙動：
  - ready → app を開く。
  - 拒否（削除手続き中 / 利用停止 / 退会手続き中 / 停止 / 準備中 / ログイン無効 / 不明）→ `ServiceAccessScreen`。app は開かず、profile だけで動く fallback も無い。再試行は一時的な拒否のときだけ出し、ログアウトは常に出す。
  - ended → 「このサービスは退会済みです。共通IDはお持ちです…」と表示し、「利用登録する」を明示的に押したときだけ再開する。
  - 一時的な失敗 → 既存の profileError 画面（再試行 / ログアウト）。auth は壊さない。
- 冪等性：1 人につき 1 リクエストを共有する（sign-in の中の呼び出し、INITIAL_SESSION、各 event）。決まった結果は sign-out / 別の人 / 明示的な retry まで再利用する。一時的な失敗は記憶しない。
- push token の登録と通知の遷移は、enrollment が ready のときだけ動く。
- 別のサービスを既に使っている common account に Kabumori を追加したときだけ、「共通IDはお持ちです。このサービスの利用登録を行いました。」を 1 回表示する。

### 実装した X の挙動

- `ServiceEnrollmentGate` が auth / recovery の後、`DataProvider` / `OnboardingGate` の前で `public.start_x_autopost_service()` を呼ぶ。enrollment が済むまで workspace のデータは読まない。
- ログインしても、workspace / social account / OAuth state / credential / publish_enabled / Vault / X API / 投稿のどれにも触れない。「Xを接続」は従来どおり、別の投稿用の許可として残る。`auth-provider.tsx` は変更していない。
- 拒否 / ended / 一時的な失敗は、それぞれに合わせた画面で app を開かない。ログアウトと「アカウントの削除について」は常に押せる（App Review 5.1.1(v)）。
- mock preview では gate しない。signed-in の tree を離れると、記憶した結果を忘れる。
- 判定のロジックは Kabumori と同一（header より下が byte 一致で、テストが固定している）。

### テスト / 確認

| 対象 | 結果 |
|---|---|
| Kabumori `deno test --no-check --allow-read tests/app/` | 352 / 352 PASS（新規 17） |
| Kabumori `tsc --noEmit` | `src/` は以前からある CSS module の 2 件だけ |
| Kabumori `expo export --platform web`（ダミーの公開 env） | 成功。bundle に `start_kabumori_service` があり、`ensure_my_profile` は無い |
| X `npm test` | 157 / 157 PASS（新規 9） |
| X `tsc --noEmit` / `expo lint` / `expo export --platform web` | すべて成功 |
| ロジックを意図的に壊した版 | 8 / 8 を検出 |
| DB の挙動（既存の `common_account_lifecycle_run.sh`、20 / 20 PASS） | start は account + entitlement（Kabumori は profile も）を作る、冪等、X の start は workspace を作らない、1 ID で両方を持てる、deleting は拒否、login の無い token は拒否 |
| 試しの merge（#94 + #95） | 392 / 392 PASS |

- 壊した版 8 種：ended を黙って再開する、unknown を ready とする、別サービスの応答を受け入れる、single-flight を外す、失敗を記憶する、読み取りエラーなのに start する、無効な login を retry する、notice を毎回出す。
- Kabumori の root には ESLint の設定が無い（以前からの状態）ため、lint は実行していない。
- TASK Phase C の各項目は、上記のテストで対応している。
  - Kabumori：新規 / X だけの account に Kabumori を追加 / active で冪等 / 繰り返しの event で 1 回 / 拒否で legacy の迂回なし / 一時エラーで状態を壊さない。
  - X：新規 / Kabumori だけの account / 冪等 / 投稿の許可を作らない / 拒否で OAuth の近道なし / 繰り返しの restore。
  - cross-app：1 ID で 2 つの entitlement / 2 つ目が 1 つ目を変えない / e-mail での統合なし / client からの直接書き込みなし。

### 後方互換性と rollout の計画（Phase D、未実施）

- サーバー側の変更は不要：RPC / 権限 / RLS / 列の権限は Phase 1 の適用で本番に入っている。Edge / config / secret / flag / migration も不要。
- app：両アプリの次の native build にこの source を入れる（EAS / TestFlight は別途承認）。2 つのアプリは独立していて、どちらが先でもよい。
- 古い binary：Kabumori は `ensure_my_profile()`（本番に存在）を呼び続け、X は何も呼ばない。enforcement が無いので、既存のユーザーへの影響は 0。
  - 古い binary で新しく登録した人は、新しい binary を開くまで entitlement を持たない。enforcement の前に、read-only の `check.sql` で観察し、必要なら別途承認を得て `backfill(true)` を実行する。
- rollback：以前の binary に戻す / source を revert する。その間に作られた entitlement は shadow なので無害で、サーバー側に戻すものは無い。
- PII を出さない観察：`check.sql` の `entitlements_by_kind` の `self_service` 行の増え方と、dry-run の `*_to_create`。
- 詳しくは `docs/common-account/phase2-service-enrollment.md`。

### changed_files（PR #95、11 ファイル、+1104 / −19）

- Kabumori：`src/lib/service-enrollment.ts`（新規）、`src/lib/auth.ts`、`src/providers/auth-provider.tsx`、`src/app/_layout.tsx`、`src/components/service-access-screen.tsx`（新規）、`tests/app/service-enrollment_test.ts`（新規）
- X：`apps/social-mobile/src/domain/service-enrollment.ts`（新規）、`apps/social-mobile/src/features/service-enrollment/service-enrollment-gate.tsx`（新規）、`apps/social-mobile/src/app/_layout.tsx`、`apps/social-mobile/tests/service-enrollment.test.mjs`（新規）
- docs：`docs/common-account/phase2-service-enrollment.md`（新規）
- この Report：`.agent/tasks/CLAUDE_TASK_5.md` のみ。

### その他

- commit / push：`c06fac64` を branch に push し、PR #95 を open。着手マーカーとこの Report は main に push。
- production mutation：**0**。deploy：**0**。EAS：0。本番への接続：0。実 X / 有料モデル：0。
- remaining_issues：
  - G1 の PR #94 とは同じファイルで hunk が別（上記）。merge の順番を決めてほしい。
  - `ended` の確認と start は 2 回の呼び出しで、その間に終了された場合は start が再開してしまう。今は ended を作る経路が無い（Phase 3）ので、実害は無い。docs に明記した。
  - Kabumori は、auth event のたびに読み込み画面が一瞬出る（以前からの挙動）。enrollment の結果は記憶するので、2 回目以降の往復は増えない。
  - 実機（Simulator / iPhone）での確認はまだ。native build は承認が必要な別工程。
  - その後：古い binary で登録した人の扱い（check → 必要なら backfill）、Phase 3（削除経路 / enforcement / orchestrator）。
- safety_checks：
  - RLS / producer / 削除経路 / Auth / Storage / Vault / X の publish 権限 / Cron / Edge は変更していない。e-mail での統合も無い。
  - client から common テーブルへの直接書き込みは無い（テストで固定）。
  - 他スロットのファイルは編集していない。秘密情報 / PII は diff に無い。
  - 公開 env はダミー値だけを使い、本物の `.env` には触れていない。
- next_recommendation：
  - K5 の後、TASK の Review gate に従って focused Codex review（Sol 高）を推奨する。
  - 重点：
    - ended を勝手に再開しないこと
    - 拒否時に fail closed であること（Kabumori に profile だけの迂回が無い、X が OAuth / workspace に触れない）
    - single-flight / reset の正しさ（sign-out → 別 user）
    - X の gate が mock と削除の導線を保っていること
    - #94 との merge の順番

---

# Previous G5 task history — preserved

# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase1-production-backfill-gate-20261006
- owner: claude
- slot: claude-5
- status: review_required
- next_owner: chatgpt
- production_mutation_window: **CLOSED** — 2026-10-06 17:52 JST. G5 ran exactly the frozen private.account_lifecycle_backfill(true) transaction once (COMMITTED 16:55 JST; 5 common accounts, 3 legacy entitlements, 0 operations) and finished the read-only postflight; G5 performs no further production write.
- priority: critical
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: production legacy backfill dry-run / parity gate / explicit apply gate
- production_project_ref: wsmznyzcvmuitkglfeuj
- production_mutation_allowed: false_until_explicit_approval
- backfill_apply_allowed: false_until_explicit_approval
- integration_allowed: false
- enforcement_allowed: false
- auth_delete_allowed: false

## Priority

The user has made the common-account system the project-wide critical path.

Until this common-account sequence reaches a safe integration checkpoint:
- G5 common-account work has priority over unrelated app production mutation.
- G1/G2/G3/G4 existing tasks must be preserved, not overwritten.
- Read-only observation and source-only/UI work may continue if non-conflicting.
- No other slot may open a production DB/Auth/permission mutation window while G5 has an active production mutation window.
- In particular, G3 PR81 production apply must remain HOLD while a G5 production write is authorized/active.

## Current accepted baseline

Common-account Phase 1 foundation is already installed in production and Final K5 PASS:
- migration: `20261001150000_common_account_lifecycle_foundation.sql`
- SHA256: `e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3`
- schema/history: EXACT / EXACT
- RLS/ACL/functions/triggers/indexes/policies: exact reviewed contract
- existing-object fingerprint unchanged by foundation apply
- common_accounts: 0
- service_entitlements: 0
- lifecycle operations: 0
- backfill: 0
- guard mode: shadow
- integration_state: not_started
- enforcement: not enabled
- PR #91 rollout/preflight tooling merged to main as `50e08e1daa0b1e91f9f170a5baaf175ebcd315cd`

Phase 0/previous dry-run history suggested a very small legacy population, but **do not hard-code old counts**. Re-read current production.

## Canonical backfill semantics

The already-reviewed production function is:
`private.account_lifecycle_backfill(boolean)`

Important source contract:
- `false` = aggregate/count-only dry-run. No account or entitlement writes.
- `true` = iterates current `auth.users` in UUID order, takes lifecycle locks, re-reads each user's plan after lock, creates only missing rows, is idempotent, and never changes an existing entitlement.
- one `common_accounts` row per current Auth login.
- Kabumori candidate = existing `profiles` row; legacy evidence distinguishes:
  - `kabumori_activity`
  - `kabumori_profile_only`
- X candidate = sole owner of the person's own `social_mobile_user_v1` self-service workspace; admin users are excluded from X consumer entitlement.
- X legacy evidence distinguishes:
  - `x_identity_verified`
  - `x_workspace_pending`
- email is never used to merge people.
- Auth-only logins receive a common account but no service entitlement.
- account status not active => new entitlement is skipped.
- existing entitlement is never rewritten by backfill.

## Mandatory startup / isolation

1. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - `.agent/ACTIVE_TASK.md`
   - this G5 TASK + previous G5 reports
   - merged migration source
   - PR #91 rollout/runbook
2. Use fresh base:
   `/Users/yuya/Developer/kabumori-fresh`
3. Fetch fresh `origin/main`.
4. Create a new G5-dedicated isolated worktree/checkout from fresh main.
5. Confirm no shared worktree with G1-G4/H1/H2.
6. Confirm production project exactly `wsmznyzcvmuitkglfeuj`.
7. Read current Supabase docs/changelog relevant to:
   - transaction/read-only semantics
   - row locks
   - SECURITY DEFINER / grants
   - Auth user lifecycle
8. Fresh-read other slot states and production mutation windows.

If isolation or ownership is ambiguous => STOP.

## Phase A — production read-only foundation check

Before any backfill dry-run:

- verify Phase 1 target migration history is exact one row;
- verify common-account foundation schema/status is still EXACT;
- verify settings remain `shadow / not_started`;
- verify no unexpected lifecycle operation is in progress;
- read aggregate counts only for:
  - auth.users
  - common_accounts
  - service_entitlements by service/status/source/evidence
  - lifecycle operations by type/status
- expected at this stage is still zero population unless another authorized task legitimately changed it.
- if any pre-existing common-account/entitlement population is unexpected, STOP and classify. Do not overwrite/rebuild.

Do not output raw UUID, email, provider subject, X handle, token, secret or user content.

## Phase B — authoritative dry-run

Run the already-reviewed function with `p_apply=false` under a transaction that is explicitly READ ONLY.

The dry-run result must record these aggregate fields:
- auth_users
- common_accounts_to_create
- kabumori_candidates
- kabumori_with_activity
- kabumori_profile_only
- kabumori_to_create
- x_autopost_candidates
- x_autopost_identity_verified
- x_autopost_workspace_pending
- x_autopost_to_create
- x_autopost_excluded_admin
- auth_only
- not_active_accounts_with_candidates
- admin_users
- excluded_non_self_service_memberships
- applied
- created_common_accounts
- created_kabumori
- created_x_autopost
- skipped_account_not_active

Required invariants for dry-run:
- `applied=false`
- all created_* = 0
- production row counts unchanged before/after
- no lifecycle operation created
- no migration history change
- no Auth/Storage/Vault/OAuth mutation

## Phase C — parity / classification verification

Independently verify the plan semantics with production reads, using only aggregate or non-identifying output.

At minimum prove:
- every current Auth login appears exactly once in the backfill plan;
- `common_accounts_to_create` matches missing current Auth logins;
- Kabumori candidate total splits exactly into activity + profile-only;
- Kabumori to-create excludes only already-existing entitlement or non-active account;
- X candidate is limited to self-service sole-owner workspace;
- admin-owned/operator/internal workspaces do not become X consumer entitlements;
- X verified + pending split equals X candidate count;
- Auth-only count reconciles with total population;
- ambiguous/shared/internal/foreign workspace footprints are excluded, not silently classified;
- no email-based merge exists;
- current raw candidate population materially matches the known Phase 0 story, or every difference is explained by a legitimate subsequent user/state change.

If an individual row must be inspected to explain an anomaly:
- keep PII local/operator-only;
- Report only non-identifying classification and counts.

Unknown/ambiguous classification => STOP / BLOCKED.
Do not apply.

## Phase D — local/disposable proof refresh

Re-run the relevant existing lifecycle/backfill tests from fresh main.

At minimum:
- lifecycle suite
- migration/source invariants
- backfill false branch leaves rows unchanged
- backfill true creates expected rows on fixture
- second apply is idempotent
- admin X exclusion
- profile-only Kabumori evidence
- activity Kabumori evidence
- X verified/pending evidence
- non-active account skip
- no existing entitlement rewrite
- no email merge

Do not modify the accepted migration in this task.

If a test defect is found in test tooling only, report and STOP before production apply package unless the correction is clearly isolated and reviewed.

## Phase E — freeze exact production apply package

If Phase A-D are PASS, prepare—not execute—the exact production write package.

The package must:
1. fresh-check all slot states and production mutex;
2. rerun the read-only dry-run immediately before write;
3. confirm no material count/classification change;
4. use the existing reviewed `private.account_lifecycle_backfill(true)` only;
5. execute in one operator-controlled transaction with stop-on-error;
6. set a bounded lock timeout so a busy Auth user causes safe STOP rather than long blocking;
7. never use `db push`, migration repair, ad-hoc inserts, updates, deletes, or manual entitlement rows;
8. never modify Auth, Storage, OAuth, Vault, providers, Cron, Edge Functions or existing service rows.

Document exact failure behavior:
- lock timeout/error => transaction rollback, STOP;
- response lost => do not blindly rerun; first read counts/plan and classify;
- unexpected row/count => STOP;
- partial state must not be manually repaired in this TASK.

## Mandatory STOP before production backfill(true)

After A-D PASS and E is frozen:

- append the approval package to Report;
- status -> `review_required`;
- next_owner -> `chatgpt`;
- result -> `BACKFILL_READY`;
- production writes -> 0;
- STOP for K5.

**Do not run backfill(true) without explicit user/ChatGPT production approval.**

The user's project-wide prioritization instruction is NOT itself approval for the production backfill write.

## After explicit backfill approval only

Resume the same G5 task.

Immediately:
1. fresh-fetch origin/main;
2. re-read ACTIVE_TASK/CURRENT_STATE;
3. assert no other production mutation window is active;
4. rerun Phase A/B enough to prove the package is not stale;
5. verify exact function definition/owner/ACL is unchanged;
6. open G5 production_mutation_window;
7. run only the frozen backfill(true) transaction.

Then separate read-only postflight must verify:
- common_accounts count = current Auth user count, except any login legitimately disappeared during safe rollback/retry classification;
- no duplicate common account;
- entitlement totals exactly match approved candidate counts;
- every backfilled entitlement source = `legacy_backfill`;
- legacy_evidence distribution matches approved dry-run;
- status = active for created entitlements;
- Auth-only users have common account and no entitlement;
- X excluded-admin count created 0 X entitlements;
- no unknown service_key/source/evidence/status;
- no lifecycle operation was created;
- no existing service row changed;
- no Auth/Storage/OAuth/Vault/Edge/Cron mutation;
- rerun `backfill(false)`: all to-create counts are 0 for active candidates;
- production_mutation_window -> CLOSED.

If exact postflight PASS:
- result -> `BACKFILL_APPLIED_PASS`
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K5.

## Explicitly out of scope

This task MUST NOT:
- wire Kabumori signup/login/session to entitlement;
- wire X signup/login/session to entitlement;
- change existing RLS policies to enforce entitlement;
- change producers/service_role gates;
- change account-delete or social-mobile-account-delete;
- build common account manager UI;
- enable enforcing delete guard;
- create deletion orchestrator;
- hard-delete Auth users;
- revoke sessions/providers;
- mutate Storage/Vault;
- deploy Edge Functions;
- change Cron;
- run real X.

Those are the next Phase 2/3 tasks after backfill is exact.

## Completion / K5 Report

Report:
- task_id
- result: BACKFILL_READY / BACKFILL_APPLIED_PASS / BLOCKED / PARTIAL
- fresh main
- isolated worktree
- production project
- foundation exactness
- dry-run aggregate
- parity/classification result
- Phase 0 comparison
- tests
- production mutex
- exact apply package
- production writes actually performed
- postflight if applied
- changed_files
- commit/push
- deploy
- backfill
- remaining_issues
- safety_checks
- next_recommendation

Never report apply as successful unless exact read-back proves it.

Recommended model: **Opus5.5（極高）**.

## Report

- task_id: common-account-v1-phase1-production-backfill-gate-20261006
- result: **BACKFILL_APPLIED_PASS**（2026-10-06 16:55 JST に COMMITTED。read-only の postflight はすべて承認値と一致した）。
- production writes actually performed（ユーザーの明示承認の範囲内）：
  - 凍結済みの `apply.sql` を 1 回だけ実行した。1 transaction の中で `private.account_lifecycle_backfill(true)` を 1 回呼んだだけ。
  - その結果：`common_accounts` 5 行、`service_entitlements` 3 行（いずれも insert）。lifecycle の version は trigger で更新された。
  - それ以外の本番書き込みは 0：client の配線 / RLS の enforce / 削除 orchestrator / Auth / Storage / OAuth / Vault / Edge deploy / Cron / 実 X / 既存サービス行の変更はすべて 0。再実行・修復・rollback も 0。

### 本番適用 — 2026-10-06（ユーザーの明示承認による）

- 承認：ユーザーがチャットで、G5 共通アカウントの legacy backfill の本番適用を明示的に承認した。
  - 手順は TASK どおり：fresh な mutex / state の確認 → fresh な dry-run → 関数の定義 / owner / ACL の再確認 → window を ACTIVE → 凍結済みの transaction だけを実行 → read-only の postflight → window を CLOSED。
  - client の配線、RLS の enforce、削除 orchestrator、Auth / Storage / OAuth / Vault、Edge deploy、Cron、実 X は行わない。
- mutex：
  - fresh main（`1be32879`、その後 `2bbaeffe`）で確認した。どのスロットも window を開いておらず、G1 / G2 は ready、G3 は review_required、G4 / H1 / H2 は done。
  - PR #93 は `b9cb6dcc` で main に入っていた。check / apply / proof / README は凍結した版と byte が一致。
  - 着手マーカー `11e71aa6`。window の ACTIVE は `ccc39926`（16:5x JST、fresh な確認の後）。CLOSED は 17:52 JST。
- fresh な確認（16:45 JST、read-only）：
  - runner の `status` は EXACT / EXACT。
  - `check.sql` の全 10 項目が、承認時（16:28）の確認と完全に同一：関数の定義ハッシュ・owner・SECURITY DEFINER・`search_path=""`・API ロールの EXECUTE 不可、dry-run 5 / 2 / 1、照合、PG 17.6。
- 実行（16:54〜16:55 JST、operator が `.g5-backfill/operator.sh apply` で実行、`BACKFILL` を手入力、DB password は非表示で 1 回入力）：
  - wrapper が固定・確認したもの：checkout `d9719dc6`（main の `b9cb6dcc` と同じファイル）、clean、migration / runner / check / apply の SHA。
  - runner の `status` が EXACT/EXACT → `check.sql` の事前確認（16:28 と同一）→ `apply.sql`。
  - `apply.sql` の中で：
    - その場の plan が承認値と同じ。
    - `result` は `applied: true`、`created_common_accounts 5`、`created_kabumori 2`、`created_x_autopost 1`、`skipped_account_not_active 0`。
    - postcondition はすべて成立（account 5 = ログイン 5、全員 active、未作成 0、entitlement 3 は全件 active / legacy_backfill、evidence は activity 1 / profile のみ 1 / verified 1、admin に X は無い、auth-only 2 人に entitlement は無い、version = 1 + entitlement 数、operations 0、settings は不変）。
    - 再度 false を実行して作成予定は 0。
    - `COMMITTED={"operations": 0, "entitlements": 3, "common_accounts": 5}`。

### read-only の postflight

- `check.sql`（16:55 JST、READ ONLY）：
  - account 5（全員 active）＝ auth.users 5。account の無いログイン 0。plan の行も distinct も 5。
  - entitlement 3：`kabumori/active/legacy_backfill/kabumori_activity` 1、`kabumori/active/legacy_backfill/kabumori_profile_only` 1、`x_autopost/active/legacy_backfill/x_identity_verified` 1。それ以外の種類は 0（不明な service_key / source / evidence / status も無い）。
  - dry-run の作成予定：common_accounts / kabumori / x_autopost とも 0。候補の分類（Kabumori 2、X 1、admin の X 除外 1、auth-only 2）は事前と同じ。
  - lifecycle operations は 0（in_progress 0）。settings は `shadow` / `not_started` / epoch 1、registry は built-in の 3 行。
  - 既存のサービス行の件数は不変（profiles 2、brands 5、memberships 2）。ledger は 75 行で不変。auth.users は 5 で、匿名 / 論理削除 / SSO / BAN 中はいずれも 0。
- **runner の `status` が `schema=UNSAFE history=EXACT` を返した件の分類**（ブロッカーではないと確定した）：
  - 原因：runner の pin には「適用直後の空の state（`accounts=0 entitlements=0 operations=0`）」が 10 番目の section として含まれている。backfill で件数が変わると、必ず UNSAFE になる。
  - 証明：runner 自身の descriptor / semantic の SQL を、そのまま read-only で本番に流した（`operator.sh diag`、17:51 JST）。
    - 10 section のうち 9（columns / constraints / indexes / relations / policies / triggers / table_acl / functions / function_acl）は pin と完全一致。スキーマ・RLS・ACL・関数は 1 つも変わっていない。
    - `state` は `b11335df…`。これはローカルで同じ backfill をした後の値と完全一致し、内容は `settings=shadow/not_started/1 registry=…3 行 accounts=5 entitlements=3 operations=0`。
    - semantic check（owner、overload、API ロールの membership、table / column / EXECUTE の実効権限、RLS）は 0 件。
    - runner が数える既存オブジェクトの指紋は `ac4f83b4…` で、適用前と同一。
  - 今後について：runner の `status` は foundation を入れた時点の確認用で、利用が始まった後は state の section のせいで UNSAFE と出る。今後の foundation 確認には diag の 9 section と semantic を使う（下の remaining に記載）。

### TASK の postflight 要件との対応

| 要件 | 結果 |
|---|---|
| common_accounts = 現在の Auth ログイン数 | 5 = 5 |
| 重複する common account が無い | PK + 5 行 / 5 人、未作成 0 |
| entitlement の合計が承認した候補数と一致 | 3 = Kabumori 2 + X 1 |
| 全件 source = `legacy_backfill` | 3 / 3 |
| legacy_evidence の内訳が dry-run と一致 | activity 1 / profile のみ 1 / verified 1 |
| 作成した entitlement は status = active | 3 / 3 |
| auth-only は account あり・entitlement なし | 2 人（apply の postcondition で確認） |
| 除外した admin に X entitlement を作っていない | 0 |
| 不明な service_key / source / evidence / status が無い | 0 |
| lifecycle operation を作っていない | 0 |
| 既存のサービス行を変えていない | profiles / brands / memberships の件数は不変。関数は新しい表だけに書く |
| Auth / Storage / OAuth / Vault / Edge / Cron の変更が無い | 0（実行したのは transaction 1 つだけ） |
| `backfill(false)` を再実行して作成予定が 0 | 0 / 0 / 0 |
| production_mutation_window を CLOSED に | 17:52 JST |

### 適用後の changed_files / remaining / next

- changed_files：この Report と header だけ（`.agent/tasks/CLAUDE_TASK_5.md`）。source の変更は 0（PR #93 は既に main に入っている）。
- deploy：0。backfill：1 回（上記のとおり）。
- 証跡（未追跡、G5 worktree `/Users/yuya/Developer/kabumori-g5-backfill/.g5-backfill/`）：
  - `logs/` に status / precheck / apply / status-after / readback / diag の各ログ。いずれも集計値だけで、password も PII も含まない。
  - `diag/` に、runner の descriptor / semantic の SQL と、比較に使った pin・ローカルの値。
- remaining_issues：
  - runner の `status` は、今後は `UNSAFE`（state section が原因）と出る。foundation の確認には diag（9 section + semantic）を使うよう、runbook に追記するのが望ましい（小さな文書の task。今回は行っていない）。
  - admin の X footprint（自分専用 workspace、接続は pending）は、entitlement に対応しないまま残る。設計どおりで、削除判定では `ADMIN_ACCOUNT` で止まる。
  - Phase 2 / 3（creator / 削除経路の配線、enforcing guard、orchestrator）は未着手。
  - 新しいログイン・profile・workspace は、配線ができるまで自動では entitlement を持たない。必要なら、配線までの間に read-only の `backfill(false)` で差分を観察する。
- safety_checks：
  - 承認範囲外の本番書き込みは 0。PII の出力 0。Vault の値は読んでいない。password は Claude が扱っていない。
  - 他スロットのファイルには触れていない。G5 の window を開いている間、他スロットの本番変更は無かった。
- next_recommendation：
  - K5。追加の Codex review は不要と考える（レビュー済みの関数だけを使い、fail-closed の transaction で、postflight が承認値と完全一致したため）。
  - 次は Phase 2（Kabumori の `ensure_my_profile` と X onboarding を lifecycle の start RPC につなぐ配線）の設計 / 実装 task を推奨する。

### 以前の結果（履歴として保持）

- 16:28 JST 時点：**BACKFILL_READY**（以下の Phase A〜E）。この時点の本番書き込みは 0。
- fresh main：
  - 開始時は `5f37d63e`。着手マーカー `7bf806d0`。Report の基点は `d2e148c3`。
  - main 上の migration SHA は `e632214b…cde3`。runner（`50e08e1d` で main に入ったもの）の SHA は `86c1a3ed…` で、本番 apply 時のものと同一。
- isolated worktree：`/Users/yuya/Developer/kabumori-g5-backfill`（branch `claude/g5-backfill-gate-20261006`、`kabumori-fresh` の fresh main から作成）。他スロットとは共有していない。
- production project：`wsmznyzcvmuitkglfeuj`。
- 確認した docs（2026-10-06）：
  - PG17 の READ ONLY transaction は行ロック（FOR KEY SHARE を含む）も拒否する。ローカルでも実測した。dry-run（false）はロックを取らない。
  - GoTrue の通常の更新（`last_sign_in_at` など）は FOR NO KEY UPDATE なので、backfill の FOR KEY SHARE とは衝突しない。衝突するのは削除・論理削除（phone の変更）だけ。
  - Supavisor の session mode（5432）は接続を client に固定するので、SET LOCAL / lock_timeout が効く。
  - 2026 年の Auth の変更で backfill に関係するのは、匿名 / 論理削除 / SSO の扱いだけ（本番ではすべて 0 件だった）。

### Phase A — 基盤と現在の人数（read-only、2026-10-06 16:28 JST）

- runner の `status` は `STATE schema=EXACT history=EXACT`。
- 履歴：対象の行が exact に 1 行。同じ名前で別 version の行は 0。ledger は 75 行。
- 関数：定義のハッシュがレビュー済みの source と一致した（ローカル PG17 の同じ deparse と同一）。
  - `backfill(boolean)` `252686a2…`、`account_lifecycle_lock` `b016c1fe…`、plan view `e5f0c915…`。
  - backfill は owner `postgres`、SECURITY DEFINER、`search_path=""`。anon / authenticated / service_role はどれも EXECUTE 不可。
  - view と関数は e-mail を参照していない。
- settings は `shadow` / `not_started` / epoch 1。built-in の checkpoint 3 行。
- 人数（集計のみ）：
  - auth.users は 5（匿名 0、論理削除 0、SSO 0、BAN 中 0）。identities は email が 5。
  - common_accounts 0、entitlements 0、operations 0（in_progress 0）。
  - 想定外の既存行は無い。

### Phase B — 正規の dry-run（`backfill(false)`、READ ONLY transaction の中で実行）

```
auth_users 5 / common_accounts_to_create 5
kabumori_candidates 2 = with_activity 1 + profile_only 1 / kabumori_to_create 2
x_autopost_candidates 1 = identity_verified 1 + workspace_pending 0 / x_autopost_to_create 1
x_autopost_excluded_admin 1 / auth_only 2 / admin_users 1
not_active_accounts_with_candidates 0 / excluded_non_self_service_memberships 0
applied false / created_common_accounts 0 / created_kabumori 0 / created_x_autopost 0 / skipped_account_not_active 0
```

- 前後の行数は同一だった（auth 5、accounts 0、entitlements 0、operations 0、ledger 75、profiles 2、brands 5、memberships 2）。
- lifecycle operation の作成・履歴の変更・Auth / Storage / Vault / OAuth の変更はいずれも 0。

### Phase C — 照合と分類（plan view を使わず、元テーブルから数え直した）

- plan view の行数は 5、distinct も 5 で、auth.users にいない user は 0。どのログインも plan にちょうど 1 回だけ現れる。
- account の無いログインは 5 で、`common_accounts_to_create` と一致。
- Kabumori：候補 2 = activity 1 + profile のみ 1。profile なしで activity だけある人は 0。作成予定 2（既存の entitlement も、非 active の account も無い）。
- X：
  - 自分専用の self-service workspace を単独で所有している人は 2。そのうち admin が 1 なので対象外。消費者向けの候補は 1（verified 1、pending 0）。
  - 共有 workspace / 内部 workspace を所有している人・他の workspace にも所属している人はすべて 0。
  - workspace の内訳：self_service 2（どちらも所有者 1 人）、内部 3。membership は owner / self_service / 自分の workspace の 2 件だけ。
  - social account の内訳：self_service に verified 1 と authorization_pending 1。内部に verified 2。
- auth-only は 2。5 − (Kabumori 候補 2 ∪ X 候補 1) で整合する。
- システム自身の footprint 関数による分類（ログインごとに集計）：
  - footprint なし・候補なし：2
  - X の footprint があり X 候補：1
  - Kabumori の footprint があり Kabumori 候補：1
  - **admin で、Kabumori と X の両方の footprint があり、Kabumori 候補だが X は対象外：1**
    - これは設計どおりの H1-4（admin は消費者向け X entitlement を持たない）。X の footprint が entitlement に対応しないまま残ることは明示しておく。将来の削除判定ではもともと `ADMIN_ACCOUNT` で止まる。
  - 黙って分類されたものや、どの分類に入るか曖昧なものは無い。
- e-mail による統合：無い（view と関数の定義に e-mail は無く、plan は 1 ログイン 1 行）。
- 現在のログインの X 削除記録：0。

### Phase 0（2026-10-01）との比較

| 項目 | Phase 0 | 今回 | 説明 |
|---|---|---|---|
| ログイン | 4 | 5 | +1 は auth-only（profile も workspace も無い新しいログイン） |
| Kabumori 候補 | 2（activity 1 は admin、profile のみ 1） | 2（同じ） | 変化なし |
| X 消費者候補 | 1（verified） | 1（verified） | 変化なし |
| admin が自分専用の self-service workspace を所有 | 0 | 1（接続は authorization_pending） | admin（運営者）が X アプリで self-service 接続を開始した状態。設計どおり X の対象外 |
| auth-only | 1 | 2 | 新しいログインのぶん |

- どちらの差分も、通常の利用 / テストによる状態変化として説明できる。
- K5 / ユーザーに確認したいこと（ブロッカーではない）：5 人目のログインと、admin による X workspace の作成が、運営側の想定内（テストなど）であること。

### Phase D — ローカル / 使い捨て環境での証明（fresh main）

- `common_account_lifecycle_run.sh` 20/20 PASS。既存の backfill 挙動テストを含む：
  - false は行を変えない。true は想定どおりの行を作る。2 回目は no-op。
  - admin の X 除外、profile のみ / activity の evidence、verified / pending、非 active の skip、既存 entitlement を書き換えない、e-mail で統合しない。
- `migration_source_invariants_test.ts` 10 passed。
- 新しい `supabase/tests/common_account_lifecycle_backfill/proof.sh` 32/32 PASS：
  - check は READ ONLY で、書き込みなし。紛れ込んだ書き込みは拒否される。dry-run と、数え直した値が一致する。
  - apply は承認した行だけを commit する。
  - 次の場合はすべて exit 3 で、何も commit されない：commit 後の再実行、plan の変化（新しいログイン）、承認値の誤り、承認値の欠落、1 ログインの行が lock 中（lock timeout。先に作った行も含めて全部 rollback）、書き込み後の行の改変（postcondition）。
- 防御を意図的に壊した版 6/6 を検出した：READ ONLY の除去、plan assert の除去、post assert の除去、lock_timeout の除去、precondition の除去、evidence check の除去。
- 本番と同じ形の人数構成（admin が Kabumori を使い X workspace を所有、profile のみ、X verified、ログインのみ × 2）をローカルに作った：
  - dry-run は本番と完全一致した。
  - 凍結値で apply.sql を通すと COMMITTED（accounts 5、entitlements 3 = kabumori_activity 1 / kabumori_profile_only 1 / x_identity_verified 1、operations 0）。その後の dry-run で作成予定は 0。

### Phase E — 凍結した本番適用パッケージ（未実行）

- source：PR [#93](https://github.com/anohi-memories/kabumori/pull/93)、head `d9719dc6`（merge HOLD）。
  - `check.sql` SHA `04c262e6…4413`、`apply.sql` SHA `04557809…3103`。
- 実行者：operator（ユーザー）が `bash /Users/yuya/Developer/kabumori-g5-backfill/.g5-backfill/operator.sh apply` を実行する。
  - wrapper は未追跡で、SHA は `6844aee1…6f46`。
  - 次をすべて固定・確認してから進む：checkout が `d9719dc6`、tracked ファイルが clean、migration / runner / check / apply の SHA。
  - 実行前に `BACKFILL` の手入力を求める。
  - DB password は 1 回だけ非表示で入力し、process 内でだけ使う。
- 凍結した承認値：`exp_auth_users=5 exp_accounts_to_create=5 exp_kab_to_create=2 exp_kab_activity=1 exp_kab_profile_only=1 exp_x_to_create=1 exp_x_verified=1 exp_x_pending=0 exp_x_excluded_admin=1 exp_auth_only=2`
- 流れ：
  1. runner の `status` が EXACT/EXACT でなければ STOP。
  2. `check.sql`（read-only の事前確認）。
  3. `apply.sql`：1 つの READ COMMITTED transaction の中で、`lock_timeout 5s`、`statement_timeout 120s`。
     - precondition：0 / 0 / 0 と `shadow` / `not_started`。
     - その場の plan が承認値と同じであること。
     - `private.account_lifecycle_backfill(true)`。
     - postcondition：作成数、account = ログイン数、全員 active、未作成 0、entitlement は全件 active / legacy_backfill で evidence の内訳が一致、admin に X が無い、auth-only に entitlement が無い、version = 1 + entitlement 数、operations 0、settings は不変。
     - 再度 false を実行して作成予定が 0 であること。
     - そのうえで COMMIT。
  4. 結果に `COMMITTED=` が無ければ STOP（再実行しない）。
  5. runner の `status` と `check.sql` で読み返す。
- 失敗時の扱い：
  - assertion の不一致・lock timeout・エラー → psql exit 3、transaction 全体を rollback、STOP。
  - 応答を失った → 再実行しない。`check.sql` で分類する：accounts 0 なら未適用、承認どおりの行があり作成予定 0 なら適用済み、それ以外は STOP。
  - 想定外の行・件数 → STOP。部分的な状態はそもそも commit されず、手作業で直すことはしない。
- 期待する postflight（read-only）：
  - accounts 5（全員 active、重複なし）。
  - entitlements 3（`kabumori/active/legacy_backfill/kabumori_activity` 1、`kabumori_profile_only` 1、`x_autopost/…/x_identity_verified` 1）。
  - auth-only 2 人は entitlement なし。admin の X entitlement 0。operations 0。
  - dry-run の作成予定はすべて 0。既存のサービス行（profiles / brands / memberships）の件数は不変。
  - 不明な service_key / source / evidence / status は CHECK 制約上ありえず、集計でも 0。
- 範囲外のまま：client の配線、RLS の enforce、削除経路、orchestrator、Auth の削除、session / provider の revoke、Storage / Vault、Edge deploy、Cron、実 X。

### その他

- production mutex：開始時も Report 時も、本番変更の window を開いているスロットは無かった。G1 / G3 は review_required / ready（本番変更なし）、G2 は ready（read-only の観察）、G4 / H1 / H2 は done。backfill の適用時には、G5 の window を ACTIVE にしてから実行する。
- changed_files：
  - PR #93（`supabase/tests/common_account_lifecycle_backfill/` の README.md、check.sql、apply.sql、proof.sh）。
  - この Report（`.agent/tasks/CLAUDE_TASK_5.md` のみ）。
  - migration / 既存 source の変更は 0。
- commit / push：PR #93 は `d9719dc6`（branch に push 済み、未 merge）。着手マーカー `7bf806d0` とこの Report を main に push。
- deploy：0。backfill：0。
- 前回 Report の訂正：`auth.scim_users.user_id` の FK を「NO ACTION」と書いたのは誤り。`confdeltype = n` は **ON DELETE SET NULL** で、Auth の削除を妨げない（GoTrue v2.197.0 の migration とも一致）。
- remaining_issues：
  - ユーザーによる確認（5 人目のログインと、admin の X workspace）。
  - PR #93 を merge するかの判断（適用は固定 commit から実行できる）。
  - Postgres 17.11 へのアップグレードが dashboard で可能になっているが、dry-run と書き込みの間に挟まないこと。
- safety_checks：
  - 本番書き込み 0。PII（UUID / e-mail / provider subject / handle / token）の出力 0。Vault の値は読んでいない。password は Claude が扱っていない。
  - 他スロットのファイルには触れていない。テストで使った UUID は固定の偽値だけ。
- next_recommendation：
  - K5 で、このパッケージと PR #93 を確認する。
  - ユーザーが本番の backfill を明示的に承認したら、同じ G5 を再開する：fresh mutex → Phase A/B の再取得 → 関数の定義 / owner / ACL の確認 → window を ACTIVE → `operator.sh apply` → postflight → window を CLOSED。
  - 追加の Codex review は不要と考える（レビュー済みの関数だけを使い、tooling は mutation で検証済み）。

---

# Previous G5 task history — preserved

# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase1-production-migration-gate-20261006
- owner: claude
- slot: claude-5
- status: done
- next_owner: none
- production_mutation_window: **CLOSED** — 2026-10-06 14:58 JST. G5 applied exactly 20261001150000 (Stage A/B/C + postflight EXACT, one history row) and read it back; G5 performs no further production write. backfill / deploy / Auth / Storage / OAuth / Vault / Cron / real X = 0.
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: production migration preflight / exact single-file rollout gate / read-back
- production_project_ref: wsmznyzcvmuitkglfeuj
- production_mutation_allowed: false_until_explicit_gate
- backfill_allowed: false
- auth_delete_allowed: false
- deploy_allowed: false

## Purpose

Common-account v1 Phase 1 の additive lifecycle foundation は source review / hosted Gate B / Final C1 まで完了し、
**foundation installation 自体は PASS-WITH-CONDITIONS** で受理済み。

このTASKは、productionへ exact Phase 1 migration を安全に入れるための専用G5 gate。

ただし開始時点では production write 権限はない。
まず fresh read-only preflight と exact apply/history package の固定まで行い、
**実際の production migration write の直前で必ず STOP してユーザーの明示承認を待つ。**

承認後に同一TASKを再開した場合のみ、承認された exact migration 1本だけを適用し、
直後に schema / ACL / RLS / function / migration-history read-back を行う。

このTASKでは backfill(true)、削除フロー有効化、Edge deploy、Auth削除、Storage削除、OAuth/Vault操作は行わない。

## Canonical accepted source

Accepted foundation:
- PR #70 merged source commit: `44121914b035e22380a4ca1bd8252a42713a2bbf`
- accepted fixed source commit: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`
- target migration:
  `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`
- accepted migration SHA256:
  `e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3`

Fresh main may contain later unrelated commits.
Before any rollout work, prove target migration bytes still match the accepted SHA256 exactly.
Mismatch => STOP. Do not “fix” production or amend the migration in this TASK.

## Accepted Gate B / C1 facts

Hosted disposable Supabase proof already established:
- exact migration applies on a real managed Supabase project
- authenticated own-row RLS read works
- cross-user read denied
- client direct write denied
- anon read denied
- service_role direct table access denied
- narrow RPC boundary works
- real Storage ownership blocks deletion readiness
- Storage API cleanup allows readiness
- direct common_accounts delete while Auth parent exists is refused
- real Auth Admin hard delete cascades Auth/common/entitlement state as intended
- durable login_removed lifecycle observation survives

Critical hosted security result:
- an already-issued access JWT remained usable against Data API after Auth deletion

Therefore:
- this Phase 1 foundation may be installed
- but destructive orchestration / enforcement is NOT authorized here
- session/global sign-out or refresh-token deletion alone must never be treated as stale-access-token invalidation
- future deletion orchestration needs live writer denial or independently proven bounded-expiry/quiescence

Do not re-open those architecture questions by weakening the accepted source.

## Mandatory startup / isolation

Before doing anything:

1. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - `.agent/ACTIVE_TASK.md`
   - this G5 TASK + prior G5 Report
   - final H1/C1 common-account review/report
2. Use the new-Mac clean base:
   `/Users/yuya/Developer/kabumori-fresh`
3. Fetch fresh `origin/main`.
4. Create a **new G5-dedicated independent worktree/checkout** from fresh origin/main.
5. Confirm it is not shared with G1-G4/H1/H2.
6. Never checkout/reset/rebase/delete another slot branch/worktree.
7. Confirm clean git status.
8. Check current Supabase changelog/docs relevant to:
   - migration/apply semantics
   - Auth/RLS/Data API grants
   - SECURITY DEFINER behavior
   - managed Auth/Storage boundaries
9. Confirm production target is exactly:
   `wsmznyzcvmuitkglfeuj`
   and not the disposable Gate B project or photo project.

If safe independent worktree cannot be established => STOP.

## Production-mutation mutex — critical

G4 currently has a separate X/social-mobile production rollout workstream.
Other slots may also advance while G5 is working.

**No two slots may perform production mutation concurrently.**

Before every production write:
- fresh-fetch origin/main
- re-read ACTIVE_TASK / CURRENT_STATE
- inspect relevant G/H TASK states
- confirm no other slot is in a production mutation/apply/deploy window
- confirm no overlapping migration/RPC/Auth/permission work has landed since preflight

If G4/G3/H1/H2 or another operator is applying/deploying/mutating the same production project:
**STOP before write.**
Read-only work may continue only if it cannot race with the mutation.

Do not “win the race” by applying first.

## Phase A — fresh production read-only preflight

Production reads only.

Re-run the full preflight immediately against current production, not historical snapshots.

At minimum verify:

### Migration/history collision
- target version/name absent
- no equivalent partial/manual foundation install
- no unexpected same-version migration
- no source/history collision
- no prior failed partial target objects

### Exact dependency shape
Re-derive from current accepted migration and verify all production dependencies it expects, including the previously reviewed:
- required relations
- required columns/types/nullability
- exact FK targets/actions/validation/deferrability
- helper function signatures/definitions/owners
- profile child cascade assumptions
- X/social-mobile helper dependencies
- `private` schema presence
- Auth/Storage managed schema shapes actually relied on

Use source-derived exact checks, not only counts.

### Ownership / role graph / defaults
Verify:
- current execution/apply owner
- relation/function owners
- API roles and inherited role memberships
- schema privileges
- default privileges that could grant unexpected table/function rights
- no unexpected overload/procedure/name collision
- Data API exposed schemas/config relevant to the new public objects

Unexpected owner/grantee/member/default ACL => STOP.

### Current target objects
All objects created by the foundation must be absent before first apply.
If any target table/view/index/function/trigger/policy already exists:
STOP and classify exact state.
Do not drop, rename, repair or reapply.

### Concurrent production work
Verify no pending/active migration from G4/G3 or another workstream would make this preflight stale.
If another production mutation lands after preflight, Phase A must be repeated before write.

## Phase B — freeze the exact apply/history mechanism

Before asking for mutation approval, document the exact command/tool/API path that will be used.

Requirements:
- exact one migration file only
- exact SHA256 above
- no ordinary `db push`
- no include-all
- no migration-history repair/relabel
- no unrelated migration
- no ad-hoc SQL edits
- no blind retry
- no assumption that schema + migration history are atomic unless actually proven for the chosen path

The migration owns its own transaction boundary.
Explicitly document:
- who executes the SQL
- how the filename/version/name are represented in migration history
- when history is written
- what happens if SQL succeeds but history bookkeeping fails
- what happens if response is lost
- what exact read-back determines:
  - not applied
  - schema present/history absent
  - history present/schema invalid
  - full success

If the chosen mechanism cannot be made deterministic and fail-closed:
STOP and report BLOCKED.
Do not improvise a new production apply path.

## Mandatory approval stop

After Phase A + B are PASS:

- write a concise approval package in the G5 Report:
  - production project ref
  - fresh main SHA
  - migration path + SHA256
  - preflight PASS summary
  - exact apply mechanism
  - exact migration-history policy
  - exact failure/STOP rules
  - expected read-back
  - confirmation that backfill/deploy/Auth/Storage/OAuth/Vault are out of scope
  - confirmation no other production mutation is active
- set status to `review_required`
- next_owner: `chatgpt`
- STOP for K5

**Do not apply the migration yet.**

ChatGPT/user must explicitly approve the production mutation package.

## Phase C — only after explicit production approval

When the same G5 TASK is explicitly re-authorized:

1. Re-read TASK / ACTIVE_TASK / CURRENT_STATE.
2. Fresh origin/main and production-mutation mutex check again.
3. Re-run any preflight element made stale by intervening changes.
4. Reconfirm migration bytes/hash.
5. Apply only the exact authorized migration through the frozen mechanism.
6. Stop-on-error.

Never:
- rerun blindly after timeout/lost response
- use ordinary db push
- apply later migrations “while here”
- fix ACLs manually
- repair history without separate authority
- roll back automatically

If apply outcome is uncertain:
perform read-only catalog + history classification and STOP.

## Phase D — mandatory production read-back after successful apply

Read-only verification immediately after apply.

At minimum verify:

### Schema/object exactness
- all expected public/private relations
- exact columns/defaults/constraints/checks
- PK/FK actions and validation
- indexes valid/ready/live
- expected triggers enabled
- expected policies
- no unexpected overloads

### Function security
For every created function:
- exact signature
- owner
- SECURITY DEFINER/INVOKER as intended
- exact empty/fixed search_path contract
- exact effective EXECUTE grantees including inherited roles
- no PUBLIC/anon/authenticated/service_role privilege beyond intended design

### Table/RLS/API privilege model
- RLS enabled where expected
- authenticated own-row SELECT only on intended public columns
- client INSERT/UPDATE/DELETE/TRUNCATE denied
- anon entry denied
- service_role direct-table privilege denied
- backend service_role uses only intended narrow RPCs
- private view/helpers not exposed to API roles
- default/inherited privileges do not defeat intended grants

### Foundation defaults
- settings row exists exactly once with expected shadow/not-started semantics
- built-in checkpoint registry/requirements are exact
- no enforcement mode accidentally enabled
- no account/entitlement/operation population was created by migration itself
- target migration history is exactly as approved

### Existing dependency preservation
Verify the migration did not mutate unrelated existing objects/grants/helpers.

Any mismatch:
STOP.
Do not patch production inside this TASK unless a new explicit corrective authority is issued.

## Explicitly out of scope

This G5 task MUST NOT:
- run `private.account_lifecycle_backfill(true)`
- create production common_accounts/service_entitlements for existing users
- activate client registration/service-start wiring
- change Kabumori `ensure_my_profile`
- change X onboarding
- change current deletion routes
- enable deletion enforcement
- hard-delete any Auth user
- revoke sessions/tokens
- touch Apple/X OAuth
- touch Vault secrets
- delete Storage objects
- deploy Edge Functions
- change Cron
- change feature flags
- run real X
- mutate photo-sharing or disposable Gate B projects

After migration read-back PASS, backfill(false) may only be done if the specific read-only authority is clearly included in the next orchestration step; backfill(true) is always a separate explicit approval.

## Completion / K5

Report must contain:
- task_id
- result: PREFLIGHT_READY / APPLIED_PASS / BLOCKED / PARTIAL
- checked_main
- dedicated worktree/isolation
- production project ref
- migration path/hash
- fresh preflight results
- concurrent production-mutation check
- chosen apply/history mechanism
- exact approval boundary used
- production writes actually performed
- migration-history result
- schema/RLS/ACL/function read-back
- tests/checks
- changed_files
- commit_hash / push
- deploy
- backfill
- remaining_issues
- safety_checks
- next_recommendation

Never report apply/push/deploy/backfill as successful unless actually verified.

### If stopping before approval
- status -> `review_required`
- next_owner -> `chatgpt`
- result -> `PREFLIGHT_READY`
- production mutation = 0

### If resumed after explicit approval and apply/read-back succeeds
- status -> `review_required`
- next_owner -> `chatgpt`
- result -> `APPLIED_PASS`
- backfill = 0
- deploy = 0

## Review guidance after K5

Do not automatically allocate another Codex review merely because this is a migration.
ChatGPT will inspect the actual G5 evidence.

If the exact approved migration applies cleanly and exhaustive read-back matches the already H1-reviewed source contract, an additional review may be unnecessary.
If there is any production drift, uncertain history state, privilege mismatch, partial outcome or security ambiguity, allocate focused Codex review.

Recommended Claude model: **Opus5.5（極高）**.

## Continuation authorization — 2026-10-06 after G4 CLOSED

- G4 PR76 production rollout is complete and its production_mutation_window is CLOSED as of 14:11 JST.
- This continuation authorizes **read-only Phase A refresh only**. It does NOT yet authorize the common-account production migration write.
- Before doing any read, fresh-fetch origin/main and re-read ACTIVE_TASK/CURRENT_STATE. Confirm G2/G3/H1/H2 or another operator is not in an active production mutation window.
- Re-run all 9 production read-only Phase A checks from the existing approved preflight bundle.
- Expected state changes versus the previous baseline include PR76 migration/history and its objects; refresh the ledger row count and existing-object fingerprint rather than comparing to the stale pre-G4 values.
- Reconfirm target common-account migration objects/history remain absent, dependencies/owners/role graph/default ACL remain compatible, renderer canary remains valid, and exact migration SHA256 remains `e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3`.
- If all 9 checks PASS, update Report with the fresh baseline, set status review_required / next_owner chatgpt, and STOP for explicit production mutation approval.
- If any unexpected drift appears, STOP BLOCKED; do not apply, repair, drop, rewrite history, or change ACLs.
- backfill/deploy/Auth/Storage/OAuth/Vault/Cron/real X remain forbidden.
- Recommended model: **Opus5.5（極高）**.

## Report

- task_id: common-account-v1-phase1-production-migration-gate-20261006
- result: **APPLIED_PASS**（2026-10-06 14:54 JST。承認済みの migration 1 本だけを本番に適用し、読み返しがすべて一致した）。
- production writes actually performed（すべてユーザーの明示承認の範囲内）：
  - `20261001150000_common_account_lifecycle_foundation.sql` のスキーマ適用（Stage A）。1 transaction。
  - migration 履歴に 1 行を insert（Stage C）。`20261001150000 / common_account_lifecycle_foundation`。
  - これ以外の本番書き込みは 0。backfill / deploy / Auth / Storage / OAuth / Vault / Cron / flag / 実 X / 削除機能の有効化もすべて 0。
- backfill: **0**（common_accounts 0 行、service_entitlements 0 行、operations 0 行を読み返しで確認）。deploy: **0**。

### Production apply — 2026-10-06（ユーザーの明示承認による）

- 承認：ユーザーがチャットで次の内容を明示的に承認した。
  - G5 共通アカウント Phase 1 の本番 migration 適用。
  - 手順は TASK どおり：fresh mutex → 必要なら最終 preflight → exact migration 1 本 → read-back。
  - backfill・削除機能の有効化・Auth / Storage / OAuth / Vault・Edge deploy・Cron・実 X は行わない。
- mutex：
  - 適用前に fresh main を確認した（`e8036721`、直前は `a82e7987`）。
  - 他スロットの状態：G2 は 14:34 に CLOSED（Edge deploy のみ。DB は変更していない）。G3 は書き込み保留（review_required）。G4 / G1 は本番変更なし。H1 / H2 は done。
  - G5 の `production_mutation_window` を ACTIVE にしてから作業した（`9c6f71bf`）。CLOSED にしたのは 14:58 JST。
- 最終 preflight（14:49〜14:52 JST）：
  - 9 本の結果は 14:27 の baseline と完全に一致した（履歴 74 行、指紋 `db31ea2e…15dd`、対象のオブジェクト・履歴は不在）。
  - G2 の deploy が 14:27 の後に入っていたため、TASK の決まりどおり再取得した。
  - runner の `status` は `schema=ABSENT history=NONE`（psql の接続と本人確認も成功）。
- 実行方法：
  - operator（ユーザー）が wrapper `.g5-prod-gate/operator.sh`（未追跡、G5 worktree）から実行した。
  - wrapper は次を固定・確認してから runner（PR #91 head `cab1f0fe`）を呼ぶ：checkout が `cab1f0fe` であること、tracked ファイルが clean であること、migration の SHA `e632214b…`、runner の SHA `86c1a3ed…`、test hook の解除。
  - 接続：session pooler、`postgres.<ref>`、`PGSSLMODE=require`。DB password は wrapper の中で 1 回だけ非表示で入力し、process 内でだけ使用した（保存・表示なし。Claude はパスワードを扱っていない）。
- runner の出力（14:54 JST）：
  - `preflight: schema=ABSENT history=NONE`
  - `Stage A: migration committed`（lock_timeout 5s。ロック待ちによる失敗なし）
  - `Stage B: existing objects unchanged`、`catalog read-back = EXACT`（pin した 10 section と、実効権限などの意味チェックがすべて一致）
  - `Stage C: history recorded (20261001150000 common_account_lifecycle_foundation)`
  - `postflight: schema=EXACT history=EXACT`、`DONE`
  - 別 session の `status`：`STATE schema=EXACT history=EXACT`
- STOP・再試行・修復・手作業での ACL 修正・rollback はすべて 0。

### Phase D — 読み返し（read-only、14:54〜14:57 JST）

**1. 9 本の bundle（適用前の baseline との比較）**
- 01 履歴：75 行。差分は 1 行だけ：`20261001150000 / common_account_lifecycle_foundation`（statements NULL）。同じ名前で別 version の行は 0。ほかの履歴は不変。
- 02 作成物：ちょうど relation 12（table 5、view 1、index 6）、型 12、関数 33、trigger 10、policy 2。名前パターンでの広い検索も同じ集合で、ほかの schema に同名の物は無い。
- 03 依存関係：完全に同一（列 26/26、FK 14/14、profiles の子の cascade、helper の本文と権限）。
- 04：`auth.users` の内部 trigger が 28 → 30。`common_accounts_user_id_fkey`（ON DELETE CASCADE）が増えた。いずれも想定どおり。ほかは同一。
- 05：public の関数 123 → 135（+12）、private の関数 1 → 22（+21）、public の relation 77 → 79、private の relation 0 → 4。role graph・schema ACL・既定権限は同一。
- 06（公開経路）・08（canary）：同一。
- 07 既存オブジェクトの指紋：`db31ea2e…15dd` で、適用前と完全一致。既存の table / 列 / 制約 / index / policy / trigger / 関数 / 型 / 既定権限は 1 つも変わっていない。

**2. 読める形での独立した読み返し（`.g5-prod-gate/sql/09_post_apply_readback.sql`、Management API 経由、runner とは別の経路）**
- RLS：table 5 つすべてで有効（FORCE は無効）。view は RLS の対象外で、権限も無い。owner はすべて `postgres`。
- table の権限：anon / authenticated / service_role とも、6 つの relation のどれにも table レベルの実効権限（SELECT〜MAINTAIN）を持たない。直接 ACL も owner 以外は無い。
- 列の権限：authenticated の SELECT だけで、ちょうど次の 11 列。INSERT / UPDATE / REFERENCES と、anon / service_role への権限は 0。
  - `common_accounts`：user_id / status / lifecycle_version / created_at / updated_at
  - `service_entitlements`：user_id / service_key / status / activated_at / ended_at / updated_at
- policy：2 本とも permissive、SELECT、roles は `authenticated`、条件は `(( SELECT auth.uid() AS uid) = user_id)`。WITH CHECK は無い。
- trigger：10 本すべて enabled（O）で、設計どおりの関数を呼ぶ。
- index：6 本すべて valid / ready / live。
- 関数 33 本：すべて owner は `postgres`、SECURITY DEFINER、`search_path=""`。
  - client 用 2 本（`start_kabumori_service` / `start_x_autopost_service`）：直接 ACL は `authenticated:EXECUTE`。実効的に実行できるのは authenticated / postgres / supabase_admin だけ。
  - backend 用 10 本：直接 ACL は `service_role:EXECUTE`。実効的に実行できるのは service_role / postgres / supabase_admin だけ。
  - 内部の 21 本：直接 ACL は無い。実効的に実行できるのは owner の postgres と superuser の supabase_admin だけ。
  - PUBLIC / anon には全関数で権限が無い。grant option も無い。authenticator は authenticated / service_role に `inherit=false` で属しているため、実効権限の一覧に出ない。
- foundation の初期状態：settings は 1 行（`shadow` / `not_started` / epoch 1）。registry は built-in の 3 行（apple_revocation:apple_identity、session_revocation:always、storage_cleanup:always）。common_accounts / service_entitlements / operations はすべて 0 行。enforce は存在しない。
- ledger：対象行は 1 行だけ。
- schema の USAGE（参考）：`private` に対して authenticated は true（適用前からの状態）。anon と service_role は false。

### 判定と残り

- 判定：承認された exact migration だけが適用された。スキーマ・RLS・ACL・関数・履歴は、H1 で review 済みの source の契約と、pin した期待値の両方に一致した。既存オブジェクトは不変。drift・履歴の不確定・権限の不一致・部分適用は無い。
- 追加の Codex review：不要と考える（TASK の Review guidance の「exact apply + 読み返しが一致」に該当）。
- remaining / next：
  - `private.account_lifecycle_backfill(false)`（read-only の件数集計）と `backfill(true)` は、それぞれ別の権限付与と承認が必要（今回は 0）。
  - integration（Phase 2/3）・enforcing guard・削除 orchestrator は未着手（前回 Report の obligations のまま）。
  - PR #91（runner と bundle）を merge するかの判断。本番ではこの PR の固定 commit から実行した。
  - DB password は G4 の作業中にリセット済みのもの。今回の適用で変更はしていない。
  - CLI の "Initialising login role..." は、毎回の read-only 実行と同じく観測として記録する。
- safety_checks：
  - 承認範囲外の本番書き込みは 0。
  - PII（token / JWT / email / user UUID / handle）の出力 0。Vault の値は読んでいない。password は Claude が扱っていない。
  - 他スロットのファイルには触れていない。G5 の window を開いている間、他スロットの本番変更は無かった。

### 以前の結果（履歴として保持）

- 14:27 JST 時点：**PREFLIGHT_READY**（Phase A 再取得 9/9 PASS。差分は G4 PR76 による想定どおりのものだけ。下の「Phase A refresh」）。
- 00:56 JST の初回 Report の時点では、G4 の window が ACTIVE だったため条件付きだった。

### Phase A refresh — 2026-10-06 14:27 JST（G4 CLOSED 後の継続許可：read-only のみ）

- 開始前の mutex チェック（fresh main `5ea7da8a`、マーカー `52efd4e7`）：
  - G4 は done / `production_mutation_window: CLOSED`（14:11 JST）。
  - G2 は ready（Edge deploy は未開始）。G1 / H1 / H2 は done。G3 は ready。
  - 本番変更の window を開いているスロットは無かった。
- Report 時点（fresh main `af4c8996`）：G3 が `in_progress`（PR81 continuation、割当上は最初に read-only Gate A/B）。window の行は無い。
- migration：fresh main 上で SHA-256 `e632214b…cde3` のまま（最終 commit `aa4d2d42`）。PR #91 head `cab1f0fe` も変化なし。
- ユーザーが、commit 済みの bundle（`supabase/tests/common_account_lifecycle_preflight/run.sh`）で 9 本を実行。全 OK、`"_tag":"Error"` は 0。
- 前回（00:56 JST）との機械比較：

| check | 結果 |
|---|---|
| 00 環境 | 同一（PG 17.6、`postgres`、READ COMMITTED） |
| 01 履歴 | 想定どおりの差分だけ：+1 行 `20261003090000 / social_mobile_publish_permission_boundary`（statements NULL）。73 → **74 行**。対象 version / 名前の行は 0 のまま。最大 version は `20261004090000` のまま |
| 02 対象オブジェクトの不在 | 同一（すべて 0。`private` は relation 0 / 関数 1） |
| 03 依存関係の形 | 同一（26/26、14/14、cascade、helper の本文と権限） |
| 04 実行時の依存 | 同一（`auth.users` の内部 trigger 28 を含む） |
| 05 ロールと権限 | 想定どおりの差分だけ：public の関数 121 → 123（PR76 の 2 本）。role graph・schema ACL・既定権限は同一 |
| 06 公開経路 | 同一（event trigger、拡張、publication） |
| 07 既存オブジェクトの指紋 | functions section だけ変化（122 → 124）。relations / constraints / indexes / policies / triggers / types / schemas_and_default_acls の各ハッシュは前回と同一 |
| 08 renderer canary | 同一（7/7） |

- 07 の functions の変化について：PR76 の migration は public に関数 2 本を作り、revoke / grant をその 2 本だけに行う（source で確認。動的な revoke ループも対象はその 2 本に限定されている）。K4 の本番読み返しも exact。G5 の依存 helper の本文・権限は 03 で同一。
- **新しい baseline（適用前）**：
  - 既存オブジェクトの指紋 combined `db31ea2ebb931dab42c4de743978c28eac484d3d99f6b4cb6aa924c382d215dd`
  - 内訳：relations 84、constraints 569、indexes 200、policies 61、triggers 46、functions 124
  - 履歴 74 行
- 注意（K4 の記録より）：rollout 中に DB password がリセットされた。C3 の psql では新しい password を `~/.pgpass` に入れる。
- G3 の PR81（`20261003120000`、`social_mobile_content_settings` の変更）が G5 より先に本番へ入る場合、指紋と履歴がまた変わる。その場合は G5 の書き込み直前に Phase A を再取得する（C1）。G5 と G3 / G2 の本番変更は同時に行わない。
- checked_main:
  - 開始時 `e303d81e`（その後 `00342bbd`）。
  - Report の基点は `e9671778`。push 前に fresh `origin/main` を再確認する。
- worktree / isolation:
  - G5 専用 worktree `/Users/yuya/Developer/kabumori-g5-prod-gate`（branch `claude/g5-phase1-prod-gate-20261006`、新 Mac の `kabumori-fresh` から作成）。
  - control 用 worktree `/Users/yuya/Developer/kabumori-g5-control`（detached）。
  - 他 slot の worktree / branch / TASK は変更していない。
- production project ref: `wsmznyzcvmuitkglfeuj`（linked project 名 `stock-x-autopost`）。全クエリは `--project-ref` を明示して実行した。Gate B の使い捨て project や photo project は対象外。
- migration path / hash:
  - path: `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`
  - SHA-256 `e632214b5602c12ee73d9a7475af36791138099a1a7fdba7e8fb521afc01cde3` = 承認済みの値と一致。ファイルの最終 commit は `aa4d2d42`。
  - 一致しない場合は runner が Stage A の前に STOP 10 で止める。

### 確認した Supabase docs / changelog（2026-10-06）

- CLI v2.115.0+ は BEGIN/COMMIT を自前で持つファイルをそのまま実行し、履歴 INSERT はその後に別に送る。つまりスキーマと履歴は同じ transaction に入らない。
- `db query --linked` は Management API の run-query を使い、migration 履歴を書かない。
- Data API の既定変更について：
  - 2026-04-28 から opt-in、2026-10-30 に全 project へ適用される。
  - 新しい `public` table を API role へ自動で grant しなくなる。
  - 明示的な GRANT は引き続き有効。
- auth / storage schema 内で object を作ることは禁止。一方、public から `auth.users` を参照する FK は許可されている。
- SECURITY DEFINER 関数には `search_path=''` を付け、PUBLIC / anon からの EXECUTE を revoke することが推奨されている。
- いずれも docs の記述であり、本番の実測は下の Phase A で別途確認した。

### Phase A — fresh production read-only preflight（PASS）

ユーザーが `supabase db query --linked --project-ref wsmznyzcvmuitkglfeuj` で 9 本を実行した（各ファイルは SELECT 1 文のみ、catalog と集計値だけを出力、PII なし）。
- runner は、書き込み語・複数文・PII 列を含むファイルを実行前に拒否する（ダミーで拒否を確認済み）。
- 実行時刻：00〜07 は 00:56 JST、08 はその後。

**A1 環境**
- PostgreSQL 17.6。`current_user` / `session_user` は `postgres`（superuser ではない、BYPASSRLS あり）。
- 既定の分離レベルは READ COMMITTED。`postgres` の `lock_timeout` は 0、`statement_timeout` は 2min。

**A2 履歴（ledger）**
- shape は runner の想定と一致：`version` text PK、`statements`、`name`、`created_by`、`idempotency_key` UNIQUE、`rollback`。owner は `postgres`。
- 73 行、最大 version は `20261004090000`。
- 対象 version の行 0、対象名の行 0、関連する名前の行 0。
- repo と大きくずれている（repo にあって ledger に無いもの 59、ledger にだけあるもの 27）。このため `db push` / `migration up` は使えないと確定した。

**A3 作成予定オブジェクトの不在**
- どの schema にも無いことを確認：relation 12、型 12、関数 33、trigger 10、policy 2、名前パターンによる広い検索も 0。
- `private` schema は存在する（owner `postgres`、relation 0、関数 1）。部分的な適用や手作業による導入の跡はない。

**A4 依存関係の形（migration 自身の preflight を SELECT で再現）**
- relation 17/17。
- 型付き列 26/26。
- FK 14/14：参照する列・参照先・削除時の動作・validated・not deferrable・型の一致をすべて照合。
- `profiles` を参照する 6 つの子テーブルはすべて CASCADE。
- helper 2 本は 20260928160000 と本文が完全一致し、text / IMMUTABLE / `search_path=""` / EXECUTE は `postgres` のみ。

**A5 実行時の依存**
- `postgres` が持つ権限：
  - `auth.users`：REFERENCES / SELECT
  - `auth.identities`、`storage.objects`、`storage.buckets`：SELECT
  - `public.profiles`：INSERT / DELETE
  - schema の USAGE / CREATE
- `auth.uid()` は uuid を返し、authenticated から EXECUTE 可能。`gen_random_uuid()` も存在する。
- `profiles` に必須の列は `id` だけ（`insert (id)` が成立する）。
- `auth.users` に user trigger は無く、内部 FK trigger が 28 個ある。適用で内部 trigger がちょうど 2 個増える見込み。
- Storage の `owner_id` は text、deprecated の `owner` は uuid。

**A6 ロールと権限**
- anon / authenticated / service_role はどの role の member でもない（owner の権限を継承しない）。
- `postgres` が新規 object に付ける既定権限：
  - public の table：API role に MAINTAIN / REFERENCES / TRIGGER / TRUNCATE だけ。
  - public の function：API role には無し。
  - private：既定権限の設定なし。
  - grantee は API role と `postgres` だけで、想定外の grantee は無い。
- migration が明示的に revoke するので、最終状態は設計どおりになる。proof では「既定で全付与」と「既定で付与なし」の両極端で同じ結果になることを証明した。

**A7 公開経路**
- event trigger：`ensure_rls`（public の新規 table の RLS を自動で有効化）、`pgrst_ddl_watch` / `pgrst_drop_watch`（PostgREST の schema cache を再読込）、拡張用の hook。
- pg_graphql は未導入。`supabase_realtime` は FOR ALL TABLES ではない。
- `authenticated` は元から `private` の USAGE を持つが、新しい private object には権限が無い。

**A8 既存オブジェクトの指紋**
- combined `d7a00f63a40e0c64da6b7f8993ea9a035e3d6d9d2a7deed861407c861c7795c3`。
- 内訳：relation 84、constraint 569、index 200、policy 61、trigger 46、function 122。

**A9 renderer canary**
- 20260928160000 の object を、本番 17.6 とローカル 17.11 で同じ deparser にかけたハッシュが 7/7 section で一致した。
- このため runner の Stage B に固定したハッシュは、本番でも同じ意味を持つ。

### 本番変更の mutex チェック

- 開始時：他 slot の本番書き込みは無かった。AI Lab の DB rollout は完了済み。
- Report 時点（fresh main `e9671778`）：
  - **G4 は `production_mutation_window: ACTIVE`**（x-test-post と publish-setting の deploy、migration `20261003090000` と履歴 1 行）。
  - G2 は Edge deploy が `ready`（別の承認待ち）。
  - G3 は done（PR81 は G4 の後）。
- G5 は今回、読み取りだけを行い、承認前の書き込みもしていない。G4 の作業とは競合しない。
- PR76 の migration は public に関数 2 本と、その権限を追加するだけで、G5 の依存オブジェクトには触れない。
- ただし PR76 が適用されると、次の 2 つは必ず変わる：
  - A8 の指紋
  - A2 の行数（+1：`20261003090000`）
- そのため G5 の書き込みの直前に Phase A を全部やり直す。

### Phase B — 固定した適用・履歴の仕組み（PR [#91](https://github.com/anohi-memories/kabumori/pull/91)、head `cab1f0fe`、merge HOLD）

- runner：`supabase/tests/common_account_lifecycle_rollout.sh`。AI Lab の PR #86 / #88 と同じ「スキーマ先、履歴後」方式で、この migration のバイト列に固定してある。
- 手順書：`common_account_lifecycle_rollout.md`。
- read-only bundle：`supabase/tests/common_account_lifecycle_preflight/`（今回実行した SQL と文面は同一で、異なるのは 1 行目のコメントだけ）。
- 実行者：operator（ユーザー）が自分のシェルから psql で実行する。session pooler（5432）に `postgres.<ref>`、`PGSSLMODE=require`、password は `~/.pgpass`。Claude には本番への接続権限が無い。

**各段階**
- Stage A：
  - `set lock_timeout = '5s'` の後、対象ファイルだけを `psql -v ON_ERROR_STOP=1` で実行する。ファイル自身の BEGIN/COMMIT はそのまま。
  - lock_timeout はファイルの編集ではなく session 設定。`auth.users` への FK が要求する SHARE ROW EXCLUSIVE ロックの待ちを 5 秒に制限し、Auth の書き込みを長く止めない。
- Stage B：新しい session で次を読み返す：
  - pinned catalog の 10 section：columns / constraints / indexes / relations / policies / triggers / table_acl（column SELECT 11 個だけ）/ functions 33 / function_acl（authenticated 2、service_role 10、それ以外 0）/ state（`shadow` / `not_started` / 1、built-in 3 行、行数 0 / 0 / 0）
  - 実効権限：API role の table・column・EXECUTE、owner、overload、RLS
  - 既存オブジェクトの指紋が、Stage A 直前から変わっていないこと
- Stage C：
  - `insert into supabase_migrations.schema_migrations (version, name) values ('20261001150000', 'common_account_lifecycle_foundation')` を、独立した transaction で 1 行だけ実行する。
  - statements は NULL（AI Lab の前例と同じ）。upsert / retry / repair はしない。
  - 書くのは Stage B が EXACT になった後だけ。

**失敗時の扱い**
- SQL は成功したが履歴の書き込みに失敗：STOP 14（schema あり / history なし）。自動の再試行はしない。review を経て `apply --resume-history` を使う（Stage B を再実行してから Stage C）。
- 応答を失った：Stage A は再実行しない。read-only で読み返して分類する（STOP 12）。
  - ABSENT：適用されていない。新しい試行には review が必要。
  - EXACT：review を経て `--resume-history`。
  - UNSAFE：STOP。
- lock 待ちが timeout した、または migration 自身が拒否した：rollback され、ABSENT / NONE を確認したうえで STOP 11。

**読み返しによる状態の判定**
- 未適用：`schema=ABSENT history=NONE`
- schema あり / history なし：`EXACT/NONE`
- history あり / schema が不正：`UNSAFE/EXACT` または `ABSENT/EXACT`（STOP 10）
- 完全に成功：`EXACT/EXACT` かつ既存オブジェクトの指紋が不変

### 承認パッケージ（Phase C / D、明示承認の後だけ）

- C0. fresh main で、G2（Edge deploy）・G3（PR81 apply）を含め、どのスロットも本番変更の window を開いていないことを確認する（G4 は 14:11 JST に CLOSED 済み）。
- C1. `bash supabase/tests/common_account_lifecycle_preflight/run.sh` を全 9 本実行し、14:27 JST の baseline と比べる。期待値：
  - 本番に変化が無ければ、9 本すべて同一（履歴 74 行、指紋 `db31ea2e…15dd`）。
  - 間に G3 の PR81 などが入っていれば、その変更に由来する差分だけを許容し、新しい値を適用前の baseline として記録する。
  - A3（不在）・A4（依存関係）・A5・A6（role / 既定権限）・A9（canary）に想定外の差分が 1 つでもあれば STOP。
- C2. PR #91 head `cab1f0fe` の clean checkout を用意し、migration の SHA を確認する。
- C3. operator のシェルで次を設定する：
  - `CAL_ROLLOUT_TARGET=production`
  - `CAL_ROLLOUT_ACK='apply 20261001150000_common_account_lifecycle_foundation to production after a same-day read-only preflight'`
  - `CAL_ROLLOUT_PROJECT_REF=wsmznyzcvmuitkglfeuj`
  - `CAL_EXPECTED_OWNER=postgres`
  - `PGHOST=<session pooler host>` `PGPORT=5432` `PGUSER=postgres.wsmznyzcvmuitkglfeuj` `PGDATABASE=postgres` `PGSSLMODE=require`（password は `~/.pgpass`）
  - そのうえで実行する：
    - `bash supabase/tests/common_account_lifecycle_rollout.sh status`：期待 `STATE schema=ABSENT history=NONE`
    - `bash supabase/tests/common_account_lifecycle_rollout.sh apply`：期待 `Stage B: existing objects unchanged`、`catalog read-back = EXACT`、`Stage C: history recorded`、`postflight: schema=EXACT history=EXACT`、`DONE`
- C4. STOP[n] が出たら手順書の表に従って止める。blind retry、手作業での ACL 修正、履歴の repair、自動 rollback はしない。
- D. 読み返し（read-only）：
  - `status` が `EXACT/EXACT`。
  - preflight bundle を再実行する：
    - A3 が反転し、12 / 12 / 33 / 10 / 2 がちょうど存在する。
    - A2 に `20261001150000 | common_account_lifecycle_foundation` が 1 行だけあり、ほかの履歴は変わらない。
    - A8 が C1 の値と一致する。
    - A5 の `auth.users` の内部 trigger が 28 から 30 になる。
  - 新しい RPC は書き込みを伴うため、試しに呼び出さない。
- 範囲外のまま：`backfill(false)` / `backfill(true)`、client の配線、削除経路の変更、enforce、Auth / Storage / OAuth / Vault、Edge deploy、Cron、flag、実 X。

### tests / checks

- `common_account_lifecycle_rollout.sh proof`（ローカル PG 17.11）：**143/143 PASS**。
  - 本番の `ensure_rls` に相当する event trigger のケースを含む。
  - Data API の既定権限は「全付与」と「付与なし」の両方。
  - lock timeout のケース：`auth.users` への書き込みを保持中に Stage A が 1 秒で諦め、何も残らない。
- runner への mutation 6/6 を、狙ったチェックで検出した：lock_timeout の除去、指紋比較の除去、履歴を検証より先に書く、overload 検出の除去、TLS ガードの除去、同名 / 別 version の履歴の見逃し。
- 指紋 SQL：実際の catalog 変更 14 種をすべて検出し、ローカル適用の前後で値が一致した。
- `common_account_lifecycle_run.sh` を fresh main で実行し 20/20 PASS。`migration_source_invariants_test.ts` 10 passed。`bash -n` / `git diff --check` clean。secret / PII スキャン 0 件。
- PR #91 の CI：Vercel が「Deployment rate limited — retry in 24 hours」で fail。これは基盤側の上限で、PR は `supabase/tests` しか変更していない。Netlify は Report 時点で pending。

### その他

- changed_files：
  - PR #91（`supabase/tests/common_account_lifecycle_rollout.sh` / `.md`、`supabase/tests/common_account_lifecycle_preflight/`（run.sh、.gitignore、sql 9 本））。
  - この Report（`.agent/tasks/CLAUDE_TASK_5.md` のみ）。
  - migration / 既存 source の変更は 0。
- commit_hash / push：
  - source `cab1f0fe` を branch に push し、PR #91 を open（未 merge）。
  - 着手マーカー `8aeef379` と、この Report を main に push。
- deploy：none。backfill：none。
- observations（止める理由ではない）：
  - Supabase CLI の linked mode は毎回 "Initialising login role..." を出し、CLI 用の login role `cli_login_postgres`（`postgres` の member、inherit=false）が存在する。G5 の SQL は何も書いていない。これは Phase 0 以来、どの read-only 実行でも同じ。
  - GoTrue の `auth.scim_users.user_id` の FK は削除時の動作が NO ACTION。将来の削除 orchestrator で、Auth の削除を妨げ得る。
- remaining_issues：
  - G4 の window が閉じるのを待ち、Phase A を再取得すること。
  - PR #91 を merge するかの判断（C2 は merge しなくても pinned commit から実行できる）。
  - runner に追加のレビューを付けるかの判断。
- safety_checks：
  - production write 0。migration / 履歴 / backfill / Auth / Storage / OAuth / Vault / deploy / Cron / flag / 実 X はすべて 0。
  - PII（token / JWT / email / user UUID / handle）の出力 0。Vault の値は読んでいない。
  - 他 slot のファイルには触れていない。G4 の window とは、読み取りのみで重なった。
- next_recommendation：
  - K5 で、このパッケージと PR #91 を確認する。
  - 承認する場合は、G4 の CLOSED と G2 の deploy の順序を決めたうえで、同じ G5 TASK を再承認する（C0 から開始）。
  - runner は既に承認された AI Lab runner の構造をそのまま流用しており、mutation でも検証済みなので、追加の Codex レビューは任意と考える。必要と判断するなら、H 枠で軽量なレビュー（Luna）。

---

# Previous G5 task history — preserved

# Claude Task 5 — CURRENT TASK

- task_id: common-account-pr70-guard-boundary-corrective-20261002
- owner: claude
- slot: claude-5
- status: done
- next_owner: none
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: corrective lifecycle authorization / migration security
- target_pr: #70
- target_head: eebe9405d758e0c120f9e6f1a70cdb1e973a0855
- production_mutation_allowed: false

## Purpose

PR #70の第2是正。

前回6 blockersは解消済みとして保持しつつ、H1再レビューで見つかった新規4 findings（7 adverse cases）を修正し、Phase 1の責任を**additive lifecycle foundation / readiness authorization**に限定したまま安全性を上げる。

重要：
- Phase 1は `auth.users` を削除しない。
- Phase 1はStorage / provider / session cleanupを完了したと主張しない。
- current Kabumori legacy hard-deleteを安全化済みと主張しない。
- common_accountsのcascade triggerを「唯一の正しさの砦」にしない。

## Mandatory startup

開始前に確認：

- PROJECT_RULES / HANDOFF / ORCHESTRATION
- CURRENT_STATE / ACTIVE_TASK
- G5 previous Report
- H1 corrective rereview full Report + Final C1
- G1〜G4 / H1 / H2 current TASK / Report
- open PR changed files
- fresh origin/main
- git status / worktree list
- G5独立worktree

Supabase taskなので、実装前にcurrent Supabase changelog/docsも確認すること。
特に：
- Auth user deletion / sessions
- Storage ownership / deletion API
- SECURITY DEFINER / RLS / Data API
- managed auth/storage schema behavior

training memoryだけで決めない。

## Accepted properties — preserve

以下は再び壊さない：

- no SQL Auth DELETE
- no Storage/Vault/provider destructive SQL
- Phase 1 stops at readiness for future managed orchestrator
- old six H1 blockers remain fixed
- additive schema
- profiles remain Kabumori-specific root
- brand_memberships remain X authorization/role
- no email-based account merge
- client arbitrary user/status write denied
- public table RLS
- least-privilege grants
- fixed search_path / schema qualification
- service start/delete serialization
- service-only delete preserves other service/Auth
- external provider work remains Saga
- G4 files untouched

## New correction A — remove correctness dependence on post-cascade blocker visibility

H1 F1 proved that a BEFORE DELETE trigger on `common_accounts` may run after other Auth FK CASCADE actions already removed `admin_users` / `brand_memberships`.

Therefore:

- Do not claim the common_accounts delete trigger can reliably rediscover every pre-delete blocker from tables that may already have cascaded.
- Do not fix by simply querying the same rows again inside that trigger.

Design a **durable pre-delete authorization / readiness token/state** that is established before the managed Auth delete actor starts, and invalidated whenever a relevant producer changes state.

Required properties:

1. Future managed orchestrator acquires authorization only after:
   - account deleting
   - all entitlements ended
   - no admin / foreign/shared/internal blocker
   - managed checkpoint requirements satisfied
   - managed ownership probe ready
   - lifecycle version / authorization epoch bound
2. The authorization must live in state not erased before the guard can validate it.
3. Auth delete guard may validate the durable authorization itself, but must not need already-cascaded admin/membership rows to reconstruct truth.
4. Any relevant producer/change must invalidate authorization or move account back to cleanup/not-ready.
5. If you cannot guarantee invalidation for a producer in Phase 1, enforce mode must remain unusable until integration wiring for that producer exists.
6. shadow must remain explicitly unsafe for legacy hard-delete.

Possible designs include a durable authorization row/epoch tied to lifecycle_version + requirement_version + subject/account, but choose based on proof, not this suggestion.

Do not add managed Auth deletion implementation.

## New correction B — readiness requirements must be versioned/invalidate ready state

H1 F2:

After an operation reached ready, these changes did not invalidate readiness:
- built-in checkpoint registry row removed
- new always-required checkpoint added
- Apple identity added without apple_revocation checkpoint

Required:

- registry/requirement changes must change a durable requirement/version epoch.
- readiness authorization binds to the exact requirement epoch.
- Apple identity/provider requirement changes must invalidate previous readiness.
- missing built-in requirement row = fail closed.
- a late Apple identity cannot reuse an old ready authorization.
- future new managed requirement cannot silently inherit old authorization.

Because auth.identities may be deleted/cascaded by managed Auth later, authorization must be validated **before** destructive managed delete starts, not reconstructed after cascades.

Add regressions for all three H1 cases.

## New correction C — validate built-in checkpoint semantics, not names only

H1 F3:

`session_revocation` / `storage_cleanup` names could be retained while requirement semantics were changed to apple-only.

Required exact semantics:

- session_revocation => always
- storage_cleanup => always
- apple_revocation => apple_identity
- built-ins cannot be silently weakened by normal owner maintenance
- corruption / missing / duplicate / unexpected incompatible built-in mapping => fail closed
- rollback must also require exact built-in semantics, not only key names

If mutable registry semantics are needed for future extensions, separate immutable built-in contract from extension rows.

Add semantic-corruption regressions.

## New correction D — entitlement ownership transfer must invalidate both accounts or be prohibited

H1 F4:

operator SQL transferring `service_entitlements.user_id` from A to B bumped only B.

Choose one safe contract:

### Preferred simple option
Make entitlement ownership transfer impossible after insert:
- user_id immutable by trigger/constraint/RPC contract
- service transfer requires end/delete old + insert new under lifecycle locks
- direct owner UPDATE changing user_id fails closed

OR, if transfer must exist:
- lock source and destination in deterministic order
- bump both lifecycle versions
- invalidate ready authorization for both
- test both stale confirmations

Do not leave source account version stale.

## Guard / enforcement contract

Clarify roles:

- `shadow`: observes/allows legacy delete; not safety.
- `enforce`: only usable after integration_state proves all relevant creators/deleters/invalidators are wired.
- guard validates a durable authorization/epoch prepared before managed delete.
- guard does not claim Storage/provider cleanup was independently proven by DB.
- provider/Storage cleanup still future orchestrator responsibility.

If full correctness of `enforce` cannot be established without Phase 2/3 wiring, it is acceptable — and preferable — for Phase 1 to make enforce **unreachable/disabled** and ship only shadow/readiness foundation. Truthful incompleteness is better than a misleading guard.

## Version/invalidation inventory

Create an explicit table in docs/tests of every state transition that must invalidate deletion readiness, including at least:

- service entitlement insert/update/delete
- account status/version changes
- admin membership/role changes
- self-service/foreign/shared X membership changes
- workspace ownership relevant to blockers
- Apple identity/provider requirement changes
- checkpoint requirement registry changes
- managed ownership/checkpoint reset
- backfill
- service provisioning
- future integration state transition

For each:
- who can write it
- whether Phase 1 currently intercepts it
- what invalidates readiness
- if not wired yet, why enforce remains disabled

This inventory is part of completion criteria.

## Preflight / rollback

Preserve prior exact FK preflight.

Add/adjust checks for new durable authorization / immutable built-in semantics.

Rollback must fail closed if:
- settings absent/corrupt
- built-in requirement semantics differ
- authorization/readiness rows exist that imply integration use
- integration started
- in-flight operation
- downstream dependency

No partial teardown.

## Required tests

Commit regressions for all new H1 findings.

At minimum:

1. late admin blocker before managed delete cannot be authorized by stale readiness.
2. late foreign/internal membership blocker cannot be authorized by stale readiness.
3. CASCADE ordering variation cannot make guard trust erased blockers.
4. built-in registry row removal invalidates/rejects readiness.
5. new always-required checkpoint invalidates old readiness.
6. late Apple identity without apple checkpoint invalidates old readiness.
7. built-in name with weakened semantic mapping fails closed.
8. rollback rejects semantic corruption.
9. entitlement user_id transfer either fails or invalidates both source/destination versions.
10. previous six H1 regressions still PASS.
11. original service start/delete/backfill races still PASS.
12. lifecycle mutation suite updated to detect new invalidation/authorization defects.
13. social-mobile account deletion regression unchanged.
14. migration invariants / shell syntax / diff check.

Prefer real 2-session PostgreSQL tests where concurrency is material.

Mutation suite must verify the intended invariant, not merely generic FAIL.

## Production safety

Forbidden:

- production migration/apply/backfill
- Auth create/update/delete
- Storage delete
- provider/OAuth revoke
- Vault mutation
- identity changes
- deploy
- Cron/flag/provider settings
- real X operation
- production enforce enablement

production read is not needed for this corrective source task unless separately authorized.

## PR / merge

Update PR #70 on the same source branch after fresh head ownership check.

- no force-push if avoidable
- Report exact old/new head
- PR remains merge HOLD until K5 + Codex rereview
- do not merge

## Completion / K5

Report:

- result
- old/new PR head
- architecture delta
- durable authorization / invalidation contract
- exact list of readiness invalidators
- guard/enforce truthfulness
- checkpoint semantic integrity
- entitlement transfer policy
- previous six blocker regression status
- new seven adverse-case regression status
- full test evidence
- changed_files
- production mutation=0
- remaining Phase 2/3 integration obligations
- rollout/rollback implications
- next recommendation

完了時：
- status -> review_required
- next_owner -> chatgpt
- STOP for K5

K5後はfocused Codex rereview。
推薦：**Sol（高）**。
production適用前：**Sol（極高）**。

## Report

- task_id: common-account-pr70-guard-boundary-corrective-20261002
- result: **PASS**（第2是正の source 候補・regression・mutation 証明まで完了。production 未適用。再レビュー待ち）
- old_pr_head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`
- new_pr_head: `47a2ed6a1635177ba82004eace4bddb42d9d53e3`（旧 head の上に 1 commit。rebase / force-push なし）
- PR: [#70](https://github.com/anohi-memories/kabumori/pull/70)（open、MERGEABLE、**merge HOLD**）。Report 時点の checks: passing 1 / pending 2 / failing 0。
- checked_main: 開始時 `93885aa`。Report push 直前に fresh `origin/main` を再確認。
- worktree / isolation: G5 専用 worktree。source は PR branch、Report は main 基点の control commit。push 前に remote PR head が `eebe940` のままであることを確認。他slotの worktree / branch / PR / TASK は未変更。open PR（#41 / #33 / #11 / #10 / #3）とのファイル重なりなし。main 側の変更（MIC phase3c）は PR のファイルと重ならない。
- push: source は PR branch へ fast-forward。この Report は `origin/main` へ fast-forward。
- deploy: none（prohibited）。
- production_mutation: **0**。production への接続（read 含む）も 0。

### startup で確認した Supabase docs / changelog（2026-10-02、公式文書の記述。挙動の実証ではない）

- Auth: 削除は `auth.admin.deleteUser()`。発行済み access token は期限まで有効、refresh token は使えなくなる。**Storage object を所有する user はこの API では削除できない**。`auth` schema の Supabase 管理 object は予告なく変わり得る。
- Storage: 所有は `owner_id`（token の `sub` 由来、`owner` は deprecated）。所有だけではアクセス制御にならない。**削除を含む全操作は Storage API 経由**（metadata 行だけ消すと実体が残る）。
- changelog: `auth` / `storage` schema への独自 table・function 作成は不可（2025-03-18）。`public` の新規 table は既定で Data API に公開されなくなる（2026-04-28、既存 project は 2026-10-30 まで）。候補は明示 grant だけに依存しており既定の公開に依存しないが、client が読む 2 table が到達可能かは適用時に確認が必要。
- これらを受けて、`auth.identities` や `storage.*` への trigger 追加は行っていない。

### architecture delta

1. **Phase 1 に enforcing guard は存在しない。** `common_accounts` の BEFORE DELETE trigger は観測のみ: `shadow` では全 delete を許可し、open な operation を `login_removed` として閉じ、raw id を消す。何も authorize しない。admin / membership / identity の行を一切見ない。settings が無い・`shadow` 以外なら全 login delete を拒否する。settings table は `shadow` 以外の値を受け付けない（CHECK）。静的チェックが「enforce を定義していない」ことを強制する。
2. **readiness は durable な authorization。** `prepare` が operation 行に `ready_lifecycle_version` / `ready_requirement_epoch` / `ready_required_checkpoints` を記録する。この table は login への FK を持たないため、cascade では消えない。
3. **requirement epoch を追加。** checkpoint 要件（registry）や settings が変わるたびに進む。
4. **built-in checkpoint を固定の contract に。** 意味まで厳密照合する。
5. **entitlement の所有者・service は不変。**
6. 既存 table への trigger 追加・既存 creator の配線は行っていない（integration phase の責務）。追加のみ、managed schema への書き込みなし、は維持。

### durable authorization / invalidation contract

- 取得: `prepare_common_account_auth_delete` のみ。`auth.users` 行の排他ロック、`common_accounts` のロック、settings 行の share ロックの下で、account `deleting` / 全 entitlement `ended` / admin・foreign・shared・internal の blocker なし / 登録のないサービスデータなし / settings あり / registry が contract と一致 / 必須 checkpoint 記録済み / managed ownership probe clean、を満たした時だけ。
- 有効性: `private.account_lifecycle_authorization_problems` が空。(a) 束縛した 3 値が現在値と一致、(b) 上記の再評価が今も通る、の両方。read model は `authorization.state` を `none` / `valid` / `stale`（理由付き）で返す。
- 検証者: Phase 1 では `prepare`（取得・更新）と read model。orchestrator は managed delete の直前に `prepare` を呼ぶ義務がある。**guard は検証もしないし authorize もしない。**
- 束縛した 3 値は durable な状態なので、将来の enforcing guard は cascade で消える行を見ずに比較できる。ただしそれが正しいのは、下表の全 producer が version か epoch を動かすよう配線された後だけ。

### exact list of readiness invalidators

| # | 遷移 | 書ける主体 | Phase 1 で捕捉 | readiness を無効化するもの |
| --- | --- | --- | --- | --- |
| 1 | entitlement の insert / update / delete | lifecycle RPC、backfill、operator SQL | **Yes**（trigger） | version が進み、operation が `cleanup` へ（`LIFECYCLE_VERSION_CHANGED`） |
| 2 | entitlement を別 person / service へ移す | operator SQL | **Yes**（拒否） | 起こり得ない |
| 3 | account の status / version 変更 | lifecycle RPC、operator SQL | **Yes**（trigger） | 同上 |
| 4 | service start / provisioning | client の start RPC | **Yes**（`deleting` 中は拒否。それ以外は 1） | — |
| 5 | backfill | operator | **Yes**（lifecycle lock。`active` 以外には付与しない） | — |
| 6 | checkpoint 要件の追加・変更・削除 | operator SQL | **Yes**（epoch が進む。built-in は不変） | 全 ready operation が `cleanup` へ（`REQUIREMENT_EPOCH_CHANGED`） |
| 7 | settings の変更（integration state）、行の削除・再作成 | operator、後続 migration | **Yes**（trigger） | epoch が進む / 再開。全 ready operation が `cleanup` へ |
| 8 | checkpoint の取り消し | orchestrator（RPC） | **Yes** | `cleanup` へ（`MANAGED_CHECKPOINT_CLEARED`） |
| 9 | admin membership の追加・削除 | service_role、operator | **No**（既存 table・未配線） | 再評価のみ: `ADMIN_ACCOUNT` |
| 10 | X workspace membership の変更（自分用 / foreign / shared） | X onboarding RPC、service_role、operator | **No** | 再評価のみ |
| 11 | blocker に関わる workspace 行（`brands` / `social_accounts` / OAuth state / X 削除 tombstone） | X connect RPC、X 削除 saga、operator | **No** | 再評価のみ |
| 12 | Kabumori profile の作成（`ensure_my_profile`） | sign-in 済みの任意の client | **No** | 再評価のみ |
| 13 | Apple identity の追加・削除 | GoTrue | **No**（managed schema） | 再評価のみ: `REQUIRED_CHECKPOINTS_CHANGED` |
| 14 | Storage object / bucket の所有 | 有効な token を持つ client（Storage API 経由） | **No**（managed schema、FK なし） | 再評価のみ: `MANAGED_OWNERSHIP_REMAINS` |
| 15 | login 行の削除 | 既存の退会経路、将来の orchestrator | guard trigger が観測 | operation を `login_removed` で閉じる |

「再評価のみ」= 保存された step は誰かが評価するまで `ready` のまま。`prepare` と read model が検出し、`prepare` が取り消す。9〜14 が version / epoch を動かさない以上、束縛値だけでは信頼できない。**これが Phase 1 に enforcing guard を置かない理由。** 全行に regression があり、6・9・absent preview には 2-session race もある。

### guard / enforce truthfulness

- `shadow` は安全化ではない。regression で「stale な readiness + ready 後の admin を持つ login が shadow で hard-delete される」ことを示し、Phase 1 はそれを `LOGIN_REMOVED_WHILE_READY_UNVERIFIED` と記録するだけ、と明示している。
- `enforce` は Phase 1 に存在しない（settings の CHECK、guard の実装、静的チェックの 3 箇所）。
- guard は blocker 行を見ないため、cascade の順序で答えが変わらない（両方の順序で regression）。
- guard が許可しても、Storage / provider cleanup について何も主張しない。
- 既存の Kabumori hard-delete は安全化されていない。

### checkpoint semantic integrity

- contract: `session_revocation` = always、`storage_cleanup` = always、`apple_revocation` = apple_identity。候補内の関数が正本で、registry 行はこれと完全一致が必要。
- trigger が built-in 行の変更・削除・改名・TRUNCATE を拒否（`ACCOUNT_LIFECYCLE_BUILTIN_CHECKPOINT_IMMUTABLE`）。
- trigger を迂回した破損（名前は残して意味だけ弱める、行が欠ける）でも、`prepare` は `MANAGED_CHECKPOINT_REGISTRY_INVALID`。
- rollback も意味まで照合する（contract を rollback ファイル自身に明記）。拡張行がある場合も拒否。
- 拡張行（新しい managed ownership）は追加できる。追加・削除は epoch を進め、既存の readiness を取り消す。

### entitlement transfer policy

所有者・service の変更は不可（BEFORE UPDATE trigger、`ACCOUNT_LIFECYCLE_ENTITLEMENT_OWNER_IMMUTABLE`）。service を移す場合は「こちらで終了 → あちらで開始」で、両 account の version が進む。拒否された transfer で両 account の version が変わらないことを regression で確認。

### previous six blocker regression status

6 件すべて PASS のまま（no Auth delete / absent preview / backfill serialization / admin exclusion / exact FK preflight / rollback の肯定条件）。対応する mutation も全検出。

### new seven adverse-case regression status

| H1 の adverse case | committed regression | 結果 |
| --- | --- | --- |
| F1 ready 後の admin が authorize される | read model が `stale [ADMIN_ACCOUNT]`、`prepare` が拒否して取り消し。race 13 / 14（両順） | PASS |
| F1 ready 後の foreign / internal membership | read model が `stale [X_WORKSPACE_NOT_SELF_SERVICE]`、`prepare` が拒否 | PASS |
| F1 cascade 順序 | test 用 probe で「cascade 内で admin 行が見える / 見えない」の両順を作り、guard の答えが同じことを確認 | PASS |
| F2 built-in registry 行の削除 | 通常保守では拒否。trigger 迂回時は `REGISTRY_INVALID` | PASS |
| F2 新しい always 必須 checkpoint | epoch +1、既存 readiness を即時取り消し。race 11 / 12（両順） | PASS |
| F2 ready 後の Apple identity | `stale [REQUIRED_CHECKPOINTS_CHANGED, MANAGED_CHECKPOINTS_MISSING]`、`prepare` は `apple_revocation` を要求 | PASS |
| F3 built-in 名で意味だけ弱める | checkpoint 未記録・非 Apple の user が ready にならない。rollback も拒否 | PASS |
| F4 entitlement の所有者移転 | 拒否。両 version 不変 | PASS |

### full test evidence

すべて使い捨てローカル PostgreSQL 17.11（Unix socket、偽データのみ、非 superuser owner）。commit 済みの tree で実行。

`supabase/tests/common_account_lifecycle_run.sh` — **20 項目 PASS**

1. exact preflight（8 種の不一致を拒否）
2. 追加のみの適用（適用前の schema dump の全行が残る）＋ 再適用の拒否
3. 静的チェック（`auth` / `storage` / `vault` への書き込みなし、enforcing guard mode なし、email を読まない、既存 object の変更なし）
4. 挙動（11 section。backfill、ACL / RLS、start、ready までの全体削除、service-only 削除、fail closed、managed ownership と checkpoint contract、guard、authorization と invalidator、cascade 順序、entitlement の不変性）
5. 2 セッション競合 14 種（前回の 12 種のうち guard 境界の 2 種を、要件変更 × prepare の両順と、late admin × prepare の両順に置き換え）
6. isolation guard、deadlock なし
7. rollback: 拒否 10 種の後、適用前と byte 一致で復元、再適用可

`supabase/tests/common_account_lifecycle_mutations.sh` — **45/45 検出**

- 各 mutation は「検出されるべき具体的な失敗メッセージ」を指定する。H1 が指摘した汎用 `FAIL` の matcher（login 行ロックの除去）は `FAIL race8 start`（deadlock）に固定した。
- 新規の対象: guard が拒否しない / enforcing mode の定義 / account 変更・要件変更・epoch 変更が readiness を取り消さない / version・epoch・必須集合への束縛を検査しない / prepare が束縛を記録しない / prepare が要件変更と直列化しない / checkpoint 取り消しが readiness を残す / built-in を保守で変更できる / registry を名前だけで検証 / rollback が弱めた意味を受理 / rollback が完了済み operation を無視 / entitlement を移転できる、ほか。
- 実ファイルは変更しない（実行後に tree clean を確認）。

既存スイート: `social_mobile_account_deletion_run.sh` 8 項目 PASS（変更なし）、`migration_source_invariants_test.ts` 10 passed、`bash -n` OK、`git diff --check` clean。

テスト作成中の事実: 挙動テストと runner は初回から通ったため、mutation で検証した。mutation は初回 43/45 が想定どおり、2 件は「想定と別のチェック」で検出されたため、想定を実際の検出箇所に固定した（未検出はなし）。静的チェックが新しい `TRUNCATE` trigger の定義を誤検出したため、文としての `drop` / `truncate` だけを見るよう直した。

未実施: 実 Supabase（GoTrue / PostgREST / Storage / `supabase_auth_admin`）での検証。

### changed_files（`eebe940` → `47a2ed6`、6 files、+1284 / −506）

- `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`
- `supabase/tests/common_account_lifecycle_behavior.sql`
- `supabase/tests/common_account_lifecycle_run.sh`
- `supabase/tests/common_account_lifecycle_mutations.sh`
- `supabase/tests/common_account_lifecycle_rollback.sql`
- `docs/common-account/phase1-lifecycle-foundation.md`

client / Edge Function / 既存 migration / 既存 RLS / 既存 table への trigger の変更は 0。関数は 21 → 33、RPC は `clear_common_account_deletion_checkpoint` を 1 つ追加。

### remaining Phase 2/3 integration obligations

- inventory の 9〜12 を配線する（writer が lifecycle を呼ぶ、または既存 table に trigger）。13〜14 は orchestrator / Auth 側の配線と stale-token 方針。
- 既存 creator（`ensure_my_profile`、`begin_social_mobile_x_oauth_connection`）を lifecycle の下に入れる。
- 既存の削除経路（Kabumori `account-delete`、X saga の scope 判定と自前の login 削除）を lifecycle へ移す。
- orchestrator: 直近再認証、session revoke、Apple revoke、X revoke + Vault purge、Storage API cleanup と再列挙、直前の `prepare`、Auth Admin API による削除、削除後の read-back / audit。
- 全 login の `common_accounts` への登録（backfill）。
- 上記が揃ってから、別 migration で enforcing guard を追加する。束縛 3 値の比較を使う。
- 実 Supabase の使い捨て project での証明。

### remaining unknowns

- production schema が exact preflight を通るか（今回 production read は行っていない）。
- production で function owner が `storage.objects` / `storage.buckets` を読めるか（読めなければ `MANAGED_STORAGE_PROBE_FAILED` で not ready）。
- Data API の既定公開の変更（2026-10-30 期限）が、client が読む 2 table にどう効くか。
- cascade 順序の regression は trigger 名の順序に依存する。名前の並びが変わらない稀な場合は 1 順序のみの検証になる（その場合もテストは誤って失敗しないようにしてある）。

### rollout / rollback implications

- 適用順: 再レビュー → production 適用前の別レビュー → production catalog の read-only 照合 → 単一ファイル適用（`db push` 不可）→ backfill dry-run 照合 → backfill → integration → 削除経路の移行と orchestrator → その後に enforcing guard の追加。
- Phase 1 を適用しても、既存の退会経路の挙動は変わらない。安全にもならない。
- rollback は integration 開始前、かつ lifecycle が一度も使われていない状態（operation 行なし、registry が built-in のみ）でだけ可能。1 transaction で、部分的な取り壊しはない。

- remaining_issues: 上記 obligations と unknowns。
- safety_checks: production mutation 0、production 接続 0。`auth.users` 削除 / Auth Admin API / Storage 削除 / OAuth revoke / Vault 操作 / identity 変更 / deploy / flag・Cron 変更 / production の enforce 有効化 0。既存 table / policy / grant / function の変更 0（schema dump 比較で証明）。旧 PR head は merge していない。他slotの TASK / branch / PR 未変更。secret / PII を source・test・Report に含めていない。
- next_recommendation: K5 の後、PR #70（head `47a2ed6`）の focused 再レビューを H1 / H2 の空き枠へ。推薦 Sol（高）。重点: guard が何も authorize しないこと、束縛 3 値と invalidator inventory の網羅性、built-in contract、rollback の肯定条件。production 適用前は Sol（極高）。

---

## Previous completed G5 task history — preserved below

# Claude Task 5 — CURRENT TASK

- task_id: common-account-pr70-corrective-lifecycle-foundation-20261001
- owner: claude
- slot: claude-5
- status: done
- next_owner: none
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: corrective architecture / migration / lifecycle security
- target_pr: #70
- target_original_head: 89cf128bd9219897806b2b641cce4866f6e16c52
- production_mutation_allowed: false

## Purpose

H1/C1でFAILとなったPR #70を、**共通アカウントv1 Phase 1の安全なadditive foundation**へ修正する。

重要な方針変更：

**Phase 1ではSupabase Auth userの実削除を完了させない。**

このPhaseの責任は、
- common account state
- service entitlement
- service start/stop serialization
- whole-account deletion intent / durable Saga state
- shadow backfill
- least-privilege ACL/RLS
- future common orchestratorが安全に使うためのDB contract

まで。

実際のmanaged Auth destruction（GoTrue/Admin API、Storage、sessions/identities、Apple/provider revoke等）は、後続の共通account deletion orchestrator Phaseで実装・検証する。

PR #70を同じbranch/PR上で修正してよいが、fresh head/ownership/競合確認必須。

## Mandatory startup / isolation

- PROJECT_RULES / HANDOFF / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK
- G5 prior Phase 1 Report
- H1 PR #70 review full Report + Final C1
- G1〜G4 / H1 / H2 fresh status
- open PR changed files
- git status / worktree list / fresh origin/main
- G5独立worktree

G4 PR #65 filesは触らない。
他slot/branch未コミット変更は触らない。

## Required corrections

### 1. Remove managed Auth destruction from Phase 1

Current candidateの `finalize_common_account_deletion` が直接 `DELETE FROM auth.users` して「completed」を返す設計は廃止する。

Phase 1では例えば：

```text
started
→ service cleanup checkpoints
→ ready_for_managed_auth_delete
```

まで。

DB側finalize/prepareは：
- lifecycle stateをlock下で再検証
- entitlement/service footprintを検査
- managed cleanupが未完ならfail closed
- **auth.usersを削除しない**
- 「外部orchestratorが次に何をすべきか」を非secretな状態で返す

とする。

名前は設計に合わせて変更可。
「finalize」という名前が実削除完了を誤解させるならrenameする。

Phase 1 Report/docs/testsから「Auth削除完了」「Storage FKで止まる」等の過剰な保証を削除する。

### 2. Managed ownership / Storage boundary

H1 finding:
- Storage ownershipはauth.users FKで守られていない。
- SQL Auth DELETEだけではowned object metadata/実体のcleanupを保証できない。

Phase 1では：
- StorageをSQL DELETEしない
- Storage cleanupを実装しない
- actual managed Auth deleteをしない
- future orchestrator prerequisiteとして、Storage/API cleanup + revalidation + retry/idempotencyをcontractへ明記
- unknown managed-service ownershipはwhole-account delete readinessでfail closedに扱える拡張点を設計

将来のorchestratorが必要なチェックポイントをoperation stateへ持たせる場合、Phase 1で安全なschemaだけ追加可。

### 3. Fix stale preview / absent-account lifecycle version

H1 findingをregression test化。

必須：
- account rowが存在しないpreviewと、その後のbackfill/service introductionで同じversionが有効のままにならない
- absent stateにも明確なepoch/nonce/version semantics
- entitlementを導入する全pathでconfirmation bindingがinvalidになる
- old preview/versionでbegin deletionできない

### 4. Serialize backfill against lifecycle state

backfillはsnapshotだけでactive判定しない。

必須：
- auth.users → common_accounts の既定lock orderを守る
- lock取得後にstatus/version/eligibility再検証
- locked/deleting等へentitlementを付与しない
- concurrent state transitionとの2-session race test
- backfillによるentitlement追加時にlifecycle/preview versionを確実にinvalidate

offline/quiescent前提に依存するならDB contractで強制し、単なる運用メモにしない。

### 5. Exclude admin from X consumer backfill

`admin_users` とself-service workspace ownerの交差ケースを明示除外。

- adminはconsumer x_autopost entitlement対象外
- Kabumori entitlementは別ルール
- mixed-role regression testを追加

### 6. Exact FK preflight

tableに「何かAuth FKがある」だけでは不可。

最低限、invariantに使うFKごとに：
- referencing table
- exact referencing column(s)
- referenced schema/table
- exact referenced column(s)
- type compatibility
- delete action
- constraint validity
- 必要ならdeferrability/timing

を照合。

H1のwrong-column FK counterexampleをcommitted regressionにする。

### 7. Rollback requires affirmative safe shadow state

settings row absenceを「rollback可」にしない。

rollback前提：
- settings rowが存在
- modeがvalid shadow
- in-flight lifecycle operationなし
- downstream dependencyなし
- integration/enforcement未開始

missing / corrupt / enforce はfail closed。

H1のmissing-settings counterexampleをregression test化。

### 8. Guard semantics

Phase 1 guardは、current production hard-deleteを安全化済みと主張しない。

shadow defaultで既存挙動不変でもよいが、docsで明示する。

enforce modeは後続integrationが揃うまで有効化禁止。

実Auth deleteをPhase 1から削除することで、guardは：
- legacy/direct hard delete protection
- future orchestrator authorization boundary
のfoundationとして再設計してよい。

ただし「authorized」判定だけでStorage/provider cleanupまで保証したと扱わない。

### 9. Session / recent-auth / provider cleanup

H1 prior findingsのP2 recent reauthenticationはPhase 1 DB-onlyでは解決しない。

明確にfuture orchestrator/client integration prerequisiteとして残す：
- recent reauth
- session revoke / stale JWT policy
- Apple revoke
- X posting authorization revoke
- Vault purge
- Storage API cleanup
- managed Auth Admin API delete
- post-delete read-back/audit/retry

### 10. Preserve accepted good properties

壊さない：
- additive schema
- profilesはKabumori root
- brand_membershipsはX role/ownership
- emailでaccount mergeしない
- client arbitrary user/status write不可
- public table RLS
- least privilege grants
- fixed search_path / schema qualification
- service start vs deletion serialization
- service-only deletion leaves other service/Auth untouched
- external provider work is Saga, not fake transaction
- G4 files untouched

## Required tests

H1の6 counterexampleを**全てcommitted regression test**にする。

最低限：
1. no SQL Auth DELETE / no false completed state
2. Storage-owned-state scenario cannot be reported as account deletion completed by Phase 1
3. absent preview -> backfill adds entitlement -> old confirmation rejected
4. concurrent locked transition vs backfill -> entitlement not granted
5. admin + self-service workspace -> x entitlement not granted
6. wrong-column FK -> preflight rejects
7. missing settings row -> rollback rejects
8. original two-session provisioning/delete races remain safe
9. rollback/reapply on valid shadow remains safe
10. ACL/RLS/SECURITY DEFINER invariants
11. mutation/defect-detection tests updated for new contract
12. existing social-mobile deletion regression
13. git diff --check / source invariants

可能ならPostgreSQL 2-session race proofを継続。

実Supabaseへのwrite/deleteはしない。

## PR / delivery

PR #70を更新する。
- old headを勝手にmergeしない
- new exact headをReport
- changed filesを明記
- architecture deltaを明記
- PR remains merge HOLD until K5 + Codex rereview

## Production safety

禁止：
- production migration/apply/backfill
- auth.users delete
- Auth Admin API delete
- Storage delete
- OAuth revoke
- Vault mutation
- identity link/unlink
- deploy
- RLS enforcement production change
- feature flag/Cron/provider setting
- real X operation

production readも原則不要。必要ならK5で別途判断。

## Completion / K5

Report：
- result
- exact old/new PR head
- architectural correction summary
- no-Auth-delete proof
- lifecycle/version/backfill serialization
- exact preflight
- rollback fail-closed
- ACL/RLS
- six H1 regression results
- full test evidence
- changed_files
- production mutation=0
- remaining managed-service/orchestrator prerequisites
- rollout/rollback implications
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP。

K5後は、同じPRの再レビューをH1/H2の空き枠へ入れる。
推薦レビュー：**Sol（高）**。
production適用前：**Sol（極高）**。

## Report

- task_id: common-account-pr70-corrective-lifecycle-foundation-20261001
- result: **PASS**（是正 source 候補・regression・mutation 証明まで完了。production 未適用。再レビュー待ち）
- old_pr_head: `89cf128bd9219897806b2b641cce4866f6e16c52`
- new_pr_head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`（旧 head の上に 1 commit。rebase / force-push なし）
- PR: [#70](https://github.com/anohi-memories/kabumori/pull/70)（open、MERGEABLE、**merge HOLD**）。Report 時点の checks: passing 2 / pending 3 / failing 0。
- checked_main: 開始時 `8ca101e`。Report push 直前に fresh `origin/main` を再確認。
- worktree / isolation: G5 専用 worktree。source は PR branch `claude/g5-common-account-phase1-20261001`、Report は main 基点の control commit。push 前に remote PR head が `89cf128` のままであることを確認。他slotの worktree / branch / PR / TASK は未変更。G4 PR #65 のファイルは未変更。
- push: source は PR branch へ fast-forward。この Report は `origin/main` へ fast-forward。
- deploy: none（prohibited）。
- production_mutation: **0**。production への接続（read 含む）も 0。

### architectural correction summary

**Phase 1 は Supabase Auth user を削除しない。**

- 旧: `finalize_common_account_deletion` が SQL で `auth.users` を削除し `completed` を返す。
- 新: `prepare_common_account_auth_delete` が lock 下で再検証し、operation を `ready_for_managed_auth_delete` へ進めるだけ。`login_deleted: false` と、orchestrator が次にすべきこと（`next_steps`、非secret）を返す。再呼び出しで再評価し、状態が崩れていれば `cleanup` へ戻す。
- Phase 1 の責任範囲: account state / service entitlement / start・stop の直列化 / 全体削除の durable intent と saga checkpoint / shadow backfill / 最小権限 ACL・RLS / 将来の orchestrator 向け DB contract。
- 実削除（Auth Admin API、Storage API cleanup、session・identity、Apple / X revoke、read-back）は後続 orchestrator の責務として設計ノートに明記。
- 前回 Report の「Storage 等の FK で阻まれた場合は停止する」という記述は誤りだった（Storage 所有は Auth への FK で守られていない）。当該の保証は Report / docs / tests から削除した。

### no-Auth-delete proof

- candidate に `auth` / `storage` / `vault` schema への `delete` / `update` / `insert` / `truncate` は 1文もない。runner の静的チェック（`COMMON_ACCOUNT_STATIC_NO_MANAGED_DELETE_PASS`）が強制する。candidate が削除する既存 table は Kabumori 自身の退会で消す `public.profiles` の1行だけ。
- account deletion に `completed` という状態が schema に存在しない（CHECK 制約。直接 UPDATE しても違反になることをテスト）。
- 挙動テスト: ready 到達後も login・account 行は存在し、operation は `in_progress` のまま。
- mutation「prepare が login を削除する」「account deletion を completed にできる」はどちらも検出される。
- テスト中の `delete from auth.users` は、login を消す主体（今の legacy 経路、将来の orchestrator）の**代役としてテストが実行**しているもの。candidate のコードではない。

### managed ownership / Storage boundary

- Storage を SQL で削除しない。Storage cleanup を実装しない。
- `private.account_lifecycle_managed_checkpoints`（registry）を追加。`storage_cleanup` / `session_revocation` は常に必須、`apple_revocation` は Apple identity がある場合に必須。`prepare` は全て記録されるまで ready にしない。checkpoint は orchestrator の申告であり、DB が検証したものではない。
- 加えて `storage.objects` / `storage.buckets` を read-only で probe する。DB から所有が見える間は、checkpoint 記録済みでも `MANAGED_OWNERSHIP_REMAINS`。これは拒否の理由であり、不在の証明ではない（直後に upload され得る）。
- Storage の shape が想定と違えば `MANAGED_STORAGE_SHAPE_UNKNOWN`（fail closed）。
- 拡張点: 新しい managed ownership は registry に1行足す。以後、orchestrator が申告するまで全削除が fail closed。built-in 行が欠けた registry も not ready。

### lifecycle / version / backfill serialization

- `lifecycle_version` は **trigger** で動く（account の state 変更、entitlement の insert / update / delete）。RPC・backfill・operator の SQL のどれが書いても動く。減少は拒否。
- `0` = account 行なし。どの行にも一致しない。version `1` = 「entitlement も state 変更も一度もない行」。
- `begin(0)` は行が存在しない時だけ有効。作成した行が「fresh（version 1・active・entitlement なし）」でなければ `lifecycle_changed`。
- backfill（apply）は login ごとに id 順で lifecycle lock（`auth.users` → `common_accounts`）を取り、**lock 取得後に** その login の plan 行を読み直してから insert する。`active` でない account には付与しない。READ COMMITTED 以外では例外。
- 既存の直列化（start と削除、判断途中、hard delete との lock order）は維持。

### exact preflight

1 transaction。次を照合し、不一致なら何も作らず中断する。

- 必要 schema / role / table（`storage.objects` / `storage.buckets` を含む 17 table）
- invariant が読む列 26 個の存在と**型**
- invariant が依存する FK 14 本それぞれについて: 参照元 table と**列**、参照先 table と**列**、列の型一致、delete action、validated、非 deferrable
- `profiles` を参照する FK に CASCADE でないものがない
- 再利用する helper 2関数の signature と戻り型
- 二重適用でない

### rollback fail-closed

rollback は「肯定的に確認できた shadow 状態」からのみ実行される。

- settings 行がちょうど 1 行、guard `shadow`、integration `not_started`（**行が無い場合は拒否**）
- built-in checkpoint 3 行が揃っている
- in-flight operation なし、`active` でない account なし
- self-service で登録された entitlement なし（client が start RPC を使い始めている）
- 依存 object なし（全 DROP が CASCADE なし）

### guard semantics

- `shadow`（導入時の既定）: 全 delete を許可。既存経路の挙動は不変。**安全化はしていない。**
- `enforce`: account が `deleting`、ready operation あり、全 entitlement `ended`、blocker なし、managed ownership probe が clean、の全てを delete の瞬間（`auth.users` 行を保持した削除 transaction 内）に再評価して満たす場合だけ許可。
- `enforce` は `integration_state = 'not_started'` の間は設定できない（table 制約）。
- 許可は「DB から見える状態が clean」という意味だけ。Storage / provider cleanup の保証ではない。
- 許可された削除でも記録するのは `login_removed`（観測）であり、`completed` ではない。

### ACL / RLS

- 新 table 5 つすべて RLS enabled。`public` の 2 table は self-SELECT policy 1 本ずつ。
- table 権限は全 role から revoke。authenticated は列限定 SELECT のみ。service_role は table 権限なし。
- 関数 21 個すべて SECURITY DEFINER / `search_path = ''` / PUBLIC・anon の EXECUTE なし。RPC ごとに 1 role へ grant。
- client は任意の user / status を書けない。start RPC は引数なし。

### six H1 regression results

| # | H1 counterexample | committed regression | 結果 |
| --- | --- | --- | --- |
| 1 | Auth DELETE が Storage 所有を残して completed | 静的チェック（managed schema への書き込みなし）＋ `completed` 不可の制約 ＋ Storage 所有が見える間は ready にならない（checkpoint 記録済みでも）＋ ready 後も login が存在 | PASS |
| 2 | absent preview が backfill 後も有効 | absent preview（0）→ profile 追加 → backfill → `begin(0)` と `begin(1)` がどちらも `lifecycle_changed`、operation なし | PASS |
| 3 | 同時の lock 遷移後に backfill が付与 | race 9: hold 未commit → backfill は待ち、付与しない。race 10: backfill が一時停止中 → hold が lock 待ちになることを `pg_stat_activity` で確認 | PASS |
| 4 | admin + self-service workspace に X entitlement | admin かつ self-service workspace 単独 owner かつ Kabumori 利用者 → X なし、Kabumori あり、`x_autopost_excluded_admin = 1` | PASS |
| 5 | 無関係な列の FK を preflight が受理 | `brand_memberships.user_id` の FK を外し、別列に Auth FK を付ける → `COMMON_ACCOUNT_PREFLIGHT_FK_MISMATCH` で拒否、何も作られない | PASS |
| 6 | settings 行なしで rollback が guard を外す | settings 行を削除 → rollback は `…SETTINGS_NOT_AFFIRMED` で拒否、guard は残る | PASS |

### full test evidence

すべて使い捨てローカル PostgreSQL 17.11（Unix socket、偽データのみ、非 superuser owner）。commit 済みの tree で実行。

`supabase/tests/common_account_lifecycle_run.sh` — **19 項目 PASS**

1. exact preflight（8 種の不一致を拒否: 列なし / 型違い / 別列の FK / delete action 違い / deferrable / 未 validate / cascade しない子 table / helper の signature 違い）
2. 追加のみの適用（適用前の schema dump の全行が残る）＋ 再適用の拒否
3. 静的チェック（managed schema への書き込みなし、email を読まない、既存 object の変更なし、既存 object への grant / revoke なし）
4. 挙動（backfill、ACL / RLS、start、ready までの全体削除、service-only 削除、fail closed、managed ownership、guard 2 モード）
5. 2 セッション競合 12 種: start→delete（account 不在の preview を含む）/ delete→start / ready→creator（legacy creator は Phase 1 では止まらないが、次の prepare で `cleanup` に戻る）/ creator→ready / 二重 delete / 二重 start / 判断途中 / hard delete との lock order / lock→backfill / backfill→lock / guard 境界の両順（orphans=0）
6. isolation guard（RPC と backfill）、deadlock なし
7. rollback: 拒否 8 種の後、適用前と byte 一致で復元、再適用可

`supabase/tests/common_account_lifecycle_mutations.sh` — **29/29 検出**

- candidate または rollback の copy に欠陥を 1 つ入れ、runner が**想定したチェックで**失敗することを要求する。実ファイルは変更しない（実行後に tree clean を確認）。
- H1 の指摘で「10 種が独立に再現されていない」とされたため、script として commit した。
- 初回は 4 種が「想定と別のチェック」で検出された。想定を実際の検出箇所に合わせ、rollback の mutation は H1 が示した元の欠陥そのものに差し替えた。

既存スイート: `social_mobile_account_deletion_run.sh` 8 項目 PASS、`migration_source_invariants_test.ts` 10 passed、`bash -n` OK、`git diff --check` clean。

未実施: 実 Supabase（GoTrue / PostgREST / Storage / `supabase_auth_admin`）での検証。ローカル PostgreSQL はその証明にならない。

### changed_files（旧 head → 新 head、7 files、+1535 / −582）

- `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql` — 是正の本体
- `supabase/tests/common_account_lifecycle_behavior.sql` — 新 contract と H1 regression
- `supabase/tests/common_account_lifecycle_run.sh` — exact preflight / 静的チェック / race 追加 / rollback 拒否
- `supabase/tests/common_account_lifecycle_mutations.sh` — **新規**。mutation 証明
- `supabase/tests/common_account_lifecycle_rollback.sql` — 肯定的 shadow 状態の要求
- `supabase/tests/common_account_lifecycle_fixture.sql` — production 形の Storage stub を追加
- `docs/common-account/phase1-lifecycle-foundation.md` — 全面改訂

client / Edge Function / 既存 migration / 既存 RLS の変更は 0。

### remaining managed-service / orchestrator prerequisites（Phase 1 では未解決）

- 直近再認証（server 側で強制）
- session revoke と stale JWT の方針（login を消しても発行済み token は失効しない）
- Apple revoke
- X posting authorization の revoke と Vault purge（既存 X saga を begin / finish で包む）
- Storage API による cleanup、空になるまでの再列挙、retry / 冪等性
- 削除直前の再検証（`prepare` の再呼び出しと Storage の再列挙）
- managed Auth Admin API による削除（SQL ではなく）
- 削除後の read-back / audit / retry。account deletion を「完了」と記録できるのはこの step だけで、そのための schema 追加が別途必要
- 実 Supabase の使い捨て project での Auth / Storage / session / role 境界の証明

### remaining unknowns

- production で function owner が `storage.objects` / `storage.buckets` を SELECT できるか（できなければ `prepare` は例外で fail closed）。
- production schema が exact preflight を通るか（read-only の catalog 照合が必要。今回 production read は行っていない）。
- shadow 期間中、既存 creator は lifecycle を通らない。ready 後にサービスデータが作られ得る。次の `prepare` は拒否するが、shadow では login 削除自体は止まらない。
- backfill（apply）は訪問した login の lock を commit まで保持する。現状の人数では問題ないが、人数が多い場合は静かな時間帯に実行する必要がある。

### rollout / rollback implications

- 適用前: この是正版の再レビュー、production 適用前の別レビュー、実 Supabase での証明、exact preflight が依存する catalog の read-only 照合。
- 適用順は変わらず: 単一ファイル適用（`db push` 不可）→ backfill dry-run 照合 → backfill → integration（`integration_state = 'started'`）→ 削除経路の移行と orchestrator → その後に `enforce`。
- rollback は integration 開始前だけ。開始後は拒否する。
- **既存 Kabumori `account-delete` はこの候補では安全にならない。** shadow では経路・挙動とも不変。

- remaining_issues: 上記 prerequisites と unknowns。
- safety_checks: production mutation 0、production 接続 0。`auth.users` 削除 / Auth Admin API / Storage 削除 / OAuth revoke / Vault 操作 / identity 変更 / deploy / flag・Cron 変更 0。既存 table / policy / grant / function の変更 0（schema dump 比較で証明）。旧 PR head は merge していない。G4 ファイル未変更。他slotの TASK / branch / PR 未変更。secret / PII を source・test・Report に含めていない。
- next_recommendation: K5 の後、同じ PR #70（head `eebe940`）の再レビューを H1 / H2 の空き枠へ。推薦 Sol（高）。重点: no-Auth-delete の境界、version trigger と absent preview、backfill の lock、exact preflight、rollback の肯定条件、guard の enforce 条件。production 適用前は Sol（極高）。

---

## Previous completed G5 task history — preserved below

# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase1-additive-lifecycle-foundation-20261001
- owner: claude
- slot: claude-5
- status: done
- next_owner: none
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: architecture + additive schema/lifecycle foundation source candidate
- production_mutation_allowed: false

## Purpose

共通アカウントv1 Phase 1として、Phase 0 inventoryとH1/C1の削除境界レビューを踏まえ、**additiveでrollback可能な共通アカウント / service entitlement / lifecycle serialization基盤のsource候補**を作る。

このTASKはsource・migration candidate・disposable testまで。
**production migration apply / backfill / deploy / RLS enforcement / real Auth deletionは禁止。**

中心設計：

```text
auth.users.id
= 共通本人ID

common_accounts
= 共通アカウントapplication state

service_entitlements
= service利用登録

public.profiles
= Kabumori固有rootのまま

brand_memberships
= X workspace authorization / roleのまま
```

各アプリの新規登録は将来：

```text
共通アカウント作成 / 既存共通アカウント認証
+
そのアプリのservice entitlement作成
```

Kabumoriから初回登録 → common account + kabumori entitlement。
X自動投稿から初回登録 → common account + x_autopost entitlement。
既存common accountが別serviceへ来た場合 → 本人認証後、そのservice entitlementだけ作る。

## H1/C1 accepted safety constraint

既存Kabumori account-deleteは、事前readだけを追加しても安全にならない。

理由：

1. Kabumori側が「X footprintなし」をread
2. 並行してauthenticated userがX workspace/membership/OAuth stateを作成
3. Kabumoriが別requestでAuth hard delete
4. membership/stateだけcascadeし、workspace/social account/authorization/Vault等が残り得る

したがってPhase 1では、削除/利用開始を直列化できる**明示的なlifecycle state / lock / durable deletion intent**を設計対象に含める。

「最後にもう一度SELECTする」だけの修正は禁止。
既存X deletion acquisitionをKabumoriへそのまま流用するのも禁止。

## Mandatory startup / isolation

開始前に必ず確認：

- PROJECT_RULES.md
- HANDOFF.md
- .agent/ORCHESTRATION.md
- .agent/CURRENT_STATE.md
- .agent/ACTIVE_TASK.md
- このG5 TASK
- G1〜G4 / H1 / H2 TASK + Report
- git status
- git worktree list
- fresh origin/main
- open PR changed files

G5専用の独立worktree / checkoutを使用。

### Competition state at assignment

- G3: account deletion UI fixはFinal K3 PASS・PR #68 merge済み。runtime deletion backendは変更していない。
- G4: PR #65 X posting OAuth account-switch。source/securityはaccepted済みだが、provider-side operator E2E待ち。G4の5ファイルは触らない。
- H1: deletion safety reviewはC1で閉じる。runtime candidateなし。
- G1/G2: Kabumori Home / report系。Auth/lifecycle scopeと競合しないことをfresh確認する。
- H2: fresh statusを確認。

競合/ownership不明ならSTOP。

## Phase 1 scope

### A. Additive schema candidate

新規migration candidateとして最低限：

1. `common_accounts`
2. `service_entitlements`
3. lifecycle / deletion serialization primitive

候補例：

```text
common_accounts
  user_id PK/FK auth.users
  status active/deleting/locked
  lifecycle_version
  timestamps

service_entitlements
  user_id
  service_key
  status provisioning/active/suspended/deleting/ended
  source
  activated_at
  ended_at
  timestamps
  PK(user_id, service_key)

account_lifecycle_operations
  id
  user_id
  operation_type
  status
  current_step
  started_at
  updated_at
  last_error_code
```

名前・列はレビューの上で調整してよい。

重要：

- additiveのみ
- existing table rename/drop禁止
- profiles / brand_memberships置換禁止
- migration historyの不整合を前提に、単一migration candidate + exact preflightを設計
- production db push禁止

### B. Lifecycle serialization contract

次を同時に満たす設計を作る：

- service利用開始中はcommon account whole-deleteと競合しても片方がfail closed
- common account deleting中は新規service entitlement/provisioningを開始できない
- service-only deletionは他service/Authを残す
- common account deletionは全active service cleanup完了後のみAuth hard delete可
- admin/shared/unknown状態はfail closed
- stale/retry/idempotencyを考慮
- external OAuth revoke/Vault purge等はSaga stepとして扱い、DB transactionで全外部処理を原子的に扱ったふりをしない

必要なら advisory lock / row lock / lifecycle_version / durable operation row を組み合わせる。
**Auth hard delete直前までのserialization guaranteeを明文化**する。

### C. Service start / stop RPC contract candidate

少なくともsource candidateまたはSQL contractとして：

- start_kabumori_service
- start_x_autopost_service
- begin/mark service deleting
- finish service deletion
- begin common account deletion
- common account deletion eligibility/read model

を検討する。

ただし既存client wiringはこのTASKでは最小限または0でよい。
G4 filesは触らない。

### D. RLS / grants design

新tableについて：

- exposed schemaならRLS必須
- authenticated userは自分のcommon account / entitlementをreadできる
- clientから任意status/user_idを書き換えられない
- writeは限定RPC/backend境界
- TRUNCATE / REFERENCES / TRIGGER等の不要grantを明示revoke
- SECURITY DEFINERが必要ならpublic exposure/EXECUTE PUBLICを避ける
- fixed search_path
- auth.uid ownership check
- service_role依存を必要最小限

既存Kabumori/X RLS enforcementはまだ変更しない。
新しいhelperを既存policyへ差し込むのはPhase 2以降。

### E. Shadow backfill candidate

Phase 0のproduction aggregateを前提に、**productionでは実行しない**backfill SQL candidateを作る。

ルール：

- common_accounts: existing auth.usersごとに1
- kabumori entitlement: legacy profilesをactive候補。source='legacy_profile'等、実利用証拠の弱いrowを区別可能にする
- x_autopost entitlement: user-facing social_mobile_user_v1 self-service workspace ownerだけ
- internal workspace/adminはconsumer x_autopost entitlementにしない
- Auth-only userはcommon accountのみ
- email一致でuser mergeしない

backfillはidempotent / dry-run count可能にする。

### F. Deletion safety future adapter contract

既存Kabumori account-deleteをこのTASKでproduction-safeと宣言しない。

source候補として必要なら：

- legacy Kabumori hard-delete routeをcommon lifecycleへ委譲するadapter設計
- service-only Kabumori withdrawal
- whole common account deletion orchestrator

の境界を明文化/テストする。

ただしX revoke/Vault purge/Apple revokeの実処理を重複実装しない。
既存social-mobile deletion adapterを将来どう呼ぶかはcontract化まで。

### G. Registration/login future contract

設計・tests/docsレベルで：

- appから新規登録 → common account作成/確認 + service entitlement
- existing common ID → login後、対象serviceのみ利用登録
- login前のemailで既存account存在を断定しない
- identity linkingは同一Auth userのみ
- email一致だけで別Auth userをmergeしない
- X login identity ≠ X posting authorization
- Apple loginを共通account削除する際のrevoke step

を固定する。

## Do not touch in Phase 1

- G4 PR #65 files:
  - apps/social-mobile/src/features/x-connect/use-x-connect.ts
  - related auth-session option/test
  - accounts/onboarding copy owned by G4
- production DB
- production Auth users
- production Vault secret
- production OAuth
- provider settings
- real X accounts
- current cron
- existing Kabumori/X service data
- profiles/brand_memberships rename/drop
- existing RLS enforcement
- account deletion production deploy
- existing user backfill
- identity link/unlink

## Required testing

Use disposable/local PostgreSQL or equivalent safe test environment.

最低限：

1. migration applies cleanly to representative schema
2. re-apply/idempotency strategy is explicit
3. RLS/grants least-privilege checks
4. common account active -> service start allowed
5. common account deleting -> service start denied
6. service provisioning vs common delete concurrency both commit orders are safe
7. service-only deletion leaves other entitlement/Auth intact
8. whole-account deletion cannot finalize while active/provisioning service remains
9. admin/shared/unknown fail closed where contract applies
10. backfill dry-run counts/classifications
11. no email-based merge
12. no client arbitrary entitlement creation/status change
13. git diff --check / SQL static checks / relevant unit tests

Race safetyは単なる逐次mockだけでなく、可能なら2セッションPostgreSQL testで証明する。

## Deliverables

- versioned migration candidate
- focused tests
- design note / comments sufficient for lifecycle invariants
- production rollout plan（未実行）
- rollback plan
- exact list of Phase 2 client/backend integration points
- Report

## Completion / K5

Reportに：

- task_id
- result PASS / PARTIAL / BLOCKED
- checked_main
- worktree/isolation
- schema candidate
- lifecycle serialization invariant
- RLS/grant model
- backfill candidate + dry-run proof
- concurrency/race proof
- changed_files
- tests
- commit/PR
- production mutation = 0
- pending conflicts
- remaining unknowns
- rollout/rollback plan
- next recommendation

完了時 status -> review_required / next_owner -> chatgpt / STOP for K5。

Auth/RLS/migration/lifecycleを横断する高リスクsource candidateなので、K5後は原則Sol（高）以上のCodexレビューを入れる。

## Report

- task_id: common-account-v1-phase1-additive-lifecycle-foundation-20261001
- result: **PASS**（source候補・disposable test・設計ノートまで完了。production は未適用。レビュー待ち）
- checked_main: 開始時 `204ba32`。PR head は `26ea179` 基点。Report push 直前に fresh `origin/main` を再確認。
- worktree / isolation: G5専用 worktree（`.claude/worktrees/g5-f7a405`）。source は branch `claude/g5-common-account-phase1-20261001`、Report は main 基点の control commit。他slotの worktree / branch / PR / TASK / dev server は未変更。G4 PR #65 のファイルには触れていない。
- commit / PR: source commit `89cf128`、[PR #70](https://github.com/anohi-memories/kabumori/pull/70)（open、MERGEABLE、**merge HOLD**）。Report 時点の checks: Vercel / Netlify preview SUCCESS、失敗 0。
- push: source は PR branch へ。この Report は `origin/main` へ fast-forward。
- deploy: none（prohibited）。
- production_mutation: **0**。production への接続（read 含む）も 0。migration apply / backfill / Auth 削除 / identity 変更 / Vault・OAuth 操作 / Cron・flag 変更はいずれも未実施。

### changed_files（PR #70、7 files、+2340）

- `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql` — migration 候補（単一ファイル、1 transaction）
- `supabase/tests/common_account_lifecycle_fixture.sql` — 既存 fixture への追加（Kabumori 側 table、`auth.identities` など）
- `supabase/tests/common_account_lifecycle_behavior.sql` — 挙動テスト
- `supabase/tests/common_account_lifecycle_run.sh` — runner（適用・競合・rollback の証明）
- `supabase/tests/common_account_lifecycle_rollback.sql` — rollback
- `supabase/tests/migration_source_invariants_test.ts` — 予約 version に `20261001150000` を1行追加
- `docs/common-account/phase1-lifecycle-foundation.md` — 設計ノート / rollout・rollback 計画 / Phase 2 接続点

client / Edge Function / 既存 migration / 既存 RLS の変更は 0。

### schema candidate

追加のみ。既存 object の rename / drop / 再定義 / grant 変更なし。

| object | 内容 |
| --- | --- |
| `public.common_accounts` | `user_id` PK → `auth.users` ON DELETE CASCADE、`status`（active / deleting / locked）、`lifecycle_version`、timestamps |
| `public.service_entitlements` | PK `(user_id, service_key)` → `common_accounts` CASCADE、`service_key`（kabumori / x_autopost）、`status`（provisioning / active / suspended / deleting / ended）、`source`、`legacy_evidence`、`activated_at`、`ended_at` |
| `private.account_lifecycle_operations` | durable deletion intent。`operation_type`（service_deletion / account_deletion）、`status`、`current_step`、Apple revoke checkpoint、`last_error_code`。in-progress は person × 種別 × service で1件（partial unique index）。raw user id は login 消滅時に消し、subject hash だけ残す |
| `private.account_lifecycle_settings` | 1行。Auth削除ガードの mode（`shadow` 既定 / `enforce`） |
| `private.account_lifecycle_backfill_plan`（view）＋ `private.account_lifecycle_backfill(p_apply)` | shadow backfill 候補（未実行） |

- `provisioning` / `suspended` / `locked` は予約状態。この候補のどの RPC も作らない。全 gate が「サービスあり」として fail closed に扱う。
- preflight（exact）: 二重適用、`private` schema、3 role、必要 table 15、必要列 9、既存 helper 関数 2、`profiles` と子 table の CASCADE、X 側行の `auth.users` 参照を検査。不足時は何も作らず中断。
- 再適用戦略: 再実行不可（`COMMON_ACCOUNT_FOUNDATION_ALREADY_APPLIED`）。ファイル全体が 1 transaction なので部分適用は起きない。
- `profiles` は Kabumori root のまま、`brand_memberships` は X の認可のまま。

RPC（すべて SECURITY DEFINER、`search_path = ''`）:

- client（authenticated、引数なし、本人は `auth.uid()` のみ）: `start_kabumori_service`、`start_x_autopost_service`
- backend（service_role、`p_user_id` は検証済み JWT 由来）: `common_account_deletion_eligibility`、`begin_service_deletion`、`finish_service_deletion`、`abort_service_deletion`、`withdraw_kabumori_service`、`begin_common_account_deletion`、`mark_common_account_apple_revoked`、`abort_common_account_deletion`、`finalize_common_account_deletion`

### lifecycle serialization invariant

- I1: 全 lifecycle RPC は、本人の `auth.users` 行（KEY SHARE。finalize は FOR UPDATE）→ `common_accounts` 行（FOR UPDATE）の順にロックしてから状態を読む。
- I2: サービス開始は account が `active` の時だけ。`begin_common_account_deletion` の commit 以降、全 start は `ACCOUNT_DELETION_IN_PROGRESS` で fail closed。
- I3: service-only deletion は login・他 entitlement・他サービスの行に触れない。
- I4: login 削除は `finalize` だけ。排他ロックを保持した同一 transaction 内で、全 entitlement が `ended`、サービス行なし、admin でない、foreign workspace なし、（Apple identity があれば）revoke checkpoint 済み、を再検証してから `auth.users` を削除する。
- I5: admin / 共有・内部 workspace / entitlement のないサービスデータ / 予約状態は fail closed。
- I6: READ COMMITTED 以外では例外。

**Auth hard delete 直前までの guarantee**: `finalize` は `auth.users` 行を FOR UPDATE で取ってから検証する。サービスデータを作る処理は必ず `auth.users` を参照する行（profile / membership / OAuth state / common account）を insert するため、(a) ロック前に commit 済みなら検証で見えて拒否、(b) ロック中なら待たされ、自分の FK で失敗して transaction ごと rollback（先に insert した workspace 行も消える）。これは **既存・未変更の** `ensure_my_profile` と `begin_social_mobile_x_oauth_connection` に対しても成立する（実物で両方の commit 順を証明）。

- 「最後にもう一度 SELECT する」方式ではない。read と delete の間に隙間がない（同一 transaction・行ロック下）。
- 既存 X deletion acquisition を Kabumori へ流用していない。
- 外部処理（X revoke / Vault purge / Apple revoke）は saga step。DB は checkpoint を記録するだけで、原子的に扱ったふりをしない。
- lock order は login 削除の cascade と同じ向き（`auth.users` → `common_accounts` → …）。lifecycle 呼び出しと legacy hard delete が同時でも待ち合わせになり、deadlock しない。
- `lifecycle_version`: backend は本人が確認画面で見た version を渡す。確認後にサービスが増えていれば `lifecycle_changed` を返し、確認していないものは消さない。
- stale / retry: 各 step は lock 下の状態遷移なので再実行は現在状態を返す。進まない削除は `abort_common_account_deletion` で `active` に戻せる。

**Auth削除ガード**: `common_accounts` の BEFORE DELETE trigger（`auth.users` からの cascade で発火）。`shadow`（導入時の既定）は全て許可し、既存経路の挙動は不変。`enforce` は finalize が同一 transaction で許可した削除以外を拒否する（SQLSTATE 23503。既存 X saga はこれを自身の `operator_required / LOGIN_DELETE_BLOCKED` に落とす）。設定行がなければ `enforce` 扱い。

### RLS / grant model

- 新 table 4つすべて RLS enabled。`public` の2 table は policy 1本ずつ（authenticated、`auth.uid() = user_id` の SELECT のみ）。
- table 権限は `PUBLIC` / anon / authenticated / service_role から全 revoke（default の TRUNCATE / REFERENCES / TRIGGER も消える）。authenticated には列限定 SELECT のみ（`source` / `legacy_evidence` は不可）。**service_role には table 権限なし**（RPC 経由のみ）。
- 関数は全て `PUBLIC` と全 role から EXECUTE を revoke し、RPC ごとに1 role へ grant。`private` の helper は owner 以外実行不可。create と revoke は同一 transaction。
- client は任意の `user_id` / `status` を書けない（INSERT / UPDATE / DELETE / TRUNCATE すべて権限なし。start RPC は引数なし）。
- 既存 Kabumori / X の RLS は未変更。

### backfill candidate + dry-run proof

`private.account_lifecycle_backfill(false)` が件数のみ、`(true)` が不足行を insert。冪等。既存 entitlement は書き換えない。`active` でない account には付与しない。email は一切読まない。

Phase 0 の production 集計と同じ形の fixture（4 login）での dry-run:

| 項目 | 結果 |
| --- | --- |
| auth_users / common_accounts_to_create | 4 / 4 |
| kabumori 候補（activity あり / profile のみ） | 2（1 / 1） |
| x_autopost 候補（identity_verified / pending） | 1（1 / 0） |
| auth_only | 1 |
| excluded_admin_users | 1 |

追加ケース（計 11 login）: 共有 workspace・内部 workspace・self-service でない workspace は X entitlement 対象外、admin に consumer X entitlement なし、同一 email の2 login は2 account のまま（entitlement も共有されない）。apply 後の件数は計画どおり、2回目 apply は 0 件、self-service 済み entitlement と `locked` account は不変。

**production では未実行。** 上表は disposable DB の fixture に対する結果であり、production の dry-run ではない。

### concurrency / race proof（2 session、実 PostgreSQL）

| # | シナリオ | 結果 |
| --- | --- | --- |
| 1 | start 未commit → deletion begin | begin は待ち、`lifecycle_changed`。再 begin は新サービスを含み、finalize は `SERVICES_REMAIN` |
| 2 | deletion begin 未commit → start | start は待ち、`ACCOUNT_DELETION_IN_PROGRESS`。行は作られない |
| 3 | finalize 未commit → lifecycle start + 既存 profile bootstrap + 実物 X onboarding | 3つとも待って失敗。orphans=0 |
| 4 | 既存 creator 未commit → finalize（X onboarding / profile の2通り） | finalize は待ち、拒否。login と所有データは残る |
| 5 | deletion begin ×2 | 1件 `started`、1件 `in_progress`。operation 1件 |
| 6 | 初回 start ×2 | account 1、entitlement 1 |
| 7 | 判断の途中（test用 trigger で start を RPC 内で一時停止）→ deletion begin | begin は待ち、`lifecycle_changed` |
| 8 | lifecycle start（一時停止中）→ legacy hard delete | deadlock なし。delete は待ってから cascade、残存行 0 |

加えて isolation guard（REPEATABLE READ は拒否）、全 race 出力に deadlock なし。

### tests

- `supabase/tests/common_account_lifecycle_run.sh`: **16 項目 PASS**（preflight 拒否 / 追加のみ適用 + 再適用拒否 / 静的チェック / 挙動 / race 8種 / isolation / no-deadlock / rollback / cleanup）。local PostgreSQL 17.11、偽データのみ。
- 追加のみの証明: 適用前後の `pg_dump --schema-only` を比較し、適用前の全行が適用後も存在。rollback 後は適用前と byte 一致、その後の再適用も成功。
- 挙動テストの対象: backfill、ACL / RLS、start、whole-account deletion、service-only deletion（Kabumori 単独、X 単独は**実物の social-mobile 削除 saga** と組み合わせ）、両サービス利用者の全体削除、admin / shared / internal / unregistered / 予約状態 / locked の fail closed、Apple checkpoint、ガード2モード。
- **ミューテーション確認**: candidate に欠陥を10種入れ（login 行ロックを外す、account 行ロックを外す、deleting 判定を外す、ガードを無効化、finalize の blocker 再検証を外す、PUBLIC の EXECUTE を残す、version 検査を外す、既存 grant を変更、など）、**10種すべてテストが検出**。初版の race テストは account 行ロックの欠落を検出できなかったため、race 7 を追加して検出できるようにした。
- 既存スイート: `social_mobile_account_deletion_run.sh` 8 項目 PASS（変更なし）、`migration_source_invariants_test.ts` 10 passed、`git diff --check` clean。
- 未実施: 実 Supabase（GoTrue admin delete、PostgREST 経由、`supabase_auth_admin` role）での確認。production の PostgreSQL version との差の確認。

### pending conflicts

- PR #65（G4、open）: この PR とファイルの重なりなし。Phase 2 の X 側接続点（`onboarding-gate.tsx` など）は #65 決着後に着手。
- PR #41（open）: `x-test-post` と X publish authority の migration。重なりなし。予約 version 一覧（invariants test）は同じファイルを触る可能性があるが、#41 の変更ファイルに含まれていない。
- PR #33（open）: admin auth。重なりなし。
- G1 / G2: Kabumori Home / report 系。Auth / lifecycle との重なりなし。

### remaining unknowns / レビューで見てほしい点

1. `finalize` は GoTrue admin API ではなく SQL で `auth.users` を削除する（既存 X finalize と同じ方式。直列化のため同一 transaction が必要）。Storage 等の FK で阻まれた場合は `AUTH_DELETE_BLOCKED` で停止する。実 Supabase での挙動は未確認。
2. ガードが返す SQLSTATE を 23503 にしたのは、既存 X saga の handler に合わせるため。妥当性の判断。
3. `start_kabumori_service` は entitlement と同時に `profiles` 行を作る。Phase 2 で `ensure_my_profile` を置き換える前提。
4. lifecycle 呼び出しごとに `auth.users` 行を KEY SHARE でロックする。`finalize` を他の lifecycle RPC と同一 transaction で呼ぶとロック昇格で deadlock し得る（PostgreSQL が片方を中断。破損はしない）。finalize は単独 transaction を前提とする。
5. X 側 helper 2関数（workspace id 導出、subject hash）を再利用している。X 削除 candidate が適用済みであることが前提（production は適用済み）。
6. Kabumori 側の test fixture は手書きの最小形。production dump 由来ではない。
7. shadow 期間中、既存 creator は entitlement を登録しないため「entitlement のないサービスデータ」が生じ得る。lifecycle はこれを `UNREGISTERED_SERVICE_FOOTPRINT` で拒否する（推測で消さない）。
8. 直近再認証（H1 の P2）は未対応。Edge Function 側の Phase 3 で扱う。
9. **既存 Kabumori `account-delete` はこの候補では安全にならない。** 経路・挙動とも未変更。

### rollout / rollback plan（未実行。各 step は個別に承認）

1. この候補のレビュー（Auth / RLS / lifecycle）。preflight が依存する catalog を read-only で再確認。
2. 単一ファイルで適用（`db push` 不可）。read-back: table / policy / grant / 関数 ACL / ガード mode `shadow`。
3. backfill dry-run を Phase 0 集計と照合 → backfill 適用 → 件数 read-back。
4. Phase 2 dual-write（既存 creator 2つが entitlement も登録）。parity: backfill dry-run の to_create が 0 のまま。
5. Phase 3: 削除経路を lifecycle へ（Kabumori は `withdraw_kabumori_service`、X は saga を begin / finish で包み scope 判定と自前の Auth 削除を除去、全体削除は orchestrator）。X の scope 規則が残る間は X → Kabumori の順。
6. その後にガードを `enforce` へ。
7. 最後に既存 RLS / producer へ entitlement 条件（flag 付き）。

rollback: `common_account_lifecycle_rollback.sql` が候補の作成物だけを drop。ガードが `enforce`、または削除が進行中なら拒否。step 4 より前は何も依存していないため、失うのは shadow 行のみ。

### Phase 2 の接続点（列挙のみ。未編集）

- Kabumori: `src/lib/auth.ts`、`src/providers/auth-provider.tsx`、`src/app/_layout.tsx`、`public.ensure_my_profile()`、`src/app/settings.tsx`、`src/lib/account-deletion.ts`、`src/lib/account-deletion-client.ts`、`supabase/functions/account-delete/*`、`apps/kabumori-web/pages/account-deletion.html`
- X（#65 決着後）: `apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`、`apps/social-mobile/src/data/onboarding-repository.ts`、`public.begin_social_mobile_x_oauth_connection`、`supabase/functions/social-mobile-account-delete/*`、`social_mobile_account_deletion_scope` / `_finalize`
- producer（最終 phase）: `claim_pending_push_notifications`、`enqueue_important_news_notifications`、`enqueue_personalized_report_notification`、`personalized_report_news_inputs`、`important_news_app_copy_targets`、`personalized-reports/index.ts`、`x-test-post/index.ts`

詳細は `docs/common-account/phase1-lifecycle-foundation.md`（PR #70）。

- remaining_issues: 上記「remaining unknowns」。production 未適用・未 backfill。
- safety_checks: production mutation 0、production 接続 0。既存 table / policy / grant / function の変更 0（schema dump 比較で証明）。G4 ファイル未変更。他slotの TASK / branch / PR 未変更。secret / PII を source・test・Report に含めていない（test は偽 UUID と `example.test` のみ）。merge / deploy なし。
- next_recommendation: K5 の後、PR #70 を Sol（高）以上の Codex レビューへ（重点: I4 の直列化と SQL による Auth 削除、ガード trigger、ACL、backfill 規則、preflight の exactness）。merge / 適用はレビューと別途承認の後。

---

## Previous completed G5 task history — preserved below

# Claude Task 5 — CURRENT TASK

- task_id: common-account-v1-phase0-prod-readonly-inventory-20261001
- owner: claude
- slot: claude-5
- status: done
- next_owner: none
- priority: highest
- start_code: G5
- finish_code: K5
- recommended_model: Opus5.5（極高）
- type: read-only architecture / production inventory / migration preflight
- production_mutation_allowed: false

## Purpose

会社共通アカウントv1の実装前Phase 0として、現行repository + productionのAuth / account / service ownership実態を**read-only**で確認し、既存ユーザーを壊さずにservice entitlementへ移行するための事実ベースのinventoryを作る。

このTASKでは**実装しない**。migration / RLS / Auth / OAuth / Vault / production data / account deletion behaviorを変更しない。

共通アカウントv1の中心方針：

```text
auth.users.id
= 共通本人ID

common_accounts
= 共通アカウントapplication state

service_entitlements
= 各serviceの利用登録

public.profiles
= v1ではKabumori固有rootのまま

brand_memberships
= X workspace authorization / roleのまま
```

各アプリの新規登録は将来、

```text
共通アカウント作成 / 既存共通アカウント認証
+
そのアプリのservice利用登録
```

として扱う。

- Kabumoriから初回登録 → common account + kabumori entitlement
- X自動投稿から初回登録 → common account + x_autopost entitlement
- 既存common accountが別serviceへ来た場合 → 本人認証後、そのservice entitlementだけ作成
- login前のemail入力だけで「既存アカウントあり」と断定表示しない（account enumeration回避）
- login identityとX posting authorizationは別レイヤー
- 異なるAuth userをemail一致だけで自動mergeしない

## Mandatory startup / isolation

開始前に必ず確認する。

1. `PROJECT_RULES.md`
2. `HANDOFF.md`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. `.agent/ACTIVE_TASK.md`
6. このG5 TASK
7. G1〜G4 / H1 / H2の現在TASK・Report
8. `git status`
9. `git worktree list`
10. fresh `origin/main`

G5専用の独立worktree / checkoutを使用する。他slotのworktreeを共有しない。

### Competition / ownership rule

このTASKはread-only調査なので他slotと並行可能だが、開始時にfresh状態を再確認する。

割当時点では、G1/G2/G3/G4およびH1/H2に別workstreamが存在する。特に：

- G3はsocial-mobile account deletion UI release cleanupを担当中。共通account/service-entitlement設計は実装しない方針。
- G4はsocial-mobile X posting OAuthのiOS account-switch/auth-session境界を担当中。
- G1/G2はKabumori UI / market-report系。
- H1/H2は別PRレビュー。

G5はこれらのbranch / files / pending PRを変更・merge・rebase・resetしない。

競合またはownership不明が見つかったら作業開始せずSTOPし、具体的な理由をReportする。

## Existing assumptions to verify read-only

### Kabumori

- Supabase Auth user.idを本人IDとして使用
- session成立時の `prepareSession -> ensureProfile -> ensure_my_profile` によりprofileが自動生成される現行構造
- `public.profiles` がKabumori固有データのcascade root
- 現行Kabumori account deletionはAuth hard delete前提
- client RLSは主に `auth.uid() = user_id`
- service_role producerはRLSを迂回する

### X social-mobile

- 同じSupabase Auth user.idを本人IDとして使用
- login methods: email / Google / Apple / X
- X login identityとX posting OAuthは分離済み
- workspace ownershipは `brand_memberships.user_id`
- posting token本体はVault、social_accountsはsecret reference
- social-only deletionは存在し、Auth / Kabumoriを残してX固有データを削除できる
- 現行delete scopeは `public.profiles` 存在有無をproxyとして使う箇所がある
- X service entitlementはまだ明示テーブル化されていない

## Phase 0 — required read-only inventory

### A. Supabase Auth / identity

productionでaggregateのみ確認。

最低限：

- Auth user総数
- provider identity総数
- provider別identity数: email / google / apple / x / その他
- 1 userが複数identityを持つ件数
- provider組み合わせのaggregate
- identityなし等の異常状態が存在するか
- 同一personと推測して自動mergeすべきuserは判定しない

**email、user UUID、provider token、raw identity payload等のPII/secretをReportへ出さない。**

Auth provider設定について、秘密値を表示せずread-only確認可能ならenabled/disabledやcallback/redirect構成の存在だけ確認する。
secret露出が必要なら「未確認」とする。

### B. Common-account migration population

既存production userを、PIIなしのaggregateで以下に分類するdry-runを作る。

```text
A. Kabumoriあり / Xなし
B. Kabumoriなし / Xあり
C. Kabumoriあり / Xあり
D. Auth userのみ / どちらもなし
```

「あり」の定義を明記する。

Kabumori候補はprofile有無だけでなく、少なくとも：

- profileのみ
- tracked_stocksあり
- alert/settingsあり
- notificationsあり
- device_push_tokensあり
- personalized_reportsあり

をaggregate分類する。

X候補は全brand_membershipsを利用者扱いしない。
一般ユーザー用workspace/profile（例: `social_mobile_user_v1`）とadmin/internal/legacy workspaceを区別し、x_autopost entitlement backfill候補の定義を提案する。

### C. Kabumori ownership / deletion surface

production schema + main sourceをread-onlyで照合。

確認：

- `profiles -> auth.users` FK
- `tracked_stocks`
- `alert_settings`
- `alert_category_settings`
- `notifications`
- `device_push_tokens`
- `personalized_reports`
- FK delete action
- current RLS predicates
- current RPC/functions using `auth.uid()`
- service_role producerがuserを列挙する経路
- current account-delete source + production deploy metadata/version（read-onlyで確認可能な範囲）
- Auth hard deleteが他serviceへcascadeし得る参照

変更しない。

### D. X workspace / membership / social account ownership

productionでaggregate + schema/sourceを確認。

最低限：

- user-facing workspace数
- user-facing owner membership数
- distinct user数
- social account数
- X identity_verified接続数
- publish_enabled状態のaggregate
- platform + platform_user_id uniqueness実態
- orphan membership / orphan social account等が存在しないか
- internal/admin/legacy workspaceとの区別
- workspace ownership chain

raw handle / platform user id / user idはReportへ出さない。

### E. OAuth / Vault boundary

確認：

- social_accountsが保持するcredential referenceの種類
- access / refresh credential reference件数のaggregate
- orphan referenceの有無（安全に判定できる場合）
- OAuth transient stateのaggregate / ownership
- X deletion時のrevoke -> fingerprint check -> Vault purge順序
- Sign in with Appleの共通アカウント完全削除時に必要となるtoken revokeを、現状どこまで実装済みか / 未実装か

**Vault secret valueは絶対に読む・表示・復号しない。**
`vault.decrypted_secrets` 等からsecret値を取得しない。

### F. Current deletion boundaries

Kabumori / Xの両方についてread-onlyで整理。

- service-only deletion
- common Auth deletion相当
- current scope判定
- cascade
- external OAuth revoke
- deletion audit
- feature flag
- reauthentication
- session/user pinning
- retry/idempotency

現行の危険なproxy / hard-delete境界を具体的に特定する。

### G. RLS / backend producer boundary

client RLSとservice_role処理を分けて一覧化する。

将来entitlement導入時に、

```text
auth.uid()/ownership条件
+
service entitlement active
```

が必要になる場所を候補として列挙する。

このTASKではRLSを書き換えない。

### H. New registration / login impact inventory

新仕様を導入する場合に変更対象になり得るsourceをread-onlyで列挙する。

Kabumori：

- signup / sign-in UI
- AuthProvider / AuthGate
- session restore
- ensure profile
- password recovery
- settings/account deletion
- service start UI

X social-mobile：

- signup / sign-in UI
- Google / Apple / X login
- linkIdentity
- workspace provisioning
- X posting OAuth start
- deletion preview/scope
- login methods/settings

共通：

- service entitlement
- common account lifecycle
- account deletion orchestrator
- Apple revoke
- account enumeration-safe UX

**変更ファイル候補を列挙するだけ。編集しない。**

## Migration dry-run recommendation

inventory結果を使い、次のPhaseで安全なshadow backfillを作るための判定ルール案をReportする。

最低限：

- common_accounts候補
- kabumori entitlement candidate rule
- x_autopost entitlement candidate rule
- ambiguous / manual-review population count
- 既存Auth-only userの扱い
- rollback可能性
- feature flag / shadow導入順

**backfill自体は実行しない。**

## Production read-only safety

許可：

- SELECT
- schema / policy / function definition read
- source review
- production metadata/version read
- aggregate count
- dry-run computation that does not write

禁止：

- INSERT / UPDATE / DELETE
- migration apply
- mutation RPC/Edge Function invocation
- Auth user create/update/delete
- identity link/unlink
- OAuth authorize/revoke
- X provider-side mutation
- Vault create/update/delete/reveal
- secret read/decrypt
- account deletion実行
- feature flag change
- deploy
- merge
- production config change
- Cron invocation/change
- real X post
- existing user backfill

read-onlyであることを保証できない操作が必要なら実行せず、未確認事項としてReportする。

## Privacy / report constraints

Reportへ以下を絶対に書かない。

- email address
- auth user UUID
- X handle
- X platform user id
- access token / refresh token
- OAuth code/verifier/state raw value
- JWT
- session id
- secret
- Vault secret value/referenceの生値
- その他個人を識別できるraw data

aggregate count、table/function名、safe schema metadataは可。

## Required output

実装コードは変更しない。

このTASK末尾 `## Report` を更新し、最低限以下を記録する。

- task_id
- result: PASS / PARTIAL / BLOCKED
- checked_main
- worktree / isolation result
- production_mutation = 0
- Auth/identity aggregate
- A/B/C/D population aggregate
- Kabumori legacy classification
- X legacy classification
- ownership findings
- deletion/cascade findings
- RLS/service_role findings
- OAuth/Vault findings（secretなし）
- Apple revoke readiness
- ambiguous migration population
- recommended backfill rules
- proposed implementation phases
- candidate files/components to change later
- conflicts/pending PRs affecting implementation
- tests/checks/read-only queries used（secret/PIIなし）
- remaining unknowns
- safety_checks
- next_recommendation

raw production recordsは貼らない。

## Completion / K5

調査完了後：

- status -> review_required
- next_owner -> chatgpt
- Report更新
- G5自身のTASK以外のsource/runtime codeを変更しない
- production mutation 0を明記
- K5でChatGPTが確認するためSTOP

このPhase 0はread-only調査なので、通常は独立Codexレビューをまだ要求しない。
ただし重大なAuth/RLS/cascade/security defectを発見した場合は修正せずReportし、K5でChatGPTがH1/H2 review/fixの要否を判断する。

## Report

- task_id: common-account-v1-phase0-prod-readonly-inventory-20261001
- result: **PASS**（Phase 0 の A〜H を repository + production で確認。未確認事項は `remaining_issues` に明記）
- checked_main: 開始時 `5414791`。Report push 直前に fresh `origin/main` を再確認。
- worktree / isolation: G5専用 worktree（`.claude/worktrees/g5-f7a405`）、branch `claude/g5-common-account-phase0-20261001`（`origin/main` 基点）。他slotの worktree / branch / PR / TASK は未変更。用意されていた worktree branch は `origin/main` と分岐した古い基点（2096 commit 遅れ）だったため、`origin/main` から branch を切り直した（旧branchは未変更で残置）。
- production_mutation: **0**。
- production read の実行者: **ユーザー本人**。Claude セッションの auto mode が production read を拒否したため、G5 は単一SELECTのクエリ10本と runner を用意し、ユーザーが自分の端末で実行した。G5 は出力ファイル（件数・schema metadata・関数定義のみ）を読んだ。回避操作はしていない。
- changed_files: `.agent/tasks/CLAUDE_TASK_5.md` のみ。クエリ一式と出力は worktree 内の未追跡ディレクトリ `.g5-phase0/` にあり、commit していない。
- tests: クエリ10本を使い捨てローカルPostgreSQL（偽データのみ）で事前に全件実行成功。production では 9本が初回成功、`03_x_workspace` は production に存在しないテーブルを参照して失敗 → 該当 read-only SQL だけ修正して再実行し成功。runner は実行前に各ファイルが「単一SELECT・書き込み語なし・`decrypted_secrets` 不使用」であることを検査する。
- commit_hash: 本 Report の commit（push 後の `origin/main` HEAD）。
- push: `origin/main` へ fast-forward。
- deploy: none（prohibited）。

### 最重要 finding（K5 で判断を推奨。修正はしていない）

1. **Kabumori `account-delete` は production に deploy 済みで ACTIVE**（`verify_jwt = true`、最終更新 2026-09-24）。処理は service role による Auth hard delete 1回だけで、X側（workspace / social account / Vault / X authorization revoke）を一切扱わない。再認証なし、server 側 feature flag なし、audit なし、admin guard なし。
   - 現在「Kabumori と X の両方を持つ user」は 0人のため、孤児 workspace / 未revoke の X authorization は発生していない。経路は稼働中。
   - 現在 `admin_users` の 1人は Kabumori の `profiles` と実利用データを持つ。その account が Kabumori アプリの退会を実行すると `admin_users` 行も cascade で消える（X側削除は同じ状況を `ADMIN_ACCOUNT` で block している）。
2. **X削除の scope 判定は production でも `profiles` 行の有無**（`social_mobile_account_deletion_scope` と `finalize` を production の関数定義で確認）。`profiles` は Kabumori アプリが受け入れた全 session で自動生成されるため、利用登録の証拠として弱い。
3. **`device_push_tokens` は production でも service_role に SELECT しか grant されていない。** `send-push-notifications` の無効 token DELETE は権限上成立しない（RLS は迂回しても table grant は必要）。今回の範囲外。

### Auth / identity aggregate（production）

| 項目 | 件数 |
| --- | --- |
| Auth user 総数 | 4 |
| identity 総数 | 4 |
| provider 別 identity | email 4 / google 0 / apple 0 / x 0 / その他 0 |
| 複数 identity を持つ user | 0 |
| provider 組み合わせ | email のみ 4 |
| identity なし user | 0 |
| soft-deleted / anonymous / SSO / banned | 0 / 0 / 0 / 0 |
| email 未確認 / email なし | 0 / 0 |
| 最終 sign-in | 4人とも直近30日以内 |
| 同一 email を持つ別 user の組 | 0 |
| identity email が user email と異なる identity | 0 |

- 異常状態は検出されず。自動 merge 候補の判定は行っていない。
- `auth.users` への trigger（非internal）は production に存在しない。
- Auth provider の enabled / callback 設定は未確認（設定読み出しは secret 露出の可能性があるため実施せず）。identity の実績としては email のみ。

source から:
- Kabumori アプリの login は email + password のみ。
- social-mobile は email / Google / Apple / X。X・Google は browser OAuth（PKCE）、Apple は iOS native（`signInWithIdToken`）＋他platformは browser。`app.json` に `ios.bundleIdentifier` がなく native Apple は build 未設定。provider は `GET /auth/v1/settings` で有効 かつ `EXPO_PUBLIC_AUTH_PROVIDERS` に宣言されたものだけ表示（default は email のみ）。
- `unlinkIdentity` は social-mobile のどこからも呼ばれない。`linkIdentity` は login-methods 画面のみ。

### A/B/C/D population aggregate（production、4 user）

「あり」の定義を3通りで集計した。

| 定義 | A: Kabumoriのみ | B: Xのみ | C: 両方 | D: どちらもなし |
| --- | --- | --- | --- | --- |
| 1. `profiles` 行あり × user-facing workspace の owner | 2 | 1 | 0 | 1 |
| 2. `profiles` 行あり × `brand_memberships` 任意 | 2 | 1 | 0 | 1 |
| 3. Kabumori 実利用あり × user-facing workspace の owner | 1 | 1 | 0 | 2 |

- 定義1と3の差は「`profiles` だけあって実利用の証拠がない user」1人。
- D（定義1）の 1人は `profiles` も membership も `admin_users` も持たない Auth-only user。

### Kabumori legacy classification（production）

| 分類 | user 数 |
| --- | --- |
| `profiles` あり | 2 |
| profile のみ（実利用の証拠なし） | 1 |
| `tracked_stocks` あり（うち active） | 1（1） |
| `alert_settings` 行あり | 1 |
| `alert_category_settings` あり | 1 |
| `notifications` あり | 1 |
| `device_push_tokens` あり | 1 |
| `personalized_reports` あり | 1 |
| `profiles` なしで Kabumori データあり | 0 |

- 実利用の証拠がある 1人が上記すべてを持つ。この user は `admin_users` にも属する。
- `profiles` 作成時期: sign-up から10分以内 1、それ以降 1。
- `profiles` は利用登録の証拠として弱い: Kabumori アプリが受け入れた全 session で `prepareSession -> ensureProfile -> ensure_my_profile` が走り `profiles(id)` を無条件に作る（cold start、全 `onAuthStateChange`、sign-in、password recovery link 経由を含む）。「Kabumoriを始める」明示ステップは存在しない。`ensure_my_profile` は production に存在（SECURITY INVOKER、authenticated のみ実行可、本体は repo と一致）。
- `ensure_my_profile` が作るのは `profiles` だけ。`alert_settings` 等は後続の client 操作で作られる。
- 注: `alert_settings` の「default から変更済み」判定は初期9列だけを見た（結果 0）。production には `market_critical_news` / `notification_preset` / `emergency_alerts` の3列が追加されており、この3列は判定に含めていない。

### X legacy classification（production）

workspace（`brands`）4件:

| `code_profile_key` | 種別 | 件数 | `is_active` / `publish_mode` |
| --- | --- | --- | --- |
| `social_mobile_user_v1` | 一般ユーザー workspace（id は `u_` + 24桁hex） | 1 | false / disabled |
| `kabumori_v1` | internal | 1 | true / live |
| `ai_salaryman_lab_v1` | internal | 1 | true / live |
| `mio_v1` | internal | 1 | false / disabled |

| 項目 | 件数 |
| --- | --- |
| user-facing workspace | 1 |
| user-facing owner membership / distinct user | 1 / 1 |
| `brand_memberships` 総数 | 1（internal workspace の membership は 0） |
| social account 総数 | 3（user-facing 1、internal 2） |
| `identity_verified` | 3 |
| `publish_enabled = true` | 2（internal のみ。user-facing は false） |
| Vault 参照あり（access / refresh） | 2 / 2（user-facing 1、internal 1） |
| user-facing workspace で予約投稿あり | 0 |
| `(platform, platform_user_id)` 重複 | 0 |

- `x_autopost` entitlement backfill 候補の定義: `code_profile_key = 'social_mobile_user_v1'` かつ id が本人の derived id（`'u_' || substr(md5(user_id), 1, 24)`）と一致する workspace の owner。該当 1人（`identity_verified`）。
- internal 3 workspace は membership を持たず、`admin_users` と service role で運用されている。consumer entitlement の対象外。
- workspace は login 時ではなく初回の「Xを連携」開始時に `begin_social_mobile_x_oauth_connection` が作る。social-mobile に sign-in しただけの user は X側に行がない。
- production の `begin_social_mobile_x_oauth_connection` は repo の最新定義と一致（rollout runbook 記載の md5 と同じ値）。

### ownership findings

production の catalog で確認（source と一致）:

- `auth.users` への FK（public schema）: `profiles.id`、`admin_users.user_id`、`brand_memberships.user_id`、`social_account_oauth_states.initiated_by_user_id`。すべて ON DELETE CASCADE。
- `profiles` への FK: `tracked_stocks` / `alert_settings` / `alert_category_settings` / `notifications` / `device_push_tokens` / `personalized_reports`。すべて `user_id -> profiles(id)` ON DELETE CASCADE。`profiles` 行の削除だけで Kabumori データは全 cascade し、Auth user は残せる。
- `brands` への FK: `brand_memberships` と `daily_content_plans` だけ CASCADE。`social_accounts` / `scheduled_posts` / `post_execution_logs` / `posting_windows` / `publish_claims` / `published_content_fingerprints` / `social_account_oauth_states` / 各 report settings・runs は NO ACTION。
- `social_accounts` への FK: `social_account_oauth_states` / `x_account_refresh_state_v2` / `x_account_refresh_rollout` / `published_content_fingerprints`。すべて NO ACTION。
- `brands` / `social_accounts` / Vault secret は `auth.users` を参照しない。X の ownership chain は `auth.users.id -> brand_memberships(user_id, role='owner') -> brands.id -> social_accounts.brand_id -> vault_*_secret_id -> vault.secrets`。`social_accounts` に user 列はない。
- unique: `social_accounts (brand_id, platform)`、partial unique `(platform, platform_user_id) where platform_user_id is not null`、`brand_memberships (brand_id, user_id)`。1つのXアカウントは全体で1行にしか結び付かない。
- X login identity の subject と `social_accounts.platform_user_id` を突き合わせる処理は存在しない（login identity と posting authorization は分離済み）。

孤児候補（production）:

| 検査 | 件数 |
| --- | --- |
| brand のない membership | 0 |
| brand のない social account | 0 |
| member のいない user-facing workspace | 0 |
| owner のいない user-facing workspace / その social account | 0 / 0 |
| social account のない user-facing workspace | 0 |
| owner が複数 / member が複数の user-facing workspace | 0 / 0 |
| 複数の user-facing workspace を持つ user | 0 |
| id pattern と `code_profile_key` の不一致 | 0 |

schema 再現性:
- `brands` / `social_accounts` / `brand_settings` / `social_account_oauth_states` の `create table` は main の migrations に存在しない（未マージ branch `feature/multibrand-foundation` と test fixture のみ）。
- production の migration history は 58 version。repo の migration file は 99。一致は 31（最後の一致は `20260905140638`）。repo にあって history にない 68 件の中には、production に object が存在するもの（`ensure_my_profile`、`brand_memberships`、X OAuth onboarding、削除 candidate など）が含まれる。history にあって repo に file がない version が 27 件。**migration history は適用状態の指標として使えない。**
- production に未適用と確認できたもの: `social_mobile_content_settings`（table なし）、`scheduled_posts.social_account_id`（列なし = v2 account-bound queue 未適用）。
- deploy 済みだが main に source directory がない Edge Function: `x-oauth-connect`、`brand-post-dry-run`、`stocks-master-sync`、`stocks-new-listing-sync`。

### deletion / cascade findings

Kabumori（`account-delete`、production deploy 済み）:
- bearer を `/auth/v1/user` で検証し、その user id に対して `DELETE /auth/v1/admin/users/{id}`（hard delete）を1回。request body は読まない。
- Kabumori データは `profiles` 経由の cascade で消える。
- 同時に `brand_memberships`、OAuth state、`admin_users` も cascade で消える。`brands` / `social_accounts` / Vault secret は残り、X authorization は revoke されない。
- 再認証なし（email 再入力は client 側のみ）、feature flag なし、audit なし、admin guard なし、session revoke なし。再試行は「404 を成功扱い」のみ。

X（`social-mobile-account-delete`、production deploy 済み、`verify_jwt = true`）:
- scope: `profiles` あり → `social_only`、なし → `social_and_login`。`finalize` でも同じ判定で `auth.users` を削除。
- 順序: bearer 検証 → 確認文字列 → 直近認証（JWT `amr` 600秒以内）→ scope 検証 → tombstone + lease 取得（同時に posting 停止）→ credential 取得 → X revoke（refresh → access）→ fingerprint 照合 → （該当時）Apple revoke → purge（refresh state → OAuth state → posts → `social_accounts` → `vault.secrets` → `brands`）→ finalize。
- state: `started -> x_revoked -> purged`、異常時 `operator_required`。lease と state で再試行は冪等。
- blocker: `ADMIN_ACCOUNT` / `OWNS_OTHER_WORKSPACE` / `WORKSPACE_NOT_SELF_SERVICE` / `SHARED_WORKSPACE` / `WORKSPACE_ROLE_MISMATCH` / `POSTING_IN_PROGRESS` / `CREDENTIAL_REFRESH_IN_PROGRESS` / `CREDENTIAL_OWNERSHIP_AMBIGUOUS`。
- feature flag は client 側のみ（`EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED`）。server 側は deploy されていること自体が gate。
- session pinning は client 側のみ。server は bearer `sub` + lease。
- `social_mobile_account_deletions.user_id` は `auth.users` への FK を持たない。

production の削除実績（audit、件数のみ）:
- 進行中 tombstone: 0。
- audit 20 行、distinct subject 2。`requested` 4 / `started` 4 / `x_revoked` 4 / `purged` 4 / `completed_social_only` 3 / `completed`（login も削除）1。`blocked` / `failed` / `operator_required` は 0。

現行の危険な境界:
1. Kabumori 側の hard delete が X を知らない（上記「最重要 finding 1」）。
2. `profiles` proxy（「最重要 finding 2」）。境界ケース:
   - X専用 user が Kabumori アプリに一度 sign-in すると `profiles` が自動生成され、以後 X削除は `social_only`（login が残る）。現在の X専用 user 1人は `profiles` を持たないため、今は `social_and_login` と判定される。
   - Kabumori user が social-mobile に sign-in しただけ（workspace なし）だと `social_only` で消すものがない。
   - social-mobile のみ・workspace なしの user は login ごと削除される。
3. 2つの削除経路が同じ Auth user を別々の条件で hard delete できる。共通の orchestrator がない。

### RLS / service_role findings

production の policy は source と一致。対象 22 table はすべて RLS enabled（forced ではない）。

client RLS（Kabumori）: `profiles` は `auth.uid() = id`、他 6 table は `auth.uid() = user_id`（`personalized_reports` は加えて `status = 'completed'` と `fact_status = 'passed'`）。共有 Auth project の authenticated user なら誰でも通る。service 利用登録の検査はない。

client RLS（X）: `brand_memberships` は self-select のみ。`brands` / `social_accounts` / `scheduled_posts` / `post_execution_logs` / `posting_windows` は membership（任意 role）で select。admin 用 policy（`private.is_admin()`）が `scheduled_posts` / `post_execution_logs` / `posting_windows` に並存。書き込みは SECURITY DEFINER RPC 経由。

`auth.uid()` を使う production 関数（8件）: `private.is_admin`、`begin_` / `consume_` / `complete_social_mobile_x_oauth_connection`（DEFINER、authenticated のみ）、`ensure_my_profile`（INVOKER）、`set_my_important_news_alert_preferences`（INVOKER）、`get_my_important_stock_news`（DEFINER）、`get_my_important_stock_news_phase5_base`（DEFINER、どの role にも実行権なし）。

`social_mobile_account_deletion_*` は production で service_role のみ実行可（内部 helper はどの role にも実行権なし）。authenticated / anon からは実行不可。

将来「ownership 条件 + entitlement active」が必要になる候補:

- Kabumori client path: 上記 7 table の全 policy、`ensure_my_profile`、`set_my_important_news_alert_preferences`、`get_my_important_stock_news`、`get_daily_kabumori_tip`（user 検査のない SECURITY DEFINER）。
- Kabumori service_role producer（RLS 迂回）: `claim_pending_push_notifications`、`enqueue_important_news_notifications`（wrapper と base）、`enqueue_personalized_report_notification`、`personalized_report_news_inputs`、`important_news_app_copy_targets`、`personalized-reports` function の `tracked_stocks` cohort query。どの producer も `profiles` を列挙しない。population の鍵は `tracked_stocks` / `alert_settings` / pending `notifications` / `device_push_tokens`。production の cron に `send-push-notifications-dispatch`（毎分）、`personalized-reports-morning` / `-close`（平日）が存在。
- X client path: `begin_social_mobile_x_oauth_connection`（authenticated なら誰でも workspace を作れる）、`consume_` / `complete_`、membership select policy 群。
- X service_role path: `x-test-post` dispatcher（repo 定義の `claim_due_post` は brand filter なしで最古の pending を取る。production の本体は未照合）、Vault credential / refresh RPC、`read_social_mobile_history_access_token`（user + owner membership を見る唯一の service-role path）。production の cron に `dispatch-scheduled-posts`（毎分）が存在（job 名からの推定。command 列は読んでいない）。一般ユーザー `u_` workspace は現状 publish できない（inactive / disabled、予約投稿 0）。この経路を開ける時点が entitlement 検査の挿入点。

付随的な気付き（範囲外、未修正）:
- `device_push_tokens`: service_role は SELECT のみ（「最重要 finding 3」）。
- `social_accounts` の SELECT grant は table 全体。member は Vault secret id 列（参照値）を読める。client は非secret 列だけ select している。
- `TRUNCATE` / `REFERENCES` / `TRIGGER` が `authenticated` に残っている table が多い（`profiles`、`tracked_stocks`、`alert_settings`、`brand_memberships` など）。`anon` にも `admin_users` / `scheduled_posts` / `post_execution_logs` / `posting_windows` / `daily_content_plans` で残っている。Data API には TRUNCATE を発行する手段がないため直ちに悪用可能とは考えにくいが、検証はしていない。entitlement 用の新 table では明示的に revoke することを推奨。

### OAuth / Vault findings（secret なし）

- posting token 本体は `vault.secrets`。`social_accounts.vault_access_token_secret_id` / `vault_refresh_token_secret_id` は参照のみ。
- `x-oauth-connect-user` は service role を使わず user JWT で RPC を呼ぶ。refresh は dispatcher 側のみ。
- legacy Kabumori 投稿は `oauth_token_store`（暗号化済み列、production に 1 行）+ env token で、Vault ではない。internal social account 1件は `identity_verified` だが Vault 参照を持たない（この legacy 経路）。

production 集計（`vault.secrets` は `id` 列のみ比較。secret 本体・name・復号 view は読んでいない）:

| 項目 | 件数 |
| --- | --- |
| `vault.secrets` 総数 | 20 |
| access 参照 / うち orphan | 2 / 0 |
| refresh 参照 / うち orphan | 2 / 0 |
| 複数 account が共有する参照 | 0 |
| OAuth state の verifier 参照 / うち orphan | 10 / 0 |
| consume 済みまたは期限切れなのに Vault に残る verifier | 10 |
| 上記3列から参照されない secret | 6（用途未調査） |
| `x_account_refresh_state_v2` 行 | 1 |

OAuth transient state（22 行）:

| 所有 | 状態 | 件数 | initiator | verifier 参照 |
| --- | --- | --- | --- | --- |
| user-facing workspace | consumed | 6 | あり | なし |
| user-facing workspace | 期限切れ・未consume | 6 | あり | なし |
| internal workspace | consumed | 6 | なし | あり |
| internal workspace | 期限切れ・未consume | 4 | なし | あり |

- user-facing の state は `initiated_by_user_id` を持ち、PKCE verifier を server に保存しない（source と一致）。
- internal の 10 行は admin 用 connect（`x-oauth-connect`、main に source なし）由来とみられ、verifier を Vault に保存し、完了・期限切れ後も 10 件すべて残っている。
- state 行は consume / 期限切れ後も削除されない。消すのは X削除の purge だけ。定期 cleanup は存在しない。

### Apple revoke readiness

- 実装は `social-mobile-account-delete` のみ（`apple_revoke.ts`）。authorization code を token endpoint で交換 → `id_token` の subject が本人の Apple identity であることを確認 → revoke endpoint。
- 適用条件は `scope === 'social_and_login'` かつ provider に apple を含む場合だけ。`social_only` では revoke しない。
- 必要 env がなければ `APPLE_REVOCATION_UNAVAILABLE` で fail closed。production の env 設定有無は未確認（secret 一覧は読んでいない）。
- sign-in 時の authorization code は破棄、Apple refresh token は保存していない。削除時に native iOS で再認証して code を取り直す前提。
- native Apple は build 未設定（`ios.bundleIdentifier` なし）。
- production の Apple identity は **0 件**。現時点で Apple revoke が必要な user はいない。
- Kabumori `account-delete` に Apple revoke はない（Kabumori アプリに Apple login がないため現状は不要）。
- 共通アカウントの完全削除では、この revoke を service 単位ではなく共通アカウント層へ移す必要がある。Apple login を公開する前に実装・検証が必要。

### ambiguous migration population（production）

| 集団 | 件数 |
| --- | --- |
| `profiles` のみで実利用の証拠がない user | 1 |
| `profiles` と user-facing workspace の両方を持つ user | 0 |
| Auth-only（どちらもなし） | 1 |
| `admin_users` に属する user（Kabumori 実利用あり） | 1 |
| internal workspace の membership を持つ user | 0 |
| 同一 email の別 user / identity email の不一致 | 0 / 0 |

manual review 対象は 4人中 2人（profile のみ 1、Auth-only 1）。Auth-only の 1人が social-mobile の sign-up なのか Kabumori の sign-up なのかは DB から区別できない。

### recommended backfill rules（案。backfill は未実行）

| 規則 | 現時点の該当数（dry-run） |
| --- | --- |
| `common_accounts`: `auth.users` 1行につき1行。merge しない | 4 |
| `kabumori` entitlement: `profiles` 行を持つ user を `active` で backfill。`source = 'legacy_profile'` と実利用の証拠有無を併記 | 2（証拠あり 1、profile のみ 1） |
| `x_autopost` entitlement: user-facing workspace（`social_mobile_user_v1` かつ derived id 一致）の owner。`identity_verified` / `authorization_pending` を区別 | 1（`identity_verified`） |
| entitlement なし（`common_accounts` のみ）。次回その app で認証した時の利用登録で作る | 1 |
| manual review | 2 |

- internal workspace の membership と `admin_users` は entitlement の対象外。admin が Kabumori を使っている場合は通常の `kabumori` entitlement を別途持つ（現状 1人）。
- email 一致での統合はしない。
- rollback: 新規 table の追加のみで既存列・既存 policy を変えないため、shadow 段階は drop で戻せる。
- 導入順: shadow table + backfill（誰も読まない）→ dual-write（`ensure_my_profile` と `begin_social_mobile_x_oauth_connection` で entitlement を同時作成）→ parity 監視 → 削除 scope 判定を entitlement に切替 → RLS / producer の enforcement を flag 付きで最後に。
- population が 4人と小さいため、backfill は件数照合を全数で行える。

### proposed implementation phases

1. schema 追加（`common_accounts` / `service_entitlements`、self-select RLS、client 書き込み不可、`TRUNCATE` 等を明示 revoke、service 利用登録 RPC）。production は migration history が source とずれているため、単一ファイルを preflight 付きで適用（`db push` 不可）。
2. shadow backfill + dual-write + parity query。
3. 削除境界: X削除 scope の `profiles` proxy を entitlement に置換。Kabumori 退会を「`profiles` 削除（cascade）+ kabumori entitlement 終了」に変更し、Auth hard delete は「active entitlement が他にない」場合だけ共通の orchestrator 経由（X revoke / Vault purge / Apple revoke / admin guard / 再認証 / audit を含む）で行う。Kabumori `account-delete` は deploy 済みのため、この Phase を待たずに admin guard と X workspace 保有時の fail-closed だけ先行する選択肢がある。
4. 登録 / login UX: 各 app に service 利用登録ステップ、enumeration-safe な文言、Kabumori の `profiles` 自動生成を明示登録へ。
5. enforcement: RLS と service_role producer に entitlement active 条件を flag 付きで追加。

### candidate files / components to change later（列挙のみ。未編集）

Kabumori:
- signup / sign-in: `src/components/auth-screen.tsx`、`src/lib/auth.ts`
- AuthProvider / AuthGate / session restore: `src/providers/auth-provider.tsx`、`src/app/_layout.tsx`、`src/components/profile-recovery-screen.tsx`、`src/lib/supabase.ts`、`src/hooks/use-register-push-token.ts`
- ensure profile: `src/lib/auth.ts`、`ensure_my_profile`（新 migration で置換）
- password recovery: `src/lib/password-recovery.ts`、`src/hooks/use-recovery-link.ts`、`src/components/password-reset-screen.tsx`、`src/app/+native-intent.tsx`
- settings / 削除: `src/app/settings.tsx`、`src/lib/settings-menu.ts`、`src/lib/account-deletion.ts`、`src/lib/account-deletion-client.ts`、`supabase/functions/account-delete/*`、`apps/kabumori-web/pages/account-deletion.html`、`docs/mobile-release/ACCOUNT_LIFECYCLE.md`
- service start UI: `src/components/onboarding-screens.tsx`、`src/hooks/use-onboarding.ts`（現状は端末ローカルの紹介画面のみ。server 側の利用登録画面は存在しない）
- producer: `supabase/functions/send-push-notifications/index.ts`、`personalized-reports/index.ts`、`important-news-monitor/index.ts` と対応 RPC

X social-mobile:
- signup / sign-in: `apps/social-mobile/src/components/auth-screen.tsx`、`src/app/_layout.tsx`、`src/providers/auth-provider.tsx`、`src/domain/auth-flows.ts`
- Google / Apple / X login: `src/lib/auth-client-flows.ts`、`src/lib/supabase.ts`、`src/lib/session-storage.ts`、`app.json`
- linkIdentity / login methods: `src/app/login-methods.tsx`、`src/domain/account-security.ts`
- workspace provisioning: `src/features/onboarding/onboarding-gate.tsx`、`src/data/onboarding-repository.ts`、`src/domain/onboarding.ts`、`begin_social_mobile_x_oauth_connection`
- X posting OAuth start: `src/features/x-connect/use-x-connect.ts`、`src/app/accounts/index.tsx`、`supabase/functions/x-oauth-connect-user/*`
- 削除 preview / scope: `src/app/account-deletion.tsx`、`src/domain/account-deletion.ts`、`supabase/functions/social-mobile-account-delete/*`、`20260928160000_social_mobile_account_deletion_candidate.sql`
- backend: `supabase/functions/x-test-post/index.ts`、`_shared/brand/brand_context.ts`、`publish_guard.ts`、`social_mobile_history_access_reader.ts`

共通（新規）: service entitlement、common account lifecycle、account deletion orchestrator、Apple revoke の共通化、enumeration-safe UX。

admin: `apps/admin` は同じ Auth + `admin_users`。`profiles` を参照しない。admin を common account に含めるかは別判断。

### conflicts / pending PRs affecting implementation

Report 時点の fresh `origin/main` と open PR で確認。

- PR #65（G4、open、merge 保留）: `use-x-connect.ts`、`onboarding-gate.tsx`、`accounts/index.tsx`。X posting OAuth start / provisioning の候補と重なる。
- PR #68（G3 の削除 UI 仕上げ、open）: `login-methods.tsx`、`(tabs)/settings.tsx`。login methods / 削除導線の候補と重なる。
- PR #41（Stage 3B prep、open）: `x-test-post/index.ts` と X account publish authority の新 migration。X service_role path の候補と重なる。
- PR #33（admin password recovery、open）: `apps/admin` の auth 経路。
- PR #66 / #67 は調査中に merge 済み。merge 後の main でも、Auth / 削除 / X OAuth / social-mobile / migrations の候補ファイルに変更はない。#66 が触れた `x-test-post/index.ts` は X service_role path の候補。
- 実装 Phase は #65 と #68 の決着後に着手するのが安全。G5 はいずれも変更していない。

### tests / checks / read-only queries used（secret / PII なし）

- source 調査: Kabumori 側・X 側を read-only で棚卸し（path:line 付き）。削除 scope 判定、finalize、`account-delete`、`ensure_my_profile`、AuthProvider、workspace 作成 RPC、Apple revoke 条件、unique index、再認証窓は G5 が直接再読して確認。
- production クエリ（ユーザー実行、すべて単一 SELECT）:
  - `00_schema_catalog`: table / 列 / FK / unique / policy / grant / 関数の属性 / `auth.users` trigger（catalog のみ）
  - `01_auth_identity`: user・identity の件数集計
  - `02_population`: A/B/C/D と Kabumori / X の flag 別件数
  - `03_x_workspace`: workspace / membership / social account / OAuth state の件数と孤児検査
  - `04_vault_reference_integrity`: 参照の件数と orphan（`vault.secrets.id` のみ）
  - `05_deletion_state`: tombstone と audit の件数
  - `06_migration_history`: 適用済み version 一覧
  - `07_cron_jobs`: job 名・schedule・active（command 列は取得しない）
  - `08_key_function_definitions`: 境界関数 12 件の定義
  - `09_legacy_token_store`: 行数のみ
  - `supabase functions list`: Edge Function の name / version / status / `verify_jwt` / 更新時刻
- GitHub: open PR の変更ファイル一覧を read-only で確認。

- remaining_issues:
  - Auth provider の enabled / redirect 設定は未確認（identity 実績は email のみ）。
  - Apple revoke 用 env、その他 function secret の設定有無は未確認。
  - `x-test-post` を起動する cron の command 本体、production の `claim_due_post` 本体は未照合。
  - Vault の「参照されない 6 secret」と、残存する verifier 10 件の用途・要否は未調査（値は読んでいない）。
  - deploy 済み function の code が main と一致するかは未照合（version と更新時刻のみ）。
  - `alert_settings` の追加3列は「変更済み」判定に含めていない。
  - Auth-only の 1人がどの app 由来かは DB から判別不能。
- safety_checks: production mutation 0。G5 による production 接続 0（read はユーザーが実行）。Vault secret 値の読み取り 0。Auth / identity / OAuth / deploy / merge / flag / Cron 変更 0。backfill 0。他slotの TASK / branch / PR / 作業ファイル変更 0。source / runtime code 変更 0。Report に email / user UUID / X handle / platform user id / token / JWT / secret / Vault 参照の生値を含めていない。
- next_recommendation:
  1. K5 で、deploy 済み `account-delete` の扱い（admin guard と X workspace 保有時の fail-closed を先行するか、共通 orchestrator まで待つか）を判断。Auth 削除境界のため H1/H2 review 対象を推奨。
  2. 共通アカウント v1 Phase 1（additive schema + shadow backfill 設計）を別 TASK で起票。#65 と G3 の決着後に着手。
  3. `device_push_tokens` の service_role grant、残存 verifier secret と OAuth state の cleanup は別件として起票を検討。


## Final K5 — 2026-10-01 JST

- verdict: **PASS — Phase 0 complete**.
- accepted_scope: repository + production read-only inventory only; source/runtime implementation changes = 0.
- production_mutation: **0**.
- key decision: common-account v1 may proceed to additive/shadow design later, but Phase 1 implementation is held until pending social-mobile Auth/deletion work is reconciled.
- security follow-up: production Kabumori account deletion currently hard-deletes the shared Auth user without X-service/admin-aware protection. This is an existing cross-service lifecycle risk and is assigned separately to H1 for source/security review and minimal fail-closed correction candidate. No production deploy is authorized by K5.
- Codex review of Phase 0 itself: not required because G5 changed no runtime code and only performed read-only inventory. The newly discovered deletion boundary receives its own H1 review.
- AI Lab diary: 記録不要 — 同日既存エントリが「共通部分とサービス固有部分を分け、サービス単位で安全に利用終了する」という今回の公開可能な要点をすでに含んでおり、重複追記はしない。


## Final K5 — Phase 1 lifecycle foundation

- verdict: **PASS to focused Codex review; merge/deploy/apply HOLD**.
- accepted source candidate: PR #70 exact head `89cf128bd9219897806b2b641cce4866f6e16c52`, 7 files, additive schema/tests/docs only.
- scope quality: no client/Edge/runtime wiring, no existing table/policy/grant/function rewrite, no G4 PR #65 file overlap.
- concurrency evidence accepted as candidate evidence: real PostgreSQL two-session race coverage, both provisioning-vs-delete commit orders, existing profile/X onboarding creators, no-deadlock case, rollback/reapply, mutation checks.
- production mutation: **0**; production read: 0; migration/backfill/deploy/Auth/OAuth/Vault/Cron changes: 0.
- merge decision: **HOLD** pending H1 review of SQL Auth deletion semantics, lifecycle serialization, guard trigger, ACL/SECURITY DEFINER/search_path, preflight exactness, shadow backfill rules, rollback safety, and Supabase compatibility.
- source candidate is not approval to apply migration or change production deletion behavior.
- next reviewer: H1 `common-account-pr70-lifecycle-foundation-review-20261001`, recommended model **Sol（高）**.
- pre-production migration/apply decision, if reached later, requires a separate **Sol（極高）** gate.
- AI Lab diary: 候補あり — 共通ログインとサービスごとの利用登録を分ける土台を作り、利用開始と全体削除が同時に走るケースまで競合テストした内容を公開安全な表現で2026-10-01エントリへ反映。


## Final K5 — PR #70 corrective foundation

- verdict: **PASS to focused Codex rereview; merge/apply/deploy HOLD**.
- accepted corrective source head: `eebe9405d758e0c120f9e6f1a70cdb1e973a0855` on PR #70, open/mergeable.
- architecture correction accepted for review: Phase 1 no longer deletes `auth.users`; it stops at `ready_for_managed_auth_delete` / managed-cleanup readiness and leaves actual Auth/Storage/provider/session destruction to a later orchestrator.
- H1 six reproduced blockers are now represented as committed regressions and are reported PASS by G5.
- G5 evidence accepted as candidate evidence: lifecycle runner 19 PASS, mutation suite 29/29 detected, existing X deletion regression PASS, migration invariants PASS, git diff clean.
- production mutation/read: 0; no migration apply/backfill/Auth delete/Storage delete/OAuth/Vault/deploy/flag/Cron change.
- fresh overlap check: PR #70 files do not overlap base-to-main runtime changes.
- merge decision: **HOLD** pending H1 rereview of exact head `eebe9405d758e0c120f9e6f1a70cdb1e973a0855`.
- production apply remains separately gated by **Sol（極高）** after source acceptance and real disposable Supabase proof.
- AI Lab diary: 追加更新なし。2026-10-01 entry already covers the common-account concurrency/safety work at an appropriate public-safe level; avoid same-day duplicate detail.


## Final K5 — PR #70 readiness authorization corrective

- verdict: **PASS to focused Codex rereview; merge/apply/deploy HOLD**.
- accepted source candidate for rereview: PR #70 exact head `47a2ed6a1635177ba82004eace4bddb42d9d53e3`, open/mergeable at K5 check.
- architecture delta accepted for review:
  - Phase 1 still performs no managed Auth deletion.
  - Phase 1 no longer contains an enforcing deletion guard; the Auth-cascade trigger is observation/shadow only.
  - readiness is durable state bound to lifecycle version + requirement epoch + required checkpoint set.
  - built-in checkpoint semantics are immutable/fail-closed.
  - entitlement owner/service transfer is prohibited.
  - producers not yet wired to invalidate readiness keep enforcement out of Phase 1.
- prior six H1 blockers remain reported PASS; the later seven adverse cases are now committed regressions and reported PASS.
- reported candidate evidence: lifecycle runner 20 PASS, mutation suite 45/45 detected, social-mobile deletion 8 PASS, migration invariants 10 PASS, shell/diff checks clean.
- production mutation/read: 0; no migration apply/backfill/Auth/Storage/OAuth/Vault/deploy/Cron/flag/provider change.
- concurrency/competition: PR #70 is 75 commits behind main, but fresh base-to-main comparison has **no file overlap** with the eight PR files. Other slot branches/files were not touched.
- merge decision: **HOLD** pending H1 rereview of exact head `47a2ed6a1635177ba82004eace4bddb42d9d53e3`.
- production apply remains separately gated by **Sol（極高）**, disposable real Supabase proof, exact production read-only preflight/history/ACL/FK checks, and explicit approval.
- AI Lab diary: **no update**. 2026-10-02 already has a different, coherent daily entry for the X app; do not overwrite/mix it merely to record another same-day workstream.



