# Claude Task 2

- task_id: kabumori-report-dryrun-false-reject-hardening-20260925
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（極高）
- purpose: production v26 dry-runで残った大引けのfalse reject 2系統と朝刊Fact false positiveを、validator安全性を緩めずsource-onlyで最小修正する。deploy禁止。

## Latest K2 evidence

PR #26:
- reviewed head: `2b40a617e34c73c301e40a17692883ac70fd3e0a`
- merged: `f7498cd3a3c8be36c5c56ba19a437ba300d6f93a`

Current production:
- personalized-reports v26
- deployed by another workstream (MIC report-context integration), not by G2
- source matched then-current origin/main `4382a33`
- verify_jwt=false
- app_enabled=false
- cron unchanged

v26 dry-run:
- close: 3/5 PASS
- close failures:
  1. `値下がりの要因は特定できません。` => INFERENCE_NOT_HEDGED
  2. factual lead + unknown-cause clause, e.g. `小幅高でしたが、指数との比較では相対的に弱く、値動きの要因は特定できません。` => INFERENCE_NOT_HEDGED
- morning: 0/1, local issues 0 but Fact FAIL
- no truncation
- no IMPACT_TOO_LONG
- no unsafe causal assertion observed
- no persistence / no notification
- app_enabled remained false

## Goal

Fix only the remaining observed false-reject / false-positive classes while preserving fail-closed behavior.

### A. Unknown-cause movement vocabulary

Add only the clearly equivalent movement nouns:
- `値下がり`
- `値上がり`

to the narrow movement-prefix allowlist.

Keep:
- whole-sentence anchoring
- CAUSAL_ASSERTION-first rejection
- sentence-by-sentence validation
- no arbitrary adjective/noun prefix
- no free-text subject

Must PASS:
- 値下がりの要因は特定できません
- 当日の値下がり要因は特定できません
- 値上がりの理由は判断できません
- 当日の値上がりの原因は確認できません

Must still FAIL:
- 急な値下がりの要因は特定できません
- 半導体株の値上がり要因は特定できません
- 円安による値上がりの要因は特定できません
- 値下がりの要因は円高です
- 値上がりの理由は好決算です

### B. Close inference-field prompt hardening

Do NOT broaden the validator to accept a factual clause before an unknown-cause statement in this task.

Instead, strengthen the generation instructions so the inference field contains inference only.

The model must not write factual performance/comparison clauses such as:
- 小幅高でしたが
- 指数との比較では相対的に弱く
- 前日比で上昇しており

inside the inference field.

Facts belong in the fact field.

When causation cannot be supported, inference should be a bounded sentence such as:
- 値動きの要因は特定できません。
- 値下がりの要因は特定できません。

Do not duplicate facts from the packet merely to introduce that sentence.

Add regression tests that lock this prompt rule.

### C. Morning Fact false-positive hardening

Observed Fact FAIL treated wording such as:
- 「値動きを見守る朝刊」
- 「注意が必要」
- 「影響しやすい構成」

as recommendation / unsupported impact.

Preferred fix:
- harden the morning generation prompt/output wording
- avoid advisory-sounding phrases
- use neutral observation language, e.g. `注目点`, `確認ポイント`, `値動きを確認`
- do NOT weaken numeric/entity/factual Fact checks
- do NOT broadly relax the Fact checker

If a tiny Fact-instruction clarification is truly required, it must be narrowly justified by a regression test and must not make unsupported advice/impact claims pass.

## Mandatory startup

1. Use an independent worktree / checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / latest G2 report / H2 PR #26 report.
3. Fresh fetch origin/main.
4. Confirm PR #26 merge `f7498cd` is in main.
5. Inspect all later main changes touching personalized-reports, especially MIC integration.
6. Confirm changed files do not overlap another active workstream.
7. Production read-only check only.
8. No deploy.

If another active workstream is editing the same file(s), STOP and report the collision.

## Scope

Prefer changing only:
- `supabase/functions/personalized-reports/report_logic.ts`
- related personalized-reports tests

May adjust another file inside `supabase/functions/personalized-reports/` only if the morning Fact prompt/instruction actually lives there and the change is necessary.

Do not change:
- `mic_market_context.ts`
- MIC context semantics
- `market_detail.ts` unless evidence proves necessary
- `_shared/market_report_packet.ts`
- DB/schema/migration
- cron
- Auth/RLS
- X
- G1 release files
- prompt length budgets (morning 120 / close 160)

## Tests

Add exact regression coverage for:

PASS:
- 値下がりの要因は特定できません
- 当日の値下がり要因は特定できません
- 値上がりの理由は判断できません
- 当日の値上がりの原因は確認できません

FAIL:
- 急な値下がりの要因は特定できません
- 半導体株の値上がり要因は特定できません
- 円安による値上がりの要因は特定できません
- 値下がりの要因は円高です
- causal assertion + unknown-cause laundering
- factual lead clause + unsafe causal assertion
- punctuation/newline bypass variants

Prompt/output-policy tests:
- close inference prompt explicitly forbids factual lead clauses
- morning prompt avoids recommendation-like wording
- morning/close brief limits remain 120/160

Run:
- close-validator focused suite
- full personalized-reports suite
- related app/report tests if touched
- deno check
- deno lint
- git diff --check

## Forbidden

- Edge deploy
- production invoke / LLM dry-run
- app_enabled change
- cron/settings mutation
- DB/schema/migration
- MIC behavior change
- merge before K2

## Completion / K2

Create a PR and report:
- root causes separated into A/B/C
- exact source changes
- exact allow/reject boundary
- prompt wording change
- whether Fact checker itself changed; if yes, why
- tests/counts
- PR number/head
- production read-back
- production mutation=0
- overlap check with MIC/shared personalized-reports work
- recommendation for H2 review before any merge/deploy

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-report-dryrun-false-reject-hardening-20260925`
- result：source-onlyの修正を完了し、PR #29を作成した（**未merge・未deploy**）。K2待ち。
- changed_files：
  - `supabase/functions/personalized-reports/report_logic.ts`（+15行。promptの定数だけ）
  - `supabase/functions/personalized-reports/report_hardening_test.ts`（新規）
- tests：
  - 新規 **9/9**
  - close_validator **23/23**
  - personalized-reports **96/96**（MICのテストを含む）
  - 関連スイート **214/214**
  - deno check・deno lint・git diff --checkはPASS
- commit_hash：PR head `bed5e79d0ab22e94be6a7c1ebd0f7c8f157ea0c0`
- push：`origin/g2-report-false-reject-hardening-20260925`。PR https://github.com/anohi-memories/kabumori/pull/29
- deploy：なし
- safety_checks：
  - production mutation 0。本番はread-onlyで確認しただけで、LLMの呼び出しもしていない。
  - MIC・market_detail・_shared・上限値・validatorの正規表現・Fact checkerは未変更。
  - 共有ファイルは未変更。

### 前提の変化と衝突の確認

- TASKの記載は「本番はv26」だったが、着手時点では変わっていた。
  - 別のセッションが16:26に `510acf5`（値下がり／値上がりの修正）を**PRを経由せずmainへ直接commit**し、16:32に**v27としてdeploy**していた。
  - v27は `510acf5` とbyte一致（`--use-api` のdownloadで確認）。
- 衝突として報告した。ユーザーから「MICの作業は終了。MICの変更を壊さず、レビュー付きでG2の内容を実行」と指示を受けて着手した。
- 着手時点で、`personalized-reports` を変更しているopen PR・作業中のbranchはなかった。
- 本PRは、MICの変更（`ca239cf`、`6419fc9`）と `510acf5` を含むmainの上に作成した。MIC関連のファイルには触れていない。

### root causes（A / B / C）

- **A. 語彙の不足**：`UNDETERMINED_MOVE_PREFIX` に「値下がり／値上がり」がなかった。
  - 修正は `510acf5` で既にmainに入っている。本PRでは、TASKが指定した境界をテストで固定しただけ。
- **B. 推定欄の文頭に事実の節が入る**：例「小幅高でしたが、指数との比較では相対的に弱く、値動きの要因は特定できません。」
  - validatorの拒否は正しい動作なので、**validatorは広げていない**。
  - 生成側のpromptで、推定欄に事実を書かせないようにした。
- **C. 朝刊のFact false positive**：「見守る」「注意が必要」「〜しやすい構成」が、推奨や根拠のない影響と判定された。
  - 生成側のpromptで、中立な観察の言い方に誘導した。**Fact checkerは変更していない**。
  - MICの入力（`mic_market`）が見通しっぽい表現を誘発した可能性がある。ただし、比較できたのは各1回だけで、確定はしていない。

### exact source changes（report_logic.ts）

- `INFERENCE_FIELD_RULE`（新設。`IMPACT_INSTRUCTIONS` に追加し、朝刊・大引けの両方に適用）：
  - inference_ja には値動き・騰落率・指数との比較などの事実を書かない。
  - 「小幅高でしたが」「指数との比較では相対的に弱く」「前日比で上昇しており」を例として明記して禁止した。
  - 事実は fact_ja にだけ書く。
  - 要因を裏付けられない場合は「値動きの要因は特定できません。」などの1文だけにし、その文を導くために事実を繰り返さない。
- `MORNING_WORDING_RULE`（新設。`MORNING_INSTRUCTIONS` にだけ追加）：
  - 対象：title・summary・overview・watch・risk_notes・checkpoints。
  - 「見守る／注意が必要／警戒が必要／〜しやすい構成／影響を受けやすい」は使わない。
  - 代わりに「注目点／確認ポイント／値動きを確認します」を使う。
- Fact checker：**変更なし**（`REPORT_FACT_INSTRUCTIONS` が不変であることをテストで固定。MICがない場合のFact instructionsが基本セットと完全一致することも確認）。

### allow / reject boundary（テスト済み）

- **PASS**
  - 値下がりの要因は特定できません
  - 当日の値下がり要因は特定できません
  - 値上がりの理由は判断できません
  - 当日の値上がりの原因は確認できません
  - 値動きの要因は特定できません
- **FAIL**
  - 語彙の外側：急な値下がり… / 半導体株の値上がり… / 円安による値上がり…
  - 要因名詞を使った事実の断定：値下がりの要因は円高です / 値上がりの理由は好決算です
  - 因果の断定を後ろの節で打ち消そうとするもの（4パターン）
  - 改行・`；`・`!`・`.` で区切って危険な文を混ぜるもの（4パターン）
  - 事実の前置き＋特定不能の文（観測された文）と、前日比の前置き文
  - 事実の前置き＋因果の断定
- mutationの確認：
  - promptのルールを外すと2件がfailする。
  - 値下がり／値上がりを外すと1件がfailする。
- 上限値（朝刊120／大引け160）が不変であることもテストで確認した。

### production read-back（read-only）

- `personalized-reports`：**v27**（別セッションによるdeploy、`510acf5` とbyte一致）、verify_jwt=false。
- `app_enabled=false`、`x_enabled=false`、cronは不変。
- 本日の大引けcron（17:15）は、確認時点（16:42）ではまだ実行前。

### recommendation

1. H2でPR #29をレビューする（promptだけの変更で、validatorとFactを緩めていないことの確認）。
2. K2でPASSならmergeし、承認を得たうえで再deployする。deployの前に、mainに直接入った `510acf5` もレビュー対象として確認するのが望ましい。
3. 再deploy後、大引けdry_runを5回と朝刊dry_run（できれば2回）で実出力を検証する。朝刊は、MICの入力あり・なしの差を見るために、dry_runの応答の `mic` の有無も記録する。
4. **運用上の推奨**：`personalized-reports` のdeployは1つのslotに一本化し、PRを経由しないmainへの直接commitとdeployは避ける（今回、レビュー前のcodeが本番に入った）。
