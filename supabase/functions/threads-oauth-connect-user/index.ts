import { createThreadsConnectEntry } from "../_shared/social/threads_connect_entry.ts";
// Wired through the F4 entry adapter. While the static source gates are closed (as in source), `handler` IS H5's
// hard-disabled handler: no secrets/SDK/connection/env constructed, even when imported.
export const handler = createThreadsConnectEntry();
if (import.meta.main) Deno.serve(handler);
