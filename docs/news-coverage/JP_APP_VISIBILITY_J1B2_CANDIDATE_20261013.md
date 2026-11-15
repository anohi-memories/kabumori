# J1-b2: アプリ掲載ポリシーの実装候補（migration候補・未適用）

- 作成: 2026-10-13 JST（F8 / ニュース改善A）。前工程: `JP_APP_VISIBILITY_J1B_OFFLINE_DESIGN_20261013.md`。
- **DB・Preview・本番へは何も適用していない。** `supabase/migrations/` にも置いていない（Previewの自動適用を避けるため `tools/jp-news-coverage/j1b/candidate/` に配置）。採用する場合に初めて昇格する。
- 検証: 使い捨てローカルPG17上で**現行RPC定義＋候補**を実行（合成データ）。`tools/jp-news-coverage/j1b/check_expected.sh` で全variantの表示マトリクスと権限(ACL/security definer)を照合。

## 1. 前工程の結論を実装候補にする際の発見（重要）

1. **`important_news_same_event` と `important_news_market_themes` / `_theme_sectors` はPush生成関数が共有している**（`enqueue_market_critical_notifications`、`enqueue_important_news_notifications`）。前回案(v2/dedupe改善)をこれらへ入れると**Pushの宛先が変わる**。X/Push副作用なしの承認条件に反するため、候補は**フィード専用の新関数**だけを追加し、共有関数・baseフィード・Push関数は一切変更しない（静的検査で保証）。
2. 前回の v3b（baseのrejected非対称をemergency例外で解消）は C7（軽微談話）を消す一方、C3（金融庁の行政処分・rejected）も消す。目的（「Xにはno_postでもアプリでは読める」）には、**rejectedの許容ルールを別に持つ**必要がある。
3. 現行同一事象判定は**タイトル中の数値2個以上**が必須で、数値のない国内ニュース（行政処分・事故）は重複排除されない。続報・第2報の重複は新しいfeed専用ルールで扱う。

## 2. 候補の内容（1ファイル）

`tools/jp-news-coverage/j1b/candidate/20261013_J1B2_news_feed_domestic_visibility_CANDIDATE.sql`

- 新関数（フィード専用、`revoke all` 済み）: `important_news_feed_themes`（既存テーマ ∪ 金融規制/国内災害/サイバー・障害）、`important_news_feed_theme_sectors`、`important_news_feed_event_key`（続報/第N報/更新/訂正/括弧を除去した正規化タイトル）、`important_news_feed_same_event`（同カテゴリ・72h・キー一致・8文字以上）。
- `get_my_important_stock_news(integer)`（Phase 5 wrapper）を `create or replace`：同シグネチャ・同戻り列・権限維持。`base_feed` と `broad_feed` は不変、`domestic_feed` を追加。
- `domestic_feed` の採用条件（O1）: `company_code is null`、重複でない、**`fact_check_status='passed'`**、severity critical/high/medium、かつ（status≠rejected、またはtdnet/company_ir、または **`source_name='jp_official'` で severity が critical/high もしくはカテゴリが administrative_action / misconduct / litigation / major_security_incident**）。噂・Fact不合格・非公式ソースのrejectedは出ない。
- 対象ユーザー（O2）: 追跡sectorがテーマに該当（O4）するユーザー、および all_useful の全員。`tracking_type` は sector一致なら holding/watch、all_useful のみなら market。
- 重複（O3）: feed専用ルール、先に公開された1件を残す。baseフィードに既にある同タイトルは再掲しない。

## 3. 比較結果（実RPC、合成。`expected_matrix.txt`）

| 例 | 内容 | current | v3b | **j1b2_a**（本命） | j1b2_b | j1b2_c |
|---|---|---|---|---|---|---|
| C1/C2 | 為替介入・日銀(published) | u1,u5 | 同 | 同 | 全員 | 同 |
| C3/C8 | 金融庁の銀行への業務改善命令＋続報(rejected, Fact通過) | **なし** | なし | **C8を銀行保有u2・all_useful u1,u5**（1件に集約） | 同 | 同 |
| C4 | 震度6強(emergency, rejected) | 全員 | 全員 | 全員 | 全員 | 全員 |
| C5/C13 | 工場爆発(rejected high)＋第2報 | なし | なし | **all_useful u1,u5**（1件に集約） | 全員 | 同a |
| C7 | 軽微な為替談話(rejected medium) | u1に表示 | 非表示 | u1に表示（現状維持） | 同 | **非表示** |
| C10 | サイバー・決済障害(published high) | u1,u5 | 同 | **u1,u2,u5**（銀行保有にも） | 全員 | 同a |
| C11 | Fact未確認の行政処分 | なし | なし | なし | なし | なし |
| C12 | 非公式ソースの障害情報(rejected high) | なし | なし | なし | なし | なし |
| C6/C9 | 低重要度/判定待ち | なし | なし | なし | なし | なし |
| C15 | TDnet企業ニュース(rejected, 保有銘柄) | u1 | u1 | u1 | u1 | u1 |

- j1b2_a: 追跡なし・sector不一致・非all_usefulのユーザー（u3, u4）は **emergencyのみ**（現状維持＝表示量を増やさない）。
- j1b2_b: a＋「critical/high（Fact通過）を全員へ」。u3/u4にも C1/C2/C5/C10 が届く（O2の最大案）。
- j1b2_c: a＋baseフィードの**rejected・非emergency・許容外**を隠す（C7を消す）。他レーン（日銀/FRBのrejectedで追跡sector一致）も同じ基準で隠れるため、**Fed声明のrejected等の現在の表示を変える**点が要判断。
- 全variantで C4（震度6強）・C15（TDnet）が維持され、C11/C12/C6/C9 は出ない。
- 権限: `get_my_important_stock_news` のsecurity definer・ACL（authenticatedのみ実行）が現行と同一。新helperはanon/authenticated/service_roleとも実行不可。

## 4. 影響しないもの / しているもの
- 不変: Push（`enqueue_*`、`market_critical_news`）、X公開、判定、`coverage_severity` 算出、baseフィード、共有関数、クライアントの上限（ホーム市場3/保有3、一覧50）。
- 変化: アプリ一覧の行（上表）。**日本語app_copyの生成対象 `important_news_app_copy_targets` は今回変えない**ため、新たに見える行は日本語タイトル/本文で表示され、app_copyは付かない（jp_officialは日本語なので表示は成立する）。必要なら別TASKでtargetsを拡張。

## 5. 承認条件への対応

| 承認条件 | 結果 |
|---|---|
| 重大な金融行政処分・災害の見落とし最小 | C3/C8（銀行保有・all_useful）、C5（all_useful）、C4（全員）、C10（銀行保有）。追跡なしの非all_usefulへは a では emergency のみ |
| 軽微な談話・噂を誤掲出しない | 噂/Fact不合格/非公式は不可視。C7は現状維持（aは悪化なし、cで解消） |
| 緊急災害を消さない | C4は全variantで維持 |
| X/Push副作用なし | 共有関数・Push関数は無変更（静的検査）。Push宛先は不変 |

## 6. 適用に向けた手順（承認後のみ）
1. 実スキーマのローカルPGで既存`supabase/tests`方式のproof（本ハーネスは stub スキーマ）。
2. Sol（高）独立レビュー（migration作成時は必須）。
3. 昇格: 候補を `supabase/migrations/<timestamp>_...sql` にコピー（`begin/commit`維持）。Preview/stagingで before/after の「ユーザー種別ごとの一覧件数」匿名集計を比較。
4. 本番: read-only preflight → 1本適用 → 同一catalog定義の読み戻し。**rollback** = 旧wrapper定義(`20260917120000_...`)の `create or replace` を再適用し、`important_news_feed_*` を drop。

## 7. 未決（推測で埋めない）
- **O1**: jp_official以外（日銀/FRB/headline trigger等）のrejectedをどうするか（本候補は jp_official のみ許容）。j1b2_c採用なら要。
- **O2**: aで止めるか、b（全員へcritical/high）まで広げるか。表示量・体験のプロダクト判断。
- **O3**: 「重複」の定義の妥当性（正規化タイトル一致のみ。言い換え記事は統合されない）。
- **O4**: テーマ→sectorの対応（特に domestic_disaster→建設・電気ガス・保険）。
- 未確認: 本番の `coverage_severity` の実分布（jp_officialのrejectedがどの重要度で保存されているか）。J0集計SQL結果が必要。
