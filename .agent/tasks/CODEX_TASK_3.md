# H3 CURRENT TASK — POSTONA Threads OAuth＋手動投稿 統合Auth/SQL重点レビュー（独立・READ ONLY）

- task_id: postona-threads-pr144-auth-publish-p1-security-review-h3-20261012
- owner: codex
- slot: codex-3
- status: review_required
- next_owner: chatgpt
- start_code: H3
- finish_code: C3
- completion_code: C3
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Sol（高）**
- type: **ONE focused independent source/security review — REVIEW only, not 臨時実装**
- target: [Draft PR #144](https://github.com/anohi-memories/kabumori/pull/144) exact HEAD **`d4a1e87b77d1fbd362dc51809ce2d998afda15ea`**, base Draft PR140 `2e75a6a842e70f3de78558681803b60935fb4251`, 24 changed G4-only files, OPEN/DRAFT/UNMERGED
- protected PRs: #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`, #135 `e38788d6677082138f0990453c7d2f00549666d0`, #139 `b4fa672f97592e87682671454e868a92098cbd56`, #121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`; all unmerged Draft/source candidate
- current release decision: G4 K4 **PASS_SOURCE_CANDIDATE / BLOCKED_REAL_PILOT**; no actual OAuth/Meta/GoTrue/Vault/DB managed proof; no live feature gates enabled, no public posting or deploy authorized
- changes_forbidden: product files, PR branches, migration apply, GRANT, RLS, Auth/Vault secrets, external Meta/Supabase/X APIs, real posts, paid calls, PR merge or deploy
- allowed: isolated source read, mock Deno/fake PostgreSQL tests and H3 TASK/Report/ACTIVE section/CURRENT_STATE bookkeeping only

## Why this review is now necessary

G4's source PR144 changed security-critical `SECURITY DEFINER` functions, principal+session authorization, grant issuance and token Vault custody, not merely UI. Prior K4 P1: PR140 `service_role` voucher `redeem_threads_manual_publish_step` could release a token after user/entitlement revocation. PR144 replaces caller claim + `service_role` redeem/record functions with caller-JWT `release_threads_manual_publish_step` and `record_threads_manual_publish_result` HMAC attestation and nonce. G4 reports disposable PostgreSQL negative tests/mutation8, combined Deno176, focus Deno93 and app258 PASS; **these are developer reports only**. Confirm whether the actual new ownership/auth boundary is safe; do not certify production based on mocks. Focus on P0/P1/P2 real bugs and proof gaps; do not spawn repeated UI review or generic TODO audit.

## Preflight and worktree

1. Read latest `PROJECT_RULES.md`, `AGENTS.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this H3 TASK/Report (preserved prior G2 C3 history below), G4 latest K4 TASK/Report, H5 C5 Report, G5 latest TASK. Fetch **fresh origin/main** and exact PR #144/#140/#139/#135/#124/#121 heads/base/files. Note: H4 has been allocated in ANOTHER chat to News PR129 and must not be used/altered; H1/H2/H5 and G3/G5 independent ownership protected. If head moved or PR conflict, report exact drift before adjudicating.
2. New physically independent H3 checkout/worktree; NO sharing other slot worktrees/dev servers/PG clusters/ports; cannot edit/check out/rebase someone else's live branch. Use read-only refs, a local H3-only disposable composite copy and fake PostgreSQL 17 socket if available, never production DB or real Auth/Meta. If no isolated environment, STOP with BLOCKED.
3. This is a **read-only independent review**. Product source edits/commits/push PR comments prohibited. Report evidence with exact path:line/commit, actual test output vs developer-claimed tests and NOT_RUN reasons.

## High priority adversarial boundaries

**S1 — Critical live privilege/TOCTOU**. Review PR144 new `supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql` plus PR140 `threads_manual_publish_candidate.sql`: confirm old `claim/redeem/record` are actually dropped (including inherited PUBLIC EXECUTE / nonfunction REST paths); new release/record functions have effective correct EXECUTE grants, ownership and SECURITY DEFINER locked search_path, current user `auth.uid()` from authenticated JWT, session row from `auth.sessions` (lock against deletion/refresh) and real G5 `private.account_lifecycle_assert_active_service_write(uuid,'x_autopost')` same-transaction fence. Verify no cross-user/brand/X socialAccount or revoked member owner/admin, no wrong service entitlement, no bare service_role principal forging. Check G5 T13 function's SQLSTATE 42501 mapping. Test user deleted/deactivated, service ended/suspended/deletion race, member downgrade/removal, revoked per-account manual consent, wrong workspace `code_profile_key`, stale provider token, grant replay/late return, concurrent writer. **Call out gap between release COMMIT and Meta HTTP** as a bounded residual risk; never claim DB locks cover the network call.
**S2 — HMAC/proof integrity**. Compare `supabase/functions/social-mobile-threads-publish/http.ts` HMAC exact message bytes/nonce/userId/attempt/step/results with SQL `release_threads_manual_publish_step` and `record_threads_manual_publish_result`. Check signature provenance (server `/auth/v1/user` vs caller bearer) and no JWT decoded as authority, nonce replay, TTL skew, grants bound session/account, no client obtainable attestation secret/Vault token, constant-time concerns, log/HTTP/exception leakage, rollback/uncertain outcome behavior and 2-write Threads duplicate controls. Confirm no alternative route bypasses privilege proof.
**S3 — Token expiry and H5 boundary**. Review `supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql`, owner-only writer/read contract, real PR124 verified connection, H5 PR139 `complete` compatible with `record_threads_credential_custody(account,expires_at)` *same DB transaction*, `verified_at=now()` precision/reconnect/rotation/secret-id binding; NULL/expired refuses, 5min buffer. Check managed Auth schema privileges/roles, actual owner transport not yet provisioned and remaining T10 G5 provider-aware deletion/orphan token risk. Don't edit G5/H5 files to force a PASS.
**S4 — End-to-end simulation fidelity and safe flags**. Inspect the G4 combined runner `supabase/tests/postona_threads_integration_run.sh` that copies actual pinned protected PR124/135/139 and G4 PR140 candidate into local copy, G5 T13 MOCK_ONLY not managed proof, `postona_threads_release_run.sh` negative cases/8 mutations; verify no misrepresented live functionality. Check original Threads connect false, manual publish server false, mobile UI two flags false, Edge returns 503; actual account-scoped permission and verified Meta-owned readback; unknown publish result MUST NOT retry. No touching G3 reservation, old X OAuth hardening Issue131 or X dispatcher.

## Verdict and handoff

- Give one `PASS_SOURCE_SECURITY_REVIEW / REAL_PILOT_HOLD`, `CHANGES_REQUIRED / REAL_PILOT_HOLD`, or `BLOCKED_REVIEW`. If P0/P1/P2: exact source:line + reproducible mocked input/SQL negative proof, severity, impact and MINIMAL correction owner. Avoid vague speculative blockers and repeated broad audits.
- Report explicit managed/real proof NOT_RUN separate from developer-reported fake results; one prioritized owner-dependent rollout matrix: G5 T13/T10, H5 owner/GoTrue/callback/custody, G4 publish/release, Meta operator/app/tester. Production merge/DB apply/Edge deploy/feature flags/one real Threads test post still require separate review/preflight and user approval; this source-only verdict is never production GO.
- Only update this H3 task and `.agent/CODEX_REPORT_3.md` preserving complete G2 historic task/report verbatim, H3 own ACTIVE_TASK and relevant CURRENT_STATE via guarded SHA; when actually finished `review_required/next_owner:chatgpt` and return exact `C3`.
- Fields required in H3 report: task_id,result,reviewed_pr_sha,changed_files,tests,commit_hash,push,merge,deploy,remaining_issues,safety_checks,next_recommendation,return_to,completion_code.
- **H3 is freed after C3** (no parked integration backlog; separate explicit TASKs for G4/G5/H5).
- Last line of Codex completion: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ へ C3 を送ってください。**

---

## H3 completion — 2026-10-12 JST

CHANGES_REQUIRED / REAL_PILOT_HOLD on exact PR144 d4a1e87b77d1fbd362dc51809ce2d998afda15ea. One P2 R1 session expiry UPDATE race independently reproduced on PG17; local FOR SHARE control blocks it. Deno93/composite176/app258 and supplied SQL/mutations PASS. See `.agent/CODEX_REPORT_3.md` for evidence, limits and owner matrix. Product edits0 / production0 / real API0. Return C3 to POSTONA｜マルチSNS化・開発統括（G4）のちゃ.

---

## Protected entire previous H3 TASK (historical, no active G2 assignment)

# H3 CURRENT TASK — かぶモリ G2 オンデマンド個別AI分析 PR143 重点独立レビュー（READ-ONLY）

- task_id: kabumori-pr143-ondemand-queue-auth-security-review-20261011
- owner: codex
- slot: codex-3
- status: done
- next_owner: none
- c3_verdict: REVIEW_COMPLETE / CHANGES_REQUIRED_P2_EXPIRY_FENCE / PRODUCTION_NO_GO (2026-10-11; H3 58 targeted offline PASS, disposable PG NOT_RUN)
- start_code: H3
- finish_code: C3
- completion_code: C3
- return_to: かぶモリアプリG2のちゃ
- recommended_model: **Sol（高）**
- classification: high-risk independent source/security + queue/idempotency review (no implementation)
- review_target_pr: https://github.com/anohi-memories/kabumori/pull/143
- exact_review_head: 1d0529bb68b0e60b32ce0a2cb0002872b1671177
- target_branch: g2-ondemand-v1-20261011
- target_base: main
- original_G2_TASK: kabumori-personalized-ondemand-background-push-v1-20261011
- g2_k2_verdict: PASS_SOURCE_CANDIDATE_WITH_BROADCAST_BLOCKER / PRODUCTION_NO_GO
- return_to_is_exact: true
- prohibited: PR merges, deploy, production DB/Cron/Auth/write, real provider API/X/Expo, G2 or other slot source edits

## Purpose and review policy

ユーザーの製品決定は「市場全体の朝刊・大引け・重要ニュースは共通で自動提供、個別AI分析は本人がボタンを押した時だけ依頼、アプリを閉じても独立したサーバーが処理、結果は本人に保存＋完了push」。月額課金・Opus/Haiku選択は**将来案**であり現時点で有効化しない。現行の個別全員分定時Cronも、本番ではまだ稼働したまま。Draft PR143はsource-only候補（30 paths/2 commits）で、migration/Edge/Cron/アプリの本番適用はゼロ。先代Draft PR141は自動個別生成時代のSUPERSEDED候補、変更・マージ禁止。

G2が使い捨てPG17のRLS/ACL/並行処理/rollback/13 mutation、Deno+app 1,616 tests PASSを自己報告。ChatGPTはsource/readbackを一部独立確認したがコマンドは未実行。PR143 Vercel status failureはbuild-rate-limit、Netlify preview success、production CI greenとは扱わない。**H3は重大な不具合・権限事故・本番混線の可能性だけを重点検証する一回の独立レビュー**。UI文言や低重要度の正規表現などの修正無限ループを始めない。

## Before H3 starts

1. `PROJECT_RULES.md` / `.agent/ORCHESTRATION.md` / `CURRENT_STATE` / `ACTIVE_TASK` / 当H3 TASK / H3 Report / G2 `.agent/tasks/CLAUDE_TASK.md` 最新先頭 Report、[PR143](https://github.com/anohi-memories/kabumori/pull/143) の差分を読む。PR headが `1d0529bb68b0e60b32ce0a2cb0002872b1671177` から動いていたら、追加差分確認前にSTOP/REPORT。
2. latest origin/main、専用の**H3独立worktree/checkout**と既存他slotのworktree/branch/変更対象競合を確認。他slotのcheckout/reset/rebase、dev server停止、dirty files変更/stageを禁止。安全な独立環境が無ければ開始禁止。
3. ソースとオフラインテストを読み、重点の1〜7について証拠（file:line、再現可能ならテスト）を返す。H3は基本**read-onlyの独立レビュー**。製品ソース、PR143/141、G2 TASK、他slot PR・branchの変更・PRマージ禁止。軽微なテスト補助が必要ならH3専用checkoutで一時実行のみ、PRは作らない。

## Focus 1 — Auth / RLS / SECURITY DEFINER

- `supabase/migrations/20261011150000_personalized_ondemand_analysis_v1.sql`: `request_personalized_analysis` が認証済本人 `auth.uid()` 以外を信頼せず、他人の依頼・情報取得/操作/通知を拒否するか。
- 非認証、別ユーザー、service_roleのRPC代行、`get_app_market_report` の認証・公開フィールド・completed/Fact/日付境界を確認。SECURITY DEFINER search_path / grant・revoke の default PUBLIC EXECUTE / PostgREST exposed schemaに抜けがないか。
- `personalized_analysis_jobs/results` の**column GRANT + RLS** が実際に同じuserの非機密列だけを返し、lease_token/provider費用/別ユーザー履歴を漏らさないか。削除連鎖/G5 entitlement変更の責務は設計境界に留めて本件で別slotを触らない。

## Focus 2 — Atomic claim / worker concurrency / idempotency / leases

- 2端末連打・同じclient_request_idリプレイ・同一人active 1件・日上限5（課金枠ではない）。フェンスに token / version / expires_atを使い、expired workerの遅延成功/失敗/二重DB書き込みを拒否するか。
- `claim_personalized_analysis_jobs` の`FOR UPDATE SKIP LOCKED`・advisory lock・max_parallel_jobsが真にatomicか、再試行上限/backoffとworker max latency/edge timeoutが整合するか。試行中AI APIの再送による二重課金はDBフェンスだけでは防げない点の説明。
- 固定20人auto batchの永久starvation廃止、100/1000 jobの公平性、実際のlarge queue latency/throughput見積り（sourceとmockを区別）。定時個別Cronと新ゲートの同時動作・切替途中のdupeはないか。

## Focus 3 — Generated financial content and privacy

- 本人の保有/監視銘柄だけを使い、古い/未来の日足が当日の確定値と混ざらず、market basis`packet`とJST日付が正確か。古い市場パケット使用時の明示、注意書き、Fact policy（客観事実厳格・AI根拠ある分析自由）、`fact_status=passed`だけが完了公開か。
- `model_tier=standard`以外を拒否し、G6共通Provider/AI budget本番切替や決済回数を自動的に仮定せず、実際に使うモデル名はsourceから確認。無許可のAPI有料callなし。

## Focus 4 — Durable job and push lifecycle

- アプリを閉じても処理する設計は独立DB job+Cron workerか（`waitUntil`だけに依存しないか）。completed成功後に通知enqueue失敗しても本文は保存、再試行は通知**予約のみ**で不確実なpush送信の二重実行なし。送信側`send-push-notifications`の`source_type=personalized_analysis`処理・deep-link・通知を拒否したユーザーの結果保存。
- server-side retries, notification partial unique index, model spend recovery and errors with no secrets logs, job ID -> user RLS check at deep link。Expoリアル送信テストは不可、NOT_RUNと記す。

## Focus 5 — Common report availability and missing broadcast

- `get_app_market_report`は個別分析不要で市場朝/大引けを各利用者に表示できるか。市場共通feedのpublic gatewayとapp_enabledとの条件、週末/市場休みの直近7日表示、内部Fact status・根拠/モデル/コスト情報漏れを確認。
- **共通朝刊・大引けの全利用者向けプッシュは未実装**という既知のブロッカーを維持。通知購読設定、target選定、優先キュー、200件/分で1万人なら単純最低50分（1件/人仮定、追加ボトルネック考慮）といった別工程設計が必要。レビュー中にG3/G4や重要ニュースproducerを改変しない。
- 新方式の配信ON/旧Cron停止/新Cron起動/Nativeビルドは全部**未承認**。Runbookの順序・rollbackで欠配、重複、漏洩の危険がないか。

## Focus 6 — Concrete offline tests / evidence

- G2報告のSQL tests（`supabase/tests/personalized_ondemand_analysis_run.sh` + fixture/behavior/rollback）とDeno worker/legacy/app testで、独立checkoutから安全に実行できる範囲を実行。使い捨てDBは**ローカル新規一時DBのみ**、ホスト/DB target厳格検証・production secrets不要。環境が足りなければ NOT_RUN と明記し、静的検証で代替。ユーザーデータ・外部API・本番Supabase接続は厳禁。
- 追加テストは重大なrisk-only（cross-user, leak, double expense, race, rollback）。13 mutation検出はG2報告であって自分の独立実行とは区別する。勝手に仕様を変えたりsource patchをpushしない。

## Focus 7 — Findings classification / stop conditions

- P0 / P1（DB/RLS/Auth/queue/決済ないし市場Fact/通知結果の重大なバグ）を優先し、`file:line` + evidence +最小修正案を提示。再現できない推測はそのまま“懸念・未検証”と明記。P2は必要なものだけ。
- `PASS_SOURCE_REVIEW_WITH_KNOWN_BLOCKER`、`CHANGES_REQUIRED`、`BLOCKED_VERIFICATION`のいずれか。PR143を未マージのまま維持。製品ソース編集0・外部API0・production0。
- Reportを`.agent/CODEX_REPORT_3.md`の**先頭に追記**（過去の未割当テンプレート履歴を残す）し、自己のTASK `status: review_required` / `next_owner: chatgpt`、ACTIVE_TASKのH3節とCURRENT_STATEのH3記録だけ更新。必須項目：task_id/result/changed_files/tests/commit_hash/push/merge/deploy/remaining_issues/safety_checks/next_recommendation/return_to/completion_code。返却は C3、G2チャットへ。
- ユーザー向け末尾には厳密に **「かぶモリアプリG2のちゃ へ C3 を送ってください。」**。返却先の推測や省略は禁止。

## Report

H3 review complete: CHANGES_REQUIRED / PRODUCTION_NO_GO. See `.agent/CODEX_REPORT_3.md` H3 FINAL entry. Return C3 to かぶモリアプリG2のちゃ.

---

## Previous H3 unassigned template — preserved verbatim

# Codex Task H3 — UNASSIGNED TEMPLATE

- task_id: none
- owner: codex
- slot: codex-3
- status: idle
- next_owner: none
- start_code: H3
- finish_code: C3
- completion_code: C3
- return_to: none（未割当。割当時にChatGPTが必ず記入）
- recommended_model: none
- report: `.agent/CODEX_REPORT_3.md`

## Purpose / allocation

未割当のCodex枠（2026-10-11追加）。H1〜H5は固定プロジェクト専用にしない。主用途はClaude実装後レビュー、バグ調査、バグ修正、回帰確認、テスト追加、DB / API / RPC / Edge Function境界確認、Auth / Security確認、deploy前確認。臨時実装は必要時のみ、TASKに「臨時実装」と明記された場合だけ行う。

このテンプレートの追加自体は作業割当ではない。現時点のScope・完了条件・実行権限は未設定。

## Before assignment（ChatGPT）

- statusだけで空き判定せず、task_id・TASK本文・Report・next_owner・ACTIVE_TASK・CURRENT_STATE・fresh `origin/main`を確認する。
- 既存TASK/Reportと他workstreamの変更を保護し、変更対象の非競合と専用の独立worktree/checkoutを確認する。
- 割当時にtask_id、目的、対象branch/commit/PR、重点確認事項、変更禁止対象、テスト、安全制約、完了条件を記入する。
- 割当時に冒頭ヘッダーの `return_to`（ユーザーが `C3` を送るちゃの部屋の人間向け名称。G番号だけにしない）と `completion_code: C3` を必ず記入する。
- 割当時に推薦モデルを必ず設定する。候補：Luna（中）/ Luna（高）/ Luna（極高）/ Sol（中）/ Sol（高）/ Sol（極高）。未割当の間はnone。

## Start / H3

`PROJECT_RULES.md`、`HANDOFF.md`、`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、このTASK、`.agent/CODEX_REPORT_3.md`、Git状態とfresh `origin/main`を確認する。

statusが `ready` / `in_progress` の場合のみ `H3` で開始する。`idle` / `done` / `review_required` では開始しない。

H3専用の独立Git worktree/checkoutを `/Users/yuya/Developer/kabumori-fresh` の fresh `origin/main` から作成して使用する。安全な独立環境を用意できない場合は開始せず停止する。他slotのbranchをcheckout/reset/rebaseしない。他workstreamの未コミット変更を変更・削除・stage・commitしない。他slotの作業ファイルやdev serverを停止・再起動しない。

## Scope / tests / completion criteria

未設定。割当時に具体化する。割当がない間は変更・テスト・push・deploy等を開始しない。

## Completion / C3

完了・停止時は `.agent/CODEX_REPORT_3.md` へ報告を記録し、このTASKのstatus / next_ownerを更新する。Reportには通常項目に加えて `return_to` と `completion_code` を含める。

ユーザー向け最終報告の末尾には必ず「返却先」を置き、TASKの `return_to` をそのまま使って「`<return_to>` へ `C3` を送ってください。」と表示する。返却先は推測しない。`return_to` / `completion_code` が欠落・不明・矛盾・不一致（`C3` 以外）の場合は「返却先未確定 — ChatGPT確認待ち」とし、理由を明記する。

`C3` はH3専用の完了確認コード。ChatGPTが対応TASKとReportを評価する。未実施を成功扱いにしない。

