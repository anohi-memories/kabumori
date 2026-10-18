# F4 Report：PR282 × PR285 のオフライン結合の検証（2026-10-19 JST）

- task_id: `postona-f4-pr282-pr285-owner-epoch-offline-integration-20261019`（ユーザーの直接の指示。main への push が禁止のため、`.agent_v2` には登録していない。この Report はこのブランチの上だけにある）
- 返却先: POSTONA G4 のちゃ／完了コード L4
- 判定: **SOURCE_ONLY_INTEGRATION_PASS（ローカルの使い捨て PG17 だけ）**。本番に適用できるとは判断していない。
- 対象:

  | PR | 担当 | head |
  |---|---|---|
  | 282 | G4 | `39b9064dc79ad52b430ba820006cd3310bf3140f` |
  | 285 | G5 | `3a5eef3d6b981e0646683ce101a22542fd0a4e2f` |
  | 278 | G3 | `bf76a7c7b54ff8aa1155aace2045235e9408c18a` |

  3つとも作業の前後で変わっていない。

## 開始前の確認
- fresh origin/main（`e8f0f93d…` で開始）を見た。
  - F4 の TASK（`postona-f4-pr276-j2-p2x2-…`）は done／none。
  - J2（PR282 の限定の再レビュー）は ready。
  - F5（共通の owner epoch）は done（L5 PASS_SOURCE_CANDIDATE）。
  - Issue #269 の G5 → G4／G3 の契約の通知を読んだ（NULL は拒否、`=` で比べる、代役と同じとみなさない）。
- **前回の F4 の TASK はまだ archive されていない**。G4 が archive するときの値は次のとおり（main への push が禁止のため、ここでは保存していない）。
  - L4 の受け入れ: `dd1c9719428288ad9fe14a7e65177b99e76ef337`
  - F4.md の blob: `5f986481e9a7b4df58090ecddb43efa0954c0116`（今の main と同じ）
  - 17766 bytes、SHA256 `85051c6c2dc395208149e812aa4320965fd160b7e445068f7c23224f1ad7d6c2`
- 専用 worktree `/Users/yuya/Developer/kabumori-f4-x-epoch` を使った。PR282 の正確な head から新しいブランチ `claude/f4-postona-pr282-pr285-owner-epoch-integration-20261019` で作成。
  - ほかの枠の worktree・未コミットの変更・dev server には触れていない。

## owner epoch の契約の結合

| 確認すること | 結果 |
|---|---|
| 1. 名前・引数・戻り値 | 一致。`private.account_lifecycle_brand_owner_epoch(text) → bigint`、STABLE・definer・`search_path=''`・owner だけ |
| 2. NULL で拒否すること | **PASS**。PR285 は不明のとき NULL を返す。G4 の比較は `=` と `IS DISTINCT FROM` だけで、NULL では確認済みにならない。接続は `X_OWNER_EPOCH_UNKNOWN` で、**何も書く前に**拒否する（前は not-null の生のエラー）。記録は `owner_epoch >= 1` を求める |
| 3. A→B→A | **PASS**。epoch が2つ進み、復活しない（behavior R2・E、e2e） |
| 4. owner→admin→owner | **PASS**（behavior R2） |
| 5. 所有者の追加と削除 | **PASS**。2人のときは NULL で拒否し、削除して1人に戻っても復活しない |
| 6. 同時の更新と rollback | **PASS**。所有者の変更を rollback しても epoch・世代・資格情報は変わらない（E）。受け渡しの最中の所有者の移動も、確かめた状態のトークンか null だけ（競合 R2） |
| 7. epoch と資格情報を同じスナップショットで評価 | **PASS**。PR285 の getter も STABLE なので、G4 の STABLE な `x_posting_credential_row`（と 003）の1つの文の中で評価される |
| 8. 既存の署名済みの資格情報との整合 | PR285 は適用のときに、既存の所有者の作業場所を epoch 1 で揃える。G4 の候補は PR285 の後にしか適用できない（前提）ので、epoch の無い記録はできない |
| 9. 古い epoch での記録し直しの拒否 | **PASS**。A→B→A の後、延長の記録し直しは、指紋が正しくても拒否する（E） |
| 10. F5 の権限設計との整合 | G4 は epoch の口を読むだけ。付与・trigger・membership の変更はしていない。PR285 の適用の前提（API の役割が membership を書けない）は、テストの世界で F5 と同じく `20260918120000` を入れて満たした |

- **代役との違いで直したこと**:
  - TEST-ONLY の代役は削除した（不明のとき 0 を返していた）。
  - PR126 の候補と G4 の 001 は、PR285 の `…_epoch_covered()` が無ければ適用を拒否する（代役では適用できない）。
- **F5 の範囲の限界（PR285 の文書のとおり、G4 では閉じられない）**: trigger を無効にしている間に A→B→A を完全に戻してから有効に戻すと、getter は前の epoch を返す。管理の操作で、F5 の resync の手順の対象。

## G3（PR278）との契約
- `credentialFor(account) → {token, generation} | null`
  - 003 `x_posting_credential_for` が、G4 の判断とトークンと F3 の `x_credential_generation`（64桁）を、1つの文で返す。
- F3 の G1〜G5 と C1〜C5 の確認を、本物の DB で合格した（e2e）。
- 拒否の場面と結果:

  | 場面 | 結果 |
  |---|---|
  | 確かめていない資格情報、所有者の変更、cross-user／cross-brand、epoch が不明 | null で、送信0件 |
  | 延長の後 | 記録し直しの後だけ、新しい世代とトークン |
  | **送信の直前に世代が変わった**（credentialFor の後に延長を記録し直した） | F3 の規則（世代が一致したときだけ送る）で、送信0件 |
- G3 の worker／consumer は変えていない。

## 延長（refresh）の記録し直しとの接続
- 呼び出し元の `x_account_attest_refreshed_credential`: PR278・PR285・main のどこからも呼ばれていない（**未接続**）。
- 呼ぶべきなのは、延長を commit する書き手で、**同じ取引の中で**、X から受け取ったトークンの SHA-256 を渡す。
  - 条件は、Vault の中身がその指紋と同じ、延長の状態が idle、generation が記録より新しい、epoch・所有者・参照・`verified_at` が確認のときのまま。
- 古い延長で復活しないこと: generation が新しくない（PASS）、指紋の違い（PASS）、間に書き込み（PASS）、古い epoch（PASS）のどれでも拒否する。
- 権限: 関数は owner だけ。今の延長の仕組み（`commit_x_account_refresh_legacy_post`）は service_role の口なので、次のどちらかが要る。どちらも**延長の仕組みの持ち主の変更と別の承認**の範囲で、G4 は何もしていない。
  - 延長の仕組みの関数の中から同じ取引で呼ぶ
  - 新しい付与

## 変更したファイル（G4 のものだけ）
- `supabase/candidates/postona_x_oauth_hardening_candidate.sql`: 次の3点を変えた。
  - epoch が NULL か 1 未満なら `X_OWNER_EPOCH_UNKNOWN`
  - `owner_epoch >= 1`
  - 前提で PR285 の coverage を求める
- `supabase/candidates/postona_x_identity_credential/001_x_identity_credential_candidate.sql`: 前提に coverage を追加し、注記を更新した。
- `supabase/functions/_shared/social/x_connect_rpc_contract.ts`: 拒否のコードの一覧に `X_OWNER_EPOCH_UNKNOWN` を追加した。追加の前は、PR126 の TS の契約のテストが**新しいコードを検出して失敗**した。
- `supabase/tests/postona_x_identity_credential_{run.sh,behavior.sql,e2e_test.ts}`: PR285 の本物、E 節、e2e 2件、ミューテーション 2件を足した。
- `supabase/tests/postona_x_oauth_hardening_run.sh`: PR285 の本物（`POSTONA_OWNER_EPOCH_CANDIDATE`）と membership の RLS の migration を入れるようにした。
- 削除: `supabase/tests/postona_x_owner_epoch_f5_stand_in.sql`
- `docs/postona/x-identity-credential-m1-20261018.md`（§8）と、この Report。

## テスト（このコミット `85a43fb338c79db322e9621dc5881407edcc26cf` の上、未コミットの変更0で実行）
- **`postona_x_identity_credential_run.sh` → ALL PASS**
  - 実行した環境: ローカルの PostgreSQL 17.11。G5/F5 の本物（PR178）＋ **PR285 の本物の epoch**、PR124、F3 PR278 の本物の 001〜006・送信アダプター。
  - 前提の拒否 PASS:
    - PR126: epoch が無い、coverage が無い（代役）
    - 001: 記録が無い、F5 が届く、epoch が無い、延長の表の形、superuser
    - 002: G4 が無い、F3 の DENY ではない
    - 003: G4 が無い、F3 の世代が無い
  - behavior PASS: 8節 ＋ R1 ＋ R2 ＋ **E（PR285: NULL・rollback・古い epoch・復旧）** ＋ 延長。
  - 競合（v1 の上書き・所有者の移動）PASS。
  - K の契約: v1 の接続は K1 をわざと拒否、v2 は K1〜K6 PASS。
  - fail-before:
    - PR276 で R1／R2 を再現した: `true …UNSIGNED… | true …FBR2… true`。この版では `false null | false null false`。
    - F3 の代役は申告の ID を確認済みにする。G4 は拒否する。
  - **e2e 9/9**:
    - C1〜C5・G1〜G5
    - 送信1回（2つの口）
    - 拒否の場面で 0件
    - R1・R2 で 0件
    - 直前の変化4種で 0件
    - 延長
    - **epoch が不明で 0件、戻すと使える**
    - **送信直前の世代の不一致で 0件**
  - **ミューテーション 20/20 を検出**（新しく「NULL を一致とみなす」と「記録し直しの epoch の確認を消す」を足した）。
- **PR126 自身のテスト**（G5 の本物のガード ＋ PR285 の本物）: `POSTONA_X_OAUTH_RUN_PASS`、PASS の印 20。
- TS の単体 13/13。`deno lint` エラー0（4ファイル）。`git diff --check` OK。
- 偽物にしたもの（MOCKED）: Edge の署名（テスト用の鍵）、X。
- 確かめていないもの（NOT_RUN）:
  - 管理環境の Supabase Auth／PostgREST／Vault、本物の OAuth・トークン・X
  - 延長の書き手からの呼び出し
  - PR285・PR278 自身の実行スクリプト（コードは変えていない）
  - session_replication_role=replica の場合（superuser の設定。F5 のテストの範囲）
  - 本番

## 残る問題
1. 延長の記録し直しの書き手が未接続（延長の仕組みの持ち主の変更と承認）。
2. PR285 の限界: trigger を無効にした間に完全に A→B→A を戻した場合（F5 の運用・resync）。PR285 の独立レビュー（Codex Sol 高）は、F5 の文書で必須。
3. J2 の PR282 の限定の再レビューは ready のまま（この結合の差分も含めて見てもらう必要がある）。
4. G3 の worker への実行の許可と PR278 への接続は、別の承認。
5. 実環境（Auth／Vault／X、署名する Edge、v1 の取り消し）は、段階的なユーザーの承認が要る。

## 行っていない本番の操作
- main への push（TASK の登録・archive を含む）
- 本番・管理環境の DB、migration の適用、権限の付与
- 本物の OAuth・Vault・X の投稿
- マージ、デプロイ、force push
