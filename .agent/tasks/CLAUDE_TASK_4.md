# K4 FINAL — POSTONA Threads Phase2b isolated contract PASS / PR118 merged — 2026-10-10

- task_id: postona-threads-phase2b-source-preparation-20261010
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- verdict: **PASS (source-only, no runtime connection)** — independently inspected PR118 scope and static prerequisite gate; accepted G4 reported tests.
- accepted_pr: 118
- exact_accepted_head: 9b71757068271cce38cedda12f6d74e705ac13ca
- source_merge: **squash merged** as b49306c0d7486adb9afdb9ae4e42defa33ace07f
- files: `supabase/functions/_shared/social/threads_connect_contract.ts`, `supabase/functions/_shared/social/threads_connect_contract_test.ts`, `docs/postona/threads-connection-phase2b.md`
- reported_tests: contract 14 PASS; 19/19 mutation detects; shared 503 PASS; X OAuth 29 PASS; deno check/lint/diff PASS; reviewers did not independently rerun these suites.
- GitHub check statuses: Netlify SUCCESS, Vercel SUCCESS at accepted head.
- independent_Codex_review: **omitted intentionally** while module remains unimported and `THREADS_CONNECT_PREREQUISITES_MET=false`. Review once at real Auth/DB/RPC/Vault and runtime wiring boundary, not repeated PR106 review.
- outstanding_blockers: G5 T13 same-transaction writer fence and T9 workspace / T10 provider-aware deletion contracts; production Phase2a2 migration not applied; Meta app, exact HTTPS redirect and callbacks not configured; Threads is not connected or enabled.
- security: no production migration/DB/Auth/Vault/token/API/deploy; PR118 source merge only. G3/G5 existing work preserved.
- AI Lab diary: 記録不要 — 2026-10-10の日記は別のAI相談改善が正本に登録済み。独立したThreads接続準備を同一event_idへ混在させない。
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- completion_code: K4
- next_recommendation: Coordinate G5 T13/T9/T10 and Meta app setup; after contracts are agreed, create new isolated G4 task for provider-aware begin/complete RPC design/implementation with disposable-DB proofs and one consolidated Codex security review before live wiring.

---

# Claude Task 4 — CURRENT TASK

- task_id: postona-threads-phase2b-source-preparation-20261010
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- type: source-only Threads OAuth Phase 2b implementation preparation, security bounded
- completion_code: K4
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Context
PR #106 / Phase 2a-2 passed final independent H1 review and was merged to main as 68aaf3e547c09d54bd9682d357a12743d0ded7f2. The source migration is **NOT applied to production**. Never treat source merge as a production schema change. Preserve the G4 old task and Report below.

## Objective
Advance Threads account connection Phase 2b using docs/postona/threads-connection-phase2b.md, beginning with fresh official Meta Threads API verification and bounded source-only implementation that remains disabled until all prerequisites pass. Do not enable user-facing connection, send posts, write live tokens, or change production.

## Mandatory first actions
1. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/ACTIVE_TASK.md, .agent/CURRENT_STATE.md, this TASK, existing G4 Report, the Phase 1 and Phase 2b docs.
2. Confirm your own clean independent G4 worktree, fresh origin/main including merge 68aaf3e, and actual G3/G5/H1/H2 changes and overlapping Auth/OAuth/Vault/migration boundaries.
3. Verify current official Threads OAuth API endpoints, permissions, app review, callback URI capabilities, token exchange/lifetime, revocation, and disconnect callback contract. Flag unresolved items explicitly; fail closed rather than guessing.
4. Before modifying an overlapping G5-owned Auth, entitlement, account deletion, OAuth, Vault, RLS or RPC boundary, STOP and report the exact contract/owner conflict. Do not modify G5-owned files in this TASK.

## Source scope
- Confirm the safest implementation slice for Threads begin/callback/complete with state binding, replay prevention, verified provider identity, owner-only writes, Vault reference-only storage, and publish_enabled=false.
- Only implement independently isolated files/contracts/tests if official contract and ownership are established and no G5 conflict exists. Unresolved Meta app credentials/redirect or database baseline must keep implementation behind inactive guards.
- Existing X posting, refresh, OAuth, workspace/persona, and POSTONA AI consultation must remain unchanged.
- Do not silently apply Phase 2a-2 migration to production, start Threads publishing, or open provider connections with real tokens.
- If the safe slice is only design/spec/test scaffolding, deliver that rather than bypassing open constraints.

## Verification
- Focused unit/contract regression for source edits, X provider regressions, malformed or reused state, workspace/auth mismatch, unknown provider identity, vault/ref safety, and explicit publish-disabled behavior.
- Run relevant Deno/type/lint/diff checks and secret scans; identify preexisting failures separately.
- Fresh PR/main overlap check before any push. Use an independent G4 branch and PR; do not merge or deploy.
- No real Meta/Supabase production API calls, DB migration apply, scheduler, OAuth secret writes or account lifecycle changes.

## Completion
- Update the Report for this task with task_id, result, changed_files, tests, commit_hash, push, PR/head, deploy, remaining_issues, safety_checks and next_recommendation.
- Set status review_required / next_owner chatgpt and STOP for K4. Identify precisely which portions require an independent security review (do not request a repeat full PR106 review).
- Return to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**, completion code **K4**.

## Report — postona-threads-phase2b-source-preparation-20261010 (2026-10-10)

- task_id: postona-threads-phase2b-source-preparation-20261010
- result: **PASS（source の準備のみ・配線なし・無効のまま）**
  - 公式契約を再確認した。
  - プロバイダ側の契約モジュールとテストを追加した。
  - 設計メモを更新した。
  - **DB の begin / complete の RPC と migration は、G5 の境界に重なるため作らず、契約の不足として報告する**（下の「G5 との境界」）。
- model_used: Opus 5.5（TASK の推奨どおり）
- workspace: `kabumori-fresh` から新しく作った G4 専用 worktree `/Users/yuya/Developer/kabumori-g4-phase2b`（branch `claude/g4-postona-threads-phase2b-prep-20261010`）。
  - 開始時の main は `75d724ab`（PR106 の merge `68aaf3e5` を含む）。push 前に最新の main `e46170d1` へ rebase した。
- PR / head: [#118](https://github.com/anohi-memories/kabumori/pull/118)、head `9b717570`、未 merge。
- commit_hash: `9b717570`（1 commit）
- push: 新しいブランチへの通常の push。force push はしていない。
- deploy: **0**

### changed_files（3つ）
- `supabase/functions/_shared/social/threads_connect_contract.ts`（新規）
- `supabase/functions/_shared/social/threads_connect_contract_test.ts`（新規）
- `docs/postona/threads-connection-phase2b.md`（§0.6〜§0.8 を追加、§11 を更新）

### 公式契約の再確認（2026-10-10、読み取りだけ）
- エンドポイント:
  - 認可: `https://threads.com/oauth/authorize`
  - 短期トークン: `POST https://graph.threads.com/oauth/access_token`
  - 長期トークン: `GET https://graph.threads.net/access_token`（`th_exchange_token`）
  - 延長: `refresh_access_token`（`th_refresh_token`）
  - 本人情報: `GET https://graph.threads.net/v1.0/me`
  - ホスト名の混在（T3）は公式でも続いているので、文書どおりに固定した。
- 権限: `threads_basic` が必須。`threads_content_publish` は投稿用。
- code は1時間有効で、1回限り。戻り先に `#_` が付く。拒否は `error=access_denied`。
- **新たに分かった危険**:
  - 短期トークンの応答の `user_id` は、2^53 を超える JSON の数値。数値として読むと別人の id に丸められうる。モジュールで対応した。
  - `token_type` は 2026-08-12 から返る。
  - `debug_token` は Threads のテスターのトークンが必要で、本番の本人確認には使えない。
- 未解決のまま:
  - T1: カスタムスキームの記載なし。https 以外は拒否する。
  - T4: PKCE の記載なし。使わない前提。2a-1 の `ConnectAdapter` は PKCE の引数を前提にしているので、配線時に任意にする必要がある。
  - T5: ユーザートークンの revoke の記載なし。
  - T6: Meta 共通の `signed_request` の形式は確認できた。Threads 固有の形は未確認。
  - T7: 延長でトークンが変わるかの記載なし。

### 実装した範囲（安全に切り出せた部分だけ）
- `threads_connect_contract.ts` は、外部への通信を差し替えられる純粋なモジュール。
  - 認可 URL、コールバックの解析、2つのトークン交換、本人情報の読み取りと照合（`THREADS_IDENTITY_MISMATCH`）。
  - 1回だけ送り、code では再試行しない。リダイレクトは追わない。10秒で打ち切る。
  - エラーは固定コードだけ。
  - JSON の数値は元の文字列のまま読む。
  - 短期トークンは戻り値に含めない。
- **静的なゲート** `THREADS_CONNECT_PREREQUISITES_MET = false`。環境変数だけでは有効にならない。前提は5つ:
  1. 2a-2 の本番適用
  2. G5 の書き込み fence
  3. RPC のレビュー
  4. 退会のプロバイダ別対応
  5. Meta アプリの設定
- このモジュールを読み込むものは 0 件で、テストで固定した。import は provider-domain の型だけ。
- Edge Function、RPC、migration、Vault、Auth、アプリ、X のコードは変えていない。

### G5 との境界（TASK の「重なる前に止めて報告」）
- **重なっている箇所**:
  - Threads の行は、G5 の `private.account_lifecycle_footprint` が数える POSTONA（`x_autopost`）の足跡になる。
  - G5 は、足跡を作る書き込み経路に利用権の fence をかける作業を、PR112 の時点で未解決の release blocker として持っている。
  - Threads の begin / complete の RPC を今作ると、fence のない書き込み経路が増える。
- **G5 に必要な契約**（T13）: 足跡を作る書き込みの前に、同じトランザクションで呼ぶ判定。内容は、利用権が有効か、ライフサイクルが削除中・終了でないか、削除とのロックによる直列化。名前・引数・ロック順・拒否コードは G5 が決める。
- あわせて決める必要があるもの:
  - T9: Threads だけを使う人のワークスペースを誰が作るか
  - T10: 退会で Threads の行をどう処理するか
- RPC の仕様と、必要な使い捨て DB テストの一覧は、設計メモ §0.8 に書いた。

### tests
- 新しい契約テスト: **14件 PASS**（型チェックあり）。内訳:
  - 公式の値に固定していること
  - 静的なゲート（環境変数をすべて揃えても無効のまま）
  - 無効のときは通信しないこと
  - 環境変数の検査（secret を出さない）
  - redirect が https で完全一致であること（http、カスタムスキーム、フラグメント、認証情報付き、ワイルドカードは拒否）
  - 認可 URL の引数がちょうど文書どおりで、secret を含まないこと
  - state の形とハッシュ
  - コールバックの13通り（`#_`、拒否、state なし・不正、code なし・不正、重複）
  - 短期トークンの交換: 要求の形、奇数の大きい id がそのまま残ること、4xx・5xx・302・通信失敗・非 JSON・トークンを含むフォーム本文・token_type の欠落と相違・id の欠落、数字以外、負数、指数表記。すべて1回だけ送ることを確認
  - 長期トークンの交換: 要求の形、有効期限の上限、文字列の期限を拒否、4xx・5xx・通信失敗
  - 本人情報: 要求の形、大きい id、username の形、4xx・5xx
  - 全体の流れ: 成功、丸めた id は別人として拒否、途中で止まる
  - エラーコードの閉集合
  - 誰も読み込んでいないこと
- 変異テスト（作業用スクリプト、コミットはしていない）: 安全上の要所を壊す **19件をすべて検出**。対照の実行は PASS。対象は次のとおり:
  - ゲートを開ける、本人の不一致を受け入れる、id を数値で読む
  - `#_` を残す、http やカスタムスキームを許す
  - token_type や期限を確認しない、文字列の期限を受け入れる
  - state を確認しない、重複を許す
  - 4xx を再試行扱いにする、リダイレクトを追う
  - URL に secret を入れる、無効なのに通信する
  - 本文をエラーに含める、短期トークンを返す
  - 環境変数だけでゲートを開ける
  - 途中で検出できなかった3件は、冗長なコードを1か所削り、テストを1件足して解消した。
- 既存の回帰テスト（rebase 後）:
  - `_shared/social` 27件、`_shared` 全体 **503件**、`x-oauth-connect-user` **29件**、すべて PASS
  - rebase 前の main では、`_shared` で AI Lab の日記スナップショットのテストが1件失敗していた。これは既存の失敗で、今回のファイルとは無関係。新しい main で解消している。
- `deno check`、`deno lint`（`_shared/social`）が PASS。`git diff --check` は問題なし。
  - `deno fmt` はリポジトリの既存ファイルも揃っていないため、適用していない。

### safety_checks
- 本番の DB・Auth・Storage・Vault・OAuth の読み書き、migration の適用、Edge の deploy、secrets の設定、Meta / Supabase の本番 API 呼び出し、実トークンの扱い: すべて **0**。
- 公式ドキュメントの取得は、Markdown 版の読み取りだけ。
- 秘密情報のパターン: 0（`url.password` の比較が1件ひっかかったが、誤検知）。テスト内の値はすべて偽物。
- 作業中の PR（#117、#116、#115、#112、#110、#33、#11、#10、#3）とのファイルの重なりは 0。最新の main との merge-tree は競合なし。
- G2 / G3 / G5 のファイルは変えていない。X の送信・refresh・OAuth、ワークスペース・ペルソナ、POSTONA の AI 相談は変えていない。

### 独立したセキュリティレビューが必要な部分（PR106 の全体の再レビューは不要）
1. `threads_connect_contract.ts` の次の点:
   - 大きい id を元の文字列で読む処理（reviver）
   - 本人の照合
   - code を再試行しないことと、エラーの分類（拒否・不明・不正）
   - エラーやログにトークン・secret が出ないこと
   - redirect URI の検査
   - 静的なゲートが環境変数で開かないこと
2. 設計メモ §0.8 の RPC 仕様（実装前の設計として）:
   - state を消費する条件（本人、未使用、期限内、`platform='threads'`）
   - G5 の判定を呼ぶ位置
   - 2a-2 のガードとの関係（所有者が持つ SECURITY DEFINER 関数だけが Meta 行を書けること）
- RPC を実装したら、その migration と使い捨て DB のテストは、改めて独立レビューの対象になる。

### remaining_issues
- G5 の契約（T13）と、T9 / T10 の合意。
- Meta アプリの登録（ユーザー）と、T1（カスタムスキーム）/ T2（リダイレクトの受け方）の決定。テスターで T3 / T5 / T6 / T7 を確認すること。
- 2a-2 の本番適用（同日の読み取り専用 preflight と承認が必要）。
- 2a-1 の `ConnectAdapter` で、PKCE の引数を任意にすること（配線時）。
- 有効期限の保存（T8、2c）。

### next_recommendation
1. K4 で確認する。必要に応じて、上の「独立したセキュリティレビューが必要な部分」に絞ったレビューを1回行う。
2. G5 の部屋に T13 / T9 / T10 の契約を依頼する（G5 の優先度は、競合がある箇所に限ったもの）。
3. 並行して、ユーザーが Meta アプリを登録し（テスター）、redirect を決める。
4. 契約が揃ったら、G4 で begin / complete の RPC の migration 候補を作り、使い捨て DB で証明する。その後に本番の preflight を行う。
- status: review_required / next_owner: chatgpt。STOP for K4。返却先: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**、完了コード **K4**。

---

# Previous G4 task — final C1 disposition (preserved)
- task_id: postona-multisocial-phase2a2-security-corrective-20261007
- final_verdict: PASS (independent H1 exact c0b6c03cb909d91f72b58424d64c6dfae1b8f14f)
- source_merge: PR #106 merged 68aaf3e547c09d54bd9682d357a12743d0ded7f2
- production_migration_apply: NOT PERFORMED / NOT AUTHORIZED
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ

---

# Claude Task 4 — CURRENT TASK

- task_id: postona-multisocial-phase2a2-security-corrective-20261007
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: codex
- priority: highest
- recommended_model: Opus5.5（高）
- type: bounded DB/security corrective / existing PR #106
- target_pr: 106
- reviewed_head: dac01220ca600cc003b3dafa4b30a84340b29850
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## C1 corrective — final ACL exactness + mechanical main integration — 2026-10-08

H1 exact-head rereview of `4b6dc57966e0d55b2e901a7707446c35b25a1f00` returned **CHANGES REQUIRED** with one narrow contract gap plus one mechanical integration conflict.

Preserve every accepted B1-B6 fix and the accepted C1-R1/C1-R2 security design. Update the existing PR #106 only.

### F1 — positively require the exact owner EXECUTE ACL

Current code rejects bad ACL entries but accepts the underprivileged state where the owning role's explicit EXECUTE entry is absent (`proacl={}`).

Required:
- for each existing trigger function:
  - `public.x_account_refresh_reset_on_reconnect()`
  - `public.social_mobile_account_deletion_guard()`
- require the direct normalized ACL to be **exactly**:
  - one EXECUTE entry for the approved owner/grantor;
  - not grantable;
  - no other grantee/privilege/grant option.
- keep all existing effective EXECUTE / membership / SET ROLE protections.
- do not GRANT, REVOKE, reassign owner, or repair drift automatically.
- empty owner ACL must fail before DDL with a stable precondition error and leave the original X-only state unchanged.

Required test:
- revoke the owner's own EXECUTE entry so the function has an empty explicit ACL;
- migration must refuse atomically for each of the two trigger functions;
- healthy exact owner-only ACL must still pass.

### F2 — resolve the reservation-file integration conflict mechanically

Fresh main and PR #106 both changed:
- `supabase/tests/migration_source_invariants_test.ts`

The desired final content is current main **plus exactly**:
- `"20261007150000": "postona_social_accounts_multi_provider"`

while preserving:
- `"20261007173000": "ai_lab_topic_evergreen_capacity"`
- every other current-main reservation/invariant unchanged.

Required:
1. fresh-fetch current `origin/main`;
2. integrate/merge current main into the existing PR branch normally (no force push);
3. resolve this one file mechanically;
4. verify the resulting file equals fresh main except for the single POSTONA reservation line;
5. verify PR merge-tree/GitHub becomes conflict-free;
6. rerun migration invariants.

Do not alter accepted migration/test/docs semantics merely to resolve the conflict.

### Bounded verification

At minimum:
- focused empty-owner-ACL adverse test for both functions;
- healthy owner-only ACL control;
- existing C1-R1/R2 focused tests;
- migration runner;
- mutation suite;
- X publish / refresh / deletion / Stage3B regressions;
- migration source invariants;
- `git diff --check`;
- secret scan;
- fresh-main changed-file overlap / mergeability check.

If the source change is exactly the positive ACL assertion + fixture/mutation coverage and the rest is mechanical main integration, no broad architecture retest is needed beyond preserving the existing green suites.

### Scope / safety

Allowed:
- existing PR #106 migration/test files;
- migration reservation invariant file;
- existing design note only if a wording update is strictly required.

Forbidden:
- production DB/catalog read/write;
- migration apply;
- deploy;
- Auth/OAuth/Vault/secrets;
- real provider calls;
- G2/G3/G5 product files;
- PR merge.

### Completion

Update existing PR #106 and report:
- new exact head;
- exact ACL assertion added;
- empty-owner-ACL tests for both trigger functions;
- reservation file parity with fresh main;
- mergeability / merge-tree result;
- relevant tests and mutation count;
- exact changed files;
- production/deploy/provider operations = 0.

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K4.

After K4, use a genuinely free H1/H2 for one final exact-head focused rereview if available.

推薦モデル：**Opus5.5（高）**

## C1 corrective — function-contract hardening round — 2026-10-07

H1 exact-head rereview of `a8f313dc72b087ab86482781297848fe6e23bdcc` returned **CHANGES REQUIRED** with two remaining blockers only.

Preserve every previously accepted B1-B6 correction and existing regression behavior. Update the existing PR #106 only.

### C1-R1 — pin owner/ACL of the two existing trigger functions

The precondition currently hard-codes trigger definition/language/SECURITY DEFINER/search_path/body hash but does not fully pin the trigger functions' owner and ACL contract.

Required:
- derive the exact approved owner/ACL contract from repository migrations/fixtures and prior read-only production evidence;
- before any DDL, require each existing trigger function to have the approved:
  - function identity/signature;
  - owner;
  - SECURITY DEFINER state;
  - language;
  - search_path/config;
  - body identity;
  - direct ACL / grant-option state;
  - no unsafe effective EXECUTE path from PUBLIC/anon/authenticated through membership or SET ROLE.
- unknown owner/ACL drift must STOP; do not repair/revoke/reassign.
- extend the before/after state snapshot so these function security properties cannot change during the migration.

Required adverse tests:
- wrong owner;
- PUBLIC EXECUTE;
- authenticated/anon direct EXECUTE;
- grant option;
- inherited EXECUTE;
- PG16+ SET-only/transitive reachability to an EXECUTE-bearing role if relevant;
- body/definition controls remain the previously accepted expected values.
- every failure must leave the original X-only state and no new guard/helper residue.

### C1-R2 — pin the new guard's exact body/definition

The postcondition currently verifies metadata for `public.social_accounts_provider_guard()` but not its body.

Required:
- postcondition must verify the exact reviewed guard implementation, not merely owner/security/search_path/language/ACL;
- use a stable canonical definition/body identity that catches semantic changes while remaining deterministic in the target PostgreSQL version;
- also pin return type/signature and relevant function properties;
- a body-only mutation preserving all metadata must fail the postcondition atomically.

Required tests:
- mutate only the guard body to:
  - allow provider relabeling;
  - skip Meta service_role protection;
  - return NEW without guards;
- keep owner/ACL/security/search_path/language unchanged;
- each mutant must be detected;
- unchanged reviewed function must pass.

### Regression / scope

Rerun:
- the focused migration runner;
- all existing B1-B6 adverse cases;
- mutation suite, with new mutations added;
- X publish / refresh / deletion / PR41 Stage3B regressions;
- `git diff --check`;
- secret scan.

Do not reopen accepted product architecture without concrete evidence.

Forbidden:
- production DB/catalog access;
- migration apply;
- deploy;
- Auth/OAuth/Vault/secrets;
- real provider calls;
- G2/G3/G5 files;
- PR merge.

Completion:
- update existing PR #106;
- report new exact head;
- C1-R1/R2 disposition;
- new adverse/mutation evidence;
- changed files;
- fresh-main overlap;
- CI;
- production/deploy/provider operations = 0;
- status -> `review_required`;
- next_owner -> `chatgpt`;
- STOP for K4.

After K4, use a genuinely free H1/H2 slot for one focused exact-head rereview.

推薦モデル：**Opus5.5（高）**


## Review verdict

Independent focused review of PR #106 returned **CHANGES REQUIRED**.

Do not merge or apply the reviewed head.

The existing healthy disposable-PG runner, 26/26 mutation suite, X publish/refresh/deletion regressions and PR41 Stage3B regressions passed, but independent adversarial PostgreSQL probes found six blocking gaps.

Update the **existing PR #106** only. Do not open a replacement PR unless technically unavoidable and reported first.

## Mandatory startup / isolation

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/ACTIVE_TASK.md`
   - `.agent/CURRENT_STATE.md`
   - this G4 TASK
   - the existing PR #106 diff/tests/docs.
2. Fresh-fetch `origin/main` from `/Users/yuya/Developer/kabumori-fresh`.
3. Use the existing isolated G4 Phase 2a-2 worktree only if it is still clean/safe; otherwise create a new independent G4 worktree.
4. Require PR #106 to still contain reviewed head `dac01220ca600cc003b3dafa4b30a84340b29850` in its history before editing.
5. Fresh-check current G3/G5/open-PR file ownership.
6. Do not touch G3 AI Lab continuity files or G5 native common-account/Auth files.
7. Production DB read/write/apply/deploy/Auth/OAuth/Vault/provider operations remain forbidden.

## Accepted review evidence — preserve

Do not weaken these accepted areas unless a concrete correction requires it:

- existing source-only scope;
- no runtime Threads/Instagram wiring;
- no plaintext token value storage by intended schema;
- explicit transaction + bounded lock wait;
- atomic rollback on ordinary failure;
- existing X publish/refresh/delete and PR41 Stage3B regressions;
- healthy-fixture canonical provider rejection;
- Meta `publish_enabled=true` rejection while platform remains Meta;
- existing local disposable PostgreSQL harness and mutation testing.

## Blocking finding B1 — provider identity uniqueness precondition

Problem:
- candidate validates `UNIQUE (brand_id, platform)` but not the existing identity uniqueness contract;
- missing or X-only-drifted `(platform, platform_user_id)` uniqueness lets the same Threads identity appear in multiple workspaces.

Required correction:
- before any DDL, fail closed unless the expected provider-identity unique index/constraint exists with approved semantics;
- validate at minimum:
  - unique;
  - valid and ready;
  - exact key columns `platform, platform_user_id`;
  - no expression key;
  - approved collation/opclass semantics;
  - predicate covers **all canonical providers whenever platform_user_id is non-null**;
  - accepted current partial predicate `platform_user_id IS NOT NULL` or an explicitly justified semantic equivalent.
- do not create/repair/deduplicate an unknown starting identity index automatically.

Required adverse fixtures:
- missing index;
- X-only predicate;
- wider/wrong key;
- expression index;
- invalid/not-ready;
- wrong predicate;
- each must refuse atomically before replacing the old platform CHECK.

## Blocking finding B2 — provider identity must be immutable

Problem:
- a verified X row can be updated to Threads if refresh ref is cleared and publish is disabled in the same statement.

Required correction:
- add a provider-identity immutability guard so `NEW.platform IS DISTINCT FROM OLD.platform` is rejected for all provider pairs and all connection states;
- simultaneous credential/flag edits must not bypass it;
- preserve ordinary X publish/refresh/delete operations that do not relabel provider;
- provider change must require a separately reviewed disconnect/new-row flow.

Implementation may use a trigger/helper as appropriate, but:
- no generic privilege widening;
- explicit owner/search_path/ACL contract;
- include full trigger definition in postcondition verification.

Required tests:
- X -> Threads / Instagram, Meta -> X, Threads <-> Instagram;
- with/without refresh;
- with simultaneous access/ref/status/publish edits;
- all refused.

## Blocking finding B3 — SET ROLE reachability

Problem:
- `pg_has_role(..., 'usage')` misses PG16+ memberships with INHERIT=false / SET=true;
- authenticated may still SET ROLE into service_role/write-bearing authority.

Required correction:
- inspect both inheritance/effective privilege and SET ROLE reachability;
- include direct + transitive membership paths;
- cover owner, service_role and any write-bearing role reachable from anon/authenticated;
- include column-only write privileges;
- refuse unknown unsafe membership graphs; do not revoke or normalize them.

Required adversarial fixtures:
- authenticated -> service_role with INHERIT FALSE, SET TRUE;
- anon equivalent;
- transitive SET-only chain;
- SET path to owner;
- SET path to a role with only column UPDATE/INSERT.

Use PG16+/PG17 membership semantics explicitly and keep compatibility documented.

## Blocking finding B4 — approved starting schema/security baseline

Problem:
- current snapshot proves before/after equality but accepts unknown starting drift as baseline;
- independent probes accepted a plaintext-like credential column, unknown trigger, extra CHECK/index and unexpected SELECT grant.

Required correction:
- migration must fail closed against an explicit reviewed starting contract **before DDL**;
- inventory and validate the complete expected shape needed for this migration:
  - all expected columns (names/types/nullability/defaults);
  - no unknown credential/token/plaintext-secret-shaped columns;
  - expected constraints;
  - expected indexes, including validity/readiness/predicates;
  - expected policies including permissive/restrictive mode;
  - expected non-internal triggers using full trigger identity/definition;
  - table and column ACL baseline;
  - role graph.
- unknown columns/constraints/indexes/policies/triggers/ACL widening must stop; do not drop or normalize unknown objects.
- if repository evidence is insufficient for a specific production baseline, STOP and report the exact missing catalog facts rather than inventing them.

Add adverse fixtures for:
- plaintext credential-shaped column;
- arbitrary unknown column;
- unknown CHECK/index/trigger/policy;
- PUBLIC/role SELECT or other unexpected ACL;
- column ACL drift;
- restrictive/permissive policy mode drift;
- trigger event/function-definition drift.

## Blocking finding B5 — connected Meta access credential

Problem:
- connected/identity_verified Threads or Instagram row can exist with both credential refs null.

Required correction:
- confirm exact current `connection_status` contract from source/fixtures;
- for Meta providers:
  - refresh ref must always be null;
  - connected / identity_verified state must require non-null access ref;
  - explicit pre-connect/disconnected states may have no access ref when consistent with the current status contract.
- preserve current X DB acceptance; do not move X runtime credential rules into this task unless necessary.

Add full matrix:
- Threads + Instagram;
- each allowed status;
- access present/absent;
- refresh present/absent;
- expected PASS/REFUSE.

## Blocking finding B6 — existing service_role authority over Meta rows

Problem:
- existing service_role table DML authority automatically expands from X-only rows to new Meta rows when platform CHECK widens;
- source-only preparation must not silently widen backend authority.

Required design decision for this corrective:
- **do not approve broad service_role Meta writes by default**;
- preserve existing X behavior;
- add a provider-aware DB boundary that prevents direct service_role creation/modification of Meta provider rows until the later reviewed Threads connection path exists;
- future narrow Threads connection code must be able to use a separately reviewed privileged path without reopening broad table DML to clients.

Preferred safe shape:
- provider-aware trigger/guard that blocks direct service_role Meta INSERT/UPDATE while allowing existing X DML;
- future narrow SECURITY DEFINER connection function may be allowed only through a separately reviewed owner/ACL path;
- audit existing SECURITY DEFINER functions touching `social_accounts` and prove none can be abused as a generic Meta writer.

Do not globally revoke service_role rights if existing X runtime relies on them.
Do not modify current X runtime files in this corrective unless absolutely necessary and conflict-free.

Required proofs:
- direct service_role Threads/Instagram INSERT refused;
- direct service_role Meta UPDATE refused;
- service_role X operations used by existing regressions remain PASS;
- authenticated/anon remain unable to write;
- no existing generic SECURITY DEFINER route can create/relabel Meta rows.

## Defensive findings to close while in this migration

Also harden the postcondition snapshot:
- include policy `polpermissive`;
- include full `pg_get_triggerdef` / trigger function identity where appropriate;
- include index validity/readiness;
- compare exact approved expressions of the three new CHECK constraints at postcondition;
- retain full role/ACL contract in postcondition.

Document:
- ACCESS EXCLUSIVE wait is bounded by `lock_timeout`, but total migration runtime is not;
- future production gate needs an approved overall statement/session timeout/cancel plan.

## Production owner/apply-role assumption

The reviewed non-superuser-owner assumption is plausible but **not production-proven**.

Do not weaken the owner guard.

For this source corrective:
- keep the migration fail-closed if current_user is not the exact approved owner/non-superuser;
- document the exact facts that a future same-day read-only production preflight must verify:
  - table owner;
  - current_user/session_user through chosen apply tool;
  - role membership options;
  - ACL/column ACL/index/constraint/trigger/policy baseline;
  - wrapper transaction behavior.

No production preflight is authorized in this task.

## Tests / evidence required

At minimum:

1. rerun original healthy runner;
2. rerun original 26 mutation suite;
3. convert all six independent review blockers into permanent repo tests;
4. add the defensive policy/trigger snapshot tests;
5. rerun existing X publish permission;
6. rerun X refresh pilot/authority;
7. rerun account deletion;
8. rerun PR41 publish-settings reader/Stage3B boundary;
9. prove failed preconditions leave the original X-only platform CHECK and no new object/partial state;
10. prove the new provider-immutability/provider-write guard itself cannot be bypassed by simultaneous updates.

Prefer mutation tests for the new guards so each protection is demonstrated to detect breakage.

## Migration reservation

The candidate version remains `20261007150000`.

Fresh-check all main/open-PR migration filenames before push.

If `supabase/tests/migration_source_invariants_test.ts` is free from active workstream ownership at that time, add the reservation:
- `20261007150000: postona_social_accounts_multi_provider`

If not free, leave it untouched and report the dependency for K4.

## Scope / safety

Allowed:
- existing PR #106 migration/tests/design-doc files;
- additional task-local migration security tests;
- reservation map only if fresh ownership check says safe.

Forbidden:
- production DB access/apply;
- Edge deploy;
- real provider API;
- Meta app/OAuth/Vault/secret changes;
- G3/G5 workstream files;
- unrelated runtime refactor;
- PR merge.

## Completion

Update the existing PR #106 and report:
- new exact head;
- B1-B6 disposition;
- exact provider-write authority design;
- schema/ACL baseline enforced;
- all new adverse PostgreSQL evidence;
- X regressions;
- migration reservation status;
- changed files;
- fresh-main overlap;
- CI;
- production/deploy/provider mutations = 0;
- remaining production-only facts.

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K4.

After K4 accepts a corrected candidate, ChatGPT should use a truly free H1/H2 slot for one focused exact-head rereview whenever available.

推薦モデル：**Opus5.5（高）**

## K4 decision — corrected PR #106 PASS_CANDIDATE / H1 rereview assigned — 2026-10-07

- verdict: **PASS_CANDIDATE / merge HOLD**.
- exact corrected head: `a8f313dc72b087ab86482781297848fe6e23bdcc`.
- PR #106 remains open/unmerged with exactly 6 changed files.
- CI: Netlify PASS / Vercel PASS.
- fresh-main overlap: 0 across the six PR files; main-only advancement since merge-base is control-file work.
- G4 reports B1-B6 corrected with expanded disposable PostgreSQL evidence, 73 adverse start states, 21 postcondition drift cases, 45/45 mutation detection, B5 60-case matrix and B2 64-case matrix.
- production DB/apply/deploy/Auth/OAuth/Vault/provider calls: 0.
- because this remains a DB/ACL/credential/provider-authority boundary, one focused exact-head independent rereview is mandatory before merge.
- H1 was verified done/free and is now assigned:
  - task: `postona-pr106-phase2a2-security-rereview-20261007`;
  - exact target: `a8f313dc72b087ab86482781297848fe6e23bdcc`;
  - recommended model: **Sol（高）**.
- H2 remains free and untouched.
- no production preflight/apply is authorized by this K4.
- next_owner: codex / H1.

## Report — postona-multisocial-phase2a2-security-corrective-20261007 (2026-10-07)

- task_id: postona-multisocial-phase2a2-security-corrective-20261007
- result: **B1〜B6 と防御的な追加項目をすべて修正し、既存の PR [#106](https://github.com/anohi-memories/kabumori/pull/106) を更新した（source のみ・本番適用なし）**。
  - 新しい head は `a8f313dc`（修正 `87280dde` ＋ main の merge）。レビューを受けた head `dac01220` は履歴に残っている（force push はしていない）。未 merge（merge_allowed=false）。
- model_used: Opus 5.5（TASK の推奨どおり）
- fresh main:
  - 開始時の main は `5e31b346`。
  - PR のブランチには、最新の main `55193e92` を通常の merge で取り込んだ。
  - 取り込んだ変更（G1 のポートフォリオ、G2 の PR101、AI モデルの登録表、.agent）は、このタスクのファイルや、テストで使う migration の連鎖と重ならない。
- workspace: 既存の G4 専用 worktree `/Users/yuya/Developer/kabumori-g4-phase2a2`（作業前に clean であることと、PR の head が `dac01220` であることを確認した）
- changed_files（PR #106 の既存 6 ファイルだけ。新しいファイルは追加していない）:
  - `supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql`（SHA-256 `9086cac4…ec3d7`）
  - `supabase/tests/postona_social_accounts_multi_provider_run.sh`
  - `supabase/tests/postona_social_accounts_multi_provider_fixture.sql`
  - `supabase/tests/postona_social_accounts_multi_provider_behavior.sql`
  - `supabase/tests/postona_social_accounts_multi_provider_mutations.sh`
  - `docs/postona/threads-connection-phase2b.md`

### B1〜B6 の対応

**B1 — プロバイダの本人 id の一意性**
- DDL の前に、`CREATE UNIQUE INDEX ON public.social_accounts USING btree (platform, platform_user_id) WHERE (platform_user_id IS NOT NULL)` が存在することを確認する。インデックス名は比較しない。条件:
  - 有効・ready・live・immediate（遅延しない）であること
  - 既定の演算子クラスと照合順序、NULLS DISTINCT、式なしであること（どれかが違えば定義文字列に現れる）
- これがなければ `POSTONA_ACCOUNTS_PRECONDITION_IDENTITY_UNIQUE` で止まる。インデックスを作り直したり、重複を解消したりはしない。
- 部分インデックスの条件 `platform_user_id IS NOT NULL` は、id を持つすべての行（全プロバイダ）を対象にする。
- 不正な状態から始めると、11 通りすべてが拒否され、何も変わらない（X だけの CHECK も残る）:
  - インデックスがない
  - X だけの条件
  - キーが広い
  - キーが違う
  - 式インデックス
  - 失敗した `CREATE INDEX CONCURRENTLY` が残した無効なインデックス
  - 条件が違う
  - NULLS NOT DISTINCT
  - text_pattern_ops
  - COLLATE "C"
  - 一意でない

**B2 — プロバイダは変えられない**
- 新しいトリガー `social_accounts_provider_guard`（BEFORE INSERT OR UPDATE、FOR EACH ROW）を追加した。`NEW.platform IS DISTINCT FROM OLD.platform` を、どのロールでも `SOCIAL_ACCOUNT_PROVIDER_IMMUTABLE` で拒否する。
- 次の組み合わせをすべて確認し、どれも拒否された:
  - 付け替え: X→Threads、X→IG、Threads→X、Threads→IG、IG→X、IG→Threads
  - 行の状態: 接続済みの X と未接続の X、refresh 参照の有無
  - 同じ文で一緒に変える内容: refresh / access / 状態 / 公開設定
  - 実行するロール: 所有者と service_role
  - 書き方: 複数行の UPDATE、upsert
- X の通常の更新（投稿許可、refresh、退会）は、既存の回帰テストですべて通った。

**B3 — SET ROLE で到達できる経路**
- `pg_has_role(..., 'MEMBER')` を使うようにした。PG16 以降の、INHERIT=false / SET=true のものも含め、すべてのメンバーシップの経路を、直接・推移的にたどる。
- anon / authenticated から、次のどれかに到達できれば `ROLE_GRAPH` で止まる:
  - テーブルの所有者、superuser、BYPASSRLS のロール、service_role
  - このテーブルを INSERT / UPDATE（列単位を含む）/ DELETE / TRUNCATE できる、またはトリガーを追加できるロール
- service_role が所有者か superuser に到達できる場合も止まる（B6 の前提）。
- ロールのつながりは正規化しない。revoke もしない。
- 不正な状態から始めた 12 通りは、すべて拒否された:
  - SET だけの経路: authenticated→service_role、anon→service_role、推移的な chain（authenticated / anon）、所有者への経路、anon から chain をたどって所有者へ、`pg_write_all_data` への経路、service_role→所有者
  - 継承による経路: service_role、所有者
  - 列単位の書き込み権限だけを持つロールへの SET 経路（ACL で先に拒否）
  - 継承した書き込みロール（ACL で先に拒否）

**B4 — レビュー済みの開始契約**
- DDL の前に、`social_accounts` が次の契約と完全に一致することを確認する。一致しなければ固定のコードで止まり、何も変えない（不明なものを drop・revoke・正規化しない）:
  - 列: 14列（名前、型、NULL 可否、既定値、identity / generated、照合順序）。それ以外の列はない
  - 制約: 6つ（定義、検証済み、遅延しない。名前は比較しない）
  - インデックス: 3つ（定義と、使える状態であること）
  - RLS: 有効で FORCE なし。member の読み取りポリシーだけがある（permissive、SELECT、authenticated、式の文字列まで一致）
  - トリガー: 既存の2つ（完全な定義、有効、関数の言語・SECURITY DEFINER・search_path・本体の md5）
  - 表の ACL: authenticated は SELECT だけ。service_role は TRIGGER を除く DML などだけ。どれも grant option なし。PUBLIC・anon・その他のロールには何もない。列単位の ACL もない
- 契約の根拠: 9/28 の本番調査に基づく fixture、識別子のインデックス・ポリシー・トリガーを作った migration、10/06 の S0（所有者は superuser でない `postgres`、トリガーはこの2つだけ、authenticated に INSERT / UPDATE / DELETE はない）。
- 本番では未確認の値がある（下の「本番だけで確認できる事実」）。その確認は同日の読み取り専用 preflight で行い、違えば契約をレビューで直す。
- 不正な状態から始めた 36 通りは、すべて拒否された:
  - 列（平文トークン形の列、未知の列、既定値、NULL 可否、型、照合順序、継承）
  - 制約（未知の CHECK、未知の UNIQUE）
  - インデックス（未知のもの）
  - RLS とポリシー（RLS オフ、FORCE、未知のポリシー、restrictive、ロールの違い）
  - トリガー（未知のもの、イベントの違い、無効化、関数本体、SECURITY INVOKER 化）
  - ACL（authenticated の UPDATE / REFERENCES / TRUNCATE、authenticated の SELECT がない、anon の SELECT / DELETE、PUBLIC の SELECT / INSERT、未知のロール、service_role の TRIGGER、grant option、列単位の4種）

**B5 — 接続済みの Meta 行の access 参照**
- 新しい CHECK `social_accounts_meta_connected_access` を追加した: `platform = 'x' or vault_access_token_secret_id is not null or connection_status in ('unconnected', 'authorization_pending', 'failed')`。
- 状態の契約は、既存の CHECK にある 5 つの値。
- 接続前の状態だけを許可リストにした。将来、状態が増えた場合は access が必須になる側（安全側）に倒れる。
- refresh 参照は、従来どおり常に NULL（`social_accounts_provider_credential_profile`）。
- X が DB で受け付けるものは変えていない。
- 全組み合わせ 60 通りを確認した（プロバイダ3 × 状態5 × access の有無 × refresh の有無）。結果は期待どおりで、X はすべて受け付けられた。
- あわせて次も確認した:
  - 接続済みの行から access を外す更新は拒否される
  - 切断（access を外して `unconnected` にする）は通る

**B6 — service_role の権限が Meta 行に広がる問題**
- 同じガードトリガーで扱う。Threads / IG の行の INSERT / UPDATE は、`current_user` がテーブル所有者のときだけ通る。それ以外は `SOCIAL_ACCOUNT_PROVIDER_WRITE_NOT_ALLOWED`:
  - ガード関数は SECURITY INVOKER なので、`current_user` は文を実行しているロールになる。所有者が持つ SECURITY DEFINER 関数の中では所有者になる。
  - X の行は対象外。DELETE も対象外。
- 将来の Threads 接続は、所有者が持つ、レビュー済みの SECURITY DEFINER 関数として作る（EXECUTE は authenticated だけ）。こうすればガードを変えずに書ける。テーブルの広い DML をクライアントに開く必要はない。
- 既存の監査:
  - `social_accounts` を書く SECURITY DEFINER 関数は 7 つ。名前でテストに固定した。
  - どれも汎用的な Meta 行の書き込み経路にならない: X の行を選ぶ、`'x'` だけを INSERT する、公開を止めるだけ、エラー状態にするだけ、Meta の ON を拒否する、削除する、のいずれか。
  - 唯一、渡された行に資格情報を書く X の完了処理でも、Threads の行を指すように偽造した state では CHECK で拒否された。secret は作られず、state は消費されず、行も変わらなかった。
  - Stage 3B の連鎖では、該当する関数は 2 つで、レビュー済みの一覧に含まれていた。
- service_role は直接の操作で次ができない（すべて拒否された）:
  - Threads / IG の行の作成
  - 既存の Meta 行の 5 種類の更新
  - upsert による変更
- service_role の X の行の作成・更新は、従来どおり通る。
- anon / authenticated は、X と Meta のどちらにも INSERT / UPDATE / DELETE できない（42501）。
- 前提として、service_role がこのテーブルに TRIGGER 権限を持たないこと、所有者や superuser に到達できないことを、precondition で確認する（B3 / B4）。

**防御的な追加項目**
- postcondition で次を確認するようにした:
  - 4 つの CHECK の定義が、文字列として完全に一致すること
  - ガードのトリガーの完全な定義と有効状態、関数の性質（所有者、SECURITY INVOKER、plpgsql、空の search_path、EXECUTE は所有者だけ）
- スナップショットに次を含めた: ポリシーの permissive、トリガーの完全な定義・関数の id・所有者・ACL・本体の md5、インデックスの valid / ready / live / immediate、関係するロールのメンバーシップ（INHERIT / SET / ADMIN を含む）、全行。
- ロックについて明記した: ACCESS EXCLUSIVE のロック待ちは `lock_timeout` で区切られるが、ファイル全体の実行時間には上限がない。本番では `statement_timeout` と、止めるときの手順の承認が必要。migration のヘッダと設計メモ §10 に書いた。

### 使い捨て PostgreSQL での確認（Homebrew PG 17.11、ローカルソケットのみ）
- 修正版のランナー: **ALL PASS**（APPLY / BEHAVIOR / 既存テスト3種 / ADVERSE / ATOMICITY / CLEANUP）
  1. 適用と挙動:
     - X の行・列・権限・ポリシー・インデックス・メンバーシップは変わらない
     - 既存のトリガー2つは、本体まで含めて変わらない
     - B5 の 60 通り、B2 の 64 通りと upsert・複数行、B6 の service_role / anon / authenticated、書き込み関数の監査、偽造した state、未知のプロバイダと表記揺れ（14 通り）、一意性（3 プロバイダ）、X の関数による拒否、退会時の operator 回し
     - CHECK とガードの定義が完全に一致すること
  2. 既存の X テストを、候補の適用後に再実行して PASS:
     - 投稿許可
     - 退会
     - Stage 3B の pilot / publish authority / settings reader
     - 退会用と Stage 3B 用の fixture は、本番の契約と関係のない点（列の既定値、本番にあるトリガーやインデックスの不足）が違う。そこで次の順に処理した: 実物で契約の形に揃える（関数本体は実際の migration から取り出す）→ 候補を適用する → 揃えた分を戻す → 既存のテストを実行する。
  3. 不正な出発状態: 73 通り（固定のコードでの拒否が 72、ロック待ちのタイムアウトが 1）。どれもカタログ全体と全行が変わらず、候補のオブジェクトが残らないことを確認した。名前を変えただけの X 専用 CHECK は適用される。適用中の書き込みは、precondition の時点から待たされる。
  4. 原子性と postcondition:
     - DROP と ADD の間、ガードを作った後、COMMIT の直前のどこで失敗しても、何も残らない
     - postcondition の直前にずれを入れた 21 通りが、すべて拒否される
- ミューテーション: **45/45 を検出**（変更していないコピーの対照実行は PASS）
  - 元の 26 件はすべて新しいコードに合わせて残した。TRUNCATE の 1 件は「authenticated が任意の権限を持てる」に統合した。
  - 新しいガード、B1 / B3 / B4 / B5、postcondition の比較項目について 20 件を追加した。
  - CHECK を弱める変異は、postcondition の期待値も同時に書き換えた。postcondition ではなく挙動のテストが検出することを確かめるため。
- `migration_source_invariants_test.ts`: 新しいファイルを含めて 11 件 PASS（このファイルは編集していない）。
- `git diff --check` 問題なし。秘密情報パターン 0。依存関係・lockfile・TS・ランタイムの変更 0。

### migration の予約
- バージョンは `20261007150000` のまま。
- main / 作業中の PR の migration と衝突しない:
  - main の最新は `20261007120000`
  - G3 PR #109: `20261007173000`
  - #3: `20260921115317`（main 上にもある）
- **`migration_source_invariants_test.ts` は G3 の作業中 PR #109 が変更している**ため、予約は追加していない。K4 で、#109 の後に `"20261007150000": "postona_social_accounts_multi_provider"` を追加してほしい。

### 他スロットとの重なり
- 作業中の PR（#109 G3、#33、#11、#10、#3）の変更ファイルとの重なりは 0。
- G3 の AI Lab のファイル、G5 の共通アカウントと Auth のファイルには触れていない。

### CI
- push 直後の時点で、失敗 0・成功 2・実行中 1・スキップ 3（Web の変更はない）。ポーリングはしていない。結果は K4 で確認してほしい。

### 本番・deploy・プロバイダの変更: 0
- 本番の読み書き、適用、Edge の deploy、Auth / OAuth / Vault / secrets / Meta アプリの変更、プロバイダの API 呼び出しは、すべてしていない。
- 使ったのは、ローカルの使い捨て PG クラスタだけ。

### 本番だけで確認できる事実（同日の読み取り専用 preflight で確認する。このタスクでは実行していない）
1. **テーブルの所有者**と、適用ツールで実行したときの `current_user` / `session_user`。所有者が superuser でないこと。
2. **ロールのメンバーシップ**（INHERIT / SET / ADMIN を含む）:
   - anon / authenticated が、所有者・superuser・BYPASSRLS・service_role・書き込みできるロールに到達できないこと
   - service_role が、所有者・superuser に到達できないこと
3. **列**: 14 列の型・NULL 可否・既定値。fixture 間で食い違いがあるもの:
   - `publish_enabled`: false か true か
   - `connection_status`: `'unconnected'` か `'identity_verified'` か
   - `handle` / `oauth_client_ref` の NULL 可否
   - 契約は publish-permission の fixture（false / unconnected / NOT NULL）に合わせた。
4. **制約** 6 つの定義。特に `UNIQUE (brand_id, platform)` が制約として存在すること。
5. **インデックス** 3 つ（本人 id のインデックスは `20260919120000` の `if not exists` で作られたので、既に同名のものがあった場合の定義を含めて確認する）。
6. **ポリシー**: member の読み取りポリシーだけで、他に（管理者用などが）ないこと。RLS が有効で FORCE なし。
7. **トリガー** 2 つの定義と、その関数本体の md5（`2d50233f…`、`dc371380…`）。
8. **表と列の ACL**:
   - authenticated が SELECT だけであること。Supabase の既定の付与が残っていれば REFERENCES / TRIGGER / MAINTAIN がある可能性がある
   - anon に何もないこと
   - service_role に TRIGGER も grant option もないこと
   - 列単位の ACL がないこと
9. **ガードの迂回の前提**（設計メモ T11 / T12）:
   - 所有者の SECURITY DEFINER 関数が書く他のテーブルや、public スキーマに対して、service_role / anon / authenticated が TRIGGER / CREATE 権限を持たないこと
   - repo にない SECURITY DEFINER 関数で `social_accounts` を書くものが本番にないこと
10. **適用ツールがファイルをトランザクションで包むか**、`statement_timeout`、止めるときの手順。
11. 適用の順序: PR41 / PR81 の migration が本番に入っていない間は、履歴の順序をどうするか（K4 が判断）。

### 次の推奨
1. K4 → 空いている H1 / H2 で、この head に絞った再レビューを 1 回行う。
2. 承認されたら、上の 1〜11 を確認する同日の読み取り専用 preflight（G4 か、ユーザーが実行）を行う。違いがあれば、契約をレビューで直す。
3. 本番適用（承認制）→ Phase 2b（Threads 接続）。2b の前に決めておくこと: 設計メモの T1 / T2 / T9 / T10。
- status: review_required / next_owner: chatgpt。STOP for K4。

## K4 decision — final function-contract corrective PASS_CANDIDATE / H1 final rereview assigned — 2026-10-08

- verdict: **PASS_CANDIDATE / merge HOLD**.
- Claude corrective source head before K4 housekeeping: `f5fb9306f99c27c62ae17070e2682dba42264bc8`.
- K4 completed the deferred migration reservation bookkeeping now that G3 PR #109 is merged/free:
  - added `20261007150000: postona_social_accounts_multi_provider` to `supabase/tests/migration_source_invariants_test.ts`;
  - preserved current-main reservation `20261007173000: ai_lab_topic_evergreen_capacity`;
  - the branch copy of the invariant file equals current main except for the single POSTONA reservation line.
- exact PR #106 head after K4 bookkeeping: `4b6dc57966e0d55b2e901a7707446c35b25a1f00`.
- PR remains open/unmerged; changed files now 7.
- product/source corrective remains limited to the existing migration/tests/docs plus the reservation map.
- G4 reports C1-R1/C1-R2 closed:
  - existing trigger functions now pin owner/ACL/effective EXECUTE plus exact normalized definition;
  - new provider guard postcondition pins exact normalized body/definition;
  - 85 adverse starts, 23 postcondition drift cases, 54/54 mutation detection, X publish/refresh/deletion/PR41 Stage3B regressions PASS.
- production DB/catalog access, apply, deploy, Auth/OAuth/Vault/provider calls: 0.
- exact-head CI at K4: Netlify PASS; Vercel pending after reservation-only commit. Prior product head had no code CI failure; review may proceed while Vercel settles.
- H1/H2 were both fresh-checked as done/free. H1 chosen for continuity with prior PR #106 review.
- H1 task: `postona-pr106-function-contract-final-rereview-20261008`.
- H1 exact target: `4b6dc57966e0d55b2e901a7707446c35b25a1f00`.
- recommended reviewer model: **Sol（高）**.
- no merge or production preflight/apply is authorized by this K4.
- next_owner: codex / H1.

## Report — C1 corrective (function-contract hardening) (2026-10-07)

- task_id: postona-multisocial-phase2a2-security-corrective-20261007（C1 corrective round）
- result: **C1-R1 と C1-R2 を修正し、既存の PR [#106](https://github.com/anohi-memories/kabumori/pull/106) を更新した（source のみ・本番適用なし）**。
  - 新しい head は `f5fb9306`（C1 修正 `fdc55d26` ＋ main の merge）。H1 が見た head `a8f313dc` は履歴に残っている（force push なし）。未 merge。
  - B1〜B6 の修正と、既存の回帰テストはすべてそのまま残した。
- model_used: Opus 5.5（TASK の推奨どおり）
- fresh main:
  - 開始時の main は `cb07f202`。
  - PR のブランチには、最新の main `38b45166` を通常の merge で取り込んだ。
  - 取り込んだ変更は、ニュース取得（`news_discovery/fetcher*`、`market_macro_source_fetchers*`）と .agent で、PR のファイルやテストで使う migration の連鎖とは重ならない。
- changed_files（PR #106 の既存ファイルのうち4つ。設計メモと挙動テストは変えていない）:
  - `supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql`（SHA-256 `6bb1c243…50353`）
  - `supabase/tests/postona_social_accounts_multi_provider_run.sh`
  - `supabase/tests/postona_social_accounts_multi_provider_fixture.sql`
  - `supabase/tests/postona_social_accounts_multi_provider_mutations.sh`

### C1-R1 — 既存の2つのトリガー関数の所有者と ACL を固定した
- **承認済みの契約の根拠**:
  - repo: `20260925140000` と `20260928160000` は、`x_account_refresh_reset_on_reconnect()` と `social_mobile_account_deletion_guard()` を作ったあと、`revoke all ... from public, anon, authenticated, service_role` している。EXECUTE は所有者だけになる。
  - 本番の読み取り専用 S0（10/06）: 所有者 `postgres` の、public スキーマでの関数の既定 ACL は `{postgres=X/postgres}`（所有者だけ）。
- **DDL の前の確認**（ロール関係の確認の後。どれかを満たさなければ止まり、何も直さない）:
  - `..._PRECONDITION_TRIGGER_FUNCTIONS`: 両関数について次がすべて一致すること
    - 識別子（`public.x_account_refresh_reset_on_reconnect()` / `public.social_mobile_account_deletion_guard()`）
    - 通常の関数であること（`prokind = 'f'`）
    - 所有者がテーブル所有者であること
    - 正規の定義 `md5(pg_get_functiondef)` が repo の migration どおりであること（`fda71f31…` / `f1e29728…`）。この定義には、引数、戻り値の型、言語、volatility、cost、SECURITY DEFINER、search_path、本体が含まれる
  - `..._PRECONDITION_TRIGGER_FUNCTION_EXECUTE`: PUBLIC、anon、authenticated のどれも、両関数を実行できないこと。直接でも、継承や SET ROLE で到達できるロール経由でも、推移的でもだめ（`pg_has_role(..., 'MEMBER')`。PG16 以降の INHERIT / SET の扱い）
  - `..._PRECONDITION_TRIGGER_FUNCTION_ACL`: 直接の ACL が、所有者自身の EXECUTE ちょうど1つであること。他の grantee も grant option もないこと（`proacl` が NULL の既定の状態は、PUBLIC の EXECUTE を含むので拒否される）
- **スナップショットに追加した項目**: トリガー関数の `prokind` と `md5(pg_get_functiondef)`。所有者、ACL、本体の md5 は以前から含めている。migration の実行中に関数のセキュリティ属性が変われば、postcondition が拒否する。
- **不正な出発状態を 12 通り追加した**。どれも固定のコードで拒否され、カタログ全体と全行は変わらず、X だけの CHECK が残り、ガードやヘルパーも残らない:
  - 所有者の違い、cost の違い（定義の違い）、search_path の違い
  - PUBLIC / authenticated / anon への直接の EXECUTE
  - service_role への EXECUTE、grant option、未知のロールへの EXECUTE
  - EXECUTE を持つロールへの経路: 継承、SET だけ、推移的（SET だけの chain）
- 以前から受け入れられている本体・定義の確認（`trigger_function_body`、SECURITY INVOKER 化など）は、そのまま通っている。

### C1-R2 — 新しいガード関数の本体を固定した
- postcondition は、既存のメタデータの確認に加えて、次も確認する:
  - `prokind = 'f'`
  - `md5(pg_get_functiondef(public.social_accounts_provider_guard()))` が、レビュー済みの値 `3f0ee4a3b1adf64819ec97cce7a67808` と一致すること
  - 既存のメタデータの確認: 所有者、SECURITY INVOKER、plpgsql、空の search_path、EXECUTE は所有者だけ
- この定義には、引数、戻り値の型 `trigger`、言語、volatility、セキュリティ、search_path、本体が含まれる。PG17 の中では決定的に同じ出力になる。
- メタデータを変えずに本体だけを変えると、apply 全体が `POSTONA_ACCOUNTS_POSTCONDITION_GUARD` で原子的に拒否される。次の2つで確認した:
  - ミューテーション3件: 付け替えを許す、Meta 行の保護を外す、何も確認せずに `NEW` を返す
  - postcondition の直前の注入: 何も確認しない本体に `create or replace`
- 変えていない関数は通る（ランナーの APPLY）。

### 使い捨て PostgreSQL での確認（Homebrew PG 17.11、ローカルソケットのみ）
- ランナー: **ALL PASS**（APPLY / BEHAVIOR / 既存テスト3種 / ADVERSE / ATOMICITY / CLEANUP）
  - B1〜B6 の不正な出発状態: 既存の 73 通りはすべて PASS のまま
  - C1-R1 の 12 通り: PASS
  - 合計 85 通り（固定のコードでの拒否が 84、ロック待ちのタイムアウトが 1）
  - postcondition の直前に入れたずれ: 23 通り（ガード本体の差し替え、既存のトリガー関数への grant を追加）。途中失敗の 3 通りも PASS
  - 既存の X の回帰テスト（投稿許可、退会、Stage 3B の pilot / publish authority / settings reader）: PASS
  - 揃え直し: 退会用と Stage 3B 用の fixture で実物の関数を作るときは、実際の migration と同じ `revoke` もかけるようにした（C1-R1 の契約に合わせるため）
- ミューテーション: **54/54 を検出**（変更していないコピーの対照実行は PASS）
  - 追加した 9 件の内訳:
    - C1-R2 の、本体だけを変えるもの 3 件
    - C1-R1 の確認を外したり弱めたりするもの 5 件（所有者、定義、EXECUTE 経路、SET だけの経路、直接の ACL）
    - スナップショットからトリガー関数の ACL を外すもの 1 件
  - 既存の2件（付け替え、Meta 行の保護）は、postcondition の固定値も変異体のものに書き換えた。こうして自己整合させたうえで、挙動テストが検出することを確認した。
- `migration_source_invariants_test.ts`: 11 件 PASS（編集していない）。
- `git diff --check` 問題なし。秘密情報パターン 0。

### migration の予約
- バージョンは `20261007150000` のまま。main・作業中の PR と衝突しない。
- `migration_source_invariants_test.ts` は、G3 の PR #109 がまだ作業中で変更しているため、予約は追加していない（前回と同じく K4 への依存）。

### 他スロットとの重なり
- 作業中の PR の変更ファイルとの重なりは 0。
- G2 / G3 / G5 のファイルには触れていない。

### CI
- Netlify は PASS。Vercel は「Deployment rate limited — retry in 24 hours」（デプロイ回数の制限）で失敗した。コードの失敗ではない（Web の変更もない）。ポーリングはしていない。

### 本番・deploy・プロバイダの変更: 0
- 本番の DB・カタログへのアクセス、適用、deploy、Auth / OAuth / Vault / secrets、プロバイダの API 呼び出しは、すべてしていない。

### 本番だけで確認できる事実（前回の一覧に追加）
- 2つのトリガー関数について:
  - 所有者
  - `proacl`（所有者自身の EXECUTE だけであること）
  - `md5(pg_get_functiondef)` が `fda71f31…`（refresh の reset）/ `f1e29728…`（退会のガード）と一致すること。本番の PG 17.6 で同じ出力になるかも、preflight で確認する
  - PUBLIC / anon / authenticated から EXECUTE に到達できないこと
- 違いがあれば、契約をレビューで直す（修復や revoke はしない）。

### 次の推奨
- K4 → 空いている H1 / H2 で、この head に絞った再レビューを 1 回行う。
- status: review_required / next_owner: chatgpt。STOP for K4。

## K4 decision — final ACL/merge corrective PASS_CANDIDATE; H1 narrow rereview assigned — 2026-10-09

- verdict: **PASS_CANDIDATE / merge HOLD**.
- exact G4 corrective PR #106 head: `c0b6c03cb909d91f72b58424d64c6dfae1b8f14f`; PR open/unmerged, 7 files, mergeable=true.
- last remaining F1: `proacl={}` for either existing trigger function now fails before DDL. SQL checks exactly one owner->owner EXECUTE without grant option and refuses NULL/default PUBLIC grants or additional grants.
- F2: G4 normally merged fresh main and mechanically resolved the migration reservation. POSTONA `20261007150000` and AI Lab `20261007173000` preserved. Candidate reservation file equals current main plus one POSTONA reservation line.
- G4 reports 87 adverse starts, 23 postcondition drift cases, 55/55 mutation detection, source invariants 11/11, and X publish/refresh/deletion/PR41 Stage3B regressions PASS.
- K4 verified exact SQL ACL predicate, reservation single-line diff, GitHub mergeability and main-side non-overlap. Netlify and Vercel both SUCCESS on exact head.
- production DB/catalog access, migration apply, deploy, Auth/OAuth/Vault/provider calls: **0**.
- accepted earlier B1-B6 and C1-R2 source remain unchanged.
- H1 and H2 were both verified done/free via status/task_id/TASK/Report/ACTIVE/CURRENT_STATE. H1 chosen for prior PR #106 review continuity.
- H1 review task: `postona-pr106-f1-acl-final-rereview-20261009`.
- H1 exact target: `c0b6c03cb909d91f72b58424d64c6dfae1b8f14f`.
- recommended reviewer model: **Sol（高）**.
- H1 review scope: positive owner EXECUTE exact-ACL, migration reservation conflict resolution, narrow PG/mutation/X regressions only.
- no PR merge or production preflight/apply authorized by this K4.
- next_owner: codex; finish code C1.

## Report — C1 corrective: final ACL exactness + main integration (2026-10-08)

- task_id: postona-multisocial-phase2a2-security-corrective-20261007（2026-10-08 の C1 corrective）
- result: **F1（ACL の厳密化）と F2（予約ファイルの競合解消）を完了し、既存の PR [#106](https://github.com/anohi-memories/kabumori/pull/106) を更新した（source のみ・本番適用なし）**。
  - 新しい head: `c0b6c03c`。内訳は、F1 の修正 `fa294855` と、main `481eccc0` の通常の merge。
  - H1 が見た `4b6dc579` は履歴に残っている（force push はしていない）。
  - 未 merge。
  - B1〜B6、C1-R1、C1-R2 の設計は変えていない。
- model_used: Opus 5.5（TASK の推奨どおり）
- workspace: 既存の G4 専用 worktree `/Users/yuya/Developer/kabumori-g4-phase2a2`。clean だった。K4 が PR に積んだ `3b4e4063` と `4b6dc579` まで fast-forward してから作業した。

### F1 — 所有者自身の EXECUTE ちょうど1つを積極的に要求する
- 2つのトリガー関数（`public.x_account_refresh_reset_on_reconnect()`、`public.social_mobile_account_deletion_guard()`）のそれぞれについて、確認方法を変えた:
  - 変更前: 「悪いエントリがないこと」だけを見ていた。
  - 変更後: 正規化した ACL がちょうど次の1件だけであることを要求する:
    ```sql
    (select array_agg(concat_ws(' | ', (a.grantor = v_owner)::text, (a.grantee = v_owner)::text,
                                a.privilege_type, a.is_grantable::text))
     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a)
      is distinct from array['true | true | EXECUTE | false']  →  POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_ACL
    ```
- この1件は、所有者が自分に与えた EXECUTE で、grant option なし。他の grantee・権限・grant option は一切ない。
- 結果として、次の2つも拒否される:
  - 空の ACL（`'{}'`。所有者の EXECUTE が revoke された状態。aclexplode が0行を返す）
  - 既定の ACL（NULL。PUBLIC を含む）
- 実効的な EXECUTE の確認（継承、SET ROLE、推移的な経路）は、そのまま残した。
- GRANT、REVOKE、所有者の変更、修復はしない。

### F1 のテスト
- 空の ACL: 2つの関数それぞれについて、`revoke execute ... from <owner>` で `proacl = '{}'` になったことを確かめてから適用した。両方とも `POSTONA_ACCOUNTS_PRECONDITION_TRIGGER_FUNCTION_ACL` で拒否された。カタログ全体と全行は変わらず、X だけの CHECK が残り、候補のオブジェクトは何も残らなかった。
- 正常な対照: 適用する DB で、両関数の ACL が `{owner=X/owner}` であることを確認してから適用し、通った（APPLY）。
- ミューテーション: 確認を「悪いエントリの拒否だけ」の旧版に戻す変異を追加した。空の ACL のケースで検出された。

### F2 — 予約ファイルの機械的な競合解消
- 最新の main `481eccc0` を、PR のブランチに通常の merge で取り込んだ。
- 競合は `supabase/tests/migration_source_invariants_test.ts` だけだった。main の内容をそのまま取り、POSTONA の1行（`"20261007150000": "postona_social_accounts_multi_provider"`）を足した。
- 結果の確認:
  - `git diff origin/main HEAD -- supabase/tests/migration_source_invariants_test.ts` は、その1行の追加だけ。`"20261007173000": "ai_lab_topic_evergreen_capacity"` をはじめ、main の他の予約や不変条件は変わっていない。
  - blob は `78c97471` で、K4 が PR に入れた版と同じ。
- `git merge-tree --write-tree origin/main HEAD` は競合なし（exit 0）。
- main に対する PR の差分は 7 ファイル: PR の 6 ファイルと、予約ファイルの1行。

### 確認（使い捨て PG 17.11、ローカルソケットのみ。merge 後の状態で実施）
- ランナー: **ALL PASS**（APPLY / BEHAVIOR / 投稿許可・退会・Stage 3B の既存テスト / ADVERSE / ATOMICITY / CLEANUP）
  - 不正な出発状態は 87 通り。固定のコードでの拒否が 86（空の ACL 2 通りを追加）、ロック待ちのタイムアウトが 1。
  - postcondition の直前の注入 23 通り、途中失敗 3 通り。
  - C1-R1 と C1-R2 の、以前からのテストはそのまま通った。
- ミューテーション: **55/55 を検出**（変更していないコピーの対照実行は PASS。F1 の 1 件を追加）。
- `migration_source_invariants_test.ts`: 11 件 PASS。
- `git diff --check origin/main HEAD` 問題なし。秘密情報パターン 0。
- 候補の SHA-256: `0eb64135…15a9c9`。

### changed_files（このラウンド）
- `supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql`（ACL の確認を「ちょうど1件」に変更）
- `supabase/tests/postona_social_accounts_multi_provider_run.sh`（空の ACL 2件、正常な対照）
- `supabase/tests/postona_social_accounts_multi_provider_mutations.sh`（F1 の変異 1件）
- `supabase/tests/migration_source_invariants_test.ts`（merge の解消。main に1行を足しただけ）
- 設計メモ、挙動テスト、fixture は変えていない。

### 他スロットとの重なり・マージ可否
- 作業中の PR（#110 G2、#33、#11、#10、#3）の変更ファイルとの重なりは 0。PR #109 は main にマージ済み。
- GitHub での mergeable は `MERGEABLE`（競合なし。mergeStateStatus は Vercel の実行中のため `UNSTABLE`）。

### CI
- push 直後の時点で、Netlify と Vercel Preview Comments は PASS、Vercel は deploy 中（失敗 0）。Web の変更はない。ポーリングはしていない。

### 本番・deploy・プロバイダの変更: 0
- 本番の DB・カタログの読み書き、適用、deploy、Auth / OAuth / Vault / secrets、プロバイダの API 呼び出しは、すべてしていない。

### 次の推奨
- K4 → 空いている H1 / H2 で、この head に絞った最終の再レビューを 1 回行う。
- status: review_required / next_owner: chatgpt。STOP for K4。

---

# Previous G4 task — finalized Phase 2a-1

# Claude Task 4 — CURRENT TASK

- task_id: postona-multisocial-phase2a1-provider-domain-foundation-20261007
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- type: source-only provider-neutral domain foundation / behavior-preserving
- production_mutation_allowed: false
- merge_allowed: false
- deploy_allowed: false

## Context

POSTONA multi-social Phase 1 architecture is accepted and on main:
- `docs/postona/multi-social-phase1.md`

G3 PR #41 is now merged to main, so the live scheduled-user source foundation no longer blocks G4 architecture work.

G5 PR #95 is still under final common-account/Auth/session review and remains unmerged. Therefore this task deliberately advances only the **non-Auth / non-OAuth / non-credential / non-DB** part of Phase 2a.

This is a safe, behavior-preserving foundation task. It must not change live publishing behavior.

## Goal

Create the provider-neutral domain foundation that later Threads and Instagram work can build on, without touching G5-owned boundaries or current live X routing.

The output should establish canonical concepts for:

- provider id: `x | threads | instagram`
- structural provider capabilities
- credential profile kind
- publish flow kind
- provider-neutral publish target/result contracts
- provider adapter interfaces/types only

This task does **not** connect Threads, does **not** publish anything, and does **not** change DB schema.

## Mandatory startup / coordination

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/ACTIVE_TASK.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - accepted `docs/postona/multi-social-phase1.md`
   - current G3/G5 TASK/Report for conflict only.
2. Fresh-fetch `origin/main` from `/Users/yuya/Developer/kabumori-fresh`.
3. Create a new independent G4 worktree/checkout.
4. Confirm PR #41 is merged in fresh main before proceeding.
5. Fresh-check current PR #95 changed files. If any proposed G4 file overlaps PR #95, do not edit that file; redesign scope or STOP.
6. Do not touch another slot's worktree, branch, uncommitted files or dev server.

## Hard no-touch boundaries

Do not modify any current G5/PR #95 file, including but not limited to:
- `apps/social-mobile/src/app/_layout.tsx`
- `apps/social-mobile/src/domain/service-enrollment.ts`
- `apps/social-mobile/src/features/service-enrollment/*`
- common-account/service-enrollment migrations/tests/docs
- Kabumori auth/session/provider files owned by G5.

Also do not modify:
- `x-test-post` runtime routing;
- current X OAuth Edge Functions/RPCs;
- Vault/token refresh implementation;
- account deletion/revoke flows;
- `social_accounts` schema;
- scheduled-post schema;
- publish-authority DB/RPCs;
- any production workflow or setting.

## Phase A — canonical provider domain

Add the smallest pure domain representation needed for future X / Threads / Instagram support.

Required concepts:

```ts
type ProviderId = 'x' | 'threads' | 'instagram';

type CredentialProfile =
  | 'oauth2_rotating_refresh'
  | 'long_lived_access';

type PublishFlow =
  | 'single_call'
  | 'container_then_publish';
```

Define structural capabilities only, for example:
- text-only supported?
- media required?
- publish flow kind
- credential profile kind
- supports optional media?
- supports provider-side permalink/id concept?

Do **not** use this task to hard-code unstable commercial pricing or enforcement quotas.
Do **not** make uncertain provider limits runtime gates.

Unknown provider id must fail closed.

## Phase B — provider-neutral contracts

Define pure interfaces/types for future adapters, without wiring them into runtime yet.

At minimum cover:

### Connected account identity
Provider-neutral identity fields such as:
- provider
- providerAccountId
- handle/displayName where available

No token/plain credential fields.

### Publication target
A target must be able to represent:
- logical target id
- provider
- connected account id
- rendered text
- optional media references
- scheduled timestamp where relevant

No DB implementation in this task.

### Publish outcome
Represent:
- published with provider post id/permalink if available
- rejected with stable code
- uncertain / requires reconciliation

The model must support target-level retry/idempotency later.

### Adapter contracts
Type/interface only for future:
- ConnectAdapter
- CredentialAdapter
- PublishAdapter
- DisconnectAdapter

Do not instantiate real adapters or call external APIs.

## Phase C — canonical location / app-server parity

Prefer one canonical pure TypeScript source if the repository/tooling can safely import it from both:
- `apps/social-mobile`
- Supabase/Deno shared code

If one shared import path is impractical or would create toolchain coupling:
- use separate app/server modules;
- add a focused parity test that proves provider ids and structural capabilities cannot silently drift.

Do not introduce a new package/workspace dependency unless clearly necessary.

## Phase D — X behavior preservation proof

This task must not change current X behavior.

Verification must prove:
- no current X runtime path imports the new adapter implementation in a way that changes execution;
- no DB/migration/RPC/Edge behavior changed;
- no publish enablement semantics changed;
- no auth/onboarding/service-enrollment behavior changed;
- no provider call is added.

If you need to touch an existing file solely to export/reuse a type, keep it minimal and prove no runtime delta.

## Suggested files

Claude should first inspect repository conventions and choose the smallest compatible placement.

A safe shape may be:
- one new pure provider-domain module;
- one or two focused test files;
- optional short design note under `docs/postona/`.

Avoid editing existing runtime files unless necessary.

## Verification

At minimum:
- provider ids exactly `x / threads / instagram`;
- unknown provider rejected;
- X capability profile matches accepted architecture;
- Threads/Instagram structural differences represented without runtime calls;
- target/outcome contracts can represent single-call and container-then-publish flows;
- app/server parity test if definitions are duplicated;
- existing social-mobile tests relevant to touched modules;
- TypeScript/Deno check as applicable;
- `git diff --check`;
- changed-file overlap check against current PR #95 = 0;
- runtime/migration/RPC/Edge/workflow/Auth/OAuth/Vault/production/provider-call changes = 0.

## Deliverable / PR

Create a focused PR for this source-only foundation.

Do not merge.

Report:
- fresh main;
- exact changed files;
- canonical provider-domain placement;
- provider capability model;
- target/outcome/adapter contracts;
- parity strategy;
- tests;
- proof of zero overlap with PR #95;
- proof of zero runtime/DB/Auth/OAuth/Vault/production/provider-call change;
- remaining blockers for actual Threads connection;
- next recommendation.

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K4.

## Review policy

This is a behavior-preserving source/domain foundation with no DB/Auth/OAuth/runtime wiring.

Default: no Codex review if K4 confirms scope stayed pure and tests pass.

推薦モデル：**Sonnet5（高）**

## Report — postona-multisocial-phase2a1-provider-domain-foundation-20261007 (2026-10-07)

- task_id: postona-multisocial-phase2a1-provider-domain-foundation-20261007
- result: **PASS（source のみ・挙動変更なし）**。PR [#103](https://github.com/anohi-memories/kabumori/pull/103) を作成した。head は `2b2f1c1f`、未 merge（merge_allowed=false）。
- model_used: Opus 5.5（TASK 推奨は Sonnet5（高）。このセッションのモデルは Opus 5.5）
- fresh main:
  - 作業は `d648ec02` から始めた。PR #41 の merge `b90ee326` を含むことを確認済み。
  - 作業中に PR #95 が merge された（`d5bea735`）。その main に rebase してから全テストをやり直した。
- workspace: `kabumori-fresh` から作った G4 専用 worktree `/Users/yuya/Developer/kabumori-g4-phase2a1`（branch `claude/g4-postona-phase2a1-provider-domain-20261007`）。
- changed_files（すべて新規、5ファイル）:
  - `apps/social-mobile/src/domain/provider-domain.ts`
  - `apps/social-mobile/tests/provider-domain.test.mjs`
  - `supabase/functions/_shared/social/provider_domain.ts`
  - `supabase/functions/_shared/social/provider_domain_test.ts`
  - `supabase/functions/_shared/social/provider_domain_parity_test.ts`
  - 既存ファイルの変更は 0。依存関係・lockfile の変更も 0。

### 置き場所と同一性の保ち方
- 正本は1つにせず、import のない同じ内容のモジュールをアプリとサーバーに1つずつ置いた。アプリ（Expo/Metro）から `supabase/functions` を読み込むにはバンドラー設定の変更が要り、TASK の「ツールチェーンを結合しない」に反するため。
- 同一性テスト `provider_domain_parity_test.ts`（Deno）で、次の4点が一致することを確認する:
  - 公開している名前
  - 全定数の値
  - 全関数の結果（入力の組み合わせで比較）
  - 公開している全21個の型（型チェック時に、型が等しいことを検査）
- 作業用のコピーにわざと4種類のずれを入れて検出を確認した。結果は「型のずれ → 型エラー」「値・余分な公開・挙動のずれ → テスト失敗」で、何も変えないコピーは通過した。

### プロバイダの機能モデル（構造のみ）
- `ProviderId = 'x' | 'threads' | 'instagram'`。`parseProviderId` は厳密に一致したものだけを受け付ける。大文字小文字の違い、前後の空白、別名、`__proto__` などはすべて `null` になり、拒否される。
- `CredentialProfile`: X は `oauth2_rotating_refresh`、Threads と IG は `long_lived_access`。
- `PublishFlow`: X は `single_call`、Threads と IG は `container_then_publish`。
- 機能の項目: `textOnly`、`mediaRequired`、`optionalMedia`、`providerPostId`、`providerPermalink`。X のパーマリンクは API の項目ではないので false。
- 定数はすべて freeze して、実行中に書き換えられないようにした。
- 料金・投稿上限・文字数上限は**入れていない**（TASK の指示どおり。実行時の判定にしない）。

### 配信先・結果・アダプタの型
- `ConnectedAccountIdentity`: トークンの項目はない。
- `CredentialRef`: 参照だけを持つ。`refreshRef` は回転型のときだけ値が入り、それ以外は null。
- `PublicationTarget`: `targetId` が冪等性のキー。作成時に確定した `renderedText` を持ち、メディアの参照と予約時刻は任意。
- `checkTargetShape`: 配信先の形だけを判定する。未知のプロバイダ、IG へのテキストだけの投稿、空の投稿を拒否する。
- `PreparedPublish`: 1回で投稿する流れか、入れ物（コンテナ）id を持つ流れか。
- `ContainerState` と `publishStepsFor`。
- `PublishOutcome`: `published`、`rejected`、`uncertain` のいずれか。`mayRetryTarget` は rejected のときだけ再試行を許す。
- `ConnectAdapter`、`CredentialAdapter`、`PublishAdapter`、`DisconnectAdapter` はインターフェースの定義だけで、実装はない。テストの中では偽のアダプタを使い、両方の投稿の流れを最後まで表現できることを確認した。

### tests
- Deno:
  - 新しいテスト 13件（ドメイン 10件、同一性 3件）が型チェックありで PASS
  - `_shared` 全体 449件 PASS（`--no-check --allow-run`）
  - `deno check` と `deno lint` PASS
- アプリ:
  - `npm test` 226件 PASS（新しい `provider-domain.test.mjs` 5件を含む。rebase 前は 198件）
  - `tsc --noEmit` と `expo lint` PASS
- `git diff --check` 問題なし。秘密情報パターン 0。

### 挙動が変わらないことの証明
- アプリの src に、新しいモジュールを読み込んでいるファイルは 0（テストで固定）。サーバー側も、自分自身のテストと同一性テスト以外から参照されていない（grep で確認）。両モジュールとも import はない（テストで固定）。
- 次のいずれも変更していない:
  - `x-test-post`
  - X の OAuth 用 Edge Function と RPC、Vault と refresh、退会・revoke
  - `social_accounts` と予約投稿のスキーマ、publish authority
  - Auth、オンボーディング、サービス利用権
  - migration、ワークフロー、本番
- プロバイダへの呼び出し、外部への通信、本番の読み書き・deploy、アプリや認証情報の作成も 0。
- PR #95 とのファイルの重なりは 0（最新の PR #95 のファイル一覧で `grep -x` して確認）。

### CI
- Netlify は通過（Web の変更がないので preview は自動キャンセル）。
- **Vercel は失敗しているが、原因は「Deployment rate limited — retry in 24 hours」**（Vercel アカウントの deploy 上限）。今回の変更とは無関係で、main の最新コミット `d5bea735` でも同じ失敗が出ている。コードの修正では直せない。

### Threads を実際に接続するまでに残る障害
1. **Meta 側の準備（2-0）**: Meta アプリ（Threads ユースケース）の登録、プライバシーポリシーとデータ削除・連携解除コールバック、テスター登録、App Review の計画。リダイレクト URI でカスタムスキームが使えるかの確認（要検証）。
2. **DB の拡張（G5 との合意が必要）**:
   - `social_accounts` の `CHECK (platform='x')` を広げる
   - 資格情報の型ごとの規則を入れる（アクセストークンだけの資格情報を許す）
   - アカウント id の接尾辞を中立にする
3. **接続経路**: Threads 用の OAuth（短期トークンから長期トークンへの交換、本人情報の取得）。資格情報ライフサイクルの持ち主である G5 と調整する。
4. **送信層**: PR #41 の経路に `PublishAdapter` を挿す。投稿をアカウントに紐付ける。

### next_recommendation
- K4 で確認する。範囲は純粋なドメインだけに収まり、テストも全て通っているので、Codex レビューは不要（TASK の方針どおり）。
- 次の G4 は「Phase 2a2 — `social_accounts` のプラットフォーム拡張と資格情報の型を入れる migration 候補（未適用・使い捨て DB で証明）＋Threads 接続の設計」を提案する。PR #95 は merge 済みなので、G5 と資格情報の型を合意してから始める。
- 並行して、ユーザーに Meta アプリの登録（2-0）を進めてもらう。
- status: review_required / next_owner: chatgpt。STOP for K4。

---

## Final K4 — Phase 2a-1 PASS / provider-domain foundation accepted — 2026-10-07

- verdict: **PASS**.
- accepted source candidate: former PR #103 exact head `2b2f1c1fb4a7188fad5dda3346e802f19bb30983`.
- scope: five new pure provider-domain/test files only; existing runtime/source files were not modified.
- accepted architecture:
  - canonical providers are exactly `x / threads / instagram`;
  - X uses `oauth2_rotating_refresh` + single-call publishing;
  - Threads/Instagram use `long_lived_access` + container-then-publish structure;
  - publication targets carry provider/account/rendered content and are the future retry/idempotency boundary;
  - `published / rejected / uncertain` outcomes preserve fail-closed reconciliation semantics;
  - adapter contracts are definitions only; no provider implementation is wired.
- parity: app/server copies are intentionally separate to avoid Expo/Deno toolchain coupling; parity tests cover exported names, values, behavior and types.
- verification accepted: Deno new tests 13 PASS, shared suite 449 PASS, app suite 226 PASS, Deno/TS/lint/diff checks PASS.
- behavior preservation: no app/runtime importer outside tests; no x-test-post, OAuth, Vault, refresh, deletion, DB schema, publish authority, Auth/onboarding/service-entitlement, workflow, deploy, production or real provider call change.
- G5 PR #95 merged during the task; G4 rebased and reran the full relevant tests afterward. Changed-file overlap with PR #95 was 0.
- CI: Netlify PASS. Vercel failure was deployment rate limiting and is non-blocking under the repository preview policy; no code failure was indicated.
- merge handling: main advanced only in unrelated/control work after the candidate base, and GitHub rejected the stale-base PR merge. K4 therefore integrated the exact five accepted blobs directly to fresh main; each main blob SHA was read back equal to the PR #103 source blob. PR #103 was closed as superseded.
- Codex review: **not required**. This task did not change a live security/runtime boundary.
- AI Lab diary: **記録不要** — provider abstraction groundwork only; no user-facing capability or live provider behavior was added.
- next: proceed to Phase 2a-2 as a source-only schema candidate / disposable-DB proof while keeping production apply and Threads OAuth disabled.

# Previous G4 task history — preserved below

# Previous G4 task — preserved history

- task_id: x-social-mobile-pr76-production-rollout-gate-20261006
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- production_mutation_window: **CLOSED** — 2026-10-06 14:11 JST. G4 PR76 S1–S5 complete and read back (x-test-post v135 code / publish-setting v1 / migration 20261003090000 + one exact history row). G4 performs no further production write.
- priority: highest
- recommended_model: Opus5.5（高）
- type: production rollout gate / read-only preflight / runtime-first deployment plan / migration gate
- source_pr: 76
- merged_main_sha: 3c5f80a61d114d2936b761fc05ee3b3d69e85f63
- production_mutation_allowed: false
- blocks_g3_pr81: true

## Purpose

PR #76 publish-permission source implementation and final independent H2 security review are complete and PASS.
PR #76 was squash-merged to main as:
`3c5f80a61d114d2936b761fc05ee3b3d69e85f63`

This task prepares the exact production rollout and performs only read-only preflight until fresh explicit user approval is obtained.

Approved rollout order from final review:

S0. production read-only preflight
S1. deploy guarded `x-test-post` runtime first
S2. byte/version read-back + old-run drain
S3. apply `20261003090000_social_mobile_publish_permission_boundary.sql`
S4. read back RPC definitions/ACL/effective privileges
S5. deploy `social-mobile-publish-setting`
S6. expose/use app control

PR #81 production rollout is blocked until PR #76's earlier migration version `20261003090000` is safely applied/read back.

## Startup / isolation

1. Read ORCHESTRATION / CURRENT_STATE / final C2/H2 report / this TASK / PR #76 rollout runbook.
2. Use new Mac clean base `/Users/yuya/Developer/kabumori-fresh` with a fresh independent G4 worktree.
3. Confirm main contains merge `3c5f80a61d114d2936b761fc05ee3b3d69e85f63`.
4. Confirm exact merged migration:
   `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql`
5. Confirm exact merged guarded runtime/import graph for `x-test-post`.
6. Do not touch G3/PR81 content-settings files.
7. Do not touch AI Lab PR82 rollout state except read-only coordination where required.
8. No production write/deploy until explicit user approval after the preflight report.

## S0 — mandatory same-day read-only preflight

Read only, no tokens/plaintext/user content beyond bounded operational metadata.

Verify:

### migration/order
- PR76 version `20261003090000` absent from production ledger unless legitimately already applied;
- PR81 `20261003120000` and PR82 `20261004090000` states recorded exactly;
- no duplicate/collision/name mismatch for PR76;
- current ledger schema fits the reviewed migration method;
- do not repair/reorder history.

### current runtime
- current deployed `x-test-post` version/status/verify_jwt;
- prove whether deployed bytes are old unguarded or already exact guarded source;
- identify exact next source bundle and SHA/file list to deploy;
- no unrelated Edge function included.

### production preconditions for migration
- current_user/apply role and owner assumptions;
- `x_legacy_post_account` owner;
- anon/authenticated/service_role inheritance graph;
- relevant default function privileges;
- target RPCs absent unless exact reviewed shape already exists;
- no unexpected same-name overloads;
- current Vault-connected publish-enabled account count and whether any has nonblank `last_connection_error_code` / missing `verified_at`, using counts/booleans only;
- no running/overdue Vault-backed posting work before future S1/S3 cutover;
- do not read token plaintext.

### rollout timing
- determine a safe no-post window;
- read actual platform/function execution constraints needed for the drain step rather than guessing;
- freeze exact S0→S6 operator sequence and abort points.

## Freeze exact production package

Prepare:
- fresh main SHA;
- migration file SHA256;
- exact x-test-post deploy file list + SHA256;
- exact social-mobile-publish-setting deploy file list + SHA256;
- exact read-back queries;
- exact abort/rollback steps already reviewed;
- exact expected production mutations.

Do not modify source unless fresh-main incompatibility is discovered; if so STOP and report.

## Mandatory STOP for user approval

After S0 and package freeze, STOP before S1.

Report:
- production project identity;
- current main SHA;
- migration hash;
- current deployed x-test-post version / guarded-or-old status;
- migration ledger state;
- target RPC state;
- current relevant account readiness aggregate;
- running/overdue count;
- exact proposed S1→S6 operations;
- expected temporary availability effect;
- abort plan;
- confirmation that PR81/PR82 are not bundled.

Then request explicit production rollout approval.

Do not interpret TASK creation or previous generic approvals for AI Lab as authorization for PR76 rollout.

## After explicit approval only

Re-run S0 immediately before first production mutation. If any material state changed, STOP and invalidate approval.

Then execute exactly:

### S1
Deploy only exact guarded `x-test-post` from merged main.
No other function.

### S2
Read back:
- version/status/verify_jwt;
- exact deployed source bytes/import graph;
- confirm guarded runtime is active;
- drain any old execution per reviewed runbook;
- confirm no running/overdue work immediately before migration.

If exact guarded runtime cannot be proven, STOP. No migration.

### S3
Apply only:
`20261003090000_social_mobile_publish_permission_boundary.sql`

Use the reviewed production method only.
No db push/include-all/history repair/unrelated migration.

### S4
Read back:
- exact two RPC signatures;
- SECURITY DEFINER;
- empty search_path;
- owners;
- direct ACL;
- effective EXECUTE:
  - PUBLIC/anon none
  - authenticated toggle only
  - service_role pre-send assertion only
- no unexpected overload/grant;
- migration history exact.

If mismatch: STOP. Do not expose publish-setting.

### S5
Deploy only exact `social-mobile-publish-setting` with its reviewed JWT setting.
Read back exact bytes/version/status/JWT setting.

### S6
Do not enable any specific account or trigger X posting automatically.
App control exposure/real use remains a separate product/QA step unless explicitly included in a later authorization.

## Safety

Forbidden before explicit approval:
- Edge deploy;
- production DDL/history write;
- publish toggle;
- user/account mutation;
- real X;
- Auth/Vault/OAuth/token mutation;
- Cron/scheduler change;
- manual dispatch/backlog/candidate injection.

Always forbidden:
- source redesign;
- migration repair/reorder;
- bundling PR81/PR82;
- token plaintext reads;
- force posting.

## Completion / K4

Report:
- task_id/result
- fresh main
- S0 preflight
- exact hashes
- approval requested/received
- exact production actions if any
- S1/S2/S3/S4/S5 results if authorized
- migration ledger/read-back
- Edge deploy read-back
- production publish toggle/X = 0 unless separately authorized
- remaining blockers
- whether PR76 migration prerequisite is now satisfied for G3/PR81
- next recommendation

Then status -> review_required / next_owner -> chatgpt / STOP for K4.

Review policy:
- final source security review is already complete.
- do not add routine Codex review after exact rollout/read-back PASS.
- only review again if the production read-back reveals a concrete mismatch or source must change.


---

# Previous G4 task — preserved history

- task_id: x-social-mobile-pr76-final-security-corrective-20261005
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: codex
- priority: highest
- recommended_model: Opus5.5（高）
- type: bounded corrective implementation / pre-send readiness parity / SECURITY DEFINER ACL / rollout fail-closed
- target_pr: 76
- reviewed_head: 7f75c07a8c997b6a585e9c86dca01186eeea671f
- production_mutation_allowed: false

## Purpose

Final H2 rereview returned **CHANGES REQUIRED** on PR #76.

The original R1-R5 architecture is substantially closed. Do not redesign the feature. Correct exactly these residual security boundaries:

1. F1: pre-send permission readiness is weaker than toggle-ON readiness.
2. F2: unexpected default/effective EXECUTE grants can survive on the two SECURITY DEFINER functions.
3. F3: documented migration-first rollout leaves a temporary fail-open interval for old runtime.

No production apply/deploy/write or real X operation.

## Startup / isolation

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / this TASK / full latest H2 report.
2. Continue only in the existing isolated G4 worktree for PR #76 if it is still safe/clean. Do not use G3/H1/H2 worktrees.
3. Fetch fresh origin/main. Confirm PR #76 exact head is still `7f75c07a8c997b6a585e9c86dca01186eeea671f` before editing. If moved, STOP.
4. G3 PR #81 remains active. Do not touch its content-settings migration/files.
5. PR #82 is now merged; current main migration is `20261004090000_ai_lab_topic_claims.sql`. H2's older note claiming PR82 still uses 20261003090000 is stale. Current intended versions are:
   - PR76: `20261003090000_social_mobile_publish_permission_boundary.sql`
   - PR81: `20261003120000_social_mobile_content_settings_hardening.sql`
   - merged PR82: `20261004090000_ai_lab_topic_claims.sql`
   Recheck fresh before push.
6. Normal push only; no force push/rebase of other slot work.

## F1 — exact pre-send readiness parity

H2 positively reproduced two states where toggle ON rejects but pre-send authority still returns authorized:

- `connection_status='identity_verified'` but `verified_at IS NULL`
- nonblank `last_connection_error_code` such as `X_ACCESS_TOKEN_UNAUTHORIZED`

Required correction:
- the final authoritative pre-send permission check must reject both;
- use fixed bounded refusal codes; no raw DB/backend text;
- do not weaken intended refreshing/current-token behavior;
- do not rely on the earlier cached `x_legacy_post_account` helper to imply these checks;
- preserve the existing exact-account / brand-live / publish_enabled / identity / credential-reference checks.

Tests must include:
- missing verified_at -> pre-send refused, actual fake X callback 0;
- recorded connection error -> pre-send refused, fake X callback 0;
- normal eligible account still sends through fake callback;
- 401 retry still performs a fresh permission check before any second request;
- OFF remains fail-safe.

Update any documentation claiming full parity so it is exactly true.

## F2 — SECURITY DEFINER exact effective ACL

H2 reproduced:
- creator/apply-role default privileges can grant EXECUTE to an unexpected role;
- current migration revokes only known roles, so the extra grant survives;
- inherited membership can make an app role effectively execute the wrong function.

Correct the migration boundary for exactly:
- `set_social_account_publish_enabled(text,boolean,boolean)`
- `assert_x_publish_permission_for_legacy_post(uuid,text,text)`

Required:
- validate expected creator/owner assumptions;
- inspect/refuse or narrowly normalize unexpected direct EXECUTE grants on these two functions only;
- assert **effective** privileges after creation, including inherited role membership;
- PUBLIC/anon must have none;
- authenticated may execute only the user toggle;
- service_role may execute only the pre-send assertion;
- unrelated roles must not retain effective EXECUTE;
- no global ALTER DEFAULT PRIVILEGES and no role-membership mutation;
- do not broaden table grants;
- fixed empty search_path / schema-qualified references remain.

Add adverse disposable-role tests:
- unexpected default EXECUTE grantee;
- unrelated direct grantee;
- inherited unexpected EXECUTE;
- expected clean role graph;
- reapply/idempotency;
- failure rolls back with no partial security surface.

If exact owner/creator policy cannot be made safe within this migration without broader architecture change, STOP and report rather than expanding scope.

## F3 — rollout must fail closed in every partial state

Current documented migration-first sequence is not accepted.

H2 reproduced:
- migration applied, old sender still active;
- caller can toggle OFF through the new RPC;
- old sender can still start an X request because it has no new pre-send guard.

Produce and test an operational sequence where **all partial rollout states fail closed**.

Preferred direction to prove:
1. deploy guarded runtime first while permission RPC is absent -> Vault-backed sends fail closed with `X_PUBLISH_PERMISSION_UNAVAILABLE`;
2. verify new runtime exact bytes/version/read-back;
3. apply the reviewed permission migration;
4. read back RPC definitions/ACL/effective privileges;
5. only then expose/deploy the user-facing publish-setting Edge/app capability.

Alternative staged-grant design is allowed only if simpler and independently provable, but do not add broad new architecture.

Required tests/proof:
- old runtime + new toggle authority must never be an allowed operational state in the approved runbook;
- new guarded runtime + missing RPC => no X callback;
- new guarded runtime + valid RPC + ON => fake X callback allowed;
- new guarded runtime + OFF/brand-disabled => callback 0;
- rollback/abort points are explicit;
- no Cron/manual backlog/candidate injection required.

No production execution in this task.

## Preserve already-closed behavior

Do not regress:
- auth.uid transactional caller authority;
- owner/admin membership locking;
- brand/account/CAS locking;
- lock ordering/deadlock protection;
- tenant-safe errors;
- fail-safe OFF;
- UI confirmation pinning;
- no service-role user toggle write path;
- no OAuth/Vault revoke on OFF;
- no cancellation claim for already-started X request;
- fresh check before 401 retry;
- current narrow publish-toggle scope.

## Required verification

Run after correction:
- migration source invariants;
- publish-setting Edge logic/http/migration tests;
- actual VaultAccountXAuth tests;
- new F1 adapter callback-zero tests;
- disposable PostgreSQL apply/reapply/behavior/race/E2E;
- new F2 default/effective ACL adverse role cases;
- F3 partial-rollout fail-closed harness;
- mutation suite expanded for F1/F2/F3;
- social-mobile full tests;
- app typecheck/lint;
- changed Deno check/lint;
- relevant x-test-post + shared tests;
- git diff --check;
- secret/scope scan.

Use fake X only. No real X/OpenAI/production.

## PR handling / completion

Amend PR #76 normally and preserve reviewed head in Report.

Report:
- task_id/result
- old/new exact PR head
- F1 correction + executable proof
- F2 correction + effective ACL proof
- F3 exact approved rollout sequence + partial-state proof
- changed_files
- SQL/runtime/app tests
- fresh-main overlap/conflicts
- migration-version check
- production mutation/read/deploy/X = 0
- remaining risks
- safety checks
- next recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

After K4, independent H2 rereview is mandatory.
Recommended rereview model: **Sol（極高）**.

---

# Previous G4 task history — preserved below

# Previous G4 task — preserved history

- task_id: x-social-mobile-pr76-fresh-main-integration-20261005
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: codex
- priority: high
- recommended_model: Sonnet5（高）
- type: integration-only / fresh-main merge / conflict resolution / regression verification
- continues_from: x-social-mobile-publish-toggle-transactional-corrective-20261003
- target_pr: 76
- current_head: fe1e846e59c69b591d29c6d21fc23c7b702d19cd
- production_mutation_allowed: false

## K4 decision / purpose

The transactional publish-toggle corrective itself is accepted as a **review candidate**, but PR #76 is currently not mergeable because main advanced substantially after the branch was created.

Fresh K4 facts:
- PR #76 exact head: `fe1e846e59c69b591d29c6d21fc23c7b702d19cd`
- PR state: open / unmerged / mergeable=false
- current main is 133 commits ahead of the PR base
- overlap across PR #76 files: exactly one file
  - `supabase/tests/migration_source_invariants_test.ts`
- the conflict is logically additive:
  - main has the current RESERVED migration map
  - PR #76 adds:
    `"20261003090000": "social_mobile_publish_permission_boundary"`
- Netlify and Vercel on the current head are green.
- Do NOT change the transactional/auth/publish implementation unless the fresh merge proves a real compatibility issue.

This task exists only to freshen the branch safely before independent Codex security rereview.

## Mandatory startup

1. Read PROJECT_RULES / CLAUDE.md / ORCHESTRATION / CURRENT_STATE / this TASK and the completed corrective Report below.
2. Continue in the existing isolated G4 worktree/checkout only. Do not use or modify G3/H1/H2 worktrees.
3. Fetch fresh `origin/main`.
4. Confirm PR #76 still points at `fe1e846e59c69b591d29c6d21fc23c7b702d19cd` before integration. If head moved, STOP and report.
5. Confirm worktree clean except explicitly owned files.
6. Do not rebase/force-push. Preserve review history with a normal merge commit from fresh `origin/main`.
7. Do not touch PR #81 content-settings files or PR #82 AI Lab claim files.

## Integration

Merge fresh `origin/main` into the PR #76 branch.

Expected conflict:
`supabase/tests/migration_source_invariants_test.ts`

Resolve by preserving **all current main content** and adding/preserving the PR #76 reservation:

`"20261003090000": "social_mobile_publish_permission_boundary"`

Do not remove or rewrite any newer RESERVED entries from main.

If any additional file conflicts appear, STOP before resolving and report exact paths. This TASK is not authority for unrelated conflict resolution.

After merge, verify migration versions are unique and there is no collision with:
- PR #81: `20261003120000_social_mobile_content_settings_hardening.sql`
- latest PR #82 candidate: `20261004090000_ai_lab_topic_claims.sql`
- current main migrations.

## No functional redesign

Do not change:
- `set_social_account_publish_enabled`
- `assert_x_publish_permission_for_legacy_post`
- lock order
- RLS/ACL/security-definer contract
- publish-setting Edge behavior
- VaultAccountXAuth pre-send guard
- UI confirmation pinning
unless the fresh-main integration causes a concrete test/compiler incompatibility.

If a concrete incompatibility appears, STOP and report instead of expanding this bounded task.

## Required regression verification

Run on the fresh-merged branch:

1. migration source invariants
2. publish-setting Edge focused tests
3. publish-setting migration contract tests
4. `vault_account_auth_test.ts`
5. relevant x-test-post + shared brand tests
6. social-mobile app tests
7. app typecheck
8. app lint
9. changed runtime Deno check/lint
10. `social_mobile_publish_permission_run.sh` disposable DB proof if it remains runnable on the fresh tree
11. `git diff --check`
12. secret/scope scan.

Because main advanced 133 commits, do not rely only on previous test results.

If full `x-test-post/index.ts` still has known baseline errors, compare against fresh main and prove no new error from PR #76.

## Safety

Forbidden:
- production migration apply
- db push
- Edge deploy
- publish toggle in production
- production row mutation
- Auth/Vault/Cron mutation
- real X operation
- PR merge.

No other slot files/worktrees/dev servers.

## Completion / K4

Report:
- task_id/result
- old head
- fresh main SHA merged
- conflict paths
- exact conflict resolution
- migration-version collision result
- tests
- new exact PR head
- push/read-back
- production mutation=0
- real X operations=0
- any compatibility issue
- next recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

After K4, independent H1 rereview is mandatory.

Recommended Codex rereview: **Sol（極高）**.

---

# Claude Task 4 — CURRENT TASK

- task_id: x-social-mobile-publish-toggle-transactional-corrective-20261003
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- priority: highest
- recommended_model: Opus5.5（極高）
- type: corrective implementation / authorization transaction / posting safety / concurrency
- continues_from: x-social-mobile-publish-toggle-v1-20261002
- blocked_pr: 76
- reviewed_bad_head: a59a89e9c585fb6e780e1af2ecc898c830f5524e
- production_mutation_allowed: false

## C1 verdict / why this exists

H1 independently reviewed PR #76 and returned **FAIL / CHANGES REQUIRED**. Do not merge or deploy the current PR head.

The critical findings were reproduced against the real candidate code:

1. **R1 P1 — membership authorization is a stale snapshot**
   - caller can be owner/admin when read, lose/demote membership before the service-role PATCH, and the write still succeeds.
   - applies to ON and OFF.
   - this must be fixed by binding current authorization to the privileged state change atomically; another HTTP membership reread is not sufficient.

2. **R2 P1 — brand active/live TOCTOU can still reach a publishable mixed snapshot**
   - toggle can read active/live, brand can then become disabled, and stale toggle can still write ON.
   - the current posting pipeline reuses cached brand context and does not prove a fresh active/live check immediately before the external X send.
   - therefore the previous claim that downstream runtime guard makes this race harmless is false.

3. **R3 P2 — zero-row/no-match reread can leak foreign-tenant state**
   - after account movement/revocation, a service-role reread can return current_enabled from a brand the caller no longer owns.
   - failure must collapse to the same safe not-found/unauthorized shape.

4. **R4 P2 — initial ON readiness and write predicate differ**
   - e.g. platform_user_id empty/whitespace can pass the write-side predicate after an eligible read.
   - current runtime exact-account authority/credential loader has stricter semantics than PR #76.

5. **R5 P2 — UI ON confirmation is not pinned to the account/context shown**
   - confirmation opened for account A can submit for account B if props change.
   - preview/context transitions can leave the confirm action live.

Current PR #76 exact head remains open/unmerged. No production mutation or real X operation was performed.

## Mandatory startup / isolation

1. Read PROJECT_RULES, CLAUDE.md, ORCHESTRATION, CURRENT_STATE, this TASK.
2. Read the full H1 report for `x-social-mobile-pr76-publish-toggle-review-20261002`.
3. Independent G4 worktree/checkout only.
4. Fresh origin/main and PR #76 branch/head.
5. Preserve the original bad-head evidence. Do not force-push away review history without recording exact old/new heads.
6. H2 is reviewing the separate `social_mobile_content_settings` schema prerequisite for PR #78. Do not touch that migration/table/RLS/function or G3 AI-consult files.
7. Existing uncommitted files/worktrees/dev servers from other slots are off-limits.
8. Read the Supabase skill before DB/RPC work.

## Required architecture outcome

The correction must create a **single authoritative server/database transaction boundary** for changing `social_accounts.publish_enabled`.

Do not try to fix R1/R2 with a sequence of extra client/Edge GETs.

Preferred direction:
- Edge verifies bearer/request shape, then invokes a narrowly scoped DB function/RPC under the caller's authenticated JWT where `auth.uid()` is available.
- the DB function locks/reads the exact account + authoritative brand + current membership in one transaction and performs the state transition only if all conditions are still true.
- if repository conventions prove a safer equivalent design, use it, but the same atomic guarantees must be demonstrated.

Do not grant general direct UPDATE rights on `social_accounts`.
Do not use client-supplied user_id/brand_id as authority.
Do not create a generic admin/service-role mutation surface.

A new migration/RPC is allowed in this corrective task **only for this publish-toggle boundary** and must be reviewed independently before any production apply.

## Atomic authorization requirements

For every ON/OFF state change, inside the same transactional authority boundary:

- identify caller from `auth.uid()` / verified JWT context
- locate exact social account
- derive its authoritative brand_id
- prove a current membership for that exact caller+brand
- role must be owner/admin
- bind expected_current_enabled CAS
- prevent account movement/brand movement/role demotion from succeeding on stale authority
- return no foreign account/brand state after authority loss
- safe not-found/forbidden responses must not become tenant existence/state oracles.

Define lock order deliberately and test deadlock/concurrency behavior. Reuse existing lock order conventions where relevant.

## ON requirements

ON is high-risk and must atomically bind at minimum:

- exact account/platform X
- exact current brand
- current brand active
- current brand publish_mode live
- current owner/admin membership
- current publish_enabled = expected
- connection_status exact usable state
- platform_user_id nonempty after trim
- verified_at present
- required credential references present
- references satisfy any non-plaintext structural constraints already enforced by the exact-account runtime helper (e.g. not equal/shared where source can prove this without exposing secrets)
- no current connection error
- any relevant account deletion/busy lifecycle guard.

Do not claim token validity merely from references; actual credential loader/runtime may still fail safely.

The read-side and mutation-side ON semantics must be the same authoritative transaction, not two divergent predicates.

## OFF requirements

OFF remains fail-safe:
- current owner/admin + exact account + expected state required
- must work even if connection degraded, credential refs missing, brand inactive/disabled
- must not revoke OAuth, delete Vault material, delete posts/history, change Auth/common-account state
- must not promise already in-flight external sends are cancelled unless a separately proven mechanism actually guarantees that.

Update UX wording accordingly.

## Runtime pre-send safety / R2 closure

The actual X publishing path must have a **fresh authoritative permission check close enough to the external X send** to make stale cached brand/account context unable to authorize a new send.

Inspect all actual X send paths for social-mobile/account-scoped publishing, including the scheduler/dispatcher and Vault-backed send adapter.

Required invariant before starting a new external X write:
- current brand still active/live
- current social account still publish_enabled
- current account is still the exact authorized/verified account with valid structural readiness
- deletion/busy/reconnect-invalid state cannot pass.

Prefer one reusable server-side exact-account publish-authority read/RPC rather than ad-hoc duplicated HTTP reads.

Be explicit about in-flight semantics:
- define the point after which a post is considered already in-flight
- do not claim OFF can recall an X request already sent
- ensure a new send cannot begin after OFF/brand disable has become authoritative.

Add adverse interleaving tests that reproduce H1's R2 mixed-snapshot schedule and prove it now fails closed.

Do not broaden into a scheduler redesign unrelated to this permission invariant.

## R3 safe reread/error semantics

Any conflict/no-match/after-write verification path must:
- remain bound to the same caller/account/brand authority
- not service-role reread foreign current_enabled or other state and return it
- collapse moved/revoked/foreign rows to the safe not-found/unauthorized result.

Test account brand transfer/deletion/membership revocation between stages.

## R4 readiness semantic alignment

Align all ON checks with the real runtime exact-account authority contract where applicable:
- trim/nonempty platform_user_id
- exact connection state
- verified_at
- credential ref structure
- last connection error
- any existing refresh/authority state that is required to safely claim the account is eligible.

Do not overclaim what can only be checked when loading credentials.
Document what ON means: "permission enabled and structurally eligible", not "future X send guaranteed".

## R5 client confirmation pinning

Fix the client so an ON confirmation is bound to the exact context the user saw:
- account id
- expected current enabled value
- eligibility/preview context
- auth/workspace context if relevant.

If any of those change before confirm:
- invalidate/close the confirmation
- do not send a request.

At submit, recheck preview/action eligibility.
Add executed regressions for:
- A confirmation then props switch to B
- preview becomes true
- account/current state changes
- cancel
- double tap/in-flight.

Do not spend time on visual redesign.

## Lower-risk hardening from H1

Address when bounded and sensible:
- clarify raw JSON "exact keys" claim; if duplicate raw-key rejection is not implemented, do not claim it
- bound request allocation safely if practical; do not falsely describe char check as a streaming byte cap
- revise OFF copy from 「いつでもONに戻せます」 to conditional wording
- explain OFF does not revoke/delete and cannot recall an already-sent X request
- clean the five `require-await` test lint findings if they are in the amended PR scope.

These are secondary; do not let them distract from R1/R2.

## Migration / RPC safety

If a new migration/RPC is introduced:
- unique timestamped migration file; do not edit unrelated historical migrations
- narrow function signature
- fixed `search_path`
- explicit SECURITY DEFINER/INVOKER reasoning
- least privilege grants
- revoke from anon/public as appropriate
- authenticated caller only if auth.uid semantics are required
- no service_role-only hidden user identity argument
- tenant/role/CAS/state validation inside transaction
- deterministic bounded return shape/error codes
- no secrets/tokens in return/logs
- migration must be locally apply/reapply tested where safe
- no production apply in G4.

Check compatibility with current production schema read-only if possible; do not mutate production.

## Tests

Must include regressions that fail on original PR #76 behavior and pass on corrective candidate:

### Authorization/concurrency
- owner -> membership removed before write: rejected, no mutation
- owner -> demoted viewer/member before write: rejected
- account moves A->B: no state leak/no mutation
- expected state changes concurrently: stale/no mutation
- brand active/live -> disabled before ON: no ON
- adverse mixed snapshot from H1 R2: no external-send authorization
- concurrent ON/OFF races deterministic/fail-safe
- account deletion/busy interaction
- lock ordering / deadlock-safe bounded behavior.

### ON readiness
- blank/whitespace platform_user_id rejected atomically
- null/missing verification fields rejected
- invalid/missing/equal/shared credential references handled consistently with structural runtime authority contract
- reconnect/error state rejected
- valid owner/admin eligible path succeeds.

### OFF
- authorized owner/admin can disable with broken credentials/inactive brand
- no revoke/delete/token/history/Auth side effect
- new sends after authoritative OFF cannot begin
- already in-flight semantics are truthful/tested as far as local harness permits.

### Runtime publish guard
- stale cached brand context cannot authorize a new X send after disable
- stale cached account ON cannot authorize after OFF
- exact account mismatch fails
- no real X API call in tests.

### Client
- confirmation pinned to A; props B -> zero request
- preview transition -> zero request
- expected state transition -> reconfirm
- normal ON confirmation/cancel/loading
- OFF path remains usable.

Run:
- corrective focused tests
- PR #76 existing tests
- relevant publish guard/token loader/dispatch tests
- full social-mobile tests
- Deno check/lint for changed runtime/tests
- typecheck/lint
- diff check
- secret/scope scan.

## Explicit non-scope

- G3 AI consultation/content settings/persona
- H2 content-settings schema prerequisite migration
- past-post learning
- account deletion/common-account lifecycle
- broad scheduler redesign
- provider OAuth reconnect
- UI redesign
- production deploy/apply/toggle
- real X operation.

## Production safety

Source/tests/PR amendment only.

Forbidden:
- production migration/RPC apply
- Edge deploy
- production publish toggle
- DB row mutation
- real X post/auth/revoke
- Vault/Auth mutation
- Cron mutation.

## Completion / K4

Report:
- task_id/result
- architecture chosen
- original H1 findings R1–R5 disposition
- transaction/lock/authorization model
- runtime fresh pre-send guard and exact in-flight semantics
- ON/OFF semantics
- tenant-safe error behavior
- migration/RPC changed files
- client confirmation pinning
- tests/adversarial interleavings
- production read/mutation
- real X operations
- old PR head and new exact head
- commit/push/PR state
- remaining risks
- safety checks
- next recommendation.

Then status -> review_required, next_owner -> chatgpt, STOP for K4.

Because this task changes migration/RPC/auth/concurrency/X pre-send safety, K4 must allocate a fresh independent Codex rereview before merge.

Recommended rereview model: **Sol（極高）**.

---

# Claude Task 4 — CURRENT TASK

- task_id: x-social-mobile-publish-toggle-v1-20261002
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: codex
- priority: high
- recommended_model: Opus5.5（高）
- type: feature implementation / posting-permission boundary / authenticated Edge Function
- production_mutation_allowed: false

## Product goal

X自動投稿アプリで、現在は表示だけしている「自動投稿 ON / OFF」を、ユーザーが安全に切り替えられる実機能にする。

This task runs in parallel with G3 `x-social-mobile-ai-consult-v1-20261002`.

G3 owns:
- AI consultation
- content settings/persona
- consultation Edge/API boundary

G4 MUST NOT touch those areas.

G4 owns only the posting-permission toggle for an exact connected social account.

## Why this is a good parallel task

Fresh production/read-only inspection confirms:
- `public.social_accounts.publish_enabled boolean not null` already exists and is the current runtime truth for posting enabled/disabled.
- authenticated clients currently have SELECT only; there is no direct UPDATE policy/grant.
- app already maps `publish_enabled=false` -> paused and true -> active.
- current account/home UI can display ON/OFF but cannot change it.
- no new DB column/table is required.
- common-account PR #70 migration work remains separate.

Therefore implement a narrow authenticated server-side write boundary using the existing schema, with **no migration**.

## Mandatory startup / isolation

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout.
3. Fresh `origin/main`.
4. Confirm G3 current task is `x-social-mobile-ai-consult-v1-20261002`; do not edit:
   - `apps/social-mobile/src/app/(tabs)/consult.tsx`
   - `apps/social-mobile/src/domain/content-settings*`
   - `apps/social-mobile/src/data/content-settings-repository.ts`
   - G3's consultation Edge Function/tests.
5. Confirm G5/H1 common-account PR #70 files do not overlap intended G4 files.
6. Do not reuse another slot's .env, simulator, Metro, untracked files, worktree or branch.
7. Read the Supabase skill and inspect existing social-mobile Edge Function Auth/membership patterns before implementation.
8. **No DB migration / RLS / grant change in this TASK.**

## Current production facts to preserve

Read-only inspection showed:
- social account connection states include `authorization_pending` and `identity_verified`.
- existing live accounts may have `publish_enabled=true/false`.
- `brand_memberships.role` supports `owner/admin/member/viewer`.
- current user-facing memberships observed are owners, but implementation must define role handling safely.
- `brands` has `is_active` and `publish_mode` including live/disabled.
- authenticated role has SELECT on social_accounts, not UPDATE.

Do not weaken RLS or add direct client write access just to make the toggle easy.

## Required architecture

Implement a dedicated authenticated server-side action for the exact account, preferably a narrowly scoped Edge Function such as:

`social-mobile-publish-setting`

or follow the repository's existing naming convention if a better one exists.

Client request conceptually:
- `social_account_id`
- `desired_enabled: boolean`
- `expected_current_enabled: boolean`

Do NOT trust a client-supplied brand id as authorization.

Server derives/validates:
1. valid caller JWT/user
2. exact social account row by id
3. account's actual `brand_id`
4. caller membership for that exact brand
5. permitted role
6. account/platform/connection readiness
7. current publish state
8. stale-state conflict protection.

## Authorization

Fail closed.

Minimum policy:
- unauthenticated: reject
- no membership: reject
- `viewer`: reject
- `member`: reject for v1 unless existing product policy clearly documents publish-control permission; default to owner/admin only
- `owner` / `admin`: eligible subject to readiness checks

Do not use unmerged common-account/service-entitlement semantics from PR #70.

Do not allow one user's membership to toggle an account in another brand.

Do not expose service-role credentials to the app.

## ON behavior — strict enable gate

Turning **ON** creates permission for future scheduled work to actually publish, so it must be stricter than OFF.

Enable only if all source-of-truth checks pass:

- exact social account exists
- platform is X for this v1
- account's brand exists
- brand `is_active = true`
- brand `publish_mode = 'live'`
- connection status is the exact verified/usable state used by the current posting pipeline (production currently uses `identity_verified`; inspect runtime contract and do not guess)
- `verified_at` is present if runtime uses it as verification evidence
- required Vault credential **references** exist for the account
- do not read/log/return Vault plaintext
- no known connection state says reconnect/authorization pending
- caller is allowed owner/admin
- request's expected current value matches the current row

If any prerequisite fails:
- do not toggle
- return a bounded user-safe error code/message
- advise reconnect where appropriate
- do not attempt X auth/post/revoke.

Do not “repair” credentials in this endpoint.

## OFF behavior — safety first

Turning **OFF** should be easy and fail safe.

An authorized owner/admin should be able to set `publish_enabled=false` even if:
- X connection is degraded
- tokens are missing
- brand is inactive

because disabling future publishing is the safer direction.

Still require:
- valid caller
- exact account/brand membership
- stale-state protection.

OFF must NOT:
- revoke X OAuth
- delete credentials
- delete scheduled posts
- delete drafts/history
- sign the user out
- alter common-account state.

It only disables the permission gate.

## Concurrency / stale UI

Use compare-and-set semantics.

The client sends the state it believes is current.

The server must not silently overwrite a state that changed after the screen loaded.

Expected behavior:
- expected matches -> perform/no-op safely
- expected mismatches -> return conflict/stale result
- client reloads current snapshot and asks user again if needed.

Avoid double-tap races:
- disable control while request is in flight
- server side conditional update on exact id + expected current value
- zero-row update after authorization/read => treat as stale/conflict, not success.

## Exact mutation boundary

The action may mutate only:

`public.social_accounts.publish_enabled`

(and an existing generic `updated_at` only if the repository's established update mechanism/trigger naturally does so).

It must NOT mutate:
- connection_status
- verified_at
- platform_user_id
- oauth_client_ref
- Vault refs
- Vault contents
- brands
- brand_memberships
- scheduled_posts
- post_execution_logs
- Auth
- common-account/service-entitlement tables
- content settings/persona
- scheduler/Cron state.

No X API call.

## Client UX — functional only

UI is going to be redesigned later. Do not polish.

Place the control where account-specific operational settings already belong, preferably:
- `apps/social-mobile/src/app/accounts/[id].tsx`

Functional minimum:
- clearly show current status
- button/control to turn ON or OFF
- ON requires an explicit confirmation explaining:
  「ONにすると、条件を満たした投稿予定は自動でXへ投稿される可能性があります」
  or equivalent truthful wording
- OFF should clearly say future automatic publishing is stopped; do not claim queued data is deleted
- loading state
- success state
- safe error state
- stale conflict -> reload/reconfirm
- disconnected/not-verified state -> ON disabled/explained; OFF remains available if currently ON
- after success, reload shared data so Home/Accounts reflect source-of-truth state.

Do not spend time on visual redesign, header polish, animations, spacing, icons, etc.

## Relationship to approvalMode

Keep these two concepts separate:

- `social_accounts.publish_enabled` = whether this exact account is allowed to publish automatically
- `content settings.approvalMode` = whether content requires human review

This G4 task changes **only publish_enabled**.

Do not edit content settings or AI consultation.

Do not treat `auto_post_preference` as permission to toggle publish_enabled.

## Tests

### Edge/server

At minimum:
- unauthenticated -> rejected
- account not found -> safe 404/blocked
- no membership -> rejected
- viewer/member -> rejected by v1 policy
- owner/admin exact brand -> allowed
- cross-brand account id -> rejected
- ON blocked for authorization_pending/not verified
- ON blocked if brand inactive
- ON blocked if brand publish_mode disabled
- ON blocked if required credential references absent
- ON never reads/returns Vault plaintext
- OFF allowed despite degraded connection for authorized owner/admin
- stale expected state -> conflict/no mutation
- duplicate/same-state request is deterministic/no harmful extra mutation
- only publish_enabled changes
- no scheduled_posts/post logs/Auth/Vault/content settings/common-account mutation
- no X API/network call
- secrets/JWT not logged or returned
- method/content-type/input validation
- bounded safe error codes.

### Client/domain

- current ON/OFF renders truthfully
- ON confirmation is required
- cancel confirmation -> no request
- OFF wording does not imply deletion/revoke
- request in flight prevents duplicate taps
- success reloads snapshot
- stale conflict reloads and does not pretend success
- disconnected account cannot be enabled
- currently-ON degraded account can still be disabled
- account id passed is exact selected account
- no G3 content-settings/consultation code imported or altered.

Run:
- focused new tests
- full social-mobile tests
- relevant Edge/shared tests
- typecheck/lint/runtime checks per repo
- `git diff --check`
- secret scan
- scope diff.

## Local verification

Use G4-owned mock/local environment.

Verify functionally:
1. OFF account -> press ON -> confirmation appears
2. cancel -> no state change
3. confirm against mocked eligible account -> UI becomes ON after reload
4. ON -> OFF -> state becomes OFF
5. authorization_pending account cannot be enabled
6. stale-state response is shown safely
7. no post is created/sent
8. no X auth/revoke occurs.

No real X post or production toggle is needed for this source task.

## DB / migration rule

**No migration, RLS change or grant change.**

If implementation cannot safely provide the write boundary without schema/RPC changes:
- STOP
- report exact blocker
- do not modify PR #70 or create a migration.

## Explicit non-scope

- AI consultation / persona
- past-post learning
- AI post generation
- edit/regenerate/approve post content
- retry failed scheduled post
- scheduler/Cron changes
- X OAuth connect/reconnect
- token refresh logic
- account deletion
- common account/service entitlement
- new DB schema
- major UI redesign
- production deploy.

## Production / safety

Source + tests + PR only.

Forbidden:
- production Edge deploy
- production publish toggle
- real X post
- real X auth/revoke
- Vault mutation
- Auth mutation
- DB migration/apply
- Cron/scheduler mutation.

Production mutation = 0.

## Completion / K4

Report:
- task_id
- result
- endpoint/architecture
- exact authorization policy
- enable prerequisites
- disable semantics
- stale/CAS behavior
- exact mutation boundary
- changed_files
- tests
- local verification
- proof G3 consultation files untouched
- DB migration = none
- production mutation = 0
- real X operations = 0
- commit / push / PR
- remaining issues
- safety checks
- next recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.

### Expected review

This is a posting-permission/security boundary. K4 should normally allocate a focused Codex review before merge.

Recommended Codex model: **Sol（高）**.

Do not merge/deploy solely from Claude's self-review.

---

# Claude Task 4

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- purpose: iOSのX OAuth接続時に前回ログインしたXアカウントが再利用され、複数Xアカウント利用者が接続先を切り替えにくい問題を、本番向けに安全に修正する。

## Why this should be fixed

The issue was reproduced during E3 preparation:
- the X login sheet remembered the previously authenticated X account.
- the operator could not reliably switch to a different X account.
- a local-only temporary change that opened a clean login session allowed the intended disposable account to be selected.
- this can affect real users who own multiple X accounts and can lead them to authorize the wrong account.

Current source uses:
`WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri)`
inside:
`apps/social-mobile/src/features/x-connect/use-x-connect.ts`

The installed app uses Expo 57 / `expo-web-browser ~57.0.3`.

Expo's current WebBrowser API supports an iOS auth-session option `preferEphemeralSession` that requests a private authentication session so normal browser cookies are not shared. Verify the installed type/API before implementation; do not add undocumented X query parameters.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout; never use G3's worktree or simulator session.
3. Fresh `origin/main`.
4. Confirm G3 is operational E3 verification only and is not editing `apps/social-mobile/src/features/x-connect/use-x-connect.ts` or related tests.
5. Inspect the installed `expo-web-browser` type/API for Expo 57 before editing.
6. Do not use or mutate the disposable E3 account, protected production accounts, Vault, DB, Auth data, or X provider settings.

## Scope

Primary allowed scope:
- `apps/social-mobile/src/features/x-connect/use-x-connect.ts`
- narrowly related social-mobile tests
- onboarding copy only if needed to explain account choice

Do not change:
- server-side X OAuth contract
- PKCE/state validation
- callback ownership binding
- Supabase Edge Functions
- DB/RLS/RPC/migrations
- Vault/token storage
- account deletion
- scheduler/posting paths
- production feature flags

## Required behavior

Goal: when a user chooses to connect or reconnect an X account on iOS, the auth session should not silently inherit a previously logged-in X identity in a way that prevents account choice.

Preferred implementation candidate:
- request an ephemeral/private auth session for the X connect flow on iOS using the supported Expo WebBrowser option.
- keep Android/Web behavior unchanged unless the installed API provides an equally documented and safe equivalent.

Requirements:
1. Preserve current PKCE, state, redirect URI and callback validation exactly.
2. Do not clear global Safari/browser cookies.
3. Do not sign the user out of unrelated web sessions.
4. Do not add undocumented X authorization parameters.
5. Do not weaken the server-side duplicate-X-account protection.
6. Cancel/dismiss/retry behavior must remain truthful.
7. Reconnect flow must use the same safe account-selection behavior.
8. No real X post or production credential mutation.

## UX

If needed, add a short truthful hint near the X connect button such as:
- the user will be asked to sign in/select the X account they want to connect.
Do not promise that every browser/platform will always show an account chooser if the platform cannot guarantee that.

## Tests

Add/adjust focused tests to prove at minimum:
- iOS X connect requests the supported private/ephemeral auth-session behavior.
- Android/Web do not receive an unsupported iOS-only behavioral change.
- redirect URI, state, PKCE challenge/verifier and callback parser remain unchanged.
- cancel/dismiss/success/error state behavior remains unchanged.
- duplicate-X-account server protection remains untouched.
- no global cookie clearing/browser data deletion is introduced.

Run:
- social-mobile tests
- typecheck
- lint
- relevant Expo export/config check if available
- diff/secret checks

No EAS build unless a native rebuild is actually required to test the API behavior. Prefer local iOS Simulator verification.

## Local visual/E2E verification

Use a local simulator/test environment only:
- confirm the X auth sheet no longer auto-reuses the prior X login in the problematic way.
- confirm the user can intentionally authenticate a different X account.
- do not use protected production posting accounts for this test.
- do not perform a real X post.

If reliable provider-side testing would require touching production credentials/accounts, STOP and report rather than doing so.

## Completion / K4

Report:
- task_id
- result
- root cause
- exact source behavior changed
- changed_files
- tests
- local simulator result
- commit_hash
- push/PR
- production mutation = 0
- remaining issues / platform caveats
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K4.

Because this changes an OAuth/authentication boundary, ChatGPT will decide at K4 whether focused Codex review is required before merge.


## Report

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- result: **PASS（source・自動テスト）／実機でのXアカウント切替確認は未実施（操作者の確認が必要）**。PR #65（未merge）。
- model_used: Sonnet 5.5
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（G3のworktree・Simulatorは使っていない。G3はE3の運用確認のみで、`use-x-connect.ts`と関連テストは編集していないことを確認）

### root cause

`use-x-connect.ts`が`WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri)`をオプションなしで呼んでいた。iOSではこれが`ASWebAuthenticationSession`で、Safariのcookieを共有するため、直前にログインしたXアカウントがそのまま再利用され、別のアカウントを選べなかった。

### exact source behavior changed

- インストール済み`expo-web-browser 57.0.3`の型定義で、`AuthSessionOpenOptions.preferEphemeralSession`（`@platform ios`、既定`false`、「ブラウザが対応するかは利用者の既定ブラウザ次第」と明記）を確認。ネイティブ側も`ASWebAuthenticationSession.prefersEphemeralWebBrowserSession`へ配線済み（カスタムスキームのcallbackでも設定される）。未文書のXパラメータは追加していない。
- **iOSだけ**、この第3引数`{ preferEphemeralSession: true }`を渡す。Android/Webは従来どおり2引数のまま（オプションなし）。再接続も同じhookなので同じ挙動になる。
- 接続画面（アカウント画面・オンボーディングの接続ステップ）に、真実に沿った案内を1行追加: 「接続時に、Xのログイン画面で接続したいアカウントを選んで（またはログインして）ください。ブラウザの状態によっては、以前ログインしたアカウントが表示される場合があります。」（アカウント選択画面が必ず出るとは約束していない）。
- 変更していないもの: state・PKCE・redirect URI検証・`x.com`ホスト許可・callback解析・リクエスト本文・cancel/dismiss/success/errorの状態処理、サーバー側のX重複アカウント保護、Edge Function、DB、Vault、アプリログイン用のprovider認証（`auth-client-flows.ts`）。cookie・ブラウザデータの削除は行っていない。

### changed_files

新規: `apps/social-mobile/src/features/x-connect/auth-session-options.ts`、`apps/social-mobile/tests/x-connect-auth-session.test.mjs`
変更: `apps/social-mobile/src/features/x-connect/use-x-connect.ts`（3引数化、+5/-1）、`apps/social-mobile/src/app/accounts/index.tsx`（案内1行）、`apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`（案内1行）
サーバー・DB・Edge Function・G3のテストファイルの変更なし。onboardingの既存テストはモジュールのimportを厳密に検査するため、新規モジュールをimportせず案内文はリテラルにした。

### tests

- 新規`x-connect-auth-session.test.mjs`: **10/10 pass**（iOSは指定あり／Android・Web・その他は指定なし／型定義にiOS専用オプションが存在／hookがそのオプションだけを渡す／OAuth契約の各行が不変／状態処理が不変／cookie削除・追加パラメータなし／アプリログイン側が不変／案内文が両画面にあり「選べる」と約束していない）。変異検査: hookからオプションを外すとテストが失敗することを確認し、元に戻した。
- `npm test`（social-mobile全体）: **99/99 pass**。data-view＋post-interaction: 22/22 pass。
- `tsc --noEmit`: PASS。`expo lint`: PASS。Expo web export: 成功（895 modules）。Expo iOS export: 成功（1224 modules）。
- `git diff --check`: PASS。secret scan: 該当なし。
- EAS buildなし。ネイティブ側にオプションが既にあるため、この変更でネイティブ再ビルドは不要と判断（実機の開発ビルドが同じ`expo-web-browser`から作られている前提）。

### local simulator result

**未実施**。理由: (1) 起動中のSimulator（iPhone 17 Pro）はG3のE3検証の環境で、使わない指示のため使っていない。(2) 「別のXアカウントを実際に選べるか」の確認は、実際のXログイン画面へXアカウントの認証情報を入力する必要があり、エージェントは認証情報を入力しない（TASKも本番・保護アカウントの使用を禁止）。したがって、プロバイダ側の実際の挙動（ログイン画面が既ログインを引き継がないこと）は**未確認**。
- 操作者の確認手順（案）: このブランチのJSを実機/Simulatorの開発ビルドに読み込み、Safariで複数のXアカウントのうち1つにログインした状態でアカウント画面の「Xアカウントを再接続」を押し、認証シートが既存のログインを引き継がずログイン画面から始まる（別のアカウントで認証できる）ことを確認する。使用するのは使い捨てアカウントのみ、投稿はしない。

### commit_hash

`e8a7785`（PR #65、ブランチ`g4/x-connect-ephemeral-auth-session-20261001`）。このReportのcommitはmainに別途push。

### push/PR

ブランチをpush済み。PR #65（OPEN、MERGEABLE）: https://github.com/anohi-memories/kabumori/pull/65 。未merge。

### production mutation

**0件**。deploy・DB/RLS/RPC/migration・Auth/Vault変更・X投稿・本番アカウント操作はいずれも無し。

### remaining issues / platform caveats

1. 実機でのプロバイダ側の挙動が未確認（上記）。`preferEphemeralSession`は「要求」で、ユーザーの既定ブラウザによっては尊重されない可能性がある（公式ドキュメントに明記）。案内文はそれに合わせて約束をしていない。
2. 副作用: 非共有セッションのため、接続のたびにXへログインし直しになる（Safariのログイン状態・SSOは使われない）。パスワードマネージャーの自動入力の使い勝手は端末設定によって変わる可能性がある。
3. Android/Webは今回のスコープ外（同等の文書化された手段がないため従来どおり）。Android側で同じ問題が出る場合は別TASKが必要。
4. アプリログイン用のX認証（G3所有）は別の信頼ステップで、同様のアカウント再利用が起こりうるが、TASKの範囲外のため変更していない。

### safety checks

- OAuth/PKCE/state/redirect/callback検証・サーバー側の重複アカウント保護・秘密情報の取り扱いは変更なし（テストで固定）。
- 未文書のX認可パラメータ、cookie・ブラウザデータ削除、他サービスからのサインアウトは導入していない。
- 本番資格情報・保護アカウント・使い捨てE3アカウントに触れていない。実際のX投稿なし。

### next recommendation

1. OAuth/認証境界の変更なので、K4でCodexの焦点レビューの要否を判断（変更は約6行で、境界の検証ロジックは不変）。
2. 操作者が実機（または自分のSimulator）で、上記の手順どおり使い捨てアカウント同士の切替を確認する。確認後にmerge。
3. 問題がなければ、E3の再開・以降のXアカウント接続の手順に「毎回Xへログインし直しになる」旨を反映する。

## Completion

- status -> review_required
- next_owner -> chatgpt


## K4 follow-up — operator provider-side E2E only

- K4 verdict: **HOLD — source/review PASS, provider-side operator E2E remains**.
- PR #65 exact head remains `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`, open and mergeable.
- Prior C1/source-security review already accepted this exact head; no additional Codex review is required unless runtime source changes.
- Fresh main has advanced since the PR base, but none of the five PR #65 source/test files overlap main-side changes.
- Do not change source unless the E2E exposes a real defect.

### Goal

Prepare and guide a safe operator-side iOS test proving:
1. a previously logged-in X identity is not silently forced on the posting-account connect flow,
2. the operator can authenticate a different disposable X account,
3. cancel -> retry remains usable,
4. reconnect uses the same behavior,
5. no real X post occurs.

### Environment isolation

- Use the dedicated G4 worktree/checkout only.
- Do not use G3's worktree, branch, or active simulator process.
- If no separate simulator/device is safely available, STOP and report instead of sharing G3's environment.
- Load PR #65 JS/source into a compatible existing development build. Do not rebuild unless actually necessary.
- Do not use protected production posting accounts.
- Use only disposable/test X identities controlled by the operator.

### Operator interaction boundary

Claude may:
- prepare the app/simulator to the point immediately before X login/account selection,
- tell the operator exactly what to tap,
- observe app-side state after the operator action,
- inspect non-secret logs/results.

Claude must NOT:
- type X passwords, passkeys, 2FA codes, recovery codes, or other credentials,
- approve X authorization on the operator's behalf,
- clear global browser cookies,
- modify provider settings,
- post to X.

### PASS criteria

PASS only if the operator confirms/observes:
- starting from a normal browser state with X account A signed in, the posting-account connect/reconnect flow does not silently complete as A without an opportunity to authenticate,
- account B can be authenticated intentionally in the auth session,
- cancellation returns safely and retry works,
- reconnect follows the same path,
- no real post is created.

Because `preferEphemeralSession` is a best-effort platform/browser request, it is acceptable if the UI is a fresh login screen rather than a literal account chooser. The required result is that the previous normal-browser session is not silently reused in a way that prevents choosing/authenticating another account.

### After PASS

- Do not merge PR #65 in G4.
- Record exact operator-observed behavior, device/simulator context, cancel/retry/reconnect result, and real X posts = 0.
- Set status -> review_required, next_owner -> chatgpt and STOP for another K4.
- ChatGPT will perform the final merge/no-race decision.

### If FAIL

- Preserve evidence and STOP.
- Do not improvise new OAuth parameters or cookie clearing.
- If a source correction is required, report the smallest proposed change first; runtime-source change will require another focused review.

Recommended model: **Sonnet5（高）**.


## Report — operator E2E follow-up (2026-10-01)

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- result: **STOP — 安全に使える独立した検証環境がなく、操作者のE2Eを開始できない**。PR #65のsourceは変更していない。
- model_used: Sonnet 5.5
- PR #65: exact head `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`（OPEN、MERGEABLE、2 commits、変更は同じ5ファイルのみ）。mergeしていない（TASKの指示どおり）。

### 確認したこと（読み取りのみ）

- 利用可能なSimulatorは `iPhone 17 Pro`（Booted）が1台＝G3のE3検証の環境のため使っていない。他の機種は Shutdown で、アプリが入っていない。
- このMacにある `SocialOperations.app` のビルド（DerivedData）は実機向け（`iphoneos`）で、9/20のもの。**Simulatorで起動できる開発ビルドは存在しない**。Simulator用にするにはネイティブビルドが必要で、TASKは「実際に必要でない限り再ビルドしない」としている。
- このworktreeにも共有checkoutにも `apps/social-mobile/.env` が無く、アプリを実データ接続（Supabaseのログイン・接続画面）まで進める公開設定値（`EXPO_PUBLIC_SUPABASE_URL`/publishable key/`EXPO_PUBLIC_DATA_SOURCE`）がこの環境に無い。G3のworktreeや環境から流用することは、環境分離のルール上しない。
- 接続ボタンまで到達するには、アプリへのログイン（メール/パスワード等）と、Xのログイン（アカウントA・Bの認証情報）が必要で、いずれもエージェントは入力しない。

### 選択肢（操作者の判断が必要）

- **A. 実機iPhone＋既存の開発ビルド（推奨・最短）**: 実機の開発クライアントに、PR #65 head のJSを読み込む。必要なのは、操作者が実機の開発ビルドで使っている公開設定値（`.env`相当、秘密ではないpublishable keyのみ）をこのworktreeに置くことの許可と、他のMetro（G1・実機で使用中のもの）を止めるタイミングの調整。Metroは自分のworktree（独立したnode_modules）から1つだけ起動する。
- **B. 新しいSimulatorにネイティブ開発ビルドを作る**: `iPhone 17e`などの未使用機種に開発ビルドを入れる。時間がかかり、TASKが避けている再ビルドに当たる。
- **C. 操作者がローカルで自分で確認**: このPRのブランチのJSを、操作者の普段の開発環境で読み込んで、下の手順で確認する。結果（PASS/FAIL）だけをChatGPT/私に共有する。

### 操作者の確認手順（A/Cで共通、使い捨てのXアカウントA・Bのみ）

1. 端末のSafariで、使い捨てXアカウントAにログインしておく（通常のブラウザの状態）。
2. アプリのアカウント画面（またはオンボーディング）で「Xアカウントを再接続」を押す。
3. 認証シートが、Aで自動的に進まず、ログイン画面から始まるか（Aを引き継がず、別のアカウントBで認証できるか）を確認する。操作者がBで認証する。
4. 別回で、認証シートを閉じて（キャンセル）→ もう一度押して再試行できるか確認する。
5. 再接続（接続済みの状態から再度押す）でも、2〜3と同じ挙動か確認する。
6. 実際のXへの投稿が作成されていないことを確認する（投稿を行う操作はしない）。

### production mutation / X posts

production mutation 0 / 実X投稿 0（今回は読み取りと文書更新のみ）。

### 次の推奨

操作者が A / B / C のどれかを選ぶ。Aの場合は、公開設定値の置き場所（このworktreeの`apps/social-mobile/.env`、未追跡）の許可と、Metroを使う順番の調整を教えてもらえれば、私がPR #65 head のJSを用意して、操作を1手ずつ案内する。

## Completion

- status -> review_required
- next_owner -> chatgpt


## K4 follow-up 2 — isolated simulator provider proof

- K4 verdict: **HOLD — source/review still PASS; prior follow-up stopped only because no isolated runnable native environment existed**.
- PR #65 exact head remains `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`, open / mergeable.
- GitHub checks are green and fresh main has no overlap with PR #65's five source/test files.
- G3 is now Final K3 done and its temporary simulator harness/app was removed. Do not reuse G3 files/worktree.
- A native Simulator build is now considered **actually necessary** for the remaining provider proof and is authorized in this G4 follow-up.
- Recommended model: **Sonnet5（高）**.

### Environment plan

1. Use the dedicated G4 worktree only.
2. Boot a currently unused Simulator device (prefer a Shutdown device such as iPhone 17e rather than reusing another slot's active simulator).
3. Build/install a Simulator-compatible development or Release-like build from PR #65 head.
4. Do not use EAS unless local native build genuinely cannot perform the check.
5. Use only public client configuration needed to reach the app login/X authorization flow. Do not copy secrets, service-role keys, Vault values, or untracked files owned by another slot.
6. If the required public Supabase URL/publishable key cannot be obtained from a safe canonical/user-provided location, STOP and ask the operator for those public values rather than borrowing another slot's .env.

### Non-mutating provider proof

The goal of this follow-up is specifically to prove the iOS auth-session behavior **without creating a new production X connection**.

Operator actions only:
1. Sign in to the disposable/test app login as needed.
2. In normal Safari, sign in to disposable X account A.
3. Start the app's posting-X connect flow.
4. Verify the auth session does **not** silently continue as A and instead presents a fresh login/authentication opportunity.
5. The operator may enter disposable X account B credentials far enough to prove B can be authenticated/identified in the isolated auth session.
6. **Do not press the final X authorization/consent action that would complete callback/linking or persist credentials.** Cancel/close before the app connection is created.
7. Retry once and verify the flow is still usable and again does not silently reuse Safari A.
8. Confirm no real X post occurred.

This provider proof is sufficient for the native behavior because:
- the actual source and Codex review already prove connect/reconnect share the same X-connect hook/auth-session option,
- focused tests cover reconnect/cancel/retry and OAuth contract,
- the only unverified platform fact was whether iOS/browser honors the ephemeral-session request enough to prevent silent reuse of the normal Safari identity.

A production disposable X connection/reconnect is therefore **not required** for this K4 and must not be created merely for verification.

### PASS criteria

PASS if all are true:
- isolated G4 Simulator/native build runs PR #65 head,
- Safari account A is not silently forced through the app auth session,
- operator can reach authentication as a different disposable account B,
- cancel returns safely,
- retry works,
- no final provider authorization/linking is completed,
- production DB/Vault/Auth/OAuth application state mutation = 0,
- real X posts = 0,
- runtime source remains unchanged.

### After PASS

- Record simulator/device/build context and operator-observed behavior.
- Re-run/fresh-confirm PR head, mergeability/checks and no main overlap.
- Do not modify runtime source.
- Set status -> review_required, next_owner -> chatgpt and STOP for K4.
- ChatGPT will make the final merge decision.

### If FAIL

- STOP with evidence.
- Do not clear Safari cookies, add undocumented X params, or improvise provider workarounds.
- Any runtime source change reopens focused review.


## Report — K4 follow-up 2: isolated provider proof (2026-10-01)

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- result: **PASS（操作者が実機で確認）**。PR #65 head のネイティブビルドで、X接続の認証セッションがSafariのログイン中アカウントAを引き継がず、別の使い捨てアカウントBで認証画面（最終の許可の手前）まで進めること、キャンセル後の再試行が同様に動くことを、操作者が観察した。runtime sourceは変更していない。
- model_used: Sonnet 5.5
- PR #65: exact head `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`（OPEN、MERGEABLE、CLEAN、GitHub checks green）。**mergeしていない**（最終のmerge判断はChatGPT）。fresh mainにPR #65の5つのsource/testファイルとの重なりなし。

### 環境（G3の環境・設定は不使用）

- 実施はG4専用の一時フォルダのみ（PR #65 headを`git archive`で取り出し、`npm ci`、`expo prebuild`、`pod install`、`xcodebuild`）。G3・他slotのworktree/.env/Simulator/Metroには触れていない。リポジトリのsource・app.jsonは変更していない（検証用の変更は一時フォルダ内のみ）。
- 公開クライアント設定（Supabase URL・publishable key）は操作者が提供。秘密鍵・service_role・Vaultは不使用。設定値は一時フォルダ内の未追跡`.env`のみ（コミットなし、このReportにも値を記載しない）。
- **Simulator**（iPhone 17e、未使用機）: Debugビルドを作成・インストールし、アプリがログイン画面（実データ接続）まで起動することを確認。ただしClaude内の操作パネルにホームボタンがなく、SafariとアプリをSimulator上で行き来する検証が不便だったため、操作者の依頼で実機に切り替えた。このMacには`Simulator.app`本体が無い。
- **実機**（操作者のiPhone 17 Pro、iOS 26系）: 一時フォルダでDebugビルド（ローカル署名、操作者の既存の開発用証明書、自動プロビジョニング）→ `devicectl`でインストール → 私のMetro（LAN、port 8081、一時フォルダのnode_modules）からJSを読み込み。EAS不使用。
  - 検証用の一時変更（一時フォルダ内のみ）: bundle identifierを既存の開発用アプリと別の値（`…g4proof`）にして、操作者の既存アプリを上書きしない。署名可能にするため、Appleログインのentitlement（`usesAppleSignIn`と`expo-apple-authentication` plugin）を一時的に外した（今回の確認対象外）。
  - アプリのJS（PR #65 headのsource）は、Metroが1386 modulesをbundleして実機に配信したことをログで確認。

### 操作者が観察した結果（使い捨てアカウントのみ）

操作者の報告（原文要旨）:
1. SafariでXアカウントAにログインした状態で、アプリのXアカウント接続を開始 → **「ログイン画面から始まった（Aを引き継がなかった）」**。
2. 別の使い捨てアカウントBで、**「許可の手前まで進めた」**（最終のX認可・consentは押していない）。
3. 認証シートを閉じる → **アプリの「Xで認証」画面に戻った**（キャンセルで安全に戻る）。
4. もう一度接続を開始 → **「ログインになった」**（再試行でも、Aを自動で引き継がずログイン画面から始まった）。

### PASS criteria

- isolated G4 native build runs PR #65 head: **満たす**（Simulator・実機の両方でPR #65 headのJSを実行。実機で操作者が確認）。
- Safari account A is not silently forced through the app auth session: **満たす（操作者の観察）**。
- operator can reach authentication as a different disposable account B: **満たす**（許可の手前まで）。
- cancel returns safely / retry works: **満たす**（操作者の観察。3と4）。
- no final provider authorization/linking completed: **満たす**（操作者は最終の許可を押していない）。
- production DB/Vault/Auth/OAuth application state mutation = 0: **Claudeは0**。操作者はアプリに使い捨てのアプリアカウントでログイン（またはその登録）をした可能性があり、その場合は使い捨てのAuthユーザーが本番Authに1件作られている。このReportでは操作者の行為の内訳は確認していない。X側の接続（連携の保存・Vault）は作られていない（最終の許可を押していないため）。
- real X posts = 0: 満たす。
- runtime source remains unchanged: 満たす（PR #65 headのまま。変更・追加commitなし）。

### 注意・補足

- 未確認: 「再接続」ボタン（接続済みアカウントがある状態）での操作は今回は行っていない。TASKの判断どおり、接続と再接続は同じhook・同じ認証セッション設定を共有する（sourceとテストで確認済み）。
- 操作者の観察は「ログイン画面から始まった」で、「アカウント選択画面」ではない。`preferEphemeralSession`はベストエフォートの要求であり、TASKのPASS基準（前のブラウザセッションの黙った再利用がない）を満たす挙動。
- 副作用の再確認: 非共有セッションのため、接続のたびにXへログインし直しになる。
- 後片付けのお願い（操作者）: iPhoneに検証用アプリ「Social Operations」（別のbundle id）が追加されている。不要なら削除してよい。使い捨てのアプリアカウント・Xアカウントも不要なら操作者側で整理する。Simulator（iPhone 17e）にも検証用アプリが残っている。
- 私が起動した開発サーバー（port 8083、8081）は両方停止済み。他のslotの開発サーバーは停止していない。一時フォルダはMacの再起動等で消える。

### production mutation / X posts

Claudeによるproduction mutation 0。実X投稿 0。最終のX認可（接続の作成）は押されていない。

### 次の推奨

- ChatGPTがK4でPR #65の最終merge判断（head `e5a66f5`、checks green、main重なりなし、操作者の実機確認PASS）。
- merge後、X接続の手順（E3など）に「接続のたびにXへログインし直し」の旨を反映する。

## Completion

- status -> review_required
- next_owner -> chatgpt


## Final K4 — X account-switch auth session

- verdict: **PASS**.
- accepted PR #65 exact head: `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`.
- squash merged as `6b1f2f6229a1b75743b57900d869368c2c5e8693`.
- source/security review had already accepted this exact head; no runtime-source changes were made after review.
- operator/native proof passed on an isolated G4 build: normal Safari X account A was not silently reused; a different disposable account B reached the final-consent boundary; cancel returned safely; retry again started at login.
- final X authorization/consent was not completed; no social-account linking was created for this proof; real X posts = 0.
- independent production read-only verification for the test window found 0 new Auth users, brand memberships, social accounts, OAuth states, token-store updates, or Vault secret creates/updates.
- fresh merge gate: PR open/mergeable, head unchanged, checks green, no overlap with the five PR files despite main advancement.
- no additional Codex review required because exact reviewed runtime source remained unchanged.
- platform caveat: iOS private/ephemeral auth session is best-effort; the verified behavior was a fresh login screen rather than a guaranteed account chooser.
- Android/Web behavior remains unchanged.
- app binary/TestFlight was not released by this K4; the merge will be included in the next native build.
- remaining separate UI follow-up: the accounts screen still has a Link-asChild styling issue identified by G3; not part of the OAuth fix.
- G4 closed and reusable only after fresh allocation.


## Report — x-social-mobile-publish-toggle-v1-20261002 (2026-10-02)

- task_id: x-social-mobile-publish-toggle-v1-20261002
- result: **PASS（source・自動テスト）／deploy・実機確認は未実施**。PR [#76](https://github.com/anohi-memories/kabumori/pull/76)（未merge、source candidate）。
- model_used: Sonnet 5.5（TASKの推奨は Opus5.5（高）。セッション内で自分のモデルは切り替えられなかったため、権限境界のレビューは Codex Sol で必ず行うこと）。

### endpoint / architecture
- 新規 Edge Function `social-mobile-publish-setting`（`logic.ts` 方針／`http.ts` PostgREST依存／`index.ts` 入口）。verify_jwt は ON のまま。POST のみ、`application/json` のみ、本文1KB以内。
- 本文は厳密に3項目 `{social_account_id, desired_enabled, expected_current_enabled}`。`brand_id` などの余計な項目は無視せず 400。
- 呼び出し元は Auth `/auth/v1/user` で検証。アカウントの本当の `brand_id` はサーバーが service key で読む。membership は呼び出し元JWT＋anon key（RLS適用）で読む。Vault の参照列は「有無」の真偽値にだけ変換し、返却・ログしない。Vault 平文は読まない。
- クライアント: `apps/social-mobile/src/app/accounts/[id].tsx` に自動投稿カード（`features/publish-setting/*`、`domain/publish-setting.ts`）。

### exact authorization policy
- owner / admin のみ（対象アカウントの brand の membership）。viewer / member は 403 `PUBLISH_CONTROL_FORBIDDEN`（OFFも不可）。
- 未認証 401。アカウント不存在／membership なし／他brand は区別できない同一の 404 `ACCOUNT_NOT_FOUND`（id の存在を漏らさない）。

### enable prerequisites（ON）
platform=x、brand `is_active`、`publish_mode='live'`、`connection_status='identity_verified'`、`platform_user_id`・`verified_at` あり、Vault参照（access/refresh）あり、`last_connection_error_code` なし、expected一致。接続系の失敗は `reconnect_recommended:true`。これらの接続条件は書き込みのWHEREにも含めており、読み取り後に接続が壊れても ON にならない（brand条件のみ書き込み前の読み取りで確認）。

### disable semantics（OFF）
owner/admin なら、接続劣化・資格情報欠落・brand無効でも常に可能。OAuth失効、資格情報・投稿・下書き・履歴の削除は一切しない。UI文言も「削除されない」と明記。

### stale / CAS behavior
- 期待値と実値が違えば 409 `STALE_STATE`（`current_enabled` 付き）。同一状態要求は書き込みなしの 200 `unchanged`。
- 書き込みは条件付きPATCH1回。0行更新は成功扱いにせず再読込し、不存在→404／状態変化→STALE_STATE／ON時は接続条件不成立→CONNECTION_NOT_VERIFIED／OFF時の原因不明→503。アカウント削除中のガードトリガは 409 `ACCOUNT_BUSY`。二重送信は2回目が STALE_STATE。

### exact mutation boundary
- 変更するのは `social_accounts.publish_enabled` のみ（`id`・`brand_id`・期待値で絞った条件付き PATCH、ボディは `{publish_enabled}` のみ）。`updated_at` は意図的に変更しない（接続状態のリース用スタンプのため）。
- 呼ぶ先は Auth user / social_accounts GET / brands GET / brand_memberships GET / social_accounts PATCH の5つだけ（テストで URL を網羅検証）。X API・Vault・RPC・他テーブル・Cron・Auth変更なし。

### changed_files（PR #76、10ファイル）
- `supabase/functions/social-mobile-publish-setting/{index,logic,http,logic_test,http_test}.ts`
- `apps/social-mobile/src/domain/publish-setting.ts`
- `apps/social-mobile/src/features/publish-setting/{use-publish-setting.ts,publish-setting-card.tsx}`
- `apps/social-mobile/src/app/accounts/[id].tsx`（カード1行追加）
- `apps/social-mobile/tests/publish-setting.test.mjs`

### tests
- Edge: `deno test` 37件 pass（logic 24 / http 13）、`deno check` pass。未認証、不存在、membershipなし、viewer/member、owner/admin、cross-brand、ON阻害13パターン、Vault平文なし・レスポンスに秘密なし、劣化時もOFF可、stale、読み取り〜書き込み間の競合、同一状態・二重送信、変更が publish_enabled のみ・他の呼び出しなし、X通信なし、ログに秘密なし、method/content-type/入力検証、エラーコードが有限集合。
- social-mobile: `npm test` 134件 pass（新規21）、`src/domain/*.test.ts` pass、`tsc --noEmit` pass、`expo lint` exit 0。UI: 状態の正直な表示、ON確認必須、キャンセルで送信なし、OFF文言に削除表現なし、実行中の二重送信なし、成功で再読込、staleで再読込、未接続はON不可（説明表示）、劣化中のONでもOFF可、正確なaccount id、G3ファイルをimportしない。
- `git diff --check` 問題なし、秘密スキャン問題なし。

### local verification
- TASK の確認項目 1〜8（ON押下→確認表示／キャンセルで変化なし／確認→再読込でON／ON→OFF／authorization_pending はON不可／staleの安全表示／投稿作成なし／X認証・失効なし）は、実コードのhook・カードをtranspileしたハーネス＋偽Supabaseで再現。
- **Simulator・実機での確認は未実施**: 関数が未deployで、mockプレビューは仕様上スイッチを出さない（`mock_preview` では ON/OFF ともに不可）ため、起動しても実動作を確認できない。deploy後に、G4専用の使い捨てアカウントでの確認が必要。

### proof G3 consultation files untouched
PR #76 の変更10ファイルに `consult.tsx`、`content-settings*`、`content-settings-repository.ts`、G3の相談Edge Function/テストは含まれない（`git diff origin/main HEAD --name-only` を consult／content-settings／migrations／.agent で絞って該当なし）。クライアントのコードは `approvalMode`・`consult`・`content-settings` を参照しないことをテストで固定。PR #70・共通アカウント作業にも触れていない。

### 固定項目
- DB migration = **none**（RLS・grant 変更もなし）
- production mutation = **0**（deploy・本番トグル・Vault/Auth/Cron変更・DB適用いずれもなし）
- real X operations = **0**（X投稿・認証・失効なし）

### commit / push / PR
- branch `g4/social-mobile-publish-toggle-v1-20261002`、commit `a59a89e9`（origin/main 直上の1コミット）、push済み、PR #76 作成済み（CI は作成時点で pending 5・failing 0）。merge・deploy はしていない。

### remaining issues
1. **ON は brand の `publish_mode='live'` が前提**。多くの一般ワークスペースでは当面 ON できない（UIは理由を安全な文言で表示）。`live` にする運用手順は本TASK外。
2. brand の `is_active`／`publish_mode` は書き込み前の読み取りで確認（接続条件のみ書き込みWHEREに含む）。わずかな TOCTOU があるが、実行時のパイプラインが brand を再確認するため、誤投稿には直結しない。Codex に判断してほしい点。
3. クライアントは自分の role を知らない。viewer/member は押した後に 403 の説明が出る（事前に非表示にしていない）。
4. 実機・Simulator 確認は deploy 後。
5. モデルは Sonnet 5.5（推奨は Opus5.5（高））。

### safety checks
上記 mutation boundary のとおり。秘密（JWT・publishable key・service key・Vault参照）はコード・テスト・ログ・レポートに含めていない。`supabase/.temp/` は既存の未追跡で、コミットしていない。

### next recommendation
K4 で Codex **Sol（高）** による集中レビュー（認可境界、条件付きPATCHの網羅、brand条件のTOCTOU、`publish_mode` の運用前提）を割り当て。Codex 承認後に操作者が deploy（verify_jwt ON、byte確認）し、使い捨てアカウントで実機確認。merge/deploy は Claude の自己レビューだけでは行わない。


## K4 decision — PR #76 source candidate

- verdict: **PASS to focused Codex review; merge/deploy HOLD**.
- accepted review target: PR #76 exact head `a59a89e9c585fb6e780e1af2ecc898c830f5524e`.
- PR is open/mergeable; Netlify and Vercel checks green.
- fresh main is 5 commits ahead of the PR base with no overlap across the 10 PR files.
- source/tests remain within posting-toggle boundary; no G3 consultation files, migration/RLS/grant, X API, scheduler or common-account changes.
- production mutation 0 / real X operations 0.
- because this is a posting-permission/security boundary, K4 does not merge.
- H1 assigned focused review `x-social-mobile-pr76-publish-toggle-review-20261002`, recommended **Sol（高）**.
- next_owner: codex; wait for C1.


## Report — x-social-mobile-publish-toggle-transactional-corrective-20261003 (2026-10-03)

- task_id: x-social-mobile-publish-toggle-transactional-corrective-20261003
- result: **PASS（source・自動テスト・使い捨てDBでの実証）／本番適用・deploy・実機確認は未実施**。PR [#76](https://github.com/anohi-memories/kabumori/pull/76) を是正（未merge、source candidate）。
- model_used: Opus 5.5（TASK推奨は Opus5.5（極高）。セッションのモデルは Opus 5.5。推論強度の設定値は自分では確認できない）
- old PR head（H1がFAILとした head、履歴に保持）: `a59a89e9c585fb6e780e1af2ecc898c830f5524e`
- new exact head: `fe1e846e59c69b591d29c6d21fc23c7b702d19cd`（通常push。force-pushなし）

### architecture chosen
TASKの「Preferred direction」どおり。判断と書き込みを**DBの1トランザクション**へ移した。

- 新migration `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql`（関数2つのみ。テーブル・policy・trigger・テーブル権限の変更なし。既存関数の `create or replace` なし）
  - `public.set_social_account_publish_enabled(p_social_account_id text, p_desired_enabled boolean, p_expected_current_enabled boolean) returns jsonb` — 呼び出し元本人のJWTで実行。`auth.uid()` が本人。`authenticated` のみ実行可（`service_role`・`anon`・PUBLIC は不可）。user id／brand id の引数なし。
  - `public.assert_x_publish_permission_for_legacy_post(uuid, text, text) returns text` — X送信直前の権限確認。`service_role` のみ。読み取り専用。
- Edge `social-mobile-publish-setting`: **service role key を持たない**（環境変数からも読まない）。Auth確認（`/auth/v1/user`）＋上記RPCを呼び出し元JWTで1回呼ぶだけ。テーブルへのアクセス・判断後の再読込なし。
- x-test-post `vault_account_auth.ts`: Vault連携アカウントのX送信（初回・401後の再送1回）の**直前に毎回**、権限確認RPCを呼ぶ。
- 詳細・図・ロールアウト順・本番preflight用クエリ: `supabase/tests/social_mobile_publish_permission.md`

SECURITY DEFINER の理由: `authenticated` は `social_accounts` に UPDATE 権限がなく、付与してはいけない（TASK指示）。この関数は1行の1列だけを書き、権限の入力はすべて `auth.uid()` とロックした行から得る。`search_path = ''`、全リレーションをスキーマ修飾。公式ドキュメント（Supabase「Database Functions」）で、definer関数は search_path 固定が必須・空が推奨、関数は既定で誰でも実行可能なので明示revokeが必要、を確認した。

### original H1 findings R1–R5 disposition
- **R1（membershipが古いスナップショット）: 解消**。呼び出し元のmembership行を、書き込みと同じトランザクション内で `FOR SHARE` ロックして読む。削除・降格は「先にcommit済みで見える」か「このトランザクションのcommitまで待つ」のどちらか。ON・OFF両方。Edgeには特権の書き込みが無いので、古い認可を使い回す経路そのものが無い。
- **R2（brandのTOCTOU／実行時ガード）: 解消（対象経路を限定して明示）**。(a) brand行を `FOR SHARE` でロックしてONを判断・書き込み（brandが無効化済みならON不可、無効化は切替のcommitを待つ）。(b) Vault連携アカウントのX送信直前に、単一SQL文（＝単一スナップショット）でbrand active/live・アカウントON・verified・削除中でない等を確認。dispatcherが生成前に読んだ古いcontextでは送信できない。「実行時ガードがあるので無害」という前回の私の主張は誤りだった。
- **R3（再読込で他テナント状態が漏れる）: 解消**。再読込を廃止。移動・削除・権限喪失はすべて同じ `not_found`（状態を含まない）。`stale`（現在値つき）と `blocked`（理由つき）は、ロック下で現在のowner/adminと確認できた相手にだけ返す。
- **R4（ON判定の不一致）: 解消**。ロックした行に対する1つの判定に統一。`nullif(btrim(platform_user_id),'')`、`identity_verified`、`verified_at`、参照2つが存在・相違・他アカウントと非共有（実行時の `x_legacy_post_account` と同じ規則）、`last_connection_error_code` なし、refresh状態が `uncertain`/`reauth_required` でない。各ケースで「ONが拒否する状態は実行時も拒否する」ことをテスト。ONの意味は「許可が有効で構造的に適格」であり「次のX送信の成功保証ではない」（Vaultの中身は読まない）と文書・UI文言に明記。
- **R5（確認が固定されていない）: 解消**。アクションを依頼時点の「アカウントid・期待状態・ログインユーザー」に固定。画面が一致しなくなったら確認を破棄（元に戻っても復活しない）。送信時にも最新の確定描画と照合するため、古い描画のボタンを押しても0リクエスト。画面側も `key={account.id}`。

低リスク指摘: 重複JSONキー・エスケープを拒否（last-winsにしない）／本文は**読み取り中にバイト数**（512）で打ち切り／OFF文言から「いつでもONに戻せます」を削除し条件付きに、「送信が始まっている投稿は取り消せない」を明記／テストのlint指摘（require-await 5件）解消。

### transaction / lock / authorization model
- 順序（アカウント削除の関数と同じ向き: brand → memberships → accounts）:
  1. `LOCK TABLE social_accounts IN ROW EXCLUSIVE MODE`（行ロックより先）
  2. brand行 `FOR SHARE`
  3. 呼び出し元のmembership行 `FOR SHARE`
  4. アカウント行 `FOR UPDATE`
- 1を先に取る理由: refreshのcommit関数は `SHARE ROW EXCLUSIVE`（テーブル）→ アカウント行の順。行ロック後にUPDATEでテーブルロックを取る（逆順）と、単回使用トークンを既に回転させたcommitとdeadlockし得る。変異テストで、この行を外すと実際にdeadlockが起きることを確認。
- brandのメンバーでない呼び出し元は、ロックを取る前の確認で `not_found`。他テナントの行のロックを待たない・取らない（テストあり）。owner/adminでないメンバーは書き込みロックを取らない。
- 待ちは有界（`lock_timeout = 3s`）。timeout・deadlock・削除ガードは `busy`（書き込みなし）。
- `READ COMMITTED` 必須（Data APIの既定）。それ以外は拒否。

### runtime fresh pre-send guard and exact in-flight semantics
- 対象: `VaultAccountXAuth.send`（現在配線されている唯一のアカウント単位の送信経路＝AI Lab `brand_post`。将来のVault連携アカウントも同じ経路）。`request()` の直前の文が必ず権限確認であることをソース固定テストで担保。
- **in-flightの定義**: 権限確認が `authorized` を返した時点から「送信中」。確認のスナップショットより前にcommitされたOFF／brand無効化は送信を止める。後にcommitされたものは、すでにXへ向かったリクエストを取り消さない。同じdispatch内の次のリクエスト（401後の再送、2件目）は新しい確認なしには始まらない。
- fail closed: 確認に到達できない・関数が無い（migration未適用）・想定外の応答は `X_PUBLISH_PERMISSION_UNAVAILABLE` で送信しない。
- `refreshing` は権限の拒否にしない（「他のrefresh進行中で拒否されたproactive refreshは現在のトークンを使い続ける」という既存の設計を維持）。
- **対象外（主張しない）**: かぶモリの従来経路（env／`oauth_token_store`）、`important-news-monitor`（`publish_enabled` を見ていないことをgrepで確認）、未配線のv2 dispatcher、未mergeのPR #41。いずれも未変更。

### ON / OFF semantics
- ON: 上記R4の条件＋現在のowner/admin＋期待状態一致＋brand active/live＋削除中でない。refresh lease保持中は `busy`。
- OFF: 現在のowner/admin・正確なアカウント・期待状態のみ必要。接続失敗・参照欠落・brand無効・refresh状態ブロックでも可能。`publish_enabled` 以外は何も変えない（失効・Vault・投稿・ログ・履歴・Authに副作用なし。全テーブルのハッシュ比較でテスト）。`updated_at` は変更しない。
- アカウント削除中は ON・OFF とも `busy`（削除側が投稿中でないことを要求し、全writerをガードが拒否するため）。

### tenant-safe error behavior
存在しないid／非メンバー／移動済み／削除済み → 同一の `404 ACCOUNT_NOT_FOUND`（状態なし）。member/viewer → `403`（どの要求でも同一、状態なし）。`current_enabled` は現在のowner/adminにのみ。DB・バックエンドの文言は一切返さない（未知の応答は `503 PUBLISH_SETTING_UNAVAILABLE`）。

### migration / RPC changed files
- 追加: `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql`
- 変更: `supabase/functions/social-mobile-publish-setting/{index,logic,http,logic_test,http_test}.ts`、追加 `migration_test.ts`
- 変更: `supabase/functions/x-test-post/vault_account_auth.ts`、`vault_account_auth_test.ts`
- 追加: `supabase/tests/social_mobile_publish_permission{.md,_fixture.sql,_behavior.sql,_run.sh,_mutations.sh,_postgrest_shim.ts,_e2e_test.ts}`
- 変更: `supabase/tests/migration_source_invariants_test.ts`（予約versionに1行追加）
- 変更: `apps/social-mobile/src/domain/publish-setting.ts`、`src/features/publish-setting/{use-publish-setting.ts,publish-setting-card.tsx}`、`src/app/accounts/[id].tsx`（`key`追加のみ）、`tests/publish-setting.test.mjs`
- 計22ファイル（PR全体）。`x-test-post/index.ts` は未変更。G3の相談・content-settings、H2のcontent-settings schema、共通アカウント、`.agent/` は差分に含まれない（`git diff --name-only origin/main...HEAD` をgrepして該当なし）。

### client confirmation pinning
上記R5のとおり。回帰テスト: A確認→Bへ切替（0リクエスト、Aへ戻しても確認は復活しない）／再描画前に古いボタンを押す／preview化／状態変化（すでにON）／適格性喪失／別ユーザー・サインアウト／キャンセル／確認ボタン連打／OFFボタンの古い描画／結果が別アカウントのカードに表示されない。フック側・カード側の防御をそれぞれ外す変異で、対応するテストが落ちることを確認。

### tests / adversarial interleavings
すべてローカル・偽データ。実X API呼び出しなし。

- **使い捨てPostgreSQL 17**（本物のmigration＝onboarding／reconnect／refresh core／rollout／アカウント削除 を積んだ上に候補を適用、非superuser所有者）: `social_mobile_publish_permission_run.sh` → APPLY / BEHAVIOR / RACE / E2E / CLEANUP すべてPASS。
  - 並行: membership削除・降格が書き込み前に起きる（ON・OFF）／切替が判断を保持中は membership削除・降格・brand無効化・publish_mode変更・アカウント移動がすべてブロックされる／brand無効化→ON拒否／**H1のR2スケジュール**（ON未commit→dispatcherがbrand読取→brand無効化は待たされる→ONcommit→dispatcherがアカウント読取→送信前確認が `BRAND_DISABLED`）／他brandへの移動・自分の別brandへの移動・アカウント削除／同一ON二重・ON対OFF／未commitのOFFは送信確認に影響せずcommit後は拒否／アカウント削除と前後どちらの順でも／refresh commit型トランザクションとのロック順（deadlockなし）／有界待ち／非メンバーは他テナントのロックを待たない。
  - E2E（`PUB_E2E=1`）: **実際のEdgeハンドラ・実際の `loadBrandContext`＋`assertBrandPublishAllowed`・実際の送信アダプタ**をHTTP経由で本物のSQLへ接続（Xのみ偽）。H1のR2スケジュールで「キャッシュ済みガードは通るが送信前確認が拒否し送信0件」を確認。5シナリオPASS。
- **変異テスト** `social_mobile_publish_permission_mutations.sh`: 候補SQLを1か所ずつ壊した30件を**30/30検出**（membershipロックなし、brandロックなし、brand再確認なし、trimなし、CAS なし、テーブルロック順、権限付与の緩和、search_path など）。
- Edge（型チェックあり）: publish-setting 39件（logic 15／http 14／migration契約 10）、`vault_account_auth_test` 29件（新規9件。送信前確認を外すと既存1件＋新規8件が落ちることを確認）。x-test-post＋_shared＋publish-setting 全体 925件PASS（`--no-check`）。変更ファイルの `deno check`・`deno lint` PASS。`x-test-post/index.ts` の型エラー6件は既存のまま（私の変更ファイルには無い）。
- 既存テストの変更1件: 「2回目の401後は再認可」テストで、同一attempt内の後続リクエストが**Xへ送られなくなった**（`X_ACCOUNT_NOT_VERIFIED` で事前拒否）ため期待値を更新。
- アプリ: `npm test` 145件（publish-setting 32件）、domain 22件、`tsc --noEmit`、`expo lint` すべてPASS。
- `git diff --check`・秘密情報スキャン: 問題なし。

### production read / mutation
- production mutation = **0**（migration適用・RPC作成・Edge deploy・トグル・行変更・Vault/Auth/Cronなし）
- production read = **0**。このworktreeはSupabase CLIが未link（共有checkoutには触れない）で、本番カタログの読み取りはしていない。**本番のトリガー一覧・権限は未確認**。適用前に操作者が流す読み取り専用クエリ4本をdocに記載（特に `social_accounts` に汎用の `updated_at` トリガーが無いこと）。
- real X operations = **0**

### commit / push / PR state
- branch `g4/social-mobile-publish-toggle-v1-20261002`、commit `fe1e846e`（`a59a89e9` の上に1コミット）、push済み、PR #76 のタイトル・説明を更新。作成時点でCIは passing 2／failing 0／pending 1。mergeable。merge・deployはしていない。

### remaining risks
1. **適用順**: migrationを先に適用してからx-test-postをdeployすること。逆順だとAI Lab（Vault連携）の投稿がすべて `X_PUBLISH_PERMISSION_UNAVAILABLE` で失敗する（安全側）。かぶモリ本体の投稿経路は影響なし。AI Labの投稿は1件につきRPCが1回増える。
2. **かぶモリ型アカウント（Vault参照なし）**: brandのowner/adminがこのスイッチでOFFにでき、ONには戻せない（`CREDENTIALS_MISSING`）。従来経路ではOFFは次回dispatchのcontext読込で効く。本番にkabumori brandのmembershipがあるかは未確認。スイッチの対象をVault連携アカウントに限定すべきかはK4/Codexの判断を仰ぎたい。
3. **OFFとrefreshの競合**（既存仕様）: refreshの `begin`〜`commit` の間（約1秒）にOFFが入ると、commitがアカウント変更とみなし `uncertain`（再接続まで停止）になる。OFFをrefresh待ちにすると古いleaseでOFF不能になるため、OFF優先とした。
4. 確認とXリクエストの間（ミリ秒）のOFFは取り消せない（上記in-flight定義のとおり）。DBロックをHTTP越しに保持できないため。
5. PostgREST経由の実挙動はローカルのshimで代用。本番Data API・JWT・verify_jwtでの確認、実機確認は未実施（deploy後）。
6. 共有参照チェックは他アカウント行をロックせずに読む（構造チェック。実行時に再確認される）。

### safety checks / 作業中の出来事
- 他slotのworktree・branch・dev server・未コミット変更には触れていない。H2のcontent-settings migration、G3のファイルも未変更。
- 「Supabase skillを読む」: このセッションに該当skillが無かった（検索しても0件）。代わりに公式ドキュメントを確認した。
- 既存migration 3ファイルの一部を読むBashコマンドが自動モードに1回拒否された。再試行・回避はせず、すでに読んだ内容と、ローカルDBへ実ファイルを適用した結果で進めた。
- **ディスク満杯**: 最終の変異テスト再実行中にMacのディスクが100%になり、テスト用PostgreSQLが停止した。私のセッション用一時フォルダにあった PR #65 検証用のiOSビルド一式（`g4-sim-e2e`、4.0GB、使用中プロセスなしを確認）を削除して復旧し、全実証を再実行してPASSを確認した。**ディスクは現在も96%使用（空き約9GB）**なので、操作者側での整理を推奨。テスト用PostgreSQLと一時DBは停止・削除済み。

### next recommendation
K4でCodex **Sol（極高）** の独立再レビューを割り当て。重点: ロック順と待ち、SECURITY DEFINER関数のACL、`not_found` の一様性、送信前確認の対象範囲（かぶモリ従来経路を含めるか）、かぶモリ型アカウントのOFF可否、適用順。承認後に、操作者が preflight → migration単独適用 → read-back → x-test-post deploy → publish-setting deploy（verify_jwt ON）の順で実施。merge・適用・deployはClaudeの自己レビューだけでは行わない。


## Report — x-social-mobile-pr76-fresh-main-integration-20261005 (2026-10-05)

- task_id: x-social-mobile-pr76-fresh-main-integration-20261005
- result: **PASS（統合のみ）**。PR [#76](https://github.com/anohi-memories/kabumori/pull/76) に最新mainを通常のmerge commitで取り込んだ。機能変更なし。未merge・未deploy。
- model_used: Opus 5.5（TASK推奨は Sonnet5（高）。このセッションのモデルが Opus 5.5 のため）
- old head: `fe1e846e59c69b591d29c6d21fc23c7b702d19cd`（開始時に PR #76 の head が一致することを確認。履歴に保持）
- fresh main SHA merged: `d345f67402a782a303ce46c640f685271d76b681`
- new exact PR head: `7f75c07a8c997b6a585e9c86dca01186eeea671f`（merge commit。親 = `fe1e846e` と `d345f674`。rebase・force-pushなし）
- commit_hash: `7f75c07a`（merge commit 1つのみ）
- changed_files（手で編集したもの）: `supabase/tests/migration_source_invariants_test.ts` の衝突解消のみ。main比較の PR 全体の変更ファイルは是正時と同じ22ファイル。
- deploy: なし
- worktree: 既存のG4専用worktree `.claude/worktrees/g4-x-admin-pr15` のみ使用（TASK指示どおり）。他slotのworktree・PR #81/#82 のファイルには触れていない。

### conflict paths
- `supabase/tests/migration_source_invariants_test.ts` のみ（TASKの想定どおり）。他のファイルは自動mergeで衝突なし。

### exact conflict resolution
`RESERVED` マップで、mainの行をすべてそのまま残し、PR #76 の予約1行をその後ろ（日付順）に置いた。mainとの差分はこの1行の追加だけ:

```
   "20261002090000": "mic_jgb_nikkei_observation_grace_stage0", // MIC State freshness Stage 0
+  "20261003090000": "social_mobile_publish_permission_boundary", // PR 76 corrective (source candidate)
```

### migration-version collision result
- merge後の `supabase/migrations/` でversionの重複 0件。
- open PR のmigrationと照合（`gh pr list` の全open PR）: PR #76 `20261003090000`、PR #81 `20261003120000_social_mobile_content_settings_hardening`、PR #82 `20261004090000_ai_lab_topic_claims`、PR #41 `20260927101423`／`20260927124300`、PR #3 `20260921115317`。**衝突なし**。
- mainで増えたmigrationは `20261002090000_mic_jgb_nikkei_observation_grace_stage0.sql` の1本のみ。`social_accounts`／brand／membership／publish／refresh には触れていない（grepで確認）。
- mainで変わった実行時コードのうち PR #76 の領域に関わるのは `_shared/brand/ai_lab_dev_diary_context.*`（文書と snapshot）だけ。`x-test-post` と `social-mobile-publish-setting` には main 側の変更なし。

### tests（merge後のブランチで実施。すべてローカル・偽データ）
1. migration source invariants: 10 passed / 0 failed
2. publish-setting Edge（logic／http）＋ 3. migration契約 ＋ 4. `vault_account_auth_test.ts`: 型チェックあり 68 passed / 0 failed
5. x-test-post ＋ `_shared` ＋ publish-setting 全体（`--no-check`）: 925 passed / 0 failed
6. social-mobile アプリ: `npm test` 145 passed、domain 22 passed
7. `tsc --noEmit`: PASS
8. `expo lint`: PASS
9. 変更した実行時・テストファイル11本の `deno check`・`deno lint`: PASS
   - `x-test-post/index.ts` 全体の型エラーは既存のもの。fresh main（`d345f674` を scratch に展開）と merge後で、エラー内容・位置（8か所）とも**完全一致**。PR #76 による新規エラー 0。
10. 使い捨て PostgreSQL 17（新Macで新規作成）: `social_mobile_publish_permission_run.sh`（`PUB_E2E=1`）→ APPLY / BEHAVIOR / RACE / E2E / CLEANUP すべてPASS。変異テスト `social_mobile_publish_permission_mutations.sh` → **30/30 検出**（TASK必須外の追加確認）
11. `git diff --check`（main比較）: 問題なし
12. 秘密情報スキャン（main比較の追加行）: 該当0件。スコープ: main比較の変更ファイルは是正時と同じ22ファイル。content-settings／AI Lab topic claims／相談／共通アカウント／`.agent/`／`.env` は含まれない。

### compatibility issue
なし。実装（`set_social_account_publish_enabled`、`assert_x_publish_permission_for_legacy_post`、ロック順、ACL、Edge挙動、送信前ガード、UIの確認固定）は一切変更していない。

### push / read-back
- push直前に PR head が `fe1e846e` のままであることを再確認してから、通常push（`fe1e846e..7f75c07a`）。force-pushなし。
- read-back: ローカル HEAD = `origin/g4/social-mobile-publish-toggle-v1-20261002` = PR #76 `headRefOid` = `7f75c07a8c997b6a585e9c86dca01186eeea671f`。state OPEN、mergeable **MERGEABLE**（mergeStateStatus CLEAN）。
- CI: push直後の時点で passing 1／failing 0／pending 5。完了は待っていない（K4で確認をお願いしたい）。
- PRのタイトル・説明は変更していない。

### production / safety
- production mutation = **0**（migration適用・db push・Edge deploy・トグル操作・行変更・Auth/Vault/Cron変更なし）
- production read = 0
- real X operations = **0**
- PR merge なし。テスト用PostgreSQLと一時DBは停止・削除済み。

### remaining issues
- 是正時の Report に書いた残リスク（適用順: migration → x-test-post deploy、かぶモリ型アカウントのOFF扱い、OFFとrefreshの競合、送信開始後のOFFは取り消せない、本番カタログ未確認など）はそのまま。今回の統合で増減なし。
- Report記入時点で main は `5704de29` まで進んでいるが、増えた4コミットは `.agent/` の調整ファイルのみ（PR #76 のファイル・migrationへの影響なし）。
- main がこの後さらに進むと、再び `RESERVED` マップで同種の衝突が起きうる（追記同士なので解消は機械的）。

### next recommendation
K4確認後、TASKどおり H1 で Codex **Sol（極高）** の独立再レビュー（対象 head は上記 new exact PR head）。merge・適用・deployは再レビュー承認後に操作者が実施。


## K4 decision — PR #76 fresh-main integration PASS

- verdict: **PASS to independent security rereview; merge/apply/deploy HOLD**.
- accepted fresh head: `7f75c07a8c997b6a585e9c86dca01186eeea671f`.
- PR is open/unmerged/mergeable=true.
- expected single conflict in `supabase/tests/migration_source_invariants_test.ts` was resolved by preserving fresh main and adding the PR76 reserved version only.
- fresh GitHub comparison after integration: current main 8 commits ahead of base, **0 overlaps** across PR changed files.
- Netlify/Vercel success.
- functional corrective code was not changed by the integration task.
- reported post-merge regression and disposable DB evidence is sufficient to proceed to independent review, not production.
- H1 is occupied by PR #82; H2 assigned `x-social-mobile-pr76-transactional-publish-toggle-rereview-20261005`.
- recommended H2 model: **Sol（極高）**.
- production apply/deploy/toggle/X remain forbidden.
- next_owner: codex; wait for C2.


## Report — x-social-mobile-pr76-final-security-corrective-20261005 (2026-10-05)

- task_id: x-social-mobile-pr76-final-security-corrective-20261005
- result: **PASS（source・自動テスト・使い捨てDBでの実証）／本番の適用・deploy・読み取り・実機確認は未実施**。PR [#76](https://github.com/anohi-memories/kabumori/pull/76) を是正（未merge、source candidate）。R1〜R5 の設計は変更なし。
- model_used: Opus 5.5（TASK 推奨 Opus5.5（高）と一致）
- old exact PR head（H2 がレビューした head、履歴に保持）: `7f75c07a8c997b6a585e9c86dca01186eeea671f`（作業開始時と push 直前の2回、PR head が一致することを確認）
- new exact PR head: `5448e545f4a88bbf6597a981c0bcbe4c01043c30`（通常 push `7f75c07a..5448e545`。force-push・rebase なし）
  - `a1a986ae` 是正本体（F1〜F3。差分は `7f75c07a..a1a986ae` で見られる）
  - `ce1328c1` 最新 main `ef2f2018` の通常 merge（衝突なし）
  - `5448e545` main の AI Lab テストのスタブに1行追加（テストのみ。下記「fresh-main」参照）
- commit_hash: 上記3つ。push: 済み、read-back 一致（local = origin = PR headRefOid）。deploy: なし。
- worktree: 既存の G4 専用 worktree `.claude/worktrees/g4-x-admin-pr15` のみ。G3・H1・H2 の worktree、PR #81 のファイルには触れていない。

### F1 — 送信直前の条件を ON と完全に揃えた
- 修正: `assert_x_publish_permission_for_legacy_post` の最終 SELECT 自体に2条件を追加した。ヘルパー `x_legacy_post_account` には頼らない。
  - `sa.verified_at is null` → `X_ACCOUNT_NOT_VERIFIED`
  - `nullif(btrim(sa.last_connection_error_code), '') is not null` → `X_ACCOUNT_CONNECTION_DEGRADED`（新しい固定コード）
  - 判定順は refresh 状態の後。uncertain／reauth_required は従来どおり固有のコードで返る。
  - `refreshing` は従来どおり拒否しない。proactive refresh が事前に拒否された場合も、従来どおり現在のトークンを使い続ける。
- 実行可能な証明（すべてローカル・偽 X）:
  - behavior SQL: ON 拒否 18 ケースすべてに実行時の拒否コードを必須化した（`runtime text not null`、スキップ廃止）。従来 null だった2ケース（verified_at 欠落・接続エラー記録）も一致。空白だけのエラーコードは ON・送信とも許可されることも確認した。
  - E2E（実 SQL＋実 `VaultAccountXAuth`＋shim、X のみ偽）:
    - verified_at 欠落／接続エラー記録 → 送信拒否、X コールバック 0。そのまま OFF は成功、ON は同じ理由で 409。復旧後は再び1回送信。
    - 正常なアカウント → 1回送信。
    - **実リフレッシュ SQL での 401 → refresh → 新しい確認 → 再送**: timeline が `read, permission, x:401, begin, commit, read, permission, x:201` になり、各 X リクエストの直前に必ず確認が入る。
    - refresh の commit 後・再送前に OFF → 再送の確認が拒否、X は最初の 401 の1回だけ。
  - 単体: 偽 DB を実 SQL と同じ条件に更新。トークン期限間近でも確認が先に拒否するのでトークン要求 0。401 記録後の次の試行は X に出る前に止まる。commit 済み refresh はエラーを消してから再送の確認を通る。
  - 変異: 4件（verified_at 無視、接続エラー無視、空白コードをエラー扱い、refreshing を拒否）をすべて検出。
- **影響（ドキュメントとコードコメントに明記）**: 接続エラーが記録されたアカウントは、再接続するまで自動投稿が止まる。対象は refresh できなかった 401、および token endpoint に拒否された refresh（429 `X_REFRESH_RATE_LIMITED` を含む）。その間 refresh も走らない（送信前に止まるため）。ON が既に拒否している状態と同じ。
- 「パリティを case by case でテスト」という記述は、上記のとおり実際に完全一致になった。

### F2 — SECURITY DEFINER の直接・実効 ACL
- migration の修正（2関数だけが対象。ALTER DEFAULT PRIVILEGES・ロール所属・テーブル権限の変更はなし）:
  1. 事前確認:
     - anon・authenticated・service_role の存在（`PUBLISH_PERMISSION_PRECONDITION_ROLES`）
     - 作成ロール = `x_legacy_post_account` の所有者。この関数の EXECUTE は所有者のみなので、機能上も必須（`PUBLISH_PERMISSION_PRECONDITION_OWNER`）
     - 作成ロールが superuser でないこと（同じコード）
  2. 既知ロールと PUBLIC を revoke した後、作成ロールの default privileges が新しい2関数に付けた付与を、どのロール宛てでも grant option の有無にかかわらず除去する（シグネチャは定数）。
  3. COMMIT 前の事後確認（違えば `PUBLISH_PERMISSION_EFFECTIVE_ACL` でファイル全体を中止）:
     - 定義: 所有者、SECURITY DEFINER、search_path=""
     - 直接 ACL: 所有者以外は、それぞれ grant option なしの EXECUTE ちょうど1件。PUBLIC なし
     - 実効権限（継承込み）: anon はどちらもなし、authenticated は switch のみ、service_role は check のみ
     - その他の全ロール: 実行できるのは、所有者を継承するロール、その関数の想定付与先を継承するロール（そのロールとして振る舞う）、superuser に限る
- 不利なロール構成のテスト `social_mobile_publish_permission_acl.sh`（新規、クラスター上で単独実行が必要）: 12 状況（毎回新しい DB）と再適用チェックで `ACL_PASS`。
  - 適用され、余計な付与が残らないことを確認したケース:
    - クリーンな構成（直接 ACL と実効権限の表が正確）
    - schema 単位の default 付与（grant option 付き）
    - DB 全体の default 付与
    - その付与先を authenticated・anon が継承する構成
  - 拒否され、2関数とも存在せず、default ACL・全関数 ACL・ロール所属の指紋が不変であることを確認したケース:
    - 想定外ロールへの直接付与
    - grant option 付き付与
    - authenticated が service_role を継承
    - anon が authenticated を継承
    - service_role が所有者を継承
    - 所有者以外による作成
    - superuser による作成
    - ヘルパーを superuser が所有し、その superuser が作成
  - service_role を継承するロールは check だけを実行できる（許可範囲として明記）。
  - 再適用は `PRECONDITION_ALREADY_APPLIED` で拒否され、権限は不変。
- **旧 head `7f75c07a` の migration をこのテストにかけると「default grantee (schema)」で失敗し、余計なロールが grant option 付き EXECUTE を保持することを確認した**（H2 の F2 を再現）。新 migration は通過。
- 変異 6 件をすべて検出（逐次実行）:
  - 付与の除去なし
  - grant option を許す
  - 直接 ACL の確認なし
  - app ロールの実効確認なし
  - 所有者比較なし
  - superuser 許可
- 補足: 「その他の全ロール」ループは、直接 ACL 確認と除去処理から論理的に導かれる性質を実効権限の形で再確認するもので、単独では観測可能な差を生まない。そのため単独の変異は置いていない。直接 ACL 確認を外す変異は検出される。
- 適用時の権限・所有者の前提を事前に確かめるため、読み取りクエリ f・g を追加した（作成ロールと superuser でないこと、ロール継承がすべて false、所有者の default ACL）。

### F3 — 途中状態がすべて安全側になるロールアウト順
- 承認手順（`supabase/tests/social_mobile_publish_permission.md` 6章。機械検査される `rollout-plan` ブロックつき）:
  - **S0** 読み取り専用 preflight a〜g。Vault 連携の投稿予定がない時間帯を選ぶ。
  - **S1** 送信前チェック付き x-test-post を deploy。S1〜S3 の間、AI Lab の投稿は `X_PUBLISH_PERMISSION_UNAVAILABLE` で安全側に失敗し、送信はされない。かぶモリ本体の投稿経路は変更しない。
  - **S2** deploy 内容をバイト単位で照合し、15分以上待つ（実行時にプラットフォームの上限を確認）。さらにクエリ h（S1 前に開始した running の投稿）= 0 を確認する。手動 dispatch・Cron 変更・backlog や候補の注入はしない。
  - **S3** migration を単独で適用。拒否された場合は何も作られないので停止（S2 の安全な状態のまま）。
  - **S4** クエリ i・j で、定義・ACL・実効権限を読み戻す。
  - **S5** publish-setting を JWT 検証 ON で deploy。
  - **S6** アプリのコントロールを公開。
- 中止経路:
  - S1／S2 の後: x-test-post を前の版に戻す（スイッチがまだ存在しないので安全）。
  - S3／S4 の後: まず `revoke execute … set_social_account_publish_enabled … from authenticated`。必要なら check も revoke（送信前チェック付きランタイムは安全側に失敗）。その後に初めてランタイムを戻す。
  - S5／S6 の後: Edge を外す（アプリのコントロールはエラーで安全側に失敗）。以降は S3 の後と同じ。
  - いずれも元に戻せる grant／revoke で、DROP はしない。
- 証明:
  - 状態遷移テスト `social_mobile_publish_permission_rollout_test.ts`（5件）:
    - 前進の全状態と全中止経路の全状態で「旧ランタイムと使えるスイッチが同時に存在しない」
    - 古い実行の排出が migration より前にある
    - migration の直後に読み戻しがあり、Edge・アプリはその後
    - preflight 以外の各 step に中止経路が1つずつある
    - ランタイムを戻すのはスイッチが使えなくなった後だけ
  - 途中状態 E2E `social_mobile_publish_permission_rollout_e2e_test.ts`（2件、**migration 未適用の実 DB**、shim は PostgREST と同じく 404 PGRST202 を返す）:
    - ON の既存アカウントで送信 → `X_PUBLISH_PERMISSION_UNAVAILABLE`、X コールバック 0、トークン要求 0
    - スイッチの Edge → 503、行は不変
  - 適用後の状態（ON → 送信1回、OFF・ブランド無効 → 0）は上記の適用後 E2E で証明。
  - 変異 5 件をすべて検出: migration 先行、排出なし、中止で先にランタイムを戻す、読み戻し前に Edge、migration 直後の中止経路なし。
- migration ファイル冒頭の「Apply BEFORE deploying …」を削除し、ランタイム先行の手順を記載した（契約テストで固定）。

### changed_files（是正コミット `a1a986ae`、13ファイル）
- `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql`
- `supabase/functions/x-test-post/vault_account_auth.ts`（コメントのみ）
- `supabase/functions/x-test-post/vault_account_auth_test.ts`
- `supabase/functions/social-mobile-publish-setting/migration_test.ts`
- `supabase/tests/social_mobile_publish_permission.md`
- `supabase/tests/social_mobile_publish_permission_behavior.sql`
- `supabase/tests/social_mobile_publish_permission_e2e_test.ts`
- `supabase/tests/social_mobile_publish_permission_postgrest_shim.ts`
- `supabase/tests/social_mobile_publish_permission_run.sh`
- `supabase/tests/social_mobile_publish_permission_mutations.sh`
- 新規: `supabase/tests/social_mobile_publish_permission_acl.sh`、`supabase/tests/social_mobile_publish_permission_rollout_test.ts`、`supabase/tests/social_mobile_publish_permission_rollout_e2e_test.ts`
- 追加コミット `5448e545`: `supabase/functions/_shared/brand/ai_lab_event_dedupe_test.ts`（スタブに1行のみ）
- PR 全体の main との差分は 26 ファイル。content-settings・相談・共通アカウント・`.agent/`・`.env` は含まれない。
- 公開 Edge コード（`social-mobile-publish-setting/{logic,http,index}.ts`）とアプリのコードは未変更。

### SQL / runtime / app tests（最終 head `5448e545` の内容で実施。すべてローカル・偽データ・偽 X）
- 使い捨て PostgreSQL 17.11（新しく作成、非 superuser 所有者、実際の前提 migration の上）:
  - `run.sh`（`PUB_E2E=1`）→ ROLLOUT_E2E（2）/ APPLY（再適用拒否を含む）/ BEHAVIOR / RACE / E2E（9）/ CLEANUP すべて PASS
- `acl.sh` → `ACL_PASS`
- 変異テスト → **45/45 DETECTED**（SQL 34・権限 6・手順 5。従来の 30 件は維持。うち権限・search_path 系の4件は、適用時点の事後確認で拒否されるようになった）
- Deno:
  - publish-setting（logic 15 / http 14 / migration 契約 13）＋ `vault_account_auth_test` 31 ＋ migration invariants 10 ＋ rollout 5 = 88 件 PASS（型チェックあり）
  - x-test-post＋`_shared`＋publish-setting 全体 984 件 PASS（`--no-check --allow-run`）
  - 変更・追加した TS 12 ファイルの `deno check`・`deno lint` PASS
- `x-test-post/index.ts` 全体の型診断: 既存の 6 件のみ。最新 main（`ef2f2018`）と内容・位置とも完全一致。PR による新規は 0。
- アプリ: `npm test` 148 件（main で 3 件増）、domain 22 件、`tsc --noEmit`、`expo lint` PASS
- `git diff --check`（main 比較）問題なし。秘密情報パターン 0 件。
- CI（新 head）: Vercel・Netlify・Vercel Preview Comments は pass、Netlify のルール系 3 件は skipping。mergeable / CLEAN。

### fresh-main overlap / conflicts
- 作業中に main が `d345f674` から `ef2f2018` へ 53 コミット進んだ（PR #81・#82 の merge、`x-test-post/index.ts` などの変更）。PR #76 のファイルとの重なりは 0。merge も衝突なし。
- **互換性で1点だけ要対応だった**:
  - 内容: main の `ai_lab_event_dedupe_test.ts`（PR #82）が、PR #76 で必須になった `assertPublishPermission` を持たない RPC スタブで実物の送信ラッパーを使っていた。`--no-check` 実行では、全送信が `X_PUBLISH_PERMISSION_UNAVAILABLE` で安全側に止まり、3 テストが失敗した。
  - 対応: スタブに許可を返す1行を追加（テストのみ、ランタイム変更なし）。型チェックも通る。
  - 実ランタイムへの影響: main の AI Lab 結果判定（`ai_lab_provider_outcome.ts`）は、X リクエストが一度も出ていない失敗を NOT_SENT（題材の確保を解放）と扱う。送信前の新しい拒否も同じ扱いになるので、矛盾はない。
- （記録）main の4件目の失敗に見えたのは、子プロセスで node を起動するテストを `--allow-run` なしで実行した私のコマンドの問題で、コードの問題ではなかった。

### migration-version check
- merge 後の `supabase/migrations/` で version の重複 0。
- PR76 `20261003090000`、PR81（merge 済み）`20261003120000_social_mobile_content_settings_hardening`、PR82（merge 済み）`20261004090000_ai_lab_topic_claims` は互いに異なる。open PR #41・#3 の version とも衝突なし。
- 予約表（`migration_source_invariants_test.ts`）の PR #76 の行は維持。テスト PASS。

### production / safety
- production mutation = **0** / production read = **0** / deploy = **0** / real X = **0**（OpenAI・Vault・Auth・Cron の操作もなし）
- PR merge なし。
- 使い捨てクラスター・DB・テスト用ロール・一時ディレクトリ・shim はすべて停止・削除済み。アプリロールの継承関係を変えるテストは、終了時に元に戻ることも確認した。
- 他 slot のファイル・worktree・dev server には触れていない。

### remaining risks
1. **F1 の可用性への影響**: 接続エラーが記録されると、再接続まで AI Lab の自動投稿が止まる（429 の一時的な refresh 拒否も含む）。適用前にクエリ e で、該当する「Vault 連携・ON」アカウントの数を確認する必要がある。H2 の集計では Vault 連携・ON は 1 件だが、エラーの有無は未確認。一時的な 429 まで止めてよいかは K4／プロダクト判断を仰ぎたい。
2. **F3 の可用性**: S1〜S3 の間は AI Lab の投稿が安全側で失敗する。投稿予定がない時間帯を選ぶ。待機時間（15分以上）は、Edge の最大実行時間を実行時に確認してから決める（プラットフォームの上限値は私が確認したものではない）。
3. **本番の作成ロール**: 本番で `postgres` が適用し、かつ `x_legacy_post_account` の所有者が `postgres` であることが前提。H2 の読み取りでは成立しているが、実際の適用手段がこのロールで実行するかはクエリ f で確認する必要がある。違えば migration は安全側で拒否する。
4. ロールアウトの中止経路は grant／revoke の SQL と deploy 操作で、状態遷移としては検証済みだが本番では未実施。
5. 前回から継続: かぶモリ型（Vault 参照なし）アカウントの OFF／ON の非対称（H2 Gate M、公開範囲の判断が必要）、OFF と refresh の競合、送信開始後の OFF は取り消せない、managed PostgREST／JWT での実機確認は未実施。

### safety checks
- TASK の禁止事項（本番適用・db push・deploy・本番トグル・本番行変更・Auth／Vault／Cron 変更・実 X・merge）はすべて未実施。
- `supabase/.temp/`（CLI の一時ファイル）はコミットしていない。stage は明示パスのみ。
- 共有ルールファイル・他 slot の TASK・Report は変更していない（自分の TASK のステータスと Report だけ更新）。

### next recommendation
K4 確認後、TASK どおり H2 で Codex **Sol（極高）** の独立再レビューを行う（対象 head `5448e545`、是正差分は `7f75c07a..a1a986ae`）。重点:
- F1: 接続エラー記録で止まることの可否
- F2: 事後確認の論理と、本番の作成ロール
- F3: 手順と待機の妥当性
- main テストスタブの1行修正

承認後に、操作者が 6章の S0〜S6 を実施する。merge・適用・deploy は Claude の自己レビューだけでは行わない。


## Report (interim) — x-social-mobile-pr76-production-rollout-gate-20261006 — S0 / package freeze / STOP before S1 (2026-10-06)

- task_id: x-social-mobile-pr76-production-rollout-gate-20261006
- result: **STOP before S1（承認待ち＋要判断）**。本番への書き込み・deploy は 0。
  - S0 は一部だけ実施（Claude が読めた範囲）。残りの本番読み取りは auto モードに拒否されたため、操作者が実行する読み取り専用スクリプトを用意した。
  - さらに、S1 の「main の x-test-post を deploy」は PR #82 の実行時コードを同時に有効化してしまう。この点を判断してもらう必要がある（後述）。
- model_used: Opus 5.5（TASK 推奨 Opus5.5（高）と一致）
- workspace: 新しい基準 `/Users/yuya/Developer/kabumori-fresh` から作った G4 専用 worktree `/Users/yuya/Developer/kabumori-g4-pr76-rollout`（branch `claude/g4-pr76-rollout-gate-20261006`、最新 main `718bf392` に fast-forward）。
  - 未追跡で、stage しないもの: `supabase/config.toml`（project_id のみ）、`supabase/.temp/`（link 情報。旧共有 checkout からコピー）、`g4-preflight/`（読み取り・運用パッケージ）
  - G3・H1・H2・G5・AI Lab の worktree には触れていない

### 確認できた事実（ローカル・git）
- main は PR #76 の squash merge `3c5f80a61d114d2936b761fc05ee3b3d69e85f63` を含む。
- 次のファイルは H2 が PASS とした head `5448e545` と同一で、merge 後も main で未変更: migration、`x-test-post/vault_account_auth.ts`、`social-mobile-publish-setting/*`、runbook。
- migration `20261003090000_social_mobile_publish_permission_boundary.sql` SHA-256: `b2ed7c756663d35b796c31138d4ab3e7fdea18107182bbd814a4f2e659c95f03`
- x-test-post の import graph（main）: 48 ファイル、すべて `x-test-post/` と `_shared/` の中、外部 import なし。manifest SHA-256 `faaccc7af9996f23c4dc84334ddaf546b9fcc491f2208c16d68b1c6d6bc22531`
- social-mobile-publish-setting: 3 ファイル、manifest SHA-256 `a844d7fc90cc5346495e09e52766170c4aa3436d54db728f3c1b24a009f698b4`
- PR #81（content-settings）のファイルは、どちらの deploy 対象の import graph にも含まれない。
- GitHub ワークフローに Edge の自動 deploy はない（日記の同期はコミットのみ）。
- 記録上、最後の x-test-post の本番 deploy は v131（2026-10-01、PR #66 直後の main）。

### S0（本番、読み取り専用）— Claude が実行できた範囲
- project `wsmznyzcvmuitkglfeuj`（stock-x-autopost）。`db query --linked` の実行ロールは `postgres`、PostgreSQL 17.6（`170006`）。
- ledger の形: `version`（PK）, `statements`, `name`, `created_by`, `idempotency_key`, `rollback`。72 行、最大 version は `20261002090000`。
- `20261003090000`（PR76）・`20261003120000`（PR81）・`20261004090000`（PR82）はいずれも history 0 行。同名の別 version もない。
  - PR82 は CURRENT_STATE の記録どおり「schema 適用済み・history 未記録」。
  - 20261003090000 より新しい version の行は 0。順序の衝突はない（db push ではなく、行を明示的に記録する方式のため）。
- 対象の2関数（どの schema・どの引数でも）: 0 件、同名の overload なし。
- migration の前提: 必要なテーブル、`x_legacy_post_account(uuid,text,text,boolean)`、`auth.uid()`、列数（10／3／3）、anon・authenticated・service_role、いずれもそろっている。
- **ここで auto モードが本番読み取りを拒否した（[Production Reads]）**。拒否後は同じ結果を他の手段で得ることはしていない。

### S0 の残り（操作者が実行。読み取り専用）
- `bash /Users/yuya/Developer/kabumori-g4-pr76-rollout/g4-preflight/run_s0.sh` → `g4-preflight/results/s0_results.json` に出力（件数・真偽値・version・ハッシュのみ）。
- 内容:
  - 所有者と作成ロール、ロール継承の真偽、owner の default function ACL
  - social_accounts のトリガー名と、authenticated の直接書き込み権限
  - アカウントの形ごとの件数
  - Vault 連携・ON のうち、F1 で止まるもの（verified_at 欠落、エラー記録、refresh ブロック）の件数
  - Vault 連携ブランドの running／期限切れ pending／次の予定時刻（AI Lab 個別も）
  - x-test-post を呼ぶ Cron（名前・schedule・active のみ）
  - pgrst event trigger
  - AI Lab claims の有無
  - Edge Function 一覧（version／status／verify_jwt／ezbr）
  - 本番 x-test-post のソースを一時フォルダにダウンロードし、ハッシュだけで照合して削除（PR76 ガードの有無、PR82 runtime の有無、どの参照コミットと一致するか）
- SQL は使い捨て PG17 上の fixture＋実前提 migration で事前に検証済み。そこで `string_agg … order by 1` の非決定性（AI Lab の Stage B 誤検出と同種）を見つけて修正した。

### 要判断: x-test-post の deploy が PR #82 を同時に有効化する
- PR #66（記録上の v131）以降に main で x-test-post の import graph を変えたコミット:
  - PR #76: `vault_account_auth.ts`
  - **PR #82**: `x-test-post/index.ts`、`_shared/brand/ai_lab_{brand_post_store,provider_outcome,scheduled_brand_post,dev_diary_context}.ts`
  - 日記 snapshot の同期
- よって TASK の S1「merged main の guarded x-test-post だけを deploy」を実行すると、**PR #82 の題材確保 runtime も本番で動き出す**。TASK の「PR81／PR82 を bundle しない」と矛盾する。
- AI Lab 側は Stage A（schema）適用済み・Stage B 再検証と Stage C（history）が承認待ち。x-test-post の deploy は AI Lab 側でも「別途・未承認」。
- 選択肢:
  - A（推奨）: AI Lab の Stage B/C を先に完了し、1回の x-test-post deploy（main）を AI Lab の deploy と PR76 の S1 を兼ねるものとして、両方を明示的に承認する。その後 PR76 の S2〜S5。
  - B: AI Lab の Stage B/C より先に main の x-test-post を deploy する。PR82 runtime は Stage A 済みの関数で動くが、AI Lab 側の承認前提を崩す。
  - C: 本番版＋PR76 ガードだけの main 外の成果物を作る。未レビューのため非推奨。
- どの案でも、S1〜S3 の間は Vault 連携（AI Lab）の送信が安全側で失敗する。PR82 runtime が動く場合は、その枠で題材の確保と生成（OpenAI）まで進んでから送信前に止まり、確保は解放される。AI Lab の投稿枠がない時間帯を選ぶ必要がある。
- G5（共通アカウントの本番 migration）とは本番変更を重ねないこと（TASK 指示）。S1 直前に再確認する。

### 固定した本番パッケージ（未実行）
- `g4-preflight/OPERATOR_S1_S5.md` に、正確なコマンド・期待される本番変更・中止手順を固定した。
- 期待される本番変更（これ以外はしない）:
  1. x-test-post の deploy（verify_jwt=false のまま）
  2. migration の自己完結トランザクション（関数2つと権限）
  3. ledger に1行（`20261003090000`, `social_mobile_publish_permission_boundary`）
  4. social-mobile-publish-setting の deploy（JWT 検証 ON）
- トグル・データ行・secret・Cron・手動 dispatch・実 X はなし。
- S3 は AI Lab と同じ3段階方式: Stage A（psql で migration 単独）→ Stage B（読み戻し）→ Stage C（履歴 insert のみ）。db push・migration up/repair・Management API での適用はしない。
- 読み戻し: `s4_readback.sql`＋`check_s4.py`＋`expected_s4.json`。owner は postgres。シグネチャは schema・名前・引数型から組み立て、並びは C collation、本体は prosrc のハッシュ。ローカルで exact／段階違い／未適用の判定を確認し、search_path に依存しないことも確認した。
- ドレイン: Supabase 公式ドキュメントの上限は1回の実行あたり 150 秒（Free）／400 秒（有料）。deploy 時に実行中だったリクエストの扱いは記載がない。このため deploy 完了から 15 分以上待ち、さらに「deploy 前に開始した running の投稿 = 0」を確認する。
- deploy 後の読み戻し: `readback_function.sh <fn>`（一覧で version・status・verify_jwt を確認し、ソースをダウンロードしてハッシュで照合）。
- パッケージのファイルの SHA-256 は、セッションの記録に保存してある（`run_s0.sh` `88cc4ed8…`、`s0_preflight.sql` `a6f5f342…`、`s4_readback.sql` `85704e9b…`、`OPERATOR_S1_S5.md` `11589271…` など）。

### 承認状況
- 承認依頼: **未受領**。以下の3点がそろうまで S1 に進まない。
  1. 操作者による `run_s0.sh` の実行と結果の共有
  2. 上記「PR #82 を同時に有効化する件」の判断
  3. その判断を前提にした、S1〜S5 への明示的な本番承認
- これまでの AI Lab 向けの承認や、TASK の作成を承認とはみなさない。

### production / safety
- 本番への書き込み = 0 / deploy = 0 / トグル = 0 / 実 X = 0 / Auth・Vault・OAuth・Cron の変更 = 0。本番読み取りは上記の SELECT のみ。
- ローカルの使い捨て PG は停止・削除済み。リポジトリへの commit は、この Report 以外にない。

### remaining blockers
1. S0 の残り（操作者による実行）
2. x-test-post／PR82 の扱いの判断（AI Lab の Stage B/C との順序を含む）
3. 本番承認

これらが済むまで、PR76 migration は未適用のまま。よって **G3／PR81 の前提はまだ満たされていない**。

### next recommendation
1. 操作者が `run_s0.sh` を実行する。
2. K4／ユーザーが案 A を判断する（AI Lab の Stage B/C → 共通の x-test-post deploy → PR76 の S2〜S5 を1つの時間帯で行う）。
3. 承認後、G4 が S0 を再実行してから、`OPERATOR_S1_S5.md` どおりに進める（コマンドは操作者が実行する可能性が高い）。

### Addendum（2026-10-06、G4 再開時）
- **AI Lab の DB ロールアウト完了を確認した**（CURRENT_STATE `6a953b92`: Stage B は EXACT、Stage C で history 1行、postflight も EXACT）。これで案 A の前提はそろった。
- CURRENT_STATE 側も、main の x-test-post が PR76 のガードと AI Lab の重複防止ロジックを一緒に含むことを認めたうえで、「即席の deploy はせず、G4 の S0 → 承認 → runtime-first の手順」としている。
- よって S1 の x-test-post deploy は、**PR76 のガードと PR82 の題材確保 runtime を同時に有効化する1回の deploy** として承認を求める（案 A）。
  - deploy から PR76 migration 適用までの間、AI Lab は題材確保と生成（OpenAI）まで進み、送信前に `X_PUBLISH_PERMISSION_UNAVAILABLE` で止まる。確保は NOT_SENT として解放される。
  - このため、AI Lab の投稿枠がない時間帯を選ぶ。
- 固定パッケージ（migration `b2ed7c75…`、x-test-post `faaccc7a…`、publish-setting `a844d7fc…`）は最新 main `0c0f88be` でも不変。
- 引き続き待っていること:
  1. 操作者による `run_s0.sh` の実行。まだ結果がない。auto モードの拒否があるので、Claude は本番読み取りを再試行していない。
  2. 上記を前提にした、S1〜S5 への明示的な本番承認。
- G5（共通アカウントの本番 migration）は in_progress。本番変更が重ならないことを S1 直前に確認する。
- status: in_progress / next_owner: user のまま。

### S0 complete (2026-10-06 00:49 JST; read-only; Claude ran the script with the user's permission)
- 実行: `g4-preflight/run_s0.sh`。SELECT 2本、Edge 一覧、x-test-post のダウンロードとハッシュ照合（一時フォルダは削除済み）。本番への書き込みは 0。結果の要約は `g4-preflight/results/s0_results.json`（SHA-256 `f7a57e08…`）。
- 識別: project `wsmznyzcvmuitkglfeuj`、`postgres`（superuser ではない）、PostgreSQL 17.6、既定の分離レベル read committed。
- ledger:
  - 73 行、最大 version `20261004090000`（AI Lab、exact 1行）。
  - **PR76 `20261003090000` は 0 行**。PR81 `20261003120000` は 0 行。共通アカウント `20261001150000` は 0 行。同名の別 version はいずれもなし。
- 対象の2関数: 同名の関数はどの schema にも 0 件。migration の前提はすべてそろっている（テーブル、helper、`auth.uid()`、列数 10／3／3、API ロール）。
- 所有者:
  - `x_legacy_post_account` の所有者は `postgres`（superuser ではない）で、作成ロールと同一。helper の ACL は所有者のみ。
  - ロール継承はすべて false: anon→authenticated／service_role／owner、authenticated→service_role／owner、service_role→authenticated／owner。
  - postgres の public の default function ACL は所有者のみ（`{postgres=X/postgres}`）。
  - 以上から、migration の事前確認・事後確認とも通る見込み。
- social_accounts:
  - トリガーは想定どおり2つ（refresh reset、deletion guard）。authenticated の直接書き込み（UPDATE／INSERT／DELETE）は false。
  - 形ごとの件数: 非Vault・authorization_pending・OFF 1、非Vault・verified・ON 1（かぶモリ）、Vault・verified・OFF 1、Vault・verified・ON 1（AI Lab）。
  - **F1 の影響: Vault 連携・ON は1件で、構造チェックを通過する**（verified_at 欠落 0、エラー記録 0、refresh ブロック 0、refresh 中 0）。→ 適用後も AI Lab は止まらない見込み。
- 投稿作業（Vault 連携ブランド、2ブランド）:
  - running 0、1時間以上前から running 0、期限切れ pending 0、今後24時間の pending 10。
  - **次の予定: 2026-10-06 07:41 JST（AI Lab）**。AI Lab の running／期限切れ pending は 0。
- Cron: `dispatch-scheduled-posts`（毎分、active）が x-test-post を呼ぶ。
- PostgREST: `pgrst_ddl_watch`・`pgrst_drop_watch` が有効 → DDL 後に schema cache が自動で再読込される。
- AI Lab: claims テーブルあり、関数5つ（DB 完了と一致）。
- Edge:
  - `x-test-post` は ACTIVE v134、verify_jwt=false、updated_at 2026-10-01 14:19 JST（v131 の deploy 時刻。version だけ上がっているのは secret 更新によるもので、コードは不変）。
  - `social-mobile-publish-setting` は未 deploy。関数は全20。
- **本番 x-test-post の中身**:
  - 46 ファイルが PR #66 merge（`9177dbcc`、v131 期）と完全一致。PR76 のガードなし、PR82 の runtime なし（旧版、ガードなし）。
  - 型だけで import される `_shared/x_v2_claim_credentials.ts` は、server 側のバンドルで消える。これを照合スクリプトで「想定どおり不在」と扱うよう修正した（AI Lab の Stage B 誤検出と同種の偽陽性を防ぐため）。修正後の `compare_deployed.py` は `6dad40cc…`、manifest のハッシュは不変。
- 判断: S0 に**問題なし**。PR82 の扱いは案 A（AI Lab の DB は完了済み。1回の x-test-post deploy で PR76 のガードと PR82 の runtime を同時に有効化する）。PR81 は同梱しない（どちらの deploy graph にも含まれない）。
- 固定パッケージは最新 main `cf4498af` でも不変（PR87 の merge は x-test-post／_shared／publish-setting／migration に触れていない）。
- 本番の mutex: G2（PR87 の deploy ゲート）と G5（共通アカウントの migration）が進行中。S1 の直前に、両者が本番変更を行っていないことを確認する。
- 次: ユーザーの明示的な本番承認を待つ（S1〜S5、時間帯は 07:41 JST より前に完了させる）。


## Report — x-social-mobile-pr76-production-rollout-gate-20261006 (final, 2026-10-06)

- task_id: x-social-mobile-pr76-production-rollout-gate-20261006
- result: **PASS — PR76 production rollout S1–S5 complete; every read-back exact**. production_mutation_window **CLOSED**（14:11 JST）。
- model_used: Opus 5.5
- fresh main at close: `7ef61a15`. Source freeze: `e303d81e`（x-test-post／_shared／publish-setting／migration は close 時点の main とも同一）。
- approval: ユーザーの明示承認「S1〜S5 をすべて承認」（2026-10-06 00:5x JST、S0 完了後）。S1 直前に S0 を再実行して実質的な変化なしを確認し、全ブランドで running 0／期限切れ 0 も確認した。

### 本番で行った操作（承認範囲内。これ以外はしていない）
| step | 時刻（JST） | 実行者 | 内容 | 読み戻し |
| --- | --- | --- | --- | --- |
| S1 | 00:57:25 完了（T1） | Claude | `supabase functions deploy x-test-post --no-verify-jwt --use-api`（1関数のみ、prune なし） | v134→**v135**、ACTIVE、verify_jwt=false、ソースが固定 main と完全一致（47ファイル。型専用の `_shared/x_v2_claim_credentials.ts` はバンドルされないので想定どおり不在）、PR76 ガードあり、PR82 runtime あり。他の関数は不変 |
| S2 | 01:12:44 | Claude | ドレイン（T1 から 15 分以上。公式ドキュメントの実行時間上限は 150 秒／400 秒）＋クエリ h | T1 より前に開始した running 0、running 0、期限切れ 0 |
| S3-A | 1回目 ~01:20 | 操作者 | `s3_stage_a.sh`（psql、session pooler、postgres） | **パスワード認証に失敗。接続段階で終了（exit 2）、SQL は1文も実行されていない**。読み戻しで関数 0・履歴 0 を確認 |
| S3-A | ~01:40 | 操作者 | DB パスワードをリセット（事前に影響を確認: Supabase 管理下のサービスは自動追従。リポジトリのコード・ワークフロー・Edge は DB パスワード未使用。secret `SUPABASE_DB_URL` はどのコードも未使用）してから再実行 | 適用成功 |
| S3-B | 01:43 | Claude | `s4_readback.sql`＋`check_s4.py stage-b` | **S4_EXACT (stage-b)** |
| S3-C | 1回目 ~14:05 | 操作者 | `s3_stage_c.sh` | 照合スクリプトの不具合（操作者のターミナルでは CLI の JSON が配列で返るのに、`{rows: …}` 形式しか想定していなかった）で、**履歴を書く前に STOP**。読み戻し自体は stage-b で EXACT。`check_s4.py` を両形式に対応させ、ローカルで両形式と段階違いを確認 |
| S3-C | 14:09 | 操作者 | `s3_stage_c.sh` 再実行 | Stage B EXACT → 履歴 insert 1行 → **S4_EXACT (final)** |
| S4 | 14:09 | Claude（独立の読み戻し） | 同じ読み戻し | **S4_EXACT (final)**。ledger: `20261003090000 / social_mobile_publish_permission_boundary` 1行 |
| S5 | 14:10:33 | Claude | `supabase functions deploy social-mobile-publish-setting --use-api`（config で verify_jwt=true） | **v1、ACTIVE、verify_jwt=true**、ソースが固定 main（= PR76 merge）と完全一致（3ファイル）。関数一覧の変化はこの1件の追加のみ |
| S6 | — | — | なし | アカウントの形は S0 と同一（トグル 0） |

### S4 の読み戻し（固定の期待値と完全一致）
- 2関数: `public.set_social_account_publish_enabled(p_social_account_id text, p_desired_enabled boolean, p_expected_current_enabled boolean)` と `public.assert_x_publish_permission_for_legacy_post(p_scheduled_post_id uuid, p_social_account_id text, p_brand_id text)`
  - owner は postgres（= helper の所有者）、SECURITY DEFINER、plpgsql、volatile、strict ではない
  - config: switch は `lock_timeout=3s,search_path=""`、check は `search_path=""`
  - 本体 SHA-256: switch `2da9f9a2…`、check `eab80dd2…`
- 直接 ACL: `check:service_role:EXECUTE:false;switch:authenticated:EXECUTE:false`、PUBLIC なし
- 実効 EXECUTE: anon はなし、authenticated は switch のみ、service_role は check のみ。その他のロールは 0。同名の関数は2つだけ。
- ledger: 該当行は exact 1、同名の別 version は 0。PR81 `20261003120000` と共通アカウント `20261001150000` は未記録（未着手、想定どおり）。
- PostgREST: `pgrst_ddl_watch`・`pgrst_drop_watch` が有効なので、schema cache の手動再読込は不要だった。

### 適用後の稼働状況（読み取りのみ）
- 部分適用の間（K4 の中間確認時点）にも、AI Lab の自然な投稿は成功し、claims は published になっていた。
- close 時点: running 0、期限切れ 0。S1 以降の投稿は成功 8・失敗 1。
- **失敗の1件はかぶモリの `morning_greeting`（06:43 予定）**。error_code なし。かぶモリは Vault 連携ではないので PR76 のガードを通らず、PR82 の変更も AI Lab の処理だけ。さらに `morning_greeting` は **9/29 から毎日1件ずつ失敗**しており、今回の変更より前からの既存問題。別途調査を推奨する。

### 観測したこと（記録）
- 01:00 前後に、全関数の version が一斉に +1 され、updated_at は不変だった（誰かの `secrets set` によるもの）。x-test-post も v135→v136 になったが、updated_at・ezbr・ソースのハッシュは S1 から不変。
- **別の作業が、本番作業の時間帯中（00:59 JST）に `important-news-monitor` を再 deploy していた**（v92→v94、PR #89 系）。PR76 の対象とは無関係で影響はないが、本番 mutex の告知（G4 は ACTIVE）と重なっていたので記録しておく。
- DB パスワードをリセットした。今後 psql や運用ランナーを使う人・ツールは新しいパスワードが必要。

### 固定パッケージと証跡（未追跡、`/Users/yuya/Developer/kabumori-g4-pr76-rollout/g4-preflight/`）
- migration `b2ed7c75…`、x-test-post の manifest `faaccc7a…`（48ファイル。うち型専用1）、publish-setting の manifest `a844d7fc…`。
- 使ったファイル:
  - `run_s0.sh`、`s0_preflight.sql`、`s0_cron.sql`
  - `readback_function.sh`、`compare_deployed.py`（`6dad40cc…`）、`check_s2.py`
  - `s3_stage_a.sh`（`50081e69…`）、`s3_stage_c.sh`（`eda5f3d7…`）
  - `s4_readback.sql`（`85704e9b…`）、`check_s4.py`（`2da42d66…`）、`expected_s4.json`
  - `references/*.json`
- 結果: `results/`（s0、x-test-post と publish-setting の読み戻し、`s4_stage_b.json`、`s4_final.json` `e0f15820…`）。
- worktree には production link（`supabase/config.toml`、`supabase/.temp/`）が残っている。リポジトリには commit していない。

### production / safety
- 本番への書き込みは承認された4種類だけ: x-test-post の deploy、migration（DDL＋権限）、履歴1行、publish-setting の deploy。DB パスワードのリセットは操作者が行った。
- publish toggle 0、アカウントや投稿の行の変更 0、実 X の手動操作 0、Cron・手動 dispatch・backlog 0、Auth・Vault・OAuth の変更 0。PR81 は同梱していない。PR82 の runtime は承認どおり同時に有効化した。
- Codex の追加レビューは不要（TASK どおり。読み戻しで不一致なし、ソース変更なし）。

### remaining blockers / next
- **PR76 migration の前提は満たされた → G3／PR81（`20261003120000`）を再開してよい。** G5（共通アカウント）も、本番 mutex が CLOSED になったので、自分の再確認から進められる。
- S6（アプリのコントロールの公開・実際の利用）は別の製品／QA 工程として未実施。
- かぶモリ `morning_greeting` の毎日失敗（9/29〜）は別タスクで調査を推奨する。
- status: review_required / next_owner: chatgpt。STOP for K4。

---

## Report — x-morning-greeting-schedule-reliability-bc-20261006 (2026-10-06)

- task_id: `x-morning-greeting-schedule-reliability-bc-20261006`
- result: **PASS — Plan B + C を source-only で実装し、PR #92 を作成**（https://github.com/anohi-memories/kabumori/pull/92）。本番操作は 0。
- model_used: Opus 5.5（推薦は Sonnet5（高）。調査から同じセッションで続けたため）
- base: fresh origin/main `9c6f71bf`。専用 worktree `/Users/yuya/Developer/kabumori-g4-mg-reliability`、branch `claude/g4-morning-greeting-reliability-20261006`
- commit_hash: `3d547584`
- push: branch push 済み、PR #92 open（未 merge）
- deploy: なし

### changed_files（5件のみ）
- `.github/workflows/morning-greeting-image.yml` — Plan B（schedule を4本に）
- `.github/workflows/morning-greeting-image-check.yml` — 新規、Plan C
- `scripts/morning-greeting-image-check.ts` — 新規、Plan C の判定
- `scripts/morning-greeting-image-check.test.ts` — 新規
- `scripts/morning-greeting-image.test.ts` — schedule テストの更新と、冪等性テストの追加

### 新しい schedule（UTC / JST）
| workflow | cron (UTC) | JST |
| --- | --- | --- |
| 画像生成 | `17 15 * * *` | 00:17 |
| 画像生成 | `47 17 * * *` | 02:47 |
| 画像生成 | `17 19 * * *` | 04:17 |
| 画像生成 | `17 20 * * *` | 05:17（06:30 の window 開始の 73 分前） |
| 画像チェック | `7 21 * * *` | 06:07（主） |
| 画像チェック | `47 0 * * *` | 09:47（予備） |

- 旧 `30 20 * * *`（05:30 JST）は削除した。workflow_dispatch と target_date の入力は変更していない。
- どの起動も JST 0 時より後なので、`resolveJstDate()` は遅延しても投稿日を指す（テストでは +9 時間まで確認）。

### 重複生成を防ぐ仕組み（Plan B）
- 既存の仕組みをそのまま使う。各 run はまず `generated/<date>.png` の有無を確かめ、あれば OpenAI を呼ばずに skip する。アップロードは `x-upsert: false`。concurrency group `morning-greeting-image` と `cancel-in-progress: false` はそのまま。
- テスト: 同じ日に4回起動しても、OpenAI 呼び出し 1 回、upload 1 回、2回目以降は `skipped: true` かつ `image_api_called: 0`。target_date を明示した場合も、その日付の画像を作ることを確認。
- ある run が 429 などで失敗しても、次の起動が自動でやり直す。

### 画像チェックの設計（Plan C）
- 読み取りだけで動く。`posting_windows`（`is_active,start_time,timezone`、kabumori と morning_greeting に限定）と、Storage の一覧取得（`POST /storage/v1/object/list/morning-greeting-assets`、prefix `generated`、search `<date>.png`、ファイル名は完全一致で照合、ページ送りあり）。OpenAI の secret は持たない。Storage／DB への書き込みも、X の操作もしない。
- 判定:
  - 朝の挨拶が OFF → pass（`disabled`）
  - 画像が無い → `MORNING_GREETING_IMAGE_MISSING`
  - 画像の作成時刻（`created_at`）が、その日の最も早い window 開始以降 → `MORNING_GREETING_IMAGE_LATE`
  - それ以外 → pass（`on_time`）
- 作成時刻で判定するので、チェック自体が GitHub に遅らされても同じ結論になる。10/6 のように画像が 10:25 に入った日は、チェックが何時に動いても LATE になる。
- 読み取りの失敗や想定外の形式は、決まったエラーコードで失敗させる（READ_FAILED / RESPONSE_MALFORMED / WINDOW_* / LIST_TOO_LARGE）。pass にはしない。
- 出力は `::error` の注記と JSON だけで、中身はエラーコード・日付・時刻のみ。キー・URL・例外メッセージは出さない。MISSING のときは、手動で画像を作るコマンドを注記に含める。
- 失敗時は exit 1 で GitHub の run が失敗になり、通常の failed-run 通知が飛ぶ。scheduled workflow の通知先は「cron を最後に変更したユーザー」（GitHub docs）。
- concurrency group は画像生成とは分けた（`morning-greeting-image-check`）。待機中のチェックが待機中の生成を押し出さないようにするため。

### tests
- `node --experimental-strip-types --test scripts/morning-greeting-image.test.ts scripts/morning-greeting-image-check.test.ts` → **44/44 pass**（変更前の既存 26/26 → 28 + 新規 16）
- 内訳:
  - cron の UTC↔JST の対応（定刻と遅延時）
  - 冪等性、target_date の明示指定
  - チェックの各判定: 期限内、無し、遅延、境界（期限ちょうどは LATE、1ms 前は pass）、OFF、類似したファイル名、ページ送り、一覧が終わらない場合、各種エラー、複数 window（最も早い開始を採用）
  - 出力に秘密情報が出ないこと
  - `main()` を実プロセスで起動し、exit 1 になり、キーや URL が出ないこと（env なし／接続拒否）
  - workflow の静的な検証（secret は2つだけ、OPENAI なし、concurrency、permissions）
- ミューテーション確認: 境界の `>=`→`>`、ページ送りの削除、例外メッセージの出力 → いずれもテストで検出できた
- YAML は Ruby Psych で parse できることを確認。strict な `tsc` は新規・変更ファイルでエラー 0（既存の未変更ファイルの既存エラーのみ）。`git diff --check` も問題なし。

### 10/7 の手動 fallback（実行していない）
```
gh workflow run morning-greeting-image.yml --repo anohi-memories/kabumori -f target_date=2026-10-07
```
PR の merge が明朝に間に合わない場合に使う。OpenAI 1回と Storage 1件の書き込みが発生するので、実行はユーザーの承認後。

### safety_checks
- production mutations = 0（deploy、DB、Storage、X、手動 dispatch のいずれも 0）
- GitHub token / Vault / Supabase Cron / secret の変更 = 0。既存の GitHub secrets（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY）を再利用しただけ。
- 他スロットの worktree・ファイルには触れていない（G3 の PR81、G2、G5）

### remaining_issues
- まだ GitHub の scheduler に依存している。4回の起動がすべて落ちる、または5時間超遅れる日は、まだ間に合わない可能性がある（そのときは 06:07 のチェックが、動けば通知する）。根本的には Plan A で解消する。
- Storage の一覧 API は、本番ではまだ実際に呼んでいない（形式はモックで検証し、shape は storage-js の list() と型定義で確認）。merge 後に、読み取りだけの workflow_dispatch で確認することを推奨する: `target_date=2026-09-17`（pass 期待）と `2026-10-06`（IMAGE_LATE 期待）。もし API が想定と違っても、失敗として表に出る（黙って pass にはならない）。
- 06:30 より後、実際の投稿時刻より前に手動で作った画像は LATE と判定される（安全側に倒した判定）。
- 本文の生成が画像の確認より先に走り、画像が無い日にも OpenAI 本文のコストがかかる問題は、本 TASK の対象外（x-test-post の deploy が必要）。

### next_recommendation
- K4 → merge。merge 後は上記の read-only dispatch 2本で Storage list の実地確認をする。今夜 merge できない場合は、10/7 の手動 fallback の要否を判断する。
- Plan A（Supabase pg_cron → GitHub `workflow_dispatch`）を別 TASK にする。このリポジトリの Actions 起動だけに絞った fine-grained token を Vault に保存する必要がある。Codex／Luna の security review を1回推奨。
- status: review_required / next_owner: chatgpt。STOP for K4。




