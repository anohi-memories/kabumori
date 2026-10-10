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

## Project Critical Path — Common Account

- priority: **CRITICAL / project-wide**
- user decision: 共通アカウント完成を、かぶモリ・X自動投稿の次工程より最優先とする。
- G5 owns the shared common-account critical path.
- Existing G1-G4 tasks are preserved. G5 priority is **conflict-based**, not a project-wide freeze: non-conflicting implementation/test/commit/push/PR/merge and non-conflicting production work may continue.
- If a production boundary overlaps G5 (same DB migration/table/RPC/function, Auth/RLS/permission, Edge Function, secret/settings/Cron/workflow/API boundary, or a shared baseline/fingerprint), G5 has priority and the conflicting operation waits.
- Same-Supabase-DB migration/DDL write sections are serialized only for the actual write/read-back window; waiting/review/user-input time must not keep a global lock active.
- next shared milestone: Phase 3a source implementation -> focused security review -> production preflight/apply gates -> final EAS/TestFlight after the common-account feature set is complete.

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
- task_id: postona-g4-x-oauth-containment-defensive-assessment-20261010
- start_code: H1
- finish_code: C1
- completion_code: C1
- next_owner: chatgpt
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CODEX_TASK.md
- report: .agent/CODEX_REPORT.md
- allocation: Previous common-AI H1 R1/R2 C1 PASS is completed/preserved. User approved G4→H1 single-task handoff after Claude Opus5.5 cyber safeguard stopped current G4 session. H1 performs NORMAL Codex defensive investigation/review (NOT 臨時実装): source-derived function ACL/exposure + containment impact matrix, operator read-only preflight proposal, optional benign fake-PG permission-denial proof. No exploitation reproduction, actual product implementation, real auth/provider/token/live Supabase, production reads/writes, RPC/Edge/deploy/merge, or connection pause. G4 BLOCKED pending H1 C1. Keep H2 G5 E11 review untouched. Return C1 to explicitly named POSTONA G4 chat.
- recommended_model: Sol（高）
## Codex H2
- owner: codex
- slot: codex-2
- status: ready
- task_id: common-account-phase3d-e11-optiond-disposable-security-review-20261010
- start_code: H2
- finish_code: C2
- completion_code: C2
- next_owner: codex
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CODEX_TASK_2.md
- report: .agent/CODEX_REPORT_2.md
- allocation: Focused independent OFFLINE Sol（高） safety review of proposed G5 E11 **disposable-only** direct SQL auth.users DELETE Option D proof before any permission to run it. Scope PR121 guard/identity-fence, PR122 E11 runbook/consent, PR128 photo stop/test/restore docs, Phase1/3a and actual GoTrue/SQL/Audit/Storage/race contracts. Do not choose Option D, run any real Supabase, modify app/source, pause photo, create/delete projects, approve fake destructive tests, migrate/deploy/merge, or touch other slots. Prior H2 G2 review C2 accepted and historical report protected. Return C2 to G5 chat.
- recommended_model: Sol（高）

## Claude G1
- owner: claude
- slot: claude-1
- status: done
- task_id: kabumori-watchlist-real-data-simulator-qa-20261010
- start_code: G1
- finish_code: K1
- next_owner: none
- return_to: かぶモリアプリG1のちゃ
- source: .agent/tasks/CLAUDE_TASK_1.md
- allocation: K1 final PASS_SAFE_STOP for Simulator PRE-FLIGHT ONLY. Claude reported Xcode/iOS Simulator and dev-client present but no authorized signed-in Supabase session; genuine data, watch registrations, saved report basis, highlighted cards and real navigation tests therefore BLOCKED_AUTH / NOT_OBSERVED. Earlier PR120 fixture tests 457/457 reported PASS are NOT equivalent to real account tests. No source/UI changes, EAS=0, DB/user writes=0, deployment=0, credentials exposure=0; other slots and Metro 8081 untouched. No new G1 TASK assigned: wait for user-assisted sign-in on a dedicated Simulator before separate real-data QA continuation. G1 task complete and free, but real-data QA gate NOT PASS.
- recommended_model: Sonnet5（中）
## Claude G2
- owner: claude
- slot: claude-2
- status: review_required
- task_id: kabumori-market-report-delivery-first-guard-calibration-20261007
- start_code: G2
- finish_code: K2
- next_owner: chatgpt
- source: .agent/tasks/CLAUDE_TASK.md
- allocation: PR110 の C2 差し戻し（P2 1件：名詞＋主語の「が」）を修正し、新しい head 2c876b0bafee31844b9854c4a7d34ba69660d4cf を push 済み。Report は .agent/tasks/CLAUDE_TASK.md の先頭の節。全テスト成功、本番操作・デプロイ 0。K2 の判断待ち。マージ・デプロイは保留。
- recommended_model: Opus5.5（高）

## Claude G3
- owner: claude
- slot: claude-3
- status: done
- task_id: postona-x-autopost-production-readiness-20261010
- start_code: G3
- finish_code: K3
- next_owner: none
- return_to: POSTONA G3のちゃ（AI相談V1本番接続担当チャット）
- source: .agent/tasks/CLAUDE_TASK_3.md
- allocation: K3 accepted G3 Stage3B X autopost rollout readiness as PASS_PREPARATION_ONLY / PREPARED_BLOCKED_ON_G5. Draft PR127 exact 4b0278228e726b65d782e9b231eb6fe84d9173ad contains only 5 new docs/offline-test and read-only inventory files; no source/SQL migrations/Edge changed or PR merged. G3-reported local PG O1/A1-A3/R1-R4, six existing pilot parts, ACL adverse, Deno 808/808; live read-only Supabase independently confirms 160000/160100/160200 not applied, publish authority/reader/check absent, AI consultation table and Stage3A refresh table present; x-test-post v141 unchanged. NO live write/deploy/X post/enable/EAS. Blocking G5 active x_autopost entitlement (claim/check/set), service deletion FK cleanup/T13; G4 real X OAuth account identity/T9 and current preclaim containment; G3 future booking generation and four-file deployed-bundle ownership diff. No Codex rereview of offline candidate; one integrated Sol（高） security review before actual production publish authorization. PR127 OPEN DRAFT UNMERGED, no new G3 task; next work driven by G5/G4 owner handoff with separate approval gates.
- recommended_model: Opus5.5（高）
## Claude G4
- owner: claude
- slot: claude-4
- status: blocked
- task_id: postona-x-oauth-preclaim-containment-readiness-20261010
- start_code: G4
- finish_code: K4
- next_owner: codex-1
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- source: .agent/tasks/CLAUDE_TASK_4.md
- allocation: Claude Opus5.5 cyber safeguard interrupted this exact defensive containment readiness task; no current matching G4 Report, K4 NOT completed. User approved temporary delegation of narrowed defensive risk/permission/impact assessment to H1. H1 task postona-g4-x-oauth-containment-defensive-assessment-20261010 ready, ordinary security investigation only, not 臨時実装. STOP new G4 work until POSTONA G4 ChatGPT receives H1 C1 and determines next gate. Existing PR126/124/121/122, G3/X operation and G5 unchanged; no runtime change.
- recommended_model: Opus5.5（高） (on hold, no start)
## Claude G5
- owner: claude
- slot: claude-5
- status: done
- task_id: common-account-phase3d-disposable-proof-pause-restore-preflight-20261010
- start_code: G5
- finish_code: K5
- next_owner: none
- return_to: 共通アカウントG5のちゃ
- source: .agent/tasks/CLAUDE_TASK_5.md
- report: .agent/tasks/CLAUDE_TASK_5.md#report
- allocation: K5 accepted Phase3d two-document offline STOP/TEST/RESTORE plan and risk review, Draft PR128 exact e9244d29ea944156cf1479c0976053d433469e06, source-only and unmerged. Verdict PASS_OFFLINE_DOCS_ONLY / PREPAUSE_BLOCKED. Missing verified dummy OAuth/OIDC identities, E11 independent review and consent, operator/window, Free active slot/cost recheck, photo app pre-pause baseline/backup and restoration process verification. Do NOT pause `anohi-memories` yet, never pause production stock-x-autopost; no live Supabase or feature changes; PR121/122/128 stay Draft. This task completed, next owner none. New work requires new safe TASK.
- recommended_model: Opus5.5（高）

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
