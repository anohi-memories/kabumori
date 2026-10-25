# G4-37：OAuth の state・遅れた callback・古い token とリースのオフラインの負の QA（2026-10-25 JST）

- task_id: `postona-g4-oauth-state-replay-stale-callback-old-lease-offline-qa-20261025`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **MOCK_PASS（偽のデータの決まった順の模型だけ）／実行時は SOURCE_NOT_VERIFIED／PRODUCTION_NO_GO**
  - DB・network・OAuth・Meta・Vault は使っていない。
  - 本人と作業場所は G5 が決める外の判定として扱った。R0 や古い brand の扱いは決めていない。
  - 製品・既存の候補・G4-35／36 のファイル・G3／G5／H5 は変えていない。
- 土台: PR #491（`85d3891a7587a7566579a793083f540952664fa6`）。版の固定: G4 `b963683b…`（PR #482）、G5S `21a5cad4…`（PR #457）。

## 1. ファイルと実行
- `supabase/tests/postona_g4_oauth_state_replay_offline_qa.mjs`（依存なし）
  - 行のロックの決まった順の模型。`UPDATE … WHERE consumed_at IS NULL` は持ち主を待ち、終わった後で commit 済みの行を見直す（READ COMMITTED）。
  - source の行の照合（13件、`git show`）。
  - 欠陥の切り替え（`G4_37_MUTANT`）。
- 実行: `node supabase/tests/postona_g4_oauth_state_replay_offline_qa.mjs <固定した commit を持つ clone>`

## 2. 結果（2026-10-25 JST）
**14件 MOCK_PASS、source の照合 13/13、欠陥 7/7 を検出**

| # | 場面 | 期待（source の根拠） | 結果 |
|---|---|---|---|
| R1 | 同じ state に callback が2つ同時に来る | 1つだけ接続する。もう1つは行のロックを待ち、`ALREADY_ATTESTED`（state の消費 `@G4:L295`、入口 `001@G4:L256`） | MOCK_PASS |
| R2 | 1つ目が途中で失敗して戻る | 待っていた再試行が接続する（トランザクションごと戻る。G4-24 の C8 で実測） | MOCK_PASS |
| R3 | 遅れた callback（期限切れ） | `STATE_NOT_CONSUMABLE`（`@G4:L302`） | MOCK_PASS |
| R4 | 成功の後の重複（結果が分からず H5 がやり直す） | `ALREADY_ATTESTED`。H5 は binding を読んで結果を知る | MOCK_PASS |
| R5 | 別の人が A の state を使う | `NOT_INITIATOR`（`001@G4:L251`） | MOCK_PASS |
| R6 | begin と callback の間に所有者が変わる | `ACCOUNT_NOT_OWNED`（`@G4:L292`） | MOCK_PASS |
| R7 | 所有者の ABA（A→B→A） | `OWNER_EPOCH_CHANGED`（`001@G4:L280`。epoch は進むだけ `oe@G5S:L264`） | MOCK_PASS |
| R8 | 切断の後の、切断の前の state | 拒否（切断が state を消す `disc@G4:L187`） | MOCK_PASS |
| R9 | 切断・再接続の後の古いリースと古い token | `LEASE_NOT_HELD`、古い token は今の token ではない | MOCK_PASS |
| R10 | リースを持ったままの再接続 | `LEASE_NOT_HELD`（A の trigger `a001@G4:L86`） | MOCK_PASS |
| R11 | 古い保留の state が後から完了する | binding が後の完了に移り、前のリースは終わる（`001@G4:L291`、G4-14 の「最後の完了が勝つ」） | MOCK_PASS（記録） |
| R12 | 2つの worker の claim | `LEASE_HELD`（`rot@G4:L234`） | MOCK_PASS |
| R13 | rotate の結果が分からず、同じリースでやり直す | `LEASE_NOT_HELD`（一度だけ `rot@G4:L338`）。worker は custody を読み直して結果を知る | MOCK_PASS |
| R14 | ふつうの流れ | 接続 → claim → rotate | MOCK_PASS |

| 欠陥 | FAIL になった件 |
|---|---|
| ロックなしの消費 | R1〜R4 |
| rollback が消費を残す | R2 |
| epoch を比べない | R7 |
| epoch が所有者で決まる（元に戻る） | R7 |
| 切断が state を残す | R8 |
| 再接続がリースを残す | R10・R11 |
| リースが一度だけでない | R13 |

- 最初の実行では、epoch の欠陥（`epoch_not_monotonic`）を検出できなかった。原因は欠陥の作り方で、値が元に戻らず負になっていた。「所有者が A に戻ると元の値に戻る」形に直して、検出した。

## 3. 本物との区別
- 模型は source を写したもの。本物の SQL での実測は、G4-24〜34 の隔離 PG17 にある分だけ（R2 の一体性、R5、R7、R10、R12、R13 の近い形）。
- R1（同時の callback）・R3・R4・R8・R11 は、本物の SQL では**未実測**。

## 4. G5・G3 への質問
- **G5**
  - Q10: 匿名の session（S1-F2）が T13 で拒否されるようになったら、begin も callback も同じ code で拒否するか。H5 の結果が分からないときの読み直しの経路（binding・接続の状態の読み出し）も、同じ session の確認の下に置くか。
  - Q11: 所有者の ABA で `OWNER_EPOCH_CHANGED` になった接続は、再接続を求める（G4-24 の C5 の実測のとおり）でよいか。
- **G3**
  - Q12: X の begin・worker でも、state の1回だけの消費と「最後の完了が勝つ」の扱いを同じにするか。G3-30（UNKNOWN と冪等性）の結果の読み直しの規則と合わせるか。
- **OPEN のまま**（#299）: locked／ban、共有の作業場所の移行、ログアウト、保持の期間。

## 5. 残件
- D8、候補 005（token の読み出し）、H5 の transport、本物の Vault の ACL、独立のセキュリティのレビュー（Codex Sol（高））。
- PR #124 の authenticated の EXECUTE は有効にしない。Issue #131 は延期のまま。
