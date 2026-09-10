# Claude Task 2

- task_id: x-multibrand-phase2-brand-context-20260910
- owner: claude
- slot: claude-2
- status: ready
- next_owner: claude
- priority: high
- purpose: 複垢化Phase 2として、現行かぶモリの挙動を維持したまま `brand_id` / BrandContext の基礎を導入し、まず `kabumori` 1ブランドだけで完全互換を確認する。本番反映・新ブランド接続は行わない。

## Approved decisions

以下はChatGPT側で承認済み。

- 共通パイプライン + 行ごとの `brand_id` を基本構造とする。
- `brands` と `social_accounts` を分離する。
- 初期ブランドIDは `kabumori` / `ai_salaryman_lab` / `mio`。
- X Appは当面3ブランド共通1 App。将来分離可能な `oauth_client_ref` は残す。
- XトークンはSupabase Vaultを採用する。通常テーブルへSecret値を平文保存しない。
- 既存シングルトン設定はin-placeでブランド対応へ多行化する。
- 新ブランドは既定OFF、`disabled -> dry_run -> live` の明示段階解放。
- migrationは expand -> switch -> contract。Phase 2では原則expand/switchまでで、旧互換を壊すcontractは行わない。
- ブランド文脈解決失敗・未知brand・安全ゲート不明時はfail-closedで投稿しない。

正式設計: `docs/multibrand/ARCHITECTURE.md`
Phase 1結果: `docs/multibrand/PHASE1.md`
Phase 1 branch commit: `719249f` on `feature/multibrand-foundation`

## Read First / Start Safety

開始時に必ず以下を確認する。

- `.agent/ORCHESTRATION.md`
- `.agent/CURRENT_STATE.md`
- `.agent/tasks/CLAUDE_TASK.md`
- `docs/multibrand/README.md`
- `docs/multibrand/SURVEY.md`
- `docs/multibrand/ARCHITECTURE.md`
- `docs/multibrand/PHASE1.md`

その上で `origin/main` をfresh-checkし、他スロットのTASKも確認して変更対象が競合しないことを確認する。競合がある場合は開始しない。

複垢作業は `/Users/yuya/Developer/kabumori-multibrand` / `feature/multibrand-foundation` を使用し、既存 `kabumori` checkout の未コミット差分は他workstreamの所有物として触らない。

作業開始前・DB reset後・完了前に `scripts/multibrand/check-safe-env.sh` を実行しSAFEを確認する。Phase 1で判明した「ローカルmigration再生時に本番URL入りCronが登録され得る」リスクを必ず認識し、local-only Cron無効化を維持する。

## Model Guidance

通常はSonnet系で進めてよい。

ただし以下が必要になった場合は勝手に設計変更せず停止してChatGPTへ報告する。

- ARCHITECTURE.mdのbrand/accountモデルを変更したい
- migration戦略を大きく変更したい
- Vault / X認証方式の再設計が必要
- Cron構造を今回変更する必要が出た
- 既存本番互換性と複垢化が両立しない

その場合は必要に応じてOpusへ切り替える。

## Scope — Phase 2

Phase 2のゴールは「3ブランド運用」ではない。

**`kabumori` 1ブランドだけを新しいbrand-aware構造で従来どおり動かせる基礎を作ること。**

実施対象は、ARCHITECTURE.mdのPhase 2に沿って必要最小限に限定する。

### A. DB expand

ローカル環境で以下の基礎を実装・検証する。

- `brands`
- `social_accounts`
- 必要なブランド設定基盤
- 既存投稿関連テーブルへの `brand_id` 追加
- 既存行を大量UPDATEせず `kabumori` として扱える後方互換
- 既存一意制約を壊さず、新しいbrand-aware制約を安全に追加する方法
- シングルトン設定のin-place多行化のうちPhase 2に必要な範囲

migrationはfeature branch専用。**本番へ適用しない。**

### B. BrandContext 基礎

`supabase/functions` 側へ、ブランド文脈を一箇所で解決する共有層を追加する。

例としてARCHITECTURE.md記載の `_shared/brand/*` 相当を実装し、少なくとも以下を型として明確化する。

- brand identity
- social account identity
- publish mode / enabled gates
- brand code profile
- operational settings

`kabumori` の既存ブランド名・文体・ハッシュタグ・プロンプト等を、挙動を変えずにBrandContext/BrandCodeProfile経由へ移せる土台を作る。

### C. 投稿パイプラインへbrand_idを通す

Phase 2で安全に変更できる範囲で、planner / scheduled row / claim / execution / completionまで `brand_id` が消えないようにする。

特に `claim_due_post()` と `x-test-post` の境界を優先する。

- 引数省略・旧経路は `kabumori` として互換動作
- 新コード内で暗黙の「唯一のブランド」を参照しない
- 未知brandはfail-closed

### D. X token loaderの分離準備

既存 `oauth_token_store` は**かぶモリ専用legacyとして凍結**する。

Phase 2では新ブランドのOAuthやVault token登録を行わない。

ただし、後続Phaseでbrand/social_account単位のtoken resolverへ切り替えられるよう、X token読込ロジックの重複を整理し、`kabumori` legacy token経路を明示的に1箇所へ寄せることは実施可。

### E. 互換テスト

`kabumori`について、brand-aware化前後で以下が変わらないことを固定する。

- 投稿種別選定
- 生成プロンプト主要部分
- ハッシュタグ
- planner / schedule / claimの意味
- dry-run時にX APIを呼ばないこと
- 既存投稿時間・Cron前提を今回変更していないこと

可能ならゴールデンスナップショット等で、かぶモリ文面・設定の意図しない変化を検知する。

## Explicitly out of scope / 禁止

Phase 2では以下を行わない。

- 本番Supabaseへのlink
- 本番DBへのmigration適用・schema変更
- 本番RPC変更
- 本番Edge Function deploy
- 本番Cron変更
- 本番Secret/Vault変更
- X OAuth
- 新規X token取得
- 会社員AIラボ・みおの実アカウント接続
- X実投稿
- 会社員AIラボ・みおの自動投稿有効化
- Instagram / Threads実装
- 管理画面ブランド切替実装
- mainへのmerge
- ARCHITECTURE.mdでPhase 3以降とされているブランド固有実装の先取り
- 既知の「GitHubにない本番コード」「本番migration不整合」の解消をこのtaskへ混ぜること

## Local environment note

Phase 1ではDocker Desktopの非対話インストールがsudoで止まり、Podmanを代替使用した。

現状でもDB migration / 直接SQL RPC / Edge Function serve / Deno testは可能なのでPhase 2は開始可。

Kong/PostgREST/Auth/Storageを含む完全結合テストが必要になった場合は、未検証のまま成功扱いせずReportへ明記する。Docker Desktop導入が本当にブロッカーになった時点で停止して報告する。

## Completion Criteria

以下を満たしたら停止してK2へ回す。

1. brand/account基礎schemaをfeature branch上のmigrationとして実装し、ローカルresetで再現できる。
2. 既存データが `kabumori` として互換的に扱われる。
3. `kabumori` 用BrandContext/BrandCodeProfile基礎が実装される。
4. 主要投稿経路で `brand_id` がplanner/claim/x-test-postまで保持される、または今回安全に到達できた境界と未対応箇所を明示する。
5. 未知brand / disabled brandがfail-closedになるテストがある。
6. 既存 `oauth_token_store` に新ブランド情報を入れていない。
7. 会社員AIラボ・みおは未接続・未有効化。
8. 既存680テストを含む関連テストがpassし、追加テスト結果も記録される。
9. `check-safe-env.sh` が完了時SAFE。
10. 本番変更・deploy・Cron変更・Secret変更・OAuth・X投稿がゼロ。
11. feature branchへcommit/pushし、mainへmergeしない。
12. Phase 3へ勝手に進まない。

## Report

完了・停止時はこのファイル末尾に以下を記録し、`status: review_required`、`next_owner: chatgpt` としてGitHub mainへ制御情報を同期する。

- task_id
- result
- changed_files
- DB/migration details
- brand context / pipeline details
- tests
- commit_hash
- push
- deploy
- production_changes
- safety_checks
- known_gaps
- remaining_issues
- Phase 3 readiness
- next_recommendation
