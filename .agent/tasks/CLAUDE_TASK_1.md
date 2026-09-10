# Claude Task 1

- task_id: broader-stock-news-coverage-phase3-market-relevance-20260911
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: トランプ政権・関税・戦争/停戦・制裁・半導体規制・原油などの市場全体ニュースを、全ユーザーへ無差別に出さず、保有/監視銘柄との関連性に応じてアプリ `/news` へ安全に表示できる仕組みを作る。X投稿量とPush配信量は今回増やさない。

## Context

Phase 1/2はChatGPTのK1レビューで完了承認済み。

現在:
- app severity `critical / high / medium / low` は既存判定結果から決定論的に導出できる
- `/news` は個別銘柄について critical/high/medium を表示できる
- 従来rejectedだった保有者向けmediumニュースも安全条件付きで表示可能
- market-wide（company_codeなし）は、関連付けが無いため全ユーザー表示を意図的に除外中
- X publish gate、Push producer、Cron、auto_publishは従来どおり
- important-news-monitor v38、send-push-notifications v4

## Product principle

**市場全体ニュースも拾う。ただし、関係のあるユーザーだけに見せる。**

トランプ発言、関税、戦争、停戦、制裁などを人物名・キーワードだけで無差別配信しない。日本株/米株/為替/金利/原油/半導体/特定業種への伝播経路を説明できるものを対象とする。

## Model

関連性設計、既存severity、stocks_master sector、SQL/RPC、X/Push安全境界を横断するため **Opus 5** を使用する。Sonnet系へ落とさない。

## Required startup checks

1. PROJECT_RULES.md
2. .agent/ORCHESTRATION.md
3. .agent/CURRENT_STATE.md
4. このTASK
5. origin/main fresh-check
6. shared checkout / clean worktree確認
7. 他slot TASKをread-only確認
8. Claude slot 2はx-oauth-connect作業中。OAuth/Vault/social_accounts/同じmigrationやproduction設定には触れない
9. Codex2はx-test-post作業。x-test-postには触れない
10. 他slotが important_news_candidates schema、get_my_important_stock_news、stocks_master sector、alert_settings、important-news-monitor を変更中なら競合確認。安全に分離できない場合は開始せず報告
11. migration history乖離を再確認し、blind db push禁止
12. 既存未コミット差分には触れない

## Phase 3A: Existing data / schema audit

実装前にread-onlyで確定する。

- market-wide候補で既に保存されている `affected_entities`、category、judgement_reason、source_type、title/body_summary等
- `stocks_master` の sector / market 等、ユーザー銘柄との突合に使える既存列と実データ品質
- `tracked_stocks` の tracking_type（holding/watch）と active条件
- Phase 2 RPCとseverity導出関数
- 直近market-wide候補の件数と代表例
- トランプ/関税/戦争/停戦/制裁/半導体規制/原油などで、既存データだけから安全に affected_assets / affected_sectors を導ける範囲

## Phase 3B: Deterministic relevance mapping

新規AI呼び出しは追加せず、可能な限り決定論的に市場ニュースの影響タグを導出する。

最低限検討するタグ:
- assets: japan_equities, us_equities, usd_jpy, jpy, rates, oil, lng, semiconductors, shipping など
- sectors: semiconductors, autos, exporters, banks, trading_companies, energy, airlines, shipping, defense など

代表マッピング例:
- 米国の対日自動車追加関税 → autos / exporters / japan_equities
- 対中半導体・AI輸出規制 → semiconductors
- 台湾海峡緊張 → semiconductors / shipping / japan_equities
- 中東戦闘拡大・ホルムズ障害 → oil / lng / shipping / airlines / energy
- 停戦・制裁解除 → oil等への逆方向影響も「対象」として関連付ける。方向性の投資助言までは行わない
- FRB/日銀サプライズ → rates / usd_jpy / banks / exporters / japan_equities
- 単なる政治発言で具体策・市場伝播経路なし → 関連付け対象外

重要:
- sector名の表記揺れを監査してから対応する
- キーワード1個だけでcritical判定しない
- relevanceは「表示対象か」を決める補助であり、売買方向を推奨しない
- source/fact basisが弱いニュースはfail closed

## Phase 3C: App feed integration

`get_my_important_stock_news` を最小変更し、以下を満たす。

1. 個別銘柄ニュース: Phase 2の挙動を完全維持
2. market-wide: company_codeなしでも、ユーザーのactive tracked stockのsector等とaffected sectorが一致する場合のみ表示候補
3. market-wideは原則 severity critical/high のみ。mediumを入れるなら明確な理由をReportし、ノイズ増加を実データで評価
4. market-wideを全ユーザーへ無差別表示しない
5. 同じmarket-wideニュースが複数保有銘柄に一致してもfeedではnews_id単位で1件にdedupe
6. 可能なら `relevance_reason` または `matched_sector` を戻り値へ追加。ただしapp互換を壊さない
7. order/limit既存維持。critical/highがmediumに埋もれない並びも検討し、変更する場合は明示する

### holding / watch

今回は表示についてはactive holding/watchどちらも関連銘柄として扱ってよい。ただしReportで件数差を出す。

Push差分はまだ有効化しない。

## Phase 3D: Optional market alerts setting design

将来の全体アラート用 `market_alerts` 設定案を設計する。

- 既定OFFを推奨
- これを理由に今回全ユーザーPushはしない
- alert_settings migrationを今回追加する必要が無ければ設計だけに留める

## Required tests

最低限:
- tariff -> autos/exporters関連ユーザー positive
- semiconductor export control -> semiconductor関連 positive
- war/Hormuz/oil shock -> energy/shipping/airline関連 positive
- FRB/BOJ surprise -> relevant sector/asset positive
- unrelated sector user negative
- market-wide全ユーザー表示なし
- company_codeなしでも関連性があれば表示
- 同一newsの複数sector matchでfeed重複なし
- weak/unknown relevance fail closed
- low severity negative
- individual stock feed Phase 2 regression
- other-user/inactive/untracked negative
- duplicate_of exclusion
- order/limit/return shape compatibility
- X publish gate unchanged
- Push producer unchanged / notifications増加なし
- important-news-monitor regression
- SQL parity/static checks where applicable
- app tsc --noEmit
- git diff --check

## Production rule

監査・実装・テストPASS後に限り、**必要最小限のDB migration/RPC更新のみ本番適用可**。

- `supabase db push` 禁止
- 対象migrationを単独・トランザクションで適用
- 事前にrollback付き本番データ検証
- `important-news-monitor` Edge deploy禁止
- `send-push-notifications` deploy禁止
- `x-test-post` deploy禁止
- Cron/auto_publish/secrets/OAuth変更禁止
- Push producer変更禁止

本番適用後:
- RPC/関数定義・ACLをread-only確認
- 本人feedで関連market-wideがあれば自然データで確認
- 無ければrollback付き既存market-wideデータで関連ユーザー条件を証明してよい
- 非関連ユーザーへ漏れないことを確認
- 個別銘柄feedの既存表示を壊していないことを確認
- notifications増加0
- X/Cron/auto_publish unchanged

## Forbidden

- X publish基準変更
- X投稿量増加
- Push配信対象拡大
- market-wide全ユーザーPush
- 新しいAI API呼び出し
- 無制限web検索追加
- artificial candidate本番投入
- candidate status変更/削除
- destructive migration
- OAuth/Vault/social_accounts変更
- x-test-post変更
- dispatcher変更

## Completion

完了時:
- status: review_required
- next_owner: chatgpt
- Report追記・origin/main同期

Report必須:
- task_id
- result
- model_used
- market_data_audit
- sector_data_audit
- relevance_mapping
- chosen_implementation
- schema_or_rpc_changes
- individual_feed_regression
- market_wide_feed_behavior
- existing_data_proof
- holding_vs_watch_result
- tests
- x_publish_invariants
- push_invariants
- production_apply_method
- production_verification
- changed_files
- commit_hash
- push
- remaining_issues
- safety_checks
- phase4_recommendation

## Report

- task_id: broader-stock-news-coverage-phase3-market-relevance-20260911
- result: **完了**。市場全体のニュース（company_code なし）を、全ユーザーへ一律に出すのではなく、**ユーザーのアクティブな登録銘柄の業種に波及する場合だけ** `/news` に表示するようにした。対応付けは、判定がすでに保存している列（カテゴリ・見出し・`affected_entities`）から決定論的に導く SQL 関数で行い、AI呼び出し・取得元・行の更新は追加していない。本番に単独のトランザクションで適用した。本人フィードでは、Phase 2 の個別銘柄5件を1件も変えずに、関連する市場ニュース7件（為替・関税・雇用統計）が加わった。X投稿・Push・Cron・auto_publish は無変更で、notifications は0件のまま。
- model_used: Opus 5

### market_data_audit

本番の市場全体の候補（company_code なし・重複除外・判定済み）は109件:
- severity 別: critical 4 / high 14 / medium 8 / low 83
- カテゴリ別: boj 39 / geopolitics 26 / war_ceasefire 16 / major_security_incident 5 / fx 4 / frb 4 / other_market_moving 4 / tariffs 3 / us_government_policy 3 / semiconductor_ai 2 / interest_rates 2 / sanctions 1
- 保存済みの材料: `category`、`title`、`body_summary`、`affected_entities`（jsonb の配列。例: `["米国","イラン","ホルムズ海峡","原油市場","ドル円"]`）、`japan_market_relevance`、`fact_check_status`、`judgement_reason`
- critical / high の代表例:
  - 「Ambassador Greer Issues Statement on President Trump's Response to Canada」（tariffs、critical、entities に「自動車」）
  - 「U.S. military says it struck three Iranian oil tankers」（critical、原油・海運）
  - 「Yen advances sharply, gaining about ¥5 against the dollar」（fx、high、関連度 high）
  - 「U.S. August payrolls rise by 162,000」（high、FRB・金利・為替）
  - 「Japan finance minister says no formal U.S. request for coordinated FX intervention」（fx、high）
  - 「World News in Brief: US-Iran war intensifies」（critical だが、見出し・entities に伝わり方の記載なし）
  - 「UN chief demands Israeli withdrawal from Lebanon」（high だが関連度 low＝判定自身が「日本株への具体的な影響は確認できない」）

### sector_data_audit

- `stocks_master.sector` は**東証33業種の日本語名で統一**されている（34通り＝33業種＋NULL）。表記揺れは無し（「証券、商品先物取引業」の読点だけ注意し、そのままの表記で対応付けた）。
- 業種が空の銘柄: 4,434件中542件（約12%）。業種が空の銘柄は、市場ニュースの対応付けの対象にならない（fail closed）。
- `tracked_stocks`: `tracking_type` は holding / watch、`is_active` で有効・無効を判定。
- 本人の登録20件（すべて active）の業種: 電気機器6（キオクシアHD・日立・ソニーG・アドバンテスト・東京エレクトロン…）/ 情報・通信業5 / 銀行業3 / サービス業3 / 機械2（ディスコ・三菱重工）/ 輸送用機器1（トヨタ）/ 小売業1 / その他製品1（任天堂）。保有（holding）の2件は、どちらもサービス業。

### relevance_mapping

`public.important_news_market_themes(category, title, affected_entities) → text[]`（テーマ）と、`public.important_news_theme_sectors(themes) → text[]`（東証33業種）。テーマは、**カテゴリ**、または見出し・entities に**伝わり方を示す明示的なキーワード**がある場合だけ付く。英単語は単語境界つき（`\y…\y`）で照合するので、「Aid」が AI に、「Carson」が cars に誤って当たることは無い。

| テーマ | 付く条件（カテゴリ / キーワード例） | 業種 |
|---|---|---|
| oil_energy | 原油・石油・ブレント・WTI・OPEC・LNG・天然ガス・エネルギー・ホルムズ・タンカー / oil・crude・hormuz・tanker | 鉱業・石油・石炭製品・電気・ガス業・海運業・空運業・卸売業 |
| shipping | 海運・航路・海峡・紅海・港湾・船舶 / shipping・strait・vessel・maritime・port | 海運業・倉庫・運輸関連業 |
| semiconductors | カテゴリ semiconductor_ai / 半導体・チップ・輸出規制・台湾 / chip・export controls・taiwan・SOX・AI | 電気機器・機械・化学・精密機器 |
| autos | 自動車 / auto・automaker・vehicle・car | 輸送用機器・ゴム製品 |
| trade | カテゴリ tariffs / 関税・通商 / tariff・duties・trade war | 輸送用機器・電気機器・機械・精密機器（輸出企業） |
| fx | カテゴリ fx / 円高・円安・ドル円・為替・介入 / yen・USD/JPY・intervention | 輸送用機器・電気機器・機械・精密機器（輸出企業） |
| rates | カテゴリ boj・frb・interest_rates / 日銀・金利・利上げ・利下げ・国債・FRB・FOMC・雇用統計 / fed・yields・treasury・payrolls・CPI | 銀行業・保険業・証券、商品先物取引業・その他金融業・不動産業 |

タスクの代表例との対応:
- 米国の対日自動車追加関税 → autos + trade → 輸送用機器・ゴム製品・電気機器・機械・精密機器（関数の単体テストで確認）
- 対中の半導体・AI輸出規制 → semiconductors → 電気機器・機械・化学・精密機器
- 台湾海峡の緊張 → semiconductors（「台湾」）。海運は「海峡」「航路」などの語があれば付く
- 中東の戦闘拡大・ホルムズの障害 → oil_energy + shipping → 鉱業・石油・電気ガス・海運・空運・卸売・倉庫運輸
- 停戦・制裁解除 → 原油などに言及があれば oil_energy（**方向は持たない**。「停戦で原油が下落」も同じテーマ）
- FRB・日銀のサプライズ → rates（＋円への言及があれば fx）
- 具体策や伝わり方の無い政治的発言・戦争の見出し → **テーマ無し＝誰にも表示しない**

防衛（defense）は、33業種では防衛関連企業を特定できない（三菱重工は「機械」、川崎重工は「輸送用機器」）ため、今回は対応付けていない（phase4_recommendation）。japan_equities・us_equities などの資産タグは、業種と結び付かない限りユーザーに届け先が無いので、今回は表示の判定に使っていない（使うと、全ユーザーへの一律表示と同じになるため）。

「キーワード1個だけで critical にしない」について: テーマのキーワードは「誰に見せるか」を決めるだけで、severity は決めない。市場ニュースが表示されるには、別途、**判定（AI）が critical / high（Fact passed）と判断し、かつ日本への関連度を medium 以上と判断していること**が必要。

### chosen_implementation

**SQL の関数による導出**（Phase 2 と同じく、RPC の読み取り時に計算）。列の追加・保存・バックフィルは無し。理由は Phase 2 と同じで、判定コード（`important-news-monitor`）の変更と deploy が不要であり、既存行を書き換えないため。

市場ニュースが表示される条件（**すべて**を満たす場合だけ）:
1. company_code が無い（市場全体のニュース）、`duplicate_of is null`
2. 状態が判定済みの X 級（ready_for_generation / generating / ready_for_publish / generation_failed / publishing / publish_failed / published）。**rejected は対象外**
3. severity が **critical / high** のみ（medium は入れない）
4. `japan_market_relevance` が medium / high（判定自身が「日本への影響がある」と述べている）
5. テーマが1つ以上あり、その業種がユーザーのアクティブな登録銘柄の業種と一致する

同じニュースが複数の銘柄に一致しても、`DISTINCT ON (news_id)` で1件にまとめる（保有を監視より優先し、その後は業種名・ticker 順で決定的に選ぶ）。

**medium を入れなかった理由**: 市場ニュースの medium は、Fact が未確定の Web 検索結果が中心（タンカー攻撃・原油100ドル超・半導体材料の輸出措置など）。本人の業種に一致する medium は5件あり、入れると市場ニュースは7件から12件になる。未確定の二次情報を業種経由で広く見せるのは、現段階ではノイズと誤情報のリスクが高いと判断した。

### schema_or_rpc_changes

`supabase/migrations/20260911120000_market_relevance_news_feed.sql`（1トランザクション）:
1. 新規 `public.important_news_market_themes(text, text, jsonb) returns text[]`: IMMUTABLE・PARALLEL SAFE・`search_path=''`。entities が配列でない場合は無視する。
2. 新規 `public.important_news_theme_sectors(text[]) returns text[]`: IMMUTABLE・PARALLEL SAFE・`search_path=''`。
3. 上の2つは public / anon / authenticated / service_role から `revoke all`（SECURITY DEFINER の RPC からだけ使う）。
4. `public.get_my_important_stock_news(integer)` を作り直した。戻り値の末尾に `matched_sector text`、`relevance_reason text` を追加したため、同じトランザクションの中で `DROP` → `CREATE`。SECURITY DEFINER・`search_path=''`・STABLE・権限（authenticated のみ）・並び順・件数上限は同じ。
- 市場ニュースの行は `ticker_code = null`、`company_name = '市場全体'`、`tracking_type` は一致した登録銘柄の種別、`matched_sector` = 一致した業種、`relevance_reason` = テーマ（例: `fx,rates`）。個別銘柄の行では、新しい2列はどちらも null。
- テーブル・列・制約・RLS・既存行の変更なし。`notifications`・Cron・auto_publish・`x_post_id` には一切触れない（静的テストで固定）。

アプリ（最小限の変更）:
- `src/lib/important-news.ts`: `ticker_code` を `string | null` に、`matched_sector?` と `relevance_reason?` を追加
- `src/app/news.tsx`: 市場ニュースは、種別バッジを「市場」、ticker の位置に「関連: {業種}」と表示する。個別銘柄の表示は Phase 2 のまま
- 古いアプリでも動く（知らない列は無視され、市場ニュースは会社名「市場全体」、ticker は空、種別は一致した登録銘柄の保有/監視として表示される）
- `tsc --noEmit`: `src/` のエラー0件

### individual_feed_regression

- 個別銘柄部分の SQL は、Phase 2 の migration と**空白・コメントを除いて同一**（静的テストで、Phase 2 のファイルと比較して固定）
- 本番データのロールバック付きテスト: 適用前の Phase 2 の RPC の出力を、同じトランザクションの中で一時テーブルに記録してから置き換え、比べた → Phase 2 の5件がすべて同じ severity で残り、欠落0、追加0
- 適用後の本番: 個別銘柄の行は5件で、Phase 2 と同じ（high 1 = ソフトバンクG の社債 / medium 4 = NTT・トヨタ・ソニーG・日立の自己株式取得状況）

### market_wide_feed_behavior

本人フィードに加わった市場ニュースは7件（すべて監視銘柄経由）:

| severity | テーマ | 一致した業種 | 見出し |
|---|---|---|---|
| critical | autos, trade | 機械 | Ambassador Greer Issues Statement on President Trump's Response to Canada |
| high | trade | 機械 | Canada strikes back with tariffs on about $20 billion worth of U.S. goods |
| high | fx | 機械 | Japan's official reserve assets fell by $79.6 billion at end-August |
| high | fx, rates | 機械 | U.S. August payrolls rise by 162,000, exceeding expectations |
| high | rates | 銀行業 | U.S. payrolls increased by 162,000 in August; unemployment rate held |
| high | fx | 機械 | Japan finance minister says no formal U.S. request for coordinated FX intervention |
| high | fx | 機械 | Yen advances sharply, gaining about ¥5 against the dollar over two days |

表示されなかったもの（正しく除外）:
- 原油・海運のテーマで本人の業種に一致しないもの5件: 米軍によるイランのタンカー攻撃（critical ×2）、ホルムズ海峡の船舶運航の低迷、レバノン空爆とホルムズのタンカー乗員の行方不明、プーチン氏のキーウ攻撃72時間停止（エネルギー市場）。本人は海運・鉱業・空運・電気ガス・卸売・石油を登録していない
- テーマが無い（伝わり方の記載が無い）critical / high の戦争の見出し4件: 「World News in Brief: US-Iran war intensifies」「Trump calls Iran conflict 'small potatoes'」など
- 関連度 low の high（国連のレバノン情勢など）
- severity medium の5件（上記の理由で意図的に除外）

### existing_data_proof

migration を丸ごと本番データの上でトランザクション内に実行し、最後に例外を投げて**必ずロールバック**するテストを、適用前に行った（その後、Phase 3 の関数が0件、RPC が Phase 2 の11列のまま、アクティブな登録が20件であることを確認）。人工の candidate は作っていない。登録の無効化も、トランザクション内だけで行った。

| # | 項目 | 結果 |
|---|---|---|
| 単体 | 対日自動車関税 → テーマ | autos, trade → 業種 ゴム製品・機械・精密機器・輸送用機器・電気機器 |
| 単体 | 半導体の輸出規制 | semiconductors |
| 単体 | ホルムズの封鎖・タンカー・原油 | oil_energy, shipping → 倉庫運輸・卸売・海運・石油・空運・鉱業・電気ガス |
| 単体 | 日銀の予想外の利上げ / FRB の緊急利下げ | rates / rates |
| 単体 | 円急落での為替介入 | fx |
| 単体 | 停戦で原油が下落 | oil_energy（方向なし） |
| 単体 | 政治的な雑談 / 伝わり方の無い戦争の見出し | テーマ無し / テーマ無し |
| 単体 | 「Aid convoy reaches Carson; relationship talks」（単語境界） | テーマ無し |
| 単体 | entities が配列でない / テーマが空・NULL | テーマ無し / 業種無し |
| 1 | Phase 2 の個別銘柄フィード | 5件 → 5件、欠落0・追加0（severity も一致） |
| 2 | 本人フィード | 12件（個別5 + 市場7）、distinct 12 |
| 3 | 市場の行で critical/high 以外 / 関連度 low / company_code あり / 本人の業種外 / 重複 | すべて0 |
| 3 | 伝わり方の無い critical（World News in Brief） | 表示されない |
| 4 | 市場の medium のうち本人の業種に一致するもの（ノイズ評価） | 5件（入れていない） |
| 5 | 並び順 / `p_limit=1` / `p_limit=0` | 新しい順 / 1件 / 1件に補正 |
| 5 | 権限: authenticated の RPC 実行 / anon / テーマ・業種の関数を authenticated が直接実行 / SECURITY DEFINER | true / false / false・false / true |
| 6 | **無関係な業種のユーザー**（サービス業の保有2件だけをアクティブにした状態） | 市場ニュース **0件** |
| 7 | 他ユーザー / 未ログイン | 0 / 0 |

### holding_vs_watch_result

- 市場ニュースの一致: **保有（holding）0件 / 監視（watch）7件**
- 理由: 保有の2件（ファルコHD・サイバーエージェント）はどちらもサービス業で、今回のテーマ（原油・海運・半導体・自動車・通商・為替・金利）はサービス業に対応付けていない。監視の18件には、電気機器・機械・輸送用機器・銀行業が含まれる
- 同じニュースが保有と監視の両方に一致した場合は、保有として表示する（`DISTINCT ON` の優先順位）
- Push は、保有・監視とも今回は有効化していない

### tests

- `market_relevance_sql_static_test.ts`（新規・5件）:
  - 個別銘柄部分の SQL が、Phase 2 の migration と同一
  - 市場ニュースの条件（company_code なし・重複除外・関連度 medium/high・severity critical/high のみ・rejected を含まない・`DISTINCT ON`・本人・アクティブ・業種の一致・テーマ必須）
  - 対応付けに使う業種名が、すべて実在する東証33業種名
  - 1トランザクション・行の書き込み無し・権限モデル・SECURITY DEFINER・`search_path=''`・並び順と件数上限
  - `notifications`・`net.http_post`・`cron.`・`auto_publish`・`x_post_id` に触れていない
- `news_severity_sql_parity_test.ts`（Phase 2・4件）: 無変更で通過
- 本番データのロールバック付きテスト: 上表のとおり全項目が期待どおり
- important-news-monitor 全体の回帰: **323 passed / 0 failed**（X 公開ゲート・producer・対象判定・重複防止を含む）
- リポジトリ全体の Deno テスト: 734 passed / 0 failed
- アプリ: `tsc --noEmit` で `src/` のエラー0件
- `git diff --check`: clean

### x_publish_invariants

- `important-news-monitor` のコード変更なし、Edge deploy なし（v38 のまま）
- `checkPublishCandidate`・auto_publish・cutover・rate control は無変更。`importance` を書き換える処理なし
- 今回の変更は、アプリの読み取り用 RPC の中だけで閉じている
- 確認: `auto_publish = true`、設定の `updated_at`（2026-09-10 08:53:08）は変化なし

### push_invariants

- `send-push-notifications`（v4）と producer は無変更。市場ニュースから通知は作らない（全ユーザーへの Push も、関連ユーザーへの Push も無し）
- 確認: 適用の前後とも **notifications = 0**。Cron は8本すべて active で変化なし

### production_apply_method

- `supabase db push` は使っていない（本番の migration 履歴の乖離が続いているため）
- 適用の直前にroot安全確認: `pwd` = worktree、HEAD `1e30278`、worktree 内の `supabase/config.toml`、linked project ref `wsmznyzcvmuitkglfeuj`
- `supabase db query --linked -f <絶対パス>` で、今回のファイル1本だけを適用した（ファイル自体が `begin; … commit;`）
- 事前に、同じ内容をロールバックするトランザクションで本番データに対して実行し、結果を確認してから適用した
- `schema_migrations` には記録していない（これまでの個別適用と同じ扱い）

### production_verification

適用後に read-only で確認:
1. RPC: 列 = news_id, ticker_code, company_name, tracking_type, title, summary, importance, news_time, source_url, severity, **matched_sector, relevance_reason**。SECURITY DEFINER・`search_path=""`・ACL `{postgres=X/postgres,authenticated=X/postgres}`。anon は実行不可
2. 関数4つ（Phase 2 の2つ＋今回の2つ）: どれも IMMUTABLE、ACL は `{postgres=X/postgres}` だけ
3. 本人フィード: 12件（個別5・市場7）、distinct 12。個別銘柄の5件は Phase 2 と同じ。市場の7件は上表のとおり
4. 市場ニュースの表示条件への違反: 0件
5. notifications = 0（増加なし）
6. auto_publish = true・設定の `updated_at` 変化なし・active な Cron 8本・candidate の状態別件数は適用前と同じ（rejected 793 / generation_failed 88 / ready_for_publish 30 / published 13 / duplicate 36）
7. Edge Function 6つ: version・`updated_at` とも変化なし
- アプリの実機での表示確認は行っていない（dev build は Metro から新しい JS を読み込めば反映される）

### changed_files

- `supabase/migrations/20260911120000_market_relevance_news_feed.sql`（新規・本番適用済み）
- `supabase/functions/important-news-monitor/market_relevance_sql_static_test.ts`（新規）
- `src/lib/important-news.ts`（`ticker_code` を null 許容に、`matched_sector` / `relevance_reason` を追加）
- `src/app/news.tsx`（市場ニュースを「市場」「関連: 業種」で表示）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

### commit_hash

- この直後の commit で、上記のファイルと本 Report をまとめて記録する

### push

- `origin/main` へ同期済み

### remaining_issues

1. **表示される業種の選び方**: 同じ優先度の業種が複数一致した場合は業種名の順で選ぶため、為替の7件はすべて「機械」と表示される（本人は電気機器を6件登録しているのに）。決定的ではあるが、最適ではない。一致した登録件数の多い業種を優先する、または一致した業種をすべて返す、などの改善が考えられる。
2. **ソースをまたいだ重複**: 同じ米雇用統計が、別の取得元から2件（別の candidate）表示されている。`duplicate_of` はソースをまたいだ同一出来事をまとめない。
3. **通商テーマの広さ**: 「カナダの対米報復関税」も、輸出企業（電気機器・機械・輸送用機器・精密機器）に対応付けられる。判定の関連度は medium だが、日本への伝わり方は間接的。日本・自動車などへの言及がある場合に限る、といった絞り込みを検討できる。
4. **原油・海運の重大ニュースが、本人には1件も届かない**: 本人がエネルギー・海運・空運を登録していないため（設計どおり）。市場全体の重大ニュースを業種と関係なく受け取りたいユーザーには、「市場アラート」の設定が必要（phase4）。
5. **テーマの付かない重大な戦争ニュース**（4件）は、誰にも表示されない。見出しに原油・海運などの語が無いため。保守的な設計だが、判定の `judgement_reason` には伝わり方が書かれていることもある（例:「世界市場と日本株に影響し得る」）。
6. **業種が空の銘柄**（12%）は、市場ニュースの対応付けの対象にならない。
7. **防衛**は33業種では特定できないため、対応付けていない。
8. **フィードの件数上限（50件）**: 市場ニュースが加わり、本人のフィードは5件から12件になった。登録が増えると、上限に達する可能性がある（Phase 2 から継続）。
9. **ロジックの所在**: 市場ニュースの対応付けは SQL にだけある（TS の複製は無い）。振る舞いは、本番データでの単体テストとロールバック付きテストで確認し、安全境界と業種名は静的テストで固定した。
10. migration 履歴の乖離、前タスクまでの既知課題は継続。

### safety_checks

- X 公開基準・X 投稿量・auto_publish の変更なし
- Push の配信対象の拡大なし。市場ニュースを全ユーザー（関連ユーザーを含む）へ Push していない
- 新しい AI 呼び出し・Web 検索・取得元の追加なし
- 人工の candidate の投入なし。candidate の状態変更・削除なし。既存行の書き換えなし
- 破壊的な migration なし（関数の作り直しは、同じトランザクション内で権限まで含めて復元）
- OAuth・Vault・social_accounts・`x-test-post`・dispatcher・Cron・secrets の変更なし
- `db push` を使わず、対象ファイル1本だけを適用した。本番での検証は read-only とロールバック付きのトランザクションだけ
- Claude slot 2（x-oauth-connect）、Codex slot 2（x-test-post）の担当範囲には触れていない
- 共有 checkout の未コミット変更には触れていない

### phase4_recommendation

1. **`market_alerts` の設定（設計）**: `alert_settings` に列を1つ追加する程度でよい。
   - `market_alerts text not null default 'off' check (market_alerts in ('off', 'critical'))`
   - `off`（既定）: 今回の業種一致の表示だけ
   - `critical`: 市場全体の critical を、業種と関係なくフィードに出す（例: 米軍のタンカー攻撃）
   - Push への接続はさらに後の段階とし、既定は OFF を維持する。全ユーザーへの一律 Push はしない。
   - 今回は migration を追加していない（設計のみ）。
2. **業種の選び方の改善**（remaining_issues 1）: 一致した業種のうち登録件数が最も多いものを表示する。または `matched_sectors text[]` で全部返す。
3. **ソースをまたいだ同一出来事のまとめ**（remaining_issues 2）: 市場ニュースは、テーマ・時刻・主要な entities の組み合わせで近いものを1件にまとめる（読み取り時の `DISTINCT ON`、または取得側の重複判定の拡張）。
4. **テーマの精度**:
   - 通商テーマを、日本・自動車などへの言及がある場合に限る（remaining_issues 3）
   - `judgement_reason` にも伝わり方の語があればテーマを付ける（判定の文章をどこまで信頼するかを決めてから）
5. **銘柄単位のテーマタグ**: 防衛・半導体装置・商社のような、33業種より細かい関連を扱うには、`stocks_master` に銘柄ごとのテーマ（例: `themes text[]`）を持たせる必要がある。データの出所（手作業か外部データか）の検討から始める。
6. **Push**: まず保有銘柄の個別ニュース（critical / high）から段階的に。市場ニュースの Push は、`market_alerts` と、関連ユーザーでの件数・ノイズの観測を経てから。
