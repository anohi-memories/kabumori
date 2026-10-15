## MIC F7｜Stage 1 S1-A SOURCE ONLY へ条件付きGO（2026-10-15 17時台 JST）

- Supabase stock-x-autopost `wsmznyzcvmuitkglfeuj` を2026-10-15に本番read-only集計。2026-10-14 00:00 JST以降、State25（no_change21 / evaluated4）、failed/running0、shadow記録21/21、no_change AI usage0、unexpected shadow status0。Slice0配備2026-10-07 16:11 JST以降State78（no_change67 / evaluated11）、shadow67/67、failed0。最新State実行10/15 15:15 JST。
- equity_indexは自然 `no_new_observation` 未観測（10/14・15はbelow_thresholdまたは重要変化でevaluated）。SOURCE-only S1-A実装は条件付きGO、ローカルSQL合成テストでno_new_observation／no pointer advanceの再現PASS必須。本番GOではない。
- commoditiesのBRENT/WTI最新観測は10/06で止まりshadow `not_verifiable/observation_not_acceptable` 継続。データ品質は別改善課題（認識していないままverifiedを許さないことが必須）。ratesの10/13-14米金利観測staleは10/15 15:15 JST runでbelow_thresholdに復帰。
- production前提read-only：34 metric・multi-source0・最新anchor tie0・market_metrics766行、State RPCはmaterialとno_changeの従来2本、current trigger1/terminal run trigger1。正式verification RPC/DB列は未導入。Scenarioは10/15 10:25 JSTに再AI評価、confidence0.780・valid_until 10/18 06:15 JST（確認時有効）。
- user指定「次回新規MIC TASKはF7、旧G7を使わない」を適用。旧G7 `mic-stage1-formal-verification-design-finalization-g7-20261011` はK7完了済み・旧正本は不変。新F7 `mic-stage1-formal-verification-s1a-source-f7-20261015` **ready / claude / Opus5.5（高） / F7→L7 / MICのちゃ**、`.agent_v2/tasks/F7.md`にSOURCE ONLY/production NO_GO TASK登録済み。新旧task_id二重割当なし。F7 Claude作業は未開始・GitHub TASK登録だけ実施。
- 正本設計：旧G7作成 [Draft PR125](https://github.com/anohi-memories/kabumori/pull/125) head `aa47e40d2a3ba7ec8bfc7d1d30c8eb51d53f2c48` OPEN/Draft/unmerged（本件で不変）。F7はfresh mainから専用独立worktreeを構築後、新規migration **ソースのみ**＋SQL42/変異5テスト・競合/権限/rollback証明。U12イベント窓／U13状態表示とDB再導出の検証。S1-B Edge変更、DB remote migration実適用、merge/deploy、Cron/Auth/Secret、Scenario変更は禁止。S1-A/B source実装後に別枠Codex Sol（高）重点レビュー、Productionには別途承認が必要。
- 今回GitHubで触れたのは新系統のF7 TASK/ACTIVE_TASK/CURRENT_STATEだけ。旧G7や他slotのTASK/Report、商品コード、PR125、Production write操作はしていない。Macのworktree独立性・未コミット変更の実地確認は**F7開始時ゲート**とし、未確認のまま成功扱いにしない。

## POSTONA J4 V4 review — two P2 client fixes (2026-10-15 JST)
- J4 `postona-j4-pr197-postona-deletion-client-security-review-20261014`: V4 CHANGES_REQUIRED P2×2 / PRODUCTION_NO_GO, done/none. Target Draft PR197 HEAD `2171ee4c02ea2eec46562d81595f5460e5507d9d`, unchanged/unmerged.
- P2-R1 incomplete ended provider summary accepted as success, can mask durable X uncertain count and Threads remote-unverified. P2-R2 post-mutation session/read-back errors drop known warning evidence. J4 independently reran mobile 281 tests and F5 Deno120, reproduced faults with negative synthetic tests; no product edits.
- Next product owner G4/F4 app (or user-authorized J5 emergency implementation after prior archive) must implement variant-specific complete result validation and retain current-user-bound known warnings through read-back failure. Separate old server deletion bypass, F3/J3 P2×3, F5/managed environment remain release blockers. No merge/deploy/live account or SNS actions permitted.

## F3 J3 V3 P2追加修正（2026-10-15）
- F3 `postona-f3-j3-v3-ack-lease-rollback-corrections-20261015`: ready/claude、推薦Opus5.5（高）、F3→L3、返却POSTONA G3のちゃ。J3の最新V3 CHANGES_REQUIRED P2 R1a count-only ACK ABA、R3a post-check row lock lease expiry、R1b rollback checkpoint raceをF3所有sourceで修正、使い捨てPGで再現と回帰。F5 PR193のtyped ACK consumerはF5担当に契約を返す。F4/G4 protected、production NO_GO。
- 前F3 TASK `postona-f3-j3-v3-r1-r3-security-fixes-20261013` はarchive `.agent_v2/archive/2026-10-15-F3-postona-f3-j3-v3-r1-r3-security-fixes-20261013/`、SHA256 `fd2b777b4c3d04041eab3dfc68cf2293b4aa6d4d0d7697457e2964fae29a89af`、blob/UTF8復元照合、HISTORY_INDEX済。PR192 Draftは未マージ。

## F2 L2 — Phase2 TOPIX Candidate Premerge Correction (2026-10-15 JST)
- GitHub verified: Draft PR #201 head `6977ca3c82f2138bb27f9cd47a4abab98f59852e`, Draft PR #203 head `46cd29be26b16133a1a5488461a5972f3253e98f`; PR203 stacked on PR201, both open/unmerged. Cloud source tests reportedly pass; no independent local rerun and no live Yahoo TOPIX symbol validation. Production/merge/deploy NO_GO.
- L2 outcome: **CHANGES_REQUIRED_SOURCE_PREMERGE**. PR203 `topixOnNikkeiSession` accepts usable TOPIX when Nikkei is absent/unusable; `market-report-data-packet` dry-run `topix_source` can cause external Yahoo fetch even with normal Secret OFF (requires cron secret, but lacks separate explicit probe gate). Both need offline correction before merge/release. No current production mutation.
- Prior F2 broadcast TASK `kabumori-f2-emergency-market-report-app-feed-broadcast-20261013` archived at `.agent_v2/archive/2026-10-15-F2-kabumori-f2-emergency-market-report-app-feed-broadcast-20261013/`; SHA256 d736b3cd94950794fc1bc402f508e07ae1eb34dfd4084af3f4b0b7e3e78b05c2 and blob restored; HISTORY_INDEX updated.
- Current new F2 TASK `kabumori-f2-topix-pr201-203-premerge-safety-corrections-20261015`: ready/claude; recommended Sonnet5（高）, F2→L2; separate independent stacked Draft based on PR203, leave PR201/203 and other slots untouched. Yahoo/JPX/Nikkei rights not cleared, never authorize actual fetch or production use implicitly.

## POSTONA J4 — independent J5 PR197 deletion-client review (2026-10-14 JST)
- J4 new `postona-j4-pr197-postona-deletion-client-security-review-20261014` ready/codex, recommended Sol（高）, J4→V4 return POSTONA｜マルチSNS化・開発統括（G4）のちゃ. Prior J4 completed TASK+Report archived with SHA256SUMS/manifest, byte readback, and HISTORY_INDEX entry.
- Review PR197 exact `2171ee4c02ea2eec46562d81595f5460e5507d9d` mobile deletion flow source; server-side older builds may still hit `social-mobile-account-delete`. F5 PR193 / F4 PR180 / F3 PR192 dependencies read-only. J3 V3 found P2×3 in X saga; remain blocker, don't relabel PASS based on J4 mobile review.
- J4 may update ONLY J4 task/Report/control metadata, not product code or other slot worktrees. All managed Auth, DB, SNS connect/delete, PR merge/deploy and production activation remain NO_GO.

## 本番の共通朝刊・大引け（2026-10-14 昼の時点）
- market-report-analysis は main `488a8948`（PR #200）を deploy 済み（ユーザーが実行）。10/14 大引けから、ゆめちゃんのコラム文体・市場全体のニュース選別・`yume.scenario_ja` が入る。
- `get_app_market_report` は V2（migration `20261014100000`、ユーザーが適用）。結果の記録は旧G2 Report（K2 待ち）。新F2の配信・通知 TASK は in_progress のまま。

## Legacy G2 content improvements — explicit slot assignment (2026-10-14)
- New user-explicit old G2 TASK `kabumori-g2-market-report-yume-column-top-points-20261014` ready/claude, Opus5.5（高）, G2→K2; old G2 history backed up and preserved. Top 3 points shared by X/app for morning/close; natural Yume conversational report with microheadings, no irrelevant corporate earnings, indicators reference table at app bottom. G2 source-only; F2 ongoing app feed/broadcast production observation isolated. Avoid parallel file overlap and do not modify F6 provider.

## POSTONA J5 V5 — client deletion boundary source accepted (2026-10-14 JST)
- J5 `postona-j5-account-deletion-legacy-bypass-ui-bridge-20261014` V5 PASS_SOURCE_IMPLEMENTATION / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; done / none. Draft PR197 HEAD `2171ee4c02ea2eec46562d81595f5460e5507d9d` unmerged; 18 POSTONA mobile files. Codex reported app tests 281 PASS, tsc/lint/export PASS (ChatGPT not independently rerun).
- Legacy client deletion path is disabled for new app source; `POSTONAの利用終了` and `共通IDを完全削除` are separate. Service-end source transport gate OFF and whole-account submission disabled until explicit release approval. Old installed clients can still invoke old server endpoint: must be secured by its owner; F3 X saga / F5 managed Auth, Threads remote-unverified and integrated independent J1–J4 Sol（高） security review remain blockers. No merge or manual deploy; automatic Vercel status is not production approval.
- J5 emergency implementation completed and released; before assigning new J5 task archive this TASK and Report, verify hashes, append HISTORY_INDEX.

## POSTONA J5 Codex emergency implementation — legacy account deletion UI (2026-10-14 JST)
- User explicitly requested Codex implementation instead of constrained Claude; NEW J5 `postona-j5-account-deletion-legacy-bypass-ui-bridge-20261014` ready/codex, recommended Sol（高）, J5→V5 return POSTONA｜マルチSNS化・開発統括（G4）のちゃ. This is separate from completed F4/F3 task_ids and only G4/F4-owned POSTONA mobile client paths, dedicated clean J5 worktree and Draft PR.
- F5 Phase8 PR193 detected G4-1: old POSTONA deletion UI calls `social-mobile-account-delete` with a second shared-login-deleting pathway. Codex will remove unsafe client call, separate POSTONA-only service termination from full shared account deletion with explicit consent and honest unknown/remote-unverified blocking; cross-owner server changes documented but forbidden. If F5 contract not ready, no invented endpoint and fail closed.
- J3 independent X saga R1/R3 review remains ready, unaffected. Production Supabase/Auth/DB/Edge and SNS OAuth/post/delete/merge/deploy remain NO_GO. J5 may not self-review; independent Sol（高） security review of completed integration later.

## F8/F9 new tasks 2026-10-14
- F8 news-improvement-a-f8-j1b5-security-review-readiness-20261014: ready, Claude Opus5.5（高）, return L8. Offline final DB/RPC review packet for J1-b4 candidate PR191, Sol（高）review pending. No Preview/production or managed migration.
- F9 api-optimization-b-f9-clean-pr190-residual-rights-tests-20261014: ready, Claude Opus5.5（高）, return L9. Rights residue and offline regression tests for clean candidate PR190. PR115/174/184/190 protected; merge/external sends prohibited.
- Prior F8/F9 marked done, archives created with byte-identical read-back and SHA256SUMS, HISTORY_INDEX entries recorded. Both slots must use independent worktrees and nonoverlapping paths.

## F3 J3 V3 指摘修正 — 2026-10-13
- F3新TASK `postona-f3-j3-v3-r1-r3-security-fixes-20261013`: ready/claude、Opus5.5（高）、F3→L3、返却先POSTONA G3のちゃ。J3 V3（`.agent_v2/reports/J3.md`）独立再現P2×3: R1 purge/finalize失敗retryで未確認投稿警告消失、R2 HTTP action:'delete'欠落、R3ロック待ち中リース期限切れ。F3-owned sourceのみ修正、F5 Phase8の共通状態・リースには触れず調整。
- 前F3 TASK `postona-f3-x-service-end-saga-wiring-20261013`（L3 accepted、Draft PR189 `4fd7084d067d2a9f589fd7fecaee70720bc60812`）archive `.agent_v2/archive/2026-10-13-F3-postona-f3-x-service-end-saga-wiring-20261013/`、SHA256 `c3cc256c946076748647a8cd54514955cc11c68a66c5b7d43dfe98a44ce3ac58`、GitHub blob復元一致、HISTORY_INDEX済。
- F5 Phase8 `common-account-f5-phase8-x-threads-lifecycle-integrated-security-20261013` は別担当ready、F4 Threadsは保護。PRはDraft/unmerged、source/offlineのみ、production NO_GO。

## F4 L4 — Threads cleanup live-lease fix accepted (2026-10-13 JST)
- F4 `postona-f4-threads-cleanup-live-lease-security-fix-20261013` accepted PASS_SOURCE_FIX / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; done/none. Draft PR180 exact HEAD `7c4f457834cddb42b72be6b74996e643b213e8c8` stacked on protected PR169. Verified F4-only 10 files, `threads_cleanup_authorized` now invokes F5's `private.account_lifecycle_cleanup_authorized(uuid)` for live lease for both account_deletion/service_deletion; reported local fail-before/pass-after and Deno118, NOT independently rerun.
- F5 PR178 Phase6 predicate/registration dependent; F3 X integration still separate. Independent J1–J4 Sol（高） integration security review before any managed permission, deployment, merge, activation, or real Threads/X/Meta operation. F4 source TASK now complete and must be archived before another F4 allocation.

## F2｜ゆめちゃんAI評論家 朝刊/大引け（2026-10-13）
- F2 TASK `kabumori-f2-yume-market-commentator-morning-close-quality-20261013` は完了報告済み（review_required/chatgpt、L2 待ち）。結果は PASS_OFFLINE_SOURCE / PRODUCTION_NO_GO。
  - Draft PR #188（head `62cd009e029885d9df5f2dd7e2620b66c32439ed`）
  - 朝刊: ゆめちゃんの日経平均の予想（±0.3%未満は横ばい）
  - 大引け: コードが判定する答え合わせと、次の見立て
  - 予想の正本は、変えられない朝刊の共通レポート（migration 不要）
  - 事実と予想で検査の基準を分けた（利用者の追加の指示を取り込んだ）
  - 640件が PASS。F6 の部品と本番は変更なし
- Previous F2 X/app cutover preflight L2 PASS_READONLY_PREFLIGHT / CUTOVER_PLAN_READY / PRODUCTION_NO_GO. PR179 remains Draft; previous TASK/Report archived with manifest SHA256 restore verified and indexed. X gate was turned ON by user at 18:07 and requires actual next-session verification; app consumer gate remained OFF per F2 readback. Consumer production switch is separate from this quality task.

## F4 Threads cleanup lease fix (2026-10-13 JST)
- F5 Phase6 PR178 HEAD `83334a091ded5571cf595fd99d7a035627564735` found F4 PR169 `threads_cleanup_authorized` permits POSTONA service_deletion Threads credential cleanup without a live owner lease. Reproduced in F5 disposable PG17 overlay; must fix before adapter registration / managed use.
- NEW F4 `postona-f4-threads-cleanup-live-lease-security-fix-20261013` ready/claude, Opus5.5（高）, F4→L4, return POSTONA｜マルチSNS化・開発統括（G4）のちゃ. Only F4-owned SQL candidate and tests. Use F5 `private.account_lifecycle_cleanup_authorized(uuid)` fail-closed predicate, live lease pre/post conditions, regression before/after, owner ACL preservation.
- Prior F4 T13 TASK archived verbatim with SHA256, restore comparison and HISTORY_INDEX. Source new independent worktree/stacked Draft on PR169; protected F5/F3/H5/old G4 branches unchanged. Production NO_GO; integrated independent J1–J4 Sol（高） review after L4 and X-side coordination.

# Current State v2（新系統・現在有効な情報だけ）

## F8/F9 L8/L9 acceptance (2026-10-14 JST)
- F8 `news-improvement-a-f8-j1b5-security-review-readiness-20261014`: done/next_owner:none, PASS_OFFLINE_REVIEW_READINESS / SOL_REVIEW_REQUIRED / PRODUCTION_NO_GO. Draft PR196 (stacked over PR191), local security 14 checks and equivalence 30 feeds reportedly PASS; independent tests not rerun here. Production/Preview read/write, merge and deploy not performed. Next: separate Sol（高） DB/RPC/security review, then Preview read-only measurements and explicit product release decision. Existing TDnet content in `company_identity_fixtures.ts` needs separate owner-owned synthetic-fixture task.
- F9 `api-optimization-b-f9-clean-pr190-residual-rights-tests-20261014`: done/next_owner:none, PASS_OFFLINE_AUDIT / MERGE_HOLD. Draft PR195 stacked on clean Draft PR190, 330 Deno tests PASS/1 ignored reported, not independently rerun here. No 40+-character exact overlap against known reference dataset, but incomplete source sampling and rights clearance remain unresolved. Historical PR115/174/184 refs remain untouched. No paid/external model sends.
- F8 and F9 TASK + ACTIVE_TASK completion recorded. Before reuse, archive both completed TASKs/Reports with SHA256/readback and update HISTORY_INDEX. No production permissions granted.


## F5 Phase8 統合検証割当（2026-10-13 JST）
- F5 `common-account-f5-phase8-x-threads-lifecycle-integrated-security-20261013`: ready/claude, Opus5.5（高）, F5→L5, return `共通アカウントG5のちゃ（新F5担当）`. Source-only local PG17/isolated overlayでF3 X PR189・F4 Threads PR180・F5 PR183を統合検証。F3/F4所有ソースは読み取りのみ、別worktree／Draft stacked PR、production NO_GO。
- 前F5 Phase7 `common-account-f5-phase7-auth-lifecycle-release-preflight-20261013` はL5 done、PR183 Draft head `f2565cc0412f8127f95f00a728d16bf83af74667`。TASK+Report archive `.agent_v2/archive/2026-10-13-F5-common-account-f5-phase7-auth-lifecycle-release-preflight-20261013/` 原文一致/read-back・SHA256SUMS・MANIFEST・HISTORY_INDEX保存済み。
- F3 X停止saga PR189・F4 Threads lease修正 PR180はそれぞれL3/L4 source受入候補、未マージ。本番Auth/DB/Edge/Meta/X/Threads/managed検証とアプリ退会routingは未承認・別工程。Phase8後に空きJ1〜J4でSol（高）の独立統合レビューを判断。


## F8/F9 parallel next tasks (2026-10-13)
- F8 `news-improvement-a-f8-j1b4-performance-security-offline-20261013`: ready/claude, Opus5.5（高）, L8. Local SQL performance/security validation for PR181/185 and Sol review packet. No managed migration, Preview or production operation; reported PG17 subset 91/116 migrations and N400 O(n²) concern still require review.
- F9 `api-optimization-b-f9-clean-replacement-final-rights-gate-20261013`: ready/claude, Opus5.5（高）, L9. Clean Draft replacement candidate preserving fail-closed model-send gate, residual rights investigation. PR115/174/184 protected, no branch history rewrite, merge, deploy or external model calls.
- Previous F8/F9 TASKs and Reports archived with SHA256SUMS/MANIFEST/readback, HISTORY_INDEX updated. ACTIVE_TASK reconciliation completed. Independent worktree and nonoverlapping ownership required.


## F8/F9 new parallel TASKs — 2026-10-13
- F8 `news-improvement-a-f8-j1b3-real-schema-proof-review-packet-20261013` ready/claude, Opus5.5（高）, return L8. Validate PR181 candidate in independent local real-schema PostgreSQL and assemble Sol（高）review packet; migration stays outside managed staging/production, no source merge or deploy.
- F9 `api-optimization-b-f9-rights-safe-eval-fixture-redaction-20261013` ready/claude, Opus5.5（高）, return L9. Prepare an isolated source candidate to withhold remaining 288 rights-unconfirmed headlines and 76 generated texts while preserving deny-by-default and offline tests. PR174 and legacy PR115 remain unchanged/Draft; no provider external sends.
- Prior F8 J1-b2 and F9 rights audit TASK+Report archived; manifests, SHA256 and byte-identical read-back verified; HISTORY_INDEX updated. Prior F9 SHA256SUMS blockage retried successfully. F8/F9 independent worktrees and non-overlapping paths; no production/DB mutations authorized.


## F3 POSTONA Xサービス終了saga接続（2026-10-13 JST）
- 旧F3 `postona-f3-x-publish-entitlement-guard-20261013` はL3 PASS_SOURCE_CANDIDATE / PRODUCTION_NO_GO、Draft PR182 `1af5047eb70327c252194220df51e94e8a17ff7e`。TASK/Reportは `.agent_v2/archive/2026-10-13-F3-postona-f3-x-publish-entitlement-guard-20261013/` に保存済み（SHA256 `aa737fc1ee29a515534f24fa8eceead9af85fe419cfa08e85b2a7e6779efe12e`、復元blob一致、MANIFEST、HISTORY_INDEX）。旧G3はdoneで不変。
- 新F3 `postona-f3-x-service-end-saga-wiring-20261013` ready/claude、Opus5.5（高）、F3→L3、返却先POSTONA G3のちゃ。F3-owned X連携解除/終了sagaをPR182候補X停止関数へ接続するソース限定TASK。F5はPhase6/7の共有削除オーケストレーター所有、F4はThreads所有で保護。独立worktree/新Draft PR、前PR HEAD変更禁止。
- 本番 `PRODUCTION_NO_GO`。F5 PR178/183等の候補未適用、G4 X Issue131、実X OAuth/revoke・本番DB/Auth/Edge/merge/deploy未承認。共通`claim_due_post()`をF3では変更しない。


## F8 J1-b2 L8 acceptance（2026-10-13）
- F8 `news-improvement-a-f8-j1b2-visibility-policy-migration-candidate-20261013`: PASS_SOURCE_CANDIDATE / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; done/next_owner:none。Draft PR181 head 94b478a70f5921ef4f0f03d2ad68a4842dc11f35 (F8 Report)。SQL candidateのみ、実migrationやDB適用なし。
- 実装候補はフィード専用helper4個＋既存wrapper置換。X/Push共有helper未変更。候補 a（sector/all_useful）、b（high/criticalを全員）、c（他rejected表示も絞る）の採用ポリシーが未決。F8報告のPG17 matrix5variant成功はChatGPT未再実行。Sol（高）独立レビュー/実スキーマ検証/個別DB承認までmerge・Preview・production NO_GO。
- 次F8 TASK前にarchive/MANIFEST/SHA256/restore/HISTORY_INDEXへ記録。F9の独立作業を保護。

## F8進行中 / F9履歴保存保留（2026-10-13）
- F8 J1-b previous TASK archived with manifest/SHA256/read-back and indexed. NEW F8 `news-improvement-a-f8-j1b2-visibility-policy-migration-candidate-20261013` ready/claude, Opus5.5（高）, return L8. App visibility source/offline candidate only; any migration must have Sol（高） review and explicit approval before DB/Preview/production apply.
- F9 prior L9 task remains done/none. Archive copy and MANIFEST.json/.md were created/read-back, but SHA256SUMS write hit OpenAI safety block; archive process incomplete and F9 reallocation is withheld. Do not overwrite F9 TASK or start unregistered work. Legacy PR115 history and PR174 rights risk (288 headlines / 76 generated texts) remain under hold, no merge/deploy/paid API.
- F8 and F9 boundaries are separate; F8 may proceed independently. No production mutations authorized.

## F9 L9 権利監査完了（2026-10-13 JST）
- F9 `api-optimization-b-f9-pr174-pr115-rights-audit-offline-20261013` L9 PASS_OFFLINE_AUDIT / MERGE_HOLD。TASK/ACTIVE_TASKは done/next_owner:none。監査 branch `claude/f9-pr174-pr115-audit-20261013` commit F9報告 `e5e124896b62d00afa4d8edab62d0d42a33af6ce`、追加文書1ファイルのみ（GitHub compare確認）。304 tests PASS / 1 ignored はF9報告、ChatGPT未再実行。
- PR174は見出し288件と生成投稿文76件の取り扱い判断待ち。PR115旧本文18件は旧Git refsに残存、main既存2fixtureもF8/F2の所有者判断が必要。旧PR115/174を勝手にclose/merge/削除/履歴書換しない。利用許諾未確認のまま有料API/外部AI送信はNO_GO。
- 次F9 TASK前に完了TASKをarchive/MANIFEST/SHA256SUMS/restore/HISTORY_INDEX保存必須。F8国内ニュース作業には非干渉。

## F8 J1-b 国内ニュースアプリ掲載（2026-10-13）
- F8 `news-improvement-a-f8-j1b-app-visibility-offline-design-20261013` L8 PASS_OFFLINE_DESIGN / IMPLEMENTATION_HOLD、done/next_owner:none。成果 branch `claude/news-j1b-app-visibility-offline-f8-20261013` commit `e912d59c24c9a66fe6b41e5f01fb6172f62cff82`（F8 Report）、設計1＋offline PG17 RPC matrix 8ファイル。検証8variant一致はClaude報告でChatGPT未再実行。DB/RPC/アプリ本体、本番変更なし。
- 重要な設計残件: v3単独は震度6強emergencyを消す。v2+v3bの組合せはテーマ追加後もrejected/no_post金融行政処分(C3/C8)を非表示にする。X投稿基準とアプリ掲載の分離(O1)、追跡なし利用者のcritical/high配信(O2)、続報重複(O3)、テーマ→sector(O4)の明示判断が次実装条件。migration/RPC PreviewとSol（高）レビューが必要で本番NO_GO。
- F8次TASK登録前に完了TASKのarchive/MANIFEST/SHA256/restore/HISTORY_INDEX更新必須。F9の同時作業を保護。

## F5 Phase7 共通認証・退会 release preflight（2026-10-13）
- F5 new `common-account-f5-phase7-auth-lifecycle-release-preflight-20261013`: ready/claude、Opus5.5（高）、F5→L5、return `共通アカウントG5のちゃ（新F5担当）`。source-only：実アプリ既存経路とDB/ACL/退会処理をdisposable PGで検証可能なrunnerへまとめ、managed環境での未検証事項とSTOP条件を具体化。production NO_GO。
- 前F5 Phase6 `common-account-f5-phase6-postona-provider-cleanup-service-deletion-20261013` はL5 PASS_SOURCE_CANDIDATE / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO、PR178 Draft（head `83334a091ded5571cf595fd99d7a035627564735`）。TASK＋Reportをappend-only archive `.agent_v2/archive/2026-10-13-F5-common-account-f5-phase6-postona-provider-cleanup-service-deletion-20261013/`へ保存、元blob一致・SHA256/read-back確認、HISTORY_INDEX追記。
- F4の `threads_cleanup_authorized` が生存lease無しでもcleanupを許可する問題は申し送り文書 `docs/common-account/F5_TO_F4_PHASE6_LEASE_GUARD_HANDOFF_20261013.md` に記録。F4担当による新TASKの限定修正待ち。F5はF4/ThreadsやF3/Xのsource/worktree/PRに触れない。
- PR121→152→165→178はDraft/unmerged、本番GoTrue/Auth/Storage/PostgREST確認は未実施。F4/F3連携の後にSol（高）の独立統合レビューを1回判断。


## F2 X/app shared report consumer cutover preflight (2026-10-13)
- F2 の TASK `kabumori-f2-shared-market-report-x-app-consumer-cutover-20261013` は L2 受入済み（PASS_READONLY_PREFLIGHT / CUTOVER_PLAN_READY / PRODUCTION_NO_GO）。
  - **2026-10-13 18:07 JST、利用者が x_enabled=true にした**（読み戻し済み、app_enabled=false のまま）。今日の大引けの X（17:00）は旧来の経路で失敗済み。明日 10/14 08:20 の X の朝刊から、共通の朝刊を投稿する（x-test-post v145、免責文なし）。戻し方は x_enabled=false
  - Draft PR #179（RUNBOOK のみ）
  - 本番の読み取り（16:24 JST）: 今日の大引けは Opus（claude-opus-5-5）で完成（16:21、Fact passed、$0.19）。x_enabled / app_enabled は false
  - Edge の版: market-report-analysis v33（main と一致）、x-test-post v145・personalized-reports v46（main と違う）。migration 20261009120000 / 20261011150000 / 20261012100000 は未適用
  - 切り替えの手順は RUNBOOK の 6 章: X は main の deploy（X 担当の確認）→ x_enabled、アプリは app_enabled／段階3〜7。どれも別承認

## F8 / F9 同時進行（2026-10-13 JST）
- F8 `news-improvement-a-f8-j1b-app-visibility-offline-design-20261013` ready/claude、Opus5.5（高）、L8返却。日本ニュースのアプリ可視性・RPC基準のread-only分析と合成fixture/設計に限定。migration/RPC/production本体は変更しない。
- F9 `api-optimization-b-f9-pr174-pr115-rights-audit-offline-20261013` ready/claude、Opus5.5（高）、L9返却。Draft PR174・旧PR115の権利/履歴/価格/送信ゲートのoffline監査。旧PR115操作・PR174 merge・有料APIなし。
- 両slotの直前TASK/Reportをarchive保存し SHA256SUMS・read-back確認済み、HISTORY_INDEXに追記。F8はdocs/news-coverage/tools/jp-news-coverage、F9はdocs/model-optimization/tools/provider-compareに分離。別worktree必須。PR116/129/164/174、F2/F6、旧G8/G9などの所有変更を禁止。実本番操作はNO_GO。

## Opus production integration release gate (2026-10-13)
- F6 new task `common-ai-f6-opus-both-integration-release-gate-20261013` ready / Opus5.5（高）, F6→L6, owner 共通AI基盤のちゃ. Old F6 preflight archived with matching blob and HISTORY_INDEX updated.
- Anthropic API key is now REGISTERED per user and Claude Code confirmation; live name readback needed before cutover, secret value never handled. PR170→173→175→176 all Draft/unmerged and release gate pending. F2 L2 task is done, F2 ACTIVE_TASK may still lag; do not edit F2 metadata from this chat.
- Actual consumer gates were x=false/app=false: Opus shared generation is not equivalent to X/app delivery. Existing v30 Edge deployment predates 7 F2 report changes, so source release could deploy those as well. F2ちゃ approval needed before rollout. No production action or merge authorized by this task.


## F2 L2｜Opus primary_both handler regression (2026-10-13)
- F2 `kabumori-f2-opus-primary-both-handler-test-sync-20261013` L2 PASS_OFFLINE_TEST_ONLY / PRODUCTION_NO_GO, done/none. PR #176 Draft head `d13efc52176665898f1c38a1e389f9973fc3de00`, 1 F2-owned test file only. Reported 41 handler + 324 integrated PASS (not independently rerun), Vercel CI rate-limited. PR170→173→175→176 remains Draft/unmerged; F6 leads release gate. No production/paid API/Edge changes.

## F2｜Opus primary_both handlerテスト修正（2026-10-13 JST）
- F2 TASK `kabumori-f2-opus-primary-both-handler-test-sync-20261013` は L2 受入済み（PASS_OFFLINE_TEST_ONLY）。PR #176 は main へマージ済み。
  - Draft PR #176（head `d13efc52176665898f1c38a1e389f9973fc3de00`、base は PR175 の branch）
  - 変更は `opus_primary_handler_test.ts` の1ファイルだけ
  - 41/41・market-report-analysis 324/324 が PASS（差分の部分だけの状態では 39/322 で、F6 の報告と一致）
  - 本番 NO_GO
- 前F2 TASK/Reportは `.agent_v2/archive/2026-10-13-F2-kabumori-f2-opus-primary-morning-close-handler-20261013/` に保存、MANIFEST/SHA256SUMSとread-back一致を確認、HISTORY_INDEX更新。F6は独立したOpus provider作業のownerを継続。

## F9 API最適化B — L9完了（2026-10-13 JST）
- F9 `api-optimization-b-f9-rights-safe-provider-compare-pr-readiness-20261013` L9判定 PASS_OFFLINE_DRAFT / RELEASE_HOLD、done/next_owner:none。Draft PR #174 は新規131ファイル（tools/provider-compare と docs/model-optimization のみ）、HEAD F9報告 `ef9876fba680f621b88c2d235a7c011ca5881e2f`。304テストPASS/1 ignoredはClaude報告、ChatGPT未再実行。権利未確認の見出しは非保持で外部送信ゲートを維持。
- 旧PR #115の権利未確認本文を含む履歴、main既存2fixtureの一致箇所、正式な利用許諾、PR174最終CI/mergeability確認は未解決。PR115変更・close・削除やPR174 merge/deploy、有料API使用を無断実施しない。
- F9はAPI最適化B専任。次TASK前に完了TASKのarchive・SHA256・restore・HISTORY_INDEX記録を実施する。F8ニュース・F2/F6 AI・他slotを保護。

## F2 L2 accepted — 2026-10-13
- F2 Opus handler TASK accepted as PASS_OFFLINE_SOURCE / TRANSFER_F6 / PRODUCTION_NO_GO. F2 done/none; user assigned further Opus work to F6, whose new source integration TASK is ready. F2 next task is V1 read-only production preflight after archiving this completed TASK. No production actions.


## F6 Opus PRIMARY both-cycle — 2026-10-13
- New F6 `common-ai-f6-opus-primary-both-integration-20261013` **ready/claude**, **Opus5.5（高）**, F6→L6, return 共通AI基盤のちゃ. Prior F6 close-only task archived at `.agent_v2/archive/2026-10-13-f6-opus-primary-close-v0.md` with matching blob/read-back and HISTORY_INDEX updated.
- F6 to implement only provider-owned primary_both changes for morning/close (derived from F2 `F2_PRIMARY_BOTH_F6_HANDOFF.patch`) in NEW Draft PR stacked on F2 PR173. F2 PR173 `review_required` waiting F2ちゃ L2, so protected F2 handler/tests remain untouched. F6 owns this project's AI code; any F2 code adjustment routed by handoff to F2ちゃ.
- Today close Opus and next morning remain targets but **not yet live**: neither PR170 nor PR173 merged, no verified Supabase Secret/deploy/feature flag; $5 trial monthly cap unchanged. F6 source/QA only until dedicated production gate. Manual OFF restores OpenAI; no automatic fallback required by user.



## F5 Phase6 — POSTONA cleanup / service-deletion source (2026-10-13 JST)
- NEW F5 `common-account-f5-phase6-postona-provider-cleanup-service-deletion-20261013` **ready / claude**, Opus5.5（高）, F5→L5, return 共通アカウントG5のちゃ（新F5担当）. Prior completed F5 Phase5 TASK+Report archived with manifest, SHA256, restore-readback and HISTORY_INDEX.
- F5 owns G5 adapter registration and EXECUTE candidate, service_deletion lease/fencing, `local_removed_remote_unverified` consent policy and precise F4/F3 contracts. Stack new Draft on F5 PR165 (currently HEAD `4638891f6c7ff432e08d462019594e1ec3d66f07`); G5 PR121/152, F4 PR167/169, H5 PR159 protected.
- F3 X authority/booking and F4 Threads writer/cleanup are independently completed source TASKs and not modified here. F5 may use read-only source overlay, no source/slot reassignment to F3/F4. J1 Sol（高） integrated review after compatibility source, not assigned yet.
- All live X/Threads/Meta/managed Supabase/Vault/migrations/GRANT/merge/deploy/posting gates remain NO_GO. Remote authorization cannot be marked revoked without evidence.

## F2 — Opus Primary 朝刊・大引け対応（2026-10-13 JST）
- PR170→173→175→176 は 2026-10-13 15:42〜15:43 JST に main へマージ済み。market-report-analysis v33 は 15:44 に deploy 済み。今日の大引けは Opus で完成（F2 の 16:24 の読み取り）。
- 本番の Cron: 朝刊 07:55（再試行 08:05）、大引け 16:20（再試行 16:35）。X の予約は 08:20 / 17:00、個別レポートは 08:35 / 17:15。
- 利用側のゲートは X・アプリとも OFF。Opus のレポートは、まだ利用者に届かない。
- 月 $5 の上限では、朝刊・大引けを毎日続けられない。見直しは別承認（F6）。



## F6 Opus PRIMARY 大引け V0 — 2026-10-13 JST
- User wants today's 2026-10-13 close report generated by **Claude Opus5.5 as PRIMARY** rather than shadow. Pre-release delivery failure acceptable; **automatic OpenAI fallback deferred**. Morning legacy OpenAI unaffected. User did not authorize unsafe secrets, unbounded spend or unreviewed DB/Edge deployment.
- New F6 `common-ai-f6-opus-primary-close-report-v0-20261013`: ready/claude, recommended **Opus5.5（高）**, start F6→L6, return 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）. Source/test first for close-only flag OFF by default; preserve schema, budget ledger and validation. Coordinate G2/F2 ownership of handler and independent worktree; stop if overlap. Live production gate/authorization separate.
- G2 PR143/149 are merged as of latest check. Common AI shadow stack PR148→150→153→157→162 remains Draft/unmerged. F6 must not treat it as ready Primary. No real paid API, production write/deploy/secret mutation performed by this allocation.



この文書には、現在有効な情報だけを置く。解決済みの問題、過去の完了解説、K / L / C / V判定の全文は書かない（完了作業は `HISTORY_INDEX.md` と `archive/` へ）。古くなった項目は追記ではなく書き換えて消す。

- 更新: 2026-10-12 JST（PR #155 merge後の状態に更新）

## POSTONA G3 → F3 新規TASK移行（2026-10-12 JST）

- 旧G3 `postona-g3-x-reservation-api-client-wiring-offline-v1-20261012` はK3受入済み `done/none`。旧G3で完結し、旧TASK/Reportは`.agent/tasks/CLAUDE_TASK_3.md`にそのまま保持。PR145→151→163はsource-only Draft/未マージ、PR163 head `9359e949d0704c08653a4d61dd5791f4d4febec9` を割当時確認。旧G3へ新規TASKは置かない。
- ユーザーのF3明示指定で**別task_id** `postona-f3-x-reservation-live-boundary-source-integration-20261012` を`.agent_v2/tasks/F3.md`に `ready / next_owner claude` 登録。推薦`Opus5.5（高）`、開始F3→完了L3、返却先`POSTONA G3のちゃ（新F3担当・AI自動投稿／X予約担当チャット）`。
- 目的：旧G3の予約API/画面の上に本物のEdge/Auth/DB接続**ソース**を実装し、G5/F5 entitlement・lifecycle とG4 X本人確認の未完成部分をdefault DENYで分離。F4 Threads、F5共通Auth、H5 owner-runtimeと変更ファイル/branchを分離。独立worktree・PR163上に新しいDraft PRを作り、PR145/151/163はそのまま保護。
- Issue #131 X本人確認、G5/F5 live判定・本人Auth/DB接続と本番審査は未完。**本番予約保存/X実投稿/Edge deploy/DB migration/mergeはNO_GO**。必要な権限が揃ってからJ1〜J4によるSol（高）の統合セキュリティレビュー1回と別承認。
- 旧系統`.agent/`は未変更。新旧task_id二重割当なし。完全移行はしない。

## F1 AIに聞く V1 Phase A — L1 accepted (2026-10-13 JST)
- task_id `kabumori-f1-ai-ask-v1-phase-a-ui-contract-20261012` L1 PASS_SOURCE_PHASE_A, `done / next_owner none`. Draft PR #166 HEAD `83b51efcf3cdb207eb0bab4c6a8dddbc1f5352f4` source-only/unmerged. G1 previous unstarted task remains cancelled/done.
- 7 files: `src/app/ai.tsx`, typed pure contract, dev-only mock, answer card, 2 test files and API/security design. Claude-reported app 576/576 PASS, 402pt offline Simulator PASS; 375pt/device/prod bundle NOT_RUN. No real provider/API/user holdings, DB/Auth/Edge/EAS/merge/deploy.
- V1 user wants holdings + market/news grounded questions. **Phase B still needed** for actual working feature: JWT/RLS user isolation, guarded server provider with cost/usage controls, grounding/freshness/citations, privacy/consent, security review. Production still shows 準備中 until separately approved Phase B.
- F1 available for separately assigned new task after append-only archive and HISTORY_INDEX update. PR166 merge remains separate decision.

## J1 AIに聞く V1 Phase B0 独立レビュー割当 — 2026-10-13 JST
- F1 B0 `kabumori-f1-ai-ask-v1-phase-b0-security-preflight-20261013` L1で設計候補受入済み、done/none。設計 PR #171 head `0beda46186efe1db680909f369e2571609851d81` はDraft・未マージ。Phase A PR #166もDraft・未マージ。
- 新J1 `kabumori-j1-ai-ask-b0-independent-security-review-20261013` ready/codex、推薦 **Sol（高）**、開始J1 → 完了V1、返却先「かぶモリアプリG1のちゃ（新F1担当）」。J1はread-only独立設計レビューのみ（本人/Auth/RLS、根拠・注入、費用上限・冪等、同意・G6依存、D1-D8）。
- B1 server/client実装・本番API/DB/Edge・有料API・deploy・mergeは未承認。J1指摘の確認後、ユーザー判断と独立した別TASKで進める。

## F1 AIに聞く B0 J1指摘修正 — 2026-10-13 JST
- J1独立レビュー`kabumori-j1-ai-ask-b0-independent-security-review-20261013` V1=CHANGES_REQUIRED（P1×5/P2×3）、J1 done。Phase B1のDB/Edge/本番接続はNO_GO。
- F1過去B0 TASK `kabumori-f1-ai-ask-v1-phase-b0-security-preflight-20261013` L1完了の原本を `.agent_v2/archive/2026-10-13-F1-kabumori-f1-ai-ask-v1-phase-b0-security-preflight-20261013/` に保存。SHA256 `caf8d633603badce2e66710cb52c011362e3edfe862cd6b75734cf171e09aef0`、復元read-back確認、HISTORY_INDEX登録済み。
- F1新TASK `kabumori-f1-ai-ask-b0-j1-r1-r8-design-correction-20261013` ready/claude、Opus5.5（高）、F1→L1、返却先「かぶモリアプリG1のちゃ（新F1担当）」。J1 R1-R8を設計文書の新Draft修正PRで対応し、focused再レビューへ返す。PR166/171を保護。実本番・有料AI・Auth/DB/Edge・migration・merge/deploy変更は禁止。

## 移行の状態

- 新系統 `.agent_v2/` はPR #155のmainマージ（`4e80c79dc42c11fbc1ca105665514b0dd32842d3`）により有効。新F/J枠は新規TASKを明示割当した後に使用する。
- 移行期間中の現行正本は旧 `.agent/`（G1〜G10 / H1〜H5）。旧系統で進行中・完了確認待ちのTASKは、すべて旧系統で完結させる。
- 旧 `.agent/` の初回snapshot: `archive/2026-10-12-initial-migration/`（snapshot元 main commit `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`、33ファイル、SHA256照合・復元テスト済み）。完全移行前に最終snapshotを別TASKで取る。

## POSTONA F4 T13 — L4 source accepted (2026-10-13 JST)
- `postona-f4-threads-t13-authenticated-writer-integration-20261013`: L4 PASS_SOURCE_IMPLEMENTATION / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO; F4 done/none. PR169 Draft/unmerged HEAD `fd15430ddcd640c5c7389582f37f1b478fc7204c` stacked on protected PR167. 14 Threads-only files, T13/F5 owner-service guard for authenticated writer, disconnect after ended service, OAuth state/secret cleanup. Focused PG, Deno118, app53 PASS as reported by Claude (not rerun independently).
- Remaining: F5 G5 adapter registration/owner lease for service_deletion/remote-unverified policy and SQL guard-order confirmation; F3 X publish/schedule guard owner wiring; H5 managed owner/Auth, independent J1 Sol（高） integrated security review. All live gates remain OFF, no deploy/merge/managed mutation/test post. Before next F4 assignment archive current TASK/Report, verify hash restore and append HISTORY_INDEX.


## POSTONA F4 — L4 source accepted（2026-10-13 JST）
- F4 task `postona-f4-threads-disconnect-lease-safe-v1-20261012` done/none; L4 `PASS_SOURCE_IMPLEMENTATION / SECURITY_REVIEW_REQUIRED / PRODUCTION_NO_GO`. Draft PR167 HEAD `02fd1989303879979b137f8338f8bc6944f266b1`, base protected G4 PR154 `98287392327eabfd5092a3ba89dde51a2e8beff6`, 24 F4-owned paths, unmerged. Threads individual disconnect UI/Edge/SQL candidate, G5 stillOwned lease-aware cleanup source; gates OFF, actual Edge/DB/Meta not activated.
- Claude reported Deno118, app17+36, local PG focused and mutation checks PASS; ChatGPT inspected GitHub diff and PR metadata but did not independently rerun local suites. F4 complete for source only, next F4 TASK requires archive+SHA256+restore+HISTORY_INDEX.
- Outstanding production blockers: independent Sol（高） security review via available J1–J4 without changing existing slot tasks; G5 T10 actual registration/EXECUTE and service_deletion lease contract; G5 decision on local_removed_remote_unverified/acceptRemoteUnverified; managed Auth/Vault/owner/Meta credentials and explicit authorized pilot. No merge/deploy/production mutation, no real Meta deauthorize, no public post. G3 X and H5 runtime unaffected.

## かぶモリV1 ソース統合（2026-10-12 JST）

- ユーザー承認によりPR143→PR149→PR158を**通常merge commit**でmainへ順次マージ済み。GitHub read-backで3件とも `closed/merged=true`、base mainを確認。
- PR143 merge `c12b869bc422cf5eb6593006a1f352fc644c71eb`; PR149 merge `17edfd007e6a0922ee2b6c13a6e2016a995d209c`; PR158 merge `42c66e07d3517a40ae4c41192aaebcb9cb14beb3`。
- PR149/158は先行PRマージ後にbase mainへ変更し、差分をそれぞれ17件/3件と確認。source-only mergeであり、**production NO_GO**。managed DB/migration、Edge、Cron、実Expo push、EAS、課金API、アプリ公開は一切未実施。
- 次工程：別承認で本番read-only事前確認、その後セキュリティゲートと段階導入計画。旧自動個別レポートの本番停止は未確認・未実施。

## G1未開始TASK取消 → F1新規割当（2026-10-12 JST）
- ユーザー明示指示「f1に入れ直して」。旧G1 `kabumori-g1-ai-ask-v1-phase-a-ui-contract-20261012` は未開始（ready/Report pending）で明示取消 `CANCELLED_UNSTARTED`、旧TASKとACTIVEはdone/none。旧TASKは旧系統に保持し、新旧二重開始を禁止。
- 新F1 `kabumori-f1-ai-ask-v1-phase-a-ui-contract-20261012` は独立した新task_id、ready/claude、推薦Opus5.5（中）、開始F1・完了L1、返却先 かぶモリアプリG1のちゃ（新F1担当）。対象はAIに聞くV1のオフラインUI＋安全API契約Phase A。3入口の開発用fixture、保有銘柄・市場/ニュースへの質問UI、情報鮮度/出典/データ分離/費用設計のみ。
- G2/G5/G6/G8/G9、他G/F/Jのファイル・worktree・本番境界は保護。実API・Auth/RLS/DB/Edge・secrets・有料API・EAS・merge・deploy禁止。Phase Bは別TASKと独立Security review。F1の作業開始前にfresh main・worktree競合を再検証。

## プロジェクト別現状

- F2は primary_both のテストの整合の TASK を完了報告済み（review_required、L2 待ち、Draft PR #176）。F8にニュース改善A J1-a診断TASK `news-improvement-a-jp-official-diagnostics-j1a-f8-20261012` を割当済み（ready/claude、L8返却、Sonnet5高）。その他の新系統枠は割当前の状態を各TASKで確認。
- かぶモリアプリ、X自動投稿アプリ（POSTONA）、共通アカウント、共通AI基盤、MIC、ニュース改善などの現状は、旧 `.agent/CURRENT_STATE.md` と旧各TASKが正本。

## G8 → F8の新規TASK移行

- 旧G8のJ0はK8で受入済み。旧G8の未開始J1-a（task_id `news-improvement-a-jp-official-diagnostics-j1a-g8-20261012`）は明示キャンセル・done/none。F8には**別task_id**でJ1-aを新規登録、旧G8との二重開始禁止。
- F8 J1-a L8（2026-10-13）PASS_SOURCE_FIXでsource完了。PR164 Draft、理由キー上限40（other込み）と集計飽和をソース確認。F8はdone/next_owner:none。PR164 merge/deploy未実施・本番NO_GO。次J1-bをF8に置く前に完了TASKのarchive/SHA256/restore/HISTORY_INDEXを必ず実施。PR116/129とG9保護。

## 共通アカウント G5→F5 新規TASK
- 旧G5 `common-account-g5-phase4-h4-c4-r1-r2-repair-20261012` はK5受入済み・done/none、旧系統のまま完結（PR152修正head `ccea1fe8132c6f573a768f0df5a033a05c62ef2c`、依存PR121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`）。旧TASK/ReportをF5へ複写しない。
- F5の新規task_id `common-account-f5-phase5-app-auth-entitlement-integration-20261012` を明示割当、`ready/claude`、推薦 `Opus5.5（高）`、開始F5・完了L5、返却先 `共通アカウントG5のちゃ（新F5担当）`。
- 既存Phase1/2開始・再登録のRPCを再利用し、本人共通ID＋サービスentitlementのG5-owned backend接続部分だけ実装。G1/G2アプリUI/Auth、G3/G4 POSTONA/Threads、H5 transport等は所有者保護し、別slotへの正確な接続依頼に分離。全てsource/offline、PR121/152未merge、本番 Auth/DB/deploy/実SNSはNO_GO。

## 未解決問題

- 解決済み: PR143のGitHubマージ可否表示は古いmainに対するものだったが、実際には通常マージ成功。旧記録: 試しのマージが古い main `50a2e079` の上のまま再計算されていないため。今の main `3c590d40` に対して、手元で PR143→149→158 を順に当てて衝突0件。マージは L2 の確認のあと、通常のマージで、間で後ろの PR の base を main に付け替えて進める（`delete_branch_on_merge: false`）。本番は NO_GO。
- 旧系統の未解決問題は旧 `.agent/CURRENT_STATE.md` と旧各TASK / Reportを参照する。

## production安全制約（現在有効）

- production の DB / Auth / RLS / migration / Edge Function / secrets / Cron / workflow / 実投稿 / 有料API は、各TASKの明示承認と安全ゲートが無い限り操作しない。
- 共通アカウント（旧G5）の優先は「競合したときに優先」であり全体停止ではない。同じDB object・RPC・Auth / RLS・Edge・settings・workflow・API境界に重なる場合だけ待つ。同一Supabase DBのDDL / write区間は直列化する。
- production mutation window は実writeの直前に開き、read-back後すぐ閉じる。各TASKヘッダーの `production_mutation_window: ACTIVE` と、その境界を確認してからproductionへ書く（新旧両系統のTASKを確認する）。
- 秘密情報（`.env`、APIキー、token、Cookie、秘密鍵）は表示・commit・ログ出力しない。

## 未マージPR

- F2: Draft PR #173（handler、base は PR170）と Draft PR #176（テスト、base は PR175）。どちらも未マージ。旧G2 PR143/149/158は3件ともmainへマージ済み。
- 新系統導入PR #155はマージ済み。旧系統の未マージPRは旧CURRENT_STATEとGitHubを参照する。

## deploy待ち

- 新系統としては無い。

## slot競合

- F2は `market-report-analysis/handler.ts`（#173）と `opus_primary_handler_test.ts`（#173・#176）を変更中。F6 の `market_report_primary.ts` は F6 の担当（#175）。F6 の仮の適用が、作業場所 kabumori-g6-qa-20261012 と kabumori-f6-handler-patch に、コミットされずに残っている（中身は差分の結果と同じ）。shadow の PR #153 も handler.ts を変えるので、後から入る側で調整が要る。
- 移行期間中は、旧Gn / Hn と新Fn / Jn が同じ境界を同時に変更しないよう、TASKを置くときに新旧両方の索引を確認する。

## 現在有効な運用判断

- 旧系統: G1/G2=かぶモリアプリ、G3/G4=X自動投稿アプリ（POSTONA）、G5〜G10=明示割当専用。H1〜H4=レビュー枠、H5=Codex臨時実装専用。単独 `F` は新旧30枠の統括。
- 新系統: F1〜F10は旧G1〜G10の後継枠、J1〜J4はレビュー枠、J5は臨時実装の優先枠（ユーザーの明示指示があればJ1〜J4も実装可）。
- 旧系統で開始したtask_idは旧系統で完結させ、新系統へは次の新規TASKから移す。
- Codexレビューの要否と時期は「レビュー最適化方針（2026-09-25〜）」に従う。レビュー省略時も実証確認は減らさない。

## 次工程

- F8で国内ニュースJ1-aを実装、L8で本チャットへ報告（Sonnet5高、production NO_GO）。
- F2の PR #176 を L2 でレビュー。そのあと #170→#173→#175→#176 をまとめて merge するかを、共通AI基盤のちゃと決める（別承認）。本番 NO_GO。

1. 旧系統の各slotが完了した時点で、ChatGPTが次の新規TASKを新系統へ置くかを判断する。
2. 初回の新系統TASK完了時にarchive / MANIFEST / SHA256 / HISTORY_INDEXの保存運用を確認する。
3. 完全移行の条件が揃ったら、最終snapshotと完全移行を別TASKで行う。
