# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-middle-east-oil-shipping-coverage-20260905
- owner: claude
- slot: claude-1
- status: done
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

## Report

- task_id: important-news-middle-east-oil-shipping-coverage-20260905
- result: 実装・テスト・commit/push完了。`war_geopolitics_taiwan`クエリの検索語彙に「Iran / Israel / Strait of Hormuz / oil tanker / maritime attack / energy infrastructure / CENTCOM」を追加し、「米軍がイランの原油タンカー3隻を攻撃」相当のニュースがカバー範囲に入るよう修正。あわせて、DNS解決で実在確認済みの`centcom.mil`・`defense.gov`をallowed domainsへ追加した。
- changed_files:
  - `supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts`（`war_geopolitics_taiwan`のsearchQueryのみ変更、`BREAKING_MARKET_SOURCE_DOMAINS`へ2ドメイン追加、他クエリ・関数ロジックは無変更）
  - `supabase/functions/important-news-monitor/breaking_market_source_fetchers_test.ts`（新規5テスト追加: 語彙カバレッジ固定、新ドメイン2件のallow確認、新ドメインでも「実際に訪問したURLのみ許可」ゲートが効くことの確認、無関係な`.mil`ドメイン(army.mil)が引き続き拒否されることの確認）
- tests: important-news-monitor全体回帰 **235/235 pass**（`breaking_market_source_fetchers_test.ts`は24/24、新規5件含む）
- commit_hash: `e67b825`
- push: 完了（origin/main反映済み、push前後でdrift確認済み）
- deploy: 未実施（scope指示どおり禁止。K1レビュー後に別タスクで対応）
- query_changes:
  - `war_geopolitics_taiwan`のsearchQuery: `"war ceasefire military conflict Taiwan Middle East breaking news today"` → `"war ceasefire military conflict Taiwan Middle East Iran Israel Strait of Hormuz oil tanker maritime attack energy infrastructure CENTCOM breaking news today"`
  - query数は6のまま変更なし（新規query追加なし、既存query語彙拡張のみ）
  - `MAX_BREAKING_MARKET_SEARCHES_PER_FETCH=2`、20分rotation、`max_tool_calls=1`、24h freshness: すべて無変更
- source_domain_changes:
  - `centcom.mil`・`defense.gov`を追加。両ドメインとも実装前にDNS解決を実施し、実在する`.mil`/`.gov`ドメイン（Akamai配信の政府インフラ）であることを確認済み。推測での追加ではない
  - 追加後もactual visited URL検証・https限定・freshness・categoryの全ゲートは無変更で適用される。テストで「allowlistにあるだけでは不十分（未訪問なら拒否）」「無関係な`.mil`ドメイン(army.mil)は引き続き拒否」の両方を確認済み
- safety_checks:
  - `MAX_BREAKING_MARKET_SEARCHES_PER_FETCH=2`: 無変更（テストで確認）
  - `max_tool_calls=1`（1検索あたり）: 無変更、コード未接触
  - 24h freshness window: 無変更
  - actual visited URL検証: 無変更・強化なし（新ドメインにも同一ゲートを適用しテストで確認）
  - クエリ数=6、rotation構造: 無変更
  - allowed domainsの追加は根拠（DNS解決確認）を伴う2件のみ。推測でのドメイン追加なし
  - importance judgement / generation / Voice retryロジック: 未接触
  - TDnet / company IR / market_macro取得: 未接触
  - auto_publish、X投稿ロジック、Cron、DB schema/migration/GRANT、本番設定: 未変更
  - morning greeting系: 未接触
  - model: 未変更
  - 他workstreamの未コミット変更・並行スロットの作業（Codex、Claude slot 2関連ファイル含む）: 変更・stage・commitなし。`git reset --mixed`でbranch pointerのみ移動し、他エージェントの編集は無傷を確認
  - secrets: 非表示・非変更
- remaining_issues:
  - 実際のOpenAI web_search呼び出しでこの語彙・ドメイン追加が意図通り候補を拾うかは、deploy後のfetch実行でしか確認できない（今回はunit testのみ、live fetchは未実施）
  - centcom.mil/defense.govが実際にOpenAIのweb_search経由でクロール可能か（curlでは403が返るが、これはBot対策の可能性が高く実際のOpenAI側クローラーの挙動は別途確認が必要）は継続観測が必要
- next_recommendation: K1レビュー後、問題なければ`important-news-monitor`をdeployし、次の自然fetch cycleでこのクエリ・ドメインが実際に候補を拾うか（特にcentcom.mil/defense.govが実際にクロール可能か）read-onlyで観測することを推奨。

## K1 Review

- reviewed_by: chatgpt
- decision: approved
- reason: 変更は `breaking_market_source_fetchers.ts` と直接対応テストに限定され、既存6-query rotation・2検索/cycle・20分rotation・24h freshness・max_tool_calls=1・actual visited URL検証・importance/generation/Voice/TDnet/IR/market_macro系を維持したまま、今回の実例に必要な Iran / Israel / Hormuz / oil tanker / maritime attack / energy infrastructure / CENTCOM 語彙を追加している。commit `e67b825` の差分はReportと一致し、centcom.mil / defense.gov 追加後も allowlist 単独では通らずactual visited URLが必須で、army.mil等の未許可ドメインは拒否されるテストがある。全体回帰235/235 pass。
- followup: 本番deployは別タスクで実施し、自然fetchで `war_geopolitics_taiwan` の実ヒットと、centcom.mil / defense.gov がOpenAI web_search経由で実際に利用可能かをread-only観測する。