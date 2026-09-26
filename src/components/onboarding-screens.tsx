import { Image } from 'expo-image';
import { useRef, useState } from 'react';
import {
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { imageFractionToContainerRect } from '@/lib/onboarding-layout';
import {
  ONBOARDING_CTA_FRACTION,
  ONBOARDING_IMAGE_SIZE,
  ONBOARDING_PAGES,
  type OnboardingPageKey,
} from '@/lib/onboarding-pages';

const palette = KABUMORI_COLORS.light;
const LAST_PAGE_INDEX = ONBOARDING_PAGES.length - 1;

// require() must appear directly in a Metro-bundled file, so the image sources live here rather
// than in onboarding-pages.ts (which tests/app/onboarding-layout_test.ts imports under plain Deno).
const PAGE_SOURCES: Record<OnboardingPageKey, number> = {
  brand: require('@/assets/onboarding/01-brand.png'),
  'ai-analysis': require('@/assets/onboarding/02-ai-analysis.png'),
  report: require('@/assets/onboarding/03-report.png'),
};

// A one-time, three-page introduction shown before the first login/signup screen. Purely local and
// explanatory -- it makes no network call and never blocks on or feeds into auth/session state.
// See src/hooks/use-onboarding.ts for the persisted "seen it" flag this screen doesn't manage
// itself (the caller decides whether to mount this component at all).
export function OnboardingScreens({ onComplete }: { onComplete: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [pageIndex, setPageIndex] = useState(0);

  function handleScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const nextIndex = Math.round(event.nativeEvent.contentOffset.x / width);
    if (nextIndex !== pageIndex && nextIndex >= 0 && nextIndex <= LAST_PAGE_INDEX) {
      setPageIndex(nextIndex);
    }
  }

  const container = { width, height };
  const ctaRect = imageFractionToContainerRect(container, ONBOARDING_IMAGE_SIZE, ONBOARDING_CTA_FRACTION);

  return (
    <View style={styles.root} testID="onboarding-screens">
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onScroll={handleScroll}
        // 32ms (~30fps) is enough for a page-index update driven purely by user scrolling; no need
        // for the 16ms/60fps default here.
        scrollEventThrottle={32}>
        {ONBOARDING_PAGES.map((page) => (
          <View key={page.key} style={{ width, height }}>
            <Image
              source={PAGE_SOURCES[page.key]}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              accessibilityLabel={page.accessibilityLabel}
              accessible
            />
          </View>
        ))}
      </ScrollView>

      {pageIndex === LAST_PAGE_INDEX ? (
        <Pressable
          onPress={onComplete}
          accessibilityRole="button"
          accessibilityLabel="はじめる"
          style={[
            styles.ctaHitTarget,
            { left: ctaRect.x, top: ctaRect.y, width: ctaRect.width, height: ctaRect.height },
          ]}
        />
      ) : null}

      <PageDots count={ONBOARDING_PAGES.length} index={pageIndex} bottomInset={insets.bottom} />
    </View>
  );
}

function PageDots({ count, index, bottomInset }: { count: number; index: number; bottomInset: number }) {
  return (
    <View
      style={[styles.dotsRow, { bottom: bottomInset + 20 }]}
      accessible
      accessibilityLabel={`${index + 1} / ${count} ページ`}>
      {Array.from({ length: count }, (_, dotIndex) => (
        <View
          key={dotIndex}
          style={[styles.dot, { backgroundColor: dotIndex === index ? palette.accent : palette.border }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#ffffff' },
  ctaHitTarget: { position: 'absolute' },
  dotsRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
