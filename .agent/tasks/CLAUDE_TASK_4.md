# Claude Task 4

- task_id: x-admin-netlify-deploy-preview-pipeline-20260924
- owner: claude
- slot: claude-4
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: X自動投稿・複数ブランド管理画面 apps/admin の開発中PreviewをNetlifyへ移し、Vercelのdeployment rate limitに依存せずテスト・レビューできる状態を作る。最終production deployのみVercelへ残す。

## Deferred previous G4 task

Previous task:
- x-admin-phase2-vercel-gate-merge-and-postmerge-qa-20260924
- PR #15 remains unmerged because Vercel check is rate-limited
- reviewed code/test state is preserved in prior G4 Report
- do NOT discard or reinterpret that work
- its remaining steps (Vercel final gate -> merge -> post-merge read-back -> production QA) are intentionally deferred by explicit user instruction while Netlify Preview is introduced

This Netlify task supersedes the active slot temporarily; the deferred PR #15 final-production gate must be resumed later as a separately assigned task after Netlify workflow is established.

## User-approved deployment policy

New standard:
- development / PR / test deploy: Netlify Deploy Preview
- code review occurs against source + Netlify Preview
- Vercel is reserved for final production deployment after implementation and review are complete
- do not spend Vercel deployment quota on ordinary intermediate testing where Netlify can validate the same web behavior

## Mandatory startup

1. Read PROJECT_RULES.md
2. Read .agent/ORCHESTRATION.md
3. Read .agent/CURRENT_STATE.md
4. Read this TASK and prior G4/G2 reports for PR #15 context
5. Fresh fetch origin/main
6. Confirm dedicated independent G4 worktree
7. Inspect G3/H1/H2/G1/G2 scopes and prove no overlap
8. Audit apps/admin Next.js version, package scripts, proxy/middleware, Supabase SSR, Server Actions, dynamic routes, and current Vercel-specific config
9. Audit any existing Netlify config before changing files

## Scope A — Netlify Preview architecture

Configure apps/admin so PR/branch builds can run as Netlify Deploy Previews.

Requirements:
- preserve Next.js 16 App Router semantics
- preserve Supabase SSR/cookie behavior
- preserve protected route behavior
- preserve Server Actions / proxy or middleware behavior supported by the chosen Netlify adapter/runtime
- do not convert secure server reads to client-side reads merely to make Netlify work
- no weakening of auth/RLS/admin boundaries
- no production DNS/domain change
- no production Supabase mutation

If a Vercel-specific assumption blocks Netlify, document and minimally abstract it; do not redesign unrelated admin behavior.

## Scope B — environment and secret boundary

Classify every env var needed by apps/admin:
- public/browser-safe
- server-only
- unavailable / external setup required

Rules:
- never commit secret values
- never expose service_role, OAuth secrets, Vault material, OpenAI private keys, or other server-only values via NEXT_PUBLIC
- Preview must fail closed if required server-only configuration is absent
- document exact Netlify UI environment-variable names required, but not values

If Netlify connection/site setup requires interactive account authorization, prepare the repository completely and report only the exact remaining UI steps.

## Scope C — build and preview verification

Run:
- apps/admin clean install as appropriate
- node tests (31/31 baseline or current higher count)
- npx tsc --noEmit
- npm run lint
- npm run build
- Netlify-compatible local/build command if available
- git diff --check
- secret scan

If actual Netlify Preview deploy is available through existing credentials/integration, verify:
- deploy succeeded
- login/auth redirect behavior
- protected pages
- Kabumori / AI Lab selector rendering
- Important News remains Kabumori-only
- AI Lab does not expose Kabumori-only toggle
- representative SSR/dynamic pages render

Do not mutate production operational settings during QA.

## Scope D — deployment workflow

Document the new normal flow:

feature branch/PR
-> local tests
-> Netlify Deploy Preview
-> Claude implementation completion
-> ChatGPT K review
-> Codex review when required
-> fixes/regression
-> final approval
-> Vercel production deploy only at the end

Vercel failure/rate-limit must no longer block ordinary implementation review if Netlify Preview and local tests cover the required web checks.

## Scope E — preserve PR #15

Do not merge PR #15 merely as part of setting up Netlify.

After Netlify Preview is working:
- identify whether PR #15 can be previewed on Netlify without modifying its reviewed semantics
- if yes, record the safe procedure for the later final gate
- keep the actual production merge/deploy deferred until separately resumed

## Forbidden

- PR #15 merge in this task
- Vercel production deploy/config/plan change
- DNS/domain change
- DB migration/RPC/view/policy changes
- Edge Function/Cron/OAuth/Vault/token changes
- x-test-post/queue Phase1D changes
- selector semantics or ADMIN_BRANDS behavior changes
- weakening auth/RLS
- secret exposure

## Completion / K4

When complete:
- status -> review_required
- next_owner -> chatgpt
- append Report with:
  - fresh main SHA
  - worktree
  - exact changed files
  - Netlify config/adapter/build decisions
  - environment variable classification
  - local build/test results
  - actual Preview deploy result or exact external authorization blocker
  - preview QA results
  - proof PR #15 semantics remain unchanged
  - Vercel production mutation=0
  - deferred PR #15 state
  - remaining risks
  - next recommendation
- STOP for K4.

## Report

- task_id: x-admin-netlify-deploy-preview-pipeline-20260924
- result: **準備完了。ただし実際のNetlifyサイト作成は未実施**（interactive account authorizationが必要でこのタスクの権限外のため）。リポジトリ側の準備・検証・runbookはすべて完了し、残りは正確なUI手順としてdocに記録した。
- model_used: Sonnet 5（`recommended_model: Sonnet5（高）`のうちSonnet5部分。effort tierの自己変更は許可されていないため、セッションの現行effortのまま実施）
- worktree: G4専用の独立worktree `/Users/yuya/Developer/kabumori/.claude/worktrees/g4-x-admin-pr15`（branch `worktree-g4-x-admin-pr15`）で完結。G1/G2/G3とは共有していない。

### Mandatory startup（1〜9）

1. PROJECT_RULES.md読了：`G1〜G4/H1・H2並行時は独立Git worktree必須`の項を確認。本worktreeで満たしている。
2. ORCHESTRATION.md読了。
3. CURRENT_STATE.md読了：`G4 owns apps/admin Netlify Preview configuration only`を確認。
4. 本TASKと、前工程G4 Report（PR #15 merge gate、現在deferred）・G2 Report（Phase 1設計、PR #14でmerge済み）を確認。
5. fresh fetch origin/main：作業中に複数回前進（最終確認時`2794ff5`）。差分はすべて`.agent/**`のcontrol fileのみで`apps/admin`は0件。
6. dedicated independent G4 worktreeを確認（上記）。
7. G1/G2/G3/H1/H2のscope overlapを確認：G1=PR#17 mobile merge（apps/admin対象外）、G2=idle（Kabumori Netlify Web Previewは別件でdeferred中、apps/adminとは無関係）、G3=X queue Phase1D、H1=done、H2=idle。いずれも重なりなし。
8. apps/adminのNext.js version（16.3.4）、package scripts（dev/build/start/lint）、proxy.ts（`src/proxy.ts`、middlewareのNext.js 16改称）、Supabase SSR（`@supabase/ssr`、cookieベース）、Server Actions（`system-toggle.ts`の1件、固定allowlist）、dynamic routes（3 dynamic + 2 static）、Vercel専用設定（`vercel.json`等は存在せず、Vercel固有の設定は0件）を監査した。
9. 既存Netlify configを監査：Phase 1（PR #14でmerge済み、task_id `x-admin-netlify-thin-control-plane-phase1-20260924`）が`netlify.toml`のsource candidateと設計doc（`docs/phase1-netlify-thin-control-plane.md`）をすでに用意していた。今回はこれを土台にPhase 2として実際のdeploy previewパイプライン化を進めた。

### changed_files

- `apps/admin/netlify.toml`（既存ファイルの更新）: コメントをPhase 2状態に更新し、Netlify Next.js 16サポートの調査結果と`proxy.ts`の残課題を明記。ビルド設定（`command`/`publish`/`NODE_VERSION`）自体は無変更（Phase 1の候補のまま正しかったため）。
- `apps/admin/.gitignore`（既存ファイルの更新）: `.netlify`を追加（Netlify CLIのローカルsite-link状態ディレクトリ、既存の`.vercel`と同様の理由）。
- `apps/admin/docs/phase2-netlify-deploy-preview.md`（新規）: Phase 2 runbook。Netlify readiness調査（引用付き）、環境変数分類表、正確な残りUI手順、PR #15互換性確認、deploy workflow、検証結果、残課題を記載。

アプリのsourceコード（`src/**`）は無変更。DB migration/RPC/Edge Function/production設定への変更は0件。

### Netlify config/adapter/build decisions

- **Base directory = `apps/admin`**（Netlify UIで設定）。理由：repo rootにnpm workspaces定義なし（`package.json`に`workspaces`フィールドなし）、apps/adminは独立した`package.json`/`package-lock.json`を持つ自己完結アプリ（root Expoアプリの`react`は19.2.3、apps/adminの`react-dom`は19.2.8で別バージョン管理）であることを確認済み。Netlify公式monorepoドキュメントに基づき、この構成ではBase directoryをapps/adminに直接設定するのが正しいパターン。
- `@netlify/plugin-nextjs`は明示的にpinしない（Netlifyの推奨どおり、自動検出の最新adapterを使う）。
- `netlify.toml`はビルドtriggerもapps/admin配下の変更のみにスコープされる（Base directoryの既定挙動）。
- Deploy Preview / Production間で環境変数の差し替えは不要（単一Supabaseプロジェクトの公開情報を両方で共有）なので`[context.*]`overrideは追加していない。

### Netlify Next.js 16対応の調査結果（Phase 1の未検証リスクへの回答）

- Netlify公式docs：「Next.js 13.5以降の全バージョンをサポート、都度のstable releaseで互換性検証」（<https://docs.netlify.com/frameworks/next-js/overview/>）
- Netlify公式changelog「Next.js 16 is ready to deploy on Netlify」：zero configurationでdeploy可能と明記（<https://www.netlify.com/changelog/next-js-16-deploy-on-netlify/>）
- Netlify公式2026-08セキュリティchangelog：`next@16.3.3`以降への更新を推奨（本アプリは`16.3.4`で既に満たしている）（<https://www.netlify.com/changelog/2026-08-25-nextjs-security-vulnerabilities/>）
- **結論：Next.js 16.3.4自体はブロッカーではない。** Phase 1が「要事前確認」としていたリスクは解消。
- **新たに特定した、より狭い残リスク**：本アプリは`middleware.ts`ではなく`src/proxy.ts`（Next.js 16の改称後規約）を使用している。調査した範囲では、`proxy.ts`認識はNetlify側adapterのビルドバージョンに依存するとのコミュニティ報告があり、実際のNetlify Deploy Preview上での動作確認が推奨されている。ローカルの`next build`/`next start`では検証不可能。影響範囲は`src/lib/supabase/proxy.ts`のセッションcookie refreshのみ（fail-closedではなくfail-slow：`(admin)/layout.tsx`とServer Action内で認可は再チェックされるため、認証バイパスにはならない）。

### environment variable classification

`apps/admin/src`全体をgrepし、`process.env.*`参照は3件のみ確認（既存アーキテクチャ、今回変更なし）：

| 変数 | 分類 | 備考 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public/browser-safe | Preview/Productionで同一値 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public/browser-safe | anon/publishable key、RLS前提でクライアント露出前提 |
| `NODE_ENV` | framework built-in | 手動設定不要 |

server-only変数は**0件**（`service_role`/`SERVICE_ROLE`/`x_client_secret`/`openai_api_key`/`vault`/`oauth`をcase-insensitiveでgrepし0 hit、再確認済み）。`netlify.toml`に「これらを絶対に追加しないこと」と明記。値が欠けた場合は`getSupabasePublicConfig()`が例外を投げ、Previewは既存設計でfail closedになる（今回新たに追加した挙動ではない）。

### local build/test results

fresh origin/main（`08b8895`、その後`2794ff5`まで前進を確認したが`apps/admin`への影響なし）上、変更後の状態で再実行：

- `node --experimental-strip-types --test src/lib/*.test.ts`：**12/12 pass**（Phase 1の既存テストのまま、今回テスト追加・変更なし）
- `npx tsc --noEmit`：PASS
- `npm run lint`：PASS
- `npm run build`（dummy public Supabase envのみ）：PASS。出力は3 dynamic route + 2 static route + 1 Proxy(Middleware)でPhase 1と一致。
- `git diff --check`：PASS
- secret scan（`service_role`/`SERVICE_ROLE`/`x_client_secret`/`openai_api_key`/`vault`/`oauth`）：新規/変更ファイル含め0件（該当語は「追加禁止」という説明文中の変数名のみ）
- ビルド副生成物（`.next/`、自動regenerateされる`next-env.d.ts`のimportパス差分）はいずれも確認後に元へ戻し、diffに残していない

### actual Preview deploy result or exact external authorization blocker

**未実施。** Netlifyサイトの作成にはNetlifyアカウントでのinteractive認証（リポジトリ接続の認可）が必要で、このタスクの権限では実行できない。`netlify` CLIも本環境に未インストール・未認証であることを確認済み。

正確な残りUI手順（5ステップ）を`apps/admin/docs/phase2-netlify-deploy-preview.md`の「Exact remaining UI steps」に記載した：
1. Netlifyダッシュボードでリポジトリ接続
2. Base directory = `apps/admin` を設定
3. 環境変数2件（`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`）を設定（既存Vercel Productionと同じ公開値）
4. deploy contextはNetlifyの既定のまま（Production=デフォルトbranch、Deploy Preview=全PR）
5. サイト作成後、最初のPreviewで`proxy.ts`のセッションrefreshが実際に動作することを確認

### preview QA results

**未実施**（live Previewが存在しないため）。QA項目自体（brand切替、AI Lab非混在、Important News Kabumori限定、tamperedselector fail-closed等）はPR #15固有のもので、次のPreview確認時にPR #15を対象として実施することを推奨に記載。

### proof PR #15 semantics remain unchanged

- origin/mainとPR #15現在head（`b04442561d9e9c6d01b4a9fcf640c2cf731cd923`、pull refとしてread-only fetchし、作業branchとしては一切checkoutせず`git diff`のみで確認。確認後にローカルrefは削除済み）を`apps/admin`スコープで再diff。
- 差分は`apps/admin/src/**`の18ファイルのみ（前回G2 Reportの記載と完全一致）。
- **`netlify.toml`・`next.config.ts`・`package.json`・`package-lock.json`・`tsconfig.json`はPR #15とmainで完全に同一**（ビルド設定に一切差分なし）。
- PR #15で新規追加された3ファイル（`active-brand.ts`/`admin-brands.ts`/`brand-selector.tsx`）を直接grepし、新しい`process.env`参照が無いことも確認した。
- 結論：**PR #15はNetlifyサイト作成後、追加変更なしでDeploy Preview可能**。PR #15自体のmerge/production QAは今回のTASK範囲外のまま据え置き。

### Vercel production mutation = 0

Vercel設定・deploy・DNS/domain変更：0件。今回はNetlify側のrepository準備とdocのみで、Vercel Productionには一切触れていない。

### deferred PR #15 state

前タスクのとおり、PR #15はVercel rate limit解除待ちのまま**未merge**（head `b044425`は今回変更なし）。本TASKはPR #15をmergeも変更もしていない。Netlify Preview対応が確認できたら、別タスクとしてPR #15のfinal gateを再開する（次回はNetlify Previewでレビュー可能なため、Vercel rate limit解除を待たずにレビュー自体は進められる可能性がある——ただし最終production mergeの判断自体は既存の慎重な手順に従う）。

### remaining risks

1. **`proxy.ts`のNetlify上での実際の動作が未検証**（唯一の技術的な未解決リスク。live Deploy Preview作成後に確認必須）。
2. **live Netlify siteが存在しない**：本タスクで用意した内容はすべてsite作成後にそのまま使える設計だが、実際の動作確認はできていない。
3. PR #15のproduction merge continuationは引き続きdeferred（本タスクとは独立）。

### safety_checks

- 変更ファイルは`apps/admin/.gitignore`・`apps/admin/netlify.toml`・`apps/admin/docs/phase2-netlify-deploy-preview.md`の3件のみ（自スロットのTASK fileを除く）。
- DB migration/RPC/Edge Function/Cron/OAuth/Vault/token/production Vercel設定：変更0件。
- PR #15・selector semantics・ADMIN_BRANDS・admin/RLS boundary：変更0件（read-only diffで比較のみ）。
- secret露出：0件（scan結果は上記のとおり）。
- 他スロット（G1/G2/G3/H1/H2）の未コミット変更・TASK/Reportには触れていない。
- 共有control file（PROJECT_RULES.md/ORCHESTRATION.md/CURRENT_STATE.md/ACTIVE_TASK.md）は今回編集していない。
- G1/G2/G3の共有checkoutは使用せず、G4専用の独立worktreeのみで作業した。

### next_recommendation

1. Netlifyアカウントでの実際のサイト作成（上記5ステップ）を、権限を持つ人間またはinteractive認証が許可された別タスクで実施する。
2. 最初のlive Deploy Previewで`proxy.ts`のセッションrefreshが実際に動作することを確認する。
3. 確認できたら、PR #15のVercel-gate→merge→post-merge QAの継続タスクを別途再開する（Netlify Previewが使えることで、レビュー自体はVercel rate limit解除を待たずに進められる可能性がある）。

## Completion

- status -> review_required
- next_owner -> chatgpt
