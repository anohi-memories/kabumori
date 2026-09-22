# Codex Task

- task_id: kabumori-mobile-home-dashboard-v1-merge-20260922
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: C1 PASS済みのPR #5（Kabumori Home/Dashboard V1）をcurrent mainへ安全にfreshenし、競合がないことを確認してmainへmergeする。実装内容は変更しない。

## Approved basis

C1 PASS:
- PR #5
- approved head: `7ff16dcb16117cd2c530fbfdf0e7da8c4788b5e8`
- prior raw-backend-error blocker fixed
- dashboard tests 4/4 PASS
- app-scope TypeScript PASS
- Expo web export PASS
- diff-check PASS
- backend production mutation 0

At C1 review, branch was behind main by 9 commits, but the intervening main-side diff was limited to `.agent` control/report files only; none of the six app/test implementation files overlapped.

## User approval

2026-09-22「じゃあすすめて」。

This authorizes the clean fresh-main merge of the already-approved Home/Dashboard V1 only.

## Model policy

- **Lunaで実施。**
- Sol不要 unless an unexpected implementation conflict appears.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`
2. Read `.agent/CURRENT_STATE.md`
3. Read this TASK
4. Read `.agent/CODEX_REPORT.md`
5. Fresh fetch `origin/main`
6. Inspect PR #5 head and changed files
7. Confirm other slots are not editing the same six app/test files

## Scope A — freshen/rebase

Target implementation files only:
- `src/app/index.tsx`
- `src/app/search.tsx`
- `src/components/app-tabs.tsx`
- `src/components/app-tabs.web.tsx`
- `src/lib/dashboard.ts`
- `tests/app/dashboard_test.ts`

Requirements:
- Rebase/freshen PR #5 onto latest `origin/main`.
- Do not drag stale `.agent` control-file history from the feature branch.
- Do not modify implementation semantics unless required for a concrete fresh-main conflict.
- If any of the six implementation/test files changed on main since C1 in a conflicting way, STOP for C1; do not auto-resolve semantics.

## Scope B — verification

After freshen:
- confirm PR diff is limited to the same six implementation/test files
- dashboard tests 4/4
- app-scope TypeScript check
- Expo web export
- `git diff --check`
- static route verification for:
  - `/`
  - `/search`
  - `/explore`
  - `/news`
  - `/reports`
- confirm Home still uses fixed Japanese error copy and never renders arbitrary backend `Error.message`
- confirm no realtime price/P&L/index fabrication
- confirm H2/social-mobile files untouched

## Scope C — merge

If all checks pass:
- merge PR #5 to `main`
- no production DB/schema/RPC/Function/Cron/secret changes
- no app-store/EAS build required in this task
- no backend deploy

After merge:
- read back latest main SHA
- verify the six files on main match the approved implementation
- verify PR #5 is merged/closed

## Scope D — handoff

Update `.agent/CODEX_REPORT.md` with:
1. pre-freshen main SHA
2. final branch/head SHA
3. exact changed files
4. verification results
5. merge commit / resulting main SHA
6. PR #5 merged state
7. production mutation = 0
8. H2/G1/G2 untouched
9. recommended next UI phase

On completion:
- task status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**


## Completion record — 2026-09-22

- Fresh main before rebase: `1b1d53323c9a903954b3852ed168240fdf581303`.
- Approved PR #5 was rebased without conflict; final feature head: `d03f08ccbf4598ef838be19128b899d309398ac6`.
- PR diff remained limited to the six approved app/test files.
- Dashboard tests 4/4, app-scope TypeScript, Expo web export/static routes, and diff-check passed.
- Home fixed Japanese error-copy mapping and no-fabrication checks remain intact.
- Merged PR #5 with merge commit `c867ee7e0c4546265be325cc606653e0bf964d9f`; resulting main: `c867ee7e0c4546265be325cc606653e0bf964d9f`.
- PR #5 is merged/closed. Read-back confirmed the six files on main match the approved implementation.
- Production mutation = 0. H2/G1/G2 and backend production areas untouched.
- status: `review_required`; next_owner: `chatgpt`; stop for C1.
