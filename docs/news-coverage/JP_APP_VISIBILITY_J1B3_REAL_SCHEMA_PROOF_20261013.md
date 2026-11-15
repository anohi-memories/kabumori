# J1-b3: 実スキーマ検証とSol（高）レビュー資料

- 作成: 2026-10-13 JST（F8 / ニュース改善A）。対象: Draft PR #181 の候補 `tools/jp-news-coverage/j1b/candidate/20261013_J1B2_news_feed_domestic_visibility_CANDIDATE.sql`（本書の作業ブランチには PR #181 の2コミットを cherry-pick して取り込んだだけで、候補SQLは未変更）。
- **本番・Preview・staging・実データには一切触れていない。** すべて使い捨てローカルPostgres 17上の合成データ。候補は `supabase/migrations/` に昇格していない。
- 結論: 候補a/b/cは**実スキーマでも前回のマトリクスと完全一致**。権限・SECURITY DEFINER・search_path・戻り型は現行と同一、Push生成関数の出力は現行と完全に同じ。**機能上のSQL不具合は見つからなかった。** ただし**既存フィードが本番想定の件数で二次的に遅くなる性能リスク**（候補はそれを約1割増やす）を発見した。→ §5。

## 1. 検証環境（実スキーマの再構成）

- `tools/jp-news-coverage/j1b3/supabase_stub.sql`: Supabase互換の最小土台（ロール anon/authenticated/service_role、`auth.users`/`auth.uid()`、storage/cron/net/vault のスタブ）。
- `load_real_schema.sh`: **リポジトリの実 `supabase/migrations/*.sql` 116本を日付順に1本ずつ1トランザクションで適用**。結果: **91本適用、25本失敗**。
  - 失敗25本は social-mobile / x-autopost / common-account / vault 系で、本番に既に存在する前提テーブル（`brands`、`social_accounts`、`posting_windows` 等）を、リポジトリのmigration単独では最初から作れないために失敗する（`PHASE4_PREFLIGHT_MISSING_TABLE`、`relation "public.social_accounts" does not exist` 等）。`20260923110440_important_news_monitor_caller_auth` はVaultのcronシークレット未設定で失敗（環境依存、RPCとは無関係）。
  - **ニュース配信チェーンのオブジェクトはすべて存在することを確認**: `important_news_candidates`（本物の列・CHECK・RLS有効・updated_atトリガ）、`stocks_master`/`tracked_stocks`/`alert_settings`/`notifications`/`profiles`（RLS有効）、`get_my_important_stock_news`＋`_phase5_base`、`important_news_same_event`/`_market_themes`/`_theme_sectors`/`_app_severity`、`enqueue_important_news_notifications`(＋phase5_base)、`enqueue_market_critical_notifications`、`important_news_app_copy_targets`。
  - 限界: 本番はリポジトリ外の変更履歴（本番にのみあるmigration等）を持つため、**ニュースチェーンに限った忠実度**であり、DB全体の複製ではない。
- 呼び出しは本番と同じく **`set role authenticated` + `request.jwt.claim.sub`** で行う（security definer経由）。

## 2. 検証結果（`real_matrix.sh` / `real_checks.sh`）

### 2.1 表示（実RPC・実スキーマ、合成10数件）
前回(stubスキーマ)の `expected_matrix.txt` と完全一致:

| user | current | a | b | c |
|---|---|---|---|---|
| u1 (all_useful・自動車保有) | C4,C1,C2,C15,C7,C10 | +C8,C5 | a と同じ | C7が消える |
| u2 (標準・銀行保有) | C4,C2 | +C8,C10 | +C1,C5 | a と同じ |
| u3 (標準・追跡なし) | C4 | C4 | +C1,C2,C5,C10 | C4 |
| u4 (標準・食品watch) | C4 | C4 | +C1,C2,C5,C10 | C4 |
| u5 (all_useful・追跡なし) | C4,C1,C2,C10 | +C8,C5 | a と同じ | a と同じ |

- 不可視のまま: C6（low）、C9（判定待ち）、C11（Fact未確認）、C12（非公式ソースのrejected）、C13（C5の第2報＝重複）。
- 維持: C4（震度6強・rejectedでもemergency）、C15（TDnet・保有銘柄 u1 のみ）。
- 他ユーザーの漏洩: 企業ニュース C15（72030）は追跡している u1 以外には出ない（全variantで確認）。市場全体の行は追跡情報を含まない。
- 件数増加（現行→a）: u1 6→8、u2 2→4、u5 4→6、u3/u4 は不変。b は u3/u4 も 1→5。

### 2.2 権限・定義（`real_checks.sh`）
- 全variantで、`get_my_important_stock_news` / `_phase5_base` / `enqueue_*` / `enqueue_market_critical_notifications` / `important_news_same_event` / `_market_themes` / `_theme_sectors` / `_app_copy_targets` の**シグネチャ・戻り型(md5)・SECURITY DEFINER・`search_path=""`・owner・ACLが現行と同一**。
- 追加される4関数（`important_news_feed_themes` / `_theme_sectors` / `_event_key` / `_same_event`）は ACL=`postgres` のみ（anon/authenticated/service_role とも実行不可）。
- `anon` はフィードを実行できない（permission denied）。`authenticated` は候補テーブルを直接読めず、helperも呼べない。
- ラッパーは `create or replace` のため権限は保持され、migration内の `revoke ... ; grant execute ... to authenticated` で再宣言（結果は現行と同一）。

### 2.3 Pushへの副作用（共有関数）
`alert_settings` を全員 push 有効にし、`enqueue_market_critical_notifications(48)` と `enqueue_important_news_notifications(48)` を current / a / b / c で実行→**出力行（user_id・candidate_id）が全variantで同一**（7行）。
- 検査が有効であることの証明（`mutation_proof.sh`）: m1=helperを authenticated に grant → ACLレポートに現れる。m2=共有の `important_news_theme_sectors` を広げる → market_critical の宛先が **1行→3行**に変わる。つまり共有関数を変えれば検出される。

### 2.4 再現
```
# 使い捨てクラスタ（Homebrew PG17、LC_ALL=C、UTF8）を起動した上で
tools/jp-news-coverage/j1b3/load_real_schema.sh j1b3_real -h 127.0.0.1 -p <port> -U postgres
tools/jp-news-coverage/j1b3/real_matrix.sh j1b3_real -h 127.0.0.1 -p <port> -U postgres
tools/jp-news-coverage/j1b3/real_checks.sh j1b3_real -h 127.0.0.1 -p <port> -U postgres   # PASS/FAIL
tools/jp-news-coverage/j1b3/mutation_proof.sh j1b3_real -h 127.0.0.1 -p <port> -U postgres
```

## 3. 変更が及ぶ範囲の評価
| 項目 | 評価 |
|---|---|
| RPC署名・戻り列 | 不変 |
| 権限(GRANT/REVOKE)・RLS | 不変（helperは非公開、RLSは変更なし） |
| Push（`enqueue_*`）/X公開/判定 | 出力同一を実測 |
| 共有関数 | 不変更（候補ファイルに再定義なし、静的検査＋実測） |
| 件数 | u1/u2/u5 が増える（上表）。上限は従来の50のまま |
| 日本語app_copy | 生成対象 `important_news_app_copy_targets` は不変 → 新規可視行はapp_copy無しで日本語本文表示 |

## 4. 未決のプロダクト判断（確定していない）
O1（jp_official以外のrejected）、O2（a止まりかbか）、O3（重複定義）、O4（テーマ→sector）。本書は a を暫定の検証基準とし、b/c の採否を決めない。

## 5. 発見事項: 既存フィードの性能（要Preview計測）

- 合成N行（medium/high/critical/low混在・unique title）でフィードを実行した実測（ローカルPG17、`authenticated`）:

| N（追加行） | 現行 | 候補a |
|---|---|---|
| 200 | 2.04 s | 2.23 s (+9%) |
| 400 | 8.22 s | 9.50 s (+16%) |

- 4倍近い増加（N 2倍で約4倍）＝**既存の `market_unique` が全候補に対する自己結合（O(n²)、各ペアで `important_news_same_event` を評価）で、日付の窓がない**ことによる。候補は同じ構造の `domestic_unique` を1つ追加するため、現行の約1割増し。
- 本番の「対象行数」（`company_code is null`・重複でない・可視status・severity≥medium）はこの調査では**未確認**。対象が数百件規模になれば現行でも数秒〜になり得る。**Preview/本番のread-only集計で対象行数を確認し、`EXPLAIN (ANALYZE, BUFFERS)` で所要時間を取るまで、採用判断の材料にしてはならない。**
- 対処案（別TASK、プロダクト判断）: フィード対象に新しさの窓（例: 14日）を入れる。ただし既存の表示挙動が変わるため、候補とは分けて承認する。

## 6. Sol（高）向け独立レビュー依頼案
対象: 候補SQL（Draft PR #181）と本書のproof一式。レビュー観点:
1. **権限**: wrapper を `create or replace` した後の ACL / SECURITY DEFINER / `search_path` が現行と同一か。新helperが anon/authenticated/service_role から実行不可か。ラッパー内で参照するオブジェクトがすべて schema 修飾されているか（`set search_path = ''`）。
2. **情報漏洩**: `auth.uid()` に基づく絞り込み（追跡sector・all_useful）が他ユーザーの追跡情報を返さないか。`domestic_feed` が company_code を持つ行を含まないか（`company_code is null`）。
3. **Fact/status ゲート**: `fact_check_status='passed'` と rejected 許容（`source_name='jp_official'` かつ severity/カテゴリ）が意図どおりで、`source_name` 偽装で通る経路が無いか（書き込み主体は service_role のみ）。
4. **Push副作用**: 共有関数不変更、出力同一の確認（本書§2.3）。
5. **性能**: §5。
6. **ロールバック**: 旧wrapper定義(`20260917120000_...`)の再適用で戻るか、helperのdrop順。
7. **正規表現/テーマ**: `important_news_feed_themes` のキーワードの誤検出（例:「銀行」を含む無関係記事が金融規制に入る等）。

## 7. Preview適用前のreadbackとrollback条件（案、実行しない）
**適用前（読み取りのみ・匿名集計）**
- 現行wrapper/ base/ 共有関数の `pg_get_functiondef` ハッシュ、ACL、`proconfig`、owner。
- 対象行数: `company_code is null and duplicate_of is null and status in (…visible…) and coalesce(coverage_severity,…) in ('critical','high','medium')` の件数（総数のみ）。
- 現行フィードの所要時間（`EXPLAIN ANALYZE`、代表的なall_usefulユーザー相当）。

**適用後**
- 上記ハッシュ・ACLが、wrapperだけ変わり、他は不変であること。helper4関数が存在し ACL=postgres のみ。
- ユーザー種別（追跡あり/なし・all_useful有無）ごとの一覧件数の前後比較（個人情報なし、件数のみ）。
- Pushワーカーを無効にしたPreviewで `enqueue_*` の出力（宛先）が現行と同一であること。

**rollback条件**: (1) wrapper/共有関数のACL・定義に意図しない差、(2) フィード所要時間が閾値超（例: 現行の1.5倍または数秒超）、(3) 一覧件数が想定を大きく超過、(4) 重複/誤掲出の報告。**手順**: 旧wrapper定義の `create or replace` 再適用 → helper4関数を drop → ハッシュ/ACL再確認。

## 8. 変更ファイル（本ブランチ）
`docs/news-coverage/JP_APP_VISIBILITY_J1B3_REAL_SCHEMA_PROOF_20261013.md`、`tools/jp-news-coverage/j1b3/*`。候補SQL（j1b/candidate）は PR #181 のものを未変更で参照。
