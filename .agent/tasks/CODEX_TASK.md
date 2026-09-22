# Codex Task

- task_id: kabumori-mobile-home-dashboard-v1-20260922
- owner: codex
- slot: codex-1
- status: review_required
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
