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
- task_id: kabumori-pr87-editorial-three-points-review-20261006
- start_code: H1
- finish_code: C1
- next_owner: none
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Final C1 PASS。PR #87 exact reviewed head 3561f1eaac41df0f23dcce8fdaace0decc654a0a は独立レビューPASS後、squash-merged as 74e4dbff09e3b248164fd00bb720402d762ebcd8。source fix 0、production mutation 0。H1 free after fresh allocation。
- recommended_model: Luna（高）

## Codex H2
- owner: codex
- slot: codex-2
- status: done
- task_id: x-social-mobile-pr76-final-security-rereview-20261005
- start_code: H2
- finish_code: C2
- next_owner: none
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Final C2 PASS on PR #76 exact head 5448e545f4a88bbf6597a981c0bcbe4c01043c30. F1/F2/F3 closed, availability tradeoff accepted, no extra review required. PR #76 squash-merged as 3c5f80a61d114d2936b761fc05ee3b3d69e85f63. H2 free after fresh allocation.

## Claude G1
- owner: claude
- slot: claude-1
- next_owner: claude
- status: ready
- task_id: kabumori-topic-learning-access-progress-and-swipe-20261006
- start_code: G1
- finish_code: K1
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: 実機確認フォロー。① topic/news詳細のiOS edge-swipeを左「戻る」と同じorigin先へ統一、②トピック一覧に初級/中級/上級切替（SettingsはHome初期表示専用）、③トピック既読/学習済みを端末内AsyncStorageで表示。detail成功表示のみ既読化、一覧focus復帰で即反映。375/402 Simulator実スワイプ確認、EAS 0、backend/production mutation 0。
- recommended_model: Sonnet5（高）

## Claude G2
- owner: claude
- slot: claude-2
- status: ready
- task_id: kabumori-pr87-close-natural-observation-20261006
- start_code: G2
- finish_code: K2
- next_owner: claude
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: market-report-analysis v24 の最初の自然な10/6大引けをread-only観測。3ポイントが数値3連発ではなく、出来事・重要材料・次の注目になっているか、Hard false reject、warning/rewrite/callsを確認。16:40 JSTより前は待機せず停止。production mutation禁止。
- recommended_model: Sonnet5（中）

## Claude G3
- owner: claude
- slot: claude-3
- status: review_required
- task_id: x-social-mobile-pr81-production-apply-continuation-20261006
- start_code: G3
- finish_code: K3
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: PR81 continuation may continue read-only Gate A/B/C only. Production write is NOT authorized and must STOP before mutation while G5 common-account production apply decision is pending. Production mutex with G5/G2 mandatory. Recommended Opus5.5（高）.
- recommended_model: Opus5.5（高）

## Claude G4
- owner: claude
- slot: claude-4
- status: done
- task_id: x-morning-greeting-schedule-reliability-bc-20261006
- start_code: G4
- finish_code: K4
- next_owner: none
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: Final K4 PASS. PR #92 exact head 3d5475849217e1ca9f40bbedf12a42c0e5671504 squash-merged as 19c85c4381c55161207032146d6f66eb8a0c99f5. Plan B adds four staggered generator schedules (00:17/02:47/04:17/05:17 JST) with same-day idempotency; Plan C adds read-only missing/late checks at 06:07/09:47 JST. 44/44 tests, fresh-main overlap 0, CI green, production mutation/deploy/X/PAT/Vault/pg_cron=0. No Codex review required. G4 free after fresh allocation. Plan A remains separate.
- recommended_model: Sonnet5（高）

## Claude G5
- owner: claude
- slot: claude-5
- status: review_required
- task_id: common-account-v1-phase1-production-migration-gate-20261006
- start_code: G5
- finish_code: K5
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: Final K5 accepts fresh PREFLIGHT_READY. G4-closed Phase A refresh passed 9/9; only expected PR76 ledger/function deltas observed; production writes remain 0. G5 is now waiting only for explicit user approval of the exact common-account production migration apply. G3 may continue read-only only and must not mutate production before this decision.
- recommended_model: Opus5.5（極高）

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
