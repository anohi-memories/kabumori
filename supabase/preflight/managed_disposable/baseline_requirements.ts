// What the common-account chain needs from the schema it is applied to (F5 Phase 12, extended in Phase 13). SOURCE ONLY, pure.
//
// The sources of truth are the migrations' own preflights, READ here (never copied) so that a changed preflight is a
// changed requirement:
//   * Phase 1 (20261001150000): the relations it requires, the columns it reads (with exact type), the foreign keys it
//     relies on, the helper functions it reuses                                           -> extractRequirements()
//   * later chain files (Phase 13 contract v2): the baseline objects they refuse to apply without. The Phase 13
//     prerequisite oracle (a local database, one baseline object removed at a time) found two that the Phase 12 contract
//     did not cover -- public.ensure_my_profile() (P4) and public.social_accounts.platform (P6) -- and a static audit of
//     every chain preflight found a third, auth.uid() (P3b, P4)                              -> extractChainPrerequisites()
// Provenance classification (who creates each object) is separate (provenance.ts) and uses the repository's migration texts only.
export type RequiredColumn = { relation: string; column: string; type: string };
export type RequiredForeignKey = { relation: string; columns: string[]; references: string; referencedColumns: string[]; onDelete: string };
export type Phase1Requirements = {
  schemas: string[];
  roles: string[];
  relations: string[];
  columns: RequiredColumn[];
  foreignKeys: RequiredForeignKey[];
  functions: string[];
};

/** The version of the baseline contract. A lock or a caller that carries another one is refused (inventory.ts), never reinterpreted. */
export const CONTRACT_VERSION = 2;

/**
 * A function whose SHAPE a chain file checks before it applies (not only that it exists).
 * `replacedBy`: a chain file later REPLACES the function (`create or replace`), and `marker` is a function that file creates.
 * Once the marker exists the function is chain-owned: its security mode and body are the chain's, so only the attributes the
 * chain keeps (kind, language, volatility, owner, return type, settings, ACL) stay in the contract -- which keeps the baseline
 * read-back (G3b) re-runnable before every chain file.
 */
export type RequiredFunctionShape = { signature: string; returns: string; securityDefiner: boolean; replacedBy?: { chainId: string; marker: string } };
/** A function of the managed platform (auth.*) the chain needs: existence and return type only, never owner, body or ACL. */
export type PlatformFunction = { signature: string; returns: string };
/**
 * One baseline object a later chain file needs, and the strength of the evidence:
 *   checked   what the chain file(s) themselves test (the refusal codes in `refusals` are raised when it does not hold)
 *   expected  what the CONTRACT adds on top, on repository evidence rather than on a refusal (null when nothing); the
 *             contract is deliberately stricter than the chain there, and a difference is a STOP, not a guess
 */
export type ChainPrerequisite = {
  kind: 'function_shape' | 'column' | 'platform_function';
  object: string;
  neededBy: string[];
  refusals: string[];
  checked: string;
  expected: string | null;
};
export type Requirements = Phase1Requirements & {
  contractVersion: typeof CONTRACT_VERSION;
  functionShapes: RequiredFunctionShape[];
  platformFunctions: PlatformFunction[];
  prerequisites: ChainPrerequisite[];
};

const PREFLIGHT_FILE = '20261001150000_common_account_lifecycle_foundation.sql';
export const PREFLIGHT_MIGRATION = `supabase/migrations/${PREFLIGHT_FILE}`;

/** Parses the three lists and the schema / role / function checks of the Phase 1 preflight. */
export function extractRequirements(phase1Text: string): Phase1Requirements {
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

// ---- Phase 13: what the later chain files refuse to apply without -------------------------------------------------------

/** The chain files whose preflight names a baseline object the Phase 1 lists do not cover, by chain id. */
export const CHAIN_PREREQUISITE_FILES = {
  P3b: 'supabase/migrations/20261010051938_common_account_service_write_guard.sql',
  P4: 'supabase/migrations/20261012130000_common_account_core_service_fence.sql',
  P6: 'supabase/migrations/20261013120000_common_account_service_deletion_ownership.sql',
} as const;

/**
 * The part of a requirement that no chain file states, and the repository evidence for it. A requirement the preflights
 * name but this table does not know is an ERROR (the extraction never guesses a type).
 */
export const EXPECTATIONS = {
  columns: {
    'public.social_accounts.platform': {
      type: 'text',
      evidence: { file: 'supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql', phrase: "'platform | text | not null | ''x''::text |  | default'" },
      note: 'P6 only requires the column to exist; its code treats it as text (jsonb_object_agg key, jsonb_agg ... order by). The type is the one the G4 multi-provider preflight describes for production; nullability and default stay in the fingerprint, not in the requirement.',
    },
  },
  /** a baseline function a chain file replaces (`create or replace`): the chain file and the function it creates first */
  functionReplacements: {
    'public.ensure_my_profile()': {
      chainId: 'P4',
      marker: 'private.account_lifecycle_service_state_refusal(uuid,text)',
      evidence: { file: 'supabase/migrations/20261012130000_common_account_core_service_fence.sql', phrase: 'create or replace function public.ensure_my_profile()' },
      note: 'P4 replaces the legacy bootstrap by a security-definer wrapper of the Phase 2 start (P9 replaces it again); until P4 has run, the baseline shape (invoker rights) is what P4 checks',
    },
  },
  platformFunctions: {
    'auth.uid()': {
      returns: 'uuid',
      evidence: { file: 'supabase/migrations/20260924100000_ensure_my_profile.sql', phrase: 'v_user_id uuid := (select auth.uid());' },
      note: 'P1 already calls it when it creates a policy or an SQL body, and P3b / P4 refuse without it; the chain compares it with uuid columns (the Phase 13 local run: without it P1 stops with "function auth.uid() does not exist", returning text with "operator does not exist: text = uuid"). Only existence and return type are part of the contract: owner, body and ACL are the platform\'s own business and vary with its version',
    },
  },
} as const;

export type ChainPrerequisites = Pick<Requirements, 'functionShapes' | 'platformFunctions' | 'prerequisites'> & { columns: RequiredColumn[]; functions: string[] };

const stripSqlComments = (text: string) => text.replace(/--[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, ' ');
const merge = <T>(items: T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item])).values()].sort((a, b) => key(a).localeCompare(key(b)));

/**
 * Reads, out of the text of the chain files, the baseline objects they refuse to apply without:
 *   * P4:  `if not exists (select 1 from pg_proc ... proname = 'f' and pronargs = 0 and prorettype = 'T'::regtype [and] [not] prosecdef) then raise exception 'C'`
 *   * P3b, P4: `to_regprocedure('auth.f()') is null then raise exception 'C'`
 *   * P6:  `not exists (select 1 from pg_attribute a where a.attrelid = 'public.r'::regclass and a.attname in ('c') and not a.attisdropped) then raise exception 'C'`
 * A preflight that no longer has one of these forms is an error, never an empty list; a relation that is not a Phase 1 baseline
 * relation (the chain's own private tables) is not a baseline requirement.
 */
export function extractChainPrerequisites(read: (path: string) => string, phase1: Phase1Requirements): ChainPrerequisites {
  const text = (id: keyof typeof CHAIN_PREREQUISITE_FILES) => stripSqlComments(read(CHAIN_PREREQUISITE_FILES[id]));
  const file = (id: keyof typeof CHAIN_PREREQUISITE_FILES) => CHAIN_PREREQUISITE_FILES[id].split('/').pop() as string;
  const prerequisites: ChainPrerequisite[] = [];

  // ---- function shapes (P4)
  const shapes: RequiredFunctionShape[] = [];
  const shapePattern = /if not exists \(select 1 from pg_proc p join pg_namespace n on n\.oid = p\.pronamespace\s+where n\.nspname = '([a-z_]+)' and p\.proname = '([a-z_0-9]+)'\s+and p\.pronargs = (\d+) and p\.prorettype = '([a-z0-9_]+)'::regtype( and not p\.prosecdef| and p\.prosecdef)\)\s+then\s+raise exception '([A-Z0-9_]+)'/gu;
  for (const match of text('P4').matchAll(shapePattern)) {
    const [, schema, name, args, returns, security, refusal] = match;
    if (Number(args) !== 0) throw new Error(`the P4 preflight checks ${schema}.${name} with ${args} argument(s): its argument types are not stated, so no signature can be built`);
    const signature = `${schema}.${name}()`;
    const invoker = security.includes('not');
    // does a chain file (here: P4 itself) replace the function after checking it? Then the marker says when it is chain-owned.
    const replacement = (EXPECTATIONS.functionReplacements as Record<string, { chainId: string; marker: string; note: string }>)[signature];
    const replaces = new RegExp(`create\\s+or\\s+replace\\s+function\\s+${schema}\\.${name}\\s*\\(\\s*\\)`, 'u').test(text('P4'));
    if (replaces && !replacement) throw new Error(`P4 replaces ${signature} but EXPECTATIONS.functionReplacements has no marker for it: the baseline read-back could not tell the baseline from the chain's version`);
    shapes.push({ signature, returns, securityDefiner: !invoker, ...(replaces && replacement ? { replacedBy: { chainId: replacement.chainId, marker: replacement.marker } } : {}) });
    prerequisites.push({
      kind: 'function_shape', object: signature, neededBy: [`P4 ${file('P4')}`], refusals: [refusal],
      checked: `exists with no argument, returns ${returns}, ${invoker ? 'invoker rights (not security definer)' : 'security definer'}`,
      expected: replaces && replacement ? `only until ${replacement.chainId} has run (its marker ${replacement.marker} exists): ${replacement.note}` : null,
    });
  }
  if (shapes.length === 0) throw new Error('the P4 preflight no longer has its function-shape check (ensure_my_profile) in the expected form');

  // ---- platform functions (P3b, P4)
  const platformFunctions: PlatformFunction[] = [];
  for (const id of ['P3b', 'P4'] as const) {
    const found = [...text(id).matchAll(/to_regprocedure\('(auth\.[a-z_]+\(\))'\) is null\s+then\s+raise exception '([A-Z0-9_]+)'/gu)];
    if (found.length === 0) throw new Error(`the ${id} preflight no longer has its auth function check in the expected form`);
    for (const [, signature, refusal] of found) {
      const expected = (EXPECTATIONS.platformFunctions as Record<string, { returns: string; note: string }>)[signature];
      if (!expected) throw new Error(`${id} requires ${signature}, which has no recorded return type: add it to EXPECTATIONS.platformFunctions with its repository evidence`);
      platformFunctions.push({ signature, returns: expected.returns });
      prerequisites.push({
        kind: 'platform_function', object: signature, neededBy: [`${id} ${file(id)}`], refusals: [refusal],
        checked: 'exists', expected: `returns ${expected.returns} -- ${expected.note}`,
      });
    }
  }

  // ---- columns of baseline relations (P6)
  const columns: RequiredColumn[] = [];
  const columnPattern = /not exists \(select 1 from pg_attribute a where a\.attrelid = '([a-z_]+\.[a-z_]+)'::regclass\s+and a\.attname in \(((?:\s*'[a-z_]+'\s*,?)+)\) and not a\.attisdropped\)\s*then\s+raise exception '([A-Z0-9_]+)'/gu;
  for (const match of text('P6').matchAll(columnPattern)) {
    const [, relation, names, refusal] = match;
    if (!phase1.relations.includes(relation)) continue; // the chain's own private tables are not baseline
    for (const [, column] of names.matchAll(/'([a-z_]+)'/gu)) {
      const key = `${relation}.${column}`;
      const expected = (EXPECTATIONS.columns as Record<string, { type: string; note: string }>)[key];
      if (!expected) throw new Error(`P6 requires ${key}, which has no recorded type: add it to EXPECTATIONS.columns with its repository evidence`);
      if (!phase1.columns.some((c) => c.relation === relation && c.column === column)) columns.push({ relation, column, type: expected.type });
      prerequisites.push({
        kind: 'column', object: key, neededBy: [`P6 ${file('P6')}`], refusals: [refusal],
        checked: 'exists (not dropped)', expected: `type ${expected.type} -- ${expected.note}`,
      });
    }
  }
  if (!prerequisites.some((p) => p.kind === 'column')) throw new Error('the P6 preflight no longer has its baseline column check (social_accounts.platform) in the expected form');

  return {
    columns: merge(columns, (c) => `${c.relation}.${c.column}`),
    functions: merge(shapes.map((s) => s.signature), (s) => s),
    functionShapes: merge(shapes, (s) => s.signature),
    platformFunctions: merge(platformFunctions, (f) => f.signature),
    // one entry per object; the files that need it, and the refusals they raise, are listed together
    prerequisites: merge(prerequisites, (p) => `${p.kind} ${p.object}`).map((p) => {
      const same = prerequisites.filter((q) => q.kind === p.kind && q.object === p.object);
      return { ...p, neededBy: [...new Set(same.flatMap((q) => q.neededBy))].sort(), refusals: [...new Set(same.flatMap((q) => q.refusals))].sort() };
    }),
  };
}

/** The Phase 1 lists plus the Phase 13 prerequisites: the whole baseline contract (version 2), read out of the migration texts. */
export function buildRequirements(read: (path: string) => string): Requirements {
  const phase1 = extractRequirements(read(PREFLIGHT_MIGRATION));
  const extra = extractChainPrerequisites(read, phase1);
  const byColumn = (a: RequiredColumn, b: RequiredColumn) => `${a.relation}.${a.column}`.localeCompare(`${b.relation}.${b.column}`);
  return {
    ...phase1,
    functions: [...new Set([...phase1.functions, ...extra.functions])].sort(),
    columns: [...phase1.columns, ...extra.columns].sort(byColumn),
    contractVersion: CONTRACT_VERSION,
    functionShapes: extra.functionShapes,
    platformFunctions: extra.platformFunctions,
    prerequisites: extra.prerequisites,
  };
}

/** True for a requirements object of the current contract version with every Phase 13 field present. */
export const isCurrentContract = (value: Partial<Requirements>): value is Requirements =>
  value.contractVersion === CONTRACT_VERSION && Array.isArray(value.functionShapes) && Array.isArray(value.platformFunctions) && Array.isArray(value.prerequisites);
