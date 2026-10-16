import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRequirements, isPlatformRelation, PREFLIGHT_MIGRATION } from './baseline_requirements.ts';

const text = Deno.readTextFileSync(new URL(`../../../${PREFLIGHT_MIGRATION}`, import.meta.url));

test('the Phase 1 preflight is read, not copied: 17 relations, 26 columns, the foreign keys, two helpers, one schema, three roles', () => {
  const requirements = extractRequirements(text);
  assert.equal(requirements.relations.length, 17);
  assert.equal(requirements.columns.length, 26);
  assert.ok(requirements.foreignKeys.length >= 14);
  assert.deepEqual(requirements.functions, ['public.social_mobile_account_deletion_subject(uuid)', 'public.social_mobile_account_deletion_workspace(uuid)']);
  assert.deepEqual(requirements.schemas, ['private']);
  assert.deepEqual(requirements.roles, ['anon', 'authenticated', 'service_role']);
  assert.deepEqual(requirements.relations.filter(isPlatformRelation), ['auth.identities', 'auth.users', 'storage.buckets', 'storage.objects']);
  // every column belongs to a required relation
  for (const column of requirements.columns) assert.ok(requirements.relations.includes(column.relation), column.relation);
  assert.ok(requirements.foreignKeys.some((key) => key.relation === 'public.social_accounts' && key.references === 'public.brands' && key.onDelete === 'a'));
});

test('a preflight that changed shape is an error, never an empty requirement list', () => {
  assert.throws(() => extractRequirements('select 1;'), /expected form/u);
  assert.throws(() => extractRequirements(text.replace("to_regclass(v_name) is null", 'false')), /required relations/u);
});
