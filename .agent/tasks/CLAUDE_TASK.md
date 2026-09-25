# Claude Task 2

- task_id: kabumori-morning-prompt-fact-contract-fix-20260925
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（極高）
- purpose: production v28 dry-runで判明した朝刊promptとFact checkerの契約矛盾を、Fact基準を緩めずsource-onlyで最小修正する。deploy禁止。

## K2 evidence

Production:
- personalized-reports v28
- merge SHA: `47ea87d33734fbd9e8489f2112c732cb0b2ca11f`
- verify_jwt=false
- app_enabled=false
- x_enabled=false

Dry-run:
- close 5/5 PASS
- morning 0/2
- local validator issues 0
- persistence 0
- notifications 0

Morning Fact failures:
1. 「個別ニュースは確認されていません／入力されたニュースはありません」
   - Fact checker interpreted this as a claim that no news exists.
2. 「寄り付き後」「場中」
   - current morning generation prompt itself asks for these timing phrases, but packet has no such future intraday observations.

This is a prompt↔Fact contract mismatch.

## Goal

Make morning generation express only claims that are verifiable from the packet, without weakening factual/safety checks.

## Required changes

### A. Future/intraday wording

Remove or replace instructions that encourage unsupported timing claims such as:
- 寄り付き後
- 場中
- 今日の値動きで〜

Preferred wording should be observational and packet-grounded, e.g.:
- 確認ポイント
- 注目点
- 前営業日の終値や入力された材料に照らして確認する点

Do not imply a future observation already exists.

### B. Empty-news wording

When the packet/news input is empty, generated text may only describe the input state, not the world state.

Allowed style:
- 「入力に個別の材料は含まれていません」
- 「このレポートの入力には個別ニュースがありません」

Avoid:
- 「個別ニュースは確認されていません」
- 「ニュースはありません」
- 「材料はありません」

unless the underlying packet explicitly proves that broader claim.

### C. Fact checker

Do NOT broadly relax the Fact checker.

If a clarification is needed, only allow the precise meta-claim that the packet/input news array is empty.

No broad permission for:
- no-news-in-the-world claims
- unsupported future/intraday claims
- unsupported causal claims

## Mandatory startup

1. Independent worktree.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK / previous G2 Report.
3. Fresh origin/main.
4. Confirm production v28 and app_enabled=false read-only.
5. Confirm no active slot edits personalized-reports.
6. If another slot overlaps the same files, STOP.

## Scope

Prefer only:
- `supabase/functions/personalized-reports/report_logic.ts`
- related personalized-reports tests

Do not change:
- validator regexes unless unavoidable; if unavoidable STOP and report first
- MIC integration
- market_detail
- _shared market packet
- DB/schema/migration
- cron
- app_enabled/x_enabled
- X/admin/G1 files

## Tests

Add exact regressions for:
- empty news input → allowed meta-claim about input only
- broad “news does not exist” claim → rejected
- prompt does not request 寄り付き後/場中 as observed facts
- prompt still produces watch/checkpoint content
- morning 120 / close 160 unchanged
- existing close validator safety unchanged
- MIC tests unchanged

Run:
- new focused tests
- full personalized-reports
- related report tests
- deno check
- deno lint
- git diff --check

## Forbidden

- deploy
- production LLM/dry-run
- merge before K2
- Fact/Safety weakening
- app_enabled change
- cron/settings mutation

## Completion / K2

Create PR and report:
- root cause
- exact prompt changes
- whether Fact checker changed
- exact allowed/rejected empty-news wording
- tests/counts
- PR/head
- production read-back
- production mutation=0
- recommendation for independent review before merge/deploy

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.

## Report

### Summary

- task_id：`kabumori-morning-prompt-fact-contract-fix-20260925`
- result：source-onlyの修正を完了し、PR #32を作成した（**未merge・未deploy**）。K2待ち。
- changed_files：
  - `supabase/functions/personalized-reports/report_logic.ts`（promptとFactの文言だけ）
  - `supabase/functions/personalized-reports/morning_contract_test.ts`（新規）
- tests：
  - 新規 **6/6**
  - report_hardening 9/9、close_validator 23/23、MIC 14/14・6/6
  - personalized-reports **102/102**、関連スイート **220/220**
  - deno check・deno lint・git diff --checkはPASS
- commit_hash：PR head `749ce19f01ae191398a5b32420b657263c54dd57`
- push：`origin/g2-morning-prompt-fact-contract-20260925`。PR https://github.com/anohi-memories/kabumori/pull/32
- deploy：なし
- safety_checks：
  - production mutation 0（read-onlyの確認だけ。LLMの呼び出しもdry_runもしていない）。
  - validatorの正規表現・上限値・MIC・market_detail・_sharedは未変更。
  - Fact checkerの既存の拒否項目は1つも削除していない。
  - 共有ファイルは未変更。

### root cause

- **A. 時点の表現**：朝刊のpromptが「watch_ja には寄り付きや場中で見るべき点を書きます」と指示していた。packetには当日の場中データがないため、Fact checkerが「寄り付き後」「場中」をpacket外の時点情報として拒否していた。**promptとFactの契約が矛盾していた**。
- **B. ニュースが空のときの表現**：「個別ニュースは確認されていません／入力されたニュースはありません」を、Fact checkerが「世の中にニュースが無い」という断定と解釈した。

### exact prompt changes

- 朝刊のwatch_jaの指示を、「前営業日の終値や入力された材料に照らして確認する点（確認ポイント・注目点）を書きます」に変更した。
- `MORNING_TIMING_RULE`（新設、朝刊のみ）：
  - 入力には今日の寄り付き・場中の値動きは含まれていない。
  - 「寄り付き後」「場中」「今日の値動きで〜」を観測済みの事実のように書かない。
  - 確認する点は「前営業日の終値や入力された材料に照らして確認する点／確認ポイント／注目点」として書く。
- `EMPTY_NEWS_RULE`（新設、COMMONに入れて朝刊・大引けの両方に適用）：入力が空のときは、入力の状態だけを書く。
- no_clear_materialのときのfact_jaの定型文：「明確な個別材料は確認できていません」→「入力に明確な個別材料は含まれていません」。

### Fact checkerの変更

- **1行だけ追加した**（`EMPTY_NEWS_FACT_RULE`）。
  - packetのnews（own_news・related_market_news・market_news）が空のとき、「入力に個別の材料は含まれていません」「このレポートの入力には個別ニュースがありません」は事実どおりなので許容する。
  - 「ニュースはありません」「材料はありません」「個別ニュースは確認されていません」や、packetにない寄り付き・場中の値動きを観測済みとして書くことは、**従来どおり不合格**。
- 既存の拒否項目は、すべて残っていることをテストで確認した：packetにない数字・事実、因果の断定、将来の値動きの断定、売買推奨、推測による穴埋め、shared_marketとの矛盾、fact_jaへの推定の混入。

### empty-newsの文言（許可／不許可）

- **許可**（入力の状態として書くもの）：「入力に個別の材料は含まれていません」「このレポートの入力には個別ニュースがありません」「入力に明確な個別材料は含まれていません」
- **不許可**（世の中について書くもの）：「個別ニュースは確認されていません」「ニュースはありません」「材料はありません」

### tests

- `morning_contract_test.ts`（6件）：
  - 旧指示が消えていること。寄り付き・場中の語は、禁止ルールの中にしか出てこないこと。
  - watch・checkpointの指示は残っていること。時点ルールは朝刊だけに入っていること。
  - 両reportのpromptにempty-newsの許可文・不許可文があること。定型文が置き換わっていること。
  - Factは、入力が空であることを述べる文だけを許可していること。既存の拒否項目がすべて残っていること。
  - 上限値が120／160のままであること。
- mutationの確認：修正を元に戻すと、6件のうち4件がfailする。

### production read-back（read-only）

- `personalized-reports` は **v28**、verify_jwt=false。
- `app_enabled=false`、`x_enabled=false`。
- 着手時点で、同じ関数を扱うopen PRや作業中の他slotはなかった。

### recommendation

1. H2で独立レビューする（Factへの追加が許可範囲の拡大として妥当か、既存の拒否を弱めていないかの確認）。
2. K2でPASSならmergeし、承認を得て再deployする。
3. **次の朝刊cronは月曜9/28 08:35 JST**。それより前に、朝刊dry_runを3回以上、大引けdry_runを3回以上実施する。朝刊が安定しなければ、同じ手順でv28に戻す（v28の大引けは5/5でPASS）。


## Final K2 — PR #32 source contract fix

Verdict: **PASS for source implementation; independent review required before merge/deploy**.

Accepted:
- PR #32 head `749ce19f01ae191398a5b32420b657263c54dd57`
- prompt removes unsupported intraday-observation framing
- empty-news wording is constrained to packet/input-state claims
- Fact checker receives only a narrow meta-claim allowance; no existing rejection removed
- validator/MIC/market_detail/shared packet unchanged
- new 6/6 tests
- personalized-reports 102/102
- related suite 220/220
- deno check/lint/diff PASS
- production mutation=0

Because Fact acceptance semantics change, H2 independent review is required before merge/deploy.
