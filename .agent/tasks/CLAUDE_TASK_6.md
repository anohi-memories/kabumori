# G6 CURRENT TASK — 共通AI基盤 Phase 2b / 市況レポート配線のオフライン統合・安全ゲート

- task_id: common-ai-provider-g6-phase2b-market-report-wiring-offline-20261012
- owner: claude
- slot: claude-6
- status: ready
- next_owner: claude
- start_code: G6
- finish_code: K6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- priority: high
- user_approval: 2026-10-12「すすめて」— K6 Phase2a PASSの次工程として**Phase2bのオフライン接続と安全性検証**。有料API・Supabase本番変更・Secrets登録・Cron/Edge deploy・実配信切替の承認ではない。
- mode: OFFLINE_SOURCE_ONLY; production_mutation_window: FORBIDDEN; merge/deploy: FORBIDDEN
- previous: Phase2a [Draft PR #148](https://github.com/anohi-memories/kabumori/pull/148), head `a71de72b3bcfc88547b616f789df7765283565ed`, new adapter and tests; K6 PASS_SOURCE_CANDIDATE / NOT_WIRED.

## Purpose and collision constraints
- Create an **offline integration candidate** proving how current market-report generation would use Phase2a shadow adapter, with legacy output unchanged and zero real API access. Avoid merely repeating Phase2a unit tests: add full generator/handler-boundary simulation using real repository synthetic fixtures, fake provider, fake ledger, and cost/time/error instrumentation.
- G2 owns PR143 (Draft, head `889ca1b44cf82bd3ecb913818dca568456849feb`) and stacked PR149 (Draft, head `31c509df1c08ecc437ca4b70541284f223c836e2`), plus market-report-analysis and scalable notification/worker/DB boundaries. **Do not modify any G2 branch, handler.ts, analysis_logic.ts, PR143/149 files, worker, migrations, notifications, or G2's worktree.** Review of G2 PR149 by H2 may be underway. Even if G2 status shows done, ownership of unmerged PRs remains protected.
- G5 Auth, G8 news, G9 API optimization, POSTONA/MIC, the other G/H slots remain protected. Do not touch shared source that another slot is editing. G6 only independent worktree/branch.
- Reuse Phase2a candidate on separate clean G6 branch without force-pushing/rebasing PR148. New changes preferred in `supabase/functions/_shared/ai_provider/` **new integration-test/harness filenames** and `docs/ai-provider/` docs. Existing Phase2a source can be referenced/imported; if it needs correction, report problem instead of modifying PR148 without explicit next decision.

## Work instructions
1. Fresh read PROJECT_RULES.md, HANDOFF.md, ORCHESTRATION, ACTIVE_TASK, CURRENT_STATE, all 15 slots/Reports relevant to collision, fresh origin/main, PR148/143/149 heads, independent G6 worktree/branch and existing provider/ledger API. Do not assume idle=free. A file/boundary collision or unsafe independent worktree => STOP/K6.
2. Inspect actual report generator's requester construction, claim context, report lifecycle, deadline and error path **read-only**. Identify exact offline integration seam and its compatibility constraints (cycle ID, attempt index, step count, model catalog, schema) while protecting G2 source.
3. Implement a distinct **offline wiring/harness candidate** under G6-owned new files which models the existing report requester call sequence through the Phase2a adapter. Validate OFF (exact identity, same generated output/diagnostics as legacy), SHADOW (still legacy report output and no user-visible packet differences), fake provider and ledger, deterministic callId/idempotency across duplicate claim attempts, failure/timeout/abort, errors from recorder, and explicit no-network/no-credentials. Include fixture that closely resembles morning and close generation. No real holdings/user content to external API.
4. Investigate **sequential shadow latency**, real report Edge execution limit and Cron overlap, possible late/shadow in-flight after primary success or timeout. If modifying the report handler would be necessary for a safe deadline guarantee, do not touch it: document exact integration contract and release blocker, tests to run in next controlled patch. Do not assert runtime guarantee from fake tests.
5. Verify trial budget limits: month $5 /40 calls, day $2 /6, per attempt $1 for system Opus5.5. Document representative per-call cost, generation twice/day × business days, 1/2 shadow steps, daily/monthly consumption, denial behavior; **no policy widening**. Define a small canary window and stop thresholds for separate approval. A cap increase must be a separately requested production mutation.
6. Security/operability: contract for EDGE `ANTHROPIC_API_KEY` scoped secret and existing ledger key, no secrets printed, service-role-only ledger, no user/brand cross-routing, **recovery for sent/unknown reservations BEFORE any live use**, sanitized observations, diagnostics separating OpenAI and Claude spending, rollback and monitoring plan. Identify cancellation/race risks. Existing production providers/Edge Cron untouched.
7. Confirm the feasibility of integrating PR148 and G2 PR143/149 without moving ownership. Produce precise integration/PR dependency plan: which owner and slot should edit each file later; decide whether G2 needs to land PR143/149 first; exact tests and release gates; describe conflict stop conditions. Keep Phase2a PR148 Draft untouched; new Draft PR from G6 branch if independently implementable, otherwise STOP with a full blocker report. Never merge or deploy.
8. Run offline Deno tests, type/lint, nearby provider and market report regressions, repository secret scan and offline bad-input/mutation probes if feasible. State results as actual executed; no web/network API, secrets/env key reads, real Supabase, Anthropic/OpenAI paid calls, X/Meta posts, push, migrations, service-key creations.
9. Report in `## Report — Phase2b` on this TASK: result, changed_files, branch/commit/PR, integration details, test commands/counts, source/production 0, safety_checks, blockers, next_recommendation. Set status review_required/next_owner chatgpt; return **K6** to **共通AI基盤のちゃ（OpenAI・Claude API専用チャット）**. Protect previous reports and other slot state from overwrite.

## Acceptance
- PASS_OFFLINE only if full generator-boundary harness + meaningful regression tests + collision-free Draft PR/docs + safe rollout/rollback/dependency gate documented, no real external invocation. If cannot implement without modifying G2-owned source, STOP/K6 with actionable contract and await explicit coordinated G2 task.
- **Never automatically activate shadow, create/inspect secrets, increase budget, change live Edge/Cron, merge PRs or run another paid Claude smoke.** Later live canary/policy/production needs fresh user approval after K6 and any required independent security review.

## Report — Phase2b（G6記入）
- task_id: common-ai-provider-g6-phase2b-market-report-wiring-offline-20261012
- result: NOT_STARTED
- changed_files: none
- tests: NOT_RUN
- push: no
- merge: no
- deploy: no
- production: 0
- paid_external_requests: 0
- remaining_issues: G6 to resolve
- next_recommendation: G6 starts; return K6

---

# PRESERVED G6 PRIOR TASKS / REPORTS — do not rewrite below

# G6 CURRENT TASK — 共通AI基盤 Phase 2a / 市況レポート向け Provider 接続アダプター（オフライン限定）

- task_id: common-ai-provider-g6-phase2a-market-report-adapter-offline-20261012
- owner: claude
- slot: claude-6
- status: done
- next_owner: none
- start_code: G6
- finish_code: K6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- priority: high
- user_approval: 2026-10-12 本チャット「OK」— 共通AI基盤 Phase2aを G6 に割り当てる。**オフライン実装・検証のみ**、本番接続/切替/課金は未承認。
- mode: source-only, separate G6 worktree, independent Draft PR, NO production
- production_mutation_window: NOT_APPLICABLE / FORBIDDEN
- previous_phase1g: K6 final PASS; production ledger 1 usage event; user reported temporary sb_secret and local ledger.env destroyed; **NEVER repeat paid smoke**.

## Goal
共通 Provider + Ledger を、既存のかぶモリ共通朝刊/大引けパイプラインから段階的に呼べるようにする、切替OFF既定の**接続候補**を用意する。既存配信の挙動は main / production で変更しない。Phase2aでは運用上のモデル自動切替や料金プラン、利用者の個別レポート接続は実装しない。

## Starting gates
1. fresh origin/main から G6 **固有の独立クリーンworktree** を作る（または G6 自身のクリーンworktreeのみ利用）。PROJECT_RULES.md / HANDOFF.md / .agent/ORCHESTRATION.md / ACTIVE_TASK.md / CURRENT_STATE.md / 本TASK / 既存共通 Provider と ledger / main市況レポート生成入口を確認。TASK status ready/in_progress 以外では開始しない。
2. 全15枠、TASK/Report、worktree/branch、変更予定ファイルと Draft PRを照合。G2は `kabumori-market-report-scalable-broadcast-push-v1-20261012` を進めるため、**G2のPR143、朝夕push producer/dispatcher/worker/DB migration/notificationファイルに触れない**。G5の共通Auth、G8ニュース、G9コスト調査、POSTONA、MICにも触れない。同一ファイルやAPI境界に競合があれば **STOP→K6で相談**。他slotのdev serverやGit変更に触れない。
3. 独立した限定アダプターを追加する前に、実際に共通市場レポート生成側の既存 Providerインターフェース、payload、error propagation、Edge env/secrets、ログ、旧生成経路を把握して変更ファイル候補を列挙。G6の変更対象を `supabase/functions/_shared/ai_provider/` 新規 adapter・その新規テスト・`docs/ai-provider/` 文書に原則限定。既存の report Edge entrypoint や共通 import をどうしても触る必要がある場合、競合・リスクを明記し **その場でコードを触らず STOP/K6**。
4. 既存 `ai_provider` / `ai_ledger` API、system `kabumori.market_report` ポリシーの仕様に適合。新アダプターは `off` / `disabled` が明示の既定値、誤設定・未設定時も legacy existing behavior を維持（本番に接続しない）。新モデル・用途への広域ポリシー自動作成は禁止。
5. Claude Opus 5.5 を **shadow候補**として、**合成Fixtureだけ**使う Deno unit/fake transport/fake ledger / contractテストを実装。出力のschema適合、長文/エラー、タイムアウト、予算拒否、部分失敗、取消、トークン利用量と推定費用、二重送信防止、クロスユーザー/データ漏洩・secret出力抑止を検証。可能なら旧生成結果との構造比較は offline fixture のみ。production RESTやAnthropicへの実呼出は禁止。
6. レポート生成が推論失敗した場合の挙動は既存の安全な配信継続方針を守る。ただし「強引な retry/二重生成」「budget拒否時の別providerの実課金への無断切替」はしない。切替ONの条件/スコープ、予算ガード、計測、roll backを仕様書へ。課金算定は Ledger と突合できるもののみ。
7. docsに「Phase2a実装済（ソースのみ）」と「未承認の本番ステップ」を明確に分離した接続/rollback runbookを作る。候補Draft PRへコード変更を集約し、original G6 Phase1g smoke script/既存DB migration/Policyを変更しない。PR open Draft のみ。mergeせず Preview/Testのみ。
8. 変更範囲内のテスト/型検査/lint/差分・機密情報確認を実行。外部送信はもちろん、`SUPABASE` secrets/Claude API keyの読み取り、.envのコピー、Edge secrets set、Supabase production DB/Edge/Cron、X実投稿、deploy/merge、課金・追加モデル呼び出しはすべて禁止。
9. ReportをこのTASKの `## Report — Phase2a` に追記、status `review_required` next_owner `chatgpt` でK6へ返す。証拠: task_id, result, scope/changed_files, tests pass/fail, commits/branch/PR head, actual push/merge/deploy, remaining_issues, security_checks, production=0, external_paid_calls=0, next_recommendation. 共通STATE/ACTIVE の自身区画のみ競合なしにCAS更新。他slot Reportは触らない。

## Done criteria and review gate
- Phase2a pass = 新しいadapter層と安全なdisabled default、合成Fixtureテスト、error/budget/idempotency検証、Draft PR + docs + Report。実朝刊/大引けの生成モデル変更・本番動作は**未完了が正しい**。
- DB/RLS/Auth/Secrets/productionへの差分が出たら fail-closed STOP。K6時にAuth/security/budgetの新境界があればH1〜H4で独立レビュー要否を判断（H5通常レビュー禁止）。
- 次のPhase2b（実レポート入口への配線、shadow、本番Secret登録・配信切替）は**別TASK/別ユーザー承認**が必要。

## K6 FINAL — Phase2a source candidate accepted (2026-10-12 JST)

- verdict: **PASS_SOURCE_CANDIDATE / NOT_WIRED / PRODUCTION_NO_GO**. GitHub Draft PR #148, head `a71de72b3bcfc88547b616f789df7765283565ed` inspected: 3 newly added files only (new shadow adapter, 18 offline test cases, docs). PR remains OPEN/DRAFT/unmerged.
- scoped source review: default OFF returns legacy requester identical; missing key/ledger/context/model also OFF; shadow sends at most once per call with deterministic IDs, budget guard; legacy result returned regardless of shadow outcome. No G2, G5 or report entrypoint modification. Direct source inspection agrees with task. 18 new tests, provider112, report283, mutations4/4, lint/type/secret scan are **G6-reported**, not independently reexecuted by ChatGPT.
- caveats before wiring: shadow execution sequentially extends report runtime (max 90s per invocation unless configured), actual quality/content equivalence cannot be inferred from structural comparison, ledger budget monthly $5/40 calls insufficient for continuous daily shadow, and observable per-report OpenAI diagnostics exclude shadow Anthropic cost. Integration ownership/secret/recovery policy to be decided before any production stage.
- status: **done / next_owner: none**. Additional H-review not assigned at source-only isolated adapter stage; reassess focused security/side effects before activating paid shadow/Edge Secrets or production changes.
- production=0; external_paid_calls=0; source commit only; PR not merged or deployed. No Phase2b approval implied. Future task requires new explicit user decision and fresh all-slot conflict check.

---

## Report — Phase2a（G6記入）

- task_id: common-ai-provider-g6-phase2a-market-report-adapter-offline-20261012
- result: **PASS_CANDIDATE (source only, default off, not wired)**
- scope / changed_files: Draft PR [#148](https://github.com/anohi-memories/kabumori/pull/148)。新規3ファイルだけで、既存ファイルの変更は 0
  - `supabase/functions/_shared/ai_provider/market_report_shadow.ts`
    - `createMarketReportRequester`
    - `shadowRequestFromResponsesBody`
    - `compareStructure`
    - `ledgerGuardFromEdgeEnv`
    - `parseMarketReportAiMode`
    - `marketReportShadowCallId`
  - `supabase/functions/_shared/ai_provider/market_report_shadow_test.ts`（18件）
  - `docs/ai-provider/PHASE2A_MARKET_REPORT_ADAPTER.md`（実装済み（ソースのみ）と、未承認の本番の手順・rollback を分けて記載）
  - 変更していないもの: market-report-analysis（G2 所有）、`mod.ts`、モデル登録表、migration、ポリシー、Phase1g の smoke、G2 PR143 と push 関連
- design:
  - 市況レポートの `Requester`（`(step, body) => {payload, inputTokens, outputTokens}`）を包む
  - `KABUMORI_MARKET_REPORT_AI_MODE`
    - 未設定・`off`・その他の値（`primary` / `on` / 大文字小文字違い）→ off。**今の requester そのもの（同じ関数）を返し**、読む環境変数はモードの1つだけ
    - ちょうど `shadow` で、かつ条件（使えるキー、台帳 Guard、cycle と claim の試行番号、呼び出し側が渡すカタログ上の Anthropic モデル）がそろったときだけ shadow。条件が欠ければ理由付きで off
  - shadow の動作
    - 今の段階が成功した後に、同じ instructions・input・スキーマ・最大出力・effort を1回だけ送る
    - 送信は1回で、再試行も fallback もしない。台帳（reserve → mark_sent → settle）を通し、主体は system（kabumori / market_report、logical role `*.shadow`）
    - 戻り値は今の結果のまま。今の段階が失敗したら shadow しない。対象は既定で generate だけ、最大2回、90秒、AbortSignal に対応
  - 呼び出し ID は `mr:<cycle>:a<claim の試行番号>:<step>:<何回目か>` で決まる。再実行は台帳が拒否するので、二重課金しない
  - 記録には本文を入れない（コード・トークン・台帳と同じ金額・構造の比較のみ）。sink の例外は飲み込む
  - モデル ID はこの層に直書きしない（Provider の分離テストの規則「モデル ID はカタログだけ」と、呼び出し側が選ぶという契約に従う）
- compatibility（オフライン）: 実際の generate / fact の依頼本文（オフライン fixture から作成）は、Provider の検査と Anthropic 向けのスキーマ変換に PASS
  - 1回あたりの上限見積もり: generate $0.45、fact $0.16。どちらも試験用ポリシーの1回 $1 以内
- tests:
  - 新規 18件 PASS（実 API・本番 0。Claude の応答は合成、台帳は「1回の試行につき送信1回」の偽物）
    - 既定 OFF と、同じ関数であること
    - 条件が欠けたときの off（8通り）
    - 変換と、不正な本文5種類の拒否
    - 成功時の結果の一致と、台帳との費用の一致
    - 対象と回数、今の段階が失敗したときの扱い
    - エラー6種類（送信1回、再試行なし）
    - スキーマ違反と max_tokens での打ち切り
    - 予算の拒否4種類（送信 0）
    - 冪等性（再実行は ATTEMPT_FINALIZED）
    - 確定の失敗（予約は残る）
    - 時間切れと取消（開始前・送信中）
    - sink の例外
    - 本文・キーの漏洩なし（項目は15個に固定）
    - 構造の比較に本文が入らないこと
    - **`generateSharedAnalysis` の結果が、shadow あり・なしで完全に一致**
    - `ledgerGuardFromEdgeEnv`
  - mutation 4/4 検出（off で別の関数を返す／再試行を許す／記録に本文を混ぜる／既定で fact も対象にする）
  - 回帰: 共通 Provider 112件（分離の規則のテストを含む）、市況レポート 283件、型チェック、lint（30ファイル）すべて PASS
  - 差分の秘密情報スキャン 0件
- commits / branch / PR head: `a71de72b` on `claude/g6-phase2a-market-report-adapter-20261012`、Draft PR #148
- push: PR の branch へ push 済み。この Report は main へ fast-forward。merge: no。deploy: no
- production=0、external_paid_calls=0
  - Secrets・`.env`・Claude API キー・Supabase キーは読んでいない、コピーしていない
  - DB・Edge・Cron・X への操作は無い
- security_checks:
  - 既定は off、条件が欠けても off
  - 主体は system だけで、利用者・ブランドを渡す経路が無い
  - 記録に本文・キーが入らない
  - 台帳を必ず通し、二重送信を防ぐ
  - 別の provider への切り替えは無い
  - 認証・権限・DB の新しい境界は無い（台帳 Guard の経路は既存の Phase1b / Phase1g と同じ）
- remaining_issues（どれも Phase 2b 以降。別 TASK・別承認）:
  1. `market-report-analysis/handler.ts` への配線は G2 が所有するファイル。G2（PR143 など）との調整が必要。`mod.ts` へのエクスポートもこのときに追加する
  2. shadow は今の段階の後に順番に走るので、実行時間が延びる（最大 `timeoutMs`）。Edge の時間内に収まるかを決める必要がある
  3. 今の試験用ポリシー（月 $5・40回）では、毎日の shadow は月の途中で `BUDGET_DENIED` になる（試算は月 42〜84回・$11〜23。安全側）。毎日続けるならポリシーの見直しが必要
  4. Edge Secret `ANTHROPIC_API_KEY` の登録と、台帳の回復処理の Cron（台帳を使う本番の呼び出しより前に必要）
  5. レポートの `diagnostics.cost_usd` は OpenAI の単価のまま。Claude の費用は台帳で確認する
- next_recommendation:
  - K6 で PR #148 を評価する（認証・権限の新しい境界は無いので、追加の H レビューは任意）
  - 次は Phase 2b: G2 と調整して配線し、Secret・Cron・ポリシーを決め、数日だけ shadow を ON にする。それぞれ別承認
---

# PRESERVED G6 PRIOR TASKS / REPORTS (completed Phase1g below; immutable history)

# G6 CURRENT TASK — 共通AI基盤 Phase 1g / Claude API 1回だけ台帳込み実接続テスト

- task_id: common-ai-provider-g6-phase1g-one-paid-call-ledger-smoke-20261011
- owner: claude
- slot: claude-6
- status: done
- next_owner: none
- start_code: G6
- finish_code: K6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- priority: high
- user_authorization: **2026-10-11「じゃあ進めて」** — 直前に「Phase1g: Claude APIを1回呼び出し、予算管理DBに利用量を正しく記録する。見積費用上限約$0.04。テスト認証情報の準備が必要。G6で実施してよいか」と説明し承認取得。**固定の合成文で有料Claude Opus5.5リクエストちょうど1回のみ**を許可。無制限/再試行/本番配信・モデル切替は許可していない。
- production_mutation_window: **CLOSED** (ACTIVE 2026-10-11T14:43Z / 23:43 JST → CLOSED 14:44Z / 23:44 JST after read-back; one live smoke) — was RESERVED_NOT_ACTIVE。実際の`--ledger=supabase` smokeは共有本番DBのRPC書込みを伴う。実行直前にfreshの全15枠/G5/STATEを確認し、他のACTIVE窓がなければ自枠の短い `ACTIVE` 窓（対象：このsmoke1件のai_ledger reserve→mark_sent→settleだけ）を`.agent/CURRENT_STATE.md`へCAS記録。完了/失敗/STOPで必ずCLOSED。窓記録不可なら実APIを呼ばない。
- source_version: fresh origin/main の固定 `supabase/tests/ai_provider_claude_smoke.ts`、`docs/ai-provider/PHASE1D_ACTIVATION_RUNBOOK.md` §2手順1–3・7、Phase1a provider / Phase1b ledger。既存コードの修正や再デプロイは本TASK不要・禁止。

## K6 INTERIM VERDICT — CONDITIONAL HOLD RELEASE / Phase1g CONTINUE (2026-10-11)

- **K6 verdict: ACCEPT KEY_COMPAT_PRODUCTION_PRECEDENT, NOT A LIVE SMOKE PASS.** G6 Report claims production market-report-analysis uses new secret key with same apikey+Bearer headers to call service_role-only RPC successfully; source of this project shares that header pattern. However this is evidence from a different key/RPC, not direct proof that the new ephemeral key works. Existing smoke reads `ai_ledger_usage_summary` before external Anthropic call, and reserve/mark_sent are fail-closed. DO NOT remove authentication error handling.
- **Safety HOLD is conditionally released** for the specific once-only paid test, AFTER all prerequisite checks: user verified dedicated Workspace `kabumori-production` monthly $10 limit and email alerts $5/$8 in screenshots; user created workspace-scoped non-admin Claude key expiring ~2026-11-10 and confirmed local `anthropic.env` exists with permissions 0600 on 2026-10-11 23:13 JST. Actual key validity / file contents never disclosed or verified by ChatGPT.
- Continue SAME G6 TASK, not a new PR/slot: first guide user to create a NEW temporary Supabase secret key and save to local mode-0600 `ledger.env`; verify setup in offline `plan`. No key values/screenshots/chat logs. `G6` start proceeds only while task ready. Confirm no other production window ACTIVE; CAS record narrow ACTIVE before live call and CLOSED after, even failure.
- **Fail closed** if new secret key cannot call the ledger RPC in the live smoke's pre-Anthropic usage-summary probe, or if any warning/401/403: zero paid calls, STOP without changing guards/retrying/falling back to memory. After any Anthropic attempt, do not retry. 1 paid call upper cost <$0.05, fixed synthetic content; revoke Supabase temporary secret key after. Legacy service_role key use remains forbidden.
- Old CRITICAL hold below is retained as historical rationale, superseded by this conditional decision. Any new source/API compatibility anomaly reestablishes STOP and report K6.

## HISTORICAL CRITICAL G6 SAFETY HOLD — Supabase new sb_secret REST header compatibility (2026-10-11)

- **STATUS FOR LIVE: HOLD until explicitly resolved.** ChatGPT source-checked `supabase/functions/_shared/ai_provider/ledger_guard.ts`: existing `SupabaseLedgerBudgetGuard.#rpc` sets BOTH `apikey: <serviceKey>` and `Authorization: Bearer <serviceKey>`. The Phase1g runbook recommends a NEW ephemeral `sb_secret_...` key. Current Supabase official docs warn that `sb_secret` is an opaque key and is **not JWT**; using it as bearer on Data REST API may fail/reject JWT verification. Reference: https://supabase.com/docs/guides/getting-started/api-keys , Known limitations; official auth gateways route new keys via `apikey`. Fake PG/PostgREST shim tests may not detect this production incompatibility.
- **Fail-closed:** Do not ask the user to create a new high-privilege Supabase secret yet; do not issue/borrow a legacy service_role key; do not run `--mode=live`, call any API, or invoke a real ledger RPC until compatibility is verified **without an unapproved live API call**. Do NOT replace `sb_secret` with `anon` or fall back to `--ledger=memory`. Claude workspace creation/key storage and offline plan are safe to proceed separately.
- G6 should examine the official platform docs, actual REST auth expectations for `apikey` vs `Authorization`, the `ledger_guard.ts` fetch headers, and mocks. **Current TASK forbids source changes**. If a fix/test is needed, report `BLOCKED_KEY_COMPAT`/K6 and propose a narrow new G6 source/test-only TASK (Opus5.5（高） or Sonnet5（高） depending on complexity), separate approval for any code changes, before real production RPC smoke. Do not bypass security guard/tools.
- User was informed in this chat while giving setup steps. This safety hold is compatible with the original one-call approval; one-call approval remains valid but must only be executed after the new-key authentication mismatch is resolved and G6 startup gates still pass.

## 背景・現在の本番状態

- G6 Phase1f K6独立検証済み：本番 Supabase `wsmznyzcvmuitkglfeuj`に `ai_ledger`5表、`public.ai_ledger_*`7 RPC（service_role-only）、migration `20261010050613`、試験system-onlyポリシー **2件**あり。2026-10-11 21:55 JST、ChatGPT read-only readback 17/17 TRUE、history1、2 enabled、利用予約/利用/請求観測0。G6のPhase1f本番DB窓はCLOSED。
- テストの唯一の許可範囲: Anthropic / `claude-opus-5-5` / `kabumori` / `market_report` / `system` / 固定合成文 / 一つのcallId、**1 transport attempt**、出力最大1536 tokens、`effort=low`、料金上限試算 `$0.040164`（`SMOKE_MAX_USD=$0.05`）。1日$2・6回、月$5・40回、1回$1の既存ポリシーを変更しない。
- ユーザーはClaude Consoleクレジット付与・他用途での実テスト利用を確認済み。**専用workspace（月上限$10、通知50%/80%）が設定済みか、workspace-scoped keyが準備できたかは未確認**。設定が無ければユーザーだけが行う操作を案内し、秘密値を要求せず準備完了までWAIT。
- G2かぶモリの個別AIは「ユーザー明示依頼→永続ジョブ→閉じても通知」の別開発に移行。G6はG2の個別データ・G5 Auth・G8/G9ニュース、POSTONA/MICに触れない。株式の個人/保有銘柄情報・実ニュース本文はAnthropicへ送信しない。

## 実行前の必須ゲート（順番固定）

1. `PROJECT_RULES.md`、`HANDOFF.md`、`.agent/ORCHESTRATION.md`、`.agent/ACTIVE_TASK.md`、`.agent/CURRENT_STATE.md`、本TASK、runbook §2手順1-3・7、`ai_provider_claude_smoke.ts`、既存G6 Reportをfresh read。G6専用の独立クリーンworktreeを使用。前回G6 worktree本人のものならクリーン確認後利用可。G1–G5/G7–G10/H1–H5のbranch、worktree、TASK/Report/dev serverへ干渉禁止。
2. fresh main、同じ実装のsmoke/台帳ポリシーを照合。本番Supabaseへ**read-only SELECT**でmigration、RPC権限、scope限定の月/日policy2件 enabled、台帳現存の使用量/予約、見積り上限と空き上限を再確認。G5および全15枠の本番窓がACTIVEなら待機/STOP、枠/スキーマ更新が変わっていたら再判定する。台帳へINSERT等はまだしない。
3. Anthropic Consoleの正しい組織・**Dedicated Workspace**・残りクレジットと**workspace月$10 spending limit**を、ユーザー操作で設定・確認（値/秘密をチャットに求めない）。既存Default Workspaceの無制限キー/管理者APIキーでのテストは禁止。本人が設定できない場合は`WAIT_USER_SETUP`とし、試験は未実行と報告。
4. ユーザーがworkspace限定のClaudeキーを既に保存しているなら**流用可能**。なければ本人が発行し、Mac上の`0600`のローカル `~/.kabumori-secrets/anthropic.env` に安全に保存。G6はキーをダンプ/表示/収集/コミット/push/Report・CIログへ記録しない。Supabase Edge Secrets `ANTHROPIC_API_KEY` を`secrets set`してはいけない（Phase2aの別ゲート）。
5. **台帳RPC用の認証情報**: `--ledger=supabase` は`SUPABASE_URL`とservice_role権限相当の`AI_LEDGER_SERVICE_KEY`が必要。ユーザーがSupabase Dashboard上で**一時的な新しいsb_secret等のsecret API keyを作り、試験専用に持ち、直後に削除**する方法のみ原則許可。既存のservice_role keyの閲覧/コピー/変更や他アプリの秘密の流用禁止。これは高権限キーなのでG6は値に一切アクセスせずユーザー本人がMac上の`0600`の`~/.kabumori-secrets/ledger.env`へ保存する。API keyの新規作成・削除に安全装置/手順上のブロックやユーザー側の追加操作が必要なら**回避せずSTOP/WAIT**。決してチャット/GitHub/画面共有へキーを貼らせない。
6. 固定smokeを**`--mode=plan --ledger=supabase`**で先に確認（外部接続・課金なし）。環境変数ホワイトリスト、`ANTHROPIC_CUSTOM_HEADERS`/`BASE_URL`/`AUTH_TOKEN`禁止、モデル・合成入力・見積り`<= $0.05`、ledger URLが正しいprojectのみ、試験用キーのみ、Deno `--allow-net`は`api.anthropic.com`と指定1プロジェクトに限定。planがFAILならliveへ進まない。
7. liveの実行**直前**にCURRENT_STATE全体/G5/他writerをfresh再検査し、対象と期間を限定した短い本番`production_mutation_window: ACTIVE`をCURRENT_STATEへCASで記録。CAS競合なら再チェックするまでSTOP。G5优先。ロックを長時間保持しない。予算ポリシーを編集・広げない。
8. **実API呼び出しは厳密に1回**：runbook §2手順7の**既存のコマンド**で `--mode=live --ledger=supabase --confirm=ONE_PAID_CALL` を実行（ユーザー承認済）。Claude Codeの安全装置が実行を拒否した場合はコード改変・別ツール経由による回避をしない。必要ならユーザー本人が自分の端末で実行する手順を案内する。**Anthropic送信が発生した/不明なら二度と実行しない**。拒否/429/5xx/timeout/台帳不整合でも自動/手動再送禁止、後続操作STOP・K6に返す。
9. 1回の実API通過後、request ID, workspace ID, model, token usage、独立料金計算、台帳usage_summaryの**前後差分**（attempt +1/success +1/usage token/cost一致）を個人情報/secret値なしでread-back。台帳にUNKNOWN/未settledが残る場合、手動補修/rollback/台帳policy解除はせずK6へエスカレーション。必要最小限の識別子だけReport。成功/失敗いずれも実際のprovider HTTP実行回数と課金有無の事実を記す。
10. **終了時**: ユーザー操作で試験用Supabase secret keyを**破棄・無効化**し、Macの`ledger.env`を削除（中身は一度も表示しない）。Claudeキーについては継続利用に必要ならuser-owned `anthropic.env` のみ保持可、不要なら本人が削除。Consoleのコスト/ログで該当request IDを照合。キーを確実に失効できない場合`SECURITY_CLEANUP_PENDING`で完了PASSにしない。本番窓をCASで`CLOSED`にし（STOP/失敗含む）、G5と他ownerへ「system市場レポート名義で1回だけ台帳記録」という構造的事実のみ共有。
11. G6 TASK `## Report — Phase1g` と `.agent/ACTIVE_TASK.md` の**G6セクションだけ**を更新し、`status: review_required / next_owner: chatgpt`。CURRENT_STATEにはG6窓/結果の公開安全な最小情報だけをCAS追記。他スロットのTASK/Report/STATE内容は上書き・並べ替え禁止。コード・migration・policy・smokeの仕様変更は行わない。

## 完了条件 / fail-closed

- PASS: 既定スクリプトで**Claudeへのリクエスト1回**、応答のmodel・provider usage・費用の独立一致、**本番台帳で1件の予約→sent→settleとusage summary増分一致**、予算ガードPASS、試験一時Supabaseキー破棄・Macローカルファイル削除確認、窓CLOSED。Console実請求額は後から反映されうるので、即時の観測不能は`BILLING_PENDING`と区別し、実費ゼロとは言わない。
- WAIT/STOP: Workspace/月$10上限未設定、workspace限定キー不足、secret key発行/削除の不備、本番対象の不一致、予算残不足、他writer ACTIVE、実行安全装置拒否、live送信回数/結果の不確定、API失敗、台帳差分不一致。**台帳なし`--ledger=memory`へのすり替えは不可**。未実行のときは絶対に「実API成功」と記録しない。
- **禁止**: 2回目の有料実呼び出し、レポート実生成・朝刊/大引けのモデル変更、個人保有情報/他人のコンテンツ送信、G5 Auth/削除、source/migration/policy/GRANT・RLS変更、Edge/Cron/Secrets設定、本番デプロイ・GitHub PR merge、ユーザーデータ変更、他用途のAPIアクセス、追加課金契約。
- **別ゲート**: `ANTHROPIC_API_KEY`の本番Supabase Edge Secret登録、再試行/回復Cron、Phase2a G2との実レポートシャドー接続、個別課金・プラン・利用上限更新はすべて別TASK/承認。
- **レビュー**: ソースに変更なし、従来Provider/ledger/runnerのPhase1b独立C1レビューとPhase1d/E2E fakeテストを確認済。通常の追加Codex枠使用不要。Auth/課金/権限/Secret境界に新たな高リスク問題を観察した場合に限り、K6でH1–H4レビュー要否を判断（H5は臨時実装専用）。
- **AI Lab日記**: 実際の動作事実だけ公開安全に、secret・プロジェクトURL/identifier・内部認証構造・請求関連識別子を含めない。

## K6 FINAL APPENDIX — phase1g confirmed after credential cleanup (2026-10-11 JST)

- K6 final verdict: **PASS_SMOKE_WITH_USER_CONFIRMED_KEY_REVOCATION / G6 RELEASED**. Do not re-run `G6` live smoke or the same paid call.
- Real execution observation: `.agent/CURRENT_STATE.md` records one fixed live smoke 23:43 JST, provider request **1**, Claude Opus 5.5, fixed synthetic content, **estimated cost $0.001448**, system/kabumori/market_report, usage reconciled by G6's observed run. Production mutation window 23:43–23:44 JST **CLOSED**. The original earlier Report below is an **interim report from before the paid call**; it is preserved but superseded by this appendix and the K6 verified observations.
- ChatGPT independently inspected production ai_ledger readback via Supabase SELECT (2026-10-11 23:47 JST): **17/17 invariant checks true**, `history_row=1`, `reservations=1`, `usage_events=1`, `open_sent=0`, `open_reserved=0`, 2 enabled narrow test budget policies unchanged. Provider's independent HTTP request count and per-token usage not directly re-executed by ChatGPT; production db counts + G6 shared-state record are cited as distinct evidence.
- **SECURITY CLEANUP USER CONFIRMED IN THIS CHAT:** user reported they revoked/deleted the newly created temporary Supabase secret API key `g6_smoke_20261011` from Dashboard and subsequently confirmed they deleted the local `~/.kabumori-secrets/ledger.env` file. **Not independently verified from Console/Mac**. Ongoing Claude workspace key in `anthropic.env` deliberately retained. No credential values were shared, fetched or committed.
- status: **done / next_owner: none**. No new paid request/DB mutation/secret action by this K6. Source/Edge/Cron/model switch/deploy left untouched. Production provider integration still NOT deployed.
- tests: G6-run original single live smoke (shared-state entry), ChatGPT-readback production SELECT (17/17), user-confirmed temporary-secret cleanup.
- changed_files: G6 TASK final appendix/status, G6 ACTIVE_TASK index, CURRENT_STATE K6 final note only.
- commit_hash/push: GitHub source-control bookkeeping only; exact commit of this final note not yet known in this file.
- remaining_issues: separate Phase2a/cron/Edge-secret/cutover approvals and G2 coordination, possible independent Anthropic Console request bill reconciliation later if desired.
- next_recommendation: await specific next user instruction for a new G6 scope, preserve existing TASK/Report.

---

## Report — Phase1g（G6記入）

- task_id: common-ai-provider-g6-phase1g-one-paid-call-ledger-smoke-20261011
- result: **KEY_COMPAT_VERIFIED_NO_SOURCE_CHANGE / WAIT_HOLD_RELEASE_AND_USER_SETUP**
  - SAFETY HOLD の論点（新形式 `sb_secret_` を `apikey` ＋ `Authorization: Bearer` で送る）は、本番での実績により互換と判断した
  - ソースの変更は不要
  - live は未実行（HOLD の解除とユーザーの準備を待つ）。**有料 API 0回、台帳 RPC 0回**
- timestamp: 2026-10-11 JST（調査のみ）
- source_head / worktree:
  - fresh `origin/main` から作成。独立 G6 worktree `/Users/yuya/Developer/kabumori-g6-common-ai`
  - smoke・共通 Provider・ポリシー SQL・runbook は、PR133 の head `61be0dfb` と差分 0
- key_compat_finding（実 API を呼ばずに確認）:
  1. 公式ドキュメント（getting-started/api-keys の Known limitations、functions/auth-headers）
     - 「secret / publishable キーは `apikey` で送り、Bearer には入れない。JWT ではないので、JWT として検証するものは失敗する」
     - ただし、Data API の窓口が「`apikey` と同じキーが入った Authorization」をどう扱うか（拒否する／JWT に置き換える）は書かれていない
  2. **このプロジェクトの本番での実績**（台帳 Guard と同じ呼び方）
     - `market-report-analysis` は 9/17（05a677f1）から `SUPABASE_SECRET_KEYS['default']`（新形式の secret キー）を使っている
     - 呼び方は `{apikey: key, Authorization: Bearer key}` で `/rest/v1/rpc/<name>` に POST。デプロイ中の `e3379f80` も同じ
     - 呼んでいる `claim_market_report_analysis` は、public / anon / authenticated から取り消し、**service_role だけ**に EXECUTE を許可した RPC（台帳の RPC と同じ構成）
     - 本番の記録（CLAUDE_TASK.md）: 10/2 の朝刊は packet まで配信された。10/5 の朝刊は claim と DB の読み取りを通過し、その後の OpenAI の段階で `ANALYSIS_OPENAI_GENERATE_FAILED:429` になった。どちらも、窓口が service_role 専用の RPC を受け付けた証拠
     - `market-intelligence-ingest` と `send-push-notifications` も同じヘッダーの組み合わせで本番の REST に書き込んでいる
  3. **互換性がなくても有料呼び出しは発生しない**
     - smoke（`--ledger=supabase`）は、Claude を呼ぶ前に `ai_ledger_usage_summary` を同じヘッダーで呼ぶ
     - そこで 401 / 403 などなら REFUSED（終了コード 2）になり、送信 0
     - reserve / mark_sent が失敗した場合も、executeAiRequest は送信しない（GUARD_UNAVAILABLE / SEND_NOT_CONFIRMED）
  - 結論: **BLOCKED_KEY_COMPAT ではない。** 台帳 Guard・smoke の修正は不要
  - 将来の任意改善（今回は禁止。別 TASK）: 公式の推奨に合わせ、`sb_` 形式のキーは `apikey` だけで送る（Bearer を付けない）
- setup:
  - dedicated_workspace_cap=未確認（ユーザーの作業待ち）、claude_key=未保存
  - temporary_supabase_key=**未作成**（HOLD のため、まだ作らないようユーザーへ伝えた）
  - `~/.kabumori-secrets/` は未作成
- prod_readonly_status（runner `status`、2026-10-11 22:16 JST）:
  - TARGET_VERIFIED、READBACK_PASS、history_row=1
  - policies 2件が有効（month $5・40回、day $2・6回、1回 $1）
  - buckets・予約・利用記録・請求観測は 0（予算の空きは全額）
- plan_result: NOT_RUN（キーのファイルが無いため）
- live_result: NOT_RUN
- paid_provider_call_count: **0**
- ledger_before_after_delta: NOT_RUN / cost_estimate_vs_usage: NOT_RUN（上限見積もり $0.040164 は固定）/ budget_policy_gate: NOT_RUN
- temporary_supabase_key_revocation: 対象なし（未作成）
- window: NOT_ACTIVE（今回は窓を開いていない）
- changed_files: `.agent/tasks/CLAUDE_TASK_6.md`（この Report とヘッダー）、`.agent/ACTIVE_TASK.md`（G6 の部分だけ）
- tests: 本番の read-only `status` 1回だけ（runner。SELECT のみ。CLI の一時ログインロールは既知の副作用）。ソースとテストの変更は無し
- commit_hash: この Report の commit / push: main へ fast-forward / merge: not_performed / deploy: not_performed
- remaining_issues:
  1. HOLD を解除するか（ChatGPT の判断）
  2. ユーザーの準備
     - Console: 専用 workspace と月 $10 の上限、workspace 限定のキーを `anthropic.env` に保存
     - 解除後に、一時的な Supabase の secret キーを `ledger.env` に保存
  3. その後に plan → 窓 → live を1回 → 照合 → 一時キーの削除
- next_recommendation:
  - K6 で互換の根拠を評価し、HOLD を解除する（同じ TASK の続きとして G6 を ready に戻す）
  - G6 はユーザーの「準備OK」の後、gate 6〜11 を順に実行する
  - Claude の安全機能が live の実行を拒否した場合は、ユーザーが自分の端末で1回だけ実行する
---

# PRESERVED G6 PRIOR TASKS / REPORTS — immutable history below

# G6 CURRENT TASK — 共通AI基盤 Phase 1f / 本番 AI Ledger 限定適用＋試験ポリシー

- task_id: common-ai-provider-g6-phase1f-production-ledger-apply-policies-20261011
- owner: claude
- slot: claude-6
- status: done
- next_owner: none
- start_code: G6
- finish_code: K6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- priority: high
- k6_final_verdict: **PASS_FULL_APPLY_AND_POLICIES_ACCEPTED / G6 RELEASED** — 2026-10-11 JST
- chatgpt_independent_live_readback: Supabase SELECT 2026-10-11 21:55 JST: migration registry exactly 1; `ai_provider_budget_ledger_readback.sql` must_be_true **17/17 true**, budget policies **2 exact system-only enabled** (month $5/40, day $2/6, per-call $1, Anthropic Opus5.5 kabumori market_report), ledger reservation/usage/billing counts all zero. Claude report's historical before/after fingerprint and user-run CLI runner PASS accepted as user/Claude-observed evidence, not independently replayed by ChatGPT.
- completion_state: source-only TASK/INDEX/STATE updates after verification. No additional production DB write, API key setup, Claude/OpenAI paid call, Cron, Edge, or cutover by K6. Production window CLOSED; future work requires new exact authorization, fresh task and conflict check.

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
