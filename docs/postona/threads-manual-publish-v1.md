# POSTONA Threads 手動テキスト投稿 V1（ソース実装・未配線・無効）

> **2026-10-12 追記（統合 TASK `postona-threads-connect-publish-integrated-offline-v1-g4-20261011`）**: §3〜§4 の `claim`→`redeem`（service_role）→`record` は、K4 の P1 指摘により `release`（権限判定とトークン受け渡しを1トランザクション・サーバーの証明つき）と `record` に置き換えた。ワークスペースの条件と G5 のエラーコードの読み分けも修正した。最新は `docs/postona/threads-connect-publish-integration-v1.md`。

- TASK: `postona-threads-manual-text-publish-v1-20261011`（G4）
- 基準: `origin/main` `9fef4659`（2026-10-11 JST）
- 状態: **ソースと偽データのテストだけ。本番の DB・Edge Function・Meta・Supabase には一切触れていない。** 実際の Threads 投稿は、下の「本番までの関門」がすべて揃い、別途承認されるまで動かない。
- 担当範囲: Threads への投稿（provider 送信部）、手動投稿のサーバー処理、手動投稿の画面。**Threads の接続（OAuth）は H5、共通アカウント・利用権・削除は G5、予約・スケジューラは G3 の担当で、ここでは触っていない。**

## 0. 要点

1. **公式の2段階投稿を、そのまま実装した。** `POST /{threads-user-id}/threads`（`media_type=TEXT`）でコンテナを作り、状態が `FINISHED` になってから `POST /{threads-user-id}/threads_publish` で公開し、最後に `GET /{media-id}` で投稿を読み戻して確認する。
2. **二重投稿しない作り。**
   - `auto_publish_text` は使わない。使うと「コンテナ作成＝公開」になり、応答が途切れたときに確かめる手段がなくなるため。
   - 1タップ＝1つの冪等キー。同じキーの再送は同じ記録を返すだけ。
   - 1アカウントにつき処理中の投稿は1件まで（DB の一意索引で保証）。
   - 公開の結果が分からないときは `uncertain`（不明）として記録し、**自動でも手動でも送り直さない**。確認はコンテナの状態の読み取りだけで行い、24時間で必ず確定する（期限切れ＝公開されていない）。
3. **権限の判断はすべて DB が、毎回行う。** Threads への書き込み（コンテナ作成・公開）の**直前ごと**に、本人確認・POSTONA 利用権（G5 の T13 フェンス）・ワークスペースのオーナー/管理者・Threads 接続・アカウントごとの「手動投稿の許可」を判定し直す。
4. **トークンは利用者の端末に渡らない。** サーバーだけが、DB が発行した使い捨ての「許可証」（60秒・1回限り・手順ごと）と引き換えに、そのアカウントのトークンを Vault から1回だけ受け取る。
5. **「投稿しました」と表示するのは、Threads から読み戻して確認できたときだけ。** Threads が投稿 id を返しただけの段階は「確認中」と表示する。
6. **画面は既定で非表示。** リリースフラグ `THREADS_MANUAL_PUBLISH_UI_ENABLED = false` のあいだ、Threads アカウントの詳細画面には「準備中」とだけ出て、入力欄もボタンも出ない。サーバー側も静的ゲート `THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false` で、すべての要求に 503 を返す。

## 1. 公式仕様の確認（2026-10-11）

| 内容 | 公式の記載 | 実装 |
|---|---|---|
| コンテナ作成 | `POST https://graph.threads.net/v1.0/<THREADS_USER_ID>/threads`、`media_type=TEXT`、`text`、`access_token`（例はフォーム送信） | 同じ。トークンはフォーム本文に入れ、URL には入れない |
| 公開 | `POST .../<THREADS_USER_ID>/threads_publish`、`creation_id` | 同じ |
| コンテナの状態 | `GET .../<MEDIA_CONTAINER_ID>?fields=status,error_message`。`EXPIRED` / `ERROR` / `FINISHED` / `IN_PROGRESS` / `PUBLISHED` | 同じ（`id` も要求し、別 id の応答は拒否） |
| 投稿の取得 | `GET /{threads-media-id}`、`fields` に `id,permalink,owner,username,timestamp` など | 読み戻しに使用。同じ id・同じ所有者・Threads のパーマリンクのときだけ「確認済み」 |
| 自分の投稿一覧 | `GET /me/threads?fields=...&since=...&limit=...` | 結果不明の投稿の照合だけに使用（`/{user-id}/threads`） |
| 文字数 | テキストは500文字まで。**絵文字は UTF-8 のバイト数で数える** | 同じ数え方（`threadsTextLength`）。アプリとサーバーで同じ結果になることをテストで確認 |
| リンク | 1投稿5個まで（超えるとコンテナ作成で `THREADS_API__LINK_LIMIT_EXCEEDED`） | 送信前に5個まで |
| `auto_publish_text` | テキストのみ、コンテナ作成時に自動公開 | **使わない**（上記の理由） |
| コンテナの期限 | 24時間以内に公開しないと `EXPIRED` | 結果不明の確定に利用 |
| 状態の確認間隔 | 1分に1回、最長5分（主に動画など） | テキストは通常すぐ準備できるため、最初の要求の中で短く最大3回だけ確認し、まだなら「続ける」ボタンに任せる |
| 権限 | `threads_basic`（全エンドポイント）、`threads_content_publish`（投稿） | 接続時（H5）に両方が付与されていることが前提 |
| 投稿上限 | `threads_publishing_limit` の例は 250件／24時間 | 上限超過は `THREADS_RATE_LIMITED` として「公開されていない」扱い |

出典: https://developers.facebook.com/documentation/threads/posts 、 …/threads/reference/publishing 、 …/threads/troubleshooting 、 …/threads/retrieve-and-discover-posts/retrieve-posts 、 …/threads/reference/media-retrieval 、 …/threads/get-started/get-access-tokens-and-permissions

**要検証（公式で確認できなかったもの）:**
- 日本語など絵文字以外の文字の数え方（1文字＝1として実装。絵文字は公式どおりバイト数）。
- Graph のエラーコードの分類（190＝トークン無効、10/200〜299＝権限、4/17/32/613/HTTP 429＝回数制限、1/2＝一時的）は Graph API 共通の慣例に従った。Threads 固有のコードは実機で確認が必要。
- `owner` フィールドが常に返るか（返らない場合は id とパーマリンクだけで確認する実装）。
- Authorization ヘッダーでのトークン送信は公式に記載がないため使わず、公式どおりパラメータで送る（GET の URL にはトークンが入るので、その URL は絶対にログに出さない）。

## 2. 作ったもの

| # | 内容 | ファイル |
|---|---|---|
| 1 | Threads 送信部（公式 API の要求の組み立てと応答の厳密な検査。ネットワークは差し替え式） | `supabase/functions/_shared/social/threads_publish_contract.ts`（＋`_test.ts`） |
| 2 | 手動投稿の手順（予約→各手順の直前に DB で再判定→許可証でトークン受け取り→Threads へ1回だけ→結果を記録） | `supabase/functions/_shared/social/threads_manual_publish.ts`（＋`_test.ts`、テスト用の参照モデル `threads_manual_publish_fake.ts`） |
| 2 | Edge Function のソース（**未デプロイ・静的ゲートで無効**） | `supabase/functions/social-mobile-threads-publish/`（`index.ts` / `http.ts` / `logic.ts`＋テスト） |
| 2 | DB 側の候補 SQL（**migration ではない・未適用**。必要な前提が無ければ何もせずに止まる） | `supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql` |
| 2 | DB 候補の検証（ローカルの使い捨て PostgreSQL だけで実行） | `supabase/tests/postona_threads_publish_{fixture,behavior}.sql`、`postona_threads_publish_run.sh` |
| 3 | 手動投稿の画面（Threads アカウント詳細のカード。リリースフラグで既定は非表示） | `apps/social-mobile/src/domain/threads-manual-publish.ts`、`src/features/threads-publish/*`、`src/app/accounts/[id].tsx`（カードを追加しただけ） |
| 3 | 画面のテスト | `apps/social-mobile/tests/threads-manual-publish.test.mjs` |
| 4 | 連携契約（この文書の §5〜§7） | `docs/postona/threads-manual-publish-v1.md` |

G3 の予約画面（`schedule.tsx`・`schedule-composer.tsx`・`schedule-planner.ts`）、X の送信経路（`x-test-post`）、H5 の接続まわり、G5 の共通アカウント・削除は**変更していない**。

## 3. 投稿1件の流れ

```
アプリ「投稿する」（明示の確認タップ。冪等キーを1つ発行）
  └─ Edge: 呼び出し元のトークンを Auth サーバーで確認
      ├─ begin   （呼び出し元の JWT。DB 内で auth.uid() が本人）   予約: 本文をそのまま保存、1アカウント1件まで
      ├─ claim create_container（呼び出し元の JWT）  ← DB が毎回すべてを判定し直し、使い捨て許可証を発行
      ├─ redeem （サーバー専用）  許可証と引き換えに、このアカウントのトークンと保存済み本文を1回だけ
      ├─ Threads: POST /threads（1回だけ）
      ├─ record （サーバー専用）  container_created / failed
      ├─ claim check_container → redeem → GET コンテナ状態（FINISHED まで最大3回）
      ├─ claim publish（再判定）→ redeem → Threads: POST /threads_publish（1回だけ）
      ├─ record  publish_returned / failed（4xx＝確実に未公開） / uncertain（応答不明）
      └─ claim confirm → redeem → GET 投稿（読み戻し）→ record published（id＋パーマリンク）
```

状態: `reserved` → `creating_container` → `container_created` → `publishing` → `publish_returned` → `published`。ほかに `failed`（公開されていない）、`uncertain`（不明。送り直さない）、`published_unidentified`（コンテナの状態で公開は確認できたが、投稿を特定できない）。

- **コンテナ作成の応答が途切れた場合は `failed`。** コンテナ id を受け取っていないので、それを公開する手段がなく、投稿は存在し得ない（24時間で期限切れになる）。
- **公開の応答が途切れた場合は `uncertain`。** 「確認する」は読み取りだけ: コンテナが `PUBLISHED` なら、開始以降の自分の投稿から本文が完全一致する1件を探して読み戻す（2件以上・0件なら `published_unidentified`）。`ERROR` / `EXPIRED` なら確実に未公開で `failed`。それ以外は不明のまま（最長24時間で確定）。
- **途中でサーバーが止まった場合**: `creating_container` のまま2分経てば `failed`（STEP_INTERRUPTED）、`publishing` のまま2分経てば `uncertain` にしてから上の確認に進む。
- **許可証を発行した直後に権限が取り消された場合**: トークンを渡さずに拒否し、その試行を `failed`（AUTHORIZATION_CHANGED）で閉じる（送信していないことが確実なため）。
- **予約から15分を過ぎた試行は、コンテナ作成・公開へ進めない**（ATTEMPT_EXPIRED）。古い操作が後から勝手に公開されることはない。

## 4. 権限の境界

- **呼び出し元の関数**（`authenticated` ロールのみ実行可）: `set_threads_manual_publish_permission` / `get_threads_manual_publish_state` / `begin_threads_manual_publish` / `claim_threads_manual_publish_step` / `get_threads_manual_publish_attempt`。どれも user id・workspace id・provider id・secret id を引数に取らない（本人は DB 内の `auth.uid()`）。
- **サーバー専用の関数**（`service_role` のみ実行可）: `redeem_threads_manual_publish_step` / `record_threads_manual_publish_step`。呼び出し元が認可された claim で発行された許可証（64桁16進・DB には sha256 だけ・60秒・1回・手順ごと）が無ければ何もしない。redeem はトークンを渡す前にアカウントを判定し直す。
- **表への直接アクセスは、どのアプリ用ロールにも無い**（RLS 有効・ポリシー無し・権限すべて剥奪。適用時の事後条件で確認）。
- **アカウントごとの手動投稿の許可**は新しい表 `social_account_manual_publish_permissions` に置いた。X の自動投稿スイッチ `publish_enabled` とは別物（Phase 2a-2 の CHECK により Threads の `publish_enabled` は false のまま）。許可の付与は G5 フェンスと接続状態を確認してから、取り消しはオーナー/管理者ならいつでも可能。取り消しても、すでに公開された投稿は消えない（画面でもそう説明）。
- 判定の順番（毎回）: 本人 → **G5 フェンス（`x_autopost`、同じトランザクションの先頭、そのロックを最後まで保持）** → ワークスペース（有効、`publish_mode` が `disabled` でない）→ メンバーシップ（オーナー/管理者）→ Threads アカウント（`identity_verified`・`verified_at`・数字の `platform_user_id`・Vault 参照あり）→ トークンの期限（5分以上先）→ 手動投稿の許可。ロック順はブランド → メンバーシップ → アカウント → 許可 → 試行（既存のアカウント関数と同じ）。
- 投稿後の読み戻し（confirm / reconcile）は許可を取り消した後でも行える（自分の投稿が出たかどうかを知る権利を奪わないため）。

**レビューで見てほしい点（新しい形のため）**: サーバー専用関数が `service_role` で動き、呼び出し元の判定から最大60秒の許可証でトークンを渡すこと。既存の X 送信（スケジューラが投稿を確保し、`service_role` 専用の関数がその投稿のトークンを渡す）と同じ考え方だが、判定を `auth.uid()` で行う点が新しい。H5 が担当する「本人確認済みの呼び出しを DB の所有者権限につなぐ方式」とは別の経路なので、統合レビューで一緒に確認してほしい。

## 5. H5（Threads 接続）との連携契約

G4 の投稿処理が、H5 の接続結果に**前提として求めるもの**（これ以外のものは読まない・書かない）:

| 項目 | 内容 |
|---|---|
| 本人 | 呼び出し元の Supabase Auth のアクセストークン。Edge は `GET /auth/v1/user` で確認し、DB では同じトークンで `auth.uid()` が本人になる。G4 は user id を引数で受け取らない |
| アカウント | `public.social_accounts` の1行。`platform='threads'`、`connection_status='identity_verified'`、`verified_at` あり、`platform_user_id`＝Threads のユーザー id（数字の文字列。2^53 を超えても丸めない） |
| 資格情報 | `vault_access_token_secret_id`＝長期トークン（60日）を入れた Vault の secret。`vault_refresh_token_secret_id` は NULL（2a-2 の CHECK）。X の資格情報とは共有しない |
| 権限 | 接続時に `threads_basic` と `threads_content_publish` が付与されていること |
| 投稿許可 | 接続しても投稿は許可されない（`publish_enabled=false` のまま、手動投稿の許可の行も無い）。許可は利用者が画面で明示したときだけ |
| 期限 | **読み出し口 `public.threads_account_credential_expires_at(social_account_id text) returns timestamptz` を、資格情報の管理側（H5 / トークン管理の担当）が用意すること**。所有者は表の所有者、アプリ用ロールから実行不可。NULL＝不明＝期限切れとして扱う。G4 は各手順の直前（claim）とトークン受け渡しの直前（redeem）に「期限まで5分以上あるか」を確認し、無ければ `CREDENTIALS_EXPIRED` で止める（受け渡し直前なら送信せずに試行を閉じる）。H5 の現在の候補は期限を OAuth 試行ごとの記録（`token_expires_at`）に持っているので、アカウント単位で読む方法を H5 側で決めてほしい。DB 候補はこの読み出し口が無いと `THREADS_PUBLISH_PRECONDITION_CREDENTIAL_EXPIRY` で止まる |
| 延長・失効 | **H5 / トークン管理の担当**。Threads が 190（トークン無効）を返したら、G4 は試行を `failed`（THREADS_TOKEN_INVALID）で閉じ、画面で再接続を案内するだけ。延長や `connection_status` の更新は G4 は行わない。G4 は `social_accounts` を一切書き換えない |
| 利用権 | `service_entitlements('x_autopost')` を POSTONA 全体の利用権として扱う（G5 の決定どおり）。Threads 専用の利用権は作らない |
| 記録 | 投稿の記録は `threads_manual_publish_attempts`（G4 所有）。H5 はこの表を読まない・書かない |

## 6. G5（共通アカウント）への依存

- **T13 フェンス** `private.account_lifecycle_assert_active_service_write(uuid, text)` が本番に存在し、所有者が表の所有者で、アプリ用ロールから実行できないこと。DB 候補は、これが無ければ `THREADS_PUBLISH_PRECONDITION_T13` で止まる。テストでは契約どおりに振る舞う代役を使った（**G5 の実装ではない**）。フェンスのエラーは固定コードに読み替える（AUTH_REQUIRED / SERVICE_NOT_ACTIVE / ACCOUNT_LIFECYCLE_BLOCKED。想定外の失敗も BLOCKED）。
- **T10（退会・削除）**: 新しい2つの表はアカウント・ワークスペースの削除に連動して消える（`on delete cascade`）。さらに既存の `social_mobile_deletion_guard` トリガーを付けたので、POSTONA の削除が始まったワークスペースには何も書き込めない。G5 の削除の集計（フットプリント）に、この2つの表を加えてほしい。投稿済みの Threads の投稿そのものは削除しない（Threads 側の削除 API は別の段階）。

## 7. 本番までの関門（静的ゲートの解除条件）

`THREADS_MANUAL_PUBLISH_PREREQUISITES`（`supabase/functions/social-mobile-threads-publish/logic.ts`）がすべて揃うまで、ゲートは false のまま。

1. `PHASE_2A2_MIGRATION_APPLIED` — 2a-2（Threads を `social_accounts` に入れられるようにする migration）の本番適用。
2. `THREADS_CONNECT_RUNTIME_LIVE` — H5 の接続が本番で動き、テスターの Threads アカウントが `identity_verified` で Vault にトークンを持ち、期限の読み出し口（§5）があること。
3. `COMMON_ACCOUNT_WRITER_FENCE_LIVE` — G5 の T13 フェンスの本番適用。
4. `PUBLISH_LEDGER_APPLIED` — この DB 候補のレビューと本番適用（同日の読み取りだけの事前確認の後、単独ファイルとして）。
5. `META_APP_PUBLISH_READY` — Meta アプリの準備（§8）。
6. `INTEGRATED_SECURITY_REVIEW` — 接続（H5）＋投稿（G4）＋T13（G5）をまとめた1回のセキュリティレビュー（Sol（高）推奨）。
7. `PILOT_APPROVED` — 特定のテスターアカウントでの実投稿について、ユーザーの明示承認。

その後に、Edge Function のデプロイ（JWT 検証 ON）、アプリのリリースフラグを ON にする版、テスター1名で1件の実投稿 → 読み戻し確認、の順。

## 8. 外部（Meta）で必要な準備（ユーザー側の作業。秘密情報はチャットや GitHub に貼らない）

1. Meta for Developers で、Threads のユースケースを持つアプリを用意する（H5 の接続と共通）。
2. アプリの権限に `threads_basic` と `threads_content_publish` を追加する。一般公開には App Review が必要だが、テスター同士なら審査前でも使える。
3. テスターを招待し、テスター本人が Threads の設定（ウェブサイトのアクセス許可）で招待を承認する。テスト用の Threads アカウントは1つで足りる。
4. リダイレクト URI（HTTPS、H5 が決める正確な値）、連携解除コールバック、データ削除コールバックの URL を登録する。
5. アプリシークレットは、Supabase のダッシュボードで Edge Function の secret としてユーザー自身が登録する（チャット・GitHub・TASK には書かない）。
6. 最初の実投稿は、そのテスターアカウントに、明示承認した1件だけ。

## 9. 検証（2026-10-11、すべてローカル・偽データ）

- Deno（`deno test --no-config`）: 送信部 17、手順 27、Edge（logic 10・http 5）を含め `_shared/social` と新しい関数で 86 件 PASS（既存の provider_domain・threads_connect のテストを含む）。`deno lint --no-config` 問題なし。
- 手順の変異テスト（4種、テスト後に元へ戻した）: 「不明を失敗扱いにする」「準備完了を待たずに公開」「再送で再び処理を進める」「FINISHED を公開済みとみなす」→ すべてテストが失敗して検出。
- DB 候補（Homebrew PostgreSQL 17 の使い捨てクラスタ、`postona_threads_publish_run.sh`）: 前提が無いと止まる（2a-2 なし、G5 フェンスなし、フェンスがアプリ用ロールから実行可能、期限の読み出し口なし）／適用・再適用拒否／動作確認（権限・本人・ロール・ワークスペース・接続・許可・トークン期限・冪等・同時実行・許可証・遷移・試行の期限・中断・削除中・連動削除）／同時実行の競合で1件だけ予約／変異6種（フェンス無効化、redeem の許可確認削除、redeem の期限確認削除、claim の比較更新削除、一意索引の削除、redeem を authenticated に開放）→ すべて検出。
- アプリ: `npm test` 252 件 PASS（新規 18 件を含む）、`tsc --noEmit` PASS、`expo lint` 問題なし。

## 10. 決めてほしいこと

1. ワークスペースの `publish_mode` が `dry_run`（自動投稿は試運転）のとき、手動投稿を許すか。今は `disabled` だけ止めている。
2. 手動投稿の許可を「アカウントごと」にしたが、ワークスペース単位にしたいか（今はアカウントごと）。
3. 画面の置き場所。今は Threads アカウントの詳細画面のカード。投稿予定タブ（G3）とつなぐのは、予約投稿の段階で G3 と相談して決める。
