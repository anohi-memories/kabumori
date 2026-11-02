import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/constants/theme';

const labels: Record<string, string> = { index: 'ホーム', schedule: '投稿予定', consult: 'AI相談', history: '履歴', settings: '設定' };
export default function TabsLayout() { const insets = useSafeAreaInsets(); return <Tabs screenOptions={({ route }) => ({ headerShown: false, sceneStyle: { backgroundColor: colors.background, paddingTop: insets.top }, tabBarActiveTintColor: colors.primary, tabBarLabel: labels[route.name], tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>●</Text> })} />; }
