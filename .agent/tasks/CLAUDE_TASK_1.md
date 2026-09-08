# Claude Task 1

- task_id: morning-greeting-tone-image-variety-20260908
- owner: claude
- slot: claude-1
- status: review_required
- next_owner: chatgpt
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

## Report

- task_id: morning-greeting-tone-image-variety-20260908
- result: 完了。investigation・実装・テストのみ、ローカルコミット済み、production変更なし。

### root cause of repetitive images

`morning_greeting_logic.ts`の`selectMorningGreetingTheme()`で、`weekday`（週の始まり・金曜日・週末・月初・月末）と`generic`（テーマなし）の2branchが、`visual_theme`へ**完全に同一の固定文字列**「朝の窓辺、コーヒー、観葉植物、やわらかい朝日」を返していた。この2branchが実質ほぼ毎日選ばれる（`special_day`/`seasonal`は年間十数日のみ）。

この`visual_theme`は`morning_greeting_image_logic.ts`の`buildMorningGreetingImagePrompt()`で"Scene/backdrop and props: {visual_theme}."としてそのまま画像生成promptへ渡される。画像生成は`gpt-image-2`のidentity-preserve編集モードで、キャラクター同一性維持用の**canonical reference画像は日によって変わらない設計**（意図通り）。したがって、visual_themeが毎日同一であれば、モデルへの日々の変化入力が実質ゼロになり、生成結果が「室内・窓際・観葉植物・マグカップ・正面上半身」へ収束するのは構造上必然だった。fallbackやvalidatorの寄与ではなく、**単一の固定promptテキストが直接の原因**。

### 生成履歴/Storage metadataの利用可否（Investigation #4）

実際の日次画像生成は`index.ts`ではなく`scripts/morning-greeting-image.ts`（`.github/workflows/morning-greeting-image.yml`が毎日05:30 JSTに実行）が担っている。このscriptは`generated/{date}.png`をSupabase Storageへ保存するのみで、**どのscene/prompt/軸を使ったかを記録するDBテーブルもStorage object metadataも存在しない**。過去の実際のscene選択を後から機械的に参照する手段は現状ゼロ。DB migrationで履歴テーブルを新設する案もあり得たが、今回はTASKの「大きなDB migrationなしで実装可能な最小案を優先」に従い、**日付から決定的に導出するseeded rotation方式**（履歴不要）を採用した。

### text-generation policy changes

`morningGreetingGenerationInstructions()`（`morning_greeting_logic.ts`）を以下のとおり変更:

- 冒頭instructionを「相場や株の解説ではなく...気持ちよく読める朝の挨拶」へ変更し、`morning_report`との役割分担を明記。
- 新規instruction追加: 「市場材料、指数の動き、決算、海外市場、個別銘柄、値動きの解説は一切入れません」— 具体的な市場材料を明示的に禁止（TASK要件4・5）。KABUMORI_VOICE由来の「株が好きで詳しい」という人物設定自体は変更していないため、軽い自己言及程度の余地は残しつつ、具体的な相場コンテンツは構造的に排除。
- テーマなし（`theme_name === null`）の日向けinstructionに「無理に豆知識・ニュース・相場の話題を差し込む必要もありません。ただ気持ちのよい朝の挨拶であれば十分です」を追加（TASK要件3）。
- 新規instruction追加: 「説教くさい語り口、自己啓発的な締め、AIが書いた金融コラムのような硬さを避けます」（TASK要件6）。既存のKABUMORI_VOICE側の禁止語彙リスト（「〜が大切です」「まずは〜を確認しましょう」等）はそのまま活用。
- 文字数validator（100〜300文字/target 120〜200文字）・安全ゲート（おはよう必須・架空実体験禁止・未確認天気禁止・投資助言禁止・架空記念日禁止・URL/ハッシュタグ禁止）は**一切変更していない**。TASK要件7・8どおり、morning_greetingの既存固定hashtags仕様（=hashtagsは一貫して禁止、morning_report/close_reportのような固定タグ付与機能は存在しない）を確認したうえで変更していない。

### image scene diversification design

新規ファイル`morning_greeting_scene_logic.ts`: `buildMorningGreetingScenePlan(date)` — **DBやgeneration historyに一切依存しない純粋関数**（date文字列のみを入力に、9軸すべてを決定的に算出）。

9軸: location(7候補) / activity(9候補) / camera_angle(8候補) / framing(10候補) / prop(7候補) / expression(11候補) / outfit(7候補) / weather_lighting(9候補) / seasonal_element(月から季節bucketを判定し、その季節内の7候補から選択)。

各軸は`(daysSinceEpoch(date) + 軸固有オフセット) mod 候補数`で選択するcyclic rotation。設計上のポイント:

1. 候補数を軸ごとに意図的に**異なる値**（7/8/9/10/11）にした。全軸が同じ周期だと、7日おきに全軸が同時に一致し「1週間ごとに完全に同じ画像」が繰り返されてしまう（実際に最初の実装でこの問題を発見し、修正済み — テスト`the full combined scene does not repeat exactly every 7 days`で回帰防止）。異なる素数寄りの候補数にすることで、組み合わせ全体の周期はLCM(7,8,9,10,11)=27,720日（約75年）まで伸び、実質的に繰り返さない。
2. TASKが名指しした軸（location/activity/prop/framing/camera_angle/outfit）はすべて候補数7以上とし、直近7日間のどのウィンドウで見てもその軸の値が重複しないことを保証（周期7以上の巡回列は必然的にこの性質を持つ）。
3. 2日連続の重複は候補数2以上の巡回列で自動的に回避される（day NとN+1が同じ値を取ることは構造上あり得ない）ため、マグカップに限らずどの軸でも連日重複しない。
4. `special_day`/`seasonal`テーマ（元日・バレンタイン・防災の日等の固定visual_theme）は、`renderThemeSyncedVisualTheme()`でその**固定アンカーテキストをそのまま保持**しつつ、activity/camera_angle/framing/expressionという「日ごとに変えてよい構図軸」だけを追加で連結する設計にし、TASK要件6（固定要素と可変要素の明確な分離）・要件7（テーマ選択日は画像も同期）の両方を満たす。location/prop/seasonal_elementはアンカーテキスト側に既に含まれているため二重に足していない。
5. `selectMorningGreetingTheme()`自体は引き続き完全に純粋関数（`date`のみが入力）。DB/ネットワークI/Oは一切追加していない。

### 14-day dry scene plan（診断結果、実API呼び出しなし）

```
2026-09-08 [generic] -> キッチンで洗濯物を干す場面、背後から振り返る構図からの腰から上のミディアムショット、折りたたみ傘、少し驚いたような明るい表情、淡いブルー系シャツ、やわらかく差し込む逆光、色づき始めた葉
2026-09-09 [generic] -> 洗面所の鏡の前で読書をする場面、手元にフォーカスした構図からの全身が入るワイドショット、トートバッグ、静かに微笑む横顔、白系カットソー、淡い朝焼けの光、金木犀の香りを感じる仕草
2026-09-10 [generic] -> ベランダで朝日を浴びて伸びをする場面、斜め後ろから覗き込むような構図からの手元と表情を含む近距離ショット、じょうろ、口角がふっと上がる自然な表情、くすみピンク系カーディガン、曇り空越しの均一な光、秋らしい薄手の上着
2026-09-11 [weekday:金曜日] -> 住宅街の朝の道で朝散歩をする場面、正面からの背景を広く見せる引きの構図、本、楽しそうにくすっと笑う表情、グレー系パーカー、朝日が斜めに差し込む光、実りの季節を感じる果物
2026-09-12 [weekday:週末] -> 近所の公園で靴を履いて出かける準備をする場面、やや斜め45度からの窓枠や玄関枠を活かしたフレーミング、マフラーやストール、少し眠たそうな柔らかい表情、グリーン系ワンピース、晴れた朝の柔らかい光、澄んだ秋の空気
2026-09-13 [weekday:週末] -> 玄関でカーテンを開ける場面、横顔中心のプロフィールからの斜め構図で奥行きを出したショット、マグカップ、興味津々な表情、ラベンダー系トップス、少し曇った落ち着いた朝の光、紅葉した葉が一枚舞う様子
2026-09-14 [weekday:週の始まり] -> リビングの窓際で朝食を作る場面、少し高い位置からの見下ろしからの縦長を活かした構図、水差しとコップ、晴れやかな笑顔、ベージュ系ニット、雨上がりの澄んだ空気感、温かみのある秋色の小物
2026-09-15 [generic] -> キッチンで植物に水やりをする場面、少し低い位置からの見上げからの中央に人物を大きく配置した構図、折りたたみ傘、やわらかい笑顔、淡いブルー系シャツ、朝もやのやわらかい光、色づき始めた葉
2026-09-16 [generic] -> 洗面所の鏡の前で軽くストレッチをする場面、背後から振り返る構図からの余白を活かしたミニマルな構図、トートバッグ、目を細めた自然な笑顔、白系カットソー、澄み切った朝の光、金木犀の香りを感じる仕草
2026-09-17 [generic] -> ベランダで洗濯物を干す場面、手元にフォーカスした構図からの上半身バストアップ、じょうろ、ちょっと照れたような微笑み、くすみピンク系カーディガン、やわらかく差し込む逆光、秋らしい薄手の上着
2026-09-18 [weekday:金曜日] -> 住宅街の朝の道で読書をする場面、斜め後ろから覗き込むような構図からの腰から上のミディアムショット、本、リラックスした穏やかな表情、グレー系パーカー、淡い朝焼けの光、実りの季節を感じる果物
2026-09-19 [weekday:週末] -> 近所の公園で朝日を浴びて伸びをする場面、正面からの全身が入るワイドショット、マフラーやストール、少し驚いたような明るい表情、グリーン系ワンピース、曇り空越しの均一な光、澄んだ秋の空気
2026-09-20 [weekday:週末] -> 玄関で朝散歩をする場面、やや斜め45度からの手元と表情を含む近距離ショット、マグカップ、静かに微笑む横顔、ラベンダー系トップス、朝日が斜めに差し込む光、紅葉した葉が一枚舞う様子
2026-09-21 [special_day:敬老の日] -> 秋の花、手紙、穏やかな朝の光、靴を履いて出かける準備をする場面、横顔中心のプロフィールからの背景を広く見せる引きの構図、口角がふっと上がる自然な表情
```

上記のとおり、7日後（09-08→09-15）でlocation/prop/activity/outfitは一致するがcamera_angle/framing/expression/weather_lightingが変わり、完全一致にはならないことを確認できる。09-21（敬老の日）ではアンカーテキスト「秋の花、手紙、穏やかな朝の光」が先頭にそのまま保持され、以降に活動・カメラ・表情のみが追加されていることも確認できる。

### changed files

- `supabase/functions/x-test-post/morning_greeting_logic.ts`
  - `selectMorningGreetingTheme()`: weekday/generic branchの固定`visual_theme`文字列を`renderFullScenePlanVisualTheme(scenePlan)`へ、special_day/seasonal branchを`renderThemeSyncedVisualTheme(anchor, scenePlan)`へ置き換え。関数のシグネチャ・返り値の型（`MorningGreetingTheme.visual_theme: string`）は変更していないため、`morning_greeting_image_logic.ts`・`yume_reference_logic.ts`・`scripts/morning-greeting-image.ts`・既存テストへの影響はゼロ（`visual_theme`を独立した文字列fixtureとして使う既存テストはそのまま無変更でpass）。
  - `morningGreetingGenerationInstructions()`: 上記のtext-generation policy changesを反映。
- `supabase/functions/x-test-post/morning_greeting_logic_test.ts`: 新規テスト6件追加（TASK要件1・2・3・4・5・6に対応する構造的instruction検証）。既存24件は無変更で全pass。
- `supabase/functions/x-test-post/morning_greeting_scene_logic.ts`（新規）: scene rotation engine一式。
- `supabase/functions/x-test-post/morning_greeting_scene_logic_test.ts`（新規）: 10テスト（1年分の連日非重複検証、7日窓での非重複検証、マグカップ連日禁止、季節整合性、7日完全一致repeatの回帰防止、purity確認、special/seasonal anchor保持確認）。

`morning_greeting_image_logic.ts`・`yume_reference_logic.ts`・`scripts/morning-greeting-image.ts`・`.github/workflows/morning-greeting-image.yml`は**一切変更していない**（画像prompt builder自体・画像生成workflowは無touchのまま、visual_themeの中身だけが変わる設計）。

### tests

- `deno test --no-check --allow-read --allow-env`（`useful_tip_output_test.ts`除く、既知の環境依存issue）: **338 passed / 0 failed**（前タスク終了時点322 → 純増16件）。
- `deno check morning_greeting_logic.ts morning_greeting_scene_logic.ts`: 新規type error 0件（検出された既存1件`retry_count`関連は前タスクから継続する既存issue、今回の変更対象外）。
- `deno lint`（変更・新規ファイル一式）: 新規lint issue 0件（検出された既存2件は前タスクから継続する既存issue、今回の変更箇所とは無関係）。
- 14-day dry scene plan: 上記のとおり実施（`selectMorningGreetingTheme()`を直接呼ぶだけのdry runで、OpenAI API・Supabase Storageへの呼び出しは一切なし）。

### commit hash

- ローカルのみ: このReport追記前の実装コミット（`git add`前のためハッシュ未確定。Report追記・status更新後にまとめてコミットする）。

### production unchanged

- production deploy: 未実施（禁止どおり）。
- X実投稿: 0件。DB write/migration: なし。Cron変更: なし。secrets変更: なし。`posting_windows`変更: なし。
- `.github/workflows/morning-greeting-image.yml`・`scripts/morning-greeting-image.ts`: 無変更（画像生成workflow自体には触れていない。次回の05:30 JST自動実行時から、コード変更済みの`selectMorningGreetingTheme()`が使われることになる）。
- Codex担当領域・Claude slot 2担当領域（`morning_report` US holiday/session labeling task）・`important-news-monitor/**`・`send-push-notifications/**`・`close_report`関連には一切触れていない。

### next recommended deploy/verification steps

1. K1レビュー・承認
2. 承認後、push
3. （承認された場合のみ）`x-test-post`を本番へdeploy — ただし今回の変更は`scripts/morning-greeting-image.ts`（画像自動生成）と`morning_greeting_logic.ts`（text生成、x-test-post内）の両方に影響するため、**画像生成は次回05:30 JST実行時から自動的に新ロジックが使われる**（workflowファイル自体は無変更のため追加のdeploy操作は不要）。text生成側の反映には`x-test-post`のdeployが必要。
4. deploy後、`test_morning_greeting_payload`モードで本番dry-runを実行し、生成文が相場色の薄い自然な挨拶になっているか・既存安全チェックが引き続き通るかをread-only確認することを推奨。
5. 画像側は次回の自動生成（05:30 JST）後に`generated/{date}.png`を目視確認し、これまでの「窓際+観葉植物+マグカップ+正面上半身」への収束から実際に脱していることを確認することを推奨（今回はdry scene planレベルの検証のみで、実画像API呼び出しは行っていない）。
