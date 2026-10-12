# G4 CURRENT TASK — POSTONA Threads実接続に向けたモバイルOAuth配線＋T10接続アダプター実装（G5待ちせず）

- task_id: postona-g4-threads-mobile-oauth-and-cleanup-wiring-v1-20261012
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- start_code: G4
- finish_code: K4
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Opus5.5（高）**
- priority: high
- type: **実装中心 — アプリ・Edgeの正規OAuth入口/コールバック配線 + Threadsプロバイダ専用T10 cleanup adapter（G5-owned integrationを触らず）。コードと実動導線を作る。調査・設計・模擬テストのみで終わらせない。**
- user_goal: **本人のPOSTONAからThreadsを接続→1件テキスト投稿できる状態を一日でも早く作る。G5 Phase4の完了を待たずG4が自分の所有範囲を先に実装。**
- owner_scope: G4-specific mobile connect/reconnect/callback, new Threads-connect Edge glue and provider-specific non-X cleanup adapter/contract, strictly G4-owned source only
- approved_writes: **独立G4 source branch + draft PR + mock/test fixture + G4 TASK/Report and ONLY G4 ACTIVE_TASK block/CURRENT_STATE relevant entry**
- forbidden_writes: **G5 account-delete / lifecycle / entitlement / Auth implementation, H5 PR139 original SQL/runtime files, PR124/135/140/144 original branches/files if owned by another worktree, G3 schedule/X code, production DB/Auth/Edge/Vault/Meta settings, feature flag enable, PR merge, deploy, EAS, paid API, actual Threads or X posting, any real provider call/secret retrieval**
- current_real_release_gate: **HOLD**; all 4 Threads connect/publish mobile/server static gates false, Edge runtime default 503, no public network write or managed auth experiment from this task
- previous_K4: PR144 `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6` one P2 session-row lock fix accepted PASS_SOURCE_FIX / REAL_PILOT_HOLD
- G5_interface_status: PR152 `5ad5bb40cadf013f00553acd5509f4f74fdbff7c` SOURCE CANDIDATE, `review_required`/K5 pending at assignment, **not production-applied and NOT final G5 contract**. Never assume it merged.

## Report — postona-g4-threads-mobile-oauth-and-cleanup-wiring-v1-20261012（G4 → K4、2026-10-12 JST）

- task_id: postona-g4-threads-mobile-oauth-and-cleanup-wiring-v1-20261012
- result: **SOURCE_COMPLETE_GATES_OFF / REAL_PILOT_HOLD**。A・B・C を実際に動くソースとして実装（設計メモではない）。ユーザーが触れる入口はすべてゲート OFF、本番・Meta・Supabase・X の呼び出し 0。
  - **A. アプリの接続／再接続フロー（本物の処理）**: `apps/social-mobile/src/features/threads-connect/threads-connect-starter.ts`（`createThreadsConnectStarter`）、`threads-connect-runtime.ts`（本番の依存: `supabase.functions.invoke('threads-oauth-connect-user')`・`WebBrowser.openAuthSessionAsync`（iOS 非共有セッション）・`dismissAuthSession`・`Linking.addEventListener('url')`・`expo.extra.threadsConnectCallbackUrl`）、`use-threads-connect.ts`、`threads-connect-card.tsx`、`domain/threads-connect.ts`。流れ: `useAuth` のトークンで start → 公式の認可 URL だけを検証して開く（サーバー判定と一致をテストで固定）→ ブラウザ結果／アプリリンクの最初の戻りを1回だけ → その時点でも同じ人・期限内 → 戻り URL を読まずにそのまま**その時点の**トークンで callback → 受領票 → 共有データを再読み込みし、その Threads アカウントが接続済みと読めてから「接続しました」。二重タップ（IN_PROGRESS）・キャンセル・Threads での拒否・期限切れ・アカウント切替／ログアウト・不正な戻り・開始拒否／不正 URL（ブラウザを開かない）・結果不明（再試行しない）を固定文言で。ゲート `THREADS_CONNECT_UI_ENABLED=false` のため画面のボタンは無効のまま。戻り先 URL は未設定なので有効にしても `CALLBACK_NOT_CONFIGURED` で止まる（Meta 登録＋検証済みアプリリンクが必要な運用作業）。
  - **B. 接続の受け渡し口（未接続）**: `supabase/functions/_shared/social/threads_connect_edge.ts`（`createThreadsConnectHandler(runtime|null, {registeredCallback})`）。H5 `createThreadsRuntime` の `start`／`callback` の出力を厳密に検証し（キー完全一致・公式 URL・`publishEnabled:false`・期限の範囲）、固定コード（START_REFUSED／CALLBACK_REFUSED／EXCHANGE_OUTCOME_UNCERTAIN／COMPLETE_OUTCOME_UNKNOWN／CALLBACK_INVALID／THREADS_CONNECT_RUNTIME_UNAVAILABLE ほか）だけを返す。呼び出し元トークンはそのまま H5 へ（JWT を解読せず user id を受け取らない）。登録外の戻りは H5 に渡さない。`THREADS_CONNECT_EDGE_WIRED=false`、H5 の入口は今も 503 で、組み込みは H5 側。service_role の代理や偽の所有者資格情報は作っていない。
  - **C. 退会時の Threads 後片付け（未登録）**: `supabase/functions/_shared/social/threads_provider_cleanup.ts`（G5 #152 `ProviderCleanupAdapter` と構造一致、組み合わせ検証で型チェック済み）＋ `supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql`（未適用・所有者のみ実行）。G5 の `private.account_lifecycle_operations` でその人の削除（account_deletion、または x_autopost の service_deletion）が `in_progress`／`cleanup` のときだけ、決定的な POSTONA ワークスペースのロック → Threads 行 FOR UPDATE → 1トランザクションで Vault のトークン・Threads 行（→ 許可・試行・nonce・custody は cascade）を削除し読み戻し。進行中かもしれない投稿（creating_container／publishing／publish_returned／uncertain）や共有トークンは消さずに `reconciliation_required`。Threads は呼ばず、成功は `local_removed_remote_unverified`（`confirmed_remote_revoked` は返さない）。結果不明は `reconciliation_required`、再試行なし。G5 のファイルは無変更・未登録。
- changed_files: 19（Draft [PR #154](https://github.com/anohi-memories/kabumori/pull/154)）
  - アプリ: `apps/social-mobile/src/domain/threads-connect.ts`、`src/features/threads-connect/{threads-connect-card.tsx,threads-connect-starter.ts,threads-connect-runtime.ts,use-threads-connect.ts}`、`src/app/accounts/{index,[id]}.tsx`（カードに accounts／reload を渡すだけ）、`tests/threads-connect.test.mjs`
  - サーバー: `supabase/functions/_shared/social/{threads_connect_edge,threads_connect_edge_test,threads_provider_cleanup,threads_provider_cleanup_test}.ts`
  - DB 候補と検証: `supabase/candidates/postona_threads_cleanup/threads_provider_cleanup_candidate.sql`、`supabase/tests/postona_threads_cleanup_{fixture,behavior}.sql`、`postona_threads_cleanup_run.sh`
  - 組み合わせ検証: `supabase/candidates/postona_threads_integration/connect_cleanup_smoke.ts`、`supabase/tests/postona_threads_connect_smoke_run.sh`
  - 文書: `docs/postona/threads-mobile-connect-and-cleanup-v1.md`
  - 無変更: PR #144／#140 のファイル、H5 #139 の原本、G5 の `account-delete/provider_cleanup.ts`・`lifecycle_logic.ts`・Auth、G3、X。
- tests:
  - RUN/PASS アプリ `node --test tests/threads-connect.test.mjs` **18**（開始・アプリリンク経由と二重の戻り・キャンセル／拒否／期限切れ・別アカウント／ログアウト・期限後と不正な戻り・二重タップ・未設定／ログアウト・開始拒否と不正 URL でブラウザを開かない・結果不明・console 出力 0 と結果にコード／state／トークンなし・サーバーとの URL 判定一致・ゲート OFF で開始しない・再読み込みで確認できてから接続済み・失敗文言）、`tests/threads-manual-publish.test.mjs` **18**（回帰）、`npx tsc --noEmit` PASS、`npx expo lint` 問題なし
  - RUN/PASS Deno `deno test --no-config --allow-env --allow-read supabase/functions/_shared/social/ supabase/functions/social-mobile-threads-publish/` **105**（新規: 受け渡し口 8・後片付け 4）、`deno lint --no-config`（新規5ファイル）問題なし
  - RUN/PASS `THREADS_PGHOST=/private/tmp/g4cw-sock THREADS_PGPORT=54944 THREADS_PGSUPER=g4super bash supabase/tests/postona_threads_cleanup_run.sh` → ALL PASS（前提不足2種で停止、ACL、接続の有無、削除中でない／後片付け段階でない／kabumori の終了では何もしない、進行中の投稿3状態、1人分だけ消える・X と他人は無傷・Vault 削除・2回目は ALREADY_REMOVED、共有トークン、POSTONA だけの終了、**変異4種検出**: 権限確認なし・進行中確認の縮小・共有確認なし・任意の service_deletion を許す）
  - RUN/PASS `bash supabase/tests/postona_threads_connect_smoke_run.sh` → ALL PASS（#124 `c30f2464…`／#135 `e38788d6…`／#139 `b4fa672f…`／#152 `5ad5bb40…` の正確な版を読み取り専用でコピー、重なりなし。受け渡し口 × H5 実コードで start→公式 URL→他所の戻りは H5 にもMetaにも届かない→callback→受領票 publish_enabled false。アダプター × G5 の実際の `runProviderCleanups`: 削除完了→proceed（threads は remote unverified）、進行中・応答なし・読めない→reconciliation_required、未接続→not_connected）
  - NOT_RUN（理由つき）: 既存の大きな回帰（統合 176・アプリ全 258・G5 80+）は無変更部分のため TASK の指示どおり回していない。本物の Meta、H5 の owner transport、管理された Supabase（Vault 削除権限・行ロック権限）、アプリリンクの実機確認、シミュレーター（ゲート OFF で画面は「準備中」）。
  - `git diff --check` PASS、秘密情報の文字列検査 0、ゲート5つ（接続／投稿のサーバー・アプリ・受け渡し口）すべて false、変更パスはすべて G4 所有。
- commit_hash: `98287392327eabfd5092a3ba89dde51a2e8beff6`（`git rev-parse HEAD` の出力）
- push: DONE（新ブランチ `claude/g4-postona-threads-connect-wiring-20261012`、force なし）
- PR: [#154](https://github.com/anohi-memories/kabumori/pull/154) OPEN/DRAFT、HEAD `98287392327eabfd5092a3ba89dde51a2e8beff6`、**base = #144 のブランチ `claude/g4-postona-threads-integration-20261011`（head `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6`、無変更）**。保護対象の head（push 直前に再確認）: #140 `2e75a6a842e70f3de78558681803b60935fb4251`、#139 `b4fa672f97592e87682671454e868a92098cbd56`、#135 `e38788d6677082138f0990453c7d2f00549666d0`、#124 `c30f246409a77080cbc03aef6c4cb72b5481e125`、#121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`、#152 `5ad5bb40cadf013f00553acd5509f4f74fdbff7c`。
- merge / deploy: NOT_DONE（マージ・適用・GRANT・Edge デプロイ・secret・フラグ・EAS・投稿・Meta 設定すべて無し）
- remaining_issues / 引き継ぎ表:
  - (a) **G4: 済（ソース）** — アプリの接続フロー、受け渡し口、Threads の後片付けアダプターと DB 候補、テスト。
  - (b) **G5** — #152 の K5 と1回の独立レビュー（Sol（高））の後、G5 のファイルでこのアダプターを登録し、削除処理のロールに `threads_provider_connection_state(uuid)`・`cleanup_threads_provider_footprint(uuid)` の EXECUTE を付与。T13・T10 の最終配線。Vault の削除権限は既存の X の削除と同じ前提（管理環境で要確認）。
  - (c) **H5** — 本物の owner transport（専用の所有者ロール、セッション行ロックの `FOR SHARE` 化、custody の1文）、`threads-oauth-connect-user` の入口に `createThreadsConnectHandler` を組み込む、コールバックの受け渡しの配線。
  - (d) **運用・ユーザー** — Meta 開発者アプリ、HTTPS コールバックと検証済みアプリリンク（`expo.extra.threadsConnectCallbackUrl`）、Threads テスター、`threads_basic`／`threads_content_publish`、秘密はチャット・リポジトリ外、各デプロイの承認。
  - ゲート OFF の今、ユーザーができないこと: アプリからの Threads 接続と投稿（ボタンは「準備中」で押せない）。サーバーの入口も 503。
- safety_checks: 新しい専用 worktree `/Users/yuya/Developer/kabumori-g4-threads-connect`（`kabumori-fresh` から #144 の正確な head で作成、前の G4 worktree はそのまま）。他スロットのブランチ・作業フォルダ・TASK／Report・G5 の port／registration・H5 の原本は無変更。組み合わせは /private/tmp の使い捨てコピー（終了時に削除）。使い捨て PostgreSQL は自分専用の socket `/private/tmp/g4cw-sock`。本番への読み書き 0。ACTIVE_TASK は G4 欄の status／next_owner だけを変更。
- next_recommendation: K4 で受け入れ判断。次は G5（#152 の K5 → レビュー → 登録）、H5（owner transport と入口への組み込み）、運用（Meta とアプリリンク）を並行。揃った時点で統合レビュー（Sol（高））→ 承認されたテスター1名で「接続→許可→1件投稿」のパイロット。
- AI Lab diary 候補（公開しても安全な粒度）: 「SNS 連携の『ログインして戻ってくる』流れで、戻りが二重に来たり途中でアカウントが変わったりしても安全に止まるよう、ブラウザとアプリの両方の戻り方をまとめて扱う形にした。退会時に連携データを片付ける処理も、投稿の途中かもしれないものは消さずに人が確認する設計にした。」

## Boundaries and protected baselines

At 2026-10-12 assignment, exact protected open Draft heads:
- POSTONA PR144 (G4 integrated connect/publish) `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6`, stacked on PR140 `2e75a6a842e70f3de78558681803b60935fb4251`. PR140 source is G4's publisher and must be preserved.
- G4 Threads OAuth SQL candidate PR124 `c30f246409a77080cbc03aef6c4cb72b5481e125` → Codex H1 PR135 `e38788d6677082138f0990453c7d2f00549666d0` → H5 authenticated runtime candidate PR139 `b4fa672f97592e87682671454e868a92098cbd56` (protected; no changes to original H5 files).
- G5 shared account T13 PR121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`, Phase4 G5 PR152 `5ad5bb40cadf013f00553acd5509f4f74fdbff7c`, both G5-owned and open Draft. G5 K5 in separate chat. G5 provider cleanup port `supabase/functions/account-delete/provider_cleanup.ts` contains `ProviderCleanupAdapter` with `provider/hasConnection/cleanup`; **PR152 registers ZERO concrete provider adapters**, so G4 must implement provider-side code without changing G5 port/registration.
- G3 X/AI scheduling and app `schedule.tsx` owned by G3; POSTONA app owns distinct `apps/social-mobile/src/features/threads-connect/**` and `src/domain/threads-connect.ts` already includes a disabled starter and `threadsCallbackForward`; connect screen `accounts/index.tsx` and `accounts/[id].tsx` already display disabled Threads card. The app already has `expo-web-browser`, `expo-linking`, `@supabase/supabase-js` dependencies and `useAuth` / `@/lib/supabase` pattern in Threads manual publisher. Build on it; don't add unnecessary packages.
- PR144 G4 manual publisher `social-mobile-threads-publish` server/HTTP, account token expiry custody candidate and release SQL are G4-owned but already K4 accepted source-only; **do not reopen broad changes**. Production setup and GoTrue/owner-role proof belong later.

## Start preflight (must be real)

1. Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this G4 TASK + prior K4 Report, G5 latest TASK/Report/PR152, H5 C5 source/Report, PR144/140/139/135/124/121. Fresh-fetch `origin/main`, exact current PR heads, real `git status`, `git worktree list`, current file ownership, any uncommitted cross-slot changes. STOP if refs or G5 interface unexpectedly changed; first reconcile and report. Ensure independent clean G4 worktree and unique dev/SQL ports; no shared worktree/dev server restarts or reset/rebase.
2. Prefer **NEW independent G4-only branch from protected PR144 exact HEAD**, new **Draft stacked PR with BASE the PR144 branch**, leaving the original PR144 / #140 / #139 / #152 heads entirely unchanged. This avoids editing previously accepted source PR; submit only the G4-owned new source delta. Existing G4 worktree may be attached to PR144: create a separate G4 integration worktree/check-out safely; do not reset, checkout, stage or modify the prior one. If any PR/base/worktree conflict, STOP rather than force push.
3. For cross-PR imports (H5 runtime only exists in protected unmerged PR139, G5 port only in PR152), **do not silently copy/duplicate secured OAuth source** into your production branch and do not add dangling runtime imports that break main or enable live code. Own a narrow typed adapter/port in G4 source that composes with the current exact H5/G5 interface and validates it in a disposable G4-only combined checkout; when not linked, production must fail closed. Record exact missing owner import/migration/role prerequisite for later integration.

## Required implementation (do not return a memo-only TASK)

### A. Real app-facing Threads connect/reconnect client and HTTPS callback handoff

- Turn existing `disabledThreadsConnectStarter` interface into a **real, injectably testable `ThreadsConnectStarter` implementation** under G4's `apps/social-mobile/src/features/threads-connect/**` + `domain/threads-connect.ts` / accounts screens. Follow existing `useXConnect`, `useThreadsManualPublish` patterns and Expo `expo-web-browser`/Linking. Keep actual user-facing button gated OFF by `THREADS_CONNECT_UI_ENABLED=false`, **but source must contain fully working authenticated request/response and browser/callback handling, not just another disabled placeholder**.
- From POSTONA's own authenticated `useAuth` access token, request H5 `threads-oauth-connect-user` server `start` (exact API envelope from its runtime contract), validate server authorization URL/allowed Meta origin, bind return to that exact current signed-in user/session and selected Threads account for reconnect (not an arbitrary client-supplied subject), launch official Meta OAuth browser safely; handle cancel, timeout, duplicate taps, account switch, app background/resume, expired session, browser redirect, and callback exactly once. Validate registered HTTPS callback origin/path and strict URL query via `threadsCallbackForward`; **never parse/store/log/send raw Meta code/state except forwarding the exact received callback URL only to the server with the person's current verified bearer**. Avoid arbitrary URL open/redirect.
- Only after server-side success + verified read-back of the account (via normal RLS snapshot refresh) may UI say “接続済み”; never trust browser URL or mock response alone; `publishEnabled` stays false until the user separately grants it. Clearly show connection in progress / canceled / expired / failed / completed. Existing X connect and G3 scheduler unaffected. If HTTPS app link association or registered callback is not configured, fail closed with a precise disabled/unavailable state; do not switch gate ON in this PR.

### B. G4-owned Connect→H5 runtime server composition contract (source only)

- Implement the smallest **non-deployed G4-owned Edge integration helper / source adapter** that defines/verifies request and response shapes for `start` and authenticated `callback`, enforces same principal/session and narrow allowed redirect, and can compose with H5 PR139 owner transport in a separate disposable integrated source checkout. Keep feature disabled and no real network credentials. H5 source still missing a real dedicated owner SQL connection factory and managed row-lock proof; do not invent a `service_role` proxy or fake owner credentials. If H5 server entry remains statically 503, clearly mark live backend BLOCKED while client/contract code can be complete. Do not change original H5 PR139 or any G5 Auth files.
- Ensure rejection/missing-transport/malformed URL/provider OAuth error response are safe fixed codes; tests must prove no token, code, state, userId, SQL credentials, Meta app secret or attestation key leaked in app logs/errors. Browser-only success ≠ connected.

### C. G4-only concrete Threads T10 provider cleanup adapter for G5 Phase4 port

- Implement a real **Threads-specific adapter implementation**, structurally compatible with G5 Draft PR152 `ProviderCleanupAdapter`: `provider: 'threads'`, `hasConnection(userId)`, `cleanup(userId)`. Put in NEW provider-owned G4 source/module path; **do NOT edit `supabase/functions/account-delete/provider_cleanup.ts` or `lifecycle_logic.ts` (G5 owner)**. Use an injected narrowly-privileged DB/credential-removal port; no client-supplied userId as sole authority and no cross-user/brand/X token operations. Account deletion/freeze lease and G5 caller ownership must be verified by the eventual G5-owned registration. No provider-remote revocation claims without official confirmation.
- Cover local removal footprint: Threads social account and dedicated Vault token, new G4 `social_account_manual_publish_permissions`, `threads_manual_publish_attempts`, `threads_manual_publish_nonces`, `threads_account_credential_custody`; avoid treating in-flight `publishing`/`creating_container` attempts as “not posted”. If provider call result unknown, outcome **reconciliation_required** and never auto-retry/repost. If no safe SQL authority route is available, implement the precise source-only transaction/SQL adapter candidate that fails closed and clearly report the narrow G5 integration/privilege condition rather than fabricating a functioning privileged DELETE. Deliver runnable local fake/disposable PG tests for actual owned cleanup logic, not documentation only.
- Return exactly allowed G5 outcomes `confirmed_remote_revoked | local_removed_remote_unverified | reconciliation_required | blocked`; do not report confirmed revoked if Threads does not provide verifiable revocation. G5's PR152 policy for `acceptRemoteUnverified` and frozen deletion is respected. **Do not register adapter inside G5's files** until separate owner/G5 review and authorization.

### D. Fast focused smoke and implementation handoff (avoid token-burning test loops)

- Only focused NEW app tests for start/cancel/callback/foreign user/account change/invalid URL, Edge request shape, double callback, secret no-log, T10 footprint/reconciliation and protected negative controls; re-run changed-file TypeScript/check and corresponding focused Deno/PG. Existing broad G4 176, app 258 and G5 80+ suites are already on record: **do not mechanically rerun all unmodified suites**. Skip unavailable local PG honestly; record RUN/PASS/FAIL/NOT_RUN and reasons. Check `git diff --check`, import/flags false, secret scan, changed paths ownership.
- Draft stacked PR must contain tangible **source code**: authenticated Expo login web flow, callback handoff, G4 server contract and concrete Threads cleanup adapter; not just more typed stubs or mock tests. Keep accepted PR144/139 source immutable. If integration cannot source-compile due to separated ancestor branches, use independently reproducible disposable composite smoke and report precise owner dependency. Do not claim real Meta flow passed when all static gates still OFF.
- Concise required handoff matrix: (a) G4 completed actual app server glue + account cleanup adapter source; (b) G5 Phase4 K5 and one independent Sol（高） high-risk review needed before G5 owner-side adapter registration/T13/T10 final wiring; (c) H5 owner runtime dedicated role/session lock/custody completion and callback Edge must be wired with verified source; (d) operator Meta developer app, HTTPS callback verified association, Threads tester, scopes `threads_basic`/`threads_content_publish`, secrets outside chat/repo, deployment approvals. Avoid another design-only G4 cycle; be honest about which exact user-touchable actions remain impossible with false gate.
- Completion: new Draft PR + exact commit/head/base, changed_files/tests and safety/remaining_issues documented in a NEW top `## Report` in THIS G4 task (preserve full previous task/report history literally); after remote PR and read-back, update only G4 TASK + G4 ACTIVE block to `review_required/next_owner:chatgpt`; return to **POSTONA｜マルチSNS化・開発統括（G4）のちゃ** via **K4**. No real system actions, merge, deploy, migration apply or public Threads post.

---

## Preserved previous G4 TASKs / K4 acceptance and Reports (historical, read-only)

# G4 CURRENT TASK — POSTONA PR144 C3-R1 session-expiry race narrow fix（SOURCE ONLY）

- task_id: postona-threads-pr144-c3-r1-session-expiry-lock-fix-g4-20261012
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- start_code: G4
- finish_code: K4
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Opus5.5（高）**
- priority: high
- type: **ONE narrow Auth/SQL session-row-lock bug correction + deterministic concurrent regression**; no broader feature implementation
- task_origin: C3 accepted independent Codex H3 `postona-threads-pr144-auth-publish-p1-security-review-h3-20261012` as CHANGES_REQUIRED, one P2 R1; H3 closed and Report preserved
- target_PR: [#144](https://github.com/anohi-memories/kabumori/pull/144)
- target_exact_HEAD: `d4a1e87b77d1fbd362dc51809ce2d998afda15ea`
- parent_PR140_exact_HEAD: `2e75a6a842e70f3de78558681803b60935fb4251`
- scope_own: `supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql`, H3 finding-specific PostgreSQL test fixture/runner in `supabase/tests/postona_threads_release_*`, optional small G4 integration note and locally modified mock only if essential
- prohibited: G5 `account_lifecycle_assert_active_service_write`/T10/Auth, H5 PR139 `claim_candidate.sql`/owner transport, G3 schedules, old X OAuth and x-test-post, H3/H4 TASK/Reports/PRs, any other slot source/worktree, production Supabase/Auth/PostgREST/Vault/Meta/X calls, real providers, secrets, migration apply, PR merge, deploy, feature-flag activation, EAS, paid AI, actual posting
- release_gate: **REAL_PILOT_HOLD**; all connect/publish/mobile gates remain FALSE, disabled Edge response remains 503

## Report — postona-threads-pr144-c3-r1-session-expiry-lock-fix-g4-20261012（G4 → K4、2026-10-12 JST）

- task_id: postona-threads-pr144-c3-r1-session-expiry-lock-fix-g4-20261012
- result: **R1_FIXED_SOURCE_ONLY / REAL_PILOT_HOLD**。C3 R1（P2）を1か所で修正し、両方の順序の2接続競合テストで修正前の失敗・修正後の成功を確認した。本番・Meta・Supabase・X の呼び出し 0、全ゲート false のまま。
  - 修正: `supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql` の release 内の検証済みセッションの確認だけを `for key share` → **`for share`** に変更（＋理由のコメント、冒頭説明の1語）。`FOR SHARE` はセッション行のどの UPDATE とも衝突するため、`not_after` の期限切れ・失効 UPDATE は release の確定まで待たされ、進行中の UPDATE が先なら release はそれを待ってから確定後の行で再判定して `AUTH_REQUIRED`（READ COMMITTED の再評価）。ロック順（T13 → セッション → ワークスペース／メンバー／アカウント／期限／同意 → nonce → 試行 → Vault）、ACL、SECURITY DEFINER、関数の署名は不変（事後条件 PASS）。行ロックに UPDATE 権限が要るのは `FOR KEY SHARE` と同じで、本番の所有者がロックできるかは引き続き管理環境での確認事項（権限付与なし）。
  - 主張しないこと: 時間経過だけによる期限切れ（UPDATE なし）が確認から確定までの数ミリ秒（最大 lock_timeout 3秒）の間に起きた場合、および release 確定後〜Threads への HTTP 要求の間の変更は止まらない（DB ロックはネットワークをまたがない。次の書き込みは新しい release で止まる）。
  - H5 申し送り（変更なし）: #139 `claim_candidate.sql` の `postona_threads_runtime.assert_actor` も `auth.sessions` を `FOR KEY SHARE`。本物の owner transport 統合時に H5（＋G5 のセッション失効契約）で (1) `FOR SHARE` 化、(2) GoTrue の実際の失効 SQL（UPDATE／DELETE・列）と所有者の行ロック権限の管理環境での確認、を決めてほしい（設計書 §4 に記載）。
  - G5 申し送り（ガードは弱めない）: POSTONA 削除開始後は既存の削除ガードが試行の更新を拒否するため、release 後の結果記録は `ACCOUNT_LIFECYCLE_BLOCKED` となり、試行は `publishing`／`creating_container` のまま残る（削除を取り下げれば同じ許可証で記録可）。G5 の削除・T10 はこの試行を「投稿されたかもしれない」として読み取り照合または監査の対象にすること、自動再投稿なし（設計書 §5、テストで境界を固定）。
- changed_files: 4（PR #144 への追加コミット 1件、PR のファイル一覧は 24 のまま）
  - `supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql`（+6/−2）
  - `supabase/tests/postona_threads_release_run.sh`（2接続のセッション競合 `session_race` と変異 `release_session_key_share_only` を追加）
  - `supabase/tests/postona_threads_release_behavior.sql`（期限切れ後の古いセッション JWT の拒否・新しいログインとの区別、削除中の遅い結果記録の境界）
  - `docs/postona/threads-connect-publish-integration-v1.md`（§3 修正の説明、§4 H5 申し送り、§5 G5 申し送り、§7 検証）
  - 無変更: `threads_credential_custody_candidate.sql`、#140 の候補・検証、#124／#135／#139／#121、G3、`x-test-post`、TS／アプリのソース（フラグ含む）。
- tests:
  - RUN/PASS `THREADS_PGHOST=/private/tmp/g4r1-sock THREADS_PGPORT=54943 THREADS_PGSUPER=g4super bash supabase/tests/postona_threads_release_run.sh` → ALL PASS。
    - 2接続のセッション競合（DB のロック待ちを `pg_locks`／`pg_stat_activity` で観測して順序づけ。テスト専用の advisory lock の関門で release をセッション確認の後に止める）: **ケース1（release が先）** 期限切れ UPDATE（lock_timeout 1秒）は `lock timeout` で確定できない → release は `released` → その後に UPDATE が確定 → 次の release は `AUTH_REQUIRED`・トークンなし。**ケース2（期限切れ UPDATE が先に進行中）** release はロック待ちになり、UPDATE の確定後に `AUTH_REQUIRED`・トークンなし。
    - **修正前の失敗**: 変異 `release_session_key_share_only`（`for share` → `for key share` に戻す）でケース1が「SESSION_CASE1 expiry committed while the release held the session」で失敗 → 検出。修正後は両ケース PASS。ケース2を修正前のコードで単独実行するのは NOT_RUN（ケース1で修正前の失敗を確認済み。`FOR KEY SHARE` は `FOR NO KEY UPDATE` と衝突しないため待たずに旧版の行を読むことは PostgreSQL の仕様上の理由）。
    - 既存の安全回帰も同じ実行で PASS: 利用権終了（P0001／42501）・削除開始・ロック・降格・メンバー削除・同意取消・サインアウト・セッション期限切れ・トークン期限・custody・再接続・本人用ワークスペース、証明の偽造／期限切れ／nonce 再利用、記録の束縛、同時の publish release で1件のみ。変異 **9種すべて検出**（フェンス削除・セッション確認削除・証明無効化・nonce 無効化・比較更新削除・記録のセッション束縛削除・service_role 付与・KEY SHARE への後退・custody の再接続束縛削除）。
  - RUN/PASS `bash supabase/tests/postona_threads_integration_run.sh`（同じ環境変数）→ ALL PASS（#124／#135／#139 の正確な版の読み取り専用コピー、SQL 通し、TS 通し、回帰 176 PASS）
  - RUN/PASS `deno test --no-config --allow-env --allow-read supabase/functions/social-mobile-threads-publish/ supabase/functions/_shared/social/` → 93 PASS（TS は無変更）
  - NOT_RUN: アプリのテスト（アプリのソース無変更）、`postona_threads_publish_run.sh`（#140 の候補は無変更）、管理された Supabase Auth／GoTrue の実際の失効 API／PostgREST／Vault、本物の G5 T13、Meta、実機、本番。
  - `git diff --check` PASS、秘密情報の文字列検査 0、ゲート 4つ false（TS 無変更）、他担当・保護パスの混入 0。
- commit_hash: `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6`（`git rev-parse HEAD` の出力）
- push: DONE（`claude/g4-postona-threads-integration-20261011` に早送りで追加。push 直前にリモートの先頭が `d4a1e87b77d1fbd362dc51809ce2d998afda15ea` のままであることを確認。force なし）
- PR: [#144](https://github.com/anohi-memories/kabumori/pull/144) OPEN/DRAFT、HEAD `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6`（2コミット）、base `claude/g4-postona-threads-manual-publish-20261011`（#140 `2e75a6a842e70f3de78558681803b60935fb4251`、無変更）。保護対象の head（push 後に再確認）: #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`、#135 `e38788d6677082138f0990453c7d2f00549666d0`、#139 `b4fa672f97592e87682671454e868a92098cbd56`、#121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`。
- merge / deploy: NOT_DONE（マージ・適用・GRANT・Edge デプロイ・secret・フラグ・EAS・投稿すべて無し）
- remaining_issues: 本番前の関門は前回 Report のとおり（G5 の T13 本番化と T10、H5 の owner transport・custody の1文・コールバック受け渡し・セッションロックの申し送り、ユーザーの Meta 準備と鍵、統合セキュリティレビュー、テスター1名・1件の明示承認）。今回の修正で新たな関門は増えていない。
- safety_checks: PR #144 のブランチは G4 専用のきれいな作業フォルダ `/Users/yuya/Developer/kabumori-g4-threads-integration` にだけ割り当てられていることを `git worktree list` で確認してから1コミットを追加。他スロットのブランチ・作業フォルダ・TASK／Report は変更なし。使い捨て PostgreSQL は自分専用の socket `/private/tmp/g4r1-sock` のクラスタのみ。本番への読み書き 0。ACTIVE_TASK は G4 欄の status／next_owner だけを変更。
- next_recommendation: K4 で差分（SQL の1語＋コメント）と競合テストを確認のうえ受け入れ判断。修正が狭いため、機械的な広いレビューの追加は不要と考える。次は前回どおり G5／H5 の小さな TASK とユーザーの Meta 準備を並行し、揃った時点で統合レビュー → 承認されたテスター1名・1件のパイロット。
- AI Lab diary: 記録不要寄り（内部のロック強度の修正。公開するなら「並行して起きる処理の順番を、実際に2つの接続でぶつけて確かめるテストを作った」程度）。

## K4 FINAL — ChatGPT 2026-10-12 JST / PR144 R1 narrow patch PASS_SOURCE_FIX

- task_id: postona-threads-pr144-c3-r1-session-expiry-lock-fix-g4-20261012
- verdict: **PASS_SOURCE_FIX / C3_R1_REMEdIED_OFFLINE / REAL_PILOT_HOLD**; G4's work accepted, G4 task `done`/`next_owner: none`. This is **not** a real Auth/Meta/Vault/GoTrue/production security release.
- Actual GitHub [Draft PR144](https://github.com/anohi-memories/kabumori/pull/144) HEAD verified `09fd2c49114b7d26c23b71a3084574dc6a5a7ad6`, 2 commits, OPEN/DRAFT/UNMERGED, base protected PR140 HEAD `2e75a6a842e70f3de78558681803b60935fb4251`, branch `claude/g4-postona-threads-integration-20261011`. Exact compare prior reviewed `d4a1e87b77d1fbd362dc51809ce2d998afda15ea` to new HEAD: **1 commit, 4 changed paths only** (G4 SQL `threads_publish_release_candidate.sql`, SQL behavior fixture `postona_threads_release_behavior.sql`, two-connection runner `postona_threads_release_run.sh`, G4 docs `threads-connect-publish-integration-v1.md`). No H5/G5/G3/other slot product files modified.
- Independently inspected source diff: release `auth.sessions` row lock `FOR KEY SHARE` → `FOR SHARE`, preserving G5 T13/session/brand/member/attempt/Vault lock order and function signature. New local race runner has ordered two-connection session expiry/release tests for both orderings, a fail-before key-share mutation, old-session JWT regression and delete-started late-result reconciliation behavior. Matches H3's reproduced C3 P2 R1 source cause; no need for a mechanical repeat comprehensive H review for this bounded fix.
- G4 Report states local PG17 session race case1/case2 PASS, key-share mutation fails-before as expected, safety mutation9/9 caught, integrated disposable SQL/T13 mocks and Deno176 PASS, focused Deno93 PASS, diff/secret/static flags PASS. **ChatGPT has NOT independently executed** actual PostgreSQL/Deno/Expo tests; app tests, protected PR140 test suite, real managed GoTrue/PostgREST/Auth/Vault/Meta/native pilot **NOT_RUN in this patch task**. Source branch code, PR, delta and report inspected; claimed Mac worktree clean, not independently inspected.
- Remaining true gates: protected H5 PR139 `claim_candidate.sql` KEY SHARE session lock still needs owner-side revocation contract; trusted owner Auth/SQL transport + custody one-statement complete + callback; G5 real T13, multi-provider T10 deletion/frozen in-flight publication audit; real project/managed Auth/PostgREST/Vault credential+EXECUTE privilege proof, Meta Threads developer app/basic/publish scopes/tester, HTTPS callback, secret keys, one exact user-approved tester account and text. An UPDATE-free natural expiry near release commit and short release→provider HTTP gap remain inherent and documented; **never claim zero race**. All server/app connect/manual gates FALSE and 503, no merge/DB apply/GRANT/Edge deploy/public post.
- Other PR original heads and their owners protected. H3 C3 completed/done/free. G5 common account Phase4 currently `ready` and must not be edited by G4. G4 slot free after acceptance; next work requires independent explicit TASK. AI Lab diary: not necessary (internal lock/race-only correction); if public summary, exclude auth source details/secrets and any live-launch claim.
- reviewer_recommendation_for_later_lifecycle_owner_proof: **Sol（高）** focused actual managed boundary; do not repeat full source review until material Auth/T13/owner transport changes exist.
- production_calls/deploy/merge/post: **NONE** at K4.

---

## Exact C3 review finding and accepted correction scope

H3 C3 reviewed exact Draft PR144 HEAD `d4a1e87b77d1fbd362dc51809ce2d998afda15ea`, parent PR140 `2e75a6a842e70f3de78558681803b60935fb4251`. H3's report is `.agent/CODEX_REPORT_3.md` top `## H3 FINAL — POSTONA Threads PR144...`, result **CHANGES_REQUIRED / REAL_PILOT_HOLD**.

- **R1 P2 (reproducible):** `supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql:229-232` validates an `auth.sessions` row `not_after` and locks it `FOR KEY SHARE`. A different connection can `UPDATE auth.sessions SET not_after=now()-interval '1 second'` (non-key field) and COMMIT while the release is blocked later in the transaction; release then returns the Vault credential **after session has expired**. Two-connection synthetic local PG17 reproduction from H3 report. H3's LOCAL-only `FOR SHARE` control prevents that concurrent nonkey update until release commit. No actual GoTrue managed API reproduction; don't claim exploited production.
- **Bounded G4 correction:** strengthen the session-row lock to `FOR SHARE` **only at the verified session check**, preserve lock order G5 T13 → session → membership/account/custody/nonce/attempt → Vault and existing source SQL ACL/SECURITY DEFINER behavior. Confirm PostgreSQL `FOR SHARE` behavior for non-key UPDATE and whether read-only Meta POST outside transaction still creates finite revocation window; don't claim network call atomicity. If safe equivalent is required because of lock order or owner privileges, document and test narrowly, no broad grants or new authority route.
- **Mandatory fail-before/pass-after race test:** run two isolated local PG sessions with a reliable synchronization barrier. Case 1 release obtains session lock first; concurrent `UPDATE auth.sessions.not_after` with bounded timeout must wait/be blocked until release COMMIT; case 2 expiry update commits first and then release must fail/return AUTH_REQUIRED without Vault release. Verify session reactivation/old JWT replay is not silently accepted; exact errors and snapshot results recorded. Re-run H3's existing revoked-entitlement/member-removed/consent-revoked/nonce-replay/concurrent-publish regression and mutation cases to establish unchanged safety. Tests fake Auth/T13/Vault and isolated DB, no managed claims.
- **H5 coordination note ONLY:** H3 also found H5 protected PR139 `supabase/candidates/postona_threads_auth_runtime/claim_candidate.sql` uses KEY SHARE; do NOT edit H5 files or create H5 task. Record the exact later interface request for H5/G5 to resolve at genuine owner-transport integration. `threads_credential_custody_candidate.sql`, PR124/135/139 and PR121 must remain unchanged.
- **G5 deletion outcome note ONLY:** H3 found an inherited deletion guard can refuse a late Threads publication result `ACCOUNT_LIFECYCLE_BLOCKED`, despite a release and possible Meta write; record this as future G5/T10 reconciliation contract, no weakening of guard.

## Mandatory preflight / branch ownership

- Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this G4 TASK and protected prior Report below, H3 latest C3 Report, H5 C5 and G5 current status; fetch fresh `origin/main` and PR144 exact head/base/changed-file ownership.
- Use an **independent clean G4 checkout/worktree** from exact PR144 head, not another slot or dirty previous checkout. PR144 original G4 branch `claude/g4-postona-threads-integration-20261011` is exclusively G4-owned but may be attached to previous G4 worktree: coordinate safely. APPEND one narrowly scoped commit to that PR's G4 branch **only if** no other active worktree/dirty files, no rebase/reset/force push and pinned head remains unchanged before push. May instead create NEW narrowly stacked Draft PR from exact PR144 head if direct append would disturb existing worktree or ownership; never overwrite PR144 or #140/139/etc branches. In either case report exact branch/PR/base/HEAD and preserve prior G4 Report.
- Stop rather than edit if conflicting ownership, worktree, unrelated PR head drift or safe independent environment cannot be established. Do not change production state.

## Tests and completion

- Run local disposable PostgreSQL 17 negative two-session race with deterministic ordering, release preconditions, claim+publish safety regressions and mutation/fail-before/pass-after if possible. Run focused Deno check/lint/tests and G4 app tests only as relevant; report `RUN/PASS/FAIL/NOT_RUN` explicitly. Check static false gates unchanged, Vault/token logging negative, role EXECUTE/implicit grants unchanged, `git diff --check`, `git status`, PR exact delta and no cross-slot file paths.
- **Completion = one P2 R1 correction + evidence**, not G5/H5/Meta real pilot. Push scoped Draft correction if safe; after remote head/diff read-back append new `## Report` to the **TOP of this current G4 TASK** (preserving whole previous K4 and G4 history), update G4 TASK + its `.agent/ACTIVE_TASK.md` block `review_required/next_owner chatgpt`. Do not change G3/G5/H1-H5 or other chat slot TASK/Report. Return `K4` to POSTONA｜マルチSNS化・開発統括（G4）のちゃ.
- ChatGPT will inspect exact source diff and concurrent regression on K4. If the change is truly bounded, avoid another mechanical broad Codex review; any later integrated real Auth/Vault/T13/Meta release still requires focused proof/approval.
- recommended_model: **Opus5.5（高）**; completion_code K4; no H5 temporary implementation needed for this G4-owned one-lock fix.

---

## Protected prior G4 K4 task and reports (read-only, complete original text follows)

# G4 CURRENT TASK — POSTONA Threads 認証＋手動テキスト投稿 統合V1（オフライン・本番無効）

- task_id: postona-threads-connect-publish-integrated-offline-v1-g4-20261011
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- start_code: G4
- finish_code: K4
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Opus5.5（高）**
- priority: high
- type: normal implementation / cross-layer integration candidate + negative security behavior tests (**no production deployment**)
- goal: **本人のThreads接続→アカウント別明示許可→テキスト1件投稿→Threads結果read-backの一連の処理を統合候補として組み上げる。次の安全審査・限定テスター実投稿に必要な不足を最小化する**
- current_limit: OFFLINE_ONLY / SOURCE_ONLY / NO_REAL_THREADS_POST / NO_SUPABASE_PRODUCTION_WRITE
- source_authority: G4 owns only NEW integration glue and scoped G4 publish-candidate corrections, NOT H5 OAuth or G5 Auth/entitlement/identity/deletion implementation
- production_mutation: **FORBIDDEN** (including Supabase Auth/DB/RPC/GRANT/RLS/migration apply, Vault, Edge deploy, Meta app config, live tokens, Cron, push, EAS, PR merge, public posting)
- external_auth_apis: **FORBIDDEN** without new explicit user-approved separate pilot TASK
- merge_deploy: **FORBIDDEN**; only Draft source PR and local fake test database allowed
- G4_previous_TASK: `postona-threads-manual-text-publish-v1-20261011` K4 PASS_SOURCE_CANDIDATE; old history/Report preserved below

## Report — postona-threads-connect-publish-integrated-offline-v1-g4-20261011（G4 → K4、2026-10-12 JST）

- task_id: postona-threads-connect-publish-integrated-offline-v1-g4-20261011
- result: **GO_SOURCE_ONLY / BLOCKED_REAL_PILOT**。I1〜I5 をすべてコードとテストで実装。接続→許可→予約→投稿→読み戻しの一連が、保護対象の正確な版（#124 / #135 / #139）を読み取り専用でコピーした使い捨て環境で、実際の SQL 候補どうし・H5 の実コードどうしで通った。実際の Threads 投稿は不可（全ゲート false）。本番・Meta・Supabase・X の呼び出し 0。
  - **I2（P1、必須ゲート）: 修正済み（ソース）**。`supabase/candidates/postona_threads_publish/threads_publish_release_candidate.sql` が、#140 の `claim`／service_role の `redeem`／`record` を **DROP** し、`release_threads_manual_publish_step` に置換。Threads への各書き込みの直前に**1トランザクション**で「サーバー証明（HMAC-SHA256・Vault `postona_threads_publish_attestation_v1`・使い捨て nonce・60秒）→ G5 フェンス（T13、ロック保持）→ `auth.sessions`（KEY SHARE）→ ワークスペース／メンバー（owner/admin）／アカウント／トークン期限／手動同意（行ロック）→ 比較更新 → Vault 読み出し → 状態移動＋記録用許可証（本人＋セッションに束縛）」。`record_threads_manual_publish_result` は許可証＋同じ本人・同じセッション＋結果への証明、フェンスなし（途中終了でも事実は記録）。service_role・anon はどの関数も実行不可（事後条件で確認）。Edge は service_role キーを持たず JWT を解読しない。**閉じていない隙間（主張しない）**: release 確定から Threads への HTTP 要求までの数ミリ秒〜最大10秒。次の書き込みは新しい release で止まる。
  - **I3**: `threads_credential_custody_candidate.sql`（アカウント単位の期限。接続確定の同じトランザクション（`verified_at = now()`）でのみ記録、Vault secret id と記録時刻 ≥ `verified_at` に束縛。不明・期限切れ・5分以内は拒否）。**H5 への最小依頼**: owner transport の `complete` に `select public.record_threads_credential_custody($account, $expires_at)` を1文追加（PR #124 complete と H5 outcome の間）。T10: G4 の4表（許可・試行・nonce・custody）は cascade、G5 の T10 は Vault secret と行を一緒に削除すること（フェイク削除で孤児なしを確認）。
  - **統合で見つけて直した不具合 2件**: ①#124／X オンボーディングは個人ワークスペースを `is_active=false, publish_mode='disabled'`（自動投稿用）で作るため、#140 の条件では**全利用者の手動投稿が拒否**されていた → `code_profile_key='social_mobile_user_v1'`（本人用ワークスペース）を条件に変更。②G5 フェンス候補の SQLSTATE `42501` を #140 は読み分けず BLOCKED に丸めていた → 固定メッセージで読み分け。
  - **I1**: `supabase/functions/_shared/social/threads_connect_publish_integration.ts`（段階・担当・不足の一覧、`firstUnavailableStage`、H5 受領票の厳密パース＝権限ではない、H5 完了トランザクションの3文）。組み合わせ環境専用 `supabase/candidates/postona_threads_integration/integration_smoke.{sql,ts}`。現状の最初の不足段階は `actor`（AUTH_GET_CLAIMS 未配線）、owner transport 未提供なら `oauth_state` で `OWNER_TRANSPORT`。
  - **I4**: 接続／再接続の入口（`THREADS_CONNECT_UI_ENABLED=false`、無効ボタン、無効な starter）とコールバック受け渡しの設計関数（登録 HTTPS URL のみ、そのままサーバーへ、コード／state をアプリで扱わない）。G3 の予約画面・X・タブは無変更。
  - **I5**: `supabase/tests/postona_threads_integration_run.sh`（組み合わせ環境の構築＋SQL 通し＋TS 通し＋回帰）、`postona_threads_release_run.sh`。
- changed_files: 24（Draft [PR #144](https://github.com/anohi-memories/kabumori/pull/144)）
  - 新規: `supabase/candidates/postona_threads_publish/{threads_credential_custody_candidate,threads_publish_release_candidate}.sql`、`supabase/candidates/postona_threads_integration/integration_smoke.{sql,ts}`、`supabase/functions/_shared/social/threads_connect_publish_integration{,_test}.ts`、`supabase/tests/postona_threads_release_{fixture,behavior}.sql`、`supabase/tests/postona_threads_release_run.sh`、`supabase/tests/postona_threads_integration_run.sh`、`apps/social-mobile/src/domain/threads-connect.ts`、`apps/social-mobile/src/features/threads-connect/threads-connect-card.tsx`、`apps/social-mobile/tests/threads-connect.test.mjs`、`docs/postona/threads-connect-publish-integration-v1.md`
  - G4 所有の修正: `supabase/functions/_shared/social/threads_manual_publish{,_fake,_test}.ts`、`supabase/functions/social-mobile-threads-publish/{http,logic,http_test}.ts`、`apps/social-mobile/src/domain/threads-manual-publish.ts`（文言）、`apps/social-mobile/src/app/accounts/{index,[id]}.tsx`（カード追加のみ）、`docs/postona/threads-manual-publish-v1.md`（置換の注記のみ）
  - 無変更: `threads_manual_publish_candidate.sql`（#140 の DB 候補とその検証）、#124／#135／#139／#121 のファイル、G3、`x-test-post`、G5。
- tests（すべて RUN・ローカル・偽データ）:
  - `THREADS_PGHOST=/private/tmp/g4ti-sock THREADS_PGPORT=54942 THREADS_PGSUPER=g4super bash supabase/tests/postona_threads_release_run.sh` → ALL PASS（前提不足4種停止、P1 の14ケース＝利用権終了 P0001/42501・削除開始・ロック・降格・メンバー削除・同意取消・サインアウト・セッション期限・トークン期限間近・custody なし・custody 更新なし再接続・接続失敗・本人用でないワークスペース、証明の偽造／期限切れ／nonce 再利用、記録の束縛（別セッション・別ユーザー・別の鍵）、途中終了後の記録、custody 制約、T10 フェイク削除、TS と同じ HMAC 既知解、同時 publish release で1件のみ、**変異8種すべて検出**）
  - `bash supabase/tests/postona_threads_integration_run.sh`（同じ環境変数）→ ALL PASS（重なりなし、#124 自身の behavior、SQL 通し、TS 通し、組み合わせ環境の Deno 回帰 **176 PASS**）
  - `bash supabase/tests/postona_threads_publish_run.sh` → ALL PASS（#140 の既存検証、回帰）
  - `deno test --no-config --allow-env --allow-read supabase/functions/social-mobile-threads-publish/ supabase/functions/_shared/social/` → **93 PASS**、`deno lint --no-config`（18ファイル）問題なし、`deno check` エラー 0
  - アプリ: `npm test` **258 PASS**（新規 threads-connect 6 を含む）、`npx tsc --noEmit` PASS、`npx expo lint` 問題なし
  - `git diff --check` PASS、秘密情報の文字列検査 0、他担当・保護パスの混入 0、4つのゲートすべて false を確認
  - NOT_RUN: 管理された Supabase Auth／PostgREST／Vault、本物の G5 T13（代役は #124 の MOCK_ONLY と G4 の契約代役）、Meta、実機、本番
- commit_hash: `d4a1e87b77d1fbd362dc51809ce2d998afda15ea`（`git rev-parse HEAD` の出力）
- push: DONE（branch `claude/g4-postona-threads-integration-20261011`）
- PR: [#144](https://github.com/anohi-memories/kabumori/pull/144) OPEN/DRAFT、**base = #140 のブランチ `claude/g4-postona-threads-manual-publish-20261011`（head `2e75a6a842e70f3de78558681803b60935fb4251`、無変更）**、HEAD `d4a1e87b77d1fbd362dc51809ce2d998afda15ea`。保護対象の head（push 直前に再確認）: #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`、#135 `e38788d6677082138f0990453c7d2f00549666d0`、#139 `b4fa672f97592e87682671454e868a92098cbd56`、#121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44`、すべて OPEN・無変更。CI の Vercel は「Deployment rate limited — retry in 24 hours」（コード起因ではない）。
- merge / deploy: NOT_DONE（マージ・Edge デプロイ・DB 適用・GRANT・secret・フラグ変更・EAS・投稿すべて無し）
- remaining_issues / 次の作業（担当別）:
  - **G5**: T13 フェンスの本番化（#121 系）。T10 の provider 別後始末に G4 の4表と Vault secret を入れる。
  - **H5**: owner transport の本番接続口（未提供のため `oauth_state` 段階で停止）、`complete` に custody の1文、Meta コールバック→アプリリンク→サーバーの受け渡しの実装。
  - **G4**: なし（ソース）。レビュー指摘の反映のみ。
  - **ユーザー（Meta／鍵）**: Threads ユースケースのアプリ、`threads_basic`＋`threads_content_publish`、テスター招待と承認、HTTPS コールバック、連携解除・データ削除コールバック、接続用・投稿用の証明鍵（Vault と Edge に同じ値。チャット・GitHub に貼らない）。
  - **H1〜H4（Sol（高））**: 接続（H5）＋投稿（G4）＋T13（G5）を合わせた1回の独立セキュリティレビュー。本番の DB 適用・GRANT・Edge デプロイ・フラグ・テスト投稿の前に必須。今の段階で個別レビューが必要な具体的 P1 は残っていない（P1 は修正済み・変異で検証済み）。
  - 前回 Report（PR #140）の commit_hash の訂正: 前回 `2e75a6a874b2a5f31e8ec7bac3c80de92e9ac78f` と書いたのは**誤り**（短縮値から補って書いた）。正しくは `2e75a6a842e70f3de78558681803b60935fb4251`（K4 記載どおり）。前回の本文は保存のため変更していない。
- safety_checks: 新しい専用 worktree `/Users/yuya/Developer/kabumori-g4-threads-integration`（`kabumori-fresh` から #140 の正確な head で作成）。#124／#135／#139／#121／#140 のブランチは checkout・rebase・変更・push なし（組み合わせは /private/tmp の使い捨てコピー、重なりチェックつき、終了時に削除）。使い捨て PostgreSQL は自分専用の socket `/private/tmp/g4ti-sock` のクラスタのみ。G6 の本番作業窓とは無関係（本番への読み書き 0）。ACTIVE_TASK は G4 欄の status／next_owner だけを変更。
- next_recommendation: K4 で GO_SOURCE_ONLY として受け入れ判断。次は G5（T13 本番化・T10）と H5（owner transport・custody の1文・コールバック受け渡し）の小さな TASK、ユーザーの Meta 準備を並行し、揃った時点で Sol（高）の統合レビュー → 承認されたテスター1名・1件のパイロット、の順を推奨。
- AI Lab diary 候補（公開しても安全な粒度）: 「SNS の接続と投稿を別々に作ってきた部品を、本物どうしで初めてつないで通しで動かしたところ、単体のテストでは見えなかった不具合が2つ見つかった。権限の確認と鍵の受け渡しを1回の処理にまとめる形にも直した。」

## K4 FINAL — 2026-10-12 JST / Threads integration candidate source-only

- task_id: postona-threads-connect-publish-integrated-offline-v1-g4-20261011
- verdict: **PASS_SOURCE_CANDIDATE / GO_SOURCE_ONLY / BLOCKED_REAL_PILOT / INDEPENDENT_REVIEW_REQUIRED**.
- exact [Draft PR144](https://github.com/anohi-memories/kabumori/pull/144) **`d4a1e87b77d1fbd362dc51809ce2d998afda15ea`**, OPEN/DRAFT/UNMERGED, 1 commit/24 G4-scoped paths, base protected [Draft PR140](https://github.com/anohi-memories/kabumori/pull/140) branch head `2e75a6a842e70f3de78558681803b60935fb4251` unchanged. Protected Draft #124 `c30f246409a77080cbc03aef6c4cb72b5481e125`, #135 `e38788d6677082138f0990453c7d2f00549666d0`, #139 `b4fa672f97592e87682671454e868a92098cbd56`, #121 `76b50e1e03f82faaa3460bab1603afa8fef3ce44` unchanged at K4. No cross-slot changed-file overlap with H5 PR139 / parent G4 PR140 delta (PR144 modifies only its own stacked G4 paths).
- accepted **candidate source and mock integration**, not production security assurance: G4-owned release-authorization replacement `threads_publish_release_candidate.sql`, account token custody candidate, H5/PR124 integration test pack, connect/reconnect disabled UI contract, precise dependency runbook. Integration tests use exact protected read-only source candidate copies in disposable environment, G5 T13 mock/contract and provider/Auth fakes. **Source gate still OFF**: server `THREADS_MANUAL_PUBLISH_PREREQUISITES_MET=false`, original connect `THREADS_CONNECT_PREREQUISITES_MET=false`, mobile manual publish / connect flags false, Edge 503. No real Meta/managed Supabase/GoTrue/Vault/POSTONA deployment.
- G4 Report self-tests (NOT rerun by ChatGPT): local PostgreSQL 17 standalone negative/release + fixture integration scripts PASS, local combined Deno176 PASS, focused Deno93 PASS, app258 PASS, lint/check/diff/secret scan PASS. ChatGPT inspected source candidate and tests, SQL privilege/session/custody components, PR metadata and claimed command/result matrix. Mac worktree, true managed PostgREST/Auth/Vault, real API and tester NOT verified. Vercel rate-limited is not interpreted as successful CI.
- The previously identified **P1 old service-role voucher gap** is addressed **as a source proposal**: old claim/redeem/record functions DROP, new caller JWT-scoped release requires server HMAC attestation, fresh T13 G5 fence/session, membership/account/custody/consent check, one-shot nonce/transactional Vault read. Do not assert end-to-end security proof until independent H4 review and real owner/auth authority design. SQL transaction cannot protect already-released provider HTTP request against later revocation; a bounded race remains and must be explicitly assessed/accepted or further mitigated. Record factual post outcomes even after permission revocation.
- Cross-system release blockers: #121 G5 T13 real managed service fence and provider-aware T10 cleanup of four new G4 tables; H5 production owner SQL connection and role/session privileges, one-source additional account-scoped custody write in verified OAuth completion; real mobile HTTPS callback, Meta Threads app/basic/publish scopes/tester, Vault key custody/attestation, targeted preflight + migration ordering/rollback and auth/race proof. User has NOT approved real test posting or production source/database changes. No public post, PR merge, deploy, secrets, grant, applied migration, EAS, charges or external provider calls in this K4.
- G4 slot **done / next_owner none**. Historic task and current G4 Report preserved unchanged below; no G5/H5/G3/etc TASK edits. Independent focused **H4 Sol（高）** source-level review of real high-risk SQL/RPC/HMAC/GoTrue/G5/H5 boundary assigned separately (H4 no implementation). Return C4 here. Any H4 findings requiring edits => new explicit narrow G4 TASK, not review loops for UI. H5 remains free and reserved only for user-authorized temporary implementation.
- AI Lab diary: public-safe summary possible about mock end-to-end, security-focused integration and two caught defects, avoiding any launch/secret claims.

---

## Why this is the next stage

2026-10-11 user explicitly requested proceeding after K4 toward posting from POSTONA to their own Threads account. Implement **the integration code and proof now**, not another memo alone. Previous source-only components:
- [Draft PR124](https://github.com/anohi-memories/kabumori/pull/124) — G4 earlier workspace/Threads begin-consume-complete SQL/RPC contract; exact protected head `c30f246409a77080cbc03aef6c4cb72b5481e125`, branch `claude/g4-postona-threads-workspace-oauth-20261010`.
- [Draft PR135](https://github.com/anohi-memories/kabumori/pull/135) — H1 fake OAuth Edge candidate, stacked on #124, exact protected head `e38788d6677082138f0990453c7d2f00549666d0`, branch `codex/h1-threads-edge-offline-20261011`.
- [Draft PR139](https://github.com/anohi-memories/kabumori/pull/139) — H5 signed actor/session + state/code durable burn + owner transport candidate, stacked on #135, exact protected head `b4fa672f97592e87682671454e868a92098cbd56`, branch `codex/h5-threads-runtime-20261011`. C5 accepted source candidate only; owner credential channel NOT provisioned, new Edge entry always 503.
- [Draft PR140](https://github.com/anohi-memories/kabumori/pull/140) — G4 Threads TEXT media container→publish→read-back + account card/manual permission/attempt SQL, exact protected head `2e75a6a842e70f3de78558681803b60935fb4251`, branch `claude/g4-postona-threads-manual-publish-20261011`, based on main. K4 accepted source-only; publishing Edge flag `THREADS_MANUAL_PUBLISH_PREREQUISITES_MET=false`, mobile `THREADS_MANUAL_PUBLISH_UI_ENABLED=false`.
- [Draft PR121](https://github.com/anohi-memories/kabumori/pull/121) — G5 T13/fence source candidate `76b50e1e03f82faaa3460bab1603afa8fef3ce44`, NOT production-applied. G5 owns `account_lifecycle_assert_active_service_write`, T10, common Auth deletion; this TASK cannot change those or use a fake G5 function as evidence of production readiness.
- G3 owns booking/scheduling UI Draft PR138, source unchanged; X OAuth security Issue #131 separately deferred. G1/G2/G6-G10/H1-H5 independent work/production mutation windows protected.

## Mandatory preflight / isolation (STOP rather than overwrite)

1. Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this task and K4 Report, H5 C5 Report, current G5/G3 task headers and exact PR source docs. Fetch **fresh `origin/main`** and re-read **current** PR #124/#135/#139/#140/#121 head/base/draft/changed-paths. If any protected SHA moved, first re-evaluate delta and ownership; do not blindly rebase/cherry-pick.
2. Create **brand-new independent G4 worktree/checkout**, NOT previous G4 checkout unless proven clean and explicitly safe. Do NOT enter/edit/check out/reset/rebase other G/H worktrees, their PR branches, their uncommitted edits or dev servers. Any collision/uncertain dirty worktree = STOP and report. Worktree paths under own G4 workspace only, separate test socket/PG cluster.
3. **PR strategy:** Prefer NEW independent `claude/g4-postona-threads-integration-20261011` branch starting from exact, protected #140 head; new **Draft stacked PR BASE #140 original branch** containing only THIS TASK's G4-owned changes. **Never modify original #140** or #139/#135/#124, even though #140 was G4-owned. For a full chain test, build a SEPARATE disposable G4-only integration checkout that combines read-only fetched exact candidates #124→#135→#139 with #140 via normal non-destructive Git merges or explicit bounded file copies; original branches remain immutable. Clearly record fetched SHAs and diff; ensure no accidental G5/H5 file edit. Do not push combined copies or imply merged main. If the test integration needs files from another owner's branch, use only local disposable checkout and keep pushed PR delta G4-only. If this cannot be made reproducible and conflict-free, stop and explain a precise branch/ownership BLOCKER.
4. Recheck `.agent/CURRENT_STATE.md` for active G6 production mutation window. Even if closed, **this TASK never applies production SQL or invokes external Meta/Auth.** No implicit permission from user saying “すすめて” to do a public Threads post.

## Implementation deliverables — code/tests required, no memo-only completion

**I1: Real source-level composition path (offline).**
- Provide a typed G4-owned integration adaptor/contract and an end-to-end test harness linking: verified app user/session through H5 `getClaims/getUser`+durable callback state/owner authority *contract* → PR124 verified Threads `social_account_id` and server-side token custody → G4 explicit per-account permission → attempt reservation/idempotency → G4 two-step Meta TEXT API → read-back confirmed post id/permalink. Integration must be proven with injected mocks and disposable DB source candidates, not fabricated `connected` or `published` UI booleans. Show one **golden path test** and precise unavailable stage when real owner transport is unprovisioned.
- Do not read/tamper with G5 users or create privileges. Don't import absent unmerged H5 paths into a deployable live entry without a source-complete flag/fail-closed build. H5's C5 receipt `publishEnabled:false` is NOT a posting capability; new G4 server MUST independently authorize exact account/user/session.

**I2: P1 permission/entitlement TOCTOU fix** — **mandatory acceptance gate**.
- K4 exposed a concrete security gap: G4 SQL `public.redeem_threads_manual_publish_step` currently redeems server `service_role` voucher up to 60s after caller-side `claim` but **does not itself recheck G5 T13 POSTONA entitlement or originating caller's owner/admin membership**. A membership/entitlement may be revoked in this interval. Implement a reviewed, effective **source-only** fix inside a NEW G4-owned SQL candidate (or an isolated addition to new G4-only integration source, not to protected PR140 source branch), ensuring DB lock order (G5 lifecycle→workspace/membership→account/attempt→Vault) and a server-authenticated principal, account, brand and grant cannot be forged by the client. Re-evaluate current lifecycle, role and manual consent immediately before **each** provider write, and analyze race between redemption and actual HTTP POST. If impossible without G5-owned RPC/privileges or H5 owner channel, **fail closed, explicitly BLOCK live**, provide smallest implementable G5/H5 interface request and regression tests; NO caller-selected userId, forged `auth.uid()`, JWT decode-as-proof, broad grants or `service_role` authority shortcut. Do not claim atomic DB locks span network calls. Never turn incomplete permission proof into `publishEnabled=true`.
- Tests at minimum: entitlement ends/locked/deleting after claim but before redeem, owner/admin demotion/removal, account switches brand, manual consent revoked, session expiry, revoked token, grant replay/late redemption, concurrent publishes, duplicate tap/HTTP lost response. Ensure provider write fake count **ZERO** after authorization failure, and no unauthorized Vault credential read.

**I3: Token custody / expiry interface.**
- PR140 depends on absent `public.threads_account_credential_expires_at(text) returns timestamptz` while H5 PR139 has per-attempt `token_expires_at`, not an account-scoped verified credential expiry. Provide a **concrete G4-owned proposal + testable adapter** for account-scoped expiry, bound to exact connected account/token rotation and Vault custody (not an arbitrary OAuth attempt row), with absent/expired/unknown = denied. If the actual persistence must be changed in H5/G5-owned schema/RPC, do **NOT edit their protected files**; specify exact interface/owner change and mark end-to-end pilot blocked. Never assume 60-day default or trust client timestamp. No real Vault/secrets access.
- G5 T10 disconnect/deletion must recognize `social_account_manual_publish_permissions` and `threads_manual_publish_attempts`. Document required G5 contract and test fake deletion while retaining no orphan credentials; do not edit G5-managed procedures.

**I4: Connection and posting UI bridge.**
- In the new stacked G4 candidate only, expose a **testable** “Threads 接続する / 再接続する” path on the account detail page and strict authorized app callback handoff design to H5; preserve G4's existing draft/manual confirmation UI and accurate unavailable/expired/consent state. Must NOT put Meta app secret, service-role key, OAuth state in diagnostic logs, credential, raw callback code, token, or fake connected result on mobile. Do not make a live Auth/Meta call. App link/universal link specifics require real Meta configuration and separate pilot; if cannot be verified offline, provide disabled explicit placeholder + clear implementation adapter rather than misleading functional button.
- Preserve G3's `schedule.tsx` and composer, X `x-test-post`, active account/provider routing, bottom tabs, any G5 App/Auth code; no new scheduled posting.

**I5: Reproducible integrated smoke pack + operator gates.**
- A new executable mock fixture/test runner (G4-owned paths), with dependency matrix for #124/#135/#139/#140, required G5 T13 real contract, Phase2a-2 schema, owner role privileges, Vault, Meta scopes `threads_basic/threads_content_publish`, tester, HTTPS callback, and T10. Explicit `RUN`/ `NOT_RUN` for real managed Auth/PostgREST/Vault/Meta/prod, and distinguish blocked requirements.
- Leave BOTH source gates `THREADS_CONNECT_PREREQUISITES_MET=false` and `THREADS_MANUAL_PUBLISH_PREREQUISITES_MET=false`, and mobile `THREADS_MANUAL_PUBLISH_UI_ENABLED=false`; new Edge entry must remain 503/unreachable. PR cannot contain true/“temporary debug ON” flips or production routes. Do not accidentally permit double posting on retry or call real Meta.
- Execute deno check/lint/focus/regressions, app TypeScript/unit/lint, disposable-local PG ACL/locks/concurrency if touched, static isolated imports, secret scan, `git diff --check`; report exact counts, commands and skipped tests. If unavailable, NOT_RUN with reason.

## Completion requirements and next owners

- Deliver **actual source and tests** in one new G4 Draft PR stacked on original protected #140 if non-overlapping and code can be kept fully disabled. If integration cannot safely compile/source-prove without unmerged G5/H5, record specific hard blocker and a small safe design patch, **not** a fake completed end-to-end.
- Include an exact next-steps matrix identifying **G5-owned** T13/T10/role prerequisites versus **G4-owned** manual publish, **H5-owned** actor/Vault and Meta operator setup. Decide **GO_SOURCE_ONLY / BLOCKED_REAL_PILOT** honestly. A narrowly scoped future G5 TASK is separately allocated by ChatGPT later; do not self-assign G5/H5 or commit to another slot.
- **Final integrated independent security review must be run separately by H1-H4**, recommended **Sol（高）**, BEFORE any production DB apply/GRANT/Edge deploy/feature flags/test public post. No self-merge/no changes to production. If a focused review is required earlier due to concrete P1 Auth/DB blockers, say so with exact file/test evidence; do not burn Codex review for UI-only edits.
- Update ONLY `.agent/tasks/CLAUDE_TASK_4.md` at top with new `## Report` (task_id, result, changed_files, tests, commit_hash, push, PR base+HEAD, merge/deploy, remaining_issues, safety_checks, next_recommendation) while preserving ALL previous task/Report text verbatim; set own TASK/index to `review_required/next_owner:chatgpt` after the actual PR push/read-back, then return **K4** to POSTONA G4 chat. Guard each write with fresh SHA; do not overwrite concurrent state changes. Do not leave task idle or claim unperformed deploy.
- AI Lab diary: may record safe mock-only milestone and lessons, no secrets, vulnerability procedure or fictitious Threads product launch.

---

## Preserved complete previous G4 TASK, K4 assessment and Report (READ-ONLY HISTORY; not current TASK)

# Claude G4 — CURRENT TASK — POSTONA Threads text publish + user-facing manual publish V1

- task_id: postona-threads-manual-text-publish-v1-20261011
- owner: claude
- slot: claude-4
- status: done
- next_owner: none
- start_code: G4
- finish_code: K4
- return_to: **POSTONA｜マルチSNS化・開発統括（G4）のちゃ**
- recommended_model: **Opus5.5（高）**
- priority: high
- type: **通常実装 — Threadsテキスト投稿の実API対応可能なprovider adapterと手動投稿UI / source + mock integration tests**
- main_product_goal: **POSTONAからユーザー自身の接続済みThreadsアカウントに1件のテキストを投稿し、投稿結果を確認できる状態（後段で限定実機pilot）**
- immediate_deliverable: implementation PR with real API request builders, explicit server-side publish-authorization boundary, testable two-step publish flow, safe one-shot user UI; **do not claim live functionality until separately authorized activation**
- remote_meta_supabase_x_api_calls: **FORBIDDEN until a separate user-approved tester/pilot TASK**
- production_DB_Auth_RPC_write_or_deploy_or_flags_or_secrets: **FORBIDDEN**
- PR_merge: **FORBIDDEN**
- shared_G5_Auth_schema_deletion_or_G3_scheduler_edits: **FORBIDDEN**
- source_owner: **Threads publication adapter, manual publish backend endpoint, scoped POSTONA manual publisher UI; NOT Threads OAuth**
- worktree: independent fresh G4 checkout; no H5/G3/G5 checkout sharing

## K4 FINAL — ChatGPT verification / 2026-10-11 JST

- task_id: postona-threads-manual-text-publish-v1-20261011
- verdict: **PASS_SOURCE_CANDIDATE / RELEASE_HOLD / NOT_LIVE_READY**. All requested pure source candidates exist. G4 Report verified below, separate real activation not approved.
- PR: [#140](https://github.com/anohi-memories/kabumori/pull/140), exactly `2e75a6a842e70f3de78558681803b60935fb4251`, OPEN/DRAFT/NOT_MERGED, 1 commit, 20 G4-scoped paths against main. ChatGPT inspected proposed Threads API transport, manual orchestration, HTTP/Edge static gate, G4 source-only SQL/role boundaries, mobile account UI, PR metadata and task Report. Source file overlap with protected PR135/#139 and G3 Draft PR138 absent in listed changed paths. Actual Mac worktree not independently inspected.
- G4 Report test evidence: Deno 86 PASS (transport+steps+Edge/provider), app 252 PASS, Postgres17 disposable DB ACL/role/concurrency negative tests PASS; lint/TS/diff checks PASS. **Tests are G4-reported, not rerun by ChatGPT; managed Supabase/PostgREST/Auth/Vault/Meta/native device untested.** Vercel build-rate-limit is not evidence of product test failure; do not claim CI green without new confirmation.
- Features accepted: TEXT-only two-step Meta publish builder (no `auto_publish_text`), one-attempt/one-account preview+manual consent UI, SQL source candidate with step claims/idempotency and account permission, read-only confirmation/reconciliation, explicit uncertainty without retry. New Edge `THREADS_MANUAL_PUBLISH_PREREQUISITES_MET=false` / mobile `THREADS_MANUAL_PUBLISH_UI_ENABLED=false`, client cannot make a real Threads write.
- **Risk / P1 integrated review required before any production activation:** new server service_role `redeem_threads_manual_publish_step` checks current account status, token and per-account permission, but **does not itself rerun G5 T13 lifecycle/entitlement and owner/admin membership checks** after caller-side `claim`; grant lasts up to 60 seconds. Need a reviewed end-to-end solution for entitlement ended/deletion/membership revoked between claim, redeem and actual Meta POST. Do not silently call an owner-only helper under service_role or widen grants; coordinate with G5 and H5 verified transport. Also G4 depends on an unimplemented owner-only `public.threads_account_credential_expires_at(text)` with exact long-token expiry semantics, and G5 T10 custody/deletion updates for G4's two new tables. No guaranteed live-ready per-post fresh-auth boundary until resolved.
- Further gates: source-only PR124/#135/#139 OAuth chain not production-active, real G5 T13, Phase2a-2 migration preflight/apply, owner+Vault authority, verified Meta app/tester/HTTPS mobile callback and 1 approved public test post, target-specific schema/source/release/security review **Sol（高）**. PR140 must remain Draft until these prerequisites and scoped user approval. Existing X code Issue131 deferred independently, not remediated.
- status: **done / next_owner none** (K4 accepts candidate, G4 freed and NOT parked for pending integration). Do not treat release HOLD as reason to occupy G4. Future integration/activation requires a new explicitly allocated TASK after fresh slot/PR/worktree checks.
- production: **no G4-caused migration/apply/GRANT/Vault/Meta/Supabase writes, PR merge, deploy, EAS or post**. Separately, `.agent/CURRENT_STATE.md` has an ACTIVE G6 production mutation window on same shared target, so new DB writes must wait for its closure and independent authorization.
- AI Lab development diary: safe to note mock-only connector/publisher design and test milestones without sharing secrets, private user or vulnerability procedure; not production-launch announcement.
- recommendation_for_integrated_boundary_review: **Sol（高）**, allocate free H1–H4 only once actual G4/G5/H5 compatible authority boundaries are assembled.

---

## Authority and boundaries

User requested Threads **real posting capability**, authorized parallel G4 development with Codex H5 where useful. Phase 1 target is ONE user-initiated text-only post (not images, auto schedule, bulk posts or Threads+X simultaneous posting). H5 separately owns the **Threads OAuth Edge/Auth trusted-identity/attempt persistence** integration under `postona-threads-oauth-runtime-bridge-h5-20261011`; H5 code and PR cannot be edited here. G3 separately owns the AI/manual **reservation planner** Draft PR138 and related `apps/social-mobile/src/app/(tabs)/schedule.tsx` paths; do not modify G3 composer/schedule or X dispatcher. G5 owns common account lifecycle/entitlement/T13 and Auth deletion, and cannot be changed. H1 accepted source-only PR135; PR124 pending. Existing X OAuth hardening Issue #131 is deferred but is NOT the G4 TASK or authorization to alter X.

**Work toward deployable, testable Threads posting code; do not produce only another prose architecture memo.** Do not use safety-risky authentication circumvention, token harvesting, fake identities or unattended public posting. This code is legitimate user-authorized publication. No production posting, operator token reading, Meta app changes, real auth session or Supabase data writes without separate narrow consent.

## Mandatory baseline and Git isolation

Read `PROJECT_RULES.md`, `AGENTS.md`, `CLAUDE.md`, `.agent/ORCHESTRATION.md`, `.agent/ACTIVE_TASK.md`, `.agent/CURRENT_STATE.md`, this G4 TASK, H5 TASK (ownership only), G3/G5 TASK headers and Reports. Fetch fresh `origin/main` via clean base `/Users/yuya/Developer/kabumori-fresh` and obtain current PR metadata/heads, ensuring no overlapping changed paths/worktree. Check existing app `apps/social-mobile` accounts routes, post UI, X publish permission and selected account/domain models, phase 2a-2 schema; current X publisher `supabase/functions/x-test-post` is reference-only and must remain unchanged. Docs `docs/postona/multi-social-phase1.md` and shared T9/T10/T13 contract. Reverify Meta official Threads publish API contract before hard-coding version/URLs.

Use new G4 branch from **fresh main**, own independent worktree; PR135/PR124/H5 branches must not be checked out/rebased/modified. G4 may import merged main's `threads_connect_contract.ts` only for safe common types; cannot import unmerged H5 or PR124 code until a later integration decision. If independent worktree/current ownership cannot be proven, STOP before editing.

## Implementation — four bounded deliverables

1. **Official Threads text publish transport** — provider-specific tested module (e.g. `supabase/functions/_shared/social/threads_publish_contract.ts`, associated `_test.ts`) that performs explicit `POST /me/threads` with `media_type=TEXT` and `text` to create a container, then `POST /me/threads_publish` with `creation_id` to publish. No reliance on `auto_publish_text=true` by default; explicitly consider whether a one-call path changes duplicate safety. Strict Meta API host/path, version and redirect validation, response ID preservation as STRING, provider error classification, content length/UTF-8/empties/newlines, fixed user-safe errors, provider post ID read-back contract; `threads_basic` and `threads_content_publish` confirmed. No client-disclosed access tokens. Inject fake HTTP/network in tests.
2. **Manual one-shot publish orchestration** — distinct account-specific Threads publish path (new isolated server module and/or Edge function source) that requires verified signed-in POSTONA user, active service entitlement, currently connected verified Threads account, **explicit per-account publish authorization**, durable attempt/step idempotency before any provider POST, exclusive exact account ownership, read-only status/read-back, and a fresh DB authorization check immediately before EACH external provider write. Server retrieves only this specific account's credential from Vault through a separately reviewed owner-controlled reader; no caller-supplied provider ID, credential, secret id, workspace/user/account ID as sole authority. Unknown provider/timeout outcomes -> record UNCERTAIN / read-back or human-assisted reconciliation, **never blindly retry either Threads write**. Preserve no credential/token data in logs/response. Connect-created accounts remain publish_disabled until an explicit reviewed user permission change. If migration/RPC required, create a **source-only guarded migration/candidate** with mock PG/RLS/ACL test; do not apply or activate. Never invent an effective service_role/owner privilege bridge absent a proven contract.
3. **User-facing manual posting UI (standalone, no G3 schedule screen modifications)** — scoped Threads-account tab/action in POSTONA accounts/navigation so user can see disconnected/ready/consent/expired/unavailable states, type and edit text, view exactly which Threads account will post, inspect preview, explicitly tap publish once, and see `publishing` / confirmed with provider ID/link / pending-uncertain / failed states. Never display successful posting on optimistic HTTP alone, and do not present mock preview as a live post. Disabled release flag until Auth/Meta/DB prereqs and approved pilot; do not create an always-on public “post now” control. No fake demo token accepted.
4. **Integration contract** with H5 OAuth owner: documented exact `verified_user_id`, `social_account_id`, provider='threads', active lifecycle T13, token-read grant, publish permission and provider result ledger I/O. Keep app/service keys `x_autopost` (POSTONA global entitlement), no new Threads entitlement. If H5/G5 prereqs are absent, implement injectable port with a **nonworking production adapter that fails closed**, report missing exact boundary; never mislabel as connected or deployable. Show the remaining SQL/Meta config and manual pilot gates needed to make actual one-post demo work.

## Independent tests and acceptance

- Auth absent/expired; wrong brand or account; cross-user, cross-brand, X-account routed to Threads; ended/deleting/suspended/no entitlement; publish disabled; token/Vault missing; expired token; expired/revoked connection; duplicate click; concurrent attempts; provider container accepted but publish failed; unknown publish outcome; invalid content/provider errors/429/timeouts; result response malformed; two steps each gets new permission check; no blind retry.
- Text-only one-post golden happy path through fake account, provider, repository, worker & UI. No real POST, real token, paid calls, production data mutation or migrations. Preserve existing X post tests and G3 planner; run focused app TypeScript/lint/tests, Deno tests, mock PG where needed, secret scan, `git diff --check`.
- Ensure safe deployment flags are false by default, no leak to logs, no mobile direct Meta Graph request; read-back result treats publication identity as verified provider-returned ID only after confirmation.
- Document concrete external operator steps to request later (Meta Threads app/tester and callback config; privacy/delete callbacks; minimal real test account) **without asking user to paste app secret into chat/GitHub**.
- Report actual change paths, tests RUN/NOT_RUN, exact PR/commit/push, dependency on H5/G5, remaining release blockers; Draft PR to main if isolated. Do not touch H5/G5/H1/H2/G3 branches, source, tasks, reports or force push.
- After completing source PR and read-back, append G4 Report to current TASK, set `review_required/next_owner:chatgpt`, and send `K4`. Do not silently enable public posting. Recommend targeted Sol（高） security review only when publish+OAuth+T13 boundaries actually integrate.

## Preserve prior G4 idle state and historical pointers

# Claude Task 4 — NO CURRENT TASK

- task_id: none
- owner: claude
- slot: claude-4
- status: idle
- next_owner: none
- start_code: G4
- finish_code: K4
- return_to: POSTONA｜マルチSNS化・開発統括（G4）のちゃ
- recommended_model: **none — select for the next actual G4 implementation task**

## Disposition and preserved history — 2026-10-11 JST

- User explicitly reassigned the prior Threads OAuth Edge offline implementation to Codex H1 (special temporary implementation), task `postona-h1-threads-oauth-edge-offline-implementation-20261011`; H1 start `H1`, finish `C1` in this chat.
- Former G4 Threads task `postona-threads-oauth-edge-offline-candidate-20261011` was interrupted by Claude Code's safety mechanism **before a submitted completion**. It was transferred, not marked implemented/done; original complete task and any future-local-ownership concerns are archived verbatim in `.agent/archive/CLAUDE_TASK_4_threads_edge_pre_codex_20261011.md`.
- Preceding X OAuth containment task remains **deferred and uncompleted**, tracked as [Issue #131](https://github.com/anohi-memories/kabumori/issues/131); preceding detailed record is `.agent/archive/CLAUDE_TASK_4_pre_threads_20261011.md`.
- G4 is **idle and available for a newly allocated separate POSTONA feature**, not an active implementation. Do not interpret a lone `G4` as permission to start old archived work; only a new `ready` TASK can begin. Never use G4 worktree to do H1 work.
- This bookkeeping does **not** grant production deploy, source merge, OAuth security bypass, database modification or provider calls.

## Report — postona-threads-manual-text-publish-v1-20261011（G4 → K4、2026-10-11 JST）

- task_id: postona-threads-manual-text-publish-v1-20261011
- result: **SOURCE_CANDIDATE_COMPLETE / RELEASE_HOLD**。4つの成果物をすべてソースと偽データのテストで実装した。Threads への実投稿は**まだできない**（静的ゲート false・リリースフラグ OFF・DB 候補は未適用）。本番・Meta・Supabase・X への呼び出し 0 件。
  1. 公式2段階投稿の送信部: `POST /{threads-user-id}/threads`（TEXT）→ コンテナ状態 → `POST /{threads-user-id}/threads_publish` → `GET /{media-id}` 読み戻し。2026-10-11 に Meta 公式文書を再確認（500文字・絵文字は UTF-8 バイト数・リンク5個・コンテナ24時間で失効）。`auto_publish_text` は重複安全性のため不使用。id は文字列のまま、エラーは固定コード、書き込みではトークンを URL に入れない。
  2. 手動1件投稿の手順: 呼び出し元 JWT の begin（冪等キー・本文をそのまま保存・1アカウント1件）→ **Threads への書き込みの直前ごとに** DB で再判定（G5 T13 フェンス `x_autopost`・オーナー/管理者・ワークスペース有効・Threads `identity_verified`・Vault 参照・**トークン期限5分以上**・アカウントごとの手動投稿の許可）→ 使い捨て許可証（sha256 のみ保存・60秒・1回・手順ごと）をサーバー専用 `service_role` 関数でトークンと交換 → 1回だけ送信 → 固定の遷移表で記録。公開の結果不明は `uncertain`（**再送しない**）、確認は読み取りのみ（コンテナ状態、24時間で確定）。途中停止・15分超過・許可証発行後の権限変化も「未公開」として確定。Edge ソース `social-mobile-threads-publish` は静的ゲートで常に 503。DB 側は migration ではなく `supabase/candidates/` の未適用候補（前提が無いと何も作らず停止）。
  3. 画面: Threads アカウント詳細のカード（投稿先表示・入力・Threads 基準の文字数・明示確認・結果表示・許可の付与/取消・「続ける」「確認する」）。「投稿しました」は読み戻し確認済み（id＋パーマリンク）のときだけ。リリースフラグ `THREADS_MANUAL_PUBLISH_UI_ENABLED=false` で既定は「準備中」表示のみ。G3 の予約画面は無変更。
  4. 連携契約: `docs/postona/threads-manual-publish-v1.md` §5（H5）・§6（G5）・§7（関門）・§8（Meta 側の準備）。
- changed_files: 20（Draft [PR #140](https://github.com/anohi-memories/kabumori/pull/140)、base main）
  - `supabase/functions/_shared/social/threads_publish_contract.ts`, `threads_publish_contract_test.ts`, `threads_manual_publish.ts`, `threads_manual_publish_test.ts`, `threads_manual_publish_fake.ts`（テスト用参照モデル）
  - `supabase/functions/social-mobile-threads-publish/{index,http,logic,http_test,logic_test}.ts`
  - `supabase/candidates/postona_threads_publish/threads_manual_publish_candidate.sql`
  - `supabase/tests/postona_threads_publish_{fixture,behavior}.sql`, `postona_threads_publish_run.sh`
  - `apps/social-mobile/src/domain/threads-manual-publish.ts`, `src/features/threads-publish/{use-threads-manual-publish.ts,threads-publish-card.tsx}`, `tests/threads-manual-publish.test.mjs`, `src/app/accounts/[id].tsx`（カード追加1行のみ）
  - `docs/postona/threads-manual-publish-v1.md`
- tests（すべて RUN・ローカル・偽データ）:
  - Deno `--no-config`: 86 PASS（新規: 送信部 17・手順 27・Edge 15、既存 provider_domain / threads_connect 含む）。`deno lint --no-config` 15ファイル問題なし。手順の変異4種（不明→失敗扱い、準備待ちなし公開、再送で再処理、FINISHED を公開扱い）すべて検出、検証後に元へ戻したことを確認。
  - DB 候補: Homebrew PostgreSQL 17 の使い捨てクラスタで `postona_threads_publish_run.sh` ALL PASS。前提不足4種（2a-2・G5 フェンス・フェンスがアプリ用ロールから実行可能・期限読み出し口）で停止、適用・再適用拒否、動作確認（ACL・本人・ロール・ワークスペース・接続・許可・トークン期限・冪等・許可証・遷移・試行期限・中断・削除中ガード・連動削除）、2セッション同時実行で1件のみ予約、変異6種すべて検出。G5 フェンスと期限読み出し口は**契約どおりの代役**で、G5/H5 の実装ではない。
  - アプリ: `npm test` 252 PASS（新規 18。サーバーとの文字数規則の一致を含む）、`tsc --noEmit` PASS、`expo lint` 問題なし。
  - `git diff --check` PASS、秘密情報の文字列検査 0 件。
  - NOT_RUN: 実 Meta / 実 Supabase Auth / PostgREST / Vault / 実機・シミュレーター表示（フラグ OFF のため画面は「準備中」のみ）。
- commit_hash: `2e75a6a874b2a5f31e8ec7bac3c80de92e9ac78f`（branch `claude/g4-postona-threads-manual-publish-20261011`、base `origin/main` `9fef4659`）
- push: DONE（上記ブランチ）。Draft PR #140 OPEN/DRAFT/UNMERGED。CI の Vercel は「Deployment rate limited — retry in 24 hours」（ビルド回数上限。コード起因ではない。PR138 と同じ）。
- deploy: NOT_DONE（Edge デプロイ・DB 適用・secret・フラグ変更・EAS すべて無し）。merge: NOT_DONE（TASK で禁止）。
- remaining_issues / 本番までの関門（静的ゲート `THREADS_MANUAL_PUBLISH_PREREQUISITES`）:
  1. Phase 2a-2 の本番適用。
  2. H5 接続ランタイムの本番化。**新しい依存: 資格情報の管理側が `public.threads_account_credential_expires_at(text) returns timestamptz`（所有者＝表の所有者、アプリ用ロール実行不可、NULL＝期限切れ）を提供すること**。H5 PR #139 は期限を OAuth 試行ごと（`token_expires_at`）に持つため、アカウント単位の読み方を H5/トークン管理側で決める必要あり。
  3. G5 T13 フェンス `private.account_lifecycle_assert_active_service_write(uuid,text)` の本番適用。G5 の T10 フットプリントに新しい2表（`social_account_manual_publish_permissions`, `threads_manual_publish_attempts`。どちらも cascade＋既存の削除ガード付き）を追加。
  4. この DB 候補のレビューと本番適用（同日の読み取り事前確認の後、単独ファイルとして）。
  5. Meta アプリ（`threads_basic`＋`threads_content_publish`、テスター招待と承認、HTTPS リダイレクト、連携解除/データ削除コールバック。アプリシークレットはユーザーがダッシュボードで直接登録）。
  6. 接続（H5）＋投稿（G4）＋T13（G5）をまとめた1回の独立セキュリティレビュー。特に「`auth.uid()` で判定 → 最大60秒の許可証で `service_role` 関数がトークンを渡す」新しい境界。
  7. テスター1名・実投稿1件の明示承認。
  - 要検証: 絵文字以外の文字数の数え方、Threads 固有のエラーコード、`owner` フィールドの有無。決めてほしいこと: `publish_mode='dry_run'` で手動投稿を許すか（今は `disabled` のみ停止）、許可の単位（今はアカウントごと）、画面の置き場所（今はアカウント詳細）。
- safety_checks: 専用 worktree `/Users/yuya/Developer/kabumori-g4-threads-publish`（`kabumori-fresh` の fresh `origin/main` から作成、他スロットと非共有）。PR #124 / #135 / #139（H5）/ #138（G3）/ G5 のブランチ・ファイルは checkout も変更もしていない（変更ファイルの重なり 0 を確認）。`x-test-post`・X OAuth（Issue #131）・G3 スケジューラ・G5 Auth/削除は無変更。`THREADS_CONNECT_PREREQUISITES_MET=false` は無変更。本番 DB/Auth/RPC の読み書き、Meta/X/Supabase API 呼び出し、トークン・secret の取得、課金 API は 0。使い捨て PostgreSQL は自分専用の socket `/private/tmp/g4tp-sock` のクラスタのみ使用。
- next_recommendation: K4 で受け入れ判断。Codex レビューは、H5・G5 の本番側の境界が揃って接続＋投稿＋T13 を統合する時点で1回（Sol（高））にまとめるのを推奨（この単体候補のための個別レビューは不要と考える）。並行して、H5/トークン管理側で期限読み出し口の置き場所を決める小さな TASK と、ユーザー側の Meta アプリ準備（§8）を進めると、実投稿までの距離が最短になる。




