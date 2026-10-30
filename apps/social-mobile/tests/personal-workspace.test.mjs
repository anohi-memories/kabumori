// G1 TASK 28 (G5-50 contract gap 1): the snapshot's personal workspace. The REAL supabase-repository.ts (transpiled) reads a scripted
// stand-in of the Supabase query builder. With several memberships the app must not take whichever brand comes first: the personal
// workspace is the one brand the person owns whose code_profile_key is social_mobile_user_v1 -- exactly one, or none (null, so the AI
// post assist sends nothing). G5 keeps checking everything else on the server; nothing here grants anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as postStatus from '../src/domain/post-status.ts';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const saved = new Map();
let trapped = 0;
test.before(() => {
  for (const name of NETWORK) {
    saved.set(name, globalThis[name]);
    globalThis[name] = function forbidden() { trapped += 1; throw new Error(`network entry point ${name} must not be used`); };
  }
});
test.after(() => {
  for (const name of NETWORK) {
    if (saved.get(name) === undefined) delete globalThis[name];
    else globalThis[name] = saved.get(name);
  }
  assert.equal(trapped, 0);
});

const source = await readFile(new URL('../src/data/supabase-repository.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const loaded = { exports: {} };
vm.runInNewContext(js, { module: loaded, exports: loaded.exports, Promise, require: (name) => { assert.ok(name === '@/domain/post-status', `unexpected import ${name}`); return postStatus; } }, { filename: 'supabase-repository.ts' });
const { SupabaseSocialRepository, PERSONAL_WORKSPACE_KIND } = loaded.exports;

const USER = 'user-1';
const OWN = 'u_0123456789abcdef01234567';
/**
 * A stand-in of the query builder: each table answers from `tables`; a select of `kindColumn` on brands can be refused (as a column
 * that is not granted would be). Every query is recorded.
 */
function fakeClient({ memberships, brands, kindError = null, kindThrows = false }) {
  const queries = [];
  const builder = (table) => {
    const q = { table, columns: null, filters: [] };
    queries.push(q);
    const chain = {
      select(columns) { q.columns = columns; return chain; },
      eq(column, value) { q.filters.push(['eq', column, value]); return chain; },
      in(column, values) { q.filters.push(['in', column, [...values]]); return chain; },
      order() { return chain; },
      limit() { return chain; },
      then(resolve, reject) {
        try {
          if (table === 'brand_memberships') return Promise.resolve({ data: memberships, error: null }).then(resolve, reject);
          if (table === 'brands' && q.columns.includes('code_profile_key')) {
            if (kindThrows) throw new Error('boom');
            if (kindError) return Promise.resolve({ data: null, error: kindError }).then(resolve, reject);
            const ids = q.filters.find((f) => f[0] === 'in')[2];
            return Promise.resolve({ data: brands.filter((b) => ids.includes(b.id)).map((b) => ({ id: b.id, code_profile_key: b.kind })), error: null }).then(resolve, reject);
          }
          if (table === 'brands') {
            const ids = q.filters.find((f) => f[0] === 'in')[2];
            return Promise.resolve({ data: brands.filter((b) => ids.includes(b.id)).map((b) => ({ id: b.id, display_name: b.name, is_active: true, publish_mode: 'disabled' })), error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        } catch (error) {
          return Promise.reject(error).then(resolve, reject);
        }
      },
    };
    return chain;
  };
  return { queries, auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) }, from: builder };
}
const read = async (world) => {
  const client = fakeClient(world);
  const result = await new SupabaseSocialRepository(client).readSnapshot();
  return { result, client };
};
const shared = { id: 'shared-brand', name: '共有の運用', kind: 'kabumori_v1' };
const own = { id: OWN, name: 'マイワークスペース', kind: 'social_mobile_user_v1' };

test('one personal workspace among several memberships: it is pinned and shown, even when a shared brand comes first', async () => {
  assert.equal(PERSONAL_WORKSPACE_KIND, 'social_mobile_user_v1');
  const { result, client } = await read({ memberships: [{ brand_id: 'shared-brand', role: 'editor' }, { brand_id: OWN, role: 'owner' }], brands: [shared, own] });
  assert.equal(result.state, 'ready');
  assert.equal(result.data.personalWorkspaceId, OWN);
  assert.equal(result.data.workspace.id, OWN, 'the personal workspace is the one shown, not the first brand read');
  // The kind is read only for the brands the person owns, and only through the RLS-protected membership ids.
  const kindQuery = client.queries.find((q) => q.table === 'brands' && q.columns.includes('code_profile_key'));
  assert.deepEqual(kindQuery.filters, [['in', 'id', [OWN]]]);
});

test('fail-closed: no personal workspace is guessed', async () => {
  const cases = [
    ['only a shared brand', [{ brand_id: 'shared-brand', role: 'owner' }], [shared]],
    ['personal kind but not the owner', [{ brand_id: OWN, role: 'editor' }], [own]],
    ['two personal-kind brands owned', [{ brand_id: OWN, role: 'owner' }, { brand_id: 'u_other', role: 'owner' }], [own, { id: 'u_other', name: 'もう一つ', kind: 'social_mobile_user_v1' }]],
    ['personal kind with no role', [{ brand_id: OWN }], [own]],
    ['a membership the brands read does not return', [{ brand_id: OWN, role: 'owner' }], []],
  ];
  for (const [label, memberships, brands] of cases) {
    const { result } = await read({ memberships, brands });
    assert.equal(result.state, 'ready', label);
    assert.equal(result.data.personalWorkspaceId, null, label);
  }
});

test('the kind read failing (not granted / error / throw) leaves the snapshot ready with no personal workspace; nothing else changes', async () => {
  const memberships = [{ brand_id: 'shared-brand', role: 'editor' }, { brand_id: OWN, role: 'owner' }];
  for (const failure of [{ kindError: { code: '42501', message: 'permission denied for column code_profile_key' } }, { kindError: { code: '42703' } }, { kindThrows: true }]) {
    const { result } = await read({ memberships, brands: [shared, own], ...failure });
    assert.equal(result.state, 'ready', JSON.stringify(failure));
    assert.equal(result.data.personalWorkspaceId, null);
    assert.equal(result.data.workspace.id, 'shared-brand', 'the shown workspace falls back to the first brand, as before');
  }
});

test('one membership in the personal workspace (the MVP case): pinned; no membership: blocked as before', async () => {
  const { result } = await read({ memberships: [{ brand_id: OWN, role: 'owner' }], brands: [own] });
  assert.equal(result.data.personalWorkspaceId, OWN);
  assert.equal(result.data.workspace.id, OWN);
  const none = await read({ memberships: [], brands: [] });
  assert.equal(none.result.state, 'blocked');
  assert.equal(none.result.data.personalWorkspaceId, null);
});
