import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const functionSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("caller authentication runs before service-role loading, JSON parsing, and mode dispatch", () => {
  const methodGate = functionSource.indexOf('if (req.method !== "POST")');
  const authCheck = functionSource.indexOf("if (!isValidImportantNewsCronSecret(");
  const serviceRoleLoad = functionSource.indexOf('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
  const bodyParse = functionSource.indexOf("const body = await req.json()");
  const publishDispatch = functionSource.indexOf('body.mode === "publish_ready"');

  assert.ok(methodGate >= 0);
  assert.ok(authCheck > methodGate);
  assert.ok(serviceRoleLoad > authCheck);
  assert.ok(bodyParse > serviceRoleLoad);
  assert.ok(publishDispatch > bodyParse);
  assert.match(functionSource, /error: "UNAUTHORIZED"[\s\S]{0,40}401/);
  assert.match(functionSource, /error: "SERVER_CONFIGURATION_MISSING"[\s\S]{0,40}500/);
});

test("auth responses do not interpolate credential material", () => {
  const authBlock = functionSource.slice(
    functionSource.indexOf('const cronSecret = Deno.env.get("IMPORTANT_NEWS_CRON_SECRET")'),
    functionSource.indexOf('const supabaseUrl = Deno.env.get("SUPABASE_URL")'),
  );

  assert.doesNotMatch(authBlock, /console\.(log|error).*cronSecret/i);
  assert.doesNotMatch(authBlock, /JSON\.stringify\([^)]*cronSecret/i);
  assert.doesNotMatch(authBlock, /\$\{cronSecret\}/);
});
