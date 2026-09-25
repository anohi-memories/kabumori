# Claude Task 2

- task_id: kabumori-morning-prompt-fact-contract-fix-20260925
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
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
