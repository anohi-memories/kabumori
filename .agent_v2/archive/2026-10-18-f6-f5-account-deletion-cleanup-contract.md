# F6 — 共通AI削除RPCとF5アカウント削除フローの接続契約
- task_id: common-ai-f6-f5-account-deletion-ai-cleanup-contract-20261017
- slot: F6
- owner: claude
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Sonnet5（高）**
- production_permission: NO_GO
- previous_archive: .agent_v2/archive/2026-10-17-f6-pr261-privacy-source-fix.md
- dependencies: F6 Draft PR249→256→261 (PR261 focused P2 fixed); F5 Phase13 D-3 current ready, separate owner; F4 POSTONA Auth UI separate; common account G5. All PR HEAD/base verify live before start.

## 目的
F5/G5が共通アカウント削除手順へAI履歴削除と費用台帳匿名化を安全に接続できるよう、**F6所有の契約、呼び出し順、例外時の再試行/補償、入力・出力、オフラインテスト**を整える。F5 Phase13 D-3を妨げず、F5/POSTONA/既存DB実装は変更しない。現状のPR261はソース候補で、本番未適用。

## 作業前必須
PROJECT_RULES、旧新ORCHESTRATION/ACTIVE_TASK/CURRENT_STATEの必要metadata、F5/G5とPOSTONA G3/G4/F3/F4の進捗、F6過去Report、PR249/256/261最新HEAD、fresh origin/mainとmigration/DB/RPC/Auth/Edgeファイルの変更競合を最小範囲で確認する。独立clean worktree必須。他slotのcheckout、未コミット変更やdev serverに触れない。所有競合・契約不明はSTOPして報告。

## F6成果物（source-only）
1. 現行F5/G5アカウント削除のcheckpoint/residue、session revocation、social_and_login経路、service entitlement停止とPOSTONA入口、RLS/Auth境界をread-onlyで調査。source path/symbolと未実装部分を区別。
2. F6側RPC `public.ai_calls_forget_user`、`public.ai_calls_forget_system_brand`、`public.ai_ledger_erase_user`、`public.ai_ledger_user_footprint` の厳密な入出力・error・前提条件・service_role権限・トランザクション/分離レベル・冪等性を実際のPR261積み上げソースに基づき文書化。未確認の関数名/値は推測禁止。
3. 推奨順序：利用権のserver-side ended確定→新規AI認可停止のread-back→最大bridge deadline＋余裕待機→inflight解消確認→call storeのユーザー削除→system brand削除→ledger匿名化→footprint全0(`policy_mentions`含む)→最後の掃除→既存F5 deletion checkpoint / residue。部分失敗時は失敗を成功扱いせずfail-closed、再実行時は冪等。system brand slugとuser IDを混同しない。
4. F5が所有すべき最小実装のファイル・変更口、既存X/Threads削除sagaとの順序・競合、操作ごとの権限境界、管理されたSupabaseで初めて検証できる点、本番前のプライバシー/保持/PITR条件を明確化。
5. F6所有の新規docs/ai-provider/F6_*とdeploy対象からimportされないmock/contract testsだけ追加可能。off-line deny-net/偽キー。PR261の既存migrationを含むDB/RPC本体、PR249ロールバック、F5/F4/Auth/POSTONA/Edge/Cron/Secretsは変更しない。
6. F5/G5チャットへそのまま渡せる**短い独立コピー用の接続依頼文**をdocsに用意。推薦モデル Opus5.5（高）、F5実装はF5が自分のTASKを完了・archive後に担当チャットの許可で別TASK登録するよう明記。既存F5 Phase13を上書きしない。

## 安全
本番・managed Supabaseへのアクセス（読み込み含む）、SQL適用、Auth/RLS変更、実Anthropic/OpenAI有料API、SNS投稿、Cron、merge/deployを禁止。ローカルPGが必要なら独立socket-only環境に限定。ドキュメントと純粋テストで確定できない事項はNOT_VERIFIED。本番送信はユーザーの方針了承だけで、正式規約変更やproduction承認ではない。

## 完了
変更ファイル、source paths、RPC呼出し契約、依存owner、テストとNOT_VERIFIED、PR/commit/pushとhead/base read-back、衝突、残課題をF6 TASK末尾Reportへ記録。status review_required/next_owner chatgpt/L6。source-onlyなら追加の機械的レビューは不要。
## Report
- task_id: common-ai-f6-f5-account-deletion-ai-cleanup-contract-20261017
- result: **CONTRACT_DONE（Draft PR #264、#261 の上に積んだ）。F6 の 4 つの RPC の厳密な契約、呼ぶ順番と失敗・再試行、F5 の最小の変更、本番の前の前提、F5 / G5 への依頼文、参照の実装とテスト（偽の RPC 10 件、本物の SQL 5 件 PASS）**
  - 変えたのは F6 の新しい文書と、deploy されないテストのファイルだけ。DB・RPC 本体（#261 の migration を含む）、#249 の rollback、F5 / F4 / 認証 / POSTONA / Edge / Cron / Secret は変えていない
  - 本番・Supabase には読むだけでも接続していない。有料の呼び出し・SNS・Cron の作成・deploy・merge は 0
  - 途中で利用上限に達したため止まり、利用者の指示どおり 2026-10-18 00:01 JST に自動で再開して仕上げた（止まる前に commit・push 済み）
- 作業前の確認
  - fresh main `bc16edc4`（開始時）
  - #249 / #256 / #261 の head は変わっていない（`e589e2c39886fde582bd31a4c25fd4f6839fac49` / `1830320bd93fcfa458411dcf00f130d87d607d39` / `017c7eb7803a134e83d1f128576b62bc69b4fcb4`）
  - F5 は別の作業（Phase13 D-3、hosted の事前の確認）で重ならない。G3 / G4 / G5 / F3 / F4 は done。task_id の重複なし
- branch / commit / PR
  - `claude/f6-f5-ai-cleanup-contract-20261017`（新しい独立した worktree `/Users/yuya/Developer/kabumori-f6-f5-contract`、#261 の head から作成）
  - commit `c558264218badd1ebbdb9063e70f8e7cce9ac23d`（push 済み、`git ls-remote` で同じ値を確認）
  - Draft PR [#264](https://github.com/anohi-memories/kabumori/pull/264)。読み返し: OPEN / Draft、base `claude/f6-pr256-policy-pii-fix-20261017`（#261、`017c7eb7803a134e83d1f128576b62bc69b4fcb4`）、head `c558264218badd1ebbdb9063e70f8e7cce9ac23d`、5 ファイル、MERGEABLE
- changed_files（5、すべて新規）
  - `docs/ai-provider/F6_F5_ACCOUNT_DELETION_AI_CLEANUP_CONTRACT.md`
  - `supabase/tests/ai_account_deletion_cleanup_contract.ts`（参照の実装 `runAiAccountCleanup`。deploy しない、`rpc` は外から渡す）
  - `supabase/tests/ai_account_deletion_cleanup_contract_test.ts`（偽の RPC）
  - `supabase/tests/ai_account_deletion_cleanup_contract_pg_test.ts`（本物の SQL）
  - `supabase/tests/ai_account_deletion_cleanup_contract_run.sh`（ローカルの socket だけ、TCP なしを確かめる）
- source paths（docs §1。main `bc16edc4` と F5 の stack の先頭 #259 `422c101aff4bb475db075abf2c0e9423582069ae` を読み取りで確認。主な点は自分でも確かめた）
  - 削除の順番: `account-delete/lifecycle_logic.ts`（gate :339 → … → 全サービスが ended の確認 :445-447 → session :449-463 → Apple → Storage :497-506 → prepare :508-528 → ログインの削除の外部の段 :530 → 削除 :539-559 → complete :561-575）
  - checkpoint を書く口: `20261009120000_common_account_deletion_completion.sql:327` は `session_revocation` / `storage_cleanup` だけ。**AI 用は無い**
  - 残りの確認: `account_lifecycle_footprint`（foundation :567-590）/ `residue`（completion :507-530）は決め打ちで、**AI を見ていない**
  - ログインの削除の gate: `managed_auth_delete` は blocked（今は届かない）
  - X の saga の `social_and_login`: `20260928160000…:619` が `delete from auth.users`（**共通アカウントの流れの外**）
  - POSTONA の AI の入口: 相談（`social-mobile-consult/logic.ts` :712-724）・試し投稿（`social-mobile-brand-dry-run/logic.ts` :265-393）とも、**利用権・共通アカウントの状態を見ていない**
  - service_role が利用権を読む口: `common_account_deletion_eligibility(uuid)`（foundation :904-941）
  - ワークスペースの slug: `public.social_mobile_account_deletion_workspace(uuid)`（`20260928160000…:98-100`、`'u_' || substr(md5(user_id), 1, 24)`）は service_role から取り上げ済み（:679）
  - F5 の文書 #147（`phase3i-lifecycle-safety-design.md:227`）は台帳の利用者 ID の消し方を「未決」としている → この文書が答え
- RPC の呼び出しの契約（docs §2、#261 のソースの行番号つき）
  - 4 つとも SECURITY DEFINER・`search_path = ''`・service_role だけ。冪等で、1 回の取引で全部か何もしないか
  - 利用者 ID は小文字の uuid（`ai_calls_forget_user` は大文字を拒む。本物の SQL で確認）
  - slug は `^u_[0-9a-f]{24}$`。ID と取り違えない（参照の実装も SQL も拒む）
  - 答えの形（成功・続けられない理由）、error（SQLSTATE と文言の頭）、lock、READ COMMITTED の決まりを表にした
- 順番と再試行（docs §3）
  - 前提: 全サービスが ended の読み返しの時刻、AI の入口が止まっていることの読み返し
  - 60 秒＋余裕を待つ → forget_user → forget_system_brand → erase_user → footprint（`policy_mentions` を含めて全部 0 のときだけ `done`）→ ログインの削除の直前にもう一度
  - 答えと F5 がすること:
    - `done` → checkpoint
    - `wait` / `retry_later` → 進行中のまま、後でやり直す
    - `operator_required` → 運用者へ
    - `refused` → 呼び出し側の誤り
    - `failed` → 成功にしない
  - 取り消しは要らない
- F5 の最小の変更（docs §4、F5 の担当）
  - `http.ts` の RPC の名前
  - 参照の実装を F5 自身のファイルに写す（tests から import しない）
  - `lifecycle_logic.ts` に AI の掃除（Storage の後・prepare の前）と最後の掃除（prepare の後・ログインの削除の外部の段の前）
  - migration で checkpoint `ai_data_cleanup` を登録し、書く口に足す。書く前に SQL の中で footprint が全部 0 かを確かめる
  - `residue` に AI の数を足す
  - migration の順番（F6 の 3 つ → F5）
  - `social_and_login` の経路の扱い（F3 / G3 / F5）
  - 権限の境目の表も載せた
- 本番の前・本物の Supabase で初めて確かめられること（docs §5）
  - 必須の前提: POSTONA の入口の利用権の確認、F5 の変更、`social_and_login`、後片付けの仕事
  - 保持・プライバシー・PITR（バックアップに残る期間）・サーバーの記録は NOT_VERIFIED
  - PostgREST の error の形・分離レベルの既定・migration のロール・削除の時間は NOT_VERIFIED
- 依頼文: docs §8 に、F5 / G5 のチャットにそのまま渡せる短い依頼文
  - 推奨のモデル Opus5.5（高）
  - 今の F5 の TASK を完了・archive した後、担当のチャットの許可で別の TASK として登録する。Phase13 を上書きしない
- tests
  - 偽の RPC（`--deny-net --deny-write`）: **10 PASS**
    - 正常、slug なし、前提・入力の拒否 8 通り、締め切りの待ち、各段の処理中、運用者へ、読み返しが 0 でない 7 通り、各段の RPC の error、形の違う答え 14 通り、やり直し
  - 本物の SQL（#249 → #256 → #261、ローカルの PostgreSQL 17.11、`listen_addresses = ''`、Unix socket だけ）: **5 PASS**
    - done → 何も残らない → 2 回目は 0 件
    - 処理中 3 種
    - 他人の枠が ID を含む → 運用者 → 直すと done
    - 本物の SQL が大文字の ID・ID と slug の取り違え・REPEATABLE READ を拒む
  - わざと壊した写し（作業用のフォルダだけ）: 9/9 検出
  - main（`3aae71c8377617e81b4065090c269e0c63e7517e`）と合わせた木（merge-tree `b8bf6569849d94120f176f5bf139f294956f85a1`、衝突なし）: 契約のテスト 10＋5 PASS、共通AI基盤＋市況レポート＋ bridge 546 PASS / 0 FAIL、invariants 11 PASS
  - lint 0 件、`git diff --check` OK
  - NOT_RUN: 本物の Supabase・PostgREST、`_shared` 全体の既知の型エラー 5 件・権限で止まる 1 件
  - 後片付け: ローカルのクラスタを止め、データ・socket・合わせた木を削除
- collision: 新しい 5 ファイルに触れる開いた PR は無い（開いた PR 124 本を確認）。読み返し（すべて OPEN / Draft、head は変わっていない）: #261 `017c7eb7803a134e83d1f128576b62bc69b4fcb4`、#256 `1830320bd93fcfa458411dcf00f130d87d607d39`、#249 `e589e2c39886fde582bd31a4c25fd4f6839fac49`、F5 の #259 `422c101aff4bb475db075abf2c0e9423582069ae`
- remaining_issues / 担当
  - POSTONA: AI の入口での利用権・共通アカウントの確認（本番の前に必須）
  - F5 / G5: docs §4 の変更（依頼文 §8）、`social_and_login` の扱い（F3 / G3 と）
  - F6（#249 の持ち主、別の作業）: `ai_calls_forget_user` に READ COMMITTED の確かめが無い
  - 利用者・運営: 保持・プライバシー・PITR の判断
- production: **NO_GO**
- review: source-only の文書とテストだけ（TASK のとおり、追加の機械的なレビューは要らない）
- next_owner: chatgpt
- recommended_model: F5 の実装は Opus5.5（高）

## L6 decision — 2026-10-18
- verdict: PASS_CONTRACT / SOURCE_ONLY / F5_HANDOFF_READY / PRODUCTION_NO_GO.
- verified PR264 OPEN Draft unmerged, HEAD `c558264218badd1ebbdb9063e70f8e7cce9ac23d`, stacked on PR261, 5 files. F6 changed only documentation and undeployed tests.
- implementer-reported mock RPC 10 PASS, isolated local PG17 SQL integration 5 PASS, mutations 9/9, merged-tree regression 546 PASS; ChatGPT has not independently rerun tests. Managed/PostgREST NOT_VERIFIED.
- Handoff: F5/G5 must own integration into account deletion checkpoint/residue + POSTONA entry entitlement gate, protect existing F5 Phase13 D-3 TASK. PR249 ai_calls_forget_user READ COMMITTED guard separately pending. Legal/privacy/PITR, cleanup Cron and production rollout remain blocked.
- No merge, managed DB mutation, SNS, paid API, deploy authorized.
