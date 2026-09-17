# Codex Task

- task_id: x-ai-lab-vault-token-refresh-production-deploy-20260917
- owner: codex
- slot: codex-1
- status: done
- next_owner: chatgpt
- priority: urgent
- recommended_model: Sol High
- purpose: C1でsource candidate・integration・read-only preflight・isolated runtime preflightまでPASSしたAI Lab専用Vault-backed refresh実装を、exact candidateから`x-test-post`のみに安全に本番反映し、runtime一致と自然slot結果を確認する。

## Final C1 review — 2026-09-17

**PASS — production deployment verified.**

確認済み:
- exact approved candidate `a7ffba4930a9eff3885ab29254f9858b80e71170` を `x-test-post` のみに本番反映。
- pre-deploy: ACTIVE v112 / `verify_jwt=false` / hash `ba0e7c78bd8cec62b4c8c2fe50bd1de80c7f3ecbaa1a1206c4e668f70012ab60`。
- post-deploy: ACTIVE v113 / `verify_jwt=false` / hash `f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4`。
- runtime read-backで `publishAiLabWithRefresh`、AI Lab Vault persistence、fixed AI Lab refs、`expectedRefreshToken`、fail-closed markersを確認。
- 他Edge Functionのversion/hash/timestamp変更なし。
- focused 30/30、full `x-test-post` + `_shared/brand` regression 474/474 PASS。
- candidate由来の新規type errorなし。fmt/diff-checkも対象範囲PASS。
- DB/schema/RPC/grant/Cron/settings変更0。
- manual X post、retry/backfill、manual refresh、OAuth再認可、manual Vault/token mutation 0。
- secret/token/Vault value output 0。
- rollback不要。

### Natural observation

- deploy直後に利用可能な次の自然AI Lab rowが無かったため、本番Cron経路でのpost-deploy自然slot結果はまだ未観測。
- これはdeploy検証のblockerとはしない。実装・deploy・runtime一致・安全境界は確認できているため本TASKは完了扱いとする。
- 次の自然slotは人工投稿・retry/backfillを行わずread-onlyで観測する。異常が出た場合だけ別タスクとして切り出す。

## Deployment completion — 2026-09-17

- Exact approved candidate `a7ffba4930a9eff3885ab29254f9858b80e71170` was deployed to `x-test-post` only with `verify_jwt=false` preserved.
- Post-deploy read-back: ACTIVE v113, source hash `f15bc31519a31181bb739504f9a24be895e7f5a95f01725bca15349db38349c4`; other Functions were unchanged.
- Focused 30/30 and full 474/474 regression suites passed. No manual post, retry/backfill, refresh request, OAuth action, or token/Vault mutation was performed.
- No post-deploy natural AI Lab row was available at read time; the next result must come from the existing Cron path. See `.agent/CODEX_REPORT.md`.
