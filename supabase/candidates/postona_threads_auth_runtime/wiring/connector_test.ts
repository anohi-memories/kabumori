import { createPostgresConnector, type Driver } from "./postgres_connector.ts";
import { readConfig, validateConfig } from "./config.ts";
import type { ClientOptions } from "@db/postgres";
import { check, fakeConfig } from "./offline.fixture.ts";
async function refused(f: () => unknown | Promise<unknown>) {
  try {
    await f();
    throw new Error("accepted");
  } catch (e) {
    check(
      ["CONFIG_UNAVAILABLE", "OWNER_CHANNEL_UNAVAILABLE"].includes(
        (e as Error).message,
      ),
    );
  }
}
for (
  const [name, change] of Object.entries({
    project: { projectRef: "b".repeat(20) },
    host: { hostname: "evil.example" },
    role: { owner: "postgres" },
    api: { owner: "service_role" },
    ca: { caPem: "" },
    callback: { callback: "http://postona.example" },
    key: { publishableKey: "sb_secret_offline_dummy" },
    port: { port: 6543 },
  })
) {
  Deno.test(
    "config fail closed: " + name,
    () => refused(() => validateConfig({ ...fakeConfig, ...change })),
  );
}
Deno.test("missing environment is sanitized", () =>
  refused(() => readConfig(() => undefined)));
for (
  const mode of [
    "success",
    "no-tls",
    "connect-error",
    "constructor-error",
    "query-error",
    "late-connect",
  ] as const
) {
  Deno.test("dedicated driver: " + mode, async () => {
    let closed = 0, queries = 0;
    let seen: ClientOptions | undefined;
    let connected = false;
    let finish: (() => void) | undefined;
    const driver: Driver = {
      get connected() {
        return connected;
      },
      get session() {
        return { tls: mode !== "no-tls", transport: "tcp" };
      },
      connect: () => {
        if (mode === "connect-error") {
          return Promise.reject(new Error("offline_dummy_secret"));
        }
        if (mode === "late-connect") {
          return new Promise<void>((resolve) => {
            finish = () => {
              connected = true;
              resolve();
            };
          });
        }
        connected = true;
        return Promise.resolve();
      },
      queryObject: <T>() => {
        queries++;
        return mode === "query-error"
          ? Promise.reject(new Error("offline_dummy_secret"))
          : Promise.resolve({ rows: [] as T[] });
      },
      end: () => {
        closed++;
        connected = false;
        return Promise.resolve();
      },
    };
    const connect = createPostgresConnector(fakeConfig, (options) => {
      seen = options;
      if (mode === "constructor-error") throw new Error("offline_dummy_secret");
      return driver;
    }, mode === "late-connect" ? 5 : 100);
    if (mode !== "success" && mode !== "query-error") {
      await refused(connect);
      if (finish) {
        finish();
        await new Promise((r) => setTimeout(r, 0));
      }
      check((closed >= 1 || mode === "constructor-error") && queries === 0);
    } else {
      const c = await connect();
      if (mode === "query-error") {
        await refused(() => c.queryObject("select 1"));
      } else {
        await c.queryObject("select $1", ["offline_dummy"]);
        await c.end();
      }
      await refused(() => c.queryObject("select 2"));
      check(closed >= 1 && queries === 1);
    }
    check(
      seen?.tls?.enforce === true && seen.tls.enabled === true &&
        seen.host_type === "tcp" && seen.connection?.attempts === 1 &&
        seen.user === "offline_owner",
    );
  });
}
