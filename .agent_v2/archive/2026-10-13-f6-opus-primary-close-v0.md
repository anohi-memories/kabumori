# F6 CURRENT TASK — 2026-10-13 大引け Opus5.5 Primary V0

- task_id: common-ai-f6-opus-primary-close-report-v0-20261013
- owner: claude
- slot: F6
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- priority: CRITICAL (2026-10-13 close report)
- user_intent: Today 2026-10-13 close report should be created by Claude Opus5.5 as PRIMARY, not shadow; service is pre-release; user explicitly accepts an occasional failed report and defers automatic OpenAI fallback.
- execution_mode: SOURCE_IMPLEMENT_AND_VALIDATION; production writes only through separately stated approval/safety gate
- production_mutation_window: CLOSED

## Goal and scope
Implement **actual Opus Primary** for **today's close report only** (not Shadow), keeping the canonical final report contract and present distribution pipeline. A manual OFF/return-to-legacy switch is desirable; **automatic OpenAI fallback is NOT required and must not block V0**. Morning report untouched. Explicit timeout, bounded cost, fail-closed on budget/auth/provider errors; failed generation may fail the close report instead of falling back. No fake success or placeholder report.

## Before starting
- Follow PROJECT_RULES.md and .agent_v2/ORCHESTRATION.md; reread latest old/new ACTIVE_TASK and CURRENT_STATE; fresh origin/main, 30-slot metadata, independent F6 clean worktree; protect G2/F2-owned market-report-analysis handler/index, G5/F5 Auth, and all other overlapping owners. **G2/F2 production report handler ownership may conflict; if overlap, STOP and return L6 with exact minimal handoff. Never edit another slot's branch/uncommitted work.**
- Fresh PR states: prior shadow stack #148→#150→#153→#157→#162 still Draft/unmerged when allocated. G2's #143 and #149 NOW merged into main. Revalidate HEAD and dependency, avoid duplicate/lost code. Old G6 last TASK done; this is a distinct NEW F6 task.
- Inspect current close-report cron/Edge/handler, OpenAI generation caller, ledger model/policy and available safe provider client from stack before choosing smallest possible change. Never enable Shadow and Primary simultaneously on same attempt.

## Implementation
1. Design and implement a V0 close-only Opus5.5 PRIMARY requester at the real analysis generation boundary. Preserve output JSON/schema/validation, stored report format, content checks, and notification behavior. No morning mode change.
2. Prefer existing common AI provider/ledger code; ensure idempotent budget reservations, settlement/error records, hard per-day/month/call limits. Existing trial Opus cap $5/mo,40 calls/mo,$2/day,6 calls/day,$1/call may be too low for daily dual runs: **do not increase automatically**. If budget is not sufficient, fail safely and report exact required revised cap for explicit approval.
3. Do not rely on shadow PRs being merged, or claim shadow integration equals primary. Create an independent Draft source-only PR with minimal explicitly owned files. For `market-report-analysis/handler.ts` or `index.ts` modification, require confirmed ownership/worktree coordination with G2/F2; otherwise produce bounded implementation plan and stop. Do not modify #148/#150/#153/#157/#162 branches.
4. Include close mode routing and feature flag (default OFF until approved activation), explicit behavior when Opus fails (report failure accepted; no automatic OpenAI retry), and manual rollback by disabling flag. Preserve existing report output and no content/secret logging.
5. Synthetic offline E2E of production close path, morning unaffected, schema/validation, storage, retries/idempotency, provider timeout/budget errors; relevant Deno/type/lint/secret scans; no real paid traffic by default.
6. Identify exact live activation steps and preflight including secret via authorized channel (do not read/copy actual secret), ledger stale-reservation recovery or bounded fail-closed alternative, deployment/cron implications, production controls/owner approval and stop thresholds. **User accepts delivery failures and postpones auto-fallback, but has not authorized bypass of credentials security, ledger limits, access controls or uncontrolled production write.** No live Edge deploy, DB/Cron migration, secrets mutation, paid API calls, or SNS writes as part of source task without separately confirmed operation approval and safeguards.
7. Record Report with changed_files, HEAD/branch/PR, tests, blockers, cost cap, whether Oct13 live cutover is actually possible, and return **L6**. Flag hard blockers immediately rather than claiming success. If doing today's live close would demand unapproved mutation or G2 conflict, explicitly recommend a separate narrow, time-boxed production gate and route to ChatGPT.

## Acceptance
- Opus PRIMARY produces canonical close report in offline tests; OpenAI morning untouched; errors remain bounded and observable; Auto OpenAI fallback intentionally absent by user choice.
- No other app/slot changes, no leaked secrets, no over-budget real calls, no unauthorized production mutation, no merges/deploys.
- Report: # Report below, status review_required/next_owner chatgpt on completion.

## Report
- task_id: common-ai-f6-opus-primary-close-report-v0-20261013
- result: **PASS_OFFLINE_SOURCE（既定 OFF・未配線）**
  - オフラインでは、Opus primary で大引けのレポートを作れた（OpenAI の経路と同じ packet と content hash）
  - **handler.ts は F2 所有なので変更していない**。配線は、検証済みのパッチとして渡す
  - 今日（10/13）の本番切り替えには、下の別承認がまだ全部必要。この作業の時点では **NO_GO**
- branch / commit / PR
  - `claude/f6-opus-primary-close-v0-20261013` @ `46b27326360e66ec843f79bae6d01584088869d0`（base main `59a04f7054c34bb141a437c39e709e1fe82ccad8`）
  - Draft PR [#170](https://github.com/anohi-memories/kabumori/pull/170)
  - 新しい worktree `/Users/yuya/Developer/kabumori-f6-opus-primary`
  - 最新の main と `merge-tree` で衝突なし
  - shadow の PR（#148 / #150 / #153 / #157 / #162）は変更していないし、頼ってもいない
- changed_files（すべて新規、F6 所有。+1,342）
  - `supabase/functions/_shared/ai_provider/market_report_primary.ts`
  - `supabase/functions/_shared/ai_provider/market_report_primary_test.ts`
  - `docs/ai-provider/F6_OPUS_PRIMARY_CLOSE_V0.md`（動作、予算、本番の手順、戻し方、止める条件、分からないこと）
  - `docs/ai-provider/F6_OPUS_PRIMARY_HANDLER_V0.patch`（**適用していない**）
- 動作
  - 設定 `KABUMORI_MARKET_REPORT_AI_MODE` がちょうど `primary_close`、かつ大引けのときだけ動く
  - 生成と Fact の **両方を Claude** で行う。モデルは `KABUMORI_MARKET_REPORT_PRIMARY_MODEL`（カタログ上の Anthropic モデル）
  - 予算台帳を必ず通る。主体は system。送信は1回で、再試行も OpenAI への自動切り替えも無い
  - 時間: 1回 90 秒まで。すべての呼び出しは処理開始から 130 秒以内に始める。残りが 6 秒未満なら送らない
  - 失敗したら `ANALYSIS_PRIMARY_<STEP>_FAILED:<コード>` でサイクルを失敗にする。16:35 の再試行は claim の試行番号 2 で Claude を使う
  - ON なのに設定が欠けているとき（モデル・キー・台帳・claim）は、`ANALYSIS_PRIMARY_CONFIG:<理由>` で失敗にする（黙って OpenAI に戻さない）
  - 朝刊、未設定、`off`、`shadow` などのほかの値は、今の OpenAI のまま。読む設定はモードの1つだけ
  - shadow と同じ設定変数なので、shadow と primary が同時に動くことは無い
  - Fact の呼び出しが失敗した場合は、今の約束どおり `FACT_NOT_RUN` で配信する
- handler のパッチ（`F6_OPUS_PRIMARY_HANDLER_V0.patch`、3ファイル +418 / -25）
  - `market-report-analysis/handler.ts`（F2）
    - primary のとき、`p_model`・packet の `model`・trace のモデルを Claude にする
    - `cost_usd` / `p_api_cost_usd` は台帳で確定した額にする（OpenAI の単価では計算しない）
    - `ai_primary` と `primary_calls` を diagnostics に足す。失敗したサイクルにも費用を残す
    - 設定不足は fail closed。呼び出しごとに識別子だけのログを1行出す
  - `market-report-analysis/opus_primary_handler_test.ts`（F2・新規）: 5件
  - `_shared/ai_provider/isolation_test.ts`（F6）
    - 許可リストは `handler.ts` → `market_report_primary.ts` の1つだけ
    - provider に届いてよいのは `handler.ts` と `index.ts` だけ
  - X やアプリは packet の `model` を読んでいない（確認済み）。DB の列は自由な文字列
  - **3ファイルは同時に入れる必要がある**（handler が import した時点で、main の古い隔離テストが落ちる）
- tests（実通信・鍵・本番 0。deno 2.9.6、macOS arm64）
  - この branch
    - primary E2E 9/9（大引け 9/30・9/17 で、OpenAI の経路と同じ packet・hash になる）
    - 朝刊と9通りの OFF の値、設定不足9通り、Claude の 529 / 429 / 500、日・月の上限と同じ試行の二重実行、時間（送らない・残り時間で打ち切り）、再生成、Fact の失敗、記録にキーや本文が入らないこと
    - 回帰: provider 103、市況レポート 283、`_shared` 606
    - 通信禁止と鍵の読み取り禁止で 14/14
  - パッチを当てた状態（使い捨ての worktree `/Users/yuya/Developer/kabumori-f6-handler-patch`）
    - handler E2E 5/5、隔離 8/8
    - provider 106、市況レポート 288、`_shared` 609、personalized 134、X 側 10、data-packet 42
    - 通信禁止と鍵の読み取り禁止で 28/28
  - `deno check` PASS。lint は provider で問題 0、市況レポートは main に元からある3件だけ
  - 秘密情報スキャン: テスト用の偽の値だけ（`sb_secret_FAKE_TEST_ONLY…`、`sk-ant-api03-NOT-REAL-handler…`）
  - PR #170 の CI は、作成直後なので未確認
- 予算（自動では増やさない）
  - 1回の予約は generate 約 $0.45、Fact 約 $0.16。普通の日は2回で約 $0.40、再生成した日は4回で約 $0.80
  - 1日の上限（6回・$2）を越える分は、送る前に拒否され、レポートは失敗する
  - 10月の残り（14営業日）に毎日続けると約 $5.6 で、月 $5 の上限で下旬に止まる
  - **毎日続けるための見直し案: 月 $20・100回**（1日・1回の上限はそのまま）。別の本番変更として明示の承認が要る
- 今日の本番切り替え（10/13 16:20）が可能か
  - **条件付きで可能。ただし、次の承認と作業がすべて必要**（どれも未承認・未実施）
    1. handler のパッチの扱い（F2 が当てるか、F6 に許可を出すか）の判断と、#170 と配線の merge
    2. 利用者による Edge Secret の登録: `ANTHROPIC_API_KEY`（専用 workspace、spend limit 付き）と `KABUMORI_MARKET_REPORT_PRIMARY_MODEL=claude-opus-5-5`。Claude はキーを読まない・写さない
    3. `market-report-analysis` の deploy（バイト列で確かめる）
    4. 16:15 までに `KABUMORI_MARKET_REPORT_AI_MODE=primary_close` を設定する
  - 推奨: **14:00〜17:00 JST の、範囲を絞った本番ゲート** を、別の TASK として ChatGPT が出す（手順は計画書 §4）
  - 回復処理の Cron の代わり（V0）
    - primary は自分で確定する。途中で止まった予約は上限額のまま枠に数えられ、使いすぎにはならない（安全側）
    - その日の後で、利用者が `ai_ledger_recover_stale` を1回実行する
    - 毎日続ける前には、回復処理の Cron を別承認で設定する
  - 戻し方は、モードを外すこと（台帳の `stop` は、ON のままだとレポートを失敗させるので使わない）
  - 止める条件4つは計画書 §4
- blockers / 分からないこと
  - 主な blocker は F2 の `handler.ts` を変える調整
  - Opus の実際の応答時間（大引けの入力 約 2 万トークン。生成が 90 秒を超えると TIMEOUT で失敗し、上限額で確定する）
  - 本番の plan の wall clock（150 秒か 400 秒か。V0 は 150 秒を前提にしている）
  - 本物の Anthropic が strict なスキーマを受け付けるか（オフラインの変換は PASS。本物は Phase 1g の小さな smoke だけ）
  - 後で merge する側で、#153 と `handler.ts`、#157 と `isolation_test.ts` の調整が要る
- merge 0、deploy 0、production 0、paid_calls 0。Secrets・`.env`・鍵は読んでいない。ほかのスロットのファイル・branch・worktree は変更していない
- next_recommendation
  - L6 で #170 とパッチを評価する
  - 今日使うなら、F2 との調整（またはパッチの適用許可）と、範囲を絞った本番ゲートの TASK を、すぐに出す
  - 間に合わなければ、明日以降の大引けから同じ手順で進める
