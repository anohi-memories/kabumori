# G4-48：X・Threads の接続を、製品の実際の経路で通す（2026-10-28 JST）

- task_id: `postona-g4-personal-mvp-x-threads-oauth-real-product-flow-integration-20261028`（G4 の固定 Issue #319）
- 返却先: POSTONA G4 担当ちゃ（Issue #319）／完了コード K4／`next_task_allowed: false`
- 判定:
  - **X は、製品のコードの経路で、つないで通した（非本番）**
  - **Threads は、製品に経路が無い**
  - **PRODUCT_NOT_DEPLOYED**: 製品にはまだ出していない
  - **PRODUCTION_NO_GO**: 本番には出せない
- 土台: PR #547（`37958f527cf6d65661e483a3237b836020ff6f64`）。main は `0ac62659`（この経路の file は、stack の土台から変わっていない）。

## 1. 経路の各段の状態
| 段 | X | Threads |
|---|---|---|
| 画面のボタン（接続・再接続） | **ある**（`app/accounts/index.tsx`・`onboarding-gate.tsx`、G1・G2） | **無い** |
| 切断のボタン | 無い（G1・G2）。hook の `disconnect()` はある（#517・#533） | 無い |
| アプリの hook | `use-x-connect.ts`（main と、G4 の候補 #517・#522・#533） | **無い** |
| Edge | `x-oauth-connect-user`（main。G4 の候補 #517・#523・#545・#547） | **無い**（H5 の transport と、オフラインの Edge の候補だけ） |
| SQL の begin・consume・complete | main（**今は T13 が無い**）。G4 の候補 001〜005（未適用） | PR #124 と G4 の entry の候補だけ（未採用） |
| G5 の判定（T13・S2-2・S2-3・owner epoch） | G5 の migration 候補（#539→#543、未適用） | 同じ。加えて H5 の `is_anonymous` が要る |

## 2. 非本番の通し試験（`supabase/tests/postona_g4_x_oauth_app_flow_run.sh` と `apps/social-mobile/tests/x-connect-product-flow.e2e.mjs`）
- **本物を使ったもの**:
  - アプリの hook（`use-x-connect.ts` を transpile して実行）
  - `@supabase/supabase-js`
  - **Edge の handler**（`index.ts` を、`Deno.serve`／`Deno.env` の代わりを置いて Node で実行）と `oauth_logic.ts`
  - PostgreSQL 17 の上の本物の SQL（G5-44 と同じ本物の world、lifecycle owner）
- **偽物にしたもの**:
  - X（token、users/me）
  - GoTrue（`/auth/v1/user`）
  - PostgREST（psql の橋。JWT の claims、authenticated／anon の role、SQLSTATE から HTTP への写し方は PostgREST の文書どおり: 42501 は 403／401、42883 は 404、ほかは 400）
  - ブラウザでの X の承認
- **結果**: 2つの mode とも **7/7 PASS**
| 場面 | mode=main（SQL は main のまま） | mode=g4（G4 X 001〜005、切断の門を開けた） |
|---|---|---|
| A が接続する（start → X → callback） | 接続でき、`identity_verified` | 同じ |
| A が再接続する | 接続できる | 接続できる |
| C（POSTONA を始めていない） | **接続できてしまう**（GAP） | X に行く前に拒否。画面は「まだ接続できません」（409） |
| 匿名の session | **始められてしまう**（GAP） | 「ログインし直し」（401） |
| X にいる間に B がログイン | `session_changed`。交換をせず、再読込もしない | 同じ |
| A が切断する | **RPC が無い**（「やり直し」） | `unconnected` になり、1回再読込。そのあと再接続できる |
| A のサービスを終える途中 | **接続できてしまう**（GAP） | 「まだ接続できません」（409） |
- **負の確認**: Edge を #545（403 の分類を直す前）に替えると、mode=g4 で3件 FAIL した（C・匿名・終える途中が「やり直し」になる）。H1 の P2 F1 を、通しの経路でも捕まえられる。
- アプリの `npm test` は 322/322、`tsc` 0 件、`expo lint` exit 0（この e2e は `*.test.mjs` に含まれないので、`npm test` では動かない）。
- **NOT_VERIFIED**: 本物の X の OAuth、本物の GoTrue・PostgREST・managed・RLS・Vault、Edge のデプロイ、実機・画面、本番

## 3. 本物の利用者が使えない理由（優先の順）
1. **SQL と G5 の判定が適用されていない**: G5 の migration（#539→#543）→ G4 の X 001〜005（lifecycle owner）。G5 は PR #457 の P2 も残っている。owner の明示の承認が要る。
2. **Edge のデプロイ**: G4 の Edge の候補（#517・#523・#545・#547）は main の SQL でも動く（code の一覧は main の code を含む）。ただし 401・409 が役に立つのは、SQL を適用した後。
3. **画面（G1・G2）**: 切断のボタン、409 の文言（「サービスが無い」と「作業場所」の区別）。
4. **G3 の T13 wrapper**: 取り下げるかどうか（G4 の 005 と同時には採用できない）。
5. **Threads**: アプリの hook・画面・Edge が製品に無い。PR #124 と H5 の transport が未採用。H5 の `is_anonymous` も要る。G4 の Threads の候補（entry の 001・002）は、その後に使う。

## 4. 依存が解けたら、すぐ行う実際の操作の確かめ
1. 非本番の Supabase に G5 の migration → G4 の X 001〜005 を適用する（読み取りで md5 と owner を確かめてから）。
2. Edge をデプロイし、アプリの開発 build で、自分の X アカウントを接続・再接続する。
3. 切断の門を開け、切断と再接続を行う。
4. POSTONA を始めていない別のアカウントで、「まだ接続できません」が出ることを確かめる。
5. このときも、同じ e2e を本物の GoTrue・PostgREST に向けて、同じ7つの場面を確かめる。
