# Claude Task 2

- task_id: kabumori-pr32-merge-redeploy-dryrun-review-deferred-20260925
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: ユーザー判断でH2レビューを一時保留し、PR #32の現在headをfresh検証したうえでmerge、personalized-reportsのみcontrolled redeploy、app_enabled=falseのまま朝刊/大引けdry-runを実施する。レビュー保留中のためactivationは禁止。

## User override

User explicitly requested:
- Codex review is temporarily deferred because Codex became unavailable mid-review.
- Continue forward now.
- Review will be done later.

Therefore:
- do NOT claim PR #32 independently reviewed.
- do NOT set app_enabled=true.
- do NOT treat this task as final activation approval.
- H2 review debt remains open and must be revisited before final activation/release.

## Current PR #32

PR #32:
- branch: `g2-morning-prompt-fact-contract-20260925`
- current head: `722d191dcbe4ba4ce5cf549659493df03d35a353`
- original G2 head: `749ce19f01ae191398a5b32420b657263c54dd57`

Mid-review Codex commit now included:
- `722d191dcbe4ba4ce5cf549659493df03d35a353`
- message: `Align no-material prompt with packet-wide news condition`
- it tightens empty-news wording so the input-state meta-claim is allowed only when holdings/watch own_news + related_market_news + market_news are all empty
- when any news exists, empty-input claims must fail
- it also avoids forcing no_clear_material fact_ja to claim global emptiness when only one holding lacks material
- adds adversarial tests for mixed-news / intraday / causal cases

This commit is **not a completed H2 review verdict**. Treat it as an unreviewed candidate change that must be revalidated by G2 before merge.

## Production baseline

- personalized-reports v28
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- close v28 dry-run previously 5/5 PASS
- morning v28 dry-run previously 0/2 Fact FAIL
- no current persistence/notification from dry-runs

## Mandatory startup

1. Independent worktree / checkout.
2. Read PROJECT_RULES / ORCHESTRATION / CURRENT_STATE / this TASK.
3. Fresh fetch origin/main + PR #32.
4. Verify PR #32 head exactly `722d191dcbe4ba4ce5cf549659493df03d35a353`.
5. Compare `749ce19...` -> `722d191...` and confirm the only semantic delta is the packet-wide empty-news tightening + tests described above.
6. Confirm no active slot edits/deploys personalized-reports.
7. Read production version/settings before mutation.
8. If app_enabled != false or production personalized-reports has changed beyond v28, STOP and report.

## Step 1 — pre-merge source verification

Run at current PR head:
- morning_contract tests
- report_hardening
- close_validator
- full personalized-reports suite
- MIC context/integration tests
- related report/app suite
- deno check
- deno lint
- git diff --check

Explicitly verify:
- mixed-news packet cannot produce empty-input claim
- empty packet can produce only precise input-state meta-claim
- broad no-news world-state claims remain rejected
- unsupported intraday claims remain rejected
- causal assertions remain rejected
- Fact/Safety existing rules remain present
- validator regexes unchanged
- limits remain morning 120 / close 160
- MIC/market_detail/shared packet unchanged

If any of these fail, STOP before merge.

## Step 2 — merge

If source verification passes:
- merge PR #32 at exact head `722d191dcbe4ba4ce5cf549659493df03d35a353`
- fresh fetch main
- verify merged personalized-reports source byte/semantic identity with reviewed candidate
- record merge SHA

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
- no X/admin/G1/MIC changes
- no other Edge Function deploy

After deploy:
- read back deployed version/source
- confirm source matches merged main
- confirm app_enabled=false
- confirm x_enabled=false
- confirm cron unchanged

## Step 4 — dry-run

Required minimum:
- morning: **3 runs**
- close: **3 runs**

For each run record:
- completed / failed
- Fact pass/fail
- local issues
- empty-news wording class
- intraday wording class
- causal assertion presence
- brief length if relevant
- malformed/truncation
- reportId/null
- notification status
- latency/cost if available

Do not include user IDs, email, tokens, or detailed holdings.

### Morning acceptance

Need 3/3:
- Fact PASS
- local issues 0
- no broad “ニュースはありません / 材料はありません / 個別ニュースは確認されていません”
- no unsupported observed-fact “寄り付き後 / 場中 / 今日の値動きで〜”
- if no news, only precise input-state wording
- if any news exists, no false empty-input claim
- no unsafe causal assertion
- no malformed/truncated output

### Close acceptance

Need 3/3:
- Fact PASS
- local issues 0
- no regression from v28 close 5/5
- no false INFERENCE_NOT_HEDGED
- no factual lead in inference
- no unsafe causal assertion
- no malformed/truncated output

### Safety acceptance

All dry-runs:
- reportId=null
- notification not_attempted
- no persistence
- app_enabled=false
- x_enabled=false

## Rollback

Rollback if:
- deployed source mismatches merged main
- new deterministic regression appears
- repeated legitimate Fact/local false reject remains
- unsafe assertion passes
- unexpected persistence/notification occurs
- close regresses materially from v28 baseline

Do not rollback for one obviously stochastic LLM failure without classification; repeat safely within a bounded count and report.

## Explicit activation gate

**Do NOT set app_enabled=true.**
Independent review remains deferred, not waived.

Even if all dry-runs PASS:
- production may remain on the new version with app_enabled=false
- activation decision waits for later review / explicit ChatGPT orchestration

## Voice policy

Do not implement PASS/WARN/BLOCK in this task.
That follows after report generation stabilization.

## Completion / K2

Report:
- fresh main
- PR head
- pre-merge tests
- merge SHA
- deployed version
- deployed-source read-back
- morning >=3 results
- close >=3 results
- app_enabled/x_enabled before/after
- persistence/notification safety
- rollback status
- production mutations
- residual review debt: H2 PR #32 review deferred by user
- whether report generation is technically stable enough for later review/activation decision

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K2.
