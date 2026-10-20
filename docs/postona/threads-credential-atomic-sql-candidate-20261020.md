# G4-11：Threads の `credentialFor` を1つの文で返す SQL の候補と、隔離した PG17 の証明（2026-10-20 JST）

- task_id: `postona-g4-threads-credential-atomic-read-sql-candidate-20261020`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ／完了コード K4／`next_task_allowed: false`
- 判定: **SOURCE_ONLY_SQL_CANDIDATE（未適用、使い捨ての PG17 だけで証明）**。
  - Codex Sol（高）の限定のレビューの前。
  - 安全の PASS・PRODUCTION_GO とは言わない。
- 土台: PR #373（head `61e94a10026df2eb6aa5f3acdc4f4512c4cb96fd`）の上。
  - PR #367（G4-09、H2 で CHANGES_REQUIRED P2）とそのレビューのブランチは**変えていない**。試験の世界に読み取り専用で重ねただけ。

> **訂正（G4-15、2026-10-21）**: 下の「保管の期限が未来」は `now()`（トランザクションの開始時刻）で比べていたため、長いトランザクションの中では期限切れのトークンを返した（H2 #329 C2 R1）。G4-15 で、取り出す時点の時計（`clock_timestamp()`）との比較、VOLATILE、READ COMMITTED のときだけ、依存の STABLE の呼ぶたびの確認に直した。詳しくは `threads-credential-expiry-clock-fix-20261021.md`。

## 1. 現状の事実（調べたこと）
| もの | 持ち主 | 状態 |
|---|---|---|
| Threads のトークン | PR #124 の complete が Vault に保存（`vault.create_secret`）し、`social_accounts.vault_access_token_secret_id` に参照を持つ | 候補・未適用 |
| 期限の記録 | G4 の保管 `threads_account_credential_custody` と読み取り口 `threads_account_credential_expires_at`（その Vault の参照について、接続の後に記録した期限だけを返す） | 候補・未適用 |
| 延長（入れ替え） | G4 PR #258／#263 のリースと比較交換。Vault を書き換えるのは H5 | 候補・未適用 |
| 資格情報の世代（64桁） | **G3** の 007 の `postona_threads_resv.threads_credential_generation`（PR #374 `e3dfbd3c`）。アカウント・所有者・Vault の参照・接続・保管・延長のリースを hash する | 候補 |
| 結び付けの世代 | G4 PR #367 の `postona_threads_binding.bindings`（owner_epoch・lifecycle_version） | 候補・**未承認**（H2 P2） |
| 使うときの判定 | G5 PR #358 の W1 `account_lifecycle_worker_brand_verdict(brand, 'x_autopost', epoch, lifecycle)` | 候補（H1 の再レビューは CHANGES_REQUIRED、導入時の検査） |

どれも本番には無い（管理環境は NOT_VERIFIED）。

## 2. 候補（`supabase/candidates/postona_threads_credential_atomic/001_threads_credential_atomic.sql`、と rollback）
`postona_threads_credential.credential_row(social_account_id text, service_key text)`
- 返すもの: **0 行か 1 行** `(social_account_id, threads_user_id, access_token, generation)`。G4-02 の `ThreadsCredentialStatement` の行と同じ形。
- 性質: owner だけが使える。STABLE・SECURITY DEFINER・空の search_path。
- **1つの SELECT（1つのスナップショット）** の中で、次のすべてを満たすときだけ行を返す。
  1. キーが G5 の共通の `x_autopost`（G4-10。キーだけでは何も通らない）
  2. Threads のアカウントで、identity_verified、Threads の利用者 ID の形
  3. G4 の結び付けが、今のワークスペースと今の Threads の利用者に一致し、**結び付けた人が今の唯一の所有者**
  4. G5 の W1 が、結び付けの owner_epoch と lifecycle_version について `active`
     - 所有者 A→B→A、終了と再開、削除、凍結は別の答えになるので、行は返らない。
  5. G4 の保管の期限が未来（期限切れ・記録なし・入れ替えたのに未記録は返らない）
  6. Vault の中身がある
  7. G3 の世代が 64 桁の小文字の 16 進
- **トークンと世代は同じ文から**返る。G4 は自分の世代を作らない。G3 は preflight で claim のときの世代と比べるので、2回の呼び出しの間の入れ替えは G3 が拒否する。
- 前提:
  - superuser でない。
  - **API の役割（anon・authenticated・service_role・authenticator）が owner になれない**（MEMBER・SET・USAGE のどれでも。NOINHERIT を含む）。
  - 表と依存の関数が同じ owner で、どれも STABLE（VOLATILE だと1つのスナップショットにならない）。
  - 再適用は拒否する。
- 事後の確認（**H2 #329 の PR #367 への P2 を受けて**）:
  - 関数とスキーマの ACL に **owner 以外の名前が1つも無い**こと。既定の ACL で委任先の役割に付与される形を含み、`proacl` が null（＝PUBLIC が実行できる）の場合も拒否する。
  - 委任先を誰が使えるかに関係なく、付与そのものを拒否する。
- 呼び手（Edge の資格情報の口、worker の役割への付与）は**別の承認の手順**で、今回は何も付与していない。

## 3. 証明（`supabase/tests/postona_threads_credential_atomic_run.sh`、PostgreSQL 17.11、ローカルの socket）
- 世界:
  - G5 の本物の lifecycle（PR #178 `83334a09` の migration を重ねた）
  - F5 PR #303 `88481aef` の owner epoch
  - 2a-2、PR #124、G4 の保管
  - G4 PR #367 `fd714505` の結び付け
  - **G5 PR #358 `4f4ece89` の本物の R1／W1**
  - **G3 PR #374 `e3dfbd3c` の 007 から、世代の関数だけを一字一句そのまま**取り出したもの（007 の残りは F3 の 001〜006 が要るので入れていない。007 全体との結合は NOT_VERIFIED）

| 段階 | 結果 |
|---|---|
| 世界 | PASS |
| 前提の拒否: superuser、authenticator が NOINHERIT・SET で owner になれる、W1 の欠落、G3 の世代の欠落、保管の読み取り口の欠落、G3 の世代が VOLATILE、結び付けの表の欠落 | PASS |
| **H2 の形**: 既定の ACL で関数の EXECUTE を委任先に与える（authenticated がその委任先に INHERIT FALSE・SET TRUE で届く）、既定の ACL でスキーマの USAGE を委任先に与える | PASS（どちらも事後の確認で拒否） |
| 再適用の拒否、rollback、rollback の2回目の拒否、再適用 | PASS |
| 振る舞い | PASS |
| 2つの接続: 入れ替え（Vault の更新と保管の再記録）を commit する前と後に `credential_row` を読む | PASS |
| ミューテーション | **12/12 を検出**（等価な2件は別に報告） |

- 振る舞いで確かめたこと:
  - API の役割と、authenticated が SET ROLE できる委任先のどれからも 42501（届かない）。関数の ACL は owner だけ。
  - 本物の流れ（begin → G4-09 の記録 → 同じトランザクションの中で complete・結び付けの attest・保管の記録）の後、本物の形の ID（`sa_…`）で、1行（ID・Threads の利用者・トークン・G3 の世代）が返る。列は G4-02 の4つ。
  - 次の場面ではどれも行が返らない（**それぞれ別の利用者で**確かめた）:
    - 他のキー（`kabumori`・null・`X_AUTOPOST`・空・空白つき）、知らないアカウント
    - 結び付けなし、別の Threads の利用者
    - **A→B→A**（W1 が `OWNER_EPOCH_CHANGED` と答えることも確かめた）
    - **終了と再開**（SYNTHETIC: lifecycle_version を直接上げた）
    - 2人の所有者、接続の解除
    - 期限切れ、保管なし、別の Vault の参照、Vault の中身なし
    - 結び付けた人が別の人
  - 入れ替え（SYNTHETIC）の後は、新しいトークンと**新しい世代**が同じ呼び出しで返る。
  - 2^53 を超える lifecycle_version でも正確に一致する。
  - 読み取りは何も書かない。
- 同時の確認: commit 前の入れ替えは見えず（前の組のまま）、commit 後は新しいトークンと新しい世代の組になる。**組が混ざることは無い**。
- ミューテーション12種:
  - キーを問わない、W1 を外す・`active` 以外を許す
  - 結び付けの照合を緩める、結び付けた人の確認を外す
  - 保管の期限を無視する、世代を別に計算する（null）
  - API への付与
  - **事後の ACL・スキーマの確認を弱める**（既定の ACL の世界で適用できてしまう）
  - **owner への到達の確認を外す**（authenticator が SET できる世界で適用できてしまう）
  - **VOLATILE を許す**
- 等価な2件（二重の守りとして残した。外しても答えは変わらない）:
  - identity_verified の確認: G4 の保管の読み取り口も同じ条件を求める。
  - 世代の 64 桁の確認: 文がすでに選んだ Threads のアカウントには、G3 の関数は必ず 64 桁を返す。
- 外への通信・本物の Supabase・Vault・OAuth・トークン・Threads は0回。トークンは偽物。Vault は試験用の表の stub。
- Threads の TS の回帰: 295 passed／0 failed（TS は変更なし）。
- NOT_VERIFIED:
  - 管理環境（Auth・PostgREST・Vault の暗号・ACL）
  - G3 の 007 全体と F3 の 001〜006 との結合
  - 本物の延長の書き手（PR #258／#263 と H5）
  - worker の役割への付与
  - 本番

## 4. G4-02 の口に重ねて分かった不一致（U2、G3 の連絡 #319 6279580056 を確認）
- 本物の行（ID が `sa_…` の文字列）を G4-02（PR #373）の口に渡した（作業用フォルダだけ）:
  - 行の読み取り `parseThreadsCredentialRow` は正しく受け付ける。
  - **入り口の `createGatedThreadsCredentialPort().credentialFor` が、ID が UUID の形でないと尋ねる前に null を返す**ので、本物のアカウントでは常に null になる。
- 同じ UUID の確認は、次の2か所にもある:
  - G4-03 の `connectedReceiptAccountId`（受領票の `social_account_id`）
  - G4-04 の縦断の `bindingProblem`
- **修正**: 3か所の確認を DB の CHECK と同じ `^[a-z][a-z0-9_]{1,80}$` にする。
  - G4 の TS の小さな変更で、この TASK の許可の範囲（新しい SQL と試験）の外なので、**次の作業**として提案する。
  - G3 には1回返答した。

## 5. 他の持ち主との IF（記録）
- **G3**:
  - 007 の `g4_threads_account_verified` は、まだ G3 の DENY。G4 の結び付けで置き換えるかは、G3 と G4 の別の手順。
  - 007 の preflight と、この文が両方とも G3 の世代を使うので、世代の定義は G3 のものに一本化している。
- **G5**:
  - W1（PR #358）の受理を待つ。
  - begin の認可（ブランドなし）が未決定。
- **H5**: 本物のトークンの保管・延長の書き手（Vault の書き込み）は H5 の持ち物で、触っていない。
- **H2**: PR #367 の P2（ACL の確認と S1→S2→S1）の修正は、別の承認の TASK。この候補は PR #367 を前提に読むだけで、承認済みとはみなしていない。

## 6. 行っていないこと
- 管理環境の DB／Auth／RLS／RPC／SECURITY DEFINER の本物への適用、本番の Edge／Cron
- Vault・本物のトークン・Meta／Threads の OAuth／API・投稿、ゲートを開くこと、有料の API
- main への push、マージ、デプロイ
- PR #367 とそのレビューのブランチ、G3／G5／H5 のファイル、他の枠の worktree の操作
