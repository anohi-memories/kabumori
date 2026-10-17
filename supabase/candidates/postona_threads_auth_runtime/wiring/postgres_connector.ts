import { Client, type ClientOptions } from "@db/postgres";
import type { OwnerSqlClient } from "../owner_transport.ts";
import { RuntimeRefusal } from "../verified_actor.ts";
import { type RuntimeConfig, validateConfig } from "./config.ts";
export interface Driver extends OwnerSqlClient {
  connect(): Promise<void>;
  readonly connected: boolean;
  readonly session: { tls: boolean | undefined; transport: string | undefined };
}
type MakeDriver = (options: ClientOptions) => Driver;
/** Fresh dedicated driver, explicit parameters/no env/DSN, enforced verified TLS, ONE connection attempt.
 * Injection is a trusted construction-time testing seam, never HTTP/body/client controlled. */
export function createPostgresConnector(
  config: RuntimeConfig,
  make: MakeDriver = (o) => new Client(o),
  timeoutMs = 5000,
) {
  const c = validateConfig(config);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new RuntimeRefusal("CONFIG_UNAVAILABLE");
  }
  return async (): Promise<OwnerSqlClient> => {
    let dead = false;
    let driver: Driver;
    try {
      driver = make({
        hostname: c.hostname,
        port: c.port,
        database: c.database,
        user: c.owner,
        password: c.password,
        host_type: "tcp",
        applicationName: "postona_threads_owner",
        connection: { attempts: 1 },
        tls: { enabled: true, enforce: true, caCertificates: [c.caPem] },
        // Timeout exists at startup, before any BEGIN can hang. No caller/DSN option injection.
        options: {
          statement_timeout: "4000",
          lock_timeout: "2000",
          idle_in_transaction_session_timeout: "6000",
        },
      });
    } catch {
      throw new RuntimeRefusal("OWNER_CHANNEL_UNAVAILABLE");
    }
    const close = async () => {
      dead = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          driver.end(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 500);
          }),
        ]);
      } catch {
        /*redacted*/
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    async function bounded<T>(work: () => Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(work),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              dead = true;
              reject(new RuntimeRefusal("OWNER_CHANNEL_UNAVAILABLE"));
            }, timeoutMs);
          }),
        ]);
      } catch {
        await close();
        throw new RuntimeRefusal("OWNER_CHANNEL_UNAVAILABLE");
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // A timed-out connect can resolve late. Close it then; never allow its late connection to query.
    await bounded(async () => {
      await driver.connect();
      if (dead) {
        await close();
        throw new Error();
      }
    });
    if (
      !driver.connected || driver.session.tls !== true ||
      driver.session.transport !== "tcp"
    ) {
      await close();
      throw new RuntimeRefusal("OWNER_CHANNEL_UNAVAILABLE");
    }
    return Object.freeze({
      async queryObject<T>(
        sql: string,
        args?: unknown[],
      ): Promise<{ rows: T[] }> {
        if (dead || !driver.connected || driver.session.tls !== true) {
          throw new RuntimeRefusal("OWNER_CHANNEL_UNAVAILABLE");
        }
        return await bounded(() => driver.queryObject<T>(sql, args));
      },
      end: close,
    });
  };
}
