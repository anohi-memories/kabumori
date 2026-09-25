// Pins the approved app icon integration (2026-09-25): the master asset's provenance
// (dimensions, hash) and every Expo config field that references the app icon.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);

/** Reads a PNG's IHDR chunk without any image-processing dependency. */
async function pngInfo(path: string) {
  const bytes = await Deno.readFile(new URL(path, repoRoot));
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} is not a PNG`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: bytes[24],
    // PNG colour type: 2 = truecolor (RGB, no alpha), 6 = truecolor + alpha.
    colorType: bytes[25],
    bytes,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Recorded once, from `shasum -a 256` on the file the user placed at ~/Desktop/アイコン.png,
// before it was copied into the repository. If this ever fails, the master file in the repo is
// not byte-identical to what the user approved and must not be treated as authoritative.
const APPROVED_MASTER_SHA256 = "31eda5379951b3d8f69676add4add33ecea6d799a48545ef076bd6235949a3f8";

test("the preserved master is byte-identical to the approved source (by hash)", async () => {
  const info = await pngInfo("assets/branding/kabumori-icon-master-2026-09-25.png");
  assert.equal(await sha256Hex(info.bytes), APPROVED_MASTER_SHA256);
  assert.equal(info.width, 1254);
  assert.equal(info.height, 1254);
  assert.equal(info.colorType, 2, "master must be opaque RGB, not RGBA");
});

test("the 1024x1024 app icon is a deterministic resize of the master, opaque, no crop", async () => {
  const info = await pngInfo("assets/images/icon.png");
  assert.equal(info.width, 1024);
  assert.equal(info.height, 1024);
  assert.equal(info.colorType, 2, "app icon must be opaque RGB, not RGBA (iOS applies its own mask)");
});

test("every Expo config field that renders the app icon points at the new master, not the Expo template", async () => {
  const config = JSON.parse(await Deno.readTextFile(new URL("app.json", repoRoot)));
  const expo = config.expo;
  assert.equal(expo.icon, "./assets/images/icon.png");
  assert.equal(expo.ios.icon, "./assets/images/icon.png");
  assert.ok(!JSON.stringify(expo.ios).includes("expo.icon"), "ios.icon must not reference the old Icon Composer template bundle");
  const notifications = expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-notifications");
  assert.equal(notifications[1].icon, "./assets/images/icon.png");
});

test("this task's own scope stayed to the app icon: identity fields untouched", async () => {
  // Splash/launch-overlay branding is covered by kabumori-branded-launch-screen-20260925 (see
  // tests/app/app-splash_test.ts); this test only pins what must never move regardless of which
  // task touches startup visuals.
  const config = JSON.parse(await Deno.readTextFile(new URL("app.json", repoRoot)));
  const expo = config.expo;
  assert.equal(expo.slug, "kabumori");
  assert.equal(expo.scheme, "kabumori");
  assert.equal(expo.ios.bundleIdentifier, "com.anohimemories.kabumori");
  assert.equal(expo.extra.eas.projectId, "eb80adf3-861e-4a48-a373-2d9a85b58899");
});
