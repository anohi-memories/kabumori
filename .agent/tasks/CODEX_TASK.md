# Codex Task

- task_id: kabumori-release-pr18-privacy-dataflow-eas-light-review-20260924
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna（高）
- purpose: K1 PASS済みPR #18の公開Privacy/Terms/Support/Account-deletionページ、native legal links、EAS設定を、実際のデータフローとApp Store提出観点から独立レビューする。実装はClaude完了済み。原則review-only、必要なら最小修正のみ。

## Target

PR #18
- branch: claude1/release-foundation-web-links
- K1 reviewed head: 2b91cc482be05536abca2a83ef2e346e5f4522f4
- PR remains open/unmerged

## Review scope

1. Fresh fetch origin/main and PR #18.
2. Confirm no unreviewed semantic drift since K1.
3. Re-audit the privacy claims against source:
   - Supabase tables/data actually stored
   - tracked_stocks fields
   - device_push_tokens / push flow
   - personalized_reports flow
   - exact fields sent to OpenAI
   - whether store:false is really used
   - whether email/user id/memo/target prices are excluded as claimed
   - analytics/tracking/ad SDK absence claim
4. Review account-deletion page against the implemented delete cascade and real-device verified flow.
5. Review Terms/Support text for factual accuracy and unsupported promises.
6. Review src/lib/legal-links.ts:
   - safe URL normalization
   - no broken/unsafe scheme handling
   - route consistency with built site
7. Review apps/kabumori-web build behavior:
   - preview noindex
   - production refuses missing operator values
   - secret/internal identifier leakage
   - Netlify suitability
8. Review eas.json autoIncrement change and RELEASE_READINESS findings for source accuracy.
9. Consider current G2 task:
   - if G2 has changed what personalized-reports sends to OpenAI, identify exact privacy text drift
   - do not edit G2-owned files
10. Re-run focused tests/checks.

## Fix policy

If concrete issue found:
- make only minimal fixes inside PR #18-owned files/tests/docs
- do not modify G2 report-generation files
- do not modify Auth, DB, migration, SMTP, DNS, Netlify production, App Store Connect
- do not deploy anything

## Required checks

At minimum:
- relevant web build tests
- legal-links/settings tests
- relevant personalized-report source read-only verification
- TypeScript/static check if needed
- git diff --check
- production mutation=0

## Forbidden

- merge PR #18
- production Netlify deploy
- DNS mutation
- EAS production build
- TestFlight/App Store submission
- Supabase Auth config
- SMTP config
- DB/migration changes
- G2/G3/G4 implementation files

## Completion / C1

Report:
- fresh main SHA
- PR head SHA
- findings by severity
- factual privacy/data-flow assessment
- account deletion accuracy assessment
- legal-links/web build assessment
- EAS/release-readiness assessment
- exact changed files if any
- tests/checks
- whether PR #18 is safe to merge
- remaining blockers
- production mutation=0

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT.md
- STOP for C1.


## C1 precheck — 2026-09-24

- C1 attempted before H1 completion.
- H1 has now reviewed the current PR #18 head and completed focused verification.
- PR #18 current head is now `6f3277639bc19fb1f420cd0e771c1d77f6d23519`, not the original K1 head `2b91cc482be05536abca2a83ef2e346e5f4522f4`.
- The additional commit is `fix(kabumori): clarify privacy retention and data flows`.
- H1 re-ran the web build, legal-links and settings tests against that exact head: 17 passed / 0 failed.
- Vercel remains failed for build rate limit; no bypass, merge, or deploy was performed.
- The review result and remaining C1 decision are recorded in `.agent/CODEX_REPORT.md`.
