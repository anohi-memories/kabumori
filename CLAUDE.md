# Claude entry point

作業を始める前に、次の2ファイルを必ず読むこと。

1. `PROJECT_RULES.md` — プロジェクトルールの唯一の正本
2. `HANDOFF.md` — 現在の作業状況、未完了事項、次の担当者への引き継ぎ

ルールが競合する場合は `PROJECT_RULES.md` を優先する。`HANDOFF.md` がまだ存在しない場合は、その旨を共有し、引き継ぎが必要な作業では `HANDOFF_TEMPLATE.md` を基に作成する。

`CLAUDE.md` 自体には詳細な運用ルールを重複させず、Claude向けの入口として保つ。

GitHub共有タスク運用は `.agent/ORCHESTRATION.md` を参照する。競合時は `PROJECT_RULES.md` を優先する。


## レビュー頻度の最新方針

作業開始時に `.agent/ORCHESTRATION.md` の「レビュー最適化方針（2026-09-25〜）」を必ず確認する。

- 低リスク変更は、原則としてCodexレビュー待ちで停止しない。
- UI、文言、prompt、画像、小規模バグ、テスト追加、既存仕様内の軽微なロジック変更は、TASKで別指定がなければClaude実装＋テスト＋Reportまで進める。
- 同一機能の連続した小修正は、1件ごとにレビュー前提にせず、安定化までまとめて進める。
- CodexレビューはDB/migration/RLS/認証/RPC/OAuth/Vault/secrets、外部実書き込み、X実投稿、cross-tenant、複雑な並行処理、破壊的production変更、重要release gateへ集中させる。
- ただしレビュー削減は安全確認削減ではない。テスト、dry-run、Preview、read-backはTASKに従って必ず実施する。
- TASKに「review deferred」「review not required」とある場合、それを尊重し、独自判断で不要なレビュー待ちを追加しない。
