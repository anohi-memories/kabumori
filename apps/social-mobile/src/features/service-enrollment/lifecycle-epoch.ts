// The ServiceEnrollmentGate's ONLY view of the POSTONA service-lifecycle signal (F4/F5 contract "design B",
// apps/social-mobile/docs/postona-service-end-gate-g1-g2-design.md).
//
// The signal is a per-person counter: the service-end surface (F4) counts up for a person each time it has an
// answered end of THAT person. It carries no verdict, no token, no preview and no outcome -- the gate reads only
// "did my question change?". When the number for the signed-in person changes, the gate discards what it decided,
// closes the app at once, and asks the server again with the current login's token (the automatic start, which
// never restarts an ended service). A person who has no number yet is at 0.
//
// STATUS -- NOT YET CONNECTED. The provider that owns the counter is F4's `ServiceLifecycleProvider`
// (`@/features/service-lifecycle/service-lifecycle`, `useServiceLifecycleEpoch(userId)`), which is not in this
// stack yet. F5 does not write a competing one. Until it lands every person is at epoch 0 here, so nothing
// re-asks and the gate behaves exactly as before; the whole refresh is implemented and proven in the gate against a
// typed mock of this hook. Connecting it is this ONE line, made when F4's provider and exact signature are confirmed:
//
//   export { useServiceLifecycleEpoch as useLifecycleEpoch } from '@/features/service-lifecycle/service-lifecycle';
//
// and `LIFECYCLE_SIGNAL_CONNECTED` becomes true (a pending spec fails until then).

/** `useLifecycleEpoch(userId)`: the signed-in person's epoch, or 0 for nobody. Called on every render of the gate. */
export type LifecycleEpochHook = (userId: string | null) => number;

export const LIFECYCLE_SIGNAL_CONNECTED = false;

export const useLifecycleEpoch: LifecycleEpochHook = () => 0;
