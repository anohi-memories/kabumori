# Claude Task 4

- task_id: x-admin-netlify-live-site-preview-qa-20260925
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: 既にrepository準備済みの apps/admin を実際のNetlifyサイトへ接続し、最初のDeploy Previewで proxy.ts / Supabase SSR / protected route / PR #15 UI semantics を安全にQAする。PR #15 mergeやVercel production deployは行わない。

## Previous G4 closure

Previous task:
- `x-admin-netlify-deploy-preview-pipeline-20260924`

Final K4:
- PASS
- implementation commit: `12b994e00a4f7ae83076e6c9c44a09d339cebb9d`
- branch: `admin-netlify-deploy-preview-phase2-20260924`
- repository-side Netlify config/runbook complete
- live Netlify site connection not yet performed
- `proxy.ts` runtime on Netlify not yet verified
- PR #15 remains unmerged and semantically untouched
- Vercel/production/DB/DNS mutation = 0

## Goal

Complete the external/live half of the Netlify Preview setup:

1. connect/create the Netlify site for this repo/admin app
2. set the correct base/build configuration
3. set only required public env vars
4. verify a real Netlify Deploy Preview
5. validate auth/session/protected-route behavior, especially Next.js 16 `proxy.ts`
6. validate PR #15 behavior on Preview without merging it

This task is allowed to perform Netlify development/preview configuration only.

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK and previous G4 Report
5. Fresh fetch origin/main
6. Confirm independent dedicated G4 worktree
7. Inspect G3/H1/H2/G1/G2 and prove no overlap
8. Re-read `apps/admin/docs/phase2-netlify-deploy-preview.md`
9. Re-read current `apps/admin/netlify.toml`
10. Verify PR #15 current head and that apps/admin source semantics have not drifted unexpectedly

## Scope A — Netlify account/site connection

Preferred path:
- use an existing authorized Netlify integration/session if available
- connect repository `anohi-memories/kabumori`
- create or link the admin site
- base directory: `apps/admin`

Do not create multiple duplicate Netlify sites if one already exists.

If interactive browser/account authorization is required and cannot be completed inside the current tool/session:
- STOP before guessing or bypassing
- record the exact blocking screen/action
- do not substitute Vercel
- do not weaken authentication
- report the minimal user action required

## Scope B — build configuration

Expected:
- Base directory: `apps/admin`
- build command: use repository `netlify.toml`
- publish/runtime: Netlify Next.js adapter/default
- Node version: use existing repository configuration
- Deploy Previews: enabled for PRs

Confirm final live Netlify settings match repository intent.

Do not add a custom Next.js adapter unless the automatic adapter demonstrably fails and the change is narrowly justified.

## Scope C — environment variables

Allowed Netlify env vars:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Use existing authorized/public values only.

Forbidden in Netlify admin preview env:
- service_role key
- OAuth client secret
- Vault secret/plaintext/reference material
- OpenAI private keys
- X access/refresh tokens
- any unrelated production secret

Confirm no server-only secret is accidentally exposed through `NEXT_PUBLIC_*`.

If the required public values cannot be safely retrieved from an already-authorized source, STOP and report the missing operator input. Do not invent them.

## Scope D — first live Deploy Preview

Create or trigger a Preview build for a safe branch/PR.

Preferred target:
- PR #15, because its reviewed selector semantics need real Preview QA and it is intentionally still unmerged

If Netlify cannot preview the already-open PR directly, use the safest repository-supported equivalent without changing PR #15 semantics.

Record:
- site id/name
- preview/deploy id if available
- branch/PR head
- build status
- build/runtime adapter version if exposed
- preview URL in Report only if non-secret/public

Do not merge PR #15.

## Scope E — proxy.ts / auth QA

This is the main unresolved risk.

Verify on actual Netlify runtime:

1. unauthenticated request to protected admin route redirects/fails closed
2. login page loads
3. authenticated session cookie is recognized
4. `src/proxy.ts` session refresh behavior executes correctly on Netlify
5. expired/invalid session does not grant access
6. protected layout still performs its own auth/authorization checks
7. Server Action authorization remains enforced

If full authenticated QA requires a production credential not safely available:
- perform all possible unauthenticated/fail-closed QA
- do not create or expose credentials
- report exactly what authenticated step remains blocked

## Scope F — PR #15 Preview QA

Against PR #15 Preview, verify:

- Kabumori / AI Lab selector renders correctly
- switching active brand changes only intended scoped admin data/views
- Important News remains Kabumori-only
- AI Lab does not expose Kabumori-only system toggle
- tampered/unknown selector value fails closed or resolves safely
- direct URL navigation respects active-brand rules
- auth/RLS boundary remains intact
- no cross-brand leakage
- representative SSR/dynamic pages render
- no hydration/runtime errors attributable to Netlify

Do not change selector semantics merely to make Preview pass.

## Scope G — Netlify logs/runtime evidence

Inspect only what is necessary:
- build logs
- Next.js runtime/function logs
- proxy/middleware-related runtime evidence
- auth redirect errors

Do not copy secret values into TASK/Report.

If logs expose secrets unexpectedly, stop and report a security issue without reproducing the secret.

## Scope H — local regression

Before/after live QA run:

- node tests for apps/admin
- `npx tsc --noEmit`
- `npm run lint`
- `npm run build`
- `git diff --check`
- secret scan

If PR #15 has current scoped tests, run them at its exact head too.

## Scope I — deployment policy verification

Confirm the intended workflow is actually viable:

feature branch / PR
→ local tests
→ Netlify Deploy Preview
→ implementation K review
→ Codex review when needed
→ merge/final approval
→ Vercel production only at final release stage

Netlify Preview success should remove Vercel rate limit from ordinary development QA.

## PR #15 safety

PR #15 remains:
- unmerged
- no Vercel production deploy
- no production admin behavior switch

This task may Preview and QA PR #15 only.

## Forbidden

- merge PR #15
- Vercel production deploy/config/plan changes
- DNS/custom-domain production cutover
- production Supabase DB migration/RPC/view/policy mutation
- Edge Function/Cron/OAuth/Vault/token mutation
- X API/post/media actions
- changing ADMIN_BRANDS/selector semantics unless a concrete bug is found and a separate fix is explicitly warranted
- service_role exposure
- disabling auth/RLS to make Preview work
- G1/G2/G3 source changes

## Production mutation budget

0 for:
- Vercel production
- production DB/schema/RPC/Auth/X/Cron/Vault

Allowed:
- Netlify development/preview site connection and Preview environment/configuration

## Completion / K4

When complete:
- status -> review_required
- next_owner -> chatgpt

Report:
1. fresh main SHA
2. worktree/branch
3. Netlify site connection result
4. exact blocker if interactive auth stopped execution
5. live configuration read-back
6. env-var names configured (never values)
7. Preview branch/PR/head
8. build/deploy result
9. `proxy.ts` QA result
10. unauthenticated/authenticated protected-route QA
11. PR #15 selector/brand boundary QA
12. local regression counts
13. changed files, if any
14. Netlify-only mutations performed
15. production mutation=0
16. PR #15 remains unmerged confirmation
17. remaining risks
18. next recommendation

If the only blocker is interactive Netlify authorization:
- leave status `review_required`
- document the exact one-time user action required
- STOP for K4.

Do not merge PR #15 or deploy production in this task.

## Report

- task_id: x-admin-netlify-live-site-preview-qa-20260925
- result: **Scope A（Netlifyアカウント/サイト接続）でブロック。live Deploy Previewは未実施。** タスクの明示的な指示どおり、推測・回避せずここでSTOPした。それ以外の準備可能な範囲（ローカル回帰・PR #15 drift確認・設定意図の再確認）はすべて実施・PASS。
- model_used: Sonnet 5（`recommended_model: Sonnet5（高）`のうちSonnet5部分）
- worktree: G4専用の独立worktree `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（branch `worktree-g4-x-admin-pr15`）で完結。

### fresh main SHA / worktree/branch

- 着手時fresh main: `7d57b42`。in_progressマーカーpush後も再フェッチし、以後変化なしを確認。
- worktree: 上記のG4専用独立worktree（前タスクから継続使用）。

### Mandatory startup（1〜10）

1〜7. PROJECT_RULES.md / ORCHESTRATION.md / CURRENT_STATE.md / 本TASKと前回G4 Reportを確認。CURRENT_STATE.mdで「G4 Netlify repository preparation is complete; live Netlify site connection/QA remains pending interactive authorization」を確認し、前提と一致。G1（done, mobile release）/ G2（ready, PR#26 merge）/ G3（done, X autopost Phase1E）/ H1（ready, Phase1H review）/ H2（done, PR#26 review）いずれも`apps/admin`と重なりなし。
8. `apps/admin/docs/phase2-netlify-deploy-preview.md`を再読了。
9. `apps/admin/netlify.toml`を再読了：ビルド設定（`command`/`publish`/`NODE_VERSION`）は前回G4完了時のまま無変更であることを確認。
10. PR #15現在headを確認：`b04442561d9e9c6d01b4a9fcf640c2cf731cd923`（前回から不変）。`apps/admin`のsource semantics driftを再diffで確認（詳細は下記）。

### Scope A — Netlify account/site connection: **ブロック**

- 既存の認証済みNetlify連携を探索：`netlify` CLIは未インストール、`npx netlify-cli status`は`Not logged in`。`NETLIFY_AUTH_TOKEN`等の環境変数なし。GitHub repository secretsにもNetlify関連の項目なし（`gh secret list`で`OPENAI_API_KEY`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_URL`の3件のみ確認、いずれもNetlifyとは無関係）。ToolSearchでも"netlify"に一致する連携ツールなし。
- **agent/human-in-the-loop認証**（`netlify login --request "<message>"`、非対話でticket URLを生成しユーザーに承認してもらう設計のオプション）を試みたが、**Claude Code auto mode classifierにより`[Unauthorized Persistence]`理由でブロックされた**。これは第三者サービスとの新規アカウント連携を持続的に作成する操作であり、意図的な安全装置として妥当と判断し、回避を試みずここで停止した。
- 結論：**Netlifyサイトの作成・接続には、権限を持つ人間がNetlifyダッシュボードで直接操作する必要がある。** 正確な手順は既に`apps/admin/docs/phase2-netlify-deploy-preview.md`の「Exact remaining UI steps」に記載済み（変更なし、再掲は次項）。

### 正確なブロッカーと必要な最小限のユーザー操作

1. Netlifyダッシュボード（ブラウザ）で `Add new site → Import an existing project` → `anohi-memories/kabumori` を接続
2. Base directory: `apps/admin`
3. 環境変数2件を設定：`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（既存Vercel Productionと同じ公開値）
4. deploy contextはNetlify既定のまま（Production=デフォルトbranch、Deploy Preview=全PR）
5. サイト作成後、このタスクの続き（Scope D以降）を別途G4で再開すれば、そこからは非対話で進められる可能性が高い

### Scope B/C — 設定意図の再確認（live接続なしで可能な範囲）

- Base directory = `apps/admin`、build command/publishはrepository `netlify.toml`依存、Node versionは既存設定（`NODE_VERSION=24`）のまま — 前回G4完了時の設計から変更なし。
- 許可された環境変数2件のみが必要で、server-only変数（service_role/OAuth/Vault/OpenAI/X token）は`apps/admin/src`に一切参照が無いことを再確認（grep 0 hit、前回と同じ）。

### Scope D/E/F/G — **未実施**（live siteが存在しないため）

Deploy Preview作成、`proxy.ts`のNetlify実行時QA、PR #15のPreview QA、Netlifyビルド/ランタイムログの確認は、いずれもlive siteの存在が前提のため実施していない。

### Scope H — local regression

fresh main（`7d57b42`）上のapps/adminで実施、いずれもPASS：

- `node --experimental-strip-types --test src/lib/*.test.ts`：**12/12 pass**
- `npx tsc --noEmit`：PASS
- `npm run lint`：PASS
- `npm run build`（dummy public env）：PASS（3 dynamic + 2 static + 1 Proxy、前回と同一）
- `git diff --check`：PASS
- secret scan：0件

**PR #15の現在head（`b044425`）でも同様に実施**（`git worktree add --detach`で一時的にread-onlyでcheckoutし、確認後`git worktree remove`で削除、ローカルの一時ref `pr15-worktree-check`も削除。PR#15自体のbranchには一切書き込んでいない）：

- `node --experimental-strip-types --test src/lib/*.test.ts`：**31/31 pass**（PR #15固有のbrand selector系テストを含む）
- `npx tsc --noEmit`：PASS
- `npm run lint`：PASS
- `npm run build`：PASS（route構成はmainと同一）

### Scope I — deployment policy verification

- ワークフロー自体（feature branch/PR → local tests → Netlify Deploy Preview → K review → Codex review → merge → Vercel production）は設計上viable。ただしNetlify Deploy Previewの実行自体がlive site未接続のため、現時点ではまだ「実証」段階に至っていない。

### PR #15 semantics drift確認

- origin/main（`7d57b42`）とPR #15現在head（`b044425`、read-only fetch、branchとしてはcheckoutせずtemp worktreeのみで確認、確認後削除）を`apps/admin`スコープで再diff。
- 差分は前回確認した18ファイル + 今回のG4 Phase2で新たにmainへ追加された3ファイル（`netlify.toml`/`.gitignore`/`docs/phase2-netlify-deploy-preview.md`のコメント・doc更新分、PR #15のbranchがPhase2着手前の古いmainから分岐しているため）の合計21ファイル。
- **`netlify.toml`の非コメント行（`[build]`/`[build.environment]`の実際の設定値）はPR #15とmainで完全に同一**であることを行レベルで確認した（コメントのみの差分）。`package.json`/`package-lock.json`/`tsconfig.json`/`next.config.ts`は無変更。
- 結論：**PR #15の意味的な内容（selector semantics、ADMIN_BRANDS、認可ロジック）に予期しないdriftは無い。** ビルド設定も実質的に同一のため、live site接続後はPR #15を無変更でPreview可能という前回の結論は引き続き有効。

### changed_files

- `.agent/tasks/CLAUDE_TASK_4.md`（本TASK/Report）のみ。`apps/admin`のsource/config/docへの変更は0件（前回完了済みの内容を再確認しただけ）。

### Netlify-only mutations performed

**0件。** サイト作成・接続・環境変数設定・deploy triggerのいずれも実施していない（Scope Aでブロックされたため）。

### production mutation = 0

Vercel/production DB/schema/RPC/Auth/X/Cron/Vault：変更0件。ADMIN_BRANDS/selector semantics：変更0件。

### PR #15 remains unmerged confirmation

head `b044425`のまま、mergeしていない。上記のとおりread-onlyでのdrift確認のみ実施した。

### remaining risks

1. **live Netlify siteが依然存在しない**（唯一の実質的なブロッカー）。上記5ステップのuser actionが必要。
2. `proxy.ts`のNetlify実行時挙動は引き続き未検証（live site作成後でなければ検証不可能）。
3. PR #15はNetlify Phase2着手前の古いmainから分岐しているため、live Preview実行時にはPR #15側をfresh mainへrebase/freshenするかどうかの判断が必要になる可能性がある（意味的drift自体は無いため、freshenは任意）。

### next_recommendation

1. 上記5ステップのNetlifyサイト作成を、権限を持つ人間（またはinteractive Netlify authorizationが明示的に許可された別タスク）が実施する。
2. サイト作成後、本TASKのScope D以降（live Deploy Preview作成、`proxy.ts` QA、PR #15 Preview QA）を別途G4で再開する。
3. その際、PR #15を対象PreviewにするかfreshenするかをK4で明示してもらうことを推奨（意味的drift自体は無いため必須ではない）。

## Completion (Netlify site connection blocked)

- status -> review_required
- next_owner -> chatgpt
