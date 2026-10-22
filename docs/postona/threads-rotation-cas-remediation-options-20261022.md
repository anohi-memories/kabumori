# G4-26：Threads の延長（rotation）の比較交換の競合を直す方針（source-only の設計とレビューの準備、2026-10-22 JST）

- task_id: `postona-g4-threads-rotation-cas-remediation-options-design-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **DESIGN_ONLY／製品の欠陥は未解消／独立のレビューが要る／PRODUCTION_NO_GO**
  - 変更はこの文書だけ。SQL・candidate・rotation・release・RPC・Auth・ACL・RLS・Edge・他の枠の path・既存の PR の head は変えていない。
  - 製品の修正は別の TASK で行う。この文書は修正でも、レビューの PASS でも、本番の GO でもない。
- 前提の再現: PR #453（head `0ab309bc4b851808bd16539136450573ab8a9e66`、G4-25）。土台は PR #449（`89b966382f3c2b6104ee13847c5448a9fa9f11f3`）。
- 読んだ source（すべてこの branch の中。行番号はこの branch のもの）:
  - `supabase/candidates/postona_threads_publish/threads_credential_rotation_candidate.sql`（blob `7366b660…`。以下「rotation」）
  - `supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql`（以下「custody」）
  - `supabase/candidates/postona_threads_binding_epoch/001_threads_binding_epoch.sql`・`002_custody_connect_proof.sql`（PR #418）
  - `supabase/candidates/postona_threads_oauth_workspace_candidate.sql`（PR #124 の `complete`）
  - `supabase/functions/_shared/social/threads_token_refresh.ts`（F4 の延長の設計の候補。以下「refresher」）
  - `supabase/candidates/postona_threads_auth_runtime/owner_transport.ts`・`wiring/custody_port.ts`（H5）
  - G3 PR #374 `e3dfbd3c…` の 007 の世代の関数（読み取りだけ）

## 1. 実測の証拠と、source から言えること・仮説の区別

| 種類 | 内容 | 根拠 |
|---|---|---|
| **実測（再現）** | SQL だけを見ると、請求した版と同じ `now()` の再接続の後で、古い延長が `rotated` になり、再接続の token を古い系統で上書きする | PR #453 の R7（1トランザクションの模型）と collision（同じマイクロ秒に始まった別々のトランザクション） |
| **実測（PASS）** | 同じリースの二重の成功、期限の短縮、切断の後の延長、ふつうの時刻の再接続は、どれも拒否される | PR #453 の R1〜R6・race、欠陥 4/4 |
| **実測（試作）** | custody を書くたびにリースを消す trigger（試験の世界だけ）で、R7 と collision は `LEASE_NOT_HELD` になる | PR #453 の §5・§7 |
| source から言えること | 延長の経路は、今どこからも呼ばれていない。rotation の claim／rotate を呼ぶ TS は、この branch にも main にも無い。refresher は `THREADS_TOKEN_REFRESH_ENABLED = false` で、どの Edge からも import されていない | `git grep`（`claim_threads_credential_refresh`・`threads_token_refresh`）。§2.3 |
| source から言えること | 実際の延長の経路では、請求した版は**24時間より古い**（下の §2.1）。だから、同じ `now()` の再接続には、24時間以上の時計の後退か、それに相当する異常が要る | refresher の `refreshDecision`（`too_young`）、Meta の文書の「24時間以上」（refresher の 6〜9行に引用。Meta での実際の強制は未確認） |
| 仮説 | 将来の書き込み（たとえば `mark_threads_credential_reauth_required`）が同じ版の比較を使うと、24時間の制約が無いので、同じ時刻の競合が起きやすくなる | rotation の文書の「要再接続の印」の後続の予定（`threads-credential-rotation-cas.md` 148行） |

## 2. NOT_RUN だった項目の source-only の検証

### 2.1 実際の延長の経路で、同じ時刻は起きるか（新しく分かったこと）
- refresher は claim の `custody_recorded_at` を発行の時刻とみなし、24時間より若いと `too_young` で延長しない（`threads_token_refresh.ts` 30〜37行、claim の答え rotation 244〜248行）。
- Meta も、24時間より若い token の延長を受け付けないと文書にある（同 6〜9行）。
- 再接続の custody の書き込みは `recorded_at = now()` で、その時刻は再接続のトランザクションの開始である（002 の 99〜103行）。
- したがって、実際の延長が `rotated` になる状況で `recorded_at` が同じになるには、再接続のトランザクションの開始が、請求した版（24時間以上前）と同じでなければならない。
- 起こりうる形:
  1. DB の時計が24時間以上戻る（step）
  2. 再接続のトランザクションが24時間以上開いたままになる。H5 の transport は1回の呼び出しで1トランザクションなので、通常は起きない。idle のトランザクションの上限は未確認
  3. 24時間の規則を持たない別の呼び出し元が rotate を呼ぶ（今は無い）
  4. Meta が若い token の延長を実際には受け付ける（文書と違う。T7 と同じく未確認）
- **見立て**:
  - 今の設計の組み合わせでは、実際に起きる可能性はとても低い。
  - ただし rotation 自身の不変条件（`recorded_at` で再接続を見分ける）は SQL の単体では成り立たない。安全は、別の部品（refresher の方針と Meta の規則）にたまたま支えられている。そのため修正は必要と考える。

### 2.2 時計の後退
- `now()` も `clock_timestamp()` も、DB の時計から取る。時計が戻ると、後のトランザクションの `now()` が前の値と同じになりうる（§2.1 の形 1）。
- 等しくならずに前へ戻った場合は、安全側に倒れる:
  - 再接続の `recorded_at`・`verified_at` が、請求した版より前になる → rotate の `recorded_at` の比較で `STALE_CREDENTIAL`
  - rotate の `recorded_at = now()` が `verified_at` より前になる → 期限の読み出し（custody 104〜112行、`recorded_at >= verified_at`）が NULL → `credential_row` は0行（要再接続）
- 時計が戻ると、リースの60秒（`lease_expires_at > clock_timestamp()`）が実際より長くなり、条件の窓が広がる。
- 修正の候補 A・B・C は時刻を使わないので、時計の影響を受けない。`clock_timestamp()` に替えるだけでは影響を受ける（§4）。

### 2.3 延長の後の、同じ時刻（rotate が書いた版）
- rotate も `recorded_at = now()` を書く（rotation 336行）。SQL の仕組みは、接続が書いた版と同じである。
- ロックの順で見ると:
  - rotate のトランザクション X は、アカウントを FOR UPDATE で持つ（rotation 297行）。
  - 同じマイクロ秒に始まった再接続 R は、PR #124 の `complete` の `update social_accounts`（workspace 336行）で X の commit を待つ。
  - 次の claim C が R より先にアカウントの行を取れるのは、R がまだ `update` に届いていない間だけである。
- 実際の延長の経路では、延長の直後の claim は期限が延びたので `not_due` になり、rotate しない（refresher 35行）。だから、この形も §2.1 と同じく、時計の異常か別の呼び出し元が要る（**仮説。実行していない**）。

### 2.4 実際の H5 の transport
- H5 の `owner_transport.ts` は、接続（begin・claim・complete・custody）だけを持つ。延長の claim／rotate は呼ばない（§1）。
- 延長の H5 の側（store port の実装）は、まだ存在しない。rotation の想定は次のとおり:
  - tx1: claim → 同じトランザクションで Vault から token を読む
  - tx2: rotate → `vault.update_secret`（rotation 24〜28行）
- **H5 への条件**（修正の候補とは別に要る）:
  1. token は claim と同じトランザクションの中で読む。claim はアカウントの行を FOR UPDATE で持つので、claim と読み出しの間に再接続が割り込めない。
  2. rotate が拒否されたら、延長で得た token を捨てる。別の claim に持ち越して、もう一度 rotate しない。refresher は `conflict` を返して終わるので、この形になっている（143〜146行）。
  - 2 が守られないと、どの修正の候補でも、古い系統の token が新しい claim の版で書かれうる。

## 3. 修正の候補の比較（A・B・C・D）

| 観点 | A: 書き込みでリースを消す | B: 単調に増える custody の版 | C: リースを接続の識別に結び付ける | D: 再接続で secret の id を新しくする |
|---|---|---|---|---|
| 仕組み | custody の行の INSERT・UPDATE のたびに、そのアカウントのリースを消す（AFTER の trigger）。rotate は `LEASE_NOT_HELD` になる | custody に `version bigint` を持たせる。**表をまたいで一意な sequence**（`nextval`）で、書き込みのたびに BEFORE の trigger が設定する。リースはその値を持ち、rotate は値の一致を求める | リースに `bindings.oauth_state_id`（または `connect_proof` の hash）を持たせる。rotate は、今の binding と同じかを確かめる。再接続のたびに、新しい state と proof になる | PR #124 の `complete` が、再接続でも `vault.create_secret` で新しい secret を作る。今の secret の id の比較だけで、再接続を見分けられる |
| 再現した2つの形を防ぐか | 防ぐ（試作で実測） | 防ぐ（設計。未実測） | 防ぐ（設計。未実測） | 防ぐ（設計。未実測） |
| 時刻に頼るか | 頼らない | 頼らない | 頼らない | 頼らない |
| 依存する DB の object | 新しい関数1つと、custody の表の trigger 1つ。rotation の file に置ける（リースの表を定義しているのは rotation） | custody の表の列・sequence・trigger（custody の candidate）。rotation の claim・rotate・リースの列。G3 の世代は hash しない列なので、変えなくてよい | rotation から `postona_threads_binding.bindings`（PR #418 の 001）を読む。適用の順は 001 → … → rotation になる | PR #124 の `complete` の本体。001 の入口はその prosrc の md5（`8c90c72f…`）を固定しているので、固定の更新も要る |
| rollback | trigger と関数を消すだけ（データは変わらない）。rotation にはまだ rollback の file が無いので、一緒に作る | 列と sequence と trigger を消し、claim と rotate を元の本体に戻す（md5 の固定）。版の値は失われるが、安全側（リースは60秒で終わる） | リースの列を消し、claim と rotate を戻す | `complete` を戻すと in-place の更新に戻る。作った secret は残る（Vault の後片付けが要る） |
| トランザクションの一体性 | 接続の complete のトランザクション（入口 → custody）の中で消える。rollback（G4-24 の C8）で一緒に戻る | 同じ書き込みの中で値が決まる | rotate の中で読み比べるだけ | `complete` の中 |
| 資格情報の上書き | 再接続の後の古い rotate は、時刻と無関係に拒否される | 同上 | 同上。ただし binding を変えない書き込み（入口を通らない PR #124 の `complete` 単独）は見分けない（G4-24 の C3 では `credential_row` が0行になるので、token は渡されない） | 同上。入口を通らない `complete` 単独も見分ける |
| リースの一生 | 書き込みで終わる。rotate の自分の書き込みでも消えるが、rotate はどのみちリースを消す（rotation 339行）ので同じ | 変わらない | 変わらない | 変わらない |
| ロックの順 | 接続: アカウント（`complete` の update）→ binding → custody → リース。claim と rotate: アカウント → custody → リース。どれも**アカウントの行を先に持つ**ので、新しい待ちの輪はできない（レビューで確かめる） | 書き込みの行の中だけ。新しいロックは無い | 001 の入口は、アカウントの行を持った後で binding を書く（001 の 244〜291行の順）。rotate がアカウントを FOR UPDATE で持った後に binding を読めば、ロックを足さずに安定した値を読める | `complete` の中だけ |
| Vault の移行 | 無し | 無し | 無し | 有り。古い secret をいつ消すか（投稿のグラントがまだ古い id を使っているかもしれない）。既存のアカウントの扱い |
| ACL | 新しい関数は所有者だけ（rotation の postcondition の一覧に足す）。trigger の関数は invoker で `search_path = ''` | 列と sequence も所有者だけ | 変わらない（rotation は所有者として binding を読む） | 変わらない |
| 監査のしやすさ | リースが消えた理由は残らない。rotate の答えは `LEASE_NOT_HELD` で、再生（replay）と区別できない（区別したければ別の印が要る） | 版の番号の順が残り、どの版を延長したかが分かる | リースに、どの接続に対するものかが残る | secret の id が接続ごとに残る |
| 冪等性 | 消すだけなので何度でも同じ | sequence の欠番は問題ない | 読み比べるだけ | 再接続のたびに新しい secret（やり直しで secret が増える） |
| H5 の変更 | 要らない（`custody_port.ts` は書き込み関数の形と ACL だけを確かめ、表の trigger は見ない） | claim の答えに版を足すなら、store port の `credentialVersion` の作り方が変わる。答えを変えずに rotate がリースの版と比べるだけなら要らない | 要らない（rotate が自分で読む） | Vault の後片付けと、custody の書き込みの前提（同じ id）が変わる |
| G3／G5 の変更 | 要らない。G3 の世代はリースを hash する（007）が、custody の書き込みで世代はどのみち変わる | 要らない | 要らない | G3 の世代は secret の id を hash するので値は変わるが、意味は正しい |
| 大きさ | 小 | 中 | 小〜中 | 大 |

### 3.1 `clock_timestamp()` に替えるだけでは足りない理由
- `clock_timestamp()` も時計の値で、識別子ではない。同じ刻み（マイクロ秒）にも、時計の後退にも弱い（§2.2）。
- `verified_at` は PR #124 の `complete` が `now()` で書く（workspace 336行）。custody だけを `clock_timestamp()` にしても、期限の読み出しの `recorded_at >= verified_at` の意味が変わるだけで、再接続の識別にはならない。
- G4-16（PR #418）でも、`now()` の比較を「同じトランザクション」の証明に使う形を、時刻ではなく proof に替えた。同じ理由である。

### 3.2 検討して外したもの
- **E: Vault の中身の hash をリースに持たせ、rotate で比べる**: 再接続の in-place の更新を時刻と無関係に見分けられる。ただし、SQL の中で復号した secret を読むことになり、rotation の「token は答えに入れない・SQL は秘密を持たない」の方針と合わない。採らない。
- **social_accounts の表の trigger で、A を `verified_at`・secret の id・`platform_user_id` の変更にも広げる**: 入口を通らない `complete` 単独も捕まえられる。ただし `social_accounts` は migration で作られていない共有の表で、所有者が決まっていない（G3-22 の意思決定の表が作成中）。**未決定**として残す。

## 4. 推奨（最小の修正と、多層の防御）
1. **最小の修正: A**（custody の AFTER INSERT OR UPDATE の trigger で、そのアカウントのリースを消す）
   - rotation の file（G4 の持ち物）に足す。H5・G3・G5 の変更は要らない。PR #453 の試作と同じ形で、実測で効いている。
   - 同時に rotation の rollback の file を作り、postcondition（所有者だけ、trigger があること、関数の md5）に加える。
2. **2層目: C**（リースに `bindings.oauth_state_id` を持たせ、rotate で今の binding と比べる）
   - A の trigger が無効にされたとき、また将来 custody を経ない再接続の経路ができたときにも、再接続を見分ける。
   - H5 の答えの形は変えない。`connect_proof` そのものは、秘密に近い値なので持たない（使うなら hash）。
3. **B は C の代わりの候補**: 将来、custody の版の比較を使う書き込み（要再接続の印など）が増えるなら、B のほうが汎用である。ただし custody の表と答えの形が変わり、H5 と相談が要る。
4. **D は今は採らない**: PR #124 の `complete` と 001 の固定、Vault の後片付けに広く影響する。
5. **どの候補でも要る H5 の条件**: §2.4 の 1・2（token は claim と同じトランザクションで読む、拒否されたら token を捨てる）。
6. **将来の書き込みの条件**: 要再接続の印など、版を比べて custody を書く新しい関数は、A の trigger を通り、C（または B）と同じ比較をする。

### 未決定（担当ちゃ・レビュー・他の枠の判断が要る）
- A の後に C と B のどちらを足すか。両方を足すか。
- `social_accounts` に trigger を置くか（共有の表の所有者の決定の後）。
- rotate が拒否したときに、「再接続で消えたリース」と「再生」を区別する印を持つか（監査）。
- 修正をどの PR に載せるか（rotation は PR #258 の系統の candidate。G4 の新しい TASK で、PR #453 の上に積む案）。
- Meta が24時間の規則を実際に強制するか（T7 と同じく未確認）。DB の idle のトランザクションの上限。

## 5. 他の枠への依存の条件
| 枠 | 推奨（A＋C）での条件 | 状態 |
|---|---|---|
| H5（#332、idle） | §2.4 の 1・2。延長の store port を実装するときに守る。A・C では、答えの形も呼び出しも変わらない | 未依頼（H5 は idle。無断で割り当てない） |
| G3（#318） | 変更は要らない。007 の世代はリースと custody を hash するので、A でリースが消えると世代が変わる。これは再接続でどのみち変わる | 連絡は要らない（採用が決まったら、念のため1回だけ） |
| G5（#320） | 変更は要らない。F5 の lifecycle の判断と、ロックの順は同じ | 連絡は要らない |
| F4 の系統（refresher） | §2.4 の 2 は今の refresher で守られている。将来変えるときの条件として残す | 情報のみ |

## 6. 試験の計画（隔離した PG17。PR #453 の runner を土台に、修正の TASK で足す）
- **正の試験**:
  - R1〜R6 と race が、修正の後も変わらず PASS
  - 接続 → claim → rotate の基本（期限が延び、新しい世代）
  - 再接続の後の新しい claim は、再接続の版で `rotated`
- **負の試験（修正の後は拒否になるべきもの）**:
  - R7（1トランザクション）、collision（別々のトランザクション）
  - 延長が書いた版での同じ時刻（§2.3 の形。R7 の接続を rotate に替える）
  - 時計の後退の模型（`recorded_at` を明示的に同じ値にした custody の書き込み。試験の世界だけ）
  - rotate が拒否された後、同じ token を新しい claim で書こうとする形。DB では防げない（H5 の条件）ことを「期待どおりの通過」として記録する
- **ロックと競合**:
  - 接続と claim と rotate の3つの session のロックの順（デッドロックが無く、`lock_timeout` で BUSY）
  - A の trigger が rotate の自分の書き込みで動いても、答えが変わらないこと
- **rollback**:
  - 正しい順（rotation の修正 → rotation → …）で戻せる
  - trigger が消えると、R7 が再び再現する（修正が効いていたことの確かめ）
- **わざと入れる欠陥**（それぞれ検出されること）:
  - A: trigger を外す／INSERT だけにする／ほかのアカウントのリースを消す／DELETE を `lease_id` の条件付きにする
  - C: 比較を外す／`oauth_state_id` を claim のときに入れない
  - B（採るなら）: 行ごとの番号にする（再作成で同じ値に戻る ABA）
- ACL: 新しい関数・列・sequence が所有者だけで、API の役割（`anon`・`authenticated`・`service_role`）に届かない

## 7. 独立のセキュリティのレビューのためのチェックリスト
1. 脅威の再評価: §2.1 の「実際の延長の経路では24時間以上の時刻の一致が要る」という推論は正しいか。ほかに、若い版で rotate に届く経路は無いか。
2. A の trigger が、custody のすべての書き込み（接続の 002、rotate、将来の書き込み）で動くか。`TRUNCATE`・`COPY`・`session_replication_role = replica` で trigger を飛ばせる役割が、所有者以外にいないか。
3. A のロックの順: 接続（アカウント → binding → custody → リース）と claim・rotate（アカウント → custody → リース）で、待ちの輪ができないか。
4. C: rotate がアカウントの行を持った後に読む binding は、入口がアカウントの行を持ってからしか書かれないことを確かめる（001 の順）。古い state が後から完了した場合（G4-14 の「最後の完了が勝つ」）も、別の `oauth_state_id` になるか。
5. B を採るなら、sequence が表をまたいで一意で、行の削除と再作成で同じ値に戻らないか。
6. H5 の条件（§2.4）が store port の実装で守られるか。token が claim の外で読まれていないか。拒否の後に持ち越していないか。
7. 監査: 拒否の答えの code で、運用者が何を区別できる必要があるか。
8. rollback の順と、rollback の後に R7 が再現すること（修正が外れたことが分かること）。
9. 時計: DB の時計の step（後退）が管理環境で起きるか。lease の60秒への影響。
10. Meta の24時間の規則が実際に強制されるか（強制されないと §2.1 の支えが弱くなる）。
11. ACL と postcondition: 新しい object が所有者だけで、rotation の postcondition に入っているか。
12. 範囲の外: 入口を通らない PR #124 の `complete` 単独（`social_accounts` の trigger の要否）。共有の表の所有者が決まった後で判断する。

## 8. NOT_RUN／NOT_VERIFIED
- この TASK では SQL を実行していない（docs だけ）。§2 の検証は source を読んだ結果で、§2.1・§2.3 の結論は推論である。
- 修正の候補 B・C・D の実装と実測
- 時計の後退・延長の後の同じ時刻の実測
- H5 の延長の store port（まだ無い）
- Meta の24時間の規則の実際の強制、Meta の延長の振る舞い（T7）
- 本物の Supabase・Auth・Vault・Meta、本番
