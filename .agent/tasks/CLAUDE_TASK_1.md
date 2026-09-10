# Claude Task 1

- task_id: important-news-push-copy-quality-20260910
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
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
