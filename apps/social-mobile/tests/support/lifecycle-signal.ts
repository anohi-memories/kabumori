// A typed stand-in for F4's per-person lifecycle counter (the part the ServiceEnrollmentGate reads). Test support
// only: the real counter belongs to F4's ServiceLifecycleProvider. The shape is the contract of `LifecycleEpochHook`.
import type { LifecycleEpochHook } from '../../src/features/service-enrollment/lifecycle-epoch.ts';

export type LifecycleSignalMock = {
  /** the epoch of one person (0 until their first signal) */
  epochOf(userId: string): number;
  /** an answered end of this person: counts up for this person only */
  bump(userId: string): void;
  /** moves a person's epoch to an arbitrary value (a provider that restarted, or went backwards) */
  set(userId: string, epoch: number): void;
  /** the hook the gate would call */
  hook: LifecycleEpochHook;
};

export function createLifecycleSignal(): LifecycleSignalMock {
  const epochs = new Map<string, number>();
  const epochOf = (userId: string) => epochs.get(userId) ?? 0;
  return {
    epochOf,
    bump: (userId) => { epochs.set(userId, epochOf(userId) + 1); },
    set: (userId, epoch) => { epochs.set(userId, epoch); },
    hook: (userId) => (userId === null ? 0 : epochOf(userId)),
  };
}
