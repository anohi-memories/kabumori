# F6 — Opus Primary を朝刊・大引けの両方に広げる（`primary_both`）と、本番ゲート

- 作成: 2026-10-13 JST（F6）
- task_id: `common-ai-f6-opus-primary-both-integration-20261013`
- 範囲: F6 の部品とテストだけ。本番の DB・Edge・Secrets・Cron の変更は 0、実 API の呼び出しも 0
- 積み重ね: main ← #170（F6 部品）← #173（F2 handler）← この PR
- 本番の手順・Cron の時刻・キーの入れ替え・予算表の正本は、F2 の `docs/ai-provider/F2_OPUS_PRIMARY_BOTH_HANDLER.md`。この文書は、F6 の部品の約束と、ゲートの今の状態だけを書く

## 1. 部品の約束（`market_report_primary.ts`）

| `KABUMORI_MARKET_REPORT_AI_MODE` | 朝刊 | 大引け |
|---|---|---|
| 未設定・`off`・`shadow`・その他すべて | OpenAI（今のまま） | OpenAI（今のまま） |
| ちょうど `primary_close` | OpenAI（今のまま） | Claude |
| ちょうど `primary_both` | Claude | Claude |

- 値の比較は完全一致。大文字・前後の空白・`primary-both` などは OFF 扱い
- Claude で作るときの約束は、V0（`F6_OPUS_PRIMARY_CLOSE_V0.md`）と同じ
  - 生成と Fact の両方を Claude で行う。予算台帳を必ず通す
  - 送信は1回で、再試行も OpenAI への自動切り替えも無い
  - 1回 90 秒まで、処理開始から 130 秒以内に始める
  - 設定が欠けていれば fail closed
- 朝刊の再試行（08:05）は claim の試行番号 2 の新しい呼び出しになる（テスト済み）
- 朝刊・大引け以外のレポート種別は、`primary_both` でも OpenAI のまま（読む設定はモードの1つだけ）

## 2. F2 の担当のテストの変更（この PR には入れていない）

- F2 の差分（`F2_PRIMARY_BOTH_F6_HANDOFF.patch`）の3つ目の部分、`market-report-analysis/opus_primary_handler_test.ts` は F2 の担当
- この PR の上では、F2 の handler のテストのうち **2件が失敗する**
  - 「`primary_both` は部品が未対応なので `MODE_UNSUPPORTED` で失敗する」という期待のテスト（close と morning）
  - 部品が対応したので、期待が古くなった
- F2 の差分を手元でだけ当てると、`market-report-analysis` は 322/322 PASS になった（コミットはしていない）
- merge の前に、F2 がこの変更を入れる必要がある（引き継ぎは Report に記載）

## 3. 本番ゲート（すべて別承認。Claude は本番に何もしない）

| # | ゲート | 今の状態（2026-10-13 15:05 JST） |
|---|---|---|
| 1 | L6 でこの PR を評価、F2 が handler のテストの変更を入れる | 未 |
| 2 | #170 → #173 → この PR の順に merge。毎回 `merge-tree` で確かめ、merge 後に main の SHA を読み直す | 未（最新の main との試算は衝突なし） |
| 3 | Edge Secret `ANTHROPIC_API_KEY`（30日の期限付きのキー）と `KABUMORI_MARKET_REPORT_PRIMARY_MODEL=claude-opus-5-5` | **登録されているか分からない**。Claude は確かめない（下の §4） |
| 4 | `market-report-analysis` だけを deploy し、本番のバイト列が main と一致することを読み直す | 未 |
| 5 | モードを設定（大引けだけなら `primary_close`、朝刊からなら `primary_both`） | 未 |
| 6 | 最初の本番の呼び出しを観察（サイクルの結果、`ai_primary` / `primary_calls` / `cost_usd` / `primary_last_error`、台帳の確定額、ログ） | 未 |
| 7 | 止める条件に当たったらモードを外す（OpenAI に戻る） | 手順あり |

- 利用者に届くかは別の話
  - 共通レポートの利用側のゲート（`market_report_consumer_settings`）は、F2 の確認では今朝 OFF だった
  - OFF のままなら、Claude で作ったレポートは保存されるだけで、X・アプリには出ない
  - ON にするのは別の承認

## 4. キーについて

- 利用者の手元の「30日の期限付きキー」が、Supabase の Edge Secret に入っているかは **分からない**
  - Phase 1g の smoke では、キーを手元の `anthropic.env` から使っただけで、Edge Secret には登録していない
- 確かめ方（利用者が実行する。名前と digest だけが出て、値は出ない）

```bash
supabase secrets list --project-ref wsmznyzcvmuitkglfeuj
```

- `ANTHROPIC_API_KEY` が無ければ、**本番の有効化はそこで止める**。登録は利用者が行う。Claude は値を読まない・写さない・表示しない
- 登録したキーの期限の日は利用者が管理する。期限の7日前までに入れ替える（F2 の文書 §5）。期限が切れると、Primary は `AUTH` で失敗する（安全側）
- `ANTHROPIC_CUSTOM_HEADERS` は登録しない（SDK が毎回読む）

## 5. 予算（試験用ポリシーのまま。自動では増やさない）

- 今の上限: 1回 $1、1日 6回・$2、1か月 40回・$5
- `primary_both` は普通の日で4回・約 $0.80。再試行や再生成があると6回で、その日の上限に達する
- 月 $5 なので、毎日続けると **6〜7営業日目（10/21 ごろ）に止まる**（止まり方は安全側で、レポートが失敗するだけ）
- 続けるなら上限の見直しが要る（F2 の文書と同じ提案）
  - 月 $25・120回、1日 $3・8回、1回 $1
  - 1か月の最大の支出は $25 に抑えられる
  - 別の本番変更として、利用者の明示の承認が要る

## 6. 今日（10/13）の大引けについて

- `primary_both`（この PR）は、F2 のテストの変更と merge が要るので、**今日 16:20 には間に合わせない**ことを推奨する。最短で明日 07:55 の朝刊から
- 今日の大引けだけなら、`primary_close` を #170 + #173 だけで使える（この PR は不要）
  - ただし、ゲートの 1〜5（キーの登録を含む）を 16:15 までに終える必要がある
  - キーがあるか分からないので、約束はしない
