# F6 — OpenAI→Anthropic 全API棚卸し・段階移行計画（POSTONA優先）
- task_id: common-ai-f6-openai-anthropic-migration-inventory-20261015
- slot: F6
- owner: claude
- status: done
- next_owner: none
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- start_code: F6
- completion_code: L6
- recommended_model: **Opus5.5（高）**
- production_mutation_window: CLOSED
- previous_archive: .agent_v2/archive/2026-10-15-f6-h5-bridge-boundary-repair.md

## 目的
現在OpenAI APIを利用するすべての呼び出し元を棚卸しし、POSTONA優先でAnthropic（Claude Sonnet/Haiku/Opus）へ安全かつ段階的に移す実装計画を作成する。かぶモリ運用休止はG1に委任し、このF6は停止操作を行わない。

## 開始前ゲート
fresh origin/main、PROJECT_RULES.md、新旧ACTIVE_TASK/CURRENT_STATE、旧G6とF6/J1/F3/F4/F5/F2/F8/F9のstatus/task_id、独立worktree、保護PRと変更対象の競合を確認。二重割当や未コミット変更の上書きを避ける。前回F6完了TASKはarchive保存済み。
依存：F6 PR #187（a7e1d3f3）、H5 PR #198（4223d5c0）、F6 PR #205（4cd2cbdd）、J1独立セキュリティレビュー（Sol（高）、現在ready）。いずれも未マージ。レビュー完了前に統合・本番切替しない。

## 調査対象・作業
1. リポジトリ全域でOpenAI SDK、OpenAI HTTP/Responses/Web Search、AIラッパー、fallback、Edge/Cron/RPC経由の間接呼び出しと設定を探索。mainとDraft PR内の経路を区別し、見落とし検証。
2. Supabase本番はread-onlyで、Cron→Edge→共通/個別AI→台帳の経路を整理。Secret値は閲覧禁止。10月の台帳実測を参照し、OpenAIの用途/費用をapplication・feature別に整理。
3. POSTONA（AI相談、投稿文生成、学習・分類）と、かぶモリ（重要ニュース、市況、MIC、AIに質問等）を区別。現在本番稼働、source-only、休止計画中の状態も併記。
4. 各経路についてAnthropicへの代替可否、Haiku/Sonnet/Opus推奨モデル、Web検索・構造化出力・tools等の非互換、料金/品質・認証・予算・冪等性リスクを一覧化。置換不可は明示。
5. POSTONA側の改修はF3/F4担当に依頼するため、呼び出し契約・テスト/実装TASK案を提示する。F6所有の共通プロバイダーとブリッジ以外は無断変更しない。
6. F6新規docs/ai-provider/文書へ全面移行マトリクス、PR依存、安全ゲート、段階ロールアウト、read-back、切戻し手順を記録。必要ならsource-only Draft PR。ローカルmockは許可するが課金API実通信をしない。

## 安全・変更不可
APIキー/Secret、実API呼び出し、Supabase Auth/DB/RPC/Cron/Edge、本番consumer設定、AI台帳の変更、X/Meta投稿、merge/deployは禁止。G1の運用休止計画、J1のreview、H5/F3/F4等の既存TASK・PR・worktreeを保護。既存Opus市場レポートの稼働に影響を与えない。モデル自動fallbackを追加しない。

## 完了条件
OpenAI全使用箇所の所有者/現在状態/入口/費用/移行方式の証跡、POSTONA優先の実行順序、モデル選択・API費用/品質測定法、安全/互換性/roll-back条件、残課題、changed_files、tests、commit/push、Draft PRを報告。TASK末尾にReport追記し review_required、next_owner chatgptでL6を返却。

## Report
- task_id: common-ai-f6-openai-anthropic-migration-inventory-20261015
- result: **INVENTORY_AND_PLAN_DONE（文書だけ）**
  - OpenAI を呼ぶ全 30 か所の棚卸しと、POSTONA を優先する段階の移行計画を作った
  - ソース・本番・台帳・Secret・設定の変更は 0。有料の呼び出しも 0
- branch / commit / PR
  - `claude/f6-openai-anthropic-inventory-20261015` @ `1dc7b72e3e36ceb75b9acc2ab605244cd8fd2af4`（base main）
  - Draft PR [#216](https://github.com/anohi-memories/kabumori/pull/216)
  - 最新の main（`1eb88b12`）と `merge-tree` で衝突なし
  - 新しい worktree `/Users/yuya/Developer/kabumori-f6-inventory`
- changed_files: `docs/ai-provider/F6_OPENAI_TO_ANTHROPIC_MIGRATION_PLAN.md`（新規、284 行）だけ
- 調べ方
  - main（`c0b6ae9f`）のコードを全体検索した。かぶモリ側と POSTONA・Draft PR 側は、読み取り専用の調査の助手 2 つで行い、要点は F6 が自分でも確かめた
  - Draft PR は全 79 本の変更ファイルと差分を確かめた
  - 本番は読み取りだけ
    - Cron 43 本の名前・時刻・有効かどうか（command は見ていない）
    - 関数 23 個の版と更新日時
    - 費用の表の列（情報スキーマ）
    - 10/1〜10/15 の利用の集計
- 主な結果
  - **全 30 か所**: POSTONA 2、かぶモリ 27、共通AI基盤の OpenAI の adapter 1（本番では未使用）
  - 画像の編集 1 か所（朝のあいさつ画像、`gpt-image-2`）を除き、すべて Responses API
  - Web 検索のツールを使う箇所が 7。embeddings、Chat Completions、streaming は無い
  - 既存の経路に、自動の fallback は無い
  - **POSTONA**
    - 呼び出しは AI 相談と、投稿文の生成部品の 2 つ（部品は試し投稿・会社員AIらぼ・利用者のブランドの 3 経路から使われる）
    - モデルは `social_ai_model_policy.ts` の gpt-6-luna
    - 共通AI基盤も台帳も通らず、**費用の記録は無い**
    - 投稿文の生成は自由文で、時間の上限が無い
  - **10月の記録額**: OpenAI 約 $19（MIC 約 6 割、重要ニュース約 3 割）。Claude Opus の市況レポートは $1.38
  - 置き換え可否
    - structured output と effort: 可（共通AI基盤が対応済み）
    - Web 検索: 可。ただし共通AI基盤にツールの対応が要る
    - 画像の編集: **不可**
- 段階の計画（docs §5）
  - 段階 0（F6）
    - #187 → #198 → #205 と J1 のレビュー
    - M2: 決まりが OpenAI も扱う。同じモデルのまま共通AI基盤を通す、2 段階の移行のため
    - 自由文を `{ text }` の JSON で包む部品
    - POSTONA の費用の計上（ブランド ID が UUID でない）
    - 台帳の枠の案、isolation の許可
    - M3: Web 検索のツール
  - 段階 P（F3 / F4）: 相談 → 試し投稿 → 会社員AIらぼ → 利用者のブランド
  - 段階 K（G1 の休止の判断の後）: MIC → 重要ニュース → Web 検索の経路 → X の文章 → 個別レポート
  - 市況レポートは移行済み
  - 依頼の案（コピー用）は docs §9
- 見つかった問題（docs §10。どれも別の担当・別承認）
  1. 市況レポートは、Claude で作る設定でも `OPENAI_API_KEY` が無いと止まる（`handler.ts:240-241`）
  2. DB の規則がモデル名を OpenAI に限っている（`important_news_candidates` のモデル名、`record_mic_fed_statement_diff_usage`）。移すには migration が要る
  3. 単価の計算の食い違い（重要ニュースの投稿文、MIC の gpt-5.6-sol）
  4. 費用の記録の漏れ（POSTONA 全部、X の一部、ニュースのアプリ用の文と探索）
  5. 時間の上限が無い（`x-test-post` 全体と、POSTONA の投稿文の生成）
  6. `x-test-post` の試験用のモードの一部で、認可の確認が見当たらない（要確認）
  7. 本番に、ソースの無い `brand-post-dry-run` が残っている
  8. `news-discovery-observer` のコードの説明と、本番の状態が食い違う（10月の検索は 0 件）
  9. POSTONA のプライバシーの表記に、AI の処理の委託先が無い
- tests: 文書だけなのでテストは無い。`git diff --check` と秘密情報スキャン 0、`merge-tree` で衝突なし
- merge 0、deploy 0、production の変更 0、paid_calls 0。Secret の値・`.env` は読んでいない
  - G1 の休止の計画、J1 のレビュー、H5 / F3 / F4 ほかの TASK・PR・worktree には触れていない
- next_recommendation
  - L6 で計画を評価する
  - 段階 0 の F6 M2 を F6 の次の TASK にする
  - 依頼案 1・2 を F3 へ（割り当ては ChatGPT）
  - 見つかった問題は各担当へ: 1 → F2、2・3 → F8 と MIC の担当、5・6 → X の担当、7 → 運用

## L6 ChatGPT acceptance 2026-10-15
- verdict: PASS_OFFLINE_PLAN / MERGE_HOLD / PRODUCTION_NO_GO
- accepted: docs-only inventory 30 sites and POSTONA-first plan at Draft PR #216 head 1dc7b72e3e36ceb75b9acc2ab605244cd8fd2af4.
- follow_up: preserve J1 P2 R1 dynamic import guard and R2 ambiguous timeout retry for next separately registered F6 task; no merge or production approval.
