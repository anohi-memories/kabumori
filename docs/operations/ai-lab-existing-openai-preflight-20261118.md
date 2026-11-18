# 第51TASK 既存OpenAI投稿経路の非課金preflight（2026-11-18）

task_id: g6-ai-lab-existing-openai-credential-preflight-20261118-01 / 読み取りのみ。有料API 0回・生成 0・実SNS送信 0・鍵の値の読取/表示 0・merge/deploy 0。

## 1 既存の鍵の取得経路（ソース照合）

| 用途 | 環境変数 / secret名 | 読む場所 | 備考 |
| --- | --- | --- | --- |
| 既存の投稿系（useful_tip / 各dry-run / 朝挨拶など） | `OPENAI_API_KEY`（Supabase Edge secret） | `supabase/functions/x-test-post/index.ts:3332`（`Deno.env.get`）。同名を important-news-monitor / personalized-reports / market-report-analysis / market-intelligence-* も読む | サーバー側のみ。値はEdge Functionの実行環境にしか無い |
| 朝挨拶画像 | `OPENAI_API_KEY`（GitHub Actions secret） | `.github/workflows/morning-greeting-image.yml:48` | GitHub secretは読み出せない |
| 共通AI基盤の既定名 | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | `_shared/ai_provider/secrets.ts:12-13` | 既定。AI Labは使わない |
| AI Lab（会社員AIラボ）専用 | OpenAI: `AI_LAB_OPENAI_TEXT_API_KEY` / Claude: `AI_LAB_TEXT_API_KEY` | `_shared/ai_provider/ai_lab_post.ts:24-26`、読替え `:229-233`（共通名の読取を専用名へ付替え、共通名は読まない）。呼出しは `x-test-post/index.ts:4172` の `createAiLabClaudeStages` | テスト `ai_lab_post_test.ts:244-259` が「共有 `OPENAI_API_KEY` を使わない」ことを固定 |

結論: 稼働中の投稿が使う `OPENAI_API_KEY` と、AI Lab比較用 `AI_LAB_OPENAI_TEXT_API_KEY` は**別名**で、AI Lab経路は設計上、共通鍵へフォールバックしない。「今の投稿で使っているから比較runnerでも使える」とはコード上言えない（用途分離が意図的）。

## 2 比較runnerが使える既存ローカル承認経路

- ローカル（このMac）側: 環境変数 `AI_LAB_OPENAI_TEXT_API_KEY` は未設定（第50TASK記録）。リポジトリ内にKeychain読取コードは無い。第50TASKが存在だけ確認したKeychain項目は Anthropic 側（service `anohi-g6-claude-shared` / account `g6`）のみで、OpenAI用に承認された項目名の記録は見つからない。
- サーバーsecret（`OPENAI_API_KEY`）はSupabase secret / GitHub secretで、読み出しも複製も禁止のため、ローカルrunnerへは渡せない。
- 今回は無人実行のため、Keychainへの追加アクセス（対話承認が出うる）は行っていない。
- 判定: **OpenAI鍵のローカル経路は「未確定」**。推測で既存の別名項目を流用しない。

## 3 モデルID・公式料金の照合（2026-11-18、公開ドキュメントの閲覧のみ）

| モデル | 公式（今回確認） | repo `model_catalog.ts` | 差異 |
| --- | --- | --- | --- |
| Claude Opus 5.5 (`claude-opus-5-5`) | 入力 $4 / 出力 $20 per MTok | $4 / $20 | なし |
| Claude Sonnet 5.5 | $2 / $10 | $2 / $10 | なし |
| Claude Haiku 5.5 | $0.10 / $0.50（100K超 $0.50 / $2.50） | 同じ | なし |
| gpt-6.1-sol | $2 / $10（短文脈 272K以下） | $2 / $10（272K超 $4 / $15） | 272K超は今回未確認 |
| gpt-6-luna | $0.10 / $0.50 | $0.10 / $0.50 | なし |

出典: platform.claude.com/docs/en/about-claude/pricing、developers.openai.com/api/docs/pricing。なお公式にはより上位の Claude Fable 5.2 / 5.1 等も載るが、比較対象外で変更しない。
**未確認**: 本人アカウントでの各モデルの利用可否（モデル一覧APIや試験呼び出しは課金/アクセス無許可のため実施せず）。

## 4 当月usage・残高

- 既存許可済みのread-only手段は無い。使用量/費用APIは管理者用キーが必要で、新規発行・Supabase secrets読取は禁止。**今回は確認不能**（数値なし）。
- 本人の最小手順（数値だけ共有すればよい）:
  1. Anthropic: platform.claude.com の Console → Settings → Billing（クレジット残高）と Usage（当月）。必要な数値: クレジット残高(USD)、当月費用(USD)。
  2. OpenAI: platform.openai.com → Settings → Billing（Credit balance）と Usage（当月）。必要な数値: 残高(USD)、当月費用(USD)。
  3. 手元確認が難しければ、くろちゃんが対話で本人の画面を見ながら確認する。管理者キーをMacに置く運用は推奨しない。

## 5 第50TASKの6稿比較に進むための未解決ゲート

1. OpenAI鍵のローカル経路（環境変数名またはKeychain service/account）を本人が明示承認（値は出さない）。
2. 両社の当月残高・使用量の実数値（上記手順）。
3. 課金実行の新しい限定承認（第50TASKの「12回・追加$0.30」承認は第50TASK限定で、今回の根拠にならない。再実行禁止も未解除）。
4. 実行は対話のくろちゃんで、逐次12回以内・$0.30以内・X投稿0。既存キー流用が可能でも1〜3は独立に必要。

## 非機密確認

この資料に鍵の値・個人情報は無い。`git diff --check` と鍵様文字列の検索で確認する。
