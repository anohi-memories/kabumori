import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

// Full-canvas character overlay of the Home Report Hero. Every character image is drawn on the same
// canvas as the Hero background, so this layer fills the Hero's art box exactly (absolute fill) and
// shows the image with contentFit="contain": the whole canvas is always visible, nothing is cropped,
// and the transparent areas simply show the background. There are no per-state scale / translate /
// offset adjustments -- all eight states follow this one rule. The layer is decorative (hidden from
// the accessibility tree), frameless, and never takes touches (pointerEvents none), so it can never
// block the CTA.
type CharacterSlotProps = {
  source: ImageSource;
  /** Overrides for the fill box (defaults to absolute fill). */
  style?: StyleProp<ViewStyle>;
};

export function CharacterSlot({ source, style }: CharacterSlotProps) {
  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, style]}
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      <Image source={source} style={styles.image} contentFit="contain" accessible={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  image: { width: '100%', height: '100%' },
});
