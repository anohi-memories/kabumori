import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';

const palette = KABUMORI_COLORS.light;

// No AI chat route/service exists in this repo yet. This is an honest
// "準備中" screen -- reachable from Home's Ask-AI entry and the bottom tab --
// rather than a fake chat UI or a route that silently does nothing.
export default function AiScreen() {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>ASK KABUMORI AI</Text>
        <Text style={styles.title}>AIに聞いてみる</Text>
        <Text style={styles.body}>
          気になるニュースや銘柄についてAIに質問できる機能は、現在準備中です。公開までもうしばらくお待ちください。
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 24, gap: 8 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11 },
  title: { color: palette.text, fontSize: 26, fontWeight: '900' },
  body: { color: palette.muted, fontSize: 15, lineHeight: 23, marginTop: 8 },
});
