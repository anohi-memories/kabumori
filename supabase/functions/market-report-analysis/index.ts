// market-report-analysis: shared market_report_packet.v1 producer (Phase 2).
// See handler.ts for scope and guarantees.
import { handleRequest } from "./handler.ts";

// Supabase Edge Runtime exposes EdgeRuntime.waitUntil to keep work running after the response. Where it does not
// exist (local Deno, another runtime), nothing is passed and the optional comparison is never prepared or sent.
const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (pending: Promise<unknown>) => void } }).EdgeRuntime;
const waitUntil = edgeRuntime && typeof edgeRuntime.waitUntil === "function"
  ? (pending: Promise<unknown>) => edgeRuntime.waitUntil!(pending)
  : undefined;

Deno.serve((req) =>
  handleRequest(req, {
    env: (name) => Deno.env.get(name),
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    waitUntil,
  })
);
