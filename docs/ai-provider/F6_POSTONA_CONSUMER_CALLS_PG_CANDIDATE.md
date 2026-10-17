# F6 POSTONA の AI 呼び出しの保存の場所（consumer_calls）: migration の候補とローカルの PostgreSQL での確認

- 日付: 2026-10-17（JST）
- task_id: `common-ai-f6-postona-consumer-calls-pg-offline-candidate-20261017`
- 前提: #241 の設計（`F6_POSTONA_AI_LEDGER_QUOTA_IDEMPOTENCY_DESIGN.md` §4）
- 状態: **ソースの候補だけ**。どの DB にも適用していない。本番・Supabase には接続していない。有料の呼び出し・SNS への投稿・merge・deploy はしていない。本番は **NO_GO**

## 0. 要約

- 新しい migration `supabase/migrations/20261017120000_ai_consumer_call_store.sql`: H5 bridge の「保存の場所」（`ConsumerCallStore`）を DB で実装する表 1 つと RPC 5 つ
- 確かめた場所: このマシンの中だけで動く使い捨ての PostgreSQL 17.11（TCP は開かず、Unix socket だけ。データは作業用のフォルダ）
- 結果: 確認の runner の 10 の部分がすべて PASS。わざと壊した写し 22 個はすべてテストで見つかった（見逃し 0）。本物の H5 bridge と本物の台帳の client を、この DB につないだテスト 9 件も PASS
- **TASK との違い（1 点）**: 表を `ai_ledger.consumer_calls` ではなく、**別の schema `ai_calls.consumer_calls`** に置いた。理由は §1

## 1. 台帳（`ai_ledger`）ではなく別の schema にした理由

- 台帳の migration（`20261010050613`）は「プロンプト・出力・会話は保存しない」ことを決まりにしていて、台帳の振る舞いのテスト（`ai_provider_budget_ledger_behavior.sql` の最後の確認）が `ai_ledger` の中の列名に `content` などが無いことを確かめている
- 保存の場所は、成功した呼び出しのモデルの出力を（消すまでの 24 時間）持つ。台帳に置くと、台帳の決まりを変えることになり、台帳のテストも落ちる（列 `content_purged_at`）。列名を変えてテストだけ通すのは、決まりを破ったまま隠すことになるので採らなかった
- そこで、出力を持つ表は台帳と別の schema `ai_calls` に置き、保持期間・削除も台帳と分けた。台帳は**読むだけ**（abandon で予約が終わっているかを見る、forget_user で台帳に残る行の数を返す）。台帳の表・関数・権限・trigger は何も変えていない（§5 の rollback / legacy で確認）
- 名前: 表 `ai_calls.consumer_calls`、RPC は `public.ai_calls_claim` / `ai_calls_complete` / `ai_calls_abandon` / `ai_calls_purge_content` / `ai_calls_forget_user`（設計の `call_claim` などと同じ働き）

## 2. 表 `ai_calls.consumer_calls`

| 列 | 型・決まり | 意味 |
|---|---|---|
| `call_key` | text 主キー、`^h5m2_[0-9a-f]{64}$` | bridge の callId。**台帳の `reservations.request_id` と同じ値**（台帳の client が callId を request_id に入れる） |
| `tenant_tag` / `fingerprint` | 64 桁の 16 進 | bridge の identity。同じ key で違えば conflict |
| `application` / `feature` | 台帳と同じ識別子の形 | `feature` は **bridge の機能の ID**（例 `postona.consult`。台帳の feature `consult` とは別） |
| `subject_kind` | `system` / `user` | system なら `user_id` と `lifecycle_version` は空 |
| `user_id` | uuid（外部キーなし） | 削除のときに行を探すためだけ |
| `brand_ref` | `^[a-z][a-z0-9_]{1,40}$` | POSTONA のブランドの slug。**監査の表示用だけ**。主体や ID にはしない |
| `lifecycle_version` | bigint ≥ 0 | 利用権を確かめたときの共通アカウントの版（監査用） |
| `claim_token` | uuid、一意 | claim の持ち主（fencing） |
| `state` | `acquired` / `complete` / `abandoned` | 処理中 / 結果あり / 復旧で閉じた |
| `result` / `audit` | jsonb、128KB まで | 結果（BridgeResult）と、その監査（中身の無い数と ID） |
| `created_at` / `completed_at` / `abandoned_at` / `content_purged_at` | timestamptz | |

- 決まり（check）: 状態ごとに埋まる列、主体の組み合わせ、出力を消した行は「UNKNOWN の印」であること、結果の大きさ
- trigger `consumer_calls_transition`: 識別の列は変えられない。状態は acquired → complete / abandoned の前にだけ進む。complete の行は「出力を消して印にする」書き換えだけ
- 索引: 利用者（削除用）、処理中（復旧用）、出力が残っている complete（消す仕事用）
- RLS あり・方針なし。どのアプリのロールにも表・schema の権限は無い

## 3. RPC（すべて `security definer`、`search_path = ''`、実行できるのは `service_role` だけ）

| RPC | 入力 | 返り値 | 決まり |
|---|---|---|---|
| `ai_calls_claim` | call_key, tenant_tag, fingerprint, application, feature, subject_kind, user_id?, brand_ref?, lifecycle_version? | `{kind: acquired, owner}` / `{kind: busy}` / `{kind: conflict}` / `{kind: complete, fingerprint, result}` | 型 `CallClaim` そのまま。新しい key は acquired。identity が違えば conflict。acquired は**何日たっても busy**（時間での横取りなし）。complete / abandoned は保存した結果を返す |
| `ai_calls_complete` | call_key, tenant_tag, fingerprint, owner, result | `{state: complete, duplicate}` | owner と identity が同じ acquired の行だけ。同じ owner が同じ結果をもう一度送ったら duplicate（応答の喪失の後の再試行）。他の owner・abandoned の行は `AI_CALLS_FENCED`、違う 2 回目は `AI_CALLS_RESULT_CONFLICT`、形の違う結果は `AI_CALLS_INVALID_INPUT`。どれも例外 → bridge は UNKNOWN にして送り直さない |
| `ai_calls_abandon` | call_key, audit, older_than_seconds?（300〜、既定 1800） | `{abandoned: true}` / `{abandoned: false, reason}` | 復旧・運用者用。acquired で、決めた時間より古く、**台帳のその call の予約が全部終わっている**ときだけ、UNKNOWN の印で閉じる。audit は台帳と合っていること（送った回数、台帳より少ない額にしない、最大額を含むなら `includes_upper_bound`）。閉じた後、元の owner の complete は fenced |
| `ai_calls_purge_content` | older_than_hours?（1〜720、既定 24）, limit? | `{purged}` | 成功した結果で、完了から時間がたったものの出力を、同じ audit の UNKNOWN の印に置き換える |
| `ai_calls_forget_user` | user_id | `{forgotten: true, deleted, ledger_reservations_retained}` / `{forgotten: false, reason: CALLS_IN_FLIGHT, in_flight}` | アカウント削除用。その利用者の行を全部消す。処理中の行があれば断る。台帳に残るその利用者の予約の数を返す（台帳は変えない） |

結果（result）として受け付けるのは、bridge が実際に保存する形だけ:
- `{ok: true, data, audit}` か `{ok: false, code, audit}`
- code は `POLICY_DENIED` / `COST_DENIED` / `BUDGET_DENIED` / `OUTPUT_REJECTED` / `MODEL_UNAVAILABLE` / `PROVIDER_FAILED` / `UNKNOWN` のどれか
- audit は型 `Audit` の 9 個の key ちょうどで、callId・tenantTag・feature がその行と同じ。回数は 0〜10、額は 0〜1 ドル

## 4. 並行・重複・止まった場所

- ロック: claim と abandon は key ごとの advisory lock → 行の `FOR UPDATE`。complete は行の `FOR UPDATE`。利用者の claim は利用者ごとの共有 lock、forget_user は同じ lock の排他。順番はどこでも 利用者 → key → 行
- 止まった場所ごと（どの場合も**送り直さない**）:

| 止まった場所 | 保存の場所 | 台帳 | 同じ operationId の再送 | 片付け |
|---|---|---|---|---|
| claim の後、予約の前 | acquired | なし | IN_PROGRESS | 30 分後に abandon（費用 0、`no_request`） |
| 予約の後、送る前 | acquired | reserved（期限切れ） | IN_PROGRESS | `ai_ledger_recover_stale` が予約を返す → abandon（費用 0） |
| 送った後、精算の前 | acquired | sent | IN_PROGRESS | `recover_stale`（既定 15 分）が unknown・最大額に → abandon（最大額の audit） |
| 精算の後、complete の前 | acquired | settled / unknown | IN_PROGRESS | abandon（台帳と同じ audit）。出力は失われる |
| complete を書いた後に応答が失われた | complete | 終わっている | 保存した結果 | なし |
| 504・時間切れ | complete（UNKNOWN） | unknown・最大額 | UNKNOWN | なし |
| 上限 | complete（BUDGET_DENIED） | 予約なし | BUDGET_DENIED | なし |

- 運用の順番: `ai_ledger_recover_stale` → `ai_calls_abandon`（audit は台帳の行から作る）。どちらも動かす Cron は作っていない（本番の変更なので別承認）

## 5. 確認したこと（ローカルの PostgreSQL だけ）

### 5.1 隔離

- `initdb` で作った使い捨てのクラスタ（PostgreSQL 17.11、Homebrew）。データは作業用のフォルダ、socket は `/private/tmp/f6cc-sock`
- `listen_addresses = ''`（TCP は開かない）、接続は Unix socket だけ（runner が毎回確かめて記録する）。runner は `/tmp` の下の socket 以外を拒む。`PG*` の環境変数は消してから動く
- Supabase・本番・他の環境には、読むだけでも接続していない

### 5.2 runner（`supabase/tests/ai_consumer_call_store_run.sh`）の 10 の部分

```bash
ACS_PGHOST=/private/tmp/f6cc-sock ACS_PGPORT=54911 ACS_PGSUPER=f6super bash supabase/tests/ai_consumer_call_store_run.sh
```

| 部分 | 確かめたこと | 結果 |
|---|---|---|
| isolation | TCP なし・Unix socket だけ | PASS |
| behaviour | 台帳が無いと断る（何も作らない）、台帳を読めないロールだと断る、2 回目の適用は失敗して何も変えない、振る舞いの 14 の項目（下） | PASS |
| persistence | claim・重複・complete・再送を別々の接続から | PASS |
| supabase | Supabase のような既定の権限（全ロールに ALL）を打ち消し、振る舞いも同じ | PASS |
| nonsuper | superuser でない持ち主（本番の migration のロールと同じ形）で適用して同じ | PASS |
| concurrency | C1: 同じ call の 60 の同時 claim → 持ち主 1・busy 59・エラー 0。C2: 2 種類の中身で 60 → 持ち主 1・conflict 30・busy 29。C3: 持ち主の complete 20 と偽の持ち主 20 → 書き込み 1・duplicate 19・fenced 20。C4: complete と abandon の競争 → 片方だけが勝ち、もう片方もそれに合う。C5: 処理中の claim 15 の最中の forget_user → 待ってから断る、何も失わない（最初の書き手を trigger で 0.5〜1 秒止めて、本当に重ねて確かめた） | PASS |
| adverse | 危ないロールの形 8 通り（持ち主のメンバー、superuser、全データの読み書き、service_role の継承、SET ROLE で service_role へ、2 段の SET ROLE、既定の権限の残り）→ どれも migration が断り、catalog は前と同じ | PASS |
| rollback | 台帳と既存のもの（表・方針・関数・台帳の行）は migration で変わらない。rollback の script で catalog が元に戻る | PASS |
| legacy | 台帳の振る舞いのテスト（18 の項目）が、この migration を入れた後もそのまま通る | PASS |
| bridge | 本物の H5 bridge＋本物の台帳の client（`SupabaseLedgerBudgetGuard`）→ この DB（偽の Anthropic、偽の鍵、通信なし）: 1 回の依頼 = 1 行・台帳の予約 1（request_id = callId）、別の bridge からの再送も送らない、同時の 2 つ → IN_PROGRESS、中身違い → CONTENT_DRIFT、別の利用者は別の呼び出し、complete の喪失（書く前 → IN_PROGRESS → abandon → UNKNOWN、書いた後 → 保存した結果）、504 → 台帳は unknown・最大額、保存は UNKNOWN、上限 → 送る前に BUDGET_DENIED、出力の削除 → 同じ audit の UNKNOWN、削除の後は認可されず送らない | 9 PASS |

振る舞いの 14 の項目（`ai_consumer_call_store_behavior.sql`）: 最初の claim、30 日たっても busy、中身・tenant・利用者・機能の違いは conflict、2 人の利用者の同じ operationId、owner・identity・duplicate・結果の衝突、形の違う結果 21 通り＋結果なしを拒否（128KB を超えるものを含む）、入力の検査（key の形、主体の決まり、slug は user_id にならない、余分な項目は保存しない）、復旧（若すぎる・台帳が終わっていない・audit が台帳と合わない、を拒否 → abandon → fenced → UNKNOWN の再送 → 台帳も同じ attempt を拒否）、送る前の停止（費用 0 で abandon）、504、上限（予約なしで BUDGET_DENIED、枠の無い機能は `NO_MATCHING_POLICY`）、出力の削除、forget_user、表を直接書き換えられないこと、ロール（anon / authenticated は実行できない、service_role も表は読めない）

### 5.3 わざと壊した写し（`ai_consumer_call_store_mutations.sh`）

22 個すべてテストで見つかった（見逃し 0）:
- claim: busy を返さない、中身の違いを見ない、key の lock を外す、利用者の共有 lock を外す
- complete: 持ち主を見ない、結果の形を見ない、2 回目で上書き、行の lock を外す
- abandon: 時間を見ない、台帳を見ない、audit と台帳の一致を見ない、lock を外す
- 出力の削除: 時間を見ない、audit を落とす
- forget_user: 処理中を見ない、他の利用者も消す、lock を外す
- trigger: 何でも通す
- 権限: RPC を authenticated に渡す、表を service_role に渡す、`search_path` を外す、RLS を外す

最初は「key の lock を外す」が見逃された（セッションが重ならず競争が起きていなかった）。最初の書き手を trigger で止めて本当に重ねるように直し、見つかるようにした。

### 5.4 その他

- `supabase/tests/migration_source_invariants_test.ts`（共通、変更なし）: 11 PASS（新しい版の番号は既存・予約と重ならない）
- 共通AI基盤・市況レポート・H5 bridge のテスト: 509 PASS、H5 bridge `offline_run.sh`: 27 PASS（この PR は deploy されるファイルを変えていない）
- 実行していないもの（NOT_RUN）: Supabase の本物の環境での適用、PostgREST を通した呼び出し（本物）、`_shared` 全体の既知の型エラー 5 件・権限で止まる 1 件

## 6. 個人のデータ・削除・保持

- 保存するもの: 不透明な利用者 ID、ブランドの slug（監査用）、ハッシュ、監査の数、成功した呼び出しの出力（**24 時間で消す**: `ai_calls_purge_content` を動かす仕事が要る。Cron は作っていない）
- 保存しないもの: プロンプト、入力、メール、X の ID、鍵。RPC に余分な項目を送っても保存しない（テストで確認）
- `ai_calls_forget_user` は、**その利用者がもう認可されない状態（利用権が active でない）になってから**呼ぶ。そうでないと、削除の後の再送が新しい行を作り、送り直しになる（bridge のテストで、認可が止まった後は送らないことを確認）
- 処理中の行があると断る。先に `recover_stale` → `abandon` で閉じる
- **台帳に残る利用者 ID は、この migration では消せない**（台帳の追記専用の trigger を変えるのは今回禁止）。forget_user はその数を返すだけ。台帳の仮名化は、台帳の変更として別の作業・別の承認が要る（未完了の依存）
- 出力の無い行（ハッシュと監査）の保持期間は未決（今は消さない。重複の防止のために残す）

## 7. 次の TypeScript の実装（別の作業）への決まり

- 保存の場所の adapter は依頼ごとに作り、`application`、**bridge の機能の ID**、主体（利用者 ID）、ブランドの slug を持つ。利用者 ID は bridge の `authorize` と**同じ確認の結果**から取る（別々に取ると、削除のときに行が見つからない）
- RPC の失敗・応答の喪失は例外にする（bridge が UNKNOWN にして送り直さない）
- テスト用の adapter（`ai_consumer_call_store_bridge_e2e_test.ts` の `SqlCallStore`）が参考になる。出すものではない

## 8. ロールバック

- `supabase/tests/ai_consumer_call_store_rollback.sql`（運用者用、migration ではない）。表と RPC を消す。**処理中の claim と保存した結果が失われ、同じ operationId がもう一度送られる**ので、先にすべての呼び出し元を止める
- 台帳の rollback より**前に**行う（RPC が台帳を読むため）

## 9. 本番の前に要ること（NO_GO）

1. この PR の独立のレビュー（権限・並行・課金に限る 1 回。Claude の別の worktree を優先）
2. 個人情報の決まりの正式な調整・プライバシーの告知・有料の利用の承認（利用者）
3. 本番の適用の承認（台帳と同じ流れ: 事前の確認 → 適用 → 読み返し）
4. TS の adapter の実装と、相談の経路のつなぎ込み（フラグ、既定は OpenAI）
5. `recover_stale`・`abandon`・`purge_content` を動かす仕事（Cron、別承認）
6. 台帳の利用者 ID の仮名化（台帳の変更、別承認）と、共通アカウントの削除の手順への `ai_calls_forget_user` の組み込み（F5 / G5）
