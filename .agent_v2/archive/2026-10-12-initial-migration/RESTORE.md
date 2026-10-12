# RESTORE — 2026-10-12-initial-migration

旧 `.agent/` 系統の初回移行snapshot。snapshot元は main commit `d811b4dc72f3e65fc61e40ae99e61b2094b18ff7`（G10 TASK登録の直後）。

## 中身

- `files/` — 元のリポジトリ相対パスのまま（`files/.agent/...`、`files/PROJECT_RULES.md` など）。各ファイルは `git show d811b4dc72f3e65fc61e40ae99e61b2094b18ff7:<original_path>` のバイト列そのもの（作業ツリーではなくcommitから取得）。
- `MANIFEST.md` / `MANIFEST.json` — original_path・archive_path・size・SHA256・git blob・snapshot元commit。
- `SHA256SUMS` — `shasum -a 256 -c` 互換。

対象は snapshot時点の `.agent/` 配下の全28ファイル（G1〜G10 TASK、H1〜H5 TASK・Report、ACTIVE_TASK、CURRENT_STATE、ORCHESTRATION、CHATGPT_HANDOFF、CLAUDE_REPORT、`.agent/archive/` 2件、`.agent/room_handoffs/` 1件）と、共有ルール・引き継ぎの5ファイル（`PROJECT_RULES.md`、`AGENTS.md`、`CLAUDE.md`、`HANDOFF.md`、`HANDOFF_TEMPLATE.md`）の計33ファイル。

## 確認方法

このディレクトリで:

```bash
shasum -a 256 -c SHA256SUMS
```

snapshot元commitとの一致（リポジトリ内で）:

```bash
git show d811b4dc72f3e65fc61e40ae99e61b2094b18ff7:.agent/CURRENT_STATE.md | shasum -a 256
```

## 復元方法

1. 専用の一時worktreeを snapshot元commit（または復元したいcommit）で作る。
2. そのworktreeのリポジトリルートへ `files/` の中身をコピーする（`cp -R files/. <worktree>/`）。
3. `git status --porcelain` と `git diff` で差分を確認する。snapshot元commitで行えば差分は0件になる。

## 2026-10-12 の確認結果

- `shasum -a 256 -c SHA256SUMS`: 33件すべてOK。
- 別手段での照合: 33件すべて、`git show <commit>:<path> | shasum -a 256` と一致し、`git hash-object` もcommit内のblob idと一致。
- 復元テスト: snapshot元commitの一時worktreeで対象33ファイルを削除（33件の変更）→ `files/` から復元 → `git status --porcelain` 0件。一時worktreeは確認後に削除した。

このディレクトリはappend-only。書き換え・削除・短縮しない。
