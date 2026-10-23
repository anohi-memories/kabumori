# G4-33：Threads の F2（Vault の直接の更新）を token の要約の照合で防ぐ案の、隔離した PG17 の QA（2026-10-23 JST）

- task_id: `postona-g4-threads-vault-f2-token-digest-isolated-qa-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **ISOLATED_DIGEST_PASS（使い捨ての PG17・偽の Vault の上だけ）／F2 は隔離候補で拒否／限界1件（D8）と未解決を明記／PRODUCTION_NO_GO**
  - 製品の修正の完了ではない。採用・適用・マージはしない。独立のセキュリティのレビューと本番の GO は別。
  - 既存の SQL・migration・候補（custody・rotation・投稿・A・C・④）・H5／G3／G5 のファイル・既存の PR の head は変えていない。
- 土台: PR #474（`ee64f6585dc3ac04d4c5182f2836d7b9663e3f1a`）→ #472（④）→ #469 → #467（C）→ … → #460（A）

## 1. 新しいファイル（G4 だけ）
| ファイル | 内容 |
|---|---|
| `supabase/candidates/postona_threads_rotation_lease_invalidation/004_rotation_token_digest.sql` | 隔離したソース候補（要約の列・要約の trigger・読む側と claim／rotate の照合・`rotate_and_store_threads_credential`） |
| `supabase/candidates/postona_threads_rotation_lease_invalidation/004_rotation_token_digest_rollback.sql` | その rollback（本体を固定に戻す。順が違えば拒否） |
| `supabase/tests/postona_threads_token_digest_run.sh` | runner（`TQ_*`。1〜3節と補助は G4-31 の runner の写し） |
| `supabase/tests/postona_threads_token_digest_behavior.sql` | D1〜D12 |
| この文書 | |

## 2. 候補の形
- **偽の Vault**（試験の世界の既存の fixture のまま）: `vault.secrets(id, secret, name)` と、`vault.decrypted_secrets` の view、`vault.update_secret`。暗号化は無い。直接の更新の経路は `vault.update_secret` を直接呼ぶこと（`cr.oob`）。
- **要約**: `custody.token_digest` = その記録が表す token の sha256（16進64桁）。
  - BEFORE INSERT OR UPDATE の trigger（SECURITY DEFINER、ENABLE ALWAYS）が、**custody を書くたびに、今の Vault の中身から**計算して入れる。書き手は値を選べない（D9）。
  - 接続（`complete` が Vault を書き、同じトランザクションで 002 が custody を書く）と `rotate_and_store`（Vault の後に custody）は、自分が書いた token の要約を記録する。
- **照合（読む側すべて）**:
  - 期限の読み出し `threads_account_credential_expires_at`（`credential_row`・手での投稿・release が使う）を、同じ形のまま置き換え、要約が無い・中身と違うときは NULL にする。
  - claim と rotate は `CREDENTIAL_UNVERIFIED`（要約が無い）／`CREDENTIAL_CHANGED`（中身と違う）で拒否する。
- **`rotate_and_store_threads_credential(…, new_token)`**: rotate の本体に次を足したもの。
  - 要約の照合の前に、`vault.secrets` の行を FOR UPDATE で取る。
  - **Vault の書き込みを custody の更新の前に**、同じ文の中で行う。
  - H5 が別に Vault を書く必要がなくなる。
- **今までの rotate** も呼べる。ただし、その後に別に Vault を書くと、記録は古い token を表したままになり、読む側がすべて拒否する（D6、安全側）。
- **既存の custody の行**: 要約は NULL（未確認）。再接続まで、読む側は拒否する（D7）。適用のときに計算する選択肢は、今の Vault の中身を正しいものとして記録してしまう（D8 と同じ）。そのため**判断は保留**した。

## 3. 結果（`TQ_* bash supabase/tests/postona_threads_token_digest_run.sh`、PostgreSQL 17.11、ローカルの socket、外部への通信は0）
最終の判定: `POSTONA_THREADS_TOKEN_DIGEST_RUN_PASS`（clean な HEAD での実行は REPORT に記す）

| 節 | 確かめたこと | 結果 |
|---|---|---|
| 4 | ④ が無い → `PRECONDITION_FINGERPRINT`。期限の読み出しがずれている → `PRECONDITION_BODIES`。所有者でない → 拒否（Vault のスキーマの権限で、前提の確認の段階で止まる）。二度目 → `ALREADY_APPLIED` | PASS |
| 5 | D1: 接続で要約が入る。claim → `credential_row` が token を渡す → `rotate_and_store` が新しい token と要約を1つの文で書き、新しい token が渡される。一度だけ使える | PASS |
| 5 | **D2: claim の後に Vault を直接書き換える → `rotate_and_store` は `CREDENTIAL_CHANGED`**。直接の書き込みは上書きされない。`credential_row` は0行、期限の読み出しは NULL。今までの rotate も拒否する | **PASS** |
| 5 | D3: claim の前に直接書き換える → claim が `CREDENTIAL_CHANGED` | PASS |
| 5 | D4: 同じ中身に書き換える → `rotated`（変化が無いので、害も無い） | PASS（記録） |
| 5 | **D5: 1つのトランザクション・同じ `now()` で、接続・claim・直接の書き換え・`rotate_and_store`** → `CREDENTIAL_CHANGED`、`credential_row` は0行（中身で比べるので、時刻と無関係） | **PASS** |
| 5 | D6: 今までの流れ（rotate の後に別に Vault を書く）→ 読む側がすべて拒否する（安全側）。再接続で戻る | PASS（延長は `rotate_and_store` に移す必要があることの実測） |
| 5 | D7: 要約の無い行 → `CREDENTIAL_UNVERIFIED`、`credential_row` は0行。再接続で要約が入る | PASS |
| 5 | **D8（限界）: 直接の書き換えの後に、所有者が custody を書く** → その中身の要約が記録され、渡される | **EXPECTED_LIMIT**（適用のときの計算も同じことになる） |
| 5 | D9: `token_digest` を直接書いても、本当の要約に置き換わる | PASS |
| 5 | D10: 形の悪い token（`REQUEST_INVALID`）、別のリース（`LEASE_NOT_HELD`）、短い期限 → どれも Vault に何も書かない | PASS |
| 5 | D11: `rotate_and_store` を rollback → token・要約・記録・リースが元に戻る | PASS |
| 5 | D12: `rotate_and_store`・trigger の関数・要約の列に、API の役割は届かない | PASS |
| 5 | **V1: 直接の書き手が Vault の行を持っている間の `rotate_and_store`** → 行のロックを待ち、新しい中身を見て `CREDENTIAL_CHANGED`。直接の書き込みは上書きされない | PASS |
| 5 | 今までの試験 R1〜R7b・N1〜N5・B1〜B8・P1〜P9（A on／off）。試験の世界だけの調整を入れた: 「H5 の書き込み」は `rotate_and_store` と同じく custody と一緒に書く。直接の書き込みを「通る」と期待した F2 の部分は、D2〜D5 で置き換えたので外した | PASS |
| 6 | V2: `rotate_and_store` が先 → 待った直接の書き手が後から書く → 読む側がすべて拒否（安全側）。V3: `rotate_and_store` が先 → 待った入口の再接続が最後に記録 → 再接続の token が渡される。デッドロック無し | PASS |
| 7 | rollback: claim・rotate・期限の読み出しが固定の本体に戻り、F2 が再び通る（要約が拒否していたことの確認）。④ の rollback を先に流す → `ROLLBACK_ORDER`。期限の読み出しを戻し忘れる → `ROLLBACK_INCOMPLETE` | PASS |
| 8 | 欠陥 7種（事後の確認を外した写しでも振る舞いで検出）:<br>claim が照合しない → D3<br>`rotate_and_store` が照合しない → D2<br>**Vault の行のロックを外す → V1**（直接の書き込みを上書きして `rotated` になる）<br>期限の読み出しが照合しない → D2<br>trigger が INSERT だけ → D1<br>trigger が書き手の値を信じる → D1<br>Vault を custody の後に書く → D1 | **7/7** |

- 欠陥「trigger が書き手の値を信じる」は、最初の実行では事後の確認を**通り抜けた**（trigger の関数の本体を固定していなかった）。trigger の関数の md5（`e964f908…`）を事後の確認に足した。
- この欠陥を最初に捕まえたのは D1 だった（UPDATE では前の値が残り、要約が更新されない）。D9 ではない。

## 4. 比べたこと（採用の判断は保留）
- **sha256 と HMAC**:
  - sha256 は鍵が要らない。token は高いエントロピーなので、要約から token を推測するのは現実的ではない、と考える。ただし、要約は token から決まる値なので、所有者だけの表に置き、API の役割には見せない（D12）。
  - HMAC（鍵を Vault に置く）なら、要約が漏れても token と照合できない。その代わり、鍵の管理（作成・入れ替え・失ったときの再計算）が要る。**今回は sha256 だけを試した（HMAC は NOT_RUN）**。
- **比較の時間の差**: SQL の文字列の比較は一定時間ではない。ただし呼べるのは所有者だけで、比べる相手も要約なので、時間の差から token は分からない、と考える（レビューの項目）。
- **NULL と既存の行**: NULL は「未確認」として拒否する（安全側）。適用のときに計算すると、今の中身（すでに直接書き換えられているかもしれない）を正しいものとして記録する（D8）。
- **時刻**: 要約は時刻を使わない。同じ `now()`（D5）でも効く。時計の step の実測は NOT_RUN（設計上は無関係）。

## 5. 未解決（できると判断できない部分）
1. **D8**: 所有者・superuser が直接の書き換えの後に custody を書くと、その中身が正しいものとして記録される。trigger の停止も所有者の権限。監査（本体の md5、trigger の状態）で扱う。
2. **照合の後の TOCTOU**:
   - `rotate_and_store` は Vault の行を FOR UPDATE で取るので、V1 では防げた。ただし**管理環境で、その権限（`vault.secrets` の行のロック）があるかは未確認**。
   - 手での投稿と release は、期限の読み出しと token の読み出しが**別の文**（`threads_manual_publish_candidate.sql` 506行、`threads_publish_release_candidate.sql` 273行）。その間の直接の書き込みは、そのまま読まれる（古い系統の復活ではないが、確認していない中身を使う）。`credential_row` は同じ文で読むので、この窓は無い。**NOT_RUN（source から）**。
3. **SQL の引数としての token**: `rotate_and_store` は新しい token を引数で受け取る。bind の変数を使わない呼び出しや、文を記録する設定では、ログに残りうる。管理環境のログの設定は未確認（NOT_RUN）。
4. **管理環境との差**: 偽の Vault は暗号化も `updated_at` も無い。本物の `vault.update_secret`・`decrypted_secrets` の権限と振る舞いは未確認。
5. **H5 の一体化**（変えていない）: 延長の store port は `rotate_and_store` を呼び、token は claim と同じトランザクションで読み、拒否の後に持ち越さない。接続は入口の経由で、claims は JSON だけ（G4-30）。G4-19 の COORDINATION は未回答。
6. **G3**: 007 の世代は要約を hash しない。直接の書き換えがあっても世代は変わらないが、`credential_row` が0行になるので安全側になる。

## 6. 独立のレビューの項目（この QA の証拠）
| # | 論点 | 証拠 | 残り |
|---|---|---|---|
| 1 | F2 が要約で閉じたか | D2・D3・D5・V1 | — |
| 2 | 書き手が要約を選べないこと | D9、欠陥 `trigger_trusts_the_writer` | trigger の停止（所有者） |
| 3 | 読む側すべてが同じ判定か | D2（`credential_row`・期限の読み出し）、手での投稿と release は期限の読み出しを経由 | 別の文で読む TOCTOU（§5-2） |
| 4 | `rotate_and_store` の一体性と失敗時に何も書かないこと | D10・D11 | — |
| 5 | Vault の行のロック | V1、欠陥 `store_no_vault_row_lock` | 管理環境の権限 |
| 6 | 今までの rotate と別の書き込み | D6（安全側） | H5 の移行 |
| 7 | NULL・既存の行の扱い | D7・D8 | 判断が要る |
| 8 | sha256 か HMAC か | §4 | 判断が要る |
| 9 | token を SQL の引数で渡すこと | §5-3 | 管理環境のログ |
| 10 | rollback の順 | 7節 | — |
| 11 | ACL と事後の確認（trigger の関数の md5 を足した） | D12、4節 | 管理環境 |
| 12 | 拒否の code の監査上の意味（`CREDENTIAL_CHANGED`／`CREDENTIAL_UNVERIFIED` が加わった） | — | 運用の決定 |

## 7. NOT_RUN／NOT_VERIFIED
- HMAC、時計の step、手での投稿と release の別の文の TOCTOU、ログへの token の残り方
- 管理環境の Vault（暗号化、権限、行のロック、`updated_at`）
- H5 の実コード、G3 の preflight、F4 の rotation の試験の全体
- 本物の Supabase・Auth・Vault・Meta、本番
