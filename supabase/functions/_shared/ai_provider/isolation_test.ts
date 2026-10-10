// Isolation and Edge / Deno compatibility of the provider module (required test 29, and the Phase 1a scope):
//   - runtime sources use web-standard APIs only: no node: imports, no Deno.* (the environment is read through the
//     injected reader), no console output;
//   - the only external dependency is the exactly pinned official Anthropic SDK, in the Anthropic adapter only;
//   - provider hosts and model ids appear only where they belong;
//   - nothing in production imports this module yet, and no app references it or the Anthropic key.
import assert from "node:assert/strict";
import test from "node:test";

const MODULE_DIR = new URL("./", import.meta.url);
const FUNCTIONS_DIR = new URL("../../", import.meta.url);
const REPO_ROOT = new URL("../../../../", import.meta.url);

async function moduleSources(): Promise<Array<{ name: string; text: string }>> {
  const out: Array<{ name: string; text: string }> = [];
  for await (const entry of Deno.readDir(MODULE_DIR)) {
    if (!entry.isFile || !entry.name.endsWith(".ts") || entry.name.endsWith("_test.ts") || entry.name === "test_support.ts") continue;
    out.push({ name: entry.name, text: await Deno.readTextFile(new URL(entry.name, MODULE_DIR)) });
  }
  return out;
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) entries.push(entry);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
    if (entry.isDirectory) yield* walk(child);
    else if (/\.(ts|tsx|js|mjs|json)$/u.test(entry.name)) yield child;
  }
}

function code(text: string): string {
  // Drop comments so documentation may name things freely.
  return text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");
}

test("29. runtime sources use web-standard APIs only (no node:, no Deno.*, no console)", async () => {
  const sources = await moduleSources();
  assert.ok(sources.length >= 12, "scanned the module");
  for (const { name, text } of sources) {
    const body = code(text);
    assert.doesNotMatch(body, /from\s+["']node:/u, `${name} imports a Node built-in`);
    // (The string "Deno.customInspect" passed to Symbol.for is a symbol name, not an API call.)
    assert.doesNotMatch(body, /(?<!["'])\bDeno\./u, `${name} uses a Deno-only API`);
    assert.doesNotMatch(body, /\bconsole\./u, `${name} logs`);
    assert.doesNotMatch(body, /\bprocess\.env\b/u, `${name} reads process.env`);
  }
});

test("29. the only external import is the pinned Anthropic SDK, in the Anthropic adapter; relative imports stay inside", async () => {
  for (const { name, text } of await moduleSources()) {
    const specifiers = [...code(text).matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/gu)].map((m) => m[1] ?? m[2]);
    for (const specifier of specifiers) {
      if (specifier.startsWith("./")) continue;
      assert.equal(name, "anthropic_adapter.ts", `${name} imports ${specifier}`);
      assert.equal(specifier, "npm:@anthropic-ai/sdk@0.132.1");
    }
  }
});

test("provider hosts appear only in their adapters; model ids only in the catalog", async () => {
  for (const { name, text } of await moduleSources()) {
    const body = code(text);
    if (name !== "openai_adapter.ts") assert.doesNotMatch(body, /api\.openai\.com/u, name);
    if (name !== "anthropic_adapter.ts") assert.doesNotMatch(body, /api\.anthropic\.com/u, name);
    if (name !== "model_catalog.ts") assert.doesNotMatch(body, /["'`](claude-[a-z0-9-]+|gpt-[0-9][0-9.]*-[a-z]+)["'`]/u, `${name} names a model`);
  }
});

test("Phase 1a scope: no production function imports the provider module yet", async () => {
  const offenders: string[] = [];
  for await (const file of walk(FUNCTIONS_DIR)) {
    if (file.href.startsWith(MODULE_DIR.href)) continue;
    const text = await Deno.readTextFile(file);
    if (/_shared\/ai_provider\//u.test(text) || /from\s+["'][^"']*ai_provider\//u.test(text)) offenders.push(file.pathname);
  }
  assert.deepEqual(offenders, []);
});

test("apps never reference the provider module or the Anthropic key (keys stay server-side)", async () => {
  const offenders: string[] = [];
  for (const dir of ["src/", "apps/"]) {
    for await (const file of walk(new URL(dir, REPO_ROOT))) {
      const text = await Deno.readTextFile(file);
      if (/ai_provider|ANTHROPIC_API_KEY|@anthropic-ai\/sdk/u.test(text)) offenders.push(file.pathname);
    }
  }
  assert.deepEqual(offenders, []);
});
