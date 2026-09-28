import { StyleSheet, Text, View } from 'react-native';
import { Image, type ImageSource } from 'expo-image';

import type { KabumoriPalette } from '@/constants/kabumori-theme';

// Independently replaceable character illustration slot. Claude must not
// generate new Yume-chan/robot artwork here -- this only lays out a fixed
// footprint that a future approved cutout PNG can fill without touching the
// card around it, and falls back to a neutral placeholder when no `source`
// is given (there is currently no approved cutout asset in the repo).
//
// Expected future asset contract, so a same-size swap never shifts layout:
// - transparent-background PNG cutout (no card/background baked in)
// - square canvas, recommended 240x240 at @1x (@2x/@3x as usual)
// - subject centered with even padding so it reads at this slot's small size
export const CHARACTER_SLOT_SIZE = 64;

type CharacterSlotProps = {
  source?: ImageSource;
  palette: KabumoriPalette;
};

export function CharacterSlot({ source, palette }: CharacterSlotProps) {
  return (
    <View
      style={[styles.slot, { backgroundColor: palette.accentSoft }]}
      accessible={false}
      importantForAccessibility="no-hide-descendants">
      {source ? (
        <Image source={source} style={styles.image} contentFit="contain" />
      ) : (
        <Text style={[styles.fallbackGlyph, { color: palette.accent }]}>🌱</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    width: CHARACTER_SLOT_SIZE,
    height: CHARACTER_SLOT_SIZE,
    borderRadius: CHARACTER_SLOT_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  image: { width: '100%', height: '100%' },
  fallbackGlyph: { fontSize: 26 },
});
