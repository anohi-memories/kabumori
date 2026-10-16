# F6 — J1 R1/R2 共通Claude APIセキュリティ修正（source-only）
- task_id: common-ai-f6-j1-import-timeout-security-fix-20261015
- slot: F6
- owner: claude
- status: done
- next_owner: none
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- start_code: F6
- completion_code: L6
- recommended_model: **Opus5.5（高）**
- production_mutation_window: CLOSED
- previous_archive: .agent_v2/archive/2026-10-15-f6-openai-anthropic-inventory-plan.md
- previous_task_id: common-ai-f6-openai-anthropic-migration-inventory-20261015
- review_source: .agent_v2/reports/J1.md (V1 CHANGES_REQUIRED/P2×2, GitHub status not yet reconciled)
- dependencies: protected Draft PR #187 → #198 → #205; inventory Draft PR #216; H5 finished; F3/F4/F5 POSTONA ownership protected.
- goal: Resolve J1 R1/R2 without changing live consumers; POSTONA Claude migration remains subsequent task.

## Start gates
Fresh origin/main and exact PR HEAD/ancestry, new/old ACTIVE_TASK and CURRENT_STATE metadata, J1 findings, F6 completed archive, protected F3/F4/F5/F2/F8/F9 and old G6/H5 owners, changed-file collisions, clean independent worktree. If overlapping files, diverged PRs or dirty worktree, STOP and return blocker. Do not overwrite J1 reviewer materials or another slot.

## Allowed source scope
F6-owned `supabase/functions/_shared/ai_provider/**` policy, isolation guard and related tests, and *only if necessary and explicitly non-conflicting* narrow H5 `_shared/ai_consumer_bridge/**` contract adjustments via separate coordination with H5 owner. If ownership conflict, do not modify H5 file; report the precise handoff. Scoped `docs/ai-provider/F6_*` may be added. Own TASK/ACTIVE metadata only. No modifications to POSTONA F3/F4, common account F5, G1 pause, legacy H5 worktree or PR branches without safe agreement.

## R1 [P2] Dynamic imports and privilege boundary
J1 Report: authorized bridge can access private provider symbols through dynamic `import("../ai_provider/mod.ts")`; scanner checks static import only. Fix guard so dynamic/computed imports, aliases/import maps, realpath/symlink, transitive/re-export paths and unresolved graph edges fail closed or are verified by robust module/AST graph and symbol policy. Do not broaden allowlist. Positive tests valid imports; negative mutations exact R1 reproduction, dynamic namespace, computed path, alias, symlink, export-star/transitive, unreadable edge; keep previous three regressions protected.

## R2 [P2] Ambiguous retry and possible charge
J1 Report: HTTP 504 timeout_error maps retryable SERVER_ERROR, while retryOnTimeout:false only blocks TIMEOUT; bridge example with maxTransportAttempts2 re-sends. Ensure any timeout/connection-loss/unknown possibly billed attempt does not automatically retry unless separately approved explicit bounded policy. Prefer fail-closed at-most-one attempt for ambiguous outcomes. Preserve known-unsent 429/529 handling only according to explicit policy. Test 504, loss after send, client timeout, known 429/529, mark_sent lost response, replay, settled-unknown, aggregate reservations and budgets; no model/provider fallback. Preserve existing market report primary_both and OpenAI adapter behavior.

## Safety and tests
Source-only Draft candidate; no paid Claude/OpenAI traffic, no Supabase mutations/Auth/RLS/RPC/Cron/Edge deploy, no secrets, live posting, production API switch, merge or deploy. Deny network and fake keys. Re-run provider, bridge, market-report offline suites; run focused mutation tests and compare exact pre-existing shared typecheck failures without silencing. Correct docs/contracts and report any remaining risk. Preserve PR187→198→205 order and J1 findings; coordinate targeted independent delta re-review only after L6.

## Completion
Report changed_files/paths, independently reproducible R1/R2 fail-before/pass-after, tests, actual commit/push, Draft PR/base/head read-back, current worktree/PR collision checks, remaining issues and risk, source_only, no paid calls/merge/deploy, production NO_GO. Update F6 Report and metadata to review_required/next_owner chatgpt; return L6 to this chat. No production approval implied.

## Report
- task_id: common-ai-f6-j1-import-timeout-security-fix-20261015
- result: **FIXED_SOURCE_ONLY（R1 と R2 を直した。Draft PR #219）**
  - R1: 読み込みの検査が、動的な `import()`、計算した道筋、別名、シンボリックリンク、中継、読めない道筋を止めるようになった。許可リストは広げていない
  - R2: 課金されたか分からない失敗（時間切れ、504 / `timeout_error`、送信後の切断、その他の 5xx）は、`maxAttempts` に関係なく送り直さない。送り直すのは 429 / 529 / OpenAI 503 だけ
  - 本番・台帳・Secret・Edge・Cron・設定の変更は 0。有料の呼び出しも 0
- branch / commit / PR
  - `claude/f6-j1-r1-r2-fix-20261016`（独立した worktree `/Users/yuya/Developer/kabumori-f6-j1-fix`、#205 の head から作成）
  - commit `643bc3c59258a53792146f282c0ad618c24e16d7`（修正）、`be35cc93205fedd6af1321aaeb1fc38d71e9b946`（文書の数の訂正。これが head）
  - Draft PR [#219](https://github.com/anohi-memories/kabumori/pull/219)。読み返し: OPEN / Draft、base `claude/f6-h5-bridge-boundary-20261015`（#205、head `4cd2cbdd`）、head `be35cc93205fedd6af1321aaeb1fc38d71e9b946`、12 ファイル、MERGEABLE
  - 順番 #187 → #198 → #205 → #219 は変えていない
- changed_files（12）
  - `supabase/functions/_shared/ai_provider/retry.ts`（`isKnownUnsent`、`retryOnTimeout: true` を無効に）、`types.ts`（`retryOnTimeout?: false`）、`execute.ts`・`model_policy.ts`（説明だけ）
  - テスト: `isolation_test.ts`（R1）、`errors_test.ts`、`execute_test.ts`、`model_policy_test.ts`、新しい `ambiguous_retry_test.ts`
  - 文書: `docs/ai-provider/PROVIDER_CONTRACT.md`（再試行の契約）、`F6_M1_ANTHROPIC_MULTIMODEL.md`（1 行）、新しい `F6_J1_R1_R2_FIX.md`
  - H5 の `ai_consumer_bridge/**` は変えていない
- R1 直す前 / 直した後（本物のファイルに同じ細工。シンボリックリンクと読めないフォルダも本物。直す前 = #205 `4cd2cbdd` の検査）
  - 直す前に見逃し → 直した後に止める（9 種類）: J1 の再現そのもの（bridge の `import("../ai_provider/mod.ts")`）、bridge の `await import`、計算した道筋、import map の別名＋その読み込み、bridge のフォルダへのシンボリックリンク、handler が primary から台帳の部品を取る、handler の `export *`、読めないフォルダの中継、`AI_PROVIDER/`（大文字）、`"a//b"` の後ろの `import`
  - 以前の回帰 3 つ（別名での `executeAiRequest`、新しい Edge が bridge を使う、private な台帳ファイル）は、直す前も後も止める
  - 普通の読み込み（相対、`npm:`、型だけ、JSON、文字列そのままの `import()`）は、直す前も後も通る
  - テストの中の合成の木でも同じ種類を確かめる（`J1 R1:` の 2 テスト。シンボリックリンクと読めないものは読み手を差し替えて確かめ、ファイルは書かない）
  - 名前の決まりをモジュールの全ファイルに広げた。handler は `market_report_primary.ts` の今の 4 つの名前だけ（狭める変更）
- R2 直す前 / 直した後
  - J1 の再現（bridge、`maxTransportAttempts: 2`、504 `timeout_error` のあと 200）: 直す前 2 回送信 → 直した後 1 回。台帳の予約 1 つ、精算 `unknown`
  - 新しいテストを直す前のコードに当てると 11 件が落ちる（`errors_test.ts` は新しい関数が無く読み込みで止まる）。このブランチでは 43 件すべて通る。手順は `F6_J1_R1_R2_FIX.md` §3
  - 確かめたこと: 504 / `timeout_error`（両 provider）、送信後の切断、こちらの時間切れ、500 / 502 / Anthropic 503、429 / 529 / OpenAI 503（`maxAttempts` の範囲だけ）、429 のあと 504、mark_sent の応答が失われた場合、`unknown` で精算済みの呼び直し（`ATTEMPT_FINALIZED`）、まとめての上限。モデルや provider の切り替えは無い
  - 変えていない: エラーの分類と `retryable`、台帳の流れと費用の計上、市況レポートの `primary_both`（もともと 1 回）、OpenAI の adapter、市況レポートの旧経路 `transport_retry.ts`
- tests（Deno 2.9.6、`--deny-net`、偽の鍵、本物の鍵の環境変数は外した子プロセス）
  - 共通AI基盤 `_shared/ai_provider/`: **139 PASS / 0 FAIL**（型の確認あり。直す前 126 + 新しい 13）
  - H5 bridge `offline_run.sh`: **27 PASS / 0 FAIL**
  - 市況レポート `market-report-analysis/`: **324 PASS / 0 FAIL**（型の確認あり。トレースの書き込みの警告は既知のもの）
  - `_shared` の全 65 テストファイル: **671 PASS / 0 FAIL**（`--no-check`。直す前の同じ取り出しで 658 PASS）
  - 型の確認（`_shared` の全テストファイル）: 直す前と後で**同じ 5 件のエラーだけ**。どれも今回触っていないファイル（`brand/brand_post_generator_test.ts:597/601/604`、`brand/dispatch_gate_test.ts:57`、`x_oauth2_post.ts:66`）。隠したり弱めたりしていない
  - main と合わせた木（`798d56be` との merge-tree）でも、新しい検査 12 件が通る（他の人の新しいコードで誤って止まらない）
  - lint（`--no-config`、変更した 9 ファイル）: 直す前も後も 0 件。`git diff --check` OK。秘密情報の文字列 0
  - わざと壊す確認
    - R1: 上の 9 種類（直す前の検査はすべて見逃す）
    - R2: 10 種類（分類の条件、`maybeBilled` の条件、5xx を送り直す、切断と時間切れを送り直す、429 / 529 を送り直さない、`retryOnTimeout: true` を許す、`maxAttempts` を無視、mark_sent の失敗でも送る、`unknown` を 0 円で精算、504 を課金なしに）→ **10 種類すべて検知**。1 回目は「切断と時間切れを送り直す」が `maybeBilled` の条件に守られて見えなかったので、条件が単独でも効くことを確かめるテストを足した
  - `execute_test.ts` の 11 / 14 / 15 / 21 は古い決まり（5xx・切断・時間切れを送り直す）を固定していたので、新しい決まりに書き換えた。どれも送る回数を少なく確かめる向き
- collision checks
  - #187 `a7e1d3f3`、#198 `4223d5c0`、#205 `4cd2cbdd`、#216 `1dc7b72e` は変わっていない（Draft のまま）
  - main（`798d56be`）と merge-tree で衝突なし。main は merge-base 以降、変えたファイルに触れていない
  - 同じファイルに触れる開いた PR: F6 自身の stack と、古い G6 の #157（`isolation_test.ts`、Phase 2 の残り）。#148 / #150 / #162 は別のファイル。他の slot の PR とは重ならない
  - J1 の Report、H5 / F2 / F3 / F4 / F5 / G1 の TASK・PR・worktree には触れていない
- remaining_risk（詳しくは docs §4）
  - 読み込みの検査は CI の検査で、実行時の囲いではない（`eval` / `new Function` / `Worker` の文字列までは見ない。いまの functions には無い）
  - functions の外の設定（リポジトリ直下の `deno.json` / `package.json`、`supabase/config.toml` の `import_map`、deploy の `--import-map`）は読まない
  - 500 / 502 / Anthropic 503 は送り直さなくなったが、費用は今まで通り 0 円で精算する。実は課金されていたら台帳が少なく数える。市況レポートの動きを変えないため変えていない（判断が要る）
  - 失敗のあと呼び出し元が新しい callId / 新しい操作で呼び直せば、新しい有料の呼び出しになる（呼び出し元の判断）
- H5 への引き継ぎ（H5 のファイルは変えていない。必須ではない）
  - H5 の `isolation_test.ts` は静的な `from` しか読まない。bridge の動的な読み込みは F6 の検査が止める
  - bridge の例の `maxTransportAttempts: 2` は、429 / 529 だけを送り直すようになる。費用の前もっての確認はそのままで安全側
  - `H5_M2_CONSUMER_BRIDGE.md` の「retry limit」を「処理されなかったと分かる拒否だけ」と読める書き方に直すとよい
- source_only: yes。merge 0、deploy 0、paid_calls 0、production の変更 0、Secret の値・`.env` は読んでいない
- production: **NO_GO のまま**。この Report はマージや本番の承認ではない
- next_recommendation
  - L6 で評価し、#219 の差分だけの独立した再レビュー（J1 の推奨は Sol（高））と必要な回帰の確認を割り当てる
  - 500 / 502 / 503 の費用の扱い（0 円か最大額か）を決める
  - H5 の引き継ぎは任意。マージの判断は #187 → #198 → #205 → #219 の順で別に

## L6 ChatGPT判定（2026-10-16）
- verdict: PASS_SOURCE_FIX / SECURITY_REREVIEW_REQUIRED / MERGE_HOLD / PRODUCTION_NO_GO
- PR219 OPEN Draft head be35cc93205fedd6af1321aaeb1fc38d71e9b946 confirmed. 12 changed files. Reported tests not independently rerun.
- remaining: independently review R1/R2 deltas and unresolved maybe-billed 500/502/503 ledger settlement undercount; existing shared typecheck errors 5. No merge/deploy/paid API or production change authorized.
