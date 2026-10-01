// The Home Report Hero assets: the approved final Hero background and the eight approved character
// images (01 very positive ... 08 volatile). Every file is a lossless WebP (cwebp -lossless -exact)
// converted from the user's PNG in Desktop/ゆめちゃん素材 and verified pixel-identical (RGBA) before
// commit: same pixel dimensions, alpha kept, no crop / resize / recolour / sharpen / denoise.
// Seven characters and the background are 1586x992; 03 neutral is 1536x960 (reported, not "fixed").
// RN-only components are checked as text, like the rest of this suite.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, repoRoot));

const BACKGROUND = ["assets/images/home/report_hero_background.webp", 1586, 992, "befc7168c04051a9558c175ee9059d27b00677b0fcd1cd6b7a1ed1fe882fff11"] as const;
const CHARACTERS: ReadonlyArray<readonly [string, number, number, string]> = [
  ["report_01_very_positive.webp", 1586, 992, "e125f2d2a71dc122ad940ad9939d98adc1a25992e4a426535f334610628adca7"],
  ["report_02_positive.webp", 1586, 992, "4b152fdbe5586c79549fe071868ae428c1b416e3253c15d2a4987e42672527fa"],
  ["report_03_neutral.webp", 1536, 960, "14f2ab72933a47929f1f1c34a9b2e17c591082d020df3827c8aa6864242f19e3"],
  ["report_04_uncertain.webp", 1586, 992, "f25f942dd053ab9d247c93bf0834e0211f326f05be708c0872537fa1fbc4eab6"],
  ["report_05_caution.webp", 1586, 992, "c291282277b7efb62503d363476c9ca14f7b372febe2ebd4839542b757f199ae"],
  ["report_06_negative.webp", 1586, 992, "5452c3aa3ee426ddc84a7cfbc2b6ca2e4129a61fb2869f8d6626030fe89f5976"],
  ["report_07_very_negative.webp", 1586, 992, "8927eae433315354a7ebb65df7c6e1316201ebf5c38b612c6194085db7d9e024"],
  ["report_08_volatile.webp", 1586, 992, "a6f70662af9fbc907343a381373cf8ed8de53119af2afb70f5e1c9d5b60b0d96"],
];

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function assertLosslessWebp(path: string, w: number, h: number, sha: string, alpha: boolean) {
  const bytes = await Deno.readFile(new URL(path, repoRoot));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF", path);
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP", path);
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), "VP8L", `${path} must stay lossless`);
  // VP8L header: signature 0x2f, then 14-bit (width-1), 14-bit (height-1), 1-bit alpha_is_used.
  assert.equal(bytes[20], 0x2f);
  const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
  assert.equal((bits & 0x3fff) + 1, w, `${path} width`);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, h, `${path} height`);
  if (alpha) assert.equal((bits >>> 28) & 1, 1, `${path} must keep its alpha channel`);
  assert.equal(await sha256Hex(bytes), sha, `${path} must be the approved file, byte for byte`);
}

test("the Hero background is the approved lossless WebP, 1586x992", () =>
  assertLosslessWebp(BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], BACKGROUND[3], false));

for (const [name, w, h, sha] of CHARACTERS) {
  test(`${name} is the approved lossless WebP with alpha, ${w}x${h}`, () =>
    assertLosslessWebp(`assets/images/report-states/${name}`, w, h, sha, true));
}

test("report-states holds exactly the eight canonical files, and the old neutral file is gone", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(new URL("assets/images/report-states/", repoRoot))) names.push(entry.name);
  assert.deepEqual(names.sort(), CHARACTERS.map(([name]) => name).sort());
  assert.ok(!names.includes("report_04_neutral.webp"), "the old report_04_neutral.webp (now 03 neutral) must not remain");
});

test("the eight states map one-to-one onto the eight files, in 01..08 order", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  const map: Record<string, string> = {
    very_positive: "report_01_very_positive.webp",
    positive: "report_02_positive.webp",
    neutral: "report_03_neutral.webp",
    uncertain: "report_04_uncertain.webp",
    caution: "report_05_caution.webp",
    negative: "report_06_negative.webp",
    very_negative: "report_07_very_negative.webp",
    volatile: "report_08_volatile.webp",
  };
  for (const [state, file] of Object.entries(map)) {
    assert.ok(
      hero.includes(`${state}: require('@/assets/images/report-states/${file}'),`),
      `${state} -> ${file}`,
    );
  }
  assert.equal((hero.match(/report-states\//g) ?? []).length, 8, "exactly the eight canonical requires");
});

test("the runtime no longer references the old fixed neutral asset or 10-state naming", async () => {
  for (const path of [
    "src/components/home/home-report-hero.tsx",
    "src/components/home/character-slot.tsx",
    "src/lib/home-hero-geometry.ts",
    "src/lib/report-character-state.ts",
  ]) {
    const text = await read(path);
    assert.ok(!/report_04_neutral|FIXED_REPORT_CHARACTER_SOURCE|10-state|10状態|01〜10|01-10/.test(text), `${path} still has old naming`);
  }
});

test("the selected character is drawn by the one full-canvas rule, with no per-state layout tweaks", async () => {
  const hero = await read("src/components/home/home-report-hero.tsx");
  const slot = await read("src/components/home/character-slot.tsx");
  assert.ok(/<CharacterSlot source=\{CHARACTER_SOURCES\[characterState\]\} \/>/.test(hero), "no per-state props");
  assert.ok(hero.includes("selectReportCharacterState(report)"));
  // Full canvas: absolute fill, contain, uncropped, decorative, frameless, never takes touches.
  assert.ok(slot.includes("StyleSheet.absoluteFill"));
  assert.ok(slot.includes('contentFit="contain"'));
  assert.ok(!/overflow:\s*'hidden'/.test(slot), "the layer must never crop the artwork");
  assert.ok(slot.includes('importantForAccessibility="no-hide-descendants"'));
  assert.ok(slot.includes("accessible={false}"));
  assert.ok(slot.includes('pointerEvents="none"'), "the character must not block the CTA");
  const code = (text: string) => text.replace(/\/\/.*$/gm, "");
  assert.ok(!/translate|scale|offset|resizeMode|contentPosition/i.test(code(slot)), "no per-state offset/scale in the layer");
  assert.ok(!/translate|offset|contentPosition/i.test(code(hero)), "no per-state offset in the Hero");
  const styles = slot.slice(slot.indexOf("StyleSheet.create"));
  assert.ok(!/backgroundColor|border|shadow/.test(styles), "no frame/glow/background around the transparent artwork");
});

test("the character is stacked 1:1 on the art box: same box as the background", async () => {
  const geometry = await read("src/lib/home-hero-geometry.ts");
  assert.ok(/HERO_ART_WIDTH = 1586;/.test(geometry) && /HERO_ART_HEIGHT = 992;/.test(geometry));
  const hero = await read("src/components/home/home-report-hero.tsx");
  const artBox = hero.slice(hero.indexOf("styles.artBox"), hero.indexOf("styles.content"));
  assert.ok(artBox.includes("HERO_BACKGROUND_SOURCE") && artBox.includes("<CharacterSlot"), "siblings in one aspect-ratio box");
  assert.ok(/contentFit="fill"/.test(artBox), "the background fills the box that already has its own aspect ratio");
});
