"""Mutation check for the G5-02 RPC model (supabase/candidates/common_account_postona_authz/rpc_preflight.ts): ONE rule (the claim sources, the refusals
before any read, the Edge's stamp and error classes, the ACL over the role graph, the worker answer, the posting service key) is broken in a scratch
COPY; the model suite must fail. A control must pass first. Offline: no database, no network.
  python3 supabase/tests/common_account_g5_02_rpc_preflight_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/tests', 'supabase/candidates/common_account_postona_authz']
R = 'supabase/candidates/common_account_postona_authz/rpc_preflight.ts'
SUITE = 'supabase/tests/common_account_g5_02_rpc_preflight_test.ts'

M = [
    # ---- R1-3 the subject
    ('the JSON claims win over the per-claim settings', R, "if (c.legacy && c.legacy.sub) {", "if (c.legacy && c.legacy.sub && !c.claimsJson) {"),
    ('an anonymous login is a subject', R, "if (role !== 'authenticated' || anonymous !== false) return", "if (role !== 'authenticated') return"),
    ('a per-claim anonymous login is a subject', R, "anonymous = c.legacy.isAnonymous === undefined || c.legacy.isAnonymous === null || c.legacy.isAnonymous === '' || c.legacy.isAnonymous === 'false' ? false : c.legacy.isAnonymous;", 'anonymous = false;'),
    ('any role is a subject', R, "if (role !== 'authenticated' || anonymous !== false) return", "if (anonymous !== false) return"),
    ('the subject need not equal auth.uid()', R, "if (c.authUid !== sub) return { refused: 'AUTH_REQUIRED' };", ''),
    ('a session id is not required', R, "|| typeof session !== 'string' || !UUID.test(session)) return { refused: 'AUTH_REQUIRED' };", ") return { refused: 'AUTH_REQUIRED' };"),
    # ---- R1-4 refusals before any read
    ('another app is answered', R, "if (p_app !== 'postona') return 'FEATURE_NOT_ENABLED';", ''),
    ('an inherited key is a feature', R, "!Object.hasOwn(POSTONA_FEATURES, p_feature)) return 'FEATURE_NOT_ENABLED';", "!(p_feature in POSTONA_FEATURES)) return 'FEATURE_NOT_ENABLED';"),
    ('a malformed brand id is read', R, "if (typeof p_brand_id !== 'string' || !BRAND_ID.test(p_brand_id)) return 'BRAND_REQUIRED';", "if (typeof p_brand_id !== 'string') return 'BRAND_REQUIRED';"),
    ('the RPC reads before refusing', R, "  if (inputRefusal || 'refused' in principal) {", "  if (false) {"),
    ('the RPC returns the times', R, "    const { issued_at_ms: _i, expires_at_ms: _e, ...rest } = w;\n    return rest;", "    return w;"),
    # ---- R1-8 the Edge
    ('a 401 / 403 is unknown instead of deny', R, "if (result.status === 401 || result.status === 403) return refusal('deny', 'AUTH_REQUIRED');", ''),
    ('a 404 is not told apart', R, "if (result.status === 404) return refusal('unknown', 'RPC_NOT_DEPLOYED');", ''),
    ('a body with extra keys is accepted', R, "if (!isRecord(b) || Object.keys(b).sort().join(',') !== RPC_KEYS || b.v !== 1) return", "if (!isRecord(b) || b.v !== 1) return"),
    ('another scope is accepted', R, "if (!isRecord(s) || s.app !== scope.app || s.feature !== scope.feature || s.brand_slug !== scope.brandId) return", "if (!isRecord(s)) return"),
    ('a refusal gets the allow lifetime', R, "expires_at_ms: b.decision === 'allow' ? nowMs + EDGE_TTL_MS : nowMs }", "expires_at_ms: nowMs + EDGE_TTL_MS }"),
    ('a non-200 is accepted', R, "if (result.status !== 200) return refusal('unknown', 'RPC_FAILED');", ''),
    # ---- R1-1 / W2-1 the ACL
    ('only direct grants count (no membership closure)', R, "for (const e of edges) if (e.member === cur && !seen.has(e.role)) { seen.add(e.role); queue.push(e.role); }", "for (const e of edges) if (e.member === start && cur === start && !seen.has(e.role)) { seen.add(e.role); }"),
    ('PUBLIC EXECUTE is accepted', R, "if (input.grants.includes('public')) return 'PUBLIC_EXECUTE';", ''),
    ('an API role reaching the owner is accepted', R, "if (reach.has(input.owner)) return `${api.toUpperCase()}_REACHES_OWNER`;", ''),
    ('an API role reaching a superuser is accepted', R, "if (input.superusers.some((s) => reach.has(s))) return `${api.toUpperCase()}_REACHES_SUPERUSER`;", ''),
    ('an extra API role executing is accepted', R, "      return `${api.toUpperCase()}_CAN_EXECUTE`;", "      continue;"),
    ('a missing grant is accepted', R, "if (!executes && expected) return `${api.toUpperCase()}_CANNOT_EXECUTE`;", ''),
    # ---- W-3 the worker answer
    ('the worker accepts another service key', R, "if (bound.serviceKey !== POSTONA_POSTING_SERVICE_KEY) return 'ACCOUNT_LIFECYCLE_SERVICE_INVALID';", ''),
    ('the worker accepts no bound epoch (the stand-in 0)', R, "if (!Number.isSafeInteger(bound.expectedOwnerEpoch) || (bound.expectedOwnerEpoch as number) < 1) return 'EXPECTED_OWNER_EPOCH_REQUIRED';", ''),
    ('the worker accepts no bind time', R, "if (!Number.isSafeInteger(bound.boundAtMs)) return 'BOUND_AT_REQUIRED';", ''),
    ('the worker turns an unknown state into a known code', R, "return P5_REFUSALS.includes(facts.serviceState) ? facts.serviceState : 'SERVICE_STATE_UNKNOWN';", "return facts.serviceState;"),
    ('the worker accepts a NULL epoch', R, "if (!Number.isSafeInteger(facts.ownerEpoch) || (facts.ownerEpoch as number) < 1) return 'OWNER_EPOCH_UNAVAILABLE';", ''),
    ('the worker ignores an owner change (A -> B -> A)', R, "if (facts.ownerEpoch !== bound.expectedOwnerEpoch) return 'OWNER_EPOCH_CHANGED';", ''),
    ('the worker ignores a re-activation since the bind', R, "if ((facts.entitlementActivatedAtMs as number) > (bound.boundAtMs as number)) return 'SERVICE_REACTIVATED_SINCE_BIND';", ''),
    ('the worker accepts an unknown activation time', R, "if (!Number.isSafeInteger(facts.entitlementActivatedAtMs)) return 'SERVICE_STATE_UNKNOWN';", ''),
    ('the worker answers without facts', R, "if (!facts) return 'FACTS_UNAVAILABLE';", "if (!facts) return 'active';"),
    ('Threads posting under its own key', R, "export const POSTONA_POSTING_SERVICE_KEY = 'x_autopost' as const;", "export const POSTONA_POSTING_SERVICE_KEY = 'threads' as const;"),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', SUITE], cwd=root, capture_output=True, text=True, timeout=300).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='g502-mut-', dir=os.environ.get('SCRATCH', None))
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
