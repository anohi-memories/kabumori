# Codex Task 2

- task_id: x-close-report-topix-source-correction-20260911
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol High
- purpose: X版 close_report の誤った Yahoo `^TPX` 利用を停止し、正式TOPIX取得元が未確定の間も大引けレポートを安全に稼働させる。

## C2 Review — 2026-09-12

### Review result

- root cause確認: **approved**
- `^TPX` rejection / metadata validation: **approved**
- tests: **approved**（targeted 61/61、full 385/385、deno check / diff check PASS）
- production deploy: **未実施で正しい**
- overall task: **follow-up required**

理由:
- Yahoo `^TPX` は日本のTOPIXではなく、TOPIXとして使用してはいけない。
- 現在のcommit `9b8b14379eb013052b60833a28df142e7ff3fb2c` は誤データ排除として正しい。
- ただし `topix: null` のまま本番deployすると、既存live close_reportはTOPIX必須gateにより恒常的に `CLOSE_REPORT_CLOSE_DATA_UNAVAILABLE` で停止する。
- JPX公式の公開ページではTOPIX自体はリアルタイム算出されるが、現行システムから無認証で安全に使えるsame-day structured endpointは確認できていない。公式TOPIX Web Serviceは別サービスとして扱われるため、今回は新規契約/credential前提にしない。

## Follow-up F1: temporary production-safe proxy

正式TOPIX sourceが確保できるまで、X大引けでは **TOPIX連動ETF（1306）** を代替の市場比較指標として使用する。

重要:
- 1306を「TOPIX」と表示してはいけない。
- ラベルは必ず `TOPIX連動ETF（1306）` 等、ETFであることが明白な表現にする。
- Fact prompt / Voice / generated copyにも「TOPIX」と誤認させない。
- 「TOPIXは◯%」のような表現は禁止。代替指標であることを保持する。

### Data source

- Yahoo structured chartの `1306.T` を利用可。
- same JST trading date
- numeric/source-backed
- close report live時は15:30 JST以降の確定sessionとして扱えること
- previous-day / unknown timestamp / metadata mismatchはreject
- symbol / exchange / currency metadataを検証し、1306.T / Tokyo-JPX系 / JPY の整合を確認する

### Implementation

最小変更で以下を行う。

1. 現在の `^TPX` rejectは維持する。
2. close data acquisitionで `1306.T` を取得し、ラベルを `TOPIX連動ETF（1306）` とする。
3. required market comparison gateは、日経平均 + この明示ラベルの代替指標で成立させる。
4. close reportのprompt / Fact basis / diagnostics / source URLも同じラベルに揃える。
5. `TOPIX` 固定文字列を前提とするvalidationがある場合は、指数名の偽装なしで安全に一般化する。
6. 17:00 schedule、Nikkei取得、Fact/Voice/X publish gateは変更しない。
7. morning_reportやpersonalized-reportsは変更しない。

### Required tests

- `^TPX` remains rejected
- 1306.T valid same-day close accepted as `TOPIX連動ETF（1306）`
- 1306.T is never labeled `TOPIX`
- 15:29以前reject
- previous-day reject
- wrong symbol/exchange/currency reject
- Nikkei + 1306 valid => live close data gate passes
- missing 1306 => fail closed
- prompt / Fact basis contain correct ETF label
- no generated-path test expects false `TOPIX` label
- targeted close tests
- full x-test-post regression
- deno check
- git diff --check

## Production

実装・テスト合格後は `x-test-post` のみ本番deploy可。

- fresh origin/main
- clean temporary worktree
- project ref `wsmznyzcvmuitkglfeuj`
- `--no-verify-jwt`
- deploy後 `functions download x-test-post --use-api`
- runtime files byte compare
- 他Edge Function versions/updated_at不変確認

禁止:
- 手動close_report実行
- 手動X投稿
- OpenAI/X API手動呼び出し
- DB/migration/RLS/RPC変更
- Cron/scheduler/posting_windows変更
- secrets/OAuth/Vault/social_accounts変更
- personalized-reports変更
- important-news/Push変更

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT_2.md` にFollow-up F1 Report追記
- origin/main同期

Report必須:
- proxy_source_validation
- label_invariants
- code_changes
- tests
- production_deploy
- deploy_verification
- unchanged_scopes
- commit_hash
- remaining_issues（正式TOPIX sourceへの将来差替えを含む）
