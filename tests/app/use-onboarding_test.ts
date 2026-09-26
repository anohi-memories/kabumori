// Pins ONBOARDING_V1_KEY and the "never trap the user" failure mode. The hook itself
// (src/hooks/use-onboarding.ts) is a React hook and needs a component tree to exercise fully
// (covered instead by real-device/manual verification per this task's own limits); this file pins
// its pure, non-React contract: the exact storage key and value convention, which _layout.tsx and
// any future maintenance depend on staying stable.
import assert from "node:assert/strict";
import test from "node:test";

// Not imported as a live module: it pulls in @react-native-async-storage/async-storage and React,
// neither of which runs under plain Deno. Every assertion here reads the file as text instead, the
// same static-analysis approach the rest of this suite already uses for RN-only source.
async function hookSource() {
  return Deno.readTextFile(new URL("../../src/hooks/use-onboarding.ts", import.meta.url));
}

test("the onboarding completion key is versioned and namespaced", async () => {
  const source = await hookSource();
  assert.match(source, /ONBOARDING_V1_KEY = 'kabumori:onboarding:v1'/);
});

test("the hook module never imports anything beyond AsyncStorage and React -- no network client", async () => {
  const source = await hookSource();
  const imports = [...source.matchAll(/^import .* from '([^']+)';?$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['@react-native-async-storage/async-storage', 'react']);
  assert.ok(!/fetch\(|XMLHttpRequest|@\/lib\/supabase/.test(source), "onboarding completion must not depend on a network call");
});

test("a storage read failure resolves to completed=true (fails open), never leaves it null forever", async () => {
  const source = await Deno.readTextFile(new URL("../../src/hooks/use-onboarding.ts", import.meta.url));
  const catchBlock = /\.catch\(\(\) => \{\s*if \(active\) setCompleted\((true|false)\);/.exec(source);
  assert.ok(catchBlock, "the getItem().catch() must set a definite value, not leave completed stuck at null");
  assert.equal(catchBlock[1], "true", "a read failure must fail OPEN (skip onboarding), never trap the user behind it");
});

test("complete() updates local state immediately and does not await the persistence write", async () => {
  const source = await Deno.readTextFile(new URL("../../src/hooks/use-onboarding.ts", import.meta.url));
  const fnStart = source.indexOf("function complete()");
  const fnBody = source.slice(fnStart, source.indexOf("\n}", fnStart));
  const setIndex = fnBody.indexOf("setCompleted(true)");
  const writeIndex = fnBody.indexOf("AsyncStorage.setItem");
  assert.ok(setIndex > -1 && writeIndex > -1 && setIndex < writeIndex, "local state must update before/without waiting on the storage write");
  assert.match(fnBody, /AsyncStorage\.setItem\([^)]*\)\.catch\(\(\) => \{\}\)/, "a failed write must not throw/reject unhandled");
});
