// G2 QA (Issue #317, task postona-g2-native-identity-device-evidence-gate-offline-20261022) -- QA only, no product code.
// Release NO_GO gates that only native evidence can lift -- app identifiers (G2-ID1 / ID5), the iOS 27 standard build
// (UIScene), Android App Links on a device -- and the ways that evidence gets mis-joined: a fixture or relabelled build taken
// for the standard build, a Simulator taken for a device, an offline / custom-scheme link test taken for App Links, an
// identifier read from a config that a local prebuild just wrote, runs whose identifiers disagree (order / login), evidence
// from another head, a partial PASS. The general evidence-drift rules (review head, merge, verdict words) are G2 #444 and
// are not repeated. Inputs: the TRACKED app.json of this checkout and docs/postona/qa/g2-native-device-evidence/
// evidence.json (G2's earlier records, copied). Offline: no network, no device, no Simulator, no EAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const APP_JSON = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
const EVIDENCE = JSON.parse(await readFile(new URL('../../../docs/postona/qa/g2-native-device-evidence/evidence.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));
const CURRENT_HEAD = EVIDENCE.appJsonAtMain.head;

/** The identifiers the TRACKED config pins (never what a prebuild wrote into a working copy). */
export function pinnedIdentifiers(appJson) {
  const ios = appJson?.expo?.ios?.bundleIdentifier ?? null;
  const android = appJson?.expo?.android?.package ?? null;
  return { ios: typeof ios === 'string' && ios ? ios : null, android: typeof android === 'string' && android ? android : null };
}

const IDENTITY_MATRIX = [['both', 'cached'], ['both', 'none'], ['ios-first', 'cached'], ['ios-first', 'none'], ['android-first', 'cached'], ['android-first', 'none']];

/**
 * Fail-closed. `tracked` = the tracked app.json; `records` = evidence; `head` = the head the release would ship.
 * Returns { gate, go, reasons } per native gate.
 */
export function decideNative(tracked, records, head) {
  const out = [];
  const atHead = (r) => r.appHead === head;

  // IDENTITY: pinned in the tracked config; every prebuild combination (order x login) at this head yields exactly the
  // pinned values and leaves the tracked files clean.
  {
    const reasons = new Set();
    const pin = pinnedIdentifiers(tracked);
    if (!pin.ios) reasons.add('IOS_IDENTIFIER_NOT_PINNED');
    if (!pin.android) reasons.add('ANDROID_PACKAGE_NOT_PINNED');
    const runs = records.filter((r) => r.gate === 'IDENTITY');
    if (runs.some((r) => !atHead(r))) reasons.add('STALE_RUN');
    const here = runs.filter(atHead);
    for (const [order, login] of IDENTITY_MATRIX) if (!here.some((r) => r.order === order && r.login === login)) reasons.add(`RUN_MISSING:${order}/${login}`);
    if (new Set(here.map((r) => r.ios)).size > 1 || new Set(here.map((r) => r.android)).size > 1) reasons.add('RUNS_DISAGREE');
    if (here.some((r) => (pin.ios && r.ios !== pin.ios) || (pin.android && r.android !== pin.android))) reasons.add('RUN_DIFFERS_FROM_PIN');
    if (here.some((r) => r.trackedConfigCleanAfter !== true)) reasons.add('PREBUILD_WRITES_TRACKED_CONFIG');
    out.push({ gate: 'IDENTITY', go: reasons.size === 0, reasons: [...reasons].sort() });
  }

  // IOS27: the STANDARD build (no fixture, no relabel) at this head launches on an iOS 27 Simulator AND on a device.
  {
    const reasons = new Set();
    const ios = records.filter((r) => r.gate === 'IOS27');
    const standard = ios.filter((r) => r.build === 'standard');
    if (ios.some((r) => r.build === 'standard' && r.result !== 'LAUNCH_PASS' && atHead(r))) reasons.add('STANDARD_BUILD_FAILS');
    const ok = (env) => standard.some((r) => r.env === env && r.result === 'LAUNCH_PASS' && atHead(r) && r.os === 'iOS 27');
    if (!ok('simulator')) reasons.add('STANDARD_SIMULATOR_LAUNCH_MISSING');
    if (!ok('device')) reasons.add('STANDARD_DEVICE_LAUNCH_MISSING');
    if (standard.some((r) => r.result === 'LAUNCH_PASS' && !atHead(r))) reasons.add('STALE_STANDARD_PASS');
    out.push({ gate: 'IOS27', go: reasons.size === 0, reasons: [...reasons].sort() });
  }

  // ANDROID_APP_LINKS: the package is pinned, and HTTPS App Links were verified on a device at this head.
  {
    const reasons = new Set();
    if (!pinnedIdentifiers(tracked).android) reasons.add('ANDROID_PACKAGE_NOT_PINNED');
    const links = records.filter((r) => r.gate === 'ANDROID_APP_LINKS');
    const verified = links.some((r) => r.env === 'device' && r.linkKind === 'https-app-link' && r.result === 'VERIFIED' && atHead(r));
    if (!verified) reasons.add('DEVICE_APP_LINKS_MISSING');
    if (!(tracked?.expo?.android?.intentFilters ?? []).some((f) => f?.autoVerify === true && (f.data ?? []).some((d) => d?.scheme === 'https'))) reasons.add('NO_VERIFIED_HTTPS_INTENT_FILTER');
    out.push({ gate: 'ANDROID_APP_LINKS', go: reasons.size === 0, reasons: [...reasons].sort() });
  }
  return out;
}
const byGate = (decisions) => Object.fromEntries(decisions.map((d) => [d.gate, d]));
/** What a hand-kept list tends to do: "there is a PASS for it". */
const naive = (records, gate) => records.some((r) => r.gate === gate && /PASS|VERIFIED/u.test(r.result ?? '')) || (gate === 'IDENTITY' && records.some((r) => r.gate === 'IDENTITY'));

// ---- the current state ---------------------------------------------------------------------------------------------
test('G2-NV1: on the tracked app.json and G2\'s recorded evidence, all three native gates are NO_GO for their real reasons', () => {
  const d = byGate(decideNative(APP_JSON, EVIDENCE.records, CURRENT_HEAD));
  assert.equal(d.IDENTITY.go, false);
  for (const r of ['IOS_IDENTIFIER_NOT_PINNED', 'ANDROID_PACKAGE_NOT_PINNED', 'RUNS_DISAGREE', 'PREBUILD_WRITES_TRACKED_CONFIG']) assert.ok(d.IDENTITY.reasons.includes(r), r);
  assert.equal(d.IOS27.go, false);
  assert.deepEqual(d.IOS27.reasons, ['STANDARD_BUILD_FAILS', 'STANDARD_DEVICE_LAUNCH_MISSING', 'STANDARD_SIMULATOR_LAUNCH_MISSING']);
  assert.equal(d.ANDROID_APP_LINKS.go, false);
  assert.deepEqual(d.ANDROID_APP_LINKS.reasons, ['ANDROID_PACKAGE_NOT_PINNED', 'DEVICE_APP_LINKS_MISSING', 'NO_VERIFIED_HTTPS_INTENT_FILTER']);
});

test('G2-NV2 (inputs): the tracked app.json pins neither identifier and has no android section; the evidence was recorded on this app.json head; the fixture / relabel PASSes exist and are not standard builds', () => {
  assert.deepEqual(pinnedIdentifiers(APP_JSON), { ios: null, android: null });
  assert.equal(APP_JSON.expo.android, undefined);
  assert.equal(APP_JSON.expo.scheme, 'kabumori-social');
  const passes = EVIDENCE.records.filter((r) => r.gate === 'IOS27' && r.result === 'LAUNCH_PASS');
  assert.deepEqual(passes.map((r) => r.build).sort(), ['patched-fixture', 'patched-fixture', 'sdk26-relabel']);
  assert.deepEqual([...new Set(EVIDENCE.records.filter((r) => r.gate === 'IDENTITY').map((r) => r.ios))].length, 3, 'three iOS identifiers from one commit (G2-ID1)');
});

// ---- mis-joined evidence: a world where the gates are really met, then one thing wrong ------------------------------
const PIN = { ios: 'com.example.g2pinned', android: 'com.example.g2pinned' };
function metWorld() {
  const tracked = clone(APP_JSON);
  tracked.expo.ios = { ...tracked.expo.ios, bundleIdentifier: PIN.ios };
  tracked.expo.android = { package: PIN.android, intentFilters: [{ action: 'VIEW', autoVerify: true, data: [{ scheme: 'https', host: 'example.test', pathPrefix: '/auth-callback' }], category: ['BROWSABLE', 'DEFAULT'] }] };
  const head = CURRENT_HEAD;
  const records = [
    ...IDENTITY_MATRIX.map(([order, login]) => ({ gate: 'IDENTITY', appHead: head, env: 'prebuild', build: 'generated', order, login, ios: PIN.ios, android: PIN.android, trackedConfigCleanAfter: true })),
    { gate: 'IOS27', appHead: head, env: 'simulator', os: 'iOS 27', build: 'standard', result: 'LAUNCH_PASS' },
    { gate: 'IOS27', appHead: head, env: 'device', os: 'iOS 27', build: 'standard', result: 'LAUNCH_PASS' },
    { gate: 'ANDROID_APP_LINKS', appHead: head, env: 'device', linkKind: 'https-app-link', result: 'VERIFIED' },
  ];
  return { tracked, records, head };
}

test('G2-NV3 (positive control): when everything is really met, all three gates lift -- the decision is not a constant NO_GO', () => {
  const w = metWorld();
  assert.deepEqual(decideNative(w.tracked, w.records, w.head).map((d) => [d.gate, d.go]), [['IDENTITY', true], ['IOS27', true], ['ANDROID_APP_LINKS', true]]);
});

const MISJOINS = {
  'M1 identifiers disagree between prebuild runs (generation order)': ['IDENTITY', (w) => { w.records.find((r) => r.order === 'ios-first' && r.login === 'cached').ios = 'com.anohi-memories.kabumori-social-mobile'; }, ['RUNS_DISAGREE', 'RUN_DIFFERS_FROM_PIN']],
  'M2 identifiers disagree with the login state (anonymous)': ['IDENTITY', (w) => { const r = w.records.find((x) => x.login === 'none' && x.order === 'both'); r.ios = 'com.anonymous.kabumorisocialmobile'; r.android = 'com.anonymous.kabumorisocialmobile'; }, ['RUNS_DISAGREE']],
  'M3 the identifier is read from a working copy a prebuild just wrote (G2-ID5), not from the tracked config': ['IDENTITY', (w) => { delete w.tracked.expo.ios.bundleIdentifier; }, ['IOS_IDENTIFIER_NOT_PINNED']],
  'M4 a prebuild still writes the tracked files': ['IDENTITY', (w) => { w.records.find((r) => r.gate === 'IDENTITY').trackedConfigCleanAfter = false; }, ['PREBUILD_WRITES_TRACKED_CONFIG']],
  'M5 only some order / login combinations were run (partial PASS)': ['IDENTITY', (w) => { w.records = w.records.filter((r) => !(r.gate === 'IDENTITY' && r.order === 'android-first')); }, ['RUN_MISSING:android-first/cached', 'RUN_MISSING:android-first/none']],
  'M6 identity runs from an older head': ['IDENTITY', (w) => { w.records.find((r) => r.gate === 'IDENTITY').appHead = 'f'.repeat(40); }, ['STALE_RUN', 'RUN_MISSING:both/cached']],
  'M7 a patched fixture launch taken for the standard build': ['IOS27', (w) => { w.records.find((r) => r.gate === 'IOS27' && r.env === 'simulator').build = 'patched-fixture'; }, ['STANDARD_SIMULATOR_LAUNCH_MISSING']],
  'M8 an SDK-26-relabelled launch taken for the standard build': ['IOS27', (w) => { w.records.find((r) => r.gate === 'IOS27' && r.env === 'device').build = 'sdk26-relabel'; }, ['STANDARD_DEVICE_LAUNCH_MISSING']],
  'M9 a Simulator launch taken for a device launch': ['IOS27', (w) => { w.records.find((r) => r.gate === 'IOS27' && r.env === 'device').env = 'simulator'; }, ['STANDARD_DEVICE_LAUNCH_MISSING']],
  'M10 a standard launch on another OS (not iOS 27)': ['IOS27', (w) => { w.records.find((r) => r.gate === 'IOS27' && r.env === 'simulator').os = 'iOS 26'; }, ['STANDARD_SIMULATOR_LAUNCH_MISSING']],
  'M11 a standard PASS from an older head while the current standard build crashes': ['IOS27', (w) => { const s = w.records.find((r) => r.gate === 'IOS27' && r.env === 'simulator'); s.appHead = 'e'.repeat(40); w.records.push({ gate: 'IOS27', appHead: w.head, env: 'simulator', os: 'iOS 27', build: 'standard', result: 'CRASH_AT_LAUNCH' }); }, ['STANDARD_BUILD_FAILS', 'STALE_STANDARD_PASS', 'STANDARD_SIMULATOR_LAUNCH_MISSING']],
  'M12 an offline / custom-scheme link test taken for App Links on a device': ['ANDROID_APP_LINKS', (w) => { Object.assign(w.records.find((r) => r.gate === 'ANDROID_APP_LINKS'), { env: 'source', linkKind: 'custom-scheme', result: 'PASS_OFFLINE' }); }, ['DEVICE_APP_LINKS_MISSING']],
  'M13 App Links "verified" on an emulator': ['ANDROID_APP_LINKS', (w) => { w.records.find((r) => r.gate === 'ANDROID_APP_LINKS').env = 'simulator'; }, ['DEVICE_APP_LINKS_MISSING']],
  'M14 the https intent filter without autoVerify': ['ANDROID_APP_LINKS', (w) => { w.tracked.expo.android.intentFilters[0].autoVerify = false; }, ['NO_VERIFIED_HTTPS_INTENT_FILTER']],
  'M15 App Links verified but the package not pinned': ['ANDROID_APP_LINKS', (w) => { delete w.tracked.expo.android.package; }, ['ANDROID_PACKAGE_NOT_PINNED']],
};

for (const [name, [gate, apply, expected]] of Object.entries(MISJOINS)) {
  test(`G2-NV4 ${name}: ${gate} stays NO_GO with that reason (the naive "there is a PASS" rule would lift it)`, () => {
    const w = metWorld();
    apply(w);
    const d = byGate(decideNative(w.tracked, w.records, w.head))[gate];
    assert.equal(d.go, false);
    for (const r of expected) assert.ok(d.reasons.includes(r), `${r} in ${d.reasons.join(',')}`);
    assert.equal(naive(w.records, gate), true, 'naive lifts it');
  });
}

// ---- negative controls on the rules ----------------------------------------------------------------------------------
test('negative controls: each rule, weakened, lets its mis-join through -- build kind (M7/M8), environment (M9/M12/M13), head (M6/M11), agreement (M1/M2)', () => {
  const lifts = (variant) => Object.entries(MISJOINS).filter(([, [gate, apply]]) => { const w = metWorld(); apply(w); return byGate(variant(w))[gate].go; }).map(([n]) => n.split(' ')[0]);
  // any build kind counts as "standard"
  assert.deepEqual(lifts((w) => decideNative(w.tracked, w.records.map((r) => (r.gate === 'IOS27' ? { ...r, build: 'standard' } : r)), w.head)), ['M7', 'M8']);
  // any environment counts for any other: besides M9 / M12 / M13, a good record in the OTHER environment then also stands in
  // for the one M7 / M8 / M10 broke
  assert.deepEqual(lifts((w) => decideNative(w.tracked, w.records.flatMap((r) => (r.gate === 'IOS27' ? [{ ...r, env: 'simulator' }, { ...r, env: 'device' }] : r.gate === 'ANDROID_APP_LINKS' ? [{ ...r, env: 'device', linkKind: 'https-app-link', result: 'VERIFIED' }] : [r])), w.head)), ['M7', 'M8', 'M9', 'M10', 'M12', 'M13']);
  // no head check
  assert.deepEqual(lifts((w) => decideNative(w.tracked, w.records.filter((r) => !(r.gate === 'IOS27' && r.result === 'CRASH_AT_LAUNCH')).map((r) => ({ ...r, appHead: w.head })), w.head)), ['M6', 'M11']);
  // no agreement check: pin = whatever the first run says, runs may differ
  assert.deepEqual(lifts((w) => decideNative(w.tracked, w.records.map((r) => (r.gate === 'IDENTITY' ? { ...r, ios: PIN.ios, android: PIN.android } : r)), w.head)), ['M1', 'M2']);
});

test('G2-NV5 (offline): the file imports only node:test / node:assert / node:fs and reads only local files', async () => {
  const source = await readFile(new URL(import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]), ['node:test', 'node:assert/strict', 'node:fs/promises']);
});
