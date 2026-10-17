# PR238 J2 V2 の P2×2 — 利用登録ゲートの限定修正（F5・2026-10-17 JST）

TASK: `common-account-f5-pr238-j2-v2-gate-stale-screen-handler-p2x2-fix-20261017`。**ソースのみ・本番 NO_GO**。J2 V2 が PR238（head `b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6`）の実ソースで再現した 2 件だけを直す。F4 の `ServiceLifecycleProvider`／`ServiceLifecycleSurface`／レイアウト／端末画面／`account-deletion`、H5 の再認証、サーバー（Auth・RPC・権利・migration・Edge）、PR230／235／236／238 は変えていない。`POSTONA_END_SOURCE_ENABLED` は `false` のまま。

変更はゲート本体 `src/features/service-enrollment/service-enrollment-gate.tsx` と、ゲートのテスト・支援だけ。

## P2-1 — ゲート自身の管理入口に旧埋め込み画面が残っていた

**before（PR238）**: 外側の surface に移った入口と違い、ゲートの「利用終了・共通IDの管理」は `deletionOpenFor` と内側の `<AccountDeletionScreen />` のままだった。再認証で同じ人の新しいログインができ、そのログインの読み戻しが `active` になるとゲートはアプリを返し、埋め込み画面は消える（外側の surface は一度も開かれていない）。確認文などの途中フローを保てなかった。

**after**: 埋め込み画面と `deletionOpenFor` を撤去。blocked／error／reenroll（loading を含む）の全ての管理入口は、F4 の**既存**の `useServiceLifecycle().open(currentUserId)` を呼ぶだけ。呼ぶ人は「クリック時にサインインしている人」で、描画時の人と一致しなければ何も開かない（`currentOwner` の参照で照合。F4 の provider も、サインイン中でない人には `open` を拒否する）。surface は F4 の仕様どおり、同じ人の新ログインでは開いたまま、別の人・サインアウトで閉じ、戻っても再表示しない。

- 新ログインへの読み戻しが active／ended／error のどれでも、surface と端末画面は残る（9 通りの行列テスト）。画面は新ログインに合わせて入力済みの確認文を捨てる（F4 の既存の保護。`value === ''` を確認）。
- ゲート自身の木に画面要素は無い（テストで確認）。
- F4 の pending 仕様 `[SPEC G2 / F5 gate, optional]` が通る（PR238 では失敗）。

## P2-2 — 古い「利用登録する」ハンドラが最新の question を確かめずに送っていた

**before（PR238）**: `reenroll` はクロージャに保存された `view`／`userId`／`loginId`／`epoch` 同士を比べるだけだった。古い `onPress` を保持して後から呼ぶと（epoch が進んだ後、別の人に変わった後、ログインが回転した後）、`reactivate_x_autopost_service` が古いトークンで 1 件送られた。応答破棄の柵は、送信済みの副作用を取り消さない。

**after**: ハンドラは「どの人・ログイン・epoch・request のために描かれたか」を持ち、**実行時**に最新の question（`currentOwner` と `request` の参照）と照合する。

- クリックの最初の処理が照合（`isCurrentQuestion`）。古ければ、request を進めず、view も変えず、RPC も送らず、そのまま返る。人・ログイン・epoch・request のどれが古くても止まる。
- 送信の瞬間にもう一度、所有者と request を確かめる（`explicit` に渡す関数の先頭。照合と送信の間に何も挟まらないので動作上は冗長だが、境界そのものに置いた）。
- 維持したもの: 送信後の所有者確認、`lifecycle_version` による比較、二重クリック抑止（`explicitInFlight`）、再登録は本人のクリックだけ。refresh では再登録しない。
- 同じ種類の古いハンドラとして、**再読み込み**と**共有アカウント通知の「はじめる」**にも同じ照合を入れた（古い「はじめる」が別の人の通知を既読にできる状態だった）。

## テスト（`tests/service-enrollment-gate-j2-v2.test.mjs`、20 件・F5 所有の追加分）

- P2-1: 3 つの閉じた状態 × 新ログインの 3 通りの答え = 9 件、別の人／サインアウトで閉じて戻っても再表示しない、古い管理クリックは何も開かない、ソース契約。
- P2-2: epoch が進んだ後／A→B／ログイン回転後／同じ owner の新しい request による上書き、現在の owner の再登録は 1 回（二重クリックでも 1 回、答えでアプリが開く）、成功後の古いコールバックは何も送らない、再読み込みと通知の古いハンドラ、照合が最初の処理であることのソース順序。
- 実行条件: 実ゲート（と P2-1 では F4 の実 provider・surface・端末画面）を transpile して hook runtime で駆動。Auth・終了要求・PostgREST は合成。通信なし。

## 触ったテスト（既存）

- `tests/service-end-g1-g2-integration.test.mjs`（F4+F5 の共同ファイル）: ゲートの module map に lifecycle を足し、**旧埋め込み画面を前提にしていた 1 件だけ**（「ゲート自身の埋め込み画面が新ログインで残る」）を新しい期待（管理入口が surface を開き、ゲートは画面を描かない）に置き換えた。ほかの 8 件は無変更で通る。
- `tests/service-enrollment-lifecycle.test.mjs`、`tests/service-enrollment.test.mjs`、`tests/support/enrollment-harness.mjs`: 埋め込み画面前提の期待を `open(userId)` に合わせた。
- 新規支援: `tests/support/assembled-app.mjs`（共同ファイルの組み立てと同じもの。F4 のファイルを編集せずに使うため）。

## 変えていない・残る STOP

managed Auth（実 GoTrue／RLS／PostgREST）、F3 X の旧経路、D1 全 ID 削除の同意、Phase12（PR233）の安全性、実機は別の release STOP。本修正は「ソースの限定修正」であり、モックのハーネスでの確認である。
