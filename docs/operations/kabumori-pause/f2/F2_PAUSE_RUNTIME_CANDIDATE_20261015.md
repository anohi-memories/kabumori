# F2｜かぶモリ休止：X・予約・通知の停止候補（ソース候補・オフライン）

- 作成: 2026-10-15 JST（F2）。2026-10-16 に J2 の指摘（J2-R2・J2-R3）を修正（§9）
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
| `x-test-post/kabumori_pause_guard_test.ts`（新規） | 10件 |
| `x-test-post/kabumori_pause_ingress_test.ts`（新規、2026-10-16） | 本物の handler を通した入口の検証。6件 |
| `tools/kabumori-pause/f2/runtime_plan.ts` と `_test.ts`（新規） | planner の可逆停止・再開、たまった通知、再開の前の審査の計画（純粋関数）。12件 |

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
- **まず呼び出し元を確かめる（2026-10-16、J2-R2）**: 登録された管理者（Supabase Auth の利用者で admin_users にある人。手動の朝の挨拶と同じ確認）でなければ、ブランドを読む前に 401。
- 次に、かぶモリが `disabled` か `is_active=false` なら、AI を呼ぶ前に 423 で断る（`ai_called: 0`）。
- `dry_run` と `live` では今までどおり動く。
  - 休止を2段階に分けられる: `publish_mode=dry_run` なら「X は止め、試し生成は許す」、`disabled` なら「どちらも止める」。
- 2026-10-15 の版では、これらの入口に呼び出し元の確認が無かった（既存の問題。J2-R2）。2026-10-16 に、上の管理者の確認を足して閉じた（§9）。

## 2. 効く範囲・効かない範囲

| 経路 | 今回の候補を入れたあと |
|---|---|
| 予約（共通・旧来の朝刊と大引け、米国プレマーケット、豆知識、交流、tip、予約の挨拶、再試行） | claim の直後に加えて、**送信の直前ごと**に止まる |
| 手動の朝の挨拶 | 開始時に加えて、**アップロードと投稿の直前**に止まる |
| 生成だけの入口 7種 | 管理者でなければ 401（AI・保存・X は0）。管理者でも `disabled` / `is_active=false` なら 423 |
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
  - `--no-check` は既存の型エラーのため。index.ts の型検査は main と同じ6件（朝の挨拶の部品・`_shared/x_oauth2_post.ts` など、すべて既存のコード）。2026-10-15 の版の「4件」は、朝の挨拶のテストのファイル単位の数だった（訂正）。新しいファイルに型エラーは無い。
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

## 9. 2026-10-16：J2 の指摘への修正

### J2-R2（P1）：生成だけの入口の呼び出し元の確認

- `authorizeKabumoriGenerationIngress`（kabumori_pause_guard.ts）で、次の順に判定する。
  1. **呼び出し元（誰か）**: `resolveAdminAuthorization`（x-test-post/admin_auth_logic.ts、既存のまま）で、登録された管理者かを確かめる。
     - 無い・形式が違う・無効なトークン、管理者でない利用者、匿名キーが無い、確認の途中の失敗は、すべて 401。
     - ブランドも読まない。AI・保存・DB の書き込み・X は0。
  2. **機能の状態（してよいか）**: 管理者でも、かぶモリが停止中（disabled・is_active=false・読み取りの失敗）なら 423。AI は0。
  3. 管理者で、live か dry_run なら、試し生成に進む（AI のみ、X は0）。
- 予約の経路（Cron #1 → claim）・POSTONA・会社員AIラボの経路は、この判定を通らない（mode の値で分かれる）。共通の Auth・RLS・RPC・Secret は変えていない。
- 大文字・小文字の違い、末尾の空白、未知の mode は生成の入口に当たらない。予約の経路に行き、期限の来た行が無ければ何もしない（AI は0）。
- 本物の handler を通した検証（`kabumori_pause_ingress_test.ts`）
  - サーバーは起動しない（`Deno.serve` を差し替える）。環境変数はメモリ上の偽物、通信はすべて偽物の router。
  - 7種の mode のすべてで、認証なし → 401、AI・保存の書き込み・DB の書き込み・RPC・X とも0、ブランドも読まない。
  - 無効なトークン、管理者でない利用者、Bearer 以外、匿名キーが無い場合 → 401、効果は0。
  - 管理者で停止中（disabled / inactive / 読み取りの失敗）→ 423、効果は0。
  - 管理者で live / dry_run → 偽の AI に届き、X は0。
  - 大文字・小文字の違いや未知の mode、20回の繰り返しでも、AI は0。

### J2-R3（P2）：planner の再開で持ち主を照合する

- `SettingRow` に行の安定した ID（1行の表は boolean の `id`、`posting_windows` は uuid）と持ち主（`brand_id`、NULL / 空は旧来のかぶモリ）を持たせた。
- 停止の計画（`planPlannerStop`）
  - 止めるのは、**有効な**かぶモリの行だけ。
  - 止める前から OFF の行は `preexistingOff` として触らず、戻しもしない。
  - ID の重複と、業務キー（post_type:slot_no）の重複は中止。
- 再開の計画（`planPlannerRestore`）
  - 止めた行それぞれについて、同じ ID・同じ持ち主・同じキー・まだ OFF であることを確かめる。
  - 止める前から OFF だった行がまだ OFF であること、他ブランドの行の持ち主・キー・状態が変わっていないことも確かめる。
  - **1つでも違えば、計画全体を中止する**（一部だけ戻すことはしない）。
    - 例: かぶモリの行が他ブランドに付け替わっていた（J2 の再現で、以前の版は drift=[] のまま戻そうとしていた）
- CAS と読み戻しのテンプレート（実行しない）

```sql
-- 再開（承認後、1つのトランザクションで。<id>・<owner>・<key> は停止の計画の値）
-- update public.posting_windows set is_active = true
--  where id = <id> and brand_id is not distinct from <owner（旧来は null）> and post_type = <…> and slot_no = <…>
--    and is_active = false
-- returning id;
-- → 戻った行の数が、計画の changes の数と一致しなければ rollback（一部だけ戻さない）
-- 1行の設定: update public.morning_report_settings set is_active = true where id and is_active = false returning id;
-- 読み戻し: §3 の snapshot をもう一度取り、計画の行だけが true、preexistingOff と他ブランドの行は停止の前のまま
```

### 再開の前の審査（休止中に、読み取りだけで行う）

- `claim_due_post` は、期限の来た最古の pending を、古さの下限なしで取る。
- そのため、再開の時点でかぶモリの pending が残っていると、どれだけ古くても投稿される。
  - J2 の再現: 2026-01-01 の豆知識の行が、再開後に送られた。
- **planner を戻すことは、送り直してよいという意味ではない。**
- `resumeReadiness` が ready になるのは、休止中（ゲートを閉じたまま）に読み取って、次がすべて0のときだけ。
  - かぶモリ（と旧来の NULL）の pending の行。期限が来た行はゲートが失敗にしているので、残るのは未来の日時の行。期限が過ぎるのを待つか、行ごとに審査する。一括で戻したり、まとめて失敗にしたりはしない。
  - かぶモリの running の行（送信の途中）。
  - X の結果が不明の実行（生成済みで post id が無い）。アカウントの実際の投稿と照らし合わせてから扱う。再送はしない。
  - かぶモリの通知の pending / processing（`planPushHold` で決める）。
- 他のブランドの予約は、判断の対象にしない。

```sql
-- テンプレート（実行しない。読み取りだけ）
select status, count(*) from public.scheduled_posts
 where coalesce(nullif(brand_id, ''), 'kabumori') = 'kabumori' and status in ('pending', 'running') group by 1;
select id, post_type, scheduled_for from public.scheduled_posts
 where coalesce(nullif(brand_id, ''), 'kabumori') = 'kabumori' and status = 'pending' order by scheduled_for;
-- X の結果が不明の実行（例: 朝刊・大引けの run の表で、生成済みかつ x_post_id が無いもの）
select 'morning' as k, count(*) from public.morning_report_runs where status = 'generated' and x_post_id is null
union all select 'close', count(*) from public.close_report_runs where status = 'generated' and x_post_id is null;
select source_type, push_status, count(*) from public.notifications where push_status in ('pending', 'processing') group by 1, 2;
```

### 2026-10-16 の検証

- 停止候補: `kabumori_pause_guard_test.ts` 10件、`kabumori_pause_ingress_test.ts` 6件が PASS（`--deny-net --deny-env --deny-write --deny-run`）。
- tools: 28件 PASS。前の設計のモデル16件と、計画12件。計画の内訳は、持ち主の変更・キーの付け替えと重複・行の消失・止める前から OFF・状態のずれ・再開の前の審査。
- x-test-post とブランドの全体: 778件 PASS、1件 BLOCKED。
  - 条件は `--deny-net --deny-env --deny-write --deny-run`。環境変数は、テストの前にメモリ上の空の偽物に差し替える（preload）。
  - BLOCKED の1件は、AI Lab の既存のテストが node を起動するもので、`--deny-run` で止まる。J2 と同じ結果。
- negative control（2026-10-16 の追加分）: 8種類で、すべて落ちた。
  - 管理者の確認を外す
  - ブランドを認証の前に読む
  - 匿名キーを要求しない
  - 確認の例外を許可として扱う（初回は検出されず、単体のテストを足して検出するようにした）
  - 持ち主を照合しない
  - 状態のずれを無視する
  - キーの重複を無視する
  - 再開の前の審査が旧来の NULL を見落とす
- 型検査: index.ts は main と同じ6件で、すべて既存のコード。lint は問題なし。
