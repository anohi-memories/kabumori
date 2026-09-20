# Codex Task 2

- task_id: social-mobile-app-phase12-general-user-content-profile-and-dry-run-20260920
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Luna
- purpose: Phase 11でgeneral-user X OAuthがproduction実証済みになったため、一般ユーザーbrandをcontent-generation pipelineへ安全に接続する最小基盤を作る。まず `social_mobile_user_v1` code profile、general-user posting defaults、dry-run generation/read pathまで。real X post・publish_enabled=true・自動投稿はまだ行わない。

## Approved basis

Phase 11 Final C2: PASS。

productionで実証済み:
- dedicated non-admin QA Auth user
- dedicated test X account
- real OAuth round-trip成功
- QA X account = identity_verified
- publish_enabled=false
- Vault token refs存在、secret values未露出
- tenant isolation runtime proof PASS
- existing production X accounts/admin OAuth unchanged
- real X post/media upload = 0
- dedicated QA fixtureは当面保持

既知の意図的gap:
- general-user brandの `code_profile_key='social_mobile_user_v1'` はまだregistry未登録
- そのため content-generation/dispatch は fail-closed
- general-user posting_windows / publish enablement は未設計
- revoke/disconnectは未実装

## Model policy

- **Lunaで開始・継続する。**
- Solへ上げるのは、shared generation pipelineの権限境界・multi-tenant isolation・既存brand回帰で具体的な設計矛盾が出た時だけ。
- 単にproduction関連だからという理由でSolへ上げない。

## Goal

Phase 12では「一般ユーザーのbrandが安全にAI生成をdry-runできる」状態まで作る。

このPhaseで目指すもの:
1. `social_mobile_user_v1` code profileをregistryへ追加
2. user-owned brand contextを既存brand pipelineから安全に解決
3. general-user default posting settings / windowsの最小モデルを決める
4. mobileからdry-run生成結果を確認できる候補を作る
5. existing AI Lab / kabumori / mio behaviorを変えない
6. real publishは一切しない

## Mandatory startup

開始前に:
1. `.agent/ORCHESTRATION.md`
2. `.agent/CURRENT_STATE.md`
3. this TASK
4. `.agent/CODEX_REPORT_2.md`
5. other 3 slot TASK
6. fresh `origin/main`
7. inspect:
   - `_shared/brand/brand_profiles.ts`
   - brand context loader
   - existing dry-run Function(s)
   - social-mobile repository/adapters
   - posting_windows schema/RPCs
   - existing general-user QA fixture read-only
8. fresh overlap check with H1/G1/G2

STOP if another slot touches the same shared brand profile files, same posting RPC/table migration, or same dry-run Function.

## Scope A — general-user profile

Add `social_mobile_user_v1` to the shared brand profile registry.

Requirements:
- no hardcoded QA handle/user ID
- generic default profile for any general-user workspace
- profile must not impersonate existing brands
- neutral safe defaults
- no brand-specific secrets
- no automatic X identity assumptions beyond connected account metadata
- unknown/missing user settings remain fail-closed or conservative

Profile should support at minimum:
- display name / brand name fallback
- tone/voice defaults
- language/locale default
- posting objective defaults
- prohibited claims / unsafe generation guardrails
- no auto-post flag embedded in profile

Do not change existing AI Lab/kabumori/mio profile behavior.

## Scope B — user settings contract

Define the minimal per-user/brand content settings needed before generation.

Prefer reusing existing settings tables/RPCs if they are tenant-safe. Add new schema only if existing model cannot represent the needed fields safely.

Minimum candidate:
- preferred tone
- content themes/topics
- posting objective
- posting frequency target
- approval mode preference
- generation timing preference
- optional NG words / notes

Requirements:
- ownership bound to `auth.uid()` / membership
- no client-trusted brand_id for write authorization
- tenant isolation
- defaults exist for first-time QA user
- no direct client write to protected cross-tenant rows unless already-established safe RLS pattern exists

If migration/RPC candidate is needed:
- source only before C2
- disposable proof required
- no production apply

## Scope C — posting defaults / windows

Design the minimum general-user posting schedule model.

Target default:
- user can have safe initial posting windows/settings
- preserve project concept:
  - default next-day AI planning
  - default auto-post may exist as product preference, but **Phase 12 must not enable live publishing**
  - optional approval mode supported
  - generation window previous-day 09:00–24:00, default around 17:00 candidate
- limits/entitlements remain separate from profile

Prefer:
- reuse `posting_windows` if tenant-safe and semantically compatible
- otherwise propose additive tenant-safe table/RPC candidate

No Cron or production scheduler changes in this Phase.

## Scope D — dry-run generation path

Implement a safe dry-run for the dedicated QA fixture and generic general-user path.

Requirements:
- signed-in user can invoke dry-run only for owned workspace
- resolve `social_mobile_user_v1`
- use current brand context / AI generation stack where safe
- no scheduled_posts write unless explicitly required for a local/disposable candidate
- no X API call
- no Vault token read required for generation
- no publish attempt
- result clearly marked preview/dry-run
- generation must not silently fall back to another brand/profile

If an existing `brand-post-dry-run` can be safely extended, preserve existing admin/general boundaries and do not regress current brands. If trust boundary differs materially, prefer a separate narrowly-scoped Function.

## Scope E — mobile candidate

Add the minimum social-mobile UX needed to exercise the dry-run:

- from Home or Accounts/Settings, user can trigger or view one preview generation
- clear states:
  - not configured
  - generating
  - preview ready
  - generation error
- no "投稿する" action yet
- no publish toggle that can set live state
- preview must show which connected X account/workspace it belongs to
- no token/secret display

Keep UX minimal; Phase 12 is foundation, not final polish.

## Scope F — dedicated QA proof

Use the retained Phase 11 QA fixture only for read-only/runtime proof where safe.

Allowed before C2:
- real signed-in read/dry-run generation if it creates no live scheduled/published content
- read-only tenant checks
- local/disposable DB candidate proof
- mocked AI if paid/live model use is unnecessary

Do not make a real X post.
Do not flip `publish_enabled`.
Do not mutate existing production brands.

If real AI generation would incur paid usage, prefer mock/local proof first. Any production AI call must be explicitly documented and bounded; if avoidable, do not make it.

## Tests

At minimum:
- profile registry regression
- general-user profile resolution
- existing AI Lab/kabumori/mio profile regression
- tenant ownership tests
- settings defaults tests
- dry-run auth/ownership tests
- no cross-tenant access
- no X publish path
- social-mobile typecheck
- lint
- relevant Deno tests
- Expo export/route resolution if UI changed
- `git diff --check`
- secret/static scan

## Production boundary

Before C2:
- no production migration apply
- no production Edge Function deploy
- no Cron/scheduler change
- no `publish_enabled=true`
- no real X post/media upload
- no existing production account mutation
- no Vault rotate/delete
- no app-wide data-source switch
- no billing/Push changes
- no cleanup of QA fixture
- no blind `db push` / migration-history repair

Read-only production checks and one bounded no-publish dry-run are allowed only if the path is proven not to publish/write protected production content.

## Completion / C2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- update `.agent/CODEX_REPORT_2.md` with:
  1. exact architecture chosen
  2. files/commits
  3. profile registry change
  4. settings/posting-window contract
  5. dry-run path
  6. mobile UX
  7. tenant/security proof
  8. tests
  9. production mutation = 0
  10. exact next production rollout recommendation
- fresh-check `origin/main` before push
- STOP for C2
