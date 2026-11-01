/**
 * Connection factory for the reservation database adapter, on jsr:@db/postgres 0.19.5 (published 2025-04-24,
 * pinned exactly; F3 SOURCE CANDIDATE). The connection string belongs to a server-side LOGIN role that is a
 * member of postona_resv_api (a separately approved rollout step; never a service-role or owner credential,
 * never in a mobile build). TLS is enforced for every non-loopback host; plain TCP is accepted only for a
 * loopback host AND an explicit test-only flag.
 */
import { Client } from "jsr:@db/postgres@0.19.5";
import type { PgConnect } from "./postgres_db.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function createDriverConnect(config: { databaseUrl: string; allowInsecureLoopback?: boolean }): PgConnect {
  const url = new URL(config.databaseUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("RESERVATION_DB_URL_INVALID");
  const loopback = LOOPBACK.has(url.hostname);
  const insecure = loopback && config.allowInsecureLoopback === true;
  const options = {
    hostname: url.hostname.replace(/^\[|\]$/gu, ""),
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//u, "")) || "postgres",
    applicationName: "postona-x-reservations",
    tls: insecure ? { enabled: false } : { enabled: true, enforce: true },
    connection: { attempts: 1 },
  };
  if (!options.user || !options.database) throw new Error("RESERVATION_DB_URL_INVALID");
  return async () => {
    const client = new Client(options);
    await client.connect();
    return { client, release: () => client.end() };
  };
}
