# G4-20：X の接続のサーバー側の本人・セッションの境界（読み取りの監査と、試験・レビューの受け入れの条件）（2026-10-22 JST）

- task_id: `postona-g4-x-oauth-server-session-revalidation-contract-audit-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **READ_ONLY_AUDIT／PRODUCTION_NO_GO**。コード・SQL・権限・秘密・本番の設定は変えていない。本物の OAuth や Auth も使っていない。
- 読んだもの:
  - main `0c42933ca5030ab31a56267529430d0473d9b155` の `supabase/functions/x-oauth-connect-user/`（`index.ts`・`oauth_logic.ts`）と migration `20260919120000`・`20260922003101`
  - PR #426 `03968e5cab5e5bc462fe585d1a72b81c81e43657`（アプリの3つの確認）
  - PR #353 `4d42b5c7a511831151bd98a34e473866dea43173`、PR #355 `155b1181ba7d6f39252de08bf63e54d7ae347f46`
  - G2 PR #419 `1ffd1b20f195d07fcc1b4beda3ea0f271c63aef3`
  - アプリが固定している `@supabase/auth-js` 2.115.0 のソース

根拠の印: **[S]** ソースの本文（ファイル:行）／**[K]** SDK のソースとコメント（サーバーの動きの間接の根拠）／**[U]** 未確認。

## 1. サーバー側の流れ（今の main）
1. **入口**（`index.ts:31-38`）: `Authorization: Bearer <ユーザーの JWT>` が無ければ 401。`resolveConnectingUser`（`oauth_logic.ts:38-70`）が、`/auth/v1/user` に**一度だけ**問い合わせる。応答が ok でなければ 401。
   - 返ってきた user id は、**その後どこにも使われない**（`index.ts:38` で捨てている）。本人の判断は、同じ JWT を PostgREST に渡したときの `auth.uid()` に任せている [S]。
2. **start**: `begin_social_mobile_x_oauth_connection`（authenticated に EXECUTE。`20260922003101` で再定義、`:77-79` で付与）[S]。state のハッシュと `initiated_by_user_id = auth.uid()` を保存する。
3. **callback**（`oauth_logic.ts:239-297`）:
   - `consume_social_mobile_x_oauth_state`（`20260919120000:167-192`、読み取りだけ）: `initiated_by_user_id = auth.uid()`、未使用、期限内でなければ `OAUTH_STATE_NOT_CONSUMABLE`。
   - redirect の一致を確かめる。
   - **X とコードを交換**（`:271`、取り消せない）→ X の本人情報を読む。
   - `complete_social_mobile_x_oauth_connection`（`:203-288`）: `initiated_by_user_id = auth.uid()` で state を1文で消費 → workspace の owner であることを確かめる → Vault に保存 → 行を `identity_verified` にする。
4. **PostgREST の `auth.uid()`** は、JWT の署名と期限だけで決まる。**セッションがまだあるか（ログアウトされていないか）は見ない**（Supabase の一般の仕組み）[U：この環境では未実測]。
5. **`/auth/v1/user`** は、JWT の `session_id` に対応するセッションが無いと `session_not_found` を返す。auth-js のコメントでは「ふつうはログアウト・削除・終了」[K]（`auth-js/dist/main/lib/fetch.js:82-86`）。本物の Auth での実測は [U]。
6. **アプリのログアウト**は、既定で `signOut()`＝global（`auth-provider.tsx:347`）。サーバーに `/logout?scope=global` を送り、その人のすべてのセッションを消す [K]（`GoTrueClient.ts` `_signOut`）。サーバーへの送信が通信のエラーで失敗したときは、端末のセッションだけを消してエラーを返す。このとき、**サーバーのセッションは残る** [K]。

## 2. 場面ごとの責任の境界
| 場面 | アプリ（PR #426） | サーバー（main） | 誤った人への結び付け |
|---|---|---|---|
| 待機中に B がログインし、アプリが B の JWT を送った | 交換の直前で止まる（そもそも送らない） | consume が `initiated_by ≠ B` で拒否する。交換は起きない [S] | 起きない |
| 待機中に B がログインし、古いアプリが A の JWT を送った（修正前） | PR #426 で止まる | A のサーバーのセッションが生きていれば `/user` は通り、**A 自身のワークスペース**に結び付く（正しい人）。応答の handle が B の画面に出ていたのが G2-CB5 で、アプリ側の表示の問題 | 起きない（A のもの） |
| A がログアウト（global）した後に、A の JWT で callback | 交換の直前で止まる | `/user` が `session_not_found` → 401 で、consume も交換も起きない [K]／[U] | 起きない |
| **`/user` の確認の後、complete の前に A がログアウト**（X との交換と本人情報の読み取りの数秒） | アプリの確認は送る前なので、ここは覆えない | PostgREST はセッションを見ないので、**complete が成功する** [S]＋[U] | 起きない（A のもの）。ただし「ログアウト後に接続が完了する」 |
| ログアウトが通信のエラーで失敗し、サーバーのセッションが残った後に、A の JWT が送られた | 端末のセッションが無いので止まる | `/user` も通り、受け付ける | 起きない（A のもの） |
| A→B→A（同じ A の新しいセッション） | 止まる（セッション ID が違う） | **受け付ける**。state は人に結び付いていて、セッションには結び付いていない [S] | 起きない（A のもの） |
| 同じセッションの token の更新 | 続く | 受け付ける | — |
| 同じ state の callback が2つ同時に来た | 二度押しは1つだけ | consume は両方通る。X のコードは1回限りなので、2つ目の交換は X が拒否する見込み [U]。complete の1文の消費で、勝つのは多くても1つ [S] | 起きない |
| **Edge を通さず PostgREST で complete を直接呼ぶ** | 対象外 | authenticated に EXECUTE があり（`20260919120000:297`）、本人が自分で始めた state なら、**任意の X の id・handle・token で通る**（attestation が無い）[S]。PR #124 の文書 §0.10 で既知 | 自分のワークスペースに、自分のものでない X の id を付けられる。一意の索引で、本当の持ち主の後の接続が `X_ACCOUNT_ALREADY_CONNECTED` になる（id の先取り） |

### まとめ（成り立っていること・成り立っていないこと）
- **成り立っている**: サーバーは、state を始めた人と、JWT の人（`auth.uid()`）を照合する。workspace の owner も確かめる。だから、**別の人の X アカウントが別の人のワークスペースに結び付くことは、Edge の流れでは起きない**。G2-CB5 の害は、アプリの表示と `onConnected`（PR #426 で修正）だった。
- **成り立っていない**（サーバーの時点の境界。アプリでは防げない）:
  - **B1**: セッションへの結び付けが無い。state は人だけに結び付き、`session_id` を記録・照合しない。
  - **B2**: complete の時点でセッションを確かめ直さない。ログアウトが `/user` の確認と complete の間に入ると、完了する。
  - **B3**: authenticated への complete の直接の付与と、attestation の無さ（既知。X の id の先取り）。
  - **B4**: 交換の前に owner・ライフサイクルを確かめ直さない（G5 の P1 の候補、`oauth_logic.ts:271`）。これは PR #353 が直す候補だが、MERGE_NO_GO のまま。PR #353 も、セッションの確かめ直し（B2）と結び付け（B1）はしていない（`/user` は今も最初の1回だけ）[S]。

## 3. 直し方の案（今回は実装しない。G4 の後の TASK。独立のレビューが要る）
| 案 | 中身 | 必要なもの |
|---|---|---|
| S1（B1） | begin で `auth.jwt()->>'session_id'` を state に記録し、consume と complete で照合する | `social_account_oauth_states` に列を足す（migration。G4-17 の土台の表の作り直しと一緒に考える）か、H5 の `postona_threads_runtime.attempts` のような別の表 |
| S2（B2） | complete の SQL の中で、JWT の `session_id` のセッションが `auth.sessions` にあり、本人のもので、期限内であることを確かめる（同じトランザクション）。Edge でも complete の直前に `/user` をもう一度呼ぶ | `auth.sessions` を読む権限（SECURITY DEFINER の持ち主）[U]。G5 の Phase 9 のセッションの fence や H5 の `assert_actor` と同じ形を使い回せるか、G5 に確かめる |
| S3（B3） | X の complete にも attestation（Threads と同じ HMAC）を入れるか、X の complete を owner transport だけにする（G4-19 の案 C と同じ考え） | X の委譲の TASK（PR #124 §0.10）。authenticated の EXECUTE を外すときは、Edge の呼び方を変える |
| S4（B4） | PR #353 の交換の前の再認可を、G5 の R1 と合わせて入れる | G5 R1、Codex Sol の審査（PR #353 の条件のまま） |
| S5 | PostgREST のエラーの文をそのまま返さない（`rpcAsUser` が `message` を返している、`oauth_logic.ts:97-105`） | PR #353 の「固定のエラーコード」で対応の候補 |

## 4. G2 PR #419 の2件との整合
- **G2-CB5**（待機中に B がログイン）: PR #426 の上では、交換を送らず、成功も `onConnected` も出ない。G2 の旧い期待（A の token で交換、B に成功）は意図どおりに失敗する。サーバー側は、B の JWT なら consume が拒否し、A の JWT なら A 自身に結び付く（誤った人への結び付けは無い）。
- **G2-CB6**（待機中にログアウト）: PR #426 の上では、交換を送らない。サーバーの側も、global のログアウトの後なら `/user` が拒否する見込み [K]／[U]。ただし、`/user` の後のログアウト（B2）と、通信のエラーで残ったサーバーのセッションは、サーバー側の課題として残る。
- G2 への期待の更新の依頼は、担当ちゃが送信済み（#317 6329061247）。G4 は G2 のファイルを変えていない。

## 5. バックエンドの模擬の E2E の試験の設計（後の TASK で作る）
- **世界**:
  - 使い捨ての PG17 に、X の接続の migration（`20260919120000`・`20260922003101`）と、最小の `auth` の模擬（`auth.uid()`・`auth.jwt()`・`auth.sessions`）を入れる。
  - Edge の `oauth_logic.ts` を、注入した `fetch` で動かす。`/auth/v1/user` は模擬の Auth、`/rest/v1/rpc/*` は PG17 に claims を置いて呼ぶ小さな模擬、X の token と `users/me` は模擬にする。
  - 本物の X・Supabase には通信しない（`--deny-net`）。
- **場面**（それぞれ「X の token の端点が呼ばれた回数」「Vault の書き込み」「state の消費」「応答のコード」「ログに秘密が無いこと」を数える）:
  1. 普通の接続（同じ人・同じセッション）
  2. B の JWT で A の state → consume が拒否、X の呼び出しは0
  3. global のログアウトの後の A の JWT → `/user` が拒否、X の呼び出しは0
  4. `/user` の後、X の交換の最中にログアウト → 今は完了する（B2 の再現）。S2 の後は拒否、Vault の書き込みは0
  5. A→B→A → 今は完了する（B1 の再現）。S1 の後は拒否
  6. token の更新（同じセッション）→ 完了
  7. 同じ state の callback が2つ同時 → 完了は多くても1つ
  8. PostgREST で complete を直接、任意の X の id → 今は通る（B3 の再現）。S3 の後は拒否
  9. 通信のエラーで残ったサーバーのセッション → 方針を決めて固定（S2 の `auth.sessions` は「残っている」と答えるので、拒否するには別の印が要る）
- 修正の前に、4・5・8 が「今の動き」を記録する試験（修正前の失敗の証拠）になるようにする。

## 6. 独立の Auth レビューの受け入れの条件（実装の後）
1. 誤った人への結び付けが、Edge の流れでも、PostgREST の直接の呼び出しでも起きないこと（B3 の後）。
2. complete の時点で、セッションが生きていて、begin のセッションと同じであること（S1・S2）。拒否のときは X の交換・Vault の書き込み・state の消費が0であること（交換の後の拒否は、state を消費しない形で、またはサーバーの方針として明記する）。
3. アプリ（PR #426）とサーバーの判断が食い違わないこと。アプリが止める場面で、サーバーが受け付けても、誤った結び付けにならないこと。
4. エラーの応答とログに、token・code・verifier・secret・DB の生の文が出ないこと。
5. API の役割の付与（complete・consume・begin）と SECURITY DEFINER・search_path が審査されていること（`complete` の search_path は今 `'public','vault'` で空ではない [S]）。
6. 本物の Supabase Auth での `/user` と `session_not_found`、ログアウトの scope ごとの動き、PostgREST がセッションを見ないことを、使い捨ての環境で実測すること（今は [K]／[U]）。

## 7. 未解決のまま守っていること
- PR #124／#405 の所有者だけの契約（H5・G5 の返答待ち）
- PR #412・#418 の独立のセキュリティのレビュー
- PR #426 の独立の Auth のレビューと、G2 PR #419 の期待の更新
- Supabase Data API の 10/27 の持ち主の合意
- H2 の Codex の停止
- PR #353／#355 は MERGE_NO_GO のまま
