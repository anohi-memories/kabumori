# Codex Task 2

- task_id: kabumori-pr29-plus-v27-validator-final-review-20260925
- owner: codex
- slot: codex-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna（極高）
- purpose: PR #29のprompt hardeningと、review前にmain→production v27へ入った commit 510acf5 のvalidator拡張を一体で最終レビューする。merge/deployは禁止。

## Review targets

A. Already on main / production v27:
- commit: `510acf5954b37410b50c23ff92c3f54af6458a72`
- change: UNDETERMINED_MOVE_PREFIX に `値下がり|値上がり` を追加
- related tests in close_validator_fix_test.ts
- production v27 is reported byte-identical to this source plus existing MIC integration
- app_enabled=false

B. PR #29:
- branch: `g2-report-false-reject-hardening-20260925`
- head: `bed5e79d0ab22e94be6a7c1ebd0f7c8f157ea0c0`
- changed:
  - personalized-reports/report_logic.ts
  - personalized-reports/report_hardening_test.ts
- source-only, unmerged, undeployed

## Required assessment

### 1. Validator safety for 510acf5

Confirm `値下がり|値上がり` widening is truly narrow.

Must PASS:
- 値下がりの要因は特定できません
- 当日の値下がり要因は特定できません
- 値上がりの理由は判断できません
- 当日の値上がりの原因は確認できません

Must FAIL:
- 急な値下がりの要因は特定できません
- 半導体株の値上がり要因は特定できません
- 円安による値上がりの要因は特定できません
- 値下がりの要因は円高です
- 値上がりの理由は好決算です
- causal assertion + unknown-cause laundering
- multi-sentence/punctuation bypasses

Verify:
- whole-string anchor intact
- CAUSAL_ASSERTION still evaluated first
- sentence splitting intact
- no free-text subject widening

### 2. PR #29 prompt hardening

Confirm PR #29 does NOT weaken validator or Fact checker.

Close inference:
- facts/comparison clauses must stay out of inference_ja
- unsupported causation should reduce to one bounded unknown-cause sentence
- validator must remain fail-closed

Morning wording:
- advisory-sounding wording is discouraged at generation time
- Fact checker should remain semantically unchanged
- neutral replacements do not themselves create unsupported claims

### 3. MIC compatibility

Main already contains MIC report-context integration.

Confirm PR #29:
- does not alter mic_market_context.ts
- does not alter MIC semantics
- does not remove MIC context from prompts
- only changes wording discipline around generated output
- does not create overlap with active MIC work

### 4. Test verification

Run:
- report_hardening tests
- close_validator tests
- full personalized-reports suite
- relevant MIC/report tests
- deno check
- deno lint
- git diff --check

Add adversarial regressions if a concrete bypass is found.

If a concrete issue is found:
- minimal fix only
- push to PR #29
- do not merge/deploy

## Production safety

Read-only verify:
- personalized-reports v27
- verify_jwt=false
- app_enabled=false
- x_enabled=false
- cron unchanged

Do not invoke production LLM.
Do not deploy.
Do not change DB/schema/settings.

## Completion / C2

Report:
- verdict PASS / PASS-WITH-FIX / FAIL
- final PR #29 head
- separate verdict for already-deployed 510acf5
- validator boundary
- prompt/Fact boundary
- MIC compatibility
- test counts
- production read-back
- production mutation=0
- recommendation for merge + controlled redeploy/dry-runs

When complete:
- status -> review_required
- next_owner -> chatgpt
- update .agent/CODEX_REPORT_2.md
- STOP for C2.


## Final C2 — PR #29 + v27 validator

Verdict: **PASS-WITH-FIX**.

Accepted:
- production/main validator commit `510acf5954b37410b50c23ff92c3f54af6458a72`: PASS
- PR #29 final reviewed head `ef9603749a43d0f63ff1ab0ca0f24b33a7bdc1c1`
- H2 minimal fix added `watch_notes[*].note_ja` to the neutral morning wording instruction
- validator and Fact semantics remain fail-closed and unweakened
- MIC compatibility PASS
- focused 32/32; personalized-reports 96/96; deno check/lint/diff PASS
- production mutation from H2 = 0

Next: G2 fresh-main merge + controlled personalized-reports redeploy with app_enabled=false + repeated dry-runs.
