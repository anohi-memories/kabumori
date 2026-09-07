# Claude Task 2

- task_id: morning-greeting-x-media-scope-reauth-20260908
- owner: claude
- slot: claude-2
- status: done
- next_owner: chatgpt
- priority: urgent
- purpose: 2026-09-08朝の`morning_greeting`が`MORNING_GREETING_MEDIA_UPLOAD_FAILED:403`で安全停止した原因を、X OAuth 2.0のmedia upload権限と実装方式まで確認し、画像付き朝の挨拶を安全に復旧できる状態へ整える。

## Report

- result: 403の最有力原因を特定。現行の`POST /2/media/upload`実装形式はX v2仕様と整合しており、既存OAuth 2.0 user tokenに`media.write` scopeが無い可能性が最も高い。
- OAuth初回認証フロー: リポジトリ内にauthorization URL生成、scope定義、PKCE、callback/token exchangeは存在しない。現在のコードは保存済みtoken読込とrefreshのみ。
- 既存refresh tokenのrefreshでは新scopeは追加できないため、`media.write`取得にはユーザー本人による再認証が必要。
- X側403 response bodyを従来破棄していたため、`title`/`detail`/`type`/`reason`/`errors[0].message`/`errors[0].code`だけをallowlistで記録する安全診断を追加。token/secret系フィールドは記録しない。
- 403は自動retryしない。401時のみ既存どおり最大1回refreshして同一media requestを再試行する。
- changed files:
  - `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
  - `supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`
- tests:
  - morning greeting publish: 15/15 pass
  - full x-test-post regression: 332/332 pass
  - shared x_oauth2_post: 5/5 pass
- commit: `1088081`
- production変更なし: deploy / X実投稿 / OAuth再認証 / Developer Console変更 / secrets / DB migration/schema/GRANT / Cron / posting_windows は未実施。

## Required user action

実際の復旧には次工程で以下が必要:
1. X Developer Portalで対象Appの登録済みredirect URIを確認。
2. App permissionsがRead and write以上であることを確認。
3. OAuth 2.0 + PKCEで `tweet.read tweet.write users.read offline.access media.write` を要求して再認証。
4. authorization codeをtoken endpointで新しいaccess/refresh tokenへ交換。
5. tokenをチャットや平文へ貼らず、既存暗号化方式で`oauth_token_store`へ安全に保存。
6. media upload単体テスト後、morning_greeting manual publishを1回だけ安全確認。

## K2 Review

- decision: approved
- reviewed_by: chatgpt
- reviewed_commit: `1088081`
- result:
  - 403の最有力原因として`media.write`不足を示す根拠は十分で、request形式のバグではないことを確認。
  - リポジトリ内に初回OAuth認証フローが存在しないため、今回scope追加をコードで完結できなかった判断は妥当。
  - allowlist方式の403 diagnosticsはsecret/token漏洩を避ける最小変更で、既存の403 non-retry / 401 single-refresh / 二重投稿防止を維持。
  - 15/15、332/332、5/5 PASSを確認。
  - 本番変更なし。
- remaining:
  - 実際の復旧はX Developer Portalでredirect URI確認 → PKCE再認証 → 新token安全保存 → media upload testが必要。
