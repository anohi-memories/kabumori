# important-news-monitor caller-auth rollout (candidate)

This is an operator runbook for a source candidate only. It does not authorize a production migration, secret write, Function configuration change, or deployment.

## Contract

- The four existing production jobs send a dedicated `x-important-news-cron-secret` header.
- The secret is one random 32-byte value encoded as unpadded base64url (43 characters).
- The Function reads the same value from `IMPORTANT_NEWS_CRON_SECRET` and rejects missing, malformed, or incorrect credentials before reading the request body, loading the service-role key, or dispatching any mode.
- The Cron command reads the header value at run time from the Vault entry `important_news_monitor_cron_secret`. The migration stores only the Vault lookup expression, never the secret value.
- Keep the existing platform `verify_jwt=false` setting for this Function: pg_net sends the dedicated header rather than a user JWT. The handler remains responsible for authentication.
- `important-news-shadow` is outside this four-job change.

## Required setup after separate production approval

1. Generate one high-entropy 32-byte secret in an approved password manager/secret generator. Do not place the value in source control, a migration, SQL text, a ticket, an application log, or a report.
2. In Supabase's Function secrets UI, set `IMPORTANT_NEWS_CRON_SECRET` to that value.
3. In Supabase Vault, create/update the secret named `important_news_monitor_cron_secret` with the identical value. Use the Vault UI so the value is not embedded in a SQL statement or migration history.
4. Read-only verify that the Vault entry exists and has the expected format without selecting or displaying its value. Confirm the Function secret is configured in Dashboard without copying the value into any report.
5. Only after a separate production change approval, apply this exact migration. It preflights all four expected job names and the Vault value, then calls `cron.alter_job` with only each existing command. If a job is missing, already patched, or has a different header syntax, it raises and makes no partial transaction change.
6. After a separate deployment approval, deploy only `important-news-monitor` with `verify_jwt=false`. No manual invocation is part of this candidate.

## Preservation and rollback notes

The migration edits only the JSONB headers expression inside each of the four existing command strings. It does not pass a schedule, body, URL, active state, or other job field to `cron.alter_job`. Thus the configured Cron frequency, request payloads, fetch cutoff/settings predicates, `auto_publish` gate, and news/publish logic remain unchanged. The job's command is transactionally altered; do not apply this migration if current job source no longer matches the inspected four-job shape.

If auth fails after a separately approved rollout, stop production mutation and inspect status codes and configuration metadata only; never print the secret. Secret rotation must be coordinated across the Function secret and Vault-backed Cron header under a separately approved plan, since a mismatch intentionally fails closed.
