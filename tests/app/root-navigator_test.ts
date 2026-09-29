// Regression guard for the "every tap on Home does nothing" bug: expo-router
// /unstable-native-tabs only registers routes that have a NativeTabs.Trigger
// inside the (tabs) group -- router.push() to any route outside that group
// (news, portfolio, topic-detail, search) silently no-ops unless that route
// is also registered as a Stack.Screen in the root navigator (see
// SignedInNavigator in src/app/_layout.tsx). This pins that every route the
// app actually router.push()es to from outside the tab group is present
// here, so a future route addition that forgets this registration fails a
// test instead of shipping a dead link.
//
// src/app/_layout.tsx imports expo-router/expo-splash-screen, which need a
// real RN/Expo runtime, so this reads the source as text -- the same
// static-analysis approach the rest of this suite uses for RN-only files.
import assert from "node:assert/strict";
import test from "node:test";

async function source() {
  return Deno.readTextFile(new URL("../../src/app/_layout.tsx", import.meta.url));
}

test("SignedInNavigator registers (tabs) plus every non-tab route pushed to from outside it", async () => {
  const text = await source();
  const screens = [...text.matchAll(/<Stack\.Screen name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(screens, ["(tabs)", "news", "portfolio", "topic-detail", "search"]);
});

test("the root Stack renders in place of the old AppTabs component (no dangling import)", async () => {
  const text = await source();
  assert.ok(!/@\/components\/app-tabs/.test(text), "app-tabs.tsx was removed; nothing should still import it");
  assert.ok(/<SignedInNavigator \/>/.test(text), "the signed-in branch must render the Stack-based navigator");
});
