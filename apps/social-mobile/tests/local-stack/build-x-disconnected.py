# G1 TASK 36. Builds the two test files (the existing harness + a tail, so the screens are mounted exactly as in the unit tests) and a copy of
# G3's local_stack/run.sh that stops after the runtime is up and runs them instead of G3's own suites. G3's files are read, never written.
# Usage: build-x-disconnected.py <output dir for run.sh copy>. Generated tests go to tests/zz-*.generated.mjs and are removed by the runner.
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.dirname(HERE)
REPO = os.path.abspath(os.path.join(TESTS, '../../..'))
LOCAL_STACK = os.path.join(REPO, 'supabase/candidates/postona_reservations_rollout/local_stack')
out = sys.argv[1]

def read(path):
    with open(path, encoding='utf-8') as f:
        return f.read()

def sub(text, old, new):
    assert text.count(old) == 1, old[:70]
    return text.replace(old, new)

SETTLE_REAL = "const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 200)); }; // real network"
STACK_IMPORT = "import * as stack from './local-stack/x-disconnected-world.mjs';\nimport { randomUUID } from 'node:crypto';\n"

# ---- the reservations screen
t = read(os.path.join(TESTS, 'reservation-screens.test.mjs'))
# helpers and tests alternate in this file: keep the helpers
head = re.sub(r"^test\('.*?^\}\);\n", '', t, flags=re.M | re.S)
head = sub(head, "const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];", "const NETWORK = [];")
head = sub(head, "const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };", SETTLE_REAL)
head = sub(head, "import test from 'node:test';\n", "import test from 'node:test';\n" + STACK_IMPORT + "import * as onboarding from '../src/domain/onboarding.ts';\n")
if os.environ.get('G1T36_MUTANT') == 'reads_need_connection':  # negative control: this check must fail without the client change
    head = sub(head, "const source = await readFile(new URL('../src/app/reservations/index.tsx', import.meta.url), 'utf8');", "const source = (await readFile(new URL('../src/app/reservations/index.tsx', import.meta.url), 'utf8')).replace(\"platform !== 'x')\", 'true)');")
if os.environ.get('G1T36_MUTANT') == 'refused_row_not_recorded':  # negative control: the row must stop reading 予約済み
    head = sub(head, "const source = await readFile(new URL('../src/app/reservations/index.tsx', import.meta.url), 'utf8');", "const source = (await readFile(new URL('../src/app/reservations/index.tsx', import.meta.url), 'utf8')).replace('if (stillCancellable) markXRowNotEditable(edited.reservationId);', '');")
with open(os.path.join(TESTS, 'zz-x-disconnected-manage.generated.mjs'), 'w', encoding='utf-8') as f:
    f.write(head + read(os.path.join(HERE, 'x-disconnected-manage.tail.mjs')))

# ---- the 投稿予定 tab
t = read(os.path.join(TESTS, 'x-reservation-composer.test.mjs'))
head = t[:t.index("test('gate OFF (G3")]
head = sub(head, "const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];", "const REAL_FETCH = globalThis.fetch;\nconst NETWORK = [];")
head = sub(head, "import test from 'node:test';\n", "import test from 'node:test';\n" + STACK_IMPORT)
head = sub(head, "async function screen({ gate = true, reply = null, account = ACCOUNT, workspaceId = ME } = {}) {", "async function screen({ gate = true, reply = null, account = ACCOUNT, workspaceId = ME, token = null, userId = null } = {}) {")
head = sub(head, "const world = { account, workspaceId, token: jwt('person-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'), userId: 'person-1',", "const world = { account, workspaceId, token, userId,")
head = sub(head, "const settle = async () => { for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve)); };", SETTLE_REAL)
head = sub(head, "async function planOne(h, text = 'hello', batchId = 'f0e2b1a4-0000-4000-8000-000000000001') {", "async function planOne(h, text = 'hello', batchId = 'f0e2b1a4-0000-4000-8000-000000000001', days = 5) {")
head = sub(head, "Date.now() + 5 * 864e5", "Date.now() + days * 864e5")
for name in ['saveButton', 'pressSave']:
    assert ('const %s' % name in head) or ('function %s' % name in head), name
with open(os.path.join(TESTS, 'zz-x-disconnected-tab.generated.mjs'), 'w', encoding='utf-8') as f:
    f.write(head + read(os.path.join(HERE, 'x-disconnected-tab.tail.mjs')))

# ---- the runtime: G3's run.sh up to "functions serve is ready", then these tests
r = read(os.path.join(LOCAL_STACK, 'run.sh'))
r = sub(r, 'here="$(cd "$(dirname "$0")" && pwd)"', 'here="%s"' % LOCAL_STACK)
cut = r.index('env -u PGPASSWORD G3LS_API="http://127.0.0.1:$API_PORT"')
r = r[:cut] + '''
export G3LS_API="http://127.0.0.1:$API_PORT" G3LS_PUBLISHABLE="$PUBLISHABLE" G3LS_DB_PORT="$DB_PORT"
unset PGPASSWORD
cd "%s" || exit 1
"${G1T36_RUN:?}"
exit $?
''' % os.path.dirname(TESTS)
with open(os.path.join(out, 'g1t36-run.sh'), 'w', encoding='utf-8') as f:
    f.write(r)
print('built')
