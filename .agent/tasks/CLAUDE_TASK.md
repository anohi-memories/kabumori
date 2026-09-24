# Claude Task 2

- task_id: x-admin-multibrand-selector-phase2-merge-only-20260924
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5.5
- purpose: K2 PASS済みのPR #15（admin multibrand selector Phase2）を最新mainへfreshen/rebaseし、apps/admin/**の意味的差分がレビュー済みcandidateと同一であることを確認し、tests再実行後にPR #15だけを安全にmergeする。Netlify deployやDB policy変更は行わない。

## Reviewed candidate

- PR: #15
- branch: `admin-multibrand-selector-phase2-20260924`
- reviewed commit: `6c23227`
- K2 verdict: PASS
- current known branch lag at K2: 5 commits behind main, all in `.agent/**`, no `apps/admin/**` drift

## Mandatory fresh start

1. `git fetch origin main`
2. fresh `origin/main`
3. read `.agent/ORCHESTRATION.md`
4. read `.agent/CURRENT_STATE.md`
5. read this TASK
6. inspect H1/H2/G1 scope overlap
7. compare PR #15 branch against fresh main
8. inspect any `apps/admin/**` changes since reviewed base

If latest main contains nontrivial overlapping `apps/admin/**` changes, STOP and report exact files. Do not auto-resolve semantic conflicts.

## Allowed

- rebase/freshen PR #15 branch onto fresh main
- resolve trivial control-file-only ancestry drift
- rerun full Phase2 admin tests/build checks
- update PR head
- merge PR #15 only after verification
- post-merge read-back

## Forbidden

- any new Phase2 feature
- selector behavior changes
- adding/removing brands from ADMIN_BRANDS
- DB migration/RPC/view/policy
- Netlify site creation/deploy
- Vercel production change
- x-test-post/**
- queue/idempotency work
- Cron/OAuth/Vault/token changes
- consumer mobile changes
- Important News backend changes
- cross-brand aggregate dashboard

## Required verification before merge

- diff remains restricted to the reviewed `apps/admin/src/**` Phase2 files
- selected-brand authority flow unchanged
- explicit brand filters remain on all operational queries
- Important News remains Kabumori-only
- system-toggle remains Kabumori-only and posting_windows update remains brand-filtered
- no service-role/X/OpenAI/OAuth secrets introduced
- node tests: 31/31 expected or higher only if main added unrelated tests
- `npx tsc --noEmit` PASS
- `npm run lint` PASS
- `npm run build` PASS using public Supabase env only
- `git diff --check` PASS
- secret scan clean
- fresh compare immediately before merge

## Merge policy

- do not merge stale reviewed head directly
- use normal PR merge or equivalent reviewed merge
- pin/verify the exact freshened head before merge
- if rebase changes Phase2 semantics, STOP for K2 instead of merging

## Post-merge

Fresh-read `origin/main` and verify:
- all reviewed Phase2 files match freshened head
- no unrelated `apps/admin/**` files were changed
- no production settings changed
- PR #15 merged and closed
- production mutation 0

## Production mutation budget

0.

## Completion / K2

When complete:
- status -> `review_required`
- next_owner -> `chatgpt`
- append `## Report`

Report:
1. fresh main SHA
2. drift/conflict findings
3. freshened PR head
4. exact changed files
5. tests/build results
6. PR #15 merge result + merge SHA
7. post-merge file read-back
8. production mutation=0
9. remaining risks
10. next recommendation
11. fresh-origin verification

Then STOP for K2.

## Report

結果：**freshenと全検証はPASS。ただしmergeは保留（未実施）。** 唯一のcheckであるVercelが `failure — Deployment rate limited — retry in 24 hours` になっている。repoの先例（PR #8 / #9：Vercel rate limit中はmergeせず、bypassもしない）に従って停止した。

1. **fresh main SHA**
   - 着手時：`9965a6f`。
   - in_progress commitの後：`3c3a0e4`。
   - 報告直前に再fetchし、`3c3a0e4` のまま変化なしを確認した。

2. **drift/conflict findings**
   - reviewed base（`708890e`）から現在のmainまでの間に、`apps/admin/**` の変更は**0件**（`git log 6c23227..origin/main -- apps/admin` が空）。
   - 差分は `.agent/**` のcontrol fileだけで、rebaseはconflictなしで完了した。
   - 兄弟スロットとの重なりもない。
     - H1（caller-auth rollout）：`apps/admin` 対象外。
     - H2（CODEX_TASK_2）：`apps/admin/**` をForbiddenに明記。
     - G1：done。

3. **freshened PR head**
   - `b278c047a296375d0f96b6f4ec03db31a176144d`（parentはmain `3c3a0e4`）。
   - pushは `--force-with-lease` で、expectedを `6c232271ed67f66f78b97d39a33c412a34d972d5` に固定した。
   - `git range-diff 708890e..6c23227 origin/main..b278c04` は `=`（patch同一）。
   - `git diff 6c23227 b278c04 -- apps/admin` は0行で、**意味差分なし**。
   - authority関連の4ファイル（`admin-brands` / `selected-brand` / `active-brand` / `actions/select-brand`）は、reviewed版とbyte単位で同一。

4. **exact changed files**
   - main..head の差分は `apps/admin/src/**` の18ファイルだけで、reviewed candidateと完全に一致する。
   - `important-news/page.tsx`、`(admin)/layout.tsx`、`(admin)/page.tsx`、`posts/page.tsx`、`brand-selector.tsx`、`globals.css`、`actions/select-brand.ts`、`actions/system-toggle.ts`、`active-brand.ts`、`admin-brands.ts`、`brand-boundary.test.ts`、`brand-query-isolation.test.ts`、`post-history.ts`、`recent-failures.ts`、`selected-brand.test.ts`、`selected-brand.ts`、`system-status.ts`、`today-scheduled-posts.ts`。

5. **tests/build results**（freshened head `b278c04` で実施）
   - node tests：**31/31 pass**。
   - `npx tsc --noEmit`：PASS。
   - `npm run lint`：PASS。
   - `npm run build`（dummyのpublic Supabase envのみ）：PASS。build後に `.env.local` は削除し、`next-env.d.ts` はrevertした。
   - `git diff --check`：PASS。
   - secret scan（service_role / sb_secret / JWT / OpenAI / X secret / password / api key / token）：0 hit。
   - 不変条件の再確認：
     - 4 moduleのbrand filterはすべてパラメータの `brandId` / `brand.id`：`today` 2件、`post-history` 3件、`recent-failures` 3件、`system-status` 3件。
     - Important Newsの取得はKabumoriのときだけ（`post-history:190`、`recent-failures:162`、`system-status:477`）。
     - system-toggleの `posting_windows` のread/update（2件）は `KABUMORI_BRAND_ID` で固定されている。

6. **PR #15 merge result + merge SHA**
   - **未merge**。PRはOPEN、headは `b278c04`、`mergeable=MERGEABLE`、`mergeStateStatus=UNSTABLE`。
   - 保留の理由：
     - Vercelのcheckがrate limitでfailureになっており、freshened headに成功したVercel build/previewが存在しない。
     - mainにbranch protectionはなく、技術的にはmergeできる。しかし先例はVercelのcheckをrequired扱いにしており、failure中のmergeやbypassはしていない。
     - PR #8の報告にあるとおり、mainへのmergeはadminのVercel Productionへの自動deployを引き起こす。未検証のままProductionへ反映される状態は避けた。
   - merge SHA：なし。

7. **post-merge file read-back**
   - merge未実施のため対象外。
   - 代わりにpre-mergeのread-backを実施した：freshened headの `apps/admin` とreviewed `6c23227` の差分は0。

8. **production mutation=0**
   - merge、Vercel/Netlifyの変更・deploy、DB/RPC/policy、Edge Function、Cron/OAuth/Vault/token：いずれも実施なし。
   - 変更したのは、PR branchのrebase pushと `.agent` control fileだけ。

9. **remaining risks**
   - Vercel rate limitの解除待ち（約24時間）。解除前にmainへ別のcommitが入るとPRは再びbehindになる。ただし `apps/admin` 以外の変更なら意味差分なしのrebaseで済む。
   - merge時にadminのVercel Productionが自動更新され、Phase2（brand selector）が本番の管理画面に反映される。
     - このTASKのForbiddenにある「Vercel production change」と、mergeに伴う自動deployとの関係について、明示的な判断を推奨する。先例（PR #8 / #14）では、自動deployは許容として扱われている。
   - 反映後のQA確認点：切替時にデータが混ざらないこと、cookie改ざん時にfallbackすること、AI Labでtoggleが出ないこと。

10. **next recommendation**
    - Vercelのrate limitが解けた後に、本TASKを再度 `ready` にして再開する。手順：
      1. mainと比較し、`apps/admin` のdriftがないことを確認する（必要ならfreshen）。
      2. Vercelのcheckが `pass` になることを確認する。
      3. `gh pr merge 15 --merge --match-head-commit <verified head>` でmergeする。
      4. post-mergeのread-backを行う。
    - 自動のVercel Production deployを許容するかどうかも、K2で明示してほしい。

11. **fresh-origin verification**
    - 報告直前に `git fetch` した：origin/mainは `3c3a0e4`。
    - `b278c04..origin/main` の間に `apps/admin` の変更は0件。PR #15 のheadは `b278c04` のまま。

### Addendum — Vercel retry (2026-09-24 ~04:00 UTC)

- ユーザー指示「リトライしてみて」を受け、`apps/admin` の中身を変えずにcommitだけ作り直して再pushし、Vercelを再トリガーした。
  - freshened headは `b04442561d9e9c6d01b4a9fcf640c2cf731cd923`（base：main `a2e2480`）。
  - `apps/admin` の差分は `b278c04` 比・reviewed `6c23227` 比ともに0行。main..headの差分は `apps/admin/src/**` の18ファイルのみ。
- 結果：Vercelは再び `failure — Deployment rate limited — retry in 24 hours`。**PR #15はmergeしていない**（OPEN、head `b044425`）。
- **操作ミスとその復旧**（本番への影響なし）：
  - 再pushの1回目で作業用worktreeが消えていたため、コマンドがメインcheckoutで実行された。
  - その結果、ローカル `main` のHEAD `e9cb57f` の日付だけがamendされて `1e2d228` になり（treeは同一）、PR branchへforce pushされた。
  - 数十秒以内に、PR branchを `--force-with-lease`（expectedは `1e2d228`）で `b278c04` へ戻した。ローカル `main` の参照も `e9cb57f` に戻した。
  - rebaseは未commitの変更を検出して中断しており、ユーザーの未commit作業（working tree/index）には一切影響していない。origin/mainにも影響していない。
- production mutation：0。
- 次：Vercelのrate limitが解けた後（直近の失敗status：`b044425`、約04:00 UTC）、同じ手順でcheckの `pass` を確認してからmergeする。
