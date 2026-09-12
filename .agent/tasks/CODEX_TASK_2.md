# Codex Task 2

- task_id: push-delivery-deduplication-hardening-20260912
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: 重要ニュース・市場Critical・個別朝刊/大引けで共有するPush通知経路について、二重enqueue・二重claim・retry・Cron重複・Expo再送などの重複通知リスクを監査し、既存機能を壊さず必要最小限のhardeningを行う。

## Context

現在のPush系統:
- important-news-monitor → notifications → send-push-notifications
- market critical news → notifications → send-push-notifications
- personalized-reports → enqueue_personalized_report_notification → notifications → send-push-notifications

既知事項:
- personalized_reportは source_type/source_id の部分ユニークindexで同一report通知を防止済み。
- market critical producer側は同一 user/news/event の重複防止あり。
- important news producerにも重複防止が存在する。
- send-push-notificationsは本番 v4。
- dispatcherはenqueue後に market_critical_news settingを再checkしないため、設定OFF直後の小さなraceが残っている。
- 重要ニュース系統が増えたため、producerだけでなくdispatcher/claim/retry/Cronまでend-to-endで重複耐性を確認する必要がある。

## Required startup checks

1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. このTASK
4. fresh `origin/main`
5. clean temporary worktree
6. 他slot TASKをread-only確認
7. `important-news-monitor` / `send-push-notifications` / notifications関連RPC・migrationを他slotが変更中なら競合報告して開始しない
8. 既存未コミット変更には触れない
9. migration history divergenceを確認し、`supabase db push` は使用しない

## Phase A — read-only architecture audit

まず変更せず、以下をend-to-endで整理する。

### Producers
- important news enqueue経路
- market critical enqueue経路
- personalized report enqueue経路
- 各経路のdedupe key / unique index / RPC idempotency
- 同一eventをproducerが2回処理した場合の挙動

### Queue / DB
- notifications tableのstatus lifecycle
- pending / processing / sent / failed 等の実際の状態
- claim方法
- row locking / SKIP LOCKED / atomic update等の有無
- retry_count / next_retry / provider receipt等の保持
- unique制約がNULLを含むケースで抜けないか

### Dispatcher
- send-push-notifications v4 のclaim処理
- 同時に2つのdispatcherが走った場合に同じnotificationを送らないか
- Function timeout直前・送信成功後DB更新失敗の挙動
- Expo API 5xx / timeout / transport retryの挙動
- provider側で受理済みなのにclient側timeoutした場合の重複リスク
- push_status更新順序

### Cron
- dispatcher cronの頻度と重複起動可能性
- net.http_post / pg_cron側のre-entry
- 前回実行が終わる前に次回が始まった場合の安全性

### Settings race
- enqueue後、dispatch直前に push_enabled / market_critical_news / morning_report / close_report をOFFにした場合の挙動
- product intentに照らしてdispatcherで再checkすべきものと、enqueue時snapshotで良いものを区別する

## Phase B — risk classification

監査結果を少なくとも以下で分類する。
- P0: 現実に同一Pushが重複送信され得る
- P1: 障害時のみ重複し得る
- P2: 理論上あるが現状保護済み
- no issue

各riskに対し、再現可能なテストまたはDB rollback-contained proofを作る。

## Phase C — minimal hardening

本当に必要な箇所だけ変更する。

設計原則:
- producer固有dedupeを維持
- queue claimはatomic/idempotent
- 同じnotification rowを複数dispatcherが同時送信できない
- retryで別rowを作らない
- Expo送信後のDB更新失敗時に無制限再送しない
- sent済みrowは二度送らない
- notification dedupe keyを弱めない
- important news / market critical / personalized reportの既存通知条件を壊さない

必要なら以下を検討してよい:
- claim token / locked_at / processing timeout
- atomic RPCでのclaim
- attempt identifier
- provider ticket ID保持
- bounded retry
- stale processing reclaim
- dispatcher直前の設定再check

ただし大規模なqueue再設計は避け、必要最小限にする。

## Settings policy

特に以下を明確にする。

- `push_enabled=false` はdispatch直前にも尊重する方向を優先。
- `market_critical_news=false` は、market critical通知がまだ未送信ならdispatch直前にも尊重する方向を優先。
- `morning_report` / `close_report` も、未送信notificationなら可能ならdispatch直前に尊重する。
- ただし既存notification schemaでsource_typeから安全に判別できない場合、推測で適用しない。

## Required tests

最低限:
- same producer enqueue twice -> 1 notification
- same personalized_report enqueue twice -> 1 notification
- same market critical enqueue twice -> 1 notification
- two concurrent dispatcher claims -> same row is sent at most once
- sent row cannot be reclaimed
- failed/retry row does not create duplicate row
- stale processing reclaim is bounded if implemented
- push_enabled OFF before dispatch -> no send
- market_critical_news OFF before dispatch -> pending market critical no send（実装した場合）
- morning_report / close_report OFF before dispatch -> corresponding pending report no send（安全に判定可能なら）
- unrelated important_news regression
- Expo provider error / timeout fail-safe
- Cron overlap simulation
- existing send-push tests
- important-news-monitor regression if touched
- personalized-reports regression if touched
- `deno check` for changed modules
- `git diff --check`

DB変更が必要な場合:
- expand-only
- rollback-contained proof
- `supabase db push` 禁止
- 本番適用はC2承認前に勝手に行わない。まず実装・テスト・Reportまで。

## Production safety

原則、このTASKの最初の完了点は **実装 + テスト + production change proposal** まで。

以下はC2の追加承認なしで実施しない:
- DB migration本番適用
- send-push-notifications本番deploy
- important-news-monitor本番deploy
- Cron変更
- 実Push送信テスト

read-only本番監査は可。

禁止:
- X投稿系変更
- x-test-post変更/deploy
- personalized reportの内容生成ロジック変更
- OAuth/Vault/social_accounts変更
- user設定の変更
- 架空notificationの本番投入
- `supabase db push`

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT_2.md` 更新
- origin/main同期

Report必須:
- task_id
- model_used
- current_architecture
- producer_dedupe_audit
- queue_claim_audit
- dispatcher_retry_audit
- cron_overlap_audit
- settings_race_audit
- risk_classification
- code_changes
- schema_changes_if_any
- tests
- production_changes: none / proposed only
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation
