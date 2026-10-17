# F6 AI の費用の台帳に残る利用者 ID の消し方と、アカウント削除の順番（source-only の候補）

- 日付: 2026-10-17（JST）
- task_id: `common-ai-f6-postona-ledger-user-erasure-offline-candidate-20261017`
- 前提: #249（保存の場所 `ai_calls`）、#241（設計）、台帳 `20261010050613`
- 状態: **ソースの候補だけ**。どの DB にも適用していない。本番・Supabase には読むだけでも接続していない。有料の呼び出し・SNS への投稿・Cron の作成・merge・deploy はしていない。本番は **NO_GO**（§9）

## 0. 要約

- 新しい migration の候補 `supabase/migrations/20261017150000_ai_ledger_user_erasure.sql`
  - `public.ai_ledger_erase_user`: 台帳の中のその利用者の ID を、**その削除のたびに新しく作る「消した人」の ID** 1 つに置き換える。金額・回数・状態・時刻などほかの列は 1 文字も変えない（月の合計・予算の数も変わらない）
  - 台帳の「追記専用」の仕組みに、**この置き換えだけ**を通す例外を足した。変わる既存の定義は 2 つだけ（予約の trigger の関数、利用の記録の trigger）。ほかの変更・削除は今までと同じ error で断る
  - `public.ai_ledger_user_footprint`（削除の読み返し用、数だけ）、`public.ai_calls_forget_system_brand`（system の呼び出しに付いた利用者のワークスペースの slug を消す）、`public.ai_calls_recovery_candidates`（止まった呼び出しの一覧、利用者 ID なし）
- F5 / G5 に渡す「アカウント削除への組み込みの決まり」（§6）
- #249 のレビューの P3 のうち TASK に書かれた 3 つへの対応（§7）、保存の場所の定期の後片付けの設計と動く見本（§8、Cron は作っていない）
- 確認: ローカルの PostgreSQL 17 だけで、runner の 10 の部分すべて PASS、わざと壊した写し 26 個すべて検出（§10）

## 1. 今の状態（読み取りで確かめたこと）

- 台帳で利用者 ID を持つ列: `reservations.user_id`、`usage_events.user_id`、`budget_buckets.user_id`（利用者ごとの枠の桶）、`budget_policies.scope_user_id`（特定の利用者だけの枠）。どれも外部キーなし（ログインを消しても連鎖して消えない）
- 守り: `usage_events` は更新・削除を断る trigger（`ai_ledger.reject_change`）、`reservations` は削除を断り、識別の列（`user_id` を含む）を変えさせない trigger（`ai_ledger.reservation_transition`）
- #249 の `ai_calls_forget_user` は保存の場所の行を消すが、台帳は変えられなかった（今回の TASK で解く）
- 共通アカウントの削除（F5、`supabase/functions/account-delete/lifecycle_logic.ts` と migration `20261001150000` / `20261009120000`）には、AI の台帳・保存の場所への手順も、読み返しも**まだ無い**（調査で確認）。§6 で組み込みの決まりを出す

## 2. 消し方の案の比べ

| 案 | 中身 | 問題 | 判定 |
|---|---|---|---|
| A | 削除のたびに新しい「消した人」の ID（ランダム）1 つに置き換える | その人の行どうしのつながりは残る（同じ ID・同じ桶） | **採用** |
| B | すべての消した人を 1 つの固定の ID にまとめる | 桶（`policy, 期間, brand, user` で一意）がぶつかる。桶をまとめると予約の `bucket_ids` が壊れる | 採らない |
| C | 行ごとに別のランダムの ID | 予約の `bucket_ids` が同じ桶を指すので、つながりは消えない。複雑になるだけ | 採らない |
| D | 行を消す | 請求・予算の数が合わなくなる（会計の記録が消える） | 採らない |
| E | `user_id` を空にする | 台帳の決まり（利用者の呼び出しは user_id 必須）を変える | 採らない |

「消した人」の ID の形: `00000000-0000-0000-xxxx-xxxxxxxxxxxx`（version 0。ランダムは 62 bit、`gen_random_uuid()` から取る）。
- 本物の利用者 ID（Supabase Auth は version 4）とは**形が違うので、ぶつかりようがない**
- 見れば「消した人」と分かる（監査で数えられる）
- 台帳の中で使われていないことを確かめてから使う
- 元の ID から計算していない。どこにも元の ID と一緒に保存しない。RPC も返さない → **元に戻す手段が無い**

## 3. 台帳の例外（最小）

- 例外が通るのは、次をすべて満たす更新だけ:
  - `ai_ledger_erase_user` の取引の中だけで立つ印（`ai_ledger.erasure = '<利用者>><消した人>'`、取引が終われば消える）があること
  - その印の利用者の行であること
  - **`user_id` だけ**が、本物の形 → 消した人の形に変わること
- 断るもの（テストで確認）:
  - 印が無い
  - ほかの列も一緒に変わる（金額、状態、遅延の数）
  - 別の利用者の行
  - 本物の形の ID への付け替え
  - 消した人 → 本物（再識別）
  - 消した人 → 別の消した人
  - 削除・truncate（印があっても断る）
- 印を立てても、service_role は台帳の表にそもそも触れない（権限が無い）
- 変わる既存の定義は 2 つだけ: `ai_ledger.reservation_transition`（関数の中身）と `usage_events_append_only`（使う関数を `ai_ledger.usage_events_guard` に）。rollback で元に戻ることを catalog の比べで確認（§10）
- 時刻は残さない: 桶の `updated_at` も変えない（変えると「いつ消したか」が残り、削除の記録と突き合わせて元の人が分かりうるため）。枠は `scope_user_id` を置き換えて無効にする（時刻は変えない）

## 4. RPC（すべて SECURITY DEFINER、`search_path = ''`、service_role だけ）

| RPC | 入力 | 返り値 | 決まり |
|---|---|---|---|
| `ai_ledger_erase_user` | user_id | `{erased: true, reservations, usage_events, budget_buckets, budget_policies}` / `{erased: false, reason: CALL_STORE_NOT_FORGOTTEN \| LEDGER_IN_FLIGHT}` | 保存の場所にその人の行が残っていたら断る（先に forget）。予約・送信中の試みがあったら断る（先に recover_stale）。利用者ごとの lock（保存の場所と同じ）と台帳の予約の lock を取る。最後に、台帳と保存の場所にその人の ID が残っていないことを確かめ、残れば全部取り消す。2 回目は 0 件で成功。消した人の ID は返さない |
| `ai_ledger_user_footprint` | user_id, brand_ref? | 台帳 4 表と保存の場所の、その人の行の数（brand を渡せば brand の行の数も） | 削除の読み返し用。数だけ |
| `ai_calls_forget_system_brand` | brand_ref（`u_` ＋ 16 進 24 文字だけ） | `{forgotten, deleted}` / 処理中なら断る | system の呼び出しで、利用者のワークスペースの slug が付いた行を消す（forget_user は user_id で探すので届かない）。運営のブランド（`ai_salaryman_lab` など）は形が違うので受け付けない |
| `ai_calls_recovery_candidates` | older_than_seconds?, limit? | 古い処理中の呼び出しと、台帳の要約（開いている試み、送った回数、額、最大額か、model、role） | 後片付けの仕事が abandon の audit を作るため。利用者 ID・ブランド・結果は返さない |

## 5. 消しても残るもの（再識別の検討）

| 残るもの | 理由 | 元の人が分かるか |
|---|---|---|
| 消した人の行どうしのつながり（同じ ID・同じ桶） | 案 A。桶と予約の対応（`bucket_ids`）を壊さないため | 利用の時刻・機能・額の並びは残る。外の記録（アプリの記録）と突き合わせれば分かりうるが、その外の記録も削除で消える前提 |
| `request_id`（callId） | 予約の識別。一方向のハッシュ（利用者 ID とアプリの operationId を含む） | 元の利用者 ID と operationId の両方を持つ人だけが「この行はあの人」と確かめられる。両方とも削除で消える前提 |
| `provider_request_id` | Anthropic の請求との突き合わせ | Anthropic 側の記録（送った内容を含む）とつながる。Anthropic 側の保持は NOT_VERIFIED |
| DB の物理的な痕跡（行の版の番号、WAL、Supabase のバックアップ・PITR） | DB の仕組み | superuser・バックアップの保持の範囲で、消す前の値が残る。期間は NOT_VERIFIED |
| サーバーの記録（PostgREST・DB の記録に RPC の引数として user_id が残りうる） | 記録の設定しだい | NOT_VERIFIED |

- 法的な判断（仮名にした記録を会計のために残してよいか、何か月か）は**していない**。保持期間の案（PHASE1B、13 か月）も未承認 → **本番の前の決めごと**（§9）
- 消す前の値を復元する手段はこの候補には無い（rollback をしても消したものは戻らない。テストで確認）

## 6. F5 / G5 に渡す「アカウント削除への組み込みの決まり」

調査で分かった今の削除の流れ（F5 の担当、どれも本番には未適用の候補）:
- 削除の Edge（`account-delete`、service_role）が次の順で進める:
  1. `begin_common_account_deletion`（共通アカウントを `deleting` に）
  2. claim
  3. X の削除（`begin_service_deletion` → X の saga → `finish_service_deletion`）
  4. `withdraw_kabumori_service`
  5. 全サービスの利用権が `ended` かを確かめる
  6. session と Apple の失効、Storage
  7. `prepare_owned_common_account_auth_delete`
  8. ログインの削除
  9. `complete_common_account_deletion`
- 残りの確認（`private.account_lifecycle_footprint` / `residue`）は SQL に決め打ちで、新しい確認を登録する仕組みは無い。新しい checkpoint を書き込む口も、今は `session_revocation` / `storage_cleanup` しか受け付けない

組み込みの案（F6 の RPC はどれも冪等で、順番は RPC 自身が断ることで守る）:

| 段 | いつ | 誰が・何を | 失敗・再試行 |
|---|---|---|---|
| 0 | 前提 | POSTONA の AI の入口（bridge の `authorize`）は、`x_autopost` の利用権と共通アカウントが **active のときだけ**認可する（#241 の設計。POSTONA の担当）。これで `deleting` / `ended` になった後は新しい呼び出しが始まらない | — |
| 1 | 利用権が `ended`（上の 5）になった後 | **待つ**: bridge の最大の締め切り（60 秒）＋余裕（例 2 分）。この間に始まっていた呼び出しが終わる | — |
| 2 | 1 の後 | `ai_calls_forget_user(user_id)` | `CALLS_IN_FLIGHT` → 後片付け（`ai_ledger_recover_stale` → `ai_calls_abandon`、§8）を待ってやり直す。削除の operation は進行中のまま（lease を更新） |
| 3 | 2 の後 | `ai_calls_forget_system_brand(ワークスペースの slug)`。slug は F5 が POSTONA の `social_mobile_account_deletion_workspace(uuid)` で求める | 同上 |
| 4 | 3 の後 | `ai_ledger_erase_user(user_id)` | `LEDGER_IN_FLIGHT` → `recover_stale` を待ってやり直す。`CALL_STORE_NOT_FORGOTTEN` → 2 に戻る |
| 5 | 4 の後 | 読み返し `ai_ledger_user_footprint(user_id, slug)` が全部 0 → F5 が checkpoint を記録（例 `ai_data_cleanup`。**F5 の変更が要る**: 書き込みの口が受け付ける名前と、登録） | 0 でなければ 2 から |
| 6 | ログインの削除の直前（上の 7 の前） | **最後の掃除**: 2〜5 をもう一度（冪等）。F5 の `residue` に AI の数を足し、0 でなければ完了させない（**F5 の変更が要る**） | 0 でなければ 2 から |
| 7 | ログインの削除の後 | 何もしない（ログインが無いので認可されず、新しい行はできない） | — |

- 権限: Edge は service_role の鍵で PostgREST から呼ぶ（5 つの RPC は service_role だけが実行できる）。`residue` は F5 の持ち主のロールで動くので、SQL から `public.ai_ledger_user_footprint` を直接呼べる（同じ持ち主の場合。F5 と F6 の migration の持ち主が同じことが前提）
- 冪等・部分失敗: どの RPC も 1 回の取引で全部か何もしないか。途中で止まっても、最初からやり直せばよい。取り消し（補償）は要らない（消す方向にしか進まない）
- F5 の lease / fence: AI の RPC は F5 の lease を見ない。古い orchestrator が同じ手順を繰り返しても害は無い（冪等）
- epoch: 保存の場所の `lifecycle_version` は監査用だけ。AI の手順は epoch に依らない（利用権の状態だけに依る）
- 記録: F5 の operation には数だけを残す（RPC は利用者 ID 以外の識別子を返さない）
- **注意**: X の saga の `social_and_login` の経路（`social_mobile_account_deletion_finalize`）は、共通アカウントの流れの外で SQL でログインを消す。この経路でも、ログインを消す前に 2〜5 を行う必要がある（F3 / G3 / F5 で確認）

## 7. #249 のレビューの P3 への対応

TASK に書かれた 3 つに対応した。残り 2 つはリポジトリに記録が無く、確かめられなかった（NOT_AVAILABLE）。

| P3 | 対応 | 確認 |
|---|---|---|
| forget_user の後の再 claim | §6 の順番（利用権の停止 → 待つ → forget → erase → 読み返し → ログインの削除の直前の最後の掃除）。`ai_ledger_erase_user` は保存の場所に行が残っていると断り、読み返しが 0 でなければ完了させない | behaviour [9]（遅れて来た claim を読み返しが見つけ、掃除のやり直しで 0 に）、concurrency E4 |
| rollback で行が消える | `supabase/tests/ai_consumer_call_store_rollback_preflight.sql`（読むだけ）: 処理中の claim があるか、24 時間より新しい行があれば rollback を止める。手順: 呼び出し元をフラグで OpenAI に戻す → 60 秒待つ → preflight → rollback | preflight の部分 |
| system ＋ brand_ref | `ai_calls_forget_system_brand`（利用者のワークスペースの slug だけ、system の行だけ、処理中なら断る）と、読み返しの brand の数 | behaviour [7] |

## 8. 定期の後片付け（設計と動く見本。Cron は作っていない）

- 順番（`supabase/tests/ai_call_store_maintenance_mock.ts` の `maintenanceTick`）:
  1. `ai_ledger_recover_stale`（期限切れの予約を返す、長く送信中のものを unknown・最大額に）
  2. `ai_calls_recovery_candidates`（30 分より古い処理中の呼び出し）
  3. 開いている試みが無いものだけ `ai_calls_abandon`。audit は bridge の登録（role / model / policyVersion）と台帳（回数・額・最大額か）から作る。登録に無い機能は推測せず残して報告
  4. `ai_calls_purge_content`（24 時間より古い出力を印に）
- どの段も冪等で、2 回目は何も変えない。送り直しは無い（テストで確認）
- 頻度の案: 5〜10 分ごと。動かすのは service_role の仕事（Edge か専用の worker）。**本番の Cron・仕事の作成は別承認**
- 保持期間の未決: 保存の場所の出力の無い行（ハッシュと監査）をいつまで残すか、台帳の保持期間

## 9. 本番の前に要ること（NO_GO）

1. 法的・保持の判断: 仮名にした台帳の記録を会計のために残してよいか、何か月か。プライバシーの告知への反映（利用者・運営）
2. F5 / G5 の変更: 削除の流れへの §6 の段の組み込み、checkpoint の名前と書き込みの口、`residue` への AI の数の追加、`social_and_login` の経路の扱い
3. POSTONA の AI の入口が利用権を確かめること（#241 の設計どおりに実装）
4. この PR の独立の限られたレビュー（新しい部分だけ: 台帳の例外、4 つの RPC、lock の順番）
5. 本番の適用の承認（台帳・保存の場所・この候補の順に）、後片付けの仕事の承認
6. NOT_VERIFIED: Supabase のバックアップ・PITR・記録の保持、Anthropic 側の保持

## 10. 確認したこと（ローカルの PostgreSQL 17.11 だけ）

- 隔離: `initdb` の使い捨てのクラスタ、`listen_addresses = ''`（TCP なし）、Unix socket だけ。runner が毎回確かめる。`/tmp` の下の socket 以外は拒む
- `supabase/tests/ai_ledger_user_erasure_run.sh` の 10 の部分: **すべて PASS**
  - isolation
  - behaviour: 保存の場所が無い → 断る、持ち主でない → 断る（どちらも catalog 不変）、2 回目の適用は失敗して不変、振る舞いの 10 項目
  - supabase の既定の権限、superuser でない持ち主
  - legacy: この候補を入れた後も、台帳のテスト（18 項目）、#249 の保存の場所のテスト（14 項目）、本物の H5 bridge の e2e（9 件）がそのまま通る
  - concurrency:
    - E1: 同じ人を 20 本同時に消す → 1 本が実行、19 本は 0 件
    - E2: 20 人を同時に消す → それぞれ自分の行だけ、合計は不変
    - E3: 消している最中の予約 → 消し終わるまで待つ
    - E4: 消している最中の claim → 利用者の lock で待つ
    - E3・E4 とも、読み返しと掃除のやり直しで片付く
  - adverse: 危ない権限の形 7 通り → 断る、catalog 不変
  - rollback: 既存の定義で変わるのはちょうど 2 つ、データは不変、rollback で catalog が完全に戻る、消したものは rollback 後も消えたまま
  - preflight（P3）、maintenance（後片付けの見本、2 回目は何も変えない）
- わざと壊した写し（`ai_ledger_user_erasure_mutations.sh`）: **26 個すべて検出**
  - 例外の条件 7、消す RPC 10、保存の場所の補助 6、権限 3
  - 最初は 1 個見逃した（brand の削除が利用者の行も消すもの）→ テストを強めて検出
