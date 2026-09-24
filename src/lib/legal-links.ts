// Privacy / Terms / Support entry points.
//
// Every public page lives under one Kabumori web origin (apps/kabumori-web, published on Netlify),
// so the app is configured with that single origin and derives each page from the route table
// below — no per-page URL strings to drift apart. The same routes are built by
// apps/kabumori-web/build.mjs, and a test checks the two tables match.
//
// The origin is read from EXPO_PUBLIC_KABUMORI_WEB_URL at build time. Until it is set to a real
// https origin the entries are still shown, but each explains its own state instead of opening a
// link that would 404 in App Store review.

export type LegalLinkKey = 'privacy' | 'terms' | 'support';

/** Every public route the app or App Store Connect points at. */
export const PUBLIC_WEB_ROUTES = {
  privacy: '/privacy',
  terms: '/terms',
  support: '/support',
  accountDeletion: '/account-deletion',
} as const;

export type LegalLink = {
  key: LegalLinkKey;
  label: string;
  url: string | null;
  /** Shown instead of opening a browser while `url` is null. */
  unavailableMessage: string;
};

const LABELS: Record<LegalLinkKey, string> = {
  privacy: 'プライバシーポリシー',
  terms: '利用規約',
  support: 'お問い合わせ・サポート',
};

/**
 * Accepts only a bare https origin (optionally with a trailing slash). Anything else — a path, a
 * query, http, a placeholder — is treated as unset, so the app never opens a malformed page.
 */
export function normalizeWebOrigin(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(:\d+)?\/?$/i.test(value)) return null;
  return value.replace(/\/$/, '');
}

export function publicWebUrl(origin: string | null, route: string): string | null {
  return origin ? `${origin}${route}` : null;
}

export function buildLegalLinks(env: Record<string, string | undefined>): LegalLink[] {
  const origin = normalizeWebOrigin(env.EXPO_PUBLIC_KABUMORI_WEB_URL);
  const keys: LegalLinkKey[] = ['privacy', 'terms', 'support'];
  return keys.map((key) => ({
    key,
    label: LABELS[key],
    url: publicWebUrl(origin, PUBLIC_WEB_ROUTES[key]),
    unavailableMessage: `${LABELS[key]}は準備中です。公開までは、アプリストアの開発者連絡先からご連絡ください。`,
  }));
}

/**
 * Reads the configured origin. `process.env.EXPO_PUBLIC_KABUMORI_WEB_URL` stays written out
 * literally because Expo substitutes it at build time; it is resolved on call rather than at
 * import so the pure builder above stays testable without process environment access.
 */
export function legalLinks(): LegalLink[] {
  return buildLegalLinks({
    EXPO_PUBLIC_KABUMORI_WEB_URL: process.env.EXPO_PUBLIC_KABUMORI_WEB_URL,
  });
}
