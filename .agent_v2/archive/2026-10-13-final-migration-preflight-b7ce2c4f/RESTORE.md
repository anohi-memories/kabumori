# Restore verification

Actual restore results are recorded in RESTORE_RESULT.json. All 33 original paths were restored into a fresh temporary directory, compared byte-for-byte with the pinned source commit, and verified against Git blob IDs. All three full PR patches were applied to their archived base copies in separate temporary directories; resulting files matched their pinned PR heads.

From this snapshot directory run `shasum -a 256 -c SHA256SUMS`. To restore, read MANIFEST.json `files`, copy each archive_path to a NEW EMPTY directory under its original_path, then compare size and SHA256 and Git blob ID. Never restore into a live slot checkout. PR base/head files are preservation evidence, not current TASKs.

This is a pre-cutover snapshot candidate. New main/control writes invalidate its freshness for cutover; preserve it append-only and create a new snapshot rather than updating it.
