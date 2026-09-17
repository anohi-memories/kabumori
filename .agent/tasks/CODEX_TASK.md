# Codex Task

- task_id: ai-lab-daily-content-plan-selection-fix-20260918
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: high
- recommended_model: Sol Medium/High
- purpose: Phase 1 candidate `0a6f20c86603c5834876208e4c05ef711d036be4` は全体構成は良いが、daily planの選択ルールが承認仕様より狭く、active planに当該slot itemが無いだけで投稿をfail-closedしてしまう。C1でここをblockerとしたため、slot未指定item / daily theme fallbackを決定的に扱えるようfocused fixする。production migration/deployはまだ行わない。

## Final C1 review — 2026-09-18

**PASS — focused blocker resolved.**

確認済み:
- focused candidate: `cdebdc861d9b6fb38645b640c3d48396ec72aee3`
- `slot_no` はoptional/nullを許容。
- 選択順は exact explicit slot item を最優先し、その後 slot未指定itemを `priority`, `id` のstable orderで未割当slotへ決定的に割り当てる。
- DBにconsumed stateを書かず、同一plan/date/slotのretryは同じitemへ解決する。
- active planに安全な題材が無いslotは停止せず、daily themeから新題材を捏造せず、hardened persona fallbackへ戻る。
- fallbackは会社員AIラボの主題を「個人開発・副業・AIとの試行錯誤の日記」へ寄せ、一般AI便利Tips・教科書的ノウハウ・架空進捗/体験の追加を明示的に抑止。
- planあり時の題材拘束、AI Lab-only wiring、JST target-date、active-only filteringは維持。
- Kabumori/Mio、market-report、OAuth/Vault/refresh、X publish/dedupe/completion境界は変更なし。
- focused 30/30、full `x-test-post` + `_shared/brand` regression 469/469 PASS。
- helper `deno check --no-config`、`deno fmt --check`、`git diff --check` PASS。
- production migration/deploy/configuration mutation 0。manual/synthetic X post、retry/backfill、OAuth action、Vault/token/secret変更 0。

### C1 decision

Phase 1 source candidate + focused selection fixは承認する。

ただし、これは**production rollout承認ではない**。migration candidate `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql` は未適用、`x-test-post`も未deployのまま。production migration適用・writer path・deployは次タスクで個別に安全確認してから行う。

このH1 taskは完了とし、次工程は「ちゃ/将来のアプリ内AIが翌日planを書き込むwriter path」とproduction rollout設計を別タスクで扱う。

## Previous C1 review — 2026-09-18

**NOT PASS — focused fix required before rollout.**

良かった点:
- brand-neutral `daily_content_plans` schema candidateを用意し、consumer wiringはAI Labのみに限定。
- target dateはJST、active planのみ、version/order deterministic。
- planあり時はAPI側AIを「文章化役」に制限し、計画外テーマ・架空進捗・一般AI Tipsへの逸脱をpromptで抑止。
- planなしでは既存pathへfallback。
- OAuth/Vault/refresh/X publish/dedupe/completion、Kabumori/Mio、market-report経路は変更なし。
- focused 27/27、full regression 466/466、helper `deno check`、`git diff --check` PASS。
- production変更0。

### Blocking issue

承認仕様ではplan selection priorityを以下としていた:
1. 当該slot明示item
2. slot指定なしの未使用/次順位item
3. daily plan全体のtheme/context
4. plan自体が無ければpersona fallback

しかしcandidateの `DailyContentPlanItem.slotNo` は必須numberで、`selectDailyContentPlanItem()` は `item.slotNo === slotNo` のexact matchだけを返す。active planが存在しても当該slot itemが無ければ `AI_LAB_CONTENT_PLAN_SLOT_MISSING` でfail-closedする。

これは「ちゃが明日の流れ/題材を登録する」運用に対して硬すぎる。例えば1日の大枠themeと3つの題材だけ登録した場合、残りslotが全停止する可能性がある。ユーザー意図は、指示がある日はそれを優先しつつ、細かいslot指定が無い部分も自然に回し、何も指示がない場合だけキャラ設定fallbackに戻ること。

## Required focused fix

### 1. Plan item model

- `slot_no` を optional/nullable として扱えるようにする。
- explicit slot itemは最優先。
- slot未指定itemsは stable order (`priority`, then `id`) で deterministic にslotへ割り当てられる設計にする。
- DB writeで「消費済み」を雑に持たない。scheduled row / slot_no / target dateを使い、retry時に同じitemへ解決する。
- 同一plan・同一target_date・同一slotは常に同じitem。
- 過去/未来plan混入禁止は維持。

### 2. Daily theme fallback

- active planがあり、explicit/unassigned itemが当該slotに割り当てられない場合でも、`day_theme` / `narrative_arc` / 共通contextだけで安全に文章化できる構造なら、そのdaily plan全体を使うfallbackを検討する。
- daily themeだけでは具体的投稿を安全に作れず、AIに新テーマ発明させることになる場合は、明示的に「このslotは通常persona fallbackへ戻す」方がよい。
- どちらを採用するかは、**AIに題材を勝手に発明させない**ことを最優先にする。
- active planの存在だけを理由に、その日の未指定slotを全部停止させない。

### 3. No-plan / unassigned behavior

- plan自体なし: existing persona fallback。
- active planあり・当該slotに安全な題材なし: production運用で停止し続けない明確なfallback ruleを実装。
- fallback promptは会社員AIラボの主題が「個人開発・副業・AIとの試行錯誤の日記」であることを最低限hardeningし、一般的なAI便利Tipsだけへ寄り続けないようにする。

### 4. Tests

最低限追加/修正:
- exact slot item優先
- slot未指定itemのdeterministic割当
- same slot retryでsame item
- priority/id tie-break
- active planだが当該slot explicit item無しでも不要な停止をしない
- planなしpersona fallback
- fallback promptが個人開発日記軸を含む
- draft/inactive無視
- JST境界
- AI Lab以外 unchanged
- existing OAuth/Vault/refresh static regression
- full x-test-post + `_shared/brand` regression
- `git diff --check`

## Safety boundary

このfocused fixでも禁止:
- production migration適用
- `supabase db push`
- production `x-test-post` deploy
- production RLS/grant/RPC変更
- Cron/posting window変更
- manual/synthetic X post
- retry/backfill
- OAuth再認可
- Vault/token/secret変更
- Mio/Kabumori behavior変更
- G1 market-report consumer変更

## Completion

完了時:
- `.agent/CODEX_REPORT.md` 先頭にfocused fix report追加
- exact candidate commit/hash
- selection algorithm
- fallback rule
- tests
- production changes=0
- this TASKを `status: review_required`, `next_owner: chatgpt`
- fresh `origin/main`確認後に安全にpush/read-back
- C1待ちでSTOP
