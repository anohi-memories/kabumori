// Explicit source integration seam; NOT a serve()/fetch default export or deployable Edge entry.
// G4 dependency deliberately injected: PR154 is not an ancestor of this PR139-based source branch.
import { readConfig } from "./config.ts";
import { createSourceServer, type HandlerFactory } from "./server_factory.ts";
export function buildForApprovedSourceIntegration(
  handlerFactory: HandlerFactory,
  read: (name: string) => string | undefined,
) {
  return createSourceServer(readConfig(read), { handlerFactory });
}
// No Deno.serve, no Deno.env, no live router, no activation through an environment flag.
