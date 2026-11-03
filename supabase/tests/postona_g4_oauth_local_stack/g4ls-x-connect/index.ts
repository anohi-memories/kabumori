// TEST ONLY (G4-02 #6). Never deployed: run.sh copies it into a throw-away local Supabase project. The REAL X connect entry
// (x-oauth-connect-user/index.ts, unchanged: its profile pin, real GoTrue / PostgREST with the caller's JWT, the real SQL). The only
// test difference: the global fetch answers api.x.com with the fake (lib.ts) and refuses anything but the local Kong.
import { localFetchX } from "../_shared_g4ls/lib.ts";

// GET .../__x_calls answers how many calls reached the fake X in this worker (the test proves "no exchange" with it, next to a positive control).
let xCalls = 0;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  if (String(input instanceof Request ? input.url : input).startsWith("https://api.x.com/")) xCalls += 1;
  return localFetchX(input as RequestInfo, init);
}) as typeof fetch;
const serve = Deno.serve;
Deno.serve = ((handler: (request: Request) => Response | Promise<Response>) =>
  serve((request) => new URL(request.url).pathname.endsWith("/__x_calls") ? Response.json({ calls: xCalls }) : handler(request))) as typeof Deno.serve;
await import("../x-oauth-connect-user/index.ts");
