# POSTONA マルチSNS化 Phase 1 — 現状の棚卸しと設計方針

- 種別: アーキテクチャ設計書（ドキュメントのみ）。コード・DB・Edge Function・本番設定・プロバイダのアプリや認証情報は**一切変更していない**。
- TASK: `postona-multisocial-phase1-architecture-inventory-20261006`（G4）
- 調査基準: `origin/main` `e7da97d4`（2026-10-06）。G3 の PR #41 は調査中に `review_required`（head `280aa0f8`、未 merge）になった。
- 外部仕様: X / Threads / Instagram の公式ドキュメント（2026-10-06 時点）。公式で確認できなかったものは **要検証** と書く。
- 対象: アプリ `apps/social-mobile`（POSTONA の暫定名）と、それを支える `supabase/`。

POSTONA = POST + PERSONA。AI と会話して本人の口調・好みを確認済みの記憶として持ち、その口調で投稿を作り、予約し、自動投稿する。今回の方針は「UI の作り込みより先に、安全にマルチSNS化する」「順番は X → Threads → Instagram」「X を設計の中心にし続けない」。

---

## 0. 結論（先に要点）

1. **土台の多くはすでに中立。** ワークスペース（`brands`）、メンバー権限（`brand_memberships`）、内容設定・ペルソナ（`social_mobile_content_settings`）、投稿文の生成（`generateBrandPost`）、アプリの型 `SocialPlatform = 'x' | 'instagram' | 'threads'` にはプラットフォームの縛りがない。
2. **本当の構造的な縛りは5つ。**
   - **A. 投稿キューにアカウントがない。** 本番の `scheduled_posts` にはアカウントもプラットフォームもない。送信時は「ブランドのただ1つの X アカウント」から逆算している。結果の列名も `x_post_id`。
   - **B. 接続アカウント表が X 専用。** `social_accounts` は本番 DDL（リポジトリ外）が `CHECK (platform = 'x')`。関連 RPC はすべて `platform = 'x'` で絞り込んでいる。
   - **C. 資格情報が X の2トークン前提。** アクセスとリフレッシュの2つの Vault 参照が「存在し、別物で、他と共有しない」ことを、送信・ON・削除の各所で要求している。Threads／Instagram は長期トークン1本をその場で延長する方式なので、そのままでは通らない。
   - **D. 送信経路が X 専用。** 定期送信は `x-test-post` の中にあり、X 用の関数（`postToX` と `VaultAccountXAuth`）しかない。しかも main では、ユーザーのワークスペースの `brand_post` は **AI Lab 以外は送信されない**（`supabase/functions/x-test-post/index.ts:4018-4021`）。一般ユーザーの実際の自動投稿は G3 の PR #41 で初めてつながる。
   - **E. 接続（OAuth）経路が X 専用。** `x-oauth-connect-user` と `*_social_mobile_x_oauth_*` RPC で、アカウント id にも `':x'` が埋め込まれている。
3. **Threads は「1アカウント・テキストのみ・手動テスト投稿」から始める。**
   - その前提として、次の3つを先に終える:
     - G3 の PR #41（アカウントに紐付いた定期 `brand_post` 経路）
     - G5 の共通アカウント Phase 2（PR #95）
     - Meta 側の準備（アプリ登録、審査計画、データ削除コールバック）
   - DB は「既存の表を広げる」方針にする。`social_accounts.platform` を広げ、資格情報の要件をプロバイダごとにする。別の表を新しく作るのではない。
   - 複数 SNS への同時投稿は、Threads 単体が安定してから。
4. **Instagram は「画像・動画が必須」なので、素材ライブラリの設計が先。** テキストだけの投稿は API 上できない。

---

## 1. 現状の棚卸し

分類: **(a)** すでに中立 / **(b)** X 固有だが包みやすい（文言・ラベル・入口） / **(c)** X 固有の構造的依存 / **(d)** 稼働中の G3・G5 作業が所有 / **(e)** 設計上 X 固有のままでよい（X アダプタ内部）。

### 1.1 バックエンド

| # | 領域 | 現状（主な参照） | 分類 | Threads/IG で変わること |
|---|---|---|---|---|
| B1 | 接続（OAuth） | Edge `x-oauth-connect-user`（`index.ts:19-85`、`oauth_logic.ts:121-122,179-180,239-297`）。RPC `begin/consume/complete_social_mobile_x_oauth_*`（`20260919120000`、`20260922003101`）。PKCE と state のハッシュ化、所有者への紐付け、完了は原子的。トークンは Vault へ。`publish_enabled` は常に false で開始 | (d)＋(c) | プロバイダごとのアダプタ（認可 URL、スコープ、コード交換、本人情報の取得）。アカウント id の接尾辞 `':x'` をプロバイダ別に。Meta はカスタムスキームのリダイレクトを受け付けない可能性がある（**要検証**） |
| B2 | ワークスペース・権限 | `brands`（`u_`＋md5 で作る）、`brand_memberships`（owner/admin/member/viewer、`20260918120000`）。1ユーザー1ワークスペース。user ワークスペースを live にするコードはリポジトリにない | (a) | ほぼ変更なし。1ワークスペースに「プラットフォームごとに1アカウント」（`UNIQUE (brand_id, platform)`） |
| B3 | `social_accounts` | 本番 DDL はリポジトリ外。`CHECK (platform='x')`、`UNIQUE (brand_id, platform)`、`connection_status` の5値、`platform_user_id`、`handle`、`publish_enabled`、`verified_at`、`last_connection_error_code`、`oauth_client_ref`、Vault 参照2つ（フィクスチャ `supabase/tests/social_mobile_publish_permission_fixture.sql:69-85`）。「ブランドのただ1つの X アカウント」前提（`x_legacy_post_account`：`20260925140000:99-108`、`brand_context.ts:106-116`） | (c) | CHECK を広げる（前方 migration＋本番 preflight）。「X が1つ」の前提をプラットフォームごと、またはアカウント id ごとに |
| B4 | 資格情報・refresh | Vault 参照、`read_x_publish_credential_for_legacy_post`、refresh core（`x_account_refresh_state_v2`、rollout、health mirror）、`VaultAccountXAuth`、X のトークンエンドポイントと「単回使用で回転する refresh token」 | (d)。中身は (e) | プロバイダごとの refresh アダプタ。Meta は長期トークンをその場で延長する（refresh token なし）。「2つの参照が必須」の箇所（`20260925140000:119-122`、`20261003090000:231-239,313-314`、`20260928160000:452-454`）をプロバイダごとの規則にする |
| B5 | 投稿キュー | 本番 `scheduled_posts` にアカウント・プラットフォーム列なし。`post_execution_logs.x_post_id`、`publish_claims.x_post_id`、`published_content_fingerprints`（`social_account_id` あり）。v2 Phase1B〜1I（アカウント紐付けキュー、手順台帳、内容スナップショット）は**未適用・未配線**で、`target_platform` は `'x'` 固定の生成列（`20260924023133:3-5`） | (c) | 投稿をアカウント（＝プラットフォーム）に紐付ける。結果 id を中立化（`provider_post_id`）。手順台帳はコンテナ作成→公開の2段階に合う |
| B6 | 内容設定・ペルソナ・生成 | `social_mobile_content_settings`（ブランド単位、プラットフォーム列なし。PR81 は本番未適用）、AI 相談 `social-mobile-consult`（保存しない・X を呼ばない）、`socialMobileGenerationGuidance`、`generateBrandPost`（長さは既定 200〜400 字。`post_length_policy.ts` は code point で数え、X の重み付けではない） | (a)。publish 時の読み取りは (d) G3 | プロバイダごとの「出し分け方針」（長さ・リンク・ハッシュタグ・メディア）。相談のプロンプト文言「X（旧Twitter）への投稿を手伝う」（`social-mobile-consult/logic.ts:378`）を中立化 |
| B7 | 投稿許可 | `set_social_account_publish_enabled`（アカウント単位、`platform<>'x'` は `PLATFORM_NOT_SUPPORTED`：`20261003090000:225`）、`assert_x_publish_permission_for_legacy_post`（送信直前）、Edge `social-mobile-publish-setting`。PR #41 が `x_account_publish_authority` と `approvalMode` による同意を追加予定 | (d)＋(c) | ON の前提条件をプロバイダごとに。送信前チェックをアカウントに紐付いた投稿向けに中立化。同意の単位（アカウントかワークスペースか）は要決定 |
| B8 | 定期実行 | `x-test-post`（Cron は毎分。定義はリポジトリ外）。`claim_due_post` → `loadBrandContext` → ブランドごとに分岐（かぶモリは env トークン＋`oauth_token_store`、AI Lab は専用ガード `brand_post_dispatch_guard.ts:10-18`、user ワークスペースは main では到達しない）。`postToX` / `postThreadToX` | (d) G3。かぶモリ・AI Lab は (e) | 投稿の対象アカウントでプロバイダを選ぶ層。「1回の実行に X の認証が1つ」という `XAuthContext` は複数プロバイダを表せない |
| B9 | 手動・テスト投稿 | `social-mobile-brand-dry-run` はプレビューのみ。ただし「確認済み X アカウントが1つ」を要求し、`platform:'x'` を返す（`logic.ts:335-357,411-414`）。ユーザーが手動で投稿する経路はない | (b) | 選んだアカウントのプラットフォームでプレビュー。手動の「今すぐ投稿」は新規 |
| B10 | 履歴・学習 | `post_execution_logs`、健康状態。`social-mobile-history-learning`（同意必須、env で無効がデフォルト、X の `GET /2/users/{id}/tweets`、取得のみで保存しない）。トークン読み取りの RPC は `'x'` 固定 | (b)。読み取り RPC は (d) | プロバイダごとの履歴取得（Threads と IG のメディア一覧、**要検証**） |
| B11 | 退会・切断 | `social-mobile-account-delete`＋`20260928160000`（全アカウントの資格情報を列挙し、X に revoke し、Vault を削除。状態名は `x_revoked`）。参照が欠けると `operator_required` | (d) G5 | プロバイダごとの revoke／連携解除。アクセストークンのみの資格情報を許す。状態名を中立化 |
| B12 | 共通アカウント | `common_accounts`、`service_entitlements(service_key in ('kabumori','x_autopost'))`、`start_x_autopost_service()`（`20261001150000`）、PR #95（Phase 2、未 merge） | (d) G5 | サービスキー `x_autopost` を POSTONA に合わせるかは要決定（G5 の migration） |

### 1.2 アプリ（`apps/social-mobile`）

X を直接書いている箇所は **53**（a:8 / b:14 / c:6 / d:18 / e:7）。主なもの:

| # | 内容 | 参照 | 分類 |
|---|---|---|---|
| A1 | 自動投稿 ON の判定が X 専用（`platform !== 'x'` だと ON 不可） | `src/domain/publish-setting.ts:46-48`、テスト `tests/publish-setting.test.mjs:43-48` | (c) |
| A2 | 接続フックが X の1本だけ（関数名 `x-oauth-connect-user`、`x.com` ホスト確認、`kabumori-social://oauth-callback`） | `src/features/x-connect/use-x-connect.ts:30-111` | (e)（X アダプタとしては正しい） |
| A3 | アカウント画面が「X 1つ」前提 | `src/app/accounts/index.tsx:13-15,46-70` | (c) |
| A4 | オンボーディングが X の形（`connect_x`、`reconnect_x`、`.eq('platform','x')`） | `src/domain/onboarding.ts:12-79`、`src/data/onboarding-repository.ts:27-30`、`src/features/onboarding/onboarding-gate.tsx` | (d) G5 |
| A5 | X 専用の状態判定（`hasXReconnectNeeded`、`postingXStatus`） | `src/domain/post-interaction.ts:46-49`、`src/domain/account-security.ts:8-21` | (c)／(d) |
| A6 | 投稿にアカウントも本文もない（`accountId:'unknown'`、`text:''`） | `src/data/supabase-repository.ts:54-56` | (c)（B5 の裏返し） |
| A7 | 設定とペルソナがブランド単位で、プロバイダ別の口調・制約を表せない | `src/data/content-settings-repository.ts:51-74` | (a)（今は十分。将来の拡張点） |
| A8 | 応答の項目名 `x_api_called` | `src/domain/consult-session.ts:91` | (c)（項目名だけ） |
| A9 | 過去投稿の学習が X 専用（`isRetweet`、`platform:'x'`）。未配線 | `src/domain/past-post-learning.ts:11-19,48` | (c) |
| A10 | 文言（「Xアカウント」「X投稿」など） | `publish-setting.ts:6-13,53-59,131-145`、`brand-post-preview.tsx`、`consult.tsx:207-215` ほか | (b) |
| A11 | 名前と scheme（"Social Operations"、`kabumori-social`） | `app.json:3-8`、`src/domain/auth-flows.ts:15-17` | 要決定（名前変更） |

すでに中立なもの: `src/domain/types.ts:1-12`（`SocialPlatform` に threads と instagram がある）、`supabase-repository.ts:47`（platform の変換）、`src/lib/x-oauth-onboarding.ts`（中身は汎用の PKCE。ファイル名だけ X）。

### 1.3 名前の衝突に注意

コードベースで **"thread" は X の返信の連なり**を指す（`tip_thread`、`postThreadToX`、`create_reply`、`x_v2_confirmed_thread_root`）。Meta の Threads と混同しないよう、新しい識別子ではプロバイダを必ず `threads`（複数形・小文字）で表す。X の返信の連なりは今後 `reply_chain` と呼ぶ。既存の X 側の名前は変えない。

---

## 2. X 固有の継ぎ目マップ（直す順）

| 層 | 継ぎ目 | 現状 | 中立化の方針 | 担当・時期 |
|---|---|---|---|---|
| DB | `social_accounts.platform` の CHECK | `='x'`（本番 DDL） | `in ('x','threads')` → 後で `'instagram'` も。前方 migration と本番 preflight | Threads 2a（G5 と調整） |
| DB | 資格情報の要件 | 2参照が必須・別物・非共有 | 「プロバイダの資格情報の型」で要件を決める（X: access＋refresh の回転型。Threads/IG: 長期 access のみ・その場で延長） | Threads 2a（G5 の資格情報ライフサイクル） |
| DB | 投稿とアカウントの紐付け | なし（ブランドの X アカウントを逆算） | 投稿に `social_account_id`（3列 FK）。プラットフォームは**実際の列**にする（生成列 `'x'` ではない） | PR #41（G3）の後 |
| DB | 結果 id | `x_post_id` | `provider_post_id`＋`provider` | 投稿の紐付けと同時 |
| DB | 関数名 | `x_legacy_post_account`、`assert_x_*`、`x_account_refresh_*` | 既存はそのまま（本番稼働中）。新しく作るものは中立名、またはプロバイダ別の兄弟にする | 随時（一括改名はしない） |
| 実行 | 送信 | `postToX`、`VaultAccountXAuth`、`XAuthContext` | `PublishAdapter` インターフェース（§3.4）。X 実装は既存コードを包むだけ | PR #41 の後 |
| 実行 | 接続 | `x-oauth-connect-user` | `ConnectAdapter`。Threads 用の Edge は別関数（`threads-oauth-connect-user`）から始める | Threads 2b |
| アプリ | ON 判定・状態判定・アカウント画面 | X 専用 | プロバイダ登録表（ラベル、アイコン、接続の入口、ON の条件） | Threads 2b（オンボーディングは G5 の後） |
| アプリ | 文言 | 「X」 | プロバイダ名を差し込む | 随時 |

---

## 3. 目標アーキテクチャ（プロバイダ中立）

### 3.1 4つの層を混ぜない

| 層 | 意味 | 置き場所（現在 → 目標） |
|---|---|---|
| 共通ログイン | 1人の人（Supabase Auth） | `auth.users`（変更なし、G5） |
| サービス利用権 | POSTONA を使う権利 | `service_entitlements`（`x_autopost` の扱いは要決定、G5） |
| SNS アカウント接続 | ワークスペースに接続した各 SNS アカウントと資格情報 | `social_accounts`（広げる）＋Vault |
| 投稿許可 | このアカウントで自動投稿してよいか（同意・ON・ブランド live） | アカウント単位の `publish_enabled`＋送信前チェック（中立化）＋同意 |

ログインに使う X（または Apple／Google）と、投稿用に接続する X は**別物**。この区別は今と同じに保つ（`apps/social-mobile/docs/multi-provider-auth-phase2.md`）。

### 3.2 接続アカウント（connected social account）

`social_accounts` を中立化して使い続ける（新しい表は作らない）。

| 項目 | 目標 | 備考 |
|---|---|---|
| `platform` | `'x' | 'threads' | 'instagram'` | CHECK を広げる |
| `platform_user_id` | プロバイダ側のユーザー id | `(platform, platform_user_id)` の一意性は既存のまま |
| `handle` / 表示名 | 表示用 | IG は username、Threads は username |
| `connection_status` | 既存の5値を共通の意味で使う | `identity_verified` = 本人確認済み |
| 投稿可能状態 | `publish_enabled` ＋ プロバイダごとの ON 条件 | §3.5 |
| 資格情報 | Vault 参照のみ。トークンを一般の表へ写さない | 型はプロバイダで決める（下記） |
| プロバイダ固有の情報 | 共通列を汚さない | 例: IG のアカウント種別（business/creator）、Threads の公開範囲。別表 `social_account_provider_metadata(social_account_id, key, value)` か、jsonb 1列（要決定） |

**資格情報の型（credential profile）:**

| 型 | 対象 | 保存 | 延長・更新 |
|---|---|---|---|
| `oauth2_rotating_refresh` | X | access と refresh（2つの Vault 参照、別物・非共有） | refresh token は単回使用で回転する。保存できなかった結果は `uncertain` 扱い（既存の refresh core） |
| `long_lived_access` | Threads / IG（IG Login） | 長期 access 1つ（refresh 参照は NULL）＋有効期限 | 期限内かつ発行から24時間以上で、その場で延長（`th_refresh_token` / `ig_refresh_token`）。60日更新しないと失効 |

送信前チェック・ON 条件・削除の「2参照必須」は、この型ごとの規則に置き換える。X の規則は今と同じにする。

### 3.3 投稿モデル（論理投稿と配信先）

「X 投稿」を根っこにしない。

```
logical post（論理投稿）  … 何を言いたいか（意図・テーマ・素材・作成元）
  └─ publication target（配信先）… どのアカウントに、いつ、どの本文で
        ├─ rendered content（プロバイダ向けの本文。作成時に確定して保存）
        ├─ media attachments（素材への参照。X/Threads は任意、IG は必須）
        ├─ status / attempts（配信先ごと）
        └─ provider_post_id / permalink / error_code
```

決めること（提案）:
- **1つの論理投稿から複数 SNS へ配信できるか:** モデルは対応する。ただし最初の Threads は配信先1つで出す。複数配信は Threads 単体が安定してから。
- **プロバイダ別の本文:** 配信先ごとに**作成時に生成して保存**する（その場で作り直さない）。予約時点の本文を確認・監査でき、再試行しても本文が変わらない。v2 の内容スナップショット（Phase1H）と同じ考え方。
- **再試行と冪等性:** 論理投稿ではなく**配信先単位**で行う。Threads／IG の2段階投稿では、コンテナ id を保存してから公開を呼ぶ。応答が不明なときは公開済みかどうかを確認するまで再送しない（X の「投稿済みかもしれない」扱いと同じ）。

実装上は、PR #41 と v2 Phase1B の「投稿をアカウントに紐付ける」形（`scheduled_posts.social_account_id`＋3列 FK）を配信先として使うのが最小。論理投稿を別表にするのは複数配信を始めるとき。

### 3.4 プロバイダアダプタ（インターフェース案）

```ts
type ProviderId = 'x' | 'threads' | 'instagram';

interface ProviderCapabilities {
  textOnly: boolean;                 // IG は false
  maxTextLength: number;             // X は重み付き 280、Threads 500、IG キャプション 2200
  countText(text: string): number;   // X は twitter-text の重み付け、Threads は文字数（CJK の数え方は要検証）
  links: 'inline' | 'preview_first_url' | 'not_clickable_needs_verification';
  mediaRequired: boolean;
  publishFlow: 'single_call' | 'container_then_publish';
  dailyPublishLimit?: number;        // Threads 250 / IG 50 か 100（要検証） / X は別体系
}

interface ConnectAdapter {           // 接続（G5 の資格情報ライフサイクルと調整）
  authorizeUrl(input): URL;
  exchangeCode(input): Promise<ProviderTokens>;     // Meta は短期→長期へ交換
  readIdentity(token): Promise<ProviderIdentity>;
}
interface CredentialAdapter {
  profile: 'oauth2_rotating_refresh' | 'long_lived_access';
  refreshIfNeeded(ref): Promise<RefreshOutcome>;   // refreshed / not_needed / reauth_required / uncertain
}
interface PublishAdapter {
  prepare(target): Promise<PreparedPublish>;        // IG・Threads はコンテナ作成、X は何もしない
  awaitReady(prepared): Promise<ReadyState>;        // コンテナの状態が FINISHED になるまで（1分ごと・最大5分）
  publish(prepared): Promise<PublishOutcome>;       // published(id) / rejected(code) / uncertain
  classify(error): OutcomeClass;                    // 投稿されていないと言い切れるか
}
interface DisconnectAdapter { revoke(ref): Promise<void>; deleteRemote?(postId): Promise<void>; }
```

X の実装は既存の `postToX`、`VaultAccountXAuth`、`runXTokenRefresh` を**包むだけ**にして、挙動は変えない。

### 3.5 投稿許可（ON 条件）

共通: 現在の owner/admin、ブランドが active かつ live、アカウントが本人確認済み、資格情報の型の規則を満たす、接続エラーなし、退会処理中でない。

プロバイダ別に足す条件の例:
- X: refresh 状態がブロックされていない（既存）。
- Threads: 長期トークンが期限内。
- IG: プロアカウントであること、メディアを持つ投稿だけ。

送信前チェックは今と同じく「送信の直前に1回の読み取りで判定」。ただし、アカウントに紐付いた投稿を対象にする中立版（またはプロバイダ別の兄弟）を新しく作り、既存の `assert_x_publish_permission_for_legacy_post` は X の従来経路のために残す。

### 3.6 内容の出し分け

- **共有するもの:** ペルソナ（口調の信号、語彙、話題、句読点・絵文字、文の長さ）、テーマ、NG ワード。
- **プロバイダごとに出し分けるもの:**
  - 長さ: X は日本語で実質140字、Threads は500字、IG キャプションは2200字
  - リンク: X は URL 付き投稿が高い（後述）、Threads は最初の URL がプレビューになる、IG はキャプション内リンクが押せない（**要検証**）
  - ハッシュタグ: Threads はトピックタグ1つ、IG は30個まで
  - メディアの有無
- 生成器（`generateBrandPost`）に「プロバイダの出し分け方針」を渡す。今の `postLengthPolicy` をブランド単位からプロバイダ単位にする。
- プロバイダ別に学習した口調は将来の拡張にする。今は `persona_provenance` に出所を残せる形だけ考えておき、作らない。

### 3.7 メディア

- **今（X）:** テキストが主。画像は任意で、ユーザーが選んだアップロードか素材ライブラリから。AI 画像生成は前提にしない。
- **Threads:** 画像・動画は任意。Meta が**公開 HTTPS URL から取得する**方式（アップロード API なし）。
- **Instagram:** メディアが必須。素材ライブラリ（`素材BOX` 画面が既にある：`src/app/media/index.tsx`、中身はモック）を論理投稿に付ける。Storage の署名付き URL の有効期限とコンテナ処理の待ち時間を合わせる必要がある（**要設計**）。今回はスキーマを作らない。

---

## 4. プロバイダの機能比較（公式ドキュメント、2026-10-06）

| 項目 | X API v2 | Threads API | Instagram |
|---|---|---|---|
| テキストのみ | 可（重み付き280。日本語・絵文字は2、URL は23） | 可（`TEXT`、500文字） | **不可**（メディア必須）。キャプション2200字・ハッシュタグ30・@20 |
| メディア | 任意（画像4・GIF1・動画1） | 任意（画像 JPEG/PNG 8MB、動画5分1GB、カルーセル2〜20） | 必須（画像は JPEG のみ・縦横比4:5〜1.91:1、リール15分300MB、カルーセル10） |
| リンク | 本文に入る。**URL 付き投稿は $0.20／件** | 最初の URL がプレビュー、5個まで | キャプション内リンクは押せない（**要検証**） |
| 投稿の流れ | 1回の呼び出し（`POST /2/tweets`） | コンテナ作成→公開（テキストは `auto_publish_text` で1回でも可） | コンテナ作成→公開（状態が `FINISHED` になるまで確認） |
| 予約 | API になし（アプリで予約） | なし | なし |
| アカウント要件 | 開発者アカウント、Project/App | Threads ユースケースの Meta アプリ（IG と未紐付けのプロフィールも可） | プロアカウント（ビジネス／クリエイター）。FB Login はページとの連携も必要 |
| 認証 | OAuth2＋PKCE。`tweet.read tweet.write users.read offline.access`（`media.write`）。access 2時間、refresh は約6か月・単回使用 | `threads_basic`＋`threads_content_publish`。長期60日、24時間後から延長可 | IG Login: `instagram_business_basic`＋`instagram_business_content_publish`、長期60日。FB Login: `instagram_basic`＋`instagram_content_publish`＋`pages_read_engagement` |
| 上限 | 1ユーザー100件／15分、1アプリ1万件／24時間。$0.015／件 | 250件／24時間（返信1000、削除100）。`threads_publishing_limit` で確認 | **50 か 100／24時間（公式内で食い違い、要検証）**。コンテナ400／24時間 |
| 投稿 id | Snowflake（文字列）。編集で id が変わる | `THREADS_MEDIA_ID`、`permalink` を取得可 | `IG_MEDIA_ID`、`permalink` を取得可 |
| 削除・解除 | `DELETE /2/tweets/:id`、`POST /2/oauth2/revoke` | `DELETE /{id}`（`threads_delete`）。連携解除とデータ削除のコールバック | 削除は FB Login のみ（`instagram_manage_contents`）。連携解除とデータ削除のコールバック |
| Webhook | Activity API（有料） | `publish`/`delete`（Live 化＋ビジネス認証が条件） | 投稿完了の webhook なし（状態をポーリング） |
| 一般公開の前提 | 審査なし。規約同意とクレジット購入 | 各権限の App Review＋アプリ公開 | Advanced Access（App Review＋Business Verification） |

出典（主なもの）:
- https://docs.x.com/x-api/posts/create-post 、 https://docs.x.com/fundamentals/counting-characters 、 https://docs.x.com/x-api/getting-started/pricing 、 https://docs.x.com/x-api/fundamentals/rate-limits 、 https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- https://developers.facebook.com/documentation/threads/posts 、 …/threads/overview 、 …/threads/get-started/long-lived-tokens 、 …/threads/troubleshooting
- https://developers.facebook.com/documentation/instagram-platform/overview 、 …/instagram-platform/content-publishing 、 …/instagram-graph-api/reference/ig-user/media 、 …/instagram-platform/app-review

**要検証（公式で確認できなかった、または食い違っているもの）:**
1. IG キャプション内リンクが押せないこと
2. Threads 500文字の数え方（日本語）
3. Threads の地域制限
4. X の280字を超える長文投稿の可否
5. X のハッシュタグ上限と、削除・メディアの料金
6. X の連携解除通知
7. X のパーマリンク形式
8. Threads と IG Login のトークン無効化 API
9. Meta の長期トークンを延長したときに文字列が変わるか
10. IG の投稿上限（50 か 100）
11. Threads の権限延長の扱い（ページ間で矛盾）
12. IG の FB Login で使うトークンの種類
13. IG の権限名の表記ゆれ
14. Threads で Business Verification が必須か
15. 開発モードの投稿の見え方
16. **Meta の OAuth で `kabumori-social://` のようなカスタムスキームのリダイレクトが使えるか**（使えなければ HTTPS のコールバックページが必要）
17. 「IG Login は Web とモバイル Web のみ」という記述が、アプリ内ブラウザ（`openAuthSessionAsync`）での認可に当てはまるか

---

## 5. Threads を先にする段階計画（Phase 2）

前提（このどれかが未完了なら、該当の段階は始めない）:
- G3 の PR #41 が merge されている（アカウントに紐付いた user ワークスペースの定期 `brand_post` 経路、publish authority、内容設定の publish 時読み取り）。
- G5 の PR #95（共通アカウント Phase 2）が merge されている（サービス利用権、オンボーディングとセッションの境界）。
- Meta 側の準備（下の 2-0）。

| 段階 | 内容 | 主なファイル・部品 | DB / migration / RPC / Edge | テスト | G3/G5 依存 | 本番ゲート | 失敗時の振る舞い |
|---|---|---|---|---|---|---|---|
| **2-0** 準備（コードなし） | Meta アプリ（Threads ユースケース）、プライバシーポリシー URL、データ削除・連携解除コールバックの設計、App Review の計画、テスター登録、リダイレクト URI の確認（要検証 16） | なし | なし | なし | なし | 外部登録はユーザー承認 | 審査が通るまでテスターのみ |
| **2a** 中立化の継ぎ目（挙動は変えない） | `ProviderId` と機能表のモジュール。X の送信・資格情報を `PublishAdapter`/`CredentialAdapter` で包む。アプリ側にプロバイダ登録表（ラベル・ON 条件）を作り、b 分類の文言を差し込みにする | `_shared/social/providers.ts`（新）、`x-test-post/vault_account_auth.ts`（包むだけ）、`apps/social-mobile/src/domain/publish-setting.ts`、`accounts/index.tsx` | migration 候補（未適用）: `social_accounts.platform` の CHECK を広げ、資格情報の型ごとの規則にする | 既存の X テストが全部そのまま通る。変異テスト | x-test-post は PR #41 の後（G3）。資格情報は G5 と合意 | migration は本番 preflight＋承認 | 未知のプラットフォームは常に拒否 |
| **2b** Threads 接続と準備状態 | Threads OAuth（短期→長期の交換、本人情報）、アカウント id `sa_…:threads`、アカウント画面と ON 条件 | Edge `threads-oauth-connect-user`（新）、RPC `begin/complete_social_mobile_threads_oauth_*`（新）、アプリの接続フック（`use-threads-connect.ts`）、`accounts/index.tsx` | 2a の migration を適用、新 RPC | 使い捨て DB（所有者紐付け、state の単回使用、Vault 書き込み）、偽プロバイダの E2E | オンボーディングは G5 の後。資格情報ライフサイクルは G5 | 本番 migration と deploy は承認制 | 接続しても `publish_enabled=false` で開始（X と同じ） |
| **2c** 手動テスト投稿 | owner が Threads テスターアカウントへテキストを1件投稿（コンテナ作成→状態確認→公開） | Edge `social-mobile-test-publish`（新、プロバイダは引数）、`ThreadsPublishAdapter` | 結果記録（配信先単位、`provider_post_id`） | 偽 Threads での E2E（作成→FINISHED→公開、EXPIRED、ERROR、応答不明） | なし（ユーザー起点の経路は新規） | 実投稿はテスターアカウントでユーザー承認時のみ | 応答不明なら再送せず確認 |
| **2d** 定期投稿 | アカウントに紐付いた投稿をプロバイダ別に送信。Threads の上限（250／24時間）をアプリ側でも数える | 送信層（PR #41 の経路に `PublishAdapter` を挿す）、送信前チェックの中立版 | 投稿の `social_account_id`＋platform 列（PR #41 と v2 Phase1B の形を中立化）、送信前チェックの RPC（新）、結果 id の中立化 | 使い捨て DB の競合テスト（OFF・ブランド無効・退会中、送信前チェック） | **PR #41 の merge が必須（G3）** | runtime を先に入れる順序（PR #76 と同じ） | 送信前チェックが失敗すれば何も出さない |
| **2e** 生成の出し分け | プロバイダ方針（500字、リンク、トピックタグ）を生成器へ。相談プロンプトの文言を中立化 | `_shared/brand/brand_post_generator.ts`、`post_length_policy.ts`、`social-mobile-consult/logic.ts:378` | なし | 生成器のテスト（長さ・タグ）、AI 相談の既存テスト | publish 時の設定読み取りは G3 の境界を使う | なし（deploy は承認） | 長さ超過は送信前に拒否 |
| **2f** 履歴と状態 | 配信先ごとの履歴・失敗理由、Threads のパーマリンク | アプリ `history.tsx`、`posts/[id].tsx`、`supabase-repository.ts` | 履歴の読み取り（配信先単位） | アプリのテスト | なし | なし | — |
| **2g** 複数配信（後回し） | 1つの論理投稿から X と Threads へ | 論理投稿の表（新） | 論理投稿の表、配信先の表 | — | — | — | 配信先ごとに独立して失敗・再試行 |

---

## 6. Instagram（Threads の後）

Threads と違うところ:

- **前提:**
  - プロアカウント（ビジネス／クリエイター）であることを接続時に確認し、そうでなければ接続を拒否する。
  - 「IG Login」と「FB Login」のどちらにするか決める必要がある。
    - IG Login: 手順が簡単（FB ページ不要）。ただし API での投稿削除ができない。Web とモバイル Web だけという記述もある（要検証 17）。
    - FB Login: ページとの連携が要る代わりに削除ができる。
    - 1つのアプリで両方を併用することはできない。
- **メディア（最優先）:**
  - 素材ライブラリ（Storage）から公開 HTTPS URL で Meta に渡す。
  - 画像は JPEG のみで、縦横比は4:5〜1.91:1。
  - リールや動画は処理待ち（状態のポーリング）が長い。
  - 素材の選択画面（`素材BOX`）を本物にする必要がある。
- **キャプション:** 2200字、ハッシュタグ30、@20。リンクは押せない前提で、プロフィールへ誘導する文言にする（要検証 1）。
- **上限:** 50 か 100／24時間（要検証 10）、コンテナは400／24時間。
- **審査:** Advanced Access（App Review と Business Verification）。データ削除コールバックも必要。
- **再利用できるもの:** Threads の2段階投稿（コンテナ→状態確認→公開）、長期トークンの資格情報型、配信先モデル、送信前チェック、生成の出し分け方針。
- **メディア UX の設計まで待つもの:** 素材の保存スキーマ、自動の画像選択、リールや動画、カルーセル。

---

## 7. G3 / G5 との依存・衝突

| 領域 | 所有 | 状態（2026-10-06） | POSTONA への影響 | 進め方 |
|---|---|---|---|---|
| user ワークスペースの定期 `brand_post` 経路（PR #41）、publish authority、内容設定の publish 時読み取り | G3 | PR #41 は review_required（head `280aa0f8`）、未 merge | 定期送信の土台。ここに `PublishAdapter` を挿す | **merge を待つ**。それまで `x-test-post` は触らない |
| `x-test-post` の定期ルーティング | G3 | 稼働中（v135 のコード） | 送信層の中立化はこの上で行う | PR #41 の後 |
| 内容設定ハードニング（PR81） | G3 | 本番未適用 | ペルソナ・設定の契約 | 契約はそのまま使う |
| 共通アカウント・サービス利用権（`x_autopost`）、Phase 2（PR #95） | G5 | PR #95 は修正中 | サービスキー名、オンボーディング、AuthGate | オンボーディングとサービス利用権は G5 の後。名前は要決定 |
| OAuth / Vault / 資格情報ライフサイクル、退会 | G5 | 稼働中 | Threads の接続・資格情報型・revoke | 2a の資格情報型は G5 と合意してから |
| 送信前チェックと publish 設定（PR #76） | G4（完了） | 本番適用済み | ON 条件の中立化の起点 | 既存は残し、中立版を足す |

---

## 8. まだ変えないもの

- `x-test-post` のルーティングと PR #41 のファイル（G3）。
- 内容設定・ペルソナの publish 時読み取りの境界（G3）。
- 共通アカウント、サービス利用権、AuthGate、オンボーディング、ログイン方法（G5）。
- OAuth・Vault・refresh core・退会の状態機械（G5／稼働中）。
- `social_accounts` の CHECK（承認された前方 migration まで）。
- PR #76 の2つの関数（本番適用済み。中立版は別に足す）。
- 既存の `x_*` という名前の DB オブジェクトや関数の一括改名（本番で稼働中なので、改名せずに新しいものを足す）。
- かぶモリ・AI Lab の X 経路（設計上 X 固有）。
- アプリの名前・scheme・バンドル id（名前変更の判断の後）。

---

## 9. プロダクトとして決めてほしいこと

1. **1つの論理投稿から複数の SNS へ同時に配信するか。** 提案: モデルは対応し、UI は Threads 単体が安定してから。
2. **SNS ごとの本文:** 配信先ごとに生成して保存する（提案）か、1つの本文を機械的に縮めるか。
3. **自動投稿の同意の単位:** アカウントごとか、ワークスペースごとか。PR #41 の `approvalMode` はワークスペース単位。
4. **1ワークスペースに1つの SNS で1アカウントまで、のままでよいか**（今は `UNIQUE (brand_id, platform)`）。
5. **X のコストの扱い:** URL 付き投稿は $0.20／件（通常の約13倍）。X では既定で URL を入れないか、プランで制限するか。
6. **Threads の最初のリリース範囲:** テキストのみか、リンクのプレビューやトピックタグも入れるか。
7. **Instagram:** IG Login か FB Login か。素材ライブラリの範囲。リールや動画をやるか。
8. **サービスキー `x_autopost` を POSTONA に合わせて変えるか**（G5 の migration）。内部 id は変えずに表示名だけ変える案もある。
9. **アプリ名・scheme（`kabumori-social`）・表示名（"Social Operations"）を変える時期。** OAuth のリダイレクト登録にも影響する。
10. **Meta の Business Verification を誰の名義で行うか**（会社情報が必要）。
11. **ペルソナを SNS 共通にするか、SNS ごとの癖も学習するか**（提案: 共通で始めて、後で SNS 別の補正を足す）。

---

## 10. 次の G4 タスク（提案）

**「POSTONA Phase 2a — 中立化の継ぎ目と Threads 接続の準備（挙動変更なし）」**
- 内容:
  - `ProviderId` と機能表のモジュール（§4 の数値を要検証のフラグ付きでコードにする）
  - `social_accounts` の CHECK を広げ、資格情報の型ごとの規則にする migration 候補（未適用、使い捨て DB での証明付き）
  - Threads 接続の設計（リダイレクト URI の確認方法を含む）
- 開始の前提: PR #41（G3）と PR #95（G5）の merge 状況を確認する。`x-test-post` と G5 の範囲には触れない。
- 並行してユーザー側で進めること: Meta アプリの登録と App Review の計画（2-0）。
