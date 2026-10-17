# かぶモリ 本番休止の実施記録
記録日: 2026-10-17 / Supabase: stock-x-autopost (`wsmznyzcvmuitkglfeuj`)

## 本番で停止・read-back確認した Cron: 計36件
- 重要ニュース: **2,3,4,8** (fetch, judgement, generation, publish-ready)
- news-discovery-observer: **43**
- 朝刊・大引け: **28,29,30,31,32,33,44**
- MIC: **12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,34,35,36,37,39,40,41,42**
上記の各`cron.job.active=false`を本番DBの停止操作後に読み戻して確認。cron.job定義は削除していない。

## 意図的に継続
- **#1** `dispatch-scheduled-posts`: POSTONA/他ブランド共有。変更禁止。
- **#9** `send-push-notifications-dispatch`: 共有Push。変更禁止。
- **#5** `kabumori-stocks-master-sync`: JPX公開銘柄一覧同期、継続をユーザーが決定。
- **#6** `kabumori-stocks-new-listing-sync`: JPX新規上場一覧同期、継続をユーザーが決定。
- #10/#11 旧個別レポートと #38 shadow は休止前から無効。
- Supabase Auth, entitlement, POSTONA X/Threads, 共通AI, ユーザーDBは保護。

## 重要な残存状態と制約
- 2026-10-17 読み取り時点で、かぶモリ `scheduled_posts` のpendingは7件。**既存分は投稿してよい**とユーザーが明示判断。キャンセル禁止。会社員AIラボなど他ブランドも保護。
- `public.notifications` の非sent状態は調査時0件。ただし全Push経路を網羅した証明ではない。
- `important_news_monitor_settings.is_active=true`, `auto_publish=true` を維持。Cronを止めても手動/別起動経路は完全遮断されない。
- ブランド側のX publish権限もliveの可能性がある。Cron停止のみで「X・Push完全封鎖」と主張しない。
- PR #213 (F2)、#225、#232 (F8)等のソース候補を本番反映済みと扱わない。
- 本番停止操作は完了、**PR merge/deployは未実施**。設定以外の実行中処理や残存キューには注意。

## 安全な再開前提
1. 全Cron active・schedule・command fingerprintを本番read-only取得し、2026-10-17記録と比較。
2. 古い市場指標・Scenario・ニュース・予約キューを現行データと混同せず、stale判定/隔離を確認。
3. POSTONAと共有の#1/#9、Auth、AI、SNS OAuth/Secretsの依存を再確認。
4. 必要なTASK・安全ゲート・明示承認後、**個別に**Cron/Edgeを再開。全件一括ONは禁止。
5. 再開後もログ、API請求、DB write、実SNS送信をread-back。

未検証の本番停止経路は「停止済み」と書かない。
