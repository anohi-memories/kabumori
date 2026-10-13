# 「AIに聞く」V1 — Phase B0 設計 v3：サーバー・認証・費用境界（J1 R1〜R8 ＋ J2 残件 R2/R3/R8 反映）

- 作成: F1（v2: `kabumori-f1-ai-ask-b0-j1-r1-r8-design-correction-20261013`／v3: `kabumori-f1-ai-ask-b0-j2-r2-r3-r8-correction-20261013`）／ 2026-10-13 JST
- 版: **v3**（v2 = Draft PR #177 head `2f33cffd4754a5576b112623b3aedc2dd31740b8`、v1 = Draft PR #171 head `0beda46186efe1db680909f369e2571609851d81`。本書はそれらの後継で、**PR171／PR177／PR166 のブランチは更新していない**）
- **後継優先関係**: 同名ファイルを PR171（v1）・PR177（v2）・本 PR（v3）が独立に追加している。**正本は v3 > v2 > v1**。PR171・PR177 を盲目的にマージしない（add/add の衝突、または古い設計の復活が起こる）。置換・クローズの判断はオーケストレーター（本 TASK は merge／close／rebase をしない）。
- 基準: `origin/main` `e34b2293758a2ddca32df9b21a050566744258f3`（v3 作成時）、Phase A Draft PR #166 head `83b51efcf3cdb207eb0bab4c6a8dddbc1f5352f4`（未マージ）
- 対応関係は別紙 [`AI_ASK_V1_PHASE_B0_J1_CORRECTION_MAP.md`](./AI_ASK_V1_PHASE_B0_J1_CORRECTION_MAP.md)（PR177・J1 指摘 R1〜R8、テスト T1〜T44）と、本 PR の別紙 [`AI_ASK_V1_PHASE_B0_J2_R2_R3_R8_DELTA_MAP.md`](./AI_ASK_V1_PHASE_B0_J2_R2_R3_R8_DELTA_MAP.md)（J2 残件・**T6／T26／T28／T29／T31／T33／T38／T43／T44 の更新条件はこちらが優先**）。
- 性格: **設計のみ**。コード・DB・Edge・設定・本番・実データ・実 API は変更も実行もしていない。B1（実装）は開始しない。
- この文書が主張しないこと: 本番で動くこと、Auth/RLS/RPC が実装済みであること、費用の確定値、G6 基盤・台帳・G2 migration が本番にあること、セキュリティ上の合格（J1 の限定差分再レビューが要る）。**ここに書く RPC・表・状態は「B1 で実装し、実 PostgreSQL で検証する契約」であり、現存しない。**

## 0. 結論と v1 からの変更点

v1（PR171）の「同期 Edge Function ＋ 小さな DB 境界」の骨格は維持し、J1 が実ソースで反証した 8 点を次のとおり直した。

| J1 | v1 の問題（要約） | v2 の設計（節） |
|---|---|---|
| R1 P1 | 台帳ポリシーの `enabled=false`／`scope_user_id` を停止・canary の境界にしていた。台帳の `enabled=false` は「拒否」ではなく「制約から除外」 | **アプリ専用の権威的ゲート**（deny-by-default の許可リスト）を DB に置き、begin／replay／dispatch 直前／finish の 4 点で再評価。OFF の線形化点と「送信済みは取り消せない」上限を明記（§3） |
| R2 P1 | トランザクション advisory lock は RPC の commit で解放され、Edge の処理中は守れない。TTL の切れた再送が再課金になり得る。回答だけをキャッシュしていた | **永続の要求行＋状態機械**（claim／lease／CAS）、ユーザー単位の永続 1 件ガード、payload digest、tombstone。V1 は送信 1 回・自動再試行なし（§4） |
| R3 P1 | `authenticated` は匿名 Auth ユーザーを含む。セッション失効・アカウント状態・退会の遅延完了が未定義 | 永続ユーザーのみ受理、セッション失効の扱い（受容遅延を明示）、common account／entitlement／profile／同意の**ライフサイクル版数フェンス**、RPC の ACL 表（§5） |
| R4 P1 | ID の存在と数値の部分一致では根拠づけにならない。`facts=[]` や質問由来の数値が通る | **V1 は抽出的**: モデルは証拠 ID の選択だけ。事実文・数値・出典・時点はすべてサーバーの証拠から生成。モデルが書く事実文は無い（§7） |
| R5 P1 | scope 別の読み取り・送信の許可が無く、市況質問が個人データの迂回路になり得る | **scope → データ源 → 項目射影の許可表**。個人データの読み取りは同意確認の後。自由文の PII は拒否（best-effort と明記）（§6） |
| R6 P2 | 時点 null／未来を許容。保有 30 件の打ち切りを全体として扱う | 下限・上限つきの時点検査、null/未来は除外、完全性（件数・数量・終値・信用/売り・登録変更）を満たさなければ構成比を出さない（§8） |
| R7 P2 | 費用を「6,000 トークン」の名目値で試算。実際の台帳予約は UTF-8 バイト＋2,048 | **バイト上界の固定契約**（モデル・出力上限・タイムアウト・入力バイト上限）。実コードで算出した上界を表に固定（§9） |
| R8 P2 | B1-a/b が §8 だけでは並行で作れない（finish/replay の権限・公開列・状態が未定義） | **共通契約 v1（凍結案）**: 入力境界・RPC 表・公開応答・エラー/unknown/pending・keyPoints 写像（§10） |

**要点（再掲）**: ① 停止と許可は DB の権威的ゲート。② 1 つの論理要求は最大 1 回しか送信しない（不明なら送信済みとして扱い、再送しない）。③ 外部 AI は「どの証拠が関連するか」を選ぶだけで、画面の事実文は一切モデルが書かない。④ 費用はバイト上界で固定し、承認前は全て OFF/0。

### 0.1 v3 の変更（J2 の限定再レビューで残った 3 件。R1／R4／R5／R6／R7 の PASS 条件は変更していない）

| J2 | v2 の残件（要約） | v3 の設計（節） |
|---|---|---|
| R2 P1 | authorize／finish の CAS に **live な `lease_until`** と **現在の `active_request_id` との一致**が無く、失効した所有者と新しい所有者を区別できない。別 ID の takeover・遅延 worker・`=` 境界・同 ID の token 回転が未定義 | **§4.3 共通ロック順**（L1〜L8）と **§4.4 CAS 述語**（`lease_until > now` を厳密、`=` は失効）。期限切れ claimed の別 ID は takeover（失敗終端化して受付）、live は reject、dispatching の失効は `unknown_after_send`（再送しない）。古い worker の遅延 authorize／finish は状態・token・epoch・slot の CAS で拒否。同 ID の回転は失効後のみ（§4.5〜4.7） |
| R3 P1 | request 行の `FOR UPDATE` と actor の通常 SELECT だけでは、別行（共通アカウント・同意）の撤回と TOCTOU になる（J2 の PG 反例 `deleting`/`answered`/`checked-v1`） | **§5.3**: 権威行 L1〜L5 を**所有者（F5）の既存ロック順**で共有ロックし、判断と保存を**同じトランザクション**で行う。撤回・ライフサイクル変更・authorize・finish の線形化点を表で固定。外部 HTTP 中は DB トランザクションを保持しない。F5 のロック順を調査し、競合なし／前提条件を明示 |
| R8 P2 | evidence.kind → Source.kind → Phase A union が不一致、`pending` が DB と client で別実装になり得る、内部 outcome と公開 union が未分離 | **§7.2／§10**: Source.kind は Phase A の `news｜report｜market_data｜holding` を**型変更なしで維持**し、`market_report → report` を含む全写像を固定。公開 `AskResponse` は **Phase A の union をそのまま**（`pending` 無し・`remainingToday`／`message`／`retryable` を撤回）。v1 の処理中は `failed` ＋ `in_progress`。内部 outcome と公開 union の写像表 |

v3 では **実 PostgreSQL 17（使い捨て・Unix ソケットのみ・合成データ）で、上の R2／R3 の契約を最小のモデルとして 2 接続以上で検証**した（別紙 §4・付録）。モデルは B1 のコードではなく、**契約が反例を閉じること**と**テストが契約違反（ミュータント）を検出できること**の確認である。

## 1. 根拠（read-only で再照合した事実）

v1 の §1.1 の再利用判断は維持。照合した事実は次のとおり。S1〜S10 は v2 作成時の `origin/main` `7fe597cb`、S11〜S15 は v3 作成時の main（`5271223b` を clone して読み取り）と PR166／PR152 の diff を読んだもの。

| # | 事実 | 根拠 | 設計への影響 |
|---|---|---|---|
| S1 | 台帳の予約は `(request_id, attempt)` で一意。**既存の予約は方針の照合より前に返る**。`reserved` の保留は再取得でき（送信許可ではない）、`sent` は `ATTEMPT_IN_FLIGHT`、確定済みは `ATTEMPT_FINALIZED` で拒否 | `20261010050613_ai_provider_budget_ledger.sql:457-479`（予約の再利用 `:469`、確定済みの拒否 `:475`） | 停止は台帳では実現できない（§3）。再送の再予約は新 callId 名前空間が要る（§4） |
| S2 | 方針の対象は `where pol.enabled and (scope_* is null or = …)`。**一致する有効な方針が 0 件なら `NO_MATCHING_POLICY`（拒否）** | 同 `:482-497`（`NO_MATCHING_POLICY` は `:495-496`） | `enabled=false` は「除外」。許可リストとして使えない。方針の**欠如**は拒否になるのは事実だが、広い方針があれば他ユーザーも通る |
| S3 | `mark_sent` は状態と期限だけを見る。方針の更新は見ない | 同 `:651-680` | OFF 後も既存の保留は送れる。ゲートは dispatch 直前に別途必要 |
| S4 | 台帳 RPC は `service_role` のみ EXECUTE（`public/anon/authenticated` から REVOKE） | 同 `:957-967` | ユーザートークンで台帳を呼ばない |
| S5 | `callId` は台帳の `request_id`（`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`）にそのまま入る。`AiRequest.callId` は `IDENTIFIER` 検査を通す | `ledger_guard.ts:131`、`execute.ts:75-76`、migration `:217` | callId の形式を本書で固定できる（§4.5） |
| S6 | `AiTransportPolicy { maxAttempts 1〜3, retryOnTimeout? }`。送信前の拒否（`REQUEST_INVALID`〜`BUDGET_DENIED`・`DEADLINE_EXCEEDED`）は「請求され得ない」と型に明記 | `types.ts:36-49, 76-92` | V1 は `maxAttempts:1, retryOnTimeout:false`。送信前エラーだけが「未送信」の証拠になる（§4.4） |
| S7 | 入力トークン上界 = 指示＋本文＋スキーマ JSON＋スキーマ名の **UTF-8 バイト** ＋ `INPUT_TOKEN_OVERHEAD`(2,048)。コスト上界 = 入力上界×入力単価 ＋ `maxOutputTokens`×出力単価 | `cost.ts:14, 37-58` | 費用は「バイト上界」で設計する（§9）。推論トークンは `maxOutputTokens` に含まれる |
| S8 | `common_accounts(status ∈ active/deleting/locked, lifecycle_version≥1)`、`service_entitlements(service_key ∈ kabumori/x_autopost, status ∈ provisioning/active/suspended/deleting/ended)`。`authenticated` は列限定の SELECT のみ。**`lifecycle_version` は、アカウント状態または entitlement が変わるたびにトリガが自動で +1 する（不変条件 I7）。減らせない** | `20261001150000_common_account_lifecycle_foundation.sql:48-49, 224-250, 341-345, 410-427, 462-472` | ライフサイクルの版数フェンスが成立する（§5.3） |
| S9 | かぶモリのサービス終了は「`profiles` 行が消えるまで」完了しない（`account_lifecycle_footprint.kabumori = exists(profiles)`）。`tracked_stocks` は `profiles.id ON DELETE CASCADE` | 同 `:567-590`、`20260901061217_add_kabumori_mvp_tables.sql:19-47` | AI Ask の新表は **`profiles(id) ON DELETE CASCADE`** にぶら下げれば、共通アカウント側の終了処理（F5 所有）を変えずに連動削除できる（§5.4） |
| S10 | 台帳の利用記録は不透明な user UUID を持つが `profiles` への FK は無い | ledger migration | 台帳の行は退会で消えない（運用上の保持）。D7 で明示（§5.4・§15） |
| S11 | Phase A（PR166）: `AskSourceKind = 'news'｜'report'｜'market_data'｜'holding'`、`AskResponse = answered{answer, keyPoints(0..5), sources, generatedAt, dataAsOf, usedHoldings}｜refused{reason}｜failed{code}`（**`message`・`retryable`・`remainingToday` は無い**）、`AskFailureCode` は 7 値の閉じた型、`isRetryable` は `network/timeout/server_error` のみ、`ASK_QUESTION_MAX_CHARS=300`、`makeClientRequestId = ask-<now の 36 進>-<6 桁 hex>`（約 19 文字）、`dataAsOf` の注釈は「newest」 | PR166 `src/lib/ai-ask.ts:28, 34-71, 74, 130-133, 227-249`（head `83b51efc`） | wire 型は §10 で Phase A の union に**そのまま**合わせる。v2 が足した `message`／`retryable`／`remainingToday` は撤回（§10.2）。`dataAsOf` の意味変更（newest→oldest）は B1-c の同期対象 |
| S12 | **共通アカウント所有者（F5）の既存ロック順（I1）**: ① `auth.users` を `FOR KEY SHARE`（readiness の確認のみ `FOR UPDATE`）→ ② `common_accounts` を `FOR UPDATE` → ③ `service_entitlements` を `FOR UPDATE`。**READ COMMITTED 必須**。全ての lifecycle RPC は `private.account_lifecycle_lock` を最初に呼び、ロックはトランザクション終了まで保持 | foundation migration `:364-392`（lock 関数）、`:811-819`（start）、`:956-962`（begin_service_deletion）、`:1008-1012`（finish）、`:1109`（account deletion）。`20261006230000_…service_start_intent.sql:95-103, 142-160`、`20261009120000_…deletion_completion.sql` の各 RPC（`:238, :287, :330, :350, :378, :445, :479, :685`）も同じ入口 | AI Ask の authorize／finish／replay は**この順序の部分列**（L1 `common_accounts` → L2 `service_entitlements` → L3 `profiles` → AI Ask 自身の行）でロックする（§4.3）。`auth.users` は取らない |
| S13 | かぶモリのサービス終了（`withdraw_kabumori_service`）は**1 トランザクション**で、`begin_service_deletion`（S12 の順で account／entitlement を `FOR UPDATE`）→ `delete from public.profiles`（CASCADE）→ `finish_service_deletion`。`profiles` の削除は常に L1 を保持した後に起きる | foundation migration `:1083-1096` | AI Ask の新表（`profiles` に CASCADE）は L3 より後ろ＝所有者の順序と矛盾しない。authorize／finish が L1 を `FOR SHARE` で保持している間、終了処理は待たされ、先に commit した側が合法な履歴になる（§5.3） |
| S14 | F5 の未マージ Draft（#152 `common_account_core_service_fence`、#165、#178／#183）も同じ I1 順序を文書化。#152 の `private.account_lifecycle_service_state_refusal(p_user_id, p_service_key)` は L1・L2 を **`FOR UPDATE`**・`lock_timeout='3s'` で取り、固定コードを返す。#152 の writer guard は**生きた `auth.sessions` 行**も確認する（D9 の S2 の先例。**未マージのため前提にしない**） | PR #152 の migration 追加行（diff `:1041-1095`）、docs `phase4-core-integration.md`（diff `:63-69`） | B1-a は「S12 の順序・READ COMMITTED・`lock_timeout`」を契約とし、F5 述語が main に入った後に置換できるかは**要調整**（§5.3.4）。ロック順の変更は F5 側に求めない |
| S15 | 台帳 `request_id` は text 128 文字・許容文字 `[A-Za-z0-9_.:/-]`。AI Ask の callId は **内部 `request_id`（uuid）由来**にすれば、tombstone の満了・行の再作成で台帳の `ATTEMPT_FINALIZED`／`ATTEMPT_IN_FLIGHT` と衝突しない（§4.4） | migration `:217`、S1 | 保持期間満了後の同一 `clientRequestId` は**新しい論理要求**になり、台帳でも別 callId になる |

### 1.1 NOT_RUN / 未確認（v1 から変わらず）

- 本番の DB・Edge・Cron・Secrets の状態（台帳 migration・G2 migration の適用、ゲートの値、`verify_jwt`、JWT 有効期限、プロバイダーキー、組織の支出上限）。
- G6 派生 PR（#148→#150→#153→#157）の中身。本設計は main の `ai_provider/` のみに依存する。
- 実プロバイダーの応答・遅延・実費・保持期間。単価は G6 カタログ（`ai-provider-catalog/2026-10-10.1`、`verifiedOn: 2026-10-10`）の引用で、請求の根拠ではない。

## 2. 構成と信頼境界

```
iPhone アプリ（/ai）
  ① get_ai_ask_status()                       … 受付可否・残り・同意状態（RPC・本人のみ）
  ② POST /functions/v1/ai-ask  Bearer <JWT>    { version:1, question, scope, tickerCode, clientRequestId }
  ▼
Edge Function `ai-ask`（関数内で必ず本人確認。ゲートウェイの verify_jwt に依存しない）
  E1 入力境界（本文バイト・深さ・キー・ID 形式・質問の正規化）
  E2 Auth: 静的キー拒否 → /auth/v1/user → 永続ユーザーのみ（§5.1）
  E3 begin_ai_ask   [ユーザートークン・auth.uid()]   ← 短い DB トランザクション①: ゲート/ライフサイクル/同意/冪等/1件ガード → claim（token・owner_epoch・lease）
  E4 証拠の組立       [ユーザートークン・RLS]          ← scope 射影（§6）のみ。DB トランザクションは保持しない
  E5 authorize_ai_ask_dispatch [service_role]        ← 短い DB トランザクション②: 同じロック順で権威行を共有ロック → 全述語を再評価 → dispatching（lease 更新・日次消費）
  E6 executeAiRequest（G6）  [transport 1回・callId 固定]  ← **DB トランザクションは保持しない**（外部 HTTP の待機中）
  E7 検証・テンプレート描画（§7）
  E8 finish_ai_ask  [service_role]                  ← 短い DB トランザクション③: 同じロック順・CAS（token・owner_epoch・live lease・slot）・述語の再評価と保存を**同一トランザクション**で
  ▼
AskResponse（事実文・出典・時点はサーバー生成。形は Phase A の union そのもの。§10）
```

信頼境界の規則:

1. **DB が権威**。Edge は状態を持たない（モジュール変数・メモリにユーザー単位の状態を置かない）。ゲート・上限・冪等・1 件ガード・同意・ライフサイクルは DB の RPC で決める。**判断と保存は 1 つの短い DB トランザクションの中で、権威行を保持したまま行う**（§4.3・§5.3）。外部 AI への HTTP 呼び出しの間は DB トランザクションも行ロックも保持しない（状態は `dispatching`＋lease で持つ）。
2. **サービスロールは E5・E8 と台帳のみ**。保有・ニュース・市況の読み取りは常にユーザートークン（RLS）。サービスキーで「誰かの保有」を読む経路は作らない。
3. 外部 AI へは scope 射影（§6）を通った項目だけを渡す。モデルの出力は**選択（ID の列）だけ**として扱い、画面の文は全てサーバーが生成する（§7）。
4. **同期のまま**とする理由は v1 と同じ（出力が小さく、キュー・worker・通知を増やさない）。長い応答／混雑時の `pending`＋ポーリングは **v2 契約の別 TASK**（§10.5）で、v1 の `timeout` の置換としては導入しない。

## 3. 制御面：権威的ゲート・許可リスト・停止の線形化（R1）

### 3.1 v1 の誤りと、実ソースが示す事実

台帳の方針は「適用される制約の集合」を決めるもので、拒否の主体ではない（S2）。したがって次の v1 の想定は成立しない。

| v1 の想定 | 実際（S1〜S3・J1 の反例） |
|---|---|
| `enabled=false` にすれば台帳が拒否する | 無効化した方針は**制約から外れる**。他の有効な広い方針が残れば許可される（制限が緩む方向） |
| `scope_user_id=A` の方針で A だけを canary にできる | その方針は A にしか効かない。広い方針が B にも一致すれば **B も予約できる** |
| `max_calls=0` にすれば既存の保留も止まる | 既存の予約は方針照合より前に返る。**cap 0 の後でも保留は `may_send=true` で送れる** |

### 3.2 権威的ゲート（アプリ専用）

DB に次を置く（B1-a の契約。すべて既定 OFF／deny）。

```
ai_ask_settings (id boolean pk default true,
                 enabled               boolean not null default false,
                 access_mode           text    not null default 'deny_all'
                                        check (access_mode in ('deny_all','allowlist','all_enrolled')),
                 daily_limit_per_user  int     not null default 0 check (>= 0),
                 minute_limit_per_user int     not null default 0 check (>= 0),
                 settings_epoch        bigint  not null default 1,   -- 更新のたびに増える（トリガ）
                 updated_at            timestamptz)
ai_ask_allowlist (user_id uuid pk references profiles(id) on delete cascade, added_at timestamptz)
```

ゲート関数 `private.ai_ask_gate(user_id)` は次を**この順に**評価し、最初に成立したものを返す（fail-closed）:

| 順 | 条件 | 結果 |
|---|---|---|
| 1 | 設定行が無い／読めない | `disabled` |
| 2 | `enabled = false` | `disabled` |
| 3 | `access_mode = 'deny_all'` | `disabled` |
| 4 | `access_mode = 'allowlist'` かつ本人が `ai_ask_allowlist` に無い | `not_allowlisted` |
| 5 | `daily_limit_per_user = 0` | `limit_zero` |
| — | 上のいずれでもない | `allowed` |

- `all_enrolled` は公開段階（G7）専用。D4/D6 の承認前は設定できない運用とする（B1-a の CHECK ではなく運用ゲート。変更は operator のみ・service_role のみ）。
- 公開応答は理由を区別しない（`unavailable` のみ）。理由は内部の監視用コードにだけ残す（質問・回答・ユーザー ID は出さない）。

### 3.3 評価点（4 点）と OFF の線形化

| 評価点 | どこで | OFF 後の挙動 |
|---|---|---|
| G-begin | `begin_ai_ask`（新規 claim・同一 ID の再開） | `unavailable`。claim は作らない |
| G-replay | `begin_ai_ask` の再生分岐、`get_ai_ask_result` | **保存済み回答も返さない**（`unavailable`）。キャッシュ回答は停止後に出さない |
| G-dispatch | `authorize_ai_ask_dispatch`（E5・送信の直前） | 状態を `cancelled` に倒し送信しない |
| G-finish | `finish_ai_ask`（E8） | 送信済みの結果は**破棄**（`cancelled`、回答を保存・返却しない） |

線形化点は **`ai_ask_settings` の更新トランザクションの commit**。`authorize_ai_ask_dispatch` は設定行を `FOR SHARE` で読み、更新側は行の排他ロックを取るため、2 つは全順序になる:

- OFF の commit **より前**に authorize が commit した要求は「承認済み」として最大 1 回だけ送信され得る。
- OFF の commit **より後**には、新しい authorize・新しい claim・replay は成立しない。
- **すでに外部へ送信した呼び出しは取り消せない**（プロバイダーに届いたもの・課金は戻らない）。OFF が保証するのは「新しい送信の停止」であり「万能の即時キャンセル」ではない。

OFF 後に残り得る送信の上限 ＝ OFF 時点で `dispatching` にある要求数 ≤（1 ユーザー 1 件ガード × 対象ユーザー数）。許可リスト運用（G6 の社内 canary）なら許可リストの人数 × 1 回の上界（§9）。

### 3.4 台帳ポリシーの位置づけ（コスト上限としてのみ使う）

| 台帳側の設定 | 役割 | 停止・許可リストに使うか |
|---|---|---|
| `feature='ai_ask'` の全体 日次・月次 `max_estimated_usd`（有効） | 全体の費用上限 | しない（上限のみ） |
| `per_user` 日次 `max_calls`（有効） | 本人の 2 重目の回数上限（DB の日次カウントと同値） | しない |
| `max_usd_per_call`（有効） | 1 回の上限。§9 の上界以上に置く | しない |
| `enabled=false`／`scope_user_id` | **使わない**（除外であって拒否ではない／他ユーザーに効かない） | しない |
| `max_calls=0` の有効な方針 | 緊急時の追加の止め弁（OFF 手順の 2 番） | 補助のみ。既存の保留は止まらないので、権威は §3.2 |

### 3.5 OFF／rollback の順序

1. `ai_ask_settings.enabled = false`（線形化点）。以後、新規 authorize・claim・replay は拒否される。
2. 台帳の `feature='ai_ask'` に **有効な** `max_calls=0` 方針を追加（新規予約の遮断。補助）。
3. **ドレイン**: 非終端（`claimed`/`dispatching`）の要求を一覧し、`lease_until` を過ぎるまで（`timeoutMs`＋余裕）待つ。残った保留は台帳の `recover_stale`／`release` で確定。
4. 不明（`unknown_after_send`）は台帳と突合し、請求の可能性として記録。
5. **破壊的な取り消し（表の DROP）は、ドレインと保持期間（§4.7）の後だけ**。ゲート OFF だけでは、外部へ送信済みのデータも既に発生した課金も消せない。B1-a は取り消し SQL を用意し、実 PostgreSQL で CASCADE と共通アカウント削除の所有（S9）を検証する。

## 4. 永続リクエスト状態機械・冪等・1 件ガード（R2）

### 4.1 v1 の誤り

- advisory lock は `begin` の RPC が commit した時点で解放される。証拠の組立・プロバイダー呼び出しは RPC の外なので、**別の `clientRequestId` の 2 件目が 1 件目の処理中に通る**（J1 PG 反例）。
- 台帳は `(request_id, attempt)` 単位。送信後・不明のあとでも attempt 2 は予約できる（S1）。アプリが「attempt を足して再実行」すると**二重送信**になる。
- 再生キャッシュ（15 分）の削除で、同じ ID の再送が「新規」になり**再課金**される。応答を保存するのは `answered` だけで、拒否・課金済みの失敗は再生できなかった。

### 4.2 表（B1-a の契約）

```
ai_ask_user_state  (user_id uuid pk references profiles(id) on delete cascade,
                    active_request_id uuid null)             -- 唯一の「slot」。lease は request 行だけが持つ（二重管理しない）

ai_ask_requests    (request_id uuid pk default gen_random_uuid(),   -- 内部 ID。台帳の callId の元（§4.5）
                    user_id uuid not null references profiles(id) on delete cascade,
                    client_request_id text not null check (client_request_id ~ '^[A-Za-z0-9_-]{16,64}$'),
                    payload_digest bytea not null check (octet_length(payload_digest) = 32),
                    scope text not null,
                    state text not null,                            -- §4.4
                    owner_epoch bigint not null default 1,          -- 所有権の世代。回転・takeover・再 claim のたびに +1
                    claim_token uuid not null,                      -- 所有者の秘密。回転のたびに更新
                    lease_until timestamptz not null,               -- この要求の**唯一**の期限
                    send_epoch smallint not null default 1 check (send_epoch between 1 and 2),
                    begin_lifecycle_version bigint not null,        -- claim 時の common_accounts.lifecycle_version
                    begin_consent_epoch bigint not null,            -- claim 時の consent_epoch
                    counted_jst_day date null,                      -- 日次を消費した JST 日（消費前は null）
                    outcome_code text null,                         -- 内部コード（公開コードとは別）
                    finish_digest bytea null,                       -- finish の冪等判定用（同じ終端の再送を識別）
                    public_response jsonb null,                     -- 保護列。期限後に NULL へ
                    response_expires_at timestamptz null,           -- 終端 +15 分（D3）
                    tombstone_until timestamptz not null,           -- 終端 +48 時間（提案・D10）
                    created_at, dispatch_authorized_at, terminal_at,
                    unique (user_id, client_request_id))

ai_ask_daily_usage (user_id uuid references profiles(id) on delete cascade, jst_day date,
                    dispatches int not null default 0, primary key (user_id, jst_day))
```

- **日次カウントは `ai_ask_daily_usage`**。回答キャッシュ・tombstone の削除とは独立で、TTL の削除でカウントが戻ることは無い。
- `client_request_id` は 16〜64 文字の `[A-Za-z0-9_-]`。Phase A の `makeClientRequestId` は `ask-<now の 36 進（現在 8 文字）>-<6 桁 hex>`（約 19 文字。PR166 `ai-ask.ts:130-133`）で**この形式を満たす**。クライアントは送信ごとに新しい ID を作り、再試行では**同じ質問・同じ ID**だけを再送する（Phase A の reducer の既存契約）。
- lease は **request 行の `lease_until` だけ**が持つ。v2 の `ai_ask_user_state.active_lease_until` は廃止（slot と request で期限が食い違う余地を残さない）。

### 4.3 共通ロック順（begin／authorize／finish／期限整理／replay／同意／所有者の削除）

R2（所有権の CAS）と R3（撤回との直列化）は**同じ固定順序**を使う。所有者（F5）の既存順序（S12：`auth.users` → `common_accounts` → `service_entitlements`、READ COMMITTED）の**後ろに AI Ask の行を連ねた**もので、所有者の順序と矛盾しない。

| 段 | 行 | AI Ask の取り方 | 変更する側（排他） |
|---|---|---|---|
| — | `auth.users` | **取らない**（所有者が先頭で `KEY SHARE` を取る） | 所有者 |
| L1 | `common_accounts(user_id)` | `FOR SHARE` | 所有者の全 lifecycle RPC（`FOR UPDATE`）、状態変更のトリガ（`NO KEY UPDATE`） |
| L2 | `service_entitlements(user_id, 'kabumori')` | `FOR SHARE` | 所有者（`FOR UPDATE`）。直接の operator SQL でも I7 のトリガが L1 を更新するので L1 で直列化される |
| L3 | `profiles(id)` | `FOR KEY SHARE`（プロフィールの通常編集は妨げない） | サービス終了（`DELETE`） |
| L4 | `ai_ask_settings`（＋許可リスト） | `FOR SHARE` | operator の設定／許可リスト変更（許可リストの変更も L4 の設定行を `FOR UPDATE` で取るので、許可リストの読み取りは L4 の共有ロックの下で一貫する） |
| L5 | `ai_ask_consents(user_id)`（ユーザーあたり 1 行・`consent_epoch` を持つ） | `FOR SHARE` | 同意・撤回（`FOR UPDATE`） |
| L6 | `ai_ask_user_state(user_id)` | `FOR UPDATE` | AI Ask の書き込み系 RPC のみ |
| L7 | `ai_ask_requests(request_id)` | `FOR UPDATE`（replay の読み取りは `FOR SHARE` または無ロック） | 同上 |
| L8 | `ai_ask_daily_usage(user_id, jst_day)` | `FOR UPDATE`（原子的な加算・払い戻し） | 同上 |

**規則**

1. **昇順でのみ取得**する。必要な段だけを取ってよいが、**下位の段の待ちを上位のロックを持ったまま行わない**（L7 を持って L1 を待たない）。
2. **READ COMMITTED**（所有者の要求。違えば fail-closed）。`lock_timeout = 3s`（F5 の #152 と同じ値）。タイムアウト・デッドロックは**状態を変えずに安全拒否**（公開は `unavailable`、要求は lease 切れで整理される）。
3. 時刻 `v_now := clock_timestamp()` は**最後のロックを取得した後**に 1 回だけ取り、その RPC の全ての lease 比較に使う（ロック待ちの間に時刻が進んでも、判断と保存が同じ `v_now` で行われる）。
4. これらの RPC は**外部 HTTP・台帳 RPC を呼ばない**。1 つの RPC ＝ 1 つの短いトランザクション。外部 AI の待機中は DB のロックを何も保持しない。
5. 同じユーザーの L7 行は、書き込み系が必ず L6 を先に取るため**L6 で直列化**される（複数の request 行を同時に触る begin の整理でも順序問題は起きない）。

| RPC | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 |
|---|---|---|---|---|---|---|---|---|
| `begin_ai_ask` | S | S | KS | S | S | X | X（同 ID 行・失効した active 行） | — |
| `authorize_ai_ask_dispatch` | S | S | KS | S | S | X | X | X |
| `finish_ai_ask` | S | S | KS | S | S | X | X | X（払い戻しのみ） |
| `get_ai_ask_result`（replay） | S | S | KS | S | S | — | S（読み取り） | — |
| `accept_ai_ask_consent` | S | S | KS | — | X | — | — | — |
| `revoke_ai_ask_consent` | — | — | — | — | X | — | — | — |
| 期限整理／purge（operator・service_role） | — | — | — | — | — | X | X | — |
| `set_ai_ask_settings`／`set_ai_ask_allowlist` | — | — | — | X | — | — | — | — |

- **撤回（revoke）は L5 だけ**を取る。アカウントが `locked`／`deleting` でも常に成功する（撤回は fail-open）。進行中の authorize／finish は L5 を共有保持するので、撤回はそれらの commit まで待つ（数ミリ秒）。
- 期限整理は「非終端を保守側の終端へ倒す」だけで新しい許可を生まないため、L1〜L5 を取らない。
- **デッドロックの検討**: 所有者の終了処理は L1（X）→ L2（X）→ L3（`DELETE`）→ CASCADE で AI Ask の子行、の順（S13）。AI Ask は L1 を S で保持してから L3 以降に進むので、所有者は L1 で待たされ、AI Ask の子行を先に握ることができない。`auth.users` 自体の削除（管理操作）の CASCADE は子テーブルの処理順が不定で、AI Ask が L1 を保持中に子行の削除と交差し得る。この場合は PostgreSQL がデッドロックを検出して**どちらかを中断**する（AI Ask 側の中断は状態を変えず安全拒否）。回答は保存されない。

### 4.4 状態と遷移（CAS 述語を含む）

| 状態 | 意味 | プロバイダーに送られた可能性 | 終端 |
|---|---|---|---|
| `claimed` | slot 確保・証拠組立中。**送信は未承認** | なし | いいえ |
| `dispatching` | authorize が commit 済み。送信され得る | **あり得る** | いいえ |
| `answered` | 検証済みの回答を保存 | あり | はい |
| `refused` | 拒否を保存（`pre_model`＝未課金／`post_model`＝課金済みを内部コードで区別） | pre:なし／post:あり | はい |
| `failed_billed` | 送信後に使えない応答（スキーマ違反・検証失敗・プロバイダーエラー）。課金あり得る | あり | はい（自動再試行なし） |
| `unknown_after_send` | `dispatching` のまま lease 切れ、または結果を失った | **あり得る** | はい（再送しない） |
| `failed_unsent` | **送信前に失敗したことが証明できる**（S6 の送信前エラー、authorize 前の失敗、claimed の失効） | なし | 条件付き（#8） |
| `cancelled` | ゲート／ライフサイクル／同意の変化で遮断 | dispatching からなら あり得る | はい |

**述語の定義**（以降の CAS で共通）

- `LIVE(r)` ＝ `r.lease_until > v_now`（**厳密な大なり**）。**`lease_until = v_now` は失効**（`<=` が失効。fail-safe 側）。
- `OWN(r)` ＝ `r.user_id = p_user_id AND r.request_id = p_request_id AND r.claim_token = p_claim_token AND r.owner_epoch = p_owner_epoch`。
- `SLOT(r)` ＝ `ai_ask_user_state.active_request_id = r.request_id`。
- `AUTH` ＝ §5.3 の述語（ライフサイクル・同意・ゲート）。

| # | 遷移 | 実行者 | ガード（**全て同一トランザクション・§4.3 のロック下**） | 備考 |
|---|---|---|---|---|
| 1 | 新規 → `claimed` | `begin_ai_ask`（user） | `AUTH`・slot が空（または #7 の整理で空にした）・digest 新規 | `INSERT`（owner_epoch=1・新 token・`lease_until = v_now + claim_lease`）と `active_request_id = 新 request` を同じ TX で |
| 2 | 同 ID の回転 `claimed` → `claimed`（**= #7 ＋ #8 を同じ TX で合成**） | `begin_ai_ask` | 同 digest・`NOT LIVE(r)`（**live の間は回転しない＝`in_progress`**） | `claim_token` 更新・`owner_epoch + 1`・lease 更新。slot は同じ request のまま（`send_epoch` は据え置き）。旧 worker の authorize／finish は `OWN` で拒否 |
| 3 | `claimed` → `dispatching` | `authorize_ai_ask_dispatch`（service） | `OWN ∧ state='claimed' ∧ LIVE ∧ SLOT ∧ AUTH ∧ 日次/分次の上限 ∧ begin の lifecycle_version／consent_epoch と現在値の一致` | **`lease_until = v_now + dispatch_lease`** に更新。日次を消費（`counted_jst_day` を設定。同一論理要求では 1 回だけ）。`callId` を返す |
| 4 | `claimed` → `refused(pre_model)` | `finish_ai_ask`（service） | `OWN ∧ state='claimed' ∧ LIVE ∧ SLOT` | 証拠 0 件・事前フィルタ。**未課金・未消費** |
| 5 | `dispatching` → `answered`／`refused(post)`／`failed_billed` | `finish_ai_ask` | `OWN ∧ state='dispatching' ∧ LIVE ∧ SLOT ∧ AUTH ∧ epoch 一致` | 同一 TX で検証済み公開形を保存し、slot を CAS で解除 |
| 6 | `claimed`／`dispatching` → `failed_unsent` | `finish_ai_ask` | `OWN ∧ LIVE ∧ SLOT`。`claimed` からは authorize 前の失敗。`dispatching` からは呼び出し元が S6 の**送信前エラー**を報告 | `counted_jst_day` 設定済みなら日次を**払い戻し**。slot 解除 |
| 7 | 期限整理：`claimed` → `failed_unsent`、`dispatching` → `unknown_after_send` | `begin_ai_ask`（同ユーザー）／authorize／finish の入口／operator の整理 | `NOT LIVE(r) ∧ 状態が非終端` | **保守側**。slot は `active_request_id = r.request_id` の CAS で解除（新しい所有者の slot を消さない）。`dispatching` は**送信済み扱い**で再送しない。台帳突合は任意の後処理 |
| 8 | `failed_unsent` → `claimed` | `begin_ai_ask` | 同 digest・slot が空・`AUTH`・`send_epoch < 2`（authorize 後に失敗した場合のみ `send_epoch + 1`、claimed からの失敗は据え置き） | 新 token・`owner_epoch + 1`。**ユーザーの同 ID 再送のみ** |
| 9 | 非終端 → `cancelled` | authorize／finish／begin／掃除 | `AUTH` の失効または epoch 不一致 | 回答は保存しない。slot 解除 |
| 10 | 終端 → 再生 | `begin_ai_ask`／`get_ai_ask_result` | 本人・`AUTH`（ゲート・同意・ライフサイクル） | `response_expires_at` 内のみ回答を返す。以降は `result_expired`（再課金しない） |

**不変条件**

- **I-1**: 1 つの論理要求（行）に対するプロバイダー送信は、**成立した #3 の後の 1 回まで**。`dispatching` に入れるのは `claimed` からだけ（#3）、`claimed` への復帰は `failed_unsent`（#8）だけ。**不明は送信済みとして扱い、自動で再送しない**。
- **I-2**: ユーザーごとの非終端の要求は最大 1 件（L6 の `active_request_id`。advisory lock の保持時間に依存しない）。**slot の取得（#1／#8／#2）と解除（#4〜#7・#9）は、全て L6 の排他の下の `active_request_id = <この request>` の CAS**。他の request の slot を書き換える経路は無い。
- **I-3**: 日次の消費は `ai_ask_daily_usage` で単調。応答キャッシュ・tombstone の削除で戻らない。払い戻しは #6 のみ。
- **I-4（新）**: **失効した所有者は何も書けない**。authorize／finish は `LIVE ∧ OWN ∧ SLOT` を要し、失効後は #7 の整理（保守側の終端）以外の状態変更を起こさない。takeover の後の遅延 worker は状態（終端）・token・epoch・slot のいずれでも拒否される。

### 4.5 `callId`・ペイロード同一性・送信 1 回の固定

- **callId**（台帳の `request_id` へ。S5・S15）: `kabumori.ai_ask.v1:<request_id（内部 uuid）>:<send_epoch>`（約 57 文字、台帳の許容文字集合内）。`kabumori.ai_ask.v1` の名前空間。**内部 `request_id` 由来**なので、tombstone 満了で行が消え同じ `clientRequestId` 文字列が再び来ても**別の callId** になり、台帳の確定済み attempt と衝突しない（v2 の `clientRequestId` 由来の hash は廃止）。
- **`send_epoch`**: authorize の後に送信前エラーで台帳の予約が `released`（確定）になると、同じ `(callId, attempt)` は `ATTEMPT_FINALIZED`（S1）。そのため #8 で **authorize を経由していた場合のみ** `send_epoch` を 1 増やして別の callId にする（claimed の失効のように台帳に何も作っていない場合は据え置く）。**#8 は送信前エラーの証明が前提**なので I-1（有料送信は論理要求あたり最大 1 回）は保たれる。上限 2 を超えたら `server_error` で終端。
- **attempt は常に 1**。`executeAiRequest` は `transport: { maxAttempts: 1, retryOnTimeout: false }`、`callId` を明示して呼ぶ。attempt を増やす再実行・タイムアウト後の自動再試行は**しない**（S6）。
- **ペイロード同一性**: `payload_digest = SHA-256( "kabumori.ai_ask.v1.payload" ‖ 0x00 ‖ LEN32(version) ‖ … ‖ LEN32(question_nfc) ‖ question_nfc ‖ LEN32(scope) ‖ scope ‖ LEN32(tickerCode または "") ‖ … ‖ LEN32(consent_version) ‖ consent_version )`（各フィールドを長さ前置で連結）。**DB が計算**し、同じ `(user_id, client_request_id)` で digest が異なれば `request_mismatch`（モデルを呼ばず、日次も消費しない。公開コードは `server_error`）。質問は Phase A と同じ正規化（制御文字・ゼロ幅の除去、トリム、Unicode コードポイント数で 1〜300。サーバーは Phase A と**同じ関数仕様**で再検証し、別基準を持ち込まない）。

### 4.6 決定表（別 ID／同 ID／応答喪失／tombstone 後）

`begin_ai_ask` が受け取る要求を B、現在の slot の所有者を A とする（`LIVE`／失効は `v_now` 基準・§4.4）。

**別 ID（B ≠ A）**

| A の状態 | A は LIVE か | B の結果 |
|---|---|---|
| `claimed` | live | **reject**: `in_progress`（B の行は作らない・未消費） |
| `claimed` | 失効 | **takeover**: A を `failed_unsent`（`claim_expired`）にして slot を CAS 解除 → B を `claimed` で受付 |
| `dispatching` | live | **reject**: `in_progress` |
| `dispatching` | 失効 | A を `unknown_after_send` にして slot を CAS 解除 → B を `claimed` で受付（A は**再送されない**。A の遅延 finish は #5 の `state='dispatching'` が偽で拒否） |

**同 ID（B = A、digest 一致）**

| 行の状態 | live | 結果 |
|---|---|---|
| `claimed` | live | `in_progress`（**回転しない**。他の再試行が live な worker の claim を奪わない） |
| `claimed` | 失効 | #7 で `failed_unsent` に整理 → #8 で再 claim（**token 回転・`owner_epoch + 1`**）。旧 token は `OWN` で拒否 |
| `dispatching` | live | `in_progress` |
| `dispatching` | 失効 | #7 で `unknown_after_send` → 再生（`result_unknown`）。**再送しない** |
| 終端（answered／refused／failed_billed／unknown／cancelled） | — | 再生（`response_expires_at` 内）／期限後は `result_expired` |
| `failed_unsent` | — | slot が空なら #8 で再 claim、塞がっていれば `in_progress` |

**失われた応答の窓**

| 失われたもの | 状態 | 次の同 ID 再送 | 結果 |
|---|---|---|---|
| begin の応答 | `claimed`（live） | lease 内は `in_progress`、失効後は #7→#8 で再 claim（claim lease は短く保つ・D10） | 送信前なので安全 |
| authorize の応答 | `dispatching` | live の間は `in_progress`、失効後は `unknown_after_send` | **保守的に送信済み扱い**。ユーザーは新しい質問として送れる（新しい ID・新しい消費） |
| 台帳 mark_sent／プロバイダー応答 | `dispatching` | 同上 | 同上。台帳の保留は `recover_stale`／突合で確定 |
| finish の応答 | 終端（保存済み） | **同 token・同 epoch・同 `finish_digest` の再送は保存済みを返す（冪等）**。lease 切れ後でも可 | 同じ終端が返る |
| Edge プロセスの停止（finish 前） | `dispatching` | live の間は `in_progress`、失効後は `unknown_after_send` | `result_unknown`。**回答を再生成しない** |

- **同 ID と新しい ID の区別（tombstone 満了後）**: tombstone の満了後に**同じ文字列**の `clientRequestId` が届いても、サーバーは「古い再送」と「新しい質問」を区別できず、**新しい論理要求として扱う**（行は再作成・内部 `request_id` も新しい・callId も別）。これは通常の再送経路ではない。**クライアントは送信ごとに新しい ID を作り、終端（`result_expired`／`result_unknown`／回答）の後に同じ ID を再利用しない**（Phase A の reducer の既存契約）。サーバー側の保護は「ID の鮮度の検査」ではなく**同じ上限**（日次・分次・全体予算・1 件ガード）で、古い ID の再送でも追加で 1 回しか課金されず、上限は迂回されない。ID に埋め込まれた時刻の検査は、クライアントが偽造できるため**保護として使わない**。
- **日付またぎ＋応答喪失**: 日次の消費は authorize の `v_now` の JST 日（`counted_jst_day`）に紐づく。払い戻しは**消費した日の行**を減らす（日付が変わっても別の日のカウントを動かさない）。翌日の同 ID の再送は終端なら再生／期限切れなら `result_expired` で、**日付が変わってもカウントは戻らない**（I-3）。

### 4.7 TTL と tombstone

- 回答キャッシュ（`public_response`）の TTL は**終端から 15 分**（D3）。期限後は列を NULL にする（掃除は begin の機会的削除または cron）。
- **行そのものは tombstone として `tombstone_until`（提案 48 時間・D10）まで残す**。tombstone は内容を持たない最小情報（状態・内部コード・時刻・digest）。同じ ID の再送は、期限後でも `result_expired`（終端・再課金しない）。
- 新しい論理要求（新しい `clientRequestId`）は、費用が発生し得るユーザーの**明示的な操作**であり、クライアントの一時的な再試行ではない。UI は `result_expired`／`result_unknown` で「新しい質問として送る」を示す（B1-c）。
- tombstone の保持は「再課金防止」のためで、質問・回答は保持しない（D7）。退会・サービス終了では `profiles` の削除に連動して消える（§5.4）。

### 4.8 保存する応答（再生できる形）

`public_response` は**公開してよい形だけ**を保存する（プロバイダーの生エラー・ID・コスト・トークン数は入れない）。形は §10.2 の `AskResponse`（Phase A の union）そのもの:

| 状態 | 保存する公開形 |
|---|---|
| `answered` | `{status:'answered', …}` |
| `refused` | `{status:'refused', reason}` |
| `failed_billed`／`unknown_after_send`／`cancelled` | `{status:'failed', code: 'server_error'｜'result_unknown'｜'unavailable'}` |

## 5. 認証・ライフサイクル・RPC 権限（R3）

### 5.1 本人の確定（Edge の入口）

| 規則 | 設計 | 失敗時 |
|---|---|---|
| A1 | `Authorization: Bearer` が無い・形式不正 | 401 `auth_required` |
| A2 | Bearer が **anon キー／service_role キーと一致**する、または `role` が `authenticated` 以外 → 拒否（定数時間比較。まず `/auth/v1/user` に渡す前に弾く） | 403 |
| A3 | `/auth/v1/user` を毎回呼び、**検証済み応答**から `id`（UUID 形式）・`aud`/`role = authenticated`・**`is_anonymous === false`** を確認。JWT のデコードだけでの信頼はしない。`is_anonymous` が欠落・不明なら**拒否**（fail-closed） | 401/403。ネットワーク失敗は 503（ID 不明のまま処理しない） |
| A4 | リクエストの本文・クエリ・ヘッダーのどこにも user_id を読む場所を作らない | — |
| A5 | 以降の変数は `user.id` ひとつ。サービス RPC（E5/E8）には `p_user_id` として明示的に渡し、DB が行の所有者と一致を確認 | 不一致は処理せず `server_error` |

- **匿名 Auth の扱い**: `authenticated` ロールは匿名ユーザーも含む（Supabase の仕様。J1 が公式 docs を確認）。したがって `is_anonymous === false` の確認が必須で、DB 側でも `profiles`（アプリが `start_kabumori_service()` で作る）と active な entitlement を要求することで二重に守る（匿名ユーザーは通常ここに到達しない）。

### 5.2 セッション失効（受容遅延を明示）

- `/auth/v1/user` は JWT の署名・期限を検証するが、**サインアウト済みセッションの即時失効を保証するとは仮定しない**。
- **S1（既定）**: 受容遅延 = JWT の残り有効期間（プラットフォーム設定。実値は G4 で確認）。D9 で運営者が「この遅延を受容する」ことを明示承認するまで、公開しない。
- **S2（強化案）**: JWT の `session_id` を **`/auth/v1/user` 成功後に**だけ参照し（署名検証済みの検証後の値。デコード単独では信頼しない）、DB の SECURITY DEFINER 関数でセッションが生きているかを確認する。`auth` スキーマを読める前提が実環境で成立するか（G4 の read-only 確認とローカルの実証）が先に必要。成立しなければ S1 に留まる。
- いずれの場合も、**認可判断は DB の live predicate（§5.3）が毎回行う**ので、セッション確認が遅延しても「アカウント終了・同意撤回後の副作用」は遮断される。

### 5.3 ライフサイクル述語・権威行・線形化（R3）

#### 5.3.1 v2 の残件（J2-R3）

v2 は「begin で版数を記録し、authorize／finish で現在値と比較する。finish は request 行を `FOR UPDATE` で取り、述語を同じトランザクションで確認する」とした。**request 行のロックは別テーブルの更新を止めない**ため、`request FOR UPDATE → actor を SELECT（active／version 1）→ 停止 →（別接続が `deleting`／version 2 を commit）→ finish が answered／checked-v1 を commit` が成立する（J2 の PG 反例 `R3_WEAK=deleting/answered/checked-v1`。別紙の付録 R3-B3 で再現を確認）。`profiles` の FK は物理削除後の再挿入を防ぐだけで、`deleting`／同意撤回が commit 済みで profile が残っている期間の認可は直列化しない。

#### 5.3.2 権威行と述語（§4.3 の L1〜L5 と同一）

authorize／finish／replay は、判断に使う**権威行を共有ロックしたまま**、同じトランザクションで保存まで行う。値を読むだけ（通常の SELECT）にしない。

| 権威行 | ロック | 述語（成立しなければ拒否） | 変更側の線形化点 |
|---|---|---|---|
| L1 `common_accounts` | `FOR SHARE` | `status = 'active'`（`locked`／`deleting` は拒否）。`lifecycle_version` を begin の記録値と比較（不一致なら `cancelled`） | 所有者の状態変更トランザクションの commit（L1 `FOR UPDATE`） |
| L2 `service_entitlements('kabumori')` | `FOR SHARE` | `status = 'active'`（`provisioning`／`suspended`／`deleting`／`ended` は拒否） | 同上（I7 により L1 の版も増える） |
| L3 `profiles` | `FOR KEY SHARE` | 行が存在する | サービス終了の `DELETE` の commit |
| L4 `ai_ask_settings`／許可リスト | `FOR SHARE` | §3.2 のゲートが `allowed`（**述語を再評価**。`settings_epoch` の比較で無関係な設定変更までキャンセルしない） | operator の設定変更の commit |
| L5 `ai_ask_consents` | `FOR SHARE` | scope が要求する目的（P1／P2）の同意が現行版で有効。`consent_epoch` を begin の記録値と比較（**撤回→再同意でも epoch が動くので、飛行中の要求は `cancelled`**） | 同意・撤回の commit |
| L6／L7 | `FOR UPDATE` | `OWN ∧ LIVE ∧ SLOT`（§4.4） | AI Ask 内部 |

- **判断と保存の原子性**: authorize の `dispatching` への CAS と日次消費、finish の公開形の保存と slot 解除は、上の共有ロックを保持した**同一トランザクション**の中で行う。ロックは commit まで解放されない。
- **外部 HTTP の間はロックを保持しない**: E6 の待機中は DB トランザクションが存在せず、状態は `dispatching`＋lease だけが持つ。送信の後に撤回／終了が起きても、finish 時に述語が偽になり**回答は保存・返却されない**（送信済みの外部呼び出しは取り消せない。§3.3）。
- `lifecycle_version` は状態または entitlement の変更ごとにトリガが自動で +1 する（S8・I7）。epoch 比較は「authorize 後に変更されて元に戻った」ケースも検出する補助で、**直列化の主はロック**。

#### 5.3.3 線形化点（どちらが先でも合法な履歴が 1 つに定まる）

| 操作 | 線形化点 | 撤回／変更が先に commit | authorize／finish が先に commit |
|---|---|---|---|
| authorize（新しい dispatch） | authorize トランザクションの commit | **拒否**（`denied`／`cancelled`）。日次も消費しない | 合法（撤回より前の承認）。以後の送信は取り消せない |
| finish（保存） | finish トランザクションの commit | **保存しない**（`cancelled`）。送信済みなら内部コードに課金の可能性を記録 | 合法な履歴（回答は撤回より前に保存）。**以後の replay は撤回後なので拒否** |
| replay（`get_ai_ask_result`／begin の再生分岐） | 読み取りトランザクション（L1〜L5 を共有ロック） | **拒否**（`unavailable`）。保存済みの回答も返さない | 返す（撤回より前の読み取り） |
| 同意の撤回 | L5 の `UPDATE` の commit | — | 進行中の authorize／finish の commit を待つ（ミリ秒）。待機後に反映 |
| サービス終了・アカウント削除 | L1／L2 の `UPDATE`、L3 の `DELETE` の commit | 以降の authorize／finish は拒否。**削除後の再挿入は FK で不可能**（行が無ければ何も書かない） | finish が先に commit し、終了処理は L1 で待機。その後 CASCADE で消える |

- 2 つの操作の間に**交差する履歴は存在しない**（共有ロックと排他ロックは両立しない）。必ず「変更 → 判断」か「判断 → 変更」のどちらかになる。
- **待機の上限**: `lock_timeout = 3s`。超えたら**状態を変えずに安全拒否**（公開は `unavailable`／lease 切れで整理）。デッドロックを検出された側も同じ。

#### 5.3.4 共通アカウント所有者（F5）のロック順の調査結果と前提

| 調査対象（main） | 取り方 | AI Ask との関係 |
|---|---|---|
| `private.account_lifecycle_lock(user, create, exclusive)`（foundation `:364-392`） | `auth.users` を `FOR KEY SHARE`（exclusive のとき `FOR UPDATE`）→ `common_accounts` を `FOR UPDATE`。READ COMMITTED 必須 | AI Ask は `auth.users` を取らず、L1 を `FOR SHARE`。順序は所有者の部分列で**矛盾なし** |
| 各 lifecycle RPC（start／begin・finish・abort の service deletion／account deletion。service_start_intent・deletion_completion を含む全 RPC） | 最初に上の lock 関数、その後 `service_entitlements` を `FOR UPDATE`、`private.account_lifecycle_operations` を `FOR UPDATE`、settings を `FOR SHARE` | L1 → L2 まで同順。operations／settings は AI Ask が取らない |
| `withdraw_kabumori_service`（foundation `:1083-1096`） | 1 トランザクション: begin（L1・L2 X）→ `DELETE profiles`（CASCADE）→ finish | AI Ask の子行は L3 より後。所有者は L1 で待機し、AI Ask の共有ロックを追い越せない |
| 未マージ Draft #152（`service_state_refusal`）／#165／#178／#183 | 同じ I1 順序を文書化。#152 は L1・L2 を `FOR UPDATE`・`lock_timeout='3s'` | **順序は同一**。ロック強度は S と X の違いのみ（AI Ask 側は同一ユーザーの要求を L6 で既に直列化しているので、X でも整合する） |

**結論（競合の有無）**: main にある所有者のロック順と、読んだ範囲の未マージ Draft に**競合は見つからない**。AI Ask は所有者の順序に**追従する側**であり、F5 のロック順・述語・workflow・RPC を変更しない。**契約前提・要調整**（B1-a 開始前に F5 所有者の確認を取る）:

1. AI Ask の RPC は **READ COMMITTED** で動くこと（所有者の要求と同じ）。
2. 所有者が今後 `profiles`／`auth.users` を削除する経路を足すとき、**L1 を先に取る順序を保つ**こと（AI Ask は子行として CASCADE されるだけで、順序制約を所有者に追加で課さない）。順序が崩れた場合の最悪はデッドロック検出による**どちらかの中断**で、回答の保存・二重送信は起きない。
3. 未マージの #152／#165／#178／#183 は**本 TASK では順序の記述と追加行のロック文だけを読んだ**。マージ後の実コードでの再確認を B1-a の開始条件にする。#152 の `service_state_refusal` を採用する場合は、L1・L2 が `FOR UPDATE` になる点（強度の違い）を B1-a が選ぶ。
4. 所有者の述語（`status`・`entitlement`）を **AI Ask が再実装して読む**（上の L1〜L2）か、F5 の関数に**置換**するかは、F5 のマージ後に B1-a が決める。いずれの場合も上のロック順を守る。

#### 5.3.5 D9（セッション失効）は未決定のまま

JWT の失効遅延の扱い（S1 受容遅延／S2 live predicate）は §5.2 のとおり**運営者の判断待ち**。F5 の #152 に生きた `auth.sessions` 行の確認という先例があるが、**未マージのため前提にしない**。D9 が決まっても、本節の直列化（権威行の共有ロック）は変わらない。

### 5.4 データの所有と退会連動

- AI Ask の全ての新表の `user_id` は **`profiles(id) ON DELETE CASCADE`**（S9）。`auth.users` への FK だけでは、かぶモリの利用を終了しても（ログインが残る間）行が残る。`profiles` に付ければ `account_lifecycle_footprint.kabumori` が「profiles が無い＝完了」と判定する既存の仕組みにそのまま乗る。
- 台帳（`ai_ledger`）の利用記録は不透明な user UUID を持ち `profiles` への FK が無い（S10）。**台帳の行は退会で消えない**（運用上の費用記録）。質問・回答の内容は台帳に無い。D7 の文面で保持を区別して明示する。

### 5.5 RPC・表の権限表（B1-a の契約。実 PG の `has_function_privilege`／`has_table_privilege` で検証）

全ての新表: `REVOKE ALL FROM PUBLIC, anon, authenticated, service_role`（行の読み書きは RPC のみ）。全ての新関数: `SECURITY DEFINER`、`SET search_path = ''`、`REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated, service_role` のうえ下表のロールにだけ `GRANT EXECUTE`。ロック順と必要な段は §4.3 の表。

| RPC | EXECUTE | 主体 | 書く／読む | 返す値（**型は §10.2〜10.3 の単一契約**） |
|---|---|---|---|---|
| `get_ai_ask_status()` | authenticated | `auth.uid()` | 読むのみ（助言的・認可の根拠にしない） | `{enabled, available, remainingToday, dailyLimit, consentVersion, consented, scopes[]}`（`remainingToday` はここだけ。`AskResponse` には載せない） |
| `accept_ai_ask_consent(p_version int, p_purposes text[])` | authenticated | `auth.uid()` | `ai_ask_consents`（`consent_epoch` を増加） | `{consented, consentVersion}` |
| `revoke_ai_ask_consent()` | authenticated | `auth.uid()` | 同上（`consent_epoch` を増加。**常に成功**） | `{consented:false}` |
| `begin_ai_ask(p_client_request_id, p_version, p_question, p_scope, p_ticker)` | authenticated | `auth.uid()` | `ai_ask_requests`／`ai_ask_user_state` | **内部 outcome**: `{outcome:'claimed', requestId, claimToken, ownerEpoch, sendEpoch, leaseSeconds}` ｜ `{outcome:'respond', response: AskResponse}`（拒否・処理中・再生・期限切れ・不明。Edge は `response` を**そのまま**返す） |
| `get_ai_ask_result(p_client_request_id)` | authenticated | `auth.uid()` | 読むのみ（§4.4 #10 の判定） | **`AskResponse` そのもの**（`answered`／`refused`／`failed`）。存在しない・期限切れ → `{status:'failed', code:'result_expired'}`、処理中 → `{status:'failed', code:'in_progress'}`。**新しい status は返さない**。他ユーザーの行は不可視 |
| `authorize_ai_ask_dispatch(p_user_id, p_request_id, p_claim_token, p_owner_epoch)` | **service_role のみ** | Edge が確定した `p_user_id`（行の所有者と一致を DB が検証） | 状態・日次カウント（§4.4 #3） | `{authorized:true, callId, leaseSeconds}` ｜ `{authorized:false, reason}`（`stale_owner`／`lease_expired`／`denied`／`cancelled`／`limit`。Edge の写像は §10.4） |
| `finish_ai_ask(p_user_id, p_request_id, p_claim_token, p_owner_epoch, p_outcome, p_public_response, p_internal_code, p_finish_digest)` | **service_role のみ** | 同上＋**`OWN ∧ LIVE ∧ SLOT` の CAS**（§4.4。**失効後は保存せず整理のみ**） | 終端状態・`public_response`（`AskResponse`） | `{stored:true, response}`（冪等：同 token・同 epoch・同 `finish_digest` の再送は保存済みを返す）｜`{stored:false, reason}`（`stale_owner`／`lease_expired`／`cancelled`／`rejected:<state>`） |
| `purge_ai_ask_expired(p_limit)` | service_role のみ | operator/cron | 期限切れ応答の NULL 化・tombstone 削除・失効した非終端の整理（§4.4 #7） | 件数のみ |
| `set_ai_ask_settings(...)`／`set_ai_ask_allowlist(...)` | service_role のみ | operator | 設定・許可リスト（`settings_epoch` を増加。L4 を `FOR UPDATE`） | — |

- `authenticated` に `authorize`／`finish` を**与えない**ので、ユーザーが自分の回答や状態を任意に書き込む経路は無い。claim_token と owner_epoch はユーザーにも見えるが、service 専用 RPC を呼べないため無害。
- 同じユーザーが `begin_ai_ask` を直接叩いても、**日次を消費せず**（消費は authorize）、lease が切れれば整理される。連打は claim の作成にも分次上限（`minute_limit_per_user`）を適用して抑える。
- **サービスロールのキーが漏れた場合**の被害（任意の `finish`）は台帳・DB 全体の侵害と同じ水準であり、本機能固有の対策では閉じられない（運用のキー管理）。CAS（token・epoch・lease・slot）は「Edge の誤動作・競合・遅延 worker」に対する保護。

## 6. データ境界：scope → データ源 → 項目射影・同意・自由文（R5）

### 6.1 scope の許可表（サーバーの権威。クライアントの選択に従わない）

| scope | 状態 | 読んでよいデータ源 | **読んではいけない** | 同意（§6.3） | `usedHoldings` |
|---|---|---|---|---|---|
| `market` | V1 受付 | `get_app_market_report`（共通・Fact 通過済みの保存文。ゲート ON のときのみ） | `tracked_stocks`、`get_my_important_stock_news`（本人の関連度で絞られた＝保有から派生する）、保存済み保有スナップショット、`profiles` の個人項目 | **質問の送信**に対する同意（目的 P1） | 常に `false` |
| `holdings` | V1 受付 | `tracked_stocks`＋`stocks_master`（保有のみ・≤30）、`get_my_important_stock_news`、保存済み終値スナップショット、`get_app_market_report`。**構成比（§8.3）の計算と登録一致の検査のためにサーバー内で読むのは、数量・取得単価・`position_type`・`side` まで** | **メモ・目標価格・他人の行は読まない**。**数量・取得単価は外向けの射影（§6.2）に含めない**（サーバー内の構成比計算と登録一致の検査にだけ使う） | P1 ＋ **ポートフォリオ文脈の送信**（目的 P2） | 実際に保有由来の項目を送ったときだけ `true` |
| `stock` | **V1 では拒否**（D5） | — | 全て | — | — |

- **`market` はプライバシーの迂回路にならない**: market の証拠は共通市況のみで、本人の保有・ウォッチ・保有から派生したニュース・スナップショットを読まない。質問に「私の保有株は…」と書かれていても、サーバーは**読み取りを広げない**（保有由来の証拠が無いので、`insufficient_evidence` か「市況のみで回答」に倒れる）。
- **`stock` はサーバーで拒否**（`scope_unsupported`）。古いクライアントが `stock` を送っても広がらない（v1 の許可リスト）。

### 6.2 項目射影（外部 AI へ渡す項目）

| データ源 | 渡す項目 | 渡さない項目 | 備考 |
|---|---|---|---|
| 保有（holdings のみ） | 銘柄コード、社名、登録種別（保有）、**構成比（%）**（§8.3 の完全性を満たすときだけ。サーバー計算） | 数量、平均取得価格、現物/信用、買い/売り、目標価格、メモ、`user_id`、`tracked_stocks.id`、損益額・評価額 | 銘柄コードの集合自体が保有の開示なので P2 の同意対象 |
| ニュース（holdings のみ） | **Fact 通過済みの `app_title_ja`／`app_summary_ja`**（先頭 300 字）、時刻、銘柄コード、`severity` | `source_url`、`app_detail_ja` 全文、未通過の生見出し | **未通過の見出しは証拠から除外**（検証済みの事実として扱えない）。範囲が狭まる点は許容 |
| 市況（market／holdings） | 見出し・要約・主要な値動きの保存文（Fact 通過済み）、`trading_date`、`generated_at` | パケット全体、内部 ID | ゲート OFF のときは市況の証拠を出さない |
| 保存済み終値（holdings のみ） | 銘柄ごとの終値・基準日（構成比の計算にサーバー内で使うのみ。**プロンプトにも数量なしで終値を渡さない**） | 損益・評価額・数量 | |
| 質問文 | 利用者が入力した文（≤300 字・正規化済み） | — | §6.4 |

### 6.3 同意（目的別・版数・撤回）

- 目的 **P1**「質問の外部 AI への送信」: scope を問わず全ての AI 呼び出しの前に必要（質問は利用者データであり、第三者へ送る）。
- 目的 **P2**「ポートフォリオ文脈（銘柄コード・社名・構成比・関連ニュース）の送信」: holdings の**個人データの読み取り・送信の前**に必要。
- 保存: `ai_ask_consents(user_id → profiles cascade, purpose, consent_version, accepted_at, revoked_at, consent_epoch)`。**版が上がれば再同意**。撤回は `consent_epoch` を増やし、進行中の要求は §5.3 のフェンスで `cancelled`、replay も拒否される。
- **順序**: begin の述語（§5.3）で同意を確認してから証拠の組立（E4）に入る。同意が無い状態では保有を**読まない**（RLS は必要条件であって、送信の同意ではない）。
- 文面（運営者の最終責任・D2）: 外部サービスの名称（D1 の結果）、**質問文を含む**送信項目、送らない項目、アプリ側の保持（回答は 15 分・tombstone は内容なし）、外部サービス側の保持（そのサービスの規約に従う。即時削除を約束しない）、台帳の保持（利用記録は不透明 ID のみ）。**プライバシーポリシー（REL-04）への反映が公開より先**。現在のポリシーは AI Ask・代替プロバイダーを網羅していないと J1 が確認しており、本タスクは公開ページを変更しない。

### 6.4 自由文（質問）に含まれる個人情報

「構造化項目として数量・取得単価・メモは送らない」ことと「自由文に個人情報が入らない」ことは別。V1 は次の **best-effort の拒否** を行い、完全な防止を約束しない。

- 事前フィルタ（モデルを呼ばず、日次も消費しない）: メールアドレス、電話番号形式、連続 7 桁以上の数字、「N株」「N口」「平均取得」「取得単価」「口座」「暗証」「パスワード」等の語＋数字の併記。該当すれば `refused: out_of_scope`（固定文言「質問に個人情報や数量は入力しないでください」）。
- UI の注意書き（B1-c）: 「質問は外部の AI サービスに送られます。個人情報や保有数量は書かないでください」。
- 質問は**証拠ではない**（§7.2）。質問中の数値・銘柄は事実として回答に出ない。

## 7. 証拠・抽出的回答・検証（R4）

### 7.1 v1 の誤り

- スキーマは `facts: [] （0..8）`・自由な `answer` を許し、V3〜V5 は「数字・社名が証拠**または質問**に現れる」だけを見る。**空の facts、入れ替えた銘柄・符号・期間、質問に書かれた数値**がすべて通る（J1 の反例）。
- 区切りタグと JSON Schema は構文上の防御であって、意味の信頼境界ではない。

### 7.2 V1 の方針：モデルは「選ぶ」だけ。事実文はサーバーが作る

```
証拠表（サーバーが作成・リクエスト限り）
  { id:"E1".., kind:"news"|"market_report"|"holding", subjectCode?:"7203",
    title: string,         // サーバー保有の確定題（Source.title の元。§10.2.1）
    statement: string,     // サーバー保有の確定文（Fact 通過済みコピー、または§8.3 の構成比テンプレート文）
    asOf: ISO|null, ref: アプリ内 ID|null, quotable: true }

モデルの出力（JSON Schema・G6 jsonSchema で強制・自由文なし）
  { refusal: null | "investment_advice" | "out_of_scope" | "insufficient_evidence",
    picks: [ { evidenceId: "E1".., role: "primary"|"supporting" } ]  (0..5),
    topic: "market_overview"|"holding_exposure"|"news_impact"|"risk_check"|"other" }
```

- **画面の文は全てサーバーが生成する**: `answer` は `topic` と「選ばれた証拠の件数・種別・時点」から作る固定テンプレート（例:「お持ちの銘柄に関連する直近のニュース 3 件を、新しい順に整理しました。」）。`keyPoints[i]` は選ばれた証拠の `statement`（サーバー保有の確定文）をそのまま使う。`sources[i]` は証拠表の値から **§10.2.1 の全値写像**（`news→news`、`market_report→report`、`holding→holding`。公開の `kind` は Phase A の列挙）で作る。**モデルが書く文字列は 1 文字も画面に出ない**。
- **質問由来の数値・銘柄は事実に昇格しない**: 質問はプロンプトの `<question>` 領域にだけあり、証拠表に入らない。回答中の数値・銘柄は全て証拠表（サーバーの確定文）由来。
- **解釈（`interpretation`）は V1 には無い**。モデル作成の解釈文は、型付きの主張（metric／entity／value／unit／sign／period／evidenceId）を構造化証拠に対して検証できる仕組み（B2・別 TASK・別 J レビュー）が要る。**因果の主張**は、証拠が明示的に原因を持つ構造化フィールドがある場合に限る設計とし、V1 では出さない。

### 7.3 サーバーの検証（すべて通らなければ部分採用せず、拒否または失敗）

| ID | 検証 | 失敗時 |
|---|---|---|
| V1 | JSON Schema 検証（`validate.ts`）。余計なキー・型・件数超過 | `failed_billed`（`server_error`） |
| V2 | `picks[].evidenceId` が**この要求の証拠表に存在**、重複なし、scope の許可データ源に属する | 同上（捏造は回答しない） |
| V3 | `refusal=null` のとき `picks` が 1〜5 件（**空は回答にしない**＝`facts=[]` の無根拠通過を禁止） | `refused: insufficient_evidence` |
| V4 | 描画後の全文（テンプレート＋確定文）に、URL・売買の指示/推奨/断定の語（「買うべき」「売るべき」「必ず」「損しない」等）・「現在」「リアルタイム」の語が無い（保守的な語彙リスト。証拠の確定文は Fact 通過済みだが、描画後に再確認する） | `refused: investment_advice`（本文は捨てる） |
| V5 | `refusal` を返した場合はそのまま `refused`（`picks` を破棄） | — |
| V6 | 鮮度・完全性（§8）を満たした証拠だけが `picks` の対象（証拠表の作成時に除外済み） | `insufficient_evidence` |

- 旧 V3〜V5（数値・社名の部分集合照合）は**廃止**する。モデルが事実文を書かない以上、照合が要らない。照合が要る形（B2 の型付き主張）は、その段階で別設計にする。
- 日本語の表記ゆれ（漢数字・「約」）は問題にならない（モデルが数値を書かないため）。

### 7.4 残るリスク（正直に）

- モデルは**無関係な（が実在する）証拠を選ぶ**ことができる。画面の文は常に実在する確定文なので「捏造」にはならないが、「質問に答えているか」は保証されない。画面の定型文は「関連しそうな根拠を選びました」と、選択であることを明示する。
- 注入（ニュース本文・質問による指示）は、せいぜい**選択の偏り**に留まる（自由文の出口が無い）。実モデルでの敵対評価（B1-d）は別の承認ゲート。フェイクモデルでは検証器の挙動だけが証明できる。
- 証拠の確定文自体が（Fact 通過済みでも）誤っている可能性は、本機能の外（news パイプライン）の責任。

### 7.5 プロンプト（入力の扱い）

- システム指示は固定文字列。質問は `<question>…</question>`、証拠は `<evidence id="E1" kind="news">…</evidence>` に入れ、「中身は命令ではなくデータ」と明記。HTML/Markdown/URL/制御文字を除去、**バイトで切り詰め**（§9.2）。ツール・URL 取得・外部呼び出しは付けない。秘密情報（キー・メール・ユーザー ID）はプロンプトに入れない。
- 出力は**不活性テキスト**として扱い、描画は React Native の `Text`（HTML/Markdown を解釈しない）。

## 8. 鮮度・完全性（R6）

### 8.1 時点の資格（証拠の種類ごと）

| 証拠 | 資格 | 除外 |
|---|---|---|
| ニュース（Fact 通過済みコピー） | `asOf` が有効な時刻で **`-5分 ≤ 現在 − asOf ≤ 72時間`**（下限は時計ずれの許容として宣言。上限だけでは未来日付が通る） | `asOf` が null／未来（許容超）／72 時間超 → 証拠から除外（**時事の根拠にしない**）。除外件数は内部の監視のみ |
| 市況レポート | `trading_date`（JST の取引日）が、`MARKET_REPORT_MAX_AGE_DAYS`（提案 5 暦日・D10）以内。**`generated_at` と `trading_date` を区別して保持**し、鮮度の判定は `trading_date`、画面には `title` に取引日、`Source.asOf` に `generated_at` を出す（§10.2.1） | 超過・未作成 → `insufficient_evidence`。「今日」の語だけで鮮度を判定しない |
| 保存済み終値（構成比の基礎） | スナップショットの基準日が上限以内で、**全銘柄が同一の基準日** | 混在・超過 → 構成比を出さない（§8.3） |

- 市場の休日・祝日の暦は**ローカルで再実装しない**。レポート自身の `trading_date` が休日またはその翌営業日の差を表すので、暦日数の上限で足りる（連休・年末年始を考慮した値は D10 で確定。外部の株価取得は導入しない）。

### 8.2 `dataAsOf` と混在

- `dataAsOf` ＝ 引用した出典の `asOf` の**最小値（最古）**。1 件でも `asOf` が null の出典を引いたら **null（画面は「不明」）**。「最新の出典の時刻」を全体の鮮度として見せない。
- 各 `sources[i].asOf` は個別に表示する。`keyPoints` に時点が異なる複数の出典が混ざるときは、画面のテンプレートが「出典ごとに時点が異なります」と示す（B1-c）。

### 8.3 保有の完全性（構成比を出す条件）

構成比（%）は**次をすべて満たすときだけ**計算し、証拠に載せる。1 つでも欠ければ構成比そのものを出さない（0 や部分集合の正規化で埋めない）。

| 条件 | 検査 |
|---|---|
| 全体が揃っている | 有効な保有の件数を `count`（上限切り捨てを検知できる形）で取得。**≤ 30 でなければ構成比なし**（30 件に打ち切って全体の構成比として表示しない） |
| 数量・終値 | 各銘柄の数量が有限の正数、終値（スナップショット）が有限の正数 |
| 登録の一致 | 現在の登録がスナップショット時点と一致（`registrationMatchesSnapshot` と同じ比較: `tracking_type`・`quantity`・`average_price`・`position_type`・`side`。**空欄はワイルドカードではない**）。編集後は一致しない |
| 方向・種別 | 全て `position_type = cash` かつ `side = long`（信用・売りは構成比の意味が異なるので、1 件でもあれば構成比なし） |
| 時点 | §8.1 のスナップショット資格（全銘柄が同一の基準日・上限以内） |
| 分母 | 「全ての有効な保有の評価額の合計」を分母（完全性が成り立つ場合だけ） |

- 構成比を出せない場合でも、ニュース・市況の証拠による回答は可能（銘柄コード・社名は P2 の同意のもとで送られ得る）。画面は「構成比は表示できません（理由）」を示す（理由は列挙のみ）。
- 保有 0 件で scope=holdings は `no_holdings`（モデル未呼び出し・未消費）。
- 外部の株価・為替の取得は導入しない（保存済みデータのみ）。

## 9. 費用契約（R7）

### 9.1 v1 の誤り

台帳の予約は「名目 6,000 トークン」ではなく**実際の UTF-8 バイト（指示＋本文＋スキーマ）＋2,048**の上界（S7）。日本語は 1 文字 3 バイトで、名目の試算より大きくなり、`max_usd_per_call` を超えれば**拒否**になる（台帳の過払いではなく利用不能）。回数・金額の表だけでは、本文のバイト数・ID・証拠の大きさ・短時間の連打を縛れない。

### 9.2 固定契約（`ai_ask.v1`・版管理。コードに散らさず 1 つの定数オブジェクト＋DB 設定は**下げる方向のみ**）

| 項目 | 固定値（提案・D1/D4 の承認まで OFF） |
|---|---|
| provider／model | **未決（D1）**。カタログ内の**ちょうど 1 つ**を `model_key` で固定。自動フォールバックなし。未設定なら `unavailable` |
| `reasoningEffort` | `low`（`none` を許す系はモデル確定時に評価） |
| `maxOutputTokens` | **800**（推論トークンを含む上限。スキーマは picks≤5 で小さい。二重加算しない） |
| `timeoutMs` | 20,000（1 回の HTTP 試行あたり） |
| `transport` | `{ maxAttempts: 1, retryOnTimeout: false }` |
| 受信本文 | **≤ 4,096 バイト**、JSON の深さ ≤ 3、キーは許可リスト、未知キーは拒否 |
| `clientRequestId` | `^[A-Za-z0-9_-]{16,64}$` |
| 質問 | コードポイント 1〜300（Phase A と同じ正規化の後） |
| システム指示 | **≤ 3,072 バイト**（固定文字列） |
| 組立後の `userContent`（質問＋証拠すべて） | **≤ 16,384 バイト**（証拠は種別ごとの件数・文字数の上限の後、バイトで最終切り詰め。切り詰めは項目単位で、途中で文を切らない） |
| スキーマ JSON | ≤ 1,024 バイト（現行案 515 バイト） |
| 1 要求の台帳予約 | 上記の上界を `upperBoundAttemptCostUsd` で計算（S7）し、`max_usd_per_call` は**それ以上**に置く |

### 9.3 バイト上界（実コードでの算出）

上限いっぱいの要求（システム指示 3,072 B・本文 16,384 B を日本語の 3 バイト文字で埋める・スキーマ 515 B・出力 800）を、`supabase/functions/_shared/ai_provider/cost.ts` の `upperBoundInputTokens`／`upperBoundAttemptCostUsd` と `model_catalog.ts`（`verifiedOn: 2026-10-10`）の単価で計算した（オフライン・読み取りのみ。再現手順は別紙 §5）。

| モデル | 入力上界（トークン） | 1 回の上界（USD・見積り） | v1 の提案 `max_usd_per_call` 0.05 |
|---|---:|---:|---|
| gpt-6-luna／claude-haiku-5-5 | 22,033 | **0.0026** | 余裕あり |
| claude-sonnet-5-5／gpt-6.1-sol | 22,033 | **0.0521** | **超過 → `PER_CALL_LIMIT` で拒否** |
| claude-opus-5-5 | 22,033 | **0.1041** | 超過 |

- 上の金額は**請求額ではない**（G6 カタログの単価による見積り。不明な使用量は上限を満額で計上する）。プロバイダーの請求・クレジット・組織の支出上限は本設計の知識外で、**硬い保証とは主張しない**（L4）。
- 表の 515 バイトのスキーマは**例**で、契約の上限は §9.2 の 1,024 バイト。**固定する実スキーマ・スキーマ名・採用モデルで T35 を再計算して初めて**数値が確定する（515 バイトの例を上限の保証に使わない）。
- Sonnet/Sol 級を採るなら、`max_usd_per_call` を上界以上（≥ 0.053）に置くか、本文の上限バイトを下げる。**採用するモデルを D1 が決めてから**、同じ関数で再計算して固定する（B1-b のテスト T35 が最大入力で `予約額 ≤ max_usd_per_call` を機械的に確認する）。単価・性能・データ取り扱いはモデル確定時に再確認する（本 PR は G6 のカタログも予算も変更しない）。

### 9.4 上限の層（すべて既定 OFF／0・承認まで）

| 層 | 内容 | 既定 |
|---|---|---|
| L0 入口 | 本文バイト・ID・質問長（§9.2）。高価な処理の前に弾く | 常時 |
| L1 ゲート | §3.2（enabled／許可リスト／日次 0） | OFF |
| L2 本人の日次 | `ai_ask_daily_usage`（JST の日付・DB の原子的な加算）。**権威** | 0 |
| L2' 本人の分次 | 直近 60 秒の claim／dispatch 件数（`minute_limit_per_user`）＋**永続の 1 件ガード**（I-2） | 0 |
| L3 台帳 | §3.4 の全体 日次/月次 `max_estimated_usd`（既存の月 5 USD 試行枠を**変更しない**。予算の所有者の割当内）、per_user 日次 `max_calls`、`max_usd_per_call` | 未設定＝`NO_MATCHING_POLICY` で拒否 |
| L4 プロバイダー側 | 組織の支出上限（コード外・運用設定） | 未確認 |

- **提案値（承認ではない）**: 本人 5 回/日（初週）、分次 2、全体日次 USD は D4 で予算の所有者が決める。v1 の「全体 20 USD/日」は**未承認の提案**で、許可ではない。
- 最悪露出の上限 ＝ 対象ユーザー数 × 1（1 件ガード）× §9.3 の 1 回上界（OFF 後の残りも同じ。§3.3）。

## 10. 共通契約 v1（B1-a／B1-b／B1-c の並行開始前に固定する）— 単一の wire 型（R8）

### 10.0 v2 の残件（J2-R8）と 3 層の分離

v2 は ① evidence.kind（`news｜market_report｜holding`）から外向けの Source.kind を「そのまま」作るとしたが、公開側の列挙（v2 の `news｜report｜market｜holding`）と Phase A の列挙（`news｜report｜market_data｜holding`）が**三者三様**で、市況を直接写像するとどの列挙とも一致しなかった。② `get_ai_ask_result` が `pending` を返す一方、公開 union は `answered｜refused｜failed` のみで、`pending` が DB と client で別々に実装され得た。③ DB の内部 outcome と公開応答が混在していた。v3 は次のとおり**層を分け、公開型は Phase A の union をそのまま**とする。

| 層 | 型 | 使われる場所 | 公開か |
|---|---|---|---|
| A. 内部 RPC outcome | `BeginOutcome`／`AuthorizeResult`／`FinishResult`（§5.5） | DB ⇄ Edge のみ。client へは出ない（`respond.response` として**公開型を内包**するだけ） | いいえ |
| B. 内部 state／outcome_code | §4.4 の状態、`outcome_code` | DB 内（監視用）。ログにはコードのみ | いいえ |
| **C. 公開 `AskResponse`** | **§10.2（Phase A の union）** | **Edge の HTTP 応答本体・`get_ai_ask_result`・`public_response` の保存形**。**唯一の wire 型** | はい |

### 10.1 リクエスト（変更なし）

`AskRequest` v1（PR166）: `{ version: 1, question, scope: 'market'|'holdings'|'stock', tickerCode: string|null, clientRequestId }`。

- サーバーは §9.2 の入力境界を適用し、`stock` は `scope_unsupported`、`version` が 1 以外は `unavailable`。**ID・保有・価格は受け取らない**。追加の入力は無い（同意・版は DB 側の状態）。

### 10.2 公開 `AskResponse`（Phase A の union をそのまま。`pending` は無い）

```
AskSourceKind = 'news' | 'report' | 'market_data' | 'holding'        // Phase A のまま。型変更なし
AskSource     = { kind: AskSourceKind, title: string, asOf: string | null, ref: string | null }

AskResponse =
  | { status: 'answered', answer: string, keyPoints: string[] /* 0..5 */, sources: AskSource[],
      generatedAt: string | null, dataAsOf: string | null, usedHoldings: boolean }
  | { status: 'refused',  reason: 'investment_advice' | 'out_of_scope' | 'insufficient_evidence' }
  | { status: 'failed',   code: AskFailureCode }

AskFailureCode = 'unavailable' | 'auth_required' | 'rate_limited' | 'budget_exhausted' | 'network' | 'timeout' | 'server_error'  // Phase A の 7 値
               | 'consent_required' | 'no_holdings' | 'not_enrolled' | 'in_progress' | 'result_expired' | 'result_unknown' | 'scope_unsupported'  // v3 で追加する 7 値
```

**v2 からの撤回**（Phase A の型へ戻す）: `answered.remainingToday`（残り回数は `get_ai_ask_status` だけが返す。回答後は client が再取得）、`refused.message`（文言は client が `reason` から表示。Phase A の固定文言）、`failed.retryable`（再試行可否は client の `isRetryable(code)`）、`pending` という status（導入しない。§10.5）。

#### 10.2.1 `Source` の生成：evidence.kind → wire の全値写像（サーバー生成。モデルは関与しない）

| evidence.kind | → `Source.kind` | `title`（サーバー） | `asOf`（サーバー） | `ref`（サーバー） |
|---|---|---|---|---|
| `news` | **`news`** | Fact 通過済みの `app_title_ja` | ニュース時刻（ISO-8601）。無効・null は証拠から除外済み（§8.1）なので常に値あり | ニュース ID（`news-detail?id=`） |
| `market_report` | **`report`** | 固定テンプレート「{朝刊｜大引け} 市況レポート（{trading_date}）」 | レポートの `generated_at`（ISO-8601）。取引日は `title` に載せる | **`null`**（V1 では共通市況レポートの詳細画面への導線を持たない。B1-c が `report-detail` の対応を確認するまで null） |
| `holding` | **`holding`** | 「{社名}（{銘柄コード}）」 | 構成比の基準日（スナップショットの基準日。ISO-8601 日付）。構成比を出さない場合は null | 銘柄コード（`stock-detail` へ） |
| （予約）`market_data` | `market_data` | — | — | — |

- **V1 は `market_data` を生成しない**（値は Phase A の union を変えないために残す）。写像に無い evidence.kind は**実装バグとして `server_error`**（黙って別の値にしない）。
- `kind`／`title`／`asOf`／`ref` は**証拠表の値だけ**から作る。モデルの出力（`picks` の `evidenceId`・`role`・`topic`）は、どの証拠を並べるかの選択にしか影響しない。

#### 10.2.2 写像と意味

- **picks → keyPoints → sources**: `picks`（0..5）→ `keyPoints`（同じ順・同数。Phase A の「0..5」と一致）。各 `keyPoints[i]` はちょうど 1 つの `sources[j]` に対応（同じ証拠の重複は 1 つに畳む）。`answer` は §7.2 のテンプレート。V1 の `answered` は `refusal=null` で `picks ≥ 1` のときだけ作る（V3）ので、**常に `sources ≥ 1`**。`generatedAt` はサーバー時刻（非 null）。
- **`dataAsOf` の意味変更（B1-c の同期対象）**: Phase A の注釈は「newest data」。v2/v3 は §8.2 のとおり**引いた出典の最古の `asOf`（1 件でも null なら null＝「不明」）**。型は `string | null` のまま。B1-c は型コメント・UI の説明文を同期する。

### 10.3 失敗コード（公開 `failed.code`）

| コード | 意味 | 同じ ID の再送 | 備考 |
|---|---|---|---|
| `unavailable` | ゲート OFF／許可外／設定取得失敗／`version≠1`／同意撤回・停止中の replay | 不可 | 理由は区別しない |
| `auth_required` | 未ログイン・失効・匿名 | 不可 | HTTP 401 |
| `rate_limited` | 本人の日次／分次 | 不可 | |
| `budget_exhausted` | 全体/台帳の上限・1 回上限 | 不可 | |
| `network`／`timeout` | **クライアント側**の通信失敗（Edge からは返さない） | **可（同じ ID）** | `get_ai_ask_result` で確認できる |
| `server_error` | 検証失敗・内部エラー・送信後の使えない応答・`request_mismatch`・authorize 後の lease 切れ | 同じ ID は**同じ終端を返す**／claimed の失効なら再 claim | 再度聞くなら新しい質問 |
| **`consent_required`** | 同意が要る | 同意後に可 | |
| **`no_holdings`** | holdings で有効な保有が 0 件 | 不可 | 未課金 |
| **`not_enrolled`** | サービス開始前／サービス終了・削除中・アカウント停止 | 不可 | 述語 §5.3 |
| **`in_progress`** | 同じユーザーの要求が処理中（同 ID・別 ID とも） | **可（間隔を空けて同じ ID。client の `isRetryable`）** | **`failed` ＋コードで返す**。新しい status は作らない |
| **`result_expired`** | 回答の保存期限（15 分）切れ、または存在しない | 不可（終端） | 再課金しない |
| **`result_unknown`** | 送信後に結果を失った（不明）／lease 切れの `dispatching` | 不可（終端・再送しない） | 「費用が発生している可能性」の文言 |
| **`scope_unsupported`** | stock など未対応の scope | 不可 | |

- 公開応答にプロバイダーの生エラー・ID・コスト・トークン数・内部コードは**含めない**。他人の応答を引くクエリは存在しない（`get_ai_ask_result` は `auth.uid()` の行のみ）。

### 10.4 内部 outcome → 公開 `AskResponse` の写像（Edge の唯一の変換表）

| 内部の結果（層 A／G6） | 公開（層 C） |
|---|---|
| `begin` → `claimed` | （続行。公開応答はまだ無い） |
| `begin` → `respond` | **`response` をそのまま返す**（Edge は書き換えない） |
| `authorize` → `stale_owner` | `{status:'failed', code:'in_progress'}`（別の所有者が live）。**送信しない** |
| `authorize` → `lease_expired` | `{status:'failed', code:'server_error'}`（行は `failed_unsent`。同 ID の再送で #8 の再 claim）。**送信しない** |
| `authorize` → `denied`（ゲート／同意／ライフサイクル／日次・分次） | `unavailable`／`consent_required`／`not_enrolled`／`rate_limited`。**送信しない** |
| `authorize` → `cancelled` | `unavailable`。**送信しない** |
| G6 の送信前エラー（`REQUEST_INVALID`／`MODEL_UNKNOWN`／`MODEL_PROVIDER_MISMATCH`／`CAPABILITY_UNSUPPORTED`／`SCHEMA_UNSUPPORTED`／`KEY_MISSING`／`KEY_INVALID`／`DEADLINE_EXCEEDED`） | `finish(failed_unsent)` → `unavailable`（キー・設定）／`server_error`（その他） |
| G6 `BUDGET_DENIED`（台帳が拒否。送信前） | `finish(failed_unsent)` → `budget_exhausted` |
| 送信後の不明（`TIMEOUT`／`NETWORK` など、使用量不明） | `finish(unknown_after_send)` → `{failed, result_unknown}`。**再送しない** |
| 送信後の既知の失敗（`RATE_LIMITED`／`OVERLOADED`／`SERVER_ERROR`／`INVALID_REQUEST`／`INCOMPLETE`／`PROTOCOL`／`INVALID_JSON`／検証 V1・V2 の失敗） | `finish(failed_billed)` → `{failed, server_error}` |
| プロバイダーの `REFUSAL`／モデルの `refusal` | `finish(refused post_model)` → `{refused, reason}`（プロバイダーの `REFUSAL` は `out_of_scope`） |
| 検証 V3〜V6 の失敗（空の picks・語彙・鮮度） | `{refused, insufficient_evidence｜investment_advice}` |

- **HTTP**: Edge が生成した全ての `AskResponse` は **HTTP 200** の本体として返す（`failed`／`refused` を含む）。例外は認証失敗の **401**（本体は `{status:'failed', code:'auth_required'}`）。プラットフォーム／ネットワークの 5xx・タイムアウトは Phase A の client が `server_error`／`network`／`timeout` に写す。
- B1-b は **G6 の `AiErrorCode` の全値**がこの表のどれかに落ちることを網羅テストする（T44）。

### 10.5 `pending`／ポーリングは v1 では導入しない

`in_progress` は**重複送信の拒否**であり、v1 の `timeout` に代わる非同期の仕組みではない。**v1 は `failed` ＋ `in_progress` の 1 つの形だけ**を持ち、`pending` という status を契約に入れない（DB の `get_ai_ask_result` も同じ）。真の `pending`＋ポーリング（ジョブ方式）は**新しい契約（v2・新しい status）とクライアント作業の別 TASK**で、状態遷移（§4.4）の上に別の受け皿を足す形になる。切り替えの条件（p95 が 25 秒超・レート制限が常態・Edge の実行時間上限）は v1 のまま。

### 10.6 Phase A（PR166）との互換性と、B1-c が行う変更（明示）

- Phase A は**未マージ・未出荷**（`ASK_SERVER_ENABLED=false`、本番は `unavailable`）。**出荷済みの旧クライアントは存在しない**ので、型の追加を B1-c で承認すれば足りる。出荷後に意味を変える変更が必要になったら `version: 2`。
- **変更しない**: `AskRequest`、`AskSourceKind`（4 値）、`AskSource`、`answered`／`refused`／`failed` の形、`clientRequestId` の生成。
- **B1-c が変更する（PR166 のマージ後・別 TASK で承認）**: ① `AskFailureCode` に 7 値を追加（型の拡張）、② `isRetryable` に `in_progress` を追加（`result_expired`／`result_unknown`／`consent_required`／`no_holdings`／`not_enrolled`／`scope_unsupported` は同じ ID の自動再試行をしない）、③ `dataAsOf` の注釈・表示の意味（最古／不明）、④ `ASK_SERVER_ENABLED` を `get_ai_ask_status` に置換、⑤ 同意画面・残り回数（`get_ai_ask_status` から）・UI の注意書き、⑥ **未知のコード・status を `server_error` として扱う decoder**。**fail-closed**: ステータス取得の失敗は `unavailable`（送信導線を出さない）。

### 10.7 B1 の共有成果物（並行の前提）

B1-a・B1-b・B1-c は次を**共通の正本**として参照する（改定は 3 者の J レビューを要する）:

1. §4.2 の表定義、§4.3 のロック順、§4.4 の状態・遷移・CAS 述語、§5.5 の RPC 権限表と戻り値。
2. §9.2 の入力境界・固定契約と、§7.2 の証拠表・出力スキーマ・§10.2.1 の写像。
3. **§10.2〜10.4 の `AskResponse`・失敗コード・内部→公開の写像**。この型を機械可読な 1 つの JSON Schema（`AskResponseWireV1`）として B1 の共有フィクスチャに置き、**DB の serializer・Edge の parse／serialize・client の decoder が同じフィクスチャで往復一致**することを T44 で確認する（キー集合は**過不足なし**。`message`／`retryable`／`remainingToday`／`pending` が出てはならない）。
4. 別紙の受入テスト T1〜T44（B1-a は DB 層、B1-b は Edge 層、B1-c は Client 層。更新条件は本 PR の別紙が優先）。

## 11. 段階ゲート・rollback

| ゲート | 条件 | 本番への影響 |
|---|---|---|
| G0 | 本設計（v3）を L1 が受入 → **J 枠（独立）による限定の差分再レビュー**（J2 の残件 R2／R3／R8 の訂正が反例を閉じているか。R1／R4〜R7 の PASS 条件が保たれているか）で PASS | なし |
| G1 | B1-a（DB）: ローカル実 PostgreSQL で、§5.5 の権限・§4 の状態機械・同意・日次・1 件ガード・フェンス・CASCADE のテスト（T2・T5〜T9・T16〜T18・T21・T23〜T31・T36〜T43）が通る。**うち T6／T26／T28／T29／T31／T38／T43 は 2 つ以上の PG 接続での順序検証（別紙 §3）**で、所有者（F5）の既存 RPC（`withdraw_kabumori_service` 等）との交差も含む。**未適用**。J 独立レビュー PASS | なし |
| G2 | B1-b（Edge）: 純関数テストとフェイクモデルの全経路、**ローカル DB と実契約を結んだ**統合テスト（個別に通るモックだけでは不可）。G6 `isolation_test` の許可リスト更新（G6/PR157 と調整・F2/F6 の並行所有を再確認）。J レビュー PASS | なし |
| G3 | B1-c（クライアント）: PR166 のマージ後、凍結契約の上で。ソーステスト（T20・T44）と Simulator（フィクスチャ） | なし（サーバー OFF） |
| G4 | **本番の read-only 確認**（別承認）: 台帳 migration・G2 migration の適用、プロバイダーキー、`verify_jwt`、JWT 有効期限、`auth.sessions` の可読性（S2）、組織の支出上限 | なし |
| G5 | **本番適用**（別承認）: migration → Edge → 台帳ポリシー（すべて OFF／0。**停止は §3.2**） | OFF のため機能は出ない |
| G6 | 許可リストの**社内ユーザーのみ** ON。実機・実費・拒否ケース集。許可リストが権威（台帳の `scope_user_id` は使わない） | 社内のみ |
| G7 | 段階公開（`all_enrolled`、日次小）→ 見張り → 上限を上げる。D6・D2 承認後 | 公開 |
| rollback | §3.5 の順序（OFF → 台帳の補助停止 → ドレイン → 突合 → 保持期間後に初めて破壊的取り消し） | 元どおり |

## 12. リスク表（v2）

| ID | リスク | 影響 | 対策 | 残り |
|---|---|---|---|---|
| R1 | クロスユーザー漏洩 | 重大 | 本人トークン RLS、RPC は `auth.uid()`、キャッシュは本人行のみ、ログ規則 | 実 DB・実 JWT での検証（J・B1-a/G4） |
| R2 | 失効・匿名・停止ユーザーの受理 | 重大 | §5.1〜5.3（匿名拒否・live predicate・版数フェンス） | セッション失効の受容遅延（D9） |
| R3 | 注入（ニュース由来含む） | 高 | 自由文の出口なし（§7）。選択のみ | 選択の偏り（§7.4）。実モデル評価（B1-d） |
| R4 | 数値・出典の捏造 | 高 | モデルが事実文を書かない。出典・時点はサーバー生成 | — |
| R5 | 投資助言の逸脱 | 高 | テンプレート＋V4 ＋事前フィルタ | 語彙リストの網羅性（保守的に拒否） |
| R6 | 費用の暴走 | 高 | §9（バイト上界・1 件ガード・日次・台帳・OFF） | 単価・請求は未確認（L4） |
| R7 | 二重課金・再送 | 中 | §4（I-1：論理要求あたり最大 1 回送信、不明は再送しない） | `result_unknown` の UX |
| R8 | 同意不足 | 高（法務） | §6.3（目的別・読み取りの前・版数・撤回のフェンス） | ポリシー文面（D2・REL-04） |
| R9 | 古い情報の誤認 | 中 | §8（下限・上限・null/未来の除外・最古の時点） | 閾値（D10） |
| R10 | 可用性 | 中 | 失敗は正直に表示。自動フォールバックなし（D8） | — |
| R11 | G6 基盤・台帳が本番に無い | ブロッカー | G4 で確認。`NO_MATCHING_POLICY` は拒否側に倒れる | 適用順序 |
| R12 | G2 個別分析との枠の混線 | 低 | 別設定・別 RPC・別カウント | 画面文言 |
| R13 | 退会後の残存 | 中 | `profiles` CASCADE（S9）、tombstone は内容なし、台帳の不透明 ID の保持は明示（D7） | 実 PG の連動検証・台帳保持の説明 |
| R14 | 停止後の送信 | 中 | 線形化点・dispatch 直前再評価・上限の明示（§3.3） | 送信済みは取り消せない |
| R15 | 部分データを全体として表示 | 中 | §8.3（件数・数量・終値・信用/売り・登録変更・基準日） | — |

## 13. B1 実装 TASK 候補（契約凍結・J の限定再レビュー PASS の後）

| 候補 | 内容 | 依存 | 触る領域 |
|---|---|---|---|
| B1-a DB | §4.2 の表・§5.5 の RPC・ゲート・同意・日次・フェンス・CASCADE・rollback SQL。**実 PG の権限・競合・失われた応答のテスト**。未適用 | 本設計の J1 再レビュー PASS、D2/D4 の数値（OFF 既定） | `supabase/migrations/`（新規）、`supabase/tests/`（新規） |
| B1-b Edge | `supabase/functions/ai-ask/`（§2 の E1〜E8）。純関数＋フェイクモデル＋ローカル DB 統合。G6 の許可リスト更新 | B1-a の RPC 形（凍結契約）、D1 のモデル枠 | `supabase/functions/ai-ask/`、`_shared/ai_provider/isolation_test.ts` |
| B1-c クライアント | PR166 の上で §10.6。**F1** | PR166 のマージ判断、凍結契約 | `src/lib/ai-ask*.ts`、`src/app/ai.tsx` |
| B1-d 評価 | 敵対ケース集・実モデル評価（G4 通過後の別承認）・費用の実測 | B1-b | `docs/`、テストデータ |

- **本 TASK は B1 のいずれも開始しない**。J1 の限定再レビューが PASS するまで、B1-a/b/c の割当・本番接続・実モデル課金を行わない。
- 競合の確認（本 TASK 時点・fresh main 7fe597cb）: 候補パスに重なる open PR は無い（`supabase/functions/ai-ask/`、`ai_ask_*` migration）。G6 の `isolation_test.ts` は PR157 が触る可能性があるため、B1-b 開始時に再確認する。

## 14. J の限定差分再レビューの観点（J1 の R1〜R8 と J2 の残件 R2／R3／R8）

| # | 観点 | 確認する反例 |
|---|---|---|
| J-R1 | 停止・許可リストが台帳に依存しない | 広い方針＋特定方針／許可外／方針欠如／既存の保留／read・dispatch・replay 中の OFF |
| J-R2 | 永続状態機械が I-1〜I-4 を満たす（live lease・slot・owner_epoch の CAS） | **期限切れ claimed への別 ID（takeover）／live への別 ID（reject）／dispatching の失効（unknown・no-resend）／遅延 worker の authorize・finish／同 ID の token 回転／`lease_until = now` の境界**／別 ID の同時実行／ペイロード不一致／begin・authorize・finish の応答喪失／落ちた送信者／TTL 後の同 ID／課金済みの拒否・検証失敗／日付またぎ |
| J-R3 | 匿名・失効・停止・同意撤回の後の副作用が無い（**権威行を共有ロックしたまま判断と保存を同一 TX で行う**。F5 のロック順に追従） | **撤回 commit が先／finish が先の両順序（2 接続）／物理削除の前後／同意 OFF→ON／entitlement 変更／replay 中の撤回**／匿名ユーザー／静的キー／locked・deleting／処理中の撤回・退会／CASCADE |
| J-R4 | 画面の事実文が全てサーバー確定文 | 空の picks／存在しない ID／質問由来の数値／入れ替え／誘導／語彙の迂回 |
| J-R5 | scope 射影・同意の順序・PII | market の個人データ読み取り無し／stock 拒否／同意前の読み取り無し／質問内 PII |
| J-R6 | 時点・完全性 | null／未来／休日／>30／部分／編集後／信用・売り |
| J-R7 | バイト上界 | 日本語の最大入力／1 回上限と予約／JST ロールオーバー／分次 |
| J-R8 | 凍結契約（**公開型は Phase A の union 1 つ**。内部 outcome と分離） | Source.kind 全値の写像／`get_ai_ask_result` の実戻り値 union／DB・Edge・client の serialize/decode 往復／`in_progress` が `failed` ＋コードであること／`dataAsOf` の意味変更の同期 |

判定: PASS（B1 着手可）／CHANGES_REQUIRED／BLOCKED（D1・D2 などユーザー決定待ちで確定できない場合）。**D1〜D8 が未決のままでも、設計の矛盾の検出は可能**。

## 15. 未決定事項・停止ゲート（ユーザー判断。fail-closed の既定値を併記）

| ID | 決めること | fail-closed の既定（承認までの挙動） | 推奨（承認ではない） |
|---|---|---|---|
| D1 | 使うプロバイダー/モデル・品質の確認 | `model_key` 未設定＝`unavailable`。実モデル・課金なし | まず低価格帯 1 モデル（G6 カタログ内）。評価は B1-d（オフライン→別承認の実機）。モデルを決めたら §9.3 を再計算して固定 |
| D2 | 外部 AI へ質問・ポートフォリオ文脈を送る同意と、プライバシーポリシー更新（REL-04） | 同意が無ければ AI 呼び出し自体をしない（P1/P2） | 初回モーダル・設定から撤回、提供元別の文面を先に審査。法的助言ではない |
| D3 | 回答の再生キャッシュ（15 分）を持つか | **キャッシュなしでも**、同じ ID の再課金はしない（tombstone で `result_expired`／`result_unknown`）。ただし回答は失われる | 15 分保持（保護列・本人のみ）。持たない場合も再課金を許さない |
| D4 | 本人の 1 日回数・分次・全体の日次/月次 USD | 日次 0・分次 0・台帳未設定（拒否） | 本人 5/日（初週）・分次 2。全体 USD は予算の所有者が決める（v1 の 20 USD/日は未承認の提案）。既存の月 5 USD 試行枠を変更しない |
| D5 | V1 の scope | `market`・`holdings` のみ。`stock` は拒否 | 同左。stock は B2（銘柄の曖昧さ・存在確認が増える） |
| D6 | 3 入口の文言と「準備中」を外す時期 | 準備中のまま | G6 の社内 canary 通過後・G7 と同時 |
| D7 | 保存・保持（履歴なし）の方針と文面 | 履歴なし。回答は最大 15 分、tombstone は内容なし、台帳は不透明 ID の利用記録 | 保持を 3 つ（アプリ／台帳／提供元）に分けて明示。提供元の保持は約束しない |
| D8 | 自動フォールバック・不明送信の再試行 | **なし**（I-1） | 変更するなら別の設計・予算・同意の承認が要る |
| **D9**（新・R3） | セッション失効の扱い（S1 受容遅延／S2 live predicate） | S1。受容遅延を運営者が承認するまで公開しない | G4 で `auth.sessions` の可読性を確認できれば S2 |
| **D10**（新・R2/R6/R7） | 数値パラメータ: lease 秒・tombstone 保持（48 h）・市況の最大経過日（5 日）・分次上限・本文の最大バイト | 提案値で B1 を開始するが、公開前に確定 | 実測（p95・Edge の実行時間上限）で調整 |

## 16. この設計の限界（正直に）

- **全て設計**。状態機械・RPC・権限・同意・フェンスは実装も実 PostgreSQL での検証も無い。J1 が通した反例の再現（実 PG17・ledger）は台帳の性質の確認であり、AI Ask の B1 の検証ではない。
- **別紙の付録の PostgreSQL モデルは B1 のコードではない**。ロック順・CAS・直列化の契約が J2 の反例を閉じること、およびテストが契約違反（ミュータント）を検出できることを、合成データ・Unix ソケットのみの使い捨てクラスタで確認したもの。実 RPC・実 RLS・実 ACL・所有者の実関数との交差・負荷は B1-a で検証する。
- 実プロバイダー・実費・実遅延・Auth の実挙動（匿名・セッション）は NOT_RUN。§9.3 の金額は見積り（`verifiedOn: 2026-10-10`）。
- 抽出的な V1 は「質問への的確さ」を犠牲にして「捏造できない」を取る設計。選択が不適切な場合は、無関係だが実在する根拠が並ぶ。
- Phase A の画面は未変更。「事実／選択」の表示分けは B1-c の小変更として提案する。
- 本書は Security 上の合格を意味しない。J1 の限定差分再レビューが必要。
