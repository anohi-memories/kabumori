# F6 — POSTONA Claude AI 費用台帳・利用上限・重複防止のsource-only設計
- task_id: common-ai-f6-postona-ai-ledger-quota-idempotency-design-20261017
- slot: F6
- owner: claude
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- production_mutation_window: CLOSED
- previous_archive: .agent_v2/archive/2026-10-17-f6-pr239-postona-contract-preflight.md
- dependencies: PR239 POSTONA contract HEAD f590b80fbbaa926be08d5e215ad87b373f402ff2; provider/bridge Draft PR187→198→205→219→222→231→234→237→239; F4+F5 source integration PR238 has focused Auth review pending; G3/F3 reservation boundaries protected.
- user_decision: POSTONAに必要なAI相談・投稿入力をAnthropicへ送る方向は2026-10-17了承、ただし既存personal-data禁止規約の正式調整、プライバシー告知、production/paid APIは未承認。

## 目的
PR239の9件の前提のうち、**POSTONAの利用量・費用台帳、per-user entitlement/quota、永続operationId/idempotency、主体/ブランドの帰属契約**をソースと現在のschemaに基づいて具体化する。開発を前に進めるが、今回はSOURCE-ONLYで本番DBやPOSTONAの既存認証/投稿コードを変更しない。将来のF3/F4/F5/H5 ownerへ明確な実装依頼と検証計画を渡せる状態にする。

## 作業前確認
fresh origin/main、PROJECT_RULES、新旧ORCHESTRATION/ACTIVE_TASK/CURRENT_STATE、旧G6/H5/F3/F4/F5/F6 TASK最新metadata、関連PRの実HEAD/base、migration/DB/Auth/Edge等の重複変更・worktree独立・task_id二重割当を確認。F4+F5 PR238の独立Auth/cross-userレビュー待ちを保護し、F3予約/POSTONA所有コードを編集しない。変更先の所有が不確定ならSTOPして報告する。

## 必須成果物
1. 本番既存のSQL schema/migrations・共通AI台帳/operationId処理/entitlement・POSTONA AI相談と投稿生成・H5 bridgeを**read-only**で調査、source path / symbol / state契約を示す。mainで確認できない本番DB存在はNOT_VERIFIED。
2. POSTONAが持つslug型 `brands.id`（UUIDでない）とUUIDのAI主体の不一致を解く設計案を複数比較し、採用案と移行順、他ユーザー/brand境界・system/Cron主体・削除時扱いを明記。identityを推測やハッシュの逆算に頼らない。
3. DB台帳のschema-only migration草案（**実migration作成・適用は禁止**）、RLS/SECURITY DEFINER/Auth境界、unique operationId、transactional acquire/reserve/settle/readback、crash・parallel・duplicate・504 unknown upper_bound、capでのfail-closed、監査可能性・請求不明の救済を設計。
4. per-user/per-service/per-operation quota、entitlement（F5）とF4 service-endedのepoch/reauth整合、system/cronの適用条件、既存OpenAI経路を変えない段階切替とroll-back、不要なPIIの送信禁止を設計する。
5. 相談→試し投稿→会社員AIラボ→予約投稿の機能別必要変更・owner・依存・オフライン回帰テスト・本番前ゲート・最小独立実装タスク案を出す。F6とH5両方のisolation設定変更が必要になるが、別ownerの変更を勝手に行わない。
6. 既存のコンシューマー/Providerを触らずに済むF6所有のdocs/オフライン純粋テストだけなら追加可能。権限・DB/APIの実実装は禁止。正確な契約がまだ不明なら設計上の未決と記録。

## 変更範囲
許可: `docs/ai-provider/F6_*` の新規/関連文書、競合のないF6-owned非デプロイmock/contract test、F6 TASK/ACTIVE Reportのみ。禁止: 既存migration、DB/RPC/SECURITY DEFINER、Auth/RLS、H5 Bridge、POSTONA/Edge/Cron、F3/F4/F5/J1/G6のファイル、shared isolation/ledger/retry実装、production secrets、merge/deploy/実課金/実SNS投稿。

## テスト・完了
deny-net/fake keysのオフライン契約・境界テスト（実施分のみ）、既存provider/H5/POSTONAへの非変更確認、changed_files、testsのPASS/FAIL/NOT_VERIFIED、PR head/base readback、collision、未決論点、本番NO_GO、次ownerと適切な推薦モデルをReportに記録。既知shared型エラー5件・権限制限テスト1件は未実行ならNOT_VERIFIED。完了はreview_required/next_owner chatgpt、L6。
## Report
- task_id: common-ai-f6-postona-ai-ledger-quota-idempotency-design-20261017
- result: **DESIGN_DONE / SOURCE_ONLY（Draft PR #241）。主体は利用者、重複の防止は台帳の schema の新しい表 `ai_ledger.consumer_calls`、上限は台帳の枠（機能ごとに利用者＋機能全体。広い枠は作らない）、利用権は bridge の `authorize` で確認、切り替えは機能ごとのフラグ（既定は OpenAI）**
  - migration は作っていないし、適用もしていない。SQL は文書の中の草案だけ
  - DB / RPC / SECURITY DEFINER / 認証 / RLS、H5 bridge、POSTONA / Edge / Cron、F3 / F4 / F5 / J1 / G6 のファイル、共通の isolation / 台帳 / 送り直しの実装には触れていない
  - 本番・Secret・設定の変更は 0。有料の呼び出し・deploy・merge・SNS への投稿も 0
- branch / commit / PR
  - `claude/f6-postona-ai-ledger-design-20261017`（独立した worktree `/Users/yuya/Developer/kabumori-f6-postona-ledger-design`、#239 の head `f590b80fbbaa926be08d5e215ad87b373f402ff2` から作成）
  - commit `d7bf96cf10d36cb1894db129d1fd5a3c17586da0`（文書＋テスト）→ `84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6`（上限の枠の直し、文書だけ）。push 済み
  - Draft PR [#241](https://github.com/anohi-memories/kabumori/pull/241)。読み返し: OPEN / Draft、base `claude/f6-postona-claude-contract-20261017`（#239、base の head `f590b80fbbaa926be08d5e215ad87b373f402ff2`）、head `84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6`、2 ファイル、MERGEABLE
  - 読むためだけに fresh main（`f85bfc7012a49d78dc66cce85c8ef1e936f5e96d`）から作った detached の worktree（push していない、変更なし）は片付けた
- changed_files（2）
  - `docs/ai-provider/F6_POSTONA_AI_LEDGER_QUOTA_IDEMPOTENCY_DESIGN.md`（新規）
  - `supabase/functions/_shared/ai_provider/postona_call_store_contract_test.ts`（新規、オフラインの契約の確認だけ。deploy されるファイルからは読まれない）
- 調べた元: fresh main `f85bfc7012a49d78dc66cce85c8ef1e936f5e96d`（読み取り専用の調査の助手 2 つ＋ F6 が要点を自分で確認）、#238 `b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6`（読むだけ）、#239 `f590b80fbbaa926be08d5e215ad87b373f402ff2`
- 今の状態（docs §1。path + symbol + 状態の契約で記載）
  - 費用の台帳 `20261010050613_ai_provider_budget_ledger.sql`: 5 表、7 RPC（security definer、`search_path = ''`、service_role だけ）。合う枠を**全部**満たす必要があり、合う枠が無ければ `NO_MATCHING_POLICY`。`user_id` / `brand_id` は uuid で外部キーなし。**削除・仮名化の手順は無い**（追記専用）。`recover_stale` を動かす Cron は無い
  - 本番は G6 の Phase 1f（2026-10-11 21:31 JST、commit `c2fcdb67952610e1e7b1007bbf37b9e8e534e14b` の Report）で適用済みの記録。枠は市況レポートの system だけ → POSTONA を今つないでも台帳が断る（安全側）。**今の本番の行は確かめていない**
  - POSTONA の `brands.id` は文字列（`u_` ＋ md5 の 24 文字。同じ利用者は入り直しても同じ ID）。owner を 1 人に限る DB の決まりは無い。予約投稿の経路（`vault_account_brand_post.ts`）は owner の利用者を確かめていない
  - 利用権: `common_accounts` / `service_entitlements`（`x_autopost`）。service_role からは読めず、利用者は自分の行の決まった列だけ読める。今、利用権を確かめる Edge の関数は無い。F4 の epoch はアプリの中だけ。F5 の `common_account_brand_service_state`（commit `4638891f`）は main にも #238 にも無い
- 主体とブランド（docs §2）: 5 案を比べた（A 利用者だけ / B `brands` に代理の uuid の列 / C 台帳に文字列の列 / D slug から uuid を計算 / E tenantTag だけ）
  - **採用は A**: 相談・試し投稿は JWT で確かめた利用者（`brandId: null`）、会社員AIらぼは system、予約投稿は F5 の新しい RPC（ブランド → owner がちょうど 1 人 → 利用権が active）で利用者に結びつける。その RPC ができるまで予約投稿は OpenAI のまま
  - ブランドの slug は保存の場所に監査用に残すだけ。D（ハッシュ）と推測・逆算は使わない。ブランドごとの上限が要るようになったら B（POSTONA / F5 の担当）
- DB の設計の草案（docs §4、**schema の草案だけ**）
  - 保存の場所 `ai_ledger.consumer_calls`: `call_key`（bridge の callId = 台帳の `request_id`）、tenant / fingerprint、`user_id`（削除用）、`brand_ref`（監査用）、`claim_token`（fencing）、状態 acquired / complete / abandoned、結果は 128KB まで
  - RPC 5 つ（台帳と同じ流儀）: `call_claim`（advisory lock、期限切れの横取りなし）、`call_complete`（owner と identity を比べる。同じ内容の繰り返しは成功）、`call_abandon`（台帳の予約が終わったものだけ UNKNOWN の印で閉じる）、`call_purge_content`（出力は 24 時間で印に）、`forget_user`（削除のときに行を消し、台帳の user_id を元に戻せない値に。追記専用の trigger の例外は、POSTONA の削除の `kabumori.social_mobile_deletion_lease` と同じやり方）
  - 1 回の依頼の流れ（claim → reserve → mark_sent → 送信 1 回 → settle → complete → 返す）と、止まった場所ごと（7 通り）の扱いを表にした。**どの場合も送り直さない**。504・時間切れは unknown・最大額
  - 請求が分からない分は台帳では最大額のまま。月ごとに `billing_observations` と比べる
- 上限・利用権・切り替え（docs §3）
  - 上限: 1 回（bridge の `maxTotalCostUsd` と枠の 1 回の額）、利用者（日・月）、機能全体（月）。枠はすべて provider・model・application・feature・主体の種類まで絞る。広い枠（application だけ等）は、自分の枠の無い機能や model まで通してしまい許可の一覧が壊れるので作らない（`ai_provider_budget_ledger_initial_policies.sql` と同じ決まり。最初の案にあった POSTONA 全体の枠は、自分で見直して外した）。POSTONA 全体の天井は Anthropic の Console の workspace の上限。枠の数字は案（9 つ、機能全体の月の合計 $28）。上限に当たったら `BUDGET_DENIED` → 相談は `CONSULT_QUOTA_EXCEEDED`。OpenAI に自動で戻さない
  - 利用権: 相談・試し投稿は、利用者の JWT で `x_autopost` と共通アカウントが両方 `active` のときだけ `authorize` が通る（60 秒）。F4 の終了はサーバーでは `ended`。入り直しても利用者の上限はリセットされない
  - 切り替え: 機能ごとのフラグ（既定 `openai`）。戻すときもフラグ。順番は 相談 → 試し投稿 → 会社員AIらぼ → 予約投稿
  - 送らないもの: 利用者 ID、メール、X のハンドル・ID、ブランドの slug、鍵
- 機能ごとの変更・担当・順番（docs §5）と最小の作業の案
  1. F6: 台帳の migration の候補（`consumer_calls`・RPC・権限の確認・`forget_user`）とローカルの PG の証明 — Opus 5.5（高）、レビューは Sol（高）
  2. H5 か F6: 保存の場所の TS の実装 — Opus 5.5（高）
  3. F5: ブランドの owner と利用権の RPC、削除の手順への組み込み — Opus 5.5（高）、Auth のレビュー
  4. POSTONA: 相談の Claude の経路（フラグ、既定は OpenAI）。F6 の isolation の許可と H5 の検査を同時に直す — Opus 5.5（高）
  5. 運用・利用者: 決まりの調整とプライバシーの告知、有料の品質の確認の承認
- collision
  - 新しい 2 ファイルに触れる開いた PR は無い（開いた PR 105 本を確認）
  - 読み返し（すべて OPEN / Draft、head は変わっていない）: #187 `a7e1d3f3f6b3812e9b8b0c0f7c29835e25505d6b`、#198 `4223d5c01389474406291c8e4578207e317638b9`、#205 `4cd2cbdd51a68bc537cd0fc81dc8f1c7ee059f21`、#216 `1dc7b72e3e36ceb75b9acc2ab605244cd8fd2af4`、#219 `be35cc93205fedd6af1321aaeb1fc38d71e9b946`、#222 `11835df1b99f4f3f23006af7f1a27ea6ae51f0e4`、#231 `2a696aff24be01538bd0d9c5a1eb0afa07421483`、#234 `2ba13ee17f75eff129048e630efbd3faa3bd9232`、#237 `d0c85b3e7f1247333ae132a8cc15e2c16bc183bb`、#239 `f590b80fbbaa926be08d5e215ad87b373f402ff2`、#238（F4＋F5）`b8e91ea8eb7c28e44820f15da5f697a9b3d4f8d6`、#182（F3）`1af5047eb70327c252194220df51e94e8a17ff7e`
- tests（Deno、`--deny-net --deny-write`、偽の鍵、本物の鍵の環境変数を外した子プロセス）
  - 新しい `postona_call_store_contract_test.ts`: **5 PASS**（本物の H5 bridge と参照の保存の場所）
    1. 同じ operationId の再送は保存した結果を返し、送らない
    2. 同時の 2 つの依頼: 送信 1 回、もう 1 つは `IN_PROGRESS`
    3. 同じ operationId で中身が違うと `CONTENT_DRIFT`。別の利用者の同じ operationId は別の呼び出し
    4. `complete` の応答の喪失: 書く前なら処理中 → abandon の印で UNKNOWN（送信 1 回のまま）。書いた後なら保存した結果
    5. 出力を印に置き換えても bridge は元の監査のまま受け入れ、送らない
  - 印の監査（`policyVersion` / `tenantTag`）をわざと壊した scratch の写しでは、テスト 4・5 が落ちる（受け入れと拒否を見分けられる）
  - PR の worktree: 共通AI基盤 `_shared/ai_provider/` **158 PASS / 0 FAIL**（新しい 5 件を含む）、H5 bridge `offline_run.sh` **27 PASS / 0 FAIL**、市況レポート **324 PASS / 0 FAIL**
  - main（`2209d798dc8472d5439aca110e0cbe0e2938fcdb`）と合わせた木（merge-tree `4a80a8b78b366e38f03d22ef398a58876f267437`、衝突なし）: 共通AI基盤＋市況レポート＋ bridge（bridge_test + isolation_test）**546 PASS / 0 FAIL**
  - lint（`--no-config`）0 件、`git diff --check` OK、秘密情報の文字列 0（テストの鍵は偽物だけ）
  - `_shared` 全体の既知の型エラー 5 件と権限で止まる 1 件は再実行していない（**NOT_VERIFIED**）
  - SQL の草案はどの DB でも実行していない（**NOT_VERIFIED**。段 1 のローカルの PG の証明で確かめる）
- remaining_issues / 未決
  - 枠の数字、POSTONA 全体の上限を台帳で持つか（「合っても許可にならない上限専用の枠」＝台帳の migration の変更）、AI を別の有料の追加にするか（新しい `service_key`）、ブランドごとの上限が要るか（案 B）、保存の場所の TS の実装の担当（H5 か F6）、台帳の利用者 ID の保持期間と POSTONA だけの削除のときの扱い、出力の保持時間（24 時間の案）
  - NOT_VERIFIED: 今の本番の台帳の行、本番の `brands` の定義（migration に無い）、#238 の後の利用権のふるまい、F5 の `4638891f` の RPC の中身、Anthropic のデータの保持の条件、実際の請求
  - 気づいたこと: 台帳の migration の冒頭と PHASE1D の runbook には「未適用」と残っている（Phase 1f の記録と食い違う古い記述。今回は直していない）
- production: **NO_GO**（個人情報の決まりの正式な調整・プライバシーの告知・有料と本番の利用が未承認。POSTONA の枠も保存の場所も本番に無い）
- next_owner: chatgpt（設計のレビューと、段 1 を F6 に出すかどうかの判断）
- recommended_model: 次の F6（台帳の migration の候補とローカルの PG の証明）は Opus 5.5（高）、独立のレビューは Sol（高）

## L6 判定 2026-10-17
- verdict: PASS_DESIGN / SOURCE_ONLY / PRODUCTION_NO_GO.
- verified Draft OPEN PR241 HEAD `84cfcd4c0b9916bed0f5e2897f24f6ffd4c443e6`, base F6 PR239 branch, 2 files, unmerged. No SQL migration or real DB execution in task.
- reported tests 5 new, provider158/bridge27/market324/integrated546 PASS; ChatGPT independent tests NOT_RUN. Shared five type errors, permission-blocked test, live DB schema & policy NOT_VERIFIED.
- next: proposal for F6 isolated migration candidate + local PostgreSQL proof only; separate authorization for DB/production. Security-critical RLS, SECURITY DEFINER, concurrency and idempotency require single focused independent review before merge/deploy. No production permission.
