// Pins the bottom navigation (user decision 2026-09-29): ホーム/銘柄/ニュース/レポート/メニュー.
// iOS shows at most 5 native tabs, so the rest live inside メニュー. src/app/(tabs)/_layout.tsx imports
// expo-router/unstable-native-tabs, which needs a real RN/Expo runtime, so this reads the source as
// text -- the same static-analysis approach the rest of this suite uses for RN-only files.
import assert from "node:assert/strict";
import test from "node:test";

async function source() {
  return Deno.readTextFile(new URL("../../src/app/(tabs)/_layout.tsx", import.meta.url));
}

test("the bottom tabs are exactly ホーム/銘柄/ニュース/レポート/メニュー, in order", async () => {
  const text = await source();
  const triggers = [...text.matchAll(/<NativeTabs\.Trigger name="([^"]+)">\s*<NativeTabs\.Trigger\.Label>([^<]+)<\/NativeTabs\.Trigger\.Label>/g)]
    .map((m) => ({ name: m[1], label: m[2] }));
  assert.deepEqual(triggers, [
    { name: "index", label: "ホーム" },
    { name: "explore", label: "銘柄" },
    { name: "news", label: "ニュース" },
    { name: "reports", label: "レポート" },
    { name: "menu", label: "メニュー" },
  ]);
});

test("there are at most 5 native tabs (a 6th would collapse into iOS' その他)", async () => {
  const text = await source();
  assert.ok([...text.matchAll(/<NativeTabs\.Trigger name=/g)].length <= 5);
});

test("destinations reached from メニュー are not tab triggers", async () => {
  const text = await source();
  for (const name of ["portfolio", "settings", "ai", "topics", "topic-detail"]) {
    assert.ok(!new RegExp(`name="${name}"`).test(text), `${name} must not be a tab trigger`);
  }
});
