// market-report-analysis: shared market_report_packet.v1 producer (Phase 2).
// See handler.ts for scope and guarantees.
import { handleRequest } from "./handler.ts";

Deno.serve((req) =>
  handleRequest(req, {
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  })
);
