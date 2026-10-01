# Claude Task 3 — CURRENT TASK

- task_id: x-social-mobile-ai-consult-v1-20261002
- owner: claude
- slot: claude-3
- status: in_progress
- next_owner: claude
- priority: high
- recommended_model: Opus5.5（高）
- type: feature implementation / AI conversation / Edge Function / authenticated settings proposal
- production_mutation_allowed: false

## Product goal

X自動投稿アプリの「AIと相談する」を、現在のローカル疑似判定から**本当にAIと自然に会話できる機能**へ進める。

この機能は投稿生成そのものではなく、その前段としてAIがユーザーを理解する場所。

ユーザーは普通の会話で、
- どんな投稿をしたいか相談する
- AIから不足情報を質問してもらう
- 発信テーマ、文体、読者、目的、NG表現などを整理する
- 現在AIが理解している投稿方針を聞く
- 簡単な雑談や一般的な質問をする
ことができる。

会話から設定変更候補が生まれても、**AIは勝手に保存しない**。
必ずユーザーが内容を確認して「これで覚えて」等の明示操作をした後だけ、既存の投稿設定 / PersonaProfileへ保存する。

過去X投稿の実取得・分析はこのTASKでは行わない。現在の同意導線・意図検出を壊さず、K3後に別G4 TASKとして接続できる境界だけ維持する。

## Existing foundation — preserve and reuse

Fresh mainで以下が既に存在する。

- `apps/social-mobile/src/app/(tabs)/consult.tsx`
  - 会話画面
  - 保存前提案カード
  - 明示確認
  - existing settings/persona read/save
- `apps/social-mobile/src/domain/content-settings.ts`
  - `SocialMobileContentSettings`
  - `PersonaProfile`
- `apps/social-mobile/src/domain/content-settings-conversation.ts`
  - bounded structured proposal
  - untrusted AI-output validator
  - publish/account/OAuth/token/scheduler controlsの拒否
  - past-post learning intent scaffold
- `apps/social-mobile/src/data/content-settings-repository.ts`
  - existing `social_mobile_content_settings` storage
  - settings + confirmed persona save
  - settings-only saveがpersonaを消さない設計

Current `createConversationalAssistantProposal()` is deterministic/local scaffolding. This TASK replaces the runtime conversation path with an authenticated server-side AI boundary while keeping deterministic helpers/validators useful for tests/fallback where appropriate.

## Mandatory startup / isolation

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G3 worktree/checkout. Do not use G1/G2/G4/G5/H1/H2 worktrees, untracked files, simulator, Metro or branch.
3. Fresh `origin/main`.
4. Confirm G4 is done and PR #65 merged.
5. Confirm G5/H1 common-account PR #70 work does not overlap intended runtime files.
6. **Do not create or edit a DB migration in this TASK.** Existing `social_mobile_content_settings` schema/persona columns are the storage boundary. If production/source schema is actually insufficient, STOP and report the exact missing column/constraint instead of creating a migration while the common-account migration review is active.
7. Inspect existing AI/LLM Edge Functions/shared helpers/model config and reuse the established provider/client/usage/error patterns. Do not introduce a new AI vendor or duplicate secret scheme.

## Functional requirements

### 1. Real conversational AI

Implement an authenticated server-side AI conversation endpoint for social-mobile consultation.

Preferred boundary:
- a dedicated narrowly scoped Edge Function such as `social-mobile-consult`, unless repository conventions clearly point to an existing suitable endpoint.
- client never receives AI provider secret.
- no direct provider call from Expo client.

Request should be bounded and include only what the assistant needs:
- current brand/workspace id
- current confirmed `SocialMobileContentSettings`
- current confirmed `PersonaProfile` if present
- bounded recent conversation turns from this consultation session
- current user message

Do not send:
- OAuth tokens
- X access/refresh tokens
- Vault ids/plaintext
- provider credentials
- unrelated workspace data
- raw account deletion/auth internals.

Keep history bounded. Do not send an unlimited chat transcript.

### 2. Natural conversation modes

The AI must support at least these behaviors without requiring explicit mode buttons:

**A. General conversation / simple questions**
Examples:
- 「今日何投稿しようかな」
- 「Xってどれくらいの頻度がいい？」
- 「最近ネタがない」
- 「ちょっと疲れた」
- simple casual conversation / brainstorming / general questions

It should answer naturally.
A normal answer **must not automatically create a settings proposal**.

No web search/current-news browsing in v1. If the user asks for genuinely current/external facts that cannot be known from supplied context, the assistant should say that this consultation chat does not currently fetch live web information rather than inventing it.

**B. Preference discovery**
When the user wants help deciding posting style or has not supplied enough detail, AI should ask concise follow-up questions naturally.

Important:
- avoid a rigid questionnaire dump.
- ask preferably 1 useful question at a time, at most 2 when tightly related.
- do not force questions when enough information exists.
- use already confirmed settings/persona so it does not repeatedly ask what it already knows.

Useful dimensions include:
- main themes
- intended audience
- purpose
- tone/formality
- post length / sentence length
- emoji/punctuation tendencies
- CTA style
- hashtag tendency
- topics/expressions to avoid
- posting frequency preference
- personal/private disclosure boundaries where explicitly discussed

Do not invent personal facts.

**C. Explain current understanding**
If user asks things like:
- 「今どういう設定になってる？」
- 「俺の投稿方針どう理解してる？」
AI should explain the currently saved settings/persona clearly without proposing a mutation unless the user asks to change something.

**D. Settings/persona proposal**
Only when the conversation contains a reasonably clear preference/change should the AI return a structured proposal delta.

Examples:
- 「もっと親しみやすくして」
- 「AIの話を多めにしたい」
- 「絵文字は少なめ」
- 「週5回くらい」

Proposal must be a **delta**, not a replacement snapshot, so unrelated saved fields are preserved.

Ambiguous statements such as「AIの話多めでもいいかな」should be handled conversationally and may ask/offer confirmation rather than silently treating them as durable settings.

### 3. Structured AI contract

Keep/reuse `validateConversationalAssistantResult()` as the trust boundary and strengthen it if needed.

Model output must be parsed as untrusted structured data containing conceptually:
- assistant reply
- optional settings delta
- optional persona delta
- follow-up questions
- confidence / uncertainty
- history-learning intent
- requires confirmation = true for any persistent change
- publish permission changed = false

Add explicit distinction if helpful between:
- chat-only response
- clarification/question
- proposal

But do not allow the model to control:
- auto-post on/off
- publish permission
- posting execution
- scheduler
- OAuth/account selection
- Auth/session
- deletion
- secrets/tokens.

Malformed/unsafe structured output must fail closed:
- show a safe retryable assistant error or safe chat fallback
- do not save anything
- do not alter posting state.

### 4. Confirmation and persistence

Existing principle remains mandatory:

**conversation → proposal → user confirmation → save**

Never:
- mutate settings on AI response arrival
- mutate persona because AI “learned” something without confirmation
- enable posting
- create scheduled posts
- change X connection.

When user confirms:
- apply only the returned delta to the latest known/safely refreshed saved state
- preserve unrelated existing fields
- save settings/persona using the existing repository/storage boundary
- visibly report save success/failure.

If a proposal became stale because saved settings changed during the conversation, prefer re-read/merge or require reconfirmation rather than silently overwriting unrelated newer settings.

### 5. Conversation UX — functional only

UI design will be substantially redesigned later. Do NOT spend time on polish.

Functional minimum:
- user message input
- send action
- visible assistant/user turns
- loading state
- retryable error state
- proposal/“AIが理解した内容” block only when there is something persistent to confirm
- clear explicit confirmation button
- clear indication after successful save
- user can keep chatting after a proposal/save
- current settings can be explained through conversation.

Do not redesign global navigation, theme, cards, spacing, animation, avatar, etc.

### 6. Past-post learning handoff

Do **not** fetch X history in this TASK.

If user says:
- 「過去の投稿を読んで」
- 「自分の過去ポストから学んで」
the AI may recognize the intent and explain that past-post learning requires explicit confirmation / the upcoming learning flow.

Preserve a structured `historyLearningIntent` boundary so the next G4 task can attach:
- verified connected X account
- bounded post fetch
- style analysis
- user confirmation
without redesigning this chat contract.

No X API read/write in this TASK.

## Authentication / authorization boundary

Because this adds an Edge Function/API boundary:

1. Require valid user JWT/session.
2. Do not trust a client-supplied brand id by itself.
3. Verify the caller has current allowed membership/ownership for that brand using the repository's established social-mobile authorization pattern.
4. Do not use future/common-account service entitlement semantics from unmerged PR #70.
5. Fail closed for missing/ambiguous membership.
6. Never log Authorization headers, JWTs, user email, AI provider secrets, X tokens, or full sensitive conversation bodies.
7. Prefer metadata-only logs: request id, result class, bounded lengths/counts, error code, duration/model usage if existing conventions support it.

## Cost / abuse bounds

Reuse existing AI cost/usage helpers if present.

At minimum:
- cap user message length
- cap number of conversation turns sent
- cap total context length
- cap model output
- one model call per send under normal path
- no automatic recursive “agent” loops
- no web search
- no X API call
- bounded timeout
- deterministic error path.

Use the least expensive existing model/config that safely supports the repository's structured-output contract; do not introduce a premium model simply because Claude is implementing the feature.

## Data/privacy behavior

For v1:
- do not create a new table to persist raw chat transcripts.
- raw conversation may live in screen/session state only.
- durable memory is the **user-confirmed structured settings/persona**, not the entire transcript.
- do not store raw conversation text in analytics/logs.
- if existing observability captures request bodies, explicitly prevent consultation text from being logged there.

This keeps the “AI learns me” behavior transparent: it remembers only what the user confirms.

## Tests

Add focused tests for at least:

### Server/API
- unauthenticated request rejected
- caller without brand membership rejected
- valid member accepted
- bounded message/history input
- oversized/malformed input rejected
- AI secret never returned/logged
- safe model response parses
- malformed JSON/shape fails closed
- model attempt to include publish/OAuth/token/scheduler/account controls rejected
- chat-only response creates no proposal
- proposal response cannot persist by itself
- current-settings explanation path has no mutation
- past-post intent creates no X API call
- provider timeout/error is safe/retryable
- model call count bounded

### Domain/client
- multi-turn assistant history sent in bounded form
- normal chat displays reply without proposal card
- follow-up question displays naturally
- proposal displays only changed fields
- explicit confirmation persists
- unconfirmed proposal persists nothing
- correction in later turn supersedes/replaces prior pending proposal safely
- unrelated settings remain unchanged when applying a delta
- existing persona not erased by settings-only confirmation
- settings changed after proposal cannot be silently clobbered
- general chat never toggles posting/scheduling/X connection
- history-learning request stays consent-gated / no fetch.

Run:
- new focused tests
- full social-mobile tests
- relevant Edge Function/shared tests
- typecheck / lint / runtime check per repo conventions
- `git diff --check`
- secret scan
- scope diff check.

No live paid AI call is required in automated tests; mock/stub the model boundary.

## Local verification

Use G3-owned environment only.

Verify with local/mock AI responses or a safe dev invocation:
1. greeting / casual conversation returns a natural answer
2. 「どんな投稿にしたらいい？」 produces a useful follow-up question
3. 「親しみやすく、AIの話を多めにしたい」 produces a reviewable proposal
4. before confirmation, saved settings unchanged
5. after explicit confirmation, local/test storage shows only intended changes
6. 「今どういう設定？」 explains saved understanding
7. 「過去投稿を読んで」 does not call X and remains consent-gated
8. no posting/schedule/X connection side effect.

Do not use real X posting or destructive production flows.

## DB / migration rule

**No new migration in this task.**
Use the existing `social_mobile_content_settings` settings/persona storage.

If the required production schema columns are absent or incompatible:
- STOP
- report exact evidence
- do not create a migration
- do not borrow/modify PR #70 common-account migration.

## Explicit non-scope

- actual past-X-post retrieval/analysis
- AI-generated post creation
- editing/regeneration/approval of a generated post
- automatic posting
- scheduled posting
- X API read/write
- x-connect/OAuth behavior
- login provider changes
- account deletion
- common-account/service-entitlement implementation
- new DB migration/schema
- major UI redesign
- production deploy
- feature flag rollout.

## Production / safety

This is **source + tests + PR only**.

Forbidden:
- production Edge Function deploy
- production DB mutation
- migration apply
- real X API operation
- real X post
- Vault mutation
- Auth mutation
- provider configuration mutation.

## Completion / K3

Report:
- task_id
- result
- architecture / endpoint chosen
- existing foundations reused
- exact AI request/response trust boundary
- authorization checks
- chat modes implemented
- confirmation/persistence semantics
- changed_files
- tests
- local verification
- AI/provider/model usage policy
- DB migration = none
- production mutation = 0
- real X operations = 0
- remaining issues
- safety_checks
- commit_hash / push / PR
- next_recommendation.

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

### Expected next stage

Because this task introduces an authenticated AI Edge Function/API boundary, K3 should normally allocate a focused Codex review before merge.

Likely review:
- H2 if free
- recommended Codex model: **Sol（高）**
- focus: Auth/membership boundary, prompt/structured-output injection, no implicit persistence, cost bounds, no publish/X side effects.

Only after source review/merge should G4 be assigned the real **past-post learning** integration.

---

# Claude Task 3 — CURRENT TASK

- task_id: x-ai-lab-dev-diary-kabumori-hero-8state-sync-20261002
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: low
- recommended_model: Sonnet5（中）
- type: AI Lab public-safe development diary context sync
- production_mutation_allowed: false

## Purpose

Final K1で完了した「かぶモリ Home Report Hero 8-state integration」を、会社員AIラボの公開安全な開発日記題材へ同期する。

これはX投稿生成ロジックの改修ではない。
共有メモ正本と、そのcommit済みruntime snapshotの同期だけを行う。

## Source fact

実際に完了・merge確認済みの事実:
- かぶモリHomeのレポートHeroで、レポート内容に応じて8種類のキャラクター表情を切り替えるUIを実装した。
- 追加AI呼び出しなしで、保存済みレポートの情報から表示状態を決める。
- 画面幅や「今日のポイント」1〜3件の差でも崩れないよう調整した。
- iOS Simulatorで複数幅を確認した。
- EAS build / production backend mutationは行っていない。

公開文にはPR番号、task_id、branch、commit SHA、内部テーブル/関数名、秘密情報を入れない。

## Required changes

1. `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`
   - 2026-10-02に既存entryがあるため、**同日entryを増やさない**。
   - 既存2026-10-02 entryはX自動投稿アプリの不具合修正について書かれているので、その内容を壊さない。
   - 1日1entry原則を守るため、今回のKabumori Hero内容を同entryへ無理に混ぜない。
   - 代わりに **2026-10-03 entryとして先取りして書かないこと**。
   - 結論として、正本Markdownへ新しい日付entryを追加できないため、今回のK1内容は**保留メモとしてTASK Reportへ記録するだけ**にする。日付が変わって実際の10/03作業が発生した場合のみ別TASKで追加する。

2. このTASKでは runtime snapshot / generator / tests を変更しない。

## Important

「K1で公開安全な題材候補がある」こと自体は記録するが、存在しない日付の開発日記を捏造しない。
同日1entryルールを破らない。
既存2026-10-02 entryを書き換えて異なる2つの開発内容を混在させない。

## Tests

- source diffが `.agent/**` のみであること
- `git diff --check`

## Completion

Reportに以下を記録:
- task_id
- result
- diary update performed: no
- reason: existing 2026-10-02 entry + one-entry-per-day rule
- preserved public-safe candidate text for future manual/next-day use
- production mutation: 0
- changed_files
- next_recommendation

その後:
- status -> done
- next_owner -> none
- STOP.

Recommended model: **Sonnet5（中）**.

## Report — K1 diary decision

- task_id: `x-ai-lab-dev-diary-kabumori-hero-8state-sync-20261002`
- result: **NO SOURCE UPDATE REQUIRED / DONE**.
- diary update performed: no.
- reason: canonical diary already has a real 2026-10-02 entry, and the documented rule is one entry per day. The K1-completed Kabumori Hero work is a valid public-safe candidate, but creating a duplicate same-day entry or pre-dating 2026-10-03 would break the diary contract.
- preserved candidate: 「株アプリのホームで、その日のレポート内容に合わせて8種類のキャラクター表情を切り替え、画面サイズやポイント数が変わっても崩れないよう調整した。」
- production mutation: 0.
- changed_files: `.agent/tasks/CLAUDE_TASK_3.md` only.
- next_recommendation: do not consume a Claude slot; reuse the candidate only if a later real diary-update task needs a backlog of public-safe development topics.
- next_owner: none.

---

## Archived previous G3 task

# Claude Task 3

- task_id: x-social-mobile-native-link-navigation-cleanup-20261001
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: medium
- recommended_model: Sonnet5（高）
- continues_from: x-social-mobile-account-deletion-ui-release-finish-20261001
- purpose: PR #68 / PR #65 後に残った social-mobile の native navigation UI 不具合を、Link-asChild の既知パターンに限定して修正・再発防止する。

## Confirmed current-main findings

Fresh main で以下を確認済み。

1. `apps/social-mobile/src/app/accounts/index.tsx`
   - 「ログイン方法」カードがまだ `<Link asChild><Pressable style={({ pressed }) => ...}>`。
   - PR #68 で確定した同じ root cause により、native で card styling が落ちる既知パターン。
   - G4 PR #65 は Final K4 PASS で merge 済みのため、現在はG4所有競合なし。

2. `apps/social-mobile/src/app/(tabs)/settings.tsx`
   - 「会話で相談する」が `<Link asChild><Card>...`。
   - `Card` は navigation press handler を受け取らないため、native確認で dead tap になっている。

3. PR #68 の `native-link-button-style.test.mjs` には `accounts/index.tsx` の known allowlist が残っている。今回の修正後はこの例外を除去する。

## Mandatory startup

1. Read `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G3 worktree/checkout.
3. Fresh `origin/main`.
4. Confirm G4 task is done and PR #65 is merged; do not reopen OAuth/auth-session work.
5. Confirm H1/G5 common-account work does not overlap the UI files below.
6. Do not reuse another slot's untracked files, .env, Simulator process, Metro process, branch, or worktree.

## Primary required fixes

### A. Accounts screen — 「ログイン方法」card

Fix the remaining native styling defect in:
- `apps/social-mobile/src/app/accounts/index.tsx`

Requirements:
- the whole intended card/tap target remains visibly styled on native iOS.
- tap navigates to `/login-methods`.
- preserve accessibility role / readable label.
- do not change X-connect hook, connect/reconnect behavior, OAuth, PKCE, callback, or account data.
- remove `accounts/index.tsx` from the known-unfixed allowlist once fixed.

Prefer the already accepted safe pattern:
- standalone `Pressable` + `router.push`
rather than `Link asChild` around a function-styled Pressable.

### B. Settings — 「会話で相談する」

Fix:
- `apps/social-mobile/src/app/(tabs)/settings.tsx`

Requirements:
- the card is visibly tappable.
- tap navigates to `/(tabs)/consult`.
- preserve the existing copy and overall layout.
- no content-settings persistence logic change.

Prefer explicit navigation with an interactive element rather than relying on `Link asChild` to inject press behavior into a component that does not forward it.

## Narrow same-pattern audit

Audit only `apps/social-mobile/src/app/**` and `apps/social-mobile/src/components/**` for these two specific invalid compositions:

1. `Link asChild` + direct child with function-valued `style` that can be lost by Slot style merging.
2. `Link asChild` + direct child such as `Card` / `View` that does not actually forward the injected press handler/ref and is therefore dead/non-interactive.

For every match:
- classify as broken / safe / false positive with concrete source reason.
- fix only demonstrably broken navigation in the same family.
- do not broaden into visual redesign or unrelated route cleanup.
- if a shared UI component change is proposed, make it only if it is strictly safer/smaller than fixing the call sites and regression coverage proves all consumers remain safe.

Potential rows mentioned by prior G3 report (history/schedule/account rows) are **audit candidates, not automatic edit targets**. Prove the issue before changing them.

## Tests

Update/extend `apps/social-mobile/tests/native-link-button-style.test.mjs` or a narrowly named companion test so that:

- `accounts/index.tsx` is no longer allowlisted.
- no `Link asChild` + function-valued direct-child style remains in app/components.
- the detector also catches the proven dead `Link asChild > Card/View` class where the child cannot receive/forward press behavior.
- detector self-tests prove the scanner actually fails on synthetic broken examples.
- the Accounts 「ログイン方法」 target is an interactive element with explicit navigation to `/login-methods`.
- Settings 「会話で相談する」 is interactive and explicitly navigates to `/(tabs)/consult`.
- any additional call-site fix gets a focused route/navigation regression.

Run:
- social-mobile full tests
- typecheck
- lint
- `git diff --check`
- focused static/navigation tests
- secret/scope diff check

## Native verification

Use a G3-owned local iOS Simulator environment only.

Verify at minimum:
1. Accounts → 「ログイン方法」 card has expected visible card styling and opens Login methods.
2. Settings → 「会話で相談する」 visibly responds to tap and opens Consult.
3. If any additional same-pattern call site was changed, visually/tap-verify that route too.
4. No production data mutation is needed; sample/mock data preferred.
5. No EAS build unless local verification is genuinely impossible.

Temporary local auth/sample-data harness is allowed only if:
- isolated to G3,
- untracked/uncommitted,
- reverted/removed after verification,
- does not connect to protected production data.

## Explicit non-scope

Do NOT change:
- `apps/social-mobile/src/features/x-connect/**`
- OAuth / PKCE / callback / provider behavior
- Supabase Auth/provider flows
- account deletion backend/state machine
- common-account/service-entitlement work
- DB / RLS / RPC / migrations
- Edge Functions
- Vault/token storage
- scheduler/posting
- production feature flags
- App Store/TestFlight/EAS release configuration

## Production / safety

- source + tests + PR only
- production mutation = 0
- real X operations = 0
- no deploy
- no account deletion
- no provider login/revoke/post
- do not expose secrets or personal credentials

## Completion / K3

Report:
- task_id
- result
- exact broken Link-asChild patterns found
- exact files fixed
- audit matrix (broken / safe / false positive)
- changed_files
- tests
- native simulator result
- proof x-connect/Auth/deletion/common-account/backend scopes unchanged
- commit_hash
- push
- PR
- production mutation = 0
- real X operations = 0
- remaining issues
- safety_checks
- next_recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Expected review policy:
- if changes stay UI/navigation-only and native verification passes, additional Codex review is normally unnecessary.
- if implementation touches shared interactive primitives broadly, Auth/OAuth, or any backend boundary, STOP and let ChatGPT decide review before merge.


## Report — x-social-mobile-native-link-navigation-cleanup-20261001

- task_id: x-social-mobile-native-link-navigation-cleanup-20261001
- result: **PASS** (source + tests + native before/after verification; PR open). Model: Sonnet 5.5.
- PR: https://github.com/anohi-memories/kabumori/pull/73 (branch `claude/g3-native-link-cleanup-20261001`)
- commit_hash: 645923ba (rebased on origin/main 0c27998b); push: done, branch pushed to origin.

### Exact broken Link-asChild patterns found (all proven dead/broken on native BEFORE the fix)
1. `Link asChild` + `Card`/`View` direct child: Link only injects its press handler into the direct child; `Card`/`View` do not accept/forward `onPress` -> tap does nothing.
2. `Link asChild` + function-valued `style` on the direct child: radix Slot merges style as `{...slotStyle, ...childStyle}`, a function spreads to `{}` -> styling lost.

### Exact files fixed
- apps/social-mobile/src/app/(tabs)/history.tsx (row -> /posts/[id])
- apps/social-mobile/src/app/(tabs)/schedule.tsx (row -> /posts/[id])
- apps/social-mobile/src/app/(tabs)/settings.tsx (「会話で相談する」 -> /(tabs)/consult)
- apps/social-mobile/src/app/accounts/index.tsx (account row -> /accounts/[id]; 「ログイン方法」 card -> /login-methods keeps styles.card)
All now use a standalone `Pressable` + `router.push` (accessibilityRole="button"), copy/layout unchanged.

### Audit matrix (src/app/** and src/components/**; every Link asChild)
| site | direct child | verdict |
|---|---|---|
| (tabs)/index.tsx x5 (切り替える/予定/履歴/設定/相談) | ActionButton | safe (forwards onPress to Pressable; Home→アカウント verified on native) |
| posts/[id].tsx 再接続 | ActionButton | safe (same class) |
| (tabs)/history.tsx, (tabs)/schedule.tsx | Card | broken -> fixed (dead tap proven native) |
| (tabs)/settings.tsx 会話で相談する | Card | broken -> fixed (dead tap proven native) |
| accounts/index.tsx account row | View | broken -> fixed (dead tap proven native) |
| accounts/index.tsx ログイン方法 | Pressable + function style | broken -> fixed (flat unstyled block proven native) |
| login-methods.tsx, settings.tsx アカウント管理 | (fixed in PR #68) | safe |
False positives: none.

### changed_files
- apps/social-mobile/src/app/(tabs)/history.tsx, (tabs)/schedule.tsx, (tabs)/settings.tsx, accounts/index.tsx
- apps/social-mobile/tests/native-link-button-style.test.mjs

### tests (clean env, no local .env.local)
- `npm test` 113/113, typecheck exit 0, lint exit 0, `git diff --check` clean.
- test file: allowlist for accounts/index.tsx removed; both broken classes detected app-wide (allowlist of press-forwarding components: Pressable/ActionButton/Text/Touchable*); detector self-tests fail on synthetic broken (Card, View, function-style Pressable) and pass on good examples; per-route navigation checks (/login-methods, /accounts/[id], /(tabs)/consult, /posts/[id]); new tests failed (6) against the unfixed code, pass after the fix.
- scope diff check: no x-connect/Auth/DB/RLS/RPC/migrations/Edge/Vault/flag path in the diff; no secret-like string added.

### Native simulator result (G3-owned device, iOS Simulator Release, sample data)
- Own simulator "G3-nav-cleanup" created and used only (another slot's devices were not touched; one stray tap on another booted device's empty home-screen area happened before I pinned the device, no effect).
- BEFORE: 履歴行, 投稿予定行, 会話で相談する, アカウント行 = no response after 8s; ログイン方法 = flat unstyled block.
- AFTER: 履歴行 -> 投稿詳細 (8:20), 投稿予定行 -> 投稿詳細 (11:44), 会話で相談する -> AI相談 tab, アカウント行 -> アカウント詳細 (@kabumori), ログイン方法 card visibly styled and -> ログイン方法 screen. Home ActionButton path also works.
- Local-only harness (sample-data .env.local, temporary auth-gate bypass in _layout.tsx, throwaway bundle id, generated ios/) used and removed; simulator deleted; nothing of it committed; package.json/.gitignore unchanged.

### proof x-connect / Auth / deletion / common-account / backend unchanged
- diff touches only the 4 screens + 1 test; `git diff --name-only` has no match for x-connect, supabase, migrations, env, auth-provider, account-deletion.

### production mutation = 0, real X operations = 0
No deploy, no flag change, no deletion, no provider login/revoke/post; sample-data build had no Supabase config.

### remaining issues
1. `/accounts/[id]` (アカウント詳細) shows no top header/back button. It was unreachable before (dead row); now reachable. Edge-swipe back works. Header config is route cleanup (out of scope) — decide separately.
2. Any future `Link asChild` around a new non-forwarding component is now caught by the test; shared primitives were not changed.
3. Unchanged release gates: common-account deletion semantics, Apple production config, legal URLs/texts, audit retention, main-app account-delete coordination; deletion flag stays OFF.

### safety_checks
- own worktree + own simulator only; explicit-path staging; no secrets/tokens/emails in report; G4/G5/H1 files untouched.

### next_recommendation
- Review/merge PR #73 (UI/navigation only; additional Codex review normally unnecessary per TASK).
- Separate small task: give `/accounts/[id]` a visible header/back button (or confirm it is intended).

---

# Claude Task 3

- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- continues_from: x-social-mobile-e3-delete-revoke-residue-20261001
- purpose: E3で機能動作がPASSしたX自動投稿アプリのアカウント削除について、残っているnative iOS UIブロッカーを解消し、共通アカウント設計に踏み込まずに現行削除UIをリリース可能な見た目・導線まで仕上げる。

## Context

Previous G3 E3 reached Final K3 PASS:
- disposable X authorization revoke succeeded
- social-mobile workspace/membership/social account/X credential/OAuth transient data were removed
- unexpected residue = 0
- protected production posting accounts unchanged
- shared Supabase Auth/login/main-app profile intentionally remained under current `social_only` behavior
- real X posts = 0

Remaining UI findings from the native iOS Release verification:
1. On `login-methods`, the buttons for 「投稿用のX接続を確認する」 and 「アカウントの削除について」 can render as blank/invisible text while their tap area still works.
2. Account deletion is too deep to discover; Settings has no direct account-management/deletion entry.

A separate common-account/auth design effort is now defining the future company-wide account/service-entitlement model. This G3 task MUST NOT preempt or redesign that model.

## Mandatory startup

1. Read `PROJECT_RULES.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, and this TASK.
2. Fresh-check `origin/main`.
3. Use an independent G3 worktree/checkout. Do not use G4/H1/H2 worktrees or simulator processes.
4. Confirm G4 PR #65 owns X account-switch auth-session work and currently touches X-connect/account-selection paths. Do not edit G4-owned files.
5. Confirm H2 PR #66 review and H1 PR #67 review do not overlap the files you intend to change.
6. Preserve all previous G3 E3 reports below; do not rewrite historical results.

## Allowed primary scope

Prefer the smallest set necessary:
- `apps/social-mobile/src/app/login-methods.tsx`
- `apps/social-mobile/src/app/(tabs)/settings.tsx`
- `apps/social-mobile/src/app/account-deletion.tsx` only if needed for UI consistency
- narrowly related social-mobile UI tests
- shared UI component only if the root cause is proven there and the change is demonstrably safe for all consumers

Do NOT edit:
- `apps/social-mobile/src/features/x-connect/**`
- G4-owned account-switch files
- Supabase Auth/provider flows
- account-deletion backend/state machine
- DB/RLS/RPC/migrations
- Vault/token storage
- OAuth ownership
- service-entitlement/common-account design
- production feature flags
- scheduler/posting paths

## Required work

### 1. Root-cause the invisible native buttons

Reproduce or inspect the iOS Release/native rendering path for:
- 「投稿用のX接続を確認する」
- 「アカウントの削除について」

Determine why the text is invisible while the Pressable remains tappable.

Do not merely change color blindly. Confirm whether the problem is caused by:
- `Link asChild` + `Pressable`
- inherited/native text/style behavior
- shared `styles.buttonText`
- Release-only rendering
- another concrete cause

Fix the actual source cause with the narrowest safe change.

### 2. Make account management discoverable from Settings

Add a clear, ordinary Settings entry for account/login management.

Preferred UX:
- a distinct account section/card in Settings
- direct route to `/login-methods`
- wording should make it obvious that login methods, X connection, and account/service deletion live there

If a direct deletion shortcut is clearly safer/usably better, it may be added, but do not bypass the existing preview/re-auth/confirmation deletion screen.

Do not move destructive logic into Settings.

### 3. Preserve deletion truthfulness

Current deletion UI must continue to:
- preview what the server says will be deleted/kept
- require fresh reauthentication
- require the typed confirmation
- report server-confirmed outcome only
- keep the current feature-gate behavior

Do not alter `social_only` / `social_and_login` semantics in this task. Those semantics will be reconsidered by the common-account project.

### 4. Feature flag

Do NOT globally enable `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` in this task.

Goal is source/UI readiness only.

After the common-account design decides the final deletion semantics, activation can be a separate controlled release step.

## Tests / verification

At minimum:
- relevant social-mobile tests
- new/updated UI/static tests proving the two button labels remain visibly rendered in native-compatible composition
- Settings contains a discoverable account-management route
- existing account-deletion preview/reauth/typed-confirmation behavior unchanged
- no G4 X-connect source change
- no Auth/DB/RLS/RPC/Vault/OAuth backend diff
- typecheck
- lint
- `git diff --check`

Native verification:
- use local iOS Simulator / Release-like build where practical
- visually confirm both affected button labels are visible
- confirm both routes are tappable and land on the correct screens
- confirm the Settings account entry is visible without requiring knowledge of hidden navigation
- no EAS build unless truly required; explain if unavoidable

## Production / safety

- source + tests + PR only
- no production deploy
- no feature-flag enable
- no destructive account deletion in this task
- no real X login/revoke/post
- production mutation = 0
- do not remove the retained disposable Auth/profile from the E3 test; that now belongs to the common-account/account-lifecycle decision

## Completion conditions

- invisible button root cause identified
- source fix implemented
- both labels visible in native verification
- Settings account-management entry added and verified
- deletion semantics/backend unchanged
- tests/typecheck/lint/diff checks pass
- commit + push + PR
- production mutation 0
- real X operations 0

## Report

Include:
- task_id
- result
- root cause of invisible buttons
- UX change
- changed_files
- tests
- native/simulator verification
- proof deletion backend/semantics unchanged
- proof no G4 overlap
- commit_hash
- push
- PR
- production mutation
- real X operations
- remaining issues
- safety_checks
- next_recommendation

Then status -> review_required, next_owner -> chatgpt and STOP for K3.

---

## Previous completed G3 history — preserved below

# Claude Task 3

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- continues_from: x-social-mobile-pr63-merge-native-e3-resume-20260930
- purpose: E3の使い捨てユーザー/X接続が正常に成立した状態から、アカウント削除E2Eを最後まで検証する。削除によるX認可失効、Vault/DB/Auth等の残存データ、既存本番アカウントへの非影響を確認する。

## Confirmed starting point

Operator report:
- local iPhone Simulator build is connected to real production data.
- a genuinely disposable X account `@tigers_torataro` is now connected successfully to the disposable social-mobile user.
- protected production posting accounts were not touched.
- account deletion and X authorization revoke have NOT been executed yet.
- a temporary local-only browser-session workaround was used to choose the correct X account; it was not committed.

The previous K3 blocker (wrong X account already connected in production) is therefore resolved.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK, and the previous G3 report history.
2. Use the existing independent G3 worktree/checkout only. Do not use G4's worktree.
3. Fresh-check `origin/main`, but do NOT pull unrelated G4 source changes into the already verified E3 session unless rebuilding becomes unavoidable.
4. Do not make source changes in this task unless a blocking defect is found. This task is operational E2E verification.
5. Confirm the disposable connected X identity is exactly `@tigers_torataro`.
6. Confirm protected production posting accounts remain unchanged and are excluded from every destructive selector.
7. Do not reveal token plaintext, secret values, Vault plaintext, or personal email addresses in logs/report.

## Phase 1 — read-only preflight before deletion

Capture a read-only baseline sufficient to prove isolation:
- disposable Auth/user/profile/workspace/membership state
- disposable social account state and platform identity
- disposable token-reference / Vault-reference existence only (never plaintext)
- OAuth state / pending rows relevant to the disposable flow
- deletion/audit/tombstone baseline if present
- protected production X account state/count/hash or equivalent invariant
- Vault count/identifier hash or equivalent protected-account invariant
- feature flags relevant to deletion remain unchanged; do not globally enable deletion

Confirm again:
- no real X post
- no scheduler/manual publish
- no provider-console mutation
- no protected production account mutation

## MANDATORY STOP — fresh destructive approval

After Phase 1 is complete and BEFORE the first destructive action, STOP and report:

- disposable identity confirmed: `@tigers_torataro`
- read-only baseline captured
- protected production accounts unchanged
- exact first destructive operation: execute the existing account-deletion flow for this disposable social-mobile user
- expected effects: delete the disposable account/workspace data, revoke only this disposable X authorization as designed, remove only this disposable credential material
- feature remains OFF globally

Then request **fresh explicit user approval in the conversation**.

The user's current request to create this TASK is NOT the destructive approval.
Do not reuse any older approval.

## Phase 2 — after fresh approval only: execute deletion

Only after explicit approval:
1. Use the existing app/account-deletion E2E path for the disposable user.
2. If a local-only flag/config is required to expose the deletion path, keep it local/uncommitted and do not globally enable production deletion.
3. Perform the deletion once. Do not retry blindly if the result is ambiguous.
4. Do not manually revoke other X accounts or make provider-console changes.
5. If deletion fails before completion, STOP and preserve evidence; do not run separate cleanup mutations unless explicitly approved.

## Phase 3 — verify X revoke

After successful deletion:
- verify the deletion path attempted/completed revoke for the disposable X authorization according to the existing implementation.
- prefer server-side/audit/result evidence that does not require retaining token plaintext.
- if provider-side confirmation requires an interactive X "Connected apps" check, ask the user to perform only that read/confirmation for `@tigers_torataro`.
- never revoke the app globally and never touch the protected production X accounts.
- do not perform a real X post as a revocation test.
- if automatic revoke is not provable or failed, STOP; do not perform a separate manual revoke without new explicit approval.

## Phase 4 — residue / isolation verification

Read-only verify the disposable user's data is removed or intentionally retained exactly as designed. Check the relevant boundaries:
- Auth user/session
- profile/workspace/membership
- social account
- OAuth transient state
- token-reference/Vault credential
- content/settings/history rows owned only by the disposable workspace, where applicable
- deletion audit/tombstone records that are intentionally retained

Also prove protected production invariants are unchanged:
- existing production X accounts
- their credential references/Vault identifiers
- refresh state
- posting/scheduler state
- feature flags
- no real X post created

Classify every remaining row/value as:
- expected retained audit/tombstone
- unexpected residue
- unrelated protected production data

Do not "clean up" unexpected residue during verification. Report it first.

## Completion / K3

Report:
- task_id
- result
- destructive approval timestamp/message boundary
- deletion result
- X revoke proof/result
- residue matrix
- protected-account invariants before/after
- source changes (expected none)
- local-only temporary config used, if any
- tests/checks
- production mutations performed exactly
- real X posts = 0
- remaining issues
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Previous G3 task closure

Previous task `x-social-mobile-pr63-merge-native-e3-resume-20260930` reached Final K3 BLOCKED only because the first X identity was already connected to a protected production posting account. No destructive action occurred. Its report and Final K3 state remain in Git history / CURRENT_STATE and are not to be re-executed.

## Report — x-social-mobile-e3-delete-revoke-residue-20261001

- task_id: x-social-mobile-e3-delete-revoke-residue-20261001
- result: **PASS** (E3 complete: deletion, X revoke, residue, protected invariants all verified). Two UI findings and one retained-by-design item are listed under remaining issues.
- model: Opus 5.5

### Destructive approval boundary
- Phase 1 (read-only baseline) finished, then STOP. Fresh explicit approval was requested in the conversation with the exact operation, expected effects and "feature stays OFF globally".
- User answered "承認する（自分で削除ボタンを押す）" at 2026-09-30T15:50:00Z (JST 10/1 00:50). No older approval was reused.
- The delete button was pressed once, by the user, in the local Simulator build. Claude pressed no destructive control.

### Deletion result
- App showed「削除しました — このアプリのデータを削除しました。ログイン用アカウントと「かぶモリ」のデータは残っています。」and returned to the login screen with the same notice banner (D2 fix confirmed on native).
- Scope: `social_only` (the disposable login also has a main-app profile), as predicted in Phase 1.
- Audit trail for the subject after the approval boundary (UTC): requested 15:57:07.42 → started 15:57:07.47 → x_revoked 15:57:07.91 → purged 15:57:07.95 → completed_social_only 15:57:08.05. No `failed` / `operator_required` / `blocked` row, no reason code. One attempt, no retry.

### X revoke proof
- Server-side: the flow stops with X_REVOKE_FAILED unless the X revoke endpoint returns success for both the refresh and the access token of exactly this account, and the `x_revoked` checkpoint is only written when the fingerprints of the revoked material match the credential set. The `x_revoked` audit row exists, followed by `purged`.
- Provider-side (user read-only check, logged in as `@tigers_torataro`): the app is no longer listed under X "connected apps". Nothing was pressed there.
- No global app revoke, no provider-console change, no real X post used as a test.

### Residue matrix (disposable subject, before → after)
| boundary | before | after | class |
|---|---|---|---|
| workspace | 1 | 0 | removed |
| membership | 1 | 0 | removed |
| social account (`tigers_torataro`, identity_verified, publish_enabled=false) | 1 | 0 | removed |
| token references in Vault (access + refresh) | 2 | 0 | removed |
| OAuth transient states (5 unconsumed) | 6 | 0 | removed |
| refresh state / scheduled posts / post logs / claims / windows / fingerprints of the workspace | 0 | 0 | none existed |
| deletion tombstone | 0 | 0 | none left (removed at finalize, as designed) |
| deletion audit rows (hashed subject only) | 10 | 15 | expected retained audit |
| Auth user / identity (email) / profile | 1 / 1 / 1 | 1 / 1 / 1 | expected retained (`social_only`: login belongs to the main app) |
| Auth sessions / refresh tokens | 3 / 4 | 3 / 4 | expected retained with the login (device sign-out is local) |
| handle present anywhere else | 0 | 0 | none |

Unexpected residue: **none**.

### Protected-account invariants (before = after, byte-equal hashes)
- protected social accounts: 3, row hash (ids, workspace, platform user, both token references, publish flag, status, updated_at) unchanged
- Vault rows referenced by protected accounts (id + updated_at hash) unchanged; all other Vault ids unchanged; Vault total 22 → 20 (= exactly the two disposable references)
- refresh state count/hash, refresh rollout, non-user workspaces hash, the other pre-existing user workspace: unchanged
- scheduled_posts 408, post_execution_logs 949 (latest timestamp unchanged, before the test), publish_claims 20, posting_windows 19, fingerprints 103: unchanged
- auth users 4, profiles 2: unchanged
- global totals changed only by the disposable rows: user workspaces 2→1, memberships 2→1, social accounts 4→3, OAuth states 28→22

### Other fields
- source changes: none committed. No PR.
- local-only temporary config (uncommitted, not in any product build): `.env.local` (real-data mode + deletion flag), `app.config.js` (throwaway bundle id), generated `ios/`, and a one-line ephemeral auth-session option in the X-connect hook used only to pick the right X account. The hook edit has been reverted in the worktree; the other files stay untracked until K3, then are removed.
- feature flag: the deletion entry is still gated by the client build flag, which is unset in every committed config. Nothing was enabled globally. No secret, Edge function, migration or provider setting was changed.
- tests/checks: operational verification only (read-only SQL before/after diff). No code changed, so no test run.
- production mutations performed exactly: (1) the user's X connect for the disposable account (new social account + 2 Vault references + OAuth states), done before this TASK; (2) one account-deletion call by the user, which revoked that X authorization and removed the rows above and wrote 5 audit rows. Nothing else.
- real X posts = 0. No scheduler/manual publish.

### Remaining issues
1. **Invisible buttons on the Login methods screen (native iOS, Release build).** 「アカウントの削除について」and「投稿用のX接続を確認する」render as blank space; the hidden area is still tappable and navigates. The deletion entry is effectively undiscoverable for a signed-in, onboarded user (the onboarding-gate entry from PR #59 is visible and fine). Release blocker for the deletion feature; needs a source fix + Simulator check. Not fixed here (operational task).
2. **Deletion entry is deep**: Home → アカウントを切り替える → ログイン方法 → bottom card. Not in the 設定 tab, where the user looked first. Consider a direct entry.
3. X auth session reuses the previous X login (already assigned to G4).
4. The disposable login itself remains in production (main-app profile exists → `social_only`). Removing it is a main-app (G1/G2) account-delete or operator action; not done.
5. Unchanged release gates: Apple production config, legal URLs/texts, audit retention policy, main-app account-delete coordination.

### Safety checks
- no token plaintext, Vault plaintext, secret value/id or personal email in logs or this report
- every destructive selector was the caller-bound deletion flow of the disposable user; no first-row fallback, no manual SQL mutation, no cleanup mutation
- protected production posting accounts untouched and proven unchanged
- dedicated G3 worktree only; G4 worktree and X-connect source untouched

### Next recommendation
- Final K3 for E3 = PASS candidate.
- Open a small source task for issue 1 (and decide issue 2) before the deletion flag can be enabled in any product build.
- Decide who removes the leftover disposable login (issue 4).


## Final K3 — E3 deletion/revoke/residue

- verdict: **PASS**
- accepted task: `x-social-mobile-e3-delete-revoke-residue-20261001`
- operational result: the disposable social-mobile service data was deleted once after fresh approval; its X authorization was revoked; no unexpected residue remained.
- accepted scope: `social_only`. The shared Supabase Auth user / login identity / main-app profile were intentionally retained.
- residue: workspace, membership, social account, disposable X credential references/material, and OAuth transient state removed as designed; deletion audit retained as designed.
- protected production posting accounts and their credential references/state remained unchanged.
- real X posts: 0. No scheduler/manual publish. No global deletion flag enable. No source commit or PR from this task.
- source changes: none. Local-only verification edits/config were not product changes; the X-connect temporary hook edit was reverted before report.
- remaining release blocker: native iOS Login methods screen has invisible/tappable-only buttons for the deletion and posting-X navigation. Deletion entry is also too deep. Keep deletion feature globally gated until UI/flow work is addressed.
- retained disposable login/profile is intentional under current `social_only` behavior and now becomes input to the new common-account/service-entitlement design rather than an E3 failure.
- Codex review: **not required for this K3** because no implementation source changed and the purpose of this task was operational E2E of already reviewed boundaries. Re-review at the next source change / production activation gate.
- AI Lab diary: 候補あり — 使い捨てアカウントで「このアプリだけ利用終了」の流れを最後まで試し、他のサービス用ログインを残したままX連携とアプリ専用データだけ消えることを確認した。
- next: common-account design should replace the current proxy-style service-existence decision with an explicit service entitlement. Separately fix the native deletion/navigation button visibility before enabling self-service deletion broadly.


## Report — x-social-mobile-account-deletion-ui-release-finish-20261001

- task_id: x-social-mobile-account-deletion-ui-release-finish-20261001
- result: **PASS** (source + tests + native visual check done; PR open for review). Model: Sonnet 5.5 (recommended Sonnet5（高）, switched by user before start).
- PR: https://github.com/anohi-memories/kabumori/pull/68 (branch `claude/g3-deletion-ui-finish-20261001`, commit `ec292b5`)

### Root cause of the invisible buttons
- `<Link asChild>` renders expo-router's Slot, which uses radix `mergeProps`: `style = { ...slotStyle, ...childStyle }`.
- A `Pressable` whose `style` is a function (`({ pressed }) => [...]`) spreads to `{}` → the button's background, padding and border were dropped; the label (`color: #FFFFFF`) stayed → white text on a near-white screen. The Pressable and its tap area still existed, hence "invisible but tappable".
- Not Release-only and not `styles.buttonText`; it is the Link-asChild + function-style composition. Verified in `node_modules/@radix-ui/react-slot` (mergeProps) and `expo-router/build/ui/Slot.js` (only flattens the Slot's own style).

### UX change
- login-methods: the two buttons are standalone `Pressable` + `router.push('/accounts' | '/account-deletion')`, same style as before (primary / danger).
- Settings: new「アカウント管理」card at the top (above the long content form, visible without scrolling): ログイン方法の確認 / 投稿用のXアカウントの接続 / アカウントの削除 are explained, button「アカウントを管理する」→ `/login-methods`. No destructive logic in Settings.
- Deletion screen, reauth, typed confirmation, server-confirmed outcome, `social_only` / `social_and_login` semantics, feature gate: untouched. `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` not enabled anywhere.

### changed_files
- apps/social-mobile/src/app/login-methods.tsx
- apps/social-mobile/src/app/(tabs)/settings.tsx
- apps/social-mobile/tests/native-link-button-style.test.mjs (new)
- No change to x-connect, accounts/index.tsx, Auth, DB/RLS/RPC/migrations, Vault, OAuth, Edge functions, flags.

### tests / checks (clean env, no local .env.local)
- `npm test` 94/94 pass (5 new), `npm run typecheck` exit 0, `npm run lint` exit 0, `git diff --check` clean.
- New test: AST scan of src/app + src/components for `Link asChild` with a function-valued child style (one known file excepted, listed in the test), detector self-check, both labels live in standalone Pressables that navigate and keep button style, Settings entry opens `/login-methods` and sits above 「コンテンツ設定」.
- Note: with a local `.env.local` present (my earlier real-data E2E file) `auth-release-readiness` "operator script" fails because the script reads it; unrelated to this change, passes without the file.

### Native verification (iOS Simulator, Release build, sample-data mode, no production connection)
- Settings → 「アカウント管理」card + button visible at top without scrolling.
- Tap → ログイン方法 screen. 「投稿用のX接続を確認する」 (blue) and 「アカウントの削除について」 (red) both visibly render with white labels.
- Tap 削除 → アカウントの削除 screen (shows 準備中 because the flag is unset — gate behavior preserved). Tap X-confirm → アカウント screen. Both land correctly.
- Local-only harness used and removed: sample-data `.env.local`, a temporary auth-gate bypass in `_layout.tsx` (reverted, never committed), a throwaway bundle id. After the check: app uninstalled, `ios/`, `app.config.js`, `.env.local` and the env backup deleted. Untracked `supabase/.temp` and `supabase/config.toml` (CLI link files) remain untracked and unstaged.

### Findings (not fixed, out of this TASK's boundary)
1. `src/app/accounts/index.tsx`「ログイン方法」card has the same defect (Link asChild + function style → card styling lost; visible as a flat unstyled block). File is touched by G4 PR #65; fix there or after it merges, then drop it from the test's allowlist.
2. Settings existing「会話で相談する」 card is a dead tap (verified on native): `Link asChild` child is `Card`, which does not accept `onPress`. Needs a separate small fix (Pressable + router.push, or let Card forward touch props). Also applies to other `Link asChild > Card/View` uses (accounts/index.tsx account rows, history/schedule rows) — worth auditing together.
3. The same family of problem can silently return; the new test guards only Link-asChild-with-function-style, not non-forwarding children.

### Production / safety
- production mutation = 0, real X operations = 0, no deploy, no flag change, no destructive deletion, no secrets/tokens/emails in report.
- Disposable E3 login/profile left in production untouched (belongs to the common-account decision).
- G4 files and worktree untouched; own worktree only; explicit-path staging.

### Remaining / next recommendation
- Review and merge PR #68; then decide the fix for findings 1–2 (G4 / a follow-up).
- Release gates unchanged: common-account deletion semantics, Apple production config, legal URLs/texts, audit retention, main-app account-delete coordination; deletion flag stays OFF.


## Final K3 — account deletion UI release finish

- verdict: **PASS**.
- accepted PR #68 exact head: `ec292b50f8d9622a9c35dd1ce62a7d9ec1c1512b`.
- squash merged as `c1f4f42ab78430ee0c214759b4ddac280b7f2265`.
- root cause accepted: `Link asChild` + function-valued Pressable style lost the button container styling, leaving white text on a light background.
- fix accepted: standalone Pressable + router.push for the two affected buttons; Settings now has a visible account-management entry.
- native iOS Simulator Release verification passed for visibility and navigation.
- tests: 94/94, typecheck PASS, lint PASS, diff check PASS.
- no account-deletion backend/state-machine/scope/feature-flag/Auth/DB/RLS/RPC/Vault/OAuth change.
- G4 files untouched; PR #65 remains a separate account-switch workstream.
- production mutation: 0; real X operations: 0.
- extra Codex review: not required because this is a narrow UI/navigation fix with native verification and no security/backend boundary change.
- remaining non-blocking findings: accounts screen has a similar styling issue in a G4-owned file; Settings 「会話で相談する」 and similar Link-asChild non-forwarding children need a separate UI follow-up.
- app binary/TestFlight release was not performed by this task; merge makes the source ready for the next native build.
- G3 closed and reusable only after fresh allocation.


## Final K3 — native Link navigation cleanup

- verdict: **PASS**.
- accepted PR #73 exact head: `645923ba87c8667073061d13a2fc46bbb31ebcbe`.
- squash merged as `a81a60bb731e2c51aa907b4cc08234cb602c4f6a`.
- scope remained UI/navigation-only: history, schedule, Settings, Accounts and the focused navigation regression test.
- native Release-like Simulator verification confirmed all previously dead targets now navigate correctly and the Accounts 「ログイン方法」 card styling is restored.
- audit accepted: all broken `Link asChild > Card/View` and function-style direct-child cases in app/components were fixed; remaining ActionButton cases are safe because they forward onPress to Pressable.
- tests: social-mobile 113/113 PASS; typecheck PASS; lint PASS; git diff --check PASS.
- no x-connect/OAuth/Auth/account-deletion/common-account/DB/RLS/RPC/Edge/Vault/flag/scheduler change.
- production mutation: 0; real X operations: 0; deploy: none.
- extra Codex review: not required because the final delta is narrow UI/navigation-only, shared primitives were not changed, and native before/after verification passed.
- Netlify preview succeeded. Vercel status failure was only the known free-tier build-rate-limit and is not a candidate-quality failure for this native UI PR.
- remaining UI issue: `/accounts/[id]` is now reachable but lacks a visible top header/back button; edge-swipe works. Treat separately as route/navigation polish.
- no TestFlight/App Store/native production build was released by this task.
- G3 closed and reusable after fresh allocation.
