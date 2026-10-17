# かぶモリ 全体統括引き継ぎ（G1/F1）
基準日: 2026-10-17。アプリ開発・運用は当面休止し、**POSTONA優先**。未完了PRやTASKは消さず、再開時にfresh確認する。

## アプリ像
日本株投資支援。銘柄・ニュース・市況・AI分析・通知などを統合。主要領域は①アプリUIと銘柄機能（G1/F1）、②朝刊/大引け/Push/X（G2/F2）、③MIC（G7/F7）、④ニュース取得（G8/F8）、⑤APIコスト改善（G9/F9）。認証（G5/F5）とAI（G6/F6）はPOSTONAと共有し、休止対象から除外。

## 確認済みの主要成果
- 共通朝刊・大引け: 共通データpacketとAI分析packet、Xとアプリの共通consumer、ゆめちゃんの自然な文体と朝刊予想/大引け照合。TOPIXは指数利用条件未確定で表示・正式対応保留。
- MIC: Facts→State→Scenario、no_change時のAI節約、Evidence、Scenario read-gate。正式Verification Stage1 S1-Aは未着手/PR #125設計Draft。
- ニュース: 公式ソース主体＋必要時のみWeb検索。一般的な国内重大事件・不祥事・金融外ニュースの網羅性改善は将来課題。アプリ掲載SQL高速化はオフライン候補（例 PR #196）であり本番適用済みとは限らない。
- API費用: 権利未確認ニュース文章を含む評価データの非保持化候補（PR #190/#195）。実モデル有料比較・品質評価は未実施。
- アカウント: Supabase Auth共通ID＋サービス別entitlement、サービス利用終了と全ID削除を厳格分離。POSTONAサービス終了のG1/G2修正はF4/F5連携・レビュー途上で、本番完了ではない。
- 共通AI: OpenAI/Claude Provider、Consumer Bridge、費用上限/不明費用計上、operationId設計。POSTONAへのClaude実接続・永続重複防止は未完成、ソース候補と本番を区別。

## 実機・UI・将来構想
**G1/F1は本引き継ぎを作成した全体統括ちゃ自身の担当であり、担当不明・資料未収集と扱ってはいけない。** 以下は旧G1のGitHub TASK/Reportと引継ぎ済みユーザー決定から復元した記録。

- V1の5タブは**ホーム／銘柄／ニュース／レポート／メニュー**。Root Stackと戻り先遷移、ポートフォリオ・ウォッチリスト、銘柄検索・銘柄詳細、ニュース、レポート、設定、ログイン、オンボーディング/スプラッシュが主要画面。旧G1の2026-10-12リリースギャップ棚卸しはDraft **PR #160**（`docs/release-readiness/kabumori-app/V1_GAP_INVENTORY_2026-10-12.md`）に**必須10／推奨8／公開後5=23件**を記録。G1のK1ではソースとして画面が概ね揃っているが、iOS実機・本番ビルド・実配信の完成とは区別。
- ユーザー希望UI: ホーム最上部へ「今日の重要」を置くこと、ゆめちゃんの8表情、ニュース/トピックの背景3種、新聞＋上昇チャート＋葉のアプリアイコン案、スプラッシュ3枚。素材の実ファイル・採用/実装状況は別途ソースと照合する。決定案を実装済みと断定しない。
- **AIに聞く**はV1で非表示にせず実装するユーザー判断。対象は **②保有銘柄への質問、③ニュース・市場情報に基づく回答**。入口はホーム・メニュー・ポートフォリオの3つ。旧G1 Phase AはUI/契約とモック限定のソース候補（本番AI接続ではない）。G2のオンデマンド定型分析とは別機能。本人データ・同意・利用権・RLS・費用・鮮度を実装前に検証。
- F1の最新task_id `kabumori-f1-ai-ask-b0-terminal-finish-auth-fix-20261014` は **done**。Draft **PR #194** は終端`finish_ai_ask`の冪等再送が同意撤回・退会・ゲートOFF後に回答を漏らす認可問題の**設計修正候補**。実B1のRPC/Edge/DB/AI接続・本番適用は未実施、production NO_GO。関連PR #166/#171/#177/#186は設計の前段階。
- リリース準備をG1が分解した順序: **①未完成機能の棚卸し→②UI仕上げ→③G2共通レポート統合→④G5共通アカウント統合→⑤iPhone実機確認→⑥公開準備**。2026-10-12の棚卸し時点では、法務Web URL・公開運営者情報/プライバシー、認証メールURL、共通ID削除、Push実機到達、App Store Connect素材と審査アカウント、AIに聞くの未接続などがrelease blocker。後続の最新状態は再確認。
- PR #156は旧G1で戻り先・銘柄数修正としてマージ済みと旧TASKに記載。レポートのQA値527 passed（2026-10-12 clean main）も当時の検証値であって現在の再実行証明ではない。
- 休止中、公開/審査/有料APIの工程を勝手に再開しない。EAS月次制限に配慮し、ローカルで確認して大きな変更時だけビルドするユーザー方針を尊重。

## 新旧運用
- 旧G/Hタスクは旧系統で完結。新F/Jタスクは新系統。30slot、独立worktree必須。
- `PROJECT_RULES.md`, `.agent/ORCHESTRATION.md`, `.agent_v2/ORCHESTRATION.md`を守る。
- 2026-10-17照合: F1 done (AIに聞くB0のAuth残件/production NO_GO)、F2 review_required、F7 readyだが休止により開始禁止、F8 review_required、F9 done。F5/F6はPOSTONA継続TASKが進む可能性が高く、将来のfresh確認必須。
- Draft PRはSource候補。PR番号やテストPASSだけでmainマージ/本番deployを推定しない。

## 安全制約
POSTONA X/Threads投稿・予約、共通認証/entitlement、共通AI、Secrets、共有RPC/Edge/DBを保護。ユーザーの明示承認なくCron再開、migration/RLS/Auth、外部API実書込み、実SNS投稿、課金AI試行をしない。停止の最新実績は [PAUSE_STATE.md](PAUSE_STATE.md)。

## 実装の再開順序（提案、未承認）
(1) 現行GitHub・production read-only棚卸し → (2) UI/仕様の再定義とビルド環境確認 → (3) 情報権利・Auth・料金/契約の安全ゲート → (4) 古い候補PRの採否 → (5) OFFLINE/Preview検証 → (6) 明示承認後の段階的production再開。
