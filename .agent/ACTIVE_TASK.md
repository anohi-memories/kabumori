# Active Tasks Index

このファイルは共有オーケストレーションの7枠インデックスです。詳細指示と割当の正本は各TASK/Reportです。statusだけで空き判定せず、task_idとTASK本文も確認してください。

## Routing preference

- かぶモリアプリ実装は G1 / G2 を使用する。
- X自動投稿・複数ブランドX実装は G3 / G4 を使用する。
- `G5`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。
- 各ペア内の割当は空き状況・競合・依存関係を見てChatGPTが決める。
- H1/H2はCodexのレビュー・バグ修正・検証枠。
- ユーザーの個別指定がある場合はその指定を優先する。
- 競合防止ルールは常に優先する。

## Deployment policy

- X自動投稿・Web管理画面の開発中/PR/テスト用PreviewはNetlifyを優先する。
- レビュー完了後の最終production deployのみVercelを使う。
- かぶモリExpo/native本体はVercelを通常開発・merge gateに使用しない。
- Expo native/iOS実機・TestFlightは従来どおり別工程。
- かぶモリ将来WebはPreview/ProductionともNetlifyを使用する。

## Codex H1
- owner: codex
- slot: codex-1
- status: review_required
- task_id: common-account-pr70-readiness-authorization-rereview-20261002
- start_code: H1
- finish_code: C1
- next_owner: chatgpt
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: H1 PASS-WITH-FIX。PR #70 original 47a2ed6 は未変更; final verified candidate aa4d2d425d1d7c432d43c9ecfb8e978a40b80a65 をH1専用branchへ保存。old 6 / latest 7 cases解消、直接common行削除の誤ったlogin_removed観測を局所修正。20 lifecycle PASS / 46 mutations detected / 8 social PASS / 10 invariants PASS。C1が修正取込を判断するまでPR merge HOLD、production mutation 0、apply/deploy禁止。推薦モデル Sol（高）。

## Codex H2
- owner: codex
- slot: codex-2
- next_owner: none
- status: done
- task_id: x-ai-lab-pr66-topic-dedup-review-20261001
- start_code: H2
- finish_code: C2
- source: `.agent/tasks/CODEX_TASK_2.md`
- report: `.agent/CODEX_REPORT_2.md`
- allocation: Final C2 PASS. PR #66 exact head 4f692e4d805ccd3ee628058bb20ee6c1f62cdd6d accepted as safe to merge after fresh no-race check. No H2 source changes. Production fix still requires separate controlled x-test-post redeploy/read-back; no DB/RPC/migration/Cron/OAuth/Vault change. H2 is free after fresh allocation.

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: none
- status: done
- task_id: kabumori-home-report-hero-8-state-assets-20261001
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: Final K1 PASS. Base 8-state Hero PR #72 was already merged; follow-up PR #74 (global 6pt character/CTA lift + CTA height/inset) squash-merged as 9b37c350a3b9d1a936d0e03ddc281e315aba50f2, then final 02/07 aligned assets PR #75 squash-merged as 02ba0e2d728833fb76b74237cc3c237130bcdbf1. Final asset hashes pinned; app tests reported 255/255; EAS build 0; backend/production mutation 0; no Codex review required. G1 free after fresh allocation.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-shared-report-v2-causal-calibration-prod-deploy-20261001
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: controlled production deploy/read-back of merged PR #71 causal-guard calibration to market-report-analysis only; gates OFF, no manual cycle; next live check is 10/2 morning; recommended Sonnet5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: ready
- task_id: x-social-mobile-ai-consult-v1-20261002
- start_code: G3
- finish_code: K3
- next_owner: claude
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: Implement real AI consultation before post generation: authenticated server-side conversational AI, natural chat/questions, current-setting explanation, bounded settings/persona proposals, explicit user confirmation before persistence. Reuse existing content-settings/persona storage and validators; no DB migration, no past-X fetch, no post generation/publish/scheduler/OAuth/common-account changes, no production deploy. Recommended Opus5.5（高）. K3 should normally send the authenticated Edge/API boundary to H2 Sol（高） review before merge.

## Claude G4
- owner: claude
- slot: claude-4
- next_owner: none
- status: done
- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- start_code: G4
- finish_code: K4
- source: `.agent/tasks/CLAUDE_TASK_4.md`
- allocation: Final K4 PASS. PR #65 exact reviewed head e5a66f5ba71f64b1a38d8f89faff3d0a31972949 squash-merged as 6b1f2f6229a1b75743b57900d869368c2c5e8693 after isolated native operator proof. Safari account A was not silently reused; disposable B reached final-consent boundary; cancel/retry passed. Final X consent/linking not completed, production state mutation for the test window 0, real X posts 0. G4 is free after fresh allocation.

## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-pr70-guard-boundary-corrective-20261002
- start_code: G5
- finish_code: K5
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: Final K5 PASS to rereview。PR #70 exact head 47a2ed6a1635177ba82004eace4bddb42d9d53e3。Phase 1からenforcing guardを外し、durable readiness/invalidation foundationへ限定。production mutation 0、merge/apply/deploy HOLD、H1 rereview assigned。

## Deferred

- PR #15 is closed with Final K4 PASS. PR #33 remains unmerged; its Auth/security review/merge decision can now be scheduled separately after fresh slot review.
- Kabumori Expo Web Netlify Preview task is also deferred because it is not currently needed for the native app workflow.

## Control codes

- `H1` / `H2`: Codex H1/H2開始。
- `G1`〜`G5`: Claude G1〜G5開始。ready / in_progressのTASKのみ。
- `C1` / `C2`: ChatGPTが対応Codex枠だけ完了確認。
- `K1`〜`K5`: ChatGPTが対応Claude枠だけ完了確認。
- 単独 `G` / `K`: G5も候補に含め、対象が1枠だけと明白な場合のみ使用。
- `F`: H1/H2 + G1〜G5の全7枠の状態・競合・実際の空き状況を確認する統括コード。

並行実行はtask_idと変更対象が分離され競合しない場合に限る。同じファイル・DB migration/RPC・Edge Function・workflow・production設定等を複数枠で同時変更しない。
