# 共通アカウント Phase 3g — 無料の OAuth / OIDC テスト環境の実現性（写真アプリを止める前の判定）

- TASK: `common-account-phase3g-free-auth-provider-test-readiness-20261011`（G5）。2026-10-11 JST に調べた。公開文書と公開ソースのみ。
- 判定の対象: PR122 / PR130 / PR134 の E1〜E12（変更していない。Draft PR122 `f17a47e3`、PR130 `5943fad5`、PR134 `1d4de2c7`）。
- やっていないこと（すべて 0 件）:
  - 実プロジェクトやプロバイダへの呼び出し、アカウント作成、ログイン、秘密情報の扱い
  - 写真アプリの一時停止、プロジェクト操作、課金

## 結論

**`IDP_PREPAUSE_BLOCKED`** — 無料で用意できる道はあるが、まだ用意されていない。下の §6 の利用者だけができる準備が終わるまで、家族写真アプリ（`anohi-memories`）は止めない。

- **managed（実 Supabase）で、無料のまま E2〜E5・E7〜E12 を行える見込み**:
  - 外部の無料 OIDC 発行元（例: Auth0 の無料テナント）を、独自 OIDC プロバイダとして使う。無料プランでも 3 件まで登録できる。
  - テストユーザーは、そのテナント内に作る偽ユーザー（メール確認済みフラグ付き）。
- **E6（約 200 件の同時実行）は、managed では完全な形では NO_GO**:
  - 既定のレート制限が、同じ IP からのサインインで 5 分あたり 30 件。
  - 規約に沿って 200 個の独立したアカウントを用意する手段もない。
  - 20 件以下の小規模な試行に留め、結果は常に PARTIAL / UNKNOWN として扱う。
- **Apple 固有の挙動は NO_GO**。有料の Apple Developer Program が必要なため、購入はしない。
- **写真アプリを止めずにできる代替**: ローカルの Supabase スタック（OSS の GoTrue・PostgREST・Storage）と、組み込みの Keycloak プロバイダを使う。E2〜E12 の多くを試せる。
  - ただし、結果は「OSS の証拠」であり、managed の PASS ではない（§5）。
  - 実行するには、別の TASK と承認が必要（コンテナイメージのダウンロード、Podman のメモリ増設）。

## 1. 確認した事実（2026-10-11 JST に閲覧）

| 事実 | 出典 |
| --- | --- |
| 独自 OAuth / OIDC プロバイダは **Free で 3 件まで**（Pro 以上は無制限）。OIDC は issuer のディスカバリで設定し、PKCE は自動 | [Custom OAuth/OIDC Providers](https://supabase.com/docs/guides/auth/custom-oauth-providers) |
| 独自 OIDC の issuer は **https 必須**で、localhost・ループバック・プライベート・リンクローカルの IP に解決されるものは拒否される（ローカルの IdP は独自 OIDC としては使えない） | GoTrue `ce9a8ee` の `internal/utilities/url_validator.go` と `internal/api/custom_oauth_admin.go`（`validateProviderURLs`） |
| 独自 OIDC は IdP の `email_verified` を「メール確認済み」として扱う（自動連携に必要） | GoTrue `ce9a8ee` の `internal/api/provider/custom_oauth.go` |
| ID token での sign-in は `custom:` プロバイダと Keycloak を受け付ける | GoTrue `ce9a8ee` の `internal/api/token_oidc.go` |
| 組み込みの Keycloak プロバイダは、設定された URL を使い、上記の URL 検証を通らない（ローカルの Keycloak を使える） | GoTrue `ce9a8ee` の `internal/api/provider/keycloak.go` |
| Auth Hooks: Before User Created と Custom Access Token は **Free・Pro** で利用可能。Postgres の hook は 2 秒以内に終える必要がある | [Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks) |
| 手動連携（linkIdentity）は beta で、既定では無効。設定で有効にする | [Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking) |
| 既定のレート制限: サインアップ・サインインは IP ごとに 5 分あたり 30 件（バースト 30）、token エンドポイントは 5 分あたり 150 件、組み込みのメール送信は 1 時間あたり 2 通 | [Rate limits](https://supabase.com/docs/guides/auth/rate-limits) |
| Free で active にできるのは 2 プロジェクトまで。一時停止中のものは数に入らない | [Pricing](https://supabase.com/pricing)、[Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)（Phase 3d で確認） |
| GitHub: 無料の個人アカウントは 1 人 1 つ。マシンアカウントは 1 つまでで、自動処理専用 | [GitHub Terms of Service](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) |
| Google OAuth の Testing 状態: テストユーザーは 1 プロジェクトで生涯 100 人まで。実在の Google アカウントが必要 | [Manage App Audience](https://support.google.com/cloud/answer/15549945?hl=en) |
| Auth0 の無料プラン: 月間アクティブユーザー 25,000、Management API は 2 件/秒。カスタムドメインにはカードが必要（今回は不要） | [Auth0 Pricing](https://auth0.com/pricing)、[Auth0 rate limits (Free)](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/free-public) |
| ローカルの CLI スタックは Docker 互換のランタイム（Podman も可）で動き、**7 GB 以上の RAM** を推奨。native ランタイムは実験的（macOS 14 以上、Apple silicon） | [Docker and native runtimes](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)、[supabase start](https://supabase.com/docs/reference/cli/supabase-start) |
| この Mac: メモリ 24 GiB、Podman の仮想マシンは 2 GiB で停止中（ローカルの読み取りのみで確認） | `sysctl`、`podman machine inspect` |

**未確認（その時点で確認する。分からなければ UNKNOWN）**
- managed での GoTrue の版
- Free でレート制限を変更できるか
- 監査ログを Postgres に書く設定
- Auth0 の無料登録でカードを求められないか
- `example.com` などの予約ドメインのメールで、確認済みの偽ユーザーを作れるか

## 2. E1〜E12 の前提条件の表

分類:
- (a) 空の使い捨てプロジェクトと、確認済みの偽ユーザー 1 人だけで行える
- (b) OAuth / PKCE のプロバイダとコールバックが必要
- (c) OIDC の発行元、または複数の独立した ID が必要
- (d) Hooks やレート制限の設定が必要
- (e) 破壊的な操作への同意、または E11 の独立レビューが必要
- (f) アカウントを持たないと意味のある実施や解釈ができない

| Exp | 分類 | managed（無料）での可否 | ローカル OSS スタックでの可否 |
| --- | --- | --- | --- |
| E1 版と設定 | a | **GO**（読み取りのみ） | 版はローカルのもので、managed の値は得られない |
| E2 BAN と自動連携 | b c e | GO 見込み（Auth0 の独自 OIDC と、確認済みの偽ユーザー 1 人） | GO 見込み（Keycloak） |
| E3 BAN 後の手動連携 | b e | GO 見込み（手動連携を有効にする） | GO 見込み |
| E4 BAN 前に開始した手動連携 | b e | GO 見込み（人が手順の合間で止める） | GO 見込み（期限は設定に依存） |
| E5 refresh・ID token・logout | a b e | GO 見込み（ID token は `custom:` が受け付けられる。ソース上） | GO 見込み |
| E6 約 200 件の同時実行 | c d e | **NO_GO（完全な形では）**／20 件以下の試行は PARTIAL | PARTIAL（制限を上げられるが、OSS の結果にすぎない） |
| E7 Custom Access Token hook | d e | GO 見込み（Free で利用可、2 秒の時間制限） | GO 見込み |
| E8 Admin 削除の cascade | a e | GO 見込み | GO 見込み（schema は OSS の版） |
| E9 古い token と Storage | a e | GO 見込み（偽のバケット、Free 1 GB） | GO 見込み（物理ファイルの保存方式が managed と異なる） |
| E10 監査ログ | a e | 設定次第（Postgres への監査が無ければ UNKNOWN） | GO 見込み |
| E11 D の確認（SQL / Admin） | e f | 独立レビュー、利用者の承認、W1〜W7 が無い限り **実施しない** | 権限が managed と異なるので、比較の参考にとどまる |
| E12 ガード migration と競合 | a e | GO 見込み | GO 見込み |
| Apple 固有 | f | **NO_GO**（有料のため） | NO_GO |

## 3. 無料で用意できる道（推奨: managed は Auth0 の独自 OIDC）

利用者だけが行う手順です。実施は、K5 と利用者の決定の後に行います。

1. Auth0 の無料テナントを作る。カードを求められたら中止する。
2. テナントに Regular Web Application を 1 つ作る。
   - Allowed Callback URL は、**使い捨てプロジェクトを作った後**に `https://<新しい ref>.supabase.co/auth/v1/callback` を登録する。ref はリポジトリに書かない。
   - client secret はパスワードマネージャーにだけ保存する。
3. Database connection に、偽ユーザーを 2〜3 人作る。
   - 予約ドメインのメールアドレスを使い、`email_verified: true` にし、確認メールは送らない。
   - E2 用に「同じメールの Supabase 側ユーザー」を用意する。
   - **他人や実在のアカウントは使わない。大量作成もしない。**
4. 窓の当日に、使い捨てプロジェクトの Authentication → Providers → Custom Providers で、OIDC（issuer `https://<テナント>.auth0.com/`）を 1 件だけ登録する。PKCE は自動。
   - 手動連携は E3 / E4 の直前に有効にする。

- GitHub と Google は推奨しない。GitHub は「1 人 1 アカウント」の規約、Google は実在のアカウントが必要なため、偽のテストユーザーだけでは成り立たない。
- Apple は対象外（有料）。

## 4. E6 について

- 200 件を同じ IP から送ると、レート制限（5 分あたり 30 件）にかかる。また、規約に沿って 200 個の独立した主体を用意することは現実的でない。
- 制限を回避する手段（IP の分散など）は使わない。
- managed では、1 回 20 件以下の小規模な試行を数回行い、結果は **PARTIAL** として扱う。「ウィンドウが存在しない」証明には決してならない。
- ローカルでは制限を上げて大規模に試せるが、これも OSS の結果にすぎない。

## 5. 写真アプリを止めない代替（ローカルの OSS スタック）

- 使うもの: Supabase CLI のローカルスタックと、組み込みの Keycloak プロバイダ（ローカルの Keycloak コンテナ）。
- GoTrue のイメージを managed と同じ版に固定すれば、E2〜E9・E12 の多くを、写真アプリを止めずに確かめられる。
- **ローカルで証明できないこと**:
  - managed の版と設定
  - 運用者の役割が持つ権限と、RLS で行が隠れずに見えるか
  - プラットフォームのレート制限や gateway の挙動
  - 物理ファイルの扱い（S3）
  - 監査ログの設定
  - 独自 OIDC での「公開の https 発行元」という経路
  - Supabase のサポート方針
- 結果は `LOCAL_OSS_EVIDENCE` として記録し、managed の PASS には数えない。
- 実施に必要なもの（別 TASK）:
  - Podman の仮想マシンを 8 GiB 以上にする（利用者がこの Mac で設定する）
  - コンテナイメージのダウンロード承認
  - 実施する G5 の TASK

## 6. 最初の managed パイロットと、終了条件

**パイロット（準備が揃った後、利用者の承認を得て。今回は何も実施しない）**
- 使い捨てプロジェクトで行うのは **E1 だけ**（読み取りのみ）:
  - 版と設定（許可リストに載せた項目）
  - カタログの指紋、拡張読み戻し（権限、RLS で見えるかどうか）
- 写真アプリの停止時間は 2〜3 時間を目安にする。
- 止める条件: T0+3h、または異常・取り違えの疑い・費用が 0 でないとき。すぐに使い捨てプロジェクトを削除または一時停止し、`anohi-memories` を再開して、利用者が実機で確認する（PR128 §5）。
- E2〜E12 の破壊的な実験は、別の窓で、実験ごとの同意を得て行う。E11 はさらに、独立レビューと `option_d_full_decision_proof` が必要。

**終了条件（Phase 3g の判定）**
- `IDP_PREPAUSE_READY` になる条件: 次の 1・2 が揃い、PR128 の P1〜P9 と R1〜R8 を満たせる見込みが立つこと。
- それまでは **`IDP_PREPAUSE_BLOCKED`**。

**利用者の次のアクション（最大 3 つ。課金なし）**
1. 写真アプリを止めずにできるローカルの OSS 検証を先に行うか決める（Podman を 8 GiB に増やすことと、イメージのダウンロードを承認する）。
2. managed の検証に進むときは、Auth0 の無料テナントと偽ユーザー 2〜3 人を、上記 §3 の手順で用意する（秘密情報はパスワードマネージャーにだけ保存）。
3. E1 だけのパイロットの担当者と時間帯（2〜3 時間）を決める。そのうえで、K5 の判断と、一時停止・作成それぞれの承認を出す。
