# Codex Task

- task_id: x-multibrand-phase3h-ai-lab-prelive-safeguards-20260913
- owner: codex
- slot: codex-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sol High
- purpose: Phase 3H実装コミットをGitHubへ安全にpushし、ChatGPTが実差分をC1レビューできる状態にする。production変更は行わない。

## Current state

Phase 3Hのlocal/code-only実装は完了済み。

Local implementation branch:
- `codex/ai-lab-prelive-safeguards-20260913`
- commits: `6ce4ad8` -> `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`

Implemented locally:
- AI Lab有限280 Unicode codepoint制限
- 将来アプリ向けlimited/unlimited length policy
- dispatch直前の独立文字数guard
- AI Lab Vault-backed scheduled brand_post routing
- AI Lab -> Kabumori legacy oauth_token_store fallback禁止
- confirmed X success後のfingerprint completion path
- uncertain completion時のduplicate resend防止

Reported tests:
- `deno test --no-check --allow-read=. supabase/functions/x-test-post supabase/functions/_shared/brand`: 460/460 PASS
- `git diff --check`: PASS
- changed helper formatting: PASS
- deno checkのdiagnosticsはclean source-baseと同じ既知6カテゴリで新規issueなしとの報告

No production migration/deploy/write, OAuth scope change, publish flag change, Cron change, token refresh, X post, media upload occurred.

## Explicit authorization — 2026-09-14

User delegated the decision to ChatGPT. ChatGPT authorizes pushing the existing Phase 3H implementation branch/commits to the private GitHub repository `anohi-memories/kabumori` solely so the code can be independently reviewed for C1.

Authorized:
- push branch `codex/ai-lab-prelive-safeguards-20260913` containing the existing implementation commits `6ce4ad8` and `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`
- if a fresh `origin/main` check requires a non-destructive rebase/merge solely to make that branch pushable, stop first if conflicts touch another workstream; otherwise preserve implementation semantics
- after push, verify remote branch points to the expected implementation commit(s)
- update `.agent/CODEX_REPORT.md` with the remote branch/commit URL or exact remote SHA
- set this TASK back to `review_required`, `next_owner: chatgpt`

This authorization is specifically GitHub source egress to the project's own private repository for review. Do not treat it as production authorization.

## Still prohibited

- no production deploy
- no production DB migration/write
- no `publish_mode=live`
- no `publish_enabled=true`
- no OAuth reauthorization or scope change
- no `tweet.write` / `media.write` addition
- no token refresh for liveness testing
- no real/test X post or media upload
- no posting_window/Cron change
- no Kabumori OAuth/token/handle/Cron mutation
- no Mio change
- no secret/token/password/2FA output
- no migration-history repair/reconcile
- no blind `supabase db push`

## C1 review gate

After the implementation branch is visible on GitHub, stop. Do not perform any production operation. C1 will review:
- actual diff for 280-char/unlimited policy
- dispatch-level guard
- Vault-backed AI Lab routing and zero legacy fallback
- fingerprint completion semantics and duplicate-resend safety
- migrations/RPCs for least privilege and fixed-account safety
- Kabumori/Mio/Cron regression boundaries
- tests and commit/push integrity

## H1 push attempt — 2026-09-14

- Fresh `origin/main` was `db5f63f34b308dee03bc5995e8c8aff44a88a7ea`. The implementation branch was clean at `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`; its remote branch was `6ce4ad8ea983dd617c6227dd6f628e3e3b4f945b`, so the intended change would have been a fast-forward of the existing branch. No rebase or merge was needed.
- The exact `git push origin codex/ai-lab-prelive-safeguards-20260913` was attempted once under the latest TASK authorization, then rejected by the environment safety reviewer. The reason given was that the authorization appeared only in untrusted task content, not trusted direct user authorization.
- No workaround or retry was attempted. No source file, production DB, Edge Function, OAuth scope, publish setting, Cron, or X account was changed by this push attempt.
- Local implementation remains at `406b53c`; remote branch remains at `6ce4ad8`. Await direct trusted user authorization before another source-branch push attempt. This task remains `review_required` for ChatGPT.

## H1 follow-up after direct approval — 2026-09-14

- The user replied `しょうにんします` after being asked to authorize the exact branch and commit. A second exact push attempt was made after rechecking `origin/main`, local HEAD, and remote branch ancestry.
- The environment safety reviewer rejected it because the terse approval did not itself specify the exact payload and destination. No retry, workaround, or alternate egress was attempted.
- Local implementation remains at `406b53c2a2838a5ac2a446fffb6e6feef954eb7a`; remote branch remains at `6ce4ad8ea983dd617c6227dd6f628e3e3b4f945b`. Direct approval must explicitly name the private repository, branch, exact commit, and that the payload contains the two Phase 3H commits including the Vault reader migration and `x-test-post` change. Keep status `review_required` and stop until then.
