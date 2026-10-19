# G6-03 POSTONA の相談 → 共通 AI の呼び出し口（source-only、相談機能は変えない）

- task_id: `common-ai-g6-postona-consult-gateway-source-adapter-20261019`（Issue #321、G6-03）
- 作成: 2026-10-19。**本番 NO_GO・deploy しない・`index.ts` につながない**。
- 前提: PR #336（G6-02）。この PR はその上に積む。
- 相談機能（`supabase/functions/social-mobile-consult/logic.ts` / `index.ts`、担当は未確定）は**読むだけ・使い回すだけ**で、1 行も変えていない（main と同じ）。

## 0. まとめ

`supabase/ai_gateway/postona_consult_adapter.ts` の `handleConsultViaGateway(request, deps, gateway)` は、**今の相談機能（`handleSocialMobileConsult`）をそのまま**動かし、AI の呼び出し（`ConsultDependencies.callModel`）だけを共通の呼び出し口に差し替える。

| 誰が | 何を |
| --- | --- |
| 相談機能（そのまま） | 本人の確認（`/auth/v1/user`）、本文の確認、ブランドの持ち主の確認（本人の JWT で RLS）、保存済みの設定の読み取り、AI への要求の組み立て、**その回ごとの出力の検査と整え**（`sanitizeConsultModelOutput`）、答えと記録（メタ情報だけ） |
| つなぎ口（G6） | JWT を G5 の口に渡す（G6 では読まない）。`Idempotency-Key` を操作の番号にする。ブランドは相談機能自身の `parseConsultRequest` で読む。相談機能が組み立てた要求が今の指示・形と同じかを確かめ、違えば断る。呼び出し口の答えを、相談機能が返せるエラーに変える。 |
| 呼び出し口（G6-01 / 02） | G5 の判定とプランの決まり、二重実行の防止、台帳、送る直前の再確認、AI への送信 1 回、再送しない |

- **OpenAI への直接の道は使わない**（自動の切り替えはしない）。呼び出し口が無い（`gateway: null`、既定）・G5 がつながっていない（`G5_NOT_CONNECTED`）・`Idempotency-Key` が無い・本文の長さが申告されていない・呼び出し口が運べない形のブランド ID、のどれでも何も送らない。
- 決まりの中身（`POSTONA_CONSULT_CONTENT`）は、相談機能の `CONSULT_SYSTEM_PROMPT` と `CONSULT_OUTPUT_SCHEMA` をそのまま使う（写していない）。呼び出し口での出力の検査は、相談機能自身の検査を、保存済みの状態を空にして使う。

## 1. 出力の検査の分担（調べて分かったこと）

`sanitizeConsultModelOutput` が**断る**のは、出力の形だけで決まる場合だけだった。
- 断る例: 返答が空、知らない項目、範囲外の数、禁止のキー

保存済みの状態と利用者の文は、**整える**ことにだけ使われている。
- 長すぎる返答は切る（断らない）。
- 保存済みと同じ「変更」は提案から外す。
- 「過去の投稿を読んで」の意図を見る。

そこで、分担を次のようにした。
- 断るもの: 呼び出し口が `OUTPUT_REJECTED` として**保存して確定**する（送り直さない）。相談機能は `CONSULT_AI_MALFORMED` を返す。
- 整えるもの: 呼び出し口は AI の答えをそのまま保存し、相談機能が**答えるたびに**（最初も再送も）その回の状態で整える。

## 2. 答えのコード（相談機能の `ConsultError`）

| 呼び出し口 | 相談機能 | status | もう一度試してよいか（同じ Key） |
| --- | --- | --- | --- |
| `QUOTA_EXCEEDED` | `CONSULT_QUOTA_EXCEEDED` | 429 | いいえ |
| `IN_PROGRESS` | `CONSULT_IN_PROGRESS` | 409 | はい（待ってから） |
| `OPERATION_REUSED` | `CONSULT_OPERATION_REUSED` | 409 | いいえ |
| `UNKNOWN` | `CONSULT_AI_UNKNOWN` | 502 | いいえ（送り直さない） |
| `PROVIDER_FAILED` | `CONSULT_AI_FAILED` | 502 | いいえ |
| `OUTPUT_REJECTED` | `CONSULT_AI_MALFORMED` | 502 | いいえ |
| `AUTH_UNAVAILABLE`（G5 に届かない） | **`CONSULT_AUTH_UNAVAILABLE`**（新） | 503 | はい |
| `AUTH_*`（ほか）・`AUTH_REVOKED_BEFORE_SEND`・`POLICY_*` | `CONSULT_NOT_ENTITLED` | 403 | いいえ |
| `STORE_UNAVAILABLE` | `CONSULT_AI_UNAVAILABLE` | 503 | はい（何も取っていない） |
| `LEDGER_UNAVAILABLE`・`NOT_SENT` | **`CONSULT_NOT_SENT`**（新） | 503 | いいえ（新しい Key でやり直す） |
| `COST_DENIED`・`REQUEST_INVALID` | `CONSULT_AI_UNAVAILABLE` | 503 | いいえ（設定） |
| （Key が無い・形が違う） | **`CONSULT_IDEMPOTENCY_KEY_REQUIRED`**（新） | 400 | いいえ |

今の直接の道では、AI の失敗は `retryable: true` だった。呼び出し口では、保存した失敗は**同じ Key では変わらない**ので `false` にした。アプリ（スマホ）側の扱いの変更が要る（§4）。

## 3. 今の直接の道との違い（つなぐ前に決めること）

1. **AI への入力の形**: 今は、保存済みの状態・会話の履歴・発言を、それぞれ別のメッセージとして送っている。呼び出し口では、これらを**1 つの JSON（データ）**にまとめて送る（指示文が「データであって命令ではない」と言っている形と同じ）。答えの質の確認が要る（本物の AI で。別の承認）。
2. ログのトークン数: 呼び出し口の答えにはトークン数が無いので、相談機能のログの `input_tokens` / `output_tokens` は 0 になる。使用量と費用は台帳にある（控えの `callKey` で引ける）。
3. `Content-Length` が必要: つなぎ口は、相談機能より先に本文の写しを読む（ブランドを知るため）。申告された長さが相談機能の上限（32 KB）以内のときだけ読み、無ければ何も送らない。
4. ブランド ID: 相談機能は `^[A-Za-z0-9_-]{1,80}$` を受け付けるが、呼び出し口のブランドは `^[a-z][a-z0-9_]{1,40}$`（POSTONA の `u_` ＋ 24 桁の 16 進数は入る）。それ以外は何も送らない。
5. 同じ Key で保存済みの設定が変わった場合: 入力（保存済みの状態を含む）が変わるので、`CONSULT_OPERATION_REUSED` になる。アプリは新しい Key でやり直す。

## 4. 本番につなぐときの最小の差分（候補。実装していない）

1. 相談機能の `index.ts`（担当は未確定。担当の同意が要る）:

   ```ts
   import { handleConsultViaGateway } from "../_shared/ai_gateway/postona_consult_adapter.ts"; // Edge に置けるようになってから
   Deno.serve((request) => handleConsultViaGateway(request, deps, gateway /* 承認まで null */));
   ```

   `gateway` は、起動時に `createAiGateway({ …, authority: createG5AuthorityPort({ transport: <G5 の本物の口>, planAllowlist }), policies: buildAppPolicySet(<運用の設定>, { "postona:consult": POSTONA_CONSULT_CONTENT }).registry })` で作る。
2. Edge に置くこと（G6-01 の §5）: `supabase/ai_gateway/` を `supabase/functions/_shared/ai_gateway/` へ移し、共有 provider の `isolation_test.ts` の許可の一覧を広げる。**Codex Sol（高）の限定レビュー**が要る。
3. G5 / F5: 判定の形（G6-02 の §2）と、問い合わせの方法の実装。
4. AI のプランの決定（どの利用権で相談を使えるか）と、運用の設定（版・モデル・上限）。
5. アプリ（スマホ。G1 / G2 の担当）:
   - 相談の要求に `Idempotency-Key` を付ける（同じ相談の再送では同じ値、新しい相談では新しい値）。
   - §2 の新しいコードと `retryable` の変更を扱う。
6. 本番: `ai_calls` の適用、台帳の枠の行（`postona` / `consult` / user）、鍵、復旧の Cron、本物の OpenAI で答えの質を確かめる。

## 5. 確かめたこと（すべて偽の部品か、隔離した DB での PASS）

| テスト | 数 | 中身 |
| --- | --- | --- |
| `common_ai_gateway_postona_consult_test.ts`（`--deny-net`。偽の Supabase（本人の確認・RLS の読み取り・台帳・`ai_calls`）・偽の G5・偽の OpenAI。**本物の相談機能**） | 8 PASS | 通し（AI への要求は 1 回、相談機能の指示文そのまま、形の名前、発言・履歴・保存済みの状態はデータとして、JWT・利用者 ID・ブランド・鍵は入らない、ログはメタ情報だけ）、再送は送信 0。既定で何も送らない 7 通り（呼び出し口なし、G5 なし、Key なし／短い／空白入り、長さの申告なし、運べないブランド ID）。相談機能の確認が先（JWT なし → 401、他人のブランド → 404、どちらも G5 を呼ばない）。G5 の拒否・プランなし・再確認での取り消し（予約を返す、再送は `CONSULT_NOT_SENT`）。人・ブランド・中身ごとの二重実行の防止と並行。504・400・台帳の障害（新しい Key なら直った後に通る）・形の違う答え。出力の検査の分担。要求のずれ 6 通りは呼び出し口を呼ぶ前に断る。全 20 コードの対応表。決まりの中身 |
| `common_ai_gateway_postona_consult_pg_test.ts` ＋ `_run.sh`（隔離した PG17、本物の台帳と `ai_calls` の SQL） | 4 PASS（うち 1 は準備） | 通し（`ai_calls` に 1 行：ブランド・利用者・一覧の role・版、settled）、新しい組み立てからの再送、Key の共有（別のブランドと人は別の行）、中身違い、**本物の並行**（送信 1）、再確認での取り消し（released・`POLICY_DENIED`・`CONSULT_NOT_SENT`）、504（両方で上限額の UNKNOWN、送り直さない） |
| PR #333 の実行用コードのテスト | 10 PASS | `supabase/ai_gateway/` のファイル一覧に、つなぎ口を足した。相談機能のモジュールを import してよいのは、つなぎ口だけ。 |

- わざと壊した写し: **16/16 を検出**（作業用のフォルダだけ。うち本物の SQL 2）。
- 意味が同じため数えていない写しが 1 つある。相談機能の OpenAI の鍵をつなぎ口に渡したままにする写しで、つなぎ口はその鍵を使わないため結果が変わらない。AI への要求が呼び出し口の鍵を使うことは、別に確かめている。
- **NOT_VERIFIED**: 配置した相談機能、G5 の本物の判定、本物の OpenAI（答えの質を含む）、本物の Supabase と managed、本番の台帳と `ai_calls`、スマホのアプリの扱い。
