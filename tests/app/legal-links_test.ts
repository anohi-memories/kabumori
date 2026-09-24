import assert from "node:assert/strict";
import test from "node:test";

import { PAGES } from "../../apps/kabumori-web/build.mjs";
import {
  buildLegalLinks,
  normalizeWebOrigin,
  PUBLIC_WEB_ROUTES,
} from "../../src/lib/legal-links.ts";

test("all three entries always exist, configured or not", () => {
  const links = buildLegalLinks({});
  assert.deepEqual(links.map((link) => link.key), ["privacy", "terms", "support"]);
  for (const link of links) {
    assert.equal(link.url, null);
    // An unconfigured entry still says something useful instead of dead-ending.
    assert.ok(link.unavailableMessage.includes(link.label));
  }
});

test("one configured origin yields every page URL", () => {
  const links = buildLegalLinks({ EXPO_PUBLIC_KABUMORI_WEB_URL: " https://kabumori.example.com/ " });
  assert.deepEqual(links.map((link) => link.url), [
    "https://kabumori.example.com/privacy",
    "https://kabumori.example.com/terms",
    "https://kabumori.example.com/support",
  ]);
});

test("a placeholder or non-origin value is treated as unset, never opened", () => {
  for (const value of [
    "",
    "   ",
    "TODO",
    "example.com",
    "http://example.com",
    "javascript:alert(1)",
    "https://example.com/privacy",
    "https://example.com?x=1",
    "https://localhost",
  ]) {
    assert.equal(normalizeWebOrigin(value), null, value);
    const [privacy] = buildLegalLinks({ EXPO_PUBLIC_KABUMORI_WEB_URL: value });
    assert.equal(privacy.url, null, value);
  }
});

test("every route the app links to is a page the public site actually builds", () => {
  const built = new Set(PAGES.map((page: { route: string }) => page.route));
  for (const route of Object.values(PUBLIC_WEB_ROUTES)) {
    assert.ok(built.has(route), `${route} is linked but not built`);
  }
});

test("URLs are not scattered: only legal-links.ts reads the web origin", async () => {
  const offenders: string[] = [];
  for await (const entry of walk(new URL("../../src/", import.meta.url))) {
    const source = await Deno.readTextFile(entry);
    const relative = entry.pathname.split("/src/").pop();
    if (relative === "lib/legal-links.ts") continue;
    if (/EXPO_PUBLIC_(KABUMORI_WEB_URL|PRIVACY|TERMS|SUPPORT)/.test(source)) offenders.push(relative ?? entry.pathname);
    if (/https:\/\/[^\s'"`]*\/(privacy|terms|support|account-deletion)\b/.test(source)) offenders.push(relative ?? entry.pathname);
  }
  assert.deepEqual(offenders, []);
});

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const item of Deno.readDir(dir)) {
    const child = new URL(item.name + (item.isDirectory ? "/" : ""), dir);
    if (item.isDirectory) yield* walk(child);
    else if (/\.(ts|tsx)$/.test(item.name)) yield child;
  }
}
