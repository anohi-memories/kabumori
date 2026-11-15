# J1-b: アプリ一覧への掲載条件 — 現状分析・最小修正案・オフライン検証

- 作成: 2026-10-13 JST（F8 / ニュース改善A）
- 範囲: 設計とオフライン検証のみ。**`supabase/migrations/*`・RPC・アプリ・important-news-monitor 本体は変更していない。** 追加物は本書と `tools/jp-news-coverage/j1b/`（実RPC定義をローカル使い捨てPostgresで実行する検証ハーネス）。
- 前提: PR #164（診断永続化）は未mergeのため、本書は診断データを使わない。本番DB・ユーザー情報にはアクセスしていない（合成データのみ）。

## 1. 検証方法（推測ではなく実SQL）

`tools/jp-news-coverage/j1b/build_rpc_sql.py` が、リポジトリのmigrationから**現行のRPC定義をそのまま抽出**する（`important_news_app_severity` / `_market_themes` / `_theme_sectors` / `_same_event` / `_number_signature` / `get_my_important_stock_news_phase5_base`(= 20260913 の `get_my_important_stock_news` をrename) / wrapper `get_my_important_stock_news`(20260917)）。最小のstubスキーマ（`stub_schema.sql`）に載せ、合成10件×ユーザー4人で実際にRPCを呼ぶ。`apply_variant.py` は修正案を**テキスト編集**として当て、各編集が1回だけ一致しなければ失敗する（無音のno-op禁止）。`check_expected.sh` が全variantを再実行し `expected_matrix.txt` と一致を確認する。

再現: ローカルのPostgres(17)を一時起動し `tools/jp-news-coverage/j1b/check_expected.sh -h 127.0.0.1 -p <port> -U postgres`（本番接続は不可能な構成）。

## 2. 現行の配信経路（コード確認）と段階の区別

| 段 | 条件 | 備考 |
|---|---|---|
| 取得→候補 | jp_official等がcandidate化（`company_code=null`＝市場全体） | J0参照 |
| 判定 | importance(no_post/important/most_important)、status（no_post→`rejected`） | **Xの閾値** |
| 重要度（アプリ） | `effective_severity = coalesce(coverage_severity, important_news_app_severity(...))` | Xとは別軸。low は不可視 |
| 一覧RPC | `get_my_important_stock_news` = wrapper(`broad_feed`) ∪ `phase5_base`(`company_feed` ∪ `market_feed`) | 上限50。クライアントは別途ホーム市場3/保有3 |
| Push | 別関数（`enqueue_important_news_notifications` 等） | **本案では不変更** |

### 2.1 `market_feed`（base）が表示する条件
`company_code is null` かつ severity ∈ {emergency, critical, high, medium} かつ（emergency **または** ユーザーの追跡銘柄のsectorが、記事の「テーマ」→sectorに一致）。`rejected` の除外条件は**base側にない**。wrapperの `broad_feed` は `all_useful` のユーザーだけで、`rejected` は tdnet/company_ir のみ可視。

### 2.2 テーマは7種だけ
`important_news_market_themes` は `oil_energy / shipping / semiconductors / autos / trade / fx / rates` のみ。国内の**金融行政処分・災害・サイバー/決済障害・工場事故**はどのテーマにも入らず、`cardinality(themes) > 0` を満たさないため、**emergency以外は追跡sectorに関係なくsector一致ルートで表示されない**。表示されるのは `all_useful` ユーザー（broad_feed）か emergency のみ。

## 3. 合成シナリオとオフライン実測（実RPC）

fixture（架空、すべて `company_code=null`、stored `coverage_severity` を指定）:

| id | 内容 | status | importance | severity | theme |
|---|---|---|---|---|---|
| C1 | 財務省 為替介入 | published | important | high | fx |
| C2 | 日銀 政策金利変更 | published | most_important | critical | rates |
| C3 | 金融庁 地方銀行へ業務改善命令 | rejected | no_post | medium | **なし** |
| C4 | 震度6強 地震 | rejected | no_post | emergency | なし（emergencyはテーマ不要） |
| C5 | 大手工場で爆発事故 | rejected | no_post | high | なし |
| C6 | 啓発キャンペーン（負例） | rejected | no_post | low | なし |
| C7 | 財務官の為替談話（軽微） | rejected | no_post | medium | fx |
| C8 | C3の続報（重複ペア） | rejected | no_post | medium | なし |
| C9 | 判定待ち | pending_judgement | — | medium | — |
| C10 | 大規模サイバー攻撃で決済障害 | published | important | high | なし |

ユーザー: u1=all_useful・自動車保有 / u2=standard・銀行保有 / u3=標準・追跡なし / u4=標準・食品ウォッチ。

### 3.1 現行（current）

| user | 見えるもの | 取りこぼし/問題 |
|---|---|---|
| u1 | C4, C1, C2, **C7**, C10 | C3/C5/C8 不可視。**C7（no_postの軽微談話）が見える** |
| u2 | C4, C2 | C3（自分の銀行業の行政処分）・C10（決済障害）・C5 不可視 |
| u3 / u4 | C4 のみ | 国内の重大ニュース（C1/C2/C5/C10）が見えない |

C6（low）・C9（判定待ち）はどのユーザーにも出ない（正しい）。

### 3.2 修正案ごとの結果（`expected_matrix.txt`）

| variant | u1 | u2 | u3 | u4 | 要点 |
|---|---|---|---|---|---|
| v1 domestic_high_for_all | C4,C1,C2,C5,C7,C10 | C4,C1,C2,C5,C10 | C4,C1,C2,C5,C10 | 同左 | critical/high＋Fact通過を全員に。C5解消、C7は残る |
| v2 domestic_themes | C4,C1,C2,C7,C10 | C4,C2,**C3,C8**,C10 | C4 | C4 | 国内テーマ追加。sector一致で銀行保有者にC3/C10。**C3とC8（同一事象）が両方出る** |
| v3 base_excludes_rejected | C1,C2,C10 | C2 | なし | なし | **危険: C4（震度6強）が全員から消える** |
| v3b …except_emergency | C4,C1,C2,C10 | C4,C2 | C4 | C4 | baseの非対称を解消、C7除去。emergencyは保持。C5/C3は隠れる |
| v1+v2 | C4,C1,C2,C5,C7,C10 | C4,C1,C2,C3,C8,C5,C10 | C4,C1,C2,C5,C10 | 同左 | 最大限表示（C7とC3/C8重複が残る） |
| v2+v3b | C4,C1,C2,C10 | C4,C2,C10 | C4 | C4 | 控えめ。銀行保有者にC10。C3は隠れる |
| v1+v2+v3b | C4,C1,C2,C10 | C4,C1,C2,C10 | C4,C1,C2,C10 | 同左 | C4/C1/C2/C10は全員。C5(rejected high)は隠れる |

**結論（検証で確定した事実）**
1. 現行の `base` が `rejected` を除外しない非対称は、**emergency（震度6強など、Xでno_postでも重大）を表示させている「荷重」**でもある。単純にwrapperと揃える（v3）と地震が全員から消える。揃えるなら emergency 例外（v3b）が必須。
2. 国内一般ニュースが追跡sectorのユーザーに届かない主因は**テーマ辞書が7種のみ**であること（v2で解消するが、テーマ→sector対応は粗い）。
3. 追跡銘柄がないユーザー（u3）やsector不一致のユーザー（u4）には、emergency以外の国内重大ニュースは `all_useful` を選ばない限り**一切届かない**。これを変えるのは v1（全員向けの critical/high 開放）であり、**表示量の増加＝プロダクト判断**。
4. 重複: `important_news_same_event` は「（続報）」付きの近接ペア（C3/C8）を同一事象にしなかった。v2/v1+v2 で重複表示が出る。J1-b本実装では dedupe の追加検証が必要。

## 4. 推奨案と必要なmigration差分

### 4.1 推奨（二段階）
- **段階1（低リスク）**: v3b（baseの `rejected` 非対称を emergency 例外つきで揃える）＋ v2（国内テーマ3種）。効果: no_postの軽微談話が消え（C7）、銀行・保険・金融・通信・建設等の追跡者に国内の行政処分/災害/障害が届く。**追跡なし/sector不一致への拡大はしない**。
- **段階2（要プロダクト判断）**: v1（critical/high＋Fact通過を全員へ）。ただし v3b と併用すると rejected high（C5）は隠れる。「Xでno_postだがアプリには出す」をどこまで許すかのポリシー（下記O1）を決めてから。

### 4.2 migration差分（案、**未作成・未適用**）
新規migration 1本（例 `YYYYMMDDHHMMSS_news_feed_domestic_visibility_v2.sql`）で、同一シグネチャの `create or replace` のみ（drop不要、権限・コメント・既存呼び出しは維持。ロールバックは旧定義の再適用）:

1. `public.important_news_market_themes(text, text, jsonb)` に3行追加:
   - `(8,'financial_regulation', t ~* '金融庁|行政処分|業務改善命令|課徴金|金融機関|銀行|証券会社|保険会社|金融システム')`
   - `(9,'domestic_disaster', t ~* '地震|震度|津波|噴火|台風|豪雨|停電|大規模災害')`
   - `(10,'cyber_outage', t ~* 'サイバー|システム障害|決済障害|情報漏えい|情報漏洩|不正アクセス')`
2. `public.important_news_theme_sectors(text[])` に対応: financial_regulation→銀行業/保険業/証券、商品先物取引業/その他金融業、domestic_disaster→建設業/電気・ガス業/保険業、cyber_outage→情報・通信業/銀行業/その他金融業。
3. `public.get_my_important_stock_news_phase5_base(integer)` の `market_candidates` に `and (news.status <> 'rejected' or news.source_type in ('tdnet','company_ir') or news.effective_severity = 'emergency')`（v3b）。
4. （段階2のみ）`market_feed` の最終where に `or (candidate.effective_severity in ('critical','high') and (candidate.status='published' or candidate.fact_check_status='passed'))`（v1）。

正確なテキスト編集は `tools/jp-news-coverage/j1b/apply_variant.py`（v1/v2/v3b）。実migrationは同じ変更を `phase5_base` 全文に反映する。

### 4.3 影響しないもの
Push（`enqueue_important_news_notifications` / `market_critical_news` / プリセット）、X公開、判定、`coverage_severity` の算出、クライアントのホーム上限3/50、日本語app_copy（可視性の条件ではない）。

## 5. 安全レビュー・Previewテスト計画（DB変更TASKの時点）
1. 上記migrationを、本ハーネスのstubではなく**実スキーマのローカルPostgres**（`supabase/tests` の既存runner方式）で `create or replace` し、既存RPC回帰（company_feed・tdnet rejected可視・emergency・all_useful）を実行。
2. Preview/staging DBに適用 → 匿名の集計SQLで、前後の「ユーザー種別ごとの一覧件数」を比較（個人情報なし）。
3. 本番適用は read-only preflight → 1本のmigration → 同一catalog定義の読み戻し（rollback=旧定義の再適用）。
4. 推奨レビュー: DB変更TASKの時点で Sol（高）。RLS/権限は `create or replace` で不変である点を確認。

## 6. 設定・UIだけで安全に改善できる案（実装不要）
- ユーザーの通知プリセットを `all_useful` にすれば、現行でも国内のcritical/high/mediumの published/ready 行は broad_feed で届く（rejectedのmarket_macro/jp_officialは除く）。アプリ側で「すべての有用なニュース」の案内を出すだけで、追跡なしユーザーの到達は改善する。
- ホームの市場セクションは `all_useful` のみ `tracking_type='market'` が入る（現行仕様）。

## 7. 未解決・要判断
- **O1**: Xでno_postの判定でもアプリに出してよい範囲（emergencyのみ / high+Fact通過 / medium以上）。
- **O2**: 追跡なし・sector不一致ユーザーへ critical/high を出す（v1）か、`all_useful` 誘導に留めるか。
- **O3**: same-event dedupe（C3/C8）の改善はJ1-bの範囲か別TASKか。
- **O4**: テーマ→sector対応（特に domestic_disaster→建設・電気ガス・保険）の妥当性レビュー。
- **未確認**: 本番の `coverage_severity` 実分布（`jp_official` のrejectedがどの重要度で保存されているか）。J0の集計SQL結果、またはPR #164反映後の診断で確認する。
