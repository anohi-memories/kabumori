# Codex Task 2

- task_id: social-mobile-app-phase2-auth-data-20260917
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna (use higher reasoning only if schema/Expo auth integration becomes ambiguous)
- purpose: `apps/social-mobile` のPhase 2として、Supabase Auth/session境界とSupabase data adapterの実装候補を作り、Phase 1のmock専用アプリを「実バックエンドへ安全に接続できるアプリ」へ進める。今回はproduction schema/OAuth/SNS投稿を変更せず、既存schemaのread-only調査とclient-side integrationを中心に進める。

## Mandatory startup / safety

開始前に必ず:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. fresh `origin/main`
を確認する。

さらにH1/G1/G2の現行TASKを確認し、同じファイル・DB migration/RPC・Edge Function・workflow・production設定に触れる可能性がある場合はSTOPして報告する。

既存未コミット変更は他workstream所有として触らない。

## Scope boundary

主変更対象:
- `apps/social-mobile/**`
- 必要ならこのTASK/Reportだけ

原則変更禁止:
- 既存root Expo株アプリ
- `apps/admin/**`
- `supabase/functions/**`
- production DB/schema/RPC/RLS
- X OAuth/Vault/token/refresh
- H1/G1/G2所有ファイル
- production SNS posting settings

### Important DB rule

multibrand migration historyには不整合の可能性があるため、**blind `supabase db push` 禁止**。

既存schemaのread-only inspectionは可。
不足schemaが判明した場合は、このPhaseでは:
- migration candidate / SQL proposalをReportへ整理
- productionへ適用しない
- C2で次段階を判断
とする。

## Phase 2 goals

### 1. Supabase client foundation

`apps/social-mobile` にSupabase client境界を追加する。

要件:
- `@supabase/supabase-js`
- Expo/React Nativeでsession persistenceできる構成
- public client envは `EXPO_PUBLIC_*` を使用
- service_role、DB password、OAuth client secret等をアプリへ埋め込まない
- env未設定時に明確なdeveloper-facing error/fallbackを出す
- client生成を画面内へ直書きしない

必要なら `@react-native-async-storage/async-storage` 等を使用してよい。

### 2. Auth architecture

最低限実装:
- AuthProvider / session state
- loading state
- signed-out state
- signed-in state
- Sign In画面
- Sign Out導線
- auth state change listener
- app launch時のsession restore

Phase2では「認証アーキテクチャが成立すること」を優先する。

実production auth mutationはテストで行わない。
新規ユーザー作成・メール送信・OAuth接続の実呼び出しは自動検証では禁止。

認証方式は既存Supabase Auth設定をread-only確認し、安全に実装できる方式を採用する。設定が不明/不足ならUIとprovider境界まで実装し、実認証方法はC2へ返す。

### 3. Repository split: mock / Supabase

Phase1の `SocialOperationsRepository` を維持し、adapterを切り替え可能にする。

最低限:
- mock adapterを残す
- Supabase adapterを追加
- repository selection/config layerを追加
- UIがSupabase SDKへ直接依存しない

UI側は同じdomain modelを使う。

### 4. Existing schema read-only inventory

production schemaを変更せず、現在のmultibrand/SNS関連schemaをread-onlyで調査する。

確認対象例:
- brands / workspaces相当
- social accounts / handles / platform / connection status
- planned posts / schedules
- post history / delivery status
- account settings / posting windows / generation settings
- user ↔ workspace/account ownership / membership境界

Reportには:
- 既存table/RPCでそのまま使えるもの
- mobile domain modelとのmapping
- 足りないfield/table
- RLS/ownership上の不足
を整理する。

### 5. Read path candidate

既存schemaと安全にmappingできる範囲について、Supabase adapterのread path candidateを実装する。

優先順:
1. Workspace / Account
2. planned posts
3. history
4. usage/plan placeholder

ただしuser ownership/RLSが不十分でtenant isolationを保証できない場合は、無理にproduction dataへ繋がない。
その場合はadapter contract + mapping candidate + explicit blocked stateを実装する。

### 6. App states

Phase2で明確に見える状態を追加:
- auth loading
- signed out
- signed in + data loading
- no workspace/account
- backend unavailable / env missing
- permission/RLS error
- offline/unknown error

「何も表示されない」は不可。

### 7. Account context

Phase1では先頭account固定だった部分を改善する。

最低限:
- active account state/context
- Accounts画面からactive account切替
- Home / 投稿予定 / 履歴がactive accountを参照
- session logoutでaccount state reset

永続化はlocalでよい。production DB writeはまだ不要。

## Security requirements

- service_roleをmobileへ絶対に入れない
- secretsをlog/Reportへ書かない
- anon/public key以外をclient envへ置かない
- tenant ownershipが証明できないproduction rowを表示しない
- RLS不足をclient filterで誤魔化さない
- DB mutationが必要ならこのPhaseではSTOPしてC2へ返す

## Explicitly out of scope

今回はまだやらない:
- production migration / RLS / RPC適用
- `supabase db push`
- SNS OAuth connect
- X/Instagram/Threads実投稿
- X token/Vault処理
- Storage upload
- AI API本接続
- push通知本実装
- billing / IAP / Stripe
- App Store / Play Store配布
- H1の401/refresh作業
- G1 market report packet

## Verification

最低限:
- `npm run typecheck`
- `npm run lint`
- Expo Web export / route resolution
- auth provider/session branchのunitまたはcomponent-level検証可能な範囲
- repository mock/Supabase selectionの検証
- active account切替の検証
- env missing / permission error stateの確認
- `git diff --check`

live production sign-in/signup/postingはverificationとして実行しない。

## Deliverables

- Supabase client foundation
- AuthProvider / SignIn / SignOut / session restore
- active account context
- mock + Supabase repository adapter boundary
- safe read-path candidate
- schema mapping/inventory report
- missing schema/RLS requirements list
- updated README/env setup

## Completion

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭へPhase2 report追加
- exact commit
- changed files
- auth architecture
- repository architecture
- schema mapping
- tests
- production mutation 0であること
- blockers / missing RLS/schema
- next Phase recommendation
を記載する。

TASKを `review_required`, `next_owner: chatgpt` に更新。

push前にfresh `origin/main`を再確認し、競合があれば安全に取り込んで再検証する。他workstreamの変更を上書きしない。

push後、origin/main read-backしてSTOP。C2待ち。
