# G4-31：消費済みの state の指紋による F1 の対策（案 ④）の、隔離した PG17 の QA（2026-10-23 JST）

- task_id: `postona-g4-threads-consumed-state-fingerprint-f1-isolated-qa-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **ISOLATED_A_C_4_PASS（使い捨ての PG17 の上だけ）／F1 は隔離候補で拒否／F2 は EXPECTED_FAIL のまま／PRODUCTION_NO_GO**
  - 製品の修正の完了ではない。採用・適用・マージはしない。独立のセキュリティのレビューと本番の GO は別。
  - 既存の SQL・migration・候補（rotation・custody・A・C・001・002・PR #124）・H5 のコード・他の枠のファイル・既存の PR の head は変えていない。
  - F2（Vault の直接の更新）、H5 の直接の `complete`・claims の不整合、X の `complete` の `platform` の条件は、対象外として**未解決**。X の件は Issue #131（X OAuth v2、延期）の再開には当たらない、読み取りだけのメモ（G4-30 §4）にとどめる。
- 土台: PR #469（`a2b15013097b09898e29a5d92034b853ff9282f2`）→ #467（C）→ #462 → #460（A）→ …

## 1. 新しいファイル（G4 だけ）
| ファイル | 内容 |
|---|---|
| `supabase/candidates/postona_threads_rotation_lease_invalidation/003_rotation_lease_connect_fingerprint.sql` | 隔離したソース候補 ④ |
| `supabase/candidates/postona_threads_rotation_lease_invalidation/003_rotation_lease_connect_fingerprint_rollback.sql` | その rollback（C の本体に戻す。順が違えば拒否） |
| `supabase/tests/postona_threads_connect_fingerprint_run.sh` | runner（`TQ_*`。`jq`・`node`・`python3`。1〜3節と補助は G4-29 の runner の写し） |
| `supabase/tests/postona_threads_connect_fingerprint_behavior.sql` | P1〜P9 と F2（psql の変数 `a_mode` = on／off） |
| この文書 | |

## 2. 指紋の定義と、source から確かめた前提
- **対象**: アカウントの `public.social_account_oauth_states` のうち、**消費済み**（`consumed_at is not null`）の行の `id`。
- **生成の規則**: id を並べた文字列の sha256（16進64桁）。数ではなく集合にするのは、「1つ消えて1つ増える」を見逃さないため（P8b）。
- **前提**（PR #124 の候補の source）:
  - `complete` は、入口からでも単独でも、state を `UPDATE … SET consumed_at = now() WHERE consumed_at IS NULL` で**ちょうど1つ**消費する（295行）。そのあとでアカウントの行を取る（305行）。
  - 失敗した `complete` は全体が戻るので、何も消費しない（P4 で実測）。
  - 新しい begin は未消費の行を足すだけなので、数えない（P5）。
  - リポジトリの中で、消費済みを未消費に戻す製品のコードは無い（試験の `SYNTHETIC` の書き換えだけ）。
  - state を消すのは、切断・後片付け・アカウントの削除。そのときはアカウントの状態も変わり、rotate は別の理由でも拒否する。
- **読む位置とスナップショット**:
  - claim も rotate も、アカウントの行を FOR UPDATE で持った後に読む（C の binding と同じ位置）。
  - どちらも VOLATILE の plpgsql で、READ COMMITTED では文ごとに新しいスナップショットになる。そのため、待った後は commit 済みの消費を見る（X1・X3 で実測）。
- **アクセス制御**:
  - 新しい列 `connect_fingerprint`（`not null`、16進64桁の CHECK）は、リースの表の所有者だけの ACL の下にある（P9）。
  - 読むのは消費済みの行の id だけで、秘密は読まない。claim／rotate は INVOKER のまま、所有者だけ。
- **履歴の増加と性能**:
  - 1回の接続で1行が増える。claim と rotate のたびに、そのアカウントの消費済みの行をすべて hash する。
  - 管理環境のこの表（migration の外の共有の表）に `social_account_id` の索引があるかは**未確認**。古い消費済みの行を片付けると指紋が変わり、そのときの延長が1回拒否される（P8、安全側）。

## 3. 結果（`TQ_* bash supabase/tests/postona_threads_connect_fingerprint_run.sh`、PostgreSQL 17.11、ローカルの socket、外部への通信は0）
最終の判定: `POSTONA_THREADS_CONNECT_FINGERPRINT_RUN_PASS`（clean な HEAD での実行は REPORT に記す）

| 節 | 確かめたこと | 結果 |
|---|---|---|
| 4 | C が無い → `PRECONDITION_C`。rotate の本体がずれている → `PRECONDITION_ROTATION`。所有者でない → `PRECONDITION_OWNER`。二度目 → `ALREADY_APPLIED` | PASS |
| 5 | P1: ふつうの claim → rotate。リースに指紋が入る。一度だけ使える | PASS（A on／off） |
| 5 | **P2: F1（同じ `now()`、`complete` 単独、custody も binding も書かない）→ `CONNECTION_CHANGED`**。Vault は単独の `complete` の token のまま。`credential_row` は古い系統を**渡さない** | **PASS（A on／off とも。G4-29 の F1 を閉じた）** |
| 5 | P3: F1 を別々のトランザクションで → `CONNECTION_CHANGED` | PASS |
| 5 | P4: attestation が拒否された `complete` は何も消費しない（指紋はそのまま）。P5: 未消費の state が増えても → `rotated` | PASS |
| 5 | P6: 入口の再接続 → A（on）か C（off）で拒否。指紋も変わっている | PASS |
| 5 | P7: 所有者が2人になる → rotation の所有者の柵で拒否、何も書かれない | PASS |
| 5 | P8: 消費済みの state が片付けで消える → `CONNECTION_CHANGED`（安全側）。P8b: 1つ消えて1つ増える（数は同じ）→ `CONNECTION_CHANGED` | PASS |
| 5 | P9: 新しい列も rotate も、API の役割から届かない | PASS |
| 5 | G4-29 の B1〜B8（F1 の部分を除く）、PR #453 の R1〜R7b、G4-27 の N1〜N5 を A＋C＋④ で | PASS |
| 6 | **④ だけ**（A off、C の binding の比較を外した写し）: 入口の再接続 → `CONNECTION_CHANGED`。同じマイクロ秒に始まった別々のトランザクション（collision）→ `CONNECTION_CHANGED`、再接続の token が残る | PASS（④ は単独でも G4-25 の競合を閉じる） |
| 7 | F1 の競合（A off）:<br>X1: 単独の `complete` が先 → 待った rotate は `CONNECTION_CHANGED`、`complete` の token が残る<br>X2: rotate（＋H5 の Vault の書き込み）が先 → 待った `complete` が最後に書き、その token が残る（このとき `credential_row` は0行。`verified_at` が rotate の記録より後なので、要再接続になる）<br>X3: claim が先 → 待った `complete` の後、その claim は `CONNECTION_CHANGED`<br>デッドロック無し | PASS |
| 8 | rollback:<br>④ を戻す → 本体が C の md5 に戻り、F1 が再び通る（④ が効いていたことの確認）。続けて C → A を戻す → R7 が再び再現<br>**A を先に戻す** → C＋④ だけで P1〜P9 が通る<br>**C を先に戻す（誤った順）** → claim は NOT NULL の指紋で失敗し、リース無し（安全側）。④ の rollback は `ROLLBACK_ORDER` で拒否する。手での復旧は列を消すこと<br>rotate を戻し忘れる rollback → `ROLLBACK_INCOMPLETE` | PASS |
| 9 | ④ の欠陥 5種（事後の確認を外した写しでも振る舞いで検出）:<br>rotate が比べない → P2<br>未消費も数える → P4/P5<br>集合でなく数にする → P1<br>claim が別の値を書く → P1<br>他のアカウントの state を数える → P1 | **5/5** |

- **欠陥 `count_not_set`（集合でなく数）について**: 検出したのは P1（リースの値と、試験の補助の hash との一致）だった。P8b（数が同じで集合が違う）は、数にしたら見逃す場面を示す試験だが、この欠陥を最初に捕まえたのは P8b ではない。
- **NOT_RUN**:
  - 単独の `complete` と、同じマイクロ秒に始まった別々のトランザクションの組み合わせ。collision の道具は入口の再接続だけを扱う。④ は時刻を使わないので、P2（同じ `now()`、1トランザクション）と X1〜X3（別々のトランザクションの順）で代えた。
  - F4 の rotation の試験の全体（世界に 001 が無い）。

## 4. 検出できる攻撃の条件と、できない条件
| 条件 | ④ |
|---|---|
| claim と rotate の間に、そのアカウントの state が消費された（入口の再接続、`complete` 単独、古い state の後からの完了） | 検出（`CONNECTION_CHANGED`） |
| 同じ `now()`、時計の後退 | 時刻を使わないので影響なし |
| 消費済みの state の削除（片付け） | 検出（安全側の拒否） |
| 失敗した接続の試み、新しい begin | 検出しない（正しい。token は変わらない） |
| **Vault のその場の直接の更新（F2）** | **検出しない**（state を消費しない）。EXPECTED_FAIL のまま |
| 所有者による claim／rotate の本体の置き換え | 検出しない（md5 の監査で扱う） |
| H5 が拒否の後に token を新しい claim に持ち越す | 検出しない（H5 の条件） |
| 消費済みを未消費に戻す書き込み（製品のコードには無い） | 集合が変わるので検出（戻すと id が減る） |

## 5. 残る境界（未解決のまま）
- **F2**: (a) 書き手を絞る、(c) 監査、(b) 版を確かめる、のどれも未実装（G4-30 §4）。④ は解決しない。
- **H5**（#332、idle。割り当てない）: 直接の `complete` と、JSON と GUC を混ぜた claims は未解決。G4-19 の COORDINATION（6329598815）は未回答。④ があれば、H5 が `complete` を直接呼んでも、古い系統は延長で書かれない。ただし 002 を入れると、H5 の今の形では接続そのものが壊れる（G4-30 §2）。
- **X の `complete` の `platform` の条件**: 読み取りだけのメモ（G4-30 §4）。実コードも OAuth も変えていない。Issue #131 は延期のまま。
- **性能**: 管理環境の state の表の索引は未確認。
- **層の重なり**: 拒否の code は、先に当たる層で決まる（リース → binding → 指紋 → 比較交換）。監査では、`LEASE_NOT_HELD`／`BINDING_CHANGED`／`CONNECTION_CHANGED` のどれも「接続が変わった」という意味になりうる。

## 6. 独立のレビューの12項目（④ を加えて更新）
| # | 論点 | この QA の証拠 | 残り |
|---|---|---|---|
| 1 | F1 が④で閉じたか | P2・P3・X1・X3（A on／off） | — |
| 2 | 「すべての `complete` が state を1つ消費する」という前提 | workspace 295行（source）、P4 | 管理環境の `complete` の本体が同じか |
| 3 | 指紋を読む位置とスナップショット | X1〜X3、デッドロック無し | 負荷の下 |
| 4 | 集合の hash（数でない）の必要 | P8b、欠陥 `count_not_set`（P1 で検出） | — |
| 5 | 未消費・失敗を数えないこと | P4・P5、欠陥 `counts_unconsumed_states` | — |
| 6 | ④ が単独でも効くこと | 6節 | — |
| 7 | rollback の順と、誤った順での安全側の失敗 | 8節 | 手での復旧の手順の文書化 |
| 8 | ACL と事後の確認 | P9、4節、欠陥 | 管理環境 |
| 9 | F2 | EXPECTED_FAIL | (a)・(b)・(c) |
| 10 | 性能と索引 | なし | 管理環境の索引 |
| 11 | H5 の transport | 対象外 | H5 の移行 |
| 12 | 拒否の code の監査上の意味 | §5 | 運用の決定 |

## 7. NOT_RUN／NOT_VERIFIED
- 単独の `complete` と、同じマイクロ秒に始まった別々のトランザクションの組み合わせ（上記）
- F4 の rotation の試験の全体
- F2 の対策、H5 の実コード、X の関数の変更
- 管理環境の state の表の索引、`complete` の本体、Vault
- Meta の規則、時計の step、本物の Supabase・Auth・Vault・Meta、本番
