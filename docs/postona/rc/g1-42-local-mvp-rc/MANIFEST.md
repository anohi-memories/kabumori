# POSTONA MVP 非本番 RC（G1 第42TASK）出典 manifest

- TASK: Issue #316 `postona-g1-42-local-mvp-integrated-release-candidate-g3-g4-g5-g6-20261103`
- 用途: 非本番・ローカル検証専用の統合候補。merge・deploy・フラグ ON の承認ではない。本番は NO_GO
- RC branch: `claude/g1-postona-mvp-local-rc-20261103`（#633 の固定 HEAD から作成）
- 基準の main: `92884b331043a4ff1e289ac8139a64fd46b6337f`（作業時の fresh origin/main）

## 取り込んだ source と順序

| 順 | 担当 | PR | 固定 HEAD | merge 後の RC commit | 衝突 |
|---|---|---|---|---|---|
| 0 | G1/H5 | #633（起点） | `5d478619260df654f1f226b44a2abc592763be7e` | （起点） | — |
| 1 | G5 | #602 | `76f6c8be32e2220be514ac2f9d02fa35a4b02cea` | `dfb96bebbbc4cf92185a67b8c4839fc374796847` | なし |
| 2 | G3 | #629 | `cc9a6572c29c059f75b54fb79fefbddaff2e485f` | `9c1974e0da60c7950c84374d739281005d5a1f2e` | なし |
| 3 | G4 | #617 | `1d020c406cc982eedfa29a8b682c96db31888a68` | `2bfd80bf02b73112aa9534a06681221d3f86a9d4` | G1 の画面 2 ファイル（下記） |
| 4 | G6 | #595 | `d68830bf8466e8a388e1d86b644937d07e03a2c2` | `1d88b18ff94e08cbab5d256782033640ba91093f` | なし |

- 方法: 各 PR の固定 HEAD を `git merge --no-ff` で取り込んだ（祖先の commit もそのまま含まれる）。rebase・cherry-pick・内容の書き換えはしていない
- 順序の理由: G5 の本人 SQL（#602）を G4 の writer（#617）より先に置き、「G4 writer は personal SQL より先に採用しない」という既存の警告を守る。G3 は G5 の後、G6 は最後
- 元の PR の HEAD・base・main は変更していない（push・rebase・reset・force push なし）

## 祖先チェーン（open の Draft PR。どれも main には merge されていない）

| 担当 | 先端 | PR の数 | 最下段 | main との merge-base | main から先の commit |
|---|---|---|---|---|---|
| G1/H5 | #633 | 37 | #274 → main | `74b6b7ceafe6b3683ee985616b3a4e2ddb04763d` | 105（このうち 66 は #629 と共有） |
| G3 | #629 | 55 | #145 → main | `4bdc4e61c8ed22e9039931a4fb7d3653829a5a5c` | 68 |
| G4 | #617 | 56 | #140 → main | `9fef46590917be9ff9083811c9ab186d8083683f` | 70 |
| G5 | #602 | 15 | #531 → main | `0c42933ca5030ab31a56267529430d0473d9b155` | 15 |
| G6 | #595 | 43 | #187 → main | `c8a4ff368d7c9958cb57aea61e49db799fa43f09` | 47 |

- 5 本の和集合は open PR 206 件。各祖先 PR が個別に受入済みかは、このTASKで1件ずつは確認していない（NOT_VERIFIED）。中央が固定した先端の SOURCE ACCEPT を前提にしている
- G3 と G1 は 66 commit を共有（G1 の積み上げが過去に G3 の積み上げを取り込んでいるため）。それ以外の組み合わせで共有する commit は 0

## 内容不変の確認

- G3・G4・G5・G6 が変更した `apps/social-mobile/` 以外のファイル（SQL candidates、Edge `_shared`、tests、migrations）は、RC で各 PR の固定 HEAD と一致した（差分 0 件、`git diff --name-only <tip> HEAD -- <その PR の変更 path>`）
- 新しい migration・GRANT・RPC・SECURITY DEFINER の追加や変更は、RC ではしていない。migration は G6 #595 の 3 件（`20261017120000_ai_consumer_call_store.sql`、`20261017150000_ai_ledger_user_erasure.sql`、`20261020154536_ai_calls_owner_held_rc_guard.sql`）だけで、内容はそのまま
- G3・G4・G5 の SQL はすべて `supabase/candidates/` の候補のままで、migration にはなっていない。RC はどれも適用・deploy しない

## 衝突と解消（G1 所有ファイルのみ）

G4 #617 は、Threads の接続・切断・投稿のカードを G1 のアカウント画面に追加している。H5 #633 は同じ画面の X 接続表示を変更しているため、次の 2 ファイルで衝突した。

- `apps/social-mobile/src/app/accounts/[id].tsx`: #633 の X 接続表示（未確認ラベルと説明）をそのまま残し、#617 の `ThreadsPublishCard` と `ThreadsConnectCard`（未接続の Threads のときだけ）を、#617 と同じ条件と同じ位置（投稿設定カードの後）に追加した
- `apps/social-mobile/src/app/accounts/index.tsx`: #633 の再接続・再開の判定をそのまま残し、#617 の `threadsAccount` と import を追加した。`ThreadsConnectCard` と `ThreadsDisconnectCard` の挿入部分は自動で merge された

## G1 の追加変更（RC 内）

- `apps/social-mobile/tests/x-connection-surfaces.test.mjs`、`apps/social-mobile/tests/x-reservation-composer.test.mjs`: #617 の Threads カードの import を、画面テストの stub に追加した。追加前は統合後に 5 件 FAIL、追加後は全件 PASS。統合の確認テストも1件追加した（Threads のカードと X の未確認表示が両方残ること）
- このファイル（manifest）

## 製品のフラグ

`POSTONA_RESERVATION_PERSISTENCE_ENABLED` と `POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED` は製品ソースで `false` のまま。ON にしたのはローカルの使い捨てコピーだけで、ここには含めない。

## 採用の前に必要なこと（RC では解除していない）

1. 祖先 206 件の merge 順は中央が決める（G5 personal SQL → G4 writer の順序は必須）
2. G3・G4・G5 の SQL candidates を migration にする手順と、その review（RLS・GRANT・SECURITY DEFINER）
3. 本物の OAuth・X、hosted、実機での確認
4. 現在の接続を確かめる判定口（G4/G5）ができるまで、X の接続表示は「未確認」のまま
