# ChatGPT Room Handoff

新しいChatGPT部屋へ移動するときの最小引き継ぎ正本です。詳細な実装状態は `.agent/CURRENT_STATE.md`、運用ルールは `.agent/ORCHESTRATION.md` を参照してください。

## 共有運用

- リポジトリ: `anohi-memories/kabumori`
- 共有タスクハブ: `.agent/`
- 実装スロットは3つ
  - Codex: `.agent/tasks/CODEX_TASK.md`
  - Claude Code slot 1: `.agent/tasks/CLAUDE_TASK_1.md`
  - Claude Code slot 2: `.agent/tasks/CLAUDE_TASK.md`
- 開始コード
  - Codex: `G`
  - Claude slot 1: `G1`
  - Claude slot 2: `G2`
- 完了確認コード
  - Codex: `C`
  - Claude slot 1: `K1`
  - Claude slot 2: `K2`
  - `K` はClaudeの完了対象が1枠だけ明白な場合の簡易確認
- `F` は全体統括。3枠の進行状況・競合・空き枠を確認するためのコードで、別チャット担当の個別タスクを文脈なしに完了処理しない
- task_idと変更対象が分離され、競合しない場合のみ3枠を同時進行してよい
- 同じファイル、同じDB migration/RPC、同じEdge Function、同じworkflow、同じproduction設定を複数スロットで同時変更しない

## 現在の主要状態

- `important-news-monitor`: v26 / ACTIVE
- `x-test-post`: v86 / ACTIVE
- important news auto_publish: false
- useful_tip schedule: active
- morning_greeting posting window: 06:30-07:00 JST / daily_probability=1 / is_active=true
- morning greeting画像自動生成: 05:30 JST daily GitHub Actions
- 2026-09-05のmorning greeting failed claimは変更・削除・再利用しない
- 2026-09-06 00:00 JST以降にmorning greetingの確定投稿予定時刻をread-only確認する
- 2026-09-06朝にscheduled_posts / publish_claims / x_post_idをread-only確認する
- 重要ニュースP0.7 corporate X market-impact gateはユーザー判断で保留。勝手に開始しない

## モデル運用方針

- 普段はGPT-5.6 Solを使う
- 難しい設計判断や複雑な原因切り分けで必要な時だけSol高を提案する
- Astraは大規模設計変更、全体レビュー、複数領域をまたぐ難題など明確に価値がある時だけ提案する
- Astra容量は節約する。日常の小修正・定型実装・GitHubタスク整理では原則使わない

## 新しいChatGPT部屋の開始手順

1. このファイルを読む
2. `.agent/CURRENT_STATE.md` を読む
3. G/C/K/F運用が必要なら `.agent/ORCHESTRATION.md` を読む
4. 実装タスクを扱う場合のみ対象スロットのTASKとREPORTを読む
5. `HANDOFF.md` はWeb-admin系を含む別用途のため、今回の部屋移動だけを理由に変更しない

新しい部屋では、ユーザーに過去経緯を再説明させず、この共有状態から継続する。
