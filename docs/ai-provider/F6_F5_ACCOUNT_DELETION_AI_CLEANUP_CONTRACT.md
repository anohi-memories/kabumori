# F6 → F5 / G5: アカウント削除への AI の後片付けの接続の決まり（source-only）

- 日付: 2026-10-17（JST）
- task_id: `common-ai-f6-f5-account-deletion-ai-cleanup-contract-20261017`
- 前提: F6 の Draft PR #249 → #256 → #261（本番には未適用のソースの候補）
- 状態: 文書・参照の実装・テストだけ。DB・RPC 本体、F5 / POSTONA / 認証 / Edge / Cron は変えていない。本番は **NO_GO**
- 調べた元: main `bc16edc4`（F5 の削除の流れ）、F5 の開いた stack の先頭 #259（head `422c101a…`。#121 → … → #250 → #254 → #259）、F6 #261（head `017c7eb7803a134e83d1f128576b62bc69b4fcb4`）。読み取りだけ

## 0. 要約

- F6 の 4 つの RPC（`ai_calls_forget_user`、`ai_calls_forget_system_brand`、`ai_ledger_erase_user`、`ai_ledger_user_footprint`）の入力・答え・error・前提・権限・分離レベル・冪等性を、#261 の積み上げのソースから確定した（§2）
- 呼ぶ順番の参照の実装 `supabase/tests/ai_account_deletion_cleanup_contract.ts` の `runAiAccountCleanup`（deploy しない。F5 が自分のファイルに写して使う）と、そのテスト（偽の RPC で 10 件、#261 の本物の SQL に対して 5 件、PASS）（§3・§6）
- F5 の今の削除の流れには、AI の手順・新しい checkpoint を書く口・AI の残りの確認がまだ無い。F5 が持つべき最小の変更を §4 にまとめた
- **本番の前の大きな前提が 2 つ未実装**: POSTONA の AI の入口が利用権を確かめていない（相談・試し投稿とも）、X の saga の `social_and_login` の経路が共通アカウントの流れの外でログインを消す（§1・§5）
- F5 / G5 のチャットにそのまま渡せる依頼文を §8 に置いた

## 1. 今の削除の流れ（main `bc16edc4`、読み取りで確認）

| 項目 | 場所 | 状態 |
|---|---|---|
| 削除の順番（Edge `account-delete`） | `supabase/functions/account-delete/lifecycle_logic.ts`: 公開の gate :339 → eligibility :340 → `begin_common_account_deletion` :356 → claim :366 → X の利用権の終了（`begin_service_deletion` → X の saga → `finish_service_deletion`）:411-435 → `withdraw_kabumori_service` :437-444 → **全サービスが `ended` かの確認 :445-447** → session の失効と checkpoint `session_revocation` :449-463 → Apple :465-495 → Storage と checkpoint `storage_cleanup` :497-506 → `prepare_owned_common_account_auth_delete` :508-528 → `begin_…_external_step('managed_auth_delete')` :530-537 → ログインの削除 :539-559 → `complete_common_account_deletion` :561-575 | 実装済み（候補、本番未適用）。#259 では 4a が `endPostona`（provider の adapter → X の saga）に変わるが、4b 以降の順番は同じ |
| 利用権の終了の書き込み | `supabase/migrations/20261001150000_common_account_lifecycle_foundation.sql:1036-1038`（`finish_service_deletion` が `ended` に） | 実装済み |
| service_role が利用権を読む口 | `public.common_account_deletion_eligibility(uuid)`（同 :904-941、`services[{service_key, status}]` を返す） | 実装済み。service_role は表を直接読めない（:335-336） |
| checkpoint の登録表 | `private.account_lifecycle_managed_checkpoints`（同 :319-324、組み込み 3 つ :307-312）。行を足すと、記録されるまで全部の削除が止まる（:314-318） | 実装済み |
| checkpoint を書く口 | `public.set_owned_common_account_deletion_checkpoint`（`20261009120000_common_account_deletion_completion.sql:319-340`）は **`session_revocation` / `storage_cleanup` だけ**（:327）。汎用の `record_…` は service_role から取り上げ済み（:734） | **AI 用の checkpoint を書く口は無い**。開いた F5 の PR にも無い |
| 残りの確認 | `private.account_lifecycle_footprint`（foundation :567-590、`kabumori` / `x_autopost` / `x_foreign` / `admin` の決め打ち）、`private.account_lifecycle_residue`（completion :507-530） | **AI の台帳・保存の場所は見ていない**（登録の仕組みも無い）。開いた PR も変えていない |
| ログインの削除の gate | `private.account_lifecycle_release_gates`（completion :176-182、`state = 'blocked'` だけ許す） | 今は削除の流れがログインの削除まで届かない（:339 で止まる） |
| X の saga の `social_and_login` | `supabase/migrations/20260928160000_social_mobile_account_deletion_candidate.sql:593-630` の `social_mobile_account_deletion_finalize` が **:619 で `delete from auth.users`**。`profiles` が無い人（POSTONA だけの人）は `social_and_login`（:282-284）。Edge `social-mobile-account-delete/delete_logic.ts:241` から | **共通アカウントの流れの外でログインを消す**。利用権の確認も AI の後片付けも無い |
| Threads の後片付け | main の `account-delete` には無い。F5 の #178 の provider の登録は `adapters: []`（未登録） | 候補だけ（F4） |
| POSTONA の AI の入口 | `social-mobile-consult/logic.ts`: `getUser` :712 → owner の確認 :716 → model :724。`social-mobile-brand-dry-run/logic.ts`: `getUser` :265 → owner :276-296 → model :393。`_shared/brand/vault_account_brand_post.ts:36` は「G5 の境界はここでは守らない」 | **利用権・共通アカウントの状態を見ていない**（どれも） |
| AI の名前への参照 | `ai_calls` / `ai_calls_forget_user` / `ai_ledger_erase_user` は F6 の #249 / #256 / #261 にだけある。`ai_ledger` の schema は main にある（台帳 `20261010050613`）。F5 の #147 の文書（`phase3i-lifecycle-safety-design.md:227`）は台帳の利用者 ID の消し方を「未決」としている | この文書がその答え |

## 2. F6 の 4 つの RPC の厳密な契約（#261 の積み上げのソースから）

共通:
- どれも `public.<名前>(p jsonb) returns jsonb`、`SECURITY DEFINER`、`search_path = ''`、**実行できるのは `service_role` だけ**（anon / authenticated は `42501`）。適用の最後に権限を確かめる（危なければ migration ごと取り消し）
- 呼び方: Edge から service_role の鍵で PostgREST の `POST /rest/v1/rpc/<名前>`、本文 `{"p": {...}}`。または F5 の持ち主のロールの SQL から直接（同じ持ち主のとき）
- error は SQL の例外（PostgREST では 2xx 以外）。**2xx 以外・形の違う答えは、成功として扱わない**
- 利用者 ID は**小文字の正規の uuid** で渡す（`ai_calls_forget_user` は大文字を拒む。`ai_ledger_*` は大文字も受けるが、揃える）
- ワークスペースの slug は `u_` ＋ 16 進 24 文字。**利用者 ID と取り違えない**（それぞれ形を検査して拒む）

| RPC（定義の場所） | 入力 | 成功の答え | 続けられない答え | error（SQLSTATE: 文言の頭） | 前提・lock・分離レベル |
|---|---|---|---|---|---|
| `ai_calls_forget_user`（`20261017120000_ai_consumer_call_store.sql:525`） | `user_id`（必須、小文字 uuid） | `{forgotten: true, deleted, ledger_reservations_retained}` | `{forgotten: false, reason: "CALLS_IN_FLIGHT", in_flight}` | `22023: AI_CALLS_INVALID_INPUT: user_id …` | 利用者の lock（`ai_calls:user:<id>`、排他）。**分離レベルの検査は無い**（#249。READ COMMITTED で呼ぶ。§8 の follow-up） |
| `ai_calls_forget_system_brand`（`20261017150000_ai_ledger_user_erasure.sql:323`） | `brand_ref`（必須、`^u_[0-9a-f]{24}$`） | `{forgotten: true, deleted}` | `{forgotten: false, reason: "CALLS_IN_FLIGHT", in_flight}`、または消した後に入った claim があれば `{…, in_flight, deleted}` | `22023: AI_CALLS_INVALID_INPUT: brand_ref …`、`P0001: AI_CALLS_REQUIRES_READ_COMMITTED` | brand の lock。処理中の行は消さない。READ COMMITTED だけ |
| `ai_ledger_erase_user`（同 `:185`） | `user_id`（必須、uuid、消した人の形は不可） | `{erased: true, reservations, usage_events, budget_buckets, budget_policies}`（2 回目以降は全部 0） | `{erased: false, reason: "CALL_STORE_NOT_FORGOTTEN", call_rows}` / `"LEDGER_IN_FLIGHT", in_flight` / `"POLICY_TEXT_MENTIONS_USER", policies` / `"POLICY_KEY_CONFLICT"` | `P0001: AI_LEDGER_ERASURE_REQUIRES_READ_COMMITTED`、`22023: AI_LEDGER_INVALID_INPUT: user_id …`、`P0001: AI_LEDGER_ERASURE_INCOMPLETE`（取り消し済み） | 利用者の lock＋台帳の予約の lock。消した人の ID は返さない。READ COMMITTED だけ |
| `ai_ledger_user_footprint`（同 `:276`） | `user_id`（必須）、`brand_ref`（任意） | `{reservations, usage_events, budget_buckets, budget_policies, policy_mentions, call_rows}`（＋ `brand_call_rows`）。**全部 0 のときだけ完了** | — | `P0001: AI_LEDGER_ERASURE_REQUIRES_READ_COMMITTED`、`22023: AI_LEDGER_INVALID_INPUT: …` | 読むだけ。READ COMMITTED だけ |

冪等性: 4 つとも、同じ入力で何度呼んでもよい（消す方向にしか進まない。2 回目は 0 件）。どれも 1 回の取引で全部か何もしないか。

## 3. 呼ぶ順番と、失敗・再試行の扱い

参照の実装 `runAiAccountCleanup(rpc, request)`（`supabase/tests/ai_account_deletion_cleanup_contract.ts`）が 1 回の「掃除」。

| 段 | 内容 | 誰が確かめるか |
|---|---|---|
| 前提 A | その人の全サービスの利用権が `ended`（`common_account_deletion_eligibility` の読み返し、lifecycle_logic.ts :445-447 の確認と同じ）。その時刻を `entitlementsEndedAtMs` として渡す | F5 |
| 前提 B | AI の入口がその人をもう認可しない（`aiAuthorizationStopped: true`）。**今の main では成り立たない**（§1: 入口が利用権を見ていない）。POSTONA の Claude の経路をつなぐ前に、入口が「利用権と共通アカウントが active のときだけ認可」する必要がある（#241 の設計、POSTONA の担当） | F5（POSTONA の入口の実装が前提） |
| 待つ | `entitlementsEndedAtMs` から bridge の最大の締め切り 60 秒＋余裕（既定 120 秒）。それまでは `wait`（何も呼ばない） | 参照の実装 |
| 1 | `ai_calls_forget_user({user_id})` | 参照の実装 |
| 2 | `ai_calls_forget_system_brand({brand_ref: ワークスペースの slug})`（slug が無い人は飛ばす） | 同上 |
| 3 | `ai_ledger_erase_user({user_id})` | 同上 |
| 4 | `ai_ledger_user_footprint({user_id, brand_ref?})` が `policy_mentions` を含めて**全部 0** のときだけ `done` | 同上 |
| 最後の掃除 | ログインの削除の直前に、同じ掃除をもう一度（冪等。0 件で `done`） | F5 |
| 残りの確認 | F5 の `residue` が AI の数も見て、0 でなければ完了させない | F5（§4） |

参照の実装の答えと、F5 がすること:

| 答え | 意味 | F5 がすること |
|---|---|---|
| `done` | 何も残っていない（数を返す） | checkpoint を記録して次へ（記録するのは数だけ） |
| `wait`（`retryAfterMs`） | 締め切りの待ち | operation は進行中のまま、lease を返して後でやり直す |
| `retry_later`（`CALLS_IN_FLIGHT` / `LEDGER_IN_FLIGHT` / `CALL_STORE_NOT_FORGOTTEN` / `FOOTPRINT_NOT_ZERO`） | 処理中の呼び出し、遅れて入った claim、残り | 同上。後片付けの仕事（`ai_ledger_recover_stale` → `ai_calls_abandon`、#256 docs §8）が終わるのを待つ |
| `operator_required`（`POLICY_TEXT_MENTIONS_USER` / `POLICY_KEY_CONFLICT`） | その人のものでない予算の枠がその人の ID を含む、名前の衝突 | 止めて運用者に知らせる。**自動では直さない**。直った後にやり直す |
| `refused`（前提・入力） | 前提が満たされていない、ID と slug の取り違え | 呼び出し側の誤り。直すまで進めない |
| `failed`（`RPC_ERROR` / `UNEXPECTED_RESPONSE`） | 通信・SQL の error、知らない形の答え | **成功として扱わない**。進めずに後でやり直す。続くなら運用者へ |

- 取り消し（補償）は要らない: どの RPC も消す方向にしか進まず、1 回の取引で全部か何もしないか。途中で止まっても、最初から同じ掃除をやり直せばよい
- 冪等: 何度呼んでもよい（2 回目以降は 0 件で `done`）
- user ID と slug を取り違えない: 参照の実装が両方の形を検査し、違えば何も呼ばずに `refused`
- 分離レベル: SQL から呼ぶときは READ COMMITTED で（erase / footprint / forget_system_brand はそれ以外を拒む。forget_user は拒まないが同じく READ COMMITTED で）

## 4. F5 が持つべき最小の変更（F5 の担当。F6 は変えていない）

| どこ | 何を | 理由 |
|---|---|---|
| `supabase/functions/account-delete/http.ts` の `RPC_NAMES`（:27-44）と deps | 4 つの RPC の名前と呼び出し | Edge が service_role で呼ぶ |
| `supabase/functions/account-delete/` に F5 自身のファイル | 参照の実装 `runAiAccountCleanup` を**写す**（`supabase/tests` から import しない。deploy される側が tests を読まないため） | 順番・判定を同じにする |
| `lifecycle_logic.ts` | (a) Storage の checkpoint（:504）の後、`prepare_owned…`（:510）の前に「AI の掃除」の段。`done` 以外ならその回の削除をそこで止める（成功にしない）。(b) `prepare_owned…` の後（:526）、`begin_…_external_step('managed_auth_delete')`（:530）の前に**最後の掃除** | 利用権の終了（:445-447）の後で、session・Apple・Storage の間に 60 秒＋余裕が過ぎることが多い。ログインを消す前に必ず 0 にする |
| ワークスペースの slug | `public.social_mobile_account_deletion_workspace(uuid)`（`20260928160000…:98`、`'u_' || substr(md5(user_id), 1, 24)`）。**service_role からは呼べない**（:679 で取り上げ）ので、F5 の持ち主のロールの SQL の中で求めるか、同じ式で求める | 推測しない |
| F5 の migration | (1) checkpoint の登録表に `('ai_data_cleanup', 'always')` を足す（足すと記録されるまで全部の削除が止まる＝安全側）。(2) `set_owned_common_account_deletion_checkpoint` の受け付ける名前（:327）に `ai_data_cleanup` を足し、**書く前に SQL の中で `public.ai_ledger_user_footprint` が全部 0 かを確かめる**（Edge の申告だけで記録しない）。(3) `private.account_lifecycle_residue`（:507-530）に AI の数を足す（例 `RESIDUAL_AI_DATA`） | 今は AI 用の checkpoint を書く口も、AI の残りの確認も無い |
| migration の順番 | F6 の台帳（`20261010050613`）→ 保存の場所（`20261017120000`）→ 消す仕組み（`20261017150000`）→ F5 の上の migration | F5 の関数が F6 の関数を呼ぶため。同じ持ち主（本番の migration のロール）であること |
| X の saga の `social_and_login`（`…finalize` :619） | ログインを消す前に AI の掃除を入れるか、POSTONA だけの人をこの経路に通さない（#259 の注記と同じ課題） | 共通アカウントの流れの外でログインが消え、AI の掃除が抜ける。F3 / G3 / F5 で決める |

権限の境目:

| 操作 | 誰が | 権限 |
|---|---|---|
| 4 つの AI の RPC | Edge `account-delete`（service_role の鍵） | service_role だけ（anon / authenticated は 42501） |
| 利用権の読み返し | 同上 | `common_account_deletion_eligibility`（service_role） |
| checkpoint の記録と AI の確認 | F5 の SECURITY DEFINER の関数（持ち主のロール） | 持ち主が `ai_ledger_user_footprint` を呼ぶ |
| ワークスペースの slug | 持ち主のロール | `social_mobile_account_deletion_workspace` は持ち主だけ |
| 利用者（authenticated） | 何もできない | — |

X / Threads の削除との順番: AI の掃除は、利用権の終了（X の saga・provider の adapter・かぶモリの退会がすべて終わった後の :445-447）を合図にする。AI の行と X / Threads の行は重ならないので、互いに止め合わない。

## 5. 本番の前に要ること・本物の Supabase で初めて確かめられること

- 未実装の前提（**本番の前に必須**）:
  1. POSTONA の AI の入口が、利用権と共通アカウントが active のときだけ Claude の経路を認可する（POSTONA の担当。今は相談・試し投稿とも見ていない）
  2. F5 の §4 の変更（AI の段、checkpoint、`residue`）
  3. `social_and_login` の経路の扱い（F3 / G3 / F5）
  4. 後片付けの仕事（`recover_stale` → `abandon`、`purge_content`）の承認と作成（#256 docs §8）
- プライバシー・保持（利用者・運営の判断）:
  - 仮名にした台帳の記録を会計のために残してよいか・何か月か
  - プライバシーの告知
  - **Supabase のバックアップ・PITR**: 消す前の値は、保持期間のあいだバックアップに残る（期間は NOT_VERIFIED）
  - サーバーの記録（PostgREST・DB の記録に RPC の本文として user_id が残りうる。保持は NOT_VERIFIED）
- 本物の Supabase でしか確かめられないこと（NOT_VERIFIED）:
  - PostgREST が SQL の error を返すときの HTTP の形（参照の実装は「2xx 以外は失敗」としか見ない）
  - PostgREST の取引の分離レベルの既定（READ COMMITTED のはず）
  - 本番の migration のロール（`postgres`）が F5 と F6 の両方の持ち主であること
  - 本番の既定の権限
  - 削除の時間（session・Apple・Storage の間に 180 秒が過ぎるか）

## 6. テスト（F6 が追加したもの、deploy しない）

- `supabase/tests/ai_account_deletion_cleanup_contract_test.ts`（偽の RPC、`--deny-net --deny-write`）: **10 PASS**
  - 正常の順番と引数
  - slug の無い人
  - 前提・入力の拒否（大文字の ID、消した人の形、slug と ID の取り違え、運営のブランド）
  - 締め切りの待ち
  - 処理中で止まる（各段）
  - 運用者へ
  - 読み返しが 0 でなければ完了にしない（7 つの数それぞれ）
  - RPC の error は成功にしない（各段）
  - 形の違う答え 14 通りを拒否
  - やり直しは 0 件で完了
- `supabase/tests/ai_account_deletion_cleanup_contract_pg_test.ts`（#249 → #256 → #261 の本物の SQL、ローカルの PostgreSQL、socket だけ）: **5 PASS**
  - 呼び出しの記録・system の行・台帳・自分の枠を持つ人 → `done`、ID・メール・slug がどこにも残らない、2 回目は 0 件で `done`
  - 処理中（自分の claim、ワークスペースの system の claim、台帳の試み）→ その段で `retry_later`
  - 他人の枠が ID を含む → `operator_required` → 直すと `done`
  - 本物の SQL が大文字の ID・slug を ID として・ID を slug として・REPEATABLE READ を拒むこと
- runner: `supabase/tests/ai_account_deletion_cleanup_contract_run.sh`（`/tmp` の下の socket 以外を拒む。TCP なしを確かめる）
- わざと壊した写し（作業用のフォルダだけ、commit していない）: 9 個すべて偽の RPC のテストで検出
  - 読み返しの 0 を見ない
  - `policy_mentions` を読まない
  - RPC の error を飲み込む
  - system の brand を飛ばす
  - 処理中を無視する
  - 運用者向けの理由を再試行にする
  - 締め切りを待たない
  - 余分な key を許す
  - slug を検査しない

## 7. 残課題・follow-up

- F6（#249 の持ち主として、別の作業）: `ai_calls_forget_user` に READ COMMITTED の確かめが無い（#261 で足した 3 つと揃っていない）。大文字の ID を拒むので、参照の実装は小文字に揃えて渡す
- POSTONA: AI の入口での利用権の確認（§5-1）
- F5 / G5: §4 の変更、`social_and_login` の扱い
- 利用者・運営: 保持・プライバシー・PITR の判断
- 本番は **NO_GO**

## 8. F5 / G5 のチャットにそのまま渡す依頼文

````text
【共通AI基盤（F6）からの接続依頼】アカウント削除に「AI の記録の後片付け」をつなぐ（source-only、本番 NO_GO）

■ 何を
共通アカウントの削除の流れに、F6 の 4 つの RPC（service_role だけ実行可）を決まった順番で入れてください。
  1. ai_calls_forget_user({user_id})            … その人の AI の呼び出しの記録を消す
  2. ai_calls_forget_system_brand({brand_ref})   … その人のワークスペース（u_+16進24文字）付きの system の記録を消す
  3. ai_ledger_erase_user({user_id})            … AI の費用の台帳のその人の ID を、元に戻せない「消した人」の ID に置き換える
  4. ai_ledger_user_footprint({user_id, brand_ref}) … 読み返し。policy_mentions を含めて全部 0 のときだけ完了
入出力・error・前提・分離レベル（READ COMMITTED）: docs/ai-provider/F6_F5_ACCOUNT_DELETION_AI_CLEANUP_CONTRACT.md §2
順番と判定は参照の実装 supabase/tests/ai_account_deletion_cleanup_contract.ts の runAiAccountCleanup をそのまま写して使ってください（tests から import しない）。答えは done / wait / retry_later / operator_required / refused / failed。done 以外は成功にしない（その回の削除を止め、後でやり直す。取り消しは不要、何度呼んでも安全）。

■ どこに（F5 の担当の最小の変更、詳細は同文書 §4）
  - account-delete/lifecycle_logic.ts: 全サービスが ended の確認（:445-447）の後、Storage の checkpoint（:504）と prepare（:510）の間に「AI の掃除」。prepare の後（:526）、ログインの削除の外部の段（:530）の前に「最後の掃除」。
  - http.ts の RPC_NAMES に 4 つ。
  - migration: checkpoint の登録表に ai_data_cleanup を足し、set_owned_common_account_deletion_checkpoint が ai_data_cleanup を受け付ける（書く前に SQL の中で ai_ledger_user_footprint が全部 0 かを確かめる）。account_lifecycle_residue に AI の数を足す。
  - ワークスペースの slug は social_mobile_account_deletion_workspace(uuid)（service_role からは呼べない）と同じ式で。user ID と取り違えない。
  - X の saga の social_and_login（finalize が auth.users を直接消す）の経路でも、ログインを消す前に AI の掃除が要る。F3/G3 と扱いを決める。

■ 前提（本番の前に必須、F5 だけでは閉じない）
  - POSTONA の AI の入口が利用権と共通アカウントが active のときだけ認可すること（今は見ていない。POSTONA の担当）。
  - F6 の migration（#249→#256→#261）の本番の適用は未承認。F5 の migration はそれより後。
  - 保持・プライバシー・PITR（バックアップに残る期間）の判断は未決。

■ 進め方
  - 今の F5 の TASK（Phase13 など）を完了・archive した後で、担当のチャットの許可を得て「別の TASK」として登録してください。今の Phase13 の TASK・Report・branch は上書きしないこと。
  - 推奨のモデル: Opus5.5（高）。
  - F6 のテスト（偽の RPC 10 件、本物の SQL 5 件）を、F5 側の写しにも同じ場面で当ててください。
````
