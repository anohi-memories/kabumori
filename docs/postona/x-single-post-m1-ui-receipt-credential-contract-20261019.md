# POSTONA X 単発投稿 — アプリの結果表示・本文なしの受領票・原子的な資格情報の契約（2026-10-19、F3）

- task_id（予定）: `postona-f3-m1-ui-receipt-atomic-credential-contract-offline-20261019`
  - **main には未登録**。main へのコミットが Vercel の本番デプロイを起こす状態が続いているため、登録していない（§7）。
- 判定: **PASS_OFFLINE_CONTRACT_ONLY（本番 NO_GO）**
  - F3 の文書・型・独立した契約テストだけで確認した。DB・Auth・X・Vault・ネットワークには触れていない（テストはネット不許可で実行）。
  - 本物の X には送っていない。
- 対象:
  - F3: PR #278（head `bf76a7c7b54ff8aa1155aace2045235e9408c18a`）の上
  - G1: PR #283（`b4b761c4dd43`）・PR #288（`c41e20ce508530328570d22c4a0cbc0a43fb2a2e`）
  - G4: PR #282（`39b9064dc79ad52b430ba820006cd3310bf3140f`）
  - F5: PR #275・#285

## 1. 本文なしの受領票（read-only receipt）は、今は存在しない

| 既存の読み取り | 受領票に使えない理由 |
|---|---|
| `post_now_begin` の繰り返し | **本文（とその SHA-256）が必要**。G1 PR #283 は再起動後、本文を持たない（ハッシュだけ）ので、利用者が同じ本文を打ち直す必要がある |
| `post_now_readback(reservation_id)`（006） | 予約 ID が必要（アプリは持っていない）。Edge の入口もない |
| `get_reservation` / `list_reservations`（002・001） | **本文を返す**。X の ID・結果のコード・`simulated` / `afterFreeze` を返さない。`assert_account_access` を通るので、利用終了後や G4 の確認が外れた後は、本人の結果も読めない |

**結論**: `clientRequestId` と `socialAccountId` だけで、本文なしに結果を返す読み取りの API はない。指示どおり実装はしていない。

### 必要な契約（提案。実装は F3 の別 TASK）

- 型と読み方は `single_post_receipt_contract.ts`（PROPOSED）に置いた。
- 送り先: `POST /functions/v1/postona-x-single-post-receipt`
  - 本文はちょうど `{ socialAccountId, clientRequestId }`。本文もハッシュも送らない。URL にも何も載せない。
- 返答は送信と同じ形（`sent` / `pending` / `failed` / `uncertain`、`simulated`、`afterFreeze`）。加えて、該当がなければ 404 `POSTONA_RESV_RECEIPT_NOT_FOUND`。
- サーバーが守ること:
  - R1 **読むだけ**: 書かない、もう一度使えるようにしない、送らない。期限の切れた claimed も、書き換えずに `uncertain LEASE_EXPIRED` と答える。
  - R2 **確認済みの本人に結び付ける**: 他人・他の口座・不明な ID は、どれも同じ 404（存在を推測させない）。
  - R3 本文・ハッシュ・トークン・リースを返さない。
  - R4 印は送信と同じ: `simulated` が false になるのは、本物の X で送った記録があるときだけ。
  - R5 404 は「この ID は始まっていない」。begin は X を呼ぶ前に行を確定するので、その ID での投稿はない。ただし begin が実行中かもしれないので、アプリは**同じ ID でだけ**再試行する。新しい ID は使わない。
- 担当:
  - F3: `postona_x_resv` の読み取り関数と Edge の入口
  - F1: 再起動後の画面で使う
  - F5: 利用終了後も本人の結果を読めるようにしてよいかの判断（R2）。セッションは生きている必要がある。
- 実装までの扱い: 再起動後は、今の G1 の方法（同じ本文を打ち直してハッシュを合わせ、同じ ID で送る）が唯一の正しい道。

## 2. G1 PR #283 / #288 とのレスポンス契約の照合

- F3 は答えの表 `contract_vectors/single_post_result_vectors.json`（34 件）を持つ。
  - 6 種類（sent / pending / failed / uncertain / refused / unavailable）をすべて含む。
  - `simulated` の欠落・`"false"`・null、`afterFreeze` の `"true"`、ID の欠落・不正、503 と 4xx を含む。
- F3 の `singlePostResultOf` は 34 件すべてで期待どおり（C1）。
- **G1 PR #288 の `single-post-contract.ts` を、作業用フォルダで同じ 34 件に当てたところ、すべて同じ答えだった**（照合のためだけで、F3 の PR には含めていない）。
- `POSTONA_RESV_SERVICE_BUSY` は 503 なので `unavailable`。G1 では「未確認・同じ ID で再試行」になる。
- 新しいコード `PUBLISH_DISABLED` / `CREDENTIAL_DEGRADED` は 403 で `refused`、再試行不可。

## 3. simulated=true を本物の投稿として出さない

- F3 は、送信手段が `simulated`（テストの偽の X）のとき、**どの経路でも `simulated:false` を返さない**（S1）。DB が本物だと言っていても同じ。
- 本物の送信手段でも、`simulated:false` になるのは、保存された印がちょうど false のときだけ。欠落・null・`"false"`・0 は true（S2）。
- G1 PR #288 は、`simulated` の `published` を `sent` にせず、未解決として残す（「X で確認してください」）。受領票の次の一手も同じにした（`keep_unresolved_check_x`）。

## 4. uncertain を自動で再送しない・再起動後に二重送信しない

- サーバー側（F3）で確かめたこと:
  - 保存済みの `uncertain` / `sent` / `failed` を、新しいプロセスが同じ ID で繰り返しても、読み直すだけで送らない。トークンも読まない（U1）。
  - 同じ ID で別の本文は 409（何も書かず、送らない）。処理中は `pending IN_PROGRESS`（U2）。
  - X を呼んだ後に結果が分からないとき（タイムアウト・記録の喪失・読み直し不能）は `uncertain` で、X へは 1 回だけ（U3）。
- **サーバーが二重送信を防げるのは、同じ `clientRequestId` の範囲だけ**。新しい ID で送れば、サーバーは別の試みとして扱う。
  - 再起動の後に新しい ID を作らないのはアプリ（G1 PR #283 のハッシュだけの記録と、送信のゲート）の責任。
  - 受領票（§1）ができれば、本文を打ち直さなくても状態を確かめられる。

## 5. G4 PR #282 の原子的な資格情報

- `credentialFor(account) → { token, generation } | null`。
  - generation は F3 の `postona_x_resv.x_credential_generation`（64 桁・小文字の 16 進）。G4 の 003 は、G4 の判断とトークンと世代を**1 つの文・1 つのスナップショット**で返す。
  - 旧 32 桁の世代は G4 側で廃止済み。
- F3 側で確かめたこと:
  - G1: 単発投稿が呼ぶのは `credentialFor` だけ（1 回）。`accessTokenFor` は 0 回。送るのは受け取ったトークン。
  - G2: 64 桁の小文字でない世代は、preflight と一致していても送らない（32 桁・大文字・65 桁・空・hex 以外）。一致しない世代も送らない。
  - G3: 別々の取得方法は「未接続」として 503、何も書かない。トークンだけの取得口も、トークンと世代を別々に取る取得口も同じ。
  - G4: G4 の固定の例外（`XCredentialSourceUnavailable`）と null は送らない（`X_CREDENTIALS_UNAVAILABLE`）。例外の文言は返答に出さない。
- **G4 PR #282 の実際の `x_posting_credential_source.ts` を作業用フォルダで動かした結果**:
  - 偽の所有者向け問い合わせで、F3 の G1〜G5 を満たした。
  - 既定（無効）は、F3 から見て未接続。
  - 32 桁の世代や問い合わせの失敗では、F3 の流れは送らなかった。
- 違い（安全側）: G4 の口座 ID の形は `^[a-z][a-z0-9_]{1,80}$` で、F3 の要求の形（`^[A-Za-z0-9_:-]{1,128}$`）より狭い。外れる ID は G4 が null を返すので、送られない。

## 6. F5 の送信直前の認可と、資格情報の世代の変更

- 開始時の拒否（T13・F5 のブランド状態・所有者・スイッチ・G4・劣化・投稿権限・ブランド）は、固定の HTTP 状態とアプリの種類に対応する。どれも送らず、トークンも読まない（F1）。
- 送信直前（preflight）の拒否:
  - `NOT_PUBLISHABLE`（F5 の状態・所有者・スイッチの変化）と `CREDENTIAL_CHANGED` は `failed`。
  - `RELEASED` は `pending`、`LEASE_LOST` は `uncertain`。
  - いずれもハンドラは何も記録せず、送らない（F2）。
- トークンを読んだ後に世代が変わった場合は、preflight の新しい世代が優先され、`CREDENTIAL_GENERATION_CHANGED` で送らない（F3）。
- 本物の SQL での確認は PR #278 の `single_post_live_fence_run.sh`（L4・R1・E3・E4）にある。今回は再実行していない。
- 残る点: F3 の世代は、ワークスペースの所有者の uuid を含むが、F5 PR #285 の owner epoch は含まない。
  - そのため、送信 1 回の間に A→B→A と所有者が戻った場合は、資格情報の行が変わっていない限り区別しない。
  - そのとき送信直前の所有者は A なので、送っても正当だと考えている。
  - F5 の epoch が適用された後に世代へ含めるかは、F5・G4 と決める（提案）。

## 7. 登録と push の扱い

- 総合指令室（Issue #269 #6260001714）と Issue #286 の「main への管理コミットが Vercel の本番デプロイを誘発する安全ゲート」は、**未解除と判断した**。
  - 2026-10-19 01:29（日本時間）のアーカイブだけのコミット `865f7634` で、Vercel の Production deployment が完了していた。Ignored Build Step 保存の報告（01:24）の後。
  - 直近の管理コミットでも、デプロイの試み（上限による失敗）が続いている。
- そのため、新しい F3 TASK は **main に登録していない**。TASK と ACTIVE への書き込みも、Report の main 反映もしていない。
- この作業は PR ブランチ（Draft PR）だけで行った。Report は PR の本文と `docs/postona/reports/` に置いた。

## 8. この文書が承認しないこと

- 受領票の実装、新しい RPC・DB・Edge
- G1 の画面、G4 の OAuth・トークン、G5 の Auth・利用権の変更
- 本物の X への投稿、migration の適用、merge、deploy、main への push
