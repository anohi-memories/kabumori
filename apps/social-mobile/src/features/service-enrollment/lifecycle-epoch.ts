// The ServiceEnrollmentGate's ONLY view of the POSTONA service-lifecycle signal (F4/F5 contract "design B",
// apps/social-mobile/docs/postona-service-end-gate-g1-g2-design.md).
//
// The signal is a per-person counter: the service-end surface (F4) counts up for a person each time it has an
// answered end of THAT person. It carries no verdict, no token, no preview and no outcome -- the gate reads only
// "did my question change?". When the number for the signed-in person changes, the gate discards what it decided,
// closes the app at once, and asks the server again with the current login's token (the automatic start, which
// never restarts an ended service). A person who has no number yet is at 0.
//
// STATUS -- CONNECTED (F4+F5 joint integration, postona-f4-f5-service-end-g1-g2-joint-integration-20261017), by the
// one line this seam documented: F4's `ServiceLifecycleProvider` (`@/features/service-lifecycle/service-lifecycle`,
// `useServiceLifecycleEpoch(userId: string | null): number`, F4 PR236 605d8776) owns the counter; this file stays a
// stateless re-export (no provider is written here).

/** `useLifecycleEpoch(userId)`: the signed-in person's epoch, or 0 for nobody. Called on every render of the gate. */
export type LifecycleEpochHook = (userId: string | null) => number;

export const LIFECYCLE_SIGNAL_CONNECTED = true;

export { useServiceLifecycleEpoch as useLifecycleEpoch } from '@/features/service-lifecycle/service-lifecycle';
