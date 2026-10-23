# G4-35：POSTONA の個人の作業場所（S1-F1）と OAuth の境界の契約表（source-only、2026-10-23 JST）

- task_id: `postona-g4-s1-f1-personal-workspace-oauth-contract-source-only-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **DESIGN_ONLY（source を読んだだけ。コード・DB・OAuth は NOT_RUN）／契約の提案と質問／他の owner の合意ではない／PRODUCTION_NO_GO**
  - この文書は、G5・G3 の実装の仕様を確定しない。製品の OAuth の経路は、契約が合意されるまで書き換えない。
  - G4-34 の隔離の TOCTOU の成果（PR #482）を、本番の対策済みとは扱わない。
- 前提:
  - 総合指令の DIRECTIVE（#319 6366748864）と COORDINATION（#319 6366593654）。
  - ユーザーの決定（案A）:
    - 既存の `auth.users` の id・`brands`・`brand_memberships`・entitlement・epoch を保つ。
    - 個人の作業場所を優先する。
    - 共有のスタッフ、所有権の譲渡、共通のログインの画面、Miseiro は延期する。
  - G5 の S1 の契約の設計: PR #477（`f7a221b7a45cf22c36b5e4d3d2c42ed564512d4a`、`docs/common-account/g5-23-postona-personal-auth-s1-contract.md`、§4.1 の規則の提案）。

## 0. 証拠の印と固定した版
- 印:
  - **[M]**: main の source（どこかで動いている証拠ではない）
  - **[C]**: Draft PR の候補（適用されていない）
  - **[R]**: 実測の報告（この TASK では実行していない）
  - **[S]**: この TASK の source からの推論
  - **[U]**: 未確認
  - **[OPEN]**: ユーザーや総合指令の判断を待つもの
- 参照の形は `path@版:L行`。

| 版 | commit | 中身 |
|---|---|---|
| main | `0c42933ca5030ab31a56267529430d0473d9b155` | X の begin（live）、アカウントの削除の作業場所の規則 |
| G4 | `b963683b3173bed274843eedd9543889dc8534c5`（PR #482） | PR #124（Threads の作業場所と OAuth）、001・002（入口・custody）、rotation、A〜005 |
| G4X | `39ab57ab…`（`claude/f4-postona-x-m1-identity-credential-20261018`） | X の OAuth の v2（G4 の候補） |
| F3 | `005d7ecc…`（`claude/f3-x-oauth-t13-guard-20261017`） | X の OAuth の T13 の囲い（G3／F3 の系統の候補） |
| G5S | `21a5cad4b71de63265db8517da93c6efc60cdde8`（PR #457） | T13、R0／R1、owner epoch |
| G3X | `6aae11a2b1686b5ec34c9b96f263468e2b28ecb4` | X の予約（G3） |

## 1. S1-F1 の確認（source から）
G5 の S1 の報告（#320 6358965774）の S1-F1 を、source で確かめた。**「その人の作業場所」の規則が食い違っている。**

| 書き手・判定 | 規則 | 場所 |
|---|---|---|
| **X の begin（live）** [M] | 所有している brand が**1つなら、id・種類・他のメンバーに関係なく再利用する**。2つ以上なら拒否（`SOCIAL_MOBILE_MULTIPLE_OWNED_BRANDS_UNSUPPORTED`）。0なら `u_<md5>` を作る。T13 も R0 も呼ばない | `supabase/migrations/20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql@main:L27-L45` |
| X の begin の T13 の囲い [C]（F3） | T13 を先に呼び、**今の live の関数をそのまま**呼ぶ（規則は live と同じ） | `supabase/candidates/postona_x_oauth_t13_guard/001_x_oauth_t13_guard.sql@F3:L88-L97` |
| X の OAuth の v2 [C]（G4X） | `private.social_mobile_ensure_personal_workspace`（下の行と同じ厳しい規則） | `supabase/candidates/postona_x_oauth_hardening_candidate.sql@G4X:L159-L179` |
| **Threads の provisioner** [C]（PR #124、G4） | id は `u_<md5>`。**ほかの brand を所有していれば拒否**（`SOCIAL_MOBILE_WORKSPACE_CONFLICT`）。種類が違えば拒否（`…NOT_SELF_SERVICE`）。他のメンバーがいれば拒否（`…SHARED`）。自分が owner でなければ拒否（`…ROLE_MISMATCH`）。削除の途中なら拒否 | `supabase/candidates/postona_threads_oauth_workspace_candidate.sql@G4:L129-L169` |
| **R0** [C]（G5） | `u_<md5>` だけを見る。無い、またはちょうど本人だけが owner の `social_mobile_user_v1` なら allow。**ほかに所有している brand は見ない** | `supabase/candidates/common_account_authorization_verdict/002_bootstrap_verdict.sql@G5S:L157, L209-L211` |
| 作業場所の id | `u_` ‖ md5(user) の先頭24文字（変わらない） | `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql@main:L98-L100` |
| G3 の X の予約 [C] | その X のアカウントの `brand_id`。所有は、その brand の owner の行があること | `supabase/candidates/postona_x_reservations/001_postona_x_reservations.sql@G3X:L188-L193` |

### 1.1 食い違いが出る場面（[S]。実行していない）
| 人の状態 | X の begin（live） | R0 | Threads（PR #124） | G3 の X の予約 |
|---|---|---|---|---|
| `u_<md5>` だけを本人が単独で所有（ふつう） | `u_` | allow | `u_` | `u_` |
| **古い・共有の brand L を1つだけ所有**、`u_` は無い | **L に結び付ける** | **allow**（`u_` が無い） | **拒否**（`WORKSPACE_CONFLICT`） | **L で予約**（X のアカウントが L にある） |
| `u_` を所有し、他のメンバーもいる | `u_` を再利用（他のメンバーを見ない） | `WORKSPACE_OWNER_UNKNOWN` か `OWN_WORKSPACE_CONFLICT` | 拒否（`WORKSPACE_SHARED`） | `u_` |
| `u_` の種類が違う（`social_mobile_user_v1` でない） | 再利用 | deny（`OWN_WORKSPACE_CONFLICT`） | 拒否（`NOT_SELF_SERVICE`） | `u_` |
| brand を2つ以上所有 | 拒否 | `u_` だけを見る（ほかは見ない） | 拒否（`WORKSPACE_CONFLICT`） | 既存の X のアカウントの brand |

- **影響**: R0 が「allow」と言った同じ人の X の接続が、別の作業場所（L）に結び付く。G3 の予約もそこで動く。Threads は拒否する。
  - 「1人に1つの作業場所」が、X と Threads で別の作業場所になりうる。
  - R0 の allow を、X の begin の正しさの根拠にはできない。

## 2. 契約表（session の本人 → 唯一の作業場所 → owner epoch／接続の世代 → OAuth の state・begin・callback → token の custody・lease・CAS・失効）
| # | 時点 | 決める人（authority） | 返す値 | owner | 失敗の code（例） | 再試行・冪等性 |
|---|---|---|---|---|---|---|
| 1 | **session の本人** | T13 `private.account_lifecycle_assert_active_service_write(user, key)`（`20261010051938…@G5S:L70` 以降）。R0／R1 は JSON の claims（`sub`・`role`・`session_id`・`is_anonymous = false`。`002…@G5S:L144`） | 例外か通過。R0／R1 は v1 の wire | **G5** | `ACCOUNT_LIFECYCLE_AUTH_REQUIRED`（G4-24 C7 で、1つずつの claim と JSON を混ぜると拒否されることを実測 [R]）、`SESSION_REVOKED`／`EXPIRED` | 読むだけ。T13 は匿名を拒否しない（G5 の S1-F2）[C] |
| 2 | **唯一の作業場所** | 提案の規則（G5 §4.1、PR #124 の provisioner と同じ）: `u_<md5>`、`social_mobile_user_v1`、本人だけが owner、**ほかの brand を所有しない** | 作業場所の id | 規則は **G5**、書き手は **G4（Threads・X の v2）** と **G3／G4（X の live の begin）** | `SOCIAL_MOBILE_WORKSPACE_CONFLICT`／`…SHARED`／`…NOT_SELF_SERVICE`／`…ROLE_MISMATCH`／`SOCIAL_MOBILE_ACCOUNT_DELETION_IN_PROGRESS`（`…workspace_candidate.sql@G4:L145-L169`） | 作る処理は `on conflict do nothing`、所有の確認は毎回。同じ人なら同じ id |
| 3 | **owner epoch／サービスの世代** | begin の後に R1 の `g5oe:<epoch>:<lifecycle>` を `record_state_generation` で state に記録（`001_threads_binding_epoch.sql@G4:L162-L206`）。callback の入口が同じ値かを確かめる（`@G4:L274-L283`） | 記録 | 提供は **G5**（OE・R1）、使うのは **G4** | `THREADS_BINDING_NOT_OWNER`／`…OWNER_EPOCH_UNKNOWN`／`…OWNER_EPOCH_CHANGED`／`…SERVICE_GENERATION_CHANGED`／`…STATE_ALREADY_RECORDED` | state ごとに1回だけ記録できる |
| 4 | **OAuth の begin** | `begin_social_mobile_threads_oauth_connection`（`…workspace_candidate.sql@G4:L175-L219`）: T13（L191）→ 作業場所（L193）→ アカウント → state（期限は10分以内、L188） | 作業場所とアカウントの id | **G4** | `THREADS_OAUTH_STATE_INPUT_INVALID`、`THREADS_ACCOUNT_CONFLICT`、作業場所の code | state の hash の重複は拒否。begin を繰り返すと新しい state（アカウントは同じ） |
| 5 | **callback（code の交換の後）** | 入口 `postona_threads_binding.complete_and_attest_binding`（`001…@G4:L214`）が PR #124 の complete（`…workspace_candidate.sql@G4:L249`）を呼ぶ。中身: T13（L270）、**attestation の HMAC**（L283）、本人が owner（L292）、**state を1回だけ消費**（L295）、Threads の利用者の一致（L307）。その後、custody の書き込み（`002_custody_connect_proof.sql@G4:L68`。入口の証明が要る） | binding（`oauth_state_id`・`connect_proof`）と custody | **G4**（H5 の transport が呼ぶ） | `THREADS_OAUTH_STATE_NOT_CONSUMABLE`（二重の callback・期限切れ）、`THREADS_CONNECT_ATTESTATION_INVALID`、`THREADS_ACCOUNT_NOT_OWNED`、`THREADS_IDENTITY_ACCOUNT_MISMATCH`、`THREADS_BINDING_*`、`THREADS_CUSTODY_NOT_IN_CONNECT_TRANSACTION` | **二度目の callback は state の消費で拒否**。失敗はトランザクションごと戻る（G4-24 C8 [R]） |
| 6 | **接続の世代**（どの資格情報か） | binding の `oauth_state_id`（C）、消費済みの state の指紋（④）、custody の token の要約（G4-33）。どれも時刻を使わない | リースに記録し、延長で比べる | **G4** | `BINDING_CHANGED`、`CONNECTION_CHANGED`、`CREDENTIAL_CHANGED`／`CREDENTIAL_UNVERIFIED` | 隔離候補だけ [C][R]（PR #467・#472・#479） |
| 7 | **token の custody・lease・CAS** | claim（`threads_credential_rotation_candidate.sql@G4:L182`）→ `rotate_and_store`（`004_rotation_token_digest.sql@G4:L306`）。読み出しは `credential_row`（1つの文）か `threads_credential_verified_token`（`005_rotation_verified_token_read.sql@G4:L44`） | token（所有者の役割だけ） | **G4** | `LEASE_NOT_HELD`、`STALE_CREDENTIAL`、`OWNER_CHANGED`、`CREDENTIALS_MISSING` | リースは60秒・一度だけ |
| 8 | **失効**（切断・削除・サービスの停止） | 切断 `disconnect_threads_account`（`threads_disconnect_candidate.sql@G4:L109`）・後片付け・アカウントの削除が、行と Vault の secret を消す。F5 のライフサイクルの判断（P4）が先 | 0行／拒否 | **G4**（切断・後片付け）、**G5**（ライフサイクル） | `ACCOUNT_NOT_FOUND`、`CONNECTION_NOT_VERIFIED`、`SERVICE_NOT_ACTIVE` | 古い token は使えない（読み出しが0行） |

## 3. 具体的な食い違いと穴（[S]、G4 の source から）
1. **作業場所の規則**（§1）:
   - X の live の begin と F3 の囲いは「所有する brand が1つなら再利用」。
   - R0 は「ほかの brand を所有しない」を見ない。
   - Threads と G4 の X の v2 は厳しい規則。
2. **X の live の begin は T13 も R0 も呼ばない**（`…20260922003101…@main:L15-L45`）。F3 の囲いは T13 だけを足す。
3. **H5 の transport**（G4-30）:
   - 1つずつの claim と JSON を混ぜて置く。
   - PR #124 の complete を直接呼び、入口を通らない（G4-31 の ④ で、古い系統の延長は防げる [R]）。
4. **T13 は匿名の session を拒否しない**（G5 の S1-F2）。R0／R1 は拒否する。
5. **G3 の X の予約**は、X のアカウントの brand をそのまま使う。§1.1 の場面では、R0 の allow と別の作業場所になる。

## 4. 負の試験の契約（次の TASK 用。この TASK では NOT_RUN）
| # | 場面 | 期待 | 確かめる層 | 今の証拠 |
|---|---|---|---|---|
| N1 | 別のユーザーが、他人の state で callback | `THREADS_ACCOUNT_NOT_OWNED`／`THREADS_BINDING_NOT_INITIATOR`、何も書かない | complete・入口 | G4-24 C7 [R]（Threads） |
| N2 | 古い作業場所（legacy の L を所有）で X と Threads の begin | 合意した規則なら、どちらも同じ拒否（または同じ作業場所）。R0 も同じ答え | X の begin・provisioner・R0 | **未実測**。今は X が L、Threads は拒否、R0 は allow（§1.1） |
| N3 | locked／ban（`banned_until`） | begin・callback・延長・投稿を拒否 | T13・R0・F5 | locked は R0 が deny [C]。ban の意味は **[OPEN]** |
| N4 | 削除・切断の後の、古い callback・古い token | callback は拒否、token は0行、延長は拒否 | 削除の tombstone・切断・claim | 切断の後の延長は `CONNECTION_NOT_VERIFIED` [R]（G4-25 R5） |
| N5 | 所有者が2人（共有） | provisioner は `WORKSPACE_SHARED`、延長と `credential_row` は拒否 | provisioner・W1・rotation | 延長は拒否 [R]（G4-31 P7）。X の begin の live は**見ない** |
| N6 | ログアウト・session の更新の後の callback | 古い session の callback は拒否（`SESSION_REVOKED`）。新しい session で始め直す | T13・R1・H5 の session の固定（G4-18） | X の hook は G4-18 [C]。Threads の callback は **未実測** |
| N7 | 期限切れ・二重の callback | `THREADS_OAUTH_STATE_NOT_CONSUMABLE`、何も書かない | complete | source（L295-L302）。**未実測**（この TASK） |
| N8 | 再接続の後の古い token の延長 | 拒否、古い系統は渡されない | A・C・④・要約・005 | 隔離で PASS [R]（PR #460〜#482） |
| N9 | 所有者の epoch／CAS の競合（A→B→A、同じ `now()`） | 拒否 | 入口・W1・rotation | G4-24 C5・G4-25〜31 [R] |
| N10 | 匿名の session | すべて拒否 | T13（S2-1 で直す提案）・R0／R1 | T13 は**通す** [C]（S1-F2） |

## 5. 決めてもらうこと（#299 の判断待ち、[OPEN]）
1. **既存の古い・共有の作業場所を持つ人の扱い**: 拒否する（再接続を求める）のか、移行するのか。
   - G5 の提案は「何も引き継がない・動かさない」。
   - X の live の begin を直すと、その人の X の接続はできなくなる。
2. locked と ban の意味（読み取り・停止を許すか）。
3. POSTONA のログアウトが端末だけか、全体か。かぶモリへの影響。
4. 停止・削除の後に、受領票の読み取りや予約の取り消しを許すか。
- これらが決まるまで、§4 の N2・N3・N6 の期待は確定しない。

## 6. 各 owner への質問と確認の依頼（決定の依頼。この文書は決めない）
**G5 へ**
- Q1: §4.1 の規則を、owner だけが呼べる述語（S2）として出すか。R0 にも「ほかの brand を所有しない」を足すか。
- Q2: T13 の匿名の拒否（S2-1）の後、H5 の JSON だけの claims（G4-30）と矛盾しないか。
- Q3: X の begin の allow に R0 を使うのか、使わないのか（G4-30 の「begin の allow を code の交換や投稿に使い回さない」と合わせて）。

**G3 へ**
- Q4: X の live の begin（と F3 の囲い）を、§4.1 の規則に合わせる TASK を G3 と G4 のどちらが持つか。G4 の X の v2（G4X）は、すでにその規則。
- Q5: X の予約が X のアカウントの brand をそのまま使うことを、§4.1 の規則で上書きするか（予約の作成で作業場所を確かめ直すか）。
- Q6: 古い作業場所の X のアカウントと予約の扱い（§5-1 と一緒に）。

**source だけで確かめてほしいこと**
- G3: `001_postona_x_reservations.sql@G3X:L188-L193` が唯一の作業場所の決め方か。
- G5: `002…@G5S:L157-L211` に、ほかの所有の確認が無いこと。

## 7. 後の実装の順と、独立のレビューの条件（提案）
1. 総合指令とユーザーが §5 を決める（#299）。
2. G5 が規則の述語と S2-1（匿名の拒否）を出す（独立のレビュー: Codex Sol（高））。
3. G3／G4 が X の begin を規則に合わせる。G4 は X の v2 の候補、G3 は live の begin と予約。どちらも Codex Sol（高）。
4. G4 が Threads の provisioner を述語に置き換え、§4 の N1〜N10 を隔離 PG17 で試す。H5 の transport の移行（入口・JSON の claims・確かめた読み出し）を H5 に依頼する。
5. 独立のレビューの条件:
   - 3つの書き手と R0 が同じ場面に同じ答えを返すことを、§1.1 の表の全行で実測すること
   - 移行の有無（§5-1）が決まっていること
   - 本番の適用の前に、管理環境の読み取りの監査（G5-18）をすること

## 8. 続けて扱う別件（この TASK では変えない）
- release の TOCTOU（G4-34、隔離の候補 005 だけ）
- D8（特権者による Vault と custody の書き換え）
- 管理環境の Vault の権限と行のロック
- H5 の transport（直接の complete・混ぜた claims）
- PR #124 の authenticated の EXECUTE は有効にしない。Issue #131（X OAuth v2）は延期のまま（G4X の v2 の候補は、規則の比較のために読んだだけ）。

## 9. NOT_RUN／NOT_VERIFIED
- この TASK のコード・DB・OAuth の実行すべて。§1.1・§3 は source からの推論。
- §4 の負の試験（N2・N6・N7・N10 は、どの TASK でも未実測）
- 管理環境の Supabase の Auth・GoTrue の ban・Vault、本番
