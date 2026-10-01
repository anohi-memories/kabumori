# Claude Task 4

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- owner: claude
- slot: claude-4
- status: ready
- next_owner: claude
- priority: high
- recommended_model: Sonnet5（高）
- purpose: iOSのX OAuth接続時に前回ログインしたXアカウントが再利用され、複数Xアカウント利用者が接続先を切り替えにくい問題を、本番向けに安全に修正する。

## Why this should be fixed

The issue was reproduced during E3 preparation:
- the X login sheet remembered the previously authenticated X account.
- the operator could not reliably switch to a different X account.
- a local-only temporary change that opened a clean login session allowed the intended disposable account to be selected.
- this can affect real users who own multiple X accounts and can lead them to authorize the wrong account.

Current source uses:
`WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri)`
inside:
`apps/social-mobile/src/features/x-connect/use-x-connect.ts`

The installed app uses Expo 57 / `expo-web-browser ~57.0.3`.

Expo's current WebBrowser API supports an iOS auth-session option `preferEphemeralSession` that requests a private authentication session so normal browser cookies are not shared. Verify the installed type/API before implementation; do not add undocumented X query parameters.

## Mandatory startup

1. Read `.agent/ORCHESTRATION.md`, `.agent/CURRENT_STATE.md`, this TASK.
2. Use an independent G4 worktree/checkout; never use G3's worktree or simulator session.
3. Fresh `origin/main`.
4. Confirm G3 is operational E3 verification only and is not editing `apps/social-mobile/src/features/x-connect/use-x-connect.ts` or related tests.
5. Inspect the installed `expo-web-browser` type/API for Expo 57 before editing.
6. Do not use or mutate the disposable E3 account, protected production accounts, Vault, DB, Auth data, or X provider settings.

## Scope

Primary allowed scope:
- `apps/social-mobile/src/features/x-connect/use-x-connect.ts`
- narrowly related social-mobile tests
- onboarding copy only if needed to explain account choice

Do not change:
- server-side X OAuth contract
- PKCE/state validation
- callback ownership binding
- Supabase Edge Functions
- DB/RLS/RPC/migrations
- Vault/token storage
- account deletion
- scheduler/posting paths
- production feature flags

## Required behavior

Goal: when a user chooses to connect or reconnect an X account on iOS, the auth session should not silently inherit a previously logged-in X identity in a way that prevents account choice.

Preferred implementation candidate:
- request an ephemeral/private auth session for the X connect flow on iOS using the supported Expo WebBrowser option.
- keep Android/Web behavior unchanged unless the installed API provides an equally documented and safe equivalent.

Requirements:
1. Preserve current PKCE, state, redirect URI and callback validation exactly.
2. Do not clear global Safari/browser cookies.
3. Do not sign the user out of unrelated web sessions.
4. Do not add undocumented X authorization parameters.
5. Do not weaken the server-side duplicate-X-account protection.
6. Cancel/dismiss/retry behavior must remain truthful.
7. Reconnect flow must use the same safe account-selection behavior.
8. No real X post or production credential mutation.

## UX

If needed, add a short truthful hint near the X connect button such as:
- the user will be asked to sign in/select the X account they want to connect.
Do not promise that every browser/platform will always show an account chooser if the platform cannot guarantee that.

## Tests

Add/adjust focused tests to prove at minimum:
- iOS X connect requests the supported private/ephemeral auth-session behavior.
- Android/Web do not receive an unsupported iOS-only behavioral change.
- redirect URI, state, PKCE challenge/verifier and callback parser remain unchanged.
- cancel/dismiss/success/error state behavior remains unchanged.
- duplicate-X-account server protection remains untouched.
- no global cookie clearing/browser data deletion is introduced.

Run:
- social-mobile tests
- typecheck
- lint
- relevant Expo export/config check if available
- diff/secret checks

No EAS build unless a native rebuild is actually required to test the API behavior. Prefer local iOS Simulator verification.

## Local visual/E2E verification

Use a local simulator/test environment only:
- confirm the X auth sheet no longer auto-reuses the prior X login in the problematic way.
- confirm the user can intentionally authenticate a different X account.
- do not use protected production posting accounts for this test.
- do not perform a real X post.

If reliable provider-side testing would require touching production credentials/accounts, STOP and report rather than doing so.

## Completion / K4

Report:
- task_id
- result
- root cause
- exact source behavior changed
- changed_files
- tests
- local simulator result
- commit_hash
- push/PR
- production mutation = 0
- remaining issues / platform caveats
- safety checks
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K4.

Because this changes an OAuth/authentication boundary, ChatGPT will decide at K4 whether focused Codex review is required before merge.


## Report

- task_id: x-social-mobile-x-account-switch-auth-session-20261001
- result: **PASS（source・自動テスト）／実機でのXアカウント切替確認は未実施（操作者の確認が必要）**。PR #65（未merge）。
- model_used: Sonnet 5.5
- worktree: G4専用 `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（G3のworktree・Simulatorは使っていない。G3はE3の運用確認のみで、`use-x-connect.ts`と関連テストは編集していないことを確認）

### root cause

`use-x-connect.ts`が`WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri)`をオプションなしで呼んでいた。iOSではこれが`ASWebAuthenticationSession`で、Safariのcookieを共有するため、直前にログインしたXアカウントがそのまま再利用され、別のアカウントを選べなかった。

### exact source behavior changed

- インストール済み`expo-web-browser 57.0.3`の型定義で、`AuthSessionOpenOptions.preferEphemeralSession`（`@platform ios`、既定`false`、「ブラウザが対応するかは利用者の既定ブラウザ次第」と明記）を確認。ネイティブ側も`ASWebAuthenticationSession.prefersEphemeralWebBrowserSession`へ配線済み（カスタムスキームのcallbackでも設定される）。未文書のXパラメータは追加していない。
- **iOSだけ**、この第3引数`{ preferEphemeralSession: true }`を渡す。Android/Webは従来どおり2引数のまま（オプションなし）。再接続も同じhookなので同じ挙動になる。
- 接続画面（アカウント画面・オンボーディングの接続ステップ）に、真実に沿った案内を1行追加: 「接続時に、Xのログイン画面で接続したいアカウントを選んで（またはログインして）ください。ブラウザの状態によっては、以前ログインしたアカウントが表示される場合があります。」（アカウント選択画面が必ず出るとは約束していない）。
- 変更していないもの: state・PKCE・redirect URI検証・`x.com`ホスト許可・callback解析・リクエスト本文・cancel/dismiss/success/errorの状態処理、サーバー側のX重複アカウント保護、Edge Function、DB、Vault、アプリログイン用のprovider認証（`auth-client-flows.ts`）。cookie・ブラウザデータの削除は行っていない。

### changed_files

新規: `apps/social-mobile/src/features/x-connect/auth-session-options.ts`、`apps/social-mobile/tests/x-connect-auth-session.test.mjs`
変更: `apps/social-mobile/src/features/x-connect/use-x-connect.ts`（3引数化、+5/-1）、`apps/social-mobile/src/app/accounts/index.tsx`（案内1行）、`apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`（案内1行）
サーバー・DB・Edge Function・G3のテストファイルの変更なし。onboardingの既存テストはモジュールのimportを厳密に検査するため、新規モジュールをimportせず案内文はリテラルにした。

### tests

- 新規`x-connect-auth-session.test.mjs`: **10/10 pass**（iOSは指定あり／Android・Web・その他は指定なし／型定義にiOS専用オプションが存在／hookがそのオプションだけを渡す／OAuth契約の各行が不変／状態処理が不変／cookie削除・追加パラメータなし／アプリログイン側が不変／案内文が両画面にあり「選べる」と約束していない）。変異検査: hookからオプションを外すとテストが失敗することを確認し、元に戻した。
- `npm test`（social-mobile全体）: **99/99 pass**。data-view＋post-interaction: 22/22 pass。
- `tsc --noEmit`: PASS。`expo lint`: PASS。Expo web export: 成功（895 modules）。Expo iOS export: 成功（1224 modules）。
- `git diff --check`: PASS。secret scan: 該当なし。
- EAS buildなし。ネイティブ側にオプションが既にあるため、この変更でネイティブ再ビルドは不要と判断（実機の開発ビルドが同じ`expo-web-browser`から作られている前提）。

### local simulator result

**未実施**。理由: (1) 起動中のSimulator（iPhone 17 Pro）はG3のE3検証の環境で、使わない指示のため使っていない。(2) 「別のXアカウントを実際に選べるか」の確認は、実際のXログイン画面へXアカウントの認証情報を入力する必要があり、エージェントは認証情報を入力しない（TASKも本番・保護アカウントの使用を禁止）。したがって、プロバイダ側の実際の挙動（ログイン画面が既ログインを引き継がないこと）は**未確認**。
- 操作者の確認手順（案）: このブランチのJSを実機/Simulatorの開発ビルドに読み込み、Safariで複数のXアカウントのうち1つにログインした状態でアカウント画面の「Xアカウントを再接続」を押し、認証シートが既存のログインを引き継がずログイン画面から始まる（別のアカウントで認証できる）ことを確認する。使用するのは使い捨てアカウントのみ、投稿はしない。

### commit_hash

`e8a7785`（PR #65、ブランチ`g4/x-connect-ephemeral-auth-session-20261001`）。このReportのcommitはmainに別途push。

### push/PR

ブランチをpush済み。PR #65（OPEN、MERGEABLE）: https://github.com/anohi-memories/kabumori/pull/65 。未merge。

### production mutation

**0件**。deploy・DB/RLS/RPC/migration・Auth/Vault変更・X投稿・本番アカウント操作はいずれも無し。

### remaining issues / platform caveats

1. 実機でのプロバイダ側の挙動が未確認（上記）。`preferEphemeralSession`は「要求」で、ユーザーの既定ブラウザによっては尊重されない可能性がある（公式ドキュメントに明記）。案内文はそれに合わせて約束をしていない。
2. 副作用: 非共有セッションのため、接続のたびにXへログインし直しになる（Safariのログイン状態・SSOは使われない）。パスワードマネージャーの自動入力の使い勝手は端末設定によって変わる可能性がある。
3. Android/Webは今回のスコープ外（同等の文書化された手段がないため従来どおり）。Android側で同じ問題が出る場合は別TASKが必要。
4. アプリログイン用のX認証（G3所有）は別の信頼ステップで、同様のアカウント再利用が起こりうるが、TASKの範囲外のため変更していない。

### safety checks

- OAuth/PKCE/state/redirect/callback検証・サーバー側の重複アカウント保護・秘密情報の取り扱いは変更なし（テストで固定）。
- 未文書のX認可パラメータ、cookie・ブラウザデータ削除、他サービスからのサインアウトは導入していない。
- 本番資格情報・保護アカウント・使い捨てE3アカウントに触れていない。実際のX投稿なし。

### next recommendation

1. OAuth/認証境界の変更なので、K4でCodexの焦点レビューの要否を判断（変更は約6行で、境界の検証ロジックは不変）。
2. 操作者が実機（または自分のSimulator）で、上記の手順どおり使い捨てアカウント同士の切替を確認する。確認後にmerge。
3. 問題がなければ、E3の再開・以降のXアカウント接続の手順に「毎回Xへログインし直しになる」旨を反映する。

## Completion

- status -> review_required
- next_owner -> chatgpt


## K4 follow-up — operator provider-side E2E only

- K4 verdict: **HOLD — source/review PASS, provider-side operator E2E remains**.
- PR #65 exact head remains `e5a66f5ba71f64b1a38d8f89faff3d0a31972949`, open and mergeable.
- Prior C1/source-security review already accepted this exact head; no additional Codex review is required unless runtime source changes.
- Fresh main has advanced since the PR base, but none of the five PR #65 source/test files overlap main-side changes.
- Do not change source unless the E2E exposes a real defect.

### Goal

Prepare and guide a safe operator-side iOS test proving:
1. a previously logged-in X identity is not silently forced on the posting-account connect flow,
2. the operator can authenticate a different disposable X account,
3. cancel -> retry remains usable,
4. reconnect uses the same behavior,
5. no real X post occurs.

### Environment isolation

- Use the dedicated G4 worktree/checkout only.
- Do not use G3's worktree, branch, or active simulator process.
- If no separate simulator/device is safely available, STOP and report instead of sharing G3's environment.
- Load PR #65 JS/source into a compatible existing development build. Do not rebuild unless actually necessary.
- Do not use protected production posting accounts.
- Use only disposable/test X identities controlled by the operator.

### Operator interaction boundary

Claude may:
- prepare the app/simulator to the point immediately before X login/account selection,
- tell the operator exactly what to tap,
- observe app-side state after the operator action,
- inspect non-secret logs/results.

Claude must NOT:
- type X passwords, passkeys, 2FA codes, recovery codes, or other credentials,
- approve X authorization on the operator's behalf,
- clear global browser cookies,
- modify provider settings,
- post to X.

### PASS criteria

PASS only if the operator confirms/observes:
- starting from a normal browser state with X account A signed in, the posting-account connect/reconnect flow does not silently complete as A without an opportunity to authenticate,
- account B can be authenticated intentionally in the auth session,
- cancellation returns safely and retry works,
- reconnect follows the same path,
- no real post is created.

Because `preferEphemeralSession` is a best-effort platform/browser request, it is acceptable if the UI is a fresh login screen rather than a literal account chooser. The required result is that the previous normal-browser session is not silently reused in a way that prevents choosing/authenticating another account.

### After PASS

- Do not merge PR #65 in G4.
- Record exact operator-observed behavior, device/simulator context, cancel/retry/reconnect result, and real X posts = 0.
- Set status -> review_required, next_owner -> chatgpt and STOP for another K4.
- ChatGPT will perform the final merge/no-race decision.

### If FAIL

- Preserve evidence and STOP.
- Do not improvise new OAuth parameters or cookie clearing.
- If a source correction is required, report the smallest proposed change first; runtime-source change will require another focused review.

Recommended model: **Sonnet5（高）**.
