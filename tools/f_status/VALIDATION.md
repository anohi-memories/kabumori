# 検証記録 — 2026-10-26（JST）

- task_id: f15-status-lifecycle-20261026（ユーザー直接依頼のF読取実装、既存G/H TASKの登録・上書きなし）
- recommended_model: Codex Sol（高）
- base: origin/main `0c42933ca5030ab31a56267529430d0473d9b155`
- worktree: `kabumori-fresh`から作成した独立`codex/f15-status-lifecycle-20261026`
- changed_files: `tools/f_status/`内の新規ファイルのみ
- production_permission: NO_GO

## 実測

`node --experimental-transform-types --test tools/f_status/*.test.ts`: **30 PASS / 0 FAIL**。
型検査（Deno、no-remote）、lint、format、diff whitespace検査: PASS。

主要な確認はreadyの誤断定防止、同task_idのSTARTEDとfresh/expired heartbeat、TASK内容変更、異なるrun/slot、
REPORT優先、終了とREPORTの分離、STOP/CHANGES_REQUIRED、HISTORY/ACCEPTの順序とリンク不一致、
pilot/idle、取得途中変更、部分取得の扱い、既知ID/provenance、世代双方向リンク、書込み不確定時の再送なし。
実際の短時間Node子プロセスでSTARTED→定期heartbeat→EXITED、非zero終了でSTOPPEDを観測。 起動失敗、共有main、dirty
worktreeは拒否。使い捨てGit worktreeで独立checkout確認も検証した。 テストのGitHub writerはメモリ上の偽物のみ。実API
POST/PATCHは0。

## 実GitHubのread-only照合

現行15枠に実装したGET経路を実行し、Issue本文・コメント・件数を照合した。 その間に他担当が通常運用を進めており、G2-01
#317がClosed、後継G2-02 #532がidleへ世代交代した。 修正後の対象3枠再読（07:14
JST付近）で、#317→#532の双方向リンク追従とidleを確認。 G3
#318のREPORTは、説明中の旧CHANGES_REQUIREDを主判定と誤認せず**K3待ち**。 G1
#316はその間に新task_idへ変わっており、readyだけから未開始とせず**不明**。
これらは取得時点の結果で、現在の稼働状態の恒久的な宣言ではない。

最終の通常F経路（全件auditなし）も07:49〜07:50 JSTに15枠すべてGET成功。
K/C待ち4、idle5、pilot2、停止1、不明3。G2は#532を使用。
不明はSTARTED/heartbeat未接続のreadyやtask_id:none/status不整合によるもので、実際の未開始や稼働ゼロを意味しない。
既存の巨大コメントを会話へ返さず、分類と件数だけを出力した。

最初の実データ照合で、説明文中のNOT_VERIFIED/旧CHANGES_REQUIREDを拾う誤判定を発見した。
主判定の優先、旧判定説明の回帰テスト、後継Issue追従を加えて修正した。
末尾ページからの正の証拠と、不完全取得からの不在推論は区別し、必要時だけ明示auditを要求する。

## 未導入・未検証

実Claude/Codexの起動、実heartbeatのGitHub書込み、現役TASKへのhook/wrapper接続、Desktop callback adapter、 G10
supervisor接続は**未実施**。稼働中のlegacyセッションを本PRだけで自動計測できるとは主張しない。
本番DB/Auth/RLS/Edge/secrets/Cron/SNS、有料API、main変更、merge/deployは0。 G10 PR
#423の`tools/phase2_g10/`と既存15枠の本文・REPORT/HISTORY/ACCEPT原文は変更していない。 残る導入操作はREADMEに記載。Draft
PRのソース受入と実導入・本番承認を区別する。
