# F2 CURRENT TASK — PR143 のライブマージ可否を原因調査

- task_id: kabumori-f2-pr143-live-mergeability-diagnosis-20261012
- owner: claude
- slot: F2
- status: done
- next_owner: none
- l2_verdict: PASS_GO_TO_MERGE_DECISION / PRODUCTION_NO_GO (2026-10-12; no GitHub merge executed)
- start_code: F2
- completion_code: L2
- return_to: かぶモリアプリ G2（新F2担当）のちゃ
- recommended_model: **Sonnet5（高）**
- current_task_path: .agent_v2/tasks/F2.md
- current_report_path: .agent_v2/tasks/F2.md#report
- dependencies: PR143 889ca1b44cf82bd3ecb913818dca568456849feb; stacked PR149 e9bb86c44808d87ad8cbd3de4f1d1564066f958a; PR158 ea7bbd07d06533d359a733d3dce65169d0e24283
- blocker: GitHub PR143 mergeable=false against recently advanced main; local overlap preliminary 0
- production_mutation_window: INACTIVE
- origin: user explicitly requested moving the UNSTARTED diagnostic from G2 to F2; old G2 original task preserved as CANCELLED_UNSTARTED and cannot be started.
- source_release: PRODUCTION_NO_GO

## 目的
ユーザーは3件のソースPR（143→149→158）の順次mainマージを承認済み。しかしPR143がGitHubでmergeable=falseとなったため、F2独立環境で正確な原因を突き止め、マージ再開の是非をL2に返す。**このTASK自身ではmainへのマージは実施しない。**

## 対象範囲
- GitHub PR143と最新main、依存PR149/158の状態。
- PR155によるagent_v2基盤導入後のmain変更による競合可能性。
- 旧G2のK2で報告した衝突0件と現在のGitHub状態の不一致。

## 変更可
- 独立F2 worktree内での使い捨てマージ再現、read-only調査、必要な検証記録。
- 自分のF2 TASK末尾ReportとF2のACTIVE_TASK/CURRENT_STATEのみ。
- G2の旧TASKやPR143/149/158のブランチを変更しない。

## 変更不可
- G1/G2/G5/G6/G3/G4や他の新旧slotのファイル、worktree、dev server、task/report。
- PR155・agent_v2基盤の所有領域。
- main、PR143、PR149、PR158の実際のマージ・base変更・Draft解除・force-push/rebase/reset。
- 本番DB/RLS/Auth/migration/Edge/Cron/secrets/Expo/EAS/API/有料API。

## 安全制約
- PROJECT_RULES.md、.agent/ORCHESTRATION.md、.agent_v2/ORCHESTRATION.md、.agent_v2/ACTIVE_TASK.md、.agent_v2/CURRENT_STATE.md、旧G2終了記録を確認。
- fresh origin/mainとPRの正確なhead/base、CI、他slot・worktreeの変更対象競合を確認。
- F2独立worktree以外でcheckout、reset、mergeしない。競合があればSTOPして担当と衝突箇所を報告。
- 未確認の操作を成功扱いしない。

## 実装 / 調査指示
1. PR143のmergeable=falseを使い捨てF2 worktreeで `git merge --no-commit` または `merge-tree` により再現し、衝突ファイル・理由を特定。
2. 競合が0なら、GitHub側の再計算待ち/metadataとソース上の安全性を区別して証拠を提示。PR143のhead SHAを再確認。
3. 実競合がある場合、所有者と限定修正方法を提案し、他slotファイルは変更しない。
4. PR149/158の親子依存、通常merge commit→後続PRのbaseをmainへ切替という前回のK2条件が引き続き満たされるか確認。
5. このTASKは診断のみ。ユーザーの既存マージ承認は有効として記録し、最終マージ実行判断はちゃのL2確認へ返す。
6. 本件と無関係なフルテストは不要。source変更なしの場合は確認種別・NOT_RUNを明記。

## 完了条件
- 状態を GO_TO_MERGE_DECISION / CHANGES_REQUIRED / BLOCKED で判定。
- main/head/base SHA、mergeableの実証、競合原因、検証、未実施事項をReportに記録。
- Reportに task_id, result, changed_files, tests, commit_hash, push, merge, deploy, remaining_issues, safety_checks, next_recommendation を記載。
- status review_required / next_owner chatgpt に変更し新F2索引へ反映。
- **かぶモリアプリ G2（新F2担当）のちゃへ L2** を返す。

## L2 acceptance

- result: PASS_GO_TO_MERGE_DECISION / PRODUCTION_NO_GO
- accepted: disposable latest-main integration of PR143→149→158 conflict-free, no source changes; developer-reported tests and PR metadata separately distinguished.
- caveat: connected GitHub metadata still reports PR143 mergeable=false against main; local clean merge does not itself authorize treating GitHub merge as performed. Fresh revalidation and merge-time checks required.
- all PRs remain Draft/open/unmerged; production actions 0.

## Report

- task_id: kabumori-f2-pr143-live-mergeability-diagnosis-20261012
- result: **GO_TO_MERGE_DECISION**（PR143 のソースは、今の main に衝突なしでマージできる。GitHub の「マージできない」「UNKNOWN」は、GitHub 側の再計算が古い main のままで止まっていることによるもので、ソースの衝突ではない）／PRODUCTION_NO_GO
- changed_files: none（調査だけ。PR143 / PR149 / PR158 のブランチ・base・Draft の状態は変えていない）
- commit_hash: none（この Report の `.agent_v2` の記録のコミットだけ）
- push: `.agent_v2/tasks/F2.md`・`.agent_v2/ACTIVE_TASK.md`・`.agent_v2/CURRENT_STATE.md` の F2 の部分だけ
- merge: no
- deploy: no

### SHA（`git rev-parse` / `gh pr view` / `gh api` の出力）

- 今の main: `3c590d400ac4f7d0cbe35c9f9cda4dd11f6b8938`
- PR143: head `889ca1b44cf82bd3ecb913818dca568456849feb`、base main、OPEN・Draft
- PR149: head `e9bb86c44808d87ad8cbd3de4f1d1564066f958a`、base `g2-ondemand-v1-20261011`（PR143）、OPEN・Draft、`MERGEABLE / CLEAN`
- PR158: head `ea7bbd07d06533d359a733d3dce65169d0e24283`、base `g2-broadcast-push-v1-20261012`（PR149）、OPEN・Draft、`MERGEABLE / CLEAN`
- PR155（新系統の基盤）: マージ済み `4e80c79dc42c11fbc1ca105665514b0dd32842d3`

### GitHub の表示（同じ時点で2つの読み方を比べた）

| 読み方 | PR143 の表示 |
|---|---|
| `gh pr view`（GraphQL） | `mergeable: UNKNOWN`、`mergeStateStatus: UNKNOWN`（調査の初めと終わりの2回とも） |
| REST `GET /pulls/143` | `mergeable: true`、`mergeable_state: clean`、`merge_commit_sha: 39e74c7f54122217faf80d90c9805cd81584a59e` |

- GitHub の試しのマージ `refs/pull/143/merge`（`39e74c7f54122217faf80d90c9805cd81584a59e`）の親は次の2つ。
  - `50a2e0797ef88c3859de7d7c94f3a9d04a46ef91`（2026-10-12 11:54 JST の main）
  - `889ca1b44cf82bd3ecb913818dca568456849feb`（PR143 の head）
- つまり GitHub の判定は、今の main ではなく、約数時間前の main に対するもので、**今の main に対する再計算がまだ終わっていない**（GraphQL は計算中を UNKNOWN で返す）。
- main には `.agent` / `.agent_v2` の記録のコミットが1〜2分おきに入るので、GitHub の再計算が追いつかない状態になっている。割り当ての時点の `mergeable=false` は、この再計算の途中の一時的な値とみられる。今回は false そのものは再現しなかった。

### 手元での実証（F2 専用の使い捨て worktree）

- `/Users/yuya/Developer/kabumori-fresh` から、今の main（`3c590d40`）で detached の worktree `/Users/yuya/Developer/kabumori-f2-pr143-diag` を作った。確認後に削除し、一時の ref も削除した。
- `git merge-tree --write-tree origin/main 889ca1b4`: 終了コード 0（衝突なし）。木 `ae22293459faae7ba0f715c68f31617e11b06753`。
- 同じ worktree で、`git merge --no-ff` を PR143 → PR149 → PR158 の順に（各 head を1回ずつ）当てた。
  - **3回とも衝突0件**。結果 `10a594f73ccc5f1ade338d89001d8cdd6d811b65`（push していない）。
  - main との差分は45ファイル（旧 G2 の確認と同じ）。`git diff --check` は問題なし。
- 起点 `7e63397b` 以降に main で変わったコードは27ファイル（`.agent` 以外）。PR143 の30ファイルとの重なりは0件。
- 旧 G2 の最後の確認（main `155a3c60`）以降に main で変わったのは、PR155 の `.agent_v2/`（63ファイル）と、`AGENTS.md`・`CLAUDE.md`・`PROJECT_RULES.md` だけ。コード・migration・テストの変更は無い。

### CI と前回の条件

- CI: PR143 は Vercel pass・Netlify deploy-preview pass。PR149・PR158 は Vercel pass。main のブランチの保護は無い（必須のチェックなし）。
- 旧 G2 の K2 の条件は、引き続き当てはまる。
  - リポジトリは `delete_branch_on_merge: false` のまま。PR143 をマージしても、PR149 の base は自動で main に付け替わらない。
  - **PR143 を通常のマージ（merge commit）で入れる → PR149 の base を main に付け替え、差分が一斉通知の分だけになることを確かめてから入れる → PR158 も同じ**。squash・rebase にしない。

### tests

- 実行したもの:
  - `git merge-tree`
  - 使い捨ての worktree での3つの PR の順の `git merge`（衝突の有無）
  - `git diff --check`
- NOT_RUN:
  - 手元の PostgreSQL の検証、Deno・アプリのテスト。旧 G2 の最後の確認以降、main にコードの変更が無いため。旧 G2 の結果（統合した版で、アプリ540件・PostgreSQL の検証すべて PASS）をそのまま使う。
  - 本番・本物の API・Expo。

### remaining_issues

- GitHub の PR143 の表示は、まだ再計算されていない。マージする人は、マージの直前に GitHub の表示を見直す。GitHub は、マージの操作のときに衝突があれば受け付けない。
  - 表示が変わらなくても、ソースは今の main に衝突なしで当たる（上の実証）。
- 本番は NO_GO のまま。マージしても、migration の適用・Edge のデプロイ・Cron・ゲートの ON・アプリのビルドはすべて別承認。
  - 順番は `docs/v1-release/RUNBOOK.md`（PR158）。

### safety_checks

- 次はすべて0件: 本番の DB・Auth・RLS・migration・Edge・Cron・Secrets・Expo・EAS・有料 API の操作。
- PR143 / PR149 / PR158 のブランチ・base・Draft、PR155・`.agent_v2` の基盤、他の新旧の枠のファイル・worktree・dev server には触れていない。
- 使い捨ての worktree と一時の ref は削除した。

### next_recommendation

- ユーザーの既存のマージの承認は有効として記録する。L2 で確認し、問題なければ上の手順（通常のマージ、間で base を main に付け替え）で PR143 → PR149 → PR158 の順にマージへ進む。
- マージのあとは、本番の**読み取りだけ**の確認（RUNBOOK の段階2）を、別承認で行う。

Return: **かぶモリアプリ G2（新F2担当）のちゃへ L2**
