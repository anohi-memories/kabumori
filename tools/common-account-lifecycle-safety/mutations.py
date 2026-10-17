"""Defect-detection proof for the Phase 3i closure-logic tests. Applies ONE mutation at a time to a scratch COPY of the
tool directory, runs the Deno suite there (read permission only) and requires a failure; the unmutated control must
pass. The worktree is never edited; no network. Usage: python3 tools/common-account-lifecycle-safety/mutations.py"""
import os
import shutil
import subprocess
import sys
import tempfile

here = os.path.dirname(os.path.abspath(__file__))
P, W = 'protocol.ts', 'world.ts'
M = [
    # --- boundaries and facts -------------------------------------------------------------------------------------------
    ('a missing boundary no longer stops the closure', P, "  if (unmet.length) return stop('BOUNDARY_UNPROVEN', ...unmet);\n", ''),
    ('the orphan sweeper is no longer required', P, "export const REQUIRED_TO_START = ['state_predicate', 'writer_guard', 'person_token_edge_checks', 'orphan_sweeper'] as const;",
     "export const REQUIRED_TO_START = ['state_predicate', 'writer_guard', 'person_token_edge_checks'] as const;"),
    ('I3 is claimed without the Storage policy', P, "  if (dataPlane && b.storage_write_policy === 'attested') claimed.push('I3');", "  if (dataPlane) claimed.push('I3');"),
    ('malformed facts are interpreted', P, "  if (issues.length) return stop('FACTS_INVALID', ...issues);\n", ''),
    ('a stale sign-in may start a closure', P, "    if (f.reauth !== 'fresh') return stop('REAUTH_REQUIRED', `reauth=${f.reauth}`);\n", ''),
    ('a locked account may be closed', P, "  if (f.account === 'locked') return stop('ACCOUNT_LOCKED', 'a locked account is never closed by the self-service path');\n", ''),
    # --- time, containment ---------------------------------------------------------------------------------------------
    ('waiting long enough is treated as evidence', P, "  if (f.serviceData === 'unknown') {", "  if (f.elapsedSinceFreezeSec > 600 && f.serviceData === 'unknown') return run('auth_delete', 'waited');\n  if (f.serviceData === 'unknown') {"),
    ('a failed ban blocks the closure', P, "  if (f.containment.ban === 'not_attempted') return run('ban', 'containment (best effort)');\n",
     "  if (f.containment.ban === 'not_attempted') return run('ban', 'containment (best effort)');\n  if (f.containment.ban === 'failed') return stop('LIFECYCLE_INCONSISTENT', 'ban failed');\n"),
    ('a done ban skips the cleanup', P, "  if (f.serviceData === 'residue') {", "  if (f.serviceData === 'residue' && f.containment.ban !== 'done') {"),
    # --- cleanup and reads -----------------------------------------------------------------------------------------------
    ('service data residue is ignored', P, "  if (f.serviceData === 'residue') {\n    return f.attempts.cleanup >= LIMITS.cleanup ? reconcile('CLEANUP_NOT_CONVERGING', 'service data') : run('cleanup_service_data', 'service data present');\n  }\n", ''),
    ('unreadable Storage is treated as empty', P, "  if (f.storage.remaining === null) {", "  if (false) {"),
    ('one empty Storage read is enough', P, "stableStorageReads: 2", "stableStorageReads: 1"),
    ('an unknown provider outcome reaches the delete', P, "    if (state === 'unknown') return reconcile('PROVIDER_UNRESOLVED', provider);\n", ''),
    ('a known identity needs no provider outcome', P, "    if (!(provider in f.providers)) {", "    if (false) {"),
    ('the snapshot is not recorded before the delete', P, "  if (f.identities.snapshot === null) return run('record_snapshot', 'decision under the exclusive lock');\n", ''),
    ('a changed identity set is ignored before the delete', P, "  if (late.length) {", "  if (false) {"),
    # --- the delete ---------------------------------------------------------------------------------------------------------
    ('an ambiguous delete may be repeated', P, "  if (f.authDelete === 'ambiguous') return run('readback_user', 'ambiguous delete: read back, never repeat');\n", ''),
    ('a failed delete may repeat without a bound', P, "  if (f.authDelete === 'failed_before_commit' && f.attempts.delete >= LIMITS.delete) return reconcile('DELETE_NOT_CONFIRMED', 'delete failed repeatedly');\n", ''),
    ('a login removed by another route counts as ours', P, "  if (f.authDelete === 'not_attempted' || f.authDelete === 'failed_before_commit') {\n    // The login disappeared", "  if (false) {\n    // The login disappeared"),
    # --- verification --------------------------------------------------------------------------------------------------------
    ('completion does not need the post-delete read', P, "  if (pd.serviceResidue === null || pd.storageResidue === null || pd.lateIdentityEvents === null) return run('verify', 'post-delete facts not read yet');\n", ''),
    ('a late identity after the delete is ignored', P, "  if (pd.lateIdentityEvents > 0) return reconcile('LATE_IDENTITY_DETECTED', `events=${pd.lateIdentityEvents}`);\n", ''),
    ('residue after the delete is ignored', P, "  if (pd.serviceResidue > 0 || pd.storageResidue > 0) {", "  if (false) {"),
    ('an unresolved provider does not stop completion', P, "  if (unresolved.length) return reconcile('PROVIDER_UNRESOLVED', ...unresolved);\n", ''),
    # --- the data-plane gate and the sweeper ---------------------------------------------------------------------------------
    ('the gate trusts a session minted after the ban', P, "  if (db.account !== 'active') return 'DENY_ACCOUNT';\n", ''),
    ('an unknown session is allowed', P, "  if (db.sessionLive !== true) return 'DENY_SESSION';", "  if (db.sessionLive === false) return 'DENY_SESSION';"),
    ('the sweeper runs on an incomplete owner list', P, "  if (!input.liveOwnersComplete) return { ok: false, code: 'OWNER_LIST_INCOMPLETE' };\n", ''),
    ('the sweeper runs on an empty owner list', P, "  if (input.liveOwners.length === 0) return { ok: false, code: 'OWNER_LIST_EMPTY' };\n", ''),
    ('the sweeper ignores the grace period', P, "&& input.now - r.createdAt >= input.graceSec)", ")"),
    # --- the model must keep reproducing the observations --------------------------------------------------------------------
    ('the model no longer lets a manual link complete after the ban (F1)', W, "      if (w.userPresent && w.manualLinksPending > 0) {", "      if (false) {"),
    ('the model no longer mints a session at the exchange (F2)', W, "        w.sessions.push({ id, live: true });\n        w.tokens.push({ id, sessionId: id });\n", ''),
    ('the model accepts nothing without a boundary (F4 disappears)', W, "      if (answer === 'ALLOW' || answer === 'NO_BOUNDARY') {", "      if (answer === 'ALLOW') {"),
    ('post-delete facts are cached instead of read with the verdict', W, "cachedVerification: options.cachedVerification ?? false,", "cachedVerification: options.cachedVerification ?? true,"),
]


def deno(root):
    r = subprocess.run(['deno', 'test', '--no-config', '--no-check', '--allow-read', root], capture_output=True, text=True)
    return r.returncode


failures = []
with tempfile.TemporaryDirectory(prefix='kabumori-p3i-mutations.', dir='/private/tmp') as tmp:
    work = os.path.join(tmp, 'tool')
    shutil.copytree(here, work, ignore=shutil.ignore_patterns('__pycache__', 'mutations.py'))
    if deno(work) != 0:
        sys.exit('FAIL the unmutated control does not pass')
    print('CONTROL   PASS')
    for label, name, old, new in M:
        path = os.path.join(work, name)
        original = open(path, encoding='utf-8').read()
        if original.count(old) != 1:
            failures.append(f'INVALID ({original.count(old)} sites)  {label}')
            continue
        open(path, 'w', encoding='utf-8').write(original.replace(old, new))
        try:
            code = deno(work)
        finally:
            open(path, 'w', encoding='utf-8').write(original)
        if code != 0:
            print(f'DETECTED  {label}')
        else:
            failures.append(f'SURVIVED  {label}')

for f in failures:
    print(f, file=sys.stderr)
if failures:
    print(f'FAIL {len(failures)} of {len(M)} mutations not detected', file=sys.stderr)
    sys.exit(1)
print(f'COMMON_ACCOUNT_LIFECYCLE_SAFETY_MUTATIONS_ALL_DETECTED {len(M)}/{len(M)}')
