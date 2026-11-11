# G3｜予約・取消・受領票の既存負例と、個人の作業場所・本人の session・owner epoch の契約との差分（2026-10-25、Issue #318 TASK 28/50）

- task_id: `postona-g3-existing-reservation-cancel-receipt-negative-contract-delta-offline-20261025`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **差分の資料と、最小の隔離 QA だけ。方針は決めていない。**
  - 未決定の分岐（保持の期間、停止の後の取消・受領票、BAN・locked・ログアウト、古い・複数 owner の作業場所）は **PENDING_POLICY** として記録し、期待値を固定していない。
  - 製品 SQL・migration・RPC・Auth・Edge・worker・アプリ、他の slot の PR・ファイルは変えていない。本番は NO_GO。
- 照合した版:
  - G4 PR #484 `69409c7900ad7c9a4cff7924dd1ea221e2c4c733`（G4-35 S1-F1）
  - G5 PR #485 `ca43fc39abbffc3a2f932e9d9c32261340c34250`（G5-26 claim・session・workspace）
  - G3 PR #475 `fa84d2ff…`・#370 `547d9f92…`・#392 `f34aab97…`・#466 `81ea17b1…`・#471 `a208ecce…`・#360 `266e6119…`
  - main `0c42933c`
- 方針の前提（#318 の COORDINATION 2026-10-23）:
  - ユーザーは案 A を確定した（既存の ID・brands・brand_memberships・entitlement・epoch を保ち、個人の作業場所を優先する）。
  - 物理削除と「全部の表を user_id に直結する案 B」は未承認。
  - 個人化を理由に、session の失効・古い token・epoch・二重の送信・課金の保護を弱めない。
- 根拠の印:
  - **VERIFIED**: G3 のソースで確かめた、または隔離の試験で実測した
  - **PROPOSED**: G4・G5 の提案だけで、合意も実装も無い
  - **UNKNOWN**: 確かめられない（本番・managed・本物の G4 の述語など）
  - **PENDING_POLICY**: ユーザー・総合指令の判断待ち（#299）

## 1. 既存の G3 の負例（作り直していない）
| 出典 | 中身 | 状態 |
|---|---|---|
| G3-25（PR #466） | X の予約の利用者の入口 × 失効・期限切れ・他人・不明・`session_id` 無し・匿名 → **ずれ 43 個** | 未修正。G5 の `session_verdict()` を利用者で呼ぶ修正（P7 と同じ道）を待つ |
| G3-26（PR #471） | ログインの直接の削除の後 → 送信の境界 B1〜B4 は成り立つ。行・本文・監査の残りと readback → **ずれ 8 個** | 未修正。保持の方針（PR #475 の Q1〜Q3）を待つ |
| PR #392 | Threads の取消・受領票の P7（D1〜D5） | 未修正 |
| PR #360 | Threads 007 は予約を作るときの owner epoch・lifecycle version を記録し、worker で照合して A→B→A の再開を拒否する | 隔離の試験で確認済み（G3 TASK 7） |

## 2. 契約との差分（G3 の側）
| # | 項目 | G3 の今（証拠） | 契約・提案（G4 #484・G5 #485） | 分類 |
|---|---|---|---|---|
| 1 | **予約の作業場所の決め方** | X の予定の投稿（作成・worker）は「X のアカウントの `brand_id`。その brand に本人の owner の行があり、種類が `social_mobile_user_v1`」だけを見る（`postona_x_reservations/001:184-209`、worker は `001:543-562`）。**ほかの owner がいても、ほかの brand を持っていても、id が `u_<md5>` でなくても通る**（W1・W2・W3 [実測]）。X の単発投稿は G5 の `brand_owner`（唯一の owner）と brand の状態を見る（`006:105-140`）。Threads の fence も唯一の owner と種類を見る（`007:177-197`） | §4.1 の規則: `u_<md5>`・`social_mobile_user_v1`・本人だけが owner・**ほかの brand を持たない**（G4 #484 §2-2、G5 #485 §6.1 Q1 で owner だけが呼べる述語を提案） | 今の動き: **VERIFIED**。規則: **PROPOSED**。古い・共有の作業場所をどう扱うか: **PENDING_POLICY** |
| 2 | X の予定の投稿と単発投稿の食い違い | 共有の作業場所（owner が 2 人）では、**予定の投稿は worker が claim する**が、**単発投稿は `SERVICE_NOT_ACTIVE` で止まる**（W1 [実測]） | 規則が決まれば、同じ答えにそろえる（G4 #484 §7-5 の「同じ場面に同じ答え」） | 食い違い: **VERIFIED**。どちらにそろえるか: **PENDING_POLICY**（複数 owner は未決定） |
| 3 | **X の begin の作業場所の再利用**（G4 の Q4） | X の begin（live、main `20260922003101`）は G3 のファイルではない。F3（G3 の系統）の T13 の囲いの候補は、T13 を足すだけで規則は live と同じ（G4 #484 §1） | §4.1 の規則に合わせる（G4 の X の v2 の候補は、すでにその規則） | 担当は未決定（**UNKNOWN**）。G3 の案は §4 |
| 4 | **session_id の受け渡し** | X の Edge の DB のアダプターは `sub`・`role` だけを置き、`session_id` を渡さない（`_shared/postona_reservations/postgres_db.ts:72-73`、G3-24）。`session_verdict()`（SV）はどこにもつながっていない | Edge は検証済みのトークンの `sub`・`session_id` を渡す（G5-09 の `edgeClaimsForDb`）。SV は欠けた `is_anonymous` を通す（G5 #485 D1。G5 の別 TASK でそろえる提案） | 今: **VERIFIED**。そろえる: **PROPOSED**（G5 の D1 → SV の install → G3 の配線） |
| 5 | **owner epoch・古い許可の失効** | Threads 007 は作るときの owner epoch を記録し、worker の W1 で照合する（`007:290-322`、PR #360 で A→B→A を拒否）。**X は記録も照合もしない**。worker は「今、owner の行があるか」だけを見るので、**A→B→A で A の古い予約がもう一度 claim される**（W4 [実測]。B が owner の間は claim されない） | 予約は、作ったときの `g5oe:<epoch>:<lifecycle>` に縛る（G5 #485 §1、R1 の allow の token。Threads と同じ形） | X の今: **VERIFIED**（ずれ 1 個として名前で固定）。X を Threads と同じ形にする: **PROPOSED**（G5 の owner epoch の候補 PR #457 の独立のレビューが済んでいない） |
| 6 | 作業場所の種類が変わった後の予約 | 作成と単発投稿は `BRAND_NOT_ELIGIBLE`。worker は claim しない（W5 [実測]）。**ただし止めたのは G4 の述語の test double**（`postona_x_oauth_t13_guard/g4_predicate_test_double.sql:10` が種類を見る）。X の予約自身の `row_publishable` は種類を見ない（`001:543-562`） | 規則の述語（1）で、作業場所の状態を見る | 今の拒否は test double に依る: **UNKNOWN**（本物の G4 の述語は未確認）。予約の側で確かめ直す: **PROPOSED** |
| 7 | 匿名 | X の単発投稿の開始は、G5 の T13 が `is_anonymous` を読まないので、匿名でも通る（G3-25 の S06 [実測]） | T13 に匿名の拒否を足す（G5 PR #483、H4 PASS_SOURCE_FOCUSED、未適用） | **PROPOSED**（PR #483 が入れば、G3-25 の 43 個のうちこの 1 個が閉じる見込み。残りの 42 個は SV の配線が要る） |
| 8 | BAN・locked | X の予約の入口は、G5 の `service_state_refusal`（locked を拒否する）を通る入口だけが locked を止める。BAN（`banned_until`）はどこでも読まない（G5 #485 §1） | 意味を決めてから `ACCOUNT_BANNED` を足す（G5 #485 D4） | **PENDING_POLICY** |

### 守っている性質（変えていない）
- 失敗は閉じる側に倒れる。
- 冪等性: `client_request_id`・`revision`・state を 1 回だけ消費する。
- 結果が不明なものは `uncertain` に固定して、もう一度 claim しない。lease は 1 つだけ。二重の送信をしない。
- 他人の行と存在しない ID は、同じ答えにする。

この TASK の試験でも公開は 0 件（全部の場面）。

## 3. PR #475 の Q1〜Q6 と、未決定の分岐（全部 PENDING_POLICY）
| PR #475 | #299 の未決定・G4 #484 §5・G5 #485 §8 | G3 で影響を受けるもの |
|---|---|---|
| Q1 削除のときの本文・状態 | 本文・監査・受領票・下書きの保持と削除 | G3-26 のずれ 8 個の扱い |
| Q2 X の監査の行 | 同上 | 監査の `user_id` |
| Q3 直接の削除の道 | （G1・G2 の account-delete） | 孤立した行 |
| Q4 停止・削除の後の受領票 | 停止の後の取消・受領票 | SV（locked を見ない）を使うか、R1・T13 を使うか（G5 #485 D5） |
| Q5 死んだ・他人の・匿名の session への答え | ログアウト（端末だけか全体か） | G3-25 の 43 個の期待（401） |
| Q6 Threads の切断で履歴が消える | — | G4 の切断・後片付け |
| （新）複数 owner・古い作業場所 | 共有・複数 owner の作業場所、古い作業場所 | §2 の 1・2（W1〜W3） |

## 4. G4 の質問（#484 §6）への G3 の答え（提案。決定ではない）
- **Q4（X の live の begin を規則に合わせる TASK の担当）**:
  - G3 の案: X の OAuth の begin は G4 の OAuth の領分（G4 の X の v2 はすでに規則どおり）なので、**G4** が持つ。
  - G3 は、F3 の T13 の囲いの候補（G3 の系統）を、G4 の変更と矛盾しない形に保つ。
  - 担当は総合指令が決める。
- **Q5（予約の作成で作業場所を確かめ直すか）**:
  - G3 の案: **確かめ直す**（G5 の述語ができたら、予約の作成・worker・単発投稿の 3 か所で同じ述語を呼ぶ）。
  - 今は X の予定の投稿と単発投稿で答えが違う（§2-2）。述語と方針が決まってからの G3 の TASK にする。
- **Q6（古い作業場所の X のアカウントと予約）**:
  - **PENDING_POLICY**。G3-28 の W3（今は通る）を記録した。
  - 「引き継がない・動かさない」（G5 の提案）を選ぶなら、その人の新しい予約は作成で止まり、すでにある予約は worker で止まる形にする必要がある（G3 の TASK）。
- **source だけの確認の依頼**（`001_postona_x_reservations.sql:L188-L193` が唯一の決め方か）:
  - 確認した。X の予約の作業場所は、**X のアカウントの `brand_id`**（`assert_account_access`、`001:184-209`）で決まる。ほかに決める箇所は無い。
  - worker は同じ brand で `row_publishable`（`001:543-562`）を見直す。単発投稿だけは `single_post_fence`（`006:105-140`）で唯一の owner と brand の状態も見る。

## 5. 後続の TASK の候補（決定の後に限る。どれも未着手）
| 案 | 内容 | 前提 |
|---|---|---|
| G3-a | X の予約の作成・worker・単発投稿を、G5 の作業場所の述語と同じ答えにそろえる。W1〜W3 の期待を固定する | G5 の述語（S2）、複数 owner と古い作業場所の方針 |
| G3-b | X の予約を作るときに `g5oe` を記録し、worker で照合する（Threads 007 と同じ形）。W4 のずれ 1 個を閉じる | G5 の owner epoch の候補（PR #457）の独立のレビュー |
| G3-c | P7 の修正（X の 42 個 ＋ Threads）。T13 の匿名の拒否（PR #483）で 1 個 | G5 の SV の install（D1 を含む） |
| G3-d | 削除の後片付け（G3-26 の 8 個） | PR #475 の Q1〜Q3 |
| G4 | X の begin を規則に合わせる | 担当の決定（Q4） |

どれも PG17 の隔離の試験 → Codex Sol（高）→ ユーザーの承認。それまで本番は NO_GO。

## 6. 隔離の試験（この TASK で足したもの）
- 足したもの: `supabase/tests/g3_x_reservation_workspace_owner_delta_qa/run.sh` と `delta_matrix.sql`。
  - G3-25・G3-26 で扱っていない、作業場所と owner の場面だけ。
  - 世界の作り方は PR #466・#471 と同じ。X の候補 001〜006 は PR #392 の head を `git show` で読んだ（変えていない）。
- 結果: `G3_X_WORKSPACE_OWNER_DELTA_QA_PASS`（使い捨ての PG17.11、2 回）。現行の 19 のセルを固定した。

| 場面 | 結果 | 扱い |
|---|---|---|
| W0 ふつう（自分の `u_<md5>`、唯一の owner） | 作成 ok・worker が claim・単発投稿 ok | **BASELINE**（確かめる） |
| W1 共有の作業場所（予約の後に 2 人目の owner） | 作成 ok・worker が **claim**・単発投稿は `SERVICE_NOT_ACTIVE` | PENDING_POLICY |
| W2 ほかの brand も持っている | 作成 ok・claim・単発投稿 ok | PENDING_POLICY |
| W3 古い作業場所（id が `u_<md5>` でない） | 作成 ok・単発投稿 ok | PENDING_POLICY |
| W4 owner の交代 A→B→A | B が owner の間は claim しない。**A に戻ると claim する** | PROPOSED（ずれ 1 個を名前で固定） |
| W5 作業場所の種類が変わる | 作成・単発投稿は `BRAND_NOT_ELIGIBLE`、worker は claim しない（**G4 の test double が止めた**） | 記録（本物の G4 の述語は UNKNOWN） |

- 再現:

```bash
WD_PGHOST=/private/tmp/<socket> WD_PGPORT=<port> WD_PGSUPER=<local superuser> WD_G5_SOURCE_DIR=<git archive of G5 #371 7140e416> bash supabase/tests/g3_x_reservation_workspace_owner_delta_qa/run.sh
```

## 7. 未解決と別のトラック
- P7（G3-25 の 43 個、Threads）、G3-26 の 8 個、W4 の 1 個は未修正。
- PR #370 の P2（システム列の ACL）と A1・A2・B・C、U8・U9 は別のトラックで未解決。
- UNKNOWN: 本物の G4 の述語、managed の GoTrue・PostgREST の claim、本番の作業場所の分布（古い・共有の作業場所を持つ人の数）。
- 本番は NO_GO。
