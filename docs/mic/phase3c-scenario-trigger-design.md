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
equity_index 6.0 s / macro 6.9 s で、21:15:09 までに全件完了した（AI呼び出しを含む
`evaluated` の場合でも10秒未満）。`no_change` は0.1 s前後。

State evaluatorのFRED系jobは、直前のFRED ingestが `completed` のときだけ起動する（ingest
失敗時はStateもScenarioも動かない＝影響が広がらない）。

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
| Production risk | 低（jobはsecretが無ければ何もしない） | 中〜高（State evaluatorを変更） | 高（State table/RPCに近い変更。State schema変更禁止に抵触しやすい） |

**採用: A（独立Cron）。** 実データ上の決め手は次の3点。

1. Stateは domain 別の独立jobが同時刻に並列で更新する。B/Cは「最後のdomainが終わった時点」
   を知る調整機構が要り、無ければ半端な組でScenarioを作りにいく。Aは全domainが終わって
   から一度だけ見に行く。
2. Scenario evaluatorには既に決定的な no_change 判定（新しいState run が無ければAI 0回）が
   ある。Cron頻度を上げても費用は増えず、遅れたStateも次slotで回収できる。
3. State評価・Scenario評価の失敗が互いに影響しない（fail-safe）。

## 4. 提案スケジュール

各State slotの10分後（:25）。State側のslot変更に追随できるよう、テストがmigrationから
State evaluator jobを読み取って対応を機械検証する（`supabase/tests/mic_scenario_phase3c_cron_test.ts`）。

| Scenario job | schedule (UTC) | 対応するState slot |
| --- | --- | --- |
| `mic-scenario-after-state-0100` | `25 1 * * 2-6` | 01:15 火〜土（rates/macro/equity_index） |
| `mic-scenario-after-state-weekday` | `25 6,9,21,22 * * 1-5` | 06:15・09:15（rates）、21:15（3 domain）、22:15（macro） |

- 起動回数: 1日最大5回（月4 / 火〜金5 / 土1 / 日0）、週25回。
- :25 の根拠: 実測バッチが10秒未満で完了。10分の余裕で、遅延したevaluatorの取りこぼしにも耐える。
- 半端な組を拾っても安全: RPCが全source Stateを再検証し、変わっていれば
  `STATE_CHANGED_DURING_EVALUATION` でfail closed。次slotで組み直す。
- 12時間の空きがある（09:25→21:25）が、その間はStateの更新機会自体が無い。

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
- **クラッシュ**: 15分以上runningのrunは次の起動の冒頭で `failed` に閉じられ、その起動が続行する。
- **State変化（評価中）**: fail closed。currentは不変、usageは残る。次slotで再生成（再試行1回分のAI費用が発生）。
- **Scenario失敗**: State行・ingestに一切書かない（テストで確認）。currentは旧値のまま、
  Phase 3B gateが `invalid` / `expired` を返す。次slotで再試行。
- **State evaluator / FRED ingest失敗**: State側jobが起動しないだけで、Scenario slotは
  no_changeで終わる（新runが無いので）。

## 7. コスト見積り

- Cron起動: 最大5回/日（平均約3.6回/日）。no_changeはAI 0回。
- AI呼び出し: 起動ごとに最大2回（Luna + 条件付きSol）、理論上限は10回/日。
  ただし実際にはState評価が `evaluated` になったバッチ（Productionでは数日に1回程度）でのみ呼ばれる。
- 単価（Phase 3Aのsmoke実測 2172 in / 1222 out トークン）: Luna 約 $0.0019、Sol 約 $0.048。
  理論上限 約 $0.25/日、現実的には 数円/日 未満。
- Solへ上げる条件: 入力Stateの品質上限が 0.6 以上 かつ（Lunaが `needs_sol` を返す か confidence < 0.5）。

## 8. 適用手順（Production TASKで別承認のうえ実施）

1. 承認後に `20260930090000_mic_scenario_automation_cron_phase3c.sql` を単体適用
   （`supabase db query --linked -f`）。jobsはsecretが無い間は何も送らないので、先に適用して安全。
2. **secret**: Phase 3Aで設定した `MIC_SCENARIO_EVALUATOR_CRON_SECRET` の値は、生成時に記録せず
   取り出せない。新しい値を生成し、Edge secret とVault secret
   `mic_scenario_evaluator_cron_secret` に**同じ値**を設定する（値は表示しない）。
   Edge secretを更新するとdeploy済みfunctionのversionが進む点に注意。
3. 最初の自然slotで観測（read-only）: run が `evaluated`、Phase 3B gate が `usable` / `degraded`。
4. 手動invokeは不要（不安な場合のみ、別承認で1回）。

## 9. 残る課題

- **静かな相場での失効**: State の narrative は「重要な変化」のときしか書き換わらない。市場が静かで
  96時間（macroは35日）更新されないと、Scenario入力のStateがstale化して使えなくなり、Scenarioは
  `expired`、再生成もできない（`insufficient_usable_states`）。これはScenarioトリガーでは解決せず、
  State層の定期リフレッシュ方針（Scenarioの入力として最低限の鮮度を保つ）が別途必要。
- domain別のfetch status / partial success は未対応（FRED reliabilityの残課題）。
- `trigger_type` の記録ミス（cronが `manual` と記録される）は別件。
- consumer接続は別Phase（利用直前の再検証、degraded表示の設計が前提）。
