import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';

// The approved brand logo (transparent WebP, 1719x463, lossless; only the empty transparent margin
// of the official artwork was trimmed: never scaled, recoloured or redrawn). It is shown with contentFit="contain" inside this
// fixed-size slot so the layout never shifts; to replace it, swap the single require below.
export const HEADER_LOGO_SOURCE: ImageSource = require('@/assets/images/home/kabumori_header_logo.webp');
export const HEADER_LOGO_SLOT = { width: 132, height: 34 } as const;

type HomeHeaderProps = {
  palette: KabumoriPalette;
  greeting: string;
  date: string;
};

// Compact header: brand logo | small greeting + date | the existing settings entry.
// No notification bell / profile button: those features do not exist yet, so no fake controls.
export function HomeHeader({ palette, greeting, date }: HomeHeaderProps) {
  return (
    <View style={styles.row}>
      <Image
        source={HEADER_LOGO_SOURCE}
        style={HEADER_LOGO_SLOT}
        contentFit="contain"
        accessible
        accessibilityRole="header"
        accessibilityLabel="かぶモリ 株をAIで、もっと身近に。"
      />

      <View style={styles.greeting}>
        <Text style={[styles.greetingText, { color: palette.text }]} numberOfLines={1}>
          {greeting}
        </Text>
        <Text style={[styles.date, { color: palette.muted }]} numberOfLines={1}>
          {date}
        </Text>
      </View>

      <Pressable
        onPress={() => router.push('/settings')}
        style={({ pressed }) => [styles.settings, { backgroundColor: palette.accentSoft }, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel="設定"
        accessibilityHint="アカウント・通知・規約・ログアウトの設定を開きます">
        <Text style={[styles.settingsText, { color: palette.muted }]}>設定</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
  greeting: { flex: 1, minWidth: 0, paddingLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#c9d3cb' },
  greetingText: { fontSize: 12, fontWeight: '800' },
  date: { fontSize: 11, fontWeight: '700', marginTop: 1 },
  settings: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
  settingsText: { fontSize: 12, fontWeight: '800' },
  pressed: { opacity: 0.7 },
});
