## H2 — PR #101 F1–F3 final exact-head rereview — 2026-10-07 JST

- task_id: kabumori-pr101-f1-f3-final-rereview-20261007
- verdict / result: **CHANGES REQUIRED**. F1 is closed. The original F2/F3 reproduction inputs are also closed, but independent probes within the explicitly requested F2/F3 scope reveal remaining credential leaks and untruthful truncation metadata. Existing supplied regressions all pass; that is not sufficient for PASS.
- status: review_required
- next_owner: chatgpt
- exact_reviewed_head: `fddd274863b08aefed60795d678a298a1160d599` (PR #101 OPEN/unmerged, head unchanged on final fetch/read-back).
- previous_reviewed_head: `2469e8a8be0125805551ba3e353c4ef6058b0150`.
- clean_base: `/Users/yuya/Developer/kabumori-fresh`; initial fresh origin/main `43065127b92dc1c8b31dd39e9ad8f9be32ac1df5`; final pre-report main `4e8e8c5cdd16af7f29418274fe7d0d2784002419`.
- isolated review checkout: `/private/tmp/h2-pr101-final-20261007.1Cptfa/review`, detached exact PR head, clean before/after. No old/shared worktree reused.
- review scope: ONLY original F1/F2/F3 corrective changes and the requested bounded regression. No new implementation, product/design reopening, model migration, merge, or production access.

### F1 — CLOSED / PASS: effective ACL, owner and inheritance

Reviewed the migration DO-block itself, not merely its tests. It rejects app-role ownership, membership (including SET ROLE/MEMBER paths) in the owner or a superuser, unexpected direct table/helper ACLs, grant options, unexpected effective table/column privileges, and helper EXECUTE. Exceptions occur inside the same BEGIN/COMMIT transaction; it does not repair global defaults/memberships.

Independent execution on a NEW H2-only disposable PostgreSQL 17.11 cluster (private Unix socket, no TCP listener, no Supabase connection):

- Candidate's full PG runner: clean path PASS; Supabase-like default table/function grants PASS; **13/13 adverse cases refused atomically**. Includes all four original reproductions, anon/service owner membership, service superuser, inherited superuser, pg_read_all_data/pg_write_all_data, grant-option widening, inherited unknown reader.
- Additional independent harness: **7/7 PASS**: unknown default table SELECT (BYPASSRLS reader), unknown default helper EXECUTE, inherited service TRIGGER, authenticated owner membership, owner membership with INHERIT FALSE, two-hop anon owner membership, two-hop authenticated pg_read_all_data.
- Each independently adverse case: no partial trace class/helper/trigger; full pg_default_acl / pg_auth_members / pg_roles snapshots hashed equal before/after. No unrelated role/default/membership repair.
- Clean behavior includes service SELECT+INSERT only, app roles denied, forbidden mutation/TRIGGER unavailable, append-only triggers active, original generation/attempt evidence retained. This is fixture evidence, NOT a claim about production's privilege graph; production preflight remains separate.
- Scratch databases and fixture roles removed; read-back only `postgres`, extra owner memberships=0; this H2-only cluster stopped. No other server stopped.

### F2 — NOT CLOSED / P1: recognizable credential residue still reaches insert

Location: `supabase/functions/market-report-analysis/debug_trace.ts:50` (QUOTED_KV), `:61-62` (standalone auth token lookahead), `:85-87` and `persistTraces` (backstop uses the same redaction detector).

Original F2 inputs now pass: quoted JSON password, opaque access_token JSON in free text, lowercase `authorization: basic ...`, unlabelled PEM, and first-redacted/later-live assignment. Ordinary Japanese/financial control is preserved. Supplied adversarial suite passes.

Remaining independent reproductions, using synthetic credentials ONLY:

1. `basic dXNlcjpwYXNz` is valid unpadded Base64 for a synthetic `user:pass` credential. All characters happen to be letters. The lookahead requires a digit / `+` / `/` / `=`, so case-insensitive Basic still goes undetected when there is no `Authorization:` prefix. Both normal traceRows->persistTraces and a forged row reach insert (callback=1); forged-row requirement is callback=0. This is a credential, not the ordinary-text control `basic income`.
2. A free-text JSON string created with `JSON.stringify({password: 'syntheticPrefix123"syntheticTail999'})` is only redacted up to the first escape backslash. The same occurs for an escaped literal backslash and escaped newline inside the password. The tail `syntheticTail999` remains in candidate and local issue text and reaches insert. The backstop sees the already-redacted first portion and does not detect the remaining value suffix. Forged *raw* quoted rows are dropped, but the actual normal redaction->writer path persists the partial credential; testing only forged rows misses this.

Minimal correction recommendation (NOT implemented by H2): consume a complete escaped quoted value, or safely drop that diagnostic row if it cannot be redacted unambiguously; recognize valid Basic credentials even when encoded using letters only, while preserving normal prose. Extend writer-level tests through the actual traceRows->persistTraces path, checking that the entire synthetic value/tail disappears or callback is zero. Keep full nonsecret output; no extra model call or retry.

### F3 — originals CLOSED, metadata NOT CLOSED / P2

Location: `debug_trace.ts:96-98`, `:119-126` (depth limit then sizing), `:142-151` (list size accounting).

Independent passing proofs: >4,500-char candidate tail; >800-char local/Fact issue tails; 150 array items and depth20 retained; 13 Fact issues retained in each generation's trace while decision/public/retry list stays 10; four model calls maximum; retry request hashes differ; 200,000-char field cap records explicit field_bound and original size for the ordinary large-field case. Base-prompt vs request hash plumbing is truthful and locally computed.

Remaining failures within the TASK's explicit original/kept size truthfulness requirement:

1. Depth64 is still an additional lower-level retention limit below 200,000 chars. A synthetic depth66 candidate with a tail is replaced by `[depth-limit]`; serialized original size=623, retained size=591, but `candidate_chars` and `truncation.candidate.original_chars` both say 591, and original_chars=kept_chars. The flag/reason is present, but the size describes the already-cut object, not the original redacted evidence. The claim of one size bound/no lower-level loss and truthful original sizing is not met. Normal shallow schema candidates are preserved; this finding does not change Fact/retry behavior.
2. For 30 findings of 10,000 chars each, 19 are retained. `kept_chars=190059`, actual `JSON.stringify(fact_issues).length=190058`. The leading-item estimator adds a comma for the first item. It reports an inexact size and can discard an item that exactly fits the declared bound. Counts otherwise match (original=30, kept=19).

Minimal correction recommendation (NOT implemented): keep defensive depth handling explicit and truthful, including original evidence size before depth cutting (or drop instead of claiming measured full retention); account for retained list JSON commas exactly and test exact boundary. Do not widen Fact/retry/public response caps.

### Tests / bounded regression independently executed

- `deno test --no-config --no-check --allow-read --allow-env supabase/functions/market-report-analysis/`: **192/192 PASS**.
- Related batch: personalized-reports **129/129**, X shared consumer **8/8**, market-report-data-packet **42/42**, trace source + migration invariants **20/20**; batch **199/199 PASS**.
- `_shared` with local `--allow-run=node`: **436/436 PASS**. No workflow or external API invoked.
- Supplied total **827/827 PASS**. No claim these cover the new failures.
- Independently authored local F2/F3 probe: **13 PASS / 7 FAIL**, process exit=1. Seven failed assertions correspond to Basic normal + forged paths (2), escaped quote/backslash/newline normal paths (3), retained-list size (1), depth-original size (1); not seven unrelated findings. Includes all original F2/F3 reproductions and hash/decision controls.
- PG: candidate clean + Supabase-like + 13 adverse PASS; independent seven adverse PASS.
- `deno check --no-config` index / analysis_logic / handler / debug_trace: PASS; changed six TypeScript files `deno lint --no-config`: PASS; runner `bash -n`: PASS; corrected diff and full PR `git diff --check`: PASS.
- Hard Fact, exactly three points, PR99 generic/metric/near-duplicate WARN-only, X 300-char/App rewrite policy, MAX_GENERATIONS=2/max4 model calls, safe-original fallback unchanged. Correction runtime diff only adds hash and full Fact trace vs bounded decision separation; guard/rewrite logic remains unchanged. Existing trace tests confirm write after complete/fail, 404/500/throw nonblocking, no persistence retry/additional AI call. Prior real five-second timeout proof was accepted and timeout plumbing is unchanged; it was not repeated as a new design review.
- Evidence files (local reviewer artifacts, NOT repo implementation): `/private/tmp/h2-pr101-final-20261007.1Cptfa/{independent_probe.ts,independent.log,independent_pg.sh,pg-independent.log,pg-proof.log,analysis.log,related.log,shared.log,check.log,lint.log}`. Reproduction steps/results are included here so C2 does not need access to the local artifacts.

### Freshness / merge recommendation / remaining issues

- PR #101 exact head remains `fddd274863b08aefed60795d678a298a1160d599`, OPEN/unmerged. API mergeability temporarily returns null (recalculation), not proof of a merge conflict; no merge attempted. Candidate source changed-file overlap with latest main remains zero. Main advances seen during review affected other slot control files only; H2 TASK remains this same task. No other slot/control state overwritten.
- **Merge recommendation: HOLD for the specific remaining F2/P1 and F3/P2 corrections only. F1 must not be reopened.** Return to C2; request a bounded G2 correction for the listed cases with exact adversarial tests. No broader redesign or routine repeated review of accepted behavior.
- Model inventory/registry/GPT-6 work remains a subsequent task, not mixed into this review. Production migration preflight/apply/deploy remain separate approval gates.

### changed_files / commit / push / safety_checks

- H2 source/code changes=0. Review evidence lives only in the new H2 private temporary directory. Supplied source checkout remains clean.
- GitHub shared sync scope ONLY `.agent/CODEX_REPORT_2.md` (prepend this report, preserve history) and `.agent/tasks/CODEX_TASK_2.md` (current task review_required / next_owner chatgpt).
- push/shared-sync: SUCCESS. Report-only commit `6fd833e98635824b5019da7f35b114b02c42c91b`; TASK-only commit `493d2425429965509867b9a5608078e478d23465`. Fresh Git fetch proves both are contained in origin/main and their committed paths are only the respective H2 file. GitHub file read-back matches the full intended Report and TASK bytes; current task_id is visible at the Report top, TASK is review_required / next_owner chatgpt. This final receipt is another Report-only control update, not an implementation commit. No source changes by H2.
- Production reads/access=0; DB writes/apply/migration/RPC=0; deploy=0; manual report/generation/OpenAI/X/Push=0; Cron/settings/Auth/Vault/OAuth/secrets=0; merge=0.
- H1/G1-G5/apps/admin/HANDOFF/old or formal repo uncommitted files/other worktrees untouched. Existing changes not staged, reset, stashed, discarded or committed. Secret exposure=0 (probes contain synthetic credentials only).
- next_owner: chatgpt; status: review_required; STOP for C2.

---

## H2 — PR #101 durable generation-trace security review — 2026-10-07 JST

- task_id: kabumori-pr101-debug-trace-security-review-20261007
- result / verdict: **CHANGES REQUIRED**. Three concrete blockers: F1 effective privilege drift commits silently; F2 recognizable credentials inside strings can persist; F3 the promised full diagnostic evidence is truncated before the advertised candidate budget.
- status: review_required
- next_owner: chatgpt
- exact_reviewed_head: `2469e8a8be0125805551ba3e353c4ef6058b0150` (PR #101, OPEN/unmerged; unchanged at final GitHub read-back).
- fresh_main: startup `7a70f75239ff4ecea296ce531f13bb1cfd179aa4`; final pre-publication `11331eda53b1881b5850e3a7b13a4e8bc6c65f41`. Main changes since PR merge-base are .agent control files only; overlap with the 10 PR source/test/docs files = **0**.
- isolation: new H2-only independent checkout `/private/tmp/h2-pr101-20261007.GcKE97/review`, detached exact head and clean. Scratch probes/logs and a private PG17.11 cluster are outside that source checkout. No H1/G1–G5 checkout, server or existing local change was modified.
- changed_files_by_H2: only this Report and `.agent/tasks/CODEX_TASK_2.md` for the shared handoff. Implementation edits = **0**.
- implementation candidate: the single PR commit above, 10 files / +1069 -13; reviewed all changed runtime, new migration, SQL/serializer tests, presentation-test adaptation and DESIGN §15.6.
- publication: **SUCCESS** — Report commit `abbae8c2efc318bf2195398ab9c04007ee8f1545` and TASK commit `a4af0c8e783aaeb323ba3483d5da0196a3df3ba6` are included in fresh GitHub main `d569f3fc6fd0b98749ad70c2410b69e4c7af5c03`. Both complete file bodies were read back exactly; TASK is `review_required / next_owner: chatgpt`. This final receipt changes only the H2 Report. Source/prod operations remain 0; STOP for C2.

### F1 — P1: effective ACL / inherited ownership is not enforced

Location: `supabase/migrations/20261007120000_market_report_generation_traces.sql:99–103` (table creation/ownership also relevant).

The migration revokes direct grants from PUBLIC/anon/authenticated/service_role, grants service_role SELECT+INSERT, and revokes helper EXECUTE from those same four named principals. It does **not** inspect/refuse unknown default grantees, inherited effective table privileges or app-role membership in the table owner. RLS with no policies and invoker-only triggers is a good clean baseline, but does not close those adverse graphs.

Independent PG proof (synthetic fixtures, H2-owned cluster only):
1. Before apply, an unknown NOLOGIN BYPASSRLS diagnostic role receives default table SELECT. Migration **COMMIT succeeds**, then SET ROLE that role reads the synthetic failed candidate (`unknown_default_reader_leaked=t`).
2. Unknown default EXECUTE on functions survives the helper revoke (`unknown_default_helper_execute=t`). The helper is SECURITY INVOKER/returns trigger, so this particular surviving EXECUTE is not itself a SECURITY DEFINER exfiltration primitive; it still disproves the stated exact service/internal helper ACL.
3. Unknown default table TRIGGER grantee inherited by service_role remains effective (`service_inherited_trigger=t`). That role creates a BEFORE INSERT trigger returning NULL; the next service insert succeeds as INSERT 0 0 and drops evidence (`inherited_trigger_silently_discards=t`). Clean SELECT+INSERT-only is therefore not an effective least-privilege invariant.
4. A graph where authenticated inherits the migration/table owner is accepted without refusal. authenticated reads the full candidate, disables the immutability triggers and deletes it (`inherited_owner_reads_trace=t`, `inherited_owner_can_erase_trace=t`). Membership itself was established as an adverse fixture, not by the migration; source currently never rejects it.

These do **not** assert that production has such memberships/default grants: production was not accessed. They prove that the required adverse-state safety is absent and the migration can silently commit unsafe privilege graphs.

Minimum corrective:
- explicitly validate safe creator/owner, exact expected table/helper direct ACL and effective privilege graph (including inherited roles; forbidden table and column capabilities / grant options);
- refuse unknown/default/inherited widening atomically rather than changing global default privileges or role memberships;
- keep the intended service SELECT+INSERT path and anon/authenticated denial, invoker helper and empty search_path;
- add real PG adverse fixtures that require rollback/no partially created objects and preservation of unrelated ACL/default-ACL/membership.
Normal DDL superuser authority is not being claimed universally preventable; the blocker is accepting app/service inheritance of that authority rather than failing closed.

### F2 — P1: secret redaction/detection misses obvious credential forms

Location: `debug_trace.ts:26–35,45–76,80–93,190–207`.

Object-key redaction works for actual nested keys, and ordinary Japanese report content is preserved. But free-text fields and Fact/local issue strings are also persisted. Current key-value regex does not recognize quoted JSON keys because a quote occurs between the key and colon. The Basic pattern is case-sensitive; PEM/private-key text is not recognized. The final detector repeats these gaps.

Independent actual `traceRows -> persistTraces` fake-insert proofs:
- a Fact issue string containing JSON `{"password":"<synthetic value>"}`;
- a candidate report string containing JSON `{"access_token":"<synthetic opaque value>"}`;
- lowercase `authorization: basic <synthetic base64>`;
- `-----BEGIN PRIVATE KEY-----...-----END PRIVATE KEY-----` inside an ordinary-named nested string.
All four: accepted=true, fake insert called=true, original synthetic credential survives=true, post-redaction containsSecret=false. No real key/token was used or printed.

Additional detector proof: a forged row string `password=[redacted] password=<later synthetic secret>` passes the final writer. `containsSecret` examines only the first regexp match and treats that safe match as sufficient; it does not scan later occurrences. This is a writer backstop defect (the ordinary serializer would redact the plain assignment too).

Minimum corrective:
- handle quoted/escaped JSON-style assignments and case-insensitive auth schemes, PEM/private-key blocks and the documented credential shapes inside nested strings/arrays/issues;
- scan **all** matches in the final detector, not only first matches;
- keep ordinary financial/report text intact, and safely drop a row if recognizable credentials still remain;
- add actual writer-level adversarial tests with callback-zero for unredacted forged rows, and non-blocking failure assertions.
Do not replace this with removal of generated report bodies: QA output retention remains the accepted product policy.

### F3 — P2: promised full body / full Fact findings are silently lost

Location: `debug_trace.ts:37–41,52–59,80–93`; `analysis_logic.ts:1183–1187`.

Independent retention proof:
- a structured candidate of only **4,537 serialized characters** (well below MAX_CANDIDATE_CHARS=60,000) becomes 4,044 characters; the tail of a 4,500-character `app_story.news_ja` is gone because MAX_STRING=4,000 runs first;
- an ~800-character Fact issue loses its meaningful tail at MAX_ISSUE=700;
- a valid mocked Fact response with **11 issues** produces only **10 stored issues** for each generation. FACT_SCHEMA has no maxItems=10; the record reuses the existing retry/response cap.
Arrays beyond 80 are also clipped by the generic serializer. This matters specifically for bad/overlong outputs—the cases this diagnostic task is meant to reconstruct. Current large-candidate test explicitly allows an object result and never checks the retained tail, so it does not catch the premature per-field loss.

Minimum corrective:
- preserve full redacted candidate and full local/Fact issue arrays separately from existing bounded retry hints/public-response summaries;
- keep existing Fact/retry decision behavior unchanged (do not remove the old cap from the decision path merely to obtain full diagnostic storage);
- if an explicit total-row/candidate bound is truly necessary, make that distinct and truthful (original sizes/counts and truncation flag), and do not silently impose lower field/issue limits while claiming full retention;
- prove failed overlong bodies, long issue tails and 11+ Fact findings remain inspectable.

### Accepted / nonblocking findings

- **Additive schema / clean append-only:** new table+indexes+invoker trigger helper only, no alteration/destruction of existing objects, no FK maintenance coupling. Nullable report_packet_id supports failures. Unique(invocation_id,generation_index) distinguishes generations; invocation UUID and attempt distinguish scheduled retries. Reapply fails rather than replacing existing objects.
- **Clean ACL/RLS baseline:** service_role SELECT+INSERT; anon/authenticated SELECT/INSERT denied; service UPDATE/DELETE/TRUNCATE denied. UPDATE/DELETE/TRUNCATE triggers reject normal table operations, including ordinary owner/superuser operations while triggers remain enabled. Not a universal guarantee against an administrative owner deliberately disabling triggers; F1 addresses unsafe role inheritance.
- **Full-output retention is genuinely implemented for normal-size structured candidates:** actual raw parsed candidate, not assembled/sanitized final report only; first local rejection survives second generation, subsequent scheduled invocation does not replace prior rows; Fact findings and selected packet linkage persist; tests exercise the handler with fake model/DB. F3 covers the remaining length/cardinality loss, not rejection of the product policy.
- **Non-blocking delivery:** trace write follows complete/fail RPC, one insert, no diagnostic retry/model call. Existing HTTP404/500/throw tests PASS. H2 additionally waited for the real AbortSignal 5-second expiry against a mocked trace sink: ~5018ms, status=completed, modelCalls=2, traceCalls=1, completeCalls=1, failCalls=0. No real network/model/storage/X request. Safe-original fallback and failed report code preserved.
- **Prompt hygiene:** unsupported “前回の引け以降に確認できたニュース” / “今日確認できたニュース” removed; supplied inputs and forward-looking morning semantics retained; no newly added finished output examples. Existing Hard/Fact guards remain unchanged.
- **Regression invariants:** exactly-3-points, Hard date/value/sign/1306/ref/causality checks; PR99 generic/metric/near-duplicate WARN-only; X300-char rewrite/App policy; MAX_GENERATIONS=2/call ceiling; safe-original fallback remain unchanged by inspected diff and regression.
- **Diagnostic identity note:** handler hashes the initial generation instructions once and applies that hash to every row; retry instructions include prior issues, so this is a base-prompt identifier, not an exact per-generation request hash. Clarify metadata meaning or compute per-generation identity without extra AI calls.
- **Known limitations, not silently treated as success:** no trace write after Edge hard-kill before settlement; raw unparseable JSON request failures carry null candidate, not raw invalid output; no retention/cleanup policy activation here. These are separate from the reproduced F1–F3 blockers.
- Supabase / Postgres skills informed effective-grant-versus-RLS and least-privilege tests. Official RLS guide checked: https://supabase.com/docs/guides/database/postgres/row-level-security . Changelog markdown fetch returned unsupported content-type; no implementation was based on an unverified API change.

### Independently reproduced tests

- market-report-analysis: **176/176 PASS**, including new debug_trace **16/16**.
- personalized-reports: **129/129 PASS**.
- X shared market consumer: **8/8 PASS**.
- market-report-data-packet: **42/42 PASS**.
- trace migration source tests: **7/7 PASS**.
- migration source invariants: **11/11 PASS**.
- _shared: **436/436 PASS**.
- Combined existing automated suites: **809/809 PASS**. Passing current suites does not override the independent counterexamples above.
- Initial _shared invocation without --allow-run=node had 435 pass/1 failure in the unchanged diary workflow-validator subprocess test. Re-running with the required narrow local Node execution permission produced 436/436. No source workaround/fix, no workflow run or push occurred.
- Deno check: market-report-analysis index + changed runtime modules PASS.
- Deno lint: changed six TS files PASS; bash -n runner PASS; git diff --check PASS; source checkout remains clean.
- Provided isolated PG17.11 clean apply/behavior/reapply runner: **PASS**.
- H2 PG adverse proof: the four unsafe outcomes above independently reproduced; source incorrectly accepted them (these are expected counterexamples, not claimed passing safety tests).
- H2 secret probe: four serializer leaks + one final-detector masking bypass reproduced; ordinary report control preserved.
- H2 retention probe: all three evidence-loss cases reproduced.
- H2 timeout/non-blocking probe: **PASS**.
- PG cleanup: runner scratch DB dropped; H2 adverse DB dropped; H2-only unknown roles/memberships removed; only postgres remained before private server STOP. No existing cluster/server touched.

### Evidence / minimal next action

Scratch evidence retained locally at `/private/tmp/h2-pr101-20261007.GcKE97`:
`analysis.log`, `related.log`, `shared-run.log`, `check.log`, `lint.log`, `pg-behavior.log`, `adverse.sql`/`adverse.log`, `secret_probe.ts`/`secrets.log`, `retention_probe.ts`/`retention.log`, `timeout_probe.ts`/`timeout.log`. The important reproductions are included above, so C2 does not require access to local files.

- merge_recommendation: **HOLD / CHANGES REQUIRED** for exact head above.
- production_rollout: **HOLD**; no apply/deploy authorization is inferred from passing regressions.
- exact_next_action: C2 return F1/F2/F3 to G2 for one bounded corrective in the new trace migration/serializer/diagnostic record plus focused adverse tests. Do not weaken Hard/Fact, remove allowed QA output retention, or alter consumer behavior. Then one targeted corrective rereview. Recommended G2 model **Opus5.5（高）**, H2 corrective review **Sol（中）**.
- H2 makes no fixes in this review; do not re-review PR41 or G5/Auth paths.

### Safety

- source edits / source commits = **0** (scratch-only probes, shared Report/TASK synchronization excepted).
- production access/read/write/schema/RPC/migration/apply/deploy = **0**.
- real OpenAI/X/Push/Auth/Vault/OAuth/Storage/API calls = **0**.
- Cron/scheduler/settings/secrets/user setting changes = **0**.
- merge = **0**; G1–G5/H1 files/worktrees and existing local uncommitted changes untouched.
- secret exposure = **0**; all credential-shaped probe strings were synthetic; no .env/token/password read.
- completion: `review_required / next_owner: chatgpt`; **STOP for C2**.

---

## H2 — PR #41 focused R1/R2 ACL rereview — 2026-10-07 JST

- task_id: x-social-mobile-pr41-acl-focused-rereview-20261007
- result / verdict: **PASS** for the corrected R1/R2 privilege boundary. Both previous blockers are closed; no new blocker found in this bounded review.
- status: review_required
- next_owner: chatgpt
- exact_reviewed_head: c509117f8addf5a8687d60d9c18ae271b2c1777c (PR #41 open/unmerged; head unchanged at final API read-back).
- previous_reviewed_head: 280aa0f83d4f039ba3e43f32da202a91fd2333f2
- fresh_main: startup fb52674435a86609d0c31e766e66446805810da1; final pre-sync 0aeceeb69ece2207f99a492a9456f64d3bae5066.
- isolation: new independent clone /private/tmp/h2-pr41-acl-20261007.wzJ2FP/review from kabumori-fresh; detached exact head; tracked working tree clean. No shared checkout/dev server/other-slot database used.
- changed_files_by_H2: .agent/CODEX_REPORT_2.md and .agent/tasks/CODEX_TASK_2.md only (completion synchronization). Implementation/migration source edits: 0. Supplemental test script/logs outside repo only.
- implementation_commit: reviewed G3 correction c509117f8addf5a8687d60d9c18ae271b2c1777c; H2 source commit none.
- commit_hash / push: SUCCESS — Report commit `c620b8a9145fc72a0b558c00f511173d3f0ce7f4` and TASK commit `76f6b82202edb9405aa8b4ef00d7b9201db41cd5` are included in fresh `origin/main` (`76f6b82202edb9405aa8b4ef00d7b9201db41cd5`). Both complete file bodies were read back exactly from GitHub main; TASK is `review_required / next_owner: chatgpt`. No implementation/source changes or production operations; STOP for C2.
- merge: 0; deploy: 0; production read/write/apply: 0; real X/OpenAI/Push/Auth/Vault/OAuth: 0.

### Scope / exact delta / freshness

Only the concrete R1/R2 fixes were re-reviewed, not the full PR41 implementation. The correction commit changes exactly six files:
- supabase/migrations/20261006160000_vault_account_brand_post_completion.sql
- supabase/migrations/20261006160100_social_mobile_publish_settings_reader.sql
- supabase/migrations/20261006160200_x_account_publish_authority.sql
- supabase/tests/x_account_refresh_pilot_run.sh
- supabase/tests/x_account_stage3b_acl_adverse_run.sh
- supabase/tests/x_account_stage3b_base_fixture.sql

No functions/app runtime files change in c509117f relative to its fresh-main integration parent. The fixture extraction preserves the existing fake-only core/auth/brand/pilot setup; existing pilot behavior/race proof remains green. The earlier PR41 runtime/body behavior accepted by C2 is preserved.

Fresh fetched main vs PR merge-base: **0 changed-file overlap** across all 16 PR41 changed files; main-only changes are other .agent slots/control state and market-report-analysis/docs, not the reviewed migrations/runtime. H1/G5 are separately reviewing PR95 Auth/session; G4 is docs-only done. No G5 entitlement or unrelated correction was attempted. GitHub mergeable currently returns null (pending recomputation), so do not claim a green mergeability gate; C2 must re-check it immediately before any merge.

### R1 disposition — PASS

The reader now checks both before creation and before COMMIT:
- all forbidden effective table privileges on social_mobile_content_settings (SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER, plus MAINTAIN on PG17);
- SELECT/INSERT/UPDATE/REFERENCES on **every live column**, using has_column_privilege, not table-only ACL inspection;
- direct, inherited and PUBLIC-derived privilege paths are included;
- drift causes refusal, not broad revoke/default-ACL/membership repair.

Independent PG17 runner results:
- direct column SELECT: refused;
- inherited column SELECT: refused;
- PUBLIC column SELECT: refused;
- column INSERT, UPDATE, REFERENCES: refused;
- table DELETE: refused.
All seven refuse with PUBLISH_SETTINGS_READER_PRECONDITION_SERVICE_ACCESS, preserve catalog/default ACL/column ACL/application membership fingerprint, leave reader absent, and keep the injected grant unchanged. Clean apply succeeds, authenticated PR81 table/column SELECT/INSERT/UPDATE remains exactly unchanged, service_role direct table/column read and writes remain denied.

### R2 disposition — PASS

Completion, reader and authority/check/set routines now have:
- preflight refusal for any same-name routine of any signature/kind;
- creator required to be non-superuser and exact relevant table owner;
- explicit owner alignment and pinned empty search_path;
- exact direct ACL: owner plus one plain service_role EXECUTE; no PUBLIC/unknown grantee/grant option;
- effective EXECUTE denial for anon/authenticated, required intended service_role EXECUTE, and additional-role effective-access scan;
- app-role owner/service-role inheritance refusal;
- authority-table RLS/owner/direct ACL/column ACL/effective table and column boundary checks.

Unknown default grantee is refused atomically rather than silently normalized. No global ALTER DEFAULT PRIVILEGES or role membership changes occur in these migrations. Known service_role default grant option is deliberately revoked/regranted into plain EXECUTE (tested); unsafe unknown grant option causes refusal.

Independent provided matrix: 27 routine cases (3 migrations x unknown default / authenticated inheritance / anon inheritance / unknown grant option / overload / procedure / superuser / non-owner / authenticated-service inheritance), plus one authority unknown default DML case, all refused atomically. Together with R1 this is **35/35 refused cases PASS**, plus known grant-option normalization and clean graph PASS.

H2 added nine independent supplemental probes outside repo:
- authenticated inherits owner: completion, reader, authority all refuse;
- anon inherits service_role: all three refuse;
- explicit unknown direct EXECUTE injected by local-only CREATE FUNCTION event-trigger fixture: all three refuse at direct-ACL postcondition.
For the owner probe H2 removed the fixture-only owner->authenticated membership first, then granted owner->authenticated in the inverse direction; this avoids the circular-membership limitation in the supplied fixture. The graph was restored after each case.
All **9/9 supplemental refusals PASS** with identical catalog/default ACL/role-membership fingerprint and no partial target routines/authority table. Combined adverse refusal proof = **44/44**.

Clean behavioral proof:
- anon/authenticated setter enable, completion, authority check, reader and direct authority INSERT all denied with permission denied; authority rows remain 0 and running post remains running.
- service_role setter returns enabled; completion returns fingerprint_persisted=true; direct authority UPDATE remains denied.
Thus the previous authenticated ability to enable authority or forge completion is not present after a successful corrected clean apply, and unsafe ACL fixtures cannot commit.

### Bounded accepted-behavior regressions

Independent existing pilot runner:
- PILOT_BEHAVIOR_PASS
- PUBLISH_AUTHORITY_BEHAVIOR_PASS
- PUBLISH_SETTINGS_READER_BEHAVIOR_PASS
- PILOT_RACE_PASS (independent account leases; one claim)
- PUBLISH_RACE_PASS (revocation effective at commit; post-commit checks refuse)
- PILOT_CLEANUP_PASS

These cover exact running brand/tenant binding, no-row/manual_review consent refusal, intended authority/check/completion, idempotent terminal completion and unchanged local race behavior.

Independent Deno:
- focused dispatcher/generator/AI Lab/settings/phase15/routing/rollout invariants: **65/65 PASS**.
- full PR76 Vault-auth guarded-send test file: **33/33 PASS**.
- migration source invariants: **11/11 PASS**.
- total independently rerun Deno in this bounded turn: **109/109 PASS**.
- deno check vault_account_brand_post.ts: PASS.
- bash -n on both supplied runners: PASS.
- git diff --check corrected commit/working tree: PASS.
- targeted added-line secret-pattern scan: 0 matches (not a guarantee for every imaginable secret format).
- no broad unrelated suite repeated. G3's 534/534 x-test-post and 436/436 _shared are prior reported evidence, not fresh H2 test counts.

Live-generation mock regression includes every remembered AI-consult preference / confirmed persona signal reaching the actual generateBrandPost prompt, unconfirmed persona exclusion, no-row/manual_review callbacks zero, authority before generation and before X, length/NG/dedupe, confirmed-completion non-replayable handling. PR76 tests cover each send/refresh/retry guarded check. Brand-generator/AI Lab/routing fixtures retain AI Lab specialized and Kabumori legacy boundaries. Real fetch is forbidden/mocked; no live X/OpenAI.

### Evidence / cleanup / safety

- PostgreSQL: owned disposable 17.11 Homebrew, Unix socket only on port 56642. All apply/adverse/behavioral writes confined to that instance; no production connection.
- Evidence root: /private/tmp/h2-pr41-acl-20261007.wzJ2FP (adverse.log, extra.sh, extra.log, pilot.log, focused.log, pr76.log, invariants.log, check.log).
- Cleanup read-back: 0 non-default databases; 0 kb_s3b_acl_* residual roles; authenticated->owner and anon->service_role usage both false. Owned PostgreSQL stopped. No other DB/server was touched.
- Formal repo / old repo / other workstreams / apps/admin / HANDOFF / secrets untouched.
- Source changes 0, merge 0, production read/write/schema/RPC/migration/history/Cron/scheduler/settings/Auth/Vault/OAuth/secret changes 0, deploy 0, real X/OpenAI/Push/manual production invokes 0.
- Supabase/Postgres skills informed effective-privilege/least-privilege/SECURITY DEFINER checks. Official functions documentation checked: https://supabase.com/docs/guides/database/functions . Changelog markdown fetch unsupported; no broad web investigation.

### Remaining issues / exact next action

- No remaining R1/R2 source blocker.
- **Recommend PR #41 source merge at exact c509117f after C2 final freshness/head/no-race/mergeability check. No further routine review is required.**
- Production rollout is separate and NOT authorized/performed here. Before apply, verify live creator/table owner is non-superuser, effective role graph/table-column/default ACLs, exact dependency/history/name collisions, and coordinate G5 rollout/enforcement ordering. No production claim is made from disposable proof.
- Candidate remains intentionally dormant without explicit authority activation; G5 entitlement enforcement remains deferred and must not be silently enabled by this review.
- Current C2 handback: review_required / next_owner: chatgpt; STOP.

---

## H2 — PR #41 live-generation security review — 2026-10-07 JST

- task_id: x-social-mobile-pr41-live-generation-security-review-20261007
- result / verdict: **CHANGES REQUIRED**. Two reproduced migration/privilege blockers; no implementation changes made by H2.
- status: review_required
- next_owner: chatgpt
- reviewed_exact_head: 280aa0f83d4f039ba3e43f32da202a91fd2333f2 (PR #41, open/unmerged; head unchanged at final fresh fetch).
- fresh_main: startup 676ce44b3d7f9282276428fbfee0dedc4ce4d385; final pre-sync 8a6c1475c4594cdc5371fa79016f0c8269444285 (previous check 06335b3aa0319d8902642c4ab06ae5385db6ebd2); PR merge-base e7da97d4625fb1474db5c5397e598eedf2589efe.
- isolation: independent clone from kabumori-fresh, /private/tmp/h2-pr41-20261007.gpGVR3/review, detached exact candidate, clean tracked files. No shared slot/worktree/dev-server operations.
- changed_files: this Report and .agent/tasks/CODEX_TASK_2.md only for GitHub synchronization. Source/migration implementation edits: 0. Disposable test helpers/logs outside repo only.
- implementation_commit: review-only, none.
- commit_hash / push: SUCCESS — Report commit d8fa25a2c5e1132f281a06e8751a09b09a3ac4ec; TASK handback commit 95f00061fec267826e51d09e64a8c6b128f97865. Fresh GitHub main read-back matched both files byte-for-byte; fresh fetched main includes both commits. Isolated control-file commits only; no PR/source push. This final receipt records those verified commits.
- deploy: 0; merge: 0; production read: 0; production mutation: 0.

### Findings — blocking

#### R1 — P2: reader migration misses effective column-level service_role table access

- location: supabase/migrations/20261006160100_social_mobile_publish_settings_reader.sql:110-111 (preconditions at 28-44 also do not reject this).
- The postcondition checks has_table_privilege only. A column SELECT grant is a separate privilege; has_table_privilege(...,'SELECT') remains false even when has_column_privilege(...,'settings','SELECT') is true.
- Independent reproduction: apply the actual PR81 candidate+hardening and Stage3A/completion to a nonsuperuser-owned disposable PG17 database; before applying the new reader, GRANT SELECT(settings) ON public.social_mobile_content_settings TO service_role; insert two fake user-brand settings rows.
- Apply the actual unmodified reader migration: **COMMIT succeeds**, contrary to the documented invariant that the underlying table is inaccessible (including columns).
- Read-back: TABLE_SELECT=false, COLUMN_SELECT=true. SET ROLE service_role; SELECT count(settings) FROM public.social_mobile_content_settings returns DIRECT_CROSS_BRAND_ROWS=2. No running scheduled post or narrow-reader binding is required for that direct read. No X/provider call.
- The provided reader behavior test asserts no *direct* column grants in a clean fixture, but does not inject drift before migration; that is not an apply-time guarantee and does not test inherited/effective column privileges.
- Required bounded correction: refuse unexpected effective column SELECT/DML privilege on every relevant live column, including inherited/PUBLIC grants, before committing (do not widen privileges or silently alter unrelated ACL/role graphs). Add direct and inherited column-drift fixtures proving refusal and atomic rollback. Do not claim this grant exists in production: production was intentionally not read.

#### R2 — P1: completion and authority RPC migrations retain unexpected default/inherited EXECUTE

- locations:
  - supabase/migrations/20261006160200_x_account_publish_authority.sql:176-183;
  - supabase/migrations/20261006160000_vault_account_brand_post_completion.sql:111-115.
- REVOKE targets only PUBLIC/anon/authenticated/service_role. An unknown default-ACL grantee survives CREATE FUNCTION, and there is no postcondition validating the exact effective EXECUTE matrix or rejecting inherited application-role access. The reader migration catches this drift for its own function; the other two migrations do not.
- Independent authority reproduction: start from a disposable DB with the actual clean reader already applied; create local fake role h2_unknown; GRANT h2_unknown TO authenticated; ALTER DEFAULT PRIVILEGES FOR ROLE kb_refresh_pilot_owner IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO h2_unknown; apply the actual authority migration. It **COMMITs**.
- Read-back: AUTH_READER_EXECUTE=false, AUTH_SETTER_EXECUTE=true. SET ROLE authenticated can call set_x_account_publish_authority('sa_pilot','enabled','ADVERSE_AUTH',now(),now()+interval '1 day'); result AUTH_UNAUTHORIZED_ENABLE=enabled and AUTH_ENABLED_ROWS=1. The caller does not need owner membership or a service_role credential. Thus a normal app role can acquire the supposedly operator/service-only publish-activation capability through a drifted role/default ACL.
- Independent completion reproduction on a separate fake database: same unknown default EXECUTE/inheritance; actual completion migration **COMMITs**. AUTH_COMPLETION_EXECUTE=true; SET ROLE authenticated can call complete_vault_account_brand_post for a known fake running user-brand post, supplying a fabricated numeric X id/hash. FAKE_COMPLETION_PERSISTED=true; POST_STATUS=succeeded, without any X request.
- This demonstrates unauthorized publish-authority enablement and forged completion state under the precise adverse conditions the TASK asks to cover. It does not assert those drifted grants exist in production.
- Required bounded correction: validate exact signatures/kinds, explicit safe ownership, raw and effective EXECUTE/GRANT OPTION, and application-role inheritance for all new privileged RPCs; unknown default ACL/overloads or unsafe owner/role graph must fail closed with no partial mutation. Add actual default-ACL/inherited-role behavioral fixtures, including authenticated setter/completion calls refused. No global default-privilege/role repair, no broad grants, no G5 implementation needed for this fix.

### Focus A/B — reader/tenant and ACL disposition

- Clean graph: SECURITY DEFINER justified by table denial; explicitly owned by settings-table owner; STABLE, empty search_path, no dynamic widening in function body; exact running brand_post + exact brand + brand-bound row; only social_mobile_user_v1 profile; six settings/persona output columns, no identity/token/Vault fields; no-row returns no consent.
- Clean behavior proof: foreign brand, pending/completed/other type, nonexistent/malformed post, AI Lab/Kabumori/internal profile refused; authenticated/anon execution refused.
- Additional adverse reader fixtures: unknown function default ACL => refused and reader absent after rollback; service_role default EXECUTE WITH GRANT OPTION => normalized narrowly to plain EXECUTE, grant option false; unknown overload => refused before mutation; authenticated inheriting service_role => refused and reader absent after rollback.
- R1 remains the column-access failure. R2 is the inconsistent authority/completion boundary; do not generalize the reader's successful checks to the entire chain.

### Focus C — consent completeness

- Both actual paths use read_social_mobile_publish_settings: runtime loadSocialMobileContentSettingsForPublish and SQL check_x_account_publish_authority. No remaining direct settings-table service read in those two paths.
- Missing row/manual_review/malformed settings do not become auto consent; malformed settings normalize to manual_review. RPC unavailable/malformed/multi-row responses fail closed.
- Ordinary consent behavior passes fake/runtime and disposable SQL tests. RPC ACL drift remains independently blocking.

### Focus D — migration chain

- Actual sequence completion 20261006160000 -> reader 20261006160100 -> authority 20261006160200 sorts after PR81 20261003120000. Clean disposable bootstrap, missing authority dependency, reapply refusal, behavior/races and cleanup reproduced.
- Neither these three nor the retired versions 20260927101423/20260927124300 appears in current-main migration inventory. Source invariant rejects retired reuse; 11/11 migration invariant tests PASS.
- Production absence/history/application claims in G3 report are **not independently confirmed** in this review: production reads prohibited. Before any separately approved rollout, live preflight must verify them.
- Do not use supabase db push or history repair. Reapply/collision refusal is not proof of all ACL drift: R1/R2 are actual accepted unsafe states.

### Focus E/F — live publish and cross-system disposition

- Runtime profile/exact-account/admin/live/post-type gates preserved; authority before generation and immediately before publish; postToX's beforeCreate callback repeats authority check inside each Vault send callback, including reactive/proactive refresh.
- PR76 assertPublishPermission remains before every request callback, including after refresh/401; actual fake send tests pass. Refused first gate => zero generation/X; revocation during generation => zero X create.
- All confirmed PR78 settings/persona fields reach the real generateBrandPost with mocked provider; unconfirmed persona omitted; 140-character/NG-word/cross-brand duplicate checks before X, no subsequent transform.
- Confirmed X completion failure sets the non-replay marker; global failure handler skips fail_scheduled_post. Missing success response id also skips failure marking. Clean completion is exact-account/idempotent/terminal.
- AI Lab specialized/topic-claim path, Kabumori legacy path, Vault ownership/refresh implementation remain unchanged by candidate except added bounded tests/callback hook.
- G5 entitlement enforcement deliberately absent. Clean graph is dormant without an explicit enabled authority row/window; documented insertion points (publish predicate, enable/re-enable, scheduled-user claim) are appropriate. No real-user authority activation before G5 entitlement enforcement. R2 breaks the claimed service/operator-only activation guarantee under ACL drift; fix before acceptance.

### Independently run tests / evidence

- PostgreSQL 17.11, non-superuser fixture owner, Unix socket only: actual PR81 hardening + refresh core/rollout + 3 candidate migrations, PILOT_BEHAVIOR_PASS / PUBLISH_AUTHORITY_BEHAVIOR_PASS / PUBLISH_SETTINGS_READER_BEHAVIOR_PASS / PILOT_RACE_PASS / PUBLISH_RACE_PASS / PILOT_CLEANUP_PASS.
- Adverse reader matrix: clean ACCEPT; column-drift ACCEPT (R1 reproduced); unknown default EXECUTE REFUSE with rollback; grant-option case no grant option; overload REFUSE; inherited application EXECUTE REFUSE with rollback.
- Separate authority/completion adverse databases: unauthorized authenticated enable and forged completion both reproduced (R2).
- x-test-post whole test directory: **534/534 PASS**.
- PR41 dispatcher + routing + migration invariants: **30/30 PASS** (14+5+11).
- Vault account auth/PR76 request/refresh permissions: **33/33 PASS**.
- Focused consult/dry-run/brand generator/dispatcher + AI Lab scheduled/topic tests: **85/85 PASS**.
- PR78 app memory-generation/consult/settings repository: **36/36 PASS**.
- Candidate broad _shared: **433 PASS / 3 FAIL**. All same failures reproduced on PR's main base e7da97d4: **419 PASS / 3 FAIL** (two diary parity/validator tests, one stale persona-confirmed string assertion). Therefore not caused by PR41's implementation diff.
- Startup main 676ce44b (PR97 corrections), with proper local node subprocess permission and its own cwd: **422/422 PASS**. Corrected diary/static-test files are not PR41 changed files; retain these fresh-main corrections on any future integration. No unrelated fix by H2.
- Targeted deno check and lint: PASS. Initial typecheck/test environment lacked existing Node/TypeScript deps; resolved only in owned temp checkout, tracked package/lock files unchanged. Initial broad validator run lacking allow-run was superseded by the properly permitted local-node-only runs above.
- git diff --check candidate diff / working tree: PASS; targeted added-line secret pattern scan 0; tracked working tree clean. The broad scan is not a guarantee against all imaginable secret formats.
- Evidence root: /private/tmp/h2-pr41-20261007.gpGVR3 (pilot.log, adverse.log, per-case logs, x-test.log, shared.log, base-e7-shared.log, baseline-shared.log, focused-brand.log, vault-auth.log, app-memory.log, typecheck.log).
- Cleanup: all 10 H2-only disposable databases removed; H2_TEST_DATABASES_LEFT=0; owned PG server stopped. No other slot database/server touched.

### Safety / remaining issues / next recommendation

- production read/write, deploy, migration/history apply/repair, Cron/scheduler/settings/user/Auth/Vault/OAuth/secret changes, real X/OpenAI/Push calls, manual production invoke, synthetic production candidate = **0**.
- H1/G1-G5 source/worktrees/uncommitted changes, apps/admin, HANDOFF, formal-repo dirty files unchanged.
- Supabase/Postgres skill informed least-privilege/SECURITY DEFINER/ACL checks; official functions documentation checked: https://supabase.com/docs/guides/database/functions . Changelog markdown fetch was unsupported; no broad web investigation or implementation performed.
- merge_recommendation: **HOLD PR #41** for the two concrete privilege defects. No deploy/apply/activation.
- exact_next_action: C2 accept the findings, return one bounded G3 corrective for R1 effective column-privilege refusal and R2 all-new-RPC default/effective ACL hardening plus behavioral/adverse tests. Preserve current-main PR97 test fixes; then review only that changed security boundary, not another full routine review. Recommended corrective reviewer: Sol（高）.
- TASK: review_required / next_owner: chatgpt; stop for C2.

---

## H2 — PR #76 final focused security rereview — 2026-10-06 JST

- task_id: x-social-mobile-pr76-final-security-rereview-20261005
- verdict: **PASS — F1/F2/F3 closed on the exact reviewed source.** No new blocking finding. Source-only final independent review; this is not a merge or production-rollout approval.
- status: review_required
- next_owner: chatgpt
- reviewed_exact_head: `5448e545f4a88bbf6597a981c0bcbe4c01043c30`; previous reviewed head `7f75c07a8c997b6a585e9c86dca01186eeea671f`.
- PR: https://github.com/anohi-memories/kabumori/pull/76 ; OPEN / unmerged / mergeable=true and exact head unchanged at final API read-back.
- fresh_main: startup `f2f7a034bd59a8e20641c0ed14606ca3d55e75c5`; pre-publication fresh fetch `b836823c0cd27d41a08f9d2c40c65966b23cfda4`. Merge-base `ef2f2018fcdaced2f3083ee8ba1b681abd04ee9d`. PR scope 26 files, main/PR file overlap 0. New main change during this review was another slot's TASK only; H2 TASK/task_id/head remained unchanged.
- isolation: fresh independent detached checkout `/private/tmp/h2-pr76-final-20261005.ySeJcp/review`, cloned from the new-Mac clean base. Protected formal checkout, old worktrees, G4/H1 and their uncommitted changes were not operated on. The reviewed checkout remained git-clean. Local disposable PostgreSQL 17.11, Unix socket only, non-superuser migration owner; test databases removed, own server stopped.

### F1 — pre-send parity: CLOSED

- Read actual migration + VaultAccountXAuth.send / PostgREST adapter, not only source-string tests. Final permission SELECT explicitly refuses missing verified_at with X_ACCOUNT_NOT_VERIFIED and nonblank btrim-normalized last_connection_error_code with X_ACCOUNT_CONNECTION_DEGRADED. Space-only code remains eligible; uncertain/reauth_required preserve their specific refusal; refreshing is not a pre-send permission refusal.
- Disposable behavior proof verifies all 18 ON-readiness cases against runtime refusal, plus blank-code eligibility. Actual adapter + real SQL over a local HTTP shim reproduces the two former F1 states after credentials/context were loaded: fake-X callbacks 0; OFF remains available; ON refuses with the matching reason; recovered eligible account sends exactly once.
- Real refresh SQL + actual adapter fake-X timeline: read -> permission -> X401 -> begin -> commit -> read -> fresh permission -> X201. OFF committed after refresh/read and before retry gives only the initial rejected X401; retry callback 0.
- Fixed refusal codes / malformed or unavailable backend responses fail closed; no raw backend/token material in responses or logs. Relevant adapter tests include zero callback on unreachable/unknown permission, proactive/retry recheck, refresh limits and redaction.

### F2 — exact/effective SECURITY DEFINER ACL: CLOSED

- Inspected both exact signatures only. Creator must own x_legacy_post_account and must be non-superuser; pre-existing exact target functions are refused. Both functions use SECURITY DEFINER and fixed empty search_path.
- Creation-default grants to any non-owner grantee (including PUBLIC and grant option) are removed only from the two new functions. Postcondition proves exact direct ACL without grant option, effective app-role privileges, owner and definition. No production ALTER DEFAULT PRIVILEGES, role-membership mutation, or unrelated table grant is added.
- Independently reran adverse disposable ACL harness: clean graph; schema/database-wide unexpected default EXECUTE (including grant option); authenticated/anon inheriting that unexpected default grantee; direct/grantable injection; cross-app and owner inheritance; wrong creator; superuser creator/helper owner; refusal and reapply atomicity. Unexpected-default/inherited case from previous H2 now leaves extra role with no target EXECUTE and app roles with the intended matrix.
- Effective matrix: anon neither; authenticated switch only; service_role assertion only. Other roles may inherit the explicitly intended role/owner, or be superusers, as documented; this is not a promise to restrict superusers. Invalid app-role inheritance refuses the entire transaction.
- Rejected apply preserves pre-existing function ACL/default ACL/role-membership fingerprints and leaves neither new function. Default-grant removal, direct/grantable ACL, effective-role, creator and superuser mutation probes all fail for the expected safety reason.

### F3 — runtime-first rollout: CLOSED as a bounded plan

- Documented order is guarded x-test-post -> exact deployed-source read-back -> at least 15-minute drain (operator must verify current runtime maximum) plus older running-post count 0 -> single permission migration -> definition/direct/effective ACL read-back -> JWT-verified publish-setting Edge -> app exposure.
- Actual partial-state proof uses prerequisite migrations without the permission migration: cached eligible ON context + VaultAccountXAuth still produces X_PUBLISH_PERMISSION_UNAVAILABLE, fake-X callbacks 0, token endpoint requests 0; toggle Edge returns bounded 503 with row unchanged.
- Actual post-migration proof: eligible ON sends once; OFF / brand-disabled stops before fake X. Migration refusal is transaction-atomic and leaves guarded/missing-RPC state safely blocking.
- State-machine forward and every abort path pass. Abort after authority is created revokes authenticated toggle EXECUTE before restoring an old sender; hiding/removing Edge alone is not treated as sufficient. Relevant mutations detect migration-first, missing drain, old-runtime-first abort, exposure before read-back and missing abort path.
- No actual platform/runtime drain or production preflight was performed. Production rollout remains a separately authorized operator gate, with byte read-back, real maximum-invocation confirmation, owner/ACL/schema preflight and all older invocations drained; missing evidence must HOLD, not be assumed.

### Prior R1–R5 bounded regression and availability

- PASS: current auth.uid transactional authority, table -> brand -> membership -> account lock order, bounded waits, demotion/removal/account-move/deletion races, CAS one-winner/stale semantics, tenant-safe answers, fail-safe OFF, no service-role user toggle, and no Auth/OAuth/Vault revocation by OFF. Existing refreshed-credential/in-flight limitations remain explicitly stated.
- App focused tests and source inspection confirm confirmation/action pinned to account + expected state + signed-in user, checked against latest committed render; preview/cross-account/stale/user-switch refuse, one in-flight request, bounded Japanese error copy.
- Availability tradeoff ACCEPTED, not a blocker: recorded nonblank connection errors (including a refresh 429) stop later sends/automatic refresh until legitimate reconnection clears the error. Matches chosen ON-readiness fail-closed contract; reconnect recovery path exists and fake-X recovery was proven. OFF racing refresh can still leave uncertainty requiring reconnect, already documented. Do not silently relax this safety contract.
- Scope remains Vault-backed exact-account path; legacy env/oauth_token_store and important-news-monitor do not gain the same mid-dispatch guarantee. Unwired v2 and other open-PR paths are not claimed protected. Existing accepted scope limitation is not reopened by this corrective review.

### Independent verification

- PostgreSQL runner, PUB_E2E=1: **ROLLOUT_E2E (2) / APPLY + reapply refusal / BEHAVIOR / RACE / E2E (9) / CLEANUP PASS**. Actual Edge handler and VaultAccountXAuth, real SQL; fake Auth/Data API shim and fake X, not hosted Supabase.
- Adverse ACL runner: **PUBLISH_PERMISSION_ACL_PASS**, 12 role situations plus reapply.
- Mutation runner: **45/45 DETECTED** at named expected checks (SQL 34, ACL 6, rollout plan 5).
- Type-checked Deno: publish-setting logic 15 + http 14 + migration 13; vault_account_auth 31; rollout state machine 5 = **78/78 PASS**. Migration invariants **10/10 PASS**; combined focused total **88/88**.
- Exact PR's AI Lab real-wrapper/stub integration: **39/39 PASS**, type checking enabled, no real provider calls.
- App focused publish-setting tests **32/32 PASS**; app TypeScript `tsc --noEmit` PASS; `expo lint` PASS.
- bash syntax for three runners PASS; `git diff --check origin/main...HEAD` PASS; added-line private-key/OpenAI/GitHub-token/JWT-literal scans 0 matches.
- Setup-only first attempts: sandbox shared-memory denial required authorized local-cluster initialization; missing app TypeScript dependency resolved by lockfile npm ci --ignore-scripts in own checkout; wrong test filename and omitted allow-run=node corrected in commands only. Final relevant runs all pass. No source workaround or test implementation change.
- Unrelated broad suites were not repeated. G4's previously reported 984-function/148-app counts are not claimed as newly rerun H2 evidence.

### Changes / delivery / safety / recommendation

- source changes: **0**. changed_files for report delivery only: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md`. Prior TASK/Report histories preserved; no ACTIVE_TASK/CURRENT_STATE/other-slot control edits.
- implementation commits reviewed: G4 corrective `a1a986ae`, fresh-main merge `ce1328c1`, test-stub correction `5448e545`. H2 made no implementation commit.
- report publication: GitHub main contents update for these two control files only, blob-SHA conflict checks and final read-back required; exact resulting delivery SHAs recorded in H2 completion/final response. No PR branch push or merge.
- production reads **0**; production DB/history/schema/RPC/RLS/Auth/Vault/OAuth/Storage/Cron/settings changes **0**; deploy **0**; real X/OpenAI/Push/API invoke **0**; secret exposure **0**. Local test-only fixture/membership writes are disposable, not production.
- remaining risks: production catalog/role-owner compatibility and runtime drain still require live operator preflight; hosted GoTrue/PostgREST behavior is simulated locally here; in-flight X cannot be recalled after an authorized check; reconnect-required availability consequence; legacy-path scope limitation.
- merge recommendation: **merge PR #76 at exact reviewed head after the usual final no-race check. This is the final routine independent review; no additional routine review is recommended after PASS unless concrete new source/blocker changes arise.**
- production rollout recommendation: **do not apply/deploy from this review**. After C2/merge and explicit production authorization, follow S0–S6 exactly, fail closed on every unmet preflight/read-back/drain condition, and never restore old runtime while new toggle authority remains usable.
- next_recommendation: **C2** to accept final PASS and decide merge / separately scoped production rollout. Recommended model: Sol（高） for the security/production decision. STOP; no further action.

---

## H2 — PR #81 residual hardening final rereview — 2026-10-05 JST

- task_id: x-social-mobile-pr81-residual-hardening-final-rereview-20261005
- verdict: **PASS for the exact reviewed source and the bounded atomic-rollout plan.** R1/R2/R3 are closed in independent disposable PostgreSQL proofs. This is not production approval, a merge, or a PR #78 final review.
- status: review_required / next_owner: chatgpt; STOP for C2.
- reviewed_exact_head: `bcc01312c638f5922db4ffd6255ddddf6f611183`; previous bad head `5595fb131813542c55c43bc783af623cdb9ea442`. PR #81 remained open/unmerged/mergeable=true on API read-back.
- fresh_main: startup `5d11923ae5ffd19a76f6e0a3fb750f299d3e1a5b`; pre-publication fetch `ed9404b91d96226b941d66540d5520bd17364b47`. Actual merge-base `cde3a7d3e09d3d2875522620e55672c0426044ef`. Main changed 63 paths from that base; intersection with the 8 PR paths = **0**. H1/G1/G2/G4 workstreams not edited.
- reviewed_changes: app content-settings repository and its test; hardening migration; fixture/behavior/runner/rollout plan; hardening static test. Historical candidate unchanged, SHA256 `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`.
- changed_files_by_H2: only .agent/CODEX_REPORT_2.md and .agent/tasks/CODEX_TASK_2.md for delivery. No implementation fixes, source commits, merge, or deploy.

### R1 — CLOSED
The guard checks constraint non-deferrability/immediacy/validation and the exact single-column brand_id PK index (primary/unique/immediate/valid/ready/live, exact key, btree/default opclass/collation, no predicate/expression). Supplied tests independently reject deferrable-immediate, initially deferred, composite and missing PKs. An actual authenticated owner INSERT … ON CONFLICT(brand_id) DO UPDATE succeeds through RLS. H2-only additional fake-cluster catalog adversaries independently refuse invalid/unready/not-live/not-unique/non-immediate index flags, wrong collation and wrong opclass; no version helper is left after refusal. No silent unknown-PK repair.

### R2 — CLOSED
Exact signatures, routine kind, table-owner identity, and non-owner grantees are checked before CREATE OR REPLACE. Post-conditions require five invoker helpers with pg_catalog search_path, no PUBLIC EXECUTE, only authenticated EXECUTE on the four pure CHECK validators, and no authenticated EXECUTE on the version trigger. The prior unknown-helper-EXECUTE reproduction, legacy-helper grant, overload, unknown name, procedure, foreign owner and post-hardening foreign grant are refused.
Independent inherited-role adversaries: anon inherits authenticated; service_role inherits authenticated through a bridge; authenticated inherits the owner. All cause the effective-function-privilege post-condition to abort and roll back (no new helper/partial hardening); role membership is unchanged by the migration. Unknown default function grantee is also refused at the post-condition and rolled back. Baseline unrelated role has no EXECUTE. Revoking any of the nested required validator grants makes real authenticated writes fail, proving those four grants are needed. No global default-ACL or role mutation in source.

### R3 — CLOSED
Existing updated_at +/-infinity and created_at infinity are refused before mutation and kept byte-identical. H2 additionally proved created_at -infinity refusal with the row unchanged. Finite CHECK protects both timestamps, including when the owner disables the trigger locally. Caller non-finite values are overwritten by server-owned finite INSERT/UPDATE timestamps; year 2999 historical rows survive unchanged and advance exactly 1us. Same-transaction monotonicity, concurrent CAS one winner, earlier long transaction no regression, stale zero-row and competing insert proofs pass. PR #78 still passes the original timestamp string directly to eq(updated_at, expectedUpdatedAt), without Date/ms conversion. Merge-tree with unchanged PR #78 head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7` is clean (tree `7fb711e20492ab2addf6c98e430c00a950f7938e`); this is composition evidence, not full PR #78 acceptance.

### Previously closed contract — preserved
Legitimate settings/persona writers and real owner upsert pass; 61 invalid settings and 24 invalid persona shapes are rejected. Exact JSON keys/types/null behavior, only endLocal=24:00, owner-only SELECT/INSERT/UPDATE, cross-brand/admin/member/viewer/anon denial, DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN denial, service-role table denial and brand cascade/lifecycle remain proven. Persona analysis metadata stays in dedicated columns rather than JSON. No durable publish/token/OAuth field was added.

### Atomic rollout and live migration-history review — PASS, procedure-specific
Read-only production catalog on project wsmznyzcvmuitkglfeuj (one BEGIN READ ONLY transaction, no user content/PII/secrets):
- PostgreSQL 17.6, current role postgres. Target table and same-prefix helpers absent. Both target versions absent.
- Live history columns: version text NOT NULL PK; statements text[], name text, created_by text, idempotency_key text UNIQUE, rollback text[] are nullable. No default required for the proposed (version,name) inserts; RLS off, owner postgres, no explicit ACL.
- brands.id text PK, membership brand/user FKs cascade, owner/admin/member/viewer role CHECK, auth.uid(), authenticated self-SELECT membership policy match the dependency contract.
- Observed owner public defaults: table Dxtm inherited by anon/authenticated/service_role, function owner-only. Relevant inheritance graph has no unexpected effective app-role owner/validator access.
- PR #76 version 20261003090000, PR #81 version 20261003120000, merged PR #82 version 20261004090000 are distinct; all four checked ledger versions (including historical candidate) absent. The earlier PR76/PR82 same-version warning is obsolete. Independent workstream rollout/order must still be coordinated.

The reviewed procedure is one operator-controlled psql --single-transaction with ON_ERROR_STOP=1 across the unchanged candidate file, corrected hardening file, and a plain INSERT of the two exact (version,name) history rows. Neither file has an outer COMMIT or nontransactional operation. H2 reproduced atomic success on the **six-column live history shape** and, independently, a duplicate-history failure and a failure after history insertion: no target table/helpers/new history survive, and the preexisting row is unchanged.
Supplied runner also proves forced failure after hardening leaves nothing while per-file application leaves the weak candidate. Therefore normal db push/migration up is **not** an approved path for this pair. Keeping the old candidate is safe only under the reviewed whole-chain transaction, not in arbitrary per-file rollout.

CLI bookkeeping interpretation was source-reviewed against [Supabase CLI v2.116.0 history logic](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/shared/legacy-migration-history.ts): applied-version listing uses version; statements is nullable. Version/name-only recording is compatible with listing/pending detection, but does not archive replay/down SQL. Keep immutable repo sources; do not imply ordinary migration fetch/down is a complete rollback plan. [CLI file application](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/shared/legacy-migration-apply.ts) is per-file, not whole-chain.

Future apply must have separate explicit approval, same-day catalog/history/owner/defaults/role preflight, fixed reviewed source, production connection supplied securely (not pasted in chat/logs), preferably psql -X, both exact files and history in the same transaction, then separate-session read-back of PK/index/FK/CHECK/trigger/RLS/policies/effective privileges/history. Stop on any mismatch, never run a follow-up db push/repair to bypass a failed preflight. After a committed read-back failure, **do not assume the table remains empty or drop it automatically**; inspect current state and obtain a separate reviewed recovery approval.

### Independent tests
- Disposable PostgreSQL 17.11, Unix socket only, non-superuser fixture owner: runner ALL_PASS, **48 PASS markers**. Precisely 31 SMCS_DRIFT_REFUSED markers, 3 NONFINITE_REFUSED, 3 enumerated repairs; G3's prose count “37 drift refusals” should not be used as the distinct-unknown-drift count.
- Additional H2 harness: 7 PK/index adversaries; 3 inherited-role adversaries; unknown function default grantee; negative-created infinity; production-shaped ledger atomic success; duplicate-history rollback; after-history rollback — ALL_PASS.
- social-mobile npm test: **116/116**, focused repository **3/3**, npm run typecheck PASS, npm run lint PASS.
- Relevant Deno brand + social-mobile-brand-dry-run runtime tests: **162/162** with --no-check --allow-read.
- Content-settings-focused Deno tests with actual typechecking, cached-only and nodeModulesDir=none: **16/16** PASS.
- Optional full checked Deno suite: 5 preexisting diagnostics in unchanged brand_post_generator_test.ts (3 never-property), dispatch_gate_test.ts (optional BrandRecord id), x_oauth2_post.ts (Uint8Array/BufferSource). Not a full checked-suite PASS; no out-of-scope fix. Initial default nodeModulesDir checking also lacked root @types/node; the focused cached-only run resolved that without source/lockfile edits.
- bash -n PASS; deno lint on changed hardening static test PASS; git diff --check PASS; added-line secret signature scan 0; owned review checkout clean.
- Initial H2 extra harness inherited-owner scenario encountered a test-fixture membership cycle, not a product failure; membership orientation was isolated correctly and the final harness passed.
- All runner/extra disposable DBs dropped; remaining test DB count 0; dedicated PostgreSQL stopped. Local proof scripts/logs only under /private/tmp/h2-pr81-20261005.OHrR02, not committed.

### Remaining risks / recommendation / safety
No remaining R1/R2/R3 source blocker in this reviewed head. Recommend C2 source PASS and normal PR #81 merge after fresh integration checks. Production apply remains **NOT authorized**; present the bounded atomic procedure for a separate operator approval, coordinate pending histories with H1/G4, and do not merge/apply PR #78 solely on this report. Managed PostgREST E2E/native login not run; finite PostgreSQL range exhaustion safely errors rather than reusing a token; pure validators are intentionally callable by authenticated; semantic secret detection inside arbitrary free text is not promised. Optional broader Deno checked-suite diagnostics remain separate baseline work.

Production writes/history repair/apply/DB grants/RLS/deploy/Auth/Vault/X/OpenAI/Push/Cron/settings = **0**. PR merge = 0. apps/admin, HANDOFF, other workstreams and formal checkout changes = 0. Secret/PII exposure = 0. Supabase skills guided ACL/RLS catalog/effective-privilege verification; no production mutation performed.
- implementation_commit: reviewed G3 head above; H2 source commit none.
- push: H2 TASK/REPORT only are being delivered with blob-SHA checks; exact delivery commit/read-back verified in completion message. No implementation push.
- next_recommendation: C2 review (Sol（高）); preserve review_required / next_owner: chatgpt and STOP.

---

## H2 — PR #76 transactional publish-toggle final rereview — 2026-10-05 JST

- task_id: x-social-mobile-pr76-transactional-publish-toggle-rereview-20261005
- verdict: **CHANGES REQUIRED**. Ordinary paths and the original authority/pinning reproductions pass, but two independent security-contract gaps and one partial-rollout gap remain. Green supplied tests are not an overall PASS.
- status: review_required / next_owner: chatgpt; **STOP for C2**.
- reviewed_exact_head: `7f75c07a8c997b6a585e9c86dca01186eeea671f`; PR #76 remained open/unmerged, mergeable=true on completion read-back. No PR merge performed.
- previous_bad_head: `a59a89e9c585fb6e780e1af2ecc898c830f5524e`.
- fresh_main_start: `b4c34611d2d99d4dfe89363bee7d579141a38812`; pre-publication fresh main: `e11f209ca764b2d1d79b769e7fd15ed961a8cbc3`.
- PR integrated base: `d345f67402a782a303ce46c640f685271d76b681`; latest main is 20 commits beyond it. PR has 22 changed paths; intersection with base-to-latest-main changed paths is **0**. Main changes during this review are shared orchestration/control files, not these source paths.
- isolation: owned temporary checkout `/private/tmp/h2-fresh-20261005.99TWCY/review`, independently cloned from the new clean base `/Users/yuya/Developer/kabumori-fresh`, then fresh-fetched GitHub main/PR76 and detached exact head. An initial owned clone from the old repo was used only for startup controls before the new-Mac rule was discovered; it was not used for reviewed candidate edits/deploy. Old/shared checkouts were never modified. Both owned source checkouts stayed git-clean.
- changed_files / source fixes: only H2 `.agent/CODEX_REPORT_2.md` and `.agent/tasks/CODEX_TASK_2.md` are synchronized to main. **Source implementation/test/migration changes: 0**. Additional adversarial harnesses exist only in owned `/private/tmp`, not in the PR/repository.
- commit_hash / push: H2 control-file-only GitHub commits; publication SHAs are supplied with final read-back. No PR implementation commit, merge or deployment is made by this review.
- deploy / production mutation: **0**.

### Findings requiring correction

#### F1 [P2] — pre-send readiness still permits states that ON correctly rejects

Location: `supabase/migrations/20261003090000_social_mobile_publish_permission_boundary.sql:276-284` (compared with ON predicate at lines 194-206). The final authoritative SELECT checks identity_verified/nonblank platform_user_id and credential references, but omits `verified_at IS NOT NULL` and nonblank `last_connection_error_code`. The preceding real `x_legacy_post_account` helper also omits both, as does the credential-reader prerequisite. Thus using that helper does not supply the missing conditions.

Independent disposable-DB reproduction, using the **unmodified candidate and real prerequisite migrations**:

1. Create an eligible fake owner/account and running post; caller-JWT toggle ON returns `updated/true`.
2. Clear only verified_at while keeping identity_verified/valid refs/ON.
3. `fixture_permission(post, account, brand)` returns **`authorized`**.
4. OFF succeeds; ON now returns **`blocked / CONNECTION_NOT_VERIFIED`**.
5. Restore verified_at, ON succeeds; set only `last_connection_error_code = 'X_ACCESS_TOKEN_UNAUTHORIZED'`.
6. Pre-send permission again returns **`authorized`**, while OFF→ON returns **`blocked / CONNECTION_DEGRADED`**.

The actual PR76 `VaultAccountXAuth.load/send` was then connected to the real local permission RPC, with a fake X callback and no external fetch. A credential was loaded before each independent state change:

```text
missing_verified_at: mock_X_callback=1, real_network_calls=0
recorded_connection_error: mock_X_callback=1, real_network_calls=0
```

These are positive bug reproductions, not successful safety tests. They violate Gate C/F's fresh structural-readiness contract; neither is a claim of actual production posting or a forged credential attack.

Why the existing suite stayed green: `social_mobile_publish_permission_behavior.sql:120,125` sets `runtime = null` for exactly these two cases, and lines 153-155 skip the runtime assertion when null. ON rejection is tested, runtime parity is intentionally not tested for these rows. Documentation's “Parity ... tested case by case” is therefore too broad.

Bounded proposed correction (not implemented): add both conditions to the final authoritative pre-send SELECT, return fixed refusal codes, and make these two SQL cases assert refusal plus actual-adapter X callback=0. Preserve intended refreshing/current-token policy, the shared helper contract and unrelated refresh behavior unless a separate necessity is established.

#### F2 [P2] — unexpected default EXECUTE grants survive the migration

Location: candidate lines **305-312**; preconditions lines 62-89. The migration revokes PUBLIC/anon/authenticated/service_role then grants the two intended roles, but does not inspect or remove other grants inherited from the apply role's default privileges. It also has no effective-role ACL postcondition. Known-role-only revocation is not an exact least-privilege boundary under the adverse role/default graph required by Gate H.

Independent local-only probe before candidate application:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO h2_extra_execute;
-- Apply unmodified candidate as nonsuperuser kb_publish_permission_owner.
SELECT has_function_privilege('h2_extra_execute',
 'public.set_social_account_publish_enabled(text,boolean,boolean)','execute');
SELECT has_function_privilege('h2_extra_execute',
 'public.assert_x_publish_permission_for_legacy_post(uuid,text,text)','execute');
```

Both results: **true**. Candidate commits successfully instead of refusing. In the same disposable role graph, temporarily granting `h2_extra_execute` to authenticated makes authenticated effectively able to EXECUTE the supposedly service_role-only pre-send assertion (**true**). The test membership was then revoked; the entire fake database was dropped and the owned cluster stopped.

Current production catalog **does not show that adverse drift**: postgres/public function defaults are owner-only, and anon/authenticated/service_role have no parent-role memberships in the queried catalog. Therefore this is a **source fail-closed/default-ACL gap**, not a claim that production is currently exploitable. `postgres` is not superuser but is BYPASSRLS, so ownership/creator role remains relevant to security-definer rollout. The separate supabase_admin default is broad; do not assume every apply tool uses postgres or silently normalize global defaults.

Bounded proposed correction (not implemented): validate the actual creator/owner and both functions' effective ACLs, refuse unknown grants/inheritance, or revoke extra grantees on these two new functions only and then assert exact effective role access before COMMIT. Do not alter global role memberships/default privileges or relax the caller authority checks. Add a default-grantee/inherited-EXECUTE mutation case; current 30 mutations only cover direct known-role/PUBLIC changes.

#### F3 [P2] — migration-first rollout does not fail closed during the old-runtime interval

Location: `supabase/tests/social_mobile_publish_permission.md:86-90` and candidate line 311. The documented order applies the publicly authenticated-executable toggle RPC before deploying the fresh pre-send runtime. Hiding the app or not deploying the thin toggle Edge yet does not remove direct caller-JWT access to that RPC.

Independent partial-rollout probe: same real local migration/RPC; load the old current-main sender before OFF, invoke the caller's transactional OFF successfully, then execute only a fake request callback. Compare with the actual PR76 sender on the identical sequence:

```text
migration_only_old_runtime: OFF=updated, mock_X_callback=1, refusal=none, real_network_calls=0
migration_and_new_runtime: OFF=updated, mock_X_callback=0,
 refusal=X_ACCOUNT_PUBLISH_DISABLED, real_network_calls=0
```

This tests source-level partial rollout, **not the deployed production Function**. The old-main adapter did not change in main during this review. Gate N's “all partial rollout states fail closed” is not proved by the candidate plan: an enabled cached dispatch can still start an X request after the new RPC acknowledged OFF, before runtime deployment.

Bounded recommendation: revise and separately approve an operational sequence that keeps new toggle authority unavailable until the guarded runtime is active. One option is guarded runtime first (missing permission RPC deliberately blocks Vault sends), then atomic RPC apply/read-back, then Edge/app exposure. Another is staging the toggle EXECUTE grant until guarded-runtime read-back succeeds. Explicitly accept the brief fail-closed availability tradeoff; do not quietly treat migration-first as safe or execute either plan from this review. Legacy paths below also need an exposure boundary.

### R1-R5 / Gates A-N disposition

| Gate | Independently established result |
| --- | --- |
| A / R1 | **Closed for reviewed toggle.** Caller identity is auth.uid(), not an argument. Exact account determines brand; current owner/admin membership, brand and account locks bind authorization and the only UPDATE in one transaction. Actual delete/demote-before-write schedules reject; writes after toggle decision wait. ON/OFF both enforce membership. Edge no longer holds service-role table mutation authority. |
| B | **Supplied race evidence PASS.** Lock order table ROW EXCLUSIVE→brand SHARE→caller membership SHARE→account UPDATE; refresh commit-shaped SHARE ROW EXCLUSIVE/table→account probe queues without deadlock. Real deletion-acquire RPC races tested both ways. Timeout returns busy around the 3s bound with no mutation; nonmember foreign-lock probe returns without waiting. No lock spans external HTTP/X. This proves the tested schedules, not absence of every possible future writer deadlock. |
| C / R2 | **Original mixed-brand TOCTOU closed for Vault path.** Actual loader's cached live+ON context is defeated by fresh DB assertion after brand disable; callback=0. New requests/401 retry check anew. Structural-readiness qualification remains F1. |
| D | **Narrow coverage verified.** All wired non-Kabumori exact-account X sends in x-test-post funnel through VaultAccountXAuth.send/postToX, including AI Lab brand_post. The mobile toggle handler itself has no X/media path. Legacy Kabumori env/oauth_token_store, important-news-monitor and unwired v2/account-bound candidates are not covered; do not market this as a global X kill switch. |
| E / R3 | **Closed for tested tenant errors.** Missing/foreign/revoked/moved/deleted rows collapse to not_found with no publish_enabled/readiness. Same-user move A→B is also refused on old authority. Members/viewers get bounded forbidden without current state; owner/admin-only CAS stale state is allowed while locks preserve authority. Unknown SQL/RPC responses become fixed unavailable; no post-decision privileged reread. |
| F / R4 | **Original ON-predicate defect closed; end-to-end parity NOT closed (F1).** Trimmed user id, identity_verified, verified_at, own distinct/unshared refs, connection health, active/live and blocked refresh state are enforced for ON. No Vault-content validity promise is made. Fresh send must enforce the omitted structural conditions too. |
| G | **OFF safety PASS within supported path.** Inactive/broken/ref-less fake account can be stopped; fingerprint of Vault/Auth/history/posts/other fields unchanged. updated_at not stamped. OFF during refresh can cause rotation commit to resolve uncertain, but does not re-enable or replay; existing tests cover the fail-safe result. Deletion already underway returns busy. |
| H | **Ordinary ACL/search_path PASS; adversarial effective ACL FAIL (F2).** Exact signatures, SECURITY DEFINER, empty search_path, fixed codes/schema-qualified relations, no dynamic SQL or broader table UPDATE. Direct ordinary grants match design. Unknown default grant and inherited assertion privilege survive. |
| I | **Chain/apply/reapply/collision PASS for inspected normal shape; adverse ACL qualification F2.** Real prerequisite migrations plus candidate apply; reapply deliberately refuses and preserves original objects. Explicit BEGIN/COMMIT requires standalone application without an outer transaction. Migration creates only the two intended RPCs/ACLs. Guards check existence/names and exact target signatures but are not a comprehensive type/owner/overload drift validator; production preflight must verify exact managed catalog before any separate apply. |
| J | **SQL and shim contract verified, real managed PostgREST unverified.** Local caller authenticated + supplied JWT-sub fixture invokes the security-definer function with correct UID. Additional probe used the production-catalog auth.uid definition with only request.jwt.claims and an empty legacy sub GUC: caller role/auth.uid checks true; toggle updated/true. Security-definer does not erase claim GUCs. No real JWT signature/managed PostgREST call was attempted. |
| K / R5 | **Closed in actual-hook/card test harness.** App's 32 publish-setting tests include A→B→A no resurrection, preview/eligibility/user/state changes, stale handlers and double-confirm/in-flight. Pin invalidation plus latest context gates prevent sending old confirmations; no claim of on-device UI testing. |
| L | **PASS.** Exact 3-key contract; raw duplicate-key/escape ambiguity rejected; streamed UTF-8 byte count ≤512 (oversized chunk cancelled, not accumulated), fixed safe errors. OFF text does acknowledge in-flight cannot be recalled, but its unsupported-legacy scope needs the qualification below. Changed Deno require-await lint passed. |
| M | **Explicit product/exposure risk, not a demonstrated active production bypass.** Ref-less legacy accounts can be stopped but not re-enabled by this RPC. Kabumori cached dispatch and important-news-monitor lack this fresh permission RPC. Current production aggregate has no owner/admin-controllable ON legacy account in the queried shape; do not report an active live bypass from the fake fixture. Generic UI/RPC nevertheless does not fence unsupported legacy accounts. Require a supported-account capability/exposure decision before release. |
| N | **Partial-rollout plan NOT closed (F3).** Missing RPC denies new-runtime sends; missing toggle RPC denies Edge changes. The reverse state—new toggle authority + old sender—remains unsafe. No rollout executed. |

### In-flight boundary / coverage detail

- For the PR76 Vault path the accepted boundary is the fresh permission SELECT/authorized return immediately before request callback. OFF/disable authoritative before that snapshot is rejected. A commit after that authorization cannot cancel an already authorized/in-flight request. No claim of post-start cancellation.
- The reactive 401 retry runs another fresh assertion after successful refresh; proactive refresh also rechecks before send. Tests demonstrate disable/deletion/block/unavailable => no new callback. No second X request starts just because the first assertion once passed.
- The final SELECT unifies post/brand/account/refresh/deletion state; the legacy helper is a preceding statement for distinct/unshared refs and unbound-post contract. Do not describe all helper-only facts as locked for the duration of external X HTTP. This review does not introduce a long-lived lock across X.
- Existing supported runtime path is unbound legacy brand_post, with one X account per brand. Unmerged PR41 account-bound publication and unwired v2 dispatcher are future integration work, not coverage proven here.

### Legacy/Kabumori boundary and production read-only facts

Only catalog and aggregate queries were performed, in READ ONLY transactions; no user identifiers/content, Vault plaintext, handles/emails, credentials or individual account values were queried for this review.

- Both target RPC names absent; target migration ledger version `20261003090000` count=0. No live conflict observed.
- Existing exact-account helper: postgres owner, security_definer, search_path empty, owner-only function ACL.
- authenticated direct social_accounts UPDATE=false.
- Relevant existing triggers: verified_at reconnect reset and social-mobile deletion guard. No generic updated_at-stamping trigger observed.
- postgres/public default function privileges owner-only; no inherited memberships for anon/authenticated/service_role. These current facts do not remove F2's creator/default-graph failure mode.
- Aggregate shape (4 accounts total, no identifiers): ref-less OFF 1 / owner-or-admin-controllable 1; ref-less ON 1 / controllable 0; Vault-backed OFF 1 / controllable 1; Vault-backed ON 1 / controllable 0. This is a metadata snapshot, not a production publish test.
- Legacy ON/OFF asymmetry is a recovery/UX risk. Universal OFF copy promises “no new automatic posts” while cached Kabumori dispatch / independent important-news lane do not satisfy that guarantee. Safest bounded product response is hide/refuse unsupported legacy controls or clearly separate permissions until an explicitly reviewed guard exists; do not silently modify those other functions in PR76.

### Independent tests and execution limits

| Verification | Result |
| --- | --- |
| Focused Edge/logic/migration/Vault tests + migration invariants, checked | **78/78** = 68 focused + 10 invariants |
| x-test-post + shared + publish-setting runtime regressions | **925/925**, explicitly `--no-check` |
| social-mobile Node app tests | **145/145** |
| App domain tests (data-view/post-interaction) | **22/22**, checked with Deno `--sloppy-imports` for Expo-style extensionless imports |
| apps/social-mobile `npm run typecheck` / `npm run lint` | **PASS / PASS** |
| Changed runtime/test Deno check + Deno lint | **11 files PASS / 11 files PASS** |
| Disposable PostgreSQL 17.11 nonsuperuser fixture/real prerequisite chain | **APPLY / BEHAVIOR / RACE / E2E / CLEANUP PASS**; E2E 5 actual-handler/adapter scenarios through local shim |
| Supplied mutation runner | **30/30 DETECTED** |
| Independent readiness probes | **Two reproducible missing-refusal cases**, real SQL + actual PR adapter + mocked X |
| Independent default/effective ACL probe | **Unexpected role executes both; inherited authenticated executes assert** |
| Independent partial-rollout comparison | **Old sender 1 fake request after OFF; new sender 0** |
| Production auth.uid definition / claims-only local replay | **PASS**, does not constitute real managed JWT verification |
| x-test-post entire index type-check | **6 baseline diagnostics**, byte-identical messages/locations to startup main after checkout-path normalization; no new diagnostic. Not claimed globally type-clean |
| Shell syntax / git diff --check / changed-source secret-pattern scan | **PASS** |

Core commands:

```sh
DENO_NO_PACKAGE_JSON=1 deno test --no-config --allow-read supabase/functions/social-mobile-publish-setting supabase/functions/x-test-post/vault_account_auth_test.ts supabase/tests/migration_source_invariants_test.ts
DENO_NO_PACKAGE_JSON=1 deno test --no-config --no-check --allow-read supabase/functions/x-test-post supabase/functions/_shared supabase/functions/social-mobile-publish-setting
PUB_PGHOST=<owned-local-/private/tmp/socket> PUB_PGPORT=56536 PUB_PGSUPER=h2_local PUB_E2E=1 bash supabase/tests/social_mobile_publish_permission_run.sh
PUB_PGHOST=<same-local-socket> PUB_PGPORT=56536 PUB_PGSUPER=h2_local bash supabase/tests/social_mobile_publish_permission_mutations.sh
npm test && npm run typecheck && npm run lint  # apps/social-mobile only
DENO_NO_PACKAGE_JSON=1 deno test --no-config --sloppy-imports apps/social-mobile/src/domain/data-view.test.ts apps/social-mobile/src/domain/post-interaction.test.ts
```

Environment caveats: initial plain root Deno check lacked root @types/node and npm auto-resolution hit restricted-network DNS. Tests were run successfully with package.json auto-discovery disabled/--no-config; no manifest/lockfile was changed to work around it. App's own locked `npm ci --ignore-scripts` succeeded only in the disposable checkout. An initial domain check rejected extensionless Expo imports; --sloppy-imports resolved this without source edits. None is classified as a newly failing PR test.

The supplied mutation suite removed its fake databases. Extra adversarial fake database `h2_pr76_adversarial` was dropped and the H2-owned socket-only PostgreSQL stopped; fake fixtures are reproducible, not retained production data. Evidence harnesses/logs remain in the owned temporary directory and the essential reproduction steps/results are included above, so C2 does not need access to that directory.

### Freshness, migration collision and rollout prerequisites

- PR76 head rechecked unchanged at completion. Fresh main changes intersect none of the 22 PR source/test/doc paths; shared `.agent` histories must still be preserved when writing H2 controls.
- Inspected migration filenames from every current open PR plus fresh main: PR76 `20261003090000`, PR81 `20261003120000`, PR82 `20261004090000` are distinct. Other open PR migration versions `20260927101423`, `20260927124300`, `20260921115317` also do not collide. No open-file response reached the 100-file pagination cap. No other PR's contents were changed/reviewed as an implementation task.
- PR76 adds its reservation without removing current-main reservations; invariant tests pass.
- No real PostgREST binary/stack was available locally. Fake-JWT shim E2E is not managed-platform authentication proof. Production Edge `verify_jwt` configuration, actual migration-executor role/effective privileges and exact managed RPC exposure still require read-only preflight plus an approved rollout test; no production call was authorized here.
- Standard security-definer/default privilege reasoning was checked against official Supabase database-functions/RLS documentation via the Supabase skill. It influenced the adverse effective-ACL/creator-role probe; it did not authorize any production change.

### Recommendation / C2 hand-back

- **PR76 merge recommendation: NO for the reviewed head.** Return bounded corrections for F1, F2 and the F3 rollout contract to G4; recommended corrective/review model **Sol（高）** for independent verification (G4 implementation model is for ChatGPT to assign).
- **Production migration/deploy/app exposure recommendation: NO.** This TASK grants none, and the partial-rollout and unsupported-account boundaries must be resolved before requesting separate approval.
- Remaining unverified items: real managed PostgREST/JWT round-trip (without production mutation), exact production migration tool/creator contract, unsupported legacy exposure decision, future account-bound/v2 dispatcher integration, exhaustive races beyond the tested schedules.
- Do not fix H1/PR82, G3/PR81, legacy Kabumori, important-news, Auth/Vault or broad orchestration files as part of this rereview.
- safety_checks: source fixes 0; PR merge 0; production DB/schema/RPC/migration writes 0; Edge deploy 0; Cron/scheduler/settings/Auth/Vault/OAuth/secret changes 0; real X/OpenAI/Push/media calls 0; real posts 0; apps/admin/HANDOFF/other-slot files changed 0. Existing dirty old repo and clean new base left untouched; no reset/stash/prune/stage/commit of their changes. Only H2 TASK/REPORT publication.

---

## H2 — PR #81 content-settings hardening rereview — 2026-10-03 JST

- task_id: x-social-mobile-pr81-content-settings-hardening-rereview-20261003
- verdict: **CHANGES REQUIRED — ordinary paths pass, three adversarial boundaries remain unclosed**.
- status: review_required / next_owner: chatgpt; STOP for C2.
- reviewed_exact_head: `5595fb131813542c55c43bc783af623cdb9ea442` (GitHub PR #81 open/unmerged; exact head checked at startup and completion).
- fresh_main_start: `a633961056e5f8b628ae59c72163306c21c3f399`; pre-publication fresh_main: `fea45fe0f0656d22e8ffef2d750fd1b62035fd26`.
- PR #78 original head remains `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`, open/unmerged.
- implementation/source fixes: **0**. This review does not rewrite the historical candidate or widen into a corrective implementation. Assign the bounded residual fixes back to G3 and re-review.
- changed_files in repository: **.agent/CODEX_REPORT_2.md / .agent/tasks/CODEX_TASK_2.md only**; histories retained. PR81's seven files were reviewed, not changed.
- implementation commit: none. Control-file publication uses normal GitHub Contents API commits; exact publication SHAs are confirmed by read-back and in the completion response/history.
- PR81 merge recommendation: **HOLD**. Production apply recommendation: **HOLD**. PR78 review may resume only after accepted corrected prerequisite, separately approved atomic apply and read-back; this is not PR78 merge approval.

### Residual findings (independently reproduced, fake local DB only)

**R1 / P2 — deferrable primary key drift is silently accepted and breaks the actual Settings writer**  
File `supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql:60-68`.

The primary-key guard checks only count and conkey. It does not reject condeferrable/condeferrable-index semantics. After the original candidate, replacing its PK with `PRIMARY KEY (brand_id) DEFERRABLE INITIALLY IMMEDIATE` and applying hardening succeeds. Output: `DEFERRABLE_PK_ACCEPTED=true`. The real repository pattern `INSERT ... ON CONFLICT (brand_id) DO UPDATE`, executed as authenticated owner through RLS, then fails with SQLSTATE **55000**: `ON CONFLICT does not support deferrable unique constraints/exclusion constraints as arbiters`. This is a missing Gate F wrong-PK check, not an observed live broken table (production target is absent).

Minimal correction: explicitly require the known immediate, nondeferrable PK/index contract, reject unexpected drift rather than changing someone else's PK, and add this drift + actual-upsert regression.

**R2 / P2 — unexpected existing helper EXECUTE grant survives hardening**  
File `...hardening.sql:448-458`; initial guard and postconditions do not assert helper ACL/owner identity.

In an exact candidate DB, pre-create `public.social_mobile_content_settings_valid_persona(jsonb)` and grant EXECUTE to a synthetic unknown role. CREATE OR REPLACE preserves that role's existing ACL. REVOKE addresses only PUBLIC/anon/authenticated/service_role. Hardening succeeds and `UNKNOWN_HELPER_EXECUTE_SURVIVES=true`. The table ACL is correctly narrowed; this finding is specifically a **function-boundary least-privilege/drift** gap, not a table tenant escape. The resulting reviewed validators are pure booleans; no secret/data-read or X/publish exploit was demonstrated.

Minimal correction: fail closed on unexpected pre-existing helper ownership/signatures/grantees, normalize only explicitly owned/known ACLs, and assert exact effective helper ACLs after apply. Cover unknown helper grant and post-hardening drift; do not globally alter default privileges.

**R3 / P2 — valid historical infinity version survives and is not strictly monotonic**  
File `...hardening.sql:299-310, 375-381`.

The unchanged candidate permits an existing `updated_at='infinity'` (no insert ownership trigger/finite CHECK). Its settings/persona otherwise meet the new contract. Hardening accepts it without rewrite or refusal. `greatest(clock_timestamp(), infinity + 1 microsecond)` remains infinity. An authenticated owner UPDATE leaves `INFINITY_VERSION_STAYS=true`, and another UPDATE with the same old version changes **1** row (`REUSED_OLD_INFINITY_TOKEN_CHANGED=1`) rather than zero. Thus strict-per-row CAS is not established for every admitted existing row.

This is **not** a problem with newly inserted hardened rows: their timestamps are server-owned finite wall-clock values. Normal finite/far-future versions, including 2999, pass. It is an unhandled historical-row precondition, and production currently has no target rows/table.

Minimal correction: refuse non-finite existing version timestamps before hardening (do not silently rewrite them), enforce the finite version domain going forward, and add the infinity fixture. Document created_at handling separately if needed. Keep the existing finite CAS and app string-token interface.

### F1-F4 disposition / gate summary

| Original finding | Independent result |
| --- | --- |
| F1 JSON/persona | **Closed for inspected normalized writer shapes**: exact root/window keysets, explicit JSON types, null-safe CHECK, locale/timezone, integer bounds, per-item arrays, 24:00 only for end, persona allowlist and column metadata. 61 invalid settings + 24 invalid persona cases rejected. Structural validation cannot detect semantic secrets hidden in permitted human text. |
| F2 effective table ACL/RLS | **Original table flaw closed**: PUBLIC/anon/service_role none; authenticated S/I/U only; DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN denied; no column ACL; tenant/owner RLS passed. **Gate C helper ACL still fails R2**. |
| F3 version | **Finite paths closed**, same-transaction and concurrent/long-transaction evidence passed. **Not globally closed for accepted historical infinity (R3)**. |
| F4 drift | Existing 20 drift cases refused and enumerated repair passed. **Not closed for deferrable PK and helper ACL drift (R1/R2)**. |

The existing PASS test suite does not prove the three omitted cases are safe. No source fix was mixed into the reviewed exact PR head.

### Migration chain / actual transactionality

- Historical `20260922045046_social_mobile_content_settings_candidate.sql` byte-unchanged, SHA256 `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`.
- New hardening version `20261003120000` is unique in PR81/current main, ordered after the historical candidate, and refuses absent target relation.
- Independent SQL runner proves candidate+hardening in a single explicit transaction; invalid existing rows/drift refuse without partial hardening.
- **Also tested the installed actual Supabase CLI 2.116.0**, not merely psql -1: separate disposable CLI project with exactly these two files, explicit DB URL bound to H2's local Unix socket. `migration up` succeeded; history contains exactly `20260922045046,20261003120000`.
- A third **repo-external fake test migration**, create marker then raise, failed as intended. Read-back: `CLI_ATOMIC_MARKER_ABSENT=true`, failed history count=0. This proves per-file rollback through the real CLI.
- Official pinned CLI source corroborates that headerless compatible statements plus history run in one extended-protocol batch. Neither reviewed file contains authored transaction controls or nontransactional statements. Source: [CLI migration apply](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/shared/legacy-migration-apply.ts), [batch contract](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/shared/legacy-db-connection.service.ts).
- **Per-file atomicity is not whole-chain atomicity.** Normal migration-up commits the historical candidate before hardening. An interrupted/failed second file could leave the known weak candidate. No repository-owned production apply path establishing an outer transaction for both files was found. A later rollout must explicitly approve/prove an atomic two-file application or equivalent safe plan; do not infer this from the CLI's per-file guarantee.
- No CLI db push, remote migration apply, history repair/reconcile or production transaction was used. CLI output calls the explicit supplied URL “remote database”, but it was the disposable local Unix socket, not Supabase production. First sandbox CLI help/version attempt failed writing CLI telemetry; ordinary approved help/version rerun succeeded, no app/secrets setting change.

### Writer compatibility / repository change

- Inspected main Settings upsert, conversation saveConfirmedProposal, PR78 saveConfirmedIfUnchanged and shared persona materializer/normalizer; no other writer of this table found in relevant source.
- Normalized settings have exact nine durable keys and five window keys; blank NG strings are dropped, arrays bounded; persona proposals trim/filter/bound durable style signals.
- PR81 deletes analyzedAt/analyzedPostCount from persona_profile only; dedicated persona_last_analyzed_at/count writes remain. Source object is not mutated; settings-only save omits persona columns, confirmed metadata retained.
- Focused repository tests **3/3 PASS**; full app **116/116 PASS**.
- PR78 CAS uses the returned timestamp **string**, not JS Date millisecond reconstruction; local JSON timestamp round-trip passed at microsecond precision. Managed PostgREST E2E was not run.
- PR78 and PR81 source composition tested with `git merge-tree --write-tree`: clean, tree `f330f255bfcec3437c01d025c384eb4cabb384ef`. This is composition evidence, not a rebase/merge or independent PR78 approval.
- Known pre-existing main validator rejects its own endLocal=24:00 default; PR78 contains its narrow fix. PR81 did not change this file; accepted finite-window saved shapes remain compatible. Record this dependency instead of claiming the unmerged main default flow works.
- Shared server contract adds livePublishingEnabled=false **only to runtime guidance**, not durable repository JSON. That flag is not a writer-controlled DB publish permission.
- PR78 and existing dry-run reads use caller JWT + publishable key. No service-role DML on this settings table is currently required.

### Independent local tests / adversarial evidence

H2 checkout `/private/tmp/h2-pr81-review.zzmdmR/repo`, detached exact PR head, clean. Own PostgreSQL **17.11**, Unix socket-only port 56434, non-superuser kb_smcs_owner setup role; client probes SET ROLE authenticated/anon/service_role. Synthetic users/brands only.

- Original SQL runner: **ALL_PASS** (apply/reapply, single transaction, behavior incl. 61+24 invalid JSON, owner/RLS/ACL, same-tx CAS, two-connection one-winner CAS, long-tx no regression, competing insert, invalid existing-row refusal, 20 drift refusals, 3 enumerated repairs, cascade/unrelated preservation, cleanup).
- Extra local adversarial cases: **three unresolved defects reproduced**, exact outputs above; valid existing-row full JSON comparison unchanged=true.
- Independently ran **one** source-external now() mutant: suite failed at `same transaction advances strictly`, expected detection. Did not rerun/claim G3's other seven mutants.
- Social-mobile full test **116/116 PASS**; repository focused **3/3 PASS** (subset, not additional distinct total).
- Deno shared-brand + social-mobile-brand-dry-run **158/158 PASS**, explicitly `--no-check --allow-read`; this is runtime test success, not a separate Deno typecheck claim.
- App TypeScript check PASS; app lint PASS; changed Deno static test lint PASS; bash syntax PASS; git diff --check PASS.
- Dependencies installed lockfile-exact via npm ci --ignore-scripts in H2 isolated app only. No root package/lock or formal-repo dependency change; checkout remained clean.
- Proof/artifacts are repo-external. All runner fake DBs removed, h2_pr81_adversarial and h2_pr81_cli dropped, H2-owned cluster stopped. Source/test files were not edited.
- This is PostgreSQL/CLI local proof, not live Supabase Auth/PostgREST/managed deletion E2E.

### Production read-only catalog / conflicts / lifecycle

Exactly **3 READ ONLY catalog transactions**, no settings/user content/PII:
- Target table and same-prefix functions absent; both migration history versions absent.
- DB role for catalog tool = postgres; dependency tables owned by postgres.
- postgres/public default table ACL remains anon/authenticated/service_role Dxtm (TRUNCATE/REFERENCES/TRIGGER/MAINTAIN); function default owner-only. Supabase_admin's separate defaults are broader and not conflated with postgres defaults. A rollout using a different creator role needs another preflight.
- brands.id text PK; memberships brand_id text FK CASCADE, user_id uuid Auth FK CASCADE, composite PK, owner/admin/member/viewer check; RLS enabled; authenticated self-membership SELECT permitted. Public CREATE denied anon/authenticated.
- Existing dependency deletion-guard triggers unchanged. Brand FK cascade proved locally, existing purge deletes brands, no new common-account schema dependency. No actual account deletion/Auth/Vault action.
- PR81 seven changed paths have **zero overlap** with fresh main changes since merge-base. Later main movement before sync changed H1/index controls only; H2 control blobs unchanged.
- H1 PR82 and G4 PR76 paths do not overlap PR81. PR81 version 20261003120000 differs from both.
- **Out-of-scope coordination note:** current PR76 and PR82 each propose a different file with version 20261003090000. This pre-existing cross-PR timestamp collision was not changed and is not PR81's own version collision; orchestrator must settle it before combining their migration histories. Do not apply all repo migrations opportunistically.
- H1 became done; G4 review_required on latest main. Their TASK/Report/source/checkouts were untouched.
- Supabase skill changelog markdown endpoint returned unsupported content-type 400; no successful changelog read claimed. Used relevant security instructions and pinned CLI source/runtime proof.

### Safety / C2 next recommendation

- code changes / historical migration rewrite / PR merge / source push: **0**.
- production DB write/schema/RPC/grant/migration/history/settings/deploy/Cron/scheduler: **0**.
- live/paid OpenAI / X / Push / OAuth / Vault / Storage / user-account actions: **0**.
- formal repo existing changes / other workstream modifications / apps/admin / HANDOFF / root package/lock/env: **0**.
- actual user-content/PII/secret reads and exposure: **0**.
- Control-file sync only, full prior TASK/Report preserved; normal conflict-checked publication with remote read-back, no force push/stash/reset.
- C2: send G3 the bounded R1/R2/R3 corrections and explicit transaction-plan requirement. Suggested implementation Opus5.5（高）, rereview Sol（高）. Keep PR81/apply/PR78 HOLD. No production authorization is implied.
- Final state: **review_required / next_owner: chatgpt**.

---

## H2 — Content-settings schema prerequisite review — 2026-10-03 JST

- task_id: x-social-mobile-content-settings-schema-prereq-review-20261002
- verdict: **FAIL / CHANGES REQUIRED — existing candidate is not ready for production apply**.
- status: review_required / next_owner: chatgpt; STOP for C2.
- reviewed main: `6ccaaf3a8bb4a2443e17412ae83421a6de7295e0`; pre-publication fresh main: `46d4258158e76f8131b9103014e8356e78c2d8eb`. Target migration/consumer sources and H2 controls were unchanged between these checkpoints.
- target: `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`
- exact migration SHA256: `b1167065e4177492b1139071055e89da2bf9db12b0e43e20dada1af07a996fdb`; last source edit: `649111c002f9e19f39e872797e3018829fdd7dbc`.
- PR #78 consumer inspected at exact head `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`; this is schema review only, NOT completion of the remaining PR #78 Auth/AI/security gates.
- implementation/source changes: **0**; no candidate rewrite, corrective migration creation, or PR merge.
- repository changed_files: **.agent/CODEX_REPORT_2.md / .agent/tasks/CODEX_TASK_2.md only**, completion record with histories preserved.
- production apply / deploy recommendation: **HOLD**. Do not present the unchanged candidate as approved for apply.

### Independent production preflight — catalog only, READ ONLY

Two explicit READ ONLY transactions against `wsmznyzcvmuitkglfeuj`; no user content/settings/PII/token query.

- `public.social_mobile_content_settings` remains absent; touch function absent; migration history version `20260922045046` count **0**. No candidate-named function collision.
- `brands.id` text PK; `brand_memberships.brand_id` text FK -> brands ON DELETE CASCADE; user_id uuid FK -> auth.users ON DELETE CASCADE; composite PK(brand_id,user_id); roles owner/admin/member/viewer. Required dependencies compatible.
- Both referenced tables have RLS enabled. Membership self-SELECT binds verified `auth.uid()` to user_id, and authenticated has SELECT; candidate policy subqueries therefore do not recurse through content-settings.
- `auth.uid()`: stable invoker UUID function, existing request.jwt.claim.sub/claims implementation. Local fixture uses the sub GUC path, not live Auth.
- Important apply-specific fact: postgres/public default table ACL gives authenticated and service_role **TRUNCATE / REFERENCES / TRIGGER / MAINTAIN**, not DML. Candidate must normalize effective grants explicitly; source GRANT statements alone do not describe the eventual ACL.
- Public CREATE is denied to anon/authenticated/service_role. Candidate trigger is invoker, not SECURITY DEFINER; no unqualified helper lookup in its body. Direct EXECUTE is revoked from PUBLIC/anon/authenticated/service_role.
- Existing brand/membership deletion-guard triggers are present. This review did not invoke them or run real account deletion.

### Findings — apply blockers / bounded corrections to assign separately

**F1 / P1 — persisted JSON boundary is weaker than the stated contract** (`candidate.sql:35-67`).

CHECK expressions can evaluate NULL and be accepted. Present-but-null locale/preferredTone/objective/approvalMode/frequency, notes:null, and missing/null generationWindow members were saved successfully under the authenticated owner role. `->>` also coerces types: preferredTone:number/bool, objective:bool, frequency:"3", dayOffset:"-1" pass. Arrays are count-only: numeric/object/null members and overlong strings pass. Locale en-US and arbitrary-looking timezone Fake/Zone are accepted by SQL even though current app/server use ja-JP/Asia-Tokyo.

The forbidden-key denylist is incomplete. Owner direct INSERT/UPDATE can persist settings access_token/secret/oauth/publish_mode, nested generationWindow.publish_enabled, and persona secret/publishEnabled/historical_posts/nested token/wrong-type signals. Tests used ONLY synthetic "fake" values; no real secret read/saved. This proves **durable malformed/forbidden structured data**, not an actual publish-enabled mutation or cross-tenant/X exploit. Existing normal app writers validate/project data, but a browser validator is not the database security boundary.

Small correction proposal: exact structured allowlists/types/required fields at both settings/window/persona levels, bounded string-array elements, null-safe rejection (`IS TRUE` / explicit missing-null checks), and compatible value constraints for current legitimate writers. Preserve legitimate endLocal=24:00 and valid persona metadata. Arbitrary human text in allowed notes cannot be semantically proven secret-free by a structural schema; do not promise that.

**F2 / P1 — DELETE denial does not mean destruction denial with live default ACL** (`candidate.sql:88-91`).

Reproducing production's exact defaults, authenticated has SELECT/INSERT/UPDATE, DELETE=false, but TRUNCATE=true, TRIGGER=true, REFERENCES=true, MAINTAIN=true. A local authenticated-role transaction truncated **all settings rows despite RLS**, then was rolled back. anon has no table privileges after REVOKE ALL. service_role inherits those non-DML rights and has no SELECT/INSERT/UPDATE.

This is a confirmed SQL privilege flaw; there is **no claim that PostgREST exposes a TRUNCATE endpoint or an identified arbitrary-SQL production exploit**. Still it violates the requested least-privilege SELECT/INSERT/UPDATE-only contract.

Small correction proposal: normalize PUBLIC/anon/authenticated/service-role table ACL, then grant only intended operations. Existing dry-run and PR78 reads use user JWT + publishable key, so missing service_role DML is not currently proven to break those readers; decide any future service-role requirement separately. Do not globally change database default privileges or unrelated tables.

**F3 / P2 — timestamp is not a per-update version** (`candidate.sql:71-86`).

updated_at is timestamptz NOT NULL DEFAULT now(), with BEFORE UPDATE trigger overwriting caller input. Ordinary distinct transactions advance it; concurrent CAS test had winner=1 / loser=0, and competing INSERT produced 23505 / one row.

But `now()` is transaction-start time. Two updates within one transaction reuse the same timestamp: a second UPDATE with the original transaction version matched **1** row, not zero. A long-running earlier transaction also moved the version backwards after another transaction updated the row. This is a deterministic transaction-clock issue, not a probabilistic microsecond collision claim. No current single-row PostgREST race failure was demonstrated; its normal two-request race passed.

Small correction proposal: retain the compatible timestamptz CAS contract, but use a server-owned strictly increasing value on UPDATE, e.g. `greatest(clock_timestamp(), old.updated_at + interval '1 microsecond')`, with insert timestamp ownership considered. Alternatively explicit revision counter would require coordinated schema/client work. Test same transaction, equal clock, regression/ABA, upsert, all writers before acceptance. No fix applied here.

**F4 / P2 — IF NOT EXISTS silently accepts a drifted same-name table** (`candidate.sql:5-69`).

Exact-shape reapply preserved rows/policies/trigger. But after locally removing JSON CHECKs and the brand FK, reapply succeeded and left **all three missing constraints missing**; malformed settings/persona then stored. CREATE TABLE IF NOT EXISTS is not schema reconciliation. Unexpected existing columns/types/constraints/grants/policies need fail-closed preflight or explicit versioned correction, not blind apply.

Fresh transactional apply -> read-back -> ROLLBACK restored absence; a forced halfway error in an explicitly wrapped transaction restored the original two fake rows. The SQL file itself has no BEGIN/COMMIT; do not assume unwrapped/manual execution is atomic. It also does not itself write migration history: application tool / explicit authorized bookkeeping must be settled in a later rollout task, never repair/reconcile opportunistically.

### Table/writer contract and accepted boundaries

- Expected columns exist in the candidate: brand_id PK/FK cascade, settings/jsonb default, persona_profile/jsonb {}, provenance enum conversation/past_post_analysis/manual, confirmed=false, optional last_analyzed_at/count 0..1000, created_at/updated_at timestamptz defaults.
- Default settings create successfully; valid lower/upper bounds and valid persona shape save; SQL endLocal 24:00 accepted, start/default 24:00 and end 24:01/prefix/suffix rejected.
- Main mobile validator still rejects its own 24:00 default. PR78 contains the narrowly scoped endTimePattern fix; do not silently merge it via this schema task. Shared server normalizer/materializer inspected, and schema-invalid data can be dropped/defaulted, but that is not a durable DB constraint.
- Existing settings screen calls repository.upsert; settings-only upsert omits persona. Local proof preserved confirmed persona. Existing saveConfirmedProposal and PR78 saveConfirmedIfUnchanged write same table; BEFORE UPDATE applies to their UPDATE/upsert paths. PR78 insert race / eq(updated_at) design depends on fixing/accepting F3 semantics, not merely the existence of a trigger.
- Ordinary RLS: owner SELECT/INSERT/UPDATE work; member/admin/foreign owner SELECT hidden and UPDATE zero; unauthorized INSERT/cross-brand reassignment denied; anon reads/inserts denied; owner DELETE denied. Owner-only agrees with PR78 and existing repository, not broader publish-toggle owner/admin policy.
- Brand FK cascade proved locally. Existing social-mobile purge explicitly deletes brands, so candidate settings rows follow that cascade without needing a new common-account table. Auth-only deletion removes membership, hides settings from caller, but leaves brand/settings until service workspace cleanup; this is not a proof of end-to-end managed deletion.
- Common-account Phase1 foundation remains separately HOLD/unapplied; candidate has no new dependency on it. Lifecycle FK compatibility is source/schema-level, not managed Auth/Vault/Storage deletion certification.
- Candidate creates one noninternal BEFORE UPDATE trigger on this table; no unrelated runtime triggers or tables were modified.

### Independent local evidence / limitations

H2-only disposable PostgreSQL **17.11**, Unix socket only, database `h2_settings_review`, synthetic users/brands; catalog-compatible required columns/FKs/self-membership RLS + actual public default ACL reproduced. Local postgres is a superuser for setup; client tests SET ROLE authenticated/anon and verify non-superuser RLS behavior. This is **not** managed Supabase/GoTrue/PostgREST E2E.

- Behavioral harness: **104 observations** — 59 expected/harness assertions, **42 admitted-invalid/version-defect observations**, 3 effective-ACL observations. Not "104/104 product PASS"; the successful TRUNCATE reproduction is adverse evidence, not a safety PASS.
- Additional apply/reapply/drift/rollback/cascade/upsert markers: 8 verified outputs.
- Real two-connection INSERT race: PASS, winner one / loser 23505 / one stored row.
- Forced-error transactional rollback: PASS, original two rows restored.
- Existing source tests run with Node 24.19 type stripping: **7/7 PASS** (migration/static3 + shared-content4). They do not detect F1/F2/F3/F4; regex tests are not DB security proof.
- Initial `deno test --allow-read` could not type-check due missing npm:@types/node in this clean checkout. No install/package/lock edit or type-check success claim. Same test files executed via standard Node runtime; Deno check remains environment-unverified.
- Source checkout clean; git diff --check PASS; migration SHA256 unchanged.
- Fake DB was dropped and H2-owned cluster stopped. Proof harness files remain outside repo in `/private/tmp/h2-settings-schema.tebpFt/`; **the findings/reproductions above are in this Report so C2 need not access local artifacts**.
- Relevant docs: [PostgreSQL CHECK/null semantics](https://www.postgresql.org/docs/17/ddl-constraints.html), [transaction-time vs clock_timestamp](https://www.postgresql.org/docs/17/functions-datetime.html), [RLS including TRUNCATE exception](https://www.postgresql.org/docs/17/ddl-rowsecurity.html), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- Supabase skill changelog .md endpoint could not be opened by the web reader (400); used current official RLS docs instead. No speculative feature implementation.

### Minimal disposable reproductions (NOT production instructions)

After applying the **unchanged candidate** in a fake owner workspace:
1. Owner UPDATE settings to its valid default with `locale:null`, or window `{}`: succeeds; invalid contract should reject.
2. Owner UPDATE persona_profile to `{"secret":"fake","historical_posts":["fake"]}`: succeeds; structural deny boundary is incomplete.
3. With production-default authenticated ACL, BEGIN / SET ROLE authenticated / TRUNCATE this table / SELECT count / ROLLBACK: count zero across tenants, despite DELETE denied.
4. BEGIN; owner UPDATE once; UPDATE again WHERE updated_at=now(): second row count1; timestamp stays identical.
5. Remove two CHECKs + brand FK in a transaction; rerun original candidate; catalog count for those three constraints remains0; ROLLBACK.
No such mutation was performed on production.

### Next action / C2 disposition / safety

- **Do not separately approve production apply of the unchanged historical candidate.**
- Assign a narrowly bounded corrective-schema task (recommended **Sol（高）** review, **Opus5.5（高）** implementation as appropriate). Default proposal is a new versioned hardening migration with explicit contract/ACL/drift checks and compatible monotonic CAS; preserve historical migration rather than silently rewriting a recorded source candidate. Decide whether original+corrective must be applied atomically or a consolidated never-applied candidate is explicitly permitted.
- Corrected candidate must pass fresh local invalid-JSON/ACL/CAS/drift proof; then C2 can consider a **separate explicit production apply approval** with live preflight and read-back.
- Only after accepted schema apply/read-back may PR78's unfinished independent review resume; schema PASS alone does not approve PR78 merge/deploy/public enablement.
- production writes/apply/migration-history/RLS/grants/deploy/settings/DB change: **0**.
- paid/live OpenAI / X / Push / Auth/OAuth/Vault/Storage / Cron/scheduler operations: **0**.
- formal repo existing changes / H1/G3/G4/other workstream changes / apps/admin / HANDOFF / root package/lock/env changes: **0**.
- Read-only catalog transactions: **2**. Actual user data reads: **0**. Secret/PII/report exposure: **0**.
- H1 fresh task is PR79 Hard Fact review; G4 transactional publish-toggle corrective is distinct. Neither worktree/TASK/report/source touched.
- Only H2 TASK/Report are synchronized via GitHub; publication SHAs identified in completion response and GitHub history. Preserve all prior entries; final status review_required / next_owner chatgpt.

---

## H2 — PR #78 AI相談 v1 review：production schema前提不成立で停止 — 2026-10-02 JST

- task_id: x-social-mobile-pr78-ai-consult-review-20261002
- verdict: **FAIL / CHANGES REQUIRED（schema prerequisite BLOCKED・独立レビュー未完了）**。
- original_exact_head: `6e9f78a31bae9b65599732a9b416dcb50f2bfbc7`。GitHub PR #78 open/unmerged、指定head一致を確認。
- final_reviewed_candidate: 元headのまま。source fix / implementation commitなし。
- fresh_main: `9c8436cc12e781194314bcf2c66e0994a7fa0053`。PRとmainのmerge-base `0c2c04e031e6b8d10a4d0f30067a54f33daa7b3b`。
- merge_recommendation: **HOLD / 未承認**。全gateを通したレビューではない。
- deploy/public_rollout_recommendation: **HOLD**。今回deploy・実AI・production write許可なし。
- changed_files: **.agent/CODEX_REPORT_2.md / .agent/tasks/CODEX_TASK_2.md の停止記録のみ**。過去履歴保持。
- next_owner: chatgpt。review_requiredでSTOP for C2。

### P1 — 必須の設定保存テーブルがproductionに存在しない

project `wsmznyzcvmuitkglfeuj` へ1回の `BEGIN TRANSACTION READ ONLY` catalog SELECTを実施し、次を確認:

```text
to_regclass('public.social_mobile_content_settings') IS NOT NULL = false
columns = []
RLS = null
grants = []
policies = []
triggers = []
constraints = []
```

これは「RLSで行が見えない」「0件の空table」ではなく、**publicのrelationそのものが不存在**というcatalog証拠。利用者レコード/PII/設定値は読んでいない。

影響:
- `apps/social-mobile/src/data/content-settings-repository.ts:49` は当該tableのsettings/persona/updated_atをSELECTする。不存在時はunavailable扱いになる。
- 同ファイル `:134` の明示確認保存は同tableへINSERTまたは `brand_id + updated_at` 条件のUPDATE。現行productionではその永続化を成立させられない。
- `supabase/functions/social-mobile-consult/logic.ts:269` のsaved-state readは同table依存。一部のmissing table/column responseはdefaultsへfallbackする（`:290-294`）。**fallbackで会話できる可能性は、confirmed settings/persona保存やCASが成立する証明ではない**。このレビューでは本番Functionを呼んでいないので実際のHTTP fallback結果を断定しない。
- Gate Eの `updated_at` exact型/nullability/default、RLS/SELECT/INSERT/UPDATE、touch trigger、すべての既存writerがversionを進めるかをlive schemaで証明できない。

TASKは「required production schemaが不足し、migration/RLS変更を要する場合は勝手に追加せずSTOP with CHANGES REQUIRED」と定めている。よってsource変更・schema追加・migration適用へ進まず停止した。これは今回のPRによるproduction破損の証拠ではなく、既存schema prerequisite未成立の検出。

### Existing source candidate（適用提案/承認ではない）

指定headに `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql` が既にあることを必要最小限確認した:
- source上のCREATE TABLE定義あり。
- source上 `updated_at timestamptz NOT NULL DEFAULT now()` とtouch trigger記載あり。

**source候補の存在をproduction適用済みと読み替えない**。このH2でそのmigrationの安全性を全レビューしたわけではない。migration history修復・db push・適用、新migration作成、RLS追加はすべて0。

### Startup / isolation / source freshness

- PROJECT_RULES / AGENTS / HANDOFF / ORCHESTRATION / CURRENT_STATE / ACTIVE_TASK / 最新H2 TASK、G3 current TASK/Reportを確認。
- 正式repo `/Users/yuya/Developer/kabumori` はmainで多数の既存dirty changesを確認し、それには一切操作していない。
- H2専用checkout `/private/tmp/h2-pr78-review.bZPBQe/repo` を新規作成し、指定PR headへdetached checkout。worktree/status clean。H1のPR #76 checkout/branch/filesには触れていない。
- fresh GitHub mainをfetch。PR merge-baseからmainまで、PRの11 source/test paths overlapは0。
- GitHub APIのbase.shaは移動するmain側refなので、diff検証には実merge-baseを使用。PR deltaはTASKどおり11 files、2661 additions / 115 deletions。別mainの.agent変更をPR source変更と混同していない。
- `git diff --check <merge-base> HEAD`: PASS。

### Review gatesの進捗（未検証をPASSにしない）

| Gate | 結果 |
| --- | --- |
| A Auth/tenant isolation | **未完了**。Auth server GET、caller JWTのREST headers、owner/profile read周辺を部分確認したが、handler/adversarial全体未検証。owner-only妥当性/duplicate membership等も最終判定しない。 |
| B request/history integrity | **未完了**。request allowlist/message/history boundsをsource上で部分確認。forged history/injection実証は未実施。 |
| C provider/structured trust | **未完了**。契約sourceの一部を読んだだけで、server/client validator・partial output・nested controlsを独立実証していない。 |
| D no implicit persistence | **未完了**。table依存のrepository save pathを確認したが、screen/confirmation全経路を独立検証していない。 |
| E live CAS/schema | **BLOCKED**。production table不存在。 |
| 24:00 narrowing | **未検証**。live DB constraintがないためserver/DB整合のPASSを出さない。 |
| F history-learning no-X boundary | **未完了**。G3申告をレビュー済みと扱わない。 |
| G cost/abuse | **未完了**。G3はper-request boundsのみ・per-user quotaなしと申告。public enablement前の制限要否はC2/再レビューで別判断。 |
| H verify_jwt/deploy config | **未完了**。[official docs](https://supabase.com/docs/guides/functions/auth-headers)のdefault verify_jwt ONと実project/repo deploy truthを区別し、今回のconfig安全判定は出していない。 |

### Tests / adversarial checks

- exact PR head / merge-base-to-main overlap / clean checkout / diff check: **確認済みPASS**。
- live schema/catalog SELECT: **成功、table不存在を確認**。
- targeted Edge tests / Deno check-lint / social-mobile全test / app typecheck-lint / shared regressions / mutation-adversarial / full secret scan: **NOT RUN**。必須schema停止条件でレビューを打ち切ったため。
- G3 Reportの153/153 app、196/196 Deno、26 Edge等は**申告履歴**であり、このH2で再実行・受入れした証拠ではない。
- failing test: なし（testを実行していない）。阻害理由はread-only production catalogに基づくschema欠落であり、test結果を作っていない。

### Exact next action / remaining issues

C2がschema前提の扱いを決める。既存content-settings candidateを別のDB review/apply承認対象にするか、承認済み非production schemaで先にfull reviewを進めるかを明示する。**今回のH2から自動的に本番migration適用へ移らない**。

必要なschemaを整える別承認/工程の後、production relation/columns/RLS/grants/updated_at triggerをread-backし、CASの実効性（全既存writersを含む）を検証。その後、同じexact PR headまたは新しく指定されたheadの残るA〜H/adversarial/testsを完了してからmerge/deploy可否を判断する。
DB前提が解決しても、未検証のAI/Auth/security gatesまでPASS扱いしない。推薦モデル：**Sol（高）**。

### Safety / sync

- production reads: **catalog-only 1 query / READ ONLY transaction**。利用者データSELECTなし。
- production INSERT/UPDATE/DELETE / migration / RLS/RPC/grant / backfill: **0**。
- merge / Edge deploy / live paid AI / X API/history/upload/post / Push / Auth/OAuth/Vault操作 / Cron/settings変更: **0**。
- source/test fix: **0**。正式repoの既存未commit変更への変更・削除・stage・commit・stash・reset: **0**。
- H1/G3/G4/他workstream、apps/admin、HANDOFF/root package/env変更: **0**。
- secret/JWT/user id/email/会話本文のReport露出: **0**。
- この停止ReportとH2 TASKだけをGitHub mainへ同期し、read-back確認する。publication commitはGitHub file historyとH2完了応答で識別する。過去Report/TASKは保持。
- review_required / next_owner: chatgpt。STOP for C2。

---

## H2 — Common-account PR #70 production前ゲート — 2026-10-02 JST

- task_id: common-account-pr70-preproduction-gate-20261002
- result: **PARTIAL / mandatory real-Supabase proof BLOCKED（operator prerequisite）**。
- source_merge_status: **PASS / merged**。source受入れとproduction適用可否は別判定。
- migration_apply_readiness: **HOLD**。actual disposable Supabase proofが未実施で、production Data API exposureも未証明。
- backfill_readiness: **HOLD**。read-only試算は完了したが、migration未適用・managed proof未実施・別途backfill明示承認が必要。
- next_owner: chatgpt / **C2待ち**。production apply/backfill/deployは今回一切許可されていない。
- exact_reviewed_main: 独立checkout/test時 `416de8fdac6a6f4c37740536759e0b09b96c81f4`。同期直前fresh GitHub main / FETCH_HEAD `e39b42f732a00c0dceb8e6f2542a83cc350b999e`。
- merged_target: `44121914b035e22380a4ca1bd8252a42713a2bbf`。
- accepted_source_head: `aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65`。
- implementation_commit: **新規なし**。上記accepted sourceがmerge済みで、H2によるsource修正なし。
- changed_files: **.agent/CODEX_REPORT_2.md / .agent/tasks/CODEX_TASK_2.md の完了記録のみ**。既存Report/TASK履歴は保持。
- deploy: 0。production mutation: 0。Auth/Storage/OAuth/Vault操作: 0。実X/OpenAI/Push: 0。
- GitHub同期: このH2制御2ファイルだけをmainへ同期し、最新TASK/Reportをread-backする。同期commit SHAはH2完了応答およびGitHub file historyで確認可能（実装commitと混同しない）。

### 判定を分離

| Gate | 判定 | 証拠 / 限界 |
| --- | --- | --- |
| A: merged source integrity | PASS | accepted sourceの8ファイルとfresh mainはbyte-identical。target mergeをancestorとして包含。 |
| B: actual disposable Supabase proof | BLOCKED / NOT RUN | 指定・承認済みの使い捨て実Supabase環境がない。ローカルPG成功をmanaged proofに読み替えない。 |
| C: production read-only preflight | PARTIAL | SQL catalog/型/FK/helper/owner権限/history/既存RLS metadataは整合。PostgREST設定/実API境界は未証明。 |
| D: backfill read-only parity | PASS（aggregate試算のみ） | 5 accounts / 2 Kabumori / 1 X候補。書き込みなし。Phase 0からの人口差分を下記に記録。 |
| E: rollout / rollback | sequencing reviewed | applyとbackfillを別々に承認する順序が必須。managed環境でのrollback/reapplyは未実証。 |
| F: production disposition | HOLD | source merge PASS ≠ migration apply PASS ≠ backfill PASS。 |

### 作業環境・freshness・競合

正式repo `/Users/yuya/Developer/kabumori` はread-onlyでstatus/branch/HEAD確認。既存未commit変更が多数あるため、そのcheckoutを作業に使っていない。ファイル変更/stage/commit/stash/resetはしていない。

H2専用checkout: `/private/tmp/h2-common-account-gate-iZx94E/repo`。正式repoからshared cloneし、fresh GitHub mainのexact SHAへdetached checkout。cloneのoriginはローカル正式repoなので、**それをGitHub正本とは扱わず**、GitHub branches/main readと `git fetch https://github.com/anohi-memories/kabumori.git main` のFETCH_HEADを照合した。同期前にもfresh-checkし、同じH2 task_id/ready/codexとReport blob不変を確認。

最新mainは他slotの.agent記録で進んでいたが、以下8ファイルはaccepted sourceから差分0:
- `docs/common-account/phase1-lifecycle-foundation.md`
- `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql`
- `supabase/tests/common_account_lifecycle_behavior.sql`
- `supabase/tests/common_account_lifecycle_fixture.sql`
- `supabase/tests/common_account_lifecycle_mutations.sh`
- `supabase/tests/common_account_lifecycle_rollback.sql`
- `supabase/tests/common_account_lifecycle_run.sh`
- `supabase/tests/migration_source_invariants_test.ts`

G3 AI consultation / G4 publish toggleはcommon-account、migration、削除境界への変更禁止で対象非競合。G2は別market-report-analysis品質調整。open PR #41/#33/#11/#10/#3のchanged pathsにも対象8ファイルのoverlapなし。未mergeの別migration/認証作業はこのH2で適用・mergeしない。CURRENT_STATE/ACTIVE_TASK/他slot TASKは更新しない。

### Gate A — source責任境界

- migrationはadditive lifecycle/readiness foundation。既存Auth/Storage/Vault/providerのdestructive SQLなし。`DELETE FROM auth.users` はmigrationにない（隔離fixture/testの模擬Auth cascadeは別物）。
- 5新テーブルはRLS ON。publicの2テーブルはauthenticatedの本人SELECTのみ、SELECT対象columnも限定。client writeなし、service_role直接table grantなし、backendは指定RPCのみ。
- 33新関数はSECURITY DEFINER / empty search_path / schema-qualified。transaction内でdefault EXECUTEをrevokeし、public RPCは目的別にexact roleへgrant。private helperはownerのみ。
- Phase 1はshadow only、enforcing modeなし。observerはmanaged login cleanupを代行しない。`ready_for_managed_auth_delete` はAuth削除完了ではない。
- accepted fix: Auth rowが残ったままcommon application rowを直接DELETEすると23503で拒否し、login_removedを誤記録しない。Auth cascadeの模擬経路はshadow/unverified observationのまま。
- readinessはlifecycle_version / requirement_epoch / exact required-checkpoint setへbound。built-in checkpoint意味の改変・entitlement owner/service transferは拒否。
- **既存Kabumori legacy hard-deleteは未変更でunsafeのまま**。Phase 1のmerge/applyだけでは安全にならない。X legacy sagaも自動的にcommon lifecycleへ移行しない。
- admin/foreign workspace/Apple identity/Storage等の未接続producerはfresh evaluationでのみ再確認される。すべてのwriter/deletion routeの統合前にenforceへ進めない。
- checkpointはbackendのattestationであり、実際のsession/provider/Storage cleanupがDBだけで証明されたものではない。prepareと外部Auth Admin API deleteはatomicではない。

### Gate B — 実Supabaseは未証明

read-onlyのproject/branch inventoryではproduction `stock-x-autopost` と別の既存projectだけが確認でき、productionのbranchはdefault/mainのみ。**別既存projectを使い捨て環境と推測せず、勝手なproject作成/課金resource作成/破壊テストもしていない**。

したがって以下はすべて実SupabaseではNOT RUN:
- single migration apply / real role owner behavior
- public/private Data API exposure、PostgREST RPC / SQLSTATE/error mapping
- anon/authenticated本人SELECT・他人非露出・client write denial
- service_role直接table grant denialとRPC-only path
- GoTrue/Auth Admin API deleteでのobserver発火、direct application-row delete refusal
- managed auth.identities / sessions / refresh token / stale JWT境界
- Storage API cleanup / owner_idとbucket compatibilityの実動作
- rollback/reapply
- provider OAuth（今回実OAuthを行う計画もなし）

ローカルPGのrole/fixture/SQL `auth.users` deleteはGoTrue・Storage・PostgRESTの代替証明にはならない。特にproductionの `supabase_auth_admin` はnonsuperuser / non-BYPASSRLSであり、実managed runtimeがtriggerをどう実行するかはNOT RUN。

### Gate C — production SELECT/catalog preflight

project `wsmznyzcvmuitkglfeuj` へ `BEGIN TRANSACTION READ ONLY` のSELECT/catalog queryのみ。DO/DDL/INSERT/UPDATE/DELETE/migration/RPC mutationは行っていない。PIIやtokenを取得・Reportへ出していない。

catalog結果:
- required 17 tables: 全存在。
- source-derived 26 exact column/type checks: mismatch 0。
- source-derived 14 exact FK checks: mismatch 0（referencing/referenced columns、型、delete action、validated、nondeferrableを含む）。
- profilesへぶら下がるnon-CASCADE FK: 0。
- private schema / anon / authenticated / service_role: 存在。
- required helper 2件: `social_mobile_account_deletion_workspace(uuid)` / `social_mobile_account_deletion_subject(uuid)`、return text、owner postgres、immutable SQL、SECURITY INVOKER、empty search_path。client/service_role EXECUTEなし、postgres EXECUTEあり。既存pure helper定義も整合。
- target新table/view/function/index name collision: 0。
- target migration `20261001150000`: migration history未記録。current max history version `20260930090000`。
- auth.users/identities PK(id)、profiles PK(id)、admin_users PK(user_id)、brand_memberships PK(brand_id,user_id)、brands PK(id)等をcatalog確認。必要な17テーブルすべて既存RLS ON / FORCE RLS OFF。
- profiles/activity tablesはowner-self authenticated policy、admin_usersはself SELECT、workspace系はmember/self SELECT。OAuth-state/tombstoneテーブルにはclient policyなし。これはmetadata確認であり実JWT/RLS behavior testではない。
- 計画上のmigration owner postgresはnonsuperuser/BYPASSRLS、必要Auth/Storage/legacy SELECT権限あり、auth.users SELECT/UPDATE（locking）、profiles INSERT/DELETE権限あり。新SECURITY DEFINER関数のmanaged環境実行は未証明。
- managed shape: storage.objects/buckets owner_id:text、legacy owner:uuid、objects.bucket_id:text。auth.identities.user_id:uuid/provider:text、sessions.user_id:uuid、refresh_tokens.user_id:varchar/session_id:uuid。users→identities/sessions CASCADE、sessions→refresh_tokens CASCADEが確認でき、owner_id→auth.users FKはない。
- SQL `current_setting('pgrst.db_schemas',true)` はnull、catalog上のexplicit pgrst.db_schemas configは空。**これをprivate schema非露出/安全の証明にはしない**。API gateway/service設定はこのSQL観測で確定できず、actual Data API exposure判定は未証明。
- deletion関連Function metadataだけread-only確認: account-delete v10 ACTIVE / verify_jwt=true、social-mobile-account-delete v5 ACTIVE / true。H2のdeployは0。

結論: **migration自身のSQL preflightに必要なcatalog条件はPASS**。しかし「実Supabase適用/managed role/API境界までPASS」とはしない。

### Gate D — readonly backfill parity / Phase 0差分

候補viewの既存Auth/legacy SELECTとpure helperをそのまま使い、新table未適用分のみtyped empty CTEで代替してaggregateした。未適用RPCを作成・呼出しせず、個人単位ID/email/handleは出力していない。`applied=false`。

| Aggregate | 今回 | Phase 0 |
| --- | ---: | ---: |
| Auth users / common_accounts would-create | 5 | 4 |
| Kabumori candidate / entitlement would-create | 2 | 2 |
| Kabumori activity | 1 | 1 |
| Kabumori profile-only | 1 | 1 |
| X candidate / entitlement would-create | 1 | 1 |
| X identity_verified | 1 | 1 |
| X workspace_pending | 0 | 0 |
| Auth-only（consumer entitlement candidateなし） | 2 | 1 |
| dual-service | 0 | 0 |
| admin_users | 1 | 1 |
| profile-only + Auth-only manual review | 3 | 2 |

その他今回aggregate:
- admin exclusion: 1（adminでもcommon account対象。X consumer entitlementには入れない）。
- excluded non-self-service memberships: 0。
- multiple-owner workspace / orphan user-facing workspace / unexpected derived ownership: すべて0。

Phase 0からAuth-only候補が1件増えたためaccount/manual-review countsが各1増。Kabumori/X判定は変化なし。「Auth-only」はview上のconsumer candidateなしの分類で、admin-excludedなloginも入り得る。用途を勝手に推測しない。profile-only1件とAuth-only2件は operator確認対象。email-based mergeなし。
これらは単一read-only snapshotのwould-create countsであり、actual backfill成功・将来のcounts固定を保証しない。適用承認時には必ずfresh dry-runを再実行する。

### Gate E — 必須rollout順序 / rollback

source docs §15の「dry-run後apply」は、**今回TASKのより厳格な承認境界で補完**する。docsを勝手に書き換えず、本番runbookは次を満たす必要がある。

1. operatorが使い捨て実Supabase環境を指定・明示承認し、Gate B全部を証明。
2. C2で証拠を受け入れ、production fresh origin/main/競合/catalog/history/API configを再確認。
3. **single migrationだけのproduction apply明示承認**を取得。`supabase db push` / history repairは禁止。
4. exact source1ファイルをapply後、tables/columns/FKs/constraints/trigger/owner/grants/RLS/33関数ACL/search_path、shadow/not_started/epoch1、built-in registry、新account/operationが空をread-back。
5. 実installed backfill(false) dry-runとPhase 0/今回試算をparity確認。manual-review/unknown populationをoperator確認。
6. **migration applyとは別のbackfill apply明示承認**を取得してからbackfill(true)。counts/state/idempotencyをread-back。
7. Phase 2 registration/creators/既存writersを統合。
8. Phase 3 deletion adapters + Auth/Storage/session/provider orchestratorを別レビュー・検証。
9. producerを完全に統合し、managed proofと明示承認を経て初めて新migrationでenforcementを検討。

rollbackはintegration開始前で、exact shadow / not_started / built-in registry intact、operationは完了済みを含め0、non-active account0、self-registered entitlement0、依存0を肯定的に確認したときだけ。one transaction / DROPなしCASCADE / refusal時partial teardownなし。local suiteで10拒否case・exact baseline restoreを再確認した。ただしdynamic/client依存をPG catalogだけでは検知できないので、運用統合なしのoperator確認も必要。managed Supabase rollback/reapply proofはNOT RUN。

### 独立test rerun

H2専用PostgreSQL 17.11 / Unix socket only / fake data。non-superuser fixture ownerで実施。既存sourceを改変していない。

| 検証 | 結果 |
| --- | --- |
| common_account_lifecycle_run.sh | **20 PASS markers / exit 0**。exact preflight8 drift、behavior、14二者race、isolation/no-deadlock、rollback10 refusal + exact restore/reapplyを含む。 |
| common_account_lifecycle_mutations.sh（CAL_JOBS=4） | **46/46 DETECTED / exit 0**。各mutantは意図したnamed failureで検知。 |
| social_mobile_account_deletion_run.sh | **8 PASS markers / exit 0**。behavior/acquire/reconnect/onboarding両順序/isolation/no-deadlock/cleanup。 |
| deno test --no-config --allow-read supabase/tests/migration_source_invariants_test.ts | **10/10 PASS**。 |
| 3 shell runner bash -n / invariants deno lint | PASS。 |
| git diff --check / accepted8 files integrity / target ancestry | PASS。 |

operator/harnessメモ: 初回local initdbはsandbox shared-memory permissionで起動前に失敗し、許可されたH2専用local操作として起動し直した。削除回帰の初回commandはCAL_変数を渡したためDEL_PGHOST requiredでfixture実行前に拒否されたが、正しいDEL_変数で8/8通過した。code/test修正や本番への切替はなし。
完了時、test DBはすべてcleanupされpostgres/template0/template1だけであること確認。H2所有local clusterのみ停止済み。独立checkout clean。

### Unresolved prerequisites / exact next operator action

**本番適用には進めない。** C2はsource PASSを維持しつつ、Gate B/C未証明とmanual-review3件を受け取る。

次の1手: **利用許可のあるdisposable非production Supabase project/sandboxを指定し、その環境だけにfake users/Storage fixture、migration apply、Auth Admin API deletion、Data API/RLS/ACL、rollback/reapplyを実施する明示承認を出す**。現在の別既存project/productionを流用しない。新project作成が必要なら課金を含め別承認を先に受ける。secretは安全な環境/connectorに設定し、チャットへ貼らない。real provider OAuthは不要。
その後C2で再ゲートし、production migration適用とbackfill適用を別々に判断する。推薦モデル：**Sol（極高）**。

### Safety checks

- production INSERT/UPDATE/DELETE / migration apply / backfill: **0**。
- deploy / Cron / flag / provider/settings変更: **0**。
- real Auth create/update/delete / identity link-unlink / Storage write-delete / OAuth revoke / Vault mutation-read-secret: **0**。
- production business/Edge Function手動実行 / X/OpenAI/Push: **0**（Supabase SELECT/catalog read-only connectorは実施）。
- code・apps/admin・HANDOFF.md・root package/env・他slotファイル変更: **0**。
- formal repo既存未commit変更へのH2変更/stage/commit/stash/reset: **0**。
- PII/raw user id/email/handle/token/secret Report露出: **0**。
- 全既存Report/TASK履歴を保持。review_required / next_owner: chatgptでSTOP for C2。

---

## H2 — AI Lab topic-deduplication PR #66 focused review — 2026-10-01

- task_id: x-ai-lab-pr66-topic-dedup-review-20261001
- result / verdict: **PASS**. Source review and requested regression checks support merging PR #66; no source edits, merge, or deploy were performed.
- reviewed_head: PR #66 exact head 4f692e4d805ccd3ee628058bb20ee6c1f62cdd6d; open, GitHub mergeable=true, Netlify preview and Vercel status both success.
- fresh_main_at_report: 040ca2919bb42db7499c08aa59325b3a388607ef. PR base was 2d2d044bcce5804cfdd3b7f64e25b66e45db16fd; inspected the 22 main commits since that base. None touched the PR's seven source paths. Current PR head remains unchanged.
- changed_files_reviewed: all seven task-scoped files: ai_lab_brand_post_store.ts, ai_lab_dev_diary_context.ts, ai_lab_scheduled_brand_post.ts, ai_lab_theme_guard.ts, ai_lab_topic_dedup_test.ts, brand_post_generator.ts, and x-test-post/index.ts.
- findings: none blocking within scope.
- root_cause_and_rotation: production entry uses deterministic rotation over sanitized, fresh diary units before evergreen; concrete changed/difficulty/decision facts are carried in every seed; generic angle candidates are excluded with reason codes; balance/interleave avoids adjacent same-entry selections when multiple entries exist. The 200-shape randomized cyclic test passed. A single-entry diary truthfully cycles distinct cuts and does not fabricate a new event.
- counter: countAiLabBrandPostsBefore performs one read-only GET scoped by brand_id=ai_salaryman_lab, post_type=brand_post, and strict scheduled_for < current; it reads PostgREST exact count from content-range. HTTP/parse/network failure returns null and invokes deterministic scheduled-hour fallback without blocking. No unrelated brand/type rows affect the exact query.
- guard/retry: exactly three total generation attempts (initial plus at most two content-only retries); rejected drafts are held out of publish/completion, while generator/transport errors are not automatically retried. After a passing draft, brand/type, character count, cross-brand duplicate and final pre-publish guards remain in sequence. Retry instructions contain reason categories, not rejected draft text. Generic-theme and opener checks are scoped to AI Lab.
- cross_brand: omitted/empty extraInstructions adds no prompt lines; only the AI Lab dispatcher supplies new lines. Runtime brand/type checks remain in place. No neutral/Kabumori/Mio voice, hashtag, scheduling, OAuth/Vault, DB/RPC/migration, Cron, or X API behavior changed.
- tests:
  - deno test -A --no-check supabase/functions/_shared/brand/ai_lab_topic_dedup_test.ts: **24 passed / 0 failed**.
  - related diary/scheduled/store/generator/dispatch-guard tests: **55 passed / 0 failed**.
  - deno test -A --no-check supabase/functions: **2337 passed / 0 failed**.
  - deno check on the five changed shared runtime modules: **pass**.
  - deno check supabase/functions/x-test-post/index.ts: six existing type errors in OAuth/image/morning-lane code. The same check at PR base 2d2d044 produced the same six diagnostics; no new AI Lab diagnostic was introduced.
  - git diff --check 2d2d044..4f692e4: **pass**.
- known_limitations: published body text is not persisted, so true semantic comparison with actual recent AI Lab posts is unavailable; current guard is bounded regex-theme/opener detection plus rotation, not semantic comparison over persisted history. One fresh diary entry can only rotate distinct cuts. Diary edits can reorder rotation; on counter-read failure, scheduled-hour fallback assumes AI Lab schedule slots do not collide within an hour.
- merge_deploy_safety: **safe to merge** based on exact reviewed head, requested tests, current mergeable status, and no overlapping main-side source paths. After merge, only x-test-post needs a separately controlled redeploy; no deploy was requested/performed here.
- changed_by_H2: .agent/CODEX_REPORT_2.md and .agent/tasks/CODEX_TASK_2.md only. PR source files unchanged.
- production_mutation: **0**. Merge **0**, deploy **0**, real X/API calls **0**, DB/schema/RPC/migration **0**, Cron/settings/OAuth/Vault changes **0**.
- safety_checks: local fixtures/stubs only; no production invocation, real X post, database write, or external AI generation.
- next_recommendation: C2 may close the review. Treat the semantic-history limitation as a separate future task if true recent-post comparison is required.

---
## H2 — AI Lab development-diary PR #61 final acceptance review — 2026-09-30

- task_id: `x-ai-salaryman-dev-diary-pr61-final-acceptance-20260930`
- result / verdict: **PASS**. Strict calendar validation closes the final finding; PR #61 is safe to merge and later deploy from the reviewed source. H2 did not merge or deploy.
- reviewed_head: PR #61 exact head `67ee04b41e37553885d43f4630628d135061cbf8`; open, GitHub mergeable=true. Fresh main SHA: `75383d6ebc36066247d37ac005c5fdc30e9aa685`; PR is 3 commits ahead / 5 behind. Main changes since merge-base have no overlap with the PR's 10 source paths.
- prior_blockers:
  - runtime Markdown packaging: **RESOLVED**. Runtime uses the ordinary import graph to load the generated snapshot; no runtime filesystem/static-asset dependency. Current-head canonical Markdown and snapshot were independently parsed and found byte-identical (2,068 characters); parity test remains.
  - hashtag scope: **RESOLVED**. Only AI Lab opts into its own hashtag voice policy. Neutral social-mobile retains the prior no-hashtag instruction; the fixed-hashtag branch remains unchanged.
  - impossible calendar dates: **RESOLVED**. `isValidCalendarDate` checks YYYY-MM-DD format and UTC year/month/day round-trip before an entry can survive sanitization. Impossible entries are excluded before freshness/topic selection and fall back to evergreen.
- date_validation_tests: current head explicitly rejects `2026-09-31`, non-leap `2026-02-29`, out-of-range months/days and malformed shapes; accepts leap day `2028-02-29` and valid month-end dates; verifies impossible dates are dropped by sanitization and selection falls back to evergreen. The selector integration test uses `2026-09-31` against `2026-09-30`, but the independent sanitizer assertion directly catches the former shape-only bug.
- safety_and_scope: AI Lab scheduled `brand_post` branch still selects the diary/evergreen topic and passes it as `topicSeed`. Snapshot parity passed; the committed diary has no matches for the sanitizer's URL/email/token/JWT/branch/task/commit/PR/schema denylist patterns. No G3/Auth/account-deletion, DB/RLS/RPC, migration, or credential files are in the PR diff. No other brand's hashtag behavior changed.
- changed_files_by_H2: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md` only. PR source unchanged.
- tests: G4 Report at this head records `ai_lab_dev_diary_context_test.ts` **29/29**, profile **7/7**, generator **13/13**, scheduled AI Lab **8/8**, shared brand suite **119/119** under Deno; changed-file `deno check`, `git diff --check`, and secret scan PASS. H2 independently counted current source test declarations: 29 / 7 / 13 / 8, coherent with the focused report. H2 did not rerun the test executables. GitHub combined status: Netlify preview success; Vercel preview failed only on build rate limit; no PR-triggered GitHub Actions runs were returned.
- merge_deploy_safety: **PASS for merge and subsequent separately controlled deploy** based on reviewed source, clean task scope, and GitHub mergeability. The Vercel preview rate limit is not treated as a code blocker under current repository policy. No merge/deploy was performed or authorized by this review.
- implementation_commit: G4 reports date-validation fix at PR head `67ee04b`; H2 made no source commit.
- push: H2 review record synchronized to GitHub; only H2 TASK/REPORT changed.
- production_mutation: **0**. Deploy **0**, real X/API **0**, DB/RLS/RPC/migration **0**, Cron/settings **0**.
- remaining_issues: none found within this focused acceptance scope. Test execution results are G4-reported; H2 independently verified current-head test declaration counts, not execution.
- safety_checks: no PR source edit, merge, deploy, production/API call, or unrelated workstream change.
- next_recommendation: C2 may close this H2 review. Any merge/deploy remains a separate operation with its own authorization and preflight.

---

## H2 — AI Lab development-diary PR #61 final focused review — 2026-09-30

- task_id: `x-ai-salaryman-dev-diary-pr61-final-review-20260930`
- result: **FAIL — do not merge/deploy yet.** No source edits, production operations, or PR actions were performed.
- reviewed_head: PR #61 exact head `be146f7bd3cabfb5ae42200ad441b427928d58cf` (open, GitHub mergeable=true). Fresh `main` SHA at review: `0224ff7ed41380749ed677c1dc27942e916fcffb`; PR branch is 2 commits ahead / 16 behind. Main-side changes since merge-base do not overlap the 10 PR source paths, though the PR should be rechecked against main before merge.
- prior_blocker_runtime_packaging: **RESOLVED in source.** Runtime loader imports `ai_lab_dev_diary_context.snapshot.ts` through the ordinary module graph; `ai_lab_dev_diary_context.ts` contains no runtime filesystem/static-asset read. The snapshot is parsed from the reviewed ref and was byte-identical to the canonical Markdown (2,068 characters). The parity test reads the Markdown only in the test process and compares it with the loader result.
- prior_blocker_hashtag_scope: **RESOLVED in source.** `voiceControlsHashtags` is enabled only on the AI Lab profile; neutral `social_mobile_user_v1` keeps the explicit no-hashtag instruction; the fixed-hashtag branch remains first and unchanged. New regression tests cover neutral no-hashtag and fixed-hashtag behavior.
- blocking_finding: `supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts` validates dates with a shape-only `YYYY-MM-DD` regex (line 36 / sanitizer line 68), then constructs `new Date(date + T00:00:00Z)` for freshness (around line 190). Impossible calendar dates such as `2026-09-31` are normalized by JavaScript to a real following date rather than rejected. Near that normalized date, a malformed/stale diary entry can pass the freshness gate and supply a diary topic; if its prose says “today”, this can fabricate current-day progress. The current “malformed date” test covers slash format and non-date text, not an impossible calendar date. Require strict calendar round-trip validation plus a regression proving impossible dates fall back to evergreen before considering merge/deploy.
- wiring_and_scope: `x-test-post/index.ts` selects the topic only inside the guarded AI Lab `brand_post` scheduled branch and passes it as `topicSeed` to `generateBrandPost`; no other brand dispatch path is changed. PR file list is 10 files, all diary context/shared brand generator/profile and the one AI Lab dispatch call site. No G3/Auth/account-deletion, DB/RLS/RPC, migration, or secret-bearing file changes were present.
- sanitizer_safety: the selector sanitizes fields before topic choice and excludes future/stale/no-safe-entry cases to evergreen. The denylist is finite (as the code comments acknowledge), so the Markdown must remain curated public-safe material; it is not a general semantic secret detector. No actual secret was observed in the reviewed diary or snapshot.
- tests: PR description reports earlier results: context 20/20, profile 7/7, generator 12/12, scheduled AI Lab 8/8, shared brand 109/109, isolated checks and diff check PASS. These counts are stale for the reviewed head: source now contains 22 context test declarations and 13 generator test declarations. GitHub combined status has Netlify preview success and Vercel preview failure due build-rate-limit; no PR-triggered GitHub Actions workflow run is available. A clean checkout/test rerun was not possible from this environment, so current-head test pass is **not independently verified**. The parity and cross-brand regression tests themselves were inspected.
- changed_files_by_H2: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md` only. PR source files unchanged.
- implementation_commit: none. H2 correction commit: none.
- push: H2 control-file review record synchronized to GitHub; no source commit/push by H2.
- deploy / real X post / production mutation: **0**.
- remaining_issues: strict impossible-date rejection and regression; current-head test suite needs rerun with updated counts.
- safety_checks: no source edit; no deploy; no real X post/API; no DB/RLS/RPC/Auth/account-deletion changes; no G3 files or credentials touched; no production mutation.
- next_recommendation: return the impossible-date finding and stale/unverified test evidence to G4/ChatGPT for a small source+test correction and current-head rerun, then re-review the new exact PR head. Keep PR #61 unmerged and undeployed.

---

## H2 — AI Lab development-diary PR #61 focused review — 2026-09-30

- task_id: `x-ai-salaryman-dev-diary-pr61-review-20260930`
- result: **FAIL — do not merge/deploy until the runtime asset blocker is resolved.** No code fix was made because the required asset packaging solution is outside the current review-only correction and cannot be proven from the available isolated checkout.
- reviewed_head: PR #61 `385e561fa93dee5eaa6dfc215016f2c79531a53a`; PR remains open. Fresh GitHub comparison: origin/main `229ac6d7cc11d5a3a58b62a84c9a8ab178c7dab1`, PR head is 1 commit ahead / 7 behind. Changed-file list is limited to the 8 files reported by GitHub.
- root_cause: The PR description says scheduled AI Lab posts always used the shared generator's static generic topic because no `topicSeed` was passed. The updated `x-test-post/index.ts` now selects a diary/evergreen seed and passes it to `generateBrandPost`; source inspection confirms this direct wiring.
- blocking_finding:
  - `ai_lab_dev_diary_context.ts` reads an adjacent Markdown file via `node:fs/promises` and `import.meta.url`. The source comment claims the full function directory is automatically bundled, but the PR does not add `supabase/config.toml` (confirmed 404 at the reviewed head) or another asset packaging mechanism.
  - Supabase's official Wasm bundling guide says non-code static assets must be included through `static_files` in `supabase/config.toml`; it also notes static files require the CLI/Docker path and are not deployed via `--use-api`: [Supabase Edge Function static-file bundling](https://supabase.com/docs/guides/functions/wasm).
  - The current catch in the scheduled dispatch converts any read failure to an empty string, so missing runtime asset silently selects evergreen topics. This masks failure and defeats the fresh-diary behavior. The Node/Deno local test that reads the checkout file does not prove deployment packaging/runtime availability.
  - required follow-up: add a supported packaging path for the Markdown (or embed it as code), verify the produced Edge bundle contains it, and exercise the loader under the Supabase Edge runtime. Until then the TASK requirement “canonical Markdown load works in the Supabase Edge runtime” is unproven.
- additional_scope_note:
  - The shared generator's no-fixed-hashtag prompt changed from “do not add a hashtag” to “defer to the profile's voice instructions.” This correctly resolves AI Lab's conflicting `#個人開発` instruction and configured fixed hashtags still use the unchanged branch. It also changes the prompt for `social_mobile_user_v1`, which has no fixed hashtags; the added regression test covers AI Lab and a configured Kabumori hashtag case, but not this no-fixed-hashtag neutral profile. Confirm this broader prompt change is intended or scope it to profiles that declare a hashtag policy.
- other_review:
  - No database/RLS/RPC/Auth/account-deletion changes were present in the PR file list.
  - The diary selector is explicitly wired in the scheduled branch; future-dated entries are rejected and missing/unsafe/stale entries use fixed evergreen seeds rather than claiming a current-day event.
  - Sanitization covers the tested URL/email/token/branch/task/commit/PR/table/RLS/RPC categories. It is a finite pattern denylist, so it should not be described as a universal semantic detector for arbitrary personal/private prose; safety currently also depends on the Markdown being curated public-safe material.
  - Cross-brand fixed-hashtag behavior is preserved by the branch condition, but the no-fixed-hashtag profile note above remains.
- tests:
  - PR description reports: diary context 20/20; brand profiles 7/7; generator 12/12; scheduled brand tests 8/8; shared brand suite 109/109; `git diff --check` clean; changed-file isolated `deno check` clean. These numbers were reported by the PR author, not independently rerun in this review.
  - GitHub combined commit status currently shows Vercel and Netlify deploy-preview success only; it does not provide independent test results.
  - Independent checkout/test attempt was blocked: GitHub DNS resolution failed when cloning into a new disposable `/private/tmp` checkout. No retry workaround was attempted. Review proceeded from GitHub's exact PR head files/patches and official Supabase docs.
- changed_files: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md` only for this review record; PR source unchanged.
- implementation_commit: none; fixes none.
- push: H2 control-file synchronization only; no PR source commit/push.
- deploy: 0. Real X post/API: 0. Production mutation: 0.
- remaining_issues: Resolve static asset packaging/runtime proof; decide whether no-fixed-hashtag behavior should affect the neutral social-mobile profile; independently run tests from a clean checkout when network access returns.
- safety_checks: no production deploy or invocation; no database/RLS/RPC/Auth/account-deletion changes; no X/API calls; no source changes; no other slot files touched.
- next_recommendation: Keep PR #61 blocked from merge/deploy until the Markdown runtime asset is demonstrably bundled and readable. Re-review the exact updated head and verify the neutral profile's hashtag behavior after the bounded follow-up.

---

## H2 — Account deletion production Stage 1 independent verification — 2026-09-29

- task_id: `x-social-mobile-account-deletion-prod-stage1-verification-20260929`
- result / verdict: **FAIL / STOP at the unrelated-production-change verification gate. All target checks performed PASS; no deletion-source defect was identified.**
- status: `review_required`; next_owner: `chatgpt`.
- accepted_source_merge: `136dcd2b35b161ccc4769da15b05e796f095e881` (accepted PR #52 head `4bc819555c07c8792f5b78ea29aa6b9a35694042`).
- fresh_origin_main_at_start: `d79b0c8524af56cc56c5245f5037517fc689d917`; final report preparation base: `bb575627c6cf0e01da3c2b694822b9a2ef256435`. Intervening main changes did not touch H2's controls or the accepted deletion source.
- independent_worktree: `/private/tmp/kabumori-h2-account-deletion-report-20260929`, H2-owned branch `codex/h2-account-deletion-report-20260929`. Only this previously clean H2 checkout was fast-forwarded. Formal shared checkout and other worktrees were not edited.
- changed_files: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md` only. Source fixes / implementation commits: **0**.
- report_commit_hash: `6c9f680be8548ca65c01b029937be952cf0199c7` (H2 TASK/REPORT only). Push: **SUCCESS**, normal fast-forward to origin/main. Fresh remote read-back confirmed this commit's inclusion, this task_id at the Report head and TASK `review_required / next_owner: chatgpt`. This delivery acknowledgement changes only the H2 Report; no source commit, merge or deploy by H2.
- production_mutation_by_H2: **0**.

### A — Migration production identity / RPC protection (sanitized)

- Exact file: `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`.
- Independently recomputed SHA-256: `7481078f91e87447216a2ae93e0c12b78ce6a68801205f4fdd74bb9bd6588657`, matching the approved value. There is no source delta from the accepted merge in this migration or deletion Edge directory.
- Read-only production catalog read-back: **21/21** function names, signatures, body hashes and definer/invoker modes match the accepted file. Expected owner and empty search_path are preserved. Client execution is denied; intended service execution surface matches exactly. No unexpected overload/collision was found. Privilege detail and unrelated security observations are intentionally not published.
- Both state/audit tables retain the reviewed columns, validated checks/keys, RLS and direct-access protection; no unexpected trigger/FK on these tables was present.
- All **11/11** expected BEFORE INSERT OR UPDATE, FOR EACH ROW guards are enabled and call the reviewed guard function. Their definitions match the accepted structure.
- READ COMMITTED remains the default/current isolation, with no incompatible database/role or relevant function override. Catalog inspection finds only the reviewed onboarding RPC as the workspace creator. All three existing onboarding RPC body hashes match the repository and runbook; no body change was caused by this migration.
- State/audit aggregate counts before and after non-destructive smoke: **0 / 0**.
- Migration-history version `20260928160000` remains **unrecorded (0 rows)**. This is the runbook's known consequence of exact direct SQL application, not evidence that the objects were absent. No history repair, reconcile, rollback or migration operation was performed by H2.

### B — Edge production identity

- `social-mobile-account-delete`: **version 1 / ACTIVE / verify_jwt=true**.
- Production updated_at: **2026-09-29T13:05:33.691Z** (22:05:33.691 JST).
- Retrieved runtime source through Supabase's read-only get-edge-function API. Exactly **4/4** files match the accepted repository source by SHA-256 over the returned source bytes: `index.ts`, `http.ts`, `delete_logic.ts`, `apple_revoke.ts`. No test/extra source files were included.
- The exact source has no console/logger calls. Fixed error responses do not echo raw RPC/provider errors or credentials. Caller identity is revalidated before the deletion flow, and no caller-supplied user ID is trusted.
- Production configuration **names only** were checked: Apple revocation configuration is absent; the accepted source keeps that path fail-closed. No configuration values/digests were output. Required existing X configuration was present; X was not contacted.
- Deletion Function metadata remained unchanged across H2 verification. Other Function metadata was compared independently; the single parallel change below triggered STOP.

### C — Independently repeated non-destructive HTTP smoke

Only a public legacy anon JWT, validated as an anon/non-user credential for the exact project, was used where needed. No user session token, service-role bearer or authenticated user deletion request was sent. Keys/Authorization headers/raw request or response bodies were not printed or persisted. Each case was attempted once, retry **0**.

| case | observed | verdict |
| --- | --- | --- |
| OPTIONS/CORS preflight | 204; expected origin/headers/methods | PASS |
| POST without Authorization | 401 at gateway | PASS |
| POST with malformed JWT | 401 at gateway | PASS |
| unauthenticated preview | 401 `AUTH_REQUIRED` | PASS |
| unauthenticated delete | 401 `AUTH_REQUIRED` | PASS |
| invalid action | 400 `ACTION_REQUIRED` | PASS |
| GET | 405 `METHOD_NOT_ALLOWED` | PASS |

- Smoke: **7/7 PASS**. Valid-user requests **0**. State/audit remained **0/0** afterward; no deletion lifecycle started.
- No regression suite was rerun: this is production read-back/HTTP verification, with no source change. The earlier exact-source checked-Deno/concurrency proofs remain historical evidence, not newly claimed test executions. Control-file `git diff --check` and staged diff check: **PASS**.

### D — STOP finding / production mutation audit / evidence limits

- Independent metadata snapshot detected one unrelated Function change during H2 verification:
  - `market-report-data-packet`: **v11 -> v12**.
  - before updated_at: `2026-09-17T05:43:45.492Z`.
  - after updated_at: `2026-09-29T13:23:18.972Z` (22:23:18.972 JST).
- This timestamp is **after** the deletion Function's Stage 1 deploy. H1 TASK separately authorizes that exact Function's controlled rollout. Its completion evidence was absent at the initial `f04d392` follow-up check, then arrived at fresh origin/main `bb57562` while H2 prepared this Report. The appended H1 Report records the exact matching **v12 / 22:23:18.972 JST** as its one authorized target deploy, with its own read-back showing all other 18 Functions unchanged. The observed change is therefore reconciled with H1's published delivery evidence, rather than attributed to G3. H2 still does not silently waive the current TASK's explicit unrelated-change STOP gate or perform more production operations.
- Other **18/19** Function records, including the deletion Function, were unchanged across the two snapshots. **No further production queries or HTTP requests were made after the delta was detected.** H2 did not redeploy, revert, fix or investigate H1's implementation.
- G3 Stage 1 Report declares only the accepted single-file migration and the new deletion Function deploy, with no real user/Vault/provider/post/activation operation. Current accepted object identity and zero state/audit rows independently corroborate no deletion lifecycle through this implementation.
- Historical absence of arbitrary Auth/Vault/provider-console operations cannot be independently proven from current catalog/counts alone. G3's before/after operator-held evidence is not included in the public repository; its historical assertions are identified as G3 evidence rather than falsely claimed H2 measurements. No user/Vault plaintext, provider console or real token was inspected by H2.

### E — C2 disposition / Stage 2 readiness / remaining gates

- **Stage 2 readiness: NO until C2 reconciles the observed parallel rollout and accepts a coordinated invariant snapshot.** Target migration/Edge/non-destructive checks performed are green, but the overall no-unrelated-change acceptance gate did not pass. This STOP is not a claim that the deletion implementation is defective.
- Do not repeat apply/deploy or perform a disposable-user deletion merely to clear this result. C2 should accept/reconcile the now-published H1 delivery against this exact delta and decide whether any further bounded read-only check is needed. A new check should explicitly allow the separately owned Function change; it is not automatically required by a deletion-source defect.
- After that acceptance, separately authorize Stage 2 for never-connected, social-only/shared-main-profile retention, X-connected disposable users, lost-response/retry and unrelated-data invariants. None of those destructive/provider E2Es was performed here.
- Apple production configuration and native E2E remain separate gates. Legal URLs/support, audit/history retention decisions, published-X-post wording, Kabumori cross-app deletion coordination and explicit app feature activation remain operator/product gates. No app activation is approved by this verification.
- Supabase/PostgreSQL skills guided current official auth-header docs, changelog, least-privilege and lock/isolation review. This inspection requested no pgcrypto/index maintenance or broader security audit.

### Safety / handoff

- Production DB write/schema/RPC/RLS/migration/history/Vault/Storage/Auth/provider configuration/Cron/settings/secrets/OAuth/activation changes: **0** by H2.
- Deploy, real X/Apple revoke, X post, OpenAI/Push call and valid-user deletion: **0**. Only the explicitly allowed seven non-destructive Function HTTP requests and read-only metadata/catalog/configuration-name checks occurred.
- Source/app/admin/HANDOFF/root package/lock/.env, existing shared uncommitted changes, other slot TASK/Report files and dev servers: **untouched**. CLI-created local ignored/untracked cache is not staged or committed.
- next_recommendation: C2 reconcile the parallel deployment and decide the bounded next verification gate. **STOP for C2; status review_required / next_owner chatgpt.**

---

## H2 — PR #52 Phase 4c final concurrency acceptance — 2026-09-29

- task_id: `x-social-mobile-account-deletion-final-concurrency-acceptance-20260929`
- result / verdict: **PASS for source; source merge ready: YES, subject to C2 acceptance.** The previously reproduced first-onboarding race and checked-Deno typing defect are corrected at the exact reviewed head. This is not production activation approval.
- status: `review_required`; next_owner: `chatgpt`.
- exact_reviewed_head: `4bc819555c07c8792f5b78ea29aa6b9a35694042`; Draft PR #52, branch `claude/g3-account-lifecycle-p4`. Fresh PR fetch and GitHub API read-back at start/end both confirmed the exact OPEN/DRAFT head; base `249df4ce4debd2de21db101fecbe4cd735c56e39`.
- previous_failed_head: `002d24ac99df2fbdf4e2423c1428ccb488a79f29`.
- fresh_origin_main_at_start: `bf260da7f094ca7f66bd8a8cc72c5b864f482506`; final report synchronization base after the other-workstream fresh-check: `38c2bd66f7711a0b5727a4bc862e45fc3071d243` (H2 control files unchanged remotely).
- independent_review_worktree: `/private/tmp/kabumori-h2-account-deletion-final-20260929`; reused only the previous clean H2-owned checkout and fast-forwarded to the exact PR head. Source remains Git-clean, with no H2 source fixes. Managed-worktree tool was unavailable for this mirror chat (Not a git repository); no G3 checkout was used.
- implementation_commit: existing G3 `4bc819555c07c8792f5b78ea29aa6b9a35694042`; H2 implementation commits: **0**.
- changed_files by H2: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md` only, in `/private/tmp/kabumori-h2-account-deletion-report-20260929`.
- report_commit_hash: `00a90f1750836f93d2968ee207bcca2f428f83c4` (H2 Report/TASK only).
- push: **SUCCESS** to origin/main. Fresh remote read-back confirmed this report commit's inclusion, the current task_id/PASS at the Report head and TASK `review_required / next_owner: chatgpt`. This follow-up records only confirmed delivery; final synchronization SHA is in the completion message.
- merge / deploy / production_mutation: **0 / 0 / 0**.

### A/B — Independent two-direction proof, with actual lock-wait observation

Used PostgreSQL **17.11**, an H2-only local Unix-socket cluster at `/private/tmp/kabumori-h2-concurrency-proof.W6NlKH`, fake Auth/Vault data and a **non-superuser** fixture owner. The real, unmodified `begin_social_mobile_x_oauth_connection` RPC was loaded from the existing onboarding and reconnect migrations. No replacement writer, real credential or production fixture was used.

1. **Onboarding first, still uncommitted:** A invokes the real authenticated first-onboarding RPC, reaches its completed creation point, then stays open. B starts service-role deletion acquire. H2 independently queries `pg_stat_activity` and observes B waiting on **Lock/advisory** before letting A commit. B then snapshots the committed new workspace. Credentials → mark-X-revoked(empty set for this never-connected fixture) → purge → finalize run as separate committed service-role calls. Finalize returns `completed`, `login_deleted=true`.
2. **Deletion first:** B acquires deletion inside an open transaction. A invokes real first onboarding. H2 observes A waiting on **Lock/advisory**, then commits B. A fails with `SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS`; its transaction creates no workspace. Using the existing lease, the remaining deletion calls finish with `completed`.
3. After each reported success, independent counts for brands, accounts, memberships, OAuth states (including initiated-by-user), refresh references, tombstones and Auth user are **all 0**. Local `pg_stat_database.deadlocks=0` throughout the independent protocol proof. This verifies the original adverse interleaving, not just a passing reconnect on an already committed workspace.

The existing exact-head runner was also rerun independently and reported all eight markers: BEHAVIOR, ACQUIRE_RACE, RECONNECT_RACE, ONBOARDING_FIRST_RACE(orphan=0), DELETION_FIRST_RACE(orphan=0), ISOLATION_GUARD, NO_DEADLOCK, CLEANUP **PASS**.

### C — Common lock, lock order, isolation and intended RPC boundary

- Shared primitive: `social_mobile_account_deletion_workspace_lock(text)`, a transaction advisory lock on `hashtextextended('social_mobile_workspace:' || derived_workspace, 0)`.
- The BEFORE INSERT guard on `brands` and `brand_memberships` takes it before creation/FK key-share critical points; deletion acquire takes it before its first workspace snapshot/row locks. Lease-holding and operator steps preserve deletion-lock → workspace-lock → row/Auth-lock order. Existing begin/complete OAuth RPC bodies were not changed.
- Both writer guard and mutation-capable outer deletion functions are volatile/default-volatile. Under READ COMMITTED the guard reads the tombstone after its lock wait and acquire reads committed workspace rows after waiting; both actual observations above prove the relevant post-lock visibility.
- Independent **REPEATABLE READ and SERIALIZABLE** first-onboarding probes both fail before workspace creation with `SOCIAL_MOBILE_WORKSPACE_CREATION_REQUIRES_READ_COMMITTED`; workspace rows remain 0. This is a deliberate fail-closed prerequisite, not a silent stale-snapshot acceptance.
- [PostgREST transaction documentation](https://docs.postgrest.org/en/v13/references/transactions.html#isolation-level) confirms READ COMMITTED by default, but role/function overrides can change it. A future rollout must read back the actual authenticated/service RPC isolation settings; no production setting was inspected or changed in this review. [PG17 isolation](https://www.postgresql.org/docs/17/transaction-iso.html) and [advisory locking](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS) were checked. No claim that every unrelated writer is globally deadlock-free is made; the intended two-direction onboarding/deletion protocol is proven without deadlock.

### D — Finalize invariant / negative and mutation evidence

- Under deletion/workspace locks and the Auth row lock, finalize rechecks brands/memberships/accounts/OAuth-state presence before removing login/tombstone.
- An independent fake-only lease-authorized row-reappearance probe returned `operator_required / WORKSPACE_REAPPEARED`; Auth and tombstone remained. Existing full behavior proof makes the same assertion. This is a defensive owner-only fixture, not evidence an authenticated client can forge a lease.
- Four H2-only mutation checks changed **only disposable DB function bodies**, restored the exact candidate bodies afterward and detected:
  1. creator guard's workspace-lock removal;
  2. acquire's workspace-lock removal;
  3. isolation guard removal;
  4. finalize's orphan invariant removal.
- The first two mutations lose the expected committed-workspace snapshot/invariant and fail the independent complete-success assertions; this is not relabeled a real-provider test. Finalize mutation incorrectly accepts the reappeared row and is detected. The unrelated/redundant hold-lock mutation was not required or counted as detected.
- Scratch proof scripts are preserved (`acceptance.sql`, `races.mjs`) under the above H2-only directory. C2 can use this Report directly without opening local artifacts.

### E — Checked Deno and required regressions

- `DENO_NO_PACKAGE_JSON=1 deno test --cached-only --no-lock --allow-read=supabase/functions/social-mobile-account-delete supabase/functions/social-mobile-account-delete/`: **17/17 PASS, type checking enabled**. No `--no-check` was used. The environment flag isolates unrelated root package resolution, not TypeScript checking.
- `DENO_NO_PACKAGE_JSON=1 deno check --cached-only --no-lock supabase/functions/social-mobile-account-delete/*.ts`: **all 7 files PASS**, including tests and entrypoint; TS2353 is gone.
- Social-mobile `npm test`: **72/72 PASS**. Data-view `node --experimental-strip-types --test src/domain/data-view.test.ts`: **14/14 PASS**.
- `npm run typecheck` / `npm run lint`: **PASS**.
- `EXPO_NO_TELEMETRY=1 npx expo export --platform web --platform ios --output-dir <H2 scratch>/expo-export`: **both PASS**. This is bundle proof only, not signed-in real-device QA. No real backend env/secret was supplied.
- Full PR `git diff --check 249df4c..HEAD` and Phase 4c `git diff --check 002d24a..HEAD`: **PASS**. Exact source checkout stays Git-clean; tracked packages unchanged.
- Candidate apply inside BEGIN → read back every candidate RPC's client-denied ACL/empty search_path, SECURITY DEFINER except the pure/internal helpers, service-role-denied lock helper/direct state reads, RLS and all **11** guard triggers → ROLLBACK → object absence: **PASS**. Reapply only in the disposable DB for behavior/race proof. Final ACL read-back: invalid entries **0**, test owner superuser=false.
- Client credential scan found only the existing rejection pattern for service-role/secret input, not a key. Edge console/logger output paths: **0**. Mock tests verify token-free responses and server-derived user identity. Audit fake-data tests remain green.
- Disposable runner DB cleanup PASS; independent `h2_concurrency_proof` DB removed and database count read back **0**; H2-only PG server stopped. Test scripts/export preserved, no material user files deleted.

### Previous accepted boundaries preserved (focused spot-check)

- **R2:** same server-derived scope; scope mismatch rejects; social-only retains Auth/main profile; late profile before finalize preserves login. Full DB behavior proves these.
- **R3:** shared/duplicate/foreign Vault references refuse before revoke; credential fingerprints and purge ownership checks remain unchanged. Full DB proof preserves other-workspace secrets.
- **R4:** verified/connected missing credentials stays operator-required; never-connected has no false required revoke. DB + Edge tests PASS.
- **R5:** durable Apple success checkpoint survives downstream failure; resume does not reuse a consumed code; client drops codes after attempts. DB + Edge/client tests PASS.
- **R6:** OPTIONS/CORS and truthful native-iOS Apple requirements unchanged; HTTP tests PASS.
- **Exact client user/session pin:** switched user or same-user/new session makes no deletion request; full mobile test PASS.
- No additional Edge implementation, auth/users finalize operation, legal wording or cross-product deletion design changed in Phase 4c. Review does not reopen accepted unrelated boundaries.

### C2 disposition / remaining production gates / safety

- **No remaining source blocker found in this focused acceptance.** C2 may accept the exact reviewed head for source merge. H2 performed no merge.
- Production remains unapproved/unactivated. Required later gates: exact single-file migration + owner/privilege/managed Auth/Storage/FK/ACL and isolation read-back; JWT-verification-ON deletion Edge deploy + runtime byte comparison; disposable-account real X/Apple/native/browser E2E and lost-response recovery; Kabumori-side delete coordination; owner/legal retention/support/terms decisions and explicit build activation. Issued JWTs still are not instantly invalidated; previous Report's Auth operational caveats remain applicable.
- Supabase/PostgreSQL skills guided current changelog, isolation, lock-order and privilege verification. Changelog PG17.11 pgcrypto/index warning does not request any production maintenance here; this candidate uses core SHA-256 and no legacy pgcrypto encryption.
- Production reads/writes/schema/migrations/RLS/RPC/Auth/Vault/Storage/Cron/settings/provider console/OAuth changes, deploy, real X/Apple/OpenAI/Push/API calls/posts: **0**. Only GitHub/official-document read requests, isolated fake-only tests and Report/TASK Git synchronization.
- Formal repo existing uncommitted changes, other slot source/control files, apps/admin, HANDOFF, root package/lock/.env/src and user dev servers: **untouched**. Latest other-workstream main advances are fast-forwarded only into the H2 Report checkout, not staged as H2 changes.
- next_recommendation: C2 review this PASS evidence and decide source merge separately from any explicitly approved future production rollout. **STOP for C2.**

---

## H2 — PR #52 Phase 4b final acceptance — 2026-09-29

- task_id: `x-social-mobile-account-deletion-final-acceptance-review-20260929`
- result / verdict: **FAIL — source merge ready: NO.** The old committed-state scenarios are corrected, but an independently reproduced in-flight first-onboarding race still produces a false successful deletion with orphaned social data. Apply/deploy/activation must remain blocked.
- exact_reviewed_head: `002d24ac99df2fbdf4e2423c1428ccb488a79f29`; Draft PR #52, `claude/g3-account-lifecycle-p4`. GitHub API read-back still reported this exact OPEN/DRAFT head.
- previous_failed_head: `12146c4ab2bc635a2781b673146e1f8ad8350258`.
- independent_review_worktree: `/private/tmp/kabumori-h2-account-deletion-final-20260929`; source stayed Git-clean and byte-unchanged. Managed worktree creation returned Not a git repository for this mirror chat; manual creation of a dedicated H2 worktree was the documented fallback. No G3 checkout was reused.
- fresh_origin_main_at_start: `a03fefc771e76f5bb53c5f54968fbffb269a0db8`; report-only synchronization base: `267ed44870304671c47c5af93a30e4d639880501`.
- source_fixes / implementation_commit: **0 / existing G3 head above**. TASK's new-design-issue FAIL/STOP rule was applied; neither the concurrency design nor the test-only typing defect was patched.
- changed_files: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md` only.
- report_commit_hash: `5bd6545582160907371dc1ba5f577b0378a1828b` (H2 Report/TASK only).
- push: **SUCCESS** to origin/main; fresh remote read-back confirmed this report commit is included, the current task_id is at the Report head, and TASK is `review_required / next_owner: chatgpt`. This follow-up only records the confirmed delivery result; its final sync SHA is provided in the completion message.
- deploy / merge / production_mutation: **0 / 0 / 0**.

### Blocking finding — R1 P1: a pre-existing uncommitted first onboarding escapes the tombstone

Relevant exact-head locations in `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql`:
- `:121-123`: the guard only reads a currently visible tombstone; no common lock is taken by this writer guard.
- `:228-230`: blocker returns allowed when the workspace is not visible.
- `:326-360`: acquire takes a deletion-only per-user advisory lock and snapshots visible workspace rows, without first serializing against an in-flight first membership creation.
- `:580-594`: finalize locks the Auth user only after purge, then deletes Auth plus the tombstone without rechecking for workspace rows that became visible while waiting.

Independent fake-only PG17 proof used the **real, unmodified** `begin_social_mobile_x_oauth_connection` RPC from the existing onboarding/reconnect migrations and the exact reviewed deletion migration. No fake replacement of that writer was used:

1. Create only a fake Auth user, with no social workspace and no main-app profile.
2. Connection A: `BEGIN`; set that fake JWT subject; switch to `authenticated`; invoke the real first-onboarding RPC; reset role; keep the transaction uncommitted for four seconds. Its guard checks completed while there was no tombstone. The membership FK holds an Auth key-share lock.
3. After one second, connection B executes deletion acquire, credentials, mark-X-revoked with an empty set, and purge in separate committed calls. A's rows are invisible: snapshot is empty and purge reports success.
4. B invokes finalize. Its late Auth `FOR UPDATE` waits for A. A commits its new workspace/account/OAuth state; B then deletes Auth, which cascades membership but not brands/accounts, and removes the tombstone.
5. Independently observed result:

```json
{"credential_status":"ok","marked":"x_revoked","purged":"purged","login_deleted":"true","remaining_brands":1,"remaining_accounts":1,"remaining_memberships":0,"remaining_tombstones":0}
```

This is a normal first-onboarding writer interleaving, not a forged lease, client secret-reference mutation or production fixture. The Edge interprets the completed finalize response as success, although social workspace/account data remains ownerless. The guard cannot retroactively reject writes whose trigger ran before the tombstone existed. G3's reconnect race tests the **opposite** order (deletion first, already committed existing workspace second), so its passing result does not cover this failure.

Required design correction: serialize deletion **before** its first workspace/credential snapshot against first-onboarding/membership creation, and define consistent lock order plus final invariants. A common per-user/creation lock or suitably early Auth-row locking needs its own two-direction concurrency proof; a late finalize-only lock is insufficient. Do not silently patch this protocol during final acceptance. C2 should return this narrowly scoped R1 failure to G3.

### Additional validation issue — P2: checked Deno tests do not compile

`supabase/functions/social-mobile-account-delete/delete_logic_test.ts:107-115` declares the override tuple as `Partial<DeletionDeps>` but includes the fake-only `providers` field. Default checked `deno test` fails **TS2353** at line 115. The helper itself already accepts `Partial<DeletionDeps> & { providers?: string[] }`; this is a test typing mismatch, not an observed production failure. `--no-check` passes 17/17 and entrypoint `deno check` passes. Do not describe all Deno checking as green. No fix was made after invoking the design STOP rule.

### Focused acceptance matrix

| boundary | result at reviewed head |
| --- | --- |
| R1 | **FAIL overall**: committed snapshot/reconnect and purge/finalize-gap markers now reject; durable lease/re-acquire works; the pre-start uncommitted first-onboarding race above remains unsafe |
| R2 | PASS for tested cross-product cases: server scope, expected-scope mismatch, social_only keeps Auth/profile, late profile before finalize preserves login under Auth-row lock; overall completion remains blocked by R1 |
| R3 | PASS for initial shared/duplicate/foreign-verifier fixtures and ownership checks at credentials/purge; fingerprint checks reject rotation instead of purging unrevoked material |
| R4 | PASS: connected/verified missing material enters operator_required; truly never-connected needs no revoke; Edge never marks missing required material as revoked |
| R5 | PASS for completed checkpoint/resume: Apple revoke followed by purge failure resumes without replaying the consumed code; checkpoint absent requires a code; client discards code after every attempt |
| R6 | PASS: OPTIONS 204 plus required CORS headers, all HTTP responses carry CORS; Apple login deletion on unsupported browser/Android is truthfully labeled native-iOS-required |
| client pin | PASS: exact userId + JWT sessionId; switched user or same-user/new session produces SESSION_CHANGED with zero new deletion requests |

### Guard coverage / posting interaction

- Eleven INSERT/UPDATE triggers were independently read back: brands, brand_memberships, social_accounts, social_account_oauth_states, x_account_refresh_state_v2, x_account_refresh_rollout, scheduled_posts, publish_claims, published_content_fingerprints, post_execution_logs, posting_windows. They enforce exclusion after a visible tombstone and preserve other-user writes; mere table coverage does **not** establish concurrency completeness (R1).
- Existing onboarding begin/complete and credential refresh bodies were inspected only for their interaction. Complete/refresh updates Vault and guarded account/state rows in one DB transaction, so a guard exception rolls back those Vault writes. Current running/publishing/refreshing checks and disabling pending posts are retained.
- Untargeted dependent tables (e.g. brand_settings/report-specific rows) are not silently expanded into purge: NO ACTION FK dependents stop it atomically; daily_content_plans is an intended cascade. Additional guards on unrelated report tables were not added. No dispatcher or other writer was changed.
- Existing lock order differences may produce an aborted transaction under contention rather than a silent bypass for committed rows. No production concurrency/E2E claim is made. The proven first-onboarding false success is the merge blocker.

### Direct auth.users finalization assessment

- Current read-only production catalog: auth.users owner `supabase_auth_admin`; `postgres` has SELECT and DELETE on auth.users and DELETE on vault.secrets; auth.users has no noninternal trigger. Candidate is **not installed**. Thus a postgres-owned definer has the currently needed table capabilities; the actual migration owner must still be pinned/read back on any separately approved rollout.
- Live FK catalog confirms Auth deletion cascades identities, sessions, MFA, OAuth consent/authorization, WebAuthn and profiles/memberships; SCIM is NO ACTION. Main-app profile protection is explicitly rechecked under lock. Unknown dependents block rather than requiring a broad purge.
- Supabase's current official hard-delete handler uses a transaction plus `tx.Destroy(user)`; direct SQL has the same row/FK hard-delete mechanism but does **not** create that handler's Auth audit-log event. This candidate's own successful finalize audit is transactional and pseudonymous. It is not an assertion of complete operational equivalence to every Auth API hook/version.
- Issued JWTs remain valid until expiration; session rows disappear on hard delete, preventing refresh. No instant global JWT invalidation is claimed. The sensitive writer protection is exactly what R1 still fails for the uncommitted first-onboarding case.
- Storage ownership/FK capability and managed-schema drift require exact rollout preflight; no live Auth user, token or Storage owner was read or deleted. See [Supabase user-deletion guidance](https://supabase.com/docs/guides/auth/managing-user-data), [official Auth hard-delete source](https://github.com/supabase/auth/blob/master/internal/api/admin.go).

### Independently executed verification

1. Own-worktree `npm ci --offline --ignore-scripts --no-audit --no-fund`: 821 cached packages; tracked dependency files unchanged.
2. Full social-mobile `npm test`: **72/72 PASS**; data-view **14/14 PASS**; `npm run typecheck` and `npm run lint`: **PASS**.
3. Expo Web + iOS export: **PASS**, output in H2-only scratch, no real backend environment injected. This is bundling proof, not signed-in device QA.
4. Deno runtime tests with scoped allow-read / cached-only / `--no-check`: **17/17 PASS**; exact `index.ts` `deno check`: **PASS**. Checked Deno test suite: **FAIL TS2353** as above.
5. Existing disposable PostgreSQL runner: **BEHAVIOR / ACQUIRE_RACE / RECONNECT_RACE / CLEANUP PASS**, with real onboarding migrations, fake Auth/Vault and non-superuser owner. Prior R1/R3/R4/R5 markers run in its behavior proof; R6/client markers run in Edge/client tests.
6. Independent apply inside BEGIN -> all candidate function client ACL/search_path checks, state-table RLS/direct-service-read denial, 11-trigger readback -> ROLLBACK and object absence: **PASS**. Reapply only in the same throwaway DB for the independent adverse interleaving.
7. Independent opposite-order first-onboarding probe: **safety expectation FAIL, defect reproduced**; exact outcome above. Scratch scripts/SQL preserved under `/private/tmp/kabumori-h2-deletion-proof.QjcRgz` but this Report includes the complete sequence and result so C2 need not open a local artifact.
8. Source `git diff --check` for full PR and Phase 4b diff: **PASS**. Client service-role/private-key patterns: zero matches; Edge console/logger paths: zero. Existing fake Apple signing-key generation is test-only, not a literal secret. Audit behavior test excludes raw IDs/tokens.
9. New broad mutation suite was **not rerun** after the reproducible design-level STOP; G3's 23/23 claim is not relabeled independent H2 evidence. The independent opposite-order probe demonstrates the existing passing suite's missing interleaving.
10. H2 throwaway DB dropped, readback count **0**, H2-only PostgreSQL server stopped. Scratch/export preserved. No material user/project file was deleted.

### C2 disposition / exact next gates / safety

- TASK -> `review_required`; next_owner -> `chatgpt`.
- C2 should return R1's first-onboarding/deletion serialization gap plus the checked-test typing issue to G3; recommended correction model **Opus5.5（高）**. No other TASK was changed or automatically reassigned.
- Source merge ready **NO** until both are corrected and exact-head focused regression passes, including both orders of first-onboarding vs deletion and zero orphan rows after reported success.
- Later rollout remains separately gated: single-file migration approval and owner/ACL/Storage/managed Auth readback; JWT-verification-ON Edge deploy + source byte compare; disposable-account real X/Apple/native/browser E2E; cross-app account-delete coordination; owner/legal retention and legal URL decisions; build activation. None was performed here.
- Production writes/migrations/RLS/RPC/Vault/Auth/Storage/settings/Cron, deploy, real X/Apple/OpenAI/Push/API invokes/posts and console/OAuth changes: **0**. Only two production catalog SELECTs; no user rows or Vault plaintext.
- Formal repo existing changes, G1/G2/G3/G4/H1 controls/source, apps/admin, HANDOFF, root package/lock/.env/src, dev servers: **untouched**. Report worktree only fast-forwarded approved remote state before editing these two H2 control files.
- Supabase skills used for current changelog/Auth/Vault/CORS/session semantics and privilege/locking checks; applicable current changelog was inspected, not a request to change production.

---

## H2 — PR #52 account-deletion privileged review — 2026-09-29

- task_id: `x-social-mobile-account-deletion-privileged-review-20260928`
- result / verdict: **FAIL — not safe to merge as a deletion implementation at the reviewed head.** Source/production enablement must remain blocked pending C2/G3 decisions and corrections.
- exact_reviewed_head: `12146c4ab2bc635a2781b673146e1f8ad8350258`; Draft PR #52, branch `claude/g3-account-lifecycle-p4`, source diff base `249df4c`.
- independent_review_worktree: `/private/tmp/kabumori-h2-account-deletion-review-20260929`; code remained byte-unchanged and Git-clean.
- fresh_origin_main_at_start: `3d8bbea33dd085a67599d2c9f8e48357c986e4ac`; report base after fresh-check: `d5054639f3608195016ef9771e8dc2203195c487`.
- source_fixes: **0**. TASK's design-level/partial-destruction STOP policy was invoked; no unrelated OAuth/backend fixes were attempted.
- changed_files (shared report only): `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md`.
- implementation_commit: existing G3 head above; no H2 implementation commit.
- report_commit_hash: `29e9a66de38770b9f0dff4b5e407c64736b94998` (H2 Report/TASK only).
- push: **SUCCESS** to origin/main. Fresh remote read-back confirmed that commit's inclusion, this task_id at the Report head, and TASK `review_required / next_owner: chatgpt`. This follow-up changes only the push-result record; its final sync SHA is provided in the completion message.
- deploy / merge / production_mutation: **0 / 0 / 0**.

### Merge-blocking findings

#### R1 — P1: deletion is not serialized against OAuth reconnect, nor across purge -> Auth deletion

Locations:
- `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql:127`, `:189` (transaction-local advisory locks); `:193-222` (purge re-check/deletion).
- `supabase/functions/social-mobile-account-delete/delete_logic.ts:143-175` (separate credentials/revoke/purge/Auth requests).
- Existing interacting RPCs (read-only review, NOT changed): `begin_social_mobile_x_oauth_connection` and `complete_social_mobile_x_oauth_connection`.

The advisory lock ends at each PostgREST transaction. Turning posting off is not a durable deletion marker: a normal freshly onboarded workspace is also inactive/disabled. Existing authenticated reconnect RPCs do not consult a deletion state or acquire the deletion lock.

Two legal interleavings were independently reproduced with candidate SQL + actual existing onboarding/reconnect RPC source in a disposable PostgreSQL database:
1. begin -> credentials snapshot -> authenticated reconnect begin+complete -> purge. Complete replaced the Vault tokens with a new fake access/refresh pair after the snapshot. Purge still succeeded. Only the old snapshot is sent to X by the Edge code; newly issued credentials can therefore be discarded locally without being revoked at X. External validity of real new X tokens is an inference from the call order, not a real-provider test.
2. purge commits -> authenticated begin reconnect recreates the derived workspace/account -> Auth-user delete. Auth deletion cascaded the membership but left the recreated brand and social-account rows as orphans. This also applies to an Auth admin API failure/retry gap. New callback completion during that gap can additionally install new secrets before Auth deletion.

Proof markers:
- `H2_RECONNECT_AFTER_CREDENTIAL_SNAPSHOT_REPRODUCED`
- `H2_PURGE_AUTH_DELETE_GAP_ORPHAN_REPRODUCED`

Required decision: a durable per-user deletion state/lease/tombstone honored by every relevant onboarding/complete/post/refresh writer, plus guarded finalization/recovery. A lock on just begin/purge is insufficient. This is cross-boundary design work, not a safe local patch to this PR. G4/other-lane RPCs were not changed.

#### R2 — P1: shared Auth deletion also deletes Kabumori main-app data without matching UI consent

- `supabase/functions/social-mobile-account-delete/index.ts:63-65` deletes the shared Supabase Auth user.
- `apps/social-mobile/src/domain/account-deletion.ts:27-33` lists login/workspace/X/schedule/history deletion but does not explain deletion of the same user's Kabumori main-app profile/data.
- G3's own `docs/account-lifecycle-phase4.md` §3 acknowledges this cross-product cascade.
- Live read-only FK catalog confirms `public.profiles.id -> auth.users.id ON DELETE CASCADE`.

The exact user is correct, but exact-user binding does not settle cross-product destructive consent. C2/owner must choose whether this is global account deletion (and disclose the full product scope) or social-app-only removal that retains shared Auth. Main-app `account-delete` can also orphan the social workspace, as already noted by G3; that other lane was reported only, not edited.

#### R3 — P1 defensive tenant boundary: foreign/shared Vault reference is not rejected

- Migration `:201-220` unions referenced secret IDs and deletes them, without checking whether another workspace/account/OAuth/refresh row also references any of those IDs.
- Live social-account index metadata contains PK, brand/platform uniqueness and platform/platform_user_id uniqueness, but no unique ownership constraint on Vault secret IDs.
- An isolated, schema-valid corruption fixture made A's access-secret reference equal B's. A's begin/purge returned ready/purged; B's account remained but its secret was deleted.
- Marker: `H2_SHARED_SECRET_REFERENCE_CROSS_TENANT_REPRODUCED`.

This is not evidence that an ordinary client can assign arbitrary Vault IDs; it is a missing fail-closed invariant at a privileged destructive boundary. Refuse ambiguous/foreign references before external revoke or deletion, and bind a stable exact credential set. No live secret IDs/plaintext were inspected.

### Additional source defects / release blockers

#### R4 — P2: missing X credential material becomes false revocation completion

`delete_logic.ts:145-157` silently skips null/empty tokens and records credentials_revoked. The credentials RPC can return null for a missing/deleted Vault object and does not expose whether an account was genuinely never connected. The independent mock returned one account with both tokens null: result was 200 ok:true, X revoke calls 0, Auth deletion executed. Distinguish truly unconnected/no-grant accounts from missing required credential material and fail closed on the latter. A direct local fix must not break normal unconnected-account deletion.

#### R5 — P2: Apple single-use-code retry is not idempotent

`apple_revoke.ts:65-75` exchanges and consumes the authorization code before purge/Auth completion; `delete_logic.ts:159-170` repeats the exchange on every retry. With real helper + fake Apple responses, the first request exchanged/revoked successfully then got PURGE_FAILED; retrying the same request got APPLE_REVOKE_FAILED before purge, because the code was already consumed. No durable Apple-revoked checkpoint is used. The screen resets reauth only on REAUTH_REQUIRED/APPLE_REAUTH_REQUIRED, not on this failure, so its normal retry retains the unusable code.

Apple's official guidance describes authorizationCode as single-use; do not claim every step is repeat-safe. Define safe resumption or explicitly obtain a new same-user native authorization code without losing the deletion state. Do not merely ignore revoke failure. [Apple WWDC guidance](https://developer.apple.com/videos/play/wwdc2022/10122/)

#### R6 — P2: web deletion cannot call the candidate Edge endpoint

`index.ts:19` returns 405 for OPTIONS and no response supplies CORS allow-origin/headers. The browser request uses Authorization/apikey/JSON and needs preflight. A local captured entry-handler test confirmed OPTIONS=405 and no Access-Control-Allow-Origin. Native app behavior is different; successful web export does not test this request. [Supabase CORS guidance](https://supabase.com/docs/guides/functions/cors)

Apple browser reauth is a separate limitation: it does not produce the native authorizationCode required by the Edge pre-check. One APPLE_CLIENT_ID is configured; native App ID vs web Services ID/audience and the supported deletion UX need an explicit rollout decision. Do not present browser Apple deletion as supported.

### Boundary assessment (including what passed)

- **Auth / IDOR:** Edge derives uid and provider identities from GET /auth/v1/user using the caller's Bearer token. Client body does not name the subject. Confirmation constant and signed-token sub + newest amr timestamp <=600 seconds precede side effects. Existing gate tests passed; independent wrong body-id probe still used only the verified uid. No source path that lets an unverified client select a different uid was found.
- **Client exact reauth:** password/native Apple/browser helper compare the resulting user against the previously captured user and reject mismatches. However the deletion screen's reauthed/confirmation state is not keyed/reset to user/session; deleteAccount fetches whichever session is current. Session switching between confirmation and submission is a remaining client-context issue to cover with a pinned user/session test, not a demonstrated cross-user backend IDOR.
- **DB privileges:** four externally callable RPCs are SECURITY DEFINER with empty search_path; all client/PUBLIC execute revoked, only service_role (plus owner) can execute. Internal helper execute revoked even from service_role. Audit RLS enabled, no direct client/service read grant. Disposable non-superuser owner proof verified actual ACL denial, not just strings.
- **Workspace guards:** live schema + baseline proof cover admin, foreign owned workspace, foreign profile, shared derived workspace, role mismatch, running post/publishing claim and refreshing state. Own owner membership being absent is not explicitly rejected; derived ID alone is accepted. Blocked cases return/raise fixed codes without proceeding to revoke/purge.
- **In-flight posting/refresh:** current running/refreshing rows are rejected; begin disables brand/account/refresh rollout, purge re-checks. Existing race proof covers two purge transactions only, not the complete multi-HTTP workflow. R1 remains unresolved.
- **FK ordering/atomicity:** unknown dependent FK correctly aborts the purge transaction. Independent fake Vault-delete-denied trigger likewise rolled back workspace/account/secrets. Edge purge error test prevented Auth deletion. This protects local purge; it cannot roll back prior X/Apple revocation or begin's committed posting changes.
- **Vault capability:** live metadata only: vault.secrets and decrypted_secrets owner=supabase_admin; current postgres has SELECT+DELETE, service_role has r/d; no noninternal delete trigger was found. These facts establish capability for a postgres-owned definer under current ACL, NOT an already applied candidate or a test of encrypted deletion. Candidate functions do not exist in production and do not pin OWNER; eventual single-file apply must explicitly verify actual owner, ACL and intended Vault delete capability. No live Vault plaintext read, mutation or production delete proof.
- **X revoke:** source POST /2/oauth2/revoke, form token/token_type_hint/client_id, Basic client credentials matches X's official SDK for a confidential client. Refresh is attempted before access; any non-2xx/throw stops before purge/Auth. No token/header log path. App type, correct same X client, already-revoked token responses and real revocation semantics remain operator/QA gates; no Developer Portal or real provider request was made. R1/R3/R4 prevent accepting overall revocation safety. [Official X OAuth SDK](https://github.com/xdevplatform/twitter-api-typescript-sdk/blob/main/src/OAuth2User.ts)
- **Apple binding:** ES256 secret generation/signature test passes, expected iss/kid/aud/sub/5min TTL. Code exchange is server-to-Apple HTTPS; returned id_token sub must match the verified user's Apple identity. Apple subject mismatch/no ID token refuses revoke. Official Supabase Auth identity source maps JSON id to ProviderID(sub), while identity_id is the row UUID: using identity.id here is correct, not a defect. [Supabase identity source](https://github.com/supabase/auth/blob/master/internal/models/identity.go)
- **Auth terminal state:** purge error blocks Auth delete, Auth failure returns AUTH_DELETE_FAILED, only 200 ok:true reaches client success/local sign-out. Non-Apple mock retry after Auth failure succeeds on nothing_to_purge. 404 counted as success at the adapter, but a later request for an already removed user normally fails getUser before reaching the 404 branch; lost-response terminal recovery is not fully specified.
- **Session invalidation:** hard Auth delete cascades session rows and invalidates refresh issuance, but issued access JWTs remain cryptographically valid until expiry. No deletion/session tombstone check is added to the existing sensitive RPCs. Do not claim immediate global access-token invalidation; R1 requires a sensitive-operation gate regardless. [Supabase user deletion/session guidance](https://supabase.com/docs/guides/auth/managing-user-data)
- **UI / legal:** explicit build flag + backend configured is required; otherwise setup_pending. Legal links fail closed on missing/placeholder/secret-like URLs, no invented policy text. X posts retained is disclosed; fixed errors never echo provider/server messages. Retained deterministic uid SHA-256 is pseudonymous, not proof of irreversibly anonymous data; retention and privacy wording need owner/legal decisions. R2 remains unresolved.
- **Audit:** fixed steps/reasons, uid hash, no raw uid/credential stored. Edge record failure is best-effort and swallowed; terminal deletion can be unrecorded if final audit fails. Define observability/recovery for a lost final response without retrying one-time external actions.

### Verification independently executed at exact PR head

1. `npm ci --offline --ignore-scripts --no-audit --no-fund` in H2's own social-mobile app: 821 packages installed from cache; no shared node_modules used, no tracked dependency/lockfile change. First test attempt without dependencies failed with two module-not-found harness failures; subsequent complete run passed.
2. `npm test`: **71/71 PASS** (account-deletion client tests included).
3. `node --test src/domain/data-view.test.ts`: **14/14 PASS**.
4. `npm run typecheck`, `npm run lint`: **PASS**.
5. `CI=1 EXPO_NO_TELEMETRY=1 npx --no-install expo export --platform web --platform ios --output-dir <H2-tmp>/expo-export`: **both PASS**, no real backend env injected. Export is bundling proof, not signed-in browser/device QA.
6. Deno cached-only/no-lock/no-config test with allow-read limited to the candidate directory: **13/13 PASS**; `deno check .../index.ts`: **PASS**. Initial no-allow-read attempt failed one source-reading test due to permission; scoped read permission resolved the harness issue.
7. G3 disposable runner (PG17, Unix socket only, fake data, non-superuser fixture owner): **BEHAVIOR / RACE / CLEANUP PASS**. Public/client ACL and shared/admin/foreign/active-work guards checked; its race is concurrent purge only.
8. Independent candidate **apply inside BEGIN -> ACL/object checks -> ROLLBACK -> candidate table/functions absent**: PASS. Then reapplied to own throwaway DB for focused behavior proofs.
9. Independent SQL probes: R1 reconnect-after-snapshot reproduced; R1 purge/Auth gap orphan reproduced; R3 cross-tenant shared-secret fixture reproduced; Vault-delete-denied atomic rollback PASS. Existing exact onboarding/reconnect RPC bodies used, auth.uid and Vault are local minimal stubs. Production catalog source matched those RPCs. No encrypted real Vault or real provider operation was used.
10. Additional outside-repo Edge/mock tests **6/6 PASS as reproduction/control checks**: verified uid vs body, null credentials false success (R4), purge/X failure stops Auth, non-Apple Auth retry, consumed Apple-code retry failure (R5), OPTIONS/CORS rejection (R6). A reproduction PASS means the defect was observed, not that release safety passed.
11. `git diff 249df4c..12146c4 --check`: PASS; review worktree git status clean. Client secret scan has no service role/client secret/private key references; no Edge console/logger path. Key-pattern scan only matched dynamically generated fake PEM in apple_revoke_test, not a literal credential.
12. Disposable proof database was dropped; catalog count=0 confirmed, own PG server stopped. Scratch evidence files/export preserved under `/private/tmp/kabumori-h2-deletion-proof.QjcRgz`; nothing from them was committed.

### Concrete reproduction / remediation handoff for C2 (no external local file needed)

- R1 snapshot race: create fake own workspace -> service begin -> capture credentials -> authenticated begin OAuth(new state) -> authenticated complete(new fake tokens) -> verify Vault material differs from captured pair -> service purge still returns purged.
- R1 finalize gap: same fake user still exists after purge -> authenticated begin OAuth recreates workspace -> delete fake auth.users row -> assert brands/social_accounts remain and owner membership is gone.
- R3: two fake users/workspaces -> set A's access-secret ref to B's access-secret -> begin+purge A -> B social_accounts remains but referenced Vault object is missing. Test source must be local only, never production fixtures.
- R4: credentials RPC mock array contains an existing account with access_token=null/refresh_token=null -> handleAccountDeletion returns ok:true with zero revoke calls and one Auth delete.
- R5: real Apple helper with fake first code exchange/revoke 200 + purge RPC error -> repeat same code -> fake exchange 400(single-use) -> APPLE_REVOKE_FAILED, no second purge/Auth.
- R6: capture Deno.serve handler, send OPTIONS with Origin and requested authorization/apikey/content-type headers -> 405, no allow-origin.

### Exact next gates

- C2 must return R1/R2/R3 for design correction before merging this deletion implementation. Suggested G3 implementation model: **Opus5.5（高）**; do not alter G3's current TASK or another lane automatically.
- Add durable workflow and writer exclusion/recovery tests, same-user/session confirmation binding, credential completeness/ownership checks, Apple resumability, and truthful native/web support.
- Resolve global-vs-product-specific deletion and main-app deletion coupling with the owner; resolve retained audit/privacy/history policy.
- Re-run exact-head tests plus interleavings and destructive boundary proof; independent security review again.
- Only separately approved production preflight may inspect/apply one migration, pin/check definer ownership/Vault ACL, deploy candidate with JWT verification ON, byte-compare and perform disposable-account/provider E2E.
- No production apply/deploy/E2E is authorized or recommended from this FAIL report.

### Safety / C2 disposition

- TASK -> `review_required`; next_owner -> `chatgpt`.
- Production DB/schema/RLS/RPC/Vault/Auth/Storage/settings/Cron mutations: **0**.
- Edge deploy, actual user/data deletion, real X/Apple revoke, X/OpenAI/Push calls/posts, provider console/OAuth changes: **0**.
- Other workstream source/control files, apps/admin, HANDOFF, root package/lock/.env/src, formal repo's existing uncommitted changes: **untouched**.
- Read-only production work limited to schema/FK/index/RPC/owner/ACL/trigger catalogs; no user rows or Vault plaintext.
- PR #52 remains unchanged at reviewed head; no source fix/merge and no review bypass.
- Current G1/G2 parallel updates did not overlap H2 controls or deletion source. Earlier N3 unfinished local report/code was preserved separately and not mixed into this task.

---

## H2 — PR #15 admin auth / cross-brand final review — 2026-09-25

- task_id: `x-admin-pr15-auth-crossbrand-final-review-20260925`
- verdict: **PASS-WITH-FIX**. Two concrete server-side authorization/context gaps were fixed on PR #15; C2 should review the updated head before any merge. No merge, deploy, or production mutation.
- fresh_origin_main_at_start: `72042530a1f63c92b0f2faf9d7ac7398b4032ff7`; latest main before PR push: `aa8a68962d1408ed042f8a5ae6c5fea8d8dbf45d`. Intervening changes did not touch `apps/admin` or H2 control files.
- PR #15: `admin-multibrand-selector-phase2-20260924`, original head `a8f98444425c25796e9fef611445b0f574120669`; the original head and semantic predecessor `b04442561d9e9c6d01b4a9fcf640c2cf731cd923` have identical tree `ab8c572641ee8a148bd97f58660268abd2f36d8c`.
- fix_commit: `de354e7ff9f647435a3c42a87629be1e735794eb`; pushed to the PR #15 branch and read back as its OPEN PR head.
- changed_files (PR fix only): `apps/admin/src/lib/actions/select-brand.ts`, `apps/admin/src/lib/actions/system-toggle.ts`, `apps/admin/src/lib/active-brand.ts`, `apps/admin/src/lib/admin-context.ts`, `apps/admin/src/lib/brand-boundary.test.ts`, `apps/admin/src/lib/selected-brand.test.ts`, `apps/admin/src/lib/selected-brand.ts`.

### Findings and boundary assessment

1. **P1 fixed — independent page/action admin gate.** The protected layout checked `admin_users`, but page components execute in parallel and independently called `requireActiveBrand()`. Its resolver accepted `brand_memberships` owner/admin alone as scoped access. A non-`admin_users` member could therefore pass the page-side brand gate and start brand-scoped data reads even while the layout redirected; live RLS permits membership reads on some operational tables. Whether any response fragment leaked in a real authenticated session was not demonstrated. The brand-selection Server Action had the same membership-only acceptance. `chooseAdminActiveBrand()` now requires the existing global `admin_users` result before either page or action accepts a selection. Unauthenticated/unknown/not-admin cases fail closed. The generic resolver's scoped behavior remains available to other callers, but does not authorize this admin app.
2. **P1 fixed — Kabumori-only mutation context.** `setSystemEnabled()` checked login and `admin_users` and pinned `posting_windows` DML to Kabumori, but did not check which brand was selected. A global admin on the AI Lab view could directly invoke the Server Action and change Kabumori settings despite hidden controls. The action now re-resolves the authorized active brand and denies the mutation unless it is an accepted Kabumori selection, before any read/write path. Unknown/tampered selection also denies. The allowlisted setting keys and fixed Kabumori `brand_id` predicates remain unchanged.
3. **Cross-brand reads — PASS.** `scheduled_posts`, `post_execution_logs`, nested `scheduled_posts`/report-run lookups, `morning_report_runs`, and `posting_windows` are filtered by the server-authorized brand ID. AI Lab skips the unscoped Important News candidate tables and Kabumori-only singleton settings, showing read-only posting-window status. The X link builder validates numeric post ID and a safe handle from the server-owned registry; no client-supplied handle reaches a URL.
4. **RLS/backend contract — PASS with limitation.** Read-only live policy inspection showed `admin_users` self-read, `brand_memberships` self-read, member SELECT policies on operational rows, and separate admin SELECT policies. `brands`/`social_accounts` are not globally readable to an `admin_users` user without membership, so the code-owned `ADMIN_BRANDS` allowlist is justified here; it does not replace DB RLS and must be updated deliberately when brands change. Mio remains excluded. No service-role key or RLS bypass was introduced.

### Tests and Preview

- All `apps/admin/src/lib/*.test.ts`: **34/34 PASS** (including 3 added adversarial assertions). Focused selected-brand/boundary: **20/20 PASS**.
- `npx tsc --noEmit`: PASS. `npm run lint`: PASS. `npm run build`: PASS (Next.js 16.3.4; protected routes dynamically rendered). `git diff --check`: PASS. Targeted added-line secret scan: 0 findings.
- Netlify Deploy Preview for final commit `de354e7`: commit status `netlify/shiny-kheer-77a154/deploy-preview=success`; URL `https://deploy-preview-15--shiny-kheer-77a154.netlify.app`. Read-only HTTP: `/login` 200; `/`, `/posts`, `/important-news` each 307 to `/login`; invalid synthetic Supabase cookie on `/posts` also 307; following redirect reaches 200 after one hop. Protected response headers include `server: Netlify` and `x-powered-by: Next.js`; no observed 404/5xx/redirect loop.
- Authenticated live QA remains **unverified**: no legitimately available admin/non-admin test session in this task. No password/token was requested or recorded. Selector behavior and server action denial were covered by source/tests, not real signed-in Preview interaction.

### Disposition and safety

- merge_recommendation: **C2 review of updated PR head required**; do not merge/deploy solely on this report. Authenticated live QA is the remaining acceptance risk if required by C2.
- production mutation: **0**. DB/schema/RLS/Auth/settings/Cron/Edge deploy/Netlify config: 0. OpenAI/X/Push/post: 0. PR merge: 0. Secrets exposed: 0.
- other workstreams: unchanged; review and control updates used isolated H2 worktrees, not the formal checkout or other slots. H2 TASK is `review_required` / `next_owner: chatgpt`.

---

## H2 — PR #29 prompt hardening + v27 validator final review — 2026-09-25

- task_id: `kabumori-pr29-plus-v27-validator-final-review-20260925`
- result: **PASS-WITH-FIX**. The v27 validator change is narrowly anchored; PR #29 prompt hardening preserves Fact/validator safety. One visible morning-output field was missing the neutral-wording instruction; the minimal prompt/test fix was pushed to PR #29. No merge or deploy.
- fresh_main_sha_at_task_start: `1abd9f0ab9eb5375395ef30380ea0aff32e61dd5`.
- latest_origin_main_before_pr_push: `3c223fa38a14b944dc0ca9022e59eff756e7eb70`. The intervening main commits touched only agent coordination/G3 files; no overlap with the reviewed `personalized-reports` files or H2 control files.
- control_report_base_sha: `de86cfff332624755de162b1ee254eecf158968c`; the only subsequent main change since the pre-push check was G2's separate task file, with no H2 report/task conflict.
- reviewed_main_commit: `510acf5954b37410b50c23ff92c3f54af6458a72`.
- reviewed_pr: #29, branch `g2-report-false-reject-hardening-20260925`; initial head `bed5e79d0ab22e94be6a7c1ebd0f7c8f157ea0c0`; final head `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`.
- implementation_commit: `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`; pushed only to the PR #29 branch. Post-push fetch confirmed the remote PR head equals this commit.
- changed_files:
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/report_hardening_test.ts`

### Review findings

- **510acf5 validator — PASS.** The `値下がり|値上がり` prefix widening remains constrained by the existing whole-string anchor and fixed unknown-cause remainder. `CAUSAL_ASSERTION` is evaluated first; sentence splitting remains intact. The four requested bounded unknown-cause phrases pass, while free-text subjects (`急な値下がり`, `半導体株の値上がり`, `円安による値上がり`), cause assertions, causal laundering, and punctuation/multi-sentence bypasses reject. No validator code was changed by PR #29.
- **PR #29 inference prompt — PASS.** Facts/comparison clauses remain in their factual fields rather than `inference_ja`; unsupported causation is constrained to a bounded unknown-cause sentence. Fact checker and fail-closed validator semantics are unchanged.
- **PR #29 morning wording — PASS-WITH-FIX.** Neutral observation guidance does not relax Fact validation or introduce new factual claims. Review found that `watch_notes[*].note_ja` is also user-visible and included in `reportTexts`, but was omitted from `MORNING_WORDING_RULE`. The prompt now names that field explicitly, with a regression assertion. No other behavior was broadened.
- **MIC compatibility — PASS.** PR #29 does not change `mic_market_context.ts` or MIC semantics and does not remove MIC context from prompts. Existing MIC/report integration remains unchanged; no active-workstream overlap was found.

### Verification

- Focused `report_hardening_test.ts` + `close_validator_fix_test.ts`: **32/32 PASS** (9 + 23).
- Full `supabase/functions/personalized-reports` suite: **96/96 PASS**, including MIC context/integration tests (14 + 6).
- `deno check --no-lock` for `index.ts` and `report_logic.ts`: **PASS**.
- `deno lint supabase/functions/personalized-reports`: **PASS**, 12 files.
- `git diff --check`: **PASS**.
- PR change remains limited to the two listed source/test files; the H2 fix is 2 insertions / 1 deletion on top of the original PR head.

### Production read-back and disposition

- Read-only project `wsmznyzcvmuitkglfeuj`: `personalized-reports` **v27 ACTIVE**, `verify_jwt=false`; `market_report_consumer_settings.app_enabled=false`, `x_enabled=false`.
- Cron read-back unchanged: job 10 `personalized-reports-morning`, `35 23 * * 0-4`, active; job 11 `personalized-reports-close`, `15 8 * * 1-5`, active.
- Production DB/settings/Cron/function mutation: **0**. Function deploy: **0**. Production LLM/API invocation: **0**. X/Push/post: **0**. Merge: **0**. Secrets exposed: **0**.
- remaining_issues: C2 merge decision and any later controlled deploy/dry-run remain separate. No production LLM output or live generated report was exercised in this review.
- next_recommendation: C2 may review the updated PR head `ef96037`; do not merge/deploy without separate approval.
- safety_checks: review and control updates used separate clean H2 worktrees; no other slot source, app, settings, or task files were changed. TASK is now `review_required` / `next_owner: chatgpt`; stop for C2.

---

## H2 — PR #26 unknown-cause prefix final review — 2026-09-25

- task_id: `kabumori-pr26-unknown-cause-prefix-final-review-20260925`
- result: **PASS**. The optional move-subject prefix is narrowly anchored; no PR-introduced causal-assertion or free-text bypass was found. Safe for C2 merge review; no merge or deploy performed.
- fresh_main_sha: `9934391fc59085ffd66f9a15396deb686a93f804`.
- reviewed_pr: #26, `g2-close-unknown-cause-prefix-20260924`, exact requested head `2b40a617e34c73c301e40a17692883ac70fd3e0a`; fetched PR head matched exactly. Main contains PR #23 merge `5df9512b43c885fff28b625d089eda249320b3c3`.
- production_readback: project `stock-x-autopost` (`wsmznyzcvmuitkglfeuj`); `personalized-reports` v25 ACTIVE, `verify_jwt=false`; `market_report_consumer_settings.app_enabled=false` and `x_enabled=false`. Read-only metadata/query only.
- changed_files: no PR source changes. H2 control files only: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md`.

### Review findings

- `UNDETERMINED_MOVE_PREFIX` permits only optional `当日の` + one of `下落|上昇|値動き|変動` + optional `の`. The remainder is a fixed unknown-cause phrase and the expression remains whole-string anchored.
- `CAUSAL_ASSERTION` is still evaluated before the unknown-cause/hedge acceptance paths. Sentence splitting remains in place. `因果関係は確認できません` is accepted as a bounded uncertainty statement; unrelated subjects, assertions, and mixed unsafe sentences are rejected.
- Additional read-only adversarial evaluation: `急な下落…`, `半導体株の下落…`, `円安による上昇…`, cause-as-fact variants, mixed clauses, and Japanese/ASCII punctuation variants all reject. `下落の要因は特定できない可能性があります` is accepted by the existing generic `HEDGE` branch, not the new anchored regex; it is a hedged uncertainty, not a causal assertion, and the HEDGE branch was unchanged by this PR.
- `morning=120` / `close=160` remain unchanged.

### Verification

- Focused close-validator suite: **20/20 PASS**.
- Full personalized-reports suite: **64/64 PASS**.
- `deno check --no-lock` for `index.ts` and `report_logic.ts`: **PASS**.
- `deno lint supabase/functions/personalized-reports`: **PASS**, 8 files.
- `git diff --check origin/main...HEAD`: **PASS**.
- PR diff is limited to `report_logic.ts` and `close_validator_fix_test.ts` (81 insertions, 2 deletions).

### C2 disposition / safety

- verdict: **PASS**; source is safe to consider for merge. H2 did not merge or deploy.
- recommendation: after C2 approval and normal merge gates, redeploy `personalized-reports` only under a separate authorization with `app_enabled=false`, then perform 3–5 natural/dry-run close validations as assigned; retain the known-good v21 rollback source and do not enable app publishing until results are accepted.
- production DB/schema/RLS/RPC/settings/Cron mutation: **0**; Edge deploy: **0**; LLM/API invocation: **0**; X/Push/post: **0**; merge: **0**; secrets exposed: **0**.
- remaining_issues: C2 merge decision and any later redeploy/dry-run are separate. The accepted generic hedge case above is pre-existing behavior and is not a PR-introduced widening.
- safety_checks: review and control report were performed in separate clean H2 worktrees. No other slot files or source were changed.

## H2 — PR #23 close validator final review — 2026-09-24

- task_id: `kabumori-pr23-close-validator-final-review-20260924`
- result: **PASS-WITH-FIX** for source review. Found and fixed one adversarial validator bypass in PR #23, added regression coverage, and pushed the minimal fix. PR remains unmerged; no production action was performed.
- fresh_main_sha: `9ca14d802bc8f15c4618369b8c4212bc0bcbe5ea` at task start; latest pre-push `origin/main`: `b3780609d655136eab05648235f1a31113a72182`.
- reviewed_pr: #23, branch `g2-close-report-validator-fix-20260924`; requested initial head `5c22c71961496fc63e698e42e7c18cacc7f7cff3`; post-fix head `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`. Post-push fetch confirmed the branch at `47d8c78`.
- changed_files (H2 fix only):
  - `supabase/functions/personalized-reports/report_logic.ts`
  - `supabase/functions/personalized-reports/close_validator_fix_test.ts`
- implementation_commit: `47d8c7830ed08b087b2dff7bbe7cc8c0f4cc382f`; push to PR branch succeeded. No merge.

### Review findings and fixes

1. **Fixed before merge — same-sentence hedge laundering.** Before the fix, an explicit causal assertion followed by a hedge token in the same sentence passed `inferenceIsHedged()`, e.g. `円高が逆風になりましたが、要因は特定できない可能性があります。` The old broad unknown-subject/end check could also accept unrelated assertions merely because `材料` or another allowed noun appeared in the sentence. This was a deterministic local-validator bypass; the semantic Fact check remained in place, so it was not a direct X/posting bypass.
2. The validator now rejects recognized causal assertions before considering hedge tokens, splits on Japanese and common ASCII punctuation plus semicolons/newlines, and permits unhedged uncertainty only for a whole-sentence anchored statement or the bounded production dry-run wording. The ordinary hedged inference path remains available.
3. Added adversarial tests for causal text followed by a hedge/unknown-cause clause, Japanese/ASCII punctuation and newline boundaries, unrelated allowed nouns, and additional unrelated assertions. The exact production unknown-cause sentence remains accepted.

### Length and safety assessment

- Final brief limits: morning **120** characters; close **160** characters. The same report-type-specific value is used in the prompt and local validator; brief length remains combined `fact_ja + inference_ja + watch_ja`. Detailed per-field limits remain 160 / 160 / 80. `DRAFT_SCHEMA` defines field shape but has no character `maxLength`; a JSON Schema property cap cannot express this context-dependent combined-field budget. The local validator remains the fail-closed enforcement point after generation. No schema-limit mismatch can bypass that check, but this distinction is recorded for C2.
- Boundary tests: close 160 passes / 161 fails; morning 120 passes / 121 fails; observed 104–136 character close fixtures pass.
- Unsupported numeric/date/URL/advice, unknown/duplicate/missing holdings, unsupported basis, shared-direction contradiction, Fact-vs-inference separation, and `no_clear_material` regression checks remain covered by the relevant suite.
- No `apps/` source changed; no directly relevant app test file was found. The app itself was not changed.

### Verification

- Focused close-validator tests: **14 passed / 0 failed**.
- Full `supabase/functions/personalized-reports` suite: **58 passed / 0 failed** (`deno test --no-check --allow-read`).
- `deno check --no-lock` for `index.ts` and `report_logic.ts`: **PASS**.
- `deno lint supabase/functions/personalized-reports`: **PASS** (8 files).
- `git diff --check`: **PASS**.
- A type-checked `deno test --allow-read` attempt could not start because this clean worktree lacks `npm:@types/node`; no dependency installation was attempted. The no-check tests and changed-source type check passed.
- Fresh-main delta after task start touched only agent coordination and Phase1F/X-autopost files; it did not overlap PR #23's personalized-report files. PR diff remains confined to the three intended personalized-report files; H2's fix changes two of those.

### C2 disposition / safety

- Source review verdict: **PASS-WITH-FIX** at PR head `47d8c78`. The runtime length policy is fail-closed and prompt/local-validator values match; C2 should note the shape-only schema distinction above when deciding merge readiness. H2 did not merge it.
- After merge and separate deploy authorization, redeploy `personalized-reports` with `app_enabled=false`, then run repeated close dry-runs (at least three) and verify local/Fact results before any later activation decision. Keep the known-good v21 rollback source available.
- production DB/schema/migration/RLS/RPC/settings/Cron mutation: **0**; Edge deploy: **0**; manual LLM/API invocation: **0**; X/Push/post: **0**; Auth/admin/X scope changes: **0**; secrets displayed: **0**.
- remaining_issues: GitHub merge checks/merge and any later deployment/dry-run remain separate steps. No app-level integration or real-model output was exercised in this review.
- safety_checks: work was isolated to the PR #23 clean worktree and this H2 control worktree; no G1/X/admin source or formal checkout changes. H2 stops for C2.

## Final C2 disposition — PR #21

- verdict: **PASS-WITH-FIX**
- reviewed/fixed head: `0a71f0882136aa8930cf0572033e1a0ba28c0760`
- identity/linkage: PASS
- env preflight: PASS
- artwork/A1/A1b findings: factual and accepted
- focused verifier tests: 8/8 PASS
- scoped suite: 116/116 PASS
- production mutation: 0
- merge disposition: safe for fresh-main merge/post-merge verification
- release disposition: do not production-build/release until official artwork, EAS production vars, and App Store Connect inputs are ready

# H2 — PR #21 branding / EAS preflight final review (2026-09-24)

- task_id: `kabumori-pr21-branding-eas-preflight-final-review-20260924`
- result: **PASS-WITH-FIX; source review is complete.** The concrete validation/accuracy issues below were fixed within PR #21 and pushed. No production activation was performed.
- fresh_main_sha: `592b8ebc1d7ce68e3ff0624f0a67cb26f88223b1` at task re-read; latest pre-control-report origin/main: `64234acfc4ff12d9f37aaa4bc4cb637309d1da0c`.
- reviewed_pr: #21, branch `claude1/release-branding-eas-preflight`; original K1 head `db5143fe399df25902739f4c60a07af712c3743a`; H2 fix commit `0a71f0882136aa8930cf0572033e1a0ba28c0760` pushed and read back as the remote branch head.
- GitHub read-back: PR OPEN, unmerged, `mergeable=true`, `mergeStateStatus=UNSTABLE`; no mainline merge performed.

## Findings and minimal fixes

1. **P2 fixed — publishable-key validation was length-only.** A long arbitrary string passed the original preflight, and a `service_role`-style credential would also pass the length check despite being unsafe in an `EXPO_PUBLIC_*` variable. The validator now accepts the documented `sb_publishable_…` shape or a legacy JWT whose payload role is `anon`; arbitrary strings, `sb_secret_…`, and `service_role` JWTs fail with a fixed message that never includes the supplied value. This is structural validation only: it does not authenticate the key, prove it belongs to the configured project URL, or contact Supabase. The accepted formats follow [Supabase's API-key format guidance](https://supabase.com/docs/guides/getting-started/api-keys).
2. **P2 fixed — App Store listing name was conflated with `expo.name`.** The readiness document now says `expo.name` sets the home-screen app name and explicitly leaves the localized App Store product name as an App Store Connect operator action. Apple's App Store Connect documentation describes that listing name as app metadata managed there: [App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information).
3. **P2 wording corrected — launch overlay scope.** The overlay is rendered on normal startup after auth loading, but a recovery-link route takes precedence. The document no longer claims every route/launch displays it.

## Identity, artwork, and release assessment

- `app.json` changed only `expo.name` to `かぶモリ`; `slug`, `scheme`, iOS `bundleIdentifier`, and EAS `projectId` compare unchanged against main. Auth/recovery deep-link identity remains `kabumori`.
- Source/config use exactly `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `EXPO_PUBLIC_KABUMORI_WEB_URL`. The first two are read by `src/lib/supabase.ts`; the third uses the same `normalizeWebOrigin()` helper as the app. Errors name variables but do not echo values. No service-role value is added to source.
- Missing Supabase build-time values fail at app startup because the root Auth provider imports the client during startup; the prior K1 export smoke had reproduced `supabaseUrl is required`. This H2 isolated worktree lacked dependencies, so that runtime reproduction was not repeated.
- The preflight checks only the current process environment, does not read EAS remote values, does not contact Supabase, and is not automatically wired into `eas build`; direct builds can bypass it. The readiness document now states this limitation. Operator must configure EAS `production` values and run the preflight in the intended environment/CI before a production build.
- The complete tracked raster/vector asset listing showed only Expo/React template art, generic tab icons, and a blue glow; `assets/images/icon.png`, `assets/expo.icon`, splash art, and the launch overlay are not official Kabumori artwork. `AnimatedSplashOverlay` is rendered by `src/app/_layout.tsx` for normal startup and references `expo-logo.png`; the web-specific overlay returns `null`. No artwork was generated or changed.
- App Store Connect localized listing name, official icon/splash/overlay art, EAS production values, and remaining account/release setup remain operator actions. Source-level PR content is reviewed; wait for required GitHub checks because PR state currently reports `UNSTABLE` before merge.

## Changed files and verification

- H2 review fix commit `0a71f0882136aa8930cf0572033e1a0ba28c0760` changed only:
  - `scripts/verify-production-env.mjs`
  - `tests/app/verify-production-env_test.ts`
  - `docs/mobile-release/RELEASE_READINESS.md`
- `node --experimental-strip-types --test tests/app/verify-production-env_test.ts`: **8/8 PASS**.
- Scoped suite `deno test --no-check --no-lock --allow-read --allow-write --allow-env tests/app/ supabase/functions/account-delete/ apps/kabumori-web/build_test.ts`: **116/116 PASS**.
- `npm run verify-production-env`: missing values -> exit 1; fake well-shaped values -> exit 0; long malformed key -> exit 1. Test values were synthetic only; no production keys were read or displayed.
- Static `app.json` parse and identity/linkage comparison: PASS; `git diff --check`: PASS.
- `src` TypeScript and Expo config/export smoke were not rerun: the clean worktree had no `node_modules`, and no global `tsc`/Expo CLI was available. No dependency installation was attempted. K1's earlier source-head report recorded src TypeScript 0 errors and a 10-route Expo export; H2 does not claim those as fresh reruns.
- Changed scope had no overlapping paths with changes on `origin/main` since the PR branch base. No H1/G2/G3/G4 files were changed by H2.

## Safety and C2 disposition

- merge: **source review PASS-WITH-FIX**; PR remains open and unmerged. GitHub reports mergeable but `UNSTABLE`; wait for checks/normal merge process. Do not treat this as approval to build/release with missing operator inputs.
- production DB/schema/migration/RLS/RPC/Auth/SMTP/EAS remote env/Netlify/App Store/TestFlight/API/X mutation: **0**. No merge, deploy, production build, artwork generation, or secret display.
- control changed_files: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md` only.
- next_recommendation: C2 review this report and the three-file PR #21 fix; keep production build blocked until official artwork, App Store Connect metadata, and EAS production variables are supplied and verified.

## Final C2 assessment — PR #19

- verdict: **PASS-WITH-FIX**
- reviewed head: `7dcf41c5714d620c41b3077376b9f5febbd129b2`
- accepted H2 fix: missing-value/change display guard
- focused tests: 49/49 PASS
- privacy boundary: PASS; no cross-user path found
- morning-to-close isolation: PASS
- compatibility/X invariants: PASS
- production mutation: 0
- product-scope decision: scheduled cohort is unchanged; users with zero active tracked rows are outside this task. Watch-only users satisfy the "no holdings" market-only case.
- semantic evidence relevance remains a future hardening item, not a merge blocker.
- next: G2 fresh-main rebase/conflict resolution + merge/post-merge verification.

# H2 — PR #19 report detail / portfolio privacy final review (2026-09-24)

- task_id: `kabumori-pr19-report-detail-portfolio-privacy-final-review-20260924`
- status: `review_required`; next_owner: `chatgpt`
- verdict: **FAIL / hold merge pending product-scope resolution.** The source and privacy review found no cross-user data path, but the advertised zero-tracked-user market-only case is unreachable from the scheduled handler. H2 fixed one independent missing-market-value display defect; this does not resolve the cohort gap.
- fresh_main_sha: `188b16541a13998e5ff32501e52082b94e3251fe` at task re-read; latest pre-report/push base: `e60ad3b3e633841cb42debe616bacb7db1ded129`.
- reviewed_pr: #19, branch `g2-app-report-detail-portfolio-impact-20260924`, initial K2 head `acbc1b6ceac04d978b7fe6fb8e3d266734d3826a`; review fix `7dcf41c5714d620c41b3077376b9f5febbd129b2` was pushed as a fast-forward. GitHub read-back: PR OPEN, unmerged, head exactly `7dcf41c...`.
- merge: **not performed**. Production deploy/mutation: **0**.

## Findings

1. **P1 — zero-tracked-user market-only report is unreachable (merge blocker if this is in scope).** `personalized-reports/index.ts` builds `byUser` exclusively from active `tracked_stocks`, derives `userIds` only from those keys, and returns before report generation when the list is empty. `report_logic.ts` and its new test allow an empty snapshot when shared market data exists, but that state cannot be reached by the scheduled handler for a user with no active holding or watch row. Users with a watch row but no holdings are included. There is no safe source/cohort decision in this PR for users with zero tracked rows; deciding whether to enumerate alert settings/profiles changes targeting, cost, and consent semantics. Clarify the intended cohort and add a scoped integration test before claiming zero-tracked-user coverage.
2. **P2 — fixed missing value with fresh change.** `metricLine()` previously emitted `change_display` when `freshness="fresh"` even if `value` was missing/invalid, so the UI could show a day change beside an unavailable value. The guard now requires `showValue && freshness === "fresh"`; a malformed-fresh fixture verifies both value and change remain absent. Fix commit: `7dcf41c5714d620c41b3077376b9f5febbd129b2`.
3. **P2 residual — evidence relevance is semantic, not fully deterministic.** `allowedBasis()` exposes `market_theme`/`macro` to every holding whenever shared themes/cross-asset lines exist. Local validation ensures the basis category exists, hedge language is used, and the Fact-check prompt rejects unsupported or contradictory claims, but code does not independently prove that a particular theme/metric is relevant to each holding's sector. No concrete failing output bypass was established; C2 should decide whether the semantic Fact gate meets the intended guarantee.

## Review assessment

- **Privacy boundary:** the function is server-side, requires the existing cron secret, and does not expose the service-role key to the mobile client. Active tracked rows are grouped by `user_id`; each generation uses only that user's tracked rows and calls `personalized_report_news_inputs` with that same user. The prompt omits user ID/email but intentionally contains that user's ticker/company/sector and portfolio quantities/prices/position. `store:false` is set on the OpenAI request.
- **Morning-to-close isolation:** the query is pinned to the same `user_id`, report type, trading date, completed status, and passed Fact status; returned rows are rechecked for the same user, and unknown stances are ignored. Lookup failure drops the comparison rather than failing open with another user's data. No schema/migration was added.
- **LLM/local validation:** strict JSON schema constrains fields/enums; code validates holding coverage, unknown/duplicate tickers, allowed basis categories, inference hedging, length, numeric packet membership, advice, URLs, dates, markup, and shared-direction contradiction before the semantic Fact call. Fact failure stores no report body and therefore cannot enqueue completion push.
- **Compatibility/UI:** `market_detail` and `holding_impacts` are optional JSON additions; legacy `stock_notes` is retained and built from the same Fact-passed text. Older bodies without `holding_impacts` use the legacy UI path. Missing/stale market data is not offered as a prompt fact; stale values are labeled in the UI. Shared-market packet is not mutated and the X formatter output remains unchanged in tests. No X queue/planner/posting files changed.
- **Files in review fix:** `supabase/functions/personalized-reports/market_detail.ts`, `supabase/functions/personalized-reports/report_upgrade_test.ts` only; commit `7dcf41c...` pushed to PR #19. No source merge or deploy.

## Tests and safety

- Focused personalized-reports plus app-impact tests: **49/49 pass** with `deno test --no-check --no-lock --allow-read`.
- `deno check` for `index.ts`, `market_detail.ts`, `report_logic.ts`: **PASS**.
- `deno lint` for the same three files: **PASS**.
- `git diff --check`: **PASS**.
- Normal type-checked Deno test invocation could not start because this isolated worktree has no cached `npm:@types/node`; no dependencies were installed. Expo web export / app `tsc` were not rerun because the worktree has no Expo/TypeScript `node_modules`. G2's prior K2 run reported those checks passing at the original implementation head; H2 does not claim a fresh rerun.
- production DB/schema/RPC/migration/Function/Cron/settings/Auth/OAuth/Vault/API/X mutation: **0**. No merge, deploy, manual API, Push, or X post. Formal checkout/unrelated workstreams were untouched.

## Remaining decision / next step

- C2 should decide whether a user with zero active holdings **and** zero watch rows is meant to receive a market-only personalized report. If yes, G2 needs an explicit eligible-user source and end-to-end test; do not infer eligibility from alert settings or enumerate users without product approval. If no, adjust the stated/tested zero-tracked guarantee and confirm watch-only accounts cover the accepted requirement.
- Until that is resolved, **PR #19 is not approved to merge**. No production activation is approved by this review.
- control changed_files: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md`.

# Prior H2 reports

# H2 — Phase1D claim-domain DB/RPC/concurrency final review (2026-09-24)

- task_id: `x-autopost-phase1d-db-rpc-concurrency-final-review-20260924`
- status: `review_required`; next_owner: `chatgpt`
- verdict: **PASS-WITH-FIX for a source-only candidate; production activation: NO.** Reviewed `238247a57287c3bb835b6e2a0ca8ee4a2d910fdf` on fresh `origin/main` `334d7a54a51d2c673e08a11957e83cc89f81fe12`; pre-push fresh main advanced only in other slots' `.agent/` files to `927a6445d6e22ec31b60a846e1610786c452db31`. H2 used only its independent clean worktree; the formal repository's existing uncommitted files were not edited, staged, or reset.
- implementation_commit: `4468a06` (`Harden Phase1D bound post guard`, rebased onto fresh main). The six-file source/control tip `7ffc888` was pushed to `origin/main`; a fresh post-push fetch read back both commits and confirmed this Report plus TASK `review_required` / `chatgpt` on GitHub.

## Findings and source-only fix

1. **P1 fixed — bound creation bypass.** After old `claim_due_post()` EXECUTE was revoked, the original trigger allowed a direct bound INSERT without the v2 wrapper. In an isolated PostgreSQL proof, `service_role` directly inserted a bound `running` row with `attempt_count=0` and **zero v2 ledger entries**. The guard now requires the v2 domain on bound INSERT and a `pending`/zero-attempt/no-timestamp initial state. A privileged SQL session can itself set a custom GUC; this marker is a PostgREST/code-path fence, **not** a DB authorization boundary against a privileged SQL operator. No new direct SQL writer should be granted table mutation authority for this purpose.
2. **P1 fixed — routing retag bypass.** The original guard checked only lifecycle columns and `social_account_id`; direct SQL changed a bound row's `post_type` while leaving its status and ledger unchanged (isolated proof: `running`/`interaction`/attempt 0/ledger 0). Bound `brand_id`, `schedule_date`, `post_type`, and `slot_no` are now immutable. Unrelated updates to historical terminal rows remain allowed and tested.
3. **P2 rollout condition — migration atomicity/idempotency.** Phase1D renames nine Phase1B functions before recreating their public wrappers and is not idempotent. Applying it statement-by-statement without a transaction could strand v2 RPC names on a mid-file failure. A separately approved rollout must verify the production migration executor's transaction behavior and apply Phase1B→Phase1D atomically with a fail/rollback rehearsal; do not blindly rerun a partially applied migration or use `db push`.
4. **P2 live-definition/activation gap.** The current production `pg_get_functiondef`, grants, table shape, and log-brand behavior were **not re-read in this H2**. Before any application, diff live definitions of the five planners, old claim/retry/fail/complete RPCs and schema/ACL against the source assumptions. The versioned legacy claim preserves the source five-planner order and unbound-only select/update, but production semantic equivalence remains unproved.

## Migration, ACL, concurrency, activation assessment

- Nine Phase1B bodies are renamed byte-for-byte to `_core`; `public`, `anon`, `authenticated`, and `service_role` EXECUTE are revoked on cores, and the same public signatures/defaults/return shapes are recreated as service-role-only wrappers. `SECURITY DEFINER` functions use empty `search_path`. `RETURN QUERY` does not exit the PL/pgSQL function, so the prior transaction-local domain is restored; on an exception the failed statement/subtransaction rolls back its local setting. Nested planner→schedule wrapper was structurally reviewed, not separately load-tested.
- `x_queue_legacy_claim_retired_v2()` checks EXECUTE by all three API roles. A mistaken re-grant closes bound claim/insert fail-closed. Legacy/v2 claims select disjoint NULL/non-NULL domains; retry/reconcile and confirmed/uncertain outcomes stayed separated in the disposable proof. Four competing workers produced one legacy and at least one v2 claim with no duplicate/cross-domain claim; both accounts became claimable. Existing Phase1B cursor prefetch locked **0/2** other turn rows while one claim transaction stayed open: fairness/throughput concern, not a double-claim proof failure.
- Safe activation order remains: live-definition diff → reviewed Phase1B+Phase1D apply → deploy legacy dispatcher switch → drain old invocations → revoke old unpartitioned claim EXECUTE/read-back → keep bound producers and v2 dispatcher OFF until Phase1C exact-account credentials, provider-step outcomes and atomic per-type completion exist. Re-granting old claim after bound rows exist is not a safe rollback. No activation was performed.

## Exact changed files and verification

- changed_files (source): `supabase/migrations/20260924160000_x_autopost_phase1d_claim_domain_partition.sql`, `supabase/functions/x-test-post/claim_domain_partition_migration_test.ts`, `supabase/tests/x_autopost_phase1d_behavior.sql`, `supabase/tests/x_autopost_phase1d_claim_domain_partition.md`.
- changed_files (control): `.agent/tasks/CODEX_TASK_2.md`, `.agent/CODEX_REPORT_2.md` only.
- Baseline original migration bypass proof: **PASS**, using only a disposable local PostgreSQL DB; direct INSERT plus retag succeeded and left no ledger row. Fixed Phase1D behavior+four-worker concurrency+cleanup proof: **PASS**; new negative cases for direct bound insert, already-running insert, routing retag, and terminal unrelated update passed. Phase1B disposable DB behavior: **PASS**. Phase1D focused static tests: **7/7 PASS**. Full `x-test-post`: **416/416 PASS**. `bash -n supabase/tests/x_autopost_phase1d_run.sh`: **PASS**. `git diff --check`: **PASS**.
- PostgreSQL test clusters and databases were under `/private/tmp` only; test DBs were dropped and the cluster stopped. No production mutation, migration, deploy, Cron/settings/OAuth/Vault change, X/OpenAI/Push API call, or X post occurred. H1/G1/G2/G3/G4 files outside the four Phase1D source/test/docs files were not changed. No secrets were displayed.
- next_recommendation: C2 review the four-file guard fix and remaining rollout blockers; keep Phase1D as a source candidate only, and do not authorize production activation until the live-definition diff, atomic migration proof, Phase1C prerequisites, and staged rollback plan pass.

# H2 — Phase 1C account-bound cutover candidate stopped at unsafe integration boundary (2026-09-24)

- task_id: `x-autopost-phase1c-dispatcher-planner-account-bound-cutover-candidate-20260924`
- status: `review_required`; next_owner: `chatgpt`
- result: **CUTOVER CANDIDATE NOT APPROVED / NO DISPATCHER IMPLEMENTATION.** The TASK explicitly requires failing the candidate if existing post-type effects cannot be preserved. The current Phase1B source and live legacy dispatch cannot safely coexist as-is. No partial v2 publisher was added or activated. C2 must review the concrete blockers and split/authorize the necessary queue, per-provider, and completion work before implementation continues.
- source: fresh `origin/main` `1be56db97d89f103bbd822a8f17b3bdf97dd3654` at start; isolated clean clone `/private/tmp/kabumori-h2-phase1c-qghsg8`. Formal checkout's unrelated dirty files were not changed/staged. H1 idle; G1 app Auth E2E; G2 admin PR merge only; no same-file/object overlap at start. Production read-only SQL only.

## Hard blockers (confirmed)

1. **Split-brain claim:** the live `claim_due_post()` selects any due `pending` row without `social_account_id` exclusion, and runs five legacy planners before claiming. Phase1B `claim_due_post_v2()` excludes unbound rows but Phase1B intentionally leaves old claim untouched. A bound row created by v2 would therefore be eligible for **both** dispatchers. This is a direct duplicate/misroute risk. Source: live `pg_get_functiondef(public.claim_due_post())`, Phase1B migration, `x-test-post/index.ts` `claimDuePost()`.
2. **Planner authority absent:** all five live creators — `plan_daily_posts(date)`, `plan_morning_report(date)`, `plan_close_report(date)`, `plan_us_premarket_report(date)`, `plan_weekly_useful_tips(date)` — have no account parameter or account reference in their SQL source. Phase1B only provides an explicit-account `plan_daily_posts_v2`; nothing supplies its trusted account argument. Existing row uniqueness on `(brand_id,schedule_date,post_type,slot_no)` means a legacy planner's unbound row can occupy the same slot before a bound planner runs. A brand's current single X account is **not** proof of intended routing.
3. **Completion is not atomic with the v2 ledger:** Phase1B `complete_post_x_confirmed_v2()` changes `scheduled_posts` and attempt outcome, but does not perform type-specific completion effects or `post_execution_logs`. Existing `complete_*_post` RPCs do those effects in separate transactions and generally change the row to `succeeded` first. Calling either completion first creates a failure gap or an incompatible status for the other. A new versioned, atomic completion contract for every supported type is required; this is not safe to paper over with two HTTP calls.
4. **One X ID is not enough for every type:** `tip` uses `postThreadToX`, issuing multiple X create requests, then records only the first ID. A later thread-part failure can leave a partially published thread. The one-attempt/one-`x_post_id` Phase1B ledger cannot represent per-part confirmed/uncertain outcomes or safely replay them. `morning_greeting` performs X media upload and X post inside `runMorningGreetingManualPublish`, with its own `publish_claims` and Storage receipt; the current helper does not expose the durable v2 provider boundary before the first HTTP request. Wrapping only the outer call would not preserve exact outcome and receipt semantics.
5. **Credential routing remains brand-derived:** `loadBrandContext` fetches the first X social account for a brand using `limit=1`; `loadBrandXTokens` reads the shared Kabumori legacy token store; the AI Lab Vault loader hardcodes its account. None accepts `claim.social_account_id` as the sole authority. Calling the current `postToX` also allows a 401 refresh/re-request after provider start. A new exact-account resolver and a one-request provider adapter are needed before a v2 dispatch can be safe.

## Planner/caller coverage matrix

| Current caller | Post types | Current provenance | Candidate disposition | Ready? |
| --- | --- | --- | --- | --- |
| `claim_due_post` → `plan_daily_posts` | tip, interaction, morning_greeting, brand_post/windows | brand/window only; no account | Explicit trusted account input plus legacy/v2 claim partition and uniqueness handling | NO |
| `plan_morning_report` | morning_report | report settings/brand only | Versioned planner with explicit account input, no brand inference | NO |
| `plan_close_report` | close_report | report settings/brand only | Same; preserve JPX timing/collision rules | NO |
| `plan_us_premarket_report` | us_premarket_report | report settings/brand only | Same; preserve DST/collision rules | NO |
| `plan_weekly_useful_tips` | useful_tip | weekly planner, no account input | Same; preserve eligibility and cadence | NO |
| Direct/manual scheduled row writers | not evidenced in live `pg_proc` insert audit | no trusted mapping proven | Require explicit account or remain legacy; no silent backfill | NO |

## Per-post-type effect audit

| Type | Existing confirmed-X effects that v2 must retain | Gap |
| --- | --- | --- |
| tip | `tips.last_used_at/use_count`, schedule completion, success log | multi-post thread/partial outcomes; atomic ledger completion missing |
| interaction | topic usage, schedule completion, success log, `interaction_post_metrics` | atomic ledger completion missing |
| useful_tip | topic usage, schedule completion, verification metadata in success log | atomic ledger completion missing |
| morning_report | report run status/X ID, schedule completion, source/model/cost success log; shared-report packet path | atomic ledger completion missing |
| close_report | same close-run/linkage, source/model/cost log; shared-report packet path | atomic ledger completion missing |
| us_premarket_report | run status/X ID, schedule completion, source/model/cost log | atomic ledger completion missing |
| morning_greeting | same-day `publish_claims`, generated-image/receipt flow, schedule completion and log | media+tweet two provider calls hidden in helper; dual claim/receipt lifecycle |
| brand_post | AI Lab fingerprint, schedule completion, success log | live completion RPC hardcodes `ai_salaryman_lab_x`; not a generic claimed-account completion |

Phase1B v2 claim itself also does not write the legacy `started` execution log. Pre-X/uncertain/terminal ledger RPCs do not create the existing `failed` execution log. These are required observability side effects, not optional UI details. Important News uses a separate Function/publish path and was not modified.

## Legacy rows and staged cutover

- Read-only live inventory at the audit: **15 pending, 0 running**: AI Lab `brand_post` 6; Kabumori `close_report` 1, `interaction` 1, `tip` 2, `useful_tip` 4. None was due at the query time. Production lacks `scheduled_posts.social_account_id` and `post_queue_attempts_v2`; all these rows are unbound. No row/backfill was changed.
- Brand/post type and the fact that there is presently one verified X account per brand do not prove each row's intended account. Explicit row-level scheduler intent or an operator-approved mapping is required. Until then: allow safe **legacy drain** under the unchanged legacy dispatcher, or manually review/cancel with a separately approved plan. Do not auto-bind.
- Safe future order: (a) review a source migration that partitions old claim to `social_account_id IS NULL` while v2 keeps `IS NOT NULL`, including planner conflict handling; (b) implement exact-account credential resolver; (c) add per-type atomic v2 completion and provider-step ledger contract, especially tip thread and greeting media/receipt; (d) test with fake brands/accounts and concurrent workers; (e) only after separate C2 approval, apply migration, deploy versioned dispatcher gated OFF, drain/dispose legacy rows, activate explicit-account planners and v2 dispatcher atomically. Rollback before any provider request may release only durable pre-X work; after `provider_started`, unknown or confirmed outcomes require reconciliation, never auto-republish.

## Tests, changed files, and safety

- Baseline focused Phase1B static tests **6/6 PASS**; current `x-test-post` plus `_shared/brand` regression **495/495 PASS**, `deno test --no-check --allow-read ...`. Normal `deno test` type-check could not start because this isolated clone lacks the local `npm:@types/node` package; no dependency installation or unrelated package edits were performed. No Phase1C source/test/migration changes were made, so no false new-feature test pass or disposable integration proof is claimed. `git diff --check` checked on the control-only patch before commit.
- changed_files: `.agent/tasks/CODEX_TASK_2.md`, `.agent/CODEX_REPORT_2.md` only. implementation_commit: **none**; control commit/push/read-back result recorded in the sync addendum when available.
- Production mutation **0**: migration/DB write/backfill 0, Function deploy 0, Cron/settings/OAuth/Vault 0, X/OpenAI/Push API invocation 0, X posts 0. H1/G1/G2 and `apps/admin/**` unchanged. No secrets or personal row data were printed.

## Control sync

- The two-file control commit `e20131754808a4dc1a05602972c01a6e3244dbc1` was pushed to `origin/main` after a fresh fetch showed no overlap. A post-push fresh fetch read that exact commit, TASK `review_required` / `chatgpt`, and this Phase1C Report at the head of the remote file. This addendum records the push/read-back; it does not change the cutover decision or any production state.

# H2 — explicit-account X queue and durable outcome candidate (2026-09-24)

- task_id: `x-autopost-phase1b-account-bound-queue-schema-and-outcome-ledger-20260924`
- status: `review_required`; next_owner: `chatgpt`
- result: **source-only candidate complete; NOT a production cutover.** The migration, versioned RPCs, fake-only PostgreSQL proof, static tests, and legacy cutover plan are ready for C2 review. No production mutation, deploy, or X call occurred. The old dispatcher and old RPCs are unchanged and must not be mixed with account-bound rows before a separately approved cutover.
- source: fresh `origin/main` `18cf9393c9ccf967e47fb754ebbbf254cff2ca6f` at start, isolated detached clone `/private/tmp/kabumori-h2-phase1-neo14U`. H1/G1/G2 scope comparison found no same queue table/function/file collision. Formal checkout's existing uncommitted changes were not accessed for editing/staging. Implementation commit after rebase onto fresh `origin/main`: `e3cf07a` (`Add account-bound X queue and durable attempt candidate`). Push outcome is recorded in the control-sync addendum after remote read-back.

## Production read-only compatibility and legacy inventory

- Live `scheduled_posts.id` is uuid; `brand_id` and `social_accounts.id/brand_id/platform` are text. `scheduled_posts` has the brand-scoped `(brand_id,schedule_date,post_type,slot_no)` unique index, but no account ID; `social_accounts` has PK `id` and `(brand_id,platform)` uniqueness. Required `posting_windows` columns exist. Live legacy `claim_due_post` uses `FOR UPDATE SKIP LOCKED` and invokes planners; old retry/fail functions exist. No production SQL write was issued.
- At read-back: 205 `succeeded`, 63 `failed`, 15 `pending`, 0 `running` scheduled rows. Since the live table has no `social_account_id`, all legacy rows are unbound by definition. Historical terminal rows need no routing. The 15 pending rows require individually evidenced, explicit account mapping or operator disposition in a future task; **none was backfilled**.
- Creator audit: `plan_daily_posts` (window/tip/interaction), `plan_morning_report`, `plan_close_report`, `plan_us_premarket_report`, `plan_weekly_useful_tips` currently insert without account ID. The first has a trusted brand window but no trusted account input; the other four likewise have no account input. `x-test-post/index.ts` calls old `claim_due_post`, then `loadBrandContext` from `brand_id` and the old type-specific completion/retry/fail RPCs. Its current account lookup is not a valid substitute for explicit queue binding. See `supabase/tests/x_autopost_phase1b_cutover.md` for exact cutover conditions.

## Source candidate

- Migration `20260924023133_x_autopost_phase1b_account_bound_queue.sql`: nullable `scheduled_posts.social_account_id` with **no default**; fixed generated X platform and composite `(social_account_id,brand_id,target_platform)` FK to `(id,brand_id,platform)`; composite schedule/attempt FK. Cross-brand, missing-account, and non-X bindings fail at DB boundary. Legacy rows remain unbound.
- `post_queue_attempts_v2` stores UUID attempt/claim token, exact post/brand/account/attempt number, `pre_x` → `provider_started` → `finished` phase, canonical outcomes `pre_x_retryable`, `pre_x_terminal`, `x_outcome_uncertain`, `x_confirmed_db_incomplete`, `completed`, stable error code, optional confirmed X ID, and timestamps. Unique attempt number and one-open-attempt index prevent ambiguity. It stores no token, provider body, or other secret. Old execution logs are untouched.
- Nine **new**, service-role-only, SECURITY DEFINER, empty-search-path RPCs: `schedule_account_bound_post_v2`, `plan_daily_posts_v2`, `claim_due_post_v2`, `mark_post_provider_started_v2`, `settle_post_pre_x_v2`, `record_post_x_uncertain_v2`, `record_post_x_confirmed_incomplete_v2`, `complete_post_x_confirmed_v2`, `reconcile_stale_pre_x_v2`. Old planner/claim/retry/fail RPCs are not replaced. The daily v2 planner requires explicit brand **and** account; other report/useful-tip planners remain legacy/unbound until their callers can supply a trustworthy account.
- Fairness: persistent last-served order per `(brand_id,social_account_id)`; v2 claim selects least recently served eligible account, then its oldest due row, with account and post row `FOR UPDATE SKIP LOCKED`. Account-turn rows are created at **schedule time**, not claim time: a first concurrency proof exposed an `ON CONFLICT` wait inside claim, which was removed before final verification. A noisy account cannot continually pass another due account. Claim cap is three attempts. Only durable `pre_x` can be reconciled after at least 15 minutes; provider-started/uncertain/confirmed-X states cannot be auto-reclaimed. The provider-start marker must be committed immediately before the first X HTTP request in the future dispatcher.

## Proof and tests

- Disposable `postgres:16` (fake brands/accounts/posts only): final `BEGIN → fixture → migration apply → behavior/ACL/security/FK/fairness/retry/cap/stale tests → ROLLBACK` **PASS**; read-back found **0** target public tables after rollback. Two distinct brands/accounts progressed. Unbound, cross-brand, missing, and non-X account paths were rejected. Confirmed X ID survived incomplete → completed; duplicate completion was rejected. Uncertain/confirmed-X rows were not re-claimed. Third pre-X failure exhausted the cap. No production DB connection was used for this proof.
- Concurrent two-worker proof: first worker held a claimed fake row for 8 seconds; second worker returned **0 claims within a 3-second statement timeout**, with no duplicate claim. This passed only after moving turn materialization to scheduling.
- New focused static tests **6/6 PASS**. Entire `x-test-post` regression **409/409 PASS** (including the six new tests), `git diff --cached --check` **PASS** for the implementation commit.
- Changed source/test files: the one migration candidate, `account_bound_queue_migration_test.ts`, `x_autopost_phase1b_fixture.sql`, `x_autopost_phase1b_behavior.sql`, and `x_autopost_phase1b_cutover.md`. This Report and the H2 TASK are the only control-file edits. Runtime `x-test-post/index.ts` was **not** changed.

## Next gate and safety

- C2 must review the candidate. A separate approved cutover must bind active planners and dispatcher to the same explicit account, route credentials from the claim's account ID, preserve each post type's domain completion side effects, reconcile legacy pending rows only with direct provenance, and verify history/admin visibility. **Do not apply this migration alone and do not activate v2 claim under the old dispatcher.** No implicit brand→account mapping or `limit=1` fallback is permitted.
- Production migration apply **0**, production DDL/DML/backfill **0**, Function deploy **0**, Cron/settings/OAuth/Vault/secrets changes **0**, X/OpenAI/Push API calls and posts **0**. `apps/admin/**`, H1/G1/G2, and formal checkout uncommitted files unchanged. No personal rows or secrets were printed.

## Control sync

- Fresh `origin/main` changed during H2 only in H1/G1/G2 control files; the isolated source/control commits rebased cleanly with no same-file collision. Pre-push fresh-check confirmed `origin/main` was ancestor and the exact seven H2 files were the only delta. Implementation `e3cf07a` and control `8ffb0174aca90f607fd9d16f54ccc56b250f6f12` pushed successfully to `origin/main` (remote HEAD `8ffb0174aca90f607fd9d16f54ccc56b250f6f12`). Post-push fresh fetch read the H2 implementation commit as an ancestor and the remote TASK as `review_required` / `chatgpt`; the remote REPORT headed this Phase1b task. This addendum records only that verification; production changes remain 0.

# H2 — X autopost Phase 1 queue foundation stopped at account/outcome boundary (2026-09-24)

- task_id: `x-autopost-phase1-common-queue-idempotency-foundation-20260924`
- status: `review_required`; next_owner: `chatgpt`
- result: **STOPPED at the TASK's explicit safe boundary, before source migration/RPC or dispatch changes.** Production `scheduled_posts` has `brand_id` but no target `social_account_id`/account binding. Its status is only `pending/running/succeeded/failed`, and it has no durable X-attempt phase, outcome class, or confirmed X ID. `post_execution_logs` likewise lacks account/outcome fields. Inferring the account from `brand_id`, the current one-account-per-brand uniqueness, or a `limit=1` lookup would silently create the very cross-account routing risk this task forbids. No fallback was invented.
- source: fresh `origin/main` `596f5328ee252ff028546f93349472b05dae3028` in an isolated clean clone. H1 owns Important News caller-auth, G1 mobile release work, G2 `apps/admin/**`; no same-file/object overlap was found. The formal repository's many pre-existing uncommitted changes were left untouched.

## Current queue invariant map

1. Live `claim_due_post()` runs the five existing planners, then claims one globally oldest `pending` due row with `FOR UPDATE SKIP LOCKED`; it atomically changes that row to `running`, increments `attempt_count`, and writes a `started` execution log. There is no per-brand/account fairness or account ID in the row/result. Its service-role-only EXECUTE and SECURITY DEFINER/search_path were read back; dispatch Cron is active once per minute with unchanged command fingerprint.
2. `scheduled_posts` has four statuses and timestamps but no durable provider-attempt boundary or X ID. `post_execution_logs` has `started/succeeded/failed`, optional X ID/error code, and brand ID, but no account ID or canonical retry/outcome state. `publish_claims` protects morning-greeting's `(brand_id,post_type,date_jst)` only; it is not the generic queue claim, and also has no account ID.
3. `retry_scheduled_post()` returns a `running` row to `pending` for morning-report transient pre-X failures; its caller checks `postAttempted` and attempt cap. Generic `fail_scheduled_post()` marks running rows failed. The dispatch outer catch excludes known completion-RPC failures, AI Lab confirmed-X incompletion, and missing X post IDs from generic failure marking, but this is branch-specific, in-memory protection rather than a durable common outcome contract. A runtime termination can erase in-memory knowledge of whether X was called.
4. AI Lab has a special confirmed-X completion error to avoid the outer failure path. Fingerprints and morning-greeting receipts/claims are category-specific, not a reusable brand/account-scoped queue outcome ledger.

## Proposed contract and safe next gate

- Canonical states for a separately reviewed foundation: `pre_x_retryable`, `pre_x_terminal`, `x_outcome_uncertain`, `x_confirmed_db_incomplete`, `completed`. Automatic reclaim must be allowed **only** for a durably proven pre-X retryable attempt, within an explicit attempt cap. Both uncertain-X and confirmed-X/DB-incomplete must be manual reconciliation, never republish. Preserve a known X post ID and stable error code; do not persist provider bodies, tokens, or secrets.
- Minimum schema/API proposal: bind every planned `scheduled_posts` row to an explicit `social_account_id` validated against the same `brand_id` and X platform, with a composite DB integrity constraint. Add a durable per-attempt identity/phase/outcome record (or equivalent guarded columns) including provider-call-started marker, claim token, stable error code, optional confirmed X ID, timestamps, and account/brand scope. Do not give legacy rows an implicit account default; their mapping/backfill needs separate reviewed evidence and cutover policy. Planners and the publisher must write/read the same explicit account binding before a new claim RPC can be activated.
- Claim/fairness candidate after that gate: new versioned, service-role-only RPC; bounded per-(brand,account) eligibility, a persistent last-served cursor or equivalent rotation, `FOR UPDATE SKIP LOCKED` plus atomic status/attempt update, and a unique claim token. Reject missing/mismatched brand/account. Keep the live `claim_due_post()` unchanged until all callers and rows are compatible. A 15-minute-plus stale threshold may identify candidates for review, but stale alone is **not** evidence that X was never called; only a durable pre-X phase can return to retryable. Confirmed/uncertain outcomes remain non-claimable.
- Disposable PostgreSQL fairness/concurrency/rollback proof, migration/static assertions, focused tests, and `x-test-post` regression were **not run**: no account-bound source candidate was safely constructible from the current live contract. This is the explicit stopping condition, not a claimed test pass. After C2 approves the schema/API gate, use fake-only fixtures to prove two-brand progress, no double claim, account isolation, retry/stale gates, and rollback before any production proposal.
- changed files: this H2 TASK and `.agent/CODEX_REPORT_2.md` only. Source/test/migration changes 0. Production DB, migration, Edge Function, Cron, OAuth/Vault, X/OpenAI/Push calls, and posts: **0**. No `apps/admin/**`, H1, G1, or G2 file was modified. Control-only commit/push result is recorded in a follow-up note after remote verification.

## Control sync

- The two-file control-only commit `c7482d4ca2479295d4125ee9164c6bb225f8a237` was pushed to `origin/main` after a fresh fetch found only unrelated G1 control-file changes. A post-push fresh fetch read that exact commit from `origin/main`; the remote H2 TASK showed `review_required` / `chatgpt`, and the remote REPORT headed this Phase 1 task. This addendum records the read-back only; there were no further source or production actions.

# H2 — X autopost Phase 0c2 production rollout completed (2026-09-24)

- task_id: `x-autopost-phase0c2-production-deploy-retry-20260924`
- status: `review_required`; next_owner: `chatgpt`
- result: PASS for the approved rollout order. A single `x-test-post` retry succeeded, runtime source was verified, a non-publish smoke passed, and only the exact reviewed brand-scoped uniqueness migration was applied. Stop for C2; no further production action is authorized by this report.
- source: fresh `origin/main` `f4052705d7cd04ecd86eb8e784c4eb4ed8729a59` at deploy, containing approved Phase0b commit `76dfe748b7fc9c34725c4fd8af6e52afcc6a6fd4`. No changes to `x-test-post`, its imported `_shared` files, or the Phase0c migration since that commit. Work was in a detached temporary clean worktree; the formal repo and unrelated uncommitted changes were untouched.
- diagnostic: the first Phase0c deploy attempt had returned HTTP 500 after asset upload. Before this retry, local `deno info --json --no-remote` resolved all 42 imported modules without graph errors; the deploy source under `x-test-post` plus `_shared` occupied about 1 MB. `deno check --no-remote index.ts` still found six existing type errors in unchanged source; no scope-expanding fix was made. The one successful retry suggests the prior 500 was transient or server-side, but its exact root cause is unproven. No alternative bundle/deploy method was tried.
- consent/retry: user replied `おk` directly to the explicit Phase0c2 retry → runtime verify/safe smoke → fresh schema preflight → exact migration request. Exactly **one retry** was performed using `supabase functions deploy x-test-post --project-ref wsmznyzcvmuitkglfeuj --no-verify-jwt --use-api`; no automatic second retry.
- preflight: production was still `x-test-post` v118 ACTIVE, `verify_jwt=false`, bundle hash `f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4`. Three exact legacy global UNIQUE constraints and three valid brand-scoped unique indexes were present; `brand_id` was NOT NULL and scoped duplicate excess was 0 on all three tables. Four planners each had exactly one old conflict target and retained SECURITY DEFINER, `search_path=public`, and `service_role` EXECUTE. Dispatch Cron fingerprint/schedule matched the previous audit; migration was absent from production history.
- deploy read-back: `x-test-post` **v119 ACTIVE**, `updated_at=1790208699428`, `verify_jwt=false`, bundle SHA-256 `4642f128a14d7eb8a269f6d50023956f33d0762f3a0dd91b8b6fdc3ef3d0d322`. `supabase functions download x-test-post --use-api` retrieved 42 runtime source files; all 42 compared byte-for-byte equal to the approved origin source, including `index.ts`, `morning_greeting_publish_logic.ts`, and `publish_claim_logic.ts`. A single unauthenticated GET, rejected before body/privileged dispatch, returned expected HTTP 405; no POST or publish action was invoked.
- fresh migration preflight after deploy: all three old constraints, all three valid scoped indexes, zero scoped duplicates, four old planner targets with unchanged security/EXECUTE, unchanged Cron fingerprint, and unchanged `publish_enabled` aggregate were reconfirmed. The runtime remained v119 with the same hash.
- migration: applied exactly `supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql`, SHA-256 `4150f0735993bbdcaad2c735f5965b6d8af4c8cc4e6a827798e1f0b6936cfd9d`, through one `apply_migration` call. Result `success=true`; production migration history version **`20260924001508`**, name `x_autopost_phase0_brand_scoped_uniqueness`. No `db push`, history repair, older foundation replay, or rewritten/ad-hoc SQL.
- postflight: all three legacy global UNIQUE constraints are absent; three brand-scoped unique indexes are valid/ready/unique; `brand_id` remains NOT NULL and scoped duplicate excess remains 0. Each of the four planners now has exactly one `ON CONFLICT (brand_id, schedule_date, post_type, slot_no) DO NOTHING` and zero old targets. Each retains SECURITY DEFINER, `search_path=public`, and `service_role` EXECUTE with the expected ACL. `x-test-post` remains v119 ACTIVE with the same runtime hash; no unrelated Function's version/updated_at/hash changed. Dispatch Cron remains active on `* * * * *` with the same command fingerprint; `publish_enabled` aggregate remains 2 true / 1 false. OAuth/Vault/token and Netlify/Vercel were not touched.
- mutation counts: successful Function deploy **1** (`x-test-post` only); production migration apply **1** (the exact approved file); other Function deploy 0; Cron/settings/OAuth/Vault/secrets/Netlify/Vercel writes 0; manual publish/media/repost/OpenAI/Push API calls 0. Natural scheduled activity was not disabled or manually invoked.
- changed repository files: `.agent/tasks/CODEX_TASK_2.md` and `.agent/CODEX_REPORT_2.md` only. Code/source/migration files were not edited in this task. Control-file commit/push and final fresh-origin read-back are recorded in the follow-up control-sync note below.
- remaining risks: no synthetic production cross-brand DML was created; rely on prior disposable PostgreSQL proof and natural operation for behavior. The older multibrand foundation migration marker remains absent from production history, so blind `supabase db push` or old migration replay remains unsafe. C2 should review the rollout evidence before any further production change.

## Control sync

- Initial control-only commit `fb1116ed0d27066821d52fe5ee416cbb5f727db9` changed exactly `.agent/CODEX_REPORT_2.md` and `.agent/tasks/CODEX_TASK_2.md` and was pushed to `origin/main` after a fresh fetch found no conflicting change.
- A fresh post-push fetch read `origin/main=fb1116ed0d27066821d52fe5ee416cbb5f727db9`; the remote H2 TASK contained `status: review_required` / `next_owner: chatgpt`, and the remote REPORT headed this Phase0c2 task. This final note is a report-only follow-up; no code or production action accompanied it.

# H2 — X autopost Phase 0c production rollout stopped at Function deploy (2026-09-24)

- task_id: `x-autopost-phase0c-production-brand-scope-rollout-20260923`
- status: `review_required`; next_owner: `chatgpt`
- result: **STOPPED before migration.** The one authorized `x-test-post` deploy attempt returned Supabase Functions API HTTP 500 (`Function deploy failed due to an internal error`). No retry or alternative deploy was attempted.
- source: fresh `origin/main` advanced through H1-only control changes to `93c3563` before deploy. Approved Phase0b commit `76dfe748b7fc9c34725c4fd8af6e52afcc6a6fd4` is an ancestor; no `x-test-post` source or Phase0c migration changes appeared since the previously reviewed source. A detached clean worktree at `/private/tmp/kabumori-h2-phase0c-rollout` was used; the formal repo and its pre-existing edits were not touched.
- consent: the user replied `おk` directly to the immediately preceding explicit production deploy → verify → exact migration confirmation request. This met Gate B; it did not authorize bypassing a failed Gate C.
- Gate A read-only preflight: `x-test-post` v118 ACTIVE, `verify_jwt=false`, bundle SHA-256 `f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4`; three exact legacy global UNIQUE constraints remained; the three brand-scoped unique indexes were valid; `brand_id` was NOT NULL and scoped duplicate excess was 0 on all three tables. All four planner RPCs had one old conflict target each, SECURITY DEFINER, `search_path=public`, and `service_role` EXECUTE. The active dispatch Cron still targeted `x-test-post` with unchanged schedule and command fingerprint. Phase0c migration was absent from production history. The previously disclosed missing older multibrand foundation history marker remains; no new drift was detected.
- approved migration file: `supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql`, SHA-256 `4150f0735993bbdcaad2c735f5965b6d8af4c8cc4e6a827798e1f0b6936cfd9d`. **Not applied.** No `supabase db push` or history repair was used.
- Gate C deploy: exactly one `supabase functions deploy x-test-post --project-ref wsmznyzcvmuitkglfeuj --no-verify-jwt --use-api` attempt from the clean worktree. CLI uploaded assets, then returned `FunctionsApiStatusError`, HTTP 500, `Function deploy failed due to an internal error`. The worktree-local temporary `supabase/config.toml` specified only the project ref and `verify_jwt=false`; it is untracked and was not committed.
- deploy read-back: `x-test-post` remains v118 ACTIVE, `updated_at=1789652263153`, `verify_jwt=false`, same bundle SHA-256 as before. Thus there is no evidence of a completed deploy. No safe smoke was run because runtime verification could not pass. No Gate D fresh migration preflight, Gate E apply, or Gate F postflight was attempted.
- production mutation counts: successful Function deploy 0; migration/DB write 0; Cron/settings/OAuth/Vault/secrets 0; other Function deploy 0; intentional X/OpenAI/Push API invocation and X posts 0. Natural scheduled activity was not disabled or changed.
- remaining risk/next step: C2 should review the deploy API 500 and decide whether a separately approved retry is appropriate. Do not apply the migration until a successful compatible-client deploy, runtime source/hash comparison, safe smoke, and fresh schema/planner preflight all pass.

# H2 — X autopost Phase 0b brand-scoped publish claim and forward migration candidate (review required, 2026-09-23)

- task_id: `x-autopost-phase0b-publish-claim-brand-scope-and-migration-reconciliation-20260923`
- status: `review_required`; next_owner: `chatgpt`
- source_base: fresh `origin/main` `4ff252132b6b4613ccd52508a387ad743c3b433b`; only H2 source/control files were changed in an isolated clean worktree. H1 is a separate `important-news-monitor` caller-auth task; G1 idle and G2 done. No file, migration, RPC, or production-setting overlap was found.
- implementation_commit: `76dfe74` (`Scope X publish claims and schedule conflicts by brand`), pushed to `origin/main` from the isolated worktree after a fresh fetch confirmed an unchanged base and only the ten listed source/test files in the commit.

## Exact source changes and trusted identity

- `claimPublishSlot` now requires a nonblank `brandId` at type and runtime boundaries, explicitly sends `brand_id`, and uses `on_conflict=brand_id,post_type,date_jst`. It still ignores an existing claim regardless of status; there is no automatic reclaim or retry.
- `completePublishSlot` and `failPublishSlot` require the same brand and PATCH only `brand_id + post_type + date_jst + status=publishing`. Missing/blank brand fails before any network request. Existing confirmed-X completion/failure handling and receipt behavior were not changed.
- Both `runMorningGreetingManualPublish` callers pass `brandContext.brand.id`. The manual HTTP path obtains that context from the server-side literal `brandId: "kabumori"` after admin authorization; the scheduled path obtains it from the server-claimed `scheduledPost.brand_id` (with the existing explicit legacy-Kabumori row fallback) and `loadBrandContext`, not from client JSON. No new client-selectable brand, account, or token authority was introduced.
- Mock tests prove different brands can claim one type/day independently, same-brand duplicates are blocked, complete/fail for one brand do not mutate the other brand, the exact conflict target/body are sent, a missing brand makes zero network calls, and confirmed-X/no-retry behavior remains intact.

## Planner and migration candidate

- The exact four live planners—`plan_daily_posts(date)`, `plan_morning_report(date)`, `plan_close_report(date)`, and `plan_us_premarket_report(date)`—still contained one `ON CONFLICT (schedule_date, post_type, slot_no) DO NOTHING` each. The source-only forward migration verifies each routine's identity/security and exactly one old target, then replaces only that target with `ON CONFLICT (brand_id, schedule_date, post_type, slot_no) DO NOTHING`. Existing bodies, other filters, SECURITY DEFINER, `search_path=public`, and EXECUTE grants are preserved. No queue fairness or other planner behavior was changed.
- The migration first asserts the exact three old table UNIQUE constraints, valid brand-scoped unique indexes, NOT NULL `brand_id`, and absence of scoped duplicates. It then drops only the old globals on `posting_windows`, `scheduled_posts`, and `publish_claims`. A failed assertion aborts the transaction. This is a review candidate, **not applied to production**.
- Historical `posting_windows` seed upserts still target `(post_type,slot_no)` in earlier migration files. They are migration-time only, not live RPCs; do not replay them against a live post-Phase0 schema. A future clean-bootstrap/source-history reconciliation must explicitly rewrite or supersede those historical seed steps without rewriting applied history.
- Live brand columns/scoped indexes exist, while the older foundation migration's source commit is not in current `origin/main` ancestry and version `20260910170000` is absent from production migration history. A blind replay could duplicate objects, collide with current data, or misstate applied provenance; `db push`/history repair is unsafe. For this live deployment, use the new forward migration's fail-closed shape assertions rather than backfilling/replaying the old DDL. No production history marker is required to execute this exact forward migration; an idempotent source bootstrap/baseline for clean environments is a separately reviewed task, not a fake history repair.

## Verification

- Fresh read-only production catalog check reconfirmed the three old constraints, `publish_claims.brand_id` NOT NULL/default `kabumori`, and all four planners' old conflict targets; all four planner routines remain SECURITY DEFINER with `search_path=public` and `service_role` EXECUTE. No production row values or secrets were printed.
- Targeted publish-claim/morning-publish/migration tests: **35/35 passed**. Full `x-test-post` regression: **403/403 passed**. `deno check --no-remote` on changed `publish_claim_logic.ts`: **passed**. Checking the imported morning-publish dependency graph reports two existing unrelated type errors (`_shared/x_oauth2_post.ts` BufferSource and `morning_greeting_logic.ts` retry_count); the same two errors reproduce on untouched `origin/main`. No scope-expanding edits were made. `git diff --check`: **passed**.
- Disposable PostgreSQL 16 proof: fake production-shaped old constraints, scoped indexes and non-null brand columns applied; candidate migration applied; two brands shared the same posting-window slot, scheduled-post slot/day, and publish-claim type/day; same-brand duplicates were rejected; all four updated planner calls worked, including repeat idempotency; SECURITY DEFINER/search_path/EXECUTE were unchanged; behavior writes rolled back; reverse script restored the three old global constraints and baseline rows. The disposable container was stopped and auto-removed.
- Changed files: `supabase/functions/x-test-post/{index.ts,morning_greeting_publish_logic.ts,morning_greeting_publish_logic_test.ts,publish_claim_logic.ts,publish_claim_logic_test.ts,multibrand_uniqueness_migration_test.ts}`, `supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql`, and the three `supabase/tests/x_autopost_phase0_uniqueness_{fixture,behavior,rollback}.sql` proof files. This REPORT and H2 TASK are the only subsequent control-file changes.
- Production mutation: **0**. Migration apply 0, Function deploy/invoke 0, Cron/settings 0, OAuth/Vault/token 0, OpenAI/X API and X posts 0. Formal repo's unrelated uncommitted changes were not touched.

## Next production gate (not authorized now)

C2 must review the migration/source-history caveat and code diff. If separately approved, deploy the brand-scoped `x-test-post` client first while the old global keys still exist, verify runtime source/setting, then fresh-read live schema/data/planner definitions and apply only the exact forward migration with read-back. Do not apply the migration before the compatible client is active. A clean-environment migration-chain reconciliation remains separate; never use `supabase db push` or blind history repair.

# H2 — X autopost Phase 0 uniqueness migration proof (blocked for C2, 2026-09-23)

- task_id: `x-autopost-phase0-disposable-global-uniqueness-migration-proof-20260923`
- result: **Production preflight and disposable proof completed, but the forward migration is not approved as a complete candidate. Stop for C2 because the current `x-test-post` publish-claim client depends on the legacy global conflict target, while this Phase explicitly forbids publisher-code changes.**
- source_base: fresh `origin/main` `f4e1fe98b679d6a7e29c3c7d150ddad0312085b8`; task and coordination docs were read from that commit. H1 is a separate read-only release audit, G1 is idle, G2 is done; no slot overlap found.
- push_preflight: fresh `origin/main` recheck advanced to `f6881db976670bcfac7a441a0defc8996e6340af`; only `.agent/tasks/CODEX_TASK.md` changed since the implementation base, so there is no H2/report/source conflict. The control-only update is being rebased onto this latest base; no H1 file will be included.
- production_scope: read-only catalog, aggregate, routine-definition, and migration-history queries only. Production DDL/DML = 0; migration apply = 0; Function deploy/invoke = 0; Cron/settings/OAuth/Vault/X changes = 0.

## Production preflight

The three legacy blockers are named table UNIQUE constraints (not standalone indexes):

| Table | Legacy UNIQUE constraint | Intended existing brand-scoped unique index | Live rows / null brand_id / scoped duplicate excess |
|---|---|---|---|
| `posting_windows` | `posting_windows_post_type_slot_no_key` (`post_type, slot_no`) | `posting_windows_brand_post_type_slot_key` (`brand_id, post_type, slot_no`) | 19 / 0 / 0 |
| `scheduled_posts` | `scheduled_posts_schedule_date_post_type_slot_no_key` (`schedule_date, post_type, slot_no`) | `scheduled_posts_brand_schedule_slot_key` (`brand_id, schedule_date, post_type, slot_no`) | 267 / 0 / 0 |
| `publish_claims` | `publish_claims_post_type_date_jst_key` (`post_type, date_jst`) | `publish_claims_brand_post_type_date_key` (`brand_id, post_type, date_jst`) | 15 / 0 / 0 |

For all three, `brand_id` is NOT NULL with default `kabumori`. The scoped keys are separate valid unique indexes. Read-only aggregate duplicate-excess count was 0 for each. Eight relevant FK definitions reference either `brands.id`, or `scheduled_posts.id`; none references a removed conflict key.

Four live planner RPCs use the old `scheduled_posts` conflict target: `plan_daily_posts(date)`, `plan_morning_report(date)`, `plan_close_report(date)`, and `plan_us_premarket_report(date)`. The historical migration source also contains `posting_windows` seed upserts, but those are migration-time operations; no live routine source referenced the old posting-window conflict target.

Critical remaining dependency: `supabase/functions/x-test-post/publish_claim_logic.ts` issues PostgREST `on_conflict=post_type,date_jst`, inserts no explicit `brand_id`, and its completion/failure PATCH filters omit `brand_id`. After removing the global `publish_claims` key, that upsert target is no longer backed by a unique constraint, and row updates would not be brand-scoped. Correcting this requires a narrowly scoped publisher caller change (pass trusted `brand_id`, use the scoped conflict target, and scope PATCH filters). The task says not to change publisher code in this phase, so this is the required stop condition—not something changed or worked around.

## Migration history/source finding

The production columns/indexes are represented in historical commit `5806e856d4ef0d146c0d11f6728777c05deb23f7` (`20260910170000_add_multibrand_brand_context_foundation.sql`), but that commit is not an ancestor of current `origin/main`; it exists on `origin/feature/multibrand-foundation` and several Codex branches. Production migration history did not list version `20260910170000`. The current `origin/main` migration chain therefore does not contain the source migration establishing the live `brand_id` columns and scoped indexes. This is a source/history drift that must be reconciled in a separate reviewed gate; no history repair was attempted.

## Disposable proof and local draft

A fake-only PostgreSQL 16 container named `codex-h2-phase0-pg-20260923` used a minimal production-shaped baseline: the exact three legacy constraints, exact scoped indexes, non-null/default `brand_id`, representative fake legacy rows, and four SECURITY DEFINER planner fixtures. The draft migration applied successfully. Within a rolled-back proof transaction:

- different brands could insert the same posting-window slot, scheduled date/type/slot, and publish-claim date/type;
- same-brand duplicates were rejected for all three keys;
- the planner fixture created the same slot for both brands and repeated calls stayed idempotent;
- `service_role` EXECUTE, SECURITY DEFINER, and `search_path=public` remained intact;
- representative legacy row counts remained 1 per table.

The rollback script restored all three original global UNIQUE constraints and old planner targets; read-back found 3 restored constraints and exactly the 3 baseline rows. The disposable container was stopped/removed, with no leftover proof container or test data.

Draft-only caveat: `supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql` plus fixture/proof files exist only as uncommitted work in `/private/tmp/kabumori-h2-phase0`. They are **not a complete or rollout-ready candidate** because the publish-claim caller dependency above is unresolved. They were not committed or pushed.

## Tests and changed files

- Focused static + publish-claim + morning-publish tests: **32/32 passed**.
- Full `x-test-post` regression: **400/400 passed**.
- Disposable PostgreSQL apply / behavior / rollback proof: **passed** for the tested SQL/planner fixture.
- `git diff --check`: passed.
- `deno check --no-remote`: not completed; environment lacks `npm:@types/node`. No dependency install or manifest change was made.
- Local draft files: `supabase/migrations/20260923102327_x_autopost_phase0_brand_scoped_uniqueness.sql`; `supabase/tests/x_autopost_phase0_uniqueness_fixture.sql`; `supabase/tests/x_autopost_phase0_uniqueness_behavior.sql`; `supabase/tests/x_autopost_phase0_uniqueness_rollback.sql`; `supabase/functions/x-test-post/multibrand_uniqueness_migration_test.ts`; `supabase/functions/x-test-post/publish_claim_logic.ts`; `supabase/functions/x-test-post/publish_claim_logic_test.ts`; `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`; `supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`; `supabase/functions/x-test-post/index.ts`. All are isolated local draft changes and were not pushed.
- Shared change in this report-only commit: `.agent/CODEX_REPORT_2.md`, `.agent/tasks/CODEX_TASK_2.md`.

## Gate recommendation / safety

Do not apply the draft migration. First authorize a separate minimal `x-test-post` publish-claim brand-scoping change and its regression tests, plus decide how the unmerged brand-foundation migration/history drift will be resolved. Then rerun fresh production read-only preflight and disposable apply/rollback against the approved complete source set. Only after C2 PASS should an exact production migration apply be separately authorized. No production rows were printed or changed; no secret or personal record was exposed.

- status: `review_required`
- next_owner: `chatgpt`
- implementation commit/push: none (draft blocked)
- report/task control-sync: `5c6dc33eb3f8d8fb91928a71568963ecf57447e9` pushed the TASK/Report update. Read-back confirmed the update; Report-only follow-up `3a21b2cf411ca22be4a9d8ebb2285f96b40412db` records that check and was pushed. Final fresh read-back confirmed `origin/main` at `3a21b2cf411ca22be4a9d8ebb2285f96b40412db`, TASK `review_required / chatgpt`, and this Report section present.

# H2 — X autopost foundation / multibrand / Netlify readiness audit (review required, 2026-09-23)
# H2 — Social mobile Phase 23 dedicated QA one-shot history read (review required, 2026-09-23)

- task_id: `x-autopost-foundation-audit-multibrand-netlify-roadmap-20260923`
- result: **Read-only audit complete; C2 review requested.** No source, production schema, Function, Cron, OAuth, account setting, or Netlify/Vercel configuration was changed.
- source_base: audit began from clean `origin/main` snapshot `e7f3d1fcd56a7cbdd1f6b6390e441803cc2c62dd` in isolated `/private/tmp/kabumori-x-foundation-audit`; the formal `/Users/yuya/Developer/kabumori` checkout and its unrelated changes were not used or touched. `PROJECT_RULES.md`, `HANDOFF.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, both Codex task scopes, and both Claude task scopes were read. H1 is a separate release-readiness audit; G1 is idle and G2 is done. The scopes are read-only and have separate Codex control files; no write conflict was found.
- scope: reviewed X posting source and shared brand modules, related OAuth/token paths, production schema/catalog/policies/indexes, relevant Cron/function metadata and aggregate row counts, plus `apps/admin` and current Netlify documentation. All production queries were read-only and aggregate where data could identify people/accounts. No secret/token/raw command value was requested or recorded.

## Executive summary

The current product is **partially multibrand, not ready for independent multi-brand posting at scale**. Database rows carry `brand_id`, memberships and account-specific OAuth/Vault structures exist, the AI Lab has one dedicated scheduled `brand_post` route, and user workspaces have isolated preview/history-learning paths. But the production scheduler still claims one global oldest due row, three important unique indexes still enforce global rather than brand-scoped keys, and the ordinary token/generator path remains Kabumori-specific. A second account per brand is not supported by safe account selection (`limit=1`, no deterministic/cardinality fail-closed); cross-brand exact-text dedupe and fingerprint completion are wired only into the AI Lab path.

The management UI can move to Netlify without moving the posting core. It is a Next.js 16 App Router app with cookie-backed Supabase SSR, protected Server Components, several force-dynamic data pages, a Server Action for operational toggles, and a Next 16 `proxy.ts`; therefore the existing app would use Netlify's Next adapter-generated serverless/edge functions. A nearly-static UI is possible only after deliberate architecture/security changes (for example, moving writes to narrow user-JWT Supabase RPC/Edge APIs and client-side RLS reads); current RLS/grants do not permit all current admin reads to become browser-side. Keep the existing Vercel Production until a Netlify preview/canary and usage check pass.

## 1. Current platform inventory / completed pieces

### Production baseline (read-only snapshot, 2026-09-23 JST)

- Supabase project ref `wsmznyzcvmuitkglfeuj` (`stock-x-autopost`). Relevant ACTIVE Functions: `x-test-post` v118 (`verify_jwt=false`); `x-oauth-connect` v25 (`false`); `x-oauth-connect-user` v6 (`false`); `social-mobile-brand-dry-run` v3 (`true`); `social-mobile-history-learning` v4 (`true`); `important-news-monitor` v64 (`false`). `send-push-notifications` v22 and `personalized-reports` v20 were also ACTIVE. Versions are metadata only; no Function was invoked or deployed.
- Active X scheduler Cron: `dispatch-scheduled-posts`, `* * * * *`, calls `x-test-post`. Important News has separate fetch/judgement/generation/publish-ready schedules; those are outside the proposed X-core rewrite and remain unchanged. Cron command bodies were not retrieved into the report.
- Production counts: 4 brands; 3 X social-account rows, all identity-verified; 2 accounts publish-enabled and 1 disabled. Brand distribution: one brand has no X account, three have exactly one, none has multiple; two brands are active+live, two are not live. Thus live data proves multi-brand configuration exists, but does **not** demonstrate multi-account-per-brand operation.
- Operational rows: `posting_windows` 19; `scheduled_posts` 267 (199 succeeded / 60 failed / 8 pending); `post_execution_logs` 643 (254 succeeded / 69 failed / 320 started); `publish_claims` 15; `published_content_fingerprints` 51; `daily_content_plans` 0. `started` log rows are historical log events and are not evidence that 320 jobs are currently running. Counts are a snapshot, not a trend or quality judgment.
- RLS is enabled on the inspected brand/scheduler tables. Authenticated SELECT policies for `brands`, `social_accounts`, `brand_memberships`, `posting_windows`, `scheduled_posts`, and `post_execution_logs` are membership- or admin-scoped. `brand_settings` and `daily_content_plans` do not expose authenticated SELECT in the observed grants/policies; operational secrets stay on server-side service-role paths. The web admin's authenticated `admin_users` check is separate from social-mobile ownership.

### Current source shape

- `supabase/functions/x-test-post/index.ts` remains the production monolith: scheduled claim, account/context resolution, token dispatch, post-type branches, external providers, X publish and completion/error paths share one entrypoint.
- `claim_due_post()` plans due content and claims at most **one global oldest due pending row** per invocation (`scheduled_for`, `FOR UPDATE SKIP LOCKED`, then running/attempt increment and a started execution log). It has no `brand_id` partition or per-brand fairness. A single every-minute Cron is adequate for the current volume but is not a fair per-brand scheduler contract.
- Context reads are server-side and keyed from the scheduled row; missing legacy `brand_id` falls back explicitly to `kabumori`. `loadBrandContext()` reads a brand, then X account and settings using `limit=1`; no `ORDER BY` or uniqueness/cardinality assertion guarantees which account is selected if a brand gains multiple X accounts. Brand/account ID mismatches and missing profile/settings fail closed after selection.
- `assertBrandPublishAllowed()` checks active brand, `publish_mode=live`, and a present `publish_enabled` X account. It is a useful common final gate but does not itself prove `connection_status=identity_verified`; the AI Lab resolver does that separately.
- Code profiles are allowlisted in `brand_profiles.ts`: Kabumori, AI Lab, and neutral social-mobile user. An unrecognized `code_profile_key` fails closed; adding a brand is therefore not fully DB/config-only and requires a reviewed code profile.
- `brand_post_generator.ts` is a reusable, profile/settings-driven OpenAI generator for its configured `brand_post`/preview types. Most existing Kabumori generators remain in `index.ts` and are not re-expressed through that generic generator.

### OAuth / token / dedupe status

- `x-oauth-connect` is the existing privileged/admin/legacy OAuth path; `x-oauth-connect-user` is the user/workspace account-onboarding path. Both are distinct from publish dispatch. The social-mobile preview/history Functions do not publish.
- In the publisher, AI Lab `brand_post` routes through `loadAiLabVaultBackedXTokens()`: exact brand/account/handle binding, `identity_verified`, `publish_enabled`, both Vault references and a service-role-only reader; refresh is explicitly disabled in that route. This is brand-specialized rather than reusable account routing.
- Other brands enter `loadBrandXTokens()`, which rejects any brand other than `kabumori` and then uses the legacy shared `oauth_token_store` plus environment fallback. The generic Vault loader is a helper, not a general production resolver wired for every social account. Do not infer that user-workspace OAuth completion implies production X publishing is enabled.
- `published_content_fingerprints` exists, is account/X-post unique, and contains 51 rows. Cross-brand logic normalizes and hashes exact text, with a 30-day window; it is not semantic dedupe. The source comment says actual persistence was intentionally not wired to Kabumori's path. In practice, read/fingerprint/complete wiring is on the dedicated AI Lab scheduled `brand_post` route; it also adds a strict Kabumori report fingerprint reader. It does not yet provide a common all-brand publish-completion contract.
- AI Lab post completion has a useful duplicate-safety pattern: after confirmed X post, completion uncertainty raises a special error that bypasses ordinary failure/requeue handling. This must become a common invariant before more publishers are enabled.

## 2. Multibrand blockers (severity)

### P0 — production database still has global uniqueness conflicts

Read-back of live `pg_indexes` found brand-scoped indexes **and** legacy global unique indexes/constraints simultaneously:

| Table | Intended brand-scoped unique index present | Still-active global unique index | Impact |
|---|---|---|---|
| `posting_windows` | `(brand_id, post_type, slot_no)` | `(post_type, slot_no)` | Two brands cannot define the same post-type slot. |
| `scheduled_posts` | `(brand_id, schedule_date, post_type, slot_no)` | `(schedule_date, post_type, slot_no)` | Two brands cannot schedule the same type/slot/date. |
| `publish_claims` | `(brand_id, post_type, date_jst)` | `(post_type, date_jst)` | Same-day claim namespaces collide across brands. |

This is a concrete rollout blocker even though the brand-specific indexes exist. A future migration must preflight conflicting rows, explicitly replace/remove only obsolete global uniqueness, and prove rollback and concurrent insert semantics in disposable PostgreSQL before any production approval. Do not blindly drop constraints or run `supabase db push`.

### P1 — publisher routing and account cardinality are not generalized

- `x-test-post` handles arbitrary brand context only partially: legacy null brand resolves to Kabumori; non-AI-Lab non-Kabumori is rejected at the token resolver. The only generic branded scheduled live path is currently AI Lab `brand_post`.
- `loadBrandContext()` silently chooses first account/settings row (`limit=1`). A multiple-X-account brand needs an explicit server-owned `social_account_id` binding or fail-closed exact-one rule, uniqueness guarantees, and deterministic credential routing. Never trust a client account/token selector.
- Publish gate should require the selected account's identity verification and usable token state as appropriate for all brands, not only AI Lab.
- Profile allowlist and supported post-type routing require code additions today; operational settings do not by themselves safely add a brand.

### P1 — queue, retries and logs are global / ambiguous

- Global oldest-row claiming can let one brand dominate or delay another and does not expose per-brand queue lag/fairness. Claim includes `brand_id` in execution logs, but the slot/idempotency and lock boundary is not globally generalized.
- `publish_claims` global key (above) is unsafe for same-type/day brands. Retry counters/status live across `scheduled_posts` and append-only `post_execution_logs`; a started log is not a definitive live-run ledger. Future design should distinguish safe pre-X retry, uncertain-X outcome, confirmed-X-but-DB-completion-failed, and terminal failure, with bounded attempts and observable per-brand run keys.
- AI Lab's completion-after-X special case is not yet shared by normal X publish branches; apply a uniform exactly-once/uncertain-result policy before broadening.

### P1 — cross-brand duplicate guard is narrow and not common

- Exact normalized text only, no semantic similarity (intentional today). Persistence/read is wired to AI Lab branch, not every brand's success path. A read limit of 200 can truncate the 30-day candidate horizon under high volume. Add common bounded/account-aware persistence, monitor coverage/limit, and keep semantic/event dedupe separate from exact-text collision to avoid overblocking legitimate distinct brand commentary.

### P2 — readiness/admin breadth

- Existing admin is a single Kabumori admin console, not a multitenant brand/account console. Some modules explicitly filter `KABUMORI_BRAND_ID`; `system-toggle.ts` is an allowlisted admin control path. Important News list is a system-level view. User-workspace member RLS and admin-user access must not be conflated.
- Current production has 4 brands and 0 multi-X-account brands; account-level operational tests/load/fairness are not demonstrated by present row distribution.

## 3. Current flow and failure/retry interpretation

`Supabase Cron (every minute) → x-test-post → claim_due_post() planners + single due-row claim → brand_id resolution (legacy null→Kabumori) → brand/settings/account limit-one read → active/live/publish_enabled guard → brand-specific token branch → post_type dispatcher → generator/Fact/Voice as branch requires → duplicate/publish guards as branch requires → X API → branch-specific completion/logging`.

This is not one uniform pipeline yet. AI Lab `brand_post` has a dedicated profile, strict account binding, Vault token reader, final text length/publish guard, exact cross-brand dedupe, and post-confirmed completion behavior. Existing Kabumori types continue through separate generators/branches. Important News also has its own monitor/publish pipeline and is an intersection only; it must not be folded into a generic rewrite without its own approval.

## 4. Admin / Netlify readiness

- `apps/admin` is isolated as an independent `kabumori-admin` package (Next.js 16.3.4, React 19.2.8, `@supabase/ssr` 0.12.5, supabase-js 2.115.0); no root workspace change is needed. `.env.local.example` declares only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. No service-role/X/OpenAI secret was found or required in this app.
- Auth flow: browser client + cookie server client, Next 16 `src/proxy.ts` refresh path, protected server layout calling `auth.getUser()` and admin_users check; dashboard and `/posts`, `/important-news` are server-rendered/data-loaded with `force-dynamic`. A server action uses session+admin recheck and `revalidatePath('/')` for allowlisted system toggles.
- Server dependencies by surface: Server Components perform Supabase reads for schedule, failures, history, candidates and system status; Server Action mutates allowlisted settings under user session/RLS; proxy handles cookie refresh. All are supported by Netlify's current OpenNext adapter but require runtime compute, not static hosting only. Netlify docs state the adapter provisions a serverless function for SSR/ISR/RSC/Route Handlers/Server Actions and an Edge Function for Next middleware/proxy.
- A static/client-heavy alternative could reduce Netlify runtime calls, but current authenticated admin reads rely on server-side RLS and some tables/settings lack authenticated SELECT. Do not loosen RLS or expose service role to make static export work. First preference: move each mutation to narrow authenticated Supabase RPC/Edge endpoints with admin check; retain either Netlify-supported SSR or deliberately redesign the UI as a static shell with explicit RLS-safe browser reads. `proxy.ts` cookie refresh + `getUser()` SSR guard means the current app cannot simply be exported static unchanged.
- No repository `netlify.toml`, Netlify project config, or tracked `vercel.json`/Vercel project config was found. `HANDOFF.md` records an existing Vercel Production deployment, so it must remain the rollback target until Netlify preview, auth, RLS, actions, redirects, and logs pass.
- Netlify current docs: Next App Router, SSR, Server Components/Actions and middleware are supported via OpenNext; dynamic paths provision Netlify functions. Function consumption/billing depends on account plan; do not assume unlimited Free usage or authorize automatic upgrades. Scheduled Functions are UTC-based, only published deploys run, and do not accept caller payloads; keep Supabase Cron as the canonical scheduler. Background Functions can run up to 15 minutes but retry after errors, so they are a poor direct X-post executor unless idempotency makes retries safe. Verify actual current Free quota in the account before rollout; no plan/account data was changed.
- Sources checked (official docs, current 2026-09-23): [Netlify Next.js support](https://docs.netlify.com/build/frameworks/framework-setup-guides/nextjs/overview/), [Netlify Functions usage/billing](https://docs.netlify.com/build/functions/usage-and-billing/), [Netlify Scheduled Functions](https://docs.netlify.com/build/functions/scheduled-functions/), [Netlify Background Functions](https://docs.netlify.com/build/functions/background-functions/), [Supabase SSR client/auth guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs&package-manager=npm&queryGroups=framework&queryGroups=package-manager).

## 5. What should stay / what may move

- Stay in Supabase: Postgres data, RLS/ACL, authoritative per-brand scheduling/claims, canonical X publisher, account selection, Vault-backed credentials, idempotent completion/failure RPCs, Cron, provider/API secrets and all actual X publish calls. Keep OpenAI content calls server-side in Supabase for current publisher flows unless a separately reviewed need changes that boundary.
- Netlify/admin: authenticated management UI, presentation, filters and non-privileged navigation. Keep only publish controls that call narrow user-authenticated RPC/Edge endpoints; never send service role, X token, or OpenAI key to browser. Ensure each mutation has server/database role checks, audit event, idempotency key, and explicit confirmation for dangerous actions.
- Avoid moving scheduler or posting execution into Netlify. Netlify can host the Next app, but Supabase remains the control/data/execution plane.

## 6. Roadmap to stable multibrand operation

### Phase 0 — prove live data and invariants (next task)

In an isolated/disposable DB first, design the minimum migration to remove the three obsolete global uniqueness conflicts while retaining brand-scoped uniqueness. Add fixtures with two brands sharing same post_type/slot/day and same publish claim; prove independent inserts, same-brand duplicate rejection, old-row safety and rollback. Production remains untouched until separately reviewed.

### Phase 1 — common queue and idempotency foundation

Define deterministic queue/claim key including brand and (where needed) social account; select due rows with per-brand fairness and bounded concurrency; make claim/completion/failure/retry transitions atomic and observable. Add a clear `x_request_id`/idempotency/outcome-unknown model. Ensure confirmed X success cannot be retried because post-success DB write failed. Model stale running reconciliation and alertable lag/attempt reasons. Preserve current Cron while replacing only function/RPC behavior behind tests/canary.

### Phase 2 — account/token routing

Replace `limit=1` with explicit trusted account selection or exact-one fail-closed selection; require brand/account consistency, platform X, identity-verified status, publish enabled, allowed brand mode/profile, correct Vault refs and account-bound OAuth client. Generalize token retrieval only through server-side/least-privilege RPC. Keep Kabumori legacy route as an explicit compatibility adapter; prove no cross-brand credential fallback. Do not publish from social-mobile workspaces until product consent/approval gates independently permit it.

### Phase 3 — common publisher + feature adapters

Separate small core (claim, brand/account context, token, common final publish guard, duplicate check, X send, completion) from per-brand/post-type content adapters. Keep Kabumori-specific morning/close/News/etc adapters specialized. Bring AI Lab `brand_post` into the same common completion/log boundary without importing Kabumori voice. Add post-type allowlist from reviewed profiles/settings but fail closed on unknown values. Wire exact-text fingerprints on every approved brand route and account for 30-day read horizon; test cross-brand exact duplicate vs distinct wording. Semantic/event overlap remains a separate policy, not an accidental hash rule.

### Phase 4 — observability and per-brand operations

Expose brand-scoped pending age, queue depth, run attempts, failure class, idempotency conflict, confirmed-X-but-completion-unknown, last success and account connection/publish gates. Provide safe pause/resume/repair controls only via admin-checked RPC, with audit logging and no arbitrary retry of uncertain X outcomes.

### Phase 5 — admin tenancy and Netlify pilot

Add a deliberate active-brand/account selector based on authenticated membership; make every query and mutation brand-scoped and check RLS/ACL. Move writes to secure Supabase RPC/Edge functions before reducing SSR. Deploy a Netlify preview (not production) rooted at `apps/admin`; set only URL/publishable key plus any non-secret public config. Verify sign-in, proxy refresh, admin denial, pages, toggles, logs, rollback, function usage/credits and no upgrade setting. If cost/read pattern is unsuitable, keep Vercel; no pressure to migrate for its own sake. Only after sustained preview/canary use and quota headroom should production DNS/cutover be considered.

### Phase 6 — long-run readiness

Run multiple brands and accounts in dry-run first, then explicit opt-in live canaries per brand/account, with duplicate/uncertain-result drills, token expiry/reconnect tests, Cron backlog/fairness, rollback, alerting, and a multi-week no-duplicate/no-cross-tenant review. Increase rollout only after every brand independently meets reliability and spend budgets.

## 7. Recommended slot decomposition / next implementation task

- H1: retain Important News/GPT-6 ownership only; no x-test-post/scheduler/index changes.
- H2 (next): Phase 0 disposable migration and proof for the three global uniqueness conflicts; after C2, create a separate implementation TASK with explicit files/rollback and no production apply. Do not combine account/token routing or Netlify work.
- G1: once idle assignment is agreed, `apps/admin/**` only — multitenant brand/account context and UI/read query design, with RLS audit read-only initially. No publisher/RPC migration edits.
- G2: social-mobile owner/account onboarding UX and tenant policies only, keeping publish disabled; no scheduled publisher/token loader changes until separately coordinated.

This decomposition avoids simultaneous writes to `x-test-post`, same RPC/migration, `apps/admin`, and social-mobile OAuth paths. Any database migration needs a single slot owner and fresh-origin check before later pushes.

## 8. Remaining issues / decisions

- The old global unique keys are the first hard blocker. Confirm production rows do not collide across brands before planning a replacement migration; current data distribution may hide conflicts because each brand has at most one X account and few brand_post rows.
- `daily_content_plans` currently has zero rows; AI Lab plan consumer state should be checked separately before assuming it is active in X selection.
- Existing logs show 320 `started` events, but aggregate-only query cannot distinguish old terminal-history records from genuinely stale in-flight work. This task did not audit or reconcile stale jobs.
- No account subscription/Netlify usage dashboard was accessed, so current Free-tier quota, compute credits/headroom and auto-upgrade controls remain unverified.
- No live X/OAuth/Vault action was used to prove a newly configured brand can publish. Production aggregate currently shows zero brands with more than one X account.

## 9. Safety / verification

- changed_files (source): **none**.
- production schema / RPC / RLS / ACL / migration: **0 writes**; Cron / scheduler / settings / publish flags: **0 writes**; Edge Function deploy/invoke: **0**; OAuth/Vault/token read or write: **0**; X API / post: **0**; Netlify project creation or Vercel changes: **0**; secrets displayed: **0**.
- Read-only production query surface: function metadata, active Cron names/schedules and sanitized target classification, catalog/index/policy metadata, and aggregate counts only. No account IDs, handles, names, tokens, cron command bodies, or post text stored in this Report.
- tests: no code changed, so no test suite was run. This audit is source/catalog/documentation analysis only.
- repository: formal repo untouched. The isolated audit worktree has an untracked `supabase/.temp/` created during Supabase CLI project metadata checks; it was not opened, staged, removed, or included. Report/TASK control-only sync is still pending fresh-origin validation and push.
- status: `review_required`; next_owner: `chatgpt`.
- next_recommendation: C2 review this audit. If approved, create a Phase 0 TASK limited to disposable migration/rollback proof for the three scoped uniqueness collisions; no production apply is implied.

- task_id: `social-mobile-app-phase23-dedicated-qa-one-shot-history-learning-20260923`
- result: **PASS candidate for C2**. After fresh, specific user consent, the dedicated QA account's past posts were read once through the authenticated app. The app displayed an **unconfirmed** persona result based on **9 posts**. No X publish, media upload, persona confirmation, or persistence was performed.
- source/preflight: fresh `origin/main` was `8b1762f72f892bbcb2084011490ee09612316a3d` before execution. H1's later control-only advance to `027285d79dbe514d0d90b15bf7debe4e1afd5505` did not overlap H2. Production `social-mobile-history-learning` was v2 ACTIVE with `verify_jwt=true`; its four runtime source files matched the approved Phase22 source. The live gate name was absent/OFF. The existing access-token RPC was service-role-only, SECURITY DEFINER, with empty search_path. Read-only QA binding checks found exactly one dedicated, verified X account, one non-admin owner/workspace, required Vault references present, and `publish_enabled=false`. No identifiers or secret values are included here.
- consent: the user replied directly, `よみとりを実行して`, to the immediately preceding confirmation that the gate would be enabled temporarily, the QA X access token would be read from Vault through the approved RPC, up to 50 posts / 2 pages would be fetched from X, and no publish/raw-post save/persona persistence would occur.
- execution: enabled `SOCIAL_MOBILE_HISTORY_LIVE_ENABLED=true` via production secret config; secret-name-only read-back confirmed ON. Tapped the QA app's one-shot button **once** with `explicit_consent=true` and its existing Auth session. UI first showed processing, then `未確定の文体候補を取得しました。分析対象: 9件。保存・投稿はしていません。` No retry or second Function invocation was initiated. The QA-only UI addition is local/uncommitted and was not deployed or pushed.
- gate_shutdown: immediately after sending the one request, unset `SOCIAL_MOBILE_HISTORY_LIVE_ENABLED`; secret-name-only read-back confirmed **absent/OFF** before reading the final UI result. Postflight Function remained ACTIVE with `verify_jwt=true`. Supabase config propagation changed the Function's listed version from v2 to **v4**, but its runtime EZBR SHA-256 remained `0ec1bc506e85f1b54ab63dba3b5848598107cfb53549bac4edb3958cc4636979` and `updated_at` remained `1790135565236`; no source deploy was performed. QA account postflight still showed one identity-verified account with `publish_enabled=false`.
- counts/evidence: app-triggered authenticated history Function request **1** (one UI click, module-level one-shot guard; independent platform request-log count unavailable); approved access-token RPC path **1** and Vault plaintext access **1** inferred from the successful, single-pass source path (independent RPC/Vault audit counters unavailable); X history GET page count **1–2**, exact count unavailable because the Function returns only analyzed count and no server request trace was exposed. The source hard-caps 50 posts and 2 pages. Analyzed posts **9**. No automatic retry exists in the app or Function.
- data_and_safety: result remained unconfirmed; no raw post body or token appeared in the app response/report. The Function's live dependencies perform Auth/RLS GETs, one access-token RPC, and X GET only; they have no persona/settings/raw-history write or publish/media/repost adapter. Thus raw-history persistence **0**, persona persistence **0**, publish/media/post **0**, OpenAI calls **0**, OAuth mutation **0**, DB schema/RLS/ACL/RPC/Cron/scheduler changes **0**. No unrelated Function was deployed or changed by source in this task. The two temporary gate configuration writes were the only intentional production settings changes, and final state is OFF.
- tests/checks: `apps/social-mobile` typecheck **PASS** and lint **PASS** in the isolated QA worktree; equivalent typecheck **PASS** in the already-running temporary Expo worktree. `git diff --check` **PASS** for the QA source diff. The production UI visibly returned success and 9 analyzed posts. No additional live test was run.
- remaining_risks: Platform-level logs were not available, so exact X pagination count and independent RPC/Vault invocation counts cannot be proven beyond the single UI action and deterministic source path. The local QA UI remains uncommitted in temporary worktrees; the production gate is OFF and the UI has an in-memory one-shot guard. This first live test does not authorize a general-user rollout or saving the proposed persona.
- next_recommendation: C2 review the bounded QA result and observability gap. Keep the live gate OFF; do not run another history read, persist persona, or enable publishing without a separate task and approval.
- control: only `.agent/tasks/CODEX_TASK_2.md` and `.agent/CODEX_REPORT_2.md` were synchronized to GitHub. TASK is `review_required` / `next_owner: chatgpt`. The H2 control commit `5c60f15acf7b73891fe9812d0829333fc0dba99b` was pushed to `origin/main`; fresh fetch/read-back confirmed that exact commit, the TASK status, and this Phase23 Report at the top. This final push-verification line is a Report-only follow-up. Formal repo's existing uncommitted changes and all other slots remain untouched.

# H2 — Social mobile Phase 22 gated live history dependencies (review required, 2026-09-23)

- task_id: `social-mobile-app-phase22-live-history-dependency-gate-default-off-20260923`
- result: **PASS**. Production `social-mobile-history-learning` now contains live dependency wiring but its server-only gate remains absent/OFF. No real-user history run was made.
- fresh_source: isolated worktree rebased on fresh `origin/main` `de93f6ccdce625b701520b17af6d6f91b9e9890f`; implementation commit `a26370391176c04b78dee417e0f4d7b71fed231a` was pushed to `origin/main`. H1 changed only its own control files between the initial checkout and rebase; no H2 source overlap. Formal checkout changes remained untouched.
- changed_files: `supabase/functions/social-mobile-history-learning/index.ts`, `supabase/functions/social-mobile-history-learning/live_dependencies.ts`, `supabase/functions/social-mobile-history-learning/live_dependencies_test.ts`, and `supabase/functions/_shared/brand/social_mobile_history_access_reader_test.ts`; plus this H2 TASK/REPORT control update.
- gate: `SOCIAL_MOBILE_HISTORY_LIVE_ENABLED`; **only exact case-sensitive `true`** enables live dependencies. Absent, empty, malformed, and any other value are OFF. It is read only from Function runtime environment; request body, header, and query cannot override it. OFF dispatches the pre-existing disabled dependencies and never constructs the service-role RPC reader. Both pre- and post-deploy secret-name-only checks confirmed the gate name is **absent** in production. No gate/config write was made.
- live_dependencies: Auth `/auth/v1/user` validates the bearer, then user-JWT/RLS reads `brand_memberships`, `brands`, and `social_accounts`. The core enforces explicit consent → authenticated user → owner membership → selected/sole workspace → workspace existence/owner recheck → exactly one identity-verified X account → trusted user/account binding → dedicated `read_social_mobile_history_access_token` RPC → bounded X history reader. Client-supplied user/account/platform IDs, Vault refs, access/refresh tokens are ignored. No generic Vault query, write/publish adapter, or raw-post persistence was added.
- service_role_boundary: `SUPABASE_SERVICE_ROLE_KEY` is read only in the exact-ON entrypoint branch; missing URL, anon key, or service-role key yields a normalized 503. Tenant reads use the user bearer plus standard `SUPABASE_ANON_KEY`, never service role. Only the existing dedicated RPC uses service role and receives trusted user/account IDs. No secret values were logged, returned, or committed.
- tests: relevant Deno suite **31/31 PASS**; Function source `deno check --no-lock` **PASS**; `git diff --check` **PASS**. Including the Node-based test file in `deno check` was not possible in this isolated environment because `npm:@types/node` was unavailable; the test executes successfully with the repository's `deno test --no-check` convention.
- production_preflight: Phase20 RPC exists exactly once, body MD5 `0bbe161dc96b02eb9207b9892b348d15`, owner `postgres`, SECURITY DEFINER, empty search_path, execute service_role-only; it was **not invoked**. Phase21 Function v1 ACTIVE / `verify_jwt=true`; its three runtime files matched approved `origin/main` bytes. Standard runtime env names for URL/anon/service-role were present; gate name was absent. Other slots targeted separate objects.
- deploy: only `social-mobile-history-learning` updated to **v2 ACTIVE**, `updated_at=1790135565236`, `verify_jwt=true`, EZBR `0ec1bc506e85f1b54ab63dba3b5848598107cfb53549bac4edb3958cc4636979`. Production mutation budget used: one Function update; no config write.
- runtime_readback: v2 runtime `index.ts`, `logic.ts`, `live_dependencies.ts`, and shared `social_mobile_history_access_reader.ts` each byte-matched the corresponding pushed `origin/main` file. The entrypoint checks exact server-only gate before reading service role or constructing live dependencies. Pre/post Function metadata comparison found **only** `social-mobile-history-learning` changed; all 15 unrelated Functions retained version, updated_at, and verify_jwt.
- safe_smoke: one unauthenticated GET, no bearer or consent, returned HTTP **401**. No real-user request, token RPC, or X API call occurred. Post-deploy gate-name check still returned absent/OFF.
- safety_counts: access-token RPC calls **0**; Vault plaintext reads **0**; X history/API calls and posts **0**; persona/raw-history/settings writes **0**; OpenAI calls **0**; DB/RPC/RLS/ACL/migration, Cron/scheduler, OAuth, secret changes **0**; unrelated Function deploys **0**.
- remaining_risks: The exact-ON path has mock coverage but has not been exercised with a real QA bearer; `verify_jwt=true` protects the gateway, and real Auth/RLS/RPC/X behavior still requires a separate Phase23 consented test. The service-role credential remains privileged; it is not read while the gate is OFF.
- next_gate: C2 review this default-OFF rollout. Only after a separate approval should Phase23 set the gate ON for exactly one explicit-consent QA history-learning run; no publish or persona persistence is authorized here.
- control: TASK set to `review_required` / `next_owner: chatgpt`. Control commit `9c95789b17c99096e85d090f15bc1b616cc284c3` was pushed; fresh `origin/main` read-back confirmed TASK status and this Report. A follow-up control-only reorder places this Phase22 entry first.

# H2 — Social mobile Phase 21 disabled history-learning Function deploy (review required, 2026-09-23)

- task_id: `social-mobile-app-phase21-production-history-learning-disabled-deploy-20260923`
- result: **PASS**. Deployed only the disabled `social-mobile-history-learning` Edge Function to production. No live history reader, Vault plaintext access, or X history fetch was enabled.
- fresh_source: deployment source was clean `origin/main` commit `3e0a346bb99f09cf9480021f1e4a4b540ea0929f`; immediately before deploy, local HEAD and freshly fetched `origin/main` matched. The three deployed source files had no diff from Phase19-approved commit `1958f9ca2925519d10018eba2e8c72fb0e246a12`.
- source_integrity: `index.ts` calls `handleHistoryLearningRequest(request, disabledHistoryLearningDependencies())` only. It does not import/call `createHistoryLearningCandidateDependencies()`, read `SUPABASE_SERVICE_ROLE_KEY`, or configure a live RPC/X adapter. With explicit consent, the disabled `readAuthUser` returns null before owner/account, access-token, RPC, Vault, or X steps. Response types omit tokens/references/raw posts; no write/publish path exists. Dormant logic is bounded to 50 posts and two pages, without raw-post persistence.
- rpc_preflight: Phase20 production RPC `public.read_social_mobile_history_access_token(uuid,text)` existed exactly once; `plpgsql`, owner `postgres`, `SECURITY DEFINER=true`, fixed empty `search_path`, body MD5 `0bbe161dc96b02eb9207b9892b348d15`; EXECUTE denied to PUBLIC/anon/authenticated and allowed only to service_role. No RPC invocation was performed.
- function_preflight: project `stock-x-autopost` (`wsmznyzcvmuitkglfeuj`) had 15 Functions and no `social-mobile-history-learning` slug. Existing `social-mobile-brand-dry-run` uses `verify_jwt=true`; public project URL was confirmed through project metadata. H1's open PR #8 targets Important News/portfolio files, G1 idle, G2 done; no history-learning file or production-object overlap. Formal checkout's existing changes were untouched.
- tests: targeted history-learning, access-reader, and migration/security tests **20/20 PASS**; `deno check --no-lock` for `index.ts` and `logic.ts` **PASS**; `git diff --check` **PASS**. Social-mobile typecheck/lint were not rerun because shared/mobile source did not change in this phase.
- deploy: Supabase Edge Function `social-mobile-history-learning` **ACTIVE v1**, `updated_at=1790133516138`, runtime `ezbr_sha256=325bf0ac75196f86c33f7cecc405bdb5e5d83748ea8e6c689eef50ecd36ac2d2`. Deployment was the only production mutation.
- jwt_policy: `verify_jwt=true`, matching the existing authenticated social-mobile Function pattern and Supabase's default protected-Function behavior. No custom bearer bypass was added; no service-role credential was obtained or wired.
- runtime_source_readback: runtime `index.ts` (350 bytes), `logic.ts` (12873 bytes), and `_shared/brand/social_mobile_history_access_reader.ts` (3379 bytes) each matched the corresponding approved `origin/main` file byte-for-byte. Runtime entrypoint still uses disabled dependencies and contains no live-factory reference.
- unrelated_function_readback: the pre-deploy 15 Functions had exactly the same version, `updated_at`, `verify_jwt`, and EZBR hash after deploy; only the new history-learning Function appeared.
- safe_smoke: exactly one unauthenticated GET (no bearer, workspace, account, consent, or secret) returned **HTTP 401**. No real-user request or service-role token was sent. The gateway rejection plus disabled entrypoint meant no path to the RPC or X.
- safety_counts: Vault plaintext reads **0**; access-token RPC calls **0**; X history/API calls and posts **0**; service-role live wiring **0**; OpenAI calls **0**; persona/settings writes **0**; DB/RPC/RLS/ACL/migration, OAuth, Cron/scheduler, and publish changes **0**; other Function deploys **0**.
- remaining_risks: The disabled shell proves deployment integrity, not a real authenticated history request. The live reader factory is present in dormant source but unreachable from the entrypoint. The service-role key still has broad privileges in general and must not be wired without a separate security review.
- next_gate: C2 review this deployment and its disabled-path proof. Only after C2 PASS should Phase22 consider server-only live dependency wiring behind an explicit default-OFF gate; real Vault read/X history fetch requires a later separate QA consent, and publishing stays disabled.
- control_files: `.agent/tasks/CODEX_TASK_2.md` set to `review_required` / `chatgpt`, and this Report entry prepended. No application source was changed in Phase21.
- control_commit_push: Initial H2 control commit `9c75d617e5e2dd47a17b3631cb6b5e4a16f68d10` was pushed to `origin/main`; a fresh fetch/read-back confirmed `origin/main` at that exact SHA with Phase21 as the top Report entry and the TASK at `review_required` / `chatgpt`. This final push-verification note is report-only.

# H2 — Social mobile Phase 20 production history access RPC rollout (review required, 2026-09-23)

- task_id: `social-mobile-app-phase20-production-history-access-rpc-rollout-20260923`
- result: **PASS**. Applied only the Phase19-approved access-token reader migration to production project `stock-x-autopost` (`wsmznyzcvmuitkglfeuj`), then read back its definition, owner, search path, ACL, and migration history. Did not invoke the RPC or read a Vault value.
- approved_source: `supabase/migrations/20260923120000_social_mobile_history_access_token_reader.sql`; SHA-256 `0f1ce8fdfbb54cac1ec156c9fb8dce10735e2a1b963df64de1004a7d849e192e`. `git diff 1958f9ca2925519d10018eba2e8c72fb0e246a12..origin/main -- <migration>` was empty; no Phase19 source drift. The SQL has an exact `(uuid,text)` signature, `SECURITY DEFINER`, fixed empty `search_path`, qualified `public`/`vault` references, explicit revokes then `service_role` grant, access-only selection, and normalized errors.
- production_preflight: **PASS**. Project was `ACTIVE_HEALTHY`; target RPC and same-name overloads absent; target migration version/name absent. `public.social_accounts`, `public.brand_memberships`, and `vault.decrypted_secrets` existed with the required compatible column types. `anon`, `authenticated`, and `service_role` roles existed (`PUBLIC` is PostgreSQL's pseudo-role). The expected owner `postgres` could SELECT the required relations/view. H1 was ready but confined to a different Important News workstream; G1 idle and G2 done, with no overlap in this migration/RPC/Vault object. Formal checkout's existing changes were untouched.
- migration_apply: **success=true** from Supabase migration API, with name `social_mobile_history_access_token_reader` and byte-exact SQL read from the approved `origin/main` file. No `supabase db push`, history repair, ad-hoc SQL rewrite, or second migration.
- migration_history: exactly one new corresponding entry, version `20260923005453`, name `social_mobile_history_access_token_reader`; the preceding final entry was `20260922024844` (`social_mobile_x_oauth_reconnect_preserve_verified`).
- rpc_readback: exactly one `public.read_social_mobile_history_access_token(uuid,text)`; return `text`; language `plpgsql`; owner `postgres`; `SECURITY DEFINER=true`; `proconfig=[search_path=""]`; definition MD5 `5bc1aece8864efcdd59f45f9aadf2d4f`; body MD5 `0bbe161dc96b02eb9207b9892b348d15`, matching the exact function body extracted from the approved local migration.
- acl_readback: `PUBLIC` EXECUTE **false**; `anon` **false**; `authenticated` **false**; `service_role` **true**. No same-name overload exists.
- access_scope_readback: function body contains `vault_access_token_secret_id`, qualified `vault.decrypted_secrets`, and `HISTORY_ACCESS_TOKEN_UNAVAILABLE`; it does **not** contain `vault_refresh_token_secret_id` or a generic secret-id parameter. No real account or Vault secret was queried.
- existing_rpc_compatibility: ten OAuth/admin RPC metadata records were inspected. Their combined definition/owner/SECURITY DEFINER/search-path/ACL digest was `e651707d059b70adf82cb35f64288a2b` both before and after apply; existing OAuth/admin RPCs were unchanged.
- verification: catalog-only postflight **PASS**; no smoke invocation was needed. Source was not modified, so source tests were not rerun. `git diff --check` applies only to the TASK/REPORT control update.
- production_boundary: exactly one approved RPC migration applied; existing production rows were not updated by the migration SQL. Vault plaintext reads **0**; Function deploys **0**; X history/API calls and posts **0**; OpenAI calls **0**; Cron/scheduler/settings/OAuth/publish changes **0**.
- remaining_risks: The new RPC has not been invoked against a real account; its live Vault-read behavior is intentionally untested in this phase. The `service_role` credential retains broad privileges outside this narrow RPC. `social-mobile-history-learning` remains disabled and undeployed, so no production caller uses the new RPC yet.
- next_gate: C2 review this metadata/ACL rollout. Only a separate Phase21 approval may deploy the history-learning Function with server-only configuration while keeping real history fetch disabled. A later explicit QA consent is required before exactly one real Vault read and X history fetch; publishing remains disabled.
- control_files: `.agent/tasks/CODEX_TASK_2.md` set to `review_required` / `chatgpt`; this `.agent/CODEX_REPORT_2.md` entry prepended. No application source was changed in Phase20.

# H2 — Social mobile Phase 19 live Vault reader architecture and disposable proof (review required, 2026-09-23)

- task_id: `social-mobile-app-phase19-live-vault-reader-architecture-and-disposable-proof-20260923`
- result: Compared the service-role-only adapter with a narrow `SECURITY DEFINER` RPC, selected the dedicated service-role-only RPC, and completed a source candidate plus fake-only PostgreSQL apply/read-back/rollback proof. No production operation was performed.
- architecture_comparison:
  - service-role-only adapter: no migration and simpler deployment/rollback, but relies entirely on Edge code to constrain a highly privileged Vault read; direct access to `vault.decrypted_secrets` through the production REST schema is also not guaranteed. A compromised service-role key retains broad database/Vault blast radius.
  - dedicated RPC: adds one migration, `SECURITY DEFINER`, ACL and search-path review surface, but places exact owner/account/status/cardinality checks in the database before plaintext access; accepts no arbitrary secret reference and is callable only by `service_role`. A stolen service-role key still has its existing broad privileges, so this is defense against accidental/miswired calls, not a reduction of the key's total blast radius.
  - decision: choose the dedicated RPC because the extra DDL is isolated and disposable-tested, while ownership and account checks precede the only access-token read. The rejected adapter has fewer database objects but a weaker database-enforced binding boundary.
- trusted_boundary: `social-mobile-history-learning` resolves `authUser.id` with `getUser()`, then owner membership, workspace ownership, exactly-one verified X account, and trusted `platform_user_id`. Only those server-resolved `authUserId` and `accountId` values reach the candidate reader. No client-supplied identity or Vault reference is accepted. The RPC rechecks owner membership (`role='owner'`), X platform, `identity_verified`, nonempty platform identity, and exactly one X account in the brand before selecting `vault_access_token_secret_id`. `auth.uid()` is not used because the server-to-RPC request uses the service-role JWT; the user id is obtained from the authenticated user's `getUser()` result and ownership is independently checked in SQL.
- chosen_candidate: Added `read_social_mobile_history_access_token(uuid,text)`, `SECURITY DEFINER` with empty fixed `search_path`, `public`/`anon`/`authenticated` execute revoked, `service_role` execute granted. The function reads only `vault_access_token_secret_id` and `vault.decrypted_secrets.decrypted_secret`; it has no refresh-token selector, arbitrary Vault-id parameter, write path, admin fallback, or detail-bearing errors. Migration fails closed if required schema is missing/mismatched or the RPC name already exists.
- phase16_wiring: The injectable Phase16 boundary now receives a trusted user/account binding instead of a Vault reference. Added a source-only dependency factory for the dedicated RPC. The current `index.ts` source still uses `disabledHistoryLearningDependencies()` and does not import or invoke the candidate factory; no live environment secret was wired and no deploy occurred.
- disposable_proof: PostgreSQL 16 ephemeral container with fake-only users, owner/viewer memberships, X accounts, and fake access/refresh values. Applied the migration candidate, read back `SECURITY DEFINER`, empty `search_path`, and ACL (service_role only). Owner A returned only access token A; cross-tenant, viewer, pending, missing platform id/ref/secret, forged account id, and multiple-X cases failed before any fake plaintext-read audit entry. The refresh decoy was not selected. The script then dropped the function and every fixture/schema/role; proof passed and the container was stopped/removed.
- changed_files:
  - `supabase/functions/_shared/brand/social_mobile_history_access_reader.ts`
  - `supabase/functions/_shared/brand/social_mobile_history_access_reader_test.ts`
  - `supabase/functions/_shared/brand/social_mobile_history_access_reader_migration_test.ts`
  - `supabase/functions/_shared/brand/social_mobile_history_access_reader_disposable_proof.sql`
  - `supabase/functions/social-mobile-history-learning/logic.ts`
  - `supabase/functions/social-mobile-history-learning/logic_test.ts`
  - `supabase/migrations/20260923120000_social_mobile_history_access_token_reader.sql` (candidate only)
  - `.agent/tasks/CODEX_TASK_2.md`
  - `.agent/CODEX_REPORT_2.md`
- tests: Social mobile Phase16/18 + shared Phase14/15 regression **34/34 PASS** (`deno test --no-check --allow-read`); `deno check --no-lock supabase/functions/social-mobile-history-learning/logic.ts` **PASS**; `apps/social-mobile npm run typecheck` **PASS**; `npm run lint` **PASS**; disposable PostgreSQL apply/read-back/behavior/rollback **PASS**; `git diff --check` **PASS**. `apps/social-mobile` dependencies were installed with `npm ci --ignore-scripts --offline` in the disposable worktree; package manifests/lockfiles are unchanged. Expo export was not run because no mobile source changed.
- remaining_risks: The candidate has not been applied to production and the production Vault view/RPC runtime has not been exercised. The service-role credential remains broadly privileged even though this RPC is narrow. The default handler remains disabled. Review schema owner privileges, PostgREST exposure of the `public` RPC, operational service-role handling, and migration rollout before any production use.
- next_production_gate: C2 review this migration and adapter. If approved, separately authorize applying only this migration and read back function definition, owner, `SECURITY DEFINER`, empty `search_path`, and exact ACL. A later separately reviewed change may wire server-only service-role config and deploy only `social-mobile-history-learning` while still disabled. Exactly-one QA Vault read/history fetch must require another explicit consent; publishing remains disabled and unapproved.
- implementation_commit: `1958f9ca2925519d10018eba2e8c72fb0e246a12`.
- control_commit: `a08b057f446355455045d5c33f59b32ec291a1bc` (TASK/REPORT update); push-verification record was subsequently pushed and read back.
- push: **PASS** — implementation commit and TASK/REPORT updates are on `origin/main`. Post-push fresh read-back confirmed this task remains `review_required` / `chatgpt` and the Phase19 Report is the top entry.
- production_mutation: **0** — no production migration/RPC/schema/RLS/ACL, Vault plaintext or service-role secret read, Edge deploy, OAuth, settings, X history/API/media/post, OpenAI, Cron/scheduler, or publish operation.
- safety_checks: Fresh `origin/main` `e62d05eec22fa441587a8678870ba24c830c8a47`; H1 is review-only in separate Important News files; Claude slot 1 idle and slot 2 done; no overlap. Formal repo/old worktree changes untouched; no app/mobile source, OAuth, `x-test-post`, `apps/admin/**`, or `HANDOFF.md` changes. No production token/secret or QA account identifiers accessed or reported.

# H2 — Social mobile Phase 17 disposable Vault token-boundary proof (review required, 2026-09-22)

- task_id: `social-mobile-app-phase17-disposable-vault-token-boundary-proof-20260922`
- result: Completed the source/metadata audit and a disposable PostgreSQL proof. No production Vault/X/API or live publish was touched.
- current_token_architecture: The canonical token-reference columns are `public.social_accounts.vault_access_token_secret_id` and `vault_refresh_token_secret_id`. OAuth completion writes both through `complete_social_mobile_x_oauth_connection()` using `vault.create_secret`/`vault.update_secret`; that SECURITY DEFINER function has `set search_path = 'public', 'vault'` and is executable only by `authenticated`. The existing `begin`/`consume`/`complete` RPCs derive ownership from `auth.uid()` and owner membership rather than client-supplied user/account identity.
- existing_read_paths: The only existing Vault value reader found is the AI-Lab-specific `loadAiLabVaultBackedXTokens()` path and its `read_ai_salaryman_lab_x_vault_token` RPC. It is service-role-backed, hard-coded to `ai_salaryman_lab`/`ai_salaryman_lab_x`, reads both access and refresh references, and is not reusable for general-user history learning. The generic `loadVaultBackedXTokens()` helper also reads both refs in parallel and is not suitable for this access-only boundary. No generic client-callable secret reader was added.
- narrow_contract: Phase16's source candidate already exposes an injectable `readAccessToken(secretRef)` boundary after server-side Auth, owner membership, workspace, exactly-one verified X-account, and bound `platform_user_id` checks. It accepts no client secret/account ref, reads no refresh token, never returns/logs the value, and the default handler is disabled. A future dedicated internal implementation should keep the access-only interface and tenant/account binding, with minimal ACL and fixed search_path proven in disposable DB first.
- disposable_fixture: A separate Podman PostgreSQL 16 container was used with fake-only UUID users, two workspaces, owner/viewer memberships, verified/pending X accounts, access/refresh/unrelated fake Vault rows, and no production values. The proof helper was created inside one transaction and never committed.
- proof_status: **PASS**. Positive user A -> owned workspace/account A resolved only access secret A; cross-tenant/user, viewer, pending, missing platform ID, missing ref, forged secret ref, multiple-account, and deleted-secret cases all failed closed. The helper accepted no refresh-secret selector or arbitrary Vault-secret selector. Ownership/account checks preceded the Vault read, and a simulated history adapter would receive only the trusted account-bound token after that boundary.
- readback_and_cleanup: `SECURITY DEFINER` and fixed `search_path = 'public', 'vault'` were read back; EXECUTE was granted to `authenticated` and not `public`; function source did not reference refresh-token reads. The transaction was rolled back, then `to_regclass('public.social_accounts')` and `to_regprocedure('public.read_history_access_token(text)')` both returned absent. The container and temporary proof file were removed.
- tests: Existing Phase16 history/preview/static suite **26/26 PASS** (`social-mobile-history-learning` 10/10, preview 10/10, Phase15 static 6/6). `apps/social-mobile` `npm run typecheck` **PASS**, `npm run lint` **PASS**, Expo web export **PASS**, and `git diff --check` **PASS**. No Phase17 source or migration was added.
- changed_files: `.agent/tasks/CODEX_TASK_2.md`; `.agent/CODEX_REPORT_2.md` only. No Phase17 source or migration was added.
- production_mutation: **0** — no production DB/schema/RLS/ACL/RPC, Vault read/write, Edge deploy, X history/API/media/post, OAuth, OpenAI, Cron/scheduler, settings, or publish operation.
- remaining_issues: The proof uses disposable PostgreSQL to mock the Vault secret boundary rather than the production Supabase Vault extension. A separate rollout review must verify the exact production ACL/RPC before any live reader is wired.
- next_recommendation: C2 review this proof and, if approved, authorize a narrowly scoped production-shaped internal access-only reader design. Keep Phase16 default handler disabled; no deploy or live history call is authorized here.
- safety_checks: Formal repo and source worktrees were untouched; no `apps/admin/**`, `HANDOFF.md`, H1 files, migrations, secrets, tokens, OAuth, X/OpenAI/Vault/Storage/Cron operations were changed or exposed.

# H2 — Social mobile Phase 16 server-side X history-learning adapter candidate (review required, 2026-09-22)

- task_id: `social-mobile-app-phase16-server-side-x-history-learning-adapter-candidate-20260922`
- result: Implemented a source-only server boundary candidate. Mobile authority is limited to a bearer, optional workspace selector, and fresh explicit consent. Auth identity, owner workspace, exactly-one X account, `identity_verified`, trusted `platform_user_id`, and the Vault access-token reference are resolved server-side through injected trusted readers. Ambiguous or missing state fails closed.
- changed_files: `supabase/functions/social-mobile-history-learning/logic.ts`; `supabase/functions/social-mobile-history-learning/index.ts`; `supabase/functions/social-mobile-history-learning/logic_test.ts`; `apps/social-mobile/src/app/(tabs)/consult.tsx`; `.agent/tasks/CODEX_TASK_2.md`; `.agent/CODEX_REPORT_2.md`.
- trusted_input_boundary: Client-supplied account IDs, platform user IDs, access tokens, Vault refs, owner IDs, publish flags, and schedule controls are ignored. The selected workspace is only a selector and must match an owner membership read with the authenticated bearer; the account binding is rechecked server-side.
- vault_boundary: Only an access-token reference is accepted by the internal reader interface. Refresh-token reads, admin/global token fallbacks, token persistence, token logging, and returning the token/reference to mobile are absent. The default Edge entrypoint uses a disabled adapter and fails closed, so no production Vault read can occur accidentally in this candidate.
- x_history_adapter: Added a read-only `GET https://api.x.com/2/users/:trusted_platform_user_id/tweets` adapter with `max_results=50`, at most two server-side pages, `exclude=replies,retweets`, and only `created_at,text,in_reply_to_user_id,referenced_tweets` fields. Provider failures normalize to stable client-safe codes; provider bodies are not returned. No write/media/repost/like/bookmark/DM/follow path exists.
- consent_and_retention: No history fetch occurs without a fresh `explicit_consent=true` request. The mobile consultation preview now shows the connected verified-account target, maximum 50 posts/2 pages, learned bounded signals, raw-body non-retention, and no-post behavior. Output is an unconfirmed `past_post_analysis` proposal only; raw post bodies exist only during the injected request/test lifetime and are not returned or persisted.
- call_order_proof: Tests assert Auth -> owner membership -> workspace -> account -> access-token read -> X fetch, client identity is ignored, non-owner/multiple/non-verified/missing-ID/missing-ref cases deny, and no fetch happens without consent.
- tests: New Phase16 Deno logic suite **10/10 PASS**. Existing Phase15/preview regression suite **16/16 PASS**. `apps/social-mobile` `npm run typecheck` **PASS**, `npm run lint` **PASS**, Expo web export **PASS**, and `git diff --check` **PASS**. Dependencies were installed only inside the isolated worktree with `npm ci --ignore-scripts`; package files remained unchanged.
- implementation_commit: `29f6d86ed6fb3e2f801ce4eb35f21e9e547a3bf0` (rebased onto fresh `origin/main` `c2f18de8c609693b4255b710e3798c2df72dda95`; scoped source, test, mobile-consent UI, TASK, and REPORT files only).
- production_mutation: **0** — no production migration/schema/RLS/ACL/RPC, Edge deploy, Vault read, X history/API/media/post, OAuth, OpenAI, Cron/scheduler, settings, publish permission, or mobile production network invocation.
- remaining_risks: The injected Vault reader and X adapter are a source candidate and are not wired to a production secret reader or deployed function. A separate review must prove the exact Vault ACL/RPC and tenant RLS contract before enabling the adapter. Persona persistence remains an explicit user-confirmation step and is not connected here.
- next_recommendation: C2 review the server contract and authorize a separate disposable Vault/RLS proof before any production adapter wiring or deploy. Keep the default handler disabled and do not enable live history fetch until that proof is complete.
- safety_checks: Formal repo and existing uncommitted changes were untouched; no `apps/admin/**`, `HANDOFF.md`, H1 files, other workstreams, production settings, migrations, secrets, tokens, OAuth, X/OpenAI/Vault/Storage/Cron operations were changed or exposed.

# H2 — Social mobile Phase 15 conversational proxy AI and history-learning candidate (review required, 2026-09-22)

- task_id: `social-mobile-app-phase15-conversational-proxy-ai-and-history-learning-candidate-20260922`
- status: `review_required`; next_owner: `chatgpt`
- result: Implemented a source-only conversational proxy boundary for the user's posting AI and an explicit-consent, mocked X-history learning candidate. No production invoke, publish, OAuth scope change, Vault access, or history API call was performed.
- source_base: fresh `origin/main` `f76f4b8d4bca5c33ac2e55e12ac35259d9d11e69`, isolated clean worktree `/private/tmp/kabumori-h2-phase15`; formal repo and pre-existing changes were untouched. No overlap with H1/G1/G2 was detected before write.
- conversational_architecture: `content-settings-conversation.ts` now exposes a validated assistant result contract (assistant reply, bounded settings/persona deltas, follow-up questions, provenance, confidence/uncertainty, explicit history intent, `requiresConfirmation=true`, and `publishPermissionChanged=false`). A future LLM can sit behind this boundary, but the current adapter is deterministic and has no network or persistence side effect. Untrusted output is rejected when it contains publish/account/OAuth/token/secret/scheduler controls or persona metadata that should remain canonical DB columns.
- persistence_and_confirmation: unconfirmed proposals remain local to the consultation screen. `applyConfirmedConversationProposal()` is the explicit confirmation boundary; corrections replace the latest proposal. `SupabaseContentSettingsRepository.saveConfirmedProposal()` is a tenant-scoped source candidate that validates settings, requires `persona.confirmed`, stores only bounded derived signals in `persona_profile`, and writes provenance/confirmation/count/time to dedicated columns. The UI does not invoke a production write in this phase.
- canonical_persona_mapping: reads now select `persona_provenance`, `persona_confirmed`, `persona_last_analyzed_at`, and `persona_last_analyzed_count`. Mobile/preview application objects derive `source`/`confirmed` from those columns; profile payload source/confirmed fields are removed on confirmed persistence, preventing contradictory metadata duplication. Preview guidance includes persona signals only when `confirmed=true`; unconfirmed history results cannot affect generation.
- history_learning_candidate: `past-post-learning.ts` requires the authenticated user to equal the workspace owner, the requested workspace to equal the owned workspace, exactly one `x/identity_verified` account with a bound platform user id, and explicit consent immediately before the injected fetcher is called. It caps processing at 50 posts and 2 pages, filters replies/retweets, returns only bounded derived signals/count/time/account binding, and never returns/stores raw post bodies. `personaCanBeUsedForPreview()` requires confirmation.
- x_api_audit: existing `x-oauth-connect-user/oauth_logic.ts` requests `tweet.read users.read tweet.write media.write offline.access`; the existing callback verifies `/2/users/me` and writes tokens through the user-JWT RPC/Vault boundary described in the Phase9 design. A future history fetch should use the authenticated account's own `GET /2/users/:id/tweets` with `tweet.read`/`users.read`, bounded `max_results`, pagination token handling, and `exclude=replies,retweets`; this phase only provides an injected mock boundary. Official docs checked 2026-09-22: [X API docs index](https://docs.x.com/x-api/llms.txt), [Get Posts](https://docs.x.com/x-api/users/get-posts.md), [X pagination guidance](https://docs.x.com/xdks/python/pagination).
- mobile_ux: `consult.tsx` now renders assistant/user bubbles, a reviewable summary, `これで覚えて`, correction-by-next-turn, and a second confirmation step before any future history fetch. It explicitly states that this candidate does not enable auto-post, create schedules, or call X. Backend/OpenAI raw errors are not shown.
- changed_files: `apps/social-mobile/src/app/(tabs)/consult.tsx`; `apps/social-mobile/src/data/content-settings-repository.ts`; `apps/social-mobile/src/domain/content-settings-conversation.ts`; `apps/social-mobile/src/domain/past-post-learning.ts`; `supabase/functions/_shared/brand/social_mobile_content_settings.ts`; `supabase/functions/social-mobile-brand-dry-run/logic.ts`; `supabase/functions/_shared/brand/social_mobile_phase15_static_test.ts`.
- implementation_commit: `8d0b0c8d1455410d4bf6613bc46670a27006cc02` (rebased onto fresh `origin/main` `f966ca0f941ef7a8511a221511a2492f33025711`; pushed and read back on `origin/main`).
- migration: **none added or applied**. Phase14 candidate columns are consumed as-is; no DB schema/RLS/ACL/RPC change was made.
- tenant_account_proof: source guards require verified Auth identity, owner/workspace equality, exactly one identity-verified X account, and bound platform user id before the mock fetcher can run. Cross-tenant and wrong-account requests fail closed in the candidate; no token is passed to the mobile client.
- tests: Phase15 static contract tests **6/6 PASS**; combined social-mobile Edge/static suite **24/24 PASS** with `deno test --no-check --allow-read`; `apps/social-mobile` `npm run typecheck` **PASS**; `npm run lint` **PASS**; Expo web export **PASS**; `git diff --check` **PASS**. `npm ci --ignore-scripts` was run only in the isolated worktree; package files are unchanged.
- production_mutation: **0** — no production migration/schema/RLS/ACL/RPC/settings/persona write, Edge deploy, OpenAI invoke, X history/API/media/post, OAuth Portal/scope change, Vault access, Cron/scheduler, scheduled post, or app-wide data-source switch.
- remaining_risks: the mobile app still uses its existing data-source/runtime wiring; the confirmation write path is a safe repository candidate but is not yet connected to authenticated UI persistence; actual X history fetch/analyzer and LLM-backed replies remain unimplemented. Before rollout, add an Edge/server-side history fetcher that reads only the verified account's Vault token, invokes `GET /2/users/:id/tweets` only after a final consent action, and performs a disposable-RLS proof for the write path.
- next_recommendation: C2 review the source candidate and decide whether to authorize a separate server-side mock-to-real history adapter design. Keep production migration/deploy/history calls disabled until that review and a dedicated token-boundary proof are complete.
- safety_checks: no `apps/admin/**`, `HANDOFF.md`, H1 files, other workstreams, production settings, migrations, secrets, tokens, OAuth, X/OpenAI/Vault/Storage/Cron operations were changed or exposed. No live X/API call or publish path exists in the new candidate.

# H2 — Social mobile Phase 14 disposable DB proof (review required, 2026-09-22)

- task_id: `social-mobile-app-phase14-persistent-content-settings-candidate-20260922`
- status: `review_required`; next_owner: `chatgpt`
- fresh_source: `origin/main` `c4f2f83f485bda45e308522c7b6d079b4b606e7c`; proof ran in an isolated temporary Supabase project/worktree. Formal checkout and existing uncommitted changes were untouched.
- migration_apply: Applied exactly `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql` to disposable local PostgreSQL **17.6**. No production database or migration history was used.
- schema_readback: Confirmed the `social_mobile_content_settings` columns/defaults, `24:00`-only `endLocal` boundary, start/default time restrictions, persona checks, foreign key, primary key, RLS enabled, three owner policies, authenticated grants, delete denial, and the trigger function with `search_path=public`.
- tenant_proof: Two isolated brands/users proved owner read/write success; non-owner insert/read/write denial; cross-tenant isolation; delete denied; invalid `startLocal=24:00`, invalid `defaultGenerationLocal=24:00`, and publish-related keys rejected; default insert succeeded with `09:00 / 24:00 / 17:00`.
- rollback_cleanup: Candidate table and trigger function plus disposable baseline fixtures were dropped. Post-cleanup `to_regclass` / `to_regprocedure` read-back returned null for all proof objects. The local Supabase instance was stopped with `--no-backup`; no residual disposable volume remains.
- tests: The source fix's shared-brand suite remains **73/73 PASS**; `apps/social-mobile` typecheck, lint, Expo export, and `git diff --check` remain PASS. The proof itself completed with `psql -v ON_ERROR_STOP=1` and zero assertion failures.
- persona_representation: Canonical persisted metadata remains in dedicated `persona_provenance` / `persona_confirmed` / analysis columns; `persona_profile` remains bounded derived signals. Future application mapping must construct `source` / `confirmed` from those columns.
- production_mutation: **0** — no production migration/schema/RLS/ACL/RPC, settings row, deploy, Cron/scheduler, scheduled post, X/OpenAI/Vault/OAuth/Storage operation was performed.
- source_commit: `649111c`; proof/control read-back is now recorded on the follow-up commit pushed after the latest origin refresh.
- safety_checks: no `apps/admin/**`, `HANDOFF.md`, H1 files, or other workstreams changed. No secrets, tokens, credentials, or personal identifiers were recorded.

# H2 — Social mobile Phase 14 C2 follow-up: end-time DB contract fix (review required, 2026-09-22)

- task_id: `social-mobile-app-phase14-persistent-content-settings-candidate-20260922`
- status: `review_required`; next_owner: `chatgpt`
- c2_blocker_fixed: The candidate migration's `endLocal` CHECK now accepts `24:00` only for the end-of-day boundary. `startLocal` and `defaultGenerationLocal` remain restricted to `00:00`–`23:59`. The SQL default (`09:00 / 24:00 / 17:00`) therefore matches the application contract without widening the other time fields.
- changed_files: `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`; `supabase/functions/_shared/brand/social_mobile_content_settings_migration_test.ts`; `.agent/tasks/CODEX_TASK_2.md`; `.agent/CODEX_REPORT_2.md`.
- regression: Added a migration-contract test for the default values, the `24:00` end-time boundary, and negative coverage proving `24:00` is not accepted by the regular start/default time pattern.
- tests: shared-brand Deno suite **73/73 PASS** (including Phase14 migration/static/settings coverage, run with `--no-check` because this isolated checkout has no Deno npm type-reference cache); `apps/social-mobile` `npm run typecheck` **PASS**; `npm run lint` **PASS**; Expo web export **PASS**; `git diff --check` **PASS**.
- disposable_postgres_proof: Re-attempted environment discovery. No local PostgreSQL client/server binaries are installed, and the available Podman VM cannot create its lockfile under the managed filesystem permissions. Therefore apply → object/read-back → rollback could not be executed in this environment. No production or shared database was used as a substitute. This remains an explicit C2 follow-up limitation.
- persona_representation: The DB columns `persona_provenance` / `persona_confirmed` are the canonical persisted metadata for this candidate; `persona_profile` remains the bounded derived-signal payload. The app/generator's `source` / `confirmed` shape is an application contract that must be mapped explicitly in a future persona write path; no such write path was broadened here.
- production_mutation: **0** — no production migration/schema/RLS/grant/RPC, settings row, deploy, Cron/scheduler, scheduled post, X/OpenAI/Vault/OAuth/Storage operation was performed.
- source_commit: `649111c` (rebased implementation/control commit on latest origin/main; formal checkout and its existing uncommitted changes remain untouched).
- safety_checks: no `apps/admin/**`, `HANDOFF.md`, H1 files, other workstreams, or production settings were changed. No secret/token/personal identifier was recorded.

# H2 — Social mobile Phase 14 persistent content settings source candidate (C2 review required, 2026-09-22)

- task_id: `social-mobile-app-phase14-persistent-content-settings-candidate-20260922`
- status: `review_required`; next_owner: `chatgpt`
- result: Implemented a source-only, tenant-safe general-user content-settings candidate. No production mutation, migration apply, deploy, settings row creation, X/OpenAI/Vault/OAuth operation, Cron, or publish enable was performed.
- fresh_source: started from fresh `origin/main` `2cee85e` in isolated clean worktree `/private/tmp/kabumori-h2-phase14-settings`. H1 was `done` and scoped to `src/**`; no active H1 overlap with `apps/social-mobile/**` or this migration/RPC candidate. Formal checkout and existing uncommitted changes were untouched.
- schema_audit: production read-only metadata confirmed `brands.id`/`brand_memberships(brand_id,user_id,role)`, membership-scoped authenticated SELECT policies, and existing `brand_settings` service-role-only access. `posting_windows` remains admin-owned with admin SELECT/UPDATE and member SELECT only. Reusing `brand_settings` or extending `posting_windows` would mix responsibilities, so a new table is required.
- candidate_migration: `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql` (source candidate only). It adds `social_mobile_content_settings` keyed by `brand_id` → `brands.id`, structured JSONB content settings, bounded persona/style metadata with provenance, updated-at trigger, and owner-only authenticated SELECT/INSERT/UPDATE RLS through `brand_memberships.role='owner'`. `authenticated` receives only SELECT/INSERT/UPDATE; delete and anon access are denied. No publish permission, token, secret, or raw post-history field is accepted. No SECURITY DEFINER RPC is needed: direct user-JWT RLS is sufficient for the audited owner boundary.
- validation: DB candidate constraints bound locale, tone/objective lengths, themes (0–8), NG words (0–20, each bounded), frequency (0–14/week), JST time fields, notes (≤1000), persona provenance/count, and reject publish/secret/raw-post keys. App validation mirrors these bounds and never carries `livePublishingEnabled=true`.
- changed_files: `supabase/migrations/20260922045046_social_mobile_content_settings_candidate.sql`; `supabase/functions/_shared/brand/social_mobile_content_settings.ts`; `supabase/functions/_shared/brand/social_mobile_content_settings_test.ts`; `supabase/functions/_shared/brand/social_mobile_content_settings_migration_test.ts`; `supabase/functions/_shared/brand/social_mobile_phase14_static_test.ts`; `supabase/functions/social-mobile-brand-dry-run/logic.ts`; `supabase/functions/social-mobile-brand-dry-run/logic_test.ts`; `apps/social-mobile/src/domain/content-settings.ts`; `apps/social-mobile/src/domain/content-settings-conversation.ts`; `apps/social-mobile/src/data/content-settings-repository.ts`; `apps/social-mobile/src/app/(tabs)/settings.tsx`; `apps/social-mobile/src/app/(tabs)/consult.tsx`.
- mobile_ux: settings screen reads/upserts only the owner workspace through the publishable Supabase client, maps backend failures to fixed Japanese copy, and exposes tone/themes/objective/frequency/timezone/generation time/NG words/notes. It has no publish toggle or immediate-post action. “あなたの投稿AI” consultation candidate accepts natural language, creates a bounded reviewable proposal, supports correction by a later turn, and recognizes “過去の自分の投稿を読んで” only as explicit-consent intent; it does not call X or save history.
- generator_integration: preview handler reads `social_mobile_content_settings` with the same verified owner JWT after membership/brand/account checks. A missing/unavailable candidate table falls back to Phase12 defaults; invalid persisted settings also fall back conservatively. Confirmed persona style signals are included in preview guidance only. `social_mobile_user_v1` preview guard remains required; no settings value enters publish/schedule/Vault paths.
- persona/history_design: persona is separate from content settings with provenance (`conversation` / `past_post_analysis` / `manual`), confirmation, bounded derived signals, and analyzed count/time. Full historical X content is not stored. Existing OAuth scopes include `tweet.read users.read tweet.write media.write offline.access`; a future explicit-consent history design can use the authenticated user’s own `GET /2/users/:id/tweets` with pagination/rate limits, but no history endpoint was called and no scope expansion was made in Phase14.
- tests: Phase14 Deno/static tests **17/17 PASS** (persisted validation, migration/RLS contract, preview persisted-settings use/fallback, persona/provenance, no publish/X-history path). Existing shared-brand regression **72/72 PASS**. `apps/social-mobile` `npm run typecheck` **PASS**, `npm run lint` **PASS**, Expo web export **PASS**, `git diff --check` **PASS**. `npm ci --ignore-scripts` was run only in the isolated worktree; package files remained unchanged. Disposable PostgreSQL apply/rollback was not run because no disposable database was available; migration proof is static-contract only and must be separately applied/rolled back in an isolated DB before any production consideration.
- production_mutation: **0** — no production migration/schema/RLS/grant/RPC, settings row, Cron/scheduler, scheduled post, X/API/media/post, OpenAI, Vault, Storage, OAuth, or app-wide data-source mutation.
- remaining_risks: migration SQL still needs isolated PostgreSQL apply/read-back/rollback proof; mobile live Supabase QA and conversation-to-LLM persistence are not yet wired; X history analysis remains design-only; persona updates need a future explicit-confirmation write path. Do not apply migration or deploy until C2 approves proof and rollout.
- source_commit: `24762d2b676ba216413d2258ef3304df302d58fe` was rebased onto fresh `origin/main` `cce53176888f5c872e0d4ec193480317a05fee7f`, pushed fast-forward to `origin/main`, and read back successfully. Only the listed Phase14 source/tests plus H2 TASK/REPORT were staged.
- safety_checks: formal repo, `apps/admin/**`, `HANDOFF.md`, H1 files, production DB, Edge Functions, settings, Cron, secrets, OAuth, X/OpenAI/Vault/Storage were untouched.

# H2 — Social mobile Phase 13 production preview rollout (C2 review required, 2026-09-21)

- task_id: `social-mobile-app-phase13-production-preview-rollout-and-qa-20260921`
- status: `review_required`; next_owner: `chatgpt`
- fresh_main: began from `origin/main` `c61e4f441e82eb8beb1647492f8c4d273d0c5158`; a concurrent H1 commit added only `supabase/migrations/20260920061041_mic_estat_activation_and_gated_macro_cron.sql`, which was not applied or included in the Function deploy. The worktree was fast-forwarded; a later H1-only update to slot-1 report/current-state files was also fast-forwarded without overlap. Current origin at progress sync: `52204ca3f35ab2a6e7c6c8c7aa8107f0567bde4a`.
- source: reviewed Phase 12 source commit `60b610292398053494d9ed73b80617d2dd2eefe6` is present in current `origin/main`; the 9 runtime files uploaded for this Function byte-match that reviewed source. No Phase 13 source edits were made.
- production_preflight: project `stock-x-autopost` / `wsmznyzcvmuitkglfeuj` was `ACTIVE_HEALTHY`. Before deploy, `social-mobile-brand-dry-run` was absent; there were 14 existing ACTIVE Functions. QA fixture read-only checks found exactly one `@yumeyoasobi` X account, identity verified with publishing disabled; one owner membership by a non-admin Auth user, one total membership, one matching inactive/disabled `social_mobile_user_v1` brand, and zero QA `scheduled_posts`. Before deploy aggregate baselines: brands 4 / hash `b884b4eec6ad2011d91f029749161aa6`; social accounts 3 / hash `642f70e9572dd5d0f01524dbf91faebb`; scheduled posts 238 / hash `d1c57e84e11bb94f3582db9b33b3d368`; OAuth-state rows 15. RLS remained enabled with self-membership read and membership-scoped brand/account reads.
- deploy: deployed only `social-mobile-brand-dry-run`, version **1**, `ACTIVE`, `verify_jwt=true`, runtime bundle SHA `3a57c02c1531d12221467162d2f0f054bff84e7955e80fab216d2baa1cdf5f59`. Runtime read-back returned exactly 9 uploaded files; each byte-compared equal to the reviewed source. All 14 unrelated Function status/version/updated_at/verify_jwt/source hashes remained unchanged.
- safe_smoke: POST with no user identity failed closed as `AUTH_REQUIRED` / HTTP 401; unsupported GET failed as `METHOD_NOT_ALLOWED` / HTTP 405. Both exit before generation by handler order. No OpenAI, Vault, X, media, scheduled-post or publish path was reached by these rejected requests.
- mobile_QA_blocker: After the user unlocked iPhone Mirroring and signed in with the QA app user, the mobile UI continued to show `@kabumori` and `@brand_studio`, not the expected QA brand. The current source explains this: `apps/social-mobile/src/data/repository-selection.ts` selects the static mock repository unless `EXPO_PUBLIC_DATA_SOURCE === 'supabase'`; `active-account-provider.tsx` uses mock accounts unless the Supabase snapshot is `ready`; and `mock-repository.ts` hardcodes those two demo accounts and demo counts. The visible screen omitted the live-source status card, matching `mock_preview`. The mock `@kabumori` account has no `brandId`; `BrandPostPreview` requires a real `brandId`, handle, and Auth session, so it cannot safely issue the authorized preview from this mock state. This is a client QA-source/configuration mismatch, not evidence that the production tenant returned another user's data.
- OAuth_UI_observation: `apps/social-mobile/src/app/accounts/index.tsx` initializes `connectState` to `idle` via component-local `useState` and has no persisted connection-status readback. The UI showed `@YumeYoasobi` connected immediately after the user's OAuth return, then the connect button after QA sign-in. This UI reset does not establish that the server-side OAuth token was revoked or unlinked. No Vault/token read, OAuth retry, or link action was performed during this diagnosis; durable server state remains unverified.
- preview: **not executed**; real OpenAI call count remains 0. No `social-mobile-brand-dry-run` authenticated generation call was made. No X API/media/post, schedule write, publish flag, or Vault access occurred.
- postdeploy_pre_preview_snapshot: read-only DB counts/hashes still equal the baseline above; QA `publish_enabled=false`, QA scheduled posts 0, and OAuth-state rows 15. This is a pre-preview snapshot, not final postflight.
- mobile_data_source: `EXPO_PUBLIC_DATA_SOURCE` is currently not set to `supabase` in the mirrored app build, or otherwise is not reaching the bundle as `supabase`; the source defaults to mock. Exact installed-build environment value was not read. The app-wide source switch is explicitly prohibited by this Phase13 TASK, so no environment/config/code change was attempted.
- C2_decision_requested: choose whether to authorize a narrowly isolated QA client/runtime using the existing QA Auth session and live RLS-scoped Supabase source (without an app-wide source switch), or an equivalent approved QA invocation path. Then require a read-only proof that the session resolves to the expected owned `social_mobile_user_v1` brand and identity-verified test X account before spending the one approved OpenAI generation. Do not select `@kabumori`, retry OAuth, or invoke generation while the UI is on static mock data. If the expected QA brand/account is absent in live mode, stop for separate read-only/RLS investigation.
- safety_checks_so_far: DB/schema/RPC/RLS/migration/Cron/settings changes 0; X API/media/post 0; OpenAI generation 0; Vault/Storage writes 0; app-wide data-source change 0; existing brands/accounts/admin OAuth unchanged per last production snapshot; secrets, tokens and user credentials exposed 0. Only account-screen navigation was used; no account selection, link, or logout action was taken by the agent.
- control_sync: after fresh-checking `origin/main` at `309acd61e6611cdcb8916cdf60f067790814ed60`, which changed only H1 `.agent/CURRENT_STATE.md` and `.agent/tasks/CODEX_TASK.md`, committed only `.agent/tasks/CODEX_TASK_2.md` and `.agent/CODEX_REPORT_2.md` as `a162bb385f446ca7f901af60d995a1a9c6e0122e`. Push succeeded; subsequent `git fetch origin main` read-back returned the exact same `origin/main` SHA and showed slot 2 `review_required` / `chatgpt`. No H1 files were staged or included.
- changed_files_for_this_handoff: `.agent/tasks/CODEX_TASK_2.md` and `.agent/CODEX_REPORT_2.md` only; mobile/Function source unchanged. Control update commit `a162bb3` is present on `origin/main`.

# H2 — Social mobile Phase 12 general-user content profile and dry-run (2026-09-20)

- task_id: `social-mobile-app-phase12-general-user-content-profile-and-dry-run-20260920`
- status: `review_required`; next_owner: `chatgpt`
- source_base: started from fresh `origin/main` `8c4841caf6615fd7acebc3d7e245d68093c6edf4`; before handoff, fetched `origin/main` at `c11ac424c4160d064c1d4e77dbf997988aa06140`. The intervening commits touched only H1 `.agent/ACTIVE_TASK.md`, `.agent/CODEX_REPORT.md`, `.agent/CURRENT_STATE.md`, and `.agent/tasks/CODEX_TASK.md`; no H2 source/TASK_2/REPORT_2 overlap. H2 worktree fast-forwarded cleanly. Formal checkout and its pre-existing changes were untouched.
- architecture: added a dedicated `social-mobile-brand-dry-run` Edge Function rather than widening the existing admin/service-role `loadBrandContext()` path. It authenticates the bearer with Supabase Auth, then performs only user-JWT + publishable-key GETs for owner memberships, the selected owned brand, and its verified X-account metadata. A client `brand_id` is only a selector, never authorization. It resolves only the exact `social_mobile_user_v1` profile, calls the existing generator with `generationPurpose: social_mobile_preview`, and returns a preview. No schedule, publish, storage, Vault, or X adapter exists on this path.
- profile/settings: registered a neutral `social_mobile_user_v1` code profile with safe Japanese voice and no fixed hashtags, secrets, QA identity, or publish permission. Added an in-memory first-run settings contract: ja-JP, natural/non-pushy tone, practical everyday theme, useful-reader-insight objective, target 3/week, manual review, Asia/Tokyo, previous-day planning window 09:00–24:00 with 17:00 generation candidate, bounded optional NG words/notes, and `livePublishingEnabled: false`. No user-editable persistence was introduced. Existing `posting_windows` remains untouched; its current admin-operated access model is not reused as a user-write settings store. Persisted settings/windows need a separately reviewed tenant-safe schema/RPC design if later required.
- mobile UX: added a Home preview card with not-configured, generating, ready, and error states. It identifies the workspace and connected verified X handle, renders generated text in client state only, and offers no publish action/toggle. Repository mapping now includes `brandId` and uses `identity_verified` for the connected state.
- tenant/security proof: eight mocked dry-run tests cover bearer validation, verified-user ownership, non-owner denial, explicit workspace selection when multiple are owned, unknown-profile fail-closed behavior, verified-account requirement, read-only disabled-QA preview, and error/secret suppression. Tests assert requests are GET-only and limited to Auth plus membership/brand/account reads. Publish guard and generator tests verify preview is restricted to the new profile and the disabled workspace cannot enter scheduled/publish behavior. No service-role key is read or used; no Vault refs/tokens are queried or returned.
- changed_files: `apps/social-mobile/src/app/(tabs)/index.tsx`; `apps/social-mobile/src/data/supabase-repository.ts`; `apps/social-mobile/src/domain/types.ts`; `apps/social-mobile/src/features/brand-preview/brand-post-preview.tsx`; `supabase/functions/_shared/brand/brand_post_generator.ts`; `supabase/functions/_shared/brand/brand_post_generator_test.ts`; `supabase/functions/_shared/brand/brand_profiles.ts`; `supabase/functions/_shared/brand/brand_profiles_test.ts`; `supabase/functions/_shared/brand/publish_guard.ts`; `supabase/functions/_shared/brand/social_mobile_content_settings.ts`; `supabase/functions/_shared/brand/social_mobile_content_settings_test.ts`; `supabase/functions/social-mobile-brand-dry-run/index.ts`; `supabase/functions/social-mobile-brand-dry-run/logic.ts`; `supabase/functions/social-mobile-brand-dry-run/logic_test.ts`; plus this report and `.agent/tasks/CODEX_TASK_2.md` control-state update.
- implementation_commit: `60b6102` (`Add social mobile general-user content preview`), created in the isolated H2 worktree after staging only the 14 listed source/test files.
- tests: relevant shared-brand + dry-run Deno tests **75/75 PASS**; social-mobile `npm run typecheck` PASS; `npm run lint` PASS; `npx expo export --platform ios` PASS; Edge Function `deno check` PASS (source unchanged since that check); `git diff --check` PASS. Static scan found no service-role credential/key literals or secret values in changed source. No manual simulator interaction was performed.
- production_and_external_actions: production DB/schema/RPC/RLS/migration writes **0**; Edge deploy **0**; Cron/scheduler/settings changes **0**; OpenAI live calls **0** (mocked only); X API/media/post calls **0**; Vault/Storage changes **0**; publish-enabled mutation **0**; production manual invoke **0**; secrets exposed **0**.
- remaining_issues: settings are code-owned preview defaults, not persisted user preferences; `posting_windows` is intentionally not writable from this user flow. No production QA invocation was made. C2 should review the tenant boundary, profile/generator integration, preview-only contract, and decide whether a separate migration/RPC design is needed before settings persistence or any deployment. Do not enable publishing as part of this Phase.
- safety_checks: no changes outside the isolated worktree; H1/G1/G2 source and reports untouched. No production mutation, deployment, AI/X/Push invocation, or publish attempt.

# H2 — Phase 11 dedicated QA real X OAuth round-trip (2026-09-20)

- task_id: `social-mobile-app-phase11-x-portal-and-real-oauth-qa-20260920`
- status: `review_required`
- next_owner: `chatgpt`
- result: Exactly one OAuth authorization callback was successfully consumed. The mobile Accounts screen displayed the linked account as connected. Production publishing remains disabled for this QA account.
- QA identity: Latest consumed OAuth state was initiated by a user absent from `public.admin_users` (`initiator_is_admin=false`). The user confirmed this is the dedicated QA Auth login.
- X identity: The newly verified X account is `@yumeyoasobi`, distinct from the two pre-existing X accounts `@yume_daka` and `@kaishain_ai_lab`. The account is `identity_verified`, has `verified_at`, and `publish_enabled=false`.
- OAuth state accounting: Five state rows are associated with this QA user; one was consumed successfully at `2026-09-20 05:26:56 UTC`. Four earlier rows are expired and unconsumed. Their cause was not established; they were left untouched. No replay was attempted.
- Vault: The linked account has access-token and refresh-token secret references, and both referenced `vault.secrets` rows exist. No secret values, token ciphertexts, OAuth codes, PKCE verifiers, or state hashes were selected or logged.
- Tenant isolation: The QA user has exactly one `brand_memberships` row, with owner role for the same brand as the linked account, and zero memberships for other brands. Read-back of RLS policies showed `brand_memberships` self-select scoped to `auth.uid()` and `brands`/`social_accounts` selects scoped to membership. This is policy-level proof; no separate authenticated cross-tenant probe was run.
- Existing accounts: Read-back still showed the pre-existing `@yume_daka` and `@kaishain_ai_lab` accounts, both with their prior earlier creation times. The new QA account is a separate row. No admin OAuth record was changed by this task.
- X/OpenAI actions: OAuth authorization/token exchange and identity verification were part of the approved round-trip. No X media upload or post/repost endpoint was called; X posts = 0. OpenAI calls = 0. `publish_enabled` was not changed.
- Deployment/configuration: No deployment, migration, schema/RLS/RPC, Cron, scheduler, settings, secrets, or OAuth Portal change was made during this continuation.
- Cleanup: No QA user/workspace/account/Vault cleanup was performed. C2 should choose whether to retain this as a regression fixture or authorize a separate cleanup task.
- Source/tests: No source changes in this continuation. Previously approved source commit `56506847613b47ea882ad48211649b587a016fbd` remains the mobile env-inlining fix; previously recorded verification remains typecheck PASS, lint PASS, OAuth/onboarding 27/27 PASS, iOS export/bundle verification PASS, Release build/install PASS, and `git diff --check` PASS.
- GitHub sync: A fresh `origin/main` check found `67fa2d2660d79a30d0761dccb0992740f38f66d4`; the intervening changes were limited to H1/CURRENT_STATE files and did not conflict with H2. Report/TASK-only commit `d0e433fb6526ea2bc0e0e4020e0a637b43736097` was pushed successfully. A post-push fetch confirmed `origin/main` at the same SHA and read-back verified this task's report plus `review_required` / `next_owner: chatgpt`. Formal checkout and its existing uncommitted changes remain untouched.
- remaining_issues: Four expired, unconsumed OAuth state rows remain; their origin is unknown and they were not cleaned up. Cross-tenant isolation was confirmed from the live RLS policy definitions and single-brand membership, not via a separately impersonated session probe. C2 should choose whether to retain the QA fixture or authorize a separate cleanup task.
- safety_checks: X post 0; media upload 0; `publish_enabled=true` change 0; OpenAI calls 0; deploy 0; schema/RLS/RPC/migration change 0; Cron/scheduler/settings change 0; OAuth Portal change 0; token/secret values exposed 0; existing production X accounts untouched; formal repo and unrelated workstreams untouched.

# Codex Slot 2 Report

## H2 — Phase 11 QA stopped for mobile public-env bundle defect (2026-09-20)

- task_id: `social-mobile-app-phase11-x-portal-and-real-oauth-qa-20260920`
- result: User confirmed the X Portal setup, dedicated non-admin QA Auth user, and dedicated test X account. During installation/startup on the paired iPhone, the app showed `Supabase接続設定がありません` and could not sign in. This is a real client configuration defect, so the OAuth round-trip was stopped before login/authorization and returned to C2 for review.
- source_base: fresh isolated clone initially at `origin/main` `739b3caab30c33b138a45cc06bb7444a00ca8a81`; before preparing the C2 review change, fetched and fast-forwarded to fresh `origin/main` `d3070e3451d8413fe1e10057410a38b3d385dd8b`. The four intervening commits changed only `.agent/CURRENT_STATE.md` and slot-1 `.agent/tasks/CODEX_TASK.md`, so there was no overlap with this H2 source/TASK/REPORT. Other slots remained H1 `review_required`, G1 `idle`, G2 `done`. Formal repo and its existing uncommitted changes were untouched.
- root_cause: `apps/social-mobile/src/lib/supabase.ts` read `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` indirectly through a generic `process.env` object. Expo's native bundle did not inline those dynamic lookups; the first installed build's JS bundle contained neither configured value and the app correctly failed closed with the missing-config banner.
- local_source_fix: In the isolated fresh clone only, define a small `expoPublicEnv` object using direct static `process.env.EXPO_PUBLIC_*` property references and use it as the default for both `getSupabaseConfig()` and `createSupabaseClient()`. This keeps injected test environments supported, uses only the publishable client key, and does not add secrets or change auth/RLS behavior. Source change is limited to `apps/social-mobile/src/lib/supabase.ts`; it is not deployed. Temporary Expo prebuild outputs remain local/untracked and are not part of the source patch.
- commit_push: implementation plus this H2 TASK/REPORT update were committed as `56506847613b47ea882ad48211649b587a016fbd` and pushed to `origin/main`; post-push `git ls-remote` read-back matched that SHA. No deployment followed.
- verification: `npm run typecheck` PASS; `npm run lint` PASS; `deno test --no-check --allow-read supabase/functions/x-oauth-connect-user/oauth_logic_test.ts supabase/functions/x-oauth-connect-user/mobile_oauth_onboarding_test.ts` **27/27 PASS**; `npx expo export --platform ios` PASS and a non-printing bundle check confirmed both configured values were embedded; Release iOS build/install PASS and the login screen appeared without the missing-config banner; `git diff --check` PASS.
- oauth_round_trip: **not attempted**. QA login credentials were not requested or entered; X consent was not opened; no OAuth state, workspace, membership, social account, or Vault token was created by this attempt. No X API, media upload, or post was made; `publish_enabled` was not changed.
- next_gate: C2 should review the one-file mobile environment-inlining fix before any production-facing QA continues. After approval, use the dedicated QA Auth user on the installed app; the user must enter credentials directly, and confirmation is still required immediately before granting X account access on the consent screen.
- safety_checks: production DB/Vault writes 0; OAuth state/account/workspace writes 0; X Developer Portal changes 0; X consent 0; X API/media/post 0; deploy 0; DB/Cron/settings/secrets/OAuth configuration changes 0; formal repo changes 0; secrets/passwords/token values exposed 0.

## H2 — Phase 11 X Portal / real OAuth QA manual gate (2026-09-20)

- task_id: `social-mobile-app-phase11-x-portal-and-real-oauth-qa-20260920`
- result: Scope A production read-only preflight and repository checks passed for source integrity, RPC security, callback URI, and requested scopes. Scope B/C cannot be completed autonomously: the X Developer Portal must be confirmed manually and production currently has no dedicated non-admin QA Auth user. No real OAuth round-trip was attempted. Status is `review_required`; next_owner is `chatgpt`.
- source: clean isolated worktree at fresh `origin/main` `1ab6c1190f6f6a389a70449c2efa607b7f167d48`. H1 targeted a separate important-news shadow continuation; G1 was idle and G2 done. No source overlap or formal-checkout mutation occurred.
- function_preflight: `x-oauth-connect-user` is ACTIVE and `verify_jwt=false`. The current Function API reports version `3`, while `updated_at=1789856530176` and runtime source hash `4cd7375395b92919085032b514ae7c1086238e8b3571dc65aa8421cd722715ef` remain unchanged from the approved Phase 10 rollout. Runtime `index.ts` and `oauth_logic.ts` are byte-equal to current `origin/main`; therefore no source drift was found, but the version-label difference is explicitly recorded rather than represented as v1.
- rpc_preflight: all three general-user OAuth RPCs are present. Each is `SECURITY DEFINER`; begin/consume use `search_path=public`, complete uses `search_path=public, vault`; EXECUTE is authenticated=yes and public/anon/service_role=no. No RPC, ACL, RLS, schema, or Vault change was made.
- data_preflight: production read-only counts are Auth users=1, admins=1, non-admin users=0, brands=3, social_accounts=2, brand_memberships=0, OAuth states=10, and user-initiated OAuth states=0. Existing admin/social-account identity hashes were recorded without selecting or exposing PII, credentials, or token values.
- mobile_contract: callback URI remains exactly `kabumori-social://oauth-callback`. Requested scopes remain exactly `tweet.read users.read tweet.write media.write offline.access`. The Function resolves the supplied bearer token through Supabase Auth and fails closed before OAuth work when authentication fails.
- portal_status: **unconfirmed and unchanged**. Required manual X Developer Portal checklist: (1) enable OAuth 2.0; (2) select an app/OAuth mode compatible with Authorization Code + PKCE; (3) save callback URI exactly `kabumori-social://oauth-callback`; (4) configure permissions sufficient for `tweet.read`, `users.read`, `tweet.write`, `media.write`, and offline refresh; (5) supply website/app metadata only if the Portal requires it to save; (6) confirm those exact saved settings without sharing any client secret.
- qa_identity_status: **not ready**. A dedicated non-admin Supabase Auth QA user must be created through the normal Auth lifecycle and remain absent from `public.admin_users`. A dedicated safe test X account must also be available. Do not reuse the existing admin Auth identity or the production AI Lab/kabumori X accounts, and do not send passwords, tokens, or secrets in chat.
- real_oauth_round_trip: not executed because Scope B/C gates are incomplete. Production writes for QA workspace/membership/social account/OAuth state/Vault tokens are 0; X authorization/token exchange/media upload/post are 0; `publish_enabled` was not changed.
- retain_vs_cleanup: not applicable until a successful dedicated QA round-trip exists. At that later point, C2 should explicitly choose either retaining it as a dedicated QA fixture or authorizing a separate cleanup task; no automatic cleanup is allowed.
- tests: OAuth logic + mobile onboarding runtime tests **27/27 PASS** with `deno test --no-check --allow-read`. A normal checked Deno invocation could not resolve `npm:@types/node` from the clean worktree dependency layout and stopped before tests; no dependency install or config workaround was made. `apps/social-mobile` `npm run typecheck` **PASS** and `npm run lint` **PASS**. `git diff --check` **PASS** before control-file edits.
- changed_files: `.agent/tasks/CODEX_TASK_2.md` and `.agent/CODEX_REPORT_2.md` only for task/report state. Application, mobile, migration, Function, and production source files were not changed.
- remaining_issues: The user must first confirm the exact Portal settings and provide readiness of one dedicated non-admin Auth QA identity plus one dedicated test X account. Resume this same H2 only after both gates are satisfied. The Function version label should be treated as metadata drift to observe; runtime source and `updated_at` prove no implementation drift.
- safety_checks: production DB writes 0; OAuth/Vault writes 0; X Developer Portal changes 0; real OAuth 0; X/media/post calls 0; deploys 0; Cron/settings changes 0; secrets/PII exposed 0; formal repo existing changes untouched.

## H2 — Phase 10 production OAuth backend rollout completed (2026-09-20)

- task_id: `social-mobile-app-phase10-production-oauth-rollout-20260920`
- result: After the user explicitly authorized the exact production migration and the `x-oauth-connect-user` Function only, Gate A through Gate D completed successfully. Status is `review_required`; next_owner is `chatgpt`.
- source: fresh `origin/main` was `890cffbb9cdf7a583db8b17f57502efe71f2fe71` at rollout. The approved migration SHA-256 remained `b778e142d6efb07a6239958a3edf38d08a2e1a07f0c58beab8298a2bd204bcab`. No source drift existed in the migration or Function files after the earlier C2 authorization-gate update.
- slot_conflict_check: H1 had completed its separate `important_news_shadow_phase1` production resources before this write; H2 preflight was rerun against that new baseline. H1 targets, G1/G2 targets, OAuth/Vault objects, and this migration/Function did not overlap. The formal repository's pre-existing uncommitted changes were untouched.
- migration_apply: exact migration `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql` applied once through the migration API. Production migration history recorded version `20260919222101`, name `social_mobile_x_oauth_onboarding`. `supabase db push`, history repair, and reconcile were not used.
- schema_postflight: `social_accounts_platform_user_id_key` exists as a partial UNIQUE index on `(platform, platform_user_id) WHERE platform_user_id IS NOT NULL`. `social_account_oauth_states.initiated_by_user_id` is nullable UUID with `auth.users(id) ON DELETE CASCADE`. Exactly three target RPCs exist with the approved signatures. All are `SECURITY DEFINER`; begin/consume use `search_path=public`, complete uses `search_path=public, vault`. EXECUTE is authenticated=yes and public/anon/service_role=no for all three.
- compatibility_postflight: RLS remained enabled on brands/social_accounts/brand_memberships/social_account_oauth_states. Existing policy hash remained `f018bf7baa7d97d14b9985a5bbc996f8`. The six existing admin OAuth RPC definition hashes/ACL/search paths were unchanged. Existing admin `x-oauth-connect` remained ACTIVE v20, `verify_jwt=false`, source hash `96a5d3ea5a938a1f972e1a74aa6013f6a18934926ffcd30c2b4fb0f1746b7f98`.
- row_mutation_summary: brands=3, social_accounts=2, brand_memberships=0, OAuth states=10 before and after. Existing brand/social-account/membership identity hashes were unchanged. Final read-back found `initiated_by_user_id IS NOT NULL` rows=0, proving no general-user OAuth state/workspace/account/token fixture was created.
- edge_deploy: deployed only `x-oauth-connect-user`; version 1, ACTIVE, `verify_jwt=false`, runtime bundle hash `4cd7375395b92919085032b514ae7c1086238e8b3571dc65aa8421cd722715ef`. `verify_jwt=false` is intentional because this Function implements custom fail-closed bearer validation against Supabase Auth (`/auth/v1/user`) before any RPC, matching the existing custom-auth architecture without relying on the gateway's legacy JWT check.
- source_equivalence: runtime download/read-back contained exactly `index.ts` and `oauth_logic.ts`. Both were byte-equal to `origin/main` source (lengths 4,923 and 12,248 respectively). Local SHA-256 values were `9b63b8591a177bac8125df4a8b794ebdb3b10b4a4fec95a034e3581d32d548eb` and `fde4a33772100b4ccd50320414da9042c9b4e78692884dedc12444735eef660b`.
- unrelated_functions: all pre-existing Function versions/updated_at remained unchanged after deploy, including `x-oauth-connect` v20. The separately completed H1 `important-news-shadow` v1 was part of the refreshed predeploy baseline and was not modified by H2.
- safe_smoke: unauthenticated POST returned HTTP 401 with `SOCIAL_MOBILE_OAUTH_AUTH_REQUIRED`; unsupported GET returned HTTP 405 with `METHOD_NOT_ALLOWED`. These paths terminate before DB RPC, X authorization, token exchange, Vault write, media upload, or X post.
- portal_and_real_oauth: X Developer Portal was not changed. Manual follow-up still requires callback URI `kabumori-social://oauth-callback` and permissions/scopes supporting `tweet.read users.read tweet.write media.write offline.access`. Real X authorization, token exchange, Vault token storage, social account creation, media upload, and X posting remain unexecuted and require a separate explicit gate.
- rollback_recovery: Function rollback can redeploy the prior approved source/version policy if needed. Schema rollback is not automatic because the migration is now recorded; any reverse migration must be separately designed/reviewed and must first prove no user OAuth states/accounts depend on the new objects. No rollback is currently indicated by postflight.
- changed_files: `.agent/tasks/CODEX_TASK_2.md`, `.agent/CODEX_REPORT_2.md` only for control/reporting. Application and Function source files were not changed during rollout.
- tests_and_checks: approved Phase 9 baseline remains OAuth 19/19, onboarding 8/8, full Deno 1259/1259, lint/typecheck/Expo export PASS. `git diff --check` PASS before rollout. Production postflight, runtime byte comparison, and safe 401/405 smoke PASS.
- safety_checks: X Developer Portal changes 0; real OAuth 0; Vault token writes 0; new production data rows 0; X/OpenAI/Push calls 0; X posts 0; Cron/settings changes 0; unrelated Function deploys 0; secrets exposed 0; formal repo existing changes untouched.

## H2 — Phase 10 production OAuth rollout preflight / blocked before mutation (2026-09-20)

- task_id: `social-mobile-app-phase10-production-oauth-rollout-20260920`
- result: Production Gate A read-only preflight passed, but the exact migration apply was rejected by the automated safety reviewer before execution because this conversation did not contain a trusted, explicit user message authorizing the production schema/security mutation. The rejection specifically covered the unique index, nullable Auth FK column, three `SECURITY DEFINER` OAuth RPCs, and Vault-backed token-write path. No workaround or alternate execution path was attempted. Status is `review_required`; next_owner is `chatgpt`.
- source: fresh `origin/main` and the dedicated preflight ref both resolved to `fc7b5b8168d1d2e8da4f2caea73db39ef2938bc8`. The isolated worktree was detached at that SHA. Approved migration SHA-256: `b778e142d6efb07a6239958a3edf38d08a2e1a07f0c58beab8298a2bd204bcab` for `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql`.
- slot_conflict_check: H1 remained `ready` on an unrelated important-news shadow rollout; G1 was `idle`; G2 was `done`. No other slot targeted this migration, these RPCs, `x-oauth-connect-user`, or OAuth/Vault settings. The formal repository's extensive pre-existing uncommitted changes were not touched.
- production_identity: project `stock-x-autopost`, ref `wsmznyzcvmuitkglfeuj`, region `ap-northeast-1`, status `ACTIVE_HEALTHY`, Postgres 17.6.
- gate_a_preflight: target partial unique index absent; `social_account_oauth_states.initiated_by_user_id` absent; all three target RPCs absent; migration history had no Phase 10 entry; duplicate non-null `(platform, platform_user_id)` groups = 0. Required tables/columns/check constraints, `brand_memberships_pkey`, nullable-compatible OAuth-state shape, Vault schema, `vault.create_secret` defaults, and `vault.update_secret` defaults were compatible. RLS was enabled on all four target tables. Existing admin OAuth RPC definitions/ACL/search paths were snapshotted read-only.
- production_baseline: brands=3, social_accounts=2, brand_memberships=0, social_account_oauth_states=10. Identity hashes were recorded for brands/social_accounts/memberships. Existing admin `x-oauth-connect` remained ACTIVE v20, `verify_jwt=false`, source hash `96a5d3ea5a938a1f972e1a74aa6013f6a18934926ffcd30c2b4fb0f1746b7f98`.
- migration_apply: **not executed**. The migration tool call returned an automated risk rejection before database execution. Immediate read-back confirmed the target index/column/RPCs remain absent, migration history is unchanged, row counts and identity hashes match the baseline, and no partial state exists.
- edge_deploy: **not executed** because Gate B did not complete. `x-oauth-connect-user` is not deployed. Function smoke tests were therefore not run. Existing `x-oauth-connect` and all unrelated Function versions/updated_at remain unchanged from the baseline inventory.
- production_mutation: schema/RPC/index/FK/grants/RLS/migration history/rows/Edge Functions/X Developer Portal/Vault token values/OAuth settings/Cron/settings/X/Push/Storage = **0 changes**.
- manual_portal_gate: still pending a later explicit gate. Required callback is `kabumori-social://oauth-callback`; portal permission/scopes must support `tweet.read users.read tweet.write media.write offline.access`. No portal setting was inspected or changed.
- real_oauth_round_trip: still pending and was not attempted. No real authorization URL completion, X token exchange, Vault token write, user workspace/account fixture, media upload, or X post occurred.
- rollback_recovery: no rollback was necessary because production was not mutated. If the owner explicitly authorizes the exact production migration in a trusted user message, rerun Gate A from fresh `origin/main`; only then apply the same SHA-256 source once, read back all ACL/RPC/index/FK invariants, and deploy only `x-oauth-connect-user` with custom internal JWT validation preserved.
- tests: no source change was made. `git diff --check` passed before the attempted rollout. Phase 9 approved tests remain the prior 19/19 OAuth, 8/8 onboarding, 1259/1259 full Deno, lint/typecheck/Expo export PASS baseline; they were not rerun because this H2 was a production rollout task and no source changed.
- changed_files: `.agent/tasks/CODEX_TASK_2.md`, `.agent/CODEX_REPORT_2.md` only (control/reporting updates).
- safety_checks: `db push` 0; migration history repair/reconcile 0; code changes 0; deploy 0; production manual invoke 0; OpenAI/X/Push calls 0; X posts 0; secret exposure 0; H1/G1/G2 files 0; formal repo existing changes untouched.

## H2 Follow-up — X OAuth posting scope hardening (2026-09-19)

- task_id: `social-mobile-app-phase9-codex-handoff-integration-20260919`
- result: Implemented the single C2 blocker fix in a clean isolated worktree from fresh `origin/main` `aa2694c43f28612548ebbce3e10bc6c043b43c02`; status `review_required`, next_owner `chatgpt`.
- changed_files: `supabase/functions/x-oauth-connect-user/oauth_logic.ts`, `supabase/functions/x-oauth-connect-user/oauth_logic_test.ts`, `apps/social-mobile/docs/phase9-x-oauth-onboarding.md`.
- scopes: exact authorization scope is now `tweet.read users.read tweet.write media.write offline.access`. `tweet.write` covers the existing `/2/tweets` flow. `media.write` is included because the repo's existing `morning_greeting_publish_logic.ts` calls `/2/media/upload`, and its regression test captures X's explicit `Missing required scope: media.write` failure. No other scopes were added. This is repository-flow evidence; no external portal configuration was inspected or changed.
- tests: OAuth function tests **19/19 PASS** (including exact-scope regression); onboarding/deep-link tests **8/8 PASS**; full Deno regression **1259/1259 PASS**; social-mobile lint/typecheck/Expo web export and `git diff --check` **PASS**.
- production: migration/schema/RPC/RLS/ACL/deploy/X Developer Portal/Vault/OAuth settings/Cron/settings/manual API/X post/Push changes **0**. Manual portal configuration remains pending separate approval; verify callback URI `kabumori-social://oauth-callback` and that app permission settings permit the requested posting/media scopes.
- commit/push: source commit `ac08cf7` contains only the three C2-approved scope/doc/test files. Source plus Report/TASK commits were pushed successfully to `origin/main` through `f3e8292250dbe97a62ea84c43e39773e3c5b6658`, after fresh-checking `d19594abff1eb968ed21dddd8c88f26fb5b46bdd`; push was fast-forward with no H1 file overlap. No production rollout is approved.

## H2 — Social mobile Phase 9 OAuth onboarding integration (2026-09-19)

- task_id: `social-mobile-app-phase9-codex-handoff-integration-20260919`
- status: `review_required`; next_owner: `chatgpt`
- fresh_main: started from `c3bc1bb064a2927dee93d1a6a9ea3e10d530c0f7`. Before publication, `origin/main` advanced by two H1-only commits (`9c50882`, `b562e6c`); the H2 branch was rebased cleanly onto `b562e6c2b10bd100e56c1b20cbfd2dd7cb9b3f6c`. No overlapping source changes were present.
- implementation: reviewed Phase 9 commits were integrated, then the minimal Accounts-screen OAuth flow and deep-link contract were added. H2 source commit: `8ae688d` (after rebase). Changed files: `apps/social-mobile/app.json`, `apps/social-mobile/docs/phase9-x-oauth-onboarding.md`, `apps/social-mobile/package.json`, `apps/social-mobile/package-lock.json`, `apps/social-mobile/src/app/accounts/index.tsx`, `apps/social-mobile/src/lib/x-oauth-onboarding.ts`, `supabase/functions/x-oauth-connect-user/index.ts`, `supabase/functions/x-oauth-connect-user/oauth_logic_test.ts`, `supabase/functions/x-oauth-connect-user/mobile_oauth_onboarding_test.ts`, `supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql`.
- migration_candidate_fixes: first-user membership insert now targets the known `brand_memberships_pkey` constraint, avoiding PL/pgSQL output-variable ambiguity. The three mobile RPCs explicitly revoke execute from `public`, `anon`, and `service_role`, then grant only to `authenticated`.
- disposable_db_proof: the final candidate migration applied in the dedicated local Supabase project. Read-back confirmed all three RPCs are `SECURITY DEFINER`; `begin`/`consume` use `search_path=public`, `complete` uses `public,vault`; execute ACL is limited to owner and `authenticated` (not `anon`/`service_role`). Two-user/brand checks passed: owner-scoped creation, cross-user consume/complete denied, consume remains read-only, successful replay denied, duplicate X platform identity rejected, failed completion transaction rolled back and remained retryable, and concurrent completion yielded exactly one success. `publish_enabled` remained false. Local historical replay required a disposable-only cron shim and minimal baseline matching read-only current-schema metadata because repository history alone lacks the live baseline; no production data was copied.
- rollback_limit: transaction rollback after simulated completion failure was verified and all local fixtures were removed when the exact disposable project was stopped with `--no-backup`. An additional restart to perform a separate reverse-DDL/object-absence read-back could not run because Podman returned an SSH handshake failure. No production or shared local DB was used; this limitation is retained for C2 review.
- mobile_flow: Accounts screen now creates cryptographically random state and PKCE verifier in memory, computes S256 challenge, invokes the start/callback function with the signed-in user's JWT, validates exact `kabumori-social://oauth-callback` URI and raw state before callback, and presents connecting/connected/cancelled/retryable/terminal states plus the verified handle. It does not persist or log OAuth state, verifier, access/refresh tokens, or secrets. `publish_enabled` is not changed by this UI.
- tests: OAuth function tests **18/18 PASS**; onboarding/deep-link tests **8/8 PASS**; full Deno regression **1258/1258 PASS**; social-mobile `npm run lint` **PASS**, `npm run typecheck` **PASS**, Expo web export **PASS**; `git diff --check` **PASS**. Static scan found only expected secret-name documentation and the publishable-key guard; no secret values or token persistence/logging were introduced.
- x_portal_step: after separate C2 approval, configure the X Developer Portal callback URI exactly as `kabumori-social://oauth-callback`; no portal setting was changed here. A real X OAuth round-trip remains untested.
- production_mutation: **0**. No production migration/RPC/schema/RLS/grant, Edge Function deploy, X Developer Portal change, Vault/OAuth change, Cron/settings, manual API invocation, X post, Push, or synthetic candidate was performed.
- push: H2 implementation, candidate integration, and Report/TASK commits pushed successfully to `origin/main`; final commit `c61b4b50f18fd40928fd859f913f44d4912a4297` is present on GitHub and was read back. The earlier H2 push advanced `b562e6c2b10bd100e56c1b20cbfd2dd7cb9b3f6c` to `a7b4ace43051cfdfe5bdec5196fe15a84080eb70`, followed by this Report-only commit. Both pushes followed fresh origin checks and were fast-forward; no H1 overlap. No deploy is authorized by this H2.
- safety_checks: formal repo and its pre-existing changes, slot 1 files, `apps/admin/**`, `HANDOFF.md`, and other workstreams were untouched. No credentials or personal identifiers were recorded.

## H2 — Social mobile Phase 8 non-admin Auth test-user setup and tenant proof (2026-09-18, follow-up)

- task_id: `social-mobile-app-phase8-nonadmin-test-user-setup-and-tenant-proof-20260918`
- result: Completed the available Phase 8 QA gates without changing source or production schema. A non-admin Auth user and one `ai_salaryman_lab/viewer` membership are now present through the user's normal setup. The user-provided Dashboard read-only session proof demonstrates tenant isolation; mobile dependency checks also pass in an isolated worktree. No manual credentials, tokens, or personal identifiers were collected.
- source_base: fresh `origin/main` `64bb02d64bc3c4abdf9c9027ecf99b88ca90f622`; isolated clean worktree `/private/tmp/kabumori-h2-phase8b-o1h67m`.
- auth_and_membership_readback: production read-only counts are `auth.users=2`, `admin_users=1`, `profiles=1`, `brand_memberships=2`. Memberships are exactly two `ai_salaryman_lab/viewer` rows: one for the preserved global-admin canary and one for the non-admin QA user. `kabumori`/`mio` membership rows are 0. The non-admin user is absent from `admin_users`; one Auth user still lacks a profile row, so profile lifecycle remains an explicit follow-up observation.
- tenant_runtime_proof: the user-recorded read-only SQL session in Supabase Dashboard (authenticated non-admin role, RLS enabled, transaction rolled back) observed only `ai_salaryman_lab`: `brand_memberships=1`, `brands=1`, `social_accounts=1`, `scheduled_posts=24`, `post_execution_logs=46`, `posting_windows=10`; `kabumori=0`, `mio=0`. No client-side brand filter was relied on. Existing global-admin policy path was not modified.
- membership_write_denial: production metadata confirms `authenticated` has no INSERT/UPDATE/DELETE grant on `public.brand_memberships`; only the self-membership SELECT policy exists. No write mutation was attempted.
- adapter_qa: static inspection confirms mobile uses `auth.getUser()` plus self-scoped `brand_memberships`, fail-closed blocked/no-workspace behavior, no `admin_users`/`private.is_admin()` dependency, no silent mock fallback, and no service-role/secret selection. Production default `EXPO_PUBLIC_DATA_SOURCE=mock` remains unchanged.
- tests: in the isolated worktree after `npm ci --ignore-scripts` (package/lock unchanged): `npm run typecheck` **PASS**; `npm run lint` **PASS**; `npx expo export --platform web --output-dir /private/tmp/social-mobile-phase8b-web` **PASS**; static policy contract **5/5 PASS**; `git diff --check` **PASS**. `git status` shows no tracked changes; only ignored temporary `node_modules`/`.expo` were created.
- cleanup: no approved Auth-user or membership deletion tool is available. The non-admin QA user/membership and the older global-admin canary remain as explicit test fixtures; no deletion workaround was attempted. Cleanup should be done later through the Dashboard's normal approved lifecycle, preserving all real users and admin policy rows.
- production_mutation: this follow-up performed read-only SQL/metadata checks only. No Auth, membership, profile, schema, RLS, grant, migration history, Cron/settings, deploy, OAuth/Vault, Storage, AI, SNS, Push, or app-default mutation was performed.
- remaining_issues: mobile runtime sign-in with the non-admin user's credential was not executed in this environment because no credential/session was provided and no Auth-login connector exists. The Dashboard proof covers the RLS boundary; an optional local device sign-in can be performed later without changing production defaults. Cleanup of the two test fixtures still needs an approved Dashboard path.
- safety_checks: formal repo and existing uncommitted changes, `apps/admin/**`, H1/G1/G2 workstreams, and `HANDOFF.md` were untouched. No secrets, passwords, tokens, emails, user IDs, or personal data were recorded. TASK is set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 8 non-admin Auth test-user setup and tenant proof (2026-09-18)

- task_id: `social-mobile-app-phase8-nonadmin-test-user-setup-and-tenant-proof-20260918`
- result: **Stopped safely at Gate 1.** A non-admin Auth test user cannot be created through an available approved tool in this environment, so no production mutation was attempted. Gate 3 membership setup and Gate 4 real authenticated tenant-isolation proof were not run.
- source_base: fresh `origin/main` `04b4d13f2f579b3fb5ae1156bae6aa7b9ece990c`; isolated clean worktree `/private/tmp/kabumori-h2-phase8-8wBuO9`.
- production_read_only: project `stock-x-autopost` is ACTIVE_HEALTHY (Supabase ref `wsmznyzcvmuitkglfeuj`, ap-northeast-1, PostgreSQL 17). Counts read without mutation: `auth.users=1`, `admin_users=1`, `profiles=1`, `brand_memberships=1`. The existing membership summary is one `ai_salaryman_lab/viewer` row. The only Auth user is also the existing admin user, so there is no non-admin session suitable for this proof.
- auth_lifecycle: no Supabase MCP/connector operation for creating an Auth user via email/password signup, invite, or another normal lifecycle is available. Direct SQL `auth.users` INSERT/DELETE is prohibited by the task and was not attempted. No password, token, email, user id, or other personal identifier is recorded.
- manual_next_step: in Supabase Dashboard, use Authentication → Users → Add user (or Invite user) to create exactly one QA account with a user-controlled credential. Confirm it is absent from `public.admin_users`; allow the existing application/profile lifecycle to create its profile if applicable. Then resume H2 for the single `ai_salaryman_lab/viewer` membership and real-session tenant proof. Do not use the global-admin account or the existing canary for non-admin proof.
- membership_and_qa: no new membership was inserted, no `kabumori`/`mio` membership was added, and no authenticated mobile read/write or tenant-isolation runtime proof was claimed. The existing global-admin canary remains unchanged and is excluded from this QA.
- app_state: `apps/social-mobile` remains read-only in this turn; production default `EXPO_PUBLIC_DATA_SOURCE=mock` is unchanged. No migration, RLS/policy, admin user, app setting, deploy, OAuth/Vault, X/Push/AI/Storage, Cron, or scheduler change was made.
- tests: no source changes. Prior Phase 7 static policy contract **5/5 PASS** and `git diff --check` **PASS** remain valid. Isolated `npm run typecheck` / `npm run lint` were unavailable because dependencies (`tsc`/`expo`) are not installed; no dependency installation or network workaround was attempted.
- production_mutation: **0**. No Auth user, membership, profile, schema, policy, settings, or production API mutation occurred.
- remaining_issues: the user must create one non-admin QA Auth user through the Dashboard's normal Auth lifecycle. After that, rerun H2 Gate 2 onward; only then can membership setup, tenant isolation, mobile adapter QA, and cleanup be proven. Production default mock must remain unchanged.
- safety_checks: formal repo existing changes, `apps/admin/**`, H1/G1/G2 workstreams, and `HANDOFF.md` were untouched. No secret, password, token, or personal data was exposed. TASK is set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 7 auth-role separation audit (2026-09-18)

- task_id: `social-mobile-app-phase7-auth-role-separation-and-tenant-isolation-20260918`
- result: Completed read-only role-boundary audit. The only production Auth user is also in `admin_users`; the existing canary remains `ai_salaryman_lab/viewer`. A non-admin user is not present, so tenant-only runtime proof cannot safely proceed without creating a new Auth user through a normal approved lifecycle.
- gate1: production metadata confirms auth_users=1, admin_users=1, profiles=1, brands=3, and brand_memberships=1 (`ai_salaryman_lab`, viewer). No user creation or membership change was made in this turn.
- role_separation_design: mobile does not call `private.is_admin()` or `admin_users`; it uses `auth.getUser()` then self-scoped `brand_memberships` and fail-closed blocked/no-workspace states. `apps/admin` separately performs admin_users checks. This keeps admin and mobile code paths separated.
- non_admin_path: no existing non-admin Auth user. Creating one via SQL or an unapproved shortcut is prohibited; manual Supabase Auth signup/invite with a user-controlled credential and profile lifecycle is required before Gate 3.
- tenant_qa: global-admin canary is explicitly excluded from tenant-only proof. Existing QA showed `kabumori` operational rows visible through the preserved admin-policy OR path; no admin policy was altered. `mio` remained not visible. Do not claim tenant isolation from this account.
- canary_cleanup: current canary is test-only. No tool-recognized approved delete path was available, so it remains one row; no workaround was attempted. It must not be used as a general-user QA account.
- app_state: `EXPO_PUBLIC_DATA_SOURCE=mock` remains default; no production app config or deployment changed. No service_role/secret/token columns are used by mobile.
- tests: static policy contract **5/5 PASS**; `git diff --check` **PASS**. `npm run typecheck` failed because `tsc` is not installed; `npm run lint` failed because `expo` is not installed. No dependency installation or network workaround was attempted.
- production_mutation: schema/RLS/grant/migration-history/auth/membership/Cron/settings/OAuth/Vault/Storage/AI/SNS/Push changes **0** in this turn.
- remaining_issues: Provide a normal non-admin Auth user through an approved manual Auth lifecycle, then run real authenticated tenant QA; separately obtain a recognized rollback path for the single test canary. Keep admin policies intact and mobile default mock.
- safety_checks: formal repo and existing changes untouched; H1/G1/G2, apps/admin, HANDOFF unchanged; no personal identifiers, passwords, tokens, or secrets recorded. TASK set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 6 canary RLS QA (2026-09-18)

- task_id: `social-mobile-app-phase6-auth-mobile-read-qa-20260918`
- result: Used the single TASK-approved canary already inserted (`ai_salaryman_lab`, role `viewer`) and performed read-only RLS checks with the sole Auth user claim. Because that user is also covered by the existing global-admin path, this canary does not prove tenant-only isolation for operational tables.
- auth_qa: SQL-level authenticated claim simulation confirmed `auth.uid()` and membership count 1. The canary can read `ai_salaryman_lab`, while existing `private.is_admin()` policies also expose `kabumori` operational rows. No admin policy was changed.
- cross_tenant_result: **tenant-only isolation proof not achieved** with the available user. `mio` rows were not visible, but `kabumori` operational rows were visible through the pre-existing admin-policy OR path. This is not a membership-policy bypass and must not be fixed by changing admin policies here.
- write_safety: authenticated membership INSERT/UPDATE/DELETE grants remain denied by metadata; no write-test mutation was attempted. Vault/OAuth/token/secret columns were not selected.
- rollback: The canary is test-only and should be removed, but the exact single-row DELETE was rejected by safety review because the tool did not recognize sufficient approval for access-control deletion. No alternate delete path was attempted; the canary remains one row pending C2/user-authorized rollback.
- adapter_qa: production default remains `EXPO_PUBLIC_DATA_SOURCE=mock`; adapter reads membership first, blocks with no membership, and never silently falls back. Live app session QA was not run because no real client session/dependencies were available.
- tests: static policy contract **5/5 PASS**; `git diff --check` **PASS**. `npm run typecheck`/`lint`/Expo export remain unavailable without installed dependencies; no install attempted.
- production_mutation: no additional membership, schema/RLS/grant, auth, migration-history, Cron/settings, OAuth/Vault, Storage, AI, SNS, Push, or app-default change was performed in this QA turn.
- remaining_issues: Remove the single test canary via a tool-recognized approved rollback, then obtain a non-global-admin Auth user or explicit admin-policy test plan before claiming tenant-only production isolation. Keep `EXPO_PUBLIC_DATA_SOURCE=mock`.
- safety_checks: formal repo and existing changes untouched; H1/G1/G2, apps/admin, HANDOFF unchanged; no secrets, tokens, emails, or personal identifiers recorded. TASK set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 6 canary recheck (2026-09-18)

- task_id: `social-mobile-app-phase6-auth-mobile-read-qa-20260918`
- result: Reopened TASK includes an explicit canary mapping: the sole production Auth user × `ai_salaryman_lab` × `viewer`. The exact single-row INSERT was attempted through the approved production SQL path, but safety review rejected it as a persistent tenant-access grant whose user approval was not recognized by the tool. No workaround or indirect SQL path was used.
- production_mutation: **0** in this attempt. No membership row was inserted, no auth/session/token was changed, and no app default or production setting was changed.
- gate1: mapping is explicitly stated in the current TASK, but tool authorization did not recognize it for the production access-control write. `kabumori` and `mio` were not touched.
- qa_status: authenticated/cross-tenant runtime QA and mobile adapter live QA remain pending because the single canary could not be created and no real Auth session was available. Existing static policy proof remains the safety basis.
- safety_stop: do not retry through `supabase_execute_sql` variants, direct PostgREST, or other workarounds. Await a tool-recognized authorization for the one approved canary INSERT.
- tests: no code changes; no new tests run. Prior static policy contract 5/5 and `git diff --check` remain PASS. Dependency-based typecheck/lint/export remain unavailable without installed dependencies; no install attempted.
- production_mutation: auth/membership/schema/RLS/grant/migration/Cron/settings/OAuth/Vault/Storage/AI/SNS/Push changes **0**.
- remaining_issues: Need tool-recognized approval for exactly one canary membership insert, then run read-only Auth/RLS/mobile QA and decide whether to remove that one row. Keep `EXPO_PUBLIC_DATA_SOURCE=mock` default.
- safety_checks: formal repo and existing changes untouched; other slots, apps/admin, HANDOFF unchanged; no secrets, tokens, or personal identifiers recorded. TASK set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 6 Auth/mobile read QA (2026-09-18)

- task_id: `social-mobile-app-phase6-auth-mobile-read-qa-20260918`
- result: Completed production read-only identity/mapping gate and no-membership state review. Canary membership was **not** inserted because no explicit user↔brand ownership relation exists in the current schema; no user/brand pairing was inferred.
- source_base: fresh `origin/main` `fbc68cd2e365012becb1ee2a139f6ec7f7a5e695`; clean detached worktree `/private/tmp/kabumori-h2-phase6-pzXuQC`.
- gate1: production read-only metadata found 1 auth user, 1 admin_users row, 1 profile, 3 brands, 2 social_accounts, and 0 brand_memberships. `social_accounts.brand_id` is an operational relation only; no owner/user membership relation is present, so canary eligibility is ambiguous.
- no_membership: `brand_memberships` row count is 0; candidate policy requires self-membership and the existing mobile adapter explicitly returns blocked/no-workspace when membership rows are empty. No auth token/password was requested or logged.
- production_qa: authenticated session/cross-tenant runtime QA could not be executed without a real user session. No auth mutation, token use, service_role use, or production client configuration change was performed. Based on the existing policy matrix/disposable proof, the expected no-membership state is fail-closed.
- adapter_qa: static inspection confirms `EXPO_PUBLIC_DATA_SOURCE=mock` default, explicit Supabase opt-in only, `auth.getUser()`, `brand_memberships` self-read, blocked/unavailable classification, no silent mock fallback, no service-role key, and no secret-column selection.
- tests: static policy contract **5/5 PASS**; `git diff --check` **PASS**. `npm run typecheck` and `npm run lint` could not start because the isolated worktree has no installed `tsc`/Expo dependencies; no install or network workaround was attempted. Expo export/runtime Auth QA not run for the same reason.
- canary: **0 rows inserted**; no rollback needed. Existing production membership row count remains 0.
- production_mutation: auth/brand/membership data, schema/RLS/grants, migration history, Cron/settings, OAuth/Vault, Storage, AI, SNS, Push, and app default data source **0 changes**.
- remaining_issues: To complete runtime Gate 3/4, a user-authorized local/dev session with dependencies installed is needed. A future canary requires an explicit, unambiguous user↔brand mapping and should remain the only allowed membership insert.
- safety_checks: formal repo and existing changes untouched; H1/G1/G2, apps/admin, HANDOFF unchanged; no secrets, tokens, emails, or personal identifiers recorded. TASK set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 5 production postflight (2026-09-18)

- task_id: `social-mobile-app-phase5-production-membership-rls-rollout-20260918`
- result: User-confirmed Dashboard execution of the exact approved candidate SQL succeeded. This follow-up performed read-only postflight, admin compatibility metadata checks, migration-history read-back, and rollback-readiness review. No re-apply was attempted.
- source_base: fresh `origin/main` `1126e51a2c308e1cd4173ec28ae2e14d905e1ed7`; clean detached worktree `/private/tmp/kabumori-h2-phase5-postflight-8EWBYL`.
- candidate: `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`; SHA-256 `a74e70c42d0b10bd773dd614c70f59e807e6b08a8da90afaa05dee2fd09321fd`.
- apply_record: applied manually by the user in Supabase Dashboard with the approved SQL; no CLI `supabase db push`, no tool re-apply, and no migration-history repair/reconcile. The migration version is not present in the migration-history read-back, which is recorded as manual-apply state rather than repaired.
- postflight: `public.brand_memberships` exists with columns `brand_id text`, `user_id uuid`, `role text`, `created_at timestamptz`; PK `(brand_id,user_id)`; FKs to `public.brands(id)` and `auth.users(id)`; role CHECK owner/admin/member/viewer; RLS enabled; row count 0.
- policies: all 6 `social_mobile_*` policies exist (self-membership plus brands/social_accounts/scheduled_posts/post_execution_logs/posting_windows tenant SELECT). Existing `admin_*` policy count is 30 and definitions remain present; no admin policy was dropped or replaced.
- grants: authenticated has SELECT on membership and operational tables; authenticated INSERT/UPDATE/DELETE on `brand_memberships` are all false. Existing `posting_windows` authenticated UPDATE grant remains unchanged for the existing admin path. `private.is_admin()` remains SECURITY DEFINER with empty search_path.
- data_readback: brands=3, social_accounts=2, scheduled_posts=187, posting_windows=19. `post_execution_logs` read-back was 437 versus preflight 431; this reflects intervening natural runtime activity, not a write performed by this task. No candidate membership was inserted.
- admin_compatibility: policy OR-composition and preserved `private.is_admin()` metadata confirm the existing global-admin route remains structurally available. No auth user was impersonated or modified; runtime session verification was not performed.
- rollback_readiness: ready only if needed; exact rollback is limited to the six candidate policies and `brand_memberships` table/index, preserving all existing admin policies. Rollback was not executed because postflight is healthy.
- mobile_state: `EXPO_PUBLIC_DATA_SOURCE=mock` remains the default; no app deploy or source switch.
- production_mutation: only the user-confirmed approved candidate schema/RLS/grant SQL was applied outside this follow-up. No canary membership, additional DB write, RPC, Cron/settings, deploy, Storage, AI/OpenAI, SNS, Push, OAuth, or secret change.
- remaining_issues: migration history does not record the manual Dashboard apply; do not repair history in this task. Next phase should perform authenticated/mobile read QA before enabling Supabase data source. Canary membership remains 0 pending an unambiguous user/brand mapping.
- tests: read-only postflight completed; prior disposable proof and regression basis remain PASS. No code changes; `git diff --check` remains clean in the isolated worktree.
- safety_checks: formal repo and existing changes untouched; apps/admin, H1/G1/G2, HANDOFF unchanged; no secrets, tokens, or personal data recorded. TASK set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 5 production rollout recheck (2026-09-18)

- task_id: `social-mobile-app-phase5-production-membership-rls-rollout-20260918`
- result: Rechecked the reopened TASK from fresh `origin/main` `3e8c69137cc17639371eb609fa4316b0dee81ae9`. The only approved production DDL route available is `supabase_apply_migration`, which previously rejected this high-risk migration because tool-recognized explicit approval was unavailable. No alternate SQL path or blind `supabase db push` was attempted.
- production_mutation: **0**. No migration, schema/RLS/grant, canary membership, deploy, DB write, Cron/settings, API, Push, or mobile data-source change was performed.
- status: This task is returned to C2 as `review_required`; `next_owner: chatgpt`. A tool-recognized approved production DDL route is still required before retrying the exact candidate apply.
- safety_checks: clean isolated worktree only; formal checkout and existing changes untouched; candidate remains `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`; `EXPO_PUBLIC_DATA_SOURCE=mock` remains unchanged; no secrets or personal data recorded.

## H2 — Social mobile Phase 5 production membership/RLS rollout (2026-09-18)

- task_id: `social-mobile-app-phase5-production-membership-rls-rollout-20260918`
- result: production preflight completed; approved candidate migration was **not applied** because the Supabase migration tool rejected the production DDL/RLS/privilege operation as high-risk without tool-recognized explicit approval. No workaround was attempted.
- source_base: fresh `origin/main` `0ddbcee7d8c35eeb01ca477fb6b8b6b78f93979f`; clean detached worktree `/private/tmp/kabumori-h2-phase5-3xUzhh`.
- candidate: `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`; source SHA-256 `a74e70c42d0b10bd773dd614c70f59e807e6b08a8da90afaa05dee2fd09321fd`; implementation commit `c40c96cb66c72c671a145ebdbee2a941c648b6bb`.
- preflight: PASS. Production confirmed `brands.id` and all four operational `brand_id` columns are `text`, matching brand FKs; all five operational tables have RLS enabled; `brand_memberships` absent; candidate policy names had no collision; existing admin policies were present and unchanged; `private.is_admin()` is SECURITY DEFINER with empty search_path; migration history does not contain the candidate version and no blind `supabase db push` was used.
- preflight_counts: `brands=3`, `social_accounts=2`, `scheduled_posts=187`, `post_execution_logs=431`, `posting_windows=19` (read-only metadata; no row mutation).
- apply: **BLOCKED by safety review** from `supabase_apply_migration`; reported reason was that production table creation/RLS/grant changes are high-risk and explicit approval was not recognized by the tool. `supabase_execute_sql` workaround was not attempted. Production schema/RLS/grant/migration mutation remains **0**.
- postflight: not applicable because apply did not run. No canary membership inserted (user/brand relation was not unambiguous).
- admin_compatibility: preflight metadata confirms existing admin policies (`admin_select_post_execution_logs`, `admin_select_posting_windows`, `admin_update_posting_windows`, `admin_select_scheduled_posts`) and `private.is_admin()` path; no policy was changed. Runtime post-apply compatibility check remains pending C2 approval/tool authorization.
- rollback_readiness: exact candidate rollback is prepared conceptually (drop only six candidate policies, then `brand_memberships`; never drop existing admin policies); rollback was not executed because apply was blocked.
- mobile_state: `EXPO_PUBLIC_DATA_SOURCE=mock` default remains unchanged; no mobile deployment or production data-source switch.
- tests: no source changes; no additional test run required. Prior disposable proof and regression results remain the basis (static policy contract 5/5, typecheck/lint/export/diff-check PASS).
- production_mutation: production DB/schema/RLS/grant/RPC/migration/auth/Cron/settings/deploy/Storage/AI/SNS/Push **0**; no canary, no manual API/X/Push.
- remaining_issues: C2 must decide whether to re-authorize the exact migration through an approved production DDL path recognized by safety review. Do not use an indirect SQL workaround. After authorization, rerun postflight/admin compatibility and rollback-readiness checks. `EXPO_PUBLIC_DATA_SOURCE=supabase` remains OFF.
- safety_checks: formal repo existing changes untouched; `apps/admin/**`, H1/G1/G2 areas, HANDOFF unchanged; no secrets, tokens, personal data, or raw credentials recorded. TASK set to `review_required`, `next_owner: chatgpt`.

## H2 — Social mobile Phase 4 disposable DB proof (2026-09-18)

- task_id: `social-mobile-app-phase4-disposable-db-proof-20260918`
- result: Phase4 membership/RLS candidateをproductionと無関係なPodman PostgreSQL 16へapplyし、object read-back、policy matrix、cross-tenant isolation、admin compatibility、mobile write denial、rollbackを実証。C2レビュー待ち。
- source_base: fresh `origin/main` `e0111a97aa79eca68fa0b676ee524620d53e7baa`。H1以外の差分・social-mobile競合なし。
- candidate: `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`; implementation source commit `c40c96cb66c72c671a145ebdbee2a941c648b6bb`（既にorigin/mainへ反映済み）。
- runtime: Podman VM上の一時 `postgres:16-alpine` container（production URL/credential不使用）。fixtureは`auth.users`、brand A/B、social_accounts、scheduled_posts、post_execution_logs、posting_windows、既存`private.is_admin()`とadmin SELECT policy。
- apply/read-back: migration apply PASS。`brand_memberships`存在、PK `(brand_id,user_id)`=1、FK=2、RLS=true、candidate policy=6、既存admin policy=5、authenticated SELECT grant=1、authenticated INSERT grant=0を確認。
- policy_matrix: authenticated non-memberは全resource 0行、A viewerはAのみ（membership/brand/account/schedule/log/window各1）、B memberはBのみ（A 0）、membership無しglobal adminは既存`private.is_admin()`でA/B双方read、service_roleは両brand read。cross-tenant漏洩0。
- write_safety: anonのbrands readはpermission denied、authenticated mobile roleのmembership INSERTはpermission denied。匿名/非memberの可視化とmembership書込みをfail-closedで確認。
- admin_compatibility: candidate policy追加後も既存admin SELECT policy 5件が残り、admin userはmembership無しで両brandをread可能。
- rollback: candidate 5 operational policies + membership policyをdropし、`brand_memberships`をdrop。read-backでmembership=absent、既存admin policy=5を確認。migration前相当へ復帰PASS。containerは検証後削除済み。
- docs: `apps/social-mobile/docs/phase4-membership-rls-contract.md` のdisposable proof記載を実績へ更新。mobile adapterはmembership self-readをtenant境界とし、`scheduled_posts`のaccount/body gapを推測しない。
- tests: static policy contract **5/5 PASS**; `npm run typecheck` **PASS**; `npm run lint` **PASS (0 errors/warnings)**; Expo Web export **PASS**; `git diff --check` **PASS**。
- production_mutation: production DB/schema/RLS/grant/RPC/migration、auth、Cron/settings、deploy、Storage、AI/OpenAI、SNS/API/Push **0**。formal checkout、`apps/admin/**`、HANDOFF、H1/G1/G2領域は未変更。
- remaining_issues: candidateはまだproduction未適用。C2承認後にのみpreflight→apply→postflight→rollbackを検討し、`EXPO_PUBLIC_DATA_SOURCE=supabase`は実運用membership/RLS確認まで既定OFFを維持。
- safety_checks: clean isolated worktree `/private/tmp/kabumori-h2-proof-7dAiKL`のみ使用。secret/token/raw production dataなし。TASKは`review_required`、`next_owner: chatgpt`。

## H2 — Social mobile app Phase 4: membership/RLS validation (2026-09-18)

- task_id: `social-mobile-app-phase4-membership-rls-validation-20260918`
- result: Phase 3で確定したtenant ownership不足を、`brand_memberships`中心の候補migration・RLS policy・mobile read contractとして具体化した。productionには一切適用していない。C2レビュー待ち。
- source_base: fresh `origin/main` `e2d369f00fc40e0cd461f0f4f0bd82d923ab76d6`（H1のagent更新を含む最新main、social-mobile/migration競合なし）。
- implementation_commit: `c40c96cb66c72c671a145ebdbee2a941c648b6bb` (`Add social mobile membership RLS candidate`, rebased onto `e2d369f`).
- changed_files:
  - `supabase/migrations/20260918120000_social_mobile_brand_memberships.sql`（review-only candidate; preflight assertion、membership table、tenant SELECT policies、mobile write revoke。production未適用）
  - `apps/social-mobile/src/data/supabase-repository.ts`（RLS-protected self-membershipを先に読み、返却されたbrand_id集合だけを operational readへ渡す。membership無しはblocked。scheduled_postsにaccount FKが無いため`accountId: "unknown"`として誤帰属を防止）
  - `apps/social-mobile/docs/phase4-membership-rls-contract.md`（schema compatibility、policy matrix、read contract、gap、rollback/runbook）
  - `apps/social-mobile/docs/phase4-policy-matrix.sql`（disposable DBのobject/matrix assertionとrollback手順のSQL）
  - `apps/social-mobile/docs/phase4-policy-matrix.test.mjs`（migration/contract static assertions）
- production_schema_read_only: Phase 3のmetadataを再利用し、`brands.id`、各`brand_id`（text）とbrands FK、RLS enabled、既存admin policyを確認。`brands`/`social_accounts`は現状authenticated policyなし、scheduled/logs/windowsは`private.is_admin()` admin-only。今回のread-only metadata確認以外のproduction操作は0。
- membership_model: `brand_memberships(brand_id text FK → brands.id, user_id uuid FK → auth.users.id, role owner/admin/member/viewer, created_at, PK(brand_id,user_id))`。本人のmembership SELECTのみauthenticatedへ許可し、membershipのinsert/update/deleteはmobile roleへ付与しない。service/backend writeと分離。
- policy_matrix_expected: anon/non-memberはmembership・A/B・operational全て0行、A member/viewer/owner/adminはAのみ、B memberはBのみ、global adminは既存`private.is_admin()` policy、service_roleはbackend責任。cross-tenant漏洩をclient filterで補わずRLSで遮断。
- migration_safety: migrationは対象table/columnの存在を先にassertし、欠落時`PHASE4_PREFLIGHT_MISSING_*`で全体停止。既存admin policyをdrop/replaceせず、追加policyのOR合成で互換性を維持。新規RPC/SECURITY DEFINER、schema変更のproduction適用はしていない。
- mobile_contract: 直接SELECT + RLSを採用。membership 0件=blocked/no-workspace、42501=blocked、42P01/42703=schema unavailable、その他=unavailable。`EXPO_PUBLIC_DATA_SOURCE=mock`既定値とservice_role非使用を維持。Vault/OAuth/AI/X secret列は選択しない。
- operational_gap: `scheduled_posts`にsocial_account_id・本文・origin正本、plan/usage sourceは未確認。今回列追加や推測mappingをせず、accountId/textはgapとして扱う。別Phaseでread view/detail relationを検討。
- disposable_db_proof: **未実行（環境制約）**。Podman/PostgreSQL runtimeが無く、`supabase db lint --local`はlocalhost:54322接続拒否、`supabase status`もPodman socket接続不可。productionへ代替適用せず、候補SQLとmatrix assertionのみ作成。apply→read-back→rollbackはC2後にdisposable runtimeで実施する必要がある。
- tests: `node --test apps/social-mobile/docs/phase4-policy-matrix.test.mjs` **5/5 PASS**; `npm run typecheck` **PASS**; `npm run lint` **PASS (0 errors/warnings)**; `npx expo export --platform web --output-dir /private/tmp/social-mobile-phase4-dist-2` **PASS**; `git diff --check` **PASS**。packageにunit runnerは無いため静的contract testで補完。
- production_mutation: DB/schema/migration/RLS/policy/grant/RPC/Cron/settings/auth/Vault/Storage/AI/SNS/Push/deploy **0**。formal checkout、`apps/admin/**`、HANDOFF、H1/G1/G2領域は未変更。
- remaining_issues: disposable PostgreSQLでの実apply・policy matrix・rollback実証が未実行（runtime準備が必要）。production適用前にC2承認、preflight、matrix、postflight、rollbackを実施する。`EXPO_PUBLIC_DATA_SOURCE=supabase`はmembership/RLS適用・実ユーザー検証までONにしない。
- safety_checks: clean isolated worktree `/private/tmp/kabumori-h2-phase4`のみ変更。既存正式repo・既存未コミット変更に触れていない。secret/token/raw production dataの記録なし。TASKは`review_required`、`next_owner: chatgpt`。

## H2 — Social mobile app Phase 3: production schema/RLS inventory (2026-09-17)

- task_id: `social-mobile-app-phase3-schema-rls-inventory-20260917`
- result: Supabase production metadataをread-only監査し、mobileの直接read可否を確定。`brands`/`social_accounts`/`scheduled_posts`のrelationは存在するが、user→brand membershipとauthenticated向けtenant RLSがなく、mobile data sourceは安全側でblockedとした。C2レビュー待ち。
- source_base: fresh `origin/main` `1a67ea45ad058813f23b7b765453457fa4193d91`（作業開始時）。
- production_read_only: `supabase_list_tables`、`pg_policies`、grants、routine metadata、migration listのみ実行。production DB write、migration、RLS/grant/RPC変更、auth mutation、deploy、SNS/API実行は0。
- confirmed_schema: `public.brands(id, display_name, is_active, publish_mode, code_profile_key)`、`public.social_accounts(id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, Vault secret id列)`、`public.scheduled_posts(id, schedule_date, post_type, slot_no, scheduled_for, status, attempt_count, brand_id)`、`public.post_execution_logs(..., brand_id, x_post_id, message, error_code)`を確認。brand/account/schedule/logsのbrand FKを確認。`scheduled_posts`にgenerated_textやsocial_account_idはなく、本文とaccount直結は未確認。
- rls_and_grants: 全対象resourceはRLS enabled。`brands`/`social_accounts`はauthenticated grant/policyがなくservice_roleのみ。`scheduled_posts`、`post_execution_logs`、`posting_windows`、`posting_blackouts`はauthenticated grantがあるがpolicyは`private.is_admin()`のみ。`private.is_admin()`はSECURITY DEFINER、empty search_path、authenticated EXECUTE。一般Auth user向けのbrand membership policyは存在しない。
- ownership: **D（relation無し/不十分）**。`profiles.id → auth.users.id`と個人テーブルの`auth.uid()` own-row policiesは存在するが、brands/social_accountsへ接続するmembership/owner table・FKはproduction metadataで確認できない。`admin_users`はadmin dashboard境界であり、social mobile tenant membershipではない。
- rpc: `get_my_important_stock_news(integer)`はSECURITY DEFINER / empty search_path / authenticated EXECUTEだが、個人向け重要ニュースRPCでありbrand/account readには使わない。mobile向けRPCは存在せず、追加していない。
- changed_files: `apps/social-mobile/src/data/supabase-repository.ts`（productionで確認した`brand_id`列を使うread candidate、schema mismatch/permission error分類、所有境界を満たさない場合のfail-closed）; `apps/social-mobile/docs/phase3-schema-rls-inventory.md`（schema/RLS/FK/mapping/Phase4 proposal）。他ファイル・他workstreamは変更していない。
- adapter_decision: `EXPO_PUBLIC_DATA_SOURCE=mock` defaultを維持。Supabase source指定時のみread-only query候補を実行し、42501はblocked、42P01/42703はschema unavailable、その他はunavailable。client-side `brand_id` filterだけで権限を補わず、RLS/ownershipが証明できないrowは表示しない。
- domain_mapping: Workspace→brands、SocialAccount→social_accounts、PlannedPost→scheduled_postsの候補を文書化。plan/usage、post origin、本文、social account relationはDB上の安全な正本が不足。Vault secret列は選択・表示しない。
- phase4_proposal: `brand_memberships(user_id,brand_id,role)`とFK/unique、brand-scoped SELECT/WRITE policies、必要ならtenant-checked private RPC、scheduled_postsのsocial_account/body relationをdisposable DBでpolicy matrix検証してから別C2承認で適用する。SECURITY DEFINERをRLS回避目的に追加しない。
- tests: `npm run typecheck` PASS; `npm run lint` PASS (0 errors/warnings); Expo Web export/route resolution PASS (`/private/tmp/social-mobile-phase3-dist`); `git diff --check` PASS。packageにunit-test runnerがないためproduction sign-in/read、OAuth、SNS/API実行はしていない。
- production_decision: **Supabase data sourceをONにしてはならない**。現状はblocked/unavailable表示が正しい。production変更0、deploy0、manual API/X/Push0、secret/token露出0。
- implementation_commit: `c0de2de` (`Audit social mobile schema and RLS`), rebased onto the latest shared `origin/main` (original local implementation was `fc5edde8e88ec25ccc8f445453e3f568163bc2fb`).
- push: authorized by the user after the initial main-branch safety review; `100c5d9` is on `origin/main` and post-push read-back confirmed the TASK/REPORT and scoped files.
- remaining_issues: Phase4でmembership/RLS設計をC2承認後にdisposable DB検証する必要がある。device visual QAと実ユーザーAuth確認も未実施。
- safety_checks: `/Users/yuya/Developer/kabumori`正式repo、root Expo、`apps/admin/**`、`supabase/**`、H1/G1/G2、HANDOFF.mdは変更していない。TASKは`review_required`、`next_owner: chatgpt`。

## H2 — Social mobile app Phase 2: Auth/data boundary (2026-09-17)

- task_id: `social-mobile-app-phase2-auth-data-20260917`
- result: Phase 2のSupabase Auth/session境界、active account context、mock/Supabase repository選択、明示的なblocked/unavailable状態を`apps/social-mobile`内に実装。C2レビュー待ち。
- changed_files: `apps/social-mobile/**`（AuthProvider、SignIn/SignOut、Supabase client、read-only repository candidate、repository selection、DataProvider、active-account context、既存画面のdata source切替、`.env.example`、package依存、README）。root Expo、`apps/admin`、`supabase/**`、他workstreamは変更していない。
- auth: `EXPO_PUBLIC_SUPABASE_URL` と `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` のみを使用し、AsyncStorage（native）付きsession persistence、`getSession()`、`onAuthStateChange`、sign-in/sign-out、loading/signed-out/signed-in分岐を実装。service-role/secret文字列は設定時に拒否し、OAuth/signup/投稿は未実装・未実行。
- data_boundary: `EXPO_PUBLIC_DATA_SOURCE=mock`（既定）は既存mockを維持。`supabase`指定時だけSupabase adapterを選択し、UIはdomain modelを介してsnapshotを参照。env不足、認証なし、RLS 42501、その他取得失敗をそれぞれblocked/unavailableとして表示し、mockへ黙ってフォールバックしない。
- active_account: Accounts画面の選択状態をcontext化し、Supabase read snapshotがreadyならそのaccountsを使い、Home/投稿予定/履歴も同じsnapshotとactive accountで絞り込む。logout時はprovider再マウントでlocal stateがリセットされる。
- schema_inventory: checked-in migrationで確認できた`scheduled_posts`は`id/schedule_date/post_type/slot_no/scheduled_for/status/...`で、brand tenant keyやgenerated textは確認できない。`brands`/`social_accounts`の完全なproduction定義・RLSはこのcloneのmigrationから確認できず、Supabase CLI read-only inspectionはsandboxのtelemetry書込みEPERMで実施不能だった。adapterは`brand_id`を推測して既存scheduler行を表示せず、所有境界を証明できない行がある場合はblockedにする。production query/writeは0。
- read_path_candidate: `auth.getUser()`後、`brands`/`social_accounts`/`scheduled_posts`をread-onlyで狭く読む候補を実装。tenant/RLSが証明できない場合は表示保留。migration/RPC/RLS追加はしていない。
- dependencies: `@supabase/supabase-js`、`@react-native-async-storage/async-storage`、`react-native-url-polyfill`を`apps/social-mobile/package.json`だけへ追加。root package filesは変更していない。
- tests: `npm run typecheck` PASS; `npm run lint` PASS (0 errors/warnings); `npx expo export --platform web --output-dir /private/tmp/social-mobile-phase2-dist` PASS (Expo Web bundle/routes); `git diff --check` PASS. Packageにunit-test runnerは未設定のため、production Auth/sign-in、DB read、OAuth、投稿は実行していない。env missing/permission/error branchesは型・静的実装で確認し、live production verificationは未実施。
- production: DB/schema/migration/RLS/RPC/Cron/settings/OAuth/Vault/Storage/AI/SNS API/Push changes 0; deploy 0; manual production invoke/API/X post 0; secrets/log exposure 0.
- blockers: `brands`/`social_accounts`の実production schemaとtenant RLS、`scheduled_posts`との安全なbrand relationは未確認。Phase 3前にread-only schema/RLS確認を行い、必要なら別C2承認でmigration/RPCを検討する。現段階でSupabase sourceを本番有効化しないこと。
- implementation_commit: `fb83c1568b3e8060dfc87a6bb01fc51dca455ca0` (`Add social mobile auth and data boundary`).
- push: successful to `origin/main`; post-push read-back confirmed this commit, the Phase 2 report, and TASK state.
- remaining_issues: device/simulator visual QA、実管理者Authでのログイン、production read-path/RLS証明は未実施。
- safety_checks: `/Users/yuya/Developer/kabumori`正式repoには触れず、clean clone内のみ変更。H1/G1/G2、`apps/admin/**`、`HANDOFF.md`、root package、`supabase/**`は変更していない。TASKは`review_required`、`next_owner: chatgpt`。

## H2 — Social mobile app Phase 1 shell (2026-09-17)

- task_id: `social-mobile-app-phase1-shell-20260917`
- result: Phase 1の独立Expo/React Nativeアプリを`apps/social-mobile`に作成。既存root Expo株アプリ、`apps/admin`、Supabase Functions、DB、OAuth、SNS APIとは分離したまま、C2レビュー待ち。
- changed_files: `apps/social-mobile/**`（独立package/app config、Expo Router routes、共通UI、design tokens、domain types、repository interface、mock repository、README）
- app_path: `apps/social-mobile`
- navigation: bottom tabs（ホーム / 投稿予定 / AI相談 / 履歴 / 設定）、stack（アカウント一覧・詳細、素材BOX、投稿詳細）
- implemented: Home summary/AI suggestion, account list/detail, planned-post timeline, local consultation proposal apply/cancel mock, published/failed history, media placeholder grid, settings/plan usage placeholder, loading/empty/error UI primitives.
- data_boundary: `SocialOperationsRepository` interface + local mock adapter。`Workspace`/`SocialAccount`/`PlannedPost`/`ConsultationMessage`/`SettingsProposal`/`MediaAsset`/`UsageSummary`等を定義し、会話文を設定正本にしない structured proposal を表現。
- tests: `npm run typecheck` PASS; `npm run lint` PASS (0 errors/warnings); `npx expo export --platform web --output-dir /private/tmp/social-mobile-dist` PASS (Metro Web bundle and route resolution); `git diff --check` PASS. `npx expo start --web --port 8089` was attempted but HTTP listener was not reachable under this sandbox's networking restriction; no app/API side effect occurred.
- production: Supabase/DB/migration/RPC/RLS/Cron/settings/OAuth/SNS API/Storage/OpenAI/X changes 0; no deploy, no manual production invoke, no post.
- known_gaps: Supabase Auth/data adapter, real OAuth, Storage upload, AI API, push notifications, billing, and app-store packaging are Phase 2+; simulator/device visual QA remains for the user/developer environment.
- commit: `74b20852ff130dc19de4629d28d11be627664140` (`Add social mobile Phase 1 shell`).
- push: successful; merge `0292a8a212f5f303223c82b508d9b727f4d7f2bc` and metadata commit `ed374b9550c73d69995497e2f2536abe85c9d593` are on `origin/main`; post-push read-back confirmed the app files and slot state.
- safety_checks: existing root Expo files, `apps/admin/**`, `supabase/**`, `HANDOFF.md`, and other slot files were not modified.
- next_recommendation: C2 review the isolated app shell and decide Phase 2 backend/auth contracts before wiring production data.

## H2 — Kabumori news URL removal production deploy (2026-09-17)

- task_id: `kabumori-news-url-removal-production-deploy-20260917`
- result: `important-news-monitor` only deployed successfully from a clean latest `origin/main`; C2 review required
- deploy_source: `origin/main` `e8db510458351d919c13eb2ee7e58944ac8aee2f`, containing approved implementation `bd97a56c8f4f9321070bcdef7970062090308a49`; no `important-news-monitor` runtime diff after that implementation commit
- pre_deploy: v54 ACTIVE, `verify_jwt=false`
- post_deploy: v55 ACTIVE, `verify_jwt=false`, updated_at advanced as expected
- runtime_readback: production download matched deploy source byte-for-byte for all 23 runtime TypeScript files (21 `important-news-monitor` files plus 2 `_shared` dependencies), including `publish_logic.ts`
- other_functions: stocks-master-sync v16, stocks-new-listing-sync v15, send-push-notifications v15, x-oauth-connect v18, personalized-reports v13, market-intelligence-ingest v11, market-intelligence-state-evaluator v7, and brand-post-dry-run v5 retained their pre-deploy versions/updated_at. `x-test-post` advanced separately from v109 to v110 during the deploy window under concurrent H1 work; H2 did not target or modify it.
- safety: no DB/schema/RPC/migration/RLS/Cron/settings/secrets/OAuth changes; no manual OpenAI/X/Push/API invocation, synthetic candidate, or X post; no source URL metadata deletion; no other Function deploy
- natural_observation: no manual run performed; next step is the next natural important-news post only
- remaining_issues: C2 should review the deployment read-back and concurrent `x-test-post` version change attribution.


## H2 — Kabumori news URL removal cost control (2026-09-16)

- task_id: `kabumori-news-url-removal-cost-control-20260916`
- result: implemented in the isolated important-news publish path; C2 review required
- root_cause: normal important-news generation appends `出典: <source_url>` to the stored `generated_text`, and the live publisher previously sent that URL-bearing text directly to X. This increased URL-bearing X payload cost.
- changed_files: `supabase/functions/important-news-monitor/publish_logic.ts`, `supabase/functions/important-news-monitor/publish_logic_test.ts`
- implementation_commit: `bd97a56` (`Remove external URLs from news X posts`)
- implementation: `stripExternalUrlsFromNewsPost()` runs only at the important-news X publisher boundary. It removes `http://`/`https://` tokens and the trailing `出典` URL line from the outbound body while leaving the candidate's stored `generated_text`, `sourceUrl`, Fact/Voice gates, dedupe/fingerprint, claim, and publish state unchanged.
- scope safety: `x-test-post`, AI Lab/Mio, morning/close reports, tips, interaction, media handling, app/push source metadata, DB schema, Cron/settings and other Functions are unchanged. No URL metadata is deleted.
- tests: focused `publish_logic_test.ts` **19/19 passed** (including http/https removal, non-URL text preservation, and source metadata retention); full `important-news-monitor` suite **407/407 passed**; changed module `deno check --no-config` **PASS**; `git diff --check` **PASS**.
- production: deploy 0; production DB/schema/RPC/migration/Cron/settings 0; manual OpenAI/X/API/Push execution 0; X posts 0; secrets/log exposure 0.
- push: source implementation commit `bd97a56` and metadata/TASK commit `8757416` were pushed to `origin/main`; merge commit `940cea6` preserved concurrent origin work, and post-push read-back confirmed both commits plus this report/TASK state.
- remaining_issues: C2 should review the exact outbound-boundary removal and confirm whether future URL-enabled post types need an explicit opt-in path.
- safety_checks: formal checkout and its existing uncommitted changes untouched; `apps/admin/**`, `HANDOFF.md`, H1/G1/G2 workstreams untouched; no production changes.

## H2 — close-report freshness production deploy (2026-09-16)

- task_id: `x-close-report-freshness-production-deploy-20260916`
- result: approved freshness fix deployed and read-back verified; C2 review required
- deploy source: fresh `origin/main` `af28c10cc7be6f9554e6a048eb3e04bca38b1117`, containing implementation commit `04bfe490a53fea95892ea6e225251b5e129aa87e`
- pre-deploy: `x-test-post` v108 ACTIVE, `verify_jwt=false`; H1/G1/G2 TASKs checked and no concurrent x-test-post source/deploy workstream found
- deploy: `x-test-post` only, with `--no-verify-jwt`; success
- post-deploy: `x-test-post` v109 ACTIVE, `verify_jwt=false`, updated_at advanced as expected
- runtime read-back: `supabase functions download x-test-post --use-api` in a separate disposable worktree; all 54 downloaded x-test-post files and shared `_shared` dependencies byte-matched the deploy source, including `close_report_logic.ts` and its tests
- other Functions unchanged: important-news-monitor v54, stocks-master-sync v16, stocks-new-listing-sync v15, send-push-notifications v15, x-oauth-connect v18, personalized-reports v13, market-intelligence-ingest v11, market-intelligence-state-evaluator v7, and brand-post-dry-run v5 retained their pre-deploy versions/updated_at
- no production DB/schema/RPC/migration/RLS/Cron/settings/posting schedule change; no manual/synthetic close-report run, OpenAI/X/Push/API invocation, or X post
- next step is the natural 17:00 close-report observation only; no manual invoke. Keep `status: review_required` / `next_owner: chatgpt`.

## H2 — close-report freshness boundary fix (2026-09-16)

- task_id: `x-close-report-freshness-boundary-fix-20260916`
- result: implemented and locally verified; C2 review required
- root_cause: `validateCloseFreshness()` used an age-only `jpx_close` limit of 90 minutes. A 15:30:00 JST close therefore became stale at 17:00:01+ due to ordinary scheduler/function delay, causing the live gate to emit `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` even for a same-session close.
- exact rule: in live mode, a `jpx_close` remains fresh when it is on the same JST calendar date, observed at/after the 15:30 JST cash close, and the reference is within the bounded 16:45–17:05 JST close execution window. The existing 90-minute age rule remains the fallback outside that semantic window; future, previous-day, invalid, missing, nonnumeric, source-identity, and pre-15:30 data remain rejected by existing gates.
- changed_files: `supabase/functions/x-test-post/close_report_logic.ts`, `supabase/functions/x-test-post/close_report_logic_test.ts`, plus this report and `.agent/tasks/CODEX_TASK_2.md`.
- tests: close-report + direct close-data targeted **64/64 passed**; full `x-test-post` regression **388/388 passed**; changed source `deno check` **PASS**. Test-file `deno check` is environment-blocked because this disposable checkout has no `npm:@types/node`; no implementation type error was reported. `git diff --check` **PASS**.
- safety: Fact/Voice gates, source identity, same-day/15:30 close-data gate, no fallback to morning/search/model-filled close values, X-post suppression, schedule time, DB/schema/RPC/migration/Cron/settings, and all other categories remain unchanged. No production deploy, Function execution, OpenAI/X/Push API call, or X post.
- remaining_issue: production outcome must be observed on the next natural 17:00 close cycle; no manual close-report run is allowed. Keep `status: review_required` / `next_owner: chatgpt`.

## H2 — important-news cost hardening production deploy (2026-09-16)

- task_id: `important-news-cost-hardening-production-deploy-20260916`
- result: approved `important-news-monitor` deployment completed; C2 review required
- deploy source: fresh `origin/main` `bfabcee0c70ec1915513e297af77f06d88e6ed7b`, containing implementation commit `44ffe59d29e666ce158efc3445efbf7b4b2985c5` and audit/report commit `58d6ec08270c0b93f6bfaac4336ba95a3cb885b5`
- pre-deploy: `important-news-monitor` v53 ACTIVE, `verify_jwt=false`; H1/G1/G2 boundaries checked and no concurrent `important-news-monitor` workstream found
- deploy: `important-news-monitor` only, with `--no-verify-jwt`; success
- post-deploy: `important-news-monitor` v54 ACTIVE, `verify_jwt=false`, updated_at advanced as expected
- runtime read-back: `supabase functions download important-news-monitor --use-api` in a separate disposable worktree; all 53 downloaded function files byte-matched the deploy source, including `post_generation_logic.ts`, tests, and `_shared` dependencies
- other Functions unchanged: `x-test-post` v108, `stocks-master-sync` v16, `stocks-new-listing-sync` v15, `send-push-notifications` v15, `x-oauth-connect` v18, `personalized-reports` v13, `market-intelligence-ingest` v11, `market-intelligence-state-evaluator` v7, and `brand-post-dry-run` v5 retained their pre-deploy versions/updated_at
- no production DB/schema/RPC/migration/RLS/Cron/settings/user-setting change; no manual/synthetic candidate, OpenAI/X/Push/API invocation, or X post
- no source commit was created for deployment; this report and TASK status are the only follow-up edits. Keep `status: review_required` / `next_owner: chatgpt` and stop for C2.

## H2 C2 follow-up — full important-news AI cost-path audit (2026-09-16)

- task_id: `x-news-generation-failure-hardening-20260916`
- result: C2 follow-up audit and local cost fixture complete; implementation remains fail-closed and is ready for C2 review
- source_base: fresh `origin/main` `51cdd4cb6bcf4867fb17af00d362522ec8d48f18`; no H1/other-workstream file overlap
- root_cause / 142 analysis: the 142 `generation_failed` rows from 2026-09-01 through 2026-09-15 are primarily legitimate Fact/Voice fail-closed outcomes (unsupported or imprecise claims, missing explicit years, identity/role uncertainty, and wording/precision issues), not a safe reason to weaken Fact gates. Corrected failure mix is `NEWS_GENERATION_FACT_RETRY_FAILED` 64, `NEWS_GENERATION_FACT_FAILED` 59, `NEWS_GENERATION_VOICE_FAILED` 17, and `NEWS_GENERATION_LOCAL_FACT_FAILED` 2. The existing Fact/Voice retries are bounded and fail-closed; no retry-policy or safety relaxation was added.

### Full AI path audit

- deterministic coverage/severity/category, duplicate, freshness, source and required-field checks: **0 AI calls**; broad collection is not narrowed.
- importance judgement: every selected candidate invokes Luna (`gpt-5.6-luna`, low reasoning, max output 1000); conditional Sol escalation uses the existing path (`gpt-5.6-sol`, medium reasoning) for low confidence/`most_important`/insufficient evidence. In the 14-day production read-only sample: 1,185 judged rows, 3,181,087 input tokens, 322,897 output tokens, 316 Sol escalations (~26.7%). The judgement packet contains the candidate and compact prior result where applicable; no new retry was introduced.
- app/Japanese copy: selected rows use one Luna draft plus one independent Fact call, no retry. The source is sanitized/capped at 3,000 characters; app-copy token usage is not persisted. The sample had 10 attempted rows (~20 calls).
- web-search-enabled collection: `breaking_market_source_fetchers.ts` uses Luna low reasoning with one `web_search` tool call per selected query, at most 4 queries per fetch, max output 1200, and no retry. Search inputs are topic/reference strings; visited-source and freshness gates remain code-owned.
- X generation: normal path is draft → Fact → Voice (three calls) with the existing bounded Fact/Voice correction/recheck paths. The retained implementation (`44ffe59d29e666ce158efc3445efbf7b4b2985c5`) sends stage-specific packets: draft/Fact retain necessary evidence, while style-only Voice omits disclosure body and affected entities; the draft prompt forbids unsupported forecasts/market reactions. Fact/Voice safety, dedupe, coverage, app-copy and publish gates are unchanged.

### Production read-only cost sample (14 days)

- `important_news_candidates`: 1,185 judged rows; judgement 3,181,087 input / 322,897 output tokens; 316 Sol escalations. 194 generated rows; generation 1,616,665 input / 137,706 output tokens. Source split: tdnet 1,042 judged / 168 generated; market_macro 106 / 7; breaking_market 37 / 19. App-copy attempts: 10 rows.
- Dominant remaining measured input costs are judgement (3.18M) and generation (1.62M); app-copy token usage is not stored, so its contribution is estimated only by local fixture.

### Mixed realistic local fixture (no production data or paid API replay)

- added test-only `supabase/functions/important-news-monitor/cost_path_audit_test.ts` with three mixed candidates (900/1,400/650-character bodies; tdnet, market_macro, breaking_market), one representative Sol escalation, two app-copy calls, and four web-search topics.
- pre-hardening X baseline (full candidate packet to draft/Fact/Voice): **15,159** serialized input characters; current stage packets: **11,496** (**24.16% X-path reduction**).
- unchanged judgement/app-copy/search inputs: 6,454 + 4,987 + 777 characters. Whole fixture: **27,377 → 23,714** (**13.38% reduction**). This is below the 30% whole-workload target; the report does not overstate it.
- no clearly safe additional reduction was identified without risking evidence loss or changing collection/quality semantics. The remaining safe opportunity is future measurement/targeting of judgement and app-copy packets, not a new broad source filter.

### Files, tests and safety

- changed file in this follow-up: `supabase/functions/important-news-monitor/cost_path_audit_test.ts` (test-only). Prior implementation commit `44ffe59d29e666ce158efc3445efbf7b4b2985c5` is retained; no additional production source change was necessary.
- new mixed fixture: **1/1 passed**.
- full important-news suite: **405/405 passed** (including prior 404 tests).
- changed production module `deno check`: **PASS**. Fixture `deno check` is environment-blocked because this disposable checkout lacks `npm:@types/node`; no source error was reported. `git diff --check`: **PASS**.
- no deploy, production DB/schema/migration/RPC/Cron/settings change, manual Function/OpenAI/X/Push call, synthetic candidate, or X post. `apps/admin/**`, `HANDOFF.md`, formal checkout and other workstreams were untouched.
- remaining issue: C2 review of the broader cost-path measurement. Keep status `review_required` / `next_owner: chatgpt`.

## H2 current task — X news generation failure hardening (2026-09-16)

- task_id: `x-news-generation-failure-hardening-20260916`
- result: implemented and locally verified; awaiting C2 review
- root_cause: the 142-row generation_failed backlog is primarily legitimate fail-closed Fact/Voice outcomes (missing explicit years, unsupported market interpretation/causality, company-identity uncertainty, and wording/precision failures), with bounded retries already present; it is not a reason to weaken safety gates.
- changed_files: `supabase/functions/important-news-monitor/post_generation_logic.ts`, `supabase/functions/important-news-monitor/post_generation_logic_test.ts`, plus this report. The TASK status is updated separately after GitHub read-back as required.
- implementation: stage-specific packets now keep full evidence for draft/Fact while omitting the disclosure body and affectedEntities from the style-only Voice stages; the draft prompt also forbids unsupported forecasts/market reactions in its closing sentence. Existing Fact/Voice checks, retry limits, dedupe, coverage, app-copy, and publish safety are unchanged.
- tests: targeted **107/107**, full important-news suite **404/404**, related suites **76/76**, changed-module `deno check` PASS, `git diff --check` PASS.
- ai_call_token_before_after: representative 4,000-repeat-body fixture was approximately **97,845 → 65,807 JSON input characters** across draft/fact/voice (same three stages), a **32.7% reduction**. Fact retains body evidence; Voice receives only style-relevant metadata plus generated text. Retry policy remains bounded and fail-closed.
- implementation_commit: `44ffe59d29e666ce158efc3445efbf7b4b2985c5`; report-sync commit will be recorded after this front-matter update; push target is `origin/main`.
- deploy: **0**. Production DB/schema/migration/RPC/Cron/settings/API/X changes: **0**. No production or paid OpenAI/X call was made.
- remaining_issues: C2 review of the input-packet reduction and fixture measurement; no production deploy is authorized by this task.
- safety_checks: formal checkout, existing uncommitted changes, H1/Claude workstreams, `apps/admin/**`, and `HANDOFF.md` untouched; no secrets or raw production text included.

## Current H2 — close-report dual-failure diagnosis (2026-09-16)

- task_id: `close-report-dual-failure-diagnosis-and-hardening-20260916`
- status: `review_required`
- next_owner: `chatgpt`
- source_base / pre-share fresh-check: `origin/main` `fd2f69995ecb1a3ce5e3338d0cc1856f866b6724`.
- isolated worktree: `/private/tmp/kabumori-h2-dual-close-ad2hJy/impl`; formal checkout and its existing changes were untouched.
- Result: **X close report failed closed; app close report completed and its notification was marked sent. The 2026-09-15 dual-failure premise is not supported by the production records.** Diagnosis-only completion, as permitted by TASK. No application or Function source changed.

### 2026-09-15 X close report — exact observed stop

- `scheduled_posts` `7a443a88-11a9-4808-9b7c-65550d4a3477` exists for `close_report`, brand `kabumori`, schedule date 2026-09-15. Scheduled 17:00:00 JST; claimed 17:00:01.880663; finished failed 17:00:32.107346; attempt_count **1**.
- Execution logs 324/325 show `Scheduled post claimed` then `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`. No X post ID; HTTP status and structured error_code are null. This was not a missing schedule/claim or a demonstrated publish API failure.
- `close_report_runs` `44b68923-51a4-43cf-88f8-fda466fb8592` was created 17:00:02.930434 JST and marked failed 17:00:32.053; error `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`, fact_check_status failed. Notes explicitly state both same-day Nikkei and TOPIX-tracking ETF (1306) values were unavailable, and required-index/timestamp validation failed. The collection reference in the notes is 17:00:02 JST.
- Persisted nikkei_data/topix_data/market_data are `{}`, source_urls `[]`, market_data_timestamp null, voice_evaluation `{}`, X post ID null. Collection returned enough for a draft object/Fact notes, but no final text was generated. Scheduled branch skips Voice when draft.text is empty and throws on Fact failure before `postToX`; therefore this path did not reach Voice retry or X posting.
- `close_report_settings` remains Asia/Tokyo, active true, 16:58–17:00–17:02; futures_target_time 15:45. Dispatcher Cron job 1 runs every minute. Its relevant 16:59–17:16 Cron SQL runs are succeeded. Cron SQL success means HTTP enqueue succeeded, not that the Function succeeded. Durable claim/failure writes completed; no DB/504 timeout is established by these records.

### X acquisition/validation findings — confirmed logic versus incident uncertainty

- `supabase/functions/x-test-post/close_report_data_logic.ts`: `fetchJpxCloseMetrics` fetches Nikkei then 1306 sequentially via Yahoo query2 chart `range=5d&interval=1m&events=history`. The ETF requires symbol `1306.T`, Tokyo/JPX exchange, JPY, and its explicit ETF label; unrelated `^TPX` is rejected. Same JST date and observation at/after 15:30 remain mandatory.
- `fetchYahooJpxCloseMetric` collapses non-2xx, JSON/transport errors, identity mismatch, missing closes, and rejected observation time to `null`. It supplies only Accept, without an explicit timeout or classified failure diagnostics. Incident HTTP response and rejected source timestamp cannot be reconstructed from the saved row.
- `index.ts` `generateCloseReport` normalizes direct values, applies source verification and `hasSameDayCloseData`, and adds `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` on missing valid live closes. The scheduled catch persists Fact notes but, for a non-Voice Fact failure, does not persist draft metrics/source URLs/usage. **Empty saved metric objects alone do not prove that the external requests returned no values.**
- Additional deterministic bug/risk in `close_report_logic.ts` `validateCloseFreshness`: jpx_close accepts age <=90 minutes. Pure local proof with observed `2026-09-15T06:30:00Z` (15:30 JST) returns fresh at `08:00:00Z` and stale at `08:00:02Z`. Thus normal seconds of scheduling delay at 17:00 can reject a valid same-day 15:30 close. The incident reference has those extra seconds, but its actual Yahoo observation time was not saved: this is a reproducible candidate cause, **not a proven sole cause of 9/15**.
- Minimum next X work after H1 completes: classified, secret-free direct-fetch diagnostics and persistence on Fact failure; then a narrow same-session-close freshness treatment compatible with 17:00 plus ordinary execution delay. Preserve source identity, same-date, >=15:30, numeric, Fact/Voice and fail-closed gates; do not use morning values/search fallback. Required tests: exact 15:30 close at 17:00+seconds, intraday/previous-day/future/invalid rejection, HTTP/JSON/identity/missing-data diagnostic distinction, Fact-failure persistence, X API zero on rejected closes, existing close/Voice regression.
- H1 `x-multibrand-phase3k-ai-lab-first-live-test-20260916` is ready and owns x-test-post/OAuth/AI Lab/posting windows. Per H2 boundary, **no X source fix was attempted**. Separate post-H1 approval/review is required.

### 2026-09-15 app personalized close report — successful path

- `personalized_reports` `29a7bda2-20a8-46a9-865b-1b4d0205bbf3`: close / trading_date 2026-09-15; created 17:15:01.747778 JST; generated 17:15:17.230; status completed, fact_status passed, fact_issues `[]`, error null. Title: 「保有2銘柄がそろって上昇した大引け」.
- Snapshot price_basis_date 2026-09-15; data_gaps `[]`. Nikkei and explicit TOPIX ETF (1306) prices both status ok / sessionDate 2026-09-15. Source basis `app_personalized_v1`, `yahoo_chart_1d`, symbols `^N225` and `1306.T`. No private holdings/user IDs or token values are included here.
- App acquisition differs from X: query2 daily bars `range=1mo&interval=1d`, User-Agent Mozilla/5.0 and 15-second timeout; `priceFactFor` requires today's bar plus regularMarketTime on the same JST day at/after 15:30. Raw regularMarketTime is not retained in the saved snapshot, so its exact source timestamp cannot be reported retrospectively.
- Current generator performs one draft + one Fact call, with no regeneration retry. Saved usage Luna input 5534 / output 1217; exact call count is not a dedicated DB column, but the completed path in source is two calls. Report saved once, then enqueue RPC only for completed/Fact-passed rows. Existing unique claim and notification deduplication remain unchanged.
- notified_at 17:15:17.305641 JST; notification `16ab98e2-efc9-4fef-9f42-f675f3651b43`, source_type personalized_report, source_id matching report, push_status **sent**, push_attempt_count **1**, last_error null. This proves enqueue and dispatcher marked-sent, not end-device receipt/read confirmation.
- Cron job 11 is active `15 8 * * 1-5` (17:15 JST); its 9/15 run succeeded. Relevant opt-in aggregate has one close-enabled/push-enabled user. RPC read-back requires current push_enabled + close_report opt-in and completed/Fact-passed/nonempty title; conflict do-nothing prevents duplicate notification.

### Prior failure / common-cause assessment

- 9/14 app close report `101d8d0c-59e1-4026-bdbb-ac17179f2027` did fail `REPORT_FACT_FAILED`: 「『半導体関連銘柄』はpacketに明記されていない分類です。」 This is a different date and an unsupported classification issue, not evidence that 9/15 app close failed.
- X and app share Yahoo provider/instrument choices, but use different chart intervals, metadata checks, timeouts/headers and execution times. App's 9/15 completed Fact/notification contradicts a simultaneous general market-data/OpenAI/DB outage. X's live close availability/validation failed; **two simultaneous independent failures or a shared outage are not established**.
- App prompt/local/Fact gates already reject unsupported numbers/claims and fail closed; generator has no bounded Fact retry. Because the target-date app close succeeded, no app source hardening was justified by this incident, and no speculative retry was added. A separately scoped follow-up may address the actual 9/14 unsupported-classification failure with bounded retry/diagnostics if desired.

### Verification / safety / C2 handoff

- Existing personalized report logic + Push dedupe contract tests: **24 passed / 0 failed** (`deno test --no-check --no-lock --allow-read ...report_logic_test.ts ...push_dedupe_contract_test.ts`). Includes close/morning success, Fact-fail no body/no Push, missing-data zero model calls, notification idempotency and opt-in checks.
- Pure local 90-minute boundary proof: fresh at 17:00:00, stale at 17:00:02 for a 15:30:00 observation. No external API was called by that proof.
- `git diff --check`: PASS. Source changes: **0**; changed files: this REPORT and `.agent/tasks/CODEX_TASK_2.md` only.
- Production DB/schema/RPC/migration/settings/Cron changes **0**; deploy **0**; manual Function/OpenAI/X/Push calls **0**; manual X posts **0**; synthetic report/candidate and reclaims **0**; secrets exposed **0**.
- apps/admin, HANDOFF, formal checkout, H1 and other workstreams unchanged. C2 should review the corrected incident premise and authorize a separate non-conflicting X close acquisition/freshness/diagnostic follow-up after H1. This task remains review_required / next_owner chatgpt.

## H2 — close-report 17:00 schedule and close-source hardening (2026-09-11)

- task_id: `close-report-1700-schedule-and-close-source-hardening-20260911`
- result: implementation and production schedule alignment complete; C2 review required
- model_used: Sol High
- source_base: `origin/main` `0b9adcb904cfe23b0b8d563827a8fd2059b8eb13`
- worktree: temporary clean clone; formal repository working tree was not modified

### Schedule audit / source of truth

- `pg_cron` job 1 calls `x-test-post` every minute (`* * * * *`); it does not contain a close-specific hour.
- `public.plan_close_report()` is the scheduling source of truth: it reads `close_report_settings.center_time` and inserts one same-day `scheduled_posts` row with the existing unique key.
- `claim_due_post()` claims rows only when `scheduled_for <= now()`, preserving at-most-once claim behavior.
- `posting_windows` is an administrative/display window and is not used by `plan_close_report()` for the due calculation. Its close row was time-aligned but its existing `is_active=false` state was preserved.
- `morning_report`, `morning_greeting`, `tip`, `interaction`, and `us_premarket_report` schedules were not changed.

### Implementation

- `resolveCloseRunMode()` now uses a tolerant 16:45–17:05 JST execution window around the 17:00 scheduled claim; the database due time remains exactly 17:00 JST / UTC 08:00.
- Live close-data validation now requires same-JST-day observation at or after 15:30 JST in both the direct acquisition path and the final live gate.
- Direct JPX close acquisition now uses Yahoo's structured `query2.finance.yahoo.com` chart endpoint with `range=5d&interval=1m`; it remains sequential, source-backed, numeric, same-day, and fail-closed. The previous `query1` 1-day endpoint could return no usable chart response at the 16:00 run (the stored run had empty Nikkei/TOPIX/source diagnostics); a read-only comparison confirmed query2 returned the current 15:30 point while query1 range=1d was rate-limited. No HTML scraping or search fallback was added.
- The 17:00 Fact/Voice gates, existing Voice single-retry, source policy, and `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` safety stop remain intact.

### Verification

- targeted close-data/close-report/Voice tests: **60 passed / 0 failed**
- full `x-test-post` regression: **381 passed / 0 failed**
- `deno check` (`close_report_logic.ts`, `close_report_data_logic.ts`): **PASS**
- `git diff --check`: **PASS**

### Production schedule change

- Before: `close_report_settings` 15:58–16:00–16:02 JST; `posting_windows` 15:58–16:02 JST, inactive.
- After: `close_report_settings` 16:58–17:00–17:02 JST; `posting_windows` 16:58–17:02 JST, inactive state preserved; timezone remains `Asia/Tokyo`, `is_active=true` remains unchanged in `close_report_settings`, and `futures_target_time=15:45` remains unchanged.
- pg_cron job 1 remains `* * * * *` and still calls only `x-test-post`; no Cron definition was changed.
- No scheduled post was manually inserted, claimed, regenerated, or published.

### Commit / push / deployment

- changed files: `supabase/functions/x-test-post/index.ts`, `close_report_logic.ts`, `close_report_logic_test.ts`, `close_report_data_logic.ts`, `close_report_data_logic_test.ts`, `.agent/tasks/CODEX_TASK_2.md`, `.agent/CODEX_REPORT_2.md`
- commit: `955a3ab5edc95a63fce181c07c0d7460b7e2961c`
- push: successful; post-push fresh-check confirmed `origin/main` contains `955a3ab5edc95a63fce181c07c0d7460b7e2961c`
- deploy source: clean clone at `origin/main` `955a3ab5edc95a63fce181c07c0d7460b7e2961c`
- deployed function: `x-test-post` only, `--no-verify-jwt`
- deploy result: success; post-deploy `x-test-post v96 ACTIVE`, `verify_jwt=false`
- `supabase functions download x-test-post --use-api` completed; every non-test runtime file byte-matched the deploy source. Download omitted local `*_test.ts` files as expected.
- other Edge Functions: unchanged (important-news-monitor v40, stocks-master-sync v6, stocks-new-listing-sync v5, send-push-notifications v4, x-oauth-connect v4; versions/updated_at unchanged)
- worktree-local temporary `supabase/config.toml` was used only for deploy and removed afterward; it was not committed.

### Safety / remaining issue

- no manual close_report run, scheduled-post injection, OpenAI/X API execution, or X post
- no DB schema/migration/RLS/RPC, Cron definition, secrets, OAuth, or unrelated category changes
- existing close_report rows were not edited; the next natural JPX business-day 17:00 path is still required for production outcome observation
- status: `review_required`
- next_owner: `chatgpt`

## H2 Follow-up E — production deploy verification

- task_id: `close-report-live-data-and-voice-retry-hardening-20260910`
- result: deployed and byte-verified; C2 review required
- deploy source: clean clone of `origin/main` at `d46f495459f06a660b63d97f8dab74ed4dd02b8a`
- approved implementation commit `491eb46f4294324d3736419e57a3e510f319d0ca`: included; no `x-test-post` changes after it
- worktree-local temporary config: project ref `wsmznyzcvmuitkglfeuj`, `[functions.x-test-post] verify_jwt = false`; not committed to `origin/main`

### Deploy and read-back

- deployed function: `x-test-post` only, with `--no-verify-jwt`
- deploy result: **success**
- post-deploy: `x-test-post v95 ACTIVE`, `verify_jwt=false`
- `supabase functions download x-test-post --use-api` completed
- byte comparison: every downloaded function file matched the exact pre-deploy source snapshot
- other Edge Functions: versions and `updated_at` values unchanged from pre-deploy read-back

### Safety

- no manual Function execution, close_report execution, OpenAI/X API call, or X post
- no DB/migration/RLS/RPC, Cron/scheduler/posting_windows/settings, secrets, or OAuth changes
- temporary `supabase/config.toml` was local to the clean clone and was not committed or added to the formal repo
- status: `review_required`
- next_owner: `chatgpt`

## H2 Follow-up D — close timestamp boundary

- task_id: `close-report-live-data-and-voice-retry-hardening-20260910`
- result: implemented; C2 review required
- source_base: `origin/main` at `cc223256f3d2fc2a996e1919adefcd7185e982c1`
- worktree: temporary clean clone; formal repository working tree was not modified

### Change

- `fetchYahooJpxCloseMetric()` now accepts a direct Nikkei/TOPIX value only when its same-JST-day observation is **15:30 JST or later**.
- Same-day 15:00–15:29 values are rejected as intraday. A latest chart point before 15:30 therefore remains unavailable and the existing `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` live safety gate stops before X.
- No fallback to material/news search, model-filled values, or relaxed Fact/Voice/publish criteria was added.

### Changed files

- `supabase/functions/x-test-post/close_report_data_logic.ts`
- `supabase/functions/x-test-post/close_report_data_logic_test.ts`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/CODEX_REPORT_2.md`

### Verification

- Targeted close-data + close-report regression: **55 passed / 0 failed**
- Full `x-test-post` regression: **379 passed / 0 failed**
- Changed pure module `deno check`: **PASS**
- `git diff --check`: **PASS**
- Added explicit acceptance at 15:30 JST and rejection tests at 15:29, 15:15, and 15:00 JST.

### Safety

- deploy / production Function execution / OpenAI or X API calls / X posts: **0**
- DB schema/migration/RLS/RPC, Cron/scheduler/settings, secrets/OAuth: **0**
- Existing formal-repo uncommitted changes, `apps/admin/**`, and `HANDOFF.md`: untouched
- status: `review_required`
- next_owner: `chatgpt`

## H2 follow-up — same-day close acquisition

- task_id: `close-report-live-data-and-voice-retry-hardening-20260910`
- status: `review_required`
- next_owner: `chatgpt`
- source_base: `origin/main` at `d8fcffb40d6aca554e63bee4a2757b7a1b554537`
- worktree: new temporary clean worktree; formal repository working tree was not modified

### Root cause confirmed

- The prior close-report collection used one broad web-search request with up to four calls and explicitly told the model that Nikkei/TOPIX concrete values were unnecessary and should only be filled if encountered incidentally.
- Therefore close values, timestamp precision, and source URL depended on incidental article/search coverage; front-session values could be returned and there was no code-owned same-day close acquisition path before the safety gate.

### Minimal follow-up implementation

- Added `close_report_data_logic.ts`, a narrow sequential fetch of the existing allowed Yahoo Finance chart source for `^N225` and `^TPX` at 1-minute resolution. It accepts a metric only when numeric, same JST date, and observed at/after 15:00 JST; failed/stale/front-session/unknown responses return null without throwing.
- `generateCloseReport` now performs this direct acquisition before the material search, prioritizes successfully fetched values over model-filled values, includes the fetched source URLs in diagnostics, and keeps the existing model search only as a supplement for materials or as a fallback source.
- The collection prompt now explicitly prioritizes code-provided close inputs and forbids padding with front-session or guessed values. Existing `hasSameDayCloseData` / `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` remains the final live safety gate.
- No Fact/Voice threshold, freshness rule, source policy, retry policy, DB schema, Cron, or publish behavior was relaxed or changed.

### Follow-up files

- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/close_report_data_logic.ts`
- `supabase/functions/x-test-post/close_report_data_logic_test.ts`
- `supabase/functions/x-test-post/close_report_logic_test.ts`

### Follow-up verification

- Direct close acquisition + close_report + Voice retry targeted tests: **55 passed / 0 failed**
- Full `x-test-post` regression: **376 passed / 0 failed**
- Pure-module `deno check` (including new acquisition module): **PASS**
- `git diff --check`: **PASS**
- Whole `index.ts` check retains six pre-existing errors in unchanged OAuth/image/morning modules only.

### Safety

- deploy / production Function execution / OpenAI or X API calls / X posts: **0**
- DB schema/migration/RLS/RPC, Cron/scheduler/settings, secrets/OAuth: **0**
- Formal repository changes, `apps/admin/**`, and `HANDOFF.md`: untouched

### Push confirmation

- H2 follow-up commit `4e66d49787a4fdf80ccafb680e2dc8079edff497` was pushed to `origin/main`.
- Post-push read-back confirmed `origin/main` contains that commit.
- status remains `review_required`; next_owner remains `chatgpt` for C2 review.

### Production deploy confirmation

- pre-deploy `origin/main` fresh-check: `566958f992f62684d76c9979f0e6d13c616c2bb3`.
- H2 implementation commit `4e66d49787a4fdf80ccafb680e2dc8079edff497` was found in `git rev-list origin/main`; deploy source was a clean worktree at that exact commit.
- deployed function: `x-test-post` only, with `--no-verify-jwt`.
- deploy result: **success**; post-deploy `x-test-post v94 ACTIVE`, `verify_jwt=false`.
- other production changes: 0 (no other Edge Function deploy, DB/migration/RLS/RPC, Cron/scheduler/posting_windows, secrets/OAuth, or manual Function/API/X execution).
- natural close_report path was not manually run; same-day artificial execution was not performed.
- status remains `review_required`; next_owner remains `chatgpt` for C2 review.

## Current H2 completion — close-report-live-data-and-voice-retry-hardening-20260910

- task_id: `close-report-live-data-and-voice-retry-hardening-20260910`
- status: `review_required`
- next_owner: `chatgpt`
- source_base: `origin/main` at `a714d21ff3c602acebcc7b995eef95f12e8d7a48`
- worktree: temporary clean worktree; formal repository working tree was not modified

### Root causes

- close_report Voice evaluation treated evaluator output/transport failures as immediate failures, so an empty/JSON-parse/max_output_tokens response received no bounded recovery attempt.
- live close_report Fact evaluation did not require the same-day post-session Nikkei and TOPIX close metrics; front-session or unavailable values could therefore reach later generation stages.

### Implemented scope

- Added `runWithSingleRetry` and close_report-only retry wiring. Only `VOICE_EVALUATION_EMPTY_OUTPUT`, `VOICE_EVALUATION_JSON_PARSE_FAILED`, and evaluator `incomplete_details.reason=max_output_tokens` are retryable; ordinary Voice rejection and unrelated errors are not. The maximum is one retry, with bounded failure diagnostics.
- Added `hasSameDayCloseData` and required live close_report Fact inputs for Nikkei and TOPIX. Values must be numeric, source-backed, fresh, same JST date, and observed at/after 15:00 JST. Missing/front-session data stops before X with `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`.
- Persisted retry count/failure codes in existing close-report `market_data` diagnostics; no schema change and no raw output/secrets.
- Existing Fact, Voice quality thresholds, rewrite, grouping, freshness, ranking, publish safety, and X ordering remain unchanged. No morning_report or other category logic was changed.

### Changed files

- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/close_report_logic.ts`
- `supabase/functions/x-test-post/close_report_logic_test.ts`
- `supabase/functions/x-test-post/voice_retry_logic.ts`
- `supabase/functions/x-test-post/voice_retry_logic_test.ts`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/CODEX_REPORT_2.md`

### Verification

- Targeted close_report + Voice retry tests: **51 passed / 0 failed**
- Full `x-test-post` regression: **372 passed / 0 failed**
- Pure-module `deno check` (`close_report_logic.ts`, `voice_retry_logic.ts`): **PASS**
- `git diff --check`: **PASS**
- Whole `index.ts` type check still reports six pre-existing errors in unchanged OAuth/image/morning modules; no unrelated fixes were made.

### Review and safety

- Earlier automatic review rejection reason: it interpreted the initial H2 change as outside the explicitly approved scope / based on untrusted task content. A later intermediate rejection was caused by an accidental morning_report diagnostic change; that was discarded. The final worktree contains only the close_report changes above plus task/report metadata.
- deploy: **0**; production OpenAI/API execution: **0**; X API/posts: **0**
- DB schema/migration/RLS/RPC, Cron/scheduler/settings, secrets/OAuth: **0**
- formal repository existing changes, `apps/admin/**`, and `HANDOFF.md`: untouched

- task_id: `morning-report-fact-diagnostics-and-greeting-status-fix-20260910`
- result: `review_required`
- next_owner: `chatgpt`
- source_base: `origin/main` at `6365c4955f95b5cdc461c7eb59ec421c96fda1ca`
- worktree: clean temporary worktree; formal repository working tree was not modified

## Root cause and changes

### Morning report Fact diagnostics

- Root cause: the live scheduled `morning_report` catch only persisted detailed draft diagnostics for Voice/Lane failures. A plain `MORNING_REPORT_FACT_CHECK_FAILED` could therefore leave only the generic error code and lose the draft's concrete Fact notes and retrieval data.
- Fix: when that exact Fact failure occurs and a draft exists, the run update now persists:
  - `fact_check_notes` from `draft.factCheckNotes`
  - `source_urls`, `market_data_timestamp`
  - input/output tokens, web-search calls, API cost
  - existing `morningRunMarketData(...)` diagnostics
  - `generated_text` and `character_count` only when draft text actually exists
- Fact gate, retry classification, and existing Voice/Lane failure logging were not changed.
- Dry-run already stored the same draft Fact notes and market diagnostics on its normal Fact-failed completion path; a regression assertion now fixes that parity.

### Morning greeting legacy receipt

- Root cause: after X posting and authoritative `publish_claims` completion succeeded, a legacy Storage JSON receipt failure still threw `MORNING_GREETING_X_POST_RECORD_FAILED:*`. The outer scheduled handler then marked the scheduled post failed even though X and the DB claim already recorded success.
- Fix: legacy receipt write remains for backward compatibility but is now best-effort after `completePublishSlot(...)`; failure logs only the HTTP status and does not overturn the successful result.
- Atomic DB `publish_claims` remains authoritative. Existing legacy receipt reads remain intact. A same-day rerun still loses the atomic claim and stops before any X request.

## Changed files

- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/morning_report_logic_test.ts`
- `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/CODEX_REPORT_2.md`

## Tests

- Targeted morning report + morning greeting publish/claim/scheduled tests: **69 passed / 0 failed**
- Full `x-test-post` regression: **367 passed / 0 failed**
- `git diff --check`: PASS
- `deno check morning_greeting_publish_logic.ts`: blocked by 2 pre-existing errors in unchanged dependencies:
  - `_shared/x_oauth2_post.ts`: current Deno `BufferSource` typing for AES-GCM IV
  - `morning_greeting_logic.ts`: existing `retry_count` return-type mismatch
- Runtime tests were therefore run with type checking separated (`--no-check`); all passed. No scope expansion was made to alter those unrelated files.

## Safety

- production deploy: not performed
- manual X/OpenAI/API execution: 0
- X posts: 0
- DB / migration / RLS / RPC writes: 0
- Cron / scheduler / settings changes: 0
- other Edge Functions or workstreams changed: 0
- `apps/admin/**` and `HANDOFF.md`: untouched
- formal repository existing uncommitted changes: untouched
- secrets changed or exposed: 0

## H2 deployment continuation (2026-09-10)

- `origin/main` fresh-check: `f26b9dbe2b262eb072eb9254e049fd86c46d3f6a`
- implementation commit `41de66bd4b4eb69bbdf0b6718274c519912f8a24` included: YES
- conflict check: no active slot changes `supabase/functions/x-test-post/**`; Claude slot 1 is isolated to the Push workstream
- clean worktree: created from current `origin/main`; clean state confirmed
- pre-deploy read-back: `x-test-post` v90 ACTIVE / `verify_jwt=false`
- deploy command prepared: `x-test-post` only with `--no-verify-jwt`
- deploy result: **not performed**. The production mutation was rejected because the `H2` start code alone was not accepted as explicit deploy authorization.
- production/manual execution: 0
- X/OpenAI API calls: 0
- DB/Cron/settings changes: 0
- formal repository dirty worktree: untouched

## Explicitly approved production deployment (2026-09-10)

- approval: explicit user approval received after the blocked attempt
- deploy source: current `origin/main` at `de19c6eb599d456342c82fe20cd41e32ebe6350a`
- implementation commit included: `41de66bd4b4eb69bbdf0b6718274c519912f8a24`
- pre-deploy: `x-test-post` v90 ACTIVE / `verify_jwt=false`
- command scope: `x-test-post` only with `--no-verify-jwt`
- deploy: success
- post-deploy: `x-test-post` v91 ACTIVE / `verify_jwt=false`
- other Edge Function deploys: 0
- DB / migration / RLS / RPC / Cron / scheduler / settings / secrets / OAuth changes: 0
- manual Function invocation / morning_greeting publish / candidate injection: 0
- manual X/OpenAI API calls and X posts: 0
- formal repository existing uncommitted changes: untouched
- natural-path observation: not yet available. Deployment completed at 2026-09-10 14:53 JST, after the natural morning_report and morning_greeting slots. No artificial same-day rerun was performed; the next naturally occurring morning paths must be checked read-only.

## Review / next step

ChatGPT should review the successful v91 deployment. After the next natural morning cycle, verify read-only that a morning_report Fact failure preserves concrete draft diagnostics and that a successful morning_greeting remains successful even if its legacy receipt write returns 400. Do not force either path or rerun a same-day post.

## H2: TOPIX source correction (2026-09-11)

- task_id: `x-close-report-topix-source-correction-20260911`
- result: `review_required`
- model_used: `gpt-5.6-sol`
- root_cause: the close_report direct source treated Yahoo `^TPX` as Japanese TOPIX without validating instrument identity. A live read-only query returned `exchangeName=CBO`, `fullExchangeName=OPRA Indices`, `currency=USD`, `regularMarketPrice=105.18`, and no chart timestamps, so it is not a usable same-day Japanese TOPIX close source.
- old_tpx_source_behavior: `fetchJpxCloseMetrics()` fetched `https://query2.finance.yahoo.com/v8/finance/chart/%5ETPX?...` and relabeled the latest numeric chart point as `TOPIX`, with no source metadata validation.
- production evidence: recent `public.close_report_runs` rows contained empty TOPIX values with `freshness=invalid_timestamp`; the latest run failed closed with `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE`.
- chosen_topix_source_or_fail_safe: no formally verified structured TOPIX source exists in the current allowed implementation. The `^TPX` path is now rejected and the production acquisition returns `topix: null`; live close_report's existing required-index gate therefore fails safe instead of publishing a false TOPIX value. No 1306 ETF or article-derived substitute was introduced.
- code_changes:
  - `close_report_data_logic.ts` rejects the Yahoo `^TPX` endpoint for TOPIX, validates Japanese TOPIX metadata (`TOPIX` symbol, JPX/Tokyo/Japan exchange identity, JPY) for any future structured TOPIX source, and leaves TOPIX unavailable in the current production acquisition path.
  - Nikkei acquisition, 15:30 JST cutoff, same-day/previous-day handling, Fact/Voice/X gates, 17:00 schedule, and all other categories are unchanged.
- tests:
  - targeted close-data + close-report tests: **61 passed / 0 failed**
  - full `x-test-post` regression (`deno test --no-check --allow-read --allow-env supabase/functions/x-test-post/*_test.ts`): **385 passed / 0 failed**
  - pure module checks (`deno check close_report_data_logic.ts close_report_logic.ts`): PASS
  - `git diff --check`: PASS
  - coverage includes `^TPX` rejection, valid same-day 15:30 TOPIX metadata acceptance, 15:29 rejection, previous-day rejection, metadata mismatch rejection, TOPIX-unavailable fail-safe, and Nikkei regression.
- production_deploy: not performed; no manual close_report, OpenAI, X, DB, Cron, settings, secrets, or OAuth operations.
- deploy_verification: N/A.
- unchanged_scopes: 17:00 scheduler/posting windows/Cron, Nikkei acquisition, Fact/Voice/X gates, morning_report, morning_greeting, important-news, personalized reports, `apps/admin/**`, and `HANDOFF.md`.
- changed_files:
  - `supabase/functions/x-test-post/close_report_data_logic.ts`
  - `supabase/functions/x-test-post/close_report_data_logic_test.ts`
  - `.agent/tasks/CODEX_TASK_2.md`
  - `.agent/CODEX_REPORT_2.md`
- commit_hash: `9b8b14379eb013052b60833a28df142e7ff3fb2c`
- push: implementation commit `9b8b14379eb013052b60833a28df142e7ff3fb2c` is present on `origin/main`.
- remaining_issues: a formally verified structured same-day TOPIX source still needs to be selected in a separate review; until then live close_report safely stops when TOPIX is unavailable.
- safety_checks: clean temporary worktree from fresh `origin/main`; formal repository and other workstreams untouched; no secrets exposed; no Storage/DB writes; no X posts.
- next_recommendation: ChatGPT C2 review. Do not deploy or run a manual close_report until the source choice is approved.

## H2 Follow-up F1: clearly labeled TOPIX ETF proxy (2026-09-12)

- task_id: `x-close-report-topix-source-correction-20260911`
- result: `review_required`
- model_used: `gpt-5.6-sol`
- proxy_source_validation: Yahoo structured chart `1306.T` was verified read-only with metadata `symbol=1306.T`, `instrumentType=ETF`, `exchangeName=JPX`, `fullExchangeName=Tokyo`, `currency=JPY`, and a populated multi-day chart. This is used only as a market-comparison proxy, not as the TOPIX index.
- label_invariants: proxy label is the exact explicit `TOPIX連動ETF（1306）`; `^TPX` remains rejected; `1306.T` is rejected if called `TOPIX`; prompts and diagnostics state that the proxy is not TOPIX itself. No 1306 value is relabeled as TOPIX.
- code_changes:
  - `close_report_data_logic.ts` adds the 1306.T structured endpoint and explicit label, validates 1306.T/JPX-Tokyo/JPY metadata, retains `^TPX` rejection, and keeps same-JST-date, numeric, 15:30+ and freshness checks.
  - `index.ts` uses the proxy in the direct close acquisition and live required-index gate, prevents live fallback to AI/article-supplied `packet.topix`, and updates collection/writer prompts, input diagnostics, and preview data to preserve the ETF label.
  - Nikkei acquisition and existing 17:00 scheduler, Fact/Voice/X gates are unchanged.
- tests:
  - targeted close-data + close-report tests: **63 passed / 0 failed**
  - full `x-test-post` regression (`deno test --no-check --allow-read --allow-env supabase/functions/x-test-post/*_test.ts`): **387 passed / 0 failed**
  - pure modules (`deno check close_report_data_logic.ts close_report_logic.ts`): PASS
  - `git diff --check`: PASS
  - coverage includes `^TPX` rejection, valid 1306.T same-day close, explicit-label invariant, metadata mismatch, 15:29 and previous-day rejection, missing-proxy fail-safe, and existing close-report regressions.
- production_deploy: not performed; no manual close_report, OpenAI/X API, X post, DB, Cron, settings, secrets, or OAuth operation.
- deploy_verification: N/A.
- unchanged_scopes: 17:00 schedule/posting windows/Cron, Nikkei path, Fact/Voice/X safety gates, morning_report, morning_greeting, important-news, personalized reports, `apps/admin/**`, `HANDOFF.md`, and formal repository working tree.
- changed_files:
  - `supabase/functions/x-test-post/close_report_data_logic.ts`
  - `supabase/functions/x-test-post/close_report_data_logic_test.ts`
  - `supabase/functions/x-test-post/index.ts`
  - `.agent/tasks/CODEX_TASK_2.md`
  - `.agent/CODEX_REPORT_2.md`
- commit_hash: `44630c8` (implementation + TASK/REPORT status update)
- push: implementation commit `44630c8` and report metadata commit `15b60c5` are present on `origin/main`.
- remaining_issues: 1306.T is an explicitly labeled ETF proxy and not a formal TOPIX index source; replace it with a formally verified TOPIX source in a separately approved task when available.
- safety_checks: clean temporary worktree from fresh `origin/main` (`d907f6c4ca45ef3ee8e88bdc1b70d64f8bbb4a7f`); no secrets exposed; no production writes or API calls.
- next_recommendation: ChatGPT C2 review. Production deployment remains a separate explicit decision.

## H2 Final Follow-up F2: production deploy verification (2026-09-12)

- task_id: `x-close-report-topix-source-correction-20260911`
- deploy_head: `090af349d771d1f73fe82dd65859eca531464209` (fresh `origin/main`)
- implementation commit `44630c8` contained in deploy HEAD: YES
- clean deploy worktree: `/private/tmp/kabumori-h2-f2-20260912`; temporary config was worktree-local and removed after deploy
- deploy scope: `x-test-post` only, with `--no-verify-jwt`
- worktree-local config: project ref `wsmznyzcvmuitkglfeuj`; `[functions.x-test-post] verify_jwt = false`
- production result: x-test-post **v97 ACTIVE**, `verify_jwt=false`
- source verification: production v97 source read-back matched all 27 runtime files from the deploy source (content length and deterministic byte hash); no mismatches
- CLI download note: `supabase functions download x-test-post --use-api` was attempted in a separate clean worktree but the CLI required a missing `SUPABASE_ACCESS_TOKEN`; the failed read operation changed no source or production state. Equivalent production source read-back and byte comparison were completed through the Supabase API.
- other Edge Functions: versions and `updated_at` unchanged in pre/post list comparison
- forbidden scopes: DB / migrations / RLS / RPC / Cron / scheduler / posting_windows / settings / secrets / OAuth / Vault / social_accounts had no writes or changes; read-only snapshots remained unchanged
- safety checks: no manual close_report, Function invocation, candidate injection, OpenAI API, X API, or X post
- remaining_issue: formal TOPIX source is still a future replacement; 1306 remains an explicitly labeled ETF proxy
- status: `review_required`; next_owner: `chatgpt`

## H2 — push delivery deduplication hardening (2026-09-12)

- task_id: `push-delivery-deduplication-hardening-20260912`
- status: `review_required`; next_owner: `chatgpt`
- model_used: `gpt-5.6-sol`
- source_base: `origin/main` at task start `441803c102104c5078e34ce34d8f01fbb32c475d`
- fresh_source_check: latest `origin/main` read-only GitHub API check is `b850f6fb31de84b7100b7e8b7f55342cb9cf60a9`; it is one commit ahead of the task base (`441803c`), changes only Market Intelligence Core docs/function/migration files, and does not overlap any H2 source, test, migration, or report path. Local `git fetch` could not resolve github.com in this environment; GitHub API read-back was used to fresh-check.
- worktree: isolated temporary clean clone; the formal checkout and its unrelated local changes were not touched.

### Current architecture / producer dedupe audit

- `important-news-monitor` enqueues only after an actual published important/most-important X outcome. The producer resolves a deterministic matching tracked stock and uses existing notifications unique keys / duplicate handling; reprocessing the same source retains the same dedupe key. No producer code was changed.
- Market-critical enqueue is limited to market-wide candidates (`company_code IS NULL`), opted-in users, and one deterministic tracked-stock row per user/event. Existing SQL checks and conflict handling preserve same-event dedupe. No producer code was changed.
- `personalized-reports` enqueue requires a completed, Fact-passed report and current push plus morning/close opt-ins. Its partial unique index `(user_id, source_type, source_id) WHERE source_type='personalized_report'` covers nullable `tracked_stock_id`; `ON CONFLICT ... DO NOTHING` makes repeated enqueue idempotent. No producer code was changed.
- Existing producers therefore have row-level dedupe. The main concrete duplicate risk was downstream concurrent dispatch, not an observed producer creating a second row.

### Queue, dispatcher, Cron, and settings audit

- Production `notifications` previously had only `pending/sent/failed/skipped`; no atomic claim, lock token, retry count, retry time, or stored provider error/receipt fields. Dispatcher v4 selected up to 200 pending rows without order or claim, then sent Expo batches; overlapping Edge invocations could select and send the same row.
- Cron `send-push-notifications-dispatch` is active every minute. The last-7-day read-only snapshot showed 2,523 successful `pg_cron` runs, zero non-success runs, max SQL job duration 80.088 ms, and no overlapping SQL job pairs. Its `net.http_post` is asynchronous, so this does not prove that long-running Edge invocations cannot overlap; atomic DB claiming is still required.
- Old dispatcher checked global `push_enabled` and `important_news` after selection, but did not re-check market-critical, morning-report, or close-report settings. The proposed claim RPC re-checks global push; `important_news`; market-critical only when a candidate can be identified as market-wide; and report-type settings only when the matching report row exists. Unknown/deleted sources fail closed rather than guessing.
- A user can still change a setting after the atomic claim transaction and before the external Expo request; a database transaction cannot safely be held open across network delivery. This small TOCTOU window remains and must be part of C2's policy review.

### Risk classification

| Risk | Before hardening | Proposed handling |
|---|---|---|
| Two dispatcher invocations send one pending row | P0 | Atomic `FOR UPDATE SKIP LOCKED` claim changes the same row to `processing` and assigns a per-claim UUID; final updates compare status and claim token. |
| Edge runtime ends after Expo may have accepted a request | P1 | Expired processing claim becomes `failed / PUSH_DELIVERY_OUTCOME_UNKNOWN`; it is never reset to pending automatically. |
| Provider ticket explicitly reports transient per-message error | P1 | Same row only, bounded to three claim attempts with 2-minute then 10-minute delay; any successful device ticket makes row `sent`; after the bound it is terminal `failed`. |
| Expo 429/5xx HTTP response | P1 | At most three attempts for the same batch with 2s/4s backoff; other 4xx responses do not retry. Transport exceptions/timeouts are ambiguous and not retried. Expo tickets still indicate Expo acceptance, not device delivery. |
| No ticket / response cardinality mismatch | P1 | Positional mapping is treated as unknown; row is terminally failed without resend. |
| Settings disabled before claim | P1 | Atomic claim RPC marks safely identified queued rows `skipped` before delivery. The short claim-to-Expo TOCTOU described above remains. |
| Producer receives same event twice / NULL stock key | P2 / protected | Existing important-news/market-critical conflict logic and personalized-report partial unique index retained; no dedupe key weakened. |
| Cron launches overlapping HTTP invocations | P1 capability, no observed overlap in SQL job history | `SKIP LOCKED` claim makes row ownership atomic even if HTTP invocations overlap. |

### Code / schema proposal

- Dispatcher now obtains work only via `claim_pending_push_notifications`; it no longer performs an unclaimed pending-row GET or JavaScript-side settings filter.
- The proposed expand-only migration adds `processing`, attempt/next-retry/claim/error columns and due/stale indexes, plus a service-role-only `SECURITY DEFINER` claim RPC with an empty search path, 200-row clamp, `SKIP LOCKED`, opt-out checks, and per-row claim token. It does not insert notification rows or alter producers.
- Final status PATCH is compare-and-set on notification id + `processing` + claim token and requires exactly one returned row. Pre-send token lookup failures can retry the same row only within the attempt bound. No-device rows become `skipped`.
- An ambiguous transport exception after a request starts terminally fails rows in started batches and only retries rows in later, not-yet-started batches. Failed DB finalization never silently returns a possibly delivered row to pending.
- Production schema is not changed; migration is local/proposed only. Existing production state remains unchanged.

### Migration history / production safety

- Production migration history and current `origin/main` migration files are two-way divergent: 17 local-only and 11 remote-only versions were observed. Several structures needed by H2 are present in production, but migration history is not a safe basis for automated application.
- `supabase db push` was not used. No production migration/RPC, Edge Function deployment, Cron/settings change, manual Expo/OpenAI/X API call, or push send was performed.
- There is no local PostgreSQL/Docker runtime in the work environment. The transactional migration was not executed or rollback-proven against a disposable database, and true concurrent-session claim behavior was not integration-tested. Static SQL/source contract checks are not a substitute for that proof.

### Tests

- Push dispatcher pure tests: **18 passed / 0 failed**.
- Queue claim SQL/source contract tests: **6 passed / 0 failed**.
- Important-news producer regression: **29 passed / 0 failed**.
- Market-critical producer SQL regression: **6 passed / 0 failed**.
- Personalized-report regression + dedupe contracts: **24 passed / 0 failed**.
- Combined relevant suite: **83 passed / 0 failed** (`deno test --no-check`; tests are runtime-tested without the unavailable Node type package).
- `deno check` for `send-push-notifications/index.ts` and `push_send_logic.ts`: PASS.
- `git diff --check`: PASS.
- Not verified: actual two-session `SKIP LOCKED` race, disposable-DB migration/rollback, live Expo response behavior. These require C2 review and a disposable Postgres/Supabase environment before any production application/deploy.

### Changed files and handoff

- `supabase/functions/send-push-notifications/index.ts`
- `supabase/functions/send-push-notifications/push_send_logic.ts`
- `supabase/functions/send-push-notifications/push_send_logic_test.ts`
- `supabase/functions/send-push-notifications/push_queue_claim_contract_test.ts` (new)
- `supabase/functions/personalized-reports/push_dedupe_contract_test.ts` (new, contract tests only)
- `supabase/migrations/20260912100000_harden_push_notification_claims.sql` (proposed; not applied)
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/CODEX_REPORT_2.md`
- commit_hash: `b83d73a25089a4a7b99bf1dc14985a6a8206fe59` (H2 implementation commit, rebased onto the fresh upstream main before push).
- push: successful via normal Git fast-forward push. Push-time `origin/main` was `b850f6fb31de84b7100b7e8b7f55342cb9cf60a9`; post-push fresh-fetch confirmed `origin/main` is `b83d73a25089a4a7b99bf1dc14985a6a8206fe59` and contains the H2 commit.
- remaining_issues: run the migration and true concurrent-claim/rollback proof in a disposable database; review residual settings TOCTOU and the bounded HTTP 5xx retry policy; reconcile migration-history divergence before any production migration.
- safety_checks: formal repo/dirty checkout untouched; `apps/admin/**` and `HANDOFF.md` untouched; no production DB/Cron/settings/secrets/OAuth, Edge deploy, Expo/OpenAI/X API, or push-send operation.
- next_recommendation: ChatGPT C2 review. Do not apply migration or deploy dispatcher until C2 approves the SQL proof and production rollout plan.

## H2 Follow-up F1 — disposable PostgreSQL proof (2026-09-12)

- task_id: `push-delivery-deduplication-hardening-20260912`
- result: `review_required`; `next_owner: chatgpt`
- source_base: `origin/main` fresh-checked at `72fcb00484570f5ecacd544b0ae330f1c12f20d7`; isolated clone HEAD matched. Before the proof commit, push-time `origin/main` was fresh-checked and still matched this SHA.
- worktree: clean temporary clone at `/private/tmp/kabumori-h2-f1-20260912-tDGet5/repo`. Formal checkout and existing local changes were not accessed or modified.
- parallel_slot_check: Codex slot 1 is `done`; Claude slot 1 is `review_required`; Claude slot 2 is working on `x-multibrand-phase3c-ai-lab-x-oauth-connect-20260910` (OAuth/Vault and `x-oauth-connect` only). No active slot overlaps this push-claim migration, `send-push-notifications`, or H2 RPC.

### Disposable database and migration proof

- environment: existing local Podman runtime with cached `public.ecr.aws/supabase/postgres:17.6.1.165` (PostgreSQL 17.6, arm64). A new `--rm` container was created with no host port, bind mount, or persistent volume; a throwaway local password was used. Existing unrelated local test containers were only listed, not changed.
- fixture: only in that disposable database, created minimal `profiles`, `tracked_stocks`, `alert_settings`, `notifications` (with the pre-migration `pending/sent/failed/skipped` check), `important_news_candidates`, and `personalized_reports`; Supabase roles `anon`, `authenticated`, and `service_role` were already present. Synthetic fixture rows only; no production data.
- migration: applied the exact repository file `supabase/migrations/20260912100000_harden_push_notification_claims.sql` through `psql`; transaction completed successfully. Verified all five new notification columns, both partial indexes, the `processing` status constraint, RPC signature, `SECURITY DEFINER`, empty search path, and grants.
- rollback containment: the migration itself is wrapped in `BEGIN` / `COMMIT`. In the disposable DB, separately ran `BEGIN; ALTER TABLE public.notifications ADD COLUMN h2_rollback_probe integer; SELECT 1 / 0; COMMIT;` with `ON_ERROR_STOP`; PostgreSQL aborted, and a follow-up catalog query returned 0 for that column. After all proof, stopped the exact temporary container; `podman ps --all --filter name=kabumori-h2-push-proof-20260912` returned no rows. No cloud or production resource was used.

#### Reproduction record

The disposable container used the already-cached image, had no published port or mount, and was deleted at the end:

```sh
podman run --detach --rm --name kabumori-h2-push-proof-20260912 \
  --env POSTGRES_PASSWORD=<throwaway-local-password> \
  public.ecr.aws/supabase/postgres:17.6.1.165
```

Minimal prerequisite DDL (all created only in that container):

```sql
CREATE TABLE public.profiles (id uuid PRIMARY KEY);
CREATE TABLE public.tracked_stocks (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES public.profiles(id)
);
CREATE TABLE public.alert_settings (
  user_id uuid PRIMARY KEY REFERENCES public.profiles(id),
  push_enabled boolean NOT NULL DEFAULT true,
  important_news boolean NOT NULL DEFAULT true,
  market_critical_news boolean NOT NULL DEFAULT false,
  morning_report boolean NOT NULL DEFAULT true,
  close_report boolean NOT NULL DEFAULT true
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id),
  tracked_stock_id uuid REFERENCES public.tracked_stocks(id),
  source_type text NOT NULL,
  source_id text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  importance text NOT NULL DEFAULT 'normal',
  push_status text NOT NULL DEFAULT 'pending'
    CHECK (push_status IN ('pending','sent','failed','skipped')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_dedupe
    UNIQUE (user_id, tracked_stock_id, source_type, source_id)
);
CREATE TABLE public.important_news_candidates (
  id uuid PRIMARY KEY,
  company_code text
);
CREATE TABLE public.personalized_reports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  report_type text NOT NULL
);
```

Then apply the exact migration file via `podman exec -i <container> psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres < supabase/migrations/20260912100000_harden_push_notification_claims.sql`. The concurrent sessions each used `BEGIN; SELECT id, claim_token, attempt_count FROM public.claim_pending_push_notifications(1); SELECT pg_sleep(0.7); COMMIT;`; only one due fixture row was eligible per race. Metadata/role checks used `has_function_privilege`, `pg_proc.prosecdef`, `pg_proc.proconfig`, `information_schema.columns`, `pg_indexes`, and `pg_get_constraintdef`.

### Claim-path behavior

- concurrency: two independent `psql` connections each ran `BEGIN; SELECT id, claim_token, attempt_count FROM public.claim_pending_push_notifications(1); SELECT pg_sleep(0.7); COMMIT;` against a set with exactly one due target row; the loser returned zero rows. Repeated across six independent races (one initial race plus five repeated rounds, alternating launch order): **6/6 one winner, 6/6 loser empty, 0 duplicate claims**. Winner was connection B in five rounds and A in one.
- claim-token CAS: updating with a wrong token affected 0 rows; the correct token/status updated exactly 1 row; a second finalization could not update it. After setting `sent`, a subsequent claim returned 0 rows.
- retry: exercised actual RPC state transitions on a single fixture row. Claim attempts were 1, 2, 3 on the same row; retry due times of 120s and 600s blocked immediate re-claims (0 rows), then became claimable after advancing the fixture due time. At attempt 3 the dispatcher-equivalent terminal decision was `failed / PUSH_ATTEMPT_LIMIT_REACHED`; no fourth claim occurred and exactly one row remained. Pure dispatcher tests independently verify the three-attempt bound and error policy.
- stale processing: rows with `push_claimed_at` 16 minutes old and `NULL` were both changed to `failed / PUSH_DELIVERY_OUTCOME_UNKNOWN`, claim fields cleared, and attempt counts left unchanged; neither was automatically replayed.
- settings and source mapping: in a rollback-only transaction, `push_enabled=false`, market-critical opt-out, `close_report=false`, missing important-news candidate, and missing personalized-report mapping were skipped and not returned. The opted-in market-critical event and a mapped company-news event were returned. No source mapping was guessed.
- permissions: `service_role` invoked the RPC successfully; actual calls as `anon` and `authenticated` both returned permission denied. Catalog checks confirmed `SECURITY DEFINER`, empty `search_path`, and only the intended service-role execute grant.
- compatibility: pre-existing fixture rows in all four legacy states (`pending`, `sent`, `failed`, `skipped`) remained valid after migration; attempt count defaulted to 0. Existing producer dedupe constraints were not modified by the migration.

### Regression and safety

- combined push / queue / important-news producer / market-critical / personalized-report regression: **83 passed / 0 failed**.
- `deno check supabase/functions/send-push-notifications/index.ts supabase/functions/send-push-notifications/push_send_logic.ts`: PASS.
- `git diff --check`: PASS; no source or test files changed for this follow-up.
- changed files for this follow-up: `.agent/tasks/CODEX_TASK_2.md`, `.agent/CODEX_REPORT_2.md` only.
- production: migration/RPC not applied; `supabase db push` not run; no Edge Function deploy, Cron/settings/secrets/OAuth changes, Push, OpenAI/X API, or X post.
- remaining_issues: the known settings change window between database claim and the external Expo request remains; migration-history divergence remains. C2 should review these and the rollout/disable plan before any production migration or dispatcher deployment.
- commit_hash: `7a42df9bf3aa756063cc0a9d994eac360eb9bb70` (proof/status control-file commit).
- push: successful; the commit above was fetched back from `origin/main` and verified there. This report-only revision records the successful push.
- next_recommendation: C2 review. Production rollout remains blocked pending C2 approval; do not apply the migration or deploy the dispatcher.

## H2 Follow-up F2 — production rollout stopped at automatic review gate (2026-09-12)

- task_id: push-delivery-deduplication-hardening-20260912
- result: blocked before production DDL; status review_required; next_owner chatgpt
- fresh source: origin/main and clean isolated clone both at ecfb183b31dae03de85955c7608d65762debb0b2.
- worktree: /private/tmp/kabumori-h2-f2-20260912-nguDH8/repo; source HEAD unchanged. A temporary, untracked supabase/config.toml bound project wsmznyzcvmuitkglfeuj and [functions.send-push-notifications] verify_jwt=false; it is not part of the report commit.

### Production preflight (read-only)

- Supabase project ref matched the worktree config.
- send-push-notifications: v4 ACTIVE, verify_jwt=false.
- public.notifications: pre-migration schema; legacy push status constraint permits pending/sent/failed/skipped; all five H2 columns absent; no H2 indexes.
- Required alert_settings columns (user_id, push_enabled, important_news, market_critical_news, morning_report, close_report) were present.
- Required personalized_reports (id, user_id, report_type) and important_news_candidates (id, company_code) columns were present.
- public.claim_pending_push_notifications did not exist. Target version 20260912100000 had no migration-history row. The only current notification status observed was one sent row.
- A post-rejection read-back confirmed the same schema/function/history state; no DDL was applied.

### Blocker and production actions

- The exact approved migration file was loaded from the clean source and submitted once using the Supabase migration tool. Automatic review rejected it before execution with: “This action was rejected due to unacceptable risk. Reason: This applies a production migration that changes the notifications schema, indexes, delivery-claim function, and privileges, while the user explicitly prohibited production DB migrations and changes. Do not bypass this rejection through a workaround or indirect execution.”
- No CLI/direct-SQL/MCP alternative was used to bypass the rejection.
- send-push-notifications deploy was not attempted because the migration/read-back prerequisite was not met.
- Function list post-check still showed send-push-notifications v4 ACTIVE / verify_jwt=false. It also showed market-intelligence-ingest v1, which was absent from the first function snapshot; H2 did not deploy or modify that function, and its origin is unconfirmed. It is flagged as an external/unrelated observation, not investigated.
- No Push send, synthetic notification, Expo/OpenAI/X request, X post, Cron/settings/secrets/OAuth change, or other Edge Function deploy was performed.

### Current disposition

- No source, migration, DB, or production function changes were made by this follow-up.
- Only this report and its matching slot-2 TASK status are updated for handoff.
- Direct resolution of the approval conflict was required before retrying production work. The user supplied explicit authorization in the following turn; see the resumed rollout below.
- status: review_required; next_owner: chatgpt.

## H2 Follow-up F2 — explicit authorization, production rollout completed (2026-09-12)

- task_id: `push-delivery-deduplication-hardening-20260912`
- result: the explicitly authorized production migration and dispatcher deploy completed; natural-event observation remains pending; status `review_required`, next_owner `chatgpt`.
- authorization: user explicitly approved only the exact H2 migration and, conditional on successful schema read-back, `send-push-notifications` deployment. No `supabase db push`, alternate migration, or unrelated production operation was used.
- source: fresh `origin/main` was `763c444f02bcb5c24c8deb3fe259ce4bba030215`; isolated clone HEAD matched. H2 implementation commit `b83d73a25089a4a7b99bf1dc14985a6a8206fe59` is an ancestor. The source migration blob matched `76a408919f1dd4b5587104fe9179b0a1c707f91f`; worktree-local config selected project `wsmznyzcvmuitkglfeuj` and `verify_jwt=false`.
- active-slot check: Codex slot 1 was done; Claude slot 1 was review_required; Claude slot 2 was working on `x-oauth-connect`/OAuth and did not overlap the notifications claim RPC or dispatcher. Formal checkout and its uncommitted changes were not accessed.

### Production migration and read-back

- Preflight confirmed an active/healthy Supabase project on PostgreSQL 17.6; the live `notifications` schema still had the legacy status constraint, lacked all five H2 columns and both H2 indexes, and had no claim RPC. Required `alert_settings`, `personalized_reports`, and `important_news_candidates` columns were present. One existing notification was `sent`.
- Applied exactly `supabase/migrations/20260912100000_harden_push_notification_claims.sql` once after the user’s direct authorization. The migration API reported success.
- Important migration-history detail: the apply tool automatically recorded `harden_push_notification_claims` under generated version `20260912075354`; the filename version `20260912100000` remains absent. No manual history repair/reconciliation or other version marking was done. This generated-version mismatch is disclosed for C2 review and must not be silently reconciled here.
- Read-back verified the five columns/defaults, `processing` status constraint, nonnegative attempt constraint, both partial indexes, RPC body/signature, `SECURITY DEFINER`, empty `search_path`, and ACL limited to `service_role` (anon/authenticated execute false). The existing notification remained `sent`; `push_attempt_count=0`. No notification was inserted or sent by this task.

### Dispatcher deployment and verification

- Fresh predeploy read-back showed `send-push-notifications` v5 ACTIVE / `verify_jwt=false` (the earlier report’s v4 was stale). Deployed only `send-push-notifications` from the exact origin source using Supabase CLI `--project-ref wsmznyzcvmuitkglfeuj --no-verify-jwt --use-api`; deployment succeeded as v6 ACTIVE / `verify_jwt=false`.
- A Supabase deploy-connector attempt rejected the temporary worktree entrypoint path before deployment; no version was created by that attempt. The supported CLI deploy then succeeded once.
- `supabase functions download send-push-notifications --project-ref wsmznyzcvmuitkglfeuj --use-api` downloaded exactly `index.ts` and `push_send_logic.ts`; both byte-compared equal to the approved origin source.
- All unrelated functions retained their immediate predeploy versions and `updated_at`: `x-test-post` v98, `important-news-monitor` v41, `stocks-master-sync` v7, `stocks-new-listing-sync` v6, `x-oauth-connect` v5, `personalized-reports` v4, `market-intelligence-ingest` v2.
- The previous active deployment was v5, not the v4 assumed by the older rollback note. No rollback was needed or attempted; this version discrepancy is recorded rather than hidden.

### Natural observation and safety

- `send-push-notifications-dispatch` remained active at `* * * * *`; read-only `pg_cron` history showed 1,440 successful scheduler runs in the prior 24 hours (latest observed 2026-09-12 07:59 UTC). Scheduler success is not treated as proof of an individual Edge response.
- Queue read-back showed only one existing `sent` notification, zero pending/processing/failed rows, and attempt count 0. No natural pending notification existed to exercise the new claim/send path; end-to-end natural-event observation remains pending. No synthetic row or manual Function call was made.
- No Push/Expo, OpenAI, or X request was manually invoked; no Push was sent by this task. No Cron, user setting, secret, OAuth, unrelated schema, or other Edge Function was changed.
- Test evidence remains the already reviewed disposable-Postgres proof and regression suite: 83/83 PASS; `deno check` PASS. No source/test files changed in this rollout.
- Temporary worktree config, CLI-local metadata, and the separate source-readback directory were removed from the disposable environment; none are included in the metadata commit.
- changed/pushed control files for this follow-up: `.agent/tasks/CODEX_TASK_2.md`, `.agent/CODEX_REPORT_2.md` only.
- next_recommendation: C2 review the generated migration-history version mismatch and await natural queue activity before considering completion of production observation. Current status: `review_required`; `next_owner: chatgpt`.

## H2 — broad-news-phase5-coverage-expansion-and-all-useful-scope-20260914

- task_id: `broad-news-phase5-coverage-expansion-and-all-useful-scope-20260914`
- result: Phase 5 code, review-only migration candidate, tests, and read-only production estimates prepared; **C2 review required**. Production migration/deploy remain prohibited and were not performed.
- status: `review_required`
- next_owner: `chatgpt`
- source_base: `origin/main` was fresh-checked at `83b2f89bf24c45e6c18fb17286142ce3ec7c0c4a`; this clean isolated worktree was based on that commit. Formal checkout and its pre-existing changes were not accessed.
- model_used: Codex; exact model identifier was not available in the task metadata.

### Current collection bottleneck

- Phase 4 observed a Saudi Aramco East-West oil pipeline restoration-duration follow-up was not surfaced by web search (`rawCandidateCount=0` for the relevant oil/energy topic), rather than being rejected by downstream quality gates.
- Current collection still uses allowlisted/visited-source validation and a bounded four searches per 20-minute fetch. The gap was follow-up query coverage and a short 3-hour freshness window, not a missing downstream company identity.

### Collection changes

- Added a rotating `market_event_followups` search query covering Saudi/Aramco pipeline repair and restoration timelines, outage duration, supply volumes, shipping resumption, sanctions/policy changes, damage updates, and financial-system outages.
- Follow-up results must carry a concrete `event_at` update timestamp and be within 6 hours; normal queries retain their 3-hour window. The prompt distinguishes a new update timestamp from the original incident and rejects old recaps/analysis.
- No source domains were added or allowlist rules loosened. Existing URL validation, actually-visited-source requirement, HTTPS check, and source policy remain.
- Search budget before/after: maximum 4 per fetch × 3 fetches/hour = **12/hour, 288/day**, unchanged. The new rotating set lengthens the worst-case revisit interval for one rotating query from about 160 to 180 minutes; it does not increase per-hour call volume.
- Follow-up topic behavior: one rotating query slot per fetch; no extra Cron, fetch, or parallel search was added.
- Zero-result diagnostics: added bounded per-run provider/query result and rejection counts, distinguishing successful zero results from provider errors. Diagnostics are best-effort persisted into the existing run record before candidate processing and returned in the response. Consecutive zero counts can be derived from run rows; no cumulative streak column/table was added.

### all_useful, app, and producer changes

- Current all_useful behavior: non-emergency market-wide items generally required a registered-sector match; emergency continued through its separate existing policy.
- New all_useful behavior: market-wide **medium/high/critical** items no longer require registered ticker/sector matching. Low remains ineligible. Category-off, push opt-outs, Fact/Japanese-copy, freshness, same-event, and duplicate gates remain required. Emergency keeps its prior dedicated path. Other presets and company/holding/watch matching are not broadened.
- App visibility: all_useful users can see unmatched market-wide medium+ items; low remains hidden. Existing severity/category labels, detail route, and Fact-passed Japanese display gates are retained. Market-only records are labelled `market` / 「市場全体」 and render when the user has no tracked stocks.
- App copy: eligible English market-wide medium+ records can enter Japanese app-copy generation without sector matching; only the existing Fact-passed Japanese copy is displayable. The copy target RPC remains service-role-only.
- Producer changes: review-only wrapper candidate for `enqueue_important_news_notifications()` retains the prior producer and adds all_useful unmatched market medium/high/critical candidates subject to settings/category/push opt-in, Fact/Japanese text, freshness, event and row dedupe. No dispatcher change; `send-push-notifications` source and claim RPC are untouched.

### Schema / migration candidate

- Added `supabase/migrations/20260917120000_broad_news_phase5_all_useful_scope_and_run_diagnostics.sql` as a review candidate only. It adds `important_news_monitor_runs.diagnostics jsonb` and replacement/wrapper RPC definitions for app-copy targeting, the authenticated user's app feed, and enqueue eligibility while retaining base behavior/permissions and safety gates.
- The migration was not applied. Local rollback-contained PostgreSQL proof could not run: no local server was listening at `127.0.0.1:54322`; `supabase db lint --local --schema public` failed to connect. An initial local Supabase/container metadata check was blocked by a sandbox permission error writing the user's Podman config. These failures were not worked around against production. Static migration checks passed, but SQL execution/rollback behavior remains **unverified** and must be reviewed/proved in an isolated disposable PostgreSQL environment before any C2 production decision.
- No production migration, RPC/schema change, migration-history repair, `supabase db push`, Edge Function deploy, Cron/settings change, synthetic candidate, manual Push, or X/OpenAI API invocation occurred.

### Read-only production estimates (last 7 days)

- Candidate rows observed: **592** total — TDnet **519** (87.7%), `market_macro` **59** (10.0%), `breaking_market` **14** (2.4%). These are source/class counts, not unique event counts.
- One active all_useful user was observed with 20 active tracked stocks and all 16 categories enabled; this is a snapshot, not a population-wide forecast.
- Under the old all_useful market rule, the read-only eligibility query found **1 critical + 1 high** candidate. Under the new unmatched-market medium+ rule it found **1 critical + 6 high**: **+5 high** over seven days (about **0.71 additional candidate/day**), with no incremental critical or medium item in that stricter push-eligibility estimate. No notification was enqueued or sent by the estimate.
- App-feed raw-row upper bound for unmatched market medium+ was **12 rows** in seven days (critical 1, high 6, medium 5); this is not a guaranteed distinct-event/user-visible count because it is before event-level presentation dedupe. Existing notification rows in the queried seven-day window: **0**.
- Collection increment cannot be measured from the historical week because the follow-up query was not in effect; no numeric candidate uplift is claimed. Expected search-call increment is **0/day**; stale recap risk is bounded by required update timestamp plus 6-hour freshness, with normal duplicate/same-event gates unchanged.

### Changed files

- `src/app/news/[id].tsx`
- `src/app/news/index.tsx`
- `src/lib/important-news.ts`
- `src/lib/news-labels.ts`
- `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`
- `supabase/functions/important-news-monitor/breaking_market_source_fetchers_test.ts`
- `supabase/functions/important-news-monitor/index.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic.ts`
- `supabase/functions/important-news-monitor/news_coverage_logic_test.ts`
- `supabase/functions/important-news-monitor/news_coverage_wiring_test.ts`
- `supabase/functions/important-news-monitor/news_collection_diagnostics.ts`
- `supabase/functions/important-news-monitor/news_collection_diagnostics_test.ts`
- `supabase/functions/important-news-monitor/phase5_migration_static_test.ts`
- `supabase/migrations/20260917120000_broad_news_phase5_all_useful_scope_and_run_diagnostics.sql`
- `tests/app/news-labels_test.ts`
- `.agent/tasks/CODEX_TASK_2.md`
- `.agent/CODEX_REPORT_2.md`

### Verification

- `deno test --no-check --allow-read supabase/functions/important-news-monitor/*test.ts`: **402 passed / 0 failed**.
- `deno test --no-check --allow-read supabase/functions/send-push-notifications/*test.ts supabase/functions/personalized-reports/*test.ts tests/app/*test.ts`: **76 passed / 0 failed**.
- Migration static test: **3 passed / 0 failed** (also included in the 402-test monitor suite).
- `deno check` for changed pure modules (`breaking_market_source_fetchers.ts`, `news_coverage_logic.ts`, `news_collection_diagnostics.ts`): **PASS**.
- `git diff --check`: **PASS**.
- App TypeScript/npm lint/build were not run: this clean worktree has no `node_modules`, and no dependency installation was permitted or performed.

### Safety / disposition

- Production DB/RPC/migration: **0**; Edge deploy: **0**; Cron/settings: **0**; manual candidate/Push: **0**; OpenAI/X API: **0**; X posts: **0**.
- Formal checkout, other H1/Claude workstreams, `apps/admin/**`, and `HANDOFF.md`: untouched.
- commit_hash: `18807d51b671c1bfbafe372e491174bcd982f89b` (Phase 5 implementation, review migration candidate, TASK/REPORT status).
- push: successful to `origin/main`; a post-push fresh fetch confirmed `origin/main` contains `18807d51b671c1bfbafe372e491174bcd982f89b`.
- remaining_issues: isolated PostgreSQL migration execution/rollback proof is outstanding; app package-level type/build checks are outstanding because dependencies are absent. Historical collection uplift cannot be quantified before natural observation.
- next_recommendation: C2 review the migration SQL and require disposable-database apply/rollback proof before considering production migration/deploy. Keep status `review_required`, next_owner `chatgpt`.

## H2 Phase 5 verification follow-up — 2026-09-14

- task_id: `broad-news-phase5-coverage-expansion-and-all-useful-scope-20260914`
- status: `review_required`
- next_owner: `chatgpt`
- source_base: freshly checked `origin/main` at `736afe1b95bc7d0afce85fb6ba5ec2d7d2882765`
- scope: disposable local PostgreSQL migration/RPC proof, app package validation, and regression rerun only; no implementation source changes.

### Disposable PostgreSQL migration proof

- A separate temporary worktree (`/private/tmp/kabumori-h2-phase5-20260914/db-proof`) ran the full migration chain through `20260917120000_broad_news_phase5_all_useful_scope_and_run_diagnostics.sql` on a local PostgreSQL 17.6 database. It was not linked to a Supabase production project.
- A temporary local-only `cron.schedule` no-op shim was used because older migrations contain production endpoint command strings. This prevented any Cron scheduling/execution during replay and exists only in the disposable proof worktree; it is not a repository migration.
- The Phase 5 migration applied successfully against the existing schema. Read-back confirmed `important_news_monitor_runs.diagnostics` is `jsonb NOT NULL DEFAULT '{}'::jsonb`, and an insert/read-back of JSON diagnostics succeeded.
- The three replacement RPCs were present with `SECURITY DEFINER` and `search_path=''`. Grants read back as: authenticated-only for `get_my_important_stock_news(integer)`; service-role-only for `important_news_app_copy_targets(integer)` and `enqueue_important_news_notifications(integer)`. `anon` had no execute on any wrapper. The renamed compatibility-base RPCs had owner-only execution; no public, anon, authenticated, or service-role execution remained.
- Rollback was demonstrated by rebuilding the disposable DB to the immediately preceding migration version `20260916100000`. Read-back then showed the Phase 5 migration history row and diagnostics column absent, original RPC names restored, all Phase 5 base-name wrappers absent, and zero temporary user/candidate/notification/run fixtures.

### RPC behavior proof and remaining issue

- A rollback-contained `DO` proof passed for unmatched market medium/high/critical visibility for an `all_useful` user with no tracked stocks; low and duplicate rows were absent from that feed.
- Producer proof passed for one unmatched market medium/high/critical enqueue to the eligible `all_useful` user. Low, category-off, generation-Fact-failed, stale (>6h), and duplicate candidates were not enqueued. `push_enabled=false` and `important_news=false` users received none. Repeated producer invocation created no additional notification.
- Existing behavior proof passed: unmatched market rows did not expand `quiet` / `standard` / `many`; a high company candidate still reached standard/holding and many/watch users with the correct tracked-stock IDs, while quiet/high remained excluded.
- App-copy targeting included an eligible unmatched English medium candidate and excluded low, category-off, app-copy-Fact-failed, and duplicate candidates.
- **Review blocker found:** an 8-hour-old unmatched English medium candidate was still returned by `important_news_app_copy_targets(integer)`. The Phase 5 broad app-copy target branch has no freshness predicate. This does not affect the producer's tested 6-hour stale gate, but the app-copy target does not meet a blanket stale-exclusion expectation. No code/migration edit was made in this verification-only follow-up; agree/fix the app-copy freshness policy and repeat the isolated proof before production approval.
- Feed category preferences remain separate from push eligibility; the category-off fixture was excluded from producer and app-copy targeting. No Push dispatcher was called; only temporary local `notifications` rows from the SQL proof were inserted and cleaned within the same `DO` block.

### Verification rerun

- Phase 5 / important-news-monitor suite: **402 passed / 0 failed**.
- Related send-push-notifications, personalized-reports, and app suites: **76 passed / 0 failed**.
- `apps/admin` lockfile install with lifecycle scripts disabled: **completed**; package/lock files unchanged.
- `npm exec tsc -- --noEmit`: **PASS**.
- `npm run lint`: **PASS**.
- `npm run build`: **PASS** (Next.js 16.3.4).
- `git diff --check`: **PASS**.

### Safety

- Production migration/RPC/schema change: **0**; production deploy: **0**; `supabase db push` / migration-history repair: **0**.
- Production Cron/settings changes: **0**; synthetic production candidate/Push: **0**; production manual invoke: **0**; X/OpenAI API calls and X posts: **0**.
- No source code or migration file changed in this follow-up. Existing Phase 5 TASK remains `review_required` / `next_owner: chatgpt`.
- Historical collection uplift still awaits natural observation; the app-copy stale-target finding above remains for C2 review.

## H2 Phase 5 app-copy freshness follow-up — 2026-09-15

- task_id: `broad-news-phase5-coverage-expansion-and-all-useful-scope-20260914`
- status: `review_required`
- next_owner: `chatgpt`
- source_base: freshly fetched `origin/main` at `a34319a107bd2337bf55c3b5a5970ac92cbe96a9`.
- integrated_base: `b39f7cf2ffbbc32b2a98c11e0d7fa9545613e1b8` (H1 Phase 3K TASK-only update; no overlap with H2 files).
- Scope: address only C2's app-copy freshness finding; no producer/feed, other preset, client, or unrelated source change.

### Change

- Updated `supabase/migrations/20260917120000_broad_news_phase5_all_useful_scope_and_run_diagnostics.sql` in `important_news_app_copy_targets(integer)`'s Phase 5 `broad_targets` CTE with `coalesce(candidate.published_at, candidate.created_at) >= now() - interval '6 hours'`.
- This is the same timestamp precedence used by the Phase 5 producer. The inclusive `>=` accepts the exact six-hour boundary. The predicate is limited to market-wide `all_useful` app-copy targets; feed/producer and `quiet` / `standard` / `many` / company / holding / watch behavior were not changed.
- Updated `phase5_migration_static_test.ts` with a scoped assertion for the app-copy CTE and the inclusive six-hour predicate.

### Disposable PostgreSQL apply / behavior proof / rollback

- Used the existing isolated `/private/tmp/kabumori-h2-phase5-20260914/db-proof` Supabase local project (`project_id=db-proof`, local Postgres port 55432; no production project link). Its temporary `cron.schedule` no-op shim remained local-only so historical migration replay could not schedule production endpoint commands.
- Replayed the local migration chain with the updated candidate migration. Read-back confirmed the migration was applied, `important_news_monitor_runs.diagnostics` remained `jsonb NOT NULL DEFAULT '{}'`, the app-copy RPC contained the six-hour predicate, and its existing `SECURITY DEFINER`, empty `search_path`, and service-role-only execute grant remained intact (`anon` and `authenticated` execute false).
- Rollback-contained RPC behavior proof passed: an English, sector-mismatched medium candidate exactly six hours old was included; an eight-hour-old fixture was excluded. Existing low, category-OFF, app-copy Fact-failed, and duplicate exclusions passed. The same proof retained unmatched-market feed behavior, producer medium/high/critical eligibility, category/Fact/stale/duplicate and opt-out exclusions, repeated-enqueue idempotency, and `quiet` / `standard` / `many` plus company holding/watch behavior.
- Post-proof read-back found zero fixture users, candidates, notifications, and run rows. Reset local DB to immediately preceding migration version `20260916100000`; read-back confirmed Phase 5 migration record/diagnostics column/base wrappers absent, original RPC names restored, and fixtures still zero. Stopped and removed only the disposable `db-proof` local DB volumes; other local Podman project was left untouched.

### Verification

- `deno test --no-check --allow-read supabase/functions/important-news-monitor/*test.ts`: **403 passed / 0 failed** (402 previous tests plus the new migration freshness regression).
- `deno test --no-check --allow-read supabase/functions/send-push-notifications/*test.ts supabase/functions/personalized-reports/*test.ts tests/app/*test.ts`: **76 passed / 0 failed**.
- `apps/admin`: lockfile-based `npm ci --ignore-scripts --no-audit --no-fund` completed; `npm exec tsc -- --noEmit`, `npm run lint`, and `npm run build` all passed. `package.json`/lockfile unchanged; Next's generated `next-env.d.ts` edit was restored and generated `deno.lock` removed.
- `git diff --check`: PASS.

### Safety / disposition

- Production migration/RPC/schema: **0**; `supabase db push`: **0**; production deploy: **0**.
- Production Cron/settings changes: **0**; synthetic production candidate/Push and production manual invoke: **0**; X/OpenAI API calls and X posts: **0**.
- Changed files for this follow-up: migration, migration static test, `.agent/tasks/CODEX_TASK_2.md`, and this report only.
- implementation_commit: `9b1281637f1ea8f1bed6863ff5e786ef918f51fa` (`Align Phase 5 app copy freshness gate`), rebased onto the fresh `origin/main` above.
- GitHub sync: successful. The implementation and H2 status/report commits were pushed; post-push fresh fetch confirmed `origin/main` at `4f9bcc23a1fc291be1f7679de99e6f49a75c4010`, containing implementation commit `9b1281637f1ea8f1bed6863ff5e786ef918f51fa`. This report-only update records that verified result.
- remaining_issues: no production action is authorized by this follow-up; C2 should re-review the updated migration candidate before any separate production approval.
- next_recommendation: return to C2 with status `review_required`, next_owner `chatgpt`.

## H2 Phase 5 production rollout — 2026-09-15

- task_id: `broad-news-phase5-coverage-expansion-and-all-useful-scope-20260914`
- status: `review_required`
- next_owner: `chatgpt`
- production preflight: fresh `origin/main` at `244fbf5963d80d121a373278881d6c8b7f319c67`; approved implementation commit `9b1281637f1ea8f1bed6863ff5e786ef918f51fa` is an ancestor. H1 is isolated to AI Lab/x-test-post; Claude observation is read-only; no migration/RPC/function overlap was found.

### Production migration

- Applied exactly the approved Phase 5 migration SQL from `supabase/migrations/20260917120000_broad_news_phase5_all_useful_scope_and_run_diagnostics.sql` through the Supabase migration API. `supabase db push` and migration-history repair/reconcile were not used.
- Apply result: **success**.
- Supabase recorded the migration under server-assigned history version `20260915130756` with name `broad_news_phase5_all_useful_scope_and_run_diagnostics`; no manual history edit was made. The requested file timestamp remains a repository filename only.
- Read-back: `important_news_monitor_runs.diagnostics` is `jsonb NOT NULL DEFAULT '{}'::jsonb`; all three replacement RPCs exist; each is `SECURITY DEFINER` with empty `search_path`; `get_my_important_stock_news(integer)` is authenticated-only, while `important_news_app_copy_targets(integer)` and `enqueue_important_news_notifications(integer)` are service-role-only. The app-copy definition contains the inclusive `coalesce(published_at, created_at) >= now() - interval '6 hours'` gate plus medium/high/critical, all_useful, category, Fact, app-copy-attempt, stale, and duplicate gates. Producer/feed definitions retain their approved medium+ all_useful branch and existing preset/company/holding/watch paths.

### important-news-monitor deploy

- Deployed **only** `important-news-monitor` from the clean `origin/main` worktree with `--no-verify-jwt` / `verify_jwt=false`.
- Result: **success**, ACTIVE version **53**. Previous version was 52. `x-test-post` remained v108; all unrelated Function versions and metadata were unchanged.
- Post-deploy source read-back via `supabase functions download ... --use-api`: all 21 deployed runtime files byte-compared equal to the approved local deploy source (`0` mismatches). Test-only files are not part of the deployed bundle and were not included in the runtime comparison.

### Natural observation

- Read-only observation after deployment found no post-deploy completed monitor cycle yet. The latest observed scheduled runs were completed and error-free, with `fetched_count` 241, `duplicate_count` 108/105/102, `new_candidate_count` 3, and diagnostics `{}`; no fresh unmatched market medium+ candidate, app-copy target, or important-news notification was present in the queried window. Notification queue counts were pending 0 / processing 0 / failed 0. Natural Phase 5 behavior is therefore **未観測**; no synthetic candidate, enqueue, Push, manual invoke, X, or OpenAI call was performed.

### Safety

- No other Edge Function deploy; no Cron/scheduler/settings/user-setting change; no OAuth/Vault change; no `supabase db push`; no migration-history repair; no synthetic candidate/Push; no manual Function/OpenAI/X invocation; no X post.
- `apps/admin/**`, `HANDOFF.md`, formal checkout, and other workstreams were untouched. TASK remains `review_required` / `next_owner: chatgpt` for C2.

## H2 X news generation failure hardening — 2026-09-16

- task_id: `x-news-generation-failure-hardening-20260916`
- status: `review_required`
- next_owner: `chatgpt`
- source_base: fresh `origin/main` `81422dd7df1dd6f40f8f07bce3b4ba9fcf81b585`; isolated clean worktree `/private/tmp/kabumori-h2-news-hardening-1789529652`.
- implementation_commit: `44ffe59d29e666ce158efc3445efbf7b4b2985c5` (pushed to `origin/main`).

### Production diagnosis (read-only)

- `important_news_candidates` `generation_failed` rows in the requested 14-day window: **141** (the shared corrected cumulative figure remains 142 for 2026-09-01 through 2026-09-15).
- Failure codes: `NEWS_GENERATION_FACT_RETRY_FAILED` 67, `NEWS_GENERATION_FACT_FAILED` 54, `NEWS_GENERATION_VOICE_FAILED` 17, `NEWS_GENERATION_LOCAL_FACT_FAILED` 2, `NEWS_GENERATION_INVALID_OUTPUT` 1.
- Source distribution is dominated by `tdnet` (66/49/13/2/1 respectively), with smaller `breaking_market` and `market_macro` contributions. Representative Fact stops were chiefly missing explicit event years, unsupported market interpretation/causality, and unconfirmed company identity; representative Voice stops were wording/role precision and unnatural explanatory closures. These are safety stops or bounded-retry failures, not evidence for weakening Fact/Voice gates.
- No production row was written, regenerated, or resent. Secrets and raw production text were not copied into this report.

### AI call path and cost audit

- Normal X generation path remains: `draft` → `fact` → `voice`, each using `gpt-5.6-luna`, reasoning effort `low`; output caps are 1400 tokens for draft/retry steps and 650 for Fact/Voice checks. Fact correction and Voice wording retries remain conservative and bounded at one each; final Fact/Voice checks remain independent and fail-closed.
- Existing retry paths were retained: a retryable Fact failure can add `fact_retry` plus a final Fact recheck; a retryable Voice failure can add one `voice_retry` plus Fact and Voice rechecks. Non-retryable safety failures do not trigger retries.
- Before/after local fixture measurement used a 4,000-repeat disclosure body. Before the change, the same full candidate packet was sent to all three stages (about 97,845 JSON input characters). After the change, draft/fact/voice packets were about 32,678 / 32,615 / 514 characters (65,807 total), a **32.7% reduction** for this representative three-stage workload. The Voice packet intentionally omits the disclosure body and `affectedEntities`; Fact still receives the body evidence it needs.
- The draft prompt now explicitly forbids adding unsupported forecasts, future changes, or market reactions in the closing sentence. No collection, severity, category, dedupe, app-copy, Push, or publication policy was changed.

### Changed files and safety-preserving implementation

- `supabase/functions/important-news-monitor/post_generation_logic.ts`: added stage-specific normalized input packets to `generationModelInput`; `draft` keeps the full candidate, `fact` keeps source/judgement evidence including `bodySummary`, and `voice`/`voice_retry` receives only fields needed for style checking plus the generated text. Added one explicit no-unsupported-forecast instruction to the existing draft prompt.
- `supabase/functions/important-news-monitor/post_generation_logic_test.ts`: added a regression fixture proving Voice does not receive the disclosure body/affected-entity payload and that the serialized Voice input is less than one third of the draft input for a large body.
- No other source, migration, DB, Cron, settings, `x-test-post`, `personalized-reports`, app, OAuth, or workflow files changed.

### Verification

- Targeted `post_generation_logic_test.ts`: **107 passed / 0 failed**.
- Full `important-news-monitor/*test.ts`: **404 passed / 0 failed**.
- Changed-module `deno check --no-lock`: **PASS**.
- `git diff --check`: **PASS**.
- No production API or paid model call was made; all verification used local mocks/fixtures.

### Safety / disposition

- Production DB/schema/migration/RPC: **0**; deploy: **0**; Cron/settings: **0**; manual candidate or X/OpenAI invocation: **0**; X posts: **0**.
- Formal checkout and its existing uncommitted changes, H1/Claude workstreams, `apps/admin/**`, and `HANDOFF.md` were untouched.
- Remaining item for C2: review the bounded input-packet change and fixture measurement before any separately authorized production deploy. Status is `review_required`; next owner is `chatgpt`.
# H2 — Social mobile Phase 13 QA live-source follow-up — 2026-09-22

- task_id: `social-mobile-app-phase13-production-preview-rollout-and-qa-20260921`
- status: `review_required`; next_owner: `chatgpt`
- fresh_preflight: fetched `origin/main` and fast-forwarded the clean QA worktree to `fc33d90fa577c336c27ed31c34efc79e160e14db`. No local source changes or other-workstream files were present.
- qa_runtime: created a temporary QA-only Expo Go runtime from this fresh tree with process-only `EXPO_PUBLIC_DATA_SOURCE=supabase`, the public Supabase URL and publishable/anon key. No repository env/default, production setting, secret, or committed file was changed. Temporary dependencies were installed only under the disposable worktree and `.gitignore` was restored to its original content.
- live_read_proof: after the user signed into the existing dedicated QA Auth account, the mobile app showed the live-source status and exactly one owned workspace (`My Workspace`) and exactly one X account (`@yumeyoasobi`). No production `@kabumori`/`@yume_daka` account or additional workspace was visible. Tenant membership isolation therefore passed at the UI/read path.
- blocker: the live account card displayed `要確認` rather than `接続済み`. The client maps only `connection_status = 'connected'` or `'identity_verified'` to connected; the required identity-verified condition was therefore not proven by this runtime. This is a concrete live-source/account-status mismatch. No OAuth relink/retry was attempted and no token/Vault read was performed.
- preview: **not executed**. OpenAI calls 0; X API/media/posts 0; scheduled_posts writes 0; publish_enabled changes 0; Vault/Storage writes 0. Because the required identity-verified QA account proof failed, the approved one-shot AI preview was not invoked.
- verification: `npm run typecheck` PASS; `npm run lint` PASS; `git diff --check` PASS. These ran in the disposable worktree after dependency installation; package manifests and lockfiles are unchanged.
- next_recommendation: C2 should perform a read-only diagnosis of why the QA account is returned with a non-connected status (without OAuth relink or mutation), then re-authorize the one preview only after `identity_verified` is proven. Do not select production accounts or invoke OpenAI from the current state.
- safety_checks: no production DB/schema/RLS/RPC/Cron/settings mutation; no Edge deploy; no OAuth mutation; no X/OpenAI production call; no publish or scheduled-post side effect; no source code change; no secrets or credentials reported.

## H2 Social mobile OAuth reconnect status hardening — 2026-09-22

- task_id: `social-mobile-app-phase13-production-preview-rollout-and-qa-20260921`
- status: `review_required`; next_owner: `chatgpt`
- fresh_preflight: fetched `origin/main` at `f501fbb` and created isolated clean worktree `/private/tmp/kabumori-h2-oauth-fix-t7jxdS`; H1 is isolated to important-news search diagnostics and other slots have no overlap with the OAuth migration/RPC files.
- root_cause: the existing `begin_social_mobile_x_oauth_connection` RPC unconditionally changed any existing X account to `authorization_pending`, so a later/abandoned reconnect demoted a previously verified account. This matches the live QA symptom (`@yumeyoasobi` showing `要確認`) while `verified_at` remained present.
- implementation: added `supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql`, a `create or replace` of only the mobile begin RPC. Existing `identity_verified` remains `identity_verified` during reconnect; new/unverified rows remain `authorization_pending`. The RPC still uses `SECURITY DEFINER`, `search_path = 'public'`, authenticated-only execute grants, and does not modify `publish_enabled` or callback completion semantics.
- changed_files:
  - `supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql`
  - `supabase/functions/x-oauth-connect-user/mobile_oauth_reconnect_test.ts`
- mobile_ui_review: reviewed `apps/social-mobile/src/app/accounts/index.tsx`; reconnect is explicitly user-triggered/local UI state and no automatic reconnect behavior was added. No app source change was needed.
- regression_tests: focused reconnect/RPC-boundary tests **2 passed / 0 failed**; x-oauth-connect-user suite **29 passed / 0 failed**; combined social-mobile preview + OAuth suite **37 passed / 0 failed**; `git diff --check` **PASS**.
- test_coverage: static regression asserts verified reconnect preservation, pending/new-account behavior, no unconditional demotion, no `publish_enabled` mutation, and authenticated-only RPC boundary. A disposable PostgreSQL server was not available in this environment, so no live SQL apply/rollback proof was claimed.
- production_safety: production migration apply **0**; production row repair **0**; Edge deploy **0**; real OAuth **0**; OpenAI preview **0**; X API/media/post **0**; Vault/Storage/scheduled-post writes **0**; publish_enabled changes **0**; Cron/settings/schema outside the candidate migration **0**; secrets/tokens not read or reported.
- remaining_issues: the candidate migration is not yet applied, the live QA row remains `authorization_pending` until a separately approved read-only precondition and repair, and the one-shot AI preview remains unexecuted. C2 must review before any rollout.
- safety_checks: formal checkout, `apps/admin/**`, `HANDOFF.md`, H1, and Claude workstreams untouched; no production mutation or manual API execution.
- next_recommendation: C2 review the migration candidate. If approved, separately authorize production apply/deploy, then verify `verified_at`, dedicated identity, Vault reference presence (without reading secret values), no newer successful binding, and `publish_enabled=false` before a bounded QA-row repair and the single preview.

## H2 Phase 13 production preflight — 2026-09-22

- task_id: `social-mobile-app-phase13-production-preview-rollout-and-qa-20260921`
- status: `review_required`; next_owner: `chatgpt`
- fresh_preflight: fetched `origin/main` and used clean worktree `/private/tmp/kabumori-h2-preflight-UZiN4r` at `0bf3f1d`; approved OAuth reconnect source-fix commit is present. H1 is separate and no conflicting slot was found.
- current_rpc: production `begin_social_mobile_x_oauth_connection` is still the pre-fix `SECURITY DEFINER`, `search_path='public'` function whose existing-account branch unconditionally sets `connection_status='authorization_pending'`; the candidate migration has not been applied.
- qa_preconditions: dedicated `@yumeyoasobi` row is still `authorization_pending`, with non-null `verified_at`, both access/refresh Vault reference IDs present (presence only; secret values were not read), `publish_enabled=false`, and the expected `social_mobile_user_v1` workspace with exactly one owner membership. OAuth history has the prior consumed verified state and a later unconsumed state; no newer successful binding to another identity was observed. No production account outside this QA scope was changed.
- mutation_gate: the TASK requires explicit trusted authorization before migration apply or QA-row repair. Therefore this turn performed read-only preflight only and stopped before any production mutation.
- production_safety: migration apply **0**; QA row repair **0**; Edge deploy **0**; OAuth retry **0**; OpenAI preview **0**; X API/media/post **0**; Vault/Storage/scheduled-post writes **0**; publish/settings/Cron/schema changes **0**.
- next_recommendation: if separately authorized, apply exactly the reviewed reconnect-preservation migration, read back RPC definition/ACL/search_path, repair only the QA status after rechecking all preconditions, then resume the isolated live runtime and exactly one no-publish AI preview.

## H2 production migration gate result — 2026-09-22

- task_id: `social-mobile-app-phase13-production-preview-rollout-and-qa-20260921`
- status: `review_required`; next_owner: `chatgpt`
- preflight: fresh `origin/main` at `e93996f`; approved migration candidate and the prior read-only QA preconditions were re-read before attempting the operation.
- attempted_operation: exactly one `supabase_apply_migration` request was made for `20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql`.
- safety_gate_result: **rejected before execution** because this is persistent production `SECURITY DEFINER` OAuth RPC DDL and the safety review did not accept the TASK's embedded authorization text as sufficient explicit user approval. No alternate path or workaround was attempted.
- production_result: migration apply **0**; migration history unchanged; RPC/ACL/search_path unchanged; QA `social_accounts` row unchanged; QA repair **0**; Edge deploy **0**; OAuth retry **0**; OpenAI preview **0**; X API/media/post **0**; Vault/Storage/scheduled-post writes **0**; Cron/settings/schema changes **0**.
- remaining_issues: direct user confirmation for the exact migration DDL is still required by the safety gate. The QA account remains `authorization_pending` and the one-shot preview remains unexecuted.
- next_recommendation: after direct authorization, retry only the exact migration, perform the required RPC/QA read-backs, then proceed to the bounded QA repair and single no-publish preview. Do not bypass the safety review.

## H2 Phase 13 production rollout and bounded QA preview — 2026-09-22

- task_id: `social-mobile-app-phase13-production-preview-rollout-and-qa-20260921`
- status: `review_required`; next_owner: `chatgpt`
- fresh_preflight: latest `origin/main` was fetched and the rollout was performed from clean worktrees based on the current main; other slots remained non-conflicting.
- migration: after direct user authorization, applied exactly `20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql`; no `supabase db push` or history repair. Server migration history records version `20260922024844` (`social_mobile_x_oauth_reconnect_preserve_verified`).
- rpc_readback: `begin_social_mobile_x_oauth_connection` read back as `SECURITY DEFINER` with `search_path=public`; `authenticated` EXECUTE=true and `public`/`anon`/`service_role` EXECUTE=false. The definition contains the `identity_verified`-preserving reconnect CASE. The RPC was the only schema/RPC object changed.
- qa_repair: after read-back, conditional preconditions all held: dedicated `@yumeyoasobi`, expected `social_mobile_user_v1` workspace with one owner membership, non-null `verified_at`, both Vault reference IDs present (presence only), `publish_enabled=false`, and no newer successful OAuth binding. Only that row's `connection_status` changed from `authorization_pending` to `identity_verified`.
- live_runtime: QA-only Expo runtime using process-scoped Supabase data source displayed exactly one owned `My Workspace` and exactly one `@yumeyoasobi`; status changed to `接続済み`; no `@kabumori`, `@yume_daka`, or unrelated account was visible.
- real_preview: exactly one UI-triggered real AI preview succeeded and displayed `プレビュー準備完了・投稿なし`. No second attempt was made. The preview path is read-only/no-publish and no generated text or credential was copied into the report.
- postflight: QA row remains `identity_verified`, `publish_enabled=false`, `verified_at` present, Vault reference presence unchanged; QA workspace has one owner membership; QA OAuth state count remains 9 / consumed 3 with no new state; QA `scheduled_posts` count remains 0. Total X account count remains 3 with the same identity hash as preflight; existing production accounts and admin OAuth were not changed.
- safety_checks: OpenAI preview calls **1**; X API/media/posts **0**; scheduled_posts writes **0**; publish enablement **0**; Vault token reads/changes **0**; Storage writes **0**; Cron/settings changes **0**; no other Function deploy; no synthetic candidate; no OAuth relink/retry; no cross-tenant visibility observed.
- remaining_issues: publishing remains disabled and no X post/media operation is authorized. C2 should review this bounded rollout separately from any future publish phase.
- next_recommendation: C2 review the exact migration history version, RPC ACL/search_path read-back, single-row repair, and one-preview postflight. Keep `publish_enabled=false`.
# H2 — Social mobile Phase 18 production-shaped access-only token reader preflight (review required, 2026-09-22)

- task_id: `social-mobile-app-phase18-production-shaped-access-token-reader-preflight-20260922`
- result: Completed a narrow source candidate and read-only production metadata preflight. No production migration/RPC/ACL/schema mutation, Vault plaintext read, Edge deploy, OAuth change, X history call, or publish operation was performed.
- production_preflight: `public.social_accounts` exposes the trusted account binding columns `id`, `brand_id`, `platform`, `handle`, `platform_user_id`, `connection_status`, `publish_enabled`, `verified_at`, `vault_access_token_secret_id`, and `vault_refresh_token_secret_id`. `public.brand_memberships` uses `brand_id`, `user_id`, and `role`; production RLS is enabled on `brands`, `brand_memberships`, and `social_accounts`. The read policies are membership-scoped, with self-membership selection bound to `auth.uid()` and brand/account reads requiring the matching membership.
- vault_preflight: The production `vault` schema has `secrets` and `decrypted_secrets`. Catalog-only read-back confirmed `decrypted_secrets` has a `decrypted_secret` column, but no row or plaintext was selected. Its ACL grants read to `service_role` (and internal owner roles), not public/anon; no client-callable generic plaintext reader was found. Vault `create_secret`/`update_secret` are SECURITY DEFINER internal functions with fixed/empty extension-owned search paths and service-role/internal ACLs.
- oauth_preflight: Existing `begin_social_mobile_x_oauth_connection`, `consume_social_mobile_x_oauth_state`, and `complete_social_mobile_x_oauth_connection` are SECURITY DEFINER. The deployed completion RPC uses `search_path=public, vault` and EXECUTE for `authenticated`; it is an OAuth write path, not a history-token reader. The only existing public token-named reader is the AI-Lab-specific `read_ai_salaryman_lab_x_vault_token`, restricted to `service_role`; it is not reusable for general-user history learning. `x-oauth-connect-user` is ACTIVE version 4 with `verify_jwt=false`; its deployed source remains the Phase 9 user-owned OAuth completion candidate and was not changed.
- qa_metadata: Read-only aggregate checks reported 3 X social-account rows, 3 identity-verified rows, 2 rows with access references, 2 with refresh references, and 1 owner membership row. Only counts/booleans were inspected; handles, user ids, secret ids, ciphertexts, and plaintexts were not read or reported.
- architecture: Added `social_mobile_history_access_reader.ts`, a server-internal access-only contract. `TrustedHistoryAccountBinding` contains only the already-resolved account/workspace/platform/identity binding and one access reference. `readVerifiedHistoryAccessToken()` rejects incomplete, non-X, or non-`identity_verified` bindings before calling the injected reader, and reads exactly one access reference. There is no refresh selector, generic secret-id input, write capability, client/public RPC, admin fallback, token logging, or token-bearing response.
- phase16_wiring: `social-mobile-history-learning/logic.ts` now adapts its existing `readAccessToken` dependency through the new boundary after Auth, owner membership, workspace ownership, exactly-one verified X account, and trusted platform id checks. The default Edge entrypoint remains disabled; no production credential or Vault implementation was wired. The returned token remains an internal local value passed only to the existing read-only X adapter and is absent from `HistoryLearningResult`/HTTP responses.
- migration: **none**. The source candidate does not require a new DB helper to prove the boundary; production currently has no suitable general-user reader and its decrypted view is service-role-only. A future dedicated server-side adapter/RPC, if chosen, requires a separate migration review with exact ownership checks, fixed `search_path`, least-privilege ACL, and no refresh exposure. No migration candidate was applied or created in this task.
- changed_files: `supabase/functions/_shared/brand/social_mobile_history_access_reader.ts`; `supabase/functions/_shared/brand/social_mobile_history_access_reader_test.ts`; `supabase/functions/social-mobile-history-learning/logic.ts`; `supabase/functions/social-mobile-history-learning/logic_test.ts`; `.agent/tasks/CODEX_TASK_2.md`; `.agent/CODEX_REPORT_2.md`.
- tests: New/internal access-boundary + Phase16 history + Phase14/15 related static suites **34/34 PASS** (`deno test --no-check --allow-read`). Modified Edge source `deno check` PASS. `apps/social-mobile` `npm run typecheck` PASS, `npm run lint` PASS, and `npx expo export --platform web` PASS. `git diff --check` PASS. Dependencies were installed only in the isolated worktree; tracked package files were unchanged.
- disposable_proof: No SQL/RPC candidate was introduced, so there was no migration apply/rollback to run. The exact source contract was proven with fake-only injected readers: positive access-only read, unverified/incomplete binding rejection before reader invocation, unavailable-secret fail-closed, no refresh selector, no response/log capability, and Phase16 call-order/response secrecy tests. No production value was used.
- production_mutation: **0** — no production DB/schema/RLS/ACL/RPC, migration, Vault plaintext read/write, Edge deploy, OAuth, X history/API/media/post, OpenAI, Cron/scheduler, settings, or publish operation.
- remaining_issues: The internal reader is a source candidate, not a live Vault adapter. A later rollout must separately decide whether to use a service-role-only server adapter or a dedicated SECURITY DEFINER RPC, then prove its exact production ACL/search_path and tenant binding in a disposable DB before deployment. Default history-learning remains disabled.
- implementation_commit: `732c630166bf8bc0fcaf7a4b5968d1d24a53c0db`.
- push: `origin/main` contains `732c630166bf8bc0fcaf7a4b5968d1d24a53c0db` after fresh fetch/read-back.
- safety_checks: Formal repo and existing uncommitted changes were untouched; no `apps/admin/**`, `HANDOFF.md`, H1 files, production settings, migrations, secrets, tokens, OAuth, X/OpenAI/Vault/Storage/Cron operations were changed or exposed.
- next_recommendation: C2 review the production-shaped contract and metadata findings. Do not create/apply a production reader, deploy history-learning, or call X history until the separate rollout gate is approved.


---

## H2 stale-task closure — 2026-09-28

- previous_task_id: `kabumori-pr32-morning-fact-contract-final-review-20260925`
- disposition: **closed as obsolete/stale; no final PASS/PASS-WITH-FIX/FAIL verdict was manufactured**
- original state: review was interrupted and explicitly deferred on 2026-09-25; partial work was preserved.
- target PR #32 was later merged independently, so keeping H2 reserved for that unfinished review no longer serves an active merge gate.
- historical partial review/report content above is preserved unchanged.
- H2 slot is now intentionally empty and may be reassigned only through a new explicit TASK.
- production mutation from this cleanup: 0.
