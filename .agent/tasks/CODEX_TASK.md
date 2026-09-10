# Codex Task

- task_id: x-multibrand-phase3a-second-brand-dryrun-20260910
- owner: codex
- slot: codex-1
- status: ready
- next_owner: codex
- priority: high
- recommended_model: terra
- purpose: 複垢化Phase 3Aとして、Phase 2で完成したbrand-aware基盤の上に2ブランド目 `ai_salaryman_lab` を「未接続・dry-run専用」で安全に通せる配管を実装する。今回は実OAuth・実Token・X実投稿・本番反映を行わない。

## Background / handoff

この作業は以下の連続したworkstreamの続き。

- 初期安全調査: `feature/multibrand-foundation` commit `56244c7`
- 正式設計: `docs/multibrand/ARCHITECTURE.md` / commit `bfa4c7b`
- Phase 1 ローカル再現: `docs/multibrand/PHASE1.md` / commit `719249f`
- Phase 2 brand-aware基盤: commit `5806e85`、C1承認済み

Phase 1では、ローカルmigration再生時に本番URL入りCronが登録され得る危険を発見し、local-only unschedule migrationと `scripts/multibrand/check-safe-env.sh` で対策済み。この安全対策は絶対に外さない。

Phase 2では以下まで完了済み。

- `brands` / `social_accounts` / `brand_settings`
- 主要投稿系テーブルの `brand_id` 対応
- `BrandContext` / `BrandCodeProfile` / publish guard
- planner / claim / x-test-post 境界でのbrand context引継ぎ
- 未知brand / disabled / dry_runのfail-closed
- 既存 `oauth_token_store` をKabumori legacy専用に固定
- token loader境界を `_shared/brand/token_loader.ts` に集約
- local DB reset PASS
- Deno tests 683 passed / 0 failed
- 本番変更・deploy・Cron・Secret/Vault・OAuth・X投稿・main mergeはゼロ

## Read First / Start Safety

開始前に必ず確認する。

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CODEX_TASK.md`
- `docs/multibrand/README.md`
- `docs/multibrand/SURVEY.md`
- `docs/multibrand/ARCHITECTURE.md`
- `docs/multibrand/PHASE1.md`
- Phase 2 commit `5806e85`

その上で `origin/main` をfresh-checkし、他スロットTASKと変更対象が競合しないことを確認する。同じmigration / RPC / Edge Function / workflow / production設定を別slotが触っている場合は開始しない。

作業場所は `/Users/yuya/Developer/kabumori-multibrand` / `feature/multibrand-foundation`。既存 `kabumori` checkoutの未コミット差分には触れない。

作業開始前・DB reset後・完了前に `scripts/multibrand/check-safe-env.sh` を実行し、必ずSAFEかつlocal `cron.job=0` を確認する。

## Approved architecture decisions

- 1本の共通パイプライン + 行ごとの `brand_id`
- `brands` と `social_accounts` を分離
- X Appは当面3ブランド共通1 App、`oauth_client_ref` は将来分離用に残す
- X token管理はSupabase Vaultを採用
- Secret値を通常テーブルやGitへ平文保存しない
- シングルトン設定はin-placeでブランド対応
- 新ブランドは `disabled -> dry_run -> live` の明示段階解放
- fail-closedを維持
- expand -> switch -> contract。既存Kabumori互換を壊すcontractはまだ行わない

## Model guidance

通常実装はTerraでよい。

以下が必要になったら勝手に設計変更せず停止してChatGPTへ報告する。

- Brand/accountモデル変更
- Vault方式の根本変更
- Cron構造変更
- Kabumori互換を壊さないと2ブランド化できない
- migration戦略の大幅変更

その場合はSol等への切替を検討する。

## Phase 3A goal

今回のゴールは **会社員AIラボを本番接続することではない**。

`ai_salaryman_lab` がKabumoriとは完全に別ブランドとして、brand context解決 → ブランド別設定 → 生成処理 → dry-run結果まで到達でき、X token読込・X API送信には絶対に到達しない状態を作る。

### A. 会社員AIラボ用 BrandCodeProfile の分離

- `ai_salaryman_lab_v1` 相当の独立 `BrandCodeProfile` を追加する
- Kabumori profile / voice / hashtags / promptを暗黙継承しない
- 今回、会社員AIラボの詳細な人格・投稿戦略を勝手に完成させない
- Phase 3Aでは「別ブランドとして安全に識別・生成経路を通せる最小profile」を作る
- ブランド固有値は明示的なprofile/settings経由に限定する
- 未定義値が必要ならKabumoriへfallbackせずfail-closedまたは明示的defaultにする

### B. 会社員AIラボをdry-run専用で有効化できるローカル設定

ローカルfeature branch上でのみ、以下を検証できるようにする。

- `brands.id = ai_salaryman_lab`
- `publish_mode = dry_run`
- social accountは実Tokenなし
- X publishは無効
- dry-run生成は可能

本番用migrationで会社員AIラボを勝手に有効化しない。必要ならテストfixture / local-only setup / transaction rollback等を使い、production seedは安全側を維持する。

### C. dry-runとpublish guardの責務分離

Phase 2では `dry_run` をpublish boundaryでfail-closedにしている。これを維持しつつ、Phase 3Aでは「生成・検証用dry-run」は通せるよう責務を明確化する。

必須条件:

- dry-runではX token loaderを呼ばない
- dry-runではVault secretを要求しない
- dry-runではX APIを呼ばない
- live publish boundaryでは従来どおり `dry_run` を拒否
- unknown/disabledは生成入口でも安全側に倒す

### D. Vault-backed token resolver の実装準備

承認済み方針どおりSupabase Vaultを使う。

Phase 3Aでは **実Secret作成・実Token保存は禁止**。

実施可:

- social accountからVault secret referenceを解決するデータモデル/型/reader境界の実装
- Vault readを抽象化し、fetch/DBをmockした単体テスト
- Secretが無い / account不一致 / brand不一致 / oauth_client_ref不一致時のfail-closed
- Kabumori legacy resolverは従来経路のまま維持

実施禁止:

- 本番Vaultへの書込み
- 実Access Token / Refresh Tokenの取得・保存
- 実X OAuth
- Secret値をGit/ログ/Reportへ記載

### E. 2ブランドの設定隔離テスト

最低限、以下を自動テストで固定する。

- Kabumoriと会社員AIラボが別 `BrandCodeProfile` を解決する
- 会社員AIラボがKabumoriのvoice/hashtags/promptをfallback継承しない
- 会社員AIラボの設定変更がKabumoriの出力に影響しない
- Kabumori既存テストは全て維持
- `ai_salaryman_lab` dry-runはtoken loader / X API未到達
- `ai_salaryman_lab` liveはToken未設定のためfail-closed
- `mio` は引き続き未実装・disabledでfail-closed

### F. Pipeline boundary

可能な範囲で `x-test-post` のbrand-aware dry-run入口を整理する。

- 明示 `brand_id` を受け取れる
- 省略時はKabumori互換
- dry-runレスポンス/ログにはbrand identityが残る
- execution log / scheduled rowへ別ブランド文脈を渡す場合も混線しない
- Kabumoriの既存投稿時刻・Cron・本番挙動は今回変更しない

## Explicitly out of scope / prohibited

- 本番Supabase link
- 本番DB migration / schema / RPC変更
- 本番Edge Function deploy
- 本番Cron変更
- 本番Secret / Vault変更
- X OAuth
- 実X token取得・保存
- 会社員AIラボの実Xアカウント接続
- X実投稿
- 会社員AIラボの `live` 有効化
- `mio` のprofile実装・接続・有効化
- Instagram / Threads
- 管理画面ブランド切替
- main merge
- GitHubにない本番コードやmigration不整合の解消を混ぜること

## Completion criteria

以下を満たしたら停止してC1へ回す。

1. `ai_salaryman_lab` がKabumoriと独立したBrandCodeProfileを持つ。
2. ローカル/テスト環境で `ai_salaryman_lab` のbrand contextが解決できる。
3. 会社員AIラボのdry-run生成経路がX token/Vault/X APIを呼ばずに成立する。
4. live publish boundaryではToken未設定の会社員AIラボがfail-closedする。
5. Vault-backed resolver境界が実Secretなしで実装・単体検証される、または安全上実装を延期すべき具体的理由をReportする。
6. Kabumori legacy token経路・出力・既存挙動を維持する。
7. `mio` は未実装・disabledのまま。
8. brand間設定/voice/hashtag/prompt混線を防ぐテストがある。
9. 既存683テストを含む全関連テストがpassし、追加テスト数を記録する。
10. local DB resetが必要な変更なら成功を確認する。
11. `check-safe-env.sh` 完了時SAFE、local cron.job=0。
12. 本番変更、deploy、Cron、Secret/Vault書込み、OAuth、X投稿、main mergeがゼロ。
13. feature branchへcommit/pushする。
14. Phase 3B（実OAuth/実アカウント接続）へ勝手に進まない。

## Report

完了・停止時は `.agent/CODEX_REPORT.md` に以下を記録し、TASKを `review_required` / `next_owner: chatgpt` にしてGitHub mainへ制御情報を同期する。

- task_id
- result
- changed_files
- brand profile / dry-run details
- Vault resolver details
- pipeline changes
- tests
- local DB verification
- commit_hash
- push
- deploy
- production_changes
- secret/oauth/x-post changes
- safety_checks
- known_gaps
- remaining_issues
- Phase 3B readiness
- next_recommendation
