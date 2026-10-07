# Kabumori Project Rules

## この文書の位置づけ

- このファイルを、長期的な方針・共通ルール・決定事項の唯一の正本とする。
- `AGENTS.md` と `CLAUDE.md` は担当ツール向けの入口に限定し、詳細ルールを重複させない。
- 短期的な作業の現在地、未完了事項、注意点は `HANDOFF.md` に記録する。
- GitHub共有タスク運用の正本は `.agent/ORCHESTRATION.md` と各 `.agent/tasks/*` とする。
- 記載が競合する場合は、このファイルを優先する。

## Codex / Claude の短縮開始コード

このプロジェクトでは、単独の `H1` / `H2` / `G1` / `G2` / `G3` / `G4` / `G5` は見出し指定や一般文字列ではなく、実装スロット開始コードとして扱う。意味をユーザーに聞き返さない。

- Codexに `H1` とだけ送られた場合: Codex slot 1。`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、`.agent/tasks/CODEX_TASK.md` を確認し、TASKが `ready` または `in_progress` のときだけ作業開始する。
- Codexに `H2` とだけ送られた場合: Codex slot 2。`.agent/ORCHESTRATION.md`、`.agent/CURRENT_STATE.md`、`.agent/tasks/CODEX_TASK_2.md` を確認し、TASKが `ready` または `in_progress` のときだけ作業開始する。
- `H1` / `H2` が `idle` / `done` / `review_required` の場合は勝手に新規作業を作らない。
- Claude Codeに `G1` は `.agent/tasks/CLAUDE_TASK_1.md`、`G2` は `.agent/tasks/CLAUDE_TASK.md`、`G3` は `.agent/tasks/CLAUDE_TASK_3.md`、`G4` は `.agent/tasks/CLAUDE_TASK_4.md`、`G5` は `.agent/tasks/CLAUDE_TASK_5.md` を自分のTASKとして扱う。TASKが `ready` または `in_progress` のときだけ作業開始する。
- 完了確認コードは Codex が `C1`/`C2`、Claude が `K1`/`K2`/`K3`/`K4`/`K5`（各Gスロットに対応、`K5`はG5専用）。
- 単独 `G` はG1〜G5の開始可能な枠が1つだけと明白な場合のみ、単独 `K` はG1〜G5の未評価のClaude完了対象が1枠だけと明白な場合のみ使用する。複数の場合は推測で選ばない。
- `F` はH1/H2のTASKとCodex Report、G1〜G5のTASKと各TASK末尾の `## Report`、`.agent/ACTIVE_TASK.md`、`.agent/CURRENT_STATE.md` を確認する全7枠の統括コード。個別TASKを文脈なしに完了処理しない。
- 並行作業・完了コード・競合防止の詳細は `.agent/ORCHESTRATION.md` に従う。

## 固定ルーティング（2026-09-24〜）

- `G1` / `G2`: かぶモリアプリ（モバイルアプリ本体）開発
- `G3` / `G4`: X自動投稿アプリ開発
- `G5`: 予備のClaude実装スロット。用途は固定せず、ユーザーまたはChatGPTが明示割当した場合のみ使用する。既存の基本ルーティングの自動fallbackにはしない。
- ユーザーから個別TASKについて明示指示がある場合はその指示を優先する。
- Codex（H1/H2）はアプリ別に固定せず、原則レビュー・バグ修正・検証を担当する。Claudeが5時間利用制限に到達した場合のみ、ChatGPTの判断でH1/H2へ臨時実装を割り当てることがある。

## MICおよびその他案件

- G1〜G5の既存TASK/Reportを保護する。MIC・その他を既存割当へ無理に割り込ませない。
- G1〜G4に安全かつ利用許可のある空きがない場合は、ChatGPTがClaudeへ直接コピーして渡せる完成指示を作る。
- G5がidleでもMIC用に自動消費しない。ユーザーまたはChatGPTによるG5への明示割当があり、真の未割当・変更対象の非競合・独立worktree/checkoutを確認できた場合のみG5を使用できる。

## レビュー頻度・Codex利用方針（2026-09-25〜）

ユーザー方針として、Codexレビューは高リスク変更と大きな節目へ集中させる。各Claude実装ごとに機械的にH1/H2レビューを要求しない。

- UI、文言、prompt、画像、軽微なバグ、テスト追加、既存仕様内の局所変更は、原則としてClaude実装＋ChatGPT確認で進めてよい。
- 同一機能の細かな連続修正は、1件ごとにレビューせず、テスト・dry-run・Preview等で安定化してから必要ならまとめて1回レビューする。
- Codexレビューを優先するのは、DB schema/migration、RLS/認証/権限、RPC/SECURITY DEFINER、OAuth/token/Vault/secrets、外部API実書き込み、X実投稿、cross-user/cross-brand境界、複雑な並行処理/idempotency、破壊的production変更、重大障害、重要release gate。
- レビューを減らしても、テスト・dry-run・Preview・read-back等の実証確認は減らさない。
- TASKまたはChatGPTが `review deferred` / `review not required` とした場合、Claudeは不要なCodex待ちを新たに作らず、指定された範囲まで作業を進める。
- 詳細な運用は `.agent/ORCHESTRATION.md` の「レビュー最適化方針（2026-09-25〜）」を正とする。

## Codex完了後の返却先（2026-10-07〜）

H1/H2の完了後に、ユーザーが `C1` / `C2` をどのちゃの部屋へ送ればよいか迷わないようにする。

- ChatGPTがH1/H2へ新しいTASK（レビュー・バグ修正・検証。臨時実装を含む）を作る時点で、TASK冒頭のヘッダーに必ず `return_to` と `completion_code` を記入する。
- `return_to` はG番号だけにせず、ユーザーが実際に戻るチャットを判別できる人間向け名称にする。原則として、そのTASKを依頼した元チャットを書く。例: `かぶモリアプリG1のちゃ`、`かぶモリアプリG2のちゃ`、`X自動投稿アプリG3のちゃ`、`X自動投稿アプリG4のちゃ`、`共通アカウントG5のちゃ`、`MICのちゃ`。
- `completion_code` は H1 → `C1`、H2 → `C2` だけを使う。H1に `C2`、H2に `C1` などの不一致はエラーとして扱う。
- Codexは返却先を推測せず、TASKの `return_to` / `completion_code` を正本とする。完了時はユーザー向け最終報告の末尾に「返却先」を表示する（例: 「かぶモリアプリG1のちゃへ `C1` を送ってください。」）。
- `return_to` / `completion_code` が欠落・不明・矛盾・不一致の場合、Codexは別の部屋へ返すよう案内せず、Reportと最終報告に「返却先未確定」と理由を明記してChatGPT確認待ちにする。
- 本ルール導入前から割り当て済みのTASKへ `return_to` を機械的に後付けしない。既存TASK/Reportの本文は保護する。
- 書式・判定・F確認の詳細は `.agent/ORCHESTRATION.md` の「Codex完了後の返却先（2026-10-07〜）」に従う。

## モデル運用

Claude向けTASKには推薦モデルを併記する。候補:

- Sonnet5（中）
- Sonnet5（高）
- Sonnet5（極高）
- Opus5.5（中）
- Opus5.5（高）
- Opus5.5（極高）

Sonnet5で安全に処理できる作業はSonnet5を優先する。設計判断、複数レイヤーにまたがる変更、認証/権限、DB/RPC/Edge Function、高リスクなproduction変更などはOpus5.5を使用する。

## 作業開始時

1. `PROJECT_RULES.md` を読む。
2. `HANDOFF.md` を読む。
3. GitHub共有タスク開始コードを受けた場合は `.agent/ORCHESTRATION.md` と該当TASKも読む。
4. リポジトリの状態を確認し、既存の未コミット変更を作業者の変更として尊重する。
5. 依頼範囲と無関係なファイルを変更しない。

## Mac移行後のローカル開発基準（2026-10-05〜）

- 新Macでの新規作業の clean base は `/Users/yuya/Developer/kabumori-fresh` とする。
- 旧 `/Users/yuya/Developer/kabumori` は既存worktree群の親リポジトリとして当面保持する。新規作業のbaseには使用しない。
- 既存のG1〜G5 / H1 / H2 worktreeは、各TASKが完了するまでそのまま継続してよい。旧repoおよび旧worktreeを、完了確認前に削除・rename・prune・resetしない。
- 新規slot作業は `kabumori-fresh` で fresh `origin/main` を確認し、そこからslot専用の独立worktreeまたは独立checkoutを作る。`kabumori-fresh` のmain作業ディレクトリ自体を複数slotで共有しない。
- G1/G2/G3/G4/G5/H1/H2/K1〜K5/C1/C2/Fの意味・開始条件・完了確認フローは従来どおりとする。
- `.env` などの秘密情報はローカル専用として扱い、stage / commit / pushしない。

## Production並行運用とG5優先度（2026-10-08〜）

ユーザー方針：共通アカウント（G5）は完成に必要なcritical pathとして**優先**するが、G5がactive/approvedであること自体を理由に、非競合の他作業を停止してはならない。優先度は「競合した場合にG5を優先する」という意味であり、プロジェクト全体のfreezeを意味しない。

- **Git上の非競合作業は継続可**：別ファイル・別機能・別migration/RPC/Edge Function/設定境界であれば、実装・テスト・commit・push・PR更新・mergeをG5待ちで止めない。
- **production作業も競合判定で扱う**：G5と具体的なmutation boundaryが分離されている場合、別slotのproduction deploy/writeを一律禁止しない。各TASKの承認・安全ゲートは個別に満たすこと。
- **G5優先で止める対象**：同じDB migration、同じtable/RPC/function、同じAuth/権限/RLS、同じEdge Function、同じsecret/settings/Cron/workflow、同じAPI境界、またはread-back/fingerprint基準を壊す可能性がある変更。競合時はG5を優先し、他方を待たせる。
- **同一Supabase DBのmigration/DDL**：対象が論理的に別でも、migration history・catalog・preflight fingerprintを共有するため、実際のDDL/write区間は同時実行しない。片方が完了・read-backしたら、他方はfresh baselineを取り直して続行する。これは数分単位のwrite区間の直列化であり、G5 TASK全期間の停止ではない。
- **mutation windowは短く保つ**：windowは実際のproduction write直前に開き、postflight/read-back完了後すぐ閉じる。ユーザー入力待ち、夜間待機、レビュー待ち、自然配信待ちなどの時間はwindowをACTIVEのまま保持しない。
- **待機中はlockを解放**：作業がユーザー操作待ち等で止まる場合、実writeが無ければwindowをCLOSED/PAUSED相当に戻し、他の非競合作業を妨げない。再開時にfresh競合確認を行う。
- **判断基準はslot名ではなく変更境界**：G5 vs G1〜G4/H1/H2という枠名だけで禁止しない。実際に触るファイル・DB object・Auth/RLS・Edge・settings・workflow・production resourceを比較して判断する。
- scopeや競合が曖昧な場合だけ停止し、具体的に何が競合するかを報告する。

## 変更と合意

- 全体方針、優先順位、共通ルール、恒久的な決定はこのファイルへ集約する。
- このファイルの内容を変える必要に気づいた担当者は、理由と変更案を提示し、プロジェクト責任者の確認を得てから更新する。
- `AGENTS.md` と `CLAUDE.md` は原則固定し、参照先や入口としての役割が変わる場合にだけ更新する。
- 実装上の判断でルールを暗黙に変更しない。例外対応を行った場合は、理由と影響を `HANDOFF.md` に残す。

## 引き継ぎ

- 担当交代時や未完了の状態で作業を終える時は、`HANDOFF_TEMPLATE.md` を使って `HANDOFF.md` を更新する。
- 完了したこと、未完了のこと、確認方法、既知の問題、次に行うことを具体的に記載する。
- 推測と確認済みの事実を区別する。
- 秘密情報、認証情報、個人情報、不要な生データは記載しない。

## 候補選定と除外ログ

- 自動投稿などの候補を選定する処理では、候補を除外した事実と理由を追跡可能なログへ必ず残す。
- ログには、少なくとも日時、処理または実行の識別子、候補を識別できる非機密のID（銘柄コードなど）、除外段階、機械判定できる理由コード、簡潔な説明を含める。
- 「条件不一致」だけで済ませず、重複、鮮度不足、データ欠損、閾値未達、禁止条件への該当など、後から判定を検証できる粒度で理由を記録する。
- 候補の本文全体、APIキー、トークン、Cookie、認証ヘッダー、個人情報などの秘密情報はログへ出さない。
- 一件も候補が採用されなかった場合も、実行結果と除外件数を記録し、原因を追跡できるようにする。

## 安全な開発

- G1〜G5 / H1・H2を並行稼働する場合、各slotは他slotと共有しない独立Git worktreeまたは独立checkoutで作業する。同じ作業ディレクトリを複数セッション/slotで共有しない。
- 各slotは他slotのbranchをcheckout/reset/rebaseせず、他slotの未コミット変更・作業ファイル・dev serverを変更、削除、stage、commit、停止、再起動しない。開始時に作業ディレクトリが他slotと共有されていないことを確認する。
- 安全な独立worktree/checkoutを用意できずshared checkoutしか使えない場合は、作業を開始せず停止して報告する。
- `.env`、APIキー、トークン、Cookie、秘密鍵などの秘密情報を表示、コミット、ログ出力しない。
- 変更前後に差分と対象ファイルを確認し、意図したファイルだけをステージする。
- 既存の未コミット変更を上書き、削除、整形、ステージしない。
- コミット前に、変更内容に応じた確認またはテストを行い、実施内容と結果を引き継ぎに残す。
- Expoに関するコードを変更する場合は、リポジトリで採用しているバージョンに対応する公式ドキュメントを確認する。現行の参照先は `https://docs.expo.dev/versions/v57.0.0/` とする。
