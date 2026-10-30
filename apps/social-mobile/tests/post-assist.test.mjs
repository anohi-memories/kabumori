// G1 TASK 26: the composer's AI post assist decisions (src/features/schedule/post-assist.ts): who may ask (the person's own
// session, their own workspace only -- everything else fails closed and sends nothing), one Idempotency-Key per press, the
// exact body per mode, the input limits, what each answer says, and how adopted hashtags are added.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as assist from '../src/features/schedule/post-assist.ts';

const calls = [];
const client = { functions: { invoke: async (name, options) => { calls.push({ name, options }); return { data: { candidates: [{ platform: 'x', text: '案', hashtags: [], length: 2, limit: 280, editable: true, requiresUserConfirmation: true }], notice: '確認してください' }, error: null }; } } };
const env = (over = {}) => ({ client, accessToken: 'jwt-1', userId: 'user-1', brandId: 'u_1', workspaceId: 'u_1', platform: 'x', preview: false, loginRefused: false, ...over });
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const fields = (over = {}) => ({ notes: '新メニューの告知', instruction: 'もっと短く', ...over });

test('fail-closed: sample data, no client, signed out, unknown workspace or another workspace blocks the request', () => {
  assert.equal(assist.assistBlock(env()), null);
  assert.equal(assist.assistBlock(env({ preview: true })), 'preview');
  assert.equal(assist.assistBlock(env({ client: null })), 'preview');
  assert.equal(assist.assistBlock(env({ accessToken: null })), 'signed_out');
  assert.equal(assist.assistBlock(env({ userId: null })), 'signed_out');
  assert.equal(assist.assistBlock(env({ brandId: null })), 'no_workspace');
  assert.equal(assist.assistBlock(env({ workspaceId: null })), 'no_workspace');
  assert.equal(assist.assistBlock(env({ brandId: 'shared-brand' })), 'other_workspace');
  for (const block of ['preview', 'signed_out', 'relogin', 'no_workspace', 'other_workspace']) assert.ok(assist.ASSIST_BLOCK_TEXT[block].length > 10);
  assert.equal(assist.assistScope(env()), 'user-1\nu_1');
  assert.equal(assist.assistScope(env({ brandId: 'shared-brand' })), null);
  assert.notEqual(assist.assistScope(env({ userId: 'user-2' })), assist.assistScope(env()));
});

test('input: each mode needs its own text, within the endpoint limits (code points)', () => {
  assert.equal(assist.assistInputIssue('draft', '', fields()), null);
  assert.match(assist.assistInputIssue('draft', '本文', fields({ notes: '  ' })), /メモを入力/u);
  assert.equal(assist.assistInputIssue('draft', '', fields({ notes: '😀'.repeat(2000) })), null);
  assert.match(assist.assistInputIssue('draft', '', fields({ notes: 'あ'.repeat(2001) })), /2000文字以内/u);
  assert.match(assist.assistInputIssue('refine', ' ', fields()), /先に本文/u);
  assert.match(assist.assistInputIssue('refine', '本文', fields({ instruction: '' })), /指示を入力/u);
  assert.match(assist.assistInputIssue('refine', '本文', fields({ instruction: 'あ'.repeat(301) })), /300文字以内/u);
  assert.equal(assist.assistInputIssue('refine', 'あ'.repeat(1000), fields({ instruction: 'あ'.repeat(300) })), null);
  assert.match(assist.assistInputIssue('hashtags', 'あ'.repeat(1001), fields()), /1000文字以内/u);
  assert.equal(assist.assistInputIssue('hashtags', '本文', fields({ instruction: '' })), null, 'hashtags needs no instruction');
});

test('a request per press: a new key each time, the exact body of the mode, and nothing when blocked or not ready', () => {
  const a = assist.newAssistRequest(env(), uuid, 'r0', 'draft', '無視される本文', fields());
  const b = assist.newAssistRequest(env(), uuid, 'r0', 'draft', '無視される本文', fields());
  assert.notEqual(a.key, b.key);
  assert.match(a.key, /^pa-/u);
  assert.deepEqual({ ...a.input }, { brandId: 'u_1', platform: 'x', mode: 'draft', notes: '新メニューの告知' });
  assert.deepEqual({ ...assist.newAssistRequest(env(), uuid, 'r0', 'refine', '本文', fields()).input }, { brandId: 'u_1', platform: 'x', mode: 'refine', draft: '本文', instruction: 'もっと短く' });
  assert.deepEqual({ ...assist.newAssistRequest(env(), uuid, 'r0', 'hashtags', '本文', fields()).input }, { brandId: 'u_1', platform: 'x', mode: 'hashtags', draft: '本文' });
  assert.equal(a.scope, 'user-1\nu_1');
  assert.equal(a.rowId, 'r0');
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.input));
  assert.equal(assist.newAssistRequest(env({ brandId: 'shared-brand' }), uuid, 'r0', 'draft', '', fields()), null);
  assert.equal(assist.newAssistRequest(env(), uuid, 'r0', 'refine', '', fields()), null);
});

test('sending: the person\'s own token, the request\'s key; nothing at all once the session or workspace changed', async () => {
  calls.length = 0;
  const request = assist.newAssistRequest(env(), uuid, 'r0', 'hashtags', '本文', fields());
  const state = await assist.sendAssist(env(), request);
  assert.equal(state.kind, 'candidates');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer jwt-1');
  assert.equal(calls[0].options.headers['Idempotency-Key'], request.key);
  assert.equal(assist.sendAssist(env({ userId: 'user-2' }), request), null);
  assert.equal(assist.sendAssist(env({ workspaceId: 'u_2', brandId: 'u_2' }), request), null);
  assert.equal(assist.sendAssist(env({ accessToken: null }), request), null);
  assert.equal(calls.length, 1);
});

test('each answer has its words and its one way on: same key only for retry_same_key', () => {
  assert.equal(assist.assistOutcomeView({ kind: 'candidates', candidates: [], notice: '' }), null);
  const retry = (kind) => assist.assistOutcomeView(kind === 'new_key_needed' ? { kind, code: 'X' } : { kind }).retry;
  assert.equal(retry('retry_same_key'), 'same_key');
  for (const kind of ['not_available', 'new_key_needed', 'unavailable']) assert.equal(retry(kind), 'new_key', kind);
  for (const kind of ['relogin', 'quota', 'invalid_input']) assert.equal(retry(kind), null, kind);
  assert.match(assist.assistOutcomeView({ kind: 'relogin' }).text, /ログインし直して/u);
  assert.match(assist.assistOutcomeView({ kind: 'unavailable' }).text, /手で書いて続けられます/u);
});

test('hashtags are appended on their own line, only the ones the text does not have yet', () => {
  assert.equal(assist.withHashtags('新メニューです', ['#カフェ', '#新メニュー']), '新メニューです\n\n#カフェ #新メニュー');
  assert.equal(assist.withHashtags('新メニューです #カフェ\n', ['#カフェ', '#新メニュー']), '新メニューです #カフェ\n\n#新メニュー');
  assert.equal(assist.withHashtags('本文 #Cafe', ['#cafe']), '本文 #Cafe', 'case-insensitive, nothing to add');
  assert.equal(assist.withHashtags('', ['#a', '#a']), '#a');
  assert.equal(assist.ASSIST_MODES.map((m) => m.label).join('/'), 'AIで下書き/書き直し/ハッシュタグ案');
});

test('TASK 28: a token answered 401 blocks as "relogin" (scope null, nothing sent); sample data and signed-out keep their own reason', async () => {
  calls.length = 0;
  assert.equal(assist.assistBlock(env({ loginRefused: true })), 'relogin');
  assert.equal(assist.assistScope(env({ loginRefused: true })), null);
  assert.equal(assist.newAssistRequest(env({ loginRefused: true }), uuid, 'r0', 'hashtags', '本文', fields()), null);
  const request = assist.newAssistRequest(env(), uuid, 'r0', 'hashtags', '本文', fields());
  assert.equal(assist.sendAssist(env({ loginRefused: true }), request), null);
  assert.equal(calls.length, 0);
  assert.equal(assist.assistBlock(env({ loginRefused: true, preview: true })), 'preview');
  assert.equal(assist.assistBlock(env({ loginRefused: true, accessToken: null })), 'signed_out');
  assert.match(assist.ASSIST_BLOCK_TEXT.relogin, /ログインし直すまで/u);
  assert.match(assist.ASSIST_BLOCK_TEXT.relogin, /手で書いて続けられます/u);
  assert.match(assist.ASSIST_BLOCK_TEXT.no_workspace, /個人ワークスペース/u);
});
