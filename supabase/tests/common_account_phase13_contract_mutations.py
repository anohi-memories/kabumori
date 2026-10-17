"""Mutation check for the baseline contract v2 (F5 Phase 13): ONE rule of the contract is broken in a scratch COPY; the tests
that guard it (and, for the flagged ones, the local-database proof) must fail. A control must pass first. Usage (needs the
local PostgreSQL socket variables of the other Phase 12/13 runners):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_phase13_contract_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
TREES = ['supabase/preflight', 'supabase/migrations', 'supabase/tests', 'docs/common-account', 'docs/postona']
DIR = 'supabase/preflight/managed_disposable/'
R = DIR + 'baseline_requirements.ts'
I = DIR + 'inventory.ts'
A = DIR + 'chain_preflight_audit.ts'
L = DIR + 'lock.ts'
TESTS = [DIR + name for name in (
    'baseline_contract_v2_test.ts', 'inventory_test.ts', 'baseline_requirements_test.ts', 'provenance_test.ts', 'plan_static_test.ts', 'plan_baseline_step_test.ts')]

# (label, file, old, new, needs_database_proof)
M = [
    # ---- reading the requirements out of the chain files
    ('the security flag of the P4 check is ignored', R, "const invoker = security.includes('not');", "const invoker = true;", False),
    ('a function shape with arguments is accepted', R, "if (Number(args) !== 0) throw new Error(", "if (false) throw new Error(", False),
    ('a missing P4 shape check is an empty list', R, "if (shapes.length === 0) throw new Error(", "if (false) throw new Error(", False),
    ('an auth function without a recorded type is guessed', R, "if (!expected) throw new Error(`${id} requires ${signature}", "if (false) throw new Error(`${id} requires ${signature}", False),
    ('a column without a recorded type is guessed', R, "if (!expected) throw new Error(`P6 requires ${key}", "if (false) throw new Error(`P6 requires ${key}", False),
    ('a missing P6 column check is an empty list', R, "if (!prerequisites.some((p) => p.kind === 'column')) throw new Error(", "if (false) throw new Error(", False),
    ('the platform column type expectation is varchar', R, "      type: 'text',\n      evidence: { file: 'supabase/migrations/20261007150000", "      type: 'character varying',\n      evidence: { file: 'supabase/migrations/20261007150000", False),
    ('the contract is built without the platform functions', R, "    platformFunctions: extra.platformFunctions,\n    prerequisites: extra.prerequisites,", "    platformFunctions: [],\n    prerequisites: extra.prerequisites,", False),
    ('the contract is built without the extra columns', R, "    columns: [...phase1.columns, ...extra.columns].sort(byColumn),", "    columns: [...phase1.columns].sort(byColumn),", False),
    ('the contract is built without the extra functions', R, "    functions: [...new Set([...phase1.functions, ...extra.functions])].sort(),", "    functions: [...phase1.functions].sort(),", False),
    ('the contract version constant moves without the lock', R, "export const CONTRACT_VERSION = 2;", "export const CONTRACT_VERSION = 3;", False),
    ('the lock is built from the Phase 1 lists only', L, "    requirements = buildRequirements(read);", "    requirements = undefined;", False),
    # ---- the check
    ('a procedure passes as the required function', I, "if (found.a.kind !== 'f') add('FUNCTION_KIND'", "if (false) add('FUNCTION_KIND'", False),
    ('the return type of the required function is not compared', I, "if (found.a.returns !== shape.returns) add('FUNCTION_SHAPE'", "if (false) add('FUNCTION_SHAPE'", False),
    ('a security definer passes as the required function', I, "&& found.a.security_definer !== shape.securityDefiner) add('FUNCTION_SHAPE'", "&& false) add('FUNCTION_SHAPE'", False),
    ('the security mode is only read from the subset', I, "  const missing = [...checkRequirements(subset, requirements, owned), ...checkRequirements(lines, requirements, owned)]", "  const missing = [...checkRequirements(subset, requirements, owned)]", False),
    ('a body that reaches out passes on a replaced function', I, "if (shape.replacedBy && mentions && Object.values(mentions).some((value) => value === true)) add('FUNCTION_MENTIONS'", "if (false) add('FUNCTION_MENTIONS'", False),
    ('the chain marker is never seen', I, "(shape.replacedBy && present.has(compact(shape.replacedBy.marker)) ? [compact(shape.signature)] : [])", "(false ? [compact(shape.signature)] : [])", False),
    ('a replaced function is still asserted invoker after the chain ran', I, "if (!owned.has(compact(shape.signature)) && 'security_definer' in found.a &&", "if ('security_definer' in found.a &&", True),
    ('the replaced function keeps its body and mode in the fingerprint', I, "if (replaced.has(compact(line.key))) out.push({ ...line, a: pick(a, ['kind', 'language', 'volatility', 'owner', 'returns', 'config', 'acl']) });", "if (replaced.has(compact(line.key))) out.push({ ...line, a: pick(a, ['kind', 'language', 'security_definer', 'volatility', 'owner', 'returns', 'config', 'acl', 'body_sha256']) });", True),
    ('a missing auth function is accepted', I, "if (!found) add('PLATFORM_FUNCTION_MISSING'", "if (false) add('PLATFORM_FUNCTION_MISSING'", False),
    ('a retyped auth function is accepted', I, "else if (found.a.kind !== 'f' || found.a.returns !== platform.returns) add('PLATFORM_FUNCTION_SHAPE'", "else if (false) add('PLATFORM_FUNCTION_SHAPE'", False),
    ('a stale contract version is read as current', I, "  if (!isCurrentContract(requirements)) {", "  if (false) {", False),
    ('the platform function is not part of the fingerprint subset', I, "        else if (platformFunctions.has(compact(line.key))) out.push({ ...line, a: pick(a, ['kind', 'returns']) });\n", "", False),
    ('the platform function carries its owner and body into the fingerprint', I, "out.push({ ...line, a: pick(a, ['kind', 'returns']) });", "out.push({ ...line, a: pick(a, ['kind', 'returns', 'owner', 'body_sha256']) });", False),
    ('a finding echoes whatever the inventory says', I, "  return text.length <= 64 && /^[A-Za-z0-9_ .,()[\\]\"-]*$/u.test(text) && secretFindings(text).length === 0 ? text : '<not shown>';", "  return text;", False),
    # ---- the static audit
    ('the audit treats a same-file create-or-replace as internal', A, "(functionsDefinedAt.get(bare) ?? Infinity) < at ||", "(functionsDefinedAt.get(bare) ?? Infinity) <= at ||", False),
    ('the audit does not see to_regprocedure checks', A, "    for (const m of text.matchAll(/to_regprocedure\\('([a-z_]+\\.[a-z_0-9]+\\([a-z_, ]*\\))'\\)/gu)) add(file, at, 'function', m[1]);\n", "", False),
    ('the audit does not see attribute checks', A, "      for (const column of columns) add(file, at, 'column', `${m[1]}.${column}`);", "      void columns;", False),
    # ---- the local-database proof must be able to fail, too
    ('the return type of the required function is not compared (proof)', I, "if (found.a.returns !== shape.returns) add('FUNCTION_SHAPE'", "if (false) add('FUNCTION_SHAPE'", True),
    ('a missing auth function is accepted (proof)', I, "if (!found) add('PLATFORM_FUNCTION_MISSING'", "if (false) add('PLATFORM_FUNCTION_MISSING'", True),
    ('the ACL of the replaced function is not in the fingerprint (proof)', I, "pick(a, ['kind', 'language', 'volatility', 'owner', 'returns', 'config', 'acl'])", "pick(a, ['kind', 'language', 'volatility', 'owner', 'returns', 'config'])", True),
    ('the language of the replaced function is not in the fingerprint (proof)', I, "pick(a, ['kind', 'language', 'volatility', 'owner', 'returns', 'config', 'acl'])", "pick(a, ['kind', 'volatility', 'owner', 'returns', 'config', 'acl'])", True),
    ('a Phase 1 helper body is not in the fingerprint (proof, unchanged invariant)', I, "pick(a, ['kind', 'language', 'security_definer', 'volatility', 'owner', 'returns', 'config', 'acl', 'body_sha256'])", "pick(a, ['kind', 'language', 'security_definer', 'volatility', 'owner', 'returns', 'config', 'acl'])", False),
    ('the column nullability is not in the fingerprint (proof)', I, "pick(a, ['rel', 'type', 'notnull', 'generated', 'identity', 'default_sha256'])", "pick(a, ['rel', 'type', 'generated', 'identity', 'default_sha256'])", True),
]


def run(root, database):
    if database:
        commands = [['bash', 'supabase/tests/common_account_phase13_contract_extension_run.sh']]
    else:
        commands = [['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', *TESTS]]
    for command in commands:
        env = dict(os.environ, P13_REPO_ROOT=root, P13_GIT_ROOT=src_root)
        try:
            code = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
        except subprocess.TimeoutExpired:
            return 124
        if code != 0:
            return code
    return 0


def fresh_copy():
    root = tempfile.mkdtemp(prefix='p13-contractmut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
root = fresh_copy()
control = run(root, False) or run(root, True)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}', flush=True)
if control != 0:
    sys.exit(1)
detected = 0
invalid = 0
for label, target, old, new, database in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != 1:
            print(f'INVALID   {label}: the site occurs {text.count(old)} times', flush=True)
            invalid += 1
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        code = run(root, database)
        print(f'{"DETECTED " if code != 0 else "SURVIVED "} {label}', flush=True)
        detected += 1 if code != 0 else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'MUTANTS   {detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
