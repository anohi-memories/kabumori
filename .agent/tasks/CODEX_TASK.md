# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-generation-reliability-fix-20260908
- owner: codex
- status: review_required
- next_owner: chatgpt
- purpose: `important` / `most_important` に採用された重要ニュースが、企業同一性判定や軽微なFact不整合で生成全落ちする問題を、安全性を維持したまま最小修正する。
- priority: high

## Background

2026-09-08の本番read-only確認で、重要ニュース候補から `important` に採用された3件がすべて `generation_failed` となり、生成成功0件だった。

確認できた代表例:

1. TDnetの企業名表記差
   - DB/一覧側: `小森`
   - 一次資料側: `株式会社 小森コーポレーション`
   - DB/一覧側: `旭コンクリ`
   - 一次資料側: `旭コンクリート工業`
   - 信頼済みTDnetの `company_code` / `entity_key` は同一企業を指しているのに、略称と正式社名の差で company identity Fact check が失敗した。

2. 軽微な生成Fact不整合
   - 外貨準備ニュースで、生成文が入力にない市場解釈を追加した。
   - 入力にある年を生成文で落とした。
   - 事実そのものは投稿可能でも、軽微な修正可能事項1箇所で投稿全体が `generation_failed` になった。

このタスクは取得・重要度判定を緩めるものではない。採用後の生成パイプラインの信頼性改善に限定する。

## Implementation scope

### 1. 企業同一性判定を安全に改善

主対象はTDnet由来候補。

- 信頼済みTDnet sourceであることを既存条件どおり必須とする。
- `company_code` が正規形式で、`entity_key === company:<company_code>` のような既存の強いidentity signalが一致している場合に限り、DB略称と一次資料正式社名の安全な表記差を許容できるよう改善する。
- `小森` ↔ `小森コーポレーション`、`旭コンクリ` ↔ `旭コンクリート工業` のような実例をテストへ追加する。
- 別企業の誤統合を防ぐことを最優先する。
- 無制限の部分一致、前方一致、曖昧な会社名類似だけで同一企業とみなす実装は禁止。
- 既存の会社コード正規化・5文字末尾0の安全ルールは壊さない。
- 既存手動alias mapを全社分増やすだけの実装は避け、可能なら強いidentity signalと一次資料内の名称証拠を組み合わせた一般化を優先する。ただし一般化が危険なら安全側へ倒す。

### 2. 軽微なFact失敗だけ最大1回の限定retry

Fact check失敗後、以下のように「事実を変えずに機械的に修正可能」なケースだけ、Lunaで最大1回の限定修正を許可する。

許可候補:
- 入力に明示された年・日付の欠落を戻す。
- 入力根拠にない市場解釈・影響解釈・因果表現を削除する。
- 確認済み同一企業の表記を、入力にある正式/安全な表記へ統一する。
- 事実を変更しない軽微なラベル/表記整合。

retry禁止:
- 数値そのものが疑わしい。
- 企業・証券コードの同一性に疑義がある。
- 日付や出来事の発生時刻そのものが不明。
- 因果関係・規模・対象範囲・重要条件に疑義がある。
- 元情報不足。
- source URL / source identityに疑義がある。
- Fact checkerのissueが未分類または安全に限定できない。

### 3. retry後はFactを必ず再検証

- retry修正文をそのまま通さない。
- local deterministic Fact checkを再実行。
- AI Fact checkも再実行。
- Factがpassedした場合のみVoiceへ進む。
- retry後もFact failなら `generation_failed`。

### 4. 既存Voice retryとの上限を明確化

- Fact retry: 最大1回。
- Voice retry: 既存最大1回。
- Fact retryとVoice retryが連鎖して無限化しないこと。
- 同一段階を2回以上retryしない。
- 既存のatomic generation claim / duplicate generation防止を壊さない。

### 5. diagnostics

可能な範囲で既存の `generation_voice_retry` と同様に、Fact retryについても後から確認できる診断情報を保持する。

最低限ほしい内容:
- attempted
- initial fact issues
- retry used model
- retry後local fact status/issues
- retry後AI fact status/issues
- retry error

DB schema追加が必要なら勝手にmigrationせず、既存JSON列等で安全に保存できるか確認し、無理ならReportに必要変更を明記する。

## Safety / behavior requirements

- `important` / `most_important` の重要度判定基準は緩めない。
- 取得候補数を増やす修正はしない。
- Fact checkerそのものを甘くして通過率だけ上げる修正は禁止。
- retryは「安全に直せる既知の軽微問題」に限定する。
- 別企業誤認は絶対に避ける。
- 元情報にない市場解釈を追加しない。
- 数値・日付・固有名詞を推測で補わない。
- 今日すでに `generation_failed` になった候補を勝手に再生成しない。
- 過去failed candidateのstatus変更、再claim、再投稿は禁止。
- `auto_publish` / X公開設定は変更しない。
- X投稿しない。
- Claude側TASK/Reportには触れない。
- 他workstreamと同一ファイル競合がある場合は開始せず報告する。

## Expected files

主対象:
- `supabase/functions/important-news-monitor/post_generation_logic.ts`
- `supabase/functions/important-news-monitor/post_generation_logic_test.ts`

必要最小限で追加可:
- `supabase/functions/important-news-monitor/index.ts`
- generation dispatch / diagnostics関連helperとtest

今回完了済みのfreshness/coverage修正ファイルを不要に再編集しないこと。

## Validation

最低限:

1. company identity
   - `小森` / `株式会社 小森コーポレーション` が強いTDnet identity signal一致時に安全に同一企業と判定できる。
   - `旭コンクリ` / `旭コンクリート工業` も同様。
   - company_code/entity_key不一致時は名前が似ていても通さない。
   - unrelated companyの誤一致fixtureを入れる。

2. Fact retry
   - 年の欠落を安全に戻すケース。
   - 根拠のない市場解釈を削除するケース。
   - 数値誤りはretry禁止。
   - 企業同一性疑義はretry禁止。
   - 未分類issueはretry禁止。
   - retryは最大1回。

3. retry後再検証
   - local Fact failで停止。
   - AI Fact failで停止。
   - Fact pass後のみVoiceへ進む。

4. regression
   - 既存generation / Fact / Voice / Voice retry / publish eligibilityを壊さない。
   - relevant tests, lint, typecheck可能範囲, `git diff --check`。

## Production policy

このタスクはローカル実装・検証まで。

- production DB write: 禁止
- migration / DDL / GRANT: 禁止。必要ならReportのみ
- Edge Function deploy: 禁止
- Cron変更: 禁止
- secrets変更・表示: 禁止
- OpenAI実APIによる本番候補再生成: 禁止
- X API / X投稿: 禁止
- auto_publish変更: 禁止

## Completion criteria

- 上記scopeを安全に実装。
- 代表失敗ケースとnegative casesをtest化。
- lint / relevant tests / typecheck可能範囲 / diff checkを報告。
- 変更ファイル一覧と設計判断をReport。
- production変更0。
- TASK末尾に `## Report` を追加。
- status: `review_required`
- next_owner: `chatgpt`

- commit: 許可
- push: 実装完了後、既存運用に従う。競合や不明点があれば勝手にpushせずReport。
- deploy: 禁止
- report_mode: inline

## Report

- task_id: important-news-generation-reliability-fix-20260908
- result: review_required
- changed_files:
  - `supabase/functions/important-news-monitor/post_generation_logic.ts`
  - `supabase/functions/important-news-monitor/post_generation_logic_test.ts`
  - `supabase/functions/important-news-monitor/index.ts`
  - `supabase/functions/important-news-monitor/generation_persistence_test.ts`
- implementation: trusted TDnet company-code/entity evidence now permits only narrow primary-header suffix differences, including 小森/小森コーポレーション and 旭コンクリ/旭コンクリート工業; unrelated prefixes, unsafe suffixes, and mismatched identity signals remain rejected.
- fact_retry: safe, single `fact_retry` is allowed only for explicit year/date restoration, deterministic unsupported market interpretation removal, confirmed company spelling, or minor label consistency. The revised text is rechecked locally and by AI Fact before Voice.
- voice_retry: existing one-at-most Voice retry remains bounded; Fact and Voice retries cannot recursively repeat.
- diagnostics: Fact retry details are placed inside the existing `generation_voice_retry` JSONB payload as a nested `fact_retry` object. No migration was added.
- tests: relevant post-generation plus persistence tests `106/106` passed; full important-news-monitor suite `255/255` passed with `--no-check --allow-read`; `git diff --check` passed; post-generation and dispatch type checks passed. Full index type check remains blocked by the existing missing `npm:unpdf@1.8.1` dependency in this clean environment; no new type error was observed in changed modules.
- commit_hash: `710d5e8` (pushed to origin/main)
- push: `710d5e8` to `origin/main`
- deploy: 0
- production_db_write: 0
- migration: 0
- cron/settings: 0
- OpenAI_real_api: 0
- X_API: 0
- X_post: 0
- apps/admin: 0
- HANDOFF.md: 0
- secrets_exposed: 0
- next_owner: chatgpt
