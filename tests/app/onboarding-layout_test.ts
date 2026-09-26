import assert from "node:assert/strict";
import test from "node:test";

import { containRect, imageFractionToContainerRect } from "../../src/lib/onboarding-layout.ts";
import { ONBOARDING_CTA_FRACTION, ONBOARDING_IMAGE_SIZE } from "../../src/lib/onboarding-pages.ts";

test("containRect: an image taller (relatively) than the container is letterboxed left/right", () => {
  // A 1179x2556 image (aspect ~0.4612) in a wider-than-that container (e.g. an iPad-shaped
  // container, hypothetically) would be height-constrained and centered horizontally.
  const rect = containRect({ width: 1000, height: 1000 }, { width: 1179, height: 2556 });
  assert.ok(rect.height <= 1000 + 0.001);
  assert.equal(rect.height, 1000); // height is the binding constraint here
  assert.ok(rect.width < 1000, "should be letterboxed, not fill the width");
  assert.ok(rect.x > 0, "should be horizontally centered, not flush left");
});

test("containRect: exact aspect ratio match fills the container with no letterboxing", () => {
  const rect = containRect({ width: 393, height: 852 }, ONBOARDING_IMAGE_SIZE); // same aspect ratio, scaled
  assert.ok(Math.abs(rect.width - 393) < 0.01);
  assert.ok(Math.abs(rect.height - 852) < 0.01);
  assert.ok(Math.abs(rect.x) < 0.01);
  assert.ok(Math.abs(rect.y) < 0.01);
});

test("containRect: a squat container is height-constrained and letterboxed left/right", () => {
  // A squat container (like a phone in landscape, hypothetically), against this tall/narrow
  // image, is height-constrained: the rendered width shrinks to preserve aspect ratio.
  const rect = containRect({ width: 800, height: 400 }, { width: 1179, height: 2556 });
  assert.equal(rect.height, 400);
  assert.ok(rect.width < 800);
  assert.ok(rect.x > 0, "should be horizontally centered, not flush left");
});

test("containRect degrades to a zero rect instead of dividing by zero on an empty container", () => {
  assert.deepEqual(containRect({ width: 0, height: 0 }, { width: 100, height: 100 }), {
    x: 0, y: 0, width: 0, height: 0,
  });
});

test("imageFractionToContainerRect: a fraction covering the whole image equals the rendered image rect", () => {
  const container = { width: 393, height: 852 };
  const image = { width: 1179, height: 2556 };
  const whole = imageFractionToContainerRect(container, image, { x: 0, y: 0, width: 1, height: 1 });
  const rendered = containRect(container, image);
  assert.deepEqual(whole, rendered);
});

test("imageFractionToContainerRect: a centered fraction stays centered within the rendered image", () => {
  const container = { width: 500, height: 500 }; // deliberately not the image's own aspect ratio
  const image = { width: 1179, height: 2556 };
  const rendered = containRect(container, image);
  const centerDot = imageFractionToContainerRect(container, image, {
    x: 0.49, y: 0.49, width: 0.02, height: 0.02,
  });
  const centerDotMidX = centerDot.x + centerDot.width / 2;
  const renderedMidX = rendered.x + rendered.width / 2;
  assert.ok(Math.abs(centerDotMidX - renderedMidX) < 1, "a ~50% fraction should land near the rendered image's own horizontal center");
});

test("the page-3 CTA hit target lands inside the rendered image on a representative small and large iPhone", () => {
  for (const container of [
    { width: 375, height: 812 }, // iPhone SE / mini-class (small)
    { width: 430, height: 932 }, // iPhone Pro Max-class (large)
  ]) {
    const rendered = containRect(container, ONBOARDING_IMAGE_SIZE);
    const cta = imageFractionToContainerRect(container, ONBOARDING_IMAGE_SIZE, ONBOARDING_CTA_FRACTION);
    assert.ok(cta.x >= rendered.x - 0.01, `${JSON.stringify(container)}: CTA left edge inside the image`);
    assert.ok(cta.x + cta.width <= rendered.x + rendered.width + 0.01, `${JSON.stringify(container)}: CTA right edge inside the image`);
    assert.ok(cta.y >= rendered.y - 0.01, `${JSON.stringify(container)}: CTA top edge inside the image`);
    assert.ok(cta.y + cta.height <= rendered.y + rendered.height + 0.01, `${JSON.stringify(container)}: CTA bottom edge inside the image`);
    // Apple's minimum recommended hit-target size, on the *rendered* (on-screen) dimensions.
    assert.ok(cta.width >= 44, `${JSON.stringify(container)}: CTA hit target must be at least 44pt wide, got ${cta.width}`);
    assert.ok(cta.height >= 44, `${JSON.stringify(container)}: CTA hit target must be at least 44pt tall, got ${cta.height}`);
  }
});
