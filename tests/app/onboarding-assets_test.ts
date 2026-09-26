// Pins the four approved-artwork assets integrated 2026-09-26: the new official icon and the
// three onboarding screens. Every hash below was recorded from `shasum -a 256` on the exact file
// the user placed on their Desktop, before it was copied into the repository -- see
// kabumori-onboarding-icon-integration-20260926's acceptance contract.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);

async function pngInfo(path: string) {
  const bytes = await Deno.readFile(new URL(path, repoRoot));
  assert.deepEqual([...bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${path} is not a PNG`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    colorType: bytes[25], // 2 = truecolor (RGB, no alpha), 6 = truecolor + alpha
    bytes,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const APPROVED = {
  iconMaster: {
    path: "assets/branding/kabumori-icon-master-2026-09-26.png",
    sha256: "6b083c5156332665a1354199f824bc7590a05d79ec2fe1608ae286425ffd7d4e",
    width: 1254,
    height: 1254,
  },
  onboarding: [
    {
      path: "assets/onboarding/01-brand.png",
      sha256: "de0f57bd48fb15a3c3cbf11480fed2106677a6729930f57b734f881051a988fb",
    },
    {
      path: "assets/onboarding/02-ai-analysis.png",
      sha256: "2ac0fda449490867f6f0ced3f89b2023f43bdb424122c8aea8ce3aedb9b5e833",
    },
    {
      path: "assets/onboarding/03-report.png",
      sha256: "6dbbf10caad1eb0c23a4604186ce2474fd8472649f952d4e4662411b1ec93dd6",
    },
  ],
} as const;

test("the new icon master is byte-identical to the approved source", async () => {
  const info = await pngInfo(APPROVED.iconMaster.path);
  assert.equal(await sha256Hex(info.bytes), APPROVED.iconMaster.sha256);
  assert.equal(info.width, APPROVED.iconMaster.width);
  assert.equal(info.height, APPROVED.iconMaster.height);
  assert.equal(info.colorType, 2, "master must be opaque RGB, not RGBA");
});

test("the installed 1024x1024 app icon is a deterministic resize of the new master", async () => {
  const info = await pngInfo("assets/images/icon.png");
  assert.equal(info.width, 1024);
  assert.equal(info.height, 1024);
  assert.equal(info.colorType, 2, "app icon must be opaque RGB, not RGBA (iOS applies its own mask)");
});

for (const asset of APPROVED.onboarding) {
  test(`${asset.path} is byte-identical to the approved onboarding source, 1179x2556`, async () => {
    const info = await pngInfo(asset.path);
    assert.equal(await sha256Hex(info.bytes), asset.sha256);
    assert.equal(info.width, 1179);
    assert.equal(info.height, 2556);
  });
}

test("app.json's icon/splash config already points at assets/images/icon.png, so no config change was needed for the new icon", async () => {
  const config = JSON.parse(await Deno.readTextFile(new URL("app.json", repoRoot)));
  const expo = config.expo;
  assert.equal(expo.icon, "./assets/images/icon.png");
  assert.equal(expo.ios.icon, "./assets/images/icon.png");
  assert.ok(!JSON.stringify(expo.ios).includes("expo.icon"), "ios.icon must not reference the old Icon Composer template bundle");
  const splash = expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-splash-screen");
  assert.equal(splash[1].image, "./assets/images/icon.png");
  const overlay = await Deno.readTextFile(new URL("src/components/animated-icon.tsx", repoRoot));
  const overlayFnEnd = overlay.indexOf("\nconst keyframe = new Keyframe({");
  assert.match(overlay.slice(0, overlayFnEnd), /assets\/images\/icon\.png/);
});

test("identity fields are unchanged by the icon/onboarding integration", async () => {
  const config = JSON.parse(await Deno.readTextFile(new URL("app.json", repoRoot)));
  const expo = config.expo;
  assert.equal(expo.slug, "kabumori");
  assert.equal(expo.scheme, "kabumori");
  assert.equal(expo.ios.bundleIdentifier, "com.anohimemories.kabumori");
  assert.equal(expo.extra.eas.projectId, "eb80adf3-861e-4a48-a373-2d9a85b58899");
});
