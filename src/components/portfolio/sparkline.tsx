import { StyleSheet, View } from 'react-native';

// A tiny dependency-free line chart made of native Views: thin rotated bars with rounded ends (each one is
// drawn a little longer than its segment, so neighbouring bars overlap and the joins read as one smooth line
// without joint dots) plus one restrained end dot. It only draws real saved values (the recent close reports'
// total asset value) and never adds, smooths or invents points; with fewer than two points it draws nothing --
// the caller keeps the card quiet instead of faking a history. The caller picks the colour from the real
// trend (see sparklineTrend in lib/portfolio-view), so a falling series is never drawn green.
export function Sparkline({ values, width, height, color }: { values: readonly number[]; width: number; height: number; color: string }) {
  if (values.length < 2 || width <= 0 || height <= 0) return null;
  const pad = 5;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const points = values.map((value, index) => ({
    x: pad + (index / (values.length - 1)) * (width - pad * 2),
    // A flat history is drawn as a quiet level line.
    y: range === 0 ? height / 2 : height - pad - ((value - min) / range) * (height - pad * 2),
  }));
  const thickness = 2;
  const last = points[points.length - 1];
  return (
    <View style={{ width, height }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {points.slice(1).map((point, index) => {
        const previous = points[index];
        const dx = point.x - previous.x;
        const dy = point.y - previous.y;
        // Round caps extend each bar by half the thickness at both ends, hiding the seam between segments.
        const length = Math.hypot(dx, dy) + thickness;
        return (
          <View
            key={index}
            style={[
              styles.segment,
              {
                width: length,
                height: thickness,
                borderRadius: thickness / 2,
                backgroundColor: color,
                left: (previous.x + point.x) / 2 - length / 2,
                top: (previous.y + point.y) / 2 - thickness / 2,
                transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
              },
            ]}
          />
        );
      })}
      <View style={[styles.dot, { backgroundColor: color, left: last.x - 3.5, top: last.y - 3.5 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { position: 'absolute' },
  dot: { position: 'absolute', width: 7, height: 7, borderRadius: 3.5 },
});
