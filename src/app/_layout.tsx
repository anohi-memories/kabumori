import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ActivityIndicator, StyleSheet, useColorScheme, View } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthScreen } from '@/components/auth-screen';
import { OnboardingScreens } from '@/components/onboarding-screens';
import { PasswordResetScreen } from '@/components/password-reset-screen';
import { ProfileRecoveryScreen } from '@/components/profile-recovery-screen';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { useOnboardingV1 } from '@/hooks/use-onboarding';
import { useRecoveryLink } from '@/hooks/use-recovery-link';
import { useRegisterPushToken } from '@/hooks/use-register-push-token';
import { usePushNotificationNavigation } from '@/hooks/use-push-notification-navigation';
import { AuthProvider, useAuth } from '@/providers/auth-provider';

SplashScreen.preventAutoHideAsync();

// expo-router/unstable-native-tabs (see src/app/(tabs)/_layout.tsx) only
// registers routes that have a matching NativeTabs.Trigger inside that same
// route group -- router.push() to anything outside it (topic-detail,
// topics, settings, ai, search) silently does nothing if those routes are rendered
// as if they were part of the tab group. This root Stack is what makes them
// reachable: (tabs) is one full-screen Stack entry, and the rest are
// ordinary pushed screens on top of it, each managing its own
// header/back-button in-content (matching news/_layout.tsx and
// reports/_layout.tsx's existing "Stack screens matched by file name"
// pattern, which already worked correctly before this fix).
function SignedInNavigator() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="topic-detail" />
      <Stack.Screen name="topics" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="ai" />
      <Stack.Screen name="search" />
    </Stack>
  );
}

function AuthGate() {
  const { session, loading, error, profileError, retry } = useAuth();
  const colorScheme = useColorScheme();
  const { link, clearRecoveryLink } = useRecoveryLink();
  const { completed: onboardingCompleted, complete: completeOnboarding } = useOnboardingV1();
  useRegisterPushToken(session);
  usePushNotificationNavigation(session);

  // A reset link takes precedence over both the app and the login form: it can arrive while signed
  // out, and it also creates a session of its own that would otherwise skip the new password.
  if (link) return <PasswordResetScreen link={link} onClose={clearRecoveryLink} />;

  // The onboarding-v1 flag is local-only (AsyncStorage) and intentionally decided independently of
  // `loading`/`session`: auth/session initialization keeps resolving in the background regardless
  // of what this gate renders, and completing onboarding never depends on it succeeding.
  if (loading || onboardingCompleted === null) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={KABUMORI_COLORS.light.accent} size="large" />
      </View>
    );
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      {onboardingCompleted === false ? (
        <OnboardingScreens onComplete={completeOnboarding} />
      ) : session && profileError ? (
        <ProfileRecoveryScreen message={profileError} onRetry={retry} />
      ) : session ? (
        <SignedInNavigator />
      ) : (
        <AuthScreen startupError={error} onRetry={retry} />
      )}
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: KABUMORI_COLORS.light.background },
});
