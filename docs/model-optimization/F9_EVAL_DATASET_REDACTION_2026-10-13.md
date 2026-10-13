# F9: 評価データの見出し・投稿文の非保持化（2026-10-13 JST）

TASK: `api-optimization-b-f9-rights-safe-eval-fixture-redaction-20261013`（API最適化 B / 返却先 L9）
基点: Draft PR #174 の head `ef9876fba680f621b88c2d235a7c011ca5881e2f`（直接は編集していない。その上に積む小差分）

有料API・無料 `count_tokens`・外部モデルへの送信、DB・Secrets・本番の操作は行っていない。出典の見出し・投稿文は、この文書・Report・PR 説明に転記していない（件数・文字数・ハッシュ・ID のみ）。

## 1. 何を非保持にしたか

| 対象 | ファイル | 件数 | 置換後 |
|---|---|---|---|
| 出典の見出し（本文の許可リスト外のホスト） | `eval_expansion.json` | 157（TDnet 113、Al Jazeera 24、BBC 10、AP 8、その他 2） | `（見出し非保持: 権利未確認）#<id8>` ＋ `titleChars` / `titleSha256` / `titleKeySha256` |
| 同上 | `eval_nopost_sample.json` | 133（TDnet 96、Al Jazeera 33、BBC 3、AP 1） | 同上 |
| 同上（報告書の例示） | `nopost_report_2026-10-10.json` | 11（すべて許可リスト外） | 同じプレースホルダ |
| 本番が生成した投稿文（出典を問わず） | `eval_expansion.json` | 76 | `（投稿文非保持）#<id8>` ＋ `textChars` / `textSha256` |

- 見出し合計は **290 件**（先の見積もり 288 件は、許可リスト外だが「その他」に分類した 2 件〔日経と米労働統計局〕を除いた数）。許可リストの判定は外部送信ゲートと同じ `bodyMayBeStored` を使っている。
- 許可リストのホスト（政府・中央銀行・国連）の見出し（50 件）は保持した。
- 投稿文は、出典が許可リストであっても 76 件すべてを非保持にした（TASK の指示どおり）。許可リストの 9 件を戻したい場合は、`redactEvalExpansion` の条件を変えるだけでよい。
- 本文（`bodySummary`）はもともと許可リストのホストのものだけで、変更していない。

## 2. 比較可能性を保つ仕組み

- **同一性**: 件数、ケース ID と順序、ラベル、期待値、判定の記録、モデル名など、非保持にしたキー以外はバイト単位で同じ（`contentDigest` が非保持前後で一致することを実行時に検査し、値を `eval_redaction_2026-10-13.json` に記録）。
- **重複検出**: 見出しの正規化テキストの SHA-256（`titleKeySha256`）で、従来どおり「同題・同発行体・同日」の重複を検出できる。
- **指標**: ハザード別の網羅数（`hazardCoverage`）は本文から算出するため、非保持前に算出した値を各ケースの `derived.hazards` に保存した。非保持後も集計値は完全に同じ（hedge 29、multiple_amounts 21 ほか）。保存しなかった場合は hedge が 29→12 などに低下していた。
- **原データでの再現**: 手元の読み取り専用 export（`id` / `title` / `generated_text`）があれば、`scripts/redact_eval_fixtures.ts --verify <rows.jsonl>` で見出し・投稿文のハッシュ一致だけを確認できる（何も書き戻さない・本文は表示しない）。

## 3. 外部送信と権利

- 外部送信ゲート（`external_send_gate.ts`）は変更していない。空の許諾台帳、ハッシュ一致や opt-in では解除されない、`legacy` 不同梱、`cli --mode live` / `probe_cli` のキー探索前停止、いずれも従来どおり。
- 付与された見出し（20 文字以上）が別ケースのペイロードに混入した場合の拒否を、負のテストに追加した。
- 負のテスト（合成データ）: 未知のホスト・URL として解釈できないもの・1 文字の見出しも非保持にする／偽のハッシュ・変更された文字列・export に無い行は一致しない／再適用で何も変わらない／元の文字列が出力に残らない。

## 4. 残る課題（隠さずに記録）

1. **Git 履歴**: PR #174 のコミット（および R3 ブランチ・旧ブランチ）には、非保持前の見出し・投稿文が残る。本ブランチ（`claude/f9-eval-redaction-20261013`）は #174 の上に積む小差分であり、履歴は消えない。そのため、**最終ツリーだけを最新 main に載せた単一コミットのブランチ** `claude/f9-provider-compare-rights-safe-clean-20261013` も別に用意した（#174 と本差分の最終ツリーと同一。親は main のみで、非保持前の文字列を含むコミット・blob を持たない）。#174 を置き換える場合はこちらを使う。squash merge でも同じ結果になる。
2. **同じ方針の対象外のテキスト**:
   - 本番の判定理由（`recorded.judgement.reason`）: `eval_expansion.json` 190 件、`eval_nopost_sample.json` 150 件、原 22 件。出典に基づく AI の文章で、見出しとの 12 文字以上の一致が 29 件ある。
   - 原 22 件の保存済み投稿文: 19 件（`cases.rights_safe.json`）。Fact / Voice の課題の入力に使うため、非保持にするには export からの再付与が前提。
   - ラベラーの記述（`keyFacts` / `rationale`）: 見出しの全文一致は 8〜23 文字の定型の開示名称に限られる（例: 決算短信・自己株式の取得状況に関するお知らせ）。出典の文章の転記ではない。
3. **定型の見出し**: 定型の開示名称（短い）は、テストやラベルの中に、文字列としては残っている。
4. **main 側の既存2ファイル**・旧 PR #115・旧ブランチ・`refs/pull/115/head`: 変更していない（前回の監査のとおり、所有者の判断）。
5. **許諾**: TDnet 等の利用条件は未確認。台帳は空。

## 5. 再現手順

```
# 非保持化の適用（冪等）と記録の作成
deno run --no-config --allow-read --allow-write=tools/provider-compare/fixtures,docs/model-optimization \
  tools/provider-compare/scripts/redact_eval_fixtures.ts --record docs/model-optimization/eval_redaction_2026-10-13.json
# 手元の export との一致確認（読み取りのみ）
deno run --no-config --allow-read tools/provider-compare/scripts/redact_eval_fixtures.ts --verify <rows.jsonl>
# テスト
deno test --no-config -A tools/provider-compare/
```

`build_eval_set.ts` / `build_nopost_sample.ts` も、生成時に同じ非保持化をかけるようにした（再生成しても元の文字列が書き込まれない）。
