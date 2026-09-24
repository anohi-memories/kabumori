# Claude Task 2

- task_id: x-admin-netlify-thin-control-plane-phase1-20260924
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Opus 5.5
- purpose: X自動投稿本番rollout(H2)と競合しない別系統として、apps/adminをNetlify Free向けのthin management UIへ安全に近づける設計・source candidateを進める。Supabaseをexecution/control planeの正本とし、Netlifyへsecretや重いbackground処理を持たせない。

## Scope boundary

Claude G2 owns only:
- apps/admin/**
- admin-specific tests/docs/helpers
- source-only admin-facing Supabase RPC/Edge API design documents/tests when actual DB object creation is not required

G2 must NOT touch:
- supabase/functions/x-test-post/**
- Phase0/Phase0b/Phase0c migrations
- posting_windows/scheduled_posts/publish_claims DDL
- Cron
- OAuth/Vault/token logic
- important-news caller-auth scope owned by H1
- consumer mobile Auth/settings scope owned by G1
- production Netlify/Vercel settings
- any production deploy/migration

If a required implementation would need a DB migration/RPC or shared Function that overlaps another slot, stop at design/source-candidate boundary and report the exact proposed object for later dedicated ownership.

## Goal

Prepare the admin app for this target:

Netlify admin UI
→ Supabase Auth / RLS / narrow admin RPC/Edge APIs
→ Supabase DB / Cron / Edge Functions
→ X API

Netlify should remain a thin authenticated UI. No X API secret, service-role key, OAuth token, or OpenAI key in browser or Netlify client bundle.

## Work

1. Inventory current apps/admin server dependencies:
   - Server Components
   - Server Actions
   - next/headers cookies
   - proxy.ts/session refresh
   - force-dynamic pages
   - revalidatePath
   - Supabase reads/writes
2. Classify each path:
   - can remain Netlify-supported SSR
   - can become RLS-safe browser read
   - should move to narrow authenticated Supabase RPC/Edge Function
   - must remain server-side
3. Design multibrand admin context:
   - explicit active brand/account selector
   - no cross-brand leakage
   - admin_users vs brand_memberships authority separation
   - safe aggregate operational views
4. Implement only non-conflicting apps/admin source candidates that improve:
   - brand/account context structure
   - route separation
   - typed admin data access boundary
   - confirmation UX for dangerous operations
   - no arbitrary table/column mutation from client
5. Netlify readiness:
   - verify Next.js 16/OpenNext compatibility from source
   - define required public env vars
   - identify runtime function consumption
   - prepare netlify config candidate only if safe and source-only
   - no Netlify project creation
6. Tests:
   - unauthenticated/admin denial
   - brand isolation in UI/data-access mocks
   - no service-role/X/OAuth secrets in client bundle/source
   - build/typecheck/lint where available
7. Report exact remaining backend RPC/Edge endpoints needed later, but do not create overlapping production DB objects.

## Product requirements

- management UI only on Netlify
- Supabase owns DB/Cron/Edge/X execution
- current Vercel Production remains untouched until later canary
- no automatic paid plan
- no production publish controls without explicit confirmation and server-side authorization
- preserve existing admin functionality unless intentionally isolated behind a source-only candidate

## Production mutation budget

0.

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- append ## Report to this file
- include changed_files, tests, commit/push, exact admin architecture, Netlify readiness, remaining backend contracts, safety checks, and next recommendation
- STOP for K2

## Report

- result: Phase A（サーバー依存インベントリ）・Phase B（multibrand admin context設計）・Phase C（限定的なsource candidate実装）を完了。実装候補はレビュー用ブランチへpush済み。production変更0件。

### changed_files

- `apps/admin/docs/phase1-netlify-thin-control-plane.md`（新規、設計文書）
- `apps/admin/netlify.toml`（新規、source-only候補。Netlifyサイトの作成・設定・デプロイは一切していない）
- `apps/admin/src/lib/admin-context.ts`（新規、`resolveAdminBrandAccess`/`canAccessBrand`）
- `apps/admin/src/lib/admin-context.test.ts`（新規、7テスト）
- `apps/admin/tsconfig.json`（`allowImportingTsExtensions: true`を追加。型チェック専用の設定でnoEmitは既にtrueのため、Next.jsのビルド・実行時解決には影響しない）

既存の4つのデータ取得ファイル（`today-scheduled-posts.ts`/`post-history.ts`/`recent-failures.ts`/`system-status.ts`）・`system-toggle.ts`・全pageファイルは無変更。

### exact admin architecture（読み取り専用インベントリの要点）

- **Server Components**: 全ページ + `(admin)/layout.tsx`。データ取得は注入された`SupabaseClient`経由のみ。
- **Client Components**: 3つのみ（`login-form.tsx`, `logout-button.tsx`, `system-status-list.tsx`）。いずれも自前でテーブルを読まない。
- **Server Action**: `system-toggle.ts`の1ファイルのみ。固定allowlistでtable/columnを限定し、クライアントから任意のtable/column書き込みは不可能な設計。admin_users所属も自前で再チェック。
- **秘密情報**: `apps/admin/src`全体で`SERVICE_ROLE`/`service_role`の参照は**0件**。全Supabaseクライアント（browser/server/proxy）が公開のpublishable keyのみ使用。secretがブラウザ/Netlifyバンドルに含まれるリスクは、今回何かを変更するまでもなく**既存アーキテクチャの時点で解消済み**だった。
- **`proxy.ts`**（Next.js 16でmiddleware.tsから改称）: セッションcookieのrefreshのみ担当。認可判定自体は`(admin)/layout.tsx`が担う。

### Netlify readiness

- `npm run build`（Next.js 16.3.4, Turbopack）・`npx tsc --noEmit`・`npm run lint`いずれもpublicな環境変数（`NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`）のみでクリーンに成功。ビルド出力は3 dynamic route + 2 static route + 1 Proxy(Middleware)で、Netlify Next.js Runtimeが前提とする形と一致。
- **唯一の要確認リスク**: Next.js 16.3.4は非常に新しいため、NetlifyのNext.js Runtimeが現時点でこのメジャーバージョンをサポート範囲に含めているかは、本タスクでは外部ライブ確認手段がなく未検証。実際のデプロイ前に必ずNetlify公式ドキュメントで確認が必要（doc内に明記、断定的な互換性主張はしていない）。
- それ以外（service-role不使用、Node専用APIの不使用、標準的な`@supabase/ssr`のcookieベースセッション）はソースレベルで既にNetlify互換と確認済み。

### 残バックエンドcontract（未作成、報告のみ）

1. 既存4データ取得ファイルのbrand_id parameterization（`KABUMORI_BRAND_ID`定数を選択済み・`canAccessBrand`検証済みのbrand idへ置き換え）— 新規DB objectは不要だが、safety-tested既存ファイル・テストに触れるため別レビューとして意図的に今回は見送り。
2. brand selector UI（`(admin)/layout.tsx`への追加）— 新規DB object不要。
3. global admin向けcross-brand集計ビュー — 形状未確定、実装するなら新規view/RPCが必要（担当slot要検討）。
4. 既存`system-toggle`allowlist以外の将来的な管理操作 — 広げるのではなく専用の狭いRPCを推奨（原則の記録のみ）。

いずれもDB migration/RPC/共有Function作成はスコープ境界に従い今回実施していない。

### security model / multibrand設計

`admin_users`所属＝global admin（全brand操作可）、`brand_memberships`の`owner`/`admin`ロール＝brand-scoped admin（該当brandのみ）と定義し、`resolveAdminBrandAccess`で両方を読み取り、`userId`は必ず`auth.getUser()`由来（クライアント指定値を信用しない）、読み取り失敗時はglobalへフォールバックせず`{kind:"scoped", brandIds:[]}`にfail-closed。既存の`brand-boundary.test.ts`（Kabumori限定の5テスト）は一切変更せず、この新モジュールもまだどのページにも配線していない（配線は安全性テストの書き換えを伴う別レビュー対象として意図的に先送り、doc §3に明記）。

### tests

- `node --experimental-strip-types --test src/lib/*.test.ts`: **12/12 pass**（既存5 + 新規7）。
- `npx tsc --noEmit`: エラーなし。
- `npm run lint`: エラー・警告なし。
- `npm run build`: 成功（public env varsのみ）。
- `npm ci --ignore-scripts`後、`package.json`/`package-lock.json`に変更なし。

### production mutation = 0 confirmation

0件。Netlifyサイトの作成・設定・デプロイなし。DB migration/RPC/Edge Function/production Vercel設定への変更なし。既存の4データ取得ファイル・`system-toggle.ts`・全pageファイルは無変更。

### safety checks

- スコープ境界（`supabase/functions/x-test-post/**`, migrations, Cron, OAuth/Vault, important-news caller-auth, consumer mobile Auth, production Netlify/Vercel設定）はいずれも未変更。
- 他slot（H1/H2/G1）の作業ディレクトリ・タスクファイルには触れていない。
- 秘密情報をコード・Report・commitに一切含めていない。

### next recommendation

1. この設計・candidateのレビュー（K2）
2. 承認後、§3の「brand selector配線」を別タスクとして着手（既存safety-testedクエリファイル+テストの書き換えを伴うため独立レビュー推奨）
3. 実際のNetlifyサイト作成前に、Next.js 16.3.4に対するNetlify公式のサポート状況を確認
4. cross-brand集計ビューの形状を決定してから実装slotを割り当て

### exact commit/push/read-back

- ブランチ`admin-netlify-thin-control-plane-phase1-20260924`、コミット`3505269`をpush済み（mainへは未マージ、レビュー待ち）。
- `.agent/tasks/CLAUDE_TASK.md`本Reportをorigin/mainへpushする。


## Final K2 — 2026-09-24

PASS.

Review findings:
- Scope stayed within `apps/admin/**`; no x-test-post, Phase0 migrations, Cron, OAuth/Vault, Important News, consumer-mobile, Netlify/Vercel production configuration, or production DB object was changed.
- Source candidate is intentionally non-wired: existing Kabumori-only query filters remain unchanged, so this phase does not weaken the current brand-isolation invariant.
- `resolveAdminBrandAccess` cleanly separates global `admin_users` authority from scoped `brand_memberships` owner/admin authority; membership read errors fail closed to zero scoped brands and no client-provided brand/user selector is trusted by this module.
- Existing admin source still contains no service-role/X/OpenAI/OAuth secret dependency; the Netlify candidate uses only public Supabase envs.
- Tests/build evidence accepted: 12/12 node tests PASS, tsc PASS, lint PASS, Next build PASS, production mutation 0.
- Independent review of current Netlify official docs confirms modern Next.js support is via OpenNext for Next.js 13.5+ and the adapter is tested with every stable Next.js release; App Router, SSR, RSC, Server Actions, Middleware, Turbopack and revalidation are supported. Netlify currently lists Node.js 24 as the default build version, so `NODE_VERSION=24` is compatible with current docs.
- The candidate branch is currently 17 commits behind main. This is not a correctness failure because its changed files are isolated to `apps/admin/**`, but it MUST be freshly rebased/fresh-checked before any merge. Do not merge the stale head directly without conflict/drift review.
- No Netlify site creation/deploy is authorized by this K2.

Next recommendation:
1. fresh-rebase the admin branch onto current main and re-run the same tests;
2. merge only after no `apps/admin/**` drift/conflict is found;
3. then create a separate G2 task for brand-selector wiring + parameterizing the four Kabumori-hardcoded admin query modules while preserving server-side `canAccessBrand` checks;
4. Netlify preview/site creation remains a later explicit production/external-action gate.
