// SOURCE CANDIDATE. NOT deployed, NOT registered with Meta, hard-disabled: every request answers 503
// THREADS_META_CALLBACKS_DISABLED until THREADS_META_CALLBACKS_ENABLED is lifted by a reviewed source change, and
// there is no durable store behind it yet. See ./http.ts for the deploy-time dependencies.
import { createHandler } from "./http.ts";

Deno.serve(createHandler(Deno.env));
