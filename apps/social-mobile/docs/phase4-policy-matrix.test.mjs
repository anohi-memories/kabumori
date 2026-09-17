import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../');
const migration = await readFile(resolve(root, 'supabase/migrations/20260918120000_social_mobile_brand_memberships.sql'), 'utf8');
const contract = await readFile(resolve(root, 'apps/social-mobile/docs/phase4-membership-rls-contract.md'), 'utf8');

test('membership schema has tenant-safe primary key and role check', () => {
  assert.match(migration, /primary key \(brand_id, user_id\)/u);
  assert.match(migration, /role in \('owner', 'admin', 'member', 'viewer'\)/u);
  assert.match(migration, /references public\.brands\(id\)/u);
  assert.match(migration, /references auth\.users\(id\)/u);
});

test('each operational table has a membership-scoped select policy', () => {
  for (const [table, relation] of [['brands', 'brands.id'], ['social_accounts', 'social_accounts.brand_id'], ['scheduled_posts', 'scheduled_posts.brand_id'], ['post_execution_logs', 'post_execution_logs.brand_id'], ['posting_windows', 'posting_windows.brand_id']]) {
    assert.match(migration, new RegExp(`social_mobile_member_select_${table}`, 'u'));
    assert.match(migration, new RegExp(`bm\\.brand_id = ${relation.replace('.', '\\.')}`, 'u'));
  }
});

test('membership writes are not granted to mobile roles', () => {
  assert.match(migration, /revoke insert, update, delete on table public\.brand_memberships from anon, authenticated/u);
  assert.match(migration, /grant select on table public\.brand_memberships to authenticated/u);
});

test('contract explicitly covers cross-tenant and anonymous isolation', () => {
  assert.match(contract, /anon.*0/u);
  assert.match(contract, /authenticated non-member.*0/u);
  assert.match(contract, /A member.*Bの行/u);
});

test('production application remains out of scope', () => {
  assert.match(migration, /review-only/u);
  assert.match(contract, /production未適用/u);
});
