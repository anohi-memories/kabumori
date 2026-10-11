# 共通AI基盤 Phase 1d — 本番適用ゲートと Claude API 接続テストの実行手順書

- 作成: 2026-10-11 JST（共通AI基盤担当くろちゃん）
- task_id: `common-ai-provider-phase1d-activation-readiness-20261011`
- 基準: `origin/main` `704c08b8`
- 今回は準備のみ。本番DB変更・migration 適用・Secrets・実 Claude API・deploy・モデル切替・merge はしていない
- **本書の書き込み手順は、ChatGPT の判断とユーザーの承認を得てから、ユーザーが自分の端末で実行する**
- Phase 1c の調査結果: `docs/ai-provider/PHASE1C_PRODUCTION_READINESS.md`

## 0. 前提（2026-10-11 時点）

| 項目 | 状態 |
|---|---|
| 本番 Supabase（ChatGPT が独立に確認） | PostgreSQL 17、`ai_ledger` schema なし、`budget_policies` なし、`public.ai_ledger_*` 0件、`20261010050613` 未適用 |
| Claude API | クレジットと API の利用実績はユーザー確認済み。クレジット取得や基本の利用登録は繰り返さない |
| 共通 Provider の利用箇所 | 0（どの Edge Function も import していない） |
| 本番作業の窓 | G1〜G5・H1/H2 とも ACTIVE なし（10/11 確認） |
| migration の固定 | `20261010050613_ai_provider_budget_ledger.sql` の sha256 `680aeb3f2e540b184476b0c1e3534d8586b4857ec29856e40793ed44eff35737`（PR #119 の head `8ef3843f` を main にマージしたもの）。runner はこれ以外のバイト列を拒否する |

## 1. 全体の流れ

| # | 内容 | 本番への影響 | 費用 | 実行者 |
|---|---|---|---|---|
| 1 | Console: 専用 workspace・利用上限・キー | なし（Anthropic 側の設定） | $0 | ユーザー |
| 2 | キーを 600 権限のファイルへ | なし | $0 | ユーザー |
| 3 | smoke の `plan`（通信なし） | なし | $0 | ユーザー |
| 4 | runner `check`（読み取りのみ） | なし | $0 | ユーザー |
| 5 | runner `apply`（台帳の作成。窓を開けて行う） | **書き込み** | $0 | ユーザー（承認後） |
| 6 | runner `policies`（試験用ポリシー2件） | **書き込み** | $0 | ユーザー（承認後） |
| 7 | smoke の `live`（Claude Opus 5.5 を1回） | 台帳に1行（`--ledger=supabase` の場合） | **≦ $0.040**（上限見積もり。実費はさらに小さい想定） | ユーザー（承認後） |
| 8 | Supabase に `ANTHROPIC_API_KEY` を登録 | Secret 追加（読む関数は 0） | $0 | ユーザー（Phase 2a の直前） |
| 9 | 回復処理の Cron | **書き込み** | $0 | 別ゲート（Phase 2a で本番を動かす前） |

順番の要点:

- 1〜4 は本番を変えないので、いつ行ってもよい
- 5・6 は G5 の窓と重ならない時間に、続けて行う
- 7 は、5・6 の後なら台帳ごと照合できる。5・6 の前なら `--ledger=memory` で Claude 側だけを照合する

## 2. 手順の詳細

コマンドは、この PR の branch をチェックアウトしたリポジトリのルートで実行する（runner は相対パスで SQL を読む）。

### 手順1　Console: 専用 workspace・利用上限・キー（ユーザー）

1. Settings > Workspaces で専用 workspace を作る（例: `kabumori-production`）
   - すでにあればそれを使う
   - **Default Workspace は利用上限を設定できない**ため、使わない
2. その workspace の Spend limits を設定する
   - 試験中は月 **$10**。通知は 50%・80%
   - 台帳の上限（月 $5）より少し上にして、台帳が働かなかった場合の歯止めにする
3. その workspace に限定したキーを作る
   - service account のキーが選べれば、それを使う（作成者が組織から外れても止まらない）
   - 名前の例: `kabumori-supabase-prod-20261012`
   - **Admin キーは使わない**（コードが拒否する）
4. 表示されたキーは、チャット・ChatGPT・Git・メモに貼らない。手順2へ進む

### 手順2　キーを 600 権限のファイルへ（ユーザー）

キーをクリップボードにコピーした状態で、次を順に実行する。

```bash
umask 077 && mkdir -p ~/.kabumori-secrets
```

```bash
printf 'ANTHROPIC_API_KEY=%s\n' "$(pbpaste)" > ~/.kabumori-secrets/anthropic.env
```

```bash
pbcopy < /dev/null
```

- このファイルは `ANTHROPIC_API_KEY` の1行だけにする。手順7と手順8で同じファイルを使う
- 手順7を `--ledger=supabase` で行う場合だけ、台帳用のファイルも作る
  - **一時的な Supabase の secret キーを新しく作り、テスト後に削除する方式を推奨**（Dashboard > Settings > API Keys）
  - これは Supabase の設定変更にあたるため、承認の対象に含める
  - 既存の service_role キーは使わない

```bash
printf 'SUPABASE_URL=https://wsmznyzcvmuitkglfeuj.supabase.co\nAI_LEDGER_SERVICE_KEY=%s\n' "$(pbpaste)" > ~/.kabumori-secrets/ledger.env
```

### 手順3　smoke の plan（通信なし・無料）

```bash
env -i PATH="$PATH" HOME="$HOME" deno run --no-config --no-prompt --allow-env=ANTHROPIC_API_KEY,ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_LOG,SUPABASE_URL,AI_LEDGER_SERVICE_KEY --env-file=$HOME/.kabumori-secrets/anthropic.env supabase/tests/ai_provider_claude_smoke.ts --mode=plan
```

- `VERDICT: PASS` と `upper_bound_usd=0.040164` を確認する
- `--allow-net` を付けていないので、通信はできない
- `env -i` で、端末の他の環境変数（`ANTHROPIC_BASE_URL` など）を持ち込まないようにしている

### 手順4　runner の check（読み取りのみ）

```bash
AIL_ROLLOUT_REF=wsmznyzcvmuitkglfeuj bash supabase/tests/ai_provider_budget_ledger_rollout.sh check
```

- 最後の行が `DONE check: READY_TO_APPLY` であることを確認する
- 出力（カタログの事実と件数だけ）は `~/.kabumori-ai-ledger-rollout/<日時>-check/` に残る
- 共有するのは、`VERDICT` の行と `predicted_refusal` の4行で足りる

### 手順5　runner の apply（書き込み。承認後）

開始前に次を確認する。

- fresh `origin/main` の全 TASK ヘッダーに `production_mutation_window: ACTIVE` が無いこと
- 特に G5 に作業中の窓が無いこと
- ChatGPT が CURRENT_STATE に、この窓（対象: `ai_ledger` schema と `public.ai_ledger_*` だけ）を記録したこと

```bash
AIL_ROLLOUT_REF=wsmznyzcvmuitkglfeuj AIL_ROLLOUT_ACK="apply 20261010050613_ai_provider_budget_ledger to wsmznyzcvmuitkglfeuj" bash supabase/tests/ai_provider_budget_ledger_rollout.sh apply
```

runner の中で、次の順に進む。どこかで期待と違えば、その場で STOP する（再試行・補修はしない）。

1. Stage 0: 事前チェック（`READY_TO_APPLY` 必須）と、既存業務の指紋（適用前）
2. Stage A: migration を1回だけ実行（sha256 一致が必須）
3. Stage B: 読み戻し（履歴を書く前に、台帳の形と権限を確認）
4. Stage C: 履歴の行（`20261010050613 / ai_provider_budget_ledger`）
5. Stage D: もう一度読み戻し（履歴 1行）と、既存業務の指紋（適用後）の比較
   - public・private の既存オブジェクト、ロール、所属、既定権限、イベントトリガーがすべて同じ
   - 増えた関数が、ちょうど RPC 7件であること

最後の行が `DONE apply: ... existing objects unchanged (+7 RPCs)` なら完了。窓を CLOSED にして、G5 に共有する（§5）。

### 手順6　runner の policies（書き込み。承認後）

```bash
AIL_ROLLOUT_REF=wsmznyzcvmuitkglfeuj AIL_ROLLOUT_ACK="insert phase1d test policies into wsmznyzcvmuitkglfeuj" bash supabase/tests/ai_provider_budget_ledger_rollout.sh policies
```

登録されるのは次の2件だけ（`supabase/tests/ai_provider_budget_ledger_initial_policies.sql`）。

| policy_key | 範囲 | 期間 | 上限 |
|---|---|---|---|
| `anthropic.opus.kabumori.market_report.monthly` | anthropic / claude-opus-5-5 / kabumori / market_report / system | JST 月 | $5.00・40回・1回 $1.00 |
| `anthropic.opus.kabumori.market_report.daily` | 同上 | JST 日 | $2.00・6回・1回 $1.00 |

- SQL 側でも、既存の行があれば拒否し、登録後の値をトランザクション内で確認してから COMMIT する
- runner は読み戻しで、2件が完全一致することを確認する

### 手順7　smoke の live（Claude を1回。承認後）

推奨は `--ledger=supabase`。1回の呼び出しで、次をまとめて確認できる。

- キー・workspace・モデル
- 構造化出力
- 費用の計算
- 本番 PostgREST 経由の台帳 RPC（reserve → mark_sent → settle）と、台帳の集計

```bash
env -i PATH="$PATH" HOME="$HOME" deno run --no-config --no-prompt --allow-env=ANTHROPIC_API_KEY,ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_LOG,SUPABASE_URL,AI_LEDGER_SERVICE_KEY --allow-net=api.anthropic.com,wsmznyzcvmuitkglfeuj.supabase.co --env-file=$HOME/.kabumori-secrets/anthropic.env --env-file=$HOME/.kabumori-secrets/ledger.env supabase/tests/ai_provider_claude_smoke.ts --mode=live --ledger=supabase --confirm=ONE_PAID_CALL
```

台帳を使わない場合（手順5・6の前、または一時キーを作らない場合）:

```bash
env -i PATH="$PATH" HOME="$HOME" deno run --no-config --no-prompt --allow-env=ANTHROPIC_API_KEY,ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_LOG,SUPABASE_URL,AI_LEDGER_SERVICE_KEY --allow-net=api.anthropic.com --env-file=$HOME/.kabumori-secrets/anthropic.env supabase/tests/ai_provider_claude_smoke.ts --mode=live --ledger=memory --confirm=ONE_PAID_CALL
```

smoke の仕様:

- 送る内容は固定の合成文だけ（「status を ok に、sum を 1+1 に」）。入力を受け付けないので、個人情報は入りようがない
- 呼び出しの名目は、許可リストの範囲（kabumori / market_report / system / Opus 5.5）。logical_role は `kabumori.market_report.connection_smoke` で、台帳では区別できる
- 送信は1回だけ（transport 1回、再試行なし、Fallback なし）。上限見積もり $0.040164（$0.05 を超える設定なら送信前に拒否）
- 照合する項目
  - Anthropic への送信がちょうど1回
  - 成功と、`claude-opus-5-5` からの応答
  - Anthropic の生の usage と、Provider の usage の一致
  - 料金表から独立に再計算した費用と、Provider の推定費用の一致
  - 費用 ≦ 上限見積もり
  - （台帳モードのみ）台帳の集計の増分が、試行1・成功1・トークン一致・費用一致であること
- 表示する識別子: `request-id`、`anthropic-workspace-id`、`anthropic-organization-id`。手順1の workspace で動いたかを、ここで確認する
- `call` 行の `payload_matches_expected` は、モデルの答えが `{"status":"ok","sum":2}` だったかの参考情報で、合否には使わない
- 市況レポート・モデル登録表・配信のコードは一切読み込まない（テストで検査済み）。エラーでも既存の配信は何も変わらない

終了コード:

| コード | 意味 |
|---|---|
| 0 | PASS |
| 1 | FAIL（送信したが、照合のどれかが一致しない、または Anthropic がエラーを返した） |
| 2 | REFUSED（送信前に拒否: 環境変数・キー・確認フレーズ・上限・台帳の拒否） |
| 3 | 引数の誤り |

終わったら:

- Console の Cost / Logs で同じ `request-id` の費用を確認し、smoke の `estimated_cost_usd` と比べる
- 一時的な Supabase の secret キーを削除し、`ledger.env` も削除する

### 手順8　ANTHROPIC_API_KEY の登録（Phase 2a の直前）

```bash
supabase secrets set --project-ref wsmznyzcvmuitkglfeuj --env-file ~/.kabumori-secrets/anthropic.env
```

```bash
supabase secrets list --project-ref wsmznyzcvmuitkglfeuj
```

- 名前と sha256 だけが表示される
- `ANTHROPIC_API_KEY` があること、ほかの `ANTHROPIC_*`（特に `ANTHROPIC_CUSTOM_HEADERS`）が無いことを確認する
  - SDK はキーを明示しても `ANTHROPIC_CUSTOM_HEADERS` を毎回読む
- `secrets set` を実行すると、全関数の version が上がる。コードの差し替えではない
- 今は、このキーを読む関数は無い
- 登録後、`anthropic.env` を削除する

### 手順9　回復処理の Cron（別ゲート）

pg_cron で `select public.ai_ledger_recover_stale('{}'::jsonb)` を数分ごとに実行する。

- 所有者権限で動くので、HTTP もキーも不要
- 応答が失われた予約を、上限額の unknown として確定させる
- Phase 2a で市況レポートを本番の台帳経由で動かす前に、別の承認で設定する
- smoke だけなら不要（smoke は自分で settle する）

## 3. 中断・障害時の対応

### 3.1 runner の STOP

| 表示 | 状態 | 対応 |
|---|---|---|
| `REFUSED`（2） | 何もしていない | 表示された理由（確認フレーズ、ref、migration のバイト列）を直す |
| `STOP[10]` | 事前条件が不成立。何も書いていない | `check` の `VERDICT` と理由を ChatGPT に共有する。補修の GRANT / REVOKE はしない |
| `STOP[11]` | Stage A が失敗し、台帳が無いことを確認済み（何も変わっていない） | `stage_a.err` を確認する。原因が分かるまで再実行しない |
| `STOP[12]` | Stage A の結果が不明（エラーなのに台帳がある、など） | **再実行しない**。`status` で状態を見る。読み戻しが PASS し履歴だけ無いなら `apply --resume-history` |
| `STOP[13]` | 台帳はあるが、読み戻しが期待と違う | 書き込みを止めて共有する。rollback は台帳が空のときだけ（§4） |
| `STOP[14]` | 台帳は検証済みで、履歴の行だけ失敗 | `apply --resume-history`（同じ確認フレーズ） |
| `STOP[15]` | 適用後の確認が不一致（既存業務の指紋の差分など） | 差分の分類を共有する。同時に別の作業が本番を変えた可能性がある（G5 など）。台帳を消す前に原因を確認する |
| `STOP[16]` | 出力を読めない（CLI の障害など） | 何も推測しない。`status` をやり直す |

### 3.2 Claude の呼び出し（smoke・Phase 2a）

| 状況 | 対応 |
|---|---|
| 401 認証エラー | キーの貼り間違い・無効化・別 workspace。キーを作り直す。再試行で直るものではない |
| 400「workspace の利用上限に達した」/ 429 `enforced_spend_limit_reached` | 上限で止まっている（Provider は再試行しない）。上限値の見直しは承認事項 |
| 400「Your credit balance is too low」/ 402 | クレジット切れ。購入・自動チャージは承認事項。市況レポートは Sol（OpenAI）のまま |
| 429 rate limit / 529 overloaded / 504 | 一時的なもの。smoke は1回で止まるので、時間を置き、**新しい callId で1回だけ**やり直す |
| 費用が想定より大きい | `stop` で全ポリシーを無効化 → Console でキーを無効化 → 原因を調べる |
| キーが漏れた疑い | Console でキーを即時に無効化 → `supabase secrets unset ANTHROPIC_API_KEY` → 新しいキーを作る |

### 3.3 緊急停止（すべての Claude 呼び出しを、送信前に止める）

```bash
AIL_ROLLOUT_REF=wsmznyzcvmuitkglfeuj AIL_ROLLOUT_ACK="disable all ai_ledger policies in wsmznyzcvmuitkglfeuj" bash supabase/tests/ai_provider_budget_ledger_rollout.sh stop
```

- 全ポリシーを `enabled = false` にする
- 以後の予約はすべて `NO_MATCHING_POLICY` で拒否され、Anthropic には何も送られない（ローカルで確認済み）
- 再開は、ポリシーを `enabled = true` に戻す運用 SQL で行う（承認事項）
- より強い停止は、Console でのキーの無効化

## 4. rollback

```bash
AIL_ROLLOUT_REF=wsmznyzcvmuitkglfeuj AIL_ROLLOUT_ACK="drop the empty ai_ledger in wsmznyzcvmuitkglfeuj" bash supabase/tests/ai_provider_budget_ledger_rollout.sh rollback
```

- **台帳に予約・利用記録・請求観測が1行でもあれば拒否する**
  - smoke を1回でも台帳経由で行った後は、ここで止まる
  - 記録を残すか消すかは、ChatGPT とユーザーが決める
- 実行内容
  1. `supabase/tests/ai_provider_budget_ledger_rollback.sql`（RPC 7件と schema を削除）
  2. 履歴の行を削除する
  3. 事前チェックが再び `READY_TO_APPLY` になることを確認する
- 呼び出し側（Phase 2a）を配線した後は、この rollback を使わない。止めるのは §3.3 で行う

## 5. G5 との競合

| 観点 | 結論 | 根拠 |
|---|---|---|
| 対象オブジェクト | 重ならない | 台帳は `ai_ledger.*` と `public.ai_ledger_*` だけを作る。既存の表・関数・権限は変えない（指紋の比較で確認） |
| 時間 | G5 の窓（ACTIVE）と重ねない | 同じ Supabase への DDL は1つずつ。G5 が窓を開けたら台帳の適用を待つ |
| G5 の未適用 migration（`20261009120000`） | 互いに影響しない | G5 の事前検証は自分の名前だけを確認する |
| **G5 の既存の指紋チェック** | 適用後に再実行すると差分が出る（予定どおり） | ローカルで実測した: 07_existing_fingerprint は `functions` だけ、04_touched_and_fingerprints は `untouched_functions` `history_count`、および `history_latest`（台帳の version が本番で最新の場合）だけが変わる。それ以外（表・列・制約・ポリシー・型・既定権限）は不変 |
| 履歴の順番 | 台帳を先に入れると、G5 の `20261009120000` は後から古い version として入る | `db push` は使わないので実害は無い。G5 の runner は件数を比べるので「+1行」を共有する |
| アカウント削除 | 当面は影響なし | 試験用ポリシーは system だけを許可するので、`user_id` の行は台帳に入らない。user 用の経路を開く前に、G5 と削除・仮名化を決める |

適用後に G5 へ共有する内容:

- 適用の日時（JST）
- 追加した関数7件
  - `public.ai_ledger_reserve` / `mark_sent` / `settle` / `release` / `recover_stale` / `usage_summary` / `budget_status`（いずれも `(p jsonb)`）
- 履歴に +1行（`20261010050613`）
- 上記の指紋の変化は予定どおりであること

## 6. 検証の記録（すべてローカル。本番・実 API は 0）

| 対象 | 内容 | 結果 |
|---|---|---|
| 事前チェックの予測 | 台帳の proof runner の adverse 14件・安全な対照2件・supabase・nonsuper で、予測（NOT_READY / READY）と migration の実際の判定が一致 | 全件一致 |
| 予測の見落としの修正 | 1c 版は「SET で中継したロールが service_role を継承する経路」（`r2_set_mixed_hops`）を見落としていた。到達先が継承する権限まで判定するよう一般化した | 修正後に一致 |
| 試験用ポリシー | 許可リスト（user・別機能・別アプリ・Sonnet・Haiku・OpenAI は拒否）、1回 $1、日 $2・6回、月 $5・40回、停止スイッチ、二重登録の拒否 | 8項目 PASS |
| 既存業務への影響 | 適用前後の指紋: 既存オブジェクトは不変、増えたのは RPC 7件だけ。G5 の 07/04 の変化は上記の項目だけ | PASS |
| smoke（オフライン） | 送信なし（plan）、送信前の拒否9種類、送信1回と照合、エラー5種類で再試行なし・キー非表示、照合の不一致検出、import の分離 | 9件 PASS |
| smoke（台帳込み e2e） | 偽の Anthropic → 実 migration ＋試験用ポリシー（PostgREST の代替サーバー経由）: 台帳の増分が一致。停止後は送信前に拒否 | PASS |
| smoke の実行フラグ | 実際のフラグで、Anthropic への通信を Deno の権限で遮断して実行: SDK の初期化に問題なし、送信は遮断されて1回で停止 | 確認済み |
| runner | 偽の supabase CLI で29経路（成功・確認フレーズ・Stage A 失敗・応答喪失→再開・既存オブジェクトの変化・予測拒否・バイト改ざん・停止・rollback の可否） | 29件 PASS |
| mutation | migration 16件＋事前チェック4件 | 20/20 検出 |
| 回帰 | 台帳の proof runner 全パート、Deno（ai_provider と smoke）103件、型チェック、lint、migration_source_invariants 11件 | PASS |

## 7. 残課題

- 本番の事前チェックの結果（ユーザーが手順4で確認する）
- 回復処理の Cron（手順9。別ゲート）
- 広い範囲のポリシーと許可リストは両立しない
  - 将来、全体の上限を DB で持つなら、「当てはまっても、それだけでは許可にならない上限専用のポリシー」が必要（migration の変更）
- 台帳経由の smoke には、一時的な Supabase の secret キーが必要（作成と削除は承認事項）
- Phase 2a（市況レポートの接続）は G2 の PR #110 → T1 の後。キーの種類（旧 service_role / 新 secret keys）は G2 と決める
- `migration_source_invariants_test.ts` の RESERVED に `20261010050613` を加えるか（共有ファイルなので未編集。調整待ち）
