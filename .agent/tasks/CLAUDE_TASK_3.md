# Claude Task 3

- task_id: x-social-mobile-account-deletion-onboarding-entry-fix-20260930
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: high
- recommended_model: Sonnet5（高）
- purpose: onboarding未完了でもaccount deletion画面へ到達できるよう、social-mobileのUI/navigationだけを修正する。

## Required
- X接続待ち、再接続、接続エラー、判定不能、新規アカウント案内などのonboarding未完了状態から削除導線を表示。
- Homeへ到達していなくてもaccount-deletion routeを開けること。
- 削除導線はsecondary actionとして表示。
- feature flag OFF時の表示は正直に維持。
- recent-auth、confirmation、session pinningは変更しない。

## Do not change
- migration
- Edge Function
- RPC
- Auth/Vault/X/Apple backend
- production config
- feature activation

production_mutation=0.

## Tests
- onboarding incomplete states expose deletion entry
- deletion route opens without Home
- feature-disabled behavior remains truthful
- existing onboarding/login/deletion tests
- typecheck/lint
- Expo web+iOS export
- diff check

## Completion / K3
Report changed_files, covered states, route behavior, tests, commit/push/PR, production_mutation=0, and whether Stage 2 E2E can resume.
Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Report

- 実行モデル: Sonnet 5.5（ユーザーが切り替えたもの。TASK の推奨は Sonnet5（高））
- **result: PASS**（UI だけの修正。本番への変更は0件）
- PR: **#59**（https://github.com/anohi-memories/kabumori/pull/59）、branch `claude/g3-onboarding-deletion-entry`、head `2a5fab88ddad660f8c359465c67c4aadcbc6ed00`（main `b5185d1` から分岐）

### covered states
- オンボーディング未完了のすべての画面に、副次の操作「アカウントの削除について」を表示するようにした:
  - 状態確認中（loading）、エラー、判定不能（ambiguous）
  - X 接続待ち、接続の再開、再接続（connect_x / reconnect_x）
  - 設定の案内（settings）
  - 新規アカウントの案内
- 完了後（Home 以降）は、これまでどおり「ログイン方法」画面と削除ルートから到達できる。

### route behavior
- 入口を押すと、Home を経由せずに、既存のアカウント削除画面（`/account-deletion` と同じ画面）が gate の中に表示される。「‹ 戻る」で元のオンボーディング画面に戻る。
- 削除画面は Home 用の provider に依存しないので、Home に到達していなくても動く。
- 削除画面を開いた状態は、開いたユーザーだけのもの。ユーザーを切り替えても引き継がれない。
- 変更していないもの: 直近の再ログイン、「削除する」の入力、ユーザーとセッションへの固定（session pinning）、機能が無効のときの「準備中」表示。機能フラグは OFF のまま。
- migration / Edge / RPC / Auth / Vault / X / Apple / 設定は、いずれも変更していない。

### changed_files
- `apps/social-mobile/src/features/onboarding/onboarding-gate.tsx`
- `apps/social-mobile/tests/onboarding-deletion-entry.test.mjs`（新規）

### tests
- 新規6件: 実際の gate（`onboarding-gate.tsx`）を、React / RN / データをスタブにして描画するテスト。
  - 未完了の全7状態で入口が出て、Home にならないこと。
  - 新規アカウントの案内画面にも入口があること。
  - 入口から削除画面が開き（Home なし）、戻るで元の画面に戻ること。
  - ユーザー切替で引き継がれないこと。
  - 完了後は従来どおりアプリを表示すること。
  - 削除画面が Home 用の provider に依存せず、ガード（再ログイン・入力・固定・準備中）が残っていること。
- `npm test` 78/78、data-view 14/14、typecheck OK、lint OK、Expo export web/ios とも成功、`git diff --check` OK、機密情報スキャン OK。
- 変異テスト 5/5 検出（主画面の入口削除、案内画面の入口削除、ユーザー単位の解除、入口が何もしない、戻るが何もしない）。

### production_mutation
- **0件**。開発サーバーも今回は起動していない（前回のような自動編集は発生していない。コミットは明示したファイルだけ）。

### Stage 2 E2E can resume?
- **はい**。この PR を受け入れてマージすれば、E1（一度も接続していないユーザー）と E2、E4 を、サポートされた画面から実行できる。
- 再開前の条件は変わらない: 破壊的な操作についてのユーザーの明示的な承認、使い捨てアカウントのみ、E3 は使い捨ての X アカウントが必要（無ければ BLOCKED のまま）。
- 機能フラグ（`EXPO_PUBLIC_ACCOUNT_DELETION_ENABLED`）は OFF のまま。有効化は E2E と legal gate の後。
- STOP for K3。
