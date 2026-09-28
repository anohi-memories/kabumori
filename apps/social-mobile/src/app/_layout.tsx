import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { AuthScreen } from '@/components/auth-screen';
import { AuthProvider, useAuth } from '@/providers/auth-provider';
import { ActiveAccountProvider } from '@/providers/active-account-provider';
import { DataProvider } from '@/providers/data-provider';
import { OnboardingGate } from '@/features/onboarding/onboarding-gate';

function SignedInApp() {
  const { loading, session } = useAuth();
  if (loading) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background }}><ActivityIndicator color={colors.primary} size="large" /><Text style={{ color: colors.muted, marginTop: 12 }}>セッションを確認しています</Text></View>;
  if (!session) return <AuthScreen />;
  // Signed in → first-run gate (real data only) → app.
  return <DataProvider><OnboardingGate><ActiveAccountProvider><Stack screenOptions={{ headerShown: false }}><Stack.Screen name="(tabs)" /><Stack.Screen name="accounts" options={{ headerShown: true, title: 'アカウント' }} /><Stack.Screen name="media" options={{ headerShown: true, title: '素材BOX' }} /><Stack.Screen name="posts/[id]" options={{ headerShown: true, title: '投稿詳細' }} /><Stack.Screen name="oauth-callback" /></Stack></ActiveAccountProvider></OnboardingGate></DataProvider>;
}

export default function RootLayout() { return <AuthProvider><StatusBar style="auto" /><SignedInApp /></AuthProvider>;
}
