// SOURCE CANDIDATE. Not deployed; independent review is mandatory before deploy.
// Per-account automatic-publishing ON/OFF (social_accounts.publish_enabled only). See logic.ts (policy)
// and http.ts (the only data access). Keep platform JWT verification ON.
import { createHandler } from "./http.ts";

Deno.serve(createHandler(Deno.env));
