# Claude Task 1

- task_id: broader-stock-news-coverage-phase2-20260911
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: Phase 1で設計・検証したapp severityを、X投稿量とPush配信量を増やさず、アプリのニュース一覧へ安全に接続する。個別銘柄IRと市場全体ニュースの将来拡張に耐える形を優先する。

## Context

前TASK `broader-stock-news-coverage-phase1-20260910` はChatGPTのK1レビューで完了承認済み。

Phase 1で確定したこと:
- 現行は `importance` が「Xへ出す価値」と「アプリで見る価値」を兼ねており、保有者には有用でもX級でないニュースが `no_post -> rejected` で消える
- app向け severity `critical / high / medium / low` を既存判定結果から決定論的に導く pure module `news_severity_logic.ts` を実装済み
- 本番直近7日665件のシミュレーションで、X対象104件は不変のまま、アプリ表示候補を新たに271件増やせる見込み
- 個別銘柄に加え、トランプ大統領・米政権、関税、米中摩擦、半導体/AI輸出規制、戦争/停戦/制裁、中東・原油、台湾海峡、海運障害、OPEC+、FRB/日銀サプライズ、為替介入、大規模災害・パンデミック・サイバー等も taxonomy 対象
- `news_severity_logic.ts` はまだ本番 `index.ts` から参照していないため、現行本番挙動は不変
- `important-news-monitor` v38、`send-push-notifications` v4、`/news` RPC published対応は本番済み

## Product principle

**収集は広く、表示は有用に、Push/Xは慎重に。**

今回のPhase 2では:
- アプリ `/news` で critical / high / medium を見られるようにする
- X publish条件は一切変更しない
- Push producer対象は一切広げない
- 市場全体ニュースを全ユーザーへPushしない
- holding/watchのPush差分はまだ本番有効化しない

## Model

DB migration/RPC、既存candidateデータ、app feed互換、X/Push安全境界、migration履歴乖離をまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktree確認
7. 他slot TASKをread-only確認
8. 他slotが `important_news_candidates` schema、同じmigration/RPC、`get_my_important_stock_news`、`/news` を変更中なら開始せず競合報告
9. 本番 `get_my_important_stock_news` 定義と repo migrationをread-only確認
10. 本番 migration history乖離を再確認し、`db push` を盲目的に使わない
11. 既存未コミット変更は他workstream所有として触らない

## Phase 2A: Choose persistence strategy

Phase 1の severity を本番フィードで使えるようにする方法を比較し、最小で安全な方を選ぶ。

候補:
A. `important_news_candidates` に `app_severity` / `ir_subtype` をexpand-only追加し、判定時に保存
B. 既存列からSQL/RPC側で決定論的に導出
C. view / generated-compatible projectionで導出

判断基準:
- 既存行を安全に扱える
- X publish / Push producerに影響しない
- backfillの事故リスクが低い
- app `/news` で安定して使える
- migration履歴乖離下でも個別適用しやすい
- severityロジックの二重実装を極力避ける

**既存データの破壊的UPDATEや大量status変更は禁止。**

## Phase 2B: App feed behavior

`/news` の対象を、現在の `importance in ('important','most_important')` 中心から、app severityベースへ拡張する。

最低要件:
- critical / high / medium を表示候補
- low は表示しない
- 個別銘柄ニュースは `tracked_stocks.user_id = auth.uid()` + `is_active=true` の既存対象判定を維持
- 他ユーザー/非登録銘柄を混ぜない
- inactiveは出さない
- `duplicate_of is null`維持
- 既存 `published / ready_for_publish / generation_failed` を壊さない
- severityがmedium以上なら、従来 `rejected` だった「アプリでは有用」ニュースを表示できる設計を検討・実装
- ただし単なるAI失敗やFact不確かな rejected を無条件で表示しない。severity根拠とFact basisが必要
- order / limit / return shape は可能な限り維持
- app `src/app/news.tsx` の互換性を維持。severity表示を追加する場合は最小UI変更にする

### Important: market-wide news

company_codeなしの市場全体ニュースについては、今回は**全ユーザーのニュース一覧へ無差別表示しない**。

理由:
- 現時点で affected_sectors / affected_assets / market alert preference が本番設計されていない
- トランプ・戦争・関税などは重要でも、ユーザー関連性を決めずに全件混ぜるとノイズになる

今回できること:
- 将来 market-wide feedへ接続可能なseverity/taxonomy設計を保持
- 必要ならRPC側で market-wideを明示的に除外し、その理由をReport
- Phase 3向けに affected_sectors / affected_assets / market_alerts の最小案を提示

## Phase 2C: X / Push invariants

絶対条件:
- `important-news-monitor` のX publish gateを変更しない
- `checkPublishCandidate` / auto_publish条件を変更しない
- `important` / `most_important` のX判定を緩めない
- `send-push-notifications`変更なし
- notification producerの対象/importance条件変更なし
- 新たなmedium/highニュースからnotificationを作らない
- Cron変更なし
- X投稿件数が増える変更なし

## Phase 2D: Existing data proof

本番read-onlyデータを使って、実際に以下を証明する。

- 現在 `/news` に出ている既存ニュースが新方式でも維持される
- 現在 `no_post/rejected` だがseverity medium以上となる登録銘柄ニュースが存在するか
- 存在する場合、新RPC定義のrollback付きテスト等で本人フィードに出ることを確認
- 非登録銘柄、inactive、他ユーザーは出ない
- market-wide company_codeなしは今回の方針どおり無差別表示されない
- duplicateなし
- limit/order維持

人工candidateの本番投入は禁止。

## Required tests

最低限:
- critical/high/medium positive
- low negative
- existing important/most_important regression
- medium相当rejectedの安全な表示
- Fact basis不足 / 不確かなrejectedはfail closed
- tracked active positive
- untracked negative
- inactive negative
- other-user negative
- duplicate exclusion
- market-wide company_codeなしの無差別表示なし
- order/limit維持
- return shape/app compatibility
- X publish gateの回帰
- Push producer対象不変
- `important-news-monitor` 全回帰
- SQL/migration lint可能範囲
- changed pure modules deno check
- `git diff --check`

## Production rule

このPhase 2は、監査・実装・テストPASS後に限り、**必要最小限のDB migration/RPC更新のみ本番適用してよい**。

ただし:
- `supabase db push` は禁止。migration history乖離があるため、対象ファイル単独の安全な適用方法を選ぶ
- Edge Function deployは禁止。もしseverity保存のため `important-news-monitor` deployが必須と判断した場合は、本番deployせずK1へ理由をReportして停止する
- `/news` appコード変更が必要ならcommit/pushまで可。ストア配布等は不要

本番適用後は:
1. RPC/schema定義をread-only確認
2. 本人フィードをread-only確認
3. 既存表示維持 + 新しいmedium/high候補の表示を証明
4. 非対象ニュース漏れなし
5. notifications 0増加を確認
6. X投稿経路・Cron・auto_publish・secrets/OAuth無変更を確認

## Forbidden

- `important-news-monitor` Edge deploy
- `send-push-notifications`変更/deploy
- `x-test-post`変更/deploy
- Cron変更
- auto_publish変更
- X publish gate変更
- Push配信対象拡大
- market-wide全ユーザーPush
- secrets/OAuth変更
- alert_settings変更
- 人工candidate本番投入
- backlogのstatus変更/削除
- unrelated migration
- destructive schema change
- blind `supabase db push`

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
- persistence_strategy_comparison
- chosen_strategy
- schema_or_rpc_changes
- app_feed_rule_before_after
- market_wide_handling
- existing_data_proof
- tests
- x_publish_invariants
- push_invariants
- production_apply_method
- production_verification
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- phase3_recommendation

## Report

- task_id: broader-stock-news-coverage-phase2-20260911
- result: **完了**。`/news` のフィードを、X向けの `importance` ではなく、アプリ向けの severity（critical / high / medium）で絞る形に切り替え、本番に個別適用した。severity は、判定がすでに保存している列から **SQL で導出する**方式（案B）で、既存行の更新・バックフィルは無し。`important-news-monitor`（判定・X公開ゲート・Push producer）には一切触れておらず、deploy も不要だった。本番の全960行で、SQL と Phase 1 の TS ロジックの判定が **960/960 一致**。本人フィードでは、既存の表示をすべて維持したまま、これまで `rejected` で消えていた登録銘柄の開示4件が新たに表示されるようになった。X投稿・Push・Cron・auto_publish は無変更、notifications は0件のまま。
- model_used: Opus 5

### persistence_strategy_comparison

| 観点 | A: 列を追加し判定時に保存 | **B: RPC内の SQL で導出（採用）** | C: view で導出 |
|---|---|---|---|
| 既存行 | 1,000件近いバックフィルが必要（UPDATE） | 更新なし（読むたびに計算） | 更新なし |
| X / Push への影響 | 判定コードの変更が必要 → **`important-news-monitor` の deploy が必須（今回は禁止）** | 無し（RPC だけ） | 無し |
| バックフィル事故のリスク | あり | 無し | 無し |
| `/news` での安定性 | 高い | 高い（純粋関数、IMMUTABLE） | 高い。ただし view の権限と RLS の設計が別に必要 |
| migration 履歴乖離下での個別適用 | 列の追加＋バックフィル＋コードの deploy | **ファイル1本を1トランザクションで** | ファイル1本 |
| ロジックの二重実装 | 無し（TS だけ） | **あり（TS と SQL）**→ 下記のとおり照合で担保 | あり |

採用理由: A は今回禁止の Edge deploy を要し、既存行の UPDATE も伴う。C は B と同じく二重実装になるうえ、view の公開範囲（RLS・権限）を別途設計する必要がある。B は、既存の SECURITY DEFINER の RPC の中に閉じるので、公開範囲が今と変わらない。

二重実装への対策:
1. SQL の関数は、TS の `deriveNewsSeverity` / `detectCorporateIrSubtype` と同じ規則・同じ正規表現・同じ判定順で書いた。
2. **静的な照合テスト**（`news_severity_sql_parity_test.ts`）: TS の `CORPORATE_IR_SUBTYPE_RULES` の各正規表現が、migration の SQL に**同じ文字列・同じ順序**で入っていること、保有者向けカテゴリの一覧と表示対象の小分類の一覧が TS と完全に一致することを、テストで固定した。どちらかだけを変えると、テストが落ちる。
3. **実データでの照合**: 本番の全960行について、SQL（ロールバックするトランザクションの中で関数を作って計算）と TS の結果を1行ずつ比べ、severity・小分類とも **960/960 一致**した。

### chosen_strategy

**B: RPC 内の SQL で導出**。

### schema_or_rpc_changes

`supabase/migrations/20260911090000_app_severity_news_feed.sql`（全体を1つのトランザクションで実行）:
1. 新規 `public.important_news_ir_subtype(p_title text) returns text`: IMMUTABLE・PARALLEL SAFE・`search_path=''`。NFKC で正規化した見出しに、TS と同じ正規表現を同じ順序で当てる。
2. 新規 `public.important_news_app_severity(importance, category, title, source_type, source_url, published_at, company_code, japan_market_relevance, fact_check_status) returns text`: IMMUTABLE・PARALLEL SAFE・`search_path=''`。TS の `deriveNewsSeverity` と同じ規則。
3. 上の2つは、public / anon / authenticated / service_role から `revoke all`。呼べるのは、関数の所有者（postgres）で動く SECURITY DEFINER の RPC だけ。
4. `public.get_my_important_stock_news(integer)` を作り直した。戻り値の末尾に `severity text` を1列追加したため、`CREATE OR REPLACE` では変更できず、同じトランザクションの中で `DROP` → `CREATE` した。依存しているビューは0件（事前に確認）。SECURITY DEFINER・`search_path=''`・STABLE・コメント・**権限（authenticated だけが実行可）は元と同じ**。
- テーブル・列・制約・インデックス・RLS・既存行は、どれも変更していない（テストで、候補テーブルへの UPDATE / INSERT / DELETE が migration に無いことを固定）。

### app_feed_rule_before_after

| | 変更前 | 変更後 |
|---|---|---|
| 対象ユーザー・銘柄 | `tracked.user_id = auth.uid()` かつ `is_active`、ticker で結合 | **同じ** |
| 重複 | `duplicate_of is null` | **同じ** |
| 重要度 | importance in (important, most_important) | **severity in (critical, high, medium)**。low は出さない |
| 状態 | ready_for_publish / generation_failed / published | **判定済みの状態すべて**: rejected / ready_for_generation / generating / ready_for_publish / generation_failed / publishing / publish_failed / published。判定前の fetched / pending_judgement と、duplicate / failed は出さない |
| rejected の扱い | 出さない | **公式の開示（tdnet / company_ir）で、かつ severity が medium 以上のときだけ**出す。Web検索で拾った二次情報の rejected は出さない |
| 並び順・件数上限 | `coalesce(published_at, created_at) desc`、1〜50件 | **同じ** |
| 戻り値 | 9列 | 同じ9列 + 末尾に `severity` |

severity の規則（TS と同じ）:
- source_url が https でない、または公開日時が無い → low
- most_important かつ Fact passed → critical / important かつ Fact passed → high
- 個別銘柄（company_code あり）: Fact が未確定の X 級、保有者向けの17カテゴリ、保有者向けIRの小分類（月次・株主優待・株式分割・希薄化・社長交代・承認/CRL・事業の停止・上場廃止・新製品）→ medium。それ以外（定型IR・社債/借入）は low
- 市場全体: 関連度 medium 以上（Fact passed）、または high（Fact 未確定）→ medium。ただし下記のとおり、フィードには入らない

「AIの失敗や Fact が不確かな rejected を無条件で出さない」ための条件:
1. 判定前・判定失敗の状態は出さない
2. rejected は公式の開示に限る（見出しそのものが一次情報）
3. rejected で出るのは、保有者向けのカテゴリ、または見出しから判別できる小分類の根拠があるものだけ。定型のIR（監査役・基準日・子会社の設立・借入など）は low のまま出ない
4. 必須の根拠（https の source_url・公開日時）が欠けたら常に low

アプリの変更（最小限）:
- `src/lib/important-news.ts`: 型に `severity?: 'critical' | 'high' | 'medium'` を追加（任意項目なので、古い RPC でも表示できる）。`importance` に `'no_post'` を許容。
- `src/app/news.tsx`: バッジを severity で出し分け（critical=「最重要」、high=「重要」、medium=「注目」を控えめな色で）。severity が無い場合は、従来どおり importance から決める。
- アプリ側の型チェック: `npx tsc --noEmit` で `src/` のエラーは0件（出力されたエラーはすべて、以前からある Deno 側の `supabase/functions/**` のもの）。

### market_wide_handling

- company_code の無い市場全体のニュースは、**このフィードには入らない**。フィードは、ユーザーの登録銘柄と ticker（company_code の先頭4文字）で結合しているため、構造的に入り込めない。
- 本番では、市場全体で severity medium 以上のものが **26件**あるが、どのユーザーのフィードにも入っていないことを確認した（ロールバック付きテスト、本番の read-only 確認とも `feed_market_wide_rows = 0`）。
- 理由: 影響する業種・資産や「市場アラート」の設定がまだ無いため、関連性を決めずに入れると、全ユーザーにとってのノイズになる。
- severity の導出自体は市場全体にも対応しており、Phase 3 で届け先が決まれば、そのまま使える。

### existing_data_proof

本番の実データで、migration を丸ごとトランザクションの中で実行し、最後に例外を投げて**必ずロールバック**するテストを行った。その後、本番が元のままであること（判定関数0件、RPC の列は元の9列、ウォッチ登録20件）も確認した。人工の candidate は作っていない。一時的なウォッチ登録の追加と無効化も、このトランザクションの中だけで行った。

| # | 項目 | 結果 |
|---|---|---|
| 1 | 本人フィード（ウォッチ20銘柄） | 5件、distinct 5（重複なし）。high 1 / medium 4 |
| 2 | **旧フィードに出ていた記事が、新方式でも出るか** | 消えた件数 **0** |
| 3 | 新しく出る、rejected で medium の開示 | 9433 KDDI・7203 トヨタ・6758 ソニーG・6501 日立の「自己株式の取得状況に関するお知らせ」（share_buyback、公式の開示） |
| 3 | 実在の、却下済みの月次開示「月次営業レポート（2026年８月度）」 | その銘柄を一時的にウォッチすると **medium で表示**（ロールバック済み） |
| 4 | low の行 / 定型的な却下済みIR（routine・社債/借入） | 0 / 0 |
| 5 | ウォッチを無効にした銘柄 | 0件 |
| 6 | 他ユーザー / 未ログイン | 0 / 0 |
| 7 | 市場全体の medium 以上（26件）がフィードに入るか | 入らない |
| 8 | 並び順（新しい順）/ `p_limit=1` → 1件 / `p_limit=0` → 1件に補正 | true / 1 / 1 |
| 8 | 登録銘柄以外の行 | 0件 |
| 8 | 権限: authenticated の RPC 実行 / anon の実行 / authenticated が判定関数を直接実行 / SECURITY DEFINER | true / false / false / true |
| 8 | 戻り値の列 | news_id, ticker_code, company_name, tracking_type, title, summary, importance, news_time, source_url, **severity** |

### tests

- `news_severity_sql_parity_test.ts`（新規・4件）: 小分類の正規表現が SQL に同じ文字列・同じ順序で入っていること / 保有者向けカテゴリの一覧の一致 / 表示対象の小分類の一覧の一致 / フィードの安全境界（本人・アクティブ・重複除外・ticker 結合・rejected は公式の開示に限る・low は出さない・権限・トランザクション・候補テーブルへの書き込みが無いこと）
- `news_severity_logic_test.ts`（Phase 1・20件）: 変更は正規表現の一覧を export しただけで、全件そのまま通過
- 実データでの照合: **960/960 一致**（severity と小分類）
- ロールバック付きの本番データのテスト: 上表のとおり、全項目が期待どおり
- `important_news_notification_logic_test.ts`（producer・29件）: 無変更で通過
- important-news-monitor 全体の回帰: **318 passed / 0 failed**（X 公開ゲート・producer・対象判定・重複防止を含む）
- `deno check`: `news_severity_logic.ts` / `news_severity_sql_parity_test.ts`
- アプリ: `tsc --noEmit` で `src/` のエラー0件
- `git diff --check`: clean

### x_publish_invariants

- `important-news-monitor` のコードに変更なし（`news_severity_logic.ts` は、正規表現の一覧を export しただけ。index.ts からは引き続き参照していない）。Edge Function の deploy なし（v38 のまま）
- `checkPublishCandidate` / auto_publish / cutover / rate control は無変更。`importance` を書き換える処理も無い
- 今回の変更は、アプリの読み取り用 RPC の中だけで閉じている。X 投稿の選定（`selectNextPublishCandidateId`）は、候補テーブルの importance と status だけを見るので、影響を受けない
- 確認: `auto_publish = true`、設定の `updated_at` は 08:53:08 のまま変化なし

### push_invariants

- `send-push-notifications` 無変更（v4）。producer（publish 成功時・company_code 一致）も無変更
- severity が medium / high の新しい表示項目から、通知は作らない（アプリの読み取りだけ）
- 確認: 適用の前後とも **notifications = 0**。Cron は8本すべて active で変化なし

### production_apply_method

- `supabase db push` は**使っていない**（本番の migration 履歴は `20260905140638` で止まっており、repo にはそれより新しい未適用・未記録の migration があるため）
- 適用の直前にroot安全確認: `pwd` = worktree、HEAD `83b914c`、worktree 内の `supabase/config.toml`、linked project ref `wsmznyzcvmuitkglfeuj`
- `supabase db query --linked -f <絶対パス>` で、今回のファイル1本だけを適用した。ファイル自体が `begin; … commit;` の1トランザクション
- 事前に、同じ内容をロールバックするトランザクションで本番データに対して実行し、結果を確認してから適用した
- `supabase_migrations.schema_migrations` には記録していない（これまでの個別適用と同じ扱い。履歴の乖離は既知の残課題）

### production_verification

適用後に read-only で確認:
1. RPC: 列に `severity` が追加され、SECURITY DEFINER・`search_path=""`・ACL `{postgres=X/postgres,authenticated=X/postgres}` を維持。anon は実行不可
2. 判定関数: 2つとも存在し、IMMUTABLE、ACL は `{postgres=X/postgres}` だけ（authenticated からは直接呼べない）
3. 本人フィード: 5件（high 1 = ソフトバンクG の社債 / medium 4 = 自己株式の取得状況 ×4）、distinct 5
4. 市場全体の行 0 / low の行 0
5. notifications = 0（増加なし）
6. auto_publish = true、設定の `updated_at` は変化なし、active な Cron は8本、candidate の状態別件数は適用前と同じ（rejected 793 / generation_failed 88 / ready_for_publish 30 / published 13 / duplicate 36）
7. Edge Function: 6つとも version・`updated_at` とも変化なし（`x-oauth-connect` v4 は 09-10 15:09 に Claude slot 2 が更新したもので、今回とは無関係）
- アプリの実機での表示確認は、今回は行っていない（dev build は Metro 経由で新しい JS を読み込めば反映される）。古いアプリのままでも、知らない `severity` 列は無視されるだけで、新しい medium の項目は従来のバッジ（「重要」）で表示される（下記 remaining_issues 2）

### changed_files

- `supabase/migrations/20260911090000_app_severity_news_feed.sql`（新規・本番適用済み）
- `supabase/functions/important-news-monitor/news_severity_sql_parity_test.ts`（新規）
- `supabase/functions/important-news-monitor/news_severity_logic.ts`（`CORPORATE_IR_SUBTYPE_RULES` の export とコメントのみ）
- `src/lib/important-news.ts`（型に `severity` を追加、`importance` に `no_post` を許容）
- `src/app/news.tsx`（バッジを severity で出し分け、控えめなスタイルを2つ追加）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

### commit_hash

- この直後の commit で、上記のファイルと本 Report をまとめて記録する

### push

- `origin/main` へ同期済み

### remaining_issues

1. **市場全体のニュースの届け先が無い**（今回は意図的にフィードから外した）。本番の26件を含め、表示するには関連付けの仕組みが必要（Phase 3）。
2. **古いアプリでのバッジ**: 新しい RPC は既存のアプリでも動くが、古いアプリは `severity` を知らないため、新しく表示される medium の項目（importance = no_post）も「重要」のバッジで表示される。新しいアプリのコード（commit 済み）では「注目」になる。dev build は Metro から新しい JS を読めば直る。
3. **ロジックの二重実装**（TS と SQL）。静的なテストと実データの照合で担保したが、今後、規則を変えるときは両方を同時に変える必要がある（テストが落ちるので、気付かないまま片方だけ変わることは無い）。
4. **フィードの件数上限（50件）と medium の件数**: 月次の開示などで medium が増えると、古い critical / high が50件の枠から押し出されることがある。今は本人のフィードが5件なので問題ないが、登録銘柄が増えたときは、重要度の高いものを優先する並べ方か、ページングを検討する必要がある。
5. **小分類は見出しのキーワードによる**ので、取りこぼしや誤判定はありうる（Phase 1 から継続）。
6. **migration 履歴の乖離**（既知・継続）。今回の `20260911090000` も、個別適用して未記録。
7. 前タスクまでの既知課題（`important-news-monitor` / `x-test-post` の認証不足、`supabase/config.toml` がリポジトリ管理外、dispatcher に原子的な claim が無いなど）は継続。

### safety_checks

- `important-news-monitor` の Edge deploy なし。`send-push-notifications` / `x-test-post` の変更・deploy なし
- X 公開ゲート・auto_publish・Cron・secrets・OAuth・alert_settings の変更なし
- Push の配信対象の拡大なし。市場全体のニュースを全ユーザーへ流していない（フィードにも Push にも入らない）
- 人工の candidate の投入なし。backlog の状態変更・削除なし。既存行の UPDATE・バックフィルなし
- 破壊的なスキーマ変更なし（テーブル・列の変更なし。関数の作り直しは、同じトランザクションの中で権限まで含めて復元）
- `db push` は使っていない。今回のファイル1本だけを適用した
- 本番での検証は、read-only のクエリと、必ずロールバックするトランザクションだけ
- 共有 checkout の未コミット変更には触れていない

### phase3_recommendation

市場全体のニュースを「関係のある人にだけ」届けるための最小案:
1. **`affected_assets` / `affected_sectors` の付与**: 判定がすでに出している `affected_entities` と、Phase 1 の分類表の伝わり方（例: tariffs → 自動車・輸出、war_ceasefire → 原油・防衛・海運、semiconductor_ai → 半導体）から、決定論的にタグを付ける（SQL の関数か、読み取り時の導出）。
2. **保有銘柄との突き合わせ**: `stocks_master.sector`（既存の列）と `affected_sectors` を結び、保有銘柄の業種に関係する市場ニュースだけを、そのユーザーのフィードに出す。
3. **`market_alerts` の設定**: ユーザーが「市場全体の重大ニュース」を受け取るかどうかを選べる設定（`alert_settings` に列を1つ追加する程度）。既定は OFF にして、全ユーザーへの一律配信を避ける。
4. **Push は最後に**: まずアプリのフィードだけに出し、件数とノイズを観測してから、保有銘柄の critical に限って Push を検討する。
5. フィードの並べ方: severity を優先する並び順か、「重要（critical / high）」と「注目（medium）」を分けた表示を検討する（remaining_issues 4）。
