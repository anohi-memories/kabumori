# Claude Task 1

- task_id: kabumori-daily-topic-level-settings-20260928
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
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

## Report — G1 result (daily topic + level settings implementation)

- task_id: kabumori-daily-topic-level-settings-20260928
- fresh main SHA at start: `19c00bf`
- worktree/branch: independent scratch checkout, branch `claude/daily-topic-level-settings-20260928`
- **result: implemented, tested, migration dry-run validated, PR opened. Not self-merged. Includes a new migration/RPC, so Codex DB/RPC review is required before merge.**

### Existing tips reuse audit

`public.tips` (from `20260828190000_create_tips.sql` + `20260828213000_expand_tips_catalog.sql`) already has ~50 seeded rows and a `difficulty text not null` column constrained to `初級`/`中級`/`実践`. RLS is enabled with no policy for `authenticated`; only `service_role` has table-level `select`. Confirmed distinct from `public.useful_tips` (X scheduler) by reading both migrations directly — no overlap, no shared columns beyond superficial naming.

### Exact architecture

1. **Migration/RPC**: `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql` — `get_daily_kabumori_tip(p_level text, p_jst_date date)`, pure SQL, `stable security definer set search_path = ''`. Deterministic pick via `hashtext(date||level) % count` over `row_number() over (order by id)`, filtered to `is_active` and the mapped difficulty. Invalid level → zero rows (fail closed). No write, no `use_count`/`last_used_at` mutation.
2. **Local preference**: `kabumori:topic-level:v1` in AsyncStorage, read/write logic dependency-injected in `src/lib/home-topic.ts` (pure, Deno-tested with an in-memory mock storage — not just regex-matched), bound to real AsyncStorage in `src/lib/topic-level-storage.ts`.
3. **App client**: `src/lib/daily-topic.ts` calls the RPC; `parseDailyTipRow` (pure) validates the shape and rejects anything malformed rather than fabricating.
4. **Home**: `src/app/index.tsx` reads the level, then fetches topic alongside news/reports in one `Promise.allSettled`; topic failure isolated to its own error slot, never breaks the other sections.
5. **Settings**: new "今日のトピック 投資知識レベル" entry in `src/lib/settings-menu.ts` + `TopicLevelView` in `src/components/settings-sheet.tsx`, immediate save with revert-on-failure.
6. **Topic card**: `topicCardStatus` in `home-topic.ts`, mirroring the `reportCardStatus` pattern just fixed on PR #46 — a fetch error is never shown as the "準備中" empty state.

### Local preference design

Read failure or malformed/unrecognized stored value → fails soft to `beginner`. Write failure returns `false`; the Settings UI reverts its optimistic selection and shows "保存できませんでした。もう一度お試しください。" rather than claiming success.

### Migration/RPC exact contract

```sql
get_daily_kabumori_tip(p_level text, p_jst_date date)
  returns table(id uuid, title text, category text, base_text text, difficulty text)
  language sql stable security definer set search_path = ''
```
`revoke all ... from public, anon; grant execute ... to authenticated;` — table stays closed, only the function is callable, only by authenticated users. Returns only the 5 intended columns.

**Deviation flagged**: used `search_path = ''` (fully-qualified `public.tips` references) instead of the task prose's literal `search_path=public`, since `''` is the dominant convention in this repo (46+ occurrences vs 28) and strictly safer. Judgment call — please confirm acceptable.

### Grants/RLS/security-definer safety

- `tips` table: unchanged, still closed to `authenticated`/`anon` (only `service_role` has table-level select, from the original migration).
- Function: `security definer`, owned by the migration-applying role (same pattern as `get_my_important_stock_news`), `set search_path = ''` prevents search-path-based hijacking, every reference fully qualified.
- Grants: `authenticated` can execute; `anon` and `public` explicitly cannot — verified functionally (see dry-run below), not just by reading the SQL.
- No user/portfolio/news data enters or leaves this function; only `p_level` (a fixed 3-value enum) and `p_jst_date` (a date) are accepted, both validated (invalid level fails closed; the date type itself rejects malformed input at the wire level).

### Changed files (exact)

- `supabase/migrations/20260928120000_add_daily_kabumori_tip_rpc.sql` (new)
- `src/lib/home-topic.ts` (extended)
- `src/lib/daily-topic.ts` (new)
- `src/lib/topic-level-storage.ts` (new)
- `src/lib/dashboard.ts` (added `'topic'` section)
- `src/lib/settings-menu.ts` (new entry; takes a resolved label string, not a value import from home-topic.ts, so this file stays Deno-testable)
- `src/components/settings-sheet.tsx` (new `TopicLevelView`)
- `src/components/home/topic-card.tsx` (real data wiring)
- `src/app/index.tsx` (topic integrated into Home's load cycle)
- `tests/app/home-topic_test.ts` (new, 20 tests)
- `tests/app/settings-menu_test.ts`, `tests/app/dashboard_test.ts` (updated)

### Tests

- New: `home-topic_test.ts` — 20/20 pass (preference read/write incl. all 5 required failure modes, difficulty mapping incl. rejection, RPC row validation, `topicCardStatus` incl. the error-vs-empty distinction).
- Updated regression: `settings-menu_test.ts` (6/6), `dashboard_test.ts` (4/4) — pass.
- Existing regression, unchanged and still passing: `home-report-highlights_test.ts`, `home-news-sections_test.ts`, `home-news-visual_test.ts`, `news-labels_test.ts`, `news-presentation_test.ts`, `report-presentation_test.ts`, `account-deletion_test.ts` (settings/auth-adjacent, confirmed unbroken).
- Migration dry-run (no `supabase db lint` available in this CLI version; substituted with something stricter): started a throwaway local Postgres (`brew services start postgresql@17`, previously stopped), created a scratch database, mocked `public.tips` + the `authenticated`/`anon`/`service_role` roles, applied the migration verbatim, ran 10 functional/security checks — determinism (same call twice → same row), per-level filtering (all 3 levels), inactive-row exclusion, invalid-level fail-closed (0 rows, no error), empty-result handling when a difficulty has 0 active rows, and grant checks (`authenticated` has execute; `anon`/`public` do not). **All 10 passed.** Database and roles dropped, service stopped afterward (restored to its prior stopped state).
- `npx tsc --noEmit` — 0 new errors under `src/` (same 2 pre-existing, unrelated CSS-module errors as `main`).
- `npx expo config --json` — resolves cleanly.
- `npx expo export --platform web --clear` — full static export succeeds; `/` (home) server-renders at 25KB.
- `git diff --check` — clean.

### Network calls added to Home

**+1** (the new topic RPC). News + reports unchanged at 2 calls, so Home is now 3 total — the new call is genuinely new functionality, not a duplicate of anything existing.

### No-LLM / no-news-overlap proof

The RPC is pure SQL with zero LLM/AI call. Zero references anywhere in this PR to `important-news-monitor`, `market-report-analysis`, `useful_tips`, or any news/report table — confirmed by the migration's `public.tips`-only scope and by grepping the diff for those names (no hits outside this report's own prose).

### Sign-out / account-deletion audit

Read `src/lib/auth.ts` and `src/lib/account-deletion*.ts` in full: neither clears any AsyncStorage key today, not even the existing onboarding-seen flag. Following that precedent, the topic-level preference is **intentionally not cleared** on sign-out or account deletion — a non-sensitive local UI preference, not user data — rather than adding new broad auth-flow logic out of this task's scope. Flagging for K1 in case a wider "clear local prefs on sign-out" policy is later wanted.

### Production mutation

**0.** Source-only PR: migration file created but not applied anywhere, no Edge Function deploy, no cron change.

### PR / head SHA

- PR: https://github.com/anohi-memories/kabumori/pull/48
- Head: `78e423b` on `claude/daily-topic-level-settings-20260928`
- Base: fresh `main` at `19c00bf`
- **Not self-merged.**

### Remaining issues

1. Real-device/authenticated visual QA not performed (same environment limitation noted on the icon and home-UI tasks).
2. Sign-out AsyncStorage-clearing policy is unaudited beyond this one key.
3. Bottom-tab redesign, character asset, and AI chat route remain open from the prior home-UI task.

### Whether Codex DB/RPC review is required

**Yes.** This PR adds a new migration/RPC. Per this task's own completion gate, status is set to `review_required` for K1 to route an available H1/H2 slot for the grants/RLS/security-definer/search_path review, being mindful H2 is protecting a deferred task and H1 may be mid X-auth-review per current `CURRENT_STATE.md`.

### Next recommendation

K1 review → assign DB/RPC review to an open H-slot → merge if satisfied → real-device visual QA of the topic card and settings picker.


## K1 review — changes required before DB/RPC review

Verdict: **CHANGES REQUIRED**. PR #48 is narrow, mergeable, well-tested, and the architecture is accepted, but three correctness issues should be fixed before handing the final source to Codex for DB/RPC review.

### K1 finding 1 — changing level can leave a stale topic from the previous level

Current flow in `handleTopicLevelChange`:

1. AsyncStorage write succeeds.
2. `topicLevel` is updated to the new level.
3. RPC fetch for the new level starts.
4. If that fetch fails, the old `topic` object is left in state.
5. `topicCardStatus(hasTopic=true, ..., error)` resolves to `topic`, so the error is hidden.

Result: Settings can say 「上級者向け」 while Home still shows the previous beginner/intermediate topic and badge.

Required fix:
- topic content must carry/track its request identity at least by `JST date + level`, or equivalent safe logic.
- A previously loaded topic may remain visible on a refresh failure **only when it belongs to the same date + same level**.
- When level changes, old-level content must never survive as if it were current.
- If the new-level fetch fails, show the topic error/retry state while keeping the successfully saved preference.
- Do not roll back the preference merely because content fetch failed; storage save and content fetch are separate outcomes.
- Add deterministic tests for:
  - beginner topic loaded -> change to advanced -> fetch fails -> beginner topic is not shown as current;
  - same date+same level refresh failure may preserve the already-loaded topic if intentionally supported;
  - successful level change shows the new level/topic.

### K1 finding 2 — "today" is frozen for the lifetime of the mounted Home screen

`todayJstValue = useMemo(() => todayJst(), [])` is computed once.

If the app remains mounted across JST midnight / a new trading day, later focus or pull-to-refresh can still:
- fetch yesterday's daily topic;
- scope the report hero to yesterday;
- show yesterday's date in the header.

Required fix:
- Resolve the current JST date on every Home load/focus/refresh, not only at initial mount.
- Store/update the active Home date explicitly if needed.
- When the JST date changes, previous-date topic/report content must not be presented as today's.
- Topic fetch must use the refreshed date.
- Report hero must use the refreshed date.
- Header date must use the refreshed date.
- Add a pure helper/test where practical so the rollover behavior is deterministic and not dependent on wall-clock sleeps.

### K1 finding 3 — avoid `abs(hashtext(...))` integer-min overflow in the RPC

The RPC currently selects the deterministic offset using:

`abs(hashtext(...)) % total`

PostgreSQL `hashtext` returns a signed 32-bit integer. `abs(-2147483648)` cannot be represented as int4 and can raise `integer out of range`.

Required fix:
- remove `abs(int4)` from the deterministic selector;
- convert to bigint before normalization, e.g. an overflow-safe non-negative mapping/modulo;
- preserve deterministic same-date/same-level behavior;
- keep the function read-only and schema/table permissions unchanged.
- Extend the migration dry-run/static verification so this selector no longer depends on int4 `abs`.

### Accepted / keep unchanged

- Existing `public.tips` reuse is accepted.
- App mapping `初級 -> beginner`, `中級 -> intermediate`, `実践 -> advanced` is accepted.
- Local AsyncStorage preference for this phase is accepted.
- Persistence across sign-out/account deletion is acceptable for now because this is non-sensitive device-local presentation preference; do not expand auth scope in this PR.
- `security definer set search_path = ''` with fully-qualified table references is acceptable in principle and should be reviewed by Codex.
- No table-wide authenticated SELECT grant.
- No OpenAI/LLM generation.
- No important-news-monitor / market-report-analysis / X useful-tip overlap.
- Production mutation remains 0.

### Re-verification

After fixes:
- rerun all topic/settings/Home tests;
- add the new level-change stale-content and date-rollover tests;
- re-run migration functional/security dry-run;
- `npx tsc --noEmit`;
- Expo config + safe export;
- `git diff --check`;
- fresh `origin/main` conflict check;
- update PR #48/report with new head SHA;
- set status -> `review_required`, next_owner -> `chatgpt`;
- STOP for K1.

Do not merge or apply the migration to production.

Recommended model: **Sonnet5（高）**.
