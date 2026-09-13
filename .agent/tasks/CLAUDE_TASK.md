# Claude Task 2

- task_id: x-multibrand-phase3d-ai-lab-dry-run-routing-safety-20260913
- owner: claude
- slot: claude-2
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus 5
- purpose: 会社員AIラボを実投稿させる前に、dry-runでブランド別の生成・schedule・claim・publish経路がKabumoriと完全分離されていることを確認し、不足があれば最小修正する。実X投稿はまだ行わない。

## Current confirmed state

- Kabumori OAuth recoveryはC1 PASS / task done。自然Cron経路で自動投稿復旧済み。
- `ai_salaryman_lab_x` はOAuth接続済み、`connection_status=identity_verified`。
- AI Lab brandは `publish_mode=dry_run`。
- AI Lab `publish_enabled=false`。
- AI Lab OAuth scopeは `tweet.read users.read offline.access` のread-only。`tweet.write` / `media.write` は付与していない。
- AI Lab access/refresh tokenはVault参照で保持し、handle `kaishain_ai_lab` 本人確認済み。
- Mioは未接続。今回触らない。
- Kabumori既存投稿経路は稼働中。壊さない。

## Goal

実投稿解禁前のPhase 3Dとして、以下を完了する。

1. AI Lab専用のdry-run投稿生成を安全に実行できる。
2. AI Labのscheduled post / candidate / execution logがすべて `brand_id=ai_salaryman_lab` で閉じる。
3. claim経路がbrand-awareで、Kabumoriの予定をAI Lab実行がclaimしない、逆も起こらない。
4. publish経路がbrand/account-awareで、対象ブランドのsocial account以外のtokenを読まない。
5. `publish_mode=dry_run` または `publish_enabled=false` の場合、X API write endpointへ到達しないことをテストで証明する。
6. KabumoriとAI Lab間で同一/近似内容を誤って同時配信しないための重複防止設計を確認し、最低限のガードを入れる。
7. 会社員AIラボで本番実投稿を有効化するために残る作業を明確化する。

## Required startup checks

開始前に必ず読む:
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CODEX_TASK.md`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/tasks/CLAUDE_TASK_1.md`

そのうえで:
- origin/main fresh-check
- isolated clean worktree/cloneを使う
- 既存未コミット変更は他workstream所有物として触らない
- Codex slot2のPush hardening、Claude slot1のimportant-news-monitorと変更対象が重なる場合は開始せず競合箇所を報告する

## Investigation first

実装前に現在の実経路をコードとread-only productionで特定する。

最低限:
- AI生成 entry point
- scheduler/planner
- `scheduled_posts` 作成
- claim RPC / claim function
- execution path
- X publish function
- social account / token selection
- dedupe / cooldown
- execution logs

特に `claim_due_post` / 同等RPCがbrand-awareかを重点確認する。

## Dry-run execution

AI Labの実投稿は禁止だが、dry-run生成・DB記録・ログ確認は許可する。

実施条件:
- `publish_mode=dry_run` 維持
- `publish_enabled=false` 維持
- X write scopesは追加しない
- X post/media API callは0件

既存仕組みで安全にAI Lab dry-runを起動できるなら、synthetic production X postではなく、生成→schedule/candidate→claim判定→dry-run停止までを確認してよい。

もしproduction dry-run起動に人工INSERTが必要、または自然経路では安全に分離確認できない場合は、まずローカル/テスト環境で再現し、production人工INSERTは行わずReportへ残す。

## Brand-routing safety requirements

最低限、以下を満たすこと。

### Scheduling
- `scheduled_posts.brand_id` を必須のルーティング情報として扱う。
- AI Lab plannerがKabumoriのposting windows / persona / prompt / settingsを参照しない。
- Kabumori plannerがAI Lab設定を参照しない。

### Claim
- due post claimは対象brandを明示してclaimできる、または一件claim後もbrand/account routingが誤らない構造であることを証明する。
- 可能ならRPCレベルでbrand isolationを入れる。
- 同時実行で別brand rowを奪わないテストを追加する。

### Publish
- X publish前に `brand_id -> social_account` を解決し、対象accountのpublish gateを確認する。
- `publish_mode != live` または `publish_enabled != true` ならwrite API前にfail-closed。
- AI Lab dry-runからlegacy Kabumori `oauth_token_store` を読まない。
- Kabumoriは既存経路を壊さない。大規模移行は今回しない。

### Logging
- execution log / error log / candidate / scheduled rowにbrand attributionが残る。
- secret/token/code/verifierをログへ出さない。

## Cross-brand duplicate guard

公開アプリ化を見据え、最低限のcross-brand重複防止を設計/実装する。

このPhaseでは大規模なsemantic vector基盤は不要。

最低限候補:
- normalized text hash
- recent-window exact duplicate block
- near-duplicate用の軽量fingerprintまたは既存類似度ロジック再利用
- same brand と cross brand の閾値/扱いを明確化

要件:
- KabumoriとAI Labが同一文面を誤って配信するのを防ぐ
- 正当な同一ニュースへの別ブランド独自解説まで過剰ブロックしない
- dry-runでは「would block / would allow」を観測できる

## Tests required

最低限:
- AI Lab generation uses AI Lab persona/settings only
- Kabumori generation remains Kabumori only
- two brands with due rows: claim isolation
- AI Lab dry_run blocks X POST before network write
- AI Lab publish_enabled=false blocks X POST before network write
- AI Lab path never loads legacy Kabumori token store
- Kabumori existing publish regression
- exact cross-brand duplicate is blocked
- sufficiently different cross-brand text is allowed
- brand_id persists through scheduled_posts -> execution log
- failure path retains correct brand_id
- all existing relevant Edge Function tests
- deno check
- git diff --check

## Production safety / prohibited

禁止:
- AI Lab `publish_mode=live`
- AI Lab `publish_enabled=true`
- AI Labへの `tweet.write` / `media.write` scope追加
- AI Lab実X投稿 / test post / media upload
- Kabumori token/OAuth再変更
- Mio接続/変更
- Cron変更
- unrelated scheduler変更
- Push通知領域
- important-news-monitor領域
- migration history repair/reconcile
- blind `supabase db push`
- secret/token/password/2FAの表示・保存・Report記載
- destructive production DB変更

本番schema/RPC変更またはEdge Function deployが必要な場合:
1. ローカル実装・テストを完了
2. exact diff / migration / deploy対象をReportへ記載
3. `status=review_required`, `next_owner=chatgpt`
4. K2承認前に本番変更しない

read-only production調査は可。

## Completion / Report

完了時はこのファイル末尾へ `## Report` を追加し、以下を必須記載:
- task_id
- result
- model_used
- source_base
- current_routing_map
- claim_brand_safety
- publish_brand_safety
- dry_run_result
- x_write_calls_count
- cross_brand_dedupe
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

終了時:
- `status: review_required`
- `next_owner: chatgpt`
- origin/mainへ安全に同期

実装不要で現状が十分安全と証明できた場合も、その証拠をReportへ残してreview_requiredにする。
