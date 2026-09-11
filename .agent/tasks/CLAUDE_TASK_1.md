# Claude Task 1

- task_id: in-app-news-japanese-detail-summary-20260911
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: 重要ニュース画面を、英語ソースへの単なるリンク集ではなく「日本語タイトル＋アプリ内詳細＋十分な日本語要約」で内容を把握できる体験へ改善する。外部ソースは確認用の二次導線にする。

## Context

直前TASK `broader-stock-news-coverage-phase3-market-relevance-20260911` はChatGPTのK1レビューで完了承認済み。

現在の問題:
- 市場全体ニュースのタイトルが英語のまま表示されることがある
- summary に `<span id="pageTitle" ...>` などHTML/DOM断片が混入するケースがある
- カードをタップすると直接英語の外部ソースへ遷移し、アプリ内で詳細を読めない
- ユーザー要望は「ソースを開かなくても、アプリだけで記事内容をある程度詳しく把握できること」

スクリーンショットで確認された代表例:
- `Ambassador Greer Issues Statement on President Trump's Response to Canada's Continued Retaliation Against the United States`
- summary に `<span id="pageTitle" class=...>` が露出
- CTAが `記事を開く` で外部ソースへ直行

## Product goal

ニュース体験を以下へ変更する。

1. 一覧のタイトルは原則日本語
2. 一覧summaryはHTML等を除去した自然な日本語短要約
3. カードタップはアプリ内ニュース詳細画面へ遷移
4. 詳細画面では、外部ソースを開かなくても内容を把握できる十分な日本語要約を表示
5. 外部ソースは詳細画面下部の `元記事を確認` 等の二次CTAにする
6. 事実関係を膨らませない。ソースに無い数字・因果・投資助言を追加しない

## Model

英語→日本語、ニュース要約品質、Fact safety、DB/RPC/app UIをまたぐため **Opus 5** を使用する。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktree確認
7. 他slot TASKをread-only確認
8. Claude slot 2のOAuth/Vault/social_accounts系と競合しないこと
9. Codex2のx-test-post変更と競合しないこと
10. `get_my_important_stock_news` / news screen / news detail route / important-news-monitor の現在実装を監査
11. migration history乖離を再確認し、blind `db push` 禁止
12. 既存未コミット差分に触れない

## Phase A: Audit current fields and safe copy sources

まず実装前に確認する。

- `important_news_candidates` の利用可能な本文/見出し系フィールド: title / normalized_title / body_summary / generated_text / judgement_reason / affected_entities / fact/voice status等
- 個別銘柄とmarket-wideで、どのフィールドが最も安全に日本語表示に使えるか
- 既存のFact/Voice通過済み生成文を再利用できるケース
- `generated_text` がX向け文体すぎる場合の扱い
- 英語タイトルの日本語化がどの段階で可能か
- summaryにHTMLが混入する原因と、決定論的sanitizationでどこまで直せるか
- source_url / source title / published_at等、詳細画面に表示できるmetadata

## Phase B: Japanese title and summary strategy

### Title
1. 既存に安全な日本語見出しがあれば再利用
2. 無ければ、元タイトルを事実を変えず日本語化
3. 会社名・国名・政策名など固有名詞は自然な日本語表記へ
4. 数字・金額・日時・増減方向を変えない
5. 冗長な官公庁見出しは意味を保ったまま簡潔化

### List summary
- HTML/XML/DOM断片を除去
- URL、ナビ文字列、Copyright、サイト共通文言等を除去
- 日本語2〜4文程度、一覧では概ね120〜220字を目安
- 「何が起きたか」「誰/何に関係するか」が一目で分かる

### Detail summary
アプリ内詳細では、概ね以下を表示できる構造を目指す。
- 日本語タイトル
- 重要度バッジ（最重要 / 重要 / 注目）
- 対象（個別銘柄名 or 市場全体）
- 公開時刻
- **要点**: 2〜4項目
- **詳しい内容**: 3〜8段落程度、目安300〜800字。ただし元ソースの情報量が少ない場合は無理に水増ししない
- **市場との関係**: 既存の `relevance_reason` / `matched_sector` / affected entities等から説明できる場合のみ、1〜3文。投資助言・上がる/下がる断定は禁止
- 出典名/URL
- `元記事を確認` CTA

外部ソースを見なくても、ニュースの主要事実・背景・関係セクターが理解できることを目標にする。

## AI usage policy

英語ニュースの日本語化と十分な要約にAIが必要な可能性が高い。

ただし恒常経路へ新しいAI呼び出しを追加する場合は、実装前にReport/designへ以下を明記する。
- どのタイミングで呼ぶか
- 1候補あたり何回か
- 利用モデル
- 失敗時fallback
- Fact safety
- コスト/遅延
- 既存Fact/Voice通過済みテキストを再利用できない理由

**既存の生成済み・検証済み日本語テキストを再利用できるなら、それを最優先する。**
安易に同じニュースへ複数回AI生成を追加しない。
画面表示のたびにAIを呼ぶ実装は禁止。

## Phase C: In-app detail screen

Before:
- タップ → `source_url` を外部ブラウザで直接開く

After:
- タップ → アプリ内 `/news/[id]` 相当の詳細画面
- 詳細画面の最下部または出典セクションから外部元記事を開ける

UI要件:
- 現行デザイン/色/タイポグラフィに馴染ませる
- 日本語本文の可読性重視
- 長文はスクロール
- titleやsummaryにHTMLタグを絶対に表示しない
- source URLそのものを大きく露出しなくてよい
- 外部リンクであることが分かるCTAにする
- 戻る操作でニュース一覧へ自然に戻れる
- bottom tabとの干渉を避ける

## Phase D: Data/API design

最小で安全な方式を比較する。

候補例:
A. 既存candidate列からRPCで日本語表示用テキストを導出/整形
B. `display_title_ja` / `app_summary_ja` / `app_detail_ja` 等を保存
C. 別のnews presentationテーブルを持つ

判断基準:
- 既存データを安全に扱える
- 取得/判定/X/Pushを壊さない
- 既存行にも適用可能
- AIコストを毎回の画面表示時に発生させない
- 将来的なPush本文にも再利用可能
- migration history乖離下で安全に適用可能

## Existing-data proof

本番の自然データで最低限確認する。
1. 英語タイトルのmarket-wideニュース
2. HTML/DOM断片がsummaryに入っているニュース
3. 日本語TDnet個別銘柄ニュース
4. generated_textがあるpublishedニュース
5. medium/rejectedだがアプリ表示対象の個別IR

可能ならスクリーンショットに出ているTrump/Canada tariff系を実データで検証する。
人工candidate本番投入は禁止。

## Required tests

最低限:
- 英語タイトル → 日本語表示
- 数字/金額/日時/増減方向の保持
- HTMLタグ/属性/DOM断片が一覧・詳細に出ない
- 空summary時のfallback
- generated_text再利用時のラベル/出典行除去
- list summaryが過度に長くならない
- detail summaryが空にならない
- 元情報が少ない時に捏造して長文化しない
- 個別銘柄/market-wide両方
- Phase 3の関連性・sector match維持
- other-user/inactive/untrackedの安全境界維持
- duplicate exclusion維持
- X publish gate不変
- Push producer不変
- notifications増加なし
- app routing test/型検証
- app `tsc --noEmit`
- relevant Deno tests
- `git diff --check`

## Production rule

まず監査・設計・実装・テストまで進める。

本番反映について:
- DB/RPCだけで安全に完結し、事前rollbackテストで確認できる変更は単独migrationで適用可
- `supabase db push`は禁止
- `important-news-monitor` Edge Function deployが必要な場合は、**今回はdeployせずK1で明示承認を取ること**
- 新しい恒常AI生成経路をEdgeに追加する場合も、**本番deploy前にK1で止めること**
- appコードはcommit/pushまで可。ストア配布は不要

## Forbidden

- X publish基準変更
- X投稿量増加
- Push配信対象拡大
- market-wide全ユーザーPush
- Cron変更
- auto_publish変更
- OAuth/Vault/social_accounts変更
- x-test-post変更
- send-push-notifications変更/deploy
- artificial candidate本番投入
- candidate status変更/削除
- destructive migration
- 外部記事本文の丸ごと保存/転載
- 出典に無い事実の生成
- 投資判断の断定や売買推奨をsummaryへ混入

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- Report追記
- origin/main同期

Report必須:
- task_id
- result
- model_used
- root_cause
- current_data_audit
- chosen_title_strategy
- chosen_summary_strategy
- AI_call_added_or_not
- AI_cost_and_failure_behavior（追加した場合）
- detail_screen_design
- schema_or_rpc_changes
- app_changes
- existing_data_before_after
- tests
- x_publish_invariants
- push_invariants
- production_changes
- deploy_required_or_not
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

## Report

未開始。`G1` で開始すること。
