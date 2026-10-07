# POSTONA Phase 2b — Threads 接続の設計メモ（実装前）

- 作成: 2026-10-07（G4、TASK `postona-multisocial-phase2a2-account-schema-candidate-20261007`）
- 前提:
  - Phase 1 の設計 `docs/postona/multi-social-phase1.md`（§3.2 接続アカウント、§5 段階計画）
  - Phase 2a-1 のプロバイダドメイン（`provider-domain.ts` / `_shared/social/provider_domain.ts`）
  - Phase 2a-2 の migration 候補 `20261007150000_postona_social_accounts_multi_provider.sql`（**未適用**）
- 外部仕様: Threads の公式ドキュメント（2026-10-06 取得）。公式で確認できなかったもの・食い違っているものは **要検証** と書く。
- このメモは設計だけで、実装はしない。OAuth のエンドポイント、Meta アプリの資格情報、実アカウントの接続、本番の変更はどれも行っていない。

## 0. 要点

- Threads の接続は X と同じ形にする。アプリが認可画面を開き、戻ってきた `code` と `state` を、ユーザーの JWT 付きで自前の Edge に渡す。Edge がサーバー側でトークンを交換し、1つの RPC が1トランザクションで書き込む。
- 保存するのは**長期 access トークン1つ**だけ。Vault に入れ、`social_accounts` には参照（uuid）だけを書く。refresh 参照は NULL（2a-2 の CHECK が強制）。短期トークンは保存しない。
- 接続しても `publish_enabled=false` で始まる。2a-2 の CHECK により、Threads の行はどの経路でも ON にできない。ON を許すのは、Threads の送信経路をレビューした後の別の migration。
- 未確定の点が3つある:
  - リダイレクト URI にカスタムスキームを使えるか
  - ユーザーのトークンを revoke する API があるか
  - API のホスト名（`threads.com` と `threads.net` が文書内で混在）
- 共通アカウントとサービス利用権（G5）には触れない。接続は利用権を作らず、変えず、判定もしない。

## 1. 2b でやること・やらないこと

やること（2b の範囲）:
- Threads アカウントの接続、再接続、本人確認
- Vault への長期トークンの保存
- アカウント画面への表示（`supabase-repository.ts` はすでに `threads` を表示用に受け付ける）

やらないこと:
- 投稿（コンテナの作成と公開）
- 長期トークンの延長（`th_refresh_token`）。2c で行う（§4）。
- Instagram
- 利用権の変更
- 退会の状態機械の変更。G5 と合意してから行う（§8）。

## 2. 認可コードの流れ

1. **begin**: アプリから新しい Edge `threads-oauth-connect-user`（`verify_jwt=true`）を呼ぶ。
   - Edge は RPC `begin_social_mobile_threads_oauth_connection`（`authenticated` のみ、SECURITY DEFINER、`search_path=''`）を呼ぶ。
   - RPC は次の処理をする:
     - 呼び出した本人の自分用ワークスペースに owner として所属していることを確認する
     - `platform='threads'` の行を用意する（id は X と同じ作り方で `'sa_' || substr(md5(brand_id || ':threads'), 1, 24)`。id の CHECK を満たす）
     - `social_account_oauth_states` に state のハッシュだけを保存する
   - Edge は認可 URL を返す:
     ```
     https://threads.com/oauth/authorize?client_id=…&redirect_uri=…&scope=threads_basic,threads_content_publish&response_type=code&state=…
     ```
   - スコープについて:
     - `threads_basic` は必須。
     - `threads_content_publish` は 2c 以降の投稿で使う。
     - `threads_delete` は投稿の削除を出すときに別に追加する。
   - state は Threads 側では任意だが、こちらでは必須にする。
   - PKCE が使えるかは文書に記載がない（**要検証**）。

2. **認可**: ユーザーが Threads の認可画面で許可すると、`redirect_uri` に `code` と `state` が付いて戻る。
   - `code` は1時間有効で、1回しか使えない。
   - 末尾に付く `#_` は `code` の一部ではないので取り除く。
   - 拒否されたときは `error=access_denied` が返る。この場合は何も書かず、「未接続」に戻す。

3. **交換**: Edge の中だけで行う。アプリには app secret も、どのトークンも渡さない。
   1. state を消費する前に確認する（本人・期限・未使用）。
   2. `POST https://graph.threads.com/oauth/access_token` で短期トークン（1時間）と `user_id` を受け取る（`grant_type=authorization_code`、`redirect_uri` は begin と完全に同じ）。
   3. `GET https://graph.threads.net/access_token?grant_type=th_exchange_token` で長期トークン（約60日、`expires_in`）に交換する。
   4. `GET https://graph.threads.net/v1.0/me?fields=id,username` で本人情報を取る。
   - 注意: ホスト名が文書内で `graph.threads.com` と `graph.threads.net` に分かれている（**要検証**）。

4. **complete**: RPC `complete_social_mobile_threads_oauth_connection` が1トランザクションで次をすべて行う:
   - state を消費する
   - 所有者を確認する
   - state に結び付いた行が `platform='threads'` であることを確認する
   - 本人情報を照合する（§3）
   - Vault に書き込む（§5）
   - 行を更新する: `connection_status='identity_verified'`、`verified_at`、`platform_user_id`、`handle`、`publish_enabled=false`、`last_connection_error_code=null`
   - X と同じく、ユーザーの JWT（`authenticated`）で呼び、`service_role` では呼ばない。

## 3. 本人情報の結果（必須）

- **プロバイダのユーザー id**: 交換の応答の `user_id` と、`/me` の `id` が一致しなければ失敗にする（`THREADS_IDENTITY_MISMATCH`）。文字列として保存する（数値として扱わない）。
- **ハンドル**: `/me` の `username` を `handle` にする。表示用で、照合には使わない。
- **再接続**: 行に `platform_user_id` がすでにあり、今回の id と違う場合は拒否する（X の `X_IDENTITY_ACCOUNT_MISMATCH` と同じ扱い）。別のアカウントに付け替えたいときは、先に切断する。
- **一意性**: 既存の一意インデックス `(platform, platform_user_id)` により、同じ Threads アカウントを2つのワークスペースに接続することはできない。違反したら `failed` と `THREADS_ACCOUNT_ALREADY_CONNECTED` にする。X と Threads で id の文字列が偶然同じでも衝突しない（2a-2 の使い捨て DB で確認済み）。
- `is_verified`（公式マーク）は保存しない。必要になったら別途決める。

## 4. 短期トークンから長期トークンへの交換の境界

- 2つの交換はどちらも Edge の中で行う（app secret を使うため。公式も「サーバー側のみ」としている）。
- **短期トークンは保存しない**。メモリ上で長期トークンへの交換に使ったら、すぐ捨てる。ログ、応答、例外のメッセージにも出さない。
- `code` を使った後で交換に失敗した場合、`code` は再利用できない。行は `failed` と固定のコードにして、ユーザーには最初からやり直してもらう。Vault には何も書かない。
- 長期トークンの延長:
  - 発行から24時間以上たち、期限前であれば延長できる。延長すると、そこから60日有効になる。
  - 延長の応答で、トークンの文字列が変わるかどうかは文書からは断定できない（**要検証**）。どちらでも安全なように、同じ secret id に `vault.update_secret` で上書きする設計にする。
  - 延長は 2c で行う。
- **2a-2 では有効期限を保存していない**:
  - 延長の時期を管理するには、`expires_at` の列か、X の `x_account_refresh_state_v2` に当たる状態表が要る。
  - これは別の migration として 2c で決める。
  - 2b だけ（テスターの段階）では、60日後に接続が失効する。そのときは再接続で回復する。

## 5. 保存（Vault の参照だけ）

- 長期トークンを `vault.create_secret(token, '<account_id>_access_token', …)` で保存する。再接続のときは `vault.update_secret` で上書きする。
- `vault_access_token_secret_id` に参照を書く。`vault_refresh_token_secret_id` は NULL のまま（2a-2 の `social_accounts_provider_credential_profile` が強制する）。
- 平文のトークンを入れる列は作らない（2a-2 の postcondition と使い捨て DB で確認済み）。
- 1つの secret を複数の行で共有しない。既存の確認が、プロバイダを問わず全行を見ている:
  - `x_legacy_post_account`
  - 投稿許可のスイッチ
  - 退会の `ownership_problem`
  - Threads の行が X の secret を共有すると、X の送信が `X_REFRESH_SECRET_REF_SHARED` で止まる（確認済み）。
- **state の取り違えへの備え**:
  - `social_account_oauth_states` は X と Threads で共有する。
  - Threads の complete は、state の行が Threads であることを必ず確かめる。
  - 逆に、Threads の state が X の complete に渡っても、X の complete は refresh 参照を書くので、2a-2 の CHECK に違反して失敗する（安全側に止まる）。
  - X の consume / complete に `platform='x'` の確認を足すかは、X OAuth の持ち主（G5）と相談する。

## 6. `publish_enabled=false` で開始

- complete は常に `publish_enabled=false` を書く。
- 2a-2 の `social_accounts_meta_publish_disabled` により、Threads / Instagram の行は ON にできない:
  - 列の既定値がどうであっても、ON の行を作るとエラーになる。
  - 既定値に頼って作った行もエラーになる（既定値が true の fixture でも確認済み）。
- 投稿許可のスイッチは、X 以外を `PLATFORM_NOT_SUPPORTED` で拒否する。送信前の確認は、Threads の id を `X_CLAIM_ACCOUNT_MISMATCH` で拒否する（確認済み）。
- ON を解禁する順序（2c 以降）:
  1. Threads の送信アダプタと送信前の確認をレビューする
  2. Threads の行だけについて、CHECK を緩める migration を入れる
  3. スイッチを Threads に対応させる

## 7. リダイレクト URI とコールバック（要検証）

- Threads は、`redirect_uri` が App Dashboard に登録した「有効な OAuth リダイレクト URI」と完全に一致することを求める。文書の例は https だけ。
- X で使っている `kabumori-social://oauth-callback` のようなカスタムスキームが通るかは **要検証**。
- 通らない場合の案は2つ（**要決定**）:
  - **A. ユニバーサルリンク / App Links**（`https://<自社ドメイン>/oauth/threads`）でアプリを開く。
    - アプリが `code` と `state` を受け取り、X と同じく JWT 付きで Edge に渡す。
    - 必要なもの: Associated Domains の設定、`apple-app-site-association` の公開、Expo の設定。
    - 「ユーザーの JWT で完了する」という X の設計をそのまま保てる。
  - **B. Edge が https のコールバックを直接受ける**。
    - ブラウザからの戻りにはユーザーの JWT が付かないので、state に記録した開始者で完了させることになる。
    - X の設計が意図して避けた形なので、採るなら別途セキュリティレビューが必要。
  - 推奨は **A**。
- Android では、認可 URL を Threads アプリではなくブラウザで開く（公式の注意）。
- App Review のために、「連携解除のコールバック URL」と「データ削除リクエストの URL」の登録が要る。
  - どちらも認証なしで届くので、署名の検証が必須。
  - Threads でのペイロードの形式（Facebook Login の `signed_request` と同じか）は **要検証**。

## 8. 切断・revoke の不確実性

- 取得した Threads の文書には、**ユーザーのトークンを revoke する API が見当たらない**（X には `POST /2/oauth2/revoke` がある）。`DELETE /{user-id}/permissions` のような手段が Threads にあるかは **要検証**。
- 確認できるまでの「切断」の扱い:
  - Vault の secret を削除し、参照を NULL にして、`connection_status='unconnected'` にする（ローカルだけの切断）。
  - Threads 側のアプリ連携の解除は、ユーザー自身に案内する（設定の場所は **要検証**）。
- ユーザーが Threads 側で連携を解除した場合:
  - 連携解除のコールバックで該当する行を切断状態にし、secret を削除する。
  - 新しい Edge エンドポイントになり、認証なし・署名検証で動くので、レビュー対象。
- **退会（既存の処理、G5 が所有）**:
  - 現状、Threads を接続済みのワークスペースは `operator_required`（`CREDENTIAL_MATERIAL_MISSING`）に止まる。Threads のトークンが X の revoke に渡ることはない（2a-2 の使い捨て DB で確認済み）。
  - 一般ユーザーに Threads の接続を出す前に、退会をプロバイダ別に対応させる必要がある:
    - X の行だけを X の revoke に渡す
    - Threads の行は Vault を削除し、revoke できる手段があればそれも行う
  - そうしないと、Threads を接続したユーザーの退会は毎回オペレーター対応になる。
  - 退会の状態機械（`x_revoked` などの状態名を含む）は G5 の範囲なので、合意してから行う。

## 9. G5（共通アカウント・サービス利用権）と分けておく場所

1. **利用権を作らない・変えない**:
   - Threads の接続は、`common_accounts` と `service_entitlements` に書き込まない。
   - サービスの開始・再開は G5 の RPC（`start_x_autopost_service()`、`reactivate_x_autopost_service(bigint)`）だけが行う。自動の開始は、終了したサービスを再開しない（`20261006230000`）。
2. **入口の判定**: アプリの Threads 接続の入口は、G5 のオンボーディング / AuthGate の内側に置く。独自の利用権判定は作らない。
3. **ワークスペースを作るのは誰か**（**要決定**）:
   - X の begin RPC は、ワークスペース（`brands` と owner の所属）がなければ作る。
   - Threads だけを使うユーザーのワークスペースを誰が作るかを決める:
     - Threads の begin も作る
     - POSTONA のサービス開始（G5）に一本化する
   - 推奨は「作る場所を1つにする」こと。決まるまで、Threads の begin はワークスペースを作らず、既存の自分用ワークスペースへの owner の所属だけを確認する。
4. **退会の足跡**:
   - G5 の `private.account_lifecycle_footprint` は、ワークスペースの `social_accounts` を、プラットフォームを問わず `x_autopost` の足跡として数える。つまり Threads の行も POSTONA（`x_autopost`）の足跡になり、新しい `service_key` は要らない。
   - `x_autopost` という名前の扱いは、Phase 1 §9-8 の決定事項のまま。
5. **送信時の利用権**:
   - `vault_account_brand_post.ts` の冒頭に書かれた G5 の境界（送信判定・権限ウィンドウ・予約投稿の claim の3か所で、`x_autopost` の利用権が有効であることを確認する）は、Threads の送信経路にも同じ位置で必要になる。
   - 2b は送信しないので対象外だが、Threads 送信（2c）の前提条件。
6. **退会の状態機械**: サービスのみの退会・全体の退会とも G5 が所有する。Threads の資格情報の後始末（§8）は、G5 と合意してから入れる。

## 10. 2b の実装単位（案）と検証

- 本番の順序（どれも承認制）:
  1. 2a-2 の migration を適用する（同日の読み取り専用 preflight の後、ファイル単体で）
  2. 2b の RPC の migration を適用する
  3. Edge を deploy する（`verify_jwt=true`）
  4. Supabase secrets に `THREADS_APP_ID` / `THREADS_APP_SECRET` を設定する（ユーザーの承認が必要。secrets の設定で全関数のバージョンが上がる点に注意）
  5. Meta アプリの設定（ユーザー）
  6. テスターだけで確認する
- 使い捨て DB でのテスト:
  - 所有者への紐付け
  - state が1回しか使えないこと
  - Threads 以外の state を拒否すること
  - 本人情報の不一致、同じ Threads アカウントの二重接続、再接続で別アカウントになる場合を拒否すること
  - Vault に参照だけが書かれること
  - `publish_enabled=false` で始まること
  - 失敗したときに何も書かれないこと
  - 変異テスト
- 偽プロバイダの E2E: Threads の API は呼ばない。
- 既存の X のテスト（投稿許可、退会、Stage 3B）が、そのまま通ること。

## 11. 要検証・要決定の一覧

| # | 内容 | 種類 |
| --- | --- | --- |
| T1 | リダイレクト URI にカスタムスキームを使えるか | 要検証 |
| T2 | A（ユニバーサルリンク）と B（Edge のコールバック）のどちらにするか | 要決定（推奨 A） |
| T3 | API のホスト名（`threads.com` / `graph.threads.com` / `graph.threads.net`）のどれが正しいか | 要検証 |
| T4 | PKCE に対応しているか | 要検証 |
| T5 | ユーザーのトークンを revoke する API があるか | 要検証 |
| T6 | 連携解除・データ削除のコールバックのペイロードと署名 | 要検証 |
| T7 | 延長したときにトークンの文字列が変わるか | 要検証 |
| T8 | 有効期限の保存場所（列か状態表か） | 要決定（2c） |
| T9 | Threads だけのユーザーのワークスペースを誰が作るか | 要決定（G5 と） |
| T10 | 退会をプロバイダ別に対応させる範囲と時期 | 要決定（G5 と） |
