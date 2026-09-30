# Claude Task 4

- task_id: x-ai-lab-diary-snapshot-automation-20261001
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- priority: high
- recommended_model: Sonnet5（高）
- supersedes_before_start: x-ai-lab-diary-update-20260930
- purpose: 会社員AIラボ開発日記の更新を毎回G3/G4へ渡さず、ChatGPT（ちゃ）がMarkdown正本へ直接追記した後に、GitHub Actionsがruntime snapshot生成と安全テストを自動実行する運用へ変更する。production deployは別の安全ゲートとして残す。

## Supersede safety

前TASK `x-ai-lab-diary-update-20260930` は status=ready のまま未着手だった。
ユーザーが明示的に自動化方針へ変更したため、前TASKは実行せず本TASKに置き換える。
前TASKの手動日記更新を別途実行しないこと。

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/room_handoffs/X_AUTOPOST_CHAT.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout and fresh `origin/main`.
3. Inspect existing GitHub Actions workflows, repository runtime/toolchain, diary generator, diary tests, and branch/protection constraints before implementing.
4. Confirm G3 ownership does not overlap this workflow/generator scope.
5. Do not inspect, modify, or reassign G1/G2 TASK/Report/status.

## Target operating model

After this task is accepted, normal K1/K2/K3/K4 diary handling should be:

1. ChatGPT performs the normal K completion check.
2. If `AI Lab diary: 候補あり`, ChatGPT directly appends a public-safe entry to:
   `supabase/functions/_shared/brand/ai_lab_dev_diary_context.md`
   on main using the GitHub connector.
3. That Markdown change automatically triggers GitHub Actions.
4. The workflow regenerates:
   `ai_lab_dev_diary_context.snapshot.ts`
   using the canonical generator.
5. The workflow automatically runs the required:
   - parity check
   - freshness/date validation
   - sanitizer/safety tests
   - scheduled AI Lab / shared-brand regression tests that are materially relevant
   - diff/secret checks where applicable
6. Only when all checks pass may the generated snapshot be committed/pushed.
7. No G3/G4 diary-update TASK is needed for this normal path.
8. Production deployment remains a separate controlled gate. A diary edit or bot snapshot commit must never by itself deploy production or post to X.

## Required implementation

### A. GitHub Actions workflow

Add a narrowly scoped workflow for the diary source.

Preferred trigger:
- push to `main`
- paths limited to the canonical Markdown diary source
- optional `workflow_dispatch` for safe manual rerun

The workflow must:
- use least-privilege permissions; request `contents: write` only if required to commit the generated snapshot
- check out the appropriate current main safely
- run the repository's canonical generator, not duplicate generation logic inside YAML
- run the relevant safety/regression tests before any write
- fail closed: if generation or any test fails, do not commit/push anything
- commit only the generated snapshot (and only other deterministic generated files if the existing generator truly requires them)
- never force-push
- guard against races/main moving during the run; if safe fast-forward cannot be guaranteed, fail without overwriting
- avoid infinite workflow recursion (for example by path scoping so a snapshot-only bot commit does not trigger itself)
- use clear bot commit metadata/message
- not expose secrets/log sensitive values

Use `concurrency` or an equivalent safe serialization mechanism so multiple diary updates cannot corrupt/overwrite each other.

If GitHub branch protection prevents a safe bot push, do not weaken protection. Implement the safest supported alternative (for example a generated PR) and document the resulting flow.

### B. Existing generator/tests

Reuse:
- `generate_ai_lab_dev_diary_snapshot.ts`
- the existing parity/freshness/calendar-date/sanitizer tests

Do not rewrite working diary architecture unnecessarily.
Add only the minimum tests needed to verify the new workflow contract/race/trigger assumptions where repository conventions support it.

### C. Orchestration rule update

Update `.agent/ORCHESTRATION.md` so the current rule:

`候補あり -> G3/G4へ開発日記更新TASK`

is replaced with the accepted automated model:

`候補あり -> ChatGPTが公開安全なMarkdownを直接更新 -> GitHub Actionsがsnapshot生成+tests`

Rules:
- K1/K2/K3/K4すべて対象
- ChatGPTが毎回自動判定
- normal diary update does not consume G3/G4
- if the automated workflow fails, ChatGPT records the failure and only then creates a repair TASK in an available G3/G4 slot if code/workflow repair is actually necessary
- do not fake dates
- preserve all current public-safety exclusions
- production deploy remains a separate gate

Update `.agent/room_handoffs/X_AUTOPOST_CHAT.md` consistently.

### D. Direct-write safety contract for ChatGPT

Document that ChatGPT may directly edit only the canonical Markdown diary file for normal diary entries.
It must not directly edit the generated snapshot.
It must not bypass failed Actions/tests.
It must not directly deploy production as part of the K completion write.
It must use only the already-sanitized Final K diary candidate and preserve the real work date.

### E. Production remains separate

Do NOT make a successful Markdown/snapshot workflow automatically:
- deploy `x-test-post`
- invoke scheduler
- post to X
- change DB/RLS/RPC/Auth/Vault/Cron/settings/secrets

If production needs the new snapshot, use the existing accepted single-function deploy gate after the generated snapshot is committed and accepted.

## Validation

At minimum verify:

1. Markdown-only change triggers the workflow.
2. Generator produces the expected snapshot.
3. parity passes.
4. valid recent date passes freshness.
5. impossible date fails or is rejected as expected.
6. sanitizer regression rejects/neutralizes prohibited internal material according to existing contract.
7. workflow does not recurse on its own snapshot-only commit.
8. failed test cannot push generated output.
9. unrelated files/functions are untouched.
10. no production deploy/post occurs.
11. existing K1-K4 routing and X-room G1/G2 isolation remain intact.

Prefer testing the workflow without using real X, real user deletion, Vault mutation, or production deploy.

## Today’s pending diary candidates

Do not lose the existing 2026-09-30 candidates. After the automation is working and safe, they may be used as the first end-to-end validation entry, but only if doing so does not require unsafe production mutation:

- iOS版で実データ接続とX認証の確認を進めたが、テスト用アカウントが既存接続と重なっていたため安全側で停止した。AIとの個人開発では、機能を進めること以上に「本番へ影響を出さない確認」に時間を使う日もある。
- 開発の進捗を自動投稿の題材として残せるよう、完了確認のたびに安全な開発内容を選別して共有メモへ回す運用を整えた。

Do not add internal identifiers to these entries.

## Completion / K4

Report:
- task_id
- result
- workflow/file changes
- exact trigger/permissions/concurrency design
- generator/tests reused
- tests and dry-run evidence
- whether a real Markdown->snapshot automatic run was validated
- commit_hash
- push
- production mutation (must remain 0 in this task)
- remaining issues
- safety checks
- updated normal K1-K4 operating flow
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K4.


## Direct implementation report

- task_id: x-ai-lab-diary-snapshot-automation-20261001
- result: **PASS / implemented directly by ChatGPT**。Claude開始前のready状態から、ユーザーの明示依頼によりChatGPTがGitHub connector経由で直接実装・E2E検証した。
- production_mutation: **0**。Supabase production deploy、scheduler invoke、X投稿、DB/RLS/RPC/Auth/Vault/Cron/settings/secret変更は行っていない。
- Codex review: **不要**。変更はGitHub Actions +運用文書のみで、実際のMarkdown→snapshot自動runをmain上で成功確認済み。

### implementation

- PR #64 `Automate AI Lab diary snapshot sync` を作成し、exact head `8b1f603c32e0e8843924c94bdfd7f849b5a6ca17` を squash merge。
- merge commit: `4ecb1330bd29c2120ceab06821adec5c0981f4de`
- added: `.github/workflows/ai-lab-diary-snapshot.yml`
- updated: `.agent/ORCHESTRATION.md`
- updated: `.agent/room_handoffs/X_AUTOPOST_CHAT.md`

### workflow contract

- trigger: mainへの `ai_lab_dev_diary_context.md` pushのみ + safe manual `workflow_dispatch`
- permissions: `contents: write` のみ
- concurrency: `ai-lab-diary-snapshot-main`, cancel-in-progress=false
- ChatGPTは通常の日記更新でMarkdown正本だけを直接編集し、snapshotは直接編集しない。
- workflowはcanonical generatorを実行し、生成前に日付・未来日・重複日・sanitizer完全一致を検証する。
- generator後にparity / freshness / calendar-date / sanitizer / brand profile / generator regressionを実行する。
- snapshot以外の生成差分が出たらfail。
- push直前にorigin/mainとのrace checkを行い、mainが進んでいればnon-fast-forward書き込みを拒否する。
- snapshot-only bot commitはMarkdown path triggerに一致しないため再帰実行しない。
- production deploy/postingはworkflowに含めない。

### real E2E validation

- ChatGPTが2026-09-30の公開安全な日記をMarkdownだけへ直接追記:
  - commit: `b0c4de4c5ae0386ce73b5cf8504d53be95584dda`
- GitHub Actions run: `36737155236`
- job/check: `sync` / success
- source validation: **5 public-safe entries validated** through 2026-10-01 JST
- generator: snapshot生成成功
- tests: **49/49 PASS, 0 FAIL**
- generated-file-only diff: PASS
- race check: PASS
- bot snapshot commit: `ee378347fe8c9d19a265291f91c17d8b7a42c2d8`
- bot commit changed exactly one file: `ai_lab_dev_diary_context.snapshot.ts`
- bot snapshot commit check-runs: 0（再帰workflow発火なし）

### normal K1-K4 operating flow

1. 各担当ChatGPTがK1/K2/K3/K4で開発日記候補を必ず判定。
2. 候補ありなら、公開安全なFinal K候補を実際の作業日付でMarkdown正本へChatGPTが直接追記。
3. GitHub Actionsがsnapshot生成と安全テストを自動実行。
4. PASS時のみsnapshotをbot commit。
5. 通常の日記更新はG3/G4を消費しない。
6. workflow失敗時だけ、修理が必要なら空きG3/G4へ修正TASKを作る。
7. production反映は別の安全ゲート。自動workflowからはdeployしない。

### remaining issue / explicit boundary

- GitHub上では新しい日記とsnapshotが同期済みだが、Supabase productionの既存 `x-test-post` bundleには、この新snapshotはまだ自動deployされない。
- live投稿AIへ新しい日記を反映する場合は、既存のsingle-function production deploy/read-back gateを別工程として行う。
- これはユーザーと合意した「生成・テストは自動化、production deployは別ゲート」の境界どおり。

### Completion

- status: done
- next_owner: none
- G4 slot: free after fresh allocation
