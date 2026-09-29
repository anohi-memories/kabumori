# MIC Phase 3B — source-only Production前レビュー

## 結論

- review_result: **REVIEW_REQUIRED**。source-only修正・検証は完了。依頼の「途中更新があるすべてのケースで本文を返さない」を最新-at-return保証として読む場合、P1の整合性契約が1点未解決。
- candidate: `ecfab7a9a76e787ace3405f600871c1f52bcec11`
- review branch: `codex/mic-phase3b-read-gate-review-20260929`
- start fresh main: `a03fefc771e76f5bb53c5f54968fbffb269a0db8`
- push前 fresh main: `0f90c8a38cb16baf38790978f7861e892521e170`。対象Scenarioファイルにcandidate親以降の変更なし。
- production_ready_read_gate: **false（厳密な応答時点保証が要求される間）**。point-in-time/optimistic validationという契約なら修正済みsourceは利用候補。
- consumer_ready: **false**。consumerは未接続。キャッシュ、利用・公開時の再検証、degraded表示の契約は別工程。
- Production changes=0、AI calls=0、deploy=0、invoke=0、secret changes=0、Cron changes=0、main merge=0。
- Productionアクセスはmigration collisionのcatalog/history SELECTのみ。service keyの取得・表示なし。

## Findings / severity / fixes

| ID | severity | 問題 | 対応 |
|---|---|---|---|
| F1 | P1 | 4 GETだけでは、新Scenarioが途中でcommitしても旧current/run/evidenceの自己整合が残り、古い本文を返す。元コメントの「必ずidentity mismatch」は誤り | current/Stateを前後2回読む6 GETへ。内容とupdated_atを比較し、差異・version欠損でinvalid/read_race_detected、本文なし。順序差は許容 |
| F2 | P1 remaining | 最後のState読取後、最後のcurrent読取前にStateだけがcommitする場合、変更を観測できない | unit + 実DBテストで明示再現。同期snapshot/最新-at-return/consumer利用時の契約判断が必要。解決済み扱いにしない |
| F3 | P2 | same run + same ai_evaluated_atなら、narrative/factors/risks/ai_confidenceが変わっていても使える | 生成時Evidenceの5フィールドと比較。違えばstate_content_drift。全く同じ再保存は有効、品質だけの変化は動的評価 |
| F4 | P2 | Evidenceの本文・配列・ai_confidence型を未検証。scenario_run_id欠損を許容、enumの`in`はprototype名も許容、fingerprint prefix未検証 | exact11項目、文字列配列、finite/range、own enum、必須run ID、current.prompt_version込みのfingerprintを検証。生成時freshness/usabilityとstate_as_ofも再構築 |
| F5 | P2 | Date.parseのみの曖昧な日時、期限の1秒延長許容、リクエスト開始時刻での期限判定 | timezone必須・暦日/時分秒検証、延長許容撤廃、実行完了時clockを採用。now==valid_untilでexpired |
| F6 | P2 | floorにEPSILONを足すと、浮動小数点の境界でstored/capよりわずかに高く丸め得る | Phase3Aと同じ保守的floor3。stored/capを絶対に超えない |

## shared_policy_regression

policy.tsへの抽出は挙動維持。evaluatorからのre-exportが同じ関数・定数を指す。policyはI/O/importなしでruntime cycleなし。

移動前の`ecfab7a^`のstate logicをそのままメモリ内で読み込み、240組のdomain × age × confidence matrixでclassification/cap/fingerprint/初回trigger/clampを直接比較。freshness境界30組も一致。既存Scenario 55件（AI input/prompt更新/trigger/quality/no_change/escalation/response lossを含む）PASS。generation側runtime変更を追加していない。

## status_precedence / read_failure_semantics

通常入力では seed unavailable → stored integrity invalid → expired → live State invalid → degraded → usable。
transport/JSON/row-array failureはunavailable/read_failedで、seedのscenario_not_generatedと識別可能。missing currentはinvalid/current_row_missing。duplicate currentは読取不能扱い。

競合・不正clockはvalidation前の安全拒否。malformed+expired / stored identity mismatch+expiredはinvalid。整合したstored artifactでexpiry+live driftならexpiredを優先。どの拒否も本文・effective confidenceなし。

## multi_read_race_assessment

順序は **C1 → S1 → immutable run → immutable evidence → S2 → C2**。

- current変更をGET1〜5の各境界に挟むとinvalid。旧run/evidenceが整合したままのsame-State successorにも効く。
- S1〜S2間のmaterial/no_change quality/ABA resaveはinvalid。次回stable readで回復。
- currentのみ新、run/evidence旧、old Scenario + new Stateはfingerprint/run/evidence/live identity検証で拒否。
- READ COMMITTEDの独立transactionとして実DBでも再現。読取adapter自体はSELECTのみ。

**残る境界:** S2の結果を読み終えた直後にStateをdata_confidence=0.2へcommit、C2は変更なしという実DBケースで、今回readはdegradedの本文を返し、次回readはinvalid。これはS2時点の観測としては正しいが、応答時点の最新状態ではない。

有限回のGETは、最終観測後の更新を保証できない。再GETを増やしても末尾の競合が移動するだけ。現在の方法は整合した観測区間を検証するoptimistic point-in-time contractであり、ロック/DB snapshot/validity leaseではない。

推奨次工程（推薦モデル: **Sol（高）**）:

1. read-timeの意味を「整合した観測時点」か「consumer利用/公開時点」か明文化。
2. 今回の複数GET中の変更を厳密に単一snapshotへ限定するなら、別承認TASKでread-only snapshot RPC等を設計。今回はmigration/RPC追加なし。
3. snapshot取得後の更新まで禁止することはRPCだけでも保証できない。consumer利用・公開時の再検証/CAS、期限・degraded表示、キャッシュ無効化を別途設計。
4. 契約承認までconsumer接続・production-ready判定は保留。

## identity_integrity / evidence_validation

current sourceScenarioRun、run.id、evidence.scenario_run_id、domain/runの対応、current/run/rebuilt fingerprintを検証。domain/run arrayは対で扱い、並び替えは許容、duplicate domain/runは拒否。

Snapshotはexact11項目。extra/missing/null/wrong type/unknown enum/NaN/Infinity/未知domain/未来・不正日時を拒否。ai_confidence=nullはPhase3A契約どおり許容。生成時にStateがusableであったこと、Evidence freshness/usabilityが生成時分類と一致することも検証。

## live_state_revalidation / narrative_vs_observation_assessment

run/timestampだけでなく生成時の本文・要因・リスク・AI confidenceと一致が必要。これはservice_roleの直接UPDATEが可能な既存信頼境界を安全側に扱う。same-run内容変更を自動再生成する変更はしていないため、その場合は後続のState/Scenario再評価が必要。

data_confidence/coverage/observationだけのno_change更新は同じ意味論のquality更新として扱う。
full→partialはdegraded、unavailable/0.3未満はinvalid。
fresh→delayed_expectedはstale扱いしない。stale/unknownは弱い観測としてdegraded。
source_domainsではnarrative_freshnessとobservation_statusを分離し、無検証enumや日時を返さない。

## expiry_assessment / effective_confidence_assessment

valid_untilはEvidenceのai_evaluated_at + domain recent期限の最小値が上限。storedが短い場合は許容、1msでも長い場合はinvalid。timezoneが等価なら一致。now==期限はexpired。

effective confidenceは `floor3(min(stored, live cap, indeterminateなら0.3))`。
capは最弱Stateのdata confidence × recentなら0.8 − missing domainごと0.1、0..1。
quality改善でもstored値を超えず、悪化で即低下。3domain利用時でも生成に使った1domainがunusableならinvalidとする。既存3domainの文章から1domainだけを取り除いたかのように本文を再利用しない。

DB numeric計算との通常例（0.6−0.1=0.5、0.6×0.8−0.1=0.38等）を確認。binary float境界ではPhase3A同様保守的floorにより最大0.001低くなり得るが、DB/元confidenceを上回らない。

## missing_domain_assessment / production_fixture_result

- 生成時macroなし、今もなし: degraded/missing_domain:macro。
- 後からmacro usable: degraded + state_available_not_in_scenario、AI再生成なし。
- 生成に使ったdomainの喪失: 残り2domainでもinvalid。
- usable sourceが2未満: invalid/insufficient_usable_states。

Production-shaped fixture（rates recent/observation stale/data confidence0.6、equity recent、macro source run欠損、stored0.38）はdegraded、effective0.38。missing_domain:macro、narrative_recent:rates、observation_stale:ratesを含む。narrativeと観測staleを混同しない。

## contract_leakage / side_effect_assessment

返却はstatus/reasons/content/confidence/expiry/evaluated_at/domain qualityだけ。run ID/fingerprint/model/token/cost/raw usage/Evidence internals/DB error/secretは返さない。run.statusのraw interpolationも除去。エラーにdummy secretを含めるテストでも漏洩なし。

固定market scope、固定3domain、DB由来のUUID検証済みrun IDだけをfilterへ入れる。server-side service key保持者専用、browser/mobile用途なし。Auth/RLS変更なし。
6 GETのみ、bodyなし。POST/PATCH/DELETE/RPC/AI/evaluator/consumer invokeはゼロ。

## migration_version_collision_assessment

candidateには旧重複名が残るが、最新mainで **164485bef39c42164f9a69670d6087f7735f2bea** がdaily topicを`20260928123000_add_daily_kabumori_tip_rpc.sql`へrename済み（100%同一byte）。Scenarioは20260928120000を維持。今回branchではmigrationを変更していない。後のsource integrationでmainのrenameを保持すること。

2026-09-29 Production read-only catalog/history確認:

- 20260928120000/20260928123000のmigration history行: **0件**。
- apply_mic_scenario_update: 存在、body MD5 `b8a1f7cc1992318d71143c9c10a0023a`（candidate/main SQLと一致）。invoker、empty search_path、service実行可・anon/auth不可。
- get_daily_kabumori_tip(text,date): 存在、body MD5 `4b7865539dc54335a1748666e0683e13`（renamed main SQLと一致）。stable/definer、empty search_path、authenticated実行可・anon不可。
- 両RPCの反映を確認。ただしScenario migration全DDLのProduction同値監査を今回実施したという意味ではない。

CLI historyはtimestampをunique versionとして扱う。旧duplicate名では2ファイルを独立追跡できない。mainのrenameでファイルcollisionは解消済みだが、SQL直適用の履歴欠損はrenameだけでは埋まらない。fresh cloneのmigration listでは2versionとも未記録、db pushは未適用候補と判断し得る。

## migration_collision_recommended_fix（別TASK、推薦モデル: Sol（高））

1. 最新mainのunique filenamesを正本とし、追加renameは行わない。
2. 正しいProduction projectで該当2versionのhistory、両SQLの**全効果**（関数引数/戻り値/body/ACL、Scenario tables/check/index/trigger/RLS/RPC等）をread-onlyで照合。
3. 適用済み同値が全確認され、履歴同期をユーザーが別途承認した場合だけ、**履歴のみ**を20260928120000=Scenario、20260928123000=daily topicとしてappliedへ整合する手順を採用。SQL再適用やdb pushを代用しない。
4. 旧version履歴が誰かにより既に記録された場合は、その所有SQLを確認してから処理。不一致ならSTOP。
5. fresh cloneでmigration listとhistory mappingを再確認。今回repair/list/db push/migration applyは実行していない。

公式参照: [Database migrations](https://supabase.com/docs/guides/deployment/database-migrations)、[CLI migration repair](https://supabase.com/docs/reference/cli/supabase-migration-repair)。

## changed_files / tests

修正4ファイル: `_shared/mic_scenario/read_adapter.ts` / `read_gate.ts` / 両test。
追加: `supabase/tests/mic_scenario_phase3b_policy_test.ts`、`mic_scenario_phase3b_read_test.ts`、本報告書。
共有policy/evaluator本体、migration、Cron、report consumer、.agent、secretsは修正なし。

- Phase3B: **52 PASS**（元35 + review17）。
- Phase3A Scenario: **55 PASS**。
- State evaluator: **198 PASS**。
- ingest: **243 PASS**（--no-check。既存mic_writer_logic_testのsync fetch mockのTS2352 10件が残るため。該当fileは未変更）。
- 前実装policy direct comparison: **1 PASS**（240組matrix）。
- disposable DB read tests: **4 PASS**。うち1件は未解決のlatest-at-return境界を再現するテストであり、厳密契約PASSを意味しない。
- Phase3A disposable concurrency/CAS tests: **4 PASS**。
- **計557 PASS**。Phase3A SQL suite + apply/reapply PASS。
- Runtime deno check（read adapter + Scenario/State/ingest index）、changed-files/test lint（9 files）、git diff --check: PASS。
- Podman/full migration chainは使わず、native PostgreSQL17 UTF8、新規dummy-only cluster `/private/tmp/mic-scenario-pg-review.rgzozO`、socket/port55483、DB mic_scenario_reviewを使用。Production接続なし。検証後このclusterのみ停止。

再現:

```sh
deno test --no-config --allow-env --allow-read supabase/functions/_shared/mic_scenario/*_test.ts supabase/functions/market-intelligence-scenario-evaluator/*_test.ts
deno test --no-config --allow-env --allow-read supabase/functions/market-intelligence-state-evaluator/*_test.ts
deno test --no-config --no-check --allow-env --allow-read supabase/functions/market-intelligence-ingest/*_test.ts
deno test --no-config --allow-run=git --allow-read supabase/tests/mic_scenario_phase3b_policy_test.ts
```

DB再現は新規disposable DBで既存`fixtures/mic_scenario_phase3a_dependencies.sql` → Phase3A migration x2 → `mic_scenario_phase3a_review.sql` → Phase3B read tests → Phase3A concurrency tests。明示的なlocal socket環境変数がなければDB testsはskip/接続拒否。

## commit / push / next_recommendation

review commitはこの報告と上記6source/testファイルのみ。exact hashとremote反映確認は最終回答を参照。既存candidate・元working tree・H1/H2 TASKは保護。mainへpush/mergeしない。

残るP1契約のレビューを先に行うこと。strict latest-at-return保証を達成したとみなしてconsumerへ接続しない。Production作業は別承認が必要。
