# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-trump-fed-trade-coverage-20260905
- owner: claude
- slot: claude-1
- status: ready
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
- commit: 必須。今回のscopeだけを最小差分でcommitする
- push: 必須。fresh-check後にmainへpushする
- deploy: 禁止。K1レビュー後に別途判断する
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
