# G3｜PR #370 の ACL の権限の境界: Codex Sol（高）の限定レビューのための証跡（2026-10-20、Issue #318 TASK 15/50）

- task_id: `postona-g3-pr370-acl-review-evidence-offline-20261020`
- 返却先: POSTONA G3のちゃ
- 完了コード: K3
- 対象: G3 Draft PR #370（`05ef903c31c120634906fa8b62481711f4a37a4c`、base main、レビュー 0 件）。この PR は #370 の上に積んであり、#370 のファイルは**変えていない**。
- 判定: **SOURCE_ONLY の証跡。#370 はまだレビューを受けておらず、安全と判定しない。本番 NO_GO**
- 作業範囲: TASK 8 の改訂（攻撃の実演はしない）に従う。
  - 候補を当てる**前**は、カタログの照会だけ。
  - 当てた**後**は、カタログに加えて、拒否されるべき文が決まった SQLSTATE で拒否されることを確かめる（拒否の確認）。
  - 残る権限は、カタログだけで示し、実行しない。

## 1. 実行のしかた
```
BM_PGHOST=/private/tmp/<socket> BM_PGPORT=<port> BM_PGSUPER=<local superuser> \
  bash supabase/candidates/postona_brand_memberships_privileges/brand_memberships_acl_evidence_run.sh
# → BRAND_MEMBERSHIPS_ACL_EVIDENCE_ALL_PASS
```
- 土台は #370 のランナーと同じ: 偽の fixture（新しい表への既定の付与を、プラットフォームの既定の模型として入れる [A]）、X の接続 RPC、削除の候補、membership の migration（`20260918120000`）。
- 使い捨ての PG17。ネットワークは使わない。G5 のファイルは使わない（G5 との順番は #370 の O1〜O4）。

## 2. E1: 有効な権限（`has_table_privilege`）の前後
列: SEL INS UPD DEL TRU REF TRI MAI（MAI = PG17 の MAINTAIN）。`kb_cal_*_child` は、authenticated・service_role を INHERIT で受け継ぐ役割の代表。

| 役割 | 前 | 後 |
|---|---|---|
| anon | `--- --- --- --- --- --- --- ---` | `--- --- --- --- --- --- --- ---` |
| authenticated | `SEL --- --- --- TRU REF TRI MAI` | `SEL --- --- --- --- --- --- MAI` |
| kb_cal_auth_child（authenticated を受け継ぐ） | `SEL --- --- --- TRU REF TRI MAI` | `SEL --- --- --- --- --- --- MAI` |
| service_role | `SEL INS UPD DEL TRU REF TRI MAI` | `SEL INS UPD DEL TRU REF --- MAI` |
| kb_cal_svc_child（service_role を受け継ぐ） | `SEL INS UPD DEL TRU REF TRI MAI` | `SEL INS UPD DEL TRU REF --- MAI` |
| authenticator | `--- --- --- --- --- --- --- ---` | `--- --- --- --- --- --- --- ---` |
| PUBLIC | `--- --- --- --- --- --- --- ---` | `--- --- --- --- --- --- --- ---` |
| 表の owner | すべて | すべて |

役割の属性（模型）:
- service_role だけが `bypassrls=true`。
- anon・authenticated・authenticator・owner は `bypassrls=false`、superuser でない。
- owner だけがログインできる。

membership（PG16 以降の INHERIT・SET・ADMIN の選択肢つき）:
- `kb_cal_svc_child` → service_role、`kb_cal_auth_child` → authenticated（inherit・set、admin なし）
- owner → anon・authenticated・service_role・両方の child
- API の役割が上の役割の member である線は無い（API の役割から owner や superuser に届かない）。
- 共有のクラスタには、他のテストの owner が API の役割の member として残っているが、これは API の役割に何も与えない。

RLS: 有効・FORCE ではない・ポリシーは 1 つ（前後で同じ）。

## 3. E2: 拒否の確認（候補の後だけ。どれも rollback するトランザクションの中）

| 役割 | 文 | 期待・実際の SQLSTATE |
|---|---|---|
| authenticated・kb_cal_auth_child | INSERT・UPDATE・DELETE・TRUNCATE | 42501 |
| authenticated・kb_cal_auth_child | CREATE TRIGGER（存在しない関数を名指し） | 42501 |
| anon | SELECT・TRUNCATE・CREATE TRIGGER | 42501 |
| service_role・kb_cal_svc_child | CREATE TRIGGER | 42501 |
| authenticator | SELECT・CREATE TRIGGER | 42501 |
| **対照**: owner | 同じ CREATE TRIGGER | **42883**（権限の確認は通り、関数が無くて止まる） |

- 確認の後、カタログ（権限の表）は変わらず、トリガーも残っていない。
- REFERENCES は、実行では確かめていない（カタログだけ）。一時テーブルは永続テーブルを参照できない（42P16）。永続テーブルで試すには、スキーマへの CREATE の付与が必要になり、それはこの証跡では足さない権限だからである。

## 4. E3: 候補の後も残るもの（カタログだけ。実行はしていない）

| 残るもの | 影響 | 扱いの案 |
|---|---|---|
| authenticated の **MAINTAIN**（PG17: VACUUM・ANALYZE・LOCK・REINDEX・CLUSTER） | 利用者の SQL の文脈から、表のロックや保守の操作ができうる。PostgREST はこれらを出さない。G5 の検査の対象外 | 別の判断。`revoke maintain … from authenticated` を足すかどうかを Sol で決める（#370 は変えていない） |
| service_role の TRUNCATE・REFERENCES・MAINTAIN、BYPASSRLS | バックエンドの鍵を持つ側の権限。G5 の L-1 の範囲外 | そのまま（L-1 の範囲どおり） |
| 表の owner と、owner の definer 関数 | RLS は FORCE ではないので、owner は RLS を通らない | 意図どおり（definer の RPC と削除の流れ） |
| owner の既定の ACL（public の表に、anon・authenticated・service_role へ ALL、`arwdDxtm`） | 表を作り直すと、TRIGGER・TRUNCATE・REFERENCES が戻る | migration で作り直さないこと。作り直す場合は、#370 の候補を当て直す。G5 の install の検査が、その状態では拒否する（#370 の C6・O4） |

## 5. 依存と順番（G5・G4 の境界は変えていない）
1. **G3 #370**（この候補）→ **G5 #303**（owner epoch。#370 の前では `OWNER_EPOCH_PRECONDITION_API_ROLE_CAN_CREATE_MEMBERSHIP_TRIGGERS` で止まる）→ G5 #351 → #358 → **#371**（R1・W1・W2）。
   - #370 のランナーの O1〜O4 は、G5 #358 の木でも、**#371 の木でも**合格した（今回あらためて実行）。
2. G4: #124 → 保管 → #367（結び付け）→ #377（`credential_row`）。#377 の install は、「API の役割が owner に届かないこと」を確かめる。この候補はそれを変えない。
3. G3: 007 は #371 の後（TASK 10・11）。
4. 戻す順番: G5 #371 → #303 → この候補の rollback（G5 の owner epoch が入っている間は、rollback は止まる。#370 の O3）。

本番の展開と戻しのリスク:
- 本番の表の owner は UNKNOWN（`postgres` か、別の役割か）。候補は owner 以外では止まる（`BM_PRIV_PRECONDITION_NOT_TABLE_OWNER`）。止まる側だが、適用する役割を、読み取りの事前確認で決める必要がある。
- 本番の付与・役割の形は UNKNOWN（例: `authenticator` が LOGIN・NOINHERIT で 3 つの API の役割の member であること、既定の付与の付与者）。模型と違う場合は、事後条件で全体が戻る（止まる側）。
- ロック: share row exclusive・5 秒。書き込みは待ち、読み取りは待たない（#370 の K1・K2）。
- 戻すと、TRIGGER などが戻る。G5 が入っている間は止まる。

## 6. Codex Sol（高）の限定レビューの対象（案。割り当ては担当ちゃ）

| # | 重要度 | 見てほしいこと | 再現・確認 |
|---|---|---|---|
| R-1 | High | 本番での実行の役割と owner の前提（`NOT_TABLE_OWNER`）、別の付与者の付与が残ったときに事後条件で止まること | `001_…revoke.sql` の前提と事後条件。#370 の C1・C2 |
| R-2 | High | 事後条件の MEMBER の到達（`pg_has_role … 'MEMBER'`）が、G5 #303 の露出の検査と同じ範囲であること。authenticator の本物の形（LOGIN・NOINHERIT）でも足りるか | §2 の membership、#370 の C2・O2 |
| R-3 | Medium | authenticated に MAINTAIN を残してよいか（PG17） | §4、`has_table_privilege('authenticated', …, 'MAINTAIN')` |
| R-4 | Medium | 既定の ACL による、作り直しの際の再付与。migration の規則にするか | §4 の `pg_default_acl` |
| R-5 | Medium | PUBLIC・BYPASSRLS・grant option の事後条件の、**止まる側**は試していない（TASK 8 の変異 C15・C16 が残った理由） | `001_…revoke.sql` の該当の分岐 |
| R-6 | Low | rollback の前提（G5 が入っている間は止まる）と、戻す順番 | #370 の O3・O4 |
| R-7 | Low | ロックとタイムアウト | #370 の K1・K2 |

## 7. 結果（実測）
- この証跡: `BRAND_MEMBERSHIPS_ACL_EVIDENCE_ALL_PASS`
  - E1: 前後の表が期待と完全に一致
  - E2: 拒否の確認 18 件がすべて 42501、owner の対照は 42883、何も変わらない
  - E3: 残るものを記録
- 変異テスト: 候補の写しに 3 個を入れ（`BM_CANDIDATE`。#370 のファイルは変えない）、**3 個すべてを検出**した。
  - service_role の TRIGGER を残す（事後条件も外す）
  - MAINTAIN も取り上げる（レビューした内容からのずれ）
  - authenticated の SELECT を取る（事後条件も外す）
- 回帰（すべて合格）:
  - #370 自身のランナー: G5 #358 の木と #371 の木の両方で `BRAND_MEMBERSHIPS_PRIVILEGES_ALL_PASS`
  - G3 #392 → `POSTONA_THREADS_P7_GATE_PASS`
  - G3 #390 → `POSTONA_THREADS_HTTP_CONTRACT_ALL_PASS`
  - G3 #382 → `POSTONA_THREADS_G4_CREDENTIAL_ALL_PASS`
  - Deno の単体 116 件

## 8. NOT_VERIFIED
- 本番の付与・役割の形・表の owner・既定の付与の付与者（managed は読んでいない）。
- 本物の Supabase の authenticator の形（LOGIN・NOINHERIT・3 つの API の役割の member）での事後条件。
- MAINTAIN・TRUNCATE・REFERENCES を実際に使ったときの影響（実演はしない）。
- PUBLIC・BYPASSRLS・grant option の事後条件で止まる側（権限を足さないと作れない）。
