# Claude Task 4

- task_id: x-admin-phase2-vercel-gate-merge-and-postmerge-qa-20260924
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet 5
- purpose: G2/K2で実装・freshen・全検証PASS済みのPR #15について、Vercel rate limit解除後のcheck確認、必要最小限の再freshen、PR merge、post-merge read-back、本番Admin QAまでを完了する。新機能実装はしない。

## Carry-forward from K2

Completed and accepted:
- reviewed Phase2 patch semantics unchanged
- freshened branch/head verified against reviewed candidate
- apps/admin/** only, 18 reviewed files
- node tests 31/31 PASS
- npx tsc --noEmit PASS
- npm run lint PASS
- npm run build PASS
- git diff --check PASS
- secret scan clean
- production mutation 0

Current PR state from prior report:
- PR #15 OPEN
- last known head: `b04442561d9e9c6d01b4a9fcf640c2cf731cd923`
- merge blocked only because Vercel reported `Deployment rate limited — retry in 24 hours`
- prior retry preserved apps/admin semantics; no source behavior change
- no merge has occurred yet

## Mandatory startup

1. fresh fetch origin/main
2. read ORCHESTRATION / CURRENT_STATE / this TASK / prior G2 Report
3. inspect G1/G2/G3/H1/H2 for scope overlap
4. inspect PR #15 current head/checks/status
5. compare PR head against fresh main
6. if main changed only outside apps/admin/**, freshen only as needed
7. if main contains overlapping apps/admin/** changes, STOP and report exact files

## Scope A — Vercel gate

- Check current PR #15 Vercel status.
- Do not repeatedly force empty retriggers if the provider is still rate-limited.
- If Vercel check is still rate-limited, STOP and report unchanged blocker.
- If Vercel check passes, continue.
- Do not bypass/ignore a failed Vercel check.

## Scope B — freshen safety

If PR #15 is behind:
- rebase/freshen onto fresh main only when there is no semantic apps/admin overlap
- verify patch equivalence to the K2-approved Phase2 candidate
- rerun required verification after any freshen

Required verification before merge:
- node tests 31/31 or higher only for unrelated added tests
- npx tsc --noEmit PASS
- npm run lint PASS
- npm run build PASS using public Supabase env only
- git diff --check PASS
- secret scan clean
- selected-brand authority unchanged
- all operational queries remain explicitly brand-scoped
- Important News remains Kabumori-only
- system-toggle remains Kabumori-only
- posting_windows update remains Kabumori brand-filtered

## Scope C — merge

Merge PR #15 only if:
- Vercel check PASS
- fresh compare PASS
- no semantic drift from reviewed Phase2 candidate
- exact head is pinned/verified immediately before merge

Use the normal reviewed PR merge path.
Do not bypass checks.

Note: merge is expected to trigger the existing Vercel Production auto-deploy for admin. This continuation is specifically authorized to finish the previously approved merge path once the Vercel gate passes; do not make any unrelated Vercel configuration change.

## Scope D — post-merge read-back

After merge:
- fresh-read origin/main
- confirm PR #15 is merged/closed
- record merge SHA
- verify the reviewed 18 apps/admin files are present
- confirm no unrelated apps/admin files changed
- confirm no DB/RPC/policy/Edge/Cron/OAuth/Vault/token settings changed

## Scope E — production Admin QA

Read-only/normal UI QA only:
- switch Kabumori / AI Lab brand selector
- verify data does not mix across brands
- verify tampered/unknown/unauthorized selector fails closed or safe-fallbacks as designed
- verify AI Lab does not show Kabumori-only system toggle
- verify Important News remains Kabumori-only
- do not mutate operational content/settings beyond ordinary selector navigation

If QA requires a production mutation beyond the already-approved merge-triggered deploy, STOP.

## Forbidden

- new Phase2 feature work
- selector semantics changes
- ADMIN_BRANDS changes
- DB migration/RPC/view/policy
- Netlify deploy/site creation
- manual Vercel configuration mutation
- x-test-post/**
- queue/idempotency work
- Cron/OAuth/Vault/token changes
- consumer mobile changes
- Important News backend changes
- cross-brand aggregate dashboard

## Completion / K4

When complete:
- status -> review_required
- next_owner -> chatgpt
- append Report with:
  - fresh main SHA
  - PR #15 final head/check status
  - any freshen details
  - tests/build counts
  - merge result + merge SHA
  - post-merge read-back
  - production Admin QA results
  - production mutation details
  - remaining risks
  - next recommendation
- STOP for K4.
