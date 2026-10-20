// POSTONA Threads — the vertical path from a finished connect to ONE post, composed only from the G4 parts that
// already exist. SOURCE CANDIDATE (G4-04, Issue #319): hard-disabled, wired to nothing, every port injected.
//
//   connect  bind(receipt, flow)  = G4-03 decideThreadsAccountBinding  (account read -> G5 person verdict)
//   post     postOnce(request)    = local checks (no port)
//                                   -> G4-02 credentialFor            (ONE statement: decision + token + generation)
//                                   -> the credential is the bound identity, and the generation the caller expects
//                                   -> G5 worker verdict (W2 shape)    (LAST check before the provider)
//                                   -> G4-02 ThreadsSendPort.send      (one two-step publish, never retried; its
//                                      pre-publish hook asks the G5 worker verdict again once the container is ready)
//   G3       credentials / sender = the same two G4-02 ports, for G3's dispatcher (G3 runs W1 in its own preflight)
// Nothing here re-implements the transport, the OAuth handler, the binding rules or any SQL.
//
// Fail-closed today, by construction:
//   * THREADS_VERTICAL_PATH_ENABLED and the three gates it composes are false;
//   * the service key is G5's common POSTONA key `x_autopost` (G4-10); any other key refuses before any port, and the
//     key opens nothing by itself;
//   * PR #124 records no owner epoch at binding, so a real row answers BIND_EPOCH_UNRECORDED at bind;
//   * no credential statement and no worker verdict exist (G4 SQL / G5 W1-W2: separate, reviewed tasks).
// With any of those missing: no account read, no G5 call, no token read, no request.
import {
  decideThreadsAccountBinding,
  THREADS_ACCOUNT_BINDING_ENABLED,
  type ThreadsAccountBinding,
  type ThreadsBindingPorts,
  type ThreadsBindingVerdict,
  type ThreadsConnectFlowContext,
} from "./threads_account_binding.ts";
import { g5Decimal } from "./g5_owner_epoch_token.ts";
import { checkThreadsText, type FetchLike } from "./threads_publish_contract.ts";
import {
  acceptableServiceKey,
  createGatedThreadsCredentialPort,
  createGatedThreadsSendPort,
  THREADS_CREDENTIAL_PORT_ENABLED,
  THREADS_POSTING_SERVICE_KEY,
  THREADS_SEND_PORT_ENABLED,
  type ThreadsCredentialPort,
  type ThreadsCredentialStatement,
  type ThreadsSendOptions,
  type ThreadsSendOutcome,
  type ThreadsSendPort,
} from "./threads_send_port.ts";

export const THREADS_VERTICAL_PATH_ENABLED = false;

/**
 * G5's worker verdict (G5-04 PR #358 W2 `common_account_worker_brand_verdict(p_brand_id, p_service_key,
 * p_expected_owner_epoch bigint, p_expected_lifecycle_version bigint)`, service_role only; not implemented): 'active' or
 * one of G5's codes. Any other answer is not 'active'. G4-08: the two expected numbers are the binding's, as decimal
 * text (the transport passes them as bigint); there is no clock argument any more.
 */
export type ThreadsWorkerVerdictPort = (
  brandId: string,
  serviceKey: string,
  expectedOwnerEpoch: string,
  expectedLifecycleVersion: string,
) => Promise<unknown>;

/** Exactly what W1 (PR #358 @ 4f4ece89) can answer besides 'active'. The pre-G5-04 names are not accepted. */
export const G5_WORKER_VERDICT_CODES = [
  "WORKSPACE_OWNER_UNKNOWN",
  "ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND",
  "ACCOUNT_DELETION_IN_PROGRESS",
  "ACCOUNT_LOCKED",
  "SERVICE_NOT_REGISTERED",
  "SERVICE_DELETION_IN_PROGRESS",
  "SERVICE_NOT_ACTIVE",
  "ACCOUNT_LIFECYCLE_SERVICE_INVALID",
  "SERVICE_STATE_UNKNOWN",
  "EXPECTED_OWNER_EPOCH_REQUIRED",
  "EXPECTED_LIFECYCLE_VERSION_REQUIRED",
  "OWNER_EPOCH_UNAVAILABLE",
  "OWNER_EPOCH_CHANGED",
  "SERVICE_GENERATION_CHANGED",
] as const;

export const THREADS_VERTICAL_REFUSALS = [
  "PATH_DISABLED",
  "SERVICE_KEY_INVALID",
  "BINDING_INVALID", // not a binding of this path (shape, service key, generation format)
  "OWNER_EPOCH_MISSING",
  "LIFECYCLE_VERSION_MISSING",
  "TEXT_INVALID",
  "WORKER_VERDICT_UNAVAILABLE", // no G5 worker verdict wired, or it failed
  "WORKER_VERDICT_UNKNOWN", // it answered something that is neither 'active' nor a G5 code
  "CREDENTIAL_UNAVAILABLE", // no statement, or it refused (expired, revoked, owner changed, ...)
  "CREDENTIAL_IDENTITY_CHANGED", // the credential is of another Threads user than the binding
  "GENERATION_CHANGED",
  ...G5_WORKER_VERDICT_CODES,
] as const;
export type ThreadsVerticalRefusal = (typeof THREADS_VERTICAL_REFUSALS)[number];

export type ThreadsPostRequest = Readonly<{
  /** Carries the two G5 numbers it was made under; they are passed on unchanged, never re-read here (G5-04). */
  binding: ThreadsAccountBinding;
  /** The generation G3's preflight answered, or null when the caller has none. */
  expectedGeneration: string | null;
  text: string;
}>;
export type ThreadsVerticalPostResult =
  | Readonly<{ kind: "refused"; code: ThreadsVerticalRefusal }>
  | Readonly<{ kind: "sent"; outcome: ThreadsSendOutcome; transport: "threads" | "simulated" }>;

export type ThreadsVerticalDeps = Readonly<{
  bindingPorts: ThreadsBindingPorts;
  credentialStatement: ThreadsCredentialStatement | null;
  workerVerdict: ThreadsWorkerVerdictPort | null;
  fetch: FetchLike;
  transport: "threads" | "simulated";
  sendOptions?: ThreadsSendOptions;
}>;

export type ThreadsVerticalPath = Readonly<{
  available: boolean;
  transport: "threads" | "simulated";
  bind(receipt: unknown, flow: ThreadsConnectFlowContext): Promise<ThreadsBindingVerdict>;
  postOnce(request: ThreadsPostRequest): Promise<ThreadsVerticalPostResult>;
  /** The same G4-02 ports, for G3's dispatcher. */
  credentials: ThreadsCredentialPort;
  sender: ThreadsSendPort;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const THREADS_USER = /^[1-9][0-9]{0,31}$/u;
const GENERATION = /^[0-9a-f]{64}$/u;
const refused = (code: ThreadsVerticalRefusal): ThreadsVerticalPostResult => Object.freeze({ kind: "refused", code });

function bindingProblem(b: unknown, serviceKey: string): ThreadsVerticalRefusal | null {
  if (typeof b !== "object" || b === null || !Object.isFrozen(b)) return "BINDING_INVALID";
  const r = b as Record<string, unknown>;
  if (
    typeof r.socialAccountId !== "string" || !UUID.test(r.socialAccountId) || typeof r.brandId !== "string" || r.brandId === "" ||
    typeof r.threadsUserId !== "string" || !THREADS_USER.test(r.threadsUserId) || typeof r.principalId !== "string" ||
    !UUID.test(r.principalId) || r.serviceKey !== serviceKey || typeof r.entitlementVersion !== "string"
  ) return "BINDING_INVALID";
  if (g5Decimal(r.ownerEpoch) === null) return "OWNER_EPOCH_MISSING";
  if (g5Decimal(r.lifecycleVersion) === null) return "LIFECYCLE_VERSION_MISSING";
  return null;
}

export function createGatedThreadsVerticalPath(enabled: boolean, serviceKey: string | null, deps: ThreadsVerticalDeps): ThreadsVerticalPath {
  const keyOk = acceptableServiceKey(serviceKey);
  const ready = enabled && keyOk;
  const credentials = createGatedThreadsCredentialPort(ready, serviceKey, deps.credentialStatement);
  const sender = createGatedThreadsSendPort(ready, deps.transport, deps.fetch, deps.sendOptions);
  const workerVerdict = typeof deps.workerVerdict === "function" ? deps.workerVerdict : null;

  async function postOnce(request: ThreadsPostRequest): Promise<ThreadsVerticalPostResult> {
    if (!enabled) return refused("PATH_DISABLED");
    if (!keyOk) return refused("SERVICE_KEY_INVALID");
    const problem = bindingProblem(request?.binding, serviceKey as string);
    if (problem) return refused(problem);
    const binding = request.binding;
    if (request.expectedGeneration !== null && (typeof request.expectedGeneration !== "string" || !GENERATION.test(request.expectedGeneration))) {
      return refused("BINDING_INVALID");
    }
    if (!checkThreadsText(request.text).ok) return refused("TEXT_INVALID");
    if (workerVerdict === null) return refused("WORKER_VERDICT_UNAVAILABLE");
    if (!credentials.available || !sender.available) return refused("CREDENTIAL_UNAVAILABLE");

    // One statement: the decision, the token and the generation together (G4-02); nothing cached.
    const credential = await credentials.credentialFor(binding.socialAccountId);
    if (credential === null) return refused("CREDENTIAL_UNAVAILABLE");
    if (credential.threadsUserId !== binding.threadsUserId) return refused("CREDENTIAL_IDENTITY_CHANGED");
    if (request.expectedGeneration !== null && credential.generation !== request.expectedGeneration) return refused("GENERATION_CHANGED");

    // The last check before the provider (G5-04 W2): the owner epoch AND the service generation (lifecycle_version) the
    // binding was made under, unchanged; G5 compares them with the current ones in one statement.
    let answer: unknown;
    try {
      answer = await workerVerdict(binding.brandId, serviceKey as string, binding.ownerEpoch, binding.lifecycleVersion);
    } catch {
      return refused("WORKER_VERDICT_UNAVAILABLE");
    }
    if (answer !== "active") {
      return refused((G5_WORKER_VERDICT_CODES as readonly unknown[]).includes(answer) ? answer as ThreadsVerticalRefusal : "WORKER_VERDICT_UNKNOWN");
    }

    // Exactly one send; whatever it answers is returned as is and never retried here. The send port requires the
    // pre-publish hook (G4-07): after the container is ready it asks G5's worker verdict once more, and only 'active'
    // lets the publish request out (the container wait would otherwise sit unchecked between step 4 and the publish).
    const outcome = await sender.send({ threadsUserId: credential.threadsUserId, accessToken: credential.accessToken }, request.text, {
      async beforePublish() {
        try {
          return (await workerVerdict(binding.brandId, serviceKey as string, binding.ownerEpoch, binding.lifecycleVersion)) === "active";
        } catch {
          return false;
        }
      },
    });
    return Object.freeze({ kind: "sent", outcome, transport: sender.transport });
  }

  return Object.freeze({
    available: ready && credentials.available && sender.available && workerVerdict !== null,
    transport: sender.transport,
    bind: (receipt: unknown, flow: ThreadsConnectFlowContext) => decideThreadsAccountBinding(enabled, serviceKey, deps.bindingPorts, receipt, flow),
    postOnce,
    credentials,
    sender,
  });
}

/** The deployable path: closed while any of the four gates is false (the common key alone opens nothing). */
export function createThreadsVerticalPath(deps: ThreadsVerticalDeps): ThreadsVerticalPath {
  const enabled = THREADS_VERTICAL_PATH_ENABLED && THREADS_ACCOUNT_BINDING_ENABLED && THREADS_CREDENTIAL_PORT_ENABLED &&
    THREADS_SEND_PORT_ENABLED;
  // The deployable path is the real network: it always declares 'threads', whatever the caller passes.
  return createGatedThreadsVerticalPath(enabled, THREADS_POSTING_SERVICE_KEY, { ...deps, transport: "threads" });
}
