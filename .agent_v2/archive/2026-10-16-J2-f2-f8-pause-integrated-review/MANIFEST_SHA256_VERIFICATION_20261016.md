# J2 independent SHA256 / restore verification — 2026-10-16

This append-only verification supplements (does not rewrite) `MANIFEST.json` and its historical pending note. Archived originals and the existing `SHA256SUMS` are unchanged.

- Previous task: `kabumori-j2-f2-f8-pause-runtime-integrated-security-review-20261015`
- Verification task: `kabumori-j2-f2-f8-pause-three-findings-focused-rereview-20261016`
- Source commit: `7f9aceca11e0d412f1428d9947ab93012e940d4e`
- Inspection baseline: `219ea8c7442dccb169de8912c031075036fa1644`
- Archive root: `.agent_v2/archive/2026-10-16-J2-f2-f8-pause-integrated-review/`

| Original path | Archive-relative path | Bytes | Source Git blob | Independently generated SHA256 |
| --- | --- | ---: | --- | --- |
| `.agent_v2/tasks/J2.md` | `files/.agent_v2/tasks/J2.md` | 5529 | `a0a1914f70ee97c2bbb830538dcc63aeb59ac377` | `c5375385ef00e1f5764e16eb35c376761293f10a3a197143ea8eb0df45318c69` |
| `.agent_v2/reports/J2.md` | `files/.agent_v2/reports/J2.md` | 24938 | `625ab52df4a18a7f06ce3120e3b16656298529cf` | `dbc6a8e7831c2be5516bec66ae054c854772e98c251e16aede7414b261af7bf3` |

Proof completed before reviewing product changes: SHA256 independently regenerated for both archived files; `shasum -a 256 -c SHA256SUMS` reports 2/2 OK. Both `git hash-object` results match recorded original blobs, and `git rev-parse <source-commit>:<original-path>` matches those blobs. Byte comparisons against `git cat-file blob <original-blob>` return exit 0 for both files. The original `size_chars` metadata is not a byte count; independently measured byte lengths are above. Source and archived content are byte-identical; no archived originals were changed.

Result: `PASS_SHA256_AND_BYTE_RESTORE_2_OF_2`. Startup archive gate satisfied. No managed/production/API/DB operations performed.
