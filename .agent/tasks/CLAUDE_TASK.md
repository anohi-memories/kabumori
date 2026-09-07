# Claude Task 2

- task_id: morning-greeting-x-media-scope-reauth-20260908
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
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
