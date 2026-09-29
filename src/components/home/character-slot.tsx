import { StyleSheet, View } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';

// Independently replaceable character illustration slot. Claude must not
// generate new Yume-chan/robot artwork here -- this only lays out a footprint
// that an approved transparent cutout fills without touching the card around it.
// When no source is passed it renders a quiet, empty placeholder (a faint
// dashed outline, no fill/emoji).
//
// Phase 1: the Home report card passes one fixed approved image
// (report_04_neutral.webp) so the user can judge size/position on a real device.
// Every visual knob lives in the constants below so micro-adjustments are a
// one-line change:
// - CHARACTER_SLOT_WIDTH: footprint width; height follows the artwork's 3:2 canvas
// - CHARACTER_OFFSET_X / _Y: shift the artwork inside/outside its footprint
//   (+x right, +y down) without moving the text column
//
// The approved artwork is a transparent 1536x1024 (3:2) cutout with the subject
// reaching all four edges, so it is shown with contentFit="contain" and never
// cropped, framed or tinted.
export const CHARACTER_ASPECT_RATIO = 1536 / 1024;
export const CHARACTER_SLOT_WIDTH = 96;
export const CHARACTER_SLOT_HEIGHT = Math.round(CHARACTER_SLOT_WIDTH / CHARACTER_ASPECT_RATIO);
export const CHARACTER_OFFSET_X = 0;
export const CHARACTER_OFFSET_Y = 0;

type CharacterSlotProps = {
  source?: ImageSource;
  palette: KabumoriPalette;
};

export function CharacterSlot({ source, palette }: CharacterSlotProps) {
  if (!source) {
    return (
      <View
        style={[styles.placeholder, { borderColor: palette.border }]}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      />
    );
  }
  return (
    <View style={styles.slot} accessible={false} importantForAccessibility="no-hide-descendants">
      <Image source={source} style={styles.image} contentFit="contain" accessible={false} />
    </View>
  );
}

const styles = StyleSheet.create({
  // No overflow clipping: an offset must never crop the artwork.
  slot: {
    width: CHARACTER_SLOT_WIDTH,
    height: CHARACTER_SLOT_HEIGHT,
    transform: [{ translateX: CHARACTER_OFFSET_X }, { translateY: CHARACTER_OFFSET_Y }],
  },
  placeholder: {
    width: CHARACTER_SLOT_HEIGHT,
    height: CHARACTER_SLOT_HEIGHT,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    opacity: 0.5,
  },
  image: { width: '100%', height: '100%' },
});
