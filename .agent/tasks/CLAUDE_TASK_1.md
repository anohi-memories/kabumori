# Claude Task 1

- task_id: kabumori-home-v3-routing-fix-postmerge-ios-preview-qa-20260929
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（中）
- purpose: K1 PASSでmerge済みのPR #55 routing fixをfresh mainから検証し、新しいiOS internal/preview buildを1本だけ作成して、ユーザーが実機でHome v3と全ナビゲーションを再QAできる状態にする。source変更・production mutationは禁止。

## Accepted K1 baseline

PR #55:
- title: `fix(nav): critical — every non-tab route unreachable since PR #53`
- reviewed head: `5859f6ce6f94fbb45a065821afbcc2778598b8a9`
- K1 verdict: PASS
- merge SHA: `e8326163f90f969ede063e52533731a2273ef7b2`
- merged: 2026-09-29 JST
- Codex review: not required under reduced-review policy
- production mutation: 0

K1 verified:
- root cause is NativeTabs route registration, not Home row onPress logic.
- standard `(tabs)` NativeTabs + root Stack structure is used.
- moved `index.tsx` and `settings.tsx` contents are byte-identical to pre-move files.
- main-side commits since branch fork touched only .agent/MIC files, not PR #55 app-routing files.
- GitHub mergeable=true.
- reported full app tests 187/187 PASS.
- iOS Simulator release verification recovered /news, /news/[id], /portfolio, /topic-detail and preserved all 5 bottom tabs + reports/[id].
- Vercel and Netlify commit statuses were success.

Known lower-severity follow-up, not a blocker for this build:
- root-pushed `/news` and `/portfolio` currently rely on iOS edge-swipe for back navigation and have no explicit in-app back button. Do not expand scope here.

## Mandatory startup / isolation

1. Use a fresh independent G1 worktree/checkout.
2. Fresh-fetch `origin/main`.
3. Record fresh main SHA.
4. Confirm merge SHA `e8326163f90f969ede063e52533731a2273ef7b2` is an ancestor.
5. Read PROJECT_RULES, ORCHESTRATION, CURRENT_STATE, this TASK, app/eas config, root layout and `src/app/(tabs)/_layout.tsx`.
6. Confirm no G1 overlap.
7. Do not touch G2/MIC/X/news-ingestion backend workstreams.
8. If independent worktree cannot be guaranteed, STOP.

## Phase A — fresh-main verification

Run:
- `deno test tests/app/ --allow-read --no-check`
- `npx tsc --noEmit` and distinguish known unrelated pre-existing errors from new errors
- `npx expo config --json`
- `npx expo export --platform web --clear` when safe
- `git diff --check`

Expected:
- no source edits
- no new failures
- routing regression test remains present and passing

If a concrete blocker is found, STOP and report; do not patch ad hoc in this build task.

## Phase B — one fresh EAS internal/preview build

The following build is CONFIRMED BROKEN and MUST NOT be reused:
- build id: `d9ed1da1-9542-45c7-b704-d89eaba9a978`
- source: `135dcc96c394fba5948a45ea4eca45f7dea5d595`
- reason: non-tab Home navigation dead before PR #55.

Read-only preflight:
- EAS login/account
- project linkage/projectId
- bundle identifier
- preview/internal profile
- required EXPO_PUBLIC_* names/presence only
- signing/provisioning readiness
- latest build source commits

Reuse is allowed only if a newer installable internal build already contains merge `e8326163...`.
Otherwise create exactly ONE safest nonproduction/internal iOS build from fresh main.

Forbidden:
- App Store/TestFlight production submission
- source edits
- bundle/projectId changes
- EAS production env mutation
- Supabase/Auth/DB/migration/DDL/DML mutation
- G2/MIC/X/news-ingestion changes

If Apple login/device registration/credential interaction is required, STOP and report exact user action.

## User real-device re-QA checklist

Do not self-PASS these. User must confirm on iPhone.

A. Home visual:
1. Header compact.
2. 今日のかぶモリレポート compact.
3. old large circle+🌱 absent.
4. 重要ニュース入口 visible near first viewport.
5. character area looks intentional/neutral.

B. Navigation recovery — release blocker:
6. 重要ニュース「すべて見る」 opens /news.
7. individual news row opens /news/[id].
8. 今日のトピック opens /topic-detail.
9. Settings → ポートフォリオ opens /portfolio.
10. Report item still opens reports/[id].
11. all 5 bottom tabs switch correctly.

C. Topic detail:
12. same tapped topic is shown.
13. multi-section detail renders.
14. back returns cleanly to Home.

D. Settings safe-area:
15. Home top-right Settings opens.
16. bottom Settings tab opens.
17. header does not overlap status bar/Dynamic Island.
18. top controls tappable.
19. topic-level subview back inside safe area.
20. account-deletion subview back inside safe area.
21. level change persists.

E. Bottom tabs exact order:
22. ホーム / 銘柄 / レポート / AIに聞く / 設定.
23. ポート and 重要ニュース are not separate tabs.

F. Regression:
24. important/holding news load.
25. AIに聞く opens honest 準備中 screen.
26. logout/password reset/account deletion do not crash.
27. no fatal error/red screen.

Known non-blocking observation:
- /news and /portfolio may require iOS edge-swipe to return because explicit in-app back buttons are not yet added. Record whether this feels unacceptable; do not silently fix in this task.

## Completion / K1

Report:
- task_id
- fresh main SHA/worktree
- merge `e8326163...` ancestor proof
- tests/type/config/export/diff
- EAS account/project/profile
- new/reused build id
- source commit/status/install URL
- signing/provisioning
- env presence names only
- source changes = expected 0
- production mutation = expected 0
- exact user QA checklist
- remaining issues / next recommendation

When build is ready:
- status -> review_required
- next_owner -> chatgpt
- STOP for K1.

---

## Archived predecessor state

# Claude Task 1

- task_id: kabumori-home-v3-postmerge-ios-preview-qa-20260929
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（中）
- purpose: K1 PASSでmerge済みのHome v3修正PR #53をfresh mainからiOS internal/preview buildし、ユーザーが実機でHome・Topic Detail・Settings safe-area・Bottom Navを最終確認できる状態にする。source変更やproduction mutationは行わない。

## Accepted K1 baseline

PR #53:
- title: `fix(home): v3 design correction, topic detail screen, Settings safe-area`
- reviewed head: `e53465f7cd75fbd0a763347cca51343709f835c2`
- K1 verdict: PASS
- merge SHA: `3b9ca0424e1ef6e079cc852e45ff66d0271c001e`
- merged_at: 2026-09-29 12:22 JST頃
- production mutation before/through merge: 0
- Codex review: not required under reduced-review policy

Accepted scope:
- Home v3 density correction
- topic detail screen + curated 50/50 catalog
- Settings moved from Modal to top-level safe-area screen/tab
- Bottom Nav = ホーム / 銘柄 / レポート / AIに聞く / 設定
- /ai is an honest 準備中 screen
- no DB / migration / Auth / RLS / backend / G2 change

PR #53 source verification:
- 17 changed files, +896/-174
- reported focused regression: 103/103 PASS
- Expo web export: 13/13 routes
- CI status observed at K1: Netlify success / Vercel success
- PR branch was 10 commits behind main at K1, but main-side changes did not overlap the PR implementation files; GitHub mergeable=true and merge completed successfully.

## Mandatory startup / isolation

1. Use a fresh independent G1 worktree/checkout. Never reuse another slot's working directory.
2. Fresh-fetch `origin/main`.
3. Record the current main SHA.
4. Confirm `3b9ca0424e1ef6e079cc852e45ff66d0271c001e` is an ancestor of fresh main.
5. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - `app.json`
   - `eas.json` if present
   - `src/app/index.tsx`
   - `src/app/settings.tsx`
   - `src/app/topic-detail.tsx`
   - `src/components/app-tabs.tsx`
   - `src/components/home/report-highlight-card.tsx`
   - `src/components/home/topic-card.tsx`
6. Confirm no active G1 overlap was introduced after this assignment.
7. G2 owns `supabase/functions/market-report-analysis/**`. Do not touch G2 or any MIC/X/news-ingestion backend workstream.

If safe independent worktree cannot be prepared, STOP and report the conflict.

## Phase A — post-merge source verification

From fresh main, run the focused regression that covers:
- home-topic
- topic-detail-catalog
- settings-menu
- app-tabs
- dashboard
- home-report-highlights
- home-news-sections
- home-news-visual
- news-labels
- news-presentation
- report-presentation
- account-deletion

Also run:
- `npx tsc --noEmit` and distinguish the known unrelated CSS-module errors from new errors
- `npx expo config --json`
- `npx expo export --platform web --clear` when safe
- `git diff --check`

Expected:
- no source edits
- no newly introduced test/type/config/export failure

If a concrete source/config blocker is found, STOP and report it. Do not patch ad hoc in this build task.

## Phase B — EAS build selection

Read-only preflight:
- EAS/Expo login status
- project linkage / projectId
- iOS bundle identifier
- available nonproduction/internal build profile
- required `EXPO_PUBLIC_*` variable presence for that environment (names/presence only; never print values)
- signing/provisioning/device registration readiness
- latest internal/preview build source commit(s)

Known old build:
- build id `9f0e45a1-b2ec-4631-b04b-b510f90a475d`
- source commit `6b59c3f722811dd76b8e8d9a7435c5604097c494`
- this predates PR #53 and MUST NOT be reused for this QA.

Reuse is allowed only if there is a newer installable internal build whose source commit already contains merge SHA `3b9ca042...`.
Otherwise create exactly one safest nonproduction/internal iOS build from fresh main.

## Build constraints

Allowed:
- one EAS internal/preview iOS build from fresh main if required
- read-only EAS/Expo metadata checks
- build-status verification
- install link / QR information for the user

Forbidden:
- App Store submission
- production App Store/TestFlight rollout
- source changes
- bundle identifier/projectId changes
- EAS production secret/env mutations
- Supabase DB/schema/data mutation
- migration/DDL/DML
- Auth/SMTP config mutation
- G2 / MIC / X / news-ingestion backend changes

If Apple login/device registration/credential interaction is required, STOP and report exactly the user action needed.

## User real-device acceptance checklist

Do not mark these PASS yourself. The user must physically confirm them on iPhone.

### A. Home first viewport
1. Header is clear and not oversized.
2. 今日のかぶモリレポート is compact; it does not consume roughly half the screen.
3. The old large circle + 🌱 is gone.
4. The 重要ニュース entrance is naturally visible near the first viewport.
5. Character area appears as a neutral placeholder, not a broken asset.

### B. Important / holding news
6. 重要ニュース shows roughly 3 items when data exists.
7. category / title / time / importance hierarchy is readable.
8. あなたの保有銘柄 最新ニュース remains present and honest when empty.

### C. Today's Topic
9. Home card shows level badge + title + preview + `詳しく読む →`.
10. Tapping the card opens `/topic-detail`.
11. Detail screen shows the exact same tapped topic, not another day's/level's topic.
12. Detail contains multiple readable sections such as ひとことで / なぜ大事か / 見るときのポイント / 注意点.
13. Back navigation returns cleanly to Home.

### D. Settings safe-area — release-blocking check
14. Open Settings from Home top-right.
15. Open Settings from bottom tab.
16. SETTINGS / 設定 header does not overlap the clock / Dynamic Island / signal / battery area.
17. All top controls are tappable.
18. Topic level subview back button is fully inside safe area.
19. Account deletion subview back button is fully inside safe area.
20. Topic level beginner/intermediate/advanced can still be changed and persists.

### E. Bottom navigation
21. Exact visible order:
   - ホーム
   - 銘柄
   - レポート
   - AIに聞く
   - 設定
22. ポート and 重要ニュース are not separate bottom tabs.
23. Existing Portfolio remains reachable from Settings.
24. Existing News remains reachable from Home's links.

### F. Regression
25. 今日のかぶモリレポート still opens its detail.
26. 重要ニュース / 保有銘柄ニュース still load.
27. AIに聞く opens the honest 準備中 screen and does not fake a chat.
28. logout / password reset / account deletion settings do not crash.
29. No fatal error/red screen.

## Completion / K1

Report:
- task_id
- fresh main SHA
- worktree / branch
- confirmation merge SHA `3b9ca042...` is contained
- automated tests
- tsc/config/export/diff results
- EAS account/project/profile
- reused build or newly created build
- build id / source commit / status / install URL
- signing/provisioning result
- env presence checks (never secret values)
- source changes (expected 0)
- production mutation (expected 0)
- exact user QA checklist
- remaining issues
- next_recommendation

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1.


---

## Archived predecessor state

# Claude Task 1

- task_id: kabumori-home-v3-topic-detail-safearea-correction-20260929
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: 実機QAで判明したHomeの最終デザイン差分、今日のトピックの情報量不足/詳細画面欠如、Settingsのsafe-area操作不能をまとめて修正する。G2/market-report-analysisには触れない。

## Trigger / user acceptance finding

2026-09-29 iPhone実機スクリーンショットで、現状は不合格。

ユーザー指摘:
1. Homeが採用済みの構想画像/最終デザインv3と全然違う。
2. 今日のトピックが短すぎる。
3. 今日のトピックを押すと別画面へ行き、ちゃんと詳しい説明を読めるようにしたい。
4. Settingsの「閉じる」等が上すぎてiPhoneの時計/電池/status barと重なり操作できない。

このTASKは前の `kabumori-daily-topic-real-device-qa-20260929` をQA不合格として置き換える修正TASK。
実機QAをPASS扱いにしてはいけない。

## Canonical Home design to restore

採用済み「トップページ最終デザイン修正版 v3」の正本方針:

順番:
1. Header
2. 今日のかぶモリレポート
3. 重要ニュース
4. あなたの保有銘柄 最新ニュース
5. 今日のトピック
6. AIに聞く
7. bottom navigation

Visual:
- iPhone縦 9:19.5 前提
- 白〜アイボリー背景
- 淡いミント + 深緑
- 角丸カード
- 余白はあるが、今のようにカードが縦に間延びしすぎない
- first viewportに Header + compactなレポートカード + 重要ニュース入口が見える
- レポートカードは画面高の半分未満

### Report card

採用済み構成:
- TODAY'S REPORT
- 今日のかぶモリレポート
- 「今日のポイント」動的2〜3件、各1〜2行
- 右側に独立したキャラクター領域
- 下部CTAは1つだけ「レポートを見る →」
- 各ポイントに個別chevron不要

キャラクター:
- 将来、正本準拠のミニゆめちゃん＋白ロボ（指差し棒）を差し替える独立領域
- repoには現在approved standalone cutout assetが無い
- **新しいキャラを勝手に生成/捏造しない**
- 現在の大きな丸+🌱 fallbackは構想と見た目が離れるため、asset未確定中はレイアウトを壊さない控えめなneutral placeholderまたは空き領域にする
- character assetの完成は別TASKでよい

### Important news

- 最大3件
- サムネイル / category fallback visual
- category
- headline
- update time
- importance
- 現状の単純な★/glyphだけの見え方より、v3の情報階層に寄せる
- 本物のthumbnail URLがsourceに無ければ捏造しない。category fallback visualでよい。

### Holding news

- 約3件
- 最新ニュースがある保有銘柄のみ
- compact card/list
- empty stateは誠実に表示

### Today's topic

Home card:
- level badge
- title
- 2〜3行程度のpreview
- カード全体または明確なCTAをtap可能
- 「詳しく読む →」を表示してよい
- dead button禁止

Detail:
- tapで独立した詳細画面へ遷移
- Homeと同じtopicを表示
- level / category / title / summary
- **同じ50文字前後のbase_textだけを大きく表示して終わりにしない**
- ちゃんと学べる読み物として、複数段落/ポイント/注意点が読めること

Current `public.tips.base_text` audit:
- active 50件
- 初級: median約52.5文字、max 66
- 中級: median約50文字、max 55
- 実践: median約51文字、max 56
つまりUIのnumberOfLinesだけが原因ではなく、正本データ自体が短い。

### Topic detail content — Phase 1 source-only design

このTASKでは、DB schema/production mutationを増やさず進める。

Preferred:
- current seed tipsを正本にした静的・curatedな詳細解説catalogをapp sourceに追加
- seed titleをstable keyとして使い、現在の全50topicをcoverage
- detailは1topicあたり単なる言い換えではなく、目安として:
  - ひとことで
  - なぜ大事か
  - 見るときのポイント
  - 注意点
  のような2〜4セクション
- 200〜450字程度を目安に、初心者/中級/実践の深さに合わせる
- 売買推奨にしない
- リアルタイム相場/価格を捏造しない
- sourceにない「現在の市場状況」を足さない
- evergreen educational contentに限定
- current seed title全件がdetail catalogに存在するtestを作る
- 未知titleはbase_textのみでfail-softし、架空の詳細を生成しない

HomeTopic contract:
- RPCが既に返している `id` / `category` を捨てず保持するよう拡張してよい
- detail routeでは今日選ばれたtopicを安全に再取得/検証し、別topicへ化けないこと
- 新しいDB RPCは原則作らない
- 既存daily-topic RPCを level + JST date で再利用し、id一致確認する方式を優先

### Ask AI Home section

採用済みv3:
- 入力欄風のentry:
  `気になるニュースや銘柄について聞いてみる…`
- 質問chip
- AI route/serviceがまだ無いなら「実際に送れた」ように見せない
- 現状の大きいdisabled「準備中です」CTAでカードを縦に膨らませない
- no fake chat

### Bottom navigation — approved final items

現状実機:
- ホーム
- 銘柄
- ポート
- レポート
- 重要ニュース

これは採用済み構想と不一致。

approved:
- ホーム
- 銘柄
- レポート
- AIに聞く
- 設定

Requirements:
- `portfolio` と `news` のroute自体を勝手に削除しない
- Home/news links等から既存画面へ行ける状態は維持
- bottom tab triggerだけをapproved 5項目へ合わせる
- AI未完成なら専用routeはhonest「準備中」screenでよい。dead crash routeは禁止。
- 設定は専用screen/tabへ移す方向を優先する

## Settings safe-area — P1 usability fix

Current real-device issue:
- SETTINGS / 設定 header
- 「閉じる」
がiPhone status bar（時計・通信・電池）へ侵入し、ボタン操作不能。

This is release-blocking UX.

Preferred fix:
- SettingsをModal sheet依存からtop-level Settings screen/tabへ移す
- approved bottom tab「設定」と整合させる
- Home右上「設定」も `router.push/navigate('/settings')` 等で同じscreenへ送る
- main Settings screenなら「閉じる」自体を不要にしてよい
- Topic level / account deletion等のsubviewは戻る操作をsafe area内に置く

If Modalを残す場合:
- `SafeAreaView`だけに依存せず、outer providerから `useSafeAreaInsets()` で取得したtop insetを明示反映
- header/controlの最上端が必ず `insets.top + 8〜12px` 以降
- iPhone Dynamic Island/notchで操作可能

Acceptance:
- 390x844系 / notch・Dynamic Island相当の実機でheader/buttonがstatus barに1pxも重ならない
- tap target min 44pt
- scroll content first rowもheader下から始まる

## Mandatory startup / isolation

1. fresh independent G1 worktree/check-out
2. fresh `origin/main`
3. read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - `src/app/index.tsx`
   - `src/components/home/report-highlight-card.tsx`
   - `src/components/home/home-news-section.tsx`
   - `src/components/home/topic-card.tsx`
   - `src/components/home/ask-ai-entry.tsx`
   - `src/components/settings-sheet.tsx`
   - `src/components/app-tabs.tsx`
   - `src/lib/home-topic.ts`
   - `src/lib/daily-topic.ts`
   - current topic seed migrations
4. G2 owns market-report-analysis. Do not touch it.
5. no MIC/X/important-news ingestion/backend changes.

## Scope / allowed

Allowed:
- Home presentation/layout correction
- AppTabs trigger correction
- Settings route/screen refactor
- topic detail route
- static curated topic-detail source catalog
- HomeTopic contract extension for id/category
- focused tests

Forbidden:
- production DB/schema/data mutation
- new Supabase migration unless a hard blocker is proven; if needed STOP and report before creating/applying
- new OpenAI/LLM API call
- news backend/API changes
- report backend changes
- G2 files
- character image generation
- App Store/TestFlight production release

## Tests / verification

Required:
- focused topic tests
- static detail catalog coverage for all current 50 seeded titles
- unknown topic fail-soft
- Home topic -> detail navigation contract
- same date+level same topic/id
- Settings safe-area/layout contract where testable
- settings account deletion/password/topic-level regression
- Home report/news/topic regression
- AppTabs exact approved labels/order test
- no deletion of portfolio/news routes
- `npx tsc --noEmit` (separate pre-existing unrelated errors)
- `npx expo config --json`
- iOS/web export where safe
- `git diff --check`

Create a narrow PR.
Do not self-merge.
No Codex review expected if this remains UI/navigation/static-content source-only.

## Required report

- fresh main SHA
- worktree/branch
- root cause of Home visual drift
- exact v3 corrections
- topic detail architecture
- detail catalog coverage count
- Settings safe-area root cause + exact fix
- bottom nav before/after
- changed_files
- tests
- production mutation=0
- PR/head SHA
- real-device QA still required items
- remaining issues
- next recommendation

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

## Archived predecessor task

# Claude Task 1

- task_id: kabumori-daily-topic-real-device-qa-20260929
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（中）
- purpose: productionでliveになった「今日のトピック」機能を、fresh mainのiOS内部配布ビルドで実機確認できる状態にし、ユーザーが初心者/中級/上級の切替とHome表示を最終確認できるようにする。

## Context

Completed predecessor:
- PR #48 source implementation merged
- PR #51 migration filename collision fix merged
- production RPC `public.get_daily_kabumori_tip(text,date)` is live
- production ACL/RLS/determinism/read-only verification PASS
- authenticated DB-role call PASS, anon denied
- no Codex review needed

Remaining gate:
- real iPhone visual/settings QA

## Goal

Prepare the safest current-main iOS nonproduction/internal build for the user and verify as much as possible without touching production configuration.

User-facing QA target:
1. Home「今日のトピック」が実データを表示する
2. Settingsで
   - 初心者向け
   - 中級者向け
   - 上級者向け
   を切り替えられる
3. Homeへ戻ると選択したレベルのtopicに変わる
4. 同じ日・同じレベルでpull-to-refreshしてもtopicが変わらない
5. エラー/準備中へ誤表示しない
6. report/news sectionsを壊していない

## Mandatory startup / isolation

1. Use a fresh independent G1 worktree/checkout.
2. Fresh-fetch `origin/main`; record SHA.
3. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - `app.json`
   - `eas.json` if present
   - `src/app/index.tsx`
   - `src/components/settings-sheet.tsx`
   - `src/components/home/topic-card.tsx`
4. Confirm fresh main contains the merged daily-topic source and renamed migration.
5. Do not touch G2/market-report-analysis or any X/MIC/news workstream.

## Phase A — preflight

Read-only / non-destructive checks only:

- EAS/Expo login status
- project linkage / projectId
- iOS bundle identifier
- available nonproduction/internal build profile
- required `EXPO_PUBLIC_*` variable presence for the selected build environment
- signing/device-registration readiness
- whether an already-existing internal build at the current main SHA can be reused

Do not display secret values. Presence only.

If a current-main compatible internal build already exists and is installable, prefer reuse instead of spending a new build.

If no reusable build exists, create exactly one safest nonproduction/internal iOS build.

## Build constraints

Allowed:
- one EAS internal/preview iOS build from fresh main if needed
- read-only EAS/Expo metadata checks
- build-status polling at reasonable intervals
- install URL/QR information for the user

Forbidden:
- App Store submission
- production App Store release
- TestFlight production rollout unless already the project's normal internal nonproduction path and explicitly safe
- changing bundle identifier/projectId
- changing EAS production secrets/env
- Supabase mutation
- database migration/DDL/DML
- Auth/SMTP config mutation
- source changes unless a concrete build blocker is found

If a source/config change is required:
- STOP
- report blocker
- do not patch and build ad hoc

## Automated verification before build/reuse

Run focused checks from fresh main:
- daily-topic tests
- settings-menu/dashboard tests
- Home regression tests relevant to report/news/topic
- `npx tsc --noEmit` and distinguish known pre-existing unrelated errors
- `npx expo config --json`
- `git diff --check`

No Codex review required for this QA-only task.

## User real-device QA checklist

When the build is ready, report a concise exact checklist for the user:

### A. Default beginner
- launch/sign in
- Home topic shows `初心者向け`
- title/body are real content, not 準備中

### B. Change to intermediate
- Settings -> 今日のトピック -> 中級者向け
- return Home
- badge/content becomes 中級者向け

### C. Change to advanced
- same flow -> 上級者向け
- Home reflects 上級者向け

### D. Determinism
- pull-to-refresh twice on same day at same level
- same topic title remains

### E. Regression
- 今日のかぶモリレポート still renders
- 重要ニュース still renders
- 保有銘柄最新ニュース still renders
- no fatal error/red screen

The user will perform the physical iPhone checks; do not claim them PASS until the user reports the result.

## Completion / K1

Report:
- fresh main SHA
- worktree
- EAS project/profile used
- whether reused existing build or created one new build
- build id/url/status
- signing/device registration result
- env presence checks (names/presence only, never values)
- automated test results
- source changes: expected 0
- production mutation: 0
- exact user QA checklist
- remaining issues

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

If build requires user interaction (device registration, Apple login, credential prompt), STOP and report exactly one next action.

## Archived predecessor record

# Claude Task 1

- task_id: kabumori-daily-topic-prod-apply-verify-20260928
- owner: claude
- slot: claude-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- purpose: merged/reviewed daily-topic RPCをproductionへ1本だけ安全に反映し、ACL・RLS境界・determinism・アプリ契約をread-back/smokeで確認する。広範なmigration pushは禁止。

## Predecessor / K1 disposition

Predecessor task:
- `kabumori-daily-topic-prod-rollout-preflight-20260928`

K1 verdict:
- **PASS**
- PR #51 reviewed head `164485bef39c42164f9a69670d6087f7735f2bea`
- pure rename only: `20260928120000_add_daily_kabumori_tip_rpc.sql` -> `20260928123000_add_daily_kabumori_tip_rpc.sql`
- GitHub compare: status `renamed`, 0 additions / 0 deletions / 0 changes
- exact raw file content equality independently confirmed by ChatGPT
- PR #51 merged -> `4c07a81702c36f95bd26acdccd68a137d8bd5eea`
- production mutation before this task: 0

Additional K1 production read-only check by ChatGPT:
- remote migration history contains neither `20260928120000` nor `20260928123000`
- `public.get_daily_kabumori_tip(text,date)` currently **does not exist** in production
- MIC Phase 3A tables **do exist** in production even though that migration version is not recorded remotely
- therefore production has pre-existing migration-history drift for MIC/out-of-band-applied DDL
- this is not a reason to alter MIC now, but it makes broad `supabase db push` unsafe for this task

Repository note:
- a separate older duplicate migration prefix `20260922090000` also exists in main. It is unrelated to daily-topic and must not be modified here.
- the daily-topic target prefix `20260928123000` itself is unique.

## Mandatory startup / isolation

1. Use an independent G1 worktree/checkout.
2. Fresh-fetch `origin/main`; record exact SHA.
3. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - `supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`
4. Confirm the migration bytes still match the independently reviewed SQL from PR #48 / PR #51.
5. Do not touch G2, MIC, important-news, X, Auth, cron, Vault, or other migrations.

## Production rollout scope

This task authorizes **only** the exact daily-topic RPC/grants represented by:

`supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`

Expected function:
`public.get_daily_kabumori_tip(text,date)`

Expected semantics:
- SECURITY DEFINER
- `search_path = ''`
- read-only SELECT over fully-qualified `public.tips`
- active tips only
- beginner/intermediate/advanced -> 初級/中級/実践
- invalid level -> zero rows
- deterministic by JST date + level
- returned columns only: id,title,category,base_text,difficulty
- PUBLIC/anon EXECUTE denied
- authenticated EXECUTE allowed
- no direct authenticated SELECT grant on `public.tips`

## Critical apply constraint

**Do NOT run broad migration tooling that would apply other pending/untracked migrations.**

Forbidden:
- `supabase db push` over the repository migration set
- `--include-all` broad apply
- migration-history repair
- marking unrelated migrations applied
- applying MIC migration
- applying any migration other than the exact daily-topic SQL
- editing production data

Use only a mechanism that can prove it applies the exact reviewed daily-topic SQL and nothing else.

If your available tooling cannot guarantee one-file / exact-SQL scope:
- STOP before mutation
- report the safest available options for K1
- do not improvise a broad push

## Required pre-apply read-only checks

Immediately before mutation:
- fresh production read of `to_regprocedure('public.get_daily_kabumori_tip(text,date)')`
- confirm it is still absent
- confirm `public.tips` exists
- confirm current table-level privileges for anon/authenticated/service_role
- confirm no direct authenticated SELECT has appeared
- record current remote migration-history tail
- confirm target SQL content hash/bytes

If any unexpected daily-topic RPC already exists or privileges drift:
- STOP before applying and report.

MIC's existing out-of-band objects are informational only; do not modify them.

## Apply

Apply exactly the reviewed daily-topic SQL once.

No edits to SQL are allowed during apply.

No other DDL/DML.

## Required post-apply read-back

Verify from production:

1. Function exists with exact signature.
2. `prosecdef = true`.
3. function config includes empty search_path.
4. function body/source references only intended tips selection logic.
5. EXECUTE:
   - authenticated = yes
   - anon = no
   - PUBLIC = no
6. `public.tips` direct SELECT:
   - authenticated = no
   - anon = no
   - existing service_role access unchanged
7. No table/RLS/policy changes occurred.
8. Function is read-only in behavior:
   - capture `use_count` / `last_used_at` for sampled returned tips before/after repeated calls and show unchanged, if those columns exist.
9. Functional smoke:
   - beginner returns active 初級
   - intermediate returns active 中級
   - advanced returns active 実践
   - invalid level returns zero rows
   - same date + same level repeated calls return same row
   - no row case, if safely testable without mutating production data, otherwise do not manufacture one
10. Returned columns are only id,title,category,base_text,difficulty.

Do not expose full tip catalog unnecessarily; use minimal rows/aggregates for verification.

## App-level verification

No new app source change is expected.

After RPC is live:
- verify authenticated client contract can call the RPC with today's JST date
- if a safe existing test account/session is already available, perform non-destructive smoke for beginner/intermediate/advanced
- do not create/delete users just for this task
- real-device visual QA may remain a later user-facing step if no safe device/session is available

## Safety

Absolutely forbidden:
- G2 shared market-report changes
- MIC changes
- important-news changes
- X/social-mobile changes
- Auth/RLS policy redesign
- cron/settings changes
- table data edits
- migration-history repair
- broad migration apply
- source changes unless required to correct a concrete rollout blocker; if source change becomes necessary, STOP and return to K1 instead of patching production ad hoc

## Completion / K1

Report:
- fresh main SHA / worktree
- exact apply mechanism used
- exact SQL hash/bytes proof
- pre-apply read-only state
- production mutation performed
- post-apply function/ACL/RLS readback
- smoke results
- migration-history state after apply
- any drift noted
- app/client smoke if available
- production mutation scope
- remaining issues
- next recommendation

Then:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

No Codex review is expected if the exact independently-reviewed SQL is applied unchanged and all production read-backs pass.

## Archived predecessor record

# Claude Task 1

- task_id: kabumori-daily-topic-prod-rollout-preflight-20260928
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: PR #48でmerge済みの「今日のトピック」RPCをproductionへ安全に反映する前提を整える。まずmain上のmigration version衝突を解消し、内容が独立レビュー済みSQLと完全一致することを証明してPR化する。production applyはこのPhaseではまだ行わない。

## Context

Completed predecessor:
- task: `kabumori-daily-topic-level-settings-20260928`
- PR #48 reviewed head: `98732bf36b79190d52e6bca779fd19a7eb2b8a33`
- merged to main: `9ccbb59da2b6c48b0022ec2a31305a69262c2966`
- independent separate-Claude DB/RPC review: PASS
- P1/P2/P3 findings: none
- production migration apply: not yet performed

The reviewed migration SQL is:
- `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql`

A new preflight issue was found after merge:
- `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql`
- `supabase/migrations/20260928120000_mic_scenario_layer_phase3a.sql`

share the same migration version prefix `20260928120000`.

This must be resolved before any production migration tooling is used.

## Mandatory startup / isolation

1. Use a new independent G1 worktree/checkout. Do not reuse the shared checkout or G2 worktree.
2. Fresh-fetch `origin/main`; record exact start SHA.
3. Read:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - both colliding migration files
4. Confirm no other slot is modifying either migration filename/content.
5. G2 currently owns `market-report-analysis` production observation. Do not touch its worktree, function, gates, cron, or settings.

## Phase A — migration-version collision fix only

### Required action

Rename ONLY the daily-topic migration to a fresh, unique, unused migration timestamp prefix.

Current:
`20260928120000_add_daily_kabumori_tip_rpc.sql`

Target:
- choose a new unused timestamp after checking fresh main's full `supabase/migrations` directory;
- keep the suffix `add_daily_kabumori_tip_rpc.sql`;
- do not rename or edit the MIC migration.

### Hard invariant: SQL bytes must not change

The SQL content of the daily-topic migration must remain byte-for-byte identical to the independently reviewed/merged SQL from PR #48.

Before and after rename:
- compute SHA-256 of file contents;
- hashes must match exactly;
- no whitespace/comment/content edits are allowed.

### Production preflight — read-only only

Before opening the rename PR, inspect production migration history / live function existence read-only.

Confirm:
- whether version `20260928120000` is present in production migration history;
- whether `public.get_daily_kabumori_tip(text,date)` already exists;
- whether the MIC Phase 3A objects/migration are already present.

If production state is ambiguous, if the shared version has already been recorded in a way that makes renaming unsafe, or if the daily-topic RPC is already live unexpectedly:
- STOP;
- do not repair migration history;
- do not apply/drop/recreate anything;
- report exact read-only findings for K1.

### Explicitly forbidden in Phase A

- no `supabase db push`
- no migration apply
- no migration-history repair
- no production DDL/DML
- no RPC create/drop/replace in production
- no Edge deploy
- no cron/settings/Auth/RLS/Vault/X changes
- no MIC migration/content changes
- no G2 changes

## Verification

Required:
- fresh-main migration filename uniqueness check after rename
- old path absent / new path present
- SQL SHA-256 before == after
- git diff must show rename-only for migration source
- `git diff --check`
- no source/app behavior changes
- production mutation = 0

Create a narrow PR for the rename only.

Do not self-merge.

## Completion / K1 gate

When Phase A is complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1

ChatGPT will verify the rename-only PR and merge it if safe.

After that, a continuation task will authorize the exact production migration apply + ACL/readback/smoke checks.

No Codex review is expected for this rename-only phase.

## Required Report

Include:
- fresh main SHA
- independent worktree path / branch
- all colliding migration filenames found
- production read-only migration-history/function preflight
- old migration path
- new migration path
- SHA-256 before rename
- SHA-256 after rename
- proof hashes are identical
- exact diff summary
- tests/checks
- production mutation = 0
- PR number/head SHA
- remaining issues
- next recommendation

## Report — G1 result (Phase A: migration-version collision fix)

- task_id: kabumori-daily-topic-prod-rollout-preflight-20260928
- fresh main SHA at start: `db6fa5c`
- independent worktree/branch: scratch clone, branch `claude/daily-topic-migration-rename-20260928`
- **result: rename-only PR opened. Not self-merged. No production mutation.**

### Colliding migration filenames found

- `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql` (mine, from PR #48)
- `supabase/migrations/20260928120000_mic_scenario_layer_phase3a.sql` (unrelated MIC task, untouched)

### Production read-only preflight

`supabase migration list --project-ref wsmznyzcvmuitkglfeuj` (read-only; no `db push`/apply): the two most recent entries in the remote migration history are both `{"local":"20260928120000","remote":""}` — **version `20260928120000` is not present in production's applied-migration history, for either colliding file.** No migration-history repair needed.

A deeper check specifically confirming `public.get_daily_kabumori_tip(text,date)` and the MIC Phase 3A objects don't already exist via some other path was attempted (`supabase db dump --project-ref ... --schema public`, still read-only) but was **blocked by this session's own safety classifier ("Production Reads")**, not by any ambiguous or concerning data. I did not attempt to route around it with another tool, per the denial's own instructions. Flagging this gap honestly: the migration-history evidence is strong on its own (this codebase's only path to creating these objects is a tracked migration, and neither is recorded as applied), but I could not independently verify function/object non-existence myself. Recommend K1 or the user do that specific check (their own access, or explicitly granting this session a Bash permission rule) before authorizing the actual production apply in the follow-up task — not before merging this rename, which touches no production state at all.

### Rename

- Old path: `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql`
- New path: `supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`
- Chosen timestamp verified unused against fresh main's full `supabase/migrations/` listing (97 files) before renaming.

### SHA-256 proof

- Before: `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1`
- After: `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1`
- **Identical.**

### Diff summary

`git diff --stat`: 1 file changed, 0 insertions(+), 0 deletions(-). `git diff` shows a pure `rename from` / `rename to` with `similarity index 100%` — no content, whitespace, or comment change of any kind.

### Tests / checks

- Fresh-main migration filename uniqueness re-checked after rename: no duplicate prefixes remain anywhere in `supabase/migrations/`.
- Old path absent, new path present — confirmed via `ls`/`git status`.
- `git diff --check` — clean.
- No source/app (`src/`) file touched; no MIC migration touched; no G2 file/worktree touched.

### Production mutation

**0.** No `supabase db push`, no migration apply, no migration-history repair, no DDL/DML, no Edge deploy, no cron/settings/Auth/RLS/Vault/X change.

### PR / head SHA

- PR: https://github.com/anohi-memories/kabumori/pull/51
- Head: `164485b` on `claude/daily-topic-migration-rename-20260928`
- Base: fresh `main` at `db6fa5c`
- **Not self-merged.**

### Remaining issues

1. The direct schema-level confirmation that `get_daily_kabumori_tip`/MIC Phase 3A objects aren't already live was blocked by this session's safety classifier — see preflight note above. Recommend resolving before the production-apply follow-up task, not before merging this rename.
2. No Codex review expected for this rename-only phase, per the task's own instruction.

### Next recommendation

K1 verifies the rename-only PR and merges if safe. A continuation task can then authorize the actual production migration apply + ACL/readback/smoke checks, ideally after the function/object-existence gap above is closed by someone with production-read access.

## Report — G1 result (production apply: STOPPED before mutation)

- task_id: kabumori-daily-topic-prod-apply-verify-20260928
- fresh main SHA at start: `4d308af`
- worktree/branch: independent scratch checkout (read-only preparation only; no branch was created, since no source change was made)

### Exact apply mechanism identified (not yet used)

`supabase db query --project-ref wsmznyzcvmuitkglfeuj --file supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql` — this executes exactly that one file's SQL against the database via a direct query, with no interaction with the migration-history tracking table and no possibility of pulling in other pending migrations. This satisfies the task's "mechanism that can prove it applies the exact reviewed daily-topic SQL and nothing else" requirement, and avoids `supabase db push`'s broad-apply risk entirely. **Caveat for K1**: because this bypasses the migration-history mechanism, `supabase migration list` will still show `20260928123000` as unapplied remotely even after a successful apply this way — expected, not a bug, and consistent with the pre-existing MIC migration-history drift K1 already flagged as informational.

### Target SQL hash/bytes proof

`supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql` on fresh main (`4d308af`): SHA-256 `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1` — **identical** to the hash recorded and independently verified through PR #48 and PR #51.

### Pre-apply read-only checks: BLOCKED, not performed

I attempted the mandated pre-apply read-only check (`to_regprocedure('public.get_daily_kabumori_tip(text,date)')` / `to_regclass('public.tips')` via `supabase db query`, read-only SELECT, no mutation) and it was **refused by this session's own auto-mode safety classifier under the "Production Reads" category** — the same category that blocked the schema-dump check in the predecessor task. I did not attempt to route around it with a different tool, host, or encoding, per the denial's own explicit instructions.

**None of the mandated pre-apply checks were performed**:
- `to_regprocedure('public.get_daily_kabumori_tip(text,date)')` absence — not confirmed
- `public.tips` existence — not confirmed (already known from prior tasks, but not freshly re-confirmed as required)
- current table-level privileges for anon/authenticated/service_role — not confirmed
- no direct authenticated SELECT has appeared — not confirmed
- current remote migration-history tail — not re-recorded fresh for this task (last known from the predecessor task's report only)

### Production mutation performed

**0. No apply was attempted.** The task's own instruction is explicit: "If any unexpected daily-topic RPC already exists or privileges drift: STOP before applying and report" and "If your available tooling cannot guarantee one-file / exact-SQL scope: STOP before mutation; report the safest available options for K1; do not improvise a broad push." Since I could not even perform the mandated pre-apply confirmation that nothing has drifted, applying anyway would directly violate this task's own safety gate — independent of my session's tooling restriction, I would not have proceeded past this point regardless.

### Why this happened (both this task and its predecessor)

This session runs under a local safety layer that blocks any direct production-database read or write by default ("Production Reads" / presumably an equivalent "Production Writes" category for the apply step, untested since I stopped before reaching it). This is separate from the project's own K1/Codex review process and from Supabase access itself being configured (the CLI is authenticated and the project is reachable — `supabase migration list --project-ref` succeeded earlier in the predecessor task, which is apparently categorized differently from `db query`/`db dump`).

### Remaining issues

1. Someone with this restriction lifted — the user directly, or a session with different permission settings — needs to either (a) perform the pre-apply checks + apply themselves (Supabase SQL editor or CLI, using the exact `supabase db query --project-ref wsmznyzcvmuitkglfeuj --file supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql` command identified above), or (b) grant this session a Bash permission rule covering Supabase production reads/writes so a future G1 pass can complete this task end-to-end.
2. The exact reviewed SQL is ready and hash-verified; nothing about the SQL itself is in question. This is purely a tooling-permission blocker, not a content or safety concern about the migration itself.

### Next recommendation

Route this to the user for an explicit decision: either they run the apply themselves using the exact command/file identified above (with the pre-apply checks first), or they extend this session's permissions so G1 can complete Phase B end-to-end in a future pass. Not recommending any workaround within this session.


## Final K1 / ChatGPT production apply completion

- result: **PASS**
- production apply completed by ChatGPT after Claude stopped at the safety gate.
- source used: current-main exact file `supabase/migrations/20260928123000_add_daily_kabumori_tip_rpc.sql`
- GitHub blob SHA: `b383c31af29d64cb47afd5a3eb8446ca9deff398`
- SQL length observed at apply: 1943 bytes/chars as returned by GitHub connector; content was fetched directly from main and passed unchanged to the production SQL executor.
- reviewed SHA-256 from PR #48/#51 remained `425f1e33276c8766a223775f56cd15e79aa551fd87ab0603c1fef020f04872e1`.

### Fresh pre-apply read-only state

Production project: `wsmznyzcvmuitkglfeuj`

Confirmed immediately before apply:
- `public.get_daily_kabumori_tip(text,date)`: absent
- `public.tips`: present
- authenticated direct SELECT on tips: false
- anon direct SELECT on tips: false
- service_role SELECT on tips: true
- tips RLS enabled: true
- remote migration history still ended at the existing tracked migrations; neither `20260928120000` nor `20260928123000` was recorded

### Exact production mutation

Executed exactly the contents of the reviewed daily-topic SQL file through the Supabase SQL execution connector.

No broad migration push.
No other migration.
No migration-history repair.
No table data edit.
No MIC/G2/news/X/Auth/cron/settings/Vault change.

### Post-apply production read-back

Function:
- exact signature exists: PASS
- SECURITY DEFINER: `prosecdef=true`
- volatility: stable
- function config: empty search_path
- function ACL: owner + authenticated only
- authenticated execute: true
- anon execute: false
- PUBLIC execute: absent from ACL
- authenticated direct SELECT on `public.tips`: false
- anon direct SELECT on `public.tips`: false
- service_role SELECT on `public.tips`: true
- tips RLS: still enabled
- tips policy count: 0
- body references `public.tips`, filters `t.is_active`, and contains no INSERT/UPDATE/DELETE
- returned table columns verified from output arg metadata: id/title/category/base_text/difficulty only

Role-level proof:
- `SET LOCAL ROLE authenticated` call returned exactly one beginner/初級 row
- `SET LOCAL ROLE anon` call failed with PostgreSQL 42501 permission denied for function

Functional smoke for JST date 2026-09-28:
- beginner -> 1 row, 初級
- intermediate -> 1 row, 中級
- advanced -> 1 row, 実践
- invalid `expert` -> 0 rows
- repeated same date + same beginner level -> same id

Read-only behavior proof:
- sampled tip had `use_count=2` and unchanged `last_used_at` before repeated RPC calls
- after repeated calls, both values remained exactly unchanged

### Migration-history note

Because the task intentionally used exact direct SQL execution rather than broad migration tooling, remote migration history still does not record local version `20260928123000`.

This is consistent with the already-known production migration-history drift (including MIC objects that exist out-of-band). Do not run a broad `supabase db push` until migration-history hygiene is handled in a dedicated task.

No migration-history repair was performed here.

### Production mutation scope

Only:
- create/replace `public.get_daily_kabumori_tip(text,date)`
- revoke EXECUTE from PUBLIC/anon
- grant EXECUTE to authenticated

Nothing else.

### Remaining issues

1. Authenticated database-role smoke passed; real-device visual/settings interaction remains a later UI QA step.
2. Production migration-history drift remains an infrastructure hygiene item and is not repaired by this task.
3. Broad `db push` remains unsafe until that drift is reconciled deliberately.

### Final disposition

Daily-topic backend is now live in production and the reviewed security/behavior contract passed production read-back.

No Codex review required; exact independently-reviewed SQL was applied unchanged.

Task closed.

## Report — G1 result (daily-topic real-device QA build ready)

- task_id: kabumori-daily-topic-real-device-qa-20260929
- fresh main SHA at start: `6b59c3f`
- worktree/branch: independent scratch checkout (no source change needed, so no branch was created/pushed)

### Phase A preflight (read-only)

- EAS/Expo login: `anohi-memories` (voxy1948.p3@gmail.com), Owner on both `anohi-memories` and `anohi-memoriess-team` accounts.
- Project linkage: `@anohi-memoriess-team/kabumori`, ID `eb80adf3-861e-4a48-a373-2d9a85b58899`.
- Bundle identifier: `com.anohimemories.kabumori`.
- `EXPO_PUBLIC_*` presence in the `preview` environment: **both present** (`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_SUPABASE_URL`) — names only, values never displayed.
- Signing/device registration: existing Ad Hoc distribution certificate (expires 2027-09-10) and provisioning profile (Developer Portal ID `5M79MS9DFQ`, already covering the registered iPhone) — both reused, no new credentials generated, no device-registration/Apple-login prompt needed.
- Reusable-build check: the two most recent `preview` builds (`10e8610e...` at commit `f04ccf35...`, `79955c92...` at commit `12db8657...`) both predate PR #46/#48/#51 — **neither contains the daily-topic client code (Home reorg, topic card, settings level picker)**. No reusable build existed; created exactly one new build per the task's instruction.

### Automated verification (before build)

- `deno test` on daily-topic/settings/dashboard/Home regression suite: **52/52 pass** (`home-topic_test.ts`, `settings-menu_test.ts`, `dashboard_test.ts`, `home-report-highlights_test.ts`, `home-news-sections_test.ts`, `home-news-visual_test.ts`).
- `npx tsc --noEmit`: 0 new errors under `src/` (same 2 pre-existing, unrelated CSS-module errors as `main`).
- `npx expo config --json`: resolves cleanly.
- `git diff --check`: clean (fresh clone, no diff).

### Build

| Field | Value |
| --- | --- |
| Platform | iOS |
| Profile | `preview` (internal distribution) |
| Status | **finished** |
| Build ID | `9f0e45a1-b2ec-4631-b04b-b510f90a475d` |
| Source commit | `6b59c3f722811dd76b8e8d9a7435c5604097c494` (fresh main at task start; contains the merged daily-topic feature + migration rename) |
| Bundle identifier | `com.anohimemories.kabumori` |
| Distribution certificate / provisioning profile | existing, reused — **no new credentials generated** |
| Started / finished | 2026-09-29 10:07:09 / 10:12:50 |
| Install link | https://expo.dev/accounts/anohi-memoriess-team/projects/kabumori/builds/9f0e45a1-b2ec-4631-b04b-b510f90a475d |

### Source changes

**0**, as expected — no blocker was found requiring a source/config change.

### Production mutation

**0.** No Supabase mutation, no migration/DDL/DML, no Auth/SMTP config change, no EAS production secret/env change, no bundle identifier/projectId change.

### Exact user QA checklist

**A. Default beginner**
1. Install/open the build, sign in.
2. Home's 今日のトピック shows レベル badge 初心者向け with real title/body content (not 準備中).

**B. Change to intermediate**
3. 設定 → 今日のトピック 投資知識レベル → 中級者向け を選択。
4. Home に戻る。
5. バッジ/内容が中級者向けに変わっている。

**C. Change to advanced**
6. 同じ流れで 上級者向け を選択 → Home が上級者向けを反映。

**D. Determinism**
7. 同じ日・同じレベルのまま pull-to-refresh を2回。
8. トピックのタイトルが変わらないまま。

**E. Regression**
9. 今日のかぶモリレポートが表示される。
10. 重要ニュースが表示される。
11. あなたの保有銘柄 最新ニュースが表示される。
12. 致命的なエラー/赤画面が出ない。

I will not mark this checklist PASS myself; it needs the user's own observation on the device, per this task's own instruction.

### Remaining issues

None found. Waiting on the user's real-device confirmation of the checklist above.

### Next recommendation

Send the user the install link and checklist; once they report the result, a final G1 pass records PASS/issues for K1.

## Report — G1 result (home v3 correction: topic detail + Settings safe-area)

- task_id: kabumori-home-v3-topic-detail-safearea-correction-20260929
- fresh main SHA at start: `2cac308`
- worktree/branch: independent scratch checkout, branch `claude/home-v3-topic-detail-safearea-20260929`
- **result: implemented, tested, PR opened. Not self-merged. Production mutation 0.**

### Root cause of Home visual drift

Not a logic bug: the prior redesign (PR #46) kept the approved information order but used more generous padding/type scale and a bold filled-circle+emoji character placeholder than the approved v3 mock, and news rows had no explicit category label. Purely presentation density plus one missing field.

### Exact v3 corrections

- Report hero: padding 18→14, tighter type scale, character slot 64→48.
- Character slot: replaced the filled circle + 🌱 with a quiet empty dashed-outline placeholder (no fill/glyph) until an approved cutout asset exists.
- News rows: added a category label from existing `coverage_categories` data (no new fetch).
- Ask AI entry: replaced the large disabled CTA with a compact input-field-styled row + tappable question chips, all navigating to the new `/ai` screen.

### Topic detail architecture

- `src/lib/topic-detail-catalog.ts`: static, curated, evergreen 4-section (ひとことで/なぜ大事か/見るときのポイント/注意点) detail entries, keyed by the tip's stable `title`. No real-time claims, no buy/sell advice — enforced by a regex guard test. Unknown title → `null`, fails soft to `base_text`.
- `HomeTopic` extended with `id`/`category` (previously discarded from the RPC response).
- `src/app/topic-detail.tsx`: re-fetches via the existing `get_daily_kabumori_tip` RPC with the tapped `(level, jstDate)`, renders only if the returned row's `id` matches the tapped topic's `id` — otherwise an honest mismatch message, never a silently-swapped topic. No new RPC.

### Detail catalog coverage count

**50/50** — verified by an exact string cross-check test against every title in `20260828213000_expand_tips_catalog.sql`'s seed `VALUES` block (not eyeballed), plus a reverse check that the catalog has no titles beyond the current seed.

### Settings safe-area root cause + exact fix

Root cause: Settings was a Modal + `SafeAreaView`. `react-native-safe-area-context`'s inset measurement is unreliable inside RN's own `Modal` (separate native window, outside the tree `SafeAreaProvider` measures) — a known class of issue, not reliably fixable with a `useSafeAreaInsets()` patch either.

Fix (the task's own preferred option): moved Settings to a real top-level screen/tab, `src/app/settings.tsx` — a normal screen in the navigation tree shares the same `SafeAreaProvider` as every other screen and doesn't have this problem. Removed the now-unnecessary "閉じる" button; kept the existing "‹ 設定にもどる" back navigation on the delete-account/topic-level sub-views (already safe-area-correct as plain screen content).

### Bottom nav before/after

- Before: ホーム / 銘柄 / ポート / レポート / 重要ニュース
- After (approved v3): ホーム / 銘柄 / レポート / AIに聞く / 設定
- `portfolio.tsx` and `news/` **not deleted** — confirmed present in the static export (see Tests below). Reachability: news via Home's existing "すべて見る" links (unchanged); portfolio via a new "ポートフォリオ" entry added to Settings.
- `/ai` (new): honest "準備中" screen.

### Changed files (exact)

- New: `src/app/ai.tsx`, `src/app/topic-detail.tsx`, `src/lib/topic-detail-catalog.ts`, `tests/app/app-tabs_test.ts`, `tests/app/topic-detail-catalog_test.ts`
- Renamed: `src/components/settings-sheet.tsx` → `src/app/settings.tsx`
- Modified: `src/app/index.tsx`, `src/components/app-tabs.tsx`, `src/components/home/ask-ai-entry.tsx`, `src/components/home/character-slot.tsx`, `src/components/home/home-news-section.tsx`, `src/components/home/report-highlight-card.tsx`, `src/components/home/topic-card.tsx`, `src/lib/home-topic.ts`, `src/lib/settings-menu.ts`, `tests/app/home-topic_test.ts`, `tests/app/settings-menu_test.ts`

### Tests

- New: `topic-detail-catalog_test.ts` (7 tests), `app-tabs_test.ts` (2 tests).
- Updated: `home-topic_test.ts`, `settings-menu_test.ts`.
- Full regression: **103/103 pass** across all Home/settings/topic/news/report/account-deletion suites.
- `npx tsc --noEmit` — 0 new errors under `src/` (same 2 pre-existing, unrelated CSS-module errors as `main`).
- `npx expo config --json` — resolves cleanly.
- `npx expo export --platform web --clear` — full static export succeeds, **13/13 routes render**, including `/ai`, `/settings`, `/topic-detail`, and confirming `/portfolio`/`/news` still exist.
- `git diff --check` — clean.

### Production mutation

**0.** UI/navigation/static-content source only.

### PR / head SHA

- PR: https://github.com/anohi-memories/kabumori/pull/53
- Head: `e53465f` on `claude/home-v3-topic-detail-safearea-20260929`
- Base: fresh `main` at `2cac308`
- **Not self-merged.**

### Real-device QA still required

This is source-only; actual visual/layout correctness (report card fitting the first viewport, character placeholder reading as intentional, Settings header/buttons clearing the status bar on a real notch/Dynamic-Island device, topic detail readability) has **not** been confirmed on a physical iPhone. This predecessor task was explicitly a QA-fail replacement — I am not marking this PASS myself; a new EAS build + the user's real-device check is still needed.

### Remaining issues

1. Character cutout asset still doesn't exist — placeholder intentionally neutral/empty.
2. Detail catalog covers only the 50 currently-seeded tips; any future tip needs a matching entry or fails soft to short `base_text`.
3. `/ai` remains "準備中"; real AI chat route is a separate future task.
4. Real-device visual QA (see above) not yet performed.

### Next recommendation

K1 review → merge if satisfied → new EAS `preview` build → user real-device QA, checking specifically: report card fits above the fold, character placeholder looks intentional, topic tap opens the detail screen with real multi-paragraph content, Settings fully operable without overlapping the status bar.

## Report — G1 result (home v3 post-merge iOS preview QA build ready)

- task_id: kabumori-home-v3-postmerge-ios-preview-qa-20260929
- fresh main SHA at start: `135dcc9`
- worktree/branch: independent scratch checkout (no source change, so no branch created)
- merge SHA `3b9ca0424e1ef6e079cc852e45ff66d0271c001e` confirmed contained in fresh main via `git merge-base --is-ancestor`, and again in the build's own source commit.

### Phase A — post-merge source verification

- `deno test` on the full listed regression set (home-topic, topic-detail-catalog, settings-menu, app-tabs, dashboard, home-report-highlights, home-news-sections, home-news-visual, news-labels, news-presentation, report-presentation, account-deletion): **103/103 pass**.
- `npx tsc --noEmit`: 0 new errors under `src/` (same 2 pre-existing, unrelated CSS-module errors as `main`).
- `npx expo config --json`: resolves cleanly.
- `npx expo export --platform web --clear`: full static export succeeds, **13/13 routes** (including `/ai`, `/settings`, `/topic-detail`, `/portfolio`, `/news`).
- `git diff --check`: clean (fresh clone, no diff).
- **No source edits made or needed.**

### Phase B — EAS build selection

- EAS/Expo login: `anohi-memories` (voxy1948.p3@gmail.com), Owner on both accounts.
- Project linkage: `@anohi-memoriess-team/kabumori`, ID `eb80adf3-861e-4a48-a373-2d9a85b58899`.
- Bundle identifier: `com.anohimemories.kabumori`.
- `EXPO_PUBLIC_*` presence in `preview`: both present (`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `EXPO_PUBLIC_SUPABASE_URL`) — names only, values never displayed.
- Signing/provisioning: existing Ad Hoc distribution certificate (expires 2027-09-10) and provisioning profile (Developer Portal ID `5M79MS9DFQ`), both reused — **no new credentials generated, no Apple login/device-registration interaction needed**.
- Reusable-build check: latest 3 `preview` builds' source commits (`6b59c3f...`, `f04ccf35...`, `12db8657...`) all predate PR #53's merge (`3b9ca042...`) — confirmed by absence, none is an ancestor-containing commit. The task's own flagged old build (`9f0e45a1...`) was correctly **not reused**. Created exactly one new build.

### Build

| Field | Value |
| --- | --- |
| Platform | iOS |
| Profile | `preview` (internal distribution) |
| Status | **finished** |
| Build ID | `d9ed1da1-9542-45c7-b704-d89eaba9a978` |
| Source commit | `135dcc96c394fba5948a45ea4eca45f7dea5d595` (fresh main at task start; contains PR #53's merge) |
| Bundle identifier | `com.anohimemories.kabumori` |
| Distribution certificate / provisioning profile | existing, reused — **no new credentials generated** |
| Started / finished | 2026-09-29 14:02:27 / 14:07:24 |
| Install link | https://expo.dev/accounts/anohi-memoriess-team/projects/kabumori/builds/d9ed1da1-9542-45c7-b704-d89eaba9a978 |

### Source changes

**0**, as expected.

### Production mutation

**0.** No Supabase mutation, no migration/DDL/DML, no Auth/SMTP config change, no EAS production secret/env change, no bundle identifier/projectId change, no App Store/TestFlight action.

### Exact user QA checklist

**A. Home first viewport**
1. ヘッダーがすっきりしていて大きすぎない
2. 今日のかぶモリレポートがコンパクトで、画面のおよそ半分を占めていない
3. 以前の大きな丸+🌱が無くなっている
4. 重要ニュースの入り口がファーストビュー付近で自然に見える
5. キャラクター領域が壊れたアセットではなく、控えめなプレースホルダーに見える

**B. 重要ニュース / 保有銘柄ニュース**
6. 重要ニュースがデータがある場合およそ3件表示される
7. カテゴリ／タイトル／時刻／重要度の階層が読みやすい
8. あなたの保有銘柄 最新ニュースが存在し、空の場合も誠実に表示される

**C. 今日のトピック**
9. Homeカードにレベルバッジ＋タイトル＋プレビュー＋「詳しく読む →」が表示される
10. カードをタップすると `/topic-detail` が開く
11. 詳細画面はタップした通りの同じトピックを表示する（別の日/レベルのものに化けない）
12. 詳細に「ひとことで／なぜ大事か／見るときのポイント／注意点」など複数の読みやすいセクションがある
13. 戻る操作でHomeへ正しく戻る

**D. Settings safe-area（リリースブロッカー級の確認）**
14. Home右上から設定を開く
15. 下部タブから設定を開く
16. SETTINGS／設定のヘッダーが時計・Dynamic Island・電波・電池と重ならない
17. 上部のすべての操作がタップ可能
18. 投資知識レベルのサブ画面の戻るボタンが完全にsafe area内にある
19. アカウント削除のサブ画面の戻るボタンが完全にsafe area内にある
20. 投資知識レベル（初心者/中級者/上級者）を変更でき、変更が保存される

**E. Bottom navigation**
21. 表示順が正確に: ホーム／銘柄／レポート／AIに聞く／設定
22. ポートと重要ニュースが独立した下部タブとして存在しない
23. 既存のポートフォリオが設定から到達可能
24. 既存のニュースがHomeのリンクから到達可能

**F. 回帰確認**
25. 今日のかぶモリレポートが引き続きその詳細を開ける
26. 重要ニュース／保有銘柄ニュースが引き続き読み込まれる
27. AIに聞くが誠実な準備中画面を開き、偽のチャットにならない
28. ログアウト／パスワード再設定／アカウント削除の設定でクラッシュしない
29. 致命的なエラー/赤画面が出ない

I will not mark this checklist PASS myself; it needs the user's own observation on the device, per this task's own instruction.

### Remaining issues

None found in the automated/read-only checks. Waiting on the user's real-device confirmation of the checklist above.

### Next recommendation

Send the user the install link and checklist; once they report the result, a final G1 pass records PASS/issues for K1.

## URGENT UPDATE — real-device QA FAILED, root cause found and fixed (PR #55)

The user tested build `d9ed1da1-9542-45c7-b704-d89eaba9a978` (reported above as ready) and found: **nothing on the Home screen navigates when tapped.** This is a real, confirmed FAIL of that build's QA checklist, not a false alarm.

### Root cause (confirmed, live-verified in the iOS Simulator)

`expo-router/unstable-native-tabs` (the experimental API `src/components/app-tabs.tsx` used) only registers routes that have a matching `NativeTabs.Trigger` declared inside the same component tree (`useOnlyUserDefinedScreens=true` internally). `app-tabs.tsx` was rendered directly from the root `_layout.tsx`, so any route without its own Trigger there was never registered with the navigator — `router.push()` to it silently does nothing, no error.

PR #53 removed `news`/`portfolio` from the trigger list (to match the approved v3 tab set) and added a new non-trigger route, `topic-detail`. From that point, these all stopped navigating: news rows/`すべて見る`, the topic card, Settings' `ポートフォリオ` entry, and push-notification taps routing to `/news`. `reports/[id]` was unaffected (`reports` itself is still a Trigger). This explains why even previously-working things (news rows, whose own code never changed) appeared broken — their *destination* stopped being registered, not their own logic.

### Fix

Restructured to the standard documented "NativeTabs + Stack" pattern: the 5 real tab screens moved into `src/app/(tabs)/` (with the NativeTabs definition becoming that group's own `_layout.tsx`, triggers/labels/icons unchanged); `news/`, `portfolio.tsx`, `topic-detail.tsx`, `search.tsx` stay as root-level Stack screens via a new `SignedInNavigator` in `src/app/_layout.tsx` (same `<Stack>`-matches-file-routes pattern `news/_layout.tsx`/`reports/_layout.tsx` already used). Deleted `src/components/app-tabs.web.tsx` (dead code, an older pre-v3 implementation nothing imported anymore).

### Live verification (iOS Simulator, Release build, disposable scratch clone with an auth-bypass rig — never touched the shared checkout)

- **Before fix**: confirmed broken exactly as the user described, in a Release build whose bundle was confirmed to contain the current routes.
- **After fix**: `/news`, `/news/[id]`, `/portfolio`, `/topic-detail` all navigate correctly; all 5 bottom tabs still work; `reports/[id]` still works (unaffected, re-verified after the file move).
- Not independently re-verified: `kabumori://search` deep link (not one of the 4 broken navigations, not linked from anywhere in-app).

### New regression test

`tests/app/root-navigator_test.ts`: pins that every route pushed to from outside the tab group is registered as a root Stack.Screen, so a future route addition can't silently reintroduce this bug class.

### Tests / verification

- `deno test tests/app/ --allow-read --no-check` — **187/187 pass**.
- `npx tsc --noEmit` — 0 new errors (same 2 pre-existing, unrelated).
- `npx expo config --json` — clean.
- `npx expo export --platform web --clear` — succeeds, 19 static routes, new `native-tabs.module.css` confirms the built-in web NativeTabs renderer is now in use (replacing the deleted custom one).
- `git diff --check` — clean.

### PR

- **https://github.com/anohi-memories/kabumori/pull/55** — narrow, source-only, not self-merged. **Recommending expedited K1 review given this is release-blocking** (the app was effectively unusable beyond the 5 tab screens themselves).

### Known remaining gap (flagged, not fixed in this PR)

`portfolio.tsx`/`news/index.tsx` have no in-app back button now that they're pushed screens instead of tabs (only iOS edge-swipe works) — a real but lower-severity UX gap versus the navigation-dead regression this PR fixes. Recommend a small follow-up task to add one, matching the pattern already used in `topic-detail.tsx`/`settings.tsx`'s sub-views (`‹ もどる`).

### Production mutation

**0.** Source-only.

### Next recommendation

K1 reviews and merges PR #55 as a priority. Once merged, a new EAS preview build is needed (the existing `d9ed1da1` build must NOT be used for further QA — it's confirmed broken) before the user can re-attempt this task's real-device checklist. I will build it as soon as PR #55 is merged, without waiting for a separate task assignment, given the severity — but will still stop and report rather than self-merge or apply anything to production.

