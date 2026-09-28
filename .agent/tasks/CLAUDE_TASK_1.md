# Claude Task 1

- task_id: kabumori-daily-topic-level-settings-20260928
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- purpose: Homeの「今日のトピック」を実データ化し、設定画面で「初心者向け / 中級者向け / 上級者向け」を選べるようにする。既存のtips資産を再利用し、OpenAI呼び出し・ニュース取得基盤・G2 shared market reportには触れない。

## Product decision

ユーザー確定方針:

- Homeに毎日1件「今日のトピック」を表示。
- ユーザーは設定画面で:
  - 初心者向け
  - 中級者向け
  - 上級者向け
  を自由に選択できる。
- Homeカードには現在のレベルバッジを表示。
- 毎日開いた時に1つ学べる軽いコンテンツ。
- リアルタイム株価やニュース生成とは独立させる。
- このPhaseでは毎日LLM生成しない。既存の安全な学習コンテンツを使い、安定性・コスト0を優先する。

## Important discovery / accepted reuse

repoにはすでに `public.tips` が存在し、約50件の学習コンテンツがseedされている。

既存difficulty:
- `初級`
- `中級`
- `実践`

App表示マッピング:
- `初級` -> `初心者向け`
- `中級` -> `中級者向け`
- `実践` -> `上級者向け`

既存tips migration:
- `20260828190000_create_tips.sql`
- `20260828213000_expand_tips_catalog.sql`

**既存X useful-tip系とは別物として扱うこと。**
`public.useful_tips` / `x-test-post` / useful-tip schedulerは今回のscope外。

## Mandatory startup / isolation

1. G1専用の独立worktree/checkoutを使用。
2. fresh `origin/main` を取得し、開始SHAを記録。
3. 必ず読む:
   - `PROJECT_RULES.md`
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - このTASK
   - `src/components/settings-sheet.tsx`
   - `src/components/home/topic-card.tsx`
   - `src/lib/home-topic.ts`
   - `src/app/index.tsx`
   - tips関連migration
4. G2が `market-report-analysis` production observation中。以下は絶対に触らない:
   - `supabase/functions/market-report-analysis/**`
   - shared report packet / consumer gates / cron
5. ニュース取得強化/API最適化側も触らない:
   - `supabase/functions/important-news-monitor/**`
   - important-news shadow/search/usage/judgement
6. X系:
   - `supabase/functions/x-test-post/**`
   - `public.useful_tips` scheduler logic
   - apps/social-mobile
   を触らない。
7. 他slotのworktree/branch/未コミット変更を触らない。

## Target architecture

### 1. Topic level preference

このPhaseでは、投資知識レベル設定は端末ローカル設定として実装する。

理由:
- onboarding v1ですでにAsyncStorageを安全に利用している。
- DB user-profile schemaを増やさず、今回のtopic機能だけで過剰なserver mutationを避けられる。
- 後日cross-device syncが必要なら別TASKでuser preferencesへ移行可能。

canonical values:
- `beginner`
- `intermediate`
- `advanced`

default:
- `beginner`

versioned key例:
- `kabumori:topic-level:v1`

要件:
- read failure時はbeginnerへfail-soft。
- write failure時は「保存できた」と誤表示しない。
- setting変更後、Homeへ戻った時に新しいlevelが反映される。
- logout/account deletionの意味と衝突しない。local-only preferenceなので、必要ならsign-out時clear要否を監査してReportに明記すること。勝手な広範囲auth変更は禁止。

### 2. Daily topic data source

`public.tips` を正本として再利用。

現在tips tableはservice_role readのみのため、clientへtable-wide selectを開放しないこと。

Preferred:
- narrow read-only RPC migrationを追加
- authenticated userのみexecute可能
- `security definer` + fixed `search_path=public`
- input validation必須
- 返却列は必要最小限:
  - id
  - title
  - category
  - base_text
  - difficulty
- active tipsのみ
- requested difficultyのみ
- 1日1件、JST date + levelに対してdeterministic/stable
- refreshのたびに別topicにならない
- DB write/use_count更新はしない
- user portfolio/news/private dataは一切入力しない

Example semantics:
- `get_daily_kabumori_tip(p_level text, p_jst_date date)`
- allowed level valuesはapp canonicalまたはDB difficultyへ明示mapping
- invalid inputはfail closed
- no rowならnull

実装詳細は既存DB conventionに合わせて最小安全設計にする。

### 3. App client

`src/lib/home-topic.ts` を実データcontractへ拡張。

必要:
- preference read/write helper
- daily topic fetch helper
- DB difficulty -> app level mapping
- typed result validation/fail-soft
- no fabricated topic

Home:
- `TopicCard` に実topicを渡す。
- Home loadにtopic取得を統合。
- 既存news/report sectionと同様、topicだけ失敗してもHome全体を壊さない。
- loading/error/empty stateを明確に分ける。
- pull-to-refresh時も同日・同levelなら同じtopicになること。
- topic取得は1回。不要なpollingなし。

### 4. Settings UI

既存 `SettingsSheet` 内に「今日のトピック」設定を追加。

表示例:
- 今日のトピック
- 投資知識レベル
- 現在: 初心者向け

選択肢:
- 初心者向け
  - 基本用語や仕組みをやさしく
- 中級者向け
  - 指標・需給・決算など一歩踏み込む
- 上級者向け
  - 実践的な材料の読み方や相場とのつながり

要件:
- 明確なselected state。
- 変更は即時保存。
- 保存失敗時は元の状態へ戻すか、未保存を明確に表示。
- accessibility labels。
- 既存 password/legal/logout/account-delete UIを壊さない。

### 5. Topic card presentation

現在のデザイン方向を維持:
- `今日のトピック`
- level badge
- title
- short body
- CTAはこのPhaseで詳細画面が無いならdead buttonを作らない。
- card内で読める長さを優先。
- `base_text` が長すぎる場合は2〜3行に制限してもよいが、内容をAIで要約しない。
- sourceに無い内容を付け足さない。

## Migration / RPC safety

このTASKは **source-only PRまで**。

Allowed:
- 新規migration file
- RPC definition
- app client/helper/UI/tests

Forbidden:
- production migration apply
- Supabase production mutation
- Edge Function deploy
- cron変更
- Auth/RLSの広範囲変更
- direct table grant select to authenticated（RPCで足りるなら禁止）
- service_role privilege拡大
- OpenAI/API call追加
- X/useful-tip scheduler変更

migration/RPCを作った場合は、K1後にCodex reviewが必要。

## Tests

最低限:

### preference
- default beginner
- valid 3 levels read/write
- malformed stored value -> beginner fail-soft
- storage read failure -> beginner
- storage write failure -> success扱いしない

### mapping
- 初級 -> beginner
- 中級 -> intermediate
- 実践 -> advanced
- unknown difficulty -> reject/fail-soft

### daily topic
- same JST date + same level -> same result
- different level -> corresponding difficulty only
- inactive tip excluded
- invalid level rejected
- no row -> honest empty state
- RPC exposes only intended columns/permission contract

### UI/client
- Home topic fetch failure does not break report/news
- settings selected state and change flow
- TopicCard level badge labels
- no fake CTA

### regression
- Home tests from PR #46
- settings/account deletion/auth related focused tests
- `npx tsc --noEmit`
- Expo config
- safe web export/render
- migration SQL lint/static validation if available
- `git diff --check`

## Completion / review gate

- narrow branch + PR.
- do not self-merge.
- production mutation 0.
- if migration/RPC is included:
  - status -> `review_required`
  - next_owner -> `chatgpt`
  - K1でChatGPT確認後、空いているH1/H2へDB/RPC reviewを割り当てる。
- H2は現在deferred既存TASK保護中なので勝手に上書きしない。
- H1がX Auth review中なら競合させない。

## Required Report

- fresh main SHA
- worktree/branch
- existing tips reuse audit
- exact architecture
- local preference design
- migration/RPC exact contract
- grants/RLS/security-definer safety
- changed_files
- tests
- network calls added to Home
- no-LLM/no-news-overlap proof
- production mutation
- PR/head SHA
- remaining issues
- whether Codex DB/RPC review is required
- next recommendation

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- STOP for K1.
