# MANIFEST — F10 `orchestration-v3-final-legacy-snapshot-and-pilot-readiness-f10-20261017`

v2 の決まり（MANIFEST.md / MANIFEST.json / SHA256SUMS）の未完了分として追加した。既存の `MANIFEST.json`・`SHA256SUMS`・写しは変更していない。

| original_path | archive_path | size | SHA256 | git blob | 元commit |
| --- | --- | --- | --- | --- | --- |
| `.agent_v2/tasks/F10.md` | `.agent_v2/archive/2026-10-17-F10-orchestration-v3-final-legacy-snapshot-and-pilot-readiness-f10-20261017/files/.agent_v2/tasks/F10.md` | 17763 | `6e887b0d488e41c8b784f3cf3859f3fad9390af3235226c5944b93572f969203` | `11fe14829f6c889f99f65c45396ef8534b22cdf0` | `c764af449ecc62d2af9c2a589e08120d1bbd23f8`（L10受入を含む最後の版） |

- `MANIFEST.json` の `source` は `main` と書かれている。元commitのSHAは、この表の値。写しのgit blobは、そのcommitの `.agent_v2/tasks/F10.md` と同じ。
- 照合（2026-10-17、F10 `orchestration-v3-incremental-index-fastpath-f10-20261017`）:
  - 空のディレクトリへ復元した結果、サイズ・SHA256・`git hash-object` が一致し、元commitのバイトとも一致した。
  - `shasum -a 256 -c SHA256SUMS` は OK。
  - HISTORY_INDEX の行（SHA256入り）も確認した。
