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
//   * THREADS_POSTING_SERVICE_KEY is null. G5's contract (G5-02, PR #344) names `x_autopost` for Threads posting; G4's
//     rule (G4-02 acceptableServiceKey) still refuses it. Adopting it is G4's decision, not made here (proposed as the
//     minimal interface change in the G4-04 doc). A synthetic key is used in tests only;
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
 * G5's worker verdict (G5-02 W2 `common_account_worker_brand_verdict`, service_role only; not implemented): 'active'
 * or one of G5's codes. Any other answer is not 'active'.
 */
export type ThreadsWorkerVerdictPort = (brandId: string, serviceKey: string, expectedOwnerEpoch: number, boundAtMs: number) => Promise<unknown>;

export const G5_WORKER_VERDICT_CODES = [
  "WORKSPACE_OWNER_UNKNOWN",
  "ACCOUNT_DELETION_IN_PROGRESS",
  "SERVICE_DELETION_IN_PROGRESS",
  "SERVICE_NOT_ACTIVE",
  "OWNER_EPOCH_UNAVAILABLE",
  "OWNER_EPOCH_CHANGED",
  "SERVICE_REACTIVATED_SINCE_BIND",
  "EXPECTED_OWNER_EPOCH_REQUIRED",
  "BOUND_AT_REQUIRED",
  "ACCOUNT_LIFECYCLE_SERVICE_INVALID",
  "SERVICE_STATE_UNKNOWN",
  "FACTS_UNAVAILABLE",
] as const;

export const THREADS_VERTICAL_REFUSALS = [
  "PATH_DISABLED",
  "SERVICE_KEY_UNDECIDED",
  "BINDING_INVALID", // not a binding of this path (shape, service key, generation format)
  "OWNER_EPOCH_MISSING",
  "BOUND_AT_REQUIRED",
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
  binding: ThreadsAccountBinding;
  /** When the binding was made (G3's reservation keeps it with the owner epoch, per G5-02). */
  boundAtMs: number;
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
  if (!Number.isSafeInteger(r.ownerEpoch) || (r.ownerEpoch as number) < 1) return "OWNER_EPOCH_MISSING";
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
    if (!keyOk) return refused("SERVICE_KEY_UNDECIDED");
    const problem = bindingProblem(request?.binding, serviceKey as string);
    if (problem) return refused(problem);
    const binding = request.binding;
    if (!Number.isSafeInteger(request.boundAtMs) || request.boundAtMs <= 0) return refused("BOUND_AT_REQUIRED");
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

    // The last check before the provider (G5-02 W2): owner epoch at binding, bind time, service period.
    let answer: unknown;
    try {
      answer = await workerVerdict(binding.brandId, serviceKey as string, binding.ownerEpoch, request.boundAtMs);
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
          return (await workerVerdict(binding.brandId, serviceKey as string, binding.ownerEpoch, request.boundAtMs)) === "active";
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

/** The deployable path: closed while any of the four gates is false or the service key is undecided. */
export function createThreadsVerticalPath(deps: ThreadsVerticalDeps): ThreadsVerticalPath {
  const enabled = THREADS_VERTICAL_PATH_ENABLED && THREADS_ACCOUNT_BINDING_ENABLED && THREADS_CREDENTIAL_PORT_ENABLED &&
    THREADS_SEND_PORT_ENABLED;
  // The deployable path is the real network: it always declares 'threads', whatever the caller passes.
  return createGatedThreadsVerticalPath(enabled, THREADS_POSTING_SERVICE_KEY, { ...deps, transport: "threads" });
}
