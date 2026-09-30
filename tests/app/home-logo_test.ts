// The approved header logo (Desktop/ゆめちゃん素材/ヘッダーロゴ.png, RGBA PNG sha256 f5d152b7...e40c,
// 2005x784) was converted losslessly (cwebp -lossless -exact); the decoded RGBA was verified
// pixel-identical to that PNG. This pins the committed file so it is never recoloured/cropped/redrawn.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const LOGO = "assets/images/home/kabumori_header_logo.webp";
const LOGO_SHA256 = "7ebbc19eb90d32b7e878727aeeacec2cdcbaef5f8072e4d2b2f711b11c02f5c1";

test("the header logo is the exact committed lossless WebP with alpha, 2005x784", async () => {
  const bytes = await Deno.readFile(new URL(LOGO, repoRoot));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), "VP8L", "must stay lossless");
  assert.equal(bytes[20], 0x2f);
  const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
  assert.equal((bits & 0x3fff) + 1, 2005);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, 784);
  assert.equal((bits >>> 28) & 1, 1, "transparent background must be kept");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert.equal(hex, LOGO_SHA256);
});

test("the slot keeps the logo's aspect ratio (contain) and stays a compact header element", async () => {
  const header = await Deno.readTextFile(new URL("src/components/home/home-header.tsx", repoRoot));
  const m = /HEADER_LOGO_SLOT = \{ width: (\d+), height: (\d+) \}/.exec(header);
  assert.ok(m);
  assert.ok(Number(m[2]) <= 40, "the header must stay compact");
  assert.ok(header.includes('contentFit="contain"'));
});
