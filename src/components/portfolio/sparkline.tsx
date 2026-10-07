import { StyleSheet, View } from 'react-native';

// A tiny dependency-free line chart made of native Views: one thin rotated bar per segment plus an end dot.
// It only draws real saved values (the recent close reports' total asset value); with fewer than two points
// it draws nothing -- the caller keeps the card quiet instead of inventing a history.
export function Sparkline({ values, width, height, color }: { values: readonly number[]; width: number; height: number; color: string }) {
  if (values.length < 2 || width <= 0 || height <= 0) return null;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const points = values.map((value, index) => ({
    x: pad + (index / (values.length - 1)) * (width - pad * 2),
    // A flat history is drawn as a quiet level line.
    y: range === 0 ? height / 2 : height - pad - ((value - min) / range) * (height - pad * 2),
  }));
  const thickness = 2.5;
  return (
    <View style={{ width, height }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {points.slice(1).map((point, index) => {
        const previous = points[index];
        const dx = point.x - previous.x;
        const dy = point.y - previous.y;
        const length = Math.hypot(dx, dy);
        return (
          <View
            key={index}
            style={[
              styles.segment,
              {
                width: length + 0.5,
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
      {points.slice(1, -1).map((point, index) => (
        <View key={`joint-${index}`} style={[styles.joint, { backgroundColor: color, left: point.x - thickness / 2, top: point.y - thickness / 2 }]} />
      ))}
      <View style={[styles.dot, { backgroundColor: color, left: points[points.length - 1].x - 4, top: points[points.length - 1].y - 4 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  segment: { position: 'absolute' },
  dot: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  joint: { position: 'absolute', width: 2.5, height: 2.5, borderRadius: 1.25 },
});
