# G4-28：延長のリースを接続の証明に結び付ける案 C の source-only 設計と、A＋C の限界・独立のレビューの準備（2026-10-23 JST）

- task_id: `postona-g4-threads-lease-binding-proof-c-defense-source-audit-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **DESIGN_ONLY（source を読んだだけ。SQL も DB の試験も NOT_RUN）／製品の欠陥は未解消／独立のレビューが要る／PRODUCTION_NO_GO**
  - G4-27 の候補 A の限定 PASS は、製品の修正の PASS ではない。この文書も修正ではない。
  - 変更はこの文書だけ。SQL・candidate・migration・ACL・RPC・Auth・Edge・他の枠の path・既存の PR の head は変えていない。
- 土台: PR #460（候補 A、`2846d395bd9c4d8474e53b87b03ab09da0d3a397`）→ PR #456（設計、`fc132e1c…`）→ PR #453（再現）→ PR #449（合わせた世界）
- 読んだ source（この branch の行番号）:
  - rotation: `supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql`
  - 候補 A: `supabase/candidates/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation.sql`
  - 001 の入口と binding: `supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql`
  - custody と期限の読み出し: `supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql`
  - PR #124 の `complete`: `supabase/candidates/postona_threads_oauth_workspace_candidate.sql`
  - `credential_row`（PR #412 `b83a7a92…`、読み取りだけ）

## 1. 候補 A の実測と、残る危険（G4-27 の証拠）
| 項目 | 証拠（PR #460 の runner、PostgreSQL 17.11） | 状態 |
|---|---|---|
| 同じ `now()` の再接続（1トランザクション、別々の2トランザクション） | R7・collision とも `LEASE_NOT_HELD` | 実測 PASS |
| 書き込みの種類（INSERT／UPDATE／DELETE／TRUNCATE）、replica の mode、RLS に掛かる書き手、ロックの順、rollback | N1〜N8、E1〜E3、10節 | 実測 PASS |
| F4 の rotation の試験の全体 | `ALL PASS`、mutant 25種を検出＋1種が同値 | 実測 PASS |
| **表の所有者が trigger を止める**（`DISABLE TRIGGER`、保守のための `DISABLE TRIGGER ALL` も同じ） | R7 が再び再現する。監査では `tgenabled = D` | **実測 EXPECTED_FAIL** |
| **custody を書かない token の変化**（入口を通らない PR #124 の `complete`、Vault のその場の直接の更新） | trigger は動かない（custody の行が変わらない） | source から（未実測） |
| H5 が拒否の後に token を持ち越す | DB では見えない | 設計上の条件 |

## 2. 案 C の中身（source から確かめた事実）
### 2.1 結び付ける値: `bindings.oauth_state_id`
- `postona_threads_binding.bindings`（001 の 146〜156行）は、1アカウントに1行（`social_account_id` が primary key）。
  - 列: `oauth_state_id uuid not null unique`、`connect_proof uuid not null`、`bound_by`、`owner_epoch`、`lifecycle_version`、`threads_user_id`、`brand_id`。
- この行を書くのは、001 の入口 `complete_and_attest_binding` の `insert … on conflict (social_account_id) do update`（287〜294行）だけ。ほかに更新も削除も無い。消えるのは、アカウントの削除の cascade（147行）だけ。
- 入口は、すでに binding に使われた state を拒否する（255行）。列は `unique`（151行）。**接続（再接続）のたびに、別の `oauth_state_id` が入る。**
  - 古い保留の state が後から完了した場合（G4-14 の「最後の完了が勝つ」）も、別の値になる。
- `oauth_state_id` は秘密ではない。`connect_proof` は「秘密でも token でもない」と 152行の注記にあるが、custody の書き込みの証明に使う値なので、リースに写すなら hash にとどめる。**C には `oauth_state_id` だけで足りる**（毎回一意で、変えられない）。

### 2.2 いつ読めば安定しているか（ロックの順）
- 入口の順: PR #124 の `complete` が `social_accounts` を update する（244行。ここでアカウントの行のロックを取る）→ `state_generations` FOR UPDATE（246行）→ アカウントの行 FOR UPDATE（263行）→ binding の upsert（287行）→（同じトランザクションで）custody の書き込み（002）。
- claim と rotate は、アカウントの行を FOR UPDATE で持った後に custody とリースを読む（rotation 213・222・232行、297・306・307行）。
- **binding は、アカウントの行のロックを持ったトランザクションの中でしか変わらない。** claim と rotate は、アカウントの行を持った後に読めば、ロックを足さずに確定した値を読める。新しい待ちの輪はできない。

### 2.3 形（次の隔離 QA の TASK 用の設計。このTASKでは書いていない）
- 新しい隔離候補（例: `…/postona_threads_rotation_lease_invalidation/002_rotation_lease_binding.sql` と rollback）。
- **前提**:
  - 候補 A が適用済み（trigger が2つとも ALWAYS）
  - rotation の claim／rotate の本体が A の固定の md5（`2d5fdec6…`／`4de6764d…`）
  - `postona_threads_binding.bindings` があり、その所有者が適用する人である
- **リースの表**: 列 `binding_oauth_state_id uuid not null` を足す。適用のときに、ある行（60秒で終わるもの）は消してから足す（安全側）。
- **claim**（CREATE OR REPLACE、同じ形）: アカウントの行と custody の確認の後で、binding を `credential_row` と同じ条件で読む。条件は「`social_account_id`・`brand_id` が同じ」「`threads_user_id` がアカウントの `platform_user_id` と同じ」の2つ（PR #412 の 100行、001 の `binding_row` の 307〜311行と同じ）。
  - 無ければ `CONNECTION_NOT_BOUND` で拒否する。
  - その `oauth_state_id` をリースに書く。答えの形は変えない（H5 の port の形も変わらない）。
- **rotate**（CREATE OR REPLACE、同じ形）: リースの確認（310〜316行）の後、比較交換（317〜325行）の前に、同じ条件で binding を読む。
  - 無い、またはリースの `binding_oauth_state_id` と違えば `BINDING_CHANGED` で拒否する。
  - 新しい code なので、「再接続でリースが変わった」と「使い済み・再生」（`LEASE_NOT_HELD`）を区別できる（G4-27 §4-4 の監査の論点）。
- **事後の確認**: 新しい本体の md5、所有者だけの ACL（rotation の事後の確認と同じ）、リースの列。
- **rollback**: claim と rotate を元の本体（A が固定した md5）に戻し、列を消す。順は「C → A → rotation」。

## 3. 比べたこと（脅威ごと。○ = 拒否、× = 通る）
| # | 脅威 | 現状（rotation のみ） | A | C | A＋C | B（custody の版。関数の本体で増やす） | E2（行の版 xmin。§5） |
|---|---|---|---|---|---|---|---|
| T1 | 入口を通る再接続が、同じ `now()` で起きる（G4-25 の再現） | × | ○（実測） | ○（設計） | ○ | ○ | ○ |
| T2 | T1 で、A の trigger が止まっている（所有者・保守の `DISABLE TRIGGER ALL`）、または ALWAYS でない | × | ×（実測） | ○（本体の中なので trigger と無関係） | ○ | ○ | ○ |
| T3 | 入口を通らない PR #124 の `complete` 単独が、同じ `now()` で起きる | × | ×（custody が変わらない） | ×（binding が変わらない） | × | ×（custody が変わらない） | ○（Vault・アカウントの行が変わる） |
| T4 | Vault の secret が、その場で直接書き換えられる（custody も binding も変えない） | × | × | × | × | × | ○（Vault の行が変わる） |
| T5 | custody が入口と rotate 以外で書かれ、trigger が止まっている（手での修理・将来の書き手） | × | × | ×（binding が変わらない） | × | 書き手が本体で増やすなら○、直接の UPDATE なら× | ○ |
| T6 | H5 が、拒否の後に延長した token を新しい claim で書く | × | × | × | × | × | × |
| T7 | 所有者が claim／rotate の本体を置き換える | × | × | × | × | × | × |

- **T3 の影響は小さい**: 入口を通らない `complete` は `verified_at = now()` を書く（workspace 336行）。custody の `recorded_at` がそれより古いと、期限の読み出し（custody 104〜112行の `recorded_at >= verified_at`）が NULL になり、`credential_row` は0行になる（G4-24 の C3 で実測）。古い延長が Vault を上書きしても、次の入口の再接続までは、token は渡されない。再接続は Vault をまた上書きする。
  - なお、入口を通らない `complete` を呼べるのは所有者だけにする方針である（G4-19、PR #124 の authenticated の EXECUTE は付けない）。
- **T6・T7 は DB では防げない**: H5 の条件（G4-26 §2.4）と、所有者の操作の監査（trigger の `tgenabled`、claim／rotate の md5）で扱う。

### 3.1 結論
- **C は A の限界の T2（trigger の停止）を閉じる。** 入口を通る再接続なら、trigger と無関係に、時刻とも無関係に拒否する。**A＋C を推奨**する。
- **C だけでは防げない**のは T3・T4・T5。これらは custody も binding も変えない変化である。
- **B が要る条件**:
  1. custody を書く関数が、入口と rotate のほかに増える（要再接続の印、修理の関数）。
  2. binding が無いアカウント（001 より前の接続）も延長したい（C は `CONNECTION_NOT_BOUND` で拒否する）。
  3. trigger に頼らずに、custody の書き込みの検出を関数の本体で保証したい。
  - ただし、B を BEFORE の trigger で増やすと、A と同じく止められる。本体で増やすと、直接の UPDATE は捕まえられない。
- **T3・T4 まで DB で捕まえたい場合**は、§5 の E2（行の版）が候補になる。管理環境での権限と、system column に頼ることの是非を、レビューで決める必要がある。

## 4. 適用と rollback の順、他の候補とインターフェースへの影響
| 対象 | 影響 |
|---|---|
| 適用の順 | custody → 001 → 002 → `credential_row` → 投稿 → release → rotation → **A** → **C** |
| rollback の順 | **C** → **A** → rotation。C の rollback は claim／rotate を A の固定の md5 に戻す（そうでないと A の再適用の前提が崩れる） |
| 誤った順 | 001 を C より先に戻す → claim／rotate が binding の表を読めずエラー（安全側。設計上の推論、未実測）。A を C より先に戻す → C は単独で動く（T1・T2 は C が拒否） |
| F4 の rotation の試験 | F4 の世界には 001 が無いので、C を入れるとすべての claim が `CONNECTION_NOT_BOUND` になる。**C の試験は、G4-24 の合わせた世界（001 あり）で行う**。F4 の試験の全体を使うなら、世界に 001 を足すか、期待の書き換えが大きくなる（次の TASK で決める） |
| G4-27 の runner | `R7_FIX_PROTOTYPE_HOLDS` の期待のまま使える（拒否の code が `LEASE_NOT_HELD` か `BINDING_CHANGED` かは、behavior の判定の両方に入れる） |
| H5（store port、まだ無い） | 答えの形は変わらない。新しい拒否 `CONNECTION_NOT_BOUND`（要再接続）と `BINDING_CHANGED`（その回は捨てて、次の回で claim し直す）の扱いを決めてもらう |
| G3（007 の世代） | 世代はリースの `lease_id` と secret だけを hash する。新しい列は hash しないので、世代の値も意味も変わらない |
| G5 | 変更は要らない（F5 の判断とロックの順は同じ） |
| `credential_row`（PR #412） | 変えない。C の binding の条件を `credential_row` と同じにして、「延長はできるが投稿には使えない」という食い違いを作らない |

## 5. E2: 行の版（xmin）を使う案（検討の材料。推奨はしない）
- リースに、claim の時点の `vault.secrets` の行と custody の行（必要ならアカウントの行も）の `xmin` を記録し、rotate で同じかを比べる。
- 行を書き換えると、PostgreSQL では新しい行の版ができ、`xmin` が書いたトランザクションの id になる。そのため、trigger を止めた書き込みや Vault の直接の更新（T3・T4・T5）も、別のトランザクションなら見分けられる。
- `xmin` は楽観的ロックの印として使われることがあるが、**懸念が多い**:
  - claim と同じトランザクションの中での書き込みは見分けられない（R7 の1トランザクションの模型。そこは A が捕まえる）。
  - 論理複製の適用先や復元の後では値が変わる（安全側に倒れるだけ）。
  - 管理環境の Supabase で、所有者の役割が `vault.secrets` の行を読めるかは**未確認**。
  - アカウントの行は、関係ない列の更新でも版が変わる（安全側の拒否が増える）。
- レビューで、T3・T4 を DB で捕まえる必要があると判断されたときの候補として残す。

## 6. 次の G4 の隔離 QA の TASK 用の試験の設計（このTASKでは NOT_RUN）
- **正**:
  - A＋C で、R1〜R6・N1〜N8・E1〜E3・collision が変わらず PASS（拒否の code は `LEASE_NOT_HELD` または `BINDING_CHANGED`）
  - 再接続の後の新しい claim がリースに新しい `oauth_state_id` を書き、`rotated`
  - binding の条件が `credential_row` と同じ
- **負**（C の目的）:
  - **CA1**: A の trigger を止めて R7 → `BINDING_CHANGED`、再接続の token が残る（A の限界が閉じたことの確認）
  - **CA2**: A の trigger を止めて collision → 拒否
  - **CA3**: trigger を ORIGIN に戻し、replica の mode で再接続 → 拒否
  - CA4: binding が無いアカウント → claim が `CONNECTION_NOT_BOUND`（`credential_row` も0行）
  - CA5: binding の brand・Threads の利用者が食い違う → claim を拒否
  - CA6: 古い保留の state が後から完了 → `oauth_state_id` が変わり、拒否
  - CA7: アカウントの削除（binding の cascade）→ `ACCOUNT_NOT_FOUND`
- **期待どおりに通ってしまうもの（EXPECTED_FAIL として記録）**:
  - CF1: 入口を通らない `complete` を同じ `now()` で → C では拒否できない。ただし `credential_row` は0行（token は渡されない）ことを測る
  - CF2: Vault の直接の更新 → 拒否できない
- **競合**:
  - claim と入口の再接続（両方の順）
  - rotate と入口の再接続
  - rotate が binding を読む位置がアカウントの行のロックの後であること（読む位置を前に動かした mutant で、競合の試験が落ちるか）
  - デッドロックが無いこと
- **rollback**:
  - C → A → rotation の順で、md5 が A の固定に戻る
  - C だけ戻すと A だけの状態（G4-27 と同じ結果）
  - 001 を先に戻すと、安全側のエラーになる
- **mutant**:
  1. rotate が binding を比べない
  2. claim が binding を書かない、または別の値を書く
  3. binding の条件から brand や Threads の利用者を外す
  4. binding を読む位置をロックの前にする
  5. 比較を `connect_proof` に替える（同値かを確かめる）
  6. rollback が md5 を戻さない
  7. 事後の確認を外した写しでも振る舞いで検出されること

## 7. 独立のセキュリティのレビューの12項目（A＋C 用に更新）
| # | 論点 | 根拠と証拠 | 状態 |
|---|---|---|---|
| 1 | 脅威の再評価（Meta の24時間の規則による支え） | G4-26 §2.1（source） | Meta の規則は未確認 |
| 2 | A の trigger がすべての書き込みで動くか、飛ばせる役割 | G4-27 N1〜N8、8節 EXPECTED_FAIL | 管理環境の役割は未確認 |
| 3 | A＋C のロックの順 | §2.2（source）、G4-27 E1〜E3 | C は未実測 |
| 4 | **C の binding が、アカウントの行のロックの下で安定しているか** | §2.2（001 の 244・263・287行） | 未実測 |
| 5 | **`oauth_state_id` が接続ごとに一意で、再利用されないか** | 001 の 151・255行 | 未実測 |
| 6 | C の条件と `credential_row` の条件の一致 | §2.3 | 未実測 |
| 7 | H5 の条件と、新しい拒否の code の扱い | G4-26 §2.4、§4 | H5 は未実装 |
| 8 | rollback の順（C → A → rotation）と md5 の戻り | §4 | 未実測 |
| 9 | T3・T4・T5 を DB で捕まえる必要があるか（E2 または B） | §3・§5 | 判断が要る |
| 10 | 時計と無関係であること | C は時刻を使わない（設計） | 未実測 |
| 11 | ACL と事後の確認（新しい列、置き換えた本体） | §2.3 | 未実測 |
| 12 | 監査: `BINDING_CHANGED` と `LEASE_NOT_HELD` の区別、trigger の `tgenabled` と本体の md5 の定期の確認 | §2.3・§3 | 運用の決定が要る |

## 8. 修正の責任の分け方
| 担当 | 持つもの |
|---|---|
| G4 | rotation・A・C の隔離候補、その試験、この設計。採用されたら、製品の候補への取り込みも（別の TASK） |
| H5（#332、idle。割り当てていない） | 延長の store port。token を claim と同じトランザクションで読むこと、拒否の後に持ち越さないこと、新しい code の扱い |
| G3 | 変更は要らない（世代は新しい列を hash しない） |
| G5 | 変更は要らない |
| 運用・レビュー | 所有者の操作の監査（trigger の状態、本体の md5）、管理環境の役割の構成、E2・B の要否の判断 |

## 9. NOT_RUN／NOT_VERIFIED
- この TASK の SQL・DB の試験のすべて（docs だけ）。§2・§3 の C・B・E2 の判定は source からの推論。
- C・B・E2 の実装と実測
- Meta の24時間の規則、H5 の延長の worker と transport、時計の step
- G3 の preflight、G5 の T13 の方針、管理環境の役割と `vault.secrets` の読み取りの権限
- 本物の Supabase・Auth・Vault・Meta、本番
