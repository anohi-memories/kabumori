# Supabase migration source canonicalization（2026-09-30）

状態: **source-only**。Production変更（migration適用、repair、db push、Cron/Vault/secret）は一切行っていない。

## 目的

Production migration ledger監査で確定したsource側のversion異常2件を、ファイル名（version）の整理だけで解消する。
SQL本文は1バイトも変更していない（`git diff -M` で100% rename）。

## 変更（2ファイルのrename）

| 旧filename | 新filename | 理由 |
| --- | --- | --- |
| `20260922090000_mic_central_bank_decision_event_type_phase2b3.sql` | `20260922093000_mic_central_bank_decision_event_type_phase2b3.sql` | `20260922090000` が macro migration と重複していた。macro側はversionを維持し、後発の Fed event-type 側をuniqueなtimestampへ移した。`20260922093000` は「macro（09:00）の直後、Fed diff schema `20260922100000` の直前」で、Fed statement schema（`20260921221336`）より後という依存を満たす。 |
| `20260920061041_mic_estat_activation_and_gated_macro_cron.sql` | `20260924093000_mic_estat_activation_and_gated_macro_cron.sql` | activation は `source_key='estat'` の行を必須とするが、その行を作る（`is_active=false` で登録する）のは `20260924090000_mic_macro_indicators_phase1b_estat_cpi.sql`。fresh replayではactivationが先に走り失敗していた。seedの直後 `20260924093000`（次の `20260924100000` の前）へ移した。 |

維持したもの: `20260922090000_mic_macro_indicators_phase1a.sql`（macro）は変更なし。

### 独立性の確認

- Fed event-type migration は `market_events_event_type_check` を作り直すだけで、macro migration は `event_type` に触れない。
  したがって両者の順序は相互に依存しない（従来はファイル名のアルファベット順で Fed が先だったが、今は macro が先）。
- どちらの新versionも、Production の `supabase_migrations` に記録されている version（監査時の読み取り）とも、
  repo内の他の version とも、open PR（#41 `20260927101423` / `20260927124300`、#3 `20260921115317`）とも衝突しない。
- Production の migration history にはこれら（MIC系）の version 自体が記録されていない（out-of-band適用）。
  そのため今回のrenameで「history上のversionとfilenameの対応」が壊れることはない。history自体の修復（repair）は別TASK。

## 検証

- `supabase/tests/migration_source_invariants_test.ts`（9件）: version一意、filename形式と暦、辞書順=時系列、
  canonical versionの固定、e-Stat seed→activationの順序、Fed migrationの前後関係、Phase 3A / daily tip / Phase 3C の固定、
  open PR予約versionとの非衝突。rename前の配置に対して実行すると4件が失敗する（検出力の確認済み）。
- 使い捨てPostgres 17でMIC系21 migrationをfresh replay:
  - rename前の順序: step 9（activation）で `Expected exactly one estat source registry row, found 0` により失敗（監査結果を再現）。
  - rename後の順序: 21ファイルすべて成功。e-Stat は `is_active=true`、Cron 22 job（Productionと同じ構成）、
    `event_type` 制約に `central_bank_decision` と `macro_release` の両方が含まれる。

## 参照の扱い

- `.agent/CODEX_REPORT_2.md` の e-Stat activation への言及は過去の作業報告（履歴）のため変更しない。
  旧version `20260920061041` から `20260924093000` へ、旧version `20260922090000`（Fed event-type）から `20260922093000` へ、
  source canonicalization でrenameした。
- `.agent/CURRENT_STATE.md` 等の「`20260922090000` の重複prefixが残っている」という記述は、この変更で解消した。
  共有の状態ファイルは他workstreamが同時に編集するため、この変更では更新していない。

## 残る課題

- Production の migration history と repo の対応（MIC系migrationが history に無い問題）の修復は別TASK。
- Phase 3C（Cron migration `20260930090000`）はこの変更に含めない。version は予約済みでテストが固定している。
