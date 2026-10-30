// TEST ONLY (G6-26). Never deployed: this lives under supabase/tests/fixtures; postona_post_assist_local_edge_run.sh copies it next to
// the real entry (supabase/functions/postona-post-assist) in a throw-away local Supabase project, where `supabase functions serve` runs it
// on the real Edge runtime behind the real local Kong / GoTrue / PostgREST.
//
// It is the real entry's handler (createPostonaPostAssistEdgeHandler) with exactly two test-only changes, both in the transport:
//   * the local stack hands every function SUPABASE_URL=http://kong:8000, which the gateway refuses on purpose (https, or http only for a
//     loopback test server). The handler is given the loopback name http://localhost:8000 instead, and this fetch sends that origin to
//     http://kong:8000. Request building, keys, headers and bodies are the gateway's own.
//   * the provider (https://api.openai.com/v1/responses) goes to the test's fake provider (G6LE_FAKE_PROVIDER_URL, on the host).
// Any other URL is refused, so nothing leaves the local machine.
import { createPostonaPostAssistEdgeHandler } from "../_shared/ai_gateway/postona_post_assist_edge.ts";

const KONG = "http://kong:8000";
const LOOPBACK = "http://localhost:8000";
const OPENAI = "https://api.openai.com/v1/responses";
const fakeProvider = Deno.env.get("G6LE_FAKE_PROVIDER_URL") ?? "";

const readEnv = (name: string): string | undefined => {
  if (name === "SUPABASE_URL") return Deno.env.get("SUPABASE_URL") === KONG ? LOOPBACK : undefined;
  return Deno.env.get(name);
};

const localFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(`${LOOPBACK}/`)) return fetch(KONG + url.slice(LOOPBACK.length), init);
  if (url === OPENAI && /^http:\/\/host\.containers\.internal:[0-9]{2,5}$/u.test(fakeProvider)) return fetch(`${fakeProvider}/v1/responses`, init);
  return Promise.reject(new TypeError("G6LE_EGRESS_REFUSED"));
};

Deno.serve(createPostonaPostAssistEdgeHandler({ readEnv, fetch: localFetch }));
