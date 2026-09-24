# Agent Orchestration

## 位置づけと優先順位

この文書は、ChatGPT（ちゃ）・Codex（こでさん）・Claude Code（くろちゃん）がGitHub上の最新指示と完了報告を共有するための運用正本です。

- `PROJECT_RULES.md` を最優先とする。
- `AGENTS.md` / `CLAUDE.md` の開始手順にも従う。
- `.agent/` は共有タスク運用専用。既存の別用途handoff文書は勝手に置き換えない。
- 通常の実装主担当はClaude Code。Claude実装枠はG1〜G4の4枠。
- Codexは通常、レビュー・バグ修正・検証を担当。Codex枠はH1/H2の2枠。
- Claudeが5時間利用制限に到達した場合に限り、ChatGPTの判断でCodexへ臨時実装を割り当ててよい。
- 並行作業はtask_idと変更対象が安全に分離されている場合だけ許可する。

### 固定ルーティング（2026-09-24〜）

- `G1` / `G2`: かぶモリアプリ（モバイルアプリ本体）開発
- `G3` / `G4`: X自動投稿アプリ開発
- ユーザーから個別TASKについて明示指示がある場合はその指示を優先する。
- Codex（H1/H2）はアプリ別に固定しない。原則レビュー・バグ修正・検証を担当する。

## タスク正本

- Codex H1: `.agent/tasks/CODEX_TASK.md` / `.agent/CODEX_REPORT.md`
- Codex H2: `.agent/tasks/CODEX_TASK_2.md` / `.agent/CODEX_REPORT_2.md`
- Claude G1: `.agent/tasks/CLAUDE_TASK_1.md`（ReportはTASK内）
- Claude G2: `.agent/tasks/CLAUDE_TASK.md`（ReportはTASK内）
- Claude G3: `.agent/tasks/CLAUDE_TASK_3.md`（ReportはTASK内）
- Claude G4: `.agent/tasks/CLAUDE_TASK_4.md`（ReportはTASK内）

`.agent/ACTIVE_TASK.md` は6枠の索引、`.agent/CURRENT_STATE.md` は短い現在地として扱う。詳細指示と割当の正本は各TASK/Report。

## 役割

### Claude Code（くろちゃん）

通常の新機能開発・大規模変更・継続実装を担当する。G1〜G4を使う。

### Codex（こでさん）

通常は以下を担当する。

- Claude実装後のコードレビュー
- バグ調査・修正
- テスト追加、不足テスト確認、回帰確認
- セキュリティ・権限・境界条件の確認
- deploy前確認
- 実装内容と仕様の整合性確認

Claudeの5時間制限時だけ、ChatGPTがH1/H2へ「臨時実装」と明記したTASKを置ける。その場合、対象範囲・安全制約・完了条件もTASKへ明記する。

### ChatGPT（ちゃ）

全体オーケストレーションを担当する。

- 実装タスクをG1〜G4へ安全に分割する
- スロット間の競合を避ける
- 実装の節目と変更リスクからCodexレビューの要否を判断する
- 必要な場合、未割当のH1/H2へ具体的なレビュー/バグ修正TASKを作る
- Codex結果を確認し、必要ならClaudeへ修正を戻す
- production反映前の確認工程を組み立てる

レビューを検討する代表的な節目:
- 機能単位の実装完了
- DB schema / migration / RPC / Edge Function変更
- API・外部サービス境界変更
- 認証・権限・セキュリティ変更
- 複数ファイル・複数レイヤーにまたがる大きな変更
- 重要バグ修正後
- production deploy前
- 回帰リスクが高い変更後

固定条件ではない。軽微・低リスク変更では省略でき、高リスク変更では途中でもレビューを入れられる。

レビューTASKには対象branch/commit/PR、目的、重点確認事項、安全制約、必要な検証、完了条件を記載する。既存TASKを上書きしてはならない。

## 作業開始コード

### G1 / G2 / G3 / G4 — Claude

- `G1`: `.agent/tasks/CLAUDE_TASK_1.md`
- `G2`: `.agent/tasks/CLAUDE_TASK.md`
- `G3`: `.agent/tasks/CLAUDE_TASK_3.md`
- `G4`: `.agent/tasks/CLAUDE_TASK_4.md`

Claudeに単独で `G` が来た場合、ready/in_progressの開始可能枠が1つだけなら開始してよい。複数なら推測せずG1〜G4の指定を求める。

### H1 / H2 — Codex

- `H1`: `.agent/tasks/CODEX_TASK.md`
- `H2`: `.agent/tasks/CODEX_TASK_2.md`

H1/H2は原則レビュー・バグ修正・検証用。TASKに「臨時実装」と明記されている場合だけ実装担当として作業してよい。

### 共通開始条件

開始前に `.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、自分のTASK、Git状態を確認し、必要に応じて`origin/main`をfresh-checkする。

statusが`ready`または`in_progress`のTASKだけ開始する。`idle` / `done` / `review_required`では開始しない。

新しいTASKは「未割当」であることが明確な枠だけに置く。`idle`だけを空き判定に使わない。task_id、既存TASK本文、Report、next_ownerも確認し、既存割当を保護する。曖昧なら上書きせず停止する。

## 完了確認コード

### C1 / C2 — Codex

- `C1`: H1だけを確認
- `C2`: H2だけを確認
- 単独`C`は使用しない

対象TASK、対応Codex Report、必要な範囲のCURRENT_STATEを確認し、レビュー内容、修正内容、テスト、commit/push/deploy、残課題、安全確認を評価する。他スロットを勝手に完了処理しない。

### K1 / K2 / K3 / K4 — Claude

- `K1`: G1
- `K2`: G2
- `K3`: G3
- `K4`: G4

対応TASK内のReportと必要な範囲のCURRENT_STATEを確認する。TASK完了条件、実装、テスト、commit/push/deploy、残課題、他スロット影響を評価し、Codexレビューが必要かChatGPTが判断する。

単独`K`は、未評価の完了対象Claude枠が1つだけと明白な場合だけ使用する。複数ならK1〜K4を指定する。

### F — 全体統括

`F`は特定タスクの完了コードではない。以下を確認する。

- `.agent/ACTIVE_TASK.md`
- `.agent/CURRENT_STATE.md`
- H1/H2のTASKとCodex Report
- G1〜G4のTASK内Report

6枠の状態・競合・実際の空き状況・レビュー待ち・deploy待ちを整理する。別チャット担当の個別TASKを文脈なしに完了扱いしたり次工程へ進めたりしない。

## 完了報告のGitHub同期

作業終了・停止時は自分のスロットのTASK/Reportだけを更新し、可能な場合はGitHubへ同期する。

- H1: `.agent/tasks/CODEX_TASK.md` + `.agent/CODEX_REPORT.md`
- H2: `.agent/tasks/CODEX_TASK_2.md` + `.agent/CODEX_REPORT_2.md`
- G1〜G4: 各TASK末尾の`## Report`

Reportにはtask_id、result、changed_files、tests、commit_hash、push、deploy、remaining_issues、safety_checks、next_recommendationを含める。

実装コードを安全にpushできない場合でも、他workstreamの変更を混ぜず、clean worktree等の安全な方法で自分の制御ファイルだけを同期できるか検討する。non-fast-forwardや同じ制御ファイルの競合があれば上書きせず停止する。

## 並行作業と競合防止

- G1〜G4 / H1・H2を並行稼働させる場合、各slotは**専用の独立Git worktreeまたは独立checkout**を使う。同一ディレクトリを複数セッション/slotで共有しない。Git branchが別でも作業ディレクトリが同じなら独立とはみなさない。
- 作業開始時に、`git worktree list`等で自分の作業ディレクトリとbranchを確認し、他slotと共有されていないことを確かめる。既存の別slotのworktree/checkoutへ切り替えて作業しない。
- 各slotは他slotのbranchをcheckout/reset/rebaseしない。他slot所有の未コミット変更・作業ファイルを変更、削除、stage、commitしない。必要な変更の引き継ぎは所有者と内容を確認し、明示的に合意した安全な方法で行う。
- dev serverは可能な限り自分のworktreeから起動し、他slotのserverを停止・再起動しない。serverの作業ディレクトリや所有者が確認できない場合は操作しない。
- shared checkoutしか利用できず、安全な独立worktree/checkoutを作成できない場合は作業開始前に停止し、理由と必要な対応を報告する。共有状態のままbranch切替やreset等で作業を進めない。
- 6枠は別task_idかつ変更対象が分離される場合のみ同時進行可能。
- 同じファイルを複数枠で同時編集しない。
- 同じDB migration / RPC / Edge Function / workflow / production設定 / API境界 / 認証・権限ロジックを複数枠で同時変更しない。
- 一方のpush後、他枠はpush前にfresh `origin/main`確認をやり直す。
- 既存未コミット変更は他workstreamの所有物として扱い、変更・削除・stage・commitしない。
- scope、所有者、競合可能性を安全に判断できない場合は作業を開始せず、具体的な競合箇所を報告する。
- 未実施を成功扱いにしない。push / merge / deployは実際に確認できた場合だけ完了として報告する。

## 基本フロー

原則:

Claude実装 → ChatGPT完了確認 → ChatGPTがレビュー要否判断 → 必要なら空きH枠へCodexレビュー/バグ修正 → ChatGPT確認 → 必要ならClaudeへ差し戻し → 最終確認 → deploy

小規模・低リスク変更ではCodexレビューを省略してよい。高リスク変更では複数回レビューを入れてよい。

## モデル運用（2026-09-24〜）

Claude向けTASKには推薦モデルを併記する。候補:

- Sonnet5（中）
- Sonnet5（高）
- Sonnet5（極高）
- Opus5.5（中）
- Opus5.5（高）
- Opus5.5（極高）

Sonnet5で安全に処理できる作業はSonnet5を優先する。設計判断、複数レイヤーにまたがる変更、認証/権限、DB/RPC/Edge Function、高リスクなproduction変更などはOpus5.5を使用する。

## MICおよびその他案件

G1〜G4に安全な空き枠がない場合、既存スロットへ無理に割り込ませない。その場合はChatGPTが直接コピーしてClaudeへ渡せる完成指示を作る。
