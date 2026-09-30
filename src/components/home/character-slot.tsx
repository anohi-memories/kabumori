import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

// Independent character layer of the Home Report Hero. It only draws the image it is given:
// the source is chosen by the caller (phase 1: one fixed approved 04 image; a later phase can swap
// the source without touching the Hero layout) and the position/size come from `style`.
//
// The approved artwork (report_04_neutral.webp) is a transparent 1536x1024 cutout whose subject
// reaches all four edges, so it is shown uncropped with contentFit="contain" and never framed,
// tinted or given a glow/speech bubble. It is decorative: hidden from the accessibility tree.
export const CHARACTER_ASPECT_RATIO = 1536 / 1024;

type CharacterSlotProps = {
  source: ImageSource;
  /** Absolute position/size supplied by the layout that owns this layer. */
  style?: StyleProp<ViewStyle>;
};

export function CharacterSlot({ source, style }: CharacterSlotProps) {
  return (
    <View
      pointerEvents="none"
      style={[styles.slot, style]}
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      <Image source={source} style={styles.image} contentFit="contain" accessible={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  // No overflow clipping: an offset must never crop the artwork.
  slot: { aspectRatio: CHARACTER_ASPECT_RATIO },
  image: { width: '100%', height: '100%' },
});
