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
  const store = { row: stored === undefined ? { settings: { ...SOCIAL_MOBILE_CONTENT_DEFAULTS }, persona: null, version: 1 } : stored, writes: [], reads: 0 };
  class Repository {
    async read() {
      store.reads += 1;
      if (!store.row) return { state: 'ready', data: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null, updatedAt: null };
      return { state: 'ready', data: store.row.settings, persona: store.row.persona, updatedAt: `v${store.row.version}` };
    }
    async saveConfirmedIfUnchanged(brandId, settings, persona, expectedUpdatedAt) {
      const current = store.row ? `v${store.row.version}` : null;
      store.writes.push({ brandId, settings, persona, expectedUpdatedAt, applied: current === expectedUpdatedAt });
      if (current !== expectedUpdatedAt) return { ok: false, stale: true, reason: 'stale' };
      assert.equal(validateSocialMobileContentSettings(settings).ok, true);
      store.row = { settings, persona: persona ?? store.row?.persona ?? null, version: (store.row?.version ?? 0) + 1 };
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
    '@/providers/data-provider': { useDataStatus: () => ({ status: live.status, snapshot: { workspace: { id: 'u_1' } } }) },
  };
  // The data status can change while the screen is open (e.g. the workspace becomes unreachable).
  const live = { status };
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
