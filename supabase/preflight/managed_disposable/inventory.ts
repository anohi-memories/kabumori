// The schema inventory (F5 Phase 12, BG1). SOURCE ONLY, pure functions: nothing here connects to a database or reads a
// file. `inventory/schema_inventory.sql` produces the lines; this module is what an operator (or the plan's G3b step)
// does with them:
//   * parse and VALIDATE them against a closed attribute list per kind (an unexpected field is a STOP, so a changed
//     query cannot start to leak a value without a reviewer seeing the list change),
//   * scan them for secret-shaped text (defence in depth: the query is meant to emit none),
//   * canonicalise them and take a digest (deterministic: the same schema is the same bytes),
//   * cut the CONTRACT SUBSET -- exactly what the common-account chain needs from the baseline, nothing else,
//   * check the subset against the requirements the Phase 1 preflight states, and compare its digest with the digest
//     the owner approved. Any difference is a STOP; nothing is repaired or synthesised.
import { ADDITIONAL_PLATFORM_REQUIREMENTS, isPlatformRelation, type Requirements } from './baseline_requirements.ts';
import { normalize, splitStatements } from './sql_scan.ts';

export const KINDS = [
  'meta', 'schema', 'extension', 'role', 'membership', 'relation', 'column', 'constraint', 'index', 'trigger', 'function',
  'policy', 'type', 'view_reference', 'event_trigger', 'publication', 'foreign_data_wrapper', 'foreign_server',
  'user_mapping', 'setting_scope', 'default_acl', 'language',
] as const;
export type Kind = (typeof KINDS)[number];
export type Line = { k: Kind; key: string; a: Record<string, unknown> };

/** The closed attribute list of every kind. The SQL file and this table are checked against each other by a local run. */
export const ATTRIBUTES: Readonly<Record<Kind, readonly string[]>> = {
  meta: ['format', 'server_major'],
  schema: ['scope', 'owner', 'acl'],
  extension: ['schema', 'version', 'owner', 'members'],
  role: ['superuser', 'inherit', 'createrole', 'createdb', 'login', 'replication', 'bypassrls', 'connlimit'],
  membership: ['member', 'role', 'admin', 'inherit', 'set'],
  relation: ['schema', 'relkind', 'owner', 'persistence', 'rls', 'rls_forced', 'partition', 'options', 'acl', 'def_shape', 'def_sha256', 'bound_sha256', 'sequence', 'foreign_server', 'foreign_option_keys'],
  column: ['rel', 'ord', 'type', 'notnull', 'generated', 'identity', 'default_shape', 'default_sha256', 'acl'],
  constraint: ['rel', 'type', 'validated', 'deferrable', 'deferred', 'def_shape', 'def_sha256', 'fk'],
  index: ['rel', 'unique', 'primary', 'valid', 'ready', 'method', 'def_shape', 'def_sha256'],
  trigger: ['rel', 'enabled', 'function', 'def_shape', 'def_sha256'],
  function: ['schema', 'kind', 'language', 'security_definer', 'volatility', 'strict', 'leakproof', 'parallel', 'owner', 'returns', 'config', 'acl', 'body_sha256', 'body_length', 'mentions'],
  policy: ['rel', 'command', 'permissive', 'roles', 'using_shape', 'using_sha256', 'check_shape', 'check_sha256'],
  type: ['kind', 'owner', 'labels', 'attributes', 'base', 'notnull', 'default_sha256', 'checks'],
  view_reference: ['view', 'reads'],
  event_trigger: ['event', 'enabled', 'owner', 'function', 'tags'],
  publication: ['owner', 'all_tables', 'insert', 'update', 'delete', 'truncate', 'tables'],
  foreign_data_wrapper: ['owner', 'option_keys'],
  foreign_server: ['wrapper', 'owner', 'option_keys'],
  user_mapping: ['server', 'user', 'option_keys'],
  setting_scope: ['names'],
  default_acl: ['acl'],
  language: ['trusted', 'owner'],
};

export class InventoryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** JSON with every object's keys sorted, so the bytes depend on the content only (jsonb orders keys by length). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Parses the output of the inventory query. Anything that is not one JSON object per line is a STOP (a psql notice, a pager, an error). */
export function parseInventory(text: string): Line[] {
  const lines: Line[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InventoryError('INVENTORY_MALFORMED', `line ${index + 1} is not JSON`);
    }
    const record = parsed as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(record).sort().join(',') !== 'a,k,key') {
      throw new InventoryError('INVENTORY_MALFORMED', `line ${index + 1} is not {k, key, a}`);
    }
    if (typeof record.k !== 'string' || !(KINDS as readonly string[]).includes(record.k)) {
      throw new InventoryError('INVENTORY_UNKNOWN_KIND', `line ${index + 1} has a kind the inventory does not define`);
    }
    if (typeof record.key !== 'string' || record.key === '' || record.a === null || typeof record.a !== 'object' || Array.isArray(record.a)) {
      throw new InventoryError('INVENTORY_MALFORMED', `line ${index + 1} has no key or no attribute object`);
    }
    const identity = `${record.k}\u0000${record.key}`;
    if (seen.has(identity)) throw new InventoryError('INVENTORY_DUPLICATE', `line ${index + 1} repeats ${record.k} ${record.key}`);
    seen.add(identity);
    lines.push({ k: record.k as Kind, key: record.key, a: record.a as Record<string, unknown> });
  }
  if (!lines.some((line) => line.k === 'meta')) throw new InventoryError('INVENTORY_INCOMPLETE', 'no meta line: the query did not run to its end');
  return lines;
}

export type Finding = { code: string; subject: string; detail: string };

const SHA256 = /^[0-9a-f]{64}$/u;

/** Structural validation: closed attribute lists, hashes are hashes, shapes carry no literal, only search_path keeps a value. */
export function validateShape(lines: readonly Line[]): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, line: Line, detail: string) => findings.push({ code, subject: `${line.k} ${line.key}`.slice(0, 160), detail });
  for (const line of lines) {
    const allowed = ATTRIBUTES[line.k];
    for (const name of Object.keys(line.a)) {
      if (!allowed.includes(name)) add('UNEXPECTED_ATTRIBUTE', line, `attribute ${name} is not part of the ${line.k} contract`);
    }
    for (const name of allowed) {
      if (!(name in line.a)) add('MISSING_ATTRIBUTE', line, `attribute ${name} is absent`);
    }
    for (const [name, value] of Object.entries(line.a)) {
      if (name.endsWith('_sha256') && value !== null && !(typeof value === 'string' && SHA256.test(value))) add('NOT_A_HASH', line, `${name} is not a SHA-256`);
      if (name.endsWith('_shape') && typeof value === 'string') {
        const rest = value.replaceAll("'?'", '');
        if (rest.includes("'")) add('UNMASKED_LITERAL', line, `${name} carries a string literal`);
        if (/\$[A-Za-z_0-9]*\$/u.test(rest)) add('UNMASKED_LITERAL', line, `${name} carries a dollar-quoted literal`);
      }
    }
    if (line.k === 'function') {
      const config = line.a.config as Record<string, unknown> | null;
      for (const [name, value] of Object.entries(config ?? {})) {
        if (name !== 'search_path' && value !== '<redacted>') add('UNREDACTED_SETTING', line, `function setting ${name} is not redacted`);
      }
    }
    if (line.k === 'setting_scope' || line.k === 'foreign_data_wrapper' || line.k === 'foreign_server' || line.k === 'user_mapping') {
      const names = (line.a.names ?? line.a.option_keys) as unknown;
      if (!Array.isArray(names) || !names.every((name) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/u.test(name))) {
        add('SETTING_NAME_SHAPE', line, 'a setting / option name is not a plain name (a value may have been included)');
      }
    }
  }
  return findings;
}

/** Secret-shaped text anywhere in the raw output. The query emits none; this is the second lock on the same door. */
const SECRET_PATTERNS: readonly { code: string; pattern: RegExp }[] = [
  { code: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/u },
  { code: 'SUPABASE_KEY', pattern: /\bsb_(secret|publishable)_[A-Za-z0-9_-]{6,}/u },
  { code: 'CONNECTION_STRING', pattern: /\bpostgres(?:ql)?:\/\/[^\s"']+/iu },
  { code: 'URL', pattern: /\bhttps?:\/\/[^\s"']+/iu },
  { code: 'SUPABASE_HOST', pattern: /\b[a-z0-9]{20}\.supabase\.(co|in|net)\b/iu },
  { code: 'PRIVATE_KEY', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { code: 'AWS_KEY', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { code: 'LONG_TOKEN', pattern: /\b(?:sk|pk|rk|xox[abp])[-_][A-Za-z0-9_-]{16,}/u },
  { code: 'BEARER', pattern: /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/iu },
];
export function secretFindings(text: string): Finding[] {
  const found: Finding[] = [];
  for (const rule of SECRET_PATTERNS) {
    if (rule.pattern.test(text)) found.push({ code: `SECRET_${rule.code}`, subject: 'inventory output', detail: `secret-shaped text (${rule.code}) is present: the output is not to be kept or shared` });
  }
  return found;
}

export type Canonical = { lines: string[]; digest: string; kinds: Record<string, { count: number; digest: string }> };

/** Sorted, key-stable lines, their digest, and a digest per kind (so a drift can be localised without the manifest). */
export async function canonicalize(lines: readonly Line[]): Promise<Canonical> {
  const sorted = [...lines].sort((a, b) => (a.k === b.k ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.k < b.k ? -1 : 1));
  const text = sorted.map((line) => stableStringify({ a: line.a, k: line.k, key: line.key }));
  const kinds: Record<string, { count: number; digest: string }> = {};
  for (const kind of KINDS) {
    const members = sorted.filter((line) => line.k === kind).map((line) => stableStringify({ a: line.a, k: line.k, key: line.key }));
    if (members.length > 0) kinds[kind] = { count: members.length, digest: await sha256Hex(`${members.join('\n')}\n`) };
  }
  return { lines: text, digest: await sha256Hex(`${text.join('\n')}\n`), kinds };
}

export type Drift = { missing: string[]; extra: string[]; changed: { object: string; fields: string[] }[] };
export const hasDrift = (drift: Drift) => drift.missing.length + drift.extra.length + drift.changed.length > 0;

/** What is in `approved` and not in `observed` (missing), the reverse (extra), and which attributes of a shared object differ. */
export function diffInventories(approved: readonly Line[], observed: readonly Line[]): Drift {
  const index = (lines: readonly Line[]) => new Map(lines.map((line) => [`${line.k} ${line.key}`, line]));
  const left = index(approved);
  const right = index(observed);
  const drift: Drift = { missing: [], extra: [], changed: [] };
  for (const [object, line] of left) {
    const other = right.get(object);
    if (!other) {
      drift.missing.push(object);
      continue;
    }
    const names = new Set([...Object.keys(line.a), ...Object.keys(other.a)]);
    const fields = [...names].filter((name) => stableStringify(line.a[name]) !== stableStringify(other.a[name])).sort();
    if (fields.length > 0) drift.changed.push({ object, fields });
  }
  for (const object of right.keys()) if (!left.has(object)) drift.extra.push(object);
  drift.missing.sort();
  drift.extra.sort();
  drift.changed.sort((a, b) => a.object.localeCompare(b.object));
  return drift;
}

// ---- the query itself is checked, too -------------------------------------------------------------------------------

/** System catalogs the inventory may read. Anything else after FROM / JOIN, or any pg_ name outside this list, is refused. */
export const CATALOGS: readonly string[] = [
  'pg_namespace', 'pg_extension', 'pg_depend', 'pg_roles', 'pg_auth_members', 'pg_class', 'pg_sequence', 'pg_foreign_table',
  'pg_foreign_server', 'pg_attribute', 'pg_attrdef', 'pg_constraint', 'pg_index', 'pg_am', 'pg_trigger', 'pg_proc', 'pg_language',
  'pg_policy', 'pg_type', 'pg_enum', 'pg_rewrite', 'pg_event_trigger', 'pg_publication', 'pg_publication_rel',
  'pg_foreign_data_wrapper', 'pg_user_mappings', 'pg_database', 'pg_db_role_setting', 'pg_default_acl',
];
/** Functions the query may call. A function that is not here (pg_read_file, pg_sleep, nextval, dblink, set_config, ...) is refused. */
export const FUNCTIONS: readonly string[] = [
  'jsonb_build_object', 'jsonb_agg', 'jsonb_object_agg', 'coalesce', 'current_setting', 'pg_get_userbyid', 'aclexplode', 'unnest',
  'format_type', 'pg_get_viewdef', 'pg_get_expr', 'pg_get_constraintdef', 'pg_get_indexdef', 'pg_get_triggerdef', 'encode',
  'sha256', 'convert_to', 'regexp_replace', 'split_part', 'substr', 'strpos', 'replace', 'oidvectortypes', 'lower', 'length',
  'to_jsonb', 'row_number', 'count', 'distinct', 'k',
];
const SQL_WORDS = new Set([
  'in', 'exists', 'over', 'from', 'join', 'select', 'not', 'and', 'or', 'when', 'then', 'else', 'case', 'end', 'on', 'as', 'where',
  'by', 'partition', 'order', 'group', 'with', 'ordinality', 'any', 'all', 'is', 'null', 'left', 'using', 'lateral', 'cross',
  'values', 'union', 'inner', 'outer', 'like', 'between', 'asc', 'desc',
]);
const FORBIDDEN_WORDS = [
  'insert', 'update', 'delete', 'create', 'alter', 'drop', 'grant', 'revoke', 'truncate', 'copy', 'call', 'do', 'execute', 'vacuum',
  'lock', 'listen', 'notify', 'comment', 'reindex', 'cluster', 'refresh', 'analyze', 'discard', 'reset', 'load', 'import', 'commit',
  'savepoint', 'prepare', 'declare', 'fetch', 'move', 'into', 'returning', 'security', 'explain',
];
export type SqlFinding = { code: string; statement: number; detail: string };

/**
 * The inventory query is data the reviewer pins by digest AND checks mechanically: only BEGIN READ ONLY, SET LOCAL of three
 * timeouts, SELECT and ROLLBACK; every FROM / JOIN target a listed catalog; every called function listed; no schema-qualified
 * application object; no comma join (an unqualified name would resolve through search_path).
 */
export function checkInventorySql(sql: string): SqlFinding[] {
  const findings: SqlFinding[] = [];
  const add = (code: string, statement: number, detail: string) => findings.push({ code, statement, detail });
  const normalized = normalize(sql);
  if (!normalized.ok) add('UNLEXABLE', 0, 'the file does not lex (unterminated literal or comment)');
  const statements = splitStatements(normalized.text);
  const strip = (text: string) => text.replace(/'(?:[^']|'')*'/gu, "''");
  statements.forEach((statement, index) => {
    const n = index + 1;
    const text = statement.text.trim().replace(/\s+/gu, ' ');
    const code = strip(text);
    const first = /^[a-z]+/u.exec(code)?.[0] ?? '';
    if (n === 1 && !/^begin transaction isolation level repeatable read read only$/u.test(code)) add('NOT_READ_ONLY_BEGIN', n, 'the first statement must be BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (n === statements.length && code !== 'rollback') add('NOT_ROLLBACK_END', n, 'the last statement must be ROLLBACK');
    if (!['begin', 'set', 'select', 'rollback'].includes(first)) add('STATEMENT_KIND', n, `a ${first || 'unknown'} statement is not allowed`);
    if (first === 'set' && !/^set local (statement_timeout|lock_timeout|idle_in_transaction_session_timeout) = ''$/u.test(code)) add('SET_NOT_ALLOWED', n, 'only SET LOCAL of the three timeouts is allowed');
    if (first !== 'select') return;
    for (const word of FORBIDDEN_WORDS) {
      if (new RegExp(`(?<![._a-z0-9])${word}(?![._a-z0-9])`, 'u').test(code)) add('FORBIDDEN_WORD', n, `the word ${word} does not belong in a read-only inventory`);
    }
    for (const match of code.matchAll(/\b(from|join)\s+(?:lateral\s+)?([a-z_][a-z0-9_.$]*)/gu)) {
      const target = match[2];
      if (!CATALOGS.includes(target) && !FUNCTIONS.includes(target)) add('FROM_TARGET', n, `reads ${target}, which is not a listed catalog`);
    }
    for (const match of code.matchAll(/(?<![._a-z0-9])(pg_[a-z0-9_]+)\b(?!\s*\()/gu)) {
      if (!CATALOGS.includes(match[1]) && !/^pg_(catalog|toast|temp)/u.test(match[1])) add('CATALOG_NAME', n, `names ${match[1]}, which is not a listed catalog`);
    }
    for (const match of code.matchAll(/(?<![._a-z0-9])([a-z_][a-z0-9_]*)\s*\(/gu)) {
      const name = match[1];
      if (!FUNCTIONS.includes(name) && !SQL_WORDS.has(name)) add('FUNCTION_NOT_LISTED', n, `calls ${name}()`);
    }
    for (const match of code.matchAll(/(?<![._a-z0-9])(public|private|auth|storage|vault|cron|net|extensions|realtime|supabase_functions|graphql|pgsodium)\.[a-z_][a-z0-9_]*/gu)) {
      add('SCHEMA_QUALIFIED_OBJECT', n, `names ${match[0]}`);
    }
    if (/\bfrom\s+[a-z_][a-z0-9_.]*(\s+(as\s+)?[a-z_][a-z0-9_]*)?\s*,/u.test(code)) add('COMMA_JOIN', n, 'a comma join (use JOIN ... ON)');
  });
  return findings;
}

// ---- the contract subset -----------------------------------------------------------------------------------------

const pick = (source: Record<string, unknown>, names: readonly string[]) => Object.fromEntries(names.filter((name) => name in source).map((name) => [name, source[name]]));
const compact = (signature: string) => signature.replace(/\s+/gu, '');
const schemaOf = (relation: string) => relation.slice(0, relation.indexOf('.'));

/** Every relation, with its required columns, the chain needs: the Phase 1 lists, the FK targets, and the auth.sessions columns. */
function neededColumns(requirements: Requirements): Map<string, Set<string>> {
  const needed = new Map<string, Set<string>>();
  const add = (relation: string, column: string) => {
    if (!needed.has(relation)) needed.set(relation, new Set());
    needed.get(relation)!.add(column);
  };
  for (const relation of requirements.relations) if (!needed.has(relation)) needed.set(relation, new Set());
  for (const item of requirements.columns) add(item.relation, item.column);
  for (const item of ADDITIONAL_PLATFORM_REQUIREMENTS) add(item.relation, item.column);
  for (const key of requirements.foreignKeys) {
    for (const column of key.columns) add(key.relation, column);
    for (const column of key.referencedColumns) add(key.references, column);
  }
  return needed;
}

/**
 * The part of an inventory the chain's correctness depends on. Everything else (other columns, other triggers, other
 * policies, other tables) stays in the full manifest for the owner to read and is NOT part of the compared digest: a
 * project may legitimately differ from production there. `ord` (column position) is dropped: it is not semantic.
 */
export function contractSubset(lines: readonly Line[], requirements: Requirements): Line[] {
  const needed = neededColumns(requirements);
  const relations = new Set(needed.keys());
  const functions = new Set(requirements.functions.map(compact));
  const schemas = new Set([...requirements.schemas, ...[...relations].map(schemaOf)]);
  const roles = new Set(requirements.roles);
  const foreignKeys = new Set(requirements.foreignKeys.map((key) => `${key.relation}|${key.columns.join(',')}|${key.references}|${key.referencedColumns.join(',')}`));
  const out: Line[] = [];
  for (const line of lines) {
    const a = line.a;
    switch (line.k) {
      case 'schema':
        if (schemas.has(line.key)) out.push(a.scope === 'app' || requirements.schemas.includes(line.key) ? line : { ...line, a: pick(a, ['scope']) });
        break;
      case 'role':
        if (roles.has(line.key)) out.push(line);
        break;
      case 'relation':
        if (relations.has(line.key)) out.push(isPlatformRelation(line.key) ? { ...line, a: pick(a, ['relkind']) } : { ...line, a: pick(a, ['relkind', 'owner', 'persistence', 'rls', 'rls_forced', 'acl']) });
        break;
      case 'column': {
        const relation = String(a.rel);
        if (needed.get(relation)?.has(line.key.slice(relation.length + 1))) {
          out.push({ ...line, a: isPlatformRelation(relation) ? pick(a, ['rel', 'type']) : pick(a, ['rel', 'type', 'notnull', 'generated', 'identity', 'default_sha256']) });
        }
        break;
      }
      case 'constraint': {
        const relation = String(a.rel);
        if (!relations.has(relation)) break;
        // keys of a platform table are the platform's own business; only the foreign keys the preflights name are compared
        if (!isPlatformRelation(relation) && (a.type === 'p' || a.type === 'u')) out.push({ ...line, a: pick(a, ['rel', 'type', 'def_sha256']) });
        if (a.type === 'f') {
          const fk = a.fk as { columns: string[]; references: string; referenced_columns: string[] } | null;
          if (fk && foreignKeys.has(`${relation}|${fk.columns.join(',')}|${fk.references}|${fk.referenced_columns.join(',')}`)) {
            out.push({ ...line, a: pick(a, ['rel', 'type', 'validated', 'fk']) });
          }
        }
        break;
      }
      case 'function':
        if (functions.has(compact(line.key))) out.push({ ...line, a: pick(a, ['kind', 'language', 'security_definer', 'volatility', 'owner', 'returns', 'config', 'acl', 'body_sha256']) });
        break;
      default:
        break;
    }
  }
  return out;
}

// ---- requirements --------------------------------------------------------------------------------------------------

/** Compares an inventory (full, or the subset) with what the Phase 1 preflight and the later preflights require. */
export function checkRequirements(lines: readonly Line[], requirements: Requirements): Finding[] {
  const findings: Finding[] = [];
  const add = (code: string, subject: string, detail: string) => findings.push({ code, subject, detail });
  const byKey = (kind: Kind) => new Map(lines.filter((line) => line.k === kind).map((line) => [line.key, line]));
  const schemas = byKey('schema');
  const roles = byKey('role');
  const relations = byKey('relation');
  const columns = byKey('column');
  const functions = new Map(lines.filter((line) => line.k === 'function').map((line) => [compact(line.key), line]));
  for (const schema of requirements.schemas) if (!schemas.has(schema)) add('SCHEMA_MISSING', schema, 'a required schema is absent');
  for (const role of requirements.roles) if (!roles.has(role)) add('ROLE_MISSING', role, 'a required role is absent');
  for (const relation of requirements.relations) {
    const found = relations.get(relation);
    if (!found) add('RELATION_MISSING', relation, 'a required relation is absent');
    else if (found.a.relkind !== 'r' && found.a.relkind !== 'p') add('RELATION_KIND', relation, `a required relation is relkind ${String(found.a.relkind)}, not a table`);
  }
  for (const item of [...requirements.columns, ...ADDITIONAL_PLATFORM_REQUIREMENTS]) {
    const found = columns.get(`${item.relation}.${item.column}`);
    if (!found) add('COLUMN_MISSING', `${item.relation}.${item.column}`, 'a required column is absent');
    else if (found.a.type !== item.type) add('COLUMN_TYPE', `${item.relation}.${item.column}`, `type ${String(found.a.type)}, required ${item.type}`);
  }
  for (const key of requirements.foreignKeys) {
    const subject = `${key.relation}(${key.columns.join(',')})->${key.references}(${key.referencedColumns.join(',')})`;
    const match = lines.find((line) => {
      if (line.k !== 'constraint' || line.a.rel !== key.relation || line.a.type !== 'f') return false;
      const fk = line.a.fk as { columns: string[]; references: string; referenced_columns: string[] } | null;
      return fk !== null && fk.columns.join(',') === key.columns.join(',') && fk.references === key.references && fk.referenced_columns.join(',') === key.referencedColumns.join(',');
    });
    if (!match) add('FOREIGN_KEY_MISSING', subject, 'a required foreign key is absent');
    else if ((match.a.fk as { on_delete: string }).on_delete !== key.onDelete) add('FOREIGN_KEY_ON_DELETE', subject, `ON DELETE ${(match.a.fk as { on_delete: string }).on_delete}, required ${key.onDelete}`);
  }
  for (const signature of requirements.functions) if (!functions.has(compact(signature))) add('FUNCTION_MISSING', signature, 'a required function is absent');
  return findings;
}

// ---- the two verdicts -----------------------------------------------------------------------------------------------

export type InventoryVerdict = { status: 'PASS' | 'STOP'; detail: string; digest?: string; findings: Finding[] };
const stopWith = (detail: string, findings: Finding[] = [], digest?: string): InventoryVerdict => ({ status: 'STOP', detail, findings, ...(digest ? { digest } : {}) });
const summary = (findings: Finding[]) => findings.slice(0, 6).map((f) => `${f.code}:${f.subject}`).join('; ') + (findings.length > 6 ? ` (+${findings.length - 6} more)` : '');

/** The plan's G3b: the project's own inventory, its requirements, its contract digest against the approved one. Any difference STOPs. */
export async function verifyInventory(output: string, requirements: Requirements, approvedDigest: string | undefined): Promise<InventoryVerdict> {
  if (approvedDigest === undefined || !SHA256.test(approvedDigest)) return stopWith('no approved baseline-contract digest: the owner has not approved a production inventory');
  const secrets = secretFindings(output);
  if (secrets.length > 0) return stopWith(`the inventory output carries secret-shaped text (${secrets.map((s) => s.code).join(', ')}); it is not compared or kept`, secrets);
  let lines: Line[];
  try {
    lines = parseInventory(output);
  } catch (error) {
    if (error instanceof InventoryError) return stopWith(`the inventory is unreadable (${error.code}): ${error.message}`);
    throw error;
  }
  const shape = validateShape(lines);
  if (shape.length > 0) return stopWith(`the inventory violates its own contract: ${summary(shape)}`, shape);
  const subset = contractSubset(lines, requirements);
  const missing = checkRequirements(subset, requirements);
  if (missing.length > 0) return stopWith(`the baseline does not provide what the chain requires: ${summary(missing)}`, missing);
  const canonical = await canonicalize(subset);
  if (canonical.digest !== approvedDigest) {
    return stopWith(`the baseline contract differs from the approved one (observed ${canonical.digest.slice(0, 16)}..., approved ${approvedDigest.slice(0, 16)}...)`, [], canonical.digest);
  }
  return { status: 'PASS', detail: `the baseline contract (${subset.length} items) equals the approved digest ${canonical.digest.slice(0, 16)}...`, digest: canonical.digest, findings: [] };
}

export type ReadinessState = 'NOT_READY' | 'READY_FOR_OWNER_REVIEW';
export type Readiness = { state: ReadinessState; reasons: string[]; unknownObjects: string[]; contractDigest?: string };
type ProvenanceUnknown = { relations: string[]; columns: string[]; foreignKeys: string[]; functions: string[] };

/**
 * Whether a baseline exists that the repository can reason about. The unknown objects (the ones no repository migration
 * creates) are listed; with no inventory the answer is always NOT_READY. With one, the answer is at most
 * READY_FOR_OWNER_REVIEW: an inventory proves what production HAS, the owner decides whether it is the baseline.
 */
export async function baselineReadiness(unknown: ProvenanceUnknown, requirements: Requirements, manifest: string | null): Promise<Readiness> {
  const unknownObjects = [
    ...unknown.relations.map((name) => `relation ${name}`), ...unknown.columns.map((name) => `column ${name}`),
    ...unknown.foreignKeys.map((name) => `foreign key ${name}`), ...unknown.functions.map((name) => `function ${name}`),
  ];
  if (manifest === null) {
    return { state: 'NOT_READY', unknownObjects, reasons: unknownObjects.length === 0 ? ['no approved inventory'] : [`${unknownObjects.length} object(s) no repository migration creates; no inventory has been supplied`] };
  }
  const reasons: string[] = [];
  const secrets = secretFindings(manifest);
  if (secrets.length > 0) return { state: 'NOT_READY', unknownObjects, reasons: [`the manifest carries secret-shaped text (${secrets.map((s) => s.code).join(', ')})`] };
  let lines: Line[];
  try {
    lines = parseInventory(manifest);
  } catch (error) {
    return { state: 'NOT_READY', unknownObjects, reasons: [error instanceof InventoryError ? `${error.code}: ${error.message}` : 'unreadable manifest'] };
  }
  const shape = validateShape(lines);
  if (shape.length > 0) reasons.push(`the manifest violates the inventory contract: ${summary(shape)}`);
  const missing = checkRequirements(lines, requirements);
  if (missing.length > 0) reasons.push(`the manifest lacks what the chain requires: ${summary(missing)}`);
  const unlisted = unknownObjects.filter((entry) => entry.startsWith('relation ')).filter((entry) => !lines.some((line) => line.k === 'relation' && `relation ${line.key}` === entry));
  if (unlisted.length > 0) reasons.push(`unknown relation(s) not in the manifest: ${unlisted.join(', ')}`);
  const digest = (await canonicalize(contractSubset(lines, requirements))).digest;
  return reasons.length === 0
    ? { state: 'READY_FOR_OWNER_REVIEW', unknownObjects, reasons: [], contractDigest: digest }
    : { state: 'NOT_READY', unknownObjects, reasons, contractDigest: digest };
}
