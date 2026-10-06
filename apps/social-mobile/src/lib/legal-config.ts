import { resolveLegalLinks } from '@/domain/legal-links';

// Static references so Expo inlines the EXPO_PUBLIC_* values into the bundle.
export const LEGAL_LINKS = resolveLegalLinks({
  privacyPolicyUrl: process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL,
  termsUrl: process.env.EXPO_PUBLIC_TERMS_URL,
  supportUrl: process.env.EXPO_PUBLIC_SUPPORT_URL,
  supportEmail: process.env.EXPO_PUBLIC_SUPPORT_EMAIL,
});
