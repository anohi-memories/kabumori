// Deterministic redaction for proof-run evidence (Phase 3c, offline readiness). Every value that could be a
// credential, a token, an authorization code, a person or a project is replaced BEFORE anything is written;
// identifiers become stable per-run placeholders (<kind:8 hex of sha256(salt|value)>) so one run's evidence can
// still be correlated, and different runs cannot be joined. Pure; no network, file or environment access.

const encoder = new TextEncoder();

async function tag(kind: string, salt: string, value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${salt}|${kind}|${value}`)));
  return `<${kind}:${Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, '0')).join('')}>`;
}

/** Already-redacted placeholders are left alone, so redaction is idempotent. */
const PLACEHOLDER = /<[a-z_]+:[0-9a-f]{8}>|<redacted>/u;

type Rule = { kind: string; pattern: RegExp; keep?: (match: RegExpExecArray) => [prefix: string, secret: string, suffix: string] };

// Order matters: whole tokens before their parts, keyed values before bare identifiers.
const RULES: Rule[] = [
  // PEM blocks (private keys, certificates).
  { kind: 'pem', pattern: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/gu },
  // JWTs (access tokens, id tokens, client secrets).
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/gu },
  // Supabase API keys (new format) and service keys by name.
  { kind: 'sbkey', pattern: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{6,}/gu },
  // Authorization header values of any scheme.
  { kind: 'auth', pattern: /\b(Bearer|Basic)\s+([^\s"',;]+)/giu, keep: (m) => [`${m[1]} `, m[2], ''] },
  // apikey / authorization headers written as "name: value".
  { kind: 'header', pattern: /\b(apikey|authorization|x-client-info|cookie|set-cookie)(\s*[:=]\s*)([^\s"',;][^\r\n"']*)/giu, keep: (m) => [`${m[1]}${m[2]}`, m[3], ''] },
  // Sensitive query / form parameters.
  {
    kind: 'param',
    pattern: /([?&#](?:code|state|access_token|refresh_token|provider_token|provider_refresh_token|id_token|token|token_hash|nonce|code_verifier|client_secret|password|apikey)=)([^&#\s"']+)/giu,
    keep: (m) => [m[1], m[2], ''],
  },
  // Secret-named JSON fields ("...secret...": "value", "password": "...", "...token...": "...", "...key...": "...").
  {
    kind: 'field',
    pattern: /("[A-Za-z0-9_]*(?:secret|password|passwd|token|api_?key|private_?key|service_?key|anon_?key|credential)[A-Za-z0-9_]*"\s*:\s*")((?:[^"\\]|\\.)*)(")/giu,
    keep: (m) => [m[1], m[2], m[3]],
  },
  // E-mail addresses.
  { kind: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu },
  // Supabase project hosts and refs.
  { kind: 'ref', pattern: /\b([a-z]{20})(\.supabase\.(?:co|in|com)|\.pooler\.supabase\.com)/gu, keep: (m) => ['', m[1], m[2]] },
  // UUIDs (user, session, identity, operation ids).
  { kind: 'uuid', pattern: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gu },
  // IPv4 addresses.
  { kind: 'ip', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu },
];

async function applyRule(text: string, rule: Rule, salt: string): Promise<string> {
  let out = '';
  let last = 0;
  rule.pattern.lastIndex = 0;
  for (let m = rule.pattern.exec(text); m; m = rule.pattern.exec(text)) {
    const [prefix, secret, suffix] = rule.keep ? rule.keep(m) : ['', m[0], ''];
    out += text.slice(last, m.index);
    if (PLACEHOLDER.test(secret) && secret.replace(PLACEHOLDER, '') === '') out += m[0];
    else out += `${prefix}${await tag(rule.kind, salt, secret)}${suffix}`;
    last = m.index + m[0].length;
    if (m[0].length === 0) rule.pattern.lastIndex += 1;
  }
  out += text.slice(last);
  return out;
}

/**
 * Redacts one piece of evidence. `salt` is the run id (stable within a run). `knownRefs` are project refs that must
 * disappear even when they appear bare (not as a host).
 */
export async function redact(text: string, salt: string, knownRefs: readonly string[] = []): Promise<string> {
  if (!salt) throw new Error('REDACTION_SALT_REQUIRED');
  let out = text;
  for (const rule of RULES) out = await applyRule(out, rule, salt);
  for (const ref of knownRefs) {
    if (!/^[a-z]{20}$/u.test(ref)) throw new Error('REDACTION_REF_INVALID');
    const placeholder = await tag('ref', salt, ref);
    out = out.split(ref).join(placeholder);
  }
  return out;
}

/** Settings whose names contain a secret-like word but whose values are flags or durations. */
const NON_SECRET_DESPITE_NAME = new Set(['hook_custom_access_token_enabled', 'refresh_token_rotation_enabled', 'security_refresh_token_reuse_interval']);

/** Keeps only allowlisted, non-secret fields of a configuration object (values that are not scalars are dropped). */
export function allowlist(config: Record<string, unknown>, fields: readonly string[]): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    if (/secret|pass|token|key|credential|cookie/iu.test(field) && !NON_SECRET_DESPITE_NAME.has(field)) {
      throw new Error(`ALLOWLIST_FIELD_LOOKS_SECRET:${field}`);
    }
    const value = config[field];
    out[field] = value === undefined ? null : (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') ? value : null;
  }
  return out;
}

/** The E1 configuration fields that may be recorded (all non-secret; verified against the public Management API schema). */
export const E1_CONFIG_ALLOWLIST = [
  'security_manual_linking_enabled',
  'api_max_request_duration',
  'jwt_exp',
  'sessions_timebox',
  'sessions_inactivity_timeout',
  'sessions_single_per_user',
  'hook_custom_access_token_enabled',
  'refresh_token_rotation_enabled',
  'security_refresh_token_reuse_interval',
  'external_anonymous_users_enabled',
  'disable_signup',
  'mailer_autoconfirm',
] as const;
