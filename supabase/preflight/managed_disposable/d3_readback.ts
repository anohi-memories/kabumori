// The settings READ-BACK SHEET of the hosted disposable project (F5 Phase 13, D-3). SOURCE ONLY, PURE, OFFLINE.
//
// The repository has no supabase/config.toml, so Auth providers, redirect URLs, JWT expiry, exposed schemas, the function list and
// the secret NAMES live in the project, not in git. After PG4 / PG5 the owner reads them from the dashboard and writes them into a
// sheet (a JSON object, kept outside git). This file is the acceptance rule for that sheet: it decides, never reads a project, a
// file or the network, and it fails CLOSED -- a missing field, an unknown name or an unexpected value is a STOP, never a pass.
//
// What the sheet holds: ref hash, plan, flags, names, counts, digests. It never holds a key, a URL with a host, a password or a
// secret VALUE; any secret-shaped text anywhere in it is itself a STOP.
import { secretFindings } from './inventory.ts';

export const READBACK_SCHEMA = 1;
export const SIDE_EFFECTS_ATTESTATION = 'no-x-no-ai-no-real-email';
/** The names the platform provides to a function; anything else must be reviewed by a person (the new key system may add names). */
export const DEFAULT_PLATFORM_SECRET_NAMES = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL'] as const;
export const FORBIDDEN_EXTENSIONS = ['pg_cron', 'pg_net', 'http', 'pgsql_http'] as const;
/** Schemas that may be exposed through the REST API: `public` is needed; `graphql_public` is a platform default; nothing else. */
export const ALLOWED_EXPOSED_SCHEMAS = ['public', 'graphql_public'] as const;
/** Names of secrets of other systems: never present on the disposable project. */
const FORBIDDEN_SECRET_NAME = /(^|_)(X|TWITTER|THREADS|META|INSTAGRAM|OPENAI|ANTHROPIC|CLAUDE|GEMINI|APPLE|GOOGLE|SMTP|RESEND|SENDGRID|EXPO|PUSH|STRIPE|VAULT)(_|$)|CLIENT_SECRET|API_KEY|TOKEN/iu;

export const READBACK_CODES = [
  'SHEET_SHAPE', 'SECRET_SHAPED', 'IDENTITY_PRODUCTION', 'IDENTITY_NOT_NEW', 'IDENTITY_MARKER_MISMATCH',
  'PROVIDER_NOT_ALLOWED', 'PROVIDER_EMAIL_OFF', 'ANONYMOUS_ON', 'SIGNUPS_CLOSED', 'AUTOCONFIRM_OFF',
  'REDIRECT_WILDCARD', 'REDIRECT_UNEXPECTED', 'REDIRECT_MISSING', 'JWT_EXPIRY_INVALID', 'JWT_EXPIRY_UNUSUAL',
  'SCHEMA_EXPOSED_NOT_ALLOWED', 'SCHEMA_PUBLIC_NOT_EXPOSED', 'EDGE_FUNCTION_NOT_ALLOWED', 'EDGE_FUNCTION_MISSING',
  'EDGE_VERIFY_JWT_OFF', 'EDGE_DIGEST_MISMATCH', 'EDGE_NOT_EMPTY', 'SECRET_NAME_FORBIDDEN', 'SECRET_NAME_UNKNOWN',
  'EXTENSION_FORBIDDEN', 'COUNTS_MISSING', 'COUNT_NOT_ZERO', 'ATTESTATION_MISSING',
] as const;
export type ReadbackCode = (typeof READBACK_CODES)[number];
export type ReadbackFinding = { code: ReadbackCode; severity: 'stop' | 'warn'; detail: string };
export type ReadbackReport = { ok: boolean; findings: ReadbackFinding[] };

export type ReadbackOptions = {
  /** `created` = right after PG4 (nothing deployed, no schema yet); `deployed` = after PG5 (the function and the counts must be there) */
  stage: 'created' | 'deployed';
  /** SHA-256 hex of every production ref (the repository's own refs, hashed by the caller) */
  productionRefSha256: readonly string[];
  /** `both-exact` = both app URLs exactly (F4's preflight); `auth-only` = only the auth-callback URL */
  redirectPolicy: 'both-exact' | 'auth-only';
  /** the Edge functions that may exist and the digest each must have, by name */
  expectedFunctions: Readonly<Record<string, string>>;
  /** providers that may be enabled (default: e-mail only, the first pass) */
  allowedProviders?: readonly string[];
  platformSecretNames?: readonly string[];
};

export const APP_SCHEME = 'kabumori-social';
const HEX64 = /^[0-9a-f]{64}$/u;
const COUNT_KEYS = ['cronJobs', 'networkTriggers', 'storageObjects', 'vaultSecrets', 'pushTokens', 'socialAccounts', 'scheduledPosts'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

export function checkReadbackSheet(sheet: unknown, options: ReadbackOptions): ReadbackReport {
  const findings: ReadbackFinding[] = [];
  const stop = (code: ReadbackCode, detail: string) => { findings.push({ code, severity: 'stop', detail }); };
  const warn = (code: ReadbackCode, detail: string) => { findings.push({ code, severity: 'warn', detail }); };
  const finish = (): ReadbackReport => ({ ok: findings.every((finding) => finding.severity !== 'stop'), findings });

  if (!isRecord(sheet) || sheet.schema !== READBACK_SCHEMA) {
    stop('SHEET_SHAPE', 'the sheet is not an object of the supported schema');
    return finish();
  }
  // the sheet is checked as text first: a sheet that carries a key, a URL or a connection string is refused whole
  if (secretFindings(JSON.stringify(sheet)).length > 0) {
    stop('SECRET_SHAPED', 'secret-shaped text is present: the sheet is not to be kept or shared');
    return finish();
  }
  const { identity, auth, api, edge, secrets, database } = sheet;
  if (!isRecord(identity) || !isRecord(auth) || !isRecord(api) || !isRecord(edge) || !isRecord(secrets) || !isRecord(database)) {
    stop('SHEET_SHAPE', 'a section (identity, auth, api, edge, secrets, database) is missing');
    return finish();
  }

  // ---- identity
  const refHash = identity.refSha256;
  if (typeof refHash !== 'string' || !HEX64.test(refHash)) stop('SHEET_SHAPE', 'identity.refSha256 is not a SHA-256');
  else if (options.productionRefSha256.includes(refHash)) stop('IDENTITY_PRODUCTION', 'the sheet describes a production project');
  if (identity.organizationHoldsProduction !== false) stop('IDENTITY_PRODUCTION', 'the organization holds production, or the sheet does not say');
  if (identity.createdAs !== 'new_project') stop('IDENTITY_NOT_NEW', 'the project was not created as a new empty project (a branch, restore or fork carries data)');
  if (identity.plan !== 'free' && identity.plan !== 'pro') stop('SHEET_SHAPE', 'identity.plan is neither free nor pro');
  if (typeof identity.regionLabel !== 'string' || identity.regionLabel.trim() === '') stop('SHEET_SHAPE', 'identity.regionLabel is empty');

  // ---- auth
  const allowedProviders = options.allowedProviders ?? ['email'];
  if (!isStrings(auth.providersEnabled)) stop('SHEET_SHAPE', 'auth.providersEnabled is not a list of names');
  else {
    if (!auth.providersEnabled.includes('email')) stop('PROVIDER_EMAIL_OFF', 'the e-mail provider is off: nothing can be tested');
    for (const provider of auth.providersEnabled) if (!allowedProviders.includes(provider)) stop('PROVIDER_NOT_ALLOWED', `provider ${provider} is on; the first pass allows ${allowedProviders.join(', ')} only`);
  }
  if (auth.anonymousSignIns !== false) stop('ANONYMOUS_ON', 'anonymous sign-ins are on, or the sheet does not say');
  if (typeof auth.signUpsOpen !== 'boolean') stop('SHEET_SHAPE', 'auth.signUpsOpen is not a boolean');
  else if (!auth.signUpsOpen) warn('SIGNUPS_CLOSED', 'sign-ups are closed: M2 and M4 cannot create users through sign-up');
  if (typeof auth.emailAutoconfirm !== 'boolean') stop('SHEET_SHAPE', 'auth.emailAutoconfirm is not a boolean');
  else if (!auth.emailAutoconfirm) warn('AUTOCONFIRM_OFF', 'e-mail confirmation is on: the built-in sender reaches only the organization team, a few messages an hour');
  if (!isStrings(auth.redirectUrls)) stop('SHEET_SHAPE', 'auth.redirectUrls is not a list');
  else {
    const authCallback = `${APP_SCHEME}://auth-callback`;
    const required = options.redirectPolicy === 'both-exact' ? [authCallback, `${APP_SCHEME}://oauth-callback`] : [authCallback];
    for (const url of auth.redirectUrls) {
      if (/[*?[\]]/u.test(url)) stop('REDIRECT_WILDCARD', 'a redirect entry contains a wildcard character');
      else if (!required.includes(url)) stop('REDIRECT_UNEXPECTED', 'a redirect entry is not one of the exact app URLs');
    }
    for (const url of required) if (!auth.redirectUrls.includes(url)) stop('REDIRECT_MISSING', `${url} is not in the list`);
  }
  if (!Number.isInteger(auth.jwtExpirySeconds) || (auth.jwtExpirySeconds as number) <= 0) stop('JWT_EXPIRY_INVALID', 'auth.jwtExpirySeconds is not a positive whole number');
  else if ((auth.jwtExpirySeconds as number) < 300 || (auth.jwtExpirySeconds as number) > 3600) warn('JWT_EXPIRY_UNUSUAL', 'the provider recommends 5 minutes to 1 hour; the expired-token check may need a value outside it');

  // ---- api
  if (!isStrings(api.exposedSchemas)) stop('SHEET_SHAPE', 'api.exposedSchemas is not a list');
  else {
    if (!api.exposedSchemas.includes('public')) stop('SCHEMA_PUBLIC_NOT_EXPOSED', 'public is not exposed: PostgREST checks cannot run');
    for (const schema of api.exposedSchemas) if (!(ALLOWED_EXPOSED_SCHEMAS as readonly string[]).includes(schema)) stop('SCHEMA_EXPOSED_NOT_ALLOWED', `schema ${schema} is exposed through the REST API`);
  }

  // ---- edge functions
  if (!Array.isArray(edge.functions) || !edge.functions.every((fn) => isRecord(fn) && typeof fn.name === 'string' && typeof fn.verifyJwt === 'boolean' && typeof fn.sha256 === 'string')) {
    stop('SHEET_SHAPE', 'edge.functions is not a list of { name, verifyJwt, sha256 }');
  } else {
    const functions = edge.functions as { name: string; verifyJwt: boolean; sha256: string }[];
    if (options.stage === 'created' && functions.length > 0) stop('EDGE_NOT_EMPTY', 'a function exists on a project that should still be empty');
    for (const fn of functions) {
      const expected = options.expectedFunctions[fn.name];
      if (expected === undefined) stop('EDGE_FUNCTION_NOT_ALLOWED', `function ${fn.name} is not on the allowed list`);
      else if (!HEX64.test(fn.sha256) || fn.sha256 !== expected) stop('EDGE_DIGEST_MISMATCH', `function ${fn.name} does not have the pinned digest`);
      if (!fn.verifyJwt) stop('EDGE_VERIFY_JWT_OFF', `function ${fn.name} does not verify the JWT`);
    }
    if (options.stage === 'deployed') {
      for (const name of Object.keys(options.expectedFunctions)) if (!functions.some((fn) => fn.name === name)) stop('EDGE_FUNCTION_MISSING', `function ${name} is not deployed`);
    }
  }

  // ---- secret NAMES (values are never read)
  if (!isStrings(secrets.names)) stop('SHEET_SHAPE', 'secrets.names is not a list of names');
  else {
    const platform = options.platformSecretNames ?? DEFAULT_PLATFORM_SECRET_NAMES;
    for (const name of secrets.names) {
      if (platform.includes(name)) continue;
      if (FORBIDDEN_SECRET_NAME.test(name)) stop('SECRET_NAME_FORBIDDEN', `a secret named ${name} belongs to another system`);
      else stop('SECRET_NAME_UNKNOWN', `a secret named ${name} is not a platform name: a person reviews it first`);
    }
  }

  // ---- database
  if (!isStrings(database.extensions)) stop('SHEET_SHAPE', 'database.extensions is not a list');
  else for (const extension of database.extensions) if ((FORBIDDEN_EXTENSIONS as readonly string[]).includes(extension)) stop('EXTENSION_FORBIDDEN', `extension ${extension} is enabled`);
  if (options.stage === 'deployed') {
    if (database.markerRefSha256 !== refHash) stop('IDENTITY_MARKER_MISMATCH', 'the project marker row does not name this project');
    const counts = database.counts;
    if (!isRecord(counts)) stop('COUNTS_MISSING', 'the counts are missing');
    else for (const key of COUNT_KEYS) {
      if (!Number.isInteger(counts[key])) stop('COUNTS_MISSING', `count ${key} is missing or not a whole number`);
      else if (counts[key] !== 0) stop('COUNT_NOT_ZERO', `count ${key} is not zero`);
    }
  }

  if (sheet.attestation !== SIDE_EFFECTS_ATTESTATION) stop('ATTESTATION_MISSING', 'the side-effect attestation is missing or worded differently');
  return finish();
}
