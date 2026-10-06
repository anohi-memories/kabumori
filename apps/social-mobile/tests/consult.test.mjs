// The consultation chat: conversation -> proposal -> explicit confirmation -> save.
// Pure domain + data-client behaviour, the real server handler (model stubbed) for the
// end-to-end contract, and static checks that the screen only saves from the confirm path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { SOCIAL_MOBILE_CONTENT_DEFAULTS, validateSocialMobileContentSettings } from '../src/domain/content-settings.ts';
import {
  applyConfirmedConversationProposal,
  createConversationalAssistantProposal,
  validateConversationalAssistantResult,
} from '../src/domain/content-settings-conversation.ts';
import {
  boundedConsultHistory,
  buildConsultRequest,
  CONSULT_FUNCTION,
  CONSULT_LIMITS,
  consultInputProblem,
  consultReducer,
  hasPersistentChange,
  initialConsultState,
  parseConsultResponse,
  planConfirmedSave,
  priorTurns,
  proposalRows,
} from '../src/domain/consult-session.ts';
import { requestConsult } from '../src/data/consult-client.ts';
import { CONSULT_LIMITS as SERVER_LIMITS, handleSocialMobileConsult } from '../../../supabase/functions/social-mobile-consult/logic.ts';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(join(root, path), 'utf8');

const settings = { ...SOCIAL_MOBILE_CONTENT_DEFAULTS, preferredTone: '落ち着いた、ていねい', themes: ['個人開発'], frequencyTargetPerWeek: 3 };
const snapshot = (over = {}, persona = null) => ({ settings: { ...settings, ...over }, persona });

const result = (over = {}) => ({
  kind: 'chat',
  assistantReply: 'いいですね。',
  proposedSettingsDelta: {},
  proposedPersonaDelta: {},
  followUpQuestions: [],
  provenance: 'conversation',
  confidence: 'medium',
  uncertainty: [],
  requiresConfirmation: true,
  historyLearningIntent: { explicitConsent: false, requestedRange: 'recent', derivedProfile: null },
  publishPermissionChanged: false,
  ...over,
});
const envelope = (r) => ({ success: true, result: r, settings_saved: false, persona_saved: false, publish_attempted: false, scheduled_post_created: false, x_api_called: false });
const valid = (over) => validateConversationalAssistantResult(result(over));
const proposal = (delta, persona = {}) => valid({ kind: 'proposal', proposedSettingsDelta: delta, proposedPersonaDelta: persona });

test('the saved defaults are valid settings (a window may end at 24:00), so a confirmation can be saved at all', () => {
  assert.equal(validateSocialMobileContentSettings(SOCIAL_MOBILE_CONTENT_DEFAULTS).ok, true);
  const window = SOCIAL_MOBILE_CONTENT_DEFAULTS.generationWindow;
  for (const endLocal of ['24:01', '25:00', '24:0', 'x']) assert.equal(validateSocialMobileContentSettings({ ...SOCIAL_MOBILE_CONTENT_DEFAULTS, generationWindow: { ...window, endLocal } }).ok, false, endLocal);
  assert.equal(validateSocialMobileContentSettings({ ...SOCIAL_MOBILE_CONTENT_DEFAULTS, generationWindow: { ...window, startLocal: '24:00' } }).ok, false);
});

// --- request ---------------------------------------------------------------------------------------

test('client and server agree on the bounds', () => {
  for (const key of ['messageChars', 'historyTurns', 'turnChars', 'historyTotalChars']) assert.equal(CONSULT_LIMITS[key], SERVER_LIMITS[key], key);
  assert.equal(CONSULT_FUNCTION, 'social-mobile-consult');
});

test('multi-turn history is sent in bounded form: newest kept, oldest dropped, long turns clipped', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` }));
  const kept = boundedConsultHistory(many);
  assert.equal(kept.length, CONSULT_LIMITS.historyTurns);
  assert.equal(kept.at(-1).text, 'turn 29');
  assert.equal(kept[0].text, `turn ${30 - CONSULT_LIMITS.historyTurns}`);
  const long = boundedConsultHistory([{ role: 'user', text: 'あ'.repeat(5000) }]);
  assert.equal(long[0].text.length, CONSULT_LIMITS.turnChars);
  const heavy = boundedConsultHistory(Array.from({ length: 12 }, () => ({ role: 'user', text: 'あ'.repeat(900) })));
  assert.ok(heavy.reduce((n, t) => n + t.text.length, 0) <= CONSULT_LIMITS.historyTotalChars);
  assert.deepEqual(boundedConsultHistory([{ role: 'user', text: '   ' }]), []);
});

test('the request body is only the workspace selector, the message and bounded turns', () => {
  const body = buildConsultRequest({ brandId: 'u_1', message: '  週5回にしたい ', priorTurns: [{ role: 'assistant', text: 'こんにちは' }] });
  assert.deepEqual(body, { brand_id: 'u_1', message: '週5回にしたい', history: [{ role: 'assistant', text: 'こんにちは' }] });
  assert.equal(consultInputProblem('  '), 'empty');
  assert.equal(consultInputProblem('あ'.repeat(CONSULT_LIMITS.messageChars + 1)), 'too_long');
  assert.equal(consultInputProblem('こんにちは'), null);
});

// --- response trust boundary -----------------------------------------------------------------------

test('a normal chat answer is accepted and carries no proposal', () => {
  const outcome = parseConsultResponse(envelope(result()));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result.kind, 'chat');
  assert.equal(hasPersistentChange(outcome.result), false);
  assert.deepEqual(proposalRows(outcome.result), []);
});

test('a chat/question answer never carries a delta, even if the payload has one', () => {
  for (const kind of ['chat', 'question']) {
    const outcome = parseConsultResponse(envelope(result({ kind, proposedSettingsDelta: { frequencyTargetPerWeek: 9 } })));
    assert.equal(outcome.ok, true);
    assert.equal(hasPersistentChange(outcome.result), false, kind);
  }
});

test('unsafe or malformed answers fail closed into a retryable error', () => {
  const bad = [
    null,
    'text',
    { success: true },
    envelope(result({ requiresConfirmation: false })),
    envelope(result({ publishPermissionChanged: true })),
    envelope(result({ assistantReply: '' })),
    envelope(result({ kind: 'save' })),
    envelope(result({ kind: 'proposal', proposedSettingsDelta: { approvalMode: 'auto_post_preference' } })),
    envelope(result({ kind: 'proposal', proposedSettingsDelta: { generationWindow: { defaultGenerationLocal: '03:00' } } })),
    envelope(result({ kind: 'proposal', proposedSettingsDelta: { livePublishingEnabled: true } })),
    envelope(result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 99 } })),
    envelope(result({ kind: 'proposal', proposedSettingsDelta: { themes: 'AI' } })),
    envelope(result({ kind: 'proposal', proposedPersonaDelta: { access_token: 't' } })),
    envelope(result({ kind: 'proposal', proposedPersonaDelta: { source: 'manual' } })),
    envelope(result({ kind: 'proposal', proposedPersonaDelta: { confirmed: true } })),
    envelope(result({ scheduled_posts: [] })),
    envelope(result({ oauth: {} })),
    envelope(result({ social_account_id: 'x' })),
    { ...envelope(result()), settings_saved: true },
    { ...envelope(result()), publish_attempted: true },
    { ...envelope(result()), x_api_called: true },
    { ...envelope(result()), scheduled_post_created: true },
  ];
  for (const payload of bad) {
    const outcome = parseConsultResponse(payload);
    assert.equal(outcome.ok, false, JSON.stringify(payload)?.slice(0, 90));
    assert.equal(outcome.error.retryable, true);
    assert.ok(outcome.error.message);
  }
});

test('server error codes map to safe messages; permanent ones are not retryable', () => {
  const timeout = parseConsultResponse({ success: false, error: 'CONSULT_AI_TIMEOUT', retryable: true });
  assert.equal(timeout.error.retryable, true);
  assert.match(timeout.error.message, /もう一度/u);
  const forbidden = parseConsultResponse({ success: false, error: 'OWNED_WORKSPACE_NOT_FOUND', retryable: true });
  assert.equal(forbidden.error.retryable, false);
  const odd = parseConsultResponse({ success: false, error: 'select * from x; <script>' });
  assert.equal(odd.error.code, 'CONSULT_REQUEST_FAILED');
});

// --- proposal display ------------------------------------------------------------------------------

test('a proposal shows only the changed fields', () => {
  const p = proposal({ preferredTone: '親しみやすい', frequencyTargetPerWeek: 5 }, { punctuationEmoji: '絵文字は少なめ', sentenceLength: 'short' });
  assert.deepEqual(proposalRows(p), [
    { key: 'preferredTone', label: 'トーン', value: '親しみやすい' },
    { key: 'frequencyTargetPerWeek', label: '週あたり', value: '5回' },
    { key: 'sentenceLength', label: '文の長さ', value: '短め' },
    { key: 'punctuationEmoji', label: '記号・絵文字', value: '絵文字は少なめ' },
  ]);
  assert.deepEqual(proposalRows(proposal({ optionalNgWords: [] })), [{ key: 'optionalNgWords', label: '避けたい語句', value: '（なし）' }]);
});

// --- session state ---------------------------------------------------------------------------------

const greeting = [{ role: 'assistant', text: 'こんにちは' }];
const sent = (state, text) => consultReducer(state, { type: 'send', text });
const replied = (state, r, against = snapshot()) => consultReducer(state, { type: 'reply', result: r, shownAgainst: against });

test('normal chat shows the reply and no proposal; a follow-up question reads as a normal turn', () => {
  let state = replied(sent(initialConsultState(greeting), '今日何投稿しようかな'), valid());
  assert.deepEqual(state.messages.map((m) => m.role), ['assistant', 'user', 'assistant']);
  assert.equal(state.pending, null);
  assert.equal(state.sending, false);
  state = replied(sent(state, 'どんな投稿にしたらいい？'), valid({ kind: 'question', assistantReply: 'どんな人に読んでほしいですか？', followUpQuestions: ['どんな人に読んでほしいですか？'] }));
  assert.equal(state.messages.at(-1).text, 'どんな人に読んでほしいですか？');
  assert.equal(state.pending, null);
});

test('sending is single-flight, ignores empty/oversized input, and ids stay unique', () => {
  const start = initialConsultState(greeting);
  assert.equal(sent(start, '   '), start);
  assert.equal(sent(start, 'あ'.repeat(CONSULT_LIMITS.messageChars + 1)), start);
  const busy = sent(start, 'ひとつめ');
  assert.equal(sent(busy, 'ふたつめ'), busy);
  const state = replied(busy, valid());
  assert.equal(new Set(state.messages.map((m) => m.id)).size, state.messages.length);
  // An answer arriving when nothing is in flight is ignored.
  assert.equal(replied(state, proposal({ frequencyTargetPerWeek: 5 })), state);
});

test('a failed request is retryable and resends the same text without duplicating the user turn', () => {
  const error = { code: 'CONSULT_AI_TIMEOUT', retryable: true, message: 'x' };
  let state = consultReducer(sent(initialConsultState(greeting), '週5回にしたい'), { type: 'failed', error });
  assert.equal(state.sending, false);
  assert.equal(state.failed.text, '週5回にしたい');
  assert.deepEqual(priorTurns(state, true), [{ role: 'assistant', text: 'こんにちは' }]);
  state = consultReducer(state, { type: 'retry' });
  assert.equal(state.sending, true);
  assert.equal(state.messages.filter((m) => m.role === 'user').length, 1);
  state = replied(state, valid());
  assert.equal(state.failed, null);
  assert.deepEqual(state.messages.map((m) => m.role), ['assistant', 'user', 'assistant']);
});

test('a later correction replaces the pending proposal; a plain answer keeps it; the user can dismiss it', () => {
  let state = replied(sent(initialConsultState(greeting), '週5回くらい'), proposal({ frequencyTargetPerWeek: 5 }));
  assert.equal(state.pending.result.proposedSettingsDelta.frequencyTargetPerWeek, 5);
  state = replied(sent(state, 'それってどういう意味？'), valid());
  assert.equal(state.pending.result.proposedSettingsDelta.frequencyTargetPerWeek, 5);
  const newer = snapshot({ notes: 'newer' });
  state = replied(sent(state, 'やっぱり週2回で'), proposal({ frequencyTargetPerWeek: 2 }), newer);
  assert.deepEqual(state.pending.result.proposedSettingsDelta, { frequencyTargetPerWeek: 2 });
  assert.equal(state.pending.shownAgainst, newer);
  state = consultReducer(state, { type: 'dismiss_proposal' });
  assert.equal(state.pending, null);
});

test('the user can keep chatting after a save; the saved proposal is cleared and reported', () => {
  let state = replied(sent(initialConsultState(greeting), '週5回くらい'), proposal({ frequencyTargetPerWeek: 5 }));
  state = consultReducer(state, { type: 'saved', text: '保存しました' });
  assert.equal(state.pending, null);
  assert.deepEqual(state.notice, { tone: 'success', text: '保存しました' });
  state = replied(sent(state, 'ありがとう'), valid());
  assert.equal(state.messages.at(-1).role, 'assistant');
  assert.equal(state.notice, null);
});

test('a history-learning request only opens the consent gate; it proposes and fetches nothing', () => {
  const r = valid({ historyLearningIntent: { explicitConsent: true, requestedRange: 'recent', derivedProfile: { toneSignals: ['x'] } } });
  assert.equal(r.historyLearningIntent.derivedProfile, null);
  const state = replied(sent(initialConsultState(greeting), '過去の投稿を読んで'), r);
  assert.equal(state.historyIntent, true);
  assert.equal(state.pending, null);
});

// --- confirmation / persistence --------------------------------------------------------------------

test('an unconfirmed proposal changes nothing; only planConfirmedSave produces something to save', () => {
  const base = snapshot();
  const before = JSON.stringify(base);
  const p = proposal({ frequencyTargetPerWeek: 5 });
  const state = replied(sent(initialConsultState(greeting), '週5回'), p, base);
  assert.equal(JSON.stringify(state.pending.shownAgainst), before);
  assert.equal(JSON.stringify(base), before);
  assert.deepEqual(planConfirmedSave({ shownAgainst: base, latest: base, proposal: valid() }), { kind: 'nothing' });
});

test('confirming applies only the delta: unrelated settings stay exactly as saved', () => {
  const base = snapshot({ notes: '読者は個人開発者', optionalNgWords: ['絶対'] });
  const plan = planConfirmedSave({ shownAgainst: base, latest: base, proposal: proposal({ preferredTone: '親しみやすい', themes: ['個人開発', 'AI活用'] }) });
  assert.equal(plan.kind, 'save');
  assert.deepEqual(plan.settings, { ...base.settings, preferredTone: '親しみやすい', themes: ['個人開発', 'AI活用'] });
  assert.equal(plan.settings.approvalMode, 'manual_review');
  assert.deepEqual(plan.settings.generationWindow, base.settings.generationWindow);
  assert.equal(plan.personaChanged, false);
});

test('a settings-only confirmation does not erase or relabel an existing persona', () => {
  const persona = { source: 'past_post_analysis', confirmed: true, toneSignals: ['淡々'], analyzedPostCount: 40, analyzedAt: '2026-09-30T00:00:00Z' };
  const base = snapshot({}, persona);
  const plan = planConfirmedSave({ shownAgainst: base, latest: base, proposal: proposal({ frequencyTargetPerWeek: 5 }) });
  assert.equal(plan.kind, 'save');
  assert.equal(plan.personaChanged, false);
  assert.deepEqual(plan.persona, persona);
  const applied = applyConfirmedConversationProposal(base.settings, persona, proposal({ frequencyTargetPerWeek: 5 }));
  assert.equal(applied.persona, persona);
});

test('a persona delta merges into the existing persona and is marked confirmed from conversation', () => {
  const persona = { source: 'conversation', confirmed: true, toneSignals: ['淡々'], ctaStyle: '控えめ' };
  const base = snapshot({}, persona);
  const plan = planConfirmedSave({ shownAgainst: base, latest: base, proposal: proposal({}, { punctuationEmoji: '絵文字は少なめ' }) });
  assert.equal(plan.kind, 'save');
  assert.equal(plan.personaChanged, true);
  assert.deepEqual(plan.persona, { ...persona, punctuationEmoji: '絵文字は少なめ', source: 'conversation', confirmed: true });
  assert.deepEqual(plan.settings, base.settings);
});

test('unrelated newer settings are kept; a newer value of a proposed field is never silently overwritten', () => {
  const shown = snapshot();
  const p = proposal({ frequencyTargetPerWeek: 5 });
  // Something else changed elsewhere after the proposal was shown: kept, and the delta still applies.
  const unrelated = snapshot({ notes: '設定画面で追記', optionalNgWords: ['絶対'] });
  const merged = planConfirmedSave({ shownAgainst: shown, latest: unrelated, proposal: p });
  assert.equal(merged.kind, 'save');
  assert.deepEqual(merged.settings, { ...unrelated.settings, frequencyTargetPerWeek: 5 });
  // The very field being proposed changed meanwhile: do not clobber, ask again.
  const conflicting = snapshot({ frequencyTargetPerWeek: 7 });
  assert.deepEqual(planConfirmedSave({ shownAgainst: shown, latest: conflicting, proposal: p }), { kind: 'reconfirm', conflicts: ['frequencyTargetPerWeek'] });
  // After the user sees the current state and confirms again, it saves.
  assert.equal(planConfirmedSave({ shownAgainst: conflicting, latest: conflicting, proposal: p }).kind, 'save');
  const personaShown = snapshot({}, { source: 'conversation', confirmed: true, ctaStyle: '控えめ' });
  const personaNow = snapshot({}, { source: 'conversation', confirmed: true, ctaStyle: '強め' });
  assert.deepEqual(planConfirmedSave({ shownAgainst: personaShown, latest: personaNow, proposal: proposal({}, { ctaStyle: '質問で終える' }) }).conflicts, ['ctaStyle']);
});

test('rebasing a stale proposal keeps it pending and tells the user to confirm again', () => {
  let state = replied(sent(initialConsultState(greeting), '週5回'), proposal({ frequencyTargetPerWeek: 5 }));
  const latest = snapshot({ frequencyTargetPerWeek: 7 });
  state = consultReducer(state, { type: 'rebase_proposal', shownAgainst: latest, text: 'もう一度' });
  assert.equal(state.pending.shownAgainst, latest);
  assert.deepEqual(state.notice, { tone: 'warning', text: 'もう一度' });
});

test('general chat can never toggle posting, scheduling or the X connection', () => {
  for (const text of ['自動投稿をONにして', '今すぐ投稿して', '毎朝9時に予約して', 'Xアカウントを切り替えて', 'ちょっと疲れた']) {
    const local = validateConversationalAssistantResult(createConversationalAssistantProposal({ currentSettings: settings, currentPersona: null, userUtterance: text }));
    assert.ok(local, text);
    const applied = applyConfirmedConversationProposal(settings, null, local);
    assert.equal(applied.settings.approvalMode, settings.approvalMode, text);
    assert.deepEqual(applied.settings.generationWindow, settings.generationWindow, text);
    assert.equal(local.publishPermissionChanged, false);
    assert.ok(!('livePublishingEnabled' in applied.settings));
  }
});

// --- data client -----------------------------------------------------------------------------------

test('the data client sends one bounded request with the session token and returns a validated answer', async () => {
  const calls = [];
  const client = { functions: { invoke: async (name, options) => { calls.push({ name, options }); return { data: envelope(result({ kind: 'proposal', proposedSettingsDelta: { frequencyTargetPerWeek: 5 } })), error: null }; } } };
  const outcome = await requestConsult(client, 'jwt-1', { brandId: 'u_1', message: '週5回', priorTurns: [{ role: 'assistant', text: 'こんにちは' }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'social-mobile-consult');
  assert.deepEqual(calls[0].options.headers, { Authorization: 'Bearer jwt-1' });
  assert.deepEqual(Object.keys(calls[0].options.body).sort(), ['brand_id', 'history', 'message']);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result.proposedSettingsDelta, { frequencyTargetPerWeek: 5 });
});

test('the data client turns a non-2xx answer, a thrown error or a bad body into a safe error', async () => {
  const withError = (context) => ({ functions: { invoke: async () => ({ data: null, error: { context } }) } });
  const http = await requestConsult(withError(Response.json({ success: false, error: 'CONSULT_AI_BUSY', retryable: true }, { status: 503 })), 't', { brandId: 'u_1', message: 'a', priorTurns: [] });
  assert.equal(http.ok, false);
  assert.equal(http.error.code, 'CONSULT_AI_BUSY');
  const opaque = await requestConsult(withError(undefined), 't', { brandId: 'u_1', message: 'a', priorTurns: [] });
  assert.equal(opaque.error.code, 'CONSULT_REQUEST_FAILED');
  const thrown = await requestConsult({ functions: { invoke: async () => { throw new Error('offline'); } } }, 't', { brandId: 'u_1', message: 'a', priorTurns: [] });
  assert.equal(thrown.error.retryable, true);
});

// --- end to end with the real server handler (model stubbed) ---------------------------------------

const userId = '11111111-1111-4111-8111-111111111111';
const brandId = 'u_ae343f5caedb67d4af33fc7a';
const nulls = (keys) => Object.fromEntries(keys.map((key) => [key, null]));
const S_KEYS = ['preferredTone', 'themes', 'objective', 'frequencyTargetPerWeek', 'optionalNgWords', 'notes'];
const P_KEYS = ['toneSignals', 'sentenceLength', 'punctuationEmoji', 'recurringVocabulary', 'topicSignals', 'hashtagHabits', 'ctaStyle', 'openingClosingPatterns'];

/** A Supabase-client stand-in that routes functions.invoke to the real Edge handler with a scripted model. */
function serverBackedClient(script) {
  const seen = { supabase: [], model: [] };
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === 'api.openai.com') {
      const body = JSON.parse(init.body);
      seen.model.push(body);
      const reply = script(body.input.at(-1).content);
      const output = { kind: 'chat', reply: 'はい。', follow_up_questions: [], settings_delta: nulls(S_KEYS), persona_delta: nulls(P_KEYS), confidence: 'medium', uncertainty: [], history_learning_requested: false, ...reply };
      output.settings_delta = { ...nulls(S_KEYS), ...(reply.settings_delta ?? {}) };
      output.persona_delta = { ...nulls(P_KEYS), ...(reply.persona_delta ?? {}) };
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    seen.supabase.push({ path: url.pathname, method: init?.method ?? 'GET' });
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId });
    if (url.pathname === '/rest/v1/brand_memberships') return Response.json([{ brand_id: brandId, role: 'owner', user_id: userId }]);
    if (url.pathname === '/rest/v1/brands') return Response.json([{ id: brandId, code_profile_key: 'social_mobile_user_v1' }]);
    if (url.pathname === '/rest/v1/social_mobile_content_settings') return Response.json([{ settings, persona_profile: {}, persona_provenance: 'conversation', persona_confirmed: false }]);
    return new Response('unexpected', { status: 404 });
  };
  const client = {
    functions: {
      invoke: async (name, options) => {
        const response = await handleSocialMobileConsult(
          new Request(`https://edge.example/${name}`, { method: 'POST', headers: { ...options.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }),
          { supabaseUrl: 'https://example.supabase.co', publishableKey: 'pk', openAiApiKey: 'sk', fetchImpl, log: () => {} },
        );
        return response.ok ? { data: await response.json(), error: null } : { data: null, error: { context: response } };
      },
    },
  };
  return { client, seen };
}

test('end to end: chat, question, proposal, explanation and history intent through the real handler', async () => {
  const { client, seen } = serverBackedClient((message) => {
    if (message.includes('こんにちは')) return { reply: 'こんにちは。今日はどんなことを話しましょうか。' };
    if (message.includes('どんな投稿')) return { kind: 'question', reply: 'どんな人に読んでほしいですか？', follow_up_questions: ['どんな人に読んでほしいですか？'] };
    if (message.includes('親しみやすく')) return { kind: 'proposal', reply: 'この内容で覚えてよいか確認してください。', settings_delta: { preferredTone: '親しみやすく、やわらかい', themes: ['個人開発', 'AI活用'] } };
    if (message.includes('今どういう設定')) return { kind: 'proposal', reply: 'いまは落ち着いたトーンで、個人開発について週3回です。', settings_delta: { preferredTone: '落ち着いた、ていねい', frequencyTargetPerWeek: 3 } };
    if (message.includes('過去投稿')) return { reply: '過去の投稿の読み込みには別途の確認が必要です。', history_learning_requested: true };
    return {};
  });
  let state = initialConsultState(greeting);
  const base = snapshot();
  const say = async (text) => {
    const prior = priorTurns(state);
    state = sent(state, text);
    const outcome = await requestConsult(client, 'jwt', { brandId, message: text, priorTurns: prior });
    state = outcome.ok ? replied(state, outcome.result, base) : consultReducer(state, { type: 'failed', error: outcome.error });
    return outcome;
  };

  assert.equal((await say('こんにちは')).result.kind, 'chat');
  assert.equal(state.pending, null);
  assert.equal((await say('どんな投稿にしたらいい？')).result.kind, 'question');
  assert.equal(state.pending, null);

  const proposed = await say('親しみやすく、AIの話を多めにしたい');
  assert.equal(proposed.result.kind, 'proposal');
  assert.deepEqual(proposalRows(state.pending.result).map((row) => row.key), ['preferredTone', 'themes']);
  // Before confirmation nothing was written anywhere: the handler only ever reads.
  assert.ok(seen.supabase.every((call) => call.method === 'GET'));
  const plan = planConfirmedSave({ shownAgainst: state.pending.shownAgainst, latest: base, proposal: state.pending.result });
  assert.deepEqual(plan.settings, { ...settings, preferredTone: '親しみやすく、やわらかい', themes: ['個人開発', 'AI活用'] });

  const explained = await say('今どういう設定？');
  assert.equal(explained.result.kind, 'chat');
  assert.equal(hasPersistentChange(explained.result), false);

  const history = await say('過去投稿を読んで');
  assert.equal(history.result.historyLearningIntent.explicitConsent, true);
  assert.equal(state.historyIntent, true);

  // One model call per send, earlier turns forwarded, and never an X / schedule / account endpoint.
  assert.equal(seen.model.length, 5);
  assert.ok(seen.model[2].input.some((turn) => turn.role === 'assistant' && turn.content === 'どんな人に読んでほしいですか？'));
  assert.ok(!seen.supabase.some((call) => /social_accounts|scheduled_posts|rpc|vault/iu.test(call.path)));
});

// --- versioned save (compare-and-swap) -------------------------------------------------------------

async function loadRepository() {
  const source = (await read('src/data/content-settings-repository.ts')).replace("'@/domain/content-settings'", JSON.stringify(pathToFileURL(join(root, 'src/domain/content-settings.ts')).href));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = await mkdtemp(join(tmpdir(), 'consult-repo-'));
  const file = join(dir, 'repository.mjs');
  await writeFile(file, js);
  return (await import(pathToFileURL(file).href)).SupabaseContentSettingsRepository;
}

function tableClient(respond) {
  const ops = [];
  const builder = (op) => {
    const chain = { eq: (column, value) => { op.filters.push([column, value]); return chain; }, select: () => Promise.resolve(respond(op)) };
    return chain;
  };
  const client = {
    from: (table) => ({
      insert: (values) => { const op = { table, kind: 'insert', values, filters: [] }; ops.push(op); return builder(op); },
      update: (values) => { const op = { table, kind: 'update', values, filters: [] }; ops.push(op); return builder(op); },
      upsert: () => { throw new Error('upsert must not be used for a confirmed conversation save'); },
    }),
  };
  return { client, ops };
}

test('a confirmed save is conditional on the row version; a changed row is reported stale and not written', async () => {
  const Repository = await loadRepository();
  const ok = tableClient(() => ({ data: [{ brand_id: 'u_1' }], error: null }));
  assert.deepEqual(await new Repository(ok.client).saveConfirmedIfUnchanged('u_1', settings, null, '2026-10-01T00:00:00.123456+00:00'), { ok: true });
  assert.equal(ok.ops[0].kind, 'update');
  assert.deepEqual(ok.ops[0].filters, [['brand_id', 'u_1'], ['updated_at', '2026-10-01T00:00:00.123456+00:00']]);
  // Settings-only: persona columns are not part of the write, so a saved persona cannot be erased.
  assert.deepEqual(Object.keys(ok.ops[0].values), ['settings']);

  const stale = tableClient(() => ({ data: [], error: null }));
  const staleResult = await new Repository(stale.client).saveConfirmedIfUnchanged('u_1', settings, null, 'v1');
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.stale, true);

  const first = tableClient(() => ({ data: [{ brand_id: 'u_1' }], error: null }));
  await new Repository(first.client).saveConfirmedIfUnchanged('u_1', settings, null, null);
  assert.equal(first.ops[0].kind, 'insert');
  const raced = tableClient(() => ({ data: null, error: { code: '23505' } }));
  assert.equal((await new Repository(raced.client).saveConfirmedIfUnchanged('u_1', settings, null, null)).stale, true);
});

test('a confirmed persona is saved in its dedicated columns; invalid settings or an unconfirmed persona are refused', async () => {
  const Repository = await loadRepository();
  const { client, ops } = tableClient(() => ({ data: [{ brand_id: 'u_1' }], error: null }));
  const persona = { source: 'conversation', confirmed: true, punctuationEmoji: '絵文字は少なめ', analyzedPostCount: 40, analyzedAt: '2026-09-30T00:00:00Z' };
  assert.deepEqual(await new Repository(client).saveConfirmedIfUnchanged('u_1', settings, persona, 'v1'), { ok: true });
  assert.deepEqual(ops[0].values.persona_profile, { punctuationEmoji: '絵文字は少なめ' });
  assert.equal(ops[0].values.persona_provenance, 'conversation');
  assert.equal(ops[0].values.persona_confirmed, true);
  assert.equal(ops[0].values.persona_last_analyzed_count, 40);

  const refused = tableClient(() => { throw new Error('must not reach the database'); });
  const repo = new Repository(refused.client);
  assert.equal((await repo.saveConfirmedIfUnchanged('u_1', { ...settings, approvalMode: 'whatever' }, null, 'v1')).ok, false);
  assert.equal((await repo.saveConfirmedIfUnchanged('u_1', { ...settings, livePublishingEnabled: true, publish_enabled: true }, null, 'v1')).ok, false);
  assert.equal((await repo.saveConfirmedIfUnchanged('u_1', settings, { ...persona, confirmed: false }, 'v1')).ok, false);
  assert.equal(refused.ops.length, 0);
  const denied = tableClient(() => ({ data: null, error: { code: '42501', message: 'internal detail' } }));
  const deniedResult = await new Repository(denied.client).saveConfirmedIfUnchanged('u_1', settings, null, 'v1');
  assert.equal(deniedResult.ok, false);
  assert.doesNotMatch(deniedResult.reason, /internal detail/u);
});

// --- the screen ------------------------------------------------------------------------------------

test('the screen saves only from the confirm button, through the versioned repository call', async () => {
  const screen = await read('src/app/(tabs)/consult.tsx');
  // The only writes are inside confirmProposal, and confirmProposal is only wired to 「これで覚えて」.
  const confirmStart = screen.indexOf('async function confirmProposal');
  const confirmEnd = screen.indexOf('const problem =');
  assert.ok(confirmStart > 0 && confirmEnd > confirmStart);
  const outside = screen.slice(0, confirmStart) + screen.slice(confirmEnd);
  assert.doesNotMatch(outside, /saveConfirmedIfUnchanged|saveConfirmedProposal|\.upsert\(|\.insert\(|\.update\(/u);
  assert.match(screen.slice(confirmStart, confirmEnd), /planConfirmedSave\(/u);
  assert.match(screen.slice(confirmStart, confirmEnd), /saveConfirmedIfUnchanged\(/u);
  assert.equal(screen.match(/void confirmProposal\(\)/gu).length, 1);
  assert.match(screen, /label=\{saving \? "保存中…" : "これで覚えて"\} onPress=\{\(\) => void confirmProposal\(\)\}/u);
  // The proposal block exists only while something persistent is pending.
  assert.match(screen, /\{state\.pending \? \(/u);
  assert.match(screen, /proposalRows\(state\.pending\.result\)/u);
  // The AI provider is never called from the app; the conversation goes through the endpoint client.
  assert.match(screen, /requestConsult\(supabase, accessToken/u);
  assert.doesNotMatch(screen, /openai|api\.x\.com|OPENAI|functions\/v1\/social-mobile-history-learning|scheduled_posts|publish_enabled/iu);
  // Loading, retryable error and the history consent gate are present.
  for (const text of ['AIが考えています…', 'もう一度送る', '過去の投稿を読み込む前に確認', '自動投稿ON・X投稿・投稿予定作成は行いません', 'この提案をやめる']) assert.ok(screen.includes(text), text);
});

test('no provider secret or direct provider call exists in the app source', async () => {
  for (const file of ['src/data/consult-client.ts', 'src/domain/consult-session.ts', 'src/domain/content-settings-conversation.ts', 'src/app/(tabs)/consult.tsx']) {
    const text = await read(file);
    assert.doesNotMatch(text, /api\.openai\.com|OPENAI_API_KEY|sk-[A-Za-z0-9]{8,}|service_role/u, file);
  }
});
