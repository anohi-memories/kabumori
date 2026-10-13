import assert from "node:assert/strict";
Deno.test("consumer bridge imports only its public provider and own types; no native effects", async () => {
  for (const file of ["bridge.ts", "types.ts"]) {
    const text = await Deno.readTextFile(new URL(file, import.meta.url));
    assert.doesNotMatch(
      text,
      /\bDeno\.|\bprocess\.env|\bconsole\.|from ["']node:|(^|[^.\w])fetch\s*\(/m,
    );
    const refs = [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) =>
      m[1]
    );
    assert.ok(
      refs.every((r) => r === "../ai_provider/mod.ts" || r === "./types.ts"),
    );
  }
});
Deno.test("no existing runtime function/app imports the consumer bridge", async () => {
  const here = new URL("./", import.meta.url);
  const funcs = new URL("../../", import.meta.url);
  const app = new URL("../../../../apps/", import.meta.url);
  const found: string[] = [];
  async function walk(dir: URL) {
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const u = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
        if (u.href.startsWith(here.href)) continue;
        if (e.isDirectory) await walk(u);
        else if (
          /\.(ts|tsx|mjs|js|json|toml)$/.test(e.name) &&
          !e.name.endsWith("_test.ts") &&
          /ai_consumer_bridge/.test(await Deno.readTextFile(u))
        ) found.push(u.pathname);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  await walk(funcs);
  await walk(app);
  assert.deepEqual(found, []);
});
