# G4／F4：Threads の接続から投稿結果の確認まで — 実装と未接続の棚卸し（2026-10-19 JST）

- task_id: `postona-g4-threads-end-to-end-gap-inventory-source-20261019`（Issue #324。`.agent_v2` の F4 には登録しない。main の F4 TASK／ACTIVE は変えていない）
- 返却先: POSTONA｜マルチSNS化・開発統括（G4）のちゃ／完了コード L4
- 判定: **SOURCE_ONLY_INVENTORY**。本番の状態は確かめていない（NOT_VERIFIED）。
- 調べた版:
  - Threads の積み上げの先頭 = PR263 の head `a1cc77e4cb3b09b0775a7e60c2c76fecd18f3705`（124→…→180→251→255→258→263 をすべて含む）
  - origin/main = `65fa7319f522fb012f4f88f9b1b155531b30cdbd`
- 重複していないこと: PR #287（X の owner epoch）と F3 PR #301（X の結果・受領票）には触れていない。Meta のコールバックの実装は、どのブランチにも無い（`signed_request`／deauthorize／data deletion を検索して、言及の3か所だけ）。

## 1. いちばん大事な事実
1. **main にある Threads のソースは `threads_connect_contract.ts`（型と契約）だけ**。Edge 関数・アプリの画面・SQL の候補は、すべて未マージの Draft PR の積み上げの中にある。
   - 本番の DB・Edge の状態は確かめていない。2a-2 の migration（`20261007150000_postona_social_accounts_multi_provider.sql`）が本番に適用済みかも NOT_VERIFIED。
2. 積み上げの中のコードは、どれも**固定の false のゲート**で止まっている。環境変数だけでは開かない。
3. **完全に無いもの**:
   - Meta の deauthorize／data deletion のコールバック（Meta のアプリ設定に URL が必要。接続の前提 `META_APP_CONFIGURED` の一部）
   - Threads の予約投稿の dispatcher（F3 の予約は X だけ）
   - トークン延長の store と scheduler
4. 投稿の結果の確認は、手動の投稿の中だけで閉じている（2段階の投稿 → 読み戻し）。不明な結果の扱いは、手動の投稿の台帳の候補にある。

## 2. 証拠表
記号: ✅ 実装あり／🔒 ゲートで停止／✖ 無い・未接続／🧪 ローカルで試験済み／❔ 本番 NOT_VERIFIED

| 部品 | 実際のパス（PR263 の先頭） | 状態 | 担当 | G4 だけでできる最初の変更 |
|---|---|---|---|---|
| OAuth の開始と callback（Edge） | `supabase/functions/threads-oauth-connect-user/index.ts` → `_shared/social/threads_connect_entry.ts`（`createThreadsConnectEntry`）、`_shared/social/threads_connect_edge.ts` | ✅🔒（`THREADS_CONNECT_EDGE_WIRED = false`［25行目］＋ env `THREADS_CONNECT_ENABLED`）🧪❔ | G4（入口）／H5（認証済みの runtime の合成） | 無し。H5 の合成（`supabase/candidates/postona_threads_auth_runtime/wiring/`）が配備できないため、G4 の入口だけ開いても動かない |
| 認証済みの runtime（呼び手の確認・state・PKCE） | `supabase/candidates/postona_threads_auth_runtime/`（`runtime.ts`、`verified_actor.ts`、`claim_candidate.sql`） | ✅（候補）🧪❔ | H5 | 無し（H5 の port） |
| iOS の戻り（HTTPS） | `apps/social-mobile/src/features/threads-connect/threads-connect-starter.ts`、`tests/threads-connect-ios-return.test.mjs` | ✅ ソース／✖ `app.json` に associatedDomains・本物の callback が無い（運用の手順） | G4 | 無し（ドメインと AASA は運用者の手順） |
| Android の戻り | PR260（DEFAULT＋BROWSABLE、port の明示は不可） | ✅（別の PR）／✖ `app.json` の intent filter は未設定 | G4 | PR260 の J2 のレビュー待ち |
| アカウントの結び付けと、ユーザー・作業場所の権限 | `supabase/candidates/postona_threads_oauth_workspace_candidate.sql`、`_shared/social/threads_connect_rpc_contract.ts`、F5 の lifecycle（PR178／193） | ✅（候補 SQL、未適用）🧪（`postona_threads_oauth_run.sh`、`postona_threads_t13_run.sh`）❔ | G4／G5（owner の fence） | 無し（PR169 の T13 の writer guard が G5 の本物の上で済） |
| トークンの保管（Vault） | `supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql` | ✅（候補、未適用）🧪❔ | G4 | 無し |
| トークンの延長（リースと比較交換） | `threads_credential_rotation_candidate.sql`（PR258／263）、`_shared/social/threads_token_refresh.ts`（PR255 の coordinator） | 🔒（`THREADS_TOKEN_REFRESH_ENABLED = false`［14行目］）。**✖ store の実装と scheduler が無い** 🧪（SQL の CAS は `postona_threads_rotation_run.sh`）❔ | G4 | 次の作業 T3 |
| 接続の解除 | `supabase/functions/social-mobile-threads-disconnect/`、`_shared/social/threads_disconnect.ts`、`supabase/candidates/postona_threads_disconnect/threads_disconnect_candidate.sql` | ✅🔒（`THREADS_DISCONNECT_SERVER_ENABLED = false`［28行目］＋ SQL `threads_disconnect_gate_open()` が false［96行目］）🧪❔ | G4 | 無し |
| サービスの退会と後片付け | `supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql`（PR180 の live lease）、F5 PR178（終了の所有）、H5 `deletion_contract.ts`（受け渡しの形だけ） | ✅（候補）🧪（`postona_threads_cleanup_run.sh`）❔ | G5（T10 の worker）／G4（Threads の後片付け） | 無し |
| **Meta の deauthorize／data deletion のコールバック** | **無い**。言及は `threads_connect_contract.ts:55`、`threads_disconnect.ts:15`、`threads_disconnect_candidate.sql:32` だけ | **✖** | G4（受け口）／G5（削除の実行） | **この PR の契約テスト**（§3）→ 次の作業 T1 |
| 手動の投稿 | `supabase/functions/social-mobile-threads-publish/{index,http,logic}.ts`、`threads_manual_publish_candidate.sql`、`threads_publish_release_candidate.sql` | ✅🔒（`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET = false`［`logic.ts` 45行目］。前提8つ）🧪❔ | G4 | 無し（前提8つは運用と承認） |
| アプリの画面（接続・解除・投稿） | `apps/social-mobile/src/features/threads-{connect,disconnect,publish}/`。カードは `src/app/accounts/index.tsx`・`[id].tsx` に組み込み済み | ✅🔒（`THREADS_CONNECT_UI_ENABLED`／`THREADS_DISCONNECT_UI_ENABLED`／`THREADS_MANUAL_PUBLISH_UI_ENABLED` がすべて false）❔ | G4 | 無し |
| 予約投稿の dispatcher | **無い**。F3 の予約（`001_postona_x_reservations.sql`）は platform `'x'` だけ | **✖** | G3（dispatcher の持ち主）／G4（Threads の送信の口） | G3 の判断待ち。G4 は手動の投稿の口を流用できる形にしておく |
| 状態・受領票・不明な結果 | 手動の投稿の中で2段階の投稿 → 読み戻し。不明は台帳（`threads_publish_release_candidate.sql`）。予約側は X だけ（F3 PR301 は X） | ✅（手動のみ）🧪❔／✖（予約） | G4（手動）／G3（予約） | 予約が決まるまで無し |

- 手動の投稿の前提8つ（`logic.ts`）:
  - `PHASE_2A2_MIGRATION_APPLIED`
  - `THREADS_CONNECT_RUNTIME_LIVE`
  - `COMMON_ACCOUNT_WRITER_FENCE_LIVE`
  - `PUBLISH_LEDGER_APPLIED`
  - `PUBLISH_ATTESTATION_KEY_PROVISIONED`
  - `META_APP_PUBLISH_READY`
  - `INTEGRATED_SECURITY_REVIEW`
  - `PILOT_APPROVED`

## 3. この PR で足したもの（G4 だけ、テストのみ）
`supabase/tests/postona_threads_meta_callback_contract_test.ts`
- Meta の2つのコールバックの**契約**（`metaCallbackViolations`）。将来の受け口が満たすべきこと:

  | 番号 | 求めること |
  |---|---|
  | M1 | 署名の偽造・別の鍵・algorithm が HMAC-SHA256 以外・形の壊れ・user_id が無いか変な形・GET を拒否し、何も変えない |
  | M2 | deauthorize で、その人のアカウントだけが止まる（再接続が要る）。応答に user_id や鍵を出さない |
  | M3 | data deletion の応答は `{ url, confirmation_code }` だけ。code は英数字、url は https で code を含み、user_id を含まない |
  | M4 | 同じ依頼には同じ code。知らない人にも同じ形で答える（存在を漏らさない） |
  | M5 | 外への通信は0回。Threads にはアプリ側の取り消しが無いので、記録するだけ |

- テスト専用の参照の handler で「満たせる」ことを、壊した handler 7種（署名の確認なし・user_id の漏れ・存在の漏れ・外への通信・algorithm の確認なし・deauthorize の無視・毎回別の code）で「検出できる」ことを確かめた。
- **仮定（Threads では確かめていない）**:
  - Meta の一般の data deletion の文書の `signed_request` の形（HMAC-SHA256、`algorithm`／`issued_at`／`user_id`、応答 `{url, confirmation_code}`）を、Threads の2つのコールバックにも当てはめた。
  - Threads の「create an app」の文書は、2つの URL の設定欄を示すが、要求の形と user_id の種類は書いていない。
  - 実際の handler を信用する前に、本番ではない Meta のアプリで本物の呼び出しを確かめる必要がある。
- 実行に要る権限は無い（ネット・env・書き込みを許していない。偽の鍵だけ）。

## 4. 次の作業（実装の大きさ、優先の順）

### T1（G4）: Meta のコールバックの Edge の候補（ゲート OFF、未配備）
- 許可するパス（新しいものだけ）:
  - `supabase/functions/threads-meta-callbacks/{index,http}.ts` と `http_test.ts`
  - `supabase/functions/_shared/social/threads_meta_callback.ts` と `_test.ts`
- 内容:
  - §3 の契約を満たす handler。store は port だけ（DB の実装なし）。
  - 固定のゲート `THREADS_META_CALLBACKS_ENABLED = false`。
  - アプリの秘密は env の名前だけで、値は持たない。
  - `metaCallbackViolations` を import して合格させる。
- 前提: 無し（ソースだけ）。本物で使うには、Meta のアプリの設定、本番ではない環境での本物の呼び出しの形の確認、ユーザーの承認が要る。

### T2（G4、G5 の同意つき）: コールバックの store の SQL 候補（未適用）と PG17 テスト
- 許可するパス:
  - `supabase/candidates/postona_threads_meta_callbacks/meta_callbacks_candidate.sql`
  - `supabase/tests/postona_threads_meta_callbacks_{run.sh,behavior.sql,fixture.sql}`
- 内容:
  - deauthorize: PR167／169 の解除の規則で `social_accounts` を止め、Vault の資格情報を使えなくする。
  - data deletion: 依頼の台帳（code は一意、同じ依頼は同じ code）と、PR180 の lease つきの後片付けへの受け渡し。
- 前提:
  - PR167／169／180 の積み上げ。
  - G5 の T10（サービスの削除の実行）の持ち主の同意。データ削除が G5 の削除の経路に入るかの判断が要る。

### T3（G4）: トークンの延長の store の実装（ゲート OFF）
- 許可するパス:
  - `supabase/functions/_shared/social/threads_token_refresh_store.ts` と `_test.ts`
  - 必要なら `supabase/candidates/postona_threads_publish/` に、延長の呼び出しの SQL を追加（新しいファイル）。
- 内容: PR255 の coordinator の store を、PR258／263 のリースと比較交換の上に作る。scheduler は作らない（cron は別の承認）。
- 前提: PR258／263 の J2 のレビューを通すこと。

### 参考（G4 の外）
- Threads の予約投稿は、G3 が F3 の予約を platform で一般化するかの判断が先。
- iOS・Android の戻りのドメイン、Meta のアプリの設定、migration の適用は、運用者とユーザーの承認の手順。

## 5. テスト（このブランチ、未コミットの変更0で実行）
| 実行したもの | 結果 |
|---|---|
| `deno test --no-config --cached-only --no-check --allow-read=.`：Threads の TS 単体（`_shared/social/threads_*_test.ts` のうち entry_composition を除く、3つの Edge の http／logic、`postona_threads_edge` の2つ、`postona_threads_auth_runtime/runtime_test.ts`、新しい契約テスト） | **216 passed／0 failed** |
| `deno test --cached-only --config supabase/candidates/postona_threads_auth_runtime/wiring/deno.json --allow-read=supabase`：entry_composition と H5 の connector | **17 passed／0 failed** |
| 新しい契約テストだけ（権限なし） | **5 passed／0 failed**。`deno lint` エラー0 |

- 注記:
  - entry_composition を H5 の config なしで実行すると1件が失敗する（`AUTH_REQUIRED` を期待したが `THREADS_CONNECT_RUNTIME_UNAVAILABLE`）。ファイルの先頭に書かれた実行方法（H5 の config）では合格する。不具合ではない。
  - SQL の実行スクリプト（`postona_threads_*_run.sh`）は今回は実行していない。各 PR の Report の結果に頼っている。
  - アプリの `node --test`（`apps/social-mobile/tests/threads-*.test.mjs`）は、この worktree に node_modules が無いため NOT_RUN。
- 送信: 外への通信0回（ネットの権限なし）。Meta・Threads・Supabase への呼び出しなし。

## 6. 行っていないこと
- 本番・管理環境の DB、migration の適用、権限の付与、Edge の配備、Vault、秘密
- 本物の Meta・OAuth・トークン・Threads への投稿
- ゲートを開くこと
- main への push（TASK の登録・archive を含む）、マージ、force push
- ほかの枠（H5／G5／G3）のファイルの変更
