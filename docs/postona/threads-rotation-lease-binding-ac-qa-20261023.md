# G4-29：Threads の延長（rotation）の案 A＋C の、隔離した統合 QA（2026-10-23 JST）

- task_id: `postona-g4-threads-rotation-lease-binding-ac-isolated-qa-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **ISOLATED_A_PLUS_C_PASS（使い捨ての PG17 の上だけ）／EXPECTED_FAIL 2件（F1・F2）／G4-28 の推論の1つを実測で訂正／PRODUCTION_NO_GO**
  - 製品の修正の完了ではない。採用・適用・マージはしない。独立のセキュリティのレビューと本番の GO は別。
  - 既存の SQL・migration・rotation と custody の候補・候補 A（001）・他の枠のファイル・既存の PR の head は変えていない。
- 土台: PR #462（`77602fcf2465a420feeb3554a741dff90adca39c`）→ PR #460（候補 A）→ PR #456 → PR #453 → PR #449

## 1. 新しいファイル（G4 だけ）
| ファイル | 内容 |
|---|---|
| `supabase/candidates/postona_threads_rotation_lease_invalidation/002_rotation_lease_binding.sql` | 隔離したソース候補 C |
| `supabase/candidates/postona_threads_rotation_lease_invalidation/002_rotation_lease_binding_rollback.sql` | その rollback（claim と rotate を A が固定した本体に戻す） |
| `supabase/tests/postona_threads_lease_binding_run.sh` | runner（`TQ_PGHOST`・`TQ_PGPORT`・`TQ_PGSUPER`。`jq`・`node`・`python3`。1〜3節と補助は G4-27 の runner の写し） |
| `supabase/tests/postona_threads_lease_binding_behavior.sql` | A＋C の振る舞い B1〜B8 と EXPECTED_FAIL F1・F2（psql の変数 `a_mode` = on／off／absent） |
| この文書 | |

## 2. 候補 C の形
- リースの表に `binding_oauth_state_id uuid not null` を足す。適用のときに、ある行（60秒で終わるもの）は消す。
- **claim**（同じ形のまま置き換え）:
  - アカウントの行・custody・投稿の途中の確認の後、リースを読む前に、binding を `credential_row` と同じ条件で読む。条件は、アカウント・作業場所が同じで、Threads の利用者がアカウントの `platform_user_id` であること。
  - 無ければ `CONNECTION_NOT_BOUND`。あれば、その `oauth_state_id` をリースに書く。答えの形は変えない。
- **rotate**（同じ形のまま置き換え）:
  - リースと所有者の確認の後、比較交換の前に、同じ条件で binding を読む。
  - 無い、またはリースの値と違えば `BINDING_CHANGED`。
- **読む位置**: どちらもアカウントの行を FOR UPDATE で持った後に読む。001 の入口は、このロックを持っている間にしか binding を書かない。
- **前提の確認**:
  - A がある（関数と trigger 2つ）
  - binding の表がある（`oauth_state_id` が NOT NULL）
  - 両方の表の所有者が適用する人である
  - まだ適用していない
  - claim／rotate の本体が A の固定の md5（`2d5fdec6…`／`4de6764d…`）
- **事後の確認**:
  - 新しい本体の md5（claim `3f0c22c6…`、rotate `ba39c98f…`）
  - INVOKER のまま・所有者だけの ACL
  - 列が NOT NULL
  - A の trigger が2つとも ALWAYS
- **rollback**: 本体を A の固定に戻し、列を消す。戻らなければ `ROLLBACK_INCOMPLETE`。順は「C → A → rotation」。

## 3. 結果（`TQ_* bash supabase/tests/postona_threads_lease_binding_run.sh`、PostgreSQL 17.11、ローカルの socket、外部への通信は0）
最終の判定: `POSTONA_THREADS_LEASE_BINDING_RUN_PASS`（clean な HEAD での実行は REPORT に記す）

| 節 | 確かめたこと | 結果 |
|---|---|---|
| 4 | A が無い → `PRECONDITION_A`。binding の表が無い → `PRECONDITION_TABLES`。所有者でない → 拒否（binding のスキーマに権限が無く、前提の確認の段階で `permission denied for schema postona_threads_binding`）。rotate の本体がずれている → `PRECONDITION_ROTATION`。二度目 → `ALREADY_APPLIED` | PASS |
| 5 | B1: リースが今の binding を名指しし、`rotated`。同じリースは二度使えない | PASS（A on／off） |
| 5 | **B2: G4-25 の再現（1トランザクション、同じ `now()`）** → A on は `LEASE_NOT_HELD`、**A の trigger を止めても `BINDING_CHANGED`**。どちらも再接続の token が残る | **PASS（G4-27 の限界を C が閉じた）** |
| 5 | B3: binding が無い → `CONNECTION_NOT_BOUND`（`credential_row` も0行） | PASS |
| 5 | B4: binding の Threads の利用者・作業場所が食い違う → `CONNECTION_NOT_BOUND` | PASS |
| 5 | B5: custody を書かずに binding だけが変わる（A には見えない）→ `BINDING_CHANGED` | PASS |
| 5 | B6: 古い保留の state が後から完了（最後の完了が勝つ）→ 新しい接続の claim は拒否 | PASS |
| 5 | B7: アカウントの削除 → 拒否。リースも binding も消える | PASS |
| 5 | B8: 新しい列も claim／rotate も、API の役割から届かない | PASS |
| 5 | PR #453 の R1〜R7b、G4-27 の N1〜N5 を A＋C で | PASS |
| 6 | 同じマイクロ秒に始まった別々のトランザクション（collision）: A off → `BINDING_CHANGED`、A on → `LEASE_NOT_HELD`。再接続の token が残る | PASS |
| 6 | replica の mode（A の trigger を ORIGIN にした）での再接続 → 入口そのものが拒否する（`THREADS_BINDING_OWNER_EPOCH_UNKNOWN`）。何も書かれず、リースも binding も残る。「A が飛ばされる」場合は、A off の実行で確かめた | PASS（実測。入口が安全側に倒れる） |
| 7 | ロックの順（A off、C だけ）:<br>E1: 再接続が先 → 待った claim は新しい binding を名指しし、`rotated`<br>E2: claim が先 → 待った再接続の後、その claim は `BINDING_CHANGED`<br>E3: rotate が先 → 再接続が最後に書く<br>E4: 同じリースを2つの session で使う → 1つだけ `rotated`<br>デッドロックは無い | PASS |
| 8 | rollback:<br>C → A の順 → 本体が A の固定に戻り、R7 が再び再現する<br>**A を先に戻す** → C だけで B1〜B8 が通る（`a_mode = absent`）<br>**binding の層（`credential_row` → 002 → 001）を先に戻す** → claim がエラー（relation が無い）でリース無し。C を戻すと claim が戻る<br>claim を戻し忘れる rollback → `ROLLBACK_INCOMPLETE` | PASS |
| 9 | C の欠陥 6種（事後の確認を外した写しでも振る舞いで検出）:<br>rotate が binding を比べない → B5<br>claim が別の値を書く → B1<br>claim の条件から Threads の利用者を外す → B4<br>作業場所を外す → B4<br>`CONNECTION_NOT_BOUND` を外す → B3（NOT NULL の違反）<br>rotate が binding を読まない → B5 | **6/6** |
| — | F4 の rotation の試験の全体を C つきで | **NOT_RUN**。F4 の世界には PR #418 の 001（binding）が無く、すべての claim が `CONNECTION_NOT_BOUND` になる（G4-28 §4）。C は合わせた世界で試した |

### EXPECTED_FAIL（A＋C でも防げないもの。実測）
- **F1: PR #124 の `complete` を単独で呼ぶ**（入口を通らない、custody を書かない、binding も変えない）。同じ `now()` で起きると:
  - 古い延長が `rotated` になる（A on・off とも）。
  - **`credential_row` は1行を返し、古い系統の token を渡す**。
- **G4-28 の訂正**: G4-28 §3（と REPORT）は、T3 の影響を「`credential_row` は0行になるので小さい」と書いた。これは**時刻が違う場合の推論で、同じ `now()` では誤り**だった。
  - 同じ時刻だと `recorded_at = verified_at` になる。期限の読み出し（`recorded_at >= verified_at`）が値を返すので、`credential_row` は古い系統を渡す。
  - G4-24 の C3 の0行は、別の時刻での実測だった。
- **F2: Vault の secret をその場で直接書き換える**（custody も binding も変えない）→ その後の rotate は `rotated`。

## 4. 残る危険と、B（版）や運用での対策
| # | 残る危険 | A＋C | 対策の候補 |
|---|---|---|---|
| 1 | **F1 入口を通らない PR #124 の `complete`**。同じ時刻なら古い系統が渡る（実測） | × | ① PR #124 の `complete` を入口の中からしか呼べないようにする（入口だけが所有者の `complete` を呼び、owner transport は入口を使う。G4-19／G4-24 の H5 の移行。今の H5 の transport は `complete` を直接呼んでいる＝**この経路そのもの**）<br>② `complete` 自身がリースを消す、または binding の書き換えを必須にする（PR #124 の範囲）<br>③ B（`complete` も custody の版を進める） |
| 2 | F2 Vault の直接の更新 | × | Vault を書くのは rotate のトランザクションの H5 だけにする（運用・H5 の条件）。DB で捕まえるなら E2（行の版 `xmin`、G4-28 §5）だが、懸念が多い |
| 3 | 所有者が claim／rotate の本体を置き換える | × | 本体の md5 の定期の監査（C の事後の確認と同じ問い合わせ） |
| 4 | H5 が拒否の後に token を持ち越す | × | H5 の条件（G4-26 §2.4） |
| 5 | A の trigger の停止 | **○（C が閉じた、B2・collision・E2 で実測）** | — |
| 6 | binding が無いアカウント（001 より前の接続）は延長できない | 仕様（`CONNECTION_NOT_BOUND`） | 再接続を求める。延長したいなら B が要る |

- **B が要るかの判断**: F1 を DB で閉じたい場合（`complete` の単独の呼び出しを禁止できない場合）、または binding が無いアカウントを延長したい場合に要る。
- F1 の経路を閉じる最も小さい手は、上の①（入口の外から `complete` を呼べなくする）と考える。これは PR #124 と H5 の transport に関わるので、G4 だけでは決められない。

## 5. G3／G5／H5 との境界
| 担当 | 影響 |
|---|---|
| H5（#332、idle。割り当てていない） | 延長の store port で `CONNECTION_NOT_BOUND`（要再接続）と `BINDING_CHANGED`（その回は捨てる）を扱う。**今の owner transport は PR #124 の `complete` を直接呼ぶので、F1 の経路そのものである**（入口への移行が要る。G4-24 から未回答） |
| G3 | 変更は要らない（007 の世代はリースの `lease_id` と secret だけを hash する。新しい列は入らない） |
| G5 | 変更は要らない（F5 の判断とロックの順は同じ） |
| PR #124（G4 の系統） | F1 を閉じる②の候補の置き場所。001 は `complete` の md5 を固定しているので、変えるなら固定の更新も要る |

## 6. 独立のレビューの12項目（A＋C、この QA の証拠）
| # | 論点 | 証拠 | 残り |
|---|---|---|---|
| 1 | 脅威の再評価（Meta の24時間の規則） | G4-26 §2.1（source） | Meta の規則は未確認 |
| 2 | A の trigger が飛ばされる経路 | G4-27 N1〜N8／8節、**この QA の B2・collision（A off）で C が閉じた** | 管理環境の役割 |
| 3 | A＋C のロックの順 | E1〜E4（A off）、G4-27 E1〜E3（A on） | 負荷の下 |
| 4 | C の binding がロックの下で安定しているか | E1・E2、B6 | 読む位置を前にずらす mutant は、同じ時刻＋ロックの待ちでしか差が出ないので、ここでは作っていない（source のレビューで確認） |
| 5 | `oauth_state_id` の一意性 | B6（古い state の後からの完了も別の値） | — |
| 6 | C の条件と `credential_row` の一致 | B3・B4、mutant 2種 | — |
| 7 | H5 の条件と新しい code | 設計のみ | H5 は未実装 |
| 8 | rollback の順 | 8節（4通り） | — |
| 9 | **F1・F2 を DB で捕まえる必要** | **F1 は実測で古い系統が渡る** | ①〜③と E2 の判断 |
| 10 | 時計と無関係 | B2・collision（時刻に頼らず拒否） | 時計の step は未実測 |
| 11 | ACL と事後の確認 | 4節、B8、mutant | 管理環境 |
| 12 | 監査（`BINDING_CHANGED` と `LEASE_NOT_HELD` の区別、trigger の状態と本体の md5） | B2 で code が分かれることを実測 | 運用の決定 |

## 7. NOT_RUN／NOT_VERIFIED
- F4 の rotation の試験の全体を C つきで（世界に 001 が無い）
- binding を読む位置をロックの前にずらす mutant（決まった再現の方法が無い）
- Meta の24時間の規則、H5 の延長の worker と transport の実コード、時計の step
- G3 の preflight（007 全体）、G5 の T13 の方針
- 本物の Supabase・Auth・Vault・Meta、本番、管理環境の役割の構成
- B と E2 の実装
