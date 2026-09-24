# Claude Task 3

- task_id: none
- owner: claude
- slot: claude-3
- status: idle
- next_owner: none
- priority: normal
- recommended_model: Luna
- purpose: Claude Code用の未割当実装スロット。TASKが割り当てられるまで作業を開始しない。

## Assignment rule

- 新しいTASKはChatGPTが競合を確認したうえで割り当てる。
- statusがidleでも、task_idや本文に既存割当がある場合は上書きしない。
- readyまたはin_progressになった場合だけG3で開始する。
- 開始前にORCHESTRATION/CURRENT_STATE/fresh origin/main/Git状態を確認する。

## Report

未割当。作業完了時はこのTASK末尾のReportにtask_id、result、changed_files、tests、commit_hash、push、deploy、remaining_issues、safety_checks、next_recommendationを記録する。
