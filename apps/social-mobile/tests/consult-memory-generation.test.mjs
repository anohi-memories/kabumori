// V1 acceptance: what the user confirms in the consultation is what post generation uses.
// The chain runs through the real code at every hop -- app proposal validation and save plan, the
// versioned repository write, the server's row reader and the brand post generator -- with only the
// network stubbed. Nothing here changes generator or runtime behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { SOCIAL_MOBILE_CONTENT_DEFAULTS } from '../src/domain/content-settings.ts';
import { validateConversationalAssistantResult } from '../src/domain/content-settings-conversation.ts';
import { planConfirmedSave } from '../src/domain/consult-session.ts';
import { handleSocialMobileConsult } from '../../../supabase/functions/social-mobile-consult/logic.ts';
import { generateBrandPost } from '../../../supabase/functions/_shared/brand/brand_post_generator.ts';

const root = resolve(import.meta.dirname, '..');
const functionsRoot = resolve(root, '../../supabase/functions');
const userId = '22222222-2222-4222-8222-222222222222';
const brandId = 'u_memory_generation_1';

async function transpiledModule(path, replacements, prefix) {
  let source = await readFile(path, 'utf8');
  for (const [from, to] of replacements) source = source.replaceAll(from, to);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const file = join(await mkdtemp(join(tmpdir(), prefix)), 'module.mjs');
  await writeFile(file, js);
  return import(pathToFileURL(file).href);
}

const loadRepository = async () => (await transpiledModule(
  join(root, 'src/data/content-settings-repository.ts'),
  [["'@/domain/content-settings'", JSON.stringify(pathToFileURL(join(root, 'src/domain/content-settings.ts')).href)]],
  'memory-repo-',
)).SupabaseContentSettingsRepository;

// The scheduled/preview consumer of saved settings on main is the dry-run handler. Its shared imports
// are loaded as-is; only the handler file itself needs transpiling (it uses a parameter property).
const loadDryRunHandler = async () => (await transpiledModule(
  join(functionsRoot, 'social-mobile-brand-dry-run/logic.ts'),
  [['"../_shared/', JSON.stringify(`${pathToFileURL(join(functionsRoot, '_shared')).href}/`).slice(0, -1)]],
  'memory-dry-run-',
)).handleSocialMobileBrandDryRun;

/** Records the confirmed write exactly as the repository sends it to PostgREST. */
function recordingTable() {
  const writes = [];
  const chain = (op) => ({ eq: (column, value) => { op.filters.push([column, value]); return chain(op); }, select: async () => ({ data: [{ brand_id: brandId }], error: null }) });
  const client = {
    from: (table) => ({
      insert: (values) => { const op = { table, kind: 'insert', values, filters: [] }; writes.push(op); return chain(op); },
      update: (values) => { const op = { table, kind: 'update', values, filters: [] }; writes.push(op); return chain(op); },
      upsert: () => { throw new Error('a confirmed conversation save must be versioned, not an upsert'); },
    }),
  };
  return { client, writes };
}

/** PostgREST stand-in for the caller's own JWT reads; `row` is the saved settings row. */
function workspaceFetch(row, onModel) {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.host === 'api.openai.com') return onModel(JSON.parse(String(init.body)));
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId });
    if (url.pathname === '/rest/v1/brand_memberships') return Response.json([{ brand_id: brandId, role: 'owner', user_id: userId }]);
    if (url.pathname === '/rest/v1/brands') {
      return Response.json([{ id: brandId, display_name: 'My Workspace', is_active: false, publish_mode: 'disabled', code_profile_key: 'social_mobile_user_v1' }]);
    }
    if (url.pathname === '/rest/v1/social_accounts') {
      return Response.json([{ id: 'acc_1', brand_id: brandId, platform: 'x', handle: 'memory_user', connection_status: 'identity_verified' }]);
    }
    if (url.pathname === '/rest/v1/social_mobile_content_settings') return Response.json(row ? [row] : []);
    return new Response('unexpected', { status: 404 });
  };
}

const openAiText = (text) => Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 1, output_tokens: 1 } });

/** Runs the real dry-run handler; its generator call mirrors defaultGenerate with the network stubbed. */
async function generationPrompt(row) {
  const handle = await loadDryRunHandler();
  let used = null;
  let promptBody = null;
  const response = await handle(
    new Request('https://edge.example/social-mobile-brand-dry-run', { method: 'POST', headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify({ brand_id: brandId }) }),
    {
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: 'pk',
      openAiApiKey: 'sk',
      fetchImpl: workspaceFetch(row, () => { throw new Error('the reader must not call the model'); }),
      generate: async ({ context, settings, openAiApiKey }) => {
        used = settings;
        const draft = await generateBrandPost({
          openAiApiKey,
          context,
          postType: 'brand_post',
          generationPurpose: 'social_mobile_preview',
          contentSettings: settings,
          fetchImpl: async (_url, init) => {
            promptBody = JSON.parse(String(init.body));
            return openAiText('小さな工夫を、ひとつだけ試してみる。');
          },
        });
        return { text: draft.text, model: draft.model, characterCount: draft.characterCount };
      },
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  return { used, instructions: String(promptBody.instructions) };
}

/** Runs the real consultation handler and returns the saved context the model was shown. */
async function nextConsultationContext(row) {
  let modelBody = null;
  const nulls = (keys) => Object.fromEntries(keys.map((key) => [key, null]));
  const response = await handleSocialMobileConsult(
    new Request('https://edge.example/social-mobile-consult', { method: 'POST', headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify({ brand_id: brandId, message: '今どういう設定？' }) }),
    {
      supabaseUrl: 'https://example.supabase.co',
      publishableKey: 'pk',
      openAiApiKey: 'sk',
      log: () => {},
      fetchImpl: workspaceFetch(row, (body) => {
        modelBody = body;
        return openAiText(JSON.stringify({
          kind: 'chat', reply: '今の設定を説明します。', follow_up_questions: [],
          settings_delta: nulls(['preferredTone', 'themes', 'objective', 'frequencyTargetPerWeek', 'optionalNgWords', 'notes']),
          persona_delta: nulls(['toneSignals', 'sentenceLength', 'punctuationEmoji', 'recurringVocabulary', 'topicSignals', 'hashtagHabits', 'ctaStyle', 'openingClosingPatterns']),
          confidence: 'high', uncertainty: [], history_learning_requested: false,
        }));
      }),
    },
  );
  assert.equal(response.status, 200);
  return JSON.stringify(modelBody.input);
}

const proposal = validateConversationalAssistantResult({
  kind: 'proposal',
  assistantReply: 'この内容で覚えてよいか確認してください。',
  proposedSettingsDelta: {
    preferredTone: '落ち着いて、ていねいに',
    themes: ['個人開発', '仕事の小さな工夫'],
    objective: '試せるヒントをひとつ届ける',
    optionalNgWords: ['絶対儲かる'],
    notes: '読者は忙しい会社員。家族の話は書かない。',
  },
  proposedPersonaDelta: { sentenceLength: 'short', punctuationEmoji: '絵文字は使わない', recurringVocabulary: ['小さな工夫', '試してみる'], toneSignals: ['淡々'] },
  followUpQuestions: [],
  provenance: 'conversation',
  confidence: 'high',
  uncertainty: [],
  requiresConfirmation: true,
  historyLearningIntent: { explicitConsent: false, requestedRange: 'recent', derivedProfile: null },
  publishPermissionChanged: false,
});

/** The confirmed save exactly as the screen performs it, turned into the row the database returns. */
async function confirmedRow() {
  assert.ok(proposal, 'the proposal is a valid conversational result');
  const latest = { settings: SOCIAL_MOBILE_CONTENT_DEFAULTS, persona: null };
  const plan = planConfirmedSave({ shownAgainst: latest, latest, proposal });
  assert.equal(plan.kind, 'save');
  const Repository = await loadRepository();
  const { client, writes } = recordingTable();
  assert.deepEqual(await new Repository(client).saveConfirmedIfUnchanged(brandId, plan.settings, plan.personaChanged ? plan.persona : null, null), { ok: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'insert');
  const { brand_id: savedBrand, ...columns } = writes[0].values;
  assert.equal(savedBrand, brandId);
  return { plan, row: { ...columns, updated_at: '2026-10-06T09:00:00.000001+00:00' } };
}

test('confirmed settings and persona reach the post-generation prompt without a shadow schema', async () => {
  const { plan, row } = await confirmedRow();
  const { used, instructions } = await generationPrompt(row);

  // Read-back is the same contract: every saved settings field arrives unchanged, plus the fixed
  // non-publishing marker and the confirmed persona from its dedicated columns.
  for (const [key, value] of Object.entries(plan.settings)) assert.deepEqual(used[key], value, key);
  assert.equal(used.livePublishingEnabled, false);
  assert.deepEqual(used.personaProfile, {
    source: 'conversation', confirmed: true, toneSignals: ['淡々'], sentenceLength: 'short', punctuationEmoji: '絵文字は使わない', recurringVocabulary: ['小さな工夫', '試してみる'],
  });

  // Consultation never changes the read-only controls.
  assert.equal(used.approvalMode, SOCIAL_MOBILE_CONTENT_DEFAULTS.approvalMode);
  assert.deepEqual(used.generationWindow, SOCIAL_MOBILE_CONTENT_DEFAULTS.generationWindow);
  assert.equal(used.frequencyTargetPerWeek, SOCIAL_MOBILE_CONTENT_DEFAULTS.frequencyTargetPerWeek);

  // ...and the generator prompt carries what was remembered.
  for (const line of [
    '希望するトーン: 落ち着いて、ていねいに',
    '投稿の目的: 試せるヒントをひとつ届ける',
    '扱うテーマ候補: 個人開発、仕事の小さな工夫',
    '避ける語句: 絶対儲かる',
    '利用者メモ（事実として未確認の内容は採用しない）: 読者は忙しい会社員。家族の話は書かない。',
    '確認済みの文体傾向: short',
    '確認済みの記号・絵文字傾向: 絵文字は使わない',
    '確認済みの語彙傾向: 小さな工夫、試してみる',
  ]) assert.ok(instructions.includes(line), `missing in prompt: ${line}`);
});

test('the confirmed state is what the next consultation knows', async () => {
  const { row } = await confirmedRow();
  const context = await nextConsultationContext(row);
  for (const value of ['落ち着いて、ていねいに', '個人開発', '試せるヒントをひとつ届ける', '絶対儲かる', '家族の話は書かない', '絵文字は使わない', '小さな工夫', '淡々']) {
    assert.ok(context.includes(value), `missing in next consultation: ${value}`);
  }
});

test('an unconfirmed persona is never remembered guidance, in generation or in the next consultation', async () => {
  const { row } = await confirmedRow();
  const unconfirmed = { ...row, persona_confirmed: false };
  const { used, instructions } = await generationPrompt(unconfirmed);
  assert.equal(used.personaProfile?.confirmed, false);
  assert.doesNotMatch(instructions, /確認済み/u);
  // Saved settings still apply; only the persona is withheld.
  assert.ok(instructions.includes('希望するトーン: 落ち着いて、ていねいに'));
  const context = await nextConsultationContext(unconfirmed);
  assert.ok(!context.includes('絵文字は使わない'));
  assert.ok(context.includes('落ち着いて、ていねいに'));
});

test('with nothing saved, generation uses the code defaults rather than anything from another workspace', async () => {
  const { used, instructions } = await generationPrompt(null);
  assert.equal(used.preferredTone, '自然で親しみやすく、押しつけない');
  assert.equal(used.personaProfile, undefined);
  assert.doesNotMatch(instructions, /確認済み/u);
});
