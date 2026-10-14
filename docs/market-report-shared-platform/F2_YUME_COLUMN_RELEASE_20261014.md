# 朝刊・大引けの品質改善（ゆめちゃんの市況コラム）— 変更と本番反映の手順

- 作成: 2026-10-14 JST（F2）
- 状態: ソースのみ（Draft PR）。本番の deploy・migration・Secret・Cron・X 投稿・通知・EAS は未実施
- 本番への反映は、下の段階ごとに利用者の承認と実行が必要

## 1. 変えたこと

| 項目 | 内容 | ファイル |
|---|---|---|
| 文体 | ゆめちゃんが読者に語りかけるコラム。事実を根拠にした「私は〜と見ています」の解釈、繰り返し・定型文・AIらしい言い回しの抑制 | `market-report-analysis/analysis_logic.ts` |
| 今日のポイント | 朝刊・大引けの3つの役割を指定どおりに。X とアプリで同じ3つを本文の最初に出す | 同上、`_shared/market_report_packet.ts` |
| ゆめちゃんの考察 | `yume.scenario_ja`（想定シナリオ）を追加。理由を長めに。予想の向きは `yume` だけが持つ（X とアプリで逆にならない） | `analysis_logic.ts`、`unit_sanitizer.ts`、`_shared/market_report_yume.ts` |
| 意見の扱い | 「〜と見ています」「〜と考えています」「私の見立てでは」を、因果のガードと Fact で見立てとして扱う（文を削らない）。事実として断定した理由は従来どおり削る | `analysis_logic.ts` |
| ニュースの選別 | 一般の個別企業の決算・開示をモデルの入力から外す。残すのは半導体・AI の high 以上の個別企業ニュース（最大2件）と、市場全体・業種のニュース。外したものは理由コードつきで記録 | `analysis_input.ts`、`handler.ts` |
| X の並び | 見出し行の直後に「📌 今日のポイント」（朝刊・大引けで同じ見出し）、その後に導入文 | `_shared/market_report_packet.ts` |
| アプリ「きょうの市況」 | 📌 今日のポイント → 🔮 ゆめちゃんの考察・予想 → 📖 今日の相場のお話 → ⚠️ この先の注目材料 → 📊 参考資料｜主な市場指標（いつも最後） | `src/app/market-report.tsx`、`src/lib/market-report-view.ts`、`src/lib/ondemand-analysis-presentation.ts` |
| アプリ用の RPC | `get_app_market_report` が `yume`・`app_story`・`session_views`・`metric_key`・`data_generated_at` も返す（関数の置き換えだけ。表・権限は同じ） | `supabase/migrations/20261014100000_app_market_report_story_v2.sql` |

### ゆめちゃんの欄がアプリに出なかった原因

- アプリは `get_app_market_report` だけで共通の朝刊・大引けを読む
- この関数は返す項目を1つずつ決めて組み立てており、`yume` が入っていなかった
- そのため、10/14 の朝刊の packet に `yume` があっても、「きょうの市況」には届かなかった
- アプリから packet の表は直接読めない（RLS と権限）。直すには関数の置き換え（migration）が要る

### ニュースの除外の記録（PROJECT_RULES「候補選定と除外ログ」）

`report_diagnostics`（`complete_` / `fail_market_report_analysis` の `p_diagnostics`）に次を残す。本文は残さない。

| キー | 例 |
|---|---|
| `news_selection` | `market_wide`（既定）/ `all` |
| `news_excluded` | `27` |
| `news_excluded_reasons` | `COMPANY_NOT_MARKET_WIDE:26,NEWS_TEXT_NOT_FACT_PASSED:1` |
| `news_excluded_refs` | `news:<uuid>=COMPANY_NOT_MARKET_WIDE,...` |

理由コード: `NEWS_TEXT_NOT_FACT_PASSED`（確認済みの日本語本文が無い）/ `COMPANY_NOT_MARKET_WIDE`（一般の個別企業）/ `COMPANY_NEWS_CAP`（半導体・AI の個別企業の3件目以降）/ `NEWS_ITEM_CAP`（15件を超えた分）

## 2. 本番への反映（3つの経路。どれも利用者の承認と実行）

大引けは 16:15 にデータ、16:20 ごろに生成、17:00 に X です。

| 段階 | 何が変わるか | 作業 | 大引けに間に合わせるには |
|---|---|---|---|
| A | 朝刊・大引けの中身（文体・考察・ポイント・ニュース）。X の文とアプリの元データの両方 | PR の merge → `market-report-analysis` の deploy | 16:00 までに deploy と読み戻し |
| B | アプリにゆめちゃんの欄とお話が出る | migration `20261014100000` の適用 ＋ Mac の Metro を新しい main で起動し直す | A の後ならいつでも。B だけ先でも壊れない |
| C | X で 📌 が本文の最初になる | `x-test-post` の deploy | 今日は勧めない（下の注意） |

### A. market-report-analysis の deploy

1. Draft PR を通常の merge（`--match-head-commit <確認済みの HEAD>`）
2. deploy 用の作業場所を merge commit にそろえて、前回（v34）と同じ方法で deploy
   - `supabase functions deploy market-report-analysis --use-api --no-verify-jwt`
3. 読み戻し
   - 関数の版が上がっている（v35 の想定）、`verify_jwt=false`
   - 本番からダウンロードしたファイルが merge commit とバイト単位で一致
   - 合言葉なしの POST が 401（生成は走らない・課金なし）
4. 16:20 以降の読み取り（大引け）
   - cycle が completed、packet に `yume.scenario_ja`、`yume.review`
   - `report_diagnostics.news_selection=market_wide` と `news_excluded*`
   - `fact.ai_status`、`fact.removed_units` に `YUME_` や因果の削除が多すぎないか
- 元に戻す: merge の直前の main から deploy し直す（DB の変更は無い）
- ニュースの選別だけ戻す: Secret `KABUMORI_MARKET_REPORT_NEWS_SELECTION=all`（deploy 不要。Secret の変更は別承認）
- 費用: Opus の出力が1回あたり数百トークン増える見込み（約 $0.01 未満）。上限（月 120回・$25、1日 8回・$3）は変えていない

### B. アプリの表示

1. migration の適用（DB の関数の置き換え。SECURITY DEFINER の読み取り関数）
   - 事前確認: V1 の関数が無いと止まる（`APP_MARKET_REPORT_STORY_V2_PREFLIGHT_V1_MISSING`）
   - 適用後の読み戻し: 関数の定義に `data_generated_at` がある。権限は `authenticated` だけ（anon・service_role は不可）
   - 利用者の権限での確認（rollback する読み取り）: `get_app_market_report('morning')` に `yume` と `app_story` がある
   - 戻し方: `supabase/tests/app_market_report_story_v2_rollback.sql`（V1 の本文に戻す）
   - 方針上、RPC・SECURITY DEFINER の変更は Codex レビューの対象。急ぐ場合はレビューを後に回すかを利用者が決める
2. Mac の Metro（`kabumori-f2-release`）を新しい main で起動し直す。開発用ビルドのままでよい（EAS 不要）
- migration の前に Metro だけ新しくしても壊れない（ゆめちゃんの欄は出ず、お話は要約と確認済みの動きで出る。指標は「主な指標」にまとまる）

### C. X の並び（今日は勧めない）

- X の文を整えるのは `x-test-post` の中の整形。本番は 10/08 の v145 で、main より古い
- deploy すると、10/08 以降の main の変更（免責文など）もまとめて出る。X の実投稿の経路なので、差分の確認とレビューを先にしたい
- deploy しなくても、A だけで X の文体・ポイントの中身・ニュースは変わる（並びは従来どおり「見出し → 導入文 → 📌 今日の注目ポイント／今日の3ポイント」）

## 3. テスト（すべてオフライン。実 API・本番 0）

```sh
# Deno 2.9.6
deno test --no-config --allow-env --allow-read --allow-run=node \
  supabase/functions/market-report-analysis/ supabase/functions/x-test-post/shared_market_report_consumer_test.ts \
  supabase/functions/personalized-reports/
deno test --no-config --no-check --allow-read --allow-env tests/app/
# 手元の使い捨て PostgreSQL 16
AM_PGHOST=/tmp/<sock> AM_PGPORT=<port> AM_PGSUPER=<superuser> bash supabase/tests/app_market_report_story_v2_run.sh
npx tsc --noEmit -p tsconfig.json   # src/ は既知の CSS 型の2件だけ
```

## 4. 今回やっていないこと

- `buildAppMarketStory`（個別レポートの `market_detail.story`）の並びは変えていない。アプリはこの story をまだ描いていない
- X の旧経路（個別生成）のプロンプト・見出しは変えていない（共通の経路が ON のため使われない）
- ホーム画面の改修
