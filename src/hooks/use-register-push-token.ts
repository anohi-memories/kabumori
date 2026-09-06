import type { Session } from '@supabase/supabase-js';
import { useEffect, useRef } from 'react';

import { registerForPushNotificationsAsync, upsertDevicePushToken } from '@/lib/push-notifications';

// Registers this device's Expo push token once per login (not on every
// re-render), independent of important-news-monitor and any notification
// generation logic -- this hook only ever writes to device_push_tokens.
export function useRegisterPushToken(session: Session | null) {
  const registeredForUserId = useRef<string | null>(null);

  useEffect(() => {
    if (!session) {
      registeredForUserId.current = null;
      return;
    }
    if (registeredForUserId.current === session.user.id) return;

    let cancelled = false;
    void (async () => {
      const result = await registerForPushNotificationsAsync();
      if (cancelled) return;

      if (result.status === 'error') {
        console.warn('[push] registration failed:', result.message);
        return;
      }
      if (result.status !== 'registered') {
        // 'skipped' (simulator/web/no EAS projectId) and 'denied' are expected,
        // non-error outcomes -- nothing to upsert, nothing to retry here.
        return;
      }

      try {
        await upsertDevicePushToken(session.user.id, result.token);
        if (!cancelled) registeredForUserId.current = session.user.id;
      } catch (error) {
        console.warn('[push] token upsert failed:', error instanceof Error ? error.message : error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session]);
}
