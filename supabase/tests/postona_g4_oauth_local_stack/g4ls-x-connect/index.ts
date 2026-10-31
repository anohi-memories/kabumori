// TEST ONLY (G4-02 #6). Never deployed: run.sh copies it into a throw-away local Supabase project. The REAL X connect entry
// (x-oauth-connect-user/index.ts, unchanged: its profile pin, real GoTrue / PostgREST with the caller's JWT, the real SQL). The only
// test difference: the global fetch answers api.x.com with the fake (lib.ts) and refuses anything but the local Kong.
import { localFetchX } from "../_shared_g4ls/lib.ts";

globalThis.fetch = localFetchX;
await import("../x-oauth-connect-user/index.ts");
