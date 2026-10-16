// Target guard of the managed-disposable acceptance harness (F5 Phase 11). SOURCE ONLY: nothing in this directory has
// been run against a managed project, and this file makes no network call and reads no file.
//
// One question: "may this process mutate THIS Supabase project?" The answer is no unless ALL of these hold:
//   * the project ref is named explicitly, is on an explicit allowlist of test-only projects, and the allowlist itself
//     contains no production ref (a polluted allowlist refuses everything);
//   * the production deny list is supplied explicitly (and every ref that appears in the repository's own files is added
//     to it by the caller: the repository only ever names the production project);
//   * the API URL is exactly https://<ref>.supabase.co (no path, port, credentials, other host);
//   * the operator typed the ref again as a confirmation;
//   * the database URL points at the same ref;
//   * the keys are the right kind and are never taken from argv.
// Execution additionally re-verifies the project's own identity (a marker row) before every mutation (runner.ts).
// Pure functions: the environment is passed in, never read from the process.

export const ENV = {
  projectRef: 'KABUMORI_DISPOSABLE_PROJECT_REF',
  allowlist: 'KABUMORI_DISPOSABLE_ALLOWLIST',
  denylist: 'KABUMORI_PRODUCTION_PROJECT_REFS',
  apiUrl: 'KABUMORI_DISPOSABLE_API_URL',
  confirm: 'KABUMORI_DISPOSABLE_CONFIRM',
  publishableKey: 'KABUMORI_DISPOSABLE_PUBLISHABLE_KEY',
  serviceKey: 'KABUMORI_DISPOSABLE_SERVICE_ROLE_KEY',
  dbUrl: 'KABUMORI_DISPOSABLE_DB_URL',
  baselineSha256: 'KABUMORI_DISPOSABLE_BASELINE_SHA256',
  baselinePath: 'KABUMORI_DISPOSABLE_BASELINE_PATH',
  emailDomain: 'KABUMORI_DISPOSABLE_TEST_EMAIL_DOMAIN',
} as const;

/** A Supabase project ref: 20 lowercase letters / digits. (Assumed from the hosted-project URL shape; a test pins it.) */
export const PROJECT_REF = /^[a-z0-9]{20}$/u;
export const HOSTED_HOST = /^([a-z0-9]{20})\.supabase\.co$/u;

export const GUARD_CODES = [
  'TARGET_REF_MISSING', 'TARGET_REF_MALFORMED', 'ALLOWLIST_MISSING', 'ALLOWLIST_MALFORMED', 'TARGET_NOT_ALLOWLISTED',
  'DENYLIST_MISSING', 'DENYLIST_MALFORMED', 'TARGET_IS_PRODUCTION', 'ALLOWLIST_CONTAINS_PRODUCTION',
  'API_URL_MISSING', 'API_URL_INVALID', 'API_URL_REF_MISMATCH', 'CONFIRM_MISSING', 'CONFIRM_MISMATCH',
  'PUBLISHABLE_KEY_MISSING', 'PUBLISHABLE_KEY_WRONG_KIND', 'SERVICE_KEY_MISSING', 'SERVICE_KEY_NOT_A_SERVICE_KEY',
  'DB_URL_MISSING', 'DB_URL_INVALID', 'DB_URL_REF_MISMATCH', 'EMAIL_DOMAIN_MISSING', 'EMAIL_DOMAIN_NOT_CONTROLLED',
  'BASELINE_DIGEST_MISSING', 'BASELINE_PATH_MISSING',
] as const;
export type GuardCode = (typeof GUARD_CODES)[number];

export type Env = Readonly<Record<string, string | undefined>>;
export type GuardFailure = { code: GuardCode; detail: string };
export type Target = { projectRef: string; baseUrl: string; dbHost: string; emailDomain: string };
export type Decision = { ok: true; target: Target; warnings: string[] } | { ok: false; failures: GuardFailure[] };

const trim = (value: string | undefined) => (value ?? '').trim();
const split = (value: string | undefined) => trim(value).split(',').map((item) => item.trim()).filter((item) => item !== '');

/** Public mail providers: a test address there could reach a real person. */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.jp', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'me.com',
  'proton.me', 'protonmail.com', 'aol.com', 'gmx.com', 'mail.com', 'privaterelay.appleid.com',
]);

export type ResolveOptions = {
  /** false (the default): shape checks only, no secret or confirmation is required; the plan is only printed. */
  execute?: boolean;
  /** every project ref found in the repository's own files (always treated as production) */
  repositoryRefs?: readonly string[];
};

/** Resolves the target. A failure list is complete (every broken rule is reported), never just the first. */
export function resolveTarget(env: Env, options: ResolveOptions = {}): Decision {
  const execute = options.execute === true;
  const failures: GuardFailure[] = [];
  const fail = (code: GuardCode, detail: string) => { failures.push({ code, detail }); };

  const ref = trim(env[ENV.projectRef]);
  if (ref === '') fail('TARGET_REF_MISSING', `${ENV.projectRef} is not set`);
  else if (!PROJECT_REF.test(ref)) fail('TARGET_REF_MALFORMED', `${ENV.projectRef} is not a 20-character project ref`);

  const allowlist = split(env[ENV.allowlist]);
  if (allowlist.length === 0) fail('ALLOWLIST_MISSING', `${ENV.allowlist} is not set: there is no implicit test project`);
  else if (!allowlist.every((entry) => PROJECT_REF.test(entry))) fail('ALLOWLIST_MALFORMED', `${ENV.allowlist} has an entry that is not a project ref`);

  const denylist = split(env[ENV.denylist]);
  if (denylist.length === 0) fail('DENYLIST_MISSING', `${ENV.denylist} is not set: production must be named explicitly`);
  else if (!denylist.every((entry) => PROJECT_REF.test(entry))) fail('DENYLIST_MALFORMED', `${ENV.denylist} has an entry that is not a project ref`);
  const production = new Set([...denylist, ...(options.repositoryRefs ?? [])]);

  if (PROJECT_REF.test(ref)) {
    if (allowlist.length > 0 && !allowlist.includes(ref)) fail('TARGET_NOT_ALLOWLISTED', 'the project is not on the allowlist');
    if (production.has(ref)) fail('TARGET_IS_PRODUCTION', 'the project is a production project (deny list or named in the repository)');
  }
  if (allowlist.some((entry) => production.has(entry))) {
    fail('ALLOWLIST_CONTAINS_PRODUCTION', 'the allowlist names a production project: the whole configuration is refused');
  }

  const url = trim(env[ENV.apiUrl]);
  let baseUrl = '';
  if (url === '') fail('API_URL_MISSING', `${ENV.apiUrl} is not set`);
  else {
    const parsed = parseHostedUrl(url);
    if (!parsed) fail('API_URL_INVALID', `${ENV.apiUrl} must be exactly https://<project-ref>.supabase.co`);
    else if (PROJECT_REF.test(ref) && parsed.ref !== ref) fail('API_URL_REF_MISMATCH', 'the API URL names another project than the target ref');
    else baseUrl = parsed.base;
  }

  const emailDomain = trim(env[ENV.emailDomain]).toLowerCase();
  if (emailDomain === '') {
    if (execute) fail('EMAIL_DOMAIN_MISSING', `${ENV.emailDomain} is not set: test addresses need a controlled domain`);
  } else if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/u.test(emailDomain) || PUBLIC_MAIL_DOMAINS.has(emailDomain) || !emailDomain.includes('.')) {
    fail('EMAIL_DOMAIN_NOT_CONTROLLED', 'the test e-mail domain is a public mail provider or malformed');
  }

  let dbHost = '';
  if (execute) {
    const confirmation = trim(env[ENV.confirm]);
    if (confirmation === '') fail('CONFIRM_MISSING', `${ENV.confirm} must repeat the project ref`);
    else if (confirmation !== ref) fail('CONFIRM_MISMATCH', 'the confirmation is not the project ref');

    const publishable = trim(env[ENV.publishableKey]);
    if (publishable === '') fail('PUBLISHABLE_KEY_MISSING', `${ENV.publishableKey} is not set`);
    else if (/service_role|sb_secret_/u.test(publishable) || looksLikeServiceRoleJwt(publishable)) {
      fail('PUBLISHABLE_KEY_WRONG_KIND', 'a service / secret key was given where the publishable key belongs');
    }
    const service = trim(env[ENV.serviceKey]);
    if (service === '') fail('SERVICE_KEY_MISSING', `${ENV.serviceKey} is not set`);
    else if (service === publishable || /^sb_publishable_/u.test(service)) fail('SERVICE_KEY_NOT_A_SERVICE_KEY', 'the service-role key is the publishable key');

    const dbUrl = trim(env[ENV.dbUrl]);
    if (dbUrl === '') fail('DB_URL_MISSING', `${ENV.dbUrl} is not set`);
    else {
      const parsed = parseDbUrl(dbUrl);
      if (!parsed) fail('DB_URL_INVALID', `${ENV.dbUrl} is not a postgres:// URL`);
      else if (!parsed.refs.includes(ref)) fail('DB_URL_REF_MISMATCH', 'the database URL does not name the target project');
      else dbHost = parsed.host;
    }
    if (trim(env[ENV.baselineSha256]) === '') fail('BASELINE_DIGEST_MISSING', `${ENV.baselineSha256} (the SHA-256 of the reviewed baseline schema) is not set`);
    else if (!/^[0-9a-f]{64}$/u.test(trim(env[ENV.baselineSha256]))) fail('BASELINE_DIGEST_MISSING', `${ENV.baselineSha256} is not a SHA-256`);
    if (trim(env[ENV.baselinePath]) === '') fail('BASELINE_PATH_MISSING', `${ENV.baselinePath} (the reviewed baseline schema file) is not set`);
  }

  if (failures.length > 0) return { ok: false, failures };
  const warnings: string[] = [];
  if (!execute) warnings.push('dry run: no project, secret or confirmation was needed or used');
  return { ok: true, target: { projectRef: ref, baseUrl, dbHost, emailDomain }, warnings };
}

/** Accepts exactly `https://<ref>.supabase.co` (an optional single trailing slash); anything else is null. */
export function parseHostedUrl(value: string): { ref: string; base: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.port !== '') return null;
  if (parsed.search !== '' || parsed.hash !== '' || (parsed.pathname !== '/' && parsed.pathname !== '')) return null;
  const host = HOSTED_HOST.exec(parsed.hostname);
  return host ? { ref: host[1], base: `https://${parsed.hostname}` } : null;
}

/** postgres://user:pw@host:port/db -> the refs it names (host db.<ref>.supabase.co, or user postgres.<ref> on a pooler). */
export function parseDbUrl(value: string): { host: string; user: string; refs: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return null;
  if (parsed.hostname === '') return null;
  const refs: string[] = [];
  const direct = /^db\.([a-z0-9]{20})\.supabase\.co$/u.exec(parsed.hostname);
  if (direct) refs.push(direct[1]);
  const pooled = /^postgres\.([a-z0-9]{20})$/u.exec(decodeURIComponent(parsed.username));
  if (pooled && /\.pooler\.supabase\.com$/u.test(parsed.hostname)) refs.push(pooled[1]);
  return { host: parsed.hostname, user: decodeURIComponent(parsed.username), refs };
}

function looksLikeServiceRoleJwt(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  try {
    const claims = JSON.parse(atob(parts[1].replaceAll('-', '+').replaceAll('_', '/'))) as { role?: unknown };
    return claims.role === 'service_role';
  } catch {
    return false;
  }
}

// ---- project refs named in the repository (always production) --------------------------------------------------------

/** Every `<ref>.supabase.co` host in a text. */
export function projectRefsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\b([a-z0-9]{20})\.supabase\.co\b/gu)) found.add(match[1]);
  return [...found].sort();
}

// ---- SQL that must never reach a disposable project ----------------------------------------------------------------

export type SqlFinding = { code: 'FOREIGN_PROJECT_HOST' | 'CRON_SCHEDULE' | 'HTTP_FROM_DATABASE'; detail: string };

/**
 * A file that names ANOTHER project's host, schedules a cron job or calls out over HTTP from the database is refused
 * before it is sent: applied to a disposable project it would arm jobs that call production (eight repository
 * migrations do exactly that).
 */
export function scanSqlForForeignTargets(sql: string, targetRef: string): SqlFinding[] {
  const findings: SqlFinding[] = [];
  const text = sql.replace(/--[^\n]*/gu, '');
  for (const ref of projectRefsIn(text)) {
    if (ref !== targetRef) findings.push({ code: 'FOREIGN_PROJECT_HOST', detail: `names project ${ref.slice(0, 4)}…${ref.slice(-4)}` });
  }
  if (/\bcron\.schedule\s*\(/iu.test(text)) findings.push({ code: 'CRON_SCHEDULE', detail: 'schedules a cron job' });
  if (/\bnet\.http_(post|get|delete)\s*\(/iu.test(text)) findings.push({ code: 'HTTP_FROM_DATABASE', detail: 'calls out over HTTP from the database' });
  return findings;
}

// ---- secrets never leave through a log line --------------------------------------------------------------------------

/** Replaces the given secret values (and any JWT or sb_ key shape) in a text. */
export function makeRedactor(secrets: readonly (string | undefined)[]): (text: string) => string {
  const values = secrets.filter((value): value is string => typeof value === 'string' && value.trim().length >= 8).map((value) => value.trim());
  return (text: string) => {
    let out = text;
    for (const value of values) out = out.split(value).join('[REDACTED]');
    out = out.replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, '[REDACTED_JWT]');
    out = out.replace(/\bsb_(secret|publishable)_[A-Za-z0-9_-]{8,}/gu, '[REDACTED_KEY]');
    out = out.replace(/postgres(ql)?:\/\/[^\s'"]+/gu, 'postgres://[REDACTED]');
    return out;
  };
}
