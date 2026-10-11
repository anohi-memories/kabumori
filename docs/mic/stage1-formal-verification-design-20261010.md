# MIC Stage 1 — 正式 Verification 詳細設計（実装準備）

状態: **DESIGN ONLY**。ソースコード変更 0、migration 作成・適用 0、Production 変更 0。

| 版 | 日付（JST） | 内容 |
| --- | --- | --- |
| v1 | 2026-10-10 | 初版（基点 `origin/main` `d9bb99d2`、PR #125 head `7e548b9f`） |
| v2 | 2026-10-11 | G7 補強。ChatGPT 設計判断（[PR #125 コメント](https://github.com/anohi-memories/kabumori/pull/125#issuecomment-6096779221)）の U2 / U3 / U6 / U9 を反映。単一スナップショット設計（1.7）、イベント判定の Edge との一致（1.5）、ポインタの意味と Stage 2 の読み取り規約（3.4）、A1 の記述統一、誤 verified の無効化（3.5）、テスト計画・rollback を補強 |

前提となる工程:

- Stage 0（JGB 現行ファイル、正確な小数比較、観測の猶予）: Production 反映済み。
- Stage 1 Slice 0（`decision_detail.verification_shadow` v1）: main 統合 `427b2931`、
  Production state-evaluator **v32**（2026-10-07 16:11 JST）。
  10/10 14:11 JST までの観測: no_change 33 件すべてに shadow、`comparison_mismatch` 0、
  `shadow_error` 0、失敗 run 0、no_change での AI 呼び出し 0。

この文書は、10/14 以降の自然 shadow 観測が PASS し、**別途 ChatGPT が正式実装を許可した場合に**、
追加の大規模調査なしで S1-A に着手できる状態にすることを目的とする。
**本書の完成は Stage 1 正式実装の GO ではない**（11 章）。
数値（96h / 168h / 0.64 / AI backstop 96h）は Stage 2 の仮値であり、**本書では採用しない**。

---

## 0. 調査結果（現行実装の事実）

### 0.1 調査したファイル

| 種別 | パス |
| --- | --- |
| State evaluator | `supabase/functions/market-intelligence-state-evaluator/index.ts`、`mic_state_decision_logic.ts`、`mic_state_query_logic.ts`、`mic_state_types.ts`、`mic_state_run_logic.ts`、`mic_state_writer_logic.ts`、`mic_state_verification_shadow.ts`（とテスト） |
| Ingest | `supabase/functions/market-intelligence-ingest/mic_writer_logic.ts` |
| Scenario | `supabase/functions/_shared/mic_scenario/{policy,read_gate,read_adapter}.ts`、`market-intelligence-scenario-evaluator/mic_scenario_run_logic.ts` |
| Consumer | `supabase/functions/personalized-reports/mic_market_context.ts` |
| Migration | `20260912090000_add_market_intelligence_core_phase1a.sql`（market_metrics / market_events）、`20260913090000_add_market_intelligence_state_layer_phase1b.sql`（State 層・view）、`20260915090000_mic_phase1b_hardening_stale_after_threshold.sql`（観測 view 現行版）、`20260924150000_mic_state_evidence_phase2c1.sql`（State RPC・evidence）、`20260928120000_mic_scenario_layer_phase3a.sql`、`20261002090000_mic_jgb_nikkei_observation_grace_stage0.sql` |
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
9. **イベントの取得（Edge）**: `fetchRecentDomainEvents` は `event_type in (domain の種別)` を
   `order=published_at.desc&limit=50` で取得する（期間指定なし。同時刻のタイの決め手なし）。
   domain の種別は `DOMAIN_EVENT_TYPES`（rates: `rate_decision`, `central_bank_decision`、macro: `macro_release`、
   geopolitical / corporate_events は別一覧、fx / commodities / equity_index は空）。
   `unseenEvents` は「`source_event_ids` に無い」「`updated_at` が欠損・不正」「`ai_evaluated_at` が欠損・不正」
   「`updated_at > ai_evaluated_at`」のどれかを未処理とする（欠損・不正は安全側＝未処理）。
   未処理のうち importance が high / critical なら material。
   material 更新時の `source_event_ids` は、その時の最大 50 件の id 一覧。
10. **market_events のスキーマ**: `updated_at timestamptz not null default now()` で、
    `trg_market_events_updated_at` が更新のたびに進める（DB 上で欠損は起きない）。
    `importance` は nullable（null は high / critical ではない）。同じ id のまま内容が上書き更新される。

---

## 1. 正式 Verification 詳細設計

### 1.1 用語

- **verified**: その run の時点で、current の narrative が根拠とした baseline 以降に新しい観測が 1 件以上あり、
  そのすべてが閾値未満で、ほかの成立条件もすべて満たしたことを **DB が確認した**状態。
- **not_verified**: verified の条件を 1 つでも満たさない状態。理由コードを必ず残す。
  - **neutral（中立）**: 唯一の理由が `no_new_observation`。事実が前回から動いていないだけ。
  - **negative（否定）**: それ以外のすべての理由。
- `verified_at` は 1.7 で定義する時刻。`ai_evaluated_at`（narrative を書いた時刻）とは別物で、
  **`ai_evaluated_at` は書き換えない**。

### 1.2 成立条件（すべて DB の 1 トランザクション内で判定）

| # | 条件 | 判定方法（DB） | 不成立時の reason |
| --- | --- | --- | --- |
| A1 | narrative identity 一致 | ロック済みの current 行で `source_evaluation_run_id = p_verified_source_evaluation_run_id`、かつ narrative / `ai_evaluated_at` / baseline が non-null | `identity_mismatch` / `identity_missing` |
| A2 | 必要な metric が揃っている | `mic_metric_domain_map` の domain の全 metric が Edge の申告に 1 回ずつ含まれ、余分な metric が無い | `metric_set_mismatch` |
| A3 | coverage full | DB が全 metric の最新行を見つけられる（**DB 再計算、U6**） | `coverage_partial` / `coverage_unavailable` |
| A4 | fetch acceptable | DB が `v_mic_source_fetch_status` から関係する全 source を再計算し、すべて `fresh`（**U6**） | `fetch_not_fresh` |
| A5 | observation acceptable | DB が `v_mic_metric_observation_status` から再計算し、全 metric が `fresh` / `delayed_expected`（**U6**） | `observation_not_acceptable` |
| A6 | 観測 identity が成立 | 1.3 の手順で全 metric の最新行を DB が特定でき、Edge の申告と一致 | `latest_observation_changed` / `latest_observation_ambiguous` / `observation_identity_missing` |
| A7 | 改定・後退が無い | baseline と同じ観測日時で値が違う（改定）、または baseline より古い（後退）metric が無い | `observation_revised` / `observation_regressed` |
| A8 | 新しい観測が 1 件以上 | baseline より新しい観測日時の metric が 1 件以上 | `no_new_observation`（neutral。**verified_at を進めない**） |
| A9 | 閾値比較がすべて正常 | 新しい観測の全 metric で、定義済みの閾値すべてを numeric で比較できた | `threshold_undefined` / `comparison_unavailable` |
| A10 | material change なし | always_material の新観測なし、abs / pct のどれも閾値未満 | `material_change` |
| A11 | 未処理の material イベントなし | 1.5 の条件で high / critical の未処理イベントが 0 件、かつ種別一覧が一致 | `event_pending` / `event_outside_window_revised` / `event_type_mapping_mismatch` / `event_scan_limit` |
| A12 | stale guard なし | all-stale 分岐（`decision_detail.ai_skipped`）の run ではない | `all_stale_guard` |
| A13 | 競合する State 更新なし | 既存の CAS（`updated_at`）と run 開始時刻の確認を通過 | （RAISE。2.4 参照） |
| A14 | Edge と DB の判定が一致 | Edge が照合候補（shadow が `below_threshold`）で、DB の判定も verified | `db_rederivation_mismatch` |
| A15 | 監査証拠を完全に保存 | 3.1 の run 列・`verification_detail`・DB fingerprint を同一トランザクションで書く。証拠の必須項目が 1 つでも欠ければ verified にしない（**U3**） | `evidence_incomplete`（書き込み自体の失敗は RAISE） |

- **RAISE するのは A13（既存の CAS）と書き込み失敗だけ**。A1 を含むそれ以外の不成立は RAISE せず、
  no_change の状態更新は旧 RPC とまったく同じに行い、`verification_status = 'not_verified'` と理由を記録する。
  - A1 を RAISE にしない理由: A13 の CAS を通過した時点で、current は Edge が読んだ時点から変わっていない。
    したがって A1 の不一致は Edge 側の不具合でしか起きず、no_change の状態更新自体は正しい。
    旧 RPC はこのケースで RAISE しないので、RAISE にすると State run の成否が旧 RPC と変わってしまう。
    照合結果だけを negative として記録するのが、既存挙動との互換と安全側の両立になる。（v1 の記述不一致を解消）
- reason が複数ある場合は上の表の順を優先順位とし、先頭を `verification_reason` に、
  全件を `verification_detail.blocking_reasons` に残す（shadow と同じ方式）。
- DB は Edge が照合候補かどうかに関係なく**毎回すべてを判定する**（U9 で全 no_change を新 RPC に通すため）。
  Edge の候補申告は A14 の照合にだけ使う。

### 1.3 観測 identity（正式版）

**結論**: 正式な観測 identity は
`(metric_key, source_key, dedupe_anchor_at)` ＋ `market_metrics.id` ＋ `value` の組とし、
**DB が自分で最新行を選び直す**。view は変更しない。

手順（1.7 の事実取得文の中で、metric ごと）:

1. Edge は metric ごとに `{metric_key, observed（date または timestamp）, value}` を送る
   （shadow の `latest` と同じ値）。行 id は送らない（view が返さないため）。
2. DB は `market_metrics` から、その metric の `dedupe_anchor_at` 最大の行を
   `order by dedupe_anchor_at desc, id desc` で選ぶ。**行ロックは取らない**（1.7）。
3. 同じ `dedupe_anchor_at` を持つ行が 2 行以上ある、またはその metric に source_key が 2 種類以上ある場合は
   `latest_observation_ambiguous`（現時点の Production では 0 件。将来の複数 source 化への備え）。
4. DB の行の anchor・value が Edge の申告と一致しなければ `latest_observation_changed`
   （Edge が読んでから DB の事実取得までに新しい観測が入った、または同日改定があった）。
5. 証拠として `market_metric_id`、`source_key`、anchor、`value`、`fetched_at` を保存する。

各ケースの扱い:

| ケース | 判定 | 結果 |
| --- | --- | --- |
| 同じ値で観測日が新しい | anchor が baseline より後 | 新しい観測（閾値比較へ） |
| 同日の再取得で値も同じ | anchor・value とも baseline と同じ | 変化なし（新しい観測ではない） |
| 同日の改定（値だけ違う） | anchor が同じで value が違う | `observation_revised`（verified にしない。AI 条件は変えない＝U5） |
| 観測日時の後退 | anchor が baseline より前 | `observation_regressed` |
| 行の置き換え（delete → insert） | 現行コードに経路は無い。起きても DB が選び直すので、anchor・value が同じなら同等、違えば 4. で検出 | 安全側 |
| 欠損 | 最新行が無い | `coverage_partial` |
| 時刻精度の違い | anchor は `dedupe_anchor_at`（date は UTC 0 時、timestamp は実時刻）で比較。baseline 側は `time_precision` に応じて `observedDate` / `observedAt` から anchor を作る。精度が食い違えば `observation_identity_missing` | 安全側 |
| Edge 読み取り後・DB 事実取得前の新 anchor 行 INSERT | DB の事実取得で見える → 4. で不一致 | `latest_observation_changed` |
| DB 事実取得後の新 anchor 行 INSERT / 同日 upsert | この照合のスナップショットには入らない。commit 時刻は `verified_at` より後になる（1.7） | この照合の主張は崩れない。次の run が拾う |

- **既存行への `FOR SHARE` は採らない**（v1 から変更）。`FOR SHARE` は既存行の UPDATE を待たせるだけで、
  より新しい `dedupe_anchor_at` の**別行の INSERT は防げない**。また ingest の upsert を待たせ、
  window 関数・集約と同じ SELECT では使えない。整合性は 1.7 の単一スナップショットで保証する。
- baseline 側は source_key と行 id を持たないが、現状は全 metric が単一 source なので
  `(metric_key, anchor)` で一意に対応する。3. の確認で、この前提が崩れたら照合しない。
- 値の比較は Postgres の `numeric` の等価比較で行う（`3.0970 = 3.097` は真）。
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

### 1.5 未処理イベント（A11、U2 条件付き採用）

**SQL 側の種別一覧**: RPC 内に domain → event_type の一覧を SQL 定数として持つ。
Edge の `DOMAIN_EVENT_TYPES` と完全一致することを、migration と TS を読み比べるソース不変条件テストで固定する。
さらに実行時にも Edge が `p_event_types`（自分が使った一覧）を送り、DB の定数と一致しなければ
`event_type_mapping_mismatch` で verified にしない（デプロイ順の食い違いへの備え）。

**DB が調べる範囲**（1.7 の事実取得文の中、ロックなし）:

1. **Edge と同じ窓 W**: domain の種別のイベントのうち、`published_at` 降順で 50 番目のイベントの
   `published_at` 以上のもの全部（同時刻のタイは全部含める＝Edge の 50 件の上位集合）。
   W の中で `importance in ('high','critical')` かつ
   「`id` が current の `source_event_ids` に無い、または `updated_at` が null、または `ai_evaluated_at` が null、
   または `updated_at > ai_evaluated_at`」のものがあれば `event_pending`。
   （DB 上で `updated_at` が null になることは無いが、Edge の `unseenEvents` と同じ安全側の条件を書いておく）
2. **窓の外**: W より古いイベントのうち、high / critical で `updated_at > ai_evaluated_at`（narrative の後に改定された）
   ものがあれば `event_outside_window_revised`。Edge はこれを見落とすので、DB で検出して verified にしない。
3. 窓の外で、narrative より前から変わっていないイベントは対象外（Edge も見ない。narrative 作成時にも
   50 件の外だったか、窓がずれただけで、新しい情報ではない）。
4. 走査件数の上限: W が 500 件を超える（同時刻の異常な大量投入など）場合は `event_scan_limit` で verified にしない。

Edge との差の整理:

| 差 | Edge | DB | 結果 |
| --- | --- | --- | --- |
| 同時刻タイで 50 件目の前後が不定 | 50 件のどれか | タイを全部含める | DB が厳しい側（過剰な not_verified はあり得るが偽の verified は無い） |
| 50 件より古い high の同 id 改定 | 見落とす | 2. で検出 | not_verified（Edge が見落とした事実を DB が拾う） |
| Edge の読み取り後に high の新規イベント | 見えない | 見える | not_verified（次の run で Edge が material 判定） |
| Edge の読み取り後に同 id 改定（importance が high に） | 見えない | 見える | not_verified |
| DB 事実取得後のイベント | — | 見えない | commit 時刻が `verified_at` より後なので、この照合の主張は崩れない |
| low / medium / null の未処理 | material にしない | 照合を妨げない（id は証拠に残す） | 既存の material 方針と同じ |
| 種別一覧の食い違い（片方だけ更新） | — | `event_type_mapping_mismatch` | not_verified。種別を変えるときは migration → Edge の順で同時に出す |

### 1.6 Narrative identity の保護

- `source_evaluation_run_id`、`ai_evaluated_at`、`numeric_baseline_snapshot`、narrative 系の列は
  照合 RPC から**一切書かない**（UPDATE の SET 句に含めない）。
- 照合結果は「どの narrative に対する照合か」を `verified_source_evaluation_run_id` として run に保存する。
- current の照合ポインタは、narrative が変わった瞬間に自動で null に戻す（3.3 のトリガー）。
  別の narrative に対する照合ポインタが current に残ることは無い。

### 1.7 スナップショットの一貫性と `verified_at` の意味（U6 / 指摘 1・5）

前提: PostgREST の RPC は 1 トランザクション・READ COMMITTED で動く。READ COMMITTED では
PL/pgSQL 関数の中でも **SQL 文ごとに新しいスナップショット**を取るので、複数の SELECT は
異なる時点の commit 済みデータを見る可能性がある（後の文ほど新しいデータを見る）。

設計:

1. **ロック（既存と同じ 2 つだけ）**: current 行 `FOR UPDATE` → run 行 `FOR UPDATE`。
   ロックを取った後は、current と run は commit まで他者が変えられない。baseline・identity・
   `source_event_ids`・`ai_evaluated_at` はこのロック済みの値を使う。
2. **事実取得文 F（1 文だけ）**: domain map、全 metric の最新行（1.3）、fetch 状態（`v_mic_source_fetch_status`）、
   観測状態（`v_mic_metric_observation_status`）、イベントの窓 W と窓の外の改定（1.5）を、
   **1 つの SQL 文（CTE で組み立てて jsonb 1 つを返す）**で読む。F の中のすべての参照は同じスナップショット S_F を見る。
3. F の後は、F が返した jsonb とロック済みの current 行の値だけで判定する（**追加のテーブル読み取りをしない**）。
   この規則は SQL のソース不変条件テストで固定する（関数本文で `market_metrics` / `market_events` / 2 つの view を参照する文が 1 つだけであること）。
4. **market_metrics / market_events に行ロックを取らない**。ingest は照合 RPC を一切待たず、
   照合 RPC も ingest を待たない（ロック順の逆転・デッドロックが起きない）。

`verified_at` の定義:

- `verified_at = now()`（トランザクション開始時刻 T0）。
- S_F は T0 より後に取られる。したがって **T0 より前に commit された事実はすべて S_F に見えている**。
- S_F の後に commit された事実（新しい anchor 行、同日 upsert、新規・改定イベント）は照合に入らないが、
  その commit 時刻は必ず T0 より後である。
- よって `verified_at` の意味は「**この時刻までに DB に commit 済みだった事実はすべて照合に含まれ、
  そのうえで narrative と矛盾する material な変化が無かった**」と確定する。
  T0 から S_F までに commit された事実も含まれている分、主張は控えめ（安全側）になる。
- Edge が読んだ時点と S_F の差は、1.3 の 4. と 1.5 で not_verified として扱う（偽の verified にならない）。
- view の中の `now()` も T0 なので、観測状態・fetch 状態の年齢計算は S_F と同じ基準時刻で行われる。

比較した代替案:

| 代替案 | 採らなかった理由 |
| --- | --- |
| REPEATABLE READ に上げる | PostgREST の RPC 呼び出しは既定の READ COMMITTED で、関数の中から途中で変更できない。設定を変えると他の RPC にも波及する |
| 既存行への `FOR SHARE` | 新しい anchor 行の INSERT を防げない。ingest を待たせる。window / 集約と併用できない |
| ingest と共有する advisory lock | ingest（別 workstream の Edge）の変更が必要。ロック責務とデッドロック解析が増える。単一スナップショットで足りる |
| 事実取得後の再確認（post-check） | 単一スナップショットで一貫性は得られており、再確認しても commit までの隙間は残る。複雑さに見合わない |

---

## 2. RPC / トランザクション設計

### 2.1 方針（U9 採用）

- **新しい RPC を追加する**: `apply_mic_state_verified_no_change_update`。既存の
  `apply_mic_state_no_change_update` / `apply_mic_state_material_update` は**変更も削除もしない**（旧 RPC は rollback 用に残す）。
- Edge は正式実装後、**すべての no_change（通常の no_change と all-stale 分岐の両方）を新 RPC で書く**。
  照合候補でない場合・照合が成立しない場合も新 RPC を通し、`not_verified` と理由を記録する。
- 新 RPC の「no_change としての書き込み」（状態 5 列の更新、run の `no_change` 化、`decision_detail`）は
  旧 RPC と**完全に同じ**にする。違いは照合の判定・記録と、ポインタの更新だけ。

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
  p_observations jsonb,                -- [{metric_key, observed, value}]（domain の全 metric）
  p_event_types text[]                 -- Edge が使った domain の種別一覧（1.5）
) returns table(result_status text, verification_status text, verification_reason text)
```

- `security invoker`、`set search_path = ''`、`service_role` のみ EXECUTE（既存 RPC と同じ権限設計）。
- 状態 5 列（coverage / fetch / observation / data_confidence / as_of）は、旧 RPC と同じく Edge の値をそのまま書く
  （State の表示値は変えない）。DB の再計算値（U6）は照合の判定と証拠にだけ使い、食い違いは
  `verification_detail.status_rederivation` に記録する。

### 2.3 処理順（1 トランザクション）

```
1. current 行を FOR UPDATE（既存と同じ）
2. run 行を FOR UPDATE、domain 一致を確認（既存と同じ）
3. run が既に no_change → already_applied を返す（冪等。照合の記録は 1 回目のもののまま）
4. CAS: expected updated_at 一致、run が running、current.updated_at <= run.started_at
   （既存と同じ。不一致は RAISE）
5. decision_detail がオブジェクトであること（既存と同じ）
6. 事実取得文 F を 1 回だけ実行（1.7）
7. 判定（追加の読み取りなし）: A1〜A12、A14、A15。DB fingerprint を計算（3.1）
8. run を no_change に更新（既存と同じ列）＋ 照合列（3.1）を同じ UPDATE で書く。
   row_count <> 1 なら RAISE
9. current の状態 5 列を更新（既存と同じ）。同じ UPDATE でポインタを更新（3.4）:
   verified → verified_at = now()、verification_run_id = p_run_id
   neutral  → ポインタは変えない
   negative → verified_at = null、verification_run_id = null
   （3.3 のトリガーが 8 で書いた run の照合列を確認するため、run → current の順にする）
10. result_status = 'applied'
```

- ロック順は「current → run」だけ（既存 RPC と同じ）。Scenario の Phase 3A RPC は current を
  `FOR SHARE` するだけなので、待ち合わせは起きても循環は生じない。ingest とはロックを共有しない。

### 2.4 失敗時の挙動（fail-closed）

| 事象 | 挙動 | 結果 |
| --- | --- | --- |
| CAS 不一致・run が running でない・current が run 開始後に更新済み（A13） | RAISE（既存と同じコード） | 全体がロールバック。run は Edge が failed にするか 15 分後に回収。State は変わらない |
| narrative identity 不一致・欠損（A1） | **RAISE しない**。`identity_mismatch` / `identity_missing`（negative） | no_change は通常どおり確定、`not_verified`、ポインタは消える。理由は 1.2 |
| その他の照合条件の不成立（A2〜A12、A14、A15 の証拠欠損） | RAISE しない | no_change は通常どおり確定、`not_verified` と理由を記録。ポインタは 3.4 の規則 |
| 照合列の書き込み失敗・制約違反・トリガーの拒否 | RAISE | 全体がロールバック（状態更新も残らない）。既存の失敗時と同じ扱い |
| 引数の形の不正（p_observations が配列でない等） | `not_verified`（`evidence_invalid`）。JSON として読めないなど構造的に処理できない場合は RAISE | 安全側 |

### 2.5 Edge 側の変更（正式実装時、S1-B）

- `applyNoChangeUpdate` の代わりに新 RPC を呼ぶ `applyVerifiedNoChangeUpdate` を追加し、
  index.ts の no_change 2 分岐（通常・all-stale）をどちらも新 RPC に切り替える。
- `p_verification_candidate` = `verificationShadow.status === "below_threshold"`（all-stale 分岐は常に false）。
- `p_verified_source_evaluation_run_id` = shadow の `narrative_identity.source_evaluation_run_id`。
- `p_observations` = shadow の `metrics[]` から `{metric_key, observed: latest.observed, value: latest.value}`。
- `p_event_types` = `eventTypesForDomain(domain)`。
- 新 RPC の戻り値の `verification_status` / `verification_reason` は run 結果のログに含めるだけで、判定には使わない。
- material 判定、AI 呼び出し条件、material RPC への引数は**変更しない**。

---

## 3. DB 変更案（migration は設計のみ、未作成）

### 3.1 `mic_state_evaluation_runs` への追加列（U3 採用）

| 列 | 型 | 意味 |
| --- | --- | --- |
| `verification_status` | `text null` check in (`verified`, `not_verified`) | null は正式実装前の run と material run |
| `verification_reason` | `text null` | verified のときは `below_threshold`、not_verified のときは主な理由 |
| `verified_source_evaluation_run_id` | `uuid null` FK → `mic_state_evaluation_runs(id)` | 照合した narrative |
| `verification_fingerprint` | `text null` | DB が計算した事実の sha256（`sha256:` + 64 hex） |
| `verified_metric_count` | `integer null` | 閾値比較した新しい観測の数 |
| `verified_observation_as_of` | `timestamptz null` | 照合した新しい観測の最大 anchor |
| `verification_detail` | `jsonb null` | 下記の DB 由来の証拠 |

`verification_detail`（不変。run の終了後は既存トリガーで変更不可）の必須項目:

- `version`（1）、`snapshot`（`verified_at` の値、事実取得文 F の実行を示す印）
- `metrics[]`: `metric_key`、`market_metric_id`、`source_key`、anchor、`value`、`fetched_at`、
  baseline の anchor と value、閾値（kind / abs / pct / always_material）、正確な変化量、判定結果
- `fetch_status_by_source`、`observation_status_by_metric`（DB 再計算値、U6）と `status_rederivation`（Edge 申告値との差）
- `events`: 窓 W の境界（50 件目の `published_at`、件数）、未処理の high / critical の id、窓の外の改定の id、
  低・中重要度の未処理 id
- `edge_claim`: Edge の候補申告、shadow の status / reason / fingerprint
- `blocking_reasons`、`classification`（`verified` / `neutral` / `negative`）

`verified` のときに上の必須項目が 1 つでも欠けていれば、DB は verified にせず `evidence_incomplete` にする。

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
      and verification_reason is not null
      and jsonb_typeof(verification_detail) = 'object')
)
```

- 既存行はすべて null なので、制約の追加は既存データと矛盾しない（220 行、走査は一瞬）。
- 型付き `mic_state_evidence` の拡張は後続判断（U3）。

DB fingerprint の入力（事実取得文 F の値から計算し、Edge の値は使わない）:

```
'v1' / domain / verified_source_evaluation_run_id /
metric ごとに metric_key | source_key | market_metric_id | dedupe_anchor_at | trim_scale(value)
            | baseline anchor | trim_scale(baseline value) | abs_thr | pct_thr | always_material
窓 W の境界 / 未処理イベント（全重要度）ごとに id | updated_at | importance
→ metric_key 順・event id 順に連結 → extensions.digest(..., 'sha256')
```

- Edge の shadow fingerprint とは正規化の方式が違うので値は一致しない。両方を保存し、
  DB 側を正式な `verification_fingerprint` とする。

### 3.2 `market_state_current` への追加列

| 列 | 型 | 意味 |
| --- | --- | --- |
| `verified_at` | `timestamptz null` | 現在の narrative を最後に verified にした時刻（1.7 の定義） |
| `verification_run_id` | `uuid null` FK → `mic_state_evaluation_runs(id)` | その run |

制約: `(verified_at is null) = (verification_run_id is null)`、`verified_at >= ai_evaluated_at`。

- 既存 7 行はすべて null。Scenario・personalized-reports は select する列を明示しているので影響しない。
- material RPC の history（`to_jsonb(v_current)`）には新しい 2 列が自動で入る。
  これは「置き換えられた narrative が最後にいつ照合されていたか」の記録として有用で、
  history を読むのは material RPC の `already_applied` 判定（`snapshot->>'source_evaluation_run_id'` のみ）だけなので無害。

### 3.3 トリガー（current、BEFORE UPDATE）

```sql
-- 1) narrative identity が変わったら照合ポインタを必ず消す（material RPC を書き換えずに済む）
if new.source_evaluation_run_id is distinct from old.source_evaluation_run_id then
  new.verified_at := null;
  new.verification_run_id := null;
end if;
-- 2) 非 null のポインタは、どの UPDATE でも（新規設定のときだけでなく）正当性を確認する
if new.verification_run_id is not null then
  if not exists (
    select 1 from public.mic_state_evaluation_runs r
    where r.id = new.verification_run_id
      and r.domain = new.domain
      and r.status = 'no_change'
      and r.verification_status = 'verified'
      and r.verified_source_evaluation_run_id = new.source_evaluation_run_id
      and r.completed_at = new.verified_at
  ) then
    raise exception 'MIC_STATE_VERIFICATION_POINTER_INVALID';
  end if;
end if;
```

- 2) は no_change・material・旧 RPC・手作業のすべての UPDATE で走る。これにより
  「ポインタは常に、今の narrative を verified にした run を指し、`verified_at` はその run の完了時刻と同じ」
  が不変条件になる（新 RPC は 8 と 9 で同じ `now()` を `completed_at` と `verified_at` に書く）。
- ポインタを null にする UPDATE は常に許可される（無効化・rollback の手段を塞がない）。
- 既存トリガー `trg_market_state_current_updated_at` との順序は名前順（`..._updated_at` < `..._verification`）で、
  互いに独立した列しか触らない。

### 3.4 ポインタの意味と Stage 2 の読み取り規約（指摘 3）

ポインタの更新規則（2.3 の 9）:

| その run の分類 | ポインタ | 理由 |
| --- | --- | --- |
| verified | この run に更新 | 新しい事実と照合できた |
| neutral（`no_new_observation` のみ） | 変えない | 事実が前回の照合から動いていないので、前回の verified はそのまま最新の事実を表す |
| negative（それ以外すべて） | **null に戻す** | 観測の stale 化、fetch 失敗、改定、未処理イベント、Edge と DB の不一致などは、前回の成功を無効にし得る |

不変条件: **current のポインタが非 null なら、それは今の narrative を verified にした run を指し、
その run 以降の同じ narrative の run はすべて verified か neutral だった**。
（material 更新では 3.3 の 1) で消え、negative では 9 で消える）

Stage 2 の読み取り規約（Stage 2 で実装、Stage 1 では誰も読まない）:

1. 照合の鮮度はポインタ（`verified_at`）だけから読む。**run の履歴を検索して「過去の成功」を探さない**。
2. 使ってよいのは、次をすべて満たすときだけ:
   - ポインタが非 null で、指す run が `verified` かつ `verified_source_evaluation_run_id = current.source_evaluation_run_id`
   - `verified_at >= ai_evaluated_at`
   - その domain の**最新の終了済み State run**が `verification_status` を持っている（新 RPC が稼働中であること。
     旧 Edge へ rollback 中は negative によるポインタ消去が働かないため、Stage 2 はポインタを使わない）
   - その run が無効化一覧（3.5）に載っていない
   - `verified_at` の経過時間が Stage 2 の上限以内（値は Stage 2 で決める）
3. どれか 1 つでも満たさなければ、照合情報が無いものとして扱う（現行の Scenario の判定に戻る）。

### 3.5 誤った verified の無効化（U11、指摘 3・7）

run は不変なので、誤 verified の記録そのものは消さず、「使わない」仕組みで対処する。

- **Stage 1 の間**: Stage 1 ではポインタを誰も読まないので、実害は無い。緊急時の手段は
  (a) Edge を旧 RPC 版（v32 相当）に戻して新しい verified を止める、
  (b) 運用者が該当 domain のポインタを null に戻す（3.3 で常に許可。Production write なので別途許可が必要）。
- **Stage 2 の GO 条件**: Stage 2 でポインタを読む前に、無効化一覧
  `mic_state_verification_invalidations(run_id uuid primary key references mic_state_evaluation_runs(id), reason text not null, invalidated_at timestamptz not null default now(), invalidated_by text not null)`
  （追記のみ、更新・削除不可、service_role のみ書き込み）を作り、
  無効化した run を指すポインタは同じトランザクションで null に戻す関数と、3.3 の 2) に「無効化一覧に無いこと」を加える。
  新テーブルは本番の `ensure_rls` 対象になるので、Stage 2 の migration で扱う（S1-A には含めない。U11）。

### 3.6 採らなかった案

| 案 | 採らなかった理由 |
| --- | --- |
| `mic_state_evidence` に `metric_observation` 種別を追加 | 種別の check 制約の付け替えと `market_metrics` への FK（on delete restrict）が要り、変更範囲が広い。U3 で後続判断 |
| 照合専用テーブルを新設 | 本番の `ensure_rls` と権限設計の対象が増える。run 行は既に不変なので監査性は同等 |
| view に `market_metrics.id` を追加 | view の再定義は他の読み手（market-report-data-packet）へ波及する。DB が自分で最新行を選び直す方が安全 |
| baseline に source_key・行 id を追加 | material（AI）経路の変更になる。Stage 1 では触らない（U4） |
| `updated_at` を鮮度に使う / `ai_evaluated_at` を更新 | 古い narrative を新しく見せてしまう |
| negative でもポインタを残し、Stage 2 が run 履歴で判断 | 読み取り側が複雑になり、「過去の成功」で延命する誤りを招く。指摘 3 により不採用 |

---

## 4. 競合対策

| 競合 | 対策 | 結果 |
| --- | --- | --- |
| State AI 評価（material RPC）と照合が同時 | 両 RPC とも current を `FOR UPDATE` → 直列化。後に来た方は `updated_at` の CAS で RAISE（`MIC_STATE_STALE_DECISION`） | 照合が後なら失敗して何も残らない。照合が先なら、その後の material 更新でトリガーがポインタを消す |
| narrative 更新中の照合 | 上と同じ。加えて A1 で `source_evaluation_run_id` を照合 | 別 narrative への照合は保存されない |
| baseline 変更との競合 | baseline は material RPC だけが変える → 上と同じ直列化と CAS。照合はロック済みの current から baseline を読む | 古い baseline に対する照合は保存されない |
| 新しい anchor 行の並行 INSERT（phantom） | 行ロックでは防げないことを前提に、単一スナップショット F で判定（1.7）。F より前の commit は見える → Edge 申告と不一致なら not_verified。F より後の commit は `verified_at` より後 | 偽の verified は生じない |
| 同日行の並行 upsert（改定） | 同上。F に見えれば `observation_revised` または `latest_observation_changed` | 同上 |
| high / critical イベントの並行 INSERT・同 id 改定 | 同上（1.5）。F に見えれば `event_pending` | 同上 |
| 古い run による上書き | 既存の `current.updated_at > run.started_at` で RAISE（`MIC_STATE_STALE_RUN`） | 新しい照合を古い run が上書きできない |
| 並行 Cron 実行 | `(domain, run_window)` の部分一意インデックス（既存）。同じ窓の 2 本目は claim できない | 二重照合は起きない |
| ABA（narrative A → B → A） | identity は内容ではなく run id（uuid、再利用されない）。CAS の `updated_at` も毎回 `now()` で進む | A に戻ったように見えても別 identity として扱われ、古い照合は無効 |
| 照合の重複記録 | 終了した run は不変。RPC は `already_applied` で 2 回目を何もせず返す。ポインタは run id で一意 | 1 run につき 1 回だけ |
| RPC の途中失敗 | 1 トランザクション。RAISE で状態更新・run 更新・ポインタすべてロールバック | 半端な記録は残らない |
| Scenario RPC との競合 | Scenario は current を `FOR SHARE`。照合 RPC の `FOR UPDATE` とは待ち合わせになるだけ。Scenario は `verified_at` を見ない（Stage 1） | Scenario の挙動は不変 |
| ingest とのロック逆転 | 照合 RPC は market_metrics / market_events をロックしない | ingest を待たせない。デッドロックしない |

責任分界:

- **Edge**: material 判定（唯一の正）、AI 呼び出し、shadow の作成、照合候補の申告、no_change の状態値。
- **DB（新 RPC）**: 照合の最終判定（正式な verified はここでしか生まれない）、fetch / observation / coverage の再計算、
  証拠と fingerprint の保存、ポインタの更新と消去。
- **DB（トリガー）**: narrative 変更時のポインタ消去と、非 null ポインタの正当性の常時確認。
- **material RPC・Scenario・consumer**: 変更しない。

---

## 5. Stage 2 との境界

Stage 1 では次を一切変えない: Scenario の AI 再生成条件、freshness 判定、confidence、valid_until、
input_fingerprint、evidence snapshot の 11 キー、read gate。

Stage 2 が使える形で用意するもの:

- current の `verified_at` / `verification_run_id`（3.4 の不変条件つき）。
- run の照合列（照合の根拠を監査できる）。
- 3.4 の読み取り規約と、3.5 の無効化一覧（Stage 2 の migration で作る）。

Stage 2 で決めること（本書では採用しない仮値）: 照合の有効時間（仮 96h）、narrative の絶対上限
（仮 168h）、照合のみの State の confidence 係数（仮 0.64）、AI backstop（仮 96h）、
Scenario の revalidation の要否、evidence snapshot に照合情報を含めるか、同日改定を AI 再評価のきっかけにするか（U5）。

---

## 6. テスト計画

### 6.1 SQL（ローカル PG17、`supabase/tests/` の既存ランナー方式）

正常系:

1. 新しい観測あり・全件閾値未満 → `verified`、ポインタが立つ、`ai_evaluated_at` / baseline / narrative / `source_evaluation_run_id` は不変。
2. 同じ値で観測日だけ新しい → `verified`（変化量 0）。
3. 複数 metric のうち一部だけ新しい観測 → `verified`（`verified_metric_count` = 新しい観測の数）。
4. 同じ narrative で 2 回連続 verified → `verified_at` が進み、ポインタが新しい run に移る。
5. 正式実装前の no_change run（照合列 null）と新 run が共存できる。

異常系:

6. 新しい観測なし → `not_verified` / `no_new_observation`（neutral）、ポインタは動かない。
7. 閾値ちょうど（5.24 → 5.29、閾値 0.05）→ `material_change`。5.24 → 5.289 → `verified`。pct も同様の境界表。
8. 同日改定（anchor 同じ・value 違い）→ `observation_revised`。
9. 観測日時の後退 → `observation_regressed`。
10. coverage 不足・metric 欠損 → `coverage_partial`。
11. stale observation → `observation_not_acceptable`。fetch stale / failed → `fetch_not_fresh`。いずれも Edge の申告が `fresh` でも DB 再計算で検出（U6）。
12. identity 不一致（別 narrative の run id を申告）→ RAISE せず `identity_mismatch`、no_change は確定、ポインタは消える（A1 統一の確認）。
13. 比較不能（pct のみで baseline 0）・閾値未定義 → それぞれの reason。
14. all-stale 分岐 → `all_stale_guard`（新 RPC 経由、U9）。
15. Edge の申告と DB の最新行が違う → `latest_observation_changed`。
16. 同じ anchor の行が 2 行（source 違い）→ `latest_observation_ambiguous`。
17. 証拠の必須項目が欠ける（テスト用に p_observations を欠落させる）→ verified にしない。

イベント（1.5）:

18. 窓 W 内の未処理 high（`source_event_ids` に無い）→ `event_pending`。low / medium / null は照合を妨げない。
19. `updated_at > ai_evaluated_at` の同 id 改定 → `event_pending`。`ai_evaluated_at` が null → 未処理扱い。
20. 60 件のイベントで、51 件目以降の high が narrative 前から不変 → 対象外（verified 可）。51 件目以降の high が narrative 後に改定 → `event_outside_window_revised`。
21. 50 件目と同時刻のタイが 3 件 → 3 件とも窓に含まれる。
22. 窓が 500 件を超える → `event_scan_limit`。
23. `p_event_types` が SQL 定数と違う → `event_type_mapping_mismatch`。

競合（2 セッション）:

24. 新しい anchor 行の並行 INSERT が F より前に commit（セッション B が current 行を先に `FOR UPDATE` で保持して RPC を待たせ、その間に INSERT・commit してから解放）→ `latest_observation_changed`。
25. 同日行の並行 upsert（値の改定）が F より前に commit → `observation_revised` または `latest_observation_changed`。
26. high イベントの並行 INSERT / 同 id 改定が F より前に commit → `event_pending`。
27. F より後の commit は照合に入らないこと: F の後に B が INSERT・commit する手順は関数の外から割り込めないため、
    代わりに (a) 関数本文で事実参照が 1 文だけであることのソース不変条件テスト、(b) `verified_at` が B の commit 時刻より前であることの確認で保証する。
28. 照合 RPC 実行中に ingest の upsert が待たされないこと（market_metrics にロックを取っていない）。
29. 並行 AI 更新: 照合 RPC の前に material RPC を commit → 照合は `MIC_STATE_STALE_DECISION` で RAISE、何も残らない。
30. 並行 AI 更新（逆順）: 照合の後に material RPC → トリガーでポインタが null に戻る、history に照合列が残る。
31. Scenario RPC（current を `FOR SHARE`）と照合 RPC の同時実行でデッドロックしない（ロック逆転なし）。

ポインタ（3.3・3.4）:

32. verified → neutral（ポインタ維持）→ negative（ポインタ消去）→ verified（再設定）の連続。
33. ABA: narrative A → B → A 相当（別 run id）で古い照合ポインタが復活しない。
34. 旧 RPC（`apply_mic_state_no_change_update`）で既存ポインタが残ったまま状態更新できる（v32 互換）。
35. ポインタの不正設定（他 narrative の run、not_verified の run、`verified_at` 不一致）を直接 UPDATE → トリガーが RAISE。null への UPDATE は許可。

失敗・権限:

36. 古い run（current が run 開始後に更新済み）→ `MIC_STATE_STALE_RUN` で RAISE。
37. 重複実行（同じ run で 2 回呼ぶ）→ 2 回目は `already_applied`、記録は 1 回目のまま。
38. DB 書き込み失敗（制約違反を注入）→ 全体ロールバック、State の状態列も変わらない。
39. 権限: anon / authenticated から新 RPC を実行できない。トリガー関数は直接実行できない。

ソース不変条件:

40. SQL の domain → event_type 定数と Edge の `DOMAIN_EVENT_TYPES` が完全一致。
41. 新 RPC の本文で `market_metrics` / `market_events` / 2 つの view を参照する SQL 文が 1 つだけ。
42. 新 RPC が `numeric_baseline_snapshot` / `ai_evaluated_at` / `source_evaluation_run_id` / narrative 系の列を SET しない。

変異テスト（mutation test）: 閾値比較を `>` に、anchor 比較を `>=` に、identity 確認を外す、
トリガーのポインタ消去を外す、negative でのポインタ消去を外す、の 5 通りで、それぞれ対応するテストが落ちることを確認する。

### 6.2 Edge（Deno、`--no-config`）

- no_change の 2 分岐が新 RPC を呼び、既存の `decision_detail`（material / reason / verification_shadow）がそのまま渡る。
- `p_verification_candidate` が shadow の status から正しく決まり、all-stale 分岐では常に false。
- `p_event_types` が `eventTypesForDomain(domain)` と一致する。
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
3. Production の現状が本書 0.2 の前提どおり（列・トリガー・RPC 署名・権限、単一 source、タイ 0）であることを read-only で確認。
4. `market-intelligence-state-evaluator` が想定の version で、running の State / Scenario run が 0 件。
5. 適用時刻が State / Scenario / ingest の実行枠（毎時 :15 / :25 / :45 付近）から外れている。
6. MIC の Cron fingerprint（既存 22 本・Scenario）を記録。

適用:

7. `supabase db query --linked -f <migration>` で 1 本だけ適用（`db push` は使わない）。
8. ledger は `migration repair --status applied <version>` でその 1 版だけ記録。

適用後（read-only read-back）:

9. 追加列・制約・FK・トリガー・新 RPC の署名と本文ハッシュ・`service_role` のみの EXECUTE を確認。
10. 既存 RPC 2 本が変わっていない（本文ハッシュ）。
11. 既存行の照合列とポインタがすべて null。
12. Cron fingerprint が不変。
13. この時点では旧 Edge（v32）のまま動き、次の自然実行が従来どおり no_change / evaluated になる（S1-A 単独の互換確認）。

---

## 8. rollback 方針

- **S1-A のみ適用・S1-B 未 deploy**: v32 は旧 RPC を使い続け、照合列・ポインタは null のまま。
  トリガーの 1)（identity 変更で消去）と 2)（非 null のときだけ確認）は null に対しては何もしないので、旧 Edge と完全に互換。
- **S1-B deploy 後に v32 へ戻す**: v32 と同じソース（main の該当 commit）を再 deploy すれば旧 RPC で動く。
  - 既に立っているポインタは、material 更新が来るまで残る。旧 RPC は negative でポインタを消さないので、
    この間のポインタは「最後に照合が成功した時刻」以上の意味を持たない。
  - そのため 3.4 の読み取り規約で「最新の State run が `verification_status` を持つこと」を条件にし、
    rollback 中は Stage 2 がポインタを使わないようにする。必要なら運用者がポインタを null に戻す（3.3 で常に許可）。
- **DB**: 列・制約・トリガー・新 RPC は残しても旧 Edge の動作に影響しない（追加のみ）。DROP 系の rollback は行わない。
- **トリガーに不具合があった場合**: トリガー関数を「何もしない」版に差し替える修正 migration を事前に用意しておく（DROP ではなく差し替え）。
- **誤って verified が記録された場合**: 3.5 のとおり。run は不変なので消さず、ポインタの消去と（Stage 2 以降は）無効化一覧で除外する。

---

## 9. 未確定事項

### 9.1 決定済み（ChatGPT 判断 2026-10-10、本書 v2 に反映）

| # | 事項 | 決定 | 反映箇所 |
| --- | --- | --- | --- |
| U2 | 未処理イベントの判定方法 | 条件付き採用: SQL 定数 ＋ ソース不変条件テスト、DB で独立判定、欠損・不正は安全側 | 1.5、6.1 の 18〜23・40 |
| U3 | 照合証拠の置き場 | 採用: run の不変 `verification_detail jsonb`。証拠欠損なら verified にしない | 3.1、A15 |
| U6 | fetch / observation / coverage を DB が再計算するか | 採用: DB が再計算し、単一スナップショットで一貫させる | 1.2、1.7、2.2 |
| U9 | no_change を新 RPC に一本化するか | 採用: 通常・all-stale とも新 RPC。旧 RPC は rollback 用に維持 | 2.1、2.5 |

### 9.2 未確定（理由と、どの GO で決めるか）

| # | 事項 | 現時点の推奨 | 決める時期 |
| --- | --- | --- | --- |
| U1 | equity で `no_new_observation` が本番で取れていない | 10/12（スポーツの日）を含む 10/14 以降の集計で確認。取れなければ合成テストで代替してよいか ChatGPT が判断 | Stage 1 実装 GO の前 |
| U4 | baseline に source_key・行 id を持たせるか | Stage 1 では持たせない（material 経路を触らない）。複数 source 化が決まったら別工程 | 将来 |
| U5 | 同日改定を検出したときに AI 再評価を促すか | Stage 1 は記録のみ（verified にしない）。AI 条件は変えない。実装 GO とは切り離す | Stage 2 |
| U7 | `delayed_expected` を照合可とするか | 可（shadow と同じ）。重み付けは Stage 2 | Stage 2 |
| U8 | macro は always_material が多く `verified` がほぼ出ない | 想定どおりとして受け入れる。実装 GO の条件にしない | Stage 2 |
| U10 | migration の version | 実装時に予約（不変条件テストの RESERVED に追加） | S1-A 着手時 |
| U11 | 誤 verified の無効化一覧 | 3.5 の設計。Stage 2 の migration で作成し、Stage 2 の GO 条件にする | Stage 2 GO の前 |
| U12 | イベント窓の走査上限（500 件）と窓の外の改定検出の範囲 | 本書の値で開始し、SQL テストで性能を確認 | S1-A レビュー時 |
| U13 | 新 RPC が状態 5 列に Edge の値を書き、DB 再計算値は証拠のみとする方針 | 推奨どおり（State の表示値を変えない）。Codex レビューで確認 | S1-A レビュー時 |

---

## 10. 実装順序

1. **S1-A（source、DB）**: migration（run 列・制約・FK、current 列・制約・FK、トリガー、新 RPC）＋ SQL テスト（6.1）＋ 変異テスト。
   旧 Edge（v32）との互換（旧 RPC・material RPC が新スキーマで従来どおり動くこと、テスト 34）をローカルで確認する。
2. **S1-B（source、Edge）**: 新 RPC を呼ぶ writer と index.ts の no_change 2 分岐の切り替え ＋ Edge テスト（6.2）。
   S1-A と同じ PR でもよい（レビューをまとめる）。
   DB / RPC / 競合制御を含むため、実装後に **Codex Sol（高）** でまとめてレビューする（ChatGPT 判断）。
3. **main 統合**: レビュー済みの内容のまま。
4. **Production（migration）**: 7 章の手順で 1 本だけ適用。旧 Edge のまま自然実行を 1 回観測（7 章 13）。
5. **Production（Edge）**: state-evaluator だけを deploy、本番のソースと main をバイト比較、自然実行で
   `verified` / `not_verified` の記録とポインタの動きを確認。
6. **観測**: shadow と DB 判定の一致（`db_rederivation_mismatch` 0 件）、AI 呼び出しの不変、記録サイズ、ポインタの不変条件。

---

## 11. Stage 1 実装 GO 条件

**本書の完成は実装 GO ではない。** 次をすべて満たし、**別途 ChatGPT が S1-A / S1-B の正式実装を許可した場合だけ**着手する。

1. 10/14 以降の自然 shadow 観測で `comparison_mismatch` 0、`shadow_error` 0、shadow 欠落 0、失敗 run の増加なし、no_change での AI 呼び出し 0。
2. rates で `no_new_observation` と `below_threshold` の両方が確認済み（済）。equity は U1 の判断に従う。
3. `not_verifiable` の主な理由が説明できている（10/10 時点: commodities の identity 欠落 1 件と EIA の観測 stale 2 件のみ）。
4. U2 / U3 / U6 / U9 は決定済み（9.1）。U12 / U13 は S1-A のレビューで確定してよい。
5. 本書 0.2 の Production 前提（単一 source、タイ 0、RPC 2 本、トリガー構成）が着手時点でも変わっていない（read-only で再確認）。
6. MIC の State evaluator・migration に、他 workstream の変更が入っていない。

Stage 2 の GO 条件（参考。Stage 1 の GO とは別）: 3.4 の読み取り規約の実装、3.5 の無効化一覧、
仮値（96h / 168h / 0.64 / AI backstop）の決定、Edge が新 RPC で稼働していること。

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

create or replace function public.apply_mic_state_verified_no_change_update(...) ...;  -- 2.2〜2.4、1.7 の単一事実取得文
revoke all on function public.apply_mic_state_verified_no_change_update(...) from public, anon, authenticated;
grant execute on function public.apply_mic_state_verified_no_change_update(...) to service_role;
revoke all on function public.market_state_current_verification_guard() from public, anon, authenticated;

commit;
```

- 既存の `apply_mic_state_no_change_update` / `apply_mic_state_material_update` には触れない。
- 新しいテーブルは作らない（`ensure_rls` の対象外）。無効化一覧（3.5）は Stage 2 の migration で作る。
