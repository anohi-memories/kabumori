# Claude Task 1

- task_id: important-news-push-copy-quality-20260910
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: 重要ニュースPush本文がTDnet/PDF由来の生テキスト（例: 「本店所在地…」）から始まり読みにくい問題を、事実性・既存publish安全性・通知配送基盤を壊さず改善する。

## Context

直前TASK `published-news-feed-and-push-tap-fix-20260910` はChatGPTのK1レビューで完了承認済み。

現在確認済み:
- `important-news-monitor` のproducerは本番投入済み
- `send-push-notifications` v4 は正しいorigin/main版へ復旧済み
- `alert_settings` opt-outは本番で実証済み
- `/news` RPCは `published` を含むよう修正済み
- 実在ニュースを使った `notifications -> Cron -> iPhone Push` はPASS
- 現状producerのPush本文は主に `body_summary` を140字へ切ったものを使うため、TDnet/PDFの定型文・住所・会社概要等が先頭に来る場合があり、通知として意味が伝わりにくい
- テスト用ウォッチ銘柄は自然E2E観測用として残している

## Model

文面品質だけでなく、重要ニュースの公開済み情報、producer、Fact安全性、本番Edge Function deployをまたぐため **Opus 5を使用する**。Sonnet系へ落とさない。

## Required startup checks

1. `PROJECT_RULES.md`
2. `.agent/ORCHESTRATION.md`
3. `.agent/CURRENT_STATE.md`
4. このTASK
5. `origin/main` fresh-check
6. shared checkout / clean worktreeの未コミット状態確認
7. `.agent/tasks/CODEX_TASK.md` / `.agent/tasks/CODEX_TASK_2.md` / `.agent/tasks/CLAUDE_TASK.md` をread-only確認
8. 他slotが `important-news-monitor/**`、同じproduction設定、同じnotification producerを変更中なら開始せず競合報告
9. 本番 `important-news-monitor` のversion/sourceとorigin/mainを確認
10. producerが現在title/bodyへ何を使っているか、候補レコードにどの生成済みテキストが存在するかを監査

既存未コミット変更は他workstream所有として扱い、変更・削除・stage・commitしない。

## Goal

Pushを見た瞬間に「何が起きたか」が分かる、短く自然で事実に忠実な本文へ改善する。

最低条件:
- 住所・本店所在地・会社概要・PDFの定型ヘッダー等をそのまま通知本文の主文にしない
- 1〜2文程度、概ね140字以内を維持
- 数字・方向性・主語など重要事実を勝手に変えない
- 既存candidateに既に生成済みで安全な要約/投稿文があるなら、それを優先再利用し、Push専用の新規AI呼び出しを安易に追加しない
- AI追加生成が本当に必要なら、コスト・遅延・失敗時fallback・Fact安全性を明示してから実装する。Task中に勝手に恒常課金経路を増やさない
- Push titleは必要以上に長くしない
- `/news` 本文・X投稿本文の品質や内容を意図せず変更しない
- user targeting / dedupe / alert_settings / dispatcherの挙動を変えない

## Phase 1: Audit and design

まず実装せず、以下を確定する。

- `important_news_candidates` に存在する本文候補フィールド（title, body_summary, generated_post_text, evaluation結果等）
- publish成功時に最終的にXへ出た文章を安全に特定できるか
- producerが現状 `body_summary` を選ぶ理由とfallback順
- TDnet由来、生ニュース記事由来、市場ニュース由来でデータ品質がどう違うか
- 既存の公開済み/生成済みテキストを再利用する場合のFactリスク
- 140字制限、改行、絵文字、記号、会社名重複の扱い

推奨優先順位:
1. 既存の生成済み・Fact/Voiceを通過した短文があり、通知として自然ならそれを再利用
2. それが無ければheadline/titleと構造化済み要約から決定論的に整形
3. 最後のfallbackとして現行 `body_summary` を使うが、住所・会社概要等の明らかな定型ノイズを除去してから短縮

## Phase 2: Minimal implementation

監査結果に基づき、`important-news-monitor` producer側の通知本文選択/整形だけを最小変更する。

必須:
- pure functionとしてテスト可能にする
- source/candidate stateを変更しない
- publish成功後だけenqueueする既存条件を維持
- dedupe keyを変更しない
- title/body/source_type/source_id/dataのdispatcher互換を維持
- enqueue failure時にX再投稿やpublish rollbackを起こさない
- 「良い本文が無い」時でも空本文にはしない。安全fallbackを持つ

## Phase 3: Tests

最低限:
- TDnet本文が `本店所在地` / 会社概要 / PDF定型文から始まるケースで、通知本文がそれを主文にしない
- 決算・業績修正・配当・自社株買い・M&A等の代表ケースで、重要事実が残る
- 数字の勝手な変更がない
- 生成済み安全テキストがある場合は優先される
- 生成済みテキストが無い場合のfallbackが有効
- 140字程度に収まる
- 空/異常入力でも空本文にしない
- title/body metadataがdispatcher互換
- user targeting / dedupe / publish-success-only の既存テスト維持
- important-news-monitor全回帰テストPASS
- `git diff --check`

## Production / deploy

テストPASS・競合なし・deploy root確認後に限り、**`important-news-monitor` だけ**本番deployしてよい。

直近のdeploy元取り違え事故を踏まえ、必ず:
- `pwd`
- git HEAD
- origin/main一致
- worktree内 `supabase/config.toml`
- linked project ref
- deploy対象が `important-news-monitor` のみ
を事前確認する。

`--no-verify-jwt` の現行仕様を勝手に変更しない。

### Post-deploy verification

- 本番sourceをdownloadし、期待commitの対象ファイルとバイト一致を確認
- 他Functionの updated_at が変わっていないことを確認
- Cron / auto_publish / secrets / OAuth を変更していないことを確認
- read-only dry-runまたはpure logicで、既知のソフトバンクG 9984の実在ニュースなど「本店所在地…」問題が出た実データに新本文ロジックを当て、改善結果をReportする
- 自然publishが発生した場合は、本人対象なら自然Pushの本文を観測してよい。ただし人工candidate・手動X投稿は禁止

## Forbidden

- `send-push-notifications`変更/deploy
- `/news` RPC変更
- `x-test-post`変更/deploy
- Cron変更
- DB schema/migration/RPC変更（今回の本文品質改善に不要なら作らない）
- secrets/OAuth変更
- alert_settings変更
- Push対象ユーザー判定変更
- dedupe仕様変更
- X投稿本文の品質調整を同時実施
- ニュース収集範囲拡張を同時実施
- 認証強化を同時実施
- 人工important-news candidate投入
- 手動X投稿
- 既存backlogのstatus変更/削除
- 新しいAI API呼び出しを監査・明示なしに恒常経路へ追加

## Completion

終了時:
- status: `review_required`
- next_owner: `chatgpt`
- このTASK末尾に `## Report` を追記
- `.agent/ORCHESTRATION.md` 規定どおり同期

Report必須:
- task_id
- result
- model_used
- existing_copy_path
- root_cause
- chosen_copy_strategy
- AI_call_added_or_not
- changed_files
- tests
- before_after_examples（実在データ、秘密情報なし）
- deploy/version/verify_jwt
- post_deploy_byte_match
- other_functions_unchanged
- natural_push_observation有無
- commit_hash
- push
- remaining_issues
- safety_checks
- next_recommendation

## Report

- task_id: important-news-push-copy-quality-20260910
- result: **完了**。producer（`important-news-monitor`）のPush本文の選び方を変更し、本番deployした（v37 → **v38**、`02323bd` と17/17ファイルがバイト一致）。本文は、**Fact・Voiceの両チェックを通過した生成済みX投稿文**を最優先で使う。自然経路（publish成功時）では、実際にXへ出た文章そのものになる。実在データ16件では、改善前は10件で冒頭に定型ノイズ（各位 / TEL / 本店所在地 / Copyright 等）が入っていたが、改善後は**0件**、最長140字。新しいAI呼び出しは追加していない。あわせて、**自然publish → producer の本番観測**を初めて記録した（10:30 UTC、`NO_TRACKING_USER`）。
- model_used: Opus 5

### existing_copy_path

- `a714d21` 版のproducerは、`buildImportantNewsNotificationSummary(bodySummary, title)` で本文を作っていた。`body_summary` の空白を1つにまとめて140字で切り、空なら見出しを使う。
- 本文の候補になるフィールド（本番の列を確認）: `title` / `normalized_title` / `body_summary` / `generated_text` / `generation_fact_status` / `generation_voice_status` / `generation_fact_issues` / `generation_voice_issues` / `judgement_reason` など。構造化された要約の列は無い。
- `generated_text` の形式: `【速報】` か `【重大速報】` のラベル + 本文（1〜3段落）+ `\n\n出典: URL`。ハッシュタグは付かない（生成プロンプトで禁止されている）。まれに絵文字（📈）を含む。
- 本番の状態（important / most_important）:

| status | 件数 | generated_text あり | Fact 通過 | Voice 通過 |
|---|---|---|---|---|
| published | 11 | 11 | 11 | 11 |
| ready_for_publish | 30 | 30 | 30 | 30 |
| generation_failed | 82 | 82 | 12 | 0 |

- **Xに最終的に出た文章は特定できる**。publishの事前チェック（`checkPublishCandidate`）は、`generation_fact_status = passed` と `generation_voice_status = passed` を必須としている。publishは `generated_text` をそのまま投稿するので、`published` の行の `generated_text` が投稿された文章そのものになる。

### root_cause

`body_summary` は、TDnetの開示PDFから抜き出したテキストだった。そのため、ほぼ必ず定型のレターヘッドから始まる（「各 位 会社名 … 代表者名 …（TEL …）」「本店所在地 東京都港区…」「Copyright(c)…」「M & A / G R O U P…」など）。PDF抽出のせいで文字間に空白も入る（「業 績 予 想 の 修 正」）。これを140字で切っても、通知には住所や定型文しか入らなかった。前タスクの実機テストで表示された「本店所在地 東京都港区海岸一丁目…」がこれに当たる。

### chosen_copy_strategy

AIを使わない、決定論的な3段構え（`selectImportantNewsNotificationSummary`）:

1. **`verified_post_text`**: `generation_fact_status = passed` **かつ** `generation_voice_status = passed` のときだけ `generated_text` を使う。先頭の `【速報】` / `【重大速報】` と末尾の `出典: URL` 行を外し、空白をまとめる。**自然経路（publish成功時）では必ずこのルートになる**（上記のとおり、publishに両チェックの通過が必須のため）。
2. **`cleaned_body_summary`**: 1が使えないときの予備。`body_summary` の中で見出しの位置を探し（空白を無視して照合）、その直後から使う。見出しが見つからなければ最初の「当社は / 当社が / 当社グループは」から使う。定型のレターヘッドは捨て、日本語の文字に隣接する空白を除く。英単語どうしの空白は残す。句点を含み15字以上の文章として読めるときだけ採用する。
3. **`headline`**: 最後の手段。見出し、それも無ければ固定文「登録銘柄の重要ニュースが公開されました。」。**本文が空になることは無い**。

長さの扱い（`fitImportantNewsNotificationText`）:
- 140字以内なら、そのまま使う。
- 超える場合は、**文単位**で140字以内に収める。括弧やかぎ括弧の中の「。」では文を切らない（「（以下「ＳＬＣ社」という。）」の途中で切れない）。
- 最初の1文だけで140字を超える場合に限り「…」で切る。その際、**数字の途中では切らない**（「3,000億円」が「3,0…」になることは無い）。

その他の扱い:
- 改行は空白1つにまとめる。絵文字はそのまま残す（Voiceチェックを通過し、Xにも出ている文章のため）。
- 会社名の重複: タイトルが `【会社名】見出し` で、本文も「会社名が…」で始まることがある。ロック画面ではタイトルが途中で切れることが多いため、本文だけで意味が通じることを優先し、重複はそのまま残した。
- タイトルのロジックは**変更なし**（`【会社名】見出し`、60字）。

### AI_call_added_or_not

**追加していない**。Push用の新しいAI呼び出し、課金経路、レイテンシは発生しない。再利用しているのは、publishの時点ですでに生成され、検証済みのテキストだけ。

### changed_files

- `supabase/functions/important-news-monitor/important_news_notification_logic.ts`（本文の選択と整形のpure function を追加。対象判定、重複防止、タイトル、行の形は変更なし）
- `supabase/functions/important-news-monitor/important_news_notification_logic_test.ts`（テストを29件に拡充）
- `supabase/functions/important-news-monitor/index.ts`（通知元の読み取り列に `generated_text` / `generation_fact_status` / `generation_voice_status` を追加。read-only のdry-runの応答に `summaryStrategy` を追加）
- `.agent/tasks/CLAUDE_TASK_1.md`（status / Report）

`publish_logic.ts`、X投稿の本文、`/news` のRPC、dispatcher、DB schema は変更していない。candidateの状態も変更しない（読み取りの列を増やしただけ）。

### tests

- `important_news_notification_logic_test.ts`: **29 passed / 0 failed**
  - 実在のソフトバンクG（9984）のレターヘッド（本店所在地…）が本文にならない
  - 検証済みの投稿文にある数字（1兆円 / 年4.75％ / 7年 / 100万円）が、そのまま残る
  - ラベルと出典行を外す。ラベルの重複や全角コロン（出典：）にも対応する
  - FactかVoiceのどちらかが未通過（failed / not_run / null）なら、生成テキストは使わない（未検証の文章がPushに漏れない）
  - 代表的な開示（自社株買い、配当修正、経営統合の解消、決算補足資料のCopyright始まり）で、レターヘッドを飛ばして本文から始まる
  - 英単語の空白は残し、日本語のPDF由来の空白は除く
  - 使える文章が無いレターヘッドだけのときは、住所ではなく見出しを使う
  - 空や異常な入力でも、本文が空にならない
  - 文単位で140字に収める。1文が長すぎるときも数字の途中で切らない。括弧の中の「。」では切らない
  - dispatcher互換（行のキー、`push_status='pending'`、`source_type` / `source_id`、importanceの許容値）
  - 既存の仕様: publish成功時のみenqueue（dry-runやFact failでは0件）、対象判定（ticker照合、company_codeなし → 0件、未登録 → 0件）、重複防止（重複キーが決定的）
- important-news-monitor 全体の回帰: **294 passed / 0 failed**
- `deno check`（ロジックとテスト）: OK
- `git diff --check`: clean
- `index.ts` 全体の型チェックは、以前からある `npm:unpdf` の解決エラーで実行できない（今回の変更とは無関係）。配線は目視で確認した（import、select、値の受け渡し、dry-run）。

### before_after_examples

本番の実データ（公開済みのTDnet開示。秘密情報なし）に、旧ロジックと新ロジックを適用した結果（16件）:

| 候補 | status | 改善前（旧・冒頭） | 改善後 | 方式 |
|---|---|---|---|---|
| ナトコ 4627 | published | 電 話 番 号 0561-32-2285（代表） 業績予想の修正に… | ナトコ（4627）が2026年10月期の通期業績予想を上方修正しました。売上高は245億円、営業利益は20億3,000万円。従来予想から営業利益を40.0％、経常利益を43.9％、純利益を46.0％引き上げています。 | verified_post_text |
| エアトリ 6191 | published | 各 位 会社名 株式会社エアトリ 代表者名 代表取締役社長 兼 CFO… | エアトリが2026年9月期の通期業績予想を上方修正しました。営業利益（減損等控除後）は前回予想比100％増の30億円、…当期利益は225％増の19億5,000万円へ。売上収益の予想は340億円で据え置きです。 | verified_post_text |
| 三井ハイテック 6966 | published | Copyright(c)2026 Mitsui High-tec, Inc. All rights reserved. … | 三井ハイテック（6966）が、2027年1月期の通期業績予想を再度上方修正しました。売上高は2,540億円から2,720億円、営業利益は145億円から195億円、… | verified_post_text |
| ムトー精工 7927 | published | 各 位 会 社 名 ムトー精工 株式会社 代 表 者 … 電 話 … | ムトー精工、自社株買いを決定 上限13万株、3億円。発行済み株式数（自己株式を除く）の1.9％にあたります。… | verified_post_text |
| アクリート 4395 | published | 各 位 会 社 名 株式会社アクリート 代表者名 …（TEL．050-…） | アクリートは、一時会計監査人を監査法人アリアから監査法人Ks Lab.へ変更すると発表しました。… | verified_post_text |
| 国連（市場ニュース） | published | The Secretary-General has condemned mounting civilian casualties… | 南レバノンのナバティエ周辺で戦闘が激化し、民間人の犠牲が増えています。国連事務総長は、イスラエル軍に…撤退を要求しました。… | verified_post_text |
| ソフトバンクG 9984 | generation_failed | 本店所在地 東京都港区海岸一丁目 7 番 1 号 会 社 名 ソフトバンクグループ株式会社 … | 当社は本日、2026年８月24日付「第70回無担保普通社債の発行に関するお知らせ」にてお知らせした、第70回無担保普通社債（…）について、発行条件を決定しましたので、下記のとおりお知らせいたします。 | cleaned_body_summary |

集計: `verified_post_text` 12件（公開済み11件＋ready 1件）、`cleaned_body_summary` 4件（generation_failed 4件）、`headline` 0件。定型ノイズは、改善前は冒頭40字に10/16件、**改善後は本文のどこにも0/16件**。改善後の最長は140字。

補足（予備ルートの品質）: `cleaned_body_summary` は住所や定型文を出さなくなったが、開示の書き出し（「当社は本日、…下記のとおりお知らせいたします。」）になり、具体的な数字が入らないことがある（ソフトバンクGの例）。**自然経路では使われない**（publish済みの候補は必ず検証済みの投稿文を持つ）ため、今回はここまでにしている。

### deploy/version/verify_jwt

- `important-news-monitor`: v37 → **v38** / ACTIVE / **`verify_jwt=false` 維持** / updated 2026-09-10 10:57:27 UTC
- deployはユーザーが実行した: worktree `/Users/yuya/Developer/kabumori/.claude/worktrees/ios-push-e2e`、HEAD `02323bd`、`--no-verify-jwt`、project `wsmznyzcvmuitkglfeuj`
- deploy前のroot確認: pwd = worktree、worktree内に `supabase/config.toml` あり（`[functions.important-news-monitor] verify_jwt = false`）、linked project ref = `wsmznyzcvmuitkglfeuj`、origin/main との差分なし
- deploy前の本番（v37）は、変更前のHEADと17/17ファイルがバイト一致していた（想定外の差分を巻き込んでいない）

### post_deploy_byte_match

- `supabase functions download important-news-monitor --use-api` で v38 を取得し、`02323bd` と比較した: **17/17ファイルがバイト一致**。差分0、未追跡ファイル0。
- 最初のdownloadは `error running container: exit 125`（CLIがDockerを使おうとして失敗）。`--use-api` を付けて取得し直した。以後のdeploy検証では `--use-api` を推奨する。
- 本番のdry-run応答に `summaryStrategy` が含まれていることでも、新しいコードが稼働していることを確認した。

### other_functions_unchanged

| function | deploy前 | deploy後 |
|---|---|---|
| x-test-post | v94 / 10:04:06 | v94 / 10:04:06 |
| send-push-notifications | v4 / 10:07:17 | v4 / 10:07:17 |
| stocks-master-sync | v6 / 09-04 05:15:26 | 同じ |
| stocks-new-listing-sync | v5 / 09-04 05:15:26 | 同じ |

Cron（8本）は、名前・スケジュール・activeとも変更なし。`auto_publish = true` のまま（設定の `updated_at` は 08:53:08 から変わっておらず、設定には触れていない）。secrets / OAuth は変更していない。

### dry-run（本番v38、read-only）

| candidate | reason | targetCount | summaryStrategy |
|---|---|---|---|
| ソフトバンクG 9984（`e8c063ef`、generation_failed） | WOULD_ENQUEUE | 1 | cleaned_body_summary（本文は上表のとおり。「本店所在地」は出ない） |
| ナトコ 4627（`514d0e92`、published） | NO_TRACKING_USER | 0 | verified_post_text |
| エアトリ 6191（`10234e28`、published） | NO_TRACKING_USER | 0 | verified_post_text |
| 三井ハイテック 6966（`af04a911`、published） | NO_TRACKING_USER | 0 | verified_post_text |
| 国連（`cea56cd6`、published、company_codeなし） | NO_COMPANY_CODE | 0 | verified_post_text |
| ムトー精工 7927（`788bc095`、今回の自然publish） | NO_TRACKING_USER | 0 | verified_post_text |

対象判定（登録銘柄のみ / company_codeなしは誰にも送らない）は、従来と同じ結果。

### natural_push_observation

**自然publish → producer の本番観測: あり**（初）。
- 2026-09-10 **10:30:01 UTC**、ムトー精工（7927）の「自己株式取得に係る事項の決定に関するお知らせ」が自然にpublishされた（`788bc095-e75b-4208-acba-a6a114530206`、important、X post ID `2097996007107871059`）。
- 正当な自然publishだった: `generated_at` は 10:27:20 UTC で cutover境界（08:53:08）より後、Fact / Voice ともに passed。古いbacklogではない。
- 10:30:00 の publish-ready の応答（`net._http_response`、HTTP 200、`published: true`）に、producerの診断結果が入っていた:
  `{"attempted":true,"reason":"NO_TRACKING_USER","tickerCode":"7927","targetCount":0,"insertedCount":0,"duplicateCount":0}`
  → **publish成功を受けてproducerが自動で呼ばれ**、登録銘柄に一致しないため0件と判定した。重複の生成も無い。
- 注意: これは v38 のdeploy（10:57）**前**の v37 で起きた。対象が0件だったため、Push本文の選び方はこの観測に関係していない。
- **自然経路でのPush本文の実機観測: なし**（登録銘柄と一致する自然publishがまだ無い）。

### commit_hash

- `02323bd` — Use the verified X post text as the important-news push body（コード。本番v38の中身）
- 本Reportはこの直後のcommitで追記

### push

- `origin/main` へ同期済み

### remaining_issues

1. **予備ルート（`cleaned_body_summary`）の本文は、開示の定型的な書き出しになることがある**（例: ソフトバンクG「…下記のとおりお知らせいたします。」）。住所・レターヘッドは出なくなったが、数字などの具体的な情報が入らないことがある。自然経路では使われないため、今回は最小の範囲にとどめた。
2. **自然経路で、登録銘柄のPush本文を実機で見る観測は、まだ行っていない**。テスト用のウォッチ17件は引き続き残してある。
3. 本文とタイトルで会社名が重複することがある（意図的。ロック画面ではタイトルが途中で切れやすいため）。気になる場合は、プロダクトとして判断する。
4. `supabase functions download` は、Dockerがあると使おうとして失敗することがある。deploy検証では `--use-api` を付けることを推奨する。
5. 前タスクまでの既知課題（`publish_failed` を `/news` に含めるか / migration履歴の乖離 / `important-news-monitor` と `x-test-post` の認証不足 / `supabase/config.toml` がリポジトリ管理外 / dispatcherに原子的claimが無い）は継続。

### safety_checks

- deployしたのは `important-news-monitor` だけ（ユーザーが実行）。deployの前後で、root・HEAD・本番ソースのバイト一致を確認した
- `verify_jwt=false` を維持した。他のFunction、Cron、`auto_publish`、secrets、OAuth、`alert_settings` は変更していない
- DB schema / migration / RPC の変更なし。`/news` のRPCとX投稿の本文は変更なし
- 対象判定、重複防止のキー、publish成功時のみenqueueする条件、dispatcherに渡す行の形は変更なし（テストで固定）
- AI呼び出しの追加なし
- 人工のcandidateの投入なし、手動のX投稿なし、backlogの変更なし（`ready_for_publish` 30件のまま、`publishing` 0件）。本番での確認は read-only のdry-runだけ
- 共有checkoutの未コミット変更には触れていない

### next_recommendation

1. 登録銘柄の自然publishで、Push本文を実機で確認する（テスト用ウォッチは確認後に削除）
2. 必要なら予備ルートの本文を改善する（例: 開示の定型句「下記のとおりお知らせいたします」の除去、見出しとの組み合わせ）。自然経路には影響しないので優先度は低い
3. 既知課題（`/news` の `publish_failed`、migration履歴、認証、`config.toml` の管理）を単独タスクとして順に進める
