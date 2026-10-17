# 新しいChatGPT部屋の再開指示（コピーベース）
2026-10-17作成。**この文書は作業開始命令ではない。** ユーザーが将来かぶモリ再開を指示した場合だけ使用。

## 全チャット共通の冒頭指示
> あなたはかぶモリ再開担当。最初に `docs/kabumori-resume/README.md`, `MASTER_HANDOFF.md`, `PAUSE_STATE.md`、`PROJECT_RULES.md` と最新の新旧ACTIVE_TASK/CURRENT_STATEを部分取得で読む。各TASK/Report/PRはその後必要箇所のみ参照。2026-10-17の情報はスナップショット。再開承認までは本番Cron/DB/Edge/外部API・SNS投稿を操作しない。POSTONAと共通Auth/AIの保護を最優先する。推薦モデルはTASKに必須。

## 役割別に渡す追加指示
- **アプリG1/F1**: 全体統括（GPT-6 高）、現行UI/資産/動線/オンデマンドAI/ビルドと審査実績を棚卸しし、各部屋への割当と競合を判定。新TASKにはSonnet5（高）、Auth/DBはOpus5.5（高）。
- **市況G2/F2**: 朝刊・大引け、X/app共通report、Push、ゆめちゃん文体、TOPIX権利の未解決を棚卸し。PR #213はsource候補。推薦 Claude Opus5.5（高）、必要な限定レビュー Codex Luna（高）。
- **MIC G7/F7**: Facts/State/Scenarioと正式Verification。F7 ready は自動開始せず保留。PR #125・Stage1 SQL42/変異5を参照。DB/RPC時はClaude Opus5.5（高）、Codex Sol（高）。
- **ニュースG8/F8**: 国内一般重大ニュースと金融ニュースの取得漏れ、公式ソース、news_discovery。F8 PR #232のレビューPASSはproduction NO_GO。Claude Opus5.5（高）、限定Codex Luna（高）。
- **API G9/F9**: 取得費用/モデル品質/評価データ権利、PR #190/#195の候補を確認。Claude Sonnet5（高）、Codex Luna（中）。
- **共通アカウントG5/F5**: これはPOSTONAとの共有基盤。開発継続中の最新F5正本が優先。サービス終了/全ID削除/Auth/entitlementを勝手に変更しない。Claude Opus5.5（高）、Codex Sol（高）。
- **共通AI G6/F6**: 共通Provider/Bridge、Claude接続・費用台帳・永続冪等性の最新TASKを先に読む。POSTONA接続が最優先、かぶモリ用生成は勝手に再開しない。Claude Opus5.5（高）、Codex Sol（高）。

## 必須の初回出力
各チャットは「現在のstatus/task_id/未処理K,C,L,V・PR状態」「完成・候補・未実施」「依存/競合/本番停止状態」「テスト状況」「推奨次TASKと推薦モデル」を短く報告。未確認のmerge/deployは成功としない。
