import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ActivityIndicator, StyleSheet, useColorScheme, View } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
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
        <AppTabs />
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
