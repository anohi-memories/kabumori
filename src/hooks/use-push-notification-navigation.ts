import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import type { Session } from '@supabase/supabase-js';

// Routes a tapped push to its content screen. The payload's shape comes from
// buildExpoPushMessage in supabase/functions/send-push-notifications --
// today the only source_type it sends is 'important_news', which always
// lands on the news tab (there is no per-article detail route yet).
// Untestable without a real device/build; see the MVP completion task Report
// for what remains to verify once one exists.
export function usePushNotificationNavigation(session: Session | null) {
  useEffect(() => {
    if (!session) return;

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { source_type?: string } | undefined;
      if (data?.source_type === 'important_news') {
        router.push('/news');
      }
    });
    return () => subscription.remove();
  }, [session]);
}
