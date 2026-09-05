# Active Task

このファイルは、ChatGPT（ちゃっぴー）が作成する最新指示の正本です。実装担当は作業開始前に `.agent/ORCHESTRATION.md` と既存のプロジェクトルールを確認してください。

## Task

- task_id: morning-greeting-enable-2026-09-06
- owner: claude
- status: review_required
- purpose: 2026-09-06朝の挨拶を、fresh-dateテストではなく本番自動投稿として安全に1回動かせる状態へする。ユーザーは投稿予定時刻を確認し、異常投稿があれば自身ですぐ削除できる体制を取る。
- scope:
  - 朝の挨拶の自動投稿設定・スケジュール・起動経路のread-only確認
  - 明日2026-09-06の朝の挨拶を自動投稿ONにするために必要な最小設定変更
  - 05:30 JSTのGitHub Actions画像自動生成との順序確認
  - 06:30〜07:00 JST想定の投稿予定時刻・実際の起動条件の確認
  - publish_claimsによる同日1回制御の確認
- forbidden:
  - 今日2026-09-05のfailed claimを削除・変更・再利用しない
  - 今日の朝の挨拶を再投稿しない
  - 朝の挨拶本文生成ロジックを不要に変更しない
  - 画像生成workflowの日次schedule（05:30 JST）を変更しない
  - important-news / useful_tip / morning_report / close_report / apps/admin / HANDOFF.md を変更しない
  - 他workstreamの未コミット変更を変更・stage・commitしない
  - secretsを表示・変更しない
  - unrelated refactorをしない
- completion_criteria:
  - origin/main fresh-check済み
  - 朝の挨拶のON/OFF設定箇所と自動起動経路を特定
  - 2026-09-06の画像が05:30 JSTに自動生成される前提を確認
  - 朝の挨拶の実際の予定時刻/時間窓を確認し、ユーザーが監視できる具体時刻を報告
  - 明日2026-09-06に限り本番自動投稿が安全に走る状態へ必要最小限で設定
  - 同日重複防止が有効であることを確認
  - 既存の安全ガードを緩めない
  - 変更が必要なら関連テスト/設定確認を実施
  - Xへの手動テスト投稿は行わない
  - 最終報告を `.agent/CLAUDE_REPORT.md` に記録
- commit: コード/設定ファイル変更がある場合のみ最小差分でcommit
- push: commitした場合はorigin/mainへpush
- deploy: Edge Function変更が必要な場合のみ対象functionだけ。単なるDB設定変更なら不要。不要なdeployは禁止
- next_owner: chatgpt

## Additional instructions

1. まずread-onlyで、朝の挨拶が現在なぜ自動起動しないのか、設定テーブル・dispatcher・schedule判定の経路を確認する。
2. `dispatch-scheduled-posts` は毎分稼働しているため、朝の挨拶側の有効化条件/時間窓を正確に確認する。
3. 明日の画像生成はGitHub Actions `morning-greeting-image.yml` が05:30 JSTに `generated/2026-09-06.png` を作る想定。画像生成前に投稿が走らないことを確認する。
4. ユーザーが監視できるよう、明日の投稿予定時刻をJSTで明示する。ランダム時間なら、確定値または確定方法を確認して報告する。
5. 可能なら「明日だけON」より、正常ならそのまま通常運用へ移れる設定が安全かも評価する。ただし勝手に恒久ONへ拡張しない。ユーザーの意図はまず明日の1回を本番で確認すること。
6. 投稿内容が変でもユーザーがX上で削除できるため、今回はfresh-date dry-runではなく本番自動投稿を許可する。ただし手動即時投稿はしない。
7. 今日2026-09-05のfailed claimには一切触れない。
8. 完了後は `.agent/CLAUDE_REPORT.md` を更新し、statusを `done` または `review_required` にする。

## Status values

- `idle`: 有効な指示なし（初期状態・次指示待ち）
- `ready`: ownerが開始できる
- `in_progress`: ownerが作業中
- `review_required`: 実装済みで確認・判断待ち
- `done`: 完了

`owner` は `codex` または `claude` のどちらか一方だけを指定します。`status: idle` のときだけ `owner: none` を使用できます。
