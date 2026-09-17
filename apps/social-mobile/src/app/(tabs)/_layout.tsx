import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { colors } from '@/constants/theme';

const labels: Record<string, string> = { index: 'ホーム', schedule: '投稿予定', consult: 'AI相談', history: '履歴', settings: '設定' };
export default function TabsLayout() { return <Tabs screenOptions={({ route }) => ({ headerShown: false, tabBarActiveTintColor: colors.primary, tabBarLabel: labels[route.name], tabBarIcon: ({ color }) => <Text style={{ color, fontSize: 18 }}>●</Text> })} />; }
