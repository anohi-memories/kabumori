// The approved header logo (Desktop/ゆめちゃん素材/ヘッダーロゴ.png, RGBA PNG sha256 f5d152b7...e40c,
// 2005x784). Only its empty transparent margin was trimmed (content bounds at alpha > 4, plus a 6px
// transparent margin: crop box x 142..1861, y 163..626 -> 1719x463); everything outside the box has
// alpha <= 1, and every pixel inside is unchanged (verified pixel-identical). The result was converted
// losslessly (cwebp -lossless -exact). No scaling, recolouring, redrawing or aspect change.
// This pins the committed file so it is never altered further.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);
const LOGO = "assets/images/home/kabumori_header_logo.webp";
const LOGO_SHA256 = "8152bc06c9a6d021a62195bba079acddc579765cd73edaa0418f97e6ab15c6fb";

test("the header logo is the exact committed lossless WebP with alpha, margin-trimmed 1719x463", async () => {
  const bytes = await Deno.readFile(new URL(LOGO, repoRoot));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(bytes.slice(8, 12)), "WEBP");
  assert.equal(new TextDecoder().decode(bytes.slice(12, 16)), "VP8L", "must stay lossless");
  assert.equal(bytes[20], 0x2f);
  const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
  assert.equal((bits & 0x3fff) + 1, 1719);
  assert.equal(((bits >>> 14) & 0x3fff) + 1, 463);
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
