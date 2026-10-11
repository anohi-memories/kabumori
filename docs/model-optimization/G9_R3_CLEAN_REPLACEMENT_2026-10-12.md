# G9 R3: 第三者本文を含まない比較ツールの置き換え候補（2026-10-12 JST）

TASK: `api-optimization-b-g9-r3-clean-history-provider-compare-replacement-20261011`（API最適化 B / 返却先 K9）

PR #115（Draft、head `8f430557`）は `fixtures/cases.json` に権利未確認の第三者本文18件（TDnet 11 / Al Jazeera 3 / BBC 2 / AP 2）を含むため、そのまま merge すると main に入る。本ブランチは、**最新の `origin/main` だけを親とする新規ブランチ**に、本文を含まない最終コードだけを載せた置き換え候補である。PR #115・旧ブランチは変更していない。有料API・実ネットワーク・本番アクセスは使っていない。

## 1. 何が入っているか

| 区分 | 内容 |
|---|---|
| コード | `tools/provider-compare/`（比較ハーネス、評価セット、外部送信ゲート、許諾台帳、基準指標）。G9 R2（`65c95589`）と同じ最終ツリーから、`fixtures/cases.json` だけを除いたもの |
| 文書 | `docs/model-optimization/`（B の調査・評価文書、R2 の外部送信ゲート、PR #115 の移行手順、本書） |
| fixture | `cases.rights_safe.json`（本文なし18件、公的機関2件のみ本文あり）、`cases_body_manifest.json`（長さと SHA-256）、`body_licences.json`（空） |
| 旧ファイル | `fixtures/cases.json` は**含まない**。旧互換は、リポジトリ外の私的ファイルを `--legacy-file` で明示した場合のみ、オフライン専用で読める |

main 側のファイルは1つも変更していない（追加のみ）。`tools/` は main に存在しなかったため、競合する既存ファイルは無い。

## 2. 履歴・権利の検証（機械検査の結果）

| 検査 | 結果 |
|---|---|
| ブランチの親 | `origin/main`（`60c82a07`）の1コミットのみ。PR #115 / Phase 5 / G9 のコミットを merge・cherry-pick・rebase していない |
| ステージされた内容 | 旧 `cases.json` を `git add` していない（コピー時に除外）。ツリーに `cases.json` は無い |
| 本文の残存検査（40文字窓、`scripts/body_leak_scan.ts`、旧18本文 vs `tools/` と `docs/`） | **本文の一致 0 件**。見出し（`title`）欄の一致 3 件（後述） |
| 20文字窓での参考値 | 見出しの重複が 11 件（TDnet の開示タイトルは本文の1行目と同一）。そのほか、`export_cases.sql` の選択条件に書いた英文の見出し文字列（2件、1行・84文字）と、決算短信の定型句（22文字、テスト2ファイル）。長い散文の一致はない |
| 他の fixture | `eval_expansion.json`（本文27件）と `eval_nopost_sample.json`（同9件）が持つ本文は、すべて許可リスト（政府・中央銀行・国連）のホストのもの。テストで全 JSON を走査して固定した |
| `legacy` | 同梱なし。`--fixtures legacy` は `--legacy-file` が無ければ `LEGACY_FILE_REQUIRED`。live と `probe_cli` では常に拒否 |

### 見出し（title）の扱い（判断を要する残件）

- 評価データの方針（`body_policy.ts`、Phase 3 から）は「見出し・URL・メタデータ・本文の長さと SHA-256 は保持し、本文は許可リストのホストのみ保持」である。本ブランチもこれを踏襲した。
- 旧18本文との重複が40文字以上の見出しは3件（`4887f2b0` 57文字、`91569af5` 54文字、`44df218f` 40文字。いずれも TDnet の開示タイトルで、本文の1行目と同一）。
- 見出しは本番がそのまま公開している表題でもあるため、本文とは別扱いとした。ただし「引用」と判断される余地があるため、K9 / 所有者が不可とする場合は、18件の見出しも本文と同じ仕組み（マニフェストにハッシュのみ、実行時に付与）に移せる。**このブランチでは行っていない**。

## 3. テストの置き換え（スキップで通したものは無い）

旧 `cases.json` の本文に依存していたテストは、**合成本文**（実物と同じ長さ・同じホストで、内容は完全に自作）で同じ経路を通すよう置き換えた。

| 旧テスト | 新しい扱い |
|---|---|
| マニフェストと監査の一致 | コミット済みのマニフェスト・監査 JSON・rights-safe ファイルの3者一致（件数22、18件は本文なし、公的機関2件は SHA-256 一致）＋合成本文での監査ロジック検証 |
| rights-safe ファイルが旧ファイルから再生成した結果と一致（ドリフト） | 合成本文から**ビルダー**を通した結果が、コミット済みの rights-safe ケースと一致（ビルダーの動作検証）。元ファイルが無いため、ファイルの再生成比較は「ビルダーが同じ入力形式から同じ出力を作る」検証に置き換えた |
| 本文が残らないこと（24文字窓） | 合成18本文を使い、スキャナが検出できること（陽性対照）と、コミット済みファイルに一致が無いことを確認。**実本文での確認**は、私的ファイルがあるときのみ走る別テスト（既定では ignored）と `scripts/body_leak_scan.ts` |
| 「本文以外は変わらない」 | 元ファイルが無いため同語反復になる。ビルダーのテストが同じ性質を保証するので削除 |
| 外部送信ゲート（18件・live・runtime bodies） | 合成本文と合成マニフェストのディレクトリ（`--fixtures-dir`）で、実コードの経路（ローダー・ゲート・`guardProvider`・CLI・`probe_cli`）をそのまま通す |
| 評価に使ったコードの版（PR #115 の基点と一致） | 現在の main は PR #116 の変更を含むため「基点または head のどちらか一方に一致」に変更（第3の未記録の版なら失敗する） |

テスト総数: 旧 299 → 新 303（うち実本文を要する1件は、私的ファイルが無い環境では ignored）。削除 8、追加 12。

## 4. 外部送信ゲートは変わらない

- `rights_unconfirmed` は、ハッシュ一致・`--runtime-bodies`・有料実行の opt-in では送れない。許諾台帳（空）に明示記録（根拠・確認者・日付・本文ハッシュ・送信先・送信内容）が無い限り、`cli --mode live` も `probe_cli`（`count_tokens` を含む）も、ゲートを通ったケースしか扱わず、APIキー探索はその後。
- 台帳に実際の許諾は追加していない。TDnet / BBC / Al Jazeera / AP は全経路で止まる。

## 5. 残る課題（隠さずに記録）

1. **旧ブランチと Git 履歴**: `8f430557`（PR #115 の head）を含む `claude/b-claude-api-compare-20261009`（PR #115）、`claude/b-news-eval-prep-20261010`、`claude/g9-fixture-rights-cost-eval-20261011` には旧本文が残る。GitHub の `refs/pull/115/head` も同様。本ブランチはこれらを祖先に持たないが、削除・書き換え・PR #115 のクローズは行っていない（所有者の判断）。GitHub 内部のキャッシュやフォークからの完全消去は、このタスクでは達成できない。
2. **見出し**: 上記のとおり判断待ち。
3. **過去の送信**: Phase 2 の L0 で、18件を含む fixture 本文を Anthropic の無料 `count_tokens` へ送っている（開示済み、取り消せない）。
4. **main に既にある同種のファイル（本ブランチの範囲外・未変更）**: リポジトリ全体を40文字窓で走査したところ、本ブランチのファイル以外で旧18本文と一致したのは、すべて main にもともとある次の2ファイルだけだった。
   - `supabase/functions/important-news-monitor/company_identity_fixtures.ts`（旧本文2件分、625窓）
   - `supabase/functions/market-report-analysis/fixtures/close_2026-09-30_news_rows.json`（旧本文1件分、57窓）

   本ブランチが追加したものでも変更したものでもない。所有する別の工程（A/G8 等）が、権利の観点で扱いを判断する必要がある。再現: `deno run --no-config --allow-read tools/provider-compare/scripts/body_leak_scan.ts --legacy-file <私的ファイル> --root supabase --window 40`（私的ファイルが必要）。
5. **許諾**: TDnet 等の利用条件は未確認。確認できたら台帳に追記する（`G9_R2_EXTERNAL_SEND_GATE_AND_LICENCES_2026-10-11.md` 参照）。
6. **有料比較**: ユーザーの別途の予算承認が必要。merge・deploy・本番利用・PR #115 のクローズは未承認。
