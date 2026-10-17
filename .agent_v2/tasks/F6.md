# F6 — PR256 匿名化P2限定修正・P3運用ガード
- task_id: common-ai-f6-pr256-policy-pii-erasure-p2-fix-20261017
- slot: F6
- owner: claude
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- production_permission: NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-f6-pr256-erasure-reviewed-changes-required.md
- review_source: independent Claude PR256 CHANGES_REQUIRED P2x1 P3x3; reviewer provided result in 共通AI基盤のちゃ chat. No repeated review of PR249.

## Goal
Correct precisely the reproduced privacy P2 in PR256: user-scoped `ai_ledger.budget_policies.policy_key` and `note` retain personal information after user erasure while `ai_ledger_user_footprint` incorrectly reports zero. Preserve ledger accounting/immutability protections. Handle the reviewer's P3a/P3b/P3c with minimal regression-tested defenses when safe, but do not widen scope to POSTONA/F5/Auth/Provider/H5.

## Preflight
Confirm fresh origin/main, PROJECT_RULES, both ORCHESTRATION/ACTIVE_TASK/CURRENT_STATE relevant metadata, PR256 exact head `1830320bd93fcfa458411dcf00f130d87d607d39` and PR249 ancestry; check F5/G5 ownership, other slot DB migration path conflicts, task_id uniqueness, independent clean worktree. If PR256 HEAD changed, rebase/overwrite forbidden; report blocker.

## Mandatory P2 regression
- Before fix, independently reproduce a user-scoped budget policy with `policy_key='override.user.<full UUID>'`, `note='support ticket: jane@example.com'`; after user erasure both strings remain even when footprint counts zero. Record fail-before.
- Fix **only new PR256 migration candidate** `supabase/migrations/20261017150000_ai_ledger_user_erasure.sql` and relevant independent tests. At policy erasure update, additionally `note = NULL`, `policy_key = 'erased.' || pol.id::text` with unique collision-safe behavior, `scope_user_id` replaced, `enabled=false`. Validate constraints, exact SQL schema, actual uniqueness and non-user/system policies unaffected; don't blindly trust one-line suggestion.
- Add real UUID/email PII assertions, footprint reporting or invariant so a retained policy identifier cannot silently pass; multiple policies, retry/idempotency, concurrent erase, billing amounts/counts unchanged, attacker role remains denied, rollback and legacy tests pass.

## P3 targeted guards
- P3a: `ai_calls_forget_system_brand` count-then-delete race: add `c.state <> 'acquired'` guard to delete and test overlapping claim/forget; if a stronger atomicity guard is required document residual risk. No loss of active records.
- P3b: `ai_ledger_erase_user` inside REPEATABLE READ may report success with unseen committed reservations; fail-closed on non-READ COMMITTED or otherwise prove no stale snapshot; tests.
- P3c: PR249 rollback scripts are **separate PR249-owned files**: do not edit. Document mandatory preflight and produce a narrowly scoped follow-up for PR249 owner if embed guard is desired.
- Other reviewer note: service_role visibility of erased IDs via budget_status/usage_summary requires truthful docs; do not expand implementation.
- Do not repeat broad security review. Focused tests and ChatGPT completion assessment suffice if changes are exactly scoped and evidence strong; otherwise one new-diff-only independent review at most.

## Safety / allowed edits
Edit PR256 candidate migration and PR256-owned offline tests/docs only, in independent branch stacked on exact PR256 head; no edits to existing migration, ledger runtime, PR249, F3/F4/F5, OAuth, Edge, H5, shared provider/auth. Local isolated PostgreSQL 17 only if socket-only/TCP off and verified. No managed/prod read or write, no Secrets, paid APIs, SNS, Cron creation, deploy or merge.

## Completion
Before/after reproduction with distinct user/non-user policies, local PG privilege/parallel/ledger invariants, mutation tests, tests PASS/FAIL/NOT_VERIFIED, changed files, branch/commit/push/PR head/base read-back, blockers, follow-up owners, production NO_GO. Report to task end, status review_required, next_owner chatgpt, send L6.
## Report
- task_id: common-ai-f6-pr256-policy-pii-erasure-p2-fix-20261017
- result: **FIX_DONE（Draft PR #261、#256 の上に積んだ）。P2 を修正の前に再現 → 修正 → 同じ再現が PASS。P3a / P3b は防ぎを入れてテストで確かめた。P3c は #249 のファイルを変えず、運用の決まりと follow-up の案。ローカルの PostgreSQL だけで runner の 11 の部分すべて PASS、わざと壊した写し 37/37 を検出**
  - 変えたのは #256 の migration の候補と #256 のテスト・文書だけ。既存の migration（台帳・#249）、#249 の rollback の script、F3 / F4 / F5、認証、POSTONA、Edge、H5 bridge、共通の provider は変えていない
  - 本番・Supabase には読むだけでも接続していない。Secret・有料の呼び出し・SNS・Cron の作成・deploy・merge は 0
- 作業前の確認
  - fresh main `8cbab04b5e8a0105e82374b50f5cd50faf656608`
  - #256 の head は `1830320bd93fcfa458411dcf00f130d87d607d39` のまま（変わっていない）。#249 `e589e2c39886fde582bd31a4c25fd4f6839fac49` がその祖先であることを確認
  - task_id の重複なし。F5 は別の作業（X の saga の stand-in）で重ならない。他の slot の migration の衝突なし（開いた PR の migration の最新は #256 の `20261017150000`）
- branch / commit / PR
  - `claude/f6-pr256-policy-pii-fix-20261017`（新しい独立した worktree `/Users/yuya/Developer/kabumori-f6-pr256-fix`、#256 の head から作成）
  - commit `017c7eb7803a134e83d1f128576b62bc69b4fcb4`（push 済み、`git ls-remote` で同じ値を確認）
  - Draft PR [#261](https://github.com/anohi-memories/kabumori/pull/261)。読み返し: OPEN / Draft、base `claude/f6-ledger-user-erasure-20261017`（#256、`1830320bd93fcfa458411dcf00f130d87d607d39`）、head `017c7eb7803a134e83d1f128576b62bc69b4fcb4`、9 ファイル、MERGEABLE
- changed_files（9）
  - `supabase/migrations/20261017150000_ai_ledger_user_erasure.sql`（#256 の候補を修正）
  - `supabase/tests/ai_ledger_user_erasure_policy_pii_repro.sql`（新規、P2 の再現）
  - `supabase/tests/ai_ledger_user_erasure_behavior.sql` / `_fixture.sql` / `_run.sh` / `_mutations.sh` / `_facts.sql` / `_rollback.sql`
  - `docs/ai-provider/F6_POSTONA_LEDGER_USER_ERASURE_CANDIDATE.md`（§11 を追加）
- **P2（その人だけの枠の名前・メモに個人の情報が残る）**
  - 修正の前（#256 の head の migration）で独立に再現（`P2_REPRO_FAIL`）
    - 枠を `policy_key = 'override.user.<利用者 ID>'`、`note = 'support ticket: jane@example.com'` で作って消した
    - 結果は `{erased: true, …, budget_policies: 1}`、読み返しは**すべて 0**
    - しかし名前に ID が 1 件、メモにメールが 1 件残った（ai_ledger / ai_calls の中で 2 行）
  - 修正（scheme を確かめてから: `policy_key` の形 `^[a-z0-9][a-z0-9_.:-]{0,127}$`、一意の制約、`note` は 500 字までで空も可）
    - その人の枠の名前を `erased.<枠の id>`（43 文字、形に合う。id はランダムの主キーなので一意）に変え、メモを空にし、無効にし、主体を消した人の ID にする。時刻・期間・上限は変えない
    - その人のものでない枠の名前・メモがその人の ID（ダッシュあり・なし、大文字・小文字）を含むなら、`POLICY_TEXT_MENTIONS_USER` で断る（ほかの人・system の枠は書き換えない。運用者が直す）
    - 改名先を別の枠が使っていたら、`POLICY_KEY_CONFLICT` で断る（一意の制約の error になる前に止める）
    - 読み返し `ai_ledger_user_footprint` に `policy_mentions` を足した。消す処理の最後の確認にも同じ条件 → 残っていれば 0 にならず、成功もしない
  - 修正の後: 同じ再現が `P2_REPRO_PASS`（名前・メモにもどの表にも ID とメールが 0、読み返しは `policy_mentions` を含めて 0）
  - テスト（behaviour [11]）
    - データ: その人の枠 2 つ（ID の形 2 種、メール）、ほかの人の枠（その人自身のメール付き）、system の枠、その人の ID を大文字で含む system の枠
    - 確かめたこと:
      - 読み返しは枠 2・言及 3 を数える
      - 断る → 何も変わらない（枠・合計）
      - 運用者が直す → 消える
      - 2 つの枠が `erased.<id>`・メモなし・無効になる。時刻・期間・上限は不変
      - ほかの枠は 1 バイトも変わらない
      - 請求・予算の合計は不変
      - ID の形 4 種とメールはどこにも残らない（ほかの人のメールは残る）
      - やり直しは 0 件
      - 名前の衝突は断る → 解消すると消える
      - service_role は枠を直接変えられない（42501）
  - 並行（E1）: 個人の情報を含む枠を持つ同じ人を 20 本同時に消す → 改名は 1 回だけ、一意の制約の error は 0、ID もメールも残らない
- **P3a（forget_system_brand の「数えてから消す」の間）**
  - 消す文に `state <> 'acquired'` を足した（処理中の行は消さない）。消した後に数え直し、処理中が残れば `{forgotten: false, reason: CALLS_IN_FLIGHT, in_flight, deleted}` を返す
  - E5: superuser でない持ち主の DB で、テスト用の RLS（FORCE）で数える文を 1 秒止めた。その間に system の claim を確定させると、修正の後はその claim が残り `{forgotten: false, in_flight: 1, deleted: 1}`
  - 条件を外した写しでは `{deleted: 2, forgotten: true}`（処理中の行が消える）→ 検出
  - 最初の E5 は、数える文が処理中の行だけの索引を読んで止まらず、見逃した → 処理中の行を 1 つ置いて止まるように直して検出
  - 残る点: system の claim はこの関数の lock を取らないので、消した後に入る claim は残る（消さずに報告し、読み返しと最後の掃除で拾う）
- **P3b（REPEATABLE READ で古い snapshot のまま成功する）**
  - 修正の前で再現: REPEATABLE READ の取引で snapshot を取った後に別の接続がその人の予約を確定 → 消す処理は `{erased: true, reservations: 4}` を返したが、読み返しで予約 1 件にその人の ID が残った
  - 修正: erase / footprint / forget_system_brand は READ COMMITTED 以外なら `AI_LEDGER_ERASURE_REQUIRES_READ_COMMITTED` / `AI_CALLS_REQUIRES_READ_COMMITTED` で止まる
  - 修正の後: 同じ場面で止まり、何も消さない。REPEATABLE READ と SERIALIZABLE で 3 つとも止まることを確認（snapshot の部分）。READ COMMITTED でやり直すと、遅れた分も含めて 5 件すべて消える
- **P3c（#249 の rollback で行が消える）**
  - #249 の持ち物の `ai_consumer_call_store_rollback.sql` は変えていない
  - 運用の決まり（docs §7・§11）: rollback の前に `ai_consumer_call_store_rollback_preflight.sql` を**必ず**通す
  - #249 の持ち主への follow-up の案: rollback の script の最初に同じ確かめ（処理中の claim、24 時間より新しい行）を入れ、当てはまれば `ACS_ROLLBACK_BLOCKED` で止める。明示の変数（例 `-v force_rollback=1`）があるときだけ進める。テストは preflight と同じ 3 つの場面
- そのほか: server（service_role）から見える消した人の ID と `erased.<id>`（`ai_ledger_budget_status`、`ai_ledger_usage_summary` の `user` の切り口）を docs §5 に正直に書いた（実装は広げていない）
- tests（ローカルの PostgreSQL 17.11 だけ。`listen_addresses = ''`、Unix socket `/private/tmp/f6p2-sock`、データは作業用のフォルダ、クラスタの識別子 `7697634508730100424`）
  - 再現: P2 は修正の前 FAIL → 修正の後 PASS。P3b は修正の前に古い snapshot で「成功」して ID が 1 件残る → 修正の後は止まる
  - runner の 11 の部分: **すべて PASS**
    - isolation
    - behaviour（11 項目、新しい [11]）
    - snapshot（新しい P3b）
    - supabase の既定の権限、superuser でない持ち主
    - legacy: 台帳のテスト 18 項目、#249 の 14 項目、本物の H5 bridge の e2e 9 件
    - concurrency: E1〜E5（E5 は新しい P3a）
    - adverse 7 通り
    - rollback（変わる既存の定義はちょうど 2 つ、rollback で catalog が完全に戻る）
    - preflight、maintenance
  - わざと壊した写し: **37 killed / 0 survived**（例外の条件 7、消す RPC 10、P2 7、P3b 3、P3a 1、保存の場所の補助 6、権限 3）
  - main（`e57c2cf72fe95287ca194b2ae53adb47b5d2c52b`）と合わせた木（merge-tree `e0f675301fefa3931d8fbfd7d296803f47c89c48`、衝突なし）: この runner の 11 の部分＋ #249 の runner の 10 の部分すべて PASS、共通AI基盤＋市況レポート＋ bridge 546 PASS / 0 FAIL、invariants 11 PASS
  - `git diff --check` OK、秘密情報の文字列 0（テストのメールは `example.com`）
  - NOT_RUN: Supabase の本物の環境、PostgREST（本物）、`_shared` 全体の既知の型エラー 5 件・権限で止まる 1 件
  - 後片付け: ローカルのクラスタを止め、データ・socket・合わせた木を削除
- collision: 新しく変えたファイルに触れる開いた PR は #256 だけ（土台、開いた PR 122 本を確認）。読み返し（すべて OPEN / Draft、head は変わっていない）: #256 `1830320bd93fcfa458411dcf00f130d87d607d39`、#249 `e589e2c39886fde582bd31a4c25fd4f6839fac49`、#241 `84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6`、#239 `f590b80fbbaa926be08d5e215ad87b373f402ff2`、#198 `4223d5c01389474406291c8e4578207e317638b9`、#187 `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b`
- remaining_issues / follow-up
  - #249 の持ち主: rollback の script の中に preflight を入れるか（上の案）
  - 運用の決まり: 枠のメモに利用者の連絡先などを書かない（消す処理はほかの枠のメモではその人の ID しか探せない）
  - F5 / G5: 読み返しは `policy_mentions` を含めて 0 を確かめる。`POLICY_TEXT_MENTIONS_USER` / `POLICY_KEY_CONFLICT` は運用者に回す。SQL から呼ぶときは READ COMMITTED で（docs §6）
  - #256 の残り（変わらず）: 法的・保持の判断、F5 / G5 の組み込み、POSTONA の入口での利用権の確認、本番の適用の承認、Supabase のバックアップ・記録の保持（NOT_VERIFIED）
- production: **NO_GO**
- review: 変えたのは指摘の 3 点だけで、どれもテストで確かめた（修正の前後の再現、37/37）。TASK のとおり、広いレビューの繰り返しはしない。要るなら新しい差分だけの独立のレビュー 1 回
- next_owner: chatgpt
- recommended_model: 差分だけのレビューをするなら Opus 5.5（高）または Sol（高）

## L6 decision 2026-10-17
- verdict: PASS_SOURCE_FIX / MERGE_HOLD / PRODUCTION_NO_GO.
- verified Draft PR261 OPEN/unmerged HEAD `017c7eb7803a134e83d1f128576b62bc69b4fcb4`, stacked on PR256, 9 changed files. Source-only.
- implementer-reported P2 fail-before/pass-after, local-PG 11 stages PASS, mutation 37/37, combined 546 PASS; ChatGPT did not independently run tests. Existing shared type errors 5 and permission-blocked test 1, managed/production NOT_VERIFIED.
- reviewer P2 policy_key/note PII addressed; P3a active call deletion and P3b stale snapshot guarded. P3c PR249 rollback preflight embedding remains follow-up to owner; source accepted without broad review loop.
- production blockers: F5/G5 account deletion integration, POSTONA entry entitlement checks, retention/privacy approvals, managed Supabase validation, maintenance scheduling, explicit DB/deploy approvals. No merge/deploy/paid API/production execution performed.
