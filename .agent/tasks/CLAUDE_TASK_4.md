# Claude Task 4

- task_id: x-social-mobile-posting-interaction-phase2-20260928
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: accepted Phase 1 Home/posting/history基盤の次として、一般ユーザーが投稿内容を確認・編集・再生成・承認し、失敗時に理由と次の行動を理解できる投稿操作UXを実装する。既存backend契約を再利用し、存在しないbackend機能をfakeしない。

## Source / accepted state

- Phase 1 PR #44 accepted/fixed and integrated before current main
- G3 Auth Phase 2 accepted and merged to main as `fbddef2535b82bf4775c2e4fddb93eeefb8c638a`
- G4 queued Phase 2 scope from `.agent/CURRENT_STATE.md`:
  - draft/post preview
  - manual edit
  - AI regenerate
  - approve
  - schedule/post action only where backend exists
  - failure reason
  - retry
  - reconnect-to-X CTA
  - schedule/history -> detail -> edit/approve
  - manual approval vs auto-post distinction

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - current social-mobile Home/schedule/history/post-detail/settings code
2. Use an independent G4 worktree/checkout.
3. Fresh fetch `origin/main`; branch from accepted current main.
4. Inventory backend/data contracts before adding UI actions.
5. G3 owns Auth/account/login-method/config-readiness files. Stop on overlap.
6. Do not invent a successful backend action where no contract exists.

## Product goal

A user should be able to move through a truthful posting flow:

`予定/下書き -> 内容確認 -> 必要なら編集/再生成 -> 承認 -> 予約/投稿状態確認 -> 失敗時は理由と次の行動`

while always understanding whether:
- this post requires manual approval
- auto-post is enabled
- the post is only a preview/draft
- the post is scheduled
- the X connection needs reconnect
- a backend action is unavailable

## Stage A — inventory / contract map

Classify current capabilities:
- real and writable
- real but read-only
- source-only/not production-applied
- unavailable
- mock-only

Cover:
- draft/body source
- edit persistence
- regenerate endpoint/action
- approval state
- schedule action
- post-now action
- retry action
- failure reason
- reconnect-required state
- history/detail data

Document blockers instead of faking them.

## Stage B — post preview/detail UX

Implement or improve a truthful post preview/detail surface.

Show where available:
- post body
- account
- scheduled time
- state/status
- manual approval / auto-post mode
- latest failure reason
- retryability
- X reconnect requirement

If the authoritative body is unavailable in real data, do not silently display mock text.

## Stage C — manual edit

If an existing safe persistence contract exists:
- allow editing draft text
- validate length/basic input
- save using existing backend/repository path
- reload and show persisted truth

If no real persistence contract exists:
- implement UI boundary/interface only if useful
- disable action truthfully
- report exact backend gap

Do not add a new production DB schema in this task unless explicitly required and authorized; STOP if that becomes necessary.

## Stage D — AI regenerate

Use an existing regenerate/generation action only if it already exists and has a safe contract.

Requirements:
- clear loading/error state
- no duplicate request on repeated tap
- regenerated content must remain pending approval if manual approval mode applies
- never auto-post merely because regeneration succeeded

If backend regenerate does not exist, do not mock success. Provide a disabled/coming-later state and report.

## Stage E — approve / schedule / post action

Wire only actions backed by existing contracts.

Preserve:
- manual approval != auto-post
- approval does not imply immediate X post unless contract explicitly says so
- auto-post state is shown clearly
- no production posting from tests/task execution

Prevent accidental double-submit.

## Stage F — failure / retry / reconnect

For failed items:
- expose human-readable failure reason where safely available
- distinguish retryable vs non-retryable if backend supports it
- show reconnect-to-X CTA when auth state indicates reconnect is required
- CTA may navigate to the existing X connection flow, but G4 must not modify G3 Auth implementation

Never expose raw secrets/provider tokens/server stack traces.

## Stage G — navigation flow

Make these paths coherent where supported:
- Home -> next post -> detail
- Schedule -> post detail
- History -> failed/sent post detail
- Detail -> edit/regenerate/approve/retry
- Detail -> reconnect to X when required

Back navigation must not lose persisted state or fabricate success.

## Truthfulness rules

Never:
- fall back from unavailable real data to mock data without an explicit dev/mock mode
- show “投稿済み” if only locally changed
- show “予約済み” before backend confirmation
- show “再生成完了” before real response
- show retry success before backend confirmation
- imply real posting in task tests

## G3 separation

Do not modify:
- Auth callback parsing
- provider linking
- PKCE/recovery/session storage
- login methods
- provider readiness/config validation

You may consume existing Auth/X reconnect status and navigate to an existing route.

If a G3 file must change, STOP and report.

## Tests

Add focused tests for:
- real vs mock truthfulness
- edit persistence or disabled state
- regenerate double-submit prevention
- approval/manual-auto distinction
- schedule/post confirmation truthfulness
- failed-post reason mapping
- reconnect CTA condition
- retry state
- navigation from schedule/history/detail

Run:
- full social-mobile tests
- data-view tests
- typecheck
- lint
- Expo web export
- Expo iOS export where current project supports it
- git diff --check
- secret scan

## Production constraints

Do NOT:
- make a real X post
- enable publish authority
- change Stage 3B rollout
- mutate production DB/schema/RLS/RPC
- deploy production backend
- alter Auth provider consoles/secrets

production_mutation=0.

## Review policy

Do not request Codex review automatically.
This is primarily user-facing app UX on existing contracts.

At K4, report any newly introduced DB/API/auth/publish boundary.
If none, normal ChatGPT completion review is enough.

## Completion / K4

Report:
- architecture/flow implemented
- real backend capabilities found
- disabled/unavailable capabilities
- changed_files
- tests
- screenshots/preview notes if practical
- backend blockers
- production_mutation=0
- G3 overlap=0 or exact overlap reason
- whether review is actually needed
- recommended next G4 step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K4.


## Report

- task_id: x-social-mobile-posting-interaction-phase2-20260928
- result: **PASS（source-only、要求どおりtruthful）**。編集・再生成・承認・再試行のいずれにも、本番から呼べるbackend契約が現状存在しないことを確認した。既存契約が無いものは「使える見た目にしない」方針どおり、理由付きの無効化ボタンとして実装した。PR #49（未merge）。DB/API/Auth/publish境界の新規追加は無し。
- model_used: Sonnet 5（高）
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（コードは新規branch `g4/social-mobile-posting-interaction-phase2-20260928`、TASK更新はworktree本来のbranchから）
- PR: https://github.com/anohi-memories/kabumori/pull/49 （head `15e9f74`、OPEN、MERGEABLE）

### architecture/flow implemented

`Home/投稿予定/履歴 → 投稿詳細` の遷移はPhase1で実装済み（変更なし）。今回は投稿詳細画面（`posts/[id].tsx`）に以下を追加した。

1. **状態・失敗理由**: 既存のPill表示に加えて、`failed`の投稿には失敗理由の行を追加（現状は「まだ確認できません」と正直に表示、下記参照）。
2. **投稿モードカード**: 「自動投稿 ON/OFF」（`account.postingState`、Homeと同じ既存field）と「承認: 手動確認が必要 / 自動投稿を許可」（`content_settings.approvalMode`、settings/consult画面と同じ既存repository経由）を**別軸**として両方表示。片方だけで判断しない設計。
3. **Xの再接続CTA**: 接続中のいずれかのXアカウントが`needs_attention`なら、既存の`/accounts`ルートへのカードを表示（G3のOAuth実装は不変更・再利用のみ）。
4. **4つの操作（編集・再生成・承認・再試行）**: すべて無効化ボタン＋理由テキスト。`retry`は`failed`の投稿にのみカードを表示。

### Stage A — inventory / contract map（結論）

| capability | 分類 | 根拠 |
|---|---|---|
| 投稿本文の取得 | unavailable（真実） | `scheduled_posts`に本文列が無い（本番・候補migrationとも）。`text`は常に空文字。 |
| 投稿本文の編集保存 | unavailable | 同上、書き込み先が存在しない。 |
| AI再生成（この投稿単位） | unavailable | この投稿1件を再生成して保存するcontractは無い。`social-mobile-brand-dry-run`はワークスペース単位のプレビューのみで、投稿を作成・更新しない（Home既存機能、重複実装しない）。 |
| 承認/投稿予定への追加 | unavailable | クライアントから呼べるRPCが無い。 |
| 予約/投稿実行 | unavailable/mock-only | `schedule_account_bound_post_v2`等はすべて`revoke ... from authenticated; grant execute ... to service_role`のみ。加えてこの一式（`supabase/migrations/20260924023133_x_autopost_phase1b_account_bound_queue.sql`）自体が「SOURCE CANDIDATE ONLY. Do not apply until a separately reviewed dispatcher cutover.」で未適用。 |
| 再試行 | unavailable | 同上（`settle_post_pre_x_v2`等も同じ理由）。 |
| 失敗理由 | source-only/real but read-only（未接続） | `post_execution_logs.message`はDBに存在するが、基本grantは`service_role`のみ。`authenticated`への読み取りはPhase4候補ポリシー（`social_mobile_brand_memberships`migration、未適用）に依存し、かつ`post_execution_logs.brand_id`列が実際に存在するかがmigration履歴だけでは確認しきれなかった（他のいずれのmigrationにも明示的な追加が見当たらない）。不確実なスキーマに対して投機的なクエリを追加するより、正直に「未接続」と報告する方を選んだ。 |
| Xの再接続要否 | real, read-only, usable | `social_accounts.connection_status`は既存の`useActiveAccount`経由で取得済み。新規contract不要。 |
| 承認モード（manual_review/auto_post_preference） | source-only（Phase14候補、本番未適用）だが、読み取りコード自体は既存 | `social_mobile_content_settings`は「Phase 14 source candidate only. Do not apply to production in this phase.」。読み取りに失敗した場合は既存の`unavailable`分類でPillが「確認できません」になる、安全側の設計は変更していない。 |
| 履歴/詳細データ | real, read-only, usable | Phase1で実装済み、変更なし。 |

### Stage B〜F — 実装内容（disabled/unavailable capabilities含む）

上記「architecture/flow implemented」に記載のとおり。**偽の成功は一切出していない**（Truthfulness rulesの5項目すべてに抵触しない設計・レビュー済み）:
- 「投稿済み」はローカル変更だけでは出ない（そもそも編集自体ができない）。
- 「予約済み」はbackend確認前には出ない（そもそも予約操作自体ができない）。
- 「再生成完了」は実レスポンス前には出ない（そもそも再生成自体ができない）。
- 「再試行成功」はbackend確認前には出ない（そもそも再試行自体ができない）。
- テスト・タスク実行中に実投稿を示唆する表示は無い。

### Stage G — navigation flow

Home→次の投稿→詳細、投稿予定→詳細、履歴→詳細はPhase1のまま健全（変更なし、確認のみ）。詳細→編集/再生成/承認/再試行は「無効な操作」として到達可能（Stage Gの要求どおり、隠さず理由を示す）。詳細→Xへの再接続は新規、既存`/accounts`へのnavigateのみ。

### changed_files

新規: `src/domain/post-interaction.ts`、`src/domain/post-interaction.test.ts`。
変更: `src/app/posts/[id].tsx`（全面書き換え）、`src/components/ui.tsx`（`ActionButton`に`disabled` propを追加、既存呼び出し元は非破壊）。
すべて`apps/social-mobile`配下。DB/RLS/RPC/migration/Auth設定の変更なし。

### tests

- `node --experimental-strip-types --test src/domain/post-interaction.test.ts`: **8/8 pass**。
- `node --experimental-strip-types --test src/domain/data-view.test.ts`: **14/14 pass**（回帰なし、Phase1のまま）。
- `npm test`（`tests/*.test.mjs`、G3 Auth Phase2一式）: **43/43 pass**（無関係・回帰なし）。
- `npm run typecheck`: PASS（このセッションでの`npm install`実行後に確認。`expo-apple-authentication`等G3 Phase2依存の未インストールを検出・解消してから実施）。
- `npm run lint`: PASS。
- `npx expo export --platform web`: 成功。
- `npx expo export --platform ios`: 成功（1215 modules、エラー0。実機/シミュレータでの起動確認ではなく、bundleの成立確認）。
- `git diff --check`: PASS。差分に対する簡易secret scan: 該当なし。
- 実ログイン・実Supabase接続での画面確認: 未実施（このセッションに認証情報が無いため。Phase1と同じ制約）。

### backend blockers

上記Stage Aの表のとおり。要点を再掲:
1. `scheduled_posts`に本文列が無い（編集・再生成の根本ブロッカー）。
2. Phase1b dispatcher一式（承認/予約/投稿実行/再試行のRPC群）が`service_role`専用かつmigration自体が未適用。
3. `post_execution_logs`（失敗理由の格納先）は`authenticated`への読み取り経路が未確定（Phase4候補migration依存＋`brand_id`列の存在が未確認）。

### production_mutation

**0件**。DB/RLS/RPC/migration/Auth設定/本番デプロイいずれも無し。branchへのpush + PR作成のみ。

### G3 overlap

**0件（重なりなし）**。変更ファイルは`posts/[id].tsx`・`ui.tsx`・新規`domain/post-interaction.*`のみで、G3のAuth Phase2/Phase3のファイル一覧（auth-provider・onboarding・x-connect・account/provider-readiness関連）とは重複しない。

### whether review is actually needed

**不要**。新規のDB/API/Auth/publish境界を導入していない（唯一の新規読み取りは、既存の`SupabaseContentSettingsRepository`を承認モード表示のために別画面から再利用しただけで、新しいtable/RPC/grantではない）。TASKのreview policyどおり、通常のChatGPT完了確認で十分と判断する。

### recommended next G4 step

1. Phase 3以降の本格的な投稿操作（編集・再生成・承認・予約・再試行の実backend化）は、今回inventoryした3つのblocker（本文列・dispatcher RPCのauthenticated開放・失敗理由の読み取り経路）を解消する別TASK（DB/RLS/RPCを伴うため、TASKの性質上レビュー必須）が先に必要。範囲・優先度はChatGPT/ユーザーの判断。
2. `post_execution_logs.brand_id`の実在有無を、DBスキーマの直接確認（migration履歴だけでなくINFORMATION_SCHEMA等）で確定させておくと、次のPhaseで失敗理由の読み取りを安全に設計しやすい。
3. PR #44・PR #49（Phase1・Phase2）とも、実ログインでの画面確認はこのセッションではできていない。実機/実アカウントでの見た目確認が必要なら、認証情報を用意した別TASKで実施する。

## Completion

- status -> review_required
- next_owner -> chatgpt
