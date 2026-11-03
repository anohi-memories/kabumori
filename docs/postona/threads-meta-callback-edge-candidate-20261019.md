# G4-01：Threads の Meta コールバックの Edge のソース候補（2026-10-19 JST）

- task_id: `postona-g4-threads-meta-callback-edge-g4issue-20261019`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_CANDIDATE（固定 OFF・未配備・永続の store なし）**。本番で使えるとは判断していない。
- 土台: PR #327（head `743deee0a9c57bc756220523f3b8e24150478df2`）の上。#324 の棚卸しと M1〜M5 の契約は作り直さず、そのまま使った。

## 1. 公式の資料で確かめたこと・確かめられなかったこと（2026-10-19 に閲覧、API は呼んでいない）

| 項目 | 状態 | 出典 |
|---|---|---|
| POST で `signed_request` を1つ送る。形は「base64url の署名」.「base64url の JSON」 | 確認済み（Meta 一般） | Meta「Data Deletion Callback」 |
| 署名は、符号化した payload の HMAC-SHA256。鍵はアプリの秘密 | 確認済み（Meta 一般） | 同上 |
| payload の項目は `algorithm`・`expires`・`issued_at`・`user_id`（アプリ単位の ID） | 確認済み（Meta 一般の例） | 同上 |
| データ削除の応答は JSON `{ url, confirmation_code }`。code は英数字。削除を始めること。HTTPS | 確認済み（Meta 一般） | 同上 |
| Threads のアプリに「Deauthorize callback URL」「Data Deletion Requests URL」の2つの設定欄がある | 確認済み（Threads） | Threads「Create an app」 |
| **Threads が送る形と、`user_id` が Threads の利用者 ID か** | **確かめられない（仮定）** | Threads の文書は、Meta がその URL に "ping" するとしか書いていない |
| 届く形式は form-urlencoded だけか | **仮定** | Meta 一般の文書の例が `$_POST` を読む形 |

- 実際の handler を信用する前に、本番ではない Meta のアプリで本物の呼び出しを1回確かめる必要がある。ゲートを開く条件の1つ。

## 2. 足したもの（G4 の新しいファイルと、G4 の契約テストの拡充だけ）

| ファイル | 内容 |
|---|---|
| `supabase/functions/_shared/social/threads_meta_callback.ts` | `THREADS_META_CALLBACKS_ENABLED = false`、署名の確認 `verifySignedRequest`、2つのコールバックの handler、削除の状態の照会の handler。import は無し。外への通信・`Deno.*`・ログも無し |
| `supabase/functions/threads-meta-callbacks/{index,http}.ts` | 固定 OFF の入口。経路は最後の区切りで決める（`deauthorize`・`data-deletion`・`deletion-status`） |
| `…/_shared/social/threads_meta_callback_test.ts`、`…/threads-meta-callbacks/http_test.ts` | 単体・入口・分離のテスト |
| `supabase/tests/postona_threads_meta_callback_contract_test.ts` | 契約に M6・M7 を追加。M1 に「拒否の応答に要求を写さない」を追加。参照の handler で code の形を確かめるようにした。壊した handler 3種を追加 |
| この文書 | — |

### 安全の性質
- **ゲート OFF**:
  - 入口は、env・本文・store のどれにも触れる前に 503 `THREADS_META_CALLBACKS_DISABLED` を返す（OPTIONS も同じ）。
  - `index.ts` は、ゲートつきの入口を既定の store（無い）で動かすだけ。
- **ゲートを開いても**、永続の store が無い（`noDurableStore` が null を返す）。そのため 503 `STORE_UNAVAILABLE` を返し、何も受け付けたことにしない。
- **署名**:
  - WebCrypto の `verify` で比べる（時間が一定）。
  - 署名は 32 バイトでないと拒否する。
  - `algorithm` は `"HMAC-SHA256"` と完全に一致する必要がある。
  - `user_id` は数字の文字列だけ（JSON の数値は精度が落ちるので拒否する）。
  - `issued_at` は 0 以上の整数が必須。10分を超えて未来のものは拒否する。
  - `expires` は文書に意味が書かれていないので使わない。
- **入力**:
  - POST だけ、form-urlencoded だけ、本文は 8 KiB まで、`signed_request` はちょうど1つ。
  - 拒否は固定のコードだけで、要求・利用者 ID・秘密を返さない。
- **deauthorize**:
  - Threads の利用者に結び付いたアカウント（`UNIQUE (platform, platform_user_id)` なので最大1件）だけを止める。
  - 知らない人にも同じ 204 で答える。
- **データ削除**:
  - store が依頼を**記録して**返した code（英数字 8〜64）のときだけ `{url, confirmation_code}` を返す。url は https で、`?code=` だけを付ける。
  - store の失敗・時間切れ（既定 5 秒）・形の悪い code は 503 にし、**成功と偽らない**。
  - 時間切れの後も store の処理が続いた場合、効果は冪等なので、Meta の再送で同じ code に収束する（store の責任）。
- **状態の照会**:
  - store が記録した `received`／`in_progress`／`completed` だけを返す。
  - 記録が無ければ `unknown`。
  - 想定外の値・失敗は 503。自分から「完了」とは言わない。
- **再送（replay）**: 2つの効果はどちらも冪等なので、同じ署名の要求が再送されても新しい変化は無い。
- **外への通信は0回**。Threads にはアプリ側の取り消しの API が無いので、記録するだけ。

## 3. 未接続の依存（G4 は何もしていない）
1. **永続の store**：SQL の候補と PG17 のテストは次の作業。
   - deauthorize は PR167／169 の解除の規則で止め、Vault の資格情報を使えなくする。
   - データ削除は依頼の台帳と、PR180 の lease つきの後片付けへの受け渡し。
   - データ削除の実行は G5 の T10 の持ち主の同意が要る。
2. **配備の時の設定**:
   - この関数だけプラットフォームの JWT 確認を OFF にする（Meta は Supabase の JWT を送らない。署名が認証になる）。`supabase/config.toml` は変えていない。
   - `THREADS_APP_SECRET` と `THREADS_META_DELETION_STATUS_URL` を設定する。
   - 2つの URL を Meta のアプリに登録する。
   - 削除の状態の照会のページは、人が見る画面の候補として別途作る。
3. **本番ではない Meta のアプリでの本物の呼び出しの確認**（§1 の仮定）。
4. F5 のライフサイクル（アカウントの終了）との関係は、store の段階で G5 と決める。

## 4. テスト（実測。未コミットの変更0で実行）

| 実行したもの | 結果 |
|---|---|
| `deno test --no-config --cached-only --allow-read=.`：新しい2ファイル（自身のテスト 10＋4。どちらも契約テストを import するので、契約の 6 件が2回ずつ数えられる） | 26 passed／0 failed |
| 契約テストだけ（権限なし） | 6 passed／0 failed |
| Threads の TS 全体（`--no-check --allow-read=.`、entry_composition を除く、新しい入口を含む） | 243 passed／0 failed |
| H5 の config で entry_composition と connector | 17 passed／0 failed |
| `deno check`（新しいファイルすべて） | エラー0 |
| `deno lint`（6ファイル） | エラー0 |
| ミューテーション（本体と入口に 28種） | **27/28 を検出** |

- 検出しなかった1件 `skip_sig_length`（32 バイトの確認を外す）は等価な変異。WebCrypto の HMAC の `verify` は、長さの違う署名を必ず false にするため、動作が変わらない。確認は多重の防御として残した。
- 途中で、既存の `threads_connect_contract_test.ts` の分離テストが、新しいファイルのコメントの中のファイル名を「import」と数えて失敗した。コメントを直して合格（既存のテストは変えていない）。
- 送信・書き込み:
  - 外への通信0回（ネットの権限なし）。
  - 偽の store だけ。本物の DB・Vault・Meta・Threads への呼び出しなし。
- NOT_RUN: SQL（store が無い）、アプリの node のテスト（今回はアプリを変えていない）、本物の Meta、管理環境、本番。

## 5. 残る問題
1. Threads の要求の形の仮定（§1）。
2. 永続の store と G5 の同意（§3-1）。
3. 配備の設定と Meta のアプリの登録（§3-2）。ユーザーの段階的な承認が要る。
4. 旧 F4 の archive の不足（MANIFEST／SHA256SUMS／HISTORY_INDEX）は、この作業では解消していない。別の安全ゲートで扱う。

## 6. 行っていないこと
- ゲートを開くこと
- 本番・管理環境の DB／Auth／Edge の適用、Cron、Vault、秘密
- 本物の Meta・OAuth・投稿
- main への push、マージ、デプロイ、force push
- ほかの枠（F3／G3、F5／G5、H5）のファイル、`supabase/config.toml`、Issue 本文の変更
