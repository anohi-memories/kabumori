# Claude Task 1

- task_id: market-report-shared-platform-phase2-consumer-cutover-20260917
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
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

### Production shadow rollout（2026-09-17 夜、ユーザーのチャット承認後）

- 承認範囲: Phase 2 migration 単体適用 / `market-report-analysis` のみ deploy / 分析 Cron 4本追加。`x_enabled` / `app_enabled` は false 維持、`x-test-post`・`personalized-reports` は deploy しない
- deploy_source: worktree `/Users/yuya/Developer/kabumori/.claude/worktrees/ios-push-e2e`、HEAD = origin/main = `05a677f`。migration と `market-report-analysis` / `_shared/market_report_packet.ts` / `_shared/kabumori_voice.ts` / `market-report-data-packet/**` は `05a677f` と差分なし
- migration SHA-256: `7f07457752d39783deb90c6d0c6627f47d33760995503e6ae53e494be4a0ba47`
- 並行スロット: H1 は AI Lab Vault token refresh candidate（ready）。本反映の migration / Function / Cron とは重複なし

#### 事前状態（read-only）

- `market_report_packets` / `market_report_consumer_settings` absent、`get_shared_market_report` などの RPC なし
- Cron 28本（`market-report-analysis-*` なし）、data cycle 1 / data packet 1（9/17 大引け）、migration 履歴末尾 `20260915130756`
- 全 Function の version / updated_at / verify_jwt を記録

#### 本番 rollback-contained proof

`begin;` ＋ Phase 2 本体 ＋ 検証 DO ブロック ＋ `RAISE EXCEPTION` ＋ `rollback;` を `supabase db query --linked -f` で実行。結果:

- `tables=2` / `rls=true` / `policies=0` / `new_cycle_columns=10` / `report_packet_triggers=4` / `rpc_definer_empty_path=4` / `anon_auth_access=false` / `service_role_select_only=true`
- `gate_rows=1` / **`gate_x_enabled=false` / `gate_app_enabled=false`** / 既存 9/17 cycle の `report_status=pending`
- スモーク（1999-01-04 の仮 cycle）: `smoke_analysis_claim=claimed` / `smoke_reclaim=already_completed` / `smoke_gate_off=disabled` / gate を仮に ON にすると `smoke_gate_on=completed` かつ `smoke_gate_on_same_packet=true` / `smoke_update_report=MARKET_DATA_PACKET_IMMUTABLE`
- proof 後の read-back は事前状態と**完全一致**（Phase 1 guard 関数の md5、Cron 28本の md5 を含む）

#### migration 適用 / read-back

- 方法: `supabase db query --linked -f /Users/yuya/Developer/kabumori/.claude/worktrees/ios-push-e2e/supabase/migrations/20260920100000_market_report_packets_phase2.sql`（`supabase db push`・履歴修復なし）
- read-back:
  - tables `market_report_packets` / `market_report_consumer_settings`、RLS 両方 true、policies 0
  - `market_report_packets` 制約15（`cycle_key`=1 cycle 1 packet、`payload_identity`、`fact_status_check`、FK 2 ほか）、トリガ4（`match_cycle` / `no_update` / `no_delete` / `no_truncate`）
  - `market_report_cycles` に分析状態列と `current_report_packet_fkey` / `report_completed_has_packet` / `report_running_has_token`、guard 関数に report 規則あり
  - RPC 4本 SECURITY DEFINER・`search_path=""`、execute は service_role のみ
  - table grants: service_role の SELECT のみ
  - **gate: `x_enabled=false` / `app_enabled=false`**
  - report packets 0、既存 9/17 大引け cycle は `report_status=pending`（今日の分析 Cron 時刻は過ぎているため、今日分は生成されない。手動実行もしていない）
  - Cron 28本のまま、migration 履歴に `20260920100000` は**記録されていない**（既知の履歴乖離、修復していない）

#### Function deploy / byte-compare

- `supabase functions deploy market-report-analysis --no-verify-jwt --project-ref wsmznyzcvmuitkglfeuj`（deploy 直前に `pwd`・HEAD・origin/main・worktree-local `config.toml` の project_id・`.temp/project-ref` を確認）
- after: **`market-report-analysis` v1 / ACTIVE / verify_jwt=false**（script 32 kB）
- runtime read-back: 別ディレクトリへ `supabase functions download market-report-analysis --use-api` → **7ファイル全て `cmp` 一致**（`market-report-analysis/{index,handler,analysis_input,analysis_logic}.ts`、`_shared/{market_report_packet,kabumori_voice}.ts`、`market-report-data-packet/session_logic.ts`）。`packet_schema.ts` は型のみの import でバンドル対象外（想定どおり）
- 他 Function（deploy 直前との比較）: `x-test-post` v112 / `important-news-monitor` v57 / `stocks-master-sync` v18 / `stocks-new-listing-sync` v17 / `send-push-notifications` v17 / `x-oauth-connect` v20 / `personalized-reports` v15 / `market-intelligence-ingest` v15 / `market-intelligence-state-evaluator` v9 / `brand-post-dry-run` v7 / `market-report-data-packet` v1 → **全て version・updated_at・verify_jwt・status 不変**
- 実行に必要な secret（名前のみ確認、値は非表示）: `OPENAI_API_KEY` / `SUPABASE_SECRET_KEYS` / `SUPABASE_URL` / `SEND_PUSH_NOTIFICATIONS_CRON_SECRET` いずれも設定済み

#### Cron（新規4本のみ）

| jobid | name | schedule（UTC） | JST | body |
|---|---|---|---|---|
| 30 | `market-report-analysis-morning` | `55 22 * * 0-4` | 平日 07:55 | `{"mode":"morning"}` |
| 31 | `market-report-analysis-morning-retry` | `5 23 * * 0-4` | 平日 08:05 | `{"mode":"morning"}` |
| 32 | `market-report-analysis-close` | `20 7 * * 1-5` | 平日 16:20 | `{"mode":"close"}` |
| 33 | `market-report-analysis-close-retry` | `35 7 * * 1-5` | 平日 16:35 | `{"mode":"close"}` |

- command（secret-free）: Vault の `send_push_notifications_cron_secret` を名前参照し、`https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-report-analysis` のみへ `net.http_post`（timeout 150000ms）。4本とも呼び先が analysis Function だけであることを read-back
- 既存 Cron 28本は `jobname / schedule / active / md5(command)` が反映前と全て同一

#### 手動実行・消費者切替

- `market-report-analysis` の手動 invoke 0、OpenAI 手動呼び出し 0、X 投稿 0、Push 0
- `x-test-post` / `personalized-reports` は未 deploy（本番は旧コードのまま）、gate も false のため X / アプリは今までどおり

#### 明朝の観測（2026-09-18）

- 07:50 `market-report-data-packet-morning` → morning data packet（Phase 1 初の自然朝刊）
- 07:55 `market-report-analysis-morning` → data packet が completed なら shared analysis を生成。未完了なら `data_not_ready` で何もしない
- 08:05 retry → 完了済みなら `already_completed`、07:55 が失敗していれば再試行
- 08:20 X朝刊 / 08:35 アプリ朝刊は gate OFF のため旧経路（shared packet は参照しない）
- 観測 SQL（read-only、`supabase db query --linked -f`）:

```sql
select c.report_type, c.trading_date, c.cycle_status, p.data_quality_status,
  c.report_status, c.report_attempt_count,
  to_char(c.report_started_at at time zone 'Asia/Tokyo', 'MM-DD HH24:MI:SS') as report_started_jst,
  to_char(c.report_completed_at at time zone 'Asia/Tokyo', 'MM-DD HH24:MI:SS') as report_completed_jst,
  c.report_last_error, c.report_diagnostics,
  r.id as report_packet_id, r.content_hash as report_hash, r.generation_calls, r.input_tokens, r.output_tokens, r.api_cost_usd,
  r.payload ->> 'market_direction' as direction,
  r.payload ->> 'headline_ja' as headline,
  jsonb_array_length(coalesce(r.payload -> 'claims', '[]'::jsonb)) as claims,
  (select jsonb_agg(x) from jsonb_array_elements_text(r.payload #> '{x_post,points_ja}') as x) as x_points,
  (select s.x_enabled::text || '/' || s.app_enabled::text from public.market_report_consumer_settings s) as gate_x_app
from public.market_report_cycles c
left join public.market_data_packets p on p.id = c.current_data_packet_id
left join public.market_report_packets r on r.id = c.current_report_packet_id
order by c.trading_date desc, c.report_type;
```

- 失敗時は `report_last_error`（例 `ANALYSIS_LOCAL_CHECK_FAILED` / `ANALYSIS_FACT_FAILED`）と `report_diagnostics.issues` で理由を確認できる。本文全体は `select payload from public.market_report_packets where id = …`

#### production changes（本反映分）

1. migration `20260920100000_market_report_packets_phase2.sql` 適用
2. Edge Function `market-report-analysis` v1 新規 deploy
3. Cron 4本新規追加（jobid 30〜33）
- それ以外（gate、既存 Function・Cron・設定・ユーザー設定・OAuth・Vault・X・Push・アプリ）の変更は 0

#### 状態

- consumer 切替は OFF のまま。明朝 07:50 / 07:55 の自然 packet を観測できる状態で K1 待ち
- cutover（`x-test-post` / `personalized-reports` deploy と gate ON）は K1 が明朝の shared packet を確認して PASS した後の別承認

### 自然実行の観測（2026-09-18 朝、read-only）

結論: **朝刊の data packet が blocked になり、共通分析は生成されなかった**。原因は Yahoo 側のデータ欠損で、実装の fail-closed は設計どおりに働いた。gate は OFF のままで、X朝刊・アプリ朝刊は従来経路で正常に完了している。本番変更・deploy・gate 変更・手動 invoke・X 投稿・Push はいずれも行っていない。

#### タイムライン（JST）

| 時刻 | 処理 | 結果 |
|---|---|---|
| 07:50:00 | `market-report-data-packet-morning` | `blocked` / `requiredMissing=["nikkei225"]` / packet `002fdf41-be5b-4a61-9ba8-53e8a97fdbb9` を保存（attempt 1） |
| 07:55:00 | `market-report-analysis-morning` | `skipped` / `data_not_ready`（OpenAI 呼び出し 0、cycle への書き込み 0） |
| 08:05:00 | `market-report-analysis-morning-retry` | `skipped` / `data_not_ready`（同上） |
| 08:20:32 | X朝刊（従来経路、gate OFF） | `succeeded` / Fact passed / 投稿済み / model `gpt-5.6-luna` |
| 08:35:00 | アプリ朝刊（従来経路、gate OFF） | `completed`（ユーザー1件、生成2 call） |

#### market_report_cycles / market_report_packets

- `morning 2026-09-18`: `cycle_status=blocked`、`last_error=DATA_QUALITY_BLOCKED`、`attempt_count=1`、`started_at=failed_at=07:50:01`
  - `report_status=pending` / `report_attempt_count=0` / `report_last_error=null` / `report_diagnostics={}`（分析は claim すらしていない＝正しい挙動）
- `close 2026-09-17`: `cycle_status=completed` / data `partial` / `report_status=pending`（16:20 の Cron 追加前に大引けを過ぎていたため、昨日分の分析は対象外）
- `market_report_packets`: **0件**（Fact status・generation_calls・token・cost・market_direction・headline・claims・x_post いずれも該当なし）
- gate: **`x_enabled=false` / `app_enabled=false`**（`updated_at` は 2026-09-17 10:47 UTC、反映時のまま）
- 今朝の分析にかかった OpenAI 費用: **$0**

#### blocked の原因（Yahoo のデータ欠損）

- 07:50 の data packet の metrics:
  - `nikkei225`: `unavailable` / `gap_reason=expected_session_not_available`（期待セッション 2026-09-17）
  - `topix_proxy_1306`: 427.4（2026-09-17）fresh、`dow` 51,778.04 / `sp500` 7,637.76 / `nasdaq_composite` 26,418.30 / `sox` 11,599.49（いずれも 2026-09-17 の米国セッション）fresh、`usdjpy` 155.69 fresh、JGB 2本は 08-31 で stale、`wti` / `brent` は 09-15 fresh
  - 取得診断は Yahoo 6銘柄・MIC・ニュース参照すべて `ok`（通信は成功）。news_refs 30件
- 10:01 JST に Yahoo を read-only 確認したところ、**`^N225` の 2026-09-17 の日足は存在するが終値が `null`**（1306.T は 427.4 を返す）。実装は null の足を採用しない（推測値を入れない）ため `expected_session_not_available` になった
- 昨日 16:15 の大引け packet では同じ `^N225` 2026-09-17 が 64,136.25 で取得できていた。**Yahoo 側で後から終値が欠落した**形で、こちらの実装やロジックの変更が原因ではない

#### 影響と安全性の確認

- 必須 metric 欠落 → data packet は blocked で保存（診断用に履歴は残る）→ 分析は `data_not_ready` で何もしない、という fail-closed の連鎖が設計どおり動作
- gate OFF のため X朝刊・アプリ朝刊は従来どおり成功。ユーザー影響 0
- Cron は私の4本を含め変更なし（本反映後に増えた2本は他スロットの MIC equity-index evaluator。既存 Cron の md5 は全て同一）

#### 次タスク候補（本タスクでは実装しない）

1. **同一セッションの確定値の再利用**: 既に自前の `market_data_packets` に保存済みの同一 `session_date` の値（今回なら 9/17 大引け packet の日経平均 64,136.25、content_hash 付き）を、Yahoo が欠損した場合の代替として使う。出所を `provider=market_data_packet` などで明示し、推測値は入れないまま可用性を上げられる
2. **朝刊の必須項目の見直し**: 朝刊の方向判定は米指数で行っており、日本株の前営業日終値は文脈情報。朝刊では `nikkei225` を必須から外し（gap として明示）、大引けのみ必須にする案
3. **Yahoo 依存のリスク**: 同じ銘柄の同じ日の値が後から消えることが実データで確認された。DESIGN.md §14 の「取得元の見直し」の優先度を上げる材料
4. 16:20 の close 分析は本日が初回（本 Report 提出時点では未到達）

#### 状態

- consumer 切替は OFF のまま。本日 16:15 → 16:20 の大引けサイクルが、共通分析の初回生成の機会になる
- cutover（`x-test-post` / `personalized-reports` の deploy と gate ON）は、K1 が実際の shared packet を確認してからの別承認




## K1 review — 2026-09-18 (corrected)

**CONDITIONAL PASS FOR TODAY'S CLOSE VALIDATION / do not block on morning fallback.**

User priority:
- The user explicitly wants the shared market-report path validated **by today's 2026-09-18 close**, before the 5-day holiday.
- Therefore the morning Yahoo `^N225` null observation is **not** a reason to delay today's close validation or to insert a new fallback implementation before today's close.
- Do not spend the pre-close window implementing the morning fallback unless today's close path itself proves it is required.

Confirmed:
- Phase 2 implementation candidate, tests, disposable PostgreSQL proof, production shadow rollout, schema/RPC/RLS/ACL, runtime byte-compare, and analysis Cron are complete.
- Consumer gate remains OFF.
- Morning failure was fail-closed and user impact was 0.
- The next required evidence is today's natural close cycle.

### Immediate priority — today's close

Do not add a new pre-close feature. Preserve current production code/gates and observe:

1. 16:15 JST `market-report-data-packet-close`
   - must complete
   - required_missing=[]
   - capture data packet id/hash/quality
2. 16:20 JST `market-report-analysis-close`
   - must generate a `market_report_packet.v1`
   - Fact/local checks pass
   - capture report packet id/hash/content/cost
3. Review the generated shared packet content for factual consistency and usability.
4. If the close shared packet is good, return to K1 immediately with exact evidence so the consumer cutover decision can still be made before 17:00/17:15.
5. Do not enable `x_enabled` / `app_enabled` before K1 approval.
6. Do not deploy `x-test-post` / `personalized-reports` before K1 approval.
7. Do not implement morning Yahoo fallback before today's close unless the close path is blocked for the same reason and there is no other way to validate safely.

### If close succeeds

Set:
- status: review_required
- next_owner: chatgpt

Report:
- close data packet result
- close analysis packet result
- packet ids/hashes
- data_quality
- Fact/local validation
- X/app gate still OFF
- whether consumer cutover can safely proceed for 17:00 / 17:15

### If close fails

Return immediately with the exact blocker. Do not start a broad fallback redesign unless specifically approved.

### Morning Yahoo null follow-up

Treat the 2026-09-18 morning Yahoo `^N225` null issue as a **separate follow-up after today's close validation**. It remains important, but it must not displace the user's stated pre-holiday deadline.

## URGENT correction — preserve today's close schedules

This overrides any ambiguous interpretation of the previous K1 note.

**Do NOT cancel, unschedule, delete, disable, or alter today's existing Phase 1 / Phase 2 close schedules.**

Required production state before today's close:
- `market-report-data-packet-close` remains scheduled at **16:15 JST**.
- `market-report-analysis-close` remains scheduled at **16:20 JST**.
- `market-report-analysis-close-retry` remains scheduled at **16:35 JST**.
- Existing 17:00 X close and 17:15 app close schedules remain unchanged.
- Consumer gates remain OFF until K1 approval.

If any of the three market-report close Cron jobs above were canceled/disabled/removed during this G1 session:
1. Restore **only** the affected job(s) to the exact previously approved schedule/body/endpoint, using the same existing Vault secret-name reference pattern.
2. Do not create duplicate jobs.
3. Read back job name / schedule / active state / secret-free command and confirm exactly one active instance of each.
4. Do not change any other Cron, Function, gate, OAuth/Vault value, posting window, or consumer.
5. Complete restoration as soon as safely possible and before 16:15 JST, then stop active changes and wait for the natural close cycle.

Today's priority is natural close observation, not redesign.

## FINAL K1 OVERRIDE — 2026-09-18 close validation takes absolute priority

This section is the latest controlling instruction for G1 and **supersedes every earlier instruction in this TASK or another K1 room that says to implement/deploy the morning Yahoo fallback first or to block today's consumer cutover because of that fallback**.

The user's explicit priority is to validate the natural close path on **2026-09-18 before the 5-day holiday**, and, only if the evidence passes K1 review, leave enough time to decide a temporary same-day consumer cutover for the existing 17:00 X close and 17:15 app close runs.

### Preserve the current implementation

- Keep the current G1 implementation results, including commit `aecfa60`, intact. Do not revert, rewrite, or discard the same-session confirmed-value reuse code or its tests.
- The morning Yahoo fallback code may remain in source. **Do not do additional fallback design, implementation, production deploy, or validation before today's close unless K1 gives a new explicit instruction after the close evidence is collected.**
- The existence of the fallback source code is not a reason to delay or cancel today's close validation, provided it is not deployed in a way that changes today's approved production close path.
- Do not introduce any new pre-close feature or broad redesign.

### Required Cron state — preserve or narrowly restore only

Before the natural cycle, perform a read-only check that the following existing jobs are present, active, and scheduled as already approved:

1. `market-report-data-packet-close` — **16:15 JST**
2. `market-report-analysis-close` — **16:20 JST**
3. `market-report-analysis-close-retry` — **16:35 JST**
4. Existing X close job — **17:00 JST**
5. Existing app close job — **17:15 JST**

For all five jobs:

- deletion, disabling, time change, endpoint/body change, and duplicate creation are prohibited;
- if this G1 session already deleted or disabled a job, restore **only that affected job** to the exact previously approved schedule/body/endpoint and existing Vault secret-name reference pattern;
- after any required restoration, read back job name, schedule, active state, and a secret-free command summary, and confirm there is **exactly one active instance** of each job;
- once confirmed/restored, make no further Cron changes and wait for natural execution;
- do not touch any other Cron, Function, production setting, OAuth value, Vault value, posting window, or another slot's files/workstream.

### Natural close observation and K1 hand-back

Keep `x_enabled=false` and `app_enabled=false` while collecting evidence.

Observe the natural production runs read-only:

1. At 16:15, verify the close data packet is `completed`, has `required_missing=[]`, and record its packet id, content hash, session/trading date, and data quality.
2. At 16:20, verify the shared close analysis is `completed`, its local checks and Fact check passed, and record its report packet id, content hash, content summary, evidence consistency, generation calls/tokens/cost, and source data packet id/hash.
3. If 16:20 does not complete, observe the existing 16:35 retry without changing its schedule.
4. Review the shared packet for factual consistency and practical usability. Do not treat mere row creation as sufficient.
5. On success, immediately set this TASK to `review_required`, set `next_owner: chatgpt`, update the inline Report with exact evidence, commit/push the control-file update, and return to **K1 immediately**. The objective is to let K1 decide the temporary cutover before 17:00/17:15.
6. On failure, return to K1 immediately with the exact blocker and evidence. Do not begin a fallback redesign or production change on your own.

### Cutover boundary for today only

- Until K1 explicitly approves after reviewing the natural shared close packet, consumer gates must remain OFF and `x-test-post` / `personalized-reports` must not be deployed.
- After K1 approval only, deploy the already-reviewed consumer candidates as specifically authorized and enable the approved consumer gate(s) for today's 17:00 X close / 17:15 app close validation.
- Confirm X and app use the same approved shared report packet id/hash and verify their production results, Fact status, and content consistency.
- After the 17:00/17:15 production verification is complete—or immediately if the temporary cutover shows a problem—set both consumer gates back to **OFF** and read back the OFF state.
- Do not leave the temporary cutover enabled beyond today's verification.

### Explicitly deferred until after today's close verification

- Additional morning Yahoo fallback design or production deploy
- Any change that makes the fallback a prerequisite for today's close/cutover decision
- Any unrelated deploy or configuration change

`x-test-post` and `personalized-reports` remain deploy-prohibited until the post-close K1 approval described above. Existing work from other slots, OAuth, and Vault are out of scope and must not be touched.

### 2026-09-18 大引けの自然観測（read-only、K1 FINAL OVERRIDE 対応）

**結論: data packet と shared analysis は「completed / Fact passed」まで到達したが、生成本文に `change_pct` というフィールド名がそのまま出ており、このままX投稿・アプリ表示に使える品質ではない。よって cutover 可否は K1 判断を仰ぐ（gate は OFF のまま、consumer は未 deploy）。**

#### Cron 事前確認（read-only、変更なし）

| ジョブ | schedule | JST | active | 実体数 | endpoint / body |
|---|---|---|---|---|---|
| `market-report-data-packet-close` (29) | `15 7 * * 1-5` | 16:15 | true | 1 | `market-report-data-packet` / `{"mode":"close"}` |
| `market-report-analysis-close` (32) | `20 7 * * 1-5` | 16:20 | true | 1 | `market-report-analysis` / `{"mode":"close"}` |
| `market-report-analysis-close-retry` (33) | `35 7 * * 1-5` | 16:35 | true | 1 | 同上 |
| X大引け: `dispatch-scheduled-posts` (1) ＋ `close_report_settings` | `* * * * *` / window 16:58–17:02 (center 17:00) | 17:00 | true | 1 | `x-test-post` |
| `personalized-reports-close` (11) | `15 8 * * 1-5` | 17:15 | true | 1 | `personalized-reports` / `{"mode":"close"}` |

- 4本とも Vault の `send_push_notifications_cron_secret` を名前参照。削除・停止・時刻変更・重複はなく、本セッションでの復旧作業も不要だった
- consumer gate: `x_enabled=false` / `app_enabled=false`（`updated_at` 2026-09-17 10:47 UTC のまま）

#### 16:15 close data packet — 成功

- `market_report_cycles(close, 2026-09-18)`: `cycle_status=completed`、attempt 1、completed 16:15:02 JST
- data packet id `c64fa70b-7bd8-495c-b427-f3e9e4ae2523` / content_hash `a5f52800d1d1340d…` / `data_quality_status=partial`
- `required_missing=[]` / `stale=[jgb2y, jgb10y]` / `unavailable=[]` / `proxies=[topix_proxy_1306]`
- session: `jpx_session_date=2026-09-18` / `us_session_date=2026-09-17`、news_refs 30件
- 主な値: 日経平均 65,018.95（+1.38%、9/18、yahoo_chart）、TOPIX連動ETF（1306）426.3円（−0.26%、9/18）、NYダウ 51,778.04（+0.61%、9/17）、S&P500 7,637.76（+1.14%）、ナスダック総合 26,418.30（+1.69%）、SOX 11,599.49（+3.14%）、ドル円 155.69（9/17、Frankfurter）、US2Y 4.74 / US10Y 5.01（9/16、FRED）、WTI 107.02 / Brent 130.8（9/15、EIA）、JGB 2本は 8/31 で stale
- 再利用（`aecfa60`）は本番未 deploy のため未使用。今回の Yahoo 値は生値で取得できている

#### 16:20 shared analysis — 失敗（Fact 不合格）

- `report_status=failed`、attempt 1、16:20:01 開始、`report_last_error=ANALYSIS_FACT_FAILED`
- diagnostics: calls 4（生成2＋Fact2）、input 20,487 / output 3,851 tokens、cost $0.008719、direction `mixed`、metrics 13、news_items 15
- Fact の指摘: **「米国市場は9月17日、日経平均は9月18日であり、『同じ日に確認できます』は日付と不整合です。」**
- 原因: 生成プロンプトが `consistent_with` を「『〜と同じ日に〜』のように書く」と指示しているため、日本市場（9/18）と米国市場（9/17）でセッション日が異なる大引けでは、その言い回し自体が事実と食い違う。Fact チェックが正しく検出した

#### 16:35 retry — 成功（completed / Fact passed）

- `report_status=completed`、attempt 2、16:35:01 開始 → 16:35:34 完了、`report_last_error=null`
- report packet id `97e714c8-afa4-4af9-92d4-107fef897912` / content_hash `4deb4f9965738c96…` / source data packet `c64fa70b-…`（hash `a5f52800…`）
- calls 4（生成2＋Fact2）、input 20,327 / output 3,532 tokens、cost **$0.008304**、model `gpt-5.6-luna`
- `market_direction=mixed`（`direction_basis=[nikkei225, topix_proxy_1306]`）、claims 7、key_news 4、themes 強2/弱2、next_watch 3、risks 3、data_gaps 6

#### 内容レビュー（K1 指示4: 行ができただけでは不十分）

事実整合性（問題なし）:

- claims の数値は data packet と一致。evidence_refs はすべて実在の `metric:` / `news:`
- `causal` は0件、`consistent_with` 2件は日付を明記、`insufficient_evidence` 2件で理由不明を明示
- TOPIX連動ETF（1306）の表記は全箇所で正しい。1日分の値動きのみで複数日語なし

**投稿品質の問題（cutover の阻害要因）**:

1. **フィールド名 `change_pct` が本文に露出**。headline/summary/claims/X本文の計6か所で「change_pctは+1.38%」のように出ている。X投稿・アプリ表示としては不可
   - 例（X本文）: 「・日経平均は65,018.95、change_pctは+1.38%。」
   - ローカル検証に英字フィールド名の検出が無く（`personalized-reports` 側にはある `latinWords` 相当が analysis に未実装）、Fact も事実面のみ見るため通過した
2. **文体が注意書きの羅列**。「確認できません」「断定できません」が本文中4回。KABUMORI_VOICE を与えているが、証拠優先の指示が強すぎて読み物になっていない
3. **`weak_themes` の誤用**。「日経平均とTOPIX連動ETF（1306）の方向差」「日銀決定発表後の上昇報道」は弱かったテーマではない
4. **当日の最重要材料の扱いが弱い**。key_news には日銀の政策金利 1.00%→1.25% 引き上げが入っているのに、X本文では「因果は断定できません」という留保だけで、利上げそのものを伝えていない

実際に投稿されるX本文（gate ON の場合、コードで整形される内容）:

```text
【大引け】きょうの日本株まとめ🌙
日経平均は上がりましたが、TOPIX連動ETF（1306）は下落でした。📊

📌 今日の3ポイント
・日経平均は65,018.95、change_pctは+1.38%。
・TOPIX連動ETF（1306）は426.3円、change_pctは−0.26%。
・日銀決定発表後の上昇は報じられていますが、因果は断定できません。

💬 9月17日の米国株高もありましたが、9月18日の日本市場との関係は確認できません。
```

#### 判断と K1 への確認事項

- 技術経路（data packet → shared analysis → 1 cycle 1 packet、Fact、費用記録、lineage）は**本番で初めて通し確認できた**
- 一方で、本文品質は上記1〜4のため、**本日17:00のX大引けに使うことは推奨しない**（特にフィールド名の露出）
- 私の判断で修正・再生成・deploy・gate ON は行っていない。`x-test-post` / `personalized-reports` 未 deploy、gate は OFF のまま
- K1 判断を仰ぐ選択肢:
  1. 本日は cutover せず（gate OFF のまま）、X・アプリは従来経路で 17:00 / 17:15 を実行。連休明けまでに (a) ローカル検証へ英字フィールド名・記号の禁止を追加、(b) `consistent_with` の言い回し指示を日付差に対応、(c) 文体と `weak_themes` の指示見直し、(d) 重要材料（金融政策など）の優先表示、を実装して再検証
  2. 品質問題を許容して本日だけ cutover（非推奨。X は公開投稿で、フィールド名露出がそのまま出る）
- 今日の16:20失敗分（$0.0087）と16:35成功分（$0.0083）を合わせた本日の analysis 費用は **$0.0170**

#### production changes（本観測分）

- **0**。read-only SQL のみ。deploy・migration・Cron 変更・gate 変更・手動 invoke・X 投稿・Push いずれも行っていない


## K1 review — 2026-09-18 close natural evidence

**Result: NOT PASS / follow-up required before consumer cutover.**

The production shadow path itself is proven:
- 16:15 close data packet completed with required_missing=[]
- 16:20 analysis failed Fact on cross-session-date wording
- 16:35 retry completed and Fact passed
- immutable lineage / packet ids / hashes / token+cost recording all worked
- existing consumers stayed untouched and gate remained OFF

However, the generated consumer-facing content is not acceptable yet:
1. internal field name `change_pct` leaked into headline/summary/claims/X text
2. prose is overly defensive/repetitive ("確認できません" / "断定できません")
3. `weak_themes` is semantically misused
4. the day's major policy event (BOJ rate hike) is under-prioritized in the X summary
5. the 16:20 first attempt exposed a prompt bug around `consistent_with` wording across JP/US session dates

### Required follow-up

Implement and test only the following before another cutover review:

1. **Internal-field leakage guard**
   - Reject consumer-facing output containing internal schema/field identifiers such as `change_pct`, `session_date`, snake_case field names, or similar implementation vocabulary.
   - Apply in shared analysis local validation, not only downstream UI/X.

2. **Cross-session date-safe wording**
   - Remove the prompt pattern that suggests "同じ日に" for `consistent_with`.
   - Require explicit dates/session labels when comparing JP and US markets from different trading dates.
   - Add a regression test reproducing the 2026-09-18 Fact failure.

3. **Theme semantics**
   - `strong_themes` / `weak_themes` must be actual market themes/sectors supported by evidence, not index divergence, article headlines, or generic observations.
   - If evidence is insufficient, return empty arrays rather than fabricate a theme.

4. **Major-material prioritization**
   - High-importance policy/macro events present in verified `key_news` (e.g. BOJ/FOMC/FX intervention) must be surfaced in the X/app market summary when relevant.
   - This must not convert correlation into unsupported causality; it may say the event occurred and separately qualify causal certainty.

5. **Prose quality**
   - Reduce repetitive disclaimers while preserving epistemic safety.
   - Prefer one concise uncertainty qualifier over repeated "確認できません/断定できません".
   - Keep X output readable Japanese with no internal implementation vocabulary.

6. **Regression**
   - Re-run market-report-analysis, x-test-post, personalized-reports, Phase 1 suites and `git diff --check`.
   - No production deploy, gate change, manual X post, manual Push, Cron change, OAuth/Vault change, or migration-history repair in this follow-up.

### Cutover boundary

- `x_enabled=false` / `app_enabled=false` must remain OFF.
- `x-test-post` / `personalized-reports` remain production-deploy prohibited until the next K1 PASS.
- The morning Yahoo fallback source (`aecfa60`) may remain in source but is not part of this review and must not be deployed as part of this follow-up.
- After fixes/tests, set status to `review_required`, next_owner to `chatgpt`, append exact test evidence and sample generated X/app text, then stop for K1.

### Content quality follow-up（K1 review 2026-09-18 close 対応、source のみ）

- 本番変更 **0**（deploy・migration・Cron・gate・手動 X 投稿・Push・OAuth/Vault・履歴修復なし）。gate は `x_enabled=false` / `app_enabled=false` のまま。`x-test-post` / `personalized-reports` は未 deploy。`aecfa60`（朝刊 fallback）は source に残し deploy していない
- 変更は `supabase/functions/market-report-analysis/` のみ（`analysis_input.ts` / `analysis_logic.ts` / 新規 `quality_test.ts` / 9/18 fixture 3件）

#### 1. 内部項目名の混入防止

- 根本原因: モデル入力のキーが英語（`change_pct` / `session_date` 等）で、モデルがそれを本文に写した
- 対策A（入力）: モデル入力のキーを日本語に変更（`指標[].名称/日付/値/前日比/鮮度`、`ニュース[].見出し/要約/重要材料/企業` など）。英字キーは `ref` のみ。方向も `上昇/下落/まちまち/ほぼ横ばい/判断できず` の日本語で渡す
- 対策B（検証）: 共有分析のローカル検証に `INTERNAL_FIELD` を追加。snake_case 識別子、`metric:` / `news:` の ref 文字列、`freshness` / `claim_type` / `market_direction` などの実装語が本文（見出し・要約・claims・key_news・テーマ・注目点・リスク・X本文）にあれば不合格
- プロンプトにも「キー名・ref・英字の項目名を本文に書かない。前日比は『（前日比+1.38%）』のように書く」を明記

#### 2. 日付の異なる市場の言い回し

- `consistent_with` の説明から「『〜と同じ日に〜』のように書く」を削除
- 日付の違う市場を並べるときは各日付を明記し「同じ日」「同日」と書かない指示を追加。モデル入力に `日付の注意`（例: 東京 9月18日 / 米国 9月17日）を渡す
- ローカル検証: 東京と米国のセッション日付が異なる packet で本文に「同じ日」「同日」があれば不合格（同じ日付の場合は許可）

#### 3. テーマの意味

- 指示: `strong_themes` / `weak_themes` は根拠のある業種・テーマのみ。指数名・指数の方向差・ニュース見出し・一般的観察は不可、根拠不足なら空配列
- ローカル検証: テーマ名に指数名・「指数」「方向差」「乖離」「報道」「発表後」を含むと不合格。テーマが参照する claim の根拠にニュースまたは SOX が無いと不合格

#### 4. 重要材料の優先

- 検証済みニュースのうち `coverage_categories` に `monetary_policy` を含むもの、または severity が emergency / critical のものを「重要材料」とし、モデル入力で先頭に並べ `重要材料: true` を付与
- 指示: 重要材料がある場合、その出来事自体を要約と X 本文に入れる。因果は、ニュースが理由として書いていない限り断定せず、出来事と確度を分けて書く
- ローカル検証: 重要材料が `key_news` に無い、または重要材料のキーワード（日銀・FRB・FOMC・ECB・政策金利・利上げ・利下げ・為替介入・金融政策のうち該当するもの）が X 本文・要約に無いと不合格
- 9/18 の実データでは BOJ 利上げ（`news:cafc0f82-…`、severity high / `monetary_policy`）が重要材料として検出され、キーワードは `日銀`・`政策金利`

#### 5. 文章の質

- 指示: 不確実性の注記は要約・X本文それぞれ1回まで、`insufficient_evidence` は1件にまとめる
- ローカル検証: X本文・要約で「確認できません/断定できません」などが2回以上、または `insufficient_evidence` が2件以上で不合格

#### 回帰テスト（本番の実データで再現）

- `quality_test.ts` **8/8 PASS**:
  - モデル入力の英字キーが `ref` のみで、`change_pct` / `session_date` が入力に存在しない
  - 9/18: セッション日付の違いを検出、BOJ が重要材料として先頭、`日付の注意` を付与
  - プロンプトから旧「同じ日に」パターンが消え、日付明記・重要材料・空テーマの指示がある
  - **16:20 の Fact 不合格の再現**: 9/17 米国と 9/18 東京を「同じ日に」と書いた claim がローカル検証で不合格になる
  - **16:35 に Fact を通過した実際の packet を再検証すると、K1 指摘すべてで不合格になる**: `change_pct` 混入、X本文の注記重複、`insufficient_evidence` 複数、非テーマ3件（「日経平均の上昇」「日経平均とTOPIX連動ETF（1306）の方向差」「日銀決定発表後の上昇報道」）、要約に重要材料（日銀・政策金利）が無い
  - 日付を明記し BOJ を前面に出した分析は合格し、X 本文も形式チェックを通る
  - 各ルールの単独検出（`session_date`、`metric:`、注記重複（X・要約）、重要材料の key_news 欠落・X 欠落、根拠の無いテーマ）
  - 日付が同じ朝刊セッションでは「同じ日」判定が働かない
- 既存を含む全体: `market-report-analysis` **21/21**、`market-report-data-packet` **42/42**、`personalized-reports` **28/28**、`x-test-post` **394/394**、`deno check`（analysis）PASS、`git diff --check` PASS

#### 見本（手書きの適合 fixture から既存フォーマッタで整形。モデル出力ではない）

X本文（gate ON 時に投稿される形）:

```text
【大引け】きょうの日本株まとめ🌙
日銀が政策金利を1.25%へ引き上げた日、日経平均は+1.38%でした📈

📌 今日の3ポイント
・日銀が政策金利を1.00%→1.25%に
・日経平均65,018.95、前日比+1.38%
・TOPIX連動ETF（1306）は−0.26%で逆方向

💬 利上げと値動きの因果ははっきりしないので、次の取引日の銀行株の反応も見たいです

#日本株 #日経平均 #株式投資 #かぶモリ
```

アプリ「今日の市場全体」:

```text
日銀が政策金利を1.25%へ、日経平均は+1.38%
9月18日は日銀が政策金利を1.00%から1.25%へ引き上げました。東京市場では日経平均が65,018.95（前日比+1.38%）と上げた一方、TOPIX連動ETF（1306）は426.3円（前日比−0.26%）で、指数によって方向が分かれました。利上げと値動きの因果はニュースでは明記されていません。
・日銀が政策金利を1.00%から1.25%へ引き上げました。
・日経平均は65,018.95（前日比+1.38%）、TOPIX連動ETF（1306）は426.3円（前日比−0.26%）でした。
・日銀の決定発表後に日経225が上昇したと報じられていますが、利上げとの因果関係はニュースでは明記されていません。（同日に確認）
・9月17日の米国市場ではSOXが前日比+3.14%でした。9月18日の東京市場への影響は、それぞれ日付が異なるため参考情報です。（同日に確認）
・利上げ後の銀行株や不動産株の反応は、次の取引日も確認したい点です。（注目点）
注目: 利上げ後の銀行株・不動産株の反応
```

（アプリでは claim_type を「報道で確認 / 同日に確認 / 理由は未確認 / 値動き / 注目点」の日本語ラベルで表示）

#### 残るリスク

- 実モデルがこの新しい指示・検証で合格する率は、本番の shadow 実行でしか確認できない。検証を厳しくしたため、初回は不合格→再生成が増える可能性がある（上限は生成2回×試行3回）
- 重要材料の判定は `monetary_policy` カテゴリと emergency/critical に限定。為替介入などが別カテゴリで入った場合はキーワードだけでは拾えない
- アプリの claim ラベル「同日に確認」は `consistent_with` の既存表示名。日付が異なる claim にも付くため、UI 側で「同時期に確認」へ変える案は別判断（今回は source 変更対象外）

#### 次の推奨

- K1 PASS 後、`market-report-analysis` のみ再 deploy（byte 比較・他 Function 不変確認）し、連休明け最初の自然サイクル（2026-09-24 07:55 / 16:20）で shared packet の品質を観測
- 品質を確認できた後に、consumer cutover（`x-test-post` / `personalized-reports` deploy と gate ON）を改めて判断


## K1 review — 2026-09-18 content-quality follow-up

**Result: NOT PASS / one narrow consumer-label blocker remains.**

The source-only analysis fixes are accepted:
- internal-field leakage guard is implemented;
- cross-session "同じ日/同日" generation is locally rejected when Tokyo/US session dates differ;
- theme semantics and major-material prioritization were tightened;
- disclaimer repetition is constrained;
- regression evidence is sufficient (analysis 21/21, Phase1 42/42, personalized 28/28, X 394/394, deno check and diff check pass);
- no production changes were made.

However, the supplied app sample still renders the existing `consistent_with` UI label **「同日に確認」** on a claim that explicitly compares **9月17日の米国市場** with **9月18日の東京市場**. That is user-facing and semantically contradicts the date-safe requirement even though the generated prose itself is now correct.

### Required narrow follow-up only

1. Change the consumer-facing Japanese label for `consistent_with` from **「同日に確認」** to a date-neutral label that remains truthful across different sessions, preferably **「同時期に確認」**.
2. Apply the mapping consistently anywhere the app/shared report UI renders that claim type. Do not alter causal logic or evidence semantics.
3. Add/adjust a regression test proving a 9/17 US vs 9/18 JP claim does not render 「同日に確認」.
4. Re-run only the affected consumer tests plus the existing shared-analysis regression needed to prove compatibility, and `git diff --check`.
5. Source only. No deploy, migration, Cron, gate, X post, Push, OAuth/Vault, or migration-history change.
6. Keep `x_enabled=false` / `app_enabled=false`; consumers remain deploy-prohibited.
7. Then set status `review_required`, next_owner `chatgpt`, append exact changed files/tests/sample app line, and stop for K1.

Do not broaden this follow-up. The analysis-quality work in commit `8dbdfbe` is otherwise accepted.
