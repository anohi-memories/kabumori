# Codex Task

- task_id: x-ai-lab-brand-post-production-hotfix-20260916
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: AI Labのcontrolled test投稿は成功したが、通常10枠のbrand_postが本番dispatcherで `UNSUPPORTED_POST_TYPE:brand_post` により失敗している。通常スケジュール経路を最小修正で復旧し、同時にかぶモリAdminの当日予定一覧へAI Lab予定が混入する表示境界漏れを修正する。

## User authorization

2026-09-16 JST、ユーザーは「早急に治したい。AILABはテスト投稿以降、予定されている投稿が一度もされていない」と明示。今回の既存障害を復旧するための、下記に限定したsource修正・必要なproduction deploy・read-back確認を承認済みと扱う。

## Confirmed production evidence

### AI Lab scheduled posting
- controlled first real post: `brand_id=ai_salaryman_lab`, `post_type=brand_post`, reserved `slot_no=0`
- natural Cron execution at 2026-09-16 18:58 JST succeeded once; X post id `2100162295930511602`
- normal planned rows after ten-window activation:
  - slot 8 scheduled 19:52:05 JST -> claimed 19:53 -> failed immediately `UNSUPPORTED_POST_TYPE:brand_post`
  - slot 9 scheduled 21:09:06 JST -> claimed 21:10 -> failed immediately `UNSUPPORTED_POST_TYPE:brand_post`
  - slot 10 scheduled 22:57:39 JST was pending at investigation time
- failed rows had no OpenAI/X write and no x_post_id; failure occurs immediately after claim.
- Therefore controlled slot0 success did not prove the normal scheduled dispatcher path for `brand_post`.

### Kabumori Admin display leak
`apps/admin/src/lib/today-scheduled-posts.ts` currently queries `scheduled_posts` by `schedule_date` only and does not select/filter `brand_id`, so AI Lab `brand_post` rows appear in the Kabumori Admin schedule list.

## Primary goal A — restore normal AI Lab brand_post execution

Trace the exact difference between the successful controlled slot0 path and normal scheduled slot8/9 path. Fix the normal production dispatcher so `post_type=brand_post` with `brand_id=ai_salaryman_lab` is routed through the already-approved AI Lab text-post generation/publish path instead of reaching `UNSUPPORTED_POST_TYPE`.

Required invariants:
- fixed brand/account routing: `ai_salaryman_lab` -> AI Lab account only
- no Kabumori legacy credential/token fallback
- no Mio routing
- `publish_enabled` / `publish_mode` / identity checks remain mandatory
- <=280 Unicode code points before X dispatch
- cross-brand duplicate/fingerprint protection remains mandatory
- at most one X write per scheduled row
- no automatic resend after completion uncertainty
- text-only; no media upload / `media.write`
- existing Kabumori post types and behavior unchanged
- Fact/Voice/safety behavior for unrelated post types unchanged
- Cron cadence and posting-window times unchanged

Do not create a new parallel posting engine if the existing approved AI Lab brand-post path can be reused safely. Prefer one canonical implementation for controlled and scheduled `brand_post` dispatch.

## Secondary goal B — Kabumori Admin brand isolation

For the Kabumori Admin current schedule/history surface involved in the screenshot, filter server-side to `brand_id='kabumori'` rather than filtering only in UI after fetching.

At minimum inspect and fix:
- `apps/admin/src/lib/today-scheduled-posts.ts`

Also inspect the directly related Admin data loaders used on the same dashboard (`post-history`, recent failures/system status if they read brand-aware posting tables). If they query cross-brand tables without a Kabumori brand predicate, apply the same minimal server-side brand boundary. Do not redesign the Admin UI.

## Mandatory diagnosis/tests

Before changing source:
1. fresh-check `origin/main`
2. read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT.md`
3. check H2/G1/G2 for overlapping `x-test-post` or Admin source work; if conflict exists STOP
4. inspect production/runtime and source routing around `UNSUPPORTED_POST_TYPE`

Tests must include at least:
1. normal scheduled `brand_post` for `ai_salaryman_lab` reaches the AI Lab brand-post handler
2. controlled slot0 and normal scheduled slot use the same canonical dispatch behavior or equivalently proven shared handler
3. wrong brand/account route is rejected
4. Kabumori cannot use AI Lab account/token path
5. >280 code points rejected before X write
6. duplicate/fingerprint protection retained
7. one scheduled row cannot produce multiple X writes
8. unsupported unknown post types remain fail-closed
9. existing Kabumori x-test-post regression remains green
10. Admin today schedule returns Kabumori rows only; AI Lab rows excluded
11. any other touched Admin loader has explicit Kabumori brand isolation test
12. `git diff --check`
13. changed-file type/check/lint or baseline-equivalent diagnostics

Run the relevant full `x-test-post` regression if practical.

## Production action authorization

If and only if implementation/tests pass and fresh conflict check remains clean, this task may:
- deploy `x-test-post` only when required for the dispatcher fix, preserving current `verify_jwt` setting
- deploy/update the Kabumori Admin only through its existing normal deployment mechanism if that deployment is automatically tied to main; do not alter hosting/project settings
- read back `x-test-post` runtime and verify source match
- verify other Edge Function versions/updated_at unchanged
- observe natural scheduled execution only

Do NOT manually invoke a synthetic/real scheduled post to force success. Do NOT backfill failed slot8/9 rows. Let the next natural eligible AI Lab slot/day verify behavior.

## Prohibited

- changes to posting-window times/probabilities
- Cron cadence/settings changes
- DB schema/migration/RPC/RLS changes
- `supabase db push`
- OAuth scope/token/handle changes
- Kabumori publish/token/account changes
- Mio changes
- unrelated Function deploy
- manual X post or manual OpenAI/X/Push invocation
- media scope/upload
- deleting failed evidence
- secret/token output

## Completion

When complete:
- write `.agent/CODEX_REPORT.md` with exact root cause, successful controlled-path vs failed scheduled-path difference, changed files, tests, deploy/read-back evidence, Admin brand-isolation evidence, and remaining natural-observation requirement
- set this TASK to `status: review_required`, `next_owner: chatgpt`
- fresh-check origin/main before push
- push safely and read back origin/main
- STOP for C1
