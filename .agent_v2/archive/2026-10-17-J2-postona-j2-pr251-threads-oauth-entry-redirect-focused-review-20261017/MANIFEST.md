# J2 PR251 archive verification (2026-10-17)

- original_commit: d6cee18234ebcc7c5b4765f237ecb26ca112b2f4
- snapshot_commit: 6ffc247609fcf4f2ab7f61c85ad454553e51904f
- task_id: postona-j2-pr251-threads-oauth-entry-redirect-focused-review-20261017
- verified_by: next J2 PR258 startup; append-only, snapshots untouched

| original_path | archive_path (this folder) | bytes | SHA256 | original/archive Git blob |
| --- | --- | ---: | --- | --- |
| .agent_v2/tasks/J2.md | J2.md | 3185 | e71898bd39955826044d5fc212b011f3c9af0f5049d7492f8968db0d1df5414f | 6dccd9a054ece5211d2e5748774f1d5f9318517a |
| .agent_v2/reports/J2.md | J2_REPORT.md | 10602 | 114cc8e0883a40c66d68f3183045918faa6728892b8e14d4039a78f27d2fb490 | 08685ebfb2d91f7f9fc8342eb95067836ca2c88e |

Restore verification: compare archive file Buffer bytes to git show original_commit:original_path with Buffer.equals, both PASS. SHA256, byte size and Git blob independently calculated. No original snapshot rewriting/deletion.
