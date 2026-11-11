# G3｜X 予約の worker：claim から送信の直前までの古い owner epoch のフェンスの隔離負例（2026-10-25、Issue #318 TASK 29/50）

- task_id: `postona-g3-x-worker-owner-epoch-send-fence-offline-mutation-20261025`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **G3 の新しい非製品テストと docs だけ。方針も G5・G4 のインターフェースも決めていない。**
  - 製品 SQL・migration・RPC・Auth・Edge・worker・アプリ、他の slot の PR・ファイルは変えていない。本番は NO_GO。
  - セキュリティの PASS は主張しない（G3 の後続の製品変更は Codex Sol（高）の独立レビューが前提）。
- 照合した版（どれも変えていない）:
  - X の候補 001〜006・worker: PR #392 `f34aab9714f5d4f11388609262d5f64cdcce5ed9`
  - Threads 007: PR #360 `266e6119f36c3d1a7a451a6254a5b26a569e7e0b`
  - G3-28: PR #493 `3760e98738b0df963575325daf639f8b4a92ecca`（W4）
  - G5 の owner epoch の候補: PR #457 `21a5cad4b71de63265db8517da93c6efc60cdde8`（独立のレビューは済んでいない）
  - G4 PR #484 `69409c79…`、G5 PR #485 `ca43fc39…`、G3 PR #370 `547d9f92…`
  - main `0c42933ca5030ab31a56267529430d0473d9b155`
- 根拠の印:
  - **VERIFIED**: G3 のソースで確かめた、または隔離の試験で実測した
  - **NOT_VERIFIED**: ソースに無いことを確かめた（その仕組みは存在しない）
  - **PROPOSED**: 提案だけで、合意も実装も無い
  - **UNKNOWN**: 確かめられない（本物の G4 の述語、managed、本番の分布）
  - **PENDING_POLICY**: ユーザー・総合指令の判断待ち（#299）

## 1. ソースの照合（read-only）
### 1.1 X は epoch の token を取得・保存・照合していない
| 項目 | 証拠 | 判定 |
|---|---|---|
| 予約の表に epoch・lifecycle の列があるか | `postona_x_reservations/001_postona_x_reservations.sql:77` の `create table postona_x_resv.reservations` に無い。001・004・005・006 を `epoch\|lifecycle_version` で検索して **0 件** | **NOT_VERIFIED**（保存しない） |
| 作成のとき G5 の R1 の allow の token（`g5oe:<epoch>:<lifecycle>`）を取るか | `001:184-209` の `assert_account_access` は X のアカウントの `brand_id`・owner の行・種類と、G5 の `service_state_refusal(user_id)` を見るだけ | **NOT_VERIFIED**（取得しない） |
| claim のときに照合するか | `004_postona_x_resv_dispatch.sql:136-186` の `claim_due` は各行を `row_publishable` で確かめるだけ（`004:173`） | **NOT_VERIFIED** |
| 送信の直前に照合するか | `004:96-127` の `pre_publish_check`: lease の一致 → G5 の BUSY → 行のロック → lease の期限 → `row_publishable`（`004:121`） | **NOT_VERIFIED** |
| `row_publishable` の中身 | `001:543-563`: 本人が作った文、同意の一致、**「今」その brand に本人の owner の行があるか**、X のアカウントがその brand にあるか、G5 の `g5_x_autopost_allowed(user_id)`、G4 の `g4_x_account_verified(user_id, account)` | **VERIFIED**（「今の状態」を見るだけで、作ったときの状態とは比べない） |
| G5 の述語 | `003_postona_x_resv_g5_binding.sql:48-58`: `private.account_lifecycle_service_state_refusal(user_id, 'x_autopost')`。利用者のライフサイクルを見て、brand の owner の移動は見ない（§3 の自己検査 2 で実測） | **VERIFIED** |
| worker の流れ | `_shared/postona_reservations/worker.ts:127` で `prePublishCheck` → `OK` 以外は送らない（`:139`）→ `publish`（`:145`）→ `finish`（`:156`・`:160`・`:164`）。`postgres_delivery_store.ts:75`・`:80` | **VERIFIED** |
| 結果の記録 | `001:628-671` の `finish`: lease が無い・違う → `POSTONA_RESV_LEASE_LOST`（`:641`・`:648`）。期限切れの lease は uncertain に固定して `lease_lost` を返す（`:654-662`） | **VERIFIED** |

### 1.2 Threads 007 は記録して照合する（比較のため）
- 作成: G5 の R1 の allow の token を読み（`007_postona_threads_reservations.sql:229-235`）、`bound_owner_epoch`・`bound_lifecycle_version` に保存する（`:95-97`、`:248-249`）。
- 照合: `g5_bound_state`（`:131-136`）が `private.account_lifecycle_worker_brand_verdict(brand, 'x_autopost', epoch, lifecycle)` を呼び、`active` 以外は止める。claim（`:311`）・送信の直前（`:353`）・停止（`:403`）で使う。
- PR #360 の隔離の試験（G3 TASK 7）で、A→B→A の再開を拒否することを確かめた。**VERIFIED**（ただし G5 の W1 は候補で、独立のレビューの状態は G5 の側による）。

### 1.3 X の再接続で、別の X 利用者が同じ行に入るか
- main の X の OAuth（`supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql:250-251`）は、行の `platform_user_id` と違う X 利用者の完了を `X_IDENTITY_ACCOUNT_MISMATCH` で拒否する。**VERIFIED（main のソース）**。
- そのため E8（同じ行の X の利用者が変わる）は、今の main の道では起きない想定の「行が書き換えられた」場合の負例。G4 の v2・後片付け・ほかの書き手で起きうるかは **UNKNOWN**（G4-36 が connection epoch を扱っている）。

## 2. 隔離の負例（新しいパス）
- `supabase/tests/g3_x_worker_owner_epoch_fence_qa/run.sh`・`fence_matrix.sql`
- 使い捨てのローカル PG17.11、偽の人・セッション・claims。X の候補は PR #392 の head を `git show` で読む（変えない）。世界の作り方は PR #466・#471・#493 と同じ。
- G3-25 の 43 個、G3-26 の 8 個、G3-28 の W4（予定の行が A→B→A で再 claim）は**写していない**。今回は「claim の後から送信の直前まで」と「結果の報告」に限る。

| 場面 | 順序 | 今の答え（実測） | 分類 |
|---|---|---|---|
| E1 | claim → owner が A→B → 送信直前の確認 | `NOT_PUBLISHABLE`、行は `failed/NOT_PUBLISHABLE_AT_SEND` | **INVARIANT**（拒否する） |
| E2 | claim → A→B→A → 送信直前の確認 | **`OK`**（行は `claimed`、送信に進む） | **PROPOSED のずれ** |
| E3 | claim → A が抜ける → A が戻る（B 無し）→ 送信直前の確認 | **`OK`** | **PROPOSED のずれ** |
| E4 | 予定の行 → A が抜ける → A が戻る → worker の claim | 抜けている間は claim しない。**戻ると claim する** | **PROPOSED のずれ**（W4 と違い B は無い） |
| E5 | claim → A→B→A → 確認の前に lease が切れる | 次の回で `uncertain/LEASE_EXPIRED` に固定。その後も claim しない | **INVARIANT** |
| E6 | 確認 `OK`（送信中）→ A→B→A → worker が「結果不明」を報告 | `uncertain` を記録。再 claim しない。同じ報告の繰り返しは `POSTONA_RESV_LEASE_LOST` | **INVARIANT**（結果不明は送り直さない） |
| E7 | 確認 `OK` → owner が A→B → worker が「送る前に失敗」を報告 | `failed/FAILED_BEFORE_SEND` を記録。再 claim しない | **INVARIANT** |
| E8 | 予定の行 → 同じ X のアカウントの行の `platform_user_id` が変わる → claim・確認 | claim する。確認も **`OK`** | **PROPOSED のずれ**（G4 の connection epoch に依存） |
| E9 | claim → 次の回 | 2 回目は claim しない | **INVARIANT**（lease は 1 つ） |

- 結果: 29 のセルを固定。INVARIANT を 5 つ確かめた。PROPOSED のずれ 4 個（E2・E3・E4・E8）を名前で固定した。公開は 0 件。2 回とも `G3_X_WORKER_OWNER_EPOCH_FENCE_QA_PASS`。
- 削除・再作成: owner の行の削除と再作成は E3・E4 で扱った。ログインそのものの削除は G3-26（PR #471）で扱い済みなので写していない。

### 2.1 送信の直前の確認と送信の間の窓（残る）
- `pre_publish_check` が `OK` を返してから `publish` が終わるまで、owner の移動を止める仕組みは無い（`worker.ts:127-145`、確認の後に行のロックは持たない）。E6・E7 は、この窓で owner が変わっても**結果は報告どおりに記録され、claim の状態に戻らない**ことを示す。送信そのものを取り消すことはできない。
- この窓は epoch を足しても消えない（Threads も同じ）。縮める案（送信の直前にもう一度 G5 の W1、provider の冪等キー）は §4 の条件に入れる。**PROPOSED**。

## 3. ゲートの自己検査（テスト専用の変異。製品の候補ではない）
1. `gate_selfcheck_epoch_model.sql`（`EF_PATCH_SQL` で使う）
   - Threads 007 の形をまねた粗い模型: brand の owner の行が変わるたびに epoch を上げる。予約は作ったときの epoch と X の `platform_user_id` を覚える。`row_publishable` は両方が同じであることも求める。
   - 結果: **E2・E3・E4・E8 のずれが全部消え**、`run.sh` は `FAIL the PROPOSED gaps changed` で落ちた（期待どおり）。INVARIANT は保たれた。ずれが閉じたらゲートが気づくことの証明。
   - これは提案の設計ではない（G5 の owner epoch・G4 の connection epoch が決める）。
2. `gate_selfcheck_weakened_owner_check.sql`
   - まず `row_publishable` の owner の確認（`001:554-557`）**だけ**を外した変異を試した → **E1 は拒否のまま（変異が生き残った）**。G4 の述語の **test double**（`postona_x_oauth_t13_guard/g4_predicate_test_double.sql` の `brand_memberships` の join）が同じ確認をしているため。G5 の述語は owner の移動を見ない。
   - そこで両方を外した版をファイルにした（本物の G4 の述語が owner を見ない場合の模型）→ `FAIL INVARIANT E1 a check after A -> B must refuse` で落ちた（期待どおり）。
   - わかったこと: **今の E1 の拒否は 2 か所（X の `row_publishable` と G4 の test double）で守られている。本物の G4 の述語が owner を見るかは UNKNOWN。** `row_publishable` の owner の確認は消してはいけない。

## 4. 依存の分離と、G3 の後続の製品変更の条件
### 4.1 既存の候補での観測（この TASK で確定したこと）
- X の worker は「今の owner の行」だけを見る。古い許可（A→B→A、A→none→A）を見分けられない（E2〜E4）。
- 結果不明・送る前の失敗・lease 切れは、owner の移動があっても閉じる側に倒れ、二重の送信は起きない（E5〜E7・E9）。

### 4.2 将来の依存（ここでは決めない）
| 依存 | 中身 | 状態 |
|---|---|---|
| G5 の owner epoch | R1 の allow の token と W1 の worker の verdict（Threads 007 が使う形）。PR #457 は H3 のレビュー待ち | **PROPOSED**（独立のレビューが済むまで X に配線しない） |
| G5 の session verdict | 利用者の入口の session の確認（G3-25 の 43 個・P7）。worker は session を持たないので、作成のときに縛った値で照合する形になる | **PROPOSED** |
| G4 の credential・connection epoch | E8。X の行の利用者・トークンが替わったら、古い予約を送らない。G4-36（#319）が callback の epoch を扱っている | **PROPOSED**／本物の G4 の述語は **UNKNOWN** |

### 4.3 G3 の後続の製品変更に必要な条件（提案）
1. Codex Sol（高）の独立レビュー（製品 SQL・RPC・worker を変えるとき必ず）。G3 自身の PASS では本番に出さない。
2. 回帰: この `run.sh` で E2・E3・E4・E8 が `NOT_PUBLISHABLE`（または claim しない）に変わり、E1・E5〜E7・E9 の INVARIANT がそのまま通ること。G3-25・G3-26・G3-28・PR #392・PR #360 の既存の試験も通ること。
3. 冪等キー: `finish` は予約の `id` と lease の token で照合し、同じ `published` の報告の繰り返しだけを冪等に受ける（`001:626-644`）。この形を保つ。今の provider の呼び出しには冪等キーを渡していない（`worker.ts:145` は account と本文だけ）。足すなら予約の `id` を使う案（**PROPOSED**）。古い epoch の行は「claim しない」で止め、`uncertain` を「送り直す」に変えない。
4. **UNKNOWN のときは NO_SEND**: epoch・connection の答えが NULL・不明・形が違う・取得できないときは送らない（Threads 007 の `SERVICE_STATE_UNKNOWN`・`EXPECTED_*_REQUIRED` と同じ）。既存の予約（epoch の無い行）の扱いも「送らない」を既定にする（どう移行するかは PENDING_POLICY）。
5. 製品の変更は、G5 の owner epoch の候補のレビューと G4 の connection epoch の合意の後の、別の G3 の TASK に限る。

## 5. PENDING_POLICY（期待値を固定していない）
- 複数 owner・古い作業場所（G3-28 の W1〜W3）。
- 既存の予約（epoch を持たない行）の移行: 全部止める／作り直しを求める／一度だけ確認する。
- owner が戻ってきたとき（A→B→A・A→none→A）に、古い予約を「送らない」で止めるのか「本人の再確認で再開」にするのか。
- 削除の後の予約の保持（PR #475 の Q1〜Q6）、BAN・locked・ログアウトの範囲（#299）。

## 6. 残り・別のトラック
- 未修正: X の owner epoch の照合（E2〜E4、G3-28 の W4）、X の identity の照合（E8）、P7（G3-25 の 43 個）、削除の後の残り（G3-26 の 8 個）。
- 別のトラック: PR #370 の P2、U8・U9。本番は NO_GO。
- UNKNOWN: 本物の G4 の述語、managed の GoTrue・PostgREST、本番の owner の移動の頻度。
