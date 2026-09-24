# Claude Task 2

- task_id: kabumori-close-unknown-cause-prefix-fix-20260924
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（極高）
- purpose: production v24 dry-runで確認した「妥当な原因不明文の誤拒否」を、validatorの安全性を維持したまま最小修正する。source/test/PRまで。deploy禁止。

## Incident evidence

PR #23はmerge済み:
- reviewed head: `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`
- merge SHA: `5df9512b43c885fff28b625d089eda249320b3c3`

Production v24 dry-run:
- close #1 FAIL: `下落の要因は特定できません。`
- close #2 FAIL: `当日の下落要因は特定できません。`
- close #3 PASS: `要因は特定できません。`
- morning PASS
- IMPACT_TOO_LONGは解消済み
- unsafe causal assertionは観測されず
- no persistence / no notification

Rollback:
- production v25 = known-good v21 source `4590ba6`
- verify_jwt=false
- app_enabled=false
- cron unchanged

## Goal

`UNDETERMINED_ONLY` / equivalent validator ruleを、実際の妥当な日本語だけ通すよう狭く拡張する。

Allow examples:
- 要因は特定できません
- 下落の要因は特定できません
- 当日の下落要因は特定できません
- 上昇の理由は判断できません
- 値動きの原因は確認できません
- 当日の変動要因は説明できません

Still reject:
- 円高が逆風になりましたが、要因は特定できません
- 円高を受けて下落しましたが理由は特定できません
- 金利上昇が原因です。ただし要因は特定できません
- causal assertion + hedge token laundering
- unrelated sentence containing allowed noun

## Implementation guidance

Prefer a narrow optional subject prefix such as:
- optional `当日の`
- optional movement noun: `下落|上昇|値動き|変動`
- optional `の`

Then require:
- unknown target noun: 要因/原因/理由/材料/因果関係/影響/背景
- cannot-determine verb phrase
- whole-sentence anchored match

Do NOT broaden to arbitrary free text.
Keep CAUSAL_ASSERTION rejection before unknown-cause acceptance.
Keep sentence-by-sentence validation.

## Mandatory startup

1. Independent worktree.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / prior G2 Report / H2 C2 report.
3. Fresh fetch origin/main.
4. Confirm main contains PR #23 merge `5df9512`.
5. Confirm production remains v25 known-good and app_enabled=false by read-only check only.
6. No deploy in this task.

## Tests

Add regression fixtures for the exact two production failures:
- `下落の要因は特定できません。` => PASS
- `当日の下落要因は特定できません。` => PASS

Also test:
- 上昇の理由は判断できません => PASS
- 値動きの原因は確認できません => PASS
- causal + unknown clause => FAIL
- same-sentence hedge laundering => FAIL
- punctuation/newline multi-sentence unsafe case => FAIL
- unrelated allowed noun => FAIL
- existing production wording => PASS
- morning120 / close160 boundaries unchanged

Run:
- close-validator tests
- full personalized-reports suite
- deno check
- deno lint
- git diff --check

## Scope

May change only:
- `supabase/functions/personalized-reports/report_logic.ts`
- related personalized-reports validator tests

Do not change prompt/limits unless test evidence proves necessary.
Do not change market_detail, DB, schema, cron, Auth, X, G1 files.

## Forbidden

- Edge deploy
- app_enabled change
- cron/settings mutation
- DB/schema/migration
- merge before K2
- production LLM invocation

## Completion / K2

Create a new PR.
Report:
- root cause
- exact regex/parser change
- exact allow/reject examples
- tests/counts
- PR number/head
- production state read-back
- production mutation=0
- recommendation for H2 review + later redeploy dry-run

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-close-unknown-cause-prefix-fix-20260924`
- result：validatorの最小修正を完了し、PR #26を作成した（**未merge・未deploy**）。K2待ち。
- changed_files：`supabase/functions/personalized-reports/report_logic.ts`、`supabase/functions/personalized-reports/close_validator_fix_test.ts`
- tests：
  - close_validator **20/20**（新規7件）
  - personalized-reports **64/64**
  - 関連スイート（tests/app＋personalized-reports＋market-report-analysis）**182/182**
  - deno check・deno lint・git diff --checkはPASS
- commit_hash：PR head `2b40a617e34c73c301e40a17692883ac70fd3e0a`
- push：`origin/g2-close-unknown-cause-prefix-20260924`。PR https://github.com/anohi-memories/kabumori/pull/26
- deploy：なし
- safety_checks：
  - production mutation 0（read-onlyの確認だけ）。
  - prompt・上限値・market_detail・DB・cron・Auth・X・G1は未変更。
  - 共有ファイルは未変更。

### root cause

- `UNDETERMINED_ONLY` は文全体の一致（anchored）で判定しており、主語の前置きを許していなかった。
- 実際のモデル出力（production v24の大引けdry_run）は「**下落の**要因は…」「**当日の下落**要因は…」のように、「原因が不明な値動き」を主語として前に付ける。そのため、妥当な文が `INFERENCE_NOT_HEDGED` になった（3回中2回）。

### exact regex change

追加したのは、任意の主語の前置き `UNDETERMINED_MOVE_PREFIX = (?:(?:当日の)?(?:下落|上昇|値動き|変動)(?:の)?)?` を、不明な対象の名詞の直前に置くことだけ。

```
^(?:(?:入力情報|確認できる情報)から)?(?:(?:当日の)?(?:下落|上昇|値動き|変動)(?:の)?)?(?:明確な)?(?:個別(?:の)?)?(?:要因|原因|理由|材料|因果関係|影響|背景)(?:との因果関係)?(?:は|が|を)?(?:特定|判断|断定|確認|説明)(?:できません|できていません|できない|されていません)$
```

- 対象の名詞に `因果関係` を単独で追加した。
- 次は変更していない：文全体の一致、`CAUSAL_ASSERTION` を先に判定する順序、文単位での検証、`UNDETERMINED_ATTRIBUTION`。

### allow / reject examples（すべてテスト済み）

- **PASS**
  - 下落の要因は特定できません（本番の失敗1）
  - 当日の下落要因は特定できません（本番の失敗2）
  - 要因は特定できません
  - 上昇の理由は判断できません
  - 値動きの原因は確認できません
  - 当日の変動要因は説明できません
  - 当日の上昇の要因は特定できません
  - 下落の背景は確認できていません
  - 因果関係は確認できません
  - 既存の本番文言（個別材料が確認できないため…結び付けることはできません）
- **FAIL**
  - 因果の断定＋「特定できない」節
    - 円高が逆風になりましたが、要因は特定できません
    - 円高を受けて下落しましたが理由は特定できません
    - 金利上昇が原因です。ただし要因は特定できません
  - hedgeによる言い逃れ
    - 円高で売られました、…可能性があります
    - 円高が逆風になりました。可能性もあります
  - 改行・`；`・`!` で区切った危険な複数文
  - 前置きの前の自由文、または許可外の主語
    - 円安による上昇の要因…
    - 半導体株の下落の要因…
    - 急な下落の要因…
  - 許可された名詞を含む事実の断定
    - 下落の要因は円高です
    - 上昇の理由は好決算です
    - 材料が出たため下落しました
    - 値動きの原因は需給悪化でした
- mutationの確認：前置きの許可を外すと、新規テストのうち2件がfailする。
- 上限値（朝刊120／大引け160）は不変であることもテストで確認した。

### production state read-back（read-only）

- `personalized-reports`：**v25**、ACTIVE、verify_jwt=false。
  - `--use-api` でdownloadしたindex / report_logicは、v21（`4590ba6`）とbyte一致。
- `app_enabled=false`、`x_enabled=false`（updated_atは2026-09-17のまま）。
- production mutation：**0**（deploy・LLM呼び出し・DB変更はいずれもなし）。

### recommendation

1. H2でPR #26を軽量レビューする（正規表現の変更が狭く保たれているかを確認）。
2. K2でPASSならmergeし、`personalized-reports` を再deployする（`--use-api --no-verify-jwt`、`app_enabled=false` のまま）。
3. 大引けdry_runを**3回以上**（できれば5回）実施し、全件がlocal検証とFactを通過することを確認する。朝刊も1回確認する。
4. 大引けが1回でもlocal検証で失敗したら、`4590ba6` へ即ロールバックする（手順は確立済み）。
5. すべて通過したら、数日の自然cronでの運用を経て、`app_enabled` のON判断を別TASKで行う。


## Final K2 — PR #26 source fix

Result: **PASS**.

Accepted:
- PR #26 head `2b40a617e34c73c301e40a17692883ac70fd3e0a`
- change limited to report validator + tests
- exact production false-reject sentences now covered
- close-validator 20/20 PASS
- personalized-reports 64/64 PASS
- related suite 182/182 PASS
- deno check/lint/diff PASS
- production remains v25 known-good source
- app_enabled=false
- production mutation=0

Next: H2 independent regex/over-permission review before merge/deploy.
