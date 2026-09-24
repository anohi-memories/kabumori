# Codex Task

- task_id: kabumori-important-news-caller-auth-merge-only-20260924
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: critical
- recommended_model: Luna
- purpose: PR #12 caller-auth source candidateのmerge-only作業はC1 PASSで完了。本番caller-auth rolloutは別承認待ち。

## C1 final decision

**PASS**

Verified:
- PR #12 merged normally.
- reviewed head: `9dffce9620b8a04706cad314a1e558ea141cb105`
- merge commit/resulting main: `844c77d6911380822c091b9b646df911810808a4`
- all 7 approved implementation files read back identical to the reviewed candidate.
- caller-auth migration remains unapplied in production.
- Vault caller secret remains absent.
- `important-news-monitor` remains ACTIVE v64, `verify_jwt=false`, prior runtime bundle unchanged.
- four production Cron jobs and shadow job retained schedule/active/command fingerprints; no auth-header patch applied yet.
- PR #11 remains stale draft/unmerged.
- production mutation by merge-only task = 0.

## Pending separate production approval

A future production rollout must be explicitly authorized and coordinated in this order:
1. create the same high-entropy caller secret in Function secrets and Supabase Vault without exposing the value;
2. read-only verify secret metadata/presence;
3. apply only `20260923110440_important_news_monitor_caller_auth.sql`;
4. verify exactly four Cron commands gain the Vault-backed auth header while schedules/bodies/URLs remain unchanged;
5. deploy only `important-news-monitor` with `verify_jwt=false`;
6. observe natural scheduled executions and confirm unauthorized requests fail closed;
7. do not change auto-publish/news logic/X/Push/Cron cadence.

No further H1 work is authorized until that production rollout receives explicit approval.
