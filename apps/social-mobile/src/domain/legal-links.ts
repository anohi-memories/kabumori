/**
 * Privacy policy / terms / support configuration. Pure (no runtime imports).
 *
 * Values come only from build-time EXPO_PUBLIC_* configuration. Anything
 * missing or invalid is "unavailable" — never guessed, never a placeholder.
 * Diagnostics expose status codes only, never the configured values.
 */

export type LegalLinkId = 'privacy' | 'terms' | 'support';

export type LegalLinkStatus =
  | 'ok'
  | 'missing'
  | 'invalid_url'
  | 'not_https'
  | 'placeholder'
  | 'credential_like';

export type LegalLink = { id: LegalLinkId; status: LegalLinkStatus; href: string | null };

export type LegalLinksInput = {
  privacyPolicyUrl: string | undefined;
  termsUrl: string | undefined;
  supportUrl: string | undefined;
  supportEmail: string | undefined;
};

/** Hosts reserved for documentation/testing or local use are never presented as real. */
const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|localhost|invalid|test|local|example)$/iu;
const IP_HOST = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/iu;
/** Query/fragment names that look like credentials: such a link is refused outright. */
const CREDENTIAL_PARAM = /(token|secret|key|signature|sig|password|auth|session|code)/iu;
const EMAIL = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/u;

export function validateWebLink(value: string | undefined): { status: LegalLinkStatus; href: string | null } {
  const raw = value?.trim();
  if (!raw) return { status: 'missing', href: null };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { status: 'invalid_url', href: null };
  }
  if (parsed.protocol !== 'https:') return { status: 'not_https', href: null };
  if (parsed.username || parsed.password || parsed.port) return { status: 'invalid_url', href: null };
  if (!parsed.hostname.includes('.') || PLACEHOLDER_HOST.test(parsed.hostname) || IP_HOST.test(parsed.hostname)) return { status: 'placeholder', href: null };
  const names = [...parsed.searchParams.keys()];
  if (names.some((name) => CREDENTIAL_PARAM.test(name)) || CREDENTIAL_PARAM.test(parsed.hash)) return { status: 'credential_like', href: null };
  return { status: 'ok', href: parsed.toString() };
}

export function validateSupportEmail(value: string | undefined): { status: LegalLinkStatus; href: string | null } {
  const raw = value?.trim();
  if (!raw) return { status: 'missing', href: null };
  if (!EMAIL.test(raw)) return { status: 'invalid_url', href: null };
  const domain = raw.slice(raw.indexOf('@') + 1);
  if (PLACEHOLDER_HOST.test(domain)) return { status: 'placeholder', href: null };
  return { status: 'ok', href: `mailto:${raw}` };
}

/** Support: a valid https page wins; otherwise a valid e-mail address; otherwise unavailable. */
export function resolveLegalLinks(input: LegalLinksInput): Record<LegalLinkId, LegalLink> {
  const privacy = validateWebLink(input.privacyPolicyUrl);
  const terms = validateWebLink(input.termsUrl);
  const supportPage = validateWebLink(input.supportUrl);
  const supportMail = validateSupportEmail(input.supportEmail);
  const support = supportPage.status === 'ok' ? supportPage
    : supportMail.status === 'ok' ? supportMail
    : supportPage.status !== 'missing' ? supportPage
    : supportMail;
  return {
    privacy: { id: 'privacy', ...privacy },
    terms: { id: 'terms', ...terms },
    support: { id: 'support', ...support },
  };
}

export const LEGAL_LINK_LABELS: Record<LegalLinkId, string> = {
  privacy: 'プライバシーポリシー',
  terms: '利用規約',
  support: 'お問い合わせ',
};

/** Developer/operator-only: ids and status codes, never the configured values. */
export function formatLegalDiagnostics(links: Record<LegalLinkId, LegalLink>): string {
  return `legal: privacy=${links.privacy.status} terms=${links.terms.status} support=${links.support.status}`;
}
