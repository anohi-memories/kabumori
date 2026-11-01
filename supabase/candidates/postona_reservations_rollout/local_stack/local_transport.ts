// TEST ONLY (G3-02 #1). Never deployed: run.sh copies it to supabase/functions/_shared_g3ls/ of a throw-away local Supabase project only.
// The local-stack transport shared by the G3 localtest twins: the real entries' handlers run unchanged; only how they reach Auth and the
// database differs, because the local stack is not the production network.
//   * Auth: the local stack hands every function SUPABASE_URL=http://kong:8000, which G3's verifier refuses on purpose (https, or http
//     only for a loopback host). The handler is given http://localhost:8000; this fetch sends that origin to http://kong:8000.
//     Any other URL is refused, so nothing leaves the local machine.
//   * Database: the local db container (host `db`) has no TLS, which G3's driver refuses on purpose for a non-loopback host. This
//     connection factory opens the same jsr:@db/postgres client to exactly db:5432 without TLS; any other host / port is refused.
import { Client } from "jsr:@db/postgres@0.19.5";
import type { PgConnect } from "../_shared/postona_reservations/postgres_db.ts";

const KONG = "http://kong:8000";
const LOOPBACK = "http://localhost:8000";

export const localEnv = {
  get(name: string): string | undefined {
    if (name === "SUPABASE_URL") return Deno.env.get("SUPABASE_URL") === KONG ? LOOPBACK : undefined;
    return Deno.env.get(name);
  },
};

export const localFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${LOOPBACK}/`)) return fetch(KONG + url.slice(LOOPBACK.length), init);
  return Promise.reject(new TypeError("G3LS_EGRESS_REFUSED"));
};

export function localDbConnect(databaseUrl: string, applicationName: string): PgConnect {
  const url = new URL(databaseUrl);
  if (url.protocol !== "postgres:" || url.hostname !== "db" || url.port !== "5432") throw new Error("G3LS_DB_URL_REFUSED");
  const options = {
    hostname: "db",
    port: 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: "postgres",
    applicationName,
    tls: { enabled: false },
    connection: { attempts: 1 },
  };
  return async () => {
    const client = new Client(options);
    await client.connect();
    return { client, release: () => client.end() };
  };
}
