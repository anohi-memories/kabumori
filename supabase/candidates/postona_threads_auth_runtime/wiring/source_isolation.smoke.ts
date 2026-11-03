import { check } from "./offline.fixture.ts";
const root = new URL("../../../", import.meta.url);
const files = [
  [
    "functions/_shared/social/threads_connect_contract.ts",
    "THREADS_CONNECT_PREREQUISITES_MET",
  ],
  [
    "functions/_shared/social/threads_connect_edge.ts",
    "THREADS_CONNECT_EDGE_WIRED",
  ],
  [
    "functions/social-mobile-threads-publish/logic.ts",
    "THREADS_MANUAL_PUBLISH_PREREQUISITES_MET",
  ],
  [
    "../apps/social-mobile/src/domain/threads-connect.ts",
    "THREADS_CONNECT_UI_ENABLED",
  ],
  [
    "../apps/social-mobile/src/domain/threads-manual-publish.ts",
    "THREADS_MANUAL_PUBLISH_UI_ENABLED",
  ],
];
Deno.test("all FIVE source gates false and real composition unreachable from Edge", async () => {
  for (const [path, name] of files) {
    check(
      new RegExp(`export const ${name} = false;`).test(
        await Deno.readTextFile(new URL(path, root)),
      ),
    );
  }
  const entry = await Deno.readTextFile(
    new URL("functions/threads-oauth-connect-user/index.ts", root),
  );
  check(
    !/server_factory|nondeployable|Deno\.env|createSourceServer/.test(entry),
  );
  for (
    const name of [
      "server_factory.ts",
      "postgres_connector.ts",
      "config.ts",
      "nondeployable.ts",
    ]
  ) {
    check(
      !/console\.(log|warn|error)|Deno\.serve\s*\(/.test(
        await Deno.readTextFile(new URL(name, import.meta.url)),
      ),
    );
  }
});
Deno.test("repaired G5 port accepts G4 adapter; lease loss before cleanup blocks", async () => {
  const moduleUrl =
    new URL("functions/account-delete/provider_cleanup.ts", root).href;
  const g4url =
    new URL("functions/_shared/social/threads_provider_cleanup.ts", root).href;
  const { runProviderCleanups } = await import(moduleUrl);
  const { createThreadsProviderCleanupAdapter } = await import(g4url);
  let active = true, mutations = 0;
  const adapter = createThreadsProviderCleanupAdapter({
    connectionState: () => {
      active = false;
      return Promise.resolve("connected");
    },
    cleanup: () => {
      mutations++;
      return Promise.resolve({ outcome: "local_removed_remote_unverified" });
    },
  });
  const r = await runProviderCleanups(
    [adapter],
    "00000000-0000-4000-8000-000000000001",
    { stillOwned: () => Promise.resolve(active) },
  );
  check(r.decision === "lease_lost" && mutations === 0);
  // This does not prove G4 cleanup honors new G5 context.stillOwned DURING its own awaited mutation;
  // PR154 adapter currently ignores that context. G5/G4-owned T10 registration remains a live blocker.
});
