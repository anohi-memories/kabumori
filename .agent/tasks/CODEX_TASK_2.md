# Codex Task 2

- task_id: none
- owner: codex
- slot: codex-2
- status: idle
- next_owner: none
- priority: normal
- recommended_model: Luna
- purpose: Codex用の未割当レビュー・バグ修正・検証スロット。TASKが割り当てられるまで作業を開始しない。

## Assignment rule

- 通常はClaude実装後のレビュー、バグ修正、検証、回帰確認、deploy前確認に使う。
- Claudeが5時間利用制限に到達した場合のみ、ChatGPTが「臨時実装」と明記したTASKを割り当ててよい。
- 新しいTASKはChatGPTが競合と既存割当を確認したうえで置く。
- statusがidleでも、task_idや本文に既存割当がある場合は上書きしない。
- readyまたはin_progressになった場合だけH2で開始する。
- 開始前にORCHESTRATION/CURRENT_STATE/fresh origin/main/Git状態を確認する。
- ユーザーが個別TASKについて明示的なルーティングを指定した場合は、その指定を優先する。
