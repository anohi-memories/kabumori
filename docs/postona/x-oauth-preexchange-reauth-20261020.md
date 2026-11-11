# G4-05：X の OAuth の認可の順序・エラーの秘匿・redirect の境界の限定修正（2026-10-20 JST）

- task_id: `postona-g4-x-oauth-preexchange-reauth-security-offline-20261019`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_FIX_CANDIDATE**。
  - 本番への影響と、P1 かどうかは判定していない。
  - Codex Sol（高）の限定レビューの前。PRODUCTION_NO_GO。
- 土台: main `9802f59017cf228b6868d2bc9c9ee99500053c4f`。対象は G4 の `supabase/functions/x-oauth-connect-user/` だけ。未マージの PR でこのフォルダを触るものは無かった。
- きっかけ: G5 の通知（Issue #319 コメント 6267736897、G5-02 PR #344 `3a900d54`）。

## 1. 修正前に確かめたこと（main のコードと、合成のテストでの再現）

| # | G5 の指摘 | main での事実 | 修正前の反例 |
|---|---|---|---|
| ① | コードの交換が owner の再確認より前 | `completeConnection` の順は、consume（読むだけ。開始した人・未使用・期限だけを見る）→ X のコードの交換 → X の本人の読み取り → complete（ここで初めて owner を再確認し、1回限りの消費）。G5 の指す `oauth_logic.ts:271` の交換は `:279` の complete より前 | 所有者でなくなった人の callback は、**交換と本人の読み取りを済ませた後**に、complete の `SOCIAL_MOBILE_ACCOUNT_NOT_OWNED` で拒否された |
| ② | DB のエラー文がクライアントへ | `rpcAsUser` は、DB のエラーの `message` をそのまま拒否のコードにし、`index.ts` がそれを返す。X の失敗は `X_TOKEN_EXCHANGE_FAILED:<HTTP の番号>` | 制約の名前と行の ID を含む DB の文が、そのまま返った。X の失敗は `X_TOKEN_EXCHANGE_FAILED:400` |
| ③ | redirect_uri のサーバー側の許可リストが無い | begin は、受け取った `redirect_uri` をそのまま保存し、X の認可 URL にも入れる。callback は「保存した値と同じか」だけを見る | 任意の値が通った。X 側の登録の照合だけが頼り |
| ④ | 退会の途中でも begin できる | X の begin／consume／complete の SQL は `common_accounts`・利用権を見ない（2つの migration に T13 の guard が無い） | begin の前に、本人の判定が1つも無かった |

- 修正前の反例のテスト（`oauth_security_test.ts` の10件）は、main のコードで **9件が失敗、1件が合格**した。
  - 合格した1件は「期限切れ・使用済みの state は交換の前に拒否」で、もともと正しい動き。
- 影響の評価（断定はしない）:
  - ① で交換したトークンは、complete が拒否すれば保存されない。
  - ただし、X 側には認可が残り、トークンは Edge のメモリに一時的に存在する。
  - 認可コードは使い切られる。

## 2. 修正（`oauth_logic.ts`・`index.ts`）
1. **交換の直前に再認可**（`requireAuthorization`、phase `pre_exchange`）:
   - consume と redirect の照合の後、X に何か送る前に、G5 の判定の口に (本人, state のワークスペース) を尋ねる。
   - 交換に進めるのは、`allow` で、本人・ワークスペースが一致し、owner epoch が分かるとき（10進の文字列か安全な整数。0 は epoch ではない）だけ。
   - それ以外は拒否する: `deny` は 403 `X_CONNECT_NOT_AUTHORIZED`、不明・形の違い・別の対象は 503 `X_CONNECT_AUTHORIZATION_UNKNOWN`、口が無い・失敗は 503 `X_CONNECT_AUTHORIZATION_UNAVAILABLE`。
   - 判定は callback のたびに取り直す（キャッシュしない）。
2. **固定のコードだけ**:
   - DB のエラーは、3つの RPC 自身が出す8つのコード（`X_CONNECT_RPC_ERROR_CODES`）だけをそのまま返す。それ以外は `SOCIAL_MOBILE_OAUTH_DB_CALL_FAILED`。
   - X の失敗は `X_TOKEN_EXCHANGE_FAILED`／`X_IDENTITY_READ_FAILED`（番号・本文なし）。
   - アプリはこれらのコードで表示を分けていない（DB の列の値で分けている）ので、壊れない。
3. **redirect は登録値だけ、完全一致**:
   - `X_CONNECT_REGISTERED_REDIRECT_URIS = {"kabumori-social://oauth-callback"}`（アプリの `use-x-connect.ts` が固定している値）。
   - 正規化しない（大文字小文字・末尾の `/`・query・fragment・前後の空白は不一致）。
   - begin と callback の両方で、RPC・判定・通信の前に確かめる（`OAUTH_REDIRECT_URI_NOT_ALLOWED`）。
4. **begin の前に本人の判定**（phase `begin`、ワークスペースはまだ無いので null）:
   - 退会の途中・サービスの終了・凍結などで `deny` なら、begin の RPC を呼ばない。
5. **口の形**（`XConnectAuthorizationPort`）:
   - G5 の R1（`common_account_authorization_verdict`、feature `x_connect`）の wire が確定していないので、正規化した形 `{decision, subjectUserId, brandId, ownerEpoch}` だけを受ける。
   - R1 の wire からこの形への変換は、R1 ができたときの小さな adapter（G4）。
6. **`index.ts` は口を渡さない（`authorization: null`）**:
   - R1 が無いので、**このまま配備すると X の接続は止まる**（begin も callback も 503）。
   - 「開いたまま」にはしていない（optional-open は禁止）。
   - マージ・配備は、R1 の実装と接続、Sol のレビュー、ユーザーの承認の後。

## 3. 閉じていないこと（正直に）
- **begin と交換の間の A→B→A**:
  - begin のときの owner epoch を、state の行に保存する場所が無い（`social_account_oauth_states` に列が無い。schema の変更 = 別の TASK）。
  - そのため、begin から callback の間に所有者が A→B→A と戻った場合は、A のままと区別できない。
  - 交換の直前の判定で「今の owner が A、epoch が分かる」ことは確かめる。state の寿命（10分）が上限。
- SQL の側（begin／consume／complete）に T13 の guard や利用権の確認を入れるのは、G4 の migration と G5 の guard の工程（今回は DB を変えていない）。
- R1・W1・W2 の本物の実装は G5（G5-02 の次の TASK）。

## 4. テスト（実測）
| 実行したもの | 結果 |
|---|---|
| main のまま、`x-oauth-connect-user/` のテスト | 29 passed |
| 反例 `oauth_security_test.ts` を main のコードで（一時的なコピー、`--no-check`） | **9 failed／1 passed**（修正前の失敗を確認） |
| 修正後、`x-oauth-connect-user/` 全体（型チェックあり、`--allow-read=.` だけ） | **39 passed／0 failed**（既存 29＋新しい 10） |
| `deno check`（index・2つのテスト） | エラー0 |
| `deno lint`（フォルダ） | 21件。main と同じ数・同じ規則（require-await 20、no-unused-vars 1）で、新しい指摘は0 |
| ミューテーション（19種） | **19/19 を検出** |

- 既存のテスト（`oauth_logic_test.ts`）の変更:
  - 呼び出しに本人と「許可する口」を渡した。
  - 戻り先の値を登録値にした。
  - X の失敗のコードから番号を外した。
  - 戻り先の不一致のテストは、送る側を登録値にして、意図（保存した値と違えば交換0）を保った。
- 外への通信0回（偽の Supabase・偽の X だけ）。本物の X のコードの交換・DB の書き込み・投稿なし。
- NOT_RUN: 本物の Auth／PostgREST／X、管理環境、本番、アプリの node のテスト（アプリは変えていない）。

## 5. 行っていないこと
- DB・RLS・Auth・RPC・SECURITY DEFINER・migration の変更や適用
- 本物の X の OAuth・トークン・投稿
- ゲートを開くこと
- main への push、マージ、デプロイ
- G5・G3・H5 のファイル、Threads の PR #341／#347 の変更
