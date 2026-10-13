# F6 — Opus朝刊・大引け統合ゲート／本番切替準備

- task_id: common-ai-f6-opus-both-release-preflight-20261013
- owner: claude
- slot: F6
- status: done
- next_owner: none
- start_code: F6
- completion_code: L6
- return_to: 共通AI基盤のちゃ（OpenAI・Claude API専用チャット）
- recommended_model: **Opus5.5（高）**
- scope: release preflight; **no unapproved production mutation**
- previous_archive: .agent_v2/archive/2026-10-13-f6-opus-primary-both-integration.md

## Goal
Prepare a conflict-safe integration/release path for Opus5.5 as PRIMARY on morning and close reports, prioritizing next available report. Keep default OFF until actual gates pass. User accepts missing pre-release delivery and postpones automatic OpenAI fallback, but does not approve uncontrolled costs, leaked secrets, unsafe production operations.

## Current dependencies (reverify on start)
- PR170 `46b27326360e66ec843f79bae6d01584088869d0` (F6 component), stacked PR173 `3605c2eb88380183b78757e092877ba2ff46c25f` (F2 handler), stacked PR175 `161f1f08c60b5b66cca2e770c53a783d43319642` (F6 primary_both). Draft/unmerged at allocation. GitHub currently reports PR170 mergeable false. Never assume conflict-free because earlier local merge-tree passed; diagnose with fresh origin/main.
- F2 L2 accepted done/none. **F2 owns** `supabase/functions/market-report-analysis/opus_primary_handler_test.ts`; its old MODE_UNSUPPORTED expectations fail after PR175. F2's saved handoff patch `docs/ai-provider/F2_PRIMARY_BOTH_F6_HANDOFF.patch` includes needed test-only update. Do not edit F2 file, TASK, branch or worktree; ChatGPT will provide copyable handoff to F2ちゃ, who owns assignment.
- F6 previous work source accepted with condition; provider 110/110 PASS; integrated report suite 319 PASS / 2 FAIL before F2 test update; locally patched test suite reported 322/322. No deployed Opus primary yet.
- Supabase Anthropic secret existence unknown. 30-day-expiry key exists per user but must never be read/printed/copied into GitHub. Trial ledger monthly $5/40, daily $2/6, per call $1. Propose higher policy only as a separate approved change.

## Work
1. Fresh main and full cross-slot worktree/file ownership collision check, including existing PRs and pending F2 test handoff; use independent clean F6 worktree. Do not begin if F2 file still owned elsewhere and overlap unavoidable.
2. Diagnose PR170 mergeable=false by inspecting GitHub status and comparing fresh main with the complete stack. Do not force/rebase/update other slot branches or merge Draft PRs automatically. Prepare exact merge order #170 → #173 → #175 → F2 test-only follow-up once independently accepted. Confirm tests after the full 4-step source composition.
3. Review and document exact release preflight: live environment/plan wall clock, valid model identifier, secret **name only**, monthly/day/call budget sufficiency, report schema and distribution safety. No access to secret values. Never claim paid smoke success without invocation and cost accounting.
4. Prepare scoped operational instructions for approved live rollout: source SHA read-back; Edge function deploy; byte/hash verification; `KABUMORI_MARKET_REPORT_AI_MODE=primary_both` as final gated ON action; observe first run; manual OFF recovery. Verify that actual app/X consumer gates are enabled before claiming delivered reports; source generation success alone is not delivery.
5. No merge, Edge deploy, secret/Cron/DB mutation, real paid Opus test or SNS write until specifically approved as an operation with safety checks. User accepts report failure, not unintended side effects. If one condition blocks, report exact blocker and nearest safe next action.
6. Test offline merge-tree/source simulation as possible, keep earlier provider tests valid, never weaken tests to ignore F2-owned regression. Record current PR statuses and detailed environment/secret name visibility (not values), budget recommendation and readiness.
7. Report with changed files, tests, current SHA, blockers, release NO_GO/GO candidacy; finish L6. Explicitly leave F2-owned test to F2ちゃ via separately shared handoff.

## Report
- task_id: common-ai-f6-opus-both-release-preflight-20261013
- result: **RELEASE_NO_GO（今は出せない）**。理由は下の4つの blocker
  - ソースの統合: 最新の main ＋ #170 → #173 → #175 → F2 のテスト変更（手元だけ）の4段階で、全スイート PASS、衝突なし
  - 本番の変更・merge・deploy・有料の呼び出しは 0
- changed_files: `.agent_v2/tasks/F6.md`（この Report）と `.agent_v2/ACTIVE_TASK.md` の F6 欄だけ。ソース・PR・ほかのスロットは変更していない
- PR（すべて OPEN / Draft。head は割り当て時のまま）
  - #170 `46b27326360e66ec843f79bae6d01584088869d0`（base main）
    - REST は `mergeable=true` / `clean`（base.sha は古い `59a04f70…` のまま）。`gh` は `UNKNOWN`
    - CI: Vercel Preview Comments PASS
  - #173 `3605c2eb88380183b78757e092877ba2ff46c25f`: `MERGEABLE` / `CLEAN`。Vercel PASS
  - #175 `161f1f08c60b5b66cca2e770c53a783d43319642`: `MERGEABLE` / `UNSTABLE`
    - 失敗は Vercel だけで、理由は「Deployment rate limited — retry in 24 hours」というプランの回数制限。コードの問題ではない

### 1. PR170 の mergeable=false の診断

- 衝突は無い。GitHub の値が古いか、計算途中だったと判断する（当時の理由は GitHub からは確かめられない）
- #170 の base `59a04f70…` から最新の main までは 64 コミットあるが、変わったのは `.agent` / `.agent_v2` だけ
  - `.agent` 以外で変わったファイルは 0
  - 4 PR のパスに触れたコミットも 0（`git log --full-history`）
- 最新の main `cd7661ca457456d20eefc9c3a1141c51741518ee` との `merge-tree`

| 合わせたもの | 結果 |
|---|---|
| main + #170 | 衝突なし（tree `5b243b15…`） |
| main + #173 | 衝突なし（tree `d9477fcf…`） |
| main + #175 | 衝突なし（tree `3c747981…`） |

### 2. 4段階を合わせた状態のテスト

- 環境: 使い捨ての worktree `/Users/yuya/Developer/kabumori-g6-qa-20261012`
  - main `2b202f56903df4aeffb3ba16d3d6a6e1c4cbd769` に #175 の head（#170 と #173 を含む）を `merge --no-commit` で重ねた（tree `cc3469e3…`）
  - その上に F2 のテスト変更だけを `git apply` で当てた
  - コミット・push はしていない
  - deno 2.9.6、macOS arm64

| 範囲 | 結果 |
|---|---|
| provider | 110/110 |
| market-report-analysis | **322/322**（F2 のテスト変更が無い場合は 319 / 2 FAIL。前回の Report のとおり） |
| `_shared` | 613 |
| personalized-reports | 134 |
| X の共有レポート利用側 | 10 |
| data-packet | 42 |
| broadcast-worker | 29 |

- 通信禁止と鍵・設定の環境変数8つの読み取り禁止で、primary・isolation・handler の関係 4 ファイル: 66/66
- 型チェック（index.ts）PASS
- lint: provider は問題 0。市況レポートの3件は main に元からあるもの
- F2 のテスト変更は、まだどの PR にも入っていない。**F2 のちゃの担当**（前回の Report の引き継ぎ文のとおり。PR175 の head の上に、opus_primary_handler_test.ts の部分だけを当てる）

### 3. 本番の点検（**読み取りだけ**。2026-10-13 15:20 ごろ JST に実行。値・digest・Cron の command は表示していない）

- Edge Secret の名前（32件）
  - **`ANTHROPIC_API_KEY` は無い**
  - `KABUMORI_MARKET_REPORT_AI_MODE` と `KABUMORI_MARKET_REPORT_PRIMARY_MODEL` も無い。今は OFF と同じで、安全側
  - `ANTHROPIC_CUSTOM_HEADERS` も無い（正しい）
  - 名前が `- OPENAI_API_KEY` と `- X_CLIENT_SECRET` の、先頭に「- 」が付いた登録が2件ある
    - 過去の登録ミスで、値の複製が残っている可能性がある
    - 関数はこの名前を読まないので害は無い。整理（unset）は利用者の判断
- モデル名: `claude-opus-5-5` はカタログにある（`model_catalog.ts`）
- 本番の関数
  - `market-report-analysis` は v30（2026-10-07 16:10 JST に deploy）
  - **本番のバイト列と最新の main は一致しない**
    - 違うファイル: `analysis_logic.ts`（差分 686 行）、`hard_fact_guards.ts`、`_shared/market_report_packet.ts`、`_shared/market_report_story.ts`
    - main にあって本番に無いファイル: `unit_sanitizer.ts`
    - `handler.ts` と `index.ts` は一致
  - 原因は、本番の後に main に入った F2（旧 G2）の市況レポートの変更7件がまだ deploy されていないこと
    - b507a3c5 配信優先
    - d56b1a9b H2 B1〜B4
    - cb3d77d5 残り
    - 2c876b0b / 319a442e C2 P2 / R1
    - bd424616 / 68d45dde Fact V2
  - **main から deploy すると、Opus の変更と一緒にこの7件も本番に出る**
- Cron（UTC の設定を JST に直したもの。すべて有効）

| レポート | データ | 生成 | 再試行 |
|---|---|---|---|
| 朝刊（平日） | 07:50 | 07:55 | 08:05 |
| 大引け（平日） | 16:15 | 16:20 | 16:35 |

- **配信のゲート**（`market_report_consumer_settings`）
  - `x_enabled=false`、`app_enabled=false`（2026-09-17 19:47 JST から変わっていない）
  - 今の X とアプリは、共有レポートではなく旧来の経路で作っている
  - **したがって、Opus で共有レポートを作っても、それだけでは利用者に届かない**
  - ON にすると、X・アプリは共有レポートだけを読む。無いときは止まる（fail closed）。ON にするのは別の判断
- 予算台帳
  - 試験用のポリシー2つが有効（`*.monthly` は $5・40回、`*.daily` は $2・6回、どちらも1回 $1）
  - 範囲は anthropic / claude-opus-5-5 / kabumori / market_report / system。**logical role は絞っていない（`*`）** ので、primary の役割名も対象になる
  - 予約は確定済みの1件だけ（Phase 1g の smoke）。詰まったままのもの（reserved / sent）は 0
- 本番の plan の wall clock（150 秒か 400 秒か）: この作業では分からない。Dashboard の Billing で確かめる。V0 は 150 秒を前提にしている（130 秒で打ち切り）

### 4. blockers（GO にするのに必要なもの）

1. ~~Edge Secret `ANTHROPIC_API_KEY` が無い~~ → **2026-10-13 15:26 JST 解消**: 利用者が登録し、F6 が名前だけで確かめた（33件、`ANTHROPIC_API_KEY` は名前が完全一致、`ANTHROPIC_CUSTOM_HEADERS` は無い。値・digest は見ていない）。キーが有効か（期限、Admin キーでないこと）は、最初の本番の呼び出しで初めて分かる。`KABUMORI_MARKET_REPORT_PRIMARY_MODEL` とモードはまだ無い（OFF のまま）
2. **F2 のテスト変更**が PR に入っていない（F2 のちゃ）
3. **deploy の範囲**: main から deploy すると、F2 の未 deploy の7件も一緒に出る。まとめて出すか、F2 / L2 が判断する
   - 別案は「本番の v30 ＋ Opus の変更だけ」の branch を作ることだが、新しい検証が要るので勧めない
4. merge の承認（#170 → #173 → #175 → F2 のテスト PR）
- このほか、利用者に届けるには配信のゲートを ON にする判断が要る。これは Opus とは別で、X が fail closed になる影響がある

### 5. 本番の手順（承認されてから。すべて利用者または承認されたスロットが行う）

```text
0) 点検（読み取り）: supabase secrets list --project-ref wsmznyzcvmuitkglfeuj
   → 名前だけを確かめる（値は出ない）
1) merge: #170 → #173 → #175 → F2 のテスト PR の順。毎回の直前に git merge-tree、merge 後に
   git fetch && git rev-parse origin/main で SHA を読み直し、main でテスト一式を流す
2) Secret（利用者）: ANTHROPIC_API_KEY と KABUMORI_MARKET_REPORT_PRIMARY_MODEL=claude-opus-5-5 の2行だけを書いた
   env ファイルを使い（シェルの履歴に値を残さない）、
   supabase secrets set --project-ref wsmznyzcvmuitkglfeuj --env-file <そのファイル>
   その後 secrets list で名前を確かめ、env ファイルを消す（全関数の version が上がるが、コードは変わらない）
3) deploy: 読み直した SHA のきれいな checkout（supabase/config.toml がある場所）から
   supabase functions deploy market-report-analysis --project-ref wsmznyzcvmuitkglfeuj
   → supabase functions download で取り直し、main とファイルごとに一致することを確かめる
     （_shared/ai_provider の新しいファイルを含む）
4) OFF のまま、次の自然なサイクルを観察する（OpenAI で完了、台帳の行が増えない）。F2 の7件の効き方もここで見る
5) ON: 朝刊からなら 07:45 まで、大引けからなら 16:10 までに
   supabase secrets set --project-ref wsmznyzcvmuitkglfeuj KABUMORI_MARKET_REPORT_AI_MODE=primary_both
6) 最初の呼び出しを観察（読み取り）: サイクルの結果、report の diagnostics（ai_primary / primary_calls / cost_usd /
   primary_last_error）、台帳の確定額、Edge のログの market_report_primary の行
7) 戻す: supabase secrets unset --project-ref wsmznyzcvmuitkglfeuj KABUMORI_MARKET_REPORT_AI_MODE
   → 次の呼び出しから OpenAI に戻る。台帳の stop は、レポートを失敗させるので戻す手段に使わない
8) 止める条件: キー・本文がログに出た（キーも作り直す）、1回 $0.60 超、1日 $1.50 超、GUARD_UNAVAILABLE、
   同じレポートの本番と再試行の両方が失敗
```

### 6. 予算の提案（別の本番変更。明示の承認が要る。自動では変えない）

- 今の月 $5・40回だと、`primary_both`（普通の日 4 回・約 $0.80）は **6〜7 営業日で止まる**（止まり方は安全側で、レポートが失敗するだけ）
- 続けるなら、月 $25・120 回、1日 $3・8 回、1回 $1
  - 1か月の最大の支出は $25 で止まる
  - 1日の上限は、各レポートに再試行の回を1つ残せる分

### 7. 判断

- **今日 16:20 の大引け: NO_GO**（キーが無い、merge と deploy の範囲が決まっていない）
- 最短の候補は **明日 07:55 の朝刊**。blocker の 1〜4 が今夜までに片付き、手順 1〜5 を承認のうえで行う場合
- 利用者に届けるには、さらに配信のゲートの判断が要る
- 分からないこと: Opus の応答時間、本番の plan の wall clock、本物の Anthropic が strict なスキーマを受け付けるか（有料の呼び出しで初めて分かる。今回は行っていない）
- next owner
  - L6（共通AI基盤のちゃ）: この判断
  - F2 のちゃ: テスト変更と、deploy の範囲（7件）
  - 利用者: キーの登録、予算の提案、配信のゲート
- merge 0、deploy 0、Secret・Cron・DB の変更 0、paid_calls 0
  - 本番は、上に書いた読み取りだけ: secret の名前、関数の一覧と本番のソースの取得、配信のゲートと Cron の行、台帳のポリシーと予約の件数
