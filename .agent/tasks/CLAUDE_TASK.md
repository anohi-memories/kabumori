# Claude Task 2

- task_id: kabumori-pr26-merge-redeploy-final-dryrun-20260925
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: C2 PASS済みPR #26をfresh mainでmergeし、personalized-reportsのみ再deployして、app_enabled=falseのまま大引けdry-run 3〜5回と朝刊1回を実施し、実LLM出力で最終安定性を確認する。

## Accepted review state

PR #26:
- reviewed head: `2b40a617e34c73c301e40a17692883ac70fd3e0a`
- H2/C2 verdict: PASS
- changed source:
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/close_validator_fix_test.ts`

Production currently:
- v25 = known-good v21 source `4590ba6`
- verify_jwt=false
- app_enabled=false
- cron unchanged

## Mandatory startup

1. Independent worktree/checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / H2 C2 report.
3. Fresh fetch origin/main and PR #26.
4. Verify PR head exactly `2b40a617e34c73c301e40a17692883ac70fd3e0a`.
5. Confirm no overlap with G1/X work.
6. Read production state before mutation.
7. If app_enabled != false, STOP.

## Step 1 — merge

If reviewed head unchanged and conflict-free:
- merge PR #26 pinned to reviewed head
- fresh fetch main
- verify merged personalized-reports source matches reviewed head
- rerun relevant tests/checks

## Step 2 — predeploy verification

Run at minimum:
- close-validator suite
- full personalized-reports suite
- deno check
- deno lint
- git diff --check

Confirm:
- only personalized-reports needs deploy
- no migration/schema
- prompt/limits unchanged
- morning 120 / close 160 unchanged

If any fail, do not deploy.

## Step 3 — deploy

Deploy only:
- `supabase/functions/personalized-reports`

Rules:
- use same safe method as prior rollout
- verify_jwt=false
- app_enabled=false throughout
- no cron change
- no DB/schema/migration
- no Auth/RLS
- no X changes
- no other Edge Function deploy

After deploy:
- download/read back deployed source
- verify byte/content match merged main
- verify app_enabled=false
- verify cron unchanged

Keep rollback source `4590ba6` immediately available.

## Step 4 — dry-run

Required:
- close dry-run: minimum 3, preferably 5
- morning dry-run: 1

For each run record non-sensitive summary only:
- completed / failed
- LLM call count
- Fact pass/fail
- local validator issues
- inference wording class
- brief length if relevant
- latency
- approximate cost if available
- truncation
- reportId/null
- notification status

Do not include user IDs, email, tokens, or sensitive holding details.

## Success criteria

Close:
- all required runs pass local validation
- no false INFERENCE_NOT_HEDGED for legitimate unknown-cause text
- no IMPACT_TOO_LONG for valid brief
- no unsafe causal assertion passes
- Fact succeeds
- no malformed/truncated body
- no persistence
- no notification

Morning:
- completes with Fact/local checks PASS
- no regression

## Immediate rollback

Rollback to exact known-good source `4590ba6` if:
- any repeated legitimate unknown-cause false rejection persists
- unsafe causal assertion passes
- local validator regression appears
- malformed/truncated output
- unexpected persistence/notification
- app_enabled changes
- deployed source mismatch
- legacy behavior regression

After rollback:
- verify source matches `4590ba6`
- verify app_enabled=false
- verify cron unchanged

## Explicit gate rule

Do NOT set `app_enabled=true` in this task.

Even full success only authorizes considering a separate activation task after K2.

## Completion / K2

Report:
- fresh main before merge
- PR head
- merge SHA
- post-merge tests
- deployed version
- source read-back
- app_enabled before/after=false
- close dry-run results 3〜5回
- morning result
- Fact/local validator results
- latency/cost/output observations
- persistence/notification safety
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

- task_id：`kabumori-pr26-merge-redeploy-final-dryrun-20260925`
- result：
  - PR #26はmerge済み。
  - **G2自身は再deployしていない**。15:02 JSTに別のworkstream（MIC report-context integration）が、PR #26を含むmainを `personalized-reports` **v26** としてdeployしていたため。
  - G2はv26に対して大引けdry_runを5回、朝刊を1回実施した。**大引けは3/5がPASS、2/5が `INFERENCE_NOT_HEDGED`、朝刊はFact FAIL**。
  - ユーザー判断「A」により、**productionはv26のまま何もしない**（rollbackなし）。
- changed_files：なし（merge以外のsource変更はない）
- tests：merge後、close_validator 20/20、personalized-reports 64/64、関連スイート 182/182、deno check・lint・diff checkはPASS（`f7498cd` で確認）
- commit_hash：PR #26のmerge `f7498cd3a3c8be36c5c56ba19a437ba300d6f93a`（reviewed head `2b40a617e34c73c301e40a17692883ac70fd3e0a`）
- push：mergeのみ
- deploy：**G2はdeployしていない**（v26は別のworkstreamによるdeploy）
- safety_checks：
  - `app_enabled=false`（dry_runの前に再確認した）。
  - dry_runは全件 `notification: not_attempted`・`reportId: null`。
  - DB・cron・Auth・Xの変更は0件。
  - 秘密情報・user_id・銘柄の詳細は本Reportに記載していない。

### 経緯

- 09:05 JST：fresh main `f7498cd` の直前（`f7afe4b`）の時点で開始した。
  - PR head `2b40a61` が一致すること、conflictがないことを確認してmergeした（`f7498cd`）。
  - デプロイ前チェックはすべてPASS。
  - 本番は、v25（`--use-api` のdownloadがv21とbyte一致）、verify_jwt=false、`app_enabled=false` だった。
- 大引けは15:30 JST前だと `CLOSE_TOO_EARLY` でskipされるため、未検証のcodeを17:15のcronに載せないよう、**deployは15:30以降に行うことにして一時停止**した。
- 16:19 JST：再開したところ、次の2点を確認した。
  - mainに、別のworkstreamの `personalized-reports` 変更（`ca239cf`、`6419fc9`、MICの読み取り専用context）がmergeされていた（merge `4382a33`）。
  - productionが **v26**（15:02 JSTにdeploy）になっていた。
    - `--use-api` でdownloadした5ファイル（index / report_logic / market_detail / mic_market_context / _shared/market_report_packet）が、**origin/main `4382a33` とbyte一致**。`f7498cd` とも `4590ba6` とも一致しない。
- 判断：G2が再deployすると別workstreamのdeployを上書きするため、**再deployしなかった**。代わりに、17:15より前に現行v26をdry_runで検証した。

### dry-run results（v26、`app_enabled=false`、Vault→`net.http_post`、`dry_run:true`）

| 実行 | 結果 | LLM呼び出し | Fact | local issue | 推定欄の分類 | 3欄合計（詳しい枠） | 観測時間 | 費用 |
|---|---|---|---|---|---|---|---|---|
| 大引け1 | completed | 2 | passed | 0 | 「要因は特定できません」系 | 125 / 130 | ≤19s | $0.0015 |
| 大引け2 | failed | 1 | 未到達 | INFERENCE_NOT_HEDGED | 事実の節＋特定不能の文 | 177 / 198 | ≤21s | $0.0011 |
| 大引け3 | completed | 2 | passed | 0 | 同上 | 118 / 117 | ≤20s | $0.0015 |
| 大引け4 | completed | 2 | passed | 0 | 同上 | 135 / 136 | ≤19s | $0.0015 |
| 大引け5 | failed | 1 | 未到達 | INFERENCE_NOT_HEDGED | 「値下がりの要因…」 | 154 / 151 | ≤19s | $0.0011 |
| 朝刊 | failed | 2 | **FAIL** | 0 | なし（brief 50 / 48字） | — | ≤20s | $0.0014 |

- 大引けの不合格文（ticker・金額は含まない）：
  - 「値下がりの要因は特定できません。」：主語の語彙（下落／上昇／値動き／変動）に**「値下がり／値上がり」が含まれていない**。
  - 「小幅高でしたが、指数との比較では相対的に弱く、値動きの要因は特定できません。」：推定欄に**事実の節が混ざっている**。現行ルールどおりの拒否だが、実出力ではよく見られる形。
  - 同じrunの「当日の下落要因は特定できません」「上昇の要因は特定できません」は、PR #26で許可したとおり通過している。
- 朝刊のFact FAIL：Fact checkerが、タイトルの「値動きを見守る朝刊」を売買推奨とみなし、「注意が必要」「影響しやすい構成」をpacket外の影響とみなした。厳しすぎる判定（LLM Factのfalse positive）とみられる。fail-closedのため、保存・通知はない。
- 打ち切り（truncation）や形式の崩れ：なし。IMPACT_TOO_LONG：なし。
- 危険な因果の断定が通過したケース：なし。
- 以前の失敗形（「下落の要因…」「当日の下落要因…」）はPR #26で解消済み。

### production state / mutations

- production：**v26**（別workstreamのdeploy、main `4382a33` とbyte一致）、verify_jwt=false、`app_enabled=false`（dry_runの前にread-back）、cronは不変。
- G2によるproduction mutation：dry_runの呼び出し6回（保存0件・通知0件）＋GitHubでのPR #26のmerge。**deploy・rollbackはしていない**。
- rollback：していない。ユーザー判断Aで、別workstreamのdeployを上書きしないことを優先した。
  - 本日17:15の大引けは、約4割の確率で生成されない見込み（fail-closedのため、誤った内容が届くことはない）。
  - rollbackの手順（`4590ba6`、`--use-api --no-verify-jwt`）は用意済み。

### activationを検討できるか

- **まだ検討できない**。大引けのlocal検証の合格率（今回3/5）と、朝刊のFact合格を先に安定させる必要がある。

### 次に推奨する修正（小さな別TASK）

1. `UNDETERMINED_MOVE_PREFIX` に `値下がり|値上がり` を追加する（語彙を足すだけ）。
2. 推定欄の文頭に置かれる、packetの事実を言い直す節（例：「小幅高でしたが、指数と比べて相対的に弱く、」）の扱いを決める。
   - (a) promptで「推定欄に事実を書かない」をさらに強く指示する、または
   - (b) 「事実の節＋特定不能の文」を狭く許可する。
   - 安全面からは (a) を先に試すことを推奨。
3. 朝刊のFact：タイトル・総括で「見守る」「注意が必要」を使わないようpromptで誘導する。または、Fact instructionsに「観察を促す表現は推奨ではない」を明記する。
4. 修正後、同じ手順（大引けdry_runを5回以上＋朝刊）で検証する。
   - MIC workstreamが同じ関数をdeployするようになったため、**deployの担当と順序を1つのslotにまとめること**を推奨する（今回のように、別のworkstreamが同じEdge Functionをdeployする状況を避けるため）。

### remaining real-device QA

- v26で新形式のレポートが保存され次第（本日17:15の大引け、または来週の朝刊）、実機で確認する：
  - 「保有株への影響」カード
  - stanceバッジ
  - 旧形式のレポートとの表示互換
