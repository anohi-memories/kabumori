# Claude Task 3

- task_id: x-universal-oauth-refresh-stage3a-merge-edge-observe-20260926
- owner: claude
- slot: claude-3
- status: done
- next_owner: none
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: reviewed Stage 3A sourceをmainへmergeし、Stage 3A対応版 x-test-post をproduction Edgeへdeployしたうえで、AI Labの自然な期限切れ1サイクルを観測して本番動作を確認する。

## Authorization

User approved proceeding on 2026-09-26 JST.

This task authorizes ONLY:
1. PR #38 reviewed/fixed head のfresh-main整合確認
2. PR #38 merge
3. merged mainから x-test-post のみ production Edge deploy
4. deploy後のread-only verification
5. AI Labの**自然な**次回token-expiry/refresh cycleを1回だけ観測
6. 安全上必要な場合のgate OFF / safe stop

Not authorized:
- second account pilot
- Stage 3B / 3C / 4 activation
- rollout row変更
- bulk Vault migration
- manual token refresh
- manual X test post
- replay of historical failed posts
- migration apply/reapply
- migration repair
- db push / include-all
- Kabumori credential migration
- unrelated DB/Auth/Admin/Cron/important-news changes

## Reviewed state

- PR #38 fixed head: `748deb13a934129e5696ab5552401f547204b32c`
- C1: PASS-WITH-FIX
- Stage 3A migration is already applied in production and read-back PASS
- production rollout rows at last K3: AI Lab only = enabled
- no other pilot/enabled rows
- migration history debt remains intentionally unnormalized
- live Edge is still pre-Stage3A TypeScript and must be updated only after merge
- current global refresh gate is expected ON from prior AI Lab recovery, but must be freshly verified

## Mandatory startup

1. Read:
   - `.agent/ORCHESTRATION.md`
   - `.agent/CURRENT_STATE.md`
   - this TASK
   - latest G3 Stage 3A production-apply report
   - latest H1/C1 Stage 3A report
2. Use independent G3 worktree/checkout.
3. Fresh fetch `origin/main`.
4. Read current Supabase skill.
5. Fetch current Supabase changelog/docs relevant to Edge Functions deploy/secrets/runtime.
6. Check installed Supabase CLI version and discover deploy commands with `--help`.
7. Do not touch G4/Admin Auth work.

## Stage 0 — pre-merge and production preflight

Before merge, confirm:

### A. PR identity
- PR #38 is OPEN
- exact head = `748deb13a934129e5696ab5552401f547204b32c`
- no semantic changes after C1
- mergeable against fresh main
- any required CI/source checks are green or explainable
- source diff remains within Stage 3A scope

Any semantic drift => STOP.

### B. Production DB authority
Read-only confirm:
- Stage 3A rollout table/functions exist
- AI Lab is the only enabled rollout row
- no pilot row
- no unexpected second enabled account
- current AI Lab refresh state is healthy or at least in a known non-terminal state
- no refreshing lease is unexpectedly stuck
- Kabumori remains legacy non-Vault path
- no credential-ref sharing

Unexpected delta => STOP.

### C. Migration safety
Confirm:
- Stage 3A migration file is already live in production
- remote migration history remains known-debt/unrecorded
- this task will NOT run migration apply/repair/db push
- merge/deploy procedure cannot implicitly apply migrations

If deployment tooling would auto-apply migrations, STOP.

## Stage 1 — merge PR #38

Merge exact reviewed/fixed head only.

After merge:
- record merge commit
- fresh fetch `origin/main`
- prove Stage 3A semantic files match reviewed head
- no unexpected unrelated conflict resolution
- rerun focused source tests required to ensure merge did not alter semantics

Minimum:
- x-test-post focused tests
- _shared relevant tests
- Stage 3A static/migration contract tests
- git diff/status clean in G3 worktree

If merge introduces semantic drift => STOP before Edge deploy.

## Stage 2 — production Edge deploy

Deploy **x-test-post only** from the verified merged main source.

Requirements:
- no migration apply
- no env change unless a rollback safety action is required
- no other Edge Function deploy
- preserve verify_jwt behavior exactly as currently intended
- use the reviewed source corresponding to merged main
- after deploy, download/read-back or equivalent source identity proof must show exact deployed Stage 3A source
- confirm Stage 3A rollout refusal/proactive-start handling from fixed head is present
- confirm Kabumori legacy path is unchanged

Record:
- prior Edge version
- new Edge version
- source identity / hash evidence
- verify_jwt setting

Any mismatch => rollback if safe and STOP.

## Stage 3 — immediate post-deploy read-only checks

Confirm:
- global refresh gate current state
- AI Lab rollout = enabled
- all other rollout rows remain off/absent
- AI Lab account health remains healthy
- no token refresh occurred merely from deployment
- no X post occurred merely from deployment
- no cross-account mutation
- no rollout row mutation

If deploy itself causes unexpected refresh/post/mutation => STOP.

## Stage 4 — one natural AI Lab expiry-cycle observation

Observe exactly one naturally scheduled AI Lab post that requires or encounters token refresh after token expiry.

Do NOT:
- manually invoke x-test-post
- create a manual X post
- shorten expiry
- alter rollout mode
- force token invalidation
- replay old rows

Required evidence:
- intended AI Lab scheduled post is claimed once
- exact AI Lab account is selected
- at most one refresh request
- at most one retry of the intended X create after 401, if reactive path occurs
- refresh generation advances exactly once if a refresh occurs
- access expiry/last_refreshed_at update consistently
- rotated credentials commit only to the same AI Lab account
- final scheduled post succeeds
- no duplicate X post
- no second 401
- no uncertain result
- no reauth_required
- no stuck lease
- no cross-account credential/state change
- Kabumori remains unchanged

If the next natural due post occurs while token is still valid:
- record a normal success but continue waiting only until the first **practical** natural expiry-cycle candidate within this session/window.
- do not manufacture a refresh.
- if no natural expiry-cycle can be observed safely within the available working window, STOP with `OBSERVATION_PENDING`; do not treat as failure.

## Hard stop / rollback conditions

Hard stop on:
- PR/source drift
- merge conflict requiring semantic judgment
- unexpected rollout row
- unexpected account becomes eligible
- Edge source mismatch
- verify_jwt drift
- invalid_grant / reauth
- token endpoint uncertainty/network ambiguity
- second 401
- duplicate provider request
- lease mismatch/stuck refresh
- credential commit mismatch
- cross-account mutation
- Kabumori path change
- unexpected migration execution
- secret/token exposure

On Edge-deploy regression before a token rotation/uncertain event:
- rollback to prior known-good x-test-post source if safe
- leave DB authority layer intact
- report exact non-secret evidence

Do not blindly retry an uncertain refresh.

## Production mutation allowed

Allowed expected mutations:
- GitHub merge of PR #38
- x-test-post Edge deployment
- one natural AI Lab refresh/credential rotation/state update if triggered by its scheduled post
- one normal AI Lab scheduled X post from existing scheduler

No other production mutation is authorized.

## Completion / K3

Report:
- task_id
- source head + merge commit
- merge verification
- focused tests
- Edge prior/new version
- deployed source identity
- verify_jwt state
- gate state
- rollout rows before/after
- natural observation timestamp/post identity using non-secret identifiers
- whether refresh happened
- refresh generation before/after
- X retry count
- scheduled post result
- cross-account/Kabumori checks
- production mutations
- hard-stop conditions encountered
- remaining risks
- whether Stage 3A is fully live and ready to plan Stage 3B second-account pilot

Then:
- status -> review_required
- next_owner -> chatgpt
- STOP for K3.

## Report

- task_id: x-universal-oauth-refresh-stage3a-merge-edge-observe-20260926
- result: K3 ready — PR #38 merged, Stage 3A x-test-post deployed (v125, byte-identical to merge), one natural AI Lab expiry-cycle observed and PASS. No hard stop.
- model: Opus 5.5
- user_approval_in_chat: 2026-09-26 23:06 JST「進める」（事前確認報告後）
- source: PR #38 head `748deb13a934129e5696ab5552401f547204b32c` → merge `6717b1fe451db83f80e837bf8104268a2b00423d`（`gh pr merge 38 --merge --match-head-commit 748deb1…`, parents `80a96cd` + `748deb1`）
- merge_verification: main の他変更は important-news-monitor のみ（PR と非重複）。merge 後 `supabase/functions/x-test-post`・`_shared`・`migrations`・`tests` は `748deb1` と完全一致。preview と merge 後でテスト再実行: x-test-post 514/0（focused: vault_account_auth / 3A static / core static / 1I static = 43/0）、_shared 141/0。worktree clean（未追跡は deploy 用 link/config のみ、未コミット）。
- stage0_production (read-only 23:05 JST): Stage 3A 5関数 md5 = apply 時の read-back と一致; rollout rows = `ai_salaryman_lab_x=enabled/GRANDFATHERED_PROVEN_REFRESH` のみ（pilot なし）; AI Lab idle gen 6、error なし、stuck なし; Kabumori は Vault 参照なし; shared refs 0; 履歴 core/3A とも未記録（既知）; gate `X_VAULT_ACCOUNT_REFRESH` 設定あり; Edge v124（=777997a）。`functions deploy` は migration を適用しない（本 TASK で migration/repair/push 0）。
- edge_deploy: x-test-post のみ、`supabase functions deploy x-test-post --use-api --no-verify-jwt`（G3 worktree、独自 config.toml/link で shared checkout 誤デプロイを防止）、23:09 JST。prior v124 → new **v125**。download して merge `6717b1f` と43ファイル byte 一致、`ROLLOUT_REFUSALS`/proactive 処理あり。verify_jwt=false 維持。Kabumori 経路（`index.ts`、`_shared/brand/**`）は `777997a` から無変更（今回の差分は `vault_account_auth.ts`＋テストのみ）。
- post_deploy_checks (23:09 JST): gate ON、rollout rows 不変、AI Lab health 正常（gen 6、secret 更新 21:17 のまま）、deploy による refresh/投稿/状態変化 0、他アカウント・Kabumori store 不変。
- natural_observation:
  - 対象: 2026-09-27 07:49 JST の AI Lab 定期投稿 `scheduled_posts.id a9550772-c083-43a3-8515-c73aaa029a6a`（attempt 1）。直前のトークン期限 09-26 23:17 JST（期限切れ状態で到来）。
  - 07:50:01 claim → 07:50:05 refresh commit → 07:50:06 succeeded（"AI Lab post completed; fingerprint persisted"）。claim 1回、ログ1組。
  - refresh: あり、1回。generation 6 → 7、`last_refreshed_at` 07:50:05、`access_expires_at` 09:50:05（+2h）、AI Lab の access/refresh secret updated_at が同時刻 07:50:05（同一アカウントのみ）。
  - X create: 保存済み期限が過ぎていたため新コードの proactive 経路（投稿前更新）の想定。DB 上は create 回数を直接観測できないが、401 記録（`last_connection_error_code`）なし・second 401 なし・成功1件・重複投稿行なし。コード上の上限は create 2回（reactive の場合）。
  - 終了時: idle、error なし、uncertain/reauth/stuck なし、rollout 不変（updated_at 09-26 22:53 のまま）。
- cross_account_kabumori: `sa_bfdab0e0…` secret/行 不変; Kabumori 行不変・Vault 参照なし・`oauth_token_store` updated_at 09-26 18:23 のまま。06:49 Kabumori morning_greeting 失敗は `MORNING_GREETING_IMAGE_NOT_FOUND`（当日画像欠落、X 呼び出し前、前日と同じ別件）。
- production_mutations: (1) PR #38 merge (2) x-test-post v125 deploy (3) 定期スケジュールによる AI Lab の自然な refresh 1回（gen 6→7、AI Lab の2 secret 更新）(4) その AI Lab 定期投稿1件。migration/repair/push/env/rollout 変更・手動 invoke・手動投稿・再実行 0。
- hard_stops_encountered: none
- remaining_risks: migration history 未正規化（`db push` 禁止継続）; X create 回数は DB から直接は見えない（必要なら Edge ログで確認）; Kabumori morning_greeting の画像欠落（別件）; Stage 3B 用の2つ目アカウントには x-test-post 側の投稿処理がまだない。
- stage3a_fully_live: yes — DB 権限層 + Edge（v125）とも本番稼働、AI Lab で proactive 自動更新を実観測。Stage 3B（2つ目アカウント pilot）の計画に進める状態。
- next_recommendation: ChatGPT K3 → Stage 3B 計画 TASK（対象アカウント選定・同意・コンテンツ経路・pilot 期限/回数・観測/ロールバック手順）。別途 migration history 単一 version 正規化の承認判断。


## Final K3 — Stage 3A fully live

Verdict: **PASS**.

- PR #38 merged at `6717b1fe451db83f80e837bf8104268a2b00423d`.
- production `x-test-post` deployed to v125 from merged main; deployed source verified byte-identical and verify_jwt=false preserved.
- Stage 3A rollout rows unchanged: AI Lab only enabled; no pilot/second enabled account.
- natural AI Lab scheduled post at 2026-09-27 07:49 JST exercised the expiry path.
- proactive refresh succeeded exactly once: generation 6 -> 7, state returned idle, no error/reauth/uncertain/stuck condition.
- scheduled post succeeded with no duplicate observed; no second 401.
- cross-account state/credential check PASS; Kabumori legacy path/store unchanged.
- migration/repair/push/env/rollout/manual invoke/manual post mutations = 0 in this continuation.
- Stage 3A is now fully live across DB authority + Edge runtime + one real natural refresh cycle.
- ready to plan Stage 3B controlled second-account pilot.
