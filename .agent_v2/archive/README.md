# archive（append-only）

旧系統のsnapshotと、新系統で完了したTASK / Reportを保存する場所。

- **追加だけ。** 既存のディレクトリ・ファイルを書き換え・削除・短縮しない。新TASKから過去archiveを編集しない。
- 1つの保存単位 = 1ディレクトリ。名前は `<YYYY-MM-DD>-<内容>`（例: `2026-10-12-initial-migration`、`2026-10-20-F1-<task_id>`）。
- 各ディレクトリに `files/`（元の相対パスのまま）、`MANIFEST.md`、`MANIFEST.json`、`SHA256SUMS` を置く。保存直後に、そのディレクトリで `shasum -a 256 -c SHA256SUMS` を実行して全件OKを確認する。
- 保存単位ごとの完了作業は `../HISTORY_INDEX.md` から引く。通常のslot作業ではこのディレクトリを読まない。
- `.gitattributes`（`** -text -whitespace`）で、archive配下を改行コード変換と `git diff --check` の空白チェックの対象外にしている。原本由来の行末空白を直すとSHA256が変わるため。
- リポジトリ全体を検索するときは、旧ファイルの写しが重複して見つかるため、必要に応じて `.agent_v2/archive/` を除外する。

## 保存済み

| ディレクトリ | 内容 | snapshot元commit | ファイル数 |
| --- | --- | --- | --- |
| `2026-10-12-initial-migration/` | 旧 `.agent/` 全28ファイル＋ `PROJECT_RULES.md` / `AGENTS.md` / `CLAUDE.md` / `HANDOFF.md` / `HANDOFF_TEMPLATE.md` | `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7` | 33 |
