# G4-21：X の接続のサーバー側の B1〜B4 の修正の前の契約と QA の設計（設計だけ、2026-10-22 JST）

- task_id: `postona-g4-x-oauth-session-state-server-remediation-design-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **DESIGN_ONLY／PRODUCTION_NO_GO**。コード・SQL・migration・権限・本番は変えていない。実装は別の TASK と独立のレビューの後。
- 元: G4-20 の監査（PR #437 `c03c30b9f1f8c333621db060d3a20f04444e549d`、`docs/postona/x-oauth-server-session-boundary-audit-20261022.md`）。
- 読んだもの（読み取りだけ）:
  - main `0c42933ca5030ab31a56267529430d0473d9b155` の X の接続（`supabase/functions/x-oauth-connect-user/`、migration `20260919120000`・`20260922003101`）
  - PR #426 `03968e5c…`（アプリの3つの確認）
  - PR #353 `4d42b5c7…`／#355 `155b1181…`（交換の前の再認可と G5 R1 の adapter。どちらも MERGE_NO_GO）
  - **G4 PR #126 `65f49f98dab39b974e6e4b450f376a37f99ef1ac`**（X の `_v2`：所有者だけ、T13・T9・attestation。Issue #131 でユーザーが 2026-10-11 に延期）
  - **G3 PR #257 `005d7eccb0d71068abc4c746214a83f1b3f6f847`**（今の v1 に T13 だけを足す暫定の wrapper。v2 への切り替えで役目を終えると PR #257 自身に書いてある）
  - G5 の T13（PR #178 系統 `83334a09` の `20261010051938`。main には無い）
  - H5 の `claim_candidate.sql`（session を `FOR SHARE` で持つ例）
  - G4 PR #124 `c30f2464…`（T9）

根拠の印: **[S]** ソース（ファイル:行）／**[K]** SDK のソースとコメント／**[U]** 未確認。

## 1. 流れの図（今の main と、各ゲートの位置）
```
アプリ（PR #426）                         Edge x-oauth-connect-user                 DB（PostgREST、authenticated の JWT）
 G1 開始：今のセッション＝画面の人     →  /auth/v1/user（1回）[S]            →  begin（v1）: auth.uid() で state（人だけ）を保存 [S]
    セッション ID あり                       結果の user id は使わない
 （X のブラウザ）
 G2 交換の直前：同じ人・同じセッション →  /auth/v1/user（1回）[S]            →  consume（v1、読み取り）: initiated_by = auth.uid() [S]
                                          X とコードの交換（取り消せない）
                                          X の本人情報                        →  complete（v1）: initiated_by = auth.uid() で消費、owner、Vault [S]
 G3 成功の直前：同じ人・同じセッション
```
- セッションの状態は、どこにも「共有」されていない。アプリは SDK の保存したセッションを読む。Edge は Auth に1回だけ問い合わせる。DB は JWT の署名と期限だけを見る [S]＋[U]。
- **保証されていること**: 人の一致（state の作成者＝JWT の人、workspace の owner）[S]。
- **保証されていないこと**:
  - セッションの一致（B1）
  - complete の時点でセッションが生きていること（B2）
  - X の本人情報が本当に Edge の交換の結果であること（B3）
  - 交換の前の owner・ライフサイクルの確かめ直し（B4）
- ログアウトの後の `/user` の拒否は [K]（auth-js のコメント）で、実測していない。

## 2. B1〜B4 ごとの修正の契約
### B1：state を session に結び付けていない
- **案 S1（推奨）**: state の表（土台の表で、migration で作られていない。G4-17）を変えずに、**G4 の専用の表**に結び付けを持つ。
  - 例: `postona_x_oauth.state_sessions(oauth_state_id pk → social_account_oauth_states(id) on delete cascade, user_id, session_id, created_at)`。所有者だけ、RLS 有効、`revoke all`（G5 R-2／R-3）。
  - begin（v2）が、同じトランザクションで `auth.jwt()->>'session_id'` を記録する。session_id が無ければ拒否する。
  - consume（v2）と complete（v2）は、`state_sessions.session_id = auth.jwt()->>'session_id'`（と user_id）を求める。違えば `OAUTH_STATE_NOT_CONSUMABLE` と同じ形で拒否する（存在を漏らさない）。
- 案 S1' は、`social_account_oauth_states` に列を足すもの。土台の表の作り直し（G4-17、Data API の 10/30）と一緒に扱う必要があるので、**今は採らない**。
- **副作用**:
  - A→B→A（同じ人の新しいセッション）、別の端末での続き、ログインし直しの後の続きは、すべて拒否される（やり直しになる）。
  - 同じセッションの token の更新は通る（session_id は変わらない）[K]。
  - PR #426 のアプリの確認と同じ線になる。
- **旧いアプリ**（PR #426 より前）: A→B→A の後の callback は、サーバーで拒否される。エラーとして見えるだけで、誤った結び付けは無い。

### B2：complete の時点で、セッションを確かめ直していない
- **案 S2（推奨）**: G5 の **T13**（`private.account_lifecycle_assert_active_service_write(auth.uid(), 'x_autopost')`）を、consume と complete の**最初**に呼ぶ。
  - T13 は、ロックの後に、JWT の `session_id` が `auth.sessions` の生きている行（本人のもの、`not_after` の前）であることを読む [S（`20261010051938:151-162`）]。
  - これで、`/user` の確認の後に入ったログアウト（G4-20 の B2）は、complete のトランザクションの中で見える。拒否のときは、state の消費・Vault・行の更新が全部取り消される。
  - v2（PR #126）は、3つとも T13 を先頭で呼ぶ設計 [S]。PR #257 は、v1 に同じ T13 を足す暫定の wrapper [S]。
- **残る隙間**: T13 は `auth.sessions` を**ロックせずに読む**（GoTrue の行なので、と T13 の注記にある）[S]。だから、T13 が読んだ後、complete の COMMIT の前に入ったログアウトは見えない。ただし、1つのトランザクションの中の短い時間で、結び付くのは本人のワークスペースだけ。
  - H5 の Threads の claim は、`auth.sessions` を `FOR SHARE` で持って、`not_after` の更新も止めている [S（`claim_candidate.sql:51-52`）]。
  - **X でも `FOR SHARE` にするかは、G5 に確かめる**（§4 の COORDINATION）。
- **Edge 側**: complete の直前にも `/user` を呼ぶ（二重の守り）。ただし、DB の T13 が正本で、Edge は早めに止めるためだけ。
- **副作用**:
  - 終了・削除中・ロック中のアカウントや、`x_autopost` の利用権が無い人は、consume と complete が拒否される（T13 の仕様）。
  - 既存の X の利用者が再接続できなくなる場合は、本番の読み取りの preflight で数える（PR #126 §3 のとおり）。

### B3：complete が authenticated に直接付与され、attestation が無い（既知、Issue #131、ユーザーが延期）
- **案 S3（推奨）**: PR #126 の v2 に切り替える。
  - v2 の complete は、Edge だけが持つ鍵（Vault の `postona_x_connect_attestation_v1`）での HMAC（state id・X の id・username・2つのトークンの SHA-256）を求める [S（PR #126 doc §2）]。
  - 切り替えの最後に、**v1 の3つから authenticated の EXECUTE を外す**。そこで先取りの穴が閉じる。
- 案 S3'：G4-19 の案 C のように、X も owner transport だけにする。
  - X の Edge は「ユーザーの JWT だけで、service role も所有者の DSN も使わない」という作りなので、作り直しが大きい。**今は採らない**。
  - v2 に attestation があれば、authenticated への付与が残っても、直接の呼び出しで任意の id は付けられない。
- **副作用**:
  - 鍵を Vault と Edge の secrets の2か所に置く（ユーザーの承認）。
  - v1 を外すまでの間は、v1 の穴が残る（PR #126 のレース8で確認済み）。
  - すでに作られた先取りは残るので、運用者が外す手順が要る（PR #126 §3）。
- **前提**: Issue #131 はユーザーの判断で延期中（2026-10-11）。**B3 の実装は、ユーザーが再開を決めてからにする**（Issue #131 の再開のきっかけ）。

### B4：交換の前に owner・ライフサイクルを確かめ直していない
- **案 S4（推奨）**: 交換の前（consume の時点）に、次の2つで確かめる。
  - **T13**（ライフサイクル・利用権・セッション）: v2 の consume が先頭で呼ぶ。
  - **G5 R1**（owner epoch・lifecycle_version）: PR #353 の交換の前の再認可と PR #355 の adapter を、v2 の Edge に載せ替える。
- **副作用**:
  - 交換の前に止まれば、X のコードは使われない（やり直せる）。
  - PR #353 は「port が未接続だと X の接続が止まる」状態なので、G5 R1 の接続と Sol のレビューの前にはマージしない（今の条件のまま）。

## 3. 導入の順序と rollback（将来。各段階でユーザーの承認と独立のレビューが要る）
1. 前提:
   - G5 の T13・R1 が本番に入っている。
   - PR #124 の T9（ワークスペースを作る唯一の入口）と 2a-2（`20261007150000`）が入っている。
   - Data API の 10/30 の土台の表の扱い（G4-17）が決まっている。
2. G3 PR #257 の暫定の wrapper（v1 に T13）を使うかどうかは、v2 までの期間の長さで決める（G3 の判断）。
   - 使えば、B2 と B4 のライフサイクルの部分は、v1 のうちから閉じる。
   - B1 と B3 は閉じない。
3. G4 v2（PR #126 を土台に、S1 の `state_sessions` を足す）を適用する（関数の追加だけで、誰からも呼べない）。
4. attestation の鍵を、Vault と Edge の secrets に置く（値は誰も見ない形にする）。
5. v2 を authenticated に付与する（v1 も残したまま）。Edge を v2 の版にし、PR #353／#355 の再認可を載せる。アプリとのやりとりの形は変えない。
6. テスターで、新しい接続と再接続を確かめる。
7. **v1 の3つから authenticated の EXECUTE を外す**（ここで B3 が閉じる）。PR #257 の wrapper も、v1 と一緒に役目を終える。
- **rollback**:
  - 7 の前なら、Edge を v1 に戻し、v2 の付与を外す。
  - 7 の後に戻すなら、v1 の付与を戻す。ただし、穴も戻る。
  - S1 の表は、v2 の rollback と一緒に消す（cascade）。
- **アプリへの影響**:
  - 送る形は変わらない。
  - 新しい拒否（セッションの変化、利用権なし）は、Edge のエラーとしてアプリに返る。アプリは `terminal_error`（または PR #426 の `session_changed`）を表示する。誤った成功は出ない。

## 4. 持ち主・担当（提案。未承認のものは未確定）
| 担当 | 中身 | 状態 |
|---|---|---|
| **G4** | v2（PR #126）の作り直し（S1 の表、T13・R1 の順序、エラーの固定コード）、Edge の v2 化、PR #353／#355 の載せ替え、§5 の E2E の実装 | 提案。**B3 はユーザーの再開の判断が要る（Issue #131）** |
| **G5** | T13（セッションが生きていることの確認）と R1 の正本。X で `auth.sessions` を `FOR SHARE` にするか、読むだけでよいかの判断 | **COORDINATION を送った（未回答）** |
| G3 | PR #257 の暫定の wrapper を使うか（v2 までの期間による）。PR #257 自身に「v2 で役目を終える」と書いてあるので、新しい連絡は要らないと判断 | 連絡しない |
| G2 | アプリの QA（PR #419 の CB5／CB6 の期待の更新は、担当ちゃが依頼済み）。サーバーの E2E は G4 が作る | 新しい連絡は要らない |
| 独立のレビュー | Auth と OAuth の境界（H2 は Codex が停止中。Claude の代理の結果は本番のセキュリティの受け入れと同じではない）。どの H の枠で、どのモデルにするかは担当ちゃとユーザーが決める | 未確定 |
| ユーザー | Issue #131 の再開（B3）、鍵と secrets、本番の preflight、各段階の適用 | 未確定 |

## 5. 将来の E2E の受け入れの表（偽の Auth・偽の X・隔離した PG17 だけ。`--deny-net`。本物のセッション・token は使わない）
- **世界**:
  - PG17 に、X の接続の migration（v1）と、v2 の候補・S1 の表、G5 の T13 を入れる。
  - 最小の `auth` の模擬（`auth.uid()`・`auth.jwt()`・`auth.sessions`）を入れる。
  - Edge の `oauth_logic.ts` を、注入した `fetch` で動かす。Auth の `/user` は模擬（sessions の表を見る）、PostgREST は claims を置いて呼ぶ模擬、X の token と `users/me` も模擬にする。
- **数えるもの**（どの場面でも数える）:
  - X の token の端点が呼ばれた回数
  - Vault の書き込み
  - state の消費
  - S1 の行
  - 応答のコード
  - ログとエラーに token・code・verifier・鍵・DB の生の文が無いこと

| # | 場面 | 今（v1、修正前の記録） | 修正後（v2＋S1＋T13＋R1＋attestation） |
|---|---|---|---|
| 1 | 同じ人・同じセッションの普通の接続 | 成功 | 成功（X の呼び出しは1回、Vault の書き込みは2つ） |
| 2 | B の JWT で A の state | consume が拒否、X の呼び出しは0 | 同じ |
| 3 | global のログアウトの後の A の JWT | `/user` が拒否（模擬） | 同じ。DB の T13 でも拒否 |
| 4 | `/user` の後、X の交換の最中にログアウト（B2） | **完了する** | complete の T13 で拒否。state・Vault・行は変わらない（交換は済んでいるので、X のコードは使われたまま） |
| 5 | A→B→A（B1） | **完了する** | consume で拒否、X の呼び出しは0 |
| 6 | 同じセッションの token の更新 | 成功 | 成功 |
| 7 | 同じ state の callback が2つ同時 | 完了は多くても1つ | 同じ |
| 8 | PostgREST で complete を直接、任意の X の id（B3） | **通る（先取り）** | v2 は attestation が無いので拒否。v1 は付与を外した後なら permission denied |
| 9 | 利用権が終了・削除中の人（B4 のライフサイクル） | **通る** | consume の T13 で拒否、X の呼び出しは0 |
| 10 | owner A→B→A（B4 の owner epoch） | **通る** | 交換の前の R1 で拒否、X の呼び出しは0 |
| 11 | 通信のエラーで残ったサーバーのセッション | 通る | 方針を固定する（T13 は「生きている」と答える。拒否するなら別の印が要る。今は「本人のもの」として通すのが案） |
| 12 | session_id の無い JWT | 通る | begin で拒否 |
- **修正前の失敗の証拠**: 4・5・8・9・10 を、v1 に対する「今の動き」の試験として先に固定する。
- **わざと欠陥を入れた検出**: S1 の照合を外す、T13 を外す、attestation を外す、R1 を外す、v1 の付与を残す。

## 6. 独立のレビューの受け入れの条件
1. §5 の表のすべてが、偽の Auth・偽の X・PG17 で通っていること。修正前の失敗の証拠があること。
2. 誤った人への結び付けが、Edge の流れでも、PostgREST の直接の呼び出しでも起きないこと。
3. 拒否のとき、X の交換の前なら X の呼び出しは0、交換の後でも state・Vault・行は変わらないこと。
4. v2 と S1 の表の ACL が所有者だけであること（G4-19 の条件と同じ）。v1 の付与を外す時点が手順にあること。
5. エラーとログに秘密が無いこと。固定のエラーコードであること。
6. T13 のロックの方針（読むだけか、`FOR SHARE` か）が、G5 と合意されていること。
7. 本物の Supabase Auth の `/user`・`session_not_found`・ログアウトの scope ごとの動きを、使い捨ての環境で実測していること（今は [K]／[U]）。

## 7. 未解決のまま守っていること
- PR #124／#405 の所有者だけの契約（G5 は回答済み。H5 は未回答。H5 の claims の置き方が G5 の T-1 と食い違う）
- PR #412・#418 の独立のセキュリティのレビュー
- PR #426 の独立の Auth のレビューと、G2 PR #419 の期待の更新
- Supabase Data API の 10/27 の持ち主の合意（G3 は未回答）
- H2 の Codex の停止
- PR #353／#355 は MERGE_NO_GO
- Issue #131 の延期（ユーザーの判断）
