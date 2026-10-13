// Comparison fixtures are copied from production rows. Only public news / disclosure text is kept, and contact details
// and named individuals' roles are stripped before anything is written into the repository.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 03-1234-5678, 0120-123-456, (03)1234-5678, +81 3 1234 5678
const PHONE = /(?:\+81[\s-]?)?\(?0\d{1,4}\)?[\s-]\d{1,4}[\s-]\d{3,4}/g;
// Whole lines that name a spokesperson or contact (kept short: they never carry the news itself).
const CONTACT_LINE = /^\s*(?:代\s*表\s*者\s*名|代表取締役社長?\s|問\s*合\s*せ\s*先|問\s*い\s*合\s*わ\s*せ\s*先|担\s*当\s*者|連\s*絡\s*先|責任者)/;

export const MAX_BODY_CHARS = 1800;

export function sanitizeBody(body: string | null, maxChars: number = MAX_BODY_CHARS): string | null {
  if (body === null) return null;
  const kept = body
    .split("\n")
    .filter((line) => !CONTACT_LINE.test(line))
    .map((line) => line.replace(EMAIL, "[email]").replace(PHONE, "[tel]"))
    .join("\n")
    .trim();
  if (kept.length <= maxChars) return kept;
  const cut = kept.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf("。"));
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trim();
}

export function containsContactDetails(text: string): boolean {
  EMAIL.lastIndex = 0;
  PHONE.lastIndex = 0;
  return EMAIL.test(text) || PHONE.test(text);
}
