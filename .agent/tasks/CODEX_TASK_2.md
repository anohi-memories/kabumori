# Codex Task 2

- task_id: morning-greeting-soft-daily-copy-20260909
- owner: codex
- slot: codex-2
- status: ready
- next_owner: codex
- priority: high
- purpose: 朝の挨拶投稿の文章が朝刊・相場解説のように固くなっているため、morning_greetingの文章だけを「日常の軽い朝挨拶」へ寄せ、ユーザーが以前指定した固定ハッシュタグを必ず付ける。画像生成・画像品質・投稿経路は変更しない。

## User feedback / incident

2026-09-09の自然投稿は画像は良好だったが、本文が朝から固すぎた。また、以前ユーザーが指定した朝挨拶用ハッシュタグが投稿に入っていなかった。

実例:
- `朝の値動きは、数字だけ追うと情報が多く見えますが、決算やニュースと照らすと少し整理しやすいです。`
- `急いで答えを出さず、今日もひとつずつ見ていけたら。`

このような相場解説・指導口調はmorning_greetingには不要。

ユーザーが望む方向感の例:
`おはようございます☀️\n朝の空気が少し気持ちいいですね😊\n今日も無理せず、ぼちぼちいきましょう。\n良い1日になりますように☕️`

※上記例を毎日固定で出すのではなく、自然な日常挨拶のトーン例として使う。

固定ハッシュタグは以下を必須とする:
`#おはよう #日本株 #日経平均 #かぶモリ #ブルバ100`

## Required investigation

1. `morning_greeting_logic.ts` の現在の共通KABUMORI_VOICE継承と専用instructionが、なぜ相場解説・先生口調を誘発するか確認する。
2. morning_greeting専用で、他投稿タイプの品質ルールを壊さずに文章だけ柔らかくできる最小変更箇所を特定する。
3. 現在の100〜300文字validator、120〜200文字target、length retryが今回の「固さ」にどう影響しているか確認する。
4. 現在の「ハッシュタグ禁止」guardがmorning_greetingにも適用されている箇所を特定し、他投稿タイプへ影響を広げずmorning_greetingだけ固定5タグを許可・必須化する。
5. 既存の安全ガード（架空体験、未確認天気、売買助言、未確認記念日、URL禁止等）は維持する。

## Required implementation

### 1. 朝挨拶を日常投稿へ寄せる

morning_greeting専用prompt/instructionを次の方向へ変更する。

- 株の解説は原則入れない。
- 朝刊のような相場解説、決算・ニュース整理、投資の考え方の説明をしない。
- 読者を指導する文章にしない。
- `整理しやすいです`、`ひとつずつ見ていけたら`、`確認していきましょう`、`焦らず見ていきましょう` 等の先生・解説者口調を避ける。
- 「おはようございます」＋軽い日常の一言＋柔らかい締め、を基本にする。
- 毎回同じ構成・定型文に固定しない。
- その日の確定テーマ（special_day / seasonal / weekday / generic）がある場合は短く自然に触れるだけでよい。豆知識や解説へ広げない。
- 天気・外出・食事・家族行事など、入力にない本人の現実を作らない。

### 2. 文字数を朝挨拶向けに軽くする

本文部分の目安を **60〜140文字程度** に変更する方向で実装する。

- 固定ハッシュタグ行は本文文字数とは分けて扱ってよい。
- validatorも、自然な60〜140文字程度の本文 + 固定ハッシュタグが正常に通るように調整する。
- generation targetはvalidator範囲の内側に十分余裕を持たせる。
- length retryは既存の「最大1回のみ」を維持する。
- 文字数を埋めるために株解説・一般論・助言を足さない。
- 短く自然に成立している文章を不必要に長文化しない。

具体的な最終min/maxは、既存テストと生成安定性を見て安全側で決めてよいが、今回の目的は「100文字以上を埋めるための相場解説」を不要にすること。

### 3. 固定ハッシュタグを必ず付ける

morning_greeting投稿の末尾に、以下5タグを必ず付ける。

`#おはよう #日本株 #日経平均 #かぶモリ #ブルバ100`

要件:
- 5タグすべて必須。
- 重複させない。
- 表記を勝手に変更しない。
- 原則として本文の後に改行して1行で付与する。
- LLM任せで欠落させない。可能なら生成後の決定論的付与を優先する。
- morning_greeting以外の投稿タイプのハッシュタグルールを変更しない。
- URLは禁止のまま維持する。

### 4. 絵文字

- 本文中1〜3個程度を目安。
- 朝の柔らかさに合う範囲で自然に使う。
- 個数合わせのための装飾はしない。

### 5. 画像は一切変更しない

2026-09-09の画像品質はユーザー評価が良好。

変更禁止:
- `morning_greeting_image_logic.ts`
- `yume_reference_logic.ts`
- canonical reference
- 画像prompt
- 画像model / quality / size
- Storage画像生成経路
- 画像テーマ選択ロジック（文章と共有する既存theme selection自体の必要最小限参照を除く）

### 6. 投稿・OAuth・Storage receiptの失敗処理は今回触らない

2026-09-09にはX投稿成功後のlegacy Storage receipt保存がHTTP 400となり、scheduled_postsだけfailed扱いになる別問題が確認されている。

このTASKは文章の柔らかさ + 固定ハッシュタグだけを対象とし、以下は変更しない:
- `morning_greeting_publish_logic.ts`
- publish_claims
- OAuth / token refresh
- X media upload
- X POST
- published receipt
- `scheduled_posts`
- Cron / scheduler

この別問題をついでに直さない。

## Tests

最低限:
1. 60〜140文字程度の自然な朝挨拶本文がacceptされる。
2. `おはようございます`を含む短い日常挨拶が、旧100文字下限だけを理由にrejectされない。
3. `朝の値動きは〜決算やニュースと照らすと〜` のような相場解説寄り文を生成instruction上で明確に抑制できる。
4. `急いで答えを出さず〜ひとつずつ見ていけたら` のような指導口調を抑制する。
5. special_day / seasonal themeは短く自然に触れられ、別記念日の捏造は引き続きreject。
6. 未確認天気、架空体験、売買助言、URL禁止など既存guardが維持される。
7. morning_greetingの最終本文に `#おはよう #日本株 #日経平均 #かぶモリ #ブルバ100` が必ず1回ずつ入る。
8. 固定5タグのうち1つでも欠ける状態を最終出力として通さない、または決定論的付与で必ず補完する。
9. morning_greeting以外の投稿タイプの既存ハッシュタグ禁止/制御を壊さない。
10. length retryは最大1回のまま。
11. morning_greeting relevant tests pass。
12. full x-test-post regression pass。

## Scope / conflicts

主対象:
- `supabase/functions/x-test-post/morning_greeting_logic.ts`
- 関連するmorning_greeting tests

必要なら最小限:
- morning_greeting専用のtest helper
- morning_greeting最終テキスト整形箇所（固定タグの決定論的付与に必要な場合のみ）

触らない:
- `morning_greeting_image_logic.ts`
- `yume_reference_logic.ts`
- `morning_greeting_publish_logic.ts`（固定タグ付与に不要なら触らない。X送信/OAuth/receiptロジック変更は禁止）
- morning_report
- close_report
- important-news-monitor
- DB migration/schema/GRANT
- Cron / scheduler
- posting_windows
- secrets
- 他Edge Function

開始時・push前にorigin/mainをfresh-checkする。
同じ`x-test-post` Edge Functionまたは同じ対象ファイルを他slotが変更中なら、同時編集・同時pushせず競合を報告して停止する。

## Production policy

このTASKは **調査 + local実装 + tests + commit/pushまで**。

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
- `.agent/CODEX_REPORT_2.md` を最新結果で置き換える
- root cause
- 変更した文体ルール
- final length target / validator range
- 固定5タグの付与方法と欠落防止方法
- changed files
- relevant/full test結果
- commit hash
- push結果
- production変更なし
- remaining issues
- next recommendation
