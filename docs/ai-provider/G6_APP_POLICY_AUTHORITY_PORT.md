# G6-02 アプリ別の AI 機能の決まり ＋ G5 の判定を受け取る口（source-only、配置しない）

- task_id: `common-ai-g6-cross-app-policy-registry-authority-port-e2e-20261019`（Issue #321、G6-02）
- 作成: 2026-10-19。**本番 NO_GO・deploy しない・どのアプリにもつながない**。
- 前提: PR #333（G6-01 の実行用コード）。この PR はその上に積む。PR #333 自体は変えていない。

## 0. まとめ

- `supabase/ai_gateway/app_policies.ts`
  - G6 の**機能の一覧**（`APP_FEATURE_CATALOG`）を持つ。
  - `buildAppPolicySet` が、次の 3 つがそろったときだけ機能を有効にする。
    - G6 の一覧
    - 運用の設定（版・AI の会社・モデル・上限・どの利用権で使えるか）
    - アプリの中身（指示・出力の形・出力の検査）
  - 設定が無い機能はすべて**使えない**。一覧に無い機能の設定（Miseiro・打ち間違い）は、起動時の誤りとして止める。
- `supabase/ai_gateway/authority_port.ts`
  - `createG5AuthorityPort` は、G5 の判定を**厳しく**変換する。少しでも想定と違えば `unknown`／`deny` にし、`allow` にはしない。
  - G6 が判断するのは、「どの利用権ならどの AI 機能を使えるか」という AI のプランの決まりだけ。本人・セッション・ブランドの持ち主・利用権の有無は、G5 の答えをそのまま使い、G6 では判断しない。
- 金額・モデル・プランは決めていない（事業の判断）。テストの値は、テストのためだけの値。

## 1. 機能の一覧（G6）

| app:feature | 主体 | ブランド | AI の会社（データの送り先） | 利用権の候補 | 既定 |
| --- | --- | --- | --- | --- | --- |
| `kabumori:market_report` | system だけ | 不要 | anthropic, openai | なし | 設定が無ければ使えない |
| `postona:consult` | user だけ | 必要 | **openai だけ** | `postona:x_autopost` | 使えない（AI のプランが未決定） |
| `postona:post_generation` | user だけ | 必要 | **openai だけ** | `postona:x_autopost` | 使えない（AI のプランが未決定） |
| `miseiro:*` | ― | ― | ― | ― | **一覧に無い**。G5 にも問い合わせずに断る |

- POSTONA で Anthropic を使えないのは、個人のデータを Anthropic に送るための正式なルール変更とプライバシーの告知がまだのため（方向は承認済み、正式は未承認）。設定で anthropic を選んでも `provider_not_allowed_for_this_data:anthropic` として使えないままにする。
- 起動時の誤り（`AppPolicyConfigError`）:
  - 一覧に無い機能
  - 設定の形
  - モデルと AI の会社の組み合わせ
  - 最大額が 1 USD を超える
  - 一覧に無い利用権・利用権の重複
  - 運営の仕事（system）の機能に利用権を付けた
- 使えないままになる理由（`disabled`）:
  - 設定が無い（`no_config`）
  - 設定で無効（`disabled_by_config`）
  - アプリの中身が無い（`no_app_content`）
  - データの送り先として許されない AI の会社
  - 利用者向けの機能なのに、使える利用権が設定されていない（`no_plan_entitlement`）
- 通ったものは、PR #333 の `definePolicyRegistry` がもう一度確かめる（版・最大額・入力が一番大きいときの額など）。

## 2. G5 に求める判定の形（G5 / F5 への提案。実装の依頼ではない）

G5 への問い合わせの方法（Edge の中の関数、RPC など）は G5 が決める。G6 は `fetchVerdict` / `fetchRecheck` を外から受け取るだけで、G5 の RPC やテーブルがあるとは仮定していない（#279 の案 B は未承認のまま）。

| 項目 | 形 | 持ち主 | G6 の扱い |
| --- | --- | --- | --- |
| `v` | `1` | G5 | 1 以外は `unknown` |
| `decision` | `allow` / `deny` / `unknown` / `pending` | G5 | allow 以外はそのまま返す |
| `reason` | 記号（`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`）か null | G5 | 自由な文は `unknown` |
| `scope` | `{app, feature, brand_slug}` | G5（問い合わせの写し） | 問い合わせと 1 つでも違えば `unknown`（SCOPE_MISMATCH） |
| `subject` | `{kind:"user", user_id: uuid}` か `{kind:"system"}` | G5 | slug を利用者 ID として使ったものは `unknown` |
| `session` | `{state: active/revoked/expired/unknown, ref}`。system は null | G5 | active 以外は `deny`（SESSION_*） |
| `owner_epoch` | 中身の見えない文字列。ブランドがあるときは必須 | **F5**（#285 の `private.account_lifecycle_brand_owner_epoch` の値を文字列にしたもの） | ブランドがあって値が無ければ `unknown` |
| `entitlements` | `"<app>:<service>"` の配列（有効なものだけ、32 件まで） | G5（service_entitlements） | 形が違えば `unknown`。プランの決まりと 1 つも合わなければ `deny`（PLAN_NOT_ALLOWED） |
| `issued_at_ms` / `expires_at_ms` | 整数のミリ秒 | G5 | 期限切れは `deny`。有効期間が 5 分を超えるもの・未来の発行（30 秒より先）は `unknown` |

- **世代**（呼び出し口が送る直前に比べる値）は、`owner_epoch`・`session.ref`・プランに関わる利用権から作る。どれかが変われば、送信 0 で予約を返す。
- G5 が届かない・3 秒（設定可）を超えて答えない場合は例外になる。呼び出し口はこれを `AUTH_UNAVAILABLE`（送信 0）、再確認のときは `AUTH_REVOKED_BEFORE_SEND` にする。
- 使えない機能（Miseiro、設定が無いもの）は、G5 に問い合わせずに `deny`（FEATURE_NOT_ENABLED）にする。

## 3. POSTONA の相談機能につなぐときの差分（提案だけ。担当は未確定なので実装しない）

今の `supabase/functions/social-mobile-consult/logic.ts` は、`ConsultDependencies.callModel`（OpenAI の要求をそのまま組み立てて送る）で AI を呼んでいる。呼び出し口に替えるときに要る差分:

1. 指示と出力の形を、決まりの「アプリの中身」として取り出す: `consultSystemInstructions`、`consultSchema`、`consultInput(input, saved)`（今の `buildConsultModelBody` の入力の部分）。
2. `callModel` の代わりに `gateway.execute(<利用者の JWT>, { app: "postona", feature: "consult", operationId: <Idempotency-Key>, input: consultInput(...), brand: { app: "postona", slug: input.brandId } })` を呼ぶ。
3. 決まりの `validate` は固定の検査（出力の形）。`sanitizeConsultModelOutput` は、その回の保存済みの状態と利用者の文が要るので、**呼び出し口から返った後で相談機能の側が呼ぶ**。保存された答えを再送で返しても同じ結果になるので、送り直しは起きない。
4. 答えのコードの対応（案）:

   | 呼び出し口のコード | 相談機能のコード |
   | --- | --- |
   | `QUOTA_EXCEEDED` | `CONSULT_QUOTA_EXCEEDED` |
   | `IN_PROGRESS` | `CONSULT_IN_PROGRESS` |
   | `OPERATION_REUSED` | `CONSULT_OPERATION_REUSED` |
   | `UNKNOWN` | `CONSULT_AI_UNKNOWN` |
   | `AUTH_*`（`AUTH_REVOKED_BEFORE_SEND` を含む）と `POLICY_*` | `CONSULT_NOT_ENTITLED` |
   | `LEDGER_UNAVAILABLE` / `STORE_UNAVAILABLE` / `NOT_SENT` | `CONSULT_AI_UNAVAILABLE` |
   | `PROVIDER_FAILED` | `CONSULT_AI_FAILED` |
   | `OUTPUT_REJECTED` | `CONSULT_AI_MALFORMED` |

   PR #273 の部品と同じ考え方。
5. 今の `assertOwnedSocialMobileWorkspace` と利用権の直接の読み取りは、G5 の判定（ブランドの持ち主と利用権）に置き換わる。置き換えが済むまでは、二重の確認として残してよい。

## 4. 確かめたこと（すべて偽の部品か、隔離した DB での PASS）

| テスト | 数 | 中身 |
| --- | --- | --- |
| `common_ai_gateway_app_authority_e2e_test.ts`（`--deny-net`、偽の G5・偽の AI・偽の Supabase） | 6 PASS | 一覧と設定（既定で使えない、使えない理由 4 種、起動時の誤り 9 種＋system の利用権、#333 の確認も働く）。G5 の口が厳しいこと（26 通り＋使えない機能は G5 を呼ばない、届かない、遅い、知らない判定の再確認、設定の誤り）。両方のアプリの通し。再確認で G5 が変わる 7 通り（セッションの取り消し、持ち主の世代、利用権の削除、新しいセッション、持ち主でなくなった、届かない、遅い）→ 送信 0・予約を返す・再送は `NOT_SENT`。人・ブランド・アプリの分離と誤用。並行の重複、504、台帳の障害、精算の喪失 |
| `common_ai_gateway_app_authority_pg_test.ts` ＋ `_run.sh`（隔離した PG17、本物の台帳と `ai_calls` の SQL） | 5 PASS（うち 1 は準備） | 両方のアプリが 1 行ずつ（一覧の role と版）、プランなし・使えない機能・Miseiro は何も残らない、再確認での取り消し（予約を返す・`POLICY_DENIED`・`NOT_SENT`）、並行の重複（送信 1）、台帳に届かない、504 |
| PR #333 の実行用コードのテスト | 10 PASS | ファイルの一覧に新しい 2 つを足しただけ（同じ決まり：実行環境の API なし、決まった import だけ） |

- わざと壊した写し: **27/27 を検出**（作業用のフォルダだけ）。内訳は、一覧と設定 9、G5 の口 18（うち本物の SQL 2）。
  - 最初は 2 通り見逃した。
    - 本物の SQL のテストが扱わない設定の写しは、外部と通信しないテストで同じ壊し方を検出済みなので、一覧から外した。
    - 「system に利用権を付けた」確認は、今の一覧ではその手前の確認に必ず先に止められる。一覧を差し替えたテストを足して検出した。

## 5. 残ること（それぞれ別の承認）

1. G5 / F5: §2 の判定の形の実装（`owner_epoch` は #285、セッションの状態、利用権）と、問い合わせの方法。
2. AI のプランの決定: どの利用権（プラン）で consult / post_generation を使えるか。決まるまでは使えないまま。
3. 運用の設定: 機能ごとの版・モデル・上限（事業の判断。今回は決めていない）。
4. POSTONA で Anthropic を使うこと: 正式なルール変更とプライバシーの告知の後に、一覧の `allowedProviders` を変える。
5. POSTONA の相談機能の担当の確定と、§3 の差分。
6. Edge への配置（G6-01 の §5）: 共有 provider の `isolation_test.ts` の許可の一覧を広げることと、Codex Sol（高）の限定レビュー。
7. 本番: `ai_calls` の適用、台帳の枠の行、鍵、復旧の Cron、本物の AI での確認。
8. Miseiro の機能（承認されたら一覧に足す）。
