# Claude Task 3

- task_id: x-social-mobile-native-data-source-and-delete-ux-fix-20260930
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Sonnet5（高）
- purpose: Stage 2 E2Eで見つかったrelease blockers D1-D3をsource-onlyで修正し、ネイティブE3再開可能な状態にする。

## Accepted Stage 2 result
- E1 PASS
- E2 PASS
- E4 PASS
- E5 PASS
- E3 BLOCKED
- existing real users/accounts were not touched
- deletion feature remains OFF

## D1 — native data source selection
Fix the native Expo data-source selection so production/release native builds do not silently fall back to mock when the intended public data-source env is set.

Requirements:
- use Expo-compatible static public env access consistent with the existing Supabase env pattern
- make repository-selection and data-provider agree on the same source
- preserve explicit mock mode for development/tests
- fail truthfully/safely for invalid or missing configuration; do not silently pretend real data is available
- do not change Supabase project, Auth, RPC, migration, Edge Function, OAuth backend, or production settings

## D2 — account deletion completion UX
- web must visibly confirm successful account deletion/social-only deletion before or while returning to login/onboarding
- do not rely only on React Native Alert for web
- preserve native behavior and existing deletion protections

## D3 — signup feedback
- web signup must show a truthful acknowledgement/in-progress/success state so repeated clicks are discouraged
- prevent accidental duplicate submission while a signup request is in flight
- do not claim email was sent unless the request actually succeeded

## Tests
Add/update tests proving:
- native production-style env selects real repository when configured
- native mock mode still works explicitly
- invalid/missing config behaves safely
- repository-selection and provider cannot disagree
- web delete completion feedback is visible
- signup has visible state + duplicate-submit protection
- existing Auth/onboarding/deletion tests remain green
- typecheck/lint
- Expo web+iOS export
- git diff --check
- secret scan

## Production constraints
No production deploy/config mutation.
No real X post/revoke.
No real user deletion.
Do not run E3 in this task.
production_mutation=0.

## Completion / K3
Report PASS/FAIL, changed_files, D1-D3 behavior, tests, commit/push/PR, production_mutation=0, and whether native E3 can resume.
Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Report

- 実行モデル: Sonnet 5.5（ユーザーが切り替えたもの。TASK の推奨は Sonnet5（高））
- **result: PASS**（source のみ。本番への変更は0件）
- PR: **#63**（https://github.com/anohi-memories/kabumori/pull/63）、branch `claude/g3-native-data-source-delete-ux`、head `5f2eae26bb1ee60c2bd7c7885c06816e86e8d852`

### D1 — ネイティブ版のデータソース選択（重大）
- 原因: `selectDataSource(env = process.env)` が、`process.env` のオブジェクトごと渡して `EXPO_PUBLIC_DATA_SOURCE` を読んでいた。ネイティブのバンドルでは、静的に書かれたプロパティ参照以外は埋め込まれないため、iOS / Android では常にモックになっていた。
- 修正:
  - `repository-selection.ts` が、静的なプロパティ参照（`process.env.EXPO_PUBLIC_…`）でまとめた値を使う（`supabase.ts` と同じパターン）。
  - `data-provider.tsx` の初期状態も、同じモジュールの `initialDataStatus()` から求める。両者は同じ判定を共有するので、食い違わない。
  - 判定は純粋な関数 `dataSourceMode`（新規 `data-source-mode.ts`）にした:
    - `supabase` だけが実データ。
    - 未設定・空・`mock` は明示的なプレビュー（開発用）。
    - それ以外の値（タイプミス等）は blocked と正直な理由で拒否する（以前は黙ってモックになっていた）。
    - Supabase の設定が欠けていれば blocked。
- 実際の `expo export --platform ios`（Metro キャッシュを消して実行）で確認した: 設定値を渡さなければ何も埋め込まれず、渡せば URL とキーが埋め込まれる。

### D2 — 削除完了の通知
- サーバーが削除を確定した後、ログイン画面に、見えて閉じられる通知を出す。ログイン用アカウントがどうなったかを正確に書く:
  - 完全に削除: 「アカウントを削除しました。ご利用ありがとうございました。」
  - このアプリのデータだけ削除: 「…ログイン用アカウントと『かぶモリ』のデータは残っています。」
- web には `Alert` の表示が無いので、Alert だけに頼らない。ネイティブの Alert は維持している。
- 失敗のときは通知を出さない。次にサインインしたセッションが現れたら消える。
- 直近の再ログイン、確認の入力、ユーザーとセッションの固定は変更していない。

### D3 — 新規登録のフィードバック
- メールのフォームに、進行中の表示（「登録しています…」とスピナー）を追加した。
- 同じタイミングでの二重の押下は、同期的に防ぐ（ref による保護。state の更新は非同期のため）。
- 登録に成功したら、目立つ「送信しました」の通知を出し、ボタンを60秒間「送信済み（あとN秒で再送できます）」にして再送を抑える。
- 「送信した」と表示するのは、リクエストが実際に成功した後だけ。失敗のメッセージは、赤い枠で目立たせる。
- メッセージ欄は読み上げにも対応（alert ロール）。

### changed_files
- `apps/social-mobile/src/data/data-source-mode.ts`（新規）、`src/data/repository-selection.ts`、`src/providers/data-provider.tsx`
- `apps/social-mobile/src/domain/auth-submit.ts`（新規）、`src/components/auth-screen.tsx`、`src/providers/auth-provider.tsx`
- テスト: `tests/data-source.test.mjs`（新規）、`tests/auth-submit.test.mjs`（新規）、`tests/auth-boundary-regression.test.mjs`、`tests/account-deletion.test.mjs`
- migration / Edge / RPC / Auth / Vault / X / Apple / 本番設定は、いずれも変更していない。

### tests
- `npm test` 89/89、data-view 14/14、typecheck OK、lint OK、Expo export web/ios とも成功、`git diff --check` OK、機密情報スキャン OK、src に console 出力なし。
- 新規・追加のテストの内容:
  - ネイティブ版と同じ条件（静的に埋め込んだ値、`process.env` 自体は空）で、実データが選ばれる。
  - 明示的なモック、未設定は、モックのまま。
  - 不正な値や設定の欠落は、安全に blocked になる。
  - 選択とプロバイダーの初期状態が、どの値でも食い違わない。
  - `src` に動的な `process.env` の参照が無い。
  - 削除の完了通知が出て、閉じられ、次のサインインで消える（失敗時は出ない）。
  - 新規登録の各状態と、二重押下の防止。
- 変異テスト 10/10 検出（D1 の動的な env、不正値のモック化、プロバイダーの直接参照、タイプミスの許容、D2 の通知の未設定・残存・表示の削除、D3 のガード削除・成功前の「送信済み」・クールダウン削除）。
- 開発サーバーは今回は起動していない（`.gitignore` の自動編集は発生していない）。コミットは明示したファイルだけ。

### production_mutation
- **0件**。本番の Auth / DB / Edge / 設定には触れていない。実ユーザー・X の失効・投稿も、いずれもなし。E3 は、この TASK では実施していない。

### native E3 can resume?
- **はい**。この PR をマージすれば、ネイティブ版で実データに接続でき、オンボーディングから「Xで認証する」に到達できる。
- E3 の再開条件は変わらない: ネイティブの開発ビルドを作り直す（ローカルの一時的な bundle id、リポジトリには入れない。`.env.local` に本番の公開設定を入れる。数分〜十数分）。使い捨ての X アカウントでユーザーが認証する（承認済み）。X の失効を伴う削除の直前に、改めてユーザーの承認を得る。
- 機能フラグは OFF のまま。有効化は E3・Apple・legal gate の後。
- STOP for K3。
