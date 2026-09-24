# Claude Task 2

- task_id: kabumori-pr23-merge-redeploy-close-dryrun-20260924
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: H2/C2 PASS-WITH-FIX済みPR #23をfresh mainでmergeし、personalized-reportsをapp_enabled=falseのまま再deployして、大引けdry-runを複数回行い実LLM出力で修正効果を確認する。

## Accepted review state

PR #23:
- reviewed head: `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`
- H2 verdict: PASS-WITH-FIX
- production current function: v23 = known-good v21 source
- rollback source commit: `4590ba6`
- app_enabled=false

H2 fix:
- 同一文内の因果断定 + hedge tokenによるvalidator bypassを拒否
- unknown-cause許可は狭く維持
- morning brief 120 / close brief 160
- close-validator 14/14 PASS
- personalized-reports 58/58 PASS
- deno check/lint/diff PASS

## Mandatory startup

1. Independent worktree/checkout.
2. Read PROJECT_RULES.md / ORCHESTRATION.md / CURRENT_STATE.md / this TASK / H2 C2 report.
3. Fresh fetch origin/main and PR #23.
4. Verify PR head exactly `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`.
5. Confirm no overlap with G1 PR #24/legal files.
6. Read production state before mutation:
   - current personalized-reports version/source
   - verify_jwt
   - app_enabled
   - cron state
7. If app_enabled is not false, STOP.

## Step 1 — merge PR #23

If reviewed head unchanged and conflict-free:
- merge PR #23 pinned to reviewed head
- fresh fetch main
- verify merged source byte/content corresponds to reviewed head
- rerun relevant tests/checks before deploy

## Step 2 — predeploy checks

At minimum:
- close-validator tests
- personalized-reports suite
- deno check
- deno lint
- git diff --check
- confirm only personalized-reports function needs deploy
- no migration/schema required

If any fail, do not deploy.

## Step 3 — production redeploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- `app_enabled=false` throughout
- no cron change
- no DB/schema/migration
- no Auth/RLS
- no X changes
- no other Edge Function deploy

After deploy:
- read back deployed version
- confirm source matches merged main
- confirm verify_jwt=false
- confirm app_enabled=false

Keep known-good rollback source `4590ba6` immediately available.

## Step 4 — dry-run validation

Use the same safe dry-run mechanism as prior task.

Required:
- close dry-run at least 3 times
- morning dry-run at least 1 time if safely feasible

For every run record only non-sensitive summary:
- completed/failed
- draft call count
- Fact pass/fail
- local validator issues
- brief lengths if relevant
- unknown-cause/hedge behavior
- latency range
- approximate cost if available
- truncation
- notification status
- reportId/null status

Do not include user IDs, email, secret/token, or sensitive holding details in Report.

## Success criteria

Close path:
- at least 3/3 dry-runs complete through local validation
- Fact check succeeds or any failure is clearly content-semantic and investigated before proceeding
- no IMPACT_TOO_LONG for valid 104–160-char brief entries
- no false INFERENCE_NOT_HEDGED on legitimate unknown-cause wording
- no unsafe causal assertion passes local validator
- no malformed/truncated body
- no persistence
- no notification

Morning path:
- existing known-good behavior remains intact

## Immediate rollback conditions

Rollback to exact known-good source `4590ba6` if:
- repeated close local-validation failures persist
- validator allows an unsafe causal assertion
- malformed output reaches Fact stage unexpectedly
- unexpected report persistence or notification occurs
- app_enabled changes unexpectedly
- function regression affects legacy path
- deployment source/read-back mismatch

After rollback, verify byte/source match and app_enabled=false.

## Explicit gate rule

Do NOT set `app_enabled=true` in this TASK even if all dry-runs pass.

Successful completion only means:
- merged source accepted
- deployed safely
- dry-run behavior validated

Gate activation is a separate ChatGPT decision/task.

## Completion / K2

Report:
- fresh main before merge
- reviewed PR head
- merge SHA
- post-merge test counts
- deployed version
- deploy source read-back
- app_enabled before/after=false
- close dry-run results (>=3)
- morning result if run
- Fact/local validator results
- latency/cost/output observations
- push/persistence safety
- rollback status
- production mutations
- whether activation can be considered next
- remaining real-device QA

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-pr23-merge-redeploy-close-dryrun-20260924`
- result：**PR #23はmerge、v24はdeploy済み。ただし大引けdry_runが3回中2回、ローカル検証で失敗したため、TASKの即時ロールバック条件に従い、v21のsourceへ再度ロールバックした**（productionはv25 = v21）。
  - 失敗は、H2で絞り込んだ「要因は特定できない」文の許可パターンの形が狭すぎたため（詳細は下記）。
  - `app_enabled=false` を維持している。
- changed_files：なし（PR #23のmergeだけ。本TASKでの追加source変更はない）
- tests：merge後 **176 passed / 0 failed**（close_validator 14/14、personalized-reports 58/58）。deno check・lint・diff checkはPASS。
- commit_hash：merge `5df9512b43c885fff28b625d089eda249320b3c3`（reviewed head `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`）
- push：mergeのみ（PR #23はMERGED）。
- deploy：
  - v24 = merged main `5df9512`
  - その後v25 = rollback（source `4590ba6`）
- remaining_issues / next_recommendation：下記を参照。
- safety_checks：
  - DB/schema・cron・Auth・X・`app_enabled` の変更は0件。
  - 秘密情報・user_id・銘柄の詳細は本Reportに記載していない。
  - 共有ファイルは未変更。

### 詳細

- **fresh main before merge**：`c0230d8`（mergeの時点では `5383c46`。1回目は「Base branch was modified」となり、確認のうえ再試行した）
- **reviewed PR head**：`47d8c78`（着手時に一致を確認。conflictなし。PR #24（G1）とのファイル重複なし）
- **merge SHA**：`5df9512`。mergeされた関数のsourceは、reviewed headと差分なし。
- **pre-deploy production**：
  - v23（`--use-api` でdownloadし、v21とbyte一致）、verify_jwt=false、`app_enabled=false`、cronは不変。
  - 補足：Docker起動中は `functions download` がtranspile後のコードを返すため、byte検証には `--use-api` を使った。
- **post-merge tests**：176/176（close_validator 14、personalized-reports 58）。
  - mainに追加されていたmigration 2本はX auto-postのもので、本関数とは無関係（deployではmigrationを適用しない）。
- **deployed version**：v24（`--use-api`、`--no-verify-jwt`）。
  - read-back：4ファイル（index / report_logic / market_detail / _shared/market_report_packet）が `5df9512` とbyte一致。
  - verify_jwt=false。
- **app_enabled**：deploy前・deploy後・rollback後のいずれも **false**。
- **dry-run**（cronと同じVault→`net.http_post` 方式、`dry_run:true`）：

| 実行 | 結果 | LLM呼び出し | Fact | local issue | 詳しい枠の3欄合計 | 簡潔な枠の合計 | 推定欄 | 観測時間 | 費用 |
|---|---|---|---|---|---|---|---|---|---|
| 大引け1 | failed | 1 | 未到達 | INFERENCE_NOT_HEDGED | 128 | 89 | 「下落の要因は特定できません。」 | ≤21s | $0.00088 |
| 大引け2 | failed | 1 | 未到達 | INFERENCE_NOT_HEDGED | 131 | 89 | 「当日の下落要因は特定できません。」 | ≤20s | $0.00093 |
| 大引け3 | **completed** | 2 | **passed** | 0 | 169 | 88 | 「要因は特定できません。」 | ≤26s | $0.00133 |
| 朝刊 | **completed** | 2 | **passed** | 0 | — | 57 / 57 | なし | ≤19s | $0.00109 |

- **改善を確認できた点**
  - 前回の原因1（`IMPACT_TOO_LONG`）は解消した。簡潔な枠は88〜89字で、上限160字以内。
  - 推定欄がそのまま「要因は特定できません。」の形なら、合格してFactも通過した。
  - 断定的な因果を書いた推定文は、実出力には現れなかった。
  - 出力の打ち切り（truncation）や形式の崩れはなかった。
- **残った原因**：H2の強化（`UNDETERMINED_ONLY` を文全体の一致に変更）で、許可されるのは「(入力情報から)(明確な)(個別)要因は特定できません」の形だけになった。実際のモデル出力は「**下落の**要因は…」「**当日の下落**要因は…」のように主語の前置きを付けることが多く、同じ意味の妥当な文を誤って拒否している（今回2/3）。
- **push / 保存の安全性**：
  - dry_runの応答は全件 `notification: not_attempted`・`reportId: null`。
  - read-onlyの確認でも、再deploy以降の `personalized_reports` の作成・更新は0件、`personalized_report` の通知は0件。
- **rollback status**：実施済み。
  - v25 = `4590ba6` の source（`--use-api` でdownloadし、index / report_logicがv21とbyte一致）。
  - verify_jwt=false、`app_enabled=false`、cron不変。
  - 翌営業日のcron（朝刊08:35、大引け17:15）は、従来のv21の動作で実行される。
- **production mutations**：
  - Edge Functionのdeploy 2回（v24、v25＝rollback）
  - dry_runの呼び出し 4回（保存・通知は0件）
  - GitHubでのPR #23のmerge
  - これ以外は0件
- **activationを検討できるか**：**まだ検討できない**。大引けのローカル検証を実出力で安定して通過させることが先に必要。
- **推奨する次の修正（小さく、狭いまま）**
  - `UNDETERMINED_ONLY` の先頭に、任意の主語句 `(?:当日の)?(?:下落|上昇|値動き|変動)(?:の)?` を許可する。例：「下落の要因は特定できません」「当日の下落要因は特定できません」「値動きの理由は判断できません」。
  - 文全体の一致と因果断定の拒否（CAUSAL_ASSERTION）は維持する。
  - 今回の実出力2文をfixture化して回帰テストにする。
  - そのうえで、再deploy→大引けdry_runを3回以上→全件の通過を確認する。
- **remaining real-device QA**：新形式のレポートはまだ本番で生成・保存されていないため未実施。上記の修正が通った後に、朝刊・大引けの「保有株への影響」の表示と旧形式との表示互換を確認する。
