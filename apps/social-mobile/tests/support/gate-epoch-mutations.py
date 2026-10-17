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
    # The seam after the joint F4+F5 connection: a stateless re-export of F4's per-person epoch hook.
    ('the seam answers a constant instead of F4\'s number', S, "export { useServiceLifecycleEpoch as useLifecycleEpoch } from '@/features/service-lifecycle/service-lifecycle';", "export const useLifecycleEpoch: LifecycleEpochHook = () => 0;"),
    ('the seam claims not to be connected', S, "export const LIFECYCLE_SIGNAL_CONNECTED = true;", "export const LIFECYCLE_SIGNAL_CONNECTED = false;"),
    ('the seam becomes a stateful provider', S, "export { useServiceLifecycleEpoch as useLifecycleEpoch } from '@/features/service-lifecycle/service-lifecycle';", "import { useState } from 'react';\nexport const useLifecycleEpoch: LifecycleEpochHook = () => useState(0)[0];"),
    # ---- J2 V2 P2-1 / P2-2
    ('the gate draws its own copy of the end screen again', G, "import { useLifecycleEpoch } from '@/features/service-enrollment/lifecycle-epoch';", "import { useLifecycleEpoch } from '@/features/service-enrollment/lifecycle-epoch';\nimport AccountDeletionScreen from '@/app/account-deletion';\nvoid AccountDeletionScreen;"),
    ('the management entry does nothing', G, "    if (signedIn !== null && signedIn === userId) lifecycle.open(signedIn);", "    void signedIn;"),
    ('the management entry opens for the identity of the render', G, "    if (signedIn !== null && signedIn === userId) lifecycle.open(signedIn);", "    if (userId !== null) lifecycle.open(userId);"),
    ('the management entry opens for whoever is signed in, whatever the render was drawn for', G, "    if (signedIn !== null && signedIn === userId) lifecycle.open(signedIn);", "    if (signedIn !== null) lifecycle.open(signedIn);"),
    ('the re-enroll click does not compare with the latest question', G, "    if (!isCurrentQuestion(clicked, shown)) return;\n    const mine = ++request.current;", "    const mine = ++request.current;"),
    ('the re-enroll click compares the owner but not the request', G, "isOwner(currentOwner.current, origin.userId, origin.loginId, origin.epoch) && originRequest === request.current, []);", "isOwner(currentOwner.current, origin.userId, origin.loginId, origin.epoch), []);"),
    ('the notice acknowledgement has neither guard', G, "            if (!isCurrentQuestion(origin, shown)) return;\n            setView((previous) => (previous.kind === 'outcome' && isOwner(previous, userId, loginId, epoch) && previous.request === shown\n              ? { ...previous, noticeAcknowledged: true } : previous));", "            setView((previous) => (previous.kind === 'outcome' ? { ...previous, noticeAcknowledged: true } : previous));"),
    ('the dispatch-time check is gone (behaviourally redundant; pinned by the source-order test)', G, "        if (mine !== request.current || !isOwner(currentOwner.current, clicked.userId, clicked.loginId, clicked.epoch)) throw new EnrollmentCancelledError();\n", ""),
    ('the retry is not compared with the latest question', G, "    if (!isCurrentQuestion({ userId, loginId, epoch }, view.request)) return;\n    enrollment.reset();", "    enrollment.reset();"),
    ('the gate\'s old copy of the opened identity returns', G, "  const explicitInFlight = useRef(false);\n", "  const explicitInFlight = useRef(false);\n  const [deletionOpenFor, setDeletionOpenFor] = useState<string | null>(null);\n  void deletionOpenFor; void setDeletionOpenFor;\n"),
    ('the gate produces the signal itself', G, "  const epoch = useLifecycleEpoch(userId);", "  const epoch = useLifecycleEpoch(userId); const bump = () => {}; bump();"),
    ('the sign-out reset is gone', G, "  useEffect(() => () => enrollment.reset(), []);", "  useEffect(() => () => undefined, []);"),
]
# Redundant guards: each is covered by another guard on every path the harness (and React) can take, so breaking only
# this one cannot be observed. They are listed so the reasoning is reproducible: they are EXPECTED to survive.
# A change of the owner (person, login or epoch) always advances the request counter in the same commit, and the request
# comparison alone blocks every old callback; likewise the notice acknowledgement is guarded twice. So each single guard
# below cannot be observed on its own through the public behaviour: they are EXPECTED to survive (the combined removals
# above are detected). The task asks for both comparisons; they are kept as defence in depth.
EQUIVALENT = [
    ('the re-enroll click compares the request but not the owner', G, "isOwner(currentOwner.current, origin.userId, origin.loginId, origin.epoch) && originRequest === request.current, []);", "originRequest === request.current, []);"),
    ('the re-enroll click ignores the epoch', G, "isOwner(currentOwner.current, origin.userId, origin.loginId, origin.epoch) && originRequest === request.current, []);", "isOwner(currentOwner.current, origin.userId, origin.loginId, currentOwner.current.epoch) && originRequest === request.current, []);"),
    ('the re-enroll click ignores the login', G, "isOwner(currentOwner.current, origin.userId, origin.loginId, origin.epoch) && originRequest === request.current, []);", "isOwner(currentOwner.current, origin.userId, currentOwner.current.loginId, origin.epoch) && originRequest === request.current, []);"),
    ('the re-enroll click ignores the person', G, "isOwner(currentOwner.current, origin.userId, origin.loginId, origin.epoch) && originRequest === request.current, []);", "isOwner(currentOwner.current, currentOwner.current.userId, origin.loginId, origin.epoch) && originRequest === request.current, []);"),
    ('the notice acknowledgement is not compared with the latest question', G, "            if (!isCurrentQuestion(origin, shown)) return;\n", ""),
    ('the notice acknowledgement applies to whatever view is current', G, "(previous.kind === 'outcome' && isOwner(previous, userId, loginId, epoch) && previous.request === shown\n              ? { ...previous, noticeAcknowledged: true } : previous)", "(previous.kind === 'outcome' ? { ...previous, noticeAcknowledged: true } : previous)"),
    ('the queued ask does not check the epoch', G, "!isOwner(currentOwner.current, userId, loginId, epoch)) return;", "false) return;"),
    ('the view is not tagged with the epoch it was asked at', G, "setView({ userId, loginId, epoch, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });\n      } catch", "setView({ userId, loginId, epoch: currentOwner.current.epoch, request: mine, kind: 'outcome', outcome, noticeAcknowledged: false });\n      } catch"),
    ('a late answer of an older request may set the view', G, "if (!cancelled && mine === request.current) setView({ userId, loginId, epoch, request: mine, kind: 'outcome'", "if (!cancelled) setView({ userId, loginId, epoch, request: mine, kind: 'outcome'"),
    ('retry is not tagged with the epoch', G, "setView({ userId, loginId, epoch, request: ++request.current, kind: 'loading' });", "setView({ userId, loginId, epoch: -1, request: ++request.current, kind: 'loading' });"),
    ('a click is honoured for another epoch', G, "!isOwner(view, userId, loginId, epoch) || view.outcome.kind !== 'reenroll_required') return;", "!isOwner(view, userId, loginId, view.epoch) || view.outcome.kind !== 'reenroll_required') return;"),
    ('a click result of another epoch is applied', G, "isOwner(currentOwner.current, clicked.userId, clicked.loginId, clicked.epoch)) {\n            setView({ ...clicked, request: mine, kind: 'outcome'", "true) {\n            setView({ ...clicked, request: mine, kind: 'outcome'"),
]

def run(root):
    try:
        return subprocess.run(['node', '--test', '--test-timeout=60000', 'tests/service-enrollment-lifecycle.test.mjs', 'tests/service-enrollment.test.mjs', 'tests/service-enrollment-gate-j2-v2.test.mjs', 'tests/service-end-g1-g2-integration.test.mjs'], cwd=root, capture_output=True, text=True, timeout=240).returncode
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
