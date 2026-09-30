// The Home Report Hero: the approved final Hero background art and the approved final neutral (04)
// character, both converted losslessly (cwebp -lossless -exact) from the user's PNGs
// (Desktop/ゆめちゃん素材/TOP.png, sha256 8a0c0f00...; report_04_neutral.webp.png, sha256 6e234ff4...) and
// verified pixel-identical before commit. They are never cropped, recoloured or redrawn.
// RN-only components are checked as text, like the rest of this suite.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const CHARACTER = "assets/images/report-states/report_04_neutral.webp";
const CHARACTER_SHA256 = "14f2ab72933a47929f1f1c34a9b2e17c591082d020df3827c8aa6864242f19e3";
const BACKGROUND = "assets/images/home/report_hero_background.webp";
const BACKGROUND_SHA256 = "befc7168c04051a9558c175ee9059d27b00677b0fcd1cd6b7a1ed1fe882fff11";

const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assertLosslessWebp(path: string, sha: string, w: number, h: number, alpha: boolean) {
  const bytes = await Deno.readFile(new URL(path, repoRoot));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), "VP8L", "must stay lossless");
  // VP8L header: signature 0x2f, then 14-bit (width-1), 14-bit (height-1), 1-bit alpha_is_used.
  assert.equal(bytes[20], 0x2f);
  const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
  assert.equal((bits & 0x3fff) + 1, w);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, h);
  if (alpha) assert.equal((bits >>> 28) & 1, 1, "alpha channel must be present (transparent background)");
  assert.equal(await sha256Hex(bytes), sha);
}

test("the final 04 artwork is the exact committed lossless WebP with alpha, 1536x960", () =>
  assertLosslessWebp(CHARACTER, CHARACTER_SHA256, 1536, 960, true));

test("the final Hero background is the exact committed lossless WebP, 1586x992", () =>
  assertLosslessWebp(BACKGROUND, BACKGROUND_SHA256, 1586, 992, false));

test("there is exactly one report-state artwork: no crop copy, no other states", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL("assets/images/report-states/", repoRoot))) names.push(entry.name);
  assert.deepEqual(names, ["report_04_neutral.webp"]);
});

test("the Hero uses the one fixed 04 source in the CharacterSlot layer, with no state selection", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  assert.ok(/const FIXED_REPORT_CHARACTER_SOURCE = require\('@\/assets\/images\/report-states\/report_04_neutral\.webp'\);/.test(hero));
  assert.ok(/<CharacterSlot source=\{FIXED_REPORT_CHARACTER_SOURCE\}/.test(hero));
  assert.equal((hero.match(/report-states\//g) ?? []).length, 1);
  assert.ok(!/report_0[0-35-9]|report_10/.test(hero));
});

test("CharacterSlot keeps the artwork uncropped, decorative, frameless and never takes touches", async () => {
  const slot = await read("src/components/home/character-slot.tsx");
  assert.ok(slot.includes('contentFit="contain"'));
  assert.ok(!/overflow:\s*'hidden'/.test(slot), "the layer must never crop the artwork");
  assert.ok(slot.includes('importantForAccessibility="no-hide-descendants"'));
  assert.ok(slot.includes("accessible={false}"));
  assert.ok(slot.includes('pointerEvents="none"'), "the character must not block the CTA");
  assert.ok(/CHARACTER_ASPECT_RATIO = HERO_CHARACTER_WIDTH \/ HERO_CHARACTER_HEIGHT;/.test(slot));
  const styles = slot.slice(slot.indexOf("StyleSheet.create"));
  assert.ok(!/backgroundColor|border|shadow/.test(styles), "no frame/glow/background around the transparent artwork");
});

test("the character is stacked 1:1 on the art box: same box, same canvas ratio", async () => {
  const geometry = await read("src/lib/home-hero-geometry.ts");
  assert.ok(/HERO_CHARACTER_WIDTH = 1536;/.test(geometry) && /HERO_CHARACTER_HEIGHT = 960;/.test(geometry));
  assert.ok(/HERO_ART_WIDTH = 1586;/.test(geometry) && /HERO_ART_HEIGHT = 992;/.test(geometry));
  const hero = await read("src/components/home/home-report-hero.tsx");
  assert.ok(/<CharacterSlot source=\{FIXED_REPORT_CHARACTER_SOURCE\} style=\{StyleSheet\.absoluteFill\} \/>/.test(hero), "fills the art box");
  // The background and the character are siblings inside the one aspect-ratio box.
  const artBox = hero.slice(hero.indexOf("styles.artBox"), hero.indexOf("styles.content"));
  assert.ok(artBox.includes("HERO_BACKGROUND_SOURCE") && artBox.includes("<CharacterSlot"));
  assert.ok(/contentFit="fill"/.test(artBox), "the background fills the box that already has its own aspect ratio");
});
