# Claude Task 1

- task_id: published-news-feed-and-push-tap-fix-20260910
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: Push通知をタップして `/news` を開いた際、すでに `published` になった重要ニュースが `get_my_important_stock_news` の状態条件から漏れて表示されない可能性を解消し、Push→ニュース一覧の導線を本番で一貫させる。

## Context

直前TASK `send-push-notifications-production-restore-20260910` は完了済み。

確認済み:
- `important-news-monitor` v37 は正しい最新版で本番稼働
- important news producerは本番投入済み
- `send-push-notifications` v4 は正しい最新版へ復旧済み
- `alert_settings.push_enabled` / `important_news` opt-outは本番Cron自然実行で実証済み
- 実在ニュースを使った `notifications -> Cron -> iPhone Push` はPASS
- Pushタップ時のクライアント遷移先は `/news`
- 既知問題: `public.get_my_important_stock_news` が現在 `status in ('ready_for_publish','generation_failed')` のような条件で絞っており、`published` を含まないため、自然publish済みニュースがPushタップ後の `/news` に表示されない可能性がある
- テスト用ウォッチ銘柄17件は自然E2E観測用として残している

## Model

変更自体は小さいが、DB RPC・本番migration履歴・アプリ表示導線・既存ニュース状態遷移をまたぐ。直近に本番deploy root事故があったため、安全監査込みで **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktreeの未コミット状態確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認
8. 他slotが `get_my_important_stock_news`、同じmigration、同じRPC、`/news` 関連ファイルを変更中なら開始せず競合報告
9. 本番RPC定義とrepo内migration/RPC定義を両方確認し、現在条件を推測でなく確定する
10. `/news` 画面がどのRPC/fields/statusを期待しているか確認する

既存未コミット変更は他workstream所有として扱い、変更・削除・stage・commitしない。

## Goal

`published` になった重要ニュースも、対象ユーザーの `/news` フィードに安全に表示されるようにする。

最低条件:
- `published` をフィード対象へ含める
- 現在表示対象の `ready_for_publish` / `generation_failed` 等を意図せず消さない
- `tracked_stocks.is_active=true` の既存対象判定を維持
- 他ユーザー/非登録銘柄のニュースを混ぜない
- 同じニュースの重複表示を増やさない
- Push producerの対象判定との整合を維持
- 既存Push/dispatcher/X投稿ロジックは変更しない

## Phase 1: Audit

まず実装せず以下を確定する。

- 本番 `public.get_my_important_stock_news` のSQL定義
- status filterの現状
- RPCのORDER BY / LIMIT / dedupe / ticker matching
- `/news` 画面で使用する返却列
- `published` 行に必要なtitle/body/source_url/company_code等が揃っているか
- `published` を足すことで古いbacklogや不適切な行が大量表示されないか
- feedに表示すべき時刻基準（published_at / generated_at / source published_at等）の現状を変える必要があるか

今回の主目的はstatus漏れ修正。無関係なフィード全面改修はしない。

## Phase 2: Minimal fix

監査で問題が `published` status漏れだけと確認できた場合、最小修正を行う。

推奨:
- 既存RPCのstatus条件へ `published` を追加
- 既存の対象銘柄マッチ、active判定、limit/order、返却shapeは維持
- migrationでRPC定義を更新する場合、既存権限/SECURITY DEFINER/SET search_path等を完全に保持
- migration名は今回専用にする

もし本番RPCとrepo定義が乖離している場合は、勝手にrepo版で上書きせず差分をReportして安全な統合案を決める。

## Phase 3: Tests

最低限:
- tracked stockに一致する `published` ニュース -> フィードに出る
- tracked stockに一致する現行status -> 従来どおり出る
- 非登録銘柄 -> 出ない
- inactive tracked stock -> 出ない
- 他ユーザーの追跡銘柄 -> 混ざらない
- 同一ニュース -> 重複しない
- order/limit -> 既存仕様維持
- return shape -> アプリ互換
- migration/SQL lint可能範囲
- `git diff --check`

## Production / verification

安全確認・テストPASS後に限り、今回のRPC修正に必要な **最小migration / RPC更新だけ** 本番適用してよい。

直近のmigration履歴乖離があるため、`supabase db push` を盲目的に使わない。本番migration historyを先に確認し、未適用migrationを巻き込まない方法を選ぶ。

本番適用後:
1. RPC定義が期待どおり `published` を含むことをread-only確認
2. 実在する対象銘柄の `published` ニュースがあれば、本人ユーザーでRPCをread-only実行し表示対象になることを確認
3. 非対象銘柄が混ざらないことを確認
4. Push通知行・X投稿・candidate status・backlogは変更しない
5. アプリ実機で `/news` を開ける場合は表示確認してよい。ただし人工ニュース投入は禁止

## Deploy / root safety

このタスクはEdge Function deployを原則必要としない。
Supabase CLIを使う場合は、前回事故対策として必ず:
- `pwd`
- git HEAD
- worktree内 `supabase/config.toml`
- linked project ref
を確認する。

共有checkoutを誤ってrootとして使わない。

## Forbidden

- `important-news-monitor`変更/deploy
- `send-push-notifications`変更/deploy
- `x-test-post`変更/deploy
- Cron変更
- secrets/OAuth変更
- alert_settings変更
- Push本文品質改善を同時実施
- 認証強化を同時実施
- X投稿
- 人工important-news candidate投入
- 既存backlogのstatus変更/削除
- unrelated migration

## Completion

終了時:
- status: `review_required`
- next_owner: `chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md` 規定どおり同期

Report必須:
- task_id
- result
- model_used
- production_rpc_before
- repo_definition_before
- root_cause
- chosen_fix
- changed_files / migration
- tests
- production_apply_method
- production_rpc_after
- published_news_positive_proof
- non_target_negative_proof
- app/news compatibility
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

## Report

- task_id: published-news-feed-and-push-tap-fix-20260910
- result: **完了**。`public.get_my_important_stock_news` の status 条件に `published` を追加する最小migrationを作成し、本番へ個別適用した。適用前後とも、本番の実データを使ったロールバック付きテストで全項目PASS（公開済みニュースが対象ユーザーのフィードに出る、既存の表示は維持、重複・登録外の混入・他ユーザーへの漏れなし、並び順・件数上限・戻り値の形・権限は不変）。人工のcandidateは入れておらず、Push・X投稿・candidateのstatus・backlogも変更していない。
- model_used: Opus 5

### production_rpc_before

本番の `pg_get_functiondef` で確定した（推測ではない）:
- `public.get_my_important_stock_news(p_limit integer default 50)`、LANGUAGE sql / STABLE / **SECURITY DEFINER** / `SET search_path TO ''`
- ACL `{postgres=X/postgres,authenticated=X/postgres}`（anon・service_role には実行権限なし）
- 条件: `tracked.user_id = auth.uid()`、`tracked.is_active = true`、`importance in ('important','most_important')`、**`status in ('ready_for_publish','generation_failed')`**、`duplicate_of is null`
- 銘柄の照合: `company_code ~ '^[0-9A-Z]{5}$' and left(company_code,4) = stocks_master.ticker_code`
- 並び順 `coalesce(published_at, created_at) desc`、件数上限 `greatest(1, least(coalesce(p_limit,50),50))`
- 本番に最後に適用されたmigrationは `20260905140638`（このRPCのmigration本体）

### repo_definition_before

`supabase/migrations/20260905140638_get_my_important_stock_news.sql` の定義は、本番と**同一**（乖離なし）。repo内で他にこのRPCを定義している箇所はない（参照は `src/lib/important-news.ts` と、producer側のコメント・テストだけ）。

### root_cause

このRPCは、重要ニュースのX自動投稿ができる前に書かれたもので、当時は `ready_for_publish` / `generation_failed` が最終状態だった。その後の自動投稿で candidate は `ready_for_publish → publishing → published` と進むようになったが、status 条件が更新されなかった。そのため、**ニュースがX投稿されてPush producerがユーザーに通知したまさにその時点で、`/news` から消える**状態になっていた（Pushをタップして `/news` を開いても、そのニュースが無い）。

監査で問題はこの status 漏れだけと確認した:
- `published` の行は title / body_summary / source_url / company_code がそろっている（欠損0件）
- 本番の重要ニュースは `generation_failed` 82 / `ready_for_publish` 30 / `published` 10。本人の登録銘柄に一致するのは `generation_failed` の1件だけで、`published` を足しても今は増えない＝古いbacklogが大量に表示されることはない
- 同じユーザー×同じニュースの重複は0件
- 時刻は `coalesce(published_at, created_at)`（元ニュースの公開時刻）で、`published` の行にも適切なので変える必要はない

### chosen_fix

status 条件に `'published'` を追加するだけ:
`news.status in ('ready_for_publish', 'generation_failed', 'published')`

それ以外（銘柄の照合、アクティブなウォッチ、重複除外、並び順、件数上限、戻り値の形、SECURITY DEFINER、空の search_path、コメント、authenticated だけへの権限）は元のmigrationと完全に同じ。元の本文との差分はこの1行だけ。

`publishing` / `publish_failed` は、タスクの推奨どおり今回は含めていない（下記 remaining_issues 1）。

### changed_files / migration

- `supabase/migrations/20260910200000_include_published_in_important_stock_news_feed.sql`（新規・今回専用）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

アプリ・Edge Function のコードは変更なし。

### tests

このリポジトリにはSQLのテスト基盤が無いので、**本番の実データ上でロールバック付きのテスト**を2回行った。1つのDOブロック内で実行し、最後に必ず `RAISE EXCEPTION` を投げて、関数の置き換えや一時的なウォッチ登録を含む**すべてをロールバック**させ、結果は例外メッセージで取り出した。`important_news_candidates` への書き込みは一切ない。

- 1回目: 適用前に、新しい定義へ一時的に置き換えて実行
- 2回目: 適用後に、**本番に適用された関数そのもの**に対して実行

両方とも全項目PASS（結果は同一）:

| # | 項目 | 結果 |
|---|---|---|
| 1 | 既存の表示（9984 ソフトバンクG `generation_failed`） | 表示される |
| 2 | 登録銘柄の `published` ニュース（4627 ナトコの実在の公開済みニュース。4627を一時ウォッチ） | **1件表示** |
| 2 | 同時に `generation_failed` も表示が維持されるか | 1件（維持） |
| 3 | 重複 | 2行・distinct 2（重複なし） |
| 4 | アクティブな登録銘柄以外の行 | 0件 |
| 5 | 並び順（新しい順） | true |
| 5 | 件数上限（`p_limit=1`→1件、`p_limit=0`→1件に補正） | 既存仕様どおり |
| 6 | ウォッチを非アクティブにした銘柄（9984） | 0件 |
| 7 | 他ユーザー（ランダムなuuid） | 0件 |
| 8 | 未ログイン | 0件 |
| 9 | 権限（authenticated 実行可 / anon 不可 / SECURITY DEFINER） | true / false / true |

各テスト後、ロールバックされたこと（関数が元のまま＝1回目の後、一時ウォッチ4627の行が無い、9984がアクティブ、ウォッチ総数20件）を確認した。

- 戻り値の形: `RETURNS TABLE` の列（名前・型・順序）は変更なし → アプリ互換
- `git diff --check`: clean、行末空白なし

### production_apply_method

- `supabase db push` は**使っていない**。本番の最後の適用が `20260905140638` で、repoにはそれより新しい未適用migration（`20260908110000`、および前々タスクで個別適用した `20260910163500`）があり、`db push` はそれらを巻き込むため。
- 今回のファイル1本だけを `supabase db query --linked -f <絶対パス>` で適用した。
- 適用直前にroot安全確認: `pwd` = worktree（`.claude/worktrees/ios-push-e2e`）、HEAD `1cd7a05`、worktree内に `supabase/config.toml` あり、linked project ref `wsmznyzcvmuitkglfeuj`。
- `supabase_migrations.schema_migrations` には記録していない（前々タスクの cron migration と同じ扱い。履歴の乖離は既知の残課題）。

### production_rpc_after

本番の read-only 確認:
- 定義に `'generation_failed', 'published'` の条件が入っている
- SECURITY DEFINER = true、`search_path=""`、ACL `{postgres=X/postgres,authenticated=X/postgres}`、anon の実行権限 = false（すべて適用前と同一）
- 本人フィード: 1件（9984 `generation_failed`）。適用前と同じで、登録外の混入0件

### published_news_positive_proof

- 適用後の本番の関数に対するロールバック付きテストで、**実在の公開済みニュース**（4627 ナトコ、2026-09-10 08:25 にX投稿済みの candidate）を一時ウォッチすると、フィードに1件表示されることを確認した（その後ロールバック）。
- 今の本人の登録銘柄には、`published` になっているニュースが無い（本番の公開済み10件はどれも登録銘柄と一致しない）。そのため、ロールバックを伴わない本人フィードでの自然な表示確認は、登録銘柄の重要ニュースが自然にpublishされるのを待つ必要がある。

### non_target_negative_proof

- 登録外の銘柄の行: 0件（テスト4、適用後の本人フィード）
- 非アクティブなウォッチ: 0件（テスト6）
- 他ユーザー: 0件（テスト7）
- 未ログイン: 0件（テスト8）

### app/news compatibility

- `/news`（`src/app/news.tsx`）は `fetchMyImportantStockNews()` → `rpc('get_my_important_stock_news', { p_limit: 50 })` を呼び、`news_id`（FlatList のkey）/ `ticker_code` / `company_name` / `tracking_type` / `title` / `summary` / `importance` / `news_time` / `source_url` を使う。戻り値の形は不変なので、アプリの変更は不要。
- `news_id` がkeyなので、重複行は表示の崩れにつながる。今回の変更で重複は増えないことをテスト3で確認した。
- 実機での `/news` 表示確認は行っていない（一致する `published` ニュースが今は無く、人工ニュースの投入は禁止のため）。

### commit_hash

- この直後のcommitで、migrationファイルと本Reportをまとめて記録する

### push

- `origin/main` へ同期済み

### remaining_issues

1. **`publishing` / `publish_failed` のニュースもフィードから消える**。`publishing` は数秒の過渡状態なので実害は小さいが、X投稿に失敗した `publish_failed` のニュースは、ニュース自体は有効なのに `/news` から恒久的に消える。これも「X投稿のパイプラインの状態がフィードの表示を左右する」同じ種類の漏れ。今回はタスクの推奨（`published` だけを追加）に従い、含めなかった。含めるかどうかはプロダクト判断として別途決めることを推奨する。
2. **同一ユーザーが同じ ticker を別の `stocks_master` 行（別市場）で登録していると、フィードで同じニュースが重複しうる**（既存の設計による。今は0件）。`/news` は `news_id` をkeyにしているので、発生すると表示が崩れる。今回の変更で増えることはない。
3. **migration履歴の乖離**（既知・継続）。本番の `schema_migrations` は `20260905140638` で止まっており、`20260908110000`（未適用）、`20260910163500`・`20260910200000`（個別適用済み・未記録）が repo と食い違っている。`db push` が安全に使えない状態が続いている。
4. 自然publishを起点にしたPush → `/news` の実機確認は未実施（登録銘柄の重要ニュースの自然publish待ち。テスト用ウォッチ17件はそのまま残している）。
5. 前タスクまでの既知課題（Push本文の品質 / `important-news-monitor`・`x-test-post` の認証不足 / `supabase/config.toml` がリポジトリ管理外 / dispatcherに原子的claimが無い）は継続。

### safety_checks

- 本番への変更は、今回のRPC定義の更新（`CREATE OR REPLACE` と、元と同一の権限の再付与）だけ
- Edge Function（5つ）はversion・`updated_at` とも変化なし。Cron・secrets・OAuth・`alert_settings` は変更していない
- 人工の important-news candidate は投入していない。candidate の status・backlog・notifications・X投稿も変更していない
- テストの一時データ（ウォッチ登録の追加と非アクティブ化）は、トランザクション内だけで行い、必ずロールバックされる構造にした。各テスト後にロールバックを確認した
- Supabase CLI は worktree の `supabase/config.toml` でrootを固定した状態で使った（共有checkoutを参照していないことを適用直前に確認）
- 共有checkoutの未コミット変更には触れていない

### next_recommendation

1. `publishing` / `publish_failed` をフィードに含めるかのプロダクト判断（remaining_issues 1）
2. migration履歴の整合（`schema_migrations` のbaselineをそろえて、`db push` を安全に使える状態に戻す）
3. 自然publishを起点にした「Push → タップ → `/news` に表示」の実機確認（テスト用ウォッチは観測後に削除）
