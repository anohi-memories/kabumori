import assert from "node:assert/strict";

Deno.test("candidate is unwired from deployed functions, apps and scheduler, static gate still false", async () => {
  const root = new URL("../../", import.meta.url);
  const contract = await Deno.readTextFile(
    new URL("functions/_shared/social/threads_connect_contract.ts", root),
  );
  assert.match(
    contract,
    /export const THREADS_CONNECT_PREREQUISITES_MET = false;/,
  );
  const candidate = await Deno.readTextFile(
    new URL("./offline_candidate.ts", import.meta.url),
  );
  assert.doesNotMatch(
    candidate,
    /Deno\.(?:serve|env)|\bfetch\(|console\.(?:log|warn|error)/,
  );
  const importers: string[] = [];
  async function walk(directory: URL): Promise<void> {
    for await (const entry of Deno.readDir(directory)) {
      if (["node_modules", ".git", ".expo", ".next"].includes(entry.name)) {
        continue;
      }
      const path = new URL(
        entry.name + (entry.isDirectory ? "/" : ""),
        directory,
      );
      if (entry.isDirectory) await walk(path);
      else if (/\.(ts|tsx|js|mjs|json|toml|ya?ml)$/.test(entry.name)) {
        const text = await Deno.readTextFile(path);
        if (
          /postona_threads_edge|createOfflineThreadsCandidate|offline_candidate\.ts/
            .test(text)
        ) importers.push(path.pathname);
      }
    }
  }
  await walk(new URL("functions/", root));
  await walk(new URL("../apps/", root));
  assert.deepEqual(importers, []);
});
