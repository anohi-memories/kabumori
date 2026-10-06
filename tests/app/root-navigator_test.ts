// Regression guard for the "every tap on Home does nothing" bug: expo-router/unstable-native-tabs only
// registers routes that have a NativeTabs.Trigger inside the (tabs) group -- router.push() to any route
// outside it silently no-ops unless that route is registered as a Stack.Screen in the root navigator
// (SignedInNavigator in src/app/_layout.tsx). This scans every literal router.push / pathname / menu
// href in src and requires its top-level segment to be either a tab trigger or a root Stack screen.
//
// RN-only source is read as text -- the same static-analysis approach the rest of this suite uses.
import assert from "node:assert/strict";
import test from "node:test";

import { MENU_ENTRIES } from "../../src/lib/menu-entries.ts";

const read = (path: string) => Deno.readTextFile(new URL(path, import.meta.url));

async function rootScreens() {
  const text = await read("../../src/app/_layout.tsx");
  return [...text.matchAll(/<Stack\.Screen name="([^"]+)"/g)].map((m) => m[1]);
}

async function tabTriggers() {
  const text = await read("../../src/app/(tabs)/_layout.tsx");
  return [...text.matchAll(/<NativeTabs\.Trigger name="([^"]+)"/g)].map((m) => m[1]);
}

async function* sourceFiles(dir = new URL("../../src/", import.meta.url)): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* sourceFiles(child);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield child;
  }
}

test("SignedInNavigator registers (tabs) plus every non-tab screen", async () => {
  assert.deepEqual(await rootScreens(), ["(tabs)", "topic-detail", "topics", "news-detail", "settings", "ai", "search"]);
});

test("the root Stack renders in place of the old AppTabs component (no dangling import)", async () => {
  const text = await read("../../src/app/_layout.tsx");
  assert.ok(!/@\/components\/app-tabs/.test(text));
  assert.ok(/<SignedInNavigator \/>/.test(text));
});

test("every literal navigation target resolves to a tab trigger or a root Stack screen", async () => {
  const known = new Set<string>(["", ...(await tabTriggers()).map((n) => (n === "index" ? "" : n)), ...(await rootScreens())]);
  const targets: Array<{ file: string; path: string }> = [];
  for await (const file of sourceFiles()) {
    const text = await Deno.readTextFile(file);
    for (const m of text.matchAll(/router\.(?:push|replace)\(\s*'(\/[^']*)'/g)) targets.push({ file: file.pathname, path: m[1] });
    for (const m of text.matchAll(/pathname:\s*'(\/[^']*)'/g)) targets.push({ file: file.pathname, path: m[1] });
  }
  assert.ok(targets.length >= 10, "expected to find the app's navigation calls");
  for (const { file, path } of targets) {
    const first = path.split("/")[1] ?? "";
    assert.ok(known.has(first), `${file}: '${path}' targets '${first}', which is neither a tab trigger nor a root Stack screen`);
  }
});

test("every メニュー entry points at a registered root Stack screen", async () => {
  const screens = new Set(await rootScreens());
  for (const entry of MENU_ENTRIES) assert.ok(screens.has(entry.href.slice(1)), `${entry.id} -> ${entry.href}`);
});
