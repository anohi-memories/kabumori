// The repository writes only what the hardened database contract accepts
// (supabase/migrations/20261003120000_social_mobile_content_settings_hardening.sql):
// persona_profile carries style signals only; provenance, confirmation and analysis
// metadata go to their dedicated columns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { SOCIAL_MOBILE_CONTENT_DEFAULTS } from '../src/domain/content-settings.ts';

const root = resolve(import.meta.dirname, '..');

async function loadRepository() {
  const source = (await readFile(join(root, 'src/data/content-settings-repository.ts'), 'utf8'))
    .replace("'@/domain/content-settings'", JSON.stringify(pathToFileURL(join(root, 'src/domain/content-settings.ts')).href));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const dir = await mkdtemp(join(tmpdir(), 'settings-repo-'));
  const file = join(dir, 'repository.mjs');
  await writeFile(file, js);
  return (await import(pathToFileURL(file).href)).SupabaseContentSettingsRepository;
}

function recordingClient() {
  const writes = [];
  return {
    writes,
    client: { from: (table) => ({ upsert: async (values, options) => { writes.push({ table, values, options }); return { error: null }; } }) },
  };
}

// The persona keys the database contract allows inside persona_profile.
const PERSONA_JSON_KEYS = new Set(['toneSignals', 'sentenceLength', 'punctuationEmoji', 'recurringVocabulary', 'topicSignals', 'hashtagHabits', 'ctaStyle', 'openingClosingPatterns']);

// The saved defaults (a window ending at 24:00) are valid as-is since PR #78 aligned the app validator.
const settings = SOCIAL_MOBILE_CONTENT_DEFAULTS;

test('a confirmed past-post persona keeps its metadata in columns, not in persona_profile', async () => {
  const Repository = await loadRepository();
  const { client, writes } = recordingClient();
  const persona = {
    source: 'past_post_analysis', confirmed: true, toneSignals: ['淡々'], sentenceLength: 'short',
    analyzedPostCount: 40, analyzedAt: '2026-09-30T00:00:00.000Z',
  };
  assert.deepEqual(await new Repository(client).saveConfirmedProposal('u_1', settings, persona), { ok: true });
  assert.equal(writes.length, 1);
  const values = writes[0].values;
  assert.deepEqual(values.persona_profile, { toneSignals: ['淡々'], sentenceLength: 'short' });
  assert.ok(Object.keys(values.persona_profile).every((key) => PERSONA_JSON_KEYS.has(key)));
  assert.equal(values.persona_provenance, 'past_post_analysis');
  assert.equal(values.persona_confirmed, true);
  assert.equal(values.persona_last_analyzed_count, 40);
  assert.equal(values.persona_last_analyzed_at, '2026-09-30T00:00:00.000Z');
  // The caller's object is not mutated.
  assert.equal(persona.analyzedPostCount, 40);
});

test('a settings-only save never writes persona columns', async () => {
  const Repository = await loadRepository();
  const { client, writes } = recordingClient();
  assert.deepEqual(await new Repository(client).upsert('u_1', settings), { ok: true });
  assert.deepEqual(Object.keys(writes[0].values).sort(), ['brand_id', 'settings']);
});

test('settings the app writes use the canonical JSON types the database requires', async () => {
  const Repository = await loadRepository();
  const { client, writes } = recordingClient();
  // A blank theme is refused by the app validator outright (nothing is written)...
  assert.equal((await new Repository(client).upsert('u_1', { ...settings, themes: ['AI', ''] })).ok, false);
  assert.equal(writes.length, 0);
  // ...while surrounding spaces are trimmed and blank NG words are dropped before writing.
  await new Repository(client).upsert('u_1', { ...settings, frequencyTargetPerWeek: 5, themes: [' AI '], optionalNgWords: ['絶対', '  '] });
  const saved = writes[0].values.settings;
  assert.equal(typeof saved.frequencyTargetPerWeek, 'number');
  assert.equal(typeof saved.generationWindow.generationDayOffset, 'number');
  assert.deepEqual(saved.themes, ['AI']);
  assert.deepEqual(saved.optionalNgWords, ['絶対']);
  assert.deepEqual(Object.keys(saved).sort(), ['approvalMode', 'frequencyTargetPerWeek', 'generationWindow', 'locale', 'notes', 'objective', 'optionalNgWords', 'preferredTone', 'themes']);
  assert.deepEqual(Object.keys(saved.generationWindow).sort(), ['defaultGenerationLocal', 'endLocal', 'generationDayOffset', 'startLocal', 'timezone']);
});
