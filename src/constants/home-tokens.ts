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

// Report Hero layout (pt / shares). The Hero is one piece of artwork with live UI laid over it (see
// src/lib/home-hero-geometry.ts): the points column sits under the baked-in 「今日のポイント」 line, on
// the left, clear of the character that occupies the right ~half of the art.
export const HERO = {
  /** Corner radius; a little above the ~3.5% radius baked into the art so its white corners are clipped. */
  radius: 14,
  /** Colour under/below the art when the live points make the Hero taller than the art. */
  fillColor: '#e4f0e6',
  /** Bottom padding under the CTA and its side margins. */
  /** Side margins of the CTA. */
  padding: 10,
  /** Space under the CTA: the CTA sits almost on the bottom edge of the art. */
  ctaBottomInset: 4,
  ctaHeight: 30,
  /** Minimum space between the last point and the CTA. */
  ctaGap: 4,
  /**
   * When the live points make the Hero taller than the art, the art's bottom edge ends inside the card.
   * It is hidden by a soft fade to the fill colour drawn over the art AND the character: a ramp of
   * non-overlapping strips (no banding) that is fully opaque for the last `fadeSolid` pt, which also
   * hides the character's bottom edge and the art's baked white corners.
   */
  fadeStrips: 20,
  fadeStripHeight: 2,
  /** Strips (counted from the bottom) that are fully opaque. */
  fadeSolidStrips: 9,
  /** Points column: left edge and width as shares of the Hero width (the baked underline spans 4.8%-44.8%). */
  pointsLeft: '4.8%',
  pointsWidth: '42%',
  /** Report kind (朝刊 / 大引け), right after the baked 「今日のポイント」 label. */
  metaLeft: '31.5%',
  metaTop: '44.3%',
  /** Maximum "today's points" shown on Home (1-3 are shown; never an empty row). */
  maxPoints: 3,
} as const;
