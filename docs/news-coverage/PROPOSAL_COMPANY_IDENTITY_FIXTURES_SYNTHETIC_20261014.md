# 提案: `company_identity_fixtures.ts` の第三者本文を合成テキストへ置換する専用TASK（案）

- 作成: 2026-10-14 JST（F8）。**本書は提案のみ。対象ファイルは変更していない**（read-only調査）。

## 1. 事実（read-only確認）

- ファイル: `supabase/functions/important-news-monitor/company_identity_fixtures.ts`（約49KB）。冒頭コメントに「Real TDnet candidates (production, 2026-09-30..10-02) … body_summary is verbatim.」とある。
- 内容: 8件（`sbiGam` / `sbi` / `kaihan` / `phc` / `synspective` / `alsok` / `otsuka` / `procrea`）。各件の `bodySummary` が、本番で取得した**適時開示PDFの本文をほぼそのまま**保持している（会社名・代表者名・電話番号・報道への言及などを含む）。`sourceUrl` も実在の `release.tdnet.info` のPDF。
- 利用箇所: `company_identity_scope_test.ts`（`companyIdentityEvidence` / `generationModelInput` の検証）と `tdnet_stocks_master_test.ts`。いずれもリポジトリ内のテスト。
- 問題: 第三者（開示企業）の文書本文をリポジトリに保存している。TDnetは閲覧サイトのrobots全拒否で、再配布許諾が確認できていない（先行docs: news_source_catalog）。`PROJECT_RULES` / TASK規定でも「第三者記事本文の無断保存禁止」。

## 2. 提案するTASK（別枠・F8以外でも可）

**目的**: 回帰テストの検出力を落とさず、第三者本文を**自作の合成テキスト**へ置換する。

1. 現行の各フィクスチャについて、`companyIdentityEvidence` の出力（`sameCompanyConfirmed`、検出された当事者・役割・エビデンス種別）と、各テストが依存する**構造的特徴**を記録する（本文は記録しない）。
   - 特徴の例: 表紙ラベルの文字間スペース（「会 社 名」）、`ＨＤ`/`ＦＧ` 等の略称と正式名称の対応、「当社」のみで会社名が書かれない本文、子会社/親会社が並記される合併・統合の開示、報道への言及（「一部報道について」）、全角英数字、`〔〕` の括弧種。
2. 各特徴を再現する**架空会社の合成本文**（架空の社名・代表者・電話・数値）を作る。実在する個人名・電話番号・住所は使わない。社名は、`companyName` / `companyCode` / `entityKey`（証券コード・銘柄名は公開された識別子であり事実）を保つ必要があるテストだけ、実在の銘柄名を保持してよい（本文のみ合成）。
3. `sourceUrl` は `https://example.test/...` 等へ置換（実PDFを指さない）。
4. **置換前後で `companyIdentityEvidence` の判定結果が同一**であることを、テストで固定する（特徴ごとの期待値を保持）。変異テスト（社名比較・当社判定・スペース正規化を壊す）で、合成フィクスチャでも失敗することを確認する。
5. `git log -p` に残る既存本文は履歴として残る（履歴書き換え＝force-pushはこのTASKの範囲外）。必要なら別途、履歴からの除去を検討する（運用判断）。

## 3. 完了条件の案
- 変更ファイルが `company_identity_fixtures.ts` と、必要な場合のみ当該2テストに限られる。
- 既存テスト（important-news-monitor全体）が全てPASS、エビデンス出力の差分0、変異テストで検出。
- リポジトリ全体で `release.tdnet.info` の実PDF URLと開示本文が残っていないことをgrepで確認（他ファイルの有無も同時に報告）。

## 4. 影響範囲・リスク
- 実装コードの変更なし（テスト資材のみ）。ただし本文の置換は、同定ロジックの回帰検出力に直結するため、手順4の同値確認が必須。
- 他のfixtures（`tools/` の合成fixture等）への波及は、grepで事前に確認する。
