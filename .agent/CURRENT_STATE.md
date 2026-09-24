# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST
- repo: kabumori
- branch: main

## User routing preference

- かぶモリアプリ実装は G1 / G2。
- X自動投稿・複数ブランドX実装は G3 / G4。
- 各ペア内のどちらへ入れるかは、空き状況・競合・依存関係を見てChatGPTが判断する。
- H1/H2はCodexのレビュー・バグ修正・検証枠。
- ユーザーが個別TASKについて明示指定した場合はその指定を優先する。
- 同一ファイル / migration / RPC / Edge Function / workflow / production設定 / API境界 / 認証・権限ロジックの競合禁止は常に優先する。

## Model routing

- Claude（くろちゃん）: Sonnet 5 / Opus 5.5。通常実装はSonnet 5優先、高リスク・複雑設計のみOpus 5.5。
- Codex（こでさん）: Luna / Sol。利用枠節約のためLunaで安全に処理できるTASKはLuna優先、高リスク境界のみSol。

## Current slot snapshot

- H1: `idle` / task_id `none`
- H2: `idle` / task_id `none`
- G1: `review_required` — `kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924`
  - FULL real-device E2E PASS (recovery via PR #17 fix, new-password login, in-app deletion, cascade to baseline). PR #17 unmerged (Vercel free-tier rate limit).
  - Side effect: the owner's iPhone push-token row was moved and then removed by the device switch. It restores when they sign back in.
- G2: `done` — `x-admin-multibrand-selector-phase2-merge-only-20260924`
  - K2 accepted completed verification/freshen work; remaining merge/Vercel/QA continuation moved to G4.
- G3: `ready` — `x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924`
- G4: `ready` — `x-admin-phase2-vercel-gate-merge-and-postmerge-qa-20260924`

## Parallel safety

- G3 owns X queue/planner SQL/RPC/x-test-post Phase1D implementation.
- G4 owns apps/admin PR #15 merge gate and post-merge QA only.
- G1 owns consumer mobile recovery/auth E2E.
- H1/H2 are currently reserved for Codex review/verification work.
- push前にfresh `origin/main`確認。
- 既存未コミット変更は他workstream所有として触らない。
- 競合可能性を安全に否定できない場合は開始せず、具体的な競合箇所を報告する。

## Known issues / observations

- Phase1B account-bound queue foundationはC2 PASS済み。
- Phase1B migration単独適用禁止。
- old dispatcherのまま `claim_due_post_v2` 有効化禁止。
- legacy pending rowsの暗黙account backfill禁止。
- Phase1Cは安全停止C2 PASS。Phase1Dでclaim-domain partitionをsource-only検証する。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。
- PR #15はVercel deployment rate limit解除後にG4でmerge continuation。

## 更新ルール

- 各専用TASK/Reportが正本。索引やCURRENT_STATEと矛盾する場合はTASK/Reportを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
