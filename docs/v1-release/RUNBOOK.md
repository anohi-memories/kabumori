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
| 3 | #158 | 両方を合わせた検証と、この手順書 | Draft。#149 の上に積んでいる |

- 2026-10-13 の追記（F2）: #143・#149・#158 は 2026-10-12 23:43〜23:44 JST に main へマージ済み。
  - 本番は、migration（`20261011150000`・`20261012100000`）が未適用。
  - `personalized-reports` は 2026-09-25 の版（v46）のまま。
  - 共通朝刊・大引けを X とアプリへ切り替える順番は、下の「6. X とアプリの切り替え」に書いた。

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
- **個別分析を止めて旧来の定時の個別レポートに戻すときは、必ず先に一斉通知の `sending_enabled = false` にする**（2026-10-13 F2 の確認）。
  - 送る直前の確認 `market_report_broadcast_send_allowed` は、オンデマンドの ON/OFF を見ない（migration `20261012100000` の186行目付近）。
  - そのため、`ondemand_requests_enabled` だけを false にすると、次のことが起きうる。
    - その日に作られた一斉通知は、完成から `max_report_age_minutes`（120分）以内なら送られ続ける。
    - 同時に、旧来の 08:35 / 17:15 の個別レポートの通知も出る。
  - 結果として、同じ人に2通届く。
- 同じ理由で、段階7の 7c〜7e（オンデマンドの ON と送信の ON）は、旧来の個別レポートの通知が出たあとで、その回の完成から120分以内には行わない。
  - 目安は、朝刊の回の完成から120分を過ぎたあとで、大引けの回が完成するより前（10:10〜16:15 JST ごろ）。
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

## 6. X とアプリの切り替え（2026-10-13 F2 の事前確認。どの操作も未実行・別承認）

「新方式」は4つの別々のものなので、混ぜない。

| # | 範囲 | 担当 | 切り替えのスイッチ | 本番の状態（2026-10-13 15:52 JST の読み取り） |
|---|---|---|---|---|
| A | 共通朝刊・大引けを作る AI（Opus Primary） | F6 | Edge Secret `KABUMORI_MARKET_REPORT_AI_MODE` | `market-report-analysis` v33 は main と同じ（15:44 に deploy）。Secret は名前があることだけ確認（値は読まない） |
| B | X が共通レポートを投稿する | F2（ゲート）／X 投稿の関数は G3・F3 | `market_report_consumer_settings.x_enabled` | false。`x-test-post` v145（10/08）は main と違う |
| C | アプリの個別レポートが共通レポートを使う | F2 | `market_report_consumer_settings.app_enabled` | false。`personalized-reports` v46（09/25）は main と違う |
| D | アプリの「きょうの市況」・一斉通知・オンデマンド（旧来の定時の個別レポートを止める） | F2 | 段階3〜7 | migration 未適用、worker 未 deploy、Cron なし、アプリ未ビルド |

### 6.1 X（範囲 B）

- 動き（本番の版 v145 と main で同じ）
  - X の朝刊 08:20・大引け 17:00 の予約（`morning_report_settings` / `close_report_settings`）が `get_shared_market_report(p_consumer='x')` を読む。
  - `x_enabled` が true で、その日の共通の回が完成していれば、その `x_post` を投稿する。
    - **旧来の生成（OpenAI の Web 検索）には進まない**。そのため、二重の生成も二重の投稿も起きない。
  - 共通の回が無い、または未完成のときは、**投稿せずに失敗する**（OpenAI へは戻らない。再試行もない）。
  - false のときは、旧来の経路そのまま。
- 時刻
  - 共通の回の完成（朝刊 07:55・再試行 08:05、大引け 16:20・再試行 16:35）は、X の予約（08:20 / 17:00）より前。
- 旧来の X の朝刊・大引けは、最近ほとんど失敗している（2026-10-02〜10-13）。
  - 大引け: `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`
  - 朝刊: `MORNING_REPORT_SEARCH_BUDGET_EXCEEDED` / `FACT_CHECK_FAILED` / 429
- 直近14件の共通の回の `x_post` を、v145 と main の両方の整形・検査に通した（手元のオフライン）。
  - 両方とも問題は0件で、長さは v145 で 174〜501字、main で 233〜560字。
- **v145 と main の違い**
  - main だけにあるもの
    - AI の免責文を1回付ける
    - Fact の状態を正しく記録する
    - 形の検査の緩和
  - main を deploy すると、Kabumori・AI Lab 以外のブランドの X 投稿の経路（Vault のアカウント、複数のゲートつき）も一緒に出る。
    - これは X 投稿の担当（G3・F3）の変更なので、その担当の確認が要る。
  - `v2_dispatcher` は index から読み込まれないので、bundle に入らない。
  - 未適用の migration には依存しない。
- 手順（それぞれ別承認）

| 順 | 操作 | 確かめること（読み戻し） | 戻し方 |
|---|---|---|---|
| X0 | 読み取り: 今日の共通の回が `completed`、`fact` の状態、`x_enabled=false`、X の予約が pending | — | — |
| X1（推奨） | X 投稿の担当（G3・F3）の確認のあとで、`x-test-post` を main から deploy する。deploy の前後で、本番の版と中身をバイト単位で比べる | ゲートが OFF のまま、旧来の投稿が今までどおり動く | 1つ前の版を deploy し直す |
| X2 | 共通の回が完成したあと、X の予約より前（朝 08:06〜08:17、大引け 16:36〜16:57）に `update public.market_report_consumer_settings set x_enabled = true, updated_at = now() where id;` | `morning_report_runs` / `close_report_runs` の `model_used = 'shared_market_report'` と `x_post_id`、`post_execution_logs` の成功 | `x_enabled = false`。次の予約から旧来に戻る |
| X3 | 1回目の投稿を X の画面で目視する（本文・免責文・長さ） | — | — |

- X1 を飛ばして v145 のまま X2 をすると、免責文の無い投稿になる。
  - 旧来の投稿も、免責文を付けない（AI への指示で投資助言を禁じているだけ）。
  - 免責文を付けるかはプロダクトとして決める。
- `app_enabled` と `x_enabled` は1つの行にあるので、`update` は列を明示し、もう一方を変えない。

### 6.2 アプリの個別レポート（範囲 C）

- 動き（v46 と main で同じ）: `app_enabled` が true で共通の回が完成していれば、個別レポートの市場全体の部分を共通の分析に置き換える。
  - 利用者ごとの OpenAI の生成（生成と Fact で2回）は**続く**。つまり上乗せで、止まりはしない。
- **true で共通の回が未完成のときは、その回の全員分を作らない**（再試行なし。`SHARED_MARKET_REPORT_UNAVAILABLE`）。
  - 大引け 17:15・朝刊 08:35 の時点で、共通の回が両方の試行で失敗していたら、その日の個別レポートと通知は出ない。
- main の `personalized-reports` は、未適用の migration `20261011150000` の表 `personalized_ondemand_settings` を読む。表が無いときは OFF として扱う作り。
  - ただし、本番の PostgREST が表の無いときに 404 を返すかは未確認。そのため、段階3（migration）のあとに deploy するのが安全。
- 手順

| 順 | 操作 | 戻し方 |
|---|---|---|
| C1 | `app_enabled = true`（共通の回が完成したあと、08:35 / 17:15 より前） | `app_enabled = false`。次の回から旧来に戻る |

- C1 は、範囲 D を待たずに単独でできる（v46 のままでよい）。

### 6.3 範囲 D（旧来の定時の個別レポートを止め、一斉通知に移る）

- 段階3〜7 のとおり。順番は「migration → deploy（`personalized-reports` は main の版を出し、`ONDEMAND_MODE` を入れる）→ Cron → アプリのビルド → 7a〜7f」。
- **v46 のまま 7c をすると、旧来の通知と一斉通知の両方が届く**。v46 には `ONDEMAND_MODE` の判定が無いため。
- 戻すときは、段階9の注意（先に `sending_enabled = false`）を守る。

### 6.4 止める条件（X とアプリ共通）

1. 共通の回が2日続けて未完成になった（Opus の失敗・予算切れを含む）。→ `x_enabled` / `app_enabled` を false に戻すか、F6 に AI のモードを外してもらう。
2. X に、壊れた本文・二重の投稿・免責文の抜けが出た。→ `x_enabled = false`。
3. 同じ人に、同じ回の通知が2通届いた。→ `sending_enabled = false`。
