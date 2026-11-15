// Caller authentication for EVERY x-test-post request, decided before any mode runs (G3 Issue #318 TASK 4/50,
// 2026-10-19, SOURCE CANDIDATE -- not deployed). The Function runs with verify_jwt=false (production audits of
// 2026-10-16/17), so the platform does not authenticate callers; before this gate only
// `publish_morning_greeting_manual` checked its caller, and every other mode -- the scheduled dispatch (claim_due_post,
// X posts, OpenAI) and the dry-run / test modes (OpenAI text + image, Storage upload) -- ran for any POST.
//
// Callers:
//   internal   the database Cron (dispatch-scheduled-posts) or an operator holding a server credential:
//              X-Cron-Secret equal to X_TEST_POST_CRON_SECRET (the repository's Cron pattern, as send-push-notifications),
//              or Authorization: Bearer equal to SUPABASE_SERVICE_ROLE_KEY (compatibility with a Cron that already sends
//              the service-role key -- its headers were never read in any audit). Both compared in constant time; an
//              unset or empty expected value never matches.
//   admin      a signed-in admin, decided by the existing, already verified port resolveAdminAuthorization
//              (Supabase Auth /auth/v1/user + admin_users). No new verifier is introduced.
// Decision by mode (unknown / missing mode = the scheduled dispatch, exactly as the handler routes it):
//   scheduled dispatch          internal only                     else 401 X_TEST_POST_CALLER_UNAUTHORIZED
//   dry-run / test modes        internal, or admin                 else 401 X_TEST_POST_CALLER_UNAUTHORIZED
//   publish_morning_greeting_manual   deferred to its existing admin check (unchanged response contract)
// Nothing is logged; no credential is echoed; the decision needs no network for internal callers.
// The three morning-greeting mode names are restated (not imported) so this gate stays free of the heavy modules'
// pre-existing type errors; caller_auth_entry_test.ts asserts they equal the handler's own constants.
export const GATE_MORNING_GREETING_IMAGE_TEST_MODE = "test_morning_greeting_image";
export const GATE_MORNING_GREETING_PAYLOAD_TEST_MODE = "test_morning_greeting_payload";
export const GATE_MORNING_GREETING_MANUAL_PUBLISH_MODE = "publish_morning_greeting_manual";

export const X_TEST_POST_CRON_SECRET_ENV = "X_TEST_POST_CRON_SECRET";
export const X_TEST_POST_CALLER_UNAUTHORIZED = "X_TEST_POST_CALLER_UNAUTHORIZED";

/** Every mode the handler branches on, besides the default scheduled dispatch. */
export const X_TEST_POST_PREVIEW_MODES: readonly string[] = Object.freeze([
  "useful_tip_dry_run",
  "kabumori_voice_dry_run",
  "morning_report_dry_run",
  "close_report_dry_run",
  "us_premarket_report_dry_run",
  GATE_MORNING_GREETING_IMAGE_TEST_MODE,
  GATE_MORNING_GREETING_PAYLOAD_TEST_MODE,
]);

export type XTestPostCallerClass = "scheduled_dispatch" | "operator_preview" | "manual_publish";

export function callerClassOf(mode: unknown): XTestPostCallerClass {
  if (mode === GATE_MORNING_GREETING_MANUAL_PUBLISH_MODE) return "manual_publish";
  if (typeof mode === "string" && X_TEST_POST_PREVIEW_MODES.includes(mode)) return "operator_preview";
  return "scheduled_dispatch";
}

export type CallerDecision =
  | { ok: true; caller: "internal" | "admin" | "deferred_to_manual_publish_check" }
  | { ok: false; status: 401; code: typeof X_TEST_POST_CALLER_UNAUTHORIZED };

type EnvLike = { get(name: string): string | undefined };
type AdminResolver = (authorizationHeader: string | null) => Promise<{ authorized: boolean }>;

const encoder = new TextEncoder();

/** Constant-time equality of two strings (compares SHA-256 digests; lengths do not leak). */
export async function secretEquals(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (typeof expected !== "string" || expected.length === 0 || typeof provided !== "string" || provided.length === 0) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

function bearerOf(headers: Headers): string | null {
  const match = /^Bearer\s+(\S+)$/iu.exec((headers.get("Authorization") ?? "").trim());
  return match ? match[1] : null;
}

export async function isInternalCaller(headers: Headers, env: EnvLike): Promise<boolean> {
  const [cron, serviceRole] = await Promise.all([
    secretEquals(headers.get("X-Cron-Secret"), env.get(X_TEST_POST_CRON_SECRET_ENV)),
    secretEquals(bearerOf(headers), env.get("SUPABASE_SERVICE_ROLE_KEY")),
  ]);
  return cron || serviceRole;
}

export async function authorizeXTestPostCaller(input: {
  mode: unknown;
  headers: Headers;
  env: EnvLike;
  resolveAdmin: AdminResolver;
}): Promise<CallerDecision> {
  const deny: CallerDecision = { ok: false, status: 401, code: X_TEST_POST_CALLER_UNAUTHORIZED };
  const kind = callerClassOf(input.mode);
  if (kind === "manual_publish") return { ok: true, caller: "deferred_to_manual_publish_check" };
  if (await isInternalCaller(input.headers, input.env)) return { ok: true, caller: "internal" };
  if (kind === "scheduled_dispatch") return deny;
  let admin = false;
  try {
    admin = (await input.resolveAdmin(input.headers.get("Authorization"))).authorized === true;
  } catch {
    admin = false;
  }
  return admin ? { ok: true, caller: "admin" } : deny;
}
