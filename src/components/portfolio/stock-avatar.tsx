import { StyleSheet, Text, View } from 'react-native';

// The company-logo slot of the portfolio rows. There is no logo field in stocks_master and no licensed logo
// source yet, so every company gets a calm fallback: a soft circle with one short label (see avatarLabel in
// lib/portfolio-view). When a licensed logo exists later, this is the one place that renders it instead; the row
// layout around it does not change. No logo URLs and no company-specific artwork are hard-coded anywhere.
//
// Without a `seed` the circle is the neutral grey. With one (the watchlist passes the ticker) the tint is picked
// deterministically from a small muted palette, so neighbouring rows are told apart without any invented mark.
const TINTS = [
  { background: '#e3efe6', color: '#3f6b4f' },
  { background: '#e1ecf3', color: '#3d6178' },
  { background: '#efe8dc', color: '#7a5f3a' },
  { background: '#ece4ef', color: '#664d78' },
  { background: '#f3e4e1', color: '#8a524b' },
  { background: '#e0efee', color: '#3a6f6a' },
] as const;
const NEUTRAL = { background: '#e9ece8', color: '#5d6a62' } as const;

/** The deterministic tint index of a seed (the same seed always gets the same colour). */
export function tintIndex(seed: string): number {
  let sum = 0;
  for (const char of seed) sum = (sum * 31 + char.charCodeAt(0)) % 9973;
  return sum % TINTS.length;
}

export function StockAvatar({ label, name, size = 48, seed }: { label: string; name: string; size?: number; seed?: string }) {
  const tint = seed ? TINTS[tintIndex(seed)] : NEUTRAL;
  return (
    <View
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: tint.background }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${name}のアイコン`}>
      <Text style={[styles.label, { fontSize: Math.round(size * 0.4), color: tint.color }]} allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  label: { fontWeight: '800' },
});
