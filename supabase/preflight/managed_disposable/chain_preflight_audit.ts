// A static audit (F5 Phase 13): every baseline object that a chain file's own text names in a catalog test is covered by the
// baseline contract. SOURCE ONLY and pure: it reads the chain files' text and the Requirements, nothing else.
//
// Why it exists: the Phase 12 contract was extracted from ONE preflight (Phase 1). The Phase 13 oracle (a local database, one
// object removed at a time) found two baseline objects a later file refuses without; this audit looks at the same question
// from the other side -- the text -- and found a third (auth.uid()). It is a regression guard: a future chain file that names
// a new baseline object in a catalog test makes `uncovered()` non-empty until the contract learns about it.
//
// What it sees:  to_regclass('x.y'), to_regprocedure('f(...)'), 'x.y'::regclass, 'f(...)'::regprocedure,
//                has_function_privilege / has_table_privilege with a literal object, `nspname = 's' and proname = 'f'`,
//                `attrelid = 'x.y'::regclass ... attname = 'c' | in ('c', ...)`.
// What it does NOT see (the oracle and the managed run cover these): objects used only inside function bodies (late bound),
// catalog tests built from variables, and the TYPE / default / grants of an object that is named.
import type { Requirements } from './baseline_requirements.ts';
import { ADDITIONAL_PLATFORM_REQUIREMENTS } from './baseline_requirements.ts';
import { normalize, scanSql } from './sql_scan.ts';

export type AuditReference = { file: string; kind: 'relation' | 'function' | 'column'; object: string; internal: boolean; covered: boolean };

const strip = (sql: string) => normalize(sql).text.replace(/--[^\n]*/gu, '');
const bareName = (signature: string) => signature.replace(/\s+/gu, '').replace(/\(.*$/u, '');
const created = (sql: string) => [...strip(sql).toLowerCase().matchAll(/\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gu)].map((match) => match[1]);

/**
 * All baseline references of the chain files, each marked internal and covered. `files` is in RELEASE ORDER. A relation is
 * internal when a chain file at or before the referencing one creates it. A function is internal when an EARLIER file
 * defines it (in any form), or the referencing file itself creates it with a plain `create function`: a same-file
 * `create or replace function` replaces something that already exists, so that something is a baseline object (this is how
 * ensure_my_profile() shows up: P4 replaces it after checking its shape).
 */
export function auditChainPreflights(files: Record<string, string>, requirements: Requirements): AuditReference[] {
  const order = Object.keys(files);
  const relationsCreatedAt = new Map<string, number>();
  const functionsDefinedAt = new Map<string, number>();
  const functionsCreatedAt = new Map<string, number>();
  order.forEach((file, index) => {
    const sql = files[file];
    for (const name of created(sql)) if (!relationsCreatedAt.has(name)) relationsCreatedAt.set(name, index);
    for (const fn of scanSql(sql).definedFunctions) if (!functionsDefinedAt.has(fn.name.toLowerCase())) functionsDefinedAt.set(fn.name.toLowerCase(), index);
    for (const m of strip(sql).toLowerCase().matchAll(/\bcreate\s+function\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/gu)) if (!functionsCreatedAt.has(m[1])) functionsCreatedAt.set(m[1], index);
  });
  const coveredRelations = new Set([...requirements.relations, ...ADDITIONAL_PLATFORM_REQUIREMENTS.map((item) => item.relation)]);
  const coveredFunctions = new Set([...requirements.functions, ...(requirements.platformFunctions ?? []).map((fn) => fn.signature)].map(bareName));
  const coveredColumns = new Set([
    ...requirements.columns.map((c) => `${c.relation}.${c.column}`), ...ADDITIONAL_PLATFORM_REQUIREMENTS.map((c) => `${c.relation}.${c.column}`),
    ...requirements.foreignKeys.flatMap((key) => [...key.columns.map((c) => `${key.relation}.${c}`), ...key.referencedColumns.map((c) => `${key.references}.${c}`)]),
  ]);
  const out: AuditReference[] = [];
  const seen = new Set<string>();
  const add = (file: string, at: number, kind: AuditReference['kind'], object: string) => {
    const name = file.split('/').pop() as string;
    const key = `${name}|${kind}|${object}`;
    if (seen.has(key)) return;
    seen.add(key);
    const relationInternal = (relation: string) => (relationsCreatedAt.get(relation) ?? Infinity) <= at;
    if (kind === 'relation') out.push({ file: name, kind, object, internal: relationInternal(object), covered: coveredRelations.has(object) });
    else if (kind === 'function') {
      const bare = bareName(object);
      out.push({ file: name, kind, object, internal: (functionsDefinedAt.get(bare) ?? Infinity) < at || (functionsCreatedAt.get(bare) ?? Infinity) <= at, covered: coveredFunctions.has(bare) });
    } else out.push({ file: name, kind, object, internal: relationInternal(object.slice(0, object.lastIndexOf('.'))), covered: coveredColumns.has(object) });
  };
  order.forEach((file, at) => {
    const text = strip(files[file]);
    for (const m of text.matchAll(/to_regclass\('([a-z_]+\.[a-z_]+)'\)/gu)) add(file, at, 'relation', m[1]);
    for (const m of text.matchAll(/'([a-z_]+\.[a-z_]+)'::regclass/gu)) add(file, at, 'relation', m[1]);
    for (const m of text.matchAll(/to_regprocedure\('([a-z_]+\.[a-z_0-9]+\([a-z_, ]*\))'\)/gu)) add(file, at, 'function', m[1]);
    for (const m of text.matchAll(/'([a-z_]+\.[a-z_0-9]+\([a-z_, ]*\))'::regprocedure/gu)) add(file, at, 'function', m[1]);
    for (const m of text.matchAll(/has_function_privilege\([^,()]+(?:\([^)]*\))?\s*,\s*'([a-z_]+\.[a-z_0-9]+\([a-z_, ]*\))'/gu)) add(file, at, 'function', m[1]);
    for (const m of text.matchAll(/has_table_privilege\([^,()]+(?:\([^)]*\))?\s*,\s*'([a-z_]+\.[a-z_]+)'/gu)) add(file, at, 'relation', m[1]);
    for (const m of text.matchAll(/n\.nspname\s*=\s*'([a-z_]+)'\s+and\s+p\.proname\s*=\s*'([a-z_0-9]+)'/gu)) add(file, at, 'function', `${m[1]}.${m[2]}()`);
    for (const m of text.matchAll(/a\.attrelid\s*=\s*'([a-z_]+\.[a-z_]+)'::regclass\s+and\s+a\.attname\s*(?:=\s*'([a-z_]+)'|in\s*\(((?:\s*'[a-z_]+'\s*,?)+)\))/gu)) {
      const columns = m[2] ? [m[2]] : [...m[3].matchAll(/'([a-z_]+)'/gu)].map((x) => x[1]);
      for (const column of columns) add(file, at, 'column', `${m[1]}.${column}`);
    }
  });
  return out.sort((a, b) => `${a.kind} ${a.object} ${a.file}`.localeCompare(`${b.kind} ${b.object} ${b.file}`));
}

/** The references the contract does not cover and no chain file creates: each one is a gap in the baseline contract. */
export const uncovered = (references: readonly AuditReference[]) => references.filter((reference) => !reference.internal && !reference.covered);
