# G2 第10世代 — PR #366 下書きのセッション識別・Authイベント境界のオフラインQA（QA専用）

- Issue #317 TASK `postona-g2-pr366-auth-session-marker-event-offline-qa-20261020`
- 対象: G1 PR #366 HEAD `44ab2e6bb812f3484c85f847574de103757e3dfc`（base #346 `c71f2a1f59d3b1eb72447a73b602adf51639c691`）。G1/G5 のソースは読み取りのみ。
- 使用 SDK: `@supabase/supabase-js` / `@supabase/auth-js` **2.115.0**（`apps/social-mobile/package-lock.json` と一致するものを読んだ）
- 実 Supabase Auth・実ユーザー・実トークンは使っていない。Auth の動きは**テスト内の模擬（MOCK）**。PR #376 の Simulator 操作は繰り返していない。
- テスト: `apps/social-mobile/tests/g2-draft-session-boundary.test.mjs`（G2 専用の新規ファイル）。本物の画面 `src/app/manual-publish.tsx`（トランスパイル）と本物の draft store を、模擬のセッション列で動かす。

## 1. 証拠表：SDK の契約／アプリのソース／仮定

| # | 事実・仮定 | 根拠 | 区分 |
|---|---|---|---|
| E1 | `last_sign_in_at` は `User`（人ごと）の**省略可能**な項目。`Session` の項目ではない | auth-js `lib/types.d.ts` 387（`interface User`）・405（`last_sign_in_at?: string`） | SDK 契約（型） |
| E2 | アクセストークンの必須 claim に `session_id`（セッションごと）がある | 同 1660–1668 `RequiredClaims`（`session_id: string`）、`getClaims()` あり | SDK 契約（型） |
| E3 | トークン更新は `/token?grant_type=refresh_token` の応答をそのまま session にし、その `user` を使う。発火は `TOKEN_REFRESHED` | `GoTrueClient.js` 4000–4030、4266、`lib/fetch.js` 135–147 `_sessionResponse` | SDK 実装 |
| E4 | 起動時、期限内の保存済みセッションは**保存時の user のまま** `SIGNED_IN` で通知。期限切れなら更新して `TOKEN_REFRESHED` | `GoTrueClient.js` 4063–4150 `_recoverAndRefresh` | SDK 実装 |
| E5 | サインイン系はすべて `SIGNED_IN`。既にログイン中でも `SIGNED_OUT` を挟まない | `GoTrueClient.js` の各 `_notifyAllSubscribers('SIGNED_IN', …)`。`SIGNED_OUT` は `_removeSession`（4405 付近）だけで、呼ぶのは `__loadSession`・`_getUser`・`_signOut`・`_recoverAndRefresh`・`_callRefreshToken` の失敗/サインアウト経路のみ | SDK 実装 |
| E6 | アプリはどのイベントでも session をそのまま反映（イベント種別では区別しない） | `src/providers/auth-provider.tsx` 132–143 | アプリ |
| E7 | 下書きの印は `session?.user.last_sign_in_at ?? ''`。画面は**ユーザーIDだけ**をキーに作り直す | `src/app/manual-publish.tsx` 末尾（route） | アプリ（#366） |
| E8 | 印の比較は文字列の一致だけ。空文字も有効な印として保存・比較される | `manual-publish-draft-store.ts` 67・132 | アプリ（#366） |
| E9 | 期限（24時間）は**読み込むときだけ**判定。ログアウトで下書きを消す処理はない | 同 129–131、`draftStore` の使用は画面だけ | アプリ（#366） |
| A1 | サーバーは新しいサインインのたびに（どの端末でも）`last_sign_in_at` を更新し、トークン更新では変えない | — | **仮定・NOT_VERIFIED**（実 Auth 不可） |
| A2 | `session_id` はトークン更新で変わらず、サインインごとに新しくなる | 型の名前と配置からの推測 | **仮定・NOT_VERIFIED** |

#366 の既存テスト「the route passes the sign-in session mark (a re-login changes it, a token refresh does not)」は、値の受け渡しを確かめているだけで、括弧内（A1）は確かめていない。

## 2. 結果（本物の画面 × 模擬セッション列）

| ID | 組合せ | 結果 |
|---|---|---|
| G2-S1 | トークン更新だけ（MOCK: 印が同じ） | 本文・アカウントとも復元。PASS |
| G2-S2 | SIGNED_OUT → 同じ人が SIGNED_IN（新しい印） | 復元せず、記録も削除。PASS |
| G2-S3 | 画面を閉じた状態で SIGNED_OUT なしの再 SIGNED_IN | 同上。PASS |
| G2-S4 | 画面を開いたまま別の人が SIGNED_IN | 画面は作り直され、A の本文は B に見えず、B のキーにも書かれない。A の記録は残る。PASS |
| G2-S5 | 再起動（保存済みセッションの復元、user は保存時のまま） | 復元。PASS |
| G2-S6 | ABA：復元の読み込みが遅れて返る間に、同じ人が新しくサインイン | 古い答えは捨てられ、記録も削除。PASS |
| G2-S7 | ABA：同じく、別の人へ切替／サインアウト | 何も表示しない、B に書かない。PASS |
| G2-S8 | 印が文字列でない・65文字以上 | 同じセッションでも復元しない（安全側）。PASS |
| G2-SM1 | 印が**無い**（undefined / null / ''） | **新しいセッションでも復元される**（FINDING、下記） |
| G2-SM2 | 同じ人が**別の端末**でサインイン → この端末のトークン更新 or 期限切れ後の再起動（MOCK: A1） | この端末はログインしたままなのに下書きが消える（FINDING、消しすぎ） |
| G2-SM3 | 画面を開いたまま、同じ人が SIGNED_OUT なしで新しくサインイン | 開いている本文は残り、次の1文字で**新しい印**で保存され、次回も復元（FINDING） |
| G2-SM4 | A がサインアウト → B が使う → 48時間後 | A の本文は端末に平文のまま残る（FINDING） |

### 負例コントロール（同じシナリオを、壊したコードで動かす）
4つすべてで、正しいコードでは起きない漏れがそのまま再現した（＝テストが検出できる）。
- route のユーザーキーをやめる → B に A の本文が表示される（S4）
- 印を定数にする → 再ログインで古い下書きが戻る（S2）
- 復元の `cancelled` 確認を外す → 古いセッションの遅い答えが勝つ（S6）
- store が印を比べない（一時ファイルに書き換えた store を import）→ 再ログインで戻る（S2）

## 3. FINDING（再現・影響・期待）— いずれも P3、情報漏洩の STOP 条件には当たらない

**G2-SM1（owner G1 route、印の供給は G5）** 印が無いと `''` になり、空文字どうしが一致する。
- 再現: `last_sign_in_at` の無いセッションで入力 → サインアウト → 同じ人が再サインイン（やはり印なし）→ 開く → 復元される。
- 影響: 同じ人の別セッションに限る（キーは人ごと）。「ログインし直すと復元されません」が守られない。実際に印が欠けるかは NOT_VERIFIED（型は省略可能）。
- 期待: 印が無い・不正なときは**保存も復元もしない**（fail-closed）。

**G2-SM2（owner G5 で印の選定、G1 で採用）** `last_sign_in_at` は人ごとの値なので、別端末のサインインがこの端末の印を変える（MOCK の A1 が正しい場合）。
- 影響: 消しすぎ（安全側）。「必要以上に消えない」に反する。
- 期待: セッションごとの値（E2 の `session_id` など）を印にする。

**G2-SM3（owner G1）** 画面のキーがユーザーIDだけなので、SIGNED_OUT を挟まない同じ人の再サインイン（E5）では画面が作り直されず、表示中の本文が新しいセッションへ持ち越されて保存される。
- 影響: 同じ人、表示中の本文に限る。
- 期待: 印が変わったら画面を作り直す（キーに印も含める）、または表示中の下書きと記録を消す。

**G2-SM4（owner G1 文言・画面、G5 サインアウト処理）** サインアウトしても下書きは端末に残り、24時間の判定は同じ人がまた読み込むまで行われない。
- 影響: 共有端末に、サインアウト後も本文が平文で残る（他の人の画面には出ない）。画面の「最大24時間まで保存」と実際が合わない。
- 期待: サインアウト・アカウント削除時に下書きを消す、起動時に期限切れを掃除する、または文言を実際に合わせる。

## 4. `sessionMark` の要件（G5/G1 への提案。実装はしていない）

1. **セッションごと**で、トークン更新では変わらず、サインインのたびに変わる値を使う。候補は access token の `session_id` claim（E2）。端末内の比較用なので、保存するなら hash 化も可。実サーバーで A2 が成り立つかは G5 で要確認。
2. 印が無い・型や長さが不正なら、**保存も復元もしない**（`?? ''` をやめる）。
3. 印が変わったら、同じ人でも画面を作り直すか、下書きを捨てる。
4. SIGNED_OUT・アカウント削除で、その人の下書きを消す。
5. A1/A2 の実確認は、G5 の使い捨て Supabase（本番以外）で、トークン更新と再サインインの前後の `last_sign_in_at` と `session_id` を比べる手順を推奨。

## 5. 範囲外の観察（未分類）
- `AuthProvider` は起動時の `getSession()` の結果と `onAuthStateChange` の両方で session を設定し、古い結果が後から上書きしないようにする確認は持たない。SDK 側のロックの順序で実際には起きにくいと読めるが NOT_VERIFIED（#366 以前からの実装、owner G5）。

## 実行
```bash
cd apps/social-mobile && node --test tests/g2-draft-session-boundary.test.mjs
```
`run.log`（13 件）、`suite.log`（全スイート 504 件 = 既存 491 + 本ファイル 13）。
