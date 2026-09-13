# Claude Task 1

- task_id: broad-news-phase3-production-rollout-20260913
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Opus 5
- purpose: C1承認済みのPhase 3（medium以上のアプリ表示、カテゴリ/重要度表示、通知プリセット、emergency/category設定）を安全に本番反映し、アプリ実画面と自然Cron/Push経路を確認する。

## Approved source

Codex H1 `broad-news-display-and-notification-presets-phase3-20260913` はC1 PASS済み。

承認済み実装commit:
- `f7c17b915c551ba81b1dfc62a0731fd3eba6f008`

承認済み内容:
- market-wide medium以上をアプリ表示
- emergency / critical / high / medium の表示
- 16カテゴリ日本語ラベル
- 通知preset: quiet / standard / many / all_useful
- `emergency_alerts`
- 行形式 `alert_category_settings`
- market emergencyはtracked stock / sector一致不要
- 未分類カテゴリは「設定なし＝有効」
- emergency notificationの `tracked_stock_id` はNULL
- dispatcher / claim RPCは変更なし
- 既存ユーザーはmigration適用だけでは通知量を増やさない

C1確認済みテスト:
- important-news runtime 395/395
- Push/レポート回帰 48/48
- app presentation 27/27
- changed app TypeScript PASS
- iOS Expo export PASS
- git diff --check PASS

## Goal

本番反映と実利用確認を完了する。

順序:
1. origin/main fresh-check + 他slot競合確認
2. exact migrationの本番適用前proof
3. exact migrationのみ本番適用
4. schema / ACL / RLS / RPC / legacy互換のread-back
5. `important-news-monitor` のみdeploy
6. deploy後runtime source read-back / byte compare
7. 他Function / Cron / dispatcher / claim RPC不変確認
8. iOS SimulatorまたはDevelopment Buildでニュース一覧・detail・設定UI確認
9. 自然Cronでcandidate/app copy/enqueueが動くことをread-only観測
10. synthetic/manual Pushなしで、自然通知が発生すれば到達を確認。発生しなければ未観測と明記

## Production authorization

ユーザー承認 + C1 PASSにより、今回許可する本番変更は以下のみ。

### DB
`supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql`
を単体で適用してよい。

必須:
- `supabase db push` 禁止
- migration history repair/reconcile禁止
- unrelated migration禁止
- destructive変更禁止
- 適用前にrollback-contained proof
- 適用後read-back

### Edge Function
read-backが成功した場合のみ `important-news-monitor` をdeployしてよい。

必須:
- deploy対象は `important-news-monitor` のみ
- production current version/sourceを事前記録
- deploy後sourceをdownload/read-backしてrepo sourceと比較
- 他Edge Function version / updated_at不変確認
- verify_jwt等の既存設定を意図せず変更しない

## Do not touch

G2は別workstreamで進行中。以下を触らない:
- `x-oauth-connect`
- OAuth / Vault / social_accounts
- X token / callback
- AI Lab routing / dry-run

H2 Push hardening境界:
- `send-push-notifications` のclaim/retry/CAS
- `claim_pending_push_notifications`
- notifications claim schema/RPC

その他禁止:
- Cron変更
- X投稿
- synthetic candidate
- manual/synthetic Push
- unrelated user setting変更
- migration history修復
- secrets/token出力

## Required production read-back

最低限確認:
- `alert_settings.notification_preset`
- `alert_settings.emergency_alerts`
- 既存alert_settings行がmigrationだけで勝手にpreset/emergencyへ書き換わっていない
- `alert_category_settings` RLS / grants
- `set_my_important_news_alert_preferences(...)`
- app feed RPCがmedium以上 + emergency無関連許可
- unified producer RPCのservice-role boundary
- NULL tracked_stock_id market notification dedupe index
- `market_critical_news` legacy compatibility
- morning_report / close_report設定不変

## App verification

可能ならSimulator/Development Buildで最低限:
- ニュース一覧が開く
- medium表示条件が反映される
- severity日本語ラベル
- category日本語ラベル
- detail表示
- 4段階preset UI
- emergency toggle
- category ON/OFF
- 保存→再読込一致
- 既存ユーザー初期表示が突然「多め」相当にならない

実ユーザー設定を書き換える必要がある場合は、既存値を記録し最小範囲で確認後、ユーザーが明示的に選んだ値以外へ勝手に変更しない。実設定変更なしでUI確認可能ならそれを優先。

## Natural observation

本番反映後はmanual runをせず、自然Cronをread-only観測する。

確認:
- candidate取得が継続
- coverage severity/categoryが保持
- app copy生成が継続
- producerエラーなし
- duplicate enqueueなし
- dispatcher pending滞留なし
- Pushが自然発生した場合のみdelivery確認

自然ニュースが無ければ「未観測」としてよい。人工ニュース投入は禁止。

## Completion

完了時:
- status: `review_required`
- next_owner: chatgpt
- origin/mainへ安全に同期

Report必須:
- task_id
- result
- model_used
- source_base
- migration_proof
- migration_apply
- schema_readback
- function_before_after
- deploy
- runtime_byte_compare
- other_functions_unchanged
- app_verification
- natural_cron_observation
- natural_push_observation
- settings_compatibility
- tests/rechecks
- production_changes
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation


## Report

- task_id: broad-news-phase3-production-rollout-20260913
- result: **本番反映完了**。許可された2操作（対象migration単体適用 → `important-news-monitor` のみdeploy）を実施し、事前proof・read-back・byte compare・他Function不変確認はすべて成功。ユーザー本人がアプリ実画面で「すべて正常」を確認済み。自然Cron観測では、**Phase 3の効果（市場mediumの日本語コピー生成）と Phase 2 の分類書き込みが実データで動作していることを確認**。自然Pushは観測期間内に発生せず（未観測）。
- model_used: Claude Opus 5
- source_base: `origin/main` `7546e99` → fast-forward後 HEAD `2be0f34`（承認commit `f7c17b915c551ba81b1dfc62a0731fd3eba6f008` を含むことを `git merge-base --is-ancestor` で確認）。

### 事前確認（競合）

- `origin/main` fresh-check 済み。他slotの状況:
  - Codex slot 1: `x-multibrand-phase3c-oauth-start-void-rpc-fix`（review_required / user）
  - Codex slot 2: `push-delivery-deduplication-hardening`（review_required / chatgpt）
  - Claude slot 2: X複垢OAuth（Phase 3F in_progress）
- 触っていない: `x-oauth-connect` / OAuth / Vault / social_accounts / X token / AI Lab routing / `send-push-notifications` / `claim_pending_push_notifications` / notifications claim schema。
- 対象migrationに `claim_pending_push_notifications` の文字列は1回だけ出現するが、**コメント行のみ**（「dispatcher と claim RPC は意図的に変更しない」の記述）。

### migration_proof（rollback-contained、すべて ROLLBACK）

対象: `supabase/migrations/20260913140000_broad_news_visibility_notification_presets.sql`（sha256 `4795a0fdafcfe990459d90d2395264fd2abbba2ac56c2c8154076a4b81e72ef2`、620行）

| 検証項目 | 結果 |
| --- | --- |
| 既存 `alert_settings` 行 | `notification_preset` NULL / `emergency_alerts` NULL のまま（**migration適用だけでは通知量が変わらない**） |
| 新規行の既定値 | `'standard'::text` / `true` |
| preset check制約 | `NULL or in ('quiet','standard','many','all_useful')` |
| 不正preset（`noisy`） | 拒否（SQLSTATE 22023） |
| `alert_category_settings` | RLS有効、本人のみの4ポリシー（select/insert/update/delete）、anonに権限なし、他ユーザーからは0行 |
| 設定RPC | `authenticated` のみ実行可。保存後 preset=many / emergency=true / カテゴリ2件（未知キー `not_a_category` は無視）、`morning_report`・`close_report` は不変 |
| 統合producer | `service_role` のみ、SECURITY DEFINER。`authenticated` からの実行は拒否 |
| アプリfeed RPC | 16行（critical 1 / high 6 / **medium 9**）、`low` は0行、市場行11件。新列 `coverage_categories` を返す |
| NULL tracked_stock_id 用index | `notifications_market_news_without_stock_once`（source_type='important_news' and tracked_stock_id is null）を確認 |
| legacy互換のproducer挙動 | preset=many / legacy(NULL)+market ON / legacy+market OFF / push_enabled OFF のいずれでも新規enqueue 0件（対象窓に該当ニュースが無いため**正の動作は未確証**。負の動作＝勝手に増えないことは確認） |

合成candidateは投入していない（producerは実在candidateのみを対象に実行）。

### migration_apply

- `supabase db query --linked -f <対象1ファイル>` で単体適用。成功（`rows: []`）。
- `supabase db push` 未使用、他migration未適用、migration history修復なし、destructive変更なし。

### schema_readback（適用直後）

| 項目 | 結果 |
| --- | --- |
| `alert_settings.notification_preset` | text、既定 `'standard'` |
| `alert_settings.emergency_alerts` | boolean、既定 `true` |
| 既存ユーザー行（適用直後） | preset **NULL** / emergency **NULL** / `market_critical_news` true / important true / push true / morning true / close true（**migrationだけでは書き換わっていない**） |
| 列grant（authenticated） | 両列に SELECT / INSERT / UPDATE |
| `alert_category_settings` | RLS有効、4ポリシー、authenticated と service_role のみ、行数0（適用直後） |
| `set_my_important_news_alert_preferences` | `{postgres, authenticated}` |
| `enqueue_important_news_notifications` | `{postgres, service_role}`、SECURITY DEFINER |
| `get_my_important_stock_news` | `{postgres, authenticated}` |
| legacy `enqueue_market_critical_notifications` | 残存（互換のため削除していない） |
| notifications index | 既存6種＋`notifications_market_news_without_stock_once` を追加（`notifications_pending_push_due_idx` / `notifications_processing_push_claimed_idx`（H2）は不変） |
| Cron | 10件、内容不変 |
| notifications | 1件（sent）のまま |
| migration history | `20260913010947` のまま（本migrationは未記録。既知の乖離を維持） |

### function_before_after / deploy / runtime_byte_compare

- deploy前: `important-news-monitor` **v49**（updated_at 1789225463633）。project ref `wsmznyzcvmuitkglfeuj`、HEAD `2be0f34`、config.tomlの `verify_jwt=false` 設定を確認。
- 実行: `supabase functions deploy important-news-monitor --no-verify-jwt`（693 kB）→ **v50**（updated_at 1789277250198）、`verify_jwt` false のまま。
- `supabase functions download --use-api` を空ディレクトリで取得し比較:
  - runtime source 全ファイルがリポジトリと差分なし（`diff -rq` 差分0、worktreeに未コミット変更なし）
  - HEADとバイト一致（`cmp`）: `index.ts` / `app_copy_logic.ts` / `news_coverage_logic.ts`
- 統合producerを呼ぶのは deploy 済み `index.ts` のみ（`rpc/enqueue_important_news_notifications`）。

### other_functions_unchanged

| Function | before | after |
| --- | --- | --- |
| x-test-post | v105 / 1789169005998 | unchanged |
| send-push-notifications | v13 / 1789199846117 | **unchanged**（dispatcher/claim RPCとも無変更） |
| x-oauth-connect | v15 / 1789261926037 | unchanged |
| personalized-reports | v11 | unchanged |
| market-intelligence-ingest | v9 | unchanged |
| market-intelligence-state-evaluator | v4 | unchanged |
| stocks-master-sync / stocks-new-listing-sync | v14 / v13 | unchanged |

### app_verification

- Metro を worktree から起動（`REACT_NATIVE_PACKAGER_HOSTNAME=192.168.188.127`、`--clear`）。実アプリと同条件（`transform.routerRoot=src/app`）でiOSバンドルを生成し、**エラーなしでビルド成功**（9.7 MB）。新設定UI（`ImportantNewsAlertSettings` / `presetOptions` / `alertCategories` / `categoryLabels` / `set_my_important_news_alert_preferences`）がバンドルに含まれることを確認。
- 実画面の確認は**ユーザー本人のDevelopment Build（ログイン済み端末）**で実施し、「すべて正常」との回答を得た。確認依頼項目: ニュース一覧が開く / medium表示の反映 / severity日本語ラベル / category日本語ラベル / detail表示 / 4段階preset UI / emergency toggle / category ON/OFF / 保存→再読込一致 / 既存ユーザー初期表示が「多め」相当にならないこと。
- 初期表示の仕様（コードで確認済み）: legacy行（preset NULL）は `market_critical_news=true` なら「標準」表示、`emergency_alerts` は fail-closed で OFF 表示。→「勝手に多め」にはならない。
- 本番データ側の裏付け（read-only）: feed 16行（critical 1 / high 6 / medium 9、うち市場medium 5）。以前は非表示だった「アジア株が下落、米イラン衝突で原油は1バレル100ドル超」が表示対象に入った。
- 注意: `coverage_categories` はPhase 2 deploy以降に取り込まれた行にのみ入るため、**既存の古い記事ではカテゴリ表示が空**（新規ニュースから表示される）。

### natural_cron_observation（read-only、manual runなし）

観測窓: deploy 2026-09-13 05:27 UTC（14:27 JST）〜 05:41 UTC（fetch 3サイクル相当）。

| 項目 | 結果 |
| --- | --- |
| fetch/judgement/generation cron | 継続稼働（HTTP 4xx/5xx **0件**） |
| 新規candidate | 0件（日曜・TDnet休止、鮮度3時間以内の新規海外ニュースなし） |
| **app copy生成** | **5件（05:34、すべて `app_copy_fact_status=passed`）**。内容はいずれも市場全体ニュースの日本語コピー: 「中国、日本の半導体材料DCS輸出に新措置」「日経平均が1.7%上昇」「中国、米国との関税引き下げ合意を早期に期待」「**アジア株が下落、米イラン衝突で原油は1バレル100ドル超**」「日銀データ、ドル円は156円20銭から155円55銭へ下落」→ **Phase 3で市場medium以上がapp copy対象に入ったことが実データで確認できた**（従来は critical/high のみ） |
| coverage分類（Phase 2の残課題） | 実データ1件を確認: market_macro の geopolitics 記事に `coverage_severity=low` / `coverage_categories=[geopolitics]` / `emergency_class=null`。**分類の書き込み経路が本番実データで動作**（Phase 2で「未確認」としていた点が解消） |
| producerエラー | なし（`notificationEnqueue` の報告自体が0＝enqueue対象なし） |
| duplicate enqueue | 0件（notifications 1件のまま） |
| dispatcher pending滞留 | 0件（push_status は sent 1件のみ） |
| X投稿 | 0件 |

### natural_push_observation

- **未観測**。観測窓内に通知条件を満たす自然ニュースが発生しなかったため、新しいPushは0件（既存の1件は09-11の大引けレポート通知で、状態 sent のまま）。
- 人工ニュース投入・手動Push・手動invokeは行っていない。

### settings_compatibility

- migration適用直後: 既存行は preset NULL / emergency NULL のまま＝**通知量は変化なし**（legacy NULL は producer 側で 'standard' 相当、emergency は fail-closed で OFF）。
- その後 **ユーザー本人がアプリUIで設定を保存**（2026-09-13 05:35:14 UTC）。現在値:
  - `notification_preset = 'all_useful'`（かなり多め）
  - `emergency_alerts = true`
  - `alert_category_settings` 16件すべて enabled=true
  - `market_critical_news = true`（RPCが preset≠quiet または emergency ON のとき true に合わせる仕様。元から true で変化なし）
  - `important_news` / `push_enabled` / `morning_report` / `close_report` は不変
- この変更は**ユーザーが画面で明示的に選んだ値**であり、こちらからの書き換えは一切していない。影響として、今後は「保有・監視の注目以上」＋「市場の重要以上（medium含む）」＋「緊急」が通知対象になるため、**通知頻度は従来よりかなり増える見込み**。うるさい場合はアプリの通知設定で「標準」等に戻せる。

### tests/rechecks（ローカル、本番適用前に再実行）

- `important-news-monitor` runtime: **395 passed / 0 failed**（`--allow-read --node-modules-dir=auto --no-check`）
- Push/レポート回帰（`send-push-notifications` ＋ `personalized-reports`）: **48 passed / 0 failed**
- アプリ presentation: **27 passed / 0 failed**（`news-presentation` 25 ＋ 新規 `news-labels` 2。`news-labels_test.ts` は型のみの `@/` alias importのためDeno型検査を外して実行）
- アプリ `npx tsc --noEmit`: `src/` のエラー **0件**
- `git diff --check`: PASS
- iOSバンドル生成: PASS（上記 app_verification）

### production_changes

1. `20260913140000_broad_news_visibility_notification_presets.sql` の単体適用。
2. `important-news-monitor` の deploy（v49 → v50）。
3. （ユーザー操作）アプリUIからの通知設定保存 — こちらの変更ではない。

やっていないこと: `db push` / 他migration / migration history修復 / Cron変更 / X投稿 / 合成candidate / 手動・合成Push / 手動invoke / 他Functionのdeploy / `send-push-notifications`・claim RPC・notifications claim schemaへの変更 / OAuth・Vault・secrets関連。

### changed_files

- 本タスクでのコード変更は**なし**（承認済み `f7c17b9` をそのまま反映）。
- 変更したのは `.agent/tasks/CLAUDE_TASK_1.md`（status と本Report）のみ。

### commit_hash

- 反映対象（Codex H1 承認実装）: `f7c17b915c551ba81b1dfc62a0731fd3eba6f008`
- 反映時のHEAD: `2be0f34`
- Report: このコミット

### push

- origin/main（fast-forward）

### remaining_issues

- **自然Pushが未観測**。ユーザーが `all_useful` ＋ emergency ON を選んだので、平日の自然ニュースで初回の実Push到達を確認したい（重複0・滞留0も併せて）。通知が多すぎる場合はプリセットを下げる判断が必要。
- 統合producerの**正の動作（実際にenqueueする経路）は本番未観測**。rollback proofでも対象窓に該当ニュースが無く0件だった。
- 古い記事には `coverage_categories` が無いため、アプリのカテゴリ表示が空になる行が残る（新規取り込み分から解消）。過去分の再分類は別タスク判断。
- legacy producer `enqueue_market_critical_notifications` が残存（互換のため）。統合producerへ一本化するかは別途判断。
- `market_critical_news` が設定RPCの副作用で更新される設計（preset≠quiet or emergency ON → true）。legacyゲートを将来撤去するときに整理が必要。
- 既存の課題は継続: migration履歴の乖離（本migrationも未記録）、テスト用の監視銘柄17件、`supabase/config.toml` がGit管理外。
- Metro は現在起動中（`192.168.188.127:8081`）。不要になれば停止してよい。

### safety_checks

- 対象migration1本のみ適用、`db push` 未使用、履歴修復なし、destructive変更なし、適用前rollback proof＋適用後read-back実施。
- deploy対象は `important-news-monitor` のみ。deploy前後のversion/updated_atを全Function記録し、他8 Functionの不変を確認。`verify_jwt` の設定変更なし。
- Cron・dispatcher・claim RPC・notifications claim schema・`alert_settings` の他項目（morning/close/push/important）は未変更。
- 合成candidate・手動Push・X投稿・手動invokeなし。secrets/tokenは出力していない。
- ユーザー設定は本人がUIで保存したもののみ。こちらからの書き換えはゼロ。

### next_recommendation

1. 平日（2026-09-14 以降）の自然ニュースで、read-onlyで以下を観測する。
   - 統合producerが実際にenqueueするか（preset `all_useful` 相当の件数）
   - 初回の実Push到達、重複0、dispatcher滞留0
   - `coverage_severity` / `coverage_categories` が新規candidateに入り、アプリでカテゴリラベルが出るか
   - 通知頻度が体感で多すぎないか（多ければプリセット調整を提案）
2. 観測が問題なければ、legacy producer の撤去と `market_critical_news` の整理（設定モデルの一本化）を検討。
3. 過去記事の coverage 再分類を行うかを判断（アプリのカテゴリ表示の穴埋め）。
