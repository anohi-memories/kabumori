# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-middle-east-oil-shipping-coverage-20260905
- owner: claude
- slot: claude-1
- status: ready
- purpose: breaking_marketが、今回見逃した「米軍によるイラン原油タンカー複数隻への攻撃」相当の、軍事衝突＋原油輸送・海上交通・エネルギーインフラに直結する重要ニュースを安定して拾えるように検索カバレッジを最小差分で強化する。
- scope:
  - `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`
  - 直接対応するテストファイルのみ
  - 必要に応じて既存allowed-domain検証テストを最小修正
- forbidden:
  - P0.7 corporate X market-impact gateを開始しない
  - importance judgement / generation / Voice retryロジックを変更しない
  - TDnet / company IR / market_macro取得を変更しない
  - auto_publishを変更しない
  - X投稿実行・投稿ロジック変更をしない
  - Cron、DB schema/migration/GRANT、本番設定を変更しない
  - morning greeting系を変更しない
  - modelを変更しない
  - breaking_marketの最大検索数2/cycle、20分rotation、24h freshness、max_tool_calls=1を変更しない
  - actual visited URL検証を弱めない
  - 信頼できる根拠なしにallowed domainsを広げない
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria:
  - `war_geopolitics_taiwan` など既存の中東・戦争系検索が、少なくとも以下を明示的にカバーするよう改善する：Iran / Israel / Strait of Hormuz / Hormuz / oil tanker / crude tanker / oil shipping / shipping route / energy infrastructure / oil facility / maritime attack / CENTCOM 等
  - 今回の実例「米軍がイランの原油タンカー3隻を攻撃」「報復→タンカー攻撃→ホルムズ海峡通航悪化→原油上昇リスク」相当が検索語彙上の明確な対象になること
  - 既存の戦争・停戦・台湾・中東一般ニュースのカバレッジを落とさないこと
  - 既存allowed domains（Reuters / AP / Bloomberg / Nikkei等）は維持すること
  - CENTCOMや米国防総省の公式発表を一次情報として安全に使えるなら、実在する公式ドメインを確認したうえでallowed listへ追加してよい。ただし推測でドメインを追加しないこと
  - 公式ドメインを追加する場合は、そのドメインだけを理由に候補を信用せず、従来どおりweb_searchが実際に訪問したURLであること、https、freshness、category等の全安全ゲートを維持すること
  - query総数をむやみに増やさず、既存6-query rotation / 最大2検索/cycleを維持すること。可能なら既存queryの語彙拡張で対応すること
  - 変更に対するunit testを追加し、今回の語彙（Iran/Hormuz/tanker/oil shipping等）と公式source domain追加がある場合はそのallow/deny挙動を固定すること
  - important-news-monitor全体テストを実行して回帰なしを確認すること
  - 実装後、最小差分でcommit/pushしてよい
  - 本番deployは禁止。K1レビュー後に別タスクでdeployする
- commit: 今回のClaude slot 1作業として安全に分離できる最小差分のみ
- push: fresh-checkで競合がなければorigin/mainへpushしてよい。drift/競合があれば停止して報告
- deploy: 禁止。K1承認後に別タスク化
- report_mode: inline
- next_owner: chatgpt

## Background / production gap

2026-09-05夜、ユーザーがChatGPTの「株式材料総合監視」で受け取った以下のような重要ニュースを、かぶモリ本番のbreaking_marketが拾えていないことを確認した。

- 米中央軍（CENTCOM）が、米軍がイランの原油タンカー3隻を攻撃したと公式発表
- イランによる米海軍艦艇への弾道ミサイル攻撃への報復とされる
- AP報道では複数隻が航行不能/破壊
- 日本株への主要リスクは、軍事衝突そのものに加えて、原油輸送資産への攻撃拡大→ホルムズ海峡の通航悪化→原油上昇→日経平均/航空/陸運/化学/電力ガス等への波及

現行 `war_geopolitics_taiwan` query は `war ceasefire military conflict Taiwan Middle East breaking news today` で、中東戦争一般は対象だが Iran / Hormuz / tanker / oil shipping / energy infrastructure / maritime attack が明示されていない。

現行 allowed domains は Reuters / AP / Bloomberg / Nikkei / MOF / BOJ / Federal Reserve / USTR / White House / Commerce / BIS / State / BLS / BEA / Treasury 等で、CENTCOM / DoD系公式ドメインは少なくとも現在のリストには無い。

ユーザー方針：こうした「軍事衝突＋原油輸送・ホルムズ海峡・エネルギーインフラ」のニュースは、個別企業IRよりも日本株全体への影響が大きく、かぶモリが優先的に拾うべき重要材料とする。

## Safety intent

目的は検索カバレッジ強化のみ。重要度判定を甘くしたり、出所検証を弱めたり、検索回数を増やしてコストを膨らませる変更はしない。

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / changed_files / tests / commit_hash / push / deploy / query_changes / source_domain_changes / safety_checks / remaining_issues / next_recommendation を記録し、statusを `review_required` にする。
