// Pins the approved v3 bottom navigation (ホーム/銘柄/レポート/AIに聞く/設定).
// src/app/(tabs)/_layout.tsx imports expo-router/unstable-native-tabs, which
// needs a real RN/Expo runtime, so this reads the source as text -- the same
// static-analysis approach the rest of this suite uses for RN-only files.
import assert from "node:assert/strict";
import test from "node:test";

async function source() {
  return Deno.readTextFile(new URL("../../src/app/(tabs)/_layout.tsx", import.meta.url));
}

test("the bottom tabs are exactly the approved v3 set, in order", async () => {
  const text = await source();
  const triggers = [...text.matchAll(/<NativeTabs\.Trigger name="([^"]+)">\s*<NativeTabs\.Trigger\.Label>([^<]+)<\/NativeTabs\.Trigger\.Label>/g)]
    .map((m) => ({ name: m[1], label: m[2] }));
  assert.deepEqual(triggers, [
    { name: "index", label: "ホーム" },
    { name: "explore", label: "銘柄" },
    { name: "reports", label: "レポート" },
    { name: "ai", label: "AIに聞く" },
    { name: "settings", label: "設定" },
  ]);
});

test("portfolio and news are not tab triggers, even though their routes still exist", async () => {
  const text = await source();
  assert.ok(!/name="portfolio"/.test(text), "portfolio must not be a tab trigger");
  assert.ok(!/name="news"/.test(text), "news must not be a tab trigger");
});
