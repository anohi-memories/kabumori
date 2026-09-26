import type { Rect } from '@/lib/onboarding-layout';

// The approved artwork's own native resolution. Every onboarding page shares it, since all three
// were exported at the same size (see tests/app/onboarding-assets_test.ts for the provenance pin).
export const ONBOARDING_IMAGE_SIZE = { width: 1179, height: 2556 };

export type OnboardingPageKey = 'brand' | 'ai-analysis' | 'report';

export type OnboardingPageMeta = {
  key: OnboardingPageKey;
  /** Non-visual only: what a screen reader announces for this page's artwork. */
  accessibilityLabel: string;
};

// Deliberately holds no `require()` -- Metro's asset-require syntax only works inside a bundled RN
// file, not under plain Deno (this module is imported by tests/app/onboarding-layout_test.ts). The
// actual image sources live in onboarding-screens.tsx, keyed by `key` below.
export const ONBOARDING_PAGES: readonly OnboardingPageMeta[] = [
  {
    key: 'brand',
    accessibilityLabel: 'かぶモリ。株とAI。やさしい投資で、ふやす、まもる、たのしむ。',
  },
  {
    key: 'ai-analysis',
    accessibilityLabel: 'あなたの大切な銘柄をAIが分析しています。最新のマーケット情報をチェック中です。',
  },
  {
    key: 'report',
    accessibilityLabel: '今日のかぶモリレポートです。あなたの銘柄に関する最新の動きをまとめました。',
  },
];

// The "はじめる →" button's own region in the page-3 artwork, as a fraction of the source image
// (0-1, measured from the 1179x2556 PNG's own pixels), not the screen. Converted to an actual
// on-screen rect at render time via imageFractionToContainerRect(), so the tappable area tracks
// the artwork exactly regardless of device size. Padded beyond the visible pill so the hit target
// comfortably clears a ~44pt minimum on every supported screen, per the accessibility hit-target
// guideline -- the visible pill alone is narrower than that in the vertical dimension.
export const ONBOARDING_CTA_FRACTION: Rect = {
  x: 0.18,
  y: 0.787,
  width: 0.64,
  height: 0.056,
};
