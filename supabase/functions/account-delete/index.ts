// SOURCE CANDIDATE. Not deployed by the task that introduced it; independent review is mandatory before
// deploy. The common-account lifecycle boundary of the Kabumori app: see lifecycle_logic.ts (flows and
// security model), http.ts (routing and adapters) and docs/common-account/phase3a-deletion-orchestrator.md.
// The former direct Auth delete (no body -> hard delete of the caller's login) no longer exists: such a
// request is refused with ACTION_REQUIRED. Keep platform JWT verification ON for this function.
import { createHandler } from './http.ts';

Deno.serve(createHandler(Deno.env));
