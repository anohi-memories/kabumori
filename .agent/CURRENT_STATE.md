# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST
- repo: kabumori
- branch: main

## User routing preference

- ユーザーから明示指定がない限り、H1 / G1 はかぶモリアプリ側を優先する。
- ユーザーから明示指定がない限り、H2 / G2 はX自動投稿・複数ブランドX運用側を優先する。
- ユーザーが個別TASKについて明示指定した場合はその指定を優先する。
- 同一ファイル / migration / RPC / Edge Function / workflow / production設定 / API境界 / 認証・権限ロジックの競合禁止は常に優先する。

## Operating model

- Claude Code（くろちゃん）が通常の実装主担当。G1〜G4を使用する。
- Codex（こでさん）は通常、レビュー・バグ修正・検証担当。H1/H2を使用する。
- Claudeが利用制限に到達した場合だけ、ChatGPTがCodexへ「臨時実装」と明記したTASKを割り当てられる。
- ChatGPTは実装の節目と変更リスクを見てレビュー時期を判断する。
- モデルは利用枠節約を優先し、Lunaで安全に処理できるTASKはLunaを優先する。DB/認証/並行処理/本番境界など高リスクのみSolを推奨する。

## Current slot snapshot

- H1: `idle` / task_id `none` — かぶモリアプリ側用に空き
- H2: `ready` — `x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924`
- G1: `review_required` — `kabumori-mobile-recovery-deeplink-routing-fix-and-e2e-resume-20260924`
  - Deep-link fix: PR #17, unmerged. Real-device E2E paused by the user (Supabase built-in email limit). Resume later with the same disposable account. New blocker: custom SMTP.
- G2: `review_required` — `x-admin-multibrand-selector-phase2-merge-only-20260924`
- G3: `idle` / task_id `none`
- G4: `idle` / task_id `none`

statusだけで空きと判断しない。task_id、TASK本文、Report、next_ownerを確認し、既存割当を保護する。

## Parallel safety

- H2 Phase1Dはqueue/planner SQL/RPC/x-test-post系を所有する。
- G2はapps/admin/**のみで、H2とscope分離を維持する。
- G1はconsumer mobile auth/recovery/E2Eを所有し、H2/G2とscope分離する。
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
- G2 PR #15はVercel deployment rate limitによりmerge保留中。

## 更新ルール

- 各専用TASK/Reportが正本。索引やCURRENT_STATEと矛盾する場合はTASK/Reportを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
