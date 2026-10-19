"""Mutation check for the fail-closed SQL scanner and the lock (F5 Phase 12): ONE rule of sql_scan.ts / runner.ts /
lock.ts is broken in a scratch COPY; the harness's own tests (the adversarial corpus included) must fail. A control must
pass first. Pure Deno. Usage: python3 supabase/tests/common_account_phase12_scanner_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
# the Phase 13 documentation-consistency tests also read these trees
TREES = ['supabase/preflight', 'supabase/migrations', 'supabase/tests', 'docs/common-account', 'docs/postona', '.agent', 'apps/social-mobile', 'supabase/functions', 'supabase/candidates/common_account_brand_owner_epoch', 'supabase/candidates/common_account_postona_authz']
SUITE = 'supabase/preflight/managed_disposable/'
S = 'supabase/preflight/managed_disposable/sql_scan.ts'
R = 'supabase/preflight/managed_disposable/runner.ts'
L = 'supabase/preflight/managed_disposable/lock.ts'
M = [
    ('comments are not blanked before the rules run', S,
     "      while (i < n && sql[i] !== '\\n') i++;\n      out += ' ';\n      continue;", "      out += ch;\n      i++;\n      continue;"),
    ('block comments are not nested', S,
     "        if (sql[i] === '/' && sql[i + 1] === '*') { level++; i += 2; continue; }\n", ""),
    ('whitespace around dots is not collapsed', S,
     "const tidy = (text: string) => text.replace(/[ \\t\\r\\f\\v]*\\.[ \\t\\r\\f\\v]*/gu, '.').replace(/\\.\\s*\\n\\s*/gu, '.');",
     "const tidy = (text: string) => text;"),
    ('quoted identifiers are not unquoted', S,
     "      out += /^[A-Za-z_][A-Za-z0-9_$]*$/u.test(content) ? content.toLowerCase() : `\"${content.toLowerCase()}\"`;", "      out += `\"${content}\"`;"),
    ('dollar-quoted bodies are not scanned', S,
     "        out += delimiter + (lexed.ok ? lexed.text : inner) + delimiter;", "        out += delimiter + ' ' + delimiter;"),
    ('the cron rule is gone', S,
     "  { code: 'CRON_REFERENCE', pattern: /\\b(cron\\.[a-z_]+|pg_cron)\\b/giu, detail: 'references pg_cron' },\n", ""),
    ('the network rule is gone', S,
     "  { code: 'NET_REFERENCE', pattern:", "  { code: 'NET_REFERENCE_DISABLED', pattern:"),
    ('the Supabase host rule is gone', S,
     "  { code: 'SUPABASE_HOST_REFERENCE', pattern: /\\bsupabase\\.(co|in|net)\\b/giu, detail: 'names a Supabase host' },\n", ""),
    ('the URL literal rule is gone', S,
     "  { code: 'URL_LITERAL', pattern: /\\bhttps?:\\/\\//giu, detail: 'contains an http(s) URL' },\n", ""),
    ('the extension rule is gone', S,
     "  { code: 'EXTENSION_CREATE', pattern: /\\bcreate\\s+extension\\b/giu, detail: 'creates an extension' },\n", ""),
    ('the vault rule is gone', S,
     "  { code: 'VAULT_REFERENCE', pattern: /\\b(vault\\.[a-z_]+|pgsodium)\\b/giu, detail: 'references Vault' },\n", ""),
    ('untrusted languages are accepted', S,
     "  { code: 'UNTRUSTED_LANGUAGE', pattern: /\\blanguage\\s+(?!sql\\b|plpgsql\\b)[a-z_][a-z0-9_]*/giu, detail: 'a function in a language other than SQL / PL/pgSQL' },\n", ""),
    ('unicode-escaped spellings are accepted', S,
     "  { code: 'UNICODE_ESCAPE', pattern: /\\bu&\\s*[\"']/giu, detail: 'a unicode-escaped identifier or string (a way to spell a name the rules cannot read)' },\n", ""),
    ('dynamic SQL is not looked for', S,
     "const DYNAMIC = /(?<!grant\\s)(?<!revoke\\s)(?<!['\"])\\b(execute|prepare|query_to_xml(?:_and_xmlschema)?|cursor_to_xml)\\b",
     "const DYNAMIC = /(?<!grant\\s)(?<!revoke\\s)(?<!['\"])\\b(execute_never)\\b"),
    ('query_to_xml is not treated as dynamic SQL', S,
     "|prepare|query_to_xml(?:_and_xmlschema)?|cursor_to_xml)", "|prepare)"),
    ('top-level statements are not classified', S,
     "    if (!KNOWN_STATEMENTS.has(first)) {", "    if (false) {"),
    ('a top-level SELECT is not reviewed', S,
     "    if (first === 'select' || first === 'with') {", "    if (false) {"),
    ('data writes are not collected', S,
     "    writes.add(target);\n    add('DATA_WRITE', 'review', match.index ?? 0, `writes ${target}`, target);", "    void target;"),
    ('a trigger on a platform table is accepted', S,
     "  { code: 'PLATFORM_TRIGGER',", "  { code: 'PLATFORM_TRIGGER_OFF',"),
    ('network helpers are not recognised', S,
     "  for (const fn of definitions) if (direct(fn)) tainted.add(bare(fn.name));", "  void direct;"),
    ('a call of a network helper is accepted', S,
     "    if (tainted.has(bare(name)) && !own.has(name)) {\n      out.push({ code: 'INDIRECT_NETWORK_CALL'", "    if (false) {\n      out.push({ code: 'INDIRECT_NETWORK_CALL'"),
    ('an unterminated literal is not a finding', S,
     "  if (!lexed.ok) findings.push({ code: 'UNTERMINATED_LITERAL', severity: 'block', line: 1, detail: 'a quote, comment or dollar quote does not close: scanned raw' });\n", ""),
    # ---- J1 V1 R3 (Phase 12 follow-up): the corpus is closed over its call graph
    ('capability is not propagated through helpers', S,
     "      if (!tainted.has(name) && fn.calls.some((called) => tainted.has(bare(called)))) {", "      if (false) {"),
    ('a helper is matched with its schema', S,
     "const bare = (name: string) => name.slice(name.lastIndexOf('.') + 1);", "const bare = (name: string) => name;"),
    ('only dollar-quoted bodies are read', S,
     "    found.push({ name: def[1], body: statement.text });", "    found.push({ name: def[1], body: /\\$([A-Za-z_][A-Za-z0-9_]*)?\\$/u.test(statement.text) ? statement.text : '' });"),
    ('procedures are not definitions', S,
     "(?:function|procedure)\\s+([a-z_][a-z0-9_.]*)\\s*\\(/giu;\nconst FUNCTION_RENAME", "(?:function)\\s+([a-z_][a-z0-9_.]*)\\s*\\(/giu;\nconst FUNCTION_RENAME"),
    ('a rename is not an alias', S,
     "    definedFunctions.push({ name: match[2].toLowerCase(), networkCapable: false, calls: [match[1].toLowerCase()], dynamic: false });", "    void match;"),
    ('run-time SQL helpers are not collected', S,
     "  return scan.calledNames.filter((name) => tainted.has(bare(name)) && !own.has(name)).sort();", "  return [];"),
    ('a call of a run-time SQL helper needs no acceptance', R,
     "  for (const name of indirectDynamicCalls(scan, new Set(dynamicFunctions))) if (!indirect.has(name)) reasons.add('INDIRECT_DYNAMIC_CALL');\n", ""),
    ('accepted helper calls are not pinned in the lock', L,
     "      indirectDynamic: indirectDynamicCalls(scan, dynamicNames),", "      indirectDynamic: [],"),
    ('the lock does not carry the dynamic helper list', L,
     "  return { files, reviewed, networkFunctions, dynamicFunctions,", "  return { files, reviewed, networkFunctions, dynamicFunctions: [],"),
    ('the lock accepts any dynamic statement', R,
     "  for (const statement of scan.dynamic) if (!dynamic.has(await sha256Hex(statement.text))) reasons.add('DYNAMIC_SQL');\n", ""),
    ('the lock accepts any write target', R,
     "  for (const table of scan.writes) if (!writes.has(table)) reasons.add('DATA_WRITE');\n", ""),
    ('the lock accepts any top-level select', R,
     "  for (const statement of scan.topLevelSelects) if (!selects.has(await sha256Hex(statement.text))) reasons.add('TOP_LEVEL_SELECT');\n", ""),
    ('blocking findings do not refuse a file', R,
     "  for (const finding of scan.findings) if (finding.severity === 'block') reasons.add(finding.code);\n", ""),
    ('the corpus network helpers are not applied', R,
     "  for (const finding of indirectNetworkCalls(scan, new Set(networkFunctions))) reasons.add(finding.code);\n", ""),
    ('a file with a blocking finding can be locked', L,
     "    if (blocking.length > 0) throw new Error(`${path} has blocking findings and cannot be locked: ${[...new Set(blocking.map((f) => f.code))].join(',')}`);\n", ""),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', SUITE],
                              cwd=root, capture_output=True, text=True, timeout=240).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='p12-mut-', dir=os.environ.get('SCRATCH', None))
    for tree in TREES:
        shutil.copytree(os.path.join(src_root, tree), os.path.join(root, tree), ignore=shutil.ignore_patterns('node_modules'))
    return root


root = fresh_copy()
control = run(root)
shutil.rmtree(root, ignore_errors=True)
print(f'CONTROL   {"PASS" if control == 0 else "FAIL"}')
if control != 0:
    sys.exit(1)
detected = 0
for label, target, old, new in M:
    root = fresh_copy()
    try:
        path = os.path.join(root, target)
        text = open(path, encoding='utf-8').read()
        if text.count(old) != 1:
            print(f'INVALID   {label} (site matched {text.count(old)} times)')
            continue
        open(path, 'w', encoding='utf-8').write(text.replace(old, new))
        if run(root) != 0:
            detected += 1
            print(f'DETECTED  {label}')
        else:
            print(f'SURVIVED  {label}')
    finally:
        shutil.rmtree(root, ignore_errors=True)
print(f'{detected}/{len(M)} detected')
sys.exit(0 if detected == len(M) else 1)
