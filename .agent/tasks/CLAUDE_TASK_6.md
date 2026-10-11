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
