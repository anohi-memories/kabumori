# Claude Task 2

- task_id: x-admin-multibrand-selector-query-parameterization-phase2-20260924
- owner: claude
- slot: claude-2
- status: done
- next_owner: none
- priority: high
- recommended_model: Opus 5.5
- purpose: K2 PASS済みPhase1 admin foundationを使い、apps/adminへ明示的なbrand selectorを配線し、現在Kabumori固定の4 query moduleを「server-sideで権限確認済みのselected brand_id」へ安全にparameterizeする。production mutationは0。

## Base

Phase1 merged on main:
- merge SHA: a9c0ef71954cdaa01e0ee7eb34bcd37dbcc6ec15
- admin-context.ts / tests / netlify.toml / design doc are on main
- current query modules still hardcode KABUMORI_BRAND_ID by design

## Mandatory fresh start

1. git fetch origin main
2. fresh origin/main
3. read ORCHESTRATION / CURRENT_STATE / this TASK
4. inspect H1/H2/G1 for overlap
5. inspect apps/admin/** drift since Phase1 merge
6. inspect current brand-boundary tests and all four target query modules

If another slot touches apps/admin/**, STOP.

## Scope A — selected-brand authority boundary

Implement a server-side helper that:
- derives user identity from supabase.auth.getUser()
- resolves AdminBrandAccess through the Phase1 resolver
- accepts a persisted/requested brand selector only as a selector, never as authority
- validates selected brand via canAccessBrand()
- fails closed on unauthorized/unknown selection
- preserves current Kabumori default for global admins unless an explicit valid selection is made
- for exactly-one scoped brand, defaults safely to that brand
- does not expose service-role or bypass RLS

Cookie/session/query storage may be used only if server-side revalidation occurs on every request.

## Scope B — brand selector UI

Add an explicit admin header selector that:
- shows only brands the current admin is authorized to access
- clearly displays active brand
- does not silently aggregate brands
- persists selection safely
- changing selection causes server-rendered data to reload
- unauthorized/tampered brand id cannot be honored
- no client-side direct DB authority is added

If brand display names require a DB read, use existing RLS-safe brands access only; do not add a new DB object in this task.

## Scope C — parameterize the four query modules

Safely replace hardcoded KABUMORI_BRAND_ID usage in:
- today-scheduled-posts.ts
- post-history.ts
- recent-failures.ts
- system-status.ts

Requirements:
- every function requires or receives an already-authorized brandId
- every relevant query keeps an explicit brand_id filter
- no unscoped fallback query
- no implicit global aggregate
- no query may accept an unvalidated raw client brandId
- types make the selected brand requirement obvious

## Scope D — system-toggle safety

Do NOT broaden generic mutation authority.

Audit whether existing system-toggle is safe to expose under selected brand context.
- If it is Kabumori-specific, keep it Kabumori-only and make UI state explicit.
- If safe parameterization can be done wholly inside apps/admin with existing RLS/allowlists and without shared backend changes, prepare a source candidate only with focused tests.
- If it would require new RPC/DB policy/shared backend, STOP at design/report for that part. Do not create the DB object.

## Scope E — tests

Update/replace brand-boundary tests so the invariant becomes:
- every operational query is explicitly brand-filtered
- selected brand must be server-authorized
- tampered selection fails closed
- global admin defaults to Kabumori unless selecting another valid brand
- scoped admin cannot select outside membership
- exactly-one scoped brand defaults correctly
- no cross-brand leakage in mocked query calls
- existing login/logout/auth denial behavior remains intact

Run:
- node tests
- tsc --noEmit
- lint
- Next build with public Supabase env only
- git diff --check
- secret scan

## Scope F — UX constraints

Keep the admin practical:
- selector in shared admin layout/header
- clear brand label on pages where data is scoped
- no duplicate selector per page
- preserve current routes and navigation
- mobile/basic responsive behavior should not regress

## Forbidden

- any production deploy
- Netlify site creation/configuration
- Vercel production change
- DB migration/RPC/view/Edge Function
- x-test-post/**
- Phase0/Phase1 queue work
- Cron/OAuth/Vault/token changes
- consumer mobile changes
- Important News changes
- cross-brand aggregate dashboard in this task

## Production mutation budget

0.

## Completion / K2

When complete:
- status -> review_required
- next_owner -> chatgpt
- append ## Report to this task

Report:
1. fresh source SHA
2. exact selected-brand authority flow
3. selector persistence method
4. changed files
5. query parameterization details
6. system-toggle decision
7. tests/build results
8. branch/commit/push/PR state
9. production mutation=0 proof
10. remaining backend contracts
11. next recommendation
12. fresh-origin verification

Then STOP for K2.

## Report

1. **fresh source SHA**
   - 着手時点のfresh `origin/main`: `009852a`（Phase1 merge `a9c0ef7` を含む）。
   - PR前に `708890e` へrebaseした。Phase1 merge以降、`apps/admin/**` のdriftはない。
   - H1（Important News caller-auth rollout）とG1（mobile release rollout）は `apps/admin/**` に触れない。
   - H2（CODEX_TASK_2）は `apps/admin/**` とG2を明示的にForbiddenにしている。
   - 以上から競合なしと判断した。

2. **selected-brand authority flow**
   - 流れ：`auth.getUser()`（identity）→ `resolveAdminBrandAccess()`（Phase1のauthority）→ cookieの値を読む（**selectorとしてのみ扱う**）→ `chooseActiveBrand({access, requestedBrandId, registry: ADMIN_BRANDS})`。
   - 候補は、code-owned allowlistの `ADMIN_BRANDS` を `canAccessBrand()` で絞り込んだもの。
     - 中身は `kabumori`/`yume_daka` と `ai_salaryman_lab`/`kaishain_ai_lab`。Mioは含めない。
     - code registryにした理由：現行RLSでは `brands`/`social_accounts` に admin SELECT policy がなく、global adminが0行になるため。新しいDB objectは作っていない。
   - 要求されたidが候補にあるときだけ、そのidを採用する。
   - 候補にないid（unknown/tampered/membership外）はfallbackして `selectionRejected=true` とする。
     - fallback先は、scopedかつ1ブランドならそのブランド。それ以外はKabumori（権限があれば）、なければregistry順の先頭。
     - rejectedの場合、ヘッダー下にwarningを表示する。
   - 候補が0件なら `no_brand` → `/unauthorized`（fail closed）。
   - 結果は `AuthorizedBrandId`（branded type）として返す。query moduleはこの型しか受け取らないため、生のcookie/form値はコンパイル時点で渡せない。
   - `getActiveBrandContext` は React `cache` を使い、per-requestで1回だけ解決する。
   - layoutは既存の `/login` → `admin_users` → `/unauthorized` のgateを変更していない。brand解決はその後に行う。
   - 各pageはlayoutと並列にrenderされるため、page側でも `requireActiveBrand()` で独自に解決・redirectする。
   - service_roleは不使用。RLSもbypassしていない。

3. **selector persistence method**
   - httpOnly cookie `kabumori_admin_brand` を使う（`sameSite=lax`、productionでは `secure`、`path=/`、30日）。
   - 書き込みはServer Action `selectAdminBrand` だけが行う。
     - `getUser` → `resolveAdminBrandAccess` → `chooseActiveBrand` を再実行する。
     - rejectedの場合は書き込まない。
     - 書き込み後に `revalidatePath("/", "layout")` を呼び、server-renderedのデータを再読込させる。
   - cookieはauthorityではない。毎requestで上記2の流れにより再検証する。

4. **changed files**（すべて `apps/admin/src/`）
   - 新規
     - `lib/admin-brands.ts`
     - `lib/selected-brand.ts`
     - `lib/active-brand.ts`
     - `lib/actions/select-brand.ts`
     - `app/brand-selector.tsx`
     - `lib/selected-brand.test.ts`
     - `lib/brand-query-isolation.test.ts`
   - 変更
     - `app/(admin)/layout.tsx`
     - `app/(admin)/page.tsx`
     - `app/(admin)/posts/page.tsx`
     - `app/(admin)/important-news/page.tsx`
     - `app/globals.css`
     - `lib/today-scheduled-posts.ts`
     - `lib/post-history.ts`
     - `lib/recent-failures.ts`
     - `lib/system-status.ts`
     - `lib/actions/system-toggle.ts`
     - `lib/brand-boundary.test.ts`

5. **query parameterization details**
   - `getTodayScheduledPosts(supabase, brandId: AuthorizedBrandId)`
     - `scheduled_posts` と `post_execution_logs` の両方に `.eq("brand_id", brandId)`。
   - `getPostHistory(supabase, brand: ActiveBrand, limit)`
     - `post_execution_logs`、`scheduled_posts`、report runs（morning/close/us_premarket）のすべてを brand filter する。
     - **修正**：report runsは従来brand filterなしだった。
     - X URLは `brand.xHandle` から組み立てる。Kabumoriは従来どおり `yume_daka`。
   - `getRecentFailures(supabase, brandId)`
     - `post_execution_logs`、`morning_report_runs`、`scheduled_posts` を brand filter する。
     - **修正**：`morning_report_runs` は従来brand filterなしだった。
   - Important News（`important_news_candidates` に `brand_id` 列なし＝Kabumori専用）
     - active brandがKabumoriのときだけ読む。
   - `getSystemStatus(supabase, brandId)`
     - Kabumori：従来の8項目の表示を維持する。`posting_windows` は `brandId` でfilterする。
       - singleton settings（important_news_monitor / morning・close・us_premarket report / useful_tip）はKabumori分岐でのみ読む。
     - 他ブランド：当該brandの `posting_windows` を post_type 別に集計し、read-onlyで表示する。toggleなし・Kabumori設定の読み取りなし・scope noteの明示あり。
   - 4 moduleすべてで、hardcodeされていた `.eq("brand_id", KABUMORI_BRAND_ID)` はゼロになった。
   - unscoped fallback queryもcross-brand aggregateもない。
   - Dashboard
     - page説明に `{brand.label}` を表示する。
     - 他ブランドでは重要ニュースカードを「かぶモリ専用」表示にし、queryを発行しない。
   - `/posts`：brand labelを表示する。
   - `/important-news`：「かぶモリ専用」と表示し、他ブランド選択中は読まずに案内だけを出す。
   - Important NewsのFunction/DB/ロジック自体は無変更で、admin側の表示gateだけを変えた。

6. **system-toggle decision**
   - Kabumori専用のまま据え置いた。mutation authorityは広げていない。
   - toggle UIが出るのはKabumori選択時だけ。他ブランドでは `toggles: []` にし、read-onlyであることをnoteで明示する。
   - **狭める修正**：`setPostingWindowFlag` の `posting_windows` のread/updateに `.eq("brand_id", KABUMORI_BRAND_ID)` を追加した（従来は `post_type` のみでfilterしていた）。
     - brandはserver側に固定しており、client/cookie由来ではない。
     - 現時点の本番では、AI Labの行は `brand_post` のみで重なりはない。ただし将来AI Labが同じpost_typeを持つと他ブランドの行を更新できてしまう潜在バグで、これを塞いだ。
   - brand-scoped toggleの提供には、brand-scoped RPC/policyが必要になる。design止めとし、DB objectは作っていない（10参照）。

7. **tests/build results**
   - `node --experimental-strip-types --test src/lib/*.test.ts`：**31/31 pass**。
     - `selected-brand.test.ts`（8件）
       - global adminはKabumoriがdefault
       - 有効な選択は採用
       - tampered/unknownはfallback+rejected
       - scoped adminはmembership外を選べない
       - scopedで1ブランドならdefault
       - registry外membershipは無視
       - 0件ならno_brand
       - registryのallowlistが完全一致
     - `brand-boundary.test.ts`（9件、source不変条件）
       - 全operational queryがパラメータのbrandでfilterされている
       - KABUMORI hardcode filterがない
       - toggleのposting_windowsがKabumori固定
       - layoutの `/login` と `admin_users` によるdenialが、brand解決より前にある
       - cookie書き込みがre-authorizationの後にある
     - `brand-query-isolation.test.ts`（7件、recording fake clientによる挙動テスト）
       - AI Labでは全queryが `brand_id=ai_salaryman_lab` になり、Kabumori専用tableを読まない
       - Kabumoriでは従来挙動（`yume_daka` URL、Important News、8項目）を維持する
     - `admin-context.test.ts`（Phase1、7件）
   - mutation確認：brand filterを1つ外すと3件failし、戻すと31/31 passに戻った。
   - `npx tsc --noEmit`：0。
   - `npm run lint`：0。
   - `npm run build`（dummyのpublic Supabase envのみ）：成功。build後に `.env.local` は削除し、`next-env.d.ts` はrevertした。
   - `git diff --check`：0。
   - secret scan（service_role / sb_secret / JWT / password / api key / token）：0 hit。

8. **branch/commit/push/PR state**
   - branch：`admin-multibrand-selector-phase2-20260924`
   - commit：`6c23227`
   - push：済み
   - PR：https://github.com/anohi-memories/kabumori/pull/15（open、**未merge**。mergeは別のmerge-only taskで行う）

9. **production mutation=0 proof**
   - production deploy、Netlify/Vercelの変更、DB migration/RPC/view/policy、Edge Function、Cron/OAuth/Vault/token：いずれも実施なし。
   - 本番への接続なし（本TASKのsource作業は完全にlocal）。
   - 変更は `apps/admin/src/**` のみ。`x-test-post/**`、`supabase/**`、mobileには触れていない。

10. **remaining backend contracts**
    - `brands`/`social_accounts` への admin SELECT policy：code registry `ADMIN_BRANDS` をDB由来に置き換えるために必要。
    - brand-scoped admin（`admin_users` にいない membership owner/admin）にappの入口を開けるかは、明示的な判断が必要。
      - 現在の入口gateは `admin_users` のみで変更していない。
      - 開ける場合は、`admin_select_*`/`admin_update_*`（`private.is_admin()` = 全brand）policyのbrand化レビューが前提になる。
      - 現状、brand境界はapp側の `.eq("brand_id")` のみで、RLSはglobal adminに全brandを見せる。
    - 他ブランド向けtoggle：brand-scoped RPC/policyが必要。
    - cross-brand aggregate view：本TASKでは対象外。

11. **next recommendation**
    - K2でPR #15をreviewする。PASSなら、merge-only taskでmergeし、Netlifyのpreview/本番反映は別task・別承認で行う。
    - 反映後の実機QAの確認点：
      - global adminでKabumoriとAI Labを切り替え、データが混ざらないこと
      - DevToolsでcookieを改ざんするとwarning付きでKabumoriにfallbackすること
      - AI Labでtoggleが出ないこと
    - その後、10の admin SELECT policy と brand-scoped policy の設計taskへ進む。

12. **fresh-origin verification**
    - 報告直前に `git fetch` し、origin/mainは `bf1e93e`（H2 queue関連のみ、`apps/admin/**` の変更なし）だった。
    - PR branchは `708890e` を基点としており、`apps/admin/**` での競合はない。
    - 報告commitは本TASK fileと `ACTIVE_TASK.md` のClaude slot 2の欄だけを更新する。


## Final K2 — 2026-09-24

PASS.

Review findings:
- Scope is confined to `apps/admin/src/**`; no DB migration/RPC/view/Edge Function, x-test-post, Cron, OAuth/Vault/token, consumer mobile, Important News backend, Netlify/Vercel production setting, or production deploy was changed.
- The selected-brand boundary is server-side and fail-closed: identity from `auth.getUser()`, authority from `resolveAdminBrandAccess()`, cookie only as a selector, and `chooseActiveBrand()` revalidates against the code-owned registry and current authority before producing an `AuthorizedBrandId`.
- Tampered/unknown/out-of-scope selections are not honored; zero authorized options redirects to unauthorized.
- Query modules remain explicitly brand-filtered; no unscoped fallback or cross-brand aggregate was introduced. Important News is gated to Kabumori because its table has no brand_id.
- `system-toggle` remains Kabumori-only; its posting_windows mutation was narrowed with an explicit Kabumori brand filter, reducing future cross-brand mutation risk.
- Test/build evidence accepted: 31/31 node tests PASS, tsc PASS, lint PASS, Next build PASS, git diff --check PASS, secret scan clean, production mutation 0.
- Independent compare confirms the PR branch is now 5 commits behind current main, but those five commits modify only .agent control files; there is no `apps/admin/**` drift since branch base `708890e`. The source candidate remains semantically reviewable, but the stale head should still be freshened before merge.
- PR #15 remains open and unmerged as intended.

Next recommendation:
1. create a merge-only G2 task to freshen/rebase PR #15 onto current main;
2. rerun the 31 tests + tsc/lint/build/diff/secret scan;
3. merge only if the apps/admin diff remains semantically identical;
4. after merge, keep Netlify preview/deploy and any DB policy work as separate gates.
