import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import { HERO_CHARACTER_HEIGHT, HERO_CHARACTER_WIDTH } from '@/lib/home-hero-geometry';

// Independent character layer of the Home Report Hero. It only draws the image it is given:
// the source is chosen by the caller (phase 1: one fixed approved image; a later phase can swap the
// source without touching the Hero layout) and the position/size come from `style`.
//
// The approved artwork (report_04_neutral.webp) is a transparent 1536x960 cutout made on the same
// canvas as the Hero background, so it is stacked on the art box 1:1 with contentFit="contain" and is
// never cropped, recoloured, framed or given a glow/speech bubble. It is decorative: hidden from
// the accessibility tree, and it never takes touches (pointerEvents none), so it cannot block the CTA.
export const CHARACTER_ASPECT_RATIO = HERO_CHARACTER_WIDTH / HERO_CHARACTER_HEIGHT;

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
  // No overflow clipping: the layer must never crop the artwork.
  slot: { aspectRatio: CHARACTER_ASPECT_RATIO },
  image: { width: '100%', height: '100%' },
});
