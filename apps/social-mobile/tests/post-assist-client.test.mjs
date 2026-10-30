// G1 TASK 26: the app's copy of G6's post assist reference client (src/data/post-assist-client.ts). The copy is pinned to the
// reference at PR #582 1a567ea8 byte for byte (below its own header), and run here through a stand-in of supabase-js
// functions.invoke: the person's token as Bearer, one Idempotency-Key per request, and every non-contract answer refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as client from '../src/data/post-assist-client.ts';

// sha256 of supabase/tests/postona_post_assist_client_reference.ts at 1a567ea8facd36f20a767c999bd36f59db5d8740, from the line
// "/** The slice of the Supabase client this needs" to the end.
const REFERENCE_BODY_SHA256 = '1606c6ec0791bfd9fe7685d1ddc399daa05ad18ed39e04f2cb90f41d53a63a7f';

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

/** supabase-js FunctionsClient.invoke: 2xx -> { data }, otherwise { error } whose context is the Response. */
const EMPTY = Symbol('empty body');
function fakeFunctions(status, body) {
  const calls = [];
  return {
    calls,
    functions: {
      invoke: async (name, options) => {
        calls.push({ name, options: { body: { ...options.body }, headers: { ...options.headers } } });
        if (status === 'throw') throw new Error('network down');
        if (status === 200) return { data: body, error: null };
        if (status === 'no-context') return { data: null, error: new Error('relay error') };
        if (status === 'fetch-error') return { data: null, error: { name: 'FunctionsFetchError', context: new TypeError('Network request failed') } };
        const text = body === EMPTY ? '' : typeof body === 'string' ? body : JSON.stringify(body);
        return { data: null, error: { name: 'FunctionsHttpError', context: new Response(text, { status }) } };
      },
    },
  };
}
const KEY = 'pa-00000000-0000-4000-8000-000000000001';
const DRAFT = Object.freeze({ brandId: 'u_abc', mode: 'draft', platform: 'x', notes: '新しい店の告知' });
const candidate = (over = {}) => ({ platform: 'x', text: '新しいお店を開きました。', hashtags: ['#開店'], length: 30, limit: 280, editable: true, requiresUserConfirmation: true, ...over });

test('the copy is the G6 reference byte for byte below its header (PR #582 1a567ea8)', async () => {
  const source = await readFile(new URL('../src/data/post-assist-client.ts', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('/** The slice of the Supabase client this needs'));
  assert.equal(createHash('sha256').update(body).digest('hex'), REFERENCE_BODY_SHA256);
  assert.ok(source.startsWith('// POSTONA AI post assist client (G1 TASK 26)'));
});

test('one request: the person\'s token as Bearer, the Idempotency-Key, and exactly the fields of the mode', async () => {
  const fake = fakeFunctions(200, { candidates: [candidate()], notice: '投稿する前に確認・編集してください' });
  const state = await client.requestPostAssist(fake, 'jwt-person', KEY, DRAFT);
  assert.equal(state.kind, 'candidates');
  assert.equal(state.candidates[0].text, '新しいお店を開きました。');
  assert.deepEqual(fake.calls, [{ name: 'postona-post-assist', options: { body: { brand_id: 'u_abc', mode: 'draft', platform: 'x', notes: '新しい店の告知' }, headers: { Authorization: 'Bearer jwt-person', 'Idempotency-Key': KEY } } }]);
  assert.deepEqual(client.buildPostAssistBody({ brandId: 'u_abc', mode: 'refine', platform: 'x', draft: 'd', instruction: 'i' }), { brand_id: 'u_abc', mode: 'refine', platform: 'x', draft: 'd', instruction: 'i' });
  assert.deepEqual(client.buildPostAssistBody({ brandId: 'u_abc', mode: 'hashtags', platform: 'x', draft: 'd' }), { brand_id: 'u_abc', mode: 'hashtags', platform: 'x', draft: 'd' });
});

test('a key is new per press and well-formed; a malformed key sends nothing', async () => {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const a = client.newPostAssistKey(uuid);
  const b = client.newPostAssistKey(uuid);
  assert.notEqual(a, b);
  assert.match(a, /^pa-/u);
  assert.throws(() => client.newPostAssistKey(() => 'has space'), /POST_ASSIST_KEY_INVALID/u);
  const fake = fakeFunctions(200, {});
  assert.deepEqual(await client.requestPostAssist(fake, 'jwt', 'short', DRAFT), { kind: 'invalid_input' });
  assert.equal(fake.calls.length, 0);
});

test('every answer maps to one screen state; anything off-contract is "unavailable", never a candidate', async () => {
  const err = (error, retry = false) => ({ error, retry_same_key: retry });
  const cases = [
    [401, err('POST_ASSIST_AUTH_REQUIRED'), 'relogin'],
    [403, err('POST_ASSIST_NOT_ENTITLED'), 'not_available'],
    [409, err('POST_ASSIST_IN_PROGRESS', true), 'retry_same_key'],
    [503, err('POST_ASSIST_BUSY', true), 'retry_same_key'],
    [503, err('POST_ASSIST_BUSY', false), 'unavailable'],
    [409, err('POST_ASSIST_OPERATION_REUSED'), 'new_key_needed'],
    [502, err('POST_ASSIST_AI_FAILED'), 'new_key_needed'],
    [429, err('POST_ASSIST_QUOTA_EXCEEDED'), 'quota'],
    [400, err('POST_ASSIST_REQUEST_INVALID'), 'invalid_input'],
    [403, err('POST_ASSIST_ORIGIN_REFUSED'), 'unavailable'],
    [500, 'not json', 'unavailable'],
    [200, { candidates: [], notice: 'x' }, 'unavailable'],
    [200, { candidates: [candidate({ editable: false })], notice: 'x' }, 'unavailable'],
    [200, { candidates: [candidate({ platform: 'threads' })], notice: 'x' }, 'unavailable'],
    [200, { candidates: [candidate({ length: 281 })], notice: 'x' }, 'unavailable'],
    [200, { candidates: [candidate()], notice: 'x', extra: 1 }, 'unavailable'],
    ['throw', null, 'unavailable'],
    ['no-context', null, 'unavailable'],
  ];
  for (const [status, body, kind] of cases) {
    const state = await client.requestPostAssist(fakeFunctions(status, body), 'jwt', KEY, DRAFT);
    assert.equal(state.kind, kind, `${status} ${JSON.stringify(body)}`);
  }
});

// G1 TASK 28 (G6-26 F1): Supabase's gateway (verify_jwt, the deploy default) answers an invalid / expired / missing token itself,
// before the endpoint runs, with its own body. Every 401 -- whatever its body -- must ask the person to sign in again, not say
// "unavailable"; and no other answer may turn into "relogin".
test('every 401 is "relogin": the gateway {code,message,msg}, an expired JWT, an empty or non-JSON body, and the endpoint\'s own 401', async () => {
  const cases = [
    ['local runtime gateway (G6-26)', { code: 'UNAUTHORIZED_INVALID_JWT_FORMAT', message: 'Invalid JWT format', msg: 'Invalid JWT format' }],
    ['expired JWT at the gateway', { code: 'UNAUTHORIZED_INVALID_JWT', message: 'JWT expired', msg: 'JWT expired' }],
    ['missing authorization at the gateway', { code: 401, message: 'Missing authorization header' }],
    ['empty body', EMPTY],
    ['JSON null', null],
    ['non-JSON body', '<html>401 Unauthorized</html>'],
    ['the endpoint\'s own 401', { error: 'POST_ASSIST_AUTH_REQUIRED', retry_same_key: false }],
    ['an unknown error code with 401', { error: 'SOMETHING_ELSE', retry_same_key: true }],
  ];
  for (const [label, body] of cases) {
    const fake = fakeFunctions(401, body);
    assert.deepEqual({ ...(await client.requestPostAssist(fake, 'jwt-expired', KEY, DRAFT)) }, { kind: 'relogin' }, label);
    assert.equal(fake.calls.length, 1, `${label}: one request, no retry of its own`);
  }
  assert.deepEqual({ ...client.postAssistStateOf(401, undefined, 'x') }, { kind: 'relogin' });
});

test('no regression around 401: the same gateway body on another status stays off-contract; network errors stay "unavailable"', async () => {
  const gateway = { code: 'UNAUTHORIZED_INVALID_JWT_FORMAT', message: 'Invalid JWT format', msg: 'Invalid JWT format' };
  for (const status of [400, 403, 500, 502, 503]) {
    assert.equal((await client.requestPostAssist(fakeFunctions(status, gateway), 'jwt', KEY, DRAFT)).kind, 'unavailable', `${status}`);
    assert.equal((await client.requestPostAssist(fakeFunctions(status, EMPTY), 'jwt', KEY, DRAFT)).kind, 'unavailable', `${status} empty`);
  }
  assert.equal((await client.requestPostAssist(fakeFunctions('fetch-error'), 'jwt', KEY, DRAFT)).kind, 'unavailable', 'FunctionsFetchError');
  assert.equal((await client.requestPostAssist(fakeFunctions(403, { error: 'POST_ASSIST_NOT_ENTITLED', retry_same_key: false }), 'jwt', KEY, DRAFT)).kind, 'not_available');
  assert.equal((await client.requestPostAssist(fakeFunctions(409, { error: 'POST_ASSIST_IN_PROGRESS', retry_same_key: true }), 'jwt', KEY, DRAFT)).kind, 'retry_same_key');
  assert.equal((await client.requestPostAssist(fakeFunctions(429, { error: 'POST_ASSIST_QUOTA_EXCEEDED', retry_same_key: false }), 'jwt', KEY, DRAFT)).kind, 'quota');
});
