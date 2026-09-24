# Codex Task

- task_id: kabumori-mobile-recovery-pr17-final-auth-security-review-20260924
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
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
