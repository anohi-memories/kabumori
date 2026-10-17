"""Mutation check for the managed-disposable harness (F5 Phase 11): ONE rule of guard.ts / runner.ts at a time is broken in
a scratch COPY, the harness's own unit and static tests must fail. A control (unmutated copy) must pass first.
Pure Deno, no database, no network. Usage: python3 supabase/tests/common_account_phase11_harness_mutations.py <repository root>"""
import os
import shutil
import subprocess
import sys
import tempfile

src_root = sys.argv[1]
# the Phase 13 documentation-consistency tests also read these trees
TREES = ['supabase/preflight', 'supabase/migrations', 'supabase/tests', 'docs/common-account', 'docs/postona', '.agent', 'apps/social-mobile', 'supabase/functions']
SUITE = 'supabase/preflight/managed_disposable/'
G = 'supabase/preflight/managed_disposable/guard.ts'
R = 'supabase/preflight/managed_disposable/runner.ts'
P = 'supabase/preflight/managed_disposable/plan.ts'
T = 'supabase/preflight/managed_disposable/transports.ts'
C = 'supabase/preflight/managed_disposable/cli.ts'
M = [
    ('the allowlist is not required', G,
     "  if (allowlist.length === 0) fail('ALLOWLIST_MISSING', `${ENV.allowlist} is not set: there is no implicit test project`);\n  else if",
     "  if (false) fail('ALLOWLIST_MISSING', '');\n  else if"),
    ('a target missing from the allowlist is accepted', G,
     "    if (allowlist.length > 0 && !allowlist.includes(ref)) fail('TARGET_NOT_ALLOWLISTED', 'the project is not on the allowlist');\n", ""),
    ('the production deny list is not consulted', G,
     "    if (production.has(ref)) fail('TARGET_IS_PRODUCTION', 'the project is a production project (deny list or named in the repository)');\n", ""),
    ('a polluted allowlist is tolerated', G,
     "  if (allowlist.some((entry) => production.has(entry))) {\n    fail('ALLOWLIST_CONTAINS_PRODUCTION', 'the allowlist names a production project: the whole configuration is refused');\n  }\n", ""),
    ('the deny list may be absent', G,
     "  if (denylist.length === 0) fail('DENYLIST_MISSING', `${ENV.denylist} is not set: production must be named explicitly`);\n  else if",
     "  if (false) fail('DENYLIST_MISSING', '');\n  else if"),
    ('the repository\'s own project refs are not treated as production', G,
     "  const production = new Set([...denylist, ...(options.repositoryRefs ?? [])]);", "  const production = new Set([...denylist]);"),
    ('the API URL may name another project', G,
     "    else if (PROJECT_REF.test(ref) && parsed.ref !== ref) fail('API_URL_REF_MISMATCH', 'the API URL names another project than the target ref');\n", ""),
    ('the API URL may carry a path or a port', G,
     "  if (parsed.search !== '' || parsed.hash !== '' || (parsed.pathname !== '/' && parsed.pathname !== '')) return null;\n", ""),
    ('the confirmation need not repeat the ref', G,
     "    else if (confirmation !== ref) fail('CONFIRM_MISMATCH', 'the confirmation is not the project ref');\n", ""),
    ('the approved baseline-contract digest is not required', G,
     "    if (!/^[0-9a-f]{64}$/u.test(trim(env[ENV.inventorySha256]))) fail('INVENTORY_DIGEST_MISSING',", "    if (false) fail('INVENTORY_DIGEST_MISSING',"),
    ('a probe file need not be pinned', R,
     "        if (pinned === undefined) throw new Error(`probe file ${path} is not pinned in the plan lock`);\n", ""),
    ('a probe file may differ from its pin', R,
     "        if (digest !== pinned) throw new Error(`probe file ${path} differs from its pinned digest`);\n", ""),
    ('the baseline read-back does not stop on a verdict', P,
     "      if (verdict.status !== 'PASS' || verdict.digest === undefined) return stop(verdict.detail);\n", ""),
    ('the cron / network footprint is not compared after the chain', P,
     "      return after === before ? pass(`unchanged (${after})`) : stop(`the footprint changed: before ${before}, after ${after}`);", "      return pass(`unchanged (${after})`);"),
    ('the cron / network footprint is not recorded before the chain', P,
     "      ctx.memo.silenceBefore = await silenceFootprint(ctx);\n", "      ctx.memo.silenceBefore = 'cron_jobs=0 network_triggers=0';\n"),
    ('the baseline read-back runs without requirements', P,
     "      if (!requirements) return stop('the plan lock carries no baseline requirements: regenerate it with cli.ts --write-lock');\n", ""),
    # ---- J1 V1 R1 / R2 (Phase 12 follow-up)
    ('the probe is sent from a second read of the path', R,
     "        return transport.sqlProbe(path, bytes);", "        return transport.sqlProbe(path, options.reader.read(path));"),
    ('the real transport reads the probe file itself', T,
     "    sqlProbe: (_path, bytes) => psql(psqlInvocation(config.dbUrl, 'probe', bytes)),",
     "    sqlProbe: async (path) => psql(psqlInvocation(config.dbUrl, 'probe', await Deno.readTextFile(path))),"),
    ('an unsafe selection is not refused up front', R,
     "  if (unsafe.length > 0) {\n    return { ...summarize(), refused:", "  if (false) {\n    return { ...summarize(), refused:"),
    ('an unknown step id in a selection is ignored', R,
     "  for (const name of selected) if (!ids.includes(name)) problems.push(`unknown step ${name}`);\n", ""),
    ('a selection may leave out a required step', R,
     "      else if (!selected.has(need)) problems.push(`${step.id} requires ${need}, which is not selected`);\n", ""),
    ('a step runs although its requirement did not pass', R,
     "    if (missing.length > 0) {\n      results.push({ id: step.id, title: step.title, status: 'STOP'", "    if (false) {\n      results.push({ id: step.id, title: step.title, status: 'STOP'"),
    ('a chain file is applied without the baseline grant', R,
     "        if (file.kind !== 'baseline') requireBaselineGrant(`file ${file.path}`);\n", ""),
    ('a login is created without the baseline grant', R,
     "          if (!step.always) requireBaselineGrant(`${request.method} ${request.path}`);\n", ""),
    ('a lock is held without the baseline grant', R,
     "          if (!step.always) requireBaselineGrant('a held lock');\n", ""),
    ('the gate evidence need not name the approved digest', R,
     "          && evidence.digest === options.lock.approvedInventory\n", "\n"),
    ('the gate evidence need not name a probe the run sent', R,
     "          && sentProbes.get(evidence.probePath) !== undefined && sentProbes.get(evidence.probePath) === options.lock.files[evidence.probePath];",
     ";"),
    ('mutating steps do not require the baseline read-back', P,
     "  step.access === 'mutate' && step.always !== true && step.id !== 'G3a' ? { ...step, requires: [BASELINE_GATE] } : step", "  step"),
    ('the database URL may name another project', G,
     "      else if (!parsed.refs.includes(ref)) fail('DB_URL_REF_MISMATCH', 'the database URL does not name the target project');\n", ""),
    ('a service key is accepted as the publishable key', G,
     "    else if (/service_role|sb_secret_/u.test(publishable) || looksLikeServiceRoleJwt(publishable)) {\n      fail('PUBLISHABLE_KEY_WRONG_KIND', 'a service / secret key was given where the publishable key belongs');\n    }\n", ""),
    ('a public mail provider is accepted as the test domain', G,
     "|| PUBLIC_MAIL_DOMAINS.has(emailDomain)", ""),
    ('a cron job in a file is not found', G,
     "  if (/\\bcron\\.schedule\\s*\\(/iu.test(text)) findings.push({ code: 'CRON_SCHEDULE', detail: 'schedules a cron job' });\n", ""),
    ('another project\'s host in a file is not found', G,
     "    if (ref !== targetRef) findings.push({ code: 'FOREIGN_PROJECT_HOST', detail: `names project ${ref.slice(0, 4)}…${ref.slice(-4)}` });", "    void ref;"),
    ('redaction does nothing', G,
     "    for (const value of values) out = out.split(value).join('[REDACTED]');\n", ""),
    ('a dry run reaches the transport', R,
     "  if (options.mode === 'dry-run') {\n    for (const step of steps) {",
     "  if (options.mode === 'dry-run') {\n    await options.transport?.sqlRead('select 1');\n    for (const step of steps) {"),
    ('execute proceeds although the target did not resolve', R,
     "  if (!options.decision.ok) {\n    return { ...summarize(), refused: options.decision.failures.map((f) => ({ code: f.code, detail: redact(f.detail) })), results: [], complete: false };\n  }\n  // an unsafe partial selection",
     "  if (false) {\n    return { ...summarize(), refused: [], results: [], complete: false };\n  }\n  // an unsafe partial selection"),
    ('the identity is not re-read before a mutating request', R,
     "          if (!step.always) requireBaselineGrant(`${request.method} ${request.path}`);\n          await verifyIdentity();\n",
     "          if (!step.always) requireBaselineGrant(`${request.method} ${request.path}`);\n"),
    ('the identity is not read before a mutating step', R,
     "      if (step.access === 'mutate') await verifyIdentity();\n      let verdict", "      let verdict"),
    ('a read-only step may send a mutation', R,
     "          if (!mutating) throw new Error(`step ${step.id} is declared read-only and may not send ${request.method}`);\n", ""),
    ('a file need not be pinned', R,
     "        if (pinned === undefined) throw new Error(`file ${file.path} is not pinned in the plan lock`);\n", ""),
    ('a file may differ from its pin', R,
     "        if ((await sha256Hex(bytes)) !== pinned) throw new Error(`file ${file.path} differs from its pinned digest`);\n", ""),
    ('a file is not scanned for effects', R,
     "        if (refusals.length > 0) throw new Error(`file ${file.path} refused: ${refusals.join(',')}`);\n", ""),
    ('a failure does not end the run', R,
     "      if ((verdict.status === 'FAIL' || verdict.status === 'STOP') && !stoppedAt) stoppedAt = step.id;", "      void 0;"),
    ('teardown does not run after a failure', R,
     "    if (stoppedAt && step.always !== true) {", "    if (stoppedAt) {"),
    ('an identity mismatch is only a FAIL, not a STOP', R,
     "const stopping = failure instanceof IdentityError || failure instanceof GateError;", "const stopping = false;"),
    ('a run with an open manual item is "complete"', R,
     " && results.every((r) => (r.manual?.length ?? 0) === 0),", ","),
    ('the CLI defaults to execution', C,
     "const execute = args.has('--execute');", "const execute = !args.has('--dry-run');"),
    ('the database password goes into argv', T,
     "    PGPASSWORD: decodeURIComponent(parsed.password),", "    PGPASSWORD: '',"),
    ('the teardown is not marked to always run', P,
     "modelled: true, always: true,", "modelled: true,"),
]


def run(root):
    try:
        return subprocess.run(['deno', 'test', '--no-config', '--no-check', '--allow-read', '--allow-env', SUITE],
                              cwd=root, capture_output=True, text=True, timeout=180).returncode
    except subprocess.TimeoutExpired:
        return 124


def fresh_copy():
    root = tempfile.mkdtemp(prefix='p11-mut-', dir=os.environ.get('SCRATCH', None))
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
