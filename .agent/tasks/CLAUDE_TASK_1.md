# Claude Task 1

- task_id: morning-greeting-tone-image-variety-20260908
- owner: claude
- slot: claude-1
- status: ready
- next_owner: claude
- priority: high
- purpose: `morning_greeting` を「朝刊のミニ版」ではなく、気持ちよく読める朝の挨拶として再設計し、同時に画像生成が毎日ほぼ同じ構図へ収束する問題を解消する。人物の一貫性は維持しつつ、文章テーマ・場所・行動・構図・小物・服装・天候・季節感に十分なバリエーションを持たせ、APIコストに見合う出力へ改善する。

## Background / confirmed issues

### Text issue
2026-09-08生成例:
`おはようございます☀️ 朝は値動きやニュースを追う前に、前日の海外市場や決算予定をざっと見ておくと...`

問題:
- 朝の挨拶なのに株・相場要素が強すぎる
- `morning_report` と役割が重複している
- 毎朝、相場確認を促す文章に寄せる必要はない

望ましい役割分担:
- `morning_greeting`: 親しみ・季節感・日常・記念日・気持ちのよい朝の挨拶
- `morning_report`: 相場・ニュース・日本株見通し

### Image issue
2026-09-02〜09-08の実画像を確認した結果、ほぼ毎回以下に収束:
- 室内
- 朝日の入る窓際
- 観葉植物
- 上半身の正面構図
- 正面笑顔
- 両手または片手でマグカップ
- 白〜ベージュ系トップス
- 同じような椅子・テーブル背景

変化は服色・植物位置・カップ持ち方程度で、APIコストに対して実質的なバリエーションが不足している。

## Required design — greeting text

1. 朝の挨拶文は原則として株テーマを使わない。
2. その日に自然な話題がある場合は以下を優先:
   - `○○の日` / 記念日
   - 季節行事
   - 季節感（暑さ、秋の気配、朝晩の変化等）
   - 曜日感（月曜、週末、連休明け等）
   - 日常の小さな話題
3. 特に自然なテーマが無い日は、普通に気持ちのよい朝の挨拶だけでよい。無理にニュース・相場・豆知識を入れない。
4. 株・投資・相場の具体材料は原則 `morning_report` に任せる。
5. 株要素を入れる場合でも、ごく軽い一言まで。市場材料・指数・決算・海外市場解説は入れない。
6. 文章は自然で親しみやすく、X上で読みやすい長さを維持する。説教調・自己啓発調・AI金融記事調を避ける。
7. 既存の文字数validator、安全ゲート、固定hashtags仕様がある場合は壊さない。
8. 既存固定hashtagsは現在の正式仕様を確認し、勝手に変更しない。

## Required design — image variety

人物のキャラクター一貫性は維持する一方、シーンを毎日明確に変える。

最低限、生成前に以下の軸を決定する設計にする:
- location
- activity
- camera_angle
- framing
- prop
- expression
- outfit
- weather / lighting
- seasonal_element

候補例:
- ベランダで朝日を浴びる
- 住宅街や公園を朝散歩
- 玄関で靴を履く / 出かける準備
- カーテンを開ける
- 朝食を作る
- トーストやフルーツを食べる
- 花や植物に水やり
- 読書
- 軽いストレッチ
- 洗濯物を干す
- 雨の日に傘を持つ / 窓の外を見る
- 秋服で外を歩く
- 週末のゆったりした朝
- 記念日テーマに対応する小物・場所

## Anti-repetition requirements

1. 直近7日程度の生成履歴を利用できるなら、以下の完全一致・近似一致を避ける:
   - location
   - activity
   - dominant prop
   - camera framing / angle
   - outfit category / dominant color family
2. 特に直近7日で多発している以下を強く抑制:
   - `窓際 + 観葉植物 + マグカップ + 正面上半身`
3. 同じdominant propを連日使わない。少なくともマグカップは連日禁止。
4. 同じlocationを2日連続で使わない。
5. 同じframing / camera angleを2日連続で使わない。
6. キャラ維持用の固定要素と、毎日変える可変要素をprompt上で明確に分離する。
7. 記念日/季節テーマが文章側で採用された日は、画像側も可能な範囲で同テーマに同期する。
8. 生成履歴の取得が難しい場合でも、date seed / deterministic rotation等で少なくとも複数scene templateをローテーションし、毎回同テンプレに収束しない構造にする。

## Important quality constraint

単純にランダム語句を足して不自然な絵を作るのではなく、1枚の画像として一貫したsceneを作ること。
人物の顔・髪型・全体キャラクター性は維持しつつ、背景・行動・ポーズ・構図を変える。

## Investigation

1. 現在のmorning_greeting本文生成prompt / theme selectionを特定。
2. 現在の画像prompt builderを特定。
3. なぜ`窓際・観葉植物・マグカップ`へ収束しているか、固定prompt・fallback・validator・reference image等の寄与を具体的に説明。
4. 既存の生成履歴/Storage metadata/DB等で直近scene情報を利用できるか確認。
5. 大きなDB migrationなしで実装可能な最小案を優先。

## Tests

最低限:
1. テーマなし通常日 -> 株・相場解説を含まない自然な朝挨拶
2. 記念日あり -> 記念日を自然に取り込める
3. morning_reportの役割を侵食する具体的市場材料をmorning_greetingに出さない
4. 連続日でlocation/activity/prop/framingが固定化しない
5. マグカップ連投を防止
6. `window + plants + mug + front-facing upper body`の連投を防止
7. seasonal/holiday themeが選ばれた場合、text/image themeが矛盾しない
8. 既存文字数・theme validation・image validation・publish safety regression pass
9. full x-test-post regression pass

可能なら複数日（例: 14日分）のdry generationを行い、scene diversityを一覧化して確認する。実画像APIを14回叩く必要はない。prompt/scene planレベルのdry generationで十分。

## Scope / conflicts

主対象:
- `supabase/functions/x-test-post/**` のmorning_greeting生成関連
- 関連tests

触らない:
- Codex current important-news task
- Claude slot2 morning_report US holiday/session labeling task
- `important-news-monitor/**`
- `send-push-notifications/**`
- close_report
- DB migration/schema/GRANT unless absolutely unavoidable;必要なら実施せず提案に留める
- Cron
- posting_windows
- production secrets

## Production policy

このTASKは investigation + local implementation + tests + commitまで。

禁止:
- production deploy
- X実投稿
- production DB write/migration
- Cron変更
- secrets変更
- posting_windows変更

## Completion

完了時:
- `status: review_required`
- `next_owner: chatgpt`
- `## Report`追記
- root cause of repetitive images
- text-generation policy changes
- image scene diversification design
- changed files
- 14-day dry scene plan / diversity evidence if feasible
- tests
- commit hash
- production unchanged
- next recommended deploy/verification steps
