import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';
import { HOME_COLORS } from '@/constants/home-tokens';

// Asset slot: the wide "かぶモリ" brand logo. Set this to
//   require('@/assets/images/home/kabumori_header_logo.webp')
// when the file exists (it is intentionally NOT required while missing). Until then the header
// shows the temporary text brand inside the same fixed-size slot, so swapping the asset is a
// one-line change and never shifts the layout.
export const HEADER_LOGO_SOURCE: ImageSource | null = null;
export const HEADER_LOGO_SLOT = { width: 132, height: 34 } as const;

type HomeHeaderProps = {
  palette: KabumoriPalette;
  greeting: string;
  date: string;
};

// Compact header: brand logo slot | small greeting + date | the existing settings entry.
// No notification bell / profile button: those features do not exist yet, so no fake controls.
export function HomeHeader({ palette, greeting, date }: HomeHeaderProps) {
  return (
    <View style={styles.row}>
      <View style={[styles.logoSlot, HEADER_LOGO_SLOT]} accessible accessibilityRole="header" accessibilityLabel="かぶモリ">
        {/* Temporary text brand; replaced by the logo image when HEADER_LOGO_SOURCE is set. */}
        <Text style={[styles.brand, { color: HOME_COLORS.brandGreen }]}>かぶモリ</Text>
        <Text style={[styles.tagline, { color: palette.muted }]} numberOfLines={1}>
          株とAIで、もっと身近に。
        </Text>
      </View>

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
  logoSlot: { justifyContent: 'center' },
  brand: { fontSize: 19, lineHeight: 22, fontWeight: '900', letterSpacing: 0.5 },
  tagline: { fontSize: 8.5, lineHeight: 11, fontWeight: '700' },
  greeting: { flex: 1, minWidth: 0, paddingLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#c9d3cb' },
  greetingText: { fontSize: 12, fontWeight: '800' },
  date: { fontSize: 11, fontWeight: '700', marginTop: 1 },
  settings: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
  settingsText: { fontSize: 12, fontWeight: '800' },
  pressed: { opacity: 0.7 },
});
