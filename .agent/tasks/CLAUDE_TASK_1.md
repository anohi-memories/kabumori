# Claude Task 1

- task_id: kabumori-privacy-dataflow-reaudit-after-report-upgrade-20260924
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: PR #19以降のpersonalized-reports / market_detail実装を、既存の公開Privacyページと照合し、OpenAIへ送信されるデータ種別・保存/処理説明が現在の実装と一致しているか再監査する。必要ならPrivacy/Release docsとテストのみを修正する。

## Why now

PR #18時点でPrivacyページは当時のreport payloadに対して監査済み。
その後PR #19で personalized-reports / market_detail / holding_impacts が拡張された。

PR #21 K1で、Privacyページの説明が現在の送信データとズレていないか再確認が必要と判明した。

Netlifyで公開する前に、実装との事実整合を確定する。

## Mandatory startup

1. Independent worktree/checkout.
2. Read PROJECT_RULES.md, .agent/ORCHESTRATION.md, .agent/CURRENT_STATE.md, this TASK.
3. Read:
   - apps/kabumori-web/pages/privacy.html
   - apps/kabumori-web/pages/account-deletion.html
   - docs/mobile-release/RELEASE_READINESS.md
   - supabase/functions/personalized-reports/report_logic.ts
   - supabase/functions/personalized-reports/market_detail.ts
   - supabase/functions/personalized-reports/index.ts
4. Fresh fetch origin/main.
5. Confirm no write overlap with G2/H2 PR #23:
   - G1 may READ G2 source for audit.
   - G1 must not edit personalized-reports source/tests.
   - Only legal/release docs/tests may be changed.
6. Do not deploy or publish Netlify.

## Audit scope

Determine exactly what is sent to OpenAI in current report generation, including:
- tracked ticker/company/sector
- tracking type
- quantity / average price / position/side if present
- derived market value / day P&L / unrealized P&L if present
- portfolio totals / sector weights / benchmark-relative data if present
- related stock news headlines/summaries/metadata
- shared public market analysis / market_detail fields
- morning outlook / morning-to-close comparison context if present
- any other newly added data category

Confirm what is NOT sent:
- email
- auth user id
- memo
- target price
- push token
- other users' data
unless source proves otherwise.

Also verify:
- `store:false` remains used for OpenAI requests
- policy wording does not imply zero provider-side retention if abuse/security logs may exist
- no new analytics/ads/tracking processor appeared
- account deletion wording still matches implementation

## Fix policy

If wording is incomplete or inaccurate:
- make minimal factual corrections only in:
  - `apps/kabumori-web/pages/privacy.html`
  - `apps/kabumori-web/pages/account-deletion.html` only if actually required
  - `apps/kabumori-web/build_test.ts`
  - `docs/mobile-release/RELEASE_READINESS.md`
- add/update regression tests for important disclosure text
- do not make legal claims beyond source evidence
- do not invent processor retention guarantees

## Forbidden

- personalized-reports source edits
- PR #23 edits
- DB/schema/migration
- Edge deploy
- app_enabled changes
- Netlify publish
- EAS/App Store actions
- Supabase Auth/SMTP changes
- X/admin/MIC changes

## Required verification

- web build tests
- legal-link/release tests as relevant
- static grep/source evidence for disclosed data flow
- git diff --check
- production mutation=0

## Completion / K1

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- fresh main SHA
- exact current OpenAI payload categories
- categories explicitly not sent
- privacy wording gaps found
- exact files changed
- tests/counts
- whether Privacy page is source-accurate enough for Netlify publication
- remaining operator/legal review caveat
- production mutation=0

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K1.
