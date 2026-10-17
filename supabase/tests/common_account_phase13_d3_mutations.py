"""Mutation check for the Phase 13 D-3 package (F5): ONE rule of the settings verifier, of the gates / cost data, of the document or of the
two offline scripts is broken in a scratch COPY; the check that guards it must fail. A control must pass first. Usage (the PostgreSQL
variables are needed only by the privilege-script mutants; they point at a throw-away LOCAL cluster on a /tmp socket):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_phase13_d3_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase', 'docs/common-account']
D = 'supabase/preflight/managed_disposable/'
R = D + 'd3_readback.ts'
G = 'docs/common-account/phase13-d3-gates.json'
C = 'docs/common-account/phase13-d3-cost-sources.json'
DOC = 'docs/common-account/phase13-d3-hosted-sandbox-preflight.md'
F4 = 'supabase/tests/common_account_phase13_d3_f4_refusal.sh'
F4M = 'supabase/tests/common_account_phase13_d3_f4_refusal.mjs'
DUMP = 'supabase/tests/common_account_phase13_d3_dump_privilege.sh'
TEST = D + 'd3_package_test.ts'

# (label, file, old, new, kind) with kind in { 'deno', 'f4', 'dump' }
M = [
    # ---- the settings verifier
    ('a production ref is accepted', R, "else if (options.productionRefSha256.includes(refHash)) stop(", "else if (false) stop(", 'deno'),
    ('an organization that holds production is accepted', R, "if (identity.organizationHoldsProduction !== false) stop(", "if (false) stop(", 'deno'),
    ('a branch or restore is accepted', R, "if (identity.createdAs !== 'new_project') stop(", "if (false) stop(", 'deno'),
    ('another provider is accepted', R, "if (!allowedProviders.includes(provider)) stop('PROVIDER_NOT_ALLOWED'", "if (false) stop('PROVIDER_NOT_ALLOWED'", 'deno'),
    ('e-mail off is accepted', R, "if (!auth.providersEnabled.includes('email')) stop(", "if (false) stop(", 'deno'),
    ('an unstated anonymous setting is accepted', R, "if (auth.anonymousSignIns !== false) stop(", "if (auth.anonymousSignIns === true) stop(", 'deno'),
    ('a wildcard redirect is accepted', R, "if (/[*?[\\]]/u.test(url)) stop('REDIRECT_WILDCARD'", "if (false) stop('REDIRECT_WILDCARD'", 'deno'),
    ('a foreign redirect is accepted', R, "else if (!required.includes(url)) stop('REDIRECT_UNEXPECTED'", "else if (false) stop('REDIRECT_UNEXPECTED'", 'deno'),
    ('a missing redirect is accepted', R, "if (!auth.redirectUrls.includes(url)) stop('REDIRECT_MISSING'", "if (false) stop('REDIRECT_MISSING'", 'deno'),
    ('a zero JWT expiry is accepted', R, "|| (auth.jwtExpirySeconds as number) <= 0) stop('JWT_EXPIRY_INVALID'", "|| false) stop('JWT_EXPIRY_INVALID'", 'deno'),
    ('an exposed private schema is accepted', R, "if (!(ALLOWED_EXPOSED_SCHEMAS as readonly string[]).includes(schema)) stop(", "if (false) stop(", 'deno'),
    ('public not exposed is accepted', R, "if (!api.exposedSchemas.includes('public')) stop(", "if (false) stop(", 'deno'),
    ('another function is accepted', R, "if (expected === undefined) stop('EDGE_FUNCTION_NOT_ALLOWED'", "if (false) stop('EDGE_FUNCTION_NOT_ALLOWED'", 'deno'),
    ('a function without JWT verification is accepted', R, "if (!fn.verifyJwt) stop(", "if (false) stop(", 'deno'),
    ('another digest is accepted', R, "|| fn.sha256 !== expected) stop('EDGE_DIGEST_MISMATCH'", "|| false) stop('EDGE_DIGEST_MISMATCH'", 'deno'),
    ('a missing function is accepted', R, "if (!functions.some((fn) => fn.name === name)) stop('EDGE_FUNCTION_MISSING'", "if (false) stop('EDGE_FUNCTION_MISSING'", 'deno'),
    ('a function on a project that should be empty is accepted', R, "if (options.stage === 'created' && functions.length > 0) stop(", "if (false) stop(", 'deno'),
    ('a secret of another system is accepted', R, "if (FORBIDDEN_SECRET_NAME.test(name)) stop('SECRET_NAME_FORBIDDEN'", "if (false) stop('SECRET_NAME_FORBIDDEN'", 'deno'),
    ('an unknown secret name is accepted', R, "else stop('SECRET_NAME_UNKNOWN',", "else void ('SECRET_NAME_UNKNOWN',", 'deno'),
    ('a forbidden extension is accepted', R, "if ((FORBIDDEN_EXTENSIONS as readonly string[]).includes(extension)) stop(", "if (false) stop(", 'deno'),
    ('a non-zero count is accepted', R, "else if (counts[key] !== 0) stop('COUNT_NOT_ZERO'", "else if (false) stop('COUNT_NOT_ZERO'", 'deno'),
    ('a marker of another project is accepted', R, "if (database.markerRefSha256 !== refHash) stop(", "if (false) stop(", 'deno'),
    ('the attestation is not required', R, "if (sheet.attestation !== SIDE_EFFECTS_ATTESTATION) stop(", "if (false) stop(", 'deno'),
    ('secret-shaped text is not scanned', R, "if (secretFindings(JSON.stringify(sheet)).length > 0) {", "if (false) {", 'deno'),
    ('a STOP does not refuse', R, "ok: findings.every((finding) => finding.severity !== 'stop')", "ok: true", 'deno'),
    ('a warning stops', R, "findings.push({ code, severity: 'warn', detail });", "findings.push({ code, severity: 'stop', detail });", 'deno'),
    # ---- the gates and the cost data
    ('a consent phrase loses its closing sentence', G, "POSTONA_END_SOURCE_ENABLED stays false in git. This does not authorize any other gate.", "POSTONA_END_SOURCE_ENABLED stays false in git.", 'deno'),
    ('the PG5 selection drops the non-skippable gate', G, "cli.ts --execute --only=G1,G2,G3a,G3b,G3-P1,G3-P2,G3-P3a,G3-P3b,G3-P4,G3-P5,G3-P6,G3-P8,G3-P9,G3-P10,G3c,G4 against the project", "cli.ts --execute --only=G1,G2,G3a,G3-P1,G3-P2,G3-P3a,G3-P3b,G3-P4,G3-P5,G3-P6,G3-P8,G3-P9,G3-P10,G3c,G4 against the project", 'deno'),
    ('PG3 no longer needs the export', G, '"prerequisites": ["PG2a", "PG2b"]', '"prerequisites": ["PG2a"]', 'deno'),
    ('an F4 condition is renamed', G, '"code": "SIDE_EFFECTS_ATTESTED"', '"code": "SIDE_EFFECTS_ATTESTEDX"', 'deno'),
    ('the PG6 phrase names M12', G, "M9, M10, M11 and the teardown T1", "M9, M10, M11, M12 and the teardown T1", 'deno'),
    ('a cost figure changes', C, '"figure": 0.01344', '"figure": 0.02', 'deno'),
    ('a cost source leaves the provider\'s site', C, '"url": "https://supabase.com/docs/guides/api/api-keys"', '"url": "https://example.invalid/docs/guides/api/api-keys"', 'deno'),
    ('the Pro envelope ceiling changes', C, '"ceilingUsd": 25', '"ceilingUsd": 20', 'deno'),
    # ---- the document
    ('the document stops saying that no gate is open', DOC, "No gate is open today", "A gate is open today", 'deno'),
    ('the document names a project host', DOC, "# Phase 13 D-3 — hosted disposable Supabase preflight package (execution-ready, non-executing)", "# Phase 13 D-3 — hosted disposable Supabase preflight package (execution-ready, non-executing)\n\nsee abcdefghijklmnopqrst.supabase.co", 'deno'),
    ('the document names a variable the guard does not read', DOC, "| `KABUMORI_DISPOSABLE_CONFIRM` |", "| `KABUMORI_DISPOSABLE_CONFIRMATION` |", 'deno'),
    ('the document says the stand-in is deployable', DOC, "it is **not a deployed Edge function**", "it is **a function the project can call**", 'deno'),
    # ---- the two offline scripts
    ('the F4 wrapper pins another blob', F4, "pinned=b2ec507904e38e97cafb7928fafd075d71dfdb82", "pinned=0000000000000000000000000000000000000000", 'f4'),
    ('the F4 check forgets the redirect cases', F4M, "  ['REDIRECTS_DECLARED', (i) => { i.operator.redirects = `${SCHEME}://auth-callback`; }],\n  ['REDIRECTS_DECLARED', (i) => { i.operator.redirects = `${SCHEME}://auth-callback,${SCHEME}://oauth-callback,${SCHEME}://*`; }],\n", "", 'f4'),
    ('the F4 control is not satisfied', F4M, "signoff: 'synthetic-test-reference'", "signoff: ''", 'f4'),
    ('the CONNECT-only login is given SELECT', DUMP, "grant select on public.d3_fake to $reader;", "grant select on public.d3_fake to $reader, $connect_only;", 'dump'),
    ('the SELECT login is the CONNECT-only one', DUMP, 'dump="$(pg_dump -h "$host" -p "$port" -U "$reader"', 'dump="$(pg_dump -h "$host" -p "$port" -U "$connect_only"', 'dump'),
]


def run(root, kind):
    env = dict(os.environ, P13D3_REPO_ROOT=root, P13D3_GIT_ROOT=src_root)
    if kind == 'deno':
        command = ['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', TEST]
    elif kind == 'f4':
        command = ['bash', F4]
    else:
        command = ['bash', DUMP]
    try:
        return subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=300, env=env).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='p13d3-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
root = fresh_copy()
control = all(run(root, kind) == 0 for kind in ('deno', 'f4', 'dump'))
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control else "FAIL"}', flush=True)
if not control:
    sys.exit(1)
detected = 0
invalid = 0
for label, target, old, new, kind in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != 1:
            print(f'INVALID   {label}: the site occurs {text.count(old)} times', flush=True)
            invalid += 1
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        code = run(root, kind)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
