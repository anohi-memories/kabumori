// Pins the Kabumori-branded launch screen (2026-09-25): native splash config, the
// AnimatedSplashOverlay component, and that no Expo template asset renders on a normal launch.
import assert from "node:assert/strict";
import test from "node:test";

const repoRoot = new URL("../../", import.meta.url);

async function readApp() {
  return JSON.parse(await Deno.readTextFile(new URL("app.json", repoRoot)));
}

async function readOverlaySource() {
  return Deno.readTextFile(new URL("src/components/animated-icon.tsx", repoRoot));
}

test("the native splash config uses the approved icon, not the Expo template", async () => {
  const config = await readApp();
  const splash = config.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-splash-screen");
  assert.ok(splash, "expo-splash-screen plugin config must exist");
  assert.equal(splash[1].image, "./assets/images/icon.png");
  assert.notEqual(splash[1].image, "./assets/images/splash-icon.png");
  assert.equal(splash[1].backgroundColor, "#eef3ed");
  assert.notEqual(splash[1].backgroundColor, "#208AEF");
});

test("the native splash icon size matches the overlay's, so there is no size jump on handoff", async () => {
  const config = await readApp();
  const splash = config.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-splash-screen");
  const overlay = await readOverlaySource();
  const sizeMatch = /SPLASH_ICON_SIZE\s*=\s*(\d+)/.exec(overlay);
  assert.ok(sizeMatch, "SPLASH_ICON_SIZE must be defined in animated-icon.tsx");
  assert.equal(splash[1].imageWidth, Number(sizeMatch[1]));
});

test("AnimatedSplashOverlay renders the approved icon, not expo-logo.png", async () => {
  const overlay = await readOverlaySource();
  // Only the AnimatedSplashOverlay function's own body is checked -- the unused, untouched
  // AnimatedIcon export (below it in the same file) still legitimately uses expo-logo.png.
  const overlayFnEnd = overlay.indexOf("\nconst keyframe = new Keyframe({");
  assert.ok(overlayFnEnd > -1, "could not isolate the AnimatedSplashOverlay function body");
  const overlayFnSource = overlay.slice(0, overlayFnEnd);
  assert.match(overlayFnSource, /export function AnimatedSplashOverlay/);
  assert.match(overlayFnSource, /assets\/images\/icon\.png/);
  assert.ok(!overlayFnSource.includes("expo-logo.png"), "AnimatedSplashOverlay must not reference the Expo logo");
});

test("the overlay's background matches the native splash background, kept as one exported constant", async () => {
  const config = await readApp();
  const splash = config.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-splash-screen");
  const overlay = await readOverlaySource();
  const bgMatch = /SPLASH_BACKGROUND\s*=\s*'(#[0-9a-fA-F]{6})'/.exec(overlay);
  assert.ok(bgMatch, "SPLASH_BACKGROUND must be exported from animated-icon.tsx");
  assert.equal(bgMatch[1].toLowerCase(), splash[1].backgroundColor.toLowerCase());
});

test("the overlay reliably disappears: the exit animation always calls setVisible(false)", async () => {
  const overlay = await readOverlaySource();
  const lines = overlay.split("\n").map((line) => line.trim());
  assert.ok(lines.some((line) => /^withCallback\(\(finished\) => \{$/.test(line) || /withCallback\(\(finished\) => \{/.test(line) && !line.startsWith("//")));
  // Not just "the text exists somewhere" -- the exact call must be live code, not commented out.
  assert.ok(
    lines.some((line) => line === "scheduleOnRN(setVisible, false);"),
    "scheduleOnRN(setVisible, false) must be an uncommented, executable line",
  );
});

test("Reduce Motion is honored: the animated exit is skipped entirely when it is enabled", async () => {
  const overlay = await readOverlaySource();
  assert.match(overlay, /AccessibilityInfo/);
  assert.match(overlay, /isReduceMotionEnabled/);
  // The reduce-motion branch must itself call setVisible(false), so a Reduce Motion user's overlay
  // still reliably disappears even though it skips the Animated.View/entering path.
  const onLayoutBlock = overlay.slice(overlay.indexOf("onLayout={() => {"), overlay.indexOf("style={styles.splashOverlay}>\n      {image}\n    </View>"));
  assert.match(onLayoutBlock, /if \(reduceMotionRef\.current\) \{[\s\S]*?setVisible\(false\);/);
});

test("the exit animation is a gentle fade + slight scale-down, not the old bounce", async () => {
  const overlay = await readOverlaySource();
  const overlayFnEnd = overlay.indexOf("\nconst keyframe = new Keyframe({");
  const overlayFnSource = overlay.slice(0, overlayFnEnd);
  assert.match(overlayFnSource, /opacity:\s*0/);
  assert.match(overlayFnSource, /scale:\s*0\.94/);
  assert.ok(!overlayFnSource.includes("Easing.elastic"), "the launch-screen exit should not use the old bouncy easing");
});

test("no normal-launch code path renders the Expo template mark", async () => {
  const layout = await Deno.readTextFile(new URL("src/app/_layout.tsx", repoRoot));
  assert.ok(!layout.includes("expo-logo"), "_layout.tsx must not reference the Expo logo directly");
  const overlay = await readOverlaySource();
  // expo-logo.png is not truly unused (AnimatedIcon, which nothing imports, still references it),
  // so the file stays -- this pins that the only *reachable* reference is that dead export.
  const reachable = new Set<string>();
  if ((await Deno.readTextFile(new URL("src/app/_layout.tsx", repoRoot))).includes("AnimatedSplashOverlay")) {
    reachable.add("AnimatedSplashOverlay");
  }
  assert.deepEqual([...reachable], ["AnimatedSplashOverlay"]);
  const overlayFnEnd = overlay.indexOf("\nconst keyframe = new Keyframe({");
  assert.ok(!overlay.slice(0, overlayFnEnd).includes("expo-logo"));
});

test("bundleIdentifier, slug, scheme and projectId are unchanged by the launch-screen work", async () => {
  const config = await readApp();
  const expo = config.expo;
  assert.equal(expo.slug, "kabumori");
  assert.equal(expo.scheme, "kabumori");
  assert.equal(expo.ios.bundleIdentifier, "com.anohimemories.kabumori");
  assert.equal(expo.extra.eas.projectId, "eb80adf3-861e-4a48-a373-2d9a85b58899");
  // And the app icon itself, which this task must not touch.
  assert.equal(expo.icon, "./assets/images/icon.png");
  assert.equal(expo.ios.icon, "./assets/images/icon.png");
});
