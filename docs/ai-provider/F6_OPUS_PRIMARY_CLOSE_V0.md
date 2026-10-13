# F6 V0 — 大引けの共有市況レポートを Claude Opus 5.5 で本番生成する（既定 OFF）

- 作成: 2026-10-13 JST（F6）
- task_id: `common-ai-f6-opus-primary-close-report-v0-20261013`
- 範囲: ソースとオフラインテストだけ。本番 DB・Edge・Secrets・Cron の変更は 0、実 API の呼び出しも 0
- 比較用の shadow（PR #148〜#162）には頼らない。最新の main から作った、独立した変更

## 1. 何をするか

設定 `KABUMORI_MARKET_REPORT_AI_MODE` の値で動きを決める。

| 値とレポート | 動作 |
|---|---|
| 未設定・`off`・`shadow`・その他すべて | 今の OpenAI のまま（何も変わらない）。読む設定はこの1つだけ |
| ちょうど `primary_close`、かつ **朝刊** | 今の OpenAI のまま |
| ちょうど `primary_close`、かつ **大引け** | 生成と Fact 確認の **両方を Claude** で行う。モデルは `KABUMORI_MARKET_REPORT_PRIMARY_MODEL`（カタログ上の Anthropic モデル。`claude-opus-5-5` を想定） |

Claude で行うときの約束:

- 指示文・入力・JSON スキーマ・出力上限・effort は、OpenAI に送っていたものと同じ。保存されるレポートの形式（`market_report_packet.v1`）、ローカルの検査、Fact の扱い、配信は変わらない
- 1回の呼び出しは予算台帳を必ず通す（reserve → mark_sent → settle）。主体は system、`kabumori` / `market_report`
- 送信は1回だけ。再試行も、OpenAI への自動切り替え（fallback）も無い
- 失敗したら、そのサイクルを失敗にする（`ANALYSIS_PRIMARY_<STEP>_FAILED:<コード>`）。次の Cron（16:35 の再試行）が、claim の試行番号 2 でもう一度 Claude で作る
- 値が `primary_close` なのに設定が欠けているとき（モデル・キー・台帳・claim）は、OpenAI に黙って戻さない。`ANALYSIS_PRIMARY_CONFIG:<理由>` で失敗にする
- 時間
  - 1回の上限は 90 秒（OpenAI と同じ）
  - すべての呼び出しは、処理開始から 130 秒以内に始める（Free plan の wall clock 150 秒のうち、残りを DB の書き込みに残す）
  - 残りが 6 秒未満なら送らない
- Fact 確認の呼び出しが失敗した場合は、今の約束どおり「Fact 未実施」で配信する（OpenAI でも同じ）
- 呼び出し ID は `mrp:<cycle>:a<claim の試行番号>:<step>:<何回目か>`。同じ試行の二重実行は、台帳が拒否する（二重課金しない）
- shadow と同じ設定変数を使うので、shadow と primary が同じ試行で同時に動くことは無い

## 2. ファイル

### F6 の PR（この branch）

| ファイル | 内容 |
|---|---|
| `supabase/functions/_shared/ai_provider/market_report_primary.ts` | `prepareMarketReportPrimary`（legacy / invalid / primary の判定と、Claude の requester） |
| `supabase/functions/_shared/ai_provider/market_report_primary_test.ts` | 本物の `generateSharedAnalysis` と大引けの fixture を使ったオフライン E2E（9件） |
| `docs/ai-provider/F6_OPUS_PRIMARY_HANDLER_V0.patch` | handler への配線の差分（**適用していない**。下記） |
| この文書 | |

### handler への配線（F2 所有のファイルを含むので、パッチとして渡す）

`F6_OPUS_PRIMARY_HANDLER_V0.patch`（3ファイル、+418 / -25）。オフラインで適用して検証済み。

| ファイル | 担当 | 変更 |
|---|---|---|
| `market-report-analysis/handler.ts` | F2（旧 G2） | `prepareMarketReportPrimary` を呼ぶ。primary のとき、保存するモデル名（`p_model`、packet の `model`、trace）を Claude にする。費用（`cost_usd`、`p_api_cost_usd`）は台帳で確定した額にし、`ai_primary` と `primary_calls` を diagnostics に足す。設定不足は fail closed。呼び出しごとに1行のログ（識別子と数値だけ） |
| `market-report-analysis/opus_primary_handler_test.ts` | F2（新規） | 本物の `handleRequest` を通した E2E（5件） |
| `_shared/ai_provider/isolation_test.ts` | F6 | 許可リスト方式。provider を参照してよいのは `handler.ts` → `market_report_primary.ts` の1つだけ。deploy 対象で provider に届くのは `handler.ts` と `index.ts` だけ |

`handler.ts` を変えるには、F2 の担当との調整の確認が必要。確認が取れたら、F2 が当てるか、F6 に当てる許可を出す。3ファイルは **同時に** 入れる（隔離テストは、handler が import した瞬間に古い規則のままだと落ちる）。

### shadow の積み重ね（#148〜#162）との関係

- 独立しているので、どちらが先に merge されてもよい
- 後から入る側で、次の2ファイルの調整が要る
  - `handler.ts`: #153 も変更している
  - `isolation_test.ts`: #157 も変更している。許可リストを足し合わせる（F6 の作業）

## 3. 予算（試験用ポリシーのまま。自動では増やさない）

今のポリシー（system・`claude-opus-5-5`・kabumori・market_report）: 1回 $1、1日 6回・$2、1か月 40回・$5。

1回の上限見積もり（予約額）は、generate 約 $0.45、Fact 約 $0.16。

| 状況 | 呼び出し | 費用の目安 |
|---|---|---|
| 普通の日（生成 → Fact 合格） | 2回 | 約 $0.40 |
| 再生成した日 | 4回 | 約 $0.80 |
| 16:20 が失敗し、16:35 で再生成した場合 | 最大 6回 | 1日の上限で止まる |

- 1日の上限（6回・$2）を越える呼び出しは、送る前に拒否され、そのレポートは失敗する（安全側）
- 10月の残りの営業日（10/13〜10/30 の14日）に毎日続けると、約 $5.6 になる。月 $5 の上限で、10月の下旬に止まる
- **毎日の大引けを Opus で続けるなら**、月の上限の見直しが要る（22営業日 × $0.40〜0.80 ＋ 再試行）
  - 提案: 月 $20・100回。1日（$2・6回）と1回（$1）はそのまま
  - 別の本番変更として、明示の承認を取る

## 4. 本番で有効にする手順（どれも別承認。この作業では何もしていない）

| # | 作業 | 実行者 | 注意 |
|---|---|---|---|
| 0 | `handler.ts` の配線の承認（F2 との調整） | ChatGPT / 利用者 | パッチの3ファイルを同時に |
| 1 | F6 の PR と配線の PR を main に merge | 承認者 | merge の直前に `merge-tree` で確かめる |
| 2 | Edge Secret を登録: `ANTHROPIC_API_KEY`（専用 workspace のキー、spend limit 付き）と `KABUMORI_MARKET_REPORT_PRIMARY_MODEL=claude-opus-5-5`。**モードはまだ入れない** | 利用者（Claude はキーを読まない・写さない） | `ANTHROPIC_CUSTOM_HEADERS` は入れない。`secrets set` で全関数の version が上がる（コードは変わらない） |
| 3 | `market-report-analysis` だけを main から deploy | 利用者 / 承認されたスロット | worktree からの deploy は config の位置に注意。deploy 後にバイト列で確かめる |
| 4 | モードは未設定のまま、今までどおり動くことを確かめる（台帳の行が増えない） | 利用者 | 時間が無ければ省いてもよいが、そのリスクを承知のうえで |
| 5 | 16:15 までに `KABUMORI_MARKET_REPORT_AI_MODE=primary_close` を設定する | 利用者 | 朝刊（翌 07:55）は、この値でも OpenAI のまま |
| 6 | 16:20 と 16:35 を観察する | 利用者 / 読み取りのみ | ログの `market_report_primary` の行、サイクルの結果、台帳の確定額 |
| 7 | 終わったら `primary_close` を外す（続けるなら別承認） | 利用者 | |

### 回復処理の Cron の代わり（V0 で上限を守る方法）

- primary は、自分の呼び出しを自分で確定する
- 確定されずに残るのは、worker が呼び出しの途中で止められた場合だけ。そのときも、予約は上限額のまま日・月の上限に数えられる。上限を越えて使うことは無く、残りの枠が減るだけ（安全側）
- その日の後で、利用者が `select public.ai_ledger_recover_stale('{}'::jsonb)` を1回実行すれば片付く
- 毎日続ける前には、回復処理の Cron を別承認で設定する

### 止める条件と戻し方

- 戻し方
  - `KABUMORI_MARKET_REPORT_AI_MODE` を外す（または `off`）。次の呼び出しから OpenAI に戻る
  - 台帳の `stop` は、primary が ON のままだとレポートを失敗させるので、**戻す手段としては使わない**
- 止める条件（1つでも当てはまったら、すぐモードを外す）
  1. ログ・記録にキー・プロンプト・本文が出た（このときはキーも作り直す）
  2. 1回の確定額が $0.60 を超えた、または1日の合計が $1.50 を超えた
  3. `GUARD_UNAVAILABLE`（台帳に届かない）が出た
  4. 16:20 と 16:35 の両方が失敗した（その日は大引けが出ない。利用者は了承済み）

## 5. まだ分からないこと（オフラインでは確かめられない）

- **Opus の応答時間。** 大引けの入力（約 2 万トークン）で、生成が 90 秒を超えると `TIMEOUT` で失敗する（上限額で確定する）。生成と Fact の合計が 130 秒の枠に収まるかも分からない
- 本番の Supabase の plan（wall clock が 150 秒か 400 秒か）
- Anthropic が、このスキーマの strict な structured output を実際に受け付けるか
  - オフラインの変換の検査は PASS している
  - 本物の API では、Phase 1g の小さな smoke しか通していない

## 6. テスト（すべてオフライン。実 API・本番 0）

```sh
deno test --no-config --allow-env --allow-read supabase/functions/_shared/ai_provider/market_report_primary_test.ts
```

- この branch: E2E 9件（大引け 9/30・9/17 で、OpenAI の経路と同じ packet と hash になることなど）
- パッチを当てた状態: handler の E2E 5件、隔離テスト 8件、各スイートの回帰
- 通信禁止（`--deny-net`）と鍵の環境変数の読み取り禁止でも PASS
