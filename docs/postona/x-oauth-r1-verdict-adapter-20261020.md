# G4-06：X の OAuth の G5 R1 判定の adapter（offline）と、閉じる側の負例（2026-10-20 JST）

- task_id: `postona-g4-x-oauth-r1-verdict-adapter-offline-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_ADAPTER（接続していない）**。本物の OAuth／DB／Auth／本番は NOT_VERIFIED、PRODUCTION_NO_GO。Codex Sol（高）の限定レビューの前。
- 土台: PR #353（G4-05、head `4d42b5c7a511831151bd98a34e473866dea43173`）の上。
- **PR #353 と同じく、マージ・配備はしない。**
  - PR #353 の `index.ts` は、今も `authorization: null`。配備すれば X の接続は閉じる（止まる）。
  - この adapter をつないでも、下の §3 のとおり begin は通らない。

## 1. R1 の wire（G5-03 PR #351 `59d3dff0` の SQL から。暫定の候補）
`public.common_account_authorization_verdict(p_app, p_feature, p_brand_id) -> jsonb`（呼び手の JWT、`authenticated` だけ）

- 8つのキー:

  | キー | 中身 |
  |---|---|
  | `v` | 1 |
  | `decision` | `allow`／`deny`／`unknown`／`pending` |
  | `reason` | allow のとき null、それ以外は固定のコード |
  | `scope` | `{app, feature, brand_slug}` |
  | `subject` | `{kind:"user", user_id}` か `{kind:"system"}` |
  | `session` | `{state, ref:"s:"+32桁}` か null |
  | `owner_epoch` | `"g5oe:<epoch>:<lifecycle_version>"` か null |
  | `entitlements` | `["postona:x_autopost"]` か `[]` |

- HTTP の分類は G5-02 §3.8 のとおり:
  - 401／403 は deny
  - 404・その他の 200 以外・形の違いは unknown
  - 通信の失敗は unavailable
- H1 の PR #351 のレビュー（Issue #306、CHANGES_REQUIRED P2×1）は W1／W2 のサービスの再開の判定についてで、R1 の wire の変更は求めていない。
- ただし G5 の最終的な受理の前なので、wire が変われば **次の K4 で、この adapter の差分の反映が必要**。

## 2. adapter（`supabase/functions/x-oauth-connect-user/r1_authorization.ts`）
- **`decodeR1Answer`**: allow になるのは、次のすべてを満たすときだけ。
  - ちょうど8つのキー、`v=1`
  - scope が `postona`／`x_connect`／尋ねたブランド
  - subject がこの本人
  - reason が null
  - session が active で ref の形
  - entitlements がちょうど `["postona:x_autopost"]`
  - `owner_epoch` の符号が正しい
- それ以外の扱い:
  - この本人についての deny は deny（上流で 403）。
  - 誰でもない deny、pending、unknown、形の違いは unknown（上流で 503）。
- **owner epoch**:
  - 文字列の符号 `g5oe:` に、先頭が0でない10進を2つ。
  - 両方を BigInt で `9223372036854775807` 以下か確かめる。
  - JS の数値には変換しない（2^53 を超えても正確）。
  - JSON の数値・桁あふれ・形の違いは unknown。
  - G4-05 の口には、epoch の10進の文字列を渡す。
- **`createXConnectR1AuthorizationPort`**（G4-05 の `XConnectAuthorizationPort`）:
  - 交換の直前（`pre_exchange`）に、呼ぶたびに R1 へ `{p_app:"postona", p_feature:"x_connect", p_brand_id}` と呼び手の JWT で尋ねる（キャッシュなし）。
  - 通信の失敗・時間切れ（既定3秒）は throw（上流で 503 unavailable）。
  - ブランドや本人の ID の形が悪ければ、R1 に尋ねず unknown。
- **本物の R1 の通信（PostgREST の client）は書いていない・注入していない**。`index.ts` もこの adapter を import していない（テストで固定）。

## 3. G5 の判断が要る不足（Issue #320 に1回だけ通知: コメント 6279536652）
- R1 は `p_brand_id` が必須（無いと `BRAND_REQUIRED`）。
- 一方、X の begin は本人の個人用のワークスペースを**その場で作る**ので、初めての接続では begin の前にブランドが無い。
- このため、adapter は begin の段階では R1 を呼ばずに unknown を返す。**R1 をつないでも X の接続は始められない**（閉じる側）。
- G5 への選択肢:
  1. connect 系の feature に、ブランドなしの本人の判定を足す。
  2. まだ無いワークスペースを名指しで判定できるようにする。
- G4 は、ユーザー ID からワークスペースの ID を導く SQL（`'u_' || md5(uid) の先頭24桁`）を TS で再実装していない（G5 が決めていない値を作らないため）。

## 4. テスト（実測）
| 実行したもの | 結果 |
|---|---|
| `x-oauth-connect-user/` 全体（型チェックあり、`--allow-read=.` だけ、ネット・env なし） | **54 passed／0 failed**（PR #353 の 39＋新しい 15） |
| `deno check` | エラー0 |
| `deno lint`（フォルダ） | 21件で、PR #353 と同じ（新しいファイルの指摘は0） |
| ミューテーション（adapter に 25種） | **24/25 を検出** |

- 検出しなかった1件 `begin_asks_r1` は等価な変異。begin の早期の打ち切りを外しても、ブランドが null なので次の確認で同じく R1 を呼ばずに unknown を返す（二重の守り）。
- 偽の R1・偽の Supabase・偽の X での流れ（成功の場合と拒否の場合を分けた）:
  - **成功**: 交換の直前に新しい allow を1回取り、交換1回。
  - **拒否（X の交換0）**: deny（退会の途中・session の期限切れ）、401、unknown、別の本人、別のブランド、epoch の欠落・桁あふれ・数値、404、500（生の SQL エラーの文）、通信の失敗、時間切れ。
  - **再送**: 2回目の callback は R1 に再び尋ね、deny なら交換0。
  - **悪い redirect**: R1 と RPC の前に拒否。
  - **begin**: R1 0回、begin の RPC 0回で拒否。
- NOT_VERIFIED: 本物の R1（PostgREST・JWT・`auth.uid()`）、本物の X、管理環境、本番。

## 5. 行っていないこと
- `index.ts` への接続（`authorization: null` のまま）、ゲートを開くこと
- 本物の R1 の client・トークン・通信
- SECURITY DEFINER／Auth／GRANT／SQL／trigger／begin の epoch の保存
- main への push、マージ、デプロイ
- G5・G3・H1 のファイル・Issue 本文の変更
