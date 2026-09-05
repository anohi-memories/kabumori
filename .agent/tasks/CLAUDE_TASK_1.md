# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-trump-fed-trade-coverage-20260905
- owner: claude
- slot: claude-1
- status: done
- purpose: `breaking_market` の検索カバレッジ不足により、トランプ米政権の市場インパクト政策（特に「FRBが利下げしなければ貿易を止める」類の、貿易政策とFRBへの金利圧力が交差するニュース）を候補取得前に取りこぼす問題を最小差分で修正する。
- scope:
  - `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`
  - `supabase/functions/important-news-monitor/breaking_market_source_fetchers_test.ts`
  - 必要なら上記に直接関係するテストのみ
- forbidden:
  - `important-news-monitor` のP0.7 corporate X market-impact gateを開始・変更しない
  - `importance_judgement_logic.ts`、投稿生成、auto_publish、X投稿ロジックを変更しない
  - Cron頻度、DB schema/migration、本番設定を変更しない
  - `MAX_BREAKING_MARKET_SEARCHES_PER_FETCH=2`、1検索あたり`max_tool_calls=1`、許可ドメイン検証、24h freshness、actual visited URL検証など既存のコスト/安全ゲートを緩めない
  - 2026-09-05のmorning greeting failed claimや朝挨拶系を触らない
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria:
  - 現在の `trump_tariff_semiconductor` / 関連検索条件を精査し、「Trump / US trade policy / trade halt or restrictions / tariff or sanctions / Federal Reserve / Fed / rate cut or interest-rate pressure」の交差領域を取得対象にできる最小修正を実装する
  - 「Trump threatens to halt trade with countries if Fed does not cut rates」相当のニュースが、検索クエリの語彙・意図上明確にカバーされることをテストで固定する
  - 従来の関税・中国・日本・半導体・輸出規制の速報カバレッジを不必要に失わない
  - 6クエリのローテーション、最大2クエリ/20分サイクル、決定論的rotationを維持する
  - `BREAKING_MARKET_SOURCE_DOMAINS`、freshness、actual source URL validationを維持する
  - 既存テストと追加テストを実行し成功を確認する
  - 本番デプロイは行わない。実装・テスト・commit/push後、ChatGPTのK1レビュー待ちにする
- commit: 完了 `af73cf2`
- push: 完了
- deploy: 未実施（当タスクでは禁止。K1承認後のdeploy/自然cycle観測は別タスクとして扱う）
- report_mode: inline
- next_owner: chatgpt

## Background / verified production facts

- 本番 `important-news-fetch` Cronは `0,20,40 * * * *` でactive。2026-09-05 06:40 JST以降もfetchは正常完了しており、取得停止ではない。
- 2026-09-05朝の `breaking_market` もsource errorなしで実行されているが、新規候補0件が継続した。
- 現在の `trump_tariff_semiconductor` queryは `Trump tariff sanctions China Japan semiconductor export controls announcement today` で、今回のような「FRBへの利下げ圧力 × 貿易停止/制限」のニュースが語彙上の隙間に落ちる。
- 別のFed系queryは `Japan yen FX intervention Ministry of Finance emergency BOJ Fed rate decision today` で、実際のFed decision中心のため、大統領によるFed圧力と貿易政策の組合せを十分に拾えていない。
- Reutersは既存のallowed domainに含まれるため、今回の主因はドメイン拒否ではなく検索カバレッジ不足と判断している。

## Completion report

完了時はこのファイルの末尾に `## Report` を追加し、task_id / result / changed_files / tests / commit_hash / push / deploy / remaining_issues / safety_checks / next_recommendation を記録する。

## Report

- task_id: important-news-trump-fed-trade-coverage-20260905
- result: 実装・テスト・commit/push完了。`trump_tariff_semiconductor`クエリの検索語彙に「Federal Reserve rate cut pressure threat to halt trade」を追加し、「トランプがFRBに利下げを迫るため貿易停止を脅す」種のニュースがカバー範囲に入るよう修正した。クエリ数・rotation構造・コスト/安全ゲートは無変更。
- changed_files:
  - `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`（`trump_tariff_semiconductor`のsearchQueryのみ変更、他5クエリ・関数ロジックは無変更）
  - `supabase/functions/important-news-monitor/breaking_market_source_fetchers_test.ts`（新規2テスト追加: 語彙カバレッジ固定、クエリ数=6の固定）
- tests: important-news-monitor全体回帰 224/224 pass（`breaking_market_source_fetchers_test.ts`は20/20、新規2件含む）
- commit_hash: `af73cf2`
- push: 完了（origin/main反映済み、push前後でdrift確認済み）
- deploy: 未実施（scope指示どおり、K1レビュー後に別途判断）
- remaining_issues:
  - 実際のOpenAI web_search呼び出しでこの語彙変更が意図通りの候補を拾うかは、deploy後のfetch実行でしか確認できない（今回はunit testのみ、live fetchは未実施）
  - 「Trump threatens to halt trade with countries if Fed does not cut rates」に類する実例が今後の自然cycleで実際に拾われるかは継続観測が必要
- safety_checks:
  - `MAX_BREAKING_MARKET_SEARCHES_PER_FETCH=2`: 無変更（テストで確認）
  - `max_tool_calls=1`（1検索あたり）: 無変更、コード未接触
  - `BREAKING_MARKET_SOURCE_DOMAINS`: 無変更
  - 24h freshness window: 無変更（テストで確認）
  - actual visited URL検証: 無変更（テストで確認）
  - クエリ数=6、rotation構造: 無変更（新規テストで固定）
  - P0.7 corporate X market-impact gate: 未着手・未変更
  - `importance_judgement_logic.ts` / 投稿生成 / `auto_publish` / X投稿ロジック: 未接触
  - Cron頻度・DB schema/migration・本番設定: 未変更
  - 2026-09-05のmorning greeting failed claim・朝挨拶系: 未接触
  - 他workstreamの未コミット変更（`package.json`, `apps/admin/*`, `src/app/*`等）: 未stage・未commit
  - secrets: 非表示・非変更
- next_recommendation: K1レビュー後、問題なければ`important-news-monitor`をdeployし、次の自然fetch cycleでこのクエリが実際に候補を拾うかread-onlyで観測することを推奨。

## K1 Review

- reviewed_by: chatgpt
- decision: approved
- reason: scope内2ファイルのみの最小差分で、検索語彙の不足を補いながら既存語彙・6クエリ構成・2検索/20分上限・freshness/URL検証等の安全/コストゲートを維持している。追加テストで新旧カバレッジとクエリ数を固定し、全体回帰224/224 pass。commit `af73cf2` の差分も報告内容と一致。
- followup: 本番deployと自然fetch cycleでの実観測は別タスクとして扱う。
