import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
  return <><StatusBar style="auto" /><Stack screenOptions={{ headerShown: false }}><Stack.Screen name="(tabs)" /><Stack.Screen name="accounts" options={{ headerShown: true, title: 'アカウント' }} /><Stack.Screen name="media" options={{ headerShown: true, title: '素材BOX' }} /><Stack.Screen name="posts/[id]" options={{ headerShown: true, title: '投稿詳細' }} /></Stack></>;
}
