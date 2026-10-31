// TEST ONLY (G4-02 #6). Never deployed: run.sh copies it into a throw-away local Supabase project. The REAL Threads disconnect core (the
// same getUser + RPC the entry's http.ts wires) past the entry's static gate, against real GoTrue / PostgREST and the real RPC; the
// SQL gate is opened in this TEST world only (by run.sh's test as the owner).
import { createThreadsDisconnectRpc, handleThreadsDisconnect } from "../_shared/social/threads_disconnect.ts";
import { createGetUser } from "../social-mobile-threads-publish/http.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
Deno.serve((request) =>
  handleThreadsDisconnect(request, {
    getUser: createGetUser({ supabaseUrl, anonKey }, fetch),
    disconnect: createThreadsDisconnectRpc({ supabaseUrl, anonKey }, fetch),
  })
);
