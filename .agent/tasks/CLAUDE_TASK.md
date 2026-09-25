# Claude Task 2

- task_id: kabumori-pr29-merge-redeploy-final-dryrun-20260925
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: C2 PASS-WITH-FIX済みPR #29をfresh mainでmergeし、personalized-reportsのみcontrolled redeployして、app_enabled=falseのまま大引け/朝刊dry-runで実出力を最終確認する。

## Accepted review state

Already on main / production:
- validator commit: `510acf5954b37410b50c23ff92c3f54af6458a72`
- H2 verdict for this validator change: PASS
- production before this task: personalized-reports v27
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- cron unchanged

PR #29:
- final reviewed head: `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`
- H2 verdict: PASS-WITH-FIX
- H2 fix: morning wording rule now explicitly covers user-visible `watch_notes[*].note_ja`
- tests at H2:
  - focused hardening + close-validator 32/32
  - personalized-reports 96/96
  - deno check/lint/diff PASS
- PR remains open/unmerged at task creation.

## Mandatory startup

1. Use an independent worktree / checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / latest H2 report.
3. Fresh fetch origin/main and PR #29.
4. Verify PR #29 head is exactly `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`.
5. Confirm no active workstream edits personalized-reports or deploys the same function.
6. Read production before mutation.
7. If app_enabled != false, STOP.
8. If production source/version changed after this assignment, STOP and report before overwriting.

## Step 1 — merge

If reviewed head is unchanged and conflict-free:
- merge PR #29
- fresh fetch main
- verify merged source contains H2-reviewed content exactly
- record merge SHA

## Step 2 — post-merge verification

Run:
- report_hardening tests
- close_validator tests
- full personalized-reports suite
- MIC/report integration tests
- deno check
- deno lint
- git diff --check

Confirm:
- validator boundary unchanged
- Fact checker not loosened
- morning/close brief limits still 120/160
- MIC context integration remains intact

## Step 3 — controlled deploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- verify_jwt=false
- app_enabled=false throughout
- x_enabled=false unchanged
- no cron change
- no DB/schema/migration
- no Auth/RLS
- no X changes
- no other Edge Function deploy

After deploy:
- read back deployed source/version
- verify deployed source matches merged main for personalized-reports
- verify app_enabled=false
- verify x_enabled=false
- verify cron unchanged

## Step 4 — dry-run

Required:
- close: **minimum 5 runs**
- morning: **minimum 2 runs**

For each run record non-sensitive summary:
- completed / failed
- LLM call count
- Fact pass/fail
- local validator issues
- inference wording class
- morning wording class
- brief length if relevant
- latency
- approximate cost if available
- truncation/malformed output
- MIC context present/absent if observable
- reportId/null
- notification status

Do not include user IDs, email, tokens, or holding details.

## Acceptance

Close:
- at least 5/5 required runs complete
- no false INFERENCE_NOT_HEDGED for legitimate unknown-cause wording
- no factual lead clause regression in inference_ja
- no unsafe causal assertion passes
- no IMPACT_TOO_LONG for valid output
- Fact/local checks pass
- no malformed/truncated output

Morning:
- at least 2/2 required runs complete
- no repeat of advisory-sounding false positive caused by 見守る/注意が必要/影響しやすい wording
- Fact/local checks pass
- no malformed/truncated output

Safety:
- no persistence
- no notification
- app_enabled=false
- x_enabled=false

## Failure / rollback

If a source regression, unsafe causal pass, repeated legitimate false reject, malformed output, unexpected persistence/notification, or deployed-source mismatch occurs:
- stop further rollout
- preserve evidence
- rollback only if required to restore known-safe production behavior
- never turn app_enabled on

If only one LLM stochastic failure occurs:
- classify cause before rollback; repeat within the allowed dry-run count if safe.
- do not hide repeated failures.

## Explicit gate

**Do NOT set app_enabled=true in this task.**

Even a full PASS only authorizes the next activation decision.

## Voice-policy follow-up

The completed audit `kabumori-voice-gate-product-policy-audit-20260925` was K2-accepted.
After this PR #29 stabilization task is accepted, next G2 should implement:
- delivery policy Phase 1
- shadow PASS/WARN/BLOCK classification + telemetry only
- no behavior change initially
Recommended implementation model for that follow-up: Opus5.5（高）
Recommended review: Codex Sol（高）

## Completion / K2

Report:
- fresh main before merge
- PR final head
- merge SHA
- tests
- deployed version
- deployed source read-back
- app_enabled/x_enabled before/after
- close 5-run results
- morning 2-run results
- Fact/local safety
- persistence/notification safety
- rollback status
- production mutations
- whether activation can be considered
- whether Voice-policy Phase 1 can start

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-pr29-merge-redeploy-final-dryrun-20260925`
- result：
  - PR #29をmergeし、`personalized-reports` を**v28**としてdeployした（ユーザー承認のうえ）。
  - dry_runの結果：**大引けは5/5がPASS（Fact・localとも）**、**朝刊は0/2（2回ともFact FAIL。理由は前回と別）**。
  - rollbackは行わず、**productionはv28のまま**（理由は下記）。`app_enabled=false`、`x_enabled=false`。
- changed_files：なし（PR #29のmergeだけ）
- tests：merge後に次がすべてPASS。
  - report_hardening 9/9、close_validator 23/23、mic_market_context 14/14、mic_market_integration 6/6
  - personalized-reports 96/96、関連スイート 214/214
  - deno check・lint・diff check
- commit_hash：merge `47ea87d33734fbd9e8489f2112c732cb0b2ca11f`（PR final head `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`）
- push：mergeのみ
- deploy：`personalized-reports` v28（source `47ea87d`、`--use-api --no-verify-jwt`）
- safety_checks：
  - deploy以降、`personalized_reports` の作成・更新は0件、`personalized_report` の通知は0件。
  - dry_runは全件 `notification: not_attempted`・`reportId: null`。
  - cronは不変。
  - 秘密情報・user_id・銘柄の詳細は本Reportに記載していない。

### 詳細

- **fresh main before merge**：`4ae9e20`。PR head `ef96037` が一致し、conflictもなかった。mainに `510acf5` 以降の関数の変更はなかった。
- **pre-deploy production**：v27（updated_atは割り当て時点から不変）。`app_enabled=false`、`x_enabled=false`。
- **本日17:15の自然cron（v27）**：大引けは `REPORT_LOCAL_CHECK_FAILED`（`INFERENCE_NOT_HEDGED` ×2）で、**生成されなかった**（fail-closedのため、保存・通知なし）。
  - deployは、このcronの完了を確認してから（17:15:44）実施した。
- **merge後の確認**：
  - mergeされたsourceは、reviewed headと差分なし。
  - brief上限は120／160、`UNDETERMINED_MOVE_PREFIX` は `510acf5` のまま。
  - validatorの正規表現・`CAUSAL_ASSERTION`・`HEDGE`・`REPORT_FACT_INSTRUCTIONS` の変更は0件。
  - MICのテストはPASS。
- **deployed version / read-back**：
  - **v28**、verify_jwt=false。
  - `--use-api` でdownloadした5ファイル（index / report_logic / market_detail / mic_market_context / _shared/market_report_packet）が、`47ea87d` と**byte一致**。
- **dry_runの結果**（cronと同じVault→`net.http_post` 方式、`dry_run:true`）

| 実行 | 結果 | LLM呼び出し | Fact | local | 推定欄の分類 | 助言っぽい言い回し | 3欄合計 | 時間 | 費用 |
|---|---|---|---|---|---|---|---|---|---|
| 大引け1 | completed | 2 | passed | 0 | 特定不能の文のみ | なし | 133 / 133 | ≤24s | $0.0017 |
| 大引け2 | completed | 2 | passed | 0 | 同上 | なし | 179 / 177 | ≤20s | $0.0018 |
| 大引け3 | completed | 2 | passed | 0 | 同上 | なし | 142 / 140 | ≤20s | $0.0015 |
| 大引け4 | completed | 2 | passed | 0 | 同上 | なし | 130 / 130 | ≤22s | $0.0016 |
| 大引け5 | completed | 2 | passed | 0 | 同上 | なし | 148 / 146 | ≤19s | $0.0017 |
| 朝刊1 | failed | 2 | **FAIL** | 0 | なし | なし | 60 / 58 | ≤15s | $0.0013 |
| 朝刊2 | failed | 2 | **FAIL** | 0 | 特定不能の文のみ | なし | 73 / 71 | ≤14s | $0.0013 |

- **大引け**：
  - 事実の前置き（factual lead）は0件、`INFERENCE_NOT_HEDGED` も0件で、PR #29の効果を確認できた。
  - 危険な因果の断定は出ていない。形式の崩れや打ち切りもない。
- **朝刊**：
  - 以前の「見守る／注意が必要／影響しやすい」系は0件になった（Cは効いている）。
  - ただし、**Fact checkerが次の2つを新たに不合格にした**：
    1. 「個別ニュースは確認されていません／入力されたニュースはありません」を、ニュースがないことの断定とみなした。
    2. 「寄り付き後」「場中」を、packetにない時点情報とみなした。
  - **2は、朝刊の生成promptそのもの（`MORNING_INSTRUCTIONS` の「watch_ja には寄り付きや場中で見るべき点を書きます」）と、Fact checkerが矛盾している**。そのため、promptに従うほど朝刊がFactで落ちる構造になっている。
  - 朝刊のFact FAILは、MIC導入後のv26〜v28で続いている（v22・v24は各1/1でPASS、v26は0/1、v28は0/2）。
    - ただし、今回の指摘の2件はどちらもMICの内容には触れていない。MICが主因とは断定できない。
- **MICのcontextの有無**：dry_runの応答にはpacketが含まれないため観測できない。
  - 参考：`market_state_current` はrates=fresh、macroとequity_indexはnarrativeが古い（9/20・9/23評価）。MICの鮮度gateにより、一部は弱い参考扱いになる設計。
- **rollback status**：**実施しない**。
  - v28は大引けを改善した（v27は本日の自然cronで失敗、v28は5/5でPASS）。
  - 朝刊はv27でもFAILしており、v28が朝刊を悪化させた根拠はない。
  - 次の朝刊cronは**月曜9/28 08:35 JST**（週末はcronなし）。それまでに修正できる。
  - fail-closedのため、誤った内容が届くリスクはない。
- **production mutations**：
  - Edge Functionのdeploy 1回（v28）
  - dry_runの呼び出し7回（保存・通知は0件）
  - GitHubでのPR #29のmerge
  - 上記以外は0件

### activationを検討できるか

- **まだ検討できない**。大引けは合格ラインに達したが、朝刊が0/2。

### Voice-policy Phase 1に着手できるか

- **着手は可能**（shadowでの分類とtelemetryだけで、動作は変えないため）。
- ただし、先に**朝刊のprompt⇔Factの矛盾**を直すことを推奨する。月曜の朝刊cronまでが期限。

### 次の推奨（小さなsource-only TASK、月曜08:35より前）

1. `MORNING_INSTRUCTIONS` の「寄り付きや場中で見るべき点」を、packetにある材料だけで書ける観察点に言い換える。例：「前営業日の終値や入力のニュースに照らして確認する点」。時点を表す語（寄り付き後・場中）を、packetにない事実として書かせない。
2. ニュースが空のときの言い方を固定する。例：「入力に個別の材料は含まれていません」（packetについての正確な記述）。「確認されていません」のような、ニュースの有無を断定する言い方を避ける。
3. Fact checkerは緩めない。必要なら、`REPORT_FACT_INSTRUCTIONS` に「packetのnews欄が空である事実を『入力に材料は含まれていません』と書くのは可」だけを追記する。
4. 検証：朝刊dry_runを3回以上、大引けを3回以上。
