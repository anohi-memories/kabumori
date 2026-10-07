# Claude Task 3 — CURRENT TASK

- task_id: ai-lab-premium-length-policy-unlimited-20261007
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sonnet5（高）
- type: bounded AI Lab length-policy correction on existing PR #109
- target_pr: 109
- accepted_security_head: 7c3c06d07c32910472185e1c94b04fa1aab794f5
- production_mutation_allowed: false
- deploy_allowed: false
- merge_allowed: false

## Context / K3 disposition

The prior PR #109 migration-security corrective is a **PASS candidate for rereview**:
- B1 SET ROLE graph guard added;
- B2 canonical prerequisite table-shape proof added;
- B3 exact companion lifecycle-function body proof added;
- 13/13 adverse cases reject and rollback;
- healthy apply/reapply passes;
- real SQL capacity remains 140/140;
- accepted 74-topic/Tier2/Tier3 design unchanged;
- production mutation/deploy/merge remains 0.

Before sending that head to Codex, the user clarified a product policy:

> 会社員AIラボはX Premium運用なので、140文字を超えてよい。短文上限に縛らない。

Fresh source inspection found the current AI Lab profile is not 140-limited, but **is hard-limited to 280 Unicode code points**:
- `AI_SALARYMAN_LAB_CODE_PROFILE.postLengthPolicy = { mode: "limited", maxChars: 280 }`;
- generator rejects 281 with `BRAND_POST_LENGTH_LIMIT_EXCEEDED`;
- final pre-X dispatch guard rejects 281 again.

This hard ceiling conflicts with the user's Premium-account policy.

## Goal

Remove the hard finite character ceiling **for company AI Lab only**.

Required final behavior:
- AI Lab `brand_post` uses the existing generic `UNLIMITED_POST_LENGTH` policy.
- 281+ characters do not fail solely because of character count.
- 140 characters is not a target or ceiling.
- 280 characters is not a target or ceiling.
- Do not force long posts either. Add/adjust AI Lab profile guidance so the model varies length naturally:
  - concise topic -> concise post is fine;
  - when the content benefits from context/detail, it may exceed 280;
  - do not pad/fill merely because Premium permits longer posts.
- Existing content safety, dedupe, topic, hashtag and account checks remain unchanged.
- Character count should still be measured/reported for diagnostics; only the finite ceiling disappears.

## Scope

Expected files:
- `supabase/functions/_shared/brand/brand_profiles.ts`
- `supabase/functions/_shared/brand/brand_profiles_test.ts`
- `supabase/functions/_shared/brand/brand_post_generator_test.ts`
- `supabase/functions/_shared/brand/brand_post_dispatch_guard_test.ts`

Do not change the generic length-policy implementation unless strictly necessary; it already supports `UNLIMITED_POST_LENGTH`.

Do not change:
- POSTONA / `social_mobile_user_v1` length behavior;
- Kabumori X length behavior;
- x-test-post report/morning/useful-tip length contracts;
- PR #109 topic pool / 74 seeds / Tier ordering;
- PR #109 B1/B2/B3 migration correction;
- scheduler/posting windows;
- X OAuth/Vault/Auth/common-account/provider logic.

## Mandatory tests

Update the old AI Lab 280-limit tests to prove the new user policy:
1. AI Lab profile is explicitly `UNLIMITED_POST_LENGTH`.
2. generation prompt no longer says `280文字以内`; it communicates no hard ceiling and natural-length guidance.
3. generator accepts >280 text (use at least one 600+ code-point fixture) and returns correct `characterCount`.
4. final AI Lab dispatch guard accepts >280 text and still returns the measured character count.
5. account mismatch / wrong post type / other existing dispatch safety checks remain unchanged.
6. POSTONA/general-user and Kabumori profile length behavior is unchanged.
7. no source/test assertion anywhere in AI Lab path still requires max 280.

Run:
- focused profile/generator/dispatch tests;
- relevant AI Lab/shared brand suite;
- PR #109 existing topic/migration tests as a smoke regression (do not need to redo every expensive PostgreSQL adverse runner if source bytes of migration are unchanged, but verify migration files remain byte-identical to accepted security head);
- deno check/lint;
- git diff --check;
- added-line secret scan.

## PR / freshness

- Keep using existing PR #109.
- Require `7c3c06d07c32910472185e1c94b04fa1aab794f5` in PR history.
- Fresh-fetch origin/main before editing and before push.
- Re-check G2/G4/G5 overlap.
- Do not alter migration/security files except for conflict-free merge resolution if absolutely necessary; if their bytes change, STOP and report before push.
- No production access/write/apply/deploy/scheduler/OpenAI/X call.

## Completion

Update PR #109 and report:
- new exact head;
- exact files changed for length policy;
- proof that prior B1/B2/B3 migration bytes are unchanged from `7c3c06d0`;
- >280 generation + dispatch results;
- focused/full relevant test counts;
- fresh-main overlap;
- production mutation/deploy/merge = 0.

Then:
- status: review_required
- next_owner: chatgpt
- STOP for K3.

After this K3, assign one exact-head Codex rereview covering:
- previously corrected B1/B2/B3 migration guards;
- this small AI Lab unlimited-length policy delta only.


## Report — ai-lab-premium-length-policy-unlimited-20261007

- result: **PASS candidate** — 会社員AIラボだけ、投稿本文の文字数上限をなくした（X Premium 運用）。PR #109 を更新し、open のまま（GitHub: MERGEABLE）。本番の読み書き 0 / migration 適用 0 / deploy 0 / merge 0 / scheduler 0 / OpenAI・X 0。
- PR #109 head: `7c3c06d07c32910472185e1c94b04fa1aab794f5` → 最新 main の通常 merge `c6df5dfc` → **新 `fb4afb21d7ce808de3257bebc8062aed93353dec`**（修正コミット 1 つ）。rebase / force-push なし。`7c3c06d0` は履歴に含まれる。
- CI: Vercel だけ「Deployment rate limited」（アカウント全体の制限で以前から同じ）。netlify は SUCCESS。
- worktree: 既存の `/Users/yuya/Developer/kabumori-g3-ai-lab-continuity`（開始時 clean、`7c3c06d0` と一致を確認）。
- 指定モデルは Sonnet5（高）だったが、ユーザーの選択で Opus 5.5 のまま実施。

### 変更内容
- `brand_profiles.ts`
  - AI ラボの `postLengthPolicy` を `{ mode: "limited", maxChars: 280 }` → **`UNLIMITED_POST_LENGTH`**（既存の汎用の無制限モード）。
  - 口調の指示に 1 行追加: 「X Premiumで運用しているため上限はない。140文字や280文字は目標でも上限でもない。題材が簡潔なら短くてよい。背景・具体的な手順・判断の理由が役立つときは280文字を超えてよい。水増しや繰り返しはしない。」
- `brand_post_generator.ts`（汎用の生成処理。**無制限モードのときだけ**挙動が変わる。理由は下記）
  - 出力トークンの上限: 無制限モードは 2000、それ以外は従来どおり 600。
  - 無制限モードで応答が打ち切られた（`status: "incomplete"`）ときは、投稿せず `BRAND_POST_OUTPUT_INCOMPLETE` で失敗する。
  - 理由: このモデルは推論ありで、推論分も 600 トークンに含まれる。日本語だと 300〜500 文字前後で打ち切られる可能性があり、しかも従来は打ち切りを検出していなかった。上限をなくすと「途中で切れた文章がそのまま投稿される」危険が出るため、最小限の対策を入れた。かぶモリ・POSTONA は無制限モードを使っていないので影響しない（テストで確認）。
  - 文字数（`characterCount`）は従来どおり計測して返す。
- 変えていないもの: 汎用の文字数ポリシー本体（`post_length_policy.ts`）、送信前ガード本体（`brand_post_dispatch_guard.ts`）、かぶモリと POSTONA の長さの扱い（POSTONA の 140 上限を含む）、x-test-post の各レポートの長さ、題材の 74 件・Tier の順番、B1/B2/B3 の migration、scheduler、OAuth / Vault / Auth / 共通アカウント / provider。
- `supabase/tests/x_account_refresh_pilot.md` の古い一文（「AI Lab keeps its own 280 policy」）を現状に合わせて修正。

### 280 文字を超える場合の結果
- 生成: 641 コードポイント（「あ」640 文字＋絵文字 1 つ。UTF-16 では 642）の本文を受け付け、`characterCount = 641`、本文は変更なし。281 文字と 3 文字も受け付けた。
- 生成時の指示文: `280文字以内` も「◯文字以内」も含まない。「投稿本文の文字数上限は設定されていません。」と、自然な長さの指示を含む。
- 送信前ガード: 1 / 140 / 279 / 280 / 281 / 600 文字と、641 コードポイントの本文をすべて受け付け、計測した文字数を返す。
- 予約投稿の実行: 641 コードポイントの本文が、そのまま X 送信処理に渡り、`characterCount = 641` が報告された。

### 安全性の確認（変わっていないこと）
- アカウント不一致: ブランド ID / アカウント ID / アカウントのブランド / プラットフォーム / ハンドル / アカウントなし の 6 通りで、長文でも `AI_LAB_DISPATCH_ACCOUNT_MISMATCH`。
- 投稿種別の誤り、`brand_post` が無効、文字数ポリシーが未設定 → 従来どおり拒否。
- 有限の上限を明示的に設定した場合は、汎用の処理として従来どおり 280 で拒否される。
- かぶモリ・POSTONA のプロフィールには長さポリシーがないまま。POSTONA の送信は 140 上限のまま。
- 内容の安全性・重複除外・題材・ハッシュタグの処理は変更なし。

### 変異確認
- AI ラボを一時的に 280 上限に戻すと、新しいテスト 8 件が失敗した。
- 打ち切り検出を一時的に無効にすると、打ち切りのテストが失敗した。
- どちらも確認後に元へ戻した。

### テスト
- 関連の重点テスト: 生成 20 件、プロフィール・送信前ガード・予約投稿・文字数ポリシー・POSTONA を含めてすべて成功。
- x-test-post + `_shared` + migration の不変条件: **1028/1028** 成功。
- PR109 のスモーク（ローカルの使い捨て PostgreSQL 17）: `ai_lab_topic_capacity_run.sh` と `ai_lab_topic_capacity_adverse_run.sh` の両方が ALL PASSED。
- migration と題材のファイルは `7c3c06d0` と**バイト単位で同じ**（`git diff --quiet 7c3c06d0 --` が差分 0）: `20261007173000_ai_lab_topic_evergreen_capacity.sql`、`ai_lab_topic_capacity_run.sh`、`ai_lab_topic_capacity_adverse_run.sh`、`ai_lab_dev_diary_context.ts`。`supabase/migrations` 全体でも `7c3c06d0` からの差分なし。
- `deno check`: 既存の 3 件（`brand_post_generator_test.ts` の今回触っていないテスト）だけで、変更前と同じ。`deno lint`: 13 件で変更前と同じ（すべて既存の `require-await`）。`git diff --check` クリーン。追加行の秘密情報スキャン 0。

### 最新 main との重なり
- 作業前と push 前に最新の main を取得した（main `c5f14378` は取り込み済み）。
- open な PR（#110 G2 / #106 G4 / #33）と変更ファイルの重なりはない。G2 / G4 / G5 のファイルには触れていない。

### 本番・ゲート
本番へのアクセス・書き込み・適用・deploy・scheduler・OpenAI・X はすべて 0。merge 0。

### 次
- TASK のとおり、新しい head `fb4afb21` に対して Codex の再レビューを 1 回（B1/B2/B3 の migration の修正と、今回の文字数の変更）。
- レビューで見てほしい点: 生成処理の「無制限モードのときだけ出力上限 2000・打ち切りは失敗」は TASK に明記されていない追加なので、この判断でよいか。
- status → review_required / next_owner → chatgpt。STOP。

---

# Previous G3 task — preserved history

# Claude Task 3 — CURRENT TASK

- task_id: ai-lab-topic-continuity-pr109-security-corrective-20261007
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Opus5.5（高）
- type: bounded migration/security corrective on existing PR #109
- target_pr: 109
- reviewed_head: f83247ae1024d4220dfbfa5484c725381d63815d
- production_mutation_allowed: false
- deploy_allowed: false
- merge_allowed: false

## C1 disposition

H1 exact-head review of PR #109 returned **CHANGES REQUIRED**.

Preserve the accepted topic/capacity implementation. Correct **only** the three migration boundary findings B1-B3 and the tests necessary to prove them.

Do not redesign the topic pool, cooldowns, scheduler, provider flow, X handling or AI model policy.

## Accepted evidence — do not reopen without concrete regression

The following is accepted and should remain byte/behavior stable except where a narrow test hook is unavoidable:
- 74 total evergreen seeds.
- evergreen-0..6 identities/text/tags preserved.
- Tier 2 diverse evergreen + Tier 3 reserve ordering.
- recent dev diary remains first.
- Tier 3 remains last priority.
- no Web Search dependency for fallback.
- no fabricated specific current-AI/news claims.
- same-seed 72h cooldown unchanged.
- tagged-theme 48h cooldown unchanged.
- unresolved claimed/provider_started/ambiguous blocking unchanged.
- event-level dedupe/fencing unchanged.
- cross-brand fingerprint/content guards unchanged.
- provider outcome / ambiguous no-resend unchanged.
- candidate limit target 128 is acceptable in principle.
- exact TS/SQL 74-entry map parity is accepted.
- real SQL 14 days x 10/day = 140/140, fixed/skewed rotation 140/140 accepted.
- old seven-seed pool exhaustion reproduction accepted.
- migration-first then x-test-post-deploy order accepted.

## Blocking B1 — fail closed on SET ROLE paths to service_role

Current reviewed migration checks direct/inherited effective privileges but misses role memberships that allow:
- direct `anon -> service_role` with `INHERIT FALSE, SET TRUE`;
- indirect `authenticated -> bridge -> service_role` with SET ROLE capability.

Required correction:
- before replacing the claim function, detect and reject **direct and transitive** API-role paths that can `SET ROLE` into `service_role` or another privileged target that would gain claim execution.
- retain existing owner-membership checks.
- support PostgreSQL 16+ per-edge membership semantics; where exact edge semantics are unavailable, fail conservatively rather than assuming safety.
- do not auto-revoke or repair role membership.
- transaction must rollback fully on detection; no function/body/ACL change may persist.

Required adverse fixtures:
1. anon -> service_role, INHERIT FALSE / SET TRUE.
2. authenticated -> intermediate role -> service_role, SET TRUE path.
3. existing ordinary INHERIT TRUE privilege path remains rejected.
4. healthy role graph remains accepted.
5. rollback/no-definition-change assertion for each rejected case.

## Blocking B2 — prerequisite table canonical-shape proof

Current preflight is too weak: object existence + substring CHECK can accept drift.

Before `CREATE OR REPLACE FUNCTION`, validate the prerequisite `ai_lab_topic_claims` shape as canonical.

At minimum prove:
- expected columns, data types, nullability/defaults;
- primary key;
- event_key and other required CHECK semantics, not substring matching;
- required unique/index definitions including key columns, predicates, uniqueness, validity/readiness;
- RLS enabled/forced state as expected;
- policies/triggers expected by the accepted base;
- table owner;
- explicit/effective table + column ACL boundary;
- no unexpected conflicting object shape relevant to claim safety.

Accepted states:
- canonical pre-capacity base state from `20261004090000`;
- canonical already-capacity state for idempotent reapply.

Reject unknown drift. Do not mutate/repair the table, RLS, policies, indexes or ACLs in this migration.

Required adverse fixtures against the **capacity migration itself**:
- missing PK;
- missing diary active unique index;
- RLS disabled;
- vacuous/replaced event-key CHECK that only contains matching text;
- at least one wrong index predicate/key/validity fixture;
- unexpected table/column ACL drift.
All must fail before function replacement and rollback cleanly.

## Blocking B3 — verify unchanged lifecycle function bodies, not metadata only

The capacity migration replaces only `claim_ai_lab_topic`, but currently accepts body drift in companion functions such as `start_ai_lab_topic_provider`.

Required correction:
- preflight exact approved definitions/contracts for the four unchanged lifecycle functions:
  - start provider
  - release claim
  - mark ambiguous
  - settle published
- check signature, argument names/order/types where contract-sensitive, language, return type, SECURITY DEFINER, search_path, owner/ACL **and normalized body definition**.
- also recognize the approved old claim definition before first apply and approved new claim definition for idempotent reapply.
- unknown body/contract drift must abort before replacement.
- do **not** rewrite those four companion functions.

Required adverse fixture:
- replace `start_ai_lab_topic_provider` with same signature/owner/return/security/search_path/ACL but body `RETURN true` without state transition.
- applying capacity migration must fail and rollback with claim function unchanged.
- add one positive healthy companion-definition control.

Use a deterministic normalization/fingerprint approach that is stable enough for the supported PostgreSQL versions and documented in tests. Do not trust only function metadata.

## Scope

Keep working on existing PR #109; do not open a replacement PR unless technically unavoidable.

Expected changed files:
- `supabase/migrations/20261007173000_ai_lab_topic_evergreen_capacity.sql`
- `supabase/tests/ai_lab_topic_capacity_run.sh`
- focused migration/adversarial/static tests as needed
- existing invariant test only if required.

Avoid changing:
- `EVERGREEN_TOPIC_SEEDS` content/count/order unless a concrete regression forces it;
- `EVERGREEN_THEME_TAGS`;
- Tier ordering;
- x-test-post runtime;
- brand post store;
- provider outcome;
- scheduler/posting windows;
- G2/G4/G5-owned files;
- Auth/OAuth/Vault/X provider boundaries.

## Mandatory verification

Re-run:
- all new B1/B2/B3 adverse fixtures;
- healthy apply + reapply;
- 74-entry TS/SQL parity;
- 129-candidate/unknown-seed rejection;
- old 7-seed exhaustion;
- real SQL >=14 days x 10/day = 140/140;
- fixed and skewed rotation capacity;
- existing claim proof;
- migration source invariants;
- relevant Deno AI Lab suites;
- explicit `deno check` / lint for changed TS tests;
- `git diff --check`;
- added-line secret scan.

Mutation-style expectation:
- each adverse drift must cause migration failure;
- no partial definition/ACL/table mutation after failure.

## Freshness / isolation

1. Read ORCHESTRATION / ACTIVE_TASK / CURRENT_STATE / this TASK / H1 Report.
2. Use the existing isolated G3 PR109 worktree only if still clean/safe; otherwise make a new independent G3 worktree from fresh `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh-fetch origin/main and PR #109.
4. Require reviewed head `f83247ae1024d4220dfbfa5484c725381d63815d` in PR history.
5. Re-check G2/G4/G5 overlap before editing and before push.
6. No production access/write/apply/deploy/scheduler/OpenAI/X call.

## Completion

Update the existing PR #109.

Report:
- exact new PR head;
- B1/B2/B3 fix summary;
- adverse fixture results;
- healthy apply/reapply;
- capacity result still 140/140;
- accepted topic files byte/semantic stability;
- changed_files;
- tests;
- fresh-main overlap;
- production mutation/deploy/merge = 0.

Then:
- status: review_required
- next_owner: chatgpt
- STOP for K3.

A second focused exact-head Codex rereview is required after this correction.


## Report — ai-lab-topic-continuity-pr109-security-corrective-20261007

- result: **PASS candidate** — B1・B2・B3 を capacity migration の preflight で fail closed にした。PR #109 を更新し、open のまま（GitHub: MERGEABLE）。本番の読み書き 0 / migration 適用 0 / deploy 0 / merge 0 / scheduler 0 / OpenAI・X 0。
- PR #109 head: 旧（レビュー対象）`f83247ae1024d4220dfbfa5484c725381d63815d` → **新 `7c3c06d07c32910472185e1c94b04fa1aab794f5`**。内訳は最新 main の通常 merge `46b3ce5b` と修正コミット 1 つ。rebase / force-push はしていない。
- CI: Vercel だけ「Deployment rate limited — retry in 24 hours」（アカウント全体の制限で、以前から同じ）。コードとは無関係。
- worktree: 既存の `/Users/yuya/Developer/kabumori-g3-ai-lab-continuity`。作業開始時に clean で、レビュー対象の head と一致していることを確認した。

### 修正の要約
いずれも `claim_ai_lab_topic` を置き換える前に評価する。1 つでも外れればファイル全体を取り消し、何も直さない。

- **B1（SET ROLE の経路）**
  - `pg_auth_members` を、anon / authenticated / service_role から再帰的にたどる。
  - 各辺の INHERIT / SET のオプションは問わず、「経路があれば届く」とみなす（PG16 以降の辺ごとの意味にも保守的に対応）。
  - anon / authenticated から次のどれかに届けば拒否する: owner、superuser、service_role、5 つの lifecycle 関数のどれかを実行できるロール、表に何らかの権限（列単位を含む）を持つロール。
  - service_role から owner / superuser に届く場合も拒否する。
  - 既存の owner メンバーシップの検査は維持した。ロールの付け外しは一切しない。
- **B2（前提の表の形）**
  - 20261004090000 の正本の定義を作る関数と、形を比べる関数を **そのままの文字で写し**、pg_temp に正本を作って比較する。
  - 比較の対象: 列・型・NOT NULL・既定値・PK・CHECK の全文・インデックス（キー・述語・一意性・valid / ready / live）・RLS / FORCE・ポリシー数・トリガー数・列 ACL の数。
  - 加えて、表の明示 ACL は owner のみであること、API ロールが実効権限（列単位・継承・PUBLIC を含む）を持たないことも確認する。
  - 以前の弱い部分一致の CHECK 検査は削除した。この migration は表を変えないので、「容量修正前の正しい形」と「再適用時の正しい形」は同じものになる。
- **B3（変更しない 4 関数の中身）**
  - start / release / mark ambiguous / settle の 4 関数について、次をすべて承認済みの値と照合する: 引数（名前・順序・型）、戻り値、plpgsql、SECURITY DEFINER、`search_path=""`、volatility、STRICT でないこと、owner、直接 ACL（owner と service_role の再付与なし EXECUTE 1 件だけ）、**`md5(prosrc)`**。
  - `prosrc` は `$$`〜`$$` の間の文字列がそのまま保存されるので、PostgreSQL のバージョンで変わらない。
  - claim は「容量修正前の本体 `a3cbe667…`」か「この migration の本体 `9aefd06d…`」（再適用時）だけを受け付ける。
  - 置き換えた後の事後条件でも、新しい本体の md5 を固定した。4 関数は書き換えていない。
  - Deno のテストが、期待する md5 を 2 つの migration のソースから計算し直して一致を確認する。

### 異常系の結果（`supabase/tests/ai_lab_topic_capacity_adverse_run.sh`、PG 17）
次の **13 件はすべて拒否** された。どの場合も、カタログの指紋（public の関数の本体と ACL、表の ACL / RLS、列 ACL、制約、インデックスの定義と valid / ready）が適用前と完全に同じで、claim の本体も容量修正前のままだった。

- B1:
  1. `anon -> service_role` を INHERIT FALSE / SET TRUE で付与（anon は直接 EXECUTE できないことも確認したうえで）
  2. `authenticated -> bridge -> service_role` を、SET の経路で付与
  3. 通常の INHERIT TRUE で `authenticated -> service_role`
  - 健全なロール構成は受け付ける（下の健全な場合）。ロールの変更は各ケースの直後と終了時に元に戻し、残っていないことを確認した。
- B2:
  4. PK を削除
  5. 日記の有効性を守る一意インデックスを削除
  6. RLS を無効化
  7. event_key の CHECK を、同じ文字列を含むが中身のない式（`… or true`）に置き換え
  8. 一意インデックスの述語を変更
  9. インデックスを invalid にする
  10. 表への SELECT の付与
  11. 列単位の SELECT の付与
- B3:
  12. `start_ai_lab_topic_provider` を、同じシグネチャ・owner・戻り値・security・search_path・ACL のまま、本体だけ `return true` にする
  13. claim の本体が未知のもの
- 修正前（`f83247ae`）の migration に同じ runner を当てると、最初のケース（B1）で「適用されてしまった」として失敗する。テストが指摘された問題を検出できることを確認した。

### 健全な場合の適用と再適用
- 健全な場合: 適用でき、claim の本体は `9aefd06d…` になる。再適用もできる。4 関数の本体は template と同じ（書き換えられていない）。
- `ai_lab_topic_capacity_run.sh` もすべて PASS:
  - 20261004090000 がない状態での適用は拒否され、何も作られない
  - 適用と再適用ができる
  - 実効 ACL は変わらない
  - 129 件以上の候補と、対応表にない seed は拒否される

### 容量の結果（変更なし）
- 本物の SQL で 14 日 × 10 投稿 / 日 = **140/140**。72 時間・48 時間のクールダウンも守られ、61 種類の seed が使われた。
- 旧来の 7 件は 1 日目で尽きる（10 枠中 6 件確保、4 件が題材切れ）。
- TS のシミュレーションも合格: 本番どおり / 0 で固定 / 偏ったローテーション、28 日間、7 件に 1 件が結果不明になる場合。

### 承認済みの題材ファイルの安定性
- `ai_lab_dev_diary_context.ts` は `f83247ae` から **1 バイトも変えていない**（git diff 0）。
- 次も変えていない: 74 件の seed、0〜6 番、タグ、Tier の順番、x-test-post、brand post store、provider outcome、scheduler。

### 変更ファイル
- `supabase/migrations/20261007173000_ai_lab_topic_evergreen_capacity.sql`（B1 / B2 / B3 の preflight と、claim 本体の事後条件。claim の本体は変更なし = md5 `9aefd06d…` のまま）
- `supabase/tests/ai_lab_topic_capacity_adverse_run.sh`（新規）
- `supabase/functions/_shared/brand/ai_lab_event_dedupe_test.ts`（B1〜B3 の静的テストを追加。既存の migration テストは、pg_temp で写した部分だけを除外して判定するように直した）

### テスト
- 異常系 13/13 の拒否と、健全な場合の適用・再適用。
- 容量の実証はすべて PASS（140/140）。既存の claim の実証も 132 件すべて PASS。
- Deno: x-test-post + _shared + migration の不変条件で 1019/1019（74 件の TS / SQL の対応表の一致、期待する md5 をソースから再計算した一致を含む）。
- 変異確認:
  - 期待する md5 を 1 文字変えると、Deno のテストが失敗する
  - 修正前の migration だと、異常系の runner が失敗する
- `deno check` / `deno lint` クリーン、shell の構文 OK、`git diff --check` クリーン、追加行の秘密情報スキャン 0。

### 最新 main との重なり
- 作業前と push 前に最新の main を取得した。
- 変更ファイルは main 側で変更されていない。
- open な PR（#106 G4 / #33 / #11 / #10 / #3）とも重なりはない。
- G2 / G4 / G5 のファイルには触れていない。

### 本番・ゲート
本番へのアクセス・書き込み・適用・deploy・scheduler・OpenAI・X はすべて 0。merge 0。

### 次
- TASK のとおり、**この修正の head（`7c3c06d0`）に対して、Codex の集中再レビューを 1 回**。
- 本番に適用する順番は前回と同じ（preflight → migration `20261007173000` を単体で適用して読み戻し → x-test-post の deploy）。
- 本番の preflight では、本番のロール構成でこの B1 の検査が通ることも確認する（2026-10-05 の読み取りでは、anon / authenticated / service_role から外向きのメンバーシップは無かった）。
- status → review_required / next_owner → chatgpt。STOP。

---

# Previous G3 task — preserved history

# Claude Task 3 — CURRENT TASK

- task_id: ai-lab-topic-continuity-fix-20261007
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Opus5.5（高）
- type: company AI Lab production-post continuity bugfix / topic-pool capacity / safe fallback
- production_mutation_allowed: false
- deploy_allowed: false
- merge_allowed: false

## User decision

会社員AIラボは、開発日記の題材や通常のevergreen題材が不足しても、`AI_LAB_TOPIC_POOL_EXHAUSTED` だけを理由に投稿を止めない。

優先順位:
1. 実際の最近の開発日記
2. 個人開発・AI活用についての多様なevergreen
3. それでも通常題材が不足する場合は、当たり障りのない「個人開発」「AIを使って作るときの気づき」「AIの進歩を使う側から感じること」等の継続用safe topic

ユーザーの要求は「題材がなければ投稿を止める」ではなく、「安全で無理のない一般話題へフォールバックして投稿を続ける」。

## Confirmed production root cause — read-only evidence

2026-10-07 15:50 JST時点のproduction read-only確認:
- `ai_salaryman_lab` は active/live、brand_post enabled。
- posting_windows は1日10枠、全枠 `daily_probability=1.0`。
- 2026-10-06: 10件予定、9 succeeded、22:19 JSTの10件目が `AI_LAB_TOPIC_POOL_EXHAUSTED`。
- 2026-10-07: 10件予定、15:50時点で実行済み5件がすべて `AI_LAB_TOPIC_POOL_EXHAUSTED`、残り5件pending。
- 失敗はOpenAI/X送信前。X障害・API残高・OAuthが直接原因ではない。
- current production bundleのevergreenは7件のみ。
- DB claim policyは同じevergreen seedを72時間、重なるgeneric themeを48時間cooldown。
- 10/6にfresh diary 3件 + evergreen 6件がpublishedとなり、残り候補もcooldown/既publishで塞がった。
- 10/7の新しい開発日記snapshotはmainにはあるが、現在のproduction x-test-post bundleには未反映。

この容量設計では10投稿/日を継続できない。偶発障害ではなくcapacity bugとして直す。

## Goal A — 3段階topic policy

### Tier 1 — recent dev diary
- 既存どおり、公開安全な直近開発日記を最優先。
- 1 event_id = 1 published event の既存event-level dedupeは維持。
- future/stale/sanitizer fail-closedを弱めない。

### Tier 2 — diverse evergreen
- 現在7件しかない `EVERGREEN_TOPIC_SEEDS` を大幅に拡充する。
- **最低60件**の安定したtopic seedを用意する。
- 同じ意味の言い換えだけで水増ししない。
- カテゴリ例:
  - 本業と個人開発の両立
  - 小さく作る / 直す / 試す
  - 仕様決め・やり直し・バグ修正
  - AIへの指示の出し方
  - 複数AIの役割分担
  - UI/UXを実機で見る重要性
  - テスト・安全確認・失敗からの学び
  - コードが書けなくても作れる側の気づき
  - AIの進歩で以前より出来ることが増えた実感
  - 新しいAIを試すときの期待と戸惑い
  - 自動化しても最後は人が判断する話
  - モデル更新・性能向上を利用者目線で感じる話

### Tier 3 — continuity-safe fallback
- Tier 1/2が通常選択できない状況でも、投稿継続用のsafe topicsを候補末尾に必ず持つ。
- Tier 3は上記60件の中の明確な continuity reserve 区分でも、別の内部配列でもよいが、DB claimの安全性を迂回しない。
- 内容例:
  - 今日少しだけ進める個人開発
  - AIとの試行錯誤
  - 便利になっても指示や確認は必要
  - 最近AIの進歩が速いと感じる、という利用者目線の一般的な感想
  - 自分の作業が少し楽になった/やれることが増えた、という一般論
- 「本日○○が発表された」「最新モデルが○○を達成した」等の具体的な最近のAI事実を、検索・根拠なしで捏造しない。
- このfixでは新しいWeb Search依存を追加しない。外部ニュース取得失敗で投稿継続まで止まる設計にしない。

## Goal B — capacity proof

安全策を雑に無効化して直さない。

原則維持:
- same evergreen seed: 72h cooldown
- generic theme overlap: 48h cooldown
- event-level claim/fencing
- provider_started / ambiguous safety
- X送信前claim
- cross-brand fingerprint duplicate guard
- content diversity guard
- no resend on ambiguous/confirmed provider outcome

evergreen数を増やすため、DB側 `claim_ai_lab_topic` のcanonical evergreen key/tag mappingもsourceと一致させる必要がある。

必要なら新しいforward migration candidateで `CREATE OR REPLACE FUNCTION public.claim_ai_lab_topic...` のcanonical mapだけを拡張する。
- table schema変更は原則不要。
- existing function security/grants/search_path/argument validation/fencing/cooldown semanticsを弱めない。
- G4のsocial_accounts schema taskには触れない。
- production applyは禁止。このTASKはsource/migration candidateまで。

### Mandatory simulation test

「60個あるから多分大丈夫」では不可。

少なくとも以下を自動テストで証明:
- diary候補0件
- 1日10投稿
- 72h seed cooldown
- 48h theme cooldown
- **連続14日以上**
- 各slotで最低1件claimable topicが存在し、`TOPIC_POOL_EXHAUSTED`にならない

必要なら候補数・theme tags配置を調整し、実際のpolicyで成立させる。
rotationが偏っても同一seedへ集中しないことも確認する。

## Goal C — regression boundaries

必須:
- recent diary remains preferred over evergreen/fallback
- one diary event is never published twice
- evergreen seed cooldown remains enforced
- theme cooldown remains enforced where tagged
- simultaneous claim cannot publish same event twice
- provider_started/ambiguous remains non-reopenable
- pre-X generation rejection releases safely
- X no-post typed failure behavior unchanged
- X ambiguous outcome does not auto-retry
- exact/cross-brand duplicate gates remain
- generic fallback still uses AI Lab voice/profile
- schedule generation remains 10 slots/day unchanged
- no change to X OAuth/token/Vault/Auth/common-account/POSTONA settings
- no change to Kabumori report/important-news/MIC paths

## Goal D — source/DB parity

If DB canonical evergreen map is expanded:
- TS `EVERGREEN_TOPIC_SEEDS` / `EVERGREEN_THEME_TAGS`
- DB `c_evergreen_tags`
must remain exactly aligned.

Add an invariant/static test so a future seed addition cannot update only one side.

## Scope candidates

Expected:
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts`
- related AI Lab topic tests
- one new migration replacing `claim_ai_lab_topic` canonical evergreen mapping if required
- migration/static/disposable proof tests directly related to this function

Possible only if necessary:
- `supabase/functions/_shared/brand/ai_lab_brand_post_store.ts`
- `supabase/functions/x-test-post/index.ts`

Do not touch:
- G4 social_accounts migration candidate/files
- G5 common-account native/Auth files
- G2 market-report rollout files
- POSTONA multi-social provider schema
- unrelated X report generation/model policy
- important-news/MIC/Kabumori app model files
- scheduler frequencies/posting windows unless a test proves they are broken.

## Startup / isolation

1. Read ORCHESTRATION / ACTIVE_TASK / CURRENT_STATE / this TASK.
2. Use fresh `/Users/yuya/Developer/kabumori-fresh` as clean base.
3. Fresh-fetch `origin/main`.
4. Create a new independent G3 worktree/checkout; do not reuse the completed GPT-6 task worktree.
5. Confirm G4/G5/G2 intended files have no overlap before editing.
6. Before push, refresh `origin/main` again and re-check overlap.

## Testing

At minimum:
- existing AI Lab dev diary/topic candidate tests
- event dedupe/claim tests
- scheduled AI Lab dispatch tests
- provider outcome tests
- new >=14-day 10-post/day exhaustion simulation
- source/DB canonical mapping parity
- migration SQL static/disposable proof if function changes
- relevant x-test-post tests if runtime file changes
- Deno check/lint for touched modules
- git diff --check
- added-line secret scan

No real OpenAI/X call.
No production DB write.
No deploy.
No scheduler invoke.

## PR / completion

Create a dedicated PR. Do not merge.

Report:
- exact root cause
- before/after topic counts and categories
- exact cooldown semantics retained/changed
- 14-day simulation result
- DB function/migration changes
- changed_files
- tests
- branch/commit/PR/head
- fresh-main overlap check
- production mutation/deploy = 0
- whether current production can still fail until migration+deploy are separately rolled out
- recommended rollout order

Then:
- status: review_required
- next_owner: chatgpt
- STOP for `K3`.

Because a SECURITY DEFINER claim function/migration may be changed, expect K3 to require one focused Codex review unless implementation proves no DB function change was necessary.

## Report — ai-lab-topic-continuity-fix-20261007

- result: **PASS candidate (source + migration candidate)** — 題材切れで投稿が止まる問題を、題材の容量を増やすことで直した。PR #109 を作成して open のまま。本番の読み書き 0 / deploy 0 / migration 適用 0 / scheduler 実行 0 / 実際の OpenAI・X の呼び出し 0 / merge 0。
- branch / commit / PR / head: `claude/g3-ai-lab-topic-continuity-20261007` / `f83247ae` / [anohi-memories/kabumori#109](https://github.com/anohi-memories/kabumori/pull/109) / `f83247ae`。
- CI: Vercel だけ「Deployment rate limited — retry in 24 hours」（アカウント全体の制限で、他の PR も同じ）。コードとは無関係。
- worktree: 新規 `/Users/yuya/Developer/kabumori-g3-ai-lab-continuity`（GPT-6 の作業の worktree は再利用していない）。

### 原因
- evergreen が **7件しかない** 状態で、「同じ seed は72時間」「同じテーマは48時間」のクールダウンをかけると、1日10投稿は続かない。
- 10/6 は日記3件と evergreen 6件で枠を使い切り、10件目から `AI_LAB_TOPIC_POOL_EXHAUSTED` になった。10/7 も同様。OpenAI や X に送る前の段階で止まっている。
- 偶然の障害ではなく、容量の設計不足。
- TS のモデルでも、本物の SQL でも、「7件の題材だけでは同じルールで 1 日目のうちに尽きる」ことを再現した（SQL では 10 枠中 6 件確保、4 件が題材切れ）。

### 題材の数とカテゴリ（前 → 後）
- 前: 7 件（タグ付き 3、タグなし 4）。
- 後: **74 件**（`evergreen-0`〜`evergreen-73`。テーブルの CHECK により上限は 99）。
  - 0〜6: 既存の 7 件。文章も添字もタグも変えていない（DB の行は添字で題材を指すため）。
  - 7〜61: **Tier 2 の多様な evergreen 55 件**（Tier 2 は既存と合わせて 62 件）。カテゴリと件数:
    - 本業との両立 5
    - 小さく作る・試す 5
    - 仕様決め・やり直し・バグ修正 5
    - AI への指示の出し方 5
    - 複数 AI の役割分担 4
    - 実機で UI を確かめる 5
    - テスト・安全確認・失敗からの学び 5
    - コードが書けなくても作れる 5
    - AI の進歩で出来ることが増えた実感 4
    - 新しい AI を試すときの期待と戸惑い 4
    - 自動化しても最後は人が判断 4
    - モデル更新を利用者目線で 4
  - 62〜73: **Tier 3 の継続用の予備 12 件**（`AI_LAB_CONTINUITY_RESERVE_START = 62`）。当たり障りのない一般的な振り返りで、候補の一番最後に置く。
- 追加した 67 件は、テーマ判定のパターン（地味・試行錯誤・手戻り・個人開発は大変・進んでいない・調べるだけ・コードを書かない）に当たらない言い回しにし、テーマタグも付けていない（72 時間の seed クールダウンだけで管理）。
- 「本日」「発表」「達成」「最新モデル」、具体的なモデル名や年などの、根拠のない最近の事実は書いていない（テストで確認）。重複なし。
- Web 検索への依存は増やしていない。

### クールダウンの扱い（変更なし）
次の安全策はどれも変えていない。
- 同じ seed: published から 72 時間
- 同じテーマ: published から 48 時間
- 未解決（claimed / provider_started / ambiguous）の seed とテーマ: 時間に関係なく隔離
- 日記イベントは一度きり
- ブランド単位の advisory lock
- 候補は全件を先に正規の形で検証する
- lease の fencing
- X の前に provider_started を確定する
- ブランド横断の fingerprint、内容の多様性ガード
- 結果不明・確定済みの X 投稿は再送しない

変えたのは次の 2 点だけ。
- 候補の順番: 新しい日記 → Tier 2（rotationIndex で回す）→ Tier 3（同じく回す。常に最後）
- 1 回の呼び出しの候補数の上限: 64 → **128**。TS 側も 128 件で切り、切った分は `CLAIM_CANDIDATE_LIMIT` として除外ログに残す。日記が先頭にあるので、切れるのは優先度の低い evergreen だけ。今の題材数では切れることはない。

### 14 日間のシミュレーション結果（日記 0 件、1 日 10 投稿）
- 本物の SQL（`supabase/tests/ai_lab_topic_capacity_run.sh`）: 実際の `claim_ai_lab_topic` / start / settle を通し、毎枠の前にすべての時刻を 2.4 時間戻して時間の経過を再現した。候補は本番の TS の builder がそのまま作ったもの。
  - **140/140 件を確保、題材切れ 0 件**
  - 同じ seed を 72 時間以内に使い回した例は 0 件、同じテーマを 48 時間以内に重ねた例も 0 件
  - 使われた seed は 61 種類
- TS のモデル（SQL の写しの `ClaimDb`）:
  - 14 日間を、ローテーションが本番どおり / 0 で固定 / ばらばら の 3 通りで回し、どれも題材切れ 0 件
  - 各 seed の再利用は 72 時間以上空いていて、1 つの seed の使用回数は上限（5 回）以内。偏りはない
  - 28 日間でも 0 件
  - 7 件に 1 件 X の結果が不明（永久に隔離）になる場合の 14 日間でも 0 件
  - 通常の運用では Tier 3 の使用は 0 件で、Tier 2 がすべてクールダウン中のときにだけ Tier 3 を確保する

### DB の関数と migration の変更
- 新しい migration `20261007173000_ai_lab_topic_evergreen_capacity.sql`（候補。未適用）。
  - 当初は `20261007120000` にしたが、main 上の G2 の `20261007120000_market_report_generation_traces.sql` と番号が衝突したため変更した。G4 の PR #106 の `20261007150000` とも別の番号。
  - `claim_ai_lab_topic` だけを `create or replace` する。正規の対応表を 74 件にし、候補の上限を 128 にした。
  - **関数のそれ以外の部分は `20261004090000` と完全に同じ**（テストで、対応表と上限を除いた本体が一致することを確認）。
  - preflight は元と同じ: owner の方針、API ロールの継承、overload の検査。加えて次を確認する: `20261004090000` が適用済みであること、event_key の CHECK が想定どおりであること。
  - 事後条件は元と同じで、5 つの関数とテーブルの owner と実効権限（継承・PUBLIC・列単位の権限を含む）を検証する。テーブルの変更はなく、`create or replace` は 1 つだけ。
- TS と SQL の対応表の一致: `EVERGREEN_TOPIC_SEEDS` / `EVERGREEN_THEME_TAGS` と、新しい migration の `c_evergreen_tags` が完全に一致し、元の 7 件の対応も残っていることをテストで確認。片方だけ更新すると失敗する。

### 変更ファイル
- `supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts`（題材、Tier 3、候補の順番と上限）
- `supabase/functions/_shared/brand/ai_lab_event_dedupe_test.ts`（DB の写しの上限、整合テスト、容量・優先順・品質・migration 差分のテストを追加。既存の 2 件は「7 件前提」の数値だけ直した）
- `supabase/migrations/20261007173000_ai_lab_topic_evergreen_capacity.sql`（新規）
- `supabase/tests/ai_lab_topic_capacity_run.sh`（新規）
- `supabase/tests/migration_source_invariants_test.ts`（新しい番号を予約一覧に追加）

`ai_lab_brand_post_store.ts`・`x-test-post/index.ts`・スケジュール・posting_windows・X 認証・POSTONA・G2 / G4 / G5 のファイルは変更していない。

### テスト
- Deno: x-test-post + _shared で 1007/1007（新しいテストを含む。`--allow-run` 付き）。
- 本物の DB:
  - 容量の実証はすべて PASS（前提なしでの適用拒否、適用と再適用、実効権限は変わらない、129 件以上の候補と対応表にない seed は拒否、14 日間で 140/140、旧 7 件は 1 日目で尽きる）
  - 既存の claim の実証も 132 件すべて PASS
- migration の不変条件 11/11。
- `deno check` / `deno lint` クリーン、`git diff --check` クリーン、追加行の秘密情報スキャン 0。

### 最新 main との重なりの確認
push の直前に最新の main を取り込んだ。
- 変更ファイルの重なりは 0。
- migration の番号の衝突は上のとおり解消済み。
- open な PR #106（G4）/ #33 / #11 / #10 / #3 とも変更ファイルの重なりは 0。

### 本番がまだ失敗し得るか、適用の順番
- **merge しただけでは本番は直らない。** 本番は 7 件の bundle のままなので、10 投稿 / 日の題材切れは、適用と deploy まで続く。
- 推奨の順番:
  1. 本番の preflight（読み取りのみ）: `20261004090000` が適用済みで関数の形が想定どおりであること、owner の方針、ai_lab_topic_claims の未解決の行の数を確認する。
  2. migration `20261007173000` を単体で適用し、読み戻す（関数の本体の md5・ACL・対応表 74 件）。
  3. `x-test-post` を deploy し直し、bytes を検証する。10/7 の開発日記の snapshot も一緒に入る。他の未 deploy の PR が bundle に入るかを事前に差分確認すること。
- **逆の順番（deploy を先にする）は不可。** 新しい bundle が 65 件以上の候補や evergreen-7 以降を送ると、古い DB 関数が `INVALID_ARGUMENT` で全件を拒否し、すべての枠が失敗する。

### レビュー
SECURITY DEFINER の claim 関数を置き換えるので、TASK のとおり **集中レビュー 1 回** を想定している。差分は対応表と上限の 2 点だけで、テストで固定してある。

- status → review_required / next_owner → chatgpt。STOP。

---

# Previous G3 task — preserved history

# Claude Task 3 — CURRENT TASK

- task_id: x-social-ai-model-policy-gpt6-upgrade-20261007
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- type: source-only AI model upgrade / centralized social-post model policy / POSTONA + AI Lab + Kabumori X
- production_mutation_allowed: false
- deploy_allowed: false
- merge_allowed: false

## User decision

This G3 owns **X auto-post AI only**.

In scope:
1. POSTONA / social-mobile
2. 会社員AIらぼ / AI Lab automatic posts
3. かぶモリ X automatic-post AI paths

Out of scope:
- Kabumori app market-report-analysis/personalized-report model migration owned by G2;
- important-news-monitor / breaking-market model migration;
- MIC;
- unrelated app/backend AI;
- image-generation model upgrades.

Current user direction:
- Luna current target = `gpt-6-luna`
- Sol current target = `gpt-6.1-sol`
- future model releases should be easy to adopt without searching dozens of runtime files.

Official API pricing verified 2026-10-07:
- `gpt-6-luna`: $0.10 / 1M input tokens, $0.50 / 1M output tokens
- `gpt-6.1-sol`: $2.00 / 1M input tokens, $10.00 / 1M output tokens

Do not use stale 5.6 pricing after the migration.

## Current production/source inventory

Production project: `stock-x-autopost`.

Observed production:
- `x-test-post` v136 contains `gpt-5.6-luna` and `gpt-5.6-sol`;
- `social-mobile-brand-dry-run` v14 imports brand generator with `gpt-5.6-luna`;
- `brand-post-dry-run` also uses the shared brand generator and therefore 5.6 Luna;
- `social-mobile-consult` is **not deployed yet**; main source currently uses `gpt-5.6-luna`;
- `social-mobile-history-learning` uses **no OpenAI text model**; it derives persona signals mechanically from bounded X history;
- `social-mobile-publish-setting` uses no OpenAI model.

Main source:
- `supabase/functions/social-mobile-consult/logic.ts`: `gpt-5.6-luna`
- `supabase/functions/_shared/brand/brand_post_generator.ts`: `gpt-5.6-luna`
- `supabase/functions/x-test-post/index.ts`: many `gpt-5.6-luna` call sites plus selected `gpt-5.6-sol` escalation paths
- `supabase/functions/x-test-post/report_voice_rewrite_logic.ts`: `gpt-5.6-luna`
- `supabase/functions/x-test-post/useful_tip_generation_logic.ts`: 5.6 Luna/Sol model union
- `supabase/functions/x-test-post/morning_greeting_logic.ts`: 5.6 Luna
- `gpt-image-2` is image generation and is deliberately not part of this text-model migration.

## Goal A — one source of truth

Create a small shared X/social AI model policy module, preferred location:

`supabase/functions/_shared/social_ai_model_policy.ts`

A different nearby shared location is allowed only if import/tooling constraints make it materially safer.

The purpose is that future model migration should normally require changing **one policy module**, not hunting literals throughout POSTONA / AI Lab / Kabumori X runtime.

Design should separate:

### Model catalog / tier

At minimum:
- FAST / routine text tier -> `gpt-6-luna`
- QUALITY / Sol escalation tier -> `gpt-6.1-sol`

Each text model entry should own:
- API model id;
- input price per 1M;
- output price per 1M;
- any capability metadata actually required by existing callers, but no speculative complexity.

### Workload policy

Use semantic workload names so callers do not know raw model ids.

At minimum cover:
- POSTONA consultation;
- generic social-mobile/brand post generation;
- AI Lab brand post generation;
- Kabumori X default text generation;
- Kabumori X web-search collection text model where part of x-test-post;
- Kabumori X voice evaluation;
- Kabumori X voice rewrite;
- useful-tip base generation;
- useful-tip quality escalation;
- US premarket base/quality escalation or any equivalent existing Sol escalation.

If multiple workloads intentionally share the same tier, map them explicitly.

## Important policy constraint

Do **not** introduce a silent unrestricted production environment-variable override that can change every live model without source review.

The user's goal is easy future version upgrades, not an unaudited runtime switch.

Preferred contract:
- model ids/prices/workload mapping are centralized in one source-controlled policy;
- future release changes the policy in one place and redeploys the relevant Edge Functions;
- tests prove runtime files do not drift back to raw text-model literals.

If there is already a project-standard reviewed config mechanism that is clearly safer, document before using it. Do not invent a broad dynamic override.

## Goal B — actual model migration

Within X/social-auto-post scope only:

- every routine `gpt-5.6-luna` runtime call -> policy resolving to `gpt-6-luna`;
- every existing `gpt-5.6-sol` quality/escalation runtime call -> policy resolving to `gpt-6.1-sol`;
- if an X/social runtime path already uses a newer valid model, preserve it unless this policy should own it;
- do not migrate non-X Kabumori app/report/news/MIC paths.

### POSTONA

Must cover:
- `social-mobile-consult`;
- generic `brand_post_generator`;
- generic live scheduled-user generation added by merged PR #41;
- social-mobile brand dry-run;
- brand-post dry-run where it reuses the same generic brand generator.

AI consultation should therefore launch for the first time on `gpt-6-luna`, never 5.6.

### AI Lab

AI Lab scheduled brand-post generation currently reaches the shared brand generator.
Prove its generated text resolves to `gpt-6-luna`.

Do not alter:
- AI Lab topic claim/dedupe;
- diary context;
- X auth;
- publish permission;
- schedule/brand settings.

### Kabumori X auto-post

Update the **X auto-post AI calls in x-test-post and its direct shared helpers**, including:
- normal text generation;
- interaction posts;
- useful tips;
- morning/close/US-premarket legacy generator paths that remain inside x-test-post;
- web-search collection model calls owned by x-test-post;
- voice evaluation;
- voice rewrite;
- preview/test generation paths that use production text-model policy.

Existing Luna->Sol escalation semantics remain the same; only the model tier target changes.

Do not alter prompts, post schedules, X auth, publish gates, Fact/voice thresholds, retry count, call ceiling or output contract merely because the model id changed.

## Goal C — cost/accounting correctness

Replace 5.6-specific cost tables/types in X/social-auto-post scope with the shared policy/catalog.

Requirements:
- one cost helper reads the selected model's centralized token rates;
- `gpt-6-luna` calculation uses 0.10 input / 0.50 output per 1M;
- `gpt-6.1-sol` uses 2.00 / 10.00;
- existing web-search per-tool-call fees remain separate and unchanged;
- diagnostics/model_used fields must record the actual selected API id;
- remove stale 5.6-only unions and comparisons;
- do not silently report a 6-series call at 5.6 pricing.

## Goal D — drift prevention

Add a focused static/invariant test for the X/social-auto-post runtime scope.

It should fail if:
- `gpt-5.6-luna` or `gpt-5.6-sol` returns to targeted runtime source;
- a raw social text model id such as `gpt-6-luna` / `gpt-6.1-sol` is newly hard-coded outside the central policy module, except a narrowly documented fixture/test case if unavoidable;
- cost/type logic diverges from the policy.

Do **not** scan unrelated G2/news/MIC source and fail on their separately-owned model decisions.

`gpt-image-2` is not a violation.

## Goal E — API compatibility

Before changing source, confirm the current Responses API bodies used by these social/X paths are supported by:
- `gpt-6-luna`;
- `gpt-6.1-sol` for the paths that actually use Sol.

Preserve current reasoning effort unless incompatible.
If a 6.1 Sol request shape needs a mechanical compatibility adjustment, keep it minimal and add a test.

No real OpenAI calls are allowed in this task.

## Scope / likely files

Allowed primary runtime:
- `supabase/functions/_shared/social_ai_model_policy.ts` (new preferred)
- `supabase/functions/social-mobile-consult/logic.ts`
- `supabase/functions/_shared/brand/brand_post_generator.ts`
- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/report_voice_rewrite_logic.ts`
- `supabase/functions/x-test-post/useful_tip_generation_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_logic.ts`
- directly related X/social model-policy tests

Additional X/social runtime files may be changed only when fresh inventory proves they contain an actual text-model literal/type/cost dependency.

Do not touch G2-owned market-report-analysis/personalized-reports model files.

## Coordination / isolation

1. Read ORCHESTRATION / ACTIVE_TASK / CURRENT_STATE / this TASK.
2. Fresh-fetch `origin/main` from `/Users/yuya/Developer/kabumori-fresh`.
3. Use a new independent G3 worktree.
4. Read current G4 and G5 TASK/Report before editing.
5. Current G4 provider-domain foundation must remain independent; do not edit its provider-domain files.
6. G5 production migration work has project-wide production priority.
7. This task is source-only: no production mutation window.
8. Before push, fresh-fetch main and verify changed-file overlap with active G4/G5/G2.
9. Any overlap with another slot's in-progress product file => STOP rather than overwriting.

## Tests

At minimum prove:

### Central policy
- POSTONA consult -> `gpt-6-luna`
- generic/AI Lab brand generator -> `gpt-6-luna`
- Kabumori X default/voice/rewrite -> `gpt-6-luna`
- existing quality escalation -> `gpt-6.1-sol`
- exact price calculation for both tiers
- selected model id is emitted in diagnostics

### POSTONA
- consult request body model is policy-selected Luna
- one call/send remains unchanged
- brand generator request body model is policy-selected Luna
- remembered content settings/persona flow unchanged
- dry-run and live generic generator share the same policy

### AI Lab
- AI Lab scheduled generation still uses generic brand generator and therefore policy Luna
- topic/dedupe/provider outcome behavior unchanged

### Kabumori X
- useful-tip Luna-first / Sol-escalation behavior unchanged semantically
- US-premarket conditional Sol escalation unchanged semantically
- voice evaluation/rewrite model updated via policy
- morning/close/interaction/tip generation paths no longer embed old 5.6 ids
- web-search collection behavior/call count unchanged
- gpt-image-2 remains unchanged

### Drift/static
- no targeted runtime `gpt-5.6-luna` / `gpt-5.6-sol`
- no social text-model literals outside policy
- unrelated G2/news/MIC paths are not accidentally rewritten

Run relevant:
- social-mobile-consult tests;
- brand_post_generator tests;
- AI Lab scheduled brand post tests;
- x-test-post focused/full feasible Deno suite;
- static/invariant test;
- deno check/lint on changed files;
- git diff --check;
- added-line secret scan.

No real OpenAI, X, DB mutation or provider calls.

## Production / deploy / merge

Forbidden in this G3:
- Edge deploy;
- production DB read/write;
- migration/history apply;
- X post;
- model/provider live smoke call;
- secret/config mutation;
- PR merge.

Create/update a dedicated PR and stop for K3.

At K3:
- verify exact changed files and CI;
- decide merge;
- normally **no Codex review** is needed if changes are only centralized model policy/model ids/costs/types/tests and no Auth/DB/permission boundary changed;
- if the implementation unexpectedly changes retry/security/publish behavior, K3 may allocate one focused review.

## Completion report

Include:
- fresh main / branch / PR / head;
- every targeted runtime model before -> after;
- central policy design;
- model-id literal drift test;
- cost-rate proof;
- POSTONA proof;
- AI Lab proof;
- Kabumori X proof;
- G2/G4/G5 overlap check;
- tests;
- production mutation/deploy/real OpenAI/X = 0;
- remaining deployment functions that must be updated later;
- whether any review is actually needed.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Recommended model: **Opus5.5（高）**.

## Report — x-social-ai-model-policy-gpt6-upgrade-20261007

- result: **PASS candidate (source-only)** — X / ソーシャル自動投稿の文章 AI を、中央のポリシーで `gpt-6-luna` / `gpt-6.1-sol` に切り替えた。PR を作成して open のまま。本番の読み書き 0 / deploy 0 / 実際の OpenAI・X の呼び出し 0 / merge 0。
- fresh main: `4e8e8c5c`（この TASK の in_progress コミット）。push 前に最新 main を再取得し、同じファイルの変更がないことを確認した。
- branch / PR / head: `claude/g3-social-ai-model-policy-20261007` / [anohi-memories/kabumori#105](https://github.com/anohi-memories/kabumori/pull/105) / `78a43ae8`。
- CI: Vercel だけ「Deployment rate limited — retry in 24 hours」。直近の PR #99 / #100 / #101 も同じで、アカウント全体の回数制限によるもの。コードとは無関係。netlify は pass / skip。
- worktree: 新規 `/Users/yuya/Developer/kabumori-g3-model-policy`。

### 実行コードのモデル（変更前 → 変更後。すべて中央のポリシー経由）
| 呼び出し箇所 | workload | 前 → 後 |
|---|---|---|
| `social-mobile-consult/logic.ts` `CONSULT_MODEL` | postonaConsult | 5.6-luna → gpt-6-luna |
| `_shared/brand/brand_post_generator.ts` `MODEL`（POSTONA のプレビューと本番、brand dry-run、AI Lab） | brandPostGeneration | 5.6-luna → gpt-6-luna |
| x-test-post: generatePostParts / 交流投稿 / 投稿予定のプレビュー / 朝・引けレポートの文章作成 / 作成ログの model_used / draft.model | kabumoriXText | 5.6-luna → gpt-6-luna |
| x-test-post: 朝・引け・米国市場前の Web 検索による材料集め（3 か所） | kabumoriXWebSearchCollection | 5.6-luna → gpt-6-luna |
| x-test-post: evaluateKabumoriVoice（呼び出しと料金） | kabumoriXVoiceEvaluation | 5.6-luna → gpt-6-luna |
| `report_voice_rewrite_logic.ts` `REPORT_VOICE_REWRITE_MODEL`（と書き直しの料金） | kabumoriXVoiceRewrite | 5.6-luna → gpt-6-luna |
| `morning_greeting_logic.ts` `MODEL` と結果の型 | kabumoriXMorningGreeting | 5.6-luna → gpt-6-luna |
| 有用 tips: 最初の試行 / Sol への昇格 | usefulTipBase / usefulTipQualityEscalation | 5.6-luna → gpt-6-luna / 5.6-sol → gpt-6.1-sol |
| 米国市場前の文章作成（`packet.requires_sol` の条件は変更なし）、作成ログの初期値 | usPremarketBase / usPremarketQualityEscalation | 5.6-luna → gpt-6-luna / 5.6-sol → gpt-6.1-sol |

`gpt-image-2` は変更なし。G2（market-report-analysis / personalized-reports）、ニュース監視、MIC には触れていない。

### 中央ポリシーの設計（`supabase/functions/_shared/social_ai_model_policy.ts`）
- モデル表（catalog）: `fast` = gpt-6-luna（$0.10 / $0.50）、`quality` = gpt-6.1-sol（$2 / $10、100 万トークンあたり）。各モデルが API の id と料金を持つ。
- 処理 → 層の対応表（workload → tier）: 11 個の処理名を明示的に割り当てた。同じ層を使う処理も、1 つずつ別に書いてある。呼び出し側はモデルの id を知らず、`socialTextModel(処理名)` を使う。
- 補助関数: `isSocialQualityTextModel`（診断用の「Sol に昇格したか」）、`socialTextModelTokenCostUsd`（丸めない）、`socialTextModelCostUsd`（小数 6 桁に丸める）。表にないモデルを渡すとエラー。
- 環境変数でモデルを切り替える仕組みは作っていない。今後のモデル更新は、このファイルを変えて関係する関数を deploy し直す。

### モデル名の直書きを防ぐテスト（`social_ai_model_policy_test.ts`）
- X / ソーシャルの実行コード（x-test-post、_shared/brand、social-mobile-consult / brand-dry-run / history-learning / publish-setting。テストは除く）を走査して、次があれば失敗する:
  - `gpt-5.6-luna` / `gpt-5.6-sol`
  - ポリシー以外での `gpt-…-luna` / `gpt-…-sol` の直書き
  - ファイルごとの料金表（`/ 1_000_000` や `{ input: 0.2, output: 1.2 }` のような書き方）
- 配線の確認:
  - 相談・ブランド生成・書き直し・朝のあいさつがポリシーを使っている
  - POSTONA のプレビューと本番、AI Lab は共通の生成部だけを通り、独自にモデルを選ばない
  - Web 検索の材料集めは 3 か所のまま
  - Sol への昇格条件は 2 つとも変わっていない
  - `gpt-image-2` は変わっていない
- 変異確認: 次の 4 通りに壊すと、いずれもテストが失敗する。
  - 5.6 のモデル名を戻す
  - 6 系のモデル名を直書きする
  - 料金表を直書きする
  - Sol への昇格先を変える
- G2 / ニュース / MIC は走査しない（担当外のモデルの決定で失敗しないように）。

### 料金の正しさ
- Luna で入出力 100 万トークンずつ = $0.6、Sol = $12。150 / 90 トークンなら Luna $0.00006、Sol $0.0012。
- 古い料金（1.4 / 35）にはならない。
- `modelCostUsd` はポリシーの料金だけを読む。5.6 用の料金表（Luna 0.2/1.2、Sol 5/30）と、5.6 のモデル名に固定した型（union）・比較は削除した。
- Web 検索を使うレポート（朝・引け・米国市場前）は、材料集めのモデル料金 + 検索料（1 回 $0.01、変更なし）+ 文章作成のモデル料金を合計して、最後に 1 回だけ丸める（新しい `reportApiCostUsd`）。
- 診断の `model` / `model_used` / `escalatedToSol` には、実際に選んだ API の id が入る。

### POSTONA の証明
- 相談: リクエストの `body.model` は `CONSULT_MODEL`（ポリシーの Luna）。既存の logic_test で確認。1 回の送信で呼ぶのは 1 回のままで、テスト全体が合格。
- ブランド生成: リクエストの model と `draft.model` がポリシーの Luna で、料金はその料金表から計算される。
- プレビューと本番の利用者投稿は、同じ `generateBrandPost` を使う（配線テスト）。
- 記憶した設定・文体の流れは変更なし（PR78 の memory-generation を含むアプリのテスト 226/226）。

### AI Lab の証明
- AI Lab の予約投稿は、共通のブランド生成を通る（配線テスト）。
- `brand_post_generator_test` の AI Lab のテストで、`draft.model` = ポリシーの Luna、料金 = ポリシーの料金表で 150 / 90 トークン分であることを確認。
- topic の claim・重複排除・provider outcome のテストはすべて合格（_shared 全体）。

### かぶモリ X の証明
- 有用 tips: 「Luna を先に試し、だめなら Sol に昇格」の順序と、昇格時の 2400 トークンは変更なし。昇格先だけがポリシーの quality。
- 米国市場前: `packet.requires_sol` の条件で quality / base を選ぶ（変更なし）。
- 声色の評価・書き直しはポリシー経由。朝・引け・交流・tips・プレビューに 5.6 の名前は残っていない（ドリフトのテスト）。
- Web 検索の回数・設定（max_tool_calls / search_context_size / include）は変更なし。
- x-test-post 全体のテストが合格。

### API の互換性（公式ドキュメントのみで確認、実際の API 呼び出しはなし）
- `gpt-6-luna`（[model page](https://developers.openai.com/api/docs/models/gpt-6-luna)）: reasoning.effort none / low / medium / high / xhigh / max。Responses API で `web_search` と構造化出力に対応。料金は $0.10 / $0.50。
- `gpt-6.1-sol`（[model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)）: reasoning.effort low / medium / high / xhigh / max（none と minimal は非対応）。Responses API で `web_search` と構造化出力に対応。料金は $2 / $10。
- 現在のリクエストは、Sol も含めてすべて `effort: "low"` なので、どちらも対応している。リクエストの形は変えていない。

### G2 / G4 / G5 との重なり
- 変更した 11 ファイルについて:
  - main 側で同じファイルの変更はない
  - open な PR（#101 / #100 / #33 / #11 / #10 / #3）とも重なりなし
- G2 の report のモデル用ファイル、G4 の provider-domain のファイル、G5 の app / auth / migration には触れていない。

### テスト
- `social_ai_model_policy_test.ts` 6/6。
- Deno: x-test-post + _shared + social-mobile-consult + brand-dry-run で 1025/1025（`--allow-run` を付けて実行）。
- アプリ（social-mobile）226/226。
- `deno check`: 変更したファイルに新しいエラーはない。x-test-post の既存の型エラー 6 件は main と同じ。
- `deno lint` 7 ファイルともクリーン、`git diff --check` クリーン、追加行の秘密情報スキャン 0 件。

### 本番・ゲート
Edge deploy 0、本番 DB の読み書き 0、migration 0、X 投稿 0、モデルを実際に呼ぶ確認 0、secret・設定の変更 0、merge 0。

### 後で deploy し直しが必要な Edge Function
- `x-test-post`（かぶモリ X、AI Lab、POSTONA の本番利用者投稿）
- `social-mobile-brand-dry-run`
- 本番の `brand-post-dry-run`（repo には同名のフォルダがない。同じブランド生成部を bundle している場合は、同じく deploy し直す）
- `social-mobile-consult`（まだ deploy していない。最初の deploy から gpt-6-luna で動く）

x-test-post の deploy では、それまでに merge 済みでまだ deploy していない PR の変更もまとめて入るので、deploy の前に graph の差分を確認すること。

### レビュー
- 変えたのはモデルの id、料金、型、テスト、中央のポリシーだけ。Auth / DB / 権限の境界、リトライ、送信のガード、プロンプトは変更していない。
- このため、**追加のレビューは不要の見込み**（TASK の方針どおり）。
- status → review_required / next_owner → chatgpt。STOP。


## Final K3 — GPT-6 social AI model policy — 2026-10-07

- verdict: **PASS / MERGED / G3 CLOSED**.
- accepted PR head: `78a43ae878205f726111dde1002bd28ea8e82b97`.
- squash merge: `9e359b3e600196fa0602ccd4162d125d613ebbb9`.
- accepted scope: X/social auto-post AI only (POSTONA, AI Lab, Kabumori X); 11 runtime/test files. G2 app/report/news/MIC and image generation were not changed.
- model policy: routine social text -> `gpt-6-luna`; existing quality escalation -> `gpt-6.1-sol`; model ids, token pricing and workload mapping are centralized with drift tests.
- independent K3 check: OpenAI official model catalog confirms the selected model IDs, standard prices ($0.10/$0.50 for Luna and $2/$10 for Sol per 1M input/output tokens), Responses API support, and `reasoning.effort: low` compatibility.
- tests accepted: policy 6/6, Deno social/X suite 1025/1025, social-mobile app 226/226, lint/diff/secret checks clean; only the reported pre-existing x-test-post type diagnostics remain unchanged from main.
- CI: Netlify success. Vercel failure is the repository/account build-rate-limit condition and is not attributed to this source change.
- Codex review: **not required**. Diff is limited to model selection, centralized pricing/types and drift tests; no Auth/DB/RPC/permission/publish/retry/prompt boundary changed.
- production mutation/read/deploy/real OpenAI/X call: **0** during this task.
- important runtime state: **source is merged, but production text models are not upgraded yet**. Existing deployed Edge Functions remain on their previously deployed bundles until a separately gated redeploy.
- later redeploy set: `x-test-post`, `social-mobile-brand-dry-run`, production `brand-post-dry-run` if present, and first deploy of `social-mobile-consult`. Before `x-test-post` deploy, inspect the full bundled graph because other merged-but-not-deployed changes may ride along.
- next step: production rollout is a separate G3 task only after current G5 production-priority/gating is clear; no deploy is authorized by this K3.
- AI Lab diary: 候補あり — AIモデルの世代更新を楽にするため、モデルと料金の設定を1か所にまとめ、古い設定の直書きが戻ったらテストで気づけるようにした。

---

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr41-acl-corrective-20261007
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- type: bounded security corrective / effective column privileges / exact RPC ACL
- target_pr: 41
- previous_head: 280aa0f83d4f039ba3e43f32da202a91fd2333f2
- h2_review: x-social-mobile-pr41-live-generation-security-review-20261007
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## C2 accepted findings

H2 reviewed exact PR #41 head:
`280aa0f83d4f039ba3e43f32da202a91fd2333f2`

Verdict: **CHANGES REQUIRED**.

Only two blocking findings are in scope for this corrective.

### R1 — P2 effective column privilege drift

Target migration:
`supabase/migrations/20261006160100_social_mobile_publish_settings_reader.sql`

Current postcondition checks table privilege but can miss column-level grants.

Reproduced H2 case:
- an effective column SELECT on `social_mobile_content_settings.settings` is granted to service_role before migration;
- table-level SELECT remains false;
- migration currently COMMITs;
- service_role can directly read settings rows cross-brand, bypassing the narrow reader.

Required correction:
- migration must fail closed if service_role has **any effective column privilege that violates the intended table denial**, including privilege inherited through another role or PUBLIC;
- inspect every live column, not only `settings`;
- cover at least SELECT / INSERT / UPDATE / REFERENCES or the full set of column privileges PostgreSQL exposes for this relation;
- preserve legitimate authenticated client privileges from PR81; do not globally revoke/repair unrelated ACLs;
- do not silently normalize unknown column ACL drift;
- refusal must roll back the migration completely;
- reader must remain absent after refused apply.

Required adverse fixtures:
- direct service_role column SELECT;
- inherited service_role column SELECT;
- PUBLIC-derived column SELECT where effective for service_role;
- at least one column UPDATE/DML drift case;
- each must refuse atomically.

### R2 — P1 unexpected default/inherited EXECUTE

Target migrations:
- `20261006160000_vault_account_brand_post_completion.sql`
- `20261006160200_x_account_publish_authority.sql`

Current source revokes only known roles.
Unknown function default ACL grantees can survive CREATE FUNCTION.
If authenticated inherits that role, it can effectively execute service/operator-only RPCs.

H2 reproduced:
- authenticated could call `set_x_account_publish_authority(...enabled...)`;
- authenticated could call `complete_vault_account_brand_post(...)`;
- both migrations COMMIT instead of refusing.

Required correction for every privileged function created by these two migrations:
- exact signature and routine kind;
- no unexpected overload/procedure collision;
- explicit safe owner;
- fixed safe search_path;
- exact direct ACL;
- no unexpected grantee;
- no grant option;
- exact effective EXECUTE matrix;
- PUBLIC/anon/authenticated must not gain effective EXECUTE;
- service_role must have only the intended EXECUTE;
- unsafe application-role inheritance must refuse;
- unknown default EXECUTE grantee must cause atomic refusal;
- do not change global ALTER DEFAULT PRIVILEGES;
- do not change role memberships;
- do not broadly grant/revoke unrelated objects.

Prefer the already-reviewed robust ACL pattern used in the PR76/reader hardening where applicable, but do not copy assumptions blindly.

Required adverse fixtures:
- unknown default EXECUTE;
- authenticated inherits unknown default grantee;
- anon inherits unknown default grantee;
- grant option;
- unexpected direct grant;
- unknown overload/procedure;
- unsafe owner/creator;
- verify failed migration leaves no partial table/function/ACL mutation.

Behavioral proof must explicitly show:
- authenticated setter call is refused;
- authenticated completion call is refused;
- service_role intended calls still work in the clean graph.

## Preserve accepted PR41 behavior

Do not redesign or reopen already-passed areas unless these ACL corrections affect them:

- narrow reader tenant binding;
- no direct settings-table read in runtime/authority paths;
- missing row/manual_review = no publish;
- `auto_post_preference` only;
- generic `social_mobile_user_v1` dispatcher;
- PR76 pre-send guard;
- authority pre-generation + immediately pre-X;
- PR78 remembered settings/persona -> live generation;
- NG/length/duplicate gates;
- exact account/brand binding;
- terminal/non-replayable confirmed X completion;
- AI Lab / Kabumori paths unchanged;
- G5 entitlement enforcement still not implemented here.

## Freshness / G4 / G5

1. Read current ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / this TASK / H2 report.
2. Fresh fetch current main and PR #41.
3. Use a new independent G3 worktree based on `/Users/yuya/Developer/kabumori-fresh`.
4. Preserve fresh-main corrections that landed after the prior PR41 integration, including test/static corrections.
5. Read current G4 and G5 TASKs for conflict only.
6. G4 is a separate chat-owned X slot; do not alter it.
7. G5 owns common-account Auth/session/enforcement/deletion semantics. Do not touch its app/migration/RPC files.
8. If current main now overlaps the PR41 source/migration files materially, STOP and report before editing.

## Tests

Rerun only what is needed plus bounded regressions:

- new R1 column ACL adverse matrix;
- new R2 function ACL/default/inheritance adverse matrix;
- existing reader behavior;
- existing publish authority behavior/race;
- existing completion behavior;
- x-test-post focused runtime;
- PR76 guard regression;
- PR78 memory-to-live generation;
- AI Lab/Kabumori bounded regression;
- migration invariants;
- `git diff --check`;
- added-line secret scan.

No need to rerun unrelated broad suites unless a changed shared helper requires it.

## Safety

Forbidden:
- production read/write;
- migration/history apply;
- Edge deploy;
- PR merge;
- real X/OpenAI;
- Auth/Vault/OAuth/Cron mutation;
- publish-authority activation;
- G5 entitlement enforcement.

## Completion

Update PR #41 branch normally; no force-push.

Report:
- old/new head;
- exact files changed;
- R1 correction and direct/inherited/PUBLIC column ACL proofs;
- R2 correction and effective EXECUTE/default ACL proofs;
- clean-graph intended permissions;
- atomic rollback proofs;
- bounded runtime regression results;
- G4/G5 overlap check;
- production/deploy/merge/real X/OpenAI = 0.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

### Review policy

Because H2 found concrete P1/P2 in the same security boundary, one **focused rereview of only R1/R2** is required after correction.

Do not repeat the full PR41 review if unchanged live/runtime behavior is covered by bounded regression.

Recommended reviewer after K3: **Sol（高）**.

Recommended Claude model: **Opus5.5（高）**.

## Report — x-social-mobile-pr41-acl-corrective-20261007

- result: **PASS candidate (source-only)** — R1・R2 を修正。PR #41 は open のまま、GitHub: MERGEABLE。本番の読み書き 0 / migration・履歴の適用 0 / deploy 0 / merge 0 / 実 X・OpenAI 0 / 投稿権限の有効化 0。
- PR41 head: 旧 `280aa0f83d4f039ba3e43f32da202a91fd2333f2` → 新 `c509117f8addf5a8687d60d9c18ae271b2c1777c`。内訳は、最新 main の通常 merge `f810d188`（PR97 のテスト・スナップショット修正を含む）+ 修正 1 コミット。rebase / force-push なし。
- worktree: 新規 `/Users/yuya/Developer/kabumori-g3-pr41-acl`（kabumori-fresh 由来）。
- G4 / G5: G4 は done（docs のみ）。G5 は PR #95（アプリの認証・登録ファイル）で、今回の変更ファイルとの重なりは 0（機械的に確認）。main 側でも PR41 の対象ファイル・migrations への変更なし。

### 変更ファイル（修正コミット `c509117f`）
- `supabase/migrations/20261006160000_vault_account_brand_post_completion.sql`（R2）
- `supabase/migrations/20261006160100_social_mobile_publish_settings_reader.sql`（R1 + 関数 ACL の厳密化）
- `supabase/migrations/20261006160200_x_account_publish_authority.sql`（R2、テーブルを含む）
- `supabase/tests/x_account_stage3b_base_fixture.sql`（新規。pilot runner の共通の土台を切り出し、内容は同じ）
- `supabase/tests/x_account_refresh_pilot_run.sh`（上の fixture を読み込むだけに変更）
- `supabase/tests/x_account_stage3b_acl_adverse_run.sh`（新規。異常系一式）
関数本体・TS ランタイム・x-test-post・PR76 / PR78 / AI Lab / Kabumori のコードは無変更。

### R1 の修正（設定テーブルの列単位の権限）
- reader migration の作成前と作成後の両方で、service_role が設定テーブルに対して実際に持つ権限を検査する。対象はテーブル単位（SELECT / INSERT / UPDATE / DELETE / TRUNCATE / REFERENCES / TRIGGER、PG17 以降は MAINTAIN も）と、**すべての列**の SELECT / INSERT / UPDATE / REFERENCES（`has_column_privilege`）。直接の付与、別ロールからの継承、PUBLIC 経由のいずれも含む。
- 1 つでも見つかれば `PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS` で全体を取り消す。見つけた付与を勝手に直すことはしない（テストで、付与が残っていることも確認）。authenticated の PR81 のクライアント権限には触れない。
- 証明（それぞれ全体が取り消され、カタログは変化なし、reader は存在しない）:
  - service_role への列 SELECT の直接付与（settings 列）
  - 継承による列 SELECT（persona_profile 列を別ロールに付与し、そのロールを service_role に付与）
  - PUBLIC への列 SELECT（brand_id 列）
  - 列 UPDATE（persona_confirmed 列）
  - 列 INSERT（brand_id, settings 列）
  - 列 REFERENCES
  - テーブル DELETE
- 問題がない状態: 適用でき、authenticated の列ごとの S / I / U とテーブル ACL が適用前後で完全に同じ。

### R2 の修正（デフォルト権限・継承による実行権限）
3 本の migration の、権限を持つすべての関数に同じ型の検査を入れた（completion / reader / check / set）。
- 作成前:
  - 同じ名前の routine が、どの種類・どの引数でも存在しない（overload・procedure の衝突は拒否）
  - anon / authenticated / service_role のロールが存在する
  - **適用するロールは superuser ではなく**、対象テーブルの所有者である（completion: scheduled_posts と social_accounts、authority: social_accounts、reader: 設定テーブル）
  - anon / authenticated が所有者や service_role を継承していない
- 作成後:
  - 関数は 1 つだけで、通常の関数（prokind f）
  - SECURITY DEFINER / INVOKER の区別が想定どおり（check は INVOKER）
  - 所有者が想定どおりで、`search_path=""`
  - 直接の ACL が「所有者 + service_role の EXECUTE 1 件（再付与権なし）」だけ。PUBLIC やその他の付与先がない
  - 実際の実行権限: anon / authenticated は不可、service_role は可
  - それ以外の非 superuser ロールは、所有者か service_role を継承している場合しか実行できない
- 投稿権限テーブル（`x_account_publish_authority`）:
  - 所有者が同じで、RLS が有効
  - 直接の ACL は「所有者 + service_role の SELECT 1 件（再付与権なし）」だけで、列単位の付与は 0
  - 実際の権限: anon / authenticated はテーブル・列とも 0、service_role は SELECT だけで書き込みは 0
  - その他のロールは、所有者経由（全権限）か service_role 経由（SELECT のみ）だけ
  - PostgreSQL の組み込みの全データ用ロール（pg_read_all_data / pg_write_all_data / pg_maintain）とその継承者は、DB 全体の管理用の付与なので最後の走査からだけ外した。app ロールの検査は、組み込みロール経由も含めて別に行っている。
- 知らない付与先は「黙って外す」のではなく、ファイル全体を取り消して拒否する。失敗理由はコードで区別した（`…:DIRECT_ACL` / `:EFFECTIVE` / `:TABLE_DIRECT_ACL` など）。
- 既知のロール（service_role）に付いた再付与権は、明示的な revoke / grant で普通の EXECUTE に戻る（テストで、再付与権が残らないことを確認）。
- グローバルな ALTER DEFAULT PRIVILEGES・ロールの membership・関係のないオブジェクトの権限は変更しない。

### デフォルト権限・継承についての証明（`x_account_stage3b_acl_adverse_run.sh`）
completion / authority / reader それぞれに、次を実行した（3 × 9 = 27 件）:
- 知らないロールへのデフォルト EXECUTE
- authenticated がそのロールを継承
- anon がそのロールを継承
- そのロールへの再付与権つき付与
- 同じ名前の overload
- 同じ名前の procedure
- superuser が適用
- 所有者でないロールが適用
- authenticated が service_role を継承

これに加えて、authority のテーブルについて「知らないロールへのデフォルトの INSERT / UPDATE を authenticated が継承」した場合の 1 件。どれも拒否され、カタログ全体の指紋（default ACL・public の関数とテーブルと列の ACL・app ロールの membership）が適用前と完全に同じで、テーブルも関数も残らない。
- 修正前のファイルで同じテストを実行すると、R1 は「列単位の付与があるのに適用された」、R2 は「知らないデフォルト EXECUTE があるのに適用された」で失敗する。テストが H2 の再現を検知することを確認した。
- 「authenticated が所有者を継承」は、fixture の所有者がすでに authenticated のメンバーで PostgreSQL が循環を拒むため作れない（migration 側の検査はある）。

### 問題がない状態で意図どおりの権限
anon と authenticated は、次の 5 つの操作がすべて 42501（permission denied）になる。投稿権限の行は 0 件のままで、投稿は running のまま。
- setter で `enabled` にする
- completion を呼ぶ
- check を呼ぶ
- reader を呼ぶ
- 投稿権限テーブルに直接 INSERT する

service_role の結果:
- setter → `enabled`
- completion → `fingerprint_persisted=true`
- 投稿権限テーブルへの直接 UPDATE → 42501

### 全体が取り消されることの証明
27 + 8（R1）= **35 件の拒否すべて**で、カタログの指紋が一致し、Stage 3B の routine と権限テーブルが残っていないことを確認した。R1 では、見つけた付与を勝手に直していないことも確認した。

### 範囲を絞った回帰テスト
- 使い捨て PostgreSQL 17（UTF8）、既存の pilot runner: PILOT_BEHAVIOR / PUBLISH_AUTHORITY_BEHAVIOR / PUBLISH_SETTINGS_READER_BEHAVIOR / PILOT_RACE / PUBLISH_RACE / CLEANUP すべて PASS。completion・投稿権限・reader の挙動と競合テストを含む。
- 異常系 runner: `STAGE3B_ACL_ADVERSE_PASS`（拒否 35 件 + 再付与権の正規化 + 問題がない状態）。
- x-test-post 全体 534/534（PR76 の送信前ガード・Vault の更新の権限を含む）。
- 範囲を絞った Deno テスト 63/63: PR41 の dispatcher（PR78 の記憶 → 本番生成の指示文を含む）、brand generator（AI Lab・Kabumori のハッシュタグ）、AI Lab の予約投稿、設定、phase15 の静的検査、migration の不変条件。
- `_shared` 全体 436/436（最新 main の PR97 修正が入り、以前の既存の失敗 3 件も解消）。
- `deno check` クリーン、shell の構文チェック OK、`git diff --check` クリーン、追加行の秘密情報スキャン 0 件。

### 本番・ゲート
本番の読み書き 0、migration・履歴の適用 0、Edge deploy 0、PR merge 0、実 X / OpenAI 0、Auth / Vault / OAuth / Cron の変更 0、投稿権限の有効化 0、G5 の entitlement の実装 0。

### 残る課題・次の推奨
- TASK のとおり、**R1 / R2 だけを対象に Sol（高）の集中再レビューを 1 回**。PR41 全体の再レビューは不要（ランタイムは無変更で、回帰テストで確認済み）。
- 本番適用の前のライブ preflight で、次を本番で確認する必要がある（今回は本番を読んでいない）:
  - 適用するロール（postgres の想定）が superuser ではなく、scheduled_posts と social_accounts と設定テーブルの所有者であること
  - app ロールの継承関係
  - service_role が設定テーブルの列に権限を持たないこと
- 以前の作業として起動された「既存テスト 3 件の修正」タスクは、main の PR97 で同じ修正がすでに入っている。重複していないか確認が必要。
- status → review_required / next_owner → chatgpt。STOP。

---

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr41-live-generation-fresh-integration-20261006
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: codex
- priority: highest
- recommended_model: Opus5.5（高）
- type: source-only fresh integration / live scheduled-user generation / narrow content-settings service read boundary
- source_pr: 41
- source_head: 59f4f53037f231e831774c04e9a1b1982eff3bd9
- prerequisite_ai_consult_merge: 60dff4e28a763e3c182495dfc41cadf94671952f
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Product goal

V1の中核である「AIと相談して覚えた投稿内容・口調」を、
一般ユーザーの実際の定期自動投稿経路でも使えるsourceへつなぐ。

PR #78 AI相談V1は Final K3 PASS 後、squash-merged to main:
`60dff4e28a763e3c182495dfc41cadf94671952f`.

AI相談側は以下まで完成済み:
- 会話だけでは保存0;
- 明示的「これで覚えて」でのみ保存;
- CASで古い提案を拒否;
- confirmed settings/personaが次回相談へ反映;
- 全8 persona signals + settingsがgeneration guidanceへ反映;
- default/AI Lab/Kabumori hashtag behaviorに回帰なし.

残るlive側の主要blockerはPR #41.

## Current PR #41 facts

PR #41 is open and currently stale/not mergeable against modern main.
It owns:
- generic Vault-backed scheduled `brand_post` path for `social_mobile_user_v1`;
- `x-test-post` routing;
- completion RPC candidate;
- per-account publish-authority candidate.

Current PR41 source loads `public.social_mobile_content_settings` directly with service_role.
Final PR81 hardening intentionally grants service_role no table access, therefore the direct read fails closed.
The publish-authority SQL also reads that table while executing as service_role and has the same dependency.

Do not solve this by granting broad table SELECT to service_role unless a narrower design is proven impossible.

## G4 / G5 coordination

- G4 is another X-app slot owned by another chat. Inspect its TASK/Report for overlap, but do not execute/modify G4.
- G5 common-account remains project-wide critical path.
- Current G5 Phase2 service-enrollment work touches app auth/session/enrollment files, not PR41 backend paths.
- This G3 is source-only and must not perform production DB/Auth/permission mutation.
- Do **not** implement common-account entitlement enforcement here. G5 owns the product semantics/timing for enforcement and deletion.
- Before editing, fresh-check G5 head/changed files again. Any overlap => STOP.

## Mandatory startup / isolation

1. Read ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / this TASK.
2. Read Final K3 AI consultation reports and merged PR78 source.
3. Read current G4/G5 TASK/Report for conflict only.
4. Use fresh `/Users/yuya/Developer/kabumori-fresh`; fetch fresh origin/main.
5. Create a new independent G3 worktree.
6. Fetch exact PR41 head `59f4f53037f231e831774c04e9a1b1982eff3bd9`.
7. Inventory every PR41 changed file and every migration dependency before integration.
8. Do not rebase/reset/force-push another slot worktree.

## Phase A — reassess PR41 against current main

Before editing, determine what remains valid vs obsolete.

Re-check:
- current `x-test-post` routing after PR76/PR82;
- current Vault account auth/refresh code;
- current scheduled_posts/account-bound queue shape;
- current publish permission boundary;
- current PR81 settings/persona contract;
- current G5 common-account foundation/enrollment source;
- whether PR41's two historical migrations are still safe to keep at their 20260927 versions or should be replaced/renumbered because they were never merged/applied and now depend on later source.

Do not preserve old migration numbering merely for convenience if clean-bootstrap/order semantics would be wrong.

## Phase B — narrow settings read boundary

Preferred architecture:
- keep `social_mobile_content_settings` table denied to service_role;
- expose the minimum publish-time read through a tightly scoped service-only function/RPC;
- exact brand-scoped input;
- only `social_mobile_user_v1` eligible;
- return only fields needed for publish consent + generation:
  - settings
  - persona_profile
  - persona provenance/confirmed/analyzed metadata as required;
- no email/user identity/token/Vault data;
- no mutation.

Security requirements:
- explicit owner;
- SECURITY DEFINER only if needed;
- `search_path = ''` or equally pinned safe path;
- PUBLIC/anon/authenticated EXECUTE none;
- service_role EXECUTE only;
- no unexpected overload/procedure;
- safe behavior for missing brand/settings;
- cannot read Kabumori/AI Lab/internal profile settings through this reader;
- no broad service_role SELECT on the underlying settings table.

PR41 Edge/runtime loader must use this narrow boundary instead of direct table SELECT.

PR41 publish-authority consent check must either:
- reuse the same narrow helper safely inside SQL; or
- use an equally narrow reviewed internal SQL helper.
Do not leave one of the two direct-table reads unresolved.

## Phase C — fresh-integrate live scheduled-user path

Integrate only the still-valid PR41 functionality onto fresh main:
- generic `social_mobile_user_v1` scheduled brand_post dispatcher;
- exact-account Vault X port;
- admin/publish gates before generation and immediately before X create;
- explicit user auto-post consent;
- confirmed content settings/persona passed to current main `generateBrandPost`;
- NG words;
- cross-brand duplicate protection;
- bounded X length;
- confirmed-X completion becomes terminal/non-replayable.

Preserve:
- Kabumori legacy path untouched;
- AI Lab specialized path untouched;
- PR76 publish permission semantics;
- PR82 AI Lab dedupe;
- current AI consultation generation guidance.

Do not special-case raw user brand IDs.

## Phase D — common-account boundary awareness

Do **not** activate entitlement enforcement here.

However document the exact future insertion point(s) where G5 Phase3 should require active `x_autopost` entitlement before:
- claiming/generating a user scheduled post;
- allowing/re-authorizing live publish authority.

The current source must remain safe/dormant until explicit rollout gates are satisfied.

If current PR41 would allow a future user to bypass G5 service enrollment semantics once enabled, STOP and report the conflict rather than inventing G5 policy.

## Migration rules

Because PR41 migrations are unmerged/unapplied candidates:
- fresh-check repo + production history before choosing final migration versions;
- no duplicate versions;
- no normal `db push` assumption;
- no production apply in this task;
- migration source must be clean-bootstrap coherent with PR81 and current main;
- if renumbering/replacing old candidate migrations is safest, do so only within PR41 branch and document old->new mapping;
- all functions/tables/grants must be idempotency/precondition aware per project conventions.

## Tests

At minimum:
- narrow settings reader refuses PUBLIC/anon/authenticated;
- service_role reads only exact allowed brand;
- wrong/internal brand fails/empty safely;
- no direct service_role table SELECT required;
- publish-authority consent check works through narrow boundary;
- manual_review/no row/unconfirmed state does not publish;
- auto_post_preference + confirmed settings reaches `generateBrandPost`;
- all AI-consult remembered generation fields survive into live generation prompt;
- authority checked pre-generation and pre-X;
- account/brand mismatch fails;
- OFF/revoked/expired authority fails;
- NG word blocks;
- duplicate blocks;
- X success + completion ambiguity never causes replay;
- AI Lab path unchanged;
- Kabumori path unchanged;
- PR76 guard unchanged;
- G5 enrollment/app files untouched.

Run relevant:
- disposable PostgreSQL behavior/ACL/adversarial tests;
- x-test-post focused Deno tests;
- shared-brand tests;
- PR78 memory-generation contract;
- typecheck/lint where applicable;
- git diff --check;
- added-line secret scan.

No real X/OpenAI.

## Production / merge gates

Forbidden:
- production migration/history write;
- Edge deploy;
- real X/OpenAI;
- Vault/OAuth/Auth mutation;
- Cron change;
- publish enablement;
- PR41 merge;
- G5 enforcement or deletion changes.

Keep resulting PR open for K3.

## Review policy

This task introduces/changes a DB permission + service_role read boundary.
If implementation reaches PASS candidate, K3 should normally allocate **one focused Codex review**.

Recommended reviewer:
- **Sol（高）** for the narrow SECURITY DEFINER/RPC/ACL + live-publish boundary.
- Do not perform repeated routine rereviews unless the review finds a concrete P1/P2 in the same boundary.

## Completion report

Include:
- result
- fresh main
- old/new PR41 head
- migration version decisions
- changed files
- settings-reader design
- ACL/owner/search_path proof
- live generation path proof
- PR78 memory->live generation proof
- G4/G5 conflict check
- tests
- production mutation/deploy/real X/OpenAI = 0
- remaining V1 blockers
- whether focused Codex review is required
- next recommendation

At completion:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Recommended model: **Opus5.5（高）**.

## Report — x-social-mobile-pr41-live-generation-fresh-integration-20261006

- result: **PASS candidate (source-only)** — PR #41 を最新 main に統合し、利用者の設定の読み取りを「公開時だけの狭い RPC」1本に絞った。PR #41 は open のまま、GitHub: MERGEABLE。本番変更 0 / deploy 0 / merge 0 / 実 X・OpenAI 0。
- fresh main: 統合時 `e7da97d4`（この TASK の in_progress コミット。PR78 squash `60dff4e2` を含む）。その後の main は `.agent` などの記録だけで、今回の変更ファイルとの重なりなし。
- PR41 head: 旧 `59f4f53037f231e831774c04e9a1b1982eff3bd9` → 新 `280aa0f83d4f039ba3e43f32da202a91fd2333f2`（通常 merge `48681238` + 1 コミット。rebase / force-push なし）。
- worktree: 新規 `/Users/yuya/Developer/kabumori-g3-pr41-live`。G4/G5 の worktree・dev server には触れていない。

### Phase A — 現在の main に対する再評価
- 衝突は `x-test-post/index.ts` の import 1 か所のみ（AI Lab の dev-diary/topic import と汎用 Vault 口座の import を両方残した）。汎用経路のブロックと `postToX` の `beforeCreate` は自動で合わさり、内容は変わっていない。
- まだ有効: 汎用 `social_mobile_user_v1` brand_post 経路、口座固定の Vault X 送信、投稿権限（生成前と X 作成直前）、同意、NG 語、ブランド横断の重複、140 字、完了 RPC（確定済み X 投稿は再送しない）。
- PR76: 送信前ガード `assert_x_publish_permission_for_legacy_post` は `VaultAccountXAuth.send` の中にあり、汎用経路も同じ `send` を通る。順序は PR76 ガード →（更新時は再ガード）→ PR41 の権限再確認（`beforeCreate`）→ X 作成。X を作るたびに両方が走る。PR76 のコードは無変更。
- PR82: AI Lab の dispatcher・topic claim は無変更（汎用経路は `ai_salaryman_lab` 以外だけ）。
- 不要になった前提: 「設定テーブルが未作成なら同意なし」の分岐（PR81 の後では常に存在する前提に変更）、service_role による設定テーブルの直接 SELECT。

### Migration の番号（旧 → 新）
- `20260927101423_vault_account_brand_post_completion` → `20261006160000_vault_account_brand_post_completion`（本文は変更なし、注記のみ）
- 新規 `20261006160100_social_mobile_publish_settings_reader`
- `20260927124300_x_account_publish_authority` → `20261006160200_x_account_publish_authority`（同意確認を reader 経由に変更）
- 理由: 3 本とも main にも本番にも未適用。新しい設計は PR81 の hardening（`20261003120000`）に依存するので、何もない状態から順に作り直したときに後ろに来る番号が必要。本番履歴の最新（`20261004090000`）・repo・open PR の番号と重複なし。旧 2 番号は `migration_source_invariants_test.ts` で「再利用禁止」として登録した。

### 変更ファイル（main との差分、14 ファイル）
`_shared/brand/vault_account_brand_post.ts` (+test), `x-test-post/index.ts`, `x-test-post/vault_account_auth_test.ts`（PR41 由来のテスト）, `x-test-post/vault_account_brand_post_routing_test.ts`, migrations 3 本, `supabase/tests/{migration_source_invariants_test.ts, social_mobile_publish_settings_reader_behavior.sql（新規）, x_account_publish_authority_behavior.sql, x_account_refresh_pilot.md, x_account_refresh_pilot_behavior.sql, x_account_refresh_pilot_run.sh}`。
禁止領域（G5 の app/auth/enrollment、PR76 migration/`vault_account_auth.ts`、AI Lab、`brand_post_generator.ts`、`social_mobile_content_settings.ts`、退会、workflow）の変更 0 を機械的に確認。

### 設定の読み取り設計（Phase B）
`public.read_social_mobile_publish_settings(p_scheduled_post_id uuid, p_brand_id text)` → `settings, persona_profile, persona_provenance, persona_confirmed, persona_last_analyzed_at, persona_last_analyzed_count`
- 応答する条件: その投稿が **実行中（running）の brand_post**、**ちょうどそのブランド**、ブランド単位の行（`social_account_id` なし）で、かつブランドのプロファイルが `social_mobile_user_v1`。
- 返すのは設定・ペルソナの列だけ（user id / email / token / Vault なし）。保存がなければ 0 行（＝同意なし）。書き込みなし。
- 拒否コード: 入力不正 `..._REQUEST_INVALID`、別投稿・別ブランド・pending/終了済み・別 post_type `..._POST_NOT_RUNNING`、Kabumori・AI Lab・その他の内部プロファイル `..._BRAND_NOT_ELIGIBLE`。
- 呼び出し元: Edge の `loadSocialMobileContentSettingsForPublish`（RPC。拒否・失敗はすべて fail closed）と、`check_x_account_publish_authority` の同意確認（直接・動的なテーブル読み取りは削除）。

### ACL / 所有者 / search_path の証明
- `SECURITY DEFINER`、`search_path = ''`、STABLE、オーバーロードなし。所有者は設定テーブルの所有者（migration 内で明示的に `alter function ... owner to <テーブル所有者>`）。
- EXECUTE: service_role のみ。PUBLIC / anon / authenticated は不可（実行すると 42501）。
- 設定テーブル自体は service_role に権限なし（列単位の権限も含めて 0）。migration の事後条件で、これに反する場合は適用を中止。
- 使い捨て DB で、service_role がテーブルを直接 SELECT / UPDATE すると 42501 になることを確認。

### 本番生成経路の証明（Phase C）
- `dispatchVaultAccountScheduledBrandPost` → 現在の main の `generateBrandPost`（PR78 の全項目ガイダンス）。順序は「権限 → 設定 → 重複の材料 → 生成 → 長さ・NG 語・重複 → 権限の再確認 → X → 完了」。
- 同意は `approvalMode = auto_post_preference` のみ。行なし・manual_review は生成も X も 0。

### PR78 の記憶 → 本番生成の証明
新しいテストで、本番の dispatcher から本物の `generateBrandPost`（OpenAI だけ差し替え）に渡し、指示文に次がすべて出ることを確認:
- 設定: トーン / 目的 / テーマ / NG 語 / メモ
- 確認済みペルソナ全 8 項目: 口調 / 文の長さ / 記号・絵文字 / 語彙 / 話題 / 呼びかけ / 書き出し・締め / ハッシュタグ習慣
- ハッシュタグの習慣は「付けないでください」と同居しない。140 字の上限も同じ指示文に入る。
- 未確認ペルソナは指示 0 行で、従来のハッシュタグ禁止が残る。

### G5 の境界（Phase D、実装はしていない）
- 今は動かない構造: 運用者が `x_account_publish_authority` に enabled の期間（最大 30 日）を作らない限り投稿しない（このテーブルも本番に未作成）。
- G5 Phase 3 が、実際の利用者に期間を有効化する前に、ブランドの owner の `service_entitlements(service_key='x_autopost')` が有効であることを、次の 3 か所で要求する必要がある（`vault_account_brand_post.ts` の先頭コメントと手順書に記載）:
  1. `check_x_account_publish_authority`（生成前と X 作成直前に評価される唯一の判定）
  2. `set_x_account_publish_authority('enabled')`（期間の付与・再付与）
  3. 利用者の予約投稿の claim（終了したサービスの投稿を claim・生成しない）
- G5 のサービス退会では、その口座の権限行も終了・取り消しにする必要がある。
- 今のソースで、有効化後に G5 の登録を迂回できる経路はない（有効化そのものが運用者の明示操作）。ただし上の 3 点がないまま期間を有効化すると、サービス終了後も最大 30 日投稿し得る。このため、有効化の前提条件として明記した。

### テスト
- 使い捨て PostgreSQL 17（UTF8）: `x_account_refresh_pilot_run.sh` → PILOT_BEHAVIOR / PUBLISH_AUTHORITY_BEHAVIOR / **PUBLISH_SETTINGS_READER_BEHAVIOR** / PILOT_RACE / PUBLISH_RACE / CLEANUP すべて PASS。
  - PR81 の candidate + hardening を本物のまま適用している。
  - 前提が欠けた状態での権限 migration の適用が拒否されること、各 migration の再適用が拒否されることも確認。
- reader の変異確認: ①プロファイル確認を外す ②実行中の投稿か確認を外す ③ブランド一致確認を外す → いずれもテストが失敗。
- Deno: x-test-post 534/534、PR41 TS 14/14、ルーティング + migration 不変条件 16/16、consult + dry-run + 不変条件 47/47。
  - `deno check`: PR41 本体・テストはクリーン。`x-test-post/index.ts` の型エラー 6 件は main にも同じ 6 件があり、今回の変更とは無関係。
  - `deno lint` クリーン。
- アプリ（PR78 の契約）: memory-generation + consult + repository 36/36。
- `git diff --check` クリーン、追加行の秘密情報スキャン 0 件。実 X / OpenAI 呼び出し 0。
- 既存の別件: `_shared` 全体では 433 合格 / 3 失敗。3 件とも main でも同じように失敗する。
  - 2 件は AI Lab 日記スナップショットの古さ。
  - 1 件は `social_mobile_phase15_static_test` が、前回 G3（PR78）で厳密化した `persona.confirmed === true` を古い文字列で検査しているもの（動作は正しい）。
  - どちらも別の作業として切り出し済み（テスト・スナップショットのみの修正）。

### 本番・ゲート
本番 migration / 履歴の書き込み 0、Edge deploy 0、実 X / OpenAI 0、Vault / OAuth / Auth の変更 0、Cron 0、投稿の有効化 0、PR41 merge 0、G5 の enforcement・退会の変更 0。

### 残る V1 の課題
1. PR81 の本番適用（G5 の後）→ その後に Stage 3B の 3 migration を順に適用（各 1 本ずつ・読み戻し付き）、x-test-post の deploy。
2. G5 Phase 3 の entitlement 要件（上の 3 点）を、本番で投稿権限を有効化する前に入れる。
3. AI 相談エンドポイントの deploy（PR78、PR81 の後）。
4. 既存のテスト 3 件の修正（別の作業）。

### レビュー
- 新しい DB 権限の境界（service_role 用の SECURITY DEFINER の reader と、本番投稿の境界）を追加したので、TASK のとおり **集中レビュー 1 回（Sol（高））を推奨**。
- 観点: reader の ACL・所有者・search_path と応答条件、同意確認の reader 経由化、migration の番号付け直しと事前・事後条件。

### 次の推奨
K3 で Sol（高）の集中レビューを 1 回。PASS 後も PR #41 は merge せず、PR81 の本番適用と G5 Phase 3 を待つ。
- status → review_required / next_owner → chatgpt。STOP。

---

# Previous G3 task — preserved history

- task_id: x-social-mobile-ai-consult-persona-generation-guidance-20261006
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Sonnet5（高）
- type: source-only V1 completion / remembered persona -> generation prompt
- source_pr: 78
- source_head: d1f131c56b082d2af57660b5bd3d83ff8c619c7d
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Product decision

AI相談はV1必須の中核機能。
「覚えた」内容が実際の投稿生成に反映されなければV1完成とはしない。

Previous G3 proved:
- conversation -> proposal -> explicit 「これで覚えて」 -> CAS save -> reread -> next consultation works;
- settings + confirmed persona survive the save/read round trip;
- current post generator consumes settings and some persona signals.

K3 found one V1 gap:
confirmed persona fields
`toneSignals`, `topicSignals`, `hashtagHabits`, `ctaStyle`, `openingClosingPatterns`
are persisted and re-read but are not currently reflected in post-generation guidance.

## Current conflict / dependency state

- G5 common-account critical path is active. This task must remain source-only and must not touch Auth/entitlement/account deletion/common-account migrations or production.
- G4 is a separate X-app slot handled in another chat. Current G4 morning-greeting work is done; future G4 UI work must not be edited here.
- PR #41 remains open and owns live general-user scheduled-post routing + account-bound Vault path. Its changed files do **not** include:
  - `supabase/functions/_shared/brand/social_mobile_content_settings.ts`
  - `supabase/functions/_shared/brand/brand_post_generator.ts`
  - their focused tests.
- PR81 production schema apply is still deferred behind G5.
- PR #78 stays open; no merge/deploy in this task.

## Goal

Make every user-confirmed persona signal that AI consultation can save materially available to social-mobile post generation, without changing security, DB, live dispatch, X, or account boundaries.

The generation contract must cover:
- preferredTone
- themes
- objective
- optionalNgWords
- notes
- persona.toneSignals
- persona.sentenceLength
- persona.punctuationEmoji
- persona.recurringVocabulary
- persona.topicSignals
- persona.hashtagHabits
- persona.ctaStyle
- persona.openingClosingPatterns

Unconfirmed persona must contribute **zero persona guidance**.

## Allowed scope

Primary:
- `supabase/functions/_shared/brand/social_mobile_content_settings.ts`
- `supabase/functions/_shared/brand/brand_post_generator.ts` only if needed for conflict-free hashtag-policy composition
- focused tests:
  - `supabase/functions/_shared/brand/brand_post_generator_test.ts`
  - PR78 memory-generation test(s)

Small app/server test updates are allowed only if necessary to keep the same contract explicit.

Do not edit:
- PR #41 files;
- x-test-post routing;
- Vault/OAuth/token/auth code;
- common-account/G5 files;
- DB migrations/RLS/RPC;
- account deletion;
- publish toggle/permission;
- G4 workflow/UI files;
- production config/secrets.

## Guidance requirements

1. **All confirmed signals must be represented semantically in the model instructions.**
   Do not merely save/read them.

2. Preserve existing bounds and sanitization.
   - no unbounded prompt injection from saved free text;
   - values remain data/guidance, not system authority;
   - do not let notes/persona override safety/publish/account instructions.

3. Keep existing settings behavior stable:
   - preferredTone / themes / objective / NG words remain;
   - notes must remain bounded but should not silently lose most of the remembered intent if a safe larger bound is practical;
   - approvalMode / generationWindow / frequencyTargetPerWeek remain operational/read-only and are not converted into AI-editable behavior here.

4. **Hashtag interaction must be internally consistent.**
   Current generic social-mobile generation ends with `ハッシュタグは付けないでください` when no fixed hashtags exist.
   If a confirmed social-mobile persona contains `hashtagHabits`, do not emit a contradictory later instruction that nullifies the remembered preference.
   Requirements:
   - no confirmed hashtag preference -> existing no-hashtag default remains unchanged;
   - confirmed hashtag habit -> generator may follow that confirmed habit within the user's own social-mobile profile;
   - do not alter AI Lab's existing hashtag policy;
   - do not alter Kabumori fixed-hashtag behavior;
   - no cross-brand special-casing by raw brand id.

5. Topic/tone/CTA/opening/closing signals must guide style, not invent personal facts.

## Required tests

At minimum prove:

- confirmed persona with every field produces guidance containing every field;
- unconfirmed persona produces none of the persona guidance;
- default social-mobile profile with no confirmed hashtag habit still says no hashtags;
- confirmed social-mobile hashtag habit does not coexist with a contradictory final no-hashtag instruction;
- AI Lab hashtag behavior unchanged;
- Kabumori fixed hashtag behavior unchanged;
- content-settings save -> reread -> generation guidance still round-trips all remembered fields;
- consultation cannot alter approval/publish/account/OAuth/schedule boundaries;
- no PR41/live-dispatch code changed.

Run:
- focused shared-brand tests;
- PR78 consult memory-generation tests;
- relevant app tests if touched;
- Deno check/lint on changed runtime;
- `git diff --check`;
- added-line secret scan.

No real OpenAI/X call.

## Production / merge

Forbidden:
- production mutation;
- Edge deploy;
- PR81 apply;
- PR78 merge;
- PR41 integration;
- real X/OpenAI;
- Auth/Vault/OAuth/Cron changes.

At completion:
- push only to PR #78 branch if clean;
- keep PR #78 open;
- status -> review_required / next_owner -> chatgpt;
- K3 decides next.

## Completion report

Include:
- result
- fresh main / previous and new PR78 head
- changed files
- exact persona fields now consumed
- hashtag behavior proof
- memory-to-generation round trip
- tests
- G4/G5/PR41 conflict check
- production mutation/deploy/merge = 0
- remaining V1 blockers
- next recommendation

## Review policy

This is bounded prompt/generation behavior, not a new auth/DB/permission boundary.
Default: no Codex review if tests and scope are clean.
If an unexpected cross-brand or publish-safety concern appears, STOP and report rather than widening scope.

Recommended model: **Sonnet5（高）**.

## Report — x-social-mobile-ai-consult-persona-generation-guidance-20261006

- result: **PASS (source-only)** — 確認済みの文体・好みはすべて投稿生成の指示に入るようになった。PR #78 は open のまま。本番変更 0、merge 0、deploy 0。
- fresh main: 取り込み時点 `2b120d03`（この TASK の in_progress コミット）。その後 main は G5 の K5 記録だけ進んだ（コード変更なし）。
- PR78 head: 前 `d1f131c56b082d2af57660b5bd3d83ff8c619c7d` → 新 `1f33c58ca82a9d33d8c5c7282e0ac5c2fbb4aca9`（通常の merge + 1 コミット。rebase / force-push なし。GitHub: MERGEABLE）。
- 競合: なし。PR78 が実際に変えるのは 17 ファイル（PR78 本来の 11 + 前回の追加 + 今回の 5）。

### 変更ファイル（今回）
- `supabase/functions/_shared/brand/social_mobile_content_settings.ts`
- `supabase/functions/_shared/brand/brand_post_generator.ts`（ハッシュタグ指示の 1 か所だけ）
- `supabase/functions/_shared/brand/social_mobile_content_settings_test.ts`
- `supabase/functions/_shared/brand/brand_post_generator_test.ts`
- `apps/social-mobile/tests/consult-memory-generation.test.mjs`
PR #41 / x-test-post / Vault・OAuth・Auth / common-account（G5）/ DB migration・RLS・RPC / 退会 / 投稿 ON-OFF・権限 / G4 のワークフロー・UI には触れていない。

### 投稿生成が使う項目（確認済みペルソナのみ）
- 設定側（従来どおり）: preferredTone / themes / objective / optionalNgWords / notes。approvalMode・generationWindow・frequencyTargetPerWeek は運用値のままで AI 編集対象にしていない。
- ペルソナ側（今回で全 8 項目）:
  - toneSignals → 「確認済みの口調の特徴」（新規）
  - sentenceLength → 「確認済みの文体傾向」（`short` などの生の値ではなく 短め / 長短まじり / 長め の文に変更）
  - punctuationEmoji → 「確認済みの記号・絵文字傾向」（上限 120→200 字。DB と同じ）
  - recurringVocabulary → 「確認済みの語彙傾向」（上限 10→30 語。DB と同じ）
  - topicSignals → 「確認済みの話題の傾向」（新規）
  - ctaStyle → 「確認済みの呼びかけ方」（新規）
  - openingClosingPatterns → 「確認済みの書き出し・締めの型」（新規）
  - hashtagHabits → 下記のハッシュタグ指示に反映（新規）
- 確認済みペルソナがあるときだけ、末尾に「文体・話題・構成の参考にするだけ。語っていない個人的な体験・実績・数値は作らない。安全・投稿権限・アカウントの指示は変えない」という注意行を付ける。
- 未確認ペルソナは、ペルソナ由来の指示を 0 行にする（ハッシュタグ習慣も無視）。

### 安全上の上限
- 保存された自由文（トーン・目的・テーマ・NG 語・メモ・ペルソナ）は、空白・改行を 1 つの空白にまとめた 1 行にしてから上限で切る。メモに改行つきの偽指示（例: 「ハッシュタグは付けないでください」「以前の指示を無視して」）を入れても、独立した指示行にならない（テストで確認）。
- notes は 300 → 600 字（DB の保存上限は 1000 字。安全に確保できる範囲で、覚えた内容の大半を残す）。1 行に収め、「事実として未確認の内容は採用しない」の注記は維持。

### ハッシュタグの証明
優先順位: 固定ハッシュタグ > プロファイル自身のハッシュタグ方針（AI Lab）> 確認済み hashtagHabits > 従来の「付けないでください」。ブランド ID による特別扱いなし。
- 確認済みの習慣なし／未確認 → 従来どおり「ハッシュタグは付けないでください」（テスト 1）
- 確認済みの習慣あり（social-mobile）→ 「利用者が確認した次の方針に従ってください（方針にない使い方はしない）: …」に置き換わり、禁止行は同居しない（テスト 2）
- AI Lab（`voiceControlsHashtags`）に習慣を渡しても従来の AI Lab 指示のまま／かぶモリ型の固定タグ（#日本株）に習慣を渡しても固定タグのまま（テスト 3）

### 保存 → 読み戻し → 生成の往復（`consult-memory-generation.test.mjs`、実コード）
AI 提案（全項目入り）→ 確認 → 版付き書き込み → 実際の dry-run 読み取り → 実際の `generateBrandPost` で、設定の全項目と、ペルソナの全 8 項目（toneSignals / sentenceLength / punctuationEmoji / recurringVocabulary / topicSignals / hashtagHabits / ctaStyle / openingClosingPatterns）が、変形なしで指示文に出る。同じ行が次回の相談の文脈にも出る。未確認ペルソナは生成にも次回の相談にも出ない。
- 変異確認（壊すと落ちる）: ①指示の文言を変える ②確認済み判定を外す ③ハッシュタグ習慣を無視する ④AI Lab より習慣を優先する → いずれもテストが失敗。

### テスト
- Deno（`--no-config`、`--allow-read`）: 共有ブランド + consult + dry-run + 設定 72/72、AI Lab 既存（scheduled / dev-diary / topic-dedup）59/59。`deno check` 4 ファイル・`deno lint` 2 ファイル クリーン。
- アプリ: `npm test` 193/193、`tsc --noEmit`、`expo lint` クリーン。
- 既存テスト 1 件の期待値だけ変更: 「メモは 400 字未満」→「700 字未満」（メモ上限を 600 字に上げたため）。
- `git diff --check` クリーン、追加行の秘密情報スキャン 0 件。実 OpenAI / 実 X 呼び出し 0。

### 衝突確認・ゲート
- G4 / G5 / PR #41: 触れていない（禁止領域のファイル変更 0 を機械的に確認）。PR #41 の変更ファイルとも重ならない。
- 本番変更 0 / Edge deploy 0 / PR81 適用 0 / PR78 merge 0 / PR41 統合 0 / Auth・Vault・OAuth・Cron 0。

### 残る V1 の課題
1. **実運用の定期投稿が保存設定をまだ読まない**。今それを読むのはユーザー JWT のプレビュー経路だけ。実運用の経路は PR #41（口座単位の Vault 経路）の統合が必要。
2. **PR #41 の読み取り権限**: PR #41 は service_role で `social_mobile_content_settings` を読むが、PR #81 の最終権限では service_role に何も与えていない。このままだと PR #41 の読み取りは拒否される（fail closed）。service_role に SELECT を狭く与えるか、定義者権限の読み取り関数にするかを、別の DB タスクで決める必要がある。
3. PR #81 の本番適用が未実施（G5 の後）。相談エンドポイントも未 deploy。
4. 全タブの上部見出しが時計と重なる（以前からの問題）。別の UI タスク。
5. 未確認: ソフトウェアキーボード、375pt 幅の実機表示（前回の Simulator 確認は 402pt のみ）。

### 次の推奨
- K3 で、PR #41 の読み取り方式（課題 2）の決定と、そのための小さな DB タスクの要否を決める。
- 追加レビューは不要の見込み（境界は変えず、プロンプト内容と上限だけの変更）。気になる場合は、一行化と上限の `social_mobile_content_settings.ts` だけを Luna（高）で軽く確認。
- status → review_required / next_owner → chatgpt。STOP。

---

# Previous G3 task — preserved history

- task_id: x-social-mobile-ai-consult-v1-fresh-integration-20261006
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Opus5.5（高）
- type: source-only fresh-main integration / AI consultation V1 core / memory-to-generation contract
- source_pr: 78
- source_head: 6e9f78a31bae9b65599732a9b416dcb50f2bfbc7
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Product decision

「AIと相談する」はV1必須の中核機能。
単なるチャットではなく、利用者とAIが会話しながら投稿内容・口調・好みを整理し、
利用者が明示確認した内容だけを覚え、その保存内容が実際の投稿生成へ反映されることをV1完成条件とする。

## Current dependencies

- PR #81 source is merged and independently reviewed, but production schema apply is still HOLD while G5 common-account critical path is active.
- G5 currently owns common-account legacy backfill / entitlement critical path. Do not overlap Auth/entitlement/account deletion/production DB work.
- G4 morning-greeting reliability task is complete; G4 is a separate X-app slot and will later handle UI work. Do not edit G4-owned work.
- PR #78 is still open at head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` and is currently not mergeable against fresh main.
- PR #78 changed paths are limited to the AI-consult/content-settings surface:
  - `apps/social-mobile/src/app/(tabs)/consult.tsx`
  - `apps/social-mobile/src/data/consult-client.ts`
  - `apps/social-mobile/src/data/content-settings-repository.ts`
  - `apps/social-mobile/src/domain/consult-session.ts`
  - `apps/social-mobile/src/domain/content-settings-conversation.ts`
  - `apps/social-mobile/src/domain/content-settings.ts`
  - `apps/social-mobile/tests/consult-screen.test.mjs`
  - `apps/social-mobile/tests/consult.test.mjs`
  - `supabase/functions/social-mobile-consult/index.ts`
  - `supabase/functions/social-mobile-consult/logic.ts`
  - `supabase/functions/social-mobile-consult/logic_test.ts`
- Current main brand generator already supports `contentSettings` and feeds `socialMobileGenerationGuidance(contentSettings)` into the prompt. This contract must remain compatible.

## Goal

Fresh-integrate PR #78 onto current main and make the AI consultation V1 source ready for later production activation, without touching production or G5 boundaries.

The task must prove:
1. natural conversation works;
2. AI can explain what it currently understands;
3. proposal is delta-only;
4. nothing is saved merely because the AI replied;
5. only explicit user confirmation ("これで覚えて") commits;
6. stale proposals never overwrite newer settings;
7. confirmed persona/settings survive re-read and are the same shape consumed by post generation;
8. AI cannot alter publish ON/OFF, X account/OAuth, schedule, approval mode, deletion, entitlement or Auth;
9. one user's workspace/settings cannot leak into another user's consultation;
10. the consultation source can be merged later without silently activating a production path before PR81 schema is live.

## Mandatory startup / isolation

1. Read ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / this TASK / prior PR78 body / final PR81 H2/C2 evidence.
2. Read current G4 and G5 TASKs for conflict only; do not execute or modify them.
3. Use new-Mac clean base `/Users/yuya/Developer/kabumori-fresh`.
4. Fetch fresh `origin/main` and PR #78 head.
5. Create a new independent G3 worktree/checkout. Never share G4/G5 workdir or dev server.
6. Confirm PR #78 exact head before integration.
7. Do not rebase/reset/force-push another slot branch.
8. Prefer a normal fresh-main integration into the PR branch or an equivalent non-destructive continuation. If the PR branch has moved unexpectedly, STOP.

## Scope

Primary scope is the existing PR #78 11 paths above plus the smallest narrowly-related tests necessary to prove current-main compatibility.

Allowed only when necessary for the memory-to-generation contract:
- read-only inspection of `supabase/functions/_shared/brand/social_mobile_content_settings.ts`
- read-only inspection/tests around `brand_post_generator.ts`
- a narrowly-scoped contract test may be added if it does not change the generator/runtime behavior.

Do not edit:
- G5 common-account / entitlement / lifecycle files or migration;
- Auth signup/login/provider wiring;
- account deletion;
- X OAuth/token/Vault paths;
- PR #41 generic live auto-post implementation;
- PR #76 publish permission code;
- morning greeting workflows;
- DB migrations, RLS, RPC, Cron;
- production settings or secrets.

If a required fix would cross one of these boundaries, STOP and report it as the next task rather than expanding scope.

## Fresh-main integration

Resolve PR #78 conflicts against current main deliberately.

Especially verify:
- final PR81 `SocialMobileContentSettings` shape;
- final persona provenance/confirmed fields;
- final `updated_at` CAS contract;
- 24:00 generation-window semantics;
- current RLS-facing repository calls;
- no old candidate migration assumptions remain in app/server code.

Do not weaken current PR81 validation to make PR78 fit.

## AI consultation behavior

Preserve/verify:
- authenticated user JWT only; no service-role shortcut;
- owner membership + `social_mobile_user_v1` workspace proof;
- tenant-safe not-found behavior;
- bounded request/history/body sizes;
- exactly one AI provider call per send;
- `gpt-5.6-luna`, structured output, `store:false`, no web/tools/X call;
- no conversation body/token/email/secret logging;
- untrusted model output allowlist + length/type validation;
- chat/question responses cannot carry mutation deltas;
- ambiguous user intent asks instead of silently proposing;
- proposal changes only explicitly requested editable fields;
- current settings explanation produces no delta;
- history-learning intent is detected but does not pretend to have read X history;
- publish/account/oauth/token/schedule/cron/approval/deletion/auth/entitlement changes remain forbidden.

## Explicit memory contract

The UI must make the state transition clear:

conversation
→ AI proposal
→ user sees exactly what will change
→ user presses explicit confirmation
→ latest settings are re-read
→ only proposal-target fields are applied
→ CAS on `updated_at`
→ stale/conflicting proposal refuses and asks for reconfirmation
→ confirmed state becomes the next consultation's saved context.

No implicit save on:
- send;
- AI reply;
- navigation;
- retry;
- app resume;
- preview/example mode.

Persona must be treated as remembered truth only after user confirmation.

## Memory-to-post-generation proof

This is a V1 acceptance requirement.

Prove with source/tests that:
- the exact confirmed settings/persona persisted by the consultation path materialize into the final `SocialMobileContentSettings` / confirmed persona contract;
- the current main post-generation guidance consumes those remembered values without a lossy/remapped shadow schema;
- preferred tone, themes/objective/notes/NG words and confirmed persona signals used by generation are preserved through save → read → guidance;
- unconfirmed persona is not treated as remembered guidance;
- unrelated read-only controls such as approval mode/generation time are not changed by consultation.

If the current live scheduled-user dispatcher that consumes this guidance still depends on open PR #41, do not implement PR #41 here. Instead, report the exact missing live wiring as a release blocker and prove the reusable generator contract only.

## UX / native verification

Use local iOS Simulator where practical.

Verify:
- normal conversation;
- loading;
- retryable provider error;
- question;
- proposal card;
- explicit "これで覚えて";
- successful save;
- stale-save conflict;
- continue conversation after save;
- keyboard/scroll/safe-area on narrow width;
- no misleading "保存済み" wording before confirmation.

No EAS build.

## Tests

At minimum:
- all PR78 consult server logic tests;
- all social-mobile consult/session/screen tests;
- content-settings repository tests;
- PR81-related content-settings tests affected by integration;
- targeted generation-guidance compatibility test;
- unauthorized / wrong-member / cross-brand refusal;
- unknown-key and dangerous-key model output refusal;
- one provider call maximum;
- no X call;
- no save before confirmation;
- stale CAS refusal;
- confirmed persona/settings re-read into next consultation;
- memory-to-generation guidance round trip;
- typecheck;
- lint;
- Deno check/lint for changed runtime;
- `git diff --check`;
- added-line secret scan.

Use fake model/X where appropriate. Do not make a paid real-AI production call in this task.

## Merge / production gates

This task is **source-only**.

Forbidden:
- PR merge;
- Edge deploy;
- PR81 production schema apply;
- DB/history write;
- Auth/Vault/OAuth/X/Cron mutation;
- production feature flag;
- real X post.

Reason:
PR81 production schema must be exact before the consultation endpoint can be activated safely, and G5 critical-path production work has priority.

At completion, if source integration/tests PASS:
- keep PR #78 open;
- report exact integrated head;
- status -> review_required / next_owner -> chatgpt;
- K3 will decide whether one focused review is needed.
- Do not request production deploy yet.

## Completion report

Include:
- task_id / result
- fresh main and original/new PR78 head
- conflicts and exact resolutions
- changed files
- memory contract proof
- memory-to-generation proof
- whether PR #41 remains required for live scheduled-user generation
- native verification
- tests
- production mutation = 0
- merge/deploy = 0
- G4/G5 conflict check
- remaining V1 blockers
- next recommendation

## Review policy

This is Auth/RLS-adjacent AI behavior but no new DB/auth/permission boundary is introduced.

Default after a clean focused integration:
- one independent review only if fresh integration materially changes auth/tenant/CAS/model-output safety boundaries;
- otherwise no routine rereview of already-reviewed unchanged contracts.
- if review is warranted, prefer **Luna（高）**; use Sol only for a concrete security-boundary change.

Recommended model: **Opus5.5（高）**.

## Report — x-social-mobile-ai-consult-v1-fresh-integration-20261006

- result: **PASS (source-only) — PR #78 fresh-integrated onto main; memory contract and memory-to-generation contract proven; PR kept open.** Production mutation 0, merge 0, deploy 0.
- fresh main merged: `5f37d63e` (this TASK's in_progress commit). Original PR78 head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` (confirmed exact before integration; single commit on merge-base `0c2c04e0`). New PR78 head: `d1f131c56b082d2af57660b5bd3d83ff8c619c7d` (GitHub: MERGEABLE) (non-destructive: merge commit `e9ed439b` + one commit `d1f131c5`; no rebase/force-push).
- worktree: new independent `/Users/yuya/Developer/kabumori-g3-ai-consult` (branch `g3-ai-consult-v1-int` → pushed to `claude/g3-ai-consult-v1-20261002`). G4/G5 worktrees, dev servers and the other session's Simulator rig were not touched.

### Conflicts / resolutions
- Textual conflicts: **0** (`content-settings-repository.ts` auto-merged: main's PR81 `saveConfirmedProposal` metadata stripping + PR78's `updatedAt` read and `saveConfirmedIfUnchanged`).
- Semantic checks against final PR81 (no PR81 validation weakened):
  - `SocialMobileContentSettings` shape: app validator, server `isSocialMobileContentSettings` and DB `valid_settings` agree (9 keys; the app never writes `livePublishingEnabled`; server re-adds it as `false`).
  - persona: `saveConfirmedIfUnchanged` strips `source/confirmed/analyzedAt/analyzedPostCount` from `persona_profile` and writes them to the dedicated columns, matching DB `valid_persona` (style-signal keys only). App/proposal bounds equal DB bounds (toneSignals 20×80, recurringVocabulary 30×50, topicSignals 20×80, openingClosingPatterns 20×100, free text 200; settings tone 120 / themes 8×100 / objective 160 / NG 20×60 / notes 1000).
  - CAS: `update … eq(brand_id) eq(updated_at, expected)` + `select` → 0 rows = stale; first save `insert` → 23505 = stale. Compatible with the hardening trigger (`updated_at = greatest(clock_timestamp(), old+1µs)`, server-owned) and RLS owner policies (authenticated SELECT/INSERT/UPDATE only).
  - 24:00: PR78's app `endTimePattern` makes the saved 24:00 default valid (server and DB already accept it in the window end only). PR81's repository test comment that worked around it is now obsolete and was updated.
  - repository/server reads use the final PR81 column names; no candidate-only assumptions remain.

### Changed files (vs main)
PR78's 11 paths, plus:
- `apps/social-mobile/src/app/(tabs)/consult.tsx` — fix: a signed-in (non-preview) workspace that is unreachable at confirm time now reports 「いまは保存できません…」 and saves nothing; previously it showed the sample-preview text 「ローカルプレビューとして確認しました」 and updated local state (misleading).
- `apps/social-mobile/tests/consult-screen.test.mjs` — regression test for that (fails without the fix).
- `apps/social-mobile/tests/consult-memory-generation.test.mjs` — new contract test (below).
- `apps/social-mobile/tests/content-settings-repository.test.mjs` — uses the 24:00 defaults directly.
No change to generator/runtime, DB migrations, RLS, Auth, X/OAuth, PR76, G5 or workflow files.

### Memory contract proof (real screen code with stubbed RN/network, plus pure logic)
- answer arriving / chat / question / explanation / retry / failure / dismiss / preview / unreachable-workspace: **0 writes** (consult-screen + consult tests).
- only 「これで覚えて」 → re-read latest → `planConfirmedSave` (delta onto latest, unrelated newer values kept) → `saveConfirmedIfUnchanged` with the re-read `updated_at` → success re-reads and becomes the next turn's saved context.
- a proposed field changed elsewhere → `reconfirm`, nothing written; row changed between re-read and write → `stale`, nothing written, proposal rebased and the user asked to press again.
- persona is written only when the proposal changed it, always `persona_confirmed=true`, `persona_provenance='conversation'`; settings-only confirmation never touches persona columns.
- server endpoint is read-only (`settings_saved=false` etc. enforced client-side), one provider call per send, `gpt-5.6-luna`, `store:false`, no tools/web/X, model output allowlisted; chat/question cannot carry deltas; publish/OAuth/token/schedule/approval/account keys refused.
- tenant: verified Auth user + owner membership read with the caller's JWT + `social_mobile_user_v1` profile; missing/non-owned → same 404; no service role in the endpoint.

### Memory-to-generation proof (`consult-memory-generation.test.mjs`, 4 tests, real code at every hop)
validated AI proposal → `planConfirmedSave` → repository `saveConfirmedIfUnchanged` (recorded PostgREST insert) → that exact row returned by a stubbed PostgREST → real `handleSocialMobileBrandDryRun` reader (`normalize` + `materialize`) → real `generateBrandPost` with stubbed OpenAI fetch:
- every saved settings field arrives unchanged (no remap), `livePublishingEnabled=false`, `personaProfile` = confirmed conversation persona;
- prompt contains tone, objective, themes, NG words, notes and the confirmed persona lines (文体傾向 / 記号・絵文字 / 語彙);
- approvalMode / generationWindow / frequency unchanged by consultation;
- the same row is the next consultation's saved context (real consult handler);
- an unconfirmed persona produces no 「確認済み」 guidance and is hidden from the next consultation; nothing saved → code defaults.
- mutation check: renaming one guidance line, or saving `persona_confirmed=false`, makes the test fail.

### Live scheduled-user generation — release blockers (not implemented here)
1. On main, the only consumer that reads `social_mobile_content_settings` into generation is the user-JWT **dry-run preview** (`social-mobile-brand-dry-run`). `x-test-post`'s live `generateBrandPost` call is the AI Lab path and passes no content settings. Live scheduled-user generation still depends on **open PR #41** (`vault_account_brand_post.ts` `loadSocialMobileContentSettings`), which uses the same normalize/materialize contract.
2. PR #41 reads the table with **service_role**, but the final PR81 hardening ACL grants service_role **nothing** on `social_mobile_content_settings` (authenticated S/I/U only). As written, PR #41's read would be refused and fail closed (`CONTENT_SETTINGS_READ_FAILED`), and its consent check (`x_account_publish_authority` reading `approvalMode`) has the same dependency. Needs a reviewed decision (narrow SELECT grant for service_role vs. a definer reader) in a separate DB task — not done here.
3. Generation guidance consumes only `sentenceLength`, `punctuationEmoji`, `recurringVocabulary` from the persona and the first 300 chars of notes. `toneSignals`, `topicSignals`, `hashtagHabits`, `ctaStyle`, `openingClosingPatterns` confirmed in consultation are saved and re-read (and shown to the next consultation) but **not used by post generation**. Changing guidance is outside this task's scope (generator read-only); recommend a small follow-up.
4. PR81 production schema still HOLD; the consult endpoint is not deployed. Until both, the app's real-data path falls back to "unavailable".

### Native verification
- iOS Simulator iPhone 18 Pro (402pt, iOS 27), local dev build (SDK-26 build-version patch on a scratch copy of the .app, as before), **real taps/swipes** via the Simulator control. No EAS.
- The app gates every screen behind sign-in, and the Simulator control could not type into the TextInput, so a **temporary uncommitted rig** was used: auth gate bypassed in `_layout.tsx`; in `consult.tsx` only the dependency bindings were swapped (data status=ready, session token, `supabase.functions.invoke` → scripted endpoint envelopes parsed by the real `requestConsult`/`parseConsultResponse`, repository → versioned in-memory row, TextInput → tap-to-fill scripted messages). All screen logic/reducer/save planning ran unmodified. Rig fully reverted (`git status` clean), app uninstalled, build folder deleted.
- verified on device: question reply (no proposal card); proposal card listing only changed fields with 「まだ保存していません。変わるのは次の項目だけです。」 and 「これで覚えて」/「この提案をやめる」; loading 「AIが考えています…」; retryable provider error 「AIが混み合っています…」 + 「もう一度送る」 → retry resent once (user turn not duplicated) while the pending proposal stayed; settings changed elsewhere → 「保存されている設定が、この提案のあとに変わっていました…もう一度「これで覚えて」を押してください。」 and nothing overwritten; second confirm → 「確認した内容を保存しました。投稿権限や投稿実行は変更していません。」 and the card closed; conversation continued after save and the next answer reflected the saved tone/themes; scrolling OK.
- not verified natively: the software keyboard (rig input), 375pt narrow width (402pt only; layout is single-column flex and the screen harness covers state), real endpoint/DB (not deployed by design).
- pre-existing app-wide issue observed (not introduced here, not fixed): every tab's `Screen` has no top safe-area inset with `headerShown:false`, so headings overlap the status bar/clock on iPhone 18 Pro (Home, AI相談, …). Recommend a separate small UI task (G4 UI).

### Tests
- app: `npm test` 193/193 (includes consult 29, consult-screen 12, memory-generation 4, repository 3); `tsc --noEmit` clean; `expo lint` clean.
- Deno (`--no-config`, `DENO_NO_PACKAGE_JSON=1`, `--allow-read`): social-mobile-consult + brand-dry-run + content-settings (+hardening static, migration) 52/52; `deno check` index/logic_test/dry-run clean; `deno lint` consult clean. `brand_post_generator_test.ts` 13/13 with `--no-check` (its 3 type errors under `--no-config` are pre-existing on main, file untouched).
- `git diff --check` clean; added-line secret scan (whole PR diff vs main) 0 hits.
- no paid AI call, no X call (all model/X/PostgREST stubbed).

### Gates
- production mutation 0; Edge deploy 0; PR81 apply 0; DB/history write 0; Auth/Vault/OAuth/X/Cron 0; real X post 0; EAS 0.
- PR #78 not merged (kept open). No feature flag.
- G4/G5 conflict check: open PRs #93 (G5 backfill), #41, #33 touch none of these paths; G5 common-account / entitlement / G4 morning-greeting files untouched.

### Remaining V1 blockers / next recommendation
- PR81 production apply (after G5 critical path) → then deploy `social-mobile-consult` (verify_jwt=true) with the reviewed OPENAI secret path.
- Decide the service_role read path for live generation (blocker 2), then fresh-integrate PR #41 (blocker 1).
- Small follow-up: make generation guidance use the remaining confirmed persona signals (blocker 3).
- App-wide top safe-area overlap (pre-existing) — separate UI task.
- Review: integration did not change auth/tenant/CAS/model-output boundaries (one UI fail-closed fix + tests). Suggest no extra review, or at most one focused Luna（高） pass on `consult.tsx` confirm path if K3 wants it.
- status → review_required / next_owner → chatgpt. STOP.

---

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr81-production-apply-continuation-20261006
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: highest
- recommended_model: Opus5.5（高）
- type: production schema continuation / same-day preflight / exact atomic apply / post-apply read-back
- source_pr: 81
- merged_main_sha: 686f23a7094389b793470503fceb2f47a71f8fbf
- prerequisite_pr76: satisfied
- blocks_pr: 78
- production_mutation_allowed: false

## Purpose

PR #76 production prerequisite is now satisfied and Final K4 PASS.

Verified production state before this allocation:
- PR76 history exact: `20261003090000 / social_mobile_publish_permission_boundary` = 1 row;
- exact two PR76 SECURITY DEFINER RPCs present with expected owner/search_path/effective EXECUTE graph;
- `x-test-post` active with guarded runtime;
- `social-mobile-publish-setting` ACTIVE v1 / verify_jwt=true;
- running=0 / overdue pending=0;
- G4 production_mutation_window = CLOSED.

Resume the previously accepted PR #81 rollout plan.

Target files:
- `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`
- `supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql`

Accepted SHA256:
- candidate: `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`
- hardening: `83d44ccfd51bcd8fcd78d31236fa52d1d8f90c6642f12c5bb1586f9d1497467e`

Reviewed production apply method:
one operator-controlled
`psql -X --single-transaction -v ON_ERROR_STOP=1`
session containing:
1. candidate SQL;
2. hardening SQL;
3. exact history insert for `20260922045046 / social_mobile_content_settings_candidate`;
4. exact history insert for `20261003120000 / social_mobile_content_settings_hardening`.

No `db push`, no `migration up`, no `--include-all`, no history repair, no unrelated migration.

## Startup / isolation

1. Read ORCHESTRATION / CURRENT_STATE / Final K4 PR76 / Final C2 PR81 / prior G3 report / this TASK.
2. Use fresh `/Users/yuya/Developer/kabumori-fresh` and a new independent G3 worktree.
3. Fetch fresh origin/main.
4. Confirm current main still contains PR81 accepted merge and both SQL files are byte unchanged.
5. Do not touch G4 worktree/runtime or G5/common-account work.
6. Production mutation mutex: before any production write, verify G2/G5/other slots are not mutating production. If another production mutation window is ACTIVE, STOP.
7. Do not read secrets/token plaintext/user content.

## Gate A — same-day production ordering

Read-only verify:
- PR76 history exact one row;
- PR82 history exact one row;
- PR81 candidate and hardening history absent unless legitimately already applied;
- no version/name collision;
- no newer unresolved prerequisite that changes the reviewed order;
- do not reorder/repair history.

If PR76 is not exact anymore, STOP.

## Gate B — fresh production preflight

One explicit READ ONLY transaction.

Verify:
- `public.social_mobile_content_settings` absent unless an exact reviewed prior apply exists;
- same-prefix helper functions absent unless exact;
- exact live migration-ledger shape;
- applying role = reviewed owner assumptions;
- `brands` / `brand_memberships` dependencies unchanged;
- default ACL and API role graph unchanged from accepted H2 baseline;
- no same-name relation/function/policy/trigger collisions;
- no unexpected overload/grant drift.

Any drift => STOP; no repair.

## Gate C — freeze exact package

Freeze:
- fresh main SHA;
- both SQL SHA256;
- exact two version/name pairs;
- exact operator command;
- exact post-apply read-back SQL;
- failure/abort behavior.

Run local syntax/diff/secret checks only as needed. Do not modify accepted migrations.

## Mandatory STOP for approval

After A/B/C are clean, STOP before first production write and report:
- project identity;
- fresh main SHA;
- exact hashes;
- current ledger state;
- exact outer transaction;
- expected schema/history changes;
- mutex state;
- rollback/abort behavior;
- confirmation PR76/PR82/G5 are not bundled.

Request fresh explicit approval for PR81 production apply.

TASK creation or prior approvals do not authorize mutation.

## After fresh explicit approval only

Immediately rerun Gate A/B.
If any material state changed, approval is invalid; STOP.

Then execute only the reviewed outer transaction.

Open a new separate READ ONLY session and verify:
- exact two history rows;
- table columns/types/nullability/defaults exact;
- PK/index immediate, nondeferrable, valid/ready/live;
- FK/check constraints exact;
- finite timestamp CHECK exact;
- RLS enabled;
- exact policies;
- table effective ACL exact;
- helper signatures/owners/search_path/effective EXECUTE exact;
- exact one expected version trigger;
- no overloads/unexpected grants/column ACL.

Mismatch => STOP, no auto-drop/history repair, no PR78 continuation.

No Edge deploy in this task.

## PR78 continuation

Only after PR81 production schema/read-back PASS:
- report schema prerequisite satisfied;
- do not merge/rebase PR78 inside the same production mutation;
- next G3 task should fresh-integrate/rebase PR #78 current head onto fresh main and resume remaining AI/Auth/security work.

## Safety

Before explicit approval forbidden:
- production DDL/DML/history write;
- Edge deploy;
- X/OpenAI/Auth/Vault/OAuth/Cron mutation.

Always forbidden:
- accepted migration rewrite;
- PR76/PR82/G5 bundling;
- history repair/reorder;
- production test data writes.

## Completion / K3

Report:
- result
- fresh main
- Gate A/B/C
- hashes
- approval requested/received
- exact production mutations
- post-apply read-back
- deploy=0
- X/OpenAI/Vault/OAuth/Cron=0
- whether PR78 may resume
- remaining risks
- next recommendation

Then status -> review_required / next_owner -> chatgpt / STOP for K3.

Review policy:
- PR81 source and migration plan already had independent final review.
- do not add routine Codex review after exact apply/read-back PASS.
- only review if a concrete production mismatch or source change appears.

Recommended model: **Opus5.5（高）**.

## Report — x-social-mobile-pr81-production-apply-continuation-20261006

- result: **PREFLIGHT_READY / HOLD — Gate A/B/C PASS (read-only); approval NOT requested** because Final K5 (`2328415d`) holds G3 production writes while the G5 common-account production-apply decision is pending. Production mutations **0**.
- fresh main at start: `af4c8996` (this TASK's in_progress commit; contains PR81 merge `686f23a7`). Main later advanced to `8f86112f` (K5 hold + G4 morning-greeting allocation, control files only; PR81 files untouched).
- worktree: new independent `/Users/yuya/Developer/kabumori-g3-pr81-apply` (detached). G4/G5 worktrees not touched (G4 `s3_stage_a.sh` only read for the pooler connection pattern).
- hashes (byte-unchanged vs accepted): candidate `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`; hardening `83d44ccfd51bcd8fcd78d31236fa52d1d8f90c6642f12c5bb1586f9d1497467e`.
- local proof on fresh main (PG 17.11, UTF8, disposable): `social_mobile_content_settings_run.sh` → `SOCIAL_MOBILE_CONTENT_SETTINGS_ALL_PASS` (48 markers). Note: a cluster made with `--locale=C` but without `-E UTF8` is SQL_ASCII and fails the length checks — always `-E UTF8`.

### Gate A — ordering (read-only, user-run at 2026-10-06 05:28 UTC; auto mode denies Claude's production reads)
- ledger 74 rows (was 72 on 10/05): +`20261003090000 social_mobile_publish_permission_boundary` (1 row) and +`20261004090000 ai_lab_topic_claims` (1 row) — exactly PR76 and PR82.
- versions ≥ 20261002: only `20261002090000`, `20261003090000`, `20261004090000`. PR81 versions/names absent; no collision.
- pre-existing, unrelated: duplicate ledger name `add_us_premarket_report` (two versions) — reported only. Earlier ledger notes (repo `20260929090000` missing from ledger; ledger-only `20260924001508`/`20260924024406`) unchanged.
- common-account `20261001150000` is unapplied and sorts between the PR81 candidate and hardening versions; it is a separate file/feature with no object overlap, but if G5 applies first, Gate A/B must be re-read (ledger/default ACL baseline changes).

### Gate B — fresh preflight (one READ ONLY transaction; `transaction_read_only=on`)
- diff vs the accepted 10/05 baseline: **only** the ledger changes above (+ newly added probe keys). Target table/any-schema same-name relation absent; same-prefix routines/policies/triggers/constraints 0; ledger shape (version text PK, statements, name, created_by, idempotency_key UNIQUE, rollback; no triggers) unchanged; `current_user=postgres` (non-superuser, bypassrls), owns `brands`; brands/brand_memberships columns/constraints/RLS/self-select policy unchanged; auth.uid unchanged; default ACL (postgres→anon/authenticated/service_role TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on tables; functions postgres only) unchanged; public schema ACL and API role graph unchanged.
- new probe: production event trigger `ensure_rls` (`rls_auto_enable`, SECURITY DEFINER, ddl_command_end on CREATE TABLE in `public`; src md5 `99be20677b456ea8d3be47bdd44fb369`) runs `alter table … enable row level security` and swallows errors. The candidate enables RLS itself, so the effect is idempotent. Reproduced byte-identically (same md5) in the local rehearsal: apply + read-back exact, `force_rls=false`.
- probe-filter note: `pr76_rpcs=[]` is a too-narrow name filter (`social_mobile_%publish%`); PR76 functions are `set_social_account_publish_enabled` / `assert_x_publish_permission_for_legacy_post`, already independently read back at K4. Not drift.

### Gate C — frozen package (untracked, `/Users/yuya/Developer/kabumori-g3-pr81-apply/.g3-local/`)
- `pr81_apply.sh` — operator runs it; checks 4 SHA-256 then ONE `psql -X --single-transaction -v ON_ERROR_STOP=1` via session pooler (`aws-0-ap-northeast-1.pooler.supabase.com:5432`, `postgres.wsmznyzcvmuitkglfeuj`, password prompt, sslmode=require): `select current_user` → `pr81_guard.sql` → candidate → hardening → `pr81_history_insert.sql`. Exit 0 = committed; 3 = whole transaction rolled back; never rerun blindly.
- `pr81_guard.sql` `bb78f9700b903e55b23d3c33cd1b322e67faa5e34ced5328e3b7fe8438703ab8` — operator-side fail-closed assertion only (no schema change): `set local lock_timeout='5s'`; current_user=postgres; PR76 history exact 1 row; PR81 history/objects absent.
- `pr81_history_insert.sql` `bf8778d9f315815357911bffaa0ceb18383106441da5cca3d50520115ff17311` — exactly `(20260922045046, social_mobile_content_settings_candidate)` and `(20261003120000, social_mobile_content_settings_hardening)`, `(version, name)` only as reviewed.
- `pr81_readback.sql` `12f136b10c450c20578b47df03b8d0b1eff04a39e78556a0eca10923d850c5d4` — separate READ ONLY session: history rows, columns/defaults/column ACL, constraints (deferrable/validated/def), PK index flags, RLS/force, policies, trigger, table ACL + effective privileges, function owner/secdef/volatility/search_path/src md5/ACL/effective EXECUTE, overloads, row count only. Expected output frozen from the local prod-shaped rehearsal in `readback_expected_local.json` (only `ledger_count` should differ: production expects 76).
- local prod-shaped rehearsal (role named `postgres`, nonsuperuser bypassrls; ensure_rls copy; ledger with PR76/PR82 rows) of the exact script: first run hit a local-only schema-permission error inside the guard → exit 3, nothing left (proves abort path); after fixing the local fixture → exit 0, `PR81_GUARD_OK`, 2 history rows; immediate rerun → `PR81_GUARD: PR81 history already present`, exit 3.
- expected read-back: 9 columns; 7 constraints all non-deferrable/validated incl. `finite_versions`; PK btree immediate/valid/ready/live; RLS on / force off; 3 owner policies (select/insert/update) for authenticated; one `social_mobile_content_settings_version` BEFORE INSERT OR UPDATE trigger; 5 functions owner postgres, non-secdef, `search_path=pg_catalog`; effective table privileges anon none / authenticated SELECT,INSERT,UPDATE / service_role none; EXECUTE authenticated on 4 validators only; overloads 0; rows 0.

### Approval / mutations / side effects
- approval requested: **no** (K5 hold). approval received: no.
- production DDL/DML/history writes 0; deploy 0; X/OpenAI/Auth/Vault/OAuth/Cron 0. Production reads: one user-run catalog/ledger-only READ ONLY preflight (no user content/PII/token/Vault).
- PR78 may resume: **no** (PR81 schema not applied).

### Remaining risks / next recommendation
- Decide order between G5 common-account apply and G3 PR81 apply (mutex: never concurrent). If G5 goes first, G3 resume must rerun the preflight (`.g3-local/pr81_preflight_v2.sql`, sha `6c9782a1…`) and accept G5's reviewed deltas before requesting approval.
- On resume: fresh mutex check → user-run preflight → diff → request explicit approval with this package → immediate Gate A/B re-read → operator runs `pr81_apply.sh` (needs the DB password reset during G4) → user-run `pr81_readback.sql` → compare to `readback_expected_local.json`.
- Pre-existing ledger irregularities (missing `20260929090000`, ledger-only `20260924001508/024406`, duplicate name `add_us_premarket_report`) remain for a separate ledger-hygiene task; they do not affect the manual PR81 path.
- status → review_required / next_owner → chatgpt. STOP.

---

# Previous G3 task history — preserved below

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr81-production-schema-gate-20261005
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- type: production migration gate / read-only preflight / ordered rollout / post-apply read-back
- source_pr: 81
- merged_main_sha: 686f23a7094389b793470503fceb2f47a71f8fbf
- blocks_pr: 78
- production_mutation_allowed: false

## Purpose

PR #81 content-settings hardeningは source実装・H2最終レビュー・main mergeまで完了済み。

本来の次工程は:

1. production schemaのsame-day read-only preflight
2. pending migration順序の確認
3. explicit user approval後に、PR #81の2ファイルをreview済みのouter transactionでproductionへ適用
4. separate-session read-back
5. その完了後にPR #78 AI相談 v1をfresh mainへrebase/integrateして残りレビューを再開

このTASKでは、まず1〜2と適用準備まで行う。

**production mutationは、TASKに書いてあるだけでは許可しない。**
実際のapply直前にユーザーの明示承認が必要。
承認前は必ずSTOPする。

## Mandatory startup / isolation

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / this TASK / Final C2 for PR #81 / H2 final report.
2. New Mac clean base: `/Users/yuya/Developer/kabumori-fresh`.
3. Fresh `origin/main`からG3専用の独立worktree/checkoutを使用。
4. Confirm main contains PR #81 merge `686f23a7094389b793470503fceb2f47a71f8fbf`.
5. Confirm these exact merged files are unchanged:
   - `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`
   - `supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql`
6. G4/PR #76 is a separate workstream. Do not edit its files/worktree.
7. Do not touch AI Lab PR #82 runtime/migration.
8. Do not touch common-account G5/H1 work.
9. No production user content/PII/token/Vault plaintext reads.

## Gate A — fresh migration ordering / pending history

Before any production mutation, read-only verify current source + production ledger.

Relevant versions:
- PR #76: `20261003090000_social_mobile_publish_permission_boundary`
- PR #81: `20261003120000_social_mobile_content_settings_hardening`
- merged PR #82: `20261004090000_ai_lab_topic_claims`
- historical PR #81 candidate: `20260922045046_social_mobile_content_settings_candidate`

Rules:
- if PR #76's earlier `20261003090000` is still an active pending/unmerged/unapplied workstream, **do not apply PR #81 ahead of it by assumption**.
- report the exact ordering conflict and STOP at read-only HOLD unless ChatGPT/user has separately resolved the rollout order.
- do not fake/repair/reorder migration history to bypass this.
- if PR #76 is merged and its production disposition is known, re-evaluate with fresh ledger.
- PR #82 being merged does not authorize its production apply and must not be bundled.

## Gate B — PR #81 production read-only preflight

Use one explicit READ ONLY production transaction and verify:

- target table `public.social_mobile_content_settings` absent unless an explicitly reviewed prior apply happened;
- same-prefix helper functions absent unless exact reviewed shape exists;
- both PR #81 migration versions absent from ledger unless already legitimately applied;
- exact live `supabase_migrations.schema_migrations` column/constraint shape;
- applying role identity;
- `brands` / `brand_memberships` dependency shape;
- current default table/function ACL relevant to the migration;
- current API role membership graph;
- no target-version/name collision;
- no unexpected same-name relation/function/policy/trigger.

If any drift from the H2-reviewed preconditions is found:
- STOP;
- do not apply;
- do not repair;
- report exact mismatch.

## Gate C — freeze reviewed production apply package

If A/B are clean and ordering is resolved, prepare but do not execute:

- exact current main SHA;
- SHA256 of both PR #81 SQL files;
- exact migration version/name pairs;
- exact operator command/runbook based on the H2-reviewed procedure;
- pre-apply and post-apply read-back SQL;
- failure/abort conditions.

Reviewed apply policy:
- direct operator-controlled `psql -X --single-transaction -v ON_ERROR_STOP=1`;
- candidate + hardening + exact two migration-history records in the same outer transaction;
- no `supabase db push`;
- no `migration up`;
- no Management API migration apply;
- no history repair/reconcile;
- no unrelated pending migration;
- production connection supplied securely outside logs/chat.

Do not change the two merged SQL files.

## Mandatory STOP for approval

When Gate A/B/C are complete, STOP before the first production write.

Report to ChatGPT/user:
- exact production project identity;
- fresh main SHA;
- exact migration hashes;
- current ledger state;
- PR #76 ordering status;
- exact operation proposed;
- expected schema/history changes;
- rollback/abort behavior;
- confirmation that no other migration/deploy is included.

Then request explicit production-apply approval.

Do not treat this TASK creation or a previous generic “continue” as mutation approval.

## After explicit approval only — production apply

Only if ChatGPT/user explicitly approves after the above STOP:

1. repeat fresh same-day Gate A/B reads immediately before mutation;
2. if any state changed -> STOP and invalidate approval;
3. execute the exact reviewed outer transaction only;
4. do not retry blindly on lost/ambiguous response;
5. open a new separate read-only session and verify:
   - both ledger rows exact;
   - target table exact columns/types/nullability/defaults;
   - PK/index immediate/nondeferrable/valid/ready/live;
   - FK/check constraints exact;
   - finite timestamp CHECK exact;
   - RLS enabled and policies exact;
   - table effective ACL exact;
   - helper signatures/owners/search_path/exact effective EXECUTE;
   - single expected version trigger;
   - no unexpected overloads/grants/column ACL.
6. if read-back mismatch:
   - STOP;
   - do not auto-drop;
   - do not history-repair;
   - do not proceed to PR #78;
   - report exact committed state for separate recovery decision.

No Edge deploy is part of this schema task.

## PR #78 continuation gate

Only after production PR #81 apply + read-back is PASS:

- fresh-check PR #78 exact current head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`;
- do not silently merge/rebase it inside this same mutation step;
- report that schema prerequisite is satisfied;
- next G3 task should fresh-integrate/rebase PR #78 onto current main and resume its unfinished Auth/AI/security gates.

PR #78 remains unmerged until that separate continuation.

## Safety

Forbidden before explicit mutation approval:
- production INSERT/UPDATE/DELETE/DDL;
- migration/history write;
- Edge deploy;
- Auth/Vault/OAuth/X/OpenAI mutation;
- Cron/scheduler/settings changes;
- PR #78 merge/deploy;
- PR #76 changes.

Always forbidden in this task:
- rewriting accepted PR #81 migrations;
- broad migration repair;
- bundling PR #76 or PR #82;
- production test data/user-content writes.

## Verification

Before approval:
- read-only production catalog/ledger preflight;
- local command/runbook syntax check;
- verify exact source hashes;
- `git diff --check`;
- no source changes expected except .agent unless a bounded operator-readback script is truly necessary.

After approved apply:
- separate-session production read-back only;
- no app/Edge/runtime test required for schema-only change beyond existing accepted source tests.

## Completion / K3

Report:
- task_id/result
- fresh main
- PR #76 ordering disposition
- production preflight
- exact SQL hashes
- whether approval was requested/received
- exact production mutations, if any
- post-apply read-back, if any
- production deploy = 0
- X/OpenAI/Vault/OAuth/Cron = 0
- remaining blockers
- whether PR #78 may now resume
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Review policy:
- this is execution of an already independently reviewed migration plan.
- do **not** automatically add another Codex review after a clean exact apply/read-back.
- if only read-only preflight/HOLD occurs, no review is needed.

## Report — x-social-mobile-pr81-production-schema-gate-20261005

- task_id: x-social-mobile-pr81-production-schema-gate-20261005
- result: **HOLD (read-only) — Gate B CLEAN, Gate A ordering unresolved; Gate C not frozen; no approval requested; production mutations 0.** Model: Opus 5.5.
- fresh main at start: `2eebb066` (contains PR #81 merge `686f23a7094389b793470503fceb2f47a71f8fbf`). Isolated G3 worktree created from the new clean base: `/Users/yuya/Developer/kabumori-g3-schema-gate` (detached on origin/main).
- exact SQL hashes (unchanged since the merge; `git diff 686f23a7..HEAD` empty for both):
  - `20260922045046_social_mobile_content_settings_candidate.sql` sha256 `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`
  - `20261003120000_social_mobile_content_settings_hardening.sql` sha256 `83d44ccfd51bcd8fcd78d31236fa52d1d8f90c6642f12c5bb1586f9d1497467e`

### Gate A — ordering: HOLD
- PR #76 `20261003090000_social_mobile_publish_permission_boundary` is **OPEN / unmerged** (head `5448e545f4a88bbf6597a981c0bcbe4c01043c30`) and **absent from the production ledger**. It sorts before PR #81's `20261003120000`. CURRENT_STATE also records this order as unresolved. Per the TASK, PR #81 is not applied ahead of it by assumption; no history reorder/fake/repair.
- PR #82 `20261004090000_ai_lab_topic_claims` is merged but **not applied** in production (ledger absent); it sorts after PR #81 and is not bundled.
- Needed decision (ChatGPT/user): either apply PR #76's migration first when it is ready, or explicitly accept PR #81 going first (then a later PR #76 apply is out-of-order for the CLI and must use the same reviewed manual procedure or `--include-all`, decided then).

### Gate B — production read-only preflight: CLEAN
One `BEGIN TRANSACTION READ ONLY` catalog/ledger query (`transaction_read_only=on`), **run by the user in their own terminal** because Claude's production read was refused by the auto-mode classifier; Claude read only the user's output file. Query sha256 `f74fbc29f8e90961b86323aef2b3b9736ea11d98a3ffa44bf90c1b0f61617054` (syntax-tested first on a throwaway local PostgreSQL, since removed). No user content, PII, tokens or Vault data selected. Results (checked_at 2026-10-05T14:32:55Z, project `wsmznyzcvmuitkglfeuj`, PostgreSQL 17.6):
- `public.social_mobile_content_settings` absent (no same-name relation in any schema); same-prefix routines 0, policies 0, triggers 0, constraints 0.
- Ledger: 72 rows; versions 20260922045046 / 20261003090000 / 20261003120000 / 20261004090000 and matching names all **absent**; latest applied `20261002090000`. Ledger columns: version text NOT NULL PK, statements text[], name text, created_by text, idempotency_key text UNIQUE, rollback text[] — all but version nullable, no triggers, so the reviewed `(version, name)` history insert fits.
- Applying role: `postgres` (current_user = session_user, not superuser), owner of `public.brands` — matches the hardening guard's owner rules.
- Dependencies: brands.id text NOT NULL PK; brand_memberships(brand_id text FK -> brands ON DELETE CASCADE, user_id uuid FK -> auth.users ON DELETE CASCADE, role CHECK owner/admin/member/viewer, PK (brand_id,user_id)), RLS on, self-select policy for authenticated using `(select auth.uid()) = user_id`, authenticated SELECT granted; auth.uid() stable, not SECURITY DEFINER.
- Default ACL (postgres, public): tables -> owner + anon/authenticated/service_role TRUNCATE/REFERENCES/TRIGGER/MAINTAIN (as H2 recorded; normalised by the hardening, allowed by its grantee guard); functions -> EXECUTE to postgres only. No global (all-schema) defaults. Public schema: USAGE for PUBLIC/anon/authenticated/service_role, CREATE only pg_database_owner.
- Role graph: authenticator, postgres and supabase_realtime_admin are members of anon/authenticated/service_role (expected Supabase shape; inherited privileges therefore follow the hardened grants).
- Verdict: no drift from the H2-reviewed preconditions.

### Gate C — not frozen (ordering unresolved)
The reviewed procedure remains `supabase/tests/social_mobile_content_settings_rollout.md` (one `psql -X --single-transaction -v ON_ERROR_STOP=1` session: candidate + hardening + two `(version, name)` history rows; no db push / migration up / Management API apply / repair; no other migration). It will be frozen with a fresh same-day preflight once the order is decided.

### Approval / mutations
- Production apply approval: **not requested** (Gate A HOLD). Production writes / DDL / history: **0**. Deploy: **0**. X/OpenAI/Vault/OAuth/Cron: **0**. PR #76/#78/#82 untouched.

### Pre-existing ledger observations (not touched, outside PR #81)
- `20260929090000_news_discovery_observer` exists in the repo but **not** in the production ledger (the history row known missing since the N3 canary).
- Ledger contains `20260924001508` and `20260924024406`, which have **no file** on main (remote-only versions).
Both matter for any future CLI `db push` and should be reconciled separately with approval; they do not affect the manual PR #81 procedure.

### Remaining blockers / PR #78
- Blocker: rollout order vs PR #76. PR #78 may **not** resume yet (schema prerequisite not applied).
- Local evidence files (untracked, not committed): `/Users/yuya/Developer/kabumori-g3-schema-gate/.g3-local/pr81_preflight.sql` and `pr81_preflight_out.json` (catalog/ledger metadata only).

### Next recommendation
ChatGPT/user decide the PR #76 vs PR #81 order. Then reassign G3: fresh same-day preflight (same query), freeze the package, request explicit production approval, apply the reviewed outer transaction, separate-session read-back; only then fresh-integrate PR #78.


---

# Withdrawn G3 allocation — user corrected routing; DO NOT EXECUTE

- task_id: ai-lab-pr82-production-rollout-runner-20261005
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- type: bounded production-rollout tooling / runbook / local rehearsal
- source_pr: 82
- merged_main_sha: 80e11c9207d44599db26a25195f1ee0091484231
- target_migration: 20261004090000_ai_lab_topic_claims.sql
- production_mutation_allowed: false

## Purpose

会社員AIラボ PR #82 の source implementation / review / main merge は完了済み。

残っているのは production rollout の **適用方式だけ**。

H1 read-only preflight で以下が確定している:
- production target table/functions/history version は未存在
- owner/default ACL/role-membership 前提は通る
- exact deploy target は `x-test-post` のみ
- Cron変更不要
- migration本体は自前の BEGIN/COMMIT を持つ
- Supabase CLI では migration SQL の COMMIT 後に history insert が走るため、schema + ledger は同一transactionにならない
- history insert失敗時に「schemaは入ったがledgerがない」状態があり得る
- migration本体を accepted source から書き換えてはいけない

このTASKでは、accepted migrationを変更せずに、本番反映を安全・再現可能に行うための **operator runner / runbook / local proof** を作る。

productionへの実行はしない。

## Isolation / startup

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / H1 preflight report / this TASK.
2. Use new Mac clean base `/Users/yuya/Developer/kabumori-fresh` with a fresh origin/main and independent G3 worktree.
3. Confirm merged PR #82 SHA `80e11c9207d44599db26a25195f1ee0091484231` is ancestor of current main.
4. G4 PR #76 is a separate active workstream. Do not touch PR #76 files/worktree/migration.
5. PR #81 is merged. Do not alter its migration/history plan.
6. No production connection, no production SQL, no deploy, no X call.

## Chosen rollout policy

Use the already-reviewed **schema-first / history-second checkpoint** policy rather than inventing a new migration or editing the accepted migration.

The runner must make this explicit:

### Stage A — exact schema apply
- apply ONLY the exact merged `20261004090000_ai_lab_topic_claims.sql`
- via direct psql/operator connection, not `supabase db push`, not `migration up`, not Management API
- preserve the migration's own BEGIN/COMMIT exactly
- ON_ERROR_STOP=1
- no include-all / repair / history rewrite
- no unrelated migrations

### Stage B — mandatory read-back checkpoint
After Stage A returns, before any history insertion:
- catalog-read exact target table/index/constraint/RLS/function owner/signature/security/search_path/effective ACL
- verify exactly five intended functions
- verify no unsafe/default/public API privileges
- verify target migration effects are fully present and safe
- if response was lost/ambiguous, inspect catalog first; never blindly rerun
- if catalog absent -> treat Stage A unapplied
- if catalog fully correct -> proceed to Stage C only with the exact same frozen source/version/name
- if catalog partial/unsafe -> STOP, no history write, no deploy, no automatic drop/down migration

### Stage C — narrow history record
Only after Stage B proves the target schema exactly correct:
- insert only the exact migration history record for version `20261004090000`, name `ai_lab_topic_claims`
- use a dedicated explicit transaction
- re-read ledger immediately
- never write/repair unrelated history rows
- if insert fails, leave schema in place and STOP with `schema present / history missing`; do not deploy and do not automatically retry/repair

The exact insert shape must be derived from the live ledger shape already documented by H1:
`version text NOT NULL PK, statements text[], name text, created_by text, idempotency_key text UNIQUE, rollback text[]`.
Do not assume fields beyond what is required; prove locally which minimal insert remains compatible with CLI pending/version detection.

## Required deliverables

Prefer adding:
- `supabase/tests/ai_lab_topic_claims_rollout.sh`
- `supabase/tests/ai_lab_topic_claims_rollout.md`

The shell runner must default to **local/disposable only** and refuse accidental production execution unless an explicit operator-only environment switch is provided in a future authorized run. Do not embed production URL/project ref/credentials.

It should support/rehearse:
- preflight
- Stage A exact migration apply
- Stage B catalog verification
- Stage C ledger insertion
- postflight
- failure modes

Do not make it a generic migration runner.

## Failure-state proof

Use disposable PostgreSQL only and prove:

1. clean success:
   - no schema/no history
   - Stage A -> exact schema
   - Stage B PASS
   - Stage C -> one exact history row
   - postflight PASS

2. migration SQL failure before COMMIT:
   - no target schema
   - no history

3. lost/unknown Stage A response simulation:
   - catalog determines whether schema exists
   - runner never auto-reruns before catalog read-back

4. Stage B detects unsafe/partial catalog:
   - no history insertion
   - no deploy recommendation

5. Stage C history INSERT failure:
   - schema remains exact
   - history absent
   - runner STOPs and marks operator-review-required
   - no automatic history repair/retry

6. rerun after fully completed rollout:
   - detects exact schema + exact history and becomes no-op/read-only
   - does not duplicate schema/history

7. mismatch:
   - wrong history name/version or drifted target object -> STOP

## Production cutover runbook

Document exact future order, but do NOT execute:

1. same-day production read-only preflight
2. verify no running/overdue AI Lab work
3. freeze exact migration SHA and x-test-post source/import graph
4. Stage A schema apply
5. Stage B catalog/API-cache read-back
6. Stage C exact history insert
7. ledger read-back
8. verify no in-flight/overdue old worker immediately before deploy
9. deploy only exact `x-test-post`
10. read back Function version/status/verify_jwt/source-byte graph
11. no manual POST/scheduler/backlog injection
12. separately authorized natural-cycle observation

Document the cold-ledger limitation truthfully:
- no historical event-claim backfill
- dedupe guarantee is forward-looking from cutover
- no retroactive no-repeat guarantee for already-posted diary topics

## Scope / safety

Allowed:
- new rollout runner/docs/tests
- local disposable DB proof
- minimal static test updates if needed
- .agent task/report

Forbidden:
- editing accepted migration `20261004090000_ai_lab_topic_claims.sql`
- editing AI Lab runtime logic
- production DB/history writes
- Edge deploy
- Cron/gate changes
- real X/OpenAI/Vault/OAuth/token actions
- PR #76 / PR #81 changes
- generic migration-repair tooling

## Verification

Run:
- rollout shell in disposable DB across all failure states
- shell syntax
- relevant migration source invariant/static checks
- exact accepted migration SHA check
- `git diff --check`
- secret/project-ref scan

No broad app/runtime test rerun required because runtime source is unchanged.

## Completion / K3

Report:
- task_id/result
- changed_files
- accepted migration untouched proof + SHA
- runner/runbook design
- Stage A/B/C semantics
- failure-state results
- local tests
- production reads/writes = 0
- deploy/X/Vault/OAuth/Cron = 0
- exact future production operator sequence
- remaining risks
- whether an additional Codex review is truly necessary
- recommended reviewer model if needed, preferring Luna

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Review policy:
- do NOT automatically request Sol review.
- If K3 shows only runner/docs/test additions and all local failure-state proofs pass, prefer either no extra review or at most **Luna（高）** for a single focused rollout-script review.

---

# Previous G3 task history — preserved below

# Previous G3 task — preserved history

- task_id: x-social-mobile-pr81-hardening-residual-corrective-20261005
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（高）
- type: bounded corrective implementation / migration drift / function ACL / CAS finite-domain / rollout plan
- continues_from: x-social-mobile-content-settings-schema-hardening-20261003
- target_pr: 81
- current_head: 5595fb131813542c55c43bc783af623cdb9ea442
- blocks_pr: 78
- production_mutation_allowed: false

## C2 verdict / purpose

H2 rereview of PR #81 returned **CHANGES REQUIRED**.

Important:
- the original large F1 JSON/persona contract issue is closed for inspected writer shapes;
- the original table ACL/RLS flaw is closed;
- finite-path CAS and normal concurrency behavior are closed;
- most drift checks are closed.

This task is **not** a redesign. It must correct exactly the remaining adversarial boundaries and produce a safe production-apply plan.

PR #81 remains open/unmerged. Production apply is still forbidden.

## Freshness / isolation

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / this TASK / full H2 rereview report.
2. Use the existing isolated G3 worktree only.
3. Fetch fresh `origin/main`.
4. Confirm PR #81 exact head is still `5595fb131813542c55c43bc783af623cdb9ea442` before editing. If head moved, STOP.
5. Fresh C2 comparison: main is 62 commits ahead of PR base with **0 overlap** across PR #81 files; still recheck before push.
6. G4 PR #76 and direct AI-Lab PR #82 are separate. Do not touch their migrations/files.
7. No production apply/write/deploy/Auth/Vault/X/OpenAI/Cron mutation.

## Residual R1 — reject deferrable PK drift

Current hardening validates PK key columns/count but not enough of the PK/index semantics.

H2 reproduced:
- replace the expected PK with `PRIMARY KEY (brand_id) DEFERRABLE INITIALLY IMMEDIATE`;
- hardening succeeds;
- actual repository `INSERT ... ON CONFLICT (brand_id) DO UPDATE` then fails with SQLSTATE 55000.

Correction requirements:
- explicitly require the expected immediate, non-deferrable PK contract;
- verify the backing unique index is usable as an ON CONFLICT arbiter;
- reject deferrable / initially deferred / unexpected PK/index drift;
- do **not** silently repair an unknown PK definition;
- add a disposable DB regression using the actual Settings upsert pattern, not catalog-only assertions.

Expected result:
- exact candidate PK -> accepted;
- deferrable/wrong PK -> hardening refuses before mutation;
- real owner upsert remains successful after hardening.

## Residual R2 — helper function owner / ACL drift

H2 reproduced an existing helper function with an unexpected EXECUTE grant to another role. `CREATE OR REPLACE` preserved that ACL and hardening did not reject it.

Correction requirements for all content-settings helper/version functions introduced or replaced by the hardening migration:
- validate exact expected signatures;
- fail closed on unexpected overloads;
- validate owner identity/policy before replacement;
- fail closed on unexpected pre-existing grantees / EXECUTE ACLs;
- after creation/replacement, assert exact effective EXECUTE privileges;
- PUBLIC / anon / service_role / unrelated roles must not inherit unexpected EXECUTE;
- authenticated may EXECUTE only the validator helper(s) that genuinely must run under CHECK evaluation;
- version trigger function must not be directly executable by app roles if not required;
- do not globally modify default privileges or unrelated role memberships;
- do not silently rewrite an unexpected owner/ACL drift unless the exact known transition is explicitly justified and tested.

Use effective privilege checks, not only `proacl` text.

Add regressions for:
- unknown helper EXECUTE grant;
- unexpected helper owner;
- unexpected overload/signature;
- post-hardening exact ACL.

## Residual R3 — finite CAS domain / infinity

H2 reproduced a valid historical row with:
`updated_at = 'infinity'`

The current trigger:
`greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`
cannot advance infinity, so the same old CAS token remains reusable.

Correction requirements:
- before hardening changes, explicitly refuse existing rows with non-finite `updated_at`;
- also assess `created_at` finite-domain expectations and document/enforce consistently if needed for invariant safety;
- do not silently rewrite historical infinity values;
- enforce finite timestamps for future rows/updates with a DB constraint or equivalent fail-closed invariant;
- server-owned INSERT/UPDATE version semantics remain unchanged for valid finite rows;
- preserve PR #78 string-token interface.

Add tests:
- existing updated_at=infinity -> hardening fails before mutation;
- negative infinity likewise;
- future finite timestamp (e.g. year 2999) remains valid if intended;
- post-hardening attempt to write non-finite version is rejected/overridden safely;
- same-transaction, concurrent one-winner, long-running earlier transaction, stale-token zero-row behavior remain GREEN.

## Whole-chain production apply plan

H2 proved actual Supabase CLI 2.116.0 gives **per-file atomicity**, not whole-chain atomicity.

The current chain is:
1. `20260922045046_social_mobile_content_settings_candidate.sql`
2. `20261003120000_social_mobile_content_settings_hardening.sql`

A normal migration-up can commit (1), then fail before/inside (2), temporarily leaving the known weak candidate live.

This task must produce a concrete rollout plan that avoids exposing the weak candidate.

Preferred options to evaluate:
- a reviewed operator-controlled outer transaction that applies both source files atomically and records migration history correctly/safely, OR
- a new deployment-safe source strategy that avoids ever exposing the weak intermediate state, without rewriting already-applied production history (none exists yet) and without breaking repo migration semantics.

Do not implement a production history repair or remote apply here.

Because production currently has neither migration version applied and the target table is absent, you may propose a source consolidation strategy **only if** it is clearly safer, preserves auditability, and H2 can independently review it. Do not silently rewrite the historical candidate without explaining why.

The completion report must state the exact intended production apply commands/transaction boundaries conceptually, but do not execute them.

## Preserve closed behavior

Do not regress:
- exact settings/persona JSON/type/key validation;
- endLocal 24:00 only;
- authenticated table privileges exactly SELECT/INSERT/UPDATE;
- DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN denied;
- owner-only RLS;
- no service-role DML requirement;
- server-owned finite monotonic updated_at;
- CAS stale zero-row semantics;
- brand FK cascade;
- no durable publish/token/OAuth controls in settings/persona;
- PR #78 source compatibility.

## Tests

Run independently after correction:

### SQL / migration
- original candidate -> corrected hardening
- reapply exact hardened shape
- all prior 20 drift cases
- deferrable PK drift
- wrong PK/index arbiter
- unknown helper EXECUTE grant
- unexpected helper owner
- unexpected overload
- infinity / -infinity existing versions
- exact effective function ACL
- table ACL/RLS
- valid historical rows unchanged
- invalid rows refuse
- same-tx CAS
- concurrent CAS one winner
- long-tx no regression
- actual repository upsert under authenticated owner
- cascade lifecycle
- no unrelated mutation.

### App/source
- focused content-settings repository tests
- full social-mobile tests
- PR #78 composition/merge-tree if useful
- typecheck
- lint
- relevant Deno shared tests
- bash syntax
- `git diff --check`
- secret/scope scan.

Use disposable local PostgreSQL/Supabase only.

## PR handling

Prefer amending PR #81 normally.

- preserve old reviewed head `5595fb131813542c55c43bc783af623cdb9ea442` in Report;
- normal push only; no force push;
- fresh-main integration only if needed;
- do not merge.

## Production safety

Forbidden:
- production migration apply / db push
- migration history repair
- production INSERT/UPDATE/DELETE
- RLS/grant/function change
- Edge deploy
- Auth/Vault/X/OpenAI/Cron mutation
- PR #78 merge/deploy.

Read-only catalog checks are optional only if required to confirm no new collision; do not read user content/PII.

## Completion / K3

Report:
- task_id/result
- R1 deferrable-PK fix and proof
- R2 helper owner/ACL fix and proof
- R3 finite-version fix and proof
- exact migration/source strategy chosen
- whole-chain production apply plan
- whether historical candidate changed and why
- changed_files
- SQL tests
- app/Deno tests
- old/new PR head
- fresh-main overlap
- production reads/mutations
- remaining risks
- safety checks
- next recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

After K3, H2 independent rereview is mandatory.

Recommended H2 model: **Sol（高）**.

## Report — x-social-mobile-pr81-hardening-residual-corrective-20261005

- task_id: x-social-mobile-pr81-hardening-residual-corrective-20261005
- result: **PASS (source + disposable local proof; nothing applied)**. Model: Opus 5.5.
- PR #81: old reviewed head `5595fb131813542c55c43bc783af623cdb9ea442` (confirmed unchanged before editing, preserved in history) -> new head `bcc01312c638f5922db4ffd6255ddddf6f611183`, normal push (no force), PR body appended truthfully. Not merged.
- PR #78 head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` untouched; `git merge-tree` of #78 onto new #81 head: clean (tree `7fb711e2`).
- fresh-main overlap: main changed 59 files since the PR merge-base; overlap with the 8 PR #81 files = **0**. Version `20261003120000` not present on main. G4 PR #76 / AI-Lab PR #82 files untouched.

### R1 — deferrable PK (fixed)
Guard now requires exactly one PK whose constraint is `not condeferrable`, `not condeferred`, `convalidated`, with key exactly (brand_id), backed by an index that is `indisprimary`, `indisunique`, `indimmediate`, valid/ready/live, 1 key column = brand_id, no predicate/expressions, btree, default opclass for the column type, collation = column collation. Unknown PK definitions are refused, never repaired. Proof: drift refusals `pk_deferrable` (the H2 reproduction), `pk_initially_deferred`, `pk_composite`, `pk_missing`; the actual Settings writer pattern `INSERT … ON CONFLICT (brand_id) DO UPDATE` as authenticated owner through RLS succeeds after hardening (behavior section A). Constraint- and index-side immediacy are two independent checks; removing both makes `pk_deferrable` accepted -> suite FAIL.

### R2 — helper owner/ACL (fixed)
Guard: every `public.social_mobile_content_settings_%` routine must be one of the six known signatures (legacy touch, text_ok, text_list_ok, valid_settings, valid_persona, version) by oid — no overloads, other names or procedures; `prokind='f'`; owner = table owner (CREATE OR REPLACE would otherwise keep a foreign owner); grantees only owner/PUBLIC/anon/authenticated/service_role. Post-conditions: exactly five functions by signature, all owned by the table owner; exact non-owner EXECUTE list = authenticated on the four validators only; effective `has_function_privilege` false for anon/service_role on all, false for authenticated on `version()`. No default-privilege or role-membership change. Proof: drift refusals `helper_unknown_grant` (H2 reproduction, real parameter names so CREATE OR REPLACE would otherwise succeed), `touch_unknown_grant`, `helper_overload`, `helper_unknown_name`, `helper_procedure`, `helper_owner` (owned by another role), plus `after_hardening_function_grant`; behavior asserts effective EXECUTE for anon/authenticated/service_role/an unrelated role on all five, PUBLIC none, legacy function removed, and that revoking EXECUTE on a validator or either nested helper makes the owner's write fail (42501) — the four grants are genuinely required. Removing guard + post-condition makes `helper_unknown_grant` accepted -> suite FAIL.

### R3 — finite versions (fixed)
Guard (before any change) refuses rows with non-finite `updated_at` or `created_at` (`…_EXISTING_ROWS_NONFINITE`), never rewriting them. New CHECK `social_mobile_content_settings_finite_versions` `((isfinite(created_at) and isfinite(updated_at)) is true)`. Trigger semantics unchanged (server-owned, `greatest(clock_timestamp(), old + 1us)`); string-token interface unchanged. Proof: `updated_infinity`, `updated_minus_infinity`, `created_infinity` refused with the row byte-identical and nothing created; a valid historical row with a 2999 version survives hardening byte-identical and advances by exactly 1us on the next update; caller-supplied ±infinity overridden on update; with the trigger disabled, infinite values are refused by the CHECK while a finite 2999 value is accepted; same-tx / concurrent one-winner / long-tx no-regression / stale-zero-row / competing insert all still PASS. Removing guard + CHECK -> suite FAIL.

### Migration / source strategy
Historical candidate **unchanged** (its reviewed shape is exactly what the guard accepts; rewriting would discard review history and production has nothing applied, so there is nothing to gain). The hardening migration was amended in place (it is itself unapplied anywhere). Whole-chain safety comes from the apply procedure, not from rewriting history.

### Whole-chain production apply plan (documented, NOT executed)
`supabase/tests/social_mobile_content_settings_rollout.md`: same-day read-only preflight (table/functions absent, both versions absent from history, history column list, applying role owns brands, default ACL grantees only anon/authenticated/service_role, dependency shape, other pending migrations e.g. G4 `20261003090000` coordinated first). Apply in ONE outer transaction from the reviewed commit:
`psql "<prod URL by operator>" --single-transaction -v ON_ERROR_STOP=1 -f …20260922045046_…candidate.sql -f …20261003120000_…hardening.sql -c "insert into supabase_migrations.schema_migrations (version, name) values ('20260922045046','social_mobile_content_settings_candidate'), ('20261003120000','social_mobile_content_settings_hardening')"`
— schema and history commit together or not at all; never `db push`/`migration up` for these versions. Then a separate read-only read-back (history, RLS/policies, effective table and function privileges, constraints, single trigger). Failure handling = a separately approved removal transaction. Rehearsed locally: `SMCS_ATOMIC_CHAIN_REHEARSAL_PASS` (atomic success with both history rows; a forced failure after the hardening leaves no table and no history; per-file application of the same failure leaves the weak candidate — the contrast that motivates the plan).

### changed_files (this corrective commit)
- supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql (R1/R2/R3 + header)
- supabase/tests/social_mobile_content_settings_behavior.sql (function ACL, nested EXECUTE, finite checks)
- supabase/tests/social_mobile_content_settings_run.sh (rollout rehearsal, 14 new drift/non-finite/historical cases)
- supabase/tests/social_mobile_content_settings_rollout.md (new)
- supabase/functions/_shared/brand/social_mobile_content_settings_hardening_static_test.ts (R1/R2/R3/rollout invariants)

### SQL tests (disposable local PostgreSQL 17.11, socket-only, non-superuser owner, fake data)
`SOCIAL_MOBILE_CONTENT_SETTINGS_ALL_PASS` with 48 PASS markers (run twice): apply + re-run, single-transaction apply, atomic-chain rehearsal, behavior (contract 61+24 invalid cases, legitimate payloads incl. real upsert, table ACL/RLS, exact function ACL, CAS, finite, lifecycle/cascade, unrelated untouched), concurrent CAS one winner, long-tx no regression, competing insert, invalid rows refused, **37 drift refusals** (prior 20 + after-hardening + 4 PK + 6 function + function-grant after hardening … incl. all prior cases), 3 non-finite refusals, valid historical row unchanged, 3 enumerated repairs, cleanup. Mutation checks: combined removal of each new defence (R1 both immediacy checks; R2 guard + post-condition; R3 guard + CHECK) -> suite FAIL; single-layer removals are caught by the other layer (defence in depth). All disposable DBs dropped; cluster stopped and deleted.

### App / Deno tests
social-mobile 116/116; typecheck 0; lint 0; `deno test --no-check` `_shared/brand` + dry-run 162/162 (incl. 9 static invariants); `deno lint` clean; `bash -n` clean; `git diff --check` clean. App code unchanged in this commit; validators not loosened.

### Production reads / mutations
Production reads: 0. Production apply / db push / history repair / writes / RLS / grants / functions / deploy: 0. Auth/Vault/X/OpenAI/Cron: 0.

### Remaining risks
1. The rollout's history insert assumes `schema_migrations(version, name)` suffices for the CLI in use — confirm the column list in the preflight; the plan is a reviewed manual step and needs explicit approval.
2. Cross-PR version collision noted by H2 (PR #76 and #82 both `20261003090000`) is outside PR #81 but affects any later `db push`; settle before combining histories.
3. Local PostgreSQL proof only (no managed Supabase/PostgREST E2E).
4. Validators remain callable via PostgREST RPC by authenticated (pure booleans).
5. Structural validation only (no semantic secret detection in free text).

### Safety checks
Own G3 worktree/branch only; normal push; explicit-path staging; other workstreams' files untouched; untracked supabase/.temp and supabase/config.toml left alone; no secrets/PII in code, tests, PR or report.

### Next recommendation
H2 independent rereview of PR #81 at `bcc01312` (Sol（高）), focusing on R1–R3 closure and the rollout plan. Then a separately approved production apply per the plan with preflight and read-back. Only after that, rebase PR #78 and resume its review.

---

# Claude Task 3 — CURRENT TASK

- task_id: x-social-mobile-content-settings-schema-hardening-20261003
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: codex
- priority: highest
- recommended_model: Opus5.5（高）
- type: corrective implementation / DB migration / RLS / JSON contract / optimistic concurrency
- continues_from: x-social-mobile-ai-consult-v1-20261002
- blocks_pr: 78
- production_mutation_allowed: false

## C2 verdict / purpose

H2 independently reviewed the existing source-only migration candidate:

`supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`

and returned **FAIL / CHANGES REQUIRED**.

PR #78 AI相談 v1 remains open/unmerged. The AI consultation source is not rejected on its merits; its durable settings/persona persistence prerequisite is not safe enough yet.

This TASK hardens that schema prerequisite **in source + local disposable tests only**.

Do NOT apply any migration to production.

## Accepted H2 findings to correct

### F1 / P1 — JSON boundary too weak

The existing CHECKs allow durable malformed or forbidden data because SQL CHECK may evaluate NULL and pass, and `->>` coerces types.

H2 reproduced acceptance of examples including:
- required fields present but null
- wrong scalar types that coerce through `->>`
- malformed/missing generationWindow members
- arrays with non-string/null/object members or overlong strings
- structurally forbidden settings keys such as token/secret/oauth/publish controls
- nested forbidden controls
- persona fields with forbidden token/publish/history-like content or wrong types.

The DB boundary must validate exact structured shape/types compatible with legitimate current app/server writers.

### F2 / P1 — effective ACL too broad

Production default ACL means the unchanged candidate can leave authenticated with non-DML privileges such as:
- TRUNCATE
- TRIGGER
- REFERENCES
- MAINTAIN

H2 locally proved an authenticated role could TRUNCATE the settings table despite DELETE being denied.

The corrected migration must normalize effective table privileges to true least privilege.

### F3 / P2 — updated_at is not a robust version

Current trigger uses `now()`, which is transaction-start time.

H2 proved:
- two updates within one transaction can retain the same timestamp
- an earlier long-running transaction can write a timestamp older than a later transaction's version.

PR #78 relies on `updated_at` as a compare-and-swap version, so the server-owned update value must be strictly monotonic for that row.

### F4 / P2 — drift silently accepted

`CREATE TABLE IF NOT EXISTS` lets a same-name but drifted table survive migration.
H2 removed CHECK/FK constraints in a disposable DB, reran the original candidate, and migration succeeded while those constraints remained absent.

The migration path must fail closed on unknown/unsafe drift rather than silently claim success.

## Mandatory startup / isolation

1. Read PROJECT_RULES, CLAUDE.md, ORCHESTRATION, CURRENT_STATE, this TASK.
2. Read the full H2 report for `x-social-mobile-content-settings-schema-prereq-review-20261002`.
3. Use independent G3 worktree/checkout.
4. Fresh origin/main and PR #78 branch/head.
5. Preserve original PR #78 head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` as review history.
6. G4 is independently changing publish-toggle authorization/migration/RPC. Do not touch its migration/RPC/function/files. Use a unique migration version and confirm no filename/order collision before push.
7. H1 is reviewing Kabumori PR #79. Do not touch H1/G2 files.
8. Read Supabase skill before DB work.
9. No production apply/write/deploy.

## Migration strategy

Default: **preserve the historical source-candidate migration and add a new versioned hardening migration**.

Do not silently rewrite `20260922045046_social_mobile_content_settings_candidate.sql`.

If you believe consolidation/editing the historical never-applied migration is materially safer, STOP and report exact migration-history evidence and rollout rationale before changing that strategy. Do not make that choice implicitly.

The new hardening migration must work safely when:
- the original candidate has just created the exact expected table, and
- the exact candidate already exists in a disposable/local environment.

Unknown drift must fail explicitly.

Production currently has no target table and no applied version `20260922045046`; that fact does not authorize apply here.

## Required corrected contract

### 1. Exact durable settings shape

Use current source types/normalizers as the canonical value contract.

At DB level, reject missing/null/wrong-type/unknown structured fields as appropriate.

Validate at minimum:
- root `settings` is object
- exact/approved root keys only
- `locale` string and currently supported values
- `preferredTone` string, bounded
- `themes` array of bounded strings, bounded count and per-item length
- `objective` string, bounded
- `frequencyTargetPerWeek` JSON number/integer semantics matching current writers; do not accept string coercion unless current canonical writer intentionally stores strings (prove if so)
- `approvalMode` exact allowed values
- `generationWindow` object with approved keys only
- timezone string constrained to current legitimate contract; do not invent support that app/server cannot consume
- `startLocal` time, **24:00 forbidden**
- `endLocal` time, **24:00 allowed**
- `defaultGenerationLocal` time, **24:00 forbidden**
- `generationDayOffset` actual canonical type and allowed values
- `optionalNgWords` array of bounded strings, count and per-item length
- `notes` string, bounded.

The DB is a structural safety boundary. Do not claim it can detect whether arbitrary allowed human text semantically contains a "secret"; that is not realistic.

### 2. Exact persona shape

Derive exact allowed durable keys/types from the current `PersonaProfile` model and server materializer.

Requirements:
- root object only
- exact approved keys only
- bounded strings/arrays/numbers as applicable
- no raw posts/history bodies
- no token/OAuth/publish/account/scheduler/Auth controls
- provenance/confirmed/analyzed metadata remain in dedicated columns where the current schema expects them, not silently duplicated into arbitrary JSON
- existing legitimate conversation and future bounded past-post-analysis profiles remain representable.

Do not weaken client/server validators to make malformed DB rows pass.

### 3. Null-safe CHECK semantics

Every invariant must evaluate to TRUE for a valid row, not merely "not false".

Use explicit `IS TRUE`, `jsonb_typeof`, key-existence/keyset tests, helper functions if justified, or equivalent fail-closed SQL.

Avoid unsafe cast order where malformed JSON can produce migration/runtime errors rather than a clean CHECK failure.

If helper validation functions are introduced:
- fixed search_path
- least privilege
- deterministic/immutable semantics where valid
- no dynamic SQL
- no user-controlled object names
- explicit EXECUTE grants/revokes.

### 4. Least-privilege ACL

Normalize effective ACL for this table/function(s).

At minimum:
- PUBLIC: no table privileges
- anon: no table privileges
- authenticated: only the exact operations needed by current mobile settings flow (expected SELECT/INSERT/UPDATE)
- DELETE denied
- TRUNCATE denied
- REFERENCES denied unless concretely needed
- TRIGGER denied
- MAINTAIN denied
- service_role: grant only what a current proven server path actually needs; do not inherit broad defaults by accident.

Do not globally alter database default privileges or unrelated tables.

RLS remains enabled and owner-scoped to exact `brand_id + auth.uid()`.

Test effective privileges, not only the GRANT statements in the file.

### 5. Monotonic CAS version

Keep compatibility with PR #78's `updated_at timestamptz` CAS unless a change is demonstrably necessary.

Preferred bounded approach to evaluate:
`greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`
on every UPDATE, ignoring caller-supplied version.

Requirements:
- strictly greater than OLD.updated_at
- cannot regress due to transaction-start time
- same transaction repeated updates advance
- normal concurrent CAS yields one winner
- stale old timestamp yields zero updates
- caller cannot set arbitrary future/past version
- insert gets a server-owned initial version.

If PostgreSQL timestamptz precision/serialization creates any remaining ABA/collision issue, document and fix before declaring PASS. A revision integer is allowed only if coordinated app/schema change is justified; avoid unnecessary scope expansion.

### 6. Drift guard / migration safety

The hardening migration must distinguish:
- expected exact candidate shape -> harden successfully
- already-hardened exact shape -> safe/idempotent behavior where migration tooling may re-run in disposable tests
- unexpected same-name relation/column/FK/CHECK/function/trigger/policy drift -> explicit failure.

Do not silently repair arbitrary unknown drift unless every repaired property is deliberately enumerated and safe.

Validate:
- expected columns/types/nullability/defaults
- PK/FK target + ON DELETE action
- expected relation kind/schema
- policy/function/trigger identity where relevant.

Avoid trusting constraint names alone; verify definitions/columns/actions for security-critical properties.

### 7. FK / lifecycle compatibility

Confirm:
- `brand_id` text compatible with current `brands(id)`
- FK ON DELETE CASCADE is still intended
- settings row disappears with brand deletion
- current common-account source work does not require a different owner key
- no dependency on unapplied common-account production schema for this table to function
- no interference with G4's new publish-toggle migration/RPC.

## Local disposable proof

Use G3-owned disposable PostgreSQL/Supabase environment only.

Must execute:

### Valid behavior
- original candidate -> hardening migration succeeds
- legitimate default row succeeds
- current Settings screen payloads succeed
- current PR #78 save/persona payloads succeed
- endLocal 24:00 succeeds
- startLocal/defaultGenerationLocal 24:00 fail
- legitimate persona examples succeed.

### Invalid JSON/persona
Regression-test H2 adverse cases:
- missing/null required fields
- wrong scalar types
- numeric/bool text coercion
- malformed generationWindow
- unknown root/window/persona keys
- non-string array items
- overlong array items
- forbidden publish/token/oauth/account/scheduler-like structured keys
- invalid persona shapes.

### ACL/RLS
Under representative roles:
- owner SELECT/INSERT/UPDATE succeed
- owner DELETE fails
- owner TRUNCATE fails
- owner cannot CREATE TRIGGER on table
- owner cannot use REFERENCES privilege
- member/viewer/nonmember/cross-brand fail DML/read as intended
- anon fails
- effective privilege queries prove only intended privileges.

### CAS
- distinct transactions advance
- two updates in same transaction advance strictly
- long-running earlier transaction cannot regress version
- concurrent CAS exactly one winner
- stale CAS zero rows
- competing insert -> unique conflict
- caller-supplied timestamp cannot control version.

### Drift
Create representative bad same-name structures:
- missing FK
- wrong FK target/action
- missing/weak CHECK
- wrong column type/nullability
- wrong trigger/function/policy
and prove hardening refuses unknown drift or explicitly repairs only the enumerated safe case.

### Lifecycle
- brand delete cascades settings row
- no unrelated rows/tables touched.

Drop disposable DB/cluster after proof.

## Source consumers / tests

Compare and run:
- current content-settings domain validators
- content-settings repository
- shared server normalizer/materializer
- PR #78 tests where source can be tested without production table
- full social-mobile tests
- relevant Deno/shared tests
- migration-specific SQL test harness
- typecheck/lint
- `git diff --check`
- secret/scope scan.

Do not loosen application validators simply because the DB is hardened.

## PR #78 handling

You may amend PR #78 with the new hardening migration/tests if that is the cleanest ownership path, because G3 owns the blocked feature.

If you do:
- keep exact original head in Report
- rebase/fresh-main safely
- ensure no overlap with G4 migration/RPC work
- update PR body truthfully
- do not merge.

Alternatively create a dedicated prerequisite PR and report dependency ordering. Choose based on smallest conflict and clearest rollout; document why.

## Production safety

Forbidden:
- production migration apply
- production settings INSERT/UPDATE/DELETE
- production RLS/grant/function change
- Edge deploy
- Auth/Vault/X/OpenAI/Cron mutation
- PR #78 merge.

Read-only production catalog inspection is allowed only if needed to confirm no new collision since H2.

## Completion / K3

Report:
- task_id/result
- migration strategy chosen
- original H2 F1-F4 disposition
- exact table/settings/persona contract
- ACL/RLS result
- monotonic CAS design and proofs
- drift handling
- lifecycle/common-account compatibility
- changed_files
- local disposable SQL evidence
- app/server tests
- original PR #78 head and new PR/dependency head
- production reads/mutations
- remaining risks
- safety checks
- next recommendation.

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

After K3, allocate fresh H2 review before any production apply or PR #78 merge.

Recommended Codex rereview: **Sol（高）**.

## Report — x-social-mobile-content-settings-schema-hardening-20261003

- task_id: x-social-mobile-content-settings-schema-hardening-20261003
- result: **PASS (source + disposable local proof; nothing applied)**. Model: Opus 5.5.
- PR: https://github.com/anohi-memories/kabumori/pull/81 — branch `claude/g3-content-settings-hardening-20261003`, head `5595fb13` (rebased on origin/main `cde3a7d3`), pushed. Not merged.
- original PR #78 head: `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` — **unchanged** (not amended, not rebased). Dependency order: #81 (review -> separate apply approval -> apply) first, then #78 rebased on it. `git merge-tree` of #78 onto #81: clean, no conflict (only shared file: content-settings-repository.ts).

### Migration strategy
- Kept `20260922045046_social_mobile_content_settings_candidate.sql` byte-unchanged as history; added `20261003120000_social_mobile_content_settings_hardening.sql` after it.
- Unique version; G4 PR #76 uses `20261003090000_social_mobile_publish_permission_boundary.sql` and does not reference this table/its functions (grep of its migration on the fetched branch: 0 hits). No H1/G2/G4 file touched.
- Chosen over amending #78: the table is a prerequisite of main's existing Settings screen too, so it can be reviewed/applied on its own and #78 stays a pure feature PR.
- Must run inside one transaction (migration tool / `psql -1`); the file itself has no BEGIN/COMMIT. All checks run before the first change; post-conditions after the last.

### H2 F1–F4 disposition
- F1 FIXED: `social_mobile_content_settings_valid_settings(jsonb)` / `_valid_persona(jsonb)` (+ `_text_ok`, `_text_list_ok`): plpgsql IMMUTABLE PARALLEL SAFE, `search_path=pg_catalog`, no dynamic SQL, type checked before any cast, never NULL. CHECKs are `(... ) is true`. Candidate shape CHECKs replaced.
- F2 FIXED: `revoke all ... from public, anon, authenticated, service_role` + `grant select, insert, update ... to authenticated`; validators EXECUTE to authenticated only (proven necessary: CHECK runs with the writer's privileges); version function EXECUTE to nobody. No default-privilege change. Post-condition asserts the exact effective ACL and zero column ACLs.
- F3 FIXED: single trigger `social_mobile_content_settings_version` BEFORE INSERT OR UPDATE; INSERT sets created_at=updated_at=clock_timestamp(); UPDATE keeps created_at and sets `greatest(clock_timestamp(), old.updated_at + 1us)`. Old `touch_updated_at` trigger+function dropped. timestamptz stays (PR #78 CAS contract unchanged).
- F4 FIXED: catalog drift guard (see below) + refusal when existing rows break the contract (`..._EXISTING_ROWS_INVALID`, nothing rewritten).

### Exact table / settings / persona contract
- Columns (exact set): brand_id text NOT NULL PK + FK -> public.brands(id) ON DELETE CASCADE; settings jsonb NOT NULL; persona_profile jsonb NOT NULL default {}; persona_provenance text NOT NULL in (conversation, past_post_analysis, manual); persona_confirmed boolean NOT NULL default false; persona_last_analyzed_at timestamptz NULL; persona_last_analyzed_count integer NULL 0..1000; created_at/updated_at timestamptz NOT NULL (server-owned).
- settings: exactly {locale, preferredTone, themes, objective, frequencyTargetPerWeek, approvalMode, generationWindow, optionalNgWords, notes}; locale = "ja-JP"; preferredTone string 1..120 non-blank; themes array <=8 of non-blank strings <=100; objective 1..160 non-blank; frequencyTargetPerWeek JSON number, integer 0..14; approvalMode "manual_review"|"auto_post_preference"; generationWindow exactly {timezone="Asia/Tokyo", startLocal HH:MM (no 24:00), endLocal HH:MM or 24:00, defaultGenerationLocal HH:MM (no 24:00), generationDayOffset JSON number -1|0}; optionalNgWords array <=20 of non-blank strings <=60; notes string <=1000. Blank = only ASCII/full-width whitespace.
- persona_profile: object with only {toneSignals <=20x80, recurringVocabulary <=30x50, topicSignals <=20x80, openingClosingPatterns <=20x100 (non-blank string items), punctuationEmoji/hashtagHabits/ctaStyle strings <=200, sentenceLength short|mixed|long}. source/confirmed/analyzedAt/analyzedPostCount are column data and refused as JSON keys.
- Not claimed: semantic secret detection inside allowed free text.

### ACL / RLS result
Effective privileges (has_table_privilege, all 8 privileges incl. MAINTAIN) for anon/authenticated/service_role: only authenticated SELECT/INSERT/UPDATE; PUBLIC none; no column ACL. RLS enabled; the three owner policies recreated unchanged in meaning (`brand_id` + `(select auth.uid())` + role owner); no DELETE policy. Proven: owner SELECT/INSERT/UPDATE ok; owner DELETE/TRUNCATE/CREATE TRIGGER/REFERENCES/ALTER denied (42501); admin/member/viewer/non-member see 0, update 0, insert denied; owner A cannot update/insert/move rows to brand B/C; anon and service_role denied.

### Monotonic CAS design and proofs
Distinct transactions advance; two updates in one transaction advance strictly and the first version then matches 0; stale CAS 0 rows; current CAS 1 row; caller-supplied updated_at/created_at (future or past) ignored; update cannot move the version back; from a far-future stored version it still advances by exactly 1us per update; `to_json(updated_at)` token round-trips exactly. Two-connection: concurrent CAS on one version -> changed=1 / changed=0 and the first writer's value stored; an earlier long-running transaction updating after a later commit still ends strictly above it; two first inserts -> one row + duplicate key. Residual: only a delete+recreate of the same brand id combined with a backwards wall clock could reproduce an old token (users cannot DELETE; rows disappear only with their brand).

### Drift handling
Accepted states: exact candidate, or the hardened shape (safe re-run proven). Verified by definition: relation kind/schema, no inheritance/partition, exact column name/type/nullability/identity/generated set, single PK on brand_id, single FK brand_id -> brands.id ON DELETE CASCADE / ON UPDATE NO ACTION / validated / not deferrable, only known-named CHECKs, only the PK index, only the candidate/hardened trigger bound to its own function, only the three owner policies, grantees only owner/PUBLIC/anon/authenticated/service_role (table and column). Refused in proof (20): FK missing / retargeted / RESTRICT / NOT VALID / extra; column type / nullable / extra / missing; unknown CHECK; extra UNIQUE; extra index; unknown trigger; rebound trigger; extra policy; unknown table grantee; unknown column grantee; table missing; same-name view; drift introduced after hardening. Each refusal leaves no partial change. Enumerated repair only: weakened or missing known-named candidate CHECK, and over-broad grants to anon/authenticated/service_role -> replaced/normalised (proven).

### Lifecycle / common-account compatibility
brand_id text matches brands.id text; ON DELETE CASCADE kept and proven (also when the deleting role has no privilege on this table — the RI action runs as the table owner); other brand's row and an unrelated table untouched. No dependency on the unapplied common-account (PR #70) schema; owner key stays the existing brand membership model. No interaction with G4's publish-toggle migration/RPC.

### changed_files (PR #81)
- supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql (new)
- supabase/tests/social_mobile_content_settings_{fixture.sql,behavior.sql,run.sh} (new)
- supabase/functions/_shared/brand/social_mobile_content_settings_hardening_static_test.ts (new)
- apps/social-mobile/src/data/content-settings-repository.ts (saveConfirmedProposal no longer copies analyzedAt/analyzedPostCount into persona_profile)
- apps/social-mobile/tests/content-settings-repository.test.mjs (new)

### Local disposable SQL evidence
Homebrew PostgreSQL 17.11, own cluster, Unix socket under /private/tmp only, lc_messages=C, non-superuser owner, fixture default ACL = ALL to anon/authenticated/service_role (broader than production's TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). Runner output: APPLY_AND_RERUN, SINGLE_TRANSACTION_APPLY, BEHAVIOR (61 invalid settings + 24 invalid persona cases rejected with 23514; legitimate default/Settings/bounds/24:00/PR78 persona/full analysis persona accepted; ACL/RLS; CAS; lifecycle), CONCURRENT_CAS_ONE_WINNER, LONG_TRANSACTION_NO_REGRESSION, COMPETING_INSERT_UNIQUE, EXISTING_INVALID_ROWS_REFUSED, DRIFT_REFUSED x20, ENUMERATED_REPAIR x3, CLEANUP -> `SOCIAL_MOBILE_CONTENT_SETTINGS_ALL_PASS`. Mutation checks (8): version via now(), no key-count check, FK action unchecked, frequency type unchecked, blank text allowed, startLocal unchecked, extra policy tolerated, ACL normalisation + post-condition removed -> each made the suite fail. All disposable databases dropped; cluster stopped and deleted.

### App / server tests
social-mobile `npm test` 116/116 (incl. 3 new repository tests); typecheck 0; lint 0; `deno test --no-check` `_shared/brand` + `social-mobile-brand-dry-run` 158/158 (incl. 5 new static invariants; candidate static tests still pass); `deno lint` clean; `bash -n` clean; `git diff --check` clean. App validators were not loosened. Note: main's app validator still rejects its own 24:00 default — fixed in PR #78 (not merged here, per H2).

### Production reads / mutations
Production reads: 0 (no catalog inspection needed; relied on H2's 2026-10-03 read-only facts). Production mutations / apply / deploy / RLS / grants / migration history: 0. OpenAI / X / Auth / Vault / Cron: 0.

### Remaining risks
1. If production's default ACL also grants this new table to a role other than anon/authenticated/service_role, the guard stops the migration (fail closed). Do a read-only `aclexplode(acldefault)` / default-ACL check in the apply preflight.
2. Validators are public functions callable via PostgREST RPC by authenticated (pure boolean, no side effects). Moving them to a non-exposed schema would be a separate decision.
3. Structural validation only; free text is not secret-scanned.
4. Theoretical old-token reuse only after brand delete+recreate with a backwards clock (see CAS).
5. Requires transactional application; not tested through managed Supabase/PostgREST (local PostgreSQL only).
6. #78 must still be rebased after #81 and re-reviewed for its own A–H gates.

### Safety checks
Own G3 worktree/branch; explicit-path staging; no other slot's files; untracked supabase/.temp and supabase/config.toml left alone; no secrets/tokens/personal data in code, tests, PR or report.

### Next recommendation
H2 rereview of PR #81 (Sol（高）): contract completeness vs writers, ACL/default-ACL assumptions, CAS trigger, drift guard coverage. Then a separate, explicitly approved production apply with read-only preflight and read-back. Only after that, rebase PR #78 and resume its review.

---

# Claude Task 3 — CURRENT TASK

- task_id: x-social-mobile-ai-consult-v1-20261002
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: codex
- priority: high
- recommended_model: Opus5.5（高）
- type: feature implementation / AI conversation / Edge Function / authenticated settings proposal
- production_mutation_allowed: false

## Product goal

X自動投稿アプリの「AIと相談する」を、現在のローカル疑似判定から**本当にAIと自然に会話できる機能**へ進める。

この機能は投稿生成そのものではなく、その前段としてAIがユーザーを理解する場所。

ユーザーは普通の会話で、
- どんな投稿をしたいか相談する
- AIから不足情報を質問してもらう
- 発信テーマ、文体、読者、目的、NG表現などを整理する
- 現在AIが理解している投稿方針を聞く
- 簡単な雑談や一般的な質問をする
ことができる。

会話から設定変更候補が生まれても、**AIは勝手に保存しない**。
必ずユーザーが内容を確認して「これで覚えて」等の明示操作をした後だけ、既存の投稿設定 / PersonaProfileへ保存する。

過去X投稿の実取得・分析はこのTASKでは行わない。現在の同意導線・意図検出を壊さず、K3後に別G4 TASKとして接続できる境界だけ維持する。

## Existing foundation — preserve and reuse

Fresh mainで以下が既に存在する。

- `apps/social-mobile/src/app/(tabs)/consult.tsx`
  - 会話画面
  - 保存前提案カード
  - 明示確認
  - existing settings/persona read/save
- `apps/social-mobile/src/domain/content-settings.ts`
  - `SocialMobileContentSettings`
  - `PersonaProfile`
- `apps/social-mobile/src/domain/content-settings-conversation.ts`
  - bounded structured proposal
  - untrusted AI-output validator
  - publish/account/OAuth/token/scheduler controlsの拒否
  - past-post learning intent scaffold
- `apps/social-mobile/src/data/content-settings-repository.ts`
  - existing `social_mobile_content_settings` storage
  - settings + confirmed persona save
  - settings-only saveがpersonaを消さない設計

Current `createConversationalAssistantProposal()` is deterministic/local scaffolding. This TASK replaces the runtime conversation path with an authenticated server-side AI boundary while keeping deterministic helpers/validators useful for tests/fallback where appropriate.

## Mandatory startup / isolation

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G3 worktree/checkout. Do not use G1/G2/G4/G5/H1/H2 worktrees, untracked files, simulator, Metro or branch.
3. Fresh `origin/main`.
4. Confirm G4 is done and PR #65 merged.
5. Confirm G5/H1 common-account PR #70 work does not overlap intended runtime files.
6. **Do not create or edit a DB migration in this TASK.** Existing `social_mobile_content_settings` schema/persona columns are the storage boundary. If production/source schema is actually insufficient, STOP and report the exact missing column/constraint instead of creating a migration while the common-account migration review is active.
7. Inspect existing AI/LLM Edge Functions/shared helpers/model config and reuse the established provider/client/usage/error patterns. Do not introduce a new AI vendor or duplicate secret scheme.

## Functional requirements

### 1. Real conversational AI

Implement an authenticated server-side AI conversation endpoint for social-mobile consultation.

Preferred boundary:
- a dedicated narrowly scoped Edge Function such as `social-mobile-consult`, unless repository conventions clearly point to an existing suitable endpoint.
- client never receives AI provider secret.
- no direct provider call from Expo client.

Request should be bounded and include only what the assistant needs:
- current brand/workspace id
- current confirmed `SocialMobileContentSettings`
- current confirmed `PersonaProfile` if present
- bounded recent conversation turns from this consultation session
- current user message

Do not send:
- OAuth tokens
- X access/refresh tokens
- Vault ids/plaintext
- provider credentials
- unrelated workspace data
- raw account deletion/auth internals.

Keep history bounded. Do not send an unlimited chat transcript.

### 2. Natural conversation modes

The AI must support at least these behaviors without requiring explicit mode buttons:

**A. General conversation / simple questions**
Examples:
- 「今日何投稿しようかな」
- 「Xってどれくらいの頻度がいい？」
- 「最近ネタがない」
- 「ちょっと疲れた」
- simple casual conversation / brainstorming / general questions

It should answer naturally.
A normal answer **must not automatically create a settings proposal**.

No web search/current-news browsing in v1. If the user asks for genuinely current/external facts that cannot be known from supplied context, the assistant should say that this consultation chat does not currently fetch live web information rather than inventing it.

**B. Preference discovery**
When the user wants help deciding posting style or has not supplied enough detail, AI should ask concise follow-up questions naturally.

Important:
- avoid a rigid questionnaire dump.
- ask preferably 1 useful question at a time, at most 2 when tightly related.
- do not force questions when enough information exists.
- use already confirmed settings/persona so it does not repeatedly ask what it already knows.

Useful dimensions include:
- main themes
- intended audience
- purpose
- tone/formality
- post length / sentence length
- emoji/punctuation tendencies
- CTA style
- hashtag tendency
- topics/expressions to avoid
- posting frequency preference
- personal/private disclosure boundaries where explicitly discussed

Do not invent personal facts.

**C. Explain current understanding**
If user asks things like:
- 「今どういう設定になってる？」
- 「俺の投稿方針どう理解してる？」
AI should explain the currently saved settings/persona clearly without proposing a mutation unless the user asks to change something.

**D. Settings/persona proposal**
Only when the conversation contains a reasonably clear preference/change should the AI return a structured proposal delta.

Examples:
- 「もっと親しみやすくして」
- 「AIの話を多めにしたい」
- 「絵文字は少なめ」
- 「週5回くらい」

Proposal must be a **delta**, not a replacement snapshot, so unrelated saved fields are preserved.

Ambiguous statements such as「AIの話多めでもいいかな」should be handled conversationally and may ask/offer confirmation rather than silently treating them as durable settings.

### 3. Structured AI contract

Keep/reuse `validateConversationalAssistantResult()` as the trust boundary and strengthen it if needed.

Model output must be parsed as untrusted structured data containing conceptually:
- assistant reply
- optional settings delta
- optional persona delta
- follow-up questions
- confidence / uncertainty
- history-learning intent
- requires confirmation = true for any persistent change
- publish permission changed = false

Add explicit distinction if helpful between:
- chat-only response
- clarification/question
- proposal

But do not allow the model to control:
- auto-post on/off
- publish permission
- posting execution
- scheduler
- OAuth/account selection
- Auth/session
- deletion
- secrets/tokens.

Malformed/unsafe structured output must fail closed:
- show a safe retryable assistant error or safe chat fallback
- do not save anything
- do not alter posting state.

### 4. Confirmation and persistence

Existing principle remains mandatory:

**conversation → proposal → user confirmation → save**

Never:
- mutate settings on AI response arrival
- mutate persona because AI “learned” something without confirmation
- enable posting
- create scheduled posts
- change X connection.

When user confirms:
- apply only the returned delta to the latest known/safely refreshed saved state
- preserve unrelated existing fields
- save settings/persona using the existing repository/storage boundary
- visibly report save success/failure.

If a proposal became stale because saved settings changed during the conversation, prefer re-read/merge or require reconfirmation rather than silently overwriting unrelated newer settings.

### 5. Conversation UX — functional only

UI design will be substantially redesigned later. Do NOT spend time on polish.

Functional minimum:
- user message input
- send action
- visible assistant/user turns
- loading state
- retryable error state
- proposal/“AIが理解した内容” block only when there is something persistent to confirm
- clear explicit confirmation button
- clear indication after successful save
- user can keep chatting after a proposal/save
- current settings can be explained through conversation.

Do not redesign global navigation, theme, cards, spacing, animation, avatar, etc.

### 6. Past-post learning handoff

Do **not** fetch X history in this TASK.

If user says:
- 「過去の投稿を読んで」
- 「自分の過去ポストから学んで」
the AI may recognize the intent and explain that past-post learning requires explicit confirmation / the upcoming learning flow.

Preserve a structured `historyLearningIntent` boundary so the next G4 task can attach:
- verified connected X account
- bounded post fetch
- style analysis
- user confirmation
without redesigning this chat contract.

No X API read/write in this TASK.

## Authentication / authorization boundary

Because this adds an Edge Function/API boundary:

1. Require valid user JWT/session.
2. Do not trust a client-supplied brand id by itself.
3. Verify the caller has current allowed membership/ownership for that brand using the repository's established social-mobile authorization pattern.
4. Do not use future/common-account service entitlement semantics from unmerged PR #70.
5. Fail closed for missing/ambiguous membership.
6. Never log Authorization headers, JWTs, user email, AI provider secrets, X tokens, or full sensitive conversation bodies.
7. Prefer metadata-only logs: request id, result class, bounded lengths/counts, error code, duration/model usage if existing conventions support it.

## Cost / abuse bounds

Reuse existing AI cost/usage helpers if present.

At minimum:
- cap user message length
- cap number of conversation turns sent
- cap total context length
- cap model output
- one model call per send under normal path
- no automatic recursive “agent” loops
- no web search
- no X API call
- bounded timeout
- deterministic error path.

Use the least expensive existing model/config that safely supports the repository's structured-output contract; do not introduce a premium model simply because Claude is implementing the feature.

## Data/privacy behavior

For v1:
- do not create a new table to persist raw chat transcripts.
- raw conversation may live in screen/session state only.
- durable memory is the **user-confirmed structured settings/persona**, not the entire transcript.
- do not store raw conversation text in analytics/logs.
- if existing observability captures request bodies, explicitly prevent consultation text from being logged there.

This keeps the “AI learns me” behavior transparent: it remembers only what the user confirms.

## Tests

Add focused tests for at least:

### Server/API
- unauthenticated request rejected
- caller without brand membership rejected
- valid member accepted
- bounded message/history input
- oversized/malformed input rejected
- AI secret never returned/logged
- safe model response parses
- malformed JSON/shape fails closed
- model attempt to include publish/OAuth/token/scheduler/account controls rejected
- chat-only response creates no proposal
- proposal response cannot persist by itself
- current-settings explanation path has no mutation
- past-post intent creates no X API call
- provider timeout/error is safe/retryable
- model call count bounded

### Domain/client
- multi-turn assistant history sent in bounded form
- normal chat displays reply without proposal card
- follow-up question displays naturally
- proposal displays only changed fields
- explicit confirmation persists
- unconfirmed proposal persists nothing
- correction in later turn supersedes/replaces prior pending proposal safely
- unrelated settings remain unchanged when applying a delta
- existing persona not erased by settings-only confirmation
- settings changed after proposal cannot be silently clobbered
- general chat never toggles posting/scheduling/X connection
- history-learning request stays consent-gated / no fetch.

Run:
- new focused tests
- full social-mobile tests
- relevant Edge Function/shared tests
- typecheck / lint / runtime check per repo conventions
- `git diff --check`
- secret scan
- scope diff check.

No live paid AI call is required in automated tests; mock/stub the model boundary.

## Local verification

Use G3-owned environment only.

Verify with local/mock AI responses or a safe dev invocation:
1. greeting / casual conversation returns a natural answer
2. 「どんな投稿にしたらいい？」 produces a useful follow-up question
3. 「親しみやすく、AIの話を多めにしたい」 produces a reviewable proposal
4. before confirmation, saved settings unchanged
5. after explicit confirmation, local/test storage shows only intended changes
6. 「今どういう設定？」 explains saved understanding
7. 「過去投稿を読んで」 does not call X and remains consent-gated
8. no posting/schedule/X connection side effect.

Do not use real X posting or destructive production flows.

## DB / migration rule

**No new migration in this task.**
Use the existing `social_mobile_content_settings` settings/persona storage.

If the required production schema columns are absent or incompatible:
- STOP
- report exact evidence
- do not create a migration
- do not borrow/modify PR #70 common-account migration.

## Explicit non-scope

- actual past-X-post retrieval/analysis
- AI-generated post creation
- editing/regeneration/approval of a generated post
- automatic posting
- scheduled posting
- X API read/write
- x-connect/OAuth behavior
- login provider changes
- account deletion
- common-account/service-entitlement implementation
- new DB migration/schema
- major UI redesign
- production deploy
- feature flag rollout.

## Production / safety

This is **source + tests + PR only**.

Forbidden:
- production Edge Function deploy
- production DB mutation
- migration apply
- real X API operation
- real X post
- Vault mutation
- Auth mutation
- provider configuration mutation.

## Completion / K3

Report:
- task_id
- result
- architecture / endpoint chosen
- existing foundations reused
- exact AI request/response trust boundary
- authorization checks
- chat modes implemented
- confirmation/persistence semantics
- changed_files
- tests
- local verification
- AI/provider/model usage policy
- DB migration = none
- production mutation = 0
- real X operations = 0
- remaining issues
- safety_checks
- commit_hash / push / PR
- next_recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

### Expected next stage

Because this task introduces an authenticated AI Edge Function/API boundary, K3 should normally allocate a focused Codex review before merge.

Likely review:
- H2 if free
- recommended Codex model: **Sol（高）**
- focus: Auth/membership boundary, prompt/structured-output injection, no implicit persistence, cost bounds, no publish/X side effects.

Only after source review/merge should G4 be assigned the real **past-post learning** integration.


## Report — x-social-mobile-ai-consult-v1-20261002

- task_id: x-social-mobile-ai-consult-v1-20261002
- result: **PASS (source + tests + PR; K3 / Codex review requested before merge)**. Model: Opus 5.5 (switched by the user before start).
- PR: https://github.com/anohi-memories/kabumori/pull/78 — branch `claude/g3-ai-consult-v1-20261002`, commit `6e9f78a3` (rebased on origin/main `0c2c04e0`), pushed.

### Architecture / endpoint chosen
- New dedicated Edge Function `supabase/functions/social-mobile-consult` (`index.ts` + pure `logic.ts`). Read-only: it has no write path, no service-role client, no token/Vault adapter, no X adapter.
- Client: `domain/consult-session.ts` (pure), `data/consult-client.ts` (functions.invoke), rewritten `app/(tabs)/consult.tsx`, versioned save in `data/content-settings-repository.ts`.
- One deliberate tightening vs. the TASK text: saved settings/persona are **read server-side with the caller's JWT** instead of being sent by the client, so the request is only `brand_id` + `message` + bounded `history`. The assistant gets the same inputs; the client cannot inject "saved" state.

### Existing foundations reused
- Auth/ownership pattern of `social-mobile-brand-dry-run` (`/auth/v1/user` + RLS-scoped REST reads with the user JWT + `social_mobile_user_v1` profile check).
- `_shared/brand/social_mobile_content_settings.ts` (`normalizeSocialMobileContentSettings`, `materializeSocialMobilePersonaProfile`).
- OpenAI Responses API pattern and default model tier of `brand_post_generator.ts` (`gpt-5.6-luna`, `store:false`, low reasoning) and the strict `json_schema` output pattern already used in `market-intelligence-ingest`. Same `OPENAI_API_KEY` secret; no new vendor or secret.
- `validateConversationalAssistantResult()` kept as the client trust boundary (strengthened), `applyConfirmedConversationProposal()`, existing `social_mobile_content_settings` storage, existing history-learning consent gate. `createConversationalAssistantProposal()` is kept only for the sample-data preview and tests.

### Exact AI request / response trust boundary
- Request to the model: system prompt + a data block of saved editable settings (+ read-only approval mode / generation time for explanation) and the **confirmed** persona only + bounded turns + the message. Never tokens, Vault ids, account/auth data, other workspaces.
- Model output = untrusted. `sanitizeConsultModelOutput()` (server): exact top-level key set; allowlisted settings keys (preferredTone, themes, objective, frequencyTargetPerWeek, optionalNgWords, notes) and persona keys; types and lengths bounded; any key matching publish/account/oauth/token/secret/schedul/cron/approval/generationWindow/locale/password/session/delete/vault refused anywhere; `chat`/`question` can never carry a delta; a delta equal to the saved value is dropped; anything else -> `CONSULT_AI_MALFORMED` (502, retryable), nothing saved.
- The client re-validates the envelope and result (`parseConsultResponse` -> `validateConversationalAssistantResult`), independently allowlisted; an envelope claiming a save/publish/X call is rejected.
- Result always has `requiresConfirmation: true`, `publishPermissionChanged: false`; envelope pins `settings_saved/persona_saved/publish_attempted/scheduled_post_created/x_api_called: false`.

### Authorization checks
1. Bearer required -> Auth server verifies the user (identity checked before body parsing).
2. `brand_memberships` read with the user's JWT, filtered by the **verified** user id + requested brand + role owner; row must match all three.
3. `brands` row must exist for that id and be `social_mobile_user_v1`.
4. Any missing/malformed/mismatched row -> 404/409, no settings read, no model call. No PR #70 / common-account semantics used. No service role anywhere.
5. Logs are metadata only (request id, result class, counts/lengths, duration, model, token usage); message/history/reply text, Authorization, user id, brand id, email and keys are never logged or returned (tested).

### Chat modes implemented
chat (casual talk, general questions, brainstorming, explaining current settings — no proposal), question (1 question, at most 2), proposal (delta only, on a clear preference; hesitant statements are handled conversationally by prompt rule). No web/live info (the assistant says so). Requests to change posting/schedule/X connection/login/deletion are answered as chat with a pointer to the app screen.

### Confirmation / persistence semantics
- An arriving answer only updates on-screen session state. The only write path is 「これで覚えて」 -> re-read latest -> `planConfirmedSave` -> `saveConfirmedIfUnchanged`.
- Delta applied onto the freshly read state: unrelated fields (including newer ones) are preserved.
- If a field the proposal touches changed since the proposal was shown -> no write, user is asked to confirm again against the current state.
- Save is a compare-and-swap on `updated_at` (insert when no row; a concurrent change/insert -> `stale`, nothing written).
- Settings-only confirmation does not touch persona columns or relabel persona provenance; a persona delta is merged and saved as confirmed/conversation.
- A newer proposal replaces the pending one; a plain answer leaves it; the user can dismiss it. Chat continues after a save.
- Raw conversation lives in screen state only; no transcript table, no analytics.

### Past-post learning handoff
`historyLearningIntent` preserved (model flag OR deterministic match on the user's own words). It only opens the existing consent gate; no X call, no persona derived, `derivedProfile` always null. G4 can attach the verified-account fetch behind that gate without changing the chat contract.

### changed_files
- supabase/functions/social-mobile-consult/{index.ts,logic.ts,logic_test.ts} (new)
- apps/social-mobile/src/domain/consult-session.ts (new), src/data/consult-client.ts (new)
- apps/social-mobile/src/app/(tabs)/consult.tsx, src/data/content-settings-repository.ts, src/domain/content-settings-conversation.ts, src/domain/content-settings.ts
- apps/social-mobile/tests/{consult.test.mjs,consult-screen.test.mjs} (new)

### Pre-existing defect found and fixed (it blocked every save)
The app validator rejected the saved default `generationWindow.endLocal = "24:00"` (DB constraint and server accept it), so `validateSocialMobileContentSettings(DEFAULTS)` was false and any settings save/read with the default window failed. Only the end time now accepts `24:00`; regression test added. Not a schema change.

### tests
- Server (`logic_test.ts`, 26): unauthenticated rejected; non-member / wrong role / wrong user rejected; valid owner accepted; bounded message/history; oversized/malformed/unknown-key input rejected; secret never returned/logged; safe response parses; malformed JSON/shape fails closed; publish/OAuth/token/scheduler/account/approval smuggling rejected; chat-only creates no proposal; proposal does not persist (handler performs only GETs); current-settings explanation has no mutation; past-post intent makes no X call; provider error/timeout safe + retryable; model call count = 1.
- App domain (`consult.test.mjs`, 29) and real screen code driven with stubbed React + scripted AI + in-memory versioned store (`consult-screen.test.mjs`, 11): bounded multi-turn history; chat shows no proposal card; follow-up question; proposal shows only changed fields; confirmation persists; unconfirmed persists nothing; later correction replaces pending proposal; unrelated settings unchanged; persona not erased by settings-only confirmation; changed settings not clobbered (reconfirm + CAS); general chat never toggles posting/scheduling/X; history request stays consent-gated; retry; preview mode makes no call and no write.
- End-to-end contract test: client -> real Edge handler (model stubbed) -> client validator -> save plan.
- Mutation checks (10): removing the membership check, the chat-delta rule, the settings allowlist, the request-key allowlist, the CAS filter, the stale-conflict rule, the client allowlist, or leaking the message into the log each makes a test fail. The deep forbidden-key scan is redundant with the allowlists (defence in depth; noted in code).
- Runs: `npm test` 153/153; typecheck 0; lint 0; `deno test` social-mobile-consult + dry-run + history-learning + `_shared/brand` 196/196; `deno check`, `deno lint` clean; `git diff --check` clean; secret scan and scope diff clean (no migration, x-connect, auth-provider, account-deletion, env, Vault, config path).
- No live paid AI call was made.

### Local verification (G3-owned, mock AI responses)
1 greeting/casual -> natural reply, no proposal. 2 「どんな投稿にしたらいい？」 -> follow-up question. 3 「親しみやすく、AIの話を多めにしたい」 -> reviewable proposal (tone + themes only). 4 before confirmation the store is byte-identical, zero writes. 5 after 「これで覚えて」 the store shows only the intended changes. 6 「今どういう設定？」 -> explanation, no proposal. 7 「過去投稿を読んで」 -> consent gate only, no X call. 8 no posting/schedule/X-connection side effect (handler issues only GETs + one provider request). All executed through the real screen code and the real handler with stubs.

### AI / provider / model usage policy
OpenAI Responses API, `gpt-5.6-luna` (existing default tier), structured output, `max_output_tokens` 900, 25 s timeout, 1 call per send, no retry/tools/web search, `store:false`. Input caps: message 1000 chars, 12 turns x 1000 chars, 6000 chars total, 32 KB body.

### DB migration = none. production mutation = 0. real X operations = 0. No deploy, no secret/config change.

### remaining issues
1. Live model behaviour (prompt quality, how reliably it distinguishes chat / question / proposal and hesitant statements) is **not verified**; it needs a dev invocation after deploy. Contract safety does not depend on it.
2. No native (Simulator) visual check of the new screen in this task; behaviour is verified through the real screen code in tests. UI is functional-only by design.
3. No per-user rate limit / usage accounting (no existing helper for social-mobile); only per-request caps. Recommend a quota before public rollout.
4. The endpoint is not deployed; the app shows a retryable error until it is. Deploy with `verify_jwt` on (the function also verifies the user itself). Remember the worktree-root deploy caveat (byte-verify).
5. Client-supplied `history` can contain forged assistant turns; they only influence the caller's own conversation and the output is still allowlisted. Worth a reviewer's look.
6. A persona edited through conversation sets provenance to `conversation` even when it was derived from past posts (existing `source: result.provenance` rule kept; analysed count/date are preserved).
7. Whether the production `social_mobile_content_settings` table exists was not checked (production reads are not available to this slot); the endpoint falls back to defaults if the table is absent, and the app already reports the table as unavailable.

### safety_checks
Own worktree/branch only; explicit-path staging; untracked `supabase/.temp`, `supabase/config.toml` left untouched; no other slot's files, simulator or Metro used; no secrets, tokens or personal emails in code, tests or this report.

### next_recommendation
- K3 -> focused Codex review (H2, Sol（高）) on: Auth/membership boundary, prompt / structured-output injection, no implicit persistence, cost bounds, no publish/X side effects.
- After merge: controlled deploy + one dev conversation to tune the prompt; then G4 past-post learning behind the existing consent gate; add a per-user quota.

---

# Claude Task 3 — CURRENT TASK

- task_id: x-ai-lab-dev-diary-kabumori-hero-8state-sync-20261002
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: low
- recommended_model: Sonnet5（中）
- type: AI Lab public-safe development diary context sync
- production_mutation_allowed: false

## Purpose

Final K1で完了した「かぶモリ Home Report Hero 8-state integration」を、会社員AIラボの公開安全な開発日記題材へ同期する。

これはX投稿生成ロジックの改修ではない。
共有メモ正本と、そのcommit済みruntime snapshotの同期だけを行う。

## Source fact

実際に完了・merge確認済みの事実:
- かぶモリHomeのレポートHeroで、レポート内容に応じて8種類のキャラクター表情を切り替えるUIを実装した。
- 追加AI呼び出しなしで、保存済みレポートの情報から表示状態を決める。
- 画面幅や「今日のポイント」1〜3件の差でも崩れないよう調整した。
- iOS Simulatorで複数幅を確認した。
- EAS build / production backend mutationは行っていない。

公開文にはPR番号、task_id、branch、commit SHA、内部テーブル/関数名、秘密情報を入れない。

## Required changes

1. `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`
   - 2026-10-02に既存entryがあるため、**同日entryを増やさない**。
   - 既存2026-10-02 entryはX自動投稿アプリの不具合修正について書かれているので、その内容を壊さない。
   - 1日1entry原則を守るため、今回のKabumori Hero内容を同entryへ無理に混ぜない。
   - 代わりに **2026-10-03 entryとして先取りして書かないこと**。
   - 結論として、正本Markdownへ新しい日付entryを追加できないため、今回のK1内容は**保留メモとしてTASK Reportへ記録するだけ**にする。日付が変わって実際の10/03作業が発生した場合のみ別TASKで追加する。

2. このTASKでは runtime snapshot / generator / tests を変更しない。

## Important

「K1で公開安全な題材候補がある」こと自体は記録するが、存在しない日付の開発日記を捏造しない。
同日1entryルールを破らない。
既存2026-10-02 entryを書き換えて異なる2つの開発内容を混在させない。

## Tests

- source diffが `.agent/**` のみであること
- `git diff --check`

## Completion

Reportに以下を記録:
- task_id
- result
- diary update performed: no
- reason: existing 2026-10-02 entry + one-entry-per-day rule
- preserved public-safe candidate text for future manual/next-day use
- production mutation: 0
- changed_files
- next_recommendation

その後:
- status -> done
- next_owner -> none
- STOP.

Recommended model: **Sonnet5（中）**.

## Report — K1 diary decision

- task_id: `x-ai-lab-dev-diary-kabumori-hero-8state-sync-20261002`
- result: **NO SOURCE UPDATE REQUIRED / DONE**.
- diary update performed: no.
- reason: canonical diary already has a real 2026-10-02 entry, and the documented rule is one entry per day. The K1-completed Kabumori Hero work is a valid public-safe candidate, but creating a duplicate same-day entry or pre-dating 2026-10-03 would break the diary contract.
- preserved candidate: 「株アプリのホームで、その日のレポート内容に合わせて8種類のキャラクター表情を切り替え、画面サイズやポイント数が変わっても崩れないよう調整した。」
- production mutation: 0.
- changed_files: `.agent/tasks/CLAUDE_TASK_3.md` only.
- next_recommendation: do not consume a Claude slot; reuse the candidate only if a later real diary-update task needs a backlog of public-safe development topics.
- next_owner: none.

---

## Archived previous G3 task

# Claude Task 3

- task_id: x-social-mobile-native-link-navigation-cleanup-20261001
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: medium
- recommended_model: Sonnet5（高）
- continues_from: x-social-mobile-account-deletion-ui-release-finish-20261001
- purpose: PR #68 / PR #65 後に残った social-mobile の native navigation UI 不具合を、Link-asChild の既知パターンに限定して修正・再発防止する。

## Confirmed current-main findings

Fresh main で以下を確認済み。

1. `apps/social-mobile/src/app/accounts/index.tsx`
   - 「ログイン方法」カードがまだ `<Link asChild><Pressable style={({ pressed }) => ...}>`。
   - PR #68 で確定した同じ root cause により、native で card styling が落ちる既知パターン。
   - G4 PR #65 は Final K4 PASS で merge 済みのため、現在はG4所有競合なし。

2. `apps/social-mobile/src/app/(tabs)/settings.tsx`
   - 「会話で相談する」が `<Link asChild><Card>...`。
   - `Card` は navigation press handler を受け取らないため、native確認で dead tap になっている。

3. PR #68 の `native-link-button-style.test.mjs` には `accounts/index.tsx` の known allowlist が残っている。今回の修正後はこの例外を除去する。

## Mandatory startup

1. Read `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G3 worktree/checkout.
3. Fresh `origin/main`.
4. Confirm G4 task is done and PR #65 is merged; do not reopen OAuth/auth-session work.
5. Confirm H1/G5 common-account work does not overlap the UI files below.
6. Do not reuse another slot's untracked files, .env, Simulator process, Metro process, branch, or worktree.

## Primary required fixes

### A. Accounts screen — 「ログイン方法」card

Fix the remaining native styling defect in:
- `apps/social-mobile/src/app/accounts/index.tsx`

Requirements:
- the whole intended card/tap target remains visibly styled on native iOS.
- tap navigates to `/login-methods`.
- preserve accessibility role / readable label.
- do not change X-connect hook, connect/reconnect behavior, OAuth, PKCE, callback, or account data.
- remove `accounts/index.tsx` from the known-unfixed allowlist once fixed.

Prefer the already accepted safe pattern:
- standalone `Pressable` + `router.push`
rather than `Link asChild` around a function-styled Pressable.

### B. Settings — 「会話で相談する」

Fix:
- `apps/social-mobile/src/app/(tabs)/settings.tsx`

Requirements:
- the card is visibly tappable.
- tap navigates to `/(tabs)/consult`.
- preserve the existing copy and overall layout.
- no content-settings persistence logic change.

Prefer explicit navigation with an interactive element rather than relying on `Link asChild` to inject press behavior into a component that does not forward it.

## Narrow same-pattern audit

Audit only `apps/social-mobile/src/app/**` and `apps/social-mobile/src/components/**` for these two specific invalid compositions:

1. `Link asChild` + direct child with function-valued `style` that can be lost by Slot style merging.
2. `Link asChild` + direct child such as `Card` / `View` that does not actually forward the injected press handler/ref and is therefore dead/non-interactive.

For every match:
- classify as broken / safe / false positive with concrete source reason.
- fix only demonstrably broken navigation in the same family.
- do not broaden into visual redesign or unrelated route cleanup.
- if a shared UI component change is proposed, make it only if it is strictly safer/smaller than fixing the call sites and regression coverage proves all consumers remain safe.

Potential rows mentioned by prior G3 report (history/schedule/account rows) are **audit candidates, not automatic edit targets**. Prove the issue before changing them.

## Tests

Update/extend `apps/social-mobile/tests/native-link-button-style.test.mjs` or a narrowly named companion test so that:

- `accounts/index.tsx` is no longer allowlisted.
- no `Link asChild` + function-valued direct-child style remains in app/components.
- the detector also catches the proven dead `Link asChild > Card/View` class where the child cannot receive/forward press behavior.
- detector self-tests prove the scanner actually fails on synthetic broken examples.
- the Accounts 「ログイン方法」 target is an interactive element with explicit navigation to `/login-methods`.
- Settings 「会話で相談する」 is interactive and explicitly navigates to `/(tabs)/consult`.
- any additional call-site fix gets a focused route/navigation regression.

Run:
- social-mobile full tests
- typecheck
- lint
- `git diff --check`
- focused static/navigation tests
- secret/scope diff check

## Native verification

Use a G3-owned local iOS Simulator environment only.

Verify at minimum:
1. Accounts → 「ログイン方法」 card has expected visible card styling and opens Login methods.
2. Settings → 「会話で相談する」 visibly responds to tap and opens Consult.
3. If any additional same-pattern call site was changed, visually/tap-verify that route too.
4. No production data mutation is needed; sample/mock data preferred.
5. No EAS build unless local verification is genuinely impossible.

Temporary local auth/sample-data harness is allowed only if:
- isolated to G3,
- untracked/uncommitted,
- reverted/removed after verification,
- does not connect to protected production data.

## Explicit non-scope

Do NOT change:
- `apps/social-mobile/src/features/x-connect/**`
- OAuth / PKCE / callback / provider behavior
- Supabase Auth/provider flows
- account deletion backend/state machine
- common-account/service-entitlement work
- DB / RLS / RPC / migrations
- Edge Functions
- Vault/token storage
- scheduler/posting
- production feature flags
- App Store/TestFlight/EAS release configuration

## Production / safety

- source + tests + PR only
- production mutation = 0
- real X operations = 0
- no deploy
- no account deletion
- no provider login/revoke/post
- do not expose secrets or personal credentials

## Completion / K3

Report:
- task_id
- result
- exact broken Link-asChild patterns found
- exact files fixed
- audit matrix (broken / safe / false positive)
- changed_files
- tests
- native simulator result
- proof x-connect/Auth/deletion/common-account/backend scopes unchanged
- commit_hash
- push
- PR
- production mutation = 0
- real X operations = 0
- remaining issues
- safety_checks
- next_recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Expected review policy:
- if changes stay UI/navigation-only and native verification passes, additional Codex review is normally unnecessary.
- if implementation touches shared interactive primitives broadly, Auth/OAuth, or any backend boundary, STOP and let ChatGPT decide review before merge.


## Report — x-social-mobile-native-link-navigation-cleanup-20261001

- task_id: x-social-mobile-native-link-navigation-cleanup-20261001
- result: **PASS** (source + tests + native before/after verification; PR open). Model: Sonnet 5.5.
- PR: https://github.com/anohi-memories/kabumori/pull/73 (branch `claude/g3-native-link-cleanup-20261001`)
- commit_hash: 645923ba (rebased on origin/main 0c27998b); push: done, branch pushed to origin.

### Exact broken Link-asChild patterns found (all proven dead/broken on native BEFORE the fix)
1. `Link asChild` + `Card`/`View` direct child: Link only injects its press handler into the direct child; `Card`/`View` do not accept/forward `onPress` -> tap does nothing.
2. `Link asChild` + function-valued `style` on the direct child: radix Slot merges style as `{...slotStyle, ...childStyle}`, a function spreads to `{}` -> styling lost.

### Exact files fixed
- apps/social-mobile/src/app/(tabs)/history.tsx (row -> /posts/[id])
- apps/social-mobile/src/app/(tabs)/schedule.tsx (row -> /posts/[id])
- apps/social-mobile/src/app/(tabs)/settings.tsx (「会話で相談する」 -> /(tabs)/consult)
- apps/social-mobile/src/app/accounts/index.tsx (account row -> /accounts/[id]; 「ログイン方法」 card -> /login-methods keeps styles.card)
All now use a standalone `Pressable` + `router.push` (accessibilityRole="button"), copy/layout unchanged.

### Audit matrix (src/app/** and src/components/**; every Link asChild)
| site | direct child | verdict |
|---|---|---|
| (tabs)/index.tsx x5 (切り替える/予定/履歴/設定/相談) | ActionButton | safe (forwards onPress to Pressable; Home→アカウント verified on native) |
| posts/[id].tsx 再接続 | ActionButton | safe (same class) |
| (tabs)/history.tsx, (tabs)/schedule.tsx | Card | broken -> fixed (dead tap proven native) |
| (tabs)/settings.tsx 会話で相談する | Card | broken -> fixed (dead tap proven native) |
| accounts/index.tsx account row | View | broken -> fixed (dead tap proven native) |
| accounts/index.tsx ログイン方法 | Pressable + function style | broken -> fixed (flat unstyled block proven native) |
| login-methods.tsx, settings.tsx アカウント管理 | (fixed in PR #68) | safe |
False positives: none.

### changed_files
- apps/social-mobile/src/app/(tabs)/history.tsx, (tabs)/schedule.tsx, (tabs)/settings.tsx, accounts/index.tsx
- apps/social-mobile/tests/native-link-button-style.test.mjs

### tests (clean env, no local .env.local)
- `npm test` 113/113, typecheck exit 0, lint exit 0, `git diff --check` clean.
- test file: allowlist for accounts/index.tsx removed; both broken classes detected app-wide (allowlist of press-forwarding components: Pressable/ActionButton/Text/Touchable*); detector self-tests fail on synthetic broken (Card, View, function-style Pressable) and pass on good examples; per-route navigation checks (/login-methods, /accounts/[id], /(tabs)/consult, /posts/[id]); new tests failed (6) against the unfixed code, pass after the fix.
- scope diff check: no x-connect/Auth/DB/RLS/RPC/migrations/Edge/Vault/flag path in the diff; no secret-like string added.

### Native simulator result (G3-owned device, iOS Simulator Release, sample data)
- Own simulator "G3-nav-cleanup" created and used only (another slot's devices were not touched; one stray tap on another booted device's empty home-screen area happened before I pinned the device, no effect).
- BEFORE: 履歴行, 投稿予定行, 会話で相談する, アカウント行 = no response after 8s; ログイン方法 = flat unstyled block.
- AFTER: 履歴行 -> 投稿詳細 (8:20), 投稿予定行 -> 投稿詳細 (11:44), 会話で相談する -> AI相談 tab, アカウント行 -> アカウント詳細 (@kabumori), ログイン方法 card visibly styled and -> ログイン方法 screen. Home ActionButton path also works.
- Local-only harness (sample-data .env.local, temporary auth-gate bypass in _layout.tsx, throwaway bundle id, generated ios/) used and removed; simulator deleted; nothing of it committed; package.json/.gitignore unchanged.

### proof x-connect / Auth / deletion / common-account / backend unchanged
- diff touches only the 4 screens + 1 test; `git diff --name-only` has no match for x-connect, supabase, migrations, env, auth-provider, account-deletion.

### production mutation = 0, real X operations = 0
No deploy, no flag change, no deletion, no provider login/revoke/post; sample-data build had no Supabase config.

### remaining issues
1. `/accounts/[id]` (アカウント詳細) shows no top header/back button. It was unreachable before (dead row); now reachable. Edge-swipe back works. Header config is route cleanup (out of scope) — decide separately.
2. Any future `Link asChild` around a new non-forwarding component is now caught by the test; shared primitives were not changed.
3. Unchanged release gates: common-account deletion semantics, Apple production config, legal URLs/texts, audit retention, main-app account-delete coordination; deletion flag stays OFF.

### safety_checks
- own worktree + own simulator only; explicit-path staging; no secrets/tokens/emails in report; G4/G5/H1 files untouched.

### next_recommendation
- Review/merge PR #73 (UI/navigation only; additional Codex review normally unnecessary per TASK).
- Separate small task: give `/accounts/[id]` a visible header/back button (or confirm it is intended).

---

# Claude Task 3

- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- continues_from: x-social-mobile-e3-delete-revoke-residue-20261001
- purpose: E3で機能動作がPASSしたX自動投稿アプリのアカウント削除について、残っているnative iOS UIブロッカーを解消し、共通アカウント設計に踏み込まずに現行削除UIをリリース可能な見た目・導線まで仕上げる。

## Context

Previous G3 E3 reached Final K3 PASS:
- disposable X authorization revoke succeeded
- social-mobile workspace/membership/social account/X credential/OAuth transient data were removed
- unexpected residue = 0
- protected production posting accounts unchanged
- shared Supabase Auth/login/main-app profile intentionally remained under current `social_only` behavior
- real X posts = 0

Remaining UI findings from the native iOS Release verification:
1. On `login-methods`, the buttons for 「投稿用のX接続を確認する」 and 「アカウントの削除について」 can render as blank/invisible text while their tap area still works.
2. Account deletion is too deep to discover; Settings has no direct account-management/deletion entry.

A separate common-account/auth design effort is now defining the future company-wide account/service-entitlement model. This G3 task MUST NOT preempt or redesign that model.

## Mandatory startup

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, and this TASK.
2. Fresh-check `origin/main`.
3. Use an independent G3 worktree/checkout. Do not use G4/H1/H2 worktrees or simulator processes.
4. Confirm G4 PR #65 owns X account-switch auth-session work and currently touches X-connect/account-selection paths. Do not edit G4-owned files.
5. Confirm H2 PR #66 review and H1 PR #67 review do not overlap the files you intend to change.
6. Preserve all previous G3 E3 reports below; do not rewrite historical results.

## Allowed primary scope

Prefer the smallest set necessary:
- `apps/social-mobile/src/app/login-methods.tsx`
- `apps/social-mobile/src/app/(tabs)/settings.tsx`
- `apps/social-mobile/src/app/account-deletion.tsx` only if needed for UI consistency
- narrowly related social-mobile UI tests
- shared UI component only if the root cause is proven there and the change is demonstrably safe for all consumers

Do NOT edit:
- `apps/social-mobile/src/features/x-connect/**`
- G4-owned account-switch files
- Supabase Auth/provider flows
- account-deletion backend/state machine
- DB/RLS/RPC/migrations
- Vault/token storage
- OAuth ownership
- service-entitlement/common-account design
- production feature flags
- scheduler/posting paths

## Required work

### 1. Root-cause the invisible native buttons

Reproduce or inspect the iOS Release/native rendering path for:
- 「投稿用のX接続を確認する」
- 「アカウントの削除について」

Determine why the text is invisible while the Pressable remains tappable.

Do not merely change color blindly. Confirm whether the problem is caused by:
- `Link asChild` + `Pressable`
- inherited/native text/style behavior
- shared `styles.buttonText`
- Release-only rendering
- another concrete cause

Fix the actual source cause with the narrowest safe change.

### 2. Make account management discoverable from Settings

Add a clear, ordinary Settings entry for account/login management.

Preferred UX:
- a distinct account section/card in Settings
- direct route to `/login-methods`
- wording should make it obvious that login methods, X connection, and account/service deletion live there

If a direct deletion shortcut is clearly safer/usably better, it may be added, but do not bypass the existing preview/re-auth/confirmation deletion screen.

Do not move destructive logic into Settings.

### 3. Preserve deletion truthfulness

Current deletion UI must continue to:
- preview what the server says will be deleted/kept
- require fresh reauthentication
- require the typed confirmation
- report server-confirmed outcome only
- keep the current feature-gate behavior

Do not alter `social_only` / `social_and_login` semantics in this task. Those semantics will be reconsidered by the common-account project.

### 4. Feature flag

Do NOT globally enable `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` in this task.

Goal is source/UI readiness only.

After the common-account design decides the final deletion semantics, activation can be a separate controlled release step.

## Tests / verification

At minimum:
- relevant social-mobile tests
- new/updated UI/static tests proving the two button labels remain visibly rendered in native-compatible composition
- Settings contains a discoverable account-management route
- existing account-deletion preview/reauth/typed-confirmation behavior unchanged
- no G4 X-connect source change
- no Auth/DB/RLS/RPC/Vault/OAuth backend diff
- typecheck
- lint
- `git diff --check`

Native verification:
- use local iOS Simulator / Release-like build where practical
- visually confirm both affected button labels are visible
- confirm both routes are tappable and land on the correct screens
- confirm the Settings account entry is visible without requiring knowledge of hidden navigation
- no EAS build unless truly required; explain if unavoidable

## Production / safety

- source + tests + PR only
- no production deploy
- no feature-flag enable
- no destructive account deletion in this task
- no real X login/revoke/post
- production mutation = 0
- do not remove the retained disposable Auth/profile from the E3 test; that now belongs to the common-account/account-lifecycle decision

## Completion conditions

- invisible button root cause identified
- source fix implemented
- both labels visible in native verification
- Settings account-management entry added and verified
- deletion semantics/backend unchanged
- tests/typecheck/lint/diff checks pass
- commit + push + PR
- production mutation 0
- real X operations 0

## Report

Include:
- task_id
- result
- root cause of invisible buttons
- UX change
- changed_files
- tests
- native/simulator verification
- proof deletion backend/semantics unchanged
- proof no G4 overlap
- commit_hash
- push
- PR
- production mutation
- real X operations
- remaining issues
- safety_checks
- next_recommendation

Then status -> review_required, next_owner -> chatgpt and STOP for K3.

---

## Previous completed G3 history — preserved below

# Claude Task 3

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- continues_from: x-social-mobile-pr63-merge-native-e3-resume-20260930
- purpose: E3の使い捨てユーザー/X接続が正常に成立した状態から、アカウント削除E2Eを最後まで検証する。削除によるX認可失効、Vault/DB/Auth等の残存データ、既存本番アカウントへの非影響を確認する。

## Confirmed starting point

Operator report:
- local iPhone Simulator build is connected to real production data.
- a genuinely disposable X account `@tigers_torataro` is now connected successfully to the disposable social-mobile user.
- protected production posting accounts were not touched.
- account deletion and X authorization revoke have NOT been executed yet.
- a temporary local-only browser-session workaround was used to choose the correct X account; it was not committed.

The previous K3 blocker (wrong X account already connected in production) is therefore resolved.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, and the previous G3 report history.
2. Use the existing independent G3 worktree/checkout only. Do not use G4's worktree.
3. Fresh-check `origin/main`, but do NOT pull unrelated G4 source changes into the already verified E3 session unless rebuilding becomes unavoidable.
4. Do not make source changes in this task unless a blocking defect is found. This task is operational E2E verification.
5. Confirm the disposable connected X identity is exactly `@tigers_torataro`.
6. Confirm protected production posting accounts remain unchanged and are excluded from every destructive selector.
7. Do not reveal token plaintext, secret values, Vault plaintext, or personal email addresses in logs/report.

## Phase 1 — read-only preflight before deletion

Capture a read-only baseline sufficient to prove isolation:
- disposable Auth/user/profile/workspace/membership state
- disposable social account state and platform identity
- disposable token-reference / Vault-reference existence only (never plaintext)
- OAuth state / pending rows relevant to the disposable flow
- deletion/audit/tombstone baseline if present
- protected production X account state/count/hash or equivalent invariant
- Vault count/identifier hash or equivalent protected-account invariant
- feature flags relevant to deletion remain unchanged; do not globally enable deletion

Confirm again:
- no real X post
- no scheduler/manual publish
- no provider-console mutation
- no protected production account mutation

## MANDATORY STOP — fresh destructive approval

After Phase 1 is complete and BEFORE the first destructive action, STOP and report:

- disposable identity confirmed: `@tigers_torataro`
- read-only baseline captured
- protected production accounts unchanged
- exact first destructive operation: execute the existing account-deletion flow for this disposable social-mobile user
- expected effects: delete the disposable account/workspace data, revoke only this disposable X authorization as designed, remove only this disposable credential material
- feature remains OFF globally

Then request **fresh explicit user approval in the conversation**.

The user's current request to create this TASK is NOT the destructive approval.
Do not reuse any older approval.

## Phase 2 — after fresh approval only: execute deletion

Only after explicit approval:
1. Use the existing app/account-deletion E2E path for the disposable user.
2. If a local-only flag/config is required to expose the deletion path, keep it local/uncommitted and do not globally enable production deletion.
3. Perform the deletion once. Do not retry blindly if the result is ambiguous.
4. Do not manually revoke other X accounts or make provider-console changes.
5. If deletion fails before completion, STOP and preserve evidence; do not run separate cleanup mutations unless explicitly approved.

## Phase 3 — verify X revoke

After successful deletion:
- verify the deletion path attempted/completed revoke for the disposable X authorization according to the existing implementation.
- prefer server-side/audit/result evidence that does not require retaining token plaintext.
- if provider-side confirmation requires an interactive X "Connected apps" check, ask the user to perform only that read/confirmation for `@tigers_torataro`.
- never revoke the app globally and never touch the protected production X accounts.
- do not perform a real X post as a revocation test.
- if automatic revoke is not provable or failed, STOP; do not perform a separate manual revoke without new explicit approval.

## Phase 4 — residue / isolation verification

Read-only verify the disposable user's data is removed or intentionally retained exactly as designed. Check the relevant boundaries:
- Auth user/session
- profile/workspace/membership
- social account
- OAuth transient state
- token-reference/Vault credential
- content/settings/history rows owned only by the disposable workspace, where applicable
- deletion audit/tombstone records that are intentionally retained

Also prove protected production invariants are unchanged:
- existing production X accounts
- their credential references/Vault identifiers
- refresh state
- posting/scheduler state
- feature flags
- no real X post created

Classify every remaining row/value as:
- expected retained audit/tombstone
- unexpected residue
- unrelated protected production data

Do not "clean up" unexpected residue during verification. Report it first.

## Completion / K3

Report:
- task_id
- result
- destructive approval timestamp/message boundary
- deletion result
- X revoke proof/result
- residue matrix
- protected-account invariants before/after
- source changes (expected none)
- local-only temporary config used, if any
- tests/checks
- production mutations performed exactly
- real X posts = 0
- remaining issues
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Previous G3 task closure

Previous task `x-social-mobile-pr63-merge-native-e3-resume-20260930` reached Final K3 BLOCKED only because the first X identity was already connected to a protected production posting account. No destructive action occurred. Its report and Final K3 state remain in Git history / CURRENT_STATE and are not to be re-executed.

## Report — x-social-mobile-e3-delete-revoke-residue-20261001

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- result: **PASS** (E3 complete: deletion, X revoke, residue, protected invariants all verified). Two UI findings and one retained-by-design item are listed under remaining issues.
- model: Opus 5.5

### Destructive approval boundary
- Phase 1 (read-only baseline) finished, then STOP. Fresh explicit approval was requested in the conversation with the exact operation, expected effects and "feature stays OFF globally".
- User answered "承認する（自分で削除ボタンを押す）" at 2026-09-30T15:50:00Z (JST 10/1 00:50). No older approval was reused.
- The delete button was pressed once, by the user, in the local Simulator build. Claude pressed no destructive control.

### Deletion result
- App showed「削除しました — このアプリのデータを削除しました。ログイン用アカウントと「かぶモリ」のデータは残っています。」and returned to the login screen with the same notice banner (D2 fix confirmed on native).
- Scope: `social_only` (the disposable login also has a main-app profile), as predicted in Phase 1.
- Audit trail for the subject after the approval boundary (UTC): requested 15:57:07.42 → started 15:57:07.47 → x_revoked 15:57:07.91 → purged 15:57:07.95 → completed_social_only 15:57:08.05. No `failed` / `operator_required` / `blocked` row, no reason code. One attempt, no retry.

### X revoke proof
- Server-side: the flow stops with X_REVOKE_FAILED unless the X revoke endpoint returns success for both the refresh and the access token of exactly this account, and the `x_revoked` checkpoint is only written when the fingerprints of the revoked material match the credential set. The `x_revoked` audit row exists, followed by `purged`.
- Provider-side (user read-only check, logged in as `@tigers_torataro`): the app is no longer listed under X "connected apps". Nothing was pressed there.
- No global app revoke, no provider-console change, no real X post used as a test.

### Residue matrix (disposable subject, before → after)
| boundary | before | after | class |
|---|---|---|---|
| workspace | 1 | 0 | removed |
| membership | 1 | 0 | removed |
| social account (`tigers_torataro`, identity_verified, publish_enabled=false) | 1 | 0 | removed |
| token references in Vault (access + refresh) | 2 | 0 | removed |
| OAuth transient states (5 unconsumed) | 6 | 0 | removed |
| refresh state / scheduled posts / post logs / claims / windows / fingerprints of the workspace | 0 | 0 | none existed |
| deletion tombstone | 0 | 0 | none left (removed at finalize, as designed) |
| deletion audit rows (hashed subject only) | 10 | 15 | expected retained audit |
| Auth user / identity (email) / profile | 1 / 1 / 1 | 1 / 1 / 1 | expected retained (`social_only`: login belongs to the main app) |
| Auth sessions / refresh tokens | 3 / 4 | 3 / 4 | expected retained with the login (device sign-out is local) |
| handle present anywhere else | 0 | 0 | none |

Unexpected residue: **none**.

### Protected-account invariants (before = after, byte-equal hashes)
- protected social accounts: 3, row hash (ids, workspace, platform user, both token references, publish flag, status, updated_at) unchanged
- Vault rows referenced by protected accounts (id + updated_at hash) unchanged; all other Vault ids unchanged; Vault total 22 → 20 (= exactly the two disposable references)
- refresh state count/hash, refresh rollout, non-user workspaces hash, the other pre-existing user workspace: unchanged
- scheduled_posts 408, post_execution_logs 949 (latest timestamp unchanged, before the test), publish_claims 20, posting_windows 19, fingerprints 103: unchanged
- auth users 4, profiles 2: unchanged
- global totals changed only by the disposable rows: user workspaces 2→1, memberships 2→1, social accounts 4→3, OAuth states 28→22

### Other fields
- source changes: none committed. No PR.
- local-only temporary config (uncommitted, not in any product build): `.env.local` (real-data mode + deletion flag), `app.config.js` (throwaway bundle id), generated `ios/`, and a one-line ephemeral auth-session option in the X-connect hook used only to pick the right X account. The hook edit has been reverted in the worktree; the other files stay untracked until K3, then are removed.
- feature flag: the deletion entry is still gated by the client build flag, which is unset in every committed config. Nothing was enabled globally. No secret, Edge function, migration or provider setting was changed.
- tests/checks: operational verification only (read-only SQL before/after diff). No code changed, so no test run.
- production mutations performed exactly: (1) the user's X connect for the disposable account (new social account + 2 Vault references + OAuth states), done before this TASK; (2) one account-deletion call by the user, which revoked that X authorization and removed the rows above and wrote 5 audit rows. Nothing else.
- real X posts = 0. No scheduler/manual publish.

### Remaining issues
1. **Invisible buttons on the Login methods screen (native iOS, Release build).** 「アカウントの削除について」and「投稿用のX接続を確認する」render as blank space; the hidden area is still tappable and navigates. The deletion entry is effectively undiscoverable for a signed-in, onboarded user (the onboarding-gate entry from PR #59 is visible and fine). Release blocker for the deletion feature; needs a source fix + Simulator check. Not fixed here (operational task).
2. **Deletion entry is deep**: Home → アカウントを切り替える → ログイン方法 → bottom card. Not in the 設定 tab, where the user looked first. Consider a direct entry.
3. X auth session reuses the previous X login (already assigned to G4).
4. The disposable login itself remains in production (main-app profile exists → `social_only`). Removing it is a main-app (G1/G2) account-delete or operator action; not done.
5. Unchanged release gates: Apple production config, legal URLs/texts, audit retention policy, main-app account-delete coordination.

### Safety checks
- no token plaintext, Vault plaintext, secret value/id or personal email in logs or this report
- every destructive selector was the caller-bound deletion flow of the disposable user; no first-row fallback, no manual SQL mutation, no cleanup mutation
- protected production posting accounts untouched and proven unchanged
- dedicated G3 worktree only; G4 worktree and X-connect source untouched

### Next recommendation
- Final K3 for E3 = PASS candidate.
- Open a small source task for issue 1 (and decide issue 2) before the deletion flag can be enabled in any product build.
- Decide who removes the leftover disposable login (issue 4).


## Final K3 — E3 deletion/revoke/residue

- verdict: **PASS**
- accepted task: `x-social-mobile-e3-delete-revoke-residue-20261001`
- operational result: the disposable social-mobile service data was deleted once after fresh approval; its X authorization was revoked; no unexpected residue remained.
- accepted scope: `social_only`. The shared Supabase Auth user / login identity / main-app profile were intentionally retained.
- residue: workspace, membership, social account, disposable X credential references/material, and OAuth transient state removed as designed; deletion audit retained as designed.
- protected production posting accounts and their credential references/state remained unchanged.
- real X posts: 0. No scheduler/manual publish. No global deletion flag enable. No source commit or PR from this task.
- source changes: none. Local-only verification edits/config were not product changes; the X-connect temporary hook edit was reverted before report.
- remaining release blocker: native iOS Login methods screen has invisible/tappable-only buttons for the deletion and posting-X navigation. Deletion entry is also too deep. Keep deletion feature globally gated until UI/flow work is addressed.
- retained disposable login/profile is intentional under current `social_only` behavior and now becomes input to the new common-account/service-entitlement design rather than an E3 failure.
- Codex review: **not required for this K3** because no implementation source changed and the purpose of this task was operational E2E of already reviewed boundaries. Re-review at the next source change / production activation gate.
- AI Lab diary: 候補あり — 使い捨てアカウントで「このアプリだけ利用終了」の流れを最後まで試し、他のサービス用ログインを残したままX連携とアプリ専用データだけ消えることを確認した。
- next: common-account design should replace the current proxy-style service-existence decision with an explicit service entitlement. Separately fix the native deletion/navigation button visibility before enabling self-service deletion broadly.


## Report — x-social-mobile-account-deletion-ui-release-finish-20261001

- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- result: **PASS** (source + tests + native visual check done; PR open for review). Model: Sonnet 5.5 (recommended Sonnet5（高）, switched by user before start).
- PR: https://github.com/anohi-memories/kabumori/pull/68 (branch `claude/g3-deletion-ui-finish-20261001`, commit `ec292b5`)

### Root cause of the invisible buttons
- `<Link asChild>` renders expo-router's Slot, which uses radix `mergeProps`: `style = { ...slotStyle, ...childStyle }`.
- A `Pressable` whose `style` is a function (`({ pressed }) => [...]`) spreads to `{}` → the button's background, padding and border were dropped; the label (`color: #FFFFFF`) stayed → white text on a near-white screen. The Pressable and its tap area still existed, hence "invisible but tappable".
- Not Release-only and not `styles.buttonText`; it is the Link-asChild + function-style composition. Verified in `node_modules/@radix-ui/react-slot` (mergeProps) and `expo-router/build/ui/Slot.js` (only flattens the Slot's own style).

### UX change
- login-methods: the two buttons are standalone `Pressable` + `router.push('/accounts' | '/account-deletion')`, same style as before (primary / danger).
- Settings: new「アカウント管理」card at the top (above the long content form, visible without scrolling): ログイン方法の確認 / 投稿用のXアカウントの接続 / アカウントの削除 are explained, button「アカウントを管理する」→ `/login-methods`. No destructive logic in Settings.
- Deletion screen, reauth, typed confirmation, server-confirmed outcome, `social_only` / `social_and_login` semantics, feature gate: untouched. `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` not enabled anywhere.

### changed_files
- apps/social-mobile/src/app/login-methods.tsx
- apps/social-mobile/src/app/(tabs)/settings.tsx
- apps/social-mobile/tests/native-link-button-style.test.mjs (new)
- No change to x-connect, accounts/index.tsx, Auth, DB/RLS/RPC/migrations, Vault, OAuth, Edge functions, flags.

### tests / checks (clean env, no local .env.local)
- `npm test` 94/94 pass (5 new), `npm run typecheck` exit 0, `npm run lint` exit 0, `git diff --check` clean.
- New test: AST scan of src/app + src/components for `Link asChild` with a function-valued child style (one known file excepted, listed in the test), detector self-check, both labels live in standalone Pressables that navigate and keep button style, Settings entry opens `/login-methods` and sits above 「コンテンツ設定」.
- Note: with a local `.env.local` present (my earlier real-data E2E file) `auth-release-readiness` "operator script" fails because the script reads it; unrelated to this change, passes without the file.

### Native verification (iOS Simulator, Release build, sample-data mode, no production connection)
- Settings → 「アカウント管理」card + button visible at top without scrolling.
- Tap → ログイン方法 screen. 「投稿用のX接続を確認する」 (blue) and 「アカウントの削除について」 (red) both visibly render with white labels.
- Tap 削除 → アカウントの削除 screen (shows 準備中 because the flag is unset — gate behavior preserved). Tap X-confirm → アカウント screen. Both land correctly.
- Local-only harness used and removed: sample-data `.env.local`, a temporary auth-gate bypass in `_layout.tsx` (reverted, never committed), a throwaway bundle id. After the check: app uninstalled, `ios/`, `app.config.js`, `.env.local` and the env backup deleted. Untracked `supabase/.temp` and `supabase/config.toml` (CLI link files) remain untracked and unstaged.

### Findings (not fixed, out of this TASK's boundary)
1. `src/app/accounts/index.tsx`「ログイン方法」card has the same defect (Link asChild + function style → card styling lost; visible as a flat unstyled block). File is touched by G4 PR #65; fix there or after it merges, then drop it from the test's allowlist.
2. Settings existing「会話で相談する」 card is a dead tap (verified on native): `Link asChild` child is `Card`, which does not accept `onPress`. Needs a separate small fix (Pressable + router.push, or let Card forward touch props). Also applies to other `Link asChild > Card/View` uses (accounts/index.tsx account rows, history/schedule rows) — worth auditing together.
3. The same family of problem can silently return; the new test guards only Link-asChild-with-function-style, not non-forwarding children.

### Production / safety
- production mutation = 0, real X operations = 0, no deploy, no flag change, no destructive deletion, no secrets/tokens/emails in report.
- Disposable E3 login/profile left in production untouched (belongs to the common-account decision).
- G4 files and worktree untouched; own worktree only; explicit-path staging.

### Remaining / next recommendation
- Review and merge PR #68; then decide the fix for findings 1–2 (G4 / a follow-up).
- Release gates unchanged: common-account deletion semantics, Apple production config, legal URLs/texts, audit retention, main-app account-delete coordination; deletion flag stays OFF.


## Final K3 — account deletion UI release finish

- verdict: **PASS**.
- accepted PR #68 exact head: `ec292b50f8d9622a9c35dd1ce62a7d9ec1c1512b`.
- squash merged as `c1f4f42ab78430ee0c214759b4ddac280b7f2265`.
- root cause accepted: `Link asChild` + function-valued Pressable style lost the button container styling, leaving white text on a light background.
- fix accepted: standalone Pressable + router.push for the two affected buttons; Settings now has a visible account-management entry.
- native iOS Simulator Release verification passed for visibility and navigation.
- tests: 94/94, typecheck PASS, lint PASS, diff check PASS.
- no account-deletion backend/state-machine/scope/feature-flag/Auth/DB/RLS/RPC/Vault/OAuth change.
- G4 files untouched; PR #65 remains a separate account-switch workstream.
- production mutation: 0; real X operations: 0.
- extra Codex review: not required because this is a narrow UI/navigation fix with native verification and no security/backend boundary change.
- remaining non-blocking findings: accounts screen has a similar styling issue in a G4-owned file; Settings 「会話で相談する」 and similar Link-asChild non-forwarding children need a separate UI follow-up.
- app binary/TestFlight release was not performed by this task; merge makes the source ready for the next native build.
- G3 closed and reusable only after fresh allocation.


## Final K3 — native Link navigation cleanup

- verdict: **PASS**.
- accepted PR #73 exact head: `645923ba87c8667073061d13a2fc46bbb31ebcbe`.
- squash merged as `a81a60bb731e2c51aa907b4cc08234cb602c4f6a`.
- scope remained UI/navigation-only: history, schedule, Settings, Accounts and the focused navigation regression test.
- native Release-like Simulator verification confirmed all previously dead targets now navigate correctly and the Accounts 「ログイン方法」 card styling is restored.
- audit accepted: all broken `Link asChild > Card/View` and function-style direct-child cases in app/components were fixed; remaining ActionButton cases are safe because they forward onPress to Pressable.
- tests: social-mobile 113/113 PASS; typecheck PASS; lint PASS; git diff --check PASS.
- no x-connect/OAuth/Auth/account-deletion/common-account/DB/RLS/RPC/Edge/Vault/flag/scheduler change.
- production mutation: 0; real X operations: 0; deploy: none.
- extra Codex review: not required because the final delta is narrow UI/navigation-only, shared primitives were not changed, and native before/after verification passed.
- Netlify preview succeeded. Vercel status failure was only the known free-tier build-rate-limit and is not a candidate-quality failure for this native UI PR.
- remaining UI issue: `/accounts/[id]` is now reachable but lacks a visible top header/back button; edge-swipe works. Treat separately as route/navigation polish.
- no TestFlight/App Store/native production build was released by this task.
- G3 closed and reusable after fresh allocation.


## K3 decision — PR #78 AI consultation v1

- verdict: **PASS to focused Codex review; merge/deploy HOLD**.
- review target: PR #78 exact head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`.
- PR open/mergeable; fresh main +7 commits with no overlap across the 11 PR files.
- Netlify success; Vercel failure is the known build-rate-limit signal.
- source/test scope is consistent with AI consultation v1; no migration/deploy/production mutation/X operation.
- K3 does not merge because the candidate adds an authenticated AI API plus user-confirmed durable settings/persona writes.
- H2 assigned `x-social-mobile-pr78-ai-consult-review-20261002`, recommended **Sol（高）**.
- key review includes real production `updated_at` CAS/trigger semantics and verify_jwt config, not only unit tests.
- next_owner: codex; wait for C2.


## C2 result — schema prerequisite missing

- verdict: **HOLD / CHANGES REQUIRED before PR #78 merge**.
- H2 confirmed production `public.social_mobile_content_settings` is absent.
- PR #78 source head remains `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`; no H2 source fix.
- AI conversation source is not rejected on its merits; review stopped at the mandatory persistence/CAS prerequisite.
- existing source-only migration candidate is undergoing a separate H2 review.
- no production schema apply is authorized.
- G3 remains review_required and blocked from merge/deploy until schema prerequisite and the remaining H2 PR #78 review gates are completed.


## K3 decision — PR #81 content-settings hardening

- verdict: **PASS to focused H2 rereview; merge/apply/deploy HOLD**.
- accepted review target: PR #81 exact head `5595fb131813542c55c43bc783af623cdb9ea442`.
- fresh main is 24 commits ahead of PR base with no overlap across the 7 PR files.
- Netlify/Vercel checks green.
- reported local evidence is sufficient to proceed to independent review, not to production apply.
- H2 assigned `x-social-mobile-pr81-content-settings-hardening-rereview-20261003`, recommended **Sol（高）**.
- production migration apply remains separately approval-gated.
- PR #78 remains blocked until schema is independently accepted, applied with explicit approval, and read back.
- next_owner: codex; wait for C2.
