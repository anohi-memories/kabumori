# MIC Phase 3C — Scenario 自動再生成トリガー設計（source-only）

状態: **source-only候補**。Production変更（Cron作成、deploy、migration適用、secret作成、invoke）は行っていない。
consumer_ready: **false**（consumerは未接続）。

## 1. 背景

Phase 3A/3B後のProductionでは、State（rates / macro / equity_index）が更新されると、
現行ScenarioはPhase 3B gateで `invalid`（`state_identity_drift`）になる。これは設計どおりの
fail-closed挙動で、Scenarioを作り直すまで本文は返らない。Scenario evaluatorには起動元が
まだ無い（Cronなし・State evaluatorからの呼び出しなし）。

## 2. Productionの実スケジュール（read-only調査、2026-09-30 00:14 UTC）

Scenarioの入力3 domainを更新し得るState evaluatorは次のとおり（すべて :15 起動）。

| State evaluator job | 起動 | domain |
| --- | --- | --- |
| `mic-evaluator-{rates,macro,equity-index}-after-fred-0100` | 01:15 火〜土 | rates / macro / equity_index |
| `mic-evaluator-rates-after-mof-jgb-0600` | 06:15 月〜金 | rates |
| `mic-evaluator-rates-after-mof-jgb-0900` | 09:15 月〜金 | rates |
| `mic-evaluator-{rates,macro,equity-index}-after-fred-2100` | 21:15 月〜金 | rates / macro / equity_index |
| `mic-evaluator-macro-after-estat` | 22:15 月〜金 | macro |

（commodities / fx のevaluatorはScenario入力ではない。）

各State evaluator jobは1 domainずつ別のCron jobで、同じ分に**並列**の別HTTP起動になる。
21:15 UTCの実バッチ（2026-09-29）は、3 domain とも 21:15:02 開始、所要 rates 4.7 s /
equity_index 6.0 s / macro 6.9 s で、21:15:09 までに全件完了した。直近14日の
21:15開始runでも対象3 domainの各最大は4.7 / 6.0 / 6.9秒だったが、母数は順に
4 / 3 / 2 runと小さい。10分完了を保証する値ではない。

State evaluatorのFRED系jobは、直前のFRED ingestが `completed` のときだけ起動する。
ingestが失敗しても独立Scenario Cronは起動するが、State run IDが不変なら `no_change` / AI 0となる。

## 3. トリガー方式の比較

| 観点 | A. 独立Scenario Cron | B. State evaluator完了後に直接invoke | C. DB event / queue / trigger |
| --- | --- | --- | --- |
| 結合度 | なし（Scenario側だけ） | 強い（State evaluatorがScenarioを知る） | 中（DBがEdge Functionを知る） |
| 障害分離 | 完全。片方の失敗が他方に波及しない | State runの所要・成否がScenario障害に引きずられ得る | trigger/queue障害がState書き込みに近い所で起きる |
| retry | 次のslotで自然に再試行 | 自前のretryが必要 | queueの再送設計が必要 |
| 重複起動 | 1日≦5回。claim（1 running）＋fingerprint一意で防止 | domain別3 jobが各々起動 → 同時3起動。claimで直列化されるが中途半端な組を拾いやすい | domainごとにtriggerが発火 → 同様 |
| AIコスト | no_changeなら0（Cron回数に依存しない） | 中途半端な組で無駄な生成＋RPCのfail-closedで捨てる恐れ | 同左 |
| latency | State更新から+10分 | ほぼ即時 | ほぼ即時 |
| 観測性 | `mic_scenario_evaluation_runs` に全起動が残る（no_changeも） | State evaluatorのログに混ざる | 追跡が難しい |
| deploy複雑度 | migration 1本（Cron 2件） | State evaluatorの改修＋deploy（稼働中のState経路を変更） | migration（State側objectに触れる）＋Edge |
| Production risk | migration履歴とsecret移行を事前に解決すれば低め。secret無しなら送信しない | 中〜高（State evaluatorを変更） | 高（State table/RPCに近い変更。State schema変更禁止に抵触しやすい） |

**採用: A（独立Cron）。** 実データ上の決め手は次の3点。

1. Stateは domain 別の独立jobが同時刻に並列で更新する。B/Cは「最後のdomainが終わった時点」
   を知る調整機構が要り、無ければ半端な組でScenarioを作りにいく。Aは全domainが終わって
   から一度だけ見に行く可能性が高い（10分内の完了は保証せず、遅延時は次slotで回収する）。
2. Scenario evaluatorには既に決定的な no_change 判定（新しいState run が無ければAI 0回）が
   ある。状態が不変の間はCron回数を増やしてもモデル費用は増えない。State更新後には次slotで再評価する。
3. State評価・Scenario評価の失敗が互いに影響しない（fail-safe）。

## 4. 提案スケジュール

各State slotの10分後（:25）。State側のslot変更に追随できるよう、テストがmigrationから
State evaluator jobを読み取って対応を機械検証する（`supabase/tests/mic_scenario_phase3c_cron_test.ts`）。

| Scenario job | schedule (UTC) | 対応するState slot |
| --- | --- | --- |
| `mic-scenario-after-state-0100` | `25 1 * * 2-6` | 01:15 火〜土（rates/macro/equity_index） |
| `mic-scenario-after-state-weekday` | `25 6,9,21,22 * * 1-5` | 06:15・09:15（rates）、21:15（3 domain）、22:15（macro） |

- 起動回数: 1日最大5回（月4 / 火〜金5 / 土1 / 日0）、週25回。
- :25 の根拠: 2026-09-29 21:15 UTCの実測バッチは10秒未満。ただし少数サンプルであり、
  10分以内の完了保証ではない。遅延が10分を超えた場合は次slotで回収する。遅延・失敗の監視が必要。
- 半端な組を拾った場合: AI中にStateが変わればRPCがfail closedし、AI費用だけ残る。RPC完了後に
  残りのStateが変われば一時的なScenarioを作る可能性があるが、Phase 3B read gateはidentity driftで
  本文を返さず、次slotで再評価する。
- 12時間の空きがある（09:25→21:25）が、その間に**定期Cron上の**対象State更新枠は無い。
  手動invokeや予定外のState更新は次のScenario slotまで待つ。

## 5. 起動が来たときのScenario evaluatorの挙動（既存契約の再確認）

| 状況 | 結果 | AI |
| --- | --- | --- |
| 使えるStateが2未満 | `no_change: insufficient_usable_states` | 0 |
| source State run id が現行Scenarioと同じ | `no_change: no_new_state_evaluation` | 0 |
| 品質/statusだけの更新（run id同じ） | `no_change` | 0 |
| 新しい State evaluation run がある | 生成（Luna。条件を満たすときのみSol） | 1（Sol時 +1） |

`scenario_trigger_test.ts` で、Cronを200回繰り返してもAIが1回のままであること、1日5回の起動でも
AIはState更新バッチの数だけ呼ばれることを検証した。

## 6. Overlap / 障害時

- **重複起動**: `mic_scenario_runs_one_running_uidx`（running は1つ）により、2つ目の起動は
  claimで409となり `skipped_duplicate`（AI 0回）。fingerprintの一意制約で、同じState集合から
  evaluatedなScenarioが2つ出来ることもない。起動間隔は最短1時間（21:25→22:25）で、通常は重ならない。
- **クラッシュ/長時間実行**: 15分以上runningのrunは次の起動の冒頭で `failed` に閉じられる。
  Edge側モデル呼び出しは通常45秒timeout/回で、実Cronは最短1時間間隔。ただし15分を超えて
  元実行がなお生存する異常時には、stale処理後の新runと並行し得る。AI開始前の一意claim、
  AI後のCAS/fingerprintを別々の防護として扱い、後者は費用を回収しない。
- **State変化（評価中）**: fail closed。currentは不変、usageは残る。次slotで再生成（再試行1回分のAI費用が発生）。
- **Scenario失敗**: State行・ingestに一切書かない（テストで確認）。currentは旧値のまま。
  新しいStateへ移っていればPhase 3B gateは `invalid`、期限を過ぎれば `expired`。
  旧Stateと期限がまだ有効なら `usable` / `degraded` のままの場合もある。次slotで再試行。
- **State evaluator / FRED ingest失敗**: Scenario slot自体は起動する。source run IDが不変なら
  no_change / AI 0。旧Scenarioはread gateで期限切れになり得る。

## 7. コスト見積り

- Cron起動: 最大5回/日（平均約3.6回/日）。no_changeはAI 0回。
- AI呼び出し: 起動ごとに最大2回（Luna + 条件付きSol）、理論上限は10 model calls/日。
  生成数は最大5 Scenario/日。2026-09-16〜30 UTCのread-only実績では、対象3 domainの
  State `evaluated` は複数日（14日中9日、計17 run）に発生した。「数日に1回」は実測と合わず、
  Scenario生成頻度をこのデータだけで予測できない。rollout後はrun/usageから実測する。
- 単価（Phase 3Aのsmoke実測 2172 in / 1222 out トークン）: Luna 約 $0.0019、Sol 約 $0.048。
  5 slot全てがLuna+Solへ進む保守的上限は約 $0.25/日（そのトークン量と単価が続く場合）。
  実費はusage ledgerでモデル別に確認し、未観測の平常時費用を断定しない。
- Solへ上げる条件: 入力Stateの品質上限が 0.6 以上 かつ（Lunaが `needs_sol` を返す か confidence < 0.5）。

## 8. 適用手順（Production TASKで別承認のうえ実施）

1. **先にmigration履歴を別作業で整合**。2026-09-30のread-only照会と
   `supabase migration list --project-ref ...` では、source 100ファイル・remote history 58件のうち
   一致31、local-only 69、remote-only 27。remote最終記録は `20260924024406`。
   Phase 3A `20260928120000` と日次tip `20260928123000` の実体はあるがhistoryは未記録で、
   他にも多数の未記録候補がある。
   2本だけを盲目的にrepairしない。source全migrationとremoteの実体を棚卸しする。
   現行mainには `20260922090000` のファイルが2本（Fed event type / macro Phase 1A）あり、
   このversion衝突も別途解消する。個別に実体が一致するもののみ別承認でhistoryを整える。過去SQLの再実行や
   `db push` をhistory代わりにしない。
2. **secretを先に準備**: 既存Edge secret値は表示・比較できないため、専用の新しい値を生成する。
   Edge `MIC_SCENARIO_EVALUATOR_CRON_SECRET` を更新し、同じ値のVault secret
   `mic_scenario_evaluator_cron_secret` を**1件だけ**作成する。この時点ではScenario Cronが0件なので、
   伝播時間中にも旧/不一致secretの自動HTTPリクエストは発生しない。旧secretを使う外部callerの有無は
   rotation前に別途確認する。Supabase公式docsではsecret更新は即時有効で再deploy不要。
   function version増分は保証として扱わない。
3. 履歴・secret準備後、別承認で本migrationを単体適用。直前に同名Cron 0件、
   既存Cron fingerprint、Vault該当名1件、Edge secret存在を再確認。設定不一致の同名jobは
   fail closed。secretが無ければHTTP送信しないが、最終migration適用をactivation gateにすると
   移行途中のunauthorizedリクエストを避けやすい。
4. 最初の自然slotでread-only観測: `evaluated` または正当な `no_change`、
   source State ID、evidence、usage、valid_until、Phase 3B gateを照合する。
   手動invokeは原則不要で、別承認なしに実行しない。

`pg_net` は送信待ちのHTTP headerを `net.http_request_queue` に一時保存する。
2026-09-30のProduction権限メタデータでは同表にanon/authenticated SELECTとnet USAGEがあるが、
Supabase公式docsによれば通常は `net` がData API非公開かつ両roleがNOLOGINなので、
この権限表示だけで一般ユーザーからの可読性は成立しない。独自のData API exposed schema設定や
権限委譲RPCが無いことをrollout前に確認する。migrationはsecret値をSQL本文・Cron commandへ
hardcodeしないが、送信待ちqueueのheaderには実値が短時間存在する設計である。

disposable DB手順: Supabase Postgres image上の`postgres` DBにpg_cron/pg_net/Vaultを用意し、
Unix socketと `PGOPTIONS='-c mic_phase3c.disposable=yes'` の両方を要求する
`supabase/tests/mic_scenario_phase3c_db_fixture.sql` をmigrationより**前**に適用する。
これはlocal pg_netを送信しないrecorderへ置換する。migrationを2回適用後、
`supabase/tests/mic_scenario_phase3c_db_behavior.sql` でsecret 0/1件、body/header/timeoutを検証する。
同名schedule/command衝突はdisposable DBでのみ作り、再適用が例外になり既存jobを上書きしないことを確認する。

## 9. 残る課題

- **静かな相場での失効**: State の narrative は「重要な変化」のときしか書き換わらない。市場が静かで
  96時間（macroは35日）更新されないと、Scenario入力のStateがstale化して使えなくなり、Scenarioは
  `expired`、再生成もできない（`insufficient_usable_states`）。これはScenarioトリガーでは解決せず、
  State層の定期リフレッシュ方針（Scenarioの入力として最低限の鮮度を保つ）が別途必要。
- domain別のfetch status / partial success は未対応（FRED reliabilityの残課題）。
- `trigger_type` の記録ミス（cronが `manual` と記録される）は別件。
- consumer接続は別Phase（利用直前の再検証、degraded表示の設計が前提）。
