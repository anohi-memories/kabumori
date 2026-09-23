import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../../migrations/20260923110440_important_news_monitor_caller_auth.sql", import.meta.url),
  "utf8",
);

test("auth migration is limited to the four existing monitor cron jobs", () => {
  for (const jobName of [
    "important-news-fetch",
    "important-news-judgement",
    "important-news-generation",
    "important-news-publish-ready",
  ]) {
    assert.ok(migration.includes(jobName));
  }

  assert.match(migration, /from cron\.job where jobname = any\(expected_job_names\)/i);
  assert.match(migration, /perform cron\.alter_job\(job\.jobid, command := patched_command\)/i);
  assert.doesNotMatch(migration, /cron\.schedule\s*\(/i);
  assert.doesNotMatch(migration, /important-news-shadow/);
});

test("migration fails closed without the named Vault secret and preserves job cadence/body", () => {
  assert.match(migration, /vault\.decrypted_secrets[\s\S]*important_news_monitor_cron_secret/);
  assert.match(migration, /configured_secret !~ '\^\[A-Za-z0-9_-\]\{42\}\[AEIMQUYcgkosw048\]\$'/);
  assert.match(migration, /patched_command := regexp_replace\([\s\S]*?job\.command/i);
  assert.match(migration, /cron\.alter_job\(job\.jobid, command := patched_command\)/i);
  assert.doesNotMatch(migration, /body\s*:=/i);
  assert.doesNotMatch(migration, /schedule\s*:=/i);
  assert.doesNotMatch(migration, /fetchSources|publish_ready|auto_publish/);
  assert.doesNotMatch(migration, /(?:sb_secret_|service_role|eyJ[A-Za-z0-9_-]{20})/);
});
