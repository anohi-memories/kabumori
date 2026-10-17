# F6 POSTONA の Claude AI: 費用の台帳・利用の上限・重複の防止・主体の帰属の設計（source-only）

- 日付: 2026-10-17（JST）
- task_id: `common-ai-f6-postona-ai-ledger-quota-idempotency-design-20261017`
- 前提: #239（`F6_POSTONA_CLAUDE_INTERFACE_PREFLIGHT.md`）の §3 の 9 件のうち、2・3・4・5 を具体にする
- 利用者の判断（2026-10-17、TASK に記録）: POSTONA の AI 相談と投稿の入力を Anthropic に送る**方向は了承**。ただし、今の「個人情報を Anthropic に送らない」決まりの正式な調整、プライバシーの告知、本番と有料の利用は**未承認**
- 調べた元: fresh `origin/main` `f85bfc70`（読み取り専用の調査の助手 2 つ＋ F6 の確認）、#238 `b8e91ea8`（読むだけ）、F6 / H5 の stack の先頭 #239 `f590b80f`
- この PR で足したのは、この文書と F6 のテスト 1 本（`postona_call_store_contract_test.ts`、オフライン）だけ。migration は作っていない。DB、RPC、認証、POSTONA、H5 bridge、Edge、Cron には触れていない

## 0. 決めたこと（要約）

1. **主体はブランドではなく利用者**。POSTONA のブランド ID（`u_` で始まる文字列）は、台帳の主体にも bridge の主体にも使わない。相談と試し投稿は JWT で確かめた利用者、会社員AIらぼは system、利用者のブランドの予約投稿は「ブランドの owner を DB で確かめる新しい RPC」で利用者に結びつける（その RPC ができるまで、予約投稿は今の OpenAI のまま）
2. **二重送信の防止は、台帳の schema に新しい表 `ai_ledger.consumer_calls` を足す**（H5 bridge の保存の口を、DB で原子的に実装する）。完了を失った呼び出しは「処理中」のまま残し、復旧で「中身の無い UNKNOWN の印」で閉じる。**送り直しは絶対にしない**。モデルの出力は 24 時間だけ置き、その後は印に置き換える
3. **上限は台帳の枠で守る**。機能ごとに、利用者ごと（1 日・1 か月）と機能全体（1 か月）の枠を入れる（台帳は合う枠を**全部**満たさないと断る）。枠はすべて provider・model・application・feature・主体の種類まで絞り、広い枠は作らない（広い枠は、自分の枠の無い機能まで通してしまうため）。POSTONA 全体の天井は Anthropic の Console の workspace の上限。1 回の上限は bridge の `maxTotalCostUsd`
4. **利用権は bridge の `authorize` で確かめる**。POSTONA の利用権は今の `service_entitlements` の `x_autopost`（POSTONA のサービス）が `active` で、共通アカウントが `active` であること。利用者の JWT で読む（service role は読めない）
5. **切り替えは機能ごとのフラグ**。既定は今の OpenAI。戻すときもフラグ。順番は 相談 → 試し投稿 → 会社員AIらぼ → 予約投稿
6. **アカウント削除**: 保存の場所の行は削除の時に消す。台帳の利用者 ID は、削除の時に、元に戻せない別の値に置き換える（台帳は追記専用なので、制御された関数を足す）。共通アカウントの削除の手順に組み込む（F5 / G5）

## 1. 今の状態（読み取りで確かめたこと）

### 1.1 費用の台帳 `ai_ledger`（`supabase/migrations/20261010050613_ai_provider_budget_ledger.sql`）

- 表
  - `budget_policies`: 枠。範囲は provider / model / application / feature / logical_role / subject_kind / brand / user（null は「どれでも」）。`per_user` / `per_brand` で利用者・ブランドごとの桶に分ける。期間は `month` / `day`（日本時間）。上限は金額・回数・1 回の金額
  - `budget_buckets`: 桶。`(policy_id, period_start, brand_id, user_id)` で一意
  - `reservations`: 送信 1 回ごとの予約。`(request_id, attempt)` で一意。状態は reserved → sent → settled / unknown、または released。`user_id` / `brand_id` は **uuid**、外部キーは無い
  - `usage_events`: 結果（追記専用）。`billing_observations`: provider の請求の観測（追記専用）
  - すべて RLS あり・方針なし。`service_role` 以外は何もできない
- RPC（すべて `security definer`、`search_path = ''`、`service_role` だけが実行できる）: `ai_ledger_reserve` / `mark_sent` / `settle` / `release` / `recover_stale` / `usage_summary` / `budget_status`
- 枠の判定: 有効な枠のうち範囲が合うものを**全部**満たす必要がある。合う枠が 1 つも無ければ `NO_MATCHING_POLICY` で断る
- 期間は予約の時刻で決まり、精算が期間をまたいでも同じ桶に入る
- 古い予約の後始末（`recover_stale`）はあるが、動かす Cron はリポジトリに無い
- 個人のデータ: 利用者・ブランドは不透明な uuid だけ。プロンプト・出力・鍵は残さない。**削除・仮名化の手順は無い**（追記専用。保持期間の案は未承認）。共通アカウントの削除の確認（`account_lifecycle_footprint` / `residue`）にも入っていない
- 本番: 共通AI基盤（G6）の Phase 1f（2026-10-11 21:31 JST に適用、`.agent/tasks/CLAUDE_TASK_6.md` の Report、commit `c2fcdb67952610e1e7b1007bbf37b9e8e534e14b`）で適用済みと記録がある。最初の枠は Opus・かぶモリ・市況レポート・system に限った 2 つ（その後、額を上げた記録あり）。**今の本番の行は確かめていない**（NOT_VERIFIED）。POSTONA の呼び出しはどの枠にも合わないので、今つないでも台帳が断る（安全側）
- TS のクライアント `ledger_guard.ts`: `request_id` に `callId`、利用者のときは `user_id` と（あれば）`brand_id` を送る

### 1.2 POSTONA の主体とブランド

- `brands.id` は文字列（`^[a-z][a-z0-9_]{1,40}$`）。表の作成は本番の元からあるもので migration に無い。利用者のワークスペースは `begin_social_mobile_x_oauth_connection`（利用者の JWT）が `'u_' || substr(md5(user_id), 1, 24)` で作る。**同じ利用者なら、POSTONA をやめて入り直しても同じ ID になる**
- `brand_memberships`: `(brand_id, user_id)` が主キー。役割は owner / admin / member / viewer。**owner を 1 人に限る DB の決まりは無い**（作成の RPC が「owner のブランドは 1 つまで」を確かめるだけ）
- 削除: `auth.users` を消すと `brand_memberships` などが消える。POSTONA の削除の手順（`social_mobile_account_deletion_*`）がブランドとその下を消す。台帳の行は残る
- 予約投稿の経路（`x-test-post` → `vault_account_brand_post.ts`）は **owner の利用者を確かめていない**。経路の RPC はどれも投稿・アカウント・ブランドで判定し、利用者を受けない

### 1.3 利用権とサービスの終了

- `public.common_accounts`（`status`: active / deleting / locked、`lifecycle_version`）、`public.service_entitlements`（`service_key` は `kabumori` / `x_autopost` だけ、`status`: provisioning / active / suspended / deleting / ended、`activated_at`）
- 権限: `service_role` からは全部取り上げてある。利用者は自分の行の決まった列だけ読める（列の指定が要る）
- RPC: `start_x_autopost_service()` / `reactivate_x_autopost_service(version)`（利用者）、削除の RPC（service role）
- **今、利用権を確かめる Edge の関数は無い**
- #238（F4＋F5）はアプリの中だけ。F4 の「サービスの終了」の epoch はアプリのメモリの中の数で、サーバーからは使えない。サーバーで確かめられるのは、今の `service_entitlements.status` と `common_accounts.lifecycle_version` / `activated_at` だけ
- main に無い候補: F5 の commit `4638891f` の `common_account_brand_service_state(p_brand_id, p_service_key)`（service role）。ブランド → owner → 利用権を返す。main にも #238 にも入っていない

### 1.4 H5 bridge の保存の口（`ai_consumer_bridge/types.ts`）

- `claim(identity) → acquired(owner) | busy | conflict | complete(fingerprint, result)`、`complete(identity, owner, result)`
- 決まり: 複数の worker で耐久的・原子的。期限切れでの横取りはしない。`complete` は owner と identity を原子的に比べる。例外や応答の喪失は UNKNOWN で、送り直さない
- 今あるのはテスト用の偽物だけ

## 2. 主体とブランドの帰属

### 2.1 案の比べ

| 案 | 中身 | 良い点 | 問題 | 判定 |
|---|---|---|---|---|
| A | 主体は利用者だけ（`brandId: null`）。ブランドは監査のために保存の場所に文字列で残す | DB の変更が要らない。POSTONA の利用者のワークスペースは利用者に 1 対 1。利用者ごとの上限がそのまま使える | ブランドごとの上限・請求はできない | **採用（今）** |
| B | `brands` に代理の uuid の列（`ai_subject_id uuid default gen_random_uuid() unique not null`）を足し、それを主体のブランドにする | ブランドごとの上限ができる。消して作り直すと新しい uuid になり、前の期間と混ざらない | 本番の元からある `brands` の変更（POSTONA の担当）。予約投稿などで uuid を読む手間 | ブランドごとの上限が必要になったら |
| C | 台帳に文字列のブランドの列を足す | slug をそのまま使える | 共通AI基盤の型と検査（`brandId` は uuid）を広く変える。入り直しで同じ slug に戻り、期間が混ざる | 採らない |
| D | slug から uuid を計算する（UUIDv5 など） | DB の変更が要らない | ハッシュから作った ID に頼る。入り直しで同じ値に戻る | 採らない（TASK の禁止事項） |
| E | bridge の `tenantTag`（ハッシュ）だけで区別する | 変更が要らない | 台帳の枠や集計に使えない | 採らない |

### 2.2 採用案 A の決まり

| 機能 | 主体 | 主体の確かめ方 | ブランドの扱い |
|---|---|---|---|
| AI 相談 | `{ kind: "user", userId, brandId: null }` | 利用者の JWT（`/auth/v1/user`）。owner のワークスペースの確認は今の POSTONA のまま | 保存の場所の `brand_ref` に監査用に残す |
| 試し投稿 | 同上 | 同上 | 同上 |
| 会社員AIらぼ | `{ kind: "system" }` | 運営のブランド（`ai_salaryman_lab`）だけ。今のトピックの claim の確認のまま | role / feature で区別 |
| 利用者のブランドの予約投稿 | `{ kind: "user", userId: <owner> }` | **新しい service role の RPC**（F5）が、ブランドの owner がちょうど 1 人で、その利用者の共通アカウントと `x_autopost` が active のときだけ user_id を返す。推測や `u_` からの逆算はしない | 同上 |

- 他の利用者との境界: bridge の `tenantTag = hash([application, subject])`、`callId = hash(tenantTag, feature, operationId)`。同じ operationId でも、利用者が違えば別の呼び出し（§6 で確認）。operationId は利用者をまたいで信用しない
- 削除: §4.6

## 3. 上限と利用権

### 3.1 上限の三段

| 段 | どこで | 何を |
|---|---|---|
| 1 回 | bridge の登録（`maxTotalCostUsd`）と枠の `max_usd_per_call` | 1 回の上限額（送る前に最大額で確かめる） |
| 利用者 | 台帳の枠（`per_user`、日本時間の日・月） | 利用者ごとの回数と金額 |
| 機能全体 | 台帳の枠（`per_user` なし、月） | 機能ごとの全利用者の合計（暴走の止め） |
| POSTONA 全体 | Anthropic の Console の workspace の上限（台帳の外） | 全部の機能の合計の天井 |

- 台帳は合う枠を全部満たす必要があるので、利用者の枠と機能全体の枠が両方効く（`ai_ledger_reserve` は合う枠のうち 1 つでも超えたら `CALL_LIMIT` / `COST_LIMIT` / `PER_CALL_LIMIT` で断る）
- **広い枠（例: application = postona だけ）は作らない**。台帳は「合う枠が 1 つでもあれば判定に進む」ので、広い枠があると、自分の枠の無い機能や model（例: Opus の新しい機能）まで広い枠の額の中で通ってしまう。すべての枠を provider・model・application・feature・主体の種類まで絞ると、枠の無い呼び出しは `NO_MATCHING_POLICY` で断られる（許可の一覧として働く）。共通AI基盤の最初の枠と同じ決まり（`supabase/tests/ai_provider_budget_ledger_initial_policies.sql` の冒頭、`PHASE1D_ACTIVATION_RUNBOOK.md` の「広い範囲のポリシーと許可リストは両立しない」）。POSTONA 全体の上限を台帳で持つには「合っても、それだけでは許可にならない上限専用の枠」が要る（台帳の migration の変更。今回は案だけ）
- 利用者ごとの枠（`per_user`）は利用者の無い呼び出し（system）には合わないので、会社員AIらぼには system の枠を別に置く
- POSTONA 全体の天井は台帳では表さず、Anthropic の Console の workspace の上限で守る（本番には上限を付けられる専用の workspace が要る。既定の workspace には付けられない）
- 回数は「送信の回数」。課金の可能性がある失敗は送り直さないので、1 回の依頼 = 1 回（429 / 529 の送り直しを許すロールだけ例外）
- 上限に当たったら bridge は `BUDGET_DENIED`。相談は新しいコード `CONSULT_QUOTA_EXCEEDED`（#239 §2.2）、投稿は失敗にする（今の OpenAI に自動で戻さない）

枠の案（**数字はすべて案。本番の DB の変更は別承認**。#239 の §2 の表では、Haiku の 1 回の上限額は相談 $0.0044・投稿 $0.0019 以下。多めの見積もり）。すべて provider `anthropic`・model `claude-haiku-5-5`・application `postona` に絞った上で:

| policy_key（案） | feature / 主体の種類 / 分け方 | 期間 | 回数 | 金額 | 1 回 |
|---|---|---|---|---|---|
| `anthropic.postona.consult.user.daily` | consult / user / per_user | 日 | 30 | $0.20 | $0.05 |
| `anthropic.postona.consult.user.monthly` | 同上 | 月 | 300 | $2.00 | $0.05 |
| `anthropic.postona.consult.all.monthly` | consult / user / 全利用者 | 月 | 20,000 | $20.00 | $0.05 |
| `anthropic.postona.preview.user.daily` | brand_post_preview / user / per_user | 日 | 10 | $0.05 | $0.02 |
| `anthropic.postona.preview.all.monthly` | brand_post_preview / user / 全利用者 | 月 | 5,000 | $3.00 | $0.02 |
| `anthropic.postona.scheduled.user.daily` | brand_post_scheduled / user / per_user | 日 | 6 | $0.03 | $0.02 |
| `anthropic.postona.scheduled.all.monthly` | brand_post_scheduled / user / 全利用者 | 月 | 5,000 | $3.00 | $0.02 |
| `anthropic.postona.ai_lab.system.daily` | ai_lab_post / system | 日 | 12 | $0.10 | $0.02 |
| `anthropic.postona.ai_lab.system.monthly` | ai_lab_post / system | 月 | 400 | $2.00 | $0.02 |

- 機能全体の月の金額の合計は $28.00（案）。Console の workspace の上限はこれより少し上に置く

### 3.2 利用権（bridge の `authorize`）

- 相談・試し投稿: POSTONA の処理が、利用者の JWT で `service_entitlements?select=status,activated_at&service_key=eq.x_autopost` と `common_accounts?select=status,lifecycle_version` を読む。**両方 `active` のときだけ** `{ subject, expiresAtMs: 今 + 60 秒 }` を返す。それ以外は `null`（bridge は `AUTHORITY_DENIED`、何も送らない）
  - `x_autopost` は今の POSTONA のサービスの利用権。AI を別の有料の追加にするなら、F5 が新しい `service_key` を足す（今回は案だけ）
  - F4 のサービスの終了は、サーバーでは `status = ended` になる。アプリの epoch は使わない
  - `lifecycle_version` と `activated_at` は監査（保存の場所）に残す。入り直しても利用者ごとの上限はリセットされない（台帳の桶は利用者と期間で決まるため。上限を逃れるための入り直しを防ぐ）
- 予約投稿: 上の新しい service role の RPC が、owner と利用権を一緒に確かめる（F5）
- 会社員AIらぼ: system。利用権の確認は無し（運営のブランドだけ）。今の厳密なアカウントの確認（`assertAiLabBrandPostDispatchAllowed`）のまま

### 3.3 切り替えと戻し方

- 機能ごとのフラグ（例: `POSTONA_CONSULT_AI_PROVIDER = openai | claude`、試し投稿・会社員AIらぼ・予約投稿にも 1 つずつ）。**既定は `openai`**。今の OpenAI の経路はそのまま残す
- 戻すときはフラグを `openai` に。台帳と保存の場所の記録は消さない
- 自動で OpenAI に戻す仕組みは作らない（Claude が失敗したら失敗を返す）
- フラグの変更は本番の設定の変更なので、承認が要る

### 3.4 送るもの・送らないもの・残すもの

| | 中身 |
|---|---|
| 送る（相談） | 利用者の発言、履歴（今の上限の中）、保存した設定（`consultContextFor` の範囲）、**確認済み**のペルソナ |
| 送る（投稿） | ブランドの声の指示、設定（トーン・テーマ・NG 語・メモの抜粋 600 字まで）、確認済みのペルソナの特徴、テーマ |
| 送らない | 利用者 ID、メール、X のハンドル・アカウント ID、ブランド ID（slug）、鍵、トークン、他の利用者のデータ |
| 残す（保存の場所） | 呼び出しの識別子（ハッシュ）、監査の数、**モデルの出力は 24 時間まで**（その後は中身の無い印） |
| 残す（台帳） | 不透明な利用者 ID、トークン数、費用。中身は残さない |
| ログ | 数と種類だけ（今のまま） |

## 4. DB の設計（**schema の草案だけ。migration は作っていない**）

> 2026-10-17 追記: 実装の候補（`F6_POSTONA_CONSUMER_CALLS_PG_CANDIDATE.md`、migration `20261017120000_ai_consumer_call_store.sql`）では、表を台帳と**別の schema `ai_calls`** に置き、RPC の名前を `ai_calls_*` にした。台帳は出力を保存しない決まりで、台帳のテストもそれを確かめているため。`ai_ledger_forget_user`（台帳の利用者 ID の置き換え）は台帳の trigger の変更が要るので、まだ作っていない。

すべて台帳と同じ流儀: `ai_ledger` schema、RLS あり・方針なし、全ロールから取り上げ、`public.ai_ledger_*(p jsonb) returns jsonb`、`security definer`、`set search_path = ''`、`service_role` だけが実行できる。適用後の確認（権限の漂流があれば止める）を同じく付ける。

### 4.1 保存の場所 `ai_ledger.consumer_calls`

```sql
create table ai_ledger.consumer_calls (
  call_key text primary key check (call_key ~ '^h5m2_[0-9a-f]{64}$'), -- bridge の callId（= reservations.request_id。bridge.ts は 'h5m2_' + SHA-256 の小文字 16 進）
  tenant_tag text not null check (tenant_tag ~ '^[0-9a-f]{64}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  application text not null check (application ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  feature text not null check (feature ~ '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$'),
  subject_kind text not null check (subject_kind in ('system', 'user')),
  user_id uuid,                                   -- 削除のときに消すためだけ。外部キーなし（台帳と同じ）
  brand_ref text check (brand_ref ~ '^[a-z][a-z0-9_]{1,40}$'), -- 監査用。主体には使わない
  lifecycle_version bigint,                       -- 監査用（利用権を確かめた時点）
  claim_token uuid not null unique,               -- bridge の owner（fencing）
  state text not null check (state in ('acquired', 'complete', 'abandoned')),
  result jsonb,                                   -- BridgeResult。acquired の間は null
  audit jsonb,                                    -- 中身の無い Audit。印にするときに使う
  content_purged_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  abandoned_at timestamptz,
  constraint consumer_calls_subject check ((subject_kind = 'system' and user_id is null) or (subject_kind = 'user' and user_id is not null)),
  constraint consumer_calls_state check (
    (state = 'acquired' and result is null and completed_at is null and abandoned_at is null)
    or (state = 'complete' and result is not null and completed_at is not null and abandoned_at is null)
    or (state = 'abandoned' and result is not null and abandoned_at is not null)),
  constraint consumer_calls_result_size check (result is null or octet_length(result::text) <= 131072)
);
```

### 4.2 RPC（草案）

| RPC | 入力 | 動き |
|---|---|---|
| `ai_ledger_call_claim` | `call_key, tenant_tag, fingerprint, application, feature, subject_kind, user_id?, brand_ref?, lifecycle_version?` | `call_key` の advisory lock の中で、無ければ `acquired` で入れて `{kind: acquired, owner: claim_token}`。あれば: tenant か fingerprint が違えば `conflict`、`acquired` なら `busy`、それ以外は `{kind: complete, fingerprint, result}` |
| `ai_ledger_call_complete` | `call_key, tenant_tag, fingerprint, owner, result` | `acquired` で owner と identity が全部同じときだけ `complete` にする（`audit` も保存）。それ以外は例外（bridge は UNKNOWN にする）。同じ内容の繰り返しは成功（応答の喪失のあとの再試行） |
| `ai_ledger_call_abandon` | `call_key, audit` | 復旧・運用者: `acquired` のまま一定時間（例 30 分）を過ぎ、かつ台帳のその `call_key` の予約が全部終わっている（または無い）ものだけ、`{ok:false, code:"UNKNOWN", audit}` の印で `abandoned` にする。**送り直し・横取りはしない** |
| `ai_ledger_call_purge_content` | `older_than_hours（既定 24）, limit` | `complete` の行のうち、時間を過ぎたものの `result` を `{ok:false, code:"UNKNOWN", audit}` に置き換え、`content_purged_at` を入れる |
| `ai_ledger_forget_user` | `user_id` | 削除の手順から: その利用者の `consumer_calls` を消し、台帳の `reservations` / `usage_events` / `budget_buckets` の `user_id` を、元に戻せない新しいランダムな uuid（削除ごと）に置き換える。台帳の追記専用の trigger（`ai_ledger.reject_change` / `ai_ledger.reservation_transition`）に、この関数が取引の中だけで立てる印（`set_config(..., true)`）を見て `user_id` 列の置き換えだけを通す例外を足す。前例: POSTONA の削除の `kabumori.social_mobile_deletion_lease`（`20260928160000_social_mobile_account_deletion_candidate.sql`） |

- 印（UNKNOWN と元の監査）を bridge がそのまま受け入れること、送り直さないことは §6 のテストで確かめた（監査を壊すとテストが落ちることも確かめた）
- `complete` の結果の大きさは bridge の `maxResultBytes`（64KB まで）に合わせる

### 4.3 一連の流れ（1 回の依頼）

1. POSTONA: 本人・ワークスペース・利用権を確かめる（§3.2）
2. bridge: `claim`（acquired）
3. 共通AI基盤: `ai_ledger_reserve`（枠の判定。断られたら `BUDGET_DENIED` を `complete` して返す）
4. `ai_ledger_mark_sent`（送信の許可は 1 回だけ）
5. Anthropic へ 1 回送る
6. `ai_ledger_settle`（実額、または不明なら最大額）
7. bridge: 出力の確認 → `complete`（**ここまで終わってから**結果を返す）
8. POSTONA: 結果を今の検査に通して返す（相談は `sanitizeConsultModelOutput`）

### 4.4 止まった場所ごとの扱い

| 止まった場所 | 保存の場所 | 台帳 | 同じ operationId の再送 | 片付け |
|---|---|---|---|---|
| claim の後、reserve の前 | acquired | なし | `IN_PROGRESS` | 30 分後に abandon（費用 0 の印） |
| reserve の後、mark_sent の前 | acquired | reserved | `IN_PROGRESS` | 台帳の `recover_stale` が予約を返す → abandon |
| mark_sent の後（送信の前後）、settle の前 | acquired | sent | `IN_PROGRESS` | `recover_stale` が unknown・最大額にする → abandon（最大額の監査） |
| settle の後、complete の前 | acquired | settled / unknown | `IN_PROGRESS` | abandon（台帳の監査）。出力は失われる |
| complete は書けたが応答が失われた | complete | 終わっている | 保存した結果 | なし |
| 504・時間切れ・切断 | complete（UNKNOWN） | unknown・最大額 | UNKNOWN | なし（送り直さない） |
| 上限 | complete（BUDGET_DENIED） | 予約なし | BUDGET_DENIED | なし（次の日は新しい operationId） |

- 同時の 2 つの依頼: `claim` の lock で 1 つだけが acquired、もう 1 つは `IN_PROGRESS`（§6 で確認）
- 同じ operationId で中身が違う: `CONTENT_DRIFT`（§6 で確認）
- `recover_stale` と `call_purge_content` / `call_abandon` を動かす Cron は、本番の変更なので別承認

### 4.5 監査と請求の確かめ

- `consumer_calls.call_key` = `reservations.request_id` = `usage_events.request_id` でつながる
- 請求が分からない分（unknown・最大額）は、台帳では最大額のまま（書き換えない）。月ごとに Anthropic の請求の数字を `billing_observations` に記録して、最大額の合計と比べる。台帳の数字は直さない

### 4.6 アカウント削除

- 共通アカウントの削除の手順（F5 / G5 の担当）に、サービスの削除の後・ログインの削除の前の 1 段として `ai_ledger_forget_user` を足す
- `private.account_lifecycle_footprint` / `residue` の確認に、`consumer_calls` に行が残っていないこと、台帳にその利用者 ID が残っていないことを足す
- POSTONA だけの削除（ログインは残す）でも、`consumer_calls` の出力は 24 時間で消える。台帳の利用者 ID を残すか消すかは、保持期間の決まりと合わせて決める（未決）

## 5. 機能ごとの変更・担当・順番

| 段 | 何を | 担当（案） | 依存 | オフラインのテスト | 本番の前の確認 |
|---|---|---|---|---|---|
| 0 | F6 / H5 の stack を順に merge（#187 → … → #239 → この PR） | 利用者の承認 | なし | 済み | なし（何もつながっていない） |
| 1 | 台帳の migration の候補: `consumer_calls`・5 つの RPC・権限の確認・`forget_user`。ローカルの PG で証明 | F6 | 段 0 | ローカルの PG の証明（並行・重複・止まった場所・権限） | 独立のレビュー、本番の適用は別承認 |
| 2 | 保存の場所の TS の実装（`ConsumerCallStore` を RPC で） | H5 か F6（bridge の持ち主と決める） | 段 1 | このテストの参照の実装と同じ振る舞い | 同上 |
| 3 | ブランド → owner → 利用権の service role の RPC、削除の手順への `forget_user` | F5 | 段 1 | ローカルの PG | Auth・他の利用者の独立のレビュー |
| 4 | AI 相談をフラグでつなぐ。アプリに operationId と `CONSULT_QUOTA_EXCEEDED`。F6 の isolation の許可と H5 の検査を同時に | POSTONA（F3 系統）＋ F6 ＋ H5 | 段 1・2、F4 の完了、§3 の判断（個人情報・告知） | 今の相談のテスト＋ Claude の偽物 | 枠の追加（DB）、有料の品質の確認、フラグ |
| 5 | 試し投稿 | POSTONA | 段 4 | 同上 | 同上 |
| 6 | 会社員AIらぼ（system） | POSTONA / X | 段 4、`x-test-post` の deploy の範囲 | 今の会社員AIらぼのテスト | 同上 |
| 7 | 利用者のブランドの予約投稿 | POSTONA / X | 段 3・6 | 今の予約投稿のテスト | 同上 |

最小の独立の作業の案（推奨のモデル）:

1. **F6: 台帳の migration の候補とローカルの PG の証明**（Opus 5.5（高））→ 独立のレビュー（Sol（高））
2. **H5 か F6: 保存の場所の TS の実装**（Opus 5.5（高））
3. **F5: ブランドの owner と利用権の RPC、削除の手順への組み込み**（Opus 5.5（高））→ Auth のレビュー
4. **POSTONA: 相談の Claude の経路（フラグ、既定は OpenAI）**（Opus 5.5（高））
5. **運用・利用者: 決まりの調整とプライバシーの告知、有料の品質の確認の承認**

## 6. 確かめたこと（この PR）

- `postona_call_store_contract_test.ts`（オフライン、偽の鍵、`--deny-net`）: §4 の保存の場所の決まりを参照の実装で表し、**本物の H5 bridge** と組み合わせて確かめる
  1. 1 回の依頼に 1 つの claim。同じ operationId の再送は、保存した結果を返して送らない
  2. 同時の 2 つの依頼: 送信は 1 回、もう 1 つは `IN_PROGRESS`
  3. 同じ operationId で中身が違うと `CONTENT_DRIFT`。別の利用者の同じ operationId は別の呼び出し
  4. `complete` の応答が失われた: 書く前なら処理中のまま → 復旧の印で閉じると UNKNOWN で、送り直さない。書いた後なら保存した結果を返す
  5. 出力を 24 時間で印に置き換えても、bridge は印をそのまま受け入れ（元の監査のまま）、送り直さない。出力は残らない
  - 印の監査をわざと壊した写しでは、4 と 5 のテストが落ちる（「受け入れた」と「形が違うとして弾いた」を見分けられる）
- 共通AI基盤 158 PASS（このテストの 5 件を含む）、H5 bridge 27 PASS、市況レポート 324 PASS

## 7. 未決と NOT_VERIFIED

- 未決: 枠の数字、POSTONA 全体の上限を台帳で持つか（上限専用の枠。台帳の migration の変更）、AI を別の有料の追加にするか（新しい `service_key`）、ブランドごとの上限が要るか（案 B）、保存の場所の TS の実装の担当、台帳の利用者 ID の保持期間と POSTONA だけの削除のときの扱い、`complete` の結果の保持時間（24 時間の案）
- NOT_VERIFIED: 今の本番の台帳の行、本番の `brands` の定義（migration に無い）、#238 の後の利用権のふるまい、F5 の `4638891f` の RPC の中身、Anthropic のデータの保持の条件、実際の請求
