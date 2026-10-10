# MIC Stage 1 — 正式 Verification 詳細設計（実装準備）

状態: **DESIGN ONLY**。ソースコード変更 0、migration 作成・適用 0、Production 変更 0。
作成: 2026-10-10（JST）。基点: `origin/main` `d9bb99d2`。

前提となる工程:

- Stage 0（JGB 現行ファイル、正確な小数比較、観測の猶予）: Production 反映済み。
- Stage 1 Slice 0（`decision_detail.verification_shadow` v1）: main 統合 `427b2931`、
  Production state-evaluator **v32**（2026-10-07 16:11 JST）。
  10/10 14:11 JST までの観測: no_change 33 件すべてに shadow、`comparison_mismatch` 0、
  `shadow_error` 0、失敗 run 0、no_change での AI 呼び出し 0。

この文書の目的は、10/14 以降の追加観測が PASS なら追加の大規模調査なしで
正式 Verification の実装に入れる状態にすることである。数値（96h / 168h / 0.64 / backstop 96h）は
Stage 2 の設計候補値であり、**本書では採用しない**。

---

## 0. 調査結果（現行実装の事実）

### 0.1 調査したファイル

| 種別 | パス |
| --- | --- |
| State evaluator | `supabase/functions/market-intelligence-state-evaluator/index.ts`、`mic_state_decision_logic.ts`、`mic_state_query_logic.ts`、`mic_state_types.ts`、`mic_state_run_logic.ts`、`mic_state_writer_logic.ts`、`mic_state_verification_shadow.ts`（とテスト） |
| Ingest | `supabase/functions/market-intelligence-ingest/mic_writer_logic.ts` |
| Scenario | `supabase/functions/_shared/mic_scenario/{policy,read_gate,read_adapter}.ts`、`market-intelligence-scenario-evaluator/mic_scenario_run_logic.ts` |
| Consumer | `supabase/functions/personalized-reports/mic_market_context.ts` |
| Migration | `20260912090000_add_market_intelligence_core_phase1a.sql`（market_metrics）、`20260913090000_add_market_intelligence_state_layer_phase1b.sql`（State 層・view）、`20260915090000_mic_phase1b_hardening_stale_after_threshold.sql`（観測 view 現行版）、`20260924150000_mic_state_evidence_phase2c1.sql`（State RPC・evidence）、`20260928120000_mic_scenario_layer_phase3a.sql`、`20261002090000_mic_jgb_nikkei_observation_grace_stage0.sql` |
| 設計文書 | `docs/market-intelligence/PHASE_1B_STATE_LAYER.md`、`docs/mic/phase3a-review-20260928.md`、`docs/mic/phase3b-review-20260929.md`、`docs/mic/phase3c-scenario-trigger-design.md` |

### 0.2 Production の実態（read-only 集計、2026-10-10 19:19 JST）

| 項目 | 値 |
| --- | --- |
| `market_metrics` 行数 | 730 |
| 1 metric に複数 source がある例 | **0**（全 metric が単一 source） |
| 最新観測日時のタイ（同 metric・同 anchor に複数行） | **0** |
| `time_precision` | 全 34 metric が `date`（timestamp 精度の metric は現存しない） |
| `market_metrics` の `updated_at` 列 / トリガー | 無し / 無し |
| `market_state_current` のトリガー | `trg_market_state_current_updated_at` のみ |
| `mic_state_evaluation_runs` のトリガー | `trg_mic_state_evaluation_runs_guard_terminal_status` のみ |
| narrative があるのに `source_evaluation_run_id` が null の domain | **無し**（commodities も 10/8 の AI 評価で解消） |
| State RPC | `apply_mic_state_material_update`（25 引数）、`apply_mic_state_no_change_update`（9 引数）の 2 本のみ |
| baseline の形 | 全 domain・全 metric で `{value, observedDate, observedAt}` の 3 キーのみ |
| shadow の最大サイズ | 8,859 バイト（macro） |
| `mic_state_evidence` | `market_event` 126 行、`fed_statement_diff` 9 行（metric の証拠は未実装） |

### 0.3 現行実装で確定している事実

1. **観測の取得経路**: Edge は `v_mic_metric_observation_status`（→ `v_mic_latest_metric_changes`）を読む。
   最新行は `row_number() over (partition by metric_key order by dedupe_anchor_at desc)` で選ばれ、
   **タイの決め手（tie-break）が無い**。view は `market_metrics.id` を返さない。
2. **market_metrics の更新**: 一意キーは `(metric_key, source_key, dedupe_anchor_at)`。ingest は
   `on_conflict=...&resolution=merge-duplicates` の upsert で、同じ観測を再取得すると
   **同じ行（同じ id）をその場で上書き**する（value / fetched_at / metadata）。行の削除経路はコード上に無い。
   行のバージョン情報は無いので、同日の値の改定は「value が変わった」こと以外では検出できない。
3. **baseline**: `numeric_baseline_snapshot` は material 更新時に Edge が
   `{metricKey: {value, observedDate, observedAt}}` で作る。source_key・行 id は持たない。
   no_change では一切更新されない。
4. **State の書き込み**: `market_state_current` を更新するのは上記 2 RPC だけ。どちらも
   current 行 `FOR UPDATE` → run 行 `FOR UPDATE` の順でロックし、`updated_at` の CAS と
   「current が run 開始後に更新されていないこと」を確認する。material RPC は history に
   `to_jsonb(v_current)` を残し、`source_evaluation_run_id = p_run_id`、`ai_evaluated_at = now()` を書く。
5. **run の一意性**: `(domain, run_window)` の部分一意インデックス（`running` / `no_change` / `evaluated`）。
   終了した run は `trg_..._guard_terminal_status` により以後一切変更できない。
   15 分を超えた `running` は次回起動時に `failed` へ回収される。
6. **Scenario 側**: Phase 3A RPC は Scenario の 3 domain の current 行を `FOR SHARE`（domain 順）でロックし、
   evidence snapshot の 11 項目を照合する。read gate は `source_evaluation_run_id` と
   `ai_evaluated_at` の一致で identity を判定する。`updated_at`・`as_of` は使わない。
7. **読み手**: `market_state_current` の読み手（Scenario evaluator、read adapter、personalized-reports、
   State evaluator）はすべて select する列を明示している。列の追加で壊れる読み手は無い。
8. **material 判定のしくみ**: `detectNewObservations` は「値が違う」または「観測日時の文字列が違う」
   metric を対象にし、`evaluateMaterialChange` が always_material → first_observation → abs → pct の順で
   判定する（Stage 0 の正確な小数比較）。macro は 20 metric 中 10 が always_material。

---

## 1. 正式 Verification 詳細設計

### 1.1 用語

- **verified**: その run の時点で、current の narrative が根拠とした baseline 以降に新しい観測が 1 件以上あり、
  そのすべてが閾値未満で、ほかの成立条件もすべて満たしたことを **DB が確認した**状態。
- **not_verified**: verified の条件を 1 つでも満たさない状態。理由コードを必ず残す。
- `verified_at` は「narrative が最新の事実と矛盾しないことを最後に確認した時刻」。
  `ai_evaluated_at`（narrative を書いた時刻）とは別物で、**`ai_evaluated_at` は書き換えない**。

### 1.2 成立条件（すべて DB のトランザクション内で判定）

| # | 条件 | 判定方法（DB） | 不成立時の reason |
| --- | --- | --- | --- |
| A1 | narrative identity 一致 | `current.source_evaluation_run_id = p_verified_source_evaluation_run_id`、かつ narrative / `ai_evaluated_at` / baseline が non-null | `identity_mismatch` / `identity_missing` |
| A2 | 必要な metric が揃っている | `mic_metric_domain_map` の domain の全 metric が送られた証拠に 1 回ずつ含まれ、余分な metric が無い | `metric_set_mismatch` |
| A3 | coverage full | 全 metric に最新行がある | `coverage_partial` / `coverage_unavailable` |
| A4 | fetch acceptable | DB が `v_mic_source_fetch_status` を読み、関係する全 source が `fresh` | `fetch_not_fresh` |
| A5 | observation acceptable | DB が `v_mic_metric_observation_status` を読み、全 metric が `fresh` / `delayed_expected` | `observation_not_acceptable` |
| A6 | 観測 identity が成立 | 1.3 の手順で全 metric の最新行を DB が特定でき、Edge の申告と一致 | `latest_observation_changed` / `latest_observation_ambiguous` / `observation_identity_missing` |
| A7 | 改定・後退が無い | baseline と同じ観測日時で値が違う（改定）、または baseline より古い（後退）metric が無い | `observation_revised` / `observation_regressed` |
| A8 | 新しい観測が 1 件以上 | baseline より新しい観測日時の metric が 1 件以上 | `no_new_observation`（**verified_at を進めない**） |
| A9 | 閾値比較がすべて正常 | 新しい観測の全 metric で、定義済みの閾値すべてを numeric で比較できた | `threshold_undefined` / `comparison_unavailable` |
| A10 | material change なし | always_material の新観測なし、abs / pct のどれも閾値未満 | `material_change` |
| A11 | 未処理の material イベントなし | 1.5 の条件で high / critical の未処理イベントが 0 件 | `event_pending` |
| A12 | stale guard なし | all-stale 分岐（`ai_skipped`）の run ではない | `all_stale_guard` |
| A13 | 競合する State 更新なし | 既存の CAS（`updated_at`）と run 開始時刻の確認を通過 | （RAISE。2.4 参照） |
| A14 | Edge と DB の判定が一致 | Edge の shadow が `below_threshold` で、DB の判定も verified | `db_rederivation_mismatch` |
| A15 | 監査証拠を完全に保存 | 3.1 の run 列・`verification_detail`・DB fingerprint を同一トランザクションで書く | （書けなければ RAISE） |

- A1・A13 以外の不成立は **RAISE しない**。no_change の状態更新は今どおり行い、
  `verification_status = 'not_verified'` と理由を記録する。照合のせいで State run を失敗させない。
- A13（CAS）は既存の no_change RPC と同じく RAISE する。これは照合と無関係に既存処理の安全条件である。
- reason が複数ある場合は、上の表の順を優先順位として先頭を `verification_reason` に、
  全件を `verification_detail.blocking_reasons` に残す（shadow と同じ方式）。

### 1.3 観測 identity（正式版）

**結論**: 正式な観測 identity は
`(metric_key, source_key, dedupe_anchor_at)` ＋ `market_metrics.id` ＋ `value` の組とし、
**DB が自分で最新行を選び直す**。view は変更しない。

手順（RPC 内、metric ごと）:

1. Edge は metric ごとに `{metric_key, observed（date または timestamp）, value}` を送る
   （shadow の `latest` と同じ値）。行 id は送らない（view が返さないため）。
2. DB は `market_metrics` から、その metric の `dedupe_anchor_at` 最大の行を
   `order by dedupe_anchor_at desc, id desc` で選び、`FOR SHARE` でロックする。
3. 同じ `dedupe_anchor_at` を持つ行が 2 行以上ある、または source_key が 2 種類以上ある場合は
   `latest_observation_ambiguous`（現時点の Production では 0 件だが、将来の複数 source 化に備える）。
4. DB の行の anchor・value が Edge の申告と一致しなければ `latest_observation_changed`
   （Edge が読んでから RPC までの間に新しい観測が入った、または同日改定があった）。
5. 証拠として `market_metric_id`、`source_key`、anchor、`value`、`fetched_at` を保存する。

各ケースの扱い:

| ケース | 判定 | 結果 |
| --- | --- | --- |
| 同じ値で観測日が新しい | anchor が baseline より後 | 新しい観測（閾値比較へ） |
| 同日の再取得で値も同じ | anchor・value とも baseline と同じ | 変化なし（新しい観測ではない） |
| 同日の改定（値だけ違う） | anchor が同じで value が違う | `observation_revised`（verified にしない） |
| 観測日時の後退 | anchor が baseline より前 | `observation_regressed` |
| 行の置き換え（delete → insert） | 現行コードに経路は無い。起きても DB が選び直すので、anchor・value が同じなら同等、違えば 4. で検出 | 安全側 |
| 欠損 | 最新行が無い | `coverage_partial` |
| 時刻精度の違い | anchor は `dedupe_anchor_at`（date は UTC 0 時、timestamp は実時刻）で比較し、baseline 側は `time_precision` に応じて `observedDate` / `observedAt` から anchor を作る。精度が baseline と最新行で食い違えば `observation_identity_missing` | 安全側 |
| RPC 中の改定 | 2. の `FOR SHARE` により、commit までその行の upsert は待たされる | 一貫 |

- baseline 側は source_key と行 id を持たないが、現状は全 metric が単一 source なので
  `(metric_key, anchor)` で一意に対応する。3. の確認で、この前提が崩れたら照合しない。
- 「value の数値比較」は Postgres の `numeric` の等価比較で行う（`3.0970 = 3.097` は真）。
  JSON で受け取った値は `(p->>'value')::numeric` で読む。

### 1.4 閾値判定（DB 側）

Edge の `evaluateMaterialChange` と同じ順序・同じ意味を `numeric` で書く。

```
new_obs かつ always_material                         → material
abs 閾値あり かつ abs(latest - baseline) >= abs_thr   → material
pct 閾値あり かつ baseline <> 0
   かつ abs(latest - baseline) * 100 >= pct_thr * abs(baseline) → material
abs も pct も null（always_material でない）          → threshold_undefined
定義済みの閾値のうち比較できないものがある（pct のみで baseline = 0 など）→ comparison_unavailable
それ以外                                               → below_threshold
```

- `numeric` は正確な小数なので、Stage 0 の境界（5.24→5.29 は閾値 0.05 に到達、5.24→5.289 は未到達）を
  float 誤差なしに再現できる。SQL テストで Stage 0 と同じ境界表を固定する。
- この判定は **既存の material 判定を置き換えない**。Edge の判定で no_change になった run に対して、
  DB が「verified と言ってよいか」を独立に確かめるためだけに使う。

### 1.5 未処理イベント（A11）

既存の Edge のルール: domain ごとの event_type（rates: `rate_decision`, `central_bank_decision`、
macro: `macro_release`、geopolitical / corporate_events は別一覧）のイベントのうち、
`source_event_ids` に無い、または `updated_at > ai_evaluated_at` のものが未処理。
そのうち importance が high / critical のものがあれば material。

DB 側の案（推奨）:

- RPC 内に domain → event_type の対応を **SQL 定数**として持ち、上の条件で high / critical の未処理イベントを数える。
- Edge の `DOMAIN_EVENT_TYPES` と SQL 定数が一致することを、ソース不変条件テスト（migration と TS を読み比べる）で固定する。
- 低・中重要度の未処理イベントは照合を妨げない（既存の material 判定と同じ扱い）。ID は証拠に残す。

（代替案と未確定事項は 9 章）

### 1.6 Narrative identity の保護

- `source_evaluation_run_id`、`ai_evaluated_at`、`numeric_baseline_snapshot`、narrative 系の列は
  照合 RPC から**一切書かない**（UPDATE の SET 句に含めない）。
- 照合結果は「どの narrative に対する照合か」を `verified_source_evaluation_run_id` として run に保存する。
- current の照合ポインタは、material 更新で narrative が変わった瞬間に自動で null に戻す（3.3 のトリガー）。
  別の narrative に対する照合ポインタが current に残ることは無い。

---

## 2. RPC / トランザクション設計

### 2.1 方針

- **新しい RPC を追加する**: `apply_mic_state_verified_no_change_update`。既存の
  `apply_mic_state_no_change_update` は**変更も削除もしない**（rollback 用に残す）。
- Edge は正式実装後、すべての no_change（通常の no_change と all-stale 分岐の両方）を新 RPC で書く。
  照合候補でない場合も新 RPC を通し、`not_verified` と理由を記録する（経路を 1 本にする）。
- 新 RPC の「no_change としての書き込み」（状態 5 列の更新、run の `no_change` 化、`decision_detail`）は
  既存 RPC と**完全に同じ**にする。違いは照合の判定と記録だけ。

### 2.2 引数（案）

```
apply_mic_state_verified_no_change_update(
  p_domain text,
  p_run_id uuid,
  p_expected_current_updated_at timestamptz,
  p_as_of timestamptz,
  p_coverage_status text,
  p_fetch_status text,
  p_observation_status text,
  p_data_confidence numeric,
  p_decision_detail jsonb,             -- 既存どおり（verification_shadow を含む）
  p_verification_candidate boolean,    -- Edge の shadow が below_threshold のとき true
  p_verified_source_evaluation_run_id uuid,  -- Edge が読んだ current の narrative identity
  p_observations jsonb                 -- [{metric_key, observed, value}]（domain の全 metric）
) returns table(result_status text, verification_status text, verification_reason text)
```

- `security invoker`、`set search_path = ''`、`service_role` のみ EXECUTE（既存 RPC と同じ権限設計）。
- `p_verification_candidate = false` のときは照合判定を行わず、
  `not_verified` と shadow の理由（無ければ `not_candidate`）を記録する。

### 2.3 処理順（1 トランザクション）

```
1. current 行を FOR UPDATE（既存と同じ）
2. run 行を FOR UPDATE、domain 一致を確認（既存と同じ）
3. run が既に no_change → already_applied を返す（冪等。照合の記録は 1 回目のもののまま）
4. CAS: expected updated_at 一致、run が running、current.updated_at <= run.started_at
   （既存と同じ。不一致は RAISE）
5. decision_detail がオブジェクトであること（既存と同じ）
6. 照合判定（候補のときだけ）:
   6a. A1 narrative identity
   6b. A2〜A5（domain map、fetch / observation の view を DB が読む）
   6c. metric ごとに 1.3 の最新行特定（market_metrics を metric_key 順・id 順に FOR SHARE）
   6d. A7〜A10（1.3・1.4）
   6e. A11（1.5）
   6f. A12（decision_detail の ai_skipped）
   6g. DB fingerprint を計算（3.1）
7. run を no_change に更新（既存と同じ列）＋ 照合列（3.1）を同じ UPDATE で書く。
   row_count <> 1 なら RAISE
8. current の状態 5 列を更新（既存と同じ）。
   verified のときだけ verified_at = now()、verification_run_id = p_run_id も同じ UPDATE で書く
   （3.3 のトリガーが 7 で書いた run の照合列を確認するため、run → current の順にする）
9. result_status = 'applied'
```

- ロック順は「current → run → market_metrics（metric_key, id 順）→ 参照のみの view」。
  Scenario の Phase 3A RPC は current を `FOR SHARE` するだけで market_metrics をロックしないので、
  ロック順の循環は生じない。ingest の upsert は market_metrics 1 行だけを書くので、
  `FOR SHARE` 中の行には commit まで待たされるだけである。
- `verified_at` は `now()`（トランザクション開始時刻）。6c でその時点の最新行を確定しているので、
  「この時刻の時点で最新の事実と照合した」という意味が成り立つ。

### 2.4 失敗時の挙動（fail-closed）

| 事象 | 挙動 | 結果 |
| --- | --- | --- |
| CAS 不一致・run が running でない・current が run 開始後に更新済み | RAISE（既存と同じコード） | 全体がロールバック。run は Edge が failed にするか 15 分後に回収。State は変わらない |
| 照合条件の不成立（A2〜A12、A14） | RAISE しない | no_change は通常どおり確定、`not_verified` と理由を記録、ポインタは動かない |
| narrative identity 不一致（A1） | RAISE しない（`identity_mismatch`）。CAS が先に通っているので実質発生しないが、発生時も安全側 | `not_verified` |
| 照合列の書き込み失敗・制約違反 | RAISE | 全体がロールバック（状態更新も残らない）。既存の失敗時と同じ扱い |
| 引数の形の不正（p_observations が配列でない等） | 候補なら `not_verified`（`evidence_invalid`）、構造的に読めない場合は RAISE | 安全側 |

### 2.5 Edge 側の変更（正式実装時）

- `applyNoChangeUpdate` の代わりに新 RPC を呼ぶ `applyVerifiedNoChangeUpdate` を追加する。
- `p_verification_candidate` = `verificationShadow.status === "below_threshold"`。
- `p_verified_source_evaluation_run_id` = shadow の `narrative_identity.source_evaluation_run_id`。
- `p_observations` = shadow の `metrics[]` から `{metric_key, observed: latest.observed, value: latest.value}`。
- 新 RPC の戻り値の `verification_status` / `verification_reason` を run 結果のログに含める（判定には使わない）。
- material 判定、AI 呼び出し条件、material RPC への引数は**変更しない**。

---

## 3. DB 変更案（migration は設計のみ、未作成）

### 3.1 `mic_state_evaluation_runs` への追加列

| 列 | 型 | 意味 |
| --- | --- | --- |
| `verification_status` | `text null` check in (`verified`, `not_verified`) | null は正式実装前の run と material run |
| `verification_reason` | `text null` | verified のときは `below_threshold`、not_verified のときは主な理由 |
| `verified_source_evaluation_run_id` | `uuid null` FK → `mic_state_evaluation_runs(id)` | 照合した narrative |
| `verification_fingerprint` | `text null` | DB が計算した事実の sha256（`sha256:` + 64 hex） |
| `verified_metric_count` | `integer null` | 閾値比較した新しい観測の数 |
| `verified_observation_as_of` | `timestamptz null` | 照合した新しい観測の最大 anchor |
| `verification_detail` | `jsonb null` | metric ごとの DB 判定（`market_metric_id`、`source_key`、anchor、value、baseline、閾値、変化量、結果）、`blocking_reasons`、未処理イベント ID |

制約（案）:

```sql
check (
  verification_status is null
  or (verification_status = 'verified'
      and status = 'no_change'
      and verification_reason = 'below_threshold'
      and verified_source_evaluation_run_id is not null
      and verification_fingerprint ~ '^sha256:[0-9a-f]{64}$'
      and verified_metric_count >= 1
      and verified_observation_as_of is not null
      and jsonb_typeof(verification_detail) = 'object')
  or (verification_status = 'not_verified'
      and status = 'no_change'
      and verification_reason is not null)
)
```

- 既存行はすべて null なので、制約の追加は既存データと矛盾しない（220 行、走査は一瞬）。
- 終了した run は既存トリガーで変更できないので、照合の記録も自動的に不変になる。

DB fingerprint の入力（DB が読んだ値から計算し、Edge の値は使わない）:

```
'v1' / domain / verified_source_evaluation_run_id /
metric ごとに metric_key | source_key | market_metric_id | dedupe_anchor_at | trim_scale(value)
            | baseline anchor | trim_scale(baseline value) | abs_thr | pct_thr | always_material
未処理イベントごとに id | updated_at | importance
→ metric_key 順・event id 順に連結 → extensions.digest(..., 'sha256')
```

- Edge の shadow fingerprint とは正規化の方式が違うので値は一致しない。両方を保存し、
  DB 側を正式な `verification_fingerprint` とする。

### 3.2 `market_state_current` への追加列

| 列 | 型 | 意味 |
| --- | --- | --- |
| `verified_at` | `timestamptz null` | 現在の narrative を最後に verified にした時刻 |
| `verification_run_id` | `uuid null` FK → `mic_state_evaluation_runs(id)` | その run |

制約: `(verified_at is null) = (verification_run_id is null)`、`verified_at >= ai_evaluated_at`。

- 既存 7 行はすべて null。Scenario・personalized-reports は select する列を明示しているので影響しない。
- material RPC の history（`to_jsonb(v_current)`）には新しい 2 列が自動で入る。
  これは「置き換えられた narrative が最後にいつ照合されていたか」の記録として有用で、
  history を読むのは material RPC の `already_applied` 判定（`snapshot->>'source_evaluation_run_id'` のみ）だけなので無害。

### 3.3 トリガー（current）

```sql
-- BEFORE UPDATE ON market_state_current
-- 1) narrative identity が変わったら照合ポインタを必ず消す（material RPC を書き換えずに済む）
if new.source_evaluation_run_id is distinct from old.source_evaluation_run_id then
  new.verified_at := null;
  new.verification_run_id := null;
end if;
-- 2) ポインタを新しく立てる更新は、その run が今の narrative を照合した verified run であること
if new.verification_run_id is not null
   and new.verification_run_id is distinct from old.verification_run_id then
  if not exists (
    select 1 from public.mic_state_evaluation_runs r
    where r.id = new.verification_run_id
      and r.domain = new.domain
      and r.verification_status = 'verified'
      and r.verified_source_evaluation_run_id = new.source_evaluation_run_id
  ) then
    raise exception 'MIC_STATE_VERIFICATION_POINTER_INVALID';
  end if;
end if;
```

- 2) が run の照合列を確認できるよう、2.3 では **run の照合列を先に書き（7）、そのあと current の
  ポインタを立てる（8）**。ロックはどちらも 2.3 の 1〜2 で取得済みなので、更新順を変えてもロック順は変わらない。
- 2) では run の `verification_status = 'verified'` も条件に加える（`not_verified` の run を指すポインタを拒否する）。
- 既存トリガー `trg_market_state_current_updated_at` との順序は名前順（`trg_market_state_current_updated_at` <
  `trg_market_state_current_verification`）で、互いに独立した列しか触らない。

### 3.4 採らなかった案

| 案 | 採らなかった理由 |
| --- | --- |
| `mic_state_evidence` に `metric_observation` 種別を追加 | 種別の check 制約の付け替えと `market_metrics` への FK（on delete restrict）が要り、変更範囲が広い。1 run に数十行増える。正式な型付き証拠としては魅力があるので 9 章で再検討 |
| 照合専用テーブルを新設 | 本番の `ensure_rls` イベントトリガーと権限設計の対象が増える。run 行は既に不変なので監査性は同等 |
| view に `market_metrics.id` を追加 | `create or replace view` は列の末尾追加なら可能だが、view の再定義は他の読み手（market-report-data-packet）へ波及する。DB が自分で最新行を選び直す方が安全 |
| baseline に source_key・行 id を追加 | material（AI）経路の変更になる。Stage 1 では触らない。9 章の将来課題 |
| `updated_at` を鮮度に使う / `ai_evaluated_at` を更新 | 古い narrative を新しく見せてしまう |

---

## 4. 競合対策

| 競合 | 対策 | 結果 |
| --- | --- | --- |
| State AI 評価（material RPC）と照合が同時 | 両 RPC とも current を `FOR UPDATE` → 直列化。後に来た方は `updated_at` の CAS で RAISE（`MIC_STATE_STALE_DECISION`） | 照合が後なら失敗して何も残らない。照合が先なら、その後の material 更新でトリガーがポインタを消す |
| narrative 更新中の照合 | 上と同じ。加えて 6a で `source_evaluation_run_id` を照合 | 別 narrative への照合は保存されない |
| baseline 変更との競合 | baseline は material RPC だけが変える → 上と同じ直列化と CAS。照合は current から baseline を読む（Edge の値を使わない） | 古い baseline に対する照合は保存されない |
| 古い run による上書き | 既存の `current.updated_at > run.started_at` で RAISE（`MIC_STATE_STALE_RUN`） | 新しい照合を古い run が上書きできない |
| 並行 Cron 実行 | `(domain, run_window)` の部分一意インデックス（既存）。同じ窓の 2 本目は claim できない | 二重照合は起きない |
| ABA（narrative A → B → A） | identity は内容ではなく run id（uuid、再利用されない）。CAS の `updated_at` も毎回 `now()` で進む | A に戻ったように見えても別 identity として扱われ、古い照合は無効 |
| 照合の重複記録 | 終了した run は不変。RPC は `already_applied` で 2 回目を何もせず返す。ポインタは run id で一意 | 1 run につき 1 回だけ |
| 照合中の観測の改定・新規取込 | 6c の `FOR SHARE` で対象行の upsert を commit まで待たせる。新しい anchor の行が並行して入った場合は、この照合の時点では最新でなかっただけで、次の run が拾う | 照合時点の整合性は保たれる |
| RPC の途中失敗 | 1 トランザクション。RAISE で状態更新・run 更新・ポインタすべてロールバック | 半端な記録は残らない |
| Scenario RPC との競合 | Scenario は current を `FOR SHARE`。照合 RPC の `FOR UPDATE` とは待ち合わせになるだけ。Scenario は `verified_at` を見ない（Stage 1） | Scenario の挙動は不変 |

責任分界:

- **Edge**: material 判定（唯一の正）、AI 呼び出し、shadow の作成、照合候補の申告。
- **DB（新 RPC）**: 照合の最終判定（正式な verified はここでしか生まれない）、証拠と fingerprint の保存、ポインタ更新。
- **DB（トリガー）**: narrative 変更時のポインタ消去と、ポインタの正当性の最終確認。
- **material RPC**: 変更しない。

---

## 5. Stage 2 との境界

Stage 1 では次を一切変えない: Scenario の AI 再生成条件、freshness 判定、confidence、valid_until、
input_fingerprint、evidence snapshot の 11 キー、read gate。

Stage 2 が使える形で用意するもの:

- current の `verified_at` / `verification_run_id`（照合の鮮度を 1 行で読める）。
- run の照合列（照合の根拠を監査できる）。
- 「verified は DB でしか生まれない」「narrative が変わればポインタは必ず消える」という不変条件。

Stage 2 で決めること（本書では採用しない候補値）: 照合の有効時間（候補 96h）、narrative の絶対上限
（候補 168h）、照合のみの State の confidence 係数（候補 0.64）、AI backstop（候補 96h）、
Scenario の revalidation の要否、evidence snapshot に照合情報を含めるか。

---

## 6. テスト計画

### 6.1 SQL（ローカル PG17、`supabase/tests/` の既存ランナー方式）

正常系:

1. 新しい観測あり・全件閾値未満 → `verified`、ポインタが立つ、`ai_evaluated_at` / baseline / narrative / `source_evaluation_run_id` は不変。
2. 同じ値で観測日だけ新しい → `verified`（変化量 0）。
3. 複数 metric のうち一部だけ新しい観測 → `verified`（`verified_metric_count` = 新しい観測の数）。
4. 既存の narrative を維持したまま 2 回連続で verified → `verified_at` が進み、ポインタが新しい run に移る。
5. 正式実装前の no_change run（照合列 null）と新 run が共存できる。

異常系:

6. 新しい観測なし → `not_verified` / `no_new_observation`、ポインタは動かない。
7. 閾値ちょうど（5.24 → 5.29、閾値 0.05）→ `material_change`。5.24 → 5.289 → `verified`。pct も同様の境界表。
8. 同日改定（anchor 同じ・value 違い）→ `observation_revised`。
9. 観測日時の後退 → `observation_regressed`。
10. coverage 不足・metric 欠損 → `coverage_partial`。
11. stale observation → `observation_not_acceptable`。fetch stale / failed → `fetch_not_fresh`。
12. identity 不一致（別 narrative の run id を申告）→ `identity_mismatch`、ポインタは動かない。
13. 比較不能（pct のみで baseline 0）・閾値未定義 → それぞれの reason。
14. 未処理の high イベント → `event_pending`。low / medium は照合を妨げない。
15. all-stale 分岐 → `all_stale_guard`。
16. Edge の申告と DB の最新行が違う（RPC 前に新しい行を入れる）→ `latest_observation_changed`。
17. 同じ anchor の行が 2 行（source 違い）→ `latest_observation_ambiguous`。
18. 重複実行（同じ run で 2 回呼ぶ）→ 2 回目は `already_applied`、記録は 1 回目のまま。
19. 並行 AI 更新: 照合 RPC の前に material RPC を commit → 照合は `MIC_STATE_STALE_DECISION` で RAISE、何も残らない。
20. 並行 AI 更新（逆順）: 照合の後に material RPC → トリガーでポインタが null に戻る、history に照合列が残る。
21. ABA: narrative A → B → A 相当（別 run id）で古い照合ポインタが復活しない。
22. 古い run（current が run 開始後に更新済み）→ `MIC_STATE_STALE_RUN` で RAISE。
23. DB 書き込み失敗（制約違反を注入）→ 全体ロールバック、State の状態列も変わらない。
24. ポインタの不正設定（他 narrative の run を直接 UPDATE で指す）→ トリガーが RAISE。
25. 2 セッションでの競合（照合 RPC が market_metrics を FOR SHARE 中に ingest の upsert）→ upsert が待つことを確認。
26. 権限: anon / authenticated から新 RPC を実行できない。

変異テスト（mutation test）: 閾値比較を `>` に、anchor 比較を `>=` に、identity 確認を外す、
トリガーのポインタ消去を外す、の 4 通りで、それぞれ対応するテストが落ちることを確認する。

### 6.2 Edge（Deno、`--no-config`）

- no_change の 2 分岐が新 RPC を呼び、既存の `decision_detail`（material / reason / verification_shadow）がそのまま渡る。
- `p_verification_candidate` が shadow の status から正しく決まる。
- material 経路の RPC 引数・AI 呼び出し条件が変わらない（既存テストの維持）。
- 新 RPC が `not_verified` を返しても run は no_change として成功扱い。

### 6.3 回帰

- State evaluator 全体、Scenario evaluator、`_shared/mic_scenario`（read gate）、ingest（`--no-check`）、
  personalized-reports の MIC context が全件通る。
- Scenario の evidence snapshot（11 キー）と input_fingerprint が変わらない。
- 既存の shadow が引き続き記録される。
- AI 呼び出しの回数・条件が変わらない（no_change での AI 呼び出し 0 を本番で再確認）。

---

## 7. migration 実行時の安全確認項目

適用前:

1. migration のバイト列の sha256 が、レビュー済みの candidate と一致する。
2. `migration_source_invariants_test.ts` に version を予約済みで、他の migration と衝突しない。
3. Production の現状が本書 0.2 の前提どおり（列・トリガー・RPC 署名・権限）であることを read-only で確認。
4. `market-intelligence-state-evaluator` が想定の version で、running の State / Scenario run が 0 件。
5. 適用時刻が State / Scenario / ingest の実行枠（毎時 :15 / :25 / :45 付近）から外れている。
6. MIC の Cron fingerprint（既存 22 本・Scenario）を記録。

適用:

7. `supabase db query --linked -f <migration>` で 1 本だけ適用（`db push` は使わない）。
8. ledger は `migration repair --status applied <version>` でその 1 版だけ記録。

適用後（read-only read-back）:

9. 追加列・制約・FK・トリガー・新 RPC の署名と本文ハッシュ・`service_role` のみの EXECUTE を確認。
10. 既存 RPC 2 本が変わっていない（本文ハッシュ）。
11. 既存行の照合列がすべて null。
12. Cron fingerprint が不変。
13. この時点では旧 Edge（v32）のまま動き、次の自然実行が従来どおり no_change / evaluated になる。

---

## 8. rollback 方針

- **Edge**: 正式実装前の v32 と同じソース（main の該当 commit）を再 deploy すれば、旧 RPC で動く。
  照合列は nullable なので、旧 Edge と共存できる。
- **DB**: 列・制約・トリガー・新 RPC は残しても旧 Edge の動作に影響しない（追加のみ）。
  DROP 系の rollback は行わない。
- **トリガーに不具合があった場合**: トリガー関数を「何もしない」版に差し替える修正 migration を
  事前に用意しておく（DROP ではなく差し替え）。ポインタが誤って残っても、Stage 1 では誰も読まないので実害は無い。
- **誤って verified が記録された場合**: run は不変なので消さない。current のポインタは次の material 更新で
  自然に消える。Stage 2 の前に、誤記録を無視するための除外条件を設ける（9 章）。

---

## 9. 未確定事項

| # | 事項 | 現時点の推奨 | 決める人・時期 |
| --- | --- | --- | --- |
| U1 | equity で `no_new_observation` が本番で取れていない | 10/12（スポーツの日）を含む 10/14 の集計で確認。取れなければ合成テストで代替してよいか判断 | ChatGPT / ユーザー、10/14 |
| U2 | 未処理イベントの判定方法（1.5） | SQL 定数 ＋ ソース不変条件テスト。代替は「Edge が申告した event_type を DB が許可リストで検証」 | Codex レビュー時 |
| U3 | 照合証拠の置き場（`verification_detail` jsonb か `mic_state_evidence` の新種別か） | Stage 1 は jsonb。型付き証拠は Stage 2 以降に再検討 | 実装前 |
| U4 | baseline に source_key・行 id を持たせるか | Stage 1 では持たせない（material 経路を触らない）。複数 source 化が決まったら別工程 | 将来 |
| U5 | 同日改定を検出したときに AI 再評価を促すか | Stage 1 は記録のみ（verified にしない）。AI 条件は変えない | Stage 2 |
| U6 | fetch / observation の状態を DB が view から再計算するか、Edge の値を信用するか | DB が view から再計算する（本書の案）。コストは domain あたり数行 | 実装前に確定 |
| U7 | `delayed_expected` を照合可とするか | 可（shadow と同じ）。Stage 2 で重み付けを検討 | Stage 2 |
| U8 | macro は always_material が多く `verified` がほぼ出ない | 想定どおりとして受け入れる（macro は Stage 2 の照合延命の対象外の候補） | Stage 2 |
| U9 | 全 no_change を新 RPC に一本化するか、候補のときだけ新 RPC にするか | 一本化（経路が 1 本の方がテストと監査が単純） | 実装前に確定 |
| U10 | migration の version | 実装時に予約（現時点では未予約。不変条件テストの RESERVED に追加） | 実装時 |
| U11 | 誤って verified になった run の除外方法 | Stage 2 の読み取り側で除外リストを持つか、run に無効化フラグを持たせるか | Stage 2 前 |

---

## 10. 実装順序

1. **S1-A（source、DB）**: migration（run 列・制約・FK、current 列・制約・FK、トリガー、新 RPC）＋ SQL テスト（6.1）＋ 変異テスト。
   → DB / RPC / 競合制御のため **Codex レビュー対象**。
2. **S1-B（source、Edge）**: 新 RPC を呼ぶ writer と index.ts の no_change 2 分岐の切り替え ＋ Edge テスト（6.2）。
   S1-A と同じ PR でもよい（レビューをまとめる）。
3. **main 統合**: レビュー済みの内容のまま。
4. **Production（migration）**: 7 章の手順で 1 本だけ適用。旧 Edge のまま自然実行を 1 回観測。
5. **Production（Edge）**: state-evaluator だけを deploy、本番のソースと main をバイト比較、自然実行で
   `verified` / `not_verified` の記録を確認。
6. **観測**: shadow と DB 判定の一致率（`db_rederivation_mismatch` 0 件）、AI 呼び出しの不変、記録サイズ。

---

## 11. Stage 1 実装 GO 条件

すべて満たしたら S1-A に着手してよい。

1. 10/14 以降の shadow 集計で `comparison_mismatch` 0、`shadow_error` 0、shadow 欠落 0、失敗 run の増加なし、no_change での AI 呼び出し 0。
2. rates で `no_new_observation` と `below_threshold` の両方が確認済み（済）。equity は U1 の判断に従う。
3. `not_verifiable` の主な理由が説明できている（10/10 時点: commodities の identity 欠落 1 件と EIA の観測 stale 2 件のみ）。
4. 本書の U2・U3・U6・U9 について、実装前に方針が確定している。
5. 本書 0.2 の Production 前提（単一 source、タイ 0、RPC 2 本、トリガー構成）が着手時点でも変わっていない（read-only で再確認）。
6. MIC の State evaluator・migration に、他 workstream の変更が入っていない。

---

## 付録 A. migration の骨子（設計のみ。ファイルは作成しない）

```sql
begin;

alter table public.mic_state_evaluation_runs
  add column if not exists verification_status text,
  add column if not exists verification_reason text,
  add column if not exists verified_source_evaluation_run_id uuid
    references public.mic_state_evaluation_runs(id),
  add column if not exists verification_fingerprint text,
  add column if not exists verified_metric_count integer,
  add column if not exists verified_observation_as_of timestamptz,
  add column if not exists verification_detail jsonb;

alter table public.mic_state_evaluation_runs
  add constraint mic_state_evaluation_runs_verification_shape_check check (...3.1...);

alter table public.market_state_current
  add column if not exists verified_at timestamptz,
  add column if not exists verification_run_id uuid
    references public.mic_state_evaluation_runs(id);

alter table public.market_state_current
  add constraint market_state_current_verification_pair_check
    check ((verified_at is null) = (verification_run_id is null)),
  add constraint market_state_current_verified_after_ai_check
    check (verified_at is null or ai_evaluated_at is null or verified_at >= ai_evaluated_at);

create or replace function public.market_state_current_verification_guard() ...;  -- 3.3
create trigger trg_market_state_current_verification
  before update on public.market_state_current
  for each row execute function public.market_state_current_verification_guard();

create or replace function public.apply_mic_state_verified_no_change_update(...) ...;  -- 2.2〜2.4
revoke all on function public.apply_mic_state_verified_no_change_update(...) from public, anon, authenticated;
grant execute on function public.apply_mic_state_verified_no_change_update(...) to service_role;

commit;
```

- 既存の `apply_mic_state_no_change_update` / `apply_mic_state_material_update` には触れない。
- 新しいテーブルは作らない（`ensure_rls` の対象外）。
