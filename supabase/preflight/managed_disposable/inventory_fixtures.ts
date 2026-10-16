// A synthetic schema inventory that provides exactly what a Requirements object asks for, plus noise the contract must
// ignore. TEST SUPPORT ONLY (fake names, fake hashes): shared by inventory_test.ts and the plan-step tests.
import { ADDITIONAL_PLATFORM_REQUIREMENTS, type Requirements } from './baseline_requirements.ts';
import type { Line } from './inventory.ts';

export const H = (n: number) => n.toString(16).padStart(64, '0');

/** An inventory that provides exactly what the requirements ask for, plus noise the contract must ignore. */
export function syntheticInventory(requirements: Requirements, options: { skip?: (line: Line) => boolean; tweak?: (line: Line) => void } = {}): Line[] {
  const lines: Line[] = [{ k: 'meta', key: 'inventory', a: { format: 1, server_major: 17 } }];
  const schemas = new Set<string>([...requirements.schemas, 'public']);
  for (const relation of [...requirements.relations, ...requirements.foreignKeys.map((k) => k.references)]) schemas.add(relation.split('.')[0]);
  for (const name of schemas) {
    lines.push({ k: 'schema', key: name, a: { scope: name === 'public' || name === 'private' ? 'app' : 'platform', owner: 'postgres', acl: null } });
  }
  for (const name of requirements.roles) lines.push({ k: 'role', key: name, a: { superuser: false, inherit: true, createrole: false, createdb: false, login: false, replication: false, bypassrls: name === 'service_role', connlimit: -1 } });
  const relations = new Set<string>([...requirements.relations, ...requirements.foreignKeys.map((k) => k.references), ...ADDITIONAL_PLATFORM_REQUIREMENTS.map((r) => r.relation)]);
  for (const name of relations) {
    lines.push({ k: 'relation', key: name, a: { schema: name.split('.')[0], relkind: 'r', owner: 'postgres', persistence: 'p', rls: true, rls_forced: false, partition: false, options: [], acl: ['service_role:SELECT'], def_shape: null, def_sha256: null, bound_sha256: null, sequence: null, foreign_server: null, foreign_option_keys: null } });
  }
  const columns = new Map<string, string>();
  for (const item of [...requirements.columns, ...ADDITIONAL_PLATFORM_REQUIREMENTS]) columns.set(`${item.relation}.${item.column}`, item.type);
  for (const key of requirements.foreignKeys) {
    for (const column of key.referencedColumns) if (!columns.has(`${key.references}.${column}`)) columns.set(`${key.references}.${column}`, 'uuid');
    for (const column of key.columns) if (!columns.has(`${key.relation}.${column}`)) columns.set(`${key.relation}.${column}`, 'uuid');
  }
  let ord = 0;
  for (const [key, type] of columns) {
    const rel = key.slice(0, key.lastIndexOf('.'));
    lines.push({ k: 'column', key, a: { rel, ord: ++ord, type, notnull: false, generated: '', identity: '', default_shape: null, default_sha256: null, acl: null } });
  }
  // noise: a column, a trigger, a policy and a function the contract does not name
  lines.push({ k: 'column', key: 'public.profiles.unrelated_note', a: { rel: 'public.profiles', ord: 99, type: 'text', notnull: false, generated: '', identity: '', default_shape: "'?'::text", default_sha256: H(1), acl: null } });
  lines.push({ k: 'trigger', key: 'public.profiles.t_noise', a: { rel: 'public.profiles', enabled: 'O', function: 'public.noise', def_shape: 'CREATE TRIGGER t_noise ...', def_sha256: H(2) } });
  lines.push({ k: 'policy', key: 'public.profiles.p_noise', a: { rel: 'public.profiles', command: '*', permissive: true, roles: ['PUBLIC'], using_shape: '(true)', using_sha256: H(3), check_shape: null, check_sha256: null } });
  lines.push({ k: 'function', key: 'public.noise()', a: { schema: 'public', kind: 'f', language: 'sql', security_definer: false, volatility: 'v', strict: false, leakproof: false, parallel: 'u', owner: 'postgres', returns: 'void', config: {}, acl: null, body_sha256: H(4), body_length: 10, mentions: { cron: false, net: false, vault: false, url: false, supabase_host: false } } });
  for (const signature of requirements.functions) {
    lines.push({ k: 'function', key: signature.replace(/\s+/gu, ''), a: { schema: 'public', kind: 'f', language: 'plpgsql', security_definer: true, volatility: 'v', strict: false, leakproof: false, parallel: 'u', owner: 'postgres', returns: 'uuid', config: { search_path: 'public, pg_temp' }, acl: ['service_role:EXECUTE'], body_sha256: H(5), body_length: 100, mentions: { cron: false, net: false, vault: false, url: false, supabase_host: false } } });
  }
  for (const key of requirements.foreignKeys) {
    lines.push({ k: 'constraint', key: `${key.relation}.${key.columns.join('_')}_fkey`, a: { rel: key.relation, type: 'f', validated: true, deferrable: false, deferred: false, def_shape: 'FOREIGN KEY', def_sha256: H(6), fk: { columns: key.columns, references: key.references, referenced_columns: key.referencedColumns, on_delete: key.onDelete, on_update: 'a' } } });
  }
  lines.push({ k: 'constraint', key: 'public.profiles.profiles_pkey', a: { rel: 'public.profiles', type: 'p', validated: true, deferrable: false, deferred: false, def_shape: 'PRIMARY KEY (id)', def_sha256: H(7), fk: null } });
  const out = lines.filter((line) => !options.skip?.(line));
  for (const line of out) options.tweak?.(line);
  return out;
}
