# Claude Task 1

- task_id: kabumori-pr24-privacy-merge-postmerge-verify-20260924
- owner: claude
- slot: claude-1
- status: in_progress
- next_owner: claude
- priority: medium
- recommended_model: Sonnet5（中）
- purpose: K1 PASS-WITH-FIX済みPR #24をfresh main確認後にmergeし、Privacy/Release docs反映とWeb build回帰をpost-merge検証する。

## Accepted state
- PR #24 head: `46515c56f88bb8a9f55c9e235477d660e8b8bd04`
- changed files:
  - `apps/kabumori-web/pages/privacy.html`
  - `apps/kabumori-web/build_test.ts`
  - `docs/mobile-release/RELEASE_READINESS.md`
- tests: 122/122 PASS
- production mutation: 0
- correction: OpenAIに送る派生ポートフォリオ情報として、全体評価額・業種別構成比・TOPIXとの比較をPrivacyへ明記。

## Mandatory startup
1. Independent worktree.
2. Read PROJECT_RULES.md / ORCHESTRATION.md / CURRENT_STATE.md / this TASK.
3. Fresh fetch origin/main.
4. PR #24 headが上記SHAのままか確認。
5. semantic drift/conflictがないことを確認。
6. H2/PR #23と変更ファイルが重ならないことを確認。
7. head変更や非自明な競合があればSTOP。

## Merge
cleanならreviewed head固定でPR #24をmergeする。
Netlify publishやproduction設定変更はしない。

## Post-merge verification
- PR #24 merged/closed
- privacy.htmlにreviewed disclosureが存在
- RELEASE_READINESSの再監査記録が存在
- build test assertionsが存在
- personalized-reports source未変更
- account-deletion未変更
- PR #23 files未変更
- scoped web/legal/app tests
- production web build with dummy operator values
- git diff --check

## Forbidden
- Netlify publish/domain mutation
- personalized-reports / PR #23 edits
- Edge deploy / app_enabled change
- DB/Auth/EAS/App Store/X/admin/MIC changes

## Completion / K1
Report:
- fresh main before merge
- verified PR head
- drift/conflict result
- merge SHA
- post-merge tests
- privacy disclosure read-back
- production mutation=0
- remaining release blockers

When complete:
- status -> review_required
- next_owner -> chatgpt
- STOP for K1.
