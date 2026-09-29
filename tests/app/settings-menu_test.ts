import assert from "node:assert/strict";
import test from "node:test";

import { buildLegalLinks } from "../../src/lib/legal-links.ts";
import { settingsEntries } from "../../src/lib/settings-menu.ts";

const configured = buildLegalLinks({
  EXPO_PUBLIC_KABUMORI_WEB_URL: "https://kabumori.example.com",
});

test("every release-blocking entry is present and in a predictable order", () => {
  const ids = settingsEntries(configured, { email: "mail@example.com" }, "初心者向け").map((entry) => entry.id);
  assert.deepEqual(ids, [
    "account-email",
    "password",
    "notifications",
    "portfolio",
    "topic-level",
    "privacy",
    "terms",
    "support",
    "logout",
    "delete-account",
  ]);
});

test("the portfolio entry is a reachability link for the route dropped from the bottom tabs", () => {
  const entry = settingsEntries(configured, { email: null }, "初心者向け").find((e) => e.id === "portfolio");
  assert.ok(entry);
  assert.equal(entry.kind, "action");
});

test("deleting the account is the last entry and is marked destructive", () => {
  const entries = settingsEntries(configured, { email: "mail@example.com" }, "初心者向け");
  const last = entries[entries.length - 1];
  assert.equal(last.id, "delete-account");
  assert.equal(last.kind, "destructive");
  assert.ok(last.description.includes("削除されます"));
});

test("no entry can dead-end: a link either has a destination or explains why not", () => {
  for (const legal of [configured, buildLegalLinks({})]) {
    for (const entry of settingsEntries(legal, { email: null }, "初心者向け")) {
      if (entry.kind !== "link") continue;
      assert.ok(
        (entry.url && !entry.unavailableMessage) || (!entry.url && entry.unavailableMessage),
        `${entry.id} must have exactly one of url / unavailableMessage`,
      );
    }
  }
});

test("the signed-in address is shown, and its absence is stated rather than left blank", () => {
  const [withEmail] = settingsEntries(configured, { email: "mail@example.com" }, "初心者向け");
  assert.equal(withEmail.description, "mail@example.com");
  const [withoutEmail] = settingsEntries(configured, { email: null }, "初心者向け");
  assert.ok(withoutEmail.description.length > 0);
});

test("the topic-level entry shows whatever label the caller resolved for the current level", () => {
  for (const label of ["初心者向け", "中級者向け", "上級者向け"]) {
    const entry = settingsEntries(configured, { email: null }, label).find((e) => e.id === "topic-level");
    assert.ok(entry, "topic-level entry must exist");
    assert.equal(entry.kind, "action");
    assert.ok(entry.description.includes(label));
  }
});
