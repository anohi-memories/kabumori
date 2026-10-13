# F9: 権利安全なモデル比較ツールの検証・公開準備（2026-10-13 JST）

TASK: `api-optimization-b-f9-rights-safe-provider-compare-pr-readiness-20261013`（API最適化 B / 返却先 L9）

旧 G9 R3 のクリーンブランチ（`claude/b-provider-compare-rights-safe-20261012`、`c476ef8a`）を、最新の `main` に載せ直して検証し、公開前に必要な小修正を加えた。有料API・実ネットワーク・本番アクセスは使っていない。PR #115・旧ブランチ・履歴には触れていない。

## 1. 検証結果

| 項目 | 結果 |
|---|---|
| 土台 | 最新 `origin/main`（作業開始時 `83407d61`、旧クリーンブランチの基点より 309 コミット先）から新規ブランチ `claude/f9-provider-compare-rights-safe-20261013`。旧クリーンコミットを cherry-pick（`main` 以外に親なし）。旧 PR #115 / Phase 5 / G9 のコミットは祖先に含まない |
| 競合 | `tools/provider-compare/` と `docs/model-optimization/` は main に存在しない。open PR でこれらのパスに触れるのは #115 のみ。ハーネスが読む本番ファイル5本は、旧クリーンブランチの基点以降、main で無変更 |
| テスト | `deno test --no-config -A tools/provider-compare/`: 304 passed / 0 failed / 1 ignored（旧本文の実物を要する検査。私的ファイルがある環境でのみ実行され、手元で PASS を確認） |
| 型検査・lint | `deno check`（全 `src` / `providers` / `scripts`）エラーなし、`deno lint` エラーなし |
| 本文の残存（40文字窓、旧18本文 vs `tools/` `docs/`） | 本文 0 件、**見出し 0 件**（R3 では見出し 3 件が残っていた） |
| 外部送信ゲート | 空の許諾台帳で18件は全経路 blocked。ハッシュ一致・`--runtime-bodies`・有料実行の opt-in では解除されない（R2/R3 から変更なし） |
| 費用算定 | Claude 3 モデルと `gpt-6-luna` の価格が、本番の provider カタログ（`supabase/functions/_shared/ai_provider/model_catalog.ts`）と一致することをテストで固定（下記 2-3） |

## 2. 今回加えた変更

### 2-1. 見出しの非保持（R3 の残件の解消）

- 旧18本文のうち TDnet の開示タイトル3件は、本文の1行目と同一（40〜57文字）だった。権利未確認の記事の見出しは、本文と同じ扱いにした。
- `cases.rights_safe.json` の該当18件の `title` を `（見出し非保持: 権利未確認）#<id8>` に置き換えた（ケースごとに一意）。マニフェストに見出しの `titleChars` / `titleSha256` を追加した。
- ローカル export の行（`scripts/export_cases.sql` の `title`）が SHA-256 で一致したときだけ、見出しを付与する。見出しが無い export・一致しない見出しは `body_source_missing` / `body_hash_mismatch` で除外する。付与された見出しも、許諾が無ければ外部へ送れない（ゲートが見出しの断片を含むペイロードを拒否する）。
- 既定（export なし）では、この18件は従来どおり `needs_rights_review` で実行から外れるため、機能上の損失はない。
- `scripts/export_cases.sql` が選択条件に書いていた英文の見出し文字列3件を、ケースの id 接頭辞による選択に置き換えた（取得される行は同じ）。

### 2-2. 残っている見出しの重複（説明）

- `eval_nopost_sample.json` に、旧18件の見出しと文字列が一致するものが1件ある。別の候補（TDnet の定型見出し「…に関する日々の開示事項」、30文字）で、同じ固定の表題が繰り返されているだけである。評価セットの方針（見出し・URL を保持）に従い、そのまま保持した。

### 2-3. 費用算定の整合

- `gpt-6.1-sol` の価格に、272K トークン超のティア（入力 4 / 出力 15 USD per 1M）を追加した。本番のカタログと同じ算式にするためで、本ツールのニュース用プロンプトは数千トークンなので比較結果は変わらない。
- 新規 `pricing_catalog_consistency_test.ts`: 両方の表にあるモデル（Claude 5.5 の3種、`gpt-6-luna`、`gpt-6.1-sol`）の価格・キャッシュ価格・長文ティアが一致することを検証する。許可リスト（`isolation_test.ts`）に、読み取り専用のカタログ1ファイルを追加した。
- 料金・品質は、公開されている価格表と過去の台帳の平均に基づく**見積もり**であり、実測値ではない。有料の比較は別途の承認が必要である。

## 3. 公開の前提（Draft PR）

- 差分は新規ファイルの追加のみで、`tools/provider-compare/` と `docs/model-optimization/` に限る。main 側のファイルの変更・削除はない。
- PR の説明に明記すること: 「PR #115 の権利安全な置き換え候補。PR #115 のクローズ・旧ブランチ削除・GitHub 履歴の消去は未承認、merge も未承認、実AI比較・deploy なし。」
- merge 後の移行案（所有者判断）: PR #115 を理由付きでクローズし、旧ブランチ3本を所有者が削除する。`refs/pull/115/head` と GitHub 内部のキャッシュからの完全な消去は、本タスクでは達成できない。

## 4. 残る課題

1. **main にもともとある2ファイル**（本ブランチは変更していない）: 旧本文と40文字以上一致する。`supabase/functions/important-news-monitor/company_identity_fixtures.ts`、`supabase/functions/market-report-analysis/fixtures/close_2026-09-30_news_rows.json`。所有する工程（A/G8 など）の判断が必要。
2. **旧ブランチと履歴**: 旧本文を含むのは `claude/b-claude-api-compare-20261009`（PR #115）、`claude/b-news-eval-prep-20261010`、`claude/g9-fixture-rights-cost-eval-20261011` の3本と、GitHub の `refs/pull/115/head`。`claude/b-provider-compare-rights-safe-20261012`（R3）は本文を含まないが、見出し3件を含む（本ブランチで解消）。クローズ・削除・書換は未承認。
3. **許諾**: TDnet 等の利用条件は未確認。確認できたら台帳に証拠付きで追記する（コード変更なしで送信が可能になるため、所有者の確認を経ること）。
4. **過去の送信**: Phase 2 の L0 で、18件を含む fixture 本文を Anthropic の無料 `count_tokens` へ送っている（開示済み、取り消せない）。
5. **有料比較・merge・deploy**: 未承認。
