"""Mutation check for the schema inventory (F5 Phase 12): ONE rule of inventory.ts or of the inventory query is broken in a
scratch COPY; the pure tests (and, for the query, the local-database proof with planted values) must fail. A control must
pass first. Usage (needs the local PostgreSQL socket variables of the other Phase 12 runners):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_phase12_inventory_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
# the Phase 13 documentation-consistency tests also read these trees
TREES = ['supabase/preflight', 'supabase/migrations', 'supabase/tests', 'docs/common-account', 'docs/postona', '.agent', 'apps/social-mobile', 'supabase/functions']
DIR = 'supabase/preflight/managed_disposable/'
I = DIR + 'inventory.ts'
Q = DIR + 'inventory/schema_inventory.sql'
C = DIR + 'inventory_cli.ts'
P = DIR + 'plan.ts'
MASK = "'(E|U&)?''(?:[^'']|'''')*''', '''?''', 'g')"

# (label, file, old, new, needs_database_proof)
M = [
    # ---- the inventory logic (pure tests)
    ('an unexpected attribute is accepted', I, "if (!allowed.includes(name)) add('UNEXPECTED_ATTRIBUTE'", "if (false) add('UNEXPECTED_ATTRIBUTE'", False),
    ('an absent attribute is accepted', I, "if (!(name in line.a)) add('MISSING_ATTRIBUTE'", "if (false) add('MISSING_ATTRIBUTE'", False),
    ('an unmasked literal in a shape is accepted', I, "if (rest.includes(\"'\")) add('UNMASKED_LITERAL'", "if (false) add('UNMASKED_LITERAL'", False),
    ('a dollar-quoted literal in a shape is accepted', I, "if (/\\$[A-Za-z_0-9]*\\$/u.test(rest)) add('UNMASKED_LITERAL'", "if (false) add('UNMASKED_LITERAL'", False),
    ('a value that is not a SHA-256 is accepted as a hash', I, "if (name.endsWith('_sha256') && value !== null && !(typeof value === 'string' && SHA256.test(value))) add(", "if (false) add(", False),
    ('an unredacted function setting is accepted', I, "if (name !== 'search_path' && value !== '<redacted>') add('UNREDACTED_SETTING'", "if (false) add('UNREDACTED_SETTING'", False),
    ('an option value passes as an option name', I, "if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(name))) {", "if (false) {", False),
    ('the JWT rule is gone', I, "  { code: 'JWT', pattern: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{4,}/u },\n", "", False),
    ('the connection-string rule is gone', I, "  { code: 'CONNECTION_STRING', pattern: /postgres(?:ql)?:\\/\\/[^\\s\"']+/iu },\n", "", False),
    ('the Supabase host rule is gone', I, "  { code: 'SUPABASE_HOST', pattern: /[a-z0-9]{20}\\.supabase\\.(co|in|net)/iu },\n", "", False),
    ('the verdict does not scan for secrets', I, "  if (secrets.length > 0) return stopWith(`the inventory output carries", "  if (false) return stopWith(`the inventory output carries", False),
    ('the verdict accepts a missing approval', I, "if (approvedDigest === undefined || !SHA256.test(approvedDigest)) return stopWith(", "if (false) return stopWith(", False),
    ('the verdict does not compare the digest', I, "  if (canonical.digest !== approvedDigest) {", "  if (false) {", False),
    ('the verdict does not check the requirements', I, "  if (missing.length > 0) return stopWith(`the baseline does not provide", "  if (false) return stopWith(`the baseline does not provide", False),
    ('the verdict does not validate the shape', I, "  if (shape.length > 0) return stopWith(`the inventory violates its own contract", "  if (false) return stopWith(`the inventory violates its own contract", False),
    ('a required column type is not compared', I, "else if (found.a.type !== item.type) add('COLUMN_TYPE'", "else if (false) add('COLUMN_TYPE'", False),
    ('a foreign key delete rule is not compared', I, "else if ((match.a.fk as { on_delete: string }).on_delete !== key.onDelete) add(", "else if (false) add(", False),
    ('a required relation may be a view', I, "else if (found.a.relkind !== 'r' && found.a.relkind !== 'p') add('RELATION_KIND'", "else if (false) add('RELATION_KIND'", False),
    ('the contract subset ignores the function body', I, "pick(a, ['kind', 'language', 'security_definer', 'volatility', 'owner', 'returns', 'config', 'acl', 'body_sha256'])", "pick(a, ['kind', 'language', 'security_definer', 'volatility', 'owner', 'returns', 'config', 'acl'])", False),
    ('the contract subset ignores the row-level-security flag', I, "pick(a, ['relkind', 'owner', 'persistence', 'rls', 'rls_forced', 'acl'])", "pick(a, ['relkind', 'owner', 'persistence', 'acl'])", False),
    ('the contract subset ignores the column default', I, "pick(a, ['rel', 'type', 'notnull', 'generated', 'identity', 'default_sha256'])", "pick(a, ['rel', 'type', 'notnull', 'generated', 'identity'])", False),
    ('the contract subset takes every column', I, "if (needed.get(relation)?.has(line.key.slice(relation.length + 1))) {", "if (true) {", False),
    ('the contract subset keeps the column position', I, "pick(a, ['rel', 'type', 'notnull', 'generated', 'identity', 'default_sha256'])", "pick(a, ['rel', 'ord', 'type', 'notnull', 'generated', 'identity', 'default_sha256'])", False),
    ('the digest depends on key order', I, "return `{${Object.keys(record).sort().map(", "return `{${Object.keys(record).map(", False),
    ('an extra object is not drift', I, "  for (const object of right.keys()) if (!left.has(object)) drift.extra.push(object);\n", "", False),
    ('a missing object is not drift', I, "      drift.missing.push(object);\n      continue;", "      continue;", False),
    ('a duplicate line is accepted', I, "    if (seen.has(identity)) throw new InventoryError('INVENTORY_DUPLICATE'", "    if (false) throw new InventoryError('INVENTORY_DUPLICATE'", False),
    ('an unknown kind is accepted', I, "if (typeof record.k !== 'string' || !(KINDS as readonly string[]).includes(record.k)) {", "if (false) {", False),
    ('a truncated output is accepted', I, "  if (!lines.some((line) => line.k === 'meta')) throw new InventoryError('INVENTORY_INCOMPLETE'", "  if (false) throw new InventoryError('INVENTORY_INCOMPLETE'", False),
    ('readiness is better than review without an inventory', I, "  if (manifest === null) {\n    return { state: 'NOT_READY'", "  if (false) {\n    return { state: 'NOT_READY'", False),
    ('a non-read-only BEGIN is accepted', I, "if (n === 1 && !/^begin transaction isolation level repeatable read read only$/u.test(code)) add(", "if (false) add(", False),
    ('a COMMIT end is accepted', I, "if (n === statements.length && code !== 'rollback') add('NOT_ROLLBACK_END'", "if (false) add('NOT_ROLLBACK_END'", False),
    ('a write statement is accepted', I, "if (!['begin', 'set', 'select', 'rollback'].includes(first)) add('STATEMENT_KIND'", "if (false) add('STATEMENT_KIND'", False),
    ('any SET is accepted', I, "if (first === 'set' && !/^set local (statement_timeout|lock_timeout|idle_in_transaction_session_timeout) = ''$/u.test(code)) add(", "if (false) add(", False),
    ('an application table may be read', I, "if (!CATALOGS.includes(target) && !FUNCTIONS.includes(target)) add('FROM_TARGET'", "if (false) add('FROM_TARGET'", False),
    ('any function may be called', I, "if (!FUNCTIONS.includes(name) && !SQL_WORDS.has(name)) add('FUNCTION_NOT_LISTED'", "if (false) add('FUNCTION_NOT_LISTED'", False),
    ('a schema-qualified application object is accepted', I, "      add('SCHEMA_QUALIFIED_OBJECT', n, `names ${match[0]}`);", "      void match;", False),
    ('a comma join is accepted', I, "add('COMMA_JOIN', n, 'a comma join (use JOIN ... ON)');", "void n;", False),
    ('any pg_ name is accepted', I, "if (!CATALOGS.includes(match[1]) && !/^pg_(catalog|toast|temp)/u.test(match[1])) add('CATALOG_NAME'", "if (false) add('CATALOG_NAME'", False),
    # ---- the operator tool and the plan steps
    ('the tool exits 0 on a different approved digest', C, "return { code: readiness.state === 'READY_FOR_OWNER_REVIEW' && same ? 0 : 1, output: out.join('\\n') };", "return { code: 0, output: out.join('\\n') };", False),
    ('the tool does not look for secrets', C, "    if (secrets.length > 0) {\n      out.push(`STOP secret-shaped", "    if (false) {\n      out.push(`STOP secret-shaped", False),
    ('the tool exits 0 on drift', C, "return { code: hasDrift(drift) ? 1 : 0, output: out.join('\\n') };", "return { code: 0, output: out.join('\\n') };", False),
    ('the baseline read-back passes whatever the verdict', P, "      if (verdict.status !== 'PASS' || verdict.digest === undefined) return stop(verdict.detail);\n", "", False),
    ('the footprint is not compared', P, "      return after === before ? pass(`unchanged (${after})`) : stop(`the footprint changed: before ${before}, after ${after}`);", "      return pass(`unchanged (${after})`);", False),
    # ---- J1 V1 R4 (Phase 12 follow-up): diff vets both inputs before it parses or prints
    ('diff does not scan the raw inputs for secrets', C,
     "  if (secrets.length > 0) return { stop: `STOP secret-shaped text in the ${label} manifest", "  if (false) return { stop: `STOP secret-shaped text in the ${label} manifest", False),
    ('diff does not check the shape contract', C,
     "  if (shape.length > 0) return { stop: `STOP the ${label} manifest violates the inventory contract", "  if (false) return { stop: `STOP the ${label} manifest violates the inventory contract", False),
    ('an unreadable manifest echoes its error', C,
     "    return { stop: `STOP the ${label} manifest could not be read` };", "    return { stop: `STOP the ${label} manifest could not be read: ${path}` };", False),
    ('check echoes the path of an unreadable manifest', C,
     "      return { code: 1, output: 'STOP the manifest could not be read' };", "      return { code: 1, output: `STOP the manifest could not be read: ${path}` };", False),
    ('a key behind an identifier prefix is not a key', I,
     "  { code: 'SUPABASE_KEY', pattern: /sb_(secret|publishable)_[A-Za-z0-9_-]{6,}/iu },", "  { code: 'SUPABASE_KEY', pattern: /\\bsb_(secret|publishable)_[A-Za-z0-9_-]{6,}/iu },", False),
    ('a token behind an identifier prefix is not a token', I,
     "  { code: 'LONG_TOKEN', pattern: /(?<![A-Za-z0-9])(?:sk|pk|rk|xox[abp])[-_][A-Za-z0-9_-]{16,}/u },", "  { code: 'LONG_TOKEN', pattern: /\\b(?:sk|pk|rk|xox[abp])[-_][A-Za-z0-9_-]{16,}/u },", False),
    # ---- the query (pure tests where static, the local-database proof otherwise)
    ('a column default is emitted as text', Q, "'default_shape', case when t.def is not null then regexp_replace(t.def, " + MASK + " end,", "'default_shape', t.def,", True),
    ('a constraint definition is emitted unmasked', Q, "'def_shape', regexp_replace(pg_get_constraintdef(con.oid), " + MASK + ",\n  'def_sha256', encode(sha256(convert_to(pg_get_constraintdef(con.oid)", "'def_shape', pg_get_constraintdef(con.oid),\n  'def_sha256', encode(sha256(convert_to(pg_get_constraintdef(con.oid)", True),
    ('an index predicate is emitted unmasked', Q, "'def_shape', regexp_replace(pg_get_indexdef(i.indexrelid), " + MASK + ",", "'def_shape', pg_get_indexdef(i.indexrelid),", True),
    ('a trigger condition is emitted unmasked', Q, "'def_shape', regexp_replace(pg_get_triggerdef(t.oid), " + MASK + ",", "'def_shape', pg_get_triggerdef(t.oid),", True),
    ('a policy expression is emitted unmasked', Q, "'using_shape', case when pol.polqual is not null then regexp_replace(pg_get_expr(pol.polqual, pol.polrelid), " + MASK + " end,", "'using_shape', pg_get_expr(pol.polqual, pol.polrelid),", True),
    ('a view definition is emitted unmasked', Q, "'def_shape', case when c.relkind in ('v', 'm') then regexp_replace(pg_get_viewdef(c.oid), " + MASK + " end,", "'def_shape', case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end,", True),
    ('a function body is emitted', Q, "'body_sha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'), 'body_length'", "'body_sha256', encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex'), 'body', p.prosrc, 'body_length'", True),
    ('a function setting value is emitted', Q, "else '<redacted>' end) from unnest(p.proconfig) cfg)", "else substr(cfg, strpos(cfg, '=') + 1) end) from unnest(p.proconfig) cfg)", True),
    ('foreign server option values are emitted', Q, "jsonb_agg(split_part(o, '=', 1) order by split_part(o, '=', 1)) from unnest(s.srvoptions) o", "jsonb_agg(o order by o) from unnest(s.srvoptions) o", True),
    ('setting values are emitted', Q, "jsonb_agg(split_part(o, '=', 1) order by split_part(o, '=', 1)) from unnest(s.setconfig) o", "jsonb_agg(o order by o) from unnest(s.setconfig) o", True),
    ('a sequence value is emitted', Q, "jsonb_build_object('type', format_type(s.seqtypid, null),", "jsonb_build_object('last', pg_sequence_last_value(c.oid), 'type', format_type(s.seqtypid, null),", True),
    ('a password hash is emitted', Q, "'login', r.rolcanlogin,", "'login', r.rolcanlogin, 'password', (select rolpassword from pg_authid x where x.oid = r.oid),", True),
    ('a row estimate is emitted', Q, "'persistence', c.relpersistence::text,\n", "'persistence', c.relpersistence::text, 'rows', c.reltuples,\n", True),
    ('the transaction is not read only', Q, "begin transaction isolation level repeatable read read only;", "begin transaction isolation level repeatable read;", True),
    ('the script commits', Q, "\nrollback;\n", "\ncommit;\n", False),
    ('network mentions are not computed', Q, "'net', lower(p.prosrc) ~ '(\\mnet\\.|pg_net|http_post|http_get)',", "'net', false,", True),
]


def run(root, database):
    commands = [['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', DIR]]
    if database:
        commands.append(['bash', 'supabase/tests/common_account_phase12_inventory_run.sh'])
    for command in commands:
        env = dict(os.environ, P12_REPO_ROOT=root)
        try:
            code = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
        except subprocess.TimeoutExpired:
            return 124
        if code != 0:
            return code
    return 0


def fresh_copy():
    root = tempfile.mkdtemp(prefix='p12-invmut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
root = fresh_copy()
control = run(root, True)
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
            print(f'INVALID   {label} (site matched {text.count(old)} times)', flush=True)
            invalid += 1
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        if run(root, database) != 0:
            detected += 1
            print(f'DETECTED  {label}', flush=True)
        else:
            print(f'SURVIVED  {label}', flush=True)
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'{detected}/{len(M)} detected, {invalid} invalid', flush=True)
sys.exit(0 if detected == len(M) and invalid == 0 else 1)
