import assert from "node:assert/strict";
import test from "node:test";

test("shadow source has no publication, notification, app-copy, or social write surface", async () => {
  const source = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  const forbidden = [
    "publish_important_news",
    "mark_important_news",
    "notifications?",
    "social_post",
    "x_post_id",
    "send-push-notifications",
    "api.x.com",
    "api.twitter.com",
    "publish-ready",
  ];
  for (const token of forbidden) {
    assert.equal(
      source.includes(token),
      false,
      `forbidden boundary token: ${token}`,
    );
  }
  assert.equal(
    source.includes('const LIVE_TABLE = "important_news_candidates"'),
    true,
  );
  assert.match(source, /Deno\.env\.get\("IMPORTANT_NEWS_SHADOW_CRON_SECRET"\)/);
  assert.equal(
    source.includes(`rest(base, key, LIVE_TABLE, { method: "POST"`),
    false,
  );
  assert.equal(
    source.includes(`rest(base, key, LIVE_TABLE, { method: "PATCH"`),
    false,
  );
});

test("migration grants only service_role and creates no policy", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260919195155_important_news_shadow_phase1.sql",
      import.meta.url,
    ),
  );
  assert.match(migration, /enable row level security/g);
  assert.doesNotMatch(migration, /create\s+policy/i);
  assert.doesNotMatch(migration, /grant\s+.+\s+to\s+(?:anon|authenticated)/i);
  assert.doesNotMatch(migration, /cron\.schedule|net\.http_post/i);
});
