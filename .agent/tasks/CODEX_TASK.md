# Codex Task

Codex（こでさん）専用の現在タスクです。`G` を受けたCodexは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルだけを自分の担当タスク正本として扱います。

- task_id: important-news-deploy-and-natural-cycle-verification-20260908
- owner: codex
- status: ready
- next_owner: codex
- purpose: 直前までにmainへ反映済みの重要ニュース取得改善・生成信頼性改善を `important-news-monitor` 本番へ安全にdeployし、自然20分サイクルで取得→判定→生成まで正常に通るかread-only確認する。
- priority: high

## Approved implementation commits

- freshness / coverage fix: `7bed84e063dbe5fc98bd0c12fa77720eead7936e`
- generation reliability fix: `710d5e8e42374a94fa163aac11098c6f02ce05ac`

両タスクはChatGPTレビュー済み。今回のタスクでは新機能実装や仕様変更を行わず、deployと本番観測に限定する。

## Pre-deploy checks

1. `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、本TASKを確認する。
2. `origin/main` が上記承認済み実装を含むことを確認する。
3. Claudeスロットや他workstreamが `important-news-monitor` の同一ファイル・同一Edge Functionを変更中でないことを確認する。競合があればdeployせず報告。
4. deploy対象差分が `important-news-monitor` に限定され、未承認のローカル変更・未コミット変更を含まないことを確認する。
5. 可能な範囲で直前のrelevant tests / diff checkを再確認する。新たな失敗が出たらdeployせず報告。

## Deployment scope

Supabase production projectの既存 `important-news-monitor` Edge Functionのみをdeployする。

許可:
- `important-news-monitor` Edge Function deploy
- deploy前後のversion/status read
- deploy後のlogs / DB rows / run diagnosticsのread-only確認
- 自然Cronサイクルの観測

禁止:
- production DB write / 手動row更新
- migration / DDL / GRANT
- Cron変更
- secrets変更・表示
- `x-test-post` その他Edge Function deploy
- auto_publish設定変更
- 過去failed candidateのstatus変更・再claim・再生成
- 手動で重要ニュース候補を注入すること
- X投稿を発生させる設定変更

## Natural-cycle verification

deploy後、原則として既存Cronによる自然20分サイクルを観測する。テスト目的の人工的なproduction candidate作成はしない。

最低限確認する内容:

### A. Function health
- deployした `important-news-monitor` がACTIVEであること。
- deploy直後に起動エラー・import error・依存解決エラーがないこと。
- Cron/fetchの既存実行が継続していること。

### B. Freshness / coverage diagnostics
自然cycleでbreaking laneが走った場合:
- `critical_market_events` が固定枠として選択されていること。
- query/provider diagnosticsが取得できること。
- raw/validated candidate countと主要rejection reasonが確認可能であること。
- 3時間freshness / event timestamp必須化による異常な全滅や例外がないこと。

market_macroが走った場合:
- fetch自体が正常完了すること。
- dedupe後cap / round-robin変更による例外や処理停止がないこと。

### C. Generation reliability
自然cycleで `important` / `most_important` が発生した場合のみ確認:
- generation claimが正常に行われること。
- TDnet略称/正式社名差だけで不当にFact failしないこと。
- Fact failが軽微かつretry可能な場合、`fact_retry` が最大1回だけ動くこと。
- retry後はlocal FactとAI Factを再検証していること。
- Voice retryを含め無限retryがないこと。
- 成功時 `ready_for_publish` 相当の既存正常状態へ進むこと。
- 失敗時は診断情報が残り、安全側に停止すること。

重要ニュースが観測時間内に1件も `important` にならない場合、人工的に作らず「generation自然確認は未成立」とReportする。

## Observation window

- deploy直後のhealth確認に加え、少なくとも自然20分cycleを2回以上確認する。
- 可能なら40〜60分程度の範囲で観測する。
- 長時間待機が必要な場合は、確認できた範囲をReportし、未成立項目を明記して `review_required` にする。

## X / publish safety

- `auto_publish` は変更しない。
- 現在のproduction設定を勝手にONにしない。
- `most_important` が生成されても、既存設定に従うだけで設定変更は禁止。
- X投稿を意図的に発生させるテストは禁止。

## Completion criteria

- deploy前競合チェック済み。
- 承認済みmainから `important-news-monitor` のみdeploy。
- deploy version/statusを記録。
- 自然cycleを最低2回観測、確認できたhealth/diagnosticsをReport。
- production DB/Cron/secrets/X設定の変更0。
- generation自然確認が成立したか未成立かを明確化。
- TASK末尾に `## Report` を追加。
- status: `review_required`
- next_owner: `chatgpt`

- commit: TASK/Report更新のみ許可
- push: TASK/Report更新は許可
- deploy: `important-news-monitor` のみ許可
- report_mode: inline
