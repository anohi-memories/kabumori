# G6 CURRENT TASK — 共通AI基盤 Phase 1f / 本番 AI Ledger 限定適用＋試験ポリシー

- task_id: common-ai-provider-g6-phase1f-production-ledger-apply-policies-20261011
- owner: claude
- slot: claude-6
- status: review_required
- next_owner: chatgpt
- start_code: G6
- finish_code: K6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- priority: high
- user_explicit_approval: **YES — 2026-10-11 このチャットで「おk」**（直前の説明：「本番Supabaseに予算管理DBを作成し、試験用の月$5・日$2の上限を登録する」への承認）
- production_mutation_window: **CLOSED** (ACTIVE 2026-10-11T12:22Z / 21:22 JST → CLOSED 12:33Z / 21:33 JST after read-back; earlier 19:28→19:29 JST window closed without any write) — rule。待機中はDBロックを占有しない。実行直前のfresh全15枠確認でG5/他writerにACTIVEが無い場合のみ、`.agent/CURRENT_STATE.md`へG6唯一の対象/操作とwindow ACTIVEをCAS追記してからapply。書込・readbackの完了/STOPでCLOSEDを記録。CAS競合または他writer ACTIVEなら**DB変更を開始しない**。
- mutation_scope: target Supabase project `wsmznyzcvmuitkglfeuj` の **exact migration `20261010050613_ai_provider_budget_ledger.sql`**、適用履歴、同一 Ledger の初期system-only予算ポリシー **2件のみ**。これ以外一切不可。
- original Phase1e K6/Report and earlier unassigned G6 template are preserved unchanged below. This Phase1f task is separate, with new `K6` on completion.

## 今回の正本・事前情報

- PR117 Provider / PR119 Ledger / PR133 rollout runner はmainへmerge済み。最新 `origin/main` を作業開始時と本番適用の直前に確認する。Phase1d実装は独立検証済み。変更は不要。
- 前回 G6 Phase1eは `PASS_READONLY_CHECK`：2026-10-11 19:05 JST にMac CLI2.116.0で `rollout.sh check` 1回成功、`TARGET_VERIFIED` / `READY_TO_APPLY`、権限拒否予測4/4 `no`、12カテゴリ・既存関数168、台帳RPC0。**時間が経つので本番書込み前に毎回取り直す**。
- ChatGPTが最新Supabase `list_migrations` で81件、最新履歴 `20261007214402`、`20261010050613`（ai ledger）未適用、G5 `20261009120000`（common_account_deletion_completion）も未適用と確認。**G5のmigrationは今回適用しない**。`supabase db push`禁止（他migrationが巻き込まれる）。
- G5の共通アカウントはpriority CRITICAL。直前の `G5 review_required` は本番禁止のオフライン調査だが、状況変化に備え全枠・windowsをfresh検証。G5が同一Supabase DDL/Auth/RPC/指紋等のmutationを開始していればG6 STOP。G5側TASK・Reportの追記/上書き禁止。
- 本番DB `ensure_rls` event trigger の本体はChatGPT read-only検証済み：新規 `public` tableに作用、台帳表 `ai_ledger` namespace は対象外。引き続き新しい挙動ならSTOP。
- このチャットのClaude作業はユーザー明示で専任G6。**他のG枠へ割当・直接コピー指示方式への差戻しはしない**。

## G6 開始時に必要なこと

1. `PROJECT_RULES.md`, `HANDOFF.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md` と本TASK、`docs/ai-provider/PHASE1D_ACTIVATION_RUNBOOK.md`、PR133 runner/proof、G5現在のTASKヘッダーをfresh read。G6専用の**独立クリーンworktree/checkout**を `/Users/yuya/Developer/kabumori-fresh` の最新 `origin/main` から安全に使う。既存G6 Phase1e worktreeは**G6本人のものでクリーンな場合に限り**そのworktreeを更新利用できる。別slotのworktree/dev server/branchは絶対触れない。
2. 現時点の全15枠のstatus/task_id/next_ownerとproduction mutation windows、fresh source HEAD、Supabaseの現状を確認。同時writer/G5と競合が無いか判断。親mainで関連migration/runner/policy/権限経路が変更されていたら**承認済みの既知コードであることを再確認できるまでSTOP**。
3. 実行するのは既存の固定runner `supabase/tests/ai_provider_budget_ledger_rollout.sh` の **`check` → `apply` → `policies`** のみ。runbook §2手順4〜6が正本。CLI 2.116以上3未満、target identity、`--agent no` JSON厳格解析、migration SHA256 `680aeb3f2e540b184476b0c1e3534d8586b4857ec29856e40793ed44eff35737`、限定操作の正確なACKを必ず使う。手順を自作SQLやダッシュボード操作へ置換しない。key/DBパスワード/ログイン認証情報は出力しない。
4. **windowの開始**: `check`で `TARGET_VERIFIED`、`READY_TO_APPLY`、predicted_refusals4件すべて否定、既存指紋とG5非競合が確認できたときのみ、fresh `.agent/CURRENT_STATE.md`の先頭に `production_mutation_window: ACTIVE`（owner G6, task_id, target ref, exact scope, UTC/JST開始時刻）をcompare-and-swap/競合確認付きで書いてから次へ。ACTIVE中はwriteとread-back以外でロックを保持しない。他slotのSTATE内容は保護。ACTIVEを記録できなければ **apply禁止・WAIT**。
5. **Stage A `apply`**: runner自身の同一実行内Stage0再チェック、指紋再取得、target再照合を通過し、**承認済みmigration 1本だけ**適用。runnerのStage B/C/D読み戻し + 履歴ちょうど1行 + 既存business fingerprint同一、増加する公開RPCが正確に7件か確認。CLI `--linked` が3本以上の一時DBログインロールを作成しうることは既知。未検証のManagement API複数文 SQLが失敗/曖昧な場合、runner STOPに従う。**リトライ・手動補修・巻き戻し・`--resume-history`の自己判断実行は禁止**。STOP[11-16]のまま内容をReportし、次判断はK6へ返す。
6. **Stage B `policies`**: `apply`が文字列・exit code・独立readbackで完全PASSした場合のみ、同じwrite window内で承認済み初期SQLをrunner `policies` 1回。合計正確に2件、以下完全一致をread-back：
   - `anthropic.opus.kabumori.market_report.monthly`: anthropic / claude-opus-5-5 / kabumori / market_report / system, month, $5.00, 40 calls, $1.00/per call
   - `anthropic.opus.kabumori.market_report.daily`: same scope, day, $2.00, 6 calls, $1.00/per call
   - user/brand/POSTONA/他model/他featureを有効化しない。*広域ポリシーは作らない*。G5の個人IDに関するデータを送受信しない。
7. **window終了**: PASSでもSTOPでも、window `CLOSED` にCASで更新し、結果とG5への影響（public RPC+7、migration history+1、既存関数指紋差分の共有）を `.agent/CURRENT_STATE.md` に公開安全な範囲で記録する。CAS失敗ならその事実をReportし、別slotを上書きせず STOP。G5のTASK/Reportは触らない。共有ファイルの変更が競合した場合は、保全して再調整を依頼する。
8. G6自身のTASKの現行Reportと `.agent/ACTIVE_TASK.md` のG6ブロックだけを更新して、`status: review_required/next_owner: chatgpt`で `K6` を返す。個人情報、SECRET/KEY、CLI credential、一時ログインロール秘密値は記録しない。GitHub commit/pushの成否は実測し、実際に未成功なら成功とは書かない。

## 拘束範囲と明確な停止条件

- **承認済み実変更**: `ai_ledger` 5テーブル + `public.ai_ledger_*` RPC7件に関わる**固定migration**、migration registry 1行、試験用policy2件。いずれもrunner経由。正確な事後構造はrunbook SQL/gateが検証。
- **禁止**: G5 `20261009120000`等ほかのmigration適用、広域予算の作成、Secrets登録/閲覧、Claude Console Workspace作成/限度額変更、Claude/OpenAI API実呼び出し・課金、実Claude smoke、Edge Function deploy、Cron変更、Auth/RLS既存ポリシー修正、G2朝刊/大引け切替、X実投稿、Netlify/Vercel本番deploy、PR merge、写真アプリの停止。既存ソース/migration/policy/runnerの変更も不要・禁止。
- **fail-closed**: project ref・CLI JSON・role/default ACL・history・sha256・G5/他writer競合・window記録・Readback・指紋差分・想定外のSQL出力で即時STOP。よくある「再実行で直る」は不可。部分適用時も台帳削除やhistory補修を勝手にしない。
- **本番観測の注意**: DDLはDBカタログと必要なロックを取る。既存表に明示変更が無くても完全無影響とは言わない。トランザクション結果が不明な場合はDBを書き直さず、独立した `status` をread-onlyで確認して報告するか、明確な追加判断を待つ。CLI `--linked` は一時ログインロールを作る。
- **レビュー**: Phase1bのCodex C1レビュー（R1/R2修正PASS）とPhase1d多数ローカルfake CLI検証、Phase1e実環境read-only PASS済み。ソース変更なしの既定runnerの限定applyについて追加の機械的Hレビューを作らない。STOP/新たなSecurity問題を見つけた場合のみ新しいレビュー要否をK6で判断する。
- **公開安全性**: AI Lab開発日記は本番DB内部構造や権限/ポリシー詳細、端末path/ログ、秘密IDを含めない。今回の日記公開は原則不要。

## 完了/返却K6 Report（新しい最上部 Report、履歴は下に保護）

- task_id: common-ai-provider-g6-phase1f-production-ledger-apply-policies-20261011
- result: NOT_STARTED / PASS_FULL_APPLY_AND_POLICIES / PARTIAL_STOP / STOP_WITHOUT_WRITE いずれか
- executed_at, target_confirmation, source SHA, CLI_version, check_exit_code
- mutation_window_start / mutation_window_end / other_writers_checked
- apply_executed, stage_A_to_D_status, migration_registry_verification
- ledger_schema_5_tables_rpcs_7_grants_rls_verification
- policies_executed, exact_2_policy_readback
- before_after_business_fingerprint / g5_notification
- changed_files, tests, commit_hash, push, merge, deploy
- explicit confirmation: secrets=0, paid_AI=0, model_switch=0, other_migrations=0
- STOP_reason, outstanding_issues, safety_checks, next_recommendation
- `K6` -> **共通AI基盤のちゃ**。本番適用後も次のsmoke/Secret/Cronは別承認であり、自動続行しない。

## Report — Phase1f（K6。最上部の Report。以前の Report は下に保存）

- task_id: common-ai-provider-g6-phase1f-production-ledger-apply-policies-20261011
- result: **PASS_FULL_APPLY_AND_POLICIES**
- executed_at:
  - apply 21:31:00〜21:31:37 JST、policies 21:31:37〜21:31:49 JST
  - Claude による独立した read-only `status` は 21:32:54 JST
- who_ran_writes: **ユーザーが自分のターミナルで1回だけ実行した**
  - 実行したコマンドは `rollout.sh apply && rollout.sh policies`（runbook §2 手順5・6、正確な ACK 付き）
  - Claude が 19:28 JST に `apply` を実行しようとしたところ、Claude Code の自動モードが "Production Deploy" として拒否した。コマンドは始まっておらず、書き込みは 0
  - そのため 19:29 JST に窓をいったん CLOSED にし、ユーザーの「準備OK」の後に開き直した
- target_confirmation:
  - check（21:22）と、apply 内の2回（Stage 0 と Stage A の直前）、policies、status のすべてで `TARGET_VERIFIED`
  - cron 42件が呼ぶ ref は `wsmznyzcvmuitkglfeuj` の1種類だけ。かぶモリ固有の表 6/6、履歴の目印 2/2
- source_SHA:
  - main 上の runner・gate・SQL・migration・policies は、PR133 の head `61be0dfb` と差分 0
  - migration の sha256 `680aeb3f…5737` は runner の固定値と一致（一致しないと runner が拒否する）
- CLI_version: 2.116.0（`--linked --project-ref wsmznyzcvmuitkglfeuj --agent no --output-format json`、空の作業ディレクトリ）
- check_exit_code: 0（21:22 JST。TARGET_VERIFIED / READY_TO_APPLY / predicted_refusals 4/4 no）
- mutation_window_start / end:
  - 本実行: ACTIVE 2026-10-11T12:22Z（21:22 JST、commit `1af11eb5`）→ CLOSED 12:33Z（21:33 JST、この commit）
  - 先行の試み: 19:28 → 19:29 JST（書き込み 0）
- other_writers_checked:
  - 窓を開く直前に全15枠を確認した。ACTIVE の窓は無し。G5 は done。ready の G1 と G8 は本番禁止
  - 共有の状態ファイルへの記録は fast-forward の push で行った（1回目は他の担当の同時書き込みと衝突したため、取り込んで再確認してから記録した）
- apply_executed: yes（1回）。stage_A_to_D_status: **ALL PASS**
  - Stage 0: TARGET_VERIFIED、READY_TO_APPLY（21:31:06）、適用前の指紋、Stage A 直前の TARGET_VERIFIED
  - Stage A: migration 1本。CLI の終了コード 0、出力 `[]`
  - 「台帳が存在するか」の確認: あり
  - Stage B: READBACK_PASS（履歴 0行の時点）
  - Stage C: 履歴の行を追加
  - Stage D: READBACK_PASS（履歴 1行）、既存オブジェクトの比較は EXISTING_UNCHANGED
- migration_registry_verification: `20261010050613 / ai_provider_budget_ledger` がちょうど1行（読み戻しの `history_row=1`）
  - 本番の履歴は 81 → 82行。max は `20261010050613`
- ledger_schema_5_tables_rpcs_7_grants_rls_verification: 読み戻しの must_be_true 17項目が、Stage B・Stage D・policies 前後・status のすべてで True
  - schema とちょうど5つの表、ちょうど7つの RPC（`(p jsonb) -> jsonb`）、所有者は1つ
  - SECURITY DEFINER と空の search_path、RLS は全表で有効、ポリシー 0
  - 直接の付与なし、EXECUTE は service_role だけ（anon / authenticated は不可）、grant option なし
  - アプリ用ロールには schema・表・補助関数の権限なし
  - 追記専用のトリガー 6、状態遷移のトリガー 1
- policies_executed: yes（1回。apply の終了コード 0 の後だけ実行される `&&` でつないだ）。exact_2_policy_readback: **完全一致**
  - `anthropic.opus.kabumori.market_report.monthly`: anthropic / claude-opus-5-5 / kabumori / market_report / system、month、$5、40回、1回 $1、enabled
  - `anthropic.opus.kabumori.market_report.daily`: 同じ範囲、day、$2、6回、1回 $1、enabled
  - logical_role・brand・user のスコープや、per_brand / per_user は無し。広い範囲のポリシーは無し
  - 台帳の行: 予約・利用記録・請求観測は 0
- before_after_business_fingerprint: public・private と全体のロール等、12カテゴリすべて同一
  - columns 1486、constraints 639、default_acl 27、event_triggers 7、indexes 211、memberships 25、policies 66、relations 303、roles 17、schemas 2、triggers 60、functions 168
  - 台帳の RPC を含む関数数は 168 → 175（ちょうど +7、すべて ai_ledger の RPC）
- g5_notification: `.agent/CURRENT_STATE.md` の CLOSED の記録に書いた
  - 履歴 +1。G5 の `20261009120000` は未適用のまま
  - G5 の指紋で変わるのは、07 の `functions`、04 の `untouched_functions` / `history_count` / `history_latest`。その他は不変
  - G5 の TASK・Report には触れていない
- cli_side_effects: 既知の副作用だけ
  - CLI の呼び出しごとに `Initialising login role...`（一時ログインロール）
  - 分離した作業ディレクトリへの `linked-project.json`
  - worktree の `supabase/.temp/cli-latest` は削除済み
- changed_files: `.agent/tasks/CLAUDE_TASK_6.md`、`.agent/ACTIVE_TASK.md`（G6 の部分だけ）、`.agent/CURRENT_STATE.md`（G6 の窓の記録だけ）
  - ソース・migration・ポリシーの SQL・runner は変更していない
- tests: 本番での実行で観察したものだけを PASS とする
  - runner の check / apply / policies / status の出力の形、終了コード、読み戻し、指紋の比較
  - 新しいオフラインテストは追加していない（既定の runner をそのまま使ったため）
- commit_hash: 窓を開いた記録 `1af11eb5`、窓を閉じた記録と Report はこの commit（K6 で GitHub 上の値を確認）
- push: main へ fast-forward（push の前に fresh `origin/main` を再確認）
- merge / deploy: not_performed
- explicit confirmation: secrets=0、paid_AI=0、model_switch=0、other_migrations=0
  - Edge・Cron・Auth・RLS の既存ポリシー、G2 の切替、photo project: すべて 0
- STOP_reason: なし（先行の試みの「ハーネスによる拒否」だけ。書き込みは無し）
- outstanding_issues:
  1. 回復処理の Cron が未設定。台帳を使う呼び出しを始める前に、別の承認が必要（smoke だけなら不要）
  2. `ANTHROPIC_API_KEY` の Supabase への登録と、実 API smoke（台帳込みにするか、台帳なしにするか）は別の承認
  3. authenticator の `statement_timeout=8s` が、PostgREST 経由の台帳 RPC の上限になる（Phase 2a の smoke で実測する）
  4. Claude からは本番に書き込めない（自動モードが拒否する）。今後の本番の書き込みも、ユーザーが実行する流れを前提にする
  5. 1回のコマンドの中で「Stage 0 の事前チェック → Stage A」の間に、他の担当が DDL を流す可能性はゼロではない
     - 窓の記録と、直前の全枠確認で防いだ
     - 指紋の比較が EXISTING_UNCHANGED だったので、実際の干渉は無かった
- safety_checks:
  - 書き込みは、承認された範囲（migration 1本と履歴1行、ポリシー2件）だけ。いずれも runner 経由で、それぞれ1回
  - 再試行・手動の補修・巻き戻し・`--resume-history` は使っていない
  - 個人情報・キー・CLI の認証情報は記録していない
- next_recommendation: K6 で評価する。次の候補は、いずれも別の承認が必要
  1. 実 API smoke（`ai_provider_claude_smoke.ts`、上限見積もり $0.040）
  2. `ANTHROPIC_API_KEY` の登録（Phase 2a の直前）
  3. 回復処理の Cron
  4. G2 と調整して、市況レポートのシャドー接続（Phase 2a）

---

# PRESERVED PRIOR G6 TASK + REPORT — Phase1e (historical, do not execute)

# K6 FINAL — 共通AI基盤 Phase 1e / production runner READ-ONLY check

- task_id: common-ai-provider-g6-phase1e-readonly-runner-preflight-20261011
- owner: claude
- slot: claude-6
- status: done
- next_owner: none
- start_code: G6
- finish_code: K6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Sonnet5（高）**
- priority: high
- user_routing_decision: 2026-10-11 ユーザー明示。**この部屋の共通AI基盤は今後G6のくろちゃん経由で実施する。直接コピー用開発指示方式を終了。** 各完了K6後も、次の共通AI TASKはこのちゃが競合確認してG6へ再割当する。doneをメモとして居座らせない。
- production_mutation_window: CLOSED (this task never opens one)
- phase: 1e / prerequisite verification only — NOT migration/apply, policies insertion or live provider activation.
- k6_final_verdict: **PASS_READONLY_CHECK_ACCEPTED / G6 RELEASED** (2026-10-11 JST)
- verified_by_chatgpt: GitHub commit `9071e76cef20c942c2e87bfbff96940e391ceacc` only changed own TASK and ACTIVE G6 block; Mac runner output/time/results rely on Claude's submitted Report. Independently preflight SQL was checked earlier; live `ensure_rls` trigger body read-only verified it only acts on `public` table creation, not new `ai_ledger` tables. No application migration, budget policies, secret, paid Anthropic smoke or actual report cutover approved.
- next_owner_gate: ChatGPT awaits explicit user approval of actual production `apply` and Phase1d trial policies before a NEW G6 task; do not start writes solely due to READY. User's dedicated G6 routing remains in force; no other slot assigned.

## 起点・既知の事実

- PR #117 Provider core, PR #119 budget ledger, PR #133 Phase 1c/1d rollout preflight/runner は **MERGED**。PR133 reviewed head `61be0dfb631b4caf85cdcf4b2a947206faab29bd`, merge `570cc45fe487ae911e6bd3c0d2cc6291dfae4837`。常に fresh origin/main を再確認。
- `20261010050613_ai_provider_budget_ledger.sql` は source-only。**本番DB適用は未承認・未実施**。同様に試験予算 policies、Supabase ANTHROPIC_API_KEY、実Claude/有料API smoke、回復Cron、G2レポート実接続も未承認。
- ChatGPTの本番 read-only SQL 観察（2026-10-11 JST）：PG17/non-superuser postgres、台帳 schema/RPC/history 未適用、preflight predicted_refusals 4項目 false/empty、PostgREST用条件良好、既存業務指紋168関数/12カテゴリ。cronは42件、expected project ref 1種類。**これは実際のMac CLI runner check が通った証明ではない**。DBの時間変化を前提に現場で再判定する。
- Claude API利用登録、付与済みクレジットと単体テスト利用はユーザー確認済み。キーの値・残高は取得・表示不要。
- G5共通アカウントはプロジェクト横断でDB/Authの同じ変更境界を優先する。新規本番DDL・shared function指紋・active production mutation windowがあればG6側をSTOPする。G1–G5 / H1–H5のTASK・Report・branches・worktrees、他所有者のdev serverは触らない。

## 今回の作業範囲（G6が担当）

1. `PROJECT_RULES.md`、`HANDOFF.md`、`.agent/ORCHESTRATION.md`、`.agent/ACTIVE_TASK.md`、`.agent/CURRENT_STATE.md` と本TASK・PR133のrunbookを読む。独立G6 worktree/checkoutを `/Users/yuya/Developer/kabumori-fresh` の fresh `origin/main` から新規に用意。安全に独立化できない場合は開始せずWAIT。
2. `docs/ai-provider/PHASE1D_ACTIVATION_RUNBOOK.md`、`supabase/tests/ai_provider_budget_ledger_rollout.sh`、`ai_provider_budget_ledger_gate.py`、`target_identity.sql` の固定SHA/操作を確認。Supabase CLIの実版・フラグ・副作用を確認（CLI 2.116系 `--linked` は接続前に**一時DBログインロールを作る可能性あり**。完全に副作用ゼロとは言わない）。`check`以外のサブコマンドを絶対実行しない。
3. fresh ACTIVE_TASKと各所有者の production mutation window、G5 current owner/next_owner、最新mainやmigration履歴を確認。G5や他writerのACTIVE窓があればSTOP／今回はウィンドウを取得せず調整報告のみ。
4. プロジェクトrefはrunbookの本番プロジェクトと完全一致と独立に検証。ユーザーのMacの独立G6 worktree内で、明示した **runner `check`** のみを実行（DB SQLはSELECTによる接続先識別・preflight・fingerprint）。ユーザー秘密の取得・印字なし。CLIが一時ログインロールを作成する可能性はログに明示し、想定外の権限変更を伴う場合はSTOP。正確な command はrunbook §2手順4を使う。失敗/不一致/想定外JSONではSTOP・繰り返し実行しない。
5. 出力にある `VERDICT: TARGET_VERIFIED`, `VERDICT: READY_TO_APPLY`, `predicted_refusal` 4行、接続先ref/時刻、fingerprint件数、実CLI exit code を照合・整理。予想外のエラー、ユーザーアクション必要、G5衝突を具体的に示す。**READYはDB適用承認ではない**。
6. 結果を自枠の `## Report` に記録し、`status: review_required` / `next_owner: chatgpt` で K6 をこの部屋へ返す。own TASKとG6索引の現在状態のみ変更可（他枠とshared CURRENT_STATEは上書きしない）。pushする場合はgit競合・最新mainを毎回再確認する。新しいPR/production用ソース改変不要。

## 安全制約・テスト

- **禁止**: `apply` / `policies` / `stop` / `rollback`、migrationや履歴の変更、SQL INSERT/UPDATE/DDL、Edge Function deploy、Supabase Secrets/API key操作、一時サービスキー新規作成、Anthropic/OpenAI実API/課金、Cron設定、G2切替、PR merge、モデル設定変更、他slot TASK/Report/branch/worktreeの操作、photo project pause。
- `supabase db query --linked` が一時ログインロールを作るという既知の運用副作用以外のproduction書き込みは認めない。ロール作成権限そのものが気になる/実環境で不明なら**CLI checkを実行せずユーザー承認待ち**と報告する。
- **テスト**: script/toolの出力形式・対象ref・exit-code・事前条件をread-backし、実runの観察範囲だけPASS。CLI未実施なら NOT_RUN と報告。既存Phase1d fake-CLI 74 pathテストはClaude報告であり、このTASKで反復不要。
- **完了条件**: 対象DBの本人性 + read-only preflight/fingerprintを最新状態で観察し、ゲート判定と残課題を手順書に沿って明記するか、安全な理由によるWAIT/STOPを提示。production `apply` の自動続行は禁止。
- **次工程**: K6/ChatGPTが初めて `apply`・試験 `policies` と実API smokeの個別承認を判断する。ユーザーの許可なしに進めない。

## Report（G6のくろちゃんが実績を記載）

- task_id: common-ai-provider-g6-phase1e-readonly-runner-preflight-20261011
- result: **PASS_READONLY_CHECK**
  - 2026-10-11 19:05 JST に、本番で `TARGET_VERIFIED` と `READY_TO_APPLY` を観察した
  - **READY は台帳の適用承認ではない**。apply / policies / 実 API smoke は、それぞれ別の承認が必要
- changed_files: `.agent/tasks/CLAUDE_TASK_6.md`（この Report とヘッダー）、`.agent/ACTIVE_TASK.md`（G6 の索引だけ）
- work_env:
  - 独立 worktree `/Users/yuya/Developer/kabumori-g6-common-ai`
  - branch `claude/g6-phase1e-readonly-runner-check-20261011`
  - 作成元: fresh `origin/main` `7e049021`。Report の前に `52da07b5` へ rebase した
- pre_checks:
  - main にある runner・gate・target_identity・preflight・fingerprint・migration・runbook は、PR133 の head `61be0dfb` と差分 0。merge `570cc45f` は main に含まれる
  - migration の sha256 `680aeb3f…5737` は runner の固定値と一致
  - 全15枠の TASK に、開いている `production_mutation_window` は無い（残っているのは 10/6〜10/7 の過去の記録だけ）
  - G5 は `review_required / next_owner chatgpt`（Phase3g。offline の文書作業で、本番に触れない）
  - G3 は in_progress だが本番は FORBIDDEN。H5 は ready だが本番は FORBIDDEN
  - 10/11 に main へ追加された migration は無い
  - `SUPABASE_PROJECT_ID` は未設定。CLI は自前のログイン情報を使う（値は表示していない）
- runner_check: **実行1回のみ**
  - command: `AIL_ROLLOUT_REF=wsmznyzcvmuitkglfeuj bash supabase/tests/ai_provider_budget_ledger_rollout.sh check`（runbook §2 手順4）
  - runner の終了コード 0。SQL 3本（identity / preflight / fingerprint）の CLI 終了コードはいずれも 0
  - 出力: `/Users/yuya/.kabumori-ai-ledger-rollout/20261011-190543-check/`
- target_verdict: **TARGET_VERIFIED**
  - `cron_jobs=42`
  - `cron_project_refs=[wsmznyzcvmuitkglfeuj]`（期待の ref と完全一致、1種類だけ）
  - product_markers 6/6 true: profiles / brands / social_accounts / common_accounts / service_entitlements / private.account_lifecycle_operations
  - history_markers 2/2 true: 20261001150000 / 20261006230000
- preflight_verdict: **READY_TO_APPLY**（checked_at_jst 2026-10-11 19:05:50）
  - DB: postgres、superuser=False、server 170006
  - 履歴: 81行、max `20261007214402`。台帳の行は false、G5 deletion completion の行も false、台帳より新しい version 0
  - 対象: `ai_ledger` 無し、`public.ai_ledger_*` 0件、同名オブジェクト 0
  - G5: lifecycle foundation あり、deletion completion は未適用、public/private の関数 168（適用で +7 の予定）
- predicted_refusals: 4項目すべて **no**
  - app_role_reaches_all_data_role
  - app_role_reaches_owner_or_superuser
  - app_role_reaches_service_role_privileges
  - default_acl_grantees_not_revoked
- postgrest:
  - ddl_watch / drop_watch true
  - authenticator が service_role に SET ROLE できる: true
  - service_role の public USAGE: true
  - authenticator の設定: `statement_timeout=8s`、`lock_timeout=8s`、`session_preload_libraries=supautils, safeupdate`
- event_triggers: ensure_rls(ddl_command_end) / issue_graphql_placeholder / issue_pg_cron_access / issue_pg_graphql_access / issue_pg_net_access / pgrst_ddl_watch / pgrst_drop_watch
- extensions: pg_cron 1.6.4、pg_net 0.20.4、supabase_vault 0.3.1
- default_acl: 24 entries
- fingerprints: 12カテゴリ（checked_at_jst 19:05:53）。apply の「適用前の指紋」はこの値ではなく、apply 実行時にその場で取り直す
  - columns 1486 / constraints 639 / default_acl 27 / event_triggers 7 / functions 168 / indexes 211
  - memberships 25 / policies 66 / relations 303 / roles 17 / schemas 2 / triggers 60
  - ai_ledger_rpcs 0
- CLI_version: **2.116.0**
  - `db query` が `--linked` / `--project-ref` / `--file` / `--output-format` / `--agent` / `--workdir` を持つことを、runner が確認した
  - 呼び出し: `--workdir <空のディレクトリ> --linked --project-ref wsmznyzcvmuitkglfeuj --output-format json --agent no`
- cli_side_effects（既知のもの。TASK で許容されている）:
  - 3回の呼び出しそれぞれで、CLI が `Initialising login role...` を表示した（一時ログインロールの作成）
  - CLI が分離した作業ディレクトリに `supabase/.temp/linked-project.json` と `cli-latest` を書いた（仕様どおり。`project-ref` は作られない）
  - runner のバージョン確認で、worktree に `supabase/.temp/cli-latest` ができた。未追跡で、削除済み
  - これ以外の本番書き込みは無い（SQL は SELECT 3本だけ）
- tests:
  - 本番での実行で観察した範囲だけを PASS とする: 出力の形（素の配列・1行・項目の集合が一致）、対象 ref、終了コード、事前条件
  - Phase1d の fake CLI 74経路は、今回は反復していない
- commit_hash: この Report の commit（K6 で GitHub 上の値を確認）
- push: main へ fast-forward（push の前に fresh `origin/main` を再確認）
- merge: not_performed
- deploy: not_performed
- production_db_mutations: 0。SELECT だけで、例外は CLI の一時ログインロール（既知の副作用）
- secrets_or_paid_provider_calls: 0。Secrets・API キーの取得や表示、Anthropic / OpenAI への呼び出しは無い
- remaining_issues:
  1. **READY は適用承認ではない。** `apply`（G5 の窓が無いことの確認と、窓の記録が必要）、試験用 `policies`、実 API smoke、`ANTHROPIC_API_KEY` の登録、回復 Cron は、それぞれ別の承認が必要
  2. `ensure_rls`（ddl_command_end）の event trigger がある。Stage A に影響しうるが、どちらでも安全側
     - 新しい表の RLS を有効にするだけなら無害（台帳の表は自分でも RLS を有効にする）
     - もしエラーを出すなら、migration は BEGIN/COMMIT の中なのでロールバックされ、STOP[11] で何も残らない
     - 関数の本体は今回読んでいない（apply 前に読み取り確認するかは ChatGPT の判断）
  3. CLI 2.116 で、複数文の migration を `--linked`（Management API）で流すのは未実測。失敗しても、STOP[11] で何も残らない
  4. authenticator の `statement_timeout=8s` は、PostgREST 経由の台帳 RPC の上限になる。台帳 RPC は短いので問題ない見込みだが、Phase 2a の smoke で実測する
  5. 履歴の max は `20261007214402`。台帳（20261010050613）を先に入れると、G5 の 20261009120000 は後から古い version として入る（runbook §5 のとおり G5 へ共有する）
- safety_checks:
  - 実行したのは `check` だけで、1回だけ。`apply` / `policies` / `stop` / `rollback` は実行していない
  - migration・履歴・SQL の書き込み、Secrets、一時サービスキー、Edge deploy、Cron、モデル切替、PR merge、photo project の操作: すべて 0
  - 他スロットの TASK・Report・branch・worktree には触れていない
- next_recommendation: K6 で、ChatGPT がこの観察結果を評価する。進める場合は、承認を別々に判断する
  1. `apply` の実施日時と窓の記録（G5 と調整。apply 時に runner がその場で事前チェックと適用前の指紋を取り直す）
  2. 試験用 `policies`
  3. 実 API smoke（台帳込みにするか、台帳なしにするか）
  4. `ANTHROPIC_API_KEY` の登録時期（Phase 2a の直前）

---

## Previous G6 UNASSIGNED TEMPLATE — preserved historical contents (not active TASK)

```md
# Claude Task 6 — UNASSIGNED TEMPLATE

- task_id: none
- owner: claude
- slot: claude-6
- status: idle
- next_owner: none
- start_code: G6
- finish_code: K6
- recommended_model: none

## Purpose / allocation

未割当の予備Claude実装スロット（2026-10-11追加）。用途は固定しない。ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存のG1/G2=かぶモリアプリ、G3/G4=X自動投稿アプリの基本ルーティングを維持する。idleだからという理由や、G1〜G4に空きがないという理由だけで自動使用しない。MIC・その他案件にも自動消費しない。

このテンプレートの追加自体は作業割当ではない。現時点のScope・完了条件・実行権限は未設定。

## Before assignment（ChatGPT）

- statusだけで空き判定せず、task_id・TASK本文・Report・next_owner・ACTIVE_TASK・CURRENT_STATE・fresh `origin/main`を確認する。
- 既存TASK/Reportと他workstreamの変更を保護し、変更対象の非競合と専用の独立worktree/checkoutを確認する。
- 明示割当時にtask_id、目的、対象範囲、変更禁止対象、テスト、安全制約、完了条件を記入する。既存G枠と同様に、`K6` を確認するちゃの部屋を `return_to` に書いておくとよい。
- 明示割当時に推薦モデルを必ず設定する。候補：Sonnet5（中）/ Sonnet5（高）/ Sonnet5（極高）/ Opus5.5（中）/ Opus5.5（高）/ Opus5.5（極高）。未割当の間はnone。

## Start / G6

`PROJECT_RULES.md`、`HANDOFF.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、必要なReport、Git状態とfresh `origin/main`を確認する。

明示割当済みでstatusが `ready` / `in_progress` の場合のみ `G6` で開始する。`idle` / `done` / `review_required` では開始しない。単独 `G` でも開始可能なClaude枠が1つだけと明白な場合のみ対象にできる。

G6専用の独立Git worktree/checkoutを `/Users/yuya/Developer/kabumori-fresh` の fresh `origin/main` から作成して使用する。安全な独立環境を用意できない場合は開始せず停止する。他slotのbranchをcheckout/reset/rebaseしない。他workstreamの未コミット変更を変更・削除・stage・commitしない。他slotの作業ファイルやdev serverを停止・再起動しない。

## Scope / tests / completion criteria

未設定。明示割当時に具体化する。割当がない間は変更・テスト・push・deploy等を開始しない。

## Completion / K6

完了・停止時の実績はこのTASK末尾の `## Report` に記録する。`K6` はG6専用のClaude完了確認コード。ChatGPTは完了条件、実装内容、changed_files、tests、commit/push/deploy、残課題、安全確認、競合、Codexレビュー要否を評価し、ORCHESTRATIONの開発日記更新判定も適用する。未実施を成功扱いにしない。

## Report

- task_id: none
- result: not_started（未割当）
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- deploy: not_performed
- remaining_issues: none（作業未割当）
- safety_checks: not_started
- next_recommendation: 明示割当までidleを維持する。
```
