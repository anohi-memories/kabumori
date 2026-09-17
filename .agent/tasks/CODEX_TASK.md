# Codex Task

- task_id: ai-lab-daily-content-plan-writer-phase2-20260918
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol Medium/High
- purpose: C1 PASS済みの `daily_content_plans` consumer candidateを前提に、ユーザーが「明日はこんな流れ」とちゃへ伝えた内容を、ちゃ/将来のアプリ内AIが安全にSupabaseへ登録できる writer path をPhase 2 candidateとして実装・検証する。今回はwriter/schema/validation/activationを完成させるが、production DB適用や`x-test-post` deployはまだ行わない。

## Product decision

運用の正本:
1. ユーザーがちゃへ「明日はこんな流れ」と伝える。
2. ちゃが会話内容をstructured daily content planへ変換する。
3. writer pathで翌日JSTのplanをSupabaseへ登録・activateする。
4. 自動投稿側はactive planを最優先して文章化する。
5. plan/itemが無いslotだけhardened persona fallbackへ戻る。

会社員AIラボの主題は「非エンジニア会社員がAIと一緒に副業・個人開発を進める実験日記」。AI一般Tipsアカウントへ寄せない。

将来はみお・social-mobileのアプリ内AIにも同じstorage/writer architectureを使えるようbrand-neutralにする。ただし、このH1でproduction consumer対象にするのは会社員AIラボのみ。

## Approved Phase 1 source

C1 PASS済み:
- base candidate: `0a6f20c86603c5834876208e4c05ef711d036be4`
- selection focused fix: `cdebdc861d9b6fb38645b640c3d48396ec72aee3`

承認済み仕様:
- `slot_no` explicit item最優先
- slot未指定itemは `priority`,`id` のstable orderで未割当slotへ決定的割当
- retryで同じitem
- safe item無しは投稿停止せずhardened persona fallback
- planあり時はAIは文章化役に限定

migration candidate `supabase/migrations/20260917143302_ai_lab_daily_content_plans_phase1.sql` は未適用。

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
- G1は `x-test-post` / market-report consumerを扱うreview_required状態。このH1では **`x-test-post`を変更しない**。consumer wiringの追加修正も行わない。
- H2は `brand_memberships` / social-mobile RLS candidate。`daily_content_plans`/writer objects以外のH2 objectsを触らない。
- OAuth/Vault/refresh/X publish pathには触らない。
- 既存未コミット変更は他workstream所有として触らない。
- push前にfresh `origin/main`を再確認。

## Phase 2 goal

**ちゃが日常運用で安全に翌日planを書けるservice-side writer contractを作り、disposable DBでversioning/activation/validationを証明する。**

このPhaseではproduction mutation 0でC1へ返す。

## 1. Writer contract

service-role/admin backend専用のwriterを設計する。

第一候補:
- service-role only RPC（SECURITY DEFINER + strict grant）
- 既存Supabase/plugin経由から呼びやすく、将来アプリbackend/Edge Functionからも再利用できる形

Edge Functionが明確に優位なら採用可だが、不要なHTTP層を増やさないこと。

最低入力:
- `brand_id`
- `target_date` (JST calendar date)
- `source` (`chatgpt` / `app_ai` / `manual` 等)
- structured `plan` JSON
- activate=true/false

最低出力:
- plan id
- version
- status
- target_date
- brand_id

secret/token/valueを返さない。

## 2. Activation/versioning semantics

同じ brand + target_date で:
- new plan作成時にversionを決定的にincrement
- activate=trueなら既存activeをarchiveし、新planだけactiveにする
- 同一transaction内で行い、activeが2件になる中間状態を作らない
- concurrent writerでもunique violationやraceで壊れない設計にする
- draft作成も可能
- archive/replaceの監査に最低限必要なmetadataを維持

既存の partial unique active constraint を利用/調整してよい。

## 3. Plan validation

DB writer境界で最低限validationする。

必須:
- `plan` object
- `items` array
- 各itemの `id`, `topic`
- `slot_no` は omitted/null または正整数
- `priority` は有限number相当
- `key_points`, `must_include`, `must_avoid` はstring array
- duplicate item id禁止
- explicit slotの範囲は現行AI Lab運用slotと矛盾しないよう確認。brand-neutral storageのためDB hardcodeが不適切ならwriter helper/app validationとの責務を明記
- oversized payloadに上限を設ける（合理的なJSON size / item count）。無制限保存にしない

無効planは保存しない。

## 4. Idempotent daily operation

ユーザーが同じ指示を誤って二度送る可能性を考慮する。

候補:
- optional `request_key` / `client_request_id`
- same brand/date/request keyなら同じ結果を返す

最低限、二重操作でactive versionが無意味に増殖しない方法を設計・検証する。
将来app側でも使えるbrand-neutralな名前にする。

## 5. ChatGPT operational shape

C1 reportに、ちゃが実際に登録するときの**canonical payload example**を秘密情報なしで示す。

例の概念:
```json
{
  "brand_id": "ai_salaryman_lab",
  "target_date": "YYYY-MM-DD",
  "source": "chatgpt",
  "request_key": "...",
  "plan": {
    "day_theme": "...",
    "narrative_arc": "...",
    "items": [
      {
        "id": "...",
        "slot_no": null,
        "priority": 10,
        "topic": "...",
        "context": "...",
        "key_points": ["..."],
        "must_include": [],
        "must_avoid": []
      }
    ]
  }
}
```

日常運用では会話本文をそのまま保存せず、ちゃがstructured planへ変換して登録する。

## 6. Security

絶対条件:
- anon/authenticated一般userからwriter実行不可
- service_role/backend admin boundaryのみ
- RLSを無効化しない
- SECURITY DEFINER採用時 `search_path=''` 等既存安全規約に従う
- dynamic SQL不要なら使わない
- brand/account OAuth/Vault secretへアクセスしない
- writerがX投稿を直接起動しない
- writerはCron/posting windowを変更しない

将来social-mobile一般ユーザーからの編集は、このadmin writerを直接開放せず、membership/tenant認可済みbackend境界を別Phaseで設計する。

## 7. Disposable DB proof

productionではなくdisposable/local/test DBで、Phase1 migration + writer candidateを適用して自動検証する。

最低限:
- first active plan create
- second active version archives prior active
- active count exactly 1
- draft create does not replace active
- invalid payload rejects/no row
- duplicate item id rejects
- null/omitted slot accepted
- explicit slot accepted
- request_key retry/idempotency
- concurrent activation safety（可能な範囲で）
- anon/authenticated execute denied
- service-role/admin path allowed
- read consumer expected queryでlatest activeが取れる
- rollback/preflight/postflight SQLが成立

## 8. Source boundary

このPhaseで触れてよい:
- `daily_content_plans` migration candidate
- writer用の新規migration/RPC/helper/tests/docs
- 必要ならbrand-neutral shared validation helper
- `.agent/CODEX_REPORT.md` / this TASK

このPhaseで触れない:
- `supabase/functions/x-test-post/index.ts`
- market-report files/functions/migrations
- personalized-reports
- apps/social-mobile files
- OAuth/Vault/token refresh
- Mio/Kabumori generation behavior

## 9. Production boundary

禁止:
- production migration apply
- `supabase db push`
- production RPC/RLS/grant change
- Edge Function deploy
- `x-test-post` deploy
- Cron/window変更
- manual/synthetic X post
- retry/backfill
- OAuth/Vault/token/secret mutation

**production mutation = 0でC1へ返すこと。**

## Verification / completion

最低限:
- disposable DB proof PASS
- writer unit/integration tests PASS
- relevant existing daily plan tests PASS
- `git diff --check` PASS
- secrets 0
- production mutation 0

C1 reportに明記:
- exact schema/RPC contract
- validation rules
- version/activation/idempotency algorithm
- canonical ChatGPT payload
- disposable DB proof
- changed files
- exact commit/hash
- rollout order: base table migration → writer migration/RPC → read-back/preflight → consumer deploy（consumer deployはG1 conflict解消後の別承認）
- rollback plan

完了時:
- `.agent/CODEX_REPORT.md`先頭にPhase2 report
- this TASKを `status: review_required`, `next_owner: chatgpt`
- safe candidateをpush/read-back
- C1待ちでSTOP
