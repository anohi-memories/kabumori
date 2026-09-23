import assert from "node:assert/strict";
import test from "node:test";

import { buildLegalLinks } from "../../src/lib/legal-links.ts";
import { settingsEntries } from "../../src/lib/settings-menu.ts";

const configured = buildLegalLinks({
  EXPO_PUBLIC_PRIVACY_POLICY_URL: "https://example.com/privacy",
  EXPO_PUBLIC_TERMS_OF_SERVICE_URL: "https://example.com/terms",
  EXPO_PUBLIC_SUPPORT_URL: "mailto:support@example.com",
});

test("every release-blocking entry is present and in a predictable order", () => {
  const ids = settingsEntries(configured, { email: "mail@example.com" }).map((entry) => entry.id);
  assert.deepEqual(ids, [
    "account-email",
    "password",
    "notifications",
    "privacy",
    "terms",
    "support",
    "logout",
    "delete-account",
  ]);
});

test("deleting the account is the last entry and is marked destructive", () => {
  const entries = settingsEntries(configured, { email: "mail@example.com" });
  const last = entries[entries.length - 1];
  assert.equal(last.id, "delete-account");
  assert.equal(last.kind, "destructive");
  assert.ok(last.description.includes("削除されます"));
});

test("no entry can dead-end: a link either has a destination or explains why not", () => {
  for (const legal of [configured, buildLegalLinks({})]) {
    for (const entry of settingsEntries(legal, { email: null })) {
      if (entry.kind !== "link") continue;
      assert.ok(
        (entry.url && !entry.unavailableMessage) || (!entry.url && entry.unavailableMessage),
        `${entry.id} must have exactly one of url / unavailableMessage`,
      );
    }
  }
});

test("the signed-in address is shown, and its absence is stated rather than left blank", () => {
  const [withEmail] = settingsEntries(configured, { email: "mail@example.com" });
  assert.equal(withEmail.description, "mail@example.com");
  const [withoutEmail] = settingsEntries(configured, { email: null });
  assert.ok(withoutEmail.description.length > 0);
});
