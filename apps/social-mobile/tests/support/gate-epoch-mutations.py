"""Mutation check for the ServiceEnrollmentGate epoch refresh (F5): ONE guard of the gate is broken in a scratch COPY of
apps/social-mobile; the gate tests must fail. A control (unmutated) must pass first. Usage (from apps/social-mobile): SCRATCH=<tmp dir> python3 tests/support/gate-epoch-mutations.py ."""
import os, shutil, subprocess, sys, tempfile
app = sys.argv[1]
G = 'src/features/service-enrollment/service-enrollment-gate.tsx'
S = 'src/features/service-enrollment/lifecycle-epoch.ts'
M = [
    ('the epoch is not read (always 0)', G, "  const epoch = useLifecycleEpoch(userId);", "  const epoch = 0; void useLifecycleEpoch;"),
    ('a changed epoch does not reset the remembered answer', G, "    if (askedFor.current.userId === userId && askedFor.current.epoch !== epoch) enrollment.reset();\n", ""),
    ('the automatic effect does not depend on the epoch', G, "  }, [attempt, selection, userId, loginId, epoch]);", "  }, [attempt, selection, userId, loginId]);"),
    ('a decided answer is not tagged with its epoch', G, "  owner.userId === userId && owner.loginId === loginId && owner.epoch === epoch;", "  owner.userId === userId && owner.loginId === loginId;"),
    ('the rendered state ignores the epoch (stale ready stays open)', G, "const current: GateView = isOwner(view, userId, loginId, epoch) ?", "const current: GateView = isOwner(view, userId, loginId, view.epoch) ?"),
    ('a refresh restarts the ended service by itself', G, "        const outcome = await enrollment.ensure({ userId, accessToken });\n        if (!cancelled && mine === request.current) setView({ userId, loginId, epoch, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });",
     "        let outcome = await enrollment.ensure({ userId, accessToken });\n        if (outcome.kind === 'reenroll_required') outcome = await enrollment.explicit({ userId, accessToken }, (c, sg) => reactivateServiceExplicitly(transportFor(c), 'x_autopost', outcome.lifecycleVersion, sg));\n        if (!cancelled && mine === request.current) setView({ userId, loginId, epoch, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });"),
    ('the error view is not tagged with the epoch (no retry is shown)', G, "if (!cancelled && mine === request.current) setView({ userId, loginId, epoch, request: mine, kind: 'error' });\n      }\n    });", "if (!cancelled && mine === request.current) setView({ userId, loginId, epoch: -1, request: mine, kind: 'error' });\n      }\n    });"),
    ('the gate imports the F4 provider directly', G, "from '@/features/service-enrollment/lifecycle-epoch';", "from '@/features/service-lifecycle/service-lifecycle';"),
    ('the seam answers a non-zero epoch for a person', S, "export const useLifecycleEpoch: LifecycleEpochHook = () => 0;", "export const useLifecycleEpoch: LifecycleEpochHook = (userId) => (userId ? 1 : 0);"),
    ('the seam claims to be connected', S, "export const LIFECYCLE_SIGNAL_CONNECTED = false;", "export const LIFECYCLE_SIGNAL_CONNECTED = true;"),
    ('the seam becomes a stateful provider', S, "export const useLifecycleEpoch: LifecycleEpochHook = () => 0;", "import { useState } from 'react';\nexport const useLifecycleEpoch: LifecycleEpochHook = () => useState(0)[0];"),
    ('the gate produces the signal itself', G, "  const epoch = useLifecycleEpoch(userId);", "  const epoch = useLifecycleEpoch(userId); const bump = () => {}; bump();"),
    ('the sign-out reset is gone', G, "  useEffect(() => () => enrollment.reset(), []);", "  useEffect(() => () => undefined, []);"),
]
# Redundant guards: each is covered by another guard on every path the harness (and React) can take, so breaking only
# this one cannot be observed. They are listed so the reasoning is reproducible: they are EXPECTED to survive.
EQUIVALENT = [
    ('the queued ask does not check the epoch', G, "!isOwner(currentOwner.current, userId, loginId, epoch)) return;", "false) return;"),
    ('the view is not tagged with the epoch it was asked at', G, "setView({ userId, loginId, epoch, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });\n      } catch", "setView({ userId, loginId, epoch: currentOwner.current.epoch, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });\n      } catch"),
    ('a late answer of an older request may set the view', G, "if (!cancelled && mine === request.current) setView({ userId, loginId, epoch, request: mine, kind: 'outcome'", "if (!cancelled) setView({ userId, loginId, epoch, request: mine, kind: 'outcome'"),
    ('retry is not tagged with the epoch', G, "setView({ userId, loginId, epoch, request: ++request.current, kind: 'loading' });", "setView({ userId, loginId, epoch: -1, request: ++request.current, kind: 'loading' });"),
    ('a click is honoured for another epoch', G, "!isOwner(view, userId, loginId, epoch) || view.outcome.kind !== 'reenroll_required') return;", "!isOwner(view, userId, loginId, view.epoch) || view.outcome.kind !== 'reenroll_required') return;"),
    ('a click result of another epoch is applied', G, "isOwner(currentOwner.current, clicked.userId, clicked.loginId, clicked.epoch)) {\n            setView({ ...clicked, request: mine, kind: 'outcome'", "true) {\n            setView({ ...clicked, request: mine, kind: 'outcome'"),
]

def run(root):
    try:
        return subprocess.run(['node', '--test', '--test-timeout=60000', 'tests/service-enrollment-lifecycle.test.mjs', 'tests/service-enrollment.test.mjs'], cwd=root, capture_output=True, text=True, timeout=240).returncode
    except subprocess.TimeoutExpired:
        return 124
def fresh():
    base = tempfile.mkdtemp(prefix='gate-mut-', dir=os.environ.get('SCRATCH'))
    root = os.path.join(base, 'apps', 'social-mobile')
    os.makedirs(root)
    for item in ['src', 'tests', 'package.json', 'tsconfig.json']:
        src = os.path.join(app, item)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(root, item))
    os.symlink(os.path.realpath(os.path.join(app, 'node_modules')), os.path.join(root, 'node_modules'))
    # the root app's copy of the enrollment logic is compared by one test
    repo = os.path.realpath(os.path.join(app, '..', '..'))
    os.makedirs(os.path.join(base, 'src', 'lib'))
    shutil.copy(os.path.join(repo, 'src', 'lib', 'service-enrollment.ts'), os.path.join(base, 'src', 'lib', 'service-enrollment.ts'))
    return root
r = fresh(); c = run(r); shutil.rmtree(os.path.dirname(os.path.dirname(r)), ignore_errors=True)
print('CONTROL', 'PASS' if c == 0 else 'FAIL', flush=True)
if c: sys.exit(1)
det = inv = 0
for label, target, old, new in M:
    r = fresh()
    try:
        p = os.path.join(r, target); t = open(p, encoding='utf-8').read()
        if t.count(old) != 1:
            print('INVALID', label, t.count(old)); inv += 1; continue
        open(p, 'w', encoding='utf-8').write(t.replace(old, new))
        if run(r) != 0: det += 1; print('DETECTED ', label, flush=True)
        else: print('SURVIVED ', label, flush=True)
    finally: shutil.rmtree(os.path.dirname(os.path.dirname(r)), ignore_errors=True)
eqs = 0
for label, target, old, new in EQUIVALENT:
    r = fresh()
    try:
        p = os.path.join(r, target); t = open(p, encoding='utf-8').read()
        if t.count(old) != 1: print('INVALID', label, t.count(old)); inv += 1; continue
        open(p, 'w', encoding='utf-8').write(t.replace(old, new))
        if run(r) != 0: print('DETECTED (equivalent guard turned out observable):', label)
        else: eqs += 1; print('EQUIVALENT (redundant guard, expected to survive):', label, flush=True)
    finally: shutil.rmtree(os.path.dirname(os.path.dirname(r)), ignore_errors=True)
print(f'{det}/{len(M)} detected, {eqs}/{len(EQUIVALENT)} equivalent survivors, {inv} invalid')
sys.exit(0 if det == len(M) and inv == 0 else 1)
