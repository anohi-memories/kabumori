# Codex Task

- task_id: important-news-throughput-and-coverage-hardening-20260909
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: urgent
- recommended_model: Sol

## Goal

重要ニュース監視について、現在の「高コストで生成しても過剰なQAで捨てる」「most_important/ready_for_publishでも実投稿へ到達しない」「戦争・トランプ政権・為替など海外重要材料が少ない」という問題をまとめて改善する。

狙いは **Factの重大誤りは厳格に止めつつ、修正可能なVoice/表現エラーは自動修正で救済し、取得→判定→生成→公開の実効通過率を現実的に引き上げること**。

## User intent / authorization

2026-09-09 JST、ユーザーは以下を明示的に希望・承認した。

- 現状の判定基準は厳しすぎる。高いAPIコストを払っているのに全然投稿できない状態は改善する。
- Factの重大誤りは止めるが、Voiceや軽微な表現問題は自動修正して投稿まで持っていく。
- `important` も安全条件を満たす場合は自動投稿候補へ広げる。
- 戦争・地政学、トランプ政権・関税、円安/円高・ドル円、Fed/米金利、原油、米半導体/AIなど日本株へ波及しやすい海外材料の監視を強化する。

## Confirmed production symptoms (2026-09-09 JST)

### A. ready_for_publishだが投稿されない

production DB確認時点で、`ready_for_publish` かつ `publish_attempts=0` が多数存在。

- `important + ready_for_publish`: 過去28件、X投稿成功0件
- `most_important + ready_for_publish`: 過去6件、X投稿成功0件
- `most_important + generation_failed`: 過去9件、X投稿成功0件

`most_important` 判定自体は発生しているが、実投稿成功はこれまで0件。

現在のpublish_ready経路、cutover条件、claim条件、importance filter、Cron実行結果を追い、**なぜpublish_attemptsが0のままなのかを実コード/production定義で特定すること**。

### B. 2026-09-09 generation_failed

当日確認した失敗例:

1. `most_important` アシックス自己株式取得/消却
   - `NEWS_GENERATION_FACT_RETRY_FAILED`
   - issue: `MISSING_EXPLICIT_YEAR`
   - 生成本文には `2026年9月9日`、`2026年9月10日`、`2027年3月31日` 等が実際に含まれている
   - **機械validator誤判定の疑いが強い**

2. `most_important` 米加通商摩擦
   - `NEWS_GENERATION_FACT_RETRY_FAILED`
   - issue: `MISSING_EXPLICIT_YEAR`
   - 生成本文には `2026年7月20日` が含まれる
   - 同様に誤判定疑い

3. `important` 大口受注
   - Fact fail: 元情報にない「決済端末」と製品カテゴリを断定
   - これは重大Fact誤りとしてhard fail維持でよい

4. `important` AFC-HD/さいか屋
   - company identity未確認
   - 同一性を安全に一次情報の正式発行会社表記へ寄せる等で救済可能か検討

5. `important` 販売用不動産
   - Fact passed / Voice failed
   - 理由: 冒頭 `【速報】` がやや煽り気味
   - **投稿全体を破棄せず自動修正すべき典型例**

6. `important` Canada tariffs
   - Fact passed / Voice failed
   - 根拠の弱い市場影響断定・追加措置未確認の断定
   - 該当文削除/弱化後に再評価すべき典型例

### C. monitor runtime異常

2026-09-09 JST 17:20 / 17:40 / 18:00開始のmonitor runが連続で

`NEWS_MONITOR_STALE_RUNTIME_TERMINATION`

になっている。

17:00までは概ね15〜27秒程度で正常終了していたのに、その後20分以内に完了しないrunが連続した。

最新run/ログ/取得源を確認し、ハング・外部fetch・無限待ち・重複処理増大・timeout管理・rate limit等の原因を特定し修正する。

## Required investigation

開始時に必ず:

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `.agent/CODEX_REPORT.md`
6. `origin/main` fresh-check
7. shared worktreeの未コミット変更確認
8. important-news-monitor関連コード、SQL/RPC、Cron、admin表示コードを必要範囲で確認
9. production settings / run logs / candidatesをread-onlyで再確認

既存未コミット変更は他workstream所有物として扱い、変更・stage・commitしない。

## Workstream 1: publish_ready 実投稿0件の根本原因修正

以下をproduction定義とコード双方で追跡する。

- `important-news-publish-ready` Cronが現在activeか、周期、request body
- `mode=publish_ready` がACTIVE functionで正しく処理されるか
- candidate claim条件
- `importance` filter
- `status='ready_for_publish'`
- `auto_publish`
- cutover `updated_at` 条件
- `created_at` / `generated_at` / `updated_at` のどれをcutover比較に使っているか
- publish_attempts更新位置
- X API到達前にsilent skipする条件
- 古いbacklog除外ロジックが新規candidateまで誤って除外していないか

安全な新規candidateが条件を満たした場合に、**自然経路でpublish_attempts>0またはX投稿へ進める状態**にする。

古いbacklogを一括投稿しない。既存cutover safetyは維持する。

## Workstream 2: QAを「Fact厳格・Voice柔軟」に再設計

### Hard failを維持するもの

- 数字・金額・株数・日付等の重大な不一致
- 対象会社/主体の誤認
- 元情報にない製品・契約・業績・措置等を事実として追加
- 一次情報と矛盾する内容
- source/date/company identityを安全に解決できない重大ケース
- 投資助言化、捏造された個人体験等の既存重大safety violation

### 原則retry/auto-fixへ変更するもの

- `【速報】` / `【重大速報】` が煽り気味
- 市場影響の断定が強い
- 「現時点では〜確認されていません」のような確認範囲不明な文
- 文体・トーン・絵文字・構成上のVoice違反
- 正式会社名へ寄せれば解決する軽微なidentity表記
- その他、本文一部削除/弱化でFact passedを維持できるもの

Voice failedで即 `generation_failed` にせず、**最大1回程度のtargeted rewrite → Fact再確認 → Voice再確認**で救済する。

APIコストが無限に膨らまないようretry回数上限を明示する。

## Workstream 3: `MISSING_EXPLICIT_YEAR` 誤判定修正

実際に西暦が本文に存在するのに失敗するケースを再現テスト化し、validatorの原因を修正する。

最低限テスト:

- `2026年9月9日`
- `2027年3月31日`
- 英文/半角表記 `2026-09-09`
- 同一本文内の複数日付
- 年なし `9月9日` は必要条件に応じてfail

既存のdate safetyを弱めすぎない。

## Workstream 4: importantも安全条件付き自動投稿対象へ

`most_important`限定では通過率が低すぎるため、ユーザー承認に基づき `important` も自動投稿候補へ広げる。

ただし無条件投稿は禁止。

推奨条件:

- status=`ready_for_publish`
- generation_fact_status=`passed`
- generation_voice_status=`passed`
- confidenceが既存安全閾値以上
- cutover後に自然発生
- x_post_idなし
- publish_attempts安全上限内
- duplicateでない

さらに、過剰連投を防ぐため以下を設計・確認する。

- 1日あたり上限またはクールダウン
- `most_important` を `important` より優先
- 同一企業/同一テーマの短時間重複抑制
- 古いbacklogを対象外に維持

件数上限/クールダウン値は既存設計との整合を見て最小変更で決め、Reportへ根拠を書く。

## Workstream 5: 戦争・Trump・為替など海外重要材料のcoverage改善

ユーザーが特に不足を感じている領域:

- 戦争・軍事衝突・中東・ホルムズ海峡等の地政学
- Trump政権の関税・制裁・貿易政策・対中/対加/対EU政策
- ドル円、急激な円安/円高、為替介入関連
- Fed、米金利、CPI/PCE/雇用など金利観測を大きく変える材料
- 原油・エネルギー供給
- 米半導体・AI・NVIDIA等、日本の半導体株へ波及しやすい材料
- 日本市場全体へ波及しやすい海外速報

まず直近数日のproduction candidates/runsを分類し、各領域について

1. そもそもfetchされていない
2. fetchはされたがduplicate/no_post/rejected
3. important判定まで行ったがgeneration_failed
4. ready_for_publishまで行ったがpublishされない

のどこで失われているかを数量で整理する。

その結果に基づき、**必要なsource/keyword/feed/relevance prompt/importance判定**だけを最小変更する。

単純に全ニュースを拾ってAPIコストを増やす変更は禁止。日本株への波及可能性が高いテーマを優先する。

## Workstream 6: stale runtime termination修正

17:20以降の20分ハングを再現/分析する。

確認候補:

- fetch対象件数の増加
- 特定sourceの無応答
- fetch timeout未設定/長すぎ
- Promise待ちの詰まり
- sequential fetch増大
- retry loop
- source単位のrate limit
- run cleanup / stale detection競合

1 source異常でmonitor全体が20分止まらないよう、可能ならsource単位timeout/partial failureで継続できる構造にする。

既存の安全なpartial error記録は維持する。

## Admin UI / status wording

管理画面が `ready_for_publish` を単純に「投稿準備完了」と表示し、実際の自動投稿対象外/保留との違いが分からない場合は、関連UIを確認する。

必要なら以下のように意味を分ける。

- QA完了・自動投稿待ち
- QA完了・自動投稿対象外
- 公開処理待ち/claim待ち
- 公開失敗

ただしadminファイルに別slot競合がある場合はUI変更は行わず、Reportに別TASK候補として残す。

## Tests

最低限:

- important-news-monitor targeted tests
- generation fact/voice retry tests
- `MISSING_EXPLICIT_YEAR` regression
- important publish eligibility tests
- most_important priority tests
- old backlog/cutover exclusion regression
- duplicate/cooldown/daily cap tests（導入した場合）
- stale source/timeout regression（可能な範囲）
- `git diff --check`

既存important-news回帰を全て通す。

## Production / deploy authorization

ユーザーは改善方針を承認済みだが、本番変更は安全に段階実施する。

許可:

- 原因を特定したコード修正
- tests
- commit / push
- `important-news-monitor` のみの必要なdeploy
- 既存publish_ready Cron設定の誤りが明確な場合の最小修正
- auto publish対象を安全条件付きで `important` まで広げる最小設定/コード変更
- read-only production検証

禁止:

- 古いready backlogの一括投稿
- 手動candidate注入
- 手動X投稿で成功扱い
- Fact重大gateの撤廃
- unlimited retry
- 全ニュース無差別収集
- secrets/OAuth変更・表示
- unrelated Edge Function deploy
- morning_greeting / morning_report / close_report / Pushアプリ変更
- migration/schema/GRANT変更（不可避なら実行せずReportしてChatGPTへ戻す）

## Apple Push task note

直前の `expo-ios-push-e2e-20260909` はApple Developer Team反映待ちでブロックしていた。Bundle ID設定commit `b9bebd466d3e3b47fa0913c168f8fc3c1c6c99cd` はpush済み。

この新TASKではPush関連を触らない。Apple Team有効化後、別途再割当する。

## Completion

完了時:

- status: `review_required`
- next_owner: `chatgpt`
- `.agent/CODEX_REPORT.md` 更新

Report必須:

- root causes（publish 0 / QA overblocking / coverage loss / stale runtime）
- changed_files
- `MISSING_EXPLICIT_YEAR` 原因と修正
- Voice retry救済の実装内容
- hard fail維持項目
- important自動投稿の条件
- cooldown/daily cap/priority設計
- 海外ニュース各領域がどの段階で落ちていたかの数量分析
- source/relevance変更内容
- stale runtime原因と修正
- tests結果
- commit_hash / push
- deploy有無とversion
- production verification
- X API calls / 実投稿の有無
- old backlogが投稿されていない確認
- remaining issues
- safety checks
- next recommendation
