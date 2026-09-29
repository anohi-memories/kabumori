// SOURCE CANDIDATE. Not deployed; independent review is mandatory before deploy.
// See delete_logic.ts (flow), http.ts (CORS/deps) and
// apps/social-mobile/docs/account-lifecycle-phase4.md (architecture).
// Keep platform JWT verification ON for this function.
import { createHandler } from './http.ts';

Deno.serve(createHandler(Deno.env));
