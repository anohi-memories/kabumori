import assert from "node:assert/strict";
import test from "node:test";

import { buildLegalLinks } from "../../src/lib/legal-links.ts";

test("all three entries always exist, configured or not", () => {
  const links = buildLegalLinks({});
  assert.deepEqual(links.map((link) => link.key), ["privacy", "terms", "support"]);
  for (const link of links) {
    assert.equal(link.url, null);
    // An unconfigured entry still says something useful instead of dead-ending.
    assert.ok(link.unavailableMessage.includes(link.label));
  }
});

test("configured https and mailto destinations are used as given", () => {
  const links = buildLegalLinks({
    EXPO_PUBLIC_PRIVACY_POLICY_URL: "https://example.com/privacy",
    EXPO_PUBLIC_TERMS_OF_SERVICE_URL: " https://example.com/terms ",
    EXPO_PUBLIC_SUPPORT_URL: "mailto:support@example.com",
  });
  assert.deepEqual(links.map((link) => link.url), [
    "https://example.com/privacy",
    "https://example.com/terms",
    "mailto:support@example.com",
  ]);
});

test("a placeholder or non-openable value is treated as unset, never opened", () => {
  for (const value of ["", "   ", "TODO", "example.com", "http://example.com", "javascript:alert(1)"]) {
    const [privacy] = buildLegalLinks({ EXPO_PUBLIC_PRIVACY_POLICY_URL: value });
    assert.equal(privacy.url, null, value);
  }
});
