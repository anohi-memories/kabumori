# Claude Task 1

- task_id: market-critical-alerts-dedupe-relevance-phase4-20260911
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: 市場全体Criticalニュースをユーザー設定に基づいて安全にPush候補へ接続しつつ、アプリ内ニュースのソース横断重複と関連業種表示を改善する。X投稿基準・X投稿量は変更しない。

## Context

前TASK `in-app-news-japanese-detail-summary-20260911` はChatGPTのK1レビューで完了承認済み。

現在までに:
- `/news` は個別銘柄 critical/high/medium を表示
- market-wide critical/high はactive tracked stocksの業種関連性がある場合だけ表示
- 英語ニュースはFactチェック済み日本語タイトル・要約・詳細をアプリ内で読める
- `important-news-monitor` v39
- `send-push-notifications` v4
- market-wideニュースのPushはまだ無効
- 同一イベントが複数sourceから別candidateとして表示されることがある
- matched_sectorは複数一致時の選択が最適でないことがある

## Product principle

**重大な市場ニュースは見逃さない。ただし、ユーザーが望んだ範囲だけ通知する。**

- トランプ政権/関税
- 戦争・軍事衝突
- 停戦・和平
- 制裁/制裁解除
- 半導体・AI輸出規制
- 為替介入
- FRB/日銀のサプライズ政策
- 原油/LNG・ホルムズ/紅海等の重大障害
- その他、日本株・為替・金利・主要セクターを大きく動かしうるCriticalニュース

を対象とする。

## Model

Push policy、ユーザー設定、DB/RPC、producer、dedupe、market relevanceを横断するため **Opus 5** を使用する。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktree確認
7. 他slot TASKをread-only確認
8. Codex2は `x-test-post`、Claude2はOAuth/Vault/social_accounts系。各担当範囲へ触れない
9. 他slotが `important-news-monitor/**`、`send-push-notifications`、`alert_settings`、`get_my_important_stock_news`、同じmigration/RPCを変更中なら開始せず競合報告
10. migration history乖離を再確認し、blind `supabase db push` 禁止
11. 既存未コミット差分は他workstream所有として触れない

## Phase 4A: Market alert preference

ユーザーが市場全体CriticalニュースのPushを受け取るかを設定できるようにする。

推奨:
- `alert_settings.market_critical_news` 等のboolean
- **既定OFF**
- 既存ユーザーに突然Pushが増えないfail-closed
- `push_enabled=false` の場合は必ず送らない
- `important_news=false` との関係を明確化する。原則、market Criticalも重要ニュースの一部として扱い、両方の設定境界をテストする

既存 `alert_settings` の構造を監査し、最小expand-only migrationを選ぶ。

## Phase 4B: Market Critical Push targeting

market-wide（company_codeなし）のうち **severity=critical** だけをPush候補にする。

最低条件:
- market_critical_news=true のユーザーのみ
- push_enabled=true
- important_news=true（既存方針と整合させる）
- Fact basisが十分
- duplicate_of is null
- AI日本語コピーまたは既存Fact-passed日本語テキストが安全に利用できる
- 同じニュースを同じユーザーへ複数通知しない
- high/mediumは今回Pushしない

Pushの本文は、可能なら今回完成したアプリ用Fact-checked日本語コピーを再利用する。画面表示時やPush時に追加AI呼び出しをしない。

### Important

業種関連があるmarket Criticalについても、**設定OFFならPushしない**。
設定ONの場合に「全市場Criticalを受け取る」設計にするか、「関連Criticalだけ」を受け取る設計にするかを実データ件数で比較し、ノイズが少ない方を選ぶ。原則は関連Criticalを優先し、全Criticalは明示的な別設定なしに広げない。

## Phase 4C: Cross-source news dedupe

現在、同一イベント（例: 同じ米雇用統計）がAP/BLS等の別sourceから別candidateとしてfeedに出ることがある。

これを改善する。

要件:
- source URL一致だけに依存しない
- 同一イベント判定は deterministic を優先
- titleの単純類似だけで誤統合しない
- event category + published time window +主要数値/主体/affected entities等、既存データで安全に判定できる範囲を使う
- 既存candidateを大量UPDATE/削除しない
- feed/RPC側のdedupeで解決できるなら優先
- Push dedupeにも同一event keyを再利用できる設計を検討
- 同じ雇用統計など実在データでproofする

誤統合リスクが高い場合は、最小安全範囲（例: macro統計のみ）に限定してよい。

## Phase 4D: matched_sector / relevance display improvement

現在、複数業種に一致しても単純な順序で1業種が選ばれる場合がある。

改善候補:
1. ユーザーが登録している銘柄数の多い一致業種を優先
2. holdingをwatchより優先
3. 複数一致なら上位2〜3業種を返す

アプリで「なぜこのニュースが表示されているか」が自然に分かることを優先する。

例:
- 為替ニュースが、実際は電気機器の登録が最多なのに「機械」とだけ出る不自然さを改善
- `relevance_reason` の方向性（上がる/下がる）断定は禁止のまま

## Required tests

最低限:
- market_critical_news default OFF
- OFF -> market Critical Push 0
- ON + push_enabled=true + important_news=true -> 対象Criticalのみ通知候補
- push_enabled=false -> 0
- important_news=false -> 0
- high/medium market news -> 0 Push
- company-specific existing Push behavior regression
-同一market newsの同一user二重通知なし
- source横断の同一イベントfeed重複抑制
- 誤統合negative case
- existing individual feed維持
- market-wide relevance維持
- matched_sector改善のpositive/priority tests
- Fact failed app copyはPush本文に使わない
- app Japanese title/detail regressions
- X publish gate unchanged
- `important-news-monitor` full regression
- dispatcher regression（変更した場合のみ）
- app `tsc --noEmit`
- changed pure modules `deno check`
- `git diff --check`

## Production safety

まず監査・実装・テストを完了する。

本番反映:
- expand-only migration / RPCは、rollback付き事前検証後に対象ファイル単独適用可
- `supabase db push`禁止
- `important-news-monitor` deployが必要な場合、root / HEAD / config / project refを確認してから `--no-verify-jwt`
- deploy後は本番sourceをdownloadして期待commitと全ファイルbyte compare
- `send-push-notifications` は既存設定で実現できるなら変更しない。変更が必要なら理由をReportし、K1前に本番deployしない

### Real production proof

人工candidate・人工marketニュースは禁止。
自然な既存Criticalニュースで:
- 設定OFFのユーザーへ通知が作られないこと
- 設定ONのrollback付きテスト等で対象ユーザーが正しく選ばれること
- 可能なら自然Critical発生時に観測

本番でユーザー設定を実際にONへ変更して自然Pushを待つ必要がある場合は、勝手に変更せずK1へ相談する。

## Forbidden

- X publish条件変更
- X投稿量増加
- high/medium market-wide Push
- market Criticalの無条件全ユーザーPush
- `x-test-post`変更
- OAuth/Vault/social_accounts変更
- Cron schedule変更
- auto_publish変更
- secrets変更
- 人工candidate作成
- candidate status変更/削除
- destructive migration
- 画面表示時/Push時の追加AI呼び出し
- Fact未確認テキストの通知利用
- unrelated Edge Function deploy

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- Report追記
- origin/main同期

Report必須:
- task_id
- result
- model_used
- alert_settings_audit
- chosen_market_alert_policy
- market_push_targeting
- cross_source_dedupe_design
- matched_sector_improvement
- schema_or_rpc_changes
- producer_changes
- dispatcher_changes_or_none
- app_changes
- existing_data_proof
- tests
- x_publish_invariants
- push_safety_invariants
- production_changes
- deploy_verification
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

## Report

- task_id: market-critical-alerts-dedupe-relevance-phase4-20260911
- result: **完了**。4つの変更を本番に反映した。本人の設定は既定の OFF のままなので、今のところ市場全体のニュースの Push は1件も作られていない。X・Cron・auto_publish・`send-push-notifications` は無変更。
  - (A) 市場全体の Critical ニュースを Push で受け取る設定 `alert_settings.market_critical_news` を追加した。**既定は OFF**。アプリの重要ニュース画面にスイッチを置いた。
  - (B) 「設定を ON にしたユーザー」×「登録業種に関係する Critical」×「Fact passed の日本語テキストがある」×「公開から6時間以内」のときだけ通知を作る producer を追加した。
  - (C) 別ソースに分かれた同じ出来事（雇用統計の AP 版と BLS 版）を、フィードで1件にまとめる。
  - (D) 関連業種を、登録している銘柄数の多い順に最大3つ返し、表示するようにした。
- model_used: Opus 5

### alert_settings_audit

- 列: `user_id`（PK、profiles への FK）、`important_news` / `earnings` / `tdnet` / `large_shareholding` / `price_move` / `morning_report` / `close_report` / `push_enabled`（すべて default true）、`email_enabled`（default false）、`updated_at`。
- 本番は **0行**。dispatcher（`send-push-notifications` v4）は、行が無いユーザーを「全部 ON」とみなす（`shouldSendNotification` の既定値）。
- RLS: 本人の select / insert / update。authenticated には**列ごとの** insert / select / update 権限が付いている → 新しい列には、権限を明示的に付ける必要があった。
- `notifications` の重複防止は `UNIQUE (user_id, tracked_stock_id, source_type, source_id)`。`tracked_stock_id` が NULL だと効かないので、市場ニュースの通知では、一致した登録銘柄の id を必ず入れる。
- アプリには、通知設定の画面も `alert_settings` を使う処理も無かった。

### chosen_market_alert_policy

- `alert_settings.market_critical_news boolean not null default false`（列の追加のみ）。authenticated には、この列だけの `select, insert, update` 権限を付けた。
- **fail-closed**:
  - 行が無いユーザー → OFF として扱う（producer は、`market_critical_news = true` の行があるユーザーにしか通知を作らない）
  - 既存のユーザーに、突然 Push が増えることはない
- 他の設定との関係:
  - `push_enabled=false` → 送らない
  - `important_news=false` → 送らない。市場の Critical も重要ニュースの一部として扱う
  - producer では、`market_critical_news` / `push_enabled` / `important_news` の3つとも true であることを必須にしている
  - dispatcher も従来どおり、`push_enabled` と `important_news` で送信時に止める（二重の防御）
- **「関連 Critical のみ」を採用した**（「全 Critical」は、明示的な別の設定なしには広げない）。直近14日の実データでの比較:
  - 全 Critical: **4件**（Greer / カナダ関税、米軍のタンカー攻撃 ×2、World News in Brief）
  - 本人の登録業種に関係する Critical: **1件**（Greer）

  タンカー攻撃は、原油・海運の業種を登録していない本人には関係が薄い。World News in Brief は、伝わり方が特定できない。関連のみにするほうが、ノイズが少ない。

### market_push_targeting

`public.enqueue_market_critical_notifications(p_window_hours integer default 6)`（新規・SECURITY DEFINER・**service_role のみ**実行可）。通知を作るのは、次の条件を**すべて**満たすときだけ:
1. `company_code is null`（市場全体）、`duplicate_of is null`、判定済みの X 級の状態
2. severity が **critical**（importance = most_important で、判定の Fact が passed）。**high / medium は通知しない**
3. `japan_market_relevance` が medium / high で、伝わり方のテーマが1つ以上ある
4. `published_at` が、現在から **6時間以内**（設定を ON にしたときに、過去の Critical がまとめて届くことはない。上限は30日に制限）
5. **Fact passed の日本語テキストがある**:
   - AI コピー（`app_copy_fact_status='passed'` の `app_title_ja` と `app_summary_ja`）、または
   - Fact passed の X 投稿文（ラベルと出典行を除いた本文。見出しは最初の1文）

   Fact 不合格のテキストは使わない
6. 受け取る人: `market_critical_news` / `push_enabled` / `important_news` がすべて true で、**アクティブな登録銘柄の業種がテーマの業種と一致する**ユーザー
7. 重複の防止:
   - 同じユーザーに、同じニュース（`source_id`）の通知がすでにあれば作らない
   - 同じ出来事の別ソースの通知がすでにあれば作らない
   - 最後に、`notifications_dedupe` の `on conflict do nothing` で止める
   - 通知を作る側でも、同じ出来事は最も早いもの1件に絞る

作る通知の中身:
- `source_type='important_news'`（dispatcher の opt-out と、タップしたときの `/news` への遷移がそのまま使える）
- `tracked_stock_id` = 一致した登録銘柄（ユーザーごとに1件、決定的に選ぶ）
- title = `【市場】` + 日本語の見出し（60字まで）
- summary = 日本語の要約（140字まで）
- importance = most_important、push_status = pending

呼び出す場所（`important-news-monitor`。**Cron は変更していない**）:
- `publish_ready` で、実際に X へ公開した直後（`result.published` のときだけ）
- `generate_ready` の最後（AI コピーを作った後）。生成対象が0件の回も呼ぶ
- dry-run 系のモードでは呼ばない
- 画面を表示するときや Push を送るときに、AI は呼ばない

### cross_source_dedupe_design

- `important_news_number_signature(title)`: タイトル中の「意味のある数字」（3桁以上、または小数点・% を含むもの。19xx / 20xx の年は除く）を、正規化して並べた集合。**2つ以上あるときだけ**値を返す（数字が1つのタイトルで、誤ってまとめないため）。
- `important_news_same_event(a, b)`: 次の3つを満たすとき、同じ出来事とみなす。
  - カテゴリが同じ
  - シグネチャが同じ
  - 公開時刻の差が72時間以内
- **対象は市場全体のニュースだけ**（個別銘柄は、既存の `duplicate_of` に任せる）。
- フィード: 同じ出来事のうち1件だけを残す。残す順番は、日本語テキストがある → critical → 公開が早い → id。
- Push でも同じ判定を使う（同じ出来事の別ソースを、同じユーザーへ再通知しない）。
- 実データでの結果:
  - `U.S. payrolls increased by 162,000 in August; unemployment rate held at 4.1%`（BLS 版）と `U.S. August payrolls rise by 162,000, exceeding expectations; unemployment rate holds at 4.1%`（AP 版）は、どちらも `162000|4.1%`。約26時間差・同じカテゴリ → **1件にまとまった**（先に出た BLS 版を残した）。
- 誤ってまとめないことの確認（単体テスト）:
  - 数字が1つだけ（`nonfarm payrolls increased by 162,000`）→ シグネチャ無し
  - 年だけ → シグネチャ無し
  - カテゴリが違う → 別の出来事
  - 4日離れている → 別の出来事
  - 数字が違う（162,000 / 4.1% と 142,000 / 4.2%）→ 別の出来事
- 見送ったもの: 米軍のタンカー攻撃の英語版（`three`）と日本語版（`3隻`）。数字の表記が違い、決定論的に安全には判定できないので、**まとめない**（最小の安全範囲にとどめた）。

### matched_sector_improvement

- フィードの市場ニュースの行で、一致した業種ごとに、本人のアクティブな登録銘柄数を数える。並べる順番は、**銘柄数の多い順 → 保有を含む業種 → 名前**。
- `matched_sector` = 1位、`matched_sectors` = 上位3つ（戻り値の列を追加）。`tracking_type` は、一致した銘柄に保有が1つでもあれば holding。
- 実データ: 為替・関税のニュースは、これまで「関連: 機械」だったのが、**「関連: 電気機器・機械」**（本人は電気機器を6銘柄、機械を2銘柄、輸送用機器を1銘柄登録）になった。詳細画面の「市場との関係」は「登録している電気機器・機械・輸送用機器の銘柄に関係する可能性があるため表示しています。」。方向（上がる・下がる）は引き続き言わない。

### schema_or_rpc_changes

`supabase/migrations/20260911200000_market_critical_alerts_dedupe.sql`（1トランザクション・本番適用済み）:
- `alert_settings.market_critical_news`（追加・default false）と、authenticated の列権限
- `important_news_number_signature(text)`・`important_news_same_event(...)`（新規・IMMUTABLE・呼び出しは関数の内部だけ）
- `enqueue_market_critical_notifications(integer)`（新規・service_role のみ）
- `get_my_important_stock_news` を作り直した:
  - 市場ニュースに、同じ出来事をまとめる処理と、業種の順位付けを追加
  - 末尾に `matched_sectors text[]` を追加
  - **個別銘柄のフィードと、市場ニュースの抽出条件は、前回と同一**（静的テストで、前回の migration と比較して固定）
  - 並び順・件数上限・権限は同じ
- candidate の行の更新・削除は無し。破壊的な変更も無し。

### producer_changes

- `important-news-monitor/index.ts`: `enqueueMarketCriticalNotifications()`（RPC を呼ぶだけ・例外を投げない・件数をログに出す）を追加。`publish_ready`（公開した直後）と `generate_ready`（出口の2か所）から呼ぶ。
- 個別銘柄の producer（`enqueueImportantNewsNotifications`）は無変更。

### dispatcher_changes_or_none

**none**。`send-push-notifications` は無変更（v4）。市場ニュースの通知も `source_type='important_news'` なので、既存の `push_enabled` / `important_news` による送信時の除外がそのまま効く。`market_critical_news` の判定は、通知を作る側で行う。

### app_changes

- `src/lib/alert-settings.ts`（新規）: `fetchMarketCriticalAlert()` / `setMarketCriticalAlert(enabled)`。本人の行に、この列だけを upsert する。
- `src/app/news/index.tsx`: 画面の上部に「市場全体の重大ニュースを通知」のスイッチを置いた。説明文は「関税・戦争・為替介入などの最重要ニュースのうち、登録銘柄の業種に関係するものをプッシュ通知します。」。読み込みが終わるまでは操作できない。保存に失敗したら元に戻して、エラーを表示する。
- `src/lib/news-labels.ts`: 「関連: 電気機器・機械」（上位2つ）。
- `src/lib/news-presentation.ts`: 「市場との関係」に、上位3つの業種を含める（列が無い古い RPC でも動く）。
- `src/lib/important-news.ts`: 型に `matched_sectors` を追加。

### existing_data_proof

migration 全体を、本番データ上のロールバックするトランザクションで検証した（その後、本番に適用）。人工の candidate は作っていない。設定の行と通知は、トランザクションの中だけで作った。

| # | 確認 | 結果 |
|---|---|---|
| 1 | 列の既定値 / authenticated の insert・update / producer を実行できるのは service_role のみ（authenticated・anon は不可） | `false` / true・true / true（false・false） |
| 2 | 設定の行が無い状態で、30日の範囲で実行 | 通知 **0件** |
| 3 | 行を既定値で作成（`market_critical_news=false`）| 0件 |
| 4 | ON だが `push_enabled=false` / ON だが `important_news=false` | 0件 / 0件 |
| 5 | ON・既定の6時間の範囲（既存の Critical はすべてそれより古い） | **0件**（まとめて届くことはない） |
| 6 | ON・30日の範囲・実データ | **1件だけ**: Greer / カナダ関税（critical・関連業種 機械など）。タイトル「【市場】米国、カナダ製品の一部輸入禁止と関税措置の変更を発表」、本文は Fact passed の AI コピー。importance most_important、pending、登録銘柄 id あり |
| 7 | もう一度実行 | 0件（冪等） |
| 8 | 通知のうち critical 以外 / company_code あり / Fact 不合格のテキストを使ったもの | 0 / 0 / 0 |
| 9 | 関係する業種（機械・輸送用機器・電気機器など）の登録を無効にして実行 | 0件（業種が合わないユーザーには届かない） |
| 10 | フィード | 12件 → **11件**（AP 版の雇用統計がまとめられた）。追加0。個別銘柄の行は変化なし。並び順は新しい順 |
| 10 | 業種 | 為替・関税のニュースは `[電気機器, 機械, 輸送用機器]`、BLS の雇用統計は `[銀行業]` |
| 11 | 他ユーザー / 未ログイン | 0 / 0 |

米軍のタンカー攻撃（critical 2件）と World News in Brief（critical・テーマ無し）は、本人の業種に合わない、またはテーマが無いため、30日の範囲で ON にしても通知の対象にならなかった。

### tests

- `market_critical_sql_static_test.ts`（新規・6件）:
  - 設定は既定 OFF で、この列だけの権限
  - producer の条件（3つの設定・company_code なし・critical のみ・severity の判定は1回だけ・6時間・関連業種・Fact passed のテキストだけ・同じニュースや同じ出来事は1回・on conflict・service_role のみ）
  - 個別銘柄と市場ニュースの抽出条件が前回と同一
  - 同じ出来事のまとめと業種の順位付け（シグネチャは数字2つ以上・年を除く・同じカテゴリ・72時間）
  - Fact の条件・権限・candidate への書き込みが無い
  - `index.ts` での呼び出しは3か所で、dry-run では呼ばない
- `tests/app/news-presentation_test.ts`（1件追加 → 16件）: 業種を上位3つまで、方向の表現は無し、列の無い古い RPC でも動く
- 本番データのロールバック付きテスト: 上表のとおり
- important-news-monitor 全体の回帰: **349 passed / 0 failed**（既存の X 公開ゲート・個別銘柄の producer・対象判定・日本語コピー・前回までの静的テストを含む）
- アプリ: `tsc --noEmit` の `src/` のエラー0件。`deno check`（新しい静的テスト）OK。`git diff --check` clean

### x_publish_invariants

- `checkPublishCandidate`・auto_publish・cutover・rate control・X 投稿文の生成は無変更。今回の呼び出しは、X へ公開した**後**と、生成が**終わった後**に足しただけ
- 確認: `auto_publish = true`、設定の `updated_at`（2026-09-10 08:53:08）は変化なし。X の投稿量を増やす変更は無い

### push_safety_invariants

- 市場ニュースの Push は、**設定を ON にした人**だけ、**critical** だけ、**関連業種**だけ、**Fact passed の日本語**だけ、**6時間以内**だけ、**1人1回**だけ
- high / medium の市場ニュースは通知しない。全ユーザーへの一律配信もしない
- 個別銘柄の Push の処理（producer・dispatcher）は無変更
- 確認: 本番の `alert_settings` は0行（ON にしている人は0人）→ 市場ニュースの通知は作られていない。**notifications = 0**

### production_changes

- migration `20260911200000_market_critical_alerts_dedupe.sql` を単独で適用した（`db push` は使っていない。事前にロールバック付きで検証済み。適用前の root: pwd = worktree・HEAD `1928648`・`config.toml`・project ref `wsmznyzcvmuitkglfeuj`）
- `important-news-monitor` を **v40** として deploy した（下記）
- 本番のユーザー設定は**変更していない**（設定を実際に ON にして自然な Push を待つ場合は、K1 に相談する）

### deploy_verification

- deploy 前: pwd = worktree、HEAD **`bb5cfa2`**、project ref `wsmznyzcvmuitkglfeuj`、`[functions.important-news-monitor] verify_jwt = false`、`supabase/functions` は HEAD と一致
- `supabase functions deploy important-news-monitor --no-verify-jwt` → **v40**、`verify_jwt=false`、2026-09-11 03:59:11 UTC
- `functions download --use-api` → **`bb5cfa2` と 18/18 ファイルがバイト一致**
- 他の Function の `updated_at` は不変:
  - x-test-post v94（09-10 10:04:06）
  - send-push-notifications v4（09-10 10:07:17）
  - stocks-master-sync v6 / stocks-new-listing-sync v5（09-04 05:15:26）
  - x-oauth-connect v4（09-10 15:09:47）
- 本番の read-only 確認:
  - 設定の既定値 `false`、`alert_settings` 0行・ON にしている人0人
  - producer の ACL は `{postgres, service_role}`
  - RPC の列に `matched_sectors` が加わった。ACL は authenticated のみ
  - 本人フィードは11件（個別5・市場6）、雇用統計は1件、業種は電気機器が先頭
  - notifications 0、Cron 8本 active
- 自然な実行（手動では呼んでいない）: deploy 後、最初の `important-news-generation` Cron の `generate_ready`（2026-09-11 **04:14:00 UTC**、HTTP 200）の応答に、`"marketCritical":{"inserted":0}` が含まれていた（deploy 前の 03:54 の応答には、この項目は無い）。設定を ON にしている人が0人なので、0件は期待どおり。実行後の状態は次のとおり:
  - notifications 0、ON にしている人0人
  - auto_publish true・設定の `updated_at` は変化なし
  - Cron 8本
  - フィード11件

### changed_files

- `supabase/migrations/20260911200000_market_critical_alerts_dedupe.sql`（新規・本番適用済み）
- `supabase/functions/important-news-monitor/index.ts`（市場 Critical の producer を呼ぶ処理）
- `supabase/functions/important-news-monitor/market_critical_sql_static_test.ts`（新規）
- `src/lib/alert-settings.ts`（新規）
- `src/app/news/index.tsx`（通知設定のスイッチ）
- `src/lib/news-labels.ts` / `src/lib/news-presentation.ts` / `src/lib/important-news.ts`（業種の表示・型）
- `tests/app/news-presentation_test.ts`（テストの追加）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

### commit_hash

- `bb5cfa2` — Opt-in market Critical pushes, cross-source dedupe and ranked sectors（本番 v40 の中身）
- 本 Report は、この直後の commit で記録する

### push

- `origin/main` へ同期済み

### remaining_issues

1. **自然な市場 Critical の Push は、まだ観測していない**。本人の設定が OFF で、直近6時間に Critical も無いため。観測するには、本人が設定を ON にして自然な Critical を待つ必要がある（K1 の判断）。
2. dispatcher は `market_critical_news` を送信時に見ない。通知を作ってから送る（最大1分）までの間に設定を OFF にしても、その1件は送られる（影響は小さい）。
3. 同じ出来事のまとめは「タイトルに意味のある数字が2つ以上ある同じカテゴリのもの」に限る。数字の少ない、または表記の違う同じ出来事（英語版と日本語版のタンカー攻撃）は、まとまらない。
4. 通知を作る側での同じ出来事のまとめは、同じ実行の中にある候補どうしと、すでに送った通知が対象。後から同じ出来事の別の候補がより良い日本語テキストを持っても、再通知はしない（仕様どおり）。
5. 市場 Critical の Push は、critical・関連業種・6時間以内・Fact passed の日本語を条件にしている。AI コピーが作られるのは次の `generate_ready`（最大約20分）なので、X に公開されない Critical では通知が少し遅れることがある。
6. ~~設定のスイッチは、実機での操作をまだ確認していない~~ → **2026-09-11 に実機で確認済み**。ユーザーが iPhone の dev build（Metro は worktree から起動、`http://192.168.188.127:8081`）で確認した内容は次のとおり:
   - スイッチの ON / OFF
   - 「関連: 電気機器・機械」の表示
   - 雇用統計が1件にまとまっていること

   確認の結果、本番の本人の `alert_settings` は **market_critical_news = true**（push_enabled・important_news も true、2026-09-11 05:24:15 UTC にアプリから保存）になっている。**ユーザー自身がアプリで ON にした状態**で、Claude は設定を変更していない。この時点で notifications は0件。今後、関連業種の自然な市場 Critical が6時間以内に公開されれば、本人に Push が届く状態になっている（remaining_issues 1 の観測が可能になった）。
7. migration 履歴の乖離（`20260911200000` も個別に適用・未記録）、前タスクまでの既知課題は継続。

### safety_checks

- X の公開条件・投稿量、Cron、auto_publish、secrets、OAuth・Vault・social_accounts、`x-test-post`、`send-push-notifications` の変更なし
- high / medium の市場ニュースは Push しない。Critical も無条件の全員配信はしない（設定・関連業種・Fact の3つの条件）
- 人工の candidate の作成、candidate の status の変更・削除なし。破壊的な migration なし
- 画面表示時・Push 時の追加の AI 呼び出しなし。Fact 未確認のテキストは通知に使わない
- 本番のユーザー設定は変更していない
- `db push` は使わず、対象ファイル1本だけを適用した。deploy の前後に root・HEAD・config・project ref を確認し、本番のソースとバイト照合した
- 他の slot の担当範囲には触れていない

### next_recommendation

1. **K1: 本人の `market_critical_news` を ON にして、自然な市場 Critical の Push を観測するかを判断する**（ON にするのは、本人がアプリのスイッチで行うのが自然）。
2. アプリの実機で、スイッチの ON / OFF と、「関連: 電気機器・機械」の表示を確認する。
3. 同じ出来事のまとめの範囲を広げるかどうか（英語と日本語、数字の表記の揺れ）は、誤ってまとめるリスクと合わせて、別タスクで検討する。
