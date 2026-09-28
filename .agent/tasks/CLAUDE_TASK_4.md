# Claude Task 4

- task_id: x-social-mobile-home-posting-settings-ux-phase1-20260928
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: `apps/social-mobile` のHome・投稿設定・投稿UXを棚卸しし、一般ユーザーが「何がいつ投稿されるか」「自動投稿がONか」「投稿内容をどう調整するか」を理解・操作できる実用画面へ近づける。

## Product direction

基盤ではなくユーザー価値を優先する。

このTASKの最重要ゴール:
- Home / schedule / settings / posts / history の現状を分類
- 既存backend契約を再利用
- 投稿予定・自動投稿状態・最近の投稿結果・主要設定がユーザーに見える
- 投稿内容や頻度の調整入口を整える

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - relevant social-mobile Home/schedule/settings/posts/history files
2. Use independent G4 worktree/checkout.
3. Fresh fetch `origin/main`.
4. If any Supabase data contract is touched, read current Supabase skill first.
5. Inspect existing screen/data contracts before editing.
6. Do not touch G3-owned auth/X-connect/onboarding files unless unavoidable; stop on overlap.

## Scope

### Stage A — inventory

Classify:
- Home
- next scheduled post
- auto-post ON/OFF visibility
- connected X account summary
- recent post success/failure
- post history
- schedule controls
- content settings
- tone/style
- posting frequency
- posting time windows
- NG words
- manual approval vs auto-post
- post preview/edit/regenerate if present
- empty/loading/error states

For each:
- usable
- partial
- UI only
- missing
- blocked by backend/config

### Stage B — minimum Home contract

Home should make these clear without opening multiple screens:
- connected X account
- auto-post enabled/disabled
- next planned/scheduled post time if available
- latest post result
- one clear CTA to adjust posting settings
- one clear CTA to review posting/history area

Do not fake data. If backend field does not exist, show truthful unavailable/empty state.

### Stage C — posting settings UX

Use existing settings/data model where possible.

Prioritize:
- auto-post preference
- posting frequency/cadence
- permitted time windows
- tone/style
- NG words / prohibited terms
- content themes/categories if already supported
- manual review vs automatic posting if contract exists

Do NOT invent unsupported settings solely for UI completeness.

### Stage D — posting UX

Where already supported, improve:
- current draft/post preview
- regenerate
- edit
- approve/post
- failure reason
- retry/reconnect CTA

If these actions are not backed yet, provide navigation/disabled-state contracts rather than fake functionality.

## Visual/UX constraints

- mobile-first
- concise Japanese UI
- obvious status hierarchy
- no admin-only terminology
- no developer/debug jargon
- loading/error/empty states must be explicit
- avoid giant dashboard density
- preserve existing brand/design system unless clearly broken

## Safety / data constraints

- no real production X post
- no hidden auto-enable
- no account/brand fallback
- user must clearly see auto-post state before it can be changed
- do not expose tokens/secrets/internal IDs
- do not touch Admin invite/recovery work
- do not activate Stage 3B pilot

## Tests

At minimum:
- Home state rendering
- auto-post enabled/disabled
- no schedule/empty schedule
- recent success/failure states
- settings persistence contract mocks
- unavailable backend field behavior
- `npm run typecheck`
- `npm run lint`
- Expo export/build smoke if practical
- `git diff --check`

## Deliverable

Report:
- inventory table/summary
- implemented Home contract
- implemented posting settings UX
- posting UX changes
- changed_files
- tests
- screenshots/preview notes if available
- backend blockers
- G3 overlap check
- recommended next G4 step

## Production constraints

- no production post
- no production rollout activation
- no production DB migration
- no unrelated PR merge
- no Admin Auth changes

## Completion / K4

Set:
- status -> review_required
- next_owner -> chatgpt

STOP for K4.

## Report

- task_id: x-social-mobile-home-posting-settings-ux-phase1-20260928
- result: **PASS（narrow scope）**。Home/schedule/history/投稿詳細の「嘘データ」バグを3件修正し、Stage Bで要求されたHomeの最小要件（自動投稿ON/OFF・次回投稿・最新結果・調整導線）を実装した。consult画面の「これで覚えて」を実際の保存へ配線した。PR #44（未merge）。
- model_used: Sonnet 5（高）
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（コードは新規branch `g4/social-mobile-home-posting-ux-phase1-20260928`、TASK更新はworktree本来のbranchから）
- PR: https://github.com/anohi-memories/kabumori/pull/44 （head `f0ecc9f`、OPEN、MERGEABLE）

### Stage A — inventory（抜粋、詳細はPR本文）

| 項目 | 状態（修正前） | 状態（修正後） |
|---|---|---|
| Home: 次回投稿予定 | missing | usable |
| Home: 自動投稿ON/OFF可視化 | missing | usable（アカウント未選択時は「不明」、ON/OFFを断定しない） |
| Home: 最新投稿結果 | missing | usable |
| Home: 設定/履歴への導線 | partial（相談画面のみ） | usable（設定・投稿予定・履歴へのCTAを追加） |
| 投稿予定(schedule) | UI only（実データが`accountId`フィルタで必ず空になるbug） | usable（bug修正、loading/unavailable明示） |
| 履歴(history) | 同上 | usable |
| 投稿詳細(posts/[id]) | blocked by bug（実データは常に「見つかりません」） | usable |
| コンテンツ設定(settings) | usable（既存のまま、変更なし） | usable |
| AI相談→保存(consult) | UI only（確認ボタンがlocal state更新のみで、既存の`saveConfirmedProposal`/`upsert`を呼んでいなかった） | usable |
| 投稿頻度・時間帯・NGワード | usable（settings画面、既存） | 変更なし |
| 手動承認 vs 自動投稿 | UI only（`投稿権限は別管理`の説明のみ、切替導線なし） | 変更なし（別管理の方針を尊重し、切替機能は追加しなかった） |
| 投稿プレビュー(BrandPostPreview) | usable（既存、edge function呼び出し） | 変更なし |
| empty/loading/error状態 | partial（`blocked`/`unavailable`が`mock_preview`と同じ表示になっていたbug） | usable（3状態を明示的に分離） |

### Stage B — Home最小要件

実装した: 接続中Xアカウントの表示、自動投稿ON/OFF、次回投稿予定、最新の投稿結果、設定調整への単一CTA、投稿予定/履歴確認への単一CTA。データが無い場合は「不明」「予定はありません」等の正直な表示にし、偽データは出さない。

### 見つけて直した実バグ（3件、いずれも「嘘データ」に該当）

1. **`accountId`フィルタで実データが常に空になっていた**: `scheduled_posts`（本番）はアカウントに紐づく列を持たない（`supabase-repository.ts`のコメントに明記済み）ため、行は`accountId: 'unknown'`で返る。Home/schedule/historyは`post.accountId === activeAccount.id`でフィルタしていたため、**接続済みの実データでも投稿予定・履歴・失敗件数が常に0件と表示されていた**。修正: 実データ（`ready`）はフィルタせずワークスペース単位で表示、モックのみ従来通りアカウント単位でフィルタ。
2. **`blocked`/`unavailable`が`mock_preview`と同じ「ローカルプレビュー」表示になっていた**: Homeのバナーで、実接続が権限エラー等で壊れている状態も、意図的なデモモードと同じ文言になっていた。加えてこの状態でも各画面はモックの投稿一覧を出し続けていた（壊れている実接続の下に、正常に見えるデモデータが表示される状態）。修正: `blocked`/`unavailable`を専用の見出し（「運用データを確認できません」）にし、この状態ではモック投稿を出さずloading/unavailableの明示状態にした。
3. **投稿詳細画面が常にモックデータしか見ていなかった**: `posts/[id].tsx`は`mockRepository.getHistory()`固定で検索していたため、実データの投稿をタップすると常に「投稿が見つかりません」になっていた。修正: 接続状態に応じて実データの`history`（planned+published+failedの全件を含む）から検索するように変更。

### `consult.tsx`の配線

- 「これで覚えて」ボタンは、ローカルのReact stateを更新するだけで、既存の`SupabaseContentSettingsRepository.saveConfirmedProposal`/`upsert`を一度も呼んでいなかった（バックエンド契約は既にあるのに未接続）。実際に保存するよう配線した。
- 発見した副次バグ: 提案の合成・適用が`SOCIAL_MOBILE_CONTENT_DEFAULTS`（ハードコードの既定値）を基準にしていたため、設定画面で既に保存済みの実設定（例: 週の投稿頻度）があっても、consult画面で1件確認するたびに**無関係な項目が既定値へ無言で巻き戻る**構造だった。修正: 設定画面と同じ方法（`repository.read(brandId)`）で実際の保存済み設定を読み込み、それを基準に提案・適用するよう変更。
- 保存対象がpersonaを含む場合は`saveConfirmedProposal`、設定のみの場合は`upsert`を使い分け、どちらも変更が無い確認（フォローアップ質問のみ等）では何も保存しない。

### 新規モジュール `src/domain/data-view.ts`（純粋関数、テスト12件）

- `resolvePostsView(status, reason, realPosts, mockPosts)`: 上記バグ2の判定を一箇所に集約。
- `statusHeadline(status)`: 上記バグ2の見出し文言。
- `summarizeHome({account, posts, history, now})`: 自動投稿ON/OFF（アカウント未選択はnull=不明）、次回投稿、最新結果、件数集計。

### changed_files

新規: `src/domain/data-view.ts`、`src/domain/data-view.test.ts`。
変更: `src/app/(tabs)/index.tsx`（Home）、`src/app/(tabs)/schedule.tsx`、`src/app/(tabs)/history.tsx`、`src/app/posts/[id].tsx`、`src/app/(tabs)/consult.tsx`、`tsconfig.json`（`allowImportingTsExtensions`・`types:["node"]`）、`package.json`/`package-lock.json`（devDependency `@types/node`、admin appの`node:test`運用に合わせた）。
すべて`apps/social-mobile`配下。DB/RLS/RPC/migrationの変更なし。

### tests

- `node --experimental-strip-types --test src/domain/data-view.test.ts`: **12/12 pass**。
- `npm run typecheck`: PASS（新規テストファイル起因のエラーは上記tsconfig変更で解消。既存の実装コードは変更前から0エラー）。
- `npm run lint`: PASS（実装中に1件warning自己検出→修正: `active-account-provider.tsx`の変更で空配列`[]`を毎レンダー新規生成していたのをやめ安定参照にしたが、後述のG3重複によりこのファイル自体は最終的に変更を取り消した）。
- `npx expo export --platform web`: 成功（853 modules、エラー0）。修正後に再実行し再確認済み。
- `git diff --check`: PASS。
- 既存の無関係テスト`docs/phase4-policy-matrix.test.mjs`: 5/5 pass（回帰なし）。
- 実ログイン・実Supabase接続での画面確認: 未実施（このセッションに認証情報が無く、全画面がSupabaseログインの後段にあるため。TASKも実投稿・実G3領域の実施は求めていない）。

### G3 overlap check（重要）

作業中に実際の重なりを発見した:
- G3のPR #42（`claude/g3-social-mobile-onboarding`、OPEN、未merge）が`src/providers/active-account-provider.tsx`・`src/providers/data-provider.tsx`・`src/app/accounts/index.tsx`・`src/app/_layout.tsx`を変更している。
- 私も同じバグ（`active-account-provider.tsx`が`loading`/`blocked`/`unavailable`時にモックアカウントへ黙ってfallbackする）を独立に発見し、一度同じ趣旨の修正を書いた。しかしTASKの「G3ファイルに重なったら停止」指示に従い、**この2ファイルへの変更は取り消した**（PR #42の方が`reload()`も含めてより完全な修正のため）。
- 代わりに`data-view.ts`は`data-provider.tsx`から型をimportせず、同じ形のローカル型を定義することで、このPRがどちらの共有providerファイルにも依存しないようにした。
- 影響: Homeの「運用アカウント」カード・自動投稿ON/OFF表示は、接続状態が`ready`または`mock_preview`のときは正しく動く。`loading`/`blocked`/`unavailable`のときは、**アカウント表示自体は既存のバグ（モックアカウントが出る）が残ったまま**で、PR #42がmergeされると自動的に解消される。投稿予定・履歴・投稿詳細（今回直した3件）はこの重なりと無関係で、PR #42の有無に関わらず単独で正しく動く。
- 今回私のbranch/PRは`(tabs)/index.tsx`・`(tabs)/schedule.tsx`・`(tabs)/history.tsx`・`(tabs)/consult.tsx`・`posts/[id].tsx`のみを変更しており、これらはG3のchanged_filesに含まれていない。

### screenshots/preview notes

なし。`npx expo export --platform web`のbundle成功のみで確認（上記の理由でログイン後の実画面キャプチャは未実施）。

### backend blockers

- `social_mobile_content_settings`テーブルは「Phase 14 source candidate only. Do not apply to production in this phase.」であり、本番未適用（migrationコメントで確認）。本番で`EXPO_PUBLIC_DATA_SOURCE=supabase`にしても、consult/settingsの保存は`42P01`等でunavailableとして安全に失敗する設計のまま。
- `scheduled_posts`に投稿本文の正本が無い（`text`は常に空文字、`supabase-repository.ts`のコメントに既知の制約として明記済み）ため、Home/schedule/historyの本文表示は「本文は投稿の確認画面で表示されます」という代替文言のまま。本文正本の追加は本TASKの範囲外。
- `EXPO_PUBLIC_DATA_SOURCE`の既定値は`mock`（`.env.example`のコメントどおり）。今回の修正は実データ経路の正直さを直したが、実データ経路自体をONにする判断は別TASK。

### production/config mutations

0件。DB/RLS/RPC/migration/Supabase設定/本番デプロイいずれも無し。branchへのpush + PR作成のみ。

### recommended next G4 step

1. PR #42（G3）とPR #44（本PR）の順序を決めてmerge。#42が先にmergeされれば、Homeのアカウント表示の残課題（上記overlap note）も自動的に解消される。
2. mainがG3の新プロバイダ構成（`reload()`付き）になった後、Home/schedule/history/consultが新しい`useDataStatus`/`useActiveAccount`のシグネチャと問題なく組み合うか、G4で軽い追従確認を行う。
3. Stage C/Dの残り（手動承認/自動投稿の切替導線、投稿の編集・再送・リトライ導線）は、実投稿権限に関わるため、範囲・承認をChatGPTと確認してから次TASKとする。

## Completion

- status -> review_required
- next_owner -> chatgpt
