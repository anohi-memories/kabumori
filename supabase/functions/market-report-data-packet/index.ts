// market-report-data-packet: shadow market_data_packet.v1 producer (Phase 1).
// See handler.ts for scope, auth and the no-AI / no-X / no-push guarantees.
import { handleRequest } from "./handler.ts";

Deno.serve((req) =>
  handleRequest(req, {
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
  })
);
