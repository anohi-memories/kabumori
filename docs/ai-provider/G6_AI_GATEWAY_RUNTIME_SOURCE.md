# G6-01 共通AI呼出し口の実行用コード（source-only、配置しない）

- task_id: `common-ai-g6-runtime-adapter-ledger-callstore-integration-source-20261019`（Issue #321、G6-01）
- 作成: 2026-10-19。**本番 NO_GO・deploy しない・どのアプリにもつながない**。
- 前提: PR #302（GAP-1〜3 を直した呼び出し口）。この PR はその上に積む。

## 0. まとめ

PR #302 の呼び出し口の中心を、本物の共有部品につないで**呼べる形**にした。

- `supabase/ai_gateway/gateway.ts` — PR #302 の呼び出し口を**1 バイトも変えずに**移したもの（再実装なし）。元の場所 `supabase/tests/common_ai_cross_app_gateway_reference.ts` は、ここを読み込み直すだけの 3 行のファイルにした。
- `supabase/ai_gateway/ai_calls_store.ts` — `SupabaseAiCallsStore`。保存の場所（`ai_calls_claim` / `ai_calls_complete`）を、PostgREST 経由で鍵付きで呼ぶ。台帳の部品 `SupabaseLedgerBudgetGuard` と同じ作り。
- `supabase/ai_gateway/policy_registry.ts` — `definePolicyRegistry`。各アプリの機能の決まりを**起動時に 1 回**確かめて、変えられない形にする。
- `supabase/ai_gateway/runtime.ts` — `createAiGateway`。次の 5 つを組み立てる。
  - 本物の provider（OpenAI / Anthropic の adapter）
  - 本物の台帳の部品
  - 保存の場所
  - G5 の判定を受け取る口（外から渡す）
  - 決まりの一覧

共有の provider・台帳・`ai_calls` の SQL・H5 bridge・G5 の認可まわり・POSTONA の相談の本体は変えていない。

## 1. 組み立ての決まり（`createAiGateway`）

設定が少しでもおかしければ、組み立てる時点で止める（AI に何かを送る前）。

| 確かめること | 合わなければ |
| --- | --- |
| Supabase の URL が https か、手元のテスト用の http://127.0.0.1 / localhost | `supabase_url` |
| 鍵が `SecretValue` | `service_key_type` |
| **旧式の JWT の service_role 鍵（`eyJ…`）でない** | `legacy_service_key` |
| 本物の project では `sb_secret_` で始まる鍵 | `service_key_kind` |
| `readEnv`、G5 の口（`verdict` と `recheck` の両方） | `read_env` / `authority` |
| 決まりの一覧が `definePolicyRegistry` で作られたもの | `policies` |

- provider には、**provider の鍵の名前（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）だけ**を読める `readEnv` を渡す（最小の権限）。
- Supabase の鍵は台帳と保存の場所の要求の header にだけ入り、AI への要求には入らない。AI の鍵は Supabase への要求には入らない（テストで確認）。
- この組み立ては Deno の API・console・環境変数を直接使わない（Edge でも動く形）。

## 2. 決まりの一覧（`definePolicyRegistry`）

起動時に断るもの:
- 同じ `app:feature` の重複
- アプリ名
- 機能名
- 版（`revision`）
- `logicalRole` と `ledgerFeature`（保存の場所と台帳の名前の形）
- モデルと AI の会社の組み合わせ
- 考える強さ
- 出力の上限
- 時間の上限
- 試みの数
- 入力の上限
- 主体（重複・空・ブランド必須なのに user が無い）
- 指示が空
- 検査の関数が無い
- 送れない schema
- **1 回の操作の最大額が 1 USD を超える**
- **入力が一番大きいときの最大額 × 試みの数が、決まりの上限を超える**

1 USD を超える額を断る理由: `ai_calls` は控えの費用を 1 USD までしか受け付けない。そのような決まりを許すと、**AI に送ってお金がかかった後に結果を保存できない**。この組み合わせを起動時に見つけて断る。

## 3. 保存の場所の部品（`SupabaseAiCallsStore`）

- claim では、次のものを送る:
  - アプリ名
  - `app:feature`（呼び出し口の控えの feature と同じ所から決まる）
  - 主体の種類
  - user の場合だけ利用者 ID
  - ブランドの slug（表示用の `brand_ref` だけ。ID としては使わない）
- 答えは、決まった 4 つの形だけを受け付ける。
  - `acquired`: owner は uuid
  - `busy`
  - `conflict`
  - `complete`: fingerprint は 64 桁、result は object

  ほかの形・HTTP のエラー（本文が正しい形に見えても）・つながらない場合は例外になる。claim では呼び出し口が `STORE_UNAVAILABLE`（何も予約しない・送らない）、complete では `UNKNOWN`（送り直さない）と答える。
- 再送のときに保存された答えを使ってよいかの細かい確認は、呼び出し口の `fromStoreAudit` が行う（PR #302）。

## 4. 確かめたこと

| テスト | 数 | 中身 |
| --- | --- | --- |
| `common_ai_gateway_runtime_test.ts`（`--deny-net`、偽の AI と偽の Supabase） | 11 PASS | 送る直前の claim の確認（G6-07: 閉じられた・読めない → 送信 0）、上の設定の拒否 9 通り、決まりの拒否 23 通りと重複、両方の AI＋かぶモリの運営の仕事の通し、新しい組み立てからの再送（送信 0）、読める鍵の名前、鍵が混ざらないこと、保存の場所に送る中身、G5 の口の 8 通り（期限切れ・拒否・つながらない・再確認での取り消し・期限切れ・世代の変化・主体の変化・つながらない）、保存の場所の障害 9 通り、台帳（枠・障害・確定の答えの喪失・精算の失敗）、同時・中身違い・別の人やブランドやアプリ・版の変更、再試行・504・400、Edge で動く形と import の範囲 |
| `common_ai_gateway_runtime_pg_test.ts` ＋ `_run.sh`（隔離した PG17、本物の台帳と `ai_calls` の SQL） | 6 PASS（うち 1 は準備） | 両方の AI＋運営の仕事、新しい組み立てからの再送、**本物の並行**の重複（送信 1）、中身違い、別の人やブランドの行と費用、日の上限（予約 0）、世代の変化（予約を返す、`NOT_SENT`）、台帳に届かない、確定した mark_sent の答えの喪失（台帳は `sent` のまま＝多めに数える）、精算の喪失、504（台帳と保存の場所の両方で上限額の UNKNOWN）、記録の喪失（書く前→処理中、書いた後→保存した答え） |
| PR #284 / #289 / #302 のテスト（移した呼び出し口を読み込み直す 3 行のファイル経由） | 11＋12＋14 PASS | 変わっていないこと |

- わざと壊した写し: **21/21 を検出**（作業用のフォルダだけ）。内訳は、保存の場所の部品 8、組み立て 5、決まりの一覧 8。
  - 最初は 1 通り見逃した（HTTP 500 なのに本文が正しい形に見える場合）。そのテストを足して検出した。
  - 意味が同じため数えていない写しが 1 つある。provider に渡す `readEnv` の絞り込みを外す写しで、今の provider は自分の鍵の名前しか読まないので、外しても結果が変わらない。
- **すべて偽の部品か、隔離した DB での PASS**。

## 5. 止めたこと（共有の境界）— 配置するには共有部品の安全の境界を変える必要がある

この実行用コードを Edge Function から使うには、`supabase/functions/` の下（例: `_shared/ai_gateway/`）へ移す必要がある。しかし provider の `supabase/functions/_shared/ai_provider/isolation_test.ts` は、配置されるコードが provider を使える範囲を、決まったファイルと決まった名前だけに絞っている（最小の権限）。今のままでは:
- 新しいファイルが provider を参照すること（`AUTHORIZED_REFERENCES`）が許されない
- provider に届くこと（`AUTHORIZED_REACHERS`）が許されない
- **台帳の部品を組み立てること（`SupabaseLedgerBudgetGuard`）・`executeAiRequest` を直接呼ぶこと**（`AUTHORIZED_PROVIDER_IMPORTS`）が許されない

そのため、**今回は移していない**。変更の候補だけを書く（実装していない）。

- 対象のファイル: `supabase/functions/_shared/ai_provider/isolation_test.ts`（共有 provider の安全の境界）
- 変更の候補:
  1. `_shared/ai_gateway/{gateway,runtime,ai_calls_store,policy_registry}.ts` を `AUTHORIZED_REFERENCES` と `AUTHORIZED_REACHERS` に足す。
  2. `AUTHORIZED_PROVIDER_IMPORTS` に、それぞれが使う名前だけを足す。
     - gateway: `executeAiRequest`、`findModelSpec`、`upperBoundAttemptCostUsd` と型
     - runtime: `SupabaseLedgerBudgetGuard`、`PROVIDER_API_KEY_ENV`、`SecretValue`、型
     - store: `safeToken`、`SecretValue`、`FetchLike`
     - registry: `assertSchemaSupported`、`findModelSpec`、`upperBoundAttemptCostUsd`
  3. Edge の入口（`AUTHORIZED_ENTRY_POINTS`）は、実際に使う関数ができるまで足さない。
- 担当: G6（共通 AI の provider の持ち主）。ただし、最小の権限の境界を広げることになる。
- 必要なレビュー: **Codex Sol（高）の限定レビュー**。見る点は、台帳の部品の組み立てと秘密の鍵の受け取りを、配置されるコードに許してよいか。
- そのほかに要るもの（別の承認）:
  - `ai_calls` の migration の本番への適用
  - 台帳の枠の行
  - Supabase の秘密の鍵の名前と登録（`sb_secret_`）
  - G5 の `verdict` / `recheck` の本物の口
  - 各アプリの決まり（版を含む）
  - 復旧の Cron
  - 本物の AI での確認

## 6. 未確認（NOT_VERIFIED）

本物の Supabase / PostgREST / managed のロールと権限、本番の台帳と枠、`ai_calls` の本番への適用、本物の OpenAI / Anthropic、G5 の本物の判定、Edge での実行、復旧の Cron。
