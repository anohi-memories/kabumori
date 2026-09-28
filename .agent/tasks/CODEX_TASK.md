# Codex Task

- task_id: x-social-mobile-phase1-consolidated-integration-review-20260928
- owner: codex
- slot: codex-1
- status: done
- next_owner: none
- priority: high
- recommended_model: Luna（高）
- purpose: social-mobile Phase 1のG3/G4成果を1回だけまとめてレビューする。PR #42（auth/X-connect/onboarding）とPR #44（Home/posting settings/history UX）の統合、merge順、provider/state境界、content-settings保存の回帰を確認する。

## Review targets

- PR #42 head `c5e0157f867450047a5f79a204df45aaeefecfa6`
- PR #44 reviewed/fixed head `966d4123c13c4dcda1799772d262dde5be8cacb8`

## Focus

1. PR #42 -> PR #44 の順で統合したときの競合/型/状態契約
2. `DataProvider` / `ActiveAccountProvider` と Home/schedule/history の組み合わせ
3. real-data modeでmock fallbackが復活しないこと
4. loading/blocked/unavailable/ready/mock_preview の表示整合
5. onboardingからHome到達後のaccount/status表示
6. X connect後のreloadとHome反映
7. multiple workspace/account時のfail-closed維持
8. consult保存が既存設定を巻き戻さないこと
9. `saveConfirmedProposal` / `upsert` の呼び分け
10. content-settings table未配置時に安全にunavailableとなること
11. no service_role/token/secret exposure
12. G3/G4間で同じファイルを二重変更していないこと
13. merge order recommendation
14. app Phase 1が次の実装へ進める状態か

## Constraints

- source review only
- no production DB/config/OAuth/X mutation
- no Stage 3B activation
- no unrelated Admin work
- no broad redesign
- no extra review loop unless concrete defect exists

## Verification

- fresh origin/main
- inspect exact diffs for PR #42 and #44
- test combined tree in recommended merge order
- run:
  - social-mobile tests
  - typecheck
  - lint
  - Expo web export
  - git diff --check
- verify real-data/no-mock behavior in source/tests
- verify consult persistence merge semantics
- verify no regression to auth/X-connect/onboarding

## Fix policy

Small, obvious integration P1/P2 bug may be fixed directly on the affected PR and retested.
Anything design-level => report and stop.

## Completion / C1

Report:
- PASS / PASS-WITH-FIX / FAIL
- exact reviewed/fixed heads
- combined merge order
- integration findings
- tests
- source changes if any
- production_mutation=0
- whether PR #42/#44 can be merged and app Phase 1 can proceed
- next recommended app implementation step

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for C1.


## Final C1 — social-mobile Phase 1 consolidated review

Verdict: **PASS-WITH-FIX**.

- PR #42 accepted head: `c5e0157f867450047a5f79a204df45aaeefecfa6`.
- PR #44 accepted fixed head: `966d4123c13c4dcda1799772d262dde5be8cacb8`.
- H1 fixed one P2 on PR #44: persisted scheduler status mapping now maps `succeeded` to published and History excludes unpublished rows.
- combined integration tree built from latest main with merge order #42 -> #44 passed.
- tests: social-mobile 16/16, data-view 14/14, typecheck/lint/Expo web export/diff all PASS.
- real-data mode remains fail-closed with no mock fallback on blocked/unavailable states.
- onboarding/X-connect/provider state and Home/schedule/history integration accepted.
- consult persistence preserves existing settings and fails safely if content-settings backend is unavailable.
- production mutation=0.
- Phase 1 source work is complete and may be closed after merging PR #42 then PR #44.
- no additional H1 loop required unless merge introduces a concrete discrepancy.
