// SOURCE CANDIDATE. NOT deployed, NOT routed, hard-disabled: every request answers 503
// THREADS_DISCONNECT_DISABLED until THREADS_DISCONNECT_SERVER_ENABLED is lifted by a reviewed source change
// (the database candidate has its own closed gate). Keep platform JWT verification ON.
import { createHandler } from "./http.ts";

Deno.serve(createHandler(Deno.env));
