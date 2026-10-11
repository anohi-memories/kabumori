# オンデマンド個別AI分析 V1 — 切り替えの Runbook（別承認待ち・未実行）

> この文書の SQL・コマンドは**どれも実行していません**。各段階はユーザーの別々の承認のあとに、ユーザー（または承認を受けた担当）が実行します。
> 本番の DB・Cron・Edge Function・Secrets・アプリの公開は、この PR では一切変えていません。

## 1. 全体の形

```
利用者がアプリで「分析」を押す
  └─ request_personalized_analysis（本人だけ。auth.uid() で決まる。1人1件・1日の上限・再送は同じジョブ）
        └─ personalized_analysis_jobs に「順番待ち」で保存（ここで画面を閉じてもよい）

DB の Cron（毎分）── POST ──▶ Edge Function personalized-analysis-worker（X-Cron-Secret）
  1. claim_personalized_analysis_jobs: 先着順・同時に動かせる数の上限・期限付きの貸し出し（token と版）
  2. 共通の朝刊・大引けのパケット + 本人の保有・株価・ニュース → 個別レポートと同じ生成と Fact 確認
  3. complete / fail（token・版・期限が一致したときだけ効く。遅れて終わった worker の書き込みは捨てる）
  4. 完成したジョブの通知を1件だけ予約（enqueue_personalized_analysis_notification）

既存の送信の Cron（send-push-notifications、毎分）が、その通知を送る（source_type = personalized_analysis）
アプリ: 通知をタップ → /reports/<job_id>?source=analysis（本人の結果だけが RLS で読める）
```

- 共通の朝刊・大引けは、`get_app_market_report`（ログイン中の利用者だけ、公開してよい項目だけ）でアプリに出す。
- 旧来の定時の個別レポート（personalized-reports）は残す。`ondemand_requests_enabled = true` の間は、その回を丸ごと飛ばす（`ONDEMAND_MODE`）。二重の生成・二重の通知は起きない。

## 2. この PR に入っているもの（すべて未適用・未デプロイ）

| 種類 | 場所 | 状態 |
|---|---|---|
| DB の migration（候補） | `supabase/migrations/20261011150000_personalized_ondemand_analysis_v1.sql` | **未適用**。既存の表・関数・権限は変えない（通知の表に部分ユニーク索引を1つ足すだけ） |
| 新しい Edge Function | `supabase/functions/personalized-analysis-worker/` | **未デプロイ** |
| 定時の個別レポートの変更 | `supabase/functions/personalized-reports/index.ts`（`ONDEMAND_MODE` の判定、入力の部品の移動） | **未デプロイ** |
| アプリ | `src/app/ai-analysis.tsx`、`src/app/market-report.tsx`、レポート一覧の入口、詳細画面、通知の行き先 | **未公開**（ゲートが OFF の間は何も見えない） |
| 手元の検証 | `supabase/tests/personalized_ondemand_analysis_run.sh` ほか | 手元の使い捨ての PostgreSQL だけ |

## 3. ゲート（すべて既定で OFF）

`public.personalized_ondemand_settings`（1行だけ。API のロールからは書けない。所有者の SQL だけで変える）

| 列 | 既定 | 意味 |
|---|---|---|
| `public_market_feed_enabled` | false | アプリに共通の朝刊・大引けを出す（入口のカードも出る） |
| `ondemand_requests_enabled` | false | 分析の依頼を受け付ける・worker が引き取る・定時の個別レポートを止める |
| `daily_request_limit` | 5 | 1人1日あたりの依頼の数（東京時間の日付。失敗した分も数える） |
| `max_parallel_jobs` | 4 | 同時に分析する数の上限（Cron が重なっても超えない） |
| `lease_seconds` | 300 | 貸し出しの期限（240〜3600。worker は残りが 200 秒未満なら AI を呼ばない） |
| `max_attempts` | 2 | 1件あたりの試行の回数 |

二つのゲートは独立している。共通の朝刊・大引けだけを先に出すこともできる。

## 4. 段階（それぞれ別の承認）

### 段階0: 本番の読み取りの確認（書き込みなし）

```sql
-- 候補が未適用であること
select to_regclass('public.personalized_analysis_jobs') as jobs_table;           -- null のはず
-- 土台があること
select to_regclass('public.market_report_cycles'), to_regclass('public.market_report_packets'),
       to_regclass('public.notifications'), to_regclass('public.alert_settings');
-- 通知の表に personalized_analysis の行が無いこと（部分ユニーク索引を作れる）
select count(*) from public.notifications where source_type = 'personalized_analysis';  -- 0 のはず
-- 既存の個別レポートの Cron の名前と予定（段階6で使う）
select jobid, jobname, schedule, active from cron.job where command ilike '%personalized-reports%';
-- 直近の共通の回の状態
select report_type, trading_date, cycle_status, report_status from public.market_report_cycles
 order by trading_date desc, report_type limit 10;
```

### 段階1: migration の適用

- `supabase/migrations/20261011150000_personalized_ondemand_analysis_v1.sql` を適用する。
- 二重の適用は `PERSONALIZED_ONDEMAND_ALREADY_APPLIED` で止まる。土台が無ければ `PERSONALIZED_ONDEMAND_PREFLIGHT_FOUNDATION_MISSING` で止まり、何も作らない。
- 適用後の確認:

```sql
select * from public.personalized_ondemand_settings;   -- 2つのゲートが false
select proname, proacl from pg_proc where proname in (
  'request_personalized_analysis', 'get_personalized_analysis_status', 'get_app_market_report',
  'claim_personalized_analysis_jobs', 'complete_personalized_analysis_job', 'fail_personalized_analysis_job',
  'enqueue_personalized_analysis_notification', 'mark_personalized_analysis_notification_failed');
```

- 戻し方（ゲートが OFF でジョブが0件のときだけ）: 下の「8. 戻し方」。

### 段階2: Edge Function のデプロイ

- 新しい関数: `supabase functions deploy personalized-analysis-worker --no-verify-jwt`
- 定時の個別レポート: `supabase functions deploy personalized-reports`（`ONDEMAND_MODE` の判定を含む版）
- **注意**
  - `supabase/config.toml` が無い worktree からデプロイすると、共有のチェックアウトの中身が出ていくことがある。デプロイ後に、デプロイされた中身をこのブランチのファイルとバイト単位で比べる。
  - personalized-reports のデプロイには、まだ本番に出ていない main の変更（PR110・PR132 など）も一緒に入る。先にその差分を確認する。
- 新しい秘密情報は不要。既存の `SEND_PUSH_NOTIFICATIONS_CRON_SECRET`、`SUPABASE_SECRET_KEYS`、`OPENAI_API_KEY` を使う。
- デプロイしただけでは何も起きない（ゲートが OFF なので、worker は何も引き取らない）。

### 段階3: worker の Cron（毎分）

```sql
-- 実行しない（別承認）。既存の send-push-notifications-dispatch と同じ形。
select cron.schedule(
  'personalized-analysis-worker',
  '* * * * *',
  $cron$
    with secret as (
      select decrypted_secret from vault.decrypted_secrets
       where name = 'send_push_notifications_cron_secret'
         and decrypted_secret is not null and decrypted_secret <> ''
       limit 1
    )
    select net.http_post(
      url := 'https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/personalized-analysis-worker',
      headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', secret.decrypted_secret),
      body := '{"batch": 4}'::jsonb,
      timeout_milliseconds := 150000
    )
    from secret;
  $cron$
);
```

- **未確認の点**
  - Edge Function の実時間の上限。
  - pg_net が待つのをやめたあと（`timeout_milliseconds`）も、関数が最後まで動くか。
- どちらの場合も、途中で止まったジョブは貸し出しの期限切れ（既定 300 秒）のあとに次の実行が引き取り直す。版が進むので、止まった側の遅れた書き込みは捨てられる。
- 1回の実行は最大で「引き取り（4件）→ 並行して分析 → 通知の予約」。1件あたりの AI の呼び出しは、生成1回と Fact 確認1回（それぞれ最大 90 秒）。

### 段階4: アプリの公開

- この PR のアプリの変更を含むビルドを出す。
- ゲートが OFF の間、アプリには何も新しく出ない（`get_personalized_analysis_status` が `enabled=false` を返す。関数が無いときも何も出ない）。
- EAS のビルドは区切りのときだけ（別承認）。

### 段階5: ゲートを ON にする（順番に、様子を見ながら）

```sql
-- 5a. 共通の朝刊・大引けだけを出す
update public.personalized_ondemand_settings set public_market_feed_enabled = true, updated_at = now();
-- 5b. オンデマンドの分析を受け付ける（同時に、定時の個別レポートの生成と通知が止まる）
update public.personalized_ondemand_settings set ondemand_requests_enabled = true, updated_at = now();
```

5b の前に、次を確かめる。
- 段階2・3が済んでいる（worker のデプロイと Cron）
- 段階4のアプリが利用者に届いている（古いアプリには依頼の入口が無い）
- 定時の個別レポートを止めてよい（5b の時点で、定時の朝刊・大引けの個別レポートと、その通知は作られなくなる）

### 段階6: 旧来の個別レポートの Cron の停止（任意・しばらく安定してから）

- 5b の時点で、定時の実行は `ONDEMAND_MODE` で何もしない。Cron 自体は動き続けるが、生成も通知もしない。
- 止める場合:

```sql
-- 名前は段階0の結果で確かめる。実行しない（別承認）。
select cron.unschedule('<personalized-reports の朝の Cron の名前>');
select cron.unschedule('<personalized-reports の大引けの Cron の名前>');
```

## 5. 見張り（読み取りだけ）

```sql
-- 状態ごとの件数（今日）
select status, count(*) from public.personalized_analysis_jobs
 where request_date = (now() at time zone 'Asia/Tokyo')::date group by status;
-- 期限を過ぎたまま残っている貸し出し（次の実行で戻るはず）
select id, attempt_count, lease_expires_at from public.personalized_analysis_jobs
 where status = 'processing' and lease_expires_at < now();
-- 失敗の理由
select error_code, count(*) from public.personalized_analysis_jobs
 where status = 'failed' and requested_at > now() - interval '1 day' group by error_code order by 2 desc;
-- 予約できていない通知
select id, notify_status, notify_attempt_count from public.personalized_analysis_jobs
 where status = 'completed' and notify_status in ('pending', 'failed');
-- 費用（結果の行の見積もり）
select sum(api_cost_usd), count(*) from public.personalized_analysis_results
 where generated_at > now() - interval '1 day';
```

## 6. 止め方（すぐ効く）

```sql
update public.personalized_ondemand_settings set ondemand_requests_enabled = false, updated_at = now();
```

- 新しい依頼は「準備中」になり、worker は何も引き取らない。
- 定時の個別レポートは、次の回から元どおり動く。
- 順番待ちのジョブは残る（ON に戻すと処理される）。破棄する場合は、別承認で `status='failed', error_code='OPERATOR_CANCELLED'` に更新する。

共通の朝刊・大引けを隠す: `public_market_feed_enabled = false`。

## 7. 既知の制約・未実装

- **全員への共通の朝刊・大引けの通知（一斉送信）は未実装（BLOCKER）**。理由は次のとおり。
  - 送信の worker は1分に200件まで。全員分を一度に予約すると、重要ニュースの通知が、その件数ぶん遅れる。
  - 誰に送るか（既存の `morning_report` / `close_report` の設定を使うか、新しい設定か）は、プロダクトとして決める必要がある。
  - 送るきっかけ（共通の分析の完成）は、X と共有している market-report-analysis の経路を触るか、新しい Cron が要る。
- 課金・回数の引き落としは無い（1日の上限だけ）。
- 上位のモデル（Claude など）は使えない。V1 は個別レポートと同じ低費用のモデルだけ（`model_tier = 'standard'`）。
- 大引けの分析の「朝の見立てとの答え合わせ」は、定時の朝刊の個別レポートがある日だけ（オンデマンドの朝の結果は使わない）。

## 8. 戻し方（migration の取り消し。ゲートが OFF で、ジョブが0件のときだけ）

`supabase/tests/personalized_ondemand_analysis_rollback.sql`（手元の検証で、取り消したあとの定義が適用前と完全に一致することを確かめた）。

```sql
-- 実行しない（別承認）。
begin;
drop function public.mark_personalized_analysis_notification_failed(uuid);
drop function public.enqueue_personalized_analysis_notification(uuid);
drop function public.fail_personalized_analysis_job(uuid, uuid, bigint, text, boolean);
drop function public.complete_personalized_analysis_job(uuid, uuid, bigint, jsonb);
drop function public.claim_personalized_analysis_jobs(integer);
drop function public.get_app_market_report(text, date);
drop function public.get_personalized_analysis_status();
drop function public.request_personalized_analysis(text, uuid, text);
drop index public.notifications_personalized_analysis_once;
drop table public.personalized_analysis_results;
drop table public.personalized_analysis_jobs;
drop table public.personalized_ondemand_settings;
commit;
```

- 先に、`source_type = 'personalized_analysis'` の通知の行をどうするかを決める（残しても害はない）。
- personalized-reports は、表が無いと 404 になり、OFF として従来どおり動く。
