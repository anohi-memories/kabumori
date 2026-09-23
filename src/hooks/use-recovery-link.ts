import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';

import { parseRecoveryLink, type RecoveryLink } from '@/lib/password-recovery';

/**
 * Watches incoming deep links for a password recovery link.
 *
 * Recovery is handled above the auth gate rather than as a route because the link can arrive in
 * either state: the person is usually signed out (so no route would be mounted), but a recovery
 * link also establishes a session of its own, which would otherwise drop them straight into the
 * app without ever setting a new password.
 *
 * Linking.useURL() reports the URL that launched the app as well as later ones, so a cold start
 * from the email link is handled the same way as a warm one.
 */
export function useRecoveryLink() {
  const url = Linking.useURL();
  const [link, setLink] = useState<RecoveryLink | null>(null);

  useEffect(() => {
    if (!url) return;
    const parsed = parseRecoveryLink(url);
    if (parsed.kind !== 'none') setLink(parsed);
  }, [url]);

  return { link, clearRecoveryLink: () => setLink(null) };
}
