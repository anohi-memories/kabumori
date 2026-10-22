# G4-25：Threads の資格情報の延長（rotation）の `recorded_at` の比較交換を、同じ時刻で隔離した PG17 で確かめた QA（2026-10-22 JST）

- task_id: `postona-g4-threads-rotation-same-timestamp-cas-isolated-qa-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **FINDING_REPRODUCED（安全の期待に対して FAIL）／修正の試作は試験の世界だけで有効／PRODUCTION_NO_GO**。
  - 製品の SQL・migration・RPC・ACL・Auth・Edge は変えていない。G4 の新しい試験と docs だけを足した。
  - 独立のセキュリティのレビュー、修正の採用、本番の GO、マージの承認は別。
- 対象: `supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql`（blob `7366b660e7ada82cdd390c2755ac18af6c7fafb9`、変えていない）
- 土台: PR #449 の head `89b966382f3c2b6104ee13847c5448a9fa9f11f3`（G4-24 の合わせた世界）。PR #418 の 001・002、PR #412 の `credential_row`、G5 PR #399、G3 PR #374 の世代の関数を、G4-24 と同じく読み取りだけで重ねた。

## 1. 新しいファイル（G4 だけ）
- `supabase/tests/postona_threads_rotation_cas_run.sh`（runner。環境の変数は `TQ_PGHOST`・`TQ_PGPORT`・`TQ_PGSUPER`。`jq` と `node` を使う）
- `supabase/tests/postona_threads_rotation_cas_behavior.sql`（振る舞い R1〜R7b。G4-24 の behavior の `cr.*` の前置きの後に流す）
- `supabase/tests/postona_threads_rotation_cas_collision.mjs`（同じマイクロ秒に始まった2つのトランザクションを見つけて使う）
- この文書

## 2. 見つかったこと（再現した）
**同じ Threads のアカウントで、延長の請求（claim）の後に再接続が起き、その再接続のトランザクションの `now()` が、請求した版を書いたトランザクションの `now()` と同じだと、古い延長が通ってしまう。** 再接続で入った token が、再接続の前の系統の token で上書きされる。

### 仕組み
- custody の版は `recorded_at = now()` で書かれる。`now()` はトランザクションの**開始の時刻**で、識別子ではない。
- 再接続では Vault の secret を**同じ id のまま**更新する（PR #124 の `vault.update_secret`、既存の `threads-credential-rotation-cas.md` の30〜37行）。そのため比較交換で再接続を見分ける手がかりは `recorded_at` だけになる。
- 再接続の custody の書き込みは `recorded_at = now()`、`verified_at = now()`。これが請求した版と同じ時刻なら、次のすべてが通る。
  - secret の id（同じ）
  - `custody.recorded_at = expected`、`lease.custody_recorded_at = expected`（同じ時刻）
  - `custody.recorded_at >= verified_at`（等しい）
- 既存の文書の37行の前提（`recorded_at` も比べれば再接続を見分けられる）は、同じ `now()` では成り立たない。
- リースは再接続で消されない。期限（60秒）の間は有効なままである。
- 延長の期限は、再接続の期限より長ければ通る。

### 実測（`TQ_* bash supabase/tests/postona_threads_rotation_cas_run.sh`、PostgreSQL 17.11、ローカルの socket）
| 試験 | 結果 |
|---|---|
| R7（同じトランザクション。同じ `now()` の確定的な模型）: 接続 → 請求 → 再接続（begin・complete）→ 延長 | **rotated**。`recorded_equal: true`、`verified_equal: true`。`credential_row` は Threads の利用者は同じまま、**再接続の前の系統の token**（`fakeTHREADSstaleLineage_…`）を新しい世代で渡す |
| 別々のトランザクション（`node` の collision）: 24 の session で同じマイクロ秒に始まった P・R を見つけた（1〜4回目で見つかった。xid は別）。P が接続して commit → C が請求 → R（`recorded_at = now()` を確認）が再接続して commit → C が延長 | **rotated**。古い系統の token が再接続の token を上書きした（`ROTATION_COLLISION_FINDING_REPRODUCED`） |
| R7b: 同じアカウントを**別の Threads の利用者**で再接続 | 入口が `THREADS_IDENTITY_ACCOUNT_MISMATCH` で拒否する。延長まで進まない。**影響は1人の Threads の利用者の中に留まる**（別人のアカウントへの投稿にはならない） |

### 脅威と失敗の条件（セキュリティのレビュー向け）
- 成り立つ条件（すべてが要る）:
  1. 請求した版を書いたトランザクション X（接続・再接続・延長のどれか）と、再接続の complete のトランザクション R が、**同じマイクロ秒に始まる**。
  2. H5 の延長の請求 C が、X の commit の後、R の commit の前に起きる。
  3. R が commit した後、リースの期限（60秒）のうちに、C の延長が rotate する。
  4. Meta での古い token の延長が成功している（再接続の前の権限がまだ有効）。
- 起きること:
  - 再接続で置き換えたはずの token の系統（たとえば漏れた token、権限の範囲が古い token）が戻り、`credential_row` が新しい世代でそれを渡す。
  - G3 の世代は変わるので、世代での古さの検出は効かない。
  - 拒否も記録も残らない（rotated として成功する）。
- 起きないこと:
  - 別の Threads の利用者・別のアカウント・別の作業場所への書き込み（R7b、既存の比較）。
  - 同じリースの二度使い、期限の短縮、切断の後の延長（R1〜R6・race。§3）。
- 起きやすさ: 低い。ただし、同じマイクロ秒に始まるトランザクションは、この Mac で24の session を開くと数回で見つかった。時計の後退（NTP の step）でも同じ時刻になりうる（**NOT_RUN**。時計は変えていない）。
- 深刻さの見立て（担当ちゃの判断の材料。確定ではない）: 中〜低。誤った利用者への投稿は起きないが、再接続の目的（token の入れ替え）が黙って取り消される。

### 未確認の同じ形
- 請求した版が**延長**（rotate も `recorded_at = now()`）で書かれた場合も、仕組みは同じ。今回は接続で書いた版だけを実測した（**NOT_RUN**）。

## 3. 安全の期待どおりだったこと（PASS）
| # | 確かめたこと | 結果 |
|---|---|---|
| R1 | 別々のトランザクション: 請求 → 期限を短くする延長は `EXPIRY_NOT_EXTENDED`（リースは残る）→ 請求した版で `rotated` → H5 が token を書く → 新しい token・新しい世代・後の `recorded_at` | PASS |
| R2 | **1つのトランザクションで2回延長**: 2回とも `recorded_at` は同じ（事実として記録）。それでも期限は延び、世代は変わる。リース a・b をもう一度使うと `LEASE_NOT_HELD` | PASS |
| R3 | 新しいリースに古い `recorded_at` → `STALE_CREDENTIAL`。何も書かれない。返却できる | PASS |
| R4 | トランザクションの rollback で、延長もリースも元に戻る。次の延長は通る | PASS |
| R5 | リースを持ったまま切断 → `CONNECTION_NOT_VERIFIED`。期限切れ → 請求が `CREDENTIAL_EXPIRED`／`CUSTODY_UNKNOWN` | PASS |
| R6 | ふつうの時刻（別の `now()`）の再接続の後の古い延長 → 拒否。再接続の token が残る | PASS |
| race | 同じリースで2つの session が延長: 1つが `rotated`、もう1つは `LEASE_NOT_HELD`（二重の成功は無い） | PASS |

### わざと入れた欠陥（4種、どれも検出）
| 欠陥 | 検出した試験 |
|---|---|
| `recorded_at` の比較を外す | R3（`STALE_CREDENTIAL` にならない） |
| リースを使い済みにしない | R2（2つ目の請求が通らない） |
| 期限が延びることを求めない | R1（短い期限が通る） |
| 延長のときに接続の状態を見直さない | R5（切断の後に通る） |

## 4. 修正の候補（製品の SQL は変えていない）
| 候補 | 内容 | この QA での確認 |
|---|---|---|
| A（試作した） | custody の書き込み（接続・再接続・延長）のたびに、そのアカウントのリースを消す。試験の世界だけの trigger `public.g4_25_prototype_drop_lease`（custody の insert・update の後） | **R7・collision とも `LEASE_NOT_HELD` で拒否、再接続の token が残る。R1〜R6 は変わらず PASS**。製品では trigger ではなく、`record_threads_credential_custody` と入口の中で消す形も考えられる |
| B | custody に単調に増える版の番号（`bigint`）を持たせ、リースと rotate の比較をその番号にする。時刻に頼らない | 未実装（設計のみ） |
| C | リースを `bindings.connect_proof`（または `oauth_state_id`）に結び付け、rotate で今の結び付けと同じかを確かめる | 未実装（設計のみ） |
| D | 再接続で Vault の secret を新しい id にする（その場の更新をやめる） | 未実装。Vault の後片付けの影響があり、PR #124 の範囲 |
| （不十分） | `recorded_at` を `clock_timestamp()` にするだけ | 同じ刻み・時計の後退が残るので、単独では足りない |

A と B（または C）を合わせるのが、いちばん強いと考える。採用の判断と、どの PR で直すかは担当ちゃとレビューに任せる。

## 5. 試験の世界
- G4-24（PR #449）の runner と同じ世界（G5 chain P1〜P10 ＋ R1／W1、F5 owner epoch、2a-2、PR #124、G4 custody、G3 の世代、PR #418 の 001・002、PR #412 の `credential_row`）に、投稿と release の候補、延長の候補を重ねた。
- 試験の世界だけの変更（G4-24 と同じ）: `auth.uid()` を JSON の claims も読む形にした、`brand_memberships` を revoke した。
- owner transport は模擬（H5 のコードは使っていない）。JSON だけの claims。
- 延長の H5 の側も模擬: 請求 → （Meta の延長は模擬しない）→ rotate → `vault.secrets` をその場で更新。
- 偽の token・偽の Vault。外部への通信は0。時計は変えていない。

## 6. NOT_RUN／NOT_VERIFIED
- 請求した版が延長で書かれた場合の同じ時刻（仕組みは同じ）
- 時計の後退（NTP の step）
- H5 の実際の延長の worker と transport のコード
- 本物の Supabase・Auth・Vault・Meta の延長、本番
- 修正の候補 B・C・D の実装
