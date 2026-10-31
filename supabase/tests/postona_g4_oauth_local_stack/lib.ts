// TEST ONLY (G4-02 #6). Never deployed: run.sh copies it to supabase/functions/_shared_g4ls/ of a throw-away local Supabase project. The
// local transport of the g4ls twins: fake X / Threads (no real provider is ever reached) and the local db container. Any other URL refuses.
import { Client } from "@db/postgres";
import { fakeConfig } from "../../candidates/postona_threads_auth_runtime/wiring/offline.fixture.ts";
import type { OwnerSqlClient } from "../../candidates/postona_threads_auth_runtime/owner_transport.ts";

const KONG = "http://kong:8000";
const realFetch = globalThis.fetch.bind(globalThis);
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const json = (body: unknown, status = 200) => Response.json(body, { status });
const raw = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const refuse = () => Promise.reject(new TypeError("G4LS_EGRESS_REFUSED"));

export async function ownerConnect(): Promise<OwnerSqlClient> {
  const c = new Client({
    hostname: "db", port: 5432, user: "postgres", password: Deno.env.get("G4LS_DB_PASSWORD"), database: "postgres",
    applicationName: "g4ls_threads", tls: { enabled: false }, connection: { attempts: 1 },
  });
  await c.connect();
  return c as unknown as OwnerSqlClient;
}

/** Threads' three calls. The code names the Threads user it was issued to (code<puid>x<n>); puid 0 = Threads refuses the code. */
function threads(url: URL, init?: RequestInit): Response | null {
  if (url.href.startsWith("https://graph.threads.com/oauth/access_token")) {
    const puid = /^code([0-9]+)x[0-9]+$/.exec(new URLSearchParams(String(init?.body)).get("code") ?? "")?.[1] ?? "";
    if (puid === "0") return json({ error: { message: "Invalid verification code format.", type: "OAuthException", code: 100 } }, 400);
    return raw(`{"access_token":"short${puid}abcdefghijkl","token_type":"bearer","user_id":${puid}}`);
  }
  if (url.href.startsWith("https://graph.threads.net/access_token")) {
    const puid = (url.searchParams.get("access_token") ?? "").replace(/^short|abcdefghijkl$/g, "");
    return json({ access_token: `long${puid}abcdefghijklmnop`, token_type: "bearer", expires_in: 5184000 });
  }
  if (url.href.startsWith("https://graph.threads.net/v1.0/me")) {
    const puid = (url.searchParams.get("access_token") ?? "").replace(/^long|abcdefghijklmnop$/g, "");
    return json({ id: puid, username: `ls_${puid.slice(-4)}` });
  }
  return null;
}

/** H5's strict config needs a managed-shaped project URL: this port sends that origin to the local Kong, Threads to the fake. */
export const localFetch: typeof fetch = (input, init) => {
  const url = urlOf(input as string | URL | Request);
  if (url.origin === new URL(fakeConfig.projectUrl).origin) return realFetch(KONG + url.pathname + url.search, init);
  const answer = threads(url, init);
  return answer ? Promise.resolve(answer) : refuse();
};

/** X's two calls. The code names the X user (x<id>x<n>); xfail = X refuses the code. Everything else may only reach the local Kong. */
export const localFetchX: typeof fetch = (input, init) => {
  const url = urlOf(input as string | URL | Request);
  if (url.href.startsWith(`${KONG}/`)) return realFetch(input as RequestInfo, init);
  if (url.href === "https://api.x.com/2/oauth2/token") {
    const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
    const id = /^x([0-9]+)x[0-9]+$/.exec(code)?.[1];
    if (!id) return Promise.resolve(json({ error: "invalid_grant" }, 400));
    return Promise.resolve(json({ access_token: `fakeXat${id}`, refresh_token: `fakeXrt${id}`, token_type: "bearer", expires_in: 7200, scope: "tweet.read users.read" }));
  }
  if (url.href === "https://api.x.com/2/users/me") {
    const id = (new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer fakeXat/, "");
    return Promise.resolve(json({ data: { id, username: `ls_${id.slice(-4)}` } }));
  }
  return refuse();
};
