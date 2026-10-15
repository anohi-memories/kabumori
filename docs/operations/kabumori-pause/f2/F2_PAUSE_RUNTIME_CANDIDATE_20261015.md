# F2｜かぶモリ休止：X・予約・通知の停止候補（ソース候補・オフライン）

- 作成: 2026-10-15 JST（F2）
- task_id: `kabumori-f2-pause-delivery-runtime-candidate-20261015`
- 返却先: かぶモリアプリG1のちゃ（運用休止・全体統括）
- 基準: main `ded9daa794bd508ee717fdf971df0ffce9215817`
- 前提: G1 受入済みの設計 `F2_PAUSE_DELIVERY_DESIGN_20261015.md`（PR #210）
- 範囲: ソースの候補と、合成データのオフライン検証だけ
  - merge・deploy・本番の停止・本番の DB / Cron / Secret / API キー・X・Push・実 API・課金は0件
  - **本番の停止の GO ではない**

## 1. 何を変えたか（x-test-post の中の、かぶモリ専用の入口だけ）

| ファイル | 変更 |
|---|---|
| `x-test-post/kabumori_pause_guard.ts`（新規） | かぶモリ専用の2つの判定。中では既存の `publish_guard.ts` の判定をそのまま使う（共通の部品は変えない） |
| `x-test-post/index.ts` | (a) かぶモリの旧来の X 認証に `beforeSend` を足し、X に作成のリクエストを出す直前ごと（401 で更新したあとの再送の前も）に呼ぶ。(b) 予約の経路と手動の朝の挨拶の、かぶモリの認証に `beforeSend` を付ける。(c) 生成だけの入口（dry-run・テスト 7種）の手前に、かぶモリの状態の判定を置く |
| `x-test-post/morning_greeting_publish_logic.ts` | `beforeSend` の引数を足し、画像のアップロードと投稿の直前（更新後の再送の前も）に呼ぶ |
| `x-test-post/kabumori_pause_guard_test.ts`（新規） | 9件 |
| `tools/kabumori-pause/f2/runtime_plan.ts` と `_test.ts`（新規） | planner の可逆停止と、たまった通知の計画（純粋関数）。6件 |

### (1) 送信の直前の再確認（in-flight の対策）

- 今まで: かぶモリの予約は、claim の直後に1回だけブランドを判定していた。そのため、判定のあとの数分の生成の間にブランドを止めても、その投稿は X に出ていた。
- 今回: かぶモリの旧来の認証で X に作成のリクエストを出す**直前ごと**に、ブランドを読み直して判定する。
  - 対象: 文章の投稿、スレッドの各投稿、朝の挨拶の画像のアップロードと投稿
  - 読み直しに失敗したら送らない（fail closed）。
  - POSTONA・会社員AIラボの Vault の経路は、すでに同じ考え方の `beforeCreate` を持つ。今回は触れていない。
- 止めた場合の扱い
  - エラーは `BRAND_PUBLISH_MODE_DISABLED` などのコードになる。
  - 朝刊の再試行の判定では「分類なし」で、再試行しない（morning_report_retry_logic.ts）。
  - 読み直しが通信の失敗だった場合は、再試行されることがある。その場合も、次の claim の直後の判定で止まる。
- 限界: 再確認とリクエストの間（ミリ秒）に止めた場合と、すでに X に出たリクエストは、取り消せない。

### (2) 生成だけの入口（AI の費用）

- 対象: `useful_tip_dry_run`、`kabumori_voice_dry_run`、`morning_report_dry_run`、`close_report_dry_run`、`us_premarket_report_dry_run`、`test_morning_greeting_image`、`test_morning_greeting_payload`
- かぶモリが `disabled` か `is_active=false` なら、AI を呼ぶ前に 423 で断る（`ai_called: 0`）。
- `dry_run` と `live` では今までどおり動く。
  - 休止を2段階に分けられる: `publish_mode=dry_run` なら「X は止め、試し生成は許す」、`disabled` なら「どちらも止める」。
- **見つけた既存の課題**: これらの入口には管理者の認証が無い（手動の朝の挨拶だけが認証を持つ）。誰でも呼べば AI の費用が出うる。今回の判定は休止中のこの穴をふさぐが、休止していない間の認証は、別の課題として G1 に返す。

## 2. 効く範囲・効かない範囲

| 経路 | 今回の候補を入れたあと |
|---|---|
| 予約（共通・旧来の朝刊と大引け、米国プレマーケット、豆知識、交流、tip、予約の挨拶、再試行） | claim の直後に加えて、**送信の直前ごと**に止まる |
| 手動の朝の挨拶 | 開始時に加えて、**アップロードと投稿の直前**に止まる |
| 生成だけの入口 7種 | `disabled` / `is_active=false` なら AI も呼ばない |
| POSTONA・会社員AIラボの brand_post | 変わらない（自分の Vault の経路の再確認のまま） |
| **ニュースの X 公開（important-news-monitor）** | **効かない。F8 の担当**（今回は触れていない） |
| planner による新しい行の作成 | ソースでは変えていない。§3 の設定で止める |
| すでに pending の通知 | ソースでは変えていない。§4 で扱う |

## 3. planner の可逆停止（設定の確認。migration は無し）

- `claim_due_post` は毎回5つの planner を実行し、各 planner は設定の `is_active` だけを見る。

| 設定 | 内容 | かぶモリ専用か |
|---|---|---|
| `morning_report_settings` / `close_report_settings` / `us_premarket_report_settings` / `useful_tip_schedule_settings` | 1行だけ、ブランドの列は無い | かぶモリ専用 |
| `posting_windows`（交流などの毎日の投稿の時間帯） | 本番では `brand_id` を持つ（migrations/20260918120000 の事前確認が列を要求）。他ブランドの行が混ざりうる | **行ごと**に、かぶモリと NULL だけ |

- `planPlannerStop`: 新しい snapshot から、止める行と、戻す値（snapshot の値そのもの）、触らない他ブランドの行を決める。
  - 中止の条件
    - 設定を読めない
    - 1行の表が0行か2行以上
    - 知らないブランドの時間帯の行がある
    - 想定外の表がある
- `planPlannerRestore`: 止めた行だけを、snapshot の値に戻す（休止の前から OFF だったものは OFF のまま）。
  - 手で ON にされた行や、他ブランドの行の変化は、ずれとして報告する。

```sql
-- テンプレート（実行しない）。値・行は操作の直前の snapshot で確定し、承認を受けてから。
-- 読み取り（snapshot）
select 'morning_report_settings' as t, id::text as k, null as brand_id, is_active from public.morning_report_settings
union all select 'close_report_settings', id::text, null, is_active from public.close_report_settings
union all select 'us_premarket_report_settings', id::text, null, is_active from public.us_premarket_report_settings
union all select 'useful_tip_schedule_settings', id::text, null, is_active from public.useful_tip_schedule_settings
union all select 'posting_windows', post_type || ':' || slot_no, brand_id, is_active from public.posting_windows
order by 1, 2;
-- 停止（承認後に、snapshot と一致することを同じトランザクションで確かめてから）
-- update public.morning_report_settings set is_active = false where id and is_active;  …（各1行の表も同様）
-- update public.posting_windows set is_active = false
--  where coalesce(nullif(brand_id, ''), 'kabumori') = 'kabumori' and is_active
--    and (post_type, slot_no) in (<snapshot で承認した組>);
-- 読み戻し: 上の snapshot をもう一度取り、止めた行だけが false、他ブランドの行は不変
```

- 予約の既存の行は、設計の §4 のとおり、消さず・延ばさず、ゲートで記録つきの失敗にする（不可逆）。
  - 行には本文が無いので、失われるのは「その日のその枠」だけ。
  - 再開後は、planner が新しい日付で作る。

## 4. たまった通知（Push）

- Dispatcher #9 は source_type を問わず pending を送る。producer を止めても、待ち行列は残る。
- `planPushHold` の動き
  - **自動では何も変えない**: 既定（`let_send`）は「送らせる」。
  - 送らせたくない場合だけ、操作者の明示の決定（`skip_approved`）で、承認した pending の id だけを `skipped` にし、`push_last_error_code='KABUMORI_PAUSED'` を残す計画を作る（列は migrations/20260912100000:18）。
  - 中止の条件
    - 承認した行がもう pending でない（processing は Expo へ送信中なので、触らず再送もしない）
    - 承認していない pending がある
    - かぶモリの producer 以外の source_type がある
    - 承認した行が無い
- `skipped` は、戻すには別の手順が要る。再開時に古い通知を送り直さないためでもある。

```sql
-- テンプレート（実行しない）
select id, source_type, push_status, created_at from public.notifications
 where push_status in ('pending', 'processing') order by created_at;
-- 承認後（skip_approved を選んだ場合だけ。snapshot の id と一致することを確かめてから）
-- update public.notifications set push_status = 'skipped', push_last_error_code = 'KABUMORI_PAUSED'
--  where id = any(<承認した id>) and push_status = 'pending';
```

## 5. POSTONA・共通部品に影響しない根拠

- 変更は、かぶモリの旧来の認証（`brandContext.brand.id === LEGACY_KABUMORI_BRAND_ID` の分岐の後）と、かぶモリ専用の入口だけ。
  - 静的な検査で、`beforeSend` が Vault の分岐に無いことを確かめた。
- `publish_guard.ts`・`brand_context.ts`・`_shared/x_oauth2_post.ts`・Dispatcher・トークンの更新・共通 AI・Secret・キー・Auth は変えていない。
- 再確認は、かぶモリの行を読むだけ（DB への書き込みは無い）。
  - 余分な読み取りは、かぶモリの送信1回につき1回だけ。

## 6. 再開

- ゲートを閉じたまま、snapshot の値で planner を戻す（`planPlannerRestore`）。
- 古い予約・通知は送り直さない。
  - 予約の failed の行は再び取られない。
  - 通知の `skipped` は送られない。
- かぶモリの refresh token の有効性を確かめてから、`publish_mode=live` に戻す。
- 長期停止の後は、X の 401 → 更新が1回走る。更新に失敗したら、送らずに失敗する。

## 7. テスト（すべてオフライン）

```bash
deno test --no-config --no-check --deny-net --deny-env --deny-write --allow-read supabase/functions/x-test-post/kabumori_pause_guard_test.ts
```

```bash
deno test --no-config --deny-net --deny-env --deny-run --deny-write --allow-read tools/kabumori-pause/f2/
```

```bash
deno test --no-config --no-check --deny-net --allow-read --allow-env --allow-run supabase/functions/x-test-post/ supabase/functions/_shared/brand/
```

- 停止候補: 9件 PASS
  - `--no-check` は、朝の挨拶の部品の既存の型エラー（main の既存のテストにも同じ4件）のため。新しいファイルに型エラーは無い。
- tools: 22件 PASS（前の設計のモデル16件と、今回の計画6件）
- x-test-post とブランドの既存のテストを含む全体: 772件 PASS
  - `--allow-run` は、AI Lab の既存のテストが node を起動するため。
- わざと壊した版（negative control）は10種類で、どれも落ちた。
  - 停止候補: 最初の送信の再確認なし／再送の前の再確認なし／挨拶の投稿の前の再確認なし／判定が何もしない／生成の入口の判定なし／予約の経路に再確認を付けない
  - 計画: 他ブランドの時間帯も止める／再開ですべて ON／決定なしで skipped／processing を見逃す
- `deno lint`: 新しいファイル・変更したファイルとも問題なし（main と同じ0件）。`git diff --check`: 問題なし。
- **限界**
  - index.ts は読み込むとサーバーが起動するため、組み込みの位置はソースの静的な検査で確かめた（runtime の E2E ではない）。
  - 本番の配備版・`claim_due_post` の本体・`posting_windows` の実際の行・通知の件数は未確認。

## 8. 残り（G1 へ）

1. F8 のニュースの遮断と合わせる（ニュースの X はこの候補では止まらない）。
2. 本番の読み取りの snapshot（設計の §7 と、この文書の §3・§4 のテンプレート）。
3. Sol（高）の独立のレビュー（G1 が別 TASK で割り当て）。
4. 生成だけの入口に管理者の認証が無い件（休止の外の課題）。
5. merge・deploy・本番の停止は、別の明示の承認。
