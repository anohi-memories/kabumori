# Claude Task 1

- task_id: close-report-final-hardening-20260907
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report

- task_id: close-report-final-hardening-20260907
- result: 完了。実装・テストのみ、ローカルコミット済み、production変更なし、未push。

### changed files

- `supabase/functions/x-test-post/index.ts`
  - `generateCloseReport()`: `appendFixedCloseReportHashtags(text)`呼び出しを削除。以後`draft.text`は固定タグなしの本文のみを返す（`localCloseReportSafetyIssues`によるローカル安全チェックは従来どおりformat検証の後に実行、この順序自体は変更していない）。
  - `closeRunMarketData()`: 5番目の任意引数`voiceRewrite`を追加し、`pipeline`オブジェクトへdiagnosticsを埋め込めるようにした（`morningRunMarketData`と同じパターン）。
  - `attemptCloseReportVoiceRewrite()`を新規追加（`attemptMorningReportVoiceRewrite`の隣）。close_report専用のrequest builder(`buildCloseReportVoiceRewriteRequestBody`)・`validateCloseReportFormat`・`localCloseReportSafetyIssues`を使い、fact-drift防止チェック・URL/hashtag等のローカル安全チェックはmorning用の既存実装（report非依存）をそのまま再利用。
  - scheduled live close_report分岐（`post_type === "close_report"`）: **最終Voice評価がpassed=trueの場合のみpostToXへ進むよう変更**（従来はVoice結果を保存するだけでVoice fail時も無条件にX投稿していた、という今回発見された安全ギャップを修正）。Voice単体fail時は`attemptCloseReportVoiceRewrite`で最大1回だけ同一実行内rewriteし、2回目Voiceがpassならそのテキストを採用、failまたはrewrite不採用なら`CLOSE_REPORT_VOICE_CHECK_FAILED`でX API到達前に停止。固定タグは最終Voice pass後・`postToX`直前に`appendKabumoriReportFixedHashtags()`で1回だけ付与。catchブロック（記録用）にも`isVoiceLayerFailure`判定を追加し、Voice層の失敗でfact_check_statusが誤って"failed"上書きされないようmorning_reportと同じ修正を適用（新規に導入した`CLOSE_REPORT_VOICE_CHECK_FAILED`によって初めて顕在化する経路のため、close_report側にも同じ修正が必要と判断）。close_reportの外側scheduled retry機構は新設していない（既存どおり、失敗時はそのまま`throw error`）。
  - close_report dry-run分岐（`isCloseReportDryRun`）: liveと同じrewrite-and-reverifyロジックを適用し、`wouldPublish`・`voiceCheck.status`・`voiceEvaluation`（最終評価）・`finalTextWithHashtags`（wouldPublish時のみ固定タグ付き）を返すよう拡張。dry-runは今回もX APIを一切呼ばない（既存構造テストで確認、かつ新規追加分もこの制約下で実装）。
- `supabase/functions/x-test-post/morning_report_voice_rewrite_logic.ts` → `report_voice_rewrite_logic.ts`（`git mv`でrename）
  - 「必要ならreport共通rewrite helper（morning用を安全に一般化する最小変更可）」という指示に基づき、ファイル名のみreport非依存な名前へ変更。**既存のexport名・実装は一切変更していない**（`buildMorningReportVoiceRewriteRequestBody`・`parseMorningReportVoiceRewriteOutputText`・`morningReportVoiceRewritePreservesFacts`・`morningReportVoiceRewriteSafetyIssues`はすべて元の名前のまま。fact-drift防止チェックとローカル安全チェックはもともとreport非依存な実装だったため、close_report側からもそのまま再利用）。
  - 新規追加: `buildCloseReportVoiceRewriteRequestBody()`（close_report固有の固定見出し・構成を維持する指示文）、定数`REPORT_VOICE_REWRITE_MODEL`（旧`MORNING_REPORT_VOICE_REWRITE_MODEL`をreport非依存な名前へrename、他ファイルからの参照がなかったことを確認済み）。
- `supabase/functions/x-test-post/morning_report_voice_rewrite_logic_test.ts` → `report_voice_rewrite_logic_test.ts`（`git mv`でrename。import path更新のみ、既存テストの内容・アサーションは無変更）。close_report builder用のテスト2件を追加（固定見出しを含むこと、morning版と異なるjson_schema名を使うこと）。
- `supabase/functions/x-test-post/close_report_logic_test.ts`: 削除されたhashtag-in-generateCloseReport前提の既存テスト1件を新architecture向けに書き換え、新規テスト4件を追加（liveでのhashtag配線順序・postToX gate・rewrite最大1回・dry-runでのrewrite/hashtagプレビュー）。既存の43テストのうち、architecture変更に伴う書き換えが必要だった2件（`appendFixedCloseReportHashtags`呼び出し前提のテスト、コメント内の"postToX"という語が誤って正規表現にマッチしていた構造テスト）を修正。`close_report_logic.ts`本体は無変更（diffなし）。

### tests

- `deno test --no-check --allow-read --allow-env`（`useful_tip_output_test.ts`除く、前タスクから継続する既知の環境依存issue）: **322 passed / 0 failed**（前タスク終了時点316 → 今回close_report関連で純増6件: `report_voice_rewrite_logic_test.ts`に2件追加、`close_report_logic_test.ts`に4件追加、既存2件は書き換え）。
- `deno check index.ts close_report_logic.ts report_voice_rewrite_logic.ts`: 今回変更起因の新規型エラー0件。検出された既存6件（`_shared/x_oauth2_post.ts`等のUint8Array/BufferSource関連、`morning_greeting_logic.ts`のretry_count関連）は前タスクから継続する、denoバージョン起因の既存issueであることを確認済み（今回のタスク対象外）。
- `deno lint`（変更・新規ファイル一式）: 今回変更起因の新規lint issue 0件。検出された2件（`index.ts`の`xWeightedLength`未使用・`unsafeOptionalMaterialCount`のprefer-const）は前タスクから継続する既存issue、今回の変更箇所とは無関係。

### commit hash

- ローカルのみ: `0716046`（`Mark Claude slot 1 close-report-final-hardening task in_progress`）に続く実装コミット（このReport追記前の時点ではまだ未コミット。Report追記・status更新後にまとめてコミットする）。

### production changesなし

- production deploy: **未実施**（禁止どおり）。
- `posting_windows.close_report.is_active`: **未変更**。今回のセッションでDB write系コマンドは一切実行していない（read-onlyクエリも今回は未実施 — 前タスクのdeploy検証時とは異なり、今回は実装・ローカルテストのみで完結）。
- DB migration/schema/GRANT: なし。Cron: なし。secrets: なし。X実投稿: なし。
- Codex担当領域・Claude slot 2担当領域には一切触れていない（`git status`で確認済み）。

### 次工程の提案

1. K1レビュー・承認
2. 承認後、push
3. （承認された場合のみ）`x-test-post`を本番へdeploy
4. deploy後、`close_report_dry_run`モードで本番read-only確認（前回の`morning-content-resilience`タスクと同じ手順: Voice first pass時の固定タグ付与確認、可能であれば意図的にVoice failしやすい状況でのrewrite-diagnostics確認）
5. dry-run確認が問題なければ、`posting_windows.close_report.is_active`をtrueへ有効化するかどうかはユーザー/ちゃっぴー判断
