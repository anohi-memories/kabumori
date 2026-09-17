# Claude Task 1

- task_id: market-report-shared-platform-phase2-consumer-cutover-20260917
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: urgent
- recommended_model: Opus 5
- deadline: 2026-09-18 17:15 JST natural close cycle
- purpose: 既にproduction shadow稼働している `market_data_packet.v1` を正本として、朝刊/大引けの市場分析を1回だけ生成し、Xとアプリが同じ市場事実・同じ市場分析を参照するconsumer切替candidateを作る。連休前に自然朝刊・大引けで確認できる状態を目指す。

## User decision

2026-09-17、ユーザーは「明日の大引までにやってしまいたい。5連休に入るので実装チェックできなくなる」と明示。

期限優先だが、既存本番を壊すbig-bangは禁止。source実装・tests・shadow deployまでは進めてよい。既存X/app consumerのproduction切替はK1 review PASS後に行う。

## Current proven state

前Phase 1はproduction shadow rollout済み。

- `market_data_packets` / `market_report_cycles` production導入済み
- `market-report-data-packet` v1 ACTIVE
- shadow Cron:
  - morning 07:50 JST
  - close 16:15 JST
- 2026-09-17 16:15 JST natural close packet completed
- close packet required_missing=[]
- natural values included Nikkei 64136.25 / TOPIX proxy 1306 427.4 / US indices etc
- existing X/app consumersはまだpacket未参照
- 2026-09-18 07:50 JSTがnatural morning packet初回

今日17:00のX closeは旧経路で `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`、17:15 app closeは旧Yahoo daily経路でcompleted。Phase 1 shadow packet自体は16:15にcompletedしている。

## Deadline scope

明日までに優先するのは**共通生成・共通参照のdata/content layer**。

必須:
1. 共通 `market_report_packet.v1` を1 cycle 1回生成
2. X morning / close はそのpacketだけから約300字summaryを作る
3. app morning / close は同じpacketの市場分析を入力・市場部分の正本として使う
4. app personal部分は portfolio snapshot + shared packet の差分だけを生成
5. Xとappが市場方向・主要材料・理由で矛盾しないこと

今回の期限では、既存アプリUIの大規模な「市場全体/マイポート」2タブ化は必須にしない。まずbackend/content sourceを共通化し、UI再設計は後続可能とする。

## Architecture target

```text
market_data_packet.v1 (immutable facts)
        ↓
market_report_packet.v1 (shared market analysis, one AI generation per cycle)
        ├─ X deterministic/lightweight summary
        └─ app personalized report
             ├─ shared market section
             └─ portfolio-specific delta
```

原則としてX側でweb_searchや市場data再取得をしない。app側でも市場全体の再分析をしない。

## Phase A — implement shared market_report_packet

現行DESIGN.mdとPhase1 schemaをfresh auditして最小実装する。

要件:
- morning / closeそれぞれ1 cycle 1 packet
- inputはcompleted `market_data_packet.v1`のみ
- source/evidence refsを保持
- output例: market_summary, major_moves, why_market_moved, strong/weak sectors/themes where supported, key_news, macro_policy_geopolitics, overseas_to_japan_effects, next_watch, risks, data_gaps
- packet外の数値・因果を追加しない
- `causal` / `consistent_with` / `insufficient_evidence`を区別
- data_quality blocked時は生成せずfail-closed
- partialはrequired_missing=[]なら許容し、intentional_gaps/staleを明示
- one cycle one successful immutable packet
- OpenAI usage/token/costを保存

## Phase B — X consumers

`x-test-post` morning_report / close_reportをshared packet consumer化するcandidateを作る。

要件:
- X summaryはshared report packetからのみ作る
- heavyweight web_search再実行禁止
- Yahoo再取得禁止
- 新しい市場事実追加禁止
- 300字前後、現行読みやすさ維持
- deterministic formatterを第一候補。AIを使う場合も軽量1call上限でshared packet外を参照しない
- morningで今回発生した `VOICE_EVALUATION_JSON_PARSE_FAILED/max_output_tokens` を再発させる別heavy Voice経路は避ける。必要なら短いbounded evaluation schemaのみ
- X publish/OAuth/account routingは既存のまま

## Phase C — app consumers

`personalized-reports` morning/closeをshared packet参照へ変更するcandidateを作る。

要件:
- 市場全体部分はshared report packetを再利用し、別AIで市場理由を作り直さない
- portfolio固有生成は shared packet + portfolio snapshot + stock-specific refs のdeltaに限定
- shared market claimsをportfolio AIが上書き/矛盾させない
- Factはportfolio固有claimsを中心に行い、shared packet本文そのものを別解釈しない
- Push/notification semanticsは変更しない

## Safe cutover design

consumer switchはfeature/configurable gateを用意し、rollbackを単純にする。

K1前:
- source/tests
- migration candidate if needed
- new shared report Function deployはshadow用途なら可
- artificial X post / Pushは禁止
- `x-test-post` / `personalized-reports` production consumer switchは禁止

K1 PASS後のcutover候補:
- shared packet consumerをON
- packet missing/blocked時の挙動を明示。勝手に別の市場分析を生成してX/appが再び分岐する設計は禁止
- holiday中に静かに壊れるより、共通packet未成立時は安全なskip/明示failureを優先

## Tomorrow gates

### Gate 1 — 07:50 JST
Natural morning `market_data_packet.v1` を確認。
- completed
- required_missing=[]
- source/freshness妥当

失敗時はconsumer切替を強行せず原因報告。

### Gate 2 — 08:20 / 08:35 JST
K1 PASSとcutoverが間に合った場合:
- X morningとapp morningが同一shared report packet id/hashを参照
- X published/succeeded
- app completed/Fact passed/Push正常
- 市場方向・主要材料・理由が一致

### Gate 3 — 16:15 / 17:00 / 17:15 JST
- close data packet completed
- shared close report packet completed
- X close succeeded using same shared packet
- app close completed using same shared packet
- X `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`旧経路に入らない

## Tests

最低限:
- report packet schema/immutability/idempotency
- morning/close completed data packet -> report packet
- blocked data -> no report generation
- evidence/causality guard
- X summary contains no fact outside shared packet
- X morning/close no web_search/Yahoo fetch in shared mode
- app market section uses exact shared packet
- portfolio delta cannot overwrite shared market facts
- missing shared packet behavior
- rollback gate OFF restores legacy code path before cutover
- existing x-test-post full regression
- personalized-reports regression
- `git diff --check`

## Parallel safety

開始前に `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, all four TASKs, fresh origin/main を確認。

Known boundaries:
- H1 may own AI Lab OAuth/Vault/x-oauth-connect. This G1 must not touch OAuth/Vault/social account state.
- G2 morning-greeting workflow/scriptには触らない。
- important-news producer logicは変更しない。read/reuse only。

同じ `x-test-post` / `personalized-reports` / market report schema/functionを他slotが変更中ならSTOPして具体的競合を報告。

## Prohibited

- blind `supabase db push`
- migration history repair/reconcile
- OAuth/token/handle changes
- manual X post
- manual Push to users
- backfill of historical reports
- AI Lab/Mio behavior changes
- existing posting window/Cron time changes unrelated to shared market report
- deleting failed evidence
- secrets output

## Completion before K1

- implementation candidate + tests complete
- any shadow-only production changes read-back verified
- consumer production switch remains OFF
- status `review_required`, next_owner `chatgpt`
- Report includes changed files, schema, call graph, tests, cost effect, rollback, tomorrow Gate readiness, exact commit

Do not wait for two-day Phase1 observation because user explicitly set a pre-holiday deadline; instead preserve safety by keeping consumer switch gated until K1 and tomorrow natural packet checks.

## Report

- task_id: `market-report-shared-platform-phase2-consumer-cutover-20260917`
- result: **実装候補・テスト・使い捨てDB検証まで完了。本番変更 0（consumer 切替 OFF のまま）**。共通 `market_report_packet.v1` の生成 Function、X朝刊/X大引けとアプリ朝刊/大引けの共通 packet 参照（切替ゲート付き、既定 OFF）を実装
- model_used: Opus 5（`claude-opus-5`）
- source_base: `origin/main` `fd45e5f`（着手時）。着手マーク push 済み
- shadow 本番反映（Phase 2 migration 適用・analysis Function deploy・Cron）は**未実施**。本番操作はユーザーのチャット承認が必要（前回、自動モードの安全チェックで停止した経緯あり）。承認後の手順は下記「rollout / cutover」に記載

### call graph（切替後）

```text
07:50 / 16:15  market-report-data-packet（Phase 1、稼働中）→ market_data_packets（不変）
07:55 / 16:20  market-report-analysis（新規）
               claim_market_report_analysis → data packet 読み取り → news_refs の Fact 済み日本語本文読み取り
               → OpenAI 生成 1回（不合格時のみ再生成 1回）＋ Fact 1回 → ローカル検証
               → complete_market_report_analysis → market_report_packets（不変、1 cycle 1件）
08:05 / 16:35  同 Function の再試行（claim が冪等なので完了済みなら何もしない）
08:20 / 17:00  x-test-post morning_report / close_report
               get_shared_market_report('x') → gate OFF: 既存経路そのまま
                                              → gate ON : packet の x_post をコードで整形して投稿（web_search / Yahoo / OpenAI / Voice なし）
                                                          packet 未完成なら SHARED_MARKET_REPORT_UNAVAILABLE で投稿しない
08:35 / 17:15  personalized-reports
               get_shared_market_report('app') → gate OFF: 既存経路そのまま
                                               → gate ON : 指数値は data packet、市場分析は report packet を参照
                                                           ユーザー別 AI は差分（ポートフォリオ部分）だけ生成
                                                           body.market_section に共通分析をそのまま保存
                                                           packet 未完成ならその回は生成しない（skip、Push なし）
```

X とアプリは同じ `report_packet_id` / `report_content_hash` を記録するため、同一分析を参照したことを後から照合できる。

### changed files

- 新規 migration: `supabase/migrations/20260920100000_market_report_packets_phase2.sql`
  - `market_report_packets`（insert-only、`unique(cycle_id)`、payload と data packet の一致 check、不変トリガ）
  - `market_report_cycles` に analysis 状態列（`report_status` / `report_attempt_count` / `report_claim_token` / `current_report_packet_id` ほか）。Phase 1 の guard 関数を、既存ルール＋report pointer の一回設定・completed 固定に置換
  - `market_report_consumer_settings`（singleton、`x_enabled` / `app_enabled` **既定 false**）
  - RPC（SECURITY DEFINER / `search_path=''` / service_role のみ）: `claim_market_report_analysis` / `complete_market_report_analysis` / `fail_market_report_analysis` / `get_shared_market_report(consumer, report_type, trading_date)`
- 新規 Function: `supabase/functions/market-report-analysis/`（`index.ts` / `handler.ts` / `analysis_input.ts` / `analysis_logic.ts` / テスト2本 / fixtures＝9/17 大引けの本番 data packet と参照ニュース行の read-only 抽出）
- 新規共有: `supabase/functions/_shared/market_report_packet.ts`（packet 型、X 本文の決定的フォーマッタ、アプリ市場セクション、gate 応答パーサ）
- `x-test-post`: `index.ts` に +50行（morning_report / close_report 分岐の直前に gate 判定を追加。既存分岐は無変更）、新規 `shared_market_report_consumer.ts` ＋テスト
- `personalized-reports`: `index.ts`（gate 読み取り、gate ON 時は指数を data packet から取得・shared 分析を packet に追加・source_basis に packet id/hash）、`report_logic.ts`（`priceFactFromSharedMetric`、shared 用指示、Fact 指示1行、方向矛盾の検出、`body.market_section`）、新規テスト
- アプリ UI: `src/app/reports/[id].tsx` に「今日の市場全体 / けさの市場全体」セクション（`body.market_section` がある場合のみ表示。既存レポートの見た目は不変）、`src/lib/report-presentation.ts` に型
- docs: `docs/market-report-shared-platform/phase2_db_proof.sql`

### schema（market_report_packet.v1）

- コードが決めるもの: `market_direction`（大引け=日経平均と1306、朝刊=米3指数の当日変化率。±0.1%未満は横ばい）、`direction_basis`、`major_moves`（data packet の表示用文字列）、`data_gaps_ja`、`key_news[].headline_ja`、`data_packet_id` / `data_content_hash`
- AI が書くもの: `headline_ja` / `market_summary_ja` / `claims[]`（`claim_type`: observation / causal / consistent_with / insufficient_evidence / watch_point、`evidence_refs`、`scope`）/ `key_news[].why_it_matters_ja` / `strong_themes` / `weak_themes`（claim_ids 必須）/ `next_watch_ja` / `risks_ja` / `x_post`（lead / points×3 / closing）
- 記録: `fact`（ai_status=passed、generation_attempts）、テーブル列に model / generation_calls / input・output tokens / api_cost_usd
- MIC 由来（金利・原油・ドル円）の変化率はモデルに渡さない（前回保存値との比較で、9/17 実データでは WTI +10.03%・Brent +19.44% と誤解を招くため）

### safety（AI 出力のローカル検証）

- 入力に無い数値（表示文字列・ニュース本文・日付以外）/ URL / ハッシュタグ / HTML / 速報ラベル / 売買推奨 / 「TOPIX」単独表記 / 続伸・続落などの複数日語
- evidence_refs は入力の `metric:` / `news:` のみ。`causal` は news ref 必須。observation などは ref 必須
- テーマの claim_ids 実在、key_news の ref 実在、見出し・要約の長さ、X 本文の3ポイント・文字数（150〜520字）
- 不合格・Fact 不合格は理由を付けて1回だけ再生成。2回目も不合格なら packet を作らず fail（再試行 Cron で最大3回）
- アプリ側: ユーザー別文面が共通分析の方向と逆（例: 共通=上昇なのに「日経平均は下落」）なら `CONTRADICTS_SHARED_MARKET` で不合格。Fact 指示にも共通分析との矛盾チェックを追加

### tests

- `market-report-analysis`: **13/13 PASS**（本番 9/17 大引け data packet から入力構築、方向のコード判定、ローカル検証の検出9種、生成＋Fact、再生成、Fact 2回不合格で fail、hash、handler: 認証・完了・data_not_ready で OpenAI 0・blocked で OpenAI 0・Fact 不合格で保存なし・冪等、通信先は OpenAI と Supabase のみ・web_search tools なし）
- `x-test-post`: **394/394 PASS**（既存 388 ＋新規 6: gate ON で決定的本文を1回投稿・run 記録、packet 未完成で投稿しない、型違い/本文不正で投稿しない、X 失敗時の run 状態、gate 読み取り（disabled / RPC 404 を disabled 扱い / 503 は1回再試行後エラー）、アプリ市場セクションの完全一致）
- `personalized-reports`: **28/28 PASS**（既存 24 ＋新規 4: 指数値が data packet 由来、shared 分析の受け渡しと gate OFF 時は packet・指示とも従来と同一、方向矛盾の検出、body.market_section の完全一致と gate OFF 時は付かないこと）
- `market-report-data-packet`（Phase 1）: 35/35 PASS
- 型チェック: `market-report-analysis` / `personalized-reports` / `market-report-data-packet` / `_shared/market_report_packet.ts` PASS。`x-test-post/index.ts` は本変更前からある6件（`_shared/x_oauth2_post.ts`、`morning_greeting_*`、`morning_lane_response_logic.ts` 等）のみで、本変更による新規エラー 0。アプリ `src/` の `tsc` エラー 0
- `git diff --check` PASS
- 使い捨て PostgreSQL（Podman、`supabase/postgres:17.6.1.165`、ポート・ボリュームなし、終了後削除）:
  - Phase 1 → Phase 2 の順に適用成功
  - `phase2_db_proof.sql` **8/8 PASS**: 権限・RLS・gate 既定 OFF / data 未完成で analysis 不可 / data→analysis→completed・再 claim 冪等・1 cycle 1 packet / 古い token 拒否 / report packet の更新・削除・pointer 変更・2件目 insert 拒否 / gate OFF=disabled・x ON で同一 packet 返却・app は独立・未作成は missing / 失敗は上限3回・consumer には not_ready / Phase 1 の不変性維持
  - Phase 1 の `phase1_db_proof.sql` も Phase 2 適用後に再実行して PASS
  - rollback containment: Phase 2 本体＋`1/0` の1トランザクション → 新テーブル・列なし、guard 関数も Phase 1 版に戻ることを確認

### cost effect（見積もり、実測は shadow 稼働後）

- analysis: luna 2 call（生成＋Fact）、入力 約6,000〜9,000 / 出力 約1,500〜2,500 tokens → **約 $0.003〜0.005 / cycle**（再生成時 最大4 call で 約 $0.01）
- X: 切替後 OpenAI・web_search 0 → 現行 1回 約 $0.03〜0.05 が **$0**
- アプリ: 入力が shared 分析分（約 500〜1,000 tokens）増え、ユーザー当たり +約 $0.0002
- 1営業日（ユーザー1人）: 現行 約 $0.09 → **約 $0.012〜0.016**

### rollout / cutover（K1 PASS 後。本番操作はユーザー承認が必要）

A. shadow（consumer は OFF のまま、今夜実施できれば Gate 3 に間に合いやすい）
1. Phase 2 migration の本番 rollback-contained proof → `supabase db query --linked -f supabase/migrations/20260920100000_market_report_packets_phase2.sql` で単体適用 → read-back（gate が false であることを含む）
2. `market-report-analysis` を `--no-verify-jwt` で deploy → download して byte 比較、他 Function 不変確認
3. Cron 4本（Vault の `send_push_notifications_cron_secret` を名前参照）
   - `market-report-analysis-morning` `55 22 * * 0-4`（07:55 JST）、`market-report-analysis-morning-retry` `5 23 * * 0-4`（08:05 JST）
   - `market-report-analysis-close` `20 7 * * 1-5`（16:20 JST）、`market-report-analysis-close-retry` `35 7 * * 1-5`（16:35 JST）
   - body は `{"mode":"morning"}` / `{"mode":"close"}`
4. 自然実行で `market_report_packets` を確認（X / アプリは未参照）

B. cutover（K1 が shadow packet の内容を確認して PASS した後）
1. `x-test-post` / `personalized-reports` を deploy（gate OFF のままなので挙動は現行と同じ）→ byte 比較。**H1 が `x-test-post` を触っている場合は deploy 順を調整**
2. `update public.market_report_consumer_settings set x_enabled = true, app_enabled = true, updated_at = now();`
3. 次の自然 08:20 / 08:35 または 17:00 / 17:15 で、X run とアプリ report の `sharedMarketReport.reportPacketId` と `source_basis.shared_market_report_packet_id` が一致することを確認

rollback: `update public.market_report_consumer_settings set x_enabled = false, app_enabled = false, updated_at = now();`（再 deploy 不要で即時に既存経路へ戻る）。analysis Cron は停止しても既存経路に影響なし。

### tomorrow Gate readiness（2026-09-18）

- Gate 1（07:50 data packet）: Phase 1 稼働中。初回の自然朝刊。本タスクの変更に依存しない
- Gate 2（08:20 / 08:35）: 今夜中に A（shadow）と K1 PASS・B-1（deploy）・gate ON まで終わる必要があり、**現実的には厳しい**。間に合わない場合は既存経路で投稿・生成される（gate OFF）
- Gate 3（16:15 / 17:00 / 17:15）: 明朝 07:55 の shadow 朝刊 packet を K1 が確認 → 日中に B を実施すれば**間に合う想定**。X大引けは gate ON で `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`（旧経路）に入らない
- 連休（9/19〜9/23）: 9/21〜9/23 は JPX 休場で全 Function が `NOT_TRADING_DAY` で skip。gate ON 中に packet が作れない営業日は X / アプリとも「出さない」（別分析へのフォールバックなし）

### production changes

- **0**（本番 migration・deploy・Cron・設定・X 投稿・Push・OpenAI 手動呼び出しなし）
- read-only のみ: 9/17 大引けの data packet と参照ニュース行の抽出（fixture 用）、`complete_*_report_post` の関数定義確認

### parallel safety / risks

- H1（AI Lab OAuth 401）が `x-test-post` を変更・deploy する可能性。今回の `x-test-post` 変更は gate 判定の追加のみで、AI Lab / OAuth / dispatcher 経路には触れていない。main へのマージ競合と deploy 順の調整が必要
- gate ON 中に analysis が失敗した日は X もアプリも出ない（意図した fail-closed）。再試行 Cron と上限3回で緩和
- X 本文は現行（500〜800字目安・Voice 評価あり）から約200〜350字の決定的整形に変わる。文体は生成時に KABUMORI_VOICE を与えているが、別途の Voice 評価はしない（`VOICE_EVALUATION_JSON_PARSE_FAILED` 系の再発を避けるため）
- アプリは gate ON で packet 未完成の日、その回のレポートを作らない（行も作らないため、履歴は関数ログと `net._http_response`（約6時間保持）にしか残らない）
- ローカル検証の数値チェックが厳しく、実モデル出力での合格率は shadow 稼働で確認が必要（モデル実呼び出しの本番テストは未実施）
- 朝刊の方向は米3指数で判定（日本市場の寄り付き前のため）
