# POSTONA Threads 接続→許可→投稿→読み戻し 統合 V1（オフライン・ソースのみ・無効）

- TASK: `postona-threads-connect-publish-integrated-offline-v1-g4-20261011`（G4）
- 基準: PR #140 の先頭 `2e75a6a842e70f3de78558681803b60935fb4251` に積む（Draft PR、base は #140 のブランチ）
- 組み合わせた保護対象（読み取り専用・変更なし）: #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`、#135 `e38788d6677082138f0990453c7d2f00549666d0`、#139 `b4fa672f97592e87682671454e868a92098cbd56`
- 判定: **GO_SOURCE_ONLY / BLOCKED_REAL_PILOT**。接続から投稿・読み戻しまでの一連は、実際のソース候補どうしを組み合わせた使い捨て環境で通った。実際の Threads 投稿は、下の「残りの関門」が揃うまでできない。

## 0. 要点

1. **K4 の P1 を直した。** これまでは「呼び出し元の権限確認（claim）」と「サーバー権限でのトークン受け取り（redeem）」が別々で、その間（最大60秒）に利用権の終了・削除開始・管理者からの降格・同意の取り消しがあっても、トークンを受け取れた。今回、**権限の判定とトークンの受け渡しを1つの DB トランザクションにまとめた**（`release`）。Threads への書き込みの直前ごとに、G5 の判定（T13）→本人のセッション→ワークスペース→メンバーシップ→アカウント→トークン期限→手動投稿の許可、をすべて判定し、そのロックを持ったまま、通ったときだけトークンを渡す。
2. **サーバー権限（service_role）の経路をなくした。** 古い `claim` / `redeem` / `record` は削除（取り消しではなく削除）。新しい `release` / `record` は呼び出し元の JWT で動き、さらに**サーバーだけが持つ鍵での証明（HMAC-SHA256）**が必要。アプリ（利用者の端末）は呼べても証明を作れないので、トークンを受け取れず、結果も書き込めない。証明は1回限り（nonce）・60秒以内。PR #124 の接続時の証明と同じ考え方（鍵の名前と文言は別）。
3. **アカウント単位のトークン期限**（`threads_account_credential_custody`）を用意した。接続を確定する**同じトランザクションの中でだけ**記録でき、保存されたトークンそのもの（Vault の id と接続時刻）に結び付く。再接続で記録が更新されなければ「期限不明＝期限切れ」として投稿を止める。H5 側に必要な変更は、完了処理に**1文足すだけ**（§4）。
4. **組み合わせて初めて見つかった不具合を2つ直した。**
   - 個人ワークスペースは、自動投稿がまだ本番でないため「無効・自動投稿停止」の設定で作られる。#140 はこの設定を見て手動投稿を拒否していたので、**実際の利用者は誰も投稿できなかった**。手動投稿の条件を「本人用の POSTONA ワークスペースであること」に改め、自動投稿の設定は見ないようにした。
   - G5 の判定（の候補）は拒否を SQLSTATE `42501` で返す。#140 は `P0001` しか読み分けていなかったので、「利用権が無い」も「ブロック中」にまとめられていた。どちらの SQLSTATE でも固定コードで読み分けるようにした。
5. **画面**: アカウント一覧に「Threadsアカウント接続（準備中）」、Threads アカウントの詳細に「再接続（準備中）」を追加。どちらもリリースフラグ（`THREADS_CONNECT_UI_ENABLED = false`）で無効、押しても何も起きない。コールバックの受け渡しは「登録した HTTPS のコールバック URL をそのまま、本人のセッションでサーバーへ渡すだけ（コード・state をアプリで読まない・保存しない・ログに出さない）」という設計を関数とテストで固定した。
6. **全部のゲートは false のまま。** `THREADS_CONNECT_PREREQUISITES_MET=false`、`THREADS_MANUAL_PUBLISH_PREREQUISITES_MET=false`、`THREADS_MANUAL_PUBLISH_UI_ENABLED=false`、`THREADS_CONNECT_UI_ENABLED=false`。新しい Edge の入口は常に 503。

## 1. 投稿1件の流れ（統合後）

```
アプリ「投稿する」（確認タップ・冪等キー）
 └ Edge（呼び出し元のトークンを Auth サーバーで確認。JWT の中身は読まない）
    ├ begin（呼び出し元 JWT）                       予約。本文をそのまま保存
    ├ release create_container（JWT＋証明）          ← 1トランザクション: 証明→T13→セッション→
    │                                                   ワークスペース/メンバー/アカウント/期限/許可→
    │                                                   nonce→比較更新→Vault→状態を進める＋記録用の許可証
    ├ Threads: POST /threads（1回だけ）
    ├ record（JWT＋証明、同じ本人・同じセッションの許可証）  事実の記録（利用権が途中で終わっても記録はする）
    ├ release check_container → 状態確認
    ├ release publish（もう一度すべて判定）→ POST /threads_publish（1回だけ）→ record
    └ release confirm → 読み戻し → record published（id＋パーマリンク）
```

**閉じていない隙間（主張しないこと）**: release の確定から Threads への HTTP 要求までの間（数ミリ秒、最大でも要求の上限10秒）に起きた変更では、すでに渡した1回の要求は止められない。DB のロックはネットワーク呼び出しをまたげない。次の書き込みには必ず新しい release が必要で、そこで止まる。

## 2. 変更したもの（この Draft PR、すべて G4 の範囲）

| # | 内容 | ファイル |
|---|---|---|
| I1 | 接続→投稿の段階と担当・不足の一覧、H5 の受領票の厳密な読み取り（権限ではない）、H5 の完了トランザクションに足す1文 | `supabase/functions/_shared/social/threads_connect_publish_integration.ts`（＋テスト） |
| I1 | 組み合わせ環境でだけ動く通し検証（SQL・TS） | `supabase/candidates/postona_threads_integration/integration_smoke.{sql,ts}` |
| I2 | P1 の修正（release / record、証明、セッション、service_role 経路の削除、G5 コードの読み分け、ワークスペース条件の修正） | `supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql` |
| I2 | 送信手順・参照モデル・Edge を release に合わせて変更 | `supabase/functions/_shared/social/threads_manual_publish{,_fake,_test}.ts`、`supabase/functions/social-mobile-threads-publish/{http,logic,http_test}.ts` |
| I3 | アカウント単位のトークン期限（保管記録と読み出し口） | `supabase/candidates/postona_threads_publish/threads_credential_custody_candidate.sql` |
| I2/I3 | DB 候補の検証（使い捨て PostgreSQL） | `supabase/tests/postona_threads_release_{fixture,behavior}.sql`、`postona_threads_release_run.sh` |
| I4 | 接続／再接続の入口（無効）とコールバック受け渡しの設計 | `apps/social-mobile/src/domain/threads-connect.ts`、`src/features/threads-connect/threads-connect-card.tsx`、`src/app/accounts/index.tsx`・`[id].tsx`（カード追加のみ）、`tests/threads-connect.test.mjs` |
| I5 | 組み合わせ環境を作って通しで検証する実行スクリプト | `supabase/tests/postona_threads_integration_run.sh` |
| — | 文言（新しい拒否コード） | `apps/social-mobile/src/domain/threads-manual-publish.ts` |

**変更していない**: #140 の DB 候補ファイル（`threads_manual_publish_candidate.sql`）とその検証、#124・#135・#139・#121 のファイル、G3 の予約画面、`x-test-post`、G5 の Auth・削除・利用権。

**適用順（将来、別承認で）**: Phase 2a-2 → G5 T13 → #124 → H5 claim → **G4 custody** → #140 manual publish → **G4 release**。release の前提条件に pgcrypto（`extensions.hmac`）、`auth.sessions`、名前付きの Vault secret（`postona_threads_publish_attestation_v1`）がある。

## 3. 権限の境界（レビューで見てほしい点）

- **トークンを受け取れるのは `release` だけ**。呼び出し元の JWT（`auth.uid()` とセッションは DB 自身が検証済みの claims から読む）＋サーバーの証明。証明が無い・違う・古い・再利用 → 何もロックせず・何も書かずに `ATTESTATION_INVALID`（フェンスにも到達しないことを検証済み）。
- **記録（record）は許可証・同じ本人・同じセッション・結果そのものへの証明**が必要。別の端末（別セッション）や管理者でも記録できない。利用権が途中で終わっても記録はできる（事実を消さないため）が、次の release は拒否される。
- **service_role・anon はどの関数も実行できない**（適用時の事後条件と検証で確認）。Edge 関数は service_role キーを持たない。持つのは証明用の鍵だけ（`THREADS_PUBLISH_ATTESTATION_KEY`、Vault の同名 secret と同じ値をユーザーが登録）。
- 証明の文言（TS と SQL で同じ値になることを既知の答えで固定）: `postona-threads-publish-release-v1` / `postona-threads-publish-record-v1` ＋ 本人 id・試行 id・手順・（許可証・結果）・発行時刻・nonce を改行でつないだもの。セッション id は文言に入れない（DB が自分で読む）ので、サーバーは JWT を解読しない。

## 4. H5 への依頼（最小の変更）

H5 の所有者トランザクション `complete` の中で、#124 の complete と H5 の outcome の間に1文を足すだけ:

```
select public.complete_social_mobile_threads_oauth_connection($1::uuid,$2,$3,$4,$5);
select public.record_threads_credential_custody($social_account_id, $expires_at::timestamptz);   -- 追加
select postona_threads_runtime.outcome($hash,$user::uuid,$session::uuid,'complete',$expires_at::timestamptz);
```

- `$expires_at` は H5 が既に計算している値（`now + expires_in`）。custody はこのトランザクションで接続されたアカウントでなければ拒否し、61日を超える期限も拒否する。
- この1文が入るまで、接続できても custody が無い＝期限不明なので、G4 は投稿しない（安全側）。
- 統合の検証（`integration_smoke.sql`）は、この3文を1トランザクションで実行して通ることを確認している。

## 5. G5 への依頼（T10・T13）

- **T13**: 本番のフェンス `private.account_lifecycle_assert_active_service_write(uuid,text)`。G4 は P0001 でも 42501 でも、固定のメッセージで読み分ける。
- **T10（削除・切断）**: Threads アカウントを消すときは、Vault の secret と `social_accounts` の行を一緒に消すこと。G4 の4つの表（手動投稿の許可・投稿の試行・nonce・custody）は `on delete cascade` で一緒に消え、トークンの残骸は残らない（G4 の検証で確認）。フットプリントの集計にこの4表を入れてほしい。すでに公開された Threads の投稿は消さない（Threads 側の削除は別段階）。

## 6. 次の作業の一覧

| 担当 | 内容 | 状態 |
|---|---|---|
| **G5** | T13 フェンスの本番化（#121 系）、T10 の provider 別後始末（上の4表と Vault） | 未。別 TASK |
| **H5** | 所有者トランザクションの提供（owner transport の本番の接続口）、`complete` に custody の1文を追加、Meta のコールバック→アプリリンク→サーバーの受け渡し | 未。別 TASK |
| **G4** | この PR の候補（custody・release）のレビュー反映、Edge のデプロイ準備（別承認） | 済（ソース） |
| **ユーザー（Meta）** | Threads ユースケースのアプリ、`threads_basic`＋`threads_content_publish`、テスター招待と承認、HTTPS コールバック、連携解除・データ削除のコールバック、接続用と投稿用の鍵（チャットや GitHub には貼らない） | 未 |
| **H1〜H4（Sol（高））** | 接続（H5）＋投稿（G4）＋T13（G5）をまとめた1回のセキュリティレビュー | 本番の DB 適用・GRANT・Edge デプロイ・フラグ・テスト投稿の**前**に必須 |
| **ユーザー** | テスター1名・テキスト1件の実投稿の明示承認 | 未 |

## 7. 検証（2026-10-11〜12 JST、すべてローカル・偽データ）

| 検証 | 結果 |
|---|---|
| `supabase/tests/postona_threads_release_run.sh`（使い捨て PG17） | ALL PASS: 前提不足4種で停止、適用・再適用拒否、動作（証明の偽造・古い・再利用、P1 の14ケース＝利用権終了（P0001／42501）・削除開始・ロック・降格・メンバー削除・同意取り消し・サインアウト・セッション期限切れ・トークン期限間近・custody なし・custody 更新なしの再接続・接続失敗・本人用でないワークスペース、記録の束縛、途中終了後の記録、custody の制約、T10 の後始末）、同時の publish release で1件だけ、変異8種すべて検出 |
| `supabase/tests/postona_threads_integration_run.sh`（組み合わせ環境） | ALL PASS: 重なりなし、#124 自身の検証、SQL の通し（G5 の利用開始→#124 begin/complete＋H5 claim/outcome＋G4 custody→許可→予約→release×4→published、実際の G5 の表での利用権終了とサインアウトの拒否）、TS の通し（H5 の実コード→受領票→G4 の Edge→1件投稿→読み戻し）、組み合わせ環境の回帰 176件 |
| `supabase/tests/postona_threads_publish_run.sh`（#140 の既存検証） | ALL PASS（#140 の候補は無変更） |
| Deno（この PR のみ） | 93件 PASS、lint 18ファイル問題なし、型エラーなし |
| アプリ | `npm test` 258件 PASS、`tsc --noEmit` PASS、`expo lint` 問題なし |
| NOT_RUN | 本番・管理された Supabase（Auth・PostgREST・Vault）、本物の G5 T13、Meta、実機。G5 フェンスは契約どおりの代役（#124 の MOCK_ONLY と G4 の代役）で、本物の証明ではない |
