# Claude Task 2

- task_id: close-report-factcheck-dryrun-live-parity-20260907
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: urgent
- purpose: 2026-09-07 の close_report で、同じ production v89 に対し `close_report_dry_run` は `factCheck=passed / wouldPublish=true` だった一方、1回だけ実行した live close_report は `CLOSE_REPORT_FACT_CHECK_FAILED` で X API 前に安全停止した。dry-run/live の差分を根本原因まで特定し、最小修正する。

## Confirmed incident

- production `x-test-post`: v89 ACTIVE
- `close_report_dry_run`:
  - `factCheck: passed`
  - `Voice: passed`
  - `wouldPublish: true`
  - fixed 4 tags 各1回、重複なし
  - X未投稿
- live close_report を1回だけ実行:
  - `CLOSE_REPORT_FACT_CHECK_FAILED`
  - X未投稿 / x_post_id null
  - 二重投稿なし
  - 安全ゲートを迂回する再試行なし
- `posting_windows.close_report.is_active=false` を維持

## Investigation scope

重点的に比較する:
- dry-run/live それぞれが Fact Check へ渡す生成本文
- source/evidence
- market data
- fact-check request body
- mode依存分岐
- claim/run state
- 実行時刻による入力差
- liveだけ再生成・再取得されていないか
- dry-runとliveが同じFact Check関数・同じ判定条件を通っているか

## Required work

1. 根本原因を特定する。
2. まず問題を再現するテストを追加する。
3. dry-run/live の Fact Check 条件差が原因なら、同一入力・同一条件で同じ判定になるよう最小修正する。
4. 必要なら診断情報を追加し、dry-run/live の比較ができるようにする。
5. 既存 v89 の以下を壊さない:
   - close_report Voice gate
   - Voice fail時最大1回rewrite
   - 固定4タグを最終Voice後に1回だけ付与
   - X二重投稿防止
6. relevant tests + full regression testを実行する。

## Safety / scope

触ってよい主対象:
- `supabase/functions/x-test-post/**` の close_report / fact-check 関連
- 必要な関連tests

触らない:
- Codex `important-news-monitor/**`
- Claude slot1 の別タスク領域
- `send-push-notifications/**`
- 他Edge Function

禁止:
- production deploy
- X実投稿
- `posting_windows`変更
- DB migration/schema/GRANT
- Cron変更
- secrets変更/表示
- 本番設定変更

## Completion

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report` を追記
- 根本原因
- dry-run/live の具体的な差
- changed files
- 再現テスト
- relevant/full test結果
- commit hash
- production変更なし
- 次工程の推奨

## Report

- task_id: close-report-factcheck-dryrun-live-parity-20260907
- result: 根本原因を2点特定し、いずれも最小修正済み。commit `ce15350`を`origin/main`へpush済み（親は本タスクの`in_progress`commit `64f7fc1`）。production DB・migration・Cron・X実投稿・`important-news-monitor`・Codex現在task対象には一切触れていない。
- investigation（read-only、production変更なし）:
  - `supabase db query --linked`で2026-09-07の`close_report_runs`を直接確認（secret値は非表示）。該当3件を発見:
    1. `99bfffc3`（16:00:01 JST、dry-run、`scheduled_post_id=null`）: `CLOSE_REPORT_FACT_CHECK_FAILED`。notes:「16:00以降に公開された未来情報が混入」「optional材料に未来時刻または不正なtimestampが混入」等7件
    2. `5620c349`（16:43:44 JST、dry-run、`scheduled_post_id=null`）: `dry_run_succeeded`、factCheck=passed。notes:「参照時刻は2026-09-07T07:43:44Z（日本時間16:43:44）として扱った」
    3. `090b0ebd`（16:45:25 JST、**live**、`scheduled_post_id`あり）: `CLOSE_REPORT_FACT_CHECK_FAILED`。**fact_check_notes=[]（空）**、character_count=null
  - `090b0ebd`（`scheduled_post_id`を持つ唯一の行）が真の"1回だけ実行したlive close_report"であることを確認。これがユーザー報告の「liveがFACT_CHECK_FAILED」に対応する。
- root_cause_1（Fact Check条件差、本命）: `generateCloseReport()`のcutoff instructionが、dry-runのみが明示opt-inできる`allowCurrentTimeReferenceForDryRun`フラグでtwo-way分岐していた。
  - false（live常時 / dry-run未指定時のdefault）:「通常運用では16:00 JSTまでに公開済みのものだけを使用します」という**文字通り固定**の文言
  - true（dry-runが明示的にopt-inした場合のみ）:「参照時刻（実行時刻）までに公開済みのものだけを使用」という**実際の参照時刻に基づく**文言
  - 実データ上、falseの文言を使った`99bfffc3`（dry-run、16:00:01ちょうど）と`090b0ebd`（live、16:45:25）は両方とも`future_information_absent=false`でFact Check失敗。trueの文言を使った`5620c349`（dry-run、16:43:44、`090b0ebd`のわずか1分41秒前）はpassed。「通常運用の16:00ちょうど」でさえ失敗しており、コード中のコメント前提（"normal 16:00 JST operation is never affected"）が実データで反証された。
  - 修正: 分岐を完全に撤去し、常に参照時刻ベースの文言（安全側で実績のある方）のみを使用するよう統一。他の安全ゲート（sourceVerified/freshness/causal-safety/TODAY-NEXT/Voice/hashtags）は無変更。
- root_cause_2（診断情報欠落）: live側の失敗ハンドラ（`scheduledPost.post_type === "close_report"`のcatch）は、`fact_check_notes`を**voice層の失敗時にしか書き込んでいなかった**。通常の`CLOSE_REPORT_FACT_CHECK_FAILED`（今回の実際のケース）ではnotesが一切保存されず、`090b0ebd`のように空配列のまま残っていた。これが今回の調査を困難にした直接の理由。
  - 修正: dry-run・live両方のcatchブロックで、`draft`が存在する限り`draft.factCheckNotes`へフォールバックするよう統一（voiceFailure時はさらに`voiceEvaluationFailureNotes`を追加）。
- changed_files（commit `ce15350`、対象は`supabase/functions/x-test-post/**`のみ）:
  - `index.ts`:
    - `generateCloseReport()`のシグネチャから`options`パラメータを削除し、cutoff instructionを単一の参照時刻ベース文言に統一
    - dry-run呼び出し元（`isCloseReportDryRun`分岐）から`allow_current_time_reference_for_dry_run`のrequest body読み取り・ローカル変数・第3引数を削除
    - `requestBody`の型定義から`allow_current_time_reference_for_dry_run?: unknown`を削除
    - close_report dry-runのcatchブロックの`fact_check_notes`を`draft`存在時は常に`draft.factCheckNotes`（+voice失敗時は追加notes）にフォールバックするよう修正
    - close_report live（`scheduledPost.post_type === "close_report"`）のcatchブロックも同様に修正
  - `close_report_logic_test.ts`: 古い分岐を前提としたtest 4件（1+2, 3+8, 4+5, "dry-run defaults..."）を、新しい単一条件・両catchブロックのnotesフォールバックを検証するtest 3件に置き換え
- reproduction_test: 新しい3テストのうち「generateCloseReport has exactly one cutoff instruction, with no dry-run/live mode branch」は**修正前のsourceに対しては失敗する**設計（`allowCurrentTimeReferenceForDryRun`の存在を`doesNotMatch`で検証）ため、修正前後の状態を確認する再現テストとして機能する。同様に「both the dry-run and live close_report failure handlers fall back to draft.factCheckNotes」も修正前は失敗する。
- tests:
  - `node --test supabase/functions/x-test-post/close_report_logic_test.ts`：**46/46 pass**
  - `node --test supabase/functions/x-test-post/*_test.ts`（full regression）：**330/330 pass**
  - `npx tsc --noEmit`：今回編集した`index.ts`・`close_report_logic_test.ts`の該当行範囲（2047-2070, 3488-3500, 3590-3615, 4080-4115付近）に新規エラーなし。既存のDeno関連エラー（`Deno`未定義、`.ts`拡張子import、`node:`型解決）は変更していない`important-news-monitor`等でも同数量出る、リポジトリ全体の既知のtsconfig事象であり、今回の変更固有ではない。
- commit_hash: `ce15350`（`origin/main`へpush済み、親は`in_progress`commit `64f7fc1`）
- production変更なし: DB migration/schema/GRANT、Cron、X実投稿、`posting_windows`、secrets、本番Edge Function deployのいずれも一切実施していない。修正はコードのみで、次回deployされて初めて本番に反映される。
- safety_checks:
  - `supabase/functions/important-news-monitor/**`：一切変更していない
  - Codex現在task（`important-news-freshness-coverage-fix-20260906`）対象：一切変更していない
  - `send-push-notifications/**`、他Edge Function：一切変更していない
  - close_report Voice gate、Voice fail時最大1回rewrite、固定4タグ最終Voice後1回付与、X二重投稿防止：既存の全regression test（330件）で無傷を確認
  - `posting_windows`変更、DB migration/schema/GRANT、Cron変更、secrets変更/表示、本番設定変更：一切行っていない
  - 本番deploy、X実投稿：一切実施していない
  - 他workstream（stocks sync関連、`.env`、`.claude/launch.json`、`apps/admin`、Codexの`.agent`ファイル等）：一切変更・stage・commitしていない
- next_recommendation: (a) 今回のcommit`ce15350`をレビューし問題なければK2、(b) 承認後、次回の`x-test-post`本番deployでこの修正を反映（deployは本タスクのforbidden対象のため未実施）、(c) deploy後は`close_report_dry_run`を通常運用時刻（16:00 JST付近）で再実行し、新しい参照時刻ベース文言でfactCheck=passedが安定して得られることをread-onlyで確認することを推奨、(d) `close_report_runs.fact_check_notes`が今後のlive失敗で正しく埋まることも合わせて確認
