# G6-05 共通 AI の呼び出し口を Edge に置くときの最小権限 — 実行できる事前確認（source-only、未適用）

- task_id: `common-ai-g6-edge-import-isolation-security-preflight-20261019`（Issue #321、G6-05）
- 作成: 2026-10-19。**本番 NO_GO・何も置いていない・共有部品は変えていない**。
- 前提: PR #345（G6-04）。この PR はその上に積む。

## 0. まとめ

G6 の実行用コード（`supabase/ai_gateway/` の 8 ファイル。G6-06 で `recovery.ts` を足して 9 ファイル）を Edge で使うには、`supabase/functions/_shared/ai_gateway/` へ置く必要がある。そこは共有 provider の `isolation_test.ts` が守る範囲で、今の許可の一覧では置けない。

この PR は、**一覧を変えず・何も置かず**に、次のことを**実際に動く確認**として作った（`supabase/tests/common_ai_gateway_edge_preflight.ts`）。

| 確認 | 結果 |
| --- | --- |
| 変えていない写しで、本物の制限のテスト（provider・bridge）を動かす | 18 PASS（基準） |
| 写しに G6 のファイル（G6-06 以降は 9 つ）を置く（import の行先だけを書き換える）。一覧は変えない | **7 件失敗**（境界が止める） |
| 置いたうえで変更案（パッチ）と G6 用の制限のテストを当てる | **23 PASS**。置いたファイルは、その場所で `deno check` も通る |
| 変更案を当てたうえで、悪い変更を 1 つずつ加える（12 種類） | **12/12 が失敗**（どのテストが止めたかも表示） |
| 変更案から許可を 1 つずつ抜く（7 参照＋8 届く範囲＋26 名前。G6-06 以降は届く範囲が 9） | **41/41 が失敗**（G6-06 以降 42/42）（＝不要な許可は 1 つも無い） |
| 変更案は行を足すだけか | 42 行（G6-06 以降 43 行）を足すだけ、消す行は 0、対象は 1 ファイル（既存の確認を弱めない） |

- 写しはすべて一時フォルダに作り、終わったら消す。リポジトリの `supabase/functions/` は 1 バイトも変えていない。
- 変えた G6 のファイルは `supabase/ai_gateway/runtime.ts` のコメント 1 行だけ（`ANTHROPIC_API_KEY` の文字を `PROVIDER_API_KEY_ENV` に）。共有の制限のテストは、コメントの中の `ANTHROPIC_*` の文字も数えるため。

## 1. 変更案（未適用）: 共有 provider の `isolation_test.ts` に足すもの

ファイル: `supabase/tests/fixtures/g6_05_edge_placement/provider_isolation_allowlist.patch`

| 一覧 | 足すもの | 理由 |
| --- | --- | --- |
| `AUTHORIZED_REFERENCES`（provider を名指ししてよいファイルと書き方） | gateway / runtime / ai_calls_store / app_policies / g5_rpc_transport / policy_registry の 6 ファイル＋G6 用の制限のテスト（文字列として 4 ファイルを名指しする） | 置いたファイルの import の書き方そのもの |
| `AUTHORIZED_REACHERS`（provider に届いてよい配置ファイル） | 上の 6 ファイル＋authority_port・postona_consult_adapter（型の import を通して間接的に届く） | 届く範囲の全部。これ以外は届かない |
| `AUTHORIZED_PROVIDER_IMPORTS`（ファイルごとに使ってよい名前） | 下の表 | 最小限（1 つ抜くと失敗することを 26 名前すべてで確認） |
| `AUTHORIZED_ENTRY_POINTS`（Edge の入口） | **足さない** | どの Edge の入口からも届かないまま。入口から使うのは、別の承認の後 |

ファイルごとの名前:

| ファイル | provider から使う名前 | 何に使うか |
| --- | --- | --- |
| `gateway.ts` | mod: `executeAiRequest`, `findModelSpec`, `upperBoundAttemptCostUsd`, 型 `AiRequest` `AiSubject` `BudgetGuard` `ExecuteDeps` `JsonSchema` | **AI を呼ぶ唯一の場所**。呼ぶのは次の 5 つを通った後だけ。決まりの一覧 → G5 の判定 → 1 回の最大額 → 保存の場所の claim → 送る直前の再確認と claim の確認（台帳の guard を包む。G6-07） |
| `runtime.ts` | mod: **`SupabaseLedgerBudgetGuard`**, `PROVIDER_API_KEY_ENV`, 型 `EnvReader` `RetryTiming`；secrets: `SecretValue`（`instanceof` に使う）；adapter: 型 `FetchLike` | **台帳の guard を組み立てる唯一の場所**。鍵は呼ぶ側から `SecretValue` で受け取り、自分では読まない。旧式の JWT の鍵は断り、本物の project では `sb_secret_` だけ。provider には、provider の鍵の名前だけを読める `readEnv` を渡す |
| `ai_calls_store.ts` | adapter: 型 `FetchLike`；redact: `safeToken`；secrets: 型 `SecretValue` | `ai_calls` の RPC を呼ぶ。エラーは整えた記号だけを返す |
| `g5_rpc_transport.ts` | adapter: 型 `FetchLike`；redact: `safeToken` | G5 の判定の RPC（**まだ無い**）を呼ぶ。本人の JWT はヘッダにだけ入れる |
| `policy_registry.ts` | mod: `assertSchemaSupported`, `findModelSpec`, `upperBoundAttemptCostUsd`, 型 `AiRequest` | 起動時の決まりの確認 |
| `app_policies.ts` | mod: `findModelSpec`, 型 `AiReasoningEffort` `JsonSchema` | 機能の一覧と設定の組み合わせ |

**許さないもの**（変更案に無い。足すと失敗する）:
- `resolveSecret`・`resolveProviderApiKey`・`primaryLedgerFromEdgeEnv`（鍵や環境を自分で読む道）
- `InMemoryBudgetGuard`
- namespace・default・副作用・動的な import
- Anthropic の SDK と `ANTHROPIC_*` の名前
- 一覧に無いファイルからの provider への到達
- どの Edge の入口からの到達

## 2. 変更案（未適用）: G6 用の制限のテスト

ファイル: `supabase/tests/fixtures/g6_05_edge_placement/ai_gateway_isolation_test.ts.txt`（置くときは `supabase/functions/_shared/ai_gateway/isolation_test.ts`）

- ファイルはちょうど 8 つ（G6-06 以降は `recovery.ts` を含む 9 つ）（とこのテスト）。
- Deno の API・`process.env`・console・`node:`・動的な import を使わない。
- import してよいのは兄弟ファイルと provider の 4 ファイルだけ。相談のつなぎ口だけは、相談機能の `logic.ts` と設定の型も読める。
- consumer bridge を読まない。
- 鍵の名前と鍵の形の文字列を書かない。
- 他の関数・アプリから `ai_gateway` を読み込まない。

共有 provider のテストが「誰が・どの名前で provider に届くか」を決める。このテストは「置いた G6 のファイル自身が何をしてよいか」を決める。

**限界**: G6 用のテストは正規表現で読む（provider のテストのような字句解析はしない）。ただし、provider への到達は、provider のテストが字句解析ですべての配置ファイルを読んで確かめる（変更案の後も同じ）。

## 3. 悪い変更が止まること（12 種類。`--show=<case>` で全文）

| 加えた変更 | 止めたテスト |
| --- | --- |
| `runtime.ts` が `resolveSecret` も import する | provider: 名前の最小権限、字句の読み取り |
| `app_policies.ts` が namespace import にする | provider: 名前の最小権限、字句の読み取り |
| `authority_port.ts` に provider の動的な import | G6: 動的な import／provider: 参照・名前・届く範囲・fail closed の 5 件 |
| 一覧に無い新しいファイルが provider を呼ぶ | G6: ファイル一覧／provider: 参照・届く範囲・名前・fail closed |
| 相談機能の `index.ts`（Edge の入口）が呼び出し口を読み込む | G6: 他から読み込まない／provider: 届く範囲と入口 |
| 別の関数（`_shared/brand/`）が呼び出し口を読み込む | 同上 |
| `ANTHROPIC_API_KEY` の文字 | G6: 鍵の名前／provider: Anthropic の名前 |
| `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` | G6: 環境の読み取り、鍵の名前 |
| `console.log` | G6: ログ |
| consumer bridge の型を読み込む | bridge: 他から読み込まない／G6: import の範囲 |
| `node:crypto` | G6: `node:`、import の範囲 |
| アプリ（`src/`）に鍵の名前 | provider: アプリが鍵を名指ししない |

## 4. 置いた後も変わらないこと（これまでの PR で確認済み。置き場所で変わらない）

- **鍵の分離**:
  - Supabase の鍵は台帳と `ai_calls` の要求のヘッダにだけ入る（`SecretValue`）。
  - AI の鍵は provider が名前で読むだけ。
  - 本人の JWT は G5 の RPC のヘッダにだけ入る。
  - どの鍵も、AI への要求・本文・ログ・世代には入らない（#333・#345 のテスト）。
- **G5 の RPC が無い今は送信 0**（#345）。台帳と `ai_calls` にも何も残らない。
- **operationId**: 同じ番号は保存した答えを返し、送り直さない。中身が違えば `OPERATION_REUSED`。並行の重複は 1 回だけ送る（#302・#333・#338、隔離 PG を含む）。
- **最初は無効**: どの Edge の入口も呼び出し口を読み込まない（変更案も入口を足さない）。相談のつなぎ口は既定で `gateway: null` → 何も送らない（#338）。

## 5. 持ち主とレビュー

| もの | 持ち主 | 変えるのに要るもの |
| --- | --- | --- |
| `supabase/ai_gateway/*`（置いた後は `_shared/ai_gateway/*`）、G6 用の制限のテスト、この事前確認 | G6 | G6 の受入（今回） |
| `supabase/functions/_shared/ai_provider/isolation_test.ts`（許可の一覧） | 共有 provider。G6 / F6 が作ったが、市況レポート（G2）・H5 bridge も守られる側 | **明示の承認＋Codex Sol（高）の限定レビュー**（未実施） |
| Edge の入口（例: 相談機能の `index.ts`） | 各機能の担当（相談機能は未確定） | 別の承認、`AUTHORIZED_ENTRY_POINTS` の変更、Sol レビュー |
| G5 の判定の RPC | G5 | G5 の TASK と Sol レビュー |

## 6. Codex Sol（高）に見てほしい点（限定レビューの依頼の材料）

1. 入口から届かないライブラリの `runtime.ts` に、**台帳の guard の組み立て（`SupabaseLedgerBudgetGuard`）**と `SecretValue` の値を許してよいか。provider の冒頭の方針は「台帳の guard を組み立てない」。
2. `gateway.ts` に **`executeAiRequest`** を許してよいか。provider の冒頭の方針は「決まりを通らない `executeAiRequest` は使わない」。呼び出し口は、決まり・判定・最大額・claim・送る直前の再確認の後でだけ呼ぶ。
3. 相談のつなぎ口が、相談機能の `logic.ts` を読み込む（持ち主をまたぐ結合）。読み込むだけで変えないが、相談機能の変更で呼び出し口のずれの確認が止まる（安全側）。
4. G6 用の制限のテストは正規表現による読み取り。provider のテストの字句解析で足りるか、G6 側にも字句解析が要るか。
5. 入口を足す段階（別 TASK）での条件: G5 の RPC の実装、相談機能の担当の同意、最初は無効、`AUTHORIZED_ENTRY_POINTS` の 1 件の追加。

## 7. 後で適用する手順（承認の後。今はしない）

1. 明示の承認と Codex Sol（高）の限定レビュー。
2. `git mv supabase/ai_gateway/*.ts supabase/functions/_shared/ai_gateway/`。import の行先だけを書き換える（この確認と同じ 3 つの書き換え）。
3. 変更案のパッチを当て、G6 用の制限のテストを置く。テスト側の import の行先を `../functions/_shared/ai_gateway/` に直す。
4. provider・bridge・G6 の制限のテスト、#284〜#345 のすべてのテスト、隔離 PG を実行する。
5. Edge の入口はまだ足さない（別 TASK）。

## 8. 実行方法

```
deno run --no-config --allow-read --allow-write=$TMPDIR,/private$TMPDIR --allow-run=deno,patch --allow-env \
  supabase/tests/common_ai_gateway_edge_preflight.ts            # 全部（--only=<case>、--show=<case>|bad）
```

NOT_VERIFIED: 本物の Edge（Supabase のバンドル・配置）、本物の G5、本物の AI、managed の Supabase。この確認が示すのは、ソースの import の境界だけ。
