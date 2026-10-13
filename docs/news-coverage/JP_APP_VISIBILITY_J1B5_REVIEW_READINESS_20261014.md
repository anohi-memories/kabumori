# J1-b5: Sol（高）独立レビュー前の最終検証パケット

- 作成: 2026-10-14 JST（F8 / ニュース改善A）。対象: Draft PR #191（性能候補）、依存 PR #181（候補）・#185（実スキーマ検証）。本ブランチは PR #191 のHEADに main をmergeしたもので、**PR #181/#185/#191 のHEADは更新していない**。
- **DB・Preview・本番・実データには触れていない。** すべて使い捨てローカルPG17の合成データ。候補SQLは `supabase/migrations/` に置いていない。
- 位置づけ: J1-b4 の性能候補（`tools/jp-news-coverage/j1b4/candidate/p_perf_a.sql`）を、レビューに渡す前に「同値性の穴」「セキュリティ」「性能の再現性」で最終確認したもの。**本番はNO_GO**。

## 1. 結論

| 論点 | 結果 |
|---|---|
| 同値性（旧定義 vs 書換え） | 生成4形状＋**エッジ20件**（72h境界・同時刻tie-break・別カテゴリ・signature null・company/market・優先度・event_key短/第2報）×6ユーザーで、**全フィードが順序込みで一致**。エッジ集合は**規則から導いた期待値**とも一致（両方が同じ誤りをしていない確認）。変異で検出。 |
| セキュリティ | EXECUTE・SECURITY DEFINER・`search_path`固定・RLS・クロスユーザー・search_path乗っ取りの14チェック（`security_checks.sh`）がPASS。署名/ACL/定義は現行と同一、Push生成関数の出力同一（J1-b3/b4で実測）。 |
| 性能 | N=200〜3,200 の時間表（§4）。現行は二次で増加、性能候補は小さい定数。**本番の対象行数が未確認のため、現行が本番で既に遅いかは未判定**。 |
| 到達（a/b/c） | §5。O1〜O4は未決定。 |

## 2. 検証環境と限界（隠さない）

- リポジトリの実migration 116本を使い捨てPG17へ適用して**91本成功・25本失敗**（`tools/jp-news-coverage/j1b3/load_real_schema.sh`）。失敗は social-mobile / x-autopost / common-account / vault 系で、本番に既にある前提テーブルをmigration単独では作れない、またはVaultシークレット未設定のため。ニュース配信チェーンのオブジェクトは**実定義で存在**するが、**本番DBとの同一性は保証されない**（リポジトリ外の変更履歴）。Preview/本番の read-only の定義ハッシュ・ACL比較で初めて確認できる。
- 性能の絶対値はローカルPG（Apple Silicon）のもの。**本番の対象行数・インデックス・負荷では変わる**。倍率と実行計画の形（Nested Loop → Hash Anti Join）を根拠とする。
- 失敗した25本の影響（それらが作るテーブルやポリシーがニュースチェーンへ及ぼす影響）は評価できない。

## 3. 同値性: 追加したエッジケース（`equivalence_edge_seed.sql`、固定id）

| 組 | 内容 | 期待（規則から導出） | 結果 |
|---|---|---|---|
| E01/E02 | 同カテゴリ・同signature・**ちょうど72h差** | 同一事象（`<=72h`）→ 早い方E01のみ | 一致 |
| E03/E04 | 72h+1秒差 | 別事象 → 両方 | 一致 |
| E05/E06 | 同時刻 | idの小さい方E05のみ | 一致 |
| E07/E08 | 同signature・別カテゴリ | 別事象 → 両方 | 一致 |
| E09/E10 | 数値1個（signature null）・同題 | 重複排除しない → 両方 | 一致 |
| E11/E12 | 年のみ（signature null） | 両方 | 一致 |
| E13/E14 | company行と市場行が同題 | company行は追跡者のみ、市場行は別に表示 | 一致 |
| E15/E16 | 一方に検証済み本文 | 優先度が同順位なら早い方E16 | 一致 |
| E17/E18 | 続報/第2報除去後に同key（domestic） | 早い方E17のみ | 一致 |
| E19/E20 | keyが8文字未満 | 統合しない → 両方 | 一致 |

- `equivalence.sh`（生成4形状＋エッジ、6ユーザー）：30フィード（うち空5）で base と wrapper が一致、エッジ期待値（u1/u2/u5/u6）とも一致。72h条件を壊す変異（1hに変更）は FAIL で検出。
- 既知の既存挙動: 上限50件の `LIMIT` に決定的tie-breakがなく、同一タイムスタンプが50件目の境界にあると呼出ごとに選ばれる行が入れ替わり得る（意味的問題ではないが、テストは時刻を一意にして排除している）。

## 4. 性能（合成N行、`authenticated`、`statement_timeout=170s`）

| 追加行数N | 現行 | 候補a（PR #181） | **性能候補（PR #191）** |
|---|---|---|---|
| 200 | 0.86 s | 0.95 s | **0.07 s** |
| 400 | 3.28 s | 3.60 s | **0.12 s** |
| 800 | 12.99 s | 14.26 s | **0.26 s** |
| 1,600 | 51.74 s | 56.21 s | **0.70 s** |
| 3,200 | **timeout（170 s で `statement_timeout` により中断）** | **timeout（同）** | **2.23 s** |

- 実行は `tools/jp-news-coverage/j1b3/timing.sh`（現行/候補a/性能候補を同一データで）。値はJ1-b4の測定（N=1,600で現行74s）と**同じ傾向だが実行ごとに揺れる**（今回の方が速い）。絶対値ではなく倍率と形状で判断する。
- N=3,200 の現行は170秒でも完了しなかった（二次増加からの外挿で数分〜）。**timeout を設定せずに実行すると無限に近い待ち**になるため、本検証は全て `statement_timeout` 付き。

- 実行計画（`plans_excerpt.txt`）: 現行は `Nested Loop Anti Join`（N=800で約14s）、候補は `Hash (Right) Anti Join`（N=3,200で約0.4s）。原因は §J1-b4 のとおり（全ペアで `important_news_same_event` と署名の正規表現を評価）。
- 傾き: 性能候補もNが倍で約1.7〜3倍に増えるため、**行数が万単位になると窓（例: 14日）が必要**になる可能性がある（別承認）。

## 5. 到達の差（a / b / c、合成。O1〜O4は未決定）

| 案 | 国内重大ニュースが届く人 | 軽微談話の誤掲出 | 件数増加 | 副作用 |
|---|---|---|---|---|
| 現行 | emergency=全員／sector一致・all_useful の既存条件 | rejected軽微談話(C7)が見える | — | — |
| **a**（暫定の比較候補） | 追跡sector該当＋all_useful。金融庁処分・事故・サイバー障害が追加 | 現状維持 | u1 6→8、u2 2→4、u5 4→6、u3/u4 不変 | なし |
| b | a＋critical/high(Fact通過)を**全員**（u3/u4も届く） | 現状維持 | u3/u4 1→5 | 表示量・通知疲れ（Pushは不変） |
| c | a＋base内の許容外rejectedを隠す（C7除去） | **除去** | aと同じ（C7のぶん減） | 他レーン（日銀/FRB）のrejected表示も変わる |

**未決定**: O1（jp_official以外のrejected）、O2（aかb）、O3（重複の定義：現状は正規化タイトル一致のみ）、O4（テーマ→sector対応）。

## 6. セキュリティ・チェックリスト（#1〜11 = `security_checks.sh` の14チェック、#12〜14 = J1-b3/b4 のスクリプト）

| # | 項目 | 結果 |
|---|---|---|
| 1 | anonがフィードを実行できない | PASS |
| 2 | service_roleがフィードを実行できない | PASS |
| 3 | authenticatedがbaseを実行できない | PASS |
| 4 | authenticatedがhelper3種を呼べない | PASS |
| 5 | authenticatedが共有signature関数を呼べない | PASS |
| 6 | feed/base/helperの `search_path` が固定 | PASS |
| 7 | `search_path` を shadow スキーマに変えてもフィード不変 | PASS |
| 8 | 他ユーザーの `tracked_stocks`/`alert_settings` を読めない（RLS） | PASS |
| 9 | フィード行が呼出ユーザー自身の追跡銘柄のみ | PASS |
| 10 | 他ユーザーの保有銘柄の企業ニュースが出ない | PASS |
| 11 | `auth.uid()` なしは空 | PASS |
| 12 | 署名・戻り型・definer・ACLが現行と同一（J1-b3 real_checks） | PASS |
| 13 | Push生成関数の出力が現行と同一（7行、J1-b3/b4） | PASS |
| 14 | 変異（helper grant・共有theme_sectors拡大）が検出される | PASS |

限界: search_path乗っ取りテストは、スキーマ修飾の欠落を網羅的に証明するものではない（静的に「全呼び出しがschema修飾済み」であることはレビューでも確認すること）。

## 7. Sol（高）向けレビュー依頼書（案・完成版）

**対象**: `tools/jp-news-coverage/j1b4/candidate/p_perf_a.sql`（`build_perf_candidate.py` で生成。PR #181 の候補を含む）。
**前提**: 本番NO_GO、候補は未適用。O1〜O4は決定していない。レビュー結果で「採用可否の判断材料」とする。

| 観点 | 確認してほしいこと | 参考 |
|---|---|---|
| A 同値性 | `market_unique` の書換えが `important_news_same_event` と数学的に同値（category等価・signature非null等価・72h・`coalesce(published_at, created_at)`）。優先度タプルの不変 | §3、`equivalence.sh` |
| B 権限 | `create or replace` 後のACL/definer/search_pathの保持。helper非公開。共有 `important_news_number_signature` を feed から呼ぶ点 | §6 |
| C 情報漏洩 | `domestic_feed` が company_code 行・他ユーザー情報を返さない。`fact_check_status='passed'` と `source_name='jp_official'` 許容の迂回 | §6 |
| D Push/X副作用 | 共有関数不変更、出力同一 | J1-b3/b4 |
| E 性能・DoS | 同一signatureが大量に並ぶ最悪ケースの比較回数、`statement_timeout` 前提のPreview計測 | §4 |
| F ロールバック | 旧base・旧wrapperの再適用→helper drop | J1-b4 §8 |
| G テーマ正規表現 | 「銀行」等の誤検出（O4） | 候補SQL |

**Preview適用前（read-only）**: 定義ハッシュ・ACL・proconfig・owner、対象行数（件数のみ）、現行フィードの `EXPLAIN (ANALYZE, BUFFERS)`。**適用後**: 変わったのはwrapper/baseだけ、helper4関数が存在しACL=postgresのみ、ユーザー種別ごとの件数前後比較、フィード所要時間、Pushワーカー停止下で `enqueue_*` の出力同一。**rollback条件**: ACL/定義の意図外差分、所要時間悪化、想定外の件数、誤掲出報告。

> レビュー枠の割当はこの文書の対象外（ちゃ／ユーザーが決定）。

## 8. 別スコープの発見: 第三者本文のfixture

`company_identity_fixtures.ts` に、本番で取得したTDnet開示PDF本文がほぼそのまま残っている（8件）。**本ブランチでは変更せず**、専用TASK案を `PROPOSAL_COMPANY_IDENTITY_FIXTURES_SYNTHETIC_20261014.md` に作成した。
