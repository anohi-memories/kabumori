# G4-32：Threads の Vault の直接の更新（F2）を、認可・版の確認・監査で防ぐ source-only の設計（2026-10-23 JST）

- task_id: `postona-g4-threads-vault-direct-write-f2-remediation-design-20261023`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **DESIGN_ONLY（source を読んだだけ。SQL・DB の試験は NOT_RUN）／F2 は未解消／独立のレビューが要る／PRODUCTION_NO_GO**
  - **A＋C＋④（PR #460・#467・#472）でも F2 は残る**（G4-29 F2・G4-31 F2 で実測）。
  - 変更はこの文書だけ。SQL・候補・migration・ACL・RPC・Auth・Edge・Vault・資格情報の処理・H5 のコード・他の枠の path・既存の PR の head は変えていない。
- 土台: PR #472（`4303a159f55fbb31f8070d6a4d049401ac46408d`）

## 1. Threads の Vault の secret に触れるすべての経路（リポジトリの source から）
| 操作 | どこ | 関数の属性・ACL | 備考 |
|---|---|---|---|
| **作成** | PR #124 の `complete`（`postona_threads_oauth_workspace_candidate.sql` 314行 `vault.create_secret`） | SECURITY DEFINER、所有者だけ（349行の revoke） | アカウントに secret が無いとき |
| **その場の更新** | 同じ `complete`（329行 `vault.update_secret`） | 同上 | 再接続。ほかのアカウントと共有していないこと・secret があることを確かめてから（320〜327行） |
| **延長の書き込み** | H5 が rotate と同じトランザクションで `vault.update_secret`（rotation の注記 24〜28行） | **コードはまだ無い**（設計だけ） | — |
| 削除 | 切断 `disconnect_threads_account`（`threads_disconnect_candidate.sql` 189・193行）、後片付け `cleanup_threads_provider_footprint`（`threads_provider_cleanup_candidate.sql` 156・160行）、アカウントの削除（migration `20260928160000` 577行） | どれも SECURITY DEFINER | アカウントの行も消える、または切断になるので、その後の rotate は `ACCOUNT_NOT_FOUND`／`CONNECTION_NOT_VERIFIED`／`CUSTODY_UNKNOWN` |
| 復号して読む | `credential_row`（PR #412）、手での投稿（`threads_manual_publish_candidate.sql` 506行）、投稿の release（`threads_publish_release_candidate.sql` 273行） | 所有者だけ | 読むだけ |
| 他の provider | X の接続の `complete_social_mobile_x_oauth_connection`（authenticated に EXECUTE）は `platform` の条件が無い。2a-2 の CHECK で rollback されると推論（G4-30 §4、未実測） | — | X の系統の判断 |

- **リポジトリの中で、Threads の token を書き換えるのは `complete` だけ**（延長の書き込みは設計のみ）。F2 は、それ以外の書き手（所有者の権限のコード、手での SQL、管理画面などの運用、X の関数の誤用）を指す。
- **管理環境の権限は未確認**: `vault.create_secret`／`update_secret` の EXECUTE、`vault.secrets` の直接の UPDATE を持つ役割、管理画面から secret を編集できるか。いずれも確認していない（読み取りの監査が要る）。
- **試験の世界の Vault**（`social_mobile_account_deletion_fixture.sql` 21・31行）は `id` と `secret` だけの偽物で、暗号化も `updated_at` も無い。版の確認の試験には、模型の拡張が要る。

## 2. F2 が起きる条件と、A＋C＋④ で残る理由
- 起きる条件: claim から rotate までの間に、その Vault の secret の中身が、custody も binding も state の消費も伴わずに変わる。
- A（custody の書き込み）・C（binding）・④（state の消費）は、どれもその変化を見ない。rotate は claim の版のまま通り、H5 の延長の書き込みが、その変化を古い系統で上書きする（G4-29・G4-31 の F2 で実測）。
- **時刻の衝突・時計の step・同じトランザクション**: F2 は時刻を使わずに起きる。A／C／④ も時刻を使わない。時刻に頼る対策（§3 の b1・c1）だけが、これらの弱点を持つ。
- **secret の id の再利用**: `complete` は id を変えずにその場で更新する。そのため、id の比較（rotation の比較交換）では F2 を見分けられない。削除の後の再接続は新しい id を作る（314行）。
- **token の更新の一体性**:
  - `complete` は、Vault の更新とアカウントの行の更新を1つの関数で行う。
  - 延長は、rotate と H5 の Vault の書き込みが同じトランザクションという**約束**だけで、関数としては分かれている（rotation の注記）。

## 3. 対策の比較
| 案 | 内容 | 時刻の衝突・step | 同じトランザクション | 認可の前提 | 担当 |
|---|---|---|---|---|---|
| **(a1) 延長と保存を1つの関数に** | `rotate` の代わりに、比較交換と `vault.update_secret` を1つの文で行う G4 の関数を作る。H5 は新しい token を渡すだけで、Vault を直接書かない | 関係なし | 関係なし | Threads の token の書き手が、リポジトリの中では2つ（入口の中の `complete` とこの関数）になる | G4（H5 は呼び方を変える） |
| (a2) 役割を分ける | transport の役割 T に、Vault の関数と `vault.secrets` の権限を与えない。G4 の関数（definer）だけが書く | — | — | 管理環境の Vault の付与の状態が未確認。custody の書き込みの契約（INVOKER・所有者 = `current_user`）とぶつかる（G4-30 §3②） | G4＋H5＋運用 |
| (b1) `vault.secrets.updated_at` を比べる | claim のときの値をリースに記録し、rotate で比べる | **弱い**（同じマイクロ秒、step） | 弱い | 管理環境の `update_secret` が `updated_at` を何で書くかは未確認 | G4 |
| (b2) `vault.secrets` の行の `xmin` を比べる | 行の版 | 強い | **見分けられない**（claim と同じトランザクションの書き込み） | system column に頼る。論理複製・復元で値が変わる（安全側）。管理環境で読めるかは未確認 | G4 |
| **(b3／c2) custody に token の要約（digest）を持たせる** | custody の行に、記録した token の sha256（または鍵つきの HMAC）を持たせる。書くのは custody の書き込み（入口の後の 002）と (a1)。claim・rotate・`credential_row`・手での投稿・release は、今の Vault の中身の要約と比べ、違えば「記録が資格情報を表していない」とみなして拒否する（`CUSTODY_UNKNOWN` と同じ扱い） | **関係なし**（中身で比べる） | **関係なし** | SQL で復号して読む（`credential_row` などがすでにしている）。要約は所有者だけの表に置く。token は高いエントロピーなので sha256 で足りるかは、レビューで決める（HMAC にするなら鍵の置き場所） | G4（custody・002・rotation・`credential_row`・投稿の2つの候補） |
| (c1) 監査（時刻） | 正しい書き込みは custody の書き込みと同じトランザクションで起きるので、「Vault の `updated_at` ≦ custody の `recorded_at`」になるはず。これを定期の問い合わせで確かめる | 弱い | 弱い | `updated_at` の振る舞いは未確認 | G4＋運用 |
| (c2) 監査（中身） | (b3) の要約と今の中身の比較を、定期の問い合わせにも使う | 関係なし | 関係なし | 同上 | G4＋運用 |

### 3.1 (a1) と (b3) の組み合わせで残る競合
- (a1) の関数は、アカウントの行を FOR UPDATE で持つ。ほかの正しい書き込み（入口の `complete`）も、アカウントの行を取るので、順に並ぶ。
- **正しくない書き手**（`vault.update_secret` を直接呼ぶもの）は、アカウントの行を取らない。そのため、(a1) が要約を確かめてから自分で Vault を書くまでの間に割り込むと、その書き込みを上書きしうる。
  - 防ぐには、(a1) が `vault.secrets` の行を `FOR UPDATE` で取る。管理環境でその権限があるかは**未確認**。
  - 取れない場合、この窓は残る。ただし上書きの後は、custody の要約が (a1) の新しい token と一致するので、古い系統の「復活」ではなく、正しくない書き込みが捨てられる結果になる。
- (b3) は、claim の後の正しくない書き込みを rotate で拒否し、claim の前の書き込みを claim で拒否する。どちらも、その資格情報は再接続まで使えなくなる（安全側）。

### 3.2 推奨（設計の案。採用は担当ちゃとレビューの判断）
1. **(b3／c2) custody の token の要約**を主な対策にする。時刻にも、同じトランザクションにも、secret の id の再利用にも依らない。読む側すべてで同じ判定にする。
2. **(a1) 延長と保存を1つの関数に**して、H5 の別の Vault の書き込みをなくす（書き手を2つに絞る）。
3. (c1)・(c2) を運用の監査にする。
4. (a2) 役割の分離は、管理環境の Vault の付与の監査の後の長期の課題。
5. (b1)・(b2) は、(b3) を採らない場合の次善の策（弱点つき）。

## 4. 他の枠とのインターフェース、変更の担当、適用と rollback の順
| 担当 | 変えること | 状態 |
|---|---|---|
| **G4** | custody の表に要約の列を足す（custody の候補）。002 の書き込みで要約を書く（002 の置き換えが要る。H5 の `custody_port.ts` が確かめる形（INVOKER・void・search_path・ACL）は保つ）。rotation（A・C・④ の本体）、(a1) の関数、`credential_row`（PR #412）、手での投稿と release の2つの候補の読み出しに要約の照合を足す。監査の問い合わせを作る | 次の隔離 QA で |
| **H5**（#332、idle。割り当てない） | 延長の store port で、rotate ＋ 自分の Vault の書き込みの代わりに (a1) を呼ぶ。token は claim と同じトランザクションで読む。拒否の後に token を持ち越さない。接続は入口の経由にし、claims は JSON だけにする（G4-30） | G4-19 の COORDINATION（6329598815）は未回答。重複を避け、今回は投稿しない |
| **G3** | 007 の世代は custody の `{secret, expires, recorded}` を hash し、要約は入らない。F2 があっても世代は変わらないが、`credential_row` が要約の不一致で行を返さなくなるので安全側になる。世代に要約を入れるかは G3 の判断 | 連絡は採用が決まったら1回だけ |
| **G5** | 変更は要らない（T-1 の JSON の claims、F5 の判断は同じ）。G5 の投稿者だけの認証の簡素化の調査（6353893007）の結果で、作業場所の条件が変わる可能性がある | 情報のみ |
| 運用 | 管理環境の Vault の権限・`updated_at`・管理画面からの編集の可否の、読み取りの監査（G5-18 の門を参照） | 未着手 |

- **適用の順（案）**: custody の要約の列 → 002 の置き換え（要約を書く）→ 既存の行の要約の扱い → rotation の A・C・④ → (a1) → 読む側（`credential_row`、投稿の2つ）の照合 → 監査。
  - 既存の行の要約の扱い: 適用のときに所有者が今の Vault から計算するか、NULL を「不明」として再接続を求めるか。決定が要る。
- **rollback**: 逆の順。読む側の照合を先に外し、最後に列を消す。要約の列が無いのに照合が残ると、読む側がすべて拒否になる（安全側）。

## 5. 次の隔離 PG17 の TASK 用の試験の計画（このTASKでは NOT_RUN）
- **模型**: 偽の Vault に `updated_at`（`update_secret` で `now()`）を足す。暗号化は模型の外として明記する。
- **正**:
  - 接続 → claim → (a1) で延長 → 要約が新しい token と一致し、`credential_row` が新しい token を渡す
  - 再接続の後の新しい claim
  - A＋C＋④ の既存の試験（R1〜R7b、N1〜N5、B1〜B8、P1〜P9）が変わらない
- **F2 の負**:
  - claim の後に Vault をその場で書き換える → rotate が拒否、`credential_row` も0行
  - claim の前に書き換える → claim が拒否
  - 同じ中身に書き換える（害なし）→ 通ることを記録
  - 同じトランザクション・同じ `now()` での書き換え → (b3) は拒否、(b1)・(b2) は見逃す（比較の証拠）
- **旧い系統の復活**: G4-29・G4-31 の F2 の手順で、古い系統の token が渡されないこと
- **ACL・役割の誤設定**:
  - 要約の列が API の役割から読めない
  - 所有者でない役割が (a1) を呼べない
  - 投稿の2つの候補と `credential_row` の照合が抜けた mutant を検出する
- **競合**: (a1) と入口の再接続、(a1) と Vault の直接の更新（`vault.secrets` の FOR UPDATE がある場合・無い場合）、デッドロック
- **rollback**: 正しい順・誤った順（照合が残り、列が無い → 安全側の拒否）
- **mutant**:
  - 要約を比べない
  - 要約を古い token で書く
  - 一部の読む側だけ照合する
  - (a1) が要約を更新しない
  - 要約が NULL のときに通す
- **監査の検出**: (c1)・(c2) の問い合わせが、Vault の直接の更新を1件として見つける

## 6. 独立のレビューの項目（F2）
1. §1 の経路の一覧が完全か（リポジトリの外の書き手、管理画面、Supabase の内部の処理）
2. 管理環境の Vault の付与（`create_secret`・`update_secret`・`vault.secrets`）と、所有者・transport の役割
3. 要約に sha256 を使ってよいか、HMAC が要るか（鍵の置き場所）。要約の列の ACL
4. SQL で復号して読む範囲を広げること（`credential_row` などはすでにしている）
5. (a1) で、H5 が token を SQL の引数として渡すこと（ログ・statement の記録に残らないか）
6. (a1) と `vault.secrets` の行のロック（権限の有無）と、残る競合の窓（§3.1）
7. 読む側すべてで判定が同じであること（3つの読み出し）
8. 既存の行の要約の扱い（計算するか、再接続を求めるか）
9. 時刻に頼る (b1)・(c1) を採る場合の弱点の受け入れ
10. G3 の世代に要約を入れるか
11. 適用と rollback の順、誤った順での安全側の失敗
12. A＋C＋④＋F2 の対策の全体で、拒否の code が監査上どう区別されるか

## 7. NOT_RUN／NOT_VERIFIED
- この TASK の SQL・DB の試験すべて（docs だけ）。§2・§3 の判定は source からの推論。
- 管理環境の Vault の権限・`updated_at`・行のロックの権限、管理画面での編集
- X の `complete` を Threads の state で呼んだ場合の実測
- H5 の延長の worker（まだ無い）、本物の Supabase・Auth・Vault・Meta、本番
