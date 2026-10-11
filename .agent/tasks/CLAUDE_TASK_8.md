# Claude Task G8 — ニュース改善A / PR #129 R1指摘9件の修正実装

- task_id: news-improvement-a-pr129-f1-f9-remediation-g8-20261011
- owner: claude
- slot: claude-8
- status: ready
- next_owner: claude
- start_code: G8
- finish_code: K8
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- scope_owner: このチャットの「ニュース改善 A」のみ。今後もA作業はG8に割当（個別TASK完了後は同じ枠で再割当）。他の案件、他のG枠のTASKや作業を引き継がない。
- assignment_authorization: ユーザーが2026-10-11にG8の使用を明示承認
- type: corrective implementation, PR #129 review findings
- prohibited: production deploy, merge, paid API, DB/schema/RPC/migration/Cron/Secrets/model/Provider changes, unrelated work

## 背景・現在地

- PR [#129](https://github.com/anohi-memories/kabumori/pull/129) は **OPEN / Draft / 未merge**。レビュー対象head `61dd33d72711b11eefd39f77ac2d2431b9b6a9a5`（開始時に最新headを再確認）。
- branch: `claude/news-body-integration-phase7-20261011`。Phase 6 + Phase 7の決算短信・FOMC改善を統合済みだが、独立Codexレビューの判定は **CHANGES_REQUIRED（P1 5件 / P2 4件）**。
- 今回は **レビューの繰り返しではなく、指摘への実コード修正と回帰テスト**。独立レビューはH1/H2/C1/C2とは別件で、レビュー結果はこのTASK本文のF1〜F9を正本とする。別チャットにある本文を参照させずに完結させる。
- Phase 6 original: `b8d10833a992bc285a89d3ab37b2c3acd995bad0`; Phase7 reviewed head above。初期レビューの合成入力再現で9件の安全性アサーションが失敗。合成再現であり、実際の誤配信が発生したとは主張しない。
- PR #116の本番反映予定は **固定merge commit `a26e4365ebcb701491629892e8bae207d28833c2`のみ**。PR #129のコードを混入させない。PR #116本番作業のworktree `/Users/yuya/Developer/kabumori-pf` は絶対保護。

## 必須開始チェック / 非競合

1. `PROJECT_RULES.md` / `.agent/ORCHESTRATION.md` / `.agent/ACTIVE_TASK.md` / `.agent/CURRENT_STATE.md` / このTASKを読み、G8の `ready`、所有者、return_toを確認。
2. `/Users/yuya/Developer/kabumori-fresh` のfresh `origin/main`、PR129最新head、所有者、他TASK/Report、worktree list、未コミット変更、競合変更対象を確認。G8専用の独立worktree/checkoutを作る。既存A単独セッションが同じPR129を現在編集している可能性があれば、**同時変更はせず停止・報告**する。
3. `kabumori-ex`（Phase6）、`kabumori-pf`（PR116）、他slotのworktree/branch/dev server・未commitファイルは一切操作しない。H1〜H5/G1〜G7/G9/G10および他のTASK/Reportを編集しない。Bの`tools/provider-compare/`と評価用ドキュメントも触らない。
4. 権利確認待ちの日銀 `boj_document_text.ts` を本番経路へ接続しない。PR115や他PRへ変更を混ぜない。

## F1〜F9（レビューで再現された修正要件）

### F1 [P1] 分離した負号を除去し、損失を利益として出力
- 場所: `_shared/news_body_extraction/kessan_tanshin_facts.ts:103–104` の `parseRow`。
- 入力: 営業利益欄 `△ 100 △ 20`。現状 `+100百万円、+20%`、期待は `-100百万円、-20%`。結合した `△100 △20` は正常。
- 対応: 別トークンの負号を安全に数値へ結合、対応不明や想定外トークンは黙って落とさず **行を拒否**。誤った本文を後段Fact/VoiceがPASSするモックでも公開候補になり得るため、上流で防ぐ。正常・異常テスト。

### F2 [P1] 金額/増減率の列をトークン数だけで交互配置判定
- 場所: `kessan_tanshin_facts.ts:108–118`。
- 指標4列・単位 `百万円 百万円 百万円 百万円 % % % %`、数値行 `1,000 100 80 50 10 20 30 40` は **金額4個→増減率4個**。現状は交互配置と判断し営業利益80・経常利益10・純利益30に誤る。期待額は100/80/50。
- 対応: 見出し+単位+列配置から対応を確証する。交互配置と横並び配置の両方、曖昧な場合のfail-closedをテスト。数の個数だけから推定しない。

### F3 [P1] IFRS税引前利益を経常利益に誤置換
- 場所: `kessan_tanshin_facts.ts:56`, 出力名 `:205`。
- `売上収益 営業利益 税引前利益 親会社の所有者に帰属する当期利益` で税引前利益80を「経常利益80」と出力。
- 対応: 異なる会計指標を分離し元見出しの意味を保持。未対応なら数値を創作せず拒否。

### F4 [P1] 連結/個別の逆転
- 場所: `kessan_tanshin_facts.ts:93–95,170`。
- 直前に `参考: 個別財務諸表`、対象表の最近接見出しは `(1)連結経営成績`。現状個別と誤分類。
- 対応: **当該表に紐付いた最近接の明示見出し**を優先し、相反する場合は拒否。近傍の無関係な語で上書きしない。

### F5 [P2] 比較対象の四半期が不一致
- 場所: `kessan_tanshin_facts.ts:187–188`。
- 当期 `2026年3月期第1四半期`、前期 `2025年3月期第3四半期` を前年同期として出力。
- 対応: 年だけでなく決算期末月、四半期、累計/単独、通期/中間期、連結/個別の比較可能性を検査。確証なければ「前年同期比」にしない。

### F6 [P1] 過去の議事録を現在のFOMC声明と誤認
- 場所: `important-news-monitor/fed_statement_enrichment.ts:142–150`。
- RSSの2026年声明タイトルから同一公式host内の `/monetarypolicy/fomcminutes20250917.htm` に302される合成例。2025年議事要旨内の引用を2026年声明の新しい政策判断として出力した。
- 対応: HTTPS/hostに加え **最終URL種別・文書見出し・RSS公開日と文書日付・決定の主文・元候補との同一性**を検査。過去資料やminutes/projections/引用を声明として受理しない。実Fed redirectが起きた事実とは扱わない。

### F7 [P2] maxPerFetch=2で3件目以降が永久脱落
- 場所: `fed_statement_enrichment.ts:125–135`、`index.ts:2106` と後続重複判定。
- 同順3件を3回実行すると毎回先頭2件だけ取得、3件目は0回。保存済み先頭候補も枠を浪費。超過時errorsもなし。
- 対応: 既処理候補を取得枠から除き、未取得の公平性、上限維持、理由付き観測、次回再試行を検証。RSSから消える場合の継続性も検討。永続化/schema/RPCが必要なら勝手に実装せず BLOCKED/設計報告。

### F8 [P2] 反対者名のミドルイニシャルで切断
- 場所: `_shared/news_body_extraction/fomc_statement_facts.ts:103–109`。
- `Voting against this action were Christopher J. Waller and Michelle W. Bowman, who preferred a different action.` → 現状 `Christopher J` のみ・反対票1。期待は完全2氏名・2票。
- 対応: イニシャルと文末、名前と理由節を区別。票数を推測しない。不明時は明示的に未確定として安全に省略。全会一致も証拠がある時のみ。

### F9 [P2] 同URL既存候補に新本文を反映できない
- 場所: `important-news-monitor/index.ts:2106–2108,2142–2145`、`findNewsDuplicate():434–437`。
- 旧本文なし→新しい公式本文ありでcontentHashが変わっても、URL一致によりduplicateとして破棄される。
- 対応: published / no_post / generation_failed / 判定待ち / 本文不足 を区別。公開済み二重投稿は禁止、未公開の安全な本文更新・再判定、履歴/監査記録保護、競合・idempotency確認。DB schema/RPC/実データ変更が必要なら無断変更せず、残課題と安全な段階導入を提示。

## 横断安全要件

- 「読み取れなかった」注意文だけでは守れない。誤った/曖昧な従来要約の数字を確定重要Factとして扱わない。Factの照合元が誤るとFactモデルでは救えない。初回Fact誤PASSを考慮する。
- 誤情報を出さない **fail-closed** と、正常な重要ニュースを過剰停止しないことの双方を検証。
- 日銀公式本文の新取得・保存・接続は禁止（権利確認待ち）。TDnet 403迂回、第三者記事本文の無断保存は禁止。
- APIキー/トークン/本番DB/外部書き込み/モデル/Secrets/Cron/Edge deploy/本番変更をしない。PR129はDraft継続、mergeは禁止。
- 既存の独立レビュー用 `review_test.ts` 等は別セッションのファイルのため直接改変せず、必要なら再現条件をこのTASKから自己完結でテスト化する。

## 必須テストと完了条件

- F1〜F9各項目に「before失敗→after期待値」テスト、正常対照（適法な数値・既存の交互列・声明）を追加。
- `important-news-monitor` 全体（レビュー時742 PASS）、Phase6の19件、Phase7の15件、`news_discovery`+observer（162 PASS報告）をオフラインで再実行。累計を二重計上しない。
- 可能な限り実PDF39/60件の集計と、当期/前期数値の正確性を再照合。本文はrepo/DBに保存しない。観測できない実データは未実施と明記。
- P1の5件をすべて解消。P2の4件を修正、または安全な未解決/実装停止と依存条件を明示。P1/P2未解決の状態で全面PASSを自称しない。
- 競合なしを確認できた場合に限りPR129の既存branchにcommit/push。PRheadを再取得してから差分を適用、他作業を上書きしない。**merge/deploy禁止**。
- 完了後、このTASK末尾の `## Report` に task_id/result/F1〜F9個別状態/changed_files/tests/before_after_quality/commit_hash/push/PR_head/remaining_issues/safety_checks/next_recommendation を書き、`K8` を **ニュース改善API最適化のちゃ** に返す。別チャットの作業を進めない。

## Report

- task_id: news-improvement-a-pr129-f1-f9-remediation-g8-20261011
- result: not_started
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- merge: not_performed
- deploy: not_performed
- remaining_issues: F1〜F9（上記）
- safety_checks: not_started
- next_recommendation: G8で開始し、安全な専用worktreeを作って修正を実施。完了時K8。
