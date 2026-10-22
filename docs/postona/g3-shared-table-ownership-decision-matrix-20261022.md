# G3｜共有の表の migration の持ち主と権限の責任：意思決定マトリクス（2026-10-22、Issue #318 TASK 22/50）

- task_id: `postona-g3-shared-table-migration-ownership-decision-matrix-20261022`
- 返却先: POSTONA G3担当ちゃ（Issue #318）／完了コード: K3
- 判定: **docs だけ。持ち主は決めていない。** この文書は割り当ての案と、決めるための質問を並べる。決めるのは総合指令・ユーザー。migration・SQL・ACL・GRANT は変えていない。本番は NO_GO。
- 前の調査: G3-20（PR #447 `e96ea327`）、G3-21（PR #452 `d78adaf2`）、G5 の Data API の文書（PR #424 `f13ce2fd`・§12・§13）、G5 の Q1〜Q6 の回答（PR #441 `1066c5a5`）、G4 の持ち主の提案（#318 コメント 6317113668、G4 Draft PR #420）
- この文書で新しく足したもの:
  1. 表ごとに「どの migration がどう触るか」と「どの slot の open PR が書くか」を突き合わせた。
  2. それをもとに、**1 表 1 owner** の案、レビュアー、合意が要る相手、10/30 の後の作り直しの検証と rollback の責任を分けた。
  3. 共有の SQL の編集の順番と、関門を整理した。
- 根拠の印:
  - [M] origin/main `0c42933c`
  - [P] 2026-10-22 JST 時点の open PR 268 件の head
  - [E] 推定
  - UNKNOWN: 根拠が足りない、または候補が複数

## 1. 証拠のマトリクス（作られ方と、誰が書くか）

| 表・列 | 作成の記録 | main の migration の触り方 [M] | open PR で書く slot [P] | 実行時の読み書き（path:line）[M] |
|---|---|---|---|---|
| `public.brand_memberships` | `20260918120000`（social-mobile Phase 4、commit c40c96cb） | **作る・RLS・付与・policy**: `20260918120000`。行を足す: `20260919120000`・`20260922003101`（X の接続 RPC）。トリガー: `20260928160000`（削除のガード）。読むだけ: 6 本 | G3 #370: TRIGGER・TRUNCATE・REFERENCES の取り上げ。G4 #453: Threads の workspace の候補が行を足す。G5 #446: owner epoch のトリガーを付ける | 読む: アプリ・admin・Edge 3 つ（利用者の JWT。G3-21 §3）。書く: 表の owner の DEFINER の RPC・cascade |
| `public.brands` | **無い**（本番と fixture だけ。G4・G5 の実測で、空の DB では `20260918120000` が `PHASE4_PREFLIGHT_MISSING_TABLE:brands` で止まる） | 行を足す: `20260919120000`・`20260922003101`。更新・削除・トリガー: `20260928160000`。policy・付与: `20260918120000`。FK の参照先: 3 本。読む: 4 本 | G4 #453: 行を足す | 読む: `apps/social-mobile/src/data/supabase-repository.ts:36`、`supabase/functions/_shared/brand/brand_context.ts:98`（service_role の REST。AI Lab のブランド投稿・x-test-post から呼ばれる）、`social-mobile-history-learning/live_dependencies.ts:89`、consult・dry-run |
| `public.social_accounts` | **無い** | 列・制約・トリガー: `20260924023133`・`20260925140000`（X の自動投稿・X の refresh）、`20261007150000`（POSTONA の複数のプロバイダー。G4 の系列、未適用）。行を足す・更新: X の接続 RPC 2 本、`20261003090000`。削除: `20260928160000`。読む: 10 本超 | G4 #453: Threads の connect・disconnect・cleanup。G4(F4) #287: X の OAuth の hardening | 読む: `apps/social-mobile/src/data/onboarding-repository.ts:28`、`supabase-repository.ts:37`、`_shared/brand/brand_context.ts:112`、`_shared/brand/ai_lab_vault_token_source.ts:62`、`social-mobile-history-learning/live_dependencies.ts:95` |
| `public.social_account_oauth_states` | **無い** | 列を足す・行を足す・更新: `20260919120000`。行を足す: `20260922003101`。削除・トリガー: `20260928160000` | G4 #453・G4(F4) #287 | アプリ・Edge からの直接の読み書きは無い（RPC の中だけ） |
| `public.published_content_fingerprints` | **無い** | 行を足す: `20261006160000`（ブランド投稿の完了、commit b90ee326）。削除・トリガー: `20260928160000` | 無い | 読む: `_shared/brand/ai_lab_brand_post_store.ts:25`（service_role の REST。AI Lab のブランド投稿） |
| `public.brand_settings` | **無い** | 読む: `20261006160200`（X のアカウントの公開の権限）だけ | 無い | 読む: `_shared/brand/brand_context.ts:122`（service_role の REST） |
| `public.daily_content_plans` | **無い** | **コメントの中だけ**（`20260928160000:14,578`「brands から cascade する」）。SQL の文としては参照が無い | 無い | **製品のコードに参照が無い**（fixture だけ） |
| `brand_id` の列（`scheduled_posts`・`post_execution_logs`・`posting_windows`・`publish_claims`） | **足す migration が無い**（4 つの表を作る migration に列が無い） | 前提の検査と policy で使う: `20260918120000`。一意性・前提で使う: `20260923102327`（X の自動投稿 phase0）。そのほか X の自動投稿の migration が使う | 無い | 読み書きは、表の作成の持ち主（X の投稿・レポートの系列）の Edge と RPC |

注:
- 走査の方法は §6。G3 の候補 #392 の `g4_predicate_contract.sql`（social_accounts の UPDATE）は G3 のテスト用の写しで、製品ではない。

## 2. 1 表 1 owner の案（**決定ではない**）

| 表・列 | migration の持ち主の案 | 確度 | レビュアー | 合意が要る相手 | ACL・RLS・GRANT と 10/30 の後の作り直しの検証・rollback の責任 |
|---|---|---|---|---|---|
| `brand_memberships` | **G3**（G5 の Q1 の提案）。対案は G4（行を書く RPC は G4 の系列） | 中（候補が 2 つ。UNKNOWN を残す） | Codex Sol（高）（H3） | G4（書く RPC）、G5（owner epoch のトリガー、L-1）、G1・G2（アプリの読み取り） | 持ち主: R-2・R-3 の書き直し（G3-21 の T-1）、PR #370 の 001 の事後条件（T-2）、PG17 の pre・postA・postB、prestate による rollback |
| `brands` | **G4**（G4 の提案。G3 は G3-20 で同意） | 中〜高 | Codex Sol（高） | G3（publish_mode などを読む）、AI Lab の持ち主（brand_context）、G5（lifecycle） | G4: 作成の migration（作成・RLS・revoke all・最小の付与）。既存の本番の表との一致の確認 |
| `social_accounts`・`social_account_oauth_states` | **G4**（G4 の提案。G3 は同意。`20261007150000` も G4 の系列） | 高 | Codex Sol（高） | G3（X の予約・自動投稿が読む）、AI Lab の持ち主（vault の鍵の取り出し）、G5 | G4: 同上。G5 の D-1・D-2（service_role の TRUNCATE などと、列単位の SELECT）の決着を含む |
| `published_content_fingerprints` | **UNKNOWN**: G3（G4 の提案）か、AI Lab のブランド投稿の持ち主 | 低 | Codex Sol（高） | 書く migration `20261006160000` の持ち主、AI Lab | 決まった持ち主: 作成の migration と、service_role の REST の読み取りに要る最小の付与（R-6 の根拠付き） |
| `brand_settings` | **UNKNOWN**: AI Lab のブランド投稿の持ち主か G3 | 低 | Codex Sol（高） | `20261006160200` の持ち主、AI Lab | 同上 |
| `daily_content_plans` | **UNKNOWN**。製品のコードに参照が無いので、まず「まだ要る表か」を確かめる | 低 | — | social-mobile（G1・G2）、G4 | 要らないなら別の判断（削除は本番の操作になるので、別の承認） |
| `brand_id` の列 4 つ | 各表の作成の持ち主（X の投稿・レポートの系列）。**UNKNOWN** | 低 | Codex Sol（高） | `20260918120000`（G3 の案）と X の自動投稿の migration の持ち主 | 列を足す migration（`if not exists`）。既存の本番の列との一致 |

## 3. 別のトラックとして保つもの（この文書は触らない）
- PR #370 の残りの P2（システム列）と、A1・A2・B・C の選択: 未決定。
- G5 の L-1 の独立のレビュー（PR #446・G5 の第 21 TASK、owner epoch の履歴のトリガー）: G5 のトラック。
- G4 の Threads の credential・CAS（G4-25）: G4 のトラック。
- P7・U8・U9: 未解決のまま。

## 4. 共有の SQL を編集するときの順番と関門（案）
1. **持ち主の決定**（総合指令。§5 の質問）。決まるまで、どの枠も共有の表の作成の migration を書かない。
2. `brand_memberships`（1 つの表に 3 つの枠の変更が載る）の順番は、G5 の apply order と同じ考え方にする。
   - (a) G3: PR #370 の方針（A1・A2・B・C）の決定と、T-1・T-2（ACL の書き直しと 001 の事後条件）
   - (b) G5: L-1 の検査の広げ方と owner epoch の install（PR #303・#446）
   - (c) G4: 行を書く RPC の変更（Threads の workspace）
   - 各段は、前の段のレビューの後に限る。
3. migration の外の表（brands など）の作成の migration:
   - 空の DB からの作り直しでは、`20260918120000` より前に作られている必要がある。本番ではすでに表がある。
   - そのため「早い timestamp の土台の migration を作り、本番では適用済みとして記録する」などの運用が要る。これは本番の操作なので、方式そのものに承認が要る（§5 の Q6）。
4. どの段も: PG17 の pre・postA・postB の試験 → Codex Sol（高）→ ユーザーの承認。それまで NO_GO。
5. 2026-10-30 当日には、既存の表は付与を保つ（G3-20 §1）。そのため、上の順番は「作り直しの前」までに済めばよく、10/30 の締め切りに合わせて急ぐ必要は無い [E]。

## 5. 総合指令に決めてほしい最小限の質問
| # | 質問 | 選択肢 |
|---|---|---|
| Q1 | `brand_memberships` の作成の migration と ACL の持ち主 | (a) G3（G5 の提案、G3 の推奨。PR #370 と同じ枠）／(b) G4（行を書く側）／(c) 保留 |
| Q2 | `brands`・`social_accounts`・`social_account_oauth_states` | (a) G4 で承認（G4 の提案、G3 も同意）／(b) 別の案 |
| Q3 | `published_content_fingerprints`・`brand_settings` | (a) G3／(b) AI Lab のブランド投稿の持ち主／(c) 持ち主を決めるための読み取りの調査を先にする |
| Q4 | `daily_content_plans` | (a) 要否の調査を割り当てる（G1・G2 または G4）／(b) 保留 |
| Q5 | `brand_id` の列 4 つ | (a) 各表の作成の持ち主／(b) 土台の migration の持ち主が一括で |
| Q6 | migration の外の表を作り直せるようにする方式 | (a) 1 つの土台の migration（早い timestamp、本番では適用済みとして記録）を 1 つの枠が書く／(b) 持ち主ごとに書く／(c) 10/30 の後も今のまま（作り直さない前提を明記） |
| Q7 | `brand_memberships` の順番 | (a) PR #370 の P2 の方針を先に決める／(b) T-1・T-2 を P2 とは別に先に進める |

## 6. 静的検査（再現できる読み取り）
- main の migration の触り方:
  - 各 migration からコメントを除き、表ごとに `create table`・`alter table … add column`・`create policy … on`・`grant/revoke … on`・`create trigger … on`・`references`・`insert into`・`update`・`delete from`・`from/join` を正規表現で分類した。
  - あわせて、追加した commit の題名を `git log --diff-filter=A` で添えた（作業用の一時スクリプト）。
- open PR:
  - 268 件の head ごとに `git diff --name-only origin/main...<head> -- supabase/candidates supabase/migrations` を取り、テスト・rollback・docs を除いた SQL を、パスごとに最新の head で読んだ。
  - そのうえで、書き込みの種類（作成・列・RLS・policy・付与・トリガー・行の書き込み）を slot（branch の名前）ごとに集計した。
- アプリ・Edge: `git grep -F "rest/v1/<表>?"`、`.from('<表>')`、`tableUrl("<表>"`、`readRows` の引数を、main のテスト以外のファイルで探した。
- 限界:
  - 名前の文字列だけを見た（動的な表の名前は見落としうる）。
  - commit の題名は持ち主の証明ではない（同じアカウントで全部の枠が commit している）。
  - 系列（X の自動投稿・social-mobile・AI Lab）が今どの枠に属するかは、PROJECT_RULES の枠の表と照らして担当ちゃが確かめる必要がある。
