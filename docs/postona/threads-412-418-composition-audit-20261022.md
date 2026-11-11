# G4-23：Threads の PR #412（資格情報の期限）と PR #418（custody の接続の証明）を合わせるときの依存の監査（読み取りだけ、2026-10-22 JST）

- task_id: `postona-g4-threads-expiry-custody-composition-readonly-audit-20261022`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定: **READ_ONLY_AUDIT／PRODUCTION_NO_GO**。
  - コード・SQL・migration・権限は変えていない。
  - 隔離した PG17 での検証は、このあとの専用の TASK で行う。
  - **それぞれの PR の PASS は、合わせたときの PASS ではない**。
- 対象（読み取りだけ。どの head も変えていない）:
  - PR #412 `b83a7a92524a8862fe0a291d54a364fe15d8048d`。#377 `afab36d977bbc5588f4dce283bd5f05521b41733` の上、さらに #373 の上。
  - PR #418 `771600a09579f461740fde4ddccb5add279c9591`。#405 `80667ffb788836722eb8d98190eaa874e6d5acc4` の上、さらに #388 と #367 の上。
  - PR #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`
  - G5 PR #358 `4f4ece89…`・#371 `7140e416…`・#399 `e363c708bcb331abccc0eb51d8b2229936c87ef6`
  - G3 PR #374〜#392
  - H5 の `owner_transport.ts`
- 共通の祖先は PR #364 `6fe75405`。

根拠の印: **[S]** ソース（ファイル:行）／**[U]** 未確認。

## 1. 2つの積み重ねの違い（静的な差分）
| 項目 | PR #412 の側（#364→#373→#377→#412） | PR #418 の側（#364→#367→#388→#405→#418） |
|---|---|---|
| 変えたファイル | TS（`threads_account_binding.ts`・`threads_send_port.ts`・`threads_connect_to_send.ts` とその試験。#373 の共通のキー）、`postona_threads_credential_atomic/001`・rollback、その試験と runner、docs | `postona_threads_binding_epoch/001`・rollback・**002**・002 の rollback、その試験（behavior・custody behavior・collision.mjs・runner）、docs |
| **両方で変えたファイル** | **無い**（文字の上では、衝突なく合わせられる）[S] | |
| 共通の候補の版 | custody の候補 `threads_credential_custody_candidate.sql` は blob `8adcac7a`、PR #124 の候補は blob `7e7fce8b`。**どちらも両方の側で同じ** [S] | 同じ |
| binding の 001 | 自分では持たない。試験の世界に **PR #367 の 001（`fd714505`）を重ねる**（`postona_threads_credential_atomic_run.sh:43,82,147`）[S] | **G4-16 の版**（blob `99df19d6`）: 入口 `complete_and_attest_binding`、`connect_proof`、単独の `attest_binding` は無い [S] |

## 2. SQL の依存（合わせたときに成り立つか）
### 2.1 `credential_row`（PR #412）が読むもの
- 読むのは表 `postona_threads_binding.bindings` の列だけ（`social_account_id`・`brand_id`・`threads_user_id`・`bound_by`・`owner_epoch`・`lifecycle_version`）[S（`001_threads_credential_atomic.sql:100-117`）]。
  - **PR #418 の版の bindings にも、すべてある**（`connect_proof` の列が増えただけ）。依存は成り立つ。
- `attest_binding`・`record_state_generation`・入口は呼ばない [S]。
- 適用の前の確認（`:79-80`）: 4つの依存の関数が、同じ owner で STABLE であること。呼ぶたびにも同じ確認をする（`:104-110`）。
  - G5 W1 `private.account_lifecycle_worker_brand_verdict(text,text,bigint,bigint)`: 最新の G5 PR #399 でも、同じ引数・STABLE・SECURITY DEFINER [S]。ただし、**`set row_security = off` が足されている**。PR #412 の確認は provolatile と owner だけなので通る見込み。実測は [U]。
  - G3 の世代 `postona_threads_resv.threads_credential_generation(text)`: G3 PR #374〜#392 で、本体の sha256 `46e4dc3aeba8`・STABLE が同じ [S]。
  - custody の読み取り口 `public.threads_account_credential_expires_at(text)`: 002 は書き込み関数だけを入れ替え、**読み取り口は変えない** [S]。
  - G5 の brand owner `private.account_lifecycle_brand_owner(text)`: 変化なし。
- その他: READ COMMITTED のときだけ行を返す（`:104`）。期限は `clock_timestamp()` と比べる（`:118`）。

### 2.2 PR #418 の側が求めるもの
- 001（G4-16 の版）:
  - PR #124 の complete の本体の md5 を固定（`8c90c72f…`）し、所有者だけであることを求める（`:115`・`:122`）[S]。PR #124 の候補の blob は両方の側で同じなので、合う。
  - スキーマの関数はちょうど3つ（`:346`）。PR #412 は自分のスキーマ `postona_threads_credential` に作るので、衝突しない。
- 002: 001（`connect_proof` の列と、入口が設定を置くこと）と、custody の候補の元の書き込み関数（md5 `eb58930b…`）を求める [S]。custody の候補は両方の側で同じなので、合う。

### 2.3 合わせると**壊れるもの**（試験と、他の持ち主の準備）
| 対象 | 何が壊れるか | 直す側 |
|---|---|---|
| PR #412 の runner（`postona_threads_credential_atomic_run.sh`） | PR #367 の 001 を `overlay` で重ねる（`:82`）。合わせた木にはその path があるので、「ownership overlap」で止まる [S] | G4（統合の TASK） |
| PR #412 の behavior の `tc.connect_all` | `complete`（PR #124）→ `attest_binding` → custody の順で呼ぶ（`postona_threads_credential_atomic_behavior.sql:61-70`）。#418 の世界では、`attest_binding` が無い。custody の書き込みも、証明が無いので拒否される（C3）[S] | G4 |
| G3 PR #382 の E2E（`postona_threads_g4_credential_run.sh`・`tests/g4_connect_people.sql:58`） | G4 PR #377 の木を前提にし、`attest_binding` で接続を作る [S]。合わせた後は、入口と custody を同じトランザクションで呼ぶ形にする必要がある | **G3**（今は idle） |
| H5 の owner transport | PR #124 の complete を直接呼び、そのあと custody を呼ぶ [S]。合わせた後は、入口が無いので結び付けが作られず、custody も拒否される。claims も JSON と個別の両方を置いていて、G5 の T-1 と食い違う | **H5**（#332 で依頼済み、未回答） |

## 3. 適用の順序と rollback の順序（統合の世界。将来、各段階で承認と独立のレビューが要る）
**適用**
1. 土台:
   - G5 の lifecycle の鎖（T13 `20261010051938` を含む、PR #178 系統）
   - F5 PR #303 の owner epoch
   - 2a-2（`20261007150000`）
   - X のオンボーディングの表、membership
   - PR #124 の候補（所有者だけ。attestation の鍵）
2. G5 の R1／W1（最新の受け入れ版。PR #399 は H1 PASS）
3. G4 の custody の候補（`threads_credential_custody_candidate.sql`）
4. G4 の binding 001（PR #418 の版）
5. G4 002（custody の接続の証明）
6. G3 の世代の関数（007、F3 の 001〜006 と一緒。G3 の持ち物）
7. G4 の `credential_row`（PR #412）
8. H5 の runtime の SQL（`claim_candidate.sql`）。そのあと transport のコードの差し替え（G4-19 の §4 の 6、JSON だけの claims）

**rollback**（逆の順）
- **7（credential_row）を先に**戻す。
  - 理由: `credential_row` は文字列の本体を持つ SQL の関数で、表への依存が記録されない [S（`language sql volatile`、`:93`）]。
  - 001 を先に消すと（`drop schema … cascade`）、`credential_row` は残ったまま、呼ぶたびに「表が無い」というエラーになる。行は返さないので fail-closed だが、静かではない。
- **5（002）は 4（001）より先に**戻す（002 の rollback が、元の書き込み関数を戻す）。
- 3 の custody の候補は、4・5 の後に戻す。

## 4. fail-closed と未確認のチェックリスト（統合の TASK の受け入れ）
| 項目 | 期待 | 根拠 | 状態 |
|---|---|---|---|
| 期限（PR #412） | `clock_timestamp()` での厳密な比較。REPEATABLE READ・SERIALIZABLE では行なし。依存が VOLATILE になれば行なし | `:104`・`:110`・`:118` [S] | 単独では PASS（G4-15）。統合では [U] |
| custody の証明（PR #418） | 入口が同じトランザクションで置いた証明が無ければ、custody を拒否する | 002 [S] | 単独では PASS（G4-16）。統合では [U] |
| 入口の所有者だけ（PR #405） | PR #124 の complete に所有者以外の実行権があれば、入口も適用も拒否する | 001 `:115`・`:122` [S] | 単独では PASS。**PR #124 の有効化の計画と衝突**（G4-19 の案 C で、付与しない方針を提案中） |
| `credential_row` が新しい接続で行を返す | 入口＋custody（同じトランザクション）の後に、ちょうど1行 | — | **統合で未検証** |
| `credential_row` が古い接続の結び付けを返さない | 再接続の後は、新しい state の結び付けと、新しい custody | — | 統合で未検証 |
| complete だけを直接呼んだ後 | 結び付けも custody も無いので、`credential_row` は行なし | G4-14 の 7c、G4-16 の C3 [S] | 統合で未検証 |
| 入れ替え（延長）の CAS | custody の `recorded_at`（`now()`）を版として比べる | rotation の候補 [S] | 同じ種類の観察として残す（G4-16）。未検証 |
| rollback の順序 | §3 の順なら、エラーなく戻る。順を間違えたら、行を返さずにエラーになる | §3 | 未検証 |
| 依存の DDL の変化 | 4つの依存のどれかが VOLATILE になれば、行なし | PR #412 [S] | 単独では PASS |
| 分離レベル | 呼び出し側（G3 の配信・H5）は READ COMMITTED | PR #412 `:104`、G5 T13 も同じ | G3 の側の呼び出しは [U] |

## 5. 責任の境界と、返答の状況
| 担当 | 中身 | 状態 |
|---|---|---|
| G4 | 統合の runner（PR #412 の世界を PR #418 の世界に置き換える。`tc.connect_all` を、入口＋custody の同じトランザクションにする）、§4 の確かめ、rollback の順の試験 | 次の専用の TASK |
| G5 | R0／R1／T13 は回答済み（#319 6330351455）。owner transport の claims は JSON だけ（`request.jwt.claims` に `sub`・`role`・`session_id`・`is_anonymous: false`）。X の T13 のロックの方針（#320 6331312443）は**未回答** | 一部回答済み |
| H5 | transport の差し替え（begin に R1 ＋ `record_state_generation`、complete を入口に、custody を同じトランザクションで、claims を JSON だけに）。#332 で依頼済み | **未回答**（H5 の Issue は idle） |
| G3 | 世代の関数（STABLE のまま）、PR #382 の E2E の準備を、入口＋custody に合わせること、`credential_row` を READ COMMITTED で呼ぶこと、worker への付与（別の段階） | **連絡はまだしていない**（G3 は今 idle。統合の TASK を始めるときに1回だけ連絡する案）。既存の COORDINATION と重ならないように、今回は投稿しない |
| ユーザー | Issue #131（X の B3）は延期のまま。PR #124 の有効化の方針、Vault の鍵、本番への適用 | 未確定 |

## 6. 次の専用の TASK の実行の条件と、独立のレビューの項目
- **実行の条件**:
  - G4 専用の worktree と、PR #418 の上に積んだ branch。
  - 隔離した PG17。G5 の最新の受け入れ版（PR #399）と、G3 の世代（PR #374 の版、本体 `46e4dc3aeba8`）を、読み取りだけで重ねる。
  - 偽の Vault・偽の token。外部への通信は0。
  - H5 の transport は、模擬の関数で代わりに動かす（H5 のコードは変えない）。
- **作る試験**:
  - §4 の表の、統合で未検証の行すべて。
  - rollback の順（正しい順・誤った順）。
  - わざと欠陥を入れて検出できるか（入口を外す、証明を外す、期限の時計を `now()` に戻す、分離レベルの確認を外す）。
- **独立のレビューの項目**:
  - 統合の適用と rollback の順。
  - ACL が所有者だけであること（`credential_row`・入口・custody・binding）。
  - PR #124 の有効化をしないこと。
  - H5 の claims（JSON だけ）。
  - G3 の呼び出しの分離レベル。
  - W1 の `row_security = off` の影響。
  - rotation の CAS の版。

## 7. 未解決のまま守っていること
- H5 の返答（transport、JSON だけの claims）
- G5 の T13 のロックの方針（X）
- PR #124 の有効化と PR #405 の衝突（案 C の合意待ち）
- PR #412・#418・#405 の独立のセキュリティのレビュー（H2 の Codex は停止中。Claude の代理の結果は承認ではない）
- Issue #131（X の B3）はユーザーの延期のまま。再開していない
- Supabase Data API の 10/27 の持ち主の合意（G3 は未回答）
