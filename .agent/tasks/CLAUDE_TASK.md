# Claude Task 2

- task_id: kabumori-pr32-no-clear-material-fix-merge-dryrun-20260925
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus5.5（高）
- purpose: PR #32 head 722d191で発見した no_clear_material / empty fact_ja 回帰を最小修正し、同じTASK内でPR更新→再テスト→merge→controlled redeploy→朝刊/大引けdry-runまで完了する。Codexレビューはユーザー方針により後回し。activationは禁止。

## K2 finding

At PR #32 head:
- `722d191dcbe4ba4ce5cf549659493df03d35a353`

Regression:
- IMPACT_INSTRUCTIONS now allows `fact_ja=""` for no_clear_material.
- `parseReportDraft().impacts()` filters out impacts with empty fact_ja.
- missing impact then causes `MISSING_HOLDING_IMPACTS` -> report fail.
- reproduced with a probe.

Production remains safe:
- personalized-reports v28
- app_enabled=false
- x_enabled=false
- merge/deploy/dry-run from the previous task did not occur
- production mutation from previous task = 0

## Chosen fix

Use **prompt-level per-holding input-state fact**, not parser widening.

For a holding with no usable material:
- keep the impact row
- keep `stance=no_clear_material`
- keep `fact_ja` non-empty
- wording must be scoped to that holding's own input only

Preferred example:
- 「この銘柄の入力には個別材料が含まれていません」

Do NOT use global packet-wide emptiness wording for a single holding.

This avoids changing parser/validator semantics and keeps existing required impact rows intact.

## Required source change

### A. no_clear_material fact_ja

Update prompt so:
- if the specific holding has no usable `own_news` / `related_market_news`, use a holding-scoped input-state fact
- do not leave fact_ja empty
- do not claim there is no news globally
- do not claim packet-wide emptiness unless packet-wide condition is truly met

### B. Fact checker

Add only the minimum precise allowance needed for the holding-scoped input-state statement.

It must be valid only when that holding's own_news and related_market_news are empty / provide no usable individual material.

Keep rejected:
- global no-news claims
- false holding-empty claim when that holding has news
- unsupported causal assertion
- unsupported intraday/future claim
- buy/sell recommendation
- fabricated data

### C. Regression tests

Must add deterministic regression proving:
1. no_clear_material impact with no usable holding news retains non-empty fact_ja
2. parseReportDraft keeps all holding impacts
3. no `MISSING_HOLDING_IMPACTS`
4. mixed-news packet:
   - holding A with news cannot claim no material
   - holding B without news can use holding-scoped input-state wording
5. global empty-input meta-claim still only allowed when packet-wide news is empty
6. broad world-state claims still fail
7. morning intraday claims still fail
8. close validator behavior unchanged
9. limits remain 120 / 160

## Scope

Prefer only:
- `supabase/functions/personalized-reports/report_logic.ts`
- `morning_contract_test.ts`
- a narrowly scoped new regression test only if necessary

Do not change:
- parser semantics unless this prompt-level fix proves impossible
- validator regexes
- MIC
- market_detail
- shared packet
- DB/schema/migration
- cron
- app_enabled/x_enabled
- X/admin/G1

If prompt-level fix is impossible without parser change, STOP and report before changing parser.

## Workflow

### Step 1 — source fix on PR #32

Work on current PR #32 branch/head lineage.
Do not create a competing PR.

Run:
- focused new regression
- morning_contract
- report_hardening
- close_validator
- full personalized-reports
- MIC context/integration
- related report/app suite
- deno check
- deno lint
- git diff --check

If any deterministic regression remains, STOP.

### Step 2 — update PR #32

Push the fix to the existing PR #32 branch.
Record new head.

No Codex review required at this stage per reduced-review policy.
Do not claim independent review.

### Step 3 — merge

Fresh fetch main and PR.
If:
- exact expected head
- conflict-free
- no overlapping active personalized-reports workstream
then merge PR #32.

Record merge SHA.

### Step 4 — controlled deploy

Deploy only:
- `personalized-reports`

Rules:
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- no cron/settings/db/auth changes
- no other Edge Function deploy

Read back deployed source/version and verify match with merged main.

### Step 5 — dry-run

Required minimum:
- morning: 3
- close: 3

Morning must pass 3/3:
- Fact PASS
- local issues 0
- all holdings have impact rows
- no MISSING_HOLDING_IMPACTS
- no global no-news false claim
- holding-scoped no-material wording only when appropriate
- no unsupported intraday wording
- no unsafe causal assertion
- no malformed/truncated output

Close must pass 3/3:
- Fact PASS
- local issues 0
- no false INFERENCE_NOT_HEDGED
- no factual lead regression
- no unsafe causal assertion
- no malformed/truncated output

All dry-runs:
- reportId=null
- notification=not_attempted
- no persistence
- app_enabled=false
- x_enabled=false

## Review policy

Per user decision:
- do not create a new H1/H2 review after this low-scope prompt/Fact contract fix
- preserve existing deferred H2 history
- final high-risk/release review can be bundled later if needed

## Activation gate

**DO NOT set app_enabled=true.**

Even if all dry-runs pass:
- leave app_enabled=false
- report technical readiness only
- activation is a later ChatGPT/user decision

## Voice policy

Do not implement PASS/WARN/BLOCK in this task.

## Completion / K2

Report:
- root cause confirmation
- exact fix
- new PR #32 head
- all tests/counts
- merge SHA
- deployed version
- source read-back
- morning 3+ results
- close 3+ results
- impact completeness
- app_enabled/x_enabled before/after
- persistence/notification safety
- rollback status
- production mutations
- remaining review debt / activation gate
- whether report generation is technically stable enough to proceed to next phase

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-pr32-no-clear-material-fix-merge-dryrun-20260925`
- result：
  - 回帰を修正し、PR #32を更新してmergeした。
  - ユーザー承認のうえ `personalized-reports` を **v29** としてdeployした。
  - dry_runは **朝刊3/3・大引け3/3がすべてPASS**（Fact・localとも）。
  - `app_enabled=false`、`x_enabled=false` を維持している。
- changed_files（PR #32への追加commit `8792622`）：
  - `report_logic.ts`（+15行／−1行：prompt・packetの1項目・Factの1行・localの1チェック）
  - `morning_contract_test.ts`（722d191の期待値を修正後の文言に合わせた）
  - `no_material_regression_test.ts`（新規）
- tests：
  - no_material_regression 7/7、morning_contract 8/8、report_hardening 9/9、close_validator 23/23、MIC 14/14・6/6
  - personalized-reports **111/111**、関連スイート **233/233**
  - deno check・lint・diff checkはPASS
- commit_hash：PR #32の新しいhead `8792622d440b008d04ca97fb780a6a765245542a`、merge `f34b8c48e0de35626a8c16cd6a8d6109285c2bde`
- push：PR #32のbranchへpush（fast-forward）し、merge済み。
- deploy：`personalized-reports` v29（source `f34b8c4`、`--use-api --no-verify-jwt`）
- safety_checks：
  - deploy以降、`personalized_reports` の作成・更新は0件、通知は0件。
  - dry_runは全件 `notification: not_attempted`・`reportId: null`。
  - cronは不変。
  - 秘密情報・user_id・銘柄の詳細は本Reportに記載していない。

### root cause（確認済み）

- `722d191` がIMPACT_INSTRUCTIONSで「書ける事実がなければ fact_ja を空文字」と指示していた。
- 一方、`parseReportDraft().impacts()` はfact_jaが空のimpactを捨てる。
- そのため、`MISSING_HOLDING_IMPACTS` → レポート全体が不合格になっていた（probeで再現済み）。

### exact fix（parserと既存のvalidator規則は変更していない）

1. **prompt**：「fact_ja は空にしません」とした。
   - `material_in_input` が「含まれていない」銘柄は、fact_jaに「この銘柄の入力には個別材料が含まれていません」と書く（値動きなどの事実を続けてもよい）。
   - 「含まれている」銘柄には、この文を書かない。
   - packet全体が空のときに限る文言（`722d191` の条件）は維持した。
2. **packet**：holdingごとに、コードで決めた `material_in_input`（含まれている／含まれていない。own_newsまたはsector一致のrelated_market_newsがあるか）を追加した。
3. **Fact**：`HOLDING_NO_MATERIAL_FACT_RULE` を追加した。
   - この文は、material_in_inputが「含まれていない」銘柄に限って許容する。
   - 「含まれている」銘柄にこの文を書いた場合、またはこの文を根拠に世の中にニュースが無いと断定した場合は不合格。
4. **local**：`FALSE_NO_MATERIAL_CLAIM` を追加した。ニュースがある銘柄にこの文を書いた場合に、決定的に拒否する（新規の狭いチェック）。
   - 既存の正規表現、`CAUSAL_ASSERTION`、上限値、parserは不変。

### dry-run（v29、`app_enabled=false`、Vault→`net.http_post`、`dry_run:true`）

| 実行 | 結果 | LLM呼び出し | Fact | local | impact | 空fact | 銘柄単位の文 / 誤用 | 世の中ニュース無し表現 | 寄り付き・場中 | 因果の断定 | 時間 | 費用 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 朝刊1 | completed | 2 | passed | 0 | 2/2 | 0 | 2 / 0 | なし | なし | なし | ≤20s | $0.0014 |
| 朝刊2 | completed | 2 | passed | 0 | 2/2 | 0 | 2 / 0 | なし | なし | なし | ≤13s | $0.0014 |
| 朝刊3 | completed | 2 | passed | 0 | 2/2 | 0 | 2 / 0 | なし | なし | なし | ≤13s | $0.0014 |
| 大引け1 | completed | 2 | passed | 0 | 2/2 | 0 | 2 / 0 | なし | なし | なし | ≤20s | $0.0018 |
| 大引け2 | completed | 2 | passed | 0 | 2/2 | 0 | 2 / 0 | なし | なし | なし | ≤19s | $0.0017 |
| 大引け3 | completed | 2 | passed | 0 | 2/2 | 0 | 2 / 0 | なし | なし | なし | ≤19s | $0.0017 |

- **impact completeness**：6回すべてで、impactの数が保有銘柄数と一致した。空のfact_jaは0件、`MISSING_HOLDING_IMPACTS` も0件。
- **本日のpacketの条件**：本日のpacketはニュース0件（news=0）だった。そのため、packet全体が空のときの文（「入力に明確な個別材料は含まれていません」）の使用は正当。
  - 一部の銘柄にだけニュースがある日（mixed-news）は、本番のデータでは今回観測できていない。
  - mixed-newsの挙動は、決定的なテスト（no_material_regression #4。ニュースがある銘柄にこの文を書くと `FALSE_NO_MATERIAL_CLAIM`）で担保している。
- 大引けの推定欄：推定表現の不足（unhedged）は0件、事実の前置き（factual lead）の回帰もなかった。
- 3欄合計は、詳しい枠で136〜191字。各欄の上限（160／160／80）の範囲内。
- 打ち切り（truncation）や形式の崩れ：なし。

### production state / mutations / rollback

- **deploy前**：v28、`app_enabled=false`、`x_enabled=false`。
- **deploy後**：**v29**、verify_jwt=false。`--use-api` のdownloadで5ファイル（index / report_logic / market_detail / mic_market_context / _shared/market_report_packet）が `f34b8c4` と**byte一致**。`app_enabled=false`、`x_enabled=false`、cronは不変。
- **production mutations**：
  - Edge Functionのdeploy 1回（v29）
  - dry_runの呼び出し6回（保存・通知は0件）
  - GitHubでの、PR #32へのpushとmerge
- **rollback**：不要のため実施していない。known-goodとして、v28（`47ea87d`）とv21（`4590ba6`）の手順が引き続き使える。

### 残っているreview負債とactivationのgate

- H2によるPR #32の独立レビューは、ユーザー判断で**保留中**のまま（本TASKでは完了扱いにしていない）。今回の追加commit `8792622` も未レビュー。
- `app_enabled` はfalseのまま。activationは、後のChatGPT・ユーザーの判断による。

### 次のphaseに進めるほど技術的に安定しているか

- **本日の条件（ニュース0件の日）では安定している**：朝刊3/3・大引け3/3がPASS。大引けは直近のv28とv29で8/8。
- 未確認なのは、mixed-newsの日の実LLMでの挙動（テストでは担保済み）。
- 推奨：
  1. 月曜9/28の自然cron（朝刊08:35・大引け17:15）の保存結果を、read-onlyで確認する。
  2. その後、保留中の独立レビューと、activationの判断へ進む。
  3. VOICE方針のPhase 1（shadowでの分類）は、その後に着手できる。
