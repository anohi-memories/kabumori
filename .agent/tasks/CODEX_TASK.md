# Codex Task

- task_id: kabumori-mobile-ui-portfolio-news-merge-20260922
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: C1 PASS済みのPR #6をlatest mainへ安全にfreshenし、UI統一・銘柄検索統合・Portfolio V1・重要ニュース重複抑制をまとめてmainへmergeする。

## Approved candidate

PR #6:
- head: `38aa1a500f90355e740603464177701b9e0c3bfc`
- state at C1: merged / closed
- changed files: 22 Kabumori app/test files
- relevant tests: 45 passed
- app-scope TypeScript: PASS
- Expo web export: PASS
- git diff --check: PASS
- production mutation: 0

## Important clarification

The following user requests are ALREADY implemented in PR #6 and must be preserved through merge:
1. Portfolio V1 using latest stored close-report `portfolio_snapshot`.
2. Important News 要点/詳細 deterministic de-duplication.

They are not yet visible to the user only because PR #6 has not been merged into main.

## Included feature set

### UI consistency
- shared Kabumori light palette across core screens
- Home / 銘柄 / ポート / レポート / 重要ニュース visually aligned

### Stock search integration
- search integrated into `/explore`
- Home stock-search action opens integrated flow
- `/search` compatibility route only
- preserve edit/delete/register flows

### Portfolio V1
- fifth tab `ポート`
- uses latest completed close-report snapshot only
- explicit basis date, never realtime claim
- totals, holding rows, stored close, daily/unrealized P/L, sector weights
- watchlist excluded from totals
- clear empty state

### Important News
- exact/near-duplicate suppression between summary/key points/detail
- no display-time AI call
- if no materially new detail remains, do not repeat it
- preserve source links and relation text

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Inspect PR #6 head and current main-side changes
7. Confirm no overlap with active H2/social-mobile files

## Freshen / merge rules

- Rebase/freshen PR #6 onto current `origin/main`.
- Current known main-side implementation changes are H2 social-mobile migration/test only; no Kabumori app overlap was present at C1.
- Do not drag stale `.agent` history.
- If any Kabumori app file in PR #6 changed on main after C1 in a conflicting way, STOP for C1 rather than auto-resolving semantics.

## Required verification after freshen

- relevant app tests
- app-scope TypeScript
- Expo web export
- `git diff --check`
- verify routes:
  - `/`
  - `/explore`
  - `/portfolio`
  - `/search`
  - `/news`
  - `/news/[id]`
  - `/reports`
  - `/reports/[id]`
- verify five-tab native/web navigation
- verify Home -> integrated stock search
- verify Portfolio basis-date copy and no realtime claim
- verify Important News duplicate suppression remains
- production mutation = 0
- no H2/G1/G2 implementation changes

## Merge

If all checks pass:
- merge PR #6 to `main`
- read back resulting main SHA
- verify PR #6 merged/closed
- verify approved Kabumori app files on main match freshened candidate
- no backend deploy, migration, Function, Cron, secret, EAS, or App Store action

## Handoff

Update `.agent/CODEX_REPORT.md` with:
1. pre-freshen main SHA
2. final feature head SHA
3. verification results
4. merge commit/resulting main SHA
5. PR #6 merged state
6. Portfolio V1 preserved
7. News de-dup preserved
8. production mutation 0
9. native/manual QA still outstanding if not run

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**


## Completion record — 2026-09-22

- pre_freshen_main: c4f2f83f485bda45e308522c7b6d079b4b606e7c
- final_feature_head: 38aa1a500f90355e740603464177701b9e0c3bfc
- merge_commit: bc4929165cf74e9044f0267299fce7f1132ac60b
- pull_request: https://github.com/anohi-memories/kabumori/pull/6 (merged and closed)
- verification: 45 relevant tests passed; app-scope TypeScript, Expo web export, route checks, and diff check passed.
- production_mutation: 0
- native/manual QA: outstanding for C1 follow-up.
- next_owner: chatgpt
