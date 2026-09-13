# Claude Task 2

- task_id: x-multibrand-phase3h-ai-lab-prelive-safeguards-20260913
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet 5
- purpose: 会社員AIラボの初回live投稿前に、280文字制限・fingerprint永続化・Vault-backed dispatch配線・posting window準備を安全に仕上げる。実X投稿、live化、write scope追加はまだ行わない。

## Source of truth

会社員AIラボの実際の投稿内容・文体・note送客・ブランド運用の正本は別の「会社員AIラボ」ChatGPTプロジェクト側。
本repoで人格や投稿戦略を新しく創作しない。

今回ユーザーから追加で確定した要件:
- 現在の会社員AIラボX運用は **280文字以内** が必須。
- 将来アプリ化する際は「280文字以内モード」と「無制限モード」を選べる設計にしたい。
- そのため固定ハードコードではなく、将来ユーザー設定へ一般化しやすい `max_chars` / length mode 相当で設計する。

## Prior approved state

Phase 3G K2 PASS。

- Phase 3G commits: `8f3b789` -> `341e5dc` on `feature/multibrand-foundation`
- `published_content_fingerprints` production-applied and verified
- real Kabumori published content 4件を使うcross-brand dedupe proof成功
- `brand-post-dry-run` deployed, byte-verified
- AI Lab Vault route metadata proof成功:
  - brand_id=`ai_salaryman_lab`
  - handle=`kaishain_ai_lab`
  - access/refresh token refs present
  - legacy fallback=false
- `publish_claims` is not required for `brand_post`
- AI Lab posting_windowsは未作成（正本の時間帯/スロット数/daily_probability未確定）
- AI Lab remains `publish_mode=dry_run`, `publish_enabled=false`
- X writes=0
- AI Lab OAuth scopes remain read-only: `tweet.read users.read offline.access`
- Kabumori/Mio/Cron unchanged

## Start / parallel safety

開始前に必ず:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- 他3slot TASK（競合確認に必要な範囲のみ）
- origin/main fresh-check
- origin/feature/multibrand-foundation fresh-check
- isolated clean worktree/clone

同じFunction/RPC/migration/workflow/production configを他slotが変更中なら停止して競合報告。
既存未コミット変更は他workstream所有物として触らない。

通常はSonnet 5。dispatch/OAuth/token refresh/Cronの根本設計変更が必要になったら大変更前に停止し、Opus切替を推奨。

## Goal

初回AI Lab live投稿の直前まで、以下を完成させる。

1. AI Lab生成文を280文字以内に強制する、将来一般化可能な文字数制御
2. 生成後にもサーバー側で上限検証し、超過文がpublish経路へ進めないことを保証
3. `published_content_fingerprints` をlive publish完了経路へ安全に書き込むための共通処理を実装・テスト
4. Kabumori既存publish完了経路へ回帰を起こさない形でfingerprint記録を配線できるところまで仕上げる
5. AI Lab `brand_id -> social_account -> Vault-backed token loader` を実dispatch経路へ配線する。ただしpublish gateが閉じた状態でのみ検証し、X writeは0
6. AI Lab posting_windowsの必要入力を明確化し、正本が確定していればinactive行のみ準備。未確定なら推測しない
7. 初回live投稿に必要なOAuth write scope変更のexact planを確定するが、scope追加・再OAuthはまだ実行しない
8. AI Labを最後までdry_run/publish_disabledのまま維持

## A. Length mode / max_chars

将来の一般ユーザーアプリを意識した設計にする。

最低要件:
- 文字数制限をprofile/settings側の設定として表現できる
- AI Labは現時点で `max_chars=280`
- 無制限モードを将来表現可能（例: `max_chars=null` または明示的mode）
- generator promptにも上限を伝える
- **prompt依存だけにしない**。生成後にサーバー側で実文字数検証する
- 280超過ならpublish candidateとして成功扱いにしない
- 安全な自動再生成/圧縮を実装する場合、回数上限を設ける。無限retry禁止
- 最終的に280以内にならない場合はfail closed
- URL・改行・日本語を含むXの実際の文字数計算との差異を調査し、単純JS `.length` で十分でないなら専用count関数を分離する
- ただしX API writeはしない

テスト:
- 279/280/281相当境界
- 日本語
- ASCII
- 改行
- URLを含むケース
- unlimited mode
- AI Labは280、Kabumori既存挙動は不変
- 超過文がpublish gate以降へ進めない

## B. Fingerprint write path

`published_content_fingerprints`を「作っただけ」で終わらせず、将来のlive publish成功後に記録される共通処理を作る。

要件:
- X publish **成功後のみ** fingerprintを記録する設計
- 失敗投稿/未投稿/dry-runでは記録しない
- brand_id/social_account_id/post_type/published_at/hashの帰属を保持
- normalized exact hashは既存cross-brand dedupeと同一規則を使う
- raw post bodyをfingerprintテーブルへ保存しない
- duplicate insert/retryに対して安全（必要ならidempotency設計）
- Kabumori既存publish完了経路への配線は回帰テストを十分に行う
- AI Lab live経路でも同じ共通処理を再利用できる設計

本番で実Kabumori投稿を発生させてテストしてはいけない。
既存成功データをread-only利用するか、ローカル/fixtureで証明する。

本番DBへのbackfillはこのタスクでは禁止。必要性が判明したら提案だけする。

## C. Vault-backed dispatch routing

AI Labの実dispatchでlegacy Kabumori token storeへ落ちない構造にする。

目標経路:
`scheduled_post.brand_id`
-> BrandContext
-> social_account
-> Vault refs
-> Vault-backed token loader
-> publish safety gate
-> （Phase 3Hではここで停止）

要件:
- `ai_salaryman_lab`はVault-backed loaderのみ
- Kabumori legacy fallback禁止
- Kabumori現行token経路は変更しない、または同等性を厳密に維持
- token値をログ/Report/responseへ出さない
- token refreshが必要でも、Phase 3Hでは不用意に実行しない。安全なread-only/metadata proofで足りるならそれを優先
- live X POST/media uploadへ到達しないことをテストで固定
- `publish_mode=dry_run` / `publish_enabled=false` の既存gateを維持

もし巨大 `x-test-post/index.ts` 変更が高リスクなら、薄い共通router抽出など最小変更を検討する。広範なリファクタは禁止。

## D. Posting windows

会社員AIラボ側の正本で以下が確定しているか確認:
- 投稿時間帯
- 1日のslot数
- daily_probability
- 曜日差/平日休日差の有無

このrepo/現TASKから確認できなければ**推測しない**。

確定値が無い場合:
- DB変更なし
- Reportに必要入力を明記

確定値がある場合:
- `brand_id=ai_salaryman_lab`
- `is_active=false`
- Kabumori rowは変更しない
- Cron変更なし
- inactiveではclaimされないことをread-back/test

## E. OAuth write scope readiness

初回live投稿に必要なwrite scopeを正確に調査して、次タスク用の変更手順を作る。

Phase 3Hで禁止:
- `tweet.write`追加
- `media.write`追加
- 再OAuth実行
- AI Lab token mutation
- X POST/media upload

Reportには:
- text-only初回投稿に必要な最小scope
- 画像投稿を後日行う場合の追加要否
- scope変更後に既存read-only tokenをどう更新/再認可するか
- rollback方法
を明記。

## F. Dry-run proof

更新後 `brand-post-dry-run` もしくは専用safe proofで最低限確認:
- generated text <= 280 for AI Lab
- `brand_id=ai_salaryman_lab`
- cross-brand real-data dedupe正常
- vault routing = Vault-backed AI Lab account
- legacy fallback=false
- publish gate blocks
- x_write_calls=0
- fingerprint write count=0 in dry-run

deployが必要ならexact diffを確認し、**brand-post-dry-runのみ**ならユーザー承認を求めてからproduction deployする。
他Functionのproduction deployが必要なら必ず個別に止めて承認を取る。

## Required tests

最低限:
- 280-char boundary tests
- unlimited mode tests
- AI Lab max_chars=280 profile/settings proof
- over-limit fail-closed/retry-cap test
- Kabumori generation regression
- fingerprint normalization/write helper tests
- dry-run never writes fingerprint
- failed publish never writes fingerprint
- successful publish semantic path writes exactly once (mock/local)
- AI Lab Vault route no legacy fallback
- X write endpoint unreachable while dry_run/publish_disabled
- brand isolation regression
- cross-brand dedupe regression
- all relevant Edge Function tests
- `git diff --check`
- `deno check` changed files; known environment failures must be compared with unchanged baseline

## Production prohibitions

厳禁:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- `tweet.write` / `media.write` scope追加
- AI Lab実X投稿/test post/media upload
- Kabumori manual retry/test post
- Kabumori OAuth/token/handle/Cron変更
- Mio変更
- Cron変更
- blind `supabase db push`
- migration history repair/reconcile
- destructive DB change
- fingerprint backfill
- secret/token/password/2FAの表示・保存・Report記載

## Completion / Report

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- task末尾に `## Report`
- origin/mainへ制御情報を安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- length_mode_design
- ai_lab_280_char_result
- fingerprint_write_path_status
- vault_dispatch_routing_status
- posting_window_status
- oauth_write_scope_readiness
- dry_run_proof
- x_write_calls_count
- fingerprint_writes_in_dry_run
- changed_files
- migrations/rpcs/functions changed
- tests
- production_changes
- deploy_status
- commit_hash
- push
- remaining_issues
- exact steps before first AI Lab live post
- safety_checks
- next_recommendation

## Success gate

Phase 3H PASS条件:
- AI Lab生成本文がサーバー側検証込みで280文字以内に制御される
- unlimited modeへ一般化可能な設計
- fingerprint write helper/live-success semanticsが実装・テストされる
- dry-run/failed publishではfingerprintを書かない
- AI Lab Vault-backed dispatch routeがlegacy fallbackなしで証明される
- posting_windowsは正本未確定なら推測せず保留
- OAuth write scopeのexact next-stepが確定
- AI Lab remains dry_run + publish_disabled
- X write=0
- write scopes still absent
- Kabumori/Mio/Cron regressionなし

Phase 3Hは初回実X投稿を許可しない。実投稿は別タスク + ユーザーの明示承認が必要。