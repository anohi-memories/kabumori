# G3｜`public.brand_memberships` を service_role が直接使う道の read-only 監査（2026-10-22、Issue #318 TASK 21/50）

- task_id: `postona-g3-service-role-brand-memberships-external-dependency-readonly-audit-20261022`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 前提: G3-20（PR #447 `e96ea327`）の T-5 を進める。
- 判定: **読み取りの監査と docs だけ。** migration・GRANT・ACL・RLS・RPC・Edge は変えていない。本番は NO_GO。PR #370 の A1・A2・B・C の選択と、P2 の修正はしない。
- 調べた範囲:
  - origin/main `0c42933c` の全ファイル
  - 2026-10-22 JST 時点の open PR **265 件**の head（各 PR の main からの差分）
- 根拠の印:
  - [M] main のソース
  - [P] open PR のソース
  - [D] 使い捨ての PG17 での実測
  - [E] 推定
  - [U] 未確認（リポジトリの外、本番の運用）

## 1. 結論（判断材料。決定ではない）
- **アクセスできるソースの中には、service_role が `brand_memberships` を直接読み書きする道は無い**（[M][P]）。
  - 読む側は、全部が利用者の JWT（authenticated）。
  - 書く側は、全部が表の owner の権限で動く。具体的には、SECURITY DEFINER の関数、FK の cascade、DEFINER のトリガー、運用者の SQL。
- 「service_role が書く」と書いた文書は 2 か所ある。どちらもコードの経路を示していない（§3 の H）。
- そのため、**コードの上では、作り直しの時に service_role の明示 GRANT は要らない**。R-6（server だけの表に service_role の付与をしない）に沿う。
- ただし、リポジトリの外（手作業・外部の仕組み・デプロイ済みだがリポジトリに無いもの）は [U]。§4 の確認がユーザーの承認のもとで済むまで、「不要」と確定しない。

## 2. 方法（再現できる静的検査）
付録 A のコマンドで再現できる。
1. `git grep -n brand_memberships origin/main` で全部の参照を出した。docs・archive・テストと、製品の経路（migration・Edge・アプリ）を分けた。
2. migration の中で `brand_memberships` を触る関数を抜き出した。それぞれについて `SECURITY DEFINER`／`INVOKER` とトリガーかを見た（付録 A の 2）。
3. Edge・アプリが使う鍵（publishable＋利用者の JWT か、service_role の鍵か）を、呼び出しのヘッダーとクライアントの作成から確かめた。
4. open PR 265 件の差分から、`brand_memberships` を新しく参照する行を集めた（145 件の PR に当たり）。テスト・docs 以外の製品ファイルに絞り（SQL の候補 21 ファイル）、それぞれの最新の head で 2. と同じ分類をした。Edge・アプリ・スクリプト・CI の製品ファイルで新しく参照するものは 0 件。
5. FK の cascade が子の表の権限を要らないことを、PG17 で確かめた（付録 B）。

## 3. 経路の一覧

| 区分 | 呼び出しの経路 | 根拠（path:line） | 必要な権限 | service_role の表の権限 |
|---|---|---|---|---|
| A. 利用者の JWT | social-mobile アプリ（publishable key＋利用者のセッション。service_role の鍵を拒む検査がある） | `apps/social-mobile/src/data/onboarding-repository.ts:19`、`apps/social-mobile/src/data/supabase-repository.ts:28`、鍵の検査 `apps/social-mobile/src/lib/supabase.ts:23` [M] | authenticated の SELECT ＋ 自分の行の policy | 要らない |
| A | admin アプリ（`createServerClient(url, publishableKey)`。service_role の鍵は入れない方針） | `apps/admin/src/lib/admin-context.ts:53`、`apps/admin/src/lib/supabase/server.ts:9`、`apps/admin/netlify.toml:38` [M] | 同上 | 要らない |
| A | Edge の consult・dry-run・history-learning（`apikey: publishableKey` ＋ `Authorization: Bearer <利用者のトークン>`） | `supabase/functions/social-mobile-consult/logic.ts:195,245`、`social-mobile-brand-dry-run/logic.ts:152-153,277`、`social-mobile-history-learning/live_dependencies.ts:43,78`（この Edge は service_role の鍵も持つが、この表には使わない） [M] | 同上 | 要らない |
| B. 他の表の policy の副問い合わせ | brands・social_accounts・scheduled_posts・post_execution_logs・posting_windows・social_mobile_content_settings の `to authenticated` の policy が `exists (select 1 from brand_memberships …)` を使う | `20260918120000:86,100,114,128,142`、`20260922045046:99,111,123,129`、`20261003120000:482,493,504,510` [M] | 呼び出した人（authenticated）の SELECT | 要らない（service_role は RLS を通らない） |
| C. 表の owner（SECURITY DEFINER） | X の接続 RPC、履歴のトークンの読み取り、削除の候補（blocker・purge・finalize）、lifecycle の footprint・backfill、公開の許可、ブランドの owner の解決 | `20260919120000:80,203`、`20260922003101:4`、`20260923120000:39`、`20260928160000:239,518,593`、`20261001150000:567,1360`、`20261003090000:133`、`20261012230000:78`（G5 の open PR） [M][P] | 関数の owner の権限（呼ぶ側は EXECUTE だけ） | 要らない |
| C | 削除のガードのトリガー（`social_mobile_account_deletion_guard`、DEFINER、brand_memberships の INSERT・UPDATE の前） | `20260928160000:119,157` [M] | 関数の owner | 要らない |
| C | open PR の候補の関数 29 個（G3・G4・G5） | §3.1 [P] | 28 個は DEFINER。1 個（G4 の `threads_credential_refresh_owner`）は INVOKER だが、API の役割すべてから EXECUTE を外し、呼ぶのは owner の transport だけ | 要らない |
| D. FK の cascade | brands・auth.users の行の削除 → brand_memberships の行の削除 | FK `20260918120000:42-43` [M]、実測は付録 B [D] | 子の表の owner の権限で動く（削除した役割に、子の表の権限は要らない） | 要らない |
| E. DDL・付与 | 作成・RLS・付与・policy、削除の候補のトリガーの作成、runbook の `drop trigger … on public.brand_memberships` | `20260918120000:41-63`、`20260928160000:157`、`apps/social-mobile/docs/account-deletion-rollout-runbook.md:124` [M] | 表の owner（migration の実行者） | 要らない |
| F. 文字だけ（アクセスではない） | 前提の検査の中の policy の文字列、lifecycle の形の一覧、日記の文脈の除外の正規表現 | `20261007150000:260`、`20261001150000:106,131-168`、`supabase/functions/_shared/brand/ai_lab_dev_diary_context.ts:73` [M] | — | — |
| G. **service_role の直接のアクセス** | **見つからない** | main と open PR 265 件の製品ファイル（Edge・アプリ・スクリプト・CI・SQL） [M][P] | — | — |
| H. 文書の記述（コードの経路ではない） | (1) migration のコメント「Inserts, updates, and deletes remain backend/service-role-only」。(2) G5 の lifecycle の文書の表で、brand_memberships を変えうる者として「X onboarding RPC, `service_role`, operator」。(3) PR #370 の 001 の事後条件と docs（「service_role の SELECT・INSERT・UPDATE・DELETE を残す」）。G3 自身の前提で、根拠は (1)。 | `20260918120000:55-56`、`docs/common-account/phase1-lifecycle-foundation.md:203` [M]、PR #370 [P] | — | 「意図」または「可能性」の記述で、使う経路は示していない |

### 3.1 open PR の候補（最新の head）の内訳
- G5: `common_account_authorization_verdict/001・002`、`common_account_brand_owner_epoch/001`（PR #446 の head）、`20261012230000`（migration の候補）。どれも DEFINER。
- G4: Threads の binding・disconnect・lifecycle guards・oauth workspace・credential custody・rotation・manual publish・release（PR #449 の head）、X の OAuth hardening（PR #287）。
  - rotation の `public.threads_credential_refresh_owner` だけが INVOKER。`revoke all … from public, anon, authenticated, service_role` で、呼ぶのは H5 の owner の transport だけ（同じファイルの 368〜400 行の事後条件で確認）。
  - 残りは DEFINER。
- G3: X の publish の guard・saga・予約（PR #392 の head）、PR #370 の 001 と rollback。関数はどれも DEFINER。
  - PR #370 の 001 は `revoke trigger … from service_role` を含む。rollback は記録の項目だけを戻す。どちらも DML の付与はしない。

## 4. 未確認の外の経路と、安全な確かめ方（どれも、この TASK ではしていない）
| # | 外の経路 | 何が分かれば判断できるか | 安全な確かめ方 | 承認する人 |
|---|---|---|---|---|
| U-1 | 運用者の手元のスクリプト・Postman・自動化（n8n など）が、service_role の鍵で REST の `/rest/v1/brand_memberships` を呼ぶ | 呼ぶものが有るか無いか | ユーザー（運用者）に聞く。Supabase の API ログ（Dashboard の Logs Explorer）で、一定の期間の `/rest/v1/brand_memberships` を、役割ごとに読み取りだけで集計する | ユーザー |
| U-2 | デプロイ済みで、リポジトリに無い Edge Function | 本番の関数の一覧とリポジトリの一覧の差 | `supabase functions list`（読み取り）とリポジトリの比較 | ユーザー |
| U-3 | Dashboard の Table Editor・SQL editor での手作業 | どの役割で動くか | Supabase の文書の確認（`postgres` 役で動くとされ、service_role の付与には依らない見込み [E]）。本番の監査ログ | ユーザー |
| U-4 | 本番の DB の中の、migration に無い関数・ビュー・トリガーで、INVOKER として brand_memberships を触り、service_role が EXECUTE できるもの | 本番のカタログに有るか無いか | G5 の読み取りの監査 SQL（`common_account_data_api_grants_audit.sql`）に、`pg_proc` の本体の検索と `has_function_privilege('service_role', …)` を足した読み取り | ユーザー（読み取りの接続の承認）。実施は割り当てられた枠 |
| U-5 | pg_cron・データベースの webhook・外部の連携が service_role で動き、この表を触る | 有るか無いか | 本番の `cron.job`・webhook の設定の読み取り | ユーザー |
| U-6 | Netlify の admin・モバイルのビルドの実際の環境変数に、service_role の鍵が入っていないか | 入っていないこと | 運用者による環境変数の名前の確認（値は見ない） | ユーザー |

- U-1〜U-6 のどれかで service_role の直接の利用が見つかったら、T-1 で、その操作に必要な最小の付与（列や操作を絞ったもの）を、根拠付きで足す。

## 5. 作成の migration の持ち主の判断に要る依存とデータの流れ（決定はしない）
- 作る: `20260918120000`（social-mobile の Phase 4 の migration。今の持ち主の案は G3＝G5 の提案）
- 行を足す・変える: X の接続 RPC（main。G4 の X OAuth の系列）、Threads の oauth workspace の候補（G4 [P]）、削除の流れ（main の削除の候補。social-mobile）
- 読む:
  - social-mobile アプリ（G1・G2）、admin アプリ、consult・dry-run・history-learning の Edge
  - G3 の予約の definer の関数（`postona_x_resv.assert_account_access`・`row_publishable` [P]）
  - G4 の Threads の関数 [P]
  - G5 の verdict・owner epoch [P]
  - 他の表の policy
- 権限を管理する:
  - G3 の PR #370（TRIGGER・TRUNCATE・REFERENCES の取り上げ）
  - G5 の L-1（PR #303 の install の前提、G5 の第 20 TASK で列・システム列へ広げる案）
- 持ち主を決めるときの条件（案）:
  1. 作成の migration と、その R-2・R-3 の書き直し（T-1）を書く枠は 1 つにする（同じ表を 2 つの枠が書き換えない）。
  2. 書き込みの RPC（G4）と、権限の取り上げ（G3）と、L-1 の検査（G5）の間で、変更の順番を決める（G5 の文書の apply order と同じ考え方）。
  3. 今の G4 の TASK（Threads の rotation の CAS）・G5 の第 20 TASK のファイルとは、編集するパスを分ける。この監査は G4・G5 のファイルを変えていない。

## 6. 後続の T-1・T-2 の選び方（提案。PR #370 の A1・A2・B・C とは別に決める）
| | T-1（作成の migration を R-2・R-3 にする新しい migration） | T-2（PR #370 の 001 の事後条件） |
|---|---|---|
| 明示の GRANT | `revoke all … from public, anon, authenticated, service_role` → `grant select … to authenticated` だけ。service_role への付与は、§4 で利用が示された場合だけ、操作を絞って足す | — |
| 事後条件 | anon・PUBLIC に何も無いこと、authenticated は SELECT だけであること（列の ACL なし）、service_role に TRIGGER・TRUNCATE・REFERENCES が無いこと | `SERVICE_ROLE_DML_LOST` をやめて「service_role に TRIGGER が無い」だけを要件にする。DML は要件にしない（G5 Q6 の (b)） |
| PG17 の試験 | pre・postA・postB の 3 つの世界。既存の付与がある表への再適用（旧表）、利用者の自分の行の読み取り、definer の RPC・cascade・トリガーが付与なしで動くこと、拒否の確認 | 3 つの世界での 001 と rollback。PR #370 の既存の 46 場面 |
| rollback | 新しい migration の逆は、適用の前の ACL の記録が要る（PR #370 の prestate の考え方） | 001 の rollback（記録の行）は変えない |
| 関門 | §4 の U-1〜U-6 の扱いの決定（確かめるか、残りとして受け入れるか）→ Codex Sol（高） | T-1 と同時。Codex Sol（高） |

- T-1 と T-2 は、同じ表と PR #370 に触る。PR #370 の P2（システム列）の方針の後か、同時に担当ちゃが順番を決める。

## 7. 未解決と NOT_VERIFIED
- PR #370 の P2（システム列の ACL）、P7・U8・U9 は未解決のまま。本番は NO_GO。
- §4 の U-1〜U-6 は [U]。この監査は「アクセスできるソースに無い」ことだけを示し、「本番に無い」とは主張しない。
- 走査は、名前 `brand_memberships` を含む文字列だけを見た。動的に組み立てた表の名前（例: 変数から作る REST のパス）は見落としうる。Edge の REST の汎用の関数（`tableUrl`・`readRows` など）の呼び出しは目で確かめたが、全部ではない [E]。
- open PR は 2026-10-22 JST 時点の head。その後の変更は含まない。

## 付録 A: 再現のコマンド（読み取りだけ）
```bash
git fetch origin
git grep -n brand_memberships origin/main -- 'apps/*/src/*' 'supabase/functions/*' ':!*_test.ts' ':!*.test.*' ':!*disposable_proof.sql'
git grep -n brand_memberships origin/main -- 'supabase/migrations/*'
git grep -n brand_memberships origin/main -- 'src/*' 'scripts/*' '.github/*'
git grep -n -E 'createServerClient|createBrowserClient|SERVICE_ROLE' origin/main -- 'apps/admin/src/*'
```
1. 上の 4 つの `git grep`: main の参照を出す。最後の `src/`・`scripts/`・`.github/` は 0 件。
2. 関数の分類: migration のフォルダの各 `create function` について、本体（`$tag$ … $tag$`）に `brand_memberships` があるものを出し、見出しと末尾に `security definer` があるかを見る。この TASK では、作業用の一時スクリプト（Python）で行った。結果は §3 の C。
3. open PR: `gh pr list --state open --limit 300 --json number,headRefOid` の各 head について、`git diff origin/main...<head> -U0` の `+` の行で `brand_memberships` を含むものを数え、ファイルごとに最新の head で 2. と同じ分類をした。

## 付録 B: FK の cascade の実測 [D]
使い捨ての PG17.11（ローカルのソケットだけ）で、次の構成を作った。
- 表の owner が、brands・users・brand_memberships（両方の FK は on delete cascade、RLS は有効）を作る。
- 別の役割には、brands と users の SELECT・DELETE だけを付ける。brand_memberships には何も付けない。

結果:
- その役割の `select count(*) from brand_memberships` → `permission denied`
- その役割が brands と users の行を削除する → 成功し、brand_memberships の行は 0 件になった（cascade は子の表の owner の権限で動く）。
