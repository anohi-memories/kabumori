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
| サーバーのアダプター | `supabase/functions/_shared/social/x_posting_credential_source.ts`（＋ test） | F3 の `XPostingCredentialSource` と同じ形。`credentialGenerationFor` も持つ。スイッチ `X_POSTING_CREDENTIAL_SOURCE_ENABLED = false` |
| 検証 | `supabase/tests/postona_x_identity_credential_run.sh`・`_fixture.sql`・`_behavior.sql`・`_e2e_test.ts` | 使い捨ての DB だけ |

## 2. 口（関数）と、F3／F5 への約束

| 口 | 入力 → 出力 | 何を確かめるか |
|---|---|---|
| `public.x_account_attested_owner(account)` | → 確認済みの人の uuid か null | 確認の記録と今の行が一致すること（人・作業場所・X の ID・2つの参照・`verified_at`）。次の条件もすべて満たすこと。<br>・作業場所の所有者がその人1人（F5 の規則）<br>・`identity_verified` で、接続のエラーが無い<br>・2つの参照がこの行だけのもので、secret が実在する<br>・削除中の作業場所ではない |
| `public.x_account_g4_verified(user, account)` | → boolean | 上の人が `user` そのもので、その人の POSTONA（`x_autopost`）が active（F5 の読むだけの判断）。PR257 の K1〜K6 |
| `public.x_account_credential_generation(account)` | → 32桁の16進か null | 次のことで変わる: 再接続（新しい確認の記録）、延長（延長の仕組みの generation）、所有者の変更（null になる）。F5（PR275）が F3 に「許可のときと送信の直前で読み比べる」よう求めている値 |
| `public.x_posting_access_token_for(account)` | → トークンか null | **サーバー専用**（実行できるのは owner だけ）。上のすべてに加え、延長の状態が idle で、期限まで2分より先。**1つの SQL 文で**判断と読み出しを行う |

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
3. 送信の直前は、`credentialGenerationFor`（または SQL の `x_account_credential_generation`）を許可のときと読み比べることを勧める（F5 の求め）。ただし、G4 の受け渡し口は、それ自体が直前にすべてを確かめ直す。
4. 適用の順は次のとおり。
   - F3 の 001 → 002 → 003 → 004 → PR257 の T13 ガード → PR262
   - G4: PR124 → PR126（v2 ＋ 確認の記録）→ G4 の 001 → **F3 の確認の後に** G4 の 002
   - F3 の Edge（PR272 の単発投稿）・worker（PR224）にアダプターをつなぐのは、F3 の作業
5. v2 を本当に使うには、PR126 の文書の手順が要る（authenticated への付与、署名する Edge の配備、v1 の取り消し）。それまでは v1 しか接続の手段がなく、**G4 の判定はどのアカウントも確認済みにしない**（安全側）。

## 4. F5／G5 への申し送り

- 使っているのは、F5 の既存の口だけ: `private.account_lifecycle_brand_owner(brand)` と `private.account_lifecycle_service_state_readonly(user, 'x_autopost')`（読むだけ、ロックなし）。F5 のファイルは変えていない。
- v2 の begin／consume／complete は、F5 の T13 ガード（`account_lifecycle_assert_active_service_write`）を最初に呼ぶ（PR126 のまま）。
- F5 PR275 の「資格情報の世代」は `x_account_credential_generation` で応えた。

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
