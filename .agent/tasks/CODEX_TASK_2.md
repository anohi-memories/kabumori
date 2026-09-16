# Codex Task 2

- task_id: x-news-generation-failure-hardening-20260916
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: X向け重要ニュース本文の `generation_failed` が累計142件まで積み上がっている問題を、実データで原因分類し、Fact安全性を落とさず公開取りこぼしを減らす。同時に、同じ重要ニュース生成経路がOpenAI API token消費の最大要因になっているため、品質を維持したままAI呼び出し回数・入力token・無駄なretryも削減する。

## Confirmed production evidence

`.agent/CURRENT_STATE.md` で確認済み:
- `status='generation_failed'` 累計142件（2026-09-01〜09-15）
- 内訳:
  - `NEWS_GENERATION_FACT_RETRY_FAILED`: 64
  - `NEWS_GENERATION_FACT_FAILED`: 59
  - `NEWS_GENERATION_VOICE_FAILED`: 17
  - `NEWS_GENERATION_LOCAL_FACT_FAILED`: 2
- 2026-09-14: generation_failed 18 / X公開1
- 2026-09-15: generation_failed 12 / X公開4
- Push / アプリ表示には影響せず、X投稿本文生成の取りこぼしとして大きい
- 以前の「4件」はクエリ上限による誤集計で、142件が訂正後の値

2026-09-16 production read-only cost auditで、直近14日:
- `important_news_candidates`: 1,241 rows / input 3,159,450 / output 320,470 tokens
- `morning_report_runs`: input 337,695 / output 38,643 / recorded cost $0.323909
- `close_report_runs`: input 320,465 / output 30,244 / recorded cost $0.450386
- `useful_tip_verifications`: input 289,675 / output 16,405 / recorded cost $0.447826
- `personalized_reports`: input 26,662 / output 5,876 / recorded cost $0.012384

`important_news_candidates`の`api_cost_usd`は完全ではないため、重要ニュースではtoken量を主指標とする。重要ニュース系が現在の最大削減候補。

## Parallel-safety boundary

Codex slot 1 / H1 は AI Lab multibrand・`x-test-post`・OAuth/Vault/投稿開始準備を所有している。

このH2では以下を触らない:
- `x-test-post`
- AI Lab / multibrand dispatch
- OAuth / Vault / social_accounts / token
- AI Lab posting_windows / Cron / publish flags
- Kabumori OAuth recovery
- morning-greeting workflow/script

また、personalized morning/close reportのFactリトライ問題は**次の別タスク**に分離する。このタスクでは `personalized-reports` を変更しない。

開始前に `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, 本TASK, `.agent/tasks/CODEX_TASK.md`, `.agent/tasks/CLAUDE_TASK_1.md`, `.agent/tasks/CLAUDE_TASK.md` を読み、`origin/main` fresh-check。競合があればSTOP。

## Goal A — production read-only diagnosis

142件を少なくとも以下で集計・代表例確認する:
- failure code別
- 日別
- source_type別
- coverage severity / importance別
- 1回目Fact fail → retry fail の比率
- voice failの典型原因
- local Fact failの典型原因
- 成功公開との比較

特に `FACT_FAILED` / `FACT_RETRY_FAILED` について、代表サンプルを十分数読み、次を区別する:
1. 本当にunsupported/hallucinated claimがありfailが妥当
2. 元packetに根拠があるのにFact checkerが落としているfalse negative
3. generatorが不要な因果・分類・評価表現を足して自滅している
4. retry promptが初回失敗理由を十分利用できていない
5. quote/数値/主体/時制/固有名詞など特定パターンで失敗している

秘密情報は出力しない。production dataはread-only。

## Goal B — design principle

**Fact基準を単純に緩めて通過率を上げるのは禁止。**

優先する修正順:
1. generatorに「packetにない因果・分類・評価を足さない」制約を強化
2. Fact fail理由をretryへ明示的に渡し、失敗箇所だけを除去/言い換え
3. retryをboundedにする（無限再試行なし）
4. retry後もunsupportedならfail-closed維持
5. voice判定はFact passed後に行い、voice修正で新事実を足さないことを保証

既存に同等機構がある場合は重複実装せず、実際の弱点だけ直す。

## Goal C — implementation

原因が明確なら、重要ニュース→X本文生成経路だけに最小source修正を行う。

想定対象は `important-news-monitor` またはその共有generation/fact/voice helper。実際の所有コードを確認してから変更する。

実装要件:
- Fact fail理由をstructuredに保持しretryへ利用
- unsupported claimを増やさない correction retry
- bounded retry
- final Fact checkerは独立して残す
- Fact未通過本文はpublish readyにしない
-既存 dedupe / coverage / app copy / Push eligibilityを変えない
- 公開済み/成功経路を壊さない
- failure reason observabilityを改善して、将来「なぜ落ちたか」を件数上限なしで集計しやすくする。ただしraw secretや不要な全文ログは増やさない

もし原因がコード変更よりprompt/config側にあり、production source変更なしで済む場合も、勝手にproduction設定を変えずreview用差分または具体案を出す。

## Goal D — AI cost reduction (same workstream)

重要ニュースの収集品質・Fact安全性を落とさず、同じ生成経路のOpenAI API消費も削減する。

### D1. AI call path audit

重要ニュース1件について最低限、以下のAI callを列挙し、実際に何回呼ばれるかを確認:
- importance judgement
- coverage/severity/category classification
- app/Japanese copy
- X post generation
- Fact check
- voice check / correction retry
- web_search-enabled OpenAI callがあればその回数

各stageについて:
- model
- candidate全件で走るか、絞り込み後のみか
- input payloadの主要field
- 同じarticle本文/metadataを重複して送っていないか
- retry条件
- 代表fixtureでのinput chars/tokens概算
をReportする。

### D2. deterministic/no-AI prefilter

AI不要な判定はコード側へ寄せる。候補:
- exact duplicate / same-event exclusion
- stale/freshness
- source allowlist/type
- 必須field / format / length
-既存metadataだけで確定できる単純判定

ただし**収集自体を狭めて節約してはいけない**。ユーザー方針は「まず広く収集」。節約は収集後のAI対象絞り込み・prompt縮小・重複処理排除で行う。

### D3. prompt/input reduction

安全に可能なものだけ:
- stageごとに必要fieldだけ渡す
- 同一article全文を複数stageへ丸ごと再送しない
- normalized packetへ集約
- 長大な共通instructionの重複を削る
- output JSON schemaを必要最小限にする
- fixed prefixを安定させcacheが効きやすい構造にする
- candidate本文上限を設ける場合はFact根拠を切り落とさない

### D4. retry waste reduction

- Fact correctionは全文ゼロから再生成より、失敗箇所だけ除去/修正できるならそちらを優先
- voice retryで本文+packet全量を無駄に再送していないか確認
- parse/format失敗に対して必要最小限の修正requestにできるか確認
- HTTP 429等は安全なerror subtypeが取れる範囲で、quota不足なら無駄な即時retryをしない設計を検討
- fail-closedは維持

### D5. reduction target

代表fixture/workloadで、品質を維持できる範囲で**平均AI input token 30%以上削減**を目標にする。
達成のために品質を落とすのは禁止。30%未満でも安全な削減なら具体的な削減率をReportする。

## Quality invariants

絶対に壊さない:
- market/company news Fact safety
- severity/category policy
- emergency detection
- same-event/dedupe
- all_useful / user category semantics
- app copy日本語品質
- X auto-publish安全性
- stale再浮上防止
- source policy
- broad collection policy

## Tests

最低限:
- 既存重要ニュースgeneration/fact/voice tests
- 新規 regression fixtures:
  - packet外の因果追加 → 初回fail → correctionで除去 → pass
  - packetに根拠がない数値/主体 → retry後もfail-closed
  - Fact passed本文は不要なretryなし
  - voice rewriteが新事実を追加しない
  - retry上限を超えてループしない
- duplicate/stale/source policy regression
- coverage severity/category regression
- emergency regression
- same-event regression
- all_useful eligibility regression
- app copy Fact fail-closed regression
- deterministic prefilterでAI call countが減るfixture
- prompt payload/input sizeまたは送信field数のbefore/after test（可能な範囲）
- `git diff --check`
- changed-file `deno check` または baseline-equivalent diagnostics証明

可能なら過去の代表 `generation_failed` サンプルをfixture化し、改善前/後の期待挙動をテストする。production rowの直接再投稿は禁止。

## Before/after measurement

Report必須:
- baseline representative workload: AI call count / input chars or token estimate
- after same workload: AI call count / input chars or token estimate
- 削減率
- どのstageを削った/縮めたか
- 品質のため残したAI stage
- generation_failed改善の期待根拠

production dataを有料APIへ再送する人工ベンチは禁止。local fixture/mockで測る。

## Production boundary

このタスクで許可しない:
- Edge Function deploy
- production DB write/migration/RPC/schema change
- manual/synthetic X post
- Cron変更
- user notification settings変更
- OAuth/Vault/token操作
- `supabase db push`
- migration history repair/reconcile
- `x-test-post`変更/deploy
- `personalized-reports`変更/deploy
- OpenAI production manual invoke

production read-only auditは可。

## Completion

完了時:
- review branch/commitをpush
- `.agent/CODEX_REPORT_2.md`へ原因分析・変更点・テスト・期待改善・**AI call/token before-after**・残課題を記録
- status: `review_required`
- next_owner: `chatgpt`
- STOP before production deploy

C2レビューで見るもの:
- 142件の内訳と根本原因がデータで説明できるか
- Fact安全性を下げず失敗率を減らす設計か
- 変更がX重要ニュース本文生成中心に限定されているか
- retryがbounded / fail-closedか
- app copy / Push / AI Lab / personalized reportsに副作用がないか
- AI input/call削減が同一fixtureで定量化されているか
- broad collection policyを壊していないか

## Next task after C2

このタスクがC2 PASSした後、別タスクとして「personalized morning/close reportの `REPORT_FACT_FAILED` 時に安全なbounded retryを追加」をCodex slot 2へ割り当てる。
