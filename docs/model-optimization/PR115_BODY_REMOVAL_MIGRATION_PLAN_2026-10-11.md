# PR #115 の第三者本文を取り除くための移行手順（所有者向け、2026-10-11 JST）

作成: G9（API最適化 B）。**この文書は手順の提案であり、G9 は PR #115・そのブランチ・Git 履歴に一切手を付けていない。** 実施するかどうか、誰が行うかは PR #115 の所有者が決める。

## 1. 現状

| 項目 | 内容 |
|---|---|
| 対象ファイル | `tools/provider-compare/fixtures/cases.json`（22件中、本文を持つ20件のうち **18件が許諾未確認**: TDnet 11 / Al Jazeera 3 / BBC 2 / AP 2。ほか2件は金融庁・財務省で公開利用条件の対象） |
| 導入コミット | `8f430557`（PR #115 の head） |
| そのコミットを含むリモートブランチ | `claude/b-claude-api-compare-20261009`（= PR #115）、`claude/b-news-eval-prep-20261010`、`claude/g9-fixture-rights-cost-eval-20261011` |
| PR #115 の状態 | OPEN / Draft、head `8f430557`（確認時点。10/9 以降の更新なし） |
| G9 ブランチで済んでいること | 本文を持たない派生 `cases.rights_safe.json` + マニフェスト `cases_body_manifest.json`、外部送信ゲート、許諾台帳（空）。`cases.json` は**変更していない**（PR #115 のテストが本文を前提とするため） |

## 2. 選択肢

| 案 | 内容 | 履歴の本文 | 手間 | 備考 |
|---|---|---|---|---|
| A. 現状維持（Draft のまま、merge しない） | 外部送信ゲートで送信は止まる。ファイルとリポジトリ内の履歴には残る | 残る | 無し | リポジトリの閲覧権限を持つ人には本文が見える。merge はしないこと |
| B. 新しいブランチで置き換え（推奨） | `main` から新ブランチを切り、PR #115 の**最終ツリー**（本文を除いたもの）を1コミットで入れる。新しい PR を作り、PR #115 は理由を書いて閉じる | 新しい PR / main には残らない（旧ブランチと `refs/pull/115/head` には残る） | 中 | 履歴の書き換え・force push が不要。旧ブランチの削除は別判断 |
| C. 履歴を書き換える（filter-repo 等 + force push） | `cases.json` を全履歴から消す | リモートのブランチからは消える。GitHub 側の `refs/pull/*`・キャッシュ・フォークには残りうる | 大 | 共有ブランチ3本に影響する。所有者の明示的な判断が必須。G9 は行わない |

G9 の推奨は **B**。完全な消去が必要（法務判断）なら、C に加えて GitHub への削除依頼（キャッシュ・`refs/pull/*`）が要る。これは G9 の範囲外。

## 3. 案 B の手順（所有者が実施）

1. **PR #115 の所有と更新を確認する**（共有アカウント作成。他のセッションが更新していないこと: `gh pr view 115 --json headRefOid,updatedAt`）。
2. `main` の最新から新ブランチを切る（例: `claude/b-provider-compare-rights-safe-20261011`）。
3. 次のファイルを入れる:
   - PR #115 の `tools/provider-compare/`（`cases.json` を**除く**）
   - G9 ブランチの `src/fixture_access.ts` `src/fixture_loader.ts` `src/external_send_gate.ts` `fixtures/cases.rights_safe.json` `fixtures/cases_body_manifest.json` `fixtures/body_licences.json` と各テスト
4. `cases.json` を直接読んでいるテストを直す:
   - `loadCases()` の既定を `cases.rights_safe.json` に変える。本文を前提とするテスト（`tasks_test.ts` ほか）は、合成の本文（短いダミーテキスト）か、ローカルのエクスポート（`--runtime-bodies`）で組み立てる。
   - `fixture_rights_audit_test.ts` と「ドリフト」テスト（`cases.json` から派生物を再生成して比較する）は、本文を持つファイルがリポジトリに無くなるため、ローカルにだけあるファイル（`.gitignore` 対象、例: `tools/provider-compare/.local/cases.legacy.json`）を環境変数で指す形にし、無ければスキップする。
   - `legacy` モードは削除するか、ローカルのファイルを指定した場合のみ有効にする。
5. 秘密情報・本文の混入を確認する: `deno test --no-config -A tools/provider-compare/`、`fixture_rights_audit` の再実行、`git grep` でマニフェストの `bodySha256` に対応する本文の断片が無いこと。
6. 新しい PR を Draft で作成する。説明に「第三者本文を含まない。PR #115 の置き換え」と書く。
7. PR #115 を閉じる（コメントに新しい PR へのリンクと理由）。旧ブランチ `claude/b-claude-api-compare-20261009` / `claude/b-news-eval-prep-20261010` は、他の作業が無いことを確認してから所有者が削除するかを決める。

## 4. 実施前に確認すること（所有者）

- 本文を持つ他のファイル: `eval_expansion.json`（27件）と `eval_nopost_sample.json`（9件）は、本文があるのは許可リスト（政府・中央銀行・国連）のホストのみ。これらは置き換え不要。ただし**見出しと本番の保存済み投稿**は全ケースに残る（出典の引用を含みうる）。扱いは `G9_R2_EXTERNAL_SEND_GATE_AND_LICENCES_2026-10-11.md` §4 を参照。
- TDnet の利用条件は未確認。確認できたら許諾台帳に `evidenceRef` 付きで追記する（コードの変更は不要）。確認できるまで、18件の本文はリポジトリに置かない。
- 過去に18件を含む本文を Anthropic の無料 `count_tokens` へ送っている（Phase 2 の L0、開示済み）。取り消せない。必要なら Anthropic への削除依頼の可否を所有者が判断する。

## 5. G9 がしていないこと

- PR #115 / 既存ブランチの更新、履歴の書き換え、force push、ブランチの削除。
- `cases.json` の変更・削除。
- Draft PR の作成（所有の合意が無いため）。
