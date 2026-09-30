# Claude Task 3

- task_id: x-social-mobile-pr63-merge-native-e3-resume-20260930
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- accepted_pr: PR #63
- accepted_head: 5f2eae26bb1ee60c2bd7c7885c06816e86e8d852
- purpose: C1 PASSを受けてPR #63を安全にmergeし、ネイティブ版でE3（X接続済み使い捨てユーザー）のStage 2 E2Eを再開する。

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest H1 report.
2. Use independent G3 worktree/checkout.
3. Fresh fetch origin/main and PR #63.
4. Confirm exact head remains `5f2eae26bb1ee60c2bd7c7885c06816e86e8d852`, mergeable, with no newer unreviewed commit.
5. Confirm G4 x-test-post rollout does not overlap PR #63 source paths.
6. If head/source scope changed, STOP.

## Phase A — merge PR #63

If exact head remains unchanged:
- merge PR #63 using normal repository merge method
- record merge SHA
- fresh-read main and confirm accepted source is present
- no unrelated PR merge

## Phase B — native E3 preparation

Prepare a local/native iOS development or simulator build from fresh main with:
- bundle-safe static public env values
- explicit `EXPO_PUBLIC_DATA_SOURCE=supabase`
- existing public Supabase URL/key only
- no service_role/secret in client
- temporary/local bundle identifier only if required; do not commit it
- no production source/config mutation

Verify before any destructive action:
- native app is using real Supabase data, not mock
- onboarding/X-connect entry is reachable
- only the approved disposable social-mobile identity/X account is used
- existing real users/accounts/workspaces are excluded
- Apple remains excluded

The user performs credentials, X login/consent and other interactive provider steps.

## Phase C — E3 connection checks

Using the disposable X account only:
- complete X connection if supported by the local native build
- read-only verify the expected disposable social account/workspace/token-reference state
- do not reveal tokens or Vault plaintext
- do not post to X

## Mandatory STOP gate before deletion/revoke

Before the first action that can:
- delete the disposable social-mobile account
- revoke the disposable X authorization/token
- mutate Vault credentials as part of deletion

**STOP and obtain fresh explicit user approval in the conversation.**

Prior approval is not sufficient for this resumed destructive step.

## Production restrictions

Before that fresh approval:
- no account deletion
- no X revoke
- no Vault mutation
- no real X post
- no provider-console changes
- no feature activation

## Completion / K3

If blocked before the approval gate, report the blocker.
If ready for destructive E3, report:
- merge SHA
- native real-data proof
- disposable-only X connection proof
- exact next destructive operation requiring approval
- unrelated-data invariant snapshot
- feature remains OFF
Then status -> review_required, next_owner -> chatgpt, STOP for K3.


## Merge confirmed by ChatGPT/GitHub connector

- PR #63 has been squash-merged successfully.
- accepted head: `5f2eae26bb1ee60c2bd7c7885c06816e86e8d852`
- merge commit: `2648f38ac3a0e3421dbd6104b46c44dbd009b6d8`
- merged_at: 2026-09-30T11:32:04Z
- do NOT retry the merge.

### Continue authorization

Continue this existing G3 task from **Phase B — native E3 preparation** using fresh `origin/main` that contains merge commit `2648f38ac3a0e3421dbd6104b46c44dbd009b6d8`.

You are authorized to:
- prepare the local/native iOS development or simulator build from fresh main
- use existing public Supabase URL/publishable or anon client key only
- set `EXPO_PUBLIC_DATA_SOURCE=supabase`
- verify the app is using real Supabase data and X-connect is reachable
- use only the approved disposable social-mobile identity/X account
- perform read-only state verification after X connection

You are NOT authorized yet to:
- delete the disposable social-mobile account
- revoke the disposable X authorization/token
- mutate Vault credentials through deletion
- make a real X post
- activate the feature

Before the first destructive delete/revoke/Vault action, STOP and request fresh explicit user approval exactly as the TASK requires.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- **result: BLOCKED（承認ゲートの手前で停止）**
  - 用意された「使い捨て X アカウント」は、本番で**すでに接続済みの投稿用 X アカウント**だった（`X_ACCOUNT_ALREADY_CONNECTED`）。
  - 本物の使い捨て X アカウントが無いため、E3 には進めない。
- 本番への破壊的な操作: **0件**（アカウントの削除、X の失効、Vault の変更、X 投稿、機能の有効化は、いずれもなし）。

### Phase A — PR #63
- head が受け入れ済みの `5f2eae2` のままで、マージ可能、ほかの PR との重なりなしを確認した。
- Claude によるマージは、auto mode の安全判定（Merge Without Review）で拒否されたため、ユーザーに依頼し、ユーザーがマージした。
- merge SHA: **`2648f38ac3a0e3421dbd6104b46c44dbd009b6d8`**。main の social-mobile の src / tests が、受け入れ済みの head と完全に一致することを確認した。

### Phase B — ネイティブで実データにつながることの証明
- 最新の main から、ローカルの iOS シミュレーター用 Release ビルドを作った。
  - 一時的な bundle id はローカルの `app.config.js` だけで使い、コミットしていない。
  - `.env.local` は git の対象外で、中身は公開 URL と publishable キー、`EXPO_PUBLIC_DATA_SOURCE=supabase`。secret や service_role は含まない。
- 結果: モック（「かぶモリ公式」）ではなく、**実データのオンボーディング「Xアカウントとつなげましょう」**が表示された。D1 の修正の効果を実機相当の環境で確認できた。
- 「Xで認証する」からの接続開始は、本番で成功した（使い捨ての E2 ユーザーのワークスペース、X アカウントの行（authorization_pending）、OAuth state が作られた）。
- オンボーディングの画面から「アカウントの削除について」の入口が見えることも確認した（PR #59 の効果）。

### Phase C — X 接続の結果（ブロッカー）
- ユーザーが X にログインして許可した後、接続は `HTTP 400 X_ACCOUNT_ALREADY_CONNECTED` で拒否された。
  - 原因の特定: ローカル限定の診断表示で内部のエラーコードを出した。この診断用の変更は元に戻し、コミットしていない。
  - 意味: 許可した X アカウントが、本番の既存の投稿アカウント（3件）のどれかとして、すでに接続済みである。
- `social_accounts (platform, platform_user_id)` の一意制約で拒否されたため、トランザクション全体がロールバックされ、何も保存されていない。
- 読み取りでの確認:
  - Vault の件数と ID ハッシュは基準値のまま。
  - 既存の接続済み X アカウント3件は、状態・更新時刻・エラーのどれも変化なし。
  - 自動更新の状態は idle のまま。
  - E2 ユーザーのアカウントは authorization_pending のままで、トークン無し。
- 付随する事象（正直に記録）: X は「許可」の時点で、その X アカウント用に新しいトークンの組を発行している。サーバーは保存前に拒否したので、どこにも保持されていない（失効させることもできない。アクセストークンは期限で失効する）。X 側でアプリの許可を取り消すと、本番の既存の投稿アカウントの接続も切れるので、X 側の操作はしないようユーザーに伝えた。

### unrelated-data invariant snapshot（Phase B 開始前との比較）
- 同じ: Auth ユーザー数 / profiles / 既存 brands のハッシュ / Vault の件数と ID ハッシュ / refresh_state / tombstone / 監査。
- 変化: `u_` ワークスペース +1、membership +1、social_accounts +1（ハッシュの変化はこの行の追加による）。すべて、E2 の使い捨てユーザーの接続開始で作られた、接続待ちの行（トークン無し）。

### ローカルの後片付け
- シミュレーターのテストアプリをアンインストールした。一時ファイル（`ios/`、`app.config.js`、`.env.local`）を削除し、`package.json` の自動編集と診断用の変更を元に戻した。作業ツリーはきれいな状態。

### 本番に残っている使い捨てのもの
- E2 の使い捨てアカウント（ログインとかぶモリの profile）と、今回できた social のワークスペース / X アカウントの行（接続待ち）/ OAuth state。本物の使い捨て X アカウントで E3 を行えば、E3 の削除でワークスペース側は消える。

### feature
- `EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED` は OFF のまま。

### exact next destructive operation (not approved, not started)
- 本物の使い捨て X アカウント（本番のどの投稿アカウントにも接続されていない、新しく作った X アカウント）で E3 の接続をやり直す。
- その後、X の失効と Vault の削除を伴う削除を行う（social_only の範囲）。**この直前に、改めてユーザーの承認が必要。**

### next recommendation
- ユーザー（またはオペレーター）が、本当に新しい使い捨て X アカウントを用意する。本番で使っている X アカウントは絶対に使わない。
- 用意できたら、同じ手順（ネイティブビルドの作り直しに約20分）で E3 を再開する。
- STOP for K3。
