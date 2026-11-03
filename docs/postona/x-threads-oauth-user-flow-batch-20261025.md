# G4-41：X・Threads の OAuth を利用者の動線に結線する一括の実装（2026-10-25 JST）

- task_id: `postona-g4-x-threads-oauth-product-auth-integration-batch-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **SOURCE_BATCH_PASS**: Edge・アプリ・SQL の候補を、隔離した PG17 と node・deno の試験で測った。
  - **G5_WIRING_NOT_DONE**: G5 の本物の判定にはつないでいない。
  - **PRODUCT_NOT_FIXED**: 製品は直っていない。
  - **PRODUCTION_NO_GO**: 本番には出せない。
- 土台: PR #516（`25be22ed9ecc08e343ca6b56cb19f8ab8761f405`）← PR #511。main は `0c42933c`。

## 1. 結線した場所（ファイル単位）
| 経路 | ファイル | 持ち主 | この TASK |
|---|---|---|---|
| X の接続の Edge | `supabase/functions/x-oauth-connect-user/oauth_logic.ts` | G4 | **製品のコードを変えた**（デプロイはしていない）。RPC の拒否を状態に分ける。session は 401、作業場所は 409、ほかは 400 |
| X の接続の hook | `apps/social-mobile/src/features/x-connect/use-x-connect.ts` | G4（X 接続の hook。G4-18 PR #426 と同じ file） | **製品のコードを変えた**。状態 `session_required`・`workspace_blocked`・`disconnecting`・`disconnected` を足し、`disconnect()` を足した |
| 判定の関数 | `apps/social-mobile/src/lib/x-oauth-onboarding.ts` | G4 | **製品のコードを変えた**。`classifyXConnectFailure`・`classifyXDisconnectFailure` を足した。再試行の規則は変えていない |
| X の begin・complete・切断の SQL | `supabase/candidates/postona_g4_x_oauth_personal_epoch/001`・`002`・**`003`** | G4 | 003 を新しく作った。利用者が自分で切断する RPC で、門は閉じたまま |
| 画面（ボタン・文言の確定） | `apps/social-mobile/src/app/accounts/index.tsx`・`onboarding-gate.tsx` | G1・G2 | 変えていない。画面は `stateText` を表示するので、新しい文言はそのまま出る。切断のボタンは G1・G2 が付ける |
| token の更新 | `x_account_refresh_*`（main） | G4 ではない | 変えていない（R-1・R-2 は G4-40 のとおり） |
| G5 の判定3つ | PR #506（H4 PASS）・PR #510（Sol 待ち）・owner epoch | G5 | 名前と形と EXECUTE だけを確かめる |
| Threads | main には無い。G4 の候補の stack にだけある | G4 | §3（source で比べた。変更は無い） |

- 同じ file を触っている G4 の未マージの PR:
  - PR #353（`oauth_logic.ts` など。G5 R1 と Sol の前はマージ禁止）
  - PR #426（`use-x-connect.ts`）
- 変えた箇所は重ならない（`fail()` の状態の1行、catch の1行と、新しい `disconnect`）。ただし、マージの順番で衝突の解消が要る。

## 2. 利用者に見えて変わること（候補を全部適用し、デプロイした場合）
| 場面 | 今 | 変わった後 |
|---|---|---|
| ログインが切れた・匿名で接続 | 「最初からやり直してください」 | 「ログインの有効期限が切れました。もう一度ログインしてから接続してください。」（401） |
| 古い brand・共有の brand（P-1 は未決） | 今は古い brand に接続される。G4-39 以降は「最初からやり直し」 | 「このアカウントでは、まだXを接続できません。サポートにお問い合わせください。」（409）。やり直しを繰り返させない |
| 古い callback・重複・ABA | 「最初からやり直し」 | 同じ |
| 通信のエラー | 「もう一度お試しください」 | 同じ |
| 切断 | できない | RPC と hook はある。**門は閉じたまま**で、画面のボタンも無い。運用者が門を開け、G1・G2 がボタンを付けて初めて使える |

- 文言は仮のもの。G1・G2 が確定する。

## 3. Threads と比べた結果（source だけで比べた。実測はしていない）
| 観点 | X（001〜003） | Threads（G4 の候補 `b963683b`） |
|---|---|---|
| W1（status の CHECK） | `'unconnected'` | `disconnect_threads_account` は行と Vault を**削除する**ので、該当しない |
| W2（token の書き手） | 更新の lease だけ | `rotate_and_store`（候補 004）だけ。同じ考え方 |
| W3（表のロックによる deadlock） | complete・切断が先に ROW EXCLUSIVE を取る | Threads の rotation は表のロックを取らない。X の更新の commit が取る SHARE ROW EXCLUSIVE とは、待つだけで循環はしない |
| session の判定（S1-F2） | G5 の session の判定 | PR #124 の begin は T13（匿名を通す）。**同じ結線が必要**（次の一括の対象） |
| 切断の門 | 003 の `x_disconnect_enabled`（閉） | `threads_disconnect_gate_open()`（閉） |

## 4. 試験（2026-10-25 JST、外部への通信は0）
- `supabase/tests/postona_g4_x_oauth_user_flow_run.sh`（隔離した PG17、製品の形、偽の Auth・Vault・G5）→ **`G4XU_USER_FLOW_ALL_PASS`**
  - behavior **19/19**: API のロール（authenticated・anon）で、次を確かめた。
    - 門が閉じているとき・開いたとき・また閉じたとき
    - subject が無い場合、session の失効、X を持たない人
    - 古い brand の人（P-1）
    - 切断で保留の state が消え、epoch が進む
    - 切断の後の古い callback、2回目の切断、再接続
    - 他の人の X には届かない
  - 適用の拒否2件。rollback の拒否2件と、rollback（002 はそのまま）からの再適用
  - 欠陥 **3/3 を検出**: 門を無視、anon に grant、適用時に門を開ける
  - 回帰: G4-40 の runner → 23/23・24/24・30/30、W3、`G4XW_PRODUCT_WIRING_ALL_PASS`
- Edge: `deno test --no-config --allow-read --allow-env supabase/functions/x-oauth-connect-user/` → **33 passed**（main は 29。4件足した）。`deno lint` も問題なし。
- アプリ（この worktree で `npm ci --ignore-scripts`）:
  - `npm test` → **298/298**
  - `npx tsc --noEmit` → 0 件
  - `npx expo lint` → exit 0
- **NOT_VERIFIED**: G5 の本物の判定、本物の Vault・Auth・X、Edge のデプロイ、実機の画面、本番

## 5. 採用の順番と、まとめてレビューするもの
1. **G5**:
   - PR #510 の Sol レビューと、PR #506・#510 と owner epoch の適用
   - begin と complete の owner に EXECUTE を与えること
   - Q13・Q10・Q11 に合意すること
2. **Codex Sol（高）が一括でレビュー**:
   - PR #511 `c686644e…`（001）
   - PR #516 `25be22ed…`（002）
   - この PR（003、Edge、hook、lib、試験）
   - G4 の PR #353・#426 は同じ file なので、一緒に見る
3. SQL は 001 → 002 → 003 の順に適用する（それぞれ前提条件で止まる）。その後に Edge をデプロイし、アプリを出す。
4. G1・G2: 文言を確定し、切断のボタンを付ける。運用者: 門を開けるか決める。
5. token の更新の担当: R-1・R-2。G3: lease の外で token を書かないこと（Q9・Q12）。
6. Threads: PR #124 の begin に、G5 の session の判定をつなぐ（次の一括）。
- 本番は owner の明示の承認があってから。

## 6. 残件
- 決めていない（G5・ユーザー）: R0、P-1、locked／ban、ログアウト、切断の後の token の保持。
- 別に残っている課題: 候補 005・D8・H5 の transport・本物の Vault の ACL。PR #124 の authenticated の EXECUTE は有効にしない。Issue #131 は延期のまま。
