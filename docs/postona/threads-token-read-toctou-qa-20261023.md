# G4-34：Threads の token の照合から取得までの隙間（TOCTOU）の、隔離した PG17 の競合 QA（2026-10-23 JST）

- task_id: `postona-g4-threads-token-read-toctou-isolated-qa-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **TOCTOU を決まった順で再現（EXPECTED_FAIL）／隔離候補 005 で release の隙間を閉じた（使い捨ての PG17・偽の Vault の上だけ）／PRODUCT_NOT_FIXED／INDEPENDENT_REVIEW_REQUIRED／PRODUCTION_NO_GO**
  - 製品の修正の完了ではない。採用・適用・マージはしない。
  - 既存の SQL・migration・候補（release・投稿・custody・A・C・④・要約）・H5／G3／G5 のファイル・既存の PR の head は変えていない。
  - D8（特権者による Vault の書き換えと custody の再記録）は、既知の未解決のまま扱う。
- 土台: PR #479（`f88d2bee64aeae67384c6148cb95fd6bc5916e51`、G4-33 の要約の候補）

## 1. 新しいファイル（G4 だけ）
| ファイル | 内容 |
|---|---|
| `supabase/candidates/postona_threads_rotation_lease_invalidation/005_rotation_verified_token_read.sql` | 隔離候補: 照合と取得を1つの文で行う `threads_credential_verified_token`。release の token の読み出しをそれに置き換える |
| `supabase/candidates/postona_threads_rotation_lease_invalidation/005_rotation_verified_token_read_rollback.sql` | その rollback（順が違えば拒否） |
| `supabase/tests/postona_threads_token_read_toctou_barrier.sql` | **試験の世界だけ**の仕掛け（偽の Vault の view の中の advisory lock）と、release を呼ぶ補助 |
| `supabase/tests/postona_threads_token_read_toctou_run.sh` | runner（`TQ_*`。1〜3節と補助は G4-33 の runner の写し。`TT_KEEP_DB=1` で DB を残す、調べるときだけ） |
| この文書 | |

## 2. source から特定した隙間
| 読む側 | 照合の文 | token の文 | 隙間 |
|---|---|---|---|
| **投稿の release** `release_threads_manual_publish_step`（`threads_publish_release_candidate.sql`） | `threads_manual_publish_authorize` の中の期限の読み出し（要約の照合を含む） | 273行の `select ds.decrypted_secret … from vault.decrypted_secrets` | **ある**（READ COMMITTED では文ごとにスナップショットが変わる） |
| `credential_row`（PR #412） | 同じ SELECT の中 | 同じ SELECT の中 | 無い |
| 手での投稿の `redeem`（`threads_manual_publish_candidate.sql` 506行） | — | — | **今の組み合わせには無い**。release の候補が `redeem`／`claim_threads_manual_publish_step` を消している（release 80〜82行） |
| H5 の延長（claim の後に token を読む。設計） | claim の要約の照合 | H5 の別の SELECT | **ある**（H5 のコードはまだ無い。模型で再現） |

- release はアカウントの行を FOR SHARE で持つ（authorize）。そのため、アカウントの行を取る正しい書き手（入口の再接続）は隙間に入れない（T6）。
- アカウントの行を取らない直接の Vault の書き手だけが入れる。

## 3. 決まった順にする仕掛け（試験の世界だけ）
- 偽の `vault.decrypted_secrets` の view を、行ごとに `g4test.toctou_hook(id)` を呼ぶ形にした。
- session が secret の id で「構え」たときだけ、その id の**最初の**評価で advisory lock 774100 を待つ。
- 攻撃役の session がその lock を持っておき、被害役が待ちに入ったのを `pg_locks` で確かめてから、Vault を直接書き換えて commit し、lock を放す。
- 待った文は、始まったときのスナップショットのまま進む（書き換えは見えない）。次の文には見える。こうして「照合した」と「読んだ」の間が、毎回同じ順になる。
- これは製品の object ではない。偽の Vault の上でだけ作る。

## 4. 結果（`TQ_* bash supabase/tests/postona_threads_token_read_toctou_run.sh`、PostgreSQL 17.11、ローカルの socket、外部への通信は0）
最終の判定: `POSTONA_THREADS_TOKEN_READ_TOCTOU_RUN_PASS`（clean な HEAD での実行は REPORT に記す）

| 節 | 確かめたこと | 結果 |
|---|---|---|
| 4 | 005: 要約が無い → `PRECONDITION_DIGEST`。release の本体がずれている → `PRECONDITION_RELEASE`。所有者でない → `PRECONDITION_OWNER`。二度目 → `ALREADY_APPLIED` | PASS |
| 5 | **T1: release（004 だけ）**。照合と取得の間に commit された直接の書き換えが、そのまま渡される（`access_token` = 照合していない token、試みは `creating_container` に進む） | **EXPECTED_FAIL（再現）** |
| 5 | T2: `credential_row`（1つの文）。同じ攻撃でも、照合した token を返す（そのスナップショット）。その後の読み出しはすべて拒否 | PASS |
| 5 | **T3: H5 の模型**（claim の後、同じトランザクションで生の SELECT）。生の読み出しは照合していない token を返す（Meta に送られうる）。`rotate_and_store` はその後 `CREDENTIAL_CHANGED` で、何も保存しない | **EXPECTED_FAIL（読み出し）**／保存は PASS |
| 5 | T4: REPEATABLE READ（比較だけ）。release は読む前に拒否する（G5 の柵が READ COMMITTED を求める: `ACCOUNT_LIFECYCLE_BLOCKED`）。`credential_row` も同じ。そのため、一般の対策にはならない | PASS（記録） |
| 5 | M2: Vault の行の FOR SHARE（比較だけ。release の試験の写し）。直接の書き手は隙間の中で commit できず（ここでは lock timeout）、照合した token が渡される。ただし `vault.secrets` の行のロックの権限が要り、管理環境では未確認 | PASS（比較） |
| 6 | **005: T1' 同じ攻撃 → `CREDENTIALS_MISSING`**。token は出ず、試みは `reserved` のまま、直接の書き込みは上書きされない | **PASS** |
| 6 | N1: ふつうの release は、照合した token を渡す。T3': H5 の模型が `threads_credential_verified_token` で読めば NULL（中止できる）。切断したアカウントは NULL | PASS |
| 6 | T6: 入口の再接続は隙間に入れない（release が FOR SHARE で持つアカウントの行を待つ。ここでは lock timeout）。release の後なら記録され、その token が渡される | PASS |
| 6 | T8: release の `lock_timeout`（3秒）を超える待ち → `BUSY`、何も進まない。T7: release を rollback すると試みは `reserved` のまま。デッドロック無し | PASS |
| 6 | G4-33 の D1〜D12 は 005 があっても変わらない | PASS |
| 7 | rollback:<br>005 を戻す → release の本体が戻り、T1 が再び再現する<br>**要約を先に戻す（誤った順）** → release は `CREDENTIALS_MISSING` で拒否する（安全側）。005 も戻すと元に戻る<br>関数を残す rollback → `ROLLBACK_INCOMPLETE` | PASS |
| 8 | 005 の欠陥 4種（事後の確認を外した写しでも振る舞いで検出）:<br>release が生の読み出しに戻る → T1'<br>照合の関数が要約を比べない → T1'<br>照合の関数が接続の状態を見ない → 切断の試験<br>release が NULL の token を拒否しない → T1' | **4/4** |

## 5. 一貫した読み出しの方法の比較
| 方法 | 結果 | 権限 | デッドロック・待ち | 限界 |
|---|---|---|---|---|
| **同じ文で照合と取得（005）** | 隙間が無い（T1'） | 追加の権限なし（所有者が `vault.decrypted_secrets` を読めること。今と同じ） | 新しいロックなし | 呼ぶ側がこの関数を使う必要がある（H5 の延長の読み出しも） |
| Vault の行のロック（M2） | 隙間の中の commit を防ぐ | `vault.secrets` の行のロック（管理環境で未確認） | 書き手が待つ。release の `lock_timeout` の内側 | 管理環境で使えるか分からない |
| REPEATABLE READ（T4） | 使えない | — | — | release も `credential_row` も READ COMMITTED を求める |
| 照合し直す（読んだ後にもう一度照合） | 試していない | — | — | 2回目の照合と使う時の間に、また隙間ができる。1つの文にまとめる方が単純（NOT_RUN） |

- **推奨（採用は担当ちゃとレビューの判断）**: 005 の形。token を読むすべての経路を `threads_credential_verified_token`（または同じ1つの文）にする。
  - 今の対象: release、H5 の延長の claim の後の読み出し（H5 の担当）。
  - M2 は、管理環境の権限が確かめられた後の追加の守りの候補。

## 6. 他の枠との境界
- **H5**（#332、idle。割り当てていない）: 延長の store port は、claim の後の token を `threads_credential_verified_token` で読む。NULL なら中止する（T3'）。生の SELECT はしない。G4-19 の COORDINATION は未回答。
- **G3**: `credential_row` は1つの文なので隙間が無い（T2）。G3 の投稿の経路が release を使う場合は 005 の形が要る。G3 の preflight は未確認。
- **G5**: release と `credential_row` が READ COMMITTED を求めるのは G5 の柵の契約（T4 で実測）。変更は要らない。
- **SQL のログ**: 005 は token を引数に取らない（返すだけ）。`rotate_and_store` が token を引数に取る件は G4-33 のまま（未確認）。

## 7. 残件（独立のセキュリティのレビューの観点）
1. **D8**（既知）: 特権者が直接 Vault を書き換え、custody を書き直すと、その中身が正しいものになる。
2. 管理環境の Vault: 暗号化された本物の `decrypted_secrets` で、1つの文の中のスナップショットが同じように効くか。行のロックの権限（M2）。いずれも未確認。
3. H5 の実際の連携（延長の worker、claims、transport）。
4. 製品の SQL への適用はしていない。PR #124 の authenticated の EXECUTE は有効にしていない。Issue #131 は延期のまま。
5. 仕掛け（advisory lock の view）は試験の世界だけのもの。本物の Vault では同じ順を強制できない。そのため、ここでの再現は「起こりうる順」の証拠であって、本番で起きた証拠ではない。

## 8. NOT_RUN／NOT_VERIFIED
- 「読んだ後にもう一度照合する」方法の実測
- 本物の Supabase の Vault（暗号化・権限・行のロック）、本番
- H5・G3 の実際の呼び出し
- 同じ時刻・時計の step（この隙間は時刻と無関係。試していない）
