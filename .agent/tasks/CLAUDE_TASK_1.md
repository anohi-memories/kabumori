# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: morning-greeting-length-tolerance-20260907
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- purpose: 2026-09-07朝のscheduled `morning_greeting` が `MORNING_GREETING_TEXT_LENGTH_INVALID` でX API到達前に失敗したため、朝の挨拶らしい短さを維持しつつ、生成揺れで投稿全体が消える確率を下げる。

## Background

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

## Required behavior

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

### 5. 既存安全策は維持

以下は変更しない。

- 挨拶に「おはよう」を必須とする判定
- theme整合性
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

## Scope

主対象:

- `supabase/functions/x-test-post/morning_greeting_logic.ts`
- 必要なら `morning_greeting_payload_logic.ts`
- 必要なら `morning_greeting_publish_logic.ts`
- 関連テスト

上記以外へ広げないこと。

Codexは `important-news-monitor` の別タスクを担当中/readyのため、重要ニュース系ファイルには触れない。
Claude slot 2のExpo/Auth/MVP/Push関連にも触れない。

## Validation

最低限、以下をテストする。

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
12. OAuth/media/posting pathへ不要な変更がない

関連テスト・typecheck/lintを実行し、結果をReportへ記載する。

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

## Completion criteria

- 100〜300文字のvalidatorへ変更
- 120〜200文字の生成目標へ変更
- retry上限1回を維持
- 可能な範囲でlength diagnosticsを観測可能にする
- 関連テストpass
- 変更ファイルとテスト結果を `## Report` に記載
- statusを `review_required` に変更
- next_owner: chatgpt
- commit: 可
- push: 原則禁止。必要なら勝手にpushせず報告
- deploy: 禁止
- report_mode: inline
