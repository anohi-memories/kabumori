# Codex Task

- task_id: kabumori-mobile-recovery-pr17-final-auth-security-review-20260924
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: critical
- recommended_model: Sol（高）
- purpose: K1 PASS済みのPR #17 recovery deep-link修正を、merge前の最終Auth/securityレビューとして検証する。実装はClaudeが完了済みで、Codexはレビュー・必要最小限のバグ修正・回帰確認のみ行う。

## Context

G1/K1 accepted:
- real iPhone recovery deep-link PASS
- password reset PASS
- new-password re-login PASS
- in-app account deletion PASS
- disposable account cascade PASS
- no unrelated production mutation

PR #17:
- branch: claude1/recovery-deeplink-fix
- reviewed head at K1: 7dc5c9ae2b5c5dea626c8a21bc2bc7c18c724a43
- changed files:
  - src/app/+native-intent.tsx
  - src/lib/password-recovery.ts
  - tests/app/recovery-routing_test.ts
- PR is still unmerged
- Vercel check may still be blocked by free-tier deployment rate limit

## Review scope

1. Fresh fetch origin/main and PR #17 head.
2. Confirm no semantic drift since K1.
3. Review recovery URL classification and redirect logic for:
   - token/fragment preservation
   - PKCE/token-hash/error-link handling
   - unrelated-link passthrough
   - no catch-all masking
   - no auth/session weakening
   - no token/password logging or persistence
4. Verify Expo Router integration is correct for initial and subsequent system URL events.
5. Re-run focused auth/recovery tests and relevant mobile static/type checks.
6. Review the real-device E2E evidence recorded in G1.
7. Check for regression/security concerns around account deletion and session state only as affected by PR #17.
8. If a concrete bug is found, make only the minimal fix within these 3 files/tests unless a broader change is strictly required; otherwise review-only.

## Forbidden

- production Auth config changes
- SMTP/Site URL/email-template changes
- migration/DB changes
- account-delete Edge Function changes
- unrelated mobile features
- X/admin/MIC work
- production user mutation
- merge PR #17
- bypassing Vercel checks

## Completion / C1

Report:
- fresh main SHA
- PR head SHA
- findings by severity
- exact changed files if any
- tests/checks and counts
- security/auth assessment
- whether PR #17 is safe to merge once repository checks allow it
- remaining blockers outside PR #17
- production mutation=0

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT.md
- STOP for C1.


## Final C1 — 2026-09-24

Result: **PASS**.

Accepted:
- H1 found one P2 recovery-link classification issue and fixed it minimally.
- PR #17 head after review: `b3798aa6be82b6a29d8d2dcf21ca27fb19ef5f50`.
- Unrelated/external links no longer enter recovery handling merely because they contain recovery-like text or `type=recovery`.
- Recovery handling is restricted to accepted app schemes/internal bare-path normalization and exact recovery routes/callback payloads.
- No auth/session weakening, token/password logging, persistence, production mutation, DB change, or Auth config change.
- Focused/auth/account-delete tests: 98 passed / 0 failed.
- Mobile src TypeScript scope: 0 errors.
- Expo web export: PASS, 10 routes unchanged.
- git diff --check: PASS.

Merge decision:
- PR #17 is considered safe to merge from the Auth/security review perspective.
- Do not merge while required repository checks remain failed.
- Current Vercel failure is the free-tier deployment rate limit; do not bypass it in this C1.

Remaining release blockers outside PR #17:
- custom SMTP
- reachable confirmation/recovery Site URL
- privacy / terms / support URLs
