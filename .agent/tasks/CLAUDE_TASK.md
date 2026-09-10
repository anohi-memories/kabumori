# Claude Task 2

- task_id: x-multibrand-architecture-design-20260910
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- purpose: 現行かぶモリ本番を壊さず、X自動投稿システムを複数ブランド／複数Xアカウントへ拡張するための正式アーキテクチャ設計を行う。今回は設計のみで、本番変更・実装・認証接続は行わない。

## Background

初期対象ブランドは以下の3つ。

- `kabumori`
- `ai_salaryman_lab`
- `mio`

将来的にはInstagram・Threadsへ広げ、最終的にはMiseiroでも利用できる共通SNS投稿基盤へ発展させる。ただし現段階ではX複垢化を優先し、Instagram／Threads／Miseiro対応は実装しない。

無名Claude Codeチャットで、実装前の現行調査と安全な開発環境構築を完了済み。

- 複垢化用作業コピー: `/Users/yuya/Developer/kabumori-multibrand`
- ブランチ: `feature/multibrand-foundation`
- 初期調査・安全環境構築commit: `56244c7`
- 追加済み: `docs/multibrand/README.md`, `docs/multibrand/SURVEY.md`, `scripts/multibrand/check-safe-env.sh`
- 既存テスト680件: 全成功
- 本番DB書き込み／Edge Function deploy／Cron変更／X投稿／OAuth／トークン取得／実アカウント接続／Docker導入: 未実施

会社員AIラボ・みおのXアカウント自体はすでに用意済み。ただし今回の設計承認前に認証接続は行わない。

## Read First

開始時に必ず以下を確認する。

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CLAUDE_TASK.md`
- `docs/multibrand/README.md`
- `docs/multibrand/SURVEY.md`
- 現行X投稿関連コード
- 関連migration / RPC / Edge Functions / Cron
- 投稿候補・投稿履歴・重複防止・auto_publish関連コード

開始前に `origin/main` をfresh-checkすること。既存の未コミット変更は他workstreamの所有物として扱い、編集・削除・stage・commitしない。

## Model Guidance

今回はDB・X認証・Cron・重複防止・後方互換性を横断する重要な設計フェーズなので、可能ならOpusを使用する。通常の軽微な確認や後続実装はSonnet系でもよいが、今回の正式設計はOpus推奨。

## Non-Negotiable Safety Rules

- 現行かぶモリ本番を複垢化の実験台にしない。
- Supabase新規プロジェクトは作成しない。
- 本番DB schema変更、migration適用、RPC変更、Edge Function deploy、Cron変更、Secret変更をしない。
- X OAuth、トークン取得、実アカウント接続、X実投稿をしない。
- 会社員AIラボ／みおの自動投稿を有効化しない。
- Docker Desktopを勝手に導入しない。
- mainへmergeしない。
- Secret値・認証情報をログ、文書、Gitへ出さない。
- 新ブランドは明示的に有効化されるまで投稿生成・Cron処理・X投稿・自動投稿が走らない設計にする。
- 1ブランドの設定変更が他ブランドへ影響しない構造を前提とする。

## Confirmed Survey Findings

- 現行X認証情報の格納構造は実質1アカウント前提。
- 1日1回投稿保証、重要ニュース重複チェック、ネタ再利用防止、投稿予定・投稿履歴・各種設定がブランド非対応で全体共有。
- 「かぶモリ」、文体、ハッシュタグ、生成プロンプト等のハードコード箇所がある。
- 本番Cronは8本、うちX投稿関連5本は1アカウント前提。
- 本番に古いX認証形式のSecret名4つが残るが、現コードからは未使用。
- GitHubに存在しない本番コードとして、銘柄マスタ同期Function 2本とDB変更9本が別workstream側の未コミット変更に存在する。
- 本番で動く重要ニュースX公開Cronを作成したmigrationが既存 `kabumori` 側では削除状態。
- DBパスワード不明のため、本番migration適用状況は完全確認できていない。
- これら不整合は複垢化へ混ぜず、必要なら別タスク化する。

## Design Goal

ブランド単位で少なくとも以下を分離できる共通基盤を設計する。

- Xアカウント認証情報
- キャラクター／人物設定
- 文体
- 投稿テーマ／カテゴリ
- 投稿頻度／スケジュール
- 生成プロンプト
- 画像方針
- note導線
- 投稿候補
- 投稿履歴
- 自動投稿ON/OFF
- 重複防止状態
- クールダウン／投稿制御
- ブランド固有生成ルール

また、Xポリシー上の安全性を考慮し、「ブランド内重複防止」と「複数ブランド横断の類似投稿防止」は別概念として設計する。

## Required Architecture Decisions

### 1. Brand / Account Model

`brand_id` と `account_id` の責務を整理し、必要なら `brands` と `social_accounts` を分離する。ブランドとSNSアカウントを1:1固定にせず、将来Instagram・Threadsにも拡張しやすい構造を検討する。ただし将来対応のための過剰設計は避ける。

### 2. Database

以下について、新規テーブル／既存テーブルへの識別子追加／設定分離の方針を決める。

- ブランド定義
- ブランド設定
- SNSアカウント
- 投稿候補
- 投稿予定
- 投稿履歴
- 重複防止
- クールダウン
- auto_publish
- スケジュール
- 生成設定

既存データは自動的に `kabumori` 扱いとなる後方互換設計を優先し、本番既存データの大量UPDATEを避けられる案を優先する。

### 3. X Authentication

複数Xアカウントの認証情報を安全に管理する方式を設計する。DB、Supabase Secrets、Vault相当、Edge Function側の責務を整理し、ブランド／social accountから正しい認証情報だけを取得できる構造にする。Secret値を通常テーブルへ平文保存する方式は避ける。

### 4. Cron / Scheduler

現行5本のX関連Cronをどう複垢化するか設計する。ブランドごとにCronを増殖させる方式と、共通dispatcher/plannerが有効ブランドを取得して処理する方式を比較し、ブランド数増加に耐える構造を優先する。ただし既存かぶモリの投稿時刻・挙動を変えない。

### 5. Posting Pipeline

Edge Function / RPC / planner / publisherの各段で、ブランドコンテキストまたはaccountコンテキストが失われない設計にする。

### 6. Deduplication

以下を分離して設計する。

- 同ブランド内の投稿重複防止
- 同ブランド内のネタ再利用防止
- クールダウン
- 複数ブランド横断の非常に似た投稿の防止

### 7. Brand Configuration / Prompt Management

現在コードへハードコードされているブランド名、文体、ハッシュタグ、プロンプト、note導線等をどこへ移すか決める。DB管理とコード管理の境界も明示する。

### 8. Storage / Images

画像保存場所・namespaceのブランド分離を設計する。みおは他ブランドと画像運用方針が大きく異なることを考慮する。

### 9. Admin UI Compatibility

管理画面のブランド切替は今回実装しないが、DB/API設計上あとから追加しやすい構造にする。

## Phased Implementation Plan To Design For

- Phase 1: 安全な開発環境で現行かぶモリ1ブランドを再現。
- Phase 2: ブランド識別機構を導入。まだ `kabumori` のみで従来動作との完全互換を確認。
- Phase 3: 会社員AIラボを2ブランド目として追加。
- Phase 4: みおを3ブランド目として追加。
- Phase 5: 3ブランドでX複垢運用を安定化。その後Instagram／Threadsを検討。

## Deliverables

設計結果を文書化し、最低限以下を明記する。

1. 推奨アーキテクチャ
2. brand/accountモデル
3. DB変更案
4. 既存テーブルごとの変更方針
5. Edge Functions変更案
6. RPC変更案
7. Cron設計
8. X複数アカウント認証管理
9. 重複防止設計
10. プロンプト／ブランド設定管理
11. Storage／画像分離
12. 後方互換性
13. migration方針
14. rollback方針
15. セキュリティ上の注意
16. 本番誤投稿防止策
17. Phase 1〜5の具体的実装順
18. 各Phaseのテスト項目
19. リスク・未決事項
20. 実装開始前にChatGPT側で判断が必要な事項

設計資料作成後はいったん停止し、勝手に本格実装へ進まない。

## Completion Criteria

- 現行調査資料と実コードを照合したうえで、上記20項目を含む正式設計が作成されている。
- 本番変更、deploy、Cron変更、Secret変更、X認証接続、X投稿を一切していない。
- Git差分が設計資料と必要最小限の `.agent/` 制御情報に限定されている。
- 既存680テストのベースラインを壊す変更をしていない。コード変更を伴わない場合はその旨を明記する。
- task完了・停止時はこのファイル末尾の `## Report` に必須項目を記録し、statusを `review_required` または `done` に更新してGitHubへ同期する。

## Report

- task_id: x-multibrand-architecture-design-20260910
- result: 正式アーキテクチャ設計を作成し、`feature/multibrand-foundation` にcommit/push（mainへはmergeしていない）。設計のみで、コード・migration・deploy・Cron・Secret・OAuth・X投稿の変更は一切なし。ここで停止し、本格実装へは進まない。
- deliverable: `docs/multibrand/ARCHITECTURE.md`（commit `bfa4c7b`、ブランチ `feature/multibrand-foundation`、親は調査commit `56244c7`）。`docs/multibrand/README.md` に設計書へのリンク1行を追加。
- 20項目の対応箇所（ARCHITECTURE.md）:
  1 推奨アーキテクチャ §0・§1 / 2 brand・accountモデル §2 / 3 DB変更案 §3 / 4 既存テーブル方針 §4 / 5 Edge Functions §5 / 6 RPC §6 / 7 Cron §7 / 8 X複数アカウント認証 §8 / 9 重複防止 §9 / 10 プロンプト・設定管理 §10 / 11 Storage・画像 §11 / 12 後方互換 §13 / 13 migration §14 / 14 rollback §15 / 15 セキュリティ §16 / 16 誤投稿防止 §17 / 17 Phase 1〜5実装順 §18 / 18 各Phaseテスト §18 / 19 リスク・未決 §19 / 20 ChatGPT判断事項 §20（管理画面互換は §12）
- 推奨の骨子:
  - 共通パイプライン＋全行に `brand_id`。Cron・Edge Functionはブランドごとに増やさない（既存Cronのジョブ名・時刻・コマンドは不変）
  - `brands`（人格単位）と `social_accounts`（SNSアカウント単位、`unique(brand_id, platform)`）を分離。`brand_id` はtextスラッグ
  - 既存テーブルへ `brand_id text not null default 'kabumori'` を追加（定数デフォルトのため既存行の大量UPDATEなし）。一意制約は新制約追加→コード切替→旧制約削除の順
  - シングルトン設定は `id=true` をかぶモリ行の意味として残す in-place 多行化で、旧コード・管理画面を無変更で動かす
  - Xトークンは新テーブル `social_account_tokens` に暗号文で保存し、既存 `oauth_token_store` は凍結（新アカウントを書かない）。旧コードの `provider=eq.x&limit=1` による取り違えを構造的に防止。暗号鍵は `X_CLIENT_SECRET` 由来から専用Secret＋鍵バージョンへ。取込時と投稿時に `/2/users/me` の user id でアカウント結合を検証
  - 重複防止を4層に分離（ブランド内同一投稿／ブランド内ネタ再利用／アカウント単位クールダウン／ブランド横断類似防止）。横断は正規化本文ハッシュ・出典URL・simhash・topic_keyで判定し fail-closed
  - プロンプト・文体はコード管理（git＋テスト）、ON/OFF・時刻・ハッシュタグ値・note導線・画像方針はDB管理
  - 新ブランドは3重ゲート（brand／account／posting_window）既定OFF、`publish_mode` を disabled→dry_run→live と明示的に上げる
  - important-news はPhase 2〜4ではkabumori専用のまま
- 実コード照合で見つかった設計上の要注意点:
  - `x-test-post/index.ts` に `_shared/x_oauth2_post.ts` とは別の `loadXTokens` 重複実装がある（Phase 2で一本化必須）
  - 旧 `claim_due_post()` はbrand_idを見ないため、ブランド対応版のdeploy前に新ブランドの予定行を作ると、かぶモリのトークンで誤投稿しうる（§13 順序制約として明記）
  - 本番Cron 1〜4はmigrationファイルに存在しない（手動作成）。Phase 1で定義をread-only取得して記録してから触る
  - 本番migration適用状況が未確定（`20260901044548` 未適用、stocks-sync系はgit未追跡のまま適用済み）。Phase 2の前提として別タスクで確定させる
- tests: コード変更なしのため実行対象なし。既存680テストのベースラインに影響しない（変更ファイルはMarkdown 2つのみ）。
- commit_hash: `bfa4c7b`（feature/multibrand-foundation）。main側は本Report更新の `.agent/` 2ファイルのみ
- push: `origin/feature/multibrand-foundation` へpush済み（`56244c7..bfa4c7b`）。mainへのmergeなし
- deploy: なし
- safety_checks:
  - Supabase新規プロジェクト作成・本番DB schema変更・migration適用・RPC変更・Edge Function deploy・Cron変更・Secret変更: いずれもなし
  - X OAuth・トークン取得・実アカウント接続・X実投稿・新ブランドの自動投稿有効化: いずれもなし
  - Docker導入なし。本番DBへの問い合わせも今回は行っていない（既存SURVEYとリポジトリのコード・migrationのみで照合）
  - 複垢worktreeで `check-safe-env.sh` を実行し `SAFE` を確認。Supabase CLIは実行していない。未追跡の `supabase/config.toml` には触れていない
  - 共有チェックアウト `/Users/yuya/Developer/kabumori` の未コミット変更（他workstream）は変更・stage・commitしていない
  - 設計書にSecret値・認証情報・個人情報は含めていない（Secret名のみ）
- remaining_issues: 実装は未着手。§20の12項目（X App共有か分離か、トークン暗号化方式、シングルトン多行化方式、Docker導入、本番migration適用状況の確定、横断類似の閾値、初回live投稿の手動承認、会社員AIラボ・みおのブランド方針資料、みおの画像方針、important-newsのkabumori専用継続、ブランド間最小時刻差と日次上限、旧Secret等の別タスク化）の判断が必要
- next_recommendation: (a) K2で設計をレビュー、(b) §20の判断事項を決定、(c) Phase 1の前提作業（本番migration適用状況・`cron.job` 定義・設定値・行数のread-only記録）を別タスクとして割当、(d) その後にPhase 1（ローカル再現とゴールデンスナップショット）へ
