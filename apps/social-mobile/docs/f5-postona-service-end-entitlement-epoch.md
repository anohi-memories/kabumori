# POSTONA 利用終了後の利用登録ゲート更新（G1）— F5 のゲート側（2026-10-17 JST）

TASK: `common-account-f5-postona-service-end-entitlement-epoch-g1-g2-20261017`。**ソースのみ・本番 NO_GO**。サーバー（Auth／RPC／権利／migration／Edge）、F4 の画面・レイアウト・provider、H5 の本人確認、`_layout.tsx`、`account-deletion.tsx` には触れていない。F4 の設計（PR230 `e6725a16`、「設計 B」）のうち **F5 の持ち分 = 利用登録ゲートが「人ごとの epoch」を読んで再確認する部分** だけを実装した。

## 0. 結論

- **G1**（POSTONA の利用終了が済んでも、ゲートが古い `ready` を持ち続ける）: ゲートは、いまサインインしている人の epoch が変わったら、決めていた答えを **その描画のうちに捨てて**（アプリは先に閉じる）、**今のログインのトークンで**サーバーにもう一度聞く（自動開始 `start_x_autopost_service`。終了済みなら `reenroll_required` が返るだけで、再開はしない）。開けるのはサーバーの `active` の答えだけ。
- **G2**（本人確認で新しいログインができても利用終了が続く）は F4 の surface の仕事で、ゲート側の条件は変えていない（審査済みの S1「新しいログインは自分の答えが出るまでアプリを開かない」は維持）。
- **未接続の部分（重要）**: epoch を出す F4 の `ServiceLifecycleProvider` はまだこのスタックに無い。F5 は競合する provider を作らない。そのためゲートの入力は F5 所有の seam `src/features/service-enrollment/lifecycle-epoch.ts` を通し、**現状は全員 epoch 0 を返す**（`LIFECYCLE_SIGNAL_CONNECTED = false`）。**ゲートの更新は実装・テスト済みだが、F4 の provider に繋ぐまで製品では動かない（G1 は製品上は未解消）。** 接続は seam の 1 行（§5）。

## 1. 確かめた版

| 範囲 | 版 |
| --- | --- |
| 本 PR の土台 | PR230 `e6725a165cd8f116a964926cdfceaa9334590491`（PR197 `2171ee4c` → 211 `eb1011f2` → 217 `d4bcd09e` → 221 `dcae62c6` → 230）。ゲートの最新版はこの祖先に入っている |
| ゲートの実パス | `apps/social-mobile/src/features/service-enrollment/service-enrollment-gate.tsx`（TASK の `src/components/…` は実在しない） |
| 触った所有範囲 | ゲート本体、F5 所有の seam、ゲートのテストと支援モジュール。ほかの生きたブランチは `service-enrollment` も `service-lifecycle` も触っていない（全 worktree で確認） |
| 本人確認 `reauthenticate`（H5、読み取りのみ） | 成功時に `{ ok: true, context: { userId, sessionId } }` を返す。`signInWithPassword`／OAuth の後に `auth.getSession()` で **新しいセッションに固定**し、`session.user.id === userId` を確かめてから返す。ゲートが必要とする「同じ人・新しいログイン」を満たすので **H5 への依頼は不要** |

## 2. 動作（信号 → ゲート）

| きっかけ | ゲートの動作 |
| --- | --- |
| いまの人の epoch が変わった（どの向きでも） | 決めていた答えを捨てる。**同じ描画でアプリを閉じる**（送信より前）。保留中の要求は取り消す。今のログインのトークンで `start_x_autopost_service` を **1 回**聞く |
| `active` が返った | 開く（その epoch・その人・そのログインの答えとしてだけ） |
| `reenroll_required` が返った | 閉じたまま「利用登録する」を出す。**再登録は本人のクリックだけ**。クリックは、直近の答えの `lifecycle_version` で 1 回 |
| 通信失敗・HTTP 500 | 閉じたまま「再読み込み」を出す。自動では再試行しない。手動の再読み込みはその epoch で 1 回聞く |
| 別の人への信号 | 見えない（読むのは今の人の epoch だけ）。何も送らない |
| トークン更新（同じログイン） | 何もしない（再確認なし） |
| 同じ人の新しいログイン（本人確認など） | 従来どおり新しいログインとして聞き直す（S1）。信号と同時でも聞くのは **新しいログインのトークンで 1 回**だけ |
| サインアウト／別の人 | 答えを全部捨てる。別の人は何も引き継がない |
| epoch 変更中に前の要求の答えが遅れて届く | 無視（要求ごとの取り消し・世代・所有者タグの三重で止まる）。**古い `ready` は復活しない** |
| 再登録クリックの要求が飛んでいる間に信号 | その要求を取り消し、再確認の答えで決める。追加の再登録は送らない |
| ゲートの再マウント | 閉じた状態から始め、聞き直す。埋め込みの利用終了画面を開いたままにはしない |
| ローカルのモックプレビュー | ゲートせず、信号を無視 |

決めた状態（`view`）はすべて **人・ログイン・epoch** のタグを持つ。どれかが違えば `loading` として扱う。信号は「開ける・閉じる」を決めない。決めるのは常にサーバーの答え。**かぶモリの権利は一切読まず書かない**（ゲートが呼ぶ RPC は `*_x_autopost_service` だけ）。

## 3. 変更したもの

- `src/features/service-enrollment/service-enrollment-gate.tsx`: epoch を読む／所有者タグに足す／epoch 変更で `enrollment.reset()` して聞き直す／クリック・再読み込みにも同じタグ。サーバー側 RPC・`service-enrollment.ts`（ドメイン）は無変更。
- `src/features/service-enrollment/lifecycle-epoch.ts`（新）: `LifecycleEpochHook` 型と現状の既定（全員 0）。状態を持たず、provider ではない。
- テスト: `tests/service-enrollment-lifecycle.test.mjs`（新・19 件）、`tests/support/enrollment-harness.mjs`（既存テストのハーネスを共有化。中身は移動のみ）、`tests/support/lifecycle-signal.ts`（型付きのモック）、`tests/service-enrollment.test.mjs`（ハーネスの import 先を変えただけ。336 件は無変更で通る）、`tests/pending/gate-seam-connect.pending.mjs`（新・接続の受け入れ。**今は失敗する**）、`tests/support/gate-epoch-mutations.py`（ゲートの mutation）。

## 4. 検証

- 通常テスト `npm test`: 336 → 355 件、すべて通過。`tsc --noEmit`、`expo lint` クリーン。
- **fail-before / pass-after**: 土台のゲート（PR230）に新テストを当てると 19 件中 15 件失敗（残る 4 件は「別の人への信号は無視」「S1」「サインアウトで消える」「モック」の対照）、本 PR のゲートでは 19/19。
- mutation: ゲートと seam の 14 件を壊して 14 件検出（`tests/support/gate-epoch-mutations.py`）。ほかに、他のガードと重複していて単独では観測できない 6 件を「等価（生き残りが正）」として明示。
- F4 の受け入れ（`tests/pending/service-end-gate.pending.mjs`、無変更）: seam の module map を 1 行足した複製（コミットしない）で試すと、**[SPEC G1 / F5 gate] の 2 件が通過**、[CONTROL] 2 件も通過。残る [SPEC] 3 件（レイアウト・surface・画面の合図）は F4 の持ち分。
- 未実施: 実機・管理された環境（メール／X／Google／Apple の実際の再認証）、F4 の実装との結合、`expo` の実行、サーバーの実挙動。**モックのハーネスの PASS であり、実 Auth ではない。**

## 5. 接続の手順（F4 の provider が入ったとき）

1. F4 が `useServiceLifecycleEpoch(userId)` の正確な export 先と型（`(userId: string | null) => number`）を確定する。
2. `lifecycle-epoch.ts` を次の 1 行に変え、`LIFECYCLE_SIGNAL_CONNECTED = true` にする（状態を持つ providerはここに書かない）:
   `export { useServiceLifecycleEpoch as useLifecycleEpoch } from '@/features/service-lifecycle/service-lifecycle';`
3. `tests/pending/gate-seam-connect.pending.mjs` が通るのを確かめ、ファイルを消す。`tests/service-enrollment-lifecycle.test.mjs` の seam 契約テスト（未接続を固定している）を接続後の形に更新する。
4. F4 の pending 仕様の module map に 1 行足して [SPEC G1 / F5 gate] を有効にする（**F4 との調整**）: `'@/features/service-enrollment/lifecycle-epoch': { useLifecycleEpoch: (userId) => (userId ? lifecycle.epochs.get(userId) ?? 0 : 0) }`。
5. 関門の中の `<AccountDeletionScreen />` と `deletionOpenFor` は、F4 の surface と `open(userId)` が入ってから置き換える（設計 §6 F5-2。今回は surface が無いので **残している**）。

## 6. F4／コーディネーターへ（相違点・依頼）

- **合図を出すタイミングの食い違い**: PR230 の設計と pending 仕様は、送信後の結果が **`RESULT_UNCONFIRMED` でも** `bump` する。今回の TASK 文は「確認できない結果では bump しない」とある。ゲートはどちらでも安全（余計な合図は、サーバーの答えで決める再確認が 1 回増えるだけ。合図が無ければ何も起きない）。決めるのは F4 の画面側。
- ゲートは信号を**作らない**（`bump` を呼ばない。テストで固定）。端末をまたいだ終了（別端末で利用終了）はこの仕組みでは検知されない（次のログイン／再読み込みで分かる）。
- seam を介するため、F4 の pending 仕様のゲート用ハーネスは上記 1 行の module map が必要（現状のままだと「unexpected import」になる）。
- 実装 PR 同士が揃った時点で、F4＋F5 の結合に対する Auth／ユーザー間境界の限定レビューを 1 回（TASK のとおり）。

## 7. 変えていない・本 TASK の範囲外

サーバーの Auth／RPC／権利の方針、DB migration、Edge、`apps/social-mobile/src/app/_layout.tsx`、`account-deletion.tsx`、F4 の provider／surface、H5 の `reauthenticate`、F3 の X 投稿、F4 の Threads、G3 T13。D1 全 ID 削除の同意は OFF のまま、本番 NO_GO、`managed_auth_delete` BLOCKED、`IDP_PREPAUSE_BLOCKED` BLOCKED。
