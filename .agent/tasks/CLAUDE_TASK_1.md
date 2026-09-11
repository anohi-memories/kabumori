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

- task_id: in-app-news-japanese-detail-summary-20260911
- result: **一部完了（AI を使わない範囲は本番反映済み。日本語が無い英語記事の翻訳は設計まで、K1 待ち）**。
  - カードのタップ先を、外部サイトからアプリ内の詳細画面 `/news/[id]` に変えた。元記事は、詳細画面の下にある「元記事を確認（外部サイト）↗」で開く二次導線にした。
  - タイトルと要約は、既存の検証済みの日本語テキストだけを使う決定論的な整形で作る。HTMLやエンティティの混入は、本人フィード12件で**0件**になった。
  - 英語の市場ニュースのうち、Fact を通過した日本語テキストがある3件は、日本語のタイトル・要約・詳細になった。
  - TDnet の開示5件は、レターヘッドとPDF由来の文字間の空白を除いた日本語本文で表示する。
  - Fact を通過した日本語テキストが無い英語記事4件（画面に出ていた「Ambassador Greer…」を含む）は、**訳文を作らず**、原題と「日本語の要約は準備中です」の表示、元記事の抜粋を出す。
  - この4件を日本語にするには、新しい AI 翻訳の経路が必要。タスクの規則に従い、設計（呼び出すタイミング、回数、モデル、コスト、失敗時の扱い、Fact の安全性）までにとどめ、実装と deploy は K1 の判断を待つ。
  - X・Push・Cron・auto_publish は無変更。notifications は0件のまま。
- model_used: Opus 5

### root_cause

1. **英語タイトル**: 取得したままの `title` を表示していた。英語の見出しを持つ候補は69件（breaking_market 25 / market_macro 44）。日本語テキストは X 投稿用の `generated_text` にしか無く、アプリはそれを受け取っていなかった。
2. **HTML の混入**: USTR の RSS（market_macro）の本文が、ページの HTML ごと保存されていた（`<span id="pageTitle" class="field field--name-title …">…`、最大6,870字）。該当は4件で、すべて market_macro。アプリは `body_summary` を加工せずに表示していた。
3. **外部サイトへの直行**: カードの「記事を開く」が `Linking.openURL(source_url)` で、アプリ内の詳細画面が存在しなかった。
4. **TDnet の本文**: PDF から抽出したテキストで、「各 位 会社名 … 代表者名 …（電話番号…）」というレターヘッドと文字間の空白が、そのまま要約になっていた。

### current_data_audit

- 本文系の列: `title` / `normalized_title` / `body_summary` / `generated_text` / `judgement_reason` / `affected_entities` / `generation_fact_status` / `generation_voice_status` / `source_type` / `source_url` / `published_at`。
- 英語の X 級（important / most_important）の市場ニュース16件の生成状況:
  - Fact passed: 11件（published 2 / ready_for_publish 7 / generation_failed かつ Voice failed 2）
  - Fact failed: 5件（generation_failed、Voice not_run）
- 本人フィード12件（個別5・市場7）の内訳:

| 記事 | 種別 | 日本語テキスト | 表示の方式 |
|---|---|---|---|
| 円が2日間で約5円上昇（Yen advances sharply） | 市場 / high | Fact・Voice passed | verified_post（日本語化） |
| 財務相、協調介入の正式要請なし | 市場 / high | Fact・Voice passed | verified_post（日本語化） |
| カナダの報復関税（Canada strikes back） | 市場 / high | Fact passed・Voice failed | verified_post（日本語化） |
| Ambassador Greer Issues Statement…（トランプ氏のカナダ対応） | 市場 / critical | **Fact failed** | original_only（準備中） |
| Japan's official reserve assets fell… | 市場 / high | **Fact failed** | original_only（準備中） |
| U.S. August payrolls rise by 162,000… | 市場 / high | **Fact failed** | original_only（準備中） |
| U.S. payrolls increased by 162,000… | 市場 / high | **Fact failed** | original_only（準備中） |
| KDDI・トヨタ・ソニーG・日立 の自己株式取得状況 | 個別 / medium | なし（TDnet 日本語） | disclosure |
| ソフトバンクG 第70回社債の条件決定 | 個別 / high | Fact failed（使わない） | disclosure |

- `generated_text` を X 向けの文体として扱う点: 先頭の【速報】/【重大速報】ラベルと末尾の「出典: URL」を外せば、日本語のニュース本文として読める（1〜3段落、100〜300字程度）。絵文字を含むことがあるが、Voice の審査を通ったものなので、そのまま残した。
- `judgement_reason` は日本語だが、「最重要とは判断できない」のような判定メモを含むため、利用者向けの本文には使っていない。
- 詳細画面に出せるメタデータ: 出典の URL（ホスト名から出典名を日本語で表示）、公開時刻（`news_time`）、対象（銘柄 / 市場全体 + 関連する業種）、重要度（severity）。

### chosen_title_strategy

1. 元のタイトルに日本語が含まれる → そのまま使う（TDnet・日本語ソース）
2. 英語のタイトルで、Fact を通過した日本語テキストがある → その**最初の1文**を見出しにする（60字以内。末尾の「。」は外す）。数字・金額・方向は、検証済みの文のまま（例:「円が2日間で約5円上昇し、1ドル＝155.75〜155.85円と約1カ月ぶりの円高水準です」）
3. どちらも無い → 英語の原題をそのまま表示する（端末上での翻訳や言い換えはしない）。詳細画面では「原題: …」も表示

### chosen_summary_strategy

`src/lib/news-presentation.ts`（import の無い純粋なモジュール。Deno でテストでき、Metro でバンドルもできる）。優先順位:
1. **verified_post**: Fact を通過した日本語テキスト（RPC が `generation_fact_status = 'passed'` のときだけ返す）。ラベル・出典行・URL を除いて段落に分ける。一覧の要約は、見出しに使った1文目の次の文から200字以内（文の途中では切らない）。詳細は全段落。要点は、4文以上あるときだけ先頭の3文（短い文章だと、タイトル・要点・本文が同じ文の繰り返しになるため）。
2. **disclosure**: 日本語の開示（TDnet）。見出しの後ろ（空白を無視して照合）、または最初の「当社は／当社が」から使う。レターヘッドを捨て、PDF 由来の文字間の空白を除く。一覧は200字、詳細は800字以内（2文ずつの段落）。
3. **japanese_body**: そのほかの日本語の本文。HTML を除去して同様に整形する。
4. **original_only**: 日本語が何も無い。一覧は「日本語の要約は準備中です」、詳細は説明文と、元の記事の抜粋（HTML 除去済み、600字以内）。**訳文の捏造はしない**。

どの方式でも、共通の処理は次のとおり:
- HTML のタグ・コメント・script/style・途中で切れたタグの除去、エンティティのデコード
- URL の除去
- 文の区切りは、括弧の中の「。」を無視する
- どうしても切る場合も、数字の途中では切らない

市場ニュースには「市場との関係」を定型文で添える。例:「為替・金利に関するニュースです。登録している機械の銘柄に関係する可能性があるため表示しています。」上がる・下がる・売り・買いといった方向の表現は含めない（テストで確認）。

### AI_call_added_or_not

**追加していない**。今回の本番反映は、既存の検証済みテキストの再利用と決定論的な整形だけ。画面を表示するたびに AI を呼ぶ処理も無い。

### AI_cost_and_failure_behavior（追加する場合の設計。今回は未実装・未 deploy。K1 の判断待ち）

対象: アプリに表示される候補のうち、タイトルが日本語でなく、Fact を通過した `generated_text` も無いもの（本人フィードでは4件。全体では英語の X 級16件中5件）。

- **タイミング**: 既存の `generate_ready`（generation の Cron が呼ぶ処理）の最後に、「アプリ用の日本語コピー」の生成を追加する（Cron は変更しない）。1回の実行で最大5件まで。表示時には呼ばない。
- **1候補あたりの回数**: 生成1回 + Fact チェック1回の、最大2回。失敗しても、次の回に1回だけ再試行する。
- **モデル**: 既存の判定・生成と同じ `gpt-5.6-luna`（入力 $0.20 / 出力 $1.20 per 1M tokens）。
- **入力**: 保存済みの `title` と `body_summary`（HTML 除去済み・最大3,000字）だけ。Web 検索と外部の知識による補完は禁止。
- **出力**: JSON `{ title_ja, summary_ja（200字以内）, detail_ja（800字以内）, key_points_ja[] }`。
- **Fact の安全性**: 既存の生成で使っている Fact チェックと同じ方式で、原文にない数字・固有名詞・因果・投資判断が無いかを確かめる。passed のものだけを表示する。
- **保存先**: `important_news_candidates` に列を追加する（`app_title_ja`・`app_summary_ja`・`app_detail_ja`・`app_copy_fact_status`・`app_copy_model`・`app_copy_generated_at`）。既存の列を変えない、追加だけの変更。
- **失敗時**: 状態を failed で保存し、アプリは今と同じ original_only（原題 + 準備中）で表示する。X と Push には影響しない。
- **コスト**: 1件あたり入力約1,500 tokens・出力約800 tokens で約 $0.0013 × 最大2回 = 約 $0.003。英語の表示対象は1日数件なので、月 $1 未満の見込み。
- **遅延**: 生成の Cron（20分ごと）の中で非同期に作るので、表示の遅延は無い。表示されるまでは最大で約20〜40分、準備中の表示になる。
- **既存テキストを使えない理由**: 対象の4件は、生成済みの日本語テキストが Fact チェックに不合格。不合格の文章を利用者に見せるのは、事実の安全性に反する。
- **必要な作業**: 列を追加する migration、`important-news-monitor` の変更と deploy、RPC がその列を返すようにする変更。→ **K1 の承認後に実施**。

### detail_screen_design

`src/app/news/[id].tsx`（重要ニュースのタブの中の Stack。一覧から push で開き、戻る操作・戻るボタン「一覧」で一覧に戻る）:
- バッジ行: 市場 / 保有 / 監視、関連する業種または ticker、重要度（最重要 / 重要 / 注目）
- 対象: 銘柄名、または「市場全体」
- 日本語タイトル。表示タイトルが原題と違う場合は、小さく「原題: …」
- 公開日時（年を含む）
- **要点**（ある場合）
- **詳しい内容**（段落）。日本語が無い場合は「日本語の要約は準備中です」の案内と、元記事の抜粋
- **市場との関係**（市場ニュースだけ。方向は言わない）
- **出典**: 出典名（例: 米通商代表部（USTR）、AP通信、財務省、TDnet（適時開示））と「元記事を確認（外部サイト）↗」。URL そのものは大きく出さない
- 長い本文はスクロールでき、下端に余白を取ってタブバーと重ならないようにした
- 詳細画面のデータは、一覧と同じ RPC から取る。そのため、アクセスできる範囲（本人・アクティブ・関連する市場ニュース）が一覧と完全に同じで、範囲外の ID は「表示できません」になる

### schema_or_rpc_changes

`supabase/migrations/20260911150000_news_feed_presentation_fields.sql`（1トランザクション・本番適用済み）:
- `get_my_important_stock_news(integer)` を作り直し、戻り値の末尾に `source_type text`、`verified_text text` を追加した。
- `verified_text` = `case when generation_fact_status = 'passed' then generated_text end`。**Fact に不合格の生成テキストは、この RPC から一切出ない**（静的テストで、`generated_text` の参照はすべてこの条件付きであることを固定）。
- 表示する記事の選び方（個別銘柄・市場ニュースの条件、並び順、件数上限）は、Phase 3 と**同一**（静的テストで、条件の部分を Phase 3 の migration と比較）。
- SECURITY DEFINER・`search_path=''`・権限（authenticated のみ）は同じ。テーブル・列・行の変更は無し。

### app_changes

- `src/app/news.tsx` → `src/app/news/index.tsx`（移動）。カードをタップするとアプリ内の詳細画面へ移動する。タイトル・要約は整形済みの日本語。日本語が無い場合は「日本語の要約は準備中です（詳細で元記事の抜粋を確認できます）」。「記事を開く」の外部リンクは廃止し、「詳しく見る ›」にした。
- `src/app/news/_layout.tsx`（新規）: 重要ニュースのタブ用の Stack（一覧はヘッダーなし、詳細は「ニュース詳細」、戻るボタンは「一覧」）。
- `src/app/news/[id].tsx`（新規）: 詳細画面。
- `src/lib/news-presentation.ts`（新規）: 表示用の整形（上記）。
- `src/lib/news-labels.ts`（新規）: 一覧と詳細で共通のバッジ・対象・日時の表示。
- `src/lib/important-news.ts`: 型に `source_type` と `verified_text` を追加。詳細画面用の `fetchMyImportantNewsItem(id)`（一覧と同じ RPC を使う）を追加。
- Push をタップしたときの遷移先 `router.push('/news')` は、`news/index` にそのまま解決される（変更なし）。
- 型付きルート: 生成物の `.expo/types/router.d.ts`（gitignore 対象）が古く、新しいルート `/news/[id]` を含んでいなかった。`expo start` と同じ生成処理（`@expo/router-server` の `regenerateDeclarations`）を、Metro を起動せずに実行して作り直したところ、`src/` の型エラーは0件になった。

### existing_data_before_after

本人フィード12件（本番の実データ）に、新しい整形を適用した結果:

| 記事 | 変更前のタイトル / 要約（冒頭） | 変更後 |
|---|---|---|
| 円の急騰（high・市場） | Yen advances sharply, gaining about ¥5… / The yen strengthened to around ¥155.75… | タイトル「円が2日間で約5円上昇し、1ドル＝155.75〜155.85円と約1カ月ぶりの円高水準です」。要約「日銀の利上げ加速観測に加え、円キャリートレードの巻き戻しが円高を支えています。…」。関係「為替に関するニュースです。登録している機械の銘柄に関係する可能性があるため表示しています。」出典: 日本経済新聞 |
| 財務相（high・市場） | Japan finance minister says no formal U.S. request… | 「日本の片山さつき財務相は9月4日、米国から協調為替介入や金融政策対応について、正式な要請は受けていないと説明しました」。出典: 財務省 |
| カナダの報復関税（high・市場） | Canada strikes back with tariffs on about $20 billion… | 「カナダが、約200億ドル相当の米国製品を対象に報復関税を発表しました」。出典: AP通信 |
| **Ambassador Greer…（critical・市場）** | 同じ英語のタイトル / `<span id="pageTitle" class="field field--name-title …">…` | 英語の原題のまま（**準備中**）。**HTML は消えた**。詳細には、元記事の抜粋（599字）と「自動車・通商・関税に関するニュースです…」、出典: 米通商代表部（USTR） |
| 外貨準備 / 雇用統計×2（high・市場） | 英語のタイトル / 英語の要約 | 原題のまま（準備中）+ 抜粋 + 市場との関係。出典: 財務省 / AP通信 / 米労働統計局 |
| KDDI 自己株式取得状況（medium・個別） | 各 位 会 社 名 ＫＤＤＩ株式会社 代表者名 … | 「当社は、会社法第165条第３項の規定により読み替えて適用される同法第156条の規定に基づく自己株式の取得につきまして、以下の通り、取得状況をお知らせいたします。」 |
| ソフトバンクG 社債（high・個別） | 本店所在地 東京都港区海岸一丁目 … | 「当社は本日、…発行条件を決定しましたので、下記のとおりお知らせいたします。」詳細（633字）で「発行総額 金１兆円・利率 年4.75%・年限 7年・利払日・申込期間」まで読める |
| ソニーG・日立・トヨタ 自己株式取得状況（medium） | 各 位 … / 2026 年 9 月 2 日 株式会社日立製作所 … / 自 己 株 式 の … | それぞれ「当社は、…」「株式会社日立製作所は、…」「（会社法第165条…）当社は、…」から始まる本文。日立の詳細では、取得株式数 10,498,200株・取得総額 57,226,868,800円まで読める |

集計: verified_post 3 / disclosure 5 / original_only 4。HTML・エンティティが残った件数は **0/12**。

### tests

- `tests/app/news-presentation_test.ts`（新規・12件）: 英語のタイトル → 検証済みの日本語 / 数字・金額・日時・方向の保持（155.75〜155.85円、約200億ドル相当など）/ ラベル・出典行・URL の除去 / HTML のタグ・属性・エンティティ・途中で切れたタグの除去 / 検証済みの日本語が無いときは訳さず原題 + 抜粋 / TDnet のレターヘッドと空白の除去 / 一覧の要約の長さの上限 / 詳細が空にならない / 情報が少ないときに水増ししない / 空・異常な入力 / 市場との関係に方向の表現を含まない / 出典名 / 数字の途中で切らない
- `news_presentation_sql_static_test.ts`（新規・4件）: 個別銘柄・市場ニュースの抽出条件と並び順・件数上限が Phase 3 と同一 / `generated_text` は Fact passed のときだけ / 1トランザクション・行の書き込み無し・権限・`notifications`・Cron・auto_publish・`x_post_id` に触れない
- 既存の静的テスト（Phase 2・3）: 無変更で通過（合計13件）
- 本番データのロールバック付きテスト: Phase 3 のフィード12件と、並び順まで含めて完全一致（欠落0・追加0）/ `verified_text` は3件で、Fact に不合格なのに出たもの0・Fact passed なのに出なかったもの0 / 他ユーザー・未ログイン 0 / 権限は同じ。その後、本番が元のまま（RPC は Phase 3 の13列）であることを確認
- important-news-monitor 全体の回帰: **327 passed / 0 failed**
- アプリ: 型付きルートを作り直したうえで `tsc --noEmit` の `src/` のエラー0件
- `git diff --check`: clean

### x_publish_invariants

- `important-news-monitor` のコード変更・deploy なし（v38 のまま）。X 公開ゲート・auto_publish・cutover・rate control は無変更
- 今回の DB の変更は、アプリの読み取り用 RPC に列を2つ足しただけ
- 確認: `auto_publish = true`、設定の `updated_at` は変化なし

### push_invariants

- `send-push-notifications` と producer は無変更。Push の本文にも影響しない（Push は producer がつくった notifications の本文を使う）
- Push をタップしたときの `/news` への遷移は、新しいルート構成でも同じ一覧に着く
- 確認: 適用の前後とも notifications = 0。Cron は8本すべて active で変化なし

### production_changes

- `supabase/migrations/20260911150000_news_feed_presentation_fields.sql` を本番に単独で適用した（`db push` は使っていない。適用直前に root を確認: `pwd` = worktree、HEAD `0a176c2`、worktree 内の `supabase/config.toml`、project ref `wsmznyzcvmuitkglfeuj`。事前にロールバック付きで検証済み）
- 適用後の確認:
  - RPC の列に `source_type`・`verified_text` が加わった
  - SECURITY DEFINER・`search_path=""`・ACL `{postgres=X/postgres,authenticated=X/postgres}`、anon は実行不可
  - 本人フィードは12件（個別5・市場7）で、Phase 3 と同じ
  - verified 3件で、漏れは0
  - notifications 0、auto_publish・Cron は変化なし
  - Edge Function 6つは変化なし
- アプリのコード: commit と push まで（ストア配布なし）

### deploy_required_or_not

- 今回の範囲（決定論的な日本語化・HTML 除去・アプリ内の詳細画面）: **Edge の deploy は不要**（DB の RPC とアプリのコードだけ）
- 残りの英語記事の日本語化（AI 翻訳）: `important-news-monitor` の変更と deploy、列を追加する migration が必要 → **K1 での明示的な承認が必要**（上記の設計のとおり）

### changed_files

- `supabase/migrations/20260911150000_news_feed_presentation_fields.sql`（新規・本番適用済み）
- `supabase/functions/important-news-monitor/news_presentation_sql_static_test.ts`（新規）
- `src/app/news.tsx` → `src/app/news/index.tsx`（移動・変更）
- `src/app/news/_layout.tsx`（新規）
- `src/app/news/[id].tsx`（新規）
- `src/lib/news-presentation.ts`（新規）
- `src/lib/news-labels.ts`（新規）
- `src/lib/important-news.ts`（型と、詳細画面用の取得関数）
- `tests/app/news-presentation_test.ts`（新規）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

### commit_hash

- この直後の commit で、上記のファイルと本 Report をまとめて記録する

### push

- `origin/main` へ同期済み

### remaining_issues

1. **英語の市場ニュースのうち、Fact を通過した日本語テキストが無いもの**（本人フィードで4件。画面に出ていた Greer / カナダの件を含む）は、まだ英語の原題と準備中の表示になる。→ AI 翻訳の経路（上記の設計）を K1 で判断する。
2. **Fact 不合格の原因は、今回は調べていない**。`generation_fact_status = failed` の中には、生成の側の問題で落ちたものもあるかもしれない。AI 翻訳を足す前に、Fact の不合格の傾向を見るのも一つの手。
3. TDnet の開示の本文は「当社は、…お知らせいたします。」という形式的な書き出しが多く、一覧の要約としては中身が薄いことがある（詳細画面では、表や数字まで読める）。見出しからの小分類（Phase 1）と組み合わせた、数字の抜き出しは今後の改善。
4. トヨタの例で、要約が「（会社法第165条…）当社は、…」と括弧書きから始まる。見出しの直後にある括弧書きの補足を飛ばす処理は入れていない。
5. 型付きルートの生成物（`.expo/types/router.d.ts`）は gitignore 対象。別の環境で `tsc` を実行するときは、先に `expo start` を実行する（または同じ生成処理を実行する）必要がある。
6. 詳細画面は、一覧と同じ RPC（上限50件）から ID を探す。50件の枠から外れた古い記事は「表示できません」になる（Push からの遷移先は一覧なので、実害は小さい）。
7. アプリの実機での表示確認は行っていない（dev build は、Metro から新しい JS を読み込めば反映される）。
8. migration 履歴の乖離、前タスクまでの既知課題は継続。

### safety_checks

- X 公開基準・X 投稿量・auto_publish・Cron・Push の配信対象の変更なし。市場ニュースの Push なし
- `send-push-notifications`・`x-test-post`・OAuth・Vault・social_accounts の変更なし
- 新しい AI 呼び出しの追加なし（設計のみ）。表示時に AI を呼ぶ処理も無い
- 人工の candidate の投入なし。candidate の状態変更・削除なし。既存行の書き換えなし
- 破壊的な migration なし（関数の作り直しは、同じトランザクション内で権限まで含めて復元）
- 外部記事の本文を丸ごと保存・転載していない（表示は保存済みの要約の抜粋で、600字以内）
- 出典に無い事実を作っていない（Fact に不合格の生成テキストは RPC から出さない。端末上での翻訳もしない）
- 「市場との関係」に投資判断・方向の断定を含めない（テストで確認）
- `db push` は使わず、対象ファイル1本だけを適用した。本番での検証は read-only と、ロールバックするトランザクションだけ
- 共有 checkout の未コミット変更、Claude slot 2・Codex slot 2 の担当範囲には触れていない

### next_recommendation

1. **K1: 英語の市場ニュースの AI 翻訳の経路を承認するか判断する**（上記の設計。モデル luna、1件あたり最大2回、Fact チェック付き、月 $1 未満の見込み、既存の生成 Cron の中で動かす）。承認されれば、列を追加する migration → `important-news-monitor` の実装とテスト → deploy → RPC の拡張、の順で進める。
2. アプリの実機で、一覧 → 詳細 → 元記事 → 戻る、の導線と、長文のスクロール・タブバーとの重なりを確認する。
3. TDnet の開示の要約を、数字（取得株式数・金額・期間など）の抜き出しで充実させる（remaining_issues 3・4）。
