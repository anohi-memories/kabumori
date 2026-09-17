# Codex Task

- task_id: ai-lab-daily-content-plan-generation-control-phase1-20260917
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol Medium/High
- purpose: 会社員AIラボの自動投稿を「APIが題材まで勝手に考える」方式から、「ちゃ/将来のアプリ内AIがSupabaseへ登録した翌日用の題材プランを最優先し、API側AIはその題材を文章化する」方式へ切り替えるPhase 1 candidateを実装する。題材プランが無い場合だけ既存キャラ設定の範囲で無難な通常投稿へfallbackする。

## Product decision — 2026-09-17

会社員AIラボの本質はAI一般ノウハウ紹介ではなく、**非エンジニア会社員がAIと一緒に副業・個人開発を進める実験日記**。

現在の問題:
- API側に自由生成させると「AIの便利な使い方」「一般論」「無難な仕事Tips」へ寄り、実際の開発日記から外れる。
- 例: メールをAIに見せて相手の受け取り方を確認する、といった投稿はブランドの主題ではない。

採用する運用:
1. ユーザーがちゃに「明日はこんな流れ」と伝える。
2. ちゃが翌日分の題材・流れ・入れる要素・避ける要素を構造化してSupabaseへ登録する。
3. 自動投稿側はその登録内容を最優先のsource-of-truthとして文章を生成する。
4. 題材プランが無い日/slotだけ、従来のキャラ設定の範囲で無難なfallback投稿を生成する。
5. 題材がある場合、API側AIは新しいテーマを勝手に発明しない。役割は「与えられた題材をX投稿へ文章化する」こと。

将来はみお・一般ユーザー向けsocial-mobileアプリにも同じarchitectureを使うが、**このH1では会社員AIラボだけを実装対象**とする。みおの生成挙動は変更しない。

## Mandatory startup / conflict gate

開始前に必ず確認:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT.md`
5. `.agent/tasks/CODEX_TASK_2.md`
6. `.agent/tasks/CLAUDE_TASK_1.md`
7. `.agent/tasks/CLAUDE_TASK.md`
8. fresh `origin/main`

競合ルール:
- G1は現在 `review_required` のmarket-report Phase2で、`x-test-post` morning/close consumer候補を含む。G1が再開され `x-test-post` を同時変更する状態になっていたらSTOP。
- H2は `apps/social-mobile/**` + read-only DB/RLS inventory中心。H1はそのapp filesを変更しない。
- G2はdone。
- 既存未コミット変更は他workstream所有として触らない。
- push前に必ずfresh `origin/main`を再確認。

## Phase 1 goal

**題材プラン保存schema + AI Lab生成側の優先制御 + testsをcandidateとして作る。**

このPhaseではproduction DB migration適用や`x-test-post`本番deployをしない。C1でsource/schemaを確認してからproduction rolloutを別途判断する。

## 1. Existing generation path audit

まず現行AI Lab `brand_post` の生成call graphを正確に特定する。

最低限確認:
- scheduled row / slot_no / target dateがどこで決まるか
- AI Lab prompt/persona/voiceの正本
- topic/themeを現在どこで選んでいるか
- generation → dedupe → X publishまでの境界
- 既存のidempotency/fingerprint/completion guard

既存OAuth/Vault/refresh v113経路は変更しない。

## 2. Daily content plan data model candidate

将来みお・一般アプリへ再利用できるよう、storageはbrand-neutralな形を優先する。ただしこのPhaseでconsumer wiringするのはAI Labのみ。

推奨イメージ:
- 1 brand × 1 target_date(JST) × version のdaily plan
- status: draft / active / archived 相当
- plan source: chatgpt / app_ai / manual 等を表せる
- structured plan payloadに最低限:
  - day_theme / narrative_arc（任意）
  - slot/topic items
  - slot_no または投稿順指定（任意）
  - topic
  - context/background
  - key_points[]
  - tone override（任意）
  - must_include[]
  - must_avoid[]
  - priority/order
- timestamps / version / active marker

重要:
- chat会話本文そのものを設定正本にしない。
- 保存するのは構造化済みcontent plan。
- 同日planのactive versionが曖昧にならないconstraint/design。
- target_dateはAI Lab投稿運用上のJST日付として扱う。
- plan未登録は正常状態であり、fallbackへ行く。

既存schemaに適切なtableが既にあるなら再利用を優先し、重複tableを作らない。production metadata/sourceを調査し、推測で決めない。

## 3. Plan selection rules

AI Lab生成時に、対象JST日付 + slotを使ってactive planを検索するcandidateを作る。

優先順位:
1. 当該slotに明示されたtopic item
2. slot指定なしの未使用/次順位item（設計上必要なら）
3. daily plan全体のtheme/context
4. plan自体が無ければ既存persona fallback

最低要件:
- 同じslotで毎回別itemを勝手に選ばない。deterministicにする。
- retry時に題材が変わらない。
- plan itemの消費状態をDB writeで雑に管理してidempotencyを壊さない。scheduled row/slot_no等、既存の正本と結びつける。
- 過去日のplanを翌日に誤利用しない。
- future planを前倒し利用しない。
- inactive/draft planは使用しない。

## 4. Prompt/generation control

### Planあり

API側AIの役割は**文章化のみ**。

promptで明示:
- 指定topic/context/key_pointsの範囲から逸脱しない
- 新しい主題・架空の進捗・架空の感情・実績を追加しない
- AI一般論/AI便利術へ勝手に変換しない
- 会社員AIラボは「個人開発の実験日記」である
- 1投稿1メッセージを明確にする
- 結論/出来事を早めに出す
- 抽象的な自己啓発、過剰な説明口調、教科書調を避ける
- must_includeを反映
- must_avoidを守る
- brand persona/voiceは文章表現にのみ使い、topicを上書きしない
- 未確認事実を補完しない

### Planなし

既存の自動生成を完全削除しない。

fallback要件:
- AI Lab personaの範囲で無難な投稿
- 個人開発 / AIとの試行錯誤 / 副業 / 非エンジニア会社員視点を中心
- 一般的なAI使い方Tipsだけに偏らないようpromptを最低限hardeningしてよい
- 既存投稿本数/slot/Cronは変更しない

## 5. Safety and brand isolation

絶対条件:
- AI Lab固定brand/account境界を維持
- Kabumori生成挙動を変えない
- Mio生成挙動を変えない
- OAuth/Vault/token/refresh logicを変えない
- X publish/retry/idempotency/fingerprint/completion guardを変えない
- morning_report / close_report / important-news経路を変えない

共通helperを作る場合でも、AI Lab以外はfeature OFF/未接続のままにする。

## 6. Tests

最低限追加:
- planあり: 指定topicがprompt/sourceへ入る
- planあり: unrelated AI tipをtopicとして生成させない指示が入る
- slot-specific item selection
- retry/same slotでsame item
- target_date JST境界
- draft/inactive plan無視
- planなし: fallback path
- must_include / must_avoid伝達
- AI Lab以外は既存path unchanged
- OAuth/Vault/refresh wiring unchanged static regression
- existing AI Lab scheduled dispatch / x-test-post regression
- `git diff --check`

可能ならgeneration providerをmockし、planあり時にAPIへ渡すmessages/promptをsnapshot/semantic assertionする。

## 7. Migration/source boundary

このPhaseで許可:
- migration candidate作成（未適用）
- helper/repository/generation wiring candidate
- tests
- docs
- local validation
- `.agent/` metadata/report

このPhaseで禁止:
- production migration適用
- `supabase db push`
- production RLS/grant/RPC変更
- production `x-test-post` deploy
- Cron/posting window変更
- manual/synthetic X post
- retry/backfill
- OAuth再認可
- Vault/token/secret変更
- manual refresh
- Mio/Kabumori behavior変更
- G1 market-report consumer変更

## Deliverables / C1 review points

C1へ返す時に明記:
- exact current AI Lab generation call graph
- proposed/used plan table/schemaと理由
- plan JSON/type shape
- JST target date / slot selection rule
- planあり/なしのprompt差分
- changed files
- tests/result
- migration candidate有無
- production changes = 0
- Mio/Kabumori/OAuth/Vault/X publish path changes = 0
- Phase 2 rollout案

## Completion

完了時:
- `.agent/CODEX_REPORT.md`先頭にPhase1 report追加
- this TASKを `status: review_required`, `next_owner: chatgpt`
- source candidate commit/hashを記録
- production deploy/migration 0を明記
- push前にfresh `origin/main`確認
- `.agent/`と安全なcandidate sourceをmainへ直接pushするかcandidate branchに置くかは既存運用/競合を見て判断し、未レビューproduction rolloutはしない
- origin read-back後STOPしてC1待ち

## Future direction (out of current H1)

後続では同じcontent-plan architectureを:
- みお
- `apps/social-mobile` のアプリ内AI相談 → structured daily content plan
へ拡張する。

みお・会社員AIラボの運用では、当面「ちゃ」がアプリ内AI/編集長の役割を担当し、ユーザーの「明日はこんな流れ」を構造化してSupabaseへ登録する想定。
