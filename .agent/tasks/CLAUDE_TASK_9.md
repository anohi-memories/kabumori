# Claude Task G9 — API最適化B R3：PR #115の権利安全な置き換えDraft PR準備

- task_id: api-optimization-b-g9-r3-clean-history-provider-compare-replacement-20261011
- owner: claude
- slot: claude-9
- status: done
- next_owner: none
- start_code: G9
- finish_code: K9
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Opus5.5（高）
- allocation: このチャットのAPI最適化B専任G9だけを使用。G8ニュース改善Aおよび他G/H・別案件に触れたり自動引継ぎしたりしない。
- operation: オフライン評価用比較ツールの履歴を汚染しない新規Draft PR準備（旧PR115の書換・閉鎖禁止）。
- work_authorization: ユーザーの「次は？」によりこのチャットでBの次工程を決定。既存PR115を無断で更新/closeする承認ではない。
- budget: paid API 0 / 無許可外部送信0 / production mutation 0

## 目的・判断

G9 R2のK9は `PASS_OFFLINE / EXTERNAL_CALLS_RELEASE_HOLD`。G9既存branch
`claude/g9-fixture-rights-cost-eval-20261011` head `65c95589564845e7b343fe9d0acc7d293bebf783`
には `external_send_gate.ts`、rights_safe fixture、評価コスト基準、テストが完成。
一方、Draft [PR #115](https://github.com/anohi-memories/kabumori/pull/115) の
`tools/provider-compare/fixtures/cases.json` にTDnet 11 / Al Jazeera 3 / BBC 2 / AP 2、
計18ケース分の権利未確認の原文が含まれ、関連過去のB branchのGit履歴にも残る。
現在のPR115をそのままmergeするとmainにこの内容が入るため、今回の狙いは
**クリーンな最新mainから別ブランチを作り、第三者本文を一切含まない最終コードだけを載せる**こと。

現時点の参考資料:
- `docs/model-optimization/PR115_BODY_REMOVAL_MIGRATION_PLAN_2026-10-11.md` （G9 R2 headに存在）
- `docs/model-optimization/G9_R2_EXTERNAL_SEND_GATE_AND_LICENCES_2026-10-11.md`
- `docs/model-optimization/G9_FIXTURE_RIGHTS_AND_COST_BASELINE_2026-10-11.md`
- PR115: 2026-10-11確認時 OPEN/Draft, head `8f4305574d1895a9f3b45c91470792bed7edb774`。PR129はA/G8が所有し、最新head `7bf9b8a0`。PR116本番は別作業。
- G9 R2はDeno 299件PASSと報告（ChatGPTの独立実行結果ではない）。

## 実行前のガード

1. `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`,
   `.agent/CURRENT_STATE.md` とこのTASK/過去Reportを確認し、G9が`ready`で同一TASKを持ち他ownerがいないことを照合。
2. fresh `origin/main`、PR115 head/差分、G9 R2 head、Git worktree/checkout、他slotの変更対象を確認。専用の新しい独立worktreeを作る。mainに `tools/provider-compare` が既に存在するなどの重複・他セッションと競合があれば自動移植せず停止・報告。
3. `G9` の作業だけ。G8のPR129、PR116固定本番worktree、他G/Hのbranch/TASK/Report/worktree、他案件・DB/Edge/Cron/Secrets/API実行に触れない。
4. PR115のownershipは共有アカウントで不明、現時点では**PR115ブランチを更新・rebase・force push・close・削除しない**。既存G9 R2ブランチも履歴書換・force pushは禁止。

## 実装作業：クリーンな置き換え

1. **履歴の分離が最重要**: 最新 `origin/main` を唯一の親とする新規ブランチを作る。過去PR115、Phase5、G9 branchのcommitを `merge / cherry-pick / rebase` **しない**。Gitへ書く前に、安全なsource treeにコードだけをコピー/再構築して履歴を切る。新しいPR/branchの ancestry に過去の `cases.json` 本文入りコミットが一件でも混入したら作成/更新を禁止。
2. `tools/provider-compare/` と `docs/model-optimization/` のBに必要な最新成果だけを再構築。旧 `fixtures/cases.json`（許諾未確認18本文）を**一度も新branchのGit indexへstage/commitしない**。代わりに `fixtures/cases.rights_safe.json` とbody manifest +空許諾台帳を採用。PR115/Phase5/G9由来の公表引用が別のJSON、fixture、ドキュメント、テストに混じらないか慎重に確認。判断不能な引用は削るか `needs_rights_review` として使えないようにする。
3. `loadCases()` の既定と `cli.ts`/probe/mock/runnerの本番送信対象は rights_safe に統一。旧 `legacy` 互換は、必要な場合のみ `.gitignore` 配下の明示的なローカルファイルから、オフライン専用で読む。外部送信時は legacy絶対拒否。DRY-RUN/テスト用の合成本文は権利確認済みの公的素材か**自作の完全合成テキスト**を利用。
4. 現行テストの `cases.json` 本文依存（`fixture_rights_audit_test`, `tasks_test`, `fixtures_test`, `metrics_test`, `eval_manifest_test`, `fixture_access_test` 等）を棚卸しし、**単にskip/削除して全PASSと見せない**。合成フィクスチャの注入、権利が安全な集計用スナップショット、ローカル原文がない場合の意味あるsafe fallbackへ置換。元の件数・監査/精度チェックをできるだけ維持し、数値やカバレッジに意味ある低下があれば報告。
5. `external_send_gate.ts` の fail-closed を保持: TDnet/AJ/BBC/AP 18件の外部送信はデフォルト拒否。ハッシュ一致やオペレータopt-inだけで解除しない。空許諾台帳、署名/根拠を持つ明示記録のみ将来受理。無料count_tokensも外部送信とみなす。本TASKは本物のライセンスを追加しない。
6. 新規branchの最終tree、git staged content、git log/ancestry、PR diffを機械的に検査し、**旧本文を追跡しないこと**を検証。旧ブランチ/PR115やGitHub refsの削除を主張しない。GitHubの内部キャッシュやPR refsからの完全消去は本TASKでは達成不可能として扱い、所有者判断待ちとする。
7. tests: `deno test --no-config -A tools/provider-compare/`（前baselineはG9 R2が299 PASS報告。変更に伴う差・理由を明示）、Deno check/lint, git diff --check, secret scan, fixture権利監査, 外部送信拒否テスト, 許諾台帳空を確認。**無料count_tokensを含めた外部接続や有料APIを一切実行しない**。
8. checkoutと最新mainに競合がなければ、**B専用の新ブランチにcommit/pushし、安全に作成できる場合は新規Draft PRを作成してよい**（PR #115への操作なし）。PRの説明には「PR115の権利安全な置き換え候補。PR115のclose/旧branch削除・GitHub歴史の消去は未承認、mergeも未承認、実AI比較/デプロイなし」を明記。PR番号/正確なshaを報告。安全な確認ができなければDraft PRを作らずBLOCKEDで返す。
9. **絶対禁止**: PR115のclose/変更、既存branchの強制push・履歴書換・削除、他G/Hへの実装再割当、main merge、Supabase DB/Edge変更、Secrets/Cron、provider設定変更、実Claude/OpenAI有料比較、本番運用切替。

## 完了・返却

- 新branchが最新main単独の子孫である。旧PR115/Phase5/G9 unsafe ancestorが入らず、treeに権利未確認18件の本文が残らない。
- 安全な評価比較tool・fixtures・gate・既存の重要テストが使え、スキップによる安全性欠落なし。元のPR115/Phase5/G9成果を失った箇所は明示。
- 新規Draft PRがあれば番号、head、差分範囲とリリース不可条件を提示。なければ理由と直し方。PR115はOPEN/Draft・未変更のまま。
- このTASK末尾 `## Report` に result, changed_files, tests, ancestry_checks, rights_checks, commit_hash, push, PR, merge, deploy, remaining_issues, next_recommendation, return_to を残し、**`K9` を「ニュース改善API最適化のちゃ」へ**返す。
- 同時に別案件やA/G8の進行・レビューはしない。

## K9 evaluation — ChatGPT, 2026-10-12 JST

- verdict: PASS_OFFLINE_BRANCH_READY / PR_NOT_CREATED / MERGE_AND_EXTERNAL_RELEASE_HOLD
- verified: G9 Report checked, remote branch `claude/b-provider-compare-rights-safe-20261012` exact `c476ef8a5c5a0294c3df8e4fefebc8722f2e1102`, sole parent `1a4b5f3802982853ecd79abb4bf3b977c678c36e`, main-derived single commit / 129 B-only newly added files. GitHub recursive tree not truncated, no `tools/provider-compare/fixtures/cases.json`. `cases.rights_safe.json` 22 cases: 2 with body, 20 with no body; `body_licences.json` entries=[].
- self_reported_tests: Deno 302 PASS / 1 ignored (legacy private input test; G9 says private rerun PASS), type/lint/diff/secret scans. ChatGPT did not execute Deno locally or independently scan private original 18 article bodies.
- required_remaining: G9's scanner reports three TDnet titles matching original article body starts (>=40 chars). G9 also reports two other **existing-main** files with overlapping original texts; neither belongs to this G9 task, and no other slot is being tasked automatically. The old PR115 and 3 old branches/refs still contain original text. Rights are unconfirmed. No claim of complete deletion or resolved legal permission.
- PR: No replacement PR was created because Claude's Create Public Surface operation was rejected by its safety system. ChatGPT has not worked around that gate or created a PR. Manual Draft PR can be opened by user with `https://github.com/anohi-memories/kabumori/pull/new/claude/b-provider-compare-rights-safe-20261012` after deciding how to handle title overlap. Original PR115 remains OPEN/Draft/unmodified. No merge/deploy or vendor API.
- decision: G9 R3 source branch accepted as offline replacement candidate. Status done, next_owner:none, **G9 remains API最適化B専任**. No automatic further TASK and no review H slot allocated. After a Draft PR exists, decide targeted review/release gate before any merge; never treat a new Draft PR as release authorization.

## Report

- task_id: api-optimization-b-g9-r3-clean-history-provider-compare-replacement-20261011
- result: PASS_OFFLINE_REPLACEMENT_BRANCH_READY / DRAFT_PR_NOT_CREATED（置き換えブランチは作成・push済み。Draft PR の作成は auto mode の権限拒否で未実施。有料API・実ネットワーク・本番アクセス・PR #115 への操作は0）
- finished: 2026-10-12 JST
- return_to: ニュース改善API最適化のちゃ（K9）
- worktree: `/Users/yuya/Developer/kabumori-g9-clean-replacement`（G9専用の新規独立worktree。旧 G9 worktree・他slotは未操作）
- branch: `claude/b-provider-compare-rights-safe-20261012`
- commit_hash: `c476ef8a5c5a0294c3df8e4fefebc8722f2e1102`（親 `1a4b5f3802982853ecd79abb4bf3b977c678c36e` = push 時点の `origin/main` の先頭。1コミットのみ）
- push: performed（新規ブランチを `origin` へ、`refs/heads/claude/b-provider-compare-rights-safe-20261012` として。既存ブランチへの push・force push なし。この Report は `.agent` の自TASKのみ）
- PR: **not_created**。`gh pr create --draft` を実行したが auto mode の分類器に「公開面の作成」として拒否された（TASK 本文は Draft PR 作成を許可しているが、実行環境側の許可が無い）。回避は試みていない。作成する場合の作成用URL: https://github.com/anohi-memories/kabumori/pull/new/claude/b-provider-compare-rights-safe-20261012 。PR 本文の案は `docs/model-optimization/G9_R3_CLEAN_REPLACEMENT_2026-10-12.md` の要約と同内容（「PR115の権利安全な置き換え候補。PR115のclose/旧branch削除・GitHub歴史の消去は未承認、mergeも未承認、実AI比較/デプロイなし」を明記する）。PR #115 は OPEN / Draft / head `8f430557` / updatedAt 2026-10-09 のまま（確認済み）。
- merge: not_performed
- deploy: not_performed

### changed_files（129。すべて新規追加。`tools/provider-compare/` と `docs/model-optimization/` のみ）

- `tools/provider-compare/**`（G9 R2 `65c95589` の最終ツリーから `fixtures/cases.json` だけを除いたもの＋R3 の変更）。R3 での変更: `src/fixtures.ts`（`loadCases()` の既定を `cases.rights_safe.json` に）、`src/fixture_loader.ts`（legacy は `--legacy-file` の私的ファイル必須、`--fixtures-dir`）、`src/cli.ts` / `src/probe_cli.ts`（上記フラグ。legacy+live はファイル読込前に拒否）、`scripts/build_cases.ts` / `build_rights_safe_fixtures.ts` / `fixture_rights_audit.ts` / `phase5_report.ts`（`cases.json` への固定参照を除去、出力はリポジトリ外）、`src/isolation_test.ts`（cases.json の除外を削除）、`README.md`、`.gitignore`（`.local/`）、新規 `src/synthetic_fixtures.ts` `src/body_leak_scan.ts` `scripts/body_leak_scan.ts`。
- `docs/model-optimization/**`（B の過去文書＋`G9_R3_CLEAN_REPLACEMENT_2026-10-12.md`、`PR115_BODY_REMOVAL_MIGRATION_PLAN` に R3 追記、`G9_R2_...` を同梱）。
- main 側の既存ファイルの変更・削除は0。

### tests

- `deno test --no-config -A tools/provider-compare/`: **302 passed / 0 failed / 1 ignored**（合計 303 件。R2 の 299 件から、削除/置換 8・追加 12）。ignored の1件は旧18本文の実物を要する検査で、私的ファイルが無い環境では実行されない。手元で私的ファイルを指定して実行し **PASS** を確認した（`PROVIDER_COMPARE_LEGACY_FILE`）。
- 置換した旧テスト（スキップ・削除で全PASSに見せていない）:
  - マニフェスト/監査の一致、「旧ファイルから再生成した結果と一致（ドリフト）」、「本文が残らない（24文字窓）」、「ゲート（18件・live・runtime bodies）」→ 合成本文（実物と同じ長さ・ホスト）で同じ実コード経路を通すテストに置換。ビルダーの動作は「合成入力から committed の rights-safe ケースと一致」で検証。
  - 「本文以外は変わらない」は元ファイルが無く同語反復になるため削除（ビルダーのテストが同じ性質を保証）。
  - 「評価コードの版が PR #115 基点と一致」→ 現在の main は PR #116 の変更を含むため「記録された基点/headのどちらか一方に一致（第3の版は失敗）」に変更。意味の低下は「基点のみ許容」→「基点または head を許容」。
  - 新規: 全 fixture JSON の本文保持ホスト検査（`eval_expansion.json` 本文27件・`eval_nopost_sample.json` 本文9件を含め許可リスト以外が0）、スキャナの陽性対照、実本文確認（私的ファイル時）、台帳レコードで1件のみクリアされる `probe_cli --plan-only` ほか。
- カバレッジの意味ある低下: 実本文（TDnet 等）を入力にした回帰は、私的ファイルが無い環境では合成本文での検証になる（本文由来の抽出テストは元から公開フィクスチャ側の `tanshin_extraction_test.ts` が自前の合成断片を使用）。
- `deno check`（全 `src/*_test.ts` と CLI・スクリプト）エラーなし、`deno lint` エラーなし、`git diff --cached --check` 問題なし、シークレット走査（キー形式の正規表現）一致なし。

### ancestry_checks

- `origin/main..HEAD` はコミット1件（`c476ef8a`）。親は `1a4b5f38`（`origin/main`）のみ。
- `8f430557`（PR #115 head）・`65c95589`（G9 R2）・`96d2aebb`（Phase 5）は **祖先ではない**（`merge-base --is-ancestor` が終了コード1）。`b6020dbb` / `63dba7be` も merge/cherry-pick/rebase していない。
- `git log HEAD -- tools/provider-compare/fixtures/cases.json` は空。HEAD のツリーに `cases.json` は無い（`cat-file -e` 終了コード128）。旧 `cases.json` の blob `030cd709…` は push 対象オブジェクト（`rev-list --objects origin/main..HEAD`）に含まれない。
- 旧ファイルは新ブランチの Git index へ一度も stage していない（コピー時に除外）。

### rights_checks

- 旧18本文 vs 新ツリー（`scripts/body_leak_scan.ts`、40文字窓）: `tools/` と `docs/` で **本文の一致 0**。見出し欄（`candidate.title`）の一致 3 件（TDnet の開示タイトルが本文1行目と同一。40–57文字）。
- 20文字窓の参考値: 見出し 11 件、ほかに `export_cases.sql` の選択条件の英文見出し文字列（1行84文字）と決算短信の定型句（22文字、テスト2ファイル）。長い散文の一致なし。
- 外部送信ゲート: 空台帳で18件は全経路 blocked。`rights_safe + runtimeBodies(18) + live` は送信不可（合成本文でテスト）。`probe_cli --fixtures legacy` はネットワーク・キー探索・ケース読込の前に拒否。legacy は同梱なし、`--legacy-file` の私的ファイルのみ・オフライン専用。
- 台帳 `body_licences.json` は空（本物の許諾は追加していない）。

### remaining_issues

1. **Draft PR 未作成**。ユーザーが権限を許可するか、手動で作成（作成用URL上記）。PR 本文には「PR115の権利安全な置き換え候補。PR115のclose/旧branch削除・GitHub歴史の消去は未承認、mergeも未承認、実AI比較/デプロイなし」と下記の残件2・3を明記する。タイトル案: `feat(provider-compare): rights-safe model-comparison harness without third-party bodies (replacement candidate for #115, Draft)`。コマンド: `gh pr create --draft --base main --head claude/b-provider-compare-rights-safe-20261012 --title <上記> --body-file <本文ファイル>`。
2. **見出し3件**（TDnet 開示タイトルが旧本文1行目と同一、40文字以上）。評価データの従来方針（見出し・URL は保持）に従ったが、不可とする場合は18件の見出しも本文と同じ仕組み（ハッシュのみ・実行時付与）に移す。このブランチでは未実施。
3. **main にもともとある2ファイルが旧本文と40文字以上一致**（本ブランチは未変更・範囲外）: `supabase/functions/important-news-monitor/company_identity_fixtures.ts`（625窓）、`supabase/functions/market-report-analysis/fixtures/close_2026-09-30_news_rows.json`（57窓）。所有する工程（A/G8 等）の判断が必要。
4. 旧ブランチ3本（`claude/b-claude-api-compare-20261009`=PR #115、`claude/b-news-eval-prep-20261010`、`claude/g9-fixture-rights-cost-eval-20261011`）と GitHub の `refs/pull/115/head` には旧本文が残る。クローズ・削除・履歴書換・GitHub 側の消去は未承認（このタスクでは達成不可）。
5. 過去の Phase 2 L0 で18件を含む本文を Anthropic の無料 `count_tokens` へ送っている（開示済み、取り消せない）。
6. 許諾（TDnet 等の利用条件）は未確認。有料比較・merge・deploy は未承認。

### safety_checks

- 有料API 0 / `count_tokens` 実呼び出し 0 / 本番DB 0 / 実キー 0 / テスト中のネットワーク接続 0（`--allow-net` なしのサブプロセスと mock のみ）。
- PR #115・#116・#129、他slotのブランチ・worktree・未commit・サーバ、監視Edge Function、Secrets/Cron/モデル/Provider に変更なし。main へのコード push なし。旧 G9 ブランチ（`65c95589`）の更新・force push・履歴書換なし。
- 開始時確認: `ACTIVE_TASK.md`（G9=ready）・G9 TASK・過去Report・fresh `origin/main`（`60c82a07`、その後 `1a4b5f38` に前進したため rebase して再テスト）・PR #115（OPEN/Draft/`8f430557`）・`tools/provider-compare` と `docs/model-optimization` が main に無いこと・他の open PR（#115 以外はこれらのパスに触れない）。
- 実行環境の分類器が、PR 作成（公開面の作成）と、その後の1回の `git ls-remote` を拒否した。いずれも回避していない。

### next_recommendation

- K9: ブランチ `claude/b-provider-compare-rights-safe-20261012` の祖先・ツリーを確認し、`PASS_OFFLINE` 判定。再実行: `deno test --no-config -A tools/provider-compare/`（302 passed / 1 ignored）。
- ユーザー: (a) Draft PR の作成を許可または手動作成、(b) 見出し3件の扱い、(c) PR #115 のクローズ・旧ブランチ削除・履歴の扱いを所有者として決定、(d) `main` 側の2ファイルの扱いを A/G8 へ。いずれも G9 は自動では行わない。
- A/G8 の作業へは引き継がない。

---

## Preserved previous G9 TASKs and Reports (history; do not edit)

# Claude Task G9 — API最適化B R2：外部AI送信の権利ゲート是正

- task_id: api-optimization-b-g9-r2-licenses-and-external-call-gate-20261011
- owner: claude
- slot: claude-9
- status: done
- next_owner: none
- start_code: G9
- finish_code: K9
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Sonnet5（高）
- task_type: G9 K9 review correction; B専用（外部AI送信の権利ゲート）
- user_routing: ユーザー明示割当 G9=API最適化B。G8ニュース改善A/その他全G/H枠は触らない。
- prohibited: paid API calls, count_tokens real network calls, production DB, paid provider access, deployment/merge, PR115 direct modification, source other than G9-owned evaluation tools/docs

## K9判定・今回の目的

- 前G9 TASK `api-optimization-b-phase5-followup-fixture-rights-and-cost-eval-g9-20261011` は `b6020dbb41d63cba88208cef20063c8d24632c0e` を `claude/g9-fixture-rights-cost-eval-20261011` にpush、17ファイル（B評価ツール/文書のみ）。G9報告: 284件PASS、typecheck/lint問題なし、実有料API0、本番アクセス0、PR merge/deploy0。GitHub変更ファイル/ブランチheadをちゃが確認、ローカルテスト自体はちゃ未実施。
- 22fixtureのうちrights_unconfirmed 18は `cases.rights_safe.json` から本文を外した。これはオフライン成果として有用。ただしPR115の `cases.json` とGit過去commitには18件の本文が残り、権利問題は未解決。PR115の既存ownerが不明なため本TASKで勝手にPR115を書き換えない。
- **K9 verdict: PASS_OFFLINE_PARTIAL / EXTERNAL_CALLS_RELEASE_HOLD**。実装の危険な残り: `fixture_access.ts` の `runtimeBodiesPath` を提供すると、SHA256一致だけで `rights_unconfirmed` 18件が `ready` になる。`cli.ts` はlive時に `--fixtures rights_safe` を確認するだけで、これら18件の外部AI送信を防ぐライセンス許諾ゲートがない。`probe_cli.ts` は既定rights_safeだが `--fixtures legacy` を指定すれば外部Anthropic count_tokensへ旧本文を送れる。ハッシュは内容一致の証拠で、転載/商用/第三者送信の許諾ではない。

## 対応範囲

1. **外部送信ゲート**: `cli.ts` live、`probe_cli.ts` count_tokens/モデル一覧等の外部接続前に、`rights_unconfirmed` は本文のハッシュが一致しても**外部プロバイダへ絶対送らない**。許諾確認済みを表す監査可能な明示情報がなければ除外/停止（fail-closed）。非公開ローカル評価でのみ一時本文を読む場合も外部へ流す経路を分離。送信前にケースごとに検査して理由を表示。APIキー発見/モデル呼出/送信前に検査できる構造を優先。
2. **legacyの扱い**: 旧 `cases.json` に本文がある事実を隠さない。少なくとも外部送信を伴う `probe_cli --fixtures legacy` は拒否。通常 `cli` はできれば安全な `rights_safe` 既定に変更し、legacyを使う必要があるローカル定型テストは明示的に指定して互換維持。古いfixture本文を含んだ本番由来記録のGit履歴書換・force pushは禁止。PR115 ownerへの移行計画として別報告。
3. **許諾の表現**: SHA256一致/オペレーターの単なるopt-inを「利用許諾あり」と扱わない。許諾状態を明示的に区別し、後日権利確認が取れたケースだけ監査記録を伴って許可する設計。今回、新たな権利許諾を仮定しない。TDnet/BBC/AJ/APの条項不明を安全側で止める。見出しや `recorded.generation.text` に引用が残り得る点も文書に記載し、評価時送信ペイロードの対象まで範囲を考慮。
4. **テスト**: 純粋mockで `rights_safe + runtimeBodies 18件有り + live` が外部送信できないこと、`probe_cli --fixtures legacy` がネットワーク開始前に拒否されること、defaultオフラインの安全な4件、許諾が検証済みの公式2件、hash mismatch/missingが既存通り、無ネットワーク/無有料APIで検証。既存284件の回帰、deno check/lint、diff check/secret scan、PR115との差分/ownership確認。テストで本物のkeysや外部APIは絶対使わない。
5. **作業境界**: 事前に `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`、G9 TASK末尾の過去Report、fresh origin/main、G9 branch最新headと他slotの所有/競合/worktreeを確認。G9専用の独立worktreeから `b6020dbb` の継続を安全に扱い、他slotのbranch/checkout/未commit/サーバを操作しない。対象変更は `tools/provider-compare/` と `docs/model-optimization/` のみ。G8 PR129、PR116、PR115、監視Edge Function/本番DB/Secrets/Cron/モデル/Providerは不干渉。
6. **成果**: 安全な場合に限りG9 branchへcommit/push、Draft PR作成は別のユーザー指示/所有確認が必要なら作らない。PR115の所有者が未確認の場合、PR115を編集しない。古い `cases.json` とGit履歴が残るという未完了課題を隠さず、別オーナーへの推奨移行手順をまとめる。
7. **完了報告**: K9で本チャットへ。TASK末尾 `## Report` にresult/外部送信ゲートの実装証拠/changed_files/tests/commit_hash/push/PR/権利の残件/safety_checks/remaining_issues/next_recommendationを書き、merge/deploy本番実行したと誤称しない。

## K9 evaluation — ChatGPT（2026-10-11 JST）

- verdict: PASS_OFFLINE / EXTERNAL_CALLS_RELEASE_HOLD
- verified_commit: 65c95589564845e7b343fe9d0acc7d293bebf783 （GitHub remote branch exact match; 親b6020dbbからfast-forward、B専用12ファイル）
- inspected: external_send_gate.ts、cli.ts、probe_cli.ts、fixture_loader.ts、許諾台帳（entries=[]）、PR115 OPEN/Draft/未変更。
- evaluated: 権利未確認18件はハッシュ一致やruntimeBodies指定だけでは外部送信できず、probeのlegacy明示指定はキー探索前に拒否。通常CLIはrights_safeが既定。安全ゲートとテスト実装あり。
- verification_limit: 299テストPASS・実キー0・有料API0・ネットワーク0はG9報告であり、ChatGPTが独立実行した結果ではない。
- remaining_hold: PR115/旧cases.json/Git履歴に未許諾の第三者本文が残る。録音/見出し/recorded_textの引用リスク、許諾の実証、実際の外部送信は未検証・未許可。PR115の所有判断前にbranchや歴史を改変しない。
- final_action: 今回のTASKはdone/next_owner:noneで終了。**G9の専任ルーティングは維持**するが、新しい具体的なB TASKを自動投入しない。G8その他枠には触れない。

## Report

- task_id: api-optimization-b-g9-r2-licenses-and-external-call-gate-20261011
- result: PASS_OFFLINE_GATE_IMPLEMENTED（外部AI送信ゲートの実装・テスト完了。EXTERNAL_CALLS_RELEASE_HOLD は維持。有料API・実ネットワーク・本番アクセスは0）
- finished: 2026-10-11 JST
- branch: `claude/g9-fixture-rights-cost-eval-20261011`（独立worktree `/Users/yuya/Developer/kabumori-g9-fixture-rights`、`b6020dbb` の継続）
- commit_hash: `65c95589564845e7b343fe9d0acc7d293bebf783`（親 `b6020dbb`）
- push: performed（G9ブランチのみ、`b6020dbb..65c95589` の fast-forward。main へのコード push・force push なし。この Report は `.agent` の自TASKのみ）
- PR: none（Draft PR は作成していない。PR #115 は未変更: OPEN/Draft、head `8f430557`、updatedAt 2026-10-09 のまま）
- merge: not_performed
- deploy: not_performed

### 外部送信ゲートの実装証拠

- 新規 `tools/provider-compare/src/external_send_gate.ts`（純粋関数。ネットワーク・env・ファイル読込・子プロセスなし。テストで固定）。ケースごとに `allowed` / 理由コードを返す。
  - `rights_unconfirmed` の本文は、ハッシュ一致・`--runtime-bodies`・`PROVIDER_COMPARE_ALLOW_PAID` では**送信不可**（`blocked_rights_unconfirmed_no_licence`、理由に「ハッシュ一致や opt-in は許諾ではない」と表示）。
  - 送れるのは、(a) 保存済みの open_terms 本文、(b) 本文なしかつ公開利用条件のホスト、(c) **許諾台帳に明示記録があるケース**のみ。記録は本文ハッシュ・provider・送信内容（title / body / recorded_text）・日付に紐づき、`state: denied` は確認記録より優先。台帳の構造不正は `LICENCE_REGISTER_INVALID` で全体停止。
  - legacy fixture は常に不可（`blocked_legacy_fixtures`）。由来不明・manifest なしは fail closed。
- 許諾台帳 `fixtures/body_licences.json` は**空**（新たな許諾は仮定していない）。TDnet / BBC / Al Jazeera / AP の18件は全経路で止まる。
- `cli.ts`: 既定 fixtures を `rights_safe` に変更（legacy は `--fixtures legacy` の明示時のみ、ローカル専用・警告付き、live は従来どおり拒否）。ゲートは **API キー探索より前**に走り、許可0件なら `EXTERNAL_SEND_NO_ELIGIBLE_CASES`。live は許可ケースだけで実行し、provider を `guardProvider` で包む（不許可の caseId・不許可本文を含むペイロードは内側 provider を呼ばず `EXTERNAL_SEND_BLOCKED`）。
- `probe_cli.ts`: `--fixtures legacy` を**最初に**拒否（`LEGACY_FIXTURES_REFUSED_FOR_EXTERNAL_CALLS`。キー探索・ケース読込・ネットワークの前）。次にゲート、その後にキー探索。`--plan-only`（キー・ネットワーク無しで送信予定と理由を表示）を追加。送信直前にも全リクエストを再検査。
- 送信内容の対象範囲: 見出しと `recorded.generation.text` に出典の引用が残りうるため、許諾記録に `title` / `recorded_text` の明示を要求し、本文なしでも許可リスト外ホストなら記録を要求。送信前にケースごとの送信量（文字数のみ）を表示。

### changed_files（12。`tools/provider-compare/` と `docs/model-optimization/` のみ）

- 新規: `src/external_send_gate.ts`, `src/external_send_gate_test.ts`, `fixtures/body_licences.json`, `docs/model-optimization/G9_R2_EXTERNAL_SEND_GATE_AND_LICENCES_2026-10-11.md`, `docs/model-optimization/PR115_BODY_REMOVAL_MIGRATION_PLAN_2026-10-11.md`
- 変更: `src/cli.ts`, `src/probe_cli.ts`, `src/fixture_loader.ts`, `src/fixture_access.ts`（コメント・manifest note のみ）, `src/fixture_access_test.ts`（「既定は legacy」前提の1件を「既定は rights_safe、legacy は明示」に更新）, `fixtures/cases_body_manifest.json`（note 文言のみ）, `docs/model-optimization/G9_FIXTURE_RIGHTS_AND_COST_BASELINE_2026-10-11.md`（R2 訂正の注記のみ）
- `fixtures/cases.json` は**変更していない**（PR #115 のテストが本文を前提とするため）。

### tests

- `deno test --no-config -A tools/provider-compare/`: **299 passed / 0 failed**（既存 284 + 新規 15。既存で変更したのは上記1件の前提のみ。他の既存テストは無変更で通過）。
- 新規15件の内容（すべて pure mock / ローカルファイル / `--allow-net` なしのサブプロセス。実キー・外部API無し）:
  - `rights_safe + runtimeBodies(18)`: 18件は attached_verified だが全件 blocked、許可は4件。全 task × 全22件を mock vendor に流しても、内側 provider に届いた caseId に18件は含まれず、届いたペイロードに18件の本文は含まれない。
  - CLI live: runtime bodies 付きで TDnet 1件に絞ると、キー探索前に `EXTERNAL_SEND_NO_ELIGIBLE_CASES`（stdout に `key:` なし）。
  - `probe_cli --fixtures legacy`: ネットワーク・キー探索・ケース読込の前に拒否。`--plan-only` は既定で4件許可、runtime bodies を足しても許可は4件のまま。
  - 既定のオフライン安全4件（公的機関2 + 本文なし2）、ハッシュ不一致・欠落は従来どおり除外、台帳は空で読込可、許諾記録の紐づけ（ハッシュ・provider・送信内容・期限・否認・本文なしの扱い）、構造不正の拒否、ペイロードへの本文混入検出（先頭・中央）。
- 変異テスト: `attached_verified` を無条件許可に書き換えると8件が失敗することを確認（元に戻して再実行済み）。
- `deno check`（cli / probe_cli / gate / test / loader）エラーなし、`deno lint` エラーなし。`git diff --check` 問題なし。シークレット走査（変更ファイルへのキー形式の正規表現）一致なし。

### 権利の残件（隠さずに記録）

1. `fixtures/cases.json` には第三者本文20件中18件（TDnet 11 / AJ 3 / BBC 2 / AP 2）が**今も入っている**。変更していない。
2. Git 履歴にも残る。導入は `8f430557`、含むリモートブランチ: `claude/b-claude-api-compare-20261009`（PR #115）、`claude/b-news-eval-prep-20261010`、`claude/g9-fixture-rights-cost-eval-20261011`。履歴書換・force push は行っていない。
3. 過去に18件を含む本文を Anthropic の無料 count_tokens へ送っている（Phase 2 L0、開示済み、取り消せない）。以後の経路はゲートで止まる。
4. 許可リスト（政府・中央銀行・国連）はリポジトリ方針でありページ単位の確認ではない。`eval_expansion.json` / `eval_nopost_sample.json` の本文（27 / 9 件）は許可リストのホストのみで、現在の CLI からは読まれない。見出しと保存済み投稿は全ケースに残る。
5. PR #115 の所有者は不明（共有アカウント作成）。置き換えの手順は `PR115_BODY_REMOVAL_MIGRATION_PLAN_2026-10-11.md`（推奨: main から新ブランチで本文なしの最終ツリーを1コミットにして新PRを作り、PR #115 を閉じる。完全消去が必要なら所有者が履歴書換と GitHub への削除依頼を判断）。

### safety_checks

- 有料API 0 / count_tokens 実呼び出し 0 / 本番DB 0 / 実キー使用 0 / ネットワーク接続 0（テストは `--allow-net` なしのサブプロセスと mock のみ）。
- PR #115・#116・#129、監視Edge Function、本番DB・Secrets・Cron・モデル・Provider に変更なし。他slotのブランチ・worktree・未commit・サーバに触れていない。変更は `tools/provider-compare/` と `docs/model-optimization/`（と本TASKのReport）のみ。
- 開始時確認: `.agent/ACTIVE_TASK.md`・G9 TASK・過去Report・fresh `origin/main`（`147590a4`）・G9 head（`b6020dbb`、worktree clean）・PR #115 の状態・`tools/provider-compare` が main に存在しないこと（他slotと競合なし）。`PROJECT_RULES.md` / `ORCHESTRATION.md` / `CURRENT_STATE.md` は G9・Report 運用・保護対象の記述を確認（競合なし）。
- merge・deploy は実行していない。

### remaining_issues

- `cases.json` と Git 履歴の本文（上記 権利の残件 1・2）。PR #115 の所有者の判断と別工程が必要。
- 許諾の確認（TDnet 等の利用条件）は未実施。確認できたら台帳に `evidenceRef` 付きで追記すれば外部送信が可能になる（コード変更不要のため、追記は所有者確認を経ること）。
- 有料の Claude 比較実行は、ユーザーの別途の予算承認が引き続き必要（EXTERNAL_CALLS_RELEASE_HOLD は維持）。

### next_recommendation

- K9: ちゃが `65c95589` のゲート（`external_send_gate.ts`）と `cli.ts` / `probe_cli.ts` の順序（ゲート → キー探索 → ネットワーク）を確認し、PASS_OFFLINE 判定。ローカルでの再実行は `deno test --no-config -A tools/provider-compare/`（299件）。
- PR #115 の所有者を確認し、移行手順（別紙）の実施可否を判断する。実施するまで `cases.json` を含むブランチは merge しない。
- Aへ決算・日銀・FOMC 調査を引き継ぐことはしない（G8 が進行中）。

---

## Preserved previous G9 TASK / Report（履歴・改変禁止）

# Claude Task G9 — API最適化B / Phase5成果から評価基盤の権利・費用整理へ

- task_id: api-optimization-b-phase5-followup-fixture-rights-and-cost-eval-g9-20261011
- owner: claude
- slot: claude-9
- status: review_required
- next_owner: chatgpt
- start_code: G9
- finish_code: K9
- return_to: ニュース改善API最適化のちゃ
- recommended_model: Sonnet5（高）
- scope_owner: このチャットの「API最適化 B」のみ。今後もB作業はG9に割当（個別TASK完了後は同じ枠で再割当）。ニュース取得/抽出・重要ニュース監視本体はA=G8が所有。他案件や他のG枠を引き継がない。
- assignment_authorization: ユーザーが2026-10-11にG9の使用を明示承認
- type: offline evaluation and cost/recall optimization preparation
- paid_api_budget: 0 / 有料API呼び出しなし
- prohibited: production deploy, DB writes, schema/RPC/migration, Cron/Secrets/model/Provider changes, other slots/tasks, PR129 edits

## 背景・根拠（B Phase5完了）

- BのPhase5報告は `claude/b-news-eval-prep-20261010` 上のcommit `96d2aebbaeffad749be5d267346f683074dd0202`、資料 `docs/model-optimization/NEWS_UNDELIVERED_ROOT_CAUSE_2026-10-10.md` と `phase5_report_2026-10-10.json`、`fixture_rights_audit_2026-10-10.json`。
- 最新確認でPR [#115](https://github.com/anohi-memories/kabumori/pull/115) はOPEN/Draft/未merged、既存head `8f4305574d1895a9f3b45c91470792bed7edb774`。開始時は最新を再取得。
- 調査: 重要以上405件のうち生成失敗196、直近7日169件中39（23.1%、作成日JST・定義F）。30日47〜48%と期間/分母を混同しない。Fact不足ゲート402/1,808 no_post、ゲート前の重要度は未記録。Xに出ないこととアプリ一覧に載らないことは別。
- PR116直接改善見込みは直近7日39件中6件+部分的7件という推定で、**本番実測ではない**。PR116 10月13日固定deployを実施する権限はこのG9にない。G8 PR129の数値抽出改善はまだレビュー指摘修正中、G9はそのコードを触らない。
- 22評価fixturesのうち本文保持20、権利監査で保存許容2（金融庁・財務省）、無許諾で本文を置くべきでない18件（TDnet11、Al Jazeera3、BBC2、AP2）。本文18件は評価時の原本取得とSHA256/字数照合を検討。JPX/TDnetの再利用条件未確認、403を迂回しない。
- Bの役割は評価基盤・モデル比較・APIコスト/取りこぼし削減の計測と設計。**ニュース本文抽出・配信Functionの実装はA/G8の範囲**。

## 今回の初回G9 TASK

1. **安全な引継ぎ照合**: Phase5のbranch/commit/報告とPR115の開発状態・TASK所有者・PR差分・mainとの関係をチェック。既存A/B直接Claudeセッションが対象branch/PRを編集中なら同時変更せず停止。B専用の新規独立worktree/checkoutから開始し、他slotのworktreeを使わない。
2. **fixture権利問題の最小修正**: 監査結果をもとに、PR115評価fixture `cases.json` に残る第三者本文18件をGit履歴の再利用・勝手な複製で増やさず、安全な参照/ハッシュ・本文非保存方式へ移す**コード案・テスト**を作成。評価時に適法に原文を取得できない/TDnet403/権利不明なら、取得を迂回せずそのケースは `unavailable` / `needs_rights_review` としてfail-closedに記録し、無断再配布しない。既存の適法なofficial 2件の扱いは維持。既存の`attachBodies`、`body_policy.ts`を活用し、再現性・ハッシュ照合をテストする。PR115を直接更新するのは明確な所有者合意・非競合・対象branch安全確認が取れた場合のみ。それ以外はG9独立branchの変更/設計として報告し、既存PRを触らない。
3. **比較とコストの測定基準**: APIコスト/重要ニュース取りこぼし/生成失敗/事象到達の評価指標をPhase5分母定義で固定し、`全判定`を重要以上失敗率の分母に混ぜない。生成失敗は段階（取込・判定ゲート・Fact/Voice・X・アプリ/通知）別に集計。既存ログとSELECT-onlyの既存集計（必要な本番読取権限が不明・競合する場合は新規本番アクセスはしない）から**オフライン再現可能**なベースラインと今後のA/B比較計画を提示。
4. **公開済み側の評価準備**: Phase4/5で人手未確認16件のうちAI暫定3件と未決13件の区別を維持。将来の配信済み側100件のサンプル評価計画を作るが、AI暫定を人手承認として扱わない。ゲート前重要度の欠落を観測可能な`JudgementTrace`設計として保全し、本番schema変更はしない。
5. **権利・費用・安全ゲート**: OpenAI/Claudeの有料比較は**ユーザーの別途予算承認まで実行しない**。既存の無料公的ソース優先＋限定WebSearch方針を維持。見逃し0を目標にしつつ、根拠のない誤配信を増やさない。利用規約不明なデータの保存・配布・403迂回は禁止。

## 変更可能な範囲

- G9専用branch上の `tools/provider-compare/` および `docs/model-optimization/` のBの評価コード・テスト・設計だけ。
- PR115のownership/競合が明らかになった場合は無断pushしない。PR129、PR116、`supabase/functions/important-news-monitor/`、`_shared/news_body_extraction/`、breaking/trigger/Provider本体、G1〜G8/G10、他TASK/Report、production DB/Cron/Secrets/設定・モデルには触れない。
- 本番接続や有料API、実Claude API比較、実X投稿、実アプリ配信、merge/deployは禁止。既存実PDF/記事本文を新たにrepoへ保存しない。純粋なテスト・評価のための読取であってもライセンスと利用範囲を遵守。
- Bの作業を「ニュース改善A/G8」のTASKへ自動移管したり、他のG枠に再割当しない。必要なA連携事項は**報告で明示**し、このチャットのちゃが判断する。

## 必須テストと完了条件

- `deno test --no-config -A tools/provider-compare/src` の既存259 PASS（Phase5報告）をベースラインとして再実行し、rights/fixtureの新規テスト・hash一致/不一致・unavailable/403・source無しを検証。既存テストの改変や本番変更無し。型検査/lint/diff/secret scan。
- fixture権利の課題18件について権利状態と安全な移行方針/実装を明示。権利未確認をPASSとしない。
- 生成失敗・API使用量の評価分母、Phase5/Phase4の差、PR116の効果の**未観測**を明確化。
- B所有範囲の差分だけ、独立branchにcommit/push。新規Draft PRは安全かつ既存PR115と重複しない場合のみ。PR115所有が未確定なら変更せずBLOCKEDと報告。
- 完了時このTASK末尾の `## Report` に task_id/result/changed_files/tests/commit_hash/push/PR/rights_checks/cost_estimates/remaining_issues/safety_checks/next_recommendation を残し、`K9` を **ニュース改善API最適化のちゃ** に返す。次のタスクはこの部屋以外から持ち込まない。

## Report

- task_id: api-optimization-b-phase5-followup-fixture-rights-and-cost-eval-g9-20261011
- result: **PASS_OFFLINE（review_required）** — 第三者本文18件を本文非保存・fail-closedで扱う仕組みと検証、評価指標の分母固定、オフラインのベースライン、配信済み側100件のSQL計画を独立branchに実装。`cases.json` とPR115は未変更（所有者判断待ち）。
- completion_code: K9（return_to: ニュース改善API最適化のちゃ）
- branch: `claude/g9-fixture-rights-cost-eval-20261011`（`claude/b-news-eval-prep-20261010` の `96d2aebb` から分岐。新規独立worktree `/Users/yuya/Developer/kabumori-g9-fixture-rights`）
- changed_files:
  - 新規 `tools/provider-compare/src/{fixture_access,fixture_loader,baseline_metrics}.ts` と `{fixture_access,baseline_metrics,pending_distinction}_test.ts`
  - 新規 `tools/provider-compare/scripts/{build_rights_safe_fixtures,baseline_report}.ts`、`export_eval_posted_sample.sql`（SELECTのみ・本番未実行）
  - 新規 `tools/provider-compare/fixtures/{cases.rights_safe,cases_body_manifest}.json`
  - 新規 `docs/model-optimization/{G9_FIXTURE_RIGHTS_AND_COST_BASELINE_2026-10-11.md,baseline_2026-10-11.json}`
  - 変更（B所有の評価ツールのみ）`src/cli.ts`（`--fixtures`、`--runtime-bodies`、liveはrights_safe必須）、`src/probe_cli.ts`（既定をrights_safe）、`scripts/phase5_report.ts` と `phase5_report_2026-10-10.json`（期間別のPR116見込みを追記のみ。他の値は不変）
- tests: `deno test --no-config -A tools/provider-compare/src` **284 passed / 0 failed**（既存259を未改変で維持 + 追加25）。`deno check` / `deno lint`（tools/provider-compare 全体 83ファイル）エラー・指摘なし。isolation（JSON文字列単位のsecret scan含む）PASS。SQLはローカルPostgreSQL 17で構文・抽出数を確認。
- commit_hash: `b6020dbb41d63cba88208cef20063c8d24632c0e`
- push: 実施（上記branchのみ）。PR作成なし（PR115との重複を避けるため。必要ならちゃが判断）。
- merge: not_performed
- deploy: not_performed
- PR: PR115 未変更（OPEN/Draft、head `8f430557`、更新なし。所有者合意が確認できないため直接更新せず）。PR116/117/129 未変更。
- rights_checks:
  - 評価fixture22件の内訳: 保存許容2（金融庁・財務省）、本文なし2、**許諾を確認できない18（TDnet 11、Al Jazeera 3、BBC 2、AP 2、16,252文字）**
  - 18件は既定で `needs_rights_review` として実行から除外。取得元（ローカルの読み取り専用エクスポート）を明示した場合のみ、サニタイズ後SHA-256が一致したものだけ付与。行なし=`body_source_missing`、不一致=`body_hash_mismatch`。ネットワーク/子プロセスのコードは無く、TDnet 403は構造上迂回できない
  - TDnet（JPX・発行体）の利用規約は公式ページから確認できず（サービス概要のみ）。BBC/AJ/APは許諾未確認。権利未確認はPASSにしていない
  - **未解決**: Git履歴にはPR115の初回コミットの本文が残る。`recorded.generation.text`（本番の公開投稿文）と見出しは各ケースに残る（本番自身の文章として扱ったが権利確認の対象）。Phase2のL0で、18件の本文を含むリクエストをAnthropicの無料count_tokensへ送っていた（課金・モデル呼び出しなし）。以後 `probe_cli` は既定でrights_safe
- cost_estimates（台帳の平均×件数。請求書ではない。有料比較は未実行）:
  - ニュースパイプライン全体 約 $13.3/30日（Sol判定 $8.7、Luna $1.4、検索 $1.7）
  - ゲートでno_postになったSol判定 約 $2.6（30日の件数）〜 $5.5（現在の量）/30日。生成失敗に使った費用 約 $0.17〜0.25/30日 → 失敗の損失は費用ではなく到達
  - 将来の比較（見積）: 一次判定×290件 Haiku(off) $0.09 / Sonnet(low) $2.60 / Opus(medium) $8.88。一次+詳細×290件 $0.20 / $5.72 / $19.03。生成の連鎖×100件 $0.12 / $3.27 / $10.04。Sonnet・Opusは一次判定でLunaの約30〜110倍。実行はユーザーの予算承認後
- metrics_baseline:
  - 配信失敗率の分母は「重要以上」に固定（no_postを入れると関数が失敗）。全判定を分母にした値は別名。30日 48.4%（196/405）と直近7日 **23.1%（39/169）** を窓つきで別保持
  - 段階別: 判定でno_post 1,406、ゲート402、重要以上405、生成停止（Fact168/Voice25/ローカル1/API2）、X配信208
  - PR116の効果は**未観測**（merge後の最初の完全な週で比較。15%への低下の検出に各群約369件=約3週間、10%なら約127件=約1週間）。直近7日の失敗39件のうち改善見込み6・部分的7・対象外26は読み取りの推定で実測ではない
- remaining_issues: (1) `cases.json` の置換とGit履歴の扱いはPR115所有者の判断（本文を前提とする既存テストの前処理追加が必要）。(2) A担当Preflightの定義（期間・分母・状態・重複・試行か最終か）は未照合。(3) ゲート前重要度の保存（`JudgementTrace`）は承認とC2レビューが必要な本番変更で、Bからは実施しない。(4) 配信済み側100件は製品方針の問い6項目の回答後に実施。(5) 人手確認済みラベルは0件。(6) TDnet原本は未確認（403は迂回しない）。
- safety_checks: 有料API呼び出し0。本番DBへの新規アクセス0（既存のコミット済み成果物のみ使用）。DB書込み/schema/Cron/Secrets/Provider/モデル変更なし。PR115/116/117/129・`supabase/functions/important-news-monitor/`・他slotのTASK/worktreeに触れていない。`cases.json` 不変。merge/deploy なし。AI暫定を人手承認として扱っていない（`verifier` は全件 `none`）。
- next_recommendation: ちゃが次を判断。(a) PR115所有者へ `cases.rights_safe.json` への切替と履歴の扱いを依頼、(b) A/G8へPhase5の取得段階の高優先3件（決算短信の当期行、日銀PDFの本文、FOMC声明）を引き継ぎ、(c) ゲート観測（`JudgementTrace`）の保存方式の承認、(d) 製品方針の問い6項目の回答後に配信済み側100件を実施、(e) 有料比較はユーザーの予算承認後のみ。K9 を **ニュース改善API最適化のちゃ** に返す。
