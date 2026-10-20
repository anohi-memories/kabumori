"""Mutation check for the G5-06 brand-less bootstrap model (supabase/candidates/common_account_postona_authz/bootstrap.ts): ONE rule (the features,
the brand refusal, the person checks, the own-workspace rule, the allow's shape, the begin transaction's guard / owner check / rollback) is broken in
a scratch COPY; the suite must fail. A control must pass first. Offline: no database, no network.
  python3 supabase/tests/common_account_g5_06_bootstrap_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/tests', 'supabase/candidates/common_account_postona_authz']
B = 'supabase/candidates/common_account_postona_authz/bootstrap.ts'
SUITE = 'supabase/tests/common_account_g5_06_bootstrap_test.ts'

M = [
    # (no "any feature is a bootstrap" mutant: a feature outside BOOTSTRAP_FEATURES maps to no connect feature, and decide() then refuses it with the
    #  same FEATURE_NOT_ENABLED -- the two checks are equivalent by construction; the suite asserts the refusal for R1's features and prototype keys)
    ('another app is answered', B, "if (scope.app !== 'postona' || !BOOT_KEYS.has(scope.feature)) return refusal('deny', 'FEATURE_NOT_ENABLED');",
     "if (!BOOT_KEYS.has(scope.feature)) return refusal('deny', 'FEATURE_NOT_ENABLED');"),
    ('a brand id from the request is accepted', B, "  if (scope.brandId !== null) return refusal('deny', 'BRAND_NOT_EXPECTED');\n", ''),
    ('the person checks are skipped', B, "  if (person.decision !== 'allow') {", "  if (false) {"),
    ('the own workspace is not looked at', B, "  if (own !== null) {", "  if (false) {"),
    ('an unreadable own workspace is allowed', B, "    if (typeof own !== 'object' || own === undefined) return refusal('unknown', 'OWN_WORKSPACE_UNREADABLE', person);\n", "    if (own === undefined) return refusal('deny', 'X', person);\n"),
    ('another workspace kind is joined', B, "    if (own.kind !== 'social_mobile_user_v1') return refusal('deny', 'OWN_WORKSPACE_CONFLICT', person);\n", ''),
    ('two owners are not unknown', B, "    if (own.ownerCount !== 1 || own.ownerUserId === null) return refusal('unknown', 'WORKSPACE_OWNER_UNKNOWN', person);\n", ''),
    ('another owner is joined (hijack)', B, "if (own.ownerUserId !== principal!.userId || own.callerRole !== 'owner') return", "if (own.callerRole !== 'owner') return"),
    ('a contradicting reader is trusted', B, "if (own.ownerUserId !== principal!.userId || own.callerRole !== 'owner') return", "if (own.ownerUserId !== principal!.userId) return"),
    ('the allow carries an owner epoch', B, "    subject: person.subject, session: person.session, owner_epoch: null, entitlements: person.entitlements,",
     "    subject: person.subject, session: person.session, owner_epoch: person.owner_epoch, entitlements: person.entitlements,"),
    ('the allow names a brand', B, "    scope: { app: 'postona', feature: scope.feature, brand_slug: null },", "    scope: { app: 'postona', feature: scope.feature, brand_slug: 'u_bootstrap' },"),
    ("the allow lives longer than R1's", B, "    issued_at_ms: nowMs, expires_at_ms: person.expires_at_ms,", "    issued_at_ms: nowMs, expires_at_ms: nowMs + 3_600_000,"),
    ('begin skips the G5 write guard', B, "  if (guard !== null) return { refused: guard };\n", ''),
    ('begin does not check the owners after creating', B, "  if (ws.kind !== 'social_mobile_user_v1' || owners.length !== 1 || owners[0] !== userId || ws.members.get(userId) !== 'owner') {",
     "  if (ws.kind !== 'social_mobile_user_v1') {"),
    ('begin does not roll back', B, "    world.workspaces.clear();                                                   // the whole transaction rolls back\n    for (const [k, v] of snapshot) world.workspaces.set(k, v);\n", ''),
    ('begin derives the id from the request instead of the subject', B, "  const id = world.derive(userId);", "  const id = world.derive('00000000-0000-4000-8000-000000000000');"),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', SUITE], cwd=root, capture_output=True, text=True, timeout=300).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='g506-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


root = fresh_copy()
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
for label, target, old, new in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != 1:
            print(f'INVALID   {label}: the site occurs {text.count(old)} times', flush=True)
            invalid += 1
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        code = run(root)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
