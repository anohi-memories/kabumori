# 共通AI基盤 Phase 1c — Claude API 本番接続前の安全確認と手順書

- 作成: 2026-10-11 JST（共通AI基盤担当くろちゃん）
- 基準: `origin/main` `5f4ab619`（PR #117 `77a627da`・PR #119 `e6a8bdbb` マージ済み）
- 範囲: 読み取り専用の事前調査と手順書の作成まで
  - 本番DBの変更、migration 適用、Secrets の追加・変更・値の取得、実 Claude API 呼び出し、deploy、モデル切替、merge は**していない**
- 本書のコマンドは、すべて**ユーザーが承認したうえで、ユーザーの端末で実行する**前提で書いている

> **2026-10-11 Phase 1d で更新:** 本番適用・接続テストの実行手順は `docs/ai-provider/PHASE1D_ACTIVATION_RUNBOOK.md` を正とする。本書の §9 の個別コマンドは、1d の runner（`supabase/tests/ai_provider_budget_ledger_rollout.sh`）に置き換えた。§10 の段階2 は 1d の smoke スクリプトで実装した。事前チェックの予測は 1d で一般化した（SET で中継したロールが継承する権限まで判定する）。

## 0. 結論

1. **コードは接続準備まで済んでいる。** ただし、共通 Provider を読み込む Edge Function はまだ1つも無い（`isolation_test.ts` が保証）。キーを登録しても、今の本番の動作は何も変わらない。
2. **足りないのは設定と運用の作業。** Anthropic Console（組織・クレジット・専用 workspace・利用上限・キー）、台帳 migration の適用、予算ポリシーの登録、回復処理の Cron、Phase 2a の呼び出し側（G2）が残っている。
3. **DB 適用は G5 と対象が重ならない。** 新しい schema `ai_ledger` と `public.ai_ledger_*` 7関数を作るだけで、既存の表や関数には一切触れない。ただし、次の2点を守る必要がある。
   - G5 の本番作業の窓（`production_mutation_window: ACTIVE`）とは時間をずらす
   - 適用後に G5 へ知らせる。G5 の過去の本番チェック2本は public の全関数を指紋に含むため、再実行すると差分が出る（§6）
4. **予算は「機能ごとの許可リスト」で始める。** 共有市況レポート（system・Opus 5.5）だけが予約でき、利用者データを含む呼び出しは DB 側でも拒否される。
   - 全体上限のような広い範囲のポリシーは置かない。当てはまるポリシーが1つでもあれば通る仕組みのため、ポリシーの無い機能まで通してしまう（§8）
   - 全体の歯止めは、Anthropic Console の workspace 利用上限で掛ける
5. **接続テストは3段階、合計の上限は約 $2.02。**
   - 段階1: 無料のキー確認
   - 段階2: 約 $0.02 以下の Opus 1回
   - 段階3: Phase 2a のシャドー生成 最大3回。1日の上限 $2.00 で止まる

## 1. 最新 main と共有タスクの状態（2026-10-11 確認）

| 項目 | 状態 |
|---|---|
| main | `5f4ab619`。PR #117（1a）・#119（1b, `8ef3843f`）マージ済み。CURRENT_STATE「Common AI Phase1a/1b SOURCE MERGED」に記録あり |
| 本番作業の窓 | G2・G3・G4・G5 とも `production_mutation_window` は **すべて CLOSED**（最後は G3 10/10 18:59） |
| G5 | Phase 3e K5 済み、`done / next_owner none`。Draft PR #121/#122/#128/#130 は未マージ。E11 は使い捨てプロジェクトでの試験で、本番とは別。家族写真アプリの停止はブロック中 |
| G5 の未適用 migration | `20261009120000_common_account_deletion_completion.sql`（PR #112, merge 済み・本番未適用・ゲート付き） |
| G2 | PR #110（市況レポートの Hard-Fact ガード）は HOLD。P1 修正の TASK が ready。Phase 2a（市況レポートの Claude 接続）は PR #110 → T1 の後 |
| 共通 Provider の利用箇所 | **0**（どの Edge Function も `_shared/ai_provider` を import していない。`isolation_test.ts` が検査） |

## 2. 共通 AI Provider の現在の実装（main）

- 場所: `supabase/functions/_shared/ai_provider/`
- OpenAI は Responses API を raw fetch で呼ぶ。Anthropic は公式 SDK `npm:@anthropic-ai/sdk@0.132.1` を使う
  - 設定: `maxRetries: 0`、`authToken: null`、固定の `baseURL`、`logLevel: "off"`、明示的なタイムアウト
- **自動 Fallback は OFF。** 拒否（refusal）されても自動では再実行しない
- 予算の Guard は2つ
  - `InMemoryBudgetGuard`: 1プロセス内のみ
  - `SupabaseLedgerBudgetGuard`: `/rest/v1/rpc/ai_ledger_*` を service キーで呼ぶ。送信許可は1回だけ（C1 R1 の修正）
- **呼び出し側の配線は無い。** 環境変数から Guard を組み立てる処理や、Edge Function からの利用は Phase 2a で作る

## 3. ANTHROPIC_API_KEY の利用箇所と設定方法

### 3.1 コード上の利用箇所

- 読み取り元は `secrets.ts` の `PROVIDER_API_KEY_ENV.anthropic = "ANTHROPIC_API_KEY"` の **1か所だけ**
  - 環境変数は、呼び出し側が渡す reader（`(name) => Deno.env.get(name)`）経由でだけ読む
- キーは `ProviderApiKey`（文字列化・JSON・inspect の結果が `[REDACTED]`）に包む。`reveal()` するのは adapter がヘッダーに入れるときだけ
- 前後の空白・制御文字を含む値と、Admin キー（`sk-ant-admin…`）は拒否する
- **今の本番の関数で、このキーを読むものは無い**
  - どの関数も `ai_provider` を import していない（`isolation_test.ts` が検査）
  - `ANTHROPIC_API_KEY` を参照しているのは `ai_provider` の中だけ（2026-10-11 に git grep で確認）

### 3.2 SDK が読む環境変数（2026-10-11 に SDK 0.132.1 の実ソースで確認）

キーを明示で渡しているため、`ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_BASE_URL`・プロファイル類は読まれない。ただし、次の2つは**コンストラクタで毎回読まれる**。

- `ANTHROPIC_CUSTOM_HEADERS`: 中身が任意のヘッダーとして、全リクエストに付く
- `ANTHROPIC_WEBHOOK_SIGNING_KEY`: 値は使わない

→ **Supabase の Secrets に `ANTHROPIC_API_KEY` 以外の `ANTHROPIC_*` を置かない。** Secrets はすべての関数から読めるため、特に `ANTHROPIC_CUSTOM_HEADERS` は厳禁。

### 3.3 キーの作り方（Anthropic Console。ユーザー操作）

1. **組織とクレジットの確認**（§8.1）。クレジットを受け取る組織と、キーを作る組織を同じにする。
2. **専用 workspace を作る。** Settings > Workspaces > Create workspace。例: `kabumori-production`
   - Default Workspace には利用上限を設定できない（公式ドキュメント）。そのため専用の workspace が必要
3. **workspace の利用上限を設定する。** Settings > Workspaces で workspace を選ぶ → Spend limits
   - 月の上限（§8.3）と通知の閾値を設定する
   - 上限に達すると API は「workspace の利用上限に達した」エラーで止まる。Provider はこれを `SPEND_LIMIT` として扱い、再試行しない
   - クレジット切れは `CREDIT_EXHAUSTED` として扱い、これも再試行しない
4. **キーを作る。** その workspace に限定したキーにする。service account が使えれば service account のキー、無ければ個人キー
   - service account のキーは、作成者が組織から外れても止まらない
   - 個人キーは、作成者が外れると無効になる
   - **Admin キーは使わない**（コードが拒否する）
5. 表示されたキーは**チャット・ChatGPT・Git・メモに貼らない**。そのまま §3.4 の手順でファイルに入れる。

### 3.4 Supabase への登録手順（ユーザー操作。Phase 2a の開始時に行うのを推奨）

キーを画面やシェル履歴に残さず、600 権限のファイル経由で登録する。キーをクリップボードにコピーした状態で、次を順に実行する。

```bash
umask 077 && mkdir -p ~/.kabumori-secrets
```

```bash
printf 'ANTHROPIC_API_KEY=%s\n' "$(pbpaste)" > ~/.kabumori-secrets/anthropic.env
```

```bash
printf 'x-api-key: %s\n' "$(pbpaste)" > ~/.kabumori-secrets/anthropic.hdr
```

```bash
pbcopy < /dev/null
```

- 段階1・2の接続テスト（§10）は、このファイルを使ってローカルで行う
- Supabase に登録するのは Phase 2a の開始時（段階3の直前）:

```bash
supabase secrets set --project-ref wsmznyzcvmuitkglfeuj --env-file ~/.kabumori-secrets/anthropic.env
```

登録後の確認（名前と sha256 だけが表示される）:

```bash
supabase secrets list --project-ref wsmznyzcvmuitkglfeuj
```

- `ANTHROPIC_API_KEY` があること、ほかの `ANTHROPIC_*` が無いことを確認する
- `secrets set` を実行すると、全関数の version が上がる。コードの差し替えではない（`updated_at` とハッシュは変わらない）
- 使い終わったら2つのファイルを削除する。キーを止めるときは、Console でキーを無効化する（即時）＋ `supabase secrets unset ANTHROPIC_API_KEY`

## 4. 本番 Supabase の migration 適用状況

- 記録上は**未適用**。CURRENT_STATE（10/11）に、merge では migration をどの DB にも適用していないと明記されている。
- 本番の migration 履歴は repo と1対1ではない（G5 の 10/07 調査: 本番だけにある version 6件、履歴に無い repo ファイル約30件）。適用済みかどうかは**履歴ではなくカタログで判定する**。`db push` は使わない。
- 読み取り専用の事前チェックを用意した（§5.2）。結果は次のとおり。
  - 本番に対して SELECT 1回を実行した。終了コード 0、書き込み 0
  - **結果の読み取りは、Claude 側の自動モードが「Production Reads」として拒否した。** そのため結果は未確認で、本書には書いていない
  - CLI は実行のたびに「Initialising login role...」と表示する（CLI 側のログイン用ロールの処理。過去の G5 調査と同じ）
  - ユーザーが同じチェックを自分の端末で実行し、判定を確認する（§12 の操作2）

## 5. ai_ledger の導入に必要な DB 権限

### 5.1 必要な権限

- **適用するロール:** `postgres`（Supabase では superuser ではない）
  - 1b の proof で「superuser ではない所有者」での適用を検証済み（`nonsuper` パート）
- **必要な権限は2つだけ:** データベースへの `CREATE`（`create schema`）と、`public` での `CREATE`（7つの RPC）
  - superuser・GRANT の補修・既存オブジェクトへの ALTER はいずれも不要
- **適用後の権限（migration 自身が検証し、違えば全体をロールバック）:**
  - RPC 7つの EXECUTE は `service_role` だけ
  - schema・表・シーケンス・補助関数には、どのアプリ用ロールにも権限が無い
  - 全表で RLS を有効にし、ポリシーは0件
  - anon・authenticated から service_role・所有者・superuser・台帳の権限を持つロールへの到達経路（継承・SET ROLE）が無いこと

### 5.2 事前チェック（読み取り専用）

- `supabase/tests/ai_provider_budget_ledger_preflight.sql`
  - カタログと migration 履歴だけを読む SELECT 1文。表の中身・個人データ・秘密情報は読まない
  - migration の事後検証が本番で**拒否するかどうかを事前に予測**する
- `supabase/tests/ai_provider_budget_ledger_gate.py`（1d で改名。`preflight` サブコマンド）
  - 上の出力から事実だけを表示し、`READY_TO_APPLY` / `NOT_READY` を判定する
- ローカル（PG17、superuser ではない所有者）での検証では、**予測と migration の実際の判定が7ケースすべてで一致**した
  - 拒否されるケース（4件）: pg_read_all_data への SET、anon → service_role の SET、SET の連鎖、ほかのロールへの既定権限
  - 受け入れるケース（3件）: 基準、SET FALSE の所属、継承のみの中継（C1 の安全な対照）

予測する拒否条件は4つ。

1. アプリ用ロールが、所有者または superuser に到達する（所属しているだけでも該当）
2. anon / authenticated が service_role に到達する
3. アプリ用ロールが `pg_read_all_data` / `pg_write_all_data` に到達する
4. 適用ロールの既定権限（全体、または public）に、migration が REVOKE しないロール宛ての付与がある
   - migration の事後検証「直接の付与は所有者以外に無いこと」で拒否される

## 6. G5（共通アカウント）との競合

| 観点 | 判定 | 対応 |
|---|---|---|
| 対象オブジェクト | 重ならない。台帳は `ai_ledger.*` と `public.ai_ledger_*` だけを作る。G5 は `private.account_lifecycle_*` と `public.*common_account*` | — |
| ロック | 既存の表を一切ロックしない（新規作成だけ） | — |
| G5 の未適用 migration（20261009120000）の事前検証 | G5 自身の名前だけを確認する作りで、台帳の有無には影響されない | — |
| **G5 の過去の本番チェック** | `common_account_lifecycle_preflight/sql/07_existing_fingerprint.sql` と `common_account_service_start_intent_preflight/sql/04_touched_and_fingerprints.sql` は、public・private の**全関数**を指紋に含む。台帳の適用後に再実行すると、+7関数の差分が出る | **G5 の窓（ACTIVE）の最中には適用しない。** 適用したら、日時と追加した関数名を G5 に共有する |
| 履歴の順番 | 台帳（20261010050613）を先に入れると、G5 の 20261009120000 は後から古い version として入る。`db push` は使わないので実害は無い。ただし G5 の runner は履歴の件数を比べる | G5 に「履歴が +1 行」と共有する |
| アカウント削除 | 台帳の `user_id` 行は G5 の残留チェック（residue / footprint）の対象外 | 初期は system だけ（§8 の許可リストで user は DB 側でも拒否）なので、user_id の行は発生しない。user 用の経路を開く前に、G5 と仮名化・削除の方針を決める |
| 直列化 | 同じ Supabase への DDL は1つずつ行う決まり | 適用の直前に、全 TASK の `production_mutation_window` を確認する。この部屋には TASK ファイルが無いので、ChatGPT が CURRENT_STATE に窓を記録する |

**結論:** G5 の作業を止める必要は無く、G5 の窓とは時間で分けるだけでよい。G5 が窓を開けたら、そちらを優先して台帳の適用を待つ。

## 7. 本番 PostgREST で RPC を公開する条件

1. **公開される schema:** `public`（既定）。RPC は `public` に作るので、`/rest/v1/rpc/ai_ledger_*` で届く。schema `ai_ledger` は公開しない（公開設定にも入れない）。
2. **呼び方:** `POST`、本文は `{"p": {...}}`。ヘッダーは `apikey` と `Authorization: Bearer <service キー>`。
   - 既存の `_shared/news_discovery/supabase_store.ts` と同じ経路・同じヘッダー
   - 引数は名前付きの `p jsonb` が1つだけで、オーバーロードは無い
3. **キー:** service_role 相当のキーだけが通る。anon・authenticated の JWT では EXECUTE できない（migration が検証）。
   - 既存コードには、旧形式の `SUPABASE_SERVICE_ROLE_KEY` と新形式の `SUPABASE_SECRET_KEYS['default']` の両方がある。Phase 2a で、どちらを使うかを G2 と決める
4. **スキーマキャッシュの再読み込み:** Supabase は通常、`pgrst_ddl_watch` / `pgrst_drop_watch` のイベントトリガーで自動的に再読み込みする。事前チェックで、この2つの有無を確認する。
   - 無い場合: 適用直後に RPC が 404 になったら、`notify pgrst, 'reload schema';` を1回だけ実行する（書き込みではなく通知）
5. **エラー:** migration の `raise`（P0001 / 22023）は HTTP 400 になる。Guard は RPC 名・状態・PostgREST のコードだけを持ち、本文は保持しない。
6. **未検証の点:** 実際の PostgREST を通した呼び出しは、まだ一度も行っていない（1b の e2e はローカルの代替サーバー）。段階3の最初の1回が、その確認を兼ねる。

## 8. 予算ポリシーの初期設定案

### 8.1 クレジットの扱い（2026-10-11 に公式ドキュメントで確認）

- Max 5x には月 $100 の API クレジットが付く。claude.ai の Settings > Billing で Console の組織に紐づけて受け取る（紐づけ先は自分では変更できない）
- 請求サイクルの終わりに失効し、繰り越しは無い。残高と有効期限は、Console の Settings > Billing の「Promotional credits」で確認できる
- 使い切ると、購入残高が無ければ API は止まる（`Your credit balance is too low…`）。Claude のプランには課金されない
- 組織のすべての workspace とキーが、同じ残高を使う
- 組織の利用上限は暦月の1日にリセットされる。クレジットは請求サイクルで補充されるため、両者の区切りは一致しない
- **紐づけ・残高・有効期限は未確認。$100 を予算として前提にしない。**

### 8.2 台帳のポリシー（`supabase/tests/ai_provider_budget_ledger_initial_policies.sql`。未適用）

| policy_key | 範囲 | 期間 | 上限 |
|---|---|---|---|
| `anthropic.opus.kabumori.market_report.monthly` | anthropic / claude-opus-5-5 / kabumori / market_report / system | JST 月 | $5.00・40回・1回あたり $1.00 |
| `anthropic.opus.kabumori.market_report.daily` | 同上 | JST 日 | $2.00・6回 |

- **広い範囲のポリシーは置かない**。当てはまるポリシーが1つでもあれば通る仕組みのため、全体・provider 全体のポリシーを置くと、ポリシーの無い機能（POSTONA の相談など）も通ってしまう。
- ローカル PG で確認した結果:
  - 予約できる: 市況レポート（system・Opus）
  - `NO_MATCHING_POLICY` で拒否: user の呼び出し、POSTONA、Sonnet、OpenAI
  - `PER_CALL_LIMIT` で拒否: 1回 $1.20
  - `CALL_LIMIT` で拒否: 1日の7回目
- **1回あたり $1.00 の理由:** 予約時の上限額は、入力の UTF-8 バイト数（日本語は実際のトークン数の数倍）と最大出力 16,000 トークンから計算され、平均費用（G2 測定で約 $0.27）よりかなり大きくなる。Phase 2a で実際のリクエストの上限額を測ってから見直す。
- **すぐ止める方法:** `update ai_ledger.budget_policies set enabled = false;` を実行すると、すべての呼び出しが `NO_MATCHING_POLICY` で止まる（予約の段階で拒否され、API には送られない）。

### 8.3 本番運用の目安（Phase 2a のシャドー結果と、クレジットの確認後に決める）

- 試算: 1日2本（朝刊・大引け）× 営業日 約21日 ≒ 42本/月 × $0.27 ≒ $11。作り直しで 1.5 倍になると ≒ $17
- 推奨値（案）:
  - 月: $20・60回
  - 日: $3・8回
  - 1回あたり: 実測した上限額 × 1.2 程度
- Console の workspace 利用上限: 台帳の上限より少し上（試験中 $10、本番 $25）。台帳が働かなかった場合の、provider 側の歯止めにする
- 自動チャージ（auto-reload）は OFF のまま。購入クレジットも、当面は追加しない

## 9. 本番適用の手順・読み戻し・rollback（承認後。ユーザーが実行）

> **1d で置き換え済み。この節のコマンドを直接使わない。** 1d の runner（`supabase/tests/ai_provider_budget_ledger_rollout.sh`）は、接続先の検証（cron の URL の ref とかぶモリ固有の目印）、CLI の互換性の確認、`--agent no` と出力の厳密な判定を行う。下のコマンドには、それが無い。

前提として、次の3つを満たしてから進める。

- 専用のちゃ・ユーザーの承認
- 全 TASK の `production_mutation_window` が CLOSED であること
- G5 の chat への事前連絡

コマンドはすべて、この手順書がある worktree のルートで実行する。

1. **事前チェック（読み取りのみ）:** 判定が `READY_TO_APPLY` であることを確認する。`NOT_READY` なら中止し、表示された理由を共有する

```bash
supabase db query --linked --project-ref wsmznyzcvmuitkglfeuj --output-format json -f supabase/tests/ai_provider_budget_ledger_preflight.sql | python3 -I supabase/tests/ai_provider_budget_ledger_gate.py preflight
```

2. **窓を開く:** ChatGPT が CURRENT_STATE に「共通AI基盤 ledger apply ACTIVE（対象: schema ai_ledger と public.ai_ledger_* だけ）」を記録する。

3. **適用（書き込み。1回だけ）:** migration は自前の BEGIN/COMMIT を持ち、事後検証で失敗すると全体がロールバックされる。途中までの状態は残らない

```bash
supabase db query --linked --project-ref wsmznyzcvmuitkglfeuj -f supabase/migrations/20261010050613_ai_provider_budget_ledger.sql
```

- 接続が切れて結果が不明なときは、**再実行しない**。手順4の読み戻しで判定する
- 二重に適用されることは無い。2回目は `create schema ai_ledger` で失敗する

4. **読み戻し（読み取りのみ）:** `must_be_true` がすべて true、`rows` がすべて 0 であることを確認する

```bash
supabase db query --linked --project-ref wsmznyzcvmuitkglfeuj --output-format json -f supabase/tests/ai_provider_budget_ledger_readback.sql
```

5. **履歴の行（書き込み）:** 読み戻しが PASS した後だけ行う

```bash
supabase db query --linked --project-ref wsmznyzcvmuitkglfeuj "insert into supabase_migrations.schema_migrations (version, name) values ('20261010050613', 'ai_provider_budget_ledger') on conflict (version) do nothing"
```

6. 読み戻しをもう一度行い、`history_row = 1` を確認する。窓を CLOSED にして、G5 に共有する。
7. **ポリシーの登録（書き込み・別の承認）:** Console の確認と金額の承認が済んでから、`supabase/tests/ai_provider_budget_ledger_initial_policies.sql` を適用し、読み戻しで `budget_policies = 2` を確認する。
8. **回復処理の Cron（書き込み・別ゲート）:** Phase 2a を本番で動かす前に設定する。
   - pg_cron で `select public.ai_ledger_recover_stale('{}'::jsonb)` を数分ごとに実行する
   - 所有者権限で動くので、HTTP もキーも不要
   - 未設定のままだと、応答が失われた予約が上限額のまま保持され続ける

**rollback**

| 状況 | 方法 |
|---|---|
| 呼び出しを止めたい | §8.2 の `enabled = false`（即時）。Console でキーを無効化。`supabase secrets unset ANTHROPIC_API_KEY` |
| 台帳ごと戻したい（**呼び出し側を配線する前だけ**） | 次の3つを順に行う。① `ai_ledger_usage_summary` で集計を控える（rollback で台帳が消えるため）② `supabase/tests/ai_provider_budget_ledger_rollback.sql` を実行し、履歴の行を削除する ③ 事前チェックが再び `READY_TO_APPLY`（対象が無い状態）に戻ることを確認する |
| 適用が事後検証で拒否された | 何も残っていない。表示された `AI_LEDGER_*` の理由を共有し、ロールの構成を調べる（補修の GRANT / REVOKE はしない） |

ローカルでの確認結果: 適用 → 読み戻し PASS → 直接の付与を入れると読み戻しが検出 → rollback → 事前チェックが `READY_TO_APPLY` に戻る。この一連の流れを確認済み。rollback の完全性は、1b の proof でカタログの digest が一致することを確認済み。

## 10. Claude API の最小費用での接続テスト計画

すべて **system 主体・合成の文章だけ**で行う。個人の保有銘柄や利用者のデータは使わない。

| 段階 | 内容 | 費用の上限 | 実行場所 |
|---|---|---|---|
| 1 | `POST /v1/messages/count_tokens`（model `claude-opus-5-5`、1文）。キー・組織・workspace・モデルの利用権限を確認する | **$0**（公式に無料。Messages とは別の rate limit） | ユーザーの端末。`curl -H @~/.kabumori-secrets/anthropic.hdr …`。応答ヘッダーで `anthropic-organization-id` / `anthropic-workspace-id` を確認する |
| 2 | 共通 Provider の `executeAiRequest` で Opus 5.5 を1回呼ぶ（InMemory Guard、上限 $0.05・1回）。effort low、最大出力 1,024、構造化出力（小さな schema） | **≒ $0.022**（入力約300バイト ≦ $0.0012 ＋ 出力 1,024 × $20/M = $0.0205） | ユーザーの端末。小さな smoke スクリプトを Phase 1d で作る（offline テスト付き。キーは `--env-file` で渡し、環境はほぼ空にして `ANTHROPIC_CUSTOM_HEADERS` などが入らないようにする） |
| 3 | Phase 2a: 共有市況レポートのシャドー生成（公開しない）。本番 Edge Function、台帳 Guard、§8.2 のポリシーで行う。最大3回 | 1回 ≒ $0.27（G2 測定）、予約上限 ≦ $1.00。1日 $2.00 で止まる | G2 と調整（PR #110 → T1 の後）。最初の1回で、PostgREST 経由の RPC（§7-6）も確認する |

- 確認する項目: 応答の model、stop_reason、usage、Provider が推定した費用と Console の Cost ページの差、構造化出力の検査結果、台帳の行（段階3）
- 失敗した場合: 自動で再実行はしない（Fallback OFF）。billing 系・利用上限のエラーは再試行しない。原因を確認してから、新しい callId で1回だけやり直す
- 費用の合計上限: 段階1 $0、段階2 ≦ $0.022、段階3 ≦ $2.00（1日の上限で止まる）

## 11. 不足している設定（一覧）

| # | 項目 | 担当 | 状態 |
|---|---|---|---|
| 1 | クレジットを受け取る Console 組織、残高、有効期限 | ユーザー | 未確認 |
| 2 | 専用 workspace と、その利用上限（月）・通知 | ユーザー | 未作成 |
| 3 | workspace に限定したキー（service account 推奨。Admin キーは不可） | ユーザー | 未作成 |
| 4 | Supabase Secret `ANTHROPIC_API_KEY`（ほかの `ANTHROPIC_*` は置かない） | ユーザー | 未登録（推定。§12 の操作3で名前を確認） |
| 5 | 台帳 migration `20261010050613` の本番適用 | ユーザー（承認後） | 未適用（記録上） |
| 6 | 予算ポリシー（§8.2） | ユーザー（承認後） | 0件 |
| 7 | 回復処理の Cron | 別ゲート | 未設定 |
| 8 | 段階2の smoke スクリプト | くろちゃん（Phase 1d） | 未作成 |
| 9 | Edge Function 側の配線（ledger Guard の組み立て、使うキーの種類） | G2（Phase 2a） | 未着手 |
| 10 | `migration_source_invariants_test.ts` の RESERVED に 20261010050613 を加えるか | ChatGPT 調整 | 未決（共有ファイルなので編集していない） |
| 11 | 台帳の user_id の保持・削除の方針 | G5 と調整 | user 用の経路を開く前に必要 |
| 12 | プライバシーポリシー（委託先が OpenAI だけの記載） | 別タスク | 共有市況レポートは個人データを含まないので、初期接続は対象外。user 用の経路の前に必要 |

## 12. 次に必要なユーザー操作（この順で）

1. **Console の確認（無料・本番に影響なし）:** クレジットの紐づけ先の組織・残高・有効期限を確認し、専用のちゃに共有する（キーの値は共有しない）。
2. **本番の事前チェック（読み取りのみ）:** §9 の手順1のコマンドを1回実行し、`VERDICT` の行と、`predicted_refusal` の4行を共有する。
3. **Secrets の名前の確認（読み取りのみ）:** `supabase secrets list --project-ref wsmznyzcvmuitkglfeuj` で、`ANTHROPIC_` で始まる名前が無いことを確認する（値は表示されない）。
4. **専用のちゃの判断:**
   - ポリシーの金額（§8.2 / §8.3）
   - 台帳の適用の日時（G5 の窓を避ける）
   - Phase 1d（段階2の smoke スクリプト）を作るか
5. 承認後: Console で workspace・利用上限・キーを作る → §3.4 でファイルを作る → 段階1 → 段階2 → 台帳の適用（§9）→ ポリシー → Cron → Phase 2a（G2）で段階3。

## 13. 未解決事項・注意

- **広い範囲のポリシーと許可リストは両立しない（§8.2）。** 機能の数が増えて全体の上限を DB で持ちたくなったら、「当てはまっても、それだけでは許可にならない上限専用のポリシー」を追加する設計が必要（台帳の migration の変更。将来）。
- `mark_sent` の応答が失われた試行は、Cron が設定されるまで上限額のまま保持される（1b の既知事項）。
- 本番の事前チェックの結果は未確認（§4）。§12 の操作2で確定する。
- 通常の `deno lint` で `no-import-prefix` が1件出る件は、1b の報告どおり（対応案 a を推奨）。

## 付録: 今回追加したファイル

| ファイル | 種類 | 本番での扱い |
|---|---|---|
| `supabase/tests/ai_provider_budget_ledger_preflight.sql` | 読み取り専用 SELECT | 事前チェック（§5.2） |
| `supabase/tests/ai_provider_budget_ledger_gate.py`（1d で改名。`preflight` サブコマンド） | 判定スクリプト（stdin の JSON だけを読む） | 事前チェックの判定 |
| `supabase/tests/ai_provider_budget_ledger_readback.sql` | 読み取り専用 SELECT（台帳の行は件数だけ） | 適用後の読み戻し（§9） |
| `supabase/tests/ai_provider_budget_ledger_initial_policies.sql` | 運用 SQL（書き込み・未適用） | 承認後のポリシー登録 |
| `docs/ai-provider/PHASE1C_PRODUCTION_READINESS.md` | 本書 | — |
