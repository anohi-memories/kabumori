# G4-18：X の接続のブラウザの待機中にユーザーが切り替わったときの fail-closed（2026-10-22 JST）

- task_id: `postona-g4-x-oauth-browser-wait-owner-session-race-failclosed-20261021`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_FIX_CANDIDATE／PRODUCTION_NO_GO**。本物の Auth・X の OAuth・本番の認可の安全の判定は、別の独立のレビュー（Codex Sol（高）など）。
- 元の指摘: G2-CB5（P3）。G2 #317 の REPORT 6316885227、QA は Draft PR #419（`1ffd1b20f195d07fcc1b4beda3ea0f271c63aef3`）、G4 への連絡は #319 6316954285。G2-CB6（ログアウト）も同じ修正で閉じる。
- 土台: main `0c42933ca5030ab31a56267529430d0473d9b155`。

## 1. 問題
- `apps/social-mobile/src/features/x-connect/use-x-connect.ts` の `connect` は、開始のときの `session`（画面に渡された値）を閉じ込め、戻ってきたときの交換（`x-oauth-connect-user/callback`）にも、その `access_token` を使っていた。
- そのため、ブラウザが開いている間に:
  - **別の人 B がログインする**と、A の token で交換が進み、画面に残った B に「Xアカウントを接続しました @A の名前」が出て、`onConnected`（B のデータの再読み込み）も走った（G2-CB5）。
  - **A がログアウトする**と、ログアウト済みの A の token で交換が送られた（G2-CB6）。
- サーバーは、送られた JWT の人に結び付けるので、X のアカウントが B に付くわけではない。問題は、**別の人の画面に別の人の接続の成功が出ること**と、**ログアウトの後にも交換が送られること**。

## 2. 直したこと（`use-x-connect.ts` だけ）
- 接続は、**始めた人とその Supabase のセッション**（ユーザー ID と、JWT の `session_id`）のものとする。
- 「今のセッション」は、画面に渡された値ではなく、SDK が保存しているセッション（`supabase.auth.getSession()`）を読む。
  - アカウントの削除（`providers/auth-provider.tsx`）が、確認を「ユーザー＋セッション」に結び付けているのと同じ形。`sessionIdOf`（`domain/recovery-binding.ts`）を使う。
- 確かめる時点は3つ:
  1. **開始のとき**: 今のセッションから持ち主を決める。画面の人と違う、またはセッション ID が無い → 何も送らない。
  2. **交換の直前**: 今のセッションが同じ人・同じセッションか。違う・ログアウト・読めない → **交換を送らない**。同じなら、**今の**（更新されているかもしれない）token で交換する。
  3. **成功の表示と `onConnected` の直前**: もう一度確かめる。違えば、成功を出さず、`onConnected` も呼ばない（交換は始めた人の token で行われたので、サーバーはその人に結び付けている）。
- 止めたときは、新しい状態 `session_changed`（「ログイン中のアカウントが変わったため、この接続は続けられません。必要なら、もう一度お試しください。」）。文に token・ID・ハンドルは入れない。ログには何も出さない。
- **ユーザー ID の一致だけでは足りない理由**:
  - A→B→A では、同じ A でも、別の人が端末を使った後の**新しいセッション**。古い画面や古い戻りが、その新しいセッションの成功になるのを防ぐため、セッション ID も比べる。
  - 同じセッションの token の更新（TOKEN_REFRESHED）は、セッション ID が変わらないので、そのまま続けられる。
- キャンセル、二度押し（同時に1つだけ）、state・戻り先の確認、iOS の private のセッションは、今までどおり。

## 3. 試験（`apps/social-mobile`、node v24.19.0、ネットワークなし）
- 新しい `tests/x-connect-owner-session.test.mjs`（11件）。本物のフックを、合成の依存で動かす。ブラウザの往復を開いたままにして、その間に人を変える。

| 場面 | 結果 |
|---|---|
| 対照: 同じ人・同じセッションのまま | 交換はそのセッションの token、成功、`onConnected` 1回 |
| G2-CB5: 待機中に B がログイン | 交換を送らない（開始の1件だけ）、`session_changed`、成功なし、`onConnected` なし |
| G2-CB6: 待機中に A がログアウト | 交換を送らない |
| A→B→A（同じ A の新しいセッション） | 交換を送らない |
| 同じセッションの token の更新 | 続けられる。交換は**更新後**の token |
| 交換の最中に人が変わる（B のログイン／ログアウト／A の新しいセッション） | 交換は A の token のものだけ。B の画面には成功なし、`onConnected` なし |
| セッションが読めない（エラー／例外） | 交換を送らない |
| 開始のとき、画面の人と保存されたセッションの人が違う／セッション ID が無い | 何も送らない |
| 人が変わった後に X でキャンセル | キャンセルのまま、交換なし |
| 止まった後に B が自分の接続を始める | 待機中の二度押しは無視。B の交換は B の token だけ、成功 |
| ログ・表示 | フックに console などのログは無い。状態の文に token・ID は無い |

- **修正前の失敗**（同じ試験を main のフック `0c42933c` に `X_CONNECT_HOOK_SOURCE` で当てた）: pass 3／fail 7／cancelled 1。
  - 通ったのは、対照・キャンセル・ソースの確認（このモードでは中身を飛ばす）の3件。
  - cancelled の1件は、開始のときの確認が無いため、ブラウザを開いて待ち続けた。
- **わざと欠陥を入れて検出できるか**（フックの写しを変えて当てた）: **7/7** を検出。
  - 交換の直前の確認を外す／成功の直前の確認を外す／ユーザー ID だけで比べる／交換に開始のときの token を使う／開始のときの画面の確認を外す／SDK のセッションを読まない／セッション ID を求めない
- 既存の `tests/x-connect-auth-session.test.mjs`（14件）は、合成のセッション（`getSession` と `session_id` のある JWT の形）を足して、そのまま通る。
- 全体:
  - `node --test tests/*.test.mjs`: **288 passed／0 failed**（main の 277 ＋ 新しい 11）
  - `tsc --noEmit`: エラーなし
  - `expo lint`: 問題なし
  - 依存は lockfile から `npm ci --ignore-scripts` で、この作業の worktree の中だけに入れた（コミットしない）。

## 4. 他の持ち主との IF・残ること
- **G2 の PR #419 の試験**（`g2-callback-reentry.test.mjs`）の G2-CB5 と G2-CB6 は、修正前の動きを「指摘」として固定している。そのため、この修正の上では2件が失敗する（設計どおり）。
  - G2 の模擬には `supabase.auth.getSession` と `@/domain/recovery-binding` が無い。
  - G2 が、期待（交換を送らない・成功を出さない）と模擬を直す必要がある。G4 は G2 のファイルを変えていない。
- **サーバー側**（`x-oauth-connect-user`）は変えていない。ログアウト後の token をサーバーが受け付けるか（G2-CB6 の後半）は NOT_VERIFIED。サーバーは JWT の人に結び付けるので、別の人への誤った結び付けは、もともとサーバーでは起きない（コードの読み取り。本物の Auth では未確認）。
- X の OAuth の PR #353（交換の前の再認可）／#355 は NO_GO のまま。今回の修正とファイルは重ならない。
- G2 の観察 G2-CB1（アプリのログインの古い戻り）と G2-CB3 は、ログインの持ち主の範囲で、今回は対象外。
- 実機（iOS／Android）・本物の Supabase Auth・X の OAuth・本番は NOT_VERIFIED。
