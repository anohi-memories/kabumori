// Privacy / Terms / Support entry points.
//
// Kabumori has no published legal or support pages yet, and App Store review requires working ones
// before submission. Hardcoding a plausible-looking URL would produce a link that 404s in review,
// so the URLs are configuration: each is read from an EXPO_PUBLIC_* value at build time. Until a
// value is set the entry is still shown, but it explains its own state instead of dead-ending on a
// broken link. The exact values still to be decided are listed in
// docs/mobile-release/ACCOUNT_LIFECYCLE.md.

export type LegalLinkKey = 'privacy' | 'terms' | 'support';

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

function normalize(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  // Only real, openable destinations count as configured. Anything else is treated as unset so the
  // app shows the honest "preparing" state rather than opening something that cannot load.
  if (!/^https:\/\/\S+$/.test(value) && !/^mailto:\S+@\S+$/.test(value)) return null;
  return value;
}

export function buildLegalLinks(
  env: Record<string, string | undefined>,
): LegalLink[] {
  const entries: Array<[LegalLinkKey, string | undefined]> = [
    ['privacy', env.EXPO_PUBLIC_PRIVACY_POLICY_URL],
    ['terms', env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL],
    ['support', env.EXPO_PUBLIC_SUPPORT_URL],
  ];
  return entries.map(([key, raw]) => ({
    key,
    label: LABELS[key],
    url: normalize(raw),
    unavailableMessage: `${LABELS[key]}は準備中です。公開までは、アプリストアの開発者連絡先からご連絡ください。`,
  }));
}

/**
 * Reads the configured values. The three `process.env.EXPO_PUBLIC_*` reads stay written out
 * literally because Expo substitutes them at build time; they are resolved on call rather than at
 * import so the pure builder above stays testable without process environment access.
 */
export function legalLinks(): LegalLink[] {
  return buildLegalLinks({
    EXPO_PUBLIC_PRIVACY_POLICY_URL: process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
    EXPO_PUBLIC_TERMS_OF_SERVICE_URL: process.env.EXPO_PUBLIC_TERMS_OF_SERVICE_URL,
    EXPO_PUBLIC_SUPPORT_URL: process.env.EXPO_PUBLIC_SUPPORT_URL,
  });
}
