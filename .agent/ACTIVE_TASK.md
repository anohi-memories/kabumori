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
- status: done
- task_id: common-account-gateb-managed-auth-final-review-20261005
- start_code: H1
- finish_code: C1
- next_owner: none
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Final C1 accepted PASS-WITH-CONDITIONS for common-account Phase 1 additive foundation. Hosted Gate B closes installation-level managed boundaries. Stale access JWT remained Data-API usable after Auth deletion, so future destructive orchestration requires live writer denial or proven expiry/quiescence beyond session revoke. Production migration/backfill remain separately gated; H1 free after fresh allocation.
- recommended_model: Sol（極高）

## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: x-social-mobile-pr76-final-security-rereview-20261005
- start_code: H2
- finish_code: C2
- next_owner: codex
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: PR #76の最終セキュリティrereview。G4がF1/F2/F3を修正済み。pre-send readiness parity、SECURITY DEFINER effective ACL、runtime-first fail-closed rolloutを独立確認。production mutation/merge/deploy/real X禁止。
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: claude
- status: ready
- task_id: kabumori-topic-detail-visual-polish-20261005
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: iOS Simulator runtime導入後の最終UI確認を再開。PR #84の既存実装を402pt/375pt、初級/中級/上級、長タイトル、背景wash/fade、番号付き本文、具体例、要点、🌱/💡表示までSimulatorで確認し、必要なら小さな見た目修正のみ行う。別PR禁止、EAS 0、backend mutation 0。完了後K1。
- recommended_model: Sonnet5（中）

## Claude G2
- owner: claude
- slot: claude-2
- status: done
- task_id: kabumori-shared-report-v2-editorial-three-points-20261005
- start_code: G2
- finish_code: K2
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: Final K2 PASS to focused H2 review。PR #87 exact head 3561f1eaac41df0f23dcce8fdaace0decc654a0a。朝刊/大引けの3ポイントを数値列挙から重要テーマ見出しへ変更し、Appもshared points_ja優先へ。production mutation 0、merge/deploy HOLD。
- recommended_model: Sonnet5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: x-social-mobile-pr81-production-schema-gate-20261005
- start_code: G3
- finish_code: K3
- next_owner: none
- source: `.agent/tasks/CLAUDE_TASK_3.md`
- allocation: Final K3 = intentional read-only HOLD. PR #81 production preflight is CLEAN, source hashes unchanged, production writes/deploy/X/OpenAI/Vault/OAuth/Cron = 0. Apply package was not frozen because earlier PR #76 migration 20261003090000 is still open/unmerged/unapplied. Do not apply PR #81 ahead by assumption. PR #78 remains blocked. Next orchestration step is K4 for completed PR #76 corrective; after PR #76 disposition is resolved, allocate a fresh G3 continuation for PR #81 production apply gate. No Codex review needed for this read-only HOLD.

## Claude G4
- owner: claude
- slot: claude-4
- status: review_required
- task_id: x-social-mobile-pr76-final-security-corrective-20261005
- start_code: G4
- finish_code: K4
- next_owner: codex
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: Final K4 PASS to one focused H2 rereview. PR #76 exact head 5448e545f4a88bbf6597a981c0bcbe4c01043c30 is OPEN/mergeable; Netlify/Vercel green; fresh-main changed-file overlap 0. G4 reports F1/F2/F3 closed with local disposable/fake-X evidence. Production mutation/read/deploy/real X = 0. H2 review is final unless a concrete blocker is found. Recommended Sol（高）.

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
