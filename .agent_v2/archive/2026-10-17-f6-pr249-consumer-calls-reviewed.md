# F6 — POSTONA AI台帳 consumer_calls migration候補・ローカルPG検証
- task_id: common-ai-f6-postona-consumer-calls-pg-offline-candidate-20261017
- slot: F6
- owner: claude
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- production_mutation_window: CLOSED
- previous_archive: .agent_v2/archive/2026-10-17-f6-pr241-ledger-design.md
- dependency: Draft PR #241 HEAD 84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6 stacked on #239; original Provider/Bridge Draft stack #187→#198→#205→#219→#222→#231→#234→#237→#239→#241.
- production_permission: NO_GO

## 目的
PR #241の設計をもとに、POSTONA Claude APIの永続的な重複防止・課金管理に必要な `ai_ledger.consumer_calls` テーブル/RPC/RLS/SECURITY DEFINERを**ソース候補として実装し、隔離されたローカルPostgreSQLだけで検証**する。今回は本番環境・managed Supabaseへの接続、DB適用、API有料呼び出し、SNS投稿、merge/deployは一切禁止。アプリ本体・既存POSTONA運用に変更なし。

## 開始前の必須ゲート
- fresh origin/main、PROJECT_RULES.md、旧新ORCHESTRATION/ACTIVE_TASK/CURRENT_STATEの該当metadata、F3/F4/F5/G3/G4/G5/H5/旧G6/F6最新owner・status・PR heads・changed filesを確認。task_id重複/マイグレーション衝突/同一ファイル競合を検出。
- PR #241 HEADとbase、PR #239、他のAuth/RLS/DB/共有AI領域のPRを再確認する。
- clean独立worktreeまたはcheckout。既存他slotのcheckout/reset/rebase/未コミットファイルやdev serverは一切触らない。競合・所有不確定・ローカルPGの完全隔離が証明できない場合はSTOPしてReport。
- DB接続先が127.0.0.1等の検証用かつ明示的に非本番であることを確認。検証専用DBの新規作成・破棄も専用ローカル環境内だけ。リモート/managed/postgres本番接続は禁止。

## 実装対象（source-only）
- F6所有の**新規の migration候補**と、`docs/ai-provider/F6_*` の手順・検証文書。migrationはGitHubのソース候補であり、本番適用しない。
- `ai_ledger.consumer_calls`：call_key、request_idの対応、tenant/fingerprint、user_id、brand_ref、claim fencing token、状態acquired/complete/abandoned、期限・result内容サイズ制限。型、ユニーク制約、check/FKの境界、索引、PII保持・削除を文書化。
- SQL RPC候補 `call_claim` / `call_complete` / `call_abandon` / `call_purge_content` / `forget_user`。機能は前設計文書の契約を正とし、既存台帳や認証との競合を避ける。SECURITY DEFINERの場合 `search_path = ''`、完全修飾、最小限のGRANT、service_role-only、RLSの安全性をチェック。
- 一意操作での同時claim/duplicate/content drift、fencing、crash before/after mark_sent、504/timeout unknown-upper_bound、成功後の重複返信、期限切れの安易な再実行禁止、quotaのfail-closedと予算整合、callId/operationIdの永続性を検証。共有AI既存ledgerの意味を変えない。
- POSTONA既存slug brandIDをUUIDと偽装しない。user主体、brand_refは監査表示だけ。system/Cron/予約投稿の委任は今回無許可とし、後続F5 owner RPCができるまで未実装。
- 削除対応 `forget_user` は既存の共通アカウント/POSTONAの所有境界を壊さないsource候補のみ。本番の既存append-only台帳トリガーの変更は今回禁止。必要なら未完了依存として報告。
- プライバシー（Anthropicへの送信）はユーザーが設計方向を了承したが、正式規約・告知・本番承認未完了。今回実送信なし。

## 変更範囲
F6の独立追加SQL候補・関連テスト・docs/ai-provider/F6_*、自身TASK/ACTIVEのReportのみ。既存のmigrationの書換禁止。H5 bridge、既存台帳・RLS・Auth・F3/F4/F5/POSTONA Edge/Cron/画面、シークレット、共通AI isolation/retry/ledgerのコード変更禁止。SQL実行は安全性を確認できた**ローカル検証DB**のみ、他環境はread-onlyでも接続しない。

## テスト・完了条件
- ネットワーク制限/検証用ローカルPG接続証跡、前提schemaをローカルだけで再構築した証跡。
- migration up実行・再実行の安全性、RPC grants/RLS/SECURITY DEFINER、2主体のcross-user、並行claim/2workers fencing、duplicate/content drift、crash/504、unknown cost、結果上限・content retention、forget_user削除、legacy共通AIの予算規約非回帰、rollback方針を検証。実環境にアクセスできない場合はテストNOT_VERIFIEDとし推測でPASSにしない。
- changed_files、tests PASS/FAIL/NOT_RUN、DB隔離、PR HEAD/base・push/readback、競合、未解決事項、production NO_GOをF6 TASKのReport末尾に記録。
- 次工程はSOURCE_ACCEPTANCE、権限・並行/課金だけの独立限定レビュー1回（Claude別worktreeを優先、Codex自動投入しない）。merge/deployや本番DB適用の承認ではない。
- 完了時 status review_required / next_owner chatgpt、L6で返却。

## Report
- task_id: common-ai-f6-postona-consumer-calls-pg-offline-candidate-20261017
- result: **SOURCE_CANDIDATE_DONE（Draft PR #249）。保存の場所の migration の候補＋ローカルの PostgreSQL だけでの確認がすべて PASS、わざと壊した写し 22/22 を検出**
  - どの DB にも適用していない。Supabase・本番には読むだけでも接続していない。有料の呼び出し・SNS への投稿・merge・deploy・Secret の変更は 0
  - 既存の migration、台帳（`ai_ledger`）、RLS / 認証、H5 bridge、POSTONA / Edge / Cron / 画面、F3 / F4 / F5 / J1 / G6 のファイル、共通の isolation / 送り直し / 台帳の実装は変えていない
- **TASK との違い（1 点、要レビュー）**: 表を `ai_ledger.consumer_calls` ではなく **別の schema `ai_calls.consumer_calls`** に置いた（RPC は `public.ai_calls_claim` / `ai_calls_complete` / `ai_calls_abandon` / `ai_calls_purge_content` / `ai_calls_forget_user`）
  - 理由: 保存する結果にはモデルの出力が入る。台帳は「出力を保存しない」決まりで、台帳の振る舞いのテストが `ai_ledger` の列名を確かめている（`content_purged_at` で落ちる）。列名を変えて通すのは決まりを破ったまま隠すので採らず、出力を持つ表を台帳から分けた。TASK の「共有AI既存ledgerの意味を変えない」を優先した
  - 台帳は読むだけ（abandon が予約の終わりを見る、forget_user が台帳に残る行の数を返す）。台帳が変わらないことは rollback / legacy の部分で確認
- branch / commit / PR
  - `claude/f6-postona-consumer-calls-pg-20261017`（新しい独立した worktree `/Users/yuya/Developer/kabumori-f6-consumer-calls-pg`、#241 の head `84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6` から作成）
  - commit `e589e2c39886fde582bd31a4c25fd4f6839fac49`（push 済み、`git ls-remote` で同じ値を確認）
  - Draft PR [#249](https://github.com/anohi-memories/kabumori/pull/249)。読み返し: OPEN / Draft、base `claude/f6-postona-ai-ledger-design-20261017`（#241、`84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6`）、head `e589e2c39886fde582bd31a4c25fd4f6839fac49`、10 ファイル、MERGEABLE
- 作業前の確認
  - fresh main `f497ea4f7009631e4eaddd46e690e5d9d9179071`。task_id の重複なし（F6.md と ACTIVE_TASK だけ）。旧 G3 / G4 / G5 / G6 / H5、新 F3 / F4 / F5 はどれも done
  - migration の衝突なし: 開いた PR の migration の最新は #214 の `20261015120000`。この候補 `20261017120000` は main・開いた PR のどれとも重ならず、いちばん新しい。台帳・bridge・call store のファイルに触れる開いた PR は H5 の #198（bridge、この stack の土台）だけ
- changed_files（10）
  - `supabase/migrations/20261017120000_ai_consumer_call_store.sql`（新規、候補）
  - `supabase/tests/ai_consumer_call_store_run.sh`（新規、確認の runner。`/tmp` の下の socket 以外を拒む）
  - `supabase/tests/ai_consumer_call_store_behavior.sql` / `_fixture.sql` / `_digest.sql` / `_rollback.sql` / `_mutations.sh` / `_bridge_e2e_test.ts`（新規、テスト専用。deploy されるファイルからは読まれない）
  - `docs/ai-provider/F6_POSTONA_CONSUMER_CALLS_PG_CANDIDATE.md`（新規）
  - `docs/ai-provider/F6_POSTONA_AI_LEDGER_QUOTA_IDEMPOTENCY_DESIGN.md`（§4 に schema の場所の追記 1 行）
- 中身（docs §2〜§4）
  - 表: `call_key`（`^h5m2_[0-9a-f]{64}$` = bridge の callId = 台帳の `request_id`）、tenant / fingerprint、application、**bridge の機能の ID**、主体、`user_id`（削除用、外部キーなし）、`brand_ref`（slug、監査用だけ）、`lifecycle_version`（監査用）、`claim_token`（fencing、一意）、状態 acquired / complete / abandoned、結果と audit（128KB まで）、時刻。check の決まり、識別の列を変えさせず状態を前にだけ進める trigger、索引 3 つ、RLS あり・方針なし
  - RPC 5 つ: すべて SECURITY DEFINER・`search_path = ''`・完全修飾・`service_role` だけ。適用の最後に、持ち主・メンバー・直接の権限・実際の権限・SET ROLE の経路・RLS を確かめ、危なければ全部取り消す（台帳と同じ流儀）
  - claim: 新しい key は acquired、identity が違えば conflict、acquired は**何日たっても busy**、complete / abandoned は保存した結果を返す
  - complete: 持ち主と identity が同じ acquired の行だけ。同じ結果の繰り返しは duplicate、他は例外（bridge は UNKNOWN、送り直さない）。受け付ける結果は bridge が保存する形だけ（code 7 種、Audit の 9 key、callId・tenant・機能が行と同じ）
  - abandon: 古い（既定 30 分、最短 5 分）＋台帳のその call の予約が全部終わっている＋audit が台帳と合う（送った回数、台帳より少ない額にしない、最大額なら `includes_upper_bound`）ときだけ UNKNOWN の印で閉じる。元の持ち主は fenced
  - purge_content: 成功した結果の出力を、時間（既定 24 時間）がたったら同じ audit の UNKNOWN の印に置き換える
  - forget_user: その利用者の行を全部消す。処理中があれば断る。利用者の排他 lock で claim と重ならない。台帳に残る行の数を返す
  - POSTONA の slug を UUID にしない（`user_id` に slug を入れると拒否、テストで確認）。主体は利用者、slug は監査の表示だけ。system / Cron / 予約投稿の委任は今回作っていない
- tests（ローカルの PostgreSQL 17.11 だけ。`listen_addresses = ''` で TCP なし、Unix socket `/private/tmp/f6cc-sock`、データは作業用のフォルダ。runner が毎回「TCP なし・socket 経由」を確かめて記録。クラスタの識別子 `7697583014892725090`）
  - runner の 10 の部分: **すべて PASS**
    - isolation: PASS
    - behaviour: 台帳なし → `AI_CALLS_REQUIRES_LEDGER`、台帳を読めないロール → `AI_CALLS_LEDGER_NOT_READABLE`（どちらも何も作らず catalog 不変）、2 回目の適用は失敗して schema 不変、振る舞いの 14 項目 PASS
    - persistence（別々の接続で claim・重複・complete・再送）: PASS
    - supabase の既定の権限を打ち消す: PASS
    - superuser でない持ち主での適用: PASS
    - concurrency: C1 同時 claim 60 → 持ち主 1・busy 59・エラー 0、C2 中身 2 種で 60 → 1・conflict 30・busy 29、C3 持ち主 20＋偽 20 → 書き込み 1・duplicate 19・fenced 20、C4 complete と abandon → 片方だけ勝ち両側が合う、C5 処理中 15 の最中の forget_user → 待って断る（in_flight 15）・何も失わない。最初の書き手を trigger で 0.5〜1 秒止めて本当に重ねた
    - adverse: 危ないロールの形 8 通りをすべて拒否、catalog 不変
    - rollback: 台帳（定義と行）と既存のものは migration で不変、rollback の script で catalog が元に戻る
    - legacy: 台帳自身の振る舞いのテスト（18 項目）がこの migration を入れた後もそのまま PASS
    - bridge: 本物の H5 bridge＋本物の `SupabaseLedgerBudgetGuard`（fetch を psql に渡すテスト用の adapter）→ この DB、偽の Anthropic・偽の鍵・`--deny-net`: **9 PASS / 0 FAIL**（1 依頼 = 1 行・台帳の予約 1・request_id = callId、別の bridge からの再送も送らない、同時 → IN_PROGRESS、中身違い → CONTENT_DRIFT、別の利用者は別、complete の喪失の前後、504 → 台帳 unknown・最大額、上限 → 送る前に BUDGET_DENIED、出力の削除 → 同じ audit の UNKNOWN、削除の後は認可されず送らない）
  - わざと壊した写し（`ai_consumer_call_store_mutations.sh`）: **22 killed / 0 survived**（claim 4、complete 4、abandon 4、purge 2、forget 3、trigger 1、権限 4）。最初は「key の lock を外す」が見逃された → 書き手を止めて本当に重ねる形に直してから検出
  - `migration_source_invariants_test.ts`（共通、変更なし）: 11 PASS
  - 共通AI基盤＋市況レポート＋ bridge のテスト（PR の worktree）: 509 PASS / 0 FAIL、`offline_run.sh`: 27 PASS
  - main（`fb707ff581e4d12f4cf4d0cc5e7644064d2da8b6`）と合わせた木（merge-tree `606e515f3cf8d361cb8a56e384a3a3862400864b`、衝突なし）: runner の 10 の部分すべて PASS、共通AI基盤＋市況レポート＋ bridge 546 PASS / 0 FAIL、invariants 11 PASS
  - lint（`--no-config`）0 件、`git diff --check` OK、秘密情報の文字列 0（テストの鍵は偽物だけ）
  - NOT_RUN: Supabase の本物の環境での適用・PostgREST（本物）経由の呼び出し、`_shared` 全体の既知の型エラー 5 件・権限で止まる 1 件
  - 後片付け: ローカルのクラスタは止めてデータ・socket のフォルダを削除。runner の DB とロールは毎回消している
- collision: 新しい 10 ファイルに触れる開いた PR は無い（開いた PR 111 本を確認）。読み返し（すべて OPEN / Draft、head は変わっていない）: #187 `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b`、#198 `4223d5c01389474406291c8e4578207e317638b9`、#205 `4cd2cbdd51a68bc537cd0fc81dc8f1c7ee059f21`、#219 `be35cc93205fedd6af1321aaeb1fc38d71e9b946`、#222 `11835df1b99f4f3f23006af7f1a27ea6ae51f0e4`、#231 `2a696aff24be01538bd0d9c5a1eb0afa07421483`、#234 `2ba13ee17f75eff129048e630efbd3faa3bd9232`、#237 `d0c85b3e7f1247333ae132a8cc15e2c16bc183bb`、#239 `f590b80fbbaa926be08d5e215ad87b373f402ff2`、#241 `84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6`、#238（F4＋F5）`b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6`、#182（F3）`1af5047eb70327c252194220df51e94e8a17ff7e`
- remaining_issues / 未完了の依存
  - schema を台帳から分けた判断（上の「TASK との違い」）のレビュー
  - 台帳に残る利用者 ID の仮名化: 台帳の追記専用の trigger の変更が要る（今回禁止）。`forget_user` は数を返すだけ
  - `forget_user` は利用権が active でなくなってから呼ぶこと（そうでないと削除の後の再送が新しい行を作る）。共通アカウントの削除の手順への組み込みは F5 / G5
  - `recover_stale` → `abandon`、`purge_content` を動かす仕事（Cron、別承認）。出力の無い行の保持期間は未決
  - 次の TS の adapter（別の作業）: 依頼ごとに作り、bridge の機能の ID と、`authorize` と同じ確認の結果の利用者 ID を持つ。RPC の失敗は例外
  - rollback は処理中・保存した結果を失い、同じ operationId がもう一度送られる → 呼び出し元を止めてから。台帳の rollback より前に
- production: **NO_GO**（個人情報の決まりの正式な調整・プライバシーの告知・有料と本番の利用が未承認。本番の適用は別承認）
- 次: SOURCE_ACCEPTANCE。権限・並行・課金だけに絞った独立のレビュー 1 回（Claude の別の worktree を優先、Codex に自動で入れない）。merge・deploy・本番の DB の適用の承認ではない
- next_owner: chatgpt
- recommended_model: 独立のレビューは Opus 5.5（高）または Sol（高）

## L6 decision 2026-10-17
- verdict: PASS_SOURCE_CANDIDATE / FOCUSED_SECURITY_REVIEW_REQUIRED / MERGE_HOLD / PRODUCTION_NO_GO
- source-only PR249 checked OPEN/Draft HEAD e589e2c39886fde582bd31a4c25fd4f6839fac49, base PR241 branch, 10 files. Intentional deviation: separate ai_calls.consumer_calls vs planned ai_ledger.consumer_calls must be reviewed, not silently accepted as production design.
- implementer-reported local PG17.11 (Unix socket isolated), 10 test phases, 60 concurrent claim safety, bridge9, mutations22/22, integrated546 PASS. ChatGPT independently did not rerun. Managed Supabase/PostgREST, five pre-existing shared type errors, one permission-blocked test NOT_VERIFIED.
- Required before merge: one independent narrow Auth/SECURITY DEFINER/RLS, transactional races/fencing, billing settlement, user deletion/rollback, ledger cross-schema permissions review (prefer distinct Claude Code Opus5.5 high, avoid automatic Codex). No live DB/merge/deploy authorization.
