# Codex Task

- task_id: kabumori-mobile-holdings-watch-news-detail-merge-20260922
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: C1 PASS済みPR #7（保有/監視分離 + Important News 詳細品質改善）をlatest mainへ安全にfreshenし、再検証後mainへmergeする。

## Approved candidate

PR #7:
- head: `0225efc66501502b32336998d4b48a71bdfece29`
- state: open / mergeable
- changed files: 5
  - `src/app/explore.tsx`
  - `src/lib/stock-sections.ts`
  - `src/lib/news-presentation.ts`
  - `tests/app/stock-sections_test.ts`
  - `tests/app/news-presentation_test.ts`
- relevant tests: 50 passed
- app-scope TypeScript: PASS
- Expo web export: PASS
- diff-check: PASS
- production mutation: 0

## C1 accepted behavior

### 銘柄
- empty-query view is split into `保有 | 監視`
- counts shown
- holdings preferred by default when present
- integrated search remains unchanged for non-empty query
- edit/register/delete refreshes and re-partitions rows
- section-specific empty states

### Important News
- verified Japanese post sentences are partitioned semantically:
  - 要点 = concise leading event facts
  - 詳しい内容 = remaining distinct event/status facts
- generic market-impact filler is excluded from 詳しい内容
- thin sources are not padded
- no display-time AI
- no producer/backend deploy/change

## Known limitation to preserve/document

This is intentionally an app-only fix:
- richer English `body_summary` may exist while `app_*_ja` fields are NULL
- facts absent from Fact-passed Japanese `verified_text` cannot be surfaced in Japanese by this candidate
- do NOT add display-time translation/AI during merge
- if real-device QA remains shallow after merge, a separate producer/app-copy task is required

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Inspect PR #7 and current main-side changes
7. Confirm no overlap with H2/G1/G2 implementation files

## Freshen rules

- Rebase/freshen PR #7 onto latest `origin/main`.
- Do not drag stale `.agent` history.
- At C1, main-side drift versus feature branch was control/report only.
- If any of the five implementation/test files now conflict semantically with main, STOP for C1 instead of auto-resolving behavior.

## Verification after freshen

- relevant app/news tests PASS
- app-scope TypeScript PASS
- Expo web export PASS
- `git diff --check` PASS
- verify `/explore` search still works
- verify empty-query `保有 | 監視` separation
- verify section default and empty states
- verify Important News detail partition and generic-filler suppression
- verify no display-time AI / no producer changes
- production mutation = 0
- H2/G1/G2 untouched

## Merge

If all checks pass:
- merge PR #7 to `main`
- read back final main SHA
- verify PR #7 merged/closed
- verify the five approved files on main match freshened candidate
- no backend deploy / migration / RPC / Cron / secret / EAS / App Store operation

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. pre-freshen main SHA
2. final feature head
3. verification results
4. merge commit / resulting main SHA
5. PR #7 merged state
6. holdings/watch separation preserved
7. news detail behavior preserved
8. known app-only limitation
9. production mutation 0
10. colors/icons visual polish still deferred

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
