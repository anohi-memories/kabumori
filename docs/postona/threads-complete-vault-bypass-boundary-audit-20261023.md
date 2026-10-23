# G4-30：Threads の `complete` 単独（F1）と Vault の直接の更新（F2）の境界の source-only 監査（2026-10-23 JST）

- task_id: `postona-g4-threads-complete-vault-bypass-boundary-audit-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **DESIGN_ONLY（source を読んだだけ。SQL・DB の試験は NOT_RUN）／F1・F2 は未解消／独立のレビューが要る／PRODUCTION_NO_GO**
  - 候補 A＋C（PR #460・#467）は、F1・F2 を解消しない。製品の修正の PASS とは扱わない。
  - 変更はこの文書だけ。SQL・候補・migration・ACL・RPC・Auth・Edge・Vault・H5 のコード・他の枠の path・既存の PR の head は変えていない。
- 土台: PR #467（`9305f32049024b66598fb312a9e29db517ad864f`）
- 行番号はこの branch のもの:
  - PR #124 の候補: `supabase/candidates/postona_threads_oauth_workspace_candidate.sql`（以下「workspace」）
  - 001・002: `supabase/candidates/postona_threads_binding_epoch/`
  - H5 の transport: `supabase/candidates/postona_threads_auth_runtime/owner_transport.ts`
  - X の migration: `supabase/migrations/`

## 1. 実測の証拠と、source から言えること・未確認の前提
| 種類 | 内容 | 根拠 |
|---|---|---|
| 実測（G4-29） | **F1**: PR #124 の `complete` を単独で（custody も binding も書かずに）、請求した版と同じ `now()` で commit する → 古い延長が `rotated`、`credential_row` が古い系統を渡す（A on／off とも） | PR #467 の F1 |
| 実測（G4-29） | **F2**: Vault の secret をその場で書き換える → その後の rotate は `rotated` | PR #467 の F2 |
| source | `complete` は SECURITY DEFINER。所有者以外に EXECUTE は無い（workspace 249〜252行・349行）。中で次をする: T13（`account_lifecycle_assert_active_service_write`）→ **Vault の鍵による attestation の HMAC の照合** → 作業場所のロック → state の消費（295行）→ アカウントの行 FOR UPDATE（305行）→ Vault の作成または**その場の更新**（314・329行）→ `verified_at = now()`・`publish_enabled = false`（336行） | workspace |
| source | **H5 の transport は、その所有者の役割そのものとして動く**（43〜49行: `current_user` が consume の所有者、superuser でない、API の役割のメンバーでない）。claims は JSON と1つずつの GUC の**両方**を置く（53〜67行）。connect の完了では、`complete` を**直接**呼び（171行）、続けて custody を書く（180行）。どちらかが失敗すると rollback する（70〜76行） | owner_transport.ts |
| source | 001 の入口 `complete_and_attest_binding` も SECURITY DEFINER（216行）。呼ぶたびに `complete` が所有者だけのもので、md5 が `8c90c72f…` であることを確かめる（231〜240行）。注記は「入口の外で完了は起きない」とするが、**所有者自身が `complete` を直接呼ぶことは止めない** | 001 |
| source | 002 の custody の書き込みは、入口が置いた `connect_proof` を求め、無ければ `THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION`（002 の 96〜97行） | 002 |
| source | `credential_row`（PR #412）は `publish_enabled` を見ない（該当0件） | PR #412 `b83a7a92…` |
| 未確認 | G3 の投稿の経路が `publish_enabled` を見るか（PR #386 の U8 の門と推測）。管理環境で `vault.update_secret` を呼べる役割、`vault.secrets.updated_at` の更新の仕方。Meta の規則。H5 の延長の worker（まだ無い） | — |

## 2. F1 の実行の境界（誰が、どの条件で踏めるか）
- **呼べる人**: `complete` の所有者の役割だけ。API の役割（anon・authenticated・service_role）には付与が無い。PR #124 の authenticated の EXECUTE は有効にしない（G4-19 の方針どおり）。
- **必要なもの**:
  1. 有効な T13 の書き込み（サービスが active）
  2. その接続の state（未消費・期限内・本人が始めたもの）
  3. **Vault の attestation の鍵で作った HMAC**（code の交換をしたサーバーだけが作れる）
  - つまり、F1 は外部の攻撃者ではなく、**本人の正しい再接続を、所有者の権限のコードが入口を通さずに完了させた**ときに起きる。
- **今の H5 の transport の場合**（source から）:
  - **002 を入れた世界**: `complete` の後の custody の書き込みが `NOT_IN_CONNECT_TRANSACTION` で失敗し、トランザクション全体が rollback される。F1 は commit されないが、**接続そのものができなくなる**（G4-24 の C3 と同じ）。
  - **002 を入れない世界**（元の custody の書き込み）: custody が書かれるので、**A の trigger がリースを終わらせる**（G4-27）。A が止まっていると F1 が開く。C は binding が変わらないので捕まえられない。
  - 実測の F1（custody を書かずに commit）は、今の H5 のコードの形ではない。所有者の権限を持つ別のコード、または手での SQL が要る。
- **claims の形**: H5 は JSON と1つずつの GUC を両方置く。G5 の T-1 の入口は、混ぜた claims を `ACCOUNT_LIFECYCLE_AUTH_REQUIRED` で拒否する（G4-24 の C7 で実測）。H5 が入口に移るには、**JSON だけにする変更も要る**。
- **F1 の害の範囲**（推論）:
  - 同じ Threads の利用者の古い系統の token が、新しい世代で渡る（G4-29 で実測）。
  - `complete` は `publish_enabled = false` にする。そのため、本人が投稿を再び有効にするまで、G3 の投稿は止まるはずである（G3 の門は未確認）。
  - ほかの利用者・作業場所には届かない（G4-25 の R7b）。

## 3. F1 を閉じる方法の比較
| 案 | 内容 | 担当 | ACL・所有者 | rollback・一体性 | 状態の code | 閉じる範囲 |
|---|---|---|---|---|---|---|
| **① 入口へ移す** | H5 の transport が `complete` を直接呼ぶのをやめる。connect の完了を「入口 → custody」の1トランザクションにし、claims を JSON だけにする | **H5**（G4-19 の COORDINATION 6329598815、未回答） | 変わらない | H5 のコードを戻すだけ。002 を入れるなら、その前に必須（入れた後では接続が壊れる） | 入口の code（`THREADS_BINDING_*`） | 通常の運用での F1 の経路をなくす。所有者の権限のほかのコードは止めない |
| ② 役割を分ける | transport の役割 T を所有者 O と分ける。T には入口（definer）だけを付与し、`complete` は付与しない | G4＋H5＋運用 | `complete` を T が呼べなくなる。ただし custody の書き込みは INVOKER で、H5 の `custody_port.ts` は「関数の所有者 = `current_user`」を求めるので、**今の契約とぶつかる**（custody を入口の中に入れるか、definer にする必要がある） | 大きい | — | `complete` の単独の呼び出しを、権限として不可能にする |
| ③ `complete` 自身がリースを終わらせる | PR #124 の本体でリースを消す（または `social_accounts` の trigger で消す） | PR #124（G4 の系統）、または共有の表（G3-22 の所有者の決定） | 001 は `complete` の md5 を固定しているので、固定の更新が要る。共有の表の trigger は、所有者の決定の後 | 本体の差し替え | `LEASE_NOT_HELD` | どの経路の `complete` でも閉じる |
| **④ 消費した接続の指紋** | claim のときに、アカウントの**消費済みの OAuth state の id の集合の hash**をリースに記録し、rotate で比べる。`complete` は入口からでも単独でも必ず state を1つ消費する（workspace 295行）ので、時刻と無関係に変化が分かる | **G4**（rotation／C の本体。C と同じ置き換えの形） | 新しい列はリースの表（所有者だけ）。`social_account_oauth_states` を読む（migration の外の共有の表だが、001 もすでに読む） | C と同じ（本体を戻し、列を消す） | 新しい `CONNECTION_CHANGED` | どの経路の `complete` でも、DB で閉じる |

- **④ のロックの順**（source から）:
  - `complete` は、state を消費してから（295行）アカウントの行を取る（305行）。
  - rotate は、アカウントの行を FOR UPDATE で持った後に集合を読むので、commit 済みの消費だけを見る。
  - `complete` が先に commit していれば、指紋が変わり拒否する。`complete` がアカウントの行を待っていれば、rotate が先に終わり、`complete` が後から書く（正しい順。G4-27 の E3 と同じ）。
- **④ の注意**:
  - 古い state を片付けで消すと指紋が変わる（安全側の拒否が増えるだけ）。数ではなく id の集合の hash にするのは、「1つ消えて1つ増える」を見逃さないため。
  - 読むのは消費済みの行だけで、秘密は読まない。
- **推奨**: **① と ④**。① は通常の運用の経路をなくし、④ は DB で残りを閉じる。② は長期の課題、③ は ④ があれば要らない。

## 4. F2（Vault のその場の直接の更新）の境界
- **リポジトリの中で Threads の Vault の secret を書くもの**（source）:
  - PR #124 の `complete`（作成・その場の更新、workspace 314・329行）だけ。
  - H5 の延長の Vault の書き込み（rotate と同じトランザクション）は**設計の上だけ**で、コードはまだ無い。
  - 切断・後片付け・アカウントの削除は secret を**消す**（上書きではない）。その後の rotate は `ACCOUNT_NOT_FOUND`／`CUSTODY_UNKNOWN` になる。
- **X の関数**:
  - X の延長の commit は `platform = 'x'` を確かめる。
  - **X の接続の `complete_social_mobile_x_oauth_connection`**（main の migration `20260919120000`、authenticated に EXECUTE）は、state の `social_account_id` でアカウントを選ぶ。**`platform = 'x'` の条件が無い**（242〜248行）。Threads の state を渡すと、Threads の行の Vault を書き換えようとする。
  - ただし、refresh token の secret も作って行に書く。2a-2（`20261007150000`）の CHECK `social_accounts_provider_credential_profile`（Threads の行は refresh token を持たない）で update が失敗し、関数ごと rollback される、と推論する。
  - **間接の守りで、未実測**。次の隔離 QA で確かめる。X の関数の条件の追加は、X の所有者（G3／G4 の X の系統）の判断。
- **管理環境の Vault**: `vault.update_secret` を呼べる役割、`updated_at` の更新の仕方は**未確認**（試験の世界の Vault は偽物）。

### F2 を閉じる方法の比較
| 案 | 内容 | 担当 | 限界 |
|---|---|---|---|
| (a) 書き手を絞る | 延長の Vault の書き込みを、G4 の関数（例: rotate と保存を1つの文にする）の中に入れる。Threads の Vault の書き手を「入口の中の `complete`」と「その関数」の2つにする | G4（H5 は呼ぶだけになる） | 所有者の権限のほかのコードは止められない。役割を分けないと、権限としては強制できない（②と同じ） |
| (b) 系統を確かめる | claim のときの Vault の行の版（`updated_at` または `xmin`）をリースに記録し、rotate で比べる | G4 | `updated_at` は時刻なので、同じマイクロ秒は見逃す。`xmin` は G4-28 §5 の懸念あり。管理環境で `vault.secrets` を読めるかは未確認 |
| (c) 監査 | 正しい書き込みは、custody の書き込みと同じトランザクション（入口、rotate）で起きる。そのため「Vault の `updated_at` ≦ custody の `recorded_at`」が成り立つはずである。これを定期の問い合わせで確かめる（`credential_row` の拒否条件にもできる） | G4＋運用 | 同じマイクロ秒は見逃す。管理環境の `updated_at` の振る舞いは未確認 |

- **推奨**: (a) で書き手を2つにし、(c) で監査し、(b) はレビューで選ぶ。**A＋C だけでは F2 は解消しない**。

## 5. 修正の順と、担当ごとの責任
1. **H5**（#332、idle。割り当てない）: ① connect の完了を「入口 → custody」へ移し、claims を JSON だけにする。**002 を採用する前提条件**（002 だけを先に入れると、接続が壊れる）。G4-19 の COORDINATION（6329598815）は未回答。重複を避け、今回は投稿しない。
2. **G4**: ④（指紋）と F2 の (a)・(b) を、A＋C の上の隔離候補として作り、試す（次の TASK）。
3. **G4／PR #124**: `complete` は所有者だけのまま。authenticated の EXECUTE は付けない。
4. **運用・レビュー**: ② 役割の分離の要否、管理環境の Vault の権限と `updated_at`（読み取りだけの監査が要る。G5-18 の門を参照）、本体の md5 と trigger の状態の定期の監査。
5. **G3**: 変更は要らない（007 の世代は、リースの `lease_id` と secret だけを hash する）。F1 の害の範囲に関わる「投稿の経路の `publish_enabled` の門」の確認だけ。今回は連絡しない。
6. **G5**: 投稿者だけの認証を簡単にする調査（#320 6353893007、読み取りだけ、承認なし）が、所有者や transport の形を変えうる。A・C・④ は作業場所の形に依らないが、binding の条件（作業場所）は影響を受けうるので、決まったら見直す。
7. **X の系統**: X の `complete` に `platform = 'x'` を足すかの判断（2a-2 の CHECK による間接の守りを確かめた後）。

## 6. 次の隔離 PG17 の試験の計画（このTASKでは NOT_RUN）
- **④**:
  - 同じ `now()` の単独の `complete` → `CONNECTION_CHANGED`（F1 が閉じる）
  - 入口の再接続 → A／C／④ のどれかで拒否
  - 片付けで state が消える → 拒否（安全側）
  - `complete` と rotate の競合（両方の順）、デッドロック無し
  - mutant: 指紋を比べない、消費済みの条件を外す、数だけにする（1つ消えて1つ増える場合を見逃すことを示す）
- **H5 の形の模型**:
  - 002 ありで「`complete` → custody」を1トランザクション → custody が拒否、全体が rollback、何も書かれない
  - 混ぜた claims で入口 → 拒否
- **F2**:
  - (a) の関数で、延長と Vault の書き込みが1つの文になる
  - (b) Vault のその場の更新 → 拒否
  - (c) の監査の問い合わせが、その場の更新を見つける
- **X の `complete` に Threads の state を渡す** → CHECK の違反で失敗し、Vault も行も state も変わらない（間接の守りの実測）
- 正しい順・誤った順の rollback、ACL、所有者でない人

## 7. 独立のレビューの12項目（F1・F2 用に更新）
| # | 論点 | 根拠 | 状態 |
|---|---|---|---|
| 1 | F1 は、所有者の権限と本物の attestation を持つコードでしか起きないか | §2（workspace の HMAC と ACL、transport の役割） | source |
| 2 | H5 の transport の今の形（直接の `complete`・混ぜた claims）と、002 を入れたときに接続が壊れること | §2 | source（G4-24 の C3・C7 は実測） |
| 3 | ① と 002 の採用の順 | §5 | 決定が要る |
| 4 | ④ の指紋がすべての `complete` で変わるか（state の消費は必ず1つ） | workspace 295行 | source |
| 5 | ④ のロックの順 | §3 | 未実測 |
| 6 | ② 役割の分離と、custody の書き込みの契約（INVOKER・所有者）の衝突 | §3、`custody_port.ts` | 設計が要る |
| 7 | ③ を入れない理由（④ で足りるか） | §3 | 判断が要る |
| 8 | F2 の Vault の書き手の一覧が完全か（リポジトリの外、管理環境） | §4 | 未確認 |
| 9 | X の `complete` に `platform` の条件が無いこと。2a-2 の CHECK による間接の守り | §4 | 未実測 |
| 10 | (b)・(c) の `updated_at`／`xmin` の管理環境での振る舞い | §4 | 未確認 |
| 11 | F1 の害の範囲（`publish_enabled = false` と G3 の門） | §2 | G3 の門は未確認 |
| 12 | 投稿者だけの認証の簡素化（G5 の調査）との両立 | §5 | 調査中 |

## 8. NOT_RUN／NOT_VERIFIED
- この TASK の SQL・DB の試験すべて（docs だけ）。§2〜§4 の判定は source からの推論。
- ④、F2 の (a)・(b)・(c)、② の実装と実測
- X の `complete` に Threads の state を渡した場合の実測
- 管理環境の Vault の権限と `updated_at`、G3 の `publish_enabled` の門、H5 の延長の worker
- 本物の Supabase・Auth・Vault・Meta、本番
