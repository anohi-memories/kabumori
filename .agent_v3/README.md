# .agent_v3（候補・未適用）

TASK登録を確実にするための管理基盤V3の**候補**。F10 `orchestration-v3-reliable-task-registration-f10-20261016` で作った。現行の運用は旧 `.agent/` と `.agent_v2/` のままで、このディレクトリはまだ使われていない。

- `EVIDENCE.md` — 「TASKと索引の片方だけが更新される」「書き込みが安全チェックで拒否される」の原因調査（確認済み・仮説・未検証）と、旧G方式・v2との比較
- `SPEC.md` — V3の仕様（正本1つ＋派生索引、1登録＝1commit、CAS、読み戻し、拒否時の停止、archive）
- `MIGRATION.md` — 段階移行の計画とGO / NO_GO条件
- `evidence/mismatch_scan.py` — 調査に使った、履歴の食い違い区間の抽出スクリプト（読み取りのみ）
- ツール: `scripts/agent_v3/`、テスト: `tests/agent_v3/`（`review_fixes.test.ts` は、2026-10-16の独立レビュー H1〜H3・M1〜M4・L1〜L7 に対する回帰テスト。F10 `orchestration-v3-pr229-security-review-high-medium-fixes-f10-20261016`）

ここには本番のslotを置かない。正式に適用するまで、F / J / G / H のTASKをここへ登録しない。
