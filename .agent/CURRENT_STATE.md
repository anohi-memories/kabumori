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

- Claude（くろちゃん）: Sonnet5（中/高/極高） / Opus5.5（中/高/極高）。Sonnet5で安全な作業はSonnet5優先。
- Codex（こでさん）: Luna（中/高/極高） / Sol（中/高/極高）。利用枠節約のためLunaで安全なTASKはLuna優先。

## Deployment policy — user approved

- 開発中・PR・テスト用Web PreviewはNetlifyへ寄せる。
- レビュー完了後の最終production deployのみVercelを使う。
- Vercelのrate limitを通常の開発・レビュー工程のブロッカーにしない。
- 現在Vercel待ちのPR #15 final gateは一旦保留。
- かぶモリExpoアプリについてNetlifyはExpo Web Preview用途であり、iOS実機/TestFlight/native-only機能の代替ではない。

## Current slot snapshot

- H1: `ready` — `kabumori-mobile-recovery-pr17-final-auth-security-review-20260924`
- H2: `idle` / task_id `none`
- G1: `done` — `kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924`
- G2: `ready` — `kabumori-netlify-expo-web-preview-pipeline-20260924`
- G3: `ready` — `x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924`
- G4: `ready` — `x-admin-netlify-deploy-preview-pipeline-20260924`

## Parallel safety

- G2 owns root Expo/Web preview configuration and Kabumori Netlify preview setup.
- G3 owns X queue/planner SQL/RPC/x-test-post Phase1D.
- G4 owns apps/admin Netlify Preview configuration only.
- H1 owns final Auth/security review of PR #17 and must not be overlapped by G2 changes to the exact PR #17 files.
- H2 is free for review/verification work.
- push前にfresh `origin/main`確認。
- 各slotは独立worktree/checkoutを使用する。
- 既存未コミット変更は他workstream所有として触らない。

## Deferred work

- PR #15 final Vercel check -> merge -> post-merge read-back -> production Admin QA.
- Prior reviewed code/test evidence remains preserved in the old G4/G2 reports.
- Resume only after Netlify Preview workflow is established or user explicitly asks.

## Known issues / observations

- Phase1B account-bound queue foundationはC2 PASS済み。
- Phase1B migration単独適用禁止。
- old dispatcherのまま `claim_due_post_v2` 有効化禁止。
- legacy pending rowsの暗黙account backfill禁止。
- Phase1Cは安全停止C2 PASS。Phase1DはG3。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASK/Reportが正本。索引やCURRENT_STATEと矛盾する場合はTASK/Reportを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
