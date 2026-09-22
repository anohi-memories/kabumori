# Codex Task

- task_id: kabumori-important-news-producer-detail-and-portfolio-freshness-diagnosis-20260922
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: Luna
- purpose: 実機QAで残った2件を正しい層で解消するため、Important Newsの詳細生成をproducer側まで改善し、Portfolioが9/17終値を表示する原因をproduction read-onlyで特定・修正候補化する。production mutationは禁止。

## Confirmed production facts — 2026-09-22

### Portfolio / personalized report
Read-only production data already proved:
- 2026-09-18 close report row exists.
- Its `portfolio_snapshot.price_basis_date = 2026-09-18`.
- 9/18 holdings prices are present and valid in the snapshot.
- However the report row is:
  - `status = failed`
  - `fact_status = pending`
  - `error = REPORT_LOCAL_CHECK_FAILED`
  - `fact_issues = ["CONTAINS_LATIN_WORD:ＵＦＪ"]`
- 2026-09-17 close report is completed + fact-passed.
- Therefore the app currently shows 9/17 because it only sees/uses completed Fact-passed report rows.
- JPX cash market is closed 2026-09-21, 09-22, 09-23; 9/18 is the latest cash-market trading day for this point in time.

### Important News
Previous read-only diagnosis proved the reported AP / UN / North Korea rows:
- have Fact-passed Japanese `generated_text` exposed as `verified_text`
- have `app_title_ja/app_summary_ja/app_detail_ja/app_key_points_ja = NULL`
- richer source-backed facts may exist in English `body_summary`
- app-only partitioning cannot surface facts absent from Japanese `verified_text`

## Goal A — Important News producer/app-copy V2 candidate

Fix the actual detail-generation layer so future news can contain meaningful Japanese detail.

Requirements:
1. Trace current important-news producer path that creates:
   - `generated_text`
   - app-title/summary/key-points/detail fields if implemented
   - fact-check gate
2. Create source candidate so generated app copy has strict semantic roles:
   - title: concise headline
   - summary: 1–2 sentence lead
   - key_points: 2–4 distinct key facts
   - detail: 2–4 short paragraphs of additional source-backed event facts/context, only when source supports them
   - market relevance: separate from event detail
3. Detail must prioritize:
   - who / what / where / when
   - sequence/timeline
   - official attribution
   - figures/distances/injuries/affected assets
   - confirmed vs unconfirmed status
   - operational status after event
4. Do not pad thin sources.
5. Do not add unsupported facts.
6. Preserve grounding/fact-check boundaries.
7. No display-time AI.
8. No production deploy in this H1.

Regression fixtures must include:
- Hormuz tanker / 2 crew injured / vessel continued / no closure confirmed
- North Korea missile / 450–600km / EEZ assessment
- UN/Houthi attempted Riyadh strike / displacement >130k
- genuinely thin source.

## Goal B — Portfolio freshness root cause and candidate

Investigate the exact `CONTAINS_LATIN_WORD:ＵＦＪ` failure.

Required:
1. Locate the report local-check/validator source that emits `CONTAINS_LATIN_WORD`.
2. Prove why full-width company-name text `ＵＦＪ` is classified as a forbidden Latin word.
3. Determine whether the rule is intended to block untranslated English prose versus legitimate Japanese company/proper-name text.
4. Build a narrowly scoped source candidate/test fix so legitimate Japanese proper names/full-width Latin company tokens do not fail the report while real untranslated Latin prose still does.
5. Add regression tests:
   - `三菱ＵＦＪフィナンシャル・グループ` should pass
   - ordinary English prose should still fail
   - ticker/company acronyms that are expected in Japanese financial copy should be handled according to the existing product rule, not broadly whitelisted without justification.

## Goal C — do NOT silently expose failed report narrative

Do not solve Portfolio freshness by simply exposing failed AI report text.

Preferred architecture:
- fix the validator so future valid reports complete normally.
- separately determine whether price snapshot data can/should be safely decoupled from narrative Fact-pass status.
- if a safe decoupling requires schema/RPC/RLS or overlaps G1 market-report work, **do not mutate**. Document the exact proposal/blocker for C1.

For the existing 9/18 failed row:
- no manual production rewrite/backfill in this H1.
- report whether a safe one-time regeneration/backfill would be required after the validator fix.

## Parallel safety / G1 boundary

G1 owns market-report consumer-cutover related work and may touch personalized-report surfaces.
Before editing any personalized-report Function/shared validator:
1. read `.agent/tasks/CLAUDE_TASK_1.md`
2. identify exact G1 file/object ownership
3. if the same file/Function/RPC is active/in-progress there, STOP that sub-part and report conflict
4. do not modify a file owned by another active workstream.

Important-news producer files are independent unless evidence says otherwise.

## Production restrictions

Forbidden:
- production DB write
- migration apply
- RPC/RLS change
- Edge Function deploy
- Cron change
- manual report regeneration
- secret/Vault/provider changes
- X/Push behavior change
- EAS/App Store action

Read-only production SQL is allowed for diagnosis.

## Verification

- relevant Deno/unit tests PASS
- app/news tests PASS if app presentation touched
- app-scope TypeScript PASS if app touched
- `git diff --check` PASS
- no unrelated H2/G1/G2 changes
- production mutation = 0

## Deliverables / C1

Update `.agent/CODEX_REPORT.md` with:
1. exact news producer data path and root cause of shallow detail
2. source candidate changed files
3. fixture results proving additional event facts reach app-copy detail
4. exact report validator root cause for `ＵＦＪ`
5. candidate validator behavior/tests or explicit G1 conflict if blocked
6. whether 9/18 requires one-time regeneration after fix
7. whether snapshot/narrative decoupling is recommended
8. all verification results
9. production mutation = 0

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**
