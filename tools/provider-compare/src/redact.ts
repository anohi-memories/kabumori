// Secrets must never reach a log line, a result file or a thrown message. Every provider error path and every
// CLI print goes through redactSecrets; results are additionally checked by assertNoSecrets before they are written.

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  /(x-api-key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
];

export const REDACTED = "[REDACTED]";

export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 6) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED
    );
  }
  return out;
}

export class SecretLeakError extends Error {
  constructor() {
    super("SECRET_LEAK_DETECTED");
    this.name = "SecretLeakError";
  }
}

/** Throws (without echoing the text) when serialised output still contains a known key or a key-shaped string. */
export function assertNoSecrets(serialised: string, knownSecrets: readonly string[] = []): void {
  if (redactSecrets(serialised, knownSecrets) !== serialised) throw new SecretLeakError();
}
