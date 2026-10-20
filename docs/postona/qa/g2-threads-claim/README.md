# G2 第8世代 — Threads 予約の uncertain 再取得・重複 claim の QA（隔離 PG17、QA専用）

- Issue #317 TASK `postona-g2-threads-uncertain-claim-retry-negative-qa-20261020`
- 対象: G3 候補 007（PR #360 HEAD `266e6119f36c3d1a7a451a6254a5b26a569e7e0b`、#356 → #339 の上、G5 サービス世代つき）。G3/G4 のソースは読み取りのみ。
- 実行: G3 の使い捨てローカル PG 検証 `postona_threads_reservations_run.sh` を**無変更**で動かし、G3 自身の `THREADS_RESV_ROLLBACK` フックで G2 シナリオを rollback 段の直前に差し込む（`run.sh`）。G2 シナリオのあとに G3 本物の rollback が走るので、G3 の RB 検査もそのまま通る。
- 実 DB・実 Threads なし。G3 のテスト用の人物と G4/G5 テストダブルのみ。

## 実在する状態と遷移（007 のソースより）

`planned → claimed`（claim_due、SKIP LOCKED、リース 30–300 秒、サービス世代が active のときだけ。そうでなければ `failed`）

| 現在 | 関数 | 条件 | 次 |
|---|---|---|---|
| claimed | preflight | 自分のリース・期限内・問題なし | claimed（OK） |
| claimed | preflight | **期限切れ** または G4 の更新中 | **planned**（RELEASED、送っていないので返す） |
| claimed | preflight | 公開不可・サービス世代変化・資格情報変化 | failed |
| claimed | preflight | 他人のリース／claimed でない | 変化なし（LEASE_LOST） |
| claimed | record | 期限内 | published / failed / uncertain |
| claimed | record | 期限切れ | **uncertain**（LEASE_EXPIRED_AT_FINISH） |
| claimed（期限切れ） | claim_due の掃除 | 次の claim 時 | **uncertain**（LEASE_EXPIRED、二度と取得しない） |
| claimed | release_unsent | 自分のリース | planned |
| planned | cancel_reservation | 本人 | cancelled |
| published | record（同じ post id） | — | published（冪等） |
| uncertain / failed / published / cancelled | — | — | **どこへも戻らない**（取得対象は planned のみ） |

`sending` 状態は存在しない（送信中は claimed のまま）。

## G3 既存テストで担保済み（作り直していない、今回すべて PASS を読み戻し）

L4 claim→preflight→record→receipt／L5 claim 後の変化（期限切れ preflight は RELEASED 含む）／L6 期限切れの遅い record・掃除・uncertain は再取得しない／L7 release・cancel／L9 サービス世代 ABA／R 2つの claim が重ならない（SKIP LOCKED）／E1–E5 dispatcher×PG（二重送信なし、unknown→uncertain）。PR #365 の G3×G4 境界13件も再実装していない。

## G2 が足した「組合せ」（`g2_claim_scenarios.sql`、すべて PASS）

| ID | シナリオ | 結果 |
|---|---|---|
| C1 | A が再確認 OK → 公開（A の記録が遅い）→ リース切れ → **B の claim が先に掃除**して uncertain → A の遅い「published」記録 | 記録は拒否（LEASE_LOST）、行は uncertain・post id なしのまま、どの worker・再起動後も**再取得されない**（2回目の公開なし。投稿は実在しうるので uncertain が正しい） |
| C2 | A の preflight #1 OK → **コンテナ待ちの間にリース切れ** → A の再確認は RELEASED（公開しない）→ planned に戻る → B が**新しいリース**で再取得 → A の古いリースの再確認・記録は拒否 → B が公開 | 取得2回、公開記録1回。同じ post id の再記録は冪等、別 id は拒否、以後再取得なし |
| C3 | リースが生きている間に worker が再起動して claim | 再選択されない。A が uncertain を記録した後も再取得されない |
| C4 | ソース走査 | `planned` に書けるのは自分の claimed リースを返す release_unsent と preflight だけ。claim_due は uncertain を選ばない |

### 負例コントロール（同じ DB 内で関数を一時差し替え → savepoint で元に戻す）: **3/3 検出**

NC1 claim_due が uncertain も選ぶ／NC2 preflight が期限切れを OK 扱い／NC3 record が claimed でない行への遅い published を受け付ける

## 観察

- C2 の流れでは Threads 側に**未公開のコンテナが1つ残る**（A の分）。公開されず期限切れになるので投稿は1回だが、コンテナ待ちがリースより長いと起こる（リース最短30秒、G4 の待ちは最大10回×間隔）。
- C1 では実際には投稿済みでも記録は uncertain（post id なし）になる。G3 の receipt は uncertain を返すため利用者には「確認できない」と出る — 設計どおり（二重投稿より安全側）。

## 手動投稿 UI（別経路）との区別

この予約 claim の結果で、手動 Threads 投稿 UI の **G2-T1（P2、新しい冪等キーでの2回目公開）が直ったとは判定しない**（別モジュール・未修正）。

## 実行

```bash
RESV_PGHOST=/private/tmp/<socket> RESV_PGPORT=<port> RESV_PGSUPER=<superuser> RESV_G5_SOURCE_DIR=<G5 source> \
  docs/postona/qa/g2-threads-claim/run.sh
```

今回の実行: 自分専用の Homebrew PG17 クラスタ（他 slot のクラスタとは別ポート・別ソケット、実行後に停止）、G5 ソースは G5 PR #285 の commit `3a5eef3d` を自分専用の worktree に取り出したもの（実行後に削除）。結果は `run.log`。
