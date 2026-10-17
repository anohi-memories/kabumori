# かぶモリ 長期休止・再開ハブ
更新基準日: 2026-10-17 / 管理: G1/F1 全体統括 ChatGPT

## 最初に読む順番
1. [PAUSE_STATE.md](PAUSE_STATE.md) — 本番停止状態と再開禁止事項
2. [MASTER_HANDOFF.md](MASTER_HANDOFF.md) — 全体方針、担当、完成/未完成の区別
3. [RESTART_PLAN.md](RESTART_PLAN.md) — 新しい各チャットへの再開指示
4. [SOURCE_REGISTER.md](SOURCE_REGISTER.md) — 受領した各部屋の引き継ぎ原本の台帳

これは2026-10-17の長期保存用**スナップショット**であり、現在状態の正本ではない。再開時は `PROJECT_RULES.md`、新旧 `ACTIVE_TASK.md`/`CURRENT_STATE.md`、各TASK/Report、PR、本番 read-only を優先。

**運用休止と開発停止は別。** この文書があることを理由に古いready TASKを開始しない。POSTONA、共通ID、共通AI、共通DB/Secretsは保護する。

## 原本の扱い
全体統括が2026-10-17に受領した**引き継ぎ書5件の原本保存は完了**。[rooms/](rooms/) に合計214,682 bytesをバイト単位で保全し、GitHub読み戻しで5件すべてのサイズ・SHA256・全バイト一致を確認済み。元ファイル名、保存先、各サイズ・SHA256、原本保存commit、検証日時は [SOURCE_REGISTER.md](SOURCE_REGISTER.md) に記録した。要約は原本の代替ではない。

## 未完了
- アプリG1/F1の網羅的な製品UI/デザイン/審査一覧の確定
- 本番の外部経路・古いキューまでの完全停止保証（Cron停止は確認済み）

## 2026-10-17 最終read-only監査
[FINAL_AUDIT_2026-10-17.md](FINAL_AUDIT_2026-10-17.md) — **BLOCKED（完全休止の条件未達）**。本番Cronは43件中39件停止、共有Dispatcher2件・銘柄同期2件を継続。かぶモリの新規予約を作るplannerとGitHubの画像生成workflowが有効なため、既存予約消化後の自動停止は保証できない。19:27 JST時点の残存予約2件、古いready_for_publish候補30件、未送信通知0件。証跡・観測時刻・未確認範囲・次の判断は監査書を参照。本監査では本番変更・実SNS呼出しを行っていない。
