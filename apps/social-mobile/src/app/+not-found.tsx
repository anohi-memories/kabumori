// The screen for a link this app does not have (G1/F1, source-only, 2026-10-20; G2 QA U2).
//
// expo-router shows its own "Unmatched Route" screen when no `+not-found` route exists. That screen is in English,
// prints the URL that was received (path and, through `createURL`, everything it was built from) and links to the
// internal `/_sitemap`. A link that arrives from outside the app -- a mistyped or forged deep link, one carrying a
// `?token=...` query -- must not be echoed back to the person, written to a log or turned into a route list.
//
// So this screen reads NOTHING about the link: no pathname, no search params, no segments, no route state, and it
// takes no props. It says one thing in Japanese and offers one safe way out: the home screen. It has no log call and
// touches no sign-in, OAuth or callback logic.
//
// What this file does NOT do: it does not remove the `/_sitemap` route (that is the expo-router `sitemap` option of
// the shared app config, which is not owned here); it only stops the not-found screen from showing it or linking to it.
import { Link } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text, View } from 'react-native';
import { colors, spacing } from '@/constants/theme';
import { ActionButton, Screen, styles } from '@/components/ui';

export default function NotFoundScreen() {
  return (
    <Screen>
      {/* Drawn on the fixed light background: dark status bar text (the root layout follows the device appearance). */}
      <StatusBar style="dark" />
      <View style={{ flex: 1, justifyContent: 'center', gap: spacing.md }}>
        <Text accessibilityRole="header" style={{ color: colors.ink, fontSize: 22, fontWeight: '800' }}>ページが見つかりません</Text>
        <Text style={styles.muted}>開こうとしたリンクは、このアプリでは使えないか、すでに無効です。</Text>
        <Link href="/" replace asChild>
          <ActionButton label="ホームに戻る" onPress={() => {}} />
        </Link>
      </View>
    </Screen>
  );
}
