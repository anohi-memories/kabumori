# G2 第7世代 — Threads 公開直前 hook の境界 QA（G3 dispatcher × G4 送信ポート、オフライン、QA専用）

- Issue #317 TASK `postona-g2-threads-prepublish-hook-negative-offline-qa-20261020`
- 対象: G4 PR #359 HEAD `4ddc0b1d1ea880eabddd5ae7ca58cfd1b0894e2a`（送信ポート、親 #347 `573c48a34ee84be730f7900686f259988eda3a94`）× G3 PR #356 HEAD `12fcba7e076e467595ae58d93af05cb09e354c6a`（予約 dispatcher の beforePublish）。2つは別スタックのため、`run.sh` が G3 のファイルを固定 commit から一時ディレクトリに取り出して合成する。
- 分類: **source 契約のみ**（両方とも固定 OFF、実配線なし。G3 は `THREADS_DISPATCH_ENABLED=false`、G4 の配布用ポートは閉じている）。実 Threads は NOT_VERIFIED。
- オフライン: deno にネットワーク権限を与えていない。Threads Graph API と予約ストアは台本どおりのフェイク。G3・G4 の既存テストは作り直さず、**境界の失敗組合せ**だけを足した。

## 呼び出し順と責任の境界

```
G3 runThreadsReservationDelivery
 ├ claimDue（ストア）
 ├ credentialFor（G4 資格情報ポート：token + generation を1回で）
 ├ preflight #1（G3：所有者・利用権・停止・世代・リース）  … NG なら送信しない
 └ G4 send(credential, text, { beforePublish })
      ├ コンテナ作成  POST /{user}/threads          … ここで Threads 側に「未公開のコンテナ」ができる
      ├ 状態待ち     GET /{container}?fields=status  … FINISHED まで
      ├ beforePublish()  ← G3 preflight #2（同じ行・同じリース・同じ世代、上限 5 秒）
      │     true 以外（false・例外・時間切れ・世代変更）→ 公開要求0、not_written publish
      ├ 公開要求     POST /{user}/threads_publish    … 最大1回、再送なし
      └ 読み戻し     GET /{media}                     … confirmed のときだけ published
 └ record（G3：published / failed_before_send / uncertain）
```

## 結果（`g2_threads_prepublish_boundary_test.ts` 13件 PASS）

| ケース | コンテナ | 公開要求 | 記録 |
|---|---|---|---|
| 正常（両側とも実ソース） | 1 | **1** | published（hook 1回） |
| 再確認 NG：権限・停止・公開不可（NOT_PUBLISHABLE） | 1 | **0** | 記録なし（ストアが既に判断）・skipped |
| 再確認 NG：リース喪失（LEASE_LOST） | 1 | **0** | 記録なし・skipped |
| 再確認 NG：取消・返却（RELEASED） | 1 | **0** | 記録なし・released |
| 再確認 NG：サービス世代（epoch）変更 | 1 | **0** | failed_before_send `CREDENTIAL_GENERATION_CHANGED` |
| 再確認 NG：ストア例外 | 1 | **0** | failed_before_send `THREADS_PREPUBLISH_UNVERIFIED` |
| 再確認 NG：時間切れ | 1 | **0** | failed_before_send `THREADS_PREPUBLISH_UNVERIFIED` |
| 公開要求の応答喪失 | 1 | 1 | **uncertain**（published でも failed でもない） |
| 同じ行が1回の取得に2回（ストアが通しても） | 1 | 1 | 2回目は送らない |
| 公開済みだが読み戻し不明 | 1 | 1 | **uncertain**（published にしない） |
| 2つの worker が同じ行を取り合う | — | 合計 **1** | リースが残る側だけ |
| 配布用 G4 ポート（閉） | 0 | 0 | 取得もしない（notAvailable） |

- **準備済みコンテナ ≠ 公開済み**: 再確認 NG のケースでは Threads 側に未公開コンテナが1つ残るが、公開要求は出ず、published とも記録しない（コンテナは Threads 側で期限切れになる）。
- **OBSERVATION（P3、owner G3/G4）**: G3 はポートが hook を守るかを確かめられない。hook を無視するポート（第3引数を使わない旧形）だと、G3 の再確認が NG でも公開され published と記録される（再確認0回）。現状は配布用ポートが G4 のもの（hook 必須）だけなので実害はないが、G3 側で「hook 対応ポートのみ受け付ける」宣言を確認するか、G4 の型で hooks を必須にするのが安全。

## 負例コントロール（`negative-controls.log`）: 5/6 検出

G4 の送信ポートは一時改変して各回復元、G3 は一時コピーだけを改変。
- 検出: G4「hook 拒否でも公開」／G3「再確認が世代を見ない」／G3「読めない・遅い再確認を OK 扱い」／G3「同じ行を2回送る」／G3「読み戻し不明を published 扱い」
- 未検出1件: G4「hook の例外を許可扱い」— G3 の hook は内部で例外を握りつぶして必ず true/false を返すため、境界からは到達できない。G4 自身のテスト（`threads_send_port_test.ts`）が担保している。

## その他

- G4 既存テスト `threads_send_port_test.ts` + `threads_connect_to_send_test.ts`: 35件 PASS（`g4-existing-suites.log`）。
- G3 既存テストは #356 のツリーが必要なため本ブランチでは実行していない（G3 の REPORT を参照）。
- G2-T1（P2）・T2（P3）・U1/U2・iOS27 native・Android 端末: 修正 HEAD なし → 未修正のまま（再実行・再投稿なし）。

## 実行

```bash
docs/postona/qa/g2-threads-prepublish/run.sh
```
