# J1-b4: フィードSQLの性能改善候補と安全レビュー前検証

- 作成: 2026-10-13 JST（F8 / ニュース改善A）。前提: PR #181（J1-b2候補）、PR #185（J1-b3実スキーマ検証）。本ブランチには両PRのコミットをcherry-pickして取り込み、**PR #181/#185のHEADは更新していない**。
- **DB・Preview・本番・実データには触れていない。** すべて使い捨てローカルPG17の合成データ。性能候補は `supabase/migrations/` に置いていない。
- 結論: 既存フィードの性能問題（O(n²)）の原因を実行計画で確定し、**同一出力のまま実測で数十〜数百倍速い**書き換え候補を作成した。出力同一性は差分テスト（4データ形状×6ユーザー）と変異テストで確認。共有Push関数は不変更。採用判断は Preview での対象行数・EXPLAIN 計測と Sol（高）レビュー後。

## 1. 前工程の限界（明示）

- 実スキーマ検証は、リポジトリの実migration 116本のうち **91本のみ適用（25本は失敗）**。失敗は social-mobile / x-autopost / common-account / vault 系で、本番に既にある前提テーブルをmigration単独では作れない、またはVaultシークレット未設定による。**ニュース配信チェーン（候補テーブル・RLS・各RPC・Push生成関数・profiles等）は実定義で存在**するが、本番DBとの同一性は保証されない（本番にはリポジトリ外の変更履歴がある）。本番との同一性は、Preview/本番の read-only の定義ハッシュ・ACL比較（§7）で初めて確認できる。
- 性能の絶対値はローカルPGの値で、**本番の件数・インデックス・ハードウェアでは異なる**。倍率と計画形状（Nested Loop → Hash Anti Join）が根拠。

## 2. 原因（EXPLAIN ANALYZE、ローカル合成PG）

`tools/jp-news-coverage/j1b4/plans_excerpt.txt` に抜粋。

| | 現行（base `market_unique`） | 候補 |
|---|---|---|
| 結合 | **Nested Loop Anti Join**（actual time 〜13.9 s、N=800の例） | **Hash (Right) Anti Join**（〜0.4 s、N=3,200の例） |
| 理由 | `NOT EXISTS (… important_news_same_event(a,b) …)` が**全ペアで関数を呼ぶ**（各ペアで `important_news_number_signature` の正規表現を2回）。関数呼び出しは等価条件にならずハッシュ結合できない | シグネチャとevent時刻を候補CTEで**1行1回**計算し、`category = … and sig = … and |Δt| <= 72h` の**等価結合**にする |

PR #181 の `domestic_unique`（正規化タイトルの正規表現をペアごとに評価）も同じ構造で、候補aは現行の約+10〜16%だった。

## 3. 性能候補（`tools/jp-news-coverage/j1b4/candidate/p_perf_a.sql`、`build_perf_candidate.py` で生成）

1. **base（feed専用）** `get_my_important_stock_news_phase5_base(integer)` を `create or replace`：`market_candidates` に `event_sig = important_news_number_signature(title)` と `event_time` を追加し、`market_unique` の同一事象条件を等価結合へ。**意味は同一**（`important_news_same_event` は「同カテゴリ・シグネチャ非null・同一・72h以内」）。共有関数 `important_news_same_event` 自体は**変更しない**（Push生成関数が使用）。
2. **wrapper**（PR #181 候補a）に同じ書き換えと、`domestic_candidates` の `event_key` 事前計算＋等価結合。
3. PR #181 の helper 4関数はそのまま（revoke済み）。

baseはwrapperからのみ呼ばれる（ACL=postgresのみ）。Push/X側（`enqueue_*`）は不変更。

## 4. 実測（合成N行、`authenticated`、`statement_timeout`付き）

| N（追加行） | 現行 | 候補a（PR181） | **性能候補** |
|---|---|---|---|
| 200 | 0.96 s | 1.10 s | **0.09 s** |
| 400 | 5.16 s | 5.19 s | **0.15 s** |
| 800 | 21.7 s | 19.7 s | **0.33 s** |
| 1,600 | 74.0 s | 83.1 s | **0.93 s** |
| 3,200 | （未測定：数分〜） | — | 2.80 s |

- 現行はNが倍で約4倍（二次）。性能候補はNが倍で約1.7〜3倍と傾きは残る（残りの二次成分は主に`domestic_matches`/優先度比較の結合）が、**定数が小さく**対象行が数千でも数秒以内。
- N=800・1,600 の現行値はハードウェア依存。**本番の対象行数が未確認**のため、「現行が本番で既に遅いか」は判定できない。Previewでの `count(*)` と `EXPLAIN (ANALYZE, BUFFERS)` が必須。

## 5. 出力同一性・回帰（再現可能）

- `tools/jp-news-coverage/j1b4/equivalence.sh`: base（元の定義のコピー vs 書き換え）と wrapper（PR #181 候補a vs 性能候補）を、**4つのデータ形状（シグネチャ種類 3/7/30/400、件数500〜900）×6ユーザー**で、順序つきの行（id・tracking_type・severity）まで比較 → **24フィード（すべて非空）で完全一致（PASS）**。
  - 変異テスト: 書き換えた72h条件を1hに変えると **FAIL** する（検出力あり）。
  - 副次的発見（既存の挙動）: フィードの `LIMIT` は `news_time` のみで決定的なtie-breakを持たない。同一タイムスタンプが50件目の境界にあると、同じ関数でも呼び出しごとに選ばれる行が入れ替わり得る（本差分テストでは時刻を一意にして排除）。意味的な問題ではないが、順序に厳密な期待をテストに入れない。
- `tools/jp-news-coverage/j1b3/real_matrix.sh`: 表示マトリクス（u1〜u5）は現行・候補a・性能候補で、候補a＝性能候補が一致（C4・C15維持、C6/C9/C11/C12/C13不可視、C8・C5・C10が追跡sector/all_usefulに追加）。
- `real_checks.sh`（`CHECK_VARIANTS="a p_perf_a"`）: 署名・戻り型・SECURITY DEFINER・`search_path=""`・owner・ACLが現行と同一、helperはACL=postgresのみ、anon実行不可、authenticatedの直接テーブル読取・helper呼出不可、**Push生成関数の出力が現行と同一（7行）** → PASS。変異テスト（helper grant / 共有theme_sectors拡大）で検出を確認。

## 6. 権限・RLS・security definer の評価

| 項目 | 評価 |
|---|---|
| 関数のEXECUTE | wrapper: authenticatedのみ（現行と同一）。base: postgresのみ（`create or replace`はACLを保持）。helper: postgresのみ |
| `search_path` | 全関数 `set search_path = ''`、本体は schema 修飾済み（実定義比較で一致） |
| SECURITY DEFINER / RLS | wrapper/baseは definer（owner=postgres、RLS bypass）。**行の絞り込みは `auth.uid()` に依存**（追跡sector・all_useful）。市場全体行に個人情報なし。企業行は追跡銘柄のみ |
| 他ユーザー漏洩 | 企業ニュース(C15)は追跡者のみ。別ユーザーの追跡/設定は返却列に含まれない（検証済み） |
| ロールバック | 旧baseと旧wrapperの定義を再適用（`20260913140000`のbase定義、`20260917120000`のwrapper定義）→ helperをdrop。baseは `create or replace` のため外部依存なし |

## 7. Sol（高）向け独立セキュリティレビュー依頼書（案、自動割当しない）

対象: `tools/jp-news-coverage/j1b4/candidate/p_perf_a.sql`（＋PR #181 の `candidate/…CANDIDATE.sql`）。観点:
1. **同値性**: `market_unique` の書き換えが `important_news_same_event` と数学的に同値か（category等価・signature非null等価・72h・NULL扱い（time null→`coalesce(published_at, created_at)`））。優先度タプルの比較は不変か。
2. **権限**: base と wrapper の `create or replace` 後のACL/definer/search_pathの保持。helper の非公開。`important_news_number_signature`（共有）を新たに feed から呼ぶ点（volatility=immutable、ACLでdefiner経由のみ）。
3. **情報漏洩・行可視性**: `domestic_feed` が company_code を持つ行・他ユーザーの追跡を返さないこと。`fact_check_status='passed'` と `jp_official` 許容条件の迂回経路（書込みはservice_roleのみ）。
4. **Push/X副作用**: 共有関数の不変更と出力同一（§5）。
5. **性能と DoS**: 認証済みユーザーが誘発できる計算量（等価結合後の最悪ケース＝同一signatureが大量に並ぶ場合の優先度比較）。`statement_timeout` 前提のPreview計測条件。
6. **ロールバック手順**の妥当性。
7. **テーマ正規表現**の誤検出（「銀行」を含む無関係記事等）— O4。

## 8. Preview適用前後のreadback（案・実行しない）

**適用前（read-only、匿名の集計）**: ①対象関数の `pg_get_functiondef` ハッシュ・ACL・`proconfig`・owner（本番との同一性確認）、②対象行数（`company_code is null and duplicate_of is null and status in (…) and severity in (critical,high,medium)`、件数のみ）、③現行フィードの `EXPLAIN (ANALYZE, BUFFERS)`（代表ユーザー）。
**適用後**: ①変わったのは wrapper と base だけ（共有関数・enqueue系は同一ハッシュ）、helper 4関数が存在しACL=postgresのみ、②ユーザー種別ごとの一覧件数の前後比較、③フィード所要時間の前後比較、④Pushワーカーを無効にした状態で `enqueue_*` の出力が現行と同一。
**rollback条件**: ACL/定義の意図外差分、所要時間が現行を上回る、件数の想定外超過、誤掲出の報告。**手順**: 旧base・旧wrapperの再適用→helperのdrop→ハッシュ/ACL再確認。

## 9. 未決・限界
- O1〜O4（jp_official以外のrejected、a/bの範囲、重複定義、sector写像）は未承認。aを比較用の暫定候補とした。
- 本番の対象行数・実際のフィード所要時間は未計測（Preview計測が必要）。
- 25本の未適用migrationの影響（本番にある他テーブルへの依存）はこのproofでは評価できない。
- `important_news_app_copy_targets`（app_copy生成対象）は不変更。新しく可視になる行にはapp_copyが付かない。
- フィードに日付の窓を入れる案は本候補に含めていない（挙動が変わるため別承認）。性能候補は窓なしでも実用的な水準だが、行数が万単位になれば窓が必要。
