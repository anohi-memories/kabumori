# Codex Task

- task_id: kabumori-mobile-holdings-watch-news-detail-merge-retry-20260922
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: PR #7 merge blockerを再判定した結果、最新mainのKabumori実装ファイルにはsemantic driftが無いことを確認したため、PR #7をlatest mainへfreshenして再検証し、mainへmergeする。

## C1 re-evaluation — false-positive blocker corrected

Previous H1 stopped because it interpreted:
- `src/lib/stock-sections.ts` / test not existing on main,
- `explore.tsx` and `news-presentation.ts` not containing PR7 behavior,

as semantic main drift.

That interpretation was incorrect.

Evidence:
- PR #7 base is `e2e5a8afeb8fe0e3513c0a137d75ca7d95bcd076`.
- Comparing PR #7 base -> current `main` shows **no changes at all** in the five PR #7 implementation/test files.
- Main changes since the PR base are limited to:
  - `.agent/**` control/report files
  - unrelated `supabase/functions/market-intelligence-ingest/**` FRED work.
- Therefore the absence of `stock-sections.ts` on main and the older behavior in `explore.tsx` / `news-presentation.ts` are simply the expected pre-PR state, not a competing semantic edit.

## Approved candidate

PR #7:
- head: `0225efc66501502b32336998d4b48a71bdfece29`
- state: open / mergeable
- changed files:
  - `src/app/explore.tsx`
  - `src/lib/stock-sections.ts`
  - `src/lib/news-presentation.ts`
  - `tests/app/stock-sections_test.ts`
  - `tests/app/news-presentation_test.ts`

Approved behavior:
- `保有 | 監視` segmented registered-stock view with counts and section-specific empty states.
- Integrated stock search preserved.
- Important News:
  - 要点 = concise leading event facts
  - 詳しい内容 = remaining distinct event/status facts
  - generic market-impact filler removed from 詳細
  - thin sources not padded
  - no display-time AI
- App-only change. Producer/backend unchanged.
- Colors/icons visual polish remains deferred.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Reconfirm PR base -> current main has no overlap in the five PR7 files.
7. Confirm H2/G1/G2 are not editing those five files.

## Freshen / merge

- Freshen/rebase PR #7 onto latest `origin/main`.
- Do not drag stale `.agent` history.
- Because current main has no implementation overlap in PR7 files, the PR7 behavior should be reapplied exactly.
- If a genuinely new change to any of the five files appears after this task was written, STOP and report the exact conflicting commit/file.

## Verification

After freshen:
- relevant app/news tests PASS
- app-scope TypeScript PASS
- Expo web export PASS
- `git diff --check` PASS
- verify `/explore` search still works
- verify `保有 | 監視` segmentation and counts
- verify default/empty-state behavior
- verify Important News detail partition and generic-filler suppression
- verify no display-time AI
- production mutation = 0
- H2/G1/G2 untouched

## Merge

If checks pass:
- merge PR #7 to main
- read back final main SHA
- verify PR #7 merged/closed
- verify the five approved files on main match freshened candidate
- no backend deploy/migration/RPC/Cron/secret/EAS/App Store action

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. proof that prior blocker was false-positive and why
2. pre-freshen main SHA
3. final feature head
4. verification results
5. merge commit/resulting main SHA
6. PR #7 merged state
7. holdings/watch behavior preserved
8. news detail behavior preserved
9. production mutation 0
10. visual polish deferred

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
