# Codex Task 2

- task_id: social-mobile-app-phase23-dedicated-qa-one-shot-history-learning-20260923
- owner: codex
- slot: codex-2
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: GPT-6 Sol Medium
- purpose: Phase22 C2 PASS後、dedicated QA Auth userと既存の安全なQA X accountだけを対象に、exactly-oneの実history-learning QAを行う。実行直前にユーザーの明示同意を必須とし、1回だけaccess-token RPC/Vault plaintext readとbounded X history fetchを許可する。publish/persona persistenceは引き続き禁止。

## Goal

Phase23では初めてlive pathを1回だけ実証する。

Allowed only after explicit user consent immediately before execution:
- set/enable the history live gate for the QA run
- one dedicated QA authenticated request
- one trusted-account access-token RPC invocation
- one bounded Vault plaintext access through that RPC
- X history fetch bounded by existing limits (max 50 posts / max 2 pages)
- return an unconfirmed persona proposal only

No publishing and no persona persistence.

## Mandatory fresh start

H2開始時:
1. `git fetch origin main`
2. fresh `origin/main`
3. `.agent/ORCHESTRATION.md`
4. `.agent/CURRENT_STATE.md`
5. this TASK
6. `.agent/CODEX_REPORT_2.md`
7. Phase22 production Function/runtime read-back
8. Phase20 RPC production metadata read-back
9. other-slot overlap check

If another slot touches the history-learning Function, live gate/config, access-token RPC, QA account, or related OAuth/Vault resources, STOP.

## Model policy

Use **GPT-6 Sol Medium**.

## Gate A — preflight only, no live read yet

Before requesting consent:
- confirm production Function ACTIVE and source hash/runtime still matches Phase22
- `verify_jwt=true`
- gate currently absent/OFF
- Phase20 RPC still service_role-only, SECURITY DEFINER, fixed search_path
- dedicated QA Auth user still exists and is non-admin
- QA user still owns exactly one intended QA brand/workspace
- exactly one verified X account belongs to that workspace
- QA X account is the previously established dedicated safe test account
- `publish_enabled=false`
- required Vault secret references exist (presence only; do not read values)
- no other production account is selected
- no overlapping task

Do not expose user ids, account ids, secret refs, token values, or PII in report.

## Gate B — explicit user consent immediately before live run

STOP and ask the user for a direct confirmation immediately before enabling/running the live path.

The confirmation request must clearly say that the next action will:
- temporarily enable history-learning live access
- read the QA X access token from Vault through the approved RPC
- call X to read up to 50 of that QA account's past posts (max 2 pages)
- not publish anything
- not save raw posts
- not persist the persona proposal

Do not treat a prior generic "OK", "すすめて", or task-start instruction as this live-read consent unless it was given in direct response to this exact confirmation request.

If explicit consent is not present, do not turn the gate ON and do not call Vault/X.

## Gate C — exactly-one QA live run

After explicit consent only:
1. enable the server-only live gate by the approved production config method
2. confirm gate is ON
3. invoke exactly one authenticated QA history-learning request with `explicit_consent=true`
4. use only the dedicated QA user/session and its owned QA workspace
5. allow exactly one access-token RPC resolution path
6. allow bounded X history fetch max 50 posts / max 2 pages
7. capture only safe result metadata:
   - success/failure
   - analyzed post count
   - bounded persona signals
   - HTTP/status/error code if failed

Never record/log/report:
- access token
- refresh token
- secret ref/id
- raw post bodies
- Authorization bearer
- service-role key

## Gate D — immediate gate OFF

Immediately after the one live run, regardless of success/failure:
- set/remove the live gate so production is OFF again
- read back that gate is absent/OFF

Do not leave live history access enabled.

## Gate E — postflight

Verify:
- exactly one intended live request occurred
- no second retry unless separately approved
- publish/media/repost calls = 0
- persona/settings writes = 0
- raw-history persistence = 0
- OpenAI calls = 0
- OAuth mutation = 0
- unrelated account/Vault rows unchanged
- Function source/version unchanged unless config-only update semantics alter metadata
- live gate OFF at end

If the first QA run fails after Vault/X was reached, do not retry automatically. STOP for C2 with the failure evidence.

## Success criteria

A PASS candidate requires:
- dedicated QA user/account binding verified
- explicit user consent captured immediately before run
- one bounded run succeeds
- token remains server-only
- X history belongs only to the dedicated QA account
- response contains only unconfirmed derived persona signals and count, not raw posts/token
- live gate is OFF again at the end
- publish remains disabled

## Forbidden

- any non-QA account
- any production admin X account
- more than one live run
- automatic retry after a live Vault/X attempt
- publishing/posting/media/repost
- `publish_enabled=true`
- raw post persistence
- persona/settings persistence
- OpenAI call
- OAuth reconnect/change
- token refresh implementation/change
- DB migration/RPC/RLS/ACL mutation
- unrelated Function deploy
- leaving live gate ON

## Completion / C2

When complete or stopped:
- status -> `review_required`
- next_owner -> `chatgpt`
- update `.agent/CODEX_REPORT_2.md`

Report:
1. preflight result
2. confirmation gate status
3. whether live run was executed
4. QA isolation proof without PII
5. exact count of live Function requests
6. access-token RPC invocation count
7. Vault plaintext read count
8. X history call/page count
9. analyzed post count
10. persona proposal remained unconfirmed
11. raw post persistence = 0
12. persona persistence = 0
13. publish/media/post = 0
14. live gate final state = OFF
15. tests/checks
16. remaining risks
17. next recommendation
18. commit/push/fresh origin verification

Then STOP for C2.
