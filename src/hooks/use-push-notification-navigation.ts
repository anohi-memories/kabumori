import { useEffect, useRef } from 'react';
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
  const handledResponseId = useRef<string | null>(null);

  useEffect(() => {
    if (!session) return;

    function handleResponse(response: Notifications.NotificationResponse) {
      const responseId = response.notification.request.identifier;
      if (handledResponseId.current === responseId) return;
      handledResponseId.current = responseId;

      const data = response.notification.request.content.data as { source_type?: string } | undefined;
      if (data?.source_type === 'important_news') {
        router.push('/news');
      }
    }

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      handleResponse(response);
    });

    // When the app is cold-launched from a notification tap, the response can
    // exist before the listener is attached. Read it once after auth is ready
    // and pass it through the same deduplicated routing boundary.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (response) handleResponse(response);
      })
      .catch(() => {
        // A response lookup failure must not block app startup or navigation.
      });

    return () => subscription.remove();
  }, [session]);
}
