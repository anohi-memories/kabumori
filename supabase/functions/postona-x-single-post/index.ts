// postona-x-single-post — F3 SOURCE CANDIDATE (M1). NOT deployed; release gate OFF (every request answers 503
// NOT_AVAILABLE). Independent security review and explicit user approval are mandatory before any deploy. Keep platform
// JWT verification ON. Secrets only after approval: SUPABASE_URL, SUPABASE_ANON_KEY, POSTONA_RESV_DATABASE_URL (a login
// role in postona_resv_api -- never service_role). X credentials: the G4-owned source is not connected (Issue #131).
import { createDriverConnect } from "../_shared/postona_reservations/postgres_driver.ts";
import { createSinglePostHttpHandler } from "./http.ts";

Deno.serve(createSinglePostHttpHandler(Deno.env, { createConnect: (databaseUrl) => createDriverConnect({ databaseUrl }) }));
