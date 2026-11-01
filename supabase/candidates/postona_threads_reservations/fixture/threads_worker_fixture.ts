/**
 * TEST FIXTURE -- the worker-side test entry for G3 Issue #318 TASK 3/50 (2026-10-19). Imported by no product code.
 *
 * 1. PROPOSED to G4 (PR #337 threads_send_port.ts; G4 owns the change): a pre-publish re-check hook.
 *      send(credential, text, hooks?: { beforePublish(): Promise<boolean> })
 *    G4 awaits `beforePublish` AFTER the container is FINISHED and BEFORE the publish request (the container wait --
 *    default 3 status reads 3 s apart -- otherwise sits between G3's preflight and the publish with no re-check).
 *    false / throw / no answer within the hook's own bound -> NO publish request; the outcome is
 *    { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" } (the container is never published
 *    and expires unpublished). The hook never sees the token. What remains (honestly): the publish request itself
 *    is one network round trip after the hook; a freeze inside that round trip is recorded as after_freeze (M1-F3).
 * 2. withPrepublishRecheck(store, sender): how G3 answers the hook -- the SAME 007 preflight (fence + lease + bound
 *    generation) once more for exactly the row being sent, requiring OK and the same generation the credential carried.
 *    Composed around PR #334's dispatcher without changing it: the last OK preflight names the row in flight (the
 *    dispatcher sends one row at a time). The real change (the dispatcher passing the hook to send) is for G3's next
 *    source TASK once G4 accepts the IF.
 * 3. createFixtureTwoStepSendPort: a SIMULATED stand-in of PR #337's two-step send (container -> status reads ->
 *    publish -> read-back) that honours the proposed hook and counts every would-be provider request. No network.
 */
import type {
  ThreadsDispatchStore, ThreadsPreflight, ThreadsSendOutcome, ThreadsSendPort,
} from "../../../functions/_shared/postona_reservations/threads_dispatch.ts";

export type ThreadsSendHooks = { beforePublish(): Promise<boolean> };
export type ThreadsSendPortWithHooks = {
  readonly available: boolean;
  readonly transport: "threads" | "simulated";
  send(credential: Readonly<{ threadsUserId: string; accessToken: string }>, text: string, hooks?: ThreadsSendHooks): Promise<ThreadsSendOutcome>;
};

export function withPrepublishRecheck(store: ThreadsDispatchStore, sender: ThreadsSendPortWithHooks): { store: ThreadsDispatchStore; sender: ThreadsSendPort; rechecks: () => number } {
  let current: { id: string; lease: string; generation: string } | null = null;
  let rechecks = 0;
  const wrappedStore: ThreadsDispatchStore = {
    ...store,
    async preflight(id, lease) {
      const answer = await store.preflight(id, lease);
      current = answer.verdict === "OK" && typeof answer.credentialGeneration === "string" ? { id, lease, generation: answer.credentialGeneration } : null;
      return answer;
    },
  };
  const wrappedSender: ThreadsSendPort = {
    available: sender.available,
    transport: sender.transport,
    send(credential, text) {
      const inFlight = current;
      current = null;
      return sender.send(credential, text, {
        async beforePublish() {
          rechecks += 1;
          if (!inFlight) return false;
          let again: ThreadsPreflight;
          try {
            again = await store.preflight(inFlight.id, inFlight.lease);
          } catch {
            return false;
          }
          return again.verdict === "OK" && again.credentialGeneration === inFlight.generation;
        },
      });
    },
  };
  return { store: wrappedStore, sender: wrappedSender, rechecks: () => rechecks };
}

export type FixtureProviderLog = { containers: number; statusReads: number; publishes: number; readBacks: number };

/** SIMULATED two-step send (PR #337's shape). `duringWait` runs between the container and the publish (the TOCTOU
 *  window); `honourHook: false` models PR #337 as it is today (no hook). */
export function createFixtureTwoStepSendPort(options: { honourHook: boolean; duringWait?: () => Promise<void>; outcome?: () => ThreadsSendOutcome | null } ) {
  const log: FixtureProviderLog = { containers: 0, statusReads: 0, publishes: 0, readBacks: 0 };
  let media = 18000000000000500;
  const port: ThreadsSendPortWithHooks = {
    available: true,
    transport: "simulated",
    async send(_credential, _text, hooks) {
      log.containers += 1;
      log.statusReads += 1;
      if (options.duringWait) await options.duringWait();
      if (options.honourHook && hooks) {
        let ok = false;
        try {
          ok = (await hooks.beforePublish()) === true;
        } catch {
          ok = false;
        }
        if (!ok) return { kind: "not_written", stage: "publish", code: "THREADS_PREPUBLISH_REFUSED" };
      }
      const scripted = options.outcome?.() ?? null;
      if (scripted) {
        if (scripted.kind !== "not_written" || scripted.stage !== "container") log.publishes += 1;
        return scripted;
      }
      log.publishes += 1;
      log.readBacks += 1;
      return { kind: "published", mediaId: String(++media), readBack: "confirmed" };
    },
  };
  return { port, log };
}

/** PR #337's DEPLOYABLE ports as they ship (gate OFF, service key undecided): both unavailable. Shape only. */
export const PR337_DEPLOYABLE_SHAPE = Object.freeze({
  credentials: Object.freeze({ available: false as const, credentialFor: () => Promise.resolve(null) }),
  sender: Object.freeze({ available: false as const, transport: "threads" as const, send: () => Promise.resolve({ kind: "not_written" as const, stage: "container" as const, code: "THREADS_SEND_DISABLED" }) }),
});
