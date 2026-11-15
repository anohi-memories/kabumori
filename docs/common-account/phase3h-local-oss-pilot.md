# 共通アカウント Phase 3h — ローカル OSS（Supabase + Keycloak）での認証の小さな実測

- TASK: `common-account-phase3h-local-oss-keycloak-safe-pilot-20261011`（G5）。実施は 2026-10-11 夜〜2026-10-12 未明（JST）。
- **結論: `LOCAL_OSS_PARTIAL_EVIDENCE`** — 隔離したローカル環境が安全に起動し、実際の GoTrue と Keycloak で E2・E3・E4・E5・E7・E8・E9・E10 の小さな実測に成功した。
  - ただし、「BAN は本人確認方法の追加を止める壁になる」という期待に反する挙動を **3 件再現**した（§4 の F1〜F3）。
  - TASK の定義では `LOCAL_OSS_FAIL`（実測の安全性違反を再現）にも当たりうる。どちらに分類するかは K5 の判断。
- **これは managed Supabase の PASS ではない。** 版も設定も権限も異なる OSS 構成での観測である（§6）。
  - E11（`auth.users` の SQL 削除）と E12（ガードの適用）は実施していない。
  - `IDP_PREPAUSE_BLOCKED`、`managed_auth_delete` の gate（blocked）、Option D の扱いは変わらない。
- 外部への通信は、公開レジストリからのイメージ取得だけ。実プロジェクト・Auth0・Google・GitHub・写真アプリには一切接続していない。

## 1. 環境（実測）

| 項目 | 値 |
| --- | --- |
| ホスト | Mac（Apple silicon、メモリ 24 GiB）、Podman 6.1.1 |
| 専用の仮想マシン | `g5-local-pilot`（CPU 4、メモリ 8 GiB、ディスク上限 40 GiB）。終了後に削除した。既存の `podman-machine-default` は起動も設定変更もしていない（停止したまま・2 GiB のまま。Supabase CLI が一度だけ接続を試みて失敗した、§3 の P1） |
| スタック | Supabase CLI 2.116.0 のローカルスタック: GoTrue **v2.196.0**、PostgreSQL 17.6.1.165、PostgREST v16.1、Storage API v1.70.3、Kong 2.8.1。除外: studio、realtime、edge-runtime、analytics、vector、imgproxy、mailpit、supavisor、postgres-meta |
| テスト用 IdP | Keycloak 26.8.0（`start-dev`、組み込みの Keycloak プロバイダ経由）。偽ユーザー 16 人（メールは `@example.test`）、クライアント 1 つ |
| 使用資源 | 仮想マシンのメモリ使用 約 2.3 GiB（コンテナ合計 約 1.3 GB、うち Keycloak 約 850 MB・Storage 約 250 MB）、ディスク使用 5.7 GiB、イメージ合計 約 2.9 GB（展開後） |
| 所要時間 | スタックの起動は 1〜2 分（初回はイメージ取得）。ケースの実行は Boot ごとに数分。待機を含む E9（期限切れの確認）と B の有効期限テスト（310〜330 秒の待機）が最長で、それぞれ 5〜6 分 |
| 確認済みの隔離 | 公開ポートは `127.0.0.1` の 3 つ（55421: API、55422: DB、55480: Keycloak）だけ。`lsof` で全インターフェースへの待ち受けがないことを確認 |

## 2. 構成と再現手順

再現用のツールは `tools/common-account-local-pilot/` にある（秘密情報なし、fail-closed）。

1. 専用の仮想マシンを作る（`podman machine init g5-local-pilot --cpus 4 --memory 8192 --disk-size 40`、起動）。
2. **仮想マシン内**で、公開ポートの既定の IP をループバックにする（§3 の落とし穴 P2）:
   `/etc/containers/containers.conf.d/60-g5-loopback.conf` に `[network]` と `default_host_ips = ["127.0.0.1"]`。サービスを再起動する。
3. 専用の `supabase init --workdir <リポジトリ外>` を行い、`prepare.py` で `config.toml` と Keycloak のレルム（偽ユーザー・偽パスワード・偽 secret はすべてリポジトリ外のワークディレクトリに生成）を作る。
4. Keycloak を同じ隔離ネットワークで起動する（`-p 127.0.0.1:55480:8080`、別名 `keycloak`、レルムは読み取り専用でマウント）。
5. `CONTAINER_CONNECTION=g5-local-pilot` を付けて `supabase start --network-id supabase_network_g5-p3h -x studio,realtime,edge-runtime,logflare,vector,imgproxy,mailpit,supavisor,postgres-meta` を実行する。
6. `G5_LOCAL_PILOT_CONFIRM=G5_OWNED_PODMAN_MACHINE_g5-local-pilot` と `P3H_WORK=<ワークディレクトリ>` を付けて `cases.py A`（手動連携 off）→ `A9` → スタックを入れ替えて `B`（手動連携 on）→ `extra.py` → `C`（フック on）を実行する。
7. 終了時: `supabase stop --no-backup`、Keycloak とネットワークを削除し、専用の仮想マシンを停止・削除する。
8. 確認: 他のマシンが無変更であること、公開ポートが残っていないこと、既定の接続が既存マシンのままであること。

## 3. 実際に踏んだ落とし穴

| # | 内容 | 対処 |
| --- | --- | --- |
| P1 | Supabase CLI 2.116 は、`DOCKER_HOST` を設定しても既定の Podman 接続（停止中の既存マシン）に接続しようとして失敗した。既存マシンは起動されなかった | `CONTAINER_CONNECTION=g5-local-pilot` を付ける |
| P2 | **CLI が公開するポートは、既定では全インターフェースで待ち受ける**（API と DB がホストのネットワーク全体から到達可能になる。DB の既定パスワードは弱い） | 仮想マシンの `containers.conf.d` で `default_host_ips = ["127.0.0.1"]` を設定し、再起動後に `lsof` で確認 |
| P3 | `podman machine start` が、ホストの `docker.sock` と `podman.sock` のシンボリックリンクを G5 のマシンへ向けた | 削除後に `podman.sock` を既存マシンの API ソケットへ戻した |
| P4 | Keycloak の組み込みプロバイダは、`profile email` しか要求しないため userinfo が 403 になる（`error getting user profile`） | 認可リクエストに `scopes=openid` を付ける |
| P5 | Keycloak の issuer は `Host` ヘッダーから決まる | ドライバは接続先を 127.0.0.1 に固定したまま、`Host: keycloak:8080` を送る |
| P6 | Keycloak の認可コードの有効期間が既定で 60 秒で、遅延テストが成り立たない | レルムで 900 秒に延ばした |
| P7 | PostgREST は期限切れ直後の JWT を受け付ける（期限後 +5 秒で受理、+75 秒で `PGRST303`） | 期限切れの対照は 90 秒以上後に行った。最初の対照は 3〜5 秒後で、誤って FAIL と判定した（F5 と下の注記） |

注記（誤りの訂正）: 最初の E9 の対照で、期限切れトークンを PostgREST が受け付けたため FAIL と記録した。原因は、確認が期限の 3〜5 秒後で、PostgREST の許容時間内だったことだった。確認の時刻を変えて取り直し、結果を C13a / C13 に分けて記録している。

## 4. ケースの結果

結果の区分: PASS = 期待どおり、PARTIAL = 一部のみ、NOT_RUN = 未実施。証跡はすべて匿名化（ID・メール・トークンなし）。

### 環境（E1 のローカル版）

| ケース | 期待 | 観測 | 結果 |
| --- | --- | --- | --- |
| C0 版と設定 | 版と非秘密の設定が記録される | GoTrue v2.196.0、PostgreSQL 17.6、Keycloak 26.8.0。`GOTRUE_JWT_EXP=120`、手動連携は Boot A で off・Boot B/C で on、監査ログのテーブルあり | PARTIAL（ローカルの値であり managed の E1 ではない） |

### E2 — BAN と自動連携

| ケース | 観測 | 結果 |
| --- | --- | --- |
| C1 対照（BAN なし） | 同じ確認済みメールの Keycloak ユーザーが、既存ユーザーに自動で連携された（providers = email, keycloak）。コード交換 200 | PASS |
| C2 BAN 済み | コールバックは `user_banned` で拒否。識別情報は追加されず、ユーザー数は 1 → 1、セッションは 0 | PASS |

### E3 — 手動連携

| ケース | 観測 | 結果 |
| --- | --- | --- |
| C3 既定 | 無効のとき `/user/identities/authorize` は 404 `manual_linking_disabled` | PASS |
| C4 有効・BAN なし | 連携が成功（email, keycloak）。同じユーザーのままコード交換 200 | PASS |
| C5 BAN 後に連携を開始 | BAN 前に取得したトークンでも 403 `user_banned` | PASS |

### E4 — BAN 前に始めた手動連携（核心）

| ケース | 観測 | 結果 |
| --- | --- | --- |
| **C6 連携を開始 → BAN → ログイン完了** | **連携が完了した**（providers = email, keycloak）。識別情報の作成時刻は BAN の更新時刻の約 0.24 秒後。コード交換は 200。BAN 前のトークンでの `GET /user` は 403 | **LINKED_AFTER_BAN（F1）** |
| C6 詳細 | コード交換が `access_token` と `refresh_token` を返し、**BAN 済みユーザーに新しいセッションが作られた**（セッション数 2）。新しい access token は `GET /user` 403、refresh 400、logout 403、パスワードでのサインイン 400 だが、**PostgREST への書き込みは 201 で受理**された | **F2** |
| C7 フローの有効期限 | Keycloak のログイン完了後、GoTrue のコールバックを 20 秒後に呼ぶと連携。**310 秒後・330 秒後は `bad_oauth_state`（"OAuth state has expired"）で拒否**され、識別情報は追加されない | PARTIAL（2 点のみ。有効期限は 20 秒より長く 310 秒以下で、ソース上の下限は 300 秒） |

### E5 — refresh・ID token・logout

| ケース | 観測 | 結果 |
| --- | --- | --- |
| C8a BAN 後 | refresh 400 `user_banned`、パスワード 400 `user_banned`、logout 403、`GET /user` 403（BAN 前のトークン） | PASS（v2.196.0。v2.195.0 以降の挙動） |
| C8b logout を BAN より前に | logout 204、セッション 0、refresh は `refresh_token_not_found` | PASS |
| C8c / C8d ID token | BAN なしは 200。BAN 済みのユーザーは 403 `user_banned` | PASS |

### E6 — 小規模な同時実行（PARTIAL のみ）

| ケース | 観測 | 結果 |
| --- | --- | --- |
| C15 同じ確認済みメールの偽 ID 8 件のコールバックを同時に開始し、+0 / +50 / +150 ms で BAN（3 ラウンド） | +0 ms: 8 件とも `user_banned`。+50 ms・+150 ms: 8 件とも連携済み（BAN より前に完了。BAN 後に作られた識別情報は 0） | PARTIAL |
| C15 追加（+10 / +20 / +30 / +50 / +80 / +120 ms） | **+10 ms のラウンド: 8 件とも連携され、うち 7 件の識別情報が BAN の更新時刻より後に作成された（F3）。** それ以外のラウンドは BAN 後に作成された識別情報が 0 | PARTIAL_COUNTEREXAMPLE_OBSERVED |

### E7 — Custom Access Token hook

| ケース | 観測 | 結果 |
| --- | --- | --- |
| C16 通常ユーザー | パスワードでのサインインは 200。フック有効時の中央値 67 ms（フックなしの基準は測っていない） | PASS |
| C17 `deleting` | パスワード・refresh ともに 403（フックのメッセージ） | PASS |
| C18 自動連携 + 交換 | コールバックでは識別情報が確定（email, keycloak）し、**トークンはコード交換の段階で 403 に拒否**された（PR121 の V10 を実機で確認） | PASS_V10_CONFIRMED |
| C19 手動連携 | 連携開始後に `deleting` にした。識別情報は確定し、交換は 403 | PASS_V10_CONFIRMED |
| C20 フックの障害 | 関数が無い間は、**無関係なユーザーのサインインも 500**。復旧後は 200 | PASS_BLAST_RADIUS_CONFIRMED |

### E8・E9・E10 — 削除・古いトークン・監査

| ケース | 観測 | 結果 |
| --- | --- | --- |
| C9 Admin の削除（auth スキーマ） | 識別情報 2・セッション 3・refresh 3 を事前に記録し、削除後に同じ ID で数えて全部 0。ユーザー 0 | PASS（auth スキーマだけ。ライフサイクル層は適用していない） |
| C10 監査 | `identity_linked` の監査行は削除後も 1 件残り、`user_deleted` の行が 1 件作られた | PASS |
| C11 Storage の所有ファイルがあるユーザー | 削除は 200 で成功（`storage.objects` に auth.users への外部キーなし）。メタデータ 1 行と実ファイル 1 つが残った | PASS |
| C12 古い有効なトークン | logout・BAN・削除の後でも、**PostgREST は 201、Storage は 200 で書き込みを受理**。拒否したのは `GET /auth/v1/user`（403）だけ。削除済みユーザーの `owner_id` で行・ファイルがさらに作られた（F4） | PASS（観測として）／F4 |
| C13a 期限の直後（+4〜7 秒） | PostgREST は 201 で受理、Storage は 400、`GET /user` は 403 | PARTIAL（F5） |
| C13 十分に過ぎた後（90 秒以上） | PostgREST 401、Storage 400、`GET /user` 403 | PASS |
| C14 削除後の実ファイル | 4 人分のファイルがすべて残った（削除済みユーザーの分は 2 つ） | PASS（F6） |

### 未実施

| 項目 | 理由 |
| --- | --- |
| E11（SQL で `auth.users` を削除）、Option D | この TASK で禁止。実施していない |
| E12（PR121 のガードの適用と競合テスト） | ライフサイクル層（Phase 1〜3a のスキーマ）をこのスタックに載せていない。NOT_RUN |
| E1 の managed 版、E2〜E12 の managed 版 | 対象外。全件 NOT_RUN |
| E6 の大規模版（約 200 件） | 実施しない（PARTIAL の小規模版のみ） |

## 5. 再現できた安全上の知見

| # | 知見 | 影響（A+B 方式に対する前提条件の候補。方式の選択ではない） |
| --- | --- | --- |
| F1 | BAN の前に始めた手動連携は、BAN の後でも完了する（C6）。コールバックは BAN を確認しない | BAN は「すでに始まった手動連携」を止めない。待機時間は少なくともフローの有効期限（観測: 310 秒で失効、ソース上の下限 300 秒）を覆う必要がある |
| F2 | その連携のコード交換は、BAN 済みのユーザーに新しいセッションと access token を発行する（C6 詳細）。その token は PostgREST では有効 | 「BAN の前にセッションを失効する」だけでは足りない。待機の**後**に、セッションの再失効と ID の再確認が必要 |
| F3 | 自動連携でも、BAN の約 10 ms 前に始まった処理は、BAN の更新時刻より後に識別情報を作る（C15）。BAN は「進行中の処理」を止めない | リクエスト処理時間の分の待機と、進行中の処理の確認が必要。コミットの順序そのものは観測していない（作成時刻と更新時刻の比較） |
| F4 | access token は状態を持たない JWT。logout・BAN・削除の後でも、有効期限まで PostgREST と Storage は受け付け、削除済みユーザーの ID で行やファイルを作れる | ガード（PR121）を呼ぶ書き込み口だけが守られる。ガードを呼ばない書き込み口と Storage は別の対策が必要 |
| F5 | PostgREST は期限切れ直後の JWT を数秒だけ受け付ける | 期限切れの確認は期限の十分後に行う |
| F6 | Admin の削除は Storage を掃除しない。メタデータも実ファイルも残る。削除は阻まれない | Storage の所有オブジェクトの掃除は別の手順（検査 → 削除 → 再検査）が必要（Phase 3a の設計どおり） |
| F7 | フックはトークン発行だけを止める。識別情報の確定は止められない（V10）。フックの障害は全ユーザーのサインインを止める | フックは補助にとどまる。障害時の影響範囲が大きい |
| F8 | Keycloak の組み込みプロバイダは `scopes=openid` が必須 | アプリ側の設定事項 |
| F9 | Admin の削除は `user_deleted` の監査行を作り、`identity_linked` の監査行は残る | SQL での削除（Option D）の場合は、この監査行が作られるかの比較が必要（E11 の対象。今回は未実施） |

## 6. managed Supabase に引き継げない部分

- 版と設定: managed の GoTrue の版・手動連携の設定・フローの有効期限・リクエスト時間の上限は不明。
- 権限: このスタックでは `supabase_admin` で読み取った。managed の `postgres` が `auth.*` に何をできるかは不明（Phase 3d の W 系の確認が必要）。
- プラットフォーム: gateway（Kong 以外の経路）、レート制限、監査ログの保存設定、Storage の S3 バックエンド（ここは file バックエンド）、ネットワーク経路は別。
- IdP: ここでは組み込みの Keycloak。**独自 OIDC プロバイダ（https 必須の issuer、`custom:` の経路）は実行していない**。managed で使う Auth0 経路とは別。
- Apple 固有の挙動、複数の独立した主体の大規模な同時実行（E6）、SQL 削除（E11）、ガードの適用（E12）は未検証。
- **結果は `LOCAL_OSS_EVIDENCE` であり、managed の PASS として数えない。**

## 7. 後片付けの証拠

- `supabase stop --no-backup` の後、コンテナ 0・ボリューム 0。Keycloak とネットワークを削除し、仮想マシン `g5-local-pilot` を停止・削除した。
- 確認: `podman machine list` に既存の `podman-machine-default`（停止中・2 GiB）だけが残る。既定の接続は既存マシンのまま。`55421`〜`55480` の待ち受けは 0。専用のファイル（EFI ストア、ロックファイル）を削除し、`podman.sock` のシンボリックリンクを既存マシンへ戻した。
- 生成した偽の secret・偽のパスワード・レルムは、リポジトリ外のスクラッチ領域にだけ存在し、コミットしていない。

## 8. ツールの安全性（オフラインのテスト）

`tools/common-account-local-pilot/test_fail_closed.py`（7 件）で、次を確認している:
- 確認用の環境変数が無ければ起動を拒否する。ワークディレクトリがリポジトリ内なら拒否する。
- HTTP クライアントは 2 つのループバックのルートにしか接続しない（それ以外の外部ホスト・DB ポート・`localhost`・メタデータ用アドレス・別ポートは拒否）。
- `prepare.py` は偽の値だけを生成し、秘密のファイルを 0600 にする。
- ソースに、外部のホスト・秘密情報・シェル実行・`delete from auth.users`・`supabase link`・`db push` がない。

注意: これらの安全装置（確認用の環境変数、ワークディレクトリのチェック）は、実測の**後**に追加した。ケースの処理自体は実測時のものから変えていない。装置を加えた版でスタックを再度起動しての再実行は、していない。
