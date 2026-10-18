# POSTONA X M1：X の本人確認と、サーバー専用のトークンの受け渡し口（F4／G4・2026-10-18 JST）

TASK: `postona-f4-m1-x-identity-verified-credential-port-source-20261018`（Issue #131 の最小のソースだけ、Issue #269 の指示 SOURCE_ONLY_GO）。

- 適用しない候補と、使い捨ての PostgreSQL 17 でのテストだけ。
- 本番・管理環境・本物の OAuth／トークン／Vault／X には触れていない。
- PR126（`65f49f98…`）の上に積んだ。v1（今の X の接続）は置き換えていないし、取り消してもいない。

## 0. 結論

- G3 の最初の「X に手入力で1件だけ投稿」を止めていた、G4 側の2つの口をソースで用意した。
  - `postona_x_resv.g4_x_account_verified(user, account)`
  - `XPostingCredentialSource.accessTokenFor(social_account_id)`
- **本人確認の証拠は、サーバーが署名した接続（PR126 の v2）だけ**にした。
  - 利用者が申告した X の ID やトークン（今の v1 の complete）は、証拠にしない。
  - v1 で上書きされたアカウントは、次に v2 で接続し直すまで「確認済みではない」。
- トークンを渡すのは、サーバーの owner の通り道からだけ。アプリや公開の API には出さない。
- 渡す直前に、1つの SQL 文（1つのスナップショット）でもう一度確かめる。確かめる内容は次のとおり。
  - 持ち主・作業場所・X の ID・POSTONA の利用権
  - 延長の状態・期限
- どれかが違えば `null`（送らない）。

## 1. 置き場所（すべて G4 のもの）

| 層 | ファイル | 中身 |
|---|---|---|
| PR126 の候補（変更） | `supabase/candidates/postona_x_oauth_hardening_candidate.sql` | 表 `x_account_identity_attestations` を足した。`complete_v2` が、同じ取引でこの「確認の記録」を書く（人・作業場所・X の ID・2つの Vault の参照・その取引の `verified_at`） |
| G4 の候補 001 | `supabase/candidates/postona_x_identity_credential/001_x_identity_credential_candidate.sql` | 4つの関数を足す（§2） |
| G4 の候補 002 | `.../002_g3_predicate_binding.sql`（＋ rollback） | F3 の `postona_x_resv.g4_x_account_verified` の中身（出荷時は `select false`）を、G4 の判定に差し替える。F3 の DENY のときだけ適用できる。**F3 の確認の後に適用する** |
| G4 の候補 003（J2 V2 の後に追加） | `.../003_x_posting_credential_for.sql` | F3 PR278 の `credentialFor` に応える `x_posting_credential_for(account)`。**F3 の 006 と F3 の確認の後に適用** |
| サーバーのアダプター | `supabase/functions/_shared/social/x_posting_credential_source.ts`（＋ test） | F3 の `XPostingCredentialSource`（`accessTokenFor`）と、PR278 の `credentialFor → {token, generation}` を持つ。スイッチ `X_POSTING_CREDENTIAL_SOURCE_ENABLED = false` |
| F5 の代役（テスト専用） | `supabase/tests/postona_x_owner_epoch_f5_stand_in.sql` | §7 で F5 に依頼する「所有者の世代（owner epoch）」の口の代役。**候補ではない** |
| 検証 | `supabase/tests/postona_x_identity_credential_run.sh`・`_fixture.sql`・`_behavior.sql`・`_e2e_test.ts` | 使い捨ての DB だけ |

## 2. 口（関数）と、F3／F5 への約束

| 口 | 入力 → 出力 | 何を確かめるか |
|---|---|---|
| `public.x_account_attested_owner(account)` | → 確認済みの人の uuid か null | 確認の記録と今の行が一致すること（人・作業場所・X の ID・2つの参照・`verified_at`）。次の条件もすべて満たすこと。<br>・**Vault にある2つのトークンの SHA-256 が、Edge が署名した（または延長の後に G4 が記録し直した）指紋と同じ**（J2 V2 R1）<br>・**F5 の所有者の世代（owner epoch）が、確認したときと同じ**（J2 V2 R2）<br>・作業場所の所有者がその人1人（F5 の規則）<br>・`identity_verified` で、接続のエラーが無い<br>・2つの参照がこの行だけのもの<br>・削除中の作業場所ではない |
| `public.x_account_g4_verified(user, account)` | → boolean | 上の人が `user` そのもので、その人の POSTONA（`x_autopost`）が active（F5 の読むだけの判断）。PR257 の K1〜K6 |
| `public.x_posting_credential_for(account)`（003） | → (token, generation) の行か、行なし | **サーバー専用**。下の受け渡しと同じ判断・トークンと、**F3 の `postona_x_resv.x_credential_generation`（SHA-256、64桁）**を、**1つの文・1つのスナップショット**で返す。G4 が独自の世代を作ることはしない（前の版の32桁の世代は廃止） |
| `public.x_account_attest_refreshed_credential(account, access_sha256, refresh_sha256)` | → boolean | **サーバー専用**。延長を書く側（延長の仕組みの持ち主）が、延長を commit した取引の中で、X から受け取ったトークンの指紋を渡して呼ぶ。Vault の中身がその指紋と同じで、延長の状態が idle、generation が新しく、ほかはすべて確認したときのままのときだけ記録し直す。**呼ばなければ、延長したトークンは渡さない** |
| `public.x_posting_access_token_for(account)` | → トークンか null | **サーバー専用**（実行できるのは owner だけ）。上のすべてに加え、延長の状態が idle で、記録した期限まで2分より先。判断とトークンの読み出しは、STABLE の `x_posting_credential_row` の中で**同じスナップショット**で行う |

- 期限の決め方は次のとおり。
  - 確認の記録の後に延長があれば、延長の仕組みの `access_expires_at` を使う。
  - それが無ければ、確認の時刻から2時間とする。
  - **仮定**: X の文書の「アクセストークンは2時間有効」。本物の X では確かめていない。控えめに倒しているので、過ぎたら null になり、送らない。
- 延長そのもの（refresh）はしていない。延長の仕組み（`20260925140000`）は変えていない。
- どの関数も SECURITY DEFINER・`search_path=''`。anon・authenticated・service_role・authenticator には実行の権限がない。
- **worker の役割（`postona_resv_worker`）に `x_posting_access_token_for` の実行を許すかどうかは、F3／G3 との別の手順**（ここでは許していない）。

## 3. F3／G3 への申し送り

1. **K1 の前提を変えてほしい**。PR257 の K1 は、今の v1 の接続で作った人を「確認済み」としている。G4 の判定はこれを**わざと拒否**する（Issue #131 の問題そのもの: v1 は X の ID を申告どおりに受け取る）。
   - G4 の実行スクリプトでは、F3 の補助を v2（署名付き）の接続に置き換えると、K1〜K6 がすべて合格する。
   - 提案: K1 の接続を v2 にする（F3 の補助のファイルの変更は F3 の判断）。
2. F3 の判定の元の注記（001）には「投稿の許可が ON」とあるが、G4 の判定は投稿の許可を見ない。PR262 が、許可を ON にする前に G4 の判定を呼ぶため。投稿の許可は F3 の B6。
3. **PR278 の単発投稿には `credentialFor`（003）を使ってほしい**。返る世代は F3 自身の `x_credential_generation` そのもの（PR278 の G1〜G5 を G4 の実行スクリプトで確認）。`accessTokenFor` は PR224 の worker 向けに残している。どちらも、確かめていないアカウントには null を返す。
4. 適用の順は次のとおり。
   - F3 の 001 → 002 → 003 → 004 → PR257 の T13 ガード → PR262
   - G4: PR124 → PR126（v2 ＋ 確認の記録）→ G4 の 001 → **F3 の確認の後に** G4 の 002
   - F3 の Edge（PR272 の単発投稿）・worker（PR224）にアダプターをつなぐのは、F3 の作業
5. v2 を本当に使うには、PR126 の文書の手順が要る（authenticated への付与、署名する Edge の配備、v1 の取り消し）。それまでは v1 しか接続の手段がなく、**G4 の判定はどのアカウントも確認済みにしない**（安全側）。

## 4. F5／G5 への申し送り

- 使っているのは、F5 の既存の口だけ: `private.account_lifecycle_brand_owner(brand)` と `private.account_lifecycle_service_state_readonly(user, 'x_autopost')`（読むだけ、ロックなし）。F5 のファイルは変えていない。
- v2 の begin／consume／complete は、F5 の T13 ガード（`account_lifecycle_assert_active_service_write`）を最初に呼ぶ（PR126 のまま）。
- F5 PR275 の「資格情報の世代」は、F3 の `x_credential_generation` に一本化した（G4 の32桁の世代は廃止）。
- **所有者の世代（owner epoch）の口を F5 に依頼している（§7）**。

## 5. 依存の順（どれも Draft・未適用）

PR124（T9）・PR178（F5）→ PR126（G4 v2 ＋ 確認の記録）→ G4 001。

F3 側: PR224 → PR257 → PR262（→ PR272 の単発投稿）、PR182（送信直前の利用権）。

G4 の 002 は、F3 の 001〜004 の後。PR126 は Issue #131 の残り（v1 の取り消しなど）とは別に、段階的なユーザーの承認が要る。

## 6. 確かめたこと（ローカル PG17・本物の G5/F5・F3 の本物の候補）

`supabase/tests/postona_x_identity_credential_run.sh`（数は Report）。

**PR126 自身のテストを、確認の記録を足した版で回した結果**: G5 の本物のガードを使うモードで、変更の前と同じ PASS の数。

**偽物（MOCKED）にしたもの**
- Edge のコード交換の署名（テスト用の鍵）
- X（F3 の送信アダプターに渡す、数えるだけの偽物）

**確かめていないもの（NOT_RUN）**
- 管理環境の Auth／PostgREST／Vault
- 本物の OAuth・トークン・X
- 本番

## 7. J2 V2 の P2×2 の修正（2026-10-18、`postona-f4-pr276-j2-p2x2-provenance-owner-epoch-atomic-credential-fix-20261018`）

### R1（同じ取引の v2 → v1）: 時刻ではなく、中身の指紋で閉じた
- PR276 は `verified_at` と Vault の参照に結び付けていた。どちらも、同じ取引の中では v2 と v1 で同じになる（`now()` が同じ、参照はその場の更新）。
- 確認の記録に、**Edge が署名した2つのトークンの SHA-256** を持たせた。HMAC は元からこの2つの指紋を含んでいる。
- 受け渡しのたびに、Vault の中身の指紋と照合する。
- 違う中身が書かれたら、同じ取引でも、どの書き手でも（v1・その場の更新など）、確認済みではなくなる。
- 同じ中身を書き直しただけなら、それは署名された資格情報そのものなので使える（テストで確認）。
- 前の版の書き手（v1）は変えていない。v1 で接続した人は、v2 で接続し直すまで使えない（安全側）。
- 延長（refresh）でトークンが変わる場合は、延長を書く側が `x_account_attest_refreshed_credential` で指紋を記録し直す。呼ばれるまでは渡さない。
  - **延長の仕組みの持ち主（F3／G3 か共通の OAuth の持ち主）との接続は、まだしていない**。

### R2（所有者 A→B→A）: F5 の「所有者の世代」に結び付けた。**F5 の同意が要る**
- 確認の記録に、F5 の `private.account_lifecycle_brand_owner_epoch(brand)` の値を持たせた。今の世代と違えば、確認済みではない。
- 世代は、所有者の membership の行への書き込み（追加・変更・削除）のたびに必ず増える。そのため A→B→A でも元に戻らない。
- 戻った後は、新しい署名付きの接続（v2）でだけ使えるようになる。世代も変わる。
- **G4 は membership の表に何も足していない**（F5 の表なので）。テストでは F5 の代役（`postona_x_owner_epoch_f5_stand_in.sql`、TEST-ONLY）を使った。
- 本物が無いと、PR126 の候補も G4 の 001 も**適用を拒否する**（安全側）。

**F5 への依頼（正確な口）**
- `private.account_lifecycle_brand_owner_epoch(p_brand_id text) returns bigint`。STABLE・SECURITY DEFINER・`search_path=''`・owner だけ。
- 値は作業場所ごとに単調に増え、`public.brand_memberships` の role='owner' の行（変更の前後のどちらか）に触れる、すべての insert／update／delete で増える。
- まだ変化が無ければ 0。
- 実装（表と trigger）は F5 の持ち物にしてほしい。代役は案の1つ。

### G3（PR278）との口
- `credentialFor(account) → { token, generation } | null`。`public.x_posting_credential_for` は、G4 の判断とトークンと F3 の世代を、**1つのスナップショット**で返す。
- 世代は F3 の `x_credential_generation`（64桁）そのもので、G4 は別の計算をしない。
- F3 の `generationSourceViolations`（G1〜G5）と `credentialSourceViolations`（C1〜C5）を、本物の DB で確認した。
- worker や API の役割への実行の許可は、F3 と G4 の別の手順（今回は付与していない）。

## 8. F5 PR285（本物の owner epoch）との結合（2026-10-19、`postona-f4-pr282-pr285-owner-epoch-offline-integration-20261019`）

- **口は一致**: 名前・引数・戻り値・性質が、G4 の依頼どおり。
  - `private.account_lifecycle_brand_owner_epoch(text) → bigint`、STABLE・SECURITY DEFINER・`search_path=''`・owner だけ。
- **違い（1）不明のとき**: PR285 は **NULL** を返す。
  - 該当する場合: 記録が無い、所有者が0人か2人以上、trigger が無い・無効、session が trigger を守らない、記録と実際の所有者が違う。
  - PR282 のテスト用の代役は「変化なし＝0」だった。
- **G4 の扱い**:
  - G4 の比較は `=` と `IS DISTINCT FROM` だけなので、NULL では確認済みにならない。
  - 接続（`complete_v2`）は、epoch が NULL か 1 未満なら、**何も書く前に**固定のコード `X_OWNER_EPOCH_UNKNOWN` で拒否する。PR282 では not-null の生のエラーだった。
  - 確認の記録は `owner_epoch >= 1` を求める。
  - TS の契約の拒否のコードの一覧にも足した。
- **違い（2）本物の判定**: 前提で、PR285 の `private.account_lifecycle_brand_owner_epoch_covered()`（owner だけ）があることを求める（代役では適用できない）。
- **違い（3）PR285 の適用の前提**: anon／authenticated が membership を書けないこと。
  - テストの世界では、F5 の実行スクリプトと同じく `20260918120000_social_mobile_brand_memberships.sql` を先に入れた。
- TEST-ONLY の代役は削除した。テストは PR285 `3a5eef3d` の候補を読むだけで重ね置きして使う。
- **F5 の限界（PR285 の文書、F5 の範囲）**: trigger を無効にした間に A→B→A を完全に戻してから有効に戻すと、getter は前の epoch を返す。
  - G4 からは見抜けない（epoch を信じる前提）。
  - trigger の無効化は管理の操作で、F5 の resync の手順の対象。
- **延長の記録し直し（`x_account_attest_refreshed_credential`）の呼び出し元**:
  - PR278・PR285・main のどこにも無い（未接続）。
  - 呼ぶべきなのは、延長を commit する書き手。今の延長の仕組み（`commit_x_account_refresh_legacy_post`）は service_role の口で、legacy の投稿用。
  - この関数は owner だけが実行できるので、service_role から呼ぶには、次のどちらかが要る。いずれも**延長の仕組みの持ち主の変更と別の承認**の範囲で、G4 からは何もしていない。
    - 延長の仕組みの関数の中から、同じ取引で呼ぶ
    - 新しい付与
