// The Home Report Hero's character layer, phase 1: one fixed approved neutral (04) artwork.
// The asset was converted losslessly (cwebp -lossless -exact) from the user's approved
// transparent PNG (Desktop/ゆめちゃん素材/report_04_neutral.webp.png, sha256 131c7f1d...7051); the
// decoded RGBA was verified pixel-identical to that PNG before it was committed. The file below is
// the canonical 04 -- it is never cropped, redrawn or duplicated.
// RN-only components are checked as text, like the rest of this suite.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const ASSET = "assets/images/report-states/report_04_neutral.webp";
const ASSET_SHA256 = "d51dd2f91207bb48589268aca76b6025dd17ab5961165c089e64124452499c7a";

const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("the approved 04 artwork is the exact committed lossless WebP with alpha, 1536x1024", async () => {
  const bytes = await Deno.readFile(new URL(ASSET, repoRoot));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), "VP8L", "must stay lossless");
  // VP8L header: signature 0x2f, then 14-bit (width-1), 14-bit (height-1), 1-bit alpha_is_used.
  assert.equal(bytes[20], 0x2f);
  const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
  assert.equal((bits & 0x3fff) + 1, 1536);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, 1024);
  assert.equal((bits >>> 28) & 1, 1, "alpha channel must be present (transparent background)");
  assert.equal(await sha256Hex(bytes), ASSET_SHA256);
});

test("there is exactly one report-state artwork: no crop copy, no other states", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL("assets/images/report-states/", repoRoot))) names.push(entry.name);
  assert.deepEqual(names, ["report_04_neutral.webp"]);
});

test("the Hero uses the one fixed 04 source in the CharacterSlot layer, with no state selection", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  assert.ok(/const FIXED_REPORT_CHARACTER_SOURCE = require\('@\/assets\/images\/report-states\/report_04_neutral\.webp'\);/.test(hero));
  assert.ok(/<CharacterSlot\s+source=\{FIXED_REPORT_CHARACTER_SOURCE\}/.test(hero));
  assert.equal((hero.match(/report-states\//g) ?? []).length, 1);
  assert.ok(!/report_0[0-35-9]|report_10/.test(hero));
});

test("CharacterSlot keeps the artwork uncropped, decorative and frameless", async () => {
  const slot = await read("src/components/home/character-slot.tsx");
  assert.ok(slot.includes('contentFit="contain"'));
  assert.ok(!/overflow:\s*'hidden'/.test(slot), "the layer must never crop the artwork");
  assert.ok(slot.includes('importantForAccessibility="no-hide-descendants"'));
  assert.ok(slot.includes("accessible={false}"));
  assert.ok(/CHARACTER_ASPECT_RATIO = 1536 \/ 1024;/.test(slot), "must match the 1536x1024 canvas");
  const styles = slot.slice(slot.indexOf("StyleSheet.create"));
  assert.ok(!/backgroundColor|border|shadow/.test(styles), "no frame/glow/background around the transparent artwork");
});

test("the character is flush top-right, about half of the Hero, and never over the points", async () => {
  const tokens = await read("src/constants/home-tokens.ts");
  const percent = Number(/characterWidthPercent: '(\d+)%'/.exec(tokens)?.[1]);
  assert.ok(percent >= 42 && percent <= 56, `${percent}% should be about half of the Hero`);
  const hero = await read("src/components/home/home-report-hero.tsx");
  // The layer lives in the top row (in flow), before the full-width points block.
  assert.ok(hero.indexOf("<CharacterSlot") < hero.indexOf("style={styles.points}"), "character comes before the points block");
  assert.ok(/character: \{ width: HERO\.characterWidthPercent, marginLeft: 'auto' \}/.test(hero));
  assert.ok(!/position: 'absolute'[^}]*CharacterSlot|CharacterSlot[^>]*position: 'absolute'/.test(hero));
});
