# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-rollout-stage1-20260929
- owner: claude
- slot: claude-3
- status: ready
- next_owner: claude
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: accepted account-deletion sourceをproductionへStage 1反映する。**migrationの単一ファイル適用・read-back・Edge Function deploy・source identity確認・非破壊smokeまで**。実ユーザー削除、実X/Apple revoke、アプリ機能有効化はまだ行わない。

## Accepted basis

- PR #52 accepted head: `4bc819555c07c8792f5b78ea29aa6b9a35694042`
- squash merge: `136dcd2b35b161ccc4769da15b05e796f095e881`
- final H2 source verdict: PASS
- production preflight result: `READY_FOR_ROLLOUT_WITH_OPERATOR_GATES`
- runbook: `apps/social-mobile/docs/account-deletion-rollout-runbook.md`
- migration:
  `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`
- expected sha256:
  `7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657`

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 preflight Report
   - latest H2 PASS report
   - rollout runbook
2. Fresh independent G3 worktree from latest `origin/main`.
3. Read current Supabase skill/changelog/docs.
4. Confirm no G4/H-slot overlap on same migration/Edge/Auth boundary.
5. Recompute migration SHA and require exact match.
6. Re-run all sanitized pre-apply read-only checks from runbook.
7. If any STOP condition fires, **do not apply**.

## Stage 1A — production migration apply

Apply only the exact accepted migration file.

Rules:
- single-file only
- atomic transaction
- lock timeout + statement timeout
- **never `db push`**
- never migration repair
- no unrelated migration
- no manual SQL edits during apply

Immediately after apply run the full read-back checks from the runbook.

Required PASS:
- expected function inventory/body identity
- owners as expected
- safe search_path
- anon/authenticated EXECUTE denied
- service-role execute surface only where intended
- state/audit table protections correct
- all expected guard triggers present/enabled
- no unexpected trigger/FK/object collision
- isolation assumptions unchanged

If read-back differs:
- STOP
- do not deploy Edge
- use only the documented rollback/recovery plan when safe
- do not improvise destructive cleanup.

## Stage 1B — Edge Function deploy

Only after Stage 1A PASS.

Deploy:
`social-mobile-account-delete`

Requirements:
- JWT verification remains enabled
- no secret values printed/logged
- required configuration names checked, values not exposed
- do not add missing Apple production configuration in this task
- Apple path remains fail-closed if not configured

After deploy:
- confirm deployed source corresponds to accepted main source
- perform safe source/byte identity comparison where supported
- verify function status/metadata
- verify CORS/OPTIONS and unauthorized/invalid-request behavior only
- smoke checks must be non-destructive.

## Allowed smoke checks

Allowed:
- OPTIONS/CORS
- missing/invalid Authorization => safe reject
- malformed/non-destructive request => safe reject
- feature remains disabled in app

Forbidden:
- valid disposable-user deletion
- auth user deletion
- Vault mutation
- X revoke
- Apple revoke
- X post
- enabling `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED`

Real E2E belongs to Stage 2.

## Safety constraints

- Do not expose secrets/tokens/passwords/Authorization headers.
- Do not change provider consoles.
- Do not change X/Apple credentials.
- Do not modify Kabumori main-app account-delete in this room/task.
- Do not touch unrelated migrations/functions.
- Do not broaden to posting backend.
- Protect other slots/worktrees.

## Completion / K3

Report:
- result: PASS / STOP / ROLLED_BACK
- fresh main commit
- pre-apply recheck result
- exact migration SHA
- apply status
- production read-back result
- rollback performed? yes/no
- Edge deploy status/version/identity confirmation
- non-destructive smoke results
- production mutations actually performed
- explicit confirmation that no real user deletion / X or Apple revoke / feature activation occurred
- remaining Stage 2 E2E/operator/legal gates
- safety_checks
- next_recommendation

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

Because this is a production DB/Auth/Vault/Edge boundary, after K3 PASS ChatGPT should route one focused H2 production-verification review before Stage 2 activation.

推薦モデル：**Opus5.5（高）**
