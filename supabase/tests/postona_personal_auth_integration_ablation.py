"""G5-36 ablation check for the integration suite: leave ONE candidate out of the integrated world (S36_ABLATE) and require that the install
test still PASSES (the world is consistent without it) while at least one test of the negative matrix FAILS -- i.e. the matrix depends on that
candidate, and the full-world PASS is not vacuous. A control (nothing left out) must pass first. Usage (a THROW-AWAY local cluster):
  CAL_PGHOST=/private/tmp/<socket> CAL_PGPORT=<port> CAL_PGSUPER=<superuser> python3 supabase/tests/postona_personal_auth_integration_ablation.py"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, 'postona_personal_auth_integration_pg_run.sh')
INSTALL = 'install order on the reviewed world'
ABLATIONS = {
    's21': 'S2-1 (T13 refuses an anonymous / unproven caller)',
    's22': 'S2-2 (the person-session gate)',
    's23': 'S2-3 (the personal-workspace predicate; R0 stays as D1 leaves it)',
}
ANSI = re.compile(r'\x1b\[[0-9;]*m')


def run(ablate):
    env = dict(os.environ, S36_ABLATE=ablate)
    r = subprocess.run(['bash', RUNNER], capture_output=True, text=True, timeout=900, env=env)
    text = ANSI.sub('', r.stdout + r.stderr)
    return r.returncode, re.findall(r'^(.+?) \.\.\. ok', text, re.M), re.findall(r'^(.+?) \.\.\. FAILED', text, re.M)


for name in ('CAL_PGHOST', 'CAL_PGPORT', 'CAL_PGSUPER'):
    if not os.environ.get(name):
        sys.exit(f'{name} is required')
code, passed, failed = run('')
print(f'CONTROL   {"PASS" if code == 0 and not failed else "FAIL"}', flush=True)
if code != 0 or failed:
    sys.exit(1)
good = 0
for key, label in ABLATIONS.items():
    code, passed, failed = run(key)
    install_ok = any(t.startswith(INSTALL) for t in passed)
    matrix = [t for t in failed if not t.startswith(INSTALL)]
    ok = code != 0 and install_ok and matrix != []
    good += 1 if ok else 0
    print(f'{"FAILS_AS_EXPECTED" if ok else "NOT_SHOWN       "} without {label}: install {"ok" if install_ok else "FAILED"}; failing tests: '
          + ' | '.join(t[:70] for t in matrix), flush=True)
print(f'ABLATIONS {good}/{len(ABLATIONS)} make the matrix fail', flush=True)
sys.exit(0 if good == len(ABLATIONS) else 1)
