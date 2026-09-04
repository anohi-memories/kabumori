# Handoff

## 基本情報

- 更新日時: 2026-09-04
- 担当者: くろちゃん（Claude Code）
- 対象ブランチ: main
- 関連Issue / PR: なし（ローカル作業、未コミット）

## 今回の目的

Web管理画面V1（`apps/admin`）の残タスクを2工程分実施：
1. 重要ニュース候補一覧（`/important-news`、ダッシュボードへの接続）
2. システム状態（ダッシュボードの「システム状態」カードを実データ化）

いずれもread-only。DB・Edge Function・Cron・RLSの変更は一切行っていない。

## 完了したこと

- `/important-news` ページ新規追加。`important_news_candidates` から直近30件を新しい順に取得し、company/title/importance/generation status/Fact・Voice/generated text/X post IDを表示。
- ダッシュボードの「重要ニュース候補」カードを実データ化（最新5件＋詳細ページへのリンク）。
- ダッシュボードの「システム状態」カードを実データ化。5系統（重要ニュース／朝刊／朝の挨拶／大引けレポート／米国プレマーケット）それぞれのON/OFFと主要設定値を表示。
- ナビゲーションに「重要ニュース」リンクを追加。
- `apps/admin/.env.local`（gitignore対象）を作成し、ローカルdevサーバーでのスモークテストを実施。値は既存のルート `.env` にある公開用URL・publishable keyをそのままコピーしたもので、秘密情報ではない。

## 未完了のこと

- 実管理者アカウントでのブラウザ最終確認（管理者パスワードを扱えないため、この担当では未実施）。
- 「その他やらないと決めたこと」以外の新機能追加は無し。ユーザー指示により、この工程が終わればV1主要機能は完成扱いとし、次は新機能追加ではなく本人による最終確認に進む予定。

## 変更したファイル

- `apps/admin/src/lib/recent-failures.ts` — `getCheckStatusLabel` をexportに変更（他モジュールから再利用するため。挙動変更なし）
- `apps/admin/src/lib/important-news.ts` — 新規。重要ニュース候補の取得・整形ロジック
- `apps/admin/src/app/important-news-list.tsx` — 新規。重要ニュース候補の表示コンポーネント
- `apps/admin/src/app/(admin)/important-news/page.tsx` — 新規ページ
- `apps/admin/src/lib/system-status.ts` — 新規。5系統のsettings取得・整形ロジック
- `apps/admin/src/app/system-status-list.tsx` — 新規。システム状態の表示コンポーネント
- `apps/admin/src/app/(admin)/layout.tsx` — ナビに「重要ニュース」を追加
- `apps/admin/src/app/(admin)/page.tsx` — 「重要ニュース候補」「システム状態」カードを実データ接続
- `apps/admin/src/app/globals.css` — 上記2機能ぶんのスタイル追加（既存の `.status-*` `.failure-*` `.post-history-*` を最大限再利用）
- `apps/admin/.env.local` — 新規（gitignore対象、非秘密の公開接続情報のみ）
- `.claude/launch.json` — 新規。ローカルdevサーバーをブラウザプレビューで起動するためのツール設定（アプリのロジックには影響しない）

`apps/admin/**` 以外でリポジトリの内容を変更したのは `.claude/launch.json` のみ（テスト用ツール設定）。DB migration・Edge Function・RLSは一切変更していない。

## 確認・テスト

- 実施した確認: `npm run lint`（成功）、`npm run build`（成功、`/important-news` が動的ルートとして生成されることを確認）
- 追加確認: ローカルdevサーバーを起動し、未ログイン状態で `/`（307リダイレクト）と `/login`（200）が正常応答することを確認。この際、全クエリがRLSにより意図通り拒否される（`42501`）状況でも各カードが個別にエラー表示するのみでページ全体はクラッシュしないことを確認できた。
- 結果: 上記いずれも問題なし。
- 未実施の確認と理由: 実管理者アカウントでの実データ表示確認は、管理者パスワードを本セッションで扱わない方針のため未実施。importance/status/Fact・Voice issuesの実際の表示値は、migrationのcheck制約から網羅した想定値であり、実データでの目視確認はできていない。

## 候補選定・除外ログ

対象外。

## 既知の問題・注意点

- 「朝の挨拶」には専用のsettingsテーブルが存在しない。`posting_windows`（`post_type = 'morning_greeting'`）の `is_active` / `start_time` / `end_time` / `timezone` を代わりに表示しているが、これはスケジュール設定のみであり、実際のCron・実行トリガー自体の稼働状況はDBから確認できない旨をUI上に注記した。
- `important_news_candidates.importance` / `status` の日本語ラベルは、migrationのcheck制約に基づく網羅的マッピング。未知の値が来ても `不明（値）` にフォールバックし、画面は壊れない設計。
- `apps/admin/.env.local` はgitignore対象で秘密情報は含まないが、リポジトリ外の作業ファイルとして存在する点は認識しておくこと。

## 次に行うこと

1. ユーザー本人が管理者アカウントでブラウザから最終確認する。
2. 問題がなければ、Web管理画面V1の主要機能は完成扱いとする（新機能追加はここでいったん停止）。

## 判断・提案

- 確認済みの決定: 「システム状態」はダッシュボード内のみで表示し、専用ページ（`/systems` 等）は追加しない（指示書内で「ダッシュボード内だけで十分見やすければ専用ページ不要」と明記されていたため）。
- 未確定の提案: なし。

---

## 追記: 2026-09-04 スマホログイン不具合の調査・修正

### 今回の目的

Macでは成功、iPhoneからLAN IP (`http://192.168.x.x:3000`) では「ログインボタンを押すとフォームがクリアされるだけで `/` へ遷移せず、エラーも出ない」症状の原因調査と、安全な範囲での修正。認証方式の全面変更・DB変更は行っていない。

### 分かったこと（原因）

- コード上に `Secure` cookie の明示指定やlocalhost限定のロジックは無く、`@supabase/ssr` のデフォルトcookie設定（`sameSite: lax`、`secure` 指定なし）はHTTP LAN接続でも問題なく動作するはずと確認済み（`node_modules/@supabase/ssr` の実装を確認）。
- Next.js dev serverのcross-origin保護（`allowedDevOrigins`）は `/_next/*` 等の内部リソースにしか適用されず、通常のページ/RSCナビゲーションには影響しないことをNext.js本体のソースで確認済み。よってこれも原因ではない。
- 最も可能性が高い原因: ログイン成功後に使っていた `router.replace("/") + router.refresh()`（Next.jsのクライアント側ソフトナビゲーション＝fetchベースのRSC遷移）が、`signInWithPassword()` がJSで書き込んだセッションcookieの反映より先に発火し得ること。ブラウザ・回線条件によっては、直後のサーバーリクエスト（`(admin)/layout.tsx`）がまだ新しいcookieを見られず、`getUser()` がユーザー無しと判定して `/login` へ差し戻す。フォームからは「エラー無く成功したのに何も起きない」ように見え、差し戻し先の `/login` は新規マウントなので入力欄が空に見える。
- 断定はできていない（実iPhone実機での確認は本セッションでは未実施）。ただしこの経路は既知のブラウザ差（特にモバイルSafari）が出やすい箇所であり、Mac/iPhoneで挙動が割れる説明として一致する。

### Macとスマホの差

- コード上に差は無い。差が出るとすれば、上記のcookie書き込みタイミングと直後のfetchナビゲーションの競合が、ブラウザ実装や回線遅延（Wi-Fi LAN経由）によって発現しやすさが変わるため。localhostとLAN IPで発生確率が変わる可能性はあるが、これは実装上のバグというより「ソフトナビゲーションに依存した実装が本質的に持つ脆さ」。

### 変更内容（最小限）

1. `apps/admin/src/app/login/login-form.tsx`
   - `signInWithPassword()` のエラーを `status`/`code`のみ（開発環境のみ）ログ出力。メール・パスワード・トークンは一切ログしない。
   - `error` が無くても `data.session` が無いケースを新たに検知し、「セッションを確立できませんでした」を表示するよう分岐を追加。
   - ログイン成功後の遷移を `router.replace + router.refresh`（ソフトナビゲーション）から `window.location.assign("/")`（フルナビゲーション）に変更。フルナビゲーションはブラウザがcookieストアを読み直してから送るトップレベルGETになるため、上記の競合を避けられる。認証方式そのものの変更ではない。
   - 遷移直前に、非機密の短命マーカーcookie `kabumori_admin_login_attempt`（20秒で失効）を発行。
2. `apps/admin/src/app/(admin)/layout.tsx`
   - セッション無しで `/` にアクセスされた際、上記マーカーcookieの有無を見て、ログイン試行直後の差し戻しなら `/login?reason=session`、そうでない通常の未ログイン訪問なら従来通り `/login` にリダイレクトを分岐。
   - 開発環境限定で、セッション無し／管理者判定失敗／通過、の3ケースをそれぞれ安全な形（真偽値のみ）でconsoleログ出力。
3. `apps/admin/src/app/login/page.tsx`
   - `?reason=session` を受け取って「セッションを保存できませんでした。もう一度お試しください。」を初期エラーとして `LoginForm` に渡すよう変更（Server Componentのため `searchParams` をawaitして読む形）。

`/unauthorized`（管理者判定失敗）は元から専用ページで明確に案内済みだったため変更していない。これで「Authエラー／セッション確立失敗／管理者判定失敗」の3種が区別可能になった。

### テスト結果

- `npm run lint`: 成功（`window.location.assign` の使用について意図を明記した `eslint-disable-next-line` コメント付きで1件抑制。それ以外の警告・エラー無し）
- `npm run build`: 成功
- 実DB確認:
  - Mac (`http://localhost:3000/`): 未ログイン → `/login` へ307リダイレクトを確認
  - LAN IP (`http://<MacのLAN IP>:3000/`): 同様に未ログイン → `/login` へ307リダイレクトを確認（localhostと同一挙動）
  - マーカーcookie付きで `/` にアクセス →`/login?reason=session` にリダイレクトし、`/login?reason=session` が実際に専用メッセージを表示することを確認
  - 未ログインredirect: 上記で確認済み
- iPhone実機でのログイン成功確認は、管理者パスワードを本セッションで扱わない方針のため未実施。

### 残課題

- 実iPhone実機での再現・解消確認がまだ。次にスマホで再現した場合、`/login?reason=session` のメッセージが出るか、開発コンソールに `[admin/login]` `[admin/layout]` のログがどこで止まるかで、今回のフルナビゲーション修正で解消したか、別要因が残っているかを切り分けられる。
- HTTPS化（Vercel公開）後は、cookieの `Secure` 属性やSame-Site挙動がより厳格な既定になるブラウザもあるため、今回のLAN HTTP特有の問題は自然に解消される可能性が高いが、これは推測であり確認はしていない。

---

## 追記2: 2026-09-04 iPhoneログインでpasswordがURLに漏れる不具合の緊急修正

### 今回の目的

iPhone実機でログインした際、dev serverのログに `GET /login?email=...&password=...` が記録される（＝native form submitが発生しパスワードがURLに漏れる）という重大なセキュリティ不具合の最優先修正。認証方式・DB・RLSは無変更。

### 分かったこと（native GET submitの真の原因）

ブラウザ（Chromiumベース、モバイル viewport）でLAN IP経由 `http://<MacのLAN IP>:3000/login` に実際にアクセスして検証した結果、下記が判明した。

1. Next.js dev serverには、`/_next/*` への配信やHMR websocketを `Origin` ヘッダが `allowedDevOrigins`（未設定時は `localhost` のみ）に一致しないホストからブロックする仕組みがある（本番ビルドには存在しない、dev専用の保護機能）。
2. `next.config.ts` に `allowedDevOrigins` の設定が無かったため、LAN IPからのHMR websocket接続がこの保護に阻まれ続けて確立できていなかった（`curl` で同ヘッダを付けて `/_next/static/...` を叩くと実際に `403` を確認）。
3. Turbopackの開発用HMRクライアントは、このwebsocket接続確立に失敗するとページを繰り返しフルリロードする動作をしており、実機では**ページが数十ミリ秒間隔で無限リロードし続けるループ**に陥っていた（Browser toolでネットワークログを取得し、`GET /login` が短時間に多数記録されることで実測確認済み）。
4. この状態でログインボタンを押すと、ちょうどReactのhydration（`onSubmit`/`onClick` ハンドラのアタッチ）が完了していない一瞬に操作が重なりやすく、`<form>` 要素のデフォルト送信（`method`未指定＝GET、`action`未指定＝現在のURL）が発火し、フォームの値がそのまま `?email=...&password=...` としてURLと（結果としてdev serverのアクセスログ）に載っていた。

これは「`event.preventDefault()`が実行されない」という単純な実装ミスではなく、**LAN IPアクセス時特有のdev server設定不足が、リロードループという形でhydrationのタイミングを乱し、native submitの窓を作っていた**、という構造的な問題だった。

### 修正内容

1. **最優先（構造的な漏洩防止）**： [apps/admin/src/app/login/login-form.tsx](apps/admin/src/app/login/login-form.tsx) から `<form>` 要素を完全に撤去。
   - 入力欄を制御コンポーネント化（`useState` で値を保持）し、送信は `type="button"` の明示的な `onClick` からのみ実行するよう変更。
   - `<form>` が存在しないため、Enterキー・ボタンクリックいずれの経路でも**ブラウザのnative submit機構自体が発生し得ない**構造にした。hydrationが万一失敗しても、ボタンは単に反応しないだけで、URLやログにcredentialが漏れることは構造上あり得ない。
   - `handleLogin` 冒頭でメール・パスワードの空チェックを追加（フォーム由来の `required` バリデーションが効かなくなったため）。
2. **根本原因の解消**： [apps/admin/next.config.ts](apps/admin/next.config.ts) に `allowedDevOrigins: ["192.168.*.*"]` を追加。dev server限定の設定で、本番ビルドには影響しない。これによりLAN IPからのHMR websocket接続がブロックされなくなり、無限リロードループそのものが解消された（実機相当の検証で確認済み、下記テスト参照）。

### iPhoneでClient JS/hydrationが正常か

- 修正前：LAN IPアクセス時、HMR websocketが `403` でブロックされ続け、Turbopackの開発クライアントがページを継続的にフルリロードしていた。JS自体は毎回正常に取得・実行されていた（`/_next/static/*` はOriginヘッダ無しの通常の `<script>` 読み込みでは200を返していた）が、リロードが頻発するせいで実際の操作可能な時間が短く、不安定だった。
- 修正後（`allowedDevOrigins` 追加後）：HMR websocketが正常に接続し（コンソールに `[HMR] connected` が1回だけ出て安定）、`GET /login` のリクエストは6秒間の観測で1回のみ。リロードループは解消。

### ログイン結果（Browser toolによる実機相当の検証）

LAN IP経由でモバイル viewportエミュレーションを使い、実際にメール・パスワードを入力してログインボタンを押下：

- URLは終始 `http://<LAN IP>:3000/login` のまま。クエリ文字列は一切付与されなかった。
- `signInWithPassword()` が実行され（ダミー認証情報のため）Supabaseから実際にエラーが返り、「メールアドレスまたはパスワードを確認してください。」が画面に表示された（Authエラー分岐が正しく機能）。
- dev serverのログを確認し、`password` という文字列やクエリ文字列付きの `GET /login?...` が一切出力されていないことを確認。

正しい認証情報での実ログイン成功確認は、管理者パスワードを本セッションで扱わない方針のため未実施（ユーザー側で新パスワード設定後、本人による確認をお願いします）。

### URL/logへcredentialが流れなくなった確認

- ソースコード上、`<form>` 要素が存在しないことをビルド後のHTML出力・DOM双方で確認済み（`document.querySelector('form')` → `null`）。
- ネイティブsubmitの経路が構造的に存在しないため、hydration失敗時でも同じ不具合は再発しない設計。
- dev serverログ・ブラウザURLいずれもクリーンであることを確認済み（上記テスト参照）。

### 変更ファイル

- `apps/admin/src/app/login/login-form.tsx` — `<form>`撤去、制御コンポーネント化、`type="button"`＋明示的`onClick`に変更、Enterキー対応、空入力チェック追加
- `apps/admin/next.config.ts` — `allowedDevOrigins: ["192.168.*.*"]` を追加（dev server限定、本番ビルド無関係）

### テスト結果

- `npm run lint`：成功
- `npm run build`：成功
- Mac localhost：`/login` 正常表示、`<form>`タグ無しを確認
- iPhone相当（LAN IP・モバイルviewport・Browser tool経由の実ブラウザ検証）：無限リロード解消、ログイン操作でURL/ログにcredential漏洩なし、Authエラー分岐が正常表示されることを確認
- 未ログインredirect：既存動作に影響なし（前回作業分から変更なし）

### 残課題

- 正しい管理者パスワードでの実ログイン成功確認（`/`への遷移確認を含む）は、本セッションではパスワードを扱わない方針のため未実施。ユーザーが新パスワードへ変更後、Mac・iPhone実機の双方で確認をお願いします。
- `allowedDevOrigins` は `192.168.*.*` のみを許可している。別のLANレンジ（`10.*.*.*` 等）で開発する場合は追加設定が必要。
- 今回の無限リロードループはdev server限定の問題であり、Vercel等の本番ビルドでは`allowedDevOrigins`の保護自体が存在しないため発生しない。

---

## 追記3: 2026-09-04 Vercel公開

### 今回の目的

完成済みのWeb管理画面V1（`apps/admin`）をVercelへ公開し、外出先からスマホでも安全に閲覧できるようにする。公開作業のみ。X投稿システム・Edge Function・DBには一切触れていない。

### Git

- `apps/admin/**`（31ファイル）と `HANDOFF.md` のみをstage・commit・push（他の未コミット変更 — ルート`package.json`/`package-lock.json`、`.env`、`src/lib/`、`supabase/**`のmigration・functions — には一切触れていない。事前にユーザーへ確認済み）。
- commit: `7bc6620` "Add Web admin dashboard (apps/admin)"、`origin/main`へpush済み。

### Vercel構成

- Vercel CLIをこの場でインストール・デバイスコード認証（ユーザーがブラウザで承認）。
- `vercel link --yes` で新規プロジェクト作成：team `kabumori` / project `admin`。
- Root Directoryを明示的に `apps/admin` に設定（`vercel project update admin --root-directory apps/admin`）。初回linkでは`.`のままだったが、これは今回CLIから`apps/admin`ディレクトリを直接deployしたため実害はない。ただし将来Git連携した場合はリポジトリ全体をcloneしてbuildするため、明示設定が必須だった。
- Framework Preset：Next.js（自動検出）。Build Command / Output Directory：既定のまま（`next build` / Next.js既定）。Node.js Version：24.x（Vercel既定、build成功済み）。

### 環境変数

Production・Preview両方に設定（値はローカルの`.env.local`からstdin経由で登録、CLI引数・ログ・報告文には一切出していない）：

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

service role key・X API secret・OpenAI secret等は未設定（不要）。

### デプロイ

- `vercel --prod --yes` でビルド・デプロイ成功。
- 本番エイリアスURL：`https://admin-lime-one-zucdop4nh7.vercel.app`（公開・SSO保護なし、200応答を確認）
- デプロイ個別URL（`https://admin-jrs5driy6-kabumori.vercel.app`）はVercelチームのDeployment Protection（SSO）が既定でかかっており302でVercelログインへリダイレクトされる。これはVercel側の仕様で、共有・確認には上記の本番エイリアスURLを使うこと。

### GitHub連携（未完了）

- `vercel git connect` を2回試行したが、いずれも `Failed to link anohi-memories/kabumori. You need to add a Login Connection to your GitHub account first. (400)` で失敗。
- 原因：Vercelアカウント（`cocopan1312-4542`）にGitHubのLogin Connectionが未登録のため。これはVercelアカウント側のOAuth連携であり、本人にしか実行できない。
- 対応：ユーザーがVercelダッシュボード（Account Settings → Login Connections）でGitHubを接続後、`apps/admin`から `vercel git connect` を再実行すれば、以後 `main` へのpushで自動デプロイされるようになる。それまでは手動で `vercel --prod` を実行する必要がある。

### Supabase Auth設定変更

変更なし。理由：管理画面はメール・パスワードの直接サインイン（`signInWithPassword`）のみを使用しており、OAuth・マジックリンク・パスワードリセットなどSupabase側のSite URL/Redirect URLsに依存するリダイレクトフローを一切使用していないため、新しいVercel URLを追加する必要が無いと判断した。

### 動作確認

- `/`・`/posts`・`/important-news` を未ログインでアクセス → いずれも307で`/login`へリダイレクトされることを本番URLで確認。
- `/login`：200で正常表示、HTMLに`<form>`タグが存在しないこと、ボタンが`type="button"`であることを確認（前回のcredential漏洩対策が本番でも有効なことを確認）。
- HTTPでのアクセスは308で自動的にHTTPSへリダイレクトされることを確認（Vercel既定）。
- `/login`のHTML・参照JSチャンクに`service_role`等の秘密情報らしき文字列が含まれていないことを確認。
- モバイルviewport（Browser tool、375×812）で`/login`が正常表示されることを確認。コンソールエラー無し。
- **実際の管理者アカウントでのログイン成功確認（`/`への遷移含む）は未実施**。管理者パスワードを本セッションで扱わない方針のため、ユーザー本人によるMac・iPhone実機での最終確認をお願いします。

### 残課題

- GitHub連携（上記参照）。完了すれば`main`へのpushで自動デプロイが有効になる。
- 独自ドメイン（`admin.kabumori.jp`）は未設定。指示書通り、まずは上記の一時URLでの動作確認を優先し、DNS操作はユーザー確認後に着手する。
- 実管理者アカウントでのログイン成功確認（Mac・iPhone双方）はユーザー側で実施をお願いします。
