# Operator checklist — common account disposable Supabase proof (TEMPLATE; Phase 3c)

Copy this outside the repository for a run and fill it in there. Never write a credential, token, password,
e-mail address or real user id into it. Runbook: `docs/common-account/phase3c-disposable-supabase-proof-runbook.md`.
Status of this template: **not used — no run has been approved or executed.**

## A. Before anything touches a project

- [ ] Written user approval for **this** disposable project. Reference (message/TASK commit, no secrets): `________`
- [ ] The project was created new for this proof. Fake data only: no production data, clone, import or copy.
- [ ] The ref is **not** the Kabumori/POSTONA project (`wsmznyzcvmuitkglfeuj`) and is **not** in the used-project ledger.
- [ ] The project marker is written **outside** the repository (absolute path `________`). Its fields:
  - `environment: disposable`, `contains_production_data: false`, `production_clone: false`;
  - name `kabumori-disposable-proof-…`;
  - this task id;
  - a future `expires_at`.
- [ ] Run id `p3c-run-YYYYMMDD-NN`: `________`. The run request is written outside the repository.
- [ ] Typed confirmation entered exactly, and per-scenario `DESTROY-<E#>-<ref>-<run_id>` consents for each destructive scenario.
- [ ] Extra approvals, where requested:
  - E7 `project_auth_config_change` `________`;
  - E11 user `________` **and** independent security review `________`.
- [ ] `deno run --no-config --allow-read …/cli.ts validate --request <abs> --ledger <abs>` printed `REQUEST_VALID_DRY_RUN_ONLY`. Output saved (redacted) as evidence item 0.
  - This is only dry-run eligibility over self-declared inputs (`SELF_DECLARED_INPUTS_NOT_VERIFIED`). It is not a check of the project, the reviewer or the fake users. Those are the witness checks below.
- [ ] No `supabase link` / `db push` / `migration up` / `functions deploy` / `secrets`, and no Supabase MCP connection, in this run.
- [ ] Credentials are held in the password manager or typed at prompts. None in files, shell history or evidence.
- [ ] Clock skew bound measured (3 round trips): `____ ms`.
- [ ] Start fingerprint (read-only) sha256: `________`.

## A2. Manual witness checks (Phase 3e, R4 — human observations at the window, per run; never copied from the request)

Each record: observer, second observer where marked, method, time (JST), MATCH / MISMATCH / UNREADABLE and a redacted evidence file. A MISMATCH or UNREADABLE stops the step.

| Check | Before | Method | Two-person | Observer / 2nd | Time (JST) | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1 new disposable project (created after approval, empty except fakes, name = marker) | every destructive step | dashboard | yes | | | | |
| W2 not `stock-x-autopost`, not `anohi-memories`, not `common-account-gateb-20261005` (compared on screen; only a salted hash prefix recorded) | every destructive step | dashboard | yes | | | | |
| W3 the client is connected to the W1 project only (host ref = W1; fake fixture marker row readable only there) | first write of the run | SQL read-back / dashboard | no | | | | |
| W4 every touched user is in this run's allowlist (created after run start, fake domain, hashed id) | every destructive step | SQL read-back | no | | | | |
| W5 E11 DELETE target: count = 1, id-only predicate, row_count = 1, else rollback | each E11 DELETE | SQL read-back | no | | | | |
| W6 the user approval and the independent review exist and name this run, scenario and runbook head | E11 | document review | yes | | | | |
| W7 E1, E8, E9, E10 and E12 PASS evidence reviewed | E11 | document review | no | | | | |

- [ ] E11 only: Admin control cohort and SQL test cohort created under one schema / config fingerprint. Non-zero denominators captured with `target_readback.sql` **before** any delete. Matrix rows A–E filled from read-backs, never inferred.
- [ ] A lost COMMIT answer was resolved by read-back only — no second DELETE.

## B. Per experiment (repeat)

| Exp | Consent ok | Started (UTC / JST) | Correlation ids | Outcome (PASS/FAIL/UNKNOWN/NOT_RUN) | Evidence file(s) (redacted) | Fingerprint after |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | n/a (observation) | | | | | |
| E2 | | | | | | |
| E3 | | | | | | |
| E4 | | | | finding LINKED/REFUSED: ___ | | |
| E5 | | | | | | |
| E6 | | | | | | |
| E7 | + config approval | | | | | |
| E8 | | | | | | |
| E9 | | | | | | |
| E10 | | | | | | |
| E11 | + user + security review | | | | | |
| E12 | | | | | | |

- [ ] Every file passed through `redact(text, run_id, [ref])` **before** it was written.
- [ ] A step whose evidence is incomplete is recorded UNKNOWN. It is never re-labelled PASS.

## C. After the run

- [ ] `verdict()` output saved. A candidate is at best `EVIDENCE_COMPLETE_PENDING_INDEPENDENT_REVIEW`. **No gate opened.**
- [ ] Fake users, buckets and test hook removed. The user is asked to delete the disposable project.
- [ ] The ref is added to the used-project ledger.
- [ ] Redacted evidence kept outside the repository. A summary goes into the next TASK Report; local evidence is deleted within 14 days of the review.
