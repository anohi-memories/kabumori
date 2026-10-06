import { StyleSheet, Text, View } from 'react-native';

// The company-logo slot of the portfolio rows. There is no logo field in stocks_master and no licensed logo
// source yet, so every company gets the same calm fallback: a soft neutral circle with one short label
// (see avatarLabel in lib/portfolio-view). When a licensed logo exists later, this is the one place that
// renders it instead; the row layout around it does not change. No logo URLs are hard-coded anywhere.
export function StockAvatar({ label, name, size = 48 }: { label: string; name: string; size?: number }) {
  return (
    <View
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={`${name}のアイコン`}>
      <Text style={[styles.label, { fontSize: Math.round(size * 0.4) }]} allowFontScaling={false}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { backgroundColor: '#e9ece8', alignItems: 'center', justifyContent: 'center' },
  label: { color: '#5d6a62', fontWeight: '800' },
});
