# F6 — POSTONA既存OpenAI相談 × 共通AI基盤 オフライン1件統合
- task_id: common-ai-f6-postona-openai-consult-offline-one-request-integration-20261018
- owner: claude
- slot: F6
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- production_permission: NO_GO
- mutation_window: CLOSED
- previous_archive: .agent_v2/archive/2026-10-18-f6-f5-account-deletion-cleanup-contract.md
- source_instruction: POSTONA総合指令室 Issue #269 comment 6245437658 (2026-10-18)
- dependencies: Existing POSTONA OpenAI consult social-mobile-consult; H5 Bridge PR198 and PR239/241/249/256/261/264 source-only Draft, not premerged; F1 POSTONA X manual UI ready, F5 X first publish auth contract ready, F3/G3 X path separately prioritized.

## 目的・優先順位
POSTONA既存OpenAI AI相談を維持し、**1件の相談リクエストをoffline/mockだけで、入口→本人/brand/POSTONA active entitlement→既存OpenAI/shared-provider adapter→結果整形/エラー→使用量/費用台帳と二重実行防止**まで検証する最小接続候補を作る。総合指令室の最優先X手入力投稿を阻害しない。Claude全面移行・モデル選択・投稿文生成・予約AIは対象外。

## 開始ゲート
開始時にPROJECT_RULES、新旧ORCHESTRATION、旧新ACTIVE_TASK/CURRENT_STATEの現在部分、F6/旧G6 Report、fresh origin/main、関連PR HEAD/base、既存相談handlerとF1/F3/F5/F4変更対象をread-only確認。別slot独立worktree、未コミット変更、shared Edge/Auth/DB/API境界競合、同task_id重複を確認。契約不整合やpath overlapはSTOPして担当ちゃへ報告。F5のM1 X認証TASKは絶対に上書きしない。

## 作業（F6所有範囲のみ）
1. 既存 `social-mobile-consult` → OpenAI Responses API と画面 `consult-client.ts` を読み取りで把握。既存のconsult JSON Schema、sanitize/error mappingを保つ。
2. 既存共通AI Provider（OpenAI）・ledger guard・H5 consumer bridgeのAPI契約、保存境界、利用量/費用計上とoperationIdの実態を現ソースで検証。既存機能にDB-backed dedupeが無い場合、mock上のPASSと実本番保証を厳格に区別する。
3. **相談1リクエストの完全offline E2E**：偽OpenAI adapter・偽JWT/owner/entitlement・偽予算/永続CallStoreを注入、既存相談レスポンス形と失敗分類を検証。P0条件として POSTONA利用権activeでない・account deleting/ended・他ユーザーbrand・署名/本人確認不可・利用額超過時は外部送信0。認可完了前にProviderへ到達しない。
4. usage input/output tokens、上限単価、予約→確定/unknown、異常時fail-closed、同一operationIdの二重請求/同時実行防止をテスト。実在するledger/API契約を再利用し、架空の本番台帳PASSとしない。
5. F1へ最小のUI契約（入力、response/error、quota表示）、F5へserver-side entitlement/Auth/停止時認可欠落・必要RPC/API境界をコピー可能な独立申し送りでdocsに記す。F5/F1 codeとTASKは触れない。
6. F6所有の独立接続adapterまたはoffline-only seamとテスト、新規docsのみ許可。 `social-mobile-consult` 実運用のhandler自体がF3/F1等と競合する場合は書き換えず契約・mockと未接続判定に留める。実POSTONAサーバーへの接続はownerと安全ゲート確認後の後続TASK。
7. 既存Claude H5 Bridgeは再利用方針だけ確認。Claude本番切替・model policy大変更禁止。

## 変更禁止／安全
F1画面、F3/X投稿・予約、F4 OAuth/credential、F5 common Auth/entitlement/deletion、既存共通DB migration/RLS/RPC/Edge/Cron/Secrets/H5-owned Bridge、他slot branch/worktree、prod/managed Supabase、実OpenAI/Claude有料API、SNS、external write、merge/deploy/EASは変更・実行禁止。**server-side entitlement未接続の相談入口は公開しない**。実API検証は別の個別承認必須。

## テスト・完了条件
- 1件のmock相談（入力→合法結果）、悪意/他user/停止・quota拒否、duplicate operationIdと同時実行、cost unknown/fail/no-resendを確認、PASS/FAIL/NOT_VERIFIEDを区別。
- source paths, changed_files, test numbers, commit/push, Draft PR head/base, collision, separate read-backをReportに残す。新規F6 TASKだけ更新し、status review_required / next_owner chatgptでL6を返す。
- L6後はPOSTONA総合指令室へ到達点（mock/実API/アプリ動作差）と依存owner・次候補（推薦モデル付き）を報告して次指示待ち。レビューはAuth/DBの新たな高リスク変更があった場合のみ。
## Report
- task_id: common-ai-f6-postona-openai-consult-offline-one-request-integration-20261018
- result: **OFFLINE_SEAM_DONE（Draft PR #273、#264 の上に積んだ）。POSTONA の今の OpenAI の AI 相談 1 件を、入口 → 本人・ワークスペース・POSTONA の利用権 → 共通AI基盤（OpenAI）→ 答えの形・error → 費用の台帳・二重実行の防止、までオフラインでつないで確認。偽の部品 9 件・本物の台帳と保存の場所の DB 定義 5 件 PASS、わざと壊した写し 11/11 を検出**
  - 今の `social-mobile-consult`（相談の本体）、F1 の画面、F3 / F4 / F5、共通の DB / RLS / RPC / Edge / Cron / Secret / H5 bridge は変えていない
  - 本番・Supabase・OpenAI には接続していない。有料の呼び出し・SNS・外部への書き込み・deploy・merge・EAS は 0
  - **利用権の確認がつながっていない相談の入口は公開しない**（本物の相談につなぐのは別の作業）
- 開始時の確認
  - fresh main `74b6b7ceafe6b3683ee985616b3a4e2ddb04763d`
  - F1（X の手入力の画面）は ready、F3（X の 1 件の投稿）は in_progress、F5（X の最初の手入力の認証）は ready。どれも相談のファイルに触れない（開いた PR 128 本で、相談の本体・アプリの相談の呼び出しに触れるものは無し）
  - task_id の重複なし。F6 の積み上げ #264 / #261 / #256 / #249 と H5 の #198 の head は変わっていない
- branch / commit / PR
  - `claude/f6-postona-openai-consult-seam-20261018`（新しい独立した worktree `/Users/yuya/Developer/kabumori-f6-consult-seam`、#264 の head `c558264218badd1ebbdb9063e70f8e7cce9ac23d` から作成。相談の本体のファイルは main と同じ）
  - commit `84ee0d6f7cf04b35f790d074435456b4e591a8d1`（push 済み、`git ls-remote` で同じ値を確認）
  - Draft PR [#273](https://github.com/anohi-memories/kabumori/pull/273)。読み返し: OPEN / Draft、base `claude/f6-f5-ai-cleanup-contract-20261017`（#264、`c558264218badd1ebbdb9063e70f8e7cce9ac23d`）、head `84ee0d6f7cf04b35f790d074435456b4e591a8d1`、5 ファイル、MERGEABLE
- changed_files（5、すべて新規、deploy されない）
  - `supabase/tests/postona_consult_shared_provider_seam.ts`（つなぎの部品 `createConsultSeam`）
  - `supabase/tests/postona_consult_shared_provider_seam_test.ts`（偽の部品だけ）
  - `supabase/tests/postona_consult_shared_provider_seam_pg_test.ts`（本物の台帳と保存の場所の DB 定義）
  - `supabase/tests/postona_consult_shared_provider_seam_run.sh`（ローカルの socket だけ、TCP なしを確かめる）
  - `docs/ai-provider/F6_POSTONA_OPENAI_CONSULT_OFFLINE_SEAM.md`
- source paths（docs §1）
  - `social-mobile-consult/logic.ts` の `handleSocialMobileConsult` :694（本人 → 入力 → 持ち主 → 保存済みの設定 → `callModel` → `sanitizeConsultModelOutput`）、`callOpenAiConsultModel` :474、差し替えの口 `ConsultDependencies.callModel` :95-106
  - アプリ `apps/social-mobile/src/data/consult-client.ts`（`functions.invoke`、error のコードを見る）
  - 利用権の表: `20261001150000_common_account_lifecycle_foundation.sql`（利用者は自分の行の決まった列を読める :341-356）
  - 共通AI基盤: `executeAiRequest`（`execute.ts:160`）、OpenAI の部品（`store:false`、strict な決まり）、`SupabaseLedgerBudgetGuard`
  - 保存の場所 `ai_calls`（#249）
  - H5 bridge（#198）は Claude だけ → 今回は使わず、保存の場所の決まりと呼び出しの番号の作り方だけ揃えた
- 中身（docs §2）
  - 今の本体を `callModel` の口で包む。本体の前に、次の 3 つを確かめる:
    - 本人（`/auth/v1/user`）
    - `Idempotency-Key`
    - POSTONA の利用権: 利用者の JWT で `common_accounts.status` と `service_entitlements(x_autopost).status` を読み、両方 active
  - 本体が持ち主・保存済みの設定を確かめて本文を作った後で、F6 の部品が次をする:
    - 本文を検査して共通AI基盤の 1 件の依頼に変える（決まりが違えば送らない）
    - 保存の場所で claim
    - 1 回だけ送る（台帳: 予約 → 送信 → 確定、不明なら最大額）
    - 記録してから返す
  - 答えの形と本体の検査は今のまま
  - 新しい error のコード: `CONSULT_OPERATION_ID_REQUIRED` / `CONSULT_NOT_ENTITLED` / `ENTITLEMENT_READ_UNAVAILABLE` / `CONSULT_IN_PROGRESS` / `CONSULT_OPERATION_REUSED` / `CONSULT_QUOTA_EXCEEDED` / `CONSULT_AI_UNKNOWN`。保存した失敗は `retryable: false`
- tests
  - 偽の部品だけ（`--deny-net --deny-write`、偽の鍵）: **9 PASS**
    - 1 件の相談: 今の本体と同じ形・同じ結果、OpenAI への送信は 1 回（今と同じモデル・決まり・上限）、利用者 ID・slug・JWT・メール・鍵は送らない、台帳は利用者の `postona / consult` で予約 1・確定 1、保存の場所は主体に結びつく、記録に文も ID も残らない
    - P0 の 15 通り（JWT なし・偽、番号なし・短い、共通アカウントが deleting / locked / 無い、POSTONA が ended / deleting / suspended / provisioning / 無い、利用権が読めない、他人のワークスペース、知らない項目）→ **OpenAI・台帳・保存の場所のどれにも届かない**
    - 上限 → 送らない
    - 再送 → 送信 1・予約 1。別の利用者の同じ番号は別
    - 中身違い → `CONSULT_OPERATION_REUSED`
    - 同時 → 送信 1、もう片方は処理中
    - 切断 → 最大額・不明、送り直さない
    - OpenAI の失敗・形の違う答え・本体の検査で弾く答え → 送り直さない
    - 記録の喪失 → 不明、その後は処理中
  - 本物の台帳と保存の場所の DB 定義（ローカルの PostgreSQL 17、`listen_addresses = ''`、Unix socket だけ、クラスタの識別子 `7697885547262399967`）: **5 PASS**
    - 予約は `settled`、`request_id` は保存の場所の番号と同じ、使用量は確定の値、再送で予約は増えない
    - 1 日 1 回の枠の 2 件目は `CONSULT_QUOTA_EXCEEDED`・予約なし・保存の場所に `BUDGET_DENIED`
    - 枠が無い → 安全側で断る
    - 切断 → 台帳は `unknown`・最大額、保存の場所は `UNKNOWN`、送り直さない
  - わざと壊した写し（作業用のフォルダだけ）: 11/11 検出
  - 今の相談の本体のテスト（`logic_test.ts`、変更なし）: 26 PASS
  - main と合わせた木（merge-tree `3521d3db299299aee36f84fb18566f959a1a9578`、衝突なし）: 部品のテスト 9＋5、本体 26、共通AI基盤＋市況レポート＋ bridge 546 PASS / 0 FAIL、invariants 11 PASS
  - lint 0 件、`git diff --check` OK、秘密情報の文字列 0
  - NOT_VERIFIED: 本物の OpenAI、本物の Supabase（PostgREST での利用権の表の列の権限・RLS）、アプリでの表示、本番の台帳の行と枠、保存の場所の本番の適用、`_shared` 全体の既知の型エラー 5 件・権限で止まる 1 件
  - 後片付け: ローカルのクラスタを止め、データ・socket・合わせた木を削除
- mock / 実 API / アプリの差（docs §5）
  - 本番の相談には、利用権の確認・二重実行の防止・費用の台帳が今は無い。今回の PASS はオフラインの振る舞いで、本番の保証ではない
  - 本番の台帳には POSTONA の枠が無い（今つないでも断られる）
  - 保存の場所は本番に未適用
  - モデルへの入力の形が少し違う（会話をデータとして 1 つの入力に）→ 有料の品質の確認が要る
  - アプリは `Idempotency-Key` をまだ送らない（F1）
- 申し送り（docs §6・§7、そのまま渡せる文）
  - F1: `Idempotency-Key`（発言ごとの UUID、自動の送り直しは同じ値）、新しい error と表示の案、`retryable: false` は自動で送り直さない
  - F5: 本番の相談・試し投稿は利用権を見ていない。2 つの表を直接読む形でよいか F5 の RPC に揃えるか、削除の途中で AI の認可が止まることの結びつき、本物の Supabase での列の権限・RLS
- 依存の担当と次の候補（推奨のモデル）
  1. POSTONA の担当: 本物の相談の入口にこの部品をつなぐ（フラグ、既定は今の直接の呼び出し）— Opus5.5（高）。前提は F5 の判断・保存の場所の本番の適用・台帳の POSTONA の枠（別承認）
  2. F1: `Idempotency-Key` と error の表示 — Opus5.5（高）
  3. F5: 利用権の確認の口と削除の手順との結びつき — Opus5.5（高）
  4. 利用者・運営: 有料の品質の確認、台帳の枠の数字
- production: **NO_GO**
- review: 新しい Auth / DB の高リスクな変更は無い（オフラインの部品とテストと文書だけ）
- next_owner: chatgpt（L6 の後、POSTONA 総合指令室へ到達点と依存の担当・次の候補を報告して次の指示待ち）

## L6 decision — 2026-10-18
- verdict: PASS_OFFLINE_INTEGRATION / SOURCE_ONLY / PRODUCTION_NO_GO. No additional security review for 5 test/docs-only files.
- verified PR273 OPEN Draft, unmerged, HEAD `84ee0d6f7cf04b35f790d074435456b4e591a8d1`, base F6 PR264, 5 new nondeploy files.
- Reported tests: mock9, local PostgreSQL5, mutations11/11, existing consult26, integrated546, invariants11 PASS; not independently rerun by ChatGPT.
- NOT_VERIFIED: real OpenAI, managed Supabase/PostgREST RLS and entitlements, real POSTONA app, production call store and quota policies. Current consult server still lacks production entitlement and idempotency/ledger wiring; do not publish. F1 Idempotency-Key and error mapping; F5 auth/service halt contract; F6 POSTONA budget policy and source integration require separate coordination and authorization.
- Next: report milestone to POSTONA総合指令室 Issue269, then HOLD for new instruction; no merge/deploy/paid API/managed writes.
