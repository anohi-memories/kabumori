# F6 POSTONA の今の OpenAI の AI 相談を、共通AI基盤に 1 件つなぐ（オフラインだけ）

- 日付: 2026-10-18（JST）
- task_id: `common-ai-f6-postona-openai-consult-offline-one-request-integration-20261018`
- 指示の元: POSTONA 総合指令室 Issue #269 のコメント 6245437658
- 状態: **オフラインの候補だけ**。今の `social-mobile-consult`（相談の本体）は変えていない。本番・Supabase・OpenAI には接続していない。有料の呼び出し・SNS・deploy・merge はしていない。本番は **NO_GO**
- 土台: F6 の Draft の積み上げの先頭 #264（head `c558264218badd1ebbdb9063e70f8e7cce9ac23d`）。相談の本体のファイルは main と同じ

## 0. 要約

- 今の相談の本体には「モデルを呼ぶ部分（`callModel`）を外から渡せる口」がある。F6 の部品 `createConsultSeam`（`supabase/tests/postona_consult_shared_provider_seam.ts`、deploy しない）は、その口を使って、**本体を変えずに**次の 4 つを足した:
  1. 本人の確認の後、**POSTONA の利用権（`x_autopost`）と共通アカウントが両方 active** のときだけ進む
  2. 操作の番号（`Idempotency-Key`）で、同じ相談の二重実行を防ぐ（保存の場所 `ai_calls`、#249）
  3. 共通AI基盤（`executeAiRequest`、OpenAI、今と同じモデル・決まり・上限・1 回だけ）で呼ぶ
  4. 費用の台帳で、送る前に枠を確かめ、確定または不明（最大額）で記録する
- 答えの形と、本体の検査（`sanitizeConsultModelOutput`）は今のまま
- 確かめたこと:
  - 偽の部品だけで 9 件 PASS
  - 本物の台帳と保存の場所の DB 定義（ローカルの使い捨ての DB）で 5 件 PASS
  - わざと壊した写し 11 個をすべて検出
- **本番の保証ではない**: 本番の相談には、利用権の確認・二重実行の防止・費用の台帳が今は無い。今回は、つないだときの振る舞いをオフラインで確かめただけ（§5）

## 1. 今の状態（読み取りで確認、main `74b6b7ce`）

| 項目 | 場所 | 状態 |
|---|---|---|
| 相談の流れ | `supabase/functions/social-mobile-consult/logic.ts` の `handleSocialMobileConsult`（:694） | 本人（`/auth/v1/user`）→ 入力の検査 → 持ち主の確認（`brand_memberships` の owner、`brands.code_profile_key`）→ 保存済みの設定 → `callModel` → `sanitizeConsultModelOutput` → 答え |
| モデルを呼ぶ部分 | `callOpenAiConsultModel`（:474）。`ConsultDependencies.callModel`（:95-106）で差し替えられる | OpenAI Responses、`gpt-6-luna`（`socialTextModel("postonaConsult")`）、出力 900、25 秒、送り直しなし |
| 利用権の確認 | 無い | **本番の入口は利用権を見ていない**（F5 の調べと同じ） |
| 二重実行の防止 | 無い | 同じ相談を 2 回送れば 2 回呼ぶ |
| 費用の記録 | 記録に入力・出力のトークン数だけ | 台帳には入らない |
| アプリ | `apps/social-mobile/src/data/consult-client.ts` | `functions.invoke('social-mobile-consult', {body, headers: {Authorization}})`。答えの error のコードを見る |
| 利用権の表 | `public.common_accounts`（`status`）、`public.service_entitlements`（`service_key`, `status`）。利用者は自分の行の決まった列だけ読める（`20261001150000…:341-356`） | 利用者の JWT で読める |
| 共通AI基盤 | `executeAiRequest`（`_shared/ai_provider/execute.ts:160`）、OpenAI の部品は `store:false`・strict な JSON の決まり・`instructions` と 1 つの `input` | OpenAI の相談の形にそのまま合う |
| 台帳の部品 | `SupabaseLedgerBudgetGuard`（`ledger_guard.ts`、`request_id` = callId） | 台帳の本番の適用は G6 の Phase 1f の記録あり。**POSTONA の枠は無い**（今つないでも断られる） |
| 保存の場所 | `ai_calls`（#249、本番には未適用） | 二重実行の防止の DB の候補 |
| H5 bridge | `_shared/ai_consumer_bridge`（#198） | **Claude だけ**（model の方針が Anthropic）。OpenAI の相談には使えない。保存の場所の決まり（`ConsumerCallStore`）と呼び出しの番号の作り方は同じにした（§3） |

## 2. つなぎの部品の流れ（`createConsultSeam`）

1. POST 以外は今の本体へそのまま
2. Bearer が無い → `AUTH_REQUIRED`（401）
3. 本人の確認（`/auth/v1/user`、id は小文字の uuid）。だめなら `AUTH_REQUIRED`
4. `Idempotency-Key` の確認（`^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$`）。無ければ `CONSULT_OPERATION_ID_REQUIRED`（400）
5. 利用者の JWT で `common_accounts?select=status&user_id=eq.<id>` と `service_entitlements?select=status&user_id=eq.<id>&service_key=eq.x_autopost` を読み、**両方 1 行で active** でなければ `CONSULT_NOT_ENTITLED`（403）。読めなければ `ENTITLEMENT_READ_UNAVAILABLE`（503、安全側）
6. 今の本体を呼ぶ（本体が本人・入力・持ち主・保存済みの設定を確かめ、OpenAI の本文を作る）。モデルを呼ぶ部分だけ、F6 のものを渡す:
   - 本体の本文を検査して、共通AI基盤の 1 件の依頼に変える（モデル・`store:false`・出力 900・effort low・決まりが違えば何も送らない）。保存済みの設定と会話は、データとして 1 つの入力にまとめる
   - 呼び出しの番号: `h5m2_` ＋ SHA-256（tenant、`postona.consult`、操作の番号）。tenant ＝ SHA-256（`postona`、主体）。主体は利用者（`brandId: null`）。H5 bridge と同じ作り方
   - 保存の場所で claim:
     - 処理中 → `CONSULT_IN_PROGRESS`（409）
     - 中身違い → `CONSULT_OPERATION_REUSED`（409）
     - 済み → 保存した答えをそのまま返す（送らない）
   - 共通AI基盤で 1 回だけ送る（台帳: 予約 → 送信 → 確定、不明なら最大額）
   - 結果を保存の場所に記録してから返す。記録が失われたら `CONSULT_AI_UNKNOWN`（同じ番号は、復旧まで処理中のまま。送り直さない）
7. 本体の検査（`sanitizeConsultModelOutput`）と答えの形は今のまま

答えの error（新しいコードは太字。保存した失敗は、同じ番号で何度送っても同じ答えなので `retryable: false`）:

| 場面 | コード | HTTP | retryable |
|---|---|---|---|
| ログインしていない・JWT が無効 | `AUTH_REQUIRED`（今と同じ） | 401 | false |
| 操作の番号が無い | **`CONSULT_OPERATION_ID_REQUIRED`** | 400 | false |
| 利用権・共通アカウントが active でない | **`CONSULT_NOT_ENTITLED`** | 403 | false |
| 利用権が読めない | **`ENTITLEMENT_READ_UNAVAILABLE`** | 503 | true |
| 他人のワークスペース | `OWNED_WORKSPACE_NOT_FOUND`（今と同じ） | 404 | false |
| 同じ番号の相談が処理中 | **`CONSULT_IN_PROGRESS`** | 409 | true |
| 同じ番号で別の内容 | **`CONSULT_OPERATION_REUSED`** | 409 | false |
| 利用の上限・枠が無い | **`CONSULT_QUOTA_EXCEEDED`** | 429 | false |
| 送ったが結果が不明（切断・時間切れ・記録の喪失） | **`CONSULT_AI_UNKNOWN`** | 502 | false |
| OpenAI の失敗 | `CONSULT_AI_FAILED` | 502 | false |
| 形の違う答え | `CONSULT_AI_MALFORMED` | 502 | false（本体の検査で弾いたときは今と同じ true） |
| 設定の不備（鍵が無いなど、何も送っていない） | `CONSULT_AI_UNAVAILABLE` | 503 | false |

## 3. H5 bridge（Claude）との関係

- 今回は OpenAI のままで、bridge は使わない（bridge は Claude だけ）。モデルの方針は変えていない
- 保存の場所の決まり（`ConsumerCallStore`）、保存する答えの形（`BridgeResult` と audit）、呼び出しの番号の作り方は bridge と同じにした。後で Claude の経路に移るときも、同じ保存の場所と台帳が使える
- Claude への切り替え・モデルの選択・投稿文・予約の AI は対象外

## 4. 確かめたこと

`supabase/tests/postona_consult_shared_provider_seam_run.sh`（ローカルの socket だけ、TCP なしを確かめる）:

- 偽の部品だけ（`_test.ts`、`--deny-net`、偽の鍵）: **9 PASS**
  - 1 件の相談:
    - 答えが今の本体と同じ形・同じ結果
    - OpenAI への送信は 1 回（`gpt-6-luna`、`store:false`、strict、出力 900、effort low、system の指示は今と同じ）
    - 利用者 ID・ワークスペースの slug・JWT・メール・鍵は OpenAI に送られない
    - 台帳は利用者の `postona / consult` で 1 回の予約と確定
    - 保存の場所は 1 行で、主体に結びつく
    - 記録には相談の文も ID も残らない
  - P0（**OpenAI・台帳・保存の場所のどれにも届かない**）: 15 通り
    - Bearer なし、偽の JWT
    - 番号なし、短い番号
    - 共通アカウントが deleting / locked / 無い
    - POSTONA が ended / deleting / suspended / provisioning / 始めていない
    - 利用権が読めない
    - 他人のワークスペース
    - 知らない項目（user_id を送る）
  - 上限: 送らずに `CONSULT_QUOTA_EXCEEDED`。同じ番号は同じ答え（台帳にもう一度は聞かない）
  - 同じ番号の再送: 同じ答え、送信 1・予約 1。別の利用者の同じ番号は別の呼び出し
  - 同じ番号で別の内容: `CONSULT_OPERATION_REUSED`、送らない
  - 同時の 2 つ: 送信 1、もう片方は `CONSULT_IN_PROGRESS`
  - 送った後の切断: 台帳は最大額、`CONSULT_AI_UNKNOWN`、送り直さない
  - OpenAI の失敗・形の違う答え・決まりには合うが本体の検査で弾く答え: どれも同じ番号では送り直さない
  - 記録の喪失: `CONSULT_AI_UNKNOWN`、その後は `CONSULT_IN_PROGRESS`、送り直さない
- 本物の台帳と保存の場所の DB 定義（`_pg_test.ts`、ローカルの PostgreSQL 17、`SupabaseLedgerBudgetGuard` と `ai_calls` の RPC）: **5 PASS**
  - 1 件の相談:
    - 台帳の予約は `settled`、`request_id` は保存の場所の番号と同じ、使用量は確定の値（1000 / 300）
    - 保存の場所は complete
    - 再送では送らず、予約も増えない
  - 利用者ごとの 1 日 1 回の枠: 2 件目は `CONSULT_QUOTA_EXCEEDED`、予約なし、保存の場所に `BUDGET_DENIED`
  - 枠が無い（無効）: 安全側で `CONSULT_QUOTA_EXCEEDED`、送らない
  - 切断: 台帳は `unknown`・最大額、保存の場所は `UNKNOWN`、送り直さない
- わざと壊した写し（作業用のフォルダだけ）: 11/11 検出
  - 利用権を見ない
  - 番号を見ない
  - 利用権が読めないのに進む
  - 保存した答えを使わない
  - 処理中を無視
  - 中身違いを無視
  - 不明を失敗にする
  - 記録の喪失を飲み込む
  - 上限を「混雑」にする
  - 利用者 ID を OpenAI に送る
  - 保存の場所の機能名の取り違え
- 今の相談の本体のテスト（`logic_test.ts`、変更なし）: 26 PASS

## 5. 本番との違い・NOT_VERIFIED

| 項目 | このオフラインの候補 | 本番の今 |
|---|---|---|
| 利用権の確認 | あり（利用者の JWT で 2 つの表を読む） | なし |
| 二重実行の防止 | 保存の場所（`ai_calls`）の決まりで確認 | なし（`ai_calls` は本番に無い） |
| 費用の台帳 | 本物の台帳の DB 定義で確認 | 相談は台帳を使っていない。POSTONA の枠も無い |
| モデルへの入力 | 保存済みの設定と会話を、データとして 1 つの入力にまとめる | 会話を役割（user / assistant）ごとの入力で送る |

- **入力の形の違い**で、答えの質が変わりうる（有料の品質の確認が要る。別承認）
- NOT_VERIFIED:
  - 本物の OpenAI
  - 本物の Supabase（PostgREST での利用権の 2 つの表の読み取りと列の権限、RLS）
  - アプリでの表示
  - 本番の台帳の行と枠
  - 保存の場所の本番の適用
  - `_shared` 全体の既知の型エラー 5 件・権限で止まる 1 件
- **利用権の確認がつながっていない相談の入口は公開しない**（TASK の決まり）。本物の相談につなぐのは、担当者と安全の確認の後の別の作業

## 6. F1（アプリの画面）への申し送り（そのまま渡せる文）

```text
【F6 → F1】AI 相談の画面の契約（オフラインの候補。本番の相談はまだ変わっていません）
- 送るとき: 今の body（brand_id, message, history）のまま、ヘッダーに Idempotency-Key を足す。
  値は「ユーザーの 1 回の発言ごと」に新しい UUID。通信の失敗でアプリが同じ発言を自動で送り直すときは同じ値。
  ユーザーが「もう一度」を押して新しく送るときは新しい値。
- 新しい error のコード（答えの body の error）と表示の案:
  CONSULT_NOT_ENTITLED（403）… 「POSTONA の利用が有効ではありません」（相談の入力を止める）
  CONSULT_QUOTA_EXCEEDED（429）… 「今日の AI 相談の上限に達しました」（残りの回数を返す API はまだ無い）
  CONSULT_IN_PROGRESS（409）… 「前の相談の答えを待っています」（少し待って同じ値で送り直してよい）
  CONSULT_OPERATION_REUSED（409）… アプリの誤り（同じ値を別の発言に使った）。新しい値で送る
  CONSULT_AI_UNKNOWN（502）… 「答えを受け取れませんでした」。同じ値で送り直しても同じ。新しく送るなら新しい値
  CONSULT_OPERATION_ID_REQUIRED（400）/ ENTITLEMENT_READ_UNAVAILABLE（503）… 「時間をおいて試してください」
- retryable が false の答えは、同じ値で自動で送り直さない。
- 答えの形（success, result, settings_saved など）は今と同じ。
- F1 の画面と TASK は F6 は変えていません。実装するかは F1 の担当のチャットで決めてください。
```

## 7. F5（共通アカウント・利用権）への申し送り（そのまま渡せる文）

```text
【F6 → F5】AI 相談の入口での利用権の確認について（オフラインの候補）
- 今の本番の相談（social-mobile-consult）と試し投稿（social-mobile-brand-dry-run）は、利用権と共通アカウントの状態を見ていません。
- F6 の候補は、相談の前に利用者の JWT で public.common_accounts（status）と public.service_entitlements（x_autopost の status）を読み、
  両方 active のときだけ AI を呼びます（provisioning / suspended / deleting / ended、行が無い、読めない → 止める）。
  使っているのは foundation の migration の「利用者は自分の行の決まった列を読める」権限（20261001150000 の :341-356）だけです。
- F5 に決めてほしいこと:
  1) この 2 つの表を直接読む形でよいか、それとも F5 の RPC（例: 利用者の JWT で呼ぶ「POSTONA の AI を使ってよいか」）に揃えるか。
  2) 削除の途中（common_accounts が deleting）や利用の終了（ended）で、AI の認可が止まることを、削除の手順の読み返し（#264 §3 の前提 B）にどうつなぐか。
  3) 本物の Supabase での列の権限・RLS の確認（F6 はオフラインだけ）。
- F5 のコードと TASK は F6 は変えていません。実装は F5 が今の TASK を終えた後、担当のチャットの許可で別の TASK として。推奨のモデル: Opus5.5（高）。
```

## 8. 次の候補（推奨のモデル）

1. POSTONA の担当: 本物の相談の入口にこの部品をつなぐ（フラグ、既定は今の OpenAI の直接の呼び出し）。前提は F5 の判断・保存の場所の本番の適用・台帳の POSTONA の枠（すべて別承認） — Opus5.5（高）
2. F1: `Idempotency-Key` と新しい error の表示 — Opus5.5（高）
3. F5: 利用権の確認の口と、削除の手順との結びつき — Opus5.5（高）
4. 利用者・運営: 有料の品質の確認（入力の形の違い）、台帳の枠の数字
