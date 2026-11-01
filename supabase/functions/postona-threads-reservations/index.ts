// postona-threads-reservations — G3 SOURCE CANDIDATE (2026-10-30, Issue #318 G3-46). NOT deployed; release gate OFF (every request
// answers 503 NOT_AVAILABLE). Independent security review and explicit user approval are mandatory before any deploy.
// Keep platform JWT verification ON. Required secrets only after approval: SUPABASE_URL, SUPABASE_ANON_KEY,
// POSTONA_RESV_DATABASE_URL (a login role that is a member of postona_resv_api -- never service_role; the X entry's login).
import { createDriverConnect } from "../_shared/postona_reservations/postgres_driver.ts";
import { createHttpHandler } from "./http.ts";

Deno.serve(createHttpHandler(Deno.env, { createConnect: (databaseUrl) => createDriverConnect({ databaseUrl }) }));
