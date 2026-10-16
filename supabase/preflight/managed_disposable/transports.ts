// The real transports of the managed-disposable harness: HTTP with fetch, SQL with psql. SOURCE ONLY -- built and
// unit-tested for argument construction, never used against a managed project in this phase (cli.ts constructs them
// only after the target guard accepted a separately approved project).
//
// Secrets: keys come from the environment and live in this object only; the database URL is split into libpq
// environment variables for the child process, so no secret is ever in an argument list (visible in `ps`).
import { parseDbUrl } from './guard.ts';
import type { HttpRequest, HttpResponse, Transport } from './runner.ts';

export type PsqlInvocation = { args: string[]; env: Record<string, string>; stdin?: string };
type PsqlMode = 'read' | 'apply' | 'probe' | 'hold';

/** Builds one psql child invocation. Pure: nothing is executed here. */
export function psqlInvocation(dbUrl: string, mode: PsqlMode, input: string): PsqlInvocation {
  const parsed = new URL(dbUrl);
  if (!parseDbUrl(dbUrl)) throw new Error('not a postgres URL');
  const options = {
    read: '-c default_transaction_read_only=on -c statement_timeout=30000',
    probe: '-c default_transaction_read_only=on -c statement_timeout=60000 -c kabumori.disposable_probe=yes',
    apply: '-c lock_timeout=5000',
    hold: '-c lock_timeout=5000',
  }[mode];
  const env: Record<string, string> = {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.replace(/^\//u, '')) || 'postgres',
    PGSSLMODE: 'require',
    PGCONNECT_TIMEOUT: '10',
    PGOPTIONS: options,
    LC_ALL: 'C',
  };
  const base = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
  if (mode === 'apply' || mode === 'probe') return { args: [...base, '-f', '-'], env, stdin: input };
  return { args: [...base, '-c', input], env };
}

export type RealConfig = { baseUrl: string; publishableKey: string; serviceKey: string; dbUrl: string };

export function createRealTransport(config: RealConfig): Transport {
  const psql = async (invocation: PsqlInvocation): Promise<string> => {
    const child = new Deno.Command('psql', {
      args: invocation.args, env: { ...invocation.env }, clearEnv: true,
      stdin: invocation.stdin === undefined ? 'null' : 'piped', stdout: 'piped', stderr: 'piped',
    }).spawn();
    if (invocation.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(invocation.stdin));
      await writer.close();
    }
    const out = await child.output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).split('\n').find((line) => /ERROR/u.test(line))?.slice(0, 200) ?? 'psql failed');
    return new TextDecoder().decode(out.stdout).trim();
  };
  return {
    async http(request: HttpRequest): Promise<HttpResponse> {
      const url = new URL(`${config.baseUrl}${request.path}`);
      for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
      const headers: Record<string, string> = {};
      if (request.key === 'publishable') headers.apikey = config.publishableKey;
      if (request.key === 'service') headers.apikey = config.serviceKey;
      const bearer = request.bearer ?? (request.key === 'service' ? config.serviceKey : request.key === 'publishable' ? config.publishableKey : undefined);
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      if (request.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(url, {
        method: request.method, headers, redirect: 'error',
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text === '' ? null : JSON.parse(text);
      } catch {
        body = text.slice(0, 300);
      }
      return { status: response.status, body };
    },
    sqlRead: (query) => psql(psqlInvocation(config.dbUrl, 'read', query)),
    sqlApplyFile: (_path, bytes) => psql(psqlInvocation(config.dbUrl, 'apply', bytes)),
    sqlProbe: async (path) => psql(psqlInvocation(config.dbUrl, 'probe', await Deno.readTextFile(path))),
    sqlHoldLock: (query, seconds) => {
      const hold = psqlInvocation(config.dbUrl, 'hold', `begin; ${query}; select pg_sleep(${Math.max(1, Math.floor(seconds))}); commit;`);
      const done = psql(hold).catch(() => '');
      return new Promise((resolve) => setTimeout(() => resolve({ release: async () => { await done; } }), 700));
    },
  };
}
