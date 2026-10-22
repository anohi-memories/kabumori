# G4-27：Threads の延長（rotation）の比較交換の競合に対する案 A（リースの失効）の隔離したソース候補と、競合の回帰 QA（2026-10-23 JST）

- task_id: `postona-g4-threads-rotation-cas-lease-invalidation-isolated-source-candidate-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **ISOLATED_SOURCE_CANDIDATE_PASS（使い捨ての PG17 の上だけ）／案 A 単体の限界は FAIL として明記／PRODUCTION_NO_GO**
  - **製品の修正の完了ではない。** 採用・独立のセキュリティのレビュー・本番の適用・マージは別。
  - 既存の SQL・migration・rotation と custody の候補・他の枠のファイル・既存の PR の head は変えていない。
- 土台: PR #456（`fc132e1cf13047d7c05c9546b7570d41d95ae7d0`）。その下に PR #453（G4-25 の再現）と PR #449（G4-24 の合わせた世界）。

## 1. 新しいファイル（G4 だけ）
| ファイル | 内容 |
|---|---|
| `supabase/candidates/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation.sql` | 隔離したソース候補 A（trigger の関数1つ・trigger 2つ・前提の確認・事後の確認） |
| `supabase/candidates/postona_threads_rotation_lease_invalidation/001_rotation_lease_invalidation_rollback.sql` | その rollback |
| `supabase/tests/postona_threads_lease_invalidation_run.sh` | runner（環境の変数は `TQ_PGHOST`・`TQ_PGPORT`・`TQ_PGSUPER`。`jq`・`node`・`python3` を使う。1〜3節は PR #453 の runner の写し） |
| `supabase/tests/postona_threads_lease_invalidation_behavior.sql` | 案 A そのものの振る舞い（N1〜N5） |
| `supabase/tests/postona_threads_lease_invalidation_legacy_patch.py` | F4 の rotation の試験全体を、**使い捨ての写しの上だけ**で、案 A で意図して変わる期待（L1〜L4）に書き換える |
| この文書 | |

## 2. 候補の形と、選んだ理由
- **custody の行の AFTER INSERT OR UPDATE OR DELETE（行ごと）と AFTER TRUNCATE（文ごと）**: そのアカウントのリースを消す（TRUNCATE ならすべて）。
  - 再接続の custody の書き込み（002 の upsert）は、再接続と同じトランザクションの中でリースを終わらせる。
  - 古い延長の rotate は、時刻と関係なく `LEASE_NOT_HELD` になる。
- **SECURITY DEFINER**（custody とリースの表の所有者）・`search_path = ''`・`row_security = off`:
  - INVOKER だと、リースを DELETE できるが RLS のポリシーが無い役割が custody を書いたとき、何も消さずに黙って通る（mutant `security_invoker` が N7 で実証）。
  - DEFINER なら、書いた役割と関係なくリースが終わる。
  - trigger の関数は直接呼べない。消すのはリースだけで、延長が安全側に失敗する方向にしか働かない。
  - `row_security = off` は、将来 RLS が強制されたら、黙って0行にならずにエラーになる。
- **ENABLE ALWAYS**: `session_replication_role = replica`（論理複製の適用や復元の道具）でも動く（mutant `not_always` が N6 で実証）。
- **前提の確認**:
  - 表が2つともある（`PRECONDITION_TABLES`）。
  - 両方の表の所有者が適用する人である（`PRECONDITION_OWNER`）。
  - rotation の claim／rotate／release の本体が、レビューした md5 と同じである（`2d5fdec6…`／`4de6764d…`／`94c68c16…`、`PRECONDITION_ROTATION`）。
  - まだ適用していない（`ALREADY_APPLIED`）。
- **事後の確認**:
  - 関数が DEFINER・VOLATILE・設定が2つ・所有者だけ。
  - trigger が2つとも `tgenabled = 'A'` で、型（イベント）が正確。
  - API の役割が custody を書けず、リースに触れない。
- **ロックの順**: trigger は custody の行の後に、リースの行だけをロックする。接続も claim と rotate も、アカウントの行を先に持つ。新しい待ちの輪はできない（E1〜E3 で実測）。

## 3. 結果（`TQ_* bash supabase/tests/postona_threads_lease_invalidation_run.sh`、PostgreSQL 17.11、ローカルの socket、外部への通信は0）
最終の判定: `POSTONA_THREADS_LEASE_INVALIDATION_RUN_PASS`（runner の出力から写した。commit 後の clean な HEAD での実行は REPORT に記す）

| 節 | 確かめたこと | 結果 |
|---|---|---|
| 4 | rotation の候補より前に適用 → `PRECONDITION_TABLES`。rotate の本体がずれている → `PRECONDITION_ROTATION`。所有者でない役割 → `PRECONDITION_OWNER`。二度目 → `ALREADY_APPLIED` | PASS |
| 5 | PR #453 の R1〜R6 は変わらず PASS。**R7（同じ `now()`、1トランザクション）は `LEASE_NOT_HELD` で拒否、再接続の token が残る**。R7b（別の Threads の利用者）も同じ | PASS |
| 5 | N1: INSERT・UPDATE（関係ない列でも）・DELETE が、そのアカウントのリースだけを終わらせる。別のアカウントのリースは残る | PASS |
| 5 | N2: 再接続の後の新しい claim は再接続の版を名指しし、`rotated`。再接続の token の延長が渡される。古い claim は `LEASE_NOT_HELD` | PASS |
| 5 | N3: 再接続をトランザクションでも savepoint でも rollback すると、リースが戻る。その claim は延長できる | PASS |
| 5 | N4: 所有者（superuser でない）は `session_replication_role` を変えられない。trigger は2つとも ALWAYS（監査の問い合わせで確認）。API の役割に EXECUTE が無い | PASS |
| 5 | N5: custody の TRUNCATE で、すべてのリースが終わる | PASS |
| 5 | N6: superuser が replica の mode で custody を書いても、リースが終わる | PASS |
| 5 | N7: ポリシーで custody を書け、リースを DELETE できるが RLS に掛かる役割の書き込み → リースが終わる。N7b: リースの権限が無い役割でも同じ | PASS |
| 5 | N8: 所有者でない役割は trigger を止められない（`must be owner`） | PASS |
| 6 | ロックの順 E1: 再接続が先に行を持つ → 待った claim は再接続の版で、`rotated`。E2: claim が先 → 待った再接続がリースを終わらせ、その claim は `LEASE_NOT_HELD`。E3: rotate（＋H5 の Vault の書き込み）が先 → 待った再接続が最後に書き、再接続の token が残る。デッドロックは無い | PASS |
| 7 | 同じリースを2つの session で使う → 1つだけが `rotated`、もう1つは `LEASE_NOT_HELD` | PASS |
| 7 | **同じマイクロ秒に始まった別々のトランザクション**（`node` の collision）→ 古い延長は `LEASE_NOT_HELD`、再接続の token が残る | PASS |
| 8 | **表の所有者が trigger を止めると、R7 は再び再現する**。監査の問い合わせは `tgenabled = D` で気づく | **EXPECTED_FAIL（案 A の限界。fail-closed ではない）** |
| 9 | F4 の rotation の試験の全体（ACL、投稿の途中、F5 のすべての状態、所有者の結び付け、13種の競合、fail-before、rotation の mutant 26種）を、案 A を足して実行（L1〜L4 の書き換えだけ） | PASS（`ALL PASS`。mutant 25種を検出。残る1種 `lease_not_consumed` は案 A では同値: **EQUIVALENT_UNDER_A**。案 A なしの基準の実行では26種すべてを検出） |
| 10 | 正しい順の rollback → trigger が消え、R7 が再び再現する（修正が効いていたことの確認）。**誤った順**（rotation の表を先に消す）→ custody の書き込みがすべてエラーになり、何も書かれない（安全側）。その後、候補の rollback で接続が戻る | PASS |
| 11 | 候補の欠陥 6種（他のアカウントを消す、UPDATE を外す、DELETE を外す、TRUNCATE で消さない、INVOKER、ALWAYS でない）。事後の確認を外した写しでも、振る舞いで検出 | **6/6** |

### F4 の試験の期待の書き換え（L1〜L4、使い捨ての写しの上だけ）
- **L1**（7節）: リースを持ったままの再接続は、リースを終わらせる。旧: `STALE_CREDENTIAL`／`LEASE_HELD`／`released`。新: `LEASE_NOT_HELD`／リース無し／`not_held`。
- **L2**（9節・14節）: rotate 自身の期限と secret の確認を試すための custody の直接の書き込みは、trigger を止めて行う（試験の世界だけ）。
  - そのため、rotate の確認（`CREDENTIAL_EXPIRED`・`STALE_CREDENTIAL`）は試験され続ける。
  - そのうえで、trigger を戻した同じ書き込みがリースを終わらせることも確かめる。
- **L3**（競合 `reconnect`）: 待っていた rotate は `LEASE_NOT_HELD`（旧: `STALE_CREDENTIAL`）。
- **L4**（mutant `lease_not_consumed`）: 案 A では、rotate の custody の更新でリースが終わるので、同値になる。検出されないことを期待どおりとして記録する。
- 試験のためだけに、候補の md5 の固定を外した写しを使う。固定は4節で別に証明している。こうしないと、F4 の rotate の mutant が、振る舞いではなく固定で止まってしまう。

## 4. 限界と残る危険（案 A 単体）
1. **所有者（または superuser）が trigger を止める・消すと、欠陥が戻る**（8節、EXPECTED_FAIL）。
   - rotate の時点では気づけない。事後の確認と監査の問い合わせ（`pg_trigger.tgenabled`）だけで気づける。
   - 「止める → 再接続 → 戻す」の窓は、rotate に確認を足しても閉じられない。
   - 所有者は信頼する前提だが、設定の誤り（止めたままにする）に備えて、定期の監査が要る。
2. **custody を書かない token の変化は、リースを終わらせない**:
   - PR #124 の `complete` を単独で呼ぶ（入口を通らない。G4-24 の C3 では `credential_row` が0行になるので、token は渡されない）
   - Vault のその場の直接の更新
   - 案 C（リースを `bindings.oauth_state_id` に結び付ける）か B（sequence の版）が要る。**未採用・別の設計判断**。
3. **H5 の条件**（G4-26 §2.4）は、どの案でも残る。
   - token は claim と同じトランザクションで読む。
   - 拒否の後に、延長した token を新しい claim に持ち越さない。
   - 持ち越すと、案 A があっても古い系統が新しい版で書かれうる（DB では防げない）。
4. **監査のしやすさ**: rotate の `LEASE_NOT_HELD` は、「再接続で終わったリース」と「使い済み・再生」を区別しない。
5. **rotate の単回使用（リースの削除）は、案 A では二重になる**（L4）。rotate の削除を外しても試験では区別できない。将来 trigger が外されたときの備えとして、rotate の削除は残すべきである。

## 5. 分けて残す未確認（NOT_RUN／NOT_VERIFIED）
- Meta の24時間の規則が実際に強制されるか（G4-26 §2.1 の支え）
- H5 の延長の worker と transport（延長の store port はまだ無い）
- 時計の step（後退）の実測
- G3 の preflight（007 全体）と F3 の 001〜006、G5 の T13 の方針（#320 の未回答）
- 本物の Supabase・Auth・Vault・Meta・本番、管理環境の役割の構成（所有者・superuser・replica の権限）
- 案 B・C の実装

## 6. 独立のレビューのための12項目（G4-26 §7 と、この QA の証拠の対応）
| # | 論点 | この QA の証拠 | 残り |
|---|---|---|---|
| 1 | 脅威の再評価（24時間の推論） | なし（source のみ、G4-26） | Meta の規則の確認 |
| 2 | trigger がすべての書き込みで動くか、飛ばせる役割 | N1・N5・N6・N7・N7b・N8、mutant 6/6、8節（所有者は止められる） | 管理環境の superuser・replica の権限 |
| 3 | ロックの順 | E1〜E3（デッドロック無し）、F4 の lock_order／claim_lock_order の競合 | 負荷の下 |
| 4 | 案 C の binding の安定 | 対象外（未採用） | 案 C の設計 |
| 5 | 案 B の sequence | 対象外（未採用） | 同上 |
| 6 | H5 の条件 | なし（H5 は未実装） | H5 の store port |
| 7 | 監査の code | §4-4 | 区別の要否 |
| 8 | rollback の順と、R7 が戻ること | 10節 | — |
| 9 | 時計 | 案 A は時刻を使わない（R7・collision） | step の実測 |
| 10 | Meta の24時間の規則 | なし | 確認 |
| 11 | ACL と事後の確認 | 4節、N4、mutant `security_invoker`／`not_always` | 管理環境 |
| 12 | 入口を通らない `complete` | §4-2 | 共有の表の所有者の決定（G3-22） |

## 7. 適用と rollback の順（使い捨ての PG17 での手順。本番の手順ではない）
- 適用: custody の候補 → … → rotation の候補 → **この候補**
- rollback: **この候補の rollback** → rotation（rotation の rollback の file はまだ無い）
- 誤った順（rotation が先）では、custody の書き込みがエラーになる（10節）。
