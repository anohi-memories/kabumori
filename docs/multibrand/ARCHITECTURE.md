# X自動投稿 複垢化（マルチブランド）正式アーキテクチャ設計

- task_id: `x-multibrand-architecture-design-20260910`
- 作成: 2026-09-10 / Claude slot 2（Opus）
- 前提資料: [README.md](README.md), [SURVEY.md](SURVEY.md)
- 照合したコード: `origin/main` `dad3868` 時点の `supabase/functions/**`, `supabase/migrations/**`, `apps/admin/src/lib/actions/system-toggle.ts`
- 状態: **設計のみ。実装・本番変更・認証接続は未実施。ChatGPT側の判断（§20）を経てから Phase 1 に着手する。**

初期対象ブランド: `kabumori`（かぶモリ・本番稼働中） / `ai_salaryman_lab`（会社員AIラボ） / `mio`（みお）

---

## 0. この設計の要約

1. **1本の共通パイプライン＋行ごとのブランド文脈**。ブランドごとにCronやEdge Functionを増やさない。全ての投稿行（予定・実行・履歴・重複防止）に `brand_id` を持たせ、処理の入口で一度だけ `BrandContext` を解決し、最後まで明示的に引き回す。
2. **既存データは列デフォルトで自動的に `kabumori`**。`brand_id text not null default 'kabumori'` の列追加はPostgreSQL 11以降ではメタデータ変更のみで、既存行の大量UPDATEもテーブル書き換えも発生しない。
3. **新ブランドは3重のゲートで既定OFF**（ブランド・SNSアカウント・投稿種別）。さらに新ブランドは `publish_mode='dry_run'` から始め、`live` への切替は明示操作のみ。
4. **Xトークンは新テーブル `social_account_tokens` に分離**し、既存 `oauth_token_store`（1行・かぶモリ専用）には新アカウントを一切書き込まない。旧コードの `provider=eq.x&limit=1` が別ブランドのトークンを掴む事故を構造的に防ぐ。
5. **重複防止は4層に分離**：①ブランド内の同一投稿防止 ②ブランド内のネタ再利用防止 ③アカウント単位のクールダウン ④**ブランド横断の類似投稿防止**（X自動化ルール対策、fail-closed）。
6. **プロンプト・文体はコード管理（git＋テスト）、運用ノブはDB管理**。
7. 移行は **expand → コード切替 → contract** の3段階。contract（旧制約の削除）はかぶモリの完全互換を確認してから。

---

## 1. 推奨アーキテクチャ

### 1.1 比較した方式

| 方式 | 概要 | 評価 |
|---|---|---|
| A. ブランドごとに複製 | Edge Function・Cron・テーブルをブランドごとにコピー | ✕ 修正がN倍、1ブランドだけ古いバグが残る。ブランド追加のたびに本番構成が増える |
| B. ブランドごとにSupabaseプロジェクト | 完全分離 | ✕ 新規プロジェクト作成は禁止。運用・費用・Secret管理がN倍 |
| **C. 共通パイプライン＋`brand_id`（推奨）** | 1つのコードとCronが、有効なブランドの行だけを処理する | ◎ ブランド数に比例して増えるのは「データ行」だけ。既存かぶモリの経路をそのまま拡張できる |

### 1.2 全体像

```
pg_cron（既存ジョブ名・既存時刻のまま）
  └─ dispatch-scheduled-posts（毎分）
        └─ x-test-post
              ├─ claim_due_post()          … 有効ブランドの予定だけを計画・取得（行にbrand_id）
              ├─ resolveBrandContext(row)  … brands / brand_settings / social_accounts / コード側プロファイル
              ├─ generate(ctx, post_type)  … ctx.voice / ctx.hashtags / ctx.prompts を使用
              ├─ guardBeforePublish(ctx)   … ゲート・アカウント照合・横断類似チェック（fail-closed）
              ├─ publish(ctx.xAuth)        … social_account_tokens から該当アカウントのみ
              └─ complete_*(…)             … brand_id付きで履歴・claim・fingerprintを記録
  └─ important-news-*（4本）… Phase 2〜4 は kabumori 専用のまま（§5.3）
```

### 1.3 設計原則

- **fail-closed**: ブランド文脈が解決できない・未知の `brand_id`・ゲートが読めない・類似チェックがエラー、のいずれでも「投稿しない」。
- **ブランドは明示引数**: モジュールレベルの「かぶモリ定数」を投稿経路で直接参照しない。`kabumori` 固有値は `BrandCodeProfile` の1エントリへ移す。
- **1ブランドの設定変更が他へ波及しない**: 設定は `(brand_id, …)` をキーとする行単位。グローバル設定は「全ブランド停止」のキルスイッチのみ。
- **過剰設計しない**: Instagram/Threads/Miseiro用のテーブル・コードは作らない。`platform` 列を持たせて将来の余地だけ残す。

---

## 2. brand / account モデル

### 2.1 責務

| 概念 | 何を表すか | 例 |
|---|---|---|
| `brand` | 人格・ブランド（キャラクター、文体、テーマ、ネタ在庫、画像方針の単位） | `kabumori`, `ai_salaryman_lab`, `mio` |
| `social_account` | 特定SNS上の1アカウント（認証・投稿先・レート制御の単位） | `kabumori:x`, `mio:x`（将来 `mio:instagram`） |

- 1ブランド : N アカウント（将来、1ブランドがX＋Threadsを持つ）。
- 現段階は **`unique(brand_id, platform)`**（1ブランドにつきXアカウントは1つ）。同一ブランド複数X垢は需要が出るまで作らない。
- `brand_id` は人が読める **text スラッグ**を主キーにする（UUIDにしない）。理由: 既存行の `default 'kabumori'` が素直に書ける、ログ・管理画面・SQLで読める、ブランド数は少ない。

### 2.2 テーブル定義案

```sql
create table public.brands (
  id text primary key check (id ~ '^[a-z][a-z0-9_]{1,40}$'),
  display_name text not null,
  is_active boolean not null default false,          -- ゲート①
  publish_mode text not null default 'disabled'
    check (publish_mode in ('disabled', 'dry_run', 'live')),
  code_profile_key text not null,                    -- コード側 BrandCodeProfile のキー
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.social_accounts (
  id text primary key,                               -- 例 'kabumori_x'
  brand_id text not null references public.brands(id),
  platform text not null check (platform in ('x')),  -- 将来 'instagram','threads' を追加
  handle text not null,                              -- 表示用 @名（秘密情報ではない）
  platform_user_id text,                             -- X user id。トークン取込時に検証して確定
  publish_enabled boolean not null default false,    -- ゲート②
  min_post_interval_minutes integer not null default 30,
  daily_post_cap integer not null default 12,
  oauth_client_ref text not null default 'default',  -- どのX Appの認証情報を使うか（§8）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, platform)
);
```

初期データ（migrationで投入）:

| brands.id | is_active | publish_mode | social_accounts | publish_enabled |
|---|---|---|---|---|
| `kabumori` | **true** | **live** | `kabumori_x` | **true** |
| `ai_salaryman_lab` | false | disabled | `ai_salaryman_lab_x` | false |
| `mio` | false | disabled | `mio_x` | false |

かぶモリだけが現状の挙動を保つ。新ブランドは行が存在しても何も起きない。

---

## 3. DB変更案

### 3.1 共通ルール

- 追加するのは **`brand_id text not null default 'kabumori' references brands(id)`**。定数デフォルトの列追加は既存行を書き換えない（PG11+のfast default）。
- 外部キーは `brands` 行投入後に付ける（同一migration内で `brands` を先に作成・投入）。
- 一意制約は **「新制約を追加 → コード切替 → 旧制約削除」** の順（§13）。`default 'kabumori'` なので既存行は旧制約を満たす＝新制約（brand_idを含む）も必ず満たす。
- インデックスは `(brand_id, 既存の検索キー)` を追加。対象テーブルは小さい想定だが、Phase 2 着手前に行数を read-only で確認し、大きい場合は `create index concurrently` を単独migrationに分ける。

### 3.2 新規テーブル

| テーブル | 用途 |
|---|---|
| `brands` | ブランド定義・ゲート①・publish_mode |
| `social_accounts` | SNSアカウント・ゲート②・クールダウン・日次上限 |
| `social_account_tokens` | 暗号化トークン（§8）。service_roleのみ |
| `brand_settings` | ブランド単位の運用ノブ（ハッシュタグ、note導線、画像方針、各post_typeの有効/頻度） |
| `published_content_fingerprints` | 投稿済み内容の指紋。ブランド内・ブランド横断の類似判定（§9） |
| `system_flags` | グローバルキルスイッチ `multibrand_publish_enabled`（1行） |

```sql
create table public.brand_settings (
  brand_id text primary key references public.brands(id),
  hashtags text[] not null default '{}',            -- 形式・個数はコードで検証
  note_url text,                                     -- note導線（nullなら出さない）
  note_link_every_n_posts integer,                   -- 何投稿に1回導線を入れるか
  image_policy jsonb not null default '{}'::jsonb,   -- §11
  enabled_post_types text[] not null default '{}',   -- ゲート③の上位（空=何も計画しない）
  updated_at timestamptz not null default now()
);

create table public.published_content_fingerprints (
  id bigint generated always as identity primary key,
  brand_id text not null references public.brands(id),
  social_account_id text not null references public.social_accounts(id),
  post_type text not null,
  x_post_id text,
  normalized_text_sha256 text not null,              -- 正規化本文の完全一致判定
  simhash64 bigint not null,                         -- 近似重複判定（ハミング距離）
  source_urls text[] not null default '{}',          -- 正規化済み出典URL
  topic_key text,                                    -- ネタID（tip id / news candidate id 等）
  published_at timestamptz not null default now()
);
create index on public.published_content_fingerprints (published_at desc);
create index on public.published_content_fingerprints (normalized_text_sha256);
create index on public.published_content_fingerprints using gin (source_urls);
```

---

## 4. 既存テーブルごとの変更方針

凡例: **B** = `brand_id` 追加（default 'kabumori'）、**U** = 一意制約に `brand_id` を含める、**S** = シングルトン設定の多行化、**共有** = 変更しない

| テーブル | 方針 | 詳細 |
|---|---|---|
| `posting_windows` | B, U | `unique(post_type, slot_no)` → `unique(brand_id, post_type, slot_no)`。新ブランドの行は `is_active=false` で作成（ゲート③） |
| `scheduled_posts` | B, U | `unique(schedule_date, post_type, slot_no)` → `+brand_id`。`claim_due_post()` が返す行にbrand_idが載る |
| `post_execution_logs` | B | 全ログにブランドを付与。管理画面・除外ログ（`PROJECT_RULES.md` 候補選定ルール）もブランド別に追える |
| `publish_claims` | B, U | `unique(post_type, date_jst)` → `unique(brand_id, post_type, date_jst)`。「1日1回保証」をブランド単位に |
| `morning_report_runs` / `close_report_runs` / `us_premarket_report_runs` / `important_news_monitor_runs` | B | 実行記録にブランドを付与 |
| `morning_report_settings` / `close_report_settings` / `us_premarket_report_settings` / `useful_tip_schedule_settings` / `important_news_monitor_settings` | S | §4.1 |
| `tips` / `useful_tips` / `interaction_topics` | B | **ネタ在庫はブランドが所有**する（テーマが違うため共有しない）。`last_used_at` / `use_count` / `cooldown_days` は行に残したままで、行自体がブランド別なので再利用制御も自動的にブランド別になる。`interaction_topics.title unique` → `unique(brand_id, title)` |
| `interaction_post_metrics` | B | `unique(x_post_id)` は全体一意のままで正しい（X上のIDは全体一意） |
| `important_news_candidates` | B | Phase 2〜4 は kabumori 専用（§5.3）。列だけ追加し、`x_post_id` unique は全体一意のまま |
| `oauth_token_store` | **変更しない（凍結）** | §8.3。新アカウントは書き込まない。Phase 2 でかぶモリの読込元を `social_account_tokens` へ移し、フォールバック元としてのみ残す |
| `posting_blackouts` | B（nullable） | `brand_id null` = 全ブランド共通の停止帯、値あり = そのブランドだけ |
| `market_holidays` | 共有 | 市場休日は全ブランド共通 |
| `market_contexts` / `useful_tip_verifications` / `important_news_company_ir_sources` | 共有 | 事実データ・取得元。生成物ではないので共有して良い |
| `admin_users` | 変更しない | ブランド別権限は将来 `admin_user_brands` を別途追加（§12） |
| アプリ系（`profiles` / `tracked_stocks` / `stocks_master` / `alert_settings` / `notifications` / `device_push_tokens`） | 対象外 | かぶモリアプリ専用。複垢化に混ぜない |

### 4.1 シングルトン設定テーブルの多行化（S）

現状 `id boolean primary key default true check (id)` の1行。既存コード（`important-news-monitor` の `?id=eq.true`、管理画面 `system-toggle.ts` の `.eq("id", true)`）が「id=true の行＝設定」と読んでいる。

**推奨: 互換を保つ in-place 多行化**

```sql
alter table public.close_report_settings add column brand_id text not null default 'kabumori'
  references public.brands(id);
alter table public.close_report_settings add constraint close_report_settings_brand_uidx unique (brand_id);
-- 旧コードが読む id=true は「かぶモリ行」の意味として残す
alter table public.close_report_settings drop constraint close_report_settings_pkey;
alter table public.close_report_settings drop constraint close_report_settings_id_check;
alter table public.close_report_settings alter column id drop not null, alter column id drop default;
alter table public.close_report_settings add constraint close_report_settings_legacy_id_check
  check (id is null or (id = true and brand_id = 'kabumori'));
create unique index close_report_settings_legacy_id_uidx on public.close_report_settings (id) where id;
alter table public.close_report_settings add primary key (brand_id);
```

- かぶモリ行は `id=true` のまま → 旧コードの読み書きは無変更で動く。
- 新ブランド行は `id=null`、`is_active=false` で作成 → 旧コードからは見えない。
- 旧コードを全て `brand_id` 指定に切り替えた後（Phase 2完了後）、`id` 列を削除（contract）。

代替案（新テーブル `brand_post_type_settings` へ集約）は §20 の判断事項。

---

## 5. Edge Functions 変更案

### 5.1 共通モジュール（新規 `supabase/functions/_shared/brand/`）

| ファイル | 内容 |
|---|---|
| `brand_context.ts` | `resolveBrandContext(brandId)` → `BrandContext`。DB（brands / brand_settings / social_accounts）＋コード側 `BrandCodeProfile` を合成。未知ID・非活性は例外 |
| `brand_profiles.ts` | `BRAND_CODE_PROFILES: Record<BrandId, BrandCodeProfile>`。文体・ペルソナ・プロンプト断片・固定ハッシュタグ検証規則・Voice checkerの指示文 |
| `publish_guard.ts` | 投稿直前ゲート（§16）。純粋関数＋DB読込の薄い層。全チェックが通らなければ投稿しない |
| `content_fingerprint.ts` | 本文正規化・SHA-256・simhash64・出典URL正規化（純粋関数、単体テスト容易） |
| `storage_paths.ts` | `brandAssetPath(ctx, kind, name)`。brandId無しでパスを作れないAPIにする |

```ts
type BrandContext = {
  brandId: BrandId;
  socialAccountId: string;
  publishMode: "dry_run" | "live";      // disabled はここに到達しない
  profile: BrandCodeProfile;             // コード管理（文体・プロンプト）
  settings: BrandSettingsRow;            // DB管理（ハッシュタグ・note・画像方針）
  account: SocialAccountRow;             // 投稿先・クールダウン・上限
};
```

### 5.2 `x-test-post`

1. `claim_due_post()` の戻り行の `brand_id` から `BrandContext` を解決（1回だけ）。
2. `post_type` 分岐（`index.ts` の morning_report / close_report / us_premarket_report / useful_tip / morning_greeting / interaction / tip）は**そのまま**。各分岐の生成関数に `ctx` を渡す。
3. `KABUMORI_VOICE`・`kabumoriImportantNewsVoice`・`KABUMORI_REPORT_FIXED_HASHTAG_LIST`・`morning_greeting_logic.ts` の `#かぶモリ` を `ctx.profile` / `ctx.settings` 参照へ置換。かぶモリの値は `BRAND_CODE_PROFILES.kabumori` にバイト一致で移す（§18でスナップショット比較）。
4. **`index.ts` 内の重複 `loadXTokens`（約3008行目）を削除し `_shared` に一本化**。現在トークン読込実装が2つあり、ブランド対応を片方だけに入れる事故が起こりうる。
5. XAuthは `ctx.socialAccountId` から構築（§8）。
6. 投稿直前に `guardBeforePublish(ctx, candidateText)`。
7. 完了RPCへ `brand_id` と fingerprint を渡す。
8. dry-run系 mode は `brand_id` 引数を受け付け、省略時は `kabumori`（既存の呼び出しと互換）。

### 5.3 `important-news-monitor`

- 株式市場ニュースはかぶモリの事業領域。会社員AIラボ・みおが株ニュースを投稿する前提は無いので、**Phase 2〜4 は `kabumori` 固定**とし、列追加とトークン読込の `social_account_tokens` 化だけ行う。
- 将来、別ブランドがニュース系投稿を持つ場合に初めて「共有ニュース素材（事実）」と「ブランド別投稿（生成文・x_post_id）」を分割する。今は分割しない（過剰設計回避）。

### 5.4 `send-push-notifications` / 銘柄マスタ系

対象外。変更しない。

---

## 6. RPC 変更案

| RPC | 変更 |
|---|---|
| `plan_daily_posts` / `plan_morning_report` / `plan_close_report` / `plan_us_premarket_report` / `plan_weekly_useful_tips` | 有効ブランド（`brands.is_active` かつ `publish_mode <> 'disabled'` かつ `social_accounts.publish_enabled` かつ `system_flags.multibrand_publish_enabled`、ただし kabumori は後述の互換条件）ごとに、そのブランドの `posting_windows` / 設定行を使って計画。`on conflict` キーに `brand_id` を含める |
| `claim_due_post()` | **引数なしのシグネチャを維持**（Cronのコマンドを変えないため）。内部で上記ゲートを再確認して1行claim。戻り行に `brand_id` が含まれる（`setof scheduled_posts` なので列追加で自動的に載る） |
| `complete_*_post` / `fail_scheduled_post` / `retry_scheduled_post` | `scheduled_posts.brand_id` を参照して `post_execution_logs` / `publish_claims` / fingerprint を記録。引数は増やさない（行から導出） |
| `mark_tip_used` | 変更不要（在庫行がブランド所有のため） |
| 新規 `record_published_fingerprint(...)` | fingerprint記録（complete系から呼ぶか、Edge Functionから呼ぶ） |
| 新規 `check_cross_brand_similarity(...)` | §9.4。SQL側でsimhashのハミング距離を計算する場合 |

**kabumori の互換条件**: Phase 2 では `system_flags.multibrand_publish_enabled` が false でも kabumori は従来通り動かす（キルスイッチは新ブランドだけを止める）。全ブランド停止スイッチは別に `brands.is_active` で行う。これにより「複垢基盤の不具合で本番かぶモリが止まる」事故を避ける。

**claim の公平性**: 1回の呼び出しで1行claim、`order by scheduled_for` のまま。3ブランド合計でも1日数十件の想定なので毎分1件で足りる。同一分に複数ブランドが重なった場合は1分ずつ遅れる（§7.3のずらし方針と整合）。

---

## 7. Cron 設計

### 7.1 比較

| 方式 | 利点 | 欠点 |
|---|---|---|
| ブランドごとにCronを増やす（例 `dispatch-scheduled-posts-mio`） | 分離が直感的 | ブランド追加のたびに本番Cron変更。Cron定義がmigration外で作られている現状では管理不能になりやすい。同じclaim関数を並行に叩き競合が増える |
| **共通dispatcher（推奨）** | Cron本数・時刻・コマンドが不変。ブランド追加はデータ行の追加だけ | dispatcher不具合が全ブランドに波及 → fail-closedとゲートで緩和 |

### 7.2 方針

- 既存8本（X関連5本）の **ジョブ名・スケジュール・コマンドを一切変えない**。
- `dispatch-scheduled-posts`（毎分）→ `claim_due_post()` が有効ブランドを横断して処理。
- `important-news-fetch/judgement/generation/publish-ready` → kabumori専用のまま（§5.3）。
- **前提作業（Phase 1）**: Cron 1〜4 はmigrationファイルに存在しない（本番で手動作成された）。本番の `cron.job` を read-only で取得し、定義をリポジトリに記録してから触る。`important-news-publish-ready` を作成したmigrationが共有チェックアウトで削除状態になっている件も同様に別タスクで整理する。

### 7.3 ブランド間の投稿時刻

- 同一分・同一App（§8）から複数アカウントが連続投稿すると協調行動に見えるリスクがあるため、**ブランド間の予定は最低N分（初期値10分、`brand_settings` で調整）ずらす**制約を planner に持たせる（既存の `plan_us_premarket_report` の ±20分衝突回避と同じ考え方）。
- かぶモリの既存時刻は動かさない。新ブランド側が避ける。

---

## 8. X複数アカウント認証管理

### 8.1 現状（照合済み）

- `_shared/x_oauth2_post.ts`: `oauth_token_store` を `provider=eq.x&limit=1` で読み、`SHA-256(X_CLIENT_SECRET)` 由来の鍵で AES-GCM 復号。無ければ `X_OAUTH2_*` にフォールバック。更新時は `on_conflict=provider` で上書き。
- `x-test-post/index.ts` にも同等の `loadXTokens` が別実装で存在（§5.2-4）。
- `oauth_token_store`: `provider text primary key` かつ `check (provider = 'x')` → 構造上1アカウント。
- 初回OAuth認可フロー（PKCE・callback）はリポジトリに無い。
- 旧OAuth1系Secret 4つは未使用（削除は別タスク。今回は触らない）。

### 8.2 役割分担

| 置き場所 | 置くもの | 置かないもの |
|---|---|---|
| Supabase Secrets | X Appの `client_id` / `client_secret`（Appごと）、トークン暗号鍵 `SOCIAL_TOKEN_ENCRYPTION_KEY`（鍵バージョン付き） | ユーザートークン（増減・更新が頻繁なため不適） |
| DB `social_account_tokens` | ユーザーアクセストークン／リフレッシュトークンの**暗号文**、IV、鍵バージョン、期限、`platform_user_id`、付与scope | 平文トークン |
| Edge Function | 復号・更新・再暗号化・投稿。復号は投稿直前のみ、メモリ上だけ | ログ出力（トークン・暗号文・鍵を一切出さない） |

```sql
create table public.social_account_tokens (
  social_account_id text primary key references public.social_accounts(id),
  access_token_ciphertext text not null,
  access_token_iv text not null,
  refresh_token_ciphertext text not null,
  refresh_token_iv text not null,
  key_version integer not null,
  granted_scopes text[] not null default '{}',
  platform_user_id text not null,        -- 取込時に /2/users/me で確認した値
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.social_account_tokens enable row level security;
revoke all on public.social_account_tokens from anon, authenticated;
grant select, insert, update on public.social_account_tokens to service_role;
```

### 8.3 暗号鍵とApp

- **鍵**: 現行の `SHA-256(X_CLIENT_SECRET)` 由来は「App secretをローテーションすると全トークンが復号不能」「Appを分けると鍵が分散」という問題があるため、専用Secret `SOCIAL_TOKEN_ENCRYPTION_KEY_V1` を新設し `key_version` で世代管理する。かぶモリの既存暗号文は旧鍵で復号できるよう、Phase 2 の移行で「旧鍵で復号→新鍵で再暗号化して `social_account_tokens` へ保存」を1回だけ行う（`oauth_token_store` は書き換えない）。
- **App**: `social_accounts.oauth_client_ref` で「どのAppの `client_id/secret` を使うか」を指定（Secret名は `X_CLIENT_ID__<REF>` 形式、`default` は既存の `X_CLIENT_ID`）。単一App共有かブランド別Appかは §20 の判断事項だが、どちらでも同じコードで動く。

### 8.4 アカウント取り違え防止（アカウント結合検証）

1. トークン取込時に `GET /2/users/me` を呼び、返った user id を `social_accounts.platform_user_id` と照合。**未設定なら確定、設定済みで不一致なら取込拒否**。
2. 投稿時に `ctx.account.platform_user_id === token.platform_user_id` を確認（DB上の値同士の比較なので追加API呼出し不要）。
3. これにより「かぶモリのトークンがみおの行に入った」「逆」を投稿前に検出する。

### 8.5 初回認可（新アカウント接続）の導線

- ユーザー本人が各アカウントでPKCE認可を行う必要がある（コードで自動化できない）。
- scope: `tweet.read tweet.write users.read offline.access media.write`（2026-09-08の `media.write` 不足インシデントの教訓を反映）。
- 導線案: 管理画面の管理者専用ページ（`admin_users` 認証済み）から `social_account_id` を指定して認可開始 → callbackをEdge Function（管理者セッション検証付き）で受け、サーバー側で暗号化保存。**トークンがチャット・ローカルファイル・ログを経由しない**。
- この導線の実装は §17 の Phase 3 前半。本設計承認前は接続しない。

### 8.6 旧経路の扱い

- `oauth_token_store`: 新アカウントは**絶対に書き込まない**。旧コードが `limit=1` で読むため、2行目が入った瞬間に取り違えが起こりうる。
- `X_OAUTH2_*` 環境変数フォールバック: `brand_id='kabumori'` の時だけ許可。他ブランドでトークン行が無ければ投稿せず失敗（fail-closed）。

---

## 9. 重複防止設計（4層）

| 層 | 目的 | 単位 | 仕組み |
|---|---|---|---|
| ① 同一投稿防止 | 同じ予定・同じ日の二重投稿を防ぐ | ブランド | `publish_claims unique(brand_id, post_type, date_jst)`、`scheduled_posts unique(brand_id, schedule_date, post_type, slot_no)`、`important_news_candidates.x_post_id` 全体一意（既存） |
| ② ネタ再利用防止 | 同じtip・話題の短期再利用を防ぐ | ブランド | 在庫行がブランド所有＋既存 `last_used_at` / `cooldown_days`（既存ロジック無変更で機能） |
| ③ クールダウン・投稿制御 | 連投・過剰投稿を防ぐ | アカウント | `social_accounts.min_post_interval_minutes` / `daily_post_cap`、`posting_blackouts`（ブランド別/共通） |
| ④ ブランド横断類似防止 | **複数アカウントで同一・酷似内容を投稿しない**（X自動化ルール・凍結対策） | 全ブランド横断 | `published_content_fingerprints`＋投稿直前チェック |

### 9.4 ブランド横断類似チェック（④）の判定

投稿直前、直近 `N=30日` の**他ブランド**の投稿に対して:

1. 正規化本文（空白・絵文字・ハッシュタグ・URL・記号除去、NFKC、小文字化）の SHA-256 が一致 → **拒否**
2. 正規化出典URLのいずれかが一致し、かつ投稿時刻差が72時間以内 → **拒否**（同じ記事を複数ブランドで同時期に扱わない）
3. simhash64 のハミング距離 ≤ 閾値（初期値8、§20で決定）→ **拒否**
4. `topic_key`（tip id・候補id等）が一致 → **拒否**（在庫をブランド共有しない方針なので通常起きないが、将来の共有素材への保険）

- 判定・DB読込が失敗したら**投稿しない**（fail-closed）。拒否は `post_execution_logs` に理由付きで記録（`PROJECT_RULES.md` の除外ログ要件）。
- 同じ判定をブランド内（自分自身の過去投稿）にも弱い閾値で適用可能だが、既存の①②で足りるため Phase 2 では横断のみ。
- LLM埋め込みによる意味的類似判定は将来の拡張余地として残し、Phase 3〜4は決定的な手法（ハッシュ・simhash）だけで始める（再現性・テスト容易性・費用の観点）。
- 横断チェックは Phase 2（かぶモリのみ）の時点で**記録だけ**開始し（fingerprint蓄積）、判定は2ブランド目追加時に有効化する。

---

## 10. プロンプト／ブランド設定管理

### 10.1 境界

| 管理場所 | 対象 | 理由 |
|---|---|---|
| **コード（git＋テスト）** `_shared/brand/brand_profiles.ts` | ペルソナ、文体（現 `kabumori_voice.ts`）、生成プロンプト断片、Voice checker指示、禁止表現、固定ハッシュタグの検証規則 | X規約・誤情報に直結し、既存のVoice gateテストで守られている。DBで気軽に書き換えるとレビュー・テストを迂回できてしまう |
| **DB** `brand_settings` / `posting_windows` / 各設定行 | ON/OFF、投稿時刻、頻度、ハッシュタグの値、note URL・頻度、画像方針フラグ、クールダウン値 | 運用で頻繁に変える。管理画面から変えたい |

- DBの `brands.code_profile_key` がコード側プロファイルを指す。**コードに無いキーは起動時・解決時に例外**（fail-closed）。
- ハッシュタグは値をDB、形式検証（個数上限・`#`始まり・重複禁止・禁止語）をコードで行う。
- かぶモリ固有文字列の移設先（照合済みの箇所）:
  - `_shared/kabumori_voice.ts` → `BRAND_CODE_PROFILES.kabumori.voice`
  - `x-test-post/fixed_hashtags_logic.ts`（`#日本株 #日経平均 #株式投資 #かぶモリ`）→ `brand_settings.hashtags`（kabumori行）＋検証はコード
  - `x-test-post/morning_greeting_logic.ts`（`#かぶモリ` 等）→ 同上
  - `important-news-monitor/post_generation_logic.ts`（Voice checker文面「あなたはかぶモリ投稿の…」）→ `profile.voiceCheckerInstruction`
  - `x-test-post/index.ts` 内のプロンプト（約14箇所）→ `profile.prompts.<post_type>`

### 10.2 ブランド固有生成ルール

`BrandCodeProfile.postTypes` に、そのブランドが扱う post_type と各生成器の設定を定義する。**プロファイルに無い post_type はそのブランドでは計画も生成もしない**（例: みおに close_report は無い）。

---

## 11. Storage／画像分離

- **既存 `morning-greeting-assets` はかぶモリ専用として無変更**（`generated/<date>.png`、`published/<date>.json`、`canonical/yume-reference.png` の既存パスを維持）。
- 新ブランドは新バケット `brand-assets`（private）を使い、パスを `<brand_id>/<kind>/<name>` とする。`kind` は `generated` / `published` / `canonical` / `test-output`。
- パス生成は `brandAssetPath(ctx, kind, name)` のみ（brandIdなしで組み立てるAPIを作らない）。
- `brand_settings.image_policy` 例:

| ブランド | 方針（想定・要確認） |
|---|---|
| kabumori | 朝の挨拶のみ画像（既存）。基準画像 `yume-reference` |
| ai_salaryman_lab | 原則テキスト。図解画像は将来 |
| mio | **画像中心**。キャラクター一貫性のための基準画像を複数（表情・服装）持つ、AI生成表示（`made_with_ai`）を必須、実在人物に似せない規則をコード側で持つ |

- みおは画像運用が他と大きく異なるため、画像生成・基準画像管理は `BrandCodeProfile.imageGenerator` として差し替え可能にし、かぶモリの朝の挨拶ロジックを流用しない。

---

## 12. 管理画面互換

- 今回は実装しない。DB/APIだけ後付けしやすくする。
- `system-toggle.ts` の `TOGGLE_CONFIG` は `.eq("id", true)` と `posting_windows.post_type` 単位で更新している。多行化後は `(brand_id, key)` を受け取る形に変える。移行期は `brand_id` 省略時に `kabumori` とみなす（§4.1 の `id=true` 互換と同じ考え方）。
- `post-history.ts` / `recent-failures.ts` / `today-scheduled-posts.ts` は `brand_id` 列を select に追加し、ブランドフィルタを後付けする。
- ブランド別の管理権限が必要になったら `admin_user_brands(admin_user_id, brand_id)` を追加（今は作らない）。

---

## 13. 後方互換性

| 保証すること | 手段 |
|---|---|
| かぶモリの投稿時刻・内容・頻度が変わらない | 既存行は `default 'kabumori'`、Cron不変、プロファイル移設はバイト一致、§18のスナップショットテスト |
| 旧コード（未切替のEdge Function）が動き続ける | 列追加のみ・`id=true` 互換・`claim_due_post()` シグネチャ不変・`oauth_token_store` 不変 |
| 旧コードが新ブランドのデータを誤って拾わない | 新ブランド行は全て非活性・`id=null`、新アカウントのトークンは別テーブル |
| 管理画面が動き続ける | 旧の `id=true` / `post_type` 単位更新がかぶモリ行だけに当たる |

**重要な順序制約**: 新ブランドの `posting_windows` / `scheduled_posts` 行は、**`claim_due_post()` と全Edge Functionがブランド対応版にdeployされた後**でなければ作らない。旧 `claim_due_post()` はbrand_idを見ないため、新ブランドの予定行を claim して **かぶモリのトークンで投稿してしまう**。

---

## 14. migration 方針

- **expand（Phase 2a）**: 新テーブル作成、`brands` / `social_accounts` 初期投入、既存テーブルへの `brand_id` 列追加（default付き）、新しい一意インデックス追加。旧制約は残す。コードは旧のまま動く。
- **code switch（Phase 2b）**: Edge Function・RPCをブランド対応版へ。かぶモリの挙動がスナップショット一致することを確認。
- **contract（Phase 2c）**: 旧一意制約の削除、シングルトンの `id` 列の役割終了（削除はさらに後）。
- 各migrationは `if not exists` 等で冪等、データ書き換え（大量UPDATE）なし、1migration＝1目的。
- **前提（Phase 1で解決）**: 本番のmigration適用状況が完全には確認できていない（DBパスワード不明、`20260901044548` は未適用が判明済み、stocks-sync系9本はgit未追跡のまま適用済み）。この状態で複垢migrationを重ねると履歴が壊れるため、Phase 2 の前に「適用状況の確定」を別タスクで完了させる。複垢化の差分には混ぜない。
- 本番適用は、ローカルDB（Docker導入後）で全migrationを空DBから適用→かぶモリ再現→テスト、が通ってから。

---

## 15. rollback 方針

| 段階 | rollback |
|---|---|
| expand migration | 基本は**戻さない**（列・テーブルが増えるだけで旧コードは影響を受けない）。どうしても戻す場合の down SQL を各migrationに併記（新テーブルdrop、追加列drop） |
| code switch | Edge Functionを直前のversionへ再deploy（version番号を事前に記録）。RPCは旧定義を down migration として同梱 |
| contract | 旧制約の再作成SQLを併記。contractは互換確認後にしか行わないので、戻す必要は低い |
| 新ブランド稼働後の問題 | `brands.is_active=false` または `social_accounts.publish_enabled=false`（即時・データ操作のみ）、全新ブランド停止は `system_flags.multibrand_publish_enabled=false` |
| トークン | `social_account_tokens` 行の削除でそのアカウントは即投稿不能（fail-closed）。X側でApp連携を解除すれば完全失効 |

---

## 16. セキュリティ上の注意

- トークン・暗号文・鍵・client secretを**ログ・DB平文・レスポンス・文書・Git・チャットへ出さない**。エラー時もX応答の非機密フィールド（title/detail/type/reason/errors.code）のみ記録（2026-09-08の `safeXApiErrorDetail` と同じ許可リスト方式）。
- `social_account_tokens` / `oauth_token_store` は anon/authenticated から完全に遮断、service_role のみ。
- 暗号鍵は専用Secret＋鍵バージョン。鍵ローテーション手順（新鍵で再暗号化→旧鍵Secret削除）を運用手順に含める。
- 認可導線は管理者セッション検証必須、`state` 検証、PKCE `S256`。callbackでの取込時に `/2/users/me` による結合検証（§8.4）。
- 旧OAuth1系Secret 4つは未使用のまま残っている。削除は複垢化とは別タスクで判断（誤って依存が無いか確認が必要）。
- 複垢worktreeには `.env` を置かない・`supabase link` しない（`check-safe-env.sh`）。

---

## 17. 本番誤投稿防止策

1. **3重ゲート**: `brands.is_active` ／ `social_accounts.publish_enabled` ／ `posting_windows.is_active`（＋ `brand_settings.enabled_post_types`）。1つでもOFFなら計画しない。
2. **publish_mode**: 新ブランドは `disabled` → `dry_run`（生成・判定・記録まで行いX APIは呼ばない）→ `live` の順に明示的に上げる。`dry_run` の X API 呼び出しはコード側でも例外（既存の `DRY_RUN_X_CALL_FORBIDDEN` と同じ方式）。
3. **投稿直前ガード `guardBeforePublish`**: ゲート再確認、`ctx.brandId === row.brand_id === account.brand_id`、アカウント結合検証、クールダウン・日次上限、横断類似チェック。いずれか失敗で投稿しない。
4. **キルスイッチ**: 新ブランド全停止 `system_flags.multibrand_publish_enabled`、ブランド単位 `brands.is_active`。
5. **順序制約**（§13）: ブランド対応コードのdeploy前に新ブランドの予定行を作らない。
6. **初回投稿の手動承認（任意）**: 新ブランドの `live` 化直後の最初のN件を承認待ちにするか（§20）。
7. **テストで保証**: 「非活性ブランドの行が存在しても X API が0回」「kabumoriのトークンが他ブランドの投稿に使われない」を単体テストで固定。

---

## 18. Phase 1〜5 の具体的実装順とテスト

### Phase 1: 安全な開発環境で現行かぶモリ1ブランドを再現

実装順:
1. 本番の migration 適用状況・`cron.job` 定義・シングルトン設定値・各テーブル行数を**read-only**で取得し記録（別タスク、秘密情報なし）
2. Cron 1〜4 の定義をリポジトリに記録（本番は変えない）
3. ローカルDB手段の決定（Docker導入 or モックのみ）→ 導入するなら `supabase start` で空DBから全migration適用
4. かぶモリの **ゴールデンスナップショット**（各post_typeのプロンプト全文・計画結果・固定ハッシュタグ・Storageパス）を生成するテストを追加

テスト:
- 既存680件 pass（基準）
- 空DBへ全migration適用が成功（Docker導入時）
- ゴールデンスナップショットが決定的に再生成できる

### Phase 2: ブランド識別機構を導入（kabumoriのみ、完全互換）

実装順:
1. 2a expand migration（§14）
2. `_shared/brand/*` 追加、`BRAND_CODE_PROFILES.kabumori` にかぶモリ値をバイト一致で移設
3. `x-test-post` の重複 `loadXTokens` を `_shared` に一本化
4. トークン読込を `social_account_tokens` 優先・`oauth_token_store`＋env フォールバック（kabumoriのみ）に
5. 全生成・投稿経路に `BrandContext` を通す
6. RPC の brand 対応（planner・claim・complete）
7. fingerprint の記録だけ開始（判定は無効）
8. 2c contract（互換確認後）

テスト:
- ゴールデンスナップショット完全一致（プロンプト・ハッシュタグ・計画時刻・パス）
- 既存680件＋新規テストすべて pass
- 未知 `brand_id` / 非活性ブランドで例外・X API 0回
- `brand_id` 省略の dry-run 呼び出しが kabumori として従来通り動く
- `oauth_token_store` のみ存在する状態でかぶモリが投稿できる（移行前互換）
- 本番: deploy後、次の自然投稿（各post_type 1回ずつ）の本文・時刻・ハッシュタグを read-only 確認

### Phase 3: 会社員AIラボを2ブランド目として追加

実装順:
1. `BRAND_CODE_PROFILES.ai_salaryman_lab`（ペルソナ・文体・扱うpost_type）— ユーザーのブランド方針資料が前提
2. ネタ在庫の投入（`brand_id='ai_salaryman_lab'`）
3. 認可導線（§8.5）の実装とユーザー本人による接続、`/2/users/me` 結合検証
4. 横断類似チェック（§9.4）を有効化
5. `is_active=true`・`publish_mode='dry_run'` で数日運用 → 生成物をユーザー確認 → `live`

テスト:
- 2ブランドの予定が同一分に来ても、それぞれ自分のトークン・自分の文体で処理される
- kabumori の設定変更（ON/OFF・時刻）が ai_salaryman_lab に影響しない、逆も同様
- 横断類似: 同一本文・同一出典・simhash近似が拒否され、ログに理由が残る
- `dry_run` で X API 0回
- アカウント結合不一致で投稿拒否

### Phase 4: みおを3ブランド目として追加

実装順:
1. `BRAND_CODE_PROFILES.mio`＋画像生成器・基準画像セット・`made_with_ai` 必須
2. `brand-assets/mio/...` の運用
3. 認可・結合検証 → `dry_run` → `live`

テスト:
- みおの画像が `brand-assets/mio/` 以外に書かれない、かぶモリの `morning-greeting-assets` を参照しない
- 画像付き投稿で `media.write` 不足時に安全停止（既存の403診断が機能）
- 3ブランド同時有効での時刻ずらし制約（§7.3）

### Phase 5: 3ブランドでX複垢運用を安定化

- 各アカウントの投稿成功率・拒否理由・類似拒否件数を管理画面で可視化
- 閾値（simhash・時間窓・日次上限）の調整
- その後に Instagram / Threads の検討（`platform` 追加、プラットフォーム別パブリッシャ）

---

## 19. リスク・未決事項

| リスク | 影響 | 対策 |
|---|---|---|
| 旧 `claim_due_post()` が新ブランド行を claim してかぶモリのトークンで投稿 | 誤投稿 | §13 順序制約、ゲート、テスト |
| `oauth_token_store` に2行目が入り旧コードが `limit=1` で取り違え | 誤投稿 | 新アカウントは別テーブル、`oauth_token_store` 凍結 |
| 本番migration適用状況が不確定 | 履歴破損・適用失敗 | Phase 1 で確定させるまで Phase 2 に進まない |
| Cron 1〜4 がmigration外 | 変更時に元に戻せない | Phase 1 で定義を記録 |
| 同一App・同一時間帯の複数アカウント投稿が協調行動と判定される | 凍結 | 横断類似防止・時刻ずらし・日次上限・App分離の検討 |
| App単位の停止で全ブランドが止まる | 全停止 | App分離の判断（§20） |
| Docker未導入でDBを実機検証できない | migrationの不具合を本番で初検出 | Docker導入の判断（§20）。導入しない場合は本番適用前のSQLレビューを厳格化 |
| プロンプト移設でかぶモリの文面が微妙に変わる | 本番の品質低下 | バイト一致のゴールデンスナップショット |
| 共有チェックアウトの未コミット差分（stocks-sync等）と複垢差分の混在 | 意図しない本番反映 | 複垢作業は `kabumori-multibrand` worktree のみ、mainへは切替計画合意まで入れない |

---

## 20. 実装開始前に ChatGPT 側で判断が必要な事項

1. **X App の構成**: 3ブランドで1つのX Appを共有するか、ブランドごとにAppを分けるか（凍結リスクの分散 vs 管理コスト）。設計はどちらにも対応（`oauth_client_ref`）。
2. **トークン暗号化方式**: 本設計の「アプリ側AES-GCM＋専用鍵Secret＋鍵バージョン」でよいか、Supabase Vault（`vault.secrets`、既にCronで使用中）へ寄せるか。
3. **シングルトン設定の多行化方式**: §4.1 の in-place（`id=true` 互換）でよいか、新テーブル集約にするか。
4. **Docker Desktop の導入可否**（Phase 1 のローカルDB再現の手段）。
5. **本番migration適用状況の確定作業**を、複垢化とは別タスクとして先に行うこと（DBパスワードの扱いを含む）。
6. **横断類似チェックの閾値・時間窓**（初期案: 30日・simhash距離8・同一出典72時間）。
7. **新ブランドの初回live投稿を手動承認制にするか**、その件数。
8. **会社員AIラボ・みおのブランド方針資料**（ペルソナ、文体、扱うテーマ、投稿種別、頻度、note導線、画像方針、NG事項）の提供者と時期。Phase 3/4 のプロファイル作成の前提。
9. **みおの画像方針**: キャラクター画像の生成方法・基準画像・AI生成表示・実在人物類似の禁止規則。
10. **important-news を kabumori 専用のままにする**前提でよいか。
11. **ブランド間の最小時刻差**（初期案10分）と各アカウントの日次上限の初期値。
12. 未使用の旧OAuth1系Secret 4つ・削除状態のpublish-ready Cron migration・git未追跡のstocks-sync資産を、それぞれ別タスクとして扱う優先度。

---

## 付録: 照合した主な事実（`origin/main` `dad3868`）

- `claim_due_post()`: 引数なし、呼ばれるたびに `plan_morning_report` / `plan_close_report` / `plan_daily_posts` / `plan_weekly_useful_tips` / `plan_us_premarket_report` を実行し、`status='pending' and scheduled_for <= now()` の1行を `for update skip locked` で claim（`20260901044548` の定義。ただし同migrationは本番未適用が判明しており、本番の定義は Phase 1 で read-only 確認が必要）。
- `x-test-post/index.ts`: dispatcher が `claimDuePost()` → `post_type` 分岐（morning_report / close_report / us_premarket_report / useful_tip / morning_greeting / interaction / tip）。トークンは同ファイル内の `loadXTokens`（`_shared` とは別実装）。
- `important-news-monitor/index.ts`: `publish_ready` で `important_news_monitor_settings?id=eq.true` の `auto_publish` を確認し、`_shared` の `loadXTokens` → `postToXWithRefresh`。
- `apps/admin/src/lib/actions/system-toggle.ts`: 設定テーブルは `.eq("id", true)`、`posting_windows` は `post_type` 単位で一括更新。
- migrationに存在する `cron.schedule` は `important-news-publish-ready` と `send-push-notifications-dispatch` の2本のみ。
- 本設計はコード変更を含まない。既存680テストのベースラインに影響しない。
