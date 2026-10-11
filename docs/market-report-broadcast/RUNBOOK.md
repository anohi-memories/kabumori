# 共通の朝刊・大引けの一斉通知 V1 — 切り替えの Runbook（別承認待ち・未実行）

> この文書の SQL・コマンドは**どれも実行していません**。各段階はユーザーの別々の承認のあとに、ユーザー（または承認を受けた担当）が実行します。
> 本番の DB・Cron・Edge Function・Secrets・アプリの公開・実際の通知の送信は、この PR では一切変えていません。
> **前提:** オンデマンド個別AI分析 V1（PR143）の migration・アプリが先に本番に出ていること。この PR は PR143 の上に積んだ PR です。

## 1. 全体の形

```
共通の回（market_report_cycles + market_report_packets）が完成
        │  （生成は今までどおり。生成の経路・X の投稿の経路には触れない）
        ▼
一斉通知の worker（Edge Function market-report-broadcast-worker、DB の Cron から毎分）
  1. enqueue_market_report_broadcasts  今日の完成した回ごとに1つ（キー = 種類 + 日付）。
     次のどれかなら作らない: ゲート OFF、共通の市況の公開（PR143）が OFF、旧来の定時の個別レポートが動いている、
     パケットが欠けている・食い違う、Fact が passed / advisory でない、見出しが空、完成から時間がたちすぎ
  2. plan_market_report_broadcast      対象者（通知 ON・朝刊／大引けの通知 ON・端末あり）を、利用者 ID の順に
                                       500人ずつの区切りへ。1回の呼び出しで最大40区切り（2万人）。続きは次の呼び出しで
  3. claim → begin → Expo → finish     同時に4区切りまで。区切りは期限付きの貸し出し（token・版・期限）。
                                       begin で対象を確かめ直し（設定・端末・試す人の一覧）、送る人に「送信中」を付ける
  4. purge                             古い記録を少しずつ消す
        │
        ▼
Expo Push API（重要ニュースと同じプロジェクト。送信の速さは一斉通知だけで上限 messages_per_second）
        │
        ▼
アプリ: 通知をタップ → /market-report?type=<morning|close>&date=<YYYY-MM-DD>
        （PR143 の get_app_market_report で、公開してよい項目だけを表示。ゲートもサーバーが守る）
```

- **重要ニュースとは別の経路:** 一斉通知は `notifications` の表も `send-push-notifications` も使いません。重要ニュースの待ち行列が一斉通知で詰まることはありません。
- **共有しているのは Expo の送信の上限だけ:** Expo の上限は1つのプロジェクトで600通/秒です（[Expo の資料](https://docs.expo.dev/push-notifications/sending-notifications/)）。一斉通知は既定で300通/秒までにして、残りを重要ニュースなどに残します。既存の送信の worker は1分に最大200件です。
- **1つの朝刊・大引けに1人1回:** 利用者ごとの記録（`market_report_broadcast_deliveries`、主キー = 一斉通知 + 利用者）。送ったかどうか分からない人（通信が途中で切れた、worker が止まった）には、二度と送りません（「届かないかもしれない」を選び、「二度届く」を避ける）。
- **Expo が受け付けたこと（ticket）は、端末に届いたことの保証ではありません。** 届いたかの確認（receipt）は V1 では行いません。

## 2. この PR に入っているもの（すべて未適用・未デプロイ）

| 種類 | 場所 | 状態 |
|---|---|---|
| DB の migration（候補） | `supabase/migrations/20261012100000_market_report_broadcast_push_v1.sql` | **未適用**。PR143 の migration のあとに適用する。既存の表・関数・権限は変えない |
| 新しい Edge Function | `supabase/functions/market-report-broadcast-worker/` | **未デプロイ** |
| アプリ | 通知の行き先（`market_report`）、共通の市況の画面の引数（種類・日付） | **未公開** |
| 手元の検証 | `supabase/tests/market_report_broadcast_run.sh` ほか | 手元の使い捨ての PostgreSQL だけ |

## 3. ゲートと上限（`public.market_report_broadcast_settings`、1行だけ。既定はすべて OFF）

| 列 | 既定 | 意味 |
|---|---|---|
| `enabled` | false | 一斉通知を作る・分ける |
| `sending_enabled` | false | 実際に送る。`enabled` だけ ON なら、作成と分割だけの**試し実行**（対象者の数・区切りの数が分かる） |
| `pilot_user_ids` | null | 試す人の一覧。null なら対象の全員。指定すると、その人たちだけに送る |
| `allow_with_legacy_personalized_reports` | false | 旧来の定時の個別レポートが動いている間（オンデマンドが OFF）も作るか。false なら作らない（同じ朝・夕に2通届くのを防ぐ） |
| `chunk_size` | 500 | 1つの区切りの人数 |
| `plan_chunks_per_call` | 40 | 1回の分割の呼び出しで作る区切りの数 |
| `max_parallel_chunks` | 4 | 同時に送る区切りの数（Expo の推奨の同時の接続6本以内） |
| `lease_seconds` | 180 | 区切りの貸し出しの期限 |
| `max_chunk_attempts` | 3 | 区切りあたりの試行の回数 |
| `max_report_age_minutes` | 120 | 回の完成からこれより時間がたったら作らない。作った一斉通知も、これより古くなったら残りを送らない |
| `messages_per_second` | 300 | 一斉通知の全体の送信の速さの上限（10〜550） |
| `keep_days` | 14 | 記録を残す日数 |

通知の設定は、既存の `alert_settings` の `push_enabled` と `morning_report` / `close_report` をそのまま使います（アプリのレポートの画面の「朝刊の通知」「大引けレポートの通知」）。設定の行が無い人には送りません。

## 4. 容量の試算（**実測と推定を分けて書く**）

前提（推定）: 1人あたり平均1.2台、Expo への1回のリクエスト（90通）に0.4秒。

| | 1万人 | 10万人 |
|---|---|---|
| 送る通知の数 | 約1.2万 | 約12万 |
| 区切りの数（500人ずつ） | 20 | 200 |
| Expo へのリクエストの数（90通ずつ） | 約140 | 約1,400 |
| 送り終えるまで（300通/秒、模擬） | **約0.7分** | **約7.5分** |
| 送り終えるまで（450通/秒、模擬） | — | **約5.1分** |
| 理論の下限（Expo の上限 600通/秒を全部使う場合） | 約20秒 | 約3.3分 |

- 「模擬」は、worker の処理をそのまま、DB と Expo を手元の模型に置き換え、仮想の時計で動かした値です（`broadcast_logic_test.ts`）。**本番の実測ではありません。**
- **DB 側の実測（手元の PostgreSQL 17、合成の利用者、`market_report_broadcast_scale.sql`）:**
  - 10万人の分割は1回の呼び出しで約0.2〜0.5秒、それを6回。
  - 区切りあたり、送る直前（begin）が約10〜35ミリ秒、送ったあと（finish）が約6〜21ミリ秒。
  - 全体でも数秒で、DB は速さの制約になりません。本番の DB での値は未確認です。
- 通知を作る側との間の遅れ: Cron が毎分なので、回の完成から送り始めまで最大1分程度。
- **目標の「数分」との関係**
  - 1万人は1分以内（模擬）。
  - 10万人は、300通/秒で約7.5分、450通/秒で約5分（模擬）。
  - 速さの上限は Expo の 600通/秒で、重要ニュースの分を残すと 450〜500 が実用の上限。
  - それより速くするには、Expo の上限を上げる相談か、FCM / APNs へ直接送る経路が要ります（V1 の範囲外）。

## 5. 段階（それぞれ別の承認）

### 段階0: 本番の読み取りの確認（書き込みなし）

```sql
select to_regclass('public.market_report_broadcasts');                 -- null のはず（未適用）
select to_regclass('public.personalized_ondemand_settings');           -- PR143 の migration が適用済みであること
-- 対象者の数（朝刊・大引け）と端末の数
select count(*) filter (where s.push_enabled and s.morning_report) as morning_users,
       count(*) filter (where s.push_enabled and s.close_report) as close_users
  from public.alert_settings as s where exists (select 1 from public.device_push_tokens as t where t.user_id = s.user_id);
select count(*) as devices, count(distinct user_id) as users from public.device_push_tokens;
-- 直近の共通の回とパケットの状態（Fact の状態を含む）
select c.report_type, c.trading_date, c.report_status, c.report_completed_at, p.payload #>> '{fact,ai_status}' as fact
  from public.market_report_cycles as c left join public.market_report_packets as p on p.id = c.current_report_packet_id
 order by c.trading_date desc, c.report_type limit 10;
-- 既存の送信の Cron と、直近の重要ニュースの送信の状態（比べるための基準）
select jobname, schedule, active from cron.job where command ilike '%send-push-notifications%';
select push_status, count(*) from public.notifications where created_at > now() - interval '1 day' group by 1;
```

### 段階1: migration の適用（ゲートはすべて OFF のまま）

- `supabase/migrations/20261012100000_market_report_broadcast_push_v1.sql`
- 二重の適用は `MARKET_REPORT_BROADCAST_ALREADY_APPLIED` で止まります。土台・PR143 が無ければ `..._PREFLIGHT_...` で止まり、何も作りません。
- 適用後: `select * from public.market_report_broadcast_settings;`（`enabled` と `sending_enabled` が false）

### 段階2: Edge Function のデプロイと Cron（ゲートは OFF のまま）

- `supabase functions deploy market-report-broadcast-worker --no-verify-jwt`
  - `supabase/config.toml` が無い worktree からのデプロイは、共有のチェックアウトの中身が出ていくことがあります。デプロイ後、中身をこのブランチとバイト単位で比べてください。
- 新しい秘密情報は不要（既存の `SEND_PUSH_NOTIFICATIONS_CRON_SECRET` と `SUPABASE_SECRET_KEYS`）。
- Cron（実行しない・別承認。既存の送信の Cron と同じ形）:

```sql
select cron.schedule(
  'market-report-broadcast-worker',
  '* * * * *',
  $cron$
    with secret as (
      select decrypted_secret from vault.decrypted_secrets
       where name = 'send_push_notifications_cron_secret' and decrypted_secret is not null and decrypted_secret <> ''
       limit 1
    )
    select net.http_post(
      url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-report-broadcast-worker',
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
      body := '{}'::jsonb,
      timeout_milliseconds := 150000
    )
    from secret;
  $cron$
);
```

- ゲートが OFF なので、何も作らず何も送りません（`enqueue` は `disabled` を返す）。

### 段階3: 試し実行（作成と分割だけ。送らない）

```sql
update public.market_report_broadcast_settings set enabled = true, sending_enabled = false, updated_at = now();
```

- 前提: PR143 の `public_market_feed_enabled = true`。オンデマンドが OFF の間は、`allow_with_legacy_personalized_reports` が false なので、一斉通知は作られません（二重の通知を防ぐ）。
  - 試し実行の日だけ true にするかは、別に判断します（送信のゲートが OFF なら送らないので、二重にはならない）。
- 確かめること（読み取りだけ）:

```sql
select report_type, trading_date, status, planned_chunks, planned_users, created_at, plan_completed_at
  from public.market_report_broadcasts order by created_at desc limit 4;
```

- 確かめたら、作った一斉通知は送られないまま古くなり、`max_report_age_minutes` を過ぎると送られずに終わります（送信を ON にしても送らない）。

### 段階4: 少数で試す（社内の人だけ）

```sql
update public.market_report_broadcast_settings
   set pilot_user_ids = array['<社内の利用者のID>'::uuid, '<...>'::uuid], sending_enabled = true, updated_at = now();
```

- 試す人の端末に、朝刊・大引けの通知が1回ずつ届くこと、タップで正しい日付・種類の画面が開くことを、実機で確かめます。
- 同じ時間帯の重要ニュースの通知が遅れていないこと（`notifications` の `push_status` と送信の時刻）を確かめます。

### 段階5: 全員の数での確認（試し実行の数字で、所要時間を見積もる）

- 段階3の `planned_users` × 平均の端末の数 ÷ `messages_per_second` が、送り終えるまでの目安です。
- 1万人を超える場合は、段階6を少しずつ（`messages_per_second` を 300 → 450 など）進めます。

### 段階6: 全員に送る

```sql
update public.market_report_broadcast_settings set pilot_user_ids = null, updated_at = now();
```

### 段階7: 見張り（読み取りだけ）

```sql
-- 一斉通知ごとの状態
select b.report_type, b.trading_date, b.status, b.planned_users, b.created_at, b.completed_at,
       sum(c.sent_users) as sent, sum(c.skipped_users) as skipped, sum(c.failed_users) as failed, sum(c.unknown_users) as unknown
  from public.market_report_broadcasts as b left join public.market_report_broadcast_chunks as c on c.broadcast_id = b.id
 group by b.id order by b.created_at desc limit 6;
-- 区切りの状態と失敗の理由
select status, last_error_code, count(*) from public.market_report_broadcast_chunks
 where created_at > now() - interval '1 day' group by 1, 2 order by 3 desc;
-- 期限を過ぎたまま残っている区切り（次の実行で戻るはず）
select id, attempt_count, lease_expires_at from public.market_report_broadcast_chunks
 where status = 'processing' and lease_expires_at < now();
```

## 6. 止め方（すぐ効く）

```sql
-- 送るのをやめる（作成・分割は続く）。送信中の区切りは、その区切りを送り終えたところで止まる
update public.market_report_broadcast_settings set sending_enabled = false, updated_at = now();
-- 何もしない
update public.market_report_broadcast_settings set enabled = false, sending_enabled = false, updated_at = now();
```

## 7. 戻し方（migration の取り消し。ゲートが OFF で、送信中の区切りが無いときだけ）

`supabase/tests/market_report_broadcast_rollback.sql`（実行しない・別承認）。手元の検証で、取り消したあとの定義が適用前と完全に一致することを確かめています。

## 8. 既知の制約・V1 でしないこと

- 届いたかの確認（Expo の receipt）はしません。`DeviceNotRegistered` の端末の削除もしません（既存の送信の worker の仕事のまま）。
- 「送ったかどうか分からない」人には送り直しません（二度届くより、届かないかもしれないほうを選ぶ）。
- 通知を送る時刻の指定（例 朝8時までは送らない）はありません。回が完成したら送ります。
- 端末の通知の許可（OS の設定）は分かりません。アプリの設定と端末の登録だけを見ます。
- Edge Function の実時間の上限は未確認です。1回の実行は100秒の予算です。途中で止まっても、貸し出しの期限切れのあとに次の実行が続きを送ります（送信中だった人は「不明」で、送り直しません）。
