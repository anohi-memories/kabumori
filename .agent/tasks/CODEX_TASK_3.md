# H3 CURRENT TASK — かぶモリ G2 オンデマンド個別AI分析 PR143 重点独立レビュー（READ-ONLY）

- task_id: kabumori-pr143-ondemand-queue-auth-security-review-20261011
- owner: codex
- slot: codex-3
- status: review_required
- next_owner: chatgpt
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
