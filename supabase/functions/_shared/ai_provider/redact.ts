// Removal of credentials from any text that could leave the provider layer (detail strings, identifiers).
// Provider error messages are never passed through at all (see errors.ts); this is the second line of defence.

const PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/gu,
  /sk-[A-Za-z0-9_-]{12,}/gu,
  /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/giu,
  /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/gu,
  /(x-api-key|api[_-]?key|authorization)\s*[:=]\s*\S+/giu,
];

/** Replace credential-looking substrings with [REDACTED]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

/**
 * A short, single-line, credential-free identifier: only [A-Za-z0-9_.:-] survive, then truncated. Used for
 * provider error types / codes and refusal categories, which are enumerations but arrive from the network.
 */
export function safeToken(value: unknown, maxLength = 64): string | null {
  if (typeof value !== "string" || value === "") return null;
  const cleaned = redactSecrets(value).replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, maxLength);
  return cleaned === "" ? null : cleaned;
}
