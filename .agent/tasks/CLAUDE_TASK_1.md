# Claude Task 1

- task_id: kabumori-privacy-dataflow-reaudit-after-report-upgrade-20260924
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report — G1 result

- task_id: kabumori-privacy-dataflow-reaudit-after-report-upgrade-20260924
- **verdict: PASS-WITH-FIX.** One real disclosure gap found and fixed. PR #24 is open and unmerged. Production mutation = 0. No Netlify publish.
- fresh main at task start: `3903d3a`; in_progress control commit `a70a5d8`. Re-verified at fix time (`0d1aec0`) that none of `supabase/functions/personalized-reports`, `apps/kabumori-web`, `src`, `app.json`, `package.json`, `eas.json` had drifted since — the audit still applies to current main.

### Exact current OpenAI payload categories (verified by reading source, not diffing)

Both OpenAI requests (`reportDraftRequestBody`, `reportFactRequestBody` in `report_logic.ts`) send `input: JSON.stringify(packet)` (plus the draft report, for the fact-check call), where `packet` is `buildPacket(...)`'s return value. Read in full:

**Per stock** (`stockPacket`, for every holding and watch item):
- `ticker_code`, `company_name`, `sector`
- `position` (現物/信用 + 売り, holdings only)
- `price_status`, today/previous close and change
- `quantity`, `average_price` (holdings only)
- `day_profit_loss`, `unrealized_profit_loss_vs_average_price` (holdings only)
- `detail` level (詳しく/簡潔に — a report-length instruction, not financial data)
- `allowed_basis` (an internal instruction-constraint list)
- `relative_to_benchmark` — **TOPIX-relative comparison, close reports, holdings only**
- `morning_outlook` (close reports only: the morning report's own earlier stance/check, recycled)
- `own_news`: severity, kind (適時開示タイトル/確認済みニュース), headline, summary, key_points
- `related_market_news`: headlines only

**Portfolio-level** (`buildPacket`):
- `indices` (public index/ETF prices)
- `portfolio`: holding/watch counts, `market_value`, `day_profit_loss`, `day_change_percent`, **`relative_to_topix`**, `unrealized_profit_loss_vs_average_price`, **`sector_weights`**
- `top_impact_holdings` / `gainers` / `decliners` (company names, already-disclosed identity data)
- `market_news`: severity, headline, summary, related sectors (public)
- `missing_data` (data-gap descriptions, not personal)
- `shared_market` (when present): direction, headline, summary, claims, next_watch, tailwind/headwind themes, cross_asset, morning_watch — confirmed, via `market_detail.ts`'s own header comment and implementation, to be **built once per run from the already-public shared market packet, with no AI call and nothing user-specific**.

### Categories confirmed NOT sent

Grepped `report_logic.ts` and `market_detail.ts` for each:
- **email** — not present anywhere in either file
- **auth user id** — `user_id` appears only in the Supabase REST query strings used to fetch/store the user's own rows server-side; never enters the OpenAI packet
- **memo** — the DB `select` in `index.ts` (`tracked_stocks?...&select=id,user_id,tracking_type,quantity,average_price,position_type,side,stock:stocks_master(...)`) does not even fetch `memo` or `target_buy_price`/`target_sell_price` from the database, so they cannot reach the packet
- **target price** — same as above
- **push token** — not referenced in either file; push tokens are only handled by `send-push-notifications`, a separate function
- **other users' data** — the query is scoped to one `user_id` per call; no cross-user data appears in a single packet

### Also verified

- `store: false` is present on **both** OpenAI requests (`reportDraftRequestBody` and `reportFactRequestBody`), unchanged from the PR #18 audit.
- Policy wording still says provider-side abuse-monitoring retention may apply (up to 30 days) — this was H1's earlier correction and remains unedited and accurate; nothing in this re-audit contradicts it.
- No new analytics/ads/tracking processor: the only `fetch()` targets across `index.ts`/`report_logic.ts` are Supabase REST, the OpenAI Responses API, and a public Yahoo Finance chart endpoint (ticker symbol only, no personal data) — confirmed by grep of every `fetch(` call site.
- Account-deletion wording still matches implementation: no new table was added for the report upgrade; `personalized_reports.body` is `jsonb` (unchanged schema since `20260911230000_personalized_reports.sql`), so richer report content is stored in the same already-covered column.

### Privacy wording gap found and fixed

`buildPacket`'s portfolio-level `sector_weights` and `relative_to_topix`, plus each holding's `relative_to_benchmark`, are real fields sent to OpenAI today. They were **not named** on the privacy page — the page's phrase "これらから計算した評価額や損益" only covered per-stock valuation/P&L, not the portfolio-level aggregation (sector concentration, TOPIX-relative comparison). These are derived entirely from data the page already discloses (ticker, sector, quantity, average price) — not a new category of personal data — but the aggregate itself is more revealing than the generic phrase implied, so I named it explicitly rather than leave it implicit.

### Exact files changed (PR #24, branch `claude1/privacy-dataflow-reaudit`, head `46515c5`)

- `apps/kabumori-web/pages/privacy.html` — the OpenAI row's description extended with `、ポートフォリオ全体の評価額・業種別の構成比率やTOPIXとの比較`
- `docs/mobile-release/RELEASE_READINESS.md` — matching sentence updated, plus a dated re-audit note under the existing "if the report generator changes" caveat
- `apps/kabumori-web/build_test.ts` — two new regression assertions (`/業種別の構成比率/`, `/TOPIXとの比較/`) inside the existing privacy-page test
- `apps/kabumori-web/pages/account-deletion.html` — **not changed**; nothing required it

No `personalized-reports` source or test file was touched, and no PR #23 file was touched.

### Tests / checks

| Check | Result |
| --- | --- |
| `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts` | **122 passed / 0 failed** (same count as before; two new `assert.match` calls added inside an existing test, no new `test()` block) |
| `node apps/kabumori-web/build.mjs` (production, dummy operator values) | built; the new sentence confirmed present in `dist/privacy/index.html` |
| `git diff --check` | PASS |

### Is the privacy page source-accurate enough for Netlify publication?

**Yes**, for the app's own data flows as implemented today — this re-audit closes the one gap this task's scope was meant to find. As already stated on the page and in `RELEASE_READINESS.md`, it remains a factual first draft based on source, not legal advice: the operator (and ideally a professional) should still review it before publication, and OpenAI's own retention/abuse-monitoring description is sourced from OpenAI's public documentation, not independently verified.

### Production mutation = 0

No Supabase migration, Auth/SMTP config, EAS/App Store action, or Netlify publish. Only the git commit/push/PR.

### Recommended next G1 task

K1 review of PR #24. Once merged, the icon/splash/launch-overlay artwork and Netlify publication tasks from the prior report remain the critical path (both still blocked on the operator).
