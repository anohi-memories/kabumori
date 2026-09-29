# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-e2e-stage2-20260929
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: production account-deletion Stage 2。**使い捨てアカウントだけ**で実際の削除フローをE2E検証し、機能有効化前の最終runtime evidenceを作る。

## Accepted production basis

- Stage 1 migration apply/read-back: PASS
- `social-mobile-account-delete` Edge v1 ACTIVE / verify_jwt=true
- deployed source matches accepted repository source
- H2 production verification: target checks PASS
- C2 reconciliation: unrelated concurrent Function change was separately authorized; no deletion defect
- app feature flag remains OFF

## Mandatory startup

1. Read ORCHESTRATION / CURRENT_STATE / this TASK / latest G3 Stage 1 Report / latest H2 production verification / rollout runbook.
2. Fresh independent G3 worktree from latest origin/main.
3. Read current Supabase skill/changelog/docs.
4. Confirm no other slot is touching this migration/Edge/Auth/Vault/X OAuth boundary.
5. Re-run a bounded read-only production identity check before destructive E2E.
6. Use **only disposable test users/workspaces created specifically for this Stage 2**.

## Mandatory approval checkpoint

Before the first request that can actually:
- delete a valid Auth user,
- delete a Vault credential,
- revoke a real X token,

STOP and ask the user for explicit confirmation.

Do not treat the previous Stage 1 approval as approval for Stage 2 destructive E2E.

The confirmation prompt must summarize:
- only disposable accounts will be used,
- what production data/tokens will be created and then deleted/revoked,
- no existing real user/account/workspace is in scope,
- Apple remains excluded unless separately configured/approved.

## Stage 2 scenarios

After explicit user approval, execute in this order:

### E1 — never-connected disposable user
- create a disposable social-mobile test user through the supported public flow
- no X connection
- run preview/delete
- verify expected scope
- verify Auth/login/social workspace cleanup as designed
- verify audit result without leaking raw identifiers
- verify unrelated production data unchanged

### E2 — social-only behavior with Kabumori profile retained
- use a disposable identity with a deliberately created test main-profile condition
- verify deletion chooses social-only behavior
- social-mobile workspace/data removed
- shared Auth/main profile retained exactly as designed
- confirm no hidden cascade

Do not modify the real Kabumori app's account-delete implementation.

### E3 — X-connected disposable user
- create/connect a dedicated disposable X test account only if a safe disposable X account is available and explicitly approved
- verify exact credential ownership
- execute deletion
- verify X revoke path and Vault cleanup
- verify retry/idempotency
- verify no other social account/token/workspace affected

If no safe disposable X account is available, mark E3 BLOCKED and do not substitute a real account.

### E4 — lost-response/retry
- simulate/produce a safe client-side lost-response or repeated request condition on disposable state
- verify durable deletion state/checkpoints
- retry must converge safely without duplicate destructive effects or false success

### E5 — unrelated-data invariants
Before/after each scenario, verify only aggregate/identifier-safe invariants:
- unrelated workspace/account counts/identities unchanged
- no cross-tenant Vault effect
- no unrelated Auth/profile effect
- guard state/tombstone/audit semantics consistent

## Apple

Apple E2E is **not part of this task** unless production Apple configuration is separately approved and configured first.
Current expected behavior remains fail-closed for Apple-login deletion.

## Forbidden

- no existing real user deletion
- no existing production X account revoke
- no unrelated Vault secret mutation
- no X post
- no app feature activation
- no provider-console changes
- no migration/Edge source edits unless a defect is found and task is stopped
- no Kabumori main-app account-delete changes
- no legal copy invention

## Failure policy

If any destructive scenario behaves unexpectedly:
- STOP immediately
- do not continue to later scenarios
- preserve evidence
- do not attempt broad cleanup beyond the documented disposable-user recovery path
- do not enable feature flag.

## Completion / K3

Report:
- PASS / PARTIAL / FAIL / BLOCKED
- explicit user approval obtained? yes/no
- disposable identities only? yes/no
- E1 result
- E2 result
- E3 result or BLOCKED reason
- E4 result
- E5 invariant result
- Auth/Vault/X mutations actually performed on disposable fixtures
- any retries/recovery
- production state after cleanup
- confirmation no real user/account/workspace was touched
- remaining Apple/legal/Kabumori coordination gates
- whether feature activation is ready yes/no
- next recommendation

Then status -> review_required, next_owner -> chatgpt, STOP for K3.

推薦モデル：**Opus5.5（高）**

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- **result: BLOCKED**（破壊的な E2E を始める前に、リリースを止める欠陥を見つけたため、失敗時ルールに従って停止した。本番のデータへの変更は0件）。

### 実施したこと
- 開始時の fresh main: `3bdfef6`（`f7018a0` で in_progress 化）。
- 本番の同一性確認（読み取りのみ）:
  - migration の読み戻しは Stage 1 と一致（21関数の md5、クライアントからの EXECUTE 0、service_role の EXECUTE 10、trigger 11、行数0）。
  - Edge は `social-mobile-account-delete` ACTIVE / verify_jwt=true / version 1。デプロイ済みソースを download し、4ファイルとも受け入れ済みのソースとバイト単位で一致。
- 役割分担: Claude の安全ルールにより、本番サービスでのアカウント作成、パスワードでのログイン、X アカウントの接続、実データの完全削除は Claude からは実行できない。ユーザーの選択で「分担」とした（ユーザーが操作し、Claude は読み取りの検証と案内を担当）。
- 公開の Auth 設定（読み取り）: email は有効、sign-up は可能、メール確認が必要。Apple / Google / X ログインは無効。
- 前後比較用の集計スナップショット（件数とハッシュのみで、識別子や値は含まない）を取得した。
- ローカルの Web 開発ビルドを本番バックエンドにつないで起動した。削除フラグは、git の対象外の `.env.local` でローカルだけ有効にした。ログイン画面まで正常に表示されることを確認した。

### 見つかった欠陥（BLOCKER）
- `apps/social-mobile/src/features/onboarding/onboarding-gate.tsx` は、オンボーディングが終わっていない状態（X 接続待ち / 再接続 / エラー / 判定不能 / 新規アカウントの案内）では、アプリ本体の画面を表示しない。その画面には「ログアウト」しか無く、**アカウント削除への入口が無い**。
- 影響:
  1. 登録したが X を接続していない（または接続に失敗した）ユーザーは、アプリ内で削除できない。これは App Review 5.1.1(v) に反し、機能の有効化・リリースを止める。
  2. Stage 2 の E1 / E2 / E4 は、サポートされている UI では実行できない。
- 推奨する修正（UI だけの小さな変更、別 TASK）:
  - オンボーディングのすべての非完了画面に「アカウントの削除」への入口を置く。
  - 削除画面を、オンボーディングを通さずに表示できるようにする。
  - migration / Edge の変更は不要。サーバー側は、ワークスペースを持たないユーザーの削除にも対応済み。
  - 修正後は、UI のテストと実機での確認を追加する。

### 各シナリオの結果
- explicit user approval（破壊的な操作についての承認）: **未取得**（その段階の前に停止した）。
- disposable identities only: 使い捨ての ID はまだ作成していない。
- E1: **BLOCKED** / E2: **BLOCKED** / E4: **BLOCKED**（上記の欠陥）
- E3: **未実施**。使い捨ての X アカウントを使えるかは未確認。E1 から順に実行する方針のため、ここで停止した。
- E5: **PASS**。停止時点のスナップショットが開始時と一致した。auth users / profiles / ワークスペース / social_accounts の件数とハッシュ / Vault の件数と ID ハッシュ / tombstone 0 / audit 0 で、変化なし。投稿系の件数も減っていない。

### production mutations
- **0件**。Auth ユーザーの作成・削除、Vault の変更、X / Apple の失効、X 投稿、アプリの機能有効化は、いずれもしていない。
- 実在するユーザー / アカウント / ワークスペースには一切触れていない。

### repo 上の誤コミットとその訂正（正直に記録）
- ローカルの開発サーバーを起動したとき、expo-cli が `apps/social-mobile/.gitignore` に自動で追記した（`expo-env.d.ts` の行）。
- この差分があったため rebase が失敗し、報告を書き込む処理が走らなかった。そのまま `git commit -am` が、この `.gitignore` の追記だけを報告用のメッセージでコミットし、main に push してしまった（`f4d1fc7`）。
- 同じ内容をすぐに `git revert`（`0ff467d`）で取り消した。どちらの commit も main の履歴に残っている。ソース / migration / Edge への影響は無い。
- `expo-env.d.ts` は、ルートの `.gitignore` の対象で、追跡されていない。

### 後片付け
- ローカルの開発サーバーを停止し、`.env.local`（ローカル専用）を削除し、preview 設定に一時的に追加した項目を元に戻した。

### remaining gates
- 上記の欠陥の修正（G3 の小さな UI の TASK を推奨）→ Stage 2 の E2E をやり直す。
- E3 のための使い捨て X アカウントの用意と、その承認。
- Apple の本番設定と承認（現在は最初から拒否する状態）。
- legal: プライバシーポリシー / 規約 / 問い合わせ先、監査の保持期間、履歴の扱い、文言の確認。
- Kabumori の `account-delete` との調整（G1/G2）。
- feature activation ready: **no**

### next recommendation
- ChatGPT は、G3 に「オンボーディング中でもアカウントを削除できる入口」を追加する小さな修正 TASK を割り当てる（UI だけ）。
- その受け入れ後に、Stage 2 の E2E を再開する。E3 の前に、使い捨て X アカウントの有無を確認する。
- STOP for K3。
