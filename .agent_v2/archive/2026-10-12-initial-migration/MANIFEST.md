# MANIFEST — 2026-10-12-initial-migration

- snapshot_commit: `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`
- snapshot_commit_date: 2026-10-12T15:34:45+09:00
- file_count: 33
- total_bytes: 6017158
- scope: all files under .agent/ at snapshot_commit + root shared rule/handoff files
- 機械可読版: `MANIFEST.json`。`shasum -a 256 -c SHA256SUMS` 互換のハッシュ一覧: `SHA256SUMS`（このディレクトリで実行）。
- 各ファイルのバイト列は `git show <snapshot_commit>:<original_path>` と同一（作業ツリーではなくcommitから取得）。

| original_path | archive_path | size | SHA256 | snapshot元commit |
| --- | --- | ---: | --- | --- |
| `.agent/ACTIVE_TASK.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/ACTIVE_TASK.md` | 21535 | `302f85bcee66eeca9cd56494d4902128ba6d74850329f68489f92594f58ec9a3` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CHATGPT_HANDOFF.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CHATGPT_HANDOFF.md` | 3163 | `6abdbc20eb9ee56cf5e7d0dc25d658591d0ecab0bb214f5a9dae5cd9dbf5d364` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CLAUDE_REPORT.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CLAUDE_REPORT.md` | 5330 | `cf129783c0f0568b04a692f2fd52bfb9442023e282f88b2e65d468837d24dd93` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CODEX_REPORT.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CODEX_REPORT.md` | 525969 | `33cb918645145f1940587953f996831f085ac9c9bf18325c11cd7ff3eeada4f6` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CODEX_REPORT_2.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CODEX_REPORT_2.md` | 814077 | `ae042e68d34946ce69811cda4a734e93c085a94de8e214694cb432d13a11753b` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CODEX_REPORT_3.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CODEX_REPORT_3.md` | 16592 | `8428e2c3f7f14dd09edfd8a850998cdca789dd778403d0b94a8c2e984b14e54c` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CODEX_REPORT_4.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CODEX_REPORT_4.md` | 14368 | `eaefd6b030dd868364a86883df11ec20356e4c2228b9aa95e00db636d52fed16` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CODEX_REPORT_5.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CODEX_REPORT_5.md` | 6205 | `192d33225ca775dee986e890c1b4f03bec3dbbe5249fc5ebda6efc01dc4e5e0d` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/CURRENT_STATE.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/CURRENT_STATE.md` | 795940 | `a692cb52d082cc0a18c0220ef580c9fa537b52c8bbeb203b35fef7b4d86fabf1` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/ORCHESTRATION.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/ORCHESTRATION.md` | 33520 | `97e2185d17c4f0a022674525268bb3c00783d4b9c3324f2e587fed625e261276` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/archive/CLAUDE_TASK_4_pre_threads_20261011.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/archive/CLAUDE_TASK_4_pre_threads_20261011.md` | 307561 | `3ab04a32937ed6c2bc0c8d8809d58b64faec52f58a115a6bc58d3b93d93a9027` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/archive/CLAUDE_TASK_4_threads_edge_pre_codex_20261011.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/archive/CLAUDE_TASK_4_threads_edge_pre_codex_20261011.md` | 9222 | `3da37797f41365b3baceb29ae24ee50774236846a35837b4df696748e7b5f69e` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/room_handoffs/X_AUTOPOST_CHAT.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/room_handoffs/X_AUTOPOST_CHAT.md` | 3700 | `5abea8f1adb531fb7a5f9c8e453e081e5cee1d8ddf4f9772f3c0306dc09452fa` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK.md` | 804227 | `620e7454ff1bee47af2fe8ca75d07810ff9851d046ff0cf14245fbd0ea7270dc` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_1.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_1.md` | 576539 | `a38443b3cbf178133189d9617e887ce5c3f00dd2e4d771ef7432762fc56650e1` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_10.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_10.md` | 13301 | `d5d8f7bf4f855485cb476fa97d94e361c516bf03bf18e205122b009b35d96ce8` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_3.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_3.md` | 497403 | `0bf58f022cafe851484f2cec1d7951712e90351f4afe42988a7fd09c782b9531` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_4.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_4.md` | 97406 | `c3f40f59da890062961f71f6a2c09e05ba7efb091346c1c020e6289336fff7e6` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_5.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_5.md` | 618761 | `9458ec9dbd7984ddccaed5be6318d20dcc6c28073b827bea011c902395660909` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_6.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_6.md` | 88851 | `56180424dd054756621694d7cf679557c78b8ba5c02504d95f94c5d756c90180` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_7.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_7.md` | 17627 | `d7559f747e2ea7990f95f824e224683130e1ecbed43beb6cfcd542cc6ca7e209` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_8.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_8.md` | 62254 | `b1970df9f14a047ba24a2643fec290109a23e1af903aa23e68122962ca505d26` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CLAUDE_TASK_9.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CLAUDE_TASK_9.md` | 50686 | `8794ca15c621c5c1a6c32d4ce64457c3c4c1f6ec6ffcac2f06dcf361ef153787` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CODEX_TASK.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CODEX_TASK.md` | 285770 | `072a47249ac5746c1a7c22398276432d83a15dc8cd0ff09869e99a018e7e23bf` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CODEX_TASK_2.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CODEX_TASK_2.md` | 218981 | `858efc7cf89c557ed9d359a45b55c39f0199315530b6ccee29183fe6e73baca5` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CODEX_TASK_3.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CODEX_TASK_3.md` | 24175 | `fb6f8a18540fa0c5a2a2e905979f8db3ab75c205bd3da8cfda1495a4ed63b471` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CODEX_TASK_4.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CODEX_TASK_4.md` | 12987 | `7826db8843a6f5970aa729a6ebbae6909b01df4336ec4001337ce0a8c8f246a5` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `.agent/tasks/CODEX_TASK_5.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/.agent/tasks/CODEX_TASK_5.md` | 16090 | `fe948ddfd9c92aafc36acbe68bf12d26b01c142bb6117f69e09ea819f67071ec` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `AGENTS.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/AGENTS.md` | 2706 | `f32a3b959ae794713527b7fde1fc2349eef7f5d6cf56116b25412916955ede07` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `CLAUDE.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/CLAUDE.md` | 2602 | `9ced1cdf51de384c804b8216aafff029d57874795d80d79152ca7c98133e25cc` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `HANDOFF.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/HANDOFF.md` | 49771 | `180ce7cf74f0c5f1a9f6c2dd56f61285ee036b4ca582f7f2e84764becd84cc9c` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `HANDOFF_TEMPLATE.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/HANDOFF_TEMPLATE.md` | 737 | `338d724192a2c10dc9bffa947b4584434102f07c1da2adb2ec3704cab810c70a` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
| `PROJECT_RULES.md` | `.agent_v2/archive/2026-10-12-initial-migration/files/PROJECT_RULES.md` | 19102 | `f2de98a8c0ee6e86d80bc74bbd7df242b3af965fed4b6deb9db72975923a9abf` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` |
