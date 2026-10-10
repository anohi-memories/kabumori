// Credential-shape detection for the evaluation data.
//
// A single loose pattern (the letters "sk" and a hyphen, then 20 or more word characters or hyphens) fires on ordinary
// article URLs whose slug ends a word in "sk" ("...kramatorsk-as-russia..."). Excluding whole files would hide real leaks, so the scan is
// split by what a string is: free text is checked against the full set of credential shapes, and URLs are checked against the
// shapes a credential can take inside a URL (provider-prefixed keys, JWTs, and secret-looking query parameters) without the
// loose "sk-" rule that slugs trip over.

export type Finding = { path: string; kind: string };

type Shape = readonly [kind: string, pattern: RegExp];

/** Shapes that are specific enough to be safe in free text and in URLs. */
const SPECIFIC_SHAPES: readonly Shape[] = [
  ["anthropic_key", /sk-ant-[A-Za-z0-9_-]{16,}/],
  ["openai_project_key", /sk-proj-[A-Za-z0-9_-]{16,}/],
  ["openai_legacy_key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["aws_access_key_id", /\bAKIA[0-9A-Z]{16}\b/],
  ["github_token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/],
];

/** The loose rule the harness has always used for free text. It is not applied to URLs. */
const LOOSE_FREE_TEXT: Shape = ["loose_sk_key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/];

const ASSIGNMENT: Shape = ["key_assignment", /\b(?:api[_-]?key|secret|access[_-]?token|password)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{20,}/i];

const URL_QUERY_SECRET = /[?&](?:api[_-]?key|key|token|access_token|secret|password|auth|signature|sig)=[A-Za-z0-9_\-./+%]{12,}/i;

const looksLikeUrl = (value: string) => /^https?:\/\//i.test(value.trim());

export function scanText(value: string): string[] {
  const kinds = SPECIFIC_SHAPES.filter(([, pattern]) => pattern.test(value)).map(([kind]) => kind);
  for (const [kind, pattern] of [LOOSE_FREE_TEXT, ASSIGNMENT]) if (pattern.test(value)) kinds.push(kind);
  return [...new Set(kinds)];
}

export function scanUrl(value: string): string[] {
  const kinds = SPECIFIC_SHAPES.filter(([, pattern]) => pattern.test(value)).map(([kind]) => kind);
  if (URL_QUERY_SECRET.test(value)) kinds.push("secret_query_parameter");
  // userinfo in the URL (https://user:pass@host/) is a credential even without a recognisable shape.
  if (/^https?:\/\/[^/\s@]+:[^/\s@]+@/i.test(value)) kinds.push("url_userinfo");
  return [...new Set(kinds)];
}

/** Walks any JSON value; every string is scanned according to what it is. Object keys are scanned as text too. */
export function scanJson(value: unknown, path = "$"): Finding[] {
  const out: Finding[] = [];
  if (typeof value === "string") {
    const kinds = looksLikeUrl(value) ? scanUrl(value) : scanText(value);
    for (const kind of kinds) out.push({ path, kind });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => out.push(...scanJson(item, `${path}[${index}]`)));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      for (const kind of scanText(key)) out.push({ path: `${path}.<key:${key.slice(0, 20)}>`, kind });
      out.push(...scanJson(item, `${path}.${key}`));
    }
  }
  return out;
}
