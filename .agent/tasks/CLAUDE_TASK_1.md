# Claude Task 1

- task_id: close-report-final-hardening-20260907
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: urgent
- purpose: 2026-09-07の大引けレポートを本番有効化する前に、morning_reportで修正したVoice誤判定耐性と同等の安全な投稿前フローをclose_reportにも適用し、Voice不合格の見逃し・タグ順序・dry-run判定を最小修正で整える。

## Confirmed current state

- production `x-test-post`: v88 ACTIVE
- shared `evaluateKabumoriVoice()` は既に以下の一般的な相場コメントを単独ではfailにしない:
  - 「気になるところです」
  - 「注目したいところです」
  - 「見ておきたいところです」
  - 「確認したいポイントです」
- close_reportの固定タグは既に共有helperで以下4タグ:
  - `#日本株 #日経平均 #株式投資 #かぶモリ`
- ただし現在のscheduled live close_reportはVoice評価を実行して保存するだけで、`voiceEvaluation.passed === false`でも`postToX()`へ進む。
- 現在の`generateCloseReport()`はVoice評価前に固定タグを本文へ付与して返しており、morning_reportの「最終Voice後にコード側でタグ付与」と順序が異なる。
- close_report dry-runもVoice結果を返すが、`wouldPublish`/最終Voice gateを明示していない。
- production `posting_windows` のclose_reportは `15:58-16:02 Asia/Tokyo`, `daily_probability=1`, **is_active=false**。このTASKでは有効化しない。

## Required implementation

### 1. close_report Voice gateを本番投稿前に必須化

scheduled live close_reportで:

1. generation成功
2. format validation成功
3. fact check成功
4. local safety成功
5. Voice評価

の順に確認し、**最終Voiceがpassed=trueの場合だけ**X APIへ進む。

最終Voiceがfailなら `CLOSE_REPORT_VOICE_CHECK_FAILED` でX API到達前に停止する。

### 2. Voice単体fail時に最大1回だけ限定rewrite

morning_reportと同じ考え方で、generation/format/fact/local safetyがすべてpassし、Voiceだけfailした場合に限り同一実行内で最大1回rewriteしてよい。

rewrite制約:
- Voice notesで指摘された表現だけ修正
- 新しい事実・数値・日時・固有名詞・因果関係を追加/変更しない
- close_report固定構造を維持
  - `【大引け】きょうの日本株まとめ🌙`
  - `📌 今日の3ポイント` 3件
  - `🔎 強かった・弱かったテーマ`
  - `👀 明日への注目点`
  - `💬 今日のひとこと`
- URL/hashtagをAIに追加させない
- 投資助言・価格断定を追加しない
- 架空の本人売買/保有/損益/具体的な現在体験を追加しない

rewrite候補は最低限:
- `validateCloseReportFormat`
- fact-drift防止の決定的チェック（morning_report方式を再利用/一般化してよい）
- `localCloseReportSafetyIssues`
- 2回目Voice
を通す。

2回目Voice passなら採用。failまたはrewrite不採用ならX投稿せず停止。rewriteループは禁止。

### 3. 固定タグを最終Voice後へ移動

`generateCloseReport()`内ではAI本文にタグを付けず、本文だけ返す。

最終fact/format/local safety/Voiceがすべて通った後、Xへ渡す直前にコード側で
`appendKabumoriReportFixedHashtags()` を1回だけ適用する。

- 本文とタグの間は空行1つ
- 4タグは各1回だけ
- rewrite有無にかかわらず重複しない
- morning_reportと同じ共有定義を維持

### 4. close_report dry-runを本番前判定に使える形へ

`close_report_dry_run`でもliveと同じ最終判定順を通す。ただしX投稿は絶対にしない。

レスポンス/diagnosticsで少なくとも確認できるようにする:
- factCheck.status
- first_voice_passed
- voice_rewrite_attempted
- second_voice_passed
- final_voice_failure_stage (`first` / `after_rewrite` / null)
- voiceCheck.status
- wouldPublish
- final generatedText（wouldPublishなら固定4タグ付き）

Voice failだけでdry-run HTTP自体を落とす必要はない。`wouldPublish=false`とerror/diagnosticsで確認できればよい。

### 5. X重複安全

- `postToX()`は最終Voice pass後に1回だけ
- X API呼び出し後の曖昧失敗を自動retryする新機構は追加しない
- close_reportの外側retry基盤を新設しない

## Tests

最低限:
1. benign market wordingをshared Voice instructionが許容すること（既存テスト再利用可）
2. first Voice pass -> rewrite 0 -> wouldPublish true
3. first fail -> rewrite 1 -> second pass -> wouldPublish true
4. first fail -> rewrite 1 -> second fail -> wouldPublish false / X 0
5. rewrite candidateがformat破壊 -> reject / X 0
6. rewrite candidateが新規数字追加 -> reject / X 0
7. final Voice pass後だけ固定タグ付与
8. fixed tags exactly once
9. live path `postToX`はfinal Voice pass後のみ
10. existing close_report tests/regression pass

## Scope / conflicts

主対象:
- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/close_report_logic.ts`
- 必要ならreport共通rewrite helper（morning用を安全に一般化する最小変更可）
- 関連tests

触らない:
- Codex `important-news-monitor/**`
- Claude slot2 `send-push-notifications/**`
- DB migration/schema/GRANT
- Cron
- secrets
- posting_windows設定
- 他Edge Function

## Production policy

このTASKはまず **local implementation + tests + commitまで**。

- production deploy: 禁止
- `posting_windows.close_report.is_active`変更: 禁止
- X実投稿: 禁止
- DB write: 禁止（通常の開発作業に必要ない）
- push: 原則禁止。完了時に必要なら報告して確認を取る

## Completion

完了時:
- `## Report` を追記
- status: `review_required`
- next_owner: `chatgpt`
- changed files
- tests
- commit hash
- production changesなしを明記
- 次工程として「K1承認 → push/deploy → close_report dry-run → posting window有効化」を提案
