const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SECRET_HEADER = "x-important-news-cron-secret";

export function isConfiguredImportantNewsCronSecret(value: string | undefined): value is string {
  return typeof value === "string" && SECRET_PATTERN.test(value);
}

export function isValidImportantNewsCronSecret(
  configuredSecret: string | undefined,
  suppliedSecret: string | null,
): boolean {
  if (!isConfiguredImportantNewsCronSecret(configuredSecret) ||
      suppliedSecret === null || !SECRET_PATTERN.test(suppliedSecret)) {
    return false;
  }

  const encoder = new TextEncoder();
  const expected = encoder.encode(configuredSecret);
  const supplied = encoder.encode(suppliedSecret);
  if (expected.length !== supplied.length) return false;

  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ supplied[index];
  }
  return difference === 0;
}

export function importantNewsCronSecretHeader(request: Request): string | null {
  return request.headers.get(SECRET_HEADER);
}
