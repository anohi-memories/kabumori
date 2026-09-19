# Claude Task 2

- task_id: social-mobile-app-phase8-completion-followup-claude-20260919
- owner: claude
- slot: claude-2
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Opus 5
- purpose: Codex slot 2から一時引き継ぎ。Phase 8で既にPASS済みのtenant RLS isolation proofを前提に、残っている mobile/local sign-in QA、profile lifecycle正本確認、test fixture cleanupだけを安全に完了させる。

## User instruction

2026-09-19、ユーザーは「今日の夜までこでさんを休ませたい。いったんくろちゃんにこの先を振って」と指示。

したがって:
- このsocial-mobile workstreamはClaude slot 2が一時担当。
- Codex slot 2はidle。
- 同じsocial-mobile Phase 8対象をCodexと並行変更しない。
- 完了確認はK2。

## Proven state / do not redo

既に本番で以下は確認済み:
- non-admin Auth userをDashboard正規経路で1件作成済み。
- non-admin userは `admin_users` 非所属。
- non-admin userに `ai_salaryman_lab / viewer` membership 1件。
- authenticated + RLS enabledのread-only proofで:
  - brand_memberships: ai_salaryman_lab = 1
  - brands: ai_salaryman_lab = 1
  - social_accounts: ai_salaryman_lab = 1
  - scheduled_posts: ai_salaryman_lab = 24
  - post_execution_logs: ai_salaryman_lab = 46
  - posting_windows: ai_salaryman_lab = 10
  - kabumori = 0
  - mio = 0
- cross-tenant leakage = 0
- client-side brand filterに依存せずtenant isolationを実証済み。
- existing global-admin policy pathは未変更。
- authenticatedのbrand_memberships INSERT/UPDATE/DELETE grantは無し。
- mobileは `auth.getUser()` + self-scoped `brand_memberships`、fail-closed。
- production default `EXPO_PUBLIC_DATA_SOURCE=mock` 維持。
- isolated worktreeで typecheck/lint/Expo export/static policy 5/5/git diff --check PASS。

**上記RLS proofを再実施・再変更しない。**

## Remaining scope only

### 1. mobile/local client sign-in QA

目的:
- 新しいnon-admin QA userを、実際のsocial-mobile client pathでsign-inして動作確認する。

要件:
- local/dev環境だけで `EXPO_PUBLIC_DATA_SOURCE=supabase` を明示。
- production default envは変更しない。
- credential/token/passwordをTASK/Report/commit/logへ残さない。
- service_role禁止。
- signed-out -> auth required
- signed-in non-admin + membership -> ai_salaryman_lab tenantだけread
- kabumori / mioの表示・取得 0
- no-membership -> blocked/no-workspace contract維持
- unavailable / permission denied / schema mismatch分類維持
- silent mock fallback禁止
- scheduled_postsのaccount/body/origin gapは推測で埋めない

実credentialがClaude実行環境から使えない場合:
- 勝手に取得/推測しない。
- local clientで必要な正確なユーザー操作手順まで作成。
- その部分だけユーザー手動QA待ちとして明記してよい。

### 2. profile lifecycle source-of-truth

現状:
- auth.users=2
- admin_users=1
- profiles=1
- 新しいnon-admin QA userにはprofile rowが無い。

調査:
- `profiles` のschema/FK/RLS/trigger
- auth.users作成triggerの有無
- signup/login時にprofileを作るRPC/Edge Function/app codeの有無
- apps/social-mobileがprofile rowを必要としているか
- apps/admin/既存株アプリ側のprofile lifecycleと混同しない

判断:
- social-mobileにprofile不要なら「不要」を根拠付きで確定。
- 必要なら正規onboarding経路を設計する。
- このtaskでは推測INSERTやproduction profile補完を勝手にしない。
- schema変更が必要ならcandidateだけ作り、production applyはK2後。

### 3. test fixture cleanup

現在のtest fixtures:
- non-admin QA user × ai_salaryman_lab/viewer membership
- old global-admin user × ai_salaryman_lab/viewer canary membership

cleanup原則:
- QAが済んだfixtureは削除を優先。
- membershipはexact test rowだけ。
- Auth user削除はSupabase Dashboard/Authの正規経路のみ。
- direct `auth.users` DELETE/INSERTは禁止。
- admin_users、本番brand/social_accounts/admin policyを絶対に触らない。
- safety reviewやtool承認で拒否されたら迂回しない。

Claudeから正規削除経路を実行できない場合:
- ユーザー向けにDashboardでのexact cleanup手順を作る。
- 何を消し、何を残すか明確にする。
- 削除前後のexpected row countを明記する。

## Verification

最低限:
- fresh origin/main
- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- this TASK
- `.agent/tasks/CODEX_TASK_2.md`
- G1/H1 current tasks
- production read-only metadata where needed

実装/QA後:
- npm ci --ignore-scripts など lockfile準拠のinstall only
- package/lock変更なし
- npm run typecheck PASS
- npm run lint PASS
- Expo Web export / route resolution PASS
- static policy contract PASS
- git diff --check PASS

## Production boundary

変更禁止:
- RLS / admin policies / grants / schemaの既存本番変更
- migration history repair/reconcile
- blind db push
- OAuth/Vault
- x-test-post / market-report / daily_content_plans
- Cron/settings
- AI/X/Push/Storage/課金
- production default `EXPO_PUBLIC_DATA_SOURCE=supabase`
- service_roleをmobile bundleへ含める

cleanup以外のproduction writeは原則0。

## Completion / K2

完了時:
- this TASK -> `review_required`
- next_owner -> `chatgpt`
- `## Report` に以下:
  1. mobile/local sign-in QA結果
  2. profile lifecycle正本
  3. cleanup結果 or exact manual cleanup手順
  4. tests
  5. changed files
  6. production mutation一覧
  7. production default mock維持確認
  8. 次Phase（X OAuth login onboarding）へ進める条件
  9. exact commit/push/read-back

push前にfresh `origin/main` を確認。
他workstreamの未コミット変更には触れない。
完了後STOPしてK2待ち。

## Report

- result: 残り3項目のうち、profile lifecycle正本確認は完了、mobile sign-in QAは自己検証可能な範囲まで実施し実credentialでの最終確認をユーザー手動待ちとして明記、test fixture cleanupは1件（old global-admin canary membership）を試みたが実行がsafety reviewでブロックされたためユーザー確認待ち。RLS isolation proof自体は再実施・再変更していない。production mutationは0件（DELETE試行は未実行のままブロック）。

### 1. mobile/local client sign-in QA

- 手順: isolated worktree（`/private/tmp/.../kabumori-socialmobile-work`）で`apps/social-mobile`に対し`npm ci --ignore-scripts`（package/lock無変更）。ローカル限定の`.env.local`（gitignore対象、コミットしない）に本番Supabase URLと`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`（publishable/anon key。secretではない）+ `EXPO_PUBLIC_DATA_SOURCE=supabase`を設定。production側の既定値（mock）は一切変更していない。
- `npx expo start --web --port 8090`で実際にアプリを起動し、Browserパネルで実際に操作して以下を実写で確認:
  - **signed-out**: ログイン画面が表示され、認証必須（fail-closed）。モックデータへのフォールバックなし。
  - **無効credential**: 実在しないメールアドレス+ランダムパスワードでログイン試行 → 実本番Supabase Authが400を返し、「メールアドレスまたはパスワードを確認してください。」を表示。console/network双方でservice_role・token等の値は一切表示されず。この応答文言と400ステータスは、`auth-provider.tsx`の実装がmockではなく実Supabase Authに到達していることの動作証跡（静的検査だけでなく実runtime証跡）。
- **未実施（ユーザー手動待ち）**: 実際の非admin QA userの実credentialによるsign-inと、その後`ai_salaryman_lab`のみが表示され`kabumori`/`mio`が一切出ないことの確認。Claude実行環境には当該credentialが無く、取得・推測もしていない。

  **ユーザー向け手順**:
  1. `cd apps/social-mobile`
  2. `cp .env.example .env.local`
  3. `.env.local`に本番の`EXPO_PUBLIC_SUPABASE_URL`と`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`を設定（既存の`kabumori`アプリの`.env`と同じ値でよい）、`EXPO_PUBLIC_DATA_SOURCE=supabase`を追加
  4. `npm ci`
  5. `npm run web`（ブラウザが開く）
  6. 非admin QA userのメールアドレス・パスワードでログイン
  7. 確認項目: ワークスペースとして`ai_salaryman_lab`のみ表示される / `kabumori`・`mio`の文言やデータが一切出ない / エラー時は「読む権限が確認できません」等の分類済みメッセージが出て、モックデータに切り替わらないこと
  8. 確認後、`.env.local`を削除するかそのままローカルに残してよい（production設定には影響しない）

### 2. profile lifecycle source-of-truth — 確定

- read-onlyで`profiles`のスキーマ・RLS・FK・トリガーを確認: `public.profiles`は`profiles_insert_own`ポリシーによりRLS配下で**クライアント自身がINSERTする**設計で、`auth.users`に対するサーバー側トリガーは存在しない（`pg_trigger`で`auth.users`上の非internalトリガー0件を確認）。
- コード調査: `src/lib/auth.ts`（**メインのkabumori消費者アプリ**、`apps/social-mobile`でも`apps/admin`でもない）の`ensureProfile()`が、`signInWithEmail`/`signUpWithEmail`の中で「無ければinsertする」形でprofile行を作成している。これがprofile作成の唯一の主体。
- `apps/social-mobile`のソース全体を検索した結果、`profiles`への参照は**皆無**（`auth.getUser()` + `brand_memberships`のみを使用）。`apps/admin`にも`profiles`参照なし。
- read-only production確認（件数のみ、識別子は記録せず）: `profile_rows_that_are_admin=1`（既存のprofile行はadmin userのもの）、`auth_users_without_profile=1`、`auth_users_that_are_nonadmin=1` — つまりprofileを持たない唯一のユーザーは、まさに新規non-admin QA userであり、理由は「メインkabumoriアプリにサインインしたことがないため`ensureProfile()`が一度も呼ばれていない」ことで完全に説明できる。
- **結論（根拠付きで確定）: `apps/social-mobile`にはprofile rowは不要。** profile lifecycleはメインkabumoriアプリ固有のonboarding仕組みであり、social-mobileのtenant境界モデル（`auth.users` + `brand_memberships`）とは無関係。推測INSERTやproduction補完は一切行っていない。

### 3. test fixture cleanup

現状のfixture（read-onlyで再確認、識別子は非記録）:
- non-admin QA user × `ai_salaryman_lab/viewer` membership（2026-09-18 06:48作成）
- old global-admin canary × `ai_salaryman_lab/viewer` membership（2026-09-18 04:57作成）

判断:
- **old global-admin canaryのmembership行は今すぐ削除してよいと判断**（Phase 6/7時点の実験用で、real non-admin proofに完全に置き換えられており、admin userは`admin_users`/`private.is_admin()`経由で既に全アクセス権を持つためこの行は不要）。対象1行だけに絞ったdry-run（`brand_id='ai_salaryman_lab' and role='viewer' and user_id in (select user_id from admin_users)`）で該当1件のみを確認した上でDELETEを実行しようとしたが、**safety reviewにより実行がブロックされた**（理由ラベルは`[Cloud Storage Mass Delete]`だが、実際は単一行のデータDELETEで規模の話ではない）。ブロック後、迂回は一切試みていない。**production mutation = 0**（DELETE未実行）。
- **non-admin QA userのmembership/Auth userは今回あえて削除しない**: 上記1のmobile sign-in QAがまだユーザー手動で未完了であり、先に削除するとそのQAに必要なfixtureそのものを壊してしまうため。「QAが済んだfixtureは削除を優先」の原則に従い、QAが済んでいないこちらは温存する判断。

**ユーザーへの確認事項**:
- (a) old global-admin canary membership 1行の削除について、私が再実行してよいか明示的に許可いただくか、Supabase Dashboard（Table Editor → `brand_memberships`）で`role='viewer'`かつadmin_usersに属するuser_idの行（1件のみ）を手動削除してください。削除前後の期待件数: `brand_memberships`は削除前2件→削除後1件（non-admin QA userの分だけ残る）。
- (b) non-admin QA userのmembership + Auth userそのものの削除は、上記1のsign-in QAが完了してから、あらためて別タスクでDashboardの正規Auth削除経路（Authentication → Users → 該当ユーザー削除）を使うことを推奨します。

### tests

isolated worktreeで実施（package/lock変更なし、`git status`は`.claude/launch.json`新規作成と`apps/social-mobile/.gitignore`へのexpo-cli自動生成分のみで、いずれもcommit/pushしていない使い捨てworktree内の変更）:
- `npm run typecheck` PASS
- `npm run lint` PASS（0 errors/warnings）
- `node docs/phase4-policy-matrix.test.mjs` static policy contract 5/5 PASS
- `npx expo export --platform web` PASS
- `git diff --check` PASS
- 上記に加え、実際に`expo start --web`でアプリを起動し、Browserパネルで signed-out表示 / 無効credential拒否 / secret非露出 を実機動作で確認（静的検査に加えた実行時証跡）

### changed files

このタスクで`apps/social-mobile`のソースコードへの変更は0件。使い捨てisolated worktree内でのみ`.env.local`（ローカル限定、gitignore対象、非コミット）を作成し、`npm ci`実行に伴うexpo-cli自動生成の`.gitignore`追記が発生したが、いずれもcommit/pushしていない。

### production mutation一覧

- 0件。read-onlyのSQL確認（`auth.users`/`admin_users`/`profiles`/`brand_memberships`の件数・関係性、`pg_trigger`）のみ実施。
- membership DELETE 1件を試みたがsafety reviewによりブロックされ未実行。

### production default mock維持確認

- 確認済み。`.agent`/production設定・`apps/social-mobile`の`.env.example`いずれも`EXPO_PUBLIC_DATA_SOURCE=mock`が既定のまま。今回の`.env.local`はisolated worktree内のローカルファイルのみで、productionには一切影響しない。

### 次Phase（X OAuth login onboarding）へ進める条件

1. ユーザーによる非admin QA userの実credential sign-in QA完了（本Reportのユーザー向け手順を実行）
2. 上記QA完了後、non-admin QA user本体とそのmembershipのcleanup（Dashboard正規経路）
3. old global-admin canary membership 1行のcleanup（上記(a)の許可または手動削除）
4. 以上が揃った時点で、tenant境界・profile lifecycle・fixture状態がすべてクリーンになり、X OAuth login onboarding実装に安全に着手できる

### exact commit/push/read-back

- コード変更なしのため、application repositoryへのcommit/pushは無し。
- `.agent/tasks/CLAUDE_TASK.md`本Reportをこのタスク完了報告としてorigin/mainへpushする。
