# Claude Task 3

- task_id: x-social-mobile-account-deletion-prod-e2e-stage2-resume-20260930
- owner: claude
- slot: claude-3
- status: review_required
- next_owner: chatgpt
- priority: critical
- recommended_model: Opus5.5（高）
- purpose: PR #59でonboarding deletion entryを修正・mergeしたため、Stage 2 disposable-account E2Eを再開する。

## Accepted basis
- account deletion production Stage 1: PASS
- H2 production verification: target checks PASS; C2 reconciled
- PR #59 merged as `cbf3945c0c576695fc7d5d5cb2e108ae15f65bea`
- deletion feature remains OFF

## Rules
- use only disposable test identities
- before the first destructive valid-user action, STOP and obtain fresh explicit user confirmation
- no existing real user/account/workspace may be touched
- Apple remains excluded unless separately configured/approved
- no app feature activation

## Scenarios
1. never-connected disposable user
2. social-only disposable user with main-profile retention
3. disposable X-connected user if a safe disposable X account is available
4. lost-response/retry
5. unrelated-data invariants

If a safe disposable X account is unavailable, mark scenario 3 BLOCKED and continue only where safe.

## Completion / K3
Report PASS/PARTIAL/FAIL/BLOCKED, confirmation status, each scenario result, actual disposable-only mutations, invariants, cleanup state, feature-activation readiness, and remaining Apple/legal/cross-app gates.
Then status -> review_required, next_owner -> chatgpt, STOP for K3.

## Report

- 実行モデル: Opus 5.5（推奨どおり）
- **result: PARTIAL**
  - E1 / E2 / E4 / E5 は PASS。
  - E3 は、ネイティブ版アプリの不具合（下記 D1）により BLOCKED。ユーザーの判断で停止した。
- confirmation status: 破壊的な E2E の前に、ユーザーから明示的な承認を得た（使い捨てアカウントのみ、既存の実ユーザーは対象外、Apple は対象外）。E3 用の使い捨て X アカウントの利用と、X の失効についても承認済み（ただし E3 は未実施）。
- 役割分担: Claude の安全ルールにより、アカウントの作成、パスワードの入力、X への接続、削除の操作はユーザーが行った。Claude は読み取りでの検証、手順の案内、ローカルビルドの準備を担当した。
- 事前確認（読み取り）:
  - 本番の DB 読み戻しが Stage 1 と一致（21関数の md5、クライアントからの EXECUTE 0、service_role の EXECUTE 10、trigger 11、行数0）。
  - Edge は v1 / verify_jwt=true で、デプロイ済みソースは4ファイルともバイト単位で一致。
  - PR #59 は main に含まれている。

### scenarios
- **E1（X 未接続の使い捨てユーザー）: PASS**
  - 作成直後、email のみ、ワークスペース / 所属 / profile / admin なし、を事前に確認した。
  - アプリ（web のローカルビルド）から削除した。
  - 監査: requested → started → x_revoked（対象なし）→ purged → **completed**（ハッシュのみ、1 subject）。
  - Auth ユーザー / identities / sessions は0件、tombstone も0件。関係ないデータは、Auth ユーザー数が1減った以外に変化なし。
  - 削除済みのアカウントでは、ログインが拒否された。
- **E2（かぶモリの profile を持つ使い捨てユーザー）: PASS**
  - かぶモリアプリへのログインで profile ができていることを事前に確認した（scope は social_only の見込み）。
  - 監査: requested → started → x_revoked（対象なし）→ purged → **completed_social_only**。
  - **共有ログインとかぶモリの profile は残った**（隠れた CASCADE は無い）。social 側のデータは0件、tombstone も0件、関係ないデータに変化なし。
  - かぶモリアプリへのログインは引き続き可能。social アプリへの再ログインもできた（設計どおり、オンボーディングの最初から）。
- **E3（X 接続済みの使い捨てユーザー）: BLOCKED**
  - web ビルドでは設計上 X を接続できない（`kabumori-social://oauth-callback` が必須）。
  - そこで、ローカルの iOS シミュレーター用 Release ビルドを作った（一時的な bundle id はローカルだけで使い、リポジトリには入れていない）。しかし下記 D1 により、アプリが常にモックデータで動き、オンボーディングにも X 接続にも到達できない。
  - X の失効 / Vault の変更は**行っていない**。
- **E4（再試行 / 応答喪失の代替）: PASS**
  - E2 のアカウントで2回目の削除を行った → 再び completed_social_only で完了し、余分な削除や二重の削除は無い。tombstone は0件。
  - 削除済みの E1 アカウントでのログインは拒否された（削除済みを「成功」と誤って扱わない）。
- **E5（関係ないデータが変わらないこと）: PASS**
  - 各シナリオの前後と最終状態で、次の値を開始時と比べた: Auth ユーザー数 / profiles / `u_` ワークスペース数 / それ以外の brands のハッシュ / memberships / social_accounts の件数とハッシュ / Vault の件数と ID ハッシュ / refresh_state / tombstone。
  - 最終状態は開始時と一致した。差分は、意図して残した E2 の使い捨てアカウント（Auth +1、profile +1）だけ。投稿系の件数は減っていない。

### 見つかった不具合（ソースは変更していない）
- **D1（重大・リリースを止める）: ネイティブ版は常にモックデータで動く**
  - `apps/social-mobile/src/data/repository-selection.ts` の `selectDataSource(env = process.env)` が、`EXPO_PUBLIC_DATA_SOURCE` を動的な参照で読んでいる。
  - ネイティブのバンドルには埋め込まれないため、iOS / Android では常に `mock` になる（`src/lib/supabase.ts` のコメントで警告されているのと同じ問題）。
  - その結果、実データ、オンボーディング（X 接続）、そこからの削除の入口に、ネイティブ版から到達できない。
  - 修正案: `supabase.ts` と同じように、`process.env.EXPO_PUBLIC_DATA_SOURCE` を静的に参照する（`data-provider.tsx` は静的参照なので、両者の判定が食い違っていることにもなる）。
- **D2（中）: web 版で削除完了のメッセージが出ない**
  - `Alert.alert` は react-native-web では何も表示しないため、確認済みの削除の後、何も表示されずにログイン画面へ戻る。
  - 完了を知らせることが求められる（App Review 5.1.1(v)）ので、画面内の表示などで正直に知らせる必要がある。
- **D3（低〜中）: web 版で新規登録を押しても案内が出ない**
  - 中立的な確認メッセージが表示されないため、ユーザーが2回押してしまい、メール送信の上限に当たった。

### actual mutations（使い捨てのものだけ）
- ユーザーの操作で、使い捨ての Auth ユーザーを2つ作成（E1、E2）。E2 はかぶモリアプリへのログインで profile ができた。
- アプリの削除機能で次を実行: E1 の完全削除（ログインを含む）、E2 のアプリデータだけの削除（2回）。
- Claude からの本番への変更: **0件**（読み取りと集計のみ）。X の失効、Vault の変更、X 投稿、機能の有効化は、いずれもなし。
- 実在するユーザー / アカウント / ワークスペースには一切触れていない（ハッシュで一致を確認）。

### cleanup state
- ローカル: web の開発サーバーは停止済み。シミュレーターのテストアプリはアンインストールした。一時ファイル（`ios/`、`app.config.js`、`.env.local`）は削除し、`package.json` と `.gitignore` の自動編集は元に戻した。preview の設定も元に戻した。リポジトリの作業ツリーはきれいな状態。
- 本番に残るもの: E2 の使い捨てアカウント（ログインとかぶモリの profile。social 側のデータは無い）。これは、かぶモリアプリ側の削除か、オペレーターの判断で片付けるものとして残した。E1 は完全に削除済み。

### feature-activation readiness
- **no**。D1（ネイティブが常にモック）、D2（web で完了通知が無い）、E3 の未実施、Apple の設定、legal gate が残っている。

### remaining gates
1. D1 の修正（小さな source の修正）。D2 / D3 の UI 修正。
2. D1 修正後にネイティブビルドで E3 を実施する（使い捨て X アカウントは用意済み、承認済み）。ネイティブで E1 相当の確認も行う。
3. Apple の本番設定と承認（現在は最初から拒否する状態）。
4. legal: プライバシーポリシー / 規約 / 問い合わせ先、監査の保持期間、履歴の扱い、文言の確認。
5. 共有 Auth: ユーザーは共有のまま進めると判断した。規約やプライバシーポリシーでの説明と、Kabumori の `account-delete` との調整（G1/G2）が必要。
6. 本番の Auth のメール送信上限が小さく、登録のやり直しで上限に当たる（運用上の注意）。

### next recommendation
- G3 に、D1（必須）と D2 / D3 を直す小さな UI / 設定の読み込みの修正 TASK を割り当てる。受け入れ後に、ネイティブビルドで E3（および E1 相当）を再開する。
- STOP for K3。
