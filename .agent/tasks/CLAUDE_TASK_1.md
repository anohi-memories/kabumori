# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-voice-guided-retry-20260905
- owner: claude
- slot: claude-1
- status: ready
- purpose: important-news生成後のVoiceチェックで、AI自身が具体的な修正点を特定できているにもかかわらず再生成せず `generation_failed` になるケースを改善する。Factがpassedで、Voice issueが修正可能な表現・文法・単複・不自然な和英混在などに限定される場合は、そのVoice指摘を明示的な修正指示として1回だけ再生成し、再度Fact + Voiceを通して安全に復帰できるようにする。
- scope:
  - `supabase/functions/important-news-monitor/post_generation_logic.ts`
  - `supabase/functions/important-news-monitor/post_generation_logic_test.ts`
  - 必要なら `generation_persistence_test.ts` / `generation_dispatch_logic_test.ts` 等、今回のretry挙動を直接固定するテストのみ
  - 既存の `generation_voice_retry` 診断情報の整合性確認
- forbidden:
  - P0.7 corporate X market-impact gateを開始しない
  - `importance_judgement_logic.ts`、breaking_market検索、TDnet取得、market_macro取得を変更しない
  - auto_publishを変更しない
  - X投稿実行・投稿ロジック変更をしない
  - Cron、DB schema/migration/GRANT、本番設定を変更しない
  - morning greeting系を変更しない
  - モデルを変更しない（現行 generation model を維持）
  - retry回数を1回より増やさない
  - Fact failure / source不一致 / 数字・固有名詞・日付・引用・因果・安全性など、事実性に関わる問題をVoice retryで無理に直さない
  - 他workstreamの未コミット変更を変更・stage・commitしない
- completion_criteria:
  - 初回Factが `passed` かつVoiceが `failed` の場合、Voice issuesの内容が「具体的に修正可能な表現品質問題」であれば1回だけ `voice_retry` を実行する
  - retry時は初回Voice issuesをそのまま修正指示としてrunnerへ渡し、元記事/候補情報の事実関係を変えず、指摘箇所だけを直す constrained retry にする
  - retry生成後は必ず再度FactチェックとVoiceチェックを実行し、両方passedのときだけ `ready_for_publish`
  - retry後Factがfailed、またはVoiceがfailedなら `generation_failed` のままにする
  - 「日本語として不自然な英単語混在」「助詞・単複・敬体などの軽微な文法」「冗長・ニュース原稿調・不自然な言い回し」など、Voiceが具体的修正案を出せるケースをretry対象に含める
  - 今回の実例相当をテストで固定する：
    - `欧州のリスク sentiment` → 自然な日本語への修正を促せる
    - `米国の特使が` に対してVoice checkerが「原文は複数なので『特使ら』が自然」と指摘した場合、Factがpassedであればretry対象にできる
  - ただし、Voice issueに「事実誤認」「数字不一致」「人物/企業/地域/日付の誤り」「ソースにない断定」「因果の捏造」などが含まれる場合はretryしない、またはretry後Factで確実に止める
  - `generation_voice_retry.attempted=true`、`voice_retry_count=1`、initial/retry issues、retry fact/voice status等の既存診断情報が正しく残ることを確認する
  - retryしないケースは従来どおり `attempted=false`
  - 既存の重要ニュース生成テスト全体を実行し回帰なしを確認する
  - 実装・テスト後、最小差分でcommit/pushしてよい
  - 本番deployは禁止。K1レビュー待ちで `review_required` にする
- commit: 今回のClaude slot 1作業として安全に分離できる変更のみ最小差分でcommit
- push: fresh-checkで競合がないことを確認してorigin/mainへpushしてよい。drift/競合があれば停止して報告
- deploy: 禁止。K1承認後に別タスクとして行う
- report_mode: inline
- next_owner: chatgpt

## Background / production example

2026-09-05の自然運用で以下の `breaking_market` 候補が `generation_failed` になった。

- title: `Putin orders a 72-hour pause in strikes on Kyiv as U.S. envoys visit Russia and Ukraine`
- generation_fact_status: `passed`
- generation_voice_status: `failed`
- generation_error: `NEWS_GENERATION_VOICE_FAILED`
- generated text included: `欧州のリスク sentiment`
- Voice issues:
  - `「欧州のリスク sentiment」は日本語として不自然で、英単語が混在しています。「欧州のリスク選好」や「欧州の市場心理」などに直す必要があります。`
  - `「米国の特使が」は原文の複数形と合っていないため、「米国の特使ら」などが自然です。`
- しかし `generation_voice_retry.attempted=false` だった。

ユーザー方針：Voice checker自身が「何をどう直せばいいか」を具体的に示しているなら、その修正指示を使って1回だけ作り直し、Fact + Voiceを再確認して通れば採用する。新しい情報や解釈を追加する再生成ではなく、指摘箇所だけを直す安全な修正retryにする。

## Safety intent

この変更の目的は「失敗を減らすこと」ではなく、「修正可能な文章品質エラーだけを安全に自己修正すること」。Fact gateを弱めないことを最優先にする。

## Completion report

完了時はこのファイル末尾に `## Report` を追加し、task_id / result / changed_files / tests / commit_hash / push / deploy / retry_rule / safety_checks / remaining_issues / next_recommendation を記録する。