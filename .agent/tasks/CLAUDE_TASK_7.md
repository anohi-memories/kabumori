# Claude Task 7 — MIC Stage 1 Formal Verification Design Finalization

- task_id: mic-stage1-formal-verification-design-finalization-g7-20261011
- owner: claude
- slot: claude-7
- status: ready
- next_owner: claude
- start_code: G7
- finish_code: K7
- completion_code: K7
- return_to: MICのちゃ（Market Intelligence Core専用チャット）
- recommended_model: Opus5.5（高）
- assigned_by: ChatGPT（MICのちゃ）
- assignment_basis: 2026-10-11 ユーザーがMIC専用担当をG7に明示指定し、次の作業開始を依頼
- task_type: DESIGN ONLY / Stage 1 formal Verification preimplementation
- target_pr: https://github.com/anohi-memories/kabumori/pull/125
- expected_pr_head_at_assignment: 7e548b9f2bff583664fc48a3ec1d658e552509d9
- source_design: docs/mic/stage1-formal-verification-design-20261010.md（Draft PR #125内のみ）
- decision_comment: https://github.com/anohi-memories/kabumori/pull/125#issuecomment-6096779221

## Scope and ownership

本チャットのMIC作業だけをG7が担当する。他のG枠（G1〜G6、G8〜G10）のTASK、Report、branch、worktree、dev server、担当案件を変更・再割当しない。G7単独担当はユーザーからの明示指定による。

**今回の目的**：PR #125の未確定4項目U2/U3/U6/U9と、ChatGPT設計コメントの競合・鮮度・安全性の懸念を既存設計書へ反映し、10/14以降のshadow自然観測PASSなら正式実装S1-Aを開始できる詳細仕様へ仕上げる。**実装開始・Stage 1 GO・main merge・production操作ではない。**

## Mandatory preflight before modifying anything

1. `PROJECT_RULES.md`, `HANDOFF.md`, `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, `.agent/ACTIVE_TASK.md`, このTASK、PR #125本文・レビュー・ChatGPT設計コメントの全文を確認する。
2. `/Users/yuya/Developer/kabumori-fresh` で fresh `origin/main` を取得し、G7専用の独立worktree/checkoutを新設する（例: `/Users/yuya/Developer/kabumori-g7-mic`）。`kabumori-fresh` 本体を共用作業場にしない。
3. `git worktree list --porcelain`, `git status`, branch、remote PR head、他slotと変更対象の競合を実際に確認する。PR #125既存worktree `/Users/yuya/Developer/kabumori-mic-stage1-design` は旧担当の環境として保護する。**旧worktreeを流用・checkout/reset/rebase/削除・stage・commitしない**。
4. PR #125 headが上記のcommitか確認。古いPRブランチが他worktreeにチェックアウト中でも、そのworktreeを触らない。G7専用worktreeで作業する方法が安全で、PRブランチの排他的な更新権限とremote head不変を確認できる場合にのみ既存PRへ文書差分を反映。必要に応じてG7専用の一時作業ブランチを使用し、リモート更新はnon-forceのfast-forwardかつ期待head一致の条件付きとする。**force push、他worktree操作、他人の変更取り込み・上書きは禁止**。排他確認ができない、PR headに他者変更がある、または安全に同PRを更新できない場合は作業を止めてK7で具体的blockerを報告し、勝手に別PRを量産しない。
5. main / PR / 他枠について競合を確認。特に `docs/mic/stage1-formal-verification-design-20261010.md` がmainに別途追加済みならSTOPし、競合を報告。
6. G7専用branchへの変更対象は原則**PR #125内の設計文書1ファイルのみ**。このTASKへのReport追記はG7自身の責任とし、既存G7 statusの処理・本体変更はK7判定へ返す。

## Design decisions to incorporate (approved by ChatGPT, not yet an implementation approval)

- **U2（条件付き採用）**：SQL側のdomain→event_type一覧をEdgeの `DOMAIN_EVENT_TYPES` と一致させる不変条件テスト。DBはhigh/criticalかつ未処理のイベントを独立判定する。特に既存Edge `unseenEvents` は `updated_at` の欠損・無効日時を**未処理として安全側**に扱うためSQL側も同等にする。新規イベント・同ID改定・イベント取込と読取の並行実行・Edgeの最近50件取得制限との差を洗い出す。Edge/DB不一致時はverifiedを発行しない。
- **U3（採用）**：Stage 1ではrunの不変 `verification_detail jsonb` にDB由来のmetric id/source/anchor/value/baseline/threshold/比較結果/未処理イベント/ブロック理由を保存。型付き `mic_state_evidence` の拡張は後続へ保留。検証証拠に欠損があればverified禁止。
- **U6（採用）**：fetch/observation/coverageはDBがsource/metric view等から独立再計算。Edge申告のみでverifiedにしない。複数SQL参照が異なるスナップショットになりうる状況を整理する。
- **U9（採用）**：通常no_changeとall-staleの双方を新RPCへ一本化。候補外・検証不成立は従来どおりno_changeを更新し `not_verified` と理由を監査記録。旧RPCはrollback用に維持。

## Mandatory safety/design corrections

1. **Phantom / READ COMMITTED**: `market_metrics` 既存行への `FOR SHARE` は新anchor行のINSERTを防げない。観測行SELECT・status view・イベント照合がREAD COMMITTED下で別々のスナップショットになり得ることを踏まえ、同時INSERT/更新時の整合性保証またはfail-closed判定を具体化。必要なら単一SQLスナップショット、advisory locking等の代替を比較し、ingestと競合させるならロック責務/デッドロックを明記。**「既存行をロックしているから新規INSERTも防げる」と誤記しないこと**。
2. **Event parity / bounds**: Edgeのイベント取得はdomain type filter＋公開日時の降順＋limit=50、`unseenEvents`では未記録ID・missing/invalid updated_at・後日の改定を判定している。DB判定が候補の事実を取りこぼさないこと（過去event、同ID上書き、最新50件超、time boundary）。未確定/過多の場合はnot_verified。
3. **Pointer/trigger**: currentの `verification_run_id` / `verified_at` が後続更新でも、narrative identityと一致し、誤ポインタを容認しない保証を検討。後続no_changeの `not_verified` が直前のverified pointerをどう扱うかの意味を明文化し、Stage 2が古い「成功」だけを根拠に延命しない読み取り条件を設定。誤ったverified runの除外・無効化（U11）も安全側に設計。
4. **A1仕様不一致**: 設計書1.2の「A1例外RAISE」と2.4の「identity_mismatchはnot_verified」記述を揃え、既存のno_change CAS/失敗時挙動と整合する理由を記す。
5. **Snapshot consistency**: `verified_at = now()` がトランザクション開始時刻であることと、DBが複数ステートメントで参照する最新観測時刻の関係を検証。正確な時刻意味を確定させる。
6. **Macro・same-date revision**: U1のequity未取得サンプル、同日改定のAI再評価方針、macro always_material制約はこの文書で実装GOと混同しない。96h/168h/0.64/AI backstopは依然仮値。
7. **Rollback**: 正式実装前v32へ戻す場合のDB追加列・トリガー互換性、誤verified証拠の無効化/除外、実装GO条件を漏れなく整理。
8. **No unauthorized scope expansion**: State material RPC、Scenario、consumer、重要ニュース、market-report、POSTONA、共通アカウント、共通AI基盤のコードや設定は触らない。

## Tests / verification (DESIGN ONLY)

- 変更前後の設計書diffと引用する現行コードの事実を照合。既存Stage0/Slice0の意味・Cron・AI call条件と矛盾がないこと。
- SQL test planに**少なくとも**新anchor並行INSERT、同日既存行upsert、high/critical event並行INSERT/更新、updated_at欠損/不正、最近50件上限、READ COMMITTED snapshot差、pointer残存と連続verified/not_verified、失敗/rollback、権限/ロック逆転を追記。
- migration / Edge / DBの**実テストは今回は実行しない**（コード変更なし）。可能な範囲で文書構造、矛盾、差分、リンクの静的検証を行う。
- docs-only PRのVercel free枠24hデプロイ制限はソース不具合として修正しない。

## Safety constraints

- **DESIGN ONLY**。禁止：source変更、migration作成・適用、本番DB write/read-only以外のProduction操作、Edge deploy、Cron変更、secret/access変更、実AI/API呼出、手動invoke、PR merge、production deploy、他G/H枠への割当。
- 他枠のTASK/Report/ブランチ/worktree/dev server/未コミット変更は保護。作業で必要があっても保護中PR branchのreset/rebase/force push/移動/削除は禁止。
- unrelated PR/CI不具合を直さない。docsのみcommit/push、PR #125をDraftのまま維持する。

## Completion criteria

1. U2/U3/U6/U9の決定と実装前提が設計文書に反映され、未解決事項は理由とGO gateを明記。
2. 同時INSERT・複数読み取り・イベントの改定・50件境界・ポインタ整合性・誤記録対処が説明され、安全な実装/テストの具体的道筋を示した。
3. A1仕様不一致を解消。従来のState material/Scenario挙動を変えない。
4. PR #125に文書だけの安全な追加commitがあれば、exact head・diff・Draft維持を確認。安全でなければSTOP/blockedを証拠と共に報告。
5. 実装・migration・本番変更0。設計完成報告で「Stage 1正式実装GO」は**10/14以降の自然観測と別途ChatGPT判断が条件**と明記。

## Completion reporting

このTASK末尾の `## Report` に以下を記録する:
- task_id / result / changed_files / tests（未実施も明記）
- PR head before/after / commit_hash / push / merge / deploy
- resolved U2/U3/U6/U9 / remaining_issues / safety_checks
- next_recommendation / return_to / completion_code

完了・停止後は **「MICのちゃ（Market Intelligence Core専用チャット）へ K7 を送ってください。」** と案内。PRはDraftを維持し、他のG/H TASKを終了・再割当しない。

## Report

- task_id: mic-stage1-formal-verification-design-finalization-g7-20261011
- result: not_started（ChatGPTがTASK登録。G7 Claude実行は未確認）
- changed_files: none
- tests: not_run
- commit_hash: none
- push: not_performed
- merge: not_performed
- deploy: not_performed
- remaining_issues: G7作業開始前。PR #125設計最終補強、10/14以降の自然shadow観測
- safety_checks: このTASK割当では本番・他workstream・ソースへの操作なし
- next_recommendation: G7を開始して設計文書だけを更新後、K7で確認
