import assert from "node:assert/strict";
import test from "node:test";

// The comparison harness must be unable to touch production news delivery. This suite proves it statically:
//   1. no production code, config or workflow refers to the harness (nothing can import or run it);
//   2. the harness lives outside supabase/functions, so it can never be part of an Edge Function bundle;
//   3. the harness reads production code only through an allow-list of pure request builders;
//   4. it carries no Supabase / X / Push write surface and no embedded key, and the SQL it ships is a SELECT.

const ROOT = new URL("../../../", import.meta.url);
const HARNESS = new URL("./", ROOT.href + "tools/provider-compare/");
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".expo", "dist", "build", ".turbo", ".claude"]);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|yml|yaml|toml|sql|sh)$/;

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* walk(child);
    else if (entry.isFile) yield child;
  }
}

async function harnessFiles(): Promise<URL[]> {
  const files: URL[] = [];
  for await (const file of walk(new URL("tools/provider-compare/", ROOT))) files.push(file);
  return files;
}

const isTest = (file: URL) => file.pathname.endsWith("_test.ts");
const rel = (file: URL) => file.pathname.slice(ROOT.pathname.length);

test("nothing outside tools/provider-compare (and docs) refers to the harness", async () => {
  const offenders: string[] = [];
  for (const top of ["supabase", "apps", "src", "scripts", ".github", "tests"]) {
    const dir = new URL(`${top}/`, ROOT);
    try {
      await Deno.stat(dir);
    } catch {
      continue;
    }
    for await (const file of walk(dir)) {
      if (!TEXT_EXT.test(file.pathname) && !file.pathname.endsWith(".md")) continue;
      const text = await Deno.readTextFile(file).catch(() => "");
      if (text.includes("provider-compare")) offenders.push(rel(file));
    }
  }
  for (const rootFile of ["package.json", "app.json", "eas.json", "tsconfig.json"]) {
    const text = await Deno.readTextFile(new URL(rootFile, ROOT)).catch(() => "");
    if (text.includes("provider-compare")) offenders.push(rootFile);
  }
  assert.deepEqual(offenders, []);
});

test("the harness is not inside supabase/functions, so no Edge Function deploy can ship it", async () => {
  for (const file of await harnessFiles()) assert.ok(!rel(file).startsWith("supabase/"), rel(file));
  const config = await Deno.readTextFile(new URL("supabase/config.toml", ROOT)).catch(() => "");
  assert.ok(!config.includes("provider-compare"));
});

test("production code is read only through an allow-list of pure request builders", async () => {
  const allowed = new Set([
    "supabase/functions/important-news-monitor/importance_judgement_logic.ts",
    "supabase/functions/important-news-monitor/post_generation_logic.ts",
    "supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts",
    "supabase/functions/important-news-monitor/breaking_market_daily_schedule.ts",
    "supabase/functions/important-news-monitor/news_candidate_logic.ts",
  ]);
  const imported = new Set<string>();
  for (const file of await harnessFiles()) {
    if (!file.pathname.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(file);
    for (const match of text.matchAll(/from\s+"((?:\.\.\/)+supabase\/[^"]+)"/g)) {
      const target = new URL(match[1], file);
      imported.add(rel(target));
    }
  }
  for (const target of imported) assert.ok(allowed.has(target), `${target} is not on the allow-list`);
  assert.ok(imported.size >= 4, "the harness really does reuse the production builders");
});

test("the harness has no Supabase, X, Push or publishing surface", async () => {
  const forbidden = [
    "SUPABASE_SERVICE_ROLE", "SUPABASE_URL", "supabase.co", "/rest/v1", "functions/v1", "createClient(",
    "api.x.com", "api.twitter.com", "publish_important_news", "mark_important_news", "send-push-notifications",
    "exp.host", "from('important_news_candidates')", "rest/v1/ai_usage_events", "rpc/",
  ];
  const offenders: string[] = [];
  for (const file of await harnessFiles()) {
    if (isTest(file) || !TEXT_EXT.test(file.pathname) || file.pathname.endsWith("cases.json") || file.pathname.endsWith(".sql")) continue;
    const text = await Deno.readTextFile(file);
    for (const token of forbidden) if (text.includes(token)) offenders.push(`${rel(file)}: ${token}`);
  }
  assert.deepEqual(offenders, []);
});

test("the only SQL shipped is a read-only SELECT", async () => {
  const sql = await Deno.readTextFile(new URL("scripts/export_cases.sql", HARNESS));
  const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.match(code, /\bselect\b/i);
  assert.doesNotMatch(code, /\b(insert|update|delete|alter|drop|create|truncate|grant|revoke|vacuum|copy)\b/i);
});

test("no API key is embedded, and keys are only ever obtained through keys.ts", async () => {
  const offenders: string[] = [];
  for (const file of await harnessFiles()) {
    if (isTest(file) || !TEXT_EXT.test(file.pathname) || file.pathname.endsWith("cases.json")) continue;
    const text = await Deno.readTextFile(file);
    if (/sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/.test(text)) offenders.push(`${rel(file)}: key-shaped string`);
    if (text.includes("Deno.env.get(")) offenders.push(`${rel(file)}: reads the environment directly`);
    if (!file.pathname.endsWith("/keys.ts") && /(?:OPENAI|ANTHROPIC)_API_KEY/.test(text) && !file.pathname.endsWith("cli.ts") && !file.pathname.endsWith("README.md")) {
      offenders.push(`${rel(file)}: names an API key variable outside keys.ts`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("live mode cannot be reached by default: the CLI's default mode is dry-run and live needs the paid opt-in", async () => {
  const cli = await Deno.readTextFile(new URL("src/cli.ts", HARNESS));
  assert.match(cli, /mode: "dry-run"/);
  assert.match(cli, /PROVIDER_COMPARE_ALLOW_PAID/);
  const budget = await Deno.readTextFile(new URL("src/budget.ts", HARNESS));
  assert.match(budget, /PROVIDER_COMPARE_ALLOW_PAID/);
});

test("the Edge Function that delivers news does not import anything from tools/", async () => {
  const dir = new URL("supabase/functions/important-news-monitor/", ROOT);
  for await (const file of walk(dir)) {
    if (!file.pathname.endsWith(".ts")) continue;
    const text = await Deno.readTextFile(file);
    assert.ok(!/from\s+"(?:\.\.\/)+tools\//.test(text), rel(file));
  }
});
