# かぶモリ V1 リリース手順（オンデマンド個別分析 + 共通朝刊・大引けの一斉通知）— 別承認待ち・未実行

> この文書の SQL・コマンドは**どれも実行していません**。各段階は、ユーザーの別々の承認のあとに、ユーザー（または承認を受けた担当）が実行します。
> 各機能の細かい手順は次の2つにあります。この文書は、2つをまとめた順番と、iPhone で試すまでの道のりです。
> - `docs/personalized-ondemand/RUNBOOK.md`（PR143）
> - `docs/market-report-broadcast/RUNBOOK.md`（PR149）

## 0. V1 の約束（何が変わるか）

1. **共通の朝刊・大引け:** 1回だけ生成し、アプリの「きょうの市況」で全員が読める。保有銘柄の有無には関係しない。
2. **一斉通知:** 通知を許可した人（`alert_settings` の `push_enabled` と `morning_report` / `close_report` が ON、端末あり）に、朝刊・大引けごとに1回。
   - 重要ニュースの通知とは別の経路で送るので、重要ニュースは遅れない。
3. **個別のAI分析:** 本人がボタンを押したときだけ作る。サーバーのジョブなので、アプリを閉じても続く。本人だけが読め、完成したら通知が1回。
4. **毎日の全員分の自動の個別レポート:** 下の段階7で、オンデマンドを ON にした時点から止まる。
   - **今の本番では止まっていない**（この文書の時点で、旧来の定時の個別レポートの Cron は動いたまま）。

Claude Opus での比較処理（G6 の PR148 → PR150 → PR153）は、既定 OFF の任意の機能で、V1 のリリースの条件ではありません。

## 1. ソースの順番（マージ）

| 順 | PR | 内容 | 状態（この文書の作成時） |
|---|---|---|---|
| 1 | #143 | オンデマンド個別分析（migration `20261011150000`、worker、アプリの画面） | Draft・未マージ。main と衝突なし（手元で確認） |
| 2 | #149 | 一斉通知（migration `20261012100000`、worker、通知のタップ先）。#143 の上に積んでいる | Draft・未マージ。#143 の上で衝突なし |
| 3 | この PR | 両方を合わせた検証と、この手順書 | Draft。#149 の上に積んでいる |

- #143 → #149 → この PR の順に入れる。順番を変えると、#149 の migration は止まる（`MARKET_REPORT_BROADCAST_PREFLIGHT_ONDEMAND_V1_MISSING`）。手元で確認済み。
- G1 の PR #156（ホームの戻り先・保有の件数）とは、ファイルの重なりが無い。どちらを先に入れてもよい。
- G5 の PR #152（共通アカウント）は、プロフィールを作るときの確認を足すもの。V1 はプロフィールを作らないので影響しない。V1 は G5 の未マージのソースに依存しない。

## 2. 段階（それぞれ別の承認）

### 段階1: 手元の確認（済み・どれも本番に触れない）

```bash
OD_PGHOST=/tmp/<sock> OD_PGPORT=<port> OD_PGSUPER=<super> bash supabase/tests/personalized_ondemand_analysis_run.sh
BC_PGHOST=/tmp/<sock> BC_PGPORT=<port> BC_PGSUPER=<super> bash supabase/tests/market_report_broadcast_run.sh
V1_PGHOST=/tmp/<sock> V1_PGPORT=<port> V1_PGSUPER=<super> bash supabase/tests/g2_v1_release_integration_run.sh
```

### 段階2: 本番の読み取りの確認（書き込みなし。読み取りにも承認が要る）

- 2つの migration が未適用であること（`to_regclass` が null）。
- 土台（共通の回・通知・端末・通知設定の表）があること。
- 直近の共通の回が `report_status = completed` で、Fact が passed / advisory か。
- 旧来の個別レポートの Cron の名前と予定、送信の Cron（`send-push-notifications-dispatch`）があること。
- 対象者の数（通知 ON・朝刊 ON・端末あり）と、端末の数の分布（1人で21台以上の人がいるか）。
- 本番の Edge Function の今の版（personalized-reports が、どのソースの版か）。

### 段階3: migration の適用（ゲートはすべて OFF のまま）

1. `20261011150000_personalized_ondemand_analysis_v1.sql`
2. `20261012100000_market_report_broadcast_push_v1.sql`

どちらも、既存の表・関数・権限を変えない（追加だけ）。取り消しの SQL はそれぞれの `supabase/tests/*_rollback.sql` にあり、逆の順（2 → 1）で取り消すと元どおりになる（手元で確認済み）。

### 段階4: Edge Function のデプロイ（ゲートは OFF のまま）

| 関数 | 中身 | 注意 |
|---|---|---|
| `personalized-analysis-worker`（新規） | 個別分析のジョブを処理 | `--no-verify-jwt` |
| `market-report-broadcast-worker`（新規） | 一斉通知を送る | `--no-verify-jwt` |
| `personalized-reports`（既存） | オンデマンドが ON の間は何もしない（`ONDEMAND_MODE`） | 本番にまだ出ていない main の変更も一緒に出る。デプロイの前に、本番の版との差分を確かめる |

- `supabase/config.toml` の無い worktree からのデプロイは、共有のチェックアウトの中身が出ることがある。デプロイの後に、中身をバイト単位で比べる。
- 新しい秘密情報は不要（既存の `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`、`SUPABASE_SECRET_KEYS`、`OPENAI_API_KEY`）。

### 段階5: Cron の登録（2つの worker、毎分。ゲートは OFF のまま）

形は、既存の `send-push-notifications-dispatch` と同じ（各 RUNBOOK に SQL）。ゲートが OFF なので、登録しても何もしない。

### 段階6: アプリのビルドと、少数の端末

- EAS のビルドは区切りのときだけ（別承認）。ビルドに入るもの: 分析の画面、「きょうの市況」、レポート一覧の入口、通知のタップ先。
- サーバーのゲートが OFF の間は、新しい入口は何も見えない（古いアプリでも新しいアプリでも、今までどおり）。

### 段階7: ゲートを ON にする（この順番で、様子を見ながら）

| 順 | 操作 | 結果 |
|---|---|---|
| 7a | `personalized_ondemand_settings.public_market_feed_enabled = true` | アプリに「きょうの市況」が出る |
| 7b | `market_report_broadcast_settings.enabled = true`（`sending_enabled` は false） | 一斉通知の試し実行（作成と分割だけ、送らない）。ただし、7c の前は旧来の個別レポートが動いているので、一斉通知は作られない（下の注） |
| 7c | `personalized_ondemand_settings.ondemand_requests_enabled = true` | 個別分析の受付が始まる。**同時に、旧来の定時の個別レポート（生成と通知）が止まる** |
| 7d | 試し実行の数字（対象者の数・区切りの数）を確認 | — |
| 7e | `market_report_broadcast_settings.pilot_user_ids = array[社内の利用者]`, `sending_enabled = true` | 社内の端末だけに一斉通知 |
| 7f | `pilot_user_ids = null` | 全員へ |
| 7g | （任意）旧来の個別レポートの Cron を外す | 7c の時点で何もしなくなっているので、外さなくても二重にはならない |

**注（二重の通知の防止）:** 一斉通知は、旧来の定時の個別レポートが動いている間（7c の前）は作られない（`allow_with_legacy_personalized_reports = false`）。同じ朝に「個別レポートができました」と「朝刊ができました」の2通が届くことは無い。

### 段階8: 見張りと読み戻し

- 一斉通知: 一斉通知ごとの送信済み・不明・失敗の数、区切りの状態、送り始めから終わりまでの時間。
- 個別分析: 状態ごとのジョブの数、失敗の理由、予約できていない完成の通知。
- 重要ニュース: 同じ時間帯の `notifications` の送信の状態と時刻が、今までどおりか。
- 実機: 通知が届くか、タップで正しい画面（その日・その種類の市況、分析結果）が開くか。

### 段階9: 止め方・戻し方

- すぐ止める（どちらも即時に効く）:
  - 一斉通知: `market_report_broadcast_settings.sending_enabled = false`
  - 個別分析: `personalized_ondemand_settings.ondemand_requests_enabled = false`（旧来の定時の個別レポートは、次の回から元どおり動く）
- migration の取り消しは、ゲートが OFF で処理中のものが無いときだけ（逆の順）。

## 3. 通知の設定・データの扱い（既定は安全側）

- 通知の設定は、既存の `alert_settings` をそのまま使う。新しい設定の画面は無い。
  - 一斉通知: `push_enabled` かつ `morning_report` / `close_report`。設定の行が無い人には送らない。
  - 個別分析の完成: `push_enabled` だけ（本人が押したものなので）。
- アプリの「朝刊の通知」「大引けレポートの通知」の切り替えが、一斉通知の受け取りも決めるようになる（文言を見直すかは、プロダクトとして決める）。
- 1つの朝刊・大引けに1人1回（一斉通知の利用者ごとの記録）。1つの分析に完成の通知1回（部分ユニーク索引）。
- 新しい表はすべて既定で空・ゲートは OFF。既存のデータは書き換えない（追加だけ）。退会すると、本人の分は連鎖して消える。

## 4. iPhone で試すまでの道のり（今の止まりどころ）

| 順 | 必要なこと | 今の状態 |
|---|---|---|
| 1 | PR143・PR149・この PR のレビューとマージの判断 | 未（ユーザー・ChatGPT の判断待ち） |
| 2 | 本番の読み取りの確認（段階2） | 未（読み取りにも承認が要る） |
| 3 | migration の適用（段階3） | 未（承認が要る） |
| 4 | Edge Function のデプロイと Cron（段階4・5） | 未（承認が要る。personalized-reports は一緒に出る変更の確認が先） |
| 5 | アプリのビルド（EAS か、手元の Expo + Simulator） | 未。手元の Simulator でも、本番のサーバーにゲートと関数が無いと、新しい画面は「準備中」のまま |
| 6 | ゲートを ON（段階7、少なくとも 7a と、試すなら 7c・7e） | 未（承認が要る） |

いちばん早く iPhone で触るには、1〜4 のあとで 7a（市況の公開）だけを ON にすれば、「きょうの市況」は見られる。個別分析と一斉通知を試すには、7c（旧来の個別レポートが止まる）と 7e（社内の端末だけ）が要る。

## 5. まだ確かめていないこと

- 本番の Edge Function の実時間の上限と、pg_net の待ち時間を過ぎたあとに処理が続くか（どちらの worker も、止まっても貸し出しの期限切れで続きを処理する）。
- 本番の Expo の応答の速さ（一斉通知の所要時間は模擬の値。10万人で約6〜7.5分）。
- 本番の共通の回が毎日きちんと完成しているか（段階2で読む）。
