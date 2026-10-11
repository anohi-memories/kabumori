import { handler } from "../../candidates/postona_threads_auth_runtime/disabled_entry.ts";
// Source-only hard-disabled entry. No secrets/SDK/connection/env constructed, even when imported.
export { handler };
if (import.meta.main) Deno.serve(handler);
