# Codex Task

- task_id: kabumori-mobile-home-dashboard-v1-20260922
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: かぶモリアプリ本体のトップ画面を「検索」から「今日の自分の株を把握できるホーム」へ作り替え、既存の登録銘柄・重要ニュース・朝刊/大引けレポートを1画面に集約する。APIコスト最適化H1は自然観測待ちのため、このUI/UX workstreamでは触らない。

## User intent

2026-09-22:
- H2/social-mobileは別チャットで進行しているため本タスクでは対象外。
- APIコスト軽減は自然conditional search待ち。
- その間に、かぶモリアプリ本体のUI/機能を詰めたい。
- まずHome/Dashboard V1から進める方針で合意。

## Model policy

- **Lunaで開始・継続。**
- UI/UX実装、既存read-only data reuse、local testsはLuna。
- SolはAuth/RLS/production schemaの具体的blockerが出た時だけ。
- このH1ではproduction DB migration / Edge Function deploy / Cron / secret変更は行わない。

## Scope boundary

対象:
- root mobile app under `src/app`, `src/components`, `src/lib`
- かぶモリ本体のみ

対象外:
- `apps/social-mobile/**`
- H2/G1/G2 task/report
- important-news search diagnostics / API cost architecture
- Cron
- Supabase migration/schema/RPC変更
- Edge Function deploy
- X/Push producer behavior
- OAuth
- admin app

既存push navigationや通知設定は壊さない。

## Current basis

Current tabs:
- `index` = 検索
- `explore` = 登録銘柄
- `reports` = レポート
- `news` = 重要ニュース

Existing reusable reads:
- `tracked_stocks`
- `fetchMyImportantStockNews()`
- `fetchRecentReports()`

Important constraint:
- 現時点のmobile appにはcurrent stock price / market index realtime sourceがない。
- したがってHome V1では**現在値・評価損益・日経平均/先物などを捏造表示しない**。
- それらは別Phaseでdata source設計後に追加する。

## Goal — Home/Dashboard V1

App起動直後にユーザーが以下を30秒以内で把握できる画面を作る:

1. 今日のレポートが出ているか
2. 重要ニュースがあるか
3. 自分が何銘柄保有/監視しているか
4. 重要ニュースの上位数件
5. すぐ登録銘柄・検索・レポート・ニュースへ移動できる

## Scope A — navigation / route

1. `src/app/index.tsx` をHome/Dashboardへ変更。
2. 既存の検索画面は機能を失わず別routeへ移す。
   - candidate: `src/app/search.tsx`
3. `AppTabs` のindex labelを `ホーム` に変更。
4. Searchはbottom tabを増やさず、Homeのquick actionから開く方式を優先。
5. NativeTabs / Expo Router上でsearch routeが意図せずbottom tabへ露出しないことを確認。
6. push notification deep-link navigationを壊さない。

## Scope B — Home header

Home上部:
- eyebrow: `KABUMORI`
- title: 時間帯によって自然な日本語
  - 朝: `おはようございます`
  - 昼〜夕: `今日のかぶモリ`
  - 夜: `今日もお疲れさまでした`
- subtitle: `あなたの保有・監視銘柄に必要な情報をまとめます。`

ユーザー名は現在のprofile sourceが明確でない限り表示しない。

## Scope C — My Stocks summary

既存 `tracked_stocks` からread-only取得して:
- 保有銘柄数
- 監視銘柄数
- 合計登録数

をHome summary cardで表示。

さらに最大3件程度:
- ticker
- company name
- 保有/監視 badge
- holdingの場合はquantity/average_priceがあれば補足表示

ただし:
- current price
- 評価額
- 含み損益
- 前日比
は現data sourceがないため表示禁止。

Actions:
- `登録銘柄を見る` -> explore
- `銘柄を検索` -> search

Empty state:
- 未登録なら「まず1銘柄追加」の導線を明確にする。

## Scope D — Important News preview

既存 `fetchMyImportantStockNews()` をreuse。

Homeには最大3件:
- target badge / ticker or market
- importance/severity
- Japanese title
- short summary if available
- time

Tap:
- `/news/[id]`

Section action:
- `重要ニュースをすべて見る` -> news tab

Do not duplicate alert settings on Home.
Do not mark all important-news notifications read merely by opening Home; current news-screen behaviorを維持。

Error:
- Home全体を落とさずsection単位でretry/soft error。

## Scope E — Today Reports preview

既存 `fetchRecentReports()` をreuse。

JST current dateで:
- 朝刊
- 大引けレポート

それぞれ:
- available -> title + summary + generated time + detail link
- unavailable -> current schedule wordingを短く表示

Tap:
- `/reports/[id]`

Section action:
- `レポートをすべて見る` -> reports tab

Homeでは通知toggleを置かない。

## Scope F — Quick actions

Home上部またはsummary直下に4 actions程度:
- 銘柄を検索
- 登録銘柄
- レポート
- 重要ニュース

既存themeに合わせ、過度に大きなボタンを乱立させない。
Accessibility labels/hintsを付ける。

## Scope G — loading / refresh / error UX

- HomeはScrollView + pull-to-refresh candidate。
- initial loadingは全画面spinnerだけにせず、section skeleton/simple loading stateを検討。
- one source failureでHome全体を空にしない。
- news/report/stocksを独立loadできる構造を優先。
- user-facing errorはbackend raw errorをそのまま大きく出さず、必要なら短い日本語 + retry。

## Scope H — visual design

Current green/cream KABUMORI styleを維持。

V1 design principles:
- mobile first
- maxWidth 720 web compatibility
- section cards hierarchy
- title/body spacing統一
- green = primary/action
- redを損益用途に予約し、Home V1では不用意に使わない
- dark modeで文字が読めなくなるhard-coded conflictがないか確認

No large design-system rewrite in this task.

## Scope I — code organization

Homeが肥大化しすぎる場合はsmall components/lib extraction可:
- dashboard data loader/hooks
- HomeSection
- quick action card
等。

ただし過剰抽象化しない。

Prefer reusing:
- `ImportantStockNews`
- news presentation helpers
- report presentation helpers
- `TrackedStock`

## Scope J — tests / verification

最低:
1. TypeScript / Expo type check
2. relevant unit tests
3. route/static verification
4. search functionality preserved after route move
5. logged-in empty tracked stocks state
6. tracked stocks state
7. reports present/absent state
8. news present/empty/error state
9. pull-to-refresh behavior smoke/static check
10. git diff --check

If practical, add pure helper tests for:
- JST greeting/time bucket
- today report selection
- tracked summary counts

No production data mutation is required.

## Acceptance criteria

C1で以下を確認できること:
- app start is Home, not Search
- bottom tab label is ホーム
- Search remains accessible and functional
- Home shows actual stored user data only
- no fabricated/current-market metrics
- news preview + reports preview + tracked summary all work
- section failure isolation
- no social-mobile/H2 files touched
- no backend production mutation
- tests/typecheck pass
- fresh origin/main checked before push

## Deliverables / C1

Update `.agent/CODEX_REPORT.md` with:
1. before/after navigation
2. Home layout sections
3. exact data sources reused
4. changed files
5. tests/typecheck
6. screenshots if available, otherwise exact manual verification notes
7. production mutation = 0
8. H2/G1/G2 untouched
9. known limitations (no realtime prices/P&L yet)
10. recommended next UI phase

On completion:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for C1

**推奨モデル：Luna。**


## Completion record — 2026-09-22

- Fresh main base: `f8e35a2116f22f4c19885d50be99bfbac033d67e`.
- PR #5: https://github.com/anohi-memories/kabumori/pull/5
- Commit: `8225d47319eda388a82e85a3d3fbe20acf03a004`.
- Root route is Home/Dashboard V1; Search moved to `/search`; native/web tab label is ホーム.
- Existing tracked-stocks, important-news, and report reads are reused with section-level retry states and pull-to-refresh.
- No backend production mutation. Dashboard tests 3/3, app-scope TypeScript, Expo web export, and diff-check passed.
- Stop for C1; next_owner is ChatGPT.


## C1 review — 2026-09-22

**NOT PASS — Home/Dashboard V1 is structurally good, but one user-facing error-handling blocker remains.**

Accepted:
- Root route is now Home/Dashboard V1.
- Search is preserved at `/search`.
- Native/web tab labels are `ホーム`.
- Existing tracked-stocks, important-news, and report reads are reused.
- No realtime price / valuation / P&L / market index values are fabricated.
- Home has quick actions, tracked-stock summary, up to 3 news items, and morning/close report previews.
- Section failures do not crash the whole Home because loads use `Promise.allSettled`.
- Pull-to-refresh is present.
- PR #5 changes only the 6 expected app/test files; social-mobile/H2 files are untouched.
- Backend production mutation = 0.
- Reported dashboard tests 3/3, app-scope TypeScript, Expo web export, and diff-check all pass.

### C1 blocker — raw backend error details are exposed on Home

The task explicitly required that user-facing errors **not surface backend raw errors directly**.

Current Home stores and renders the exact `Error.message` for each rejected section:
- `stocksResult.reason.message`
- `newsResult.reason.message`
- `reportsResult.reason.message`

Those messages can contain Supabase/PostgREST/RPC details because the underlying loaders currently append backend `error.message`.

This means the new Home can show implementation-level backend text directly to end users, contrary to Scope G.

### Required continuation

1. On Home, map each section failure to a short fixed Japanese user-facing message, for example:
   - stocks: `登録銘柄を読み込めませんでした。`
   - news: `重要ニュースを読み込めませんでした。`
   - reports: `レポートを読み込めませんでした。`
2. Keep detailed errors out of visible UI. Do not add secrets/raw backend payloads to logs.
3. Keep section-level retry UI.
4. Prefer making retry reload only the failed section if it is a small change; if not, reloading all sections is acceptable for V1 as long as the failure remains visually isolated.
5. Add/adjust a test or static assertion that Home-visible error copy cannot include arbitrary backend `Error.message`.
6. Keep all existing navigation/data/no-fabrication behavior unchanged.
7. Fresh-check `origin/main` before push.
8. Production mutation remains 0.
9. Return to `review_required`, next_owner=chatgpt, then stop for C1.

**Recommended model: Luna.**


## C1 blocker fix record — 2026-09-22

- C1 blocker resolved in commit `7ff16dcb16117cd2c530fbfdf0e7da8c4788b5e8` on PR #5.
- Home stocks/news/reports failures now map to fixed Japanese copy: `登録銘柄を読み込めませんでした。` / `重要ニュースを読み込めませんでした。` / `レポートを読み込めませんでした。`
- Added dashboard helper mapping and a test proving arbitrary backend error text is not used as Home-visible copy.
- Section retry, navigation, stored-data-only behavior, and no-fabrication constraints are unchanged.
- Tests: dashboard 4/4, app-scope TypeScript, Expo web export, and diff-check passed.
- Production mutation = 0; no backend, social-mobile, H2, G1, or G2 changes.
- status: `review_required`; next_owner: `chatgpt`; stop for C1.


## Final C1 review — 2026-09-22

**PASS — prior Home error-copy blocker is resolved.**

Reviewed PR #5 head:
- branch: `codex/kabumori-mobile-home-dashboard-v1-20260922`
- head: `7ff16dcb16117cd2c530fbfdf0e7da8c4788b5e8`

Accepted:
- Home no longer renders arbitrary backend `Error.message` values.
- Stocks/news/reports failures map to fixed Japanese user-facing copy via `dashboardSectionError()`.
- Retry UI and section-level `Promise.allSettled` isolation are preserved.
- Search remains at `/search`; root remains Home; native/web tab label remains `ホーム`.
- No realtime price/valuation/P&L/index data is fabricated.
- PR scope remains limited to the 6 expected app/test files.
- Dashboard tests now 4/4 and include an assertion that arbitrary backend detail is not used as visible copy.
- App-scope TypeScript, Expo web export, and diff-check are reported PASS.
- Production/backend mutation = 0; H2/G1/G2 implementation files untouched.

Freshness check:
- The branch is currently behind main by 9 commits, but the intervening main-side diff is limited to `.agent` control/report files only; none of the six implementation/test files overlap.
- Therefore no implementation conflict is present. Rebase/freshen before merge is still required so control-history is not dragged in or lost.

C1 judgment:
- Home/Dashboard V1 candidate is approved.
- PR #5 may proceed to a clean fresh-main merge after a final no-conflict check.
- No backend deploy/migration is part of this task.

**Recommended model for merge/freshen: Luna.**
