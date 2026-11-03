// SOURCE CANDIDATE. NOT deployed, NOT routed, hard-disabled: every request answers 503
// THREADS_PUBLISH_DISABLED until THREADS_MANUAL_PUBLISH_PREREQUISITES_MET is lifted by a reviewed source
// change (see logic.ts and docs/postona/threads-manual-publish-v1.md). Keep platform JWT verification ON.
import { createHandler } from "./http.ts";

Deno.serve(createHandler(Deno.env));
