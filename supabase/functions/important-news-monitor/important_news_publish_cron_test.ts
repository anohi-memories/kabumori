import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../migrations/20260908110000_add_important_news_publish_ready_cron.sql", import.meta.url),
  "utf8",
);

test("publish trigger uses the dedicated mode and the existing active/auto-publish guards", () => {
  assert.match(migration, /important-news-publish-ready/);
  assert.ok(migration.includes("'*/5 * * * *'"));
  assert.match(migration, /body := '\{"mode":"publish_ready"\}'::jsonb/);
  assert.match(migration, /where id = true and is_active = true and auto_publish = true/);
});

test("publish trigger is idempotent and does not create a second job", () => {
  assert.ok(migration.includes("if not exists (\n    select 1 from cron.job where jobname = 'important-news-publish-ready'"));
});
