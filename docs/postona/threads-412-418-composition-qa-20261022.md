# G4-24：Threads の PR #412 × PR #418 を隔離した PG17 で合わせた QA（fail-closed の実証、2026-10-22 JST）

- task_id: `postona-g4-threads-412-418-isolated-pg17-composition-qa-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **ISOLATED_COMPOSITION_QA_PASS（試験のうえで）／PRODUCTION_NO_GO**。
  - 製品の SQL・migration・RPC・ACL・Auth・Edge は変えていない。G4 の新しい試験と docs だけを足した。
  - 独立のセキュリティのレビュー、本番の GO、マージの承認は別。
- 土台: PR #418 の head `771600a09579f461740fde4ddccb5add279c9591`（001・002 の候補、変えていない）。
- 読み取りだけで重ねたもの:
  - G5 PR #399 `e363c708bcb331abccc0eb51d8b2229936c87ef6`: chain の P1〜P10 のうち main に無いもの、Phase 9 の認証の fixture、F5 の owner epoch、R1／W1／W2（001）、R0（002）
  - G4 PR #412 `b83a7a92524a8862fe0a291d54a364fe15d8048d`: `credential_row` の 001 と rollback。その元の behavior も、合わせた世界で動かないことを示すためだけに重ねた
  - G3 PR #374 `e3dfbd3cce3fffccdb638159f3aa6c3313d5098c`: 007 から世代の関数だけを、一字一句そのまま

## 1. 新しいファイル（G4 だけ）
- `supabase/tests/postona_threads_credential_composition_run.sh`（runner。環境の変数は `TQ_PGHOST`・`TQ_PGPORT`・`TQ_PGSUPER`。`node` は使わない。`jq` を使う）
- `supabase/tests/postona_threads_credential_composition_behavior.sql`（合わせた世界の振る舞い）
- この文書

## 2. 試験の世界
- G4 の世界（X の表、2a-2、PR #124 とその偽の attestation の鍵、G4 の custody）を、G5 の chain（P1〜P10）の上に置いた。
- 試験の世界だけの変更（G5・F5 の runner と同じ）:
  - `auth.uid()` を、個別の claim、無ければ `request.jwt.claims ->> 'sub'` を読む形にした。
  - `brand_memberships` の TRIGGER／TRUNCATE／REFERENCES を revoke した。
- **owner transport は模擬**（H5 のコードは使っていない）:
  - JSON だけの `request.jwt.claims`（`sub`・`role`・`session_id`・`is_anonymous: false`。G5 の T-1）。
  - 操作ごとに1トランザクション:
    - begin: begin → **G5 R1**（`common_account_authorization_verdict('postona','threads_connect', ws)` の `g5oe:<epoch>:<lifecycle>`）→ `record_state_generation`
    - complete: 入口 `complete_and_attest_binding` → custody の書き込み
- 偽の token・偽の Vault（fixture の表）。外部への通信は0。

## 3. 結果（`TQ_*` の runner、PostgreSQL 17.11、ローカルの socket）
`POSTONA_THREADS_CREDENTIAL_COMPOSITION_RUN_PASS`

| 段階 | 結果 |
|---|---|
| 世界: G5 chain P1〜P10 ＋ R1／W1（PR #399）＋ F5 owner epoch ＋ 2a-2 ＋ PR #124 ＋ G4 custody ＋ G3 の世代 | PASS |
| **再現: PR #412 の元の behavior**（合わせた世界の上） | `function postona_threads_binding.attest_binding(uuid, uuid, text) does not exist` で止まる |
| **再現: PR #412 の元の runner**（PR #418 の head ＋ PR #412 のファイル、使い捨ての worktree で実行） | `FAIL ownership overlap: supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql already exists in the G4 base` |
| 適用の順 | `credential_row` を 001 より先に → `THREADS_CREDENTIAL_PRECONDITION_TABLES`。002 を 001 より先に → `THREADS_CUSTODY_PROOF_PRECONDITION_BINDING`。001 → 002 → `credential_row` で適用できる |
| 合わせた世界の振る舞い（下の表） | PASS |
| rollback（正しい順）: `credential_row` → 002 → 001 | PASS（両方のスキーマが消え、custody の書き込み関数は候補の元の本体（md5 `eb58930b…`）に戻る） |
| rollback（誤った順）: 001 を先に | `credential_row` は `relation "postona_threads_binding.bindings" does not exist` で**エラー**。custody の書き込みもエラー（行も書き込みも無い）。その後でも、002 と `credential_row` は戻せる |
| わざと欠陥を入れて検出できるか | **6/6 を検出** |
| rotation（`recorded_at` の CAS） | 公開の候補と release の候補の後に適用できた。請求した版で `rotated`（その後も `credential_row` は1行）。古い `recorded_at` では `STALE_CREDENTIAL`。**同じ `now()` の2つのトランザクションの競合は NOT_RUN** |

### 振る舞い（`postona_threads_credential_composition_behavior.sql`）
| # | 確かめたこと | 結果 |
|---|---|---|
| K1 | `credential_row`・入口・`record_state_generation`・`binding_row`・custody の書き込みと読み取り・PR #124 の complete の ACL が所有者だけ。API の役割は `credential_row` に届かない | PASS |
| K2 | G5 の W1 は STABLE・definer・`row_security = off`。それでも `credential_row` の適用時と呼ぶたびの確認は通る | PASS |
| C1 | 新しい接続 → ちょうど1行（このアカウント、Threads の利用者、token、64桁の世代）。state に結び付く | PASS |
| C2 | 再接続 → 新しい token・新しい結び付けだけ。世代も新しい | PASS |
| C3 | 移行していない transport（PR #124 の complete を単独で呼ぶ）: custody と同じトランザクションなら拒否（`THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION`）で、何も残らない。complete だけを commit すると、`credential_row` は**0行**になり、その state は二度と結び付けられない | PASS |
| C3b | 結び付け済みのアカウントでも、入口なしの complete＋custody は拒否される | PASS |
| C4 | 期限を過ぎると、同じトランザクションの中でも0行（時計で判定） | PASS |
| C5 | 所有者が2人なら0行。1人に戻しても0行（owner epoch は進むだけで、W1 は `OWNER_EPOCH_CHANGED`）。再接続すると1行。所有者 A→B→A も0行 | PASS |
| C6 | サービスの世代が動いた（SYNTHETIC）、切断した → 0行 | PASS |
| C7 | 入口の claims: 無い → `THREADS_BINDING_INPUT_INVALID`。`session_id` が無い → 拒否。**別の人 → `THREADS_ACCOUNT_NOT_OWNED`**。**個別の claim と JSON を混ぜる → `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`**（G5 の T-1 のとおり。H5 の今の置き方では拒否される）。拒否では何も書かれない。JSON だけなら完了する | PASS |
| C8 | custody が拒否されると（期限が範囲外）、入口も一緒に取り消される。savepoint の rollback もトランザクションの rollback も、両方を取り消す。同じ state でやり直せる | PASS |
| C9 | READ COMMITTED だけが1行。REPEATABLE READ・SERIALIZABLE は0行 | PASS |
| C10 | 結び付けた人が、今の唯一の所有者でない（SYNTHETIC）→ 0行 | PASS |

### わざと入れた欠陥（6種、どれも検出）
- `credential_row`:
  - 期限を `now()` にする
  - 分離レベルの確認を外す
  - W1 を外す
  - 結び付けた人の確認を外す
- 002: 証明の照合を外す
- 001: 入口が証明を設定しない

最初の実行では、結び付けた人の確認と証明の照合の2つを取りこぼした。C3b と C10 を足したので、今は検出する。

## 4. G4 の試験の安全な更新の候補（PR #412 の runner と behavior）
- runner: PR #367 の 001 を重ねるのをやめる。PR #418 の 001・002 を土台にする（この runner と同じ形）。
- behavior の `tc.connect_all`: `complete`（PR #124）→ `attest_binding` → custody の順をやめる。次の2つに置き換える（この behavior の `cr.t_begin`／`cr.t_complete` と同じ形）。
  - begin のトランザクション: begin → R1 → `record_state_generation`
  - complete のトランザクション: 入口 → custody
- PR #412 の head は変えていない。PR #412 を PR #418 の上に積み直すかどうかは、担当ちゃが判断する。

## 5. 他の担当との依存（未解決のもの）
- **H5**（#332、未回答）:
  - 今の owner transport は、PR #124 の complete を直接呼んでいる（C3 のとおり、結び付けも custody も作れない）。
  - claims も個別と JSON を混ぜている（C7 のとおり、T13 が拒否する）。
  - 入口と custody への差し替え、claims を JSON だけにすることが必要。
- **G5**:
  - R1 と W1 は、この合わせた世界で動いた。
  - X の T13 のセッションのロックの方針（#320 6331312443）は**未回答**。
- **G3**（今は Data API の調査中）:
  - PR #382 の E2E（`g4_connect_people.sql:58` の `attest_binding`）の置き換えを提案する（G3 のファイルには触れていない）。
  - `credential_row` を READ COMMITTED で呼ぶこと。
  - worker への付与は別の段階。
- **PR #124 の authenticated の EXECUTE**: 有効にしていない。付与されると、入口が拒否する（G4-19）。
- **Issue #131**（X の B3）: 再開していない。

## 6. 独立のレビューが要ること
- 適用と rollback の順（とくに `credential_row` を先に戻すこと）
- ACL が所有者だけであること
- 実際の H5 の transport で、JSON だけの claims と同じトランザクションになること
- W1 の `row_security = off`
- rotation の CAS の、同じマイクロ秒の競合（NOT_RUN）
- 管理環境の役割の構成

## 7. NOT_RUN／NOT_VERIFIED
- rotation の、同じ `now()` の競合
- H5 の実際の transport のコード
- G3 の 007 全体と F3 の 001〜006（世代の関数だけを使った）
- 本物の Supabase・Auth・Vault・Threads、本番
