# Claude Task 3

- task_id: x-social-mobile-pr63-merge-native-e3-resume-20260930
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- accepted_pr: PR #63
- accepted_head: 5f2eae26bb1ee60c2bd7c7885c06816e86e8d852
- purpose: C1 PASSを受けてPR #63を安全にmergeし、ネイティブ版でE3（X接続済み使い捨てユーザー）のStage 2 E2Eを再開する。

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest H1 report.
2. Use independent G3 worktree/checkout.
3. Fresh fetch origin/main and PR #63.
4. Confirm exact head remains `5f2eae26bb1ee60c2bd7c7885c06816e86e8d852`, mergeable, with no newer unreviewed commit.
5. Confirm G4 x-test-post rollout does not overlap PR #63 source paths.
6. If head/source scope changed, STOP.

## Phase A — merge PR #63

If exact head remains unchanged:
- merge PR #63 using normal repository merge method
- record merge SHA
- fresh-read main and confirm accepted source is present
- no unrelated PR merge

## Phase B — native E3 preparation

Prepare a local/native iOS development or simulator build from fresh main with:
- bundle-safe static public env values
- explicit `EXPO_PUBLIC_DATA_SOURCE=supabase`
- existing public Supabase URL/key only
- no service_role/secret in client
- temporary/local bundle identifier only if required; do not commit it
- no production source/config mutation

Verify before any destructive action:
- native app is using real Supabase data, not mock
- onboarding/X-connect entry is reachable
- only the approved disposable social-mobile identity/X account is used
- existing real users/accounts/workspaces are excluded
- Apple remains excluded

The user performs credentials, X login/consent and other interactive provider steps.

## Phase C — E3 connection checks

Using the disposable X account only:
- complete X connection if supported by the local native build
- read-only verify the expected disposable social account/workspace/token-reference state
- do not reveal tokens or Vault plaintext
- do not post to X

## Mandatory STOP gate before deletion/revoke

Before the first action that can:
- delete the disposable social-mobile account
- revoke the disposable X authorization/token
- mutate Vault credentials as part of deletion

**STOP and obtain fresh explicit user approval in the conversation.**

Prior approval is not sufficient for this resumed destructive step.

## Production restrictions

Before that fresh approval:
- no account deletion
- no X revoke
- no Vault mutation
- no real X post
- no provider-console changes
- no feature activation

## Completion / K3

If blocked before the approval gate, report the blocker.
If ready for destructive E3, report:
- merge SHA
- native real-data proof
- disposable-only X connection proof
- exact next destructive operation requiring approval
- unrelated-data invariant snapshot
- feature remains OFF
Then status -> review_required, next_owner -> chatgpt, STOP for K3.
