// Phase 9 (F5): the two HTTP test seams of the shared sign-in proof, used by common_account_phase9_shared_login_test.ts.
//
//   FAKE GOTRUE     /auth/v1/signup, /token (password | refresh_token | id_token), /logout, /user, /admin/users/:id
//                   -- creates real rows in the disposable database's stand-in `auth` schema (users, identities,
//                   sessions) and mints HS256 access tokens with sub / session_id / role / is_anonymous / exp. It is a
//                   MODEL of the documented behaviour (unique e-mail, unique provider subject, refresh-token rotation,
//                   a session row that dies on sign-out). What the real GoTrue does can only be proven in a managed
//                   disposable project (docs/common-account/phase9-shared-login-enrollment.md section 9).
//   FAKE POSTGREST  /rest/v1/rpc/<name> -- verifies the token and its expiry, takes the database role and the claims
//                   from it, calls ONLY an exposed public RPC, in ONE transaction as that role, and maps the SQLSTATE
//                   to an HTTP status the way PostgREST does. The SQL behind it is the repository's own.
//
// No supabase-js, no network: fetch against 127.0.0.1 only. Every id, key and token is fake.
const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ---- database access ---------------------------------------------------------------------------------------------
export type PsqlResult = { ok: boolean; out: string; err: string };
export async function psql(statement: string, options: { database?: string; verbose?: boolean } = {}): Promise<PsqlResult> {
  const out = await new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', ...(options.verbose ? ['-v', 'VERBOSITY=verbose'] : []), '-c', statement],
    env: {
      PGHOST: Deno.env.get('PGHOST') ?? '', PGPORT: Deno.env.get('PGPORT') ?? '', PGUSER: Deno.env.get('PGUSER') ?? '',
      PGDATABASE: options.database ?? Deno.env.get('PGDATABASE') ?? '', LC_ALL: 'C',
    },
    stdout: 'piped', stderr: 'piped',
  }).output();
  return { ok: out.success, out: decoder.decode(out.stdout).trim(), err: decoder.decode(out.stderr).trim() };
}
export async function sql(statement: string, database?: string): Promise<string> {
  const result = await psql(statement, { database });
  if (!result.ok) throw new Error(result.err);
  return result.out;
}
export const lit = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

// ---- HS256 -------------------------------------------------------------------------------------------------------
const b64url = (input: Uint8Array | string) => {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};
const unb64url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
const hmacKey = (secret: Uint8Array) => crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export const APIKEY = 'phase9-publishable-stand-in';
export const SERVICE_KEY = 'phase9-service-stand-in';

export type Claims = Record<string, unknown>;
export type SeamOptions = {
  /** public RPCs the fake PostgREST exposes (the default is the reviewed enrollment set) */
  exposed?: readonly string[];
  /** false: sign-up answers a user and NO session until the e-mail is confirmed (the default of a hosted project) */
  autoconfirm?: boolean;
  /** how a provider sign-in whose verified e-mail already belongs to a login is treated */
  linking?: 'verified_email' | 'never';
  accessTtlSeconds?: number;
  /** the disposable database both seams use (default: PGDATABASE) */
  database?: string;
};

export const ENROLLMENT_RPCS = [
  'start_kabumori_service', 'start_x_autopost_service', 'reactivate_kabumori_service', 'reactivate_x_autopost_service', 'ensure_my_profile',
] as const;

type Tokens = { access_token: string; refresh_token: string; expires_in: number; token_type: 'bearer'; user: { id: string; email: string | null } };
export type Hit = { path: string; status: number; sub?: unknown; role?: unknown };

export type Seams = {
  baseUrl: string;
  hits: Hit[];
  /** seconds added to the fake clock (token minting and expiry); the database clock is the real one */
  advance(seconds: number): void;
  mint(claims: Claims, options?: { secret?: 'wrong' }): Promise<string>;
  stop(): Promise<void>;
};

export function startSeams(options: SeamOptions = {}): Promise<Seams> {
  const q = (statement: string) => sql(statement, options.database);
  const exposed = new Set<string>(options.exposed ?? ENROLLMENT_RPCS);
  const autoconfirm = options.autoconfirm ?? true;
  const linking = options.linking ?? 'verified_email';
  const ttl = options.accessTtlSeconds ?? 3600;
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const wrongSecret = crypto.getRandomValues(new Uint8Array(32));
  const hits: Hit[] = [];
  let skew = 0;
  const now = () => Math.floor(Date.now() / 1000) + skew;

  // model state kept outside the database: passwords, confirmations, refresh tokens
  const passwords = new Map<string, string>();
  const unconfirmed = new Set<string>();
  const refreshTokens = new Map<string, { sessionId: string; userId: string; used: boolean }>();

  const sign = async (claims: Claims, key = secret) => {
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claims));
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(key), encoder.encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(signature)}`;
  };
  const verify = async (token: string): Promise<{ claims: Claims } | 'bad' | 'expired'> => {
    const parts = token.split('.');
    if (parts.length !== 3) return 'bad';
    try {
      const good = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(parts[2]) as BufferSource, encoder.encode(`${parts[0]}.${parts[1]}`));
      if (!good) return 'bad';
      const claims = JSON.parse(decoder.decode(unb64url(parts[1]))) as Claims;
      if (typeof claims.exp !== 'number' || claims.exp <= now()) return 'expired';
      return { claims };
    } catch {
      return 'bad';
    }
  };
  const accessTokenFor = (userId: string, sessionId: string, anonymous = false) => sign({
    aud: 'authenticated', role: 'authenticated', sub: userId, session_id: sessionId, aal: 'aal1',
    is_anonymous: anonymous, iat: now(), exp: now() + ttl,
  });
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const gotrueError = (status: number, code: string, msg: string) => json({ code: status, error_code: code, msg }, status);

  const newSession = async (userId: string, anonymous = false): Promise<Tokens> => {
    const sessionId = await q(`insert into auth.sessions (user_id) values (${lit(userId)}) returning id::text`);
    const refresh = `rt_${crypto.randomUUID()}`;
    refreshTokens.set(refresh, { sessionId, userId, used: false });
    const email = (await q(`select coalesce(email, '') from auth.users where id = ${lit(userId)}`)) || null;
    return { access_token: await accessTokenFor(userId, sessionId, anonymous), refresh_token: refresh, expires_in: ttl, token_type: 'bearer', user: { id: userId, email } };
  };
  const createUser = async (email: string | null, anonymous = false) => {
    return await q(`insert into auth.users (id, email, is_anonymous) values (gen_random_uuid(), ${lit(email)}, ${anonymous}) returning id::text`);
  };

  const gotrue = async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname.slice('/auth/v1'.length);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
    const bearer = /^Bearer (\S+)$/u.exec(req.headers.get('authorization') ?? '')?.[1];
    if (req.method === 'POST' && path === '/signup') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email)) return gotrueError(422, 'validation_failed', 'Unable to validate email address');
      if (password.length < 8) return gotrueError(422, 'weak_password', 'Password should be at least 8 characters.');
      const exists = (await q(`select count(*) from auth.users where lower(email) = ${lit(email)}`)) !== '0';
      if (exists) {
        // autoconfirm: GoTrue says so; confirmation mode: an obfuscated user, nothing created, nothing sent
        if (autoconfirm) return gotrueError(422, 'user_already_exists', 'User already registered');
        return json({ id: crypto.randomUUID(), email, identities: [], aud: 'authenticated', role: '' });
      }
      let userId: string;
      try {
        userId = await createUser(email);
        await q(`insert into auth.identities (user_id, provider, provider_id) values (${lit(userId)}, 'email', ${lit(userId)})`);
      } catch {
        // lost a race against a concurrent sign-up of the same address: the database's unique index decided
        return gotrueError(422, 'user_already_exists', 'User already registered');
      }
      passwords.set(userId, password);
      if (!autoconfirm) {
        unconfirmed.add(userId);
        return json({ id: userId, email, identities: [{ provider: 'email' }], aud: 'authenticated', role: '' });
      }
      return json(await newSession(userId));
    }
    if (req.method === 'POST' && path === '/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        const userId = await q(`select coalesce((select id::text from auth.users where lower(email) = ${lit(email)}), '')`);
        if (!userId || passwords.get(userId) !== body.password) return gotrueError(400, 'invalid_credentials', 'Invalid login credentials');
        if (unconfirmed.has(userId)) return gotrueError(400, 'email_not_confirmed', 'Email not confirmed');
        return json(await newSession(userId));
      }
      if (grant === 'refresh_token') {
        const entry = typeof body.refresh_token === 'string' ? refreshTokens.get(body.refresh_token) : undefined;
        if (!entry || entry.used) return gotrueError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        const live = await q(`select count(*) from auth.sessions where id = ${lit(entry.sessionId)} and user_id = ${lit(entry.userId)}`);
        if (live === '0') return gotrueError(400, 'session_not_found', 'Invalid Refresh Token: Session Not Found');
        entry.used = true;
        const refresh = `rt_${crypto.randomUUID()}`;
        refreshTokens.set(refresh, { sessionId: entry.sessionId, userId: entry.userId, used: false });
        const email = (await q(`select coalesce(email, '') from auth.users where id = ${lit(entry.userId)}`)) || null;
        return json({ access_token: await accessTokenFor(entry.userId, entry.sessionId), refresh_token: refresh, expires_in: ttl, token_type: 'bearer', user: { id: entry.userId, email } });
      }
      if (grant === 'id_token') {
        // a provider's id token, as a JSON string: { sub, email, email_verified }
        const provider = typeof body.provider === 'string' ? body.provider : '';
        let claims: { sub?: string; email?: string; email_verified?: boolean };
        try {
          claims = JSON.parse(String(body.id_token));
        } catch {
          return gotrueError(400, 'bad_jwt', 'invalid id_token');
        }
        if (!['apple', 'google'].includes(provider) || !claims.sub) return gotrueError(400, 'bad_jwt', 'invalid id_token');
        let userId = await q(`select coalesce((select user_id::text from auth.identities where provider = ${lit(provider)} and provider_id = ${lit(claims.sub)}), '')`);
        if (!userId) {
          const email = claims.email?.trim().toLowerCase() ?? null;
          const owner = email ? await q(`select coalesce((select id::text from auth.users where lower(email) = ${lit(email)}), '')`) : '';
          if (owner && linking === 'verified_email' && claims.email_verified === true) {
            userId = owner;
          } else if (owner) {
            return gotrueError(422, 'email_exists', 'A user with this email address has already been registered');
          } else {
            userId = await createUser(email);
          }
          await q(`insert into auth.identities (user_id, provider, provider_id) values (${lit(userId)}, ${lit(provider)}, ${lit(claims.sub)})`);
        }
        return json(await newSession(userId));
      }
      return gotrueError(400, 'unsupported_grant_type', 'unsupported grant type');
    }
    if (req.method === 'POST' && path === '/logout') {
      const checked = bearer ? await verify(bearer) : 'bad';
      if (typeof checked === 'string') return gotrueError(401, 'bad_jwt', 'invalid JWT');
      const scope = url.searchParams.get('scope') ?? 'global';
      const sessionId = String(checked.claims.session_id);
      const userId = String(checked.claims.sub);
      await q(scope === 'local'
        ? `delete from auth.sessions where id = ${lit(sessionId)} and user_id = ${lit(userId)}`
        : scope === 'others'
        ? `delete from auth.sessions where id <> ${lit(sessionId)} and user_id = ${lit(userId)}`
        : `delete from auth.sessions where user_id = ${lit(userId)}`);
      return new Response(null, { status: 204 });
    }
    if (req.method === 'GET' && path === '/user') {
      const checked = bearer ? await verify(bearer) : 'bad';
      if (typeof checked === 'string') return gotrueError(401, 'bad_jwt', 'invalid JWT');
      const live = await q(`select count(*) from auth.sessions where id = ${lit(String(checked.claims.session_id))} and user_id = ${lit(String(checked.claims.sub))}`);
      if (live === '0') return gotrueError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
      const email = await q(`select coalesce(email, '') from auth.users where id = ${lit(String(checked.claims.sub))}`);
      return json({ id: checked.claims.sub, email: email || null, aud: 'authenticated', role: 'authenticated' });
    }
    const admin = /^\/admin\/users\/([0-9a-f-]{36})$/u.exec(path);
    if (admin && req.method === 'DELETE') {
      if (req.headers.get('apikey') !== SERVICE_KEY || bearer !== SERVICE_KEY) return gotrueError(401, 'not_admin', 'User not allowed');
      const gone = await q(`delete from auth.users where id = ${lit(admin[1])} returning 1`);
      return gone === '1' ? json({}) : gotrueError(404, 'user_not_found', 'User not found');
    }
    return gotrueError(404, 'not_found', 'path not found');
  };

  const postgrest = async (req: Request, url: URL): Promise<Response> => {
    const match = /^\/rest\/v1\/rpc\/([a-z_]+)$/u.exec(url.pathname);
    if (req.method !== 'POST' || !match) return json({ code: 'PGRST125', message: 'Invalid path specified in request URL' }, 404);
    const fn = match[1];
    const reply = (status: number, body: unknown, who?: { sub?: unknown; role?: unknown }) => {
      hits.push({ path: url.pathname, status, sub: who?.sub, role: who?.role });
      return json(body, status);
    };
    if (req.headers.get('apikey') !== APIKEY) return reply(401, { code: 'PGRST301', message: 'No API key found in request' });
    const bearer = /^Bearer (\S+)$/u.exec(req.headers.get('authorization') ?? '');
    if (!bearer) return reply(401, { code: 'PGRST302', message: 'Anonymous access is disabled' });
    const checked = await verify(bearer[1]);
    if (checked === 'expired') return reply(401, { code: 'PGRST303', message: 'JWT expired' });
    if (checked === 'bad') return reply(401, { code: 'PGRST301', message: 'JWSError JWSInvalidSignature' });
    const { claims } = checked;
    const who = { sub: claims.sub, role: claims.role };
    if (claims.role !== 'authenticated' && claims.role !== 'anon') return reply(401, { code: '42704', message: 'role does not exist' }, who);
    if (!exposed.has(fn)) return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache` }, who);
    const args = await req.json().catch(() => ({})) as Record<string, unknown>;
    const named: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      if (!/^p_[a-z_]+$/u.test(key) || !['string', 'number', 'boolean'].includes(typeof value)) {
        return reply(400, { code: 'PGRST102', message: 'Invalid request body' }, who);
      }
      named.push(`${key} => ${lit(value)}`);
    }
    // As PostgREST does: the claims travel in request.jwt.claims, the role is the database role, one transaction.
    const result = await psql(
      `begin; set local "request.jwt.claims" = ${lit(JSON.stringify(claims))}; set local role ${claims.role}; `
      + `select to_jsonb(public.${fn}(${named.join(', ')})); commit;`,
      { verbose: true, database: options.database },
    );
    if (result.ok) return reply(200, JSON.parse(result.out), who);
    const error = /ERROR:\s+([0-9A-Z]{5}): ([^\n]*)/u.exec(result.err);
    const state = error?.[1] ?? 'XX000';
    const message = error?.[2] ?? 'internal error';
    if (state === '42883') return reply(404, { code: 'PGRST202', message: `Could not find the function public.${fn} in the schema cache`, details: null, hint: null }, who);
    const status = state === '42501' ? (claims.role === 'anon' ? 401 : 403) : state === '55P03' ? 503 : 400;
    return reply(status, { code: state, message, details: null, hint: null }, who);
  };

  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/auth/v1/')) {
        const response = await gotrue(req, url);
        hits.push({ path: url.pathname, status: response.status });
        return response;
      }
      return await postgrest(req, url);
    } catch (failure) {
      return json({ code: 'XX000', message: String(failure instanceof Error ? failure.message : failure).slice(0, 200) }, 500);
    }
  });
  return Promise.resolve({
    baseUrl: `http://127.0.0.1:${(server.addr as Deno.NetAddr).port}`,
    hits,
    advance: (seconds) => { skew += seconds; },
    mint: (claims, opts) => sign(claims, opts?.secret === 'wrong' ? wrongSecret : secret),
    stop: async () => { await server.shutdown(); },
  });
}

/** What a client does with sign-up / sign-in answers: just enough fetch to drive the model like supabase-js would. */
export async function authCall(
  seams: Seams, path: string, body: unknown, options: { method?: string; bearer?: string; query?: string; apikey?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(`${seams.baseUrl}/auth/v1${path}${options.query ? `?${options.query}` : ''}`, {
    method: options.method ?? 'POST',
    headers: {
      apikey: options.apikey ?? APIKEY,
      ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}
