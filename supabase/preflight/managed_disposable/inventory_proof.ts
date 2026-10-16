// Local-database proof of the schema inventory (F5 Phase 12), driven by supabase/tests/common_account_phase12_inventory_run.sh.
// A throw-away database holds planted fake values (SENTINEL_*, the fake world file); the inventory query is run as a
// login that can only CONNECT, as the owner of everything, and as a superuser. Every run must be structure only, valid
// against the inventory's closed attribute lists, free of secret-shaped text, byte-for-byte deterministic, free of side
// effects, and sensitive to a real change. Fake data and local sockets only: nothing here can reach a managed project.
import { canonicalize, checkInventorySql, contractSubset, diffInventories, type Line, parseInventory, secretFindings, stableStringify, validateShape, verifyInventory } from './inventory.ts';
import type { Requirements } from './baseline_requirements.ts';

const env = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is required (common_account_phase12_inventory_run.sh)`);
  return value;
};
const host = env('PGHOST'), port = env('PGPORT'), database = env('P12_DB');
const roles = { super: env('P12_SUPER'), owner: env('P12_OWNER'), reader: env('P12_READER') } as const;
const querySql = env('P12_INVENTORY_SQL');
const worldSql = Deno.readTextFileSync(env('P12_WORLD_SQL')) + Deno.readTextFileSync(env('P12_WORLD_SUPER_SQL'));
const decoder = new TextDecoder();

type Role = keyof typeof roles;
async function psql(role: Role, args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...args],
    env: { PGHOST: host, PGPORT: port, PGUSER: roles[role], PGDATABASE: database, LC_ALL: 'C' }, clearEnv: true, stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), err: decoder.decode(out.stderr).trim() };
}
const inventory = async (role: Role, file = querySql) => {
  const run = await psql(role, ['-f', file]);
  if (!run.ok) throw new Error(`inventory as ${role} failed: ${run.err.slice(0, 300)}`);
  return run.out;
};

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`P12_INVENTORY_PROOF|${name}|${ok ? 'PASS' : 'FAIL'}${detail && !ok ? `|${detail}` : ''}`);
  if (!ok) failures++;
};

// planted values: every SENTINEL_ token of the fake world, and the sequence value
const sentinels = [...new Set([...worldSql.matchAll(/SENTINEL_[A-Za-z0-9_]+/gu)].map((m) => m[0])), '7351902', 'sentinel-host.example.test'];
check('world_has_sentinels', sentinels.length >= 15, `found ${sentinels.length}`);
const leaked = (text: string) => sentinels.filter((s) => text.includes(s));

// 1. the least-privileged login cannot read application data (so the inventory cannot be leaning on a privilege)
for (const relation of ['public.p12_sentinel_rows', 'cron.job', 'vault.secrets']) {
  const attempt = await psql('reader', ['-c', `select count(*) from ${relation}`]);
  check(`reader_cannot_read_${relation}`, !attempt.ok && /permission denied/u.test(attempt.err), attempt.err.slice(0, 120));
}
const readerPrivileged = await psql('reader', ['-c', "select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls from pg_roles where rolname = current_user"]);
check('reader_has_no_privilege', readerPrivileged.out === 'f', readerPrivileged.out);

// 2. the three runs: structure only, valid, no secret-shaped text, no planted value
const outputs: Record<Role, string> = { reader: await inventory('reader'), owner: await inventory('owner'), super: await inventory('super') };
for (const role of Object.keys(outputs) as Role[]) {
  const text = outputs[role];
  let lines: Line[] = [];
  try {
    lines = parseInventory(text);
    check(`${role}_parses`, lines.length > 40, `${lines.length} lines`);
  } catch (error) {
    check(`${role}_parses`, false, String(error));
  }
  check(`${role}_valid_against_attribute_lists`, validateShape(lines).length === 0, JSON.stringify(validateShape(lines).slice(0, 3)));
  check(`${role}_no_secret_shaped_text`, secretFindings(text).length === 0, JSON.stringify(secretFindings(text).map((f) => f.code)));
  check(`${role}_no_planted_value`, leaked(text).length === 0, leaked(text).join(','));
}

// 3. deterministic, and independent of who asks (every kind except what a non-owner is not allowed to see)
const first = await canonicalize(parseInventory(outputs.reader));
const again = await canonicalize(parseInventory(await inventory('reader')));
check('deterministic_same_login', first.digest === again.digest);
const ownerView = await canonicalize(parseInventory(outputs.owner));
const differing = Object.keys(first.kinds).filter((kind) => first.kinds[kind]?.digest !== ownerView.kinds[kind]?.digest);
check('same_for_reader_and_owner', differing.length === 0, differing.join(','));

// 4. what the inventory DOES contain
const lines = parseInventory(outputs.reader);
const find = (k: string, key: string) => lines.find((line) => line.k === k && line.key === key);
const rows = find('relation', 'public.p12_sentinel_rows');
check('relation_present', rows?.a.relkind === 'r' && rows.a.rls === true && rows.a.owner === roles.owner);
const note = find('column', 'public.p12_sentinel_rows.note');
const defaultText = "'SENTINEL_COLUMN_DEFAULT_b81e'::text";
const defaultHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(defaultText)))].map((b) => b.toString(16).padStart(2, '0')).join('');
check('default_is_shape_and_hash', note?.a.default_shape === "'?'::text" && note.a.default_sha256 === defaultHash, JSON.stringify(note?.a));
const check1 = find('constraint', 'public.p12_sentinel_rows.p12_note_check');
check('check_constraint_masked', typeof check1?.a.def_shape === 'string' && check1.a.def_shape.includes("'?'") && /^[0-9a-f]{64}$/u.test(String(check1.a.def_sha256)));
check('index_predicate_masked', String(find('index', 'public.p12_sentinel_rows.p12_sentinel_idx')?.a.def_shape).includes("'?'"));
check('policy_masked', String(find('policy', 'public.p12_sentinel_rows.p12_sentinel_policy')?.a.using_shape).includes("'?'") && JSON.stringify(find('policy', 'public.p12_sentinel_rows.p12_sentinel_policy')?.a.roles) === '["authenticated"]');
check('trigger_masked', String(find('trigger', 'public.p12_sentinel_rows.p12_sentinel_trigger')?.a.def_shape).includes("'?'"));
check('view_masked_and_referenced', String(find('relation', 'public.p12_sentinel_view')?.a.def_shape).includes("'?'") && find('view_reference', 'public.p12_sentinel_view>public.p12_sentinel_rows') !== undefined);
const fn = find('function', 'public.p12_sentinel_fn(uuid)');
check('function_hash_only', fn?.a.security_definer === true && /^[0-9a-f]{64}$/u.test(String(fn.a.body_sha256)) && Number(fn.a.body_length) > 20 && !('body' in fn.a));
check('function_settings_redacted', stableStringify(fn?.a.config) === '{"app.p12_token":"<redacted>","search_path":"public, pg_temp"}', JSON.stringify(fn?.a.config));
const net = find('function', 'public.p12_net_fn()');
check('network_function_flagged', (net?.a.mentions as Record<string, boolean>)?.net === true && (net?.a.mentions as Record<string, boolean>)?.url === true && (fn?.a.mentions as Record<string, boolean>)?.net === false);
check('sequence_has_options_not_value', (find('relation', 'public.p12_sentinel_seq')?.a.sequence as Record<string, unknown>)?.type === 'bigint');
const enumType = find('type', 'public.p12_status');
check('enum_labels_are_structure', JSON.stringify(enumType?.a.labels) === '["draft","live"]');
const domain = find('type', 'public.p12_code');
check('domain_default_hashed', domain?.a.base === 'text' && /^[0-9a-f]{64}$/u.test(String(domain.a.default_sha256)) && JSON.stringify(domain.a.checks).includes("'?'"));
check('publication_lists_tables', JSON.stringify(find('publication', 'p12_pub')?.a.tables) === '["public.p12_sentinel_rows"]');
check('role_has_attributes_only', find('role', 'kb_p12i_app') !== undefined && !('password' in (find('role', 'kb_p12i_app')?.a ?? {})) && !('valid_until' in (find('role', 'kb_p12i_app')?.a ?? {})));
check('foreign_server_option_keys_only', JSON.stringify(find('foreign_server', 'p12_server')?.a.option_keys) === '["host","password"]', JSON.stringify(find('foreign_server', 'p12_server')?.a));
check('foreign_table_option_keys_only', JSON.stringify(find('relation', 'public.p12_remote')?.a.foreign_option_keys) === '["table_name"]');
const settingNames = lines.filter((line) => line.k === 'setting_scope').flatMap((line) => line.a.names as string[]);
check('setting_names_not_values', settingNames.includes('app.service_key') && settingNames.includes('app.endpoint'));
check('cron_and_vault_rows_absent', !lines.some((line) => /\bp12\b/u.test(line.key) && ['cron', 'vault'].some((s) => line.key.startsWith(s))));
check('default_acl_present', lines.some((line) => line.k === 'default_acl'));

// 5. the query is read-only at the ENGINE level, whatever its text says: an injected CREATE / INSERT is refused by the server
const scratchDir = await Deno.makeTempDir({ dir: Deno.env.get('P12_TMP') ?? undefined });
const injected = async (statement: string) => {
  const text = Deno.readTextFileSync(querySql).replace(/\nrollback;\s*$/u, `\n${statement}\nrollback;\n`);
  const file = `${scratchDir}/injected.sql`;
  Deno.writeTextFileSync(file, text);
  return { run: await psql('owner', ['-f', file]), flagged: checkInventorySql(text).length > 0 };
};
for (const [name, statement, exists] of [
  ['create_table', 'create table public.p12_must_not_exist (a int);', "select to_regclass('public.p12_must_not_exist') is not null"],
  ['insert_row', "insert into public.p12_sentinel_rows (secret_note) values ('SENTINEL_INJECTED_ROW');", "select count(*) > 1 from public.p12_sentinel_rows"],
  ['grant', 'grant select on public.p12_sentinel_rows to public;', "select exists (select 1 from aclexplode((select relacl from pg_class where oid = 'public.p12_sentinel_rows'::regclass)) a where a.grantee = 0)"],
] as const) {
  const attempt = await injected(statement);
  const after = await psql('super', ['-c', exists]);
  check(`engine_refuses_${name}`, !attempt.run.ok && /read-only transaction/u.test(attempt.run.err) && after.out === 'f', `${attempt.run.err.slice(0, 100)} after=${after.out}`);
  check(`static_check_flags_${name}`, attempt.flagged);
}

// 6. no side effect: the sequence was not advanced, and nothing changed
const sequence = await psql('super', ['-c', 'select last_value from public.p12_sentinel_seq']);
check('sequence_untouched', sequence.out === '7351902', sequence.out);
const after = await canonicalize(parseInventory(await inventory('reader')));
check('inventory_unchanged_by_running_it', after.digest === first.digest);

// 7. a real change is a drift, and the digest sees what the shape hides
// a REVOKE leaves an explicit ACL where there was none (relacl is not reset to NULL), so a privilege change is not byte-restorable
const drift = async (name: string, change: string, undo: string, expectation: (d: ReturnType<typeof diffInventories>) => boolean, restorable = true) => {
  const baseline = parseInventory(await inventory('reader'));
  const apply = await psql('owner', ['-c', change]);
  if (!apply.ok) { check(`drift_${name}`, false, apply.err.slice(0, 160)); return; }
  const changed = parseInventory(await inventory('reader'));
  const found = diffInventories(baseline, changed);
  const digest = (await canonicalize(changed)).digest !== (await canonicalize(baseline)).digest;
  await psql('owner', ['-c', undo]);
  const restored = (await canonicalize(parseInventory(await inventory('reader')))).digest === (await canonicalize(baseline)).digest;
  check(`drift_${name}`, expectation(found) && digest && (restored || !restorable), JSON.stringify(found).slice(0, 200));
};
await drift('column_added', 'alter table public.p12_sentinel_rows add column extra int', 'alter table public.p12_sentinel_rows drop column extra',
  (d) => d.extra.includes('column public.p12_sentinel_rows.extra') && d.missing.length === 0);
await drift('same_shape_other_literal', "alter table public.p12_sentinel_rows alter column note set default 'SENTINEL_OTHER_DEFAULT_0000'", "alter table public.p12_sentinel_rows alter column note set default 'SENTINEL_COLUMN_DEFAULT_b81e'",
  (d) => d.changed.length === 1 && d.changed[0].object === 'column public.p12_sentinel_rows.note' && d.changed[0].fields.join() === 'default_sha256');
await drift('policy_dropped', 'drop policy p12_sentinel_policy on public.p12_sentinel_rows',
  "create policy p12_sentinel_policy on public.p12_sentinel_rows for select to authenticated using (note <> 'SENTINEL_POLICY_LITERAL_0e44')",
  (d) => d.missing.includes('policy public.p12_sentinel_rows.p12_sentinel_policy'));
await drift('function_body_changed', "create or replace function public.p12_trigger_fn() returns trigger language plpgsql as $f$ begin return null; end $f$",
  'create or replace function public.p12_trigger_fn() returns trigger language plpgsql as $f$ begin return new; end $f$',
  (d) => d.changed.length === 1 && d.changed[0].object === 'function public.p12_trigger_fn()' && d.changed[0].fields.join() === 'body_length,body_sha256');
await drift('privilege_granted', 'grant select on public.p12_sentinel_rows to anon', 'revoke select on public.p12_sentinel_rows from anon',
  (d) => d.changed.length === 1 && d.changed[0].fields.join() === 'acl', false);
await drift('rls_disabled', 'alter table public.p12_sentinel_rows disable row level security', 'alter table public.p12_sentinel_rows enable row level security',
  (d) => d.changed.length === 1 && d.changed[0].fields.join() === 'rls');

// 8. the contract subset over the live inventory: the digest the owner would approve, and what it does / does not notice
const requirements: Requirements = {
  schemas: [], roles: ['authenticated'], relations: ['public.p12_sentinel_rows'],
  columns: [{ relation: 'public.p12_sentinel_rows', column: 'secret_note', type: 'text' }, { relation: 'public.p12_sentinel_rows', column: 'id', type: 'bigint' }],
  foreignKeys: [], functions: ['public.p12_sentinel_fn(uuid)'],
};
const approved = (await canonicalize(contractSubset(parseInventory(await inventory('reader')), requirements))).digest;
const verdict = async () => verifyInventory(await inventory('reader'), requirements, approved);
check('verify_passes_on_the_approved_baseline', (await verdict()).status === 'PASS');
await psql('owner', ['-c', 'alter table public.p12_sentinel_rows add column unrelated int; create trigger p12_unrelated before update on public.p12_sentinel_rows for each row execute function public.p12_trigger_fn()']);
check('verify_ignores_a_change_outside_the_contract', (await verdict()).status === 'PASS');
await psql('owner', ['-c', 'drop trigger p12_unrelated on public.p12_sentinel_rows; alter table public.p12_sentinel_rows drop column unrelated']);
await psql('super', ['-c', "create or replace function public.p12_sentinel_fn(p uuid) returns text language plpgsql security definer set search_path = public, pg_temp set app.p12_token = 'x' as $f$ begin return 'changed'; end $f$"]);
const stopped = await verdict();
check('verify_stops_on_a_change_inside_the_contract', stopped.status === 'STOP' && /differs from the approved one/u.test(stopped.detail), stopped.detail);
await psql('owner', ['-c', 'alter table public.p12_sentinel_rows alter column secret_note type varchar(40)']);
const typed = await verdict();
check('verify_stops_on_a_type_change', typed.status === 'STOP' && /COLUMN_TYPE/u.test(typed.detail), typed.detail);
await psql('owner', ['-c', 'alter table public.p12_sentinel_rows alter column secret_note type text']);

await Deno.remove(scratchDir, { recursive: true });
console.log(failures === 0 ? 'P12_INVENTORY_ALL_PASS' : `P12_INVENTORY_FAILURES|${failures}`);
Deno.exit(failures === 0 ? 0 : 1);
