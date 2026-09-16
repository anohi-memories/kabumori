# Codex Task 2

- task_id: x-news-generation-failure-hardening-20260916
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: X向け重要ニュース本文の `generation_failed` が累計142件まで積み上がっている問題を、実データで原因分類し、Fact安全性を落とさず公開取りこぼしを減らす最小修正を実装・検証してC2レビューへ出す。

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

## Parallel-safety boundary

Codex slot 1 / H1 は AI Lab multibrand・`x-test-post`・OAuth/Vault/投稿開始準備を所有している。

このH2では以下を触らない:
- `x-test-post`
- AI Lab / multibrand dispatch
- OAuth / Vault / social_accounts / token
- AI Lab posting_windows / Cron / publish flags
- Kabumori OAuth recovery

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

## Tests

最低限:
- 既存重要ニュースgeneration/fact/voice tests
- 新規 regression fixtures:
  - packet外の因果追加 → 初回fail → correctionで除去 → pass
  - packetに根拠がない数値/主体 → retry後もfail-closed
  - Fact passed本文は不要なretryなし
  - voice rewriteが新事実を追加しない
  - retry上限を超えてループしない
- `git diff --check`
- changed-file `deno check` または baseline-equivalent diagnostics証明

可能なら過去の代表 `generation_failed` サンプルをfixture化し、改善前/後の期待挙動をテストする。production rowの直接再投稿は禁止。

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

## Completion

完了時:
- review branch/commitをpush
- `.agent/CODEX_REPORT_2.md`へ原因分析・変更点・テスト・期待改善・残課題を記録
- status: `review_required`
- next_owner: `chatgpt`
- STOP before production deploy

C2レビューで見るもの:
- 142件の内訳と根本原因がデータで説明できるか
- Fact安全性を下げず失敗率を減らす設計か
- 変更がX重要ニュース本文生成に限定されているか
- retryがbounded / fail-closedか
- app copy / Push / AI Lab / personalized reportsに副作用がないか

## Next task after C2

このタスクがC2 PASSした後、別タスクとして「personalized morning/close reportの `REPORT_FACT_FAILED` 時に安全なbounded retryを追加」をCodex slot 2へ割り当てる。