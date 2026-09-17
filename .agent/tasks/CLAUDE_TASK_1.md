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
