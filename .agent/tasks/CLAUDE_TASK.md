# Claude Task 2

- task_id: morning-report-us-holiday-session-labeling-20260908
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: urgent
- purpose: 2026-09-08朝刊で、前夜の米国市場がLabor Day休場だったにもかかわらず、前営業日9/4の半導体上昇をトップ項目で「米国半導体株が広く上昇。半導体指数も約3%上昇」と出し、読者に「昨夜の値動き」と誤認させる時間軸問題が発生した。米国市場の休場判定と前営業日ラベルを機械的に保証し、朝刊が古いセッションを最新セッションのように表現しないよう最小修正する。

## Confirmed incident

2026-09-08朝刊では:
- 前夜2026-09-07の米国株式市場はLabor Dayで休場
- 実際の約3%半導体上昇は前営業日2026-09-04の動き
- 本文途中では「前週末の米国市場では」と書けていた
- しかしトップ3では「米国半導体株が広く上昇。半導体指数も約3%上昇」とだけ表示され、通常読者は昨夜の値動きと解釈する

これは「数字自体の捏造」ではなく、セッション日付・休場情報の表示欠落による重大な時間軸誤認。

## Required investigation

1. 現在の`morning_report`が米国市場セッション日をどう決めているか確認する。
2. 既存の`getExpectedUsSessionDate()`や米国市場営業日/休日判定を再利用できるか確認する。
3. Labor DayなどNYSE/Nasdaq休場日の翌朝に、前営業日の指数・SOX等を使う場合どのフィールド/ロジックで区別できるか確認する。
4. 生成プロンプト、fact-check、format validator、local safetyのどこに「セッション日ラベル強制」を入れるのが最も決定的で安全か判断する。
5. 9/8 incidentを再現するテストを先に追加する。

## Required implementation

### 1. 米国市場休場を機械判定

朝刊生成時に、対象となる「前夜の米国市場」が休場だったかを明示的に判定できる状態にする。

- 休日判定をLLM推測だけに任せない
- 既存の米国セッション日ロジックが使えるなら再利用
- 新たな外部依存を増やさない最小実装を優先

### 2. 休場翌朝は冒頭で明示

前夜が米国休場だった場合、朝刊本文の上部（少なくともトップ3より前または最初の注目ポイント内）に、読者が誤認しない形で必ず明示する。

例:
- `昨夜の米国株はLabor Dayで休場。以下は前営業日9/4の動きです。`

休日名が安全に確定できない場合は:
- `昨夜の米国株は休場。以下は前営業日の動きです。`

のように、休場事実と前営業日参照を最低限保証する。

### 3. 前営業日データのラベル強制

休場翌朝に前営業日の指数・SOX・個別株の値動きを扱う場合:

禁止:
- `米国半導体株が上昇`
- `SOXが3%上昇`
- `米株は下落`

のように、いつの値動きか不明なトップ見出し。

必須:
- `前営業日9/4の米国市場では…`
- `前週末のSOXは約3%上昇`
- `前営業日の米半導体株は…`

など、古いセッションであることが見出し/要約だけ読んでも分かる表現。

### 4. セッション日整合性をvalidator/fact checkで保証

LLMプロンプトだけではなく、可能な範囲で決定的チェックを追加する。

最低限:
- 前夜休場時に`昨夜/前夜の米国市場が上昇・下落した`と読める表現を許さない
- 前営業日データを使う場合、本文または該当ポイントに`前営業日`/具体日付/`前週末`等のラベルがあること
- `usSessionDate`と本文のセッション参照が矛盾しないこと

### 5. 休場日は古い材料を最新材料扱いしない

米国休場日に前営業日の株価材料を再利用する場合でも:
- その後に発生した新しいマクロ/為替/金利/地政学材料があれば、時間軸上そちらを優先できるようにする
- 「前営業日の株価材料」だけでトップ3を埋めない

ただし今回は大規模な材料ランキング再設計は不要。まず時間軸誤認を確実に防ぐ最小修正を優先する。

## Tests

最低限:
1. 2026-09-08 JST朝 → 前夜2026-09-07 Labor Day休場と判定できる
2. 休場翌朝に9/4のSOX上昇を使う場合、`前営業日`/`前週末`/具体日付ラベルなしの出力をreject
3. `米国半導体株が広く上昇。半導体指数も約3%上昇`のような無日付表現を9/8条件でreject
4. `昨夜の米国株は休場。前営業日9/4のSOXは約3%上昇`はaccept
5. 通常の米国営業日翌朝では既存の「昨夜の米国市場」表現を不必要に壊さない
6. weekend後の月曜朝など既存セッション日ロジックと整合する
7. morning_report relevant tests pass
8. full x-test-post regression pass

## Scope / conflicts

主対象:
- `supabase/functions/x-test-post/morning_report_logic.ts`
- `supabase/functions/x-test-post/index.ts`
- `supabase/functions/x-test-post/us_session_date_logic.ts`（必要な場合のみ）
- 関連tests

触らない:
- Codex `important-news-monitor/**`
- Claude slot1担当領域
- `send-push-notifications/**`
- morning_greeting OAuth/media upload関連
- close_report
- DB migration/schema/GRANT
- Cron
- `posting_windows`
- secrets
- 他Edge Function

## Production policy

このTASKは **調査 + local実装 + tests + commitまで**。

禁止:
- production deploy
- X実投稿
- 本番DB write
- migration/schema/GRANT
- Cron変更
- posting_windows変更
- secrets変更/表示

## Completion

完了時:
- status: `review_required`
- next_owner: `chatgpt`
- `## Report`追記
- incident再現条件
- root cause
- 休場判定方法
- 前営業日ラベル保証方法
- changed files
- reproduction/relevant/full test結果
- commit hash
- production変更なし
- 次工程推奨
