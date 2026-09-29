// Phase 1 of the Home report-card character: one fixed approved neutral artwork.
// The asset was converted losslessly (cwebp -lossless -exact) from the user's approved
// transparent PNG (Desktop/ゆめちゃん素材/report_04_neutral.webp.png, sha256 131c7f1d...7051);
// the decoded RGBA was verified pixel-identical to that PNG before it was committed.
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

test("the Home report card shows the one fixed 04 source in CharacterSlot, with no state selection", async () => {
  const card = await read("src/components/home/report-highlight-card.tsx");
  assert.ok(card.includes("require('@/assets/images/report-states/report_04_neutral.webp')"));
  assert.ok(/const FIXED_REPORT_CHARACTER_SOURCE = require\(/.test(card));
  assert.ok(/<CharacterSlot palette=\{palette\} source=\{FIXED_REPORT_CHARACTER_SOURCE\} \/>/.test(card));
  // Phase 2 (10-state selection) is out of scope: only the one asset may be referenced.
  assert.equal((card.match(/report-states\//g) ?? []).length, 1);
  assert.ok(!/report_0[0-35-9]|report_10/.test(card));
});

test("CharacterSlot keeps the artwork uncropped, decorative and adjustable from constants", async () => {
  const slot = await read("src/components/home/character-slot.tsx");
  assert.ok(slot.includes('contentFit="contain"'));
  assert.ok(!/overflow:\s*'hidden'/.test(slot), "an offset must never crop the artwork");
  assert.ok(slot.includes('importantForAccessibility="no-hide-descendants"'));
  assert.ok(slot.includes("accessible={false}"));
  for (const name of ["CHARACTER_SLOT_WIDTH_PERCENT", "CHARACTER_OFFSET_X", "CHARACTER_OFFSET_Y", "CHARACTER_ASPECT_RATIO"]) {
    assert.ok(new RegExp(`export const ${name} =`).test(slot), name);
  }
  // No frame/glow/background around the transparent artwork.
  const styles = slot.slice(slot.indexOf("StyleSheet.create"));
  const slotStyle = styles.slice(styles.indexOf("slot:"), styles.indexOf("placeholder:"));
  assert.ok(!/backgroundColor|border|shadow/.test(slotStyle));
});

test("the artwork takes about the right third of the card, 3:2, bottom-aligned", async () => {
  const slot = await read("src/components/home/character-slot.tsx");
  const percent = Number(/export const CHARACTER_SLOT_WIDTH_PERCENT = '(\d+)%';/.exec(slot)?.[1]);
  assert.ok(percent >= 30 && percent <= 40, `${percent}% should stay around one third of the card`);
  assert.ok(/aspectRatio: CHARACTER_ASPECT_RATIO/.test(slot));
  const card = await read("src/components/home/report-highlight-card.tsx");
  assert.ok(/headRow: \{[^}]*alignItems: 'flex-end'/.test(card), "the character sits on the bottom edge of the header block");
});

test("the report title shrinks instead of wrapping a stray glyph when the text column is narrow", async () => {
  const card = await read("src/components/home/report-highlight-card.tsx");
  const title = card.slice(card.indexOf("styles.title, {"), card.indexOf("今日の かぶモリレポート"));
  assert.ok(title.includes("numberOfLines={1}") && title.includes("adjustsFontSizeToFit") && title.includes("minimumFontScale"));
});
