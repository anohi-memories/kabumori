import { Stack } from 'expo-router';

// The 重要ニュース tab keeps its own stack so a detail page opens on top of the
// list and the back gesture returns to it, while the bottom tabs stay in place.
export default function NewsLayout() {
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
      <Stack.Screen name="[id]" options={{ title: 'ニュース詳細' }} />
    </Stack>
  );
}
