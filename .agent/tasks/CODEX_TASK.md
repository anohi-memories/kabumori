# Codex Task

- task_id: x-multibrand-phase3h-ai-lab-prelive-safeguards-20260913
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
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
