# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: morning-content-resilience-20260907
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- purpose: 2026-09-07朝に発生した2種類の `x-test-post` 投稿停止（morning_greetingの文字数判定、morning_reportのVoice誤判定）を、既存安全策を維持したまま最小修正で再発しにくくする。

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
- URL / hashtagを追加しない
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

## Existing safety requirements to preserve

以下は変更しない。

- morning_greetingの「おはよう」必須判定
- greeting theme整合性
- 架空の実体験禁止
- 未確認天気禁止
- 投資助言禁止
- 架空の記念日禁止
- URL / hashtag禁止
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
- relevant tests pass
- 変更ファイルとテスト結果を `## Report` に記載
- statusを `review_required` に変更
- next_owner: chatgpt
- commit: 可
- push: 原則禁止。必要なら勝手にpushせず報告
- deploy: 禁止
- report_mode: inline
