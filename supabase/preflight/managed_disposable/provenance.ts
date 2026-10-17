// Provenance of every schema object the common-account chain needs (F5 Phase 12). SOURCE ONLY.
//
// Question: for each object the Phase 1 preflight requires, WHO creates it, and what in the repository supports that
// claim? Four classes, and nothing is invented for the ones the repository cannot answer:
//
//   platform_managed          auth.* / storage.* / the API roles: created by Supabase, never by this repository; their
//                             shape is only assumed by the fixtures and is read back in a project by the release probe
//   repository_created        a reviewed migration of this repository creates it
//   repository_altered_only   migrations ALTER it but none CREATEs it: the object came from outside the repository
//   absent_from_repository    no migration creates or alters it
//
// The last two are the UNKNOWN BASELINE. They are never synthesized here and never filled in by a fixture: a staging
// run is not ready while any of them lacks an approved production inventory (readiness.ts).
import type { Requirements } from './baseline_requirements.ts';
import { isPlatformRelation } from './baseline_requirements.ts';

export type ObjectClass = 'platform_managed' | 'repository_created' | 'repository_altered_only' | 'absent_from_repository';
export type RelationProvenance = {
  name: string;
  class: ObjectClass;
  createdBy: string[];
  alteredBy: string[];
};
export type FunctionProvenance = { signature: string; class: Exclude<ObjectClass, 'platform_managed'>; createdBy: string[] };

const version = (file: string) => file.slice(0, 14);
const stripComments = (text: string) => text.replace(/--[^\n]*/gu, '').replace(/\/\*[\s\S]*?\*\//gu, ' ');
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function relationProvenance(name: string, migrations: Record<string, string>): RelationProvenance {
  if (isPlatformRelation(name)) return { name, class: 'platform_managed', createdBy: [], alteredBy: [] };
  const [schema, bare] = name.split('.');
  const qualified = `(?:${escape(schema)}\\.)?${escape(bare)}`;
  const create = new RegExp(`\\bcreate\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${qualified}\\b`, 'iu');
  const alter = new RegExp(`\\balter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?${qualified}\\b`, 'iu');
  const createdBy: string[] = [];
  const alteredBy: string[] = [];
  for (const [file, text] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
    const code = stripComments(text);
    if (create.test(code)) createdBy.push(version(file));
    else if (alter.test(code)) alteredBy.push(version(file));
  }
  const klass: ObjectClass = createdBy.length > 0 ? 'repository_created' : alteredBy.length > 0 ? 'repository_altered_only' : 'absent_from_repository';
  return { name, class: klass, createdBy, alteredBy };
}

export function functionProvenance(signature: string, migrations: Record<string, string>): FunctionProvenance {
  const bare = signature.slice(0, signature.indexOf('('));
  const [schema, name] = bare.split('.');
  const create = new RegExp(`\\bcreate\\s+(?:or\\s+replace\\s+)?function\\s+(?:${escape(schema)}\\.)?${escape(name)}\\s*\\(`, 'iu');
  const createdBy = Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b)).filter(([, text]) => create.test(stripComments(text))).map(([file]) => version(file));
  return { signature, class: createdBy.length > 0 ? 'repository_created' : 'absent_from_repository', createdBy };
}

export function classify(requirements: Requirements, migrations: Record<string, string>) {
  return {
    relations: requirements.relations.map((name) => relationProvenance(name, migrations)),
    functions: requirements.functions.map((signature) => functionProvenance(signature, migrations)),
    // the schema and the roles: only the schema can be created by a migration, the roles never are
    schemas: requirements.schemas.map((name) => {
      const created = Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))
        .filter(([, text]) => new RegExp(`\\bcreate\\s+schema\\s+(?:if\\s+not\\s+exists\\s+)?${escape(name)}\\b`, 'iu').test(stripComments(text))).map(([file]) => version(file));
      return { name, class: (created.length > 0 ? 'repository_created' : 'absent_from_repository') as ObjectClass, createdBy: created };
    }),
    roles: requirements.roles.map((name) => ({ name, class: 'platform_managed' as ObjectClass })),
    // functions of the managed platform the chain needs (auth.uid()): created by Supabase, never by this repository
    platformFunctions: (requirements.platformFunctions ?? []).map((fn) => ({ signature: fn.signature, returns: fn.returns, class: 'platform_managed' as ObjectClass })),
  };
}

// ---- the database half: what a world holds ------------------------------------------------------------------------------

export type WorldColumn = { relation: string; column: string; type: string };
export type WorldFacts = {
  relations: string[];
  columns: WorldColumn[];
  foreignKeys: string[];
  functions: string[];
};
export type ColumnProvenance = {
  relation: string;
  column: string;
  type: string;
  /** where the column is seen: the fixture world (F), the migration-replay world (M) */
  inFixture: boolean;
  inMigrations: boolean;
  /**
   * `fixture_only` / `neither` = UNKNOWN BASELINE (only a fixture knows the column, or nobody does);
   * `blocked_replay` = a repository migration creates the relation but the replay could not build it (it needs an unknown
   * object): not unknown in itself, and not verified either
   */
  source: 'migrations' | 'fixture_only' | 'platform_assumed' | 'blocked_replay' | 'neither';
  typeDiffers: boolean;
};

export function compareColumns(requirements: Pick<Requirements, 'columns'>, fixture: WorldFacts, replay: WorldFacts, createdByRepository: ReadonlySet<string> = new Set()): ColumnProvenance[] {
  const index = (facts: WorldFacts) => new Map(facts.columns.map((c) => [`${c.relation}.${c.column}`, c.type]));
  const f = index(fixture);
  const m = index(replay);
  return requirements.columns.map((required) => {
    const key = `${required.relation}.${required.column}`;
    const inFixture = f.get(key) === required.type;
    const inMigrations = m.get(key) === required.type;
    const platform = isPlatformRelation(required.relation);
    const blocked = !platform && !inMigrations && createdByRepository.has(required.relation) && !replay.relations.includes(required.relation);
    const source = platform ? 'platform_assumed' : inMigrations ? 'migrations' : blocked ? 'blocked_replay' : inFixture ? 'fixture_only' : 'neither';
    return {
      relation: required.relation, column: required.column, type: required.type, inFixture, inMigrations, source,
      typeDiffers: (f.has(key) && f.get(key) !== required.type) || (m.has(key) && m.get(key) !== required.type),
    } satisfies ColumnProvenance;
  });
}

/** Columns that exist in the fixture world on a relation the repository does not fully create, and nowhere else. */
export function fixtureOnlyColumns(relations: string[], fixture: WorldFacts, replay: WorldFacts): WorldColumn[] {
  const replayKeys = new Set(replay.columns.map((c) => `${c.relation}.${c.column}`));
  return fixture.columns
    .filter((c) => relations.includes(c.relation) && !replayKeys.has(`${c.relation}.${c.column}`))
    .sort((a, b) => `${a.relation}.${a.column}`.localeCompare(`${b.relation}.${b.column}`));
}

export type ReplayResult = { file: string; applied: boolean; error: string | null };

export type Provenance = {
  version: 1;
  requirements: Requirements;
  relations: (RelationProvenance & { inFixture: boolean; inReplay: boolean })[];
  functions: (FunctionProvenance & { inFixture: boolean; inReplay: boolean })[];
  schemas: { name: string; class: ObjectClass; createdBy: string[] }[];
  roles: { name: string; class: ObjectClass }[];
  platformFunctions: { signature: string; returns: string; class: ObjectClass }[];
  columns: ColumnProvenance[];
  foreignKeys: { key: string; inFixture: boolean; inReplay: boolean; touchesUnknown: boolean }[];
  /** columns of the gap relations that only the fixtures define: not reconstructed, listed */
  fixtureOnlyColumns: WorldColumn[];
  replay: ReplayResult[];
  /** the unknown baseline, derived (never typed in) */
  unknown: {
    relations: string[];
    columns: string[];
    foreignKeys: string[];
    functions: string[];
  };
  /** relations a repository migration creates that the replay on a bare platform could not produce (it needs something unknown or platform-specific) */
  createdButNotReplayable: string[];
  /** the schema inventory (inventory/schema_inventory.sql) run over the two LOCAL worlds and checked against the requirements */
  inventory?: InventoryEvidence;
};
export type InventoryEvidence = {
  /** SHA-256 of the query file: a changed query is new evidence */
  querySha256: string;
  worlds: Record<'fixture' | 'replay', {
    lines: number;
    byKind: Record<string, number>;
    /** requirement findings: what the inventory of this world does NOT provide */
    findings: { code: string; subject: string }[];
    contractItems: number;
    contractDigest: string;
  }>;
};

const fkKey = (fk: Requirements['foreignKeys'][number]) => `${fk.relation}(${fk.columns.join(',')})->${fk.references}(${fk.referencedColumns.join(',')}) on delete ${fk.onDelete}`;

export function buildProvenance(
  requirements: Requirements, migrations: Record<string, string>, fixture: WorldFacts, replay: WorldFacts, replayResults: ReplayResult[],
): Provenance {
  const classified = classify(requirements, migrations);
  const relations = classified.relations.map((r) => ({ ...r, inFixture: fixture.relations.includes(r.name), inReplay: replay.relations.includes(r.name) }));
  const functions = classified.functions.map((fn) => ({ ...fn, inFixture: fixture.functions.includes(fn.signature), inReplay: replay.functions.includes(fn.signature) }));
  const created = new Set(relations.filter((r) => r.class === 'repository_created').map((r) => r.name));
  const columns = compareColumns(requirements, fixture, replay, created);
  const unknownRelations = relations.filter((r) => r.class === 'absent_from_repository' || r.class === 'repository_altered_only').map((r) => r.name);
  const foreignKeys = requirements.foreignKeys.map((fk) => ({
    key: fkKey(fk), inFixture: fixture.foreignKeys.includes(fkKey(fk)), inReplay: replay.foreignKeys.includes(fkKey(fk)),
    // a key that touches an unknown relation is itself unknown; a key of a relation the replay could not build is "blocked"
    touchesUnknown: unknownRelations.includes(fk.relation) || unknownRelations.includes(fk.references),
  }));
  const blocked = relations.filter((r) => r.class === 'repository_created' && !r.inReplay).map((r) => r.name);
  return {
    version: 1,
    requirements,
    relations,
    functions,
    schemas: classified.schemas,
    roles: classified.roles,
    platformFunctions: classified.platformFunctions,
    columns,
    foreignKeys,
    fixtureOnlyColumns: fixtureOnlyColumns(unknownRelations, fixture, replay),
    replay: replayResults,
    unknown: {
      relations: unknownRelations.sort(),
      columns: columns.filter((c) => c.source === 'fixture_only' || c.source === 'neither').map((c) => `${c.relation}.${c.column}`).sort(),
      foreignKeys: foreignKeys.filter((k) => k.touchesUnknown).map((k) => k.key).sort(),
      functions: functions.filter((f) => f.class === 'absent_from_repository').map((f) => f.signature).sort(),
    },
    createdButNotReplayable: blocked.sort(),
  };
}
