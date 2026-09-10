# Codex Task

- task_id: x-multibrand-phase3b-auth-connection-prep-20260910
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: terra
- purpose: 複垢化Phase 3Bとして、会社員AIラボの実Xアカウントを安全に接続できるよう、Supabase Vaultを使う認証情報管理・OAuth接続・検証手順の実装準備を行う。ただし今回のtaskではX実投稿・live有効化・本番自動投稿開始は行わない。

## Background / handoff

このworkstreamは以下の続き。

- 初期安全調査: `feature/multibrand-foundation` commit `56244c7`
- 正式設計: `docs/multibrand/ARCHITECTURE.md` / commit `bfa4c7b`
- Phase 1 ローカル再現: `docs/multibrand/PHASE1.md` / commit `719249f`
- Phase 2 brand-aware基盤: commit `5806e85`、C1承認済み
- Phase 3A 会社員AIラボdry-run基盤: commit `34cb78c`、C1承認済み

Phase 3Aまでで以下を確認済み。

- `ai_salaryman_lab` はKabumoriとは独立した `BrandCodeProfile`
- Kabumoriのvoice / hashtags / promptを暗黙継承しない
- `brand_context_dry_run` で会社員AIラボをX token/Vault/X API未到達のまま検証可能
- disabled / unknown / dry_run publishはfail-closed
- Vault resolverはopaque secret reference + mock reader境界まで実装
- `mio` は未実装・disabled
- Deno tests 686 passed / 0 failed
- 本番Supabase / deploy / Cron / Secret/Vault書込み / OAuth / X投稿 / main mergeはゼロ

## Approved architecture decisions

- 共通パイプライン + `brand_id`
- `brands` と `social_accounts` を分離
- X Appは当面3ブランド共通1 App。将来分離用 `oauth_client_ref` は残す
- X token管理はSupabase Vault
- Secret値を通常テーブル・Git・Report・ログへ平文保存しない
- 新ブランドは `disabled -> dry_run -> live` の段階解放
- 会社員AIラボは今回も `live` にしない
- Kabumori legacy `oauth_token_store` は壊さない
- fail-closedを維持

## Read First / Safety

開始前に必ず確認する。

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CODEX_TASK.md`
- `docs/multibrand/README.md`
- `docs/multibrand/SURVEY.md`
- `docs/multibrand/ARCHITECTURE.md`
- `docs/multibrand/PHASE1.md`
- Phase 2 commit `5806e85`
- Phase 3A commit `34cb78c`

`origin/main` と他slot TASKをfresh-checkし、同じmigration / RPC / Edge Function / workflow / production設定へ触れる競合作業があれば開始しない。

作業場所は `/Users/yuya/Developer/kabumori-multibrand` / `feature/multibrand-foundation`。

Phase 1のlocal-only Cron無効化を維持し、開始前・DB reset後・完了前に `scripts/multibrand/check-safe-env.sh` がSAFEかつlocal `cron.job=0` であることを確認する。

## Phase 3B goal

**会社員AIラボの本物のXアカウント接続を、安全に実施できるところまで認証配管を完成させる。今回の完了条件は「投稿できること」ではなく「認証情報を安全に保持・選択・検証できること」。**

### A. Vault-backed token persistence design/implementation

Phase 3Aの `VaultSecretReader` 境界を、実運用可能なSupabase Vault adapterへ発展させる。

必要事項:

- `social_accounts` とVault secret referenceの対応関係を明示する
- Access Token / Refresh TokenのSecret本体は通常テーブルへ保存しない
- 通常テーブルに置くのはopaqueなVault secret id/referenceと必要最小限の非秘密metadataだけ
- brand/account不一致、secret欠落、client mismatch時はfail-closed
- refresh後のtoken更新方法を設計・実装可能な境界として定義
- Secret値をログ・例外・Reportへ出さない

本番Vaultへ実Secretを書き込む必要が出る前に、手順と対象を確認し、ユーザー操作または明示承認が必要な箇所を切り分けること。

### B. OAuth connection flow preparation

会社員AIラボのXアカウントを、既存Kabumoriと同じX Appを使って認可できる接続フローを準備する。

- `oauth_client_ref=default` を前提
- どのcallback / authorization URL / scope / PKCE/stateを使うか現行Kabumori経路を調査し、再利用可能部分を共通化
- OAuth stateにbrand/account identityを安全に紐付ける
- callback時に別brand/accountへtokenが保存されない防止策
- access/refresh tokenの保存先をVaultへ限定
- Kabumori legacy token経路を変更しない

**実際にXの認可画面でログイン・同意が必要な箇所は、ユーザー本人操作が必要として停止・明示すること。認証情報やパスワードを要求・保存しない。**

### C. Connection verification without posting

実アカウント接続後にX投稿せず接続確認できる方法を用意する。

- 可能ならread-onlyなX API（例: authenticated user identity）で、接続されたアカウントが意図した会社員AIラボであることだけを確認
- write/post APIは呼ばない
- account identity mismatch時はVault登録/有効化を中断
- 接続済みでも `publish_mode=dry_run` / `publish_enabled=false` を維持

X API仕様が現行コードだけで確定できず、外部最新仕様確認が必要なら、推測で実装せずReportへ明記して停止してよい。

### D. DB / schema changes

必要ならfeature branch上のmigrationで以下を追加可能。

- social account token reference metadata
- OAuth state/session metadata
- account connection status / verified identity metadata

ただし:

- migrationは本番へ適用しない
- Secret本体はDB通常テーブルへ入れない
- Kabumori既存データ/constraintを壊さないexpand-onlyを優先
- `mio` を有効化しない

### E. Tests

最低限以下を自動テストで固定する。

- brand Aのtoken refをbrand Bが読めない
- account mismatchはVault read前またはX API前にfail-closed
- OAuth state tamper / unknown state / expired stateを拒否
- callbackが意図したbrand/account以外へtokenを紐付けない
- company AI lab接続後もpublish guardはdry_run/disabledでX publishを拒否
- read-only identity verificationとwrite/post経路が分離されている
- Secret値がエラー出力・ログ・fixture snapshotへ漏れない
- Kabumori既存テストを維持

## Explicitly prohibited in this task

- X実投稿
- 会社員AIラボの `publish_mode=live`
- `publish_enabled=true` による投稿解放
- 自動投稿Cronへの会社員AIラボ追加
- 本番Edge Function deploy
- 本番Cron変更
- main merge
- `mio` profile/OAuth接続/有効化
- Instagram / Threads
- Secret値のGit/ログ/Report記載
- Kabumoriの既存tokenをVaultへ強制移行

## Production interaction policy

今回の基本作業はfeature branch / local / mockで行う。

本番側でOAuth callback URLやVaultの実接続確認など、どうしてもread/write操作が必要になる段階では、**先に安全な実行手順を完成させ、必要なユーザー操作とChatGPT承認ポイントをReportへ明記して停止**する。勝手に本番Secret作成・OAuth完了・deployは行わない。

## Completion criteria

以下を満たしたら停止してC1へ回す。

1. Vault-backed per-account token reference/reader/update境界が実運用可能な形で実装または完全に設計される。
2. OAuth state/callbackがbrand/account-awareで、混線防止テストがある。
3. 会社員AIラボをX投稿なしでread-only identity verificationできる経路が実装/明文化される。
4. 接続後も `dry_run` / publish disabledを維持する安全ゲートがある。
5. Secret値を通常テーブル/Git/ログ/Reportへ出さない。
6. Kabumori legacy token経路を維持する。
7. `mio` は未実装・disabled。
8. 既存686テストを含む全関連テストがpassし、追加件数を記録する。
9. DB変更があればlocal resetを確認する。
10. `check-safe-env.sh` 完了時SAFE、local cron.job=0。
11. 本番deploy/Cron変更/X投稿/live有効化/main mergeがゼロ。
12. feature branchへcommit/pushする。
13. 実OAuth承認・実Vault Secret登録などユーザー操作が必要な場合、その直前で停止し具体的手順をReportする。
14. Phase 3Cまたは自動投稿解放へ勝手に進まない。

## Report

完了・停止時は `.agent/CODEX_REPORT.md` に以下を記録し、TASKを `review_required` / `next_owner: chatgpt` にしてGitHub mainへ同期する。

- task_id
- result
- changed_files
- Vault design/implementation
- OAuth flow/state/callback details
- account identity verification
- tests
- local DB verification
- commit_hash
- push
- deploy
- production_changes
- secret/oauth/x-post changes
- user_action_required
- safety_checks
- known_gaps
- remaining_issues
- next_recommendation
