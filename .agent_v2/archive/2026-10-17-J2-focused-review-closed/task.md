# J2 — F2/F8 かぶモリ休止 修正3件の限定独立再レビュー
- task_id: kabumori-j2-f2-f8-pause-three-findings-focused-rereview-20261016
- slot: J2
- owner: codex
- status: review_required
- next_owner: chatgpt
- return_to: かぶモリアプリG1のちゃ（運用休止・全体統括）
- start_code: J2
- completion_code: V2
- recommended_model: Sol（高）
- current_task_path: .agent_v2/tasks/J2.md
- current_report_path: .agent_v2/reports/J2.md
- previous_archive: .agent_v2/archive/2026-10-16-J2-f2-f8-pause-integrated-review/
- dependencies: F8 PR #212 head d04ff9d2227bbb0e43d7ddbcf8c3b5cc7ad54d3a; F2 PR #213 head c10f1da593ba3dc365cf340e9569ae1caa9789b1; previous J2 V2 PR #218 report on main; PR129/164 protected
- blocker: CHANGES_REQUIRED / P1 R1 residual: newer entry-gate OFF is not recorded in egress stop sequence; stale pending true still initiates X. R2/R3 PASS. Production/merge/deploy NO_GO.
- production_mutation_window: FORBIDDEN

## 目的
J2 V2（CHANGES_REQUIRED）の3指摘に対するF8/F2の限定修正のみ独立再検証し、PASS_FOCUSED_REVIEWまたはCHANGES_REQUIREDを返す。旧スコープ全体の再監査は禁止。前回レビューは既に受領済み。

## 開始ゲート
fresh origin/main、新旧ACTIVE_TASK/CURRENT_STATEの最新metadata、PR #212/#213/#218のHEAD、PR129/164競合、F2/F8のReport/正確な修正diffを確認。独立clean worktree/checkoutが不可なら停止。旧J2はarchiveで保存。SHA256SUMS・MANIFEST・HISTORY_INDEXを登録済み。archive元ソースとの一致・restore照合済み。archiveはappend-only。

## レビュー限定範囲
1. J2-R1 P1（F8 #212）: late trueが後発OFF/timeout/unreadableを上書きしないこと。TTL既定0と非同期読取開始番号、3秒硬いtimeout（signal無視含む）、並行応答の両順序、実handler上のfinal fetch/write/claim/X/AI/Pushを合成・deny-netで再現。停止完了はin-flight観測とreadbackの後であり、即時停止や全HTTP取消を保証しない。
2. J2-R2 P1（F2 #213）: 7種類のgeneration/test ingressに管理者認証がAI・DB read/claim/write・Xより先にあるか。未認証/不正/非admin/不達→401, 有効admin＋休止→423, 有効admin＋live/dry_runだけmock AI可。例外を許可しない。POSTONAとtrusted scheduled path/既存Authに影響しない。
3. J2-R3 P2（F2 #213）: planPlannerRestoreが安定ID、キー、ブランド/NULL legacy、snapshot stateを照合し、ブランド変更・ID/キー重複・消失・状態drift・初期OFF行を誤復元しない。全体abort、CAS/readback手順・resumeReadinessでpending/running/unknown/Push残を0まで明示。DB実行禁止。

## 検証と完了
旧失敗ケースが新PR HEADでPASSするか確認し、限定のadversarial/negative controlsを実行。既存の本番での設定/配備版/observer#43/Push/PR129/164の残存課題は別の運用ゲートとして区別し、新たな全体監査は要求しない。独立した実測件数と既存既知型エラーを区別してReportへ記録する。
変更可: J2 TASK/Report・ACTIVE_TASK J2 sectionのみ。Product/F2/F8 source/PR HEAD/他slot/production/Auth/RLS/Cron/Secrets/実API課金/SNS/merge/deploy禁止。必要な修正があればF2/F8へ返却する。push/read-back後、J2 status review_required / next_owner chatgptとし、かぶモリアプリG1のちゃ（運用休止・全体統括）へ V2 を送ってください。

## Report
- result: CHANGES_REQUIRED / P1 R1 residual; R2 PASS; R3 PASS
- tests: 79 PASS / 1 FAIL across 80 focused tests (F8 19/19, F2 guard/ingress/tools 44/44, independent probes 16/17). Type baseline: F8 1 / F2 6 existing errors, no new type errors; diff check PASS. See current Report.
- archive: independent SHA256 and source-blob byte restore 2/2 PASS; append-only MANIFEST_SHA256_VERIFICATION_20261016.md and HISTORY_INDEX saved before review.
- push: Report content commit e2d79af004aaeebac567f925eb4a2119738c40e2 committed to main and exact read-back PASS; TASK/ACTIVE metadata publication receipt follows; no product changes
- merge: not_performed
- deploy: not_performed
- production: NO_GO
