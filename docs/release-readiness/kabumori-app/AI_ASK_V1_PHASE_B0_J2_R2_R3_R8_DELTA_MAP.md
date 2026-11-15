# 「AIに聞く」V1 Phase B0 — J2 残件 R2／R3／R8 と J4 残件 R3-P2 の差分対応表（v2 → v3 → v3.1）

- 作成: F1（v3: `kabumori-f1-ai-ask-b0-j2-r2-r3-r8-correction-20261013`／**v3.1: `kabumori-f1-ai-ask-b0-terminal-finish-auth-fix-20261014`**）／ 2026-10-13〜14 JST
- 正本: J2 Report [`.agent_v2/reports/J2.md`](../../../.agent_v2/reports/J2.md)（`CHANGES_REQUIRED`。R2 P1・R3 P1・R8 P2 の 3 件が残件。R1／R4／R5／R6／R7 は設計限定で PASS）。以下の「J2 原文」の行番号は同ファイルの行。
- J4 Report: [`.agent_v2/reports/J4.md`](../../../.agent_v2/reports/J4.md)（`CHANGES_REQUIRED`。R2・R8 は設計限定 PASS、**残件は R3-P2 の 1 件**。原文 `J4.md:35-56`）。
- 対象設計: [`AI_ASK_V1_PHASE_B0_SECURITY_DESIGN.md`](./AI_ASK_V1_PHASE_B0_SECURITY_DESIGN.md)（**v3.1**。後継元: v3 = Draft PR #186 head `25d1b612073450ee31b39458c8a4fc0308328cd4`、v2 = Draft PR #177 head `2f33cffd4754a5576b112623b3aedc2dd31740b8`、v1 = Draft PR #171 head `0beda46186efe1db680909f369e2571609851d81`）。
- **後継優先関係**: 同名の設計書が PR171・PR177・PR186・本 PR に独立して存在する。**正本は v3.1 > v3 > v2 > v1**。本書の §3（テスト条件）は、PR177 の別紙 `…_J1_CORRECTION_MAP.md` の T6／T26／T28／T29／T31／T33／T38／T43／T44 の条件を**置き換える**（その他の ID は PR177 の別紙のまま。**v3.1 は T28／T31／T43 に終端 finish 再送の条件を追記**）。PR171・PR177・PR186 を盲目的にマージしない。
- 性格: 設計の差分対応表。**実装も実 DB（本番）も実プロバイダーも無い**。「解消した」とは「v3 の設計が J2 の反例を閉じる契約になった」の意味で、B1 の実装の検証ではない。§4 の PostgreSQL モデルは**契約の最小モデル**（B1 のコードではない）。

## 1. 対応表（J2 残件 → v2 → v3 → 受入テスト）

### J2-R2 [P1] live な lease と所有権を dispatch／finish の条件に固定する

| 項目 | 内容 |
|---|---|
| J2 原文 | `J2.md:48-54`（共通ロック順と CAS の明記、authorize は live lease＋現在の active_request_id＋token／epoch／state 一致、期限切れ claimed への別 ID の takeover/reject、dispatching の unknown 確定と遅延 finish 拒否、`=` 境界、終端化・slot 解除が古い worker から新所有者を消さない、課金不明は no-resend、T6／T26／T28／T29／T38 の追加、T29 の 48h 後の扱い、台帳 ID 衝突の統合確認） |
| v2（PR177） | §4.3 #2〜#9／I-2。#3 は token／state／gate／quota／lifecycle のみ、#5 は token／G-finish／lifecycle のみで、`lease_until`・`active_request_id` の一致が契約に無かった。#2 は同 ID の再開、#7 は dispatching の整理のみで、期限切れ claimed と別 ID の順序が一意でなかった |
| v3 | **§4.3** 固定ロック順 L1〜L8（所有者 F5 の I1 順序の後ろに AI Ask の行を連ねる）と RPC×段の表、規則 1〜5（昇順・READ COMMITTED・`lock_timeout 3s`・`v_now` はロック取得後・外部 HTTP/台帳を呼ばない）。**§4.4** 述語 `LIVE`（`lease_until > v_now`、**`=` は失効**）／`OWN`（user・request・token・owner_epoch）／`SLOT`（`active_request_id = r.request_id`）と、全遷移への適用。#7 に「期限整理」を一般化（`claimed → failed_unsent`、`dispatching → unknown_after_send`、slot は CAS 解除）。不変条件 I-4（失効した所有者は何も書けない）を追加。**§4.6** 別 ID／同 ID／応答喪失／tombstone 後の決定表。**§4.5** callId を内部 `request_id` 由来に変更（台帳の確定済み attempt との衝突を回避） |
| 反例の扱い | token／state／各 gate が一致したまま期限だけ超過した A の authorize → `LIVE` が偽で `lease_expired`（整理して slot 解除）。A 失効→B takeover の後の A の遅延 authorize／finish → state（`failed_unsent`／`unknown_after_send`）・token・epoch・slot で拒否。B の slot は A の整理の CAS で消えない |
| 受入テスト | T6・T26・T28・T29・T38（§3 に更新後の 2 接続の順序表）。T37（同意版の digest 不一致） |
| ソース根拠 | 台帳 `(request_id, attempt)`（migration `:237`、`:469-478`）、`types.ts:41-49`（`maxAttempts`・`retryOnTimeout`）、`execute.ts:75-76`・`ledger_guard.ts:131`、所有者の I1 順序（foundation `:364-392`）。**モデル検証**: 付録 R2-A1〜A8 |
| 残る決定 | D3（15 分キャッシュ）、D8（不明の再試行なし）、**D10**（claim lease 30 秒・dispatch lease 45 秒・tombstone 48h の確定） |

### J2-R3 [P1] request 行のロックだけでは同意／ライフサイクルの撤回と直列化できない

| 項目 | 内容 |
|---|---|
| J2 原文 | `J2.md:56-64`（settings／allowlist・common lifecycle／entitlement・consent・user-state／request の権威行と固定ロック順、判断と保存を同じ競合フェンスに置く、共通 owner の既存ロック順の確認と非変更、DB トランザクションを外部 HTTP の間保持しない、撤回先行／finish 先行の両順序、物理削除の前後・consent OFF→ON・entitlement 変更・replay 中の撤回を 2 接続で、deadlock/timeout は安全拒否、D9 は未決定のまま） |
| v2（PR177） | §5.3「finish が行を `FOR UPDATE` で取り、`profiles` と述語を同じトランザクションで確認する」。request 行のロックは別テーブルの更新を止めないため、J2 の PG 反例（`deleting`／`answered`／`checked-v1`）が成立した |
| v3 | **§5.3.2** 権威行 L1〜L5 を**共有ロックしたまま**、判断と保存を同一トランザクションで行う（`FOR SHARE`／`FOR KEY SHARE`）。**§5.3.3** 線形化点の表（authorize・finish・replay・撤回・サービス終了。変更が先／判断が先のどちらでも合法な履歴が 1 つに定まる）。**§5.3.4** F5 のロック順の調査結果（競合なし・追従する側・契約前提）。**§2/§5.3.2** 外部 HTTP の間は DB のトランザクションもロックも保持しない。`settings_epoch` の比較をやめ、ゲートの**述語を再評価**（無関係な設定変更で飛行中の要求をキャンセルしない）。撤回は L5 のみで常に成功 |
| 反例の扱い | `request FOR UPDATE → actor SELECT → 停止 → 別接続が deleting を commit → finish が answered を commit`（J2）→ finish が L1 を `FOR SHARE` で保持するため、所有者の `FOR UPDATE` は finish の commit まで待つ（付録 R3-B4。**v2 の契約をそのまま実装したミュータントは同じ反例を再現**＝付録 R3-B3）。撤回が先 → finish は `cancelled`・回答なし・slot 解除（R3-B2）。consent OFF→ON → epoch が動き `cancelled`（R3-B8） |
| 受入テスト | T31・T43（§3 に更新後の 2 接続の順序表）、T21・T30・T41・T42 |
| ソース根拠 | foundation `:364-392`（lock 関数）・`:1083-1096`（`withdraw_kabumori_service`）・`:48-49,410-427,462-472`（I7）、service_start_intent／deletion_completion の各 RPC、未マージ #152（I1 順序・`lock_timeout 3s`）。**モデル検証**: 付録 R3-B1〜B9 |
| 残る決定 | **D9**（セッション失効の受容遅延 S1／S2。**未決定のまま**）。F5 の未マージ分は B1-a 開始前に再確認（§5.3.4 前提 3） |

### J2-R8 [P2] DB／Edge／client へ渡す wire 型を 1 つに固定する

| 項目 | 内容 |
|---|---|
| J2 原文 | `J2.md:66-72`（canonical Source.kind と `market_report → report` を含む全 evidence→wire 写像、title／asOf／ref のサーバー出所、内部 begin outcome と公開 AskResponse.status の区別、v1 の処理中は `failed`＋コードの 1 つの形、T44 に source kind 全値・get_result の実戻り値 union・往復、`dataAsOf` の意味変更の B1-c 同期） |
| v2（PR177） | §7.2「sources は kind から作る」、§10.2 の公開 union（`answered`／`refused`／`failed`）、§5.5 の `get_ai_ask_result`（`pending(in_progress)` を含む）、§10.3（`in_progress` は `failed` の v1 代替）、§10.5（真の `pending` は v2）。evidence.kind（`news｜market_report｜holding`）、v2 の公開 Source.kind（`news｜report｜market｜holding`）、Phase A（`news｜report｜market_data｜holding`）が不一致。`message`／`retryable`／`remainingToday` は Phase A に無い |
| v3 | **§10.0** 層の分離（A 内部 RPC outcome／B 内部 state／**C 公開 `AskResponse`＝唯一の wire 型**）。**§10.2** Phase A の union を**そのまま**（`AskSourceKind` は 4 値のまま）。`message`／`retryable`／`remainingToday`／`pending` を撤回。**§10.2.1** evidence→wire の全値写像（`news→news`、**`market_report→report`**、`holding→holding`、`market_data` は V1 で生成しない）と title／asOf／ref の出所（サーバー）。**§10.4** 内部 outcome → 公開の写像表（G6 の `AiErrorCode` 全値を網羅）と HTTP 規則。**§5.5** `begin` は `{claimed}｜{respond: AskResponse}`、`get_ai_ask_result` は `AskResponse` そのもの（新 status なし）。**§10.6** B1-c の型変更（`AskFailureCode` +7・`isRetryable`・`dataAsOf` の意味）を明示。**§10.7** 機械可読な `AskResponseWireV1` を共有フィクスチャにし、DB serializer・Edge・client decoder の往復一致を T44 に |
| 反例の扱い | 市況を直接写像すると列挙のどれとも不一致 → `market_report → report` に固定。`pending` が別実装になる → `pending` を契約に入れず `failed`＋`in_progress` の 1 形のみ。内部と公開の混在 → 3 層の分離と変換表 |
| 受入テスト | T44（§3）、T20・T2・T8・T41 |
| ソース根拠 | PR166 `src/lib/ai-ask.ts:34-71`（`AskSourceKind`・`AskResponse`・`AskFailureCode`）、`:227-249`（`isRetryable`）、`types.ts`（G6 の `AiErrorCode`）。PR166 は未マージ・未出荷 |
| 残る決定 | B1-c の型変更は PR166 のマージ判断（別）に依存。契約の凍結は J の限定再レビュー PASS が条件 |

### J4-R3-P2 [P2] 冪等な finish の終端再返却が AUTH を迂回する（v3.1）

| 項目 | 内容 |
|---|---|
| J4 原文 | `J4.md:35-56`（冪等な terminal-finish でも現在の AUTH を同じ L1〜L5 のロック下で検査し、拒否なら保存済み本文を返さない。終端行の再生成・日次の払い戻し・新送信はしない。冪等再送に LIVE／現在 slot を再要求して正常な finish 応答喪失を壊さない。§4.6／§5.5 に「lease 例外は AUTH 例外ではない」を明記し、付録モデルを揃える。3 ケースで成功返却が無いこと、AUTH 有効の正常な同 digest 再送は期限後でも同じ保存済み結果を返すこと） |
| v3（PR186） | §4.6「同 token・同 epoch・同 `finish_digest` の再送は保存済みを返す（冪等）。lease 切れ後でも可」。付録モデルの `finish_ask` は、`_fence()` の認可結果を見る**前**に `stored:idempotent` を返す。通常の `replay_ask` は同じ状況で `unavailable` |
| v3.1 | **§4.4 #11** 終端 finish の冪等再送の遷移（ガード = `OWN` ∧ `finish_digest` 一致 ∧ **現在の `AUTH`**、`LIVE`・`SLOT` は要求しない）。**§4.4 I-5**「lease／slot の例外は AUTH の例外ではない」。**§4.6** 応答喪失の窓の finish 行と「終端 finish の再送と通常の replay は同じ結果になる」の項。**§5.3.3** 線形化点の表に「終端 finish の冪等再送」の行（replay と同じ線形化点）。**§5.5** `finish_ai_ask` の戻り値に `denied`（冪等再送で AUTH が失効。本文は返さない）。**§10.4** `denied` → 公開 `unavailable` の写像。付録モデルの `finish_ask` を同じ意味に修正し、J4 の 3 反例を回帰として追加 |
| 反例の扱い | (a) 同意撤回の後・(b) 退会処理開始（`deleting`）の後・(c) 設定 `enabled=false` の後の終端 finish 再送 → いずれも `denied:*` で本文を返さない（付録 J4-consent／J4-lifecycle／J4-gate）。通常の replay と結果が一致（`unavailable`）。**早期 return に戻したミュータントは 3 件とも `stored:idempotent` を返し、テストで検出される**。AUTH が有効な再送は lease が切れた後でも `stored:idempotent`（付録 J4-ok） |
| 二重課金・二重生成 | 再送は状態・`public_response`・日次・台帳を**一切変えない**（付録 J4-ok: dispatches=1・finish commit=1・状態は `answered` のまま）。AUTH 失効時も払い戻し・再生成・新送信は無い（I-1／I-3 は不変） |
| 線形化 | 再送トランザクションは L1〜L5 を共有ロックして判断するので、撤回の commit が先なら `denied`、再送が先なら返却（撤回より前の読み取り）。撤回は再送の commit の後に直列化される（付録 J4-race） |
| 受入テスト | **T31・T43・T28**（§3 に追記）、T41（権限表に `denied` の戻りを含める）、T44（`denied` の公開写像） |
| ソース根拠 | PR186 設計書 §3.3（G-finish）・§4.4 #5／#10・§4.6・§5.3.2〜5.3.3・§5.5。付録 `model.sql` の `finish_ask` と `replay_ask`（同じ `_fence`） |
| 残る決定 | なし（新しい決定事項は無い。D1〜D10 は未決定のまま。D9 のセッション失効判断も未決定） |

## 2. 前回 PASS（R1／R4／R5／R6／R7、および J4 が PASS とした R2／R8）の条件の保持確認

**v3 → v3.1 の変更範囲**（PR186 の設計書との節別 diff）: ヘッダー、§0.1（J4 の行）、§4.4（#11 と I-5）、§4.6（finish 応答喪失の行と再送の項）、§5.3.3（再送の行）、§5.5（`finish_ai_ask` の戻り値）、§10.4（`denied`・`AiErrorCode` の注記行）、§14（J-R3 の観点）。**それ以外の節（§1〜§3 の本文、§4.1〜4.3・§4.5・§4.7〜4.8、§5.1〜5.2・§5.3.1〜5.3.2・§5.3.4〜5.3.5・§5.4、§6〜§9、§10.0〜10.3・§10.5〜10.7、§11〜§13、§15〜§16）は v3 のまま**。J4 が設計限定 PASS とした R2（ロック順・CAS・lease・slot・takeover）と R8（wire 型・写像・`in_progress`）の本文は変更していない。

v3 は次の**表現の整合**だけを直し、PASS 条件は変えていない（PR177 の設計書との `git diff` で、§3（§3.5 の参照番号 1 箇所を除く）・§6.2・§7.3・§8.2〜8.3・§9.1〜9.2・§9.4・§12 の本文に変更が無いことを確認できる）。

| 元 | 変更の有無 | 内容 |
|---|---|---|
| R1 | なし | §3 は無変更。4 評価点（begin／replay／dispatch／finish）は、§4.3／§5.3 の同一ロックの下で行われる、という実現方法だけが具体化された |
| R4 | なし | §7.3 の検証・抽出的方針は無変更。§7.2 は `title` を証拠の項目に追記し、sources を §10.2.1 の写像で作ると参照を張った（J2 の「R4 PASS」の範囲外の整合） |
| R5 | **注記の修正（J2 の指示）** | §6.1「読んではいけない」の「数量・取得単価」を、「**外向けの射影に含めない**。サーバー内の構成比計算・登録一致の検査のためにだけ読む（§8.3）」へ整理（§6.2 と §8.3 の矛盾の解消）。メモ・目標価格・他人の行は読まない |
| R6 | 表現のみ | §8.1 の「画面の時点」を「鮮度の判定は `trading_date`、画面には `title` に取引日・`Source.asOf` に `generated_at`」へ（§10.2.1 と整合）。時点・完全性の規則は無変更 |
| R7 | 注記のみ | §9.3 に「515 バイトのスキーマは例。契約の上限は 1,024 バイトで、実スキーマ・名前・採用モデルで T35 を再計算して確定」を追記（J2 の注記）。数値・上限は無変更 |

## 3. 更新後の受入条件（PR177 の別紙の同 ID を置き換える）

層: **DB**＝ローカル PG（B1-a）、**Edge**＝Deno＋フェイクモデル＋ローカル DB（B1-b）、**Client**＝ソーステスト（B1-c）。**接続 S1／S2** は別々の PG 接続（別トランザクション）。`⏸` は「そのトランザクションの判断後・commit 前の待機（race 窓）」で、B1 ではテスト専用のフック（`pg_sleep` を挟む BEFORE トリガ等。実装の記録は付録のモデルを参照）。括弧内の ID（R2-A1 等）は、付録の使い捨てモデルで同じ内容を確認済みのシナリオ。ID が無い条件は B1 の受入で初めて検証する。

### T6 ◎（R2・DB／Edge）同一ユーザー・異なる ID の並行／1 件ガード

| 手順 | 期待 |
|---|---|
| S1・S2 が同じユーザーで別 ID（X1／X2）の `begin` を同時に実行（10 回繰り返し・ユーザーは毎回別） | **ちょうど 1 件が `claimed`**、他方は `in_progress`（行も作られない・日次も消費されない）。`active_request_id` は勝者。台帳の予約 ≤ 1 |
| （検出力）L6 の行ロックを外し、判定と挿入の間に ⏸ を入れたミュータント | **2 件とも claimed になる**（テストが契約違反を検出する） |
| 分次上限（`minute_limit_per_user`）に達した連打 | 超過分は claim を作らず `rate_limited` |

モデル: R2-A6（10 回・ミュータントで 2 件 claimed を検出）。

### T26 ★◎（R2・DB）期限切れ所有者・takeover・遅延 worker・境界

| ケース | 手順 | 期待 |
|---|---|---|
| (a) 期限切れ claimed に別 ID | S1: A を claim（lease 短）→ 失効を待つ → S2: B を begin → S1: A の遅延 `authorize`／`finish` | B は **takeover**（A は `failed_unsent`・slot=B）。A の遅延呼び出しは `stale_owner`／`rejected`。B の slot は不変で B は authorize できる（R2-A1） |
| (b) live への別 ID | A が live（claimed／dispatching）の間に B を begin | `in_progress`（takeover しない）（R2-A2） |
| (c) dispatching の失効 | A を authorize（dispatch lease 短）→ 失効 → B を begin → A の遅延 finish | A は **`unknown_after_send`**（再送されない）・B は claimed。A の遅延 finish は `rejected:unknown_after_send`、**何も保存されない**。同 ID の begin(A) は `replay:unknown_after_send`（R2-A2） |
| (d) 失効境界 | `now = lease_until − 1ms` と `now = lease_until` | 前者は live（`in_progress`）、**後者は失効（takeover）**（R2-A4） |
| (e) 失効直後の authorize（未 takeover） | lease 切れの A が authorize | `lease_expired`、A は `failed_unsent`、slot は CAS で解除。同 ID の再送は #8 で epoch+1 の再 claim（R2-A5） |
| (f) lease 検査のミュータント | authorize から `lease_until > now` を外す | 期限切れの claim が `authorized` になる（検出される）（R2-A7） |

### T28 ★◎（R2・DB／Edge）begin／authorize／finish の応答喪失

| 失われたもの | 手順 | 期待 |
|---|---|---|
| begin の応答 | claim 後に同 ID を再送（live）／失効後に再送 | live の間は `in_progress`（**token を回転させない**）、失効後は #7→#8 で epoch+1 の再 claim。旧 token は拒否（R2-A3） |
| authorize の応答 | authorize commit 後に応答を捨て、同 ID を再送 | live の間 `in_progress`、失効後 `unknown_after_send`（**送信済み扱い・再送しない**） |
| finish の応答 | finish commit 後に応答を捨て、**同 token・同 epoch・同 `finish_digest`** で再送 | 保存済みの公開形が返る（冪等。lease 切れ後でも可） |
| finish が別結果で再送 | 終端が `unknown_after_send` の後に `answered` で finish | `rejected:unknown_after_send`（保存しない） |
| 日付またぎ＋応答喪失 | authorize が JST 23:59、finish／再送が 00:01 | 日次の払い戻し・消費は**消費した日の行**。翌日の再送は終端の再生／`result_expired`。カウントは戻らない（I-3） |
| **（v3.1）AUTH が有効な冪等再送** | finish commit 後（lease 切れの後を含む）に同 token・同 epoch・同 `finish_digest` で再送 | `stored:true`＋保存済みの公開形。**状態・日次・台帳に二重の効果が無い**（dispatches・finish commit・状態が不変）。別の outcome／別 token の再送は `rejected:<state>`（付録 J4-ok） |

### T29 ★◎（R2・DB）落ちた送信者・TTL・tombstone・同 ID の扱い

| ケース | 手順 | 期待 |
|---|---|---|
| 落ちた送信者 | dispatching のまま lease 切れ → 同 ID／別 ID | `unknown_after_send`。同 ID は `result_unknown`（再送しない）。別 ID は新しい論理要求（新しい消費） |
| 応答 TTL（15 分）後 | 終端後 15 分以降に同 ID | `result_expired`（**再課金しない・新規扱いにしない**）。日次カウントは TTL の削除で戻らない |
| **tombstone（48h）内** | 同じ ID の再送 | 終端（再生／`result_expired`／`result_unknown`）。**新しい論理要求にはならない** |
| **tombstone 満了後**（行が purge された後） | **同じ文字列**の ID が届く | サーバーは**区別できず**、新しい論理要求として扱う（行・内部 `request_id`・`callId` が新しい）。**全ての上限（日次・分次・全体予算・1 件ガード）が適用**され、追加で最大 1 回しか課金されない。通常の遅延再送を「明示の新操作」と見なすものではなく、クライアントは終端後の ID を再利用しない契約（§4.6） |
| 台帳 ID の衝突 | 上の「満了後の同じ文字列」を実 G6／台帳と統合して実行 | callId が内部 `request_id` 由来で新しいため **`ATTEMPT_FINALIZED`／`ATTEMPT_IN_FLIGHT` に当たらない**（B1-b の統合で確認） |

### T31 ★◎（R3・DB／Edge）同意・撤回・削除と replay の競合（2 接続）

| 順序 | S1 | S2 | 期待（線形化） |
|---|---|---|---|
| finish 先行 | `finish`（⏸ 1.0s） | 0.3s 後に `revoke_ai_ask_consent` | finish は `stored`。**撤回は finish の commit の後**に直列化。以後の replay は `unavailable`（R3-B1） |
| 撤回先行 | `revoke` commit | `finish` | finish は `cancelled`・**回答なし**・slot 解除（R3-B2） |
| 同意 OFF→ON（飛行中） | `revoke`→`accept` | `finish` | epoch が動いているため `cancelled`（保守的）（R3-B8） |
| replay 中の撤回 | `get_ai_ask_result`（⏸） | `revoke` | replay が先なら返す（撤回より前の読み取り）、撤回が先なら `unavailable` |
| ミュータント（v2 の契約） | request 行 `FOR UPDATE`＋actor の通常 SELECT で finish（⏸） | ライフサイクル変更を commit | **`answered` が `deleting` の後に commit される**（J2 反例の再現＝検出力。R3-B3） |
| **（v3.1）終端 finish の再送・撤回後** | finish を保存 → `revoke` → 同じ finish を再送 | `denied`（本文なし）。**通常の replay も `unavailable` で一致**（J4-consent） |
| **（v3.1）終端 finish の再送・退会処理開始後** | finish を保存 → 所有者がステータスを `deleting` → 再送 | `denied`（J4-lifecycle）。replay も `unavailable` |
| **（v3.1）終端 finish の再送・ゲート OFF 後** | finish を保存 → `settings.enabled=false` → 再送 | `denied`（J4-gate）。ゲートを戻した後は再び返却される |
| **（v3.1）再送 vs 撤回の競合（2 接続）** | S1: 終端 finish の再送（⏸ 1.0s）／S2: 0.3s 後に `revoke` | S1 は `stored:true`（撤回より前の読み取り）、**撤回は再送の commit の後**。次の再送は `denied`（J4-race） |
| **（v3.1）ミュータント（早期 return）** | 冪等の判定を AUTH の評価より前に置く | 上の 3 ケースで `stored:idempotent` を返す（**テストが検出する**。J4-consent／lifecycle／gate の MUTANT） |

### T43 ★◎（R3・DB／Edge）authorize／finish と lifecycle／同意／ゲートの変更の直列化

| ケース | 手順 | 期待 |
|---|---|---|
| authorize 先行 | S1: `authorize`（⏸）／S2: 0.3s 後に revoke | authorize は commit（以後の送信は取り消せない）。撤回は後。続く finish は `cancelled`（R3-B6） |
| 変更先行 | S1: ライフサイクルを `locked`／`deleting` に commit／S2: authorize | `denied`（`account_locked`）。**日次は消費されない**（R3-B5） |
| finish 先行 | S1: finish（⏸）／S2: 0.3s 後に所有者がステータス変更 | finish が先に commit。所有者の更新は finish の後（R3-B4）。以後の replay は拒否 |
| 物理削除（所有者の `withdraw_kabumori_service` 相当） | (a) finish（⏸）／withdraw を 0.3s 後 (b) withdraw（⏸）／finish を 0.3s 後 | (a) finish が `stored`・withdraw は待機して CASCADE で行が消える。(b) finish は**何も保存しない**・**行が復活しない**（R3-B7） |
| entitlement 変更 | 所有者が entitlement を `suspended`／`ended`（I7 により L1 の版も増える）にして commit | 以降の authorize／finish／replay は拒否 |
| デッドロック／ハング | ライフサイクル更新・同意の撤回・要求サイクル（begin→authorize→finish）を 3 接続で 25 回ずつ | デッドロック・lock timeout の発生が 0（発生しても**安全拒否**で、回答は保存されず、非終端の要求は常に ≤ 1）（R3-B9） |
| 順序の適合 | AI Ask の RPC が取るロックの順序を `pg_locks` で確認 | §4.3 の昇順のみ（逆順の取得が無い）。所有者の RPC と交差しても待機は有限 |
| **（v3.1）終端再送のロック** | 冪等な終端 finish の再送が取るロックを `pg_locks` で確認 | 通常の finish と同じ L1〜L5 の共有ロック（再送の経路だけ AUTH 用のロックを省いていない）。物理削除（所有者の `withdraw_kabumori_service` 相当）の後の再送は行が無く `stale_owner`（何も復活しない） |

### T33 ◎（R4・Edge）表現の明確化（J2 の指摘）

「入れ替えは画面に出ない」は、**モデルが自由文のエンティティ・符号・期間・数値を書き換える経路が存在しない**という意味に限定する。**無関係だが実在する証拠 E2 を選んだ場合**は、画面に（実在する確定文として）表示されるのが**正しい**（§7.4 の許容された残余リスク）。テストは「(1) 出力スキーマ外のキー・自由文は拒否」「(2) 空の picks は回答にしない」「(3) 質問由来の数値が画面に出ない」を検証し、「選択が質問に適切か」は検証しない（B1-d の実モデル評価）。T40 のファズは**実際の renderer**を対象にし、固定文集合への包含が「適切な回答」を証明するとは主張しない。

### T38 ◆◎（R2・DB）`failed_unsent` の再開と送信 1 回

| 手順 | 期待 |
|---|---|
| authorize 後の送信前エラー（`BUDGET_DENIED` 等）→ finish(`failed_unsent`) → 同 ID を再送（`send_epoch` 1→2） | 日次が払い戻され、再 claim は `owner_epoch+1`・`send_epoch+1`・**callId が別**。有料送信は論理要求あたり ≤ 1 |
| claimed の失効からの再 claim | `owner_epoch+1`、`send_epoch` は**据え置き**（台帳に何も作っていない） |
| 2 回目の `failed_unsent` の後（`send_epoch = 2`）の再 claim | `server_error` で終端 |
| 失効した所有者・遅延 finish の `failed_unsent` | `stale_owner`／`rejected`（slot を消さない） |

### T44 ◆◎（R8・Client／Edge／DB）wire 型の往復一致

| 検査 | 期待 |
|---|---|
| `Source.kind` の全値（`news`／`report`／`market_data`／`holding`）と evidence.kind の全値の写像 | `news→news`、**`market_report→report`**、`holding→holding`。`market_data` は V1 で生成されない。写像に無い値は `server_error` |
| `get_ai_ask_result` の**実際の戻り値**の union | `answered`／`refused`／`failed` のみ。存在しない・期限切れは `failed/result_expired`、処理中は `failed/in_progress`。**`pending` や未知の status を返さない** |
| `begin_ai_ask`／`authorize`／`finish` の内部 outcome と公開応答の分離 | 内部 outcome は client に出ない。`respond.response` は `AskResponse` として検証を通る |
| DB の serialize ↔ Edge の parse／serialize ↔ client の decode の往復 | 同一の `AskResponseWireV1` フィクスチャで**キー集合が過不足なく一致**（`message`／`retryable`／`remainingToday`／`pending` が無い）。未知のコード・status は client が `server_error` に落とす |
| `in_progress` | `{status:'failed', code:'in_progress'}`。client の `isRetryable` が真（同じ ID・間隔を空けて） |
| **（v3.1）`finish` の `denied`** | 公開は `{status:'failed', code:'unavailable'}`（保存済み本文を返さない）。RPC の戻り `{stored:false, reason:'denied'}` は client に出ない（層 A） |
| G6 `AiErrorCode` の全値 | §10.4 の写像表のどれかに落ちる（網羅テスト） |
| `dataAsOf` | 最古の出典の `asOf`（1 件でも null なら null）。Phase A の注釈（newest）を B1-c が更新 |

## 4. 検証記録（実施／NOT_RUN）

| 区分 | 内容 |
|---|---|
| 実施（read-only） | J2 Report 全文、PR177 の設計書・別紙、PR166 の `ai-ask.ts`、共通アカウント基盤 migration（lock 関数・全 lifecycle RPC・`withdraw_kabumori_service`・I7 トリガ）、`20261006230000`／`20261009120000` の lock 使用箇所、F5 未マージ Draft #152／#165／#183 の追加行（ロック文・順序の記述）、G6 `types.ts`／`cost.ts`／台帳 migration の該当箇所。行番号を設計書の根拠表に反映 |
| 実施（オフライン・使い捨て PG17） | **付録のモデル**: Unix ソケットのみ（TCP 無し）・合成ユーザー・実データ無し。**63 アサーション（設計 57＋ミュータント検出 6）が全て PASS**（v3 の 45 に J4 の回帰 18 を追加。実行時の出力は付録 C）。完了後にクラスタを停止・削除 |
| 実施（整合チェック） | 設計書・別紙の節番号・テスト ID・失敗コード・RPC 名・列挙の相互参照、`git diff --check` |
| **NOT_RUN** | B1 の SQL／RLS／RPC／Edge は存在しないため、実 RPC・実 RLS・実 ACL（`has_function_privilege`）、**所有者の実関数（`withdraw_kabumori_service` 等）との交差**、実 Auth（匿名・セッション失効）、台帳との統合（callId 衝突）、実負荷、本番の台帳・G2 migration・`verify_jwt`・JWT 有効期限・組織の支出上限、実プロバイダー・実費、Simulator／実機 |

付録のモデルが**示すこと**: ① v3 の契約（共有ロックの下での判断と保存・CAS・lease）は J2 の反例を閉じる。② v2 の契約（request 行ロック＋通常 SELECT）は反例を再現する（R3-B3）。③ lease 検査・スロットロックを外したミュータントはテストで検出される（R2-A6／A7）。④ **（v3.1）冪等 finish の早期 return（AUTH の迂回）は J4 の 3 ケースで検出され、AUTH が有効な再送は lease 切れ後でも維持される**（J4-*）。**示さないこと**: B1 のコードの正しさ、実環境での待機時間、F5 の実関数との相互作用（B1-a の受入）。

## 5. 未決定事項 D1〜D10（変更なし。停止ゲート）

D1〜D8 は v2 の §15 のまま（承認までの fail-closed 既定を併記）。本書で関係する値:

| ID | 内容 | 本書の関係 | 提案値（承認ではない） | 承認までの挙動 |
|---|---|---|---|---|
| D3 | 回答キャッシュの有無・TTL | tombstone があるので、キャッシュなしでも再課金しない | 15 分 | 未承認＝キャッシュなし相当（回答は再生できない） |
| D8 | 自動フォールバック・不明の再試行 | I-1（不明は送信済み扱い・再送しない） | なし | 変更不可 |
| **D9** | セッション失効の受容遅延（S1／S2） | **未決定のまま**。権威行の共有ロック（本書）は D9 に依存しない | S1（JWT 残存期限を受容）／G4 で `auth.sessions` を確認できれば S2 | 公開しない |
| **D10** | 数値パラメータ | claim lease・dispatch lease・tombstone・応答 TTL・分次・`lock_timeout` | claim lease **30 秒**／dispatch lease **45 秒**（`timeoutMs 20 秒` ＋検証・finish の余裕 25 秒。**`timeoutMs` より長いこと**が条件）／tombstone **48 時間**／応答 TTL **15 分**／分次 **2**／`lock_timeout` **3 秒**／市況の最大経過日 5 日 | 提案値で B1 を開始してよいが、公開前に実測（p95・Edge の実行時間上限）で確定 |

## 付録

### 付録 A. 使い捨て PostgreSQL モデル（`model.sql`）

B1 のコードではない。所有者側（`common_accounts`／`service_entitlements`／`profiles`）と AI Ask 側（設定・同意・user_state・requests・daily_usage）の最小の鏡像で、§4.3 のロック順・§4.4 の CAS を実装している。`p_weak`／`p_skip_lease` はミュータント用のフラグ。

<details><summary>model.sql</summary>

```sql
-- DISPOSABLE design-model proof for the AI Ask B0 v3 lock order / CAS contract (F1, 2026-10-13).
-- NOT B1 code. A toy mirror of: common_accounts, service_entitlements, profiles (owner side) and
-- ai_ask_settings / consents / user_state / requests / daily_usage (AI Ask side). No real data, no production.
set client_min_messages = warning;

create table common_accounts (user_id uuid primary key, status text not null default 'active',
                              lifecycle_version bigint not null default 1);
create table service_entitlements (user_id uuid not null references common_accounts (user_id) on delete cascade,
                                   service_key text not null, status text not null,
                                   primary key (user_id, service_key));
create table profiles (id uuid primary key);
create table ai_ask_settings (id boolean primary key default true check (id), enabled boolean not null default false,
                              settings_epoch bigint not null default 1);
create table ai_ask_consents (user_id uuid primary key references profiles (id) on delete cascade,
                              consented boolean not null default false, consent_epoch bigint not null default 1);
create table ai_ask_user_state (user_id uuid primary key references profiles (id) on delete cascade,
                                active_request_id uuid);
create table ai_ask_requests (request_id uuid primary key default gen_random_uuid(),
                              user_id uuid not null references profiles (id) on delete cascade,
                              client_request_id text not null, state text not null,
                              claim_token uuid not null default gen_random_uuid(),
                              owner_epoch bigint not null default 1, lease_until timestamptz not null,
                              lc_version bigint not null, consent_epoch bigint not null,
                              public_response jsonb, unique (user_id, client_request_id));
create table ai_ask_daily_usage (user_id uuid not null references profiles (id) on delete cascade,
                                 jst_day date not null, dispatches int not null default 0,
                                 primary key (user_id, jst_day));
create table audit (seq bigserial primary key, at timestamptz not null default clock_timestamp(), label text not null);
create table results (seq bigserial primary key, label text not null, ok boolean not null, detail text);

insert into ai_ask_settings (enabled) values (true);

create function new_user() returns uuid language plpgsql as $$
declare u uuid := gen_random_uuid();
begin
  insert into common_accounts (user_id) values (u);
  insert into service_entitlements values (u, 'kabumori', 'active');
  insert into profiles values (u);
  insert into ai_ask_consents (user_id, consented) values (u, true);
  return u;
end $$;

-- L1..L5 in the owner's I1 order (account -> entitlement -> profile) then AI Ask settings -> consent.
-- Every lock is kept until the end of the caller's transaction.
create function _fence(p_user uuid) returns jsonb language plpgsql as $$
declare a common_accounts; ent text; pr uuid; s ai_ask_settings; c ai_ask_consents;
begin
  perform set_config('lock_timeout', '3s', true);
  select * into a from common_accounts where user_id = p_user for share;                      -- L1
  if not found then return jsonb_build_object('ok', false, 'why', 'no_account'); end if;
  select status into ent from service_entitlements where user_id = p_user and service_key = 'kabumori' for share; -- L2
  select id into pr from profiles where id = p_user for key share;                            -- L3
  select * into s from ai_ask_settings where id for share;                                    -- L4
  select * into c from ai_ask_consents where user_id = p_user for share;                      -- L5
  if a.status <> 'active' then return jsonb_build_object('ok', false, 'why', 'account_' || a.status); end if;
  if ent is distinct from 'active' then return jsonb_build_object('ok', false, 'why', 'entitlement_' || coalesce(ent, 'none')); end if;
  if pr is null then return jsonb_build_object('ok', false, 'why', 'no_profile'); end if;
  if not coalesce(s.enabled, false) then return jsonb_build_object('ok', false, 'why', 'gate_closed'); end if;
  if not coalesce(c.consented, false) then return jsonb_build_object('ok', false, 'why', 'consent_missing'); end if;
  return jsonb_build_object('ok', true, 'lc', a.lifecycle_version, 'ce', c.consent_epoch);
end $$;

-- expiry: lease_until <= now is EXPIRED (equality counts as expired).
create function _terminalize_expired(r ai_ask_requests) returns void language plpgsql as $$
begin
  update ai_ask_requests
     set state = case r.state when 'claimed' then 'failed_unsent' else 'unknown_after_send' end
   where request_id = r.request_id and state in ('claimed', 'dispatching');
  update ai_ask_user_state set active_request_id = null
   where user_id = r.user_id and active_request_id = r.request_id;       -- CAS on the request id
end $$;

create function begin_ask(p_user uuid, p_cid text, p_lease_ms int default 30000,
                          p_now timestamptz default null, p_pause float default 0,
                          p_weak boolean default false) returns text language plpgsql as $$
declare f jsonb; act uuid; r ai_ask_requests; a ai_ask_requests; v_new ai_ask_requests; v_now timestamptz;
begin
  f := _fence(p_user);
  if not (f ->> 'ok')::boolean then return 'denied:' || (f ->> 'why'); end if;
  insert into ai_ask_user_state (user_id) values (p_user) on conflict do nothing;
  if p_weak then
    select active_request_id into act from ai_ask_user_state where user_id = p_user;               -- MUTANT: no row lock
  else
    select active_request_id into act from ai_ask_user_state where user_id = p_user for update;    -- L6
  end if;
  select * into r from ai_ask_requests where user_id = p_user and client_request_id = p_cid for update; -- L7
  if act is not null then
    select * into a from ai_ask_requests where request_id = act for update;
  end if;
  v_now := coalesce(p_now, clock_timestamp());                                                     -- after the locks
  if act is not null then
    if a.request_id is not null and a.lease_until <= v_now then
      perform _terminalize_expired(a);
      act := null;
      select * into r from ai_ask_requests where user_id = p_user and client_request_id = p_cid;
    end if;
  end if;
  if p_pause > 0 then perform pg_sleep(p_pause); end if;
  if r.request_id is not null then
    if r.state = 'claimed' then
      if r.lease_until > v_now or (act is not null and act <> r.request_id) then return 'in_progress'; end if;
      update ai_ask_requests set claim_token = gen_random_uuid(), owner_epoch = owner_epoch + 1,
             lease_until = v_now + make_interval(secs => p_lease_ms / 1000.0)
       where request_id = r.request_id returning * into v_new;
      update ai_ask_user_state set active_request_id = r.request_id where user_id = p_user;
      return format('claimed|%s|%s|%s', v_new.request_id, v_new.claim_token, v_new.owner_epoch);
    elsif r.state = 'dispatching' then
      return 'in_progress';
    elsif r.state = 'failed_unsent' then
      if act is not null then return 'in_progress'; end if;
      update ai_ask_requests set state = 'claimed', claim_token = gen_random_uuid(), owner_epoch = owner_epoch + 1,
             lease_until = v_now + make_interval(secs => p_lease_ms / 1000.0)
       where request_id = r.request_id returning * into v_new;
      update ai_ask_user_state set active_request_id = r.request_id where user_id = p_user;
      return format('claimed|%s|%s|%s', v_new.request_id, v_new.claim_token, v_new.owner_epoch);
    else
      return 'replay:' || r.state;
    end if;
  end if;
  if act is not null then return 'in_progress'; end if;
  insert into ai_ask_requests (user_id, client_request_id, state, lease_until, lc_version, consent_epoch)
  values (p_user, p_cid, 'claimed', v_now + make_interval(secs => p_lease_ms / 1000.0), (f ->> 'lc')::bigint, (f ->> 'ce')::bigint)
  returning * into v_new;
  update ai_ask_user_state set active_request_id = v_new.request_id where user_id = p_user;
  return format('claimed|%s|%s|%s', v_new.request_id, v_new.claim_token, v_new.owner_epoch);
end $$;

create function authorize_ask(p_user uuid, p_rid uuid, p_token uuid, p_epoch bigint, p_lease_ms int default 30000,
                              p_now timestamptz default null, p_pause float default 0,
                              p_skip_lease boolean default false)
returns text language plpgsql as $$
declare f jsonb; act uuid; r ai_ask_requests; v_now timestamptz;
begin
  f := _fence(p_user);
  if not (f ->> 'ok')::boolean then return 'denied:' || (f ->> 'why'); end if;
  select active_request_id into act from ai_ask_user_state where user_id = p_user for update;      -- L6
  select * into r from ai_ask_requests where request_id = p_rid and user_id = p_user for update;    -- L7
  if not found then return 'stale_owner'; end if;
  v_now := coalesce(p_now, clock_timestamp());                                                     -- after the locks
  if not p_skip_lease and r.state in ('claimed', 'dispatching') and r.lease_until <= v_now then   -- MUTANT: p_skip_lease
    perform _terminalize_expired(r);
    return 'lease_expired';
  end if;
  if not (r.state = 'claimed' and r.claim_token = p_token and r.owner_epoch = p_epoch and act = r.request_id) then
    return 'stale_owner';
  end if;
  if r.lc_version <> (f ->> 'lc')::bigint or r.consent_epoch <> (f ->> 'ce')::bigint then
    update ai_ask_requests set state = 'cancelled' where request_id = r.request_id;
    update ai_ask_user_state set active_request_id = null where user_id = p_user and active_request_id = r.request_id;
    return 'cancelled';
  end if;
  if p_pause > 0 then perform pg_sleep(p_pause); end if;
  update ai_ask_requests set state = 'dispatching', lease_until = v_now + make_interval(secs => p_lease_ms / 1000.0)
   where request_id = r.request_id;
  insert into ai_ask_daily_usage (user_id, jst_day, dispatches) values (p_user, current_date, 1)
  on conflict (user_id, jst_day) do update set dispatches = ai_ask_daily_usage.dispatches + 1;      -- L8
  insert into audit (label) values ('authorize_commit:' || p_rid);
  return 'authorized';
end $$;

create function finish_ask(p_user uuid, p_rid uuid, p_token uuid, p_epoch bigint, p_outcome text default 'answered',
                           p_pause float default 0, p_now timestamptz default null,
                           p_weak boolean default false, p_idem_skips_auth boolean default false)
returns text language plpgsql as $$
declare f jsonb; act uuid; r ai_ask_requests; ok boolean; st text; v_now timestamptz;
begin
  if p_weak then
    -- MUTANT = the v2 contract: request row FOR UPDATE + a plain read of the actor state, nothing else locked.
    select * into r from ai_ask_requests where request_id = p_rid and user_id = p_user for update;
    select a.status into st from common_accounts a where a.user_id = p_user;
    ok := (st = 'active');
    f := jsonb_build_object('ok', ok, 'lc', (select lifecycle_version from common_accounts where user_id = p_user),
                            'ce', (select consent_epoch from ai_ask_consents where user_id = p_user));
    select active_request_id into act from ai_ask_user_state where user_id = p_user;
  else
    f := _fence(p_user);
    select active_request_id into act from ai_ask_user_state where user_id = p_user for update;    -- L6
    select * into r from ai_ask_requests where request_id = p_rid and user_id = p_user for update;  -- L7
  end if;
  if r.request_id is null then return 'stale_owner'; end if;
  v_now := coalesce(p_now, clock_timestamp());                                                     -- after the locks
  if r.state not in ('claimed', 'dispatching') then
    if r.claim_token = p_token and r.owner_epoch = p_epoch and r.public_response ->> 'status' = p_outcome then
      -- Idempotent re-send of a terminal finish. The exception covers LIVE lease and SLOT only (the lease may be
      -- long gone). It is NOT an AUTH exception: the same L1..L5 shared locks and the same AUTH as replay apply.
      if not p_idem_skips_auth and not (f ->> 'ok')::boolean then return 'denied:' || (f ->> 'why'); end if;
      if p_pause > 0 then perform pg_sleep(p_pause); end if;     -- race window INSIDE the re-send transaction
      insert into audit (label) values ('finish_idem_commit:' || p_rid);
      return 'stored:idempotent';
    end if;
    return 'rejected:' || r.state;
  end if;
  if r.lease_until <= v_now then
    perform _terminalize_expired(r);
    return 'lease_expired';
  end if;
  if not (r.claim_token = p_token and r.owner_epoch = p_epoch and act = r.request_id) then return 'stale_owner'; end if;
  if not (f ->> 'ok')::boolean or r.lc_version <> (f ->> 'lc')::bigint or r.consent_epoch <> (f ->> 'ce')::bigint then
    update ai_ask_requests set state = 'cancelled' where request_id = r.request_id;
    update ai_ask_user_state set active_request_id = null where user_id = p_user and active_request_id = r.request_id;
    return 'cancelled';
  end if;
  if p_pause > 0 then perform pg_sleep(p_pause); end if;     -- race window INSIDE the finish transaction
  update ai_ask_requests set state = 'answered', public_response = jsonb_build_object('status', p_outcome)
   where request_id = r.request_id;
  update ai_ask_user_state set active_request_id = null where user_id = p_user and active_request_id = r.request_id;
  insert into audit (label) values ('finish_commit:' || p_rid);
  return 'stored';
end $$;

create function replay_ask(p_user uuid, p_cid text) returns text language plpgsql as $$
declare f jsonb; r ai_ask_requests;
begin
  f := _fence(p_user);
  if not (f ->> 'ok')::boolean then return 'unavailable'; end if;
  select * into r from ai_ask_requests where user_id = p_user and client_request_id = p_cid;
  if not found then return 'result_expired'; end if;
  return coalesce(r.public_response ->> 'status', 'in_progress');
end $$;

-- consent change (L5 only; never blocked by lifecycle state)
create function revoke_consent(p_user uuid) returns text language plpgsql as $$
begin
  update ai_ask_consents set consented = false, consent_epoch = consent_epoch + 1 where user_id = p_user;
  insert into audit (label) values ('revoke_commit:' || p_user);
  return 'revoked';
end $$;
create function accept_consent(p_user uuid) returns text language plpgsql as $$
begin
  update ai_ask_consents set consented = true, consent_epoch = consent_epoch + 1 where user_id = p_user;
  return 'accepted';
end $$;

-- owner side (F5 I1 order): account FOR UPDATE, then entitlement; the version moves with every change.
create function owner_set_status(p_user uuid, p_status text, p_pause float default 0) returns text language plpgsql as $$
begin
  perform 1 from common_accounts where user_id = p_user for update;
  if p_pause > 0 then perform pg_sleep(p_pause); end if;
  update common_accounts set status = p_status, lifecycle_version = lifecycle_version + 1 where user_id = p_user;
  insert into audit (label) values ('lifecycle_commit:' || p_user);
  return 'set:' || p_status;
end $$;

create function owner_withdraw(p_user uuid, p_pause float default 0) returns text language plpgsql as $$
begin
  perform 1 from common_accounts where user_id = p_user for update;                       -- L1 X
  perform 1 from service_entitlements where user_id = p_user and service_key = 'kabumori' for update;  -- L2 X
  update service_entitlements set status = 'deleting' where user_id = p_user and service_key = 'kabumori';
  update common_accounts set lifecycle_version = lifecycle_version + 1 where user_id = p_user;
  if p_pause > 0 then perform pg_sleep(p_pause); end if;
  delete from profiles where id = p_user;                                                  -- cascades into ai_ask_*
  update service_entitlements set status = 'ended' where user_id = p_user and service_key = 'kabumori';
  insert into audit (label) values ('withdraw_commit:' || p_user);
  return 'withdrawn';
end $$;

create function expect(p_label text, p_ok boolean, p_detail text default null) returns void language plpgsql as $$
begin
  insert into results (label, ok, detail) values (p_label, coalesce(p_ok, false), p_detail);
end $$;
```

</details>

### 付録 B. 実行スクリプト（`run.sh`）

使い捨てクラスタを Unix ソケット（`/private/tmp/f1v3pg`・TCP 無し）で作り、モデルを流し、2〜3 接続のシナリオを実行して停止・削除する。`LC_ALL=C`・`-E UTF8`・`lc_messages=C`（Homebrew PG17）。

<details><summary>run.sh</summary>

```bash
#!/bin/bash
# Disposable proof runner (design model only; see model.sql). Unix socket only, no TCP, fake users, then stopped.
export LC_ALL=C
D=/private/tmp/claude-501/-Users-yuya-Developer-kabumori/5b573098-889d-4d29-bb2d-890ef29a7011/scratchpad/v3proof
PGD="$D/pg"
SOCK=/private/tmp/f1v3pg
PORT=54933
DB=f1v3

rm -rf "$PGD" "$SOCK"
mkdir -p "$SOCK"
initdb -D "$PGD" -E UTF8 --locale=C -A trust >/dev/null || exit 1
pg_ctl -D "$PGD" -o "-p $PORT -c listen_addresses='' -c unix_socket_directories=$SOCK -c lc_messages=C" -l "$D/pg.log" -w start >/dev/null || exit 1
trap 'pg_ctl -D "$PGD" -m fast stop >/dev/null 2>&1; rm -rf "$SOCK"' EXIT
createdb -h "$SOCK" -p $PORT $DB || exit 1
psql -h "$SOCK" -p $PORT -d $DB -X -q -v ON_ERROR_STOP=1 -f "$D/model.sql" || exit 1

Q() { psql -h "$SOCK" -p $PORT -d $DB -X -q -At -c "$1" 2>&1; }
ck() { # label actual want
  local ok=false
  if [[ "$2" == "$3" ]]; then ok=true; fi
  Q "select expect('$1', $ok, 'got=$2 want=$3')" >/dev/null
}
newuser() { Q "select new_user()"; }
state_of() { Q "select state from ai_ask_requests where request_id='$1'"; }
active_of() { Q "select coalesce(active_request_id::text,'none') from ai_ask_user_state where user_id='$1'"; }
seq_of() { Q "select min(seq) from audit where label like '$1%'"; }
authorize_then_claim() { # user cid -> sets RID TOK EP and authorizes
  local u="$1" cid="$2" out
  out=$(Q "select begin_ask('$u','$cid',30000)")
  IFS='|' read -r _ RID TOK EP <<<"$out"
  Q "select authorize_ask('$u','$RID','$TOK',$EP,30000)" >/dev/null
}

# ------------------------------------------------------------------ R2
echo "## R2 scenarios"
# A1: claimed A expires; B (another id) takes over; A's late authorize/finish are rejected; B's slot intact.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','A',800)"); IFS='|' read -r _ A_RID A_TOK A_EP <<<"$OUT"
Q "select pg_sleep(1.1)" >/dev/null
OUT=$(Q "select begin_ask('$U','B',30000)"); IFS='|' read -r B_KIND B_RID B_TOK B_EP <<<"$OUT"
ck "R2-A1 B takes over an EXPIRED claimed A" "$B_KIND" "claimed"
ck "R2-A1 A terminalized as failed_unsent" "$(state_of $A_RID)" "failed_unsent"
ck "R2-A1 slot owned by B" "$(active_of $U)" "$B_RID"
ck "R2-A1 late authorize(A) rejected" "$(Q "select authorize_ask('$U','$A_RID','$A_TOK',$A_EP)")" "stale_owner"
ck "R2-A1 late finish(A) rejected" "$(Q "select finish_ask('$U','$A_RID','$A_TOK',$A_EP)")" "rejected:failed_unsent"
ck "R2-A1 B slot still intact after A's late calls" "$(active_of $U)" "$B_RID"
ck "R2-A1 B can still authorize" "$(Q "select authorize_ask('$U','$B_RID','$B_TOK',$B_EP)")" "authorized"

# A2: dispatching A expires -> unknown_after_send (no resend); B takes over; A's late finish stores nothing.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','A',30000)"); IFS='|' read -r _ A_RID A_TOK A_EP <<<"$OUT"
ck "R2-A2 A dispatching (short dispatch lease)" "$(Q "select authorize_ask('$U','$A_RID','$A_TOK',$A_EP,800)")" "authorized"
ck "R2-A2 same-id begin while dispatching+live" "$(Q "select begin_ask('$U','A')")" "in_progress"
ck "R2-A2 other-id begin while dispatching+live" "$(Q "select begin_ask('$U','B')")" "in_progress"
Q "select pg_sleep(1.1)" >/dev/null
OUT=$(Q "select begin_ask('$U','B',30000)"); IFS='|' read -r B_KIND B_RID B_TOK B_EP <<<"$OUT"
ck "R2-A2 B claimed after A's dispatch lease expired" "$B_KIND" "claimed"
ck "R2-A2 A is unknown_after_send (never re-sent)" "$(state_of $A_RID)" "unknown_after_send"
ck "R2-A2 A's late finish stores nothing" "$(Q "select finish_ask('$U','$A_RID','$A_TOK',$A_EP)")" "rejected:unknown_after_send"
ck "R2-A2 B slot intact" "$(active_of $U)" "$B_RID"
ck "R2-A2 same-id begin(A) replays the terminal state" "$(Q "select begin_ask('$U','A')")" "replay:unknown_after_send"

# A3: same-id token rotation only after expiry; old token dies.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','A',800)"); IFS='|' read -r _ RID TOK1 EP1 <<<"$OUT"
ck "R2-A3 same-id retry inside live lease is in_progress (no rotation)" "$(Q "select begin_ask('$U','A',800)")" "in_progress"
ck "R2-A3 token unchanged by the rejected retry" "$(Q "select (claim_token='$TOK1')::text from ai_ask_requests where request_id='$RID'")" "true"
Q "select pg_sleep(1.1)" >/dev/null
OUT=$(Q "select begin_ask('$U','A',30000)"); IFS='|' read -r K RID2 TOK2 EP2 <<<"$OUT"
ck "R2-A3 rotated after expiry (same request, epoch+1)" "$K|$([[ $RID2 == $RID ]] && echo same)|$EP2" "claimed|same|2"
ck "R2-A3 old token rejected" "$(Q "select authorize_ask('$U','$RID','$TOK1',$EP1)")" "stale_owner"
ck "R2-A3 new token accepted" "$(Q "select authorize_ask('$U','$RID','$TOK2',$EP2)")" "authorized"

# A4: boundary lease_until == now is EXPIRED (deterministic clock via p_now).
U=$(newuser)
Q "select begin_ask('$U','A',1000,'2026-10-13 00:00:00+00')" >/dev/null
ck "R2-A4 now = lease_until - 1ms : still live" "$(Q "select begin_ask('$U','B',1000,'2026-10-13 00:00:00.999+00')")" "in_progress"
OUT=$(Q "select begin_ask('$U','B',1000,'2026-10-13 00:00:01+00')")
ck "R2-A4 now = lease_until exactly : expired -> takeover" "${OUT%%|*}" "claimed"

# A5: late authorize by A after expiry but BEFORE anyone takes over: terminalized, slot freed, same id re-claims.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','A',800)"); IFS='|' read -r _ RID TOK EP <<<"$OUT"
Q "select pg_sleep(1.1)" >/dev/null
ck "R2-A5 authorize after expiry -> lease_expired" "$(Q "select authorize_ask('$U','$RID','$TOK',$EP)")" "lease_expired"
ck "R2-A5 slot released by CAS" "$(active_of $U)" "none"
OUT=$(Q "select begin_ask('$U','A',30000)"); IFS='|' read -r K RID2 TOK2 EP2 <<<"$OUT"
ck "R2-A5 same id re-claims from failed_unsent with epoch+1" "$K|$EP2" "claimed|2"

# A7: MUTANT without the live-lease predicate (token/state/epoch/slot all match, only the clock differs).
U=$(newuser)
OUT=$(Q "select begin_ask('$U','A',500)"); IFS='|' read -r _ RID TOK EP <<<"$OUT"
Q "select pg_sleep(0.8)" >/dev/null
ck "R2-A7 MUTANT (no live-lease check) authorizes an EXPIRED claim: detected" \
   "$(Q "select authorize_ask('$U','$RID','$TOK',$EP,30000,null,0,true)")" "authorized"

# A8: cleanup (another id's begin does the lazy expiry) vs finish, BOTH orders.
#  (a) finish acquires its locks while the lease is still live, the lease then expires inside its window:
#      the finish is the legal earlier history; B (begin) waits on the slot and then claims.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','A',30000)"); IFS='|' read -r _ A_RID A_TOK A_EP <<<"$OUT"
Q "select authorize_ask('$U','$A_RID','$A_TOK',$A_EP,1500)" >/dev/null
Q "select pg_sleep(1.0)" >/dev/null
Q "select finish_ask('$U','$A_RID','$A_TOK',$A_EP,'answered',1.2)" > "$D/s1.txt" &
Q "select pg_sleep(0.7)" >/dev/null
OUT=$(Q "select begin_ask('$U','B',30000)"); IFS='|' read -r B_KIND B_RID _ _ <<<"$OUT"
wait
ck "R2-A8a finish(live at lock time) stored; B claims after it; A answered; slot=B" \
   "$(cat $D/s1.txt)|$B_KIND|$(state_of $A_RID)|$([[ $(active_of $U) == $B_RID ]] && echo slot_B)" "stored|claimed|answered|slot_B"
#  (b) expiry cleanup first: the late finish is rejected (covered by A2); here with the finish starting AFTER the cleanup.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','A',30000)"); IFS='|' read -r _ A_RID A_TOK A_EP <<<"$OUT"
Q "select authorize_ask('$U','$A_RID','$A_TOK',$A_EP,600)" >/dev/null
Q "select pg_sleep(0.9)" >/dev/null
Q "select begin_ask('$U','B',30000)" > "$D/s2.txt" &
FIN=$(Q "select finish_ask('$U','$A_RID','$A_TOK',$A_EP,'answered',0)")
wait
ck "R2-A8b cleanup first: finish rejected, A unknown_after_send, B holds the slot" \
   "$([[ $FIN == rejected:* || $FIN == lease_expired ]] && echo rejected)|$(state_of $A_RID)" "rejected|unknown_after_send"

# A6: two sessions race with DIFFERENT ids for one user (10 users): exactly one claim each time.
BAD=0
for i in 1 2 3 4 5 6 7 8 9 10; do
  U=$(newuser)
  Q "insert into ai_ask_user_state (user_id) values ('$U')" >/dev/null   # row pre-exists: FOR UPDATE is the only serializer
  Q "select begin_ask('$U','X1',30000)" > "$D/r1.txt" &
  Q "select begin_ask('$U','X2',30000)" > "$D/r2.txt" &
  wait
  C=$(cat "$D/r1.txt" "$D/r2.txt" | LC_ALL=C /usr/bin/grep -c '^claimed|')
  if [[ "$C" != "1" ]]; then BAD=$((BAD+1)); fi
done
ck "R2-A6 10 races, distinct ids: always exactly one claim" "$BAD" "0"
# mutant: no user_state row lock + a pause between check and insert -> both claim (test sensitivity).
U=$(newuser)
Q "insert into ai_ask_user_state (user_id) values ('$U')" >/dev/null
Q "select begin_ask('$U','Y1',30000,null,0.6,true)" > "$D/r1.txt" &
Q "select begin_ask('$U','Y2',30000,null,0.6,true)" > "$D/r2.txt" &
wait
C=$(cat "$D/r1.txt" "$D/r2.txt" | LC_ALL=C /usr/bin/grep -c '^claimed|')
ck "R2-A6 MUTANT (no slot lock) is DETECTED: two claims" "$C" "2"

# ------------------------------------------------------------------ R3
echo "## R3 scenarios"
# B1: finish commits FIRST (revoke waits for the S locks) -> legal history; replay after revoke refused.
U=$(newuser); authorize_then_claim "$U" F1
Q "select finish_ask('$U','$RID','$TOK',$EP,'answered',1.0)" > "$D/s1.txt" &
Q "select pg_sleep(0.3)" >/dev/null; R=$(Q "select revoke_consent('$U')")
wait
ck "R3-B1 finish (started first) stored" "$(cat $D/s1.txt)" "stored"
ck "R3-B1 revoke serialized AFTER finish commit" "$([[ $(seq_of finish_commit:$RID) -lt $(seq_of revoke_commit:$U) ]] && echo yes)" "yes"
ck "R3-B1 replay after revoke is refused" "$(Q "select replay_ask('$U','F1')")" "unavailable"

# B2: revoke commits FIRST -> finish cancelled, nothing stored.
U=$(newuser); authorize_then_claim "$U" F2
Q "select revoke_consent('$U')" >/dev/null
ck "R3-B2 finish after revoke -> denied/cancelled" "$(Q "select finish_ask('$U','$RID','$TOK',$EP)")" "cancelled"
ck "R3-B2 no response stored" "$(Q "select coalesce(public_response::text,'null') from ai_ask_requests where request_id='$RID'")" "null"
ck "R3-B2 slot released" "$(active_of $U)" "none"

# B3: MUTANT = v2 contract (request lock + plain read): lifecycle change commits INSIDE the finish window.
U=$(newuser); authorize_then_claim "$U" F3
Q "select finish_ask('$U','$RID','$TOK',$EP,'answered',1.0,null,true)" > "$D/s1.txt" &
Q "select pg_sleep(0.3)" >/dev/null; Q "select owner_set_status('$U','deleting')" >/dev/null
wait
ck "R3-B3 MUTANT stores an answer although the account committed deleting first (counterexample reproduced)" \
   "$(cat $D/s1.txt)|$(Q "select status from common_accounts where user_id='$U'")|$([[ $(seq_of lifecycle_commit:$U) -lt $(seq_of finish_commit:$RID) ]] && echo lc_first)" "stored|deleting|lc_first"

# B4: fenced finish vs lifecycle change started during the window: lifecycle waits (finish first, legal).
U=$(newuser); authorize_then_claim "$U" F4
Q "select finish_ask('$U','$RID','$TOK',$EP,'answered',1.0)" > "$D/s1.txt" &
Q "select pg_sleep(0.3)" >/dev/null; Q "select owner_set_status('$U','deleting')" >/dev/null
wait
ck "R3-B4 fenced finish stored, lifecycle serialized after it" \
   "$(cat $D/s1.txt)|$([[ $(seq_of finish_commit:$RID) -lt $(seq_of lifecycle_commit:$U) ]] && echo finish_first)" "stored|finish_first"
ck "R3-B4 replay after deleting is refused" "$(Q "select replay_ask('$U','F4')")" "unavailable"

# B5: lifecycle commits FIRST -> authorize and finish refuse.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','F5',30000)"); IFS='|' read -r _ RID TOK EP <<<"$OUT"
Q "select owner_set_status('$U','locked')" >/dev/null
ck "R3-B5 authorize after lifecycle change denied" "$(Q "select authorize_ask('$U','$RID','$TOK',$EP)")" "denied:account_locked"
ck "R3-B5 nothing consumed" "$(Q "select count(*) from ai_ask_daily_usage where user_id='$U'")" "0"

# B6: authorize vs revoke, both orders.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','F6',30000)"); IFS='|' read -r _ RID TOK EP <<<"$OUT"
Q "select authorize_ask('$U','$RID','$TOK',$EP,30000,null,1.0)" > "$D/s1.txt" &
Q "select pg_sleep(0.3)" >/dev/null; Q "select revoke_consent('$U')" >/dev/null
wait
ck "R3-B6 authorize first, revoke serialized after" \
   "$(cat $D/s1.txt)|$([[ $(seq_of authorize_commit:$RID) -lt $(seq_of revoke_commit:$U) ]] && echo auth_first)" "authorized|auth_first"
ck "R3-B6 the finish that follows the revoke is cancelled" "$(Q "select finish_ask('$U','$RID','$TOK',$EP)")" "cancelled"

# B7: physical withdrawal (owner: account X -> entitlement X -> profile delete) vs finish, both orders.
U=$(newuser); authorize_then_claim "$U" F7
Q "select finish_ask('$U','$RID','$TOK',$EP,'answered',1.0)" > "$D/s1.txt" &
Q "select pg_sleep(0.3)" >/dev/null; Q "select owner_withdraw('$U')" >/dev/null
wait
ck "R3-B7a finish first, withdraw waits then cascades" \
   "$(cat $D/s1.txt)|$(Q "select count(*) from ai_ask_requests where user_id='$U'")|$(Q "select count(*) from profiles where id='$U'")" "stored|0|0"
U=$(newuser); authorize_then_claim "$U" F8
Q "select owner_withdraw('$U',1.0)" > "$D/s1.txt" &
Q "select pg_sleep(0.3)" >/dev/null; FIN=$(Q "select finish_ask('$U','$RID','$TOK',$EP)")
wait
ck "R3-B7b withdraw first: finish stores nothing and nothing is resurrected" \
   "$([[ $FIN != stored ]] && echo not_stored)|$(Q "select count(*) from ai_ask_requests where user_id='$U'")|$(Q "select count(*) from ai_ask_user_state where user_id='$U'")" "not_stored|0|0"

# B8: consent OFF -> ON while a request is in flight: epoch moved -> cancelled (conservative).
U=$(newuser); authorize_then_claim "$U" F9
Q "select revoke_consent('$U')" >/dev/null; Q "select accept_consent('$U')" >/dev/null
ck "R3-B8 consent OFF->ON during flight: finish cancelled" "$(Q "select finish_ask('$U','$RID','$TOK',$EP)")" "cancelled"

# B9: deadlock / hang stress: lifecycle toggles + consent toggles + request cycles on ONE user, 3 sessions.
U=$(newuser)
( for i in $(seq 1 25); do
    O=$(Q "select begin_ask('$U','S$i',30000)")
    IFS='|' read -r K R T E <<<"$O"
    if [[ "$K" == "claimed" ]]; then
      Q "select authorize_ask('$U','$R','$T',$E,30000)"
      Q "select finish_ask('$U','$R','$T',$E)"
    fi
  done > "$D/w1.txt" 2>&1 ) &
( for i in $(seq 1 25); do Q "select owner_set_status('$U','active')"; done > "$D/w2.txt" 2>&1 ) &
( for i in $(seq 1 25); do Q "select revoke_consent('$U')"; Q "select accept_consent('$U')"; done > "$D/w3.txt" 2>&1 ) &
wait
DL=$(cat "$D/w1.txt" "$D/w2.txt" "$D/w3.txt" | LC_ALL=C /usr/bin/grep -c -i -E "deadlock|lock timeout|canceling statement")
ck "R3-B9 no deadlock / lock timeout in the 3-session stress" "$DL" "0"
ck "R3-B9 invariant: at most one non-terminal request for the user" \
   "$(Q "select (count(*) filter (where state in ('claimed','dispatching')) <= 1)::text from ai_ask_requests where user_id='$U'")" "true"


# ------------------------------------------------------------------ J4 R3-P2 (terminal finish re-send must re-check AUTH)
echo "## J4 R3-P2 scenarios"
for KIND in consent lifecycle gate; do
  U=$(newuser); authorize_then_claim "$U" "J4$KIND"
  FIRST=$(Q "select finish_ask('$U','$RID','$TOK',$EP,'answered')")
  case $KIND in
    consent)   Q "select revoke_consent('$U')" >/dev/null; WANT="denied:consent_missing" ;;
    lifecycle) Q "select owner_set_status('$U','deleting')" >/dev/null; WANT="denied:account_deleting" ;;
    gate)      Q "update ai_ask_settings set enabled = false" >/dev/null; WANT="denied:gate_closed" ;;
  esac
  AGAIN=$(Q "select finish_ask('$U','$RID','$TOK',$EP,'answered')")
  REPLAY=$(Q "select replay_ask('$U','J4$KIND')")
  MUT=$(Q "select finish_ask('$U','$RID','$TOK',$EP,'answered',0,null,false,true)")
  if [[ $KIND == gate ]]; then Q "update ai_ask_settings set enabled = true" >/dev/null; fi
  ck "J4-$KIND first finish stored" "$FIRST" "stored"
  ck "J4-$KIND terminal finish re-send after the change is DENIED (no stored response returned)" "$AGAIN" "$WANT"
  ck "J4-$KIND normal replay agrees (unavailable)" "$REPLAY" "unavailable"
  ck "J4-$KIND MUTANT (idempotent return skips AUTH) is DETECTED: returns stored" "$MUT" "stored:idempotent"
done

# AUTH valid: an idempotent re-send is kept even long after the lease, and it does nothing a second time.
U=$(newuser)
OUT=$(Q "select begin_ask('$U','J4ok',30000)"); IFS='|' read -r _ RID TOK EP <<<"$OUT"
Q "select authorize_ask('$U','$RID','$TOK',$EP,500)" >/dev/null
FIRST=$(Q "select finish_ask('$U','$RID','$TOK',$EP,'answered')")
Q "select pg_sleep(0.8)" >/dev/null
AGAIN=$(Q "select finish_ask('$U','$RID','$TOK',$EP,'answered')")
ck "J4-ok first finish stored; re-send after the lease is expired returns the same result" "$FIRST|$AGAIN" "stored|stored:idempotent"
ck "J4-ok replay still returns the stored answer" "$(Q "select replay_ask('$U','J4ok')")" "answered"
ck "J4-ok no second effect: one usage row = 1 dispatch, one finish commit, state unchanged" \
   "$(Q "select dispatches from ai_ask_daily_usage where user_id='$U'")|$(Q "select count(*) from audit where label='finish_commit:$RID'")|$(state_of $RID)" "1|1|answered"
ck "J4-ok a re-send with a DIFFERENT outcome is rejected, not stored" "$(Q "select finish_ask('$U','$RID','$TOK',$EP,'refused')")" "rejected:answered"
ck "J4-ok a re-send with a stale token is rejected" "$(Q "select finish_ask('$U','$RID',gen_random_uuid(),$EP,'answered')")" "rejected:answered"

# Linearization of the terminal re-send vs a revoke (both orders), same shape as replay.
U=$(newuser); authorize_then_claim "$U" J4race
Q "select finish_ask('$U','$RID','$TOK',$EP,'answered')" >/dev/null
Q "select finish_ask('$U','$RID','$TOK',$EP,'answered',1.0)" > "$D/s1.txt" &
Q "select pg_sleep(0.3)" >/dev/null; Q "select revoke_consent('$U')" >/dev/null
wait
ck "J4-race re-send holding the shared locks first: returned; revoke serialized AFTER it; the next re-send is denied" \
   "$(cat $D/s1.txt)|$([[ $(seq_of finish_idem_commit:$RID) -lt $(seq_of revoke_commit:$U) ]] && echo resend_first)|$(Q "select finish_ask('$U','$RID','$TOK',$EP,'answered')")" \
   "stored:idempotent|resend_first|denied:consent_missing"

echo "## RESULTS"
psql -h "$SOCK" -p $PORT -d $DB -X -q -At -F ' | ' -c "select case when ok then 'PASS' else 'FAIL' end, label, detail from results order by seq"
psql -h "$SOCK" -p $PORT -d $DB -X -q -At -c "select 'TOTAL pass=' || count(*) filter (where ok) || ' fail=' || count(*) filter (where not ok) from results"
```

</details>

### 付録 C. 実行結果（本 TASK で実測）

| 結果 | シナリオ |
|---|---|
| PASS | R2-A1 B takes over an EXPIRED claimed A |
| PASS | R2-A1 A terminalized as failed_unsent |
| PASS | R2-A1 slot owned by B |
| PASS | R2-A1 late authorize(A) rejected |
| PASS | R2-A1 late finish(A) rejected |
| PASS | R2-A1 B can still authorize |
| PASS | R2-A2 A dispatching (short dispatch lease) |
| PASS | R2-A2 same-id begin while dispatching+live |
| PASS | R2-A2 other-id begin while dispatching+live |
| PASS | R2-A2 A is unknown_after_send (never re-sent) |
| PASS | R2-A2 B slot intact |
| PASS | R2-A2 same-id begin(A) replays the terminal state |
| PASS | R2-A3 same-id retry inside live lease is in_progress (no rotation) |
| PASS | R2-A3 token unchanged by the rejected retry |
| PASS | R2-A3 rotated after expiry (same request, epoch+1) |
| PASS | R2-A3 old token rejected |
| PASS | R2-A3 new token accepted |
| PASS | R2-A4 now = lease_until - 1ms : still live |
| PASS | R2-A4 now = lease_until exactly : expired -> takeover |
| PASS | R2-A5 authorize after expiry -> lease_expired |
| PASS | R2-A5 slot released by CAS |
| PASS | R2-A5 same id re-claims from failed_unsent with epoch+1 |
| PASS | R2-A7 MUTANT (no live-lease check) authorizes an EXPIRED claim: detected |
| PASS | R2-A8a finish(live at lock time) stored; B claims after it; A answered; slot=B |
| PASS | R2-A8b cleanup first: finish rejected, A unknown_after_send, B holds the slot |
| PASS | R2-A6 10 races, distinct ids: always exactly one claim |
| PASS | R2-A6 MUTANT (no slot lock) is DETECTED: two claims |
| PASS | R3-B1 finish (started first) stored |
| PASS | R3-B1 revoke serialized AFTER finish commit |
| PASS | R3-B1 replay after revoke is refused |
| PASS | R3-B2 finish after revoke -> denied/cancelled |
| PASS | R3-B2 no response stored |
| PASS | R3-B2 slot released |
| PASS | R3-B3 MUTANT stores an answer although the account committed deleting first (counterexample reproduced) |
| PASS | R3-B4 fenced finish stored, lifecycle serialized after it |
| PASS | R3-B4 replay after deleting is refused |
| PASS | R3-B5 authorize after lifecycle change denied |
| PASS | R3-B5 nothing consumed |
| PASS | R3-B6 authorize first, revoke serialized after |
| PASS | R3-B6 the finish that follows the revoke is cancelled |
| PASS | R3-B7a finish first, withdraw waits then cascades |
| PASS | R3-B7b withdraw first: finish stores nothing and nothing is resurrected |
| PASS | R3-B8 consent OFF->ON during flight: finish cancelled |
| PASS | R3-B9 no deadlock / lock timeout in the 3-session stress |
| PASS | R3-B9 invariant: at most one non-terminal request for the user |
| PASS | J4-consent first finish stored |
| PASS | J4-consent terminal finish re-send after the change is DENIED (no stored response returned) |
| PASS | J4-consent normal replay agrees (unavailable) |
| PASS | J4-consent MUTANT (idempotent return skips AUTH) is DETECTED: returns stored |
| PASS | J4-lifecycle first finish stored |
| PASS | J4-lifecycle terminal finish re-send after the change is DENIED (no stored response returned) |
| PASS | J4-lifecycle normal replay agrees (unavailable) |
| PASS | J4-lifecycle MUTANT (idempotent return skips AUTH) is DETECTED: returns stored |
| PASS | J4-gate first finish stored |
| PASS | J4-gate terminal finish re-send after the change is DENIED (no stored response returned) |
| PASS | J4-gate normal replay agrees (unavailable) |
| PASS | J4-gate MUTANT (idempotent return skips AUTH) is DETECTED: returns stored |
| PASS | J4-ok first finish stored; re-send after the lease is expired returns the same result |
| PASS | J4-ok replay still returns the stored answer |
| PASS | J4-ok no second effect: one usage row = 1 dispatch, one finish commit, state unchanged |
| PASS | J4-ok a re-send with a DIFFERENT outcome is rejected, not stored |
| PASS | J4-ok a re-send with a stale token is rejected |
| PASS | J4-race re-send holding the shared locks first: returned; revoke serialized AFTER it; the next re-send is denied |

`TOTAL pass=63 fail=0`（アサーション 63 件。うち `MUTANT` を含む 3 件は「契約違反を入れたときにテストが検出できること」の確認）
