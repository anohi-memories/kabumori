// G1 TASK 49: the Threads native rig's build step (tests/local-stack/build-threads-native-rig.py) still applies to this source, changes
// only a throw-away copy, keeps the gateway on loopback, and the product source keeps every Threads gate OFF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const app = new URL('..', import.meta.url).pathname;
const script = join(app, 'tests/local-stack/build-threads-native-rig.py');
const FILES = ['package.json', 'src/domain/threads-connect.ts', 'src/domain/threads-manual-publish.ts', 'src/domain/threads-disconnect.ts', 'src/lib/supabase.ts',
  'src/features/threads-connect/threads-connect-runtime.ts', 'src/features/threads-connect/threads-connect-card.tsx', 'src/features/threads-publish/threads-publish-card.tsx'];
const SEED = { api: 'http://127.0.0.1:56990', publishable: 'sb_publishable_flow_fake_0123456789', callback: 'https://postona.example/callback' };

async function copy() {
  const dir = await mkdtemp(join(tmpdir(), 'g1t49-rig-'));
  for (const f of FILES) await cp(join(app, f), join(dir, f), { recursive: true });
  await writeFile(join(dir, 'seed.json'), JSON.stringify(SEED));
  return dir;
}
const run = (dir, seed = join(dir, 'seed.json')) => execFileSync('python3', ['-I', script, dir, seed], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('T49 rig build: applies to this source in a copy only; gates ON there, the auth browser goes to the loopback consent page, the cards say local', async () => {
  const dir = await copy();
  try {
    assert.match(run(dir), /rig edits applied/u);
    const read = (f) => readFile(join(dir, f), 'utf8');
    assert.match(await read('src/domain/threads-connect.ts'), /THREADS_CONNECT_UI_ENABLED = true;/u);
    assert.match(await read('src/domain/threads-manual-publish.ts'), /THREADS_MANUAL_PUBLISH_UI_ENABLED = true;/u);
    assert.match(await read('src/domain/threads-disconnect.ts'), /THREADS_DISCONNECT_UI_ENABLED = true;/u);
    const runtime = await read('src/features/threads-connect/threads-connect-runtime.ts');
    assert.match(runtime, /\/rig\/fake-threads\/authorize/u);
    assert.match(runtime, /kabumori-social:\/\/threads-rig-callback/u);
    assert.match(await read('src/features/threads-publish/threads-publish-card.tsx'), /ローカル検証ビルド/u);
    assert.match(await read('src/features/threads-connect/threads-connect-card.tsx'), /ローカル検証ビルド/u);
    const env = await read('.env.local');
    assert.match(env, /^EXPO_PUBLIC_SUPABASE_URL=http:\/\/127\.0\.0\.1:56990$/mu);
    assert.doesNotMatch(env, /password|secret|service_role/iu, 'no credential in the build');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('T49 rig build: refuses a non-loopback gateway and a git checkout; the product source keeps every Threads gate OFF', async () => {
  const dir = await copy();
  try {
    await writeFile(join(dir, 'seed.json'), JSON.stringify({ ...SEED, api: 'https://example.supabase.co' }));
    assert.throws(() => run(dir), /loopback/u);
    await writeFile(join(dir, 'seed.json'), JSON.stringify(SEED));
    await writeFile(join(dir, '.git'), 'gitdir: elsewhere');
    assert.throws(() => run(dir), /throw-away copy/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
  for (const [f, gate] of [['src/domain/threads-connect.ts', 'THREADS_CONNECT_UI_ENABLED'], ['src/domain/threads-manual-publish.ts', 'THREADS_MANUAL_PUBLISH_UI_ENABLED'], ['src/domain/threads-disconnect.ts', 'THREADS_DISCONNECT_UI_ENABLED']]) {
    assert.match(await readFile(join(app, f), 'utf8'), new RegExp(`export const ${gate} = false;`, 'u'));
  }
  assert.doesNotMatch(await readFile(join(app, 'src/features/threads-connect/threads-connect-runtime.ts'), 'utf8'), /rig/iu, 'no rig seam in the product source');
});
