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
全体統括が2026-10-17に受領した引き継ぎ書5件を参照して作成。原本の完全なGitHub保存・SHA256確認は別途必要（[SOURCE_REGISTER.md](SOURCE_REGISTER.md)参照）。要約は原本の代替ではない。

## 未完了
- アプリG1/F1の網羅的な製品UI/デザイン/審査一覧の確定
- 受領5原本のバイト単位保全とhash検証
- 本番の外部経路・古いキューまでの完全停止保証（Cron停止は確認済み）
