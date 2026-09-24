# ChatGPT Room Handoff

新しいChatGPT部屋へ移動するときの最小引き継ぎです。詳細な実装状態は `.agent/CURRENT_STATE.md`、運用正本は `.agent/ORCHESTRATION.md`、個別作業は各TASK/Reportを参照してください。

## 共有運用

- リポジトリ: `anohi-memories/kabumori`
- 共有タスクハブ: `.agent/`
- 通常の実装主担当: Claude Code（くろちゃん）
- 通常のレビュー・バグ修正・検証担当: Codex（こでさん）
- ChatGPT（ちゃ）: 全体オーケストレーションとレビュー時期判断

### 6スロット

- H1: `.agent/tasks/CODEX_TASK.md` / `.agent/CODEX_REPORT.md`
- H2: `.agent/tasks/CODEX_TASK_2.md` / `.agent/CODEX_REPORT_2.md`
- G1: `.agent/tasks/CLAUDE_TASK_1.md`（ReportはTASK内）
- G2: `.agent/tasks/CLAUDE_TASK.md`（ReportはTASK内）
- G3: `.agent/tasks/CLAUDE_TASK_3.md`（ReportはTASK内）
- G4: `.agent/tasks/CLAUDE_TASK_4.md`（ReportはTASK内）

### コード

- `H1` / `H2`: Codex開始
- `C1` / `C2`: Codex個別完了確認
- `G1`〜`G4`: Claude開始
- `K1`〜`K4`: Claude個別完了確認
- 単独`G` / `K`: 対象が1枠だけ明白な場合のみ
- `F`: 全6枠統括

Claudeが5時間利用制限に到達した場合だけ、ChatGPT判断でCodexへ臨時実装を割り当てられる。通常時のH1/H2はレビュー・バグ修正・検証用。

ChatGPTは機能完了、DB/API境界、認証・権限、複数レイヤー変更、重要バグ修正後、本番反映前などを目安にレビュー要否を判断する。固定条件ではなくリスクベース。既存TASKを上書きせず、未割当H枠だけを使う。

## 安全ルール

- task_idと変更対象が分離され競合しない場合だけ並行作業する。
- 同じファイル、DB migration/RPC、Edge Function、workflow、production設定等を複数枠で同時変更しない。
- push前にfresh `origin/main`確認。
- 他workstreamの未コミット変更を変更・削除・stage・commitしない。
- statusだけで空き判定しない。task_idとTASK本文も確認する。
- 未実施を成功扱いにしない。

## 新しいChatGPT部屋の開始手順

1. このファイルを読む
2. `.agent/CURRENT_STATE.md` を読む
3. G/H/C/K/F運用が必要なら `.agent/ORCHESTRATION.md` を読む
4. 対象スロットのTASK/Reportを読む
5. TASK/Reportと索引が矛盾する場合はTASK/Reportを正本として扱う
6. ユーザーに過去経緯を再説明させず、この共有状態から継続する
