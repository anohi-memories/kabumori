// postona-x-reservation-worker — F3 SOURCE CANDIDATE. NOT deployed; release gate OFF (every request answers 503
// NOT_AVAILABLE); no Cron. Independent security review and explicit user approval are mandatory before any deploy.
// Required secrets only after approval: POSTONA_RESV_WORKER_SECRET (>= 32 chars, scheduler only) and
// POSTONA_RESV_WORKER_DATABASE_URL (a login role that is a member of postona_resv_worker -- never service_role).
// X credentials: the G4-owned generation-bound source (token + generation, one snapshot) is not connected (Issue #131), so
// even behind the gate nothing is claimed or sent; the run is the generation-bound delivery (x_bound_delivery.ts, G3-49 / G3-50).
import { createDriverConnect } from "../_shared/postona_reservations/postgres_driver.ts";
import { createWorkerHandler } from "./http.ts";

Deno.serve(createWorkerHandler(Deno.env, { createConnect: (databaseUrl) => createDriverConnect({ databaseUrl }) }));
