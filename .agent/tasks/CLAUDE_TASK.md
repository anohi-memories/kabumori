# Claude Task 2

- task_id: kabumori-personalized-reports-prod-deploy-dryrun-20260924
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: PR #19でmain反映済みのpersonalized-reports新実装を、market_report_consumer_settings.app_enabled=falseを維持したままproductionへ安全にdeployし、dry-run/実LLM検証で品質・Fact合格率・出力量・費用・表示互換を確認する。gate ONはこのTASKでは禁止。

## User authorization

User explicitly approved proceeding with the next rollout stage.

Authorized in this TASK:
- production Edge Function deploy of `personalized-reports`
- read-only production verification
- controlled dry-run / test invocation needed to validate the deployed function
- observation of generated output/cost/timing/safety signals, only in ways that do not enqueue or deliver unintended notifications

Not authorized:
- `market_report_consumer_settings.app_enabled=true`
- production cron schedule changes
- DB/schema/migration changes
- push notification delivery changes
- broad user-cohort expansion
- Auth/RLS changes
- X posting changes

## Accepted source state

PR #19 is merged:
- merged head: `2b743f3a9799f35409ab1e61652b9e76b04977c5`
- merge/main SHA: `518542702f820e490d0c02050b0ef470f023ce5a`
- final K2: PASS
- post-merge tests: 154/154 PASS
- deno check/lint PASS
- no new src TypeScript errors
- Expo export 10 routes PASS
- H2 privacy/user-boundary review: PASS-WITH-FIX
- production deploy has not yet occurred

## Product/cohort boundary

- Scheduled cohort remains users with active `tracked_stocks` rows.
- Watch-only users may receive a market-only report.
- Users with zero active tracked stocks are out of scope.
- Do not infer eligibility from profiles/alert settings.

## Mandatory startup

1. Use independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK, G2 Final K2, H2/C2 PR #19 report.
3. Fresh fetch origin/main.
4. Confirm `personalized-reports` source on main contains merge `5185427` and H2 missing-value fix.
5. Confirm no overlap with G1/PR #21 review work.
6. Read current production function/settings before mutation:
   - deployed `personalized-reports` version/config if inspectable
   - `market_report_consumer_settings.app_enabled`
   - relevant cron state
   - current required secrets/env presence without exposing plaintext values
7. If `app_enabled` is not false, STOP immediately and report. Do not deploy into an unexpectedly enabled lane.

## Pre-deploy gate

Before deploy:
- rerun focused personalized-reports tests
- deno check/lint
- git diff --check
- verify deploy target/project
- verify no migration/schema change required
- verify no source drift from reviewed main

If any check fails, do not deploy.

## Production deploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- no other function deploy
- no migration
- no cron change
- no settings update
- no `app_enabled` change
- capture deployed version/identifier if available
- immediately read back deployment status

## Dry-run / validation

After successful deploy, with `app_enabled=false` still confirmed:

1. Use the safest existing dry-run path or direct controlled invocation supported by the function.
2. Prevent unintended push delivery:
   - use existing dry_run/skip-notify mechanism if present
   - if no safe dry-run path exists, STOP before any invocation that could send user-visible output/push.
3. Validate at least:
   - morning path
   - close path if safely invocable with available data
   - one real eligible user if privacy-safe and already authorized by normal app semantics
   - watch-only/no-holdings behavior if safely testable without cohort mutation
4. Record:
   - generation success/failure
   - Fact pass/fail
   - local validation failures
   - token/output size if available
   - latency
   - any provider/API cost indicators available from source/response/logs
   - saved body structure
   - market detail presence/absence under gate OFF
   - holding impacts
   - morning-to-close comparison availability
5. Do not display or copy secrets, auth tokens, emails, user IDs, or sensitive portfolio details into TASK/Report. Summarize only.

## Quality gates

Stop and report without enabling `app_enabled` if any:
- cross-user anomaly
- unsupported causal claim that local/Fact validation allows
- repeated Fact failure
- malformed body
- push unexpectedly sent
- output truncation
- cost/latency materially outside reasonable expectations
- deployed function fails normal legacy path
- shared packet dependency behaves unexpectedly
- blocked shared packet causes non-fail-closed behavior

## Explicit gate rule

`app_enabled` MUST remain false throughout this TASK.

Even if dry-run is perfect:
- do not enable it
- recommend whether it is safe to enable in the Report
- wait for K2 / ChatGPT decision for a separate gate-activation task

## Rollback

If deploy causes a concrete regression and a previously deployed known-good version is available:
- rollback only if the deployment mechanism and exact prior version are confidently known
- otherwise stop and report rather than improvising
- never change DB/schema to compensate

## Required checks after deploy

- function deployed/read-back confirmed
- `app_enabled=false` confirmed after deploy
- no cron changes
- no DB/schema changes
- no X/shared fact mutation
- dry-run evidence recorded
- production logs inspected only as needed and without leaking secrets
- git status clean / no unrelated local edits

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- Report must include:
  1. fresh main SHA
  2. pre-deploy production state
  3. exact deployed function/version
  4. deploy result
  5. dry-run method
  6. morning/close validation result
  7. Fact/local-validation result
  8. latency/output/cost observations
  9. push-safety result
  10. app_enabled read-back = false
  11. production mutations performed
  12. rollback status if any
  13. whether a separate app_enabled activation task is recommended
  14. remaining real-device QA needs
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-personalized-reports-prod-deploy-dryrun-20260924`（継続指示「v22 rollback + close-report validator fix」を含む）
- result：
  - v22のdeploy後、dry_runで大引けが3回中3回、ローカル検証で失敗した。
  - productionは**v21のsourceへロールバック済み**（v23として配置）。
  - validatorの修正PR #23を作成した（**未merge・未deploy**）。
  - `app_enabled=false` を維持している。K2待ち。
- changed_files（PR #23）：`supabase/functions/personalized-reports/report_logic.ts`、`report_upgrade_test.ts`（上限変更に合わせて1か所調整）、`close_validator_fix_test.ts`（新規）
- tests：**167 passed / 0 failed**（従来154件＋新規13件）。deno check・deno lint・git diff --checkはPASS。
- commit_hash：PR #23のhead `5c22c71`
- push：`origin/g2-close-report-validator-fix-20260924`。PR https://github.com/anohi-memories/kabumori/pull/23
- deploy：
  - deployは合計2回、いずれも `personalized-reports` のみ。
  - (1) v22：main `87c1866` 由来のPR #19実装
  - (2) v23：ロールバック。source `4590ba6`（= v21）
- remaining_issues / next_recommendation：下記12と13を参照。
- safety_checks：
  - DB/schema/migration・cron・Auth/RLS・X・`app_enabled` の変更は0件。
  - 秘密情報・user_id・銘柄の詳細は本Reportに記載していない。
  - `ACTIVE_TASK` などの共有ファイルは未変更。

### 1. fresh main SHA

- deploy元：`87c1866`（PR #19のmerge `5185427` とH2修正を含む）
- 修正PRのbase：`25e1d89`

### 2. pre-deploy production state（read-only）

- `personalized-reports`：v21、verify_jwt=false。source はcommit `4590ba6` とbyte一致（`b83d73a` とも同一）。モデルはgpt-5.6-luna、共有分析には未対応。
- `app_enabled=false`、`x_enabled=false`（updated_atは2026-09-17のまま）。
- cron：`personalized-reports-morning`（`35 23 * * 0-4`）、`personalized-reports-close`（`15 8 * * 1-5`）。どちらもactiveでdry_runの指定なし。
- 必要なsecretは名前だけ確認し、4つとも存在した（値は読んでいない）。
- 共有packet：当日の朝刊・大引けともcompleted。対象ユーザーは1人。
- PR #21（G1）の変更ファイルとの重なりはない。

### 3. exact deployed function/version

- rollback前：**v22**（PR #19の実装）
  - 4ファイルをmain `87c1866` とbyte比較して一致：index.ts、report_logic.ts、market_detail.ts、_shared/market_report_packet.ts
  - verify_jwt=false
- rollback後：**v23 = v21のsource（commit `4590ba6`）**
  - downloadしたindex.ts・report_logic.tsが、v21のバックアップとbyte一致
  - verify_jwt=false
- 継続指示にあったcommit `4600ba6` は、私の直前の報告の誤記。正しくは **`4590ba6`**（rollbackもこのcommitで実施）。

### 4. deploy result

- v22、v23ともdeployは成功し、ACTIVE。
- 2回とも、専用worktreeに `supabase/config.toml`（personalized-reportsは `verify_jwt=false`）とlinkファイルを置き、`--no-verify-jwt` を付けてdeployした。共有checkoutのsourceが誤って配布されるのを防ぐため。

### 5. dry-run method

- cronと同じ方式で呼び出した：DB内でVaultからsecretを読み、`net.http_post` で `personalized-reports` を呼ぶ。secretの値はDBの外に出ていない。
- bodyは `{"mode":"morning"|"close","dry_run":true}`。
- dry_runでは、claimのinsert・結果のpatch・通知のenqueueがいずれもsource上で実行されない（`!dryRun` のガード）。
- 実行回数：朝刊1回、大引け3回。

### 6. morning / close validation result

- **朝刊（1回）**
  - completed、LLM呼び出し2回、Fact passed、local issue 0件
  - holding_impactsは2件（どちらもno_clear_material、brief）
  - 市場詳細：gate OFFのため無し（想定どおり）
- **大引け（3回）**
  - 3回とも `REPORT_LOCAL_CHECK_FAILED`（LLM呼び出し1回でFactまで到達せず）
  - 1回目：`INFERENCE_NOT_HEDGED`
  - 2回目・3回目：`IMPACT_TOO_LONG`（brief枠が104〜136字）
  - 朝→大引けの比較：当日の朝刊が旧形式のため、「比較なし（not_comparable）」になった（想定どおり）
- **原因（root cause）**
  1. briefの上限（3欄合計100字）が大引けには短すぎた。大引けは値動き・1306との差・材料の有無を載せる必要がある。
  2. 推定欄のhedge必須チェックが、「要因は特定できない」ことを述べるだけの妥当な文まで拒否していた。
- いずれもfail-closedで、誤った内容が保存・通知される状態ではなかった。ただし、翌日以降の大引けが毎日生成されなくなるおそれがあったため、ロールバックした。

### 7. Fact / local-validation result and fix（PR #23）

- **文字数上限**：朝刊brief **120字**（dry_runの最大67字、短さを維持）、大引けbrief **160字**（実測104〜136字に対して約18%の余裕）。「詳しく」枠（160＋160＋80）よりは十分短い。
- **hedgeの判定**：推定欄の**文ごとに**、次のどちらかであることを必須にした。
  - (a) hedge表現を含む
  - (b) 狭い「特定できない」文：
    - 不明な対象（要因・原因・理由・材料・因果関係・影響・背景）を明示している
    - 文末が「特定・判断・断定・確認・説明・結び付けること」＋「できません／できていません」などで終わる
    - 因果の断定（「逆風になりました」「原因です」「で売られました」「を受けて下落し」など）を含まない
- 次の文は引き続き不合格：「円高が逆風になりました」「半導体安が下落の原因です」「金利上昇で売られました」、断定の文に「特定できない」を付け足したもの。

### 8. latency / output / cost observations

- 費用（response値）：朝刊 約 **$0.00098**、大引け 約 $0.0007〜0.0008（ローカルで失敗したため1回分）。
- 出力量：朝刊のタイトル20字・要約85字・総括189字。打ち切り（truncation）はない。
- 所要時間：個別には計測できていない。いずれも発行後、最初のpoll（約15秒以内）で応答があり、timeoutもなかった。

### 9. push-safety result

- dry_runの応答は、全件 `notification: not_attempted`・`reportId: null`。
- read-onlyの確認：deploy以降の `personalized_reports` の作成・更新は**0件**、`personalized_report` の通知は**0件**。当日の既存2件（v1 lane）は変わっていない。

### 10. app_enabled read-back

- deploy前・deploy後・rollback後のいずれも **false**（x_enabledもfalse、updated_atは2026-09-17のまま）。

### 11. production mutations performed

- Edge Functionのdeploy 2回：v22、およびv23（v21のsourceへのロールバック）。
- dry_run呼び出し 4回（`net.http_post`）。保存・通知は0件。
- 上記以外（cron・DB・schema・settings・Auth・X）は0件。

### 12. rollback status / remaining risks

- **rollback：完了**。productionはv23 = v21のsource（byte一致）で、cronは従来の動作に戻っている。
- 残るリスク：
  - PR #23は、実LLMの出力ではまだ検証していない（再deploy後のdry_runで確認が必要）。
  - 推定欄の文ごとのチェックは以前より厳しくなった面がある（背景事実を1文混ぜると不合格）。プロンプトでも誘導しているが、実出力での合格率は要確認。
  - モデル切替（gpt-5.6→gpt-6-luna）も再deployで入る。

### 13. next recommendation

1. PR #23をK2で確認し、必要ならCodexの軽量レビューを入れる。
2. merge後に `personalized-reports` を再deployし、**大引けのdry_runを複数回**（例：3回以上）実施して、local・Factの合格を確認する。失敗すれば、同じ手順でv21へ即ロールバックする。
3. 数日運用して安定したら、`app_enabled` のON判断を別TASKで行う（本TASKではONにしない）。

### 14. remaining real-device QA

- 新形式のレポートがまだ本番で生成されていないため、実機での確認は未実施。
- 再deploy後に確認が必要な項目：
  - 朝刊・大引けの「保有株への影響」カード
  - stanceバッジ
  - 答え合わせ行（新形式の朝刊ができた翌日の大引けから）
  - 旧形式のレポートの表示互換
