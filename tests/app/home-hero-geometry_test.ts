import assert from "node:assert/strict";
import test from "node:test";

import {
  HERO_ART_ASPECT,
  HERO_POINTS_TOP_RATIO,
  heroArtHeight,
  heroIsExtended,
  heroPointsTop,
  heroWidth,
} from "../../src/lib/home-hero-geometry.ts";

test("the art aspect ratio is the 1586x992 canvas", () => {
  assert.equal(HERO_ART_ASPECT, 1586 / 992);
});

test("heroWidth subtracts both gutters and caps the Home column", () => {
  assert.equal(heroWidth(402, 16), 370);
  assert.equal(heroWidth(375, 16), 343);
  assert.equal(heroWidth(1000, 16), 688, "the Home column is capped at 720");
  assert.equal(heroWidth(10, 16), 0, "never negative");
});

test("the art height follows the aspect ratio at every width", () => {
  assert.ok(Math.abs(heroArtHeight(370) - 231.4) < 0.1);
  assert.ok(Math.abs(heroArtHeight(343) - 214.5) < 0.1);
  assert.ok(Math.abs(heroArtHeight(288) - 180.1) < 0.1);
});

test("the points start under the baked 今日のポイント underline (about 53.5% of the art height)", () => {
  assert.equal(HERO_POINTS_TOP_RATIO, 0.535);
  assert.ok(Math.abs(heroPointsTop(231.4) - 123.8) < 0.1);
});

test("heroIsExtended only when the live content made the Hero taller than the art", () => {
  assert.equal(heroIsExtended(231.4, 231.4), false);
  assert.equal(heroIsExtended(232.0, 231.4), false, "sub-point rounding is not an extension");
  assert.equal(heroIsExtended(268, 231.4), true);
  assert.equal(heroIsExtended(0, 231.4), false, "before layout");
});
