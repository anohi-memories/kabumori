# Claude Task 2

- task_id: morning-greeting-x-media-scope-reauth-20260908
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- purpose: 2026-09-08朝の`morning_greeting`が`MORNING_GREETING_MEDIA_UPLOAD_FAILED:403`で安全停止した原因を、X OAuth 2.0のmedia upload権限と実装方式まで確認し、画像付き朝の挨拶を安全に復旧できる状態へ整える。

## Confirmed incident

- 2026-09-08 06:56 JST頃、`morning_greeting` scheduled run開始。
- `post_execution_logs`:
  - started: `Scheduled post claimed`
  - failed: `MORNING_GREETING_MEDIA_UPLOAD_FAILED:403`
- `publish_claims`:
  - `post_type=morning_greeting`
  - `date_jst=2026-09-08`
  - `status=failed`
  - `x_post_id=null`
  - `error_code=MORNING_GREETING_MEDIA_UPLOAD_FAILED:403`
- X本投稿は未実施。二重投稿なし。
- 文字数失敗ではない。
- 現行コードは画像を`POST https://api.x.com/2/media/upload`へBearer tokenで送信し、403はretryせず安全停止する。

## Current official X requirements to verify against

X公式OAuth 2.0 docsでは少なくとも以下を確認済み:
- `tweet.write`: 投稿権限
- `media.write`: **Upload media**
- `offline.access`: refresh token発行/継続利用

したがって最有力仮説は、現在保存されているOAuth 2.0 user tokenが`tweet.write`等は持つ一方、画像投稿追加前に発行されたため`media.write`を持っていないこと。

ただし403だけで断定せず、X APIの現在仕様・request形式も含めて実装と照合すること。

## Required investigation

1. リポジトリ内でX OAuth認証開始/authorization URL生成/初回token取得の経路を特定する。
   - scope定義
   - callback/token exchange
   - token保存先`oauth_token_store`
   - refresh経路
2. リポジトリ内に初回OAuth認証フローが無い場合は、その事実を明記し、過去に手動発行したtokenだけを保存している構成か確認する。
3. `POST /2/media/upload`の現在のX公式仕様と現行実装を比較する。
   - `media.write` scope要否
   - multipart raw bytesでのupload可否
   - `media_category=tweet_image`
   - Bearer user access token
4. 403 response bodyを安全に診断できるよう、secret/tokenを一切出さずにerror detail/code/title等だけ記録できる最小診断改善が必要か判断する。
5. 現在tokenのscopeをsecret露出なしで確認できる方法があるか調査する。できない場合、再認証が必要と判断できる根拠を示す。

## Required implementation

原因がscope不足なら:

1. X OAuth authorization requestに最低限以下を含める:
   - `tweet.read`（現行で必要なら維持）
   - `tweet.write`
   - `users.read`（現行で必要なら維持）
   - `offline.access`
   - **`media.write`**
2. 既存refresh tokenをrefreshするだけでは新scopeが付与されない前提で、**ユーザー再認証が必要なフロー**を明確にする。
3. リポジトリにOAuth開始フローが無い場合は、今後再現可能な最小の安全な再認証導線を提案/実装する。ただしproduction secret変更や実際のX再認証はこのTASKでは行わない。
4. media upload 403時のdiagnosticsを改善する場合:
   - access token / refresh token / client secretをログ・DB・Reportに絶対出さない
   - X responseの非機密なerror code/title/detailのみ保存/返却可
   - 403を自動retryしない
5. 既存の二重投稿防止claim、401時最大1回refresh、文字数retry、画像生成/テーマ検証を壊さない。

## Tests

最低限:
1. OAuth scope定義が存在する場合、`media.write`が含まれる
2. `tweet.write`/`offline.access`等の既存必須scopeが落ちない
3. media upload 403ではX tweet POSTへ進まない
4. 403で自動retryしない
5. 401だけは既存どおり最大1回refresh後に同一media request再試行
6. diagnostics追加時、token/secretを含めない
7. existing morning_greeting/manual publish regression pass
8. full `x-test-post` regression pass

## Scope / conflicts

主対象:
- `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
- `supabase/functions/_shared/x_oauth2_post.ts`
- X OAuth初回認証フローが存在する場合その関連ファイル
- 関連tests/docs

触らない:
- Codex `important-news-monitor/**`
- Claude slot1担当領域
- `send-push-notifications/**`
- close_reportロジック（今回の`ce15350`修正を壊さない）
- DB migration/schema/GRANT
- Cron
- `posting_windows`
- 他Edge Function

## Production policy

このTASKは **調査 + local実装 + tests + commitまで**。

禁止:
- production Edge Function deploy
- Xへの実投稿
- X Developer Console設定変更
- 実際のOAuth再認証/ユーザー同意操作
- production secrets変更
- DB write/migration/schema/GRANT
- Cron変更

read-onlyでの本番DB/設定確認は可。ただしsecret/token本文は絶対に表示・保存しない。

## Completion

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report`追記
- 403の根本原因または最有力原因と根拠
- 現在のOAuth scope/初回認証経路
- changed files
- tests
- commit hash
- production変更なし
- **ユーザーが次に実際に行う再認証手順**を具体的に記載
- 次工程として「K2承認 → 必要ならdeploy → ユーザー再認証 → media upload test → morning_greeting manual publish/dry-run確認」を提案

## Report

- task_id: morning-greeting-x-media-scope-reauth-20260908
- result: 403の最有力原因を特定（コード上で確定はできないが証拠は強い）。原因はリポジトリ内に「新scopeを追加できる初回OAuth認証フロー」自体が存在しないため、Required implementation §1（authorization requestへのscope追加）は実装できないと判断し、代わりに§4の診断改善を実装した。commit `1088081`を`origin/main`へpush済み（親は本タスクの`in_progress`commit `aaf4698`）。production変更・実際のOAuth再認証・secrets変更は一切行っていない。
- root_cause（最有力、根拠あり）:
  - `POST https://api.x.com/2/media/upload`はX公式仕様上、OAuth 2.0 User Context（Bearer token）経由の場合`media.write` scopeを要求する
  - 現行実装（`morning_greeting_publish_logic.ts`）のrequest形式（multipart form-data、`media`フィールド＋`media_category=tweet_image`、`Authorization: Bearer <accessToken>`）はX公式のv2 media upload仕様と一致しており、**request形式のバグではない**
  - `/2/tweets`（tweet.write）は同じ保存済みtokenで日常的に成功しているため、tokenそのものが失効/無効化されているわけではない。403が`/2/media/upload`だけで発生していることは、scope不足という仮説と整合する
  - 401（token期限切れ）ではなく403（権限不足）であることも、「refreshで直る一時的な期限切れ」ではなく「そもそも許可されていない操作」という解釈と整合する
- investigation_1（OAuth初回認証フローの有無）: **リポジトリ内に一切存在しない**ことを確認。
  - `supabase/functions/_shared/x_oauth2_post.ts`を全文確認：`loadXTokens`（`oauth_token_store`からの読み取り、無ければenv secretへfallback）、`refreshXTokens`（`grant_type=refresh_token`によるrefreshのみ）、`postToXWithRefresh`/`requestXWithAuthRefresh`（401時1回だけrefresh&retry）の3機能のみ。authorization URL生成・scope指定・PKCE (code_verifier/code_challenge)・callback/token exchangeのいずれも存在しない
  - リポジトリ全体を`redirect_uri`/`response_type=code`/`code_challenge`/`tweet.write`等でgrep検索したが、初回認証フローやscope文字列の定義は一切見つからなかった
  - 結論: **現在保存されているOAuth 2.0 user token（`oauth_token_store`）は、このリポジトリのコードでは一度も発行されておらず、過去に何らかの外部手段（X Developer Portal、Postman等）で人手で取得・登録されたものである**。`refreshXTokens`は`refresh_token`グラントのみを行い、これはOAuth 2.0仕様上、既存tokenのscopeセットを維持するだけで新しいscopeを追加することは原理的にできない。したがって、mediaupload権限を得るには**ユーザー本人による新規の認可(consent)フローの再実行が必須**であり、これはコード修正だけでは解決できない
- investigation_2（現在のtoken scopeをsecret露出なしで確認する方法）: Xは token scopeを安全にintrospectできる公開APIエンドポイントを提供していない（OAuth2 tokenのscope一覧を返す専用APIは無い）。実際にリクエストして200/403の結果からscopeの有無を推測する以外の安全な確認方法は無いと判断した。今回は「`/2/tweets`は成功・`/2/media/upload`は403」という既存の運用実績自体を、追加のAPI呼び出しをせずに得られる最良の状況証拠として採用した
- investigation_3（403 response bodyの診断可否）: **改善が必要と判断し実装した**。既存コードは`mediaResult.body`（Xのエラーレスポンス本文、JSONとして取得済み）を完全に破棄しており、`publish_claims.error_code`には`MORNING_GREETING_MEDIA_UPLOAD_FAILED:403`というHTTPステータスのみが残っていた。これが今回、根本原因をこの調査だけで確定できなかった直接の理由（Xが実際に返した`title`/`detail`/`reason`等が失われていた）
- changed_files（commit `1088081`、対象は`supabase/functions/x-test-post/**`のみ）:
  - `morning_greeting_publish_logic.ts`: `safeXApiErrorDetail()`を追加（`title`/`detail`/`type`/`reason`/`errors[0].message`/`errors[0].code`のみを許可リスト方式で抽出、他のフィールドは一切拾わない）。media upload失敗時のエラーコードに`:title=...;detail=...`等の形式で付加。403の自動retryなし、401の1回リフレッシュ&リトライは無変更
  - `morning_greeting_publish_logic_test.ts`: 新規test 2件。(1) X公式のproblem-detail形式（`title`/`detail`/`reason`）が安全に抽出されること、かつダミーで仕込んだ`access_token`フィールドが結果に一切含まれないこと（許可リスト方式であることの証明）。(2) `errors[]`形式のレスポンスから`message`/`code`が抽出されること、同様に`refresh_token`ダミーフィールドが漏れないこと
- Required_implementation_1〜3（scope追加・再認証フロー実装）について: **実装せず、理由を明記して見送った**。
  - §1「authorization requestにmedia.write等を含める」は、含める対象となる「authorization request生成コード」自体がリポジトリに存在しないため、コード上の変更対象が無い
  - §3「今後再現可能な最小の安全な再認証導線を提案/実装する」について、標準的なOAuth 2.0 + PKCEのauthorization URLは`redirect_uri`（X Developer Portal側で登録済みの値）を必要とするが、この値はリポジトリのどこにも記録されておらず、外部から安全に推測することもできないため、動作する認可URLをコード側で構築することは今回見送った（誤った値を含むURLを提示するとかえって混乱を招くため）。正確な手順は下記`required_user_action`に記載
- tests:
  - `node --test supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`：**15/15 pass**（既存13件＋新規2件）
  - `node --test supabase/functions/x-test-post/*_test.ts`（full regression）：**332/332 pass**
  - `node --test supabase/functions/_shared/x_oauth2_post_test.ts`：5/5 pass（無変更、影響なしを確認）
  - `npx tsc --noEmit`：新規追加コード範囲（`morning_greeting_publish_logic.ts` 145-172行付近・269行、testファイル226-311行付近）に新規の実質的エラーなし。既存の`TS18046 'error' is of type 'unknown'`等は同ファイルの既存テスト全体で同一パターンが繰り返し出現する、リポジトリ全体の既知のtsconfig事象（Deno向けコードをNode向けtscでチェックしているため）であり、今回の変更固有ではない
- commit_hash: `1088081`（`origin/main`へpush済み、親は`in_progress`commit `aaf4698`）
- production変更なし: DB migration/schema/GRANT、Cron、`posting_windows`、secrets、本番Edge Function deploy、実際のOAuth再認証・X Developer Console設定変更、X実投稿のいずれも一切実施していない
- required_user_action（ユーザー本人が実施する必要がある手順）:
  1. X Developer Portalで、投稿に使っているApp（`X_CLIENT_ID`に対応するApp）の「User authentication settings」を開き、現在の`redirect URI (callback URL)`を確認・記録する（このリポジトリには記録が無いため、Developer Portal側でのみ確認可能）
  2. 同じ画面でApp permissionsが「Read and write」以上になっていることを確認する（`media.write`はOAuth2 scopeとしてもApp権限としても必要）
  3. ブラウザで以下の形式の認可URLを開く（`<...>`部分はユーザー自身の値に置き換える。`code_verifier`/`code_challenge`はPKCE用に自分で生成するか、必要なら次タスクで生成用の最小スクリプトを用意できる）:
     `https://x.com/i/oauth2/authorize?response_type=code&client_id=<X_CLIENT_ID>&redirect_uri=<手順1で確認したredirect_uri>&scope=tweet.read%20tweet.write%20users.read%20offline.access%20media.write&state=<ランダム文字列>&code_challenge=<S256チャレンジ>&code_challenge_method=S256`
  4. 投稿用アカウントでログインし、同意画面で許可する
  5. リダイレクト先URLのクエリパラメータ`code`を取得する
  6. `POST https://api.x.com/2/oauth2/token`へ`grant_type=authorization_code`・取得した`code`・同じ`redirect_uri`・`code_verifier`・Basic認証（`client_id:client_secret`）を付けてPOSTし、新しい`access_token`/`refresh_token`を取得する
  7. 取得した新しいtokenは、チャットや平文ファイルに貼らず、secret変更権限のある場で`oauth_token_store`の該当行を安全に更新する（本タスクでは実施しない）
- remaining_issues:
  - 上記手順3〜6（実際の認可URL訪問・トークン交換）はユーザー本人の操作が必須で、本タスクでは一切実施していない
  - PKCE用の`code_verifier`/`code_challenge`生成を安全にローカルで行う最小スクリプトが必要であれば、別タスクとして用意可能
  - 新tokenの`oauth_token_store`への安全な書き込み手順（暗号化含む、既存`saveXTokens`の仕組みを利用）も、再認証完了後の別タスクとして計画が必要
- safety_checks:
  - `supabase/functions/important-news-monitor/**`、Codex現在task対象：一切変更していない
  - Claude slot1担当領域、`send-push-notifications/**`、close_reportロジック（`ce15350`修正含む）：一切変更していない
  - DB migration/schema/GRANT、Cron、`posting_windows`：一切変更していない
  - 本番Edge Function deploy、X実投稿、X Developer Console設定変更、実際のOAuth再認証・ユーザー同意操作：一切実施していない
  - production secrets：表示・変更していない
  - 既存の二重投稿防止claim、401時最大1回refresh、文字数retry：全regression test（332件）で無傷を確認
  - 他workstream（stocks sync関連、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない
- next_recommendation: (a) 今回のcommit`1088081`をレビューし問題なければK2、(b) 承認後、ユーザー本人にrequired_user_actionの手順1〜7を依頼（必要ならPKCE生成スクリプトを別タスクで用意）、(c) 新token取得後、`oauth_token_store`への安全な書き込みを別タスクで実施、(d) 書き込み後、`media upload`単体テスト→`morning_greeting`のdry-run/manual publishでread-only確認、という順で提案
