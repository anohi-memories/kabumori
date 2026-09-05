# Claude Task 1

Claude Code（くろちゃん）並列スロット1の現在タスクです。`G1` を受けたClaude Codeは、`.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認したうえで、このファイルを自分の担当タスク正本として扱います。

- task_id: important-news-voice-guided-retry-20260905
- owner: claude
- slot: claude-1
- status: review_required
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

## Report

- task_id: important-news-voice-guided-retry-20260905
- result: 実装・テスト・commit/push完了。`isRetryableVoiceFailure`の分類パターンを拡張し、「英単語混在・和英混在」「単複・助詞・文法・敬体」を新たにretry対象へ追加。同時に、既存の`/人物|企業|国|制度/`パターンが「米国」等の国名を含むだけの無害な文でも誤って非retry判定していたバグ（bare `国` の部分一致問題）を発見し、`/国名/`（国名の誤り、という具体的claim）へ厳格化して修正した。実例（Putin/Kyivニュース、Fact=passed, Voiceが「欧州のリスク sentiment」の英単語混在＋「米国の特使が」の単複不一致を指摘）をunit testとend-to-end統合テストの両方で固定した。
- changed_files:
  - `supabase/functions/important-news-monitor/post_generation_logic.ts`（`RETRYABLE_VOICE_ISSUE_PATTERNS`へ9パターン追加、`NON_RETRYABLE_VOICE_ISSUE_PATTERNS`の`国`→`国名`厳格化、voice_retryプロンプト文言に新カテゴリを明記）
  - `supabase/functions/important-news-monitor/post_generation_logic_test.ts`（classifier新規8テスト＋実例再現end-to-end統合テスト1件を追加）
- tests: important-news-monitor全体回帰 **231/231 pass**（`post_generation_logic_test.ts`は92/92、新規9件含む）
- commit_hash: `f45ca12`
- push: 完了（origin/main反映済み、push前後でdrift確認済み）
- deploy: 未実施（scope指示どおり禁止。K1レビュー後に別タスクとして対応）
- retry_rule:
  - retryable: 重複・同義反復・冗長・不自然な接続/締め・ぎこちなさ・ニュース原稿/AI要約/報道文体/会話調系の指摘（既存）＋**英単語混在・和英混在・日本語として不自然（外来語混在）・単複/複数形/単数形・助詞・文法・敬体**（今回追加）
  - non-retryable（変更なし、範囲厳格化のみ）: 断定・誤り・取り違え・改変・根拠・出典・ソース・意味が変わる・安全性・情報不足・unsupported・証券コード・数字・日付・事実・捏造・人物/企業/**国名**（bare「国」から厳格化）/制度
  - 全issueがretryable判定でなければretryしない（従来どおり`.every()`方式、未知issueは安全側でfalseデフォルト）
  - retry最大1回、既存の1回制限ロジック（`generateImportantNewsPost`内の到達経路が1箇所のみ）は無変更
- safety_checks:
  - Fact gate: 無変更。retry対象はFact=passed かつ全Voice issueがretryable判定の場合のみ
  - retry後は必ずFact再チェック→Voice再チェックの順で両方passedのときのみ`ready_for_publish`（無変更）
  - retry回数1回制限: 無変更（コード構造上2回目のretry経路は存在しない）
  - model: 無変更（既存generation model継続使用）
  - `generation_voice_retry`診断情報（attempted/voice_retry_count/initial_voice_issues/retry_fact_status/retry_voice_status/retry_voice_issues/retry_error）: フィールド構造・書き込みロジックとも無変更
  - `importance_judgement_logic.ts`、breaking_market検索、TDnet/market_macro取得: 未接触
  - auto_publish、X投稿ロジック、Cron、DB schema/migration/GRANT、本番設定: 未変更
  - morning greeting系: 未接触
  - 他workstreamの未コミット変更（Codexの`.agent/CODEX_REPORT.md`・`.agent/tasks/CODEX_TASK.md`含む）: 変更・stage・commitなし（`git reset --mixed`でbranch pointerのみ移動、working tree上のCodex編集は無傷を確認）
  - secrets: 非表示・非変更
- remaining_issues:
  - 実際のOpenAI Voice checkerが「英単語混在」「単複」等を実際どう表現するかには自然文のバリエーションがあり、今回追加した正規表現パターンで完全に網羅できているかはdeploy後の自然運用でしか実証できない
  - `/国名/`への厳格化により、今後「国名」という単語を使わずに国名誤りを表現するVoice issue（例:「アメリカではなくイギリスの誤り」）は`誤り`パターンで引き続き捕捉されるが、念のため今後の自然観測で見ておきたい
- next_recommendation: K1レビュー後、問題なければ`important-news-monitor`をdeployし、次回以降Voice retryが実際に発火する自然事例をread-onlyで観測することを推奨。