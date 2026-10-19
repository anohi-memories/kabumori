"""Mutation check for the G5-01 POSTONA authorization verdict reference: ONE rule of verdict.ts (the feature policy, the caller, the session, the account,
the entitlement, the brand / owner, the owner-epoch token, the consumer check, the recheck before an irreversible action) or of the TEST-ONLY facts read
is broken in a scratch COPY; the pure suite (and, when it does not notice, the PG17 suite) must fail. A control must pass first. Usage (the PG17 suite needs
the socket variables of a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> python3 supabase/tests/common_account_g5_01_authz_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/migrations', 'supabase/tests', 'supabase/candidates/common_account_postona_authz', 'supabase/candidates/common_account_brand_owner_epoch']
V = 'supabase/candidates/common_account_postona_authz/verdict.ts'
PG = 'supabase/tests/common_account_g5_01_authz_pg_test.ts'
PURE = 'supabase/tests/common_account_g5_01_authz_test.ts'
RUNNER = 'supabase/tests/common_account_g5_01_authz_pg_run.sh'

M = [
    # ---- the feature policy and the caller (nothing is read before these pass)
    ('another app (Miseiro / Kabumori) is answered as POSTONA', V, "if (scope.app === 'miseiro' || scope.app === 'kabumori') return 'FEATURE_NOT_ENABLED';\n  if (scope.app !== 'postona') return 'FEATURE_NOT_ENABLED';", ''),
    ('an inherited object key is a feature', V, "if (!Object.hasOwn(POSTONA_FEATURES, scope.feature)) return 'FEATURE_NOT_ENABLED';", "if (!(scope.feature in POSTONA_FEATURES)) return 'FEATURE_NOT_ENABLED';"),
    ('a malformed brand id is looked up', V, "&& BRAND_ID.test(scope.brandId))) return 'BRAND_REQUIRED';", ")) return 'BRAND_REQUIRED';"),
    ('authorize reads before refusing a bad caller', V, "    return refusal(scope, 'deny', 'AUTH_REQUIRED', nowMs, null);\n  }\n  let facts", "  }\n  let facts"),
    ('a non-authenticated role is a caller', V, "if (!principal || !UUID.test(principal.userId) || principal.role !== 'authenticated' || !UUID.test(principal.sessionId)) {\n    return refusal(scope, 'deny', 'AUTH_REQUIRED', nowMs, null);\n  }\n  if (!facts)", "if (!principal || !UUID.test(principal.userId) || !UUID.test(principal.sessionId)) {\n    return refusal(scope, 'deny', 'AUTH_REQUIRED', nowMs, null);\n  }\n  if (!facts)"),
    # ---- the session and the account
    ('a revoked session is allowed', V, "if (facts.sessionLive === false) return", "if (facts.sessionLive === 'never') return"),
    ('an expired session is not told apart', V, "if (facts.sessionLive === null) return", "if (facts.sessionLive === 'never') return"),
    ('an open account deletion with an active row is allowed', V, "if (account.status === 'deleting' || account.deletionOpen) return", "if (account.status === 'deleting') return"),
    ('a locked account is allowed', V, "if (account.status === 'locked') return refusal(scope, 'deny', 'ACCOUNT_LOCKED', nowMs, principal);\n  if (account.status !== 'active')", "if (account.status !== 'active' && account.status !== 'locked')"),
    ('a missing common account is allowed through', V, "if (account === null) return refusal(scope, 'deny', 'ACCOUNT_NOT_FOUND', nowMs, principal);", ''),
    # ---- the entitlement
    ('a missing x_autopost entitlement counts as active', V, "? facts.entitlements[policy.service] : null;", "? facts.entitlements[policy.service] : { status: 'active', deletionOpen: false };"),
    ('an open service deletion with an active row is allowed', V, "if (ent.status === 'deleting' || ent.deletionOpen) return", "if (ent.status === 'deleting') return"),
    ('provisioning is allowed', V, "if (ent.status === 'provisioning') return refusal(scope, 'pending', 'SERVICE_PROVISIONING', nowMs, principal);", "if (ent.status === 'provisioning') ent.status;"),
    ('a suspended entitlement is unknown instead of refused', V, "if (ent.status === 'suspended') return refusal(scope, 'deny', 'SERVICE_SUSPENDED', nowMs, principal);", ''),
    ('another app\'s entitlement is listed', V, "&& APP_OF_SERVICE[key as ServiceKey] === scope.app)", ')'),
    # ---- the brand and the owner
    ('a non-owner role is allowed', V, "if (!(policy.roles as readonly string[]).includes(brand.callerRole)) return", "if (false) return"),
    ('two owners are allowed', V, "if (brand.ownerCount !== 1 || brand.ownerUserId === null) return", "if (brand.ownerUserId === null) return"),
    ('another owner is accepted', V, "if (brand.ownerUserId !== principal.userId) return refusal(scope, 'deny', 'BRAND_ACCESS_DENIED', nowMs, principal);", ''),
    ('a NULL owner epoch is accepted', V, "if (!isInt(brand.ownerEpoch) || brand.ownerEpoch < 1) return", "if (brand.ownerEpoch === -1) return"),
    ('an unknown brand is told apart from not a member (existence oracle)', V, "if (brand === null || brand.callerRole === null) return refusal(scope, 'deny', 'BRAND_ACCESS_DENIED', nowMs, principal);",
     "if (brand === null) return refusal(scope, 'deny', 'BRAND_NOT_FOUND', nowMs, principal);\n  if (brand.callerRole === null) return refusal(scope, 'deny', 'BRAND_ACCESS_DENIED', nowMs, principal);"),
    ('another workspace kind is allowed', V, "if (brand.kind !== 'social_mobile_user_v1') return", "if (brand.kind === 'never') return"),
    # ---- the token and the session reference
    ('the token ignores the lifecycle version (entitlement ABA)', V, "return `g5oe:${ownerEpoch}:${lifecycleVersion}`;", "return `g5oe:${ownerEpoch}:1`;"),
    ('the token ignores the owner epoch (owner ABA)', V, "return `g5oe:${ownerEpoch}:${lifecycleVersion}`;", "return `g5oe:1:${lifecycleVersion}`;"),
    ('the raw session id travels', V, "return 's:' + (await sha256Hex(`g5-session:${sessionId}`)).slice(0, 32);", "return 's:' + sessionId;"),
    # ---- the consumer check
    ('the consumer ignores the scope', V, "s.app !== scope.app || s.feature !== scope.feature || s.brand_slug !== scope.brandId) {", "false) {"),
    ('the consumer ignores extra keys', V, "if (!isRecord(wire) || !keysAre(wire, WIRE_KEYS) || wire.v !== VERDICT_VERSION) return { refused: 'WIRE_SHAPE' };", "if (!isRecord(wire) || wire.v !== VERDICT_VERSION) return { refused: 'WIRE_SHAPE' };"),
    ('the consumer accepts an expired verdict', V, "if (!(wire.expires_at_ms > nowMs)) return { refused: 'EXPIRED' };", ''),
    ('the consumer accepts any lifetime', V, "if (wire.expires_at_ms - wire.issued_at_ms > maxTtlMs) return { refused: 'TTL_TOO_LONG' };", ''),
    ('the consumer accepts a revoked session marked allow', V, "|| session.state !== 'active' ||", '||'),
    ('the consumer accepts the stand-in epoch 0', V, "/^g5oe:[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$/u", "/^g5oe:[0-9]{1,19}:[0-9]{1,19}$/u"),
    ('the generation ignores the session', V, "JSON.stringify([subject.user_id, session.ref, wire.owner_epoch, [...ents].sort()])", "JSON.stringify([subject.user_id, wire.owner_epoch, [...ents].sort()])"),
    ('the generation ignores the owner token', V, "JSON.stringify([subject.user_id, session.ref, wire.owner_epoch, [...ents].sort()])", "JSON.stringify([subject.user_id, session.ref, [...ents].sort()])"),
    ('the generation ignores the entitlements', V, "JSON.stringify([subject.user_id, session.ref, wire.owner_epoch, [...ents].sort()])", "JSON.stringify([subject.user_id, session.ref, wire.owner_epoch])"),
    # ---- the recheck before an irreversible action
    ('no recheck: the first verdict is enough', V, "if (after.generation !== before.generation) return { sent: false, refused: 'AUTH_CHANGED_BEFORE_SEND' };", ''),
    ('an unreachable G5 at the recheck sends', V, "    return { sent: false, refused: 'AUTH_UNAVAILABLE_BEFORE_SEND' };", '    fresh = input.first;'),
    ('a refused recheck sends', V, "if ('refused' in after) return { sent: false, refused: `RECHECK_${after.refused}` };", "if ('refused' in after) return { sent: true, result: await input.act() };"),
    # ---- the TEST-ONLY facts read (the PG17 suite must catch these)
    ('the facts read ignores the session expiry', PG, "when s.not_after is null or s.not_after > clock_timestamp() then true", "when true then true"),
    ('the facts read uses a constant owner epoch', PG, "'ownerEpoch', private.account_lifecycle_brand_owner_epoch(b.id))", "'ownerEpoch', 1)"),
    ('the facts read takes the caller role of anyone', PG, "where m.brand_id = b.id and m.user_id = $1::uuid),", "where m.brand_id = b.id order by m.role desc limit 1),"),
]


def run_pure(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', PURE], cwd=root, capture_output=True, text=True, timeout=300).returncode
    except subprocess.TimeoutExpired:
        return 124


def run_pg(root):
    env = dict(os.environ, G501_REPO_ROOT=root)
    try:
        return subprocess.run(['bash', RUNNER], cwd=root, capture_output=True, text=True, timeout=900, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='g501-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
root = fresh_copy()
control = (run_pure(root), run_pg(root))
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == (0, 0) else "FAIL " + str(control)}', flush=True)
if control != (0, 0):
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
        by = 'pure' if run_pure(root) != 0 else ('pg' if run_pg(root) != 0 else None)
        print(f'{"DETECTED " if by else "SURVIVED "} {label}{" (" + by + ")" if by else ""}', flush=True)
        detected += 1 if by else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
