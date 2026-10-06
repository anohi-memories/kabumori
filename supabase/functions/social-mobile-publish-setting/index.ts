// SOURCE CANDIDATE. Not deployed; independent review is mandatory before deploy.
// Per-account automatic-publishing ON/OFF. The decision and the write are one database transaction
// (public.set_social_account_publish_enabled, run with the caller's own JWT); see logic.ts and http.ts.
// Requires migration 20261003090000 to be applied first. Keep platform JWT verification ON.
import { createHandler } from "./http.ts";

Deno.serve(createHandler(Deno.env));
