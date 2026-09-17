# Codex Task 2

- task_id: social-mobile-app-phase1-shell-20260917
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: マルチアカウントSNS自動運用の一般ユーザー向けモバイルアプリ制作を開始する。既存のかぶモリ株アプリとは分離し、まずExpo/React Nativeの独立アプリ土台・主要画面・ナビゲーション・型/データ境界を実装して、次フェーズでSupabase認証/実データへ接続できる状態にする。

## Product direction

このアプリの中心価値は「AI運用担当者がアプリの中にいる」こと。

ユーザーは巨大な設定フォームを直接編集するのではなく、AIとの対話で運用方針を決め、構造化された提案を確認して適用する。将来的にX / Instagram / Threadsなど複数SNS、複数アカウントへ展開する。

Phase 1ではバックエンド全面実装より先に、実際に触れるアプリ本体の骨格を作る。

## Mandatory startup / safety

開始前に:
1. `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, `.agent/CODEX_REPORT_2.md` を読む。
2. fresh `origin/main` を確認。
3. H1/G1/G2の現行TASKを確認し、変更対象が重なる場合はSTOP。
4. 既存のroot Expoアプリ（かぶモリ株アプリ）と`apps/admin`を調査し、既存アプリを壊さない分離方針を決める。
5. 既存未コミット変更は他workstream所有として触らない。

## Isolation rule

- 新しい一般ユーザー向けSNS運用アプリは、既存root Expo株アプリとは**別アプリ**として作る。
- 原則として `apps/social-mobile/` に独立したExpoアプリを置く。
- 最終プロダクト名はまだ固定しない。内部名は `social-mobile` でよい。
- 既存root `src/app`, `src/components`, 株アプリ設定/画面を置換・移動しない。
- `supabase/functions`, DB migration/RPC/RLS, production settingsはこのPhaseでは変更しない。

既存repo構造により `apps/social-mobile/` が不適切と判断した場合は、実装前に理由と代替配置をReportへ明記し、既存株アプリとの完全分離を維持する。

## Phase 1 scope

### 1. Expo app foundation

独立したExpo/React Nativeアプリを作る。

最低限:
- TypeScript
- Expo Router
- iOS / Android / Webで成立する構成
- SafeArea対応
- light/darkを壊さない基本theme
- 共通spacing / typography / radius等のdesign tokens
- loading / empty / errorの共通UI部品
- 開発用READMEまたは起動手順

既存repoのExpo 57 / React Native 0.86系との整合を優先する。

### 2. Main navigation

Phase 1で以下の主要導線を実装する。

主タブ:
- ホーム
- 投稿予定
- AI運用相談
- 投稿履歴
- 設定

ホーム等から遷移:
- アカウント一覧/詳細
- 素材BOX

モバイルで自然なbottom-tab + stack構成を基本にする。

### 3. Screens

最低限、以下を「空白画面ではなく実UI」として作る。

#### Home
- 選択中アカウント
- 今日の投稿予定数
- 次回投稿時刻
- 要確認/失敗件数
- AI運用担当者からの短い提案カード
- 他アカウントへの切替導線

#### Accounts
- 複数SNSアカウント一覧
- platform / handle / connection status / posting state
- active account切替
- 将来の追加接続ボタン（Phase1では実OAuthしない）

#### 投稿予定
- 日単位timeline/listを主UIにする
- date jump導線
- AI生成 / user-authored / fixed/manual のorigin表示
- draft / scheduled / publishing / published / failed 等のstatus表示
- 投稿詳細へ遷移
- Phase1では表示・編集UIの骨格まで。実投稿はしない

#### AI運用相談
- chat形式UI
- AI message / user message
- AIが「運用設定変更案」を提案するカードUI
- `変更内容を見る` → structured diff/proposal → `適用する` / `キャンセル`
- Phase1ではローカルmock interactionでよいが、chat text自体をcanonical設定にしない設計にする

#### 投稿履歴
- published / failed filter
- platform / account / time / result
- 本文preview
- error rowの視認性

#### 素材BOX
- image/video placeholder grid/list
- upload CTAのUIのみ
- 実Storage uploadは次Phase

#### 設定
- account運用方針への導線
- 投稿頻度/承認モード/通知などのsetting sections
- plan/usage表示領域のplaceholder

### 4. Data / type boundary

Phase1から将来の実データ接続を見据えて、画面内へ直接巨大mock objectを埋め込まない。

最低限のdomain typesを定義:
- Workspace / Account / SocialPlatform
- AccountProfile / VoiceSettings
- PlannedPost / PostOrigin / PostStatus
- ConsultationMessage / SettingsProposal
- MediaAsset
- UsageSummary / PlanTier

repository/service interfaceを切り、Phase1はmock/local adapterを使用してよい。
次PhaseでSupabase adapterへ差し替え可能にする。

### 5. Important product rules to encode in UI/types

- AI相談の会話文そのものを設定正本にしない。
- AIはstructured proposalを作り、ユーザー確認後に適用する前提。
- user-edited / fixed / manual postを自動再生成で上書きしない前提をorigin/typeで表現する。
- approval requiredは任意。標準は「生成後、未操作なら予定時刻に自動投稿」の思想。
- Free/Standard/Proのplan概念を型だけ持たせる。課金処理はまだしない。
- URL/link-post quota、通常post quota、AI処理usageを将来別カウントできる形を意識する。

## Explicitly out of scope

Phase 1ではやらない:
- production Supabase schema/migration/RPC/RLS変更
- production OAuth/X token/Vault変更
- H1の`x-test-post` / OAuth / refresh領域
- G1のmarket report packet / personalized report領域
- 実X/Instagram/Threads投稿
- 実SNS OAuth接続
- App Store / Play Store配布
- 課金/Stripe/App Store IAP
- push通知本実装
- Storage upload本実装
- AI API本接続
- 既存かぶモリ株アプリのUI刷新

## Quality / verification

最低限:
- TypeScript typecheck相当
- lint
- Expo Router route解決確認
- iOS simulatorまたはExpo Webの少なくとも1系統で起動確認
- main tabsの遷移確認
- Accounts/素材BOXへのstack遷移確認
- empty/error/loading stateの最低限確認
- `git diff --check`

可能なら主要domain/serviceに軽いunit testを追加する。

## Deliverables

- 独立したSNS運用モバイルアプリのPhase1実装
- 主要5タブ + Accounts + 素材BOX
- domain types / mock repository/service boundary
- 起動手順
- screenshot不要。動作確認結果をReportへ記録

## Completion

完了時:
- `.agent/CODEX_REPORT_2.md` 先頭にPhase1 reportを追加
- exact commit / changed files / app path / navigation map / implemented screens / data boundary / tests / known gaps / next recommended Phase2を記載
- this TASKを `status: review_required`, `next_owner: chatgpt` に更新
- fresh `origin/main` を再確認してからpush
- origin/main read-back後STOPしてC2待ち

このPhaseではproduction backend/OAuth/X自動投稿には触らない。
