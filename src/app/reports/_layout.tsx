import { Stack } from 'expo-router';

// The レポート tab keeps its own stack (like 重要ニュース) so a report opens on
// top of the list and the back gesture returns to it.
export default function ReportsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: '#397449',
        headerTitleStyle: { color: '#17211a', fontWeight: '800' },
        headerStyle: { backgroundColor: '#f7f8f5' },
        headerShadowVisible: false,
        headerBackTitle: '一覧',
        contentStyle: { backgroundColor: '#f7f8f5' },
      }}>
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[id]" options={{ title: 'レポート' }} />
    </Stack>
  );
}
