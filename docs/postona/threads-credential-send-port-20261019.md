# G4-02：Threads の資格情報と送信の port（G3 の予約との接続の候補、offline）（2026-10-19 JST）

- task_id: `postona-g4-threads-credential-send-port-offline-source-20261019`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_CANDIDATE（固定 OFF・どこにも接続しない・本物の資格情報の SQL なし）**。PRODUCTION_NO_GO。
- 土台: PR #335（head `9c5b7bfb95623ae20dc23f7544f70dfa8a38e410`）の上。
- 照合した G3 の版: PR #334 の head `8f7a1e3914e41a6db5dcaee64224c4b5817afce9` の `threads_dispatch.ts`（SHA-256 `875175a5…`）。**G3 のファイルは変更していない**。

## 1. G3 の求める IF と、G4 の既存のコードの照合

| G3 が求めるもの | G4 の既存のコード | 状態 | この PR |
|---|---|---|---|
| 2段階の投稿の通信（コンテナを作る→状態の確認→公開→読み戻し） | `threads_publish_contract.ts`：`createThreadsTextContainer`、`readThreadsContainerStatus`、`publishThreadsContainer`、`readThreadsPublishedPost` | **実装済み**（PR #140 の系統）。各段階が1回の要求、再送なし、`not_written`／`unknown` を分ける | そのまま使う（通信のコードは新しく書いていない） |
| 段階つきの結果 `ThreadsSendOutcome` | `ThreadsPublishError(code, outcome)` | 段階の情報が無い（手動の投稿は段階ごとに DB の試行記録へ書くため） | **新規** `threads_send_port.ts` の `send` が段階を付ける |
| `ThreadsSendPort { available, transport, send }` | 無し（手動の投稿 `threads_manual_publish.ts` は、段階ごとに DB で release／record する別の流れ） | **不足** | **新規**。`createThreadsSendPort`（本物の通信、固定 OFF）、`createGatedThreadsSendPort`（テスト用、`simulated`） |
| `ThreadsCredentialPort.credentialFor` → 判断・トークン・世代を**1つの文**で | 手動の投稿の release（`threads_publish_release_candidate.sql`）は試行ごとの付与で、世代を返さない | **不足**。本物の SQL は無い | **新規**。1回の呼び出しだけを受け、行の形を厳しく確かめる。文が無い・キーが未決定・ゲート OFF なら常に null |
| 世代の関数（64桁の小文字の16進） | 無し | **G3 の持ち物**（予約の schema） | 作っていない |
| Threads の投稿の利用権（service key） | 無し（今は `kabumori`・`x_autopost` だけ） | **G5 の判断待ち** | `THREADS_POSTING_SERVICE_KEY = null`。`x_autopost` と `kabumori` は拒否し、流用しない |
| dispatcher・予約・結果・受領票 | — | **G3 の持ち物** | 触っていない |

## 2. 送信の結果の対応（`send` の中身）

| 起きたこと | G4 の結果 | G3 の判断（PR #334 の `dispatchOutcomeOf`） |
|---|---|---|
| 入力の不正（ID・トークン・本文） | `not_written` container `THREADS_REQUEST_INVALID`（要求0件） | failed_before_send |
| コンテナの作成の明確な拒否（4xx） | `not_written` container | failed_before_send |
| コンテナの作成の不明（通信の失敗・5xx・読めない 2xx） | `unknown` container | failed_before_send（コンテナの ID を持たないので、投稿になり得ない） |
| コンテナが ERROR／EXPIRED、規定回数で準備ができない、状態が読めない | `not_written` publish（公開の要求をしていない） | failed_before_send |
| 自分が公開していないのにコンテナが PUBLISHED | `unknown` publish（もう一度は公開しない） | uncertain |
| 公開の明確な拒否 | `not_written` publish | failed_before_send |
| 公開の不明 | `unknown` publish（再送しない） | uncertain |
| 公開して、読み戻しで同じ ID・同じ所有者・permalink | `published` confirmed | published |
| 読み戻しで別の ID か別の所有者 | `published` mismatch | uncertain |
| 読み戻しの失敗 | `published` unknown | uncertain |

- `unknown` readback は出さない。公開の応答に media の ID があれば、`published` に読み戻しの状態を付けて返す（G3 では同じ uncertain になる）。
- 要求の数: コンテナ1回、状態の確認は最大 N 回（既定3回・3秒おき・上限10回）、公開は最大1回、読み戻し1回。
- 再試行はしない。ログも出さない。トークンは書き込みの URL に入れない（既存の通信の規則のまま）。

## 3. G3 に伝える、閉じていないこと
1. **コンテナの待ちの間の再確認**:
   - G3 の preflight は send の前に1回だけ。
   - send の中のコンテナの待ち（既定で最大 約6秒）と公開の要求の間に、所有者・利用権・凍結の再確認が無い。
   - 手動の投稿は、要求のたびに DB で再判断している。
   - 提案（G4 は実装していない）: send に「公開の直前の再確認」の hook を足すか、G3 が待ちを短くする。
2. **資格情報の取得の順**: G3 は `credentialFor` → `preflight` の順で、世代を比べる。G4 の port は呼び出しのたびに文を1回だけ実行し、キャッシュしない。
3. **本物の資格情報の文**（SQL）が無い。必要なのは、`social_accounts`（Threads、verified）、Vault の中身、G3 の世代の関数、G5 の利用権を、1つの SECURITY DEFINER の文で評価するもの。G4 は提案だけで、未承認の共有 DB・SECURITY DEFINER は作っていない。
4. **G5 の service key** が決まるまで、資格情報の port は使えない（設計どおり）。

## 4. テスト（実測）

| 実行したもの | 結果 |
|---|---|
| `threads_send_port_test.ts`（`--allow-read=.` だけ、ネット・env なし） | 16 passed／0 failed |
| Threads の TS 全体（`--no-check --allow-read=.`、entry_composition を除く、新しいテストを含む） | 259 passed／0 failed |
| H5 の config で entry_composition と connector | 17 passed／0 failed |
| check・lint（2ファイル） | エラー0 |
| ミューテーション（25種） | **25/25 を検出** |
| G3 PR #334 の `threads_dispatch.ts`（変更なし）× G4 の port の重ね合わせ（作業用フォルダだけ、コミットなし、型チェックあり） | 4 passed |

- ミューテーションの例:
  - 不明を `not_written` とみなす（コンテナ・公開）
  - 公開の再送
  - FINISHED の前の公開
  - PUBLISHED の再公開
  - 読み戻しの不一致・失敗を確認済みとみなす
  - 読み戻しの省略
  - 状態の確認の上限なし
  - transport の偽装・凍結なし
  - 別アカウントの行、世代の大文字・桁数、余分な列、複数の行
  - キャッシュ、文のエラーの伝播、ID の形の確認なし
  - ゲート ON・キーの推測・`x_autopost` の許可
- 重ね合わせで確かめたこと:
  - G4 の port の型が G3 の型に当てはまる。
  - G4 の deployable の port では G3 は何も claim しない。
  - 結果の対応（上の表）。
  - 世代が変わると送信0件。
- 外への通信0回（偽の Threads だけ）。本物の DB・Vault・トークン・Meta・Threads なし。
- NOT_RUN: SQL（文が無い）、本物の Threads、管理環境、本番。

## 5. 行っていないこと
- ゲートを開くこと、service key を決めること
- DB・RLS・Auth・RPC・SECURITY DEFINER・GRANT、Edge の配備、Cron
- 本物の Meta・OAuth・トークン・Vault・投稿
- main への push、マージ、デプロイ
- G3 の `threads_dispatch.ts` の変更、G5・H5 のファイル、既存の `threads_publish_contract.ts`・`threads_manual_publish.ts` の変更
