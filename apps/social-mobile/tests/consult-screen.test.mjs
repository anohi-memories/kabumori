// The real consult.tsx (transpiled) driven end to end with stubbed React/RN, a scripted
// AI answer and an in-memory settings store. Proves on the actual screen code that an
// answer never saves, that only 「これで覚えて」 does, and that a save is delta-only and
// never clobbers newer settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import * as contentSettings from '../src/domain/content-settings.ts';
import * as conversation from '../src/domain/content-settings-conversation.ts';
import * as session from '../src/domain/consult-session.ts';

const { SOCIAL_MOBILE_CONTENT_DEFAULTS, validateSocialMobileContentSettings } = contentSettings;
const { validateConversationalAssistantResult } = conversation;

const walk = (node, visit) => {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit));
  if (node === null || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const flat = (children) => [children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill', 'SectionTitle'].includes(n.type)) out.push(flat(n.props.children)); }); return out; };
const buttons = (tree) => { const out = []; walk(tree, (n) => { if (n.type === 'ActionButton') out.push(n.props); }); return out; };
const button = (tree, label) => buttons(tree).find((b) => b.label === label);
const input = (tree) => { let found = null; walk(tree, (n) => { if (n.type === 'TextInput') found = n.props; }); return found; };
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

const result = (over = {}) => validateConversationalAssistantResult({
  kind: 'chat', assistantReply: 'いいですね。', proposedSettingsDelta: {}, proposedPersonaDelta: {}, followUpQuestions: [], provenance: 'conversation',
  confidence: 'medium', uncertainty: [], requiresConfirmation: true, historyLearningIntent: { explicitConsent: false, requestedRange: 'recent', derivedProfile: null }, publishPermissionChanged: false, ...over,
});

async function consultHarness({ status = 'ready', script, stored } = {}) {
  const slots = []; let cursor = 0; let first = true; const effects = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useReducer: (reducer, arg, init) => { const i = slot(() => (init ? init(arg) : arg)); return [slots[i], (event) => { slots[i] = reducer(slots[i], event); }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useMemo: (factory) => slots[slot(factory)],
    useEffect: (effect) => { if (first) effects.push(effect); else effect(); },
  };
  // In-memory stand-in for the settings table: versioned rows, every write recorded.
  const store = { row: stored === undefined ? { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS }, persona: null, version: 1 } : stored, writes: [], reads: 0, afterRead: null, afterSave: null, unavailableFor: new Set() };
  class Repository {
    async read(brandId) {
      store.reads += 1;
      // Lets a test change the world (e.g. the workspace) while a read is in flight.
      if (store.afterRead) { const hook = store.afterRead; store.afterRead = null; hook(); }
      if (store.unavailableFor.has(brandId)) return { state: 'unavailable', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, reason: '設定を取得できません。' };
      if (!store.row) return { state: 'ready', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, updatedAt: null };
      return { state: 'ready', data: store.row.settings, persona: store.row.persona, updatedAt: `v${store.row.version}` };
    }
    async saveConfirmedIfUnchanged(brandId, settings, persona, expectedUpdatedAt) {
      const current = store.row ? `v${store.row.version}` : null;
      store.writes.push({ brandId, settings, persona, expectedUpdatedAt, applied: current === expectedUpdatedAt });
      if (current !== expectedUpdatedAt) return { ok: false, stale: true, reason: 'stale' };
      assert.equal(validateSocialMobileContentSettings(settings).ok, true);
      store.row = { settings, persona: persona ?? store.row?.persona ?? null, version: (store.row?.version ?? 0) + 1 };
      // The write has reached the store; a hook here models the workspace changing while the answer is in flight.
      if (store.afterSave) { const hook = store.afterSave; store.afterSave = null; hook(); }
      return { ok: true };
    }
    async upsert() { throw new Error('upsert must not be used by the consult screen'); }
    async saveConfirmedProposal() { throw new Error('saveConfirmedProposal must not be used by the consult screen'); }
  }
  const ai = { calls: [] };
  const stubs = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }) },
    'react-native': { ActivityIndicator: 'ActivityIndicator', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    '@/constants/theme': { colors: { primary: 'p', primarySoft: 'ps', surface: 's', border: 'b', ink: 'i' } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: {} } },
    '@/data/mock-repository': { mockRepository: { getConsultation: () => ({ messages: [{ id: 'm', role: 'assistant', text: '見本のあいさつ' }] }) } },
    '@/data/consult-client': { requestConsult: async (_client, token, request) => { ai.calls.push({ token, request }); return script(request.message, ai.calls.length); } },
    '@/data/content-settings-repository': { SupabaseContentSettingsRepository: Repository },
    '@/lib/supabase': { supabase: status === 'mock_preview' ? null : {} },
    '@/domain/content-settings': contentSettings,
    '@/domain/content-settings-conversation': conversation,
    '@/domain/consult-session': session,
    '@/providers/auth-provider': { useAuth: () => ({ session: status === 'mock_preview' ? null : { access_token: 'jwt-1' } }) },
    '@/providers/data-provider': { useDataStatus: () => ({ status: live.status, snapshot: { workspace: { id: live.workspaceId } } }) },
  };
  // The data status can change while the screen is open (e.g. the workspace becomes unreachable).
  const live = { status, workspaceId: 'u_1' };
  const source = await readFile(new URL('../src/app/(tabs)/consult.tsx', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, Promise, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } }, { filename: 'consult.tsx' });
  const render = () => { cursor = 0; return module.exports.default({}); };
  render(); first = false; effects.forEach((effect) => effect());
  await settle();
  const say = async (text) => {
    input(render()).onChangeText(text);
    button(render(), '送信').onPress();
    await settle();
    return render();
  };
  return { render, say, store, ai, live };
}

test('greeting, casual chat and a follow-up question show replies and no proposal; nothing is written', async () => {
  const h = await consultHarness({
    script: (message) => ({ ok: true, result: message.includes('どんな投稿') ? result({ kind: 'question', assistantReply: 'どんな人に読んでほしいですか？', followUpQuestions: ['どんな人に読んでほしいですか？'] }) : result({ assistantReply: 'こんにちは。今日は何を話しましょうか。' }) }),
  });
  assert.ok(texts(h.render()).some((t) => t.includes('気軽に話しかけてください')));
  let tree = await h.say('こんにちは');
  assert.ok(texts(tree).includes('こんにちは。今日は何を話しましょうか。'));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  tree = await h.say('どんな投稿にしたらいい？');
  assert.ok(texts(tree).includes('どんな人に読んでほしいですか？'));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  assert.equal(h.store.writes.length, 0);
  // One endpoint call per send, with the session token, and earlier turns as bounded history.
  assert.equal(h.ai.calls.length, 2);
  assert.equal(h.ai.calls[0].token, 'jwt-1');
  assert.deepEqual(h.ai.calls[1].request.priorTurns.map((t) => t.role), ['assistant', 'user', 'assistant']);
  assert.equal(input(tree).value, '');
});

test('a proposal shows only its changed fields, saves nothing until 「これで覚えて」, then saves just the delta', async () => {
  const before = { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS, notes: '読者は個人開発者', frequencyTargetPerWeek: 4 }, persona: null, version: 7 };
  const h = await consultHarness({
    stored: before,
    script: () => ({ ok: true, result: result({ kind: 'proposal', assistantReply: 'この内容で覚えてよいか確認してください。', proposedSettingsDelta: { preferredTone: '親しみやすく、やわらかい', themes: ['AI活用'] } }) }),
  });
  let tree = await h.say('親しみやすく、AIの話を多めにしたい');
  const shown = texts(tree);
  assert.ok(shown.includes('トーン: 親しみやすく、やわらかい'));
  assert.ok(shown.includes('テーマ: AI活用'));
  assert.ok(!shown.some((t) => t.startsWith('週あたり') || t.startsWith('AIへの補足メモ')));
  // The answer arrived and is on screen, yet nothing was saved.
  assert.equal(h.store.writes.length, 0);
  assert.equal(h.store.row, before);

  button(tree, 'これで覚えて').onPress();
  await settle();
  tree = h.render();
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].expectedUpdatedAt, 'v7');
  assert.equal(h.store.writes[0].persona, null);
  assert.deepEqual(h.store.row.settings, { ...before.settings, preferredTone: '親しみやすく、やわらかい', themes: ['AI活用'] });
  assert.equal(h.store.row.settings.approvalMode, 'manual_review');
  assert.ok(texts(tree).some((t) => t.includes('確認した内容を保存しました')));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  // The conversation continues after a save.
  assert.ok(button(tree, '送信'));
});

test('a field changed elsewhere after the proposal is not overwritten: the user is asked to confirm again', async () => {
  const h = await consultHarness({
    stored: { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS }, persona: null, version: 1 },
    script: () => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }),
  });
  let tree = await h.say('週5回くらい');
  // Meanwhile the settings screen saved a different frequency and an unrelated note.
  h.store.row = { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS, frequencyTargetPerWeek: 7, notes: '別の画面で追記' }, persona: null, version: 2 };
  button(tree, 'これで覚えて').onPress();
  await settle();
  tree = h.render();
  assert.equal(h.store.writes.length, 0);
  assert.equal(h.store.row.settings.frequencyTargetPerWeek, 7);
  assert.ok(texts(tree).some((t) => t.includes('もう一度「これで覚えて」')));
  // Confirming again, now against what is saved, applies the delta and keeps the unrelated note.
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].expectedUpdatedAt, 'v2');
  assert.deepEqual(h.store.row.settings, { ...SOCIAL_MOBILE_CONTENT_DEFAULTS, frequencyTargetPerWeek: 5, notes: '別の画面で追記' });
});

test('an unrelated newer setting is kept when the proposal is confirmed', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }) });
  const tree = await h.say('週5回くらい');
  h.store.row = { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS, optionalNgWords: ['絶対'] }, persona: null, version: 2 };
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.equal(h.store.writes.length, 1);
  assert.deepEqual(h.store.row.settings, { ...SOCIAL_MOBILE_CONTENT_DEFAULTS, optionalNgWords: ['絶対'], frequencyTargetPerWeek: 5 });
});

test('a settings-only confirmation leaves a saved persona untouched; a persona proposal saves it as confirmed', async () => {
  const persona = { source: 'past_post_analysis', confirmed: true, toneSignals: ['淡々'], analyzedPostCount: 40 };
  const h = await consultHarness({
    stored: { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS }, persona, version: 3 },
    script: (message) => ({ ok: true, result: message.includes('絵文字') ? result({ kind: 'proposal', proposedPersonaDelta: { punctuationEmoji: '絵文字は少なめ' } }) : result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }),
  });
  let tree = await h.say('週5回くらい');
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.equal(h.store.writes[0].persona, null);
  assert.deepEqual(h.store.row.persona, persona);

  tree = await h.say('絵文字は少なめ');
  assert.ok(texts(tree).includes('記号・絵文字: 絵文字は少なめ'));
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.deepEqual(h.store.writes[1].persona, { ...persona, punctuationEmoji: '絵文字は少なめ', source: 'conversation', confirmed: true });
});

test('a later correction replaces the pending proposal, and a dismissed proposal saves nothing', async () => {
  const h = await consultHarness({ script: (message) => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: message.includes('2') ? 2 : 5 } }) }) });
  await h.say('週5回くらい');
  let tree = await h.say('やっぱり週2回で');
  assert.ok(texts(tree).includes('週あたり: 2回'));
  assert.ok(!texts(tree).includes('週あたり: 5回'));
  button(tree, 'この提案をやめる').onPress();
  tree = h.render();
  assert.equal(button(tree, 'これで覚えて'), undefined);
  assert.equal(h.store.writes.length, 0);
});

test('explaining the current settings is a plain answer: no proposal, no write', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result({ assistantReply: 'いまは、自然で親しみやすいトーンで、週3回の設定です。' }) }) });
  const tree = await h.say('今どういう設定？');
  assert.ok(texts(tree).includes('いまは、自然で親しみやすいトーンで、週3回の設定です。'));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  assert.equal(h.store.writes.length, 0);
});

test('a past-post request opens the consent gate only: no fetch, no persona, no write', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result({ assistantReply: '過去の投稿の読み込みには別途の確認が必要です。', historyLearningIntent: { explicitConsent: true, requestedRange: 'recent', derivedProfile: null } }) }) });
  let tree = await h.say('過去投稿を読んで');
  const gate = button(tree, '過去の投稿を読み込む前に確認');
  assert.ok(gate);
  assert.equal(button(tree, 'これで覚えて'), undefined);
  gate.onPress();
  tree = h.render();
  assert.ok(texts(tree).some((t) => t.includes('この候補画面では外部取得を実行しません')));
  assert.equal(h.ai.calls.length, 1);
  assert.equal(h.store.writes.length, 0);
});

test('a failed answer shows a retryable error, saves nothing, and retry resends the same message once', async () => {
  const h = await consultHarness({
    script: (_message, n) => (n === 1 ? { ok: false, error: session.consultFailure('CONSULT_AI_TIMEOUT', true) } : { ok: true, result: result({ assistantReply: 'お待たせしました。' }) }),
  });
  let tree = await h.say('週5回にしたい');
  assert.ok(texts(tree).some((t) => t.includes('時間がかかっています')));
  assert.equal(h.store.writes.length, 0);
  button(tree, 'もう一度送る').onPress();
  await settle();
  tree = h.render();
  assert.equal(h.ai.calls.length, 2);
  assert.equal(h.ai.calls[1].request.message, '週5回にしたい');
  assert.deepEqual(h.ai.calls[1].request.priorTurns.map((t) => t.role), ['assistant']);
  assert.ok(texts(tree).includes('お待たせしました。'));
  assert.equal(texts(tree).filter((t) => t === '週5回にしたい').length, 1);
  const permanent = await consultHarness({ script: () => ({ ok: false, error: session.consultFailure('OWNED_WORKSPACE_NOT_FOUND') }) });
  assert.equal(button(await permanent.say('こんにちは'), 'もう一度送る'), undefined);
});

test('empty or oversized input cannot be sent', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result() }) });
  assert.equal(button(h.render(), '送信').disabled, true);
  input(h.render()).onChangeText('あ'.repeat(session.CONSULT_LIMITS.messageChars + 1));
  const tree = h.render();
  assert.equal(button(tree, '送信').disabled, true);
  button(tree, '送信').onPress();
  await settle();
  assert.equal(h.ai.calls.length, 0);
});

test('a signed-in workspace that becomes unreachable before 「これで覚えて」 saves nothing and never claims a preview save', async () => {
  const h = await consultHarness({
    script: () => ({ ok: true, result: result({ kind: 'proposal', assistantReply: 'この内容で覚えてよいか確認してください。', proposedSettingsDelta: { preferredTone: '親しみやすく' } }) }),
  });
  await h.say('親しみやすくしたい');
  h.live.status = 'unavailable';
  button(h.render(), 'これで覚えて').onPress();
  await settle();
  const shown = texts(h.render());
  assert.ok(shown.some((t) => t.includes('いまは保存できません')));
  assert.ok(!shown.some((t) => t.includes('保存しました') || t.includes('ローカルプレビュー')));
  assert.equal(h.store.writes.length, 0);
  // The proposal stays visible so the user can confirm again later.
  assert.ok(button(h.render(), 'これで覚えて'));
});

test('the sample-data preview never calls the endpoint and never writes', async () => {
  const h = await consultHarness({ status: 'mock_preview', script: () => { throw new Error('the endpoint must not be called in preview'); } });
  assert.ok(texts(h.render()).includes('見本のあいさつ'));
  const tree = await h.say('週4回、やわらかく');
  assert.ok(texts(tree).includes('週あたり: 4回'));
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.ok(texts(h.render()).some((t) => t.includes('実データへはまだ保存していません')));
  assert.equal(h.ai.calls.length, 0);
  assert.equal(h.store.writes.length, 0);
  assert.equal(h.store.reads, 0);
});

test('a workspace switch ends the consultation: the old conversation and proposal are gone and nothing is saved', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result({ kind: 'proposal', assistantReply: 'この内容で覚えてよいか確認してください。', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }) });
  let tree = await h.say('週5回くらい');
  assert.ok(button(tree, 'これで覚えて'));
  h.live.workspaceId = 'u_2';
  h.render();
  await settle();
  tree = h.render();
  assert.equal(button(tree, 'これで覚えて'), undefined);
  assert.ok(!texts(tree).includes('週5回くらい'));
  assert.ok(!texts(tree).some((t) => t.startsWith('週あたり')));
  assert.ok(texts(tree).some((t) => t.includes('気軽に話しかけてください')));
  assert.equal(h.store.writes.length, 0);
  // The next message is a fresh consultation for the new workspace: no turns from the old one.
  await h.say('こんにちは');
  assert.equal(JSON.stringify(h.ai.calls[1].request.priorTurns.map((t) => t.role)), '["assistant"]');
  assert.equal(h.ai.calls[1].request.brandId, 'u_2');
});

test('an answer that arrives after a workspace switch is dropped, never shown as a proposal for the new workspace', async () => {
  let release;
  const h = await consultHarness({
    script: () => new Promise((resolve) => { release = () => resolve({ ok: true, result: result({ kind: 'proposal', assistantReply: '古い提案', proposedSettingsDelta: { frequencyTargetPerWeek: 6 } }) }); }),
  });
  input(h.render()).onChangeText('週6回');
  button(h.render(), '送信').onPress();
  await settle();
  h.live.workspaceId = 'u_2';
  h.render();
  await settle();
  release();
  await settle();
  const tree = h.render();
  assert.ok(!texts(tree).includes('古い提案'));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  assert.equal(button(tree, '送信').label, '送信');
  assert.equal(h.store.writes.length, 0);
});

test('a confirmation is abandoned if the workspace changes before the write is sent', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }) });
  const tree = await h.say('週5回くらい');
  h.store.afterRead = () => { h.live.workspaceId = 'u_2'; h.render(); };
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.equal(h.store.writes.length, 0);
  assert.ok(!texts(h.render()).some((t) => t.includes('保存しました')));
});

test('pressing 「これで覚えて」 twice in a row sends exactly one write', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }) });
  const tree = await h.say('週5回くらい');
  const confirm = button(tree, 'これで覚えて');
  confirm.onPress();
  confirm.onPress();
  await settle();
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.row.settings.frequencyTargetPerWeek, 5);
  const shown = texts(h.render());
  assert.ok(shown.some((t) => t.includes('確認した内容を保存しました')));
  assert.ok(!shown.some((t) => t.includes('もう一度「これで覚えて」')));
});

// --- Session epoch: a return to a workspace shown before (A -> B -> A) is a new consultation ---

const switchTo = (h, id) => { h.live.workspaceId = id; h.render(); };

test('A -> B -> A while an answer is in flight: the first A session\'s answer never reaches the new A session', async () => {
  const pending = [];
  const h = await consultHarness({
    script: (message) => new Promise((resolve) => pending.push({ message, resolve })),
  });
  input(h.render()).onChangeText('週6回');
  button(h.render(), '送信').onPress();
  await settle();
  switchTo(h, 'u_2');
  await settle();
  switchTo(h, 'u_1');
  await settle();
  // The user starts talking in the new A session; that answer is still in flight too.
  input(h.render()).onChangeText('こんにちは');
  button(h.render(), '送信').onPress();
  await settle();
  // The obsolete first-A answer arrives first.
  pending[0].resolve({ ok: true, result: result({ kind: 'proposal', assistantReply: '古いAの提案', proposedSettingsDelta: { frequencyTargetPerWeek: 6 } }) });
  await settle();
  let tree = h.render();
  assert.ok(!texts(tree).includes('古いAの提案'));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  // The new A session's own question is still waiting for its answer.
  assert.ok(button(tree, '送信中…'));
  pending[1].resolve({ ok: true, result: result({ assistantReply: '新しいAの返事' }) });
  await settle();
  tree = h.render();
  assert.ok(texts(tree).includes('新しいAの返事'));
  assert.ok(!texts(tree).includes('古いAの提案'));
  assert.ok(!texts(tree).includes('週6回'));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  assert.equal(h.store.writes.length, 0);
});

test('A -> B -> A while a confirmation is reading: the obsolete confirmation writes nothing and shows nothing', async () => {
  const h = await consultHarness({ script: () => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }) });
  const tree = await h.say('週5回くらい');
  h.store.afterRead = () => { switchTo(h, 'u_2'); switchTo(h, 'u_1'); };
  button(tree, 'これで覚えて').onPress();
  await settle();
  const after = h.render();
  assert.equal(h.store.writes.length, 0);
  assert.ok(!texts(after).some((t) => t.includes('保存しました') || t.includes('もう一度「これで覚えて」')));
  assert.equal(button(after, 'これで覚えて'), undefined);
  assert.ok(!texts(after).includes('週5回くらい'));
});

test('A -> B -> A after the write was sent: the write is not undone, but its completion never reaches the new A session', async () => {
  const h = await consultHarness({ script: (message) => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: message.includes('2') ? 2 : 5 } }) }) });
  let tree = await h.say('週5回くらい');
  h.store.afterSave = () => { switchTo(h, 'u_2'); switchTo(h, 'u_1'); };
  button(tree, 'これで覚えて').onPress();
  await settle();
  // The request had already been sent: it was applied (ignoring its answer does not cancel it).
  assert.equal(h.store.writes.length, 1);
  assert.equal(h.store.writes[0].applied, true);
  tree = h.render();
  assert.ok(!texts(tree).some((t) => t.includes('保存しました')));
  assert.equal(button(tree, 'これで覚えて'), undefined);
  assert.equal(button(tree, '送信').disabled, true);
  // The new A session is not blocked by the obsolete save: it can propose and save on its own.
  tree = await h.say('週2回で');
  assert.equal(button(tree, 'これで覚えて').disabled, false);
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.equal(h.store.writes.length, 2);
  assert.equal(h.store.writes[1].applied, true);
  assert.equal(h.store.row.settings.frequencyTargetPerWeek, 2);
  // Both writes went to workspace A only; nothing was written while B was shown.
  assert.deepEqual(h.store.writes.map((w) => w.brandId), ['u_1', 'u_1']);
  assert.ok(texts(h.render()).some((t) => t.includes('確認した内容を保存しました')));
});

test('when the new workspace cannot be read, the previous workspace\'s saved settings are never used as the proposal basis', async () => {
  // Workspace A has saved settings; a proposal for B is made while B cannot be read.
  const h = await consultHarness({
    stored: { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS, frequencyTargetPerWeek: 7, preferredTone: 'Aのトーン' }, persona: null, version: 4 },
    script: () => ({ ok: true, result: result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } }) }),
  });
  h.store.unavailableFor.add('u_2');
  switchTo(h, 'u_2');
  await settle();
  const tree = await h.say('週5回くらい');
  // B becomes readable; its real saved row happens to equal A's. A proposal shown against A's
  // settings would look unchanged and be saved at once; shown against "unknown" it must be confirmed again.
  h.store.unavailableFor.delete('u_2');
  button(tree, 'これで覚えて').onPress();
  await settle();
  assert.equal(h.store.writes.length, 0);
  assert.ok(texts(h.render()).some((t) => t.includes('もう一度「これで覚えて」')));
});
