import { THREADS_CONNECT_PREREQUISITES_MET } from "../../functions/_shared/social/threads_connect_contract.ts";
// No runtime dependency constructed. Even a future flag change is insufficient to enable this.
export function handler(_request: Request): Response {
  return Response.json({
    error: THREADS_CONNECT_PREREQUISITES_MET
      ? "THREADS_RUNTIME_NOT_APPROVED"
      : "THREADS_CONNECT_DISABLED",
  }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}
