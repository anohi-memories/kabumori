# Current State

引き継ぎに必要な短い現在地だけを記録します。詳細仕様や履歴は各TASK/Reportを正本として参照してください。

- checked_at: 2026-09-24 JST
- repo: kabumori
- branch: main
- orchestration:
  - 共通ルール: `.agent/ORCHESTRATION.md`
  - Codex: H1/H2開始、C1/C2完了確認
  - Claude: G1〜G4開始、K1〜K4完了確認
  - F: 全6枠統括

## Operating model

- Claude Code（くろちゃん）が通常の実装主担当。G1〜G4を使用する。
- Codex（こでさん）は通常、レビュー・バグ修正・検証担当。H1/H2を使用する。
- Claudeが5時間利用制限に到達した場合だけ、ChatGPT（ちゃ）がCodexへ臨時実装TASKを割り当てられる。
- ChatGPTは実装の節目と変更リスクを見てレビュー時期を判断し、未割当のH枠へ具体的なレビューTASKを作る。
- 以前のH1/G1=かぶモリ本体、H2/G2=X自動投稿アプリという固定ルーティングは新しい役割ベース運用では使用しない。ユーザーが個別TASKについて明示指定した場合はその指定を優先する。

## Current slot snapshot

各TASKを正本として確認した現在地:

- H1: `ready` — `x-autopost-phase1d-claim-domain-partition-and-planner-authority-20260924`
- H2: `idle` / task_id `none` — 未割当
- G1: `review_required` — `kabumori-mobile-auth-real-e2e-disposable-account-20260924`
- G2: `review_required` — `x-admin-multibrand-selector-phase2-merge-only-20260924`
- G3: `idle` / task_id `none` — 未割当
- G4: `idle` / task_id `none` — 未割当

statusだけで空きと判断しない。task_id、TASK本文、Report、next_ownerを確認し、既存割当を保護する。

## Parallel safety

- 同じファイル、DB migration、RPC、Edge Function、workflow、production設定、API境界、認証・権限ロジックを複数枠で同時変更しない。
- push前にfresh `origin/main`確認。
- 既存未コミット変更は他workstream所有として触らない。
- 競合可能性を安全に否定できない場合は開始せず、具体的な競合箇所を報告する。

## Known issues / observations

- Phase1B account-bound queue foundationはC2 PASS済み。
- Phase1B migration単独適用禁止。
- old dispatcherのまま claim_due_post_v2 有効化禁止。
- legacy pending rowsの暗黙account backfill禁止。
- multibrand migration history不整合の可能性があるためblind `supabase db push`禁止。

## 更新ルール

- 各専用TASK/Reportが正本。索引やCURRENT_STATEと矛盾する場合はTASK/Reportを優先する。
- 作業完了時に確認できた現在値だけを反映する。
- 推測は事実として書かず、秘密情報・認証情報・個人情報は書かない。
