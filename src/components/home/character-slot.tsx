import { StyleSheet, View } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';

// Independently replaceable character illustration slot. Claude must not
// generate new Yume-chan/robot artwork here -- this only lays out a fixed
// footprint that a future approved cutout PNG can fill without touching the
// card around it. There is currently no approved cutout asset in the repo,
// so until one exists this renders a quiet, empty placeholder (a faint
// dashed outline, no fill/emoji) rather than a bold decorative shape that
// would read as a finished design element and drift from the approved v3
// look.
//
// Expected future asset contract, so a same-size swap never shifts layout:
// - transparent-background PNG cutout (no card/background baked in)
// - square canvas, recommended 240x240 at @1x (@2x/@3x as usual)
// - subject centered with even padding so it reads at this slot's small size
export const CHARACTER_SLOT_SIZE = 48;

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
      <Image source={source} style={styles.image} contentFit="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    width: CHARACTER_SLOT_SIZE,
    height: CHARACTER_SLOT_SIZE,
    overflow: 'hidden',
  },
  placeholder: {
    width: CHARACTER_SLOT_SIZE,
    height: CHARACTER_SLOT_SIZE,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    opacity: 0.5,
  },
  image: { width: '100%', height: '100%' },
});
