// Geometry of the Home Report Hero. The Hero is one piece of artwork (report_hero_background.webp,
// 1586x992: title, description and the "今日のポイント" label are baked into the picture) with the
// live UI laid over it: the character (same-size canvas, stacked 1:1 on the art), the report kind,
// the 1-3 points and the CTA. Everything that depends on the art is derived from the art's own
// aspect ratio here, so it scales with the screen instead of using fixed pixels.
//
// This module has no RN imports so it can be tested with Deno and bundled by Metro.

export const HERO_ART_WIDTH = 1586;
export const HERO_ART_HEIGHT = 992;
export const HERO_ART_ASPECT = HERO_ART_WIDTH / HERO_ART_HEIGHT;

/** Character canvas (report_04_neutral.webp), drawn on the same box as the art. */
export const HERO_CHARACTER_WIDTH = 1536;
export const HERO_CHARACTER_HEIGHT = 960;

/**
 * Where the live points start, as a share of the art height: just below the baked
 * "今日のポイント" underline (y=512 of 992 in the artwork).
 */
export const HERO_POINTS_TOP_RATIO = 0.535;

/** Width of the Hero card for a window width (the Home column is capped at maxWidth). */
export function heroWidth(windowWidth: number, gutter: number, maxWidth = 720): number {
  return Math.max(0, Math.min(windowWidth, maxWidth) - gutter * 2);
}

/** Height the artwork occupies at a given Hero width. */
export function heroArtHeight(width: number): number {
  return width / HERO_ART_ASPECT;
}

/** Top offset of the live points inside the Hero. */
export function heroPointsTop(artHeight: number): number {
  return artHeight * HERO_POINTS_TOP_RATIO;
}

/**
 * True when the live content (up to 3 two-line points + CTA) made the Hero taller than the art, so
 * the area under the art needs the fade-to-fill treatment.
 */
export function heroIsExtended(heroHeight: number, artHeight: number): boolean {
  return heroHeight > artHeight + 1;
}
