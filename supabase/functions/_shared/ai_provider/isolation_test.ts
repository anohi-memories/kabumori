// Isolation and Edge / Deno compatibility of the provider module (required test 29, and the Phase 2c scope):
//   - runtime sources use web-standard APIs only: no node: imports, no Deno.* (the environment is read through the
//     injected reader), no console output;
//   - the only external dependency is the exactly pinned official Anthropic SDK, in the Anthropic adapter only;
//   - provider hosts and model ids appear only where they belong;
//   - Phase 2c (G2 PR #153): the shared market report handler is the ONE production user. Outside this module, only
//     the files in AUTHORIZED_REFERENCES name it, with exactly those imports; of all deployable sources only that
//     handler and its entry point reach it (directly or through other files); the Anthropic SDK and key names stay
//     inside it (plus the handler's offline test); no app references it or the Anthropic key.
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

// ---- Phase 2c scope ------------------------------------------------------------------------------------------------
// The checks below are pure functions over a file tree (path relative to supabase/functions/ -> text), so the same
// code runs on the repository and on synthetic trees that must be refused.

type Tree = ReadonlyMap<string, string>;

const MODULE_PREFIX = "_shared/ai_provider/";

/** Every file outside this module that names it, with every specifier it uses for it. Nothing else may. */
const AUTHORIZED_REFERENCES: Record<string, readonly string[]> = {
  "market-report-analysis/handler.ts": [
    "../_shared/ai_provider/market_report_shadow.ts",
    "../_shared/ai_provider/market_report_wiring.ts",
  ],
  "market-report-analysis/shadow_wiring_test.ts": [
    "../_shared/ai_provider/market_report_wiring.ts",
    "../_shared/ai_provider/test_support.ts",
  ],
};

/** The deployable sources that may reach this module through their imports: the handler and its entry point. */
const AUTHORIZED_REACHERS = ["market-report-analysis/handler.ts", "market-report-analysis/index.ts"];

/** Outside this module, the Anthropic SDK and ANTHROPIC_* names appear only in the handler's offline test. */
const AUTHORIZED_ANTHROPIC_NAMES = ["market-report-analysis/shadow_wiring_test.ts"];

const isTestFile = (path: string) => path.endsWith("_test.ts") || path.endsWith("/test_support.ts");
const isCode = (path: string) => /\.(ts|tsx|js|mjs)$/u.test(path);

/** Files outside the module that mention it -> sorted specifiers; a mention outside a string literal is "<bare>". */
function directReferences(tree: Tree): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [path, text] of tree) {
    if (path.startsWith(MODULE_PREFIX) || !/ai_provider\//u.test(text)) continue;
    const literals = [...text.matchAll(/["'`]([^"'`\n]*ai_provider\/[^"'`\n]*)["'`]/gu)].map((m) => m[1]);
    const mentions = text.match(/ai_provider\//gu)?.length ?? 0;
    const specifiers = new Set(literals);
    if (mentions !== literals.length) specifiers.add("<bare>");
    out[path] = [...specifiers].sort();
  }
  return out;
}

/** Relative imports (static, re-export, side-effect, dynamic) of one file, resolved to tree paths. */
function relativeImports(path: string, text: string): string[] {
  const body = code(text);
  const specifiers = [
    ...body.matchAll(/\bfrom\s*["']([^"']+)["']/gu),
    ...body.matchAll(/\bimport\s*["']([^"']+)["']/gu),
    ...body.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/gu),
  ].map((m) => m[1]).filter((s) => s.startsWith("./") || s.startsWith("../"));
  const base = new URL(path, "file:///functions/");
  return specifiers.map((s) => decodeURIComponent(new URL(s, base).pathname).replace(/^\/functions\//u, ""));
}

/** Deployable (non-test) sources outside the module whose import graph reaches the module. */
function reachingProductionFiles(tree: Tree): string[] {
  const memo = new Map<string, boolean>();
  const reaches = (path: string, stack: Set<string>): boolean => {
    if (path.startsWith(MODULE_PREFIX)) return true;
    const known = memo.get(path);
    if (known !== undefined) return known;
    const text = tree.get(path);
    if (text === undefined || stack.has(path)) return false;
    stack.add(path);
    const result = relativeImports(path, text).some((dep) => reaches(dep, stack));
    stack.delete(path);
    memo.set(path, result);
    return result;
  };
  return [...tree.keys()]
    .filter((path) => !path.startsWith(MODULE_PREFIX) && isCode(path) && !isTestFile(path) && reaches(path, new Set()))
    .sort();
}

/** Files outside the module that name the Anthropic SDK or an ANTHROPIC_* setting. */
function anthropicNames(tree: Tree): string[] {
  return [...tree.entries()]
    .filter(([path, text]) => !path.startsWith(MODULE_PREFIX) && /@anthropic-ai\/|\bANTHROPIC_[A-Z_]+/u.test(text))
    .map(([path]) => path)
    .sort();
}

/** App files (src/, apps/) that name the provider module, the Anthropic key or its SDK. */
function appLeaks(tree: Tree): string[] {
  return [...tree.entries()].filter(([, text]) => /ai_provider|ANTHROPIC_API_KEY|@anthropic-ai\/sdk/u.test(text)).map(([path]) => path).sort();
}

async function readTree(root: URL): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  for await (const file of walk(root)) tree.set(file.href.slice(root.href.length), await Deno.readTextFile(file));
  return tree;
}

const functionsTree = readTree(FUNCTIONS_DIR);

async function appTree(): Promise<Map<string, string>> {
  const tree = new Map<string, string>();
  for (const dir of ["src/", "apps/"]) {
    for (const [path, text] of await readTree(new URL(dir, REPO_ROOT))) tree.set(dir + path, text);
  }
  return tree;
}

const sortedAuthorized = () =>
  Object.fromEntries(Object.entries(AUTHORIZED_REFERENCES).map(([path, specifiers]) => [path, [...specifiers].sort()]));

test("Phase 2c scope: only the authorized market report files name the provider module, with exactly these imports", async () => {
  assert.deepEqual(directReferences(await functionsTree), sortedAuthorized());
});

test("Phase 2c scope: of all deployable sources, only the market report handler and its entry point reach the module", async () => {
  assert.deepEqual(reachingProductionFiles(await functionsTree), AUTHORIZED_REACHERS);
});

test("Phase 2c scope: the Anthropic SDK and ANTHROPIC_* names stay in the module (and the handler's offline test)", async () => {
  assert.deepEqual(anthropicNames(await functionsTree), AUTHORIZED_ANTHROPIC_NAMES);
});

test("apps never reference the provider module or the Anthropic key (keys stay server-side)", async () => {
  assert.deepEqual(appLeaks(await appTree()), []);
});

test("Phase 2c scope: every widening is refused (synthetic trees built on the real one)", async () => {
  const real = await functionsTree;
  const withFile = (path: string, text: string) => new Map([...real, [path, text]]);
  const refusedDirect = (tree: Tree, path: string) => {
    assert.notDeepEqual(directReferences(tree), sortedAuthorized(), `${path}: direct reference not refused`);
    assert.ok(path in directReferences(tree), path);
  };

  // Another Edge Function imports the module (static, dynamic, re-export, side effect): refused twice over.
  for (const [path, text] of [
    ["x-test-post/index.ts", `${real.get("x-test-post/index.ts") ?? ""}\nimport { executeAiRequest } from "../_shared/ai_provider/mod.ts";\n`],
    ["personalized-reports/ai.ts", `export const load = () => import("../_shared/ai_provider/execute.ts");\n`],
    ["social-mobile-consult/provider.ts", `export * from "../_shared/ai_provider/mod.ts";\n`],
    ["important-news-monitor/boot.ts", `import "../_shared/ai_provider/anthropic_adapter.ts";\n`],
  ] as const) {
    const tree = withFile(path, text);
    refusedDirect(tree, path);
    assert.ok(reachingProductionFiles(tree).includes(path), `${path}: reach not refused`);
  }

  // Indirect: a deployable file that imports the handler reaches the module without naming it.
  const bridge = withFile("_shared/report_bridge.ts", `export { handleRequest } from "../market-report-analysis/handler.ts";\n`);
  assert.deepEqual(directReferences(bridge), sortedAuthorized(), "no direct reference");
  assert.deepEqual(reachingProductionFiles(bridge), ["_shared/report_bridge.ts", ...AUTHORIZED_REACHERS]);

  // The handler imports one more provider file, or another market report source starts using the module.
  const handler = real.get("market-report-analysis/handler.ts")!;
  refusedDirect(
    withFile("market-report-analysis/handler.ts", `${handler}\nimport { AnthropicAdapter } from "../_shared/ai_provider/anthropic_adapter.ts";\n`),
    "market-report-analysis/handler.ts",
  );
  const extra = withFile("market-report-analysis/extra.ts", `import { prepareMarketReportShadow } from "../_shared/ai_provider/market_report_wiring.ts";\n`);
  refusedDirect(extra, "market-report-analysis/extra.ts");
  assert.ok(reachingProductionFiles(extra).includes("market-report-analysis/extra.ts"));

  // Another function's test may not use the module either (the allowlist names files, not directories or kinds).
  refusedDirect(withFile("x-test-post/provider_test.ts", `import { fakeEnv } from "../_shared/ai_provider/test_support.ts";\n`), "x-test-post/provider_test.ts");

  // A path mentioned outside a string literal is still a reference.
  assert.deepEqual(directReferences(withFile("x-test-post/notes.ts", "// see _shared/ai_provider/mod.ts\n"))["x-test-post/notes.ts"], ["<bare>"]);

  // Production code outside the module may not read the Anthropic key or import its SDK.
  for (const [path, text] of [
    ["personalized-reports/claude.ts", `export const key = Deno.env.get("ANTHROPIC_API_KEY");\n`],
    ["market-report-analysis/handler.ts", `${handler}\nimport Anthropic from "npm:@anthropic-ai/sdk@0.132.1";\n`],
  ] as const) {
    assert.ok(anthropicNames(withFile(path, text)).includes(path), `${path}: Anthropic name not refused`);
  }

  // App leaks are still found.
  for (const [path, text] of [
    ["src/lib/ai.ts", `const key = process.env.ANTHROPIC_API_KEY;\n`],
    ["src/lib/sdk.ts", `import Anthropic from "@anthropic-ai/sdk";\n`],
    ["apps/social-mobile/src/ai.ts", `import { executeAiRequest } from "../../../supabase/functions/_shared/ai_provider/mod.ts";\n`],
  ] as const) {
    assert.deepEqual(appLeaks(new Map([[path, text]])), [path]);
  }
});
