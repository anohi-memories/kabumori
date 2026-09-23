# Claude Task 2

- task_id: idle
- owner: claude
- slot: claude-2
- status: idle
- next_owner: chatgpt
- priority: normal
- recommended_model: Opus 5.5
- purpose: 空きスロット。ユーザーまたはChatGPTから次の明示TASKが入るまで新規作業を開始しない。

## Notes

- 直前の `kabumori-release-mobile-blockers-phase1-auth-account-settings-20260924` は Claude slot 1（G1）へ移動済み。
- G2は現在空き。
- `G2` 単独で開始しても、TASKがidleのため勝手に新規作業しない。
