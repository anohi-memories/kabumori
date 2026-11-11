# POSTONA X 接続（OAuth）の硬化 — 調査と候補（ソースのみ）

- 作成: 2026-10-10（G4、TASK `postona-x-oauth-provider-hardening-candidate-20261010`）
- 状態: **候補だけ。** 本番への適用、Edge の deploy、付与の変更はしていない。候補 SQL は migration ではなく、どこからも呼べない。
- 依存（どちらも Draft で、main にも本番にもない）:
  - G5 の T13（service-write guard）: Draft PR #121（`76b50e1e`）
  - G4 の T9（ワークスペースを作る唯一の入口）: Draft PR #124（`c30f2464`）
- 関連: `docs/postona/threads-g5-t9-t10-t13-shared-contract-20261010.md`（T9 / T10 / T13 の共有契約）と、PR #124 の設計メモ §0.9〜§0.10。

## 0. 要点

- 今の X 接続の complete RPC は、**ログインした人なら誰でも、他人の X アカウントを先に自分の行へ結び付けられる。** 結び付けられた X アカウントの本当の持ち主は、運用者が外すまで接続できない。これを使い捨て DB で再現した（本物では試していない）。
- 候補は、既存の3つの RPC を変えずに、新しい名前の3つ（`_v2`）を所有者専用で追加する。v2 は、先頭で T13、ワークスペースは T9、state は X の行に結び付け、complete にはコード交換をしたサーバーの署名（attestation）を必須にする。
- 切り替えは、付与・鍵・Edge の deploy を含む**別のレビューとユーザーの承認**が必要な作業（§3）。旧 RPC の実行権を外した時点で、先取りの穴が閉じる。
- **すでに作られた先取りは、v2 にしても残る。** 運用者が外す手順が必要（§3）。

## 1. Stage A — 今の X 接続（使い捨て DB で再現）

### 1.1 本番に出ている版（repo の記録から。本番 DB は読んでいない）

| 対象 | 本番での状態（記録） |
| --- | --- |
| `20260919120000_social_mobile_x_oauth_onboarding.sql`（begin / consume / complete、`authenticated` に EXECUTE） | 適用済み。履歴の版は `20260919222101`（`.agent/CODEX_REPORT_2.md`、2026-09-19） |
| `20260922003101_social_mobile_x_oauth_reconnect_preserve_verified.sql`（begin の置き換え） | 適用済み。履歴の版は `20260922024844`。読み直しでは `authenticated` が EXECUTE=true、anon / service_role / PUBLIC は false（同、2026-09-22） |
| Edge `x-oauth-connect-user` | ACTIVE、`verify_jwt=false`（Supabase Auth で bearer を自前で確かめる）。ユーザー本人の JWT のまま3つの RPC を呼ぶ |

- complete を置き換える migration は、ほかにない（`supabase/migrations` を確認）。
- 2a-2（`20261007150000`）は本番に未適用。

### 1.2 再現した結果（`postona_x_oauth_hardening_behavior.sql` §2）

1. **先取り（preclaim）**
   - 手順: ログインした人 P が、Edge を通さずに begin → consume → complete を直接呼ぶ。complete には、他人 V の X ユーザー ID と、自分で作った文字列のトークンを渡す。
   - 結果:
     - **受け付けられる。** P の行が V の X ID で `identity_verified` になる。handle も P が自由に決められる。
     - そのあと V が本物の接続をしても、`X_ACCOUNT_ALREADY_CONNECTED` で拒否される。運用者が外すまで直らない。
     - POSTONA に未登録の人（利用権なし）でも同じことができる（live の経路には T13 がない）。
   - 必要な条件:
     - ログインできること。
     - アプリに入っている公開の anon key と自分の JWT で、PostgREST の `/rest/v1/rpc/...` を直接呼べること。Supabase の標準の構成だが、本番の PostgREST の設定は確認していない。
     - X のユーザー ID は公開情報なので、狙う相手の ID は簡単に分かる。
   - できないこと:
     - 投稿（トークンが偽物なので X に拒否される）
     - 他人のトークンを取ること
     - 他人の行を書き換えること
   - 重大度: **中**。可用性（正しい持ち主が接続できない）と、表示の信頼性（他人の handle を自分の接続として見せられる）の問題で、乗っ取りではない。
   - 本番で起きているかは**未確認**（本番 DB を読んでいない）。確かめ方は §3 の preflight に入れた。
2. **`failed` の記録は残らない**
   - complete の `unique_violation` のハンドラーは、行を `failed` にしてから例外を投げ直す。
   - その例外で同じトランザクションが取り消されるため、`failed` も消える。
   - 再現でも、V の行は `authorization_pending` のまま、state は未消費、secret もなかった。
   - **v2 の方針**: 「全体を取り消し、何も記録しない」をそのまま仕様にした。エラーは呼び出した人にその場で返るので、状態として残す必要はない。残すには state の消費と途中の書き込みを確定させる必要があり、そのほうが不正確になる。
3. **begin が T9 / T13 と違う**
   - 利用権が終了した人でも、begin が通る（T13 がない）。
   - 別の brand の owner なら、その brand に X の行を付ける（決定論的なワークスペースを使わない）。
4. **provider を確かめない**: consume / complete は `platform='x'` を条件にしていない。Threads の state を渡しても、2a-2 の CHECK（または本人確認）で全体が失敗する。ただし、制約に頼っているだけ（PR #124 で確認済み。v2 では明示的に拒否する）。
5. **入力の範囲が広い**: begin は redirect の形も期限の上限も見ない。`http://` で1年先の期限でも受け付けた。

## 2. 候補 — `supabase/candidates/postona_x_oauth_hardening_candidate.sql`

- **migration ではない**。`supabase/migrations` の外に置いたので、どのツールも適用しない。
- 前提条件として次の3つを要求する。どれかが欠けていれば、固定コードで止まり、何も作らない。
  - G5 の T13 が実在し、所有者が同じで、API ロールから実行できないこと
  - PR #124 の T9 provisioner が実在し、SECURITY INVOKER で、所有者が同じで、API ロールから実行できないこと
  - 本人 ID の一意インデックスが、2a-2 と同じ定義であること
- 作るもの（EXECUTE は所有者だけ。API ロールへの付与は 0。既存の3つの RPC は、定義も付与も変えない）:
  - `public.begin_social_mobile_x_oauth_connection_v2(text, text, timestamptz)`
  - `public.consume_social_mobile_x_oauth_state_v2(text)`（読み取りだけ）
  - `public.complete_social_mobile_x_oauth_connection_v2(uuid, text, text, text, text, text)`（最後の引数が attestation）

**順序**（共有契約 T13 のロック順: `auth.users` KEY SHARE → `common_accounts` → `service_entitlements` → ワークスペース → state → `social_accounts` / Vault）

| RPC | 順序 |
| --- | --- |
| begin v2 | ① 形だけを見る ② T13 ③ T9 provisioner ④ X の行を FOR UPDATE（なければ作る。別の id の X 行があれば `X_ACCOUNT_CONFLICT`）⑤ state を INSERT |
| consume v2 | ① 形 ② T13 ③ 読み取りだけ（本人が始めた、本人の決定論的ワークスペースの、X 行の、未使用で期限内の state） |
| complete v2 | ① 形 ② T13 ③ attestation ④ ワークスペースの lock → owner の所属 ⑤ state を1文で消費 ⑥ X 行を FOR UPDATE ⑦ Vault（2つ）⑧ 行の更新 |

- X のトークン交換（HTTP）は、consume と complete の間で、DB のトランザクションの外にある。code は再試行しない（今の Edge と同じ）。

**attestation**
- 鍵は Vault の `postona_x_connect_attestation_v1`（ちょうど1つ、32文字以上）。Threads とは別の鍵にした。片方が漏れても、もう片方には使えない。テストでも、Threads の鍵での署名は拒否されることを確認した。
- メッセージは次を改行でつないだもの: `postona-x-connect-v1`、state id、X のユーザー ID、username、access トークンの SHA-256、refresh トークンの SHA-256。トークン自体は入れない。
- SQL と TS（`supabase/functions/_shared/social/x_connect_rpc_contract.ts`）が同じ既知解を出すことを、両方のテストで固定した。
- 鍵を持つのは Edge だけ。Edge は、自分で X とコード交換し、`/2/users/me` で読んだ ID にだけ署名する。PKCE の verifier はクライアントだけが持つので、他人の認可コードを横取りしても、交換はできない。

**その他**
- エラーコード: 意味が同じものは今と同じ名前にした（`OAUTH_STATE_INPUT_INVALID`、`OAUTH_STATE_NOT_CONSUMABLE`、`OAUTH_TOKEN_OR_IDENTITY_INVALID`、`SOCIAL_MOBILE_ACCOUNT_NOT_OWNED`、`X_IDENTITY_ACCOUNT_MISMATCH`、`X_ACCOUNT_ALREADY_CONNECTED`）。新しいものは次の4つ: `X_CONNECT_ATTESTATION_UNAVAILABLE` / `_INVALID`、`X_ACCOUNT_CONFLICT`、`X_CREDENTIAL_SHAPE_INVALID`。T13 と provisioner の拒否コードも返りうる。
- 入力の形:
  - X のユーザー ID は20桁までの10進数。
  - username は1〜15文字の `[A-Za-z0-9_]`（`@` なし。保存は今と同じく小文字）。
  - トークンは空白なしの印字可能な ASCII で、16〜4096文字。access と refresh は別の値。
  - redirect はカスタムスキームか https。`http://`、`#`、`*`、`@`、空白は不可。2048文字まで。
  - 期限は今から10分以内（今の Edge は、ちょうど10分を渡している）。
  - **X のトークンの文字種と長さは、X の公式の記述で確かめていない**（要検証。§5）。
- 資格情報（Vault には参照だけを書く）:
  - access と refresh の2つの参照を、作るか、同じ id のまま上書きする（今と同じ名前 `<行のid>_access_token` / `_refresh_token`）。
  - 次の場合は `X_CREDENTIAL_SHAPE_INVALID` で全体を取り消す:
    - 参照が他の行と共有されている
    - 参照先の secret がない
    - 2つの参照が同じ secret を指している
    - 行の名前の secret が残っている
- 再接続:
  - 本人確認済みの行は、新しい begin のあとも `identity_verified` のまま（`20260922003101` と同じ）。
  - 別の X ID なら `X_IDENTITY_ACCOUNT_MISMATCH`。
  - 同じ ID なら、同じ参照を上書きする。今の経路で接続した行も、v2 でそのまま再接続できる（テストで確認）。
- `publish_enabled=false`（今と同じ。接続しただけでは投稿しない）。

## 3. 切り替えの計画（将来。別レビュー・ユーザー承認・本番の作業）

**前提**: G5 の T13 と、PR #124 の provisioner（と 2a-2）が本番に入っていること。

**本番の読み取り専用 preflight**（ユーザーが実行する）:
- 今の X 行のうち、決定論的なワークスペースにないもの（「owner の brand」経由で付いたもの）の数。v2 の begin はこれらを `SOCIAL_MOBILE_WORKSPACE_CONFLICT` で拒否するので、先に扱いを決める。
- X を接続済みで、`x_autopost` の利用権が active でない人の数。v2 の begin は T13 で拒否するので、再接続ができなくなる。
- 先取りの疑いがある行。identity_verified なのに、トークンが一度も使われていない（投稿・refresh の成功記録がない）行を、運用者が見る。
  - 一意インデックスがあるので、同じ X ID の重複はない。疑わしい行の判断には、運用者の確認が要る。
- 3つの RPC の定義と ACL が、source と同じであること（md5 で比べる）。

**手順**（各段階で読み直しを行う）:
1. 候補を適用する（関数の追加だけ。誰からも呼べない）。
2. attestation の鍵を作り、Vault と Edge の secrets の2か所に置く。値は誰も見ない形にする（ユーザーの承認）。
3. 有効化の migration:
   - v2 の3つを `authenticated` に付与する（旧の3つも付与したまま）。
   - 2a-2 の「social_accounts を書く SECURITY DEFINER 関数のレビュー済み一覧」に、v2 の begin と complete を加える（テストで、新しく増えるのはちょうどこの2つと Threads の2つであることを確認済み）。
4. Edge を v2 版にして deploy する（`x_connect_rpc_contract.ts` を使う）。アプリとのやりとりの形は変えない。
5. テスターで、新しい接続と、既存の接続の再接続を1回ずつ確かめる。
6. **旧の3つの RPC から `authenticated` の EXECUTE を外す。** この時点で先取りの穴が閉じる（テストで、外したあとは permission denied になり、既存の X 行が変わらないことを確認）。

**3〜6 の間の注意**: 旧の経路が残るので、穴も残る。テストのレース8で、この間に旧の経路の先取りが、v2 の正しい接続に勝ちうることを確認した。間隔は短くする。

**ロールバック**:
- 6 の前: Edge を前のバージョンに戻すだけでよい。v2 は付与を外せば、誰からも呼べなくなる。
- 6 の後: 旧の RPC の付与を戻し、Edge を戻す（穴も戻る）。
- どちらでも、既存の接続のトークンと参照は変わらない。v2 は同じ id を上書きするだけなので。

**すでにある先取りへの対応**: v2 にしても、すでに結び付けられた X ID はそのまま残る（テストで確認）。運用者が該当する行の ID を外す手順が必要になる。テストでは、ID を外したあとに正しい持ち主が v2 で接続できることを確認した。手順の正式化と、本人からの申し出の窓口は未決定。

## 4. 検証（使い捨て PostgreSQL 17。本番なし）

`supabase/tests/postona_x_oauth_hardening_run.sh`
- 必要なもの: PR #124 の3つのファイル（`POSTONA_PR124_DIR`。PR #124 が main に入れば不要）。
- 2つのモードがある:
  - `POSTONA_T13=mock`: PR #124 にある T13 の代わり。**MOCK_ONLY**
  - `POSTONA_T13=g5`: G5 の PR #121 の本物の候補
- 環境: G5 の世界（Phase 1 / service start / Phase 3a）、今の X オンボーディングの migration、退会、2a-2、PR #124 の T9。
- 適用の拒否:
  - T13 がない・API ロールから届く・別の所有者
  - provisioner がない・SECURITY DEFINER・service_role から届く・別の所有者
  - 別の作成者、superuser
  - pgcrypto がない、本人 ID のインデックスがない・広い、Vault に名前がない
  - 再適用
- 適用したあと、旧の3つの RPC と PR #124 の関数の定義と付与が変わっていないこと。
- 挙動（`postona_x_oauth_hardening_behavior.sql`）:
  - Stage A の再現
  - 到達できるもの、T13 の全拒否コード × 3つの RPC（拒否のときは書き込み 0）
  - ワークスペース（今の begin が作ったものの再利用、Threads との共有）と、他人のもの・共有・旧 brand・別の X 行の拒否
  - 入力
  - consume の結び付け（Threads の state、他人の state、他のワークスペース、期限切れ、旧 brand）
  - complete:
    - 先取りの試み（作った値、推測した鍵、別の ID の署名）
    - attestation の改ざん、鍵がない・短い、Threads の鍵
    - 再利用、再接続、二重接続（全体の取り消し）、残っている先取り
    - Vault の障害、資格情報の形、owner でなくなった場合
    - 今の経路で接続した行の再接続
  - begin と complete の間のライフサイクルの変化
  - 切り替えの模擬（旧の付与を外す）
  - lifecycle の行が変わらないこと
- 2セッションの競合:
  - v2 の begin どうし
  - v2 の begin と Threads の begin、今の begin と v2 の begin（それぞれ両方の順序）
  - ロック順
  - begin と全削除
  - complete と POSTONA のみの終了
  - 同じ state への complete どうし
  - 同じ X ID を2人が同時に complete
  - 切り替えの間の、旧の経路の先取りと v2 の正しい接続
- 適用したあとに provisioner、次に T13 を消すと、v2 はすべて失敗し、何も書かない。
- TS: `x_connect_rpc_contract_test.ts`（既知解、入力、拒否コードの一致、どこからも import されないこと）。
- **MOCK_ONLY**: mock モードの「T13 が最初の書き込みより前に動く」の記録による確認は、G5 の判定の安全性の証明ではない。
  - ロック順は、競合テストで両方のモードで確認している。
- **未証明**:
  - 本物の Supabase Auth / GoTrue / PostgREST、本番の ACL と PostgREST の公開設定
  - 本物の Vault（pgsodium）
  - X の API（トークンの形を含む）
  - 新しい Edge（作っていない）

## 5. 残り・次

- 切り替え（§3）は、別の TASK として、レビューとユーザーの承認を経て行う。Edge v2 の実装も、その TASK に含める。
- X のトークンの文字種と長さを、X の公式の記述で確かめる（v2 の入力の形の根拠）。
- T10（プロバイダ別の後始末）は対象外のまま（G5 と G4 の統合作業）。X の revoke、Threads の remote revoke、利用権、退会の状態機械には触れていない。
- 統合のセキュリティレビューは1回だけ。G5 の本物の guard と、G4 の X / Threads の RPC・Vault・後始末の境界が揃ったときに行う。
