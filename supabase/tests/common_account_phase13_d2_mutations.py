"""Mutation check for the X saga stand-in (F5 Phase 13, D-2): ONE rule of the stand-in, its adapters, its tripwires or its
production-exclusion check is broken in a scratch COPY; the tests that guard it (and, for the flagged ones, the PostgreSQL-backed
end-to-end run) must fail. A control must pass first. Usage (needs the local PostgreSQL socket variables):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> \
    python3 supabase/tests/common_account_phase13_d2_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
# the document test of the stand-in reads docs/; the exclusion check walks supabase/ and apps/
TREES = ['supabase', 'apps/social-mobile', 'docs/common-account']
D = 'supabase/preflight/managed_disposable/x_saga_standin/'
S = D + 'standin.ts'
H = D + 'harness.ts'
T = D + 'tripwire.ts'
X = D + 'exclusion.ts'
SUITE = D
RUNNER = 'supabase/tests/common_account_phase13_d2_standin_run.sh'

# (label, file, old, new, needs_database_run)
M = [
    # ---- the stand-in: markers, fail-closed, armed, scope rule, acknowledgement
    ('effects are claimed', S, "{ effects_performed: false, remote_x_verified: false, production_usable: false } as const", "{ effects_performed: true, remote_x_verified: false, production_usable: false } as const", False),
    ('a remote verification is claimed', S, "{ effects_performed: false, remote_x_verified: false, production_usable: false } as const", "{ effects_performed: false, remote_x_verified: true, production_usable: false } as const", False),
    ('production use is claimed', S, "{ effects_performed: false, remote_x_verified: false, production_usable: false } as const", "{ effects_performed: false, remote_x_verified: false, production_usable: true } as const", False),
    ('an exhausted script answers clean', S, "const step: StandInStep = queue.shift() ?? { scenario: 'failed' };", "const step: StandInStep = queue.shift() ?? { scenario: 'clean' };", False),
    ('a disabled stand-in still runs', S, "      runs += 1;\n      if (config.onRun) await config.onRun(userId, runs);\n      if (!config.armed) {", "      runs += 1;\n      if (config.onRun) await config.onRun(userId, runs);\n      if (false) {", False),
    ('a disabled stand-in still previews', S, "    async preview(userId) {\n      if (!config.armed) {", "    async preview(userId) {\n      if (false) {", True),
    ('a POSTONA-only person gets the login-keeping scope (R2\' papered over)', S, "const scope = (await config.persons.hasKabumoriProfile(userId)) ? 'social_only' : 'social_and_login';", "const scope = 'social_only';", True),
    ('a bare count acknowledges', S, "      if (!isStandInSnapshot(snapshot)) return answer({ status: 'snapshot_required' });\n", "", False),
    ('a stale snapshot is never stale', S, "      if (staleLeft > 0 && snapshot === currentName) {", "      if (false) {", True),
    ('a replay is not a replay', S, "return answer({ status: 'acknowledged', cleared: last.count, replay: true });", "return answer({ status: 'acknowledged', cleared: last.count, replay: false });", False),
    ('another person\'s snapshot clears this person\'s set', S, "      if (snapshot !== currentName) {", "      if (false) {", False),
    ('the snapshot name ignores the person', S, "`x-saga-stand-in|${userId}|${generation}`", "`x-saga-stand-in|${generation}`", False),
    ('a run is not recorded', S, "      note('run', userId, step.scenario, false);\n", "", False),
    # ---- the adapters
    ('a conversion is not registered as simulated', H, "  registered.add(result);\n", "", False),
    ('a converted result is mutable', H, "  return Object.freeze(result);", "  return result;", False),
    ('a block is converted to in_progress', H, "case 'blocked': return simulatedResult({ outcome: 'blocked', reason: result.facts.reason });", "case 'blocked': return simulatedResult({ outcome: 'in_progress' });", False),
    ('a revoke failure is converted to a block', H, "case 'reconciliation_required': return simulatedResult({ outcome: 'failed', reason: result.facts.reason });", "case 'reconciliation_required': return simulatedResult({ outcome: 'blocked', reason: result.facts.reason });", False),
    ('a disabled stand-in is a success for the preview', H, "return answer.kind === 'simulated' ? { scope: answer.scope, state: answer.state } : null;", "return answer.kind === 'simulated' ? { scope: answer.scope, state: answer.state } : { scope: 'social_only', state: 'none' };", False),
    ('an unreadable token is a person', H, "      if (userId === null) return null;\n      const answer = await standIn.preview(userId);", "      const answer = await standIn.preview(String(userId));", False),
    ('every RPC is answered by the stand-in', H, "    if (name !== 'ack_x_unconfirmed') return await rpc(name, args);", "    if (false) return await rpc(name, args);", False),
    ('the saga answer loses the marker', H, "const tagged = (body: Record<string, unknown>) => ({ ...body, stand_in: { simulated: true, ...STAND_IN_MARKERS } });", "const tagged = (body: Record<string, unknown>) => ({ ...body });", False),
    ('a busy saga answers ok over HTTP', H, "case 'in_progress': return respond({ ok: false, error: 'DELETION_IN_PROGRESS' }, 409);", "case 'in_progress': return respond({ ok: true, login_deleted: false }, 200);", True),
    ('a block loses its reason over HTTP', H, "case 'blocked': return respond({ ok: false, error: `DELETION_BLOCKED_${result.facts.reason}` }, 409);", "case 'blocked': return respond({ ok: false, error: 'DELETION_BLOCKED_UNKNOWN' }, 409);", True),
    ('the report loses the banner', H, "return [REPORT_BANNER, ...records.map(", "return [...records.map(", False),
    # ---- the tripwires
    ('fetch is not armed', T, "  replace(globalThis, 'fetch', () => refuse('fetch'), 'fetch');\n", "", False),
    ('sockets are not armed', T, "    if (Object.getOwnPropertyDescriptor(Deno, name)) replace(Deno, name, () => refuse(`Deno.${name}`), `Deno.${name}`);", "    void name;", False),
    ('secret environment reads pass', T, "    if (SECRET_ENV_NAME.test(name)) {", "    if (false) {", False),
    ('the tripwires are re-entrant', T, "  if (armed) throw new Error('the tripwires are already armed');", "  void armed;", False),
    ('the tripwires are not restored', T, "  return { hits, restore: () => { while (restorers.length) restorers.pop()!(); armed = false; } };", "  return { hits, restore: () => { armed = false; } };", False),
    # ---- the production exclusion check
    ('production reachability ignores export-from edges', X, "  for (const match of noComments.matchAll(/\\b(import|export)\\s+(type\\s+)?", "  for (const match of noComments.matchAll(/\\b(import)\\s+(type\\s+)?", False),
    ('production reachability is never computed', X, "  for (const file of reachable(entries, reader.read)) if (inDir(file))", "  for (const file of []) if (inDir(file))", False),
    ('production may name the directory', X, "    if (reader.read(file).includes('x_saga_standin')) add('PRODUCTION_MENTIONS_STAND_IN'", "    if (false) add('PRODUCTION_MENTIONS_STAND_IN'", False),
    ('other places may name the directory', X, "      if (reader.read(file).includes('x_saga_standin')) add('MENTIONED_OUTSIDE_ALLOWED'", "      if (false) add('MENTIONED_OUTSIDE_ALLOWED'", False),
    ('a value import from production is accepted', X, "        else if (!ref.typeOnly) add('VALUE_IMPORT_FROM_PRODUCTION'", "        else if (false) add('VALUE_IMPORT_FROM_PRODUCTION'", False),
    ('network code is accepted in a runtime file', X, "  { code: 'NETWORK', pattern: /\\bfetch\\s*\\(|\\bXMLHttpRequest\\b|\\bWebSocket\\b|\\bEventSource\\b|\\bsendBeacon\\b|\\bBroadcastChannel\\b/u },\n", "", False),
    ('the Deno namespace is accepted in a runtime file', X, "  { code: 'DENO_NAMESPACE', pattern: /\\bDeno\\b/u },\n", "", False),
    ('a second `done` is accepted', X, "    const allowed = file.endsWith('/harness.ts') ? 1 : 0;", "    const allowed = file.endsWith('/harness.ts') ? 2 : 1;", False),
    ('secret-shaped text in the directory is accepted', X, "    for (const finding of secretFindings(reader.read(file))) add('SECRET_SHAPED'", "    for (const finding of []) add('SECRET_SHAPED'", False),
]


def run(root, database):
    if database:
        commands = [['bash', RUNNER]]
    else:
        commands = [['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', SUITE]]
    for command in commands:
        env = dict(os.environ, P13D2_REPO_ROOT=root)
        try:
            code = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=600, env=env).returncode
        except subprocess.TimeoutExpired:
            return 124
        if code != 0:
            return code
    return 0


def fresh_copy():
    root = tempfile.mkdtemp(prefix='p13d2-mut-', dir=os.environ.get('SCRATCH', None))
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
