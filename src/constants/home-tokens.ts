// Shared layout/colour tokens for the rebuilt Home screen (visual reference:
// the user's ideal Home mock). Every Home section reads its gutter, radius and
// brand greens from here so the whole screen stays one coherent visual system.
//
// This module has no RN imports so it can be tested with Deno and bundled by Metro.

export const HOME_LAYOUT = {
  /** Horizontal screen gutter shared by every section. */
  gutter: 16,
  /** Vertical gap between sections. */
  sectionGap: 10,
  /** Corner radius of the big blocks (Hero, topic feature, lists). */
  radius: 18,
  /** Bottom padding so the last block clears the floating tab bar. */
  bottomInset: 110,
} as const;

export const HOME_COLORS = {
  // Hero: pale mint block with a deep-green brand accent.
  heroBackground: '#eaf6ee',
  heroBorder: '#d3ead9',
  brandGreen: '#1f7a45',
  deepGreen: '#17603a',
  pillGreen: '#2f9e57',
  pointsPillBackground: '#d9f0e0',
  pointsPillText: '#1f7a45',
  pointsBoxBackground: '#ffffff',
  // "今日のポイント" numbered circles: 1 = red, 2 = blue, 3 = orange.
  point: ['#e5484d', '#2f7fd8', '#f5a524'] as const,
  // Topic feature: soft blue-lavender block.
  topicBackground: '#eef1fb',
  topicBorder: '#dfe4f5',
  topicBadgeBackground: '#e5e0f8',
  topicBadgeText: '#5b4bb0',
  // Neutral card surface used by news + AI blocks.
  card: '#ffffff',
  cardBorder: '#e4e9e5',
  important: '#d6403f',
} as const;

// Compact Report Hero geometry (pt). The Hero is a layered block: the character is an independent
// absolute layer on the right (resting on the CTA row, behind the text), while the title block and a
// compact points box sit on the left. The character never drives the Hero height.
export const HERO = {
  padding: 10,
  ctaHeight: 36,
  /** Space between the points box and the CTA row. */
  ctaGap: 8,
  /** Title / description column, as a share of the Hero width. */
  titleColumnPercent: '58%',
  /** Points box, as a share of the Hero width (a little of the wand tip may tuck behind it). */
  pointsColumnPercent: '56%',
  /** Character layer width, as a share of the Hero width. */
  characterWidthPercent: '52%',
  /** Right offset (pt) of the character layer inside the Hero. */
  characterRight: -2,
  /** Keeps the layered composition while the Hero has little text (loading / empty). */
  minHeight: 200,
  /** Maximum "today's points" shown on Home. */
  maxPoints: 3,
} as const;
