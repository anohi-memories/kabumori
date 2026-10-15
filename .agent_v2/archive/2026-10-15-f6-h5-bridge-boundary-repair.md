# F6 — H5 Claude consumer bridge M2 連携境界の修正・安全検証

- task_id: common-ai-f6-h5-consumer-bridge-import-boundary-repair-20261014
- slot: F6
- owner: claude
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- previous_archive: .agent_v2/archive/2026-10-14-f6-anthropic-multimodel-m1.md
- scope: source-only / no production mutations

## Goal
H5のClaude利用側ブリッジをF6共通プロバイダーの安全境界に統合可能な状態へ修正する。F6 Draft PR #187 HEAD `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b` とH5 Draft PR #198 HEAD `4223d5c01389474406291c8e4578207e317638b9` を保護し、現在のOpus市況レポート本番へ影響させない。

## Current blockers
- C5: H5自身のmock/offline tests 27 PASS、F6 baseline 19 PASSだが両者の合成は16 PASS / 3 FAIL（厳格なimport allowlist、deployable reachability、widening mutation checks）。
- H5 PR198 is stacked on F6 PR187. H5の権限境界・budget idempotency・SDK任意環境変数参照には検討事項が残る。
- Separate bookkeeping Draft PR #199 still unmerged; ChatGPT has recorded C5 done directly to old H5 TASK/Report/ACTIVE_TASK. Do not merge #199 without reconciling conflicts.
- F6 TASK marked done, F6 ACTIVE_TASK was stale review_required: update F6 ACTIVE_TASK now for this new task only after confirming no concurrent write.
- Legacy G6 tasks and other existing PRs may touch `_shared/ai_provider`; safeguard cross-slot changes.

## Execution
1. Read `PROJECT_RULES.md`, `.agent_v2/ORCHESTRATION.md`, fresh main, new+old ACTIVE_TASK/CURRENT_STATE, PRs #187/#198/#199 and original Codex C5 evidence. Independently verify H5 completed, no unprocessed C5, exact PR HEADs, file ownership, worktree/checkout and cross-slot write conflicts.
2. Use separate clean F6 worktree. Compose PR187+PR198 offline. Inspect exact 3 failing assertions, import graph/reachability and mutations. **Do not weaken an isolation test just to turn it green.** Determine least-privilege import list and safe code boundaries. F6-owned `_shared/ai_provider/` may be changed by F6 only; H5-owned `_shared/ai_consumer_bridge/` must not be edited without separate H5 handoff.
3. Investigate SDK optional environment variable reads. Propose safe containment/constructor settings without reading real secrets or relying on production variables. When safely possible implement F6-owned narrow fixes or new F6 tests, including both old and new import boundary cases. Preserve denial of unapproved feature/tenant/model, budget spend, and side effects.
4. Run all relevant offline tests with denied network: F6 provider/model_policy/isolation, H5 bridge, market-report-analysis (324 baseline), `_shared`, type/lint/diff checks; test failure and refusal branches, mutation tests and key-exposure checks. No AI API paid calls.
5. Produce scoped F6-only new Draft PR stacked on exact parent (PR198 if needed) with explicit dependency order #187 → #198 → F6 repair PR. Never modify H5 PR198 or prior F6 PR187 branches. If H5 code must be changed, BLOCK and provide exact H5 follow-up instructions.
6. Report changed_files, tests counts, regression proof, head/base/commit, mergeability with fresh main, remaining security blockers, downstream budget/tenant/feature dependencies. Mark F6 review_required and return L6. Reviewer: Codex **Sol（高）** for tenant auth/budget/security if changed; the same H5 implementer must not independently approve its own source.

## No-go
- Do not merge PR187/198/199, change DB/RLS/RPC/Edge/Cron/Secrets/consumer flags, deploy, create Auth users, invoke paid Anthropic, alter live X/app, or change another slot's branch/worktree.
- F2 owns report/forecast and delivery, F8 owns news, F9 optimization, F1 AI question, POSTONA other G/F slots. This TASK does not turn any feature ON.

## Completion conditions
- F6/H5 integration issue diagnosed with exact test evidence; all 3 regressions genuinely fixed or separately BLOCKED with owner and minimal patch instructions.
- Opus primary_both remains unchanged, security constraints not weakened. Return `L6` to **共通AI基盤のちゃ（OpenAI・Claude API専用チャット）**.

## Report
- l6_verdict: PASS_OFFLINE_SOURCE / SECURITY_REVIEW_REQUIRED / MERGE_HOLD / PRODUCTION_NO_GO. PR205 head confirmed and stacked PR187→PR198→PR205. Integration regressions resolved; header authentication containment requires independent Sol（高） review.
- task_id: common-ai-f6-h5-consumer-bridge-import-boundary-repair-20261014
- result: **PASS_OFFLINE_SOURCE**。3件の失敗は直した。テストは緩めず、確認は強めた。SDK の環境変数の穴も塞いだ。H5 のコードの変更は不要
- branch / commit / PR
  - `claude/f6-h5-bridge-boundary-20261015` @ `4cd2cbdd51a68bc537cd0fc81dc8f1c7ee059f21`
  - Draft PR [#205](https://github.com/anohi-memories/kabumori/pull/205)。base は #198 の branch `codex/h5-claude-consumer-m2-20261014`
  - 依存の順番: **#187 → #198 → #205**
  - 新しい worktree `/Users/yuya/Developer/kabumori-f6-bridge-boundary`
  - 最新の main（`19de65fd`）と `merge-tree` で衝突なし
- protected: #187 `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b` と #198 `4223d5c01389474406291c8e4578207e317638b9` は変更していない（push 後に `ls-remote` で確認）
  - #199（記録用）にも、H5 の `_shared/ai_consumer_bridge/` にも、H5 の TASK にも触れていない
  - 開いている PR で `_shared/ai_provider/` に触れているのは、F6 の #187・#150・#157・#162 だけ
- changed_files（F6 所有だけ。+325 / -14）
  - `supabase/functions/_shared/ai_provider/isolation_test.ts`
  - `supabase/functions/_shared/ai_provider/anthropic_adapter.ts`
  - `supabase/functions/_shared/ai_provider/anthropic_env_containment_test.ts`（新規）
  - `docs/ai-provider/F6_H5_BRIDGE_BOUNDARY.md`（新規）

### 3件の失敗の原因と直し方

- 再現: #187 と #198 を合わせた状態で、F6 の `isolation_test.ts` の3件が失敗した
  - 参照してよいファイルの一覧: ブリッジの 5 ファイルが `../ai_provider/mod.ts` / `test_support.ts` を参照していた
  - deploy 対象で届いてよいファイルの一覧: `bridge.ts` と `types.ts` が届いていた
  - 広げる方向の変更をすべて拒否する確認: 上の2つと同じ一覧を前提にしていた
- 直し方
  - 許可したのは、実際の参照ちょうど（ファイルと参照先）だけ
    - runtime: `bridge.ts` → `mod.ts`、`types.ts` → `mod.ts`
    - テスト: `bridge_test.ts` → `test_support.ts`、H5 の `isolation_test.ts` → `mod.ts`、`offline_samples_test.ts` → `mod.ts` と `test_support.ts`
  - 届いてよいファイルに、ライブラリの `bridge.ts` と `types.ts` を足した
- **新しい確認（強化）**
  1. `AUTHORIZED_MOD_IMPORTS`: `mod.ts` を import する deploy 対象のファイルは、決めた名前しか取れない
     - `bridge.ts` は 13 個、`types.ts` は 4 個（今の import ちょうど）
     - 名前空間の import、`export *`、`SupabaseLedgerBudgetGuard`、`InMemoryBudgetGuard`、`resolveProviderApiKey`、`resolveSecret`、`SecretValue`、決まりを通らない `executeAiRequest` は、どれも失敗する
     - 別名を付けた import も、元の名前で数える
  2. `AUTHORIZED_ENTRY_POINTS`: provider に届いてよい Edge 関数の入口は、今も `market-report-analysis/index.ts` だけ
     - 関数がブリッジを読み込むと失敗する。つなぐときは F6 が許可を足す
- 拒否の確認に足した例: ブリッジの名前の追加 6種類、`ledger_guard.ts` の直接参照、許可のない新しいファイル・テスト、X の関数や別の関数の入口からの読み込み
  - 古い境界（市況レポートの handler）の確認は、そのまま残した

### SDK が読む任意の環境変数（`@anthropic-ai/sdk@0.132.1`、`src/client.ts` を読み、オフラインで実験した）

- 修正前、F6 の adapter で SDK が読んでいた環境変数は `ANTHROPIC_CUSTOM_HEADERS` と `ANTHROPIC_WEBHOOK_SIGNING_KEY`
- **`ANTHROPIC_CUSTOM_HEADERS` に値があると、`x-api-key` が別のキーに置き換わり、`Authorization` や任意のヘッダー、`anthropic-version` の変更も送られた**（偽の通信先で再現）
- 本番の Edge Secret に、この変数は無い（10/13 に名前で確認）。実害は無い
- 修正
  - `webhookKey: null` を渡す。`ANTHROPIC_WEBHOOK_SIGNING_KEY` を読まなくなる
  - SDK に渡す fetch は、SDK が普段送るヘッダー（`accept`、`anthropic-version`、`content-type`、`user-agent`、`x-api-key`、`x-stainless-*`）だけを通す
  - `x-api-key`・`anthropic-version`（`2023-06-01`）・`accept`・`content-type` は、adapter 自身の値に固定し直す
  - `ANTHROPIC_CUSTOM_HEADERS` の読み取り自体は SDK の作りで止められない。値はもう外に出ない（`user-agent` と `x-stainless-*` だけは残るが、送り先は固定の Anthropic）
  - 変数が無いときの送信ヘッダーは、今までと同じ（テストで確認）

### tests（実通信・鍵・本番 0。deno 2.9.6、macOS arm64）

| 範囲 | 結果 |
|---|---|
| `isolation_test` | 9/9 |
| `anthropic_env_containment_test` | 4/4（新規） |
| `anthropic_adapter_test` | 8/8 |
| H5 の `offline_run.sh` | 27/27 |
| H5 の `offline_samples_test` | 2/2（環境変数は `ANTHROPIC_CUSTOM_HEADERS` だけを許した状態で PASS。WEBHOOK を読まなくなったことの確認） |
| provider | 126（121 + 新しい 5） |
| market-report-analysis | **324** |
| `_shared` | 658（ブリッジの 29 を含む） |

- 通信禁止と、鍵・base URL・auth token・webhook・モードなど10個の環境変数の読み取り禁止で、関係 6 ファイル: 86/86
- mutation 8/8 検出（`webhookKey`、ヘッダーの絞り込み、キーの固定、バージョンの固定、守りの接続、再エクスポートの検出、関数の入口の確認、名前空間の import）
- `deno check`、`deno lint`（33 ファイル）、`git diff --check`、秘密情報スキャン 0

### そのほか

- 本番の Opus（`primary_both`）
  - 中身は変わらない（同じ要求、同じヘッダー）
  - 本番に効くのは、別に承認された deploy のときだけ
  - 今回、本番・台帳・Secret・Cron・Edge・配信の設定は変更していない
- H5 への申し送り（必須ではない。docs §3）
  - `offline_run.sh` の `--allow-env` から `ANTHROPIC_WEBHOOK_SIGNING_KEY` を外せる
  - ブリッジの中の `deno.json` / `deno.lock` と、つなぐ関数側の設定の整合
  - 認可（`deps.authorize`）は、つなぐ担当が設計して検証する
  - `operationId` の決め方で、二重課金の防止と、繰り返しの拒否が決まる
- remaining security / review
  - H5 のテナントの認可・予算の境界は、H5 の設計。この PR では変えていない
  - レビューは、H5 の実装者とは別の **Codex Sol（高）** を推奨
    - 対象: F6 の adapter のヘッダーの守り（出ていく認証ヘッダーに関わる）と、ブリッジの認可・予算
- downstream（どれも別の TASK・別の承認）
  - 関数がブリッジを使い始めるとき: F6 の許可リスト 4 種の追加
  - 台帳の機能・モデル・主体ごとの枠（本番の DB）
  - 機能ごとの評価と、OFF に戻す手順
- merge 0、deploy 0、production 0、paid_calls 0。Secret・`.env`・鍵の値は読んでいない
