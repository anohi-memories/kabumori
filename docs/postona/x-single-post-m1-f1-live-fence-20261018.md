# POSTONA X 手入力の単発投稿 — 送信直前のライブ確認（M1-F1）と結果の正直な記録（M1-F3）（2026-10-18、F3）

- 判定: **PASS_LOCAL_SYNTHETIC_ONLY（本番 NO_GO）**
  - 手元の使い捨て PostgreSQL 17 と、偽の Auth・偽の G4（トークンと世代の取得口）・偽の X だけで確認した。
  - 本物の X には一度も送っていない。偽の X の「成功」は、本物の投稿の証拠ではない（結果には `simulated: true` が付く）。
  - 公開スイッチ（`POSTONA_X_SINGLE_POST_ENABLED`）は OFF のまま。G4 の取得口は未接続（`X_GENERATION_CREDENTIALS_NOT_CONNECTED`）。G4 の本人確認の判定は出荷時「常に拒否」。そのため、本番では何も送れない。
- 根拠: F5 の M1 契約（PR #275、B1〜B8、指摘 M1-F1 / M1-F3）、Issue #269。
- 積み順: PR #272（`559b3e54f04a89ffe23ebbf54d71857ad064b1e7`）の上。既存の PR は変更していない。

## 1. 何が足りなかったか（PR #272 の 005 で実際に確認した穴）

`single_post_live_fence_run.sh` の FB 区分は、006 を当てる**前**の 005 で、次の 5 つが実際に通ってしまうことを毎回確かめる。

| 記号 | 005 で通ってしまうこと |
|---|---|
| FB1 | 投稿スイッチ（`social_accounts.publish_enabled`）が OFF でも送信に進む（B6） |
| FB2 | ワークスペースの所有者が 2 人になり、F5 のブランド状態が `WORKSPACE_OWNER_UNKNOWN` でも送信に進む（B4・B7） |
| FB3 | 資格情報が「再認可が必要」でも送信に進む |
| FB4 | 開始から送信直前までに資格情報が変わっても（Vault の参照先が入れ替わっても）直前確認は OK |
| FB5 | 「停止後に記録された」印も、送信手段（本物か模擬か）の記録もない（M1-F3・模擬の明示） |

## 2. 006 で変えたこと（F3 の `postona_x_resv` だけ。F5・G4・Stage 3B のものは変えていない）

- `supabase/candidates/postona_x_reservations/006_postona_x_single_post_live_fence.sql`（migration ではない）とロールバック。
- **送信の柵（`single_post_fence`）** の順番:
  1. F5 の T13（ログイン・セッション・利用権。G5 のロックを先に取る）
  2. 持ち主・G5・G4（既存の `assert_account_access`）
  3. 投稿権限が `revoked` でないこと（PR #182）
  4. **投稿スイッチが ON**（B6。新しいコード `POSTONA_RESV_PUBLISH_DISABLED`、403）
  5. **F5 のブランド状態 `public.common_account_brand_service_state(brand, 'x_autopost') = 'active'`**（B7・M1-F1）。T13 のロックを持ったまま、その場で読む。
  6. **F5 のワークスペース所有者 `private.account_lifecycle_brand_owner(brand)` が本人ちょうど**（B4。2 人以上・不明は拒否）
  7. 資格情報の更新状態: `refreshing` は混雑（送らずに戻す）、`uncertain` / `reauth_required` は拒否（`POSTONA_RESV_CREDENTIAL_DEGRADED`、403）
- **資格情報の世代 `x_credential_generation(account)`**:
  - 次の値をまとめた SHA-256。
    - アカウント、ワークスペースと F5 の所有者、X のユーザー ID
    - Vault の参照先 2 つ（アクセス用・更新用）
    - 接続状態、`verified_at`、行の `updated_at`
    - 更新状態の世代と状態（refresh core の表があるときだけ）
  - Vault の中身は読まない。API 役割からは呼べない。
- **`single_post_bindings`**: 1 件ごとに、開始時の所有者・ワークスペース・世代を記録し、結果の記録時に送信手段と `after_freeze` を書く。API 役割からは読めない。
- **API 役割の関数**（005 の check / finish / get は API 役割から外した）:

  | 関数 | 中身 |
  |---|---|
  | `post_now_begin` | 005 と同じ答え。世代を結び付ける。もう一度使える行では、結び付けを新しくする |
  | `post_now_preflight` | 送る直前に柵をもう一度通す。開始時と比べて所有者・ワークスペース・世代が変わっていたら `failed CREDENTIAL_CHANGED`（送らない）。そのあと既存の `pre_publish_check`。OK のときは、トークンが持つべき世代を返す |
  | `post_now_record` | 結果（既存の finish）と送信手段（`x` / `simulated`）。記録の時点で F5 の状態を読み直し、`active` でなければ `after_freeze = true` |
  | `post_now_readback` | 状態、保存した X の ID、`after_freeze`、`simulated`（送信手段が分からないときは true） |

- **サーバーの流れ**（`single_post.ts`）:
  1. 認証
  2. G4 の取得口（世代付き）がなければ 503
  3. begin
  4. **トークンと世代を G4 から取得**
  5. **そのあとで preflight**。トークンを取ったあとに起きた停止・スイッチ OFF・利用終了・サインアウト・更新も止められる。
  6. トークンの世代と preflight が返した世代が一致したときだけ送る。違えば `failed CREDENTIAL_GENERATION_CHANGED`（送らない）。
  7. X へ 1 回（そのトークンだけを持つ一度きりの取得口）
  8. record
  9. 別の接続で読み直す
- **残る隙間（正直に書く）**: preflight の確定から X の呼び出しまでの間に起きた停止は、X の呼び出しにロックを掛けられないため防げない（M1-F3 の前提）。その場合は「停止後に記録された」（`after_freeze = true`）として、投稿した事実をそのまま記録し、隠さない（E5・L6・R1 で確認）。

## 3. F1（アプリの投稿画面）への申し送り

- 送り先・本文・`clientRequestId` の扱いは M1 と同じ（`docs/postona/x-single-post-m1-20261018.md` §2）。
- 結果の種類（`singlePostResultOf`）は変わらない: `sent` / `pending` / `failed` / `uncertain` / `refused` / `unavailable`。
- 結果に次の 2 つが加わる（`sent` / `pending` / `failed` / `uncertain` のとき）:
  - `simulated`: サーバーが「本物の X で送った」と記録したときだけ false。**印がないときは true**。true の `sent` は試験の結果で、投稿済みとして見せない。
  - `afterFreeze`: 停止や利用終了の**あと**に記録された投稿（送信中に止められたもの）。投稿済みとして見せ、注記を付ける。
- `sent` は、読み直しで保存した X の ID が一致したときだけ。`uncertain` は**自動で再送しない**（本人に X で確認してもらう）。
- 新しい拒否コード: `POSTONA_RESV_PUBLISH_DISABLED`（投稿スイッチ OFF、403）、`POSTONA_RESV_CREDENTIAL_DEGRADED`（X の再接続が必要、403）。`POSTONA_RESV_SERVICE_BUSY` は 503 なので `unavailable`（同じ ID で再試行）。
- 今は公開スイッチが OFF なので、どの呼び出しも 503 `NOT_AVAILABLE`。送信ボタンは無効のまま。

## 4. G4（X の本人確認とトークン）への申し送り — 契約の提案

- 新しい取得口 `XPostingGenerationCredentialSource.credentialFor(account) → { token, generation } | null`（`x_credential_generation.ts`）。
- 契約は G1〜G5。`generationSourceViolations()` で、G4 の実装に対してそのまま確かめられる。
  - G1: 届けたあとは `available` が true。
  - G2: 接続済み・確認済みの口座には、トークン（16〜4096 文字）と世代（64 桁の 16 進）を返す。
  - **G3: 世代は、トークンを読んだのと同じ時点の `postona_x_resv.x_credential_generation(account)`**（Vault の読み出しと同じスナップショット）。
  - G4: 不明・切断・削除済みには null を返す（例外にしない）。
  - G5: 口座ごとにトークンが違う。ほかの口座のトークンを答えや例外に含めない。
- `accessTokenFor` だけの古い取得口は**受け付けない**（どの世代のトークンか分からないため）。
- G4 側で必要なこと:
  - `x_credential_generation` を G4 の所有者側の関数から読めるようにする。今はどの API 役割からも呼べない。権限は G4 と F3 の合同レビューで決める。
  - 本人確認の判定 `g4_x_account_verified` は PR #257 の K1〜K6 のまま。006 は判定の中身を変えていない。

## 5. F5（利用権）への申し送り — 使い方の報告と追加の条件

- 使っているもの:
  - `public.common_account_brand_service_state(text, text) → text`（stable・definer）
  - `private.account_lifecycle_brand_owner(text) → uuid`
  - どちらも、所有者の役割から、T13 のあとに読むだけ。F5 のファイル・migration・RPC・権限は変えていない。
- 006 は、当てる前に次を確かめる（合わなければ当てない）:
  - 型と volatility
  - 所有者が同じであること
  - **API 役割（anon / authenticated / postona_resv_api / postona_resv_worker）に実行権限がないこと**
- 追加でお願いしたい条件:
  1. `common_account_brand_service_state` の戻り値の `'active'` と、拒否コードの集合を固定してほしい。
  2. 所有者がちょうど 1 人という意味（`brand_memberships.role = 'owner'` が 1 件）を変えるときは、F3 に知らせてほしい。
  3. 停止の処理が `social_accounts.updated_at` を更新する場合、世代が変わり、送信は止まる（安全側）。

## 6. 本番の前に必要なこと（この文書は実行の承認ではない）

1. G4 の Issue #131: 世代付きの取得口（G1〜G5）と本人確認の判定。
2. F5 の候補（T13 と Phase 5 のブランド状態）の承認と適用。
3. 適用の順は 001〜005 → 006 → Edge。ロールバックは Edge → 006 → 005 の順。
4. 本物の Auth・PostgREST・X での確認と、Sol（高）による Auth・トークン・送信の境界の合同レビュー（G4・F5 と一緒に）。
5. 実際の X への投稿は、別の明示的な承認があるまで行わない。
