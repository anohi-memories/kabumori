// What the common-account chain needs from the schema it is applied to (F5 Phase 12). SOURCE ONLY, pure.
//
// The single source of truth is the Phase 1 migration's own preflight: the relations it requires, the column it reads
// (with exact type), the foreign keys it relies on, the helper functions it reuses. This module reads those lists OUT of
// the migration text, so a changed preflight is a changed requirement, never a stale copy. Provenance classification
// (who creates each object) is separate (provenance.ts) and uses the repository's migration texts only.
export type RequiredColumn = { relation: string; column: string; type: string };
export type RequiredForeignKey = { relation: string; columns: string[]; references: string; referencedColumns: string[]; onDelete: string };
export type Requirements = {
  schemas: string[];
  roles: string[];
  relations: string[];
  columns: RequiredColumn[];
  foreignKeys: RequiredForeignKey[];
  functions: string[];
};

const PREFLIGHT_FILE = '20261001150000_common_account_lifecycle_foundation.sql';
export const PREFLIGHT_MIGRATION = `supabase/migrations/${PREFLIGHT_FILE}`;

/** Parses the three lists and the schema / role / function checks of the Phase 1 preflight. */
export function extractRequirements(phase1Text: string): Requirements {
  const text = phase1Text.replace(/--[^\n]*/gu, '');
  const blocks = [...text.matchAll(/jsonb_array_elements\('(\[[\s\S]*?\])'::jsonb\)/gu)].map((m) => JSON.parse(m[1]) as Record<string, unknown>[]);
  const columnBlock = blocks.find((block) => block.every((item) => 'c' in item && typeof item.c === 'string' && 'type' in item));
  const keyBlock = blocks.find((block) => block.every((item) => Array.isArray(item.c) && 'r' in item));
  if (!columnBlock || !keyBlock) throw new Error('the Phase 1 preflight no longer has its column / foreign-key lists in the expected form');

  const relationList = /foreach v_name in array array\[((?:\s*'[a-z_]+\.[a-z_]+'\s*,?)+)\s*\]\s*loop\s*if to_regclass\(v_name\) is null/u.exec(text);
  if (!relationList) throw new Error('the Phase 1 preflight no longer lists its required relations in the expected form');
  const relations = [...relationList[1].matchAll(/'([a-z_]+\.[a-z_]+)'/gu)].map((m) => m[1]);

  const roles = [...new Set([...text.matchAll(/foreach v_name in array array\[((?:\s*'[a-z_]+'\s*,?)+)\s*\]\s*loop\s*if not exists \(select 1 from pg_roles/gu)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/gu)].map((x) => x[1])))];
  const schemas = [...text.matchAll(/to_regnamespace\('([a-z_]+)'\) is null/gu)].map((m) => m[1]);
  const functions = [...text.matchAll(/'(public\.[a-z_]+\([a-z, ]*\))'/gu)].map((m) => m[1]);

  return {
    schemas: [...new Set(schemas)].sort(),
    roles: roles.sort(),
    relations: [...relations].sort(),
    columns: (columnBlock as { t: string; c: string; type: string }[]).map((item) => ({ relation: item.t, column: item.c, type: item.type }))
      .sort((a, b) => `${a.relation}.${a.column}`.localeCompare(`${b.relation}.${b.column}`)),
    foreignKeys: (keyBlock as { t: string; c: string[]; r: string; rc: string[]; del: string }[]).map((item) => ({
      relation: item.t, columns: item.c, references: item.r, referencedColumns: item.rc, onDelete: item.del,
    })).sort((a, b) => `${a.relation}.${a.columns.join(',')}`.localeCompare(`${b.relation}.${b.columns.join(',')}`)),
    functions: [...new Set(functions)].sort(),
  };
}

/** Objects of the lifecycle chain that its OTHER files take from outside (the Phase 3b / 9 preflights read auth.sessions). */
export const ADDITIONAL_PLATFORM_REQUIREMENTS = [
  { relation: 'auth.sessions', column: 'id', type: 'uuid', neededBy: '20261010051938, 20261015090000' },
  { relation: 'auth.sessions', column: 'user_id', type: 'uuid', neededBy: '20261010051938, 20261015090000' },
  { relation: 'auth.sessions', column: 'not_after', type: 'timestamp with time zone', neededBy: '20261010051938, 20261015090000' },
] as const;

export const isPlatformRelation = (name: string) => /^(auth|storage|vault|extensions)\./u.test(name);
