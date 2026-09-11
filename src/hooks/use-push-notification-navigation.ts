import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import type { Session } from '@supabase/supabase-js';

import { reportRouteForPush } from '@/lib/report-presentation';

// Routes a tapped push to its content screen. The payload's shape comes from
// buildExpoPushMessage in supabase/functions/send-push-notifications:
// 'important_news' lands on the news tab; 'personalized_report' opens that
// report (source_id is the personalized_reports id).
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

      const data = response.notification.request.content.data as
        { source_type?: string; source_id?: string } | undefined;
      if (data?.source_type === 'important_news') {
        router.push('/news');
        return;
      }
      const reportRoute = reportRouteForPush(data);
      if (reportRoute) {
        router.push(reportRoute as Href);
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
