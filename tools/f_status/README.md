# F専用15枠の稼働判定（導入前の候補）

正本は
[#299 STATUS_LIFECYCLE（2026-10-22）](https://github.com/anohi-memories/kabumori/issues/299#issuecomment-6331946028)。
推薦モデル／推論: Codex Sol（高）。ユーザー直接依頼の独立F作業で、H枠を消費・上書きしない。本番 NO_GO。

## Fを読む

Node 24で実行（V3のTypeScript parameter
propertyを読み込むためtransform-typesが必要）。認証は既存ghに任せ、tokenを取得・表示・保存しない。

```sh
node --experimental-transform-types tools/f_status/cli.ts F
node --experimental-transform-types tools/f_status/cli.ts F --json
# 欠落・重複・不明、または必要な証拠が取得tailより古い場合だけ限定監査
node --experimental-transform-types tools/f_status/cli.ts F --audit
```

`F`/`f`完全一致のみ。旧F/Jの30枠へ拡大しない。F経路はGETのみで、TASK編集・受入・起動・merge/deployを実行しない。
既定は最新100コメントの末尾ページと本文の既知ID単体GET。取得前後の本文・更新時刻・件数が変われば不明。
末尾ページの開始ID以降にある同task_id証拠は判定できる。古い証拠や不完全な取得から「開始していない」とは推論しない。
全件監査は明示的な`--audit`のみ。無type・task_id無しコメントも取得件数と種類別集計に残す。出力には原文全件を流さない。
50件世代交代は、Closed旧Issueの`successor_issue`/`next_issue_url`、新Issueの`predecessor_issue`、slot、次世代番号と旧Issue再読を照合する。
リンク欠落・循環・世代不一致は不明。番号を推測しない。G2の#317→#532も追従する。

| 判定         | 必要な証拠                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------ |
| 実行前       | 記録方式導入を明示したQUEUEDと、その後のコメント範囲の確認。readyだけでは不可                    |
| 実行中       | 同task_id・run_id・TASK内容hashのSTARTEDと新鮮なheartbeat（既定180秒）。STARTED自体も最初のpulse |
| K/C待ち      | 同task_idの最新REPORT。本文readyとの食い違いは「状態更新遅延・証拠あり」                         |
| Done         | 同task_idのREPORT→HISTORY→受入ACCEPT。STOP/CHANGES_REQUIREDや保留の候補をDoneにしない            |
| 停止・要修正 | 最新REPORT/ACCEPTの主判定がSTOP/CHANGES_REQUIRED等、または実プロセスの失敗終了                   |
| 不明         | heartbeat失効・取得失敗・未導入・本文だけのin_progress/done・REPORTのない正常終了・不整合        |
| idle/pilot   | 未割当と正式稼働外を別表示                                                                       |

「実行中」は取得時点の実行プロセス観測で、作業内容の進捗や本番許可の証明ではない。説明文にある過去の差戻しや端末NOT_VERIFIEDを主判定と混同しない。
本文status/next_ownerの担当ちゃによる更新ではhashを失効させない。他のTASK内容変更では不明に落とす。

## 実開始とheartbeatの記録（まだ現役枠へ未導入）

このPRを作っただけでは既存のClaude/Codexセッションに観測機能は付かない。
以下は導入時の操作例であり、本TASKで実Claude/Codex・有料API・実コメント書込みを実行していない。
枠の既存TASK・開始ゲート・専有worktree・起動権限を先に確認する。オプションは権限承認の代わりにならない。

1. **次の未開始TASKから**全開始経路の計測導入を担当ちゃが確認。`queue`はQUEUED候補を標準出力へ出すだけ。投稿には`--publish`が必要。
   既存STARTED/REPORT/QUEUEDがあれば拒否する。既に動いているlegacy TASKを後付けQUEUEDで未開始に見せない。
2. 承認済みのCLIセッション全体を`run`で包む。spawn成功後にSTARTED、プロセス存続中60秒ごとにheartbeat、終了にEXITED/STOPPEDを生成。
   初回heartbeatコメント1件を以後更新し、STARTED/REPORT/HISTORY/ACCEPT原文を書き換えない。
3. 終了後、実装者が既存のREPORT投稿・read-backを行う。EXITEDはREPORTを代行しない。
   担当ちゃが本文in_progress/review_required更新、HISTORY/ACCEPT受入を正本どおり行う。

```sh
# 候補表示だけ。--publishを付けたときだけ同枠へ投稿する。
node --experimental-transform-types tools/f_status/cli.ts queue \
  --slot H1 --task-id APPROVED_TASK_ID --all-starts-instrumented
# AUTHORIZED_AGENT_COMMANDは既に承認されたCLIセッション。F自身は呼び出さない。
node --experimental-transform-types tools/f_status/cli.ts run \
  --slot H1 --task-id APPROVED_TASK_ID --worktree /ABS/DEDICATED/WORKTREE \
  --start-gates-passed --publish -- AUTHORIZED_AGENT_COMMAND
```

`run`も既定はローカル記録のみで、GitHub読取を行う。共有main checkout・dirty
worktreeを拒否し、HEAD/branch/worktreeと実行者を記録する。
`.f-status/`は専有worktree内の無視されたローカル記録。worktree単位の排他ファイルを残し、終了・失敗後は担当者が記録とGitHubを照合して**自枠だけ**解除する。
不確定な書込みを自動再送しない。記録失敗は投稿を停止し、既に承認されて動いているagentを勝手に再起動・強制停止しない。
heartbeatは期限切れ後に不明になる。停電・プロセス強制終了で終了記録が無くても実行中を永久表示しない。

## G10・Desktopとの導入境界

- G10の`run`は拒否する。`tools/phase2_g10/`、PID、launchd、台帳・鍵、G10初回自動起動は変更・実行していない。
  既存監督側の実開始／生存確認／終了箇所から`eventBody`と`publish`を呼ぶ接続だけを、G10担当の別承認下で行う。
  既存TASKの権限・NO_GO・署名境界をこの記録で広げない。
- Codex Desktopや既に開いているClaudeセッションは、このCLI wrapperだけでは計測できない。
  実開始／活動／終了コールバックを同じイベント形式へ接続する必要がある。未接続の枠は不明と表示する。
  CLIを二重起動して代用しない。STARTEDを代理で捏造しない。
- 導入順: Draft PRのソース確認→mergeの別承認→次TASKの1枠で記録の実read-back→担当ちゃのF読取へ採用→他枠へ順次。
  現在の15枠TASKの書換え・一斉起動・勝手な設定インストールは不要。

## 以前の仕組みの再利用と検証

V3 `scripts/agent_v3/registry.ts`のTASK header解析、ready→in_progress→review_required→doneという遷移契約と、
`github_backend.ts`のgh transportを再利用。旧ファイルの編集・旧履歴の移動は0。
main（0c42933c）には固定IssueのSTARTED/heartbeat統合は無く、調査時のユーザーClaude settingsにもhooksは無かった。
過去に別環境で使われた機構の完全な所在までは確認できていない。G10 Phase2は別branchの専有実装で、依存に加えていない。

```sh
node --experimental-transform-types --test tools/f_status/*.test.ts
deno check --no-config --no-lock --no-remote tools/f_status/cli.ts tools/f_status/*.test.ts
deno lint tools/f_status
deno fmt --line-width 120 --check tools/f_status
```

検証結果と実GitHub照合の限界は[VALIDATION.md](VALIDATION.md)。
