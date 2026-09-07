# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: morning-content-resilience-20260907
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
- priority: high
- purpose: 2026-09-07朝に発生した2種類の `x-test-post` 投稿停止（morning_greetingの文字数判定、morning_reportのVoice誤判定）を、既存安全策を維持したまま最小修正で再発しにくくし、朝刊へ既存の固定ハッシュタグを確実に付与する。

## Background

### A. morning_greeting

2026-09-07本番のread-only確認結果:

- `scheduled_posts`
  - scheduled_for: 2026-09-07 06:47:23 JST
  - started_at: 06:48:01 JST
  - finished_at: 06:48:07 JST
  - status: failed
- `post_execution_logs`: `MORNING_GREETING_TEXT_LENGTH_INVALID`
- `publish_claims`: failed / x_post_idなし
- 画像 `generated/2026-09-07.png` は05:42:33 JSTに正常生成済み
- `posting_windows` は06:30-07:00 JST / active / probability=1で正常
- 前日の401とは別原因。今回の失敗は本文文字数判定であり、X APIへ到達していない。
- 本番 `x-test-post` はv87 ACTIVE。前タスクのOAuth 401 refresh修正は維持すること。

### B. morning_report / 朝刊

2026-09-07本番のread-only確認結果:

- scheduled_for: 2026-09-07 08:20:00 JST
- 実行開始: 08:20:01 JST
- `morning_report_runs.status`: failed
- error: `MORNING_REPORT_VOICE_CHECK_FAILED`
- generation: 成功
- format check: 成功
- `fact_check_status`: passed
- X API到達前に停止し、`x_post_id` はnull
- scheduled retryは行われず、attempt_countは1のまま
- 問題になった本文末尾:
  - `米国の半導体高が、日本の関連株にも同じ強さで続くのかが気になるところです。`

この「気になるところです」は通常の相場コメントとして自然であり、架空の個人的な現在感情・実体験として弾くのは厳しすぎる。

一方、以下のような実在しない個人的状態・体験は引き続き禁止する:

- 「今朝からずっと気になっています」
- 「さっき見て驚きました」
- 「私はこの銘柄を保有しています」
- 実際には入力されていない売買、損益、保有、体験、感情の断定

### C. morning_report fixed hashtags

既存の大引けレポートではコード側で以下の固定タグを付与している。

`#日本株 #日経平均 #株式投資 #かぶモリ`

`close_report_logic.ts` のコメント上も朝刊と共有する仕様だが、現状は大引け側にしか配線されていない。朝刊も同じ4タグを投稿末尾へ確実に付ける。

## Required behavior

# Part 1: morning_greeting length tolerance

### 1. 投稿許容文字数を100〜300文字へ拡張

`morning_greeting` 本文の最終validatorを以下に変更する。

- minimum: **100文字**
- maximum: **300文字**

100文字未満または300文字超だけを `MORNING_GREETING_TEXT_LENGTH_INVALID` とする。

### 2. 生成目標は120〜200文字

AIへの通常生成instructionは、許容上限300文字いっぱいを狙わせず、以下を目標とする。

- target minimum: **120文字**
- target maximum: **200文字**

目的は「普段は短めの朝の挨拶」を維持しつつ、多少長く生成されても投稿中止にしないこと。

### 3. length retryも120〜200文字を狙う

初回が許容範囲100〜300を外れた場合だけ、既存どおり最大1回retryしてよい。

- short retry: 自然に具体化して120〜200文字を狙う
- long retry: 内容を保ちながら120〜200文字を狙う
- 2回目も100〜300文字外なら停止
- retry回数上限は増やさない

### 4. 文字数diagnosticsを残す

今回のような失敗を後から切り分けられるよう、少なくとも以下がread-only確認で分かる形にする。

- retry_count
- first_length
- retry_length
- length_failure_stage (`first` / `retry`)

既存の `MorningGreetingLengthInvalidError` / payload diagnosticsを活用し、**DB migrationなしで可能な範囲**を優先する。

既存テーブルへ保存できる安全なフィールド/ログ経路があるならそこへ残す。DB schema変更が必要なら勝手にmigrationせず、`review_required` で必要性を報告する。

# Part 2: morning_report Voice false-positive resilience

### 5. Voice判定で「普通の相場コメント」と「架空の個人的現在状態」を分離する

`morning_report` / `close_report` / `us_premarket_report` 等のVoice評価で、一般的な相場コメントまで「現在の個人的感情の捏造」として弾かないよう、評価instructionを修正する。

**許容する例（fact basisに反しないことが前提）**:

- 「気になるところです」
- 「注目したいところです」
- 「見ておきたいところです」
- 「確認したいポイントです」

これらは市場解説上の修辞・論点提示として扱い、単独では `needs_review` 理由にしない。

**引き続きNGにする例**:

- 入力に存在しない実体験を示す表現
- 入力に存在しない本人の売買・保有・損益
- 「今朝からずっと気になっている」「さっき見て驚いた」など、具体的な現在/直近の個人的状態や行動を実在した事実として語る表現
- その他、投稿者本人の経験・感情・行動を事実として新しく作る表現

要点は、**単なる「気になるところです」等の市場コメントは許可し、具体的な本人の現在状態・経験を捏造した場合だけ弾く**こと。

### 6. morning_report Voice失敗時に、公開前の「1回だけ表現修正」を入れる

`morning_report` で以下が成立している場合:

- generation成功
- format check成功
- fact check成功
- X API未到達
- Voice評価だけ `passed=false`

そのまま即 `MORNING_REPORT_VOICE_CHECK_FAILED` にせず、**最大1回だけ**Voice notesを使った限定的rewriteを行う。

rewrite条件:

- 目的はVoice上の問題表現だけを直すこと
- 元のverified fact basisから新しい事実を追加しない
- 数値、固有名詞、日付、因果関係を勝手に追加・変更しない
- 朝刊の固定見出し・3つの注目ポイント・注意点・今日のひとこと構造を維持
- URL / hashtagをAIに追加させない
- 投資助言へ寄せない
- 架空の個人的実体験・売買・保有・感情を追加しない

rewrite後は少なくとも以下を再確認する:

1. morning_report format validation
2. fact safety（既存fact checkerを再利用できるなら再実行。コスト/構造上難しい場合は、verified fact basisから逸脱していないことを保証する既存経路を使い、その理由をReportへ明記）
3. Voice evaluation

2回目のVoice評価がpassなら、その本文だけをX投稿経路へ進める。

2回目もfailなら、従来どおり `MORNING_REPORT_VOICE_CHECK_FAILED` で停止する。

### 7. scheduled-post retry分類は変更しない

`MORNING_REPORT_VOICE_CHECK_FAILED` をscheduled-postレベルの通常retryable errorへ変更しない。

今回入れるのは**同一実行内・X API到達前の最大1回rewrite**であり、外側のscheduled retryを増やすものではない。

理由:

- 同じ条件で全生成を何度も繰り返すループを避ける
- duplicate X投稿リスクを増やさない
- content/safety failureを無制限retryしない既存設計を維持する

### 8. Voice diagnosticsを最低限残す

DB migrationなしで可能な既存ログ/diagnostics経路を使い、少なくとも後から以下を判別できるようにする。

- first_voice_passed
- voice_rewrite_attempted
- second_voice_passed
- final_voice_failure_stage (`first` / `after_rewrite`)

Voice notes全文を不用意に永続化する必要はない。secretやraw model response全文は保存しない。

# Part 3: morning_report fixed hashtags

### 9. 朝刊末尾へ固定4タグをコード側で付与する

朝刊の最終X投稿本文の末尾へ、既存の大引けレポートと同じ順序で以下を**ちょうど1回だけ**付与する。

`#日本株 #日経平均 #株式投資 #かぶモリ`

要件:

- AI生成promptへタグ生成を任せない
- Voice rewriteにもタグ生成を任せない
- 本文のformat / fact / Voiceの最終判定が完了した後、X APIへ渡す直前の確定本文へコード側で付与する
- 本文とタグの間は空行1つ（`\n\n`）
- retry/rewriteがあっても重複付与しない
- 可能なら既存の大引け固定タグ定義を共有・再利用し、同じ4タグを別々にハードコードして将来ずれないようにする
- 大引け側の既存挙動は壊さない

## Existing safety requirements to preserve

以下は変更しない。

- morning_greetingの「おはよう」必須判定
- greeting theme整合性
- 架空の実体験禁止
- 未確認天気禁止
- 投資助言禁止
- 架空の記念日禁止
- morning_greetingのURL / hashtag禁止
- 絵文字上限の安全策
- 画像存在確認
- 同日重複投稿防止 (`publish_claims` / receipt)
- OAuth 401時のみ1回refresh + 同一request 1回retry
- 401以外の曖昧失敗を自動retryしない方針
- morning_reportのfact gate / source verification / format validation
- X投稿前のduplicate safety

## Scope

このタスクは `x-test-post` Edge Function内だけで完結させる。

主対象候補:

- `supabase/functions/x-test-post/morning_greeting_logic.ts`
- 必要なら `morning_greeting_payload_logic.ts`
- 必要なら `morning_greeting_publish_logic.ts`
- `supabase/functions/x-test-post/index.ts` のVoice評価instruction / morning_report実行部分
- `supabase/functions/x-test-post/close_report_logic.ts` の既存固定タグ定義（共有化のため必要な最小変更のみ）
- 必要ならfixed hashtag共有用の小さなhelper/module
- 必要ならVoice rewrite用の小さなhelper/module
- 関連テスト

**同じ `x-test-post` Edge Functionを別スロットで同時変更しないこと。**

Codexは `important-news-monitor` の別タスクを担当中/readyのため、重要ニュース系ファイルには触れない。
Claude slot 2のExpo/Auth/MVP/Push関連にも触れない。

## Validation

### morning_greeting

1. 99文字 -> reject
2. 100文字 -> accept
3. 120〜200文字 -> accept
4. 180〜250文字 -> accept
5. 300文字 -> accept
6. 301文字 -> reject
7. 初回99文字 -> retry -> 120〜200文字ならaccept
8. 初回301文字超 -> retry -> 120〜200文字ならaccept
9. retry後も範囲外 -> `MORNING_GREETING_TEXT_LENGTH_INVALID`
10. retryは最大1回のまま
11. 既存のsalutation/theme/safety testsがpass

### morning_report Voice

12. 「気になるところです」のような通常の市場コメントを、個人的現在感情の捏造として自動的にfailさせないinstructionになっていること
13. 入力にない「今朝からずっと気になっている」「さっき見て驚いた」等は引き続きfail対象になること
14. first Voice fail -> rewrite最大1回 -> second Voice passなら投稿経路へ進めること
15. first Voice fail -> rewrite -> second Voice failならX API到達前に停止すること
16. rewrite回数は最大1回でループしないこと
17. rewriteで朝刊固定formatが壊れた場合は投稿しないこと
18. rewriteでfact safetyを損なう経路がないこと
19. X投稿処理は最終validation完了後に1回だけ呼ばれること
20. scheduled retry分類は従来のままであること

### morning_report hashtags

21. 正常朝刊の最終投稿本文が `#日本株 #日経平均 #株式投資 #かぶモリ` で終わること
22. 4タグがそれぞれ1回だけ存在すること
23. Voice rewriteありでもタグが重複しないこと
24. Voice最終fail時はタグ付与後に誤ってX投稿へ進まないこと
25. 大引け側の固定タグ出力に回帰がないこと

### regression

- OAuth/media/posting pathへ不要な変更がない
- relevant tests pass
- typecheck/lintを可能な範囲で実行

## Production policy

このタスクは**ローカル実装・検証まで**。

- production deploy: 禁止
- production DB write: 禁止
- migration / DDL / GRANT: 禁止
- Cron変更: 禁止
- secrets変更・表示: 禁止
- Xへの手動投稿: 禁止
- 2026-09-07 failed `scheduled_posts` / `publish_claims` の再実行・削除・再claim: 禁止
- 朝画像生成workflow変更: 禁止
- 2026-09-07 failed morning_reportを勝手に再投稿しない

## Completion criteria

- morning_greeting validatorを100〜300文字へ変更
- morning_greeting生成目標を120〜200文字へ変更
- greeting retry上限1回を維持
- greeting length diagnosticsを可能な範囲で観測可能にする
- 「気になるところです」等を通常の相場コメントとして許容できるVoice instructionへ修正
- morning_report Voice fail時の限定rewriteを最大1回だけ実装
- rewrite後のformat / fact safety / Voice再確認を実装
- scheduled Voice failureの外側retry分類は変更しない
- Voice diagnosticsを可能な範囲で観測可能にする
- 朝刊末尾へ固定4タグをコード側でちょうど1回付与
- 大引け側の固定タグ挙動を維持
- relevant tests pass
- 変更ファイルとテスト結果を `## Report` に記載
- statusを `review_required` に変更
- next_owner: chatgpt
- commit: 可
- push: 原則禁止。必要なら勝手にpushせず報告
- deploy: 禁止
- report_mode: inline

## Report

- task_id: morning-content-resilience-20260907
- result: 完了（Part 1/2/3すべて実装・テスト済み、ローカルのみ、未push）
- production_changes: なし（実装・テストはすべてローカル。本番`x-test-post`は前タスク完了時点のv87のまま。2026-09-07に失敗した`scheduled_posts`/`publish_claims`（morning_greeting/morning_report双方）・失敗したmorning_reportの再実行/再投稿/削除/再claimは一切行っていない。DB書き込み・migration・Cron・secrets変更もなし）

### Part 1: morning_greeting length tolerance

- `morning_greeting_logic.ts`: `MORNING_GREETING_MAX_CHARACTERS` を180→300へ、`MORNING_GREETING_TARGET_MIN/MAX_CHARACTERS` を110-160→120-200へ変更。`MORNING_GREETING_MIN_CHARACTERS`(100)は変更なし。validatorロジック・retry構造（最大1回、targetを狙う）・診断用エラー型は既存のまま再利用。
- DB migration: **不要と判断**。`publish_claims.error_code`は既存の`text`型カラムであり、`MorningGreetingPayloadDryRunError`の`retryCount`/`firstLength`/`retryLength`/`lengthFailureStage`を`"MORNING_GREETING_TEXT_LENGTH_INVALID:retryCount=1;firstLength=99;retryLength=200;stage=retry"`という形式のsuffixへエンコードして既存カラムへ格納する方式にした（`morning_greeting_publish_logic.ts`）。スキーマ変更は一切行っていない。
- validation 1-11相当のテストを`morning_greeting_logic_test.ts`へ全面的に書き換え（100/300文字境界、120-200/180-250文字帯、初回失敗→retry成功、初回失敗→retry後も範囲外→`stage:"retry"`診断、retry上限1回、既存のsalutation/theme/safetyテストは無変更）。
- 既存のOAuth 401 refresh実装（前タスク）・重複防止・画像存在確認等には触れていない。

### Part 2: morning_report Voice false-positive resilience

- `index.ts`内`evaluateKabumoriVoice()`のinstructionsを修正し、「気になるところです」「注目したいところです」「見ておきたいところです」「確認したいポイントです」を単独では違反にしないと明記。一方「今朝からずっと気になっています」「さっき見て驚きました」のような具体的な現在・直近の個人的状態/行動を実在した事実として語る表現、および架空の売買・保有・損益経験は引き続き明示的にNGとした（インシデント文言そのままで実際に再現・修正確認済み）。
- 新規ファイル `morning_report_voice_rewrite_logic.ts`: rewrite用リクエスト構築・レスポンス解析・fact-drift防止チェック・ローカル安全パターンチェックを純粋関数として実装。
  - `morningReportVoiceRewritePreservesFacts()`: rewrite後テキストに含まれる数字列（全角含む）がすべて元テキストにも存在することを要求する決定的チェック。新しい数値・日付の追加を機械的に拒否する。
  - `morningReportVoiceRewriteSafetyIssues()`: URL/ハッシュタグ・投資助言断定・架空の売買/保有/含み益損表現をローカル正規表現で検出（close_report_logic.tsの`localCloseReportSafetyIssues`と同系統のdefense-in-depth）。
- `index.ts`に`attemptMorningReportVoiceRewrite()`を追加。OpenAI呼び出し→出力抽出→fact-drift/safety/`validateMorningReportFormat`の3チェックを直列に通過した場合のみ書き換え候補を返し、いずれか1つでも失敗した場合は`null`（=rewrite不採用、従来どおり`MORNING_REPORT_VOICE_CHECK_FAILED`）。
- fact safety再検証の方式について: **既存fact checker（`evaluateMorningFacts`）は再利用不可と判断**。この関数は検索・候補選定パイプラインの出力（ソース検証・鮮度等）を検証するものであり、自由記述テキストの内容を検証する設計ではない。rewriteのためだけに検索パイプライン全体を再実行することは、要件7（同一条件での全生成ループ回避、duplicate投稿リスク増加回避）に反するため、その場で機械的に判定可能な「rewrite後テキストの数字列は元テキストの数字列の部分集合」という決定的no-driftガードを採用した。この判断根拠は`morning_report_voice_rewrite_logic.ts`冒頭コメントにも明記。
- `index.ts`の`morning_report` dry-runパス・scheduled-dispatch（live）パス双方に同一のrewrite-and-reverifyオーケストレーションを配線:
  1. 初回Voice評価が`passed=false`の場合のみ、最大1回`attemptMorningReportVoiceRewrite()`を呼ぶ（構造テストで呼び出し回数1回・`evaluateKabumoriVoice`呼び出し回数2回であることを確認済み）。
  2. rewrite候補が得られ、2回目のVoice評価が`passed=true`ならそのテキストを最終テキストとして採用。得られない/2回目もfailの場合は元のテキストのまま`finalVoiceEvaluation`は初回の失敗結果を維持し、従来どおり`MORNING_REPORT_VOICE_CHECK_FAILED`で停止（liveパスはX API到達前、dry-runパスはそもそもpostToXを呼ばない）。
  3. 外側`shouldRetryMorningReport()`呼び出し・引数は一切変更していない（構造テストで確認済み）。
- Voice diagnosticsは`morning_report_runs.market_data`（既存の非migration JSONフィールド）内`pipeline`オブジェクトへ`first_voice_passed`/`voice_rewrite_attempted`/`second_voice_passed`/`final_voice_failure_stage`として追加。Voice notes全文やraw model responseの新規永続化は行っていない（既存の`voiceEvaluation`埋め込み自体は変更前から存在する挙動でありPart 2では変更していない）。

### Part 3: morning_report fixed hashtags

- 新規ファイル `fixed_hashtags_logic.ts`: `close_report_logic.ts`にあった固定タグ定義（`#日本株 #日経平均 #株式投資 #かぶモリ`）と付与/検証関数をreport非依存な形で抽出。
- `close_report_logic.ts`は抽出後のモジュールを`import`し、既存の`CLOSE_REPORT_FIXED_HASHTAGS`/`appendFixedCloseReportHashtags`/`hasFixedCloseReportHashtagsExactlyOnce`という名前をそのままエイリアス再exportすることで、`index.ts`・`close_report_logic_test.ts`双方を無変更のまま維持（既存43テストは無変更で全pass、大引け側の挙動・呼び出し順は一切変更していない）。
- `index.ts`のmorning_report live/dry-runパスへ`appendKabumoriReportFixedHashtags()`を配線。呼び出しは各パスにつき1回のみ、`if (!finalVoiceEvaluation.passed) throw ...`（最終Voice判定）より後・`postToX()`呼び出しより前という順序を構造テストで確認済み。AIプロンプト・Voice rewriteのどちらにもタグ生成をさせていない。

### Validation coverage（タスク記載の25項目との対応）

- 1-11 (morning_greeting): `morning_greeting_logic_test.ts`で網羅。全pass。
- 12-13 (Voice文言の許容/禁止): `voice_evaluation_instructions_test.ts`で構造的に検証（instructions文字列に許容表現・禁止表現が明記されていることを確認）。
- 14-20 (rewrite-and-reverifyフロー): `morning_report_voice_rewrite_logic_test.ts`（純粋関数7件）+ `morning_report_voice_rewrite_wiring_test.ts`（index.ts配線6件、rewrite最大1回・postToX呼び出し1回・outer retry分類不変を含む）で検証。
- 21-25 (hashtags): `fixed_hashtags_logic_test.ts`（既存5件、無変更で全pass）+ `morning_report_voice_rewrite_wiring_test.ts`のhashtag配線順序テストで検証。close_report側43テストも無変更で全pass、回帰なし。

### changed_files

- `supabase/functions/x-test-post/morning_greeting_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_logic_test.ts`
- `supabase/functions/x-test-post/morning_greeting_payload_logic_test.ts`（Part 1の許容範囲拡張に伴い、境界値ちょうど300文字だったテスト用フィクスチャを320文字へ修正。新range下で意図通り「範囲外」を再現するための修正で、production側ロジックは無変更）
- `supabase/functions/x-test-post/morning_greeting_publish_logic.ts`
- `supabase/functions/x-test-post/morning_greeting_publish_logic_test.ts`
- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/close_report_logic.ts`
- `supabase/functions/x-test-post/fixed_hashtags_logic.ts`（新規）
- `supabase/functions/x-test-post/fixed_hashtags_logic_test.ts`（新規）
- `supabase/functions/x-test-post/morning_report_voice_rewrite_logic.ts`（新規）
- `supabase/functions/x-test-post/morning_report_voice_rewrite_logic_test.ts`（新規）
- `supabase/functions/x-test-post/morning_report_voice_rewrite_wiring_test.ts`（新規）
- `supabase/functions/x-test-post/voice_evaluation_instructions_test.ts`（新規）

Codex担当の`important-news-monitor`関連ファイル、Claude slot 2担当のExpo/Auth/Push関連ファイルには一切触れていない（`git status`で確認済み、他エージェントの未コミット変更もすべて無傷）。

### tests

- `deno test --no-check --allow-read --allow-env`で`x-test-post`配下の全`*_test.ts`を実行（`useful_tip_output_test.ts`を除く。この1ファイルは今回のいずれの変更とも無関係で、この検証環境のdeno 2.9.6が`globalThis.Deno`への再代入を拒否するため単体でも失敗する既存の環境依存issueであることを確認済み。詳細は下記備考）。
- 結果: **316 passed / 0 failed**（新規追加分: `fixed_hashtags_logic_test.ts` 5件 [既存] + `voice_evaluation_instructions_test.ts` 3件 + `morning_report_voice_rewrite_logic_test.ts` 7件 + `morning_report_voice_rewrite_wiring_test.ts` 6件 = 今回のPart 2/3向け新規16件を含む）。
- `deno check index.ts` および今回変更・新規作成した全ファイルの型検査を実施。今回の変更に起因する新規の型エラーは0件。検出された既存6件の型エラー（`_shared/x_oauth2_post.ts`・`morning_greeting_image_logic.ts`・`morning_lane_response_logic.ts`のUint8Array/BufferSourceおよびretry_count関連）はすべて`origin/main`時点から存在する、今回のdenoバージョン(2.9.6、今回この検証のため新規インストール)固有のTypeScript lib差分による既存issueであることを`git show origin/main:...`で照合し確認済み。今回のタスクの変更対象外。
- `deno lint`を今回変更・新規作成した全ファイルに対し実施。今回の変更に起因する新規lint issueは0件（検出された`index.ts`の2件・`morning_greeting_payload_logic_test.ts`の3件は同様に既存issueであることを確認済み）。

### 備考（環境）

- この検証環境にはdenoが未インストールだったため、Homebrewでdeno 2.9.6を新規インストールして検証した。以降のセッションでも同様に必要になる可能性がある。

### next_recommendation

- push可否をご判断ください（本タスクの指示`push: 原則禁止。必要なら勝手にpushせず報告`に従い、ここではpushしていません。ローカルコミットのみ完了しています）。
- 本番反映（deploy）は今回禁止のため未実施。review後、別タスクとしてv87→v88のデプロイ・本番でのdry-run確認（`morning_report_dry_run`モード等）を推奨します。
- `useful_tip_output_test.ts`の`globalThis.Deno`再代入issueは今回のタスクと無関係ですが、deno更新後の別環境でも同様に顕在化する可能性があるため、別タスクでの切り分けを推奨します（今回は触れていません）。
