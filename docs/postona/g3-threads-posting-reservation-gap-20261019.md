# G3｜POSTONA 投稿・予約の実装ギャップと、Threads 予約の dispatcher の候補（2026-10-19、Issue #318 G3-01）

- task_id: `postona-g3-threads-post-reservation-source-gap-20261019`（Issue #318、TASK 1/50）／返却先 POSTONA G3のちゃ／完了コード K3
- 判定: **SOURCE_ONLY（オフライン・模擬・ネット不許可）**。本番 NO_GO。
- 調べた版:
  - origin/main
  - F3/G3 の積み上げの先頭 PR #301 `abbe63d880b69cd49ec95e560b4cc5aeefedab49`
  - G4 の Threads の積み上げの先頭 PR #263 `a1cc77e4cb3b09b0775a7e60c2c76fecd18f3705`
  - G4 の棚卸し PR #327 `743deee0a9`
- 重複しないこと: G4 の棚卸し（PR #327）が、Threads の OAuth・資格情報・解除・手動投稿・Meta のコールバックを証拠つきで整理済み。ここでは**それを引用**し、G3 の持ち分（投稿・予約・dispatcher・結果）だけを足す。PR #301 の受領票と、PR #287 の owner epoch は作り直していない。

## 1. 分類（✅ 実装あり／🔒 ゲートで停止／🧪 ローカルで試験済み／✖ 無い／❔ 本番 NOT_VERIFIED）

**main にあるのは Threads の `threads_connect_contract.ts`（型）だけ。** POSTONA の投稿・予約のコードは、X も Threads もすべて未マージの Draft PR の中にある。

| 項目 | X | Threads | 持ち主 |
|---|---|---|---|
| OAuth の接続・アカウントの結び付け | ✅🔒🧪❔ PR #257（T13 のガード）ほか | ✅🔒🧪❔ PR #124→…→#251・#260（PR #327 §2） | G4（G5 の owner fence） |
| トークンの延長 | ✅（候補）G4 | 🔒 PR #255・#258・#263。**✖ store と scheduler**（PR #327 T3） | G4 |
| 解除・退会の後片付け | ✅（候補）PR #189・#204 | ✅🔒🧪❔ PR #167・#169・#180。**✖ Meta のコールバック**（PR #327 T1・T2） | G4／G5 |
| 資格情報（世代つき・1 回の取得） | ✅（候補）G4 PR #282 `credentialFor` → `{token, generation}`、F3 PR #278 の世代 | ✖（Threads の世代の関数も `credentialFor` も無い） | G4（取得口）／G3（世代の関数） |
| 単発投稿（サーバー） | ✅🔒🧪 PR #272・#278（直前の確認・世代・after_freeze） | ✅🔒🧪❔ G4 の手動投稿 PR #140・#144（2 段階投稿 → 読み戻し、台帳） | X は G3、Threads の手動は G4 |
| 予約の作成・一覧・取消 | ✅🔒🧪 PR #145・#163・#168（`postona_x_resv`、**platform は x だけ**） | **✖** | G3 |
| 予約の dispatcher（worker） | ✅🔒🧪 PR #224（`worker.ts`、`postona-x-reservation-worker`） | **✖ → 今回の候補 `threads_dispatch.ts`（オフライン）** | G3（送信の口は G4） |
| 結果・受領票・不明な結果 | ✅ PR #278（readback・after_freeze）、PR #301（本文なしの受領票は**提案**） | 手動の投稿の中だけ（G4 の台帳）。予約側は ✖ | G3（予約）／G4（手動） |
| 停止・利用権・所有者のゲート | ✅🔒🧪 T13・ブランド状態・所有者・スイッチ（PR #182・#262・#278） | ✅（手動・接続の writer のみ、PR #169）。予約側は ✖ | G5（判断）／G3（使う側） |

- 実行の確認: 🧪 は各 PR のローカル試験（PG17・Deno）による。今回再実行したのは §5 のものだけ。

## 2. 境界（G4 へ 1 回だけ通知した内容）

| 持ち主 | 持つもの | 今回の IF |
|---|---|---|
| **G3** | 投稿・予約の表と関数（`postona_x_resv` とその一般化）、dispatcher（worker）、結果・受領票、資格情報の世代の関数 | `threads_dispatch.ts` の `ThreadsDispatchStore`（予約表の口）と dispatcher 本体 |
| **G4** | Provider・Surface・OAuth・アカウント・資格情報・Threads の通信（2 段階投稿） | `ThreadsCredentialPort.credentialFor(account) → {socialAccountId, threadsUserId, accessToken, generation} \| null`（1 回の取得）と、`ThreadsSendPort.send(credential, text) → ThreadsSendOutcome`（`transport` 付き） |
| **G5** | 共通 ID・Auth・利用権・凍結・所有者 | 予約側の直前確認で使う判断（T13、ブランド状態、所有者）。**Threads の投稿に使う service key**（今は `kabumori`／`x_autopost` だけ）の決定 |

- G4 の `threads_publish_contract.ts` の `ThreadsPublishError(code, outcome: not_written | unknown)` は、G3 の `ThreadsSendOutcome` にそのまま写せる形にした。
  - 段階: container → `container`、publish → `publish`、読み戻し → `readback`。
  - `not_written` → `not_written`、`unknown` → `unknown`。

## 3. 今回の候補（G3 だけ、新しいファイル、オフライン）

- `supabase/functions/_shared/postona_reservations/threads_dispatch.ts`。`THREADS_DISPATCH_ENABLED = false`、どこにもつないでいない。
- 1 件の送り方は、X の worker・単発投稿と同じ規則:
  1. Threads の行で、資格情報の口座が行の口座と同じであること。ほかの provider・口座の行は送らずに戻す。
  2. 資格情報と世代は **1 回の `credentialFor`** で受け取る。トークンだけの取得口は「未接続」。
  3. **直前の確認（preflight）が最後**。リース、所有者・作業場所・利用権・スイッチ・凍結・停止、結び付けた世代を確かめる。preflight の世代が資格情報の世代と一致しなければ送らない。
  4. 送信は 1 回だけ。結果の読み方:

     | G4 の送信口の結果 | 記録 |
     |---|---|
     | container 段階で書かれていない、または不明 | `failed_before_send`。container の ID を持たないので、公開されることはない（G4 の重複防止の規則） |
     | publish 段階で書かれていない | `failed_before_send` |
     | publish 段階で不明 | `uncertain`（再送しない） |
     | 公開済みだが、読み戻しが不明・不一致 | `uncertain` |
     | 読み戻しで確認できた | `published`（media id） |

  5. 送信手段（`threads`／`simulated`）とともに記録する。記録できた結果だけを数え、送ったかもしれない行は戻さない。
- 同じ実行で同じ行が 2 回来ても、送るのは 1 回。停止の合図・preflight が読めない・リースが送信前に切れた場合は、送らずに戻す。

## 4. 実際につなぐときに必要な差分（設計の提示だけ。実装していない）

1. **G3（SQL 候補 007、未作成）予約表の provider の一般化**
   - `postona_x_resv.reservations` に `provider text not null default 'x' check (provider in ('x','threads'))` を足す。または `social_accounts.platform` から導く。
   - `assert_account_access` を platform で分ける。Threads は `g4_threads_account_verified`（G4、出荷時は拒否）を使う。
   - `claim_due(worker, lease, limit, provider)` は provider ごとに取る（X の worker が Threads の行を取らない）。
   - `pre_publish_check` に Threads の世代を足した `threads_preflight(reservation, lease) → (verdict, credential_generation)`。
   - `finish` に transport を足した `record`。
   - Threads の世代の関数 `threads_credential_generation(account)`: 口座・作業場所と F5 の所有者・Threads のユーザー ID・Vault の参照先・接続状態・延長の状態（PR #258 のリースと比較交換の世代）。
2. **G4** `ThreadsCredentialPort.credentialFor` の SQL（X の 003 と同じく、判断・トークン・G3 の世代を 1 つの文で返す）と、`ThreadsSendPort`（PR #140・#144 の 2 段階投稿を、予約用に `send` 1 回へ包む）。
3. **G5** Threads の投稿に使う service key（`x_autopost` を流用するか、`threads_autopost` を作るか）と、T13 の対象。予約の preflight は、それを読むだけ。
4. **権限と配備**（別の承認）: worker の役割への関数の付与、Edge・Cron の配備、Meta のアプリの設定。

## 5. テスト（このブランチで実行したもの）

- `threads_dispatch_test.ts`: **13 件合格**（ネット不許可、`fetch` の呼び出し 0 回）。
  - 予約表は、メモリ上の模擬（リースの比較交換、所有者・作業場所・凍結・スイッチ・停止のゲート、取得時の世代の結び付け）。
  - G4 の 2 つの口は模擬。
  - 見たこと:
    - 既定 OFF
    - 正常系
    - 結果が出た行は再送しない
    - 同じ行の重複は 1 回だけ送る（壊れた予約表でも同じ）
    - 2 つの worker が同時に動いても 1 回ずつ
    - 他人・他の口座・他の作業場所・X の行は送らない
    - 停止・スイッチ OFF・凍結・利用終了（資格情報を取った後でも）は送信 0
    - 世代の変更・古い世代・形の崩れた世代（双方一致を含む）は送信 0
    - 2 段階投稿の各結果の読み方
    - 送信手段の記録
    - 記録の喪失とリース切れは `uncertain`
    - 送らずに戻す 3 つの場合
    - 報告にトークンも本文も入らない
- 変異テスト: `threads_dispatch.ts` に 20 個。すべて検出した。最初は 3 個が生き残ったため、テストを 3 つ足した。
- 既存の F3/G3 の Deno の回帰は Report を参照。PostgreSQL のランナーと G4 の Threads の試験は、今回は実行していない（NOT_VERIFIED）。

## 6. 最短の順番（小さな TASK の候補）

1. **G3-02**: SQL 候補 007（§4-1）と PG17 の負例テスト。worker 役割の付与は設計だけ。依存: G5 の service key の決定（§4-3）。
2. **G4（PR #327 の T3 と並行）**: Threads の `credentialFor` と送信口を、§2 の IF で用意する。
3. **G3-03**: `threads_dispatch.ts` を予約表の本物の口（007 の関数）につなぎ、PG17 の E2E（模擬の Threads）を通す。
4. 本物の Threads への投稿、Meta のアプリの設定、配備は、ユーザーの明示の承認の後。
