# G3｜`public.brand_memberships` の Data API 再構築・最小権限のオフライン回帰契約（2026-10-23、Issue #318 TASK 23/50）

- task_id: `postona-g3-data-api-brand-memberships-offline-regression-contract-20261023`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **隔離した模擬テストと docs だけ。**
  - 変えていないもの: migration・製品 SQL・GRANT・ACL・RLS・RPC・Edge。PR #370 の SQL、G5 の L-1 の候補、G4 の Threads・OAuth。
  - 決めていないもの: 共有の migration の持ち主（G3-22 の Q1〜Q7）、PR #370 の A1・A2・B・C、service_role の直接の DML の要否。
  - 本番は NO_GO。
- 変更したファイル（G3 の新しいパスだけ）:
  - `supabase/tests/g3_brand_memberships_data_api_contract/contract_run.sh`（テストのランナー）
  - `supabase/tests/g3_brand_memberships_data_api_contract/contract_delta.sql`（**テスト用の契約の模型**。migration でも候補でもない）
  - この文書

## 1. テストの仕様（期待値と、未承認・未知の条件の分離）
### 世界（表の owner の既定の権限の模型。owner は本番の `postgres` の代わり）
| 世界 | 既定 | 根拠 |
|---|---|---|
| pre | 新しい表に anon・authenticated・service_role へ ALL | 今の模型（G3-20、G5 の文書） |
| postA | 何も付けない | Supabase の changelog（Discussion #45329）の記載 |
| postB | TRUNCATE・REFERENCES・TRIGGER・MAINTAIN だけ | コメントの報告で、未確認（G3-20 §1） |

### 対象
- **R（今の動きの記録。契約ではない）**: 表の migration の DDL（`20260918120000` の 41〜66 行を、変えずに読む）だけで作り直す。
- **C（契約）**: その上に `contract_delta.sql` を当てる。中身は次の 2 文。
  - `revoke all … from public, anon, authenticated, service_role`
  - `grant select … to authenticated`
- **E（既存の表）**: pre で作った表。

### 期待値
| # | 期待 | 区分 |
|---|---|---|
| R | DDL だけでは既定に依る。pre: service_role に 8 つ、authenticated に TRIGGER・TRUNCATE・REFERENCES・MAINTAIN。postA: service_role に何も無い。postB: TRIGGER・TRUNCATE・REFERENCES・MAINTAIN が残る | 記録 |
| C1 | 3 つの世界で ACL が同じ（owner と `authenticated=r` だけ）。anon・service_role に何も無い。PUBLIC の項目 0。列の ACL 0 | 契約 |
| C2 | authenticated は自分の行だけを読める（RLS）。sub の無い呼び出しは 0 行 | 契約 |
| C3 | anon・PUBLIC（何も持たない役割）の SELECT と、authenticated の INSERT は 42501 | 契約（負例） |
| C4 | service_role の SELECT・INSERT・UPDATE・DELETE・TRUNCATE は、どれも 42501 | **未承認の前提**（G3-21: ソースに直接の利用が無い。外の経路 U-1〜U-6 は [U]）。外で利用が見つかったら、この期待を変える前にユーザーの判断が要る |
| C5 | 表の owner の SECURITY DEFINER の書き込み関数（テスト用の模型。service_role には EXECUTE だけ）は、表の権限なしで書ける | 契約 |
| C5n | 同じ本体を INVOKER にすると、service_role では 42501 | 負例。INVOKER の関数を足すなら表の付与が要ることを示す |
| C6 | DEFINER のガードのトリガー（削除のガードの模型）は、書き込み関数の下で動いて止める（P0001） | 契約 |
| C7 | FK の cascade（service_role による brands の削除、Auth の管理役による auth.users の削除）は、子の表の権限なしで行を消す | 契約 |
| C8 | PR #370 の 001（`547d9f92` を `git show` で読む）は、契約の表では `SERVICE_ROLE_DML_LOST` で止まり、何も変えない | 記録（T-2 の依存） |
| E1 | 既定を変えても、既存の表の ACL は変わらない | 記録（changelog の「既存の表は付与を保つ」の模型） |
| E2 | 既存の表に契約を当て、記録した prestate から戻す模型の rollback で、項目の集合が元に戻る。間に別の変更があれば止まる（`G3C_ROLLBACK_MISMATCH`） | 契約（本物の rollback は T-1 で、PR #370 の prestate の形） |
| V | 契約の 2 文は、ddl_command_end のイベントトリガーを 1 文ずつ動かす（REVOKE・GRANT） | 記録（managed のイベントトリガーの差は §3） |

## 2. 実測（使い捨ての PG17.11、ローカルのソケットだけ、偽の役割・偽の行）
- `contract_run.sh` → `G3_BRAND_MEMBERSHIPS_DATA_API_CONTRACT_ALL_PASS`（R、C は 3 つの世界、C1 の一致、E1・E2、V）
- 契約の ACL（3 つの世界で同じ）: `OWNER=arwdDxtm/OWNER,authenticated=r/OWNER`
- 契約の変異（`G3C_CONTRACT` で写しに差し替え）: **9 個のうち 8 個を検出**
  - 検出した 8 個:
    - revoke 無し
    - service_role を revoke しない
    - changelog の例の付与（3 つの役割に select・insert・update・delete）
    - anon に SELECT
    - authenticated の SELECT 無し
    - DML だけの revoke（postB で TRIGGER などが残る）
    - service_role に SELECT
    - 列の REFERENCES
  - 残った 1 個: `public` を revoke しない変異。PostgreSQL の既定では PUBLIC に表の権限が付かず、どの世界でも PUBLIC は空なので結果が変わらない。R-2・R-3 の多重の防御として残す。
- ランナーの作りの注意: 各世界の DB は呼び出しごとに名前を分けた。`$(...)` の中では errexit が効かないので、各段で失敗を確かめる（作業中に、同じ名前の DB の再利用と、psql の失敗の見落としを見つけて直した）。

## 3. 保証の範囲と、確かめていないこと
- 保証するのは、このローカルの模型での ACL と、権限の判定の結果だけ。
- managed（PG17.6・supautils・`supabase_admin` の既定・Supabase のイベントトリガー・PostgREST の再読み込み）は確かめていない。
  - 既定の模型は、表の owner の `alter default privileges` で作った。
  - Supabase の実際の既定が `postgres` 以外の役割（`supabase_admin` など）にも有る場合の動きは [U]。
- postB は未確認の報告の模型。postA と postB のどちらでも契約の ACL は同じになることを確かめた（契約は既定に依らない）。
- C4 の「service_role に表の権限が要らない」は、ソースの調査（G3-21）に基づく前提で、**本番の外の経路（U-1〜U-6）は確かめていない**。
- 書き込み関数・ガードのトリガーは、テスト用の模型。本物の X の接続 RPC・削除のガードの本体ではない（本物も SECURITY DEFINER であることは G3-21 で確認済み）。
- E2 の rollback は期待値の模型。本物の rollback は T-1 で書き、PR #370 の prestate の行の形（DB・OID・sha256・ロック・確保）に合わせる必要がある。

## 4. T-1・T-2 の設計の前提（このテストから）
- T-1（作成の migration の書き直し）:
  - 契約の 2 文（revoke all → authenticated に SELECT だけ）で、pre・postA・postB の全部で同じ ACL になる（C1）。
  - 書き込みの道は、表の owner の DEFINER の関数、トリガー、cascade だけで足りる（C5〜C7）。
- T-2（PR #370 の 001）: 契約の表では今の 001 が止まる（C8）。`SERVICE_ROLE_DML_LOST` を外す変更が要る。T-1 と同時に。
- このランナーは、T-1・T-2 の候補ができたら、`G3C_CONTRACT` に候補の差分を渡す回帰として使える。T-2 の 001 は `G3C_PR370_REV` で差し替える。
- どちらも、持ち主の決定（G3-22 Q1）と PR #370 の方針（Q7）の後に、Codex Sol（高）のレビューとユーザーの承認を経る。

## 5. 再現
```bash
G3C_PGHOST=/private/tmp/<socket> G3C_PGPORT=<port> G3C_PGSUPER=<local superuser> bash supabase/tests/g3_brand_memberships_data_api_contract/contract_run.sh
```
- ローカルの PostgreSQL 17 で実行する。偽の役割 anon・authenticated・service_role・authenticator は、無ければ作る（クラスタ全体なので、1 つずつ実行すること）。
- V の部分だけは、テストの DB の中で superuser がイベントトリガーを作る。
