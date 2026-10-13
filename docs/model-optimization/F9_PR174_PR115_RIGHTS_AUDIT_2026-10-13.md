# F9: PR #174 と旧 PR #115 の残存権利リスク監査・統合前点検（2026-10-13 JST）

TASK: `api-optimization-b-f9-pr174-pr115-rights-audit-offline-20261013`（API最適化 B / 返却先 L9）
基準: `origin/main` = `9261afa6`（作業時点）、PR #174 head = `ef9876fba680f621b88c2d235a7c011ca5881e2f`、PR #115 head = `8f4305574d1895a9f3b45c91470792bed7edb774`。

資料とオフライン検証だけを行った。実 Claude / OpenAI API・無料 `count_tokens` を含むネットワーク送信、PR #115 / #174 / 他ブランチの変更・クローズ・merge、main 既存 fixture の変更は一切していない。第三者の本文・見出しは、この文書にもチャットにも転載していない（件数・文字数・ID のみ）。

## 1. 結論

1. **PR #174 は、18件の第三者本文と、その18件の見出しを含まない。外部送信ゲートは deny-by-default のまま動く**（最新 main との合成状態でテスト 304 件 PASS、conflict なし）。
2. ただし **PR #174 には、権利未確認の出典の見出しが評価データに多数残っている**（340 件中 288 件が TDnet / Al Jazeera / BBC / AP の候補。うち 76 件は本番が生成した投稿文も持つ）。これは従来方針（見出し・URL・メタデータは保持、本文は許可リストのホストのみ）に沿うが、権利上は「判断待ち」であり、merge 前に所有者が決める（§4 カテゴリ D）。
3. **旧本文18件は、PR #115 のコミット `8f430557` と、それを含むリモートブランチ3本・ローカルブランチ3本・`refs/pull/115/head` に残る。** main にも、旧本文と40文字以上一致する既存ファイルが2つある（別担当のもの、§6）。いずれも本タスクでは変更していない。
4. 費用の算式は、本番の provider カタログ（基準日 2026-10-10）と一致する。品質は**未測定**（有料呼び出し無し。mock の一致 100% は構造上の値）。

## 2. 確認した状態

| 項目 | 結果 |
|---|---|
| PR #174 | OPEN / Draft、`main` 向け、MERGEABLE、131 files / +35,575 / −0。main に対して 108 コミット遅れ・2 コミット先。`git merge-tree` は競合なし |
| PR #174 の CI | Vercel / Netlify のデプロイプレビューのみ（成功）。**`tools/provider-compare/` の Deno テストを走らせる CI は無い**ので、テストはローカル再実行が必要 |
| PR #115 | OPEN / Draft、head `8f430557`、最終更新 2026-10-09（無変更） |
| open PR との競合 | `tools/provider-compare/` と `docs/model-optimization/` に触れる open PR は #115 と #174 のみ。F8 の `docs/news-coverage` / `tools/jp-news-coverage`、F2/F6 の共通AI・市況、PR116/129/164 のファイルとは重ならない |
| main の変更（#174 の基点以降） | `supabase/functions/_shared/ai_provider/` に `market_report_primary.ts` の追加と `isolation_test.ts` の拡張。`model_catalog.ts` と、ハーネスが読む本番ファイルは無変更 |

## 3. PR #174 の再検証（最新 main との合成状態）

`origin/main` と PR #174 head を合成した作業ツリー（ローカルのみ、push していない）で実行した。

| 項目 | 結果 |
|---|---|
| `deno test --no-config -A tools/provider-compare/` | 304 passed / 0 failed / 1 ignored（旧18本文の実物を要する検査。私的ファイルが無い環境では実行されない。手元で私的ファイルを指定すると PASS） |
| `deno check`（`src` / `scripts`）、`deno lint` | エラーなし |
| main 側 `_shared/ai_provider/isolation_test.ts` と `cost_test.ts` | 15 passed。`supabase/functions/` と `src/` `apps/` だけを走査する検査で、`tools/` は対象外（PR #174 はカタログを読み取りのみで参照） |
| 旧18本文 vs `tools/` `docs/`（40文字窓） | 本文 0 件、見出し 0 件 |
| 第三者本文の保持（全 fixture JSON） | 本文を持つのは許可リスト（政府・中央銀行・国連）のホストだけ（テストで固定） |
| 外部送信 fail-closed | 空の許諾台帳で18件は全経路 blocked（ハッシュ一致・`--runtime-bodies`・有料実行の opt-in では解除されない）。`cli --mode live` と `probe_cli` はキー探索の前に停止。`legacy` は同梱なしで、live と `probe_cli` では拒否 |
| ゲートの内容 | 合成18件（実物と同じ長さ・ホストの自作テキスト）を `--runtime-bodies` で付けた dry-run でも `cleared=4 blocked=18`。付与した見出し（20文字以上）の断片が外部ペイロードに混入しても拒否される。20文字未満の短い見出しは窓検査の対象外だが、そのケース自体が許可されていなければ送信されない（ケース単位のゲートが主、ペイロード検査は二重化） |

## 4. 権利リスクのカテゴリ（転載なし）

| 区分 | 場所 | 件数・規模 | 内容 | 状態 |
|---|---|---|---|---|
| **A. 旧本文（全文）** | PR #115 のコミット `8f430557` の `tools/provider-compare/fixtures/cases.json`（約 90KB） | 18 ケース / 本文 計 16,252 文字（TDnet 11 = 10,831、Al Jazeera 3 = 2,894、BBC 2 = 2,069、AP 2 = 458） | 出版者の記事・開示の本文。許諾未確認 | 残存。旧ブランチ3本（`claude/b-claude-api-compare-20261009`=PR #115、`claude/b-news-eval-prep-20261010`、`claude/g9-fixture-rights-cost-eval-20261011`）と同名のローカルブランチ、`refs/pull/115/head` に含まれる。PR #174（`claude/f9-…`）と R3 ブランチ（`claude/b-provider-compare-rights-safe-20261012`）は含まない |
| **B. 旧本文の見出し** | R3 ブランチ `c476ef8a` の `cases.rights_safe.json` | 18 件（うち3件は本文1行目と同一） | 出典の表題 | R3 ブランチに残る。PR #174 では非保持に置換（長さ・SHA-256 のみ保持） |
| **C. main 既存 fixture** | main の `supabase/functions/` 配下 | 2 ファイル（§6） | 旧本文と40文字以上一致 | 別担当の判断待ち。本タスクでは変更しない |
| **D. 評価データの見出し・投稿文** | PR #174 の `eval_expansion.json`（190）、`eval_nopost_sample.json`（150）、`nopost_report_2026-10-10.json`（11） | 見出し 340 件のうち **288 件が権利未確認の出典**（TDnet 209、Al Jazeera 57、BBC 13、AP 9）。`eval_expansion.json` の 76 件は本番生成の投稿文（`recorded.generation.text`）も持つ | 見出しは出典の表題。投稿文は本番が出典から書いたもの（公開済みのものを含む） | 従来方針により保持（本文は無し）。**所有者の判断待ち**（選択肢: そのまま / 本文と同様に非保持化し export で再付与 / 一部のみ） |
| **E. 公的機関ホストの本文** | PR #174 の fixture 全般 | 38 件（原22件のうち2件＋評価データ 27 + 9） | 政府・中央銀行・国連の公開文書 | 許可リスト（`body_policy.ts`）に基づき保持。ページ単位の個別確認ではなく、リポジトリ方針 |
| **F. 過去の送信** | Anthropic の無料 `count_tokens` | Phase 2 L0 で18件を含む fixture 本文を送信（開示済み） | 取り消せない | 以後の経路はゲートで停止 |
| **G. 未知の他ファイル** | main / 他ブランチ | 不明 | 今回の走査は「既知の旧18本文」との一致のみ。他の第三者テキストの有無は判定できない | 別の棚卸しが必要（担当別申し送り §6） |

## 5. 旧 PR #115 の整理案（所有者の承認が必要な操作を分離）

**この監査では何も実行していない。** 操作を3群に分ける。

| 群 | 操作 | 承認 | 備考 |
|---|---|---|---|
| 1. 承認不要（済） | PR #174 の作成、R3・F9 ブランチの push | 済み | PR #115 には触れていない |
| 2. 所有者の承認が必要 | PR #174 の merge（§7 のチェックリスト後）／PR #115 のクローズ（理由コメント付き）／旧ブランチ3本（リモート・ローカル）の削除 | 要 | 順序: #174 merge → #115 クローズ → 旧ブランチ削除。削除後も `refs/pull/115/head` と GitHub 内部キャッシュには残りうる |
| 3. 所有者の判断＋追加依頼が必要 | 履歴の書き換え（`filter-repo` + force push）／GitHub への削除依頼（参照・キャッシュの除去）／Anthropic への削除依頼（過去の `count_tokens` 送信） | 要（共有ブランチに影響） | 実施する場合は別 TASK。F9 は行わない |

## 6. main 側 2 fixture の担当別申し送り（変更しない）

| ファイル | 一致の内容 | 参照するテスト | 追加の経緯 | 担当（提案） |
|---|---|---|---|---|
| `supabase/functions/important-news-monitor/company_identity_fixtures.ts` | 旧本文 2 件分と長い一致（625 窓。うち1件は約 3,550 文字が一致）。本文の抜粋が実物のまま入っている | `tdnet_stocks_master_test.ts`、`company_identity_scope_test.ts` | `d685b2b8`（2026-10-03）TDnet の会社名同定の修正 | ニュース改善 A（F8）。最小の合成テキストへの置換を検討（同定ロジックの回帰を保つため、会社名・表記パターンだけを残す） |
| `supabase/functions/market-report-analysis/fixtures/close_2026-09-30_news_rows.json` | 見出し欄2件のみ（70 / 65 文字、TDnet の開示タイトル） | `presentation_v2_test.ts`（`loadFixture("close_2026-09-30")`） | `5877045f`（2026-10-01）共有市況レポート v2 | 市況（F2 / 共有レポート）。見出しを合成表題に置換しても本テストの意味が変わらないかの確認が必要 |

どちらも PR #174 とは独立である（PR #174 はこれらに触れず、これらを悪化もさせない）。

## 7. PR #174 の merge 前チェックリスト

1. [ ] §4 カテゴリ D（見出し 288 件・投稿文 76 件）の扱いを所有者が決定する（保持する場合は、その旨を PR 説明に明記）。
2. [ ] 最新 main に追従する（現在 108 コミット遅れ。競合なしだが、merge 直前に `merge-tree` を再確認）。
3. [ ] ローカルで `deno test --no-config -A tools/provider-compare/`、`deno check`、`deno lint` を再実行する（CI は走らせない）。
4. [ ] 差分が `tools/provider-compare/` と `docs/model-optimization/` の新規追加のみで、main 側の既存ファイルを変更していないことを確認する。
5. [ ] 旧18本文の残存検査（`scripts/body_leak_scan.ts`、私的ファイルが必要）が本文 0 件・見出し 0 件であることを、所有者の環境で再現する。
6. [ ] 許諾台帳 `body_licences.json` が空であること、`legacy` が同梱されていないことを確認する。
7. [ ] PR 説明に「PR #115 のクローズ・旧ブランチ削除・履歴消去・merge・実AI比較・deploy は未承認」を明記する（記載済み）。
8. [ ] merge 後の手順（§5 群2）の担当者を決める。

## 8. 権利クリアランスの条件（外部へ送信できる条件）

外部送信は、`fixtures/body_licences.json` に次を満たす記録があるケースだけに許可される（コードの変更は不要。記録の追加は所有者の確認が前提）。

1. **根拠**: 契約番号、利用条件の URL と取得日、書面の返信など、後から確認できる参照（`evidenceRef`）。
2. **範囲**: 外部 AI プロバイダ（Anthropic / OpenAI）への送信、評価目的の保存、見出し（`title`）・本文（`body`）・投稿文（`recorded_text`）を明示。
3. **対象の固定**: 本文の SHA-256 と、送信先 provider、期間（`expiresOn`）。
4. **出典別の要点**: TDnet は JPX と発行体の利用条件、BBC / Al Jazeera / AP は商用・機械処理・第三者への送信を許す契約か（利用規約で機械処理が禁止されていないか）。今回は確認しておらず、新たな許諾は仮定しない。
5. **否認**: 拒否・不可の回答は `state: denied` で記録し、確認記録より優先する。

## 9. 費用・品質（オフライン、2026-10-13 時点）

### 9-1. 基準日

- 本番の provider カタログ: `ai-provider-catalog/2026-10-10.1`（各モデルの `verifiedOn` = 2026-10-10）。ハーネスの価格表との一致を `pricing_catalog_consistency_test.ts` で確認（Claude 5.5 の3種、`gpt-6-luna`、`gpt-6.1-sol`）。
- 検証時点: 2026-10-13（JST）。**モデルと価格は変わり得る。** 実行前に、カタログの `verifiedOn` と公式の料金ページを再確認すること。

### 9-2. 算式の検証

`judgement_primary` の平均（入力 1,792 トークン、出力: Haiku 172 / Sonnet 422 / Opus 972）を手計算し、ハーネスの出力と一致した（Haiku $0.000265、Sonnet $0.007804、Opus $0.026608）。長文ティア（Haiku 10 万トークン超）は本ツールの入力では発生しない。

### 9-3. 見積もり（dry-run、ネットワークなし。実測ではない）

| 構成 | 22 ケース（合成本文、全6課題） | 外部送信が許可される4ケース（全6課題） |
|---|---|---|
| Haiku 5.5（effort low、thinking off） | 約 $0.08 | 約 $0.05 |
| Sonnet 5.5（effort low） | 約 $1.12 | 約 $0.29 |
| Opus 5.5（effort medium） | 約 $3.35 | 約 $0.74 |
| 参考: OpenAI（記録された本番実績の再生） | 約 $0.03（Luna 4 課題）＋ $0.14（Sol 判定） | — |

- 6課題のうち Web 検索（固定4クエリ）は、ケース数に依存しない固定費（Haiku 約 $0.05、Sonnet 約 $0.16、Opus 約 $0.33）。
- 思考トークンの上乗せ（Sonnet +250 / +600、Opus +800 など）は**未検証の仮定**。実測で外れる可能性が高い。

### 9-4. 品質

- **未測定**。mock の一致 100% は「記録した答えをそのまま返す」ことによる構造上の値で、品質ではない。
- 合成本文は、実物と長さ・ホスト・件数が同じだけで、内容は実記事ではない。したがって合成 fixture による比較は、配管・費用・ゲートの確認にのみ使え、品質の根拠にはならない。
- 外部送信が許可される実ケースは4件のみで、統計的な比較にならない。

## 10. 将来の実比較プラン（最小額・明示承認。今回は実施しない）

| 段階 | 内容 | 上限の目安（見積もり） | 前提 |
|---|---|---|---|
| 0 | 権利OKの評価セットを作る: 公的機関ホストの候補 54 件（評価データ 33 + 17、原22件のうち4件。本文を持つのは 38 件）を `CaseFixture` 形式にする（実装は別 TASK、API 送信なし） | $0 | 所有者の承認（作業）。見出し・投稿文の扱いの決定（§4 D） |
| 1 | `probe_cli`（無料 `count_tokens`）で tokenizer 係数だけを較正。権利OKの公的機関本文のみ送る | $0（無料。ただし外部送信なので明示承認が必要） | ユーザーの明示承認、`PROVIDER_COMPARE_ALLOW_PAID` は不要 |
| 2 | Haiku と Sonnet で、判定（primary / detail）のみ。約 54 ケース | 約 $1（Haiku 約 $0.03 + Sonnet 約 $0.9）。上限 `--max-usd 3 --max-calls 400` | ユーザーの明示承認と上限の指定。Claude のクレジット残高の確認 |
| 3 | 結果が良好な場合のみ Opus を判定に限定（約 54 ケース） | 約 $3（`--max-usd 5`） | 段階2の結果を見てからの別承認 |
| 4 | 生成（draft / fact / voice）は、段階2〜3で判定が許容範囲のときだけ。権利OKの投稿元に限る | 1ケースあたり Sonnet 約 $0.03、Opus 約 $0.10（30 ケースで約 $1 / $3） | 別承認 |

- 各段階は、上限（`--max-calls` / `--max-usd`）を指定しないと開始できない（ハーネスの予算ガード）。
- 実測の前に「承認する金額」「送るデータの範囲（件数・ホスト）」を明示すること。結果は見積もりと比較して報告する。

## 11. 実施した検証・未実施

| 実施 | 内容 |
|---|---|
| ○ | PR / ブランチ / main の状態、open PR の競合、`merge-tree`、合成状態でのテスト・型検査・lint、main 側 ai_provider の isolation / cost テスト、旧本文の残存走査（`tools/` `docs/` と、リポジトリ全体は別実行）、見出し・投稿文の棚卸し、dry-run の費用見積もりと算式の手計算 |
| × | 実 API・`count_tokens` の呼び出し、PR #115 / #174 の変更・クローズ・merge、main 既存 fixture の変更、履歴の書き換え、利用条件の確認（TDnet 等）、品質の測定、リポジトリ外（他ブランチ・他クローン）の網羅的な権利走査 |
