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

- ~~GitHub連携~~ → ユーザーがVercelダッシュボードでGitHubのLogin Connectionを追加し、`anohi-memories/kabumori`をVercel側で接続済み（`vercel git connect`で`already connected`を確認、Root Directoryも`apps/admin`のまま維持されていることを確認）。以後`main`へのpushで自動デプロイされる。過去のcommit（`7bc6620`・`7e0d11e`）は接続前のため自動ビルドは走っておらず、現在の本番エイリアスは手動`vercel --prod`時点のビルドのまま。次に`main`へpushがあった際に自動デプロイが実際に動くか確認するとよい。
- 独自ドメイン（`admin.kabumori.jp`）は未設定。指示書通り、まずは上記の一時URLでの動作確認を優先し、DNS操作はユーザー確認後に着手する。
- 実管理者アカウントでのログイン成功確認（Mac・iPhone双方）はユーザー側で実施をお願いします。

---

## 追記4: 2026-09-04 システム状態のON/OFF操作（V1.1）

### 今回の目的

読み取り専用だった「システム状態」に、管理者本人が各自動投稿機能をON/OFFできる操作を追加する。投稿時間・監視間隔・Luna/Sol設定・Cron・prompt・生成ロジック・X投稿ロジックは一切変更しない。

### DB確認結果（実装前に必ず確認、UPDATE不可なら実装しない方針で調査）

| テーブル | SELECT | UPDATE | RLS policy |
|---|---|---|---|
| `important_news_monitor_settings` | ✅ | ✅ | `admin_update_important_news_monitor_settings`（既存、`20260901064201_add_admin_dashboard_access.sql`） |
| `morning_report_settings` | ✅ | ✅ | `admin_update_morning_report_settings`（既存、同上） |
| `close_report_settings` | ✅ | ✅ | `admin_update_close_report_settings`（既存、同上） |
| `us_premarket_report_settings` | ✅ | ✅ | `admin_update_us_premarket_report_settings`（既存、同上） |
| `posting_windows`（朝の挨拶） | ✅ | ❌ | SELECTポリシーのみ、UPDATE用grant/policyが存在しない |

`posting_windows`はUPDATE不可のため、朝の挨拶のON/OFF操作は実装せず、read-onlyのまま。migration・RLS変更は一切行っていない。

### 実装方式

Server Action [`apps/admin/src/lib/actions/system-toggle.ts`](apps/admin/src/lib/actions/system-toggle.ts) の `setSystemEnabled(systemKey, enabled)`：

- 固定allowlist（`SYSTEM_TOGGLE_KEYS`）でtable/columnをserver側マッピング。clientはテーブル名・カラム名を一切送信できない。
- 呼び出しごとに `auth.getUser()` → `admin_users` 確認を再実施（画面表示時の認証を信用しない）。
- 更新前に現在値を読み、既に目的の値なら書き込みをスキップ（他操作との競合時の無駄な書き込み回避）。
- 成功時 `revalidatePath("/")` で最新状態を反映。
- service role不使用。既存RLSが独立した第二の防御層として機能。

UI側 [`apps/admin/src/app/system-status-list.tsx`](apps/admin/src/app/system-status-list.tsx) をclient componentに変更し、トグルボタン押下→確認ダイアログ（native `<dialog>`）→確定で実行、という2段階フローを実装。ワンクリック即変更は無し。押下中はボタンdisabledで二重送信を防止。

### 操作可能システム（このV1.1時点）

1. 重要ニュース監視 ON/OFF（`important_news_monitor_settings.is_active`）
2. 重要ニュース X自動投稿 ON/OFF（`important_news_monitor_settings.auto_publish`、監視とは独立）
3. 朝刊 ON/OFF（`morning_report_settings.is_active`）
4. 大引けレポート ON/OFF（`close_report_settings.is_active`）
5. 米国プレマーケット ON/OFF（`us_premarket_report_settings.is_active`）
6. 朝の挨拶 — 操作不可（上記の通りUPDATE policy不足）

### 確認ダイアログ

- 通常操作：「{システム名}の{項目}をON/OFFにしますか？」+ キャンセル/明示ボタン文言（例：「監視をOFFにする」）
- 重要ニュース `auto_publish` をONにする場合のみ：赤枠警告「ONにすると、重要ニュースが条件成立時に自動的にXへ投稿されます。」を追加表示し、確認ボタンも赤系スタイル（`primary-button-danger`）で一段強調

### 変更履歴（audit log）

既存DBにaudit/change-logに相当するテーブルは存在しない（全migration検索で確認）。V1.1では履歴機能なし。将来のV1.2候補として引き継ぐ。

### 変更ファイル

- 新規：`apps/admin/src/lib/actions/system-toggle.ts`
- 更新：`apps/admin/src/lib/system-status.ts`（`toggles`フィールド追加）
- 更新：`apps/admin/src/app/system-status-list.tsx`（client化、確認ダイアログ実装）
- 更新：`apps/admin/src/app/globals.css`（トグルボタン・確認ダイアログのスタイル追加）

### テスト

- `npm run lint`：成功
- `npm run build`：成功
- local：devサーバー起動、エラー無しを確認
- **本番値の変更は一切行っていない**。実際のON/OFF操作確認は管理者ログインが必要なため、パスワードを扱わない方針により本セッションでは未実施。

### 未完事項

- `posting_windows`（朝の挨拶）にUPDATE権限が無い。追加すれば同じパターンで対応可能な変更案（未実施）：
  ```sql
  grant update on table public.posting_windows to authenticated;
  create policy admin_update_posting_windows on public.posting_windows
    for update to authenticated
    using ((select private.is_admin()))
    with check ((select private.is_admin()));
  ```
- 実際のON/OFF動作確認（重要ニュース監視のOFF→ON復元含む）はユーザー本人による実施が必要。

---

## 追記5: 2026-09-04 株の小ネタ（tip）/ お役立ち情報（useful_tip）のON/OFF確認・実装

### 確認結果

**`tip`（株の小ネタ）**
- 制御元：`posting_windows`（`post_type = 'tip'`、slot 1〜3の3行、それぞれ独立した`is_active`）。専用settingsテーブルは無い。
- UPDATE可否：**不可**。`posting_windows`は「追記4」で確認済みの通り、authenticated向けのUPDATE grant/policyが存在しない。
- → **実装せず**。ON/OFF操作は追加していない。

**`useful_tip`（お役立ち情報）**
- 制御元：専用テーブル`useful_tip_schedule_settings`（`is_active`カラムあり、PK `id boolean = true`の単一行）。
- UPDATE可否：**可能**。`20260901064201_add_admin_dashboard_access.sql`で`grant update ... to authenticated` と `admin_update_useful_tip_schedule_settings`ポリシーが既に付与されている（重要ニュース等と同じ既存パターン）。
- `is_active`は`plan_weekly_useful_tips()`内で`if not found or not s.is_active then return;`として使われており、Cronディスパッチャ（`claim_due_post`）自体は毎回呼ばれ続けるが、候補生成だけを止める仕組み。Edge Function変更は不要。
- → 既存Server Action allowlist方式に**追加実装した**。

### 実装内容

- [`system-toggle.ts`](apps/admin/src/lib/actions/system-toggle.ts)：allowlistに `useful_tip` を追加（`useful_tip_schedule_settings.is_active`）。
- [`system-status.ts`](apps/admin/src/lib/system-status.ts)：`getUsefulTipStatus()` を追加。表示項目は投稿頻度（週n回）・投稿時間帯A/B・タイムゾーン。トグル付き。
- UI（`system-status-list.tsx`）は既存の汎用データ駆動実装のため変更不要。

### テスト

- `npm run lint`：成功
- `npm run build`：成功
- **本番値の変更は一切行っていない**。`useful_tip_schedule_settings.is_active`は現在`true`（本番稼働中、週7回）で、テストのために変更していない。

### 未完事項

- `tip`のON/OFFは、`posting_windows`のUPDATE権限追加（「追記4」の変更案と同じmigration）がされない限り対応不可。かつ`tip`は1系統ではなく3スロット（`posting_windows`の3行）を個別に持つため、UPDATE権限を追加した場合も「まとめてON/OFF」か「スロット単位」か設計判断が別途必要になる。→ 「追記6」で対応。
- `useful_tip`の実際のON/OFF動作確認はユーザー本人による実施が必要（本番稼働中のため、テストで不用意にOFFにしないよう注意）。

---

## 追記6: 2026-09-04 posting_windows UPDATE権限追加＋朝の挨拶/tip ON/OFF対応

### 今回の目的

「追記4」で見送っていた朝の挨拶と株の小ネタ`tip`のON/OFFを、`posting_windows`への管理者限定UPDATE権限追加（例外的にDB変更を許可されたスコープ）によって対応する。

### 事前確認結果

- `public.posting_windows`：実在、`post_type`・`is_active`・`slot_no`列すべて実在（`20260828203000_create_post_scheduler.sql`）。PKは`id uuid`、`unique(post_type, slot_no)`。
- 朝の挨拶：`post_type='morning_greeting'`、`slot_no=1`の1行のみ（`20260901044548_add_morning_greeting_schedule.sql`で挿入。他に同post_typeの行を挿入するmigrationは無し）。
- `tip`：`post_type='tip'`、`slot_no`1〜3の3行（`20260828203000_create_post_scheduler.sql`で挿入。以後この3行への追加行は無し）。3スロット独立と確認済み。
- 既存SELECT policy：`admin_select_posting_windows`（`for select`のみ、`20260901064201_add_admin_dashboard_access.sql`）。
- `private.is_admin()`：`admin_users`テーブルを`auth.uid()`で照会するsecurity definer関数。既存の全`admin_update_*`policyと同一の使い方。
- policy名衝突：`admin_update_posting_windows`という名前は既存migration内に一切登場せず、衝突なし。他テーブルの命名規則（`admin_update_<table>`）とも一致。

### 【重要】migrationは作成したが、本番DBへは未適用

新規migration [`supabase/migrations/20260904170000_add_posting_windows_admin_update.sql`](supabase/migrations/20260904170000_add_posting_windows_admin_update.sql) を作成した（内容は指示書の通り、`grant update`と`admin_update_posting_windows` policyの追加のみ）。

ただし`supabase db push`を試みたところ、**このmigrationより前に、他の並行作業由来と思われる未適用migrationが2件残っていることが判明**した（`supabase migration list`で`remote`欄が空欄）：

1. `20260901044548_add_morning_greeting_schedule.sql` — `posting_windows`へ朝挨拶rowを挿入し、**Cronディスパッチャ関数`claim_due_post()`を再定義**する内容
2. `20260904010000_add_important_news_generation_issues.sql` — `important_news_candidates`に`generation_fact_issues`/`generation_voice_issues`列を追加

実際にリモートのスキーマを`supabase db dump --schema public`で確認した結果、上記2列は**本番DBに存在しないこと**を確認した。また朝挨拶用のrowもこの状況では存在しないと考えられる（該当migration未適用のため）。

`supabase db push`はmigrationを古い順に適用するため、`--include-all`を付けない限りこの2件を素通りして自分のmigrationだけを適用することができない。`--include-all`を付けると、Cron関数の再定義を含むこの2件も一緒に本番へ適用されることになり、「Cron変更しない」「他テーブルは変更しない」という今回の指示に反するおそれがあったため、**ユーザーに確認**。

→ ユーザーの判断：「自分のSQLだけ手動で適用（推奨）」。よって、このセッションでは`supabase db push`等によるDB適用を一切実行していない。以下のSQL（migrationファイルと同一内容）を、ユーザーまたは担当者がSupabase StudioのSQL Editor等で手動実行する想定：

```sql
grant update on table public.posting_windows to authenticated;

create policy admin_update_posting_windows
on public.posting_windows
for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
```

手動適用後、`supabase migration list`の`remote`欄をこのmigrationについて合わせたい場合は `supabase migration repair --status applied 20260904170000` の実行を検討（CLIのbookkeeping同期のみ、任意）。

### 実装内容（コードはmigration適用前提で作成済み、適用後に有効化される）

- [`system-toggle.ts`](apps/admin/src/lib/actions/system-toggle.ts)：allowlistに `morning_greeting` と `tip` を追加。`posting_windows`向けの新モード（`mode: "posting_window"`）を導入し、`post_type`で絞り込んで該当行**すべて**を同じ`is_active`へ更新する（`tip`なら3行同時、個別スロット操作は無し）。現在値がすでに揃っていれば書き込みをスキップする点は既存の単一行モードと同じ。
- [`system-status.ts`](apps/admin/src/lib/system-status.ts)：
  - `getMorningGreetingStatus`：トグルを追加。注記を「投稿ウィンドウ設定のON/OFFです。Cron実行自体とは別です。」に更新。
  - `getTipStatus`（新規）：`posting_windows`の`tip`3行を取得し、「投稿枠：3件」「有効な投稿枠：X/3件」を表示。3行が不揃いな場合はその旨を注記し、トグル操作で揃えられるようにした。
- UI（`system-status-list.tsx`）：`tip`の確認ダイアログのみ「{システム名}3枠をすべてON/OFFにしますか？」という専用文言に変更（複数row更新であることを明示）。朝の挨拶はトグルのlabelを「投稿設定」にし、既存の汎用文言で「朝の挨拶の投稿設定をON/OFFにしますか？」となるようにした。

### 現状の動作（migration未適用のため）

- 朝の挨拶：該当rowが存在しないため、システム状態カードは引き続き「状態確認不可」表示のまま（トグルも出ない）。
- `tip`：SELECTは既存権限で可能なため、カード自体は新たに表示され現在値（3/3件有効など）を確認できるが、トグル操作をするとRLSがUPDATEを拒否し（`42501`）、「設定を変更できませんでした」という安全なエラー表示になる（クラッシュはしない）。migration適用後に初めて機能する。

### テスト

- `npm run lint`：成功
- `npm run build`：成功
- local：devサーバー起動、エラー無しを確認
- **本番DBへの変更は一切行っていない**（migrationファイルの作成のみ、適用はユーザー側で実施予定）

### 未完事項

- 上記SQLの本番適用（ユーザー側で実施予定）。
- 適用後、実際のON/OFF動作確認（朝の挨拶・tip 3枠一括、および復元）はユーザー本人による実施をお願いします。

---

## 追記7: 2026-09-04 スキーマ調査ミスの訂正、posting_windows UPDATE適用の再試行、交流投稿(interaction)追加

### 【訂正】「追記6」の調査ミスについて

「追記6」で報告した「`important_news_candidates.generation_fact_issues`/`generation_voice_issues`が本番DBに存在しない」は**誤りでした**。原因は`supabase db dump`がDocker Desktop依存で実際には失敗していたのに、その失敗時の空/エラー出力を「列が存在しない証拠」と誤読したこと。

Docker非依存の`supabase gen types typescript --linked`（本番スキーマを直接イントロスペクトする読み取り専用コマンド）で再確認した結果、**両列とも実際には存在**していることを確認した。管理画面で実際に表示できていた内容と一致する。

再調査の結果（プロジェクトref 4者一致、`wsmznyzcvmuitkglfeuj`で確認済み）：

| migration | schema効果 | DB反映済みか | remote history記録 |
|---|---|---|---|
| `20260901044548_add_morning_greeting_schedule.sql` | morning_greeting行insert、`claim_due_post()`再定義 | 未反映と推定（`posting_windows`の総行数8が、morning_greeting抜きの合計と一致するため。関数定義自体は直接確認できず、確信度は中） | 未記録 |
| `20260904010000_add_important_news_generation_issues.sql` | `generation_fact_issues`/`generation_voice_issues`列追加 | **反映済み（確認済み）** | 未記録（trackingの記録漏れのみ） |

### posting_windows UPDATE権限の本番適用について（再試行するも今回も未実施）

ユーザーからの明示的な許可（「実施してよいこと」としてSQLが提示された）を受け、改めてCLIから安全に適用できないか検証したが、**今回も技術的な制約により適用できていない**：

- `supabase db push`：migrationの順序制約により、`20260901044548`・`20260904010000`より後ろにある新migrationだけを単独適用することができない（`--include-all`が必要だが、これは禁止事項に抵触するため使用せず）。
- `migration repair`：禁止事項のため使用せず。
- 直接`psql`接続：DBパスワードを保持しておらず、取得もしていない。
- `supabase db dump`/`db diff`：Docker Desktop依存のため、この環境では実行不可。
- Supabase Studio SQL Editor：ブラウザでのログインセッションが必要で、本セッションからは操作不可（Vercelの場合と同様の制約）。

以上より、**本番へのSQL適用は今回も私からは実施していません**。下記SQLをユーザーご自身（またはSupabaseダッシュボードにアクセスできる担当者）がSupabase StudioのSQL Editorで実行してください。合わせて、実行後にそのまま自己確認いただけるread-onlyの確認クエリも用意した（私はこれらを実行して確認する手段を持たないため）：

適用SQL（指示書と同一）：
```sql
grant update on table public.posting_windows to authenticated;

create policy admin_update_posting_windows
on public.posting_windows
for update
to authenticated
using ((select private.is_admin()))
with check ((select private.is_admin()));
```

適用後の自己確認用SQL（read-only、副作用なし）：
```sql
-- 1. authenticatedへのUPDATE grant確認
select grantee, privilege_type
from information_schema.role_table_grants
where table_schema='public' and table_name='posting_windows' and grantee='authenticated';

-- 2. admin_update_posting_windows policyの存在と内容確認
select policyname, cmd, qual, with_check
from pg_policies
where schemaname='public' and tablename='posting_windows';

-- 3. tip 3行が変更されていないことの確認
select post_type, slot_no, is_active, start_time, end_time
from public.posting_windows
where post_type='tip'
order by slot_no;
```

適用が完了したとご連絡いただければ、私の方でも`supabase migration list`・`gen types`等の読み取り専用コマンドで裏どり確認します。

### interaction（交流投稿）の追加

**row数・現在値はmigration履歴からの推定**（前述の理由によりライブクエリでの直接確認ができないため）：

- `post_type='interaction'`：2行（`slot_no=1,2`）。`20260828223000_create_interaction_posts.sql`で挿入。
- slot 1：`start_time='14:00'`, `end_time='16:30'`, `timezone='Asia/Tokyo'`
- slot 2：`start_time='20:00'`, `end_time='22:00'`, `timezone='Asia/Tokyo'`
- `is_active`：migration履歴上は**2行とも`false`**。`20260828225000_expand_interaction_topics.sql`と`20260828234000_add_interaction_collision_avoidance.sql`の両方で明示的に`is_active=false`に設定されており（後者のコメント: "Keep interaction publication disabled until the explicit activation step."）、以後これを覆すmigrationは無い。
- `posting_windows`全体の行数8（tip3+interaction2+morning_report1+close_report1+us_premarket_report1=8）と整合。

コード自体は実際の管理画面上ではその時点のライブ値を正しく表示する（この確信度の話は今回私が確認できる範囲の話であり、コードのロジックには影響しない）。

### 実装内容

- [`system-toggle.ts`](apps/admin/src/lib/actions/system-toggle.ts)：allowlistに`interaction`を追加（`posting_windows`、`post_type='interaction'`、該当2行を同時更新）。
- [`system-status.ts`](apps/admin/src/lib/system-status.ts)：`tip`と`interaction`共通の`getPostingWindowGroupStatus()`ヘルパーへリファクタリングし、`interaction`用の呼び出しを追加（投稿枠数・有効枠数・各枠の時間帯を表示）。
- UI（`system-status-list.tsx`）：確認ダイアログの複数枠文言（「◯枠をすべてON/OFFにしますか？」）を`tip`専用のハードコードから、`toggle.slotCount`を使った汎用ロジックへ変更（`interaction`にも自動的に適用される）。

### 安全条件の遵守

`posting_windows`のUPDATE policyは本番未適用のため、`interaction`のトグル操作は現時点でRLSに拒否され「設定を変更できませんでした」と安全に失敗する（クラッシュなし）。指示通り「実装だけ行って本番操作はさせない」状態。

### テスト

- `npm run lint`：成功
- `npm run build`：成功
- local：devサーバー起動、エラー無し確認
- **本番DB・本番値の変更は一切行っていない**
- `20260901044548`・`20260904010000`の2件が本番未適用のままである点は、今回のスコープ外だが重要な既知の問題として記録。特に`20260904010000`が未適用だと、既存の「重要ニュース候補」ページ（`/important-news`）のクエリが本番で失敗している可能性がある。担当者への確認を推奨。

---

## 追記8: 2026-09-04 22:43頃 本番tip OFF操作でServer Error（緊急修正）

### 何が起きたか

ユーザーが本番管理画面で「株の小ネタ」をOFFにしようとしたところ、iPhone Safariで `A server error occurred` （error ID `2772002555@E352`）。操作後にDBを直接確認したところ`posting_windows`の`tip`3行は`is_active=true`のまま変わっておらず、UPDATEが実行されていなかった。

### 真の原因

`apps/admin/src/lib/actions/system-toggle.ts`は`"use server"`ファイルだが、`export const SYSTEM_TOGGLE_KEYS = [...] as const;`という**非関数の値**をexportしていた。Next.jsの制約で、`"use server"`ファイルはasync関数（と型のみ）しかexportできない。本番ビルドでこのモジュールが実際に評価される際（＝サーバーアクションが呼ばれた瞬間）に、

```
Error: A "use server" file can only export async functions, found object.
digest: '2772002555@E352'
```

でモジュール評価自体が失敗し、`setSystemEnabled()`の中身が一切実行される前に500エラーになっていた。これは`tip`固有の問題ではなく、**この日追加した全てのON/OFFトグル（重要ニュース監視・朝刊・大引け・米国プレマーケット・useful_tip・朝の挨拶・tip・interaction）が同様に本番で機能していなかった**ことを意味する。

Vercel本番ログ（`vercel logs --environment production --status-code 500 --since 6h`）でdigestが完全一致する例外を確認し特定した。

### なぜlocal lint/buildで検出できなかったか

この「use serverファイルのexport形状チェック」はNext.js/Turbopackの**モジュール評価時（実行時）のチェック**であり、`next build`のコンパイル・型チェック段階では検出されない。また、ローカルではログイン済みセッションが無く実際にサーバーアクションを呼び出すテストができなかったため（本セッションは管理者パスワードを扱わない方針のため）、本番で実際にクリックされるまで発覚しなかった。

### 修正内容

`SYSTEM_TOGGLE_KEYS`の`export`キーワードを削除しただけ（1行）。この配列は同ファイル内の`isToggleKey()`とtype導出でのみ使われており、他のファイルからは参照されていなかった（外部からは既に`export type SystemToggleKey`という型のみを参照）。

### 修正ファイル

- [`apps/admin/src/lib/actions/system-toggle.ts`](apps/admin/src/lib/actions/system-toggle.ts)

### DB/RLS変更なしの確認

一切変更していない。`posting_windows`の`tip`3行も、修正前後を通じて私からは一切書き込んでいない（ユーザー報告の通り3行とも`is_active=true`のまま）。

### テスト

- `npm run lint`：成功
- `npm run build`：成功（このエラーはbuildでは検出されない性質のため、build成功は今回の修正の直接的な証明にはならない点に注意）
- Vercel自動デプロイ：成功（`Ready`確認、production alias 200応答確認）
- **実際のtip OFF操作の再テストはユーザー本人にお願いします**（ログインが必要なため）
